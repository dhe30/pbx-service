import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { vendorEndpoint } from '../src/pstn.js';
import type { Ctx } from '../src/ctx.js';

// Assertions on the RENDERED telephony configs (2 edges + 2 pbx test inventory). Produce them with
//   sh telephony/tests/check-configs.sh        (Linux/WSL: ansible + kamailio 6.0)
// which also runs `kamailio -c` on each edge config. Skipped when nothing has been rendered.

const R = join(import.meta.dirname, '../../../telephony/tests/.rendered');
const rendered = existsSync(join(R, 'edge-1', 'kamailio.cfg'));
const read = (host: string, file: string) => readFileSync(join(R, host, file), 'utf8');
/** A route block's body: `route[NAME] { ... }` up to the next top-level block. */
function block(cfg: string, header: string): string {
  const i = cfg.indexOf(header);
  if (i < 0) throw new Error(`no ${header}`);
  const rest = cfg.slice(i);
  const end = rest.slice(1).search(/\n(route|branch_route|onreply_route|failure_route|event_route|request_route)[[ {]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe.skipIf(!rendered)('rendered configs', () => {
  const kam = rendered ? read('edge-1', 'kamailio.cfg') : '';
  const kam2 = rendered ? read('edge-2', 'kamailio.cfg') : '';

  it('kamailio -c passed on every edge', () => {
    const results = read('.', 'results.txt');
    expect(results).toMatch(/PASS kamailio -c edge-1/);
    expect(results).toMatch(/PASS kamailio -c edge-2/);
    expect(results).not.toMatch(/FAIL/);
  });

  describe('B1: registrations in memory, replicated between edges; DB read-only', () => {
    it('usrloc db_mode 0 + dmq_usrloc with full sync on start', () => {
      expect(kam).toMatch(/modparam\("usrloc", "db_mode", 0\)/);
      expect(kam).not.toMatch(/modparam\("usrloc", "db_url"/);
      expect(kam).toMatch(/modparam\("dmq_usrloc", "enable", 1\)/);
      expect(kam).toMatch(/modparam\("dmq_usrloc", "sync", 1\)/);
      // DMQ runs on the internal socket (5070), not the internet-facing 5060.
      expect(kam).toMatch(/modparam\("dmq", "server_address", "sip:127\.0\.0\.11:5070"\)/);
      expect(kam).toMatch(/modparam\("dmq", "notification_address", "sip:127\.0\.0\.12:5070"\)/);
      expect(kam2).toMatch(/modparam\("dmq", "notification_address", "sip:127\.0\.0\.11:5070"\)/);
      expect(block(kam, 'route[DMQ]')).toMatch(/dmq_handle_message\(\)/);
    });
    it('auth and DID lookups use the read-only DB URL', () => {
      // Edges aren't db hosts: the local proxy's read-only port (replicas first).
      expect(kam).toMatch(/#!define DBURL_RO "postgres:\/\/kamailio:[^@]+@127\.0\.0\.1:5433\/pbx"/);
      expect(kam).toMatch(/modparam\("auth_db", "db_url", DBURL_RO\)/);
      expect(kam).toMatch(/modparam\("sqlops", "sqlcon", "ro=>postgres:/);
    });
    it('more workers than phase 1 (8/4)', () => {
      expect(kam).toMatch(/^children=16$/m);
      expect(kam).toMatch(/^tcp_children=16$/m);
    });
  });

  describe('§3 "Any number of phones register"; "rings all of an extension\'s devices"', () => {
    it('no one-contact-per-user save flag, unlimited contacts', () => {
      expect(kam).not.toMatch(/save\("location", "0x04"\)/);
      expect(kam).toMatch(/modparam\("registrar", "max_contacts", 0\)/);
    });
    it('each forked branch gets its own rtpengine media leg (via-branch=extra)', () => {
      expect(kam).toMatch(/modparam\("rtpengine", "extra_id_pv", "\$avp\(extra_id\)"\)/);
      const br = block(kam, 'branch_route[DEV_BRANCH]');
      expect(br).toMatch(/\$avp\(extra_id\) = @via\[1\]\.branch \+ \$T_branch_idx;/);
      expect(br.match(/rtpengine_offer\("via-branch=extra /g)).toHaveLength(3);
      const rep = block(kam, 'onreply_route[DEV_REPLY]');
      expect(rep).toMatch(/\$avp\(extra_id\) = @via\[2\]\.branch \+ \$T_branch_idx;/);
      expect(rep.match(/rtpengine_answer\("via-branch=extra /g)).toHaveLength(3);
    });
    it('a peer edge delivers a relayed INVITE from its own Path ;received, not loose_route()\'s return code', () => {
      // loose_route() returns -3 for a pre-loaded route on an initial request: `if (!loose_route())`
      // refused every relayed call with 403 (live, 2026-11-14).
      const peer = block(kam, 'route[FROM_PEER]');
      const code = peer.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
      expect(code).not.toMatch(/loose_route\(/);
      expect(peer).toMatch(/\$var\(rt\) = \$\(hdr\(Route\)\{nameaddr\.uri\}\);/);
      expect(peer).toMatch(/\{uri\.param,received\}\{s\.unescape\.param\}/);
      expect(peer).toContain('$(var(rt){uri.host}) != "127.0.0.11"');
      expect(peer).toMatch(/remove_hf\("Route"\);\n\t\$du = \$var\(rcv\);/);
      expect(block(kam2, 'route[FROM_PEER]')).toContain('$(var(rt){uri.host}) != "127.0.0.12"');
    });
    it('INVITEs to phones are trimmed to fit one UDP packet', () => {
      expect(kam).toMatch(/modparam\("rr", "append_fromtag", 0\)/);
      const dev = block(kam, 'route[TO_DEVICES]');
      expect(dev).toMatch(/remove_hf\("P-Asserted-Identity"\);/);
      expect(dev).toMatch(/remove_hf\("User-Agent"\);/);
      expect(dev).toContain('append_hf("Supported: 100rel, timer, replaces\\r\\n");');
      // Transfers need REFER (+ NOTIFY); UPDATE/PRACK/INFO/OPTIONS stay usable in the dialog.
      expect(dev).toContain('append_hf("Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, UPDATE, PRACK, INFO, REFER, NOTIFY\\r\\n");');
      // Trimmed before relaying, so every branch (and a peer edge's relay) gets the small version.
      expect(dev.indexOf('remove_hf("Allow")')).toBeLessThan(dev.indexOf('route(RELAY)'));
    });
    it('a lost rtpengine command costs ~0.1 s, and a ~0.8 s stall does not disable the node (20 attempts)', () => {
      expect(kam).toMatch(/modparam\("rtpengine", "rtpengine_tout_ms", 100\)/);
      expect(kam).toMatch(/modparam\("rtpengine", "rtpengine_retr", 20\)/);
    });
    it('a retransmission seen while another worker handles the request is dropped untouched (6.0.8 orphan release, 2026-11-17)', () => {
      const req = block(kam, 'request_route {');
      // t_check_trans() on a branch-less transaction made tm release it; the 200 OK then went stateless.
      expect(req).toMatch(/if \(t_precheck_trans\(\)\) \{\n\t\t\texit;\n\t\t\}\n\t\tt_check_trans\(\);/);
    });
    it('a phone answering G.723 with an fmtp line gets reuse-codecs (rtpengine 26.0.1 bug, 2026-11-15)', () => {
      const fix = block(kam, 'route[G723_FIX]');
      expect(fix).toContain('if (search_body("a=fmtp:4 ")) {');
      expect(fix).toContain('$var(g723fix) = " reuse-codecs";');
      // Every rtpengine_answer on a phone's answer (ringing branches and in-dialog replies) uses it.
      const dev = block(kam, 'onreply_route[DEV_REPLY]');
      expect(dev.indexOf('route(G723_FIX)')).toBeLessThan(dev.indexOf('rtpengine_answer'));
      expect(dev.match(/rtpengine_answer\("[^"]*\$var\(g723fix\)"\)/g)).toHaveLength(3);
      expect(block(kam, 'onreply_route[RTP_REPLY]')).toContain('rtpengine_answer("$avp(rtp_answer)$var(g723fix)")');
    });
    it('requests to Asterisk / the peer edge are resent after 100 ms; the internet keeps SIP defaults', () => {
      const nh = block(kam, 'route[NH_TIMERS]');
      // Test inventory: pbx 127.0.0.21/.22, peer edge 127.0.0.12 (edge-1 is .11, not its own hop).
      expect(nh).toContain('$nh(d) == "127.0.0.21" || $nh(d) == "127.0.0.22" || $nh(d) == "127.0.0.12"');
      expect(nh).toContain('t_set_retr(100, 400);');
      expect(block(kam, 'route[RELAY]').indexOf('route(NH_TIMERS)')).toBeLessThan(block(kam, 'route[RELAY]').indexOf('t_relay()'));
      expect(block(kam, 'failure_route[PBX_FAILOVER]')).toMatch(/route\(NH_TIMERS\);\n\s*t_relay\(\);/);
    });
    it('only 503 or a dead node marks a pbx node inactive; a 500 (one failed call) goes to the caller', () => {
      // 2026-11-20 19:49: vendor DNS outage -> each failed PSTN call (500) marked every pbx node
      // inactive in turn and other calls got 503 "no pbx node available".
      const fo = block(kam, 'failure_route[PBX_FAILOVER]');
      expect(fo).toContain('if (t_check_status("503") || (t_branch_timeout() && !t_branch_replied())) {');
      expect(fo).not.toMatch(/t_check_status\("[^"]*500/);
    });
    it('log lines end in a \\n escape, not a line break inside the string', () => {
      expect(kam).not.toMatch(/xlog\("L_[A-Z]+", "[^"\n]*\n"\)/);
    });
    it('transport (WS / TLS / UDP) is decided per branch, not per message', () => {
      const br = block(kam, 'branch_route[DEV_BRANCH]');
      expect(br).toMatch(/setbflag\(FLB_WS\)/);
      expect(br).toMatch(/setbflag\(FLB_TLS\)/);
      expect(block(kam, 'onreply_route[DEV_REPLY]')).toMatch(/isbflagset\(FLB_WS\)/);
    });
  });

  describe('§3 codecs: "A phone may support only one of PCMU, PCMA, G.729, G.723.1, or Opus; calls between any two must work"', () => {
    const offers = (route: string) => [...block(kam, route).matchAll(/rtpengine_offer\("([^"]+)"\)/g)].map((m) => m[1]!);
    it('toward Asterisk: always PCMU only (+ DTMF events), transcoding enabled', () => {
      for (const route of ['route[FROM_CARRIER]', 'route[FROM_DEVICE]']) {
        for (const f of offers(route)) expect(f).toMatch(/codec-mask=all codec-transcode=PCMU codec-transcode=telephone-event/);
      }
    });
    it('toward carriers, vendors and SIP phones (UDP/TLS): PCMU + PCMA, G.729, G.723.1, Opus offered', () => {
      const br = block(kam, 'branch_route[DEV_BRANCH]');
      const plainTls = [...br.matchAll(/rtpengine_offer\("([^"]+)"\)/g)].map((m) => m[1]!).filter((f) => !f.includes('SAVPF'));
      expect(plainTls).toHaveLength(2);
      for (const f of [...plainTls, ...offers('route[TO_VENDOR]')]) {
        expect(f).toMatch(/codec-transcode=PCMA codec-transcode=G729 codec-transcode=G723 codec-transcode=opus/);
      }
    });
    it('toward browsers: PCMU (WebRTC supports it) - no transcoding on the browser leg', () => {
      const ws = [...block(kam, 'branch_route[DEV_BRANCH]').matchAll(/rtpengine_offer\("([^"]+)"\)/g)].map((m) => m[1]!).find((f) => f.includes('SAVPF'))!;
      expect(ws).toMatch(/ICE=force DTLS=passive/);
      expect(ws).not.toMatch(/G729|G723/);
    });
    it('every rtpengine offer/answer drops media from senders other than the learned one (stray stream, 2026-11-18)', () => {
      const calls = [...kam.matchAll(/rtpengine_(?:offer|answer)\("([^"]+)"\)/g)].map((m) => m[1]!).filter((f) => !f.startsWith('$avp'));
      expect(calls.length).toBeGreaterThan(10);
      for (const f of calls) expect(f).toContain('strict-source');
      // In-dialog replies take their flags from an avp set to one of the same flag sets.
      const avps = [...kam.matchAll(/\$avp\(rtp_answer\) = "([^"]+)"/g)].map((m) => m[1]!);
      for (const f of avps) expect(f).toContain('strict-source');
    });
    it('in-dialog re-INVITEs (hold/resume, transfer) cover all five leg types both ways', () => {
      const ind = block(kam, 'route[INDLG_SDP]');
      for (const leg of ['carrier', 'vendor', 'staff_udp', 'staff_tls', 'staff_ws']) expect(ind).toContain(`check_route_param("leg=${leg}")`);
      expect(ind.match(/rtpengine_offer\(/g)).toHaveLength(10);
    });
  });

  describe('§3 TLS phones use SRTP with SDES (RFC 4568); _sips._tcp', () => {
    it('TLS listener on the public address; staff_tls legs use RTP/SAVP without DTLS', () => {
      expect(kam).toMatch(/^listen=tls:127\.0\.1\.11:5061$/m);
      expect(kam).toMatch(/^enable_tls=yes$/m);
      expect(read('edge-1', 'tls.cfg')).toMatch(/certificate = \/etc\/kamailio\/tls\/cert\.pem/);
      const tlsOffer = [...block(kam, 'branch_route[DEV_BRANCH]').matchAll(/rtpengine_offer\("([^"]+)"\)/g)].map((m) => m[1]!).find((f) => f.includes('RTP/SAVP '))!;
      expect(tlsOffer).toMatch(/DTLS=off/);
      // Only the AES_CM_128 suites, so AES_CM_128_HMAC_SHA1_80 is tag 1 (phones that answer tag 1
      // with it were rejected when rtpengine offered every suite).
      expect(tlsOffer).toContain('SDES-only-AES_CM_128_HMAC_SHA1_80 SDES-only-AES_CM_128_HMAC_SHA1_32');
      const reinviteTls = block(kam, 'route[INDLG_SDP]');
      expect(reinviteTls).toContain('SDES-only-AES_CM_128_HMAC_SHA1_80');
    });
  });

  describe('§3 outgoing calls / §1 PSTN vendors', () => {
    it('phones place calls after digest auth; Kamailio passes the authenticated user to Asterisk', () => {
      const r = block(kam, 'route[FROM_DEVICE]');
      expect(r).toMatch(/auth_check\("\$fd", "subscriber", "1"\)/);
      expect(r).toMatch(/append_hf\("X-PBX-User: \$var\(user\)\\r\\n"\)/);
      expect(r).toMatch(/append_hf\("X-PBX-Src: device\\r\\n"\)/);
      // Phase 1 answered 403 to every phone-originated INVITE.
      expect(kam).toMatch(/route\(FROM_DEVICE\);/);
    });
    it('forged X-PBX-* headers from outside are removed', () => {
      expect(block(kam, 'route[REQINIT]')).toMatch(/remove_hf_re\("\^X-PBX-"\)/);
    });
    it('Asterisk -> vendor hosts goes through TO_VENDOR (rtpengine leg=vendor)', () => {
      expect(kam).toMatch(/\$rd == "us-vendor\.cse356\.compas\.cs\.stonybrook\.edu" \|\| \$rd == "intl-vendor\.cse356\.compas\.cs\.stonybrook\.edu"\) route\(TO_VENDOR\)/);
      expect(block(kam, 'route[TO_VENDOR]')).toMatch(/add_rr_param\(";leg=vendor"\)/);
      expect(block(kam, 'failure_route[VENDOR_FAILURE]')).toMatch(/t_check_status\("401\|407"\)/);
    });
    it('vendor legs go to a stored address, not a DNS lookup per call (2026-11-23 478 Unresolvable destination)', () => {
      // TO_VENDOR picks the destination before rtpengine/relay; SEND_PUBLIC then reads its transport.
      const tv = block(kam, 'route[TO_VENDOR]');
      expect(tv.indexOf('route(VENDOR_DST);')).toBeGreaterThan(tv.indexOf('loose_route()'));
      expect(tv.indexOf('route(VENDOR_DST);')).toBeLessThan(tv.indexOf('route(SEND_PUBLIC);'));
      expect(kam).toMatch(/modparam\("htable", "htable", "vdns=>size=4;autoexpire=0;"\)/);
      const vd = block(kam, 'route[VENDOR_DST] {');
      // re-resolve at most once a minute, keep the last good address when a lookup fails
      expect(vd).toMatch(/\$Ts - \$sht\(vdns=>\$var\(vh\)::at\) >= 60\)/);
      expect(vd).toMatch(/dns_query\("\$var\(vh\)", "vd"\)/);
      // deploy-time address only when nothing resolved yet, one per vendor host
      expect(vd).toContain('if ($var(vh) == "us-vendor.cse356.compas.cs.stonybrook.edu") $var(vip) = "130.245.136.142";');
      expect(vd).toContain('if ($var(vh) == "intl-vendor.cse356.compas.cs.stonybrook.edu") $var(vip) = "130.245.136.142";');
      expect(vd).toMatch(/\$du = "sip:" \+ \$var\(vip\) \+ ":5060";/);
      // an existing $du (a Route to another hop) is left alone
      expect(vd).toMatch(/^route\[VENDOR_DST\] \{\n\tif \(\$du != \$null && \$du != ""\) return;/);
    });
    it('the vendor endpoints the ARI app dials exist in pjsip.conf with digest auth via that edge', () => {
      const pjsip = read('pbx-1', 'pjsip.conf');
      const cfg = loadConfig({ ARI_USER: 'x', ARI_PASSWORD: 'x', DATABASE_URL: 'x', S3_ENDPOINT: 'http://s', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' });
      const ctx = { cfg } as Ctx;
      for (const vendor of ['us', 'intl'] as const) {
        for (const [trunk, ip] of [['edge-a', '127.0.0.11'], ['edge-b', '127.0.0.12']]) {
          const ep = vendorEndpoint(ctx, vendor, 'h', trunk!, '+1').split('/')[1]!;
          expect(pjsip).toContain(`[${ep}](edge-common)`);
          const section = pjsip.slice(pjsip.indexOf(`[${ep}](edge-common)`)).split('\n\n')[0]!;
          expect(section).toContain(`outbound_proxy=sip:${ip}:5070\\;lr`);
          expect(section).toContain(`outbound_auth=vendor-${vendor}-auth`);
        }
      }
      expect(pjsip).toMatch(/\[vendor-us-auth\]\ntype=auth\nauth_type=userpass\nusername=test-us-user/);
      expect(pjsip).toMatch(/\[vendor-intl-auth\][\s\S]*username=test-intl-user/);
    });
    it('the ARI app is configured with the vendor hosts and both trunks', () => {
      const env = read('pbx-1', 'ari-app.env');
      expect(env).toMatch(/^TRUNKS=edge-a,edge-b$/m);
      expect(env).toMatch(/^VENDOR_US_HOST=us-vendor\.cse356\.compas\.cs\.stonybrook\.edu$/m);
      expect(env).toMatch(/^CDR_SPOOL_DIR=\/var\/spool\/pbx\/cdr$/m);
    });
  });

  describe('Asterisk', () => {
    const pjsip = rendered ? read('pbx-1', 'pjsip.conf') : '';
    it('PCMU only toward the edges (rtpengine transcodes everything else), media anchored', () => {
      expect(pjsip).toMatch(/disallow=all\nallow=ulaw\n/);
      expect(pjsip).toMatch(/direct_media=no/);
      expect(pjsip).toMatch(/dtmf_mode=rfc4733/);
    });
    it('REFER accepted (transfers handled by the ARI app)', () => {
      expect(pjsip).toMatch(/allow_transfer=yes/);
    });
    it('SIP T1 100 ms toward the edges (private network); INVITE timeout unchanged', () => {
      expect(pjsip).toMatch(/\[system\]\ntype=system\n[\s\S]*\ntimer_t1=100\ntimer_b=32000\n/);
    });
    it('no connected-line re-INVITEs: a mid-call re-offer let the codec flip (2026-11-14 incident)', () => {
      expect(pjsip).toMatch(/\[edge-common\]\(!\)[\s\S]*\nsend_connected_line=no\n/);
    });
    it('overload guard is a call cap (80 per vCPU), not a load-average limit (it refused calls at half-idle CPU)', () => {
      // render-telephony.yml renders with ansible_processor_vcpus=4.
      const conf = read('pbx-1', 'asterisk.conf');
      expect(conf).toMatch(/^maxcalls = 320$/m);
      expect(conf).not.toMatch(/^maxload/m);
    });
    it('dialplan hands every call to Stasis with the source and SIP user from Kamailio', () => {
      const ext = read('pbx-1', 'extensions.conf');
      expect(ext).toMatch(/exten => _\[\+\*#0-9\]!,1/); // *98 and extension numbers too
      // 3rd argument: the SIP Call-ID, for matching the app's logs with edge captures (2026-11-15).
      expect(ext).toMatch(/Stasis\(pbx-app,\$\{PJSIP_HEADER\(read,X-PBX-Src\)\},\$\{PJSIP_HEADER\(read,X-PBX-User\)\},\$\{CHANNEL\(pjsip,call-id\)\}\)/);
      expect(ext).toMatch(/Hangup\(34\)/);
    });
    it('the h extension keeps the ARI app\'s hangup cause (the `_.` catch-all turned every reject into 404, 2026-11-18)', () => {
      const ext = read('pbx-1', 'extensions.conf');
      const h = ext.match(/^exten => h,1,(.*)$/m);
      expect(h).not.toBeNull();
      expect(h![1]).not.toMatch(/Hangup/);
      // The explicit h line must exist in the same context as the catch-all.
      expect(ext.indexOf('exten => h,1')).toBeLessThan(ext.indexOf('exten => _.,1,Hangup(1)'));
      expect(ext.indexOf('[from-edge]')).toBeLessThan(ext.indexOf('exten => h,1'));
    });
  });

  describe('SIP history (sipdump, 2026-11-15)', () => {
    it('every SIP message, all transports, to hourly pcaps with the real transport, kept 12 h', () => {
      expect(kam).toMatch(/^loadmodule "sipdump\.so"$/m);
      expect(kam).toMatch(/modparam\("sipdump", "enable", 1\)/);
      expect(kam).toMatch(/modparam\("sipdump", "mode", 12\)/); // 4 pcap + 8 P-KSR-SIPDump header
      expect(kam).toMatch(/modparam\("sipdump", "rotate", 3600\)/);
      expect(kam).toMatch(/modparam\("sipdump", "folder", "\/var\/log\/pbx\/sipdump"\)/);
      expect(kam).toMatch(/modparam\("sipdump", "fage", 43200\)/);
      // Not the default 100 µs: the writer would wake 10,000 times a second on a 1-vCPU edge.
      expect(kam).toMatch(/modparam\("sipdump", "wait", 10000\)/);
    });
  });

  describe('B2/B3/B5', () => {
    it('B2: course testers are exempt from pike; carrier IP from the Course Services tab', () => {
      expect(kam).toMatch(/is_in_subnet\("\$si", "130\.245\.136\.0\/24"\)\) setflag\(FLT_TRUSTED\)/);
      expect(kam).toMatch(/is_in_subnet\("\$si", "130\.245\.136\.142\/32"\) && \$pr == "udp"\)/);
      expect(block(kam, 'route[REQINIT]')).toMatch(/if \(isflagset\(FLT_DEVICE_SRC\) && !isflagset\(FLT_TRUSTED\)\)/);
    });
    it('a carrier entry with :port matches that source port only (fake carrier + phones on one host)', () => {
      const cls = block(kam2, 'route[CLASSIFY]');
      expect(cls).toMatch(/is_in_subnet\("\$si", "192\.168\.56\.1\/32"\) && \$sp == 5062 && \$pr == "udp"\) \{\n\t\tsetflag\(FLT_CARRIER\)/);
      // without a port: any source port (the real carrier)
      expect(cls).toMatch(/is_in_subnet\("\$si", "130\.245\.136\.142\/32"\) && \$pr == "udp"\) \{/);
      expect(cls).toMatch(/is_in_subnet\("\$si", "192\.168\.56\.1\/32"\)\) setflag\(FLT_TRUSTED\)/);
    });
    it('B3: rtpengine kernel forwarding + one thread per vCPU', () => {
      const rtp = read('edge-1', 'rtpengine.conf');
      expect(rtp).toMatch(/^table = 0$/m);
      expect(rtp).toMatch(/^num-threads = 4$/m);
    });
    it('B5: dispatcher hashes on the account (alg 7) so an account stays on one pbx node', () => {
      expect(kam).toMatch(/modparam\("dispatcher", "hash_pvar", "\$avp\(dshash\)"\)/);
      expect(kam).toMatch(/modparam\("auth_db", "load_credentials", "\$avp\(tenant\)=tenant_id"\)/);
      const sel = block(kam, 'route[PBX_SELECT]');
      expect(sel).toMatch(/\$var\(alg\) = 7;/);
      expect(sel).toMatch(/ds_select_dst\("1", "\$var\(alg\)"\)/);
      const carrier = block(kam, 'route[FROM_CARRIER]');
      expect(carrier).toMatch(/sql_query\("ro", "select tenant_id from public\.kamailio_did_tenant/);
      // The cache miss is tested on $sht itself: a $var can never be $null, so testing a copy
      // skipped the lookup and every carrier call hashed on its DID (2026-11-15).
      expect(carrier).toMatch(/if \(\$sht\(didt=>\$var\(did\)\) == \$null\) \{/);
      expect(carrier).not.toMatch(/\$var\(tenant\) == \$null/);
      expect(carrier.indexOf('$var(tenant) = $sht(didt=>$var(did));')).toBeGreaterThan(carrier.indexOf('$sht(didt=>$var(did)) = $var(found);'));
      expect(read('edge-1', 'dispatcher.list')).toMatch(
        /1 sip:127\.0\.0\.21:5060 0 0 socket=udp:127\.0\.0\.11:5070\n1 sip:127\.0\.0\.22:5060 0 0 socket=udp:127\.0\.0\.11:5070/,
      );
    });
  });

  // verify-backlog V-P10 / V-T10. SIP carries addresses inside its messages, so each socket must
  // put the address its audience can reach: the private one for Asterisk / the peer edge / DMQ, the
  // public one for the carrier, vendors and phones. edge-1: public IP on an interface; edge-2:
  // behind 1:1 NAT like Clanode (binds its private IP, advertises the public one).
  describe('sockets: internal vs internet-facing, with and without 1:1 NAT', () => {
    const listens = (cfg: string) => cfg.split('\n').filter((l) => l.startsWith('listen='));
    it('internal socket first (the default for DMQ and the peer edge), on its own port', () => {
      expect(listens(kam)[0]).toBe('listen=udp:127.0.0.11:5070');
      expect(listens(kam2)[0]).toBe('listen=udp:127.0.0.12:5070');
    });
    it('public IP on an interface: bind it, nothing to advertise', () => {
      expect(listens(kam)).toEqual([
        'listen=udp:127.0.0.11:5070',
        'listen=udp:127.0.1.11:5060',
        'listen=tls:127.0.1.11:5061',
        'listen=tcp:127.0.0.11:8080',
      ]);
    });
    it('behind 1:1 NAT: public UDP and TLS bind the private IP and advertise the public one', () => {
      expect(listens(kam2)).toEqual([
        'listen=udp:127.0.0.12:5070',
        'listen=udp:127.0.0.12:5060 advertise 127.0.1.12:5060',
        'listen=tls:127.0.0.12:5061 advertise 127.0.1.12:5061',
        'listen=tcp:127.0.0.12:8080',
      ]);
      // rtpengine: same local address for both sides; the external side advertises the public IP.
      expect(read('edge-2', 'rtpengine.conf')).toMatch(/^interface = internal\/127\.0\.0\.12;external\/127\.0\.0\.12!127\.0\.1\.12$/m);
    });
    it('new requests toward the internet leave from the public socket', () => {
      // ' {': the route itself, not the mention in the Listeners comment
      expect(block(kam2, 'route[SEND_PUBLIC] {')).toMatch(/force_send_socket\(udp:127\.0\.0\.12:5060\)/);
      expect(block(kam, 'route[SEND_PUBLIC] {')).toMatch(/force_send_socket\(udp:127\.0\.1\.11:5060\)/);
      // vendor legs, a phone on this edge, a phone delivered for the peer edge
      expect(block(kam, 'route[TO_VENDOR]')).toMatch(/route\(SEND_PUBLIC\);\n\troute\(RELAY\);/);
      expect(block(kam, 'branch_route[DEV_BRANCH]')).toMatch(/\$du = \$var\(rcv\);\n\t\troute\(SEND_PUBLIC\);/);
      expect(block(kam, 'route[FROM_PEER]')).toMatch(/route\(SEND_PUBLIC\);\n\troute\(RELAY\);/);
      // in-dialog requests: double Record-Route picks the socket
      expect(kam).toMatch(/modparam\("rr", "enable_double_rr", 1\)/);
    });
    it('replies relayed statelessly to the internet leave from the public socket too (2026-11-18)', () => {
      // A 200 OK retransmission from Asterisk after the transaction is gone went out of the first
      // (internal) socket, :5070. Only replies that came in on the internal socket, go on over UDP
      // and are not for one of our own private hops get the public socket.
      const rr = block(kam, '\nreply_route {');
      expect(rr).toContain('if ($Rp == 5070 && $(sel(via[2].transport){s.tolower}) == "udp") {');
      expect(rr).toContain('$sel(via[2].host) != "127.0.0.21" && $sel(via[2].host) != "127.0.0.22" && $sel(via[2].host) != "127.0.0.12"');
      expect(rr).toContain('force_send_socket(udp:127.0.1.11:5060);');
      expect(block(kam2, '\nreply_route {')).toContain('force_send_socket(udp:127.0.0.12:5060);');
    });
    it("ring legs: the app's X-PBX-Leg tag is logged with the leg's Call-ID and stripped (2026-11-18)", () => {
      const tag = block(kam, 'route[LEG_TAG] {');
      expect(tag).toContain('if (is_present_hf("X-PBX-Leg")) {');
      expect(tag).toContain('xlog("L_INFO", "legs: $hdr(X-PBX-Leg) is [ci=$ci] to $rU\\n");');
      expect(tag).toContain('remove_hf("X-PBX-Leg");');
      // first thing on both paths of a leg the app placed: phones and vendors
      expect(block(kam, 'route[TO_DEVICES]')).toMatch(/^route\[TO_DEVICES\] \{\n\troute\(LEG_TAG\);/);
      expect(block(kam, 'route[TO_VENDOR] {')).toMatch(/^route\[TO_VENDOR\] \{\n\troute\(LEG_TAG\);/);
      // and it can't be forged from outside: X-PBX-* is stripped from anyone but pbx nodes / peer
      expect(kam).toContain('remove_hf_re("^X-PBX-");');
    });
    it('phones get 15 s for a first reply (5 s turned slow phones into cause 18 at the peak, 2026-11-18)', () => {
      expect(block(kam, 'route[DEV_TIMERS] {')).toContain('t_set_fr(120000, 15000);');
      // both places that send an INVITE to a phone: this edge's fork, and delivery for the peer edge
      expect(block(kam, 'route[TO_DEVICES]')).toMatch(/route\(DEV_TIMERS\);\n\troute\(RELAY\);/);
      expect(block(kam, 'route[FROM_PEER]')).toMatch(/route\(DEV_TIMERS\);\n\troute\(SEND_PUBLIC\);\n\troute\(RELAY\);/);
      // everything else keeps the 5 s default; the pbx nodes keep their 2 s failover timer
      expect(kam).toMatch(/modparam\("tm", "fr_timer", 5000\)/);
      expect(block(kam, 'route[PBX_TIMERS]')).toContain('t_set_fr(120000, 2000);');
    });
    it('a late 2xx from a party with no transaction is logged (still relayed)', () => {
      const rr = block(kam, '\nreply_route {');
      expect(rr).toContain('if ($Rp != 5070 && $rm == "INVITE" && status =~ "^2[0-9][0-9]$" && !t_check_trans()) {');
      expect(rr).toMatch(/xlog\("L_WARN", "devices: late 2xx from .*\[ci=\$ci\]\\n"\);/);
      expect(rr).not.toMatch(/^\s*drop;/m);
    });
    it('Asterisk and the peer edge reach Kamailio on the internal port', () => {
      expect(block(kam, 'route[REGISTRAR]')).toContain('Path: <sip:127.0.0.11:5070;lr;received=');
      const pjsip = read('pbx-1', 'pjsip.conf');
      expect(pjsip).toMatch(/\[edge-a\]\ntype=aor\n[^\n]*\ncontact=sip:127\.0\.0\.11:5070\n/);
      expect(pjsip).toMatch(/\[edge-b\]\ntype=aor\n[^\n]*\ncontact=sip:127\.0\.0\.12:5070\n/);
    });
  });
  // CLAUDE.md §14 / cloud-deploy §2: one Let's Encrypt certificate, issued with HTTP-01 through
  // HAProxy :80 (certbot standalone on 127.0.0.1), installed for HTTPS/WSS and Kamailio TLS.
  describe('§14 TLS certificate: HTTP-01 on :80, installed for HAProxy and Kamailio', () => {
    const hasHap = rendered && existsSync(join(R, 'edge-2', 'haproxy.cfg'));
    const hap = hasHap ? read('edge-2', 'haproxy.cfg') : '';
    const install = hasHap ? read('edge-2', 'pbx-install-cert.sh') : '';
    it.skipIf(!hasHap)(':80 sends ACME challenges to certbot and redirects everything else', () => {
      const i = hap.indexOf('frontend http\n');
      const http = hap.slice(i, hap.indexOf('\n\n', i));
      expect(http).toContain('bind 127.0.0.12:80'); // behind 1:1 NAT: the private IP
      expect(http).toContain('acl acme_challenge path_beg /.well-known/acme-challenge/');
      expect(http).toContain('http-request redirect scheme https code 301 unless acme_challenge');
      expect(http).toContain('use_backend acme if acme_challenge');
      expect(hap).toMatch(/backend acme\n\s+server certbot 127\.0\.0\.1:8888\n/);
      expect(hap).toContain('bind 127.0.0.12:443 ssl crt /etc/haproxy/certs/site.pem');
    });
    it.skipIf(!hasHap)('the install script feeds both HAProxy and Kamailio TLS', () => {
      expect(install).toContain('site=/etc/haproxy/certs/site.pem');
      expect(install).toContain('kam_cert=/etc/kamailio/tls/cert.pem');
      expect(install).toContain('kam_key=/etc/kamailio/tls/key.pem');
      expect(install).toContain('kamcmd tls.reload');
      expect(read('edge-2', 'tls.cfg')).toMatch(/^certificate = \/etc\/kamailio\/tls\/cert\.pem$/m);
    });
  });

  // split-contracts O4: one origin for the website (/api/... calls), the course's tools (API at
  // the root, from an OpenAPI document without `servers`) and browser page loads.
  describe('§4/§6 website and API on one origin (edge HAProxy routing)', () => {
    const hasHap = rendered && existsSync(join(R, 'edge-1', 'haproxy.cfg'));
    const hap = hasHap ? read('edge-1', 'haproxy.cfg') : '';
    // A top-level section by its header line ("\n" + name: not "default_backend api" etc.).
    const section = (name: string) => {
      const i = hap.indexOf(`\n${name}\n`) + 1;
      return hap.slice(i, hap.indexOf('\n\n', hap.indexOf('\n', i) + 1));
    };
    it.skipIf(!hasHap)('clients are told to retire idle connections before HAProxy closes them', () => {
      // 2026-11-20 18:15: the course's client reused a socket idle 60 s = timeout client ->
      // "fetch failed (UND_ERR_SOCKET)".
      const ka = Number(/timeout http-keep-alive (\d+)s/.exec(section('defaults'))?.[1]);
      const told = Number(/http-response set-header Keep-Alive "timeout=(\d+)"/.exec(hap)?.[1]);
      expect(told).toBeGreaterThan(0);
      expect(ka).toBeGreaterThan(told + 30);
    });
    it.skipIf(!hasHap)('/api/... is stripped and flagged BEFORE routing, and the flag picks the API', () => {
      const https = hap.slice(hap.indexOf('\nfrontend https\n'), hap.indexOf('\nbackend kamailio_ws\n'));
      const setVar = https.indexOf('http-request set-var(txn.api_prefix) bool(true) if api_prefix');
      const strip = https.indexOf('http-request replace-path ^/api(/.*)$ \\1 if api_prefix');
      expect(setVar).toBeGreaterThan(0);
      expect(strip).toBeGreaterThan(setVar); // remembered first: after stripping, /api/ looks like /
      // Order of use_backend = priority: WebSocket, then anything that came in under /api, then web.
      const uses = [...https.matchAll(/^\s*(use_backend|default_backend) .*$/gm)].map((m) => m[0].trim());
      expect(uses).toEqual([
        'use_backend kamailio_ws if { path /ws }',
        'use_backend api if { var(txn.api_prefix) -m bool }',
        'use_backend web if web_static || web_files',
        'use_backend web if page_load wants_html !api_only',
        'default_backend api',
      ]);
      expect(https).toContain('acl wants_html req.hdr(accept) -m sub text/html');
      expect(https).toMatch(/acl api_only\s+path \/openapi\.json \/health \/ready \/metrics/);
    });
    it.skipIf(!hasHap)('the refresh cookie (Path=/auth) is rewritten to /api/auth for /api requests only', () => {
      expect(section('backend api')).toContain(
        'http-response replace-header Set-Cookie ^(.*;\\s*[Pp]ath=)/auth(;.*)?$ \\1/api/auth\\2 if { var(txn.api_prefix) -m bool }',
      );
    });
    it.skipIf(!hasHap)('backend web = nginx on every app node (web_port), health-checked', () => {
      const web = section('backend web');
      expect(web).toContain('option httpchk GET /');
      expect(web).toMatch(/server app-1-web 127\.0\.0\.31:8081 check/);
      expect(section('backend api')).toMatch(/server app-1 127\.0\.0\.31:3000 check/);
    });
  });
});

// Dedicated media nodes (inventory group `media`, tests/render-inventory-media.ini): rtpengine set 0
// stays the edges (calls already anchored there), set 1 = media nodes, a live switch decides which
// set NEW calls use, and each call's set rides in its Record-Route (;rs=1). README 2.4, V-T18.
const RM = join(import.meta.dirname, '../../../telephony/tests/.rendered-media');
const renderedMedia = existsSync(join(RM, 'edge-1', 'kamailio.cfg'));

describe.skipIf(!renderedMedia || !rendered)('rendered configs with media nodes', () => {
  const kam = renderedMedia ? readFileSync(join(RM, 'edge-1', 'kamailio.cfg'), 'utf8') : '';
  const today = rendered ? read('edge-1', 'kamailio.cfg') : '';

  it('kamailio -c passed on both edges', () => {
    const results = readFileSync(join(RM, 'results.txt'), 'utf8');
    expect(results).toMatch(/PASS kamailio -c edge-1/);
    expect(results).toMatch(/PASS kamailio -c edge-2/);
  });

  it('set 0 is exactly the edges list of today (calls in progress keep hashing to the same node); set 1 = media', () => {
    const set0 = today.match(/modparam\("rtpengine", "rtpengine_sock", "([^"]+)"\)/)![1];
    expect(set0).toBe('udp:127.0.0.11:2223 udp:127.0.0.12:2223');
    expect(kam).toContain(`modparam("rtpengine", "rtpengine_sock", "${set0}")`);
    expect(kam).toContain('modparam("rtpengine", "rtpengine_sock", "1 == udp:127.0.0.51:2223 udp:127.0.0.52:2223")');
    expect(kam).toContain('modparam("rtpengine", "setid_avp", "$avp(rtpset)")');
  });

  it('a live switch; after a restart it starts at group_vars rtpengine_media_new_calls (1 since 2026-11-15)', () => {
    expect(kam).toMatch(/^loadmodule "cfg_rpc\.so"$/m);
    expect(kam).toMatch(/^pbx\.media_rtp = 1 desc /m);
    expect(block(kam, 'route[RTP_SET_NEW]')).toContain('if ($sel(cfg_get.pbx.media_rtp) == 1) $avp(rtpset) = 1;');
  });

  it('every NEW call picks its set before its first rtpengine command and tags its Record-Route', () => {
    for (const r of ['route[FROM_CARRIER]', 'route[FROM_DEVICE]', 'route[TO_VENDOR]']) {
      const b = block(kam, r);
      expect(b.indexOf('route(RTP_SET_NEW)'), r).toBeGreaterThan(-1);
      expect(b.indexOf('route(RTP_SET_NEW)'), r).toBeLessThan(b.indexOf('rtpengine_offer'));
      expect(b.indexOf('route(RTP_SET_RR)'), r).toBeLessThan(b.indexOf('record_route()'));
    }
    // A fork: one set for all branches (TO_DEVICES), the tag on each branch's Record-Route.
    expect(block(kam, 'route[TO_DEVICES]')).toContain('route(RTP_SET_NEW)');
    const br = block(kam, 'branch_route[DEV_BRANCH]');
    expect(br.indexOf('route(RTP_SET_RR)')).toBeLessThan(br.indexOf('record_route()'));
    expect(block(kam, 'route[RTP_SET_RR]')).toContain('if ($avp(rtpset) == 1) add_rr_param(";rs=1");');
  });

  it('in-dialog requests use the call\'s own set; a relaying edge copies the tag; CANCEL uses the switch', () => {
    const wd = block(kam, 'route[WITHINDLG]');
    expect(wd).toContain('if (check_route_param("rs=1")) $avp(rtpset) = 1;');
    expect(wd.indexOf('check_route_param("rs=1")')).toBeLessThan(wd.indexOf('rtpengine_delete'));
    expect(wd.indexOf('check_route_param("rs=1")')).toBeLessThan(wd.indexOf('route(INDLG_SDP)'));
    const peer = block(kam, 'route[FROM_PEER]');
    expect(peer.indexOf('add_rr_param(";rs=1")')).toBeLessThan(peer.indexOf('record_route()'));
    const req = block(kam, 'request_route');
    expect(req.indexOf('route(RTP_SET_NEW)')).toBeLessThan(req.indexOf('rtpengine_delete'));
  });

  it('media nodes get an rtpengine config with their own internal/external interfaces', () => {
    const conf = readFileSync(join(RM, 'media-2', 'rtpengine.conf'), 'utf8');
    expect(conf).toMatch(/^interface = internal\/127\.0\.0\.52;external\/127\.0\.0\.52!127\.0\.1\.52$/m);
    expect(conf).toMatch(/^listen-ng = 127\.0\.0\.52:2223$/m);
  });
});

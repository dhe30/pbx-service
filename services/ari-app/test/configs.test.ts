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
      expect(kam).toMatch(/modparam\("dmq", "notification_address", "sip:127\.0\.0\.12:5060"\)/);
      expect(kam2).toMatch(/modparam\("dmq", "notification_address", "sip:127\.0\.0\.11:5060"\)/);
      expect(block(kam, 'route[DMQ]')).toMatch(/dmq_handle_message\(\)/);
    });
    it('auth and DID lookups use the read-only DB URL', () => {
      expect(kam).toMatch(/#!define DBURL_RO "postgres:\/\/kamailio:[^@]+@127\.0\.0\.1:5432\/pbx"/);
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
    it('the vendor endpoints the ARI app dials exist in pjsip.conf with digest auth via that edge', () => {
      const pjsip = read('pbx-1', 'pjsip.conf');
      const cfg = loadConfig({ ARI_USER: 'x', ARI_PASSWORD: 'x', DATABASE_URL: 'x', S3_ENDPOINT: 'http://s', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' });
      const ctx = { cfg } as Ctx;
      for (const vendor of ['us', 'intl'] as const) {
        for (const [trunk, ip] of [['edge-a', '127.0.0.11'], ['edge-b', '127.0.0.12']]) {
          const ep = vendorEndpoint(ctx, vendor, 'h', trunk!, '+1').split('/')[1]!;
          expect(pjsip).toContain(`[${ep}](edge-common)`);
          const section = pjsip.slice(pjsip.indexOf(`[${ep}](edge-common)`)).split('\n\n')[0]!;
          expect(section).toContain(`outbound_proxy=sip:${ip}:5060\\;lr`);
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
    it('dialplan hands every call to Stasis with the source and SIP user from Kamailio', () => {
      const ext = read('pbx-1', 'extensions.conf');
      expect(ext).toMatch(/exten => _\[\+\*#0-9\]!,1/); // *98 and extension numbers too
      expect(ext).toMatch(/Stasis\(pbx-app,\$\{PJSIP_HEADER\(read,X-PBX-Src\)\},\$\{PJSIP_HEADER\(read,X-PBX-User\)\}\)/);
      expect(ext).toMatch(/Hangup\(34\)/);
    });
  });

  describe('B2/B3/B5', () => {
    it('B2: course testers are exempt from pike; carrier IP from the Course Services tab', () => {
      expect(kam).toMatch(/is_in_subnet\("\$si", "130\.245\.136\.0\/24"\)\) setflag\(FLT_TRUSTED\)/);
      expect(kam).toMatch(/is_in_subnet\("\$si", "130\.245\.136\.142\/32"\) && \$pr == "udp"\)/);
      expect(block(kam, 'route[REQINIT]')).toMatch(/if \(isflagset\(FLT_DEVICE_SRC\) && !isflagset\(FLT_TRUSTED\)\)/);
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
      expect(block(kam, 'route[FROM_CARRIER]')).toMatch(/sql_query\("ro", "select tenant_id from public\.kamailio_did_tenant/);
      expect(read('edge-1', 'dispatcher.list')).toMatch(/1 sip:127\.0\.0\.21:5060 0 0\n1 sip:127\.0\.0\.22:5060 0 0/);
    });
  });
});

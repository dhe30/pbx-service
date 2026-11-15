#!/usr/bin/env python3
"""What does an SRTP phone receive when the RTP from Asterisk changes SSRC mid-call?

Drives this edge's rtpengine directly over its ng control port (no SIP, no Asterisk) and replays the
media of call 3bf2b8eb (2026-11-15, "bad_codec at a phone that takes PCMU with SRTP"):

  fake Asterisk (RTP/AVP, PCMU) <-> rtpengine <-> fake TLS phone (RTP/SAVP, SDES AES_CM_128_HMAC_SHA1_80)

set up with the flags kamailio.cfg uses for a staff_tls leg (F.tls.pbx_offer / pbx_answer). The fake
Asterisk sends SSRC A, then switches to SSRC B with jumped sequence numbers and timestamps (what
Asterisk's native RTP bridge does when it starts passing the other party's packets through). The
fake phone sends SRTP from a different port than its SDP says, like the course simulator.
Everything rtpengine sends the phone is decrypted with the key rtpengine offered and judged by three
receiver models: rfc (RFC 3711, one context per SSRC), latch (keeps the first SSRC only) and shared
(one replay window for all SSRCs). docs/incidents/2026-11-15-tls-bad-codec.md has the results.

Run on an edge (the ng port only listens on its private IP; the kernel forwarding path is only there):
    loadtest/diag/remote.sh edge-2 py loadtest/diag/srtp-ssrc-replay.py --ip 10.0.0.42
Each case is one ~6 s rtpengine session (Call-ID pbxtest-ssrc-*), deleted afterwards. The audio
record (pbx-call-audio) will list it, and may raise one CustomerCallAudioBad alert.
    --selftest     check the SRTP code against RFC 3711 test vectors (no rtpengine needed)
Needs python3-cryptography (installed with certbot on the edges).
"""
import argparse, base64, hashlib, hmac, os, re, select, socket, struct, sys, time

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:
    sys.exit('needs python3-cryptography')

# kamailio.cfg.j2 F.tls.pbx_offer / pbx_answer, as Kamailio's rtpengine module sends them: it parses
# the flag strings into ng keys (rtpengine 26 ignores a raw "rtpp-flags" string from us: it then
# offered plain RTP/AVP without crypto).
OFFER_KEYS = {'direction': ['internal', 'external'], 'replace': ['origin', 'session-connection'], 'ICE': 'remove',
              'DTLS': 'off', 'transport-protocol': 'RTP/SAVP',
              'SDES': ['only-AES_CM_128_HMAC_SHA1_80', 'only-AES_CM_128_HMAC_SHA1_32'],
              'codec': {'transcode': ['PCMA', 'G729', 'G723', 'opus']}}
ANSWER_KEYS = {'replace': ['origin', 'session-connection'], 'ICE': 'remove', 'DTLS': 'off', 'transport-protocol': 'RTP/AVP'}

# ---------------- bencode / ng ----------------
def benc(x):
    if isinstance(x, int): return b'i%de' % x
    if isinstance(x, str): x = x.encode()
    if isinstance(x, bytes): return b'%d:%s' % (len(x), x)
    if isinstance(x, list): return b'l' + b''.join(benc(v) for v in x) + b'e'
    if isinstance(x, dict): return b'd' + b''.join(benc(k) + benc(x[k]) for k in sorted(x)) + b'e'
    raise TypeError(x)

def bdec(d, i=0):
    c = d[i:i + 1]
    if c == b'i':
        j = d.index(b'e', i); return int(d[i + 1:j]), j + 1
    if c == b'l':
        i += 1; out = []
        while d[i:i + 1] != b'e':
            v, i = bdec(d, i); out.append(v)
        return out, i + 1
    if c == b'd':
        i += 1; out = {}
        while d[i:i + 1] != b'e':
            k, i = bdec(d, i); v, i = bdec(d, i); out[k.decode()] = v
        return out, i + 1
    j = d.index(b':', i); n = int(d[i:j]); return d[j + 1:j + 1 + n], j + 1 + n

def ng(addr, cmd):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
    cookie = os.urandom(6).hex().encode()
    s.sendto(cookie + b' ' + benc(cmd), addr)
    data = s.recv(65535); s.close()
    _, _, body = data.partition(b' ')
    r, _ = bdec(body)
    if r.get('result') != b'ok':
        sys.exit(f"ng {cmd['command']} failed: {r}")
    return r

# ---------------- SRTP (RFC 3711, AES_CM_128_HMAC_SHA1_80) ----------------
def aes_ctr(key, iv16, n):
    e = Cipher(algorithms.AES(key), modes.CTR(iv16)).encryptor()
    return e.update(b'\0' * n) + e.finalize()

def kdf(mk, ms, label, n):
    x = int.from_bytes(ms, 'big') ^ (label << 48)
    return aes_ctr(mk, (x << 16).to_bytes(16, 'big'), n)

class Keys:
    def __init__(self, inline_b64):
        raw = base64.b64decode(inline_b64.split('|')[0]); mk, ms = raw[:16], raw[16:30]
        self.ke, self.ka, self.ks = kdf(mk, ms, 0, 16), kdf(mk, ms, 1, 20), kdf(mk, ms, 2, 14)

    def iv(self, ssrc, index):
        return ((int.from_bytes(self.ks, 'big') << 16) ^ (ssrc << 64) ^ (index << 16)).to_bytes(16, 'big')

    def protect(self, hdr, payload, ssrc, index):
        enc = bytes(a ^ b for a, b in zip(payload, aes_ctr(self.ke, self.iv(ssrc, index), len(payload))))
        roc = index >> 16
        tag = hmac.new(self.ka, hdr + enc + struct.pack('>I', roc), hashlib.sha1).digest()[:10]
        return hdr + enc + tag

    def unprotect(self, pkt, hlen, ssrc, index):
        body, tag = pkt[:-10], pkt[-10:]
        roc = index >> 16
        if hmac.new(self.ka, body + struct.pack('>I', roc), hashlib.sha1).digest()[:10] != tag:
            return None
        enc = body[hlen:]
        return bytes(a ^ b for a, b in zip(enc, aes_ctr(self.ke, self.iv(ssrc, index), len(enc))))

def rtp_hdr(pt, seq, ts, ssrc, marker=False):
    return struct.pack('>BBHII', 0x80, (0x80 if marker else 0) | pt, seq & 0xFFFF, ts & 0xFFFFFFFF, ssrc)

def parse_hdr(p):
    b0, b1, seq, ts, ssrc = struct.unpack('>BBHII', p[:12])
    hlen = 12 + 4 * (b0 & 0x0F)
    if b0 & 0x10:
        hlen += 4 + 4 * struct.unpack('>H', p[hlen + 2:hlen + 4])[0]
    return dict(pt=b1 & 0x7F, m=bool(b1 & 0x80), seq=seq, ts=ts, ssrc=ssrc, hlen=hlen)

MAGIC = b'PBXT'
def payload(counter, stream):
    return MAGIC + struct.pack('>BI', stream, counter) + b'\xff' * (160 - 9)

def est_index(st, seq):
    """RFC 3711 appendix A index guess; st = {'s_l','roc'} or None (first packet)."""
    if st is None: return seq
    s_l, roc = st['s_l'], st['roc']
    if s_l < 32768:
        v = roc - 1 if seq - s_l > 32768 else roc
    else:
        v = roc + 1 if s_l - 32768 > seq else roc
    return max(v, 0) * 65536 + seq

# ---------------- receiver models ----------------
def judge(pkts, keys, model):
    """pkts: list of raw SRTP packets as received by the phone. Returns per-SSRC counts."""
    res, per, shared, latched = {}, {}, None, None
    for p in pkts:
        h = parse_hdr(p); s = h['ssrc']
        r = res.setdefault(s, dict(rx=0, ok=0, auth_fail=0, replay_drop=0, other_ssrc_drop=0, bad_payload=0))
        r['rx'] += 1
        if model == 'latch':
            latched = s if latched is None else latched
            if s != latched: r['other_ssrc_drop'] += 1; continue
        st = per.get(s) if model in ('rfc', 'latch') else shared
        idx = est_index(st, h['seq'])
        if st is not None:
            hi = st['s_l'] + 65536 * st['roc']
            if idx in st['seen'] or idx <= hi - 64:
                r['replay_drop'] += 1; continue
        plain = keys.unprotect(p, h['hlen'], s, idx)
        if plain is None:
            r['auth_fail'] += 1; continue
        if not plain.startswith(MAGIC): r['bad_payload'] += 1; continue
        r['ok'] += 1
        if st is None:
            st = dict(s_l=h['seq'], roc=0, seen=set())
        if idx > st['s_l'] + 65536 * st['roc']:
            st['s_l'], st['roc'] = idx & 0xFFFF, idx >> 16
        st['seen'].add(idx)
        if model in ('rfc', 'latch'): per[s] = st
        else: shared = st
    return res

# ---------------- one replay ----------------
def run(a, name, switch_after, b_seq, duration=5.0, phone_starts=3.0):
    ip = a.ip
    def udp():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind((ip, 0)); s.setblocking(False); return s
    pbx, phone_sdp, phone_src = udp(), udp(), udp()
    p1, p2 = pbx.getsockname()[1], phone_sdp.getsockname()[1]
    cid = f'pbxtest-ssrc-{name}-{int(time.time())}'
    ftag, ttag, vb = 'ast' + os.urandom(4).hex(), 'ph' + os.urandom(4).hex(), 'z9hG4bKtest' + os.urandom(4).hex()
    offer_sdp = (f"v=0\r\no=- 1 1 IN IP4 {ip}\r\ns=Asterisk\r\nc=IN IP4 {ip}\r\nt=0 0\r\n"
                 f"m=audio {p1} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n"
                 f"a=fmtp:101 0-16\r\na=ptime:20\r\na=maxptime:150\r\na=sendrecv\r\n")
    r = ng(a.ng, {'command': 'offer', 'call-id': cid, 'from-tag': ftag, 'via-branch': vb, 'sdp': offer_sdp, **OFFER_KEYS})
    osdp = r['sdp'].decode()
    x_port = int(re.search(r'^m=audio (\d+) (\S+) ([0-9 ]+)', osdp, re.M).group(1))
    crypto = dict((int(t), (suite, key)) for t, suite, key in re.findall(r'^a=crypto:(\d+) (\S+) inline:(\S+)', osdp, re.M))
    to_phone_keys = Keys(crypto[1][1]) if crypto.get(1, ('',))[0] == 'AES_CM_128_HMAC_SHA1_80' else None
    phone_key_raw = os.urandom(30)
    phone_keys = Keys(base64.b64encode(phone_key_raw).decode())
    answer_sdp = (f"v=0\r\no=- 2 2 IN IP4 {ip}\r\ns=phone\r\nc=IN IP4 {ip}\r\nt=0 0\r\n"
                  f"m=audio {p2} RTP/SAVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n"
                  f"a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:{base64.b64encode(phone_key_raw).decode()}\r\na=sendrecv\r\n")
    r = ng(a.ng, {'command': 'answer', 'call-id': cid, 'from-tag': ftag, 'to-tag': ttag, 'via-branch': vb, 'sdp': answer_sdp, **ANSWER_KEYS})
    asdp = r['sdp'].decode()
    y_port = int(re.search(r'^m=audio (\d+)', asdp, re.M).group(1))
    y_ip = re.search(r'^c=IN IP4 (\S+)', asdp, re.M).group(1)

    # Schedules (t, kind). Fake Asterisk: SSRC A until switch_after, then SSRC B (seq/ts jump).
    A, B, P = 0x11111111, 0x22222222, 0x33333333
    a_seq, a_ts = 40000, 1000000
    sched = []
    end_a = duration if switch_after is None else switch_after
    n = 0
    while n == 0 or n * 0.020 < end_a:  # at least one A packet
        sched.append((n * 0.020, 'pbx', A, a_seq + n, a_ts + 160 * n, n, n == 0)); n += 1
    if switch_after is not None:
        k = 0
        while switch_after + 0.020 * k < duration:
            sched.append((switch_after + 0.020 * k, 'pbx', B, b_seq + k, 3000000 + 160 * k, n + k, k == 0)); k += 1
    m = 0; t = phone_starts
    while t < duration:
        sched.append((t, 'phone', P, 20000 + m, 5000000 + 160 * m, m, m == 0)); m += 1; t = phone_starts + 0.020 * m
    sched.sort(key=lambda s: s[0])

    to_phone, to_pbx = [], []
    t0 = time.monotonic(); i = 0
    while True:
        now = time.monotonic() - t0
        while i < len(sched) and sched[i][0] <= now:
            _, who, ssrc, seq, ts, ctr, mk = sched[i]; i += 1
            if who == 'pbx':
                pbx.sendto(rtp_hdr(0, seq, ts, ssrc, mk) + payload(ctr, 1 if ssrc == A else 2), (y_ip, y_port))
            else:
                hdr = rtp_hdr(0, seq, ts, ssrc, mk)
                phone_src.sendto(phone_keys.protect(hdr, payload(ctr, 3), ssrc, seq), (ip, x_port))
        if now > duration + 0.5: break
        rl, _, _ = select.select([pbx, phone_sdp, phone_src], [], [], 0.005)
        for s in rl:
            try:
                while True:
                    data, src = s.recvfrom(4096)
                    if data[1] & 0x7F in (72, 73, 74, 75, 76, 77, 78, 79): continue  # RTCP
                    (to_pbx if s is pbx else to_phone).append((now, s.getsockname()[1], data))
            except BlockingIOError:
                pass
    q = ng(a.ng, {'command': 'query', 'call-id': cid, 'from-tag': ftag})
    ng(a.ng, {'command': 'delete', 'call-id': cid, 'from-tag': ftag})
    for s in (pbx, phone_sdp, phone_src): s.close()

    print(f'\n===== {name}: switch_after={switch_after} B seq start={b_seq} (A seq start {a_seq}); call-id {cid}')
    print(f"offer to phone: m={re.search(r'^m=.*$', osdp, re.M).group(0)} crypto tags {sorted((k, v[0]) for k, v in crypto.items())}")
    sent_a = sum(1 for s in sched if s[1] == 'pbx' and s[2] == A); sent_b = sum(1 for s in sched if s[1] == 'pbx' and s[2] == B)
    print(f'sent by fake Asterisk: SSRC A {sent_a}, SSRC B {sent_b}; by phone {m}')
    ssrcs, ports, pts = {}, {}, {}
    for _, port, p in to_phone:
        h = parse_hdr(p); ssrcs[h['ssrc']] = ssrcs.get(h['ssrc'], 0) + 1
        ports[port] = ports.get(port, 0) + 1; pts[h['pt']] = pts.get(h['pt'], 0) + 1
    names = {A: 'A', B: 'B', P: 'P'}
    print('received by phone: ', {names.get(k, hex(k)): v for k, v in ssrcs.items()}, 'on ports',
          {('sdp' if k == p2 else 'src'): v for k, v in ports.items()}, 'pt', pts)
    if to_phone_keys:
        seqs = [(names.get(parse_hdr(p)['ssrc'], '?'), parse_hdr(p)['seq']) for _, _, p in to_phone[:3]]
        sw = next((k for k in range(1, len(to_phone)) if parse_hdr(to_phone[k][2])['ssrc'] != parse_hdr(to_phone[k - 1][2])['ssrc']), None)
        if sw:
            print('  around the switch:', [(names.get(parse_hdr(p)['ssrc'], '?'), parse_hdr(p)['seq'], round(t, 3)) for t, _, p in to_phone[max(0, sw - 2):sw + 3]])
        for model in ('rfc', 'latch', 'shared'):
            res = judge([p for _, _, p in to_phone], to_phone_keys, model)
            print(f'  phone model {model:6}:', {names.get(k, hex(k)): v for k, v in res.items()})
    else:
        print('  rtpengine did not offer AES_CM_128_HMAC_SHA1_80 as tag 1:', crypto)
    ok_pbx = sum(1 for _, _, p in to_pbx if p[12:16] == MAGIC)
    print(f'received by fake Asterisk (phone->pbx, decrypted by rtpengine): {len(to_pbx)} packets, {ok_pbx} with intact payload')
    tags = q.get('tags', {})
    for tag, tv in tags.items():
        for med in tv.get('medias', []):
            for st in med.get('streams', []):
                stats = st.get('stats', {})
                print(f"  rtpengine stream tag {tag[:6]} local {st.get('local port')}: packets {stats.get('packets')} errors {stats.get('errors')}")


def selftest():
    # RFC 3711 appendix B.3 (key derivation)
    mk = bytes.fromhex('E1F97A0D3E018BE0D64FA32C06DE4139'); ms = bytes.fromhex('0EC675AD498AFEEBB6960B3AABE6')
    k = Keys(base64.b64encode(mk + ms).decode())
    assert k.ke.hex().upper() == 'C61E7A93744F39EE10734AFE3FF7A087', k.ke.hex()
    assert k.ks.hex().upper() == '30CBBC08863D8C85D49DB34A9AE1', k.ks.hex()
    assert k.ka.hex().upper().startswith('CEBE321F6FF7716B6FD4AB49AF256A15'), k.ka.hex()
    # 5 packets of SSRC A (seq 40000..), then 5 of SSRC B with LOWER sequence numbers.
    A, B = 0x11111111, 0x22222222
    pk = [k.protect(rtp_hdr(0, 40000 + i, 160 * i, A), payload(i, 1), A, 40000 + i) for i in range(5)]
    pk += [k.protect(rtp_hdr(0, 12000 + i, 160 * i, B), payload(i, 2), B, 12000 + i) for i in range(5)]
    got = {m: judge(pk, k, m) for m in ('rfc', 'latch', 'shared')}
    assert got['rfc'][A]['ok'] == 5 and got['rfc'][B]['ok'] == 5, got['rfc']
    assert got['latch'][B]['other_ssrc_drop'] == 5, got['latch']
    assert got['shared'][B]['replay_drop'] == 5, got['shared']
    tampered = bytearray(pk[0]); tampered[20] ^= 1
    assert judge([bytes(tampered)], k, 'rfc')[A]['auth_fail'] == 1
    print('selftest ok')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ip', help="this edge's private IP (rtpengine interface + ng address)")
    ap.add_argument('--ng-port', type=int, default=2223)
    ap.add_argument('--only', help='run one case: control, switch15ms-lower, switch15ms-higher, switch2s-lower')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.ip:
        ap.error('--ip is required (or --selftest)')
    a.ng = (a.ip, a.ng_port)
    cases = [
        ('control', None, 0),               # no SSRC switch at all
        ('switch15ms-lower', 0.015, 12000),  # like 3bf2b8eb: 1 packet A, then B; B seq lower than A
        ('switch15ms-higher', 0.015, 60000), # same, B seq higher
        ('switch2s-lower', 2.0, 12000),      # switch after the stream has been in the kernel for 2 s
    ]
    for name, sw, bseq in cases:
        if a.only and a.only != name: continue
        run(a, name, sw, bseq)


if __name__ == '__main__':
    main()

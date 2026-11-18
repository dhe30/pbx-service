#!/usr/bin/env python3
"""Read-only: are "slow phones" really slow, or are our INVITEs to them getting lost?

    loadtest/diag/remote.sh edge-2 py loadtest/diag/invite-delay.py [files=2] [dir=/var/log/pbx/sipdump]

For every INVITE an edge sends to a phone/vendor on the internet over UDP, measures the time to the
first reply from that host and how many copies of the INVITE we had sent by then. SIP over UDP
resends an unanswered INVITE after 0.5 s, 1.5 s, 3.5 s, 7.5 s. If our first copy is lost, the phone
answers the resend, so delays cluster just after those times, with copies > 1. A phone that is
merely slow answers at any time after copy 1. TLS/TCP has no resends (shown separately).
Streams the newest N hourly sipdump files at nice 10; keeps a few numbers per INVITE.
"""
import collections
import glob
import ipaddress
import os
import struct
import sys

os.nice(10)
n = int(sys.argv[1]) if len(sys.argv) > 1 else 2
folder = sys.argv[2] if len(sys.argv) > 2 else '/var/log/pbx/sipdump'
files = sorted(glob.glob(os.path.join(folder, '*.pcap')), key=os.path.getmtime)[-n:]
PRIVATE = ipaddress.ip_network('10.0.0.0/8')


def packets(path):
    with open(path, 'rb') as f:
        head = f.read(24)
        endian = '<' if head[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
        nanos = head[:4] in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
        off = {1: 14, 113: 16, 276: 20, 101: 0, 12: 0}[struct.unpack(endian + 'I', head[20:24])[0]]
        while True:
            rec = f.read(16)
            if len(rec) < 16:
                return
            sec, frac, incl, _ = struct.unpack(endian + 'IIII', rec)
            data = f.read(incl)
            ip = data[off:]
            if len(ip) < 28 or ip[0] >> 4 != 4:
                continue
            ihl = (ip[0] & 0x0F) * 4
            yield (sec + frac / (1e9 if nanos else 1e6), str(ipaddress.IPv4Address(ip[12:16])),
                   str(ipaddress.IPv4Address(ip[16:20])), ip[ihl + 8:])


def header(lines, *names):
    for line in lines[1:]:
        k, _, v = line.partition(':')
        if k.strip().lower() in names:
            return v.strip()
    return ''


sent = {}      # (call-id, cseq, host) -> [first send time, copies, transport, reply delay, copies at reply]
for path in files:
    for t, src, dst, payload in packets(path):
        head = payload.split(b'\r\n\r\n', 1)[0].decode('latin-1')
        lines = head.split('\r\n')
        first = lines[0].split(' ')
        if len(first) < 2:
            continue
        cseq = header(lines, 'cseq')
        if not cseq.endswith('INVITE'):
            continue
        cid = header(lines, 'call-id', 'i')
        if first[0] == 'INVITE' and ipaddress.ip_address(src) in PRIVATE \
                and ipaddress.ip_address(dst) not in PRIVATE:
            key = (cid, cseq, dst)
            dump = header(lines, 'p-ksr-sipdump').lower()
            tr = 'tls' if 'tls' in dump else 'tcp' if 'tcp' in dump else 'udp'
            e = sent.setdefault(key, [t, 0, tr, None, None])
            if e[3] is None:
                e[1] += 1
        elif first[0] == 'SIP/2.0':
            e = sent.get((cid, cseq, src))
            if e and e[3] is None:
                e[3], e[4] = t - e[0], e[1]

BUCKETS = [0.1, 0.45, 0.6, 1.4, 1.6, 3.4, 3.6, 7.4, 7.6, 15, 1e9]
print('files:', ', '.join(os.path.basename(f) for f in files))
for tr in ('udp', 'tls', 'tcp'):
    rows = [e for e in sent.values() if e[2] == tr]
    if not rows:
        continue
    answered = [e for e in rows if e[3] is not None]
    print(f'\n{tr}: {len(rows)} INVITEs to the internet, {len(rows) - len(answered)} never answered '
          f'in the capture, {sum(1 for e in rows if e[1] > 1)} needed a resend')
    hist = collections.Counter()
    for e in answered:
        b = next(i for i, x in enumerate(BUCKETS) if e[3] < x)
        hist[(b, min(e[4], 5))] += 1
    lo = 0
    for i, hi in enumerate(BUCKETS):
        cnt = {c: hist[(i, c)] for c in range(1, 6) if hist[(i, c)]}
        if cnt:
            label = f'{lo:.2f}-{hi:.2f}s' if hi < 1e8 else f'>{lo:.0f}s'
            print(f'  first reply {label:>13}: {sum(cnt.values()):6d}   by copies sent before it: {cnt}')
        lo = hi
    hosts = collections.defaultdict(lambda: [0, 0])
    for e, k in ((e, k) for k, e in sent.items() if e[2] == tr):
        hosts[k[2]][0] += 1
        hosts[k[2]][1] += e[1] > 1
    print('  resend share by host (top 10 by INVITEs):')
    for h, (tot, rs) in sorted(hosts.items(), key=lambda x: -x[1][0])[:10]:
        print(f'    {h:16} {tot:6d} INVITEs  {100 * rs / tot:5.1f}% resent')

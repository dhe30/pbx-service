#!/usr/bin/env python3
"""Where does a call's audio stop? Per-flow RTP timelines and gaps from an edge capture.

Each UDP flow (src ip:port -> dst ip:port) in the RTP port ranges is one direction of one media
stream: party -> rtpengine (public side, 30000-40000 on the edge) or rtpengine -> Asterisk
(private side, Asterisk RTP 10000-20000). For every flow this prints first/last packet, packet
count, RTP payload types, SSRC changes, and every gap of at least --gap seconds. Comparing the two
directions of the same call around a gap shows whether the party stopped sending (the gap starts
on party -> edge) or our relay stopped delivering (party -> edge continues, edge -> Asterisk stops).

Capture headers only (RTP header fits in 64 bytes):
    timeout 1800 tcpdump -ni ens3 -s 64 -w /tmp/vm-rtp.pcap 'udp and (portrange 10000-20000 or portrange 30000-40000)'
Run on the edge:
    loadtest/diag/remote.sh edge-1 py loadtest/diag/rtp-gaps.py /tmp/vm-rtp.pcap --gap 2 --around 09:58:10
Options:
    --gap S          report gaps >= S seconds (default 2)
    --around HH:MM:SS[,HH:MM:SS...]   only flows active within 60 s of these UTC times
    --peer IP        only flows to or from IP
"""
import argparse
import struct
import sys
from collections import defaultdict
from datetime import datetime, timezone


def packets(path):
    with open(path, 'rb') as f:
        head = f.read(24)
        magic = head[:4]
        endian = '<' if magic in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
        nanos = magic in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
        linktype = struct.unpack(endian + 'I', head[20:24])[0]
        off = {1: 14, 113: 16, 276: 20}.get(linktype, 0)
        while True:
            rec = f.read(16)
            if len(rec) < 16:
                return
            sec, frac, incl, _ = struct.unpack(endian + 'IIII', rec)
            data = f.read(incl)
            ip = data[off:]
            if len(ip) < 28 or ip[9] != 17:
                continue
            ihl = (ip[0] & 0x0F) * 4
            src = '.'.join(map(str, ip[12:16]))
            dst = '.'.join(map(str, ip[16:20]))
            sport, dport = struct.unpack('>HH', ip[ihl:ihl + 4])
            rtp = ip[ihl + 8:ihl + 20]
            pt = ssrc = None
            if len(rtp) >= 12 and rtp[0] >> 6 == 2:          # RTP version 2
                pt = rtp[1] & 0x7F
                ssrc = struct.unpack('>I', rtp[8:12])[0]
            yield sec + frac / (1e9 if nanos else 1e6), src, sport, dst, dport, pt, ssrc


def hms(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime('%H:%M:%S.%f')[:-3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pcap')
    ap.add_argument('--gap', type=float, default=2.0)
    ap.add_argument('--around', default='')
    ap.add_argument('--peer', default='')
    a = ap.parse_args()

    flows = defaultdict(lambda: {'first': None, 'last': None, 'n': 0, 'pts': defaultdict(int), 'ssrcs': [], 'gaps': []})
    day = None
    for t, src, sport, dst, dport, pt, ssrc in packets(a.pcap):
        if pt is not None and 72 <= pt <= 76:
            continue                                           # RTCP (SR/RR/...), not media
        if a.peer and a.peer not in (src, dst):
            continue
        day = day or datetime.fromtimestamp(t, timezone.utc).date()
        fl = flows[(src, sport, dst, dport)]
        if fl['last'] is not None and t - fl['last'] >= a.gap:
            fl['gaps'].append((fl['last'], t))
        fl['first'] = fl['first'] or t
        fl['last'] = t
        fl['n'] += 1
        if pt is not None:
            fl['pts'][pt] += 1
        if ssrc is not None and (not fl['ssrcs'] or fl['ssrcs'][-1][1] != ssrc):
            fl['ssrcs'].append((t, ssrc))

    targets = []
    if a.around and day:
        for s in a.around.split(','):
            h, m, sec = (int(x) for x in s.strip().split(':'))
            targets.append(datetime(day.year, day.month, day.day, h, m, sec, tzinfo=timezone.utc).timestamp())

    rows = []
    for (src, sport, dst, dport), fl in flows.items():
        if fl['n'] < 20:
            continue
        if targets and not any(fl['first'] - 60 <= x <= fl['last'] + 60 for x in targets):
            continue
        rows.append((fl['first'], src, sport, dst, dport, fl))
    for first, src, sport, dst, dport, fl in sorted(rows):
        dur = fl['last'] - fl['first']
        pts = ','.join(f'{p}:{n}' for p, n in sorted(fl['pts'].items()))
        print(f'{hms(first)} -> {hms(fl["last"])} ({dur:6.1f} s) {src}:{sport} -> {dst}:{dport}  '
              f'{fl["n"]} pkts, {fl["n"] / dur if dur else 0:.0f}/s, pt {pts}, ssrc changes {len(fl["ssrcs"]) - 1}')
        for g0, g1 in fl['gaps']:
            print(f'      GAP {g1 - g0:5.1f} s: {hms(g0)} -> {hms(g1)}')
        if fl['last'] and rows:
            pass


if __name__ == '__main__':
    main()

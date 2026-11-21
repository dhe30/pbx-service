#!/usr/bin/env python3
"""What audio did each RTP stream of a call carry? Decode and compare streams from a media capture.

Packet counts (pbx-call-audio, rtpengine's final stats) show that packets flowed, not what they
carried. This reads a FULL-payload capture (tcpdump -s 0) and, per UDP flow (one direction of one
media stream), prints:
  - packets, duration, payload types, payload sizes and RTP timestamp steps (ptime: 20 vs 30 ms),
    sequence gaps, SSRC changes (with times);
  - for PCMU / PCMA (every rtpengine <-> Asterisk leg is PCMU): loudness per second (dBFS) and
    the share of near-silent seconds;
and, with --corr, whether one PCMU flow carries the same audio as another (e.g. the caller's
stream into Asterisk vs Asterisk's stream toward the transfer target): normalised correlation of
their 20 ms loudness envelopes over arrival time, best lag within +-2 s.

Capture on a media node (see docs/incidents/2026-11-17-hold-before-answer.md for the plan):
    tcpdump -Z root -ni ens3 -s 0 -w /var/tmp/rtpcap/rtp.pcap udp portrange 30000-40000
Cut one call out ON THE NODE (ports from rtpengine's "Kernelizing media stream" lines), then copy
the small file here and analyse it here (never run this on a production node):
    tcpdump -r rtp.pcap00 -w call.pcap 'udp port 33096 or udp port 33428'
    python3 -I rtp-audio.py call.pcap [--wav outdir] [--corr 1,3] [--port 33096]
Standard library only.
"""
import argparse
import math
import os
import struct
import sys
import wave
from collections import Counter, defaultdict
from datetime import datetime, timezone


def ulaw_table():
    t = []
    for b in range(256):
        u = ~b & 0xFF
        sign, exp, mant = u & 0x80, (u >> 4) & 0x07, u & 0x0F
        mag = ((mant << 3) + 0x84) << exp
        mag -= 0x84
        t.append(-mag if sign else mag)
    return t


def alaw_table():
    t = []
    for b in range(256):
        a = b ^ 0x55
        sign, exp, mant = a & 0x80, (a >> 4) & 0x07, a & 0x0F
        mag = (mant << 4) + 8 if exp == 0 else ((mant << 4) + 0x108) << (exp - 1)
        t.append(mag if sign else -mag)
    return t


DECODE = {0: ulaw_table(), 8: alaw_table()}
STATIC_NAMES = {0: 'PCMU', 8: 'PCMA', 4: 'G723', 18: 'G729', 13: 'CN'}


def packets(path):
    """(time, src, sport, dst, dport, udp payload) for every IPv4/UDP packet of a pcap file."""
    with open(path, 'rb') as f:
        head = f.read(24)
        if len(head) < 24:
            return
        magic = head[:4]
        if magic in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1'):
            endian = '<'
        elif magic in (b'\xa1\xb2\xc3\xd4', b'\xa1\xb2\x3c\x4d'):
            endian = '>'
        else:
            sys.exit(f'{path}: not a classic pcap file')
        nano = magic in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
        linktype = struct.unpack(endian + 'I', head[20:24])[0]
        rec = struct.Struct(endian + 'IIII')
        while True:
            h = f.read(16)
            if len(h) < 16:
                return
            sec, frac, incl, _ = rec.unpack(h)
            data = f.read(incl)
            t = sec + frac / (1e9 if nano else 1e6)
            if linktype == 1:  # Ethernet
                off, etype = 14, struct.unpack('>H', data[12:14])[0]
                if etype == 0x8100:
                    off, etype = 18, struct.unpack('>H', data[16:18])[0]
            elif linktype == 113:  # Linux cooked (any)
                off, etype = 16, struct.unpack('>H', data[14:16])[0]
            elif linktype == 276:  # Linux cooked v2
                off, etype = 20, struct.unpack('>H', data[0:2])[0]
            else:
                sys.exit(f'{path}: link type {linktype} not supported')
            if etype != 0x0800 or len(data) < off + 28:
                continue
            ip = data[off:]
            ihl = (ip[0] & 0x0F) * 4
            if ip[9] != 17:
                continue
            src, dst = '.'.join(map(str, ip[12:16])), '.'.join(map(str, ip[16:20]))
            sport, dport = struct.unpack('>HH', ip[ihl:ihl + 4])
            yield t, src, sport, dst, dport, ip[ihl + 8:]


def rtp(payload):
    """(pt, seq, ts, ssrc, media payload) or None if it isn't RTP (RTCP, STUN, ...)."""
    if len(payload) < 12 or payload[0] >> 6 != 2:
        return None
    pt = payload[1] & 0x7F
    if 72 <= pt <= 76:  # RTCP shares the first bits
        return None
    seq, ts, ssrc = struct.unpack('>HII', payload[2:12])
    off = 12 + 4 * (payload[0] & 0x0F)
    if payload[0] & 0x10 and len(payload) >= off + 4:  # header extension
        off += 4 + 4 * struct.unpack('>H', payload[off + 2:off + 4])[0]
    end = len(payload)
    if payload[0] & 0x20 and end > off:  # padding
        end -= payload[-1]
    return pt, seq, ts, ssrc, payload[off:end]


class Flow:
    def __init__(self, key):
        self.key = key
        self.n = 0
        self.first = self.last = None
        self.pts = Counter()
        self.sizes = Counter()
        self.ts_steps = Counter()
        self.ssrc_changes = []  # (time, old, new)
        self.seq_gaps = 0
        self.prev = None  # (seq, ts, ssrc)
        self.env = []  # (time, rms) per decoded packet
        self.audio = bytearray()  # 16-bit little-endian PCM (PCMU/PCMA only)
        self.raw = defaultdict(bytearray)  # pt -> concatenated payloads (other codecs)

    def add(self, t, pt, seq, ts, ssrc, media, keep_audio):
        self.n += 1
        self.first = t if self.first is None else self.first
        self.last = t
        self.pts[pt] += 1
        self.sizes[len(media)] += 1
        if self.prev:
            pseq, pts_, pssrc = self.prev
            if ssrc != pssrc:
                self.ssrc_changes.append((t, pssrc, ssrc))
            else:
                if (seq - pseq) & 0xFFFF != 1:
                    self.seq_gaps += 1
                self.ts_steps[(ts - pts_) & 0xFFFFFFFF] += 1
        self.prev = (seq, ts, ssrc)
        table = DECODE.get(pt)
        if table and media:
            samples = [table[b] for b in media]
            self.env.append((t, math.sqrt(sum(s * s for s in samples) / len(samples))))
            if keep_audio:
                self.audio += struct.pack('<%dh' % len(samples), *samples)
        elif keep_audio and media and pt in (4, 18, 96):  # G.723, G.729, Opus (our offer's pt)
            self.raw[pt] += media

    def seconds_db(self):
        """Loudness per second of arrival time, dBFS (-inf for silence)."""
        if not self.env:
            return []
        t0 = self.env[0][0]
        acc = defaultdict(list)
        for t, r in self.env:
            acc[int(t - t0)].append(r)
        out = []
        for s in range(max(acc) + 1):
            v = acc.get(s)
            r = math.sqrt(sum(x * x for x in v) / len(v)) if v else 0.0
            out.append(-99.0 if r < 1 else 20 * math.log10(r / 32768))
        return out


def env_series(flow, t0, step=0.02, n=None):
    bins = defaultdict(list)
    for t, r in flow.env:
        bins[int((t - t0) / step)].append(r)
    n = n or (max(bins) + 1 if bins else 0)
    return [math.log10(1 + (sum(bins[i]) / len(bins[i]) if i in bins else 0.0)) for i in range(n)]


def correlate(a, b, step=0.02, max_lag_s=2.0):
    """Best normalised correlation of b's envelope against a's, and b's lag (s) behind a."""
    t0 = min(a.first, b.first)
    n = int((max(a.last, b.last) - t0) / step) + 1
    x, y = env_series(a, t0, step, n), env_series(b, t0, step, n)
    best = (0.0, 0.0)
    for lag in range(-int(max_lag_s / step), int(max_lag_s / step) + 1):
        pairs = [(x[i], y[i + lag]) for i in range(n) if 0 <= i + lag < n and (x[i] or y[i + lag])]
        if len(pairs) < 50:
            continue
        mx = sum(p[0] for p in pairs) / len(pairs)
        my = sum(p[1] for p in pairs) / len(pairs)
        sxy = sum((p - mx) * (q - my) for p, q in pairs)
        sx = math.sqrt(sum((p - mx) ** 2 for p, _ in pairs))
        sy = math.sqrt(sum((q - my) ** 2 for _, q in pairs))
        if sx and sy and sxy / (sx * sy) > best[0]:
            best = (sxy / (sx * sy), lag * step)
    return best


def hhmmss(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime('%H:%M:%S.%f')[:12]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pcap', nargs='+')
    ap.add_argument('--port', type=int, action='append', help='only flows with this UDP port (repeatable)')
    ap.add_argument('--min-packets', type=int, default=50, help='ignore flows with fewer RTP packets')
    ap.add_argument('--wav', help='write each flow: PCMU/PCMA as .wav, other codecs as raw payload (.g723/.g729/.pt96)')
    ap.add_argument('--corr', action='append', default=[], help='"i,j": compare flows i and j (numbers as printed)')
    ap.add_argument('--seconds', action='store_true', help='print the per-second loudness of each PCMU/PCMA flow')
    args = ap.parse_args()

    keep = bool(args.wav)
    flows = {}
    for path in args.pcap:
        for t, src, sport, dst, dport, payload in packets(path):
            if args.port and sport not in args.port and dport not in args.port:
                continue
            r = rtp(payload)
            if not r:
                continue
            key = (src, sport, dst, dport)
            f = flows.get(key) or flows.setdefault(key, Flow(key))
            f.add(t, *r, keep_audio=keep)

    shown = sorted((f for f in flows.values() if f.n >= args.min_packets), key=lambda f: (f.first, f.key))
    print(f'{len(flows)} RTP flows, {len(shown)} with >= {args.min_packets} packets')
    for i, f in enumerate(shown, 1):
        src, sport, dst, dport = f.key
        dur = f.last - f.first
        pts = ' '.join(f'{STATIC_NAMES.get(p, p)}x{c}' for p, c in f.pts.most_common())
        sizes = ' '.join(f'{s}Bx{c}' for s, c in f.sizes.most_common(3))
        steps = ' '.join(f'{s}x{c}' for s, c in f.ts_steps.most_common(3))
        print(f'\n[{i}] {src}:{sport} -> {dst}:{dport}  {hhmmss(f.first)}-{hhmmss(f.last)} ({dur:.1f} s)'
              f'  {f.n} pkts ({f.n / dur if dur else 0:.1f}/s)')
        print(f'    codecs {pts}; payload {sizes}; ts steps {steps}; seq gaps {f.seq_gaps}')
        for t, old, new in f.ssrc_changes:
            print(f'    SSRC change at {hhmmss(t)}: {old:08x} -> {new:08x}')
        db = f.seconds_db()
        if db:
            silent = sum(1 for d in db if d < -55)
            print(f'    loudness: median {sorted(db)[len(db) // 2]:.0f} dBFS, {silent}/{len(db)} s below -55 dBFS')
            if args.seconds:
                print('    per second: ' + ' '.join(f'{d:.0f}' for d in db))
        if args.wav:
            os.makedirs(args.wav, exist_ok=True)
            base = os.path.join(args.wav, f'{i:02d}_{src}_{sport}_to_{dst}_{dport}')
            if f.audio:
                with wave.open(base + '.wav', 'wb') as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(8000)
                    w.writeframes(bytes(f.audio))
            for pt, raw in f.raw.items():
                ext = {4: 'g723', 18: 'g729'}.get(pt, f'pt{pt}')
                with open(f'{base}.{ext}', 'wb') as out:
                    out.write(raw)

    for spec in args.corr:
        i, j = (int(x) for x in spec.split(','))
        a, b = shown[i - 1], shown[j - 1]
        if not a.env or not b.env:
            print(f'\ncorr [{i}] vs [{j}]: both flows must be PCMU/PCMA')
            continue
        c, lag = correlate(a, b)
        print(f'\ncorr [{i}] vs [{j}]: {c:.2f} at lag {lag:+.2f} s'
              f'  ({"same audio" if c >= 0.6 else "weak" if c >= 0.3 else "different / no audio"})')


if __name__ == '__main__':
    main()

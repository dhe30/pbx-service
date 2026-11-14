#!/usr/bin/env python3
"""Write an RTP pcap (Ethernet/IPv4/UDP/RTP) that SIPp's play_pcap_audio can replay.

    gen_pcap.py <out.pcap> <PCMU|PCMA|G729|G723|opus> <payload type> <seconds>

The payload is synthetic but well-formed for each codec, so rtpengine can decode it:
PCMU/PCMA 160 bytes per 20 ms, G.729 two 10-byte frames per 20 ms, G.723.1 one 24-byte 6.3 kbit/s
frame per 30 ms (frame type bits 00), Opus one 20 ms SILK frame (TOC 0x48) at a 48 kHz clock.
Addresses and ports in the file are placeholders; SIPp sends to the negotiated media address.
"""
import random
import struct
import sys

out, codec, pt, secs = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
rnd = random.Random(42)
spec = {  # ptime ms, RTP clock, payload generator
    "PCMU": (20, 8000, lambda i: bytes((i * 7 + k * 13) % 256 for k in range(160))),
    "PCMA": (20, 8000, lambda i: bytes((i * 5 + k * 11) % 256 for k in range(160))),
    "G729": (20, 8000, lambda i: bytes(rnd.randrange(256) for _ in range(20))),
    "G723": (30, 8000, lambda i: bytes([rnd.randrange(256) & 0xFC]) + bytes(rnd.randrange(256) for _ in range(23))),
    "opus": (20, 48000, lambda i: bytes([0x48]) + bytes(rnd.randrange(256) for _ in range(39))),
}
ptime, clock, payload = spec[codec]
step = clock * ptime // 1000

def csum(b):
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    s = (s >> 16) + (s & 0xFFFF)
    return ~(s + (s >> 16)) & 0xFFFF

with open(out, "wb") as f:
    f.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
    for i in range(int(secs * 1000 / ptime)):
        rtp = struct.pack("!BBHII", 0x80, pt, (1000 + i) & 0xFFFF, (i * step) & 0xFFFFFFFF, 0x1234ABCD) + payload(i)
        udp = struct.pack("!HHHH", 6000, 6001, 8 + len(rtp), 0) + rtp
        ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(udp), i & 0xFFFF, 0, 64, 17, 0,
                         bytes([10, 0, 0, 1]), bytes([10, 0, 0, 2]))
        ip = ip[:10] + struct.pack("!H", csum(ip)) + ip[12:] + udp
        frame = b"\x02\x00\x00\x00\x00\x02" + b"\x02\x00\x00\x00\x00\x01" + b"\x08\x00" + ip
        t = i * ptime / 1000
        f.write(struct.pack("<IIII", int(t), int((t % 1) * 1e6), len(frame), len(frame)) + frame)

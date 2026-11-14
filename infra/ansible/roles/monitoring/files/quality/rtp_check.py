#!/usr/bin/env python3
"""Judge the audio a test phone received AFTER its session refresh, by payload type and size.

    rtp_check.py <capture.pcap> <phone ip> <caller SIP port> <caller RTP port> <callee RTP port>

The capture (tcpdump -i any) holds the UDP packets that arrived at the two test phones: RTP on the
two media ports and SIP on the caller's signalling port. The refresh time is when the 200 OK to the
caller's refresh re-INVITE (CSeq 3 INVITE, q_refresh_uac.xml.tpl) arrived; packets from 1 s later
on count as "after the refresh".

Both phones send and expect PCMU (pt 0). An RTP packet is good if its payload type is 0 and its
payload is whole 10 ms PCMU frames (a multiple of 80 bytes; 160 = 20 ms, a 172-byte RTP packet).
Anything else except telephone-event (pt 101) is wrong: e.g. 36-byte G.723 (pt 4), 32-byte G.729
(pt 18) or PCMA (pt 8) packets sent to a phone that plays PCMU are a silent leg (incident
2026-11-14-codec-flip).

Prints one line for the shell (pt -1 / size 0 = nothing received):
    refresh_found answer_pts  good_caller wrong_caller pt_caller size_caller \
    good_callee wrong_callee pt_callee size_callee  before_caller before_callee
answer_pts is the m= payload type list of the refresh answer ("4,101"), or "-". pt/size are the
most common RTP payload type and RTP packet size (header + payload) after the refresh. A short
human summary goes to stderr.
"""
import collections
import struct
import sys

GUARD_S = 1.0           # packets already in flight when rtpengine changed its mind
DTMF_PT = 101


def packets(path):
    """Yield (time, dst ip, dst port, UDP payload) for IPv4/UDP packets in a pcap file."""
    with open(path, "rb") as f:
        hdr = f.read(24)
        if len(hdr) < 24:
            return
        magic = struct.unpack("<I", hdr[:4])[0]
        if magic in (0xA1B2C3D4, 0xA1B23C4D):
            end = "<"
        else:
            end = ">"
            magic = struct.unpack(">I", hdr[:4])[0]
        frac = 1e-9 if magic == 0xA1B23C4D else 1e-6
        linktype = struct.unpack(end + "I", hdr[20:24])[0] & 0x0FFFFFFF
        while True:
            rec = f.read(16)
            if len(rec) < 16:
                return
            sec, sub, incl, _ = struct.unpack(end + "IIII", rec)
            data = f.read(incl)
            if len(data) < incl:
                return
            ip = link_payload(linktype, data)
            if ip is None or len(ip) < 20 or ip[0] >> 4 != 4 or ip[9] != 17:
                continue
            if struct.unpack("!H", ip[6:8])[0] & 0x1FFF:      # non-first fragment
                continue
            ihl = (ip[0] & 0x0F) * 4
            udp = ip[ihl:]
            if len(udp) < 8:
                continue
            dport, ulen = struct.unpack("!HH", udp[2:6])
            yield sec + sub * frac, ".".join(str(b) for b in ip[16:20]), dport, udp[8:ulen]


def link_payload(linktype, data):
    """The IPv4 packet inside one captured frame, or None."""
    if linktype == 1:                          # Ethernet (+ VLAN tags)
        off, etype = 14, struct.unpack("!H", data[12:14])[0]
        while etype in (0x8100, 0x88A8) and len(data) >= off + 4:
            etype = struct.unpack("!H", data[off + 2:off + 4])[0]
            off += 4
        return data[off:] if etype == 0x0800 else None
    if linktype == 113:                        # Linux cooked (SLL), tcpdump -i any (older)
        return data[16:] if struct.unpack("!H", data[14:16])[0] == 0x0800 else None
    if linktype == 276:                        # Linux cooked v2 (SLL2), tcpdump -i any (4.99+)
        return data[20:] if struct.unpack("!H", data[0:2])[0] == 0x0800 else None
    if linktype in (12, 101, 228):             # raw IP / raw IPv4
        return data
    if linktype == 0:                          # BSD loopback
        return data[4:]
    return None


def rtp(payload):
    """(payload type, payload length) of an RTP packet, or None if it isn't one."""
    if len(payload) < 12 or payload[0] >> 6 != 2:
        return None
    pt = payload[1] & 0x7F
    hlen = 12 + 4 * (payload[0] & 0x0F)
    if payload[0] & 0x10 and len(payload) >= hlen + 4:   # header extension
        hlen += 4 + 4 * struct.unpack("!H", payload[hlen + 2:hlen + 4])[0]
    plen = len(payload) - hlen
    if payload[0] & 0x20 and plen > 0:                   # padding
        plen -= payload[-1]
    return (pt, plen) if plen >= 0 else None


def main():
    path, me, sip_port, ports = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4:6]
    ports = [int(p) for p in ports]
    pkts = [p for p in packets(path) if p[1] == me]

    refresh_at, answer = None, "-"
    for t, _, dport, data in pkts:
        if dport != sip_port or not data.startswith(b"SIP/2.0 200"):
            continue
        text = data.decode("latin-1")
        heads = {l.split(":", 1)[0].strip().lower(): l.split(":", 1)[1].strip()
                 for l in text.split("\r\n") if ":" in l and not l.startswith(("a=", "m=", "o=", "c="))}
        if heads.get("cseq", "").split() == ["3", "INVITE"]:
            refresh_at = t
            for l in text.split("\r\n"):
                if l.startswith("m=audio"):
                    answer = ",".join(l.split()[3:]) or "-"
            break

    out = ["1" if refresh_at is not None else "0", answer]
    before = []
    for name, port in zip(("caller", "callee"), ports):
        good = wrong = early = 0
        kinds = collections.Counter()
        for t, _, dport, data in pkts:
            if dport != port:
                continue
            r = rtp(data)
            if r is None:
                continue
            if refresh_at is None or t < refresh_at:
                early += 1
                continue
            if t < refresh_at + GUARD_S:
                continue
            pt, plen = r
            if pt == DTMF_PT:
                continue
            kinds[(pt, len(data))] += 1
            if pt == 0 and plen > 0 and plen % 80 == 0:
                good += 1
            else:
                wrong += 1
        (pt, size), _ = kinds.most_common(1)[0] if kinds else ((-1, 0), 0)
        out += [str(good), str(wrong), str(pt), str(size)]
        before.append(str(early))
        mix = ", ".join("pt %d x %d B: %d" % (k[0], k[1], n) for k, n in kinds.most_common(4)) or "nothing"
        print("  to %s after the refresh: %d good PCMU, %d wrong (%s)" % (name, good, wrong, mix),
              file=sys.stderr)
    print("  refresh answered: %s; packets before the refresh: caller %s, callee %s"
          % ("m=" + answer.replace(",", " ") if refresh_at is not None else "NOT SEEN", before[0], before[1]),
          file=sys.stderr)
    print(" ".join(out + before))


if __name__ == "__main__":
    main()

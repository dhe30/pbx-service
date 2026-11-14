#!/usr/bin/env python3
"""Report on one pbx-long-call-test call: who refreshed the session, how, and what codec each
phone received afterwards (follow-up 2 of docs/incidents/2026-11-14-codec-flip.md).

    long_call_check.py <capture.pcap> <phone ip> <caller SIP port> <callee SIP port> \
                       <caller RTP port> <callee RTP port> <judge from, s after answer>

The capture holds the UDP packets that arrived at the two test phones (SIP + RTP). Prints:
  - the session-timer headers Asterisk used (its 200 OK to the caller, its INVITE to the callee);
  - every in-dialog INVITE/UPDATE Asterisk sent each phone (seconds after the answer, SDP m= line
    or "no SDP") and the answer to the caller's own re-INVITE;
  - the RTP each phone received from <judge from> on: good = PCMU (pt 0) in whole 10 ms frames,
    wrong = anything else (36-byte G.723, 32-byte G.729, PCMA...), like rtp_check.py.
Last line: VERDICT PASS | FLIP | INCONCLUSIVE (Asterisk sent no refresh) | ERROR. Exit 0/2/3/1.
"""
import collections
import os
import sys

sys.dont_write_bytecode = True          # no __pycache__ next to the scenarios (or in the repo)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rtp_check import packets, rtp  # noqa: E402  (same directory)

DTMF_PT = 101


def parse_sip(data):
    """(first line, {lower-case header: value}, m=audio payload list or None)."""
    text = data.decode("latin-1")
    head, _, body = text.partition("\r\n\r\n")
    lines = head.split("\r\n")
    hdrs = {}
    for l in lines[1:]:
        if ":" in l:
            k, v = l.split(":", 1)
            hdrs.setdefault(k.strip().lower(), v.strip())
    m = None
    for l in body.split("\r\n"):
        if l.startswith("m=audio"):
            m = " ".join(l.split()[3:])
    return lines[0], hdrs, m


def main():
    a = sys.argv
    path, me = a[1], a[2]
    caller_sip, callee_sip, caller_rtp, callee_rtp = (int(x) for x in a[3:7])
    judge_from = float(a[7])
    pkts = [p for p in packets(path) if p[1] == me]

    t0 = None
    seen = set()
    events = []            # (t, phone, text)
    info = []
    callee_initial_cseq = None
    for t, _, dport, data in pkts:
        if dport not in (caller_sip, callee_sip) or not data[:3].isalpha():   # SIP text, not RTP
            continue
        try:
            first, h, m = parse_sip(data)
        except Exception:
            continue
        cseq = h.get("cseq", "")
        key = (dport, first.split()[0], cseq)
        if key in seen:                     # retransmission
            continue
        seen.add(key)
        if dport == caller_sip and first.startswith("SIP/2.0 200") and cseq.split() == ["2", "INVITE"]:
            t0 = t
            info.append("Asterisk's 200 OK to the caller: Session-Expires: %s | Require: %s | Allow has UPDATE: %s"
                        % (h.get("session-expires", "-"), h.get("require", "-"),
                           "yes" if "UPDATE" in h.get("allow", "").upper() else "no"))
        elif dport == callee_sip and first.startswith("INVITE ") and callee_initial_cseq is None:
            callee_initial_cseq = cseq
            info.append("Asterisk's INVITE to the callee: Session-Expires: %s | Min-SE: %s | Supported: %s"
                        % (h.get("session-expires", "-"), h.get("min-se", "-"), h.get("supported", "-")))
        elif first.startswith(("INVITE ", "UPDATE ")):
            phone = "caller" if dport == caller_sip else "callee"
            events.append((t, phone, "%s from Asterisk, %s, Session-Expires: %s"
                           % (first.split()[0], "SDP m=" + m if m else "no SDP", h.get("session-expires", "-"))))
        elif dport == caller_sip and first.startswith("SIP/2.0 200") and cseq.split() == ["3", "INVITE"]:
            events.append((t, "caller", "answer to the caller's own re-INVITE: %s"
                           % ("m=" + m if m else "no SDP")))

    if t0 is None:
        print("no 200 OK to the caller's INVITE in the capture (call not answered?)")
        print("VERDICT ERROR")
        return 1
    for line in info:
        print(line)
    asterisk_reqs = [e for e in events if "from Asterisk" in e[2]]
    print("In-dialog requests after the answer:" if events else "In-dialog requests after the answer: none")
    for t, phone, text in sorted(events):
        print("  %7.1f s  %s: %s" % (t - t0, phone, text))

    flip = False
    for name, port in (("caller", caller_rtp), ("callee", callee_rtp)):
        good = wrong = before = 0
        kinds = collections.Counter()
        for t, _, dport, data in pkts:
            if dport != port:
                continue
            r = rtp(data)
            if r is None:
                continue
            if t - t0 < judge_from:
                before += 1
                continue
            pt, plen = r
            if pt == DTMF_PT:
                continue
            kinds[(pt, len(data))] += 1
            if pt == 0 and plen > 0 and plen % 80 == 0:
                good += 1
            else:
                wrong += 1
        mix = ", ".join("pt %d x %d B: %d" % (k[0], k[1], n) for k, n in kinds.most_common(4)) or "nothing"
        bad = good < 250 or wrong * 20 > good + wrong
        flip = flip or bad
        print("RTP to the %s from %.0f s on: %d good PCMU, %d wrong (%s); %d packets before%s"
              % (name, judge_from, good, wrong, mix, before, "  <-- SILENT/WRONG CODEC" if bad else ""))

    if flip:
        print("VERDICT FLIP")
        return 2
    if not asterisk_reqs:
        print("VERDICT INCONCLUSIVE (Asterisk sent no refresh: it was not the refresher, or the call was too short)")
        return 3
    print("VERDICT PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

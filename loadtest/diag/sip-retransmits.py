#!/usr/bin/env python3
"""Where do the course's SIP requests lose ~500 ms? Reads a tcpdump capture taken on an edge.

The course's SIP tail for us is SIP's UDP resend timer: a request whose first copy gets no answer
is resent after 500 ms (then 1 s, 2 s), and the resend is answered at once. This script pairs every
request that reached us from outside with our replies and classifies each transaction that the
client had to resend:

  answered-then-resent   we replied to the first copy, the client resent anyway:
                         our reply was lost after it left us, or went somewhere the client ignores
                         (look at the reply size and the "reply to" column)
  resent-before-answer   our first reply came only after the resend: Kamailio ignored or
                         delayed the first copy (check its logs: pike, sanity, ...)
  never-answered         no reply from us at all in the capture

A request whose resend never shows up but whose first copy is missing can't be seen here (lost
before reaching the VM). Compare the course's count of slow transactions with what this finds.

Capture on the edge (public SIP socket is udp/5060; the internal one, 5070, is not needed):
    timeout 600 tcpdump -ni ens3 -s 0 -w /tmp/sip.pcap udp port 5060
Analyze (python3 is on every VM, nothing to install):
    ssh root@<edge> 'python3 - /tmp/sip.pcap' < loadtest/diag/sip-retransmits.py
Several files of a tcpdump -W ring can be given, oldest first. Or from WSL, without the passphrase
each time: loadtest/diag/remote.sh edge-1 py loadtest/diag/sip-retransmits.py /tmp/sip.pcap

Only standard library. Reads classic pcap (not pcapng: tcpdump -w writes classic pcap).
"""
import collections
import ipaddress
import struct
import sys

PRIVATE = ipaddress.ip_network('10.0.0.0/8')
SIP_PORT = 5060
# UDP payload that fits one 1500-byte IPv4 packet; bigger replies are fragmented.
MAX_UNFRAGMENTED = 1500 - 20 - 8


def packets(path):
    """Yields (time, src_ip, src_port, dst_ip, dst_port, payload, fragmented)."""
    with open(path, 'rb') as f:
        head = f.read(24)
        magic = head[:4]
        if magic in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1'):
            endian = '<'
        elif magic in (b'\xa1\xb2\xc3\xd4', b'\xa1\xb2\x3c\x4d'):
            endian = '>'
        else:
            sys.exit('not a classic pcap file (tcpdump -w writes one; convert pcapng with editcap -F pcap)')
        nanos = magic in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
        linktype = struct.unpack(endian + 'I', head[20:24])[0]
        while True:
            rec = f.read(16)
            if len(rec) < 16:
                return
            sec, frac, incl, _orig = struct.unpack(endian + 'IIII', rec)
            data = f.read(incl)
            t = sec + frac / (1e9 if nanos else 1e6)
            if linktype == 1:  # Ethernet
                off, ethertype = 14, struct.unpack('>H', data[12:14])[0]
                if ethertype == 0x8100:  # VLAN tag
                    off, ethertype = 18, struct.unpack('>H', data[16:18])[0]
            elif linktype == 113:  # Linux cooked (tcpdump -i any)
                off, ethertype = 16, struct.unpack('>H', data[14:16])[0]
            elif linktype == 276:  # Linux cooked v2
                off, ethertype = 20, struct.unpack('>H', data[0:2])[0]
            elif linktype in (101, 12):  # raw IP
                off, ethertype = 0, 0x0800
            else:
                sys.exit(f'unsupported link type {linktype}')
            if ethertype != 0x0800 or len(data) < off + 28:
                continue
            ip = data[off:]
            ihl = (ip[0] & 0x0F) * 4
            if ip[9] != 17:  # UDP
                continue
            flags_frag = struct.unpack('>H', ip[6:8])[0]
            more_fragments, frag_offset = bool(flags_frag & 0x2000), flags_frag & 0x1FFF
            if frag_offset:  # later fragments carry no UDP header
                continue
            src, dst = str(ipaddress.IPv4Address(ip[12:16])), str(ipaddress.IPv4Address(ip[16:20]))
            sport, dport, ulen = struct.unpack('>HHH', ip[ihl:ihl + 6])
            payload = ip[ihl + 8:]
            yield t, src, sport, dst, dport, payload, more_fragments or ulen - 8 > MAX_UNFRAGMENTED, ulen - 8


def parse_sip(payload):
    """(is_request, method_or_code, call_id, cseq_num, cseq_method, top_branch) or None."""
    try:
        text = payload.decode('utf-8', 'replace')
    except Exception:
        return None
    head = text.split('\r\n\r\n', 1)[0]
    lines = head.split('\r\n')
    if not lines or not lines[0]:
        return None
    first = lines[0].split(' ')
    if first[0].startswith('SIP/2.0'):
        is_request, what = False, first[1] if len(first) > 1 else '?'
    elif len(first) >= 3 and first[2].startswith('SIP/2.0'):
        is_request, what = True, first[0]
    else:
        return None  # keepalive (CRLF) or junk
    call_id = cseq_num = cseq_method = branch = None
    for line in lines[1:]:
        name, _, value = line.partition(':')
        name = name.strip().lower()
        value = value.strip()
        if name in ('call-id', 'i') and call_id is None:
            call_id = value
        elif name == 'cseq' and cseq_num is None:
            parts = value.split()
            if len(parts) == 2:
                cseq_num, cseq_method = parts
        elif name in ('via', 'v') and branch is None:
            for param in value.split(',')[0].split(';')[1:]:
                k, _, v = param.partition('=')
                if k.strip().lower() == 'branch':
                    branch = v.strip()
    if call_id is None or cseq_num is None:
        return None
    return is_request, what, call_id, cseq_num, cseq_method, branch


def is_external(ip):
    return ipaddress.IPv4Address(ip) not in PRIVATE


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    # Transactions started by the outside (phones, carrier, vendors) toward our public socket.
    tx = {}
    first_t = last_t = None
    # Several files (a tcpdump -W ring) are read in the order given; pass them oldest first.
    all_packets = (p for path in sys.argv[1:] for p in packets(path))
    for t, src, sport, dst, dport, payload, fragmented, size in all_packets:
        first_t = t if first_t is None else first_t
        last_t = t
        sip = parse_sip(payload)
        if not sip:
            continue
        is_request, what, call_id, cseq_num, cseq_method, branch = sip
        if is_request and dport == SIP_PORT and is_external(src):
            if what == 'ACK':
                continue
            key = (src, call_id, cseq_num, cseq_method, branch)  # scanners reuse Call-IDs
            rec = tx.setdefault(key, {'method': what, 'src': f'{src}:{sport}', 'copies': [], 'replies': []})
            rec['copies'].append(t)
        elif not is_request and sport == SIP_PORT and is_external(dst):
            key = (dst, call_id, cseq_num, cseq_method, branch)
            rec = tx.get(key)
            if rec is not None:  # a reply to a request we saw arrive (not to one we sent)
                rec['replies'].append((t, what, f'{dst}:{dport}', size, fragmented))

    if not tx:
        sys.exit('no SIP requests from outside to port 5060 in this capture')
    span = (last_t - first_t) if first_t is not None else 0
    print(f'capture: {span:.0f} s, {len(tx)} transactions started from outside\n')

    per_method = collections.defaultdict(collections.Counter)
    first_reply_ms = collections.defaultdict(list)
    examples = collections.defaultdict(list)
    reply_sizes = collections.defaultdict(collections.Counter)
    by_source = collections.defaultdict(collections.Counter)
    for key, r in tx.items():
        m = r['method']
        copies, replies = r['copies'], r['replies']
        c = per_method[m]
        c['transactions'] += 1
        src_ip = r['src'].split(':')[0]
        by_source[src_ip]['transactions'] += 1
        for _t, _code, _to, size, frag in replies:
            reply_sizes[m]['fragmented' if frag else 'fits one packet'] += 1
        if replies:
            first_reply_ms[m].append((replies[0][0] - copies[0]) * 1000)
            mismatched = [to for _t, _c, to, _s, _f in replies if to != r['src']]
            if mismatched:
                c['reply sent to a different ip:port than the request came from'] += 1
        if len(copies) < 2:
            if not replies:
                c['never answered (no resend seen)'] += 1
            continue
        c['resent by client'] += 1
        by_source[src_ip]['resent'] += 1
        second = copies[1]
        if not replies:
            kind = 'never-answered'
        elif replies[0][0] < second:
            kind = 'answered-then-resent'
        else:
            kind = 'resent-before-answer'
        c[kind] += 1
        if len(examples[(m, kind)]) < 5:
            reply_desc = ', '.join(
                f'{code} after {(rt - copies[0]) * 1000:.0f} ms to {to} ({size} B{" FRAGMENTED" if frag else ""})'
                for rt, code, to, size, frag in replies[:3]
            ) or 'none'
            gaps = ', '.join(f'{(ct - copies[0]) * 1000:.0f}' for ct in copies[1:4])
            examples[(m, kind)].append(
                f'    from {r["src"]} call-id {key[1][:40]} cseq {key[2]}: resent at +{gaps} ms; our replies: {reply_desc}'
            )

    def pct(vals, p):
        vals = sorted(vals)
        return vals[min(len(vals) - 1, int(p / 100 * len(vals)))] if vals else float('nan')

    for m in sorted(per_method, key=lambda k: -per_method[k]['transactions']):
        c = per_method[m]
        n = c['transactions']
        lat = first_reply_ms[m]
        print(f'{m}: {n} transactions, {c["resent by client"]} resent by the client ({100 * c["resent by client"] / n:.1f}%)')
        if lat:
            print(f'  our first reply after the first copy: p50 {pct(lat, 50):.1f} ms, p95 {pct(lat, 95):.1f} ms, '
                  f'p99 {pct(lat, 99):.1f} ms, max {max(lat):.0f} ms')
        for k in ('answered-then-resent', 'resent-before-answer', 'never-answered',
                  'never answered (no resend seen)', 'reply sent to a different ip:port than the request came from'):
            if c[k]:
                print(f'  {k}: {c[k]}')
        if reply_sizes[m]:
            print(f'  our replies: {dict(reply_sizes[m])}')
        for kind in ('answered-then-resent', 'resent-before-answer', 'never-answered'):
            if examples[(m, kind)]:
                print(f'  examples ({kind}):')
                print('\n'.join(examples[(m, kind)]))
        print()

    # Is a resend tied to how fast we answered (e.g. a client that drops replies arriving before it
    # has recorded its own request) or random (loss on the way)? Compare our reply delay for
    # transactions the client resent vs. those it didn't.
    print('our first-reply delay, resent vs. not resent (answered transactions only):')
    edges_ms = [0.25, 0.5, 1, 2, 5, 20, 100, 10 ** 9]
    for m in sorted(per_method, key=lambda k: -per_method[k]['transactions'])[:3]:
        groups = {'resent': collections.Counter(), 'not resent': collections.Counter()}
        for r in tx.values():
            if r['method'] != m or not r['replies']:
                continue
            delay = (r['replies'][0][0] - r['copies'][0]) * 1000
            g = 'resent' if len(r['copies']) > 1 and r['replies'][0][0] < r['copies'][1] else 'not resent'
            groups[g][next(e for e in edges_ms if delay <= e)] += 1
        for g, c in groups.items():
            n = sum(c.values())
            if n:
                dist = '  '.join(f'<={e}ms:{100 * c[e] / n:.0f}%' for e in edges_ms[:-1] if c[e])
                print(f'  {m} {g:10} n={n:6}  {dist}')
    print()

    # Bursty (many in the same seconds) or spread out?
    resent_times = sorted(r['copies'][0] for r in tx.values() if len(r['copies']) > 1 and r['method'] == 'REGISTER')
    if resent_times and first_t is not None:
        per_10s = collections.Counter(int((t - first_t) // 10) for t in resent_times)
        busiest = per_10s.most_common(5)
        print(f'REGISTER resends per 10 s window: {len(per_10s)} windows with any, busiest: '
              + ', '.join(f'+{w * 10}s:{n}' for w, n in busiest))
        print()

    print('by source IP (top 10 by transactions):')
    for ip, c in sorted(by_source.items(), key=lambda kv: -kv[1]['transactions'])[:10]:
        print(f'  {ip:16} {c["transactions"]:6} transactions, {c["resent"]:5} resent '
              f'({100 * c["resent"] / c["transactions"]:.1f}%)')


if __name__ == '__main__':
    main()

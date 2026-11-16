#!/usr/bin/env python3
"""Search an edge's SIP history: every SIP message Kamailio received or sent, on every transport.

Kamailio's sipdump module (kamailio.cfg) writes hourly pcap files to /var/log/pbx/sipdump on each
edge (sip-YYYY-MM-DD--HH-MM-SS.pcap, kept 24 h). TLS desk phones and browsers (WebSocket) are in
them too, written after decryption, with a "P-KSR-SIPDump: <transport> pid=.. pno=.." header that
gives the real transport (the pcap's IP/UDP headers are synthetic for TCP, TLS and WS).

Pick what to look at, then the matching calls are printed as ladders (every message of each
matching Call-ID, in time order):
    --call-id ID       a SIP Call-ID (substring), e.g. the `sip` field of an ARI app log line
    --match TEXT       text in the request line / From / To / Contact / P-Asserted-Identity:
                       a number (16315550132), a SIP user (x2e11f8d87a326444), an IP
    --method M         only transactions of this method (REGISTER, INVITE, ...)
    --failed           only Call-IDs where we sent or received a final reply >= 400 (no 401/407).
                       OPTIONS are left out (internet scanners get hundreds of 403s an hour, all
                       with Call-ID "1"); add --method OPTIONS to see them
    --since/--until    UTC, "HH:MM" (today) or "YYYY-MM-DDTHH:MM"; picks files and messages
    --full             print whole messages, not one line each
    --limit N          at most N Call-IDs (default 20)

Safe on a live edge (1 vCPU, 2 GB; a full-day scan once froze edge-1 for 11 minutes):
    two streaming passes (pass 1 keeps a few bits per matching Call-ID, pass 2 keeps messages
    only for the Call-IDs printed), runs at nice 10, and caps its own memory
    (--max-mem-mb, default 300: exits with a message instead of starving Kamailio).
    With --dir, --since is required and the window may be at most 2 h; --long lifts that, but
    for long windows copy the pcaps off the edge (scp) and run there.

Run on an edge (no install needed):
    loadtest/diag/remote.sh edge-1 py loadtest/diag/sip-history.py --dir /var/log/pbx/sipdump \\
        --since 10:55 --until 11:00 --match 16315550132
Or give pcap files instead of --dir. Standard library only.
"""
import argparse
import datetime as dt
import ipaddress
import os
import re
import struct
import sys
from collections import OrderedDict, defaultdict

FILE_TS = re.compile(r'(\d{4}-\d{2}-\d{2})--(\d{2})-(\d{2})-(\d{2})\.pcap$')
UTC = dt.timezone.utc
MAX_WINDOW_H = 2  # longest --since/--until span on a live edge without --long


def parse_when(s, default_date):
    if 'T' in s:
        return dt.datetime.fromisoformat(s).replace(tzinfo=UTC)
    h, m = s.split(':')[:2]
    return dt.datetime.combine(default_date, dt.time(int(h), int(m)), tzinfo=UTC)


def first_packet_time(path):
    """UTC time of a pcap's first record, or None if it has none yet."""
    with open(path, 'rb') as f:
        head = f.read(32)
    if len(head) < 32:
        return None
    endian = '<' if head[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
    return dt.datetime.fromtimestamp(struct.unpack(endian + 'I', head[24:28])[0], UTC)


def pick_files(folder, since, until):
    """Hourly files whose span can overlap [since, until] (a file covers up to the next one).

    A file's start is its first packet's time: sipdump names files in the server's LOCAL time,
    which is UTC on the edges but not necessarily elsewhere."""
    files = []
    for name in os.listdir(folder):
        if FILE_TS.search(name):
            path = os.path.join(folder, name)
            start = first_packet_time(path)
            if start:
                files.append((start, path))
    files.sort()
    chosen = []
    for i, (start, path) in enumerate(files):
        end = files[i + 1][0] if i + 1 < len(files) else dt.datetime.max.replace(tzinfo=UTC)
        if (until is None or start <= until) and (since is None or end >= since):
            chosen.append(path)
    return chosen


def packets(path):
    """(time, src ip:port, dst ip:port, payload) per UDP packet of a classic pcap."""
    with open(path, 'rb') as f:
        head = f.read(24)
        if len(head) < 24:
            return
        endian = '<' if head[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
        nanos = head[:4] in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
        linktype = struct.unpack(endian + 'I', head[20:24])[0]
        off = {1: 14, 113: 16, 276: 20, 101: 0, 12: 0}.get(linktype)
        if off is None:
            sys.exit(f'{path}: unsupported link type {linktype}')
        while True:
            rec = f.read(16)
            if len(rec) < 16:
                return  # end of file (or a file still being written: stop at the last whole record)
            sec, frac, incl, _ = struct.unpack(endian + 'IIII', rec)
            data = f.read(incl)
            if len(data) < incl:
                return
            ip = data[off:]
            if len(ip) < 28 or ip[0] >> 4 != 4 or ip[9] != 17:
                continue
            ihl = (ip[0] & 0x0F) * 4
            sport, dport = struct.unpack('>HH', ip[ihl:ihl + 4])
            src = f'{ipaddress.IPv4Address(ip[12:16])}:{sport}'
            dst = f'{ipaddress.IPv4Address(ip[16:20])}:{dport}'
            yield sec + frac / (1e9 if nanos else 1e6), src, dst, ip[ihl + 8:]


HDR = re.compile(r'^([A-Za-z-]+)\s*:\s*(.*)$')
COMPACT = {'i': 'call-id', 'f': 'from', 't': 'to', 'm': 'contact', 'v': 'via', 'l': 'content-length', 'c': 'content-type'}


def parse(payload):
    text = payload.decode('utf-8', 'replace')
    head, _, body = text.partition('\r\n\r\n')
    lines = head.split('\r\n')
    if not lines or not (lines[0].startswith('SIP/2.0') or ' SIP/2.0' in lines[0]):
        return None
    h = defaultdict(list)
    for line in lines[1:]:
        m = HDR.match(line)
        if m:
            name = m.group(1).lower()
            h[COMPACT.get(name, name)].append(m.group(2))
    cseq = (h.get('cseq') or [''])[0].split()
    first = lines[0]
    status = int(first.split()[1]) if first.startswith('SIP/2.0') and first.split()[1:2] and first.split()[1].isdigit() else None
    dump = (h.get('p-ksr-sipdump') or [''])[0]
    return {
        'first': first,
        'status': status,
        'method': cseq[1] if len(cseq) == 2 else '?',
        'cseq': cseq[0] if cseq else '?',
        'call_id': (h.get('call-id') or [''])[0],
        'proto': dump.split()[0] if dump else '',
        'h': h,
        'body': body,
        'text': text,
    }


def searchable(msg):
    h = msg['h']
    return ' '.join([msg['first']] + h.get('from', []) + h.get('to', []) + h.get('contact', []) + h.get('p-asserted-identity', []))


def sdp_summary(body):
    m = re.search(r'^m=audio (\d+) (\S+) ([0-9 ]+)', body, re.M)
    c = re.search(r'^c=IN IP4 (\S+)', body, re.M)
    dirs = re.findall(r'^a=(sendrecv|sendonly|recvonly|inactive)', body, re.M)
    if not m:
        return ''
    return f' [sdp {c.group(1) if c else "?"}:{m.group(1)} {m.group(2)} pt {m.group(3).strip()}{" " + dirs[0] if dirs else ""}]'


MEM_HELP = ('Out of memory (cap {mb} MB, --max-mem-mb): narrow --since/--until or add filters. '
            'For day-long analysis copy the pcaps off the edge and run there.')


def limit_resources(max_mem_mb):
    """Keep a search from starving Kamailio on a small edge (2026-11-15: a full-day scan held
    every message in memory and edge-1 froze and rebooted, an 11-minute outage).
    The cap makes Python raise MemoryError instead of pushing the VM into memory pressure."""
    try:
        os.nice(10)
    except (AttributeError, OSError):  # no os.nice on Windows
        pass
    if max_mem_mb > 0:
        try:
            import resource
            cap = max_mem_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (cap, cap))
        except (ImportError, ValueError, OSError):
            pass  # not on Linux (e.g. Windows dev box): no cap


def messages(files, since, until):
    """Stream parsed messages in the time window, one at a time."""
    for path in files:
        for t, src, dst, payload in packets(path):
            when = dt.datetime.fromtimestamp(t, UTC)
            if (since and when < since) or (until and when > until):
                continue
            msg = parse(payload)
            if msg:
                msg.update(t=t, src=src, dst=dst)
                yield msg


# Per-Call-ID criteria, kept as bits so pass 1 stores one small int per interesting Call-ID.
B_METHOD, B_MATCH, B_FAILED = 1, 2, 4


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='*')
    ap.add_argument('--dir')
    ap.add_argument('--call-id')
    ap.add_argument('--match')
    ap.add_argument('--method')
    ap.add_argument('--failed', action='store_true')
    ap.add_argument('--since')
    ap.add_argument('--until')
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--max-mem-mb', type=int, default=300)
    ap.add_argument('--long', action='store_true')
    a = ap.parse_args()

    today = dt.datetime.now(UTC).date()
    since = parse_when(a.since, today) if a.since else None
    until = parse_when(a.until, today) if a.until else None
    if a.dir and not a.long:
        start = since or dt.datetime.now(UTC) - dt.timedelta(hours=24)
        span = (until or dt.datetime.now(UTC)) - start
        if since is None or span > dt.timedelta(hours=MAX_WINDOW_H):
            sys.exit(f'window is {span.total_seconds() / 3600:.1f} h; on a live edge give --since/--until '
                     f'at most {MAX_WINDOW_H} h apart (or --long, ideally on a copy of the pcaps, not the edge)')
    files = list(a.files)
    if a.dir:
        files += pick_files(a.dir, since, until)
        if not files:
            print(f'no SIP history files in {a.dir} for that time window')
            return
    if not files:
        sys.exit('no pcap files (give files or --dir)')
    limit_resources(a.max_mem_mb)
    try:
        run(a, files, since, until)
    except MemoryError:
        sys.exit(MEM_HELP.format(mb=a.max_mem_mb))


def run(a, files, since, until):
    method = a.method.upper() if a.method else None
    want_options = method == 'OPTIONS'
    need = (B_METHOD if method else 0) | (B_MATCH if a.match else 0) | (B_FAILED if a.failed else 0)

    # Pass 1: stream, remember only which Call-IDs meet which criteria (insertion order = first seen).
    bits = OrderedDict()
    n_msgs = 0
    for m in messages(files, since, until):
        n_msgs += 1
        cid = m['call_id']
        if a.call_id and a.call_id not in cid:
            continue
        b = 0
        if method and m['method'] == method:
            b |= B_METHOD
        if a.match and a.match in searchable(m):
            b |= B_MATCH
        st = m['status']
        if a.failed and st and st >= 400 and st not in (401, 407) and (want_options or m['method'] != 'OPTIONS'):
            b |= B_FAILED
        if need == 0:
            if cid not in bits and len(bits) <= a.limit:
                bits[cid] = 0  # no criteria: the first Call-IDs seen (one extra = "more exist")
        elif b:
            bits[cid] = bits.get(cid, 0) | b
    picked = [cid for cid, b in bits.items() if b & need == need]
    total = len(picked)
    picked = picked[:a.limit]
    bits.clear()

    # Pass 2: keep messages only for the Call-IDs that will be printed.
    keep = {cid: [] for cid in picked}
    for m in messages(files, since, until):
        lst = keep.get(m['call_id'])
        if lst is not None:
            if not a.full:
                m['text'] = ''
            m['h'] = None
            lst.append(m)

    more = f', showing {a.limit}' if total > a.limit else ''
    print(f'{len(files)} file(s), {n_msgs} messages; {total}{"+" if need == 0 and total > a.limit else ""} '
          f'Call-IDs match{more}')
    for cid in picked:
        msgs = sorted(keep[cid], key=lambda m: m['t'])
        print(f'\n=== Call-ID {cid} ({len(msgs)} messages)')
        for m in msgs:
            if method and m['method'] != method:
                continue
            ts = dt.datetime.fromtimestamp(m['t'], UTC).strftime('%H:%M:%S.%f')[:-3]
            line = m['first'] if m['status'] is None else f"{m['first']} ({m['method']})"
            print(f"{ts} {m['proto'] or '?':4} {m['src']:>21} -> {m['dst']:<21} {line[:100]} cseq {m['cseq']}{sdp_summary(m['body'])}")
            if a.full:
                print('    ' + m['text'].replace('\r\n', '\n    ').rstrip())


if __name__ == '__main__':
    main()

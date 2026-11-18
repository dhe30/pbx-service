#!/usr/bin/env python3
"""Read-only: count SIP final replies by method and code in an edge's sipdump pcaps.

    loadtest/diag/remote.sh edge-1 py loadtest/diag/sip-codes.py [files=2] [dir=/var/log/pbx/sipdump]

Uses the newest N hourly files (default 2). Scans them with mmap (no big memory use) at nice 10.
Each reply an edge relays appears twice (received from one side, sent to the other), so look at
ratios, not absolute numbers. 487 = a CANCELled branch (losing simultaneous-ring legs, caller hung
up): normal. Look at 408 / 480 / 5xx: those are the failures a capacity problem produces.
"""
import collections
import glob
import mmap
import os
import re
import sys

os.nice(10)
n = int(sys.argv[1]) if len(sys.argv) > 1 else 2
folder = sys.argv[2] if len(sys.argv) > 2 else '/var/log/pbx/sipdump'
files = sorted(glob.glob(os.path.join(folder, '*.pcap')), key=os.path.getmtime)[-n:]
REPLY = re.compile(rb'SIP/2\.0 (\d{3}) ([^\r\n]{0,40})\r\n(?:[^\r\n]{0,2000}\r\n){0,40}?'
                   rb'(?i:CSeq): *\d+ ([A-Z]+)')
REQ = re.compile(rb'\n([A-Z]{3,9}) sip:[^ \r\n]{1,300} SIP/2\.0\r\n')
codes = collections.Counter()
reasons = {}
reqs = collections.Counter()
for f in files:
    with open(f, 'rb') as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as m:
        for x in REPLY.finditer(m):
            code, reason, method = x.group(1).decode(), x.group(2).decode('latin-1'), x.group(3).decode()
            if code >= '200':
                codes[(method, code)] += 1
                reasons.setdefault((method, code), reason)
        for x in REQ.finditer(m):
            reqs[x.group(1).decode()] += 1
print('files:', ', '.join(os.path.basename(f) for f in files))
print('requests seen:', dict(reqs.most_common()))
for method in sorted({k[0] for k in codes}):
    total = sum(v for k, v in codes.items() if k[0] == method)
    print(f'\n{method}: {total} final replies')
    for (meth, code), v in sorted(codes.items()):
        if meth == method:
            print(f'  {code} {reasons[(meth, code)][:30]:30} {v:8d}  {100 * v / total:6.2f}%')

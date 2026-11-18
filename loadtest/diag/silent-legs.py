#!/usr/bin/env python3
"""Why was each silent customer leg silent? Joins audio records, the call app's ring legs and the edges.

The media nodes' audio records (pbx-call-audio, /var/log/pbx/call-audio.jsonl) say WHICH legs were
silent, one record per SIP Call-ID. They can't say why: the silence usually starts at the other
party of the same call, which is a different Call-ID, or at the call app, which never bridged the
leg. This script joins, for a time window:

  media nodes  audio record per Call-ID (verdict, codec, packets each way, Asterisk's side)
  pbx nodes    the call app's "ring: answered" / "ring: leg ended" lines (caller's Call-ID, the
               rung SIP user, cause, and since 2026-11-18 the leg's channel id)
  edges        "legs: <channel id> is [ci=<Call-ID>]" (Kamailio LEG_TAG, since 2026-11-18) and
               "devices: late 2xx ... [ci=...]" (2xx after we gave up on the phone)

and classifies every silent party leg of a ring leg (a call the app placed to a phone):

  stopped by the app          the app had already stopped this leg (another leg won the race, or
                              the ring timeout) when the phone answered: a slow phone, not a bug
  late answer, never bridged  the phone's 200 OK came after Kamailio had answered Asterisk 408
                              (no reply within the phone-branch timer); the app had moved on
  caller sent nothing         the other party of the call sent (almost) no audio: nothing to forward
  ours: bridged, caller ok    the app bridged the leg and the caller sent audio, yet Asterisk
                              sent this leg nothing. Look here first: this one is on our side
  rtpengine dropped it        Asterisk sent audio, the party got none (transcoding/relay)
  not joined                  no matching ring line (e.g. vendor legs, or a window edge)

Silent legs of calls PLACED by a party (its own INVITE) are listed separately by verdict.

Before the leg tags are deployed, ring legs are matched by (rung SIP user, answer time) from the
edge's SIP history (sipdump pcaps), which is heavier: the window is then limited to 15 min.

Run from WSL (uses remote.sh and the ssh agent; read-only, bounded windows):
    python3 loadtest/diag/silent-legs.py 2026-11-17T14:40 2026-11-17T14:50
    python3 loadtest/diag/silent-legs.py 2026-11-19T13:00 2026-11-19T13:30 --list 20
Times are UTC. Hosts come from infra/ansible/inventory/production.ini ([edge], [pbx], [media]).
"""
import argparse
import collections
import configparser
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE = os.path.join(HERE, 'remote.sh')
INVENTORY = os.path.join(HERE, '..', '..', 'infra', 'ansible', 'inventory', 'production.ini')
MAX_LOG_WINDOW = dt.timedelta(minutes=30)
MAX_PCAP_WINDOW = dt.timedelta(minutes=15)
TAIL = dt.timedelta(minutes=3)  # audio records are written when a call ends
# A caller that sent fewer packets than this (~0.5 s of 20 ms audio) counts as silent.
CALLER_SILENT_PACKETS = 25

# ----------------------------------------------------------------------------- remote collectors
# Each runs on one node via `remote.sh <host> py <file> args...` and prints JSON lines.

MEDIA_COLLECTOR = r'''
import json, glob, gzip, sys, os
os.nice(10)
a, b = sys.argv[1], sys.argv[2]
for f in sorted(glob.glob('/var/log/pbx/call-audio.jsonl*')):
    op = gzip.open if f.endswith('.gz') else open
    for l in op(f, 'rt'):
        try: j = json.loads(l)
        except Exception: continue
        if not (a <= j.get('time', '') < b) or j.get('test'): continue
        pbx = next((x for x in j.get('legs', []) if x.get('side') == 'pbx'), {})
        for leg in j.get('legs', []):
            if leg.get('side') != 'party': continue
            print(json.dumps({'cid': j['call_id'], 'node': j.get('edge'), 'time': j['time'], 'verdict': leg.get('verdict'),
                              'codec': leg.get('codec'), 'proto': leg.get('proto'), 'peer': leg.get('peer'),
                              'party_in': leg.get('in_p'), 'party_out': leg.get('out_p'),
                              'ast_in': pbx.get('in_p'), 'ast_out': pbx.get('out_p'), 'dur': j.get('duration_s')}))
'''

PBX_COLLECTOR = r'''
import json, subprocess, sys, os
os.nice(10)
out = subprocess.run(['journalctl', '-u', 'pbx-ari-app', '--since', sys.argv[1], '--until', sys.argv[2], '-o', 'cat'],
                     capture_output=True, text=True).stdout
for l in out.splitlines():
    if '"ring: answered"' not in l and '"ring: leg ended"' not in l and '"ring: others stopped"' not in l: continue
    try: j = json.loads(l)
    except Exception: continue
    if j['msg'] == 'ring: others stopped':
        for leg in j.get('legs') or []:
            print(json.dumps({'t': j['time'] / 1000, 'msg': 'ring: stopped', 'leg': leg, 'parent': j.get('sip', ''), 'won': j.get('won')}))
        continue
    tg = j.get('target')
    if isinstance(tg, str):
        try: tg = json.loads(tg)
        except Exception: tg = {}
    tg = tg or {}
    print(json.dumps({'t': j['time'] / 1000, 'msg': j['msg'], 'user': tg.get('sipUsername') or tg.get('number'),
                      'kind_target': tg.get('kind'), 'parent': j.get('sip', ''), 'caller_kind': j.get('kind'),
                      'leg': j.get('leg'), 'cause': j.get('cause'), 'ms': j.get('ms')}))
'''

EDGE_LOG_COLLECTOR = r'''
import json, re, subprocess, sys, os
os.nice(10)
out = subprocess.run(['journalctl', '-u', 'kamailio', '--since', sys.argv[1], '--until', sys.argv[2], '-o', 'cat',
                      '-g', 'legs: |late 2xx'], capture_output=True, text=True).stdout
for l in out.splitlines():
    m = re.search(r'legs: (\S+) is \[ci=([^\]]+)\] to (\S*)', l)
    if m:
        print(json.dumps({'type': 'leg', 'leg': m.group(1), 'cid': m.group(2), 'user': m.group(3)})); continue
    m = re.search(r'late 2xx from (\S+) .*\[ci=([^\]]+)\]', l)
    if m:
        print(json.dumps({'type': 'late', 'cid': m.group(2), 'from': m.group(1)}))
'''

# Fallback (no leg tags yet): ring legs from the edge's SIP history: INVITE pbx -> edge, its R-URI
# user, the time of the 200 OK we relayed back, and whether the pbx got a final reply before it.
EDGE_PCAP_COLLECTOR = r'''
import json, os, re, struct, sys, glob, datetime as dt, ipaddress
os.nice(10)
U = dt.timezone.utc
since = dt.datetime.fromisoformat(sys.argv[1]).replace(tzinfo=U).timestamp()
until = dt.datetime.fromisoformat(sys.argv[2]).replace(tzinfo=U).timestamp()
pbx = set(sys.argv[3].split(','))
def first_ts(p):
    with open(p, 'rb') as f: h = f.read(32)
    if len(h) < 32: return None
    e = '<' if h[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
    return struct.unpack(e + 'I', h[24:28])[0]
files = sorted((first_ts(p), p) for p in glob.glob('/var/log/pbx/sipdump/*.pcap') if first_ts(p))
use = [p for i, (s, p) in enumerate(files) if s <= until and (files[i + 1][0] if i + 1 < len(files) else 1e12) >= since]
legs = {}
def hdr(p, n):
    m = re.search(rb'^' + n + rb'\s*:\s*([^\r\n]*)', p, re.M | re.I)
    return m.group(1).decode('utf-8', 'replace') if m else ''
for path in use:
    with open(path, 'rb') as f:
        h = f.read(24)
        e = '<' if h[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
        ns = h[:4] in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
        off = {1: 14, 113: 16, 276: 20, 101: 0, 12: 0}[struct.unpack(e + 'I', h[20:24])[0]]
        while True:
            r = f.read(16)
            if len(r) < 16: break
            s, fr, n, _ = struct.unpack(e + 'IIII', r)
            t = s + fr / (1e9 if ns else 1e6)
            if t < since: f.seek(n, 1); continue
            if t > until + 60: break
            ip = f.read(n)[off:]
            if len(ip) < 28 or ip[9] != 17: continue
            ihl = (ip[0] & 15) * 4
            src = str(ipaddress.IPv4Address(ip[12:16])); dst = str(ipaddress.IPv4Address(ip[16:20]))
            p = ip[ihl + 8:]
            if p.startswith(b'INVITE ') and src in pbx and 'tag=' not in hdr(p, b'To') and t <= until:
                m = re.match(rb'INVITE sip:([^@;>]+)@', p); cid = hdr(p, b'(?:Call-ID|i)')
                if m and cid not in legs:
                    legs[cid] = {'type': 'pcapleg', 'cid': cid, 'user': m.group(1).decode(), 'inv': t, 'ans': None, 'final_before': None}
            elif p.startswith(b'SIP/2.0 ') and dst in pbx and hdr(p, b'CSeq').endswith('INVITE'):
                cid = hdr(p, b'(?:Call-ID|i)'); leg = legs.get(cid)
                if not leg: continue
                code = int(p[8:11])
                if code >= 300 and leg['final_before'] is None and leg['ans'] is None: leg['final_before'] = code
                if code == 200 and leg['ans'] is None: leg['ans'] = t
for v in legs.values(): print(json.dumps(v))
'''


def inventory():
    cp = configparser.ConfigParser(allow_no_value=True, delimiters=(' ',), strict=False)
    cp.optionxform = str
    with open(INVENTORY) as f:
        cp.read_string(f.read())
    def hosts(group, var):
        out = []
        for name, rest in cp.items(group) if cp.has_section(group) else []:
            kv = dict(x.split('=', 1) for x in (rest or '').split() if '=' in x)
            out.append(kv.get(var) or kv.get('ansible_host'))
        return [h for h in out if h]
    return hosts('edge', 'ansible_host'), hosts('pbx', 'private_ip'), hosts('media', 'ansible_host'), hosts('pbx', 'private_ip')


def collect(host, code, *args):
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as f:
        f.write(code)
        path = f.name
    try:
        r = subprocess.run(['bash', REMOTE, host, 'py', path, *[f"'{a}'" for a in args]],
                           capture_output=True, text=True, timeout=600)
    finally:
        os.unlink(path)
    if r.returncode != 0:
        print(f'  {host}: collector failed: {r.stderr.strip()[:300]}', file=sys.stderr)
    rows = []
    for line in r.stdout.splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows


def tx(codec):
    c = (codec or '').split('/')[0]
    if not c or c.startswith('unknown'):
        return 'unknown'
    return 'PCMU' if c == 'PCMU' else 'transcoded'


def silent(rec):
    return rec and rec.get('verdict') not in (None, 'ok', 'no_media')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('since', help='UTC, YYYY-MM-DDTHH:MM')
    ap.add_argument('until', help='UTC, YYYY-MM-DDTHH:MM')
    ap.add_argument('--pcap', action='store_true', help='force the SIP-history fallback even if leg tags exist')
    ap.add_argument('--list', type=int, default=8, help='examples to print per class (default 8)')
    args = ap.parse_args()
    since = dt.datetime.fromisoformat(args.since)
    until = dt.datetime.fromisoformat(args.until)
    if until <= since or until - since > MAX_LOG_WINDOW:
        sys.exit(f'window must be > 0 and at most {MAX_LOG_WINDOW} (keep the nodes unloaded)')
    edges, pbxs, medias, pbx_ips = inventory()
    iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%S')
    jt = lambda d: d.strftime('%Y-%m-%d %H:%M:%S')

    print(f'collecting {args.since} .. {args.until} UTC: media {medias}, pbx {pbxs}, edges {edges}', file=sys.stderr)
    audio = {}
    for h in medias:
        for r in collect(h, MEDIA_COLLECTOR, iso(since), iso(until + TAIL)):
            audio.setdefault(r['cid'], r)
    ring = []
    for h in pbxs:
        ring += collect(h, PBX_COLLECTOR, jt(since - dt.timedelta(seconds=30)), jt(until + dt.timedelta(seconds=60)))
    tags, late = {}, set()
    if not args.pcap:
        for h in edges:
            for r in collect(h, EDGE_LOG_COLLECTOR, jt(since - dt.timedelta(seconds=30)), jt(until + dt.timedelta(seconds=60))):
                if r['type'] == 'leg':
                    tags[r['leg']] = r['cid']
                else:
                    late.add(r['cid'])
    mode = 'leg tags' if tags else 'SIP-history match (no leg tags in this window)'
    # leg channel id -> its ring lines; leg Call-ID -> channel id
    by_leg = collections.defaultdict(list)
    for r in ring:
        if r.get('leg'):
            by_leg[r['leg']].append(r)
    legs = {}  # ring-leg Call-ID -> {'answered': bool, 'cause': ..., 'parent': caller Call-ID, 'late': bool}
    if tags:
        for chan, cid in tags.items():
            lines = by_leg.get(chan, [])
            ans = next((x for x in lines if x['msg'] == 'ring: answered'), None)
            end = next((x for x in lines if x['msg'] == 'ring: leg ended'), None)
            stop = next((x for x in lines if x['msg'] == 'ring: stopped'), None)
            parent = (ans or end or stop or {}).get('parent')
            legs[cid] = {'answered': bool(ans), 'cause': (end or {}).get('cause'), 'parent': parent, 'late': cid in late,
                         'stopped': bool(stop) and not ans, 'race_lost': bool(stop and stop.get('won'))}
    else:
        if until - since > MAX_PCAP_WINDOW:
            sys.exit(f'no leg tags in this window: the SIP-history fallback is limited to {MAX_PCAP_WINDOW}')
        pc = []
        for h in edges:
            pc += collect(h, EDGE_PCAP_COLLECTOR, iso(since), iso(until), ','.join(pbx_ips))
        answered = [r for r in ring if r['msg'] == 'ring: answered' and r.get('user')]
        ended = [r for r in ring if r['msg'] == 'ring: leg ended' and r.get('user')]
        for p in pc:
            if p['ans'] is None:
                continue
            a = [r for r in answered if r['user'] == p['user'] and abs(r['t'] - p['ans']) < 1.0]
            e = [r for r in ended if r['user'] == p['user'] and p['inv'] - 1 <= r['t'] <= p['ans'] + 1]
            parent = a[0]['parent'] if len(a) == 1 else (e[0]['parent'] if len(e) == 1 else None)
            legs[p['cid']] = {'answered': len(a) == 1, 'cause': e[0]['cause'] if e else None, 'parent': parent,
                              'late': p['final_before'] is not None, 'answer_s': round(p['ans'] - p['inv'], 1)}

    classes = collections.Counter(); by_codec = collections.Counter(); examples = collections.defaultdict(list)
    placed = collections.Counter()
    ring_cids = set(legs)
    for cid, rec in audio.items():
        if not rec.get('verdict') or rec['verdict'] == 'no_media':
            continue
        c = tx(rec['codec'])
        if cid not in ring_cids:
            if silent(rec):
                placed[(rec['verdict'], c)] += 1
            continue
        by_codec[(c, 'total')] += 1
        if not silent(rec):
            continue
        lg = legs[cid]; caller = audio.get(lg['parent'] or '')
        if lg.get('stopped'):
            k = 'stopped by the app (another leg won)' if lg.get('race_lost') else 'stopped by the app (ring timeout)'
        elif lg['late'] or (not lg['answered'] and lg['cause'] == 18):
            k = 'late answer, never bridged'
        elif not lg['answered'] and not lg['parent']:
            k = 'not joined (no ring line for this leg)'
        elif not lg['answered']:
            k = 'not bridged (app saw no answer)'
        elif rec.get('ast_in') and not rec.get('party_out'):
            k = 'rtpengine dropped it'
        elif caller and (caller.get('party_in') or 0) < CALLER_SILENT_PACKETS:
            k = 'caller sent nothing'
        elif caller:
            k = 'ours: bridged, caller ok'
        else:
            k = 'not joined (caller record missing)'
        classes[k] += 1; by_codec[(c, k)] += 1
        if len(examples[k]) < args.list:
            examples[k].append((rec['time'][11:19], cid[:36], rec['codec'], rec['peer'], 'party_in', rec['party_in'],
                                'ast_in', rec['ast_in'], 'dur', rec['dur'], 'caller', (lg['parent'] or '')[:30],
                                'caller_sent', (caller or {}).get('party_in', '-'), 'answer_s', lg.get('answer_s', '')))
    total_silent = sum(classes.values())
    print(f'mode: {mode}; audio records {len(audio)}, ring legs {len(legs)}, ring lines {len(ring)}')
    print(f'\nSILENT RING LEGS (calls the app placed to a phone or number): {total_silent}')
    for k, v in classes.most_common():
        print(f'  {v:5d}  {k}')
    print('\nby the leg\'s codec (silent / ring legs with audio):')
    for c in ('PCMU', 'transcoded', 'unknown'):
        n = by_codec[(c, 'total')]
        if not n:
            continue
        parts = ', '.join(f'{k} {by_codec[(c, k)]}' for k in classes if by_codec[(c, k)])
        bad = sum(by_codec[(c, k)] for k in classes)
        print(f'  {c:10s} {bad:4d}/{n:<5d} {100 * bad / n:4.1f}%   {parts}')
    print('\nsilent legs of calls PLACED by a party (its own INVITE), by verdict and codec:')
    for (v, c), n in placed.most_common():
        print(f'  {n:5d}  {v:18s} {c}')
    for k, ex in examples.items():
        print(f'\nexamples: {k}')
        for e in ex:
            print('   ', *e)


if __name__ == '__main__':
    main()

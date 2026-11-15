#!/usr/bin/env python3
"""Which API requests are slow, and where does the time go? Reads an edge's HAProxy log.

The course measures API latency from its own client. HAProxy's log (option httplog) splits each
request it handled into:
    TR  receiving the request headers      Tw  waiting in a queue
    Tc  connecting to an app node          Tr  the API's response time
    Ta  total, from the first byte of the request to the end of the response
Ta does NOT include the TCP + TLS handshake with the client. So:
  - slow in the course's chart but small Ta here  -> time lost before HAProxy got the request
    (client SYN lost or dropped by us: see the TCP listen counters printed at the end);
  - large Tc -> connect to the app node (lost SYN on the private network, PR #39);
  - large Tr -> the API itself (the route is listed; check pbx_api_http_request_duration_seconds).

Run on an edge (logs are in journald):
    ssh root@<edge> 'python3 - 24' < loadtest/diag/haproxy-slow.py      # last 24 hours
Course clients seen so far (V-A4): 130.245.136.85 (API load probes), 130.245.136.233 (adapter).
"""
import collections
import re
import subprocess
import sys

HOURS = sys.argv[1] if len(sys.argv) > 1 else '24'
SKIP_PATHS = ('/ready', '/health', '/metrics')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I)
DIGITS = re.compile(r'/\d{3,}')
LINE = re.compile(
    r'(?P<cip>[\d.]+):\d+ \[(?P<date>[^\]]+)\] (?P<fe>\S+) (?P<be>[^/\s]+)/(?P<srv>\S+) '
    r'(?P<TR>-?\d+)/(?P<Tw>-?\d+)/(?P<Tc>-?\d+)/(?P<Tr>-?\d+)/\+?(?P<Ta>-?\d+) (?P<st>\d{3}) '
    r'.*? (?P<ac>\d+)/(?P<fc>\d+)/(?P<bc>\d+)/(?P<sc>\d+)/\+?(?P<rc>\d+) \d+/\d+ .*?"(?P<m>[A-Z]+) (?P<path>\S+)'
)


def route(path):
    path = path.split('?', 1)[0]
    return DIGITS.sub('/:n', UUID.sub(':id', path))


def pct(vals, p):
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(p / 100 * len(vals)))] if vals else 0


def main():
    out = subprocess.run(
        ['journalctl', '-u', 'haproxy', '--since', f'-{HOURS}h', '-o', 'cat', '--no-pager'],
        capture_output=True, text=True, check=False,
    ).stdout
    reqs = []
    for line in out.splitlines():
        m = LINE.search(line)
        if not m or m['be'] != 'api':
            continue
        d = m.groupdict()
        if d['path'].split('?', 1)[0] in SKIP_PATHS:
            continue
        for k in ('TR', 'Tw', 'Tc', 'Tr', 'Ta', 'rc'):
            d[k] = int(d[k])
        reqs.append(d)
    if not reqs:
        sys.exit(f'no api requests in the HAProxy log for the last {HOURS} h '
                 '(is HAProxy logging to journald on this edge?)')

    ta = [r['Ta'] for r in reqs]
    print(f'last {HOURS} h on this edge: {len(reqs)} API requests (health checks excluded)')
    print(f'  Ta (HAProxy, handshake not included): p50 {pct(ta, 50)} ms, p95 {pct(ta, 95)} ms, '
          f'p99 {pct(ta, 99)} ms, max {max(ta)} ms; over 1 s: {sum(t > 1000 for t in ta)}')
    print(f'  requests that needed a connect retry to an app node: {sum(r["rc"] > 0 for r in reqs)}')
    print(f'  aborted / errors (Tr or Tc = -1): {sum(r["Tr"] < 0 or r["Tc"] < 0 for r in reqs)}\n')

    print('slow requests (Ta > 1 s): which part was slow')
    slow = [r for r in reqs if r['Ta'] > 1000]
    blame = collections.Counter()
    for r in slow:
        parts = {'receiving request (TR)': r['TR'], 'queue (Tw)': r['Tw'],
                 'connect to app (Tc)': r['Tc'], 'API response (Tr)': r['Tr']}
        blame[max(parts, key=parts.get)] += 1
    for k, n in blame.most_common():
        print(f'  {k}: {n}')
    print()

    print('per route: count, p99 Ta, requests over 1 s (sorted by slow count)')
    by_route = collections.defaultdict(list)
    for r in reqs:
        by_route[f'{r["m"]} {route(r["path"])}'].append(r['Ta'])
    rows = sorted(by_route.items(), key=lambda kv: (-sum(t > 1000 for t in kv[1]), -len(kv[1])))
    for name, vals in rows[:25]:
        print(f'  {name:45} {len(vals):6} {pct(vals, 99):7} ms {sum(t > 1000 for t in vals):5}')
    print()

    print('per client IP (top 10)')
    by_ip = collections.defaultdict(list)
    for r in reqs:
        by_ip[r['cip']].append(r['Ta'])
    for ip, vals in sorted(by_ip.items(), key=lambda kv: -len(kv[1]))[:10]:
        print(f'  {ip:16} {len(vals):6} requests, p99 Ta {pct(vals, 99)} ms, over 1 s: {sum(t > 1000 for t in vals)}')
    print()

    print('20 slowest (date, client, TR/Tw/Tc/Tr/Ta ms, connect retries, status, request)')
    for r in sorted(reqs, key=lambda r: -r['Ta'])[:20]:
        print(f'  {r["date"]} {r["cip"]:15} {r["TR"]}/{r["Tw"]}/{r["Tc"]}/{r["Tr"]}/{r["Ta"]} '
              f'rc={r["rc"]} {r["st"]} {r["m"]} {route(r["path"])} -> {r["srv"]}')
    print()

    # Handshakes HAProxy never logs: SYNs the kernel dropped or answered late on our listeners.
    print('TCP listen counters on this edge (absolute since boot; run twice to see the rate):')
    print(subprocess.run(
        ['nstat', '-az', 'TcpExtListenOverflows', 'TcpExtListenDrops', 'TcpExtTCPReqQFullDrop',
         'TcpExtSyncookiesSent', 'TcpExtTCPSynRetrans', 'TcpExtTCPTimeouts'],
        capture_output=True, text=True, check=False).stdout)
    print(subprocess.run(['uptime', '-s'], capture_output=True, text=True, check=False).stdout.strip(), '= booted')
    print('listeners (Recv-Q = connections waiting for accept, Send-Q = backlog limit):')
    print(subprocess.run(['ss', '-ltnH', 'sport = :443 or sport = :5061 or sport = :8080 or sport = :80'],
                         capture_output=True, text=True, check=False).stdout)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Read-only: does our failure RATE grow with load, or stay constant?

Runs on mon-1 (queries Prometheus over HTTP GET, changes nothing):
    loadtest/diag/remote.sh mon-1 py loadtest/diag/load-shape.py [hours=24] [step_min=15] [prom=http://10.0.1.81:9090]

Prints one row per time bucket: calls/min, % of legs per outcome, and the busiest CPU / load per
VM. Read it like this:
  - failed% roughly constant while calls/min varies  -> a fixed per-call cause (bug or packet loss)
  - failed% ~0 at low load, then climbing             -> a capacity limit; the VM whose CPU/load is
                                                         pinned in those rows is the bottleneck
"""
import json
import sys
import time
import urllib.parse
import urllib.request

hours = float(sys.argv[1]) if len(sys.argv) > 1 else 24
step = int(float(sys.argv[2]) * 60) if len(sys.argv) > 2 else 900
prom = sys.argv[3] if len(sys.argv) > 3 else 'http://10.0.1.81:9090'
end = int(time.time())
end -= end % step
start = end - int(hours * 3600)
start -= start % step   # Prometheus returns points at start + k*step: keep them on our grid
win = f'{step}s'


def q(expr):
    url = prom + '/api/v1/query_range?' + urllib.parse.urlencode(
        {'query': expr, 'start': start, 'end': end, 'step': step})
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.load(r)['data']['result']
    out = {}
    for s in data:
        key = '|'.join(f'{v}' for k, v in sorted(s['metric'].items())) or 'all'
        for t, v in s['values']:
            try:
                out.setdefault(key, {})[int(t)] = float(v)
            except ValueError:
                pass
    return out


outcomes = q(f'sum by (outcome) (rate(pbx_calls_total[{win}])) * 60')
audio = q(f'sum by (verdict) (rate(pbx_call_audio_legs_total{{test="false"}}[{win}])) * 60')
cpu = q(f'1 - avg by (instance) (rate(node_cpu_seconds_total{{mode="idle"}}[{win}]))')
load = q(f'max_over_time(node_load1[{win}])')
active = q(f'max by (instance) (max_over_time(pbx_active_calls[{win}]))')
inst = lambda k: k.split('|')[0].split(':')[0]

names = sorted(outcomes)
anames = sorted(audio)
pnames = sorted(active)
print('time(UTC)    calls/min  ' + '  '.join(f'{n[:9]:>9}%' for n in names)
      + '  ' + '  '.join(f'{("aud:" + n)[:14]:>14}/min' for n in anames)
      + '  ' + '  '.join(f'{("max@" + inst(n))[:14]:>14}' for n in pnames)
      + '  busiest-CPU                 highest-load1')
for t in range(start, end + 1, step):
    total = sum(outcomes[n].get(t, 0) for n in names)
    if total == 0:
        continue
    row = f'{time.strftime("%m-%d %H:%M", time.gmtime(t))}  {total:9.1f}  '
    row += '  '.join(f'{100 * outcomes[n].get(t, 0) / total:9.1f}%' for n in names)
    row += '  ' + '  '.join(f'{audio[n].get(t, 0):14.2f}    ' for n in anames)
    row += '  ' + '  '.join(f'{active[n].get(t, 0):14.0f}' for n in pnames)
    c = max(((v.get(t, 0), inst(k)) for k, v in cpu.items()), default=(0, '-'))
    l = max(((v.get(t, 0), inst(k)) for k, v in load.items()), default=(0, '-'))
    row += f'  {c[1]:>15} {100 * c[0]:5.1f}%   {l[1]:>15} {l[0]:5.2f}'
    print(row)

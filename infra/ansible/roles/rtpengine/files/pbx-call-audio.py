#!/usr/bin/env python3
"""Per-call audio record from rtpengine's own final packet stats (managed by Ansible, roles/rtpengine).

Why: the course counts "failed, silent or misrouted legs" but never says which call. rtpengine
already logs, for every call it deletes (log-level 6), each leg's codec and the packets/bytes it
received from and sent to that party. This turns those lines into one JSON record per call and a
verdict per party-facing leg, so a silent leg shows up on our side, with its Call-ID, minutes
after it happens (docs/incidents/2026-11-14-codec-flip.md: every failed call had a leg where we
sent the phone a different packet size than it sent us).

Verdicts (per leg toward a party, i.e. a peer that is not a private address = not Asterisk):
  ok
  no_media            no packets either way (e.g. answered, then hung up at once)
  silent_from_party   the party sent nothing while we sent it audio
  silent_to_party     we sent the party nothing while it sent audio
  format_mismatch     packets we sent it differ in size from what it sends (a different codec:
                      PCMU 172 B, G.729 32 B, G.723 36 B per 20/30 ms packet incl. RTP header).
                      Not detectable: PCMU vs PCMA (same size). Opus legs are never judged on size.

Usage:
  pbx-call-audio --follow [--jsonl FILE] [--prom FILE] [--test-peer IP ...]   (systemd service)
  journalctl -u rtpengine-daemon -o short-unix ... | pbx-call-audio --stdin [--summary]
Input lines must be journalctl "-o short-unix" format.
"""
import argparse
import ipaddress
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter

LINE = re.compile(r'^(?P<ts>\d+\.\d+) (?P<host>\S+) rtpengine\[\d+\]: \w+: \[(?P<cid>[^\]]+)\]: \[core\] (?P<msg>.*)$')
TAG = re.compile(r"^--- Tag '(?P<tag>[^']*)', created (?P<age>[\d:]+) ago")
MEDIA = re.compile(r'^------ Media #\d+ \(\w+ over (?P<proto>[^)]+)\) using (?P<codec>.+)$')
PORT = re.compile(r'^--------- Port\s+(?P<local>\S+)\s+<>\s+(?P<peer>\S+?)\s*(?P<rtcp>\(RTCP\))?, SSRC \S+, '
                  r'in (?P<inp>\d+) p, (?P<inb>\d+) b, (?P<ine>\d+) e, \d+ ts, '
                  r'out (?P<outp>\d+) p, (?P<outb>\d+) b, (?P<oute>\d+) e')
DELETE_DELAY_S = 30   # rtpengine delete-delay: "created X ago" is measured 30 s after the BYE
VERDICTS = ('ok', 'no_media', 'silent_from_party', 'silent_to_party', 'format_mismatch')


def is_private(ip):
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


def age_seconds(age):
    s = 0
    for part in age.split(':'):
        s = s * 60 + int(part)
    return s


def judge(leg):
    """Verdict for one party-facing leg (dict with in_p/in_b/out_p/out_b/proto/codec)."""
    in_p, out_p = leg['in_p'], leg['out_p']
    if in_p == 0 and out_p == 0:
        return 'no_media'
    if in_p == 0 and out_p >= 50:
        return 'silent_from_party'
    if out_p == 0 and in_p >= 50:
        return 'silent_to_party'
    if in_p >= 100 and out_p >= 100 and 'opus' not in leg['codec'].lower():
        in_bpp = leg['in_b'] / in_p
        out_bpp = leg['out_b'] / out_p
        if 'SAVP' in leg['proto']:
            in_bpp -= 10        # SRTP auth tag counted on the received (still encrypted) side
        margin = max(8.0, 0.2 * max(in_bpp, out_bpp))
        # Judge only when the party's own stream clearly has one size. A browser mixes PCMU with
        # 13-byte comfort-noise packets (average ~130 B): not a codec, so not judged.
        if in_bpp >= 150 and out_bpp < in_bpp - margin:      # party talks PCMU/PCMA, we send smaller
            return 'format_mismatch'
        if in_bpp <= 50 and out_bpp > in_bpp + margin:       # party talks G.729/G.723, we send larger
            return 'format_mismatch'
    return 'ok'


class Call:
    def __init__(self, cid, ts, host):
        self.cid, self.ts, self.host = cid, ts, host
        self.legs = []
        self._tag = None
        self._media = None

    def feed(self, msg):
        m = TAG.match(msg)
        if m:
            self._tag = {'tag': m['tag'], 'age_s': age_seconds(m['age'])}
            self._media = None
            return
        m = MEDIA.match(msg)
        if m and self._tag is not None:
            self._media = {'proto': m['proto'], 'codec': m['codec']}
            return
        m = PORT.match(msg)
        if m and self._media is not None and not m['rtcp']:
            peer_ip, _, peer_port = m['peer'].rpartition(':')
            # No peer address: a fork branch that never answered, or a call cancelled while ringing.
            side = 'none' if not peer_ip else ('pbx' if is_private(peer_ip) else 'party')
            leg = {
                'tag': self._tag['tag'],
                'peer': peer_ip, 'peer_port': int(peer_port or 0),
                'side': side,
                'proto': self._media['proto'], 'codec': self._media['codec'],
                'in_p': int(m['inp']), 'in_b': int(m['inb']), 'in_e': int(m['ine']),
                'out_p': int(m['outp']), 'out_b': int(m['outb']), 'out_e': int(m['oute']),
                'age_s': self._tag['age_s'],
            }
            leg['in_bpp'] = round(leg['in_b'] / leg['in_p'], 1) if leg['in_p'] else None
            leg['out_bpp'] = round(leg['out_b'] / leg['out_p'], 1) if leg['out_p'] else None
            leg['verdict'] = judge(leg) if leg['side'] == 'party' else None
            self.legs.append(leg)
            self._media = None   # first RTP port of each media only

    def record(self, test_peers):
        party = [l for l in self.legs if l['side'] == 'party']
        bad = [l['verdict'] for l in party if l['verdict'] != 'ok']
        return {
            'ts': round(float(self.ts), 3),
            'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(float(self.ts))),
            'edge': self.host,
            'call_id': self.cid,
            # Media lifetime: tag age minus rtpengine's delete-delay (includes ringing time).
            'duration_s': max(0, max((l['age_s'] for l in self.legs), default=0) - DELETE_DELAY_S),
            'test': any(l['peer'] in test_peers for l in self.legs),
            'verdict': bad[0] if bad else ('ok' if party else 'no_party_leg'),
            'legs': self.legs,
        }


class Parser:
    def __init__(self, test_peers, emit):
        self.test_peers = set(test_peers)
        self.emit = emit
        self.open = {}      # cid -> Call (inside a "Final packet stats" block)
        self.last = {}      # cid -> time of last stats line (for the idle flush)

    def line(self, raw):
        m = LINE.match(raw.rstrip('\n'))
        if not m:
            return
        cid, msg = m['cid'], m['msg']
        if '/' in cid:          # "[callid/tag/1 port N]": per-stream lines, never part of the stats block
            return
        if msg.startswith('Final packet stats'):
            self.flush(cid)
            self.open[cid] = Call(cid, m['ts'], m['host'])
            self.last[cid] = time.monotonic()
            return
        call = self.open.get(cid)
        if call is None:
            return
        if msg.startswith(('--- Tag', '------ Media', '--------- Port', '---     ')):
            call.feed(msg)
            self.last[cid] = time.monotonic()
        else:                   # e.g. "Removing media stream ... (final call cleanup)": block is over
            self.flush(cid)

    def flush(self, cid):
        call = self.open.pop(cid, None)
        self.last.pop(cid, None)
        if call is not None and call.legs:
            self.emit(call.record(self.test_peers))

    def flush_idle(self, idle_s=2.0):
        now = time.monotonic()
        for cid in [c for c, t in self.last.items() if now - t > idle_s]:
            self.flush(cid)

    def flush_all(self):
        for cid in list(self.open):
            self.flush(cid)


def write_prom(path, counts, last_bad_ts):
    lines = ['# HELP pbx_call_audio_legs_total Party-facing call legs by audio verdict (rtpengine final stats).',
             '# TYPE pbx_call_audio_legs_total counter']
    for (verdict, test), n in sorted(counts.items()):
        lines.append(f'pbx_call_audio_legs_total{{verdict="{verdict}",test="{str(test).lower()}"}} {n}')
    lines += ['# HELP pbx_call_audio_last_bad_timestamp_seconds Last customer leg with a verdict other than ok.',
              '# TYPE pbx_call_audio_last_bad_timestamp_seconds gauge',
              f'pbx_call_audio_last_bad_timestamp_seconds {last_bad_ts}',
              '# TYPE pbx_call_audio_last_run_timestamp_seconds gauge',
              f'pbx_call_audio_last_run_timestamp_seconds {int(time.time())}']
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--follow', action='store_true', help='tail journalctl -u rtpengine-daemon')
    mode.add_argument('--stdin', action='store_true', help='read journal lines (-o short-unix) from stdin')
    ap.add_argument('--unit', default='rtpengine-daemon')
    ap.add_argument('--jsonl', help='append one JSON record per call to this file')
    ap.add_argument('--prom', help='node_exporter textfile to (re)write with the verdict counters')
    ap.add_argument('--test-peer', action='append', default=[], help='peer IP of our own test calls')
    ap.add_argument('--summary', action='store_true', help='--stdin: print verdict counts at the end')
    ap.add_argument('--bad-only', action='store_true', help='--stdin: print only calls not ok')
    args = ap.parse_args()

    # Counters start at 0 on each restart; Prometheus' increase() handles the reset.
    counts = Counter({(v, t): 0 for v in VERDICTS for t in (False, True)})
    state = {'last_bad': 0, 'dirty': True}
    out = open(args.jsonl, 'a', buffering=1) if args.jsonl else None

    def emit(rec):
        for leg in rec['legs']:
            if leg['side'] == 'party':
                counts[(leg['verdict'], rec['test'])] += 1
        if rec['verdict'] not in ('ok', 'no_party_leg') and not rec['test']:
            state['last_bad'] = int(rec['ts'])
        state['dirty'] = True
        line = json.dumps(rec, separators=(',', ':'))
        if out:
            out.write(line + '\n')
        if args.stdin and not out and (not args.bad_only or rec['verdict'] not in ('ok', 'no_party_leg')):
            print(line)

    parser = Parser(args.test_peer, emit)

    if args.stdin:
        for raw in sys.stdin:
            parser.line(raw)
        parser.flush_all()
        if args.prom:
            write_prom(args.prom, counts, state['last_bad'])
        if args.summary:
            print(json.dumps({f'{v}{" (test)" if t else ""}': n for (v, t), n in sorted(counts.items()) if n},
                             indent=1), file=sys.stderr)
        return

    # --follow: journalctl keeps running; read with a timeout so idle blocks and metrics get flushed.
    import select
    proc = subprocess.Popen(['journalctl', '-u', args.unit, '-f', '-n', '0', '-o', 'short-unix'],
                            stdout=subprocess.PIPE, text=True, bufsize=1)
    last_write = 0.0
    while True:
        ready, _, _ = select.select([proc.stdout], [], [], 1.0)
        if ready:
            raw = proc.stdout.readline()
            if raw == '':
                sys.exit('journalctl exited')
            parser.line(raw)
        parser.flush_idle()
        if args.prom and (state['dirty'] or time.time() - last_write > 60):
            write_prom(args.prom, counts, state['last_bad'])
            state['dirty'], last_write = False, time.time()


if __name__ == '__main__':
    main()

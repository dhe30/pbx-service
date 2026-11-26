#!/usr/bin/env python3
"""Forecast tool, step 1: collect hourly snapshots of our own business data.

Asks a Patroni replica (through the forced command db-query.sh, so mon-1 cannot send SQL) for every
whole hour since the last stored snapshot, one hour per query with a pause in between, and appends
each JSON snapshot to <data_dir>/snapshots.jsonl. Every call record is read once, by the snapshot of
the hour it started in; everything longer (days, trends) is computed from the stored file.

Run by the systemd timer every 6 hours and by `report.py` on request. Stdlib only.

    collect.py [--config /etc/pbx-forecast/config.json] [--max-hours N]
"""
import argparse
import datetime as dt
import fcntl
import json
import os
import subprocess
import sys
import time

DEFAULT_CONFIG = "/etc/pbx-forecast/config.json"
HOUR = dt.timedelta(hours=1)


def load_config(path):
    with open(path) as f:
        cfg = json.load(f)
    cfg.setdefault("data_dir", "/var/lib/pbx-forecast")
    cfg.setdefault("ssh_key", "/var/lib/pbx-forecast/.ssh/id_ed25519")
    cfg.setdefault("ssh_user", "postgres")
    cfg.setdefault("backfill_hours", 72)   # first run: how far back to start
    cfg.setdefault("pause_seconds", 2)     # between hourly queries
    return cfg


def fmt(t):
    return t.strftime("%Y-%m-%d %H:00+00")


def last_snapshot_end(path):
    """End ('to') of the newest stored snapshot, or None."""
    if not os.path.exists(path):
        return None
    last = None
    with open(path) as f:
        for line in f:
            if line.strip():
                last = line
    if last is None:
        return None
    return dt.datetime.strptime(json.loads(last)["to"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def query(cfg, start, end):
    """One hour from the first db node that accepts (replicas only; the primary refuses)."""
    errors = []
    for host in cfg["db_hosts"]:
        cmd = ["ssh", "-i", cfg["ssh_key"], "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
               "-o", "StrictHostKeyChecking=accept-new",
               f"{cfg['ssh_user']}@{host}", f'snapshot "{fmt(start)}" "{fmt(end)}"']
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            lines = [l for l in r.stdout.splitlines() if l.startswith("{")]
            if len(lines) == 1:
                snap = json.loads(lines[0])
                snap["source"] = host
                return snap
            errors.append(f"{host}: unexpected output")
        else:
            errors.append(f"{host}: rc={r.returncode} {r.stderr.strip()[:200]}")
    raise RuntimeError("no replica answered: " + "; ".join(errors))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--max-hours", type=int, default=None, help="stop after this many hours (default: catch up)")
    ap.add_argument("--rebuild", action="store_true",
                    help="move snapshots.jsonl aside (kept as snapshots.<time>.jsonl) and fetch the last "
                         "backfill_hours again, e.g. after the snapshot format changed")
    args = ap.parse_args()
    cfg = load_config(args.config)

    os.makedirs(cfg["data_dir"], exist_ok=True)
    if os.path.exists(os.path.join(cfg["data_dir"], "OFF")):
        print("collect: OFF file present, doing nothing")
        return 0
    out = os.path.join(cfg["data_dir"], "snapshots.jsonl")

    # One collector at a time (timer and an on-request run must not overlap).
    lock = open(os.path.join(cfg["data_dir"], ".collect.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("collect: another run is in progress, skipping")
        return 0

    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    if args.rebuild and os.path.exists(out):
        kept = os.path.join(cfg["data_dir"], f"snapshots.{now:%Y%m%dT%H}.jsonl")
        os.rename(out, kept)
        print(f"collect: old snapshots kept as {kept}")
    start = last_snapshot_end(out) or now - cfg["backfill_hours"] * HOUR
    done = 0
    while start + HOUR <= now and (args.max_hours is None or done < args.max_hours):
        if done:
            time.sleep(cfg["pause_seconds"])
        t0 = time.monotonic()
        snap = query(cfg, start, start + HOUR)
        snap["query_seconds"] = round(time.monotonic() - t0, 3)
        with open(out, "a") as f:
            f.write(json.dumps(snap, separators=(",", ":")) + "\n")
        start += HOUR
        done += 1
    print(f"collect: {done} hour(s) stored, up to {fmt(start)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

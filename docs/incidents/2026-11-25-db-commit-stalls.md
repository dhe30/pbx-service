# 2026-11-25: DB primary disk stalls -> API 503 and all-pbx 408s

## What the grader saw (UTC)
- 13:35-13:38 us/pstn failures (other groups spiked too: partly shared).
- 13:58-13:59 every call type failing (phone_in 84/min); only our group.
- 14:11-14:16 ticket wave: `refresh_failed_408`, `no_audio` (codecs, tls, ivr, ring groups),
  `POST /tickets` / `DELETE /voicemails` -> "503 No server is available", `call_records` "no record".
- Since 14:19 a trickle of 2-8 inbound failures/min (not explained yet; other groups show one too).

Load had risen ~2.5x at 13:03 (grader ~350 -> ~900 calls/min).

## Cause
db-1 (Patroni primary) could not flush its root disk:
- From 13:29 plain `COMMIT`s took 20-84 s and released together (921 commits > 5 s in the 14h hour;
  0 at the same hours on 11-24). `synchronous_standby_names = db-2`.
- walwriter blocked in `blkdev_issue_flush`, `jbd2/vda1` stuck in commit, 0 sectors written to vda in
  12 s, `/proc/pressure/io` full 50-98 %. WAL LSN did not move for 5 s.
- `dd bs=4k count=20 oflag=dsync`: ~30 ms per write on db-1/db-2 root, 7 ms on db-3, 80-170 ms on
  the Garage Volumes. Garage was the largest writer on db-1 (47 MB in 10 s). Root fs mounted `discard`.

## Effects
- API `/ready` checks the DB with a 1.5 s limit: app-1 and app-2 failed together, so the edge
  HAProxies had no API server 14:10:59-14:11:49 and 14:32:21-14:32:39.
- 14:10: all five pbx nodes timed out (408) on edge-2 -> 137 "no pbx node". The ARI app's config
  cache waited for a reload with no time limit whenever the snapshot was expired or invalidated
  (stale fallback only on an error), so a slow DB held new calls on every node.
- 14:39:24 someone ran a Patroni config change: `synchronous_commit` off cluster-wide. Slow commits
  stopped; CDR inserts still took up to 12 s at 14:42.

## Changes
- services/ari-app/src/cache.ts: expired / invalidated snapshots, account ids and rate decks are kept
  as fallbacks; a call waits at most `CONFIG_STALE_WAIT_MS` (500 ms) for a reload when one exists.

## Still open
- Garage write load shares db-1's storage with the Postgres primary (move it, or separate storage).
- Call-path reads share the ARI app's DB pool with CDR inserts that hang on commit.
- `synchronous_commit` is off: a db-1 crash can lose the last fraction of a second of commits.

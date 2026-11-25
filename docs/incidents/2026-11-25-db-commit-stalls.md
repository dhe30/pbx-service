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

## 18:04 UTC: the stall reached etcd -> Patroni shut Postgres down for 70 s
- 17:50-18:04 db-1 statements 20-33 s, a checkpoint sync 117 s; CDR inserts were retried and landed
  3-20 min late (grader `call_records` "no record" tickets for calls 17:45-18:02; the rows exist).
- db-1 is the etcd leader: fdatasync up to 8.8 s. 18:03:44 Patroni read timeouts to all three etcd
  members -> "demoting self because DCS is not accessible" -> fast shutdown 18:04:01 (58 s on the
  stuck disk), read-only 18:05:00, promoted again 18:05:11 (sync standby now db-3).
- Grader: `call failed_500` (ARI app: "the database system is shutting down"), API 503 on
  login / tickets / voicemail_web, a 2-min spike; back to the trickle by 18:07.
- Fix: `failsafe_mode: true` (live 18:12 UTC via `patronictl edit-config`, and in the role). With
  etcd unreachable the primary now stays up while it can reach every member's REST API.

## 18:20 UTC: why the db VMs stall (node_exporter counters since boot)
| | IO fully stalled (% of uptime) | root flushes/s | ms per flush |
|---|---|---|---|
| db-1 | 10.2 | 5.3 | 20.3 |
| db-2 | 6.7 | 5.5 | 6.7 |
| db-3 | 5.9 | 5.5 | 5.7 |
| app / edge / pbx-1..5 | 0.1-0.6 | 0.4-2.3 | 5-10 (pbx-2 34) |

- The db VMs (2 vCPU / 4 GB) are the only ones stalling at that level; db-1's root disk is slower
  per write than db-2's with fewer write ops: its placement, not its load.
- Volumes (vdb) take 120-200 ms per flush on every db node.
- db-1 writes in 20 s: Garage 78 MB (resync queue ~5,300 blocks, LMDB metadata 600 MB on the root
  disk), Postgres 10 MB, journald 6.5 MB (Patroni tracebacks ~3,400 lines/min, Garage ~740/min).
- Not the cause: `discard` (2,800 discards in 35 h, ~2 s in total).

## 18:2x-18:33 UTC: step-1 mitigations (live)
- journald `Storage=volatile`, `RuntimeMaxUse=150M` on db-1..3 (roles/logging: `db` added to
  `journald_volatile_groups`). Restarts 276-837 ms.
- `vm.dirty_background_bytes` 64 MB / `vm.dirty_bytes` 256 MB (roles/postgres_patroni/tasks/
  writeback.yml), instead of 10 % / 20 % of RAM.
- Garage `resync-tranquility` 2 -> 6 on all nodes (`garage worker set -a resync-tranquility 6`; a
  Garage runtime variable, not in the role).
- Patroni switchover db-1 -> db-3 at 18:32:34-18:32:45 (timeline 6; db-2 sync standby; db-1 a
  streaming replica). Cost: 11 failed call flows ("the database system is shutting down") and 25
  Kamailio auth_db read errors (18:32:40-18:33:10); grader register ~35/min for 2 min. Baseline by
  18:34. A manual CHECKPOINT on db-1 beforehand took 139 s during a stall: don't force one on a
  stalling disk.

## Still open
- Garage write load shares db-1's storage with the Postgres primary (move it, or separate storage).
- Call-path reads share the ARI app's DB pool with CDR inserts that hang on commit.
- `synchronous_commit` is off: a db-1 crash can lose the last fraction of a second of commits.

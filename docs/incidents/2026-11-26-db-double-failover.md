# 2026-11-26: memory runs out on the db nodes -> db-2/db-3 stop responding, two Patroni failovers

Status: **mitigated 18:08 UTC** (root cause below; the sections after it are the 17:17 write-up,
made before anyone looked on the db nodes). All three db nodes up, db-1 primary (timeline 10), Garage
memory capped, uploads succeeding, spooled recordings draining.

## Root cause (checked on the db and pbx nodes, 17:50-18:10 UTC)
1. **~15:23: the Garage Volumes filled up.** `/var/lib/garage/data2` (250 GB, 240G declared capacity)
   reached 246 GB on all three db nodes. Every PUT failed:
   `Could not reach quorum of 2 ... IO error: No space left on device (os error 28)`.
2. **Upload retry storm.** Every pbx node's uploader kept retrying every finished recording: oldest
   waiting item 15:23-15:44, ~17,800 recordings (~50 GB) pending at 18:00 (pbx-7 6,830 / 21 GB,
   pbx-3 3,099, pbx-6 2,949), ~99 % of uploads failing. Each pbx node held ~45 connections to Garage,
   with MBs of unread data in Garage's receive queues; db-1 logged `TCP: out of memory`.
3. **Garage memory** (the growing anonymous memory above) reached 2-2.5 GB on the 4 GB db-2/db-3
   and 5.2 GB on db-1. No swap and no cgroup limit, so the VMs thrashed (journal nearly silent,
   etcd unresponsive) instead of killing Garage.
4. **etcd lost quorum, so Patroni demoted the primary.** Recovery came each time from the kernel
   OOM-killing Garage: db-3 at **17:14:03** (etcd leader 17:14:06, db-1 promoted 17:14:08), db-3 at
   17:41:17 and db-2 at 17:41:37 (second outage, no primary 17:41:10-17:42:21, timeline 10).

Fixes:
- 17:56-17:58: the Volumes were grown to 500 GB (online `resize2fs`); PUTs succeed from ~18:00.
- ~19:30: grown again to 1500 GB (online `resize2fs`, 20 % used): recordings were ~105 GB/day per
  node on 11-25 (224k recording minutes; Garage compresses the WAVs ~2:1), so 7 days need ~1-1.4 TB.
  `garage_volume_capacity=1440G`.
- 18:06-18:08: Garage capped live, one node at a time (`systemctl set-property garage`;
  db-2/db-3 MemoryHigh=1200M MemoryMax=1500M, db-1 2500M/3G). Setting it killed and restarted
  Garage on each node: db-2 went from 104 MB to 2.7 GB available. Afterwards Garage's working memory
  was 280-500 MB (the cgroup at MemoryHigh is mostly page cache), with 0 upload failures in 2 min.
- Role: `garage_memory_{max,high}_mb` (37.5 % / 30 % of RAM) in the Garage unit, the live drop-ins
  removed, `garage_volume_capacity=470G` in the production inventory.

Still open:
- Why the Volume could fill: nothing alerted. `DiskSpaceLow` (70 %) should have fired on data2;
  check that the alert covers mounts other than /.
- The uploader makes a backlog worse: in `services/ari-app/src/uploader.ts`, `sweep()` runs
  sequentially but a new sweep starts every interval while the old ones still run, so upload
  concurrency grows with the backlog.
- Lost rows and grader tickets for 16:20-16:30, 17:00-17:14 and 17:41-17:42 (step 6 below).
- Forensics: pg_rewind copies the source's `log/` directory, so on db-2/db-3 the start of
  `postgresql-Thu.log` holds db-1's lines. The volatile journals on db-2/db-3 keep only about 1 h
  (Patroni's ConnectionReset tracebacks), so the 16:22 trigger is no longer in the logs there.

## What happened (UTC)
- 11:00-15:27: steady. Available memory flat on all three db nodes (db-1 ~6.9 GB, db-2 ~2.4 GB,
  db-3 ~2.1 GB); process (anonymous) memory flat at 220-520 MB.
- **15:27-15:47: process memory starts growing on all three nodes at the same time**, about 50 MB/min
  per node (db-1 15:47-16:27: 420 -> 2,432 MB).
- 16:18-16:22: db-3, then db-2, down to 70-100 MB available. Memory pressure, major page faults
  (250-700/s) and disk reads (10-70 MB/s) jump; CPU 90-99 %, IO wait 50-80 %, disk writes near 0.
  The kernel is evicting and re-reading pages (no swap, no OOM kill): the nodes stop answering
  without rebooting (uptime ~58 h). etcd, Patroni, Postgres, Garage and node_exporter all time out.
- 16:22:12: failover, **db-3 -> db-2** (timeline 7).
- 16:25:37: failover, **db-2 -> db-1** (timeline 8). db-1 has been the primary since then.
- 16:26-16:28: Postgres restarts on db-2 and db-3 as replicas, which frees its shared memory
  (Shmem 1,000 -> 160-420 MB) and gives them 1.2-1.4 GB back. Process memory keeps growing.
- 16:50-17:04: db-3 and db-2 run out again the same way; down from 16:54 and again from 17:00.
  No failover this time (db-1 stayed primary).
- About 17:00-17:05: db-1's Postgres exporter missed scrapes and db-1's shared memory dropped
  899 -> 234 MB by 17:07, so **Postgres on db-1 probably restarted** (not confirmed: check
  `patronictl history` for a new timeline and Patroni's log). Its process memory did not drop.
- db-1's process memory grew only ~3 MB/min from 16:47 to 17:07 (2,969 -> 3,035 MB), down from
  ~50 MB/min, while db-2 and db-3 were down. With 3.4 GB available at 17:07 it has hours at that
  rate, but under an hour if it goes back to 50 MB/min. (An earlier estimate of "out of memory at
  about 17:45" assumed 50 MB/min.)
- **About 17:01-17:14: no writable primary (~13 min).** With db-2 and db-3 unresponsive, etcd lost
  quorum, and failsafe mode can't keep a primary that can't reach every member: db-1 demoted itself
  (shared memory 895 -> 233 MB at 17:05 = Postgres restarted read-only).
- 17:14:08: db-1 promoted again (**timeline 9**) once db-3 answered and etcd had quorum.
- 17:15: db-3 back **without a reboot** (uptime 3,492 min). Its process memory fell 2,788 -> 655 MB,
  so the process holding the memory on db-3 died or was restarted. db-3 is the sync standby, lag 0:
  a failover is possible again.
- db-2 still down at 17:17, and missing from Patroni's member list.
- **The growth stops while the peers are down and resumes when they come back.** db-1's process
  memory fell 3,509 -> 2,963 MB while db-2 and db-3 were down (16:59-17:13), then rose
  2,974 -> 3,674 MB in 4 minutes after db-3 returned (about 175 MB/min); db-3's rose 655 -> 951 MB
  in 2 minutes. That points to work between the db nodes, most likely Garage replication or resync.
  db-1 had 2.3 GB available at 17:17: at that rate it could run out around 17:35-17:45.

## What is (and isn't) using the memory
| Measured (Prometheus, per db node)          | Growing?                                   |
|---------------------------------------------|--------------------------------------------|
| Anonymous (process) memory                  | **Yes**: ~50 MB/min from 15:27-15:47       |
| Shmem (Postgres shared_buffers)             | No (flat ~0.8-1.0 GB, frees on restart)    |
| Kernel slab, unreclaimable                  | No (60-97 MB)                              |
| etcd resident memory                        | No (80-119 MB)                             |
| node_exporter, postgres_exporter            | No (17-36 MB)                              |
| Postgres connections                        | Not related (db-2/db-3 grew with 3-9 connections; db-1's curve didn't bend when it went 17 -> 139) |

- **Not Postgres itself**: when Postgres restarted (db-2/db-3 at 16:26, db-1 about 17:01) its
  shared memory was freed but process memory kept growing.
- **Not etcd or the exporters** (flat).
- Remaining candidates, none of which Prometheus sees per process: **Garage** (most likely: it does
  the same work on every db node, since every object is stored on all three), **Patroni**,
  **pgBackRest**, or something else started around 15:30.
- The start at the same time on three nodes points to a cluster-wide trigger at 15:27-15:47: a
  change in object-store traffic (uploads, the 7-day recording deletes), a Garage operation, or a
  manual action. No commit in this repo today touches the db roles.

## Effects
- **Recordings and voicemail uploads**: failed while Garage had fewer than 2 of 3 nodes, and stayed in
  each pbx node's spool. They drained after the first dropout (no finished recording waiting at
  16:5x). With db-2 and db-3 down again, Garage has 1 of 3 nodes and uploads fail again; the files
  stay in the spool (nothing is deleted before its upload succeeds).
- **Database writes**: short outages at each failover (16:22, 16:25) and probably at db-1's Postgres
  restart (about 17:01): API errors, CDRs held in the ARI app's spool and inserted later.
  **Not checked yet**: the API error rate and support tickets for these windows.
- **Possible lost rows**: `synchronous_commit` has been off cluster-wide since 2026-11-25
  (`2026-11-25-db-commit-stalls.md`), so a commit is confirmed before any replica has it. The last
  commits on db-3 before 16:22:12 and on db-2 before 16:25:37 may be gone (CDRs, tickets, voicemail
  rows, payments). **Not checked yet.**
- **Replica lag**: 24-41 MB at the first check, then 45-70 MB (16:53-16:55), then 91-106 MB, still
  growing: replicas short of memory barely get to replay WAL. Consequences:
  - The read-only DB port (127.0.0.1:5433, Kamailio digest auth and DID lookups) uses only replicas
    less than 16 MB behind, so `pg_replicas` is empty on every node (`HAProxyBackendDown`, job
    dbproxy) and traffic falls back to `pg_any`, which checks only that a node is running. Some
    Kamailio queries read from a lagging replica: new SIP credentials or numbers may not be visible.
  - Patroni won't promote a replica more than 1 MB behind (`maximum_lag_on_failover`): **if db-1
    fails now, there is no failover**.

Recovered after the first dropout and checked at 16:5x: Garage `/health` "fully operational" on all
three, API `/ready` up on app-1 and app-2, both edge API probes passing, `pg_primary` healthy everywhere.

## Why the alerts didn't warn us
`MemoryLow` (< 10 % available `for: 10m`) never fired: at 50 MB/min a 4 GB node goes from 10 % to
stuck in about 8 minutes. The first sign was `NodeDown`. A trend alert would have given about an hour,
e.g. `predict_linear(node_memory_MemAvailable_bytes[30m], 3600) < 0`.

## Runbook for Muhammad (DB HA and monitoring)
Order matters: first keep db-1 (the only primary, no failover candidate) alive, then stop the
growth, then bring db-2 and db-3 back one at a time. Every step marked **change** is your call.

### 1. Where are we now (read-only, on db-1, about 2 min)
```
patronictl list                 # db-1 still Leader? replicas' state and lag
patronictl history | tail -3    # a timeline 9 = db-1's Postgres restart at ~17:01 was a failover
free -m                         # db-1's available memory now
garage status                   # which Garage nodes are connected
```
If db-1's available memory is under ~1 GB and still falling, go straight to step 3 for db-1: a
primary that thrashes takes the whole database down with no failover.

### 2. Name the process that grows (read-only, on db-1)
```
ps -eo pid,rss,etime,cmd --sort=-rss | head -15     # RSS in KB; run twice a minute apart
journalctl -u garage --since 15:15 --until 15:55 --no-pager | tail -100
garage worker list              # background workers: resync, scrub, block GC, lifecycle
garage stats
```
Also look for piles of `pgbackrest` processes (`pgrep -c pgbackrest`) and at Patroni's RSS.
What started at 15:27-15:47 on all three nodes at once is the trigger: compare with Garage's log
(a repair, scrub, resync or deletion burst), object-store traffic, and any manual action.

### 3. Stop the growth (**change**)
Depends on step 2:
- **Garage**: restart it on db-1 (`systemctl restart garage`). While db-2 and db-3 are down,
  Garage is already unavailable (1 of 3 nodes), so this costs no availability. If a background
  worker is the cause, pause or throttle it before the restart, or it comes back
  (`garage worker --help` for the v2 syntax: worker tranquility / count settings,
  `garage repair` to pause a scrub).
- **Patroni**: `systemctl restart patroni` on the **primary** also stops Postgres (a write outage
  and, with no healthy replica, no failover). Fix the replicas first (step 4), then
  `patronictl switchover` before restarting Patroni on db-1.
- **pgBackRest**: stuck `archive-push` processes can be killed; check `pgbackrest --stanza=pbx check`
  and `/var/log/pgbackrest/` for why they hang (mon-1's disk is 75.6 % full: the repository is there).
- **Anything else**: stop it if it is safe to; otherwise decide by what it is.
Then watch `free -m` on db-1 for 5 minutes: available memory should stop falling.

### 4. Bring back db-2 and db-3, one at a time (**change**)
They are probably stuck thrashing and won't answer SSH: reboot from the Clanode panel. Start with
**db-3** (the sync standby).
1. After boot, apply the step-3 fix there too if the cause starts with the node (for example a
   Garage worker setting), before the memory has time to run out (~40 min on 4 GB at 50 MB/min).
2. Wait until `patronictl list` shows it `streaming` with lag under 16 MB, and `garage status` shows
   it connected. Garage then copies the blocks it missed: watch its memory and IO while it does.
3. Only then do db-2.
Once one replica is caught up (lag under 1 MB), a failover is possible again.

### 5. Check that everything recovered (read-only)
- `patronictl list`: both replicas `streaming`, lag under 16 MB. Then `pg_replicas` has servers again
  and `HAProxyBackendDown` (job dbproxy) clears on every node.
- `garage status`: 3 nodes; `/health` "fully operational" on each.
- pbx nodes: `pbx_upload_backlog` and `pbx_cdr_backlog` back to 0 (the spooled recordings and CDRs
  from the outage upload and insert themselves).
- Memory on all three nodes flat for 30 minutes.

### 6. Afterwards
1. Lost rows: compare each old primary's last WAL position with the failover positions in
   `patronictl history` (timeline 6 ended at 70042385512, timeline 7 at 70072750112), and check
   grader tickets for missing calls, payments or tickets from 16:20-16:30 and about 17:01.
2. Decide whether `synchronous_commit` goes back on.
3. Monitoring: a memory trend alert (`predict_linear`, above) and per-process memory for Garage and
   Patroni.
4. Limit the damage next time: a `MemoryMax=` on the Garage unit (systemd) makes a leak kill Garage
   instead of freezing the node; and db-2/db-3 have half of db-1's memory (4 GB vs 8 GB).
5. Update this doc with the process found, the trigger and what fixed it.

## Evidence
- Patroni `/cluster` and `/history` from app-1; `/patroni` from each node.
- Prometheus on mon-1, 11:07-17:07 in 20-min steps and 16:10-17:04 in 2-min steps:
  `node_memory_{MemAvailable,Shmem,SUnreclaim,AnonPages}_bytes`, `node_vmstat_{pgmajfault,oom_kill}`,
  `node_pressure_{memory,io}_stalled_seconds_total`, `node_disk_{read,written}_bytes_total`,
  `node_cpu_seconds_total`, `process_resident_memory_bytes` by job, `pg_stat_activity_count`, `up`.
- Ruled out: CPU steal 0 and no clock offset jumps (not a platform pause), no network drops (not a
  partition), disk write latency 2-13 ms (not a disk stall).

## Unrelated, seen at the same time
- mon-1 root disk 75.6 % full (`DiskSpaceLow`, threshold 70 %).

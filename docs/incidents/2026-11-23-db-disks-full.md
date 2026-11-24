# 2026-11-23: db nodes' disks nearly full (call recordings)

## What happened
- ~23:45 UTC: db-1..3 root disks (32 GB, also holding Postgres) at 98 %, 630–870 MB free, filling
  at ~33 MB/min (measured on db-1). Projected full at ~00:08 UTC; Postgres would have stopped on
  all three nodes at nearly the same time.
- Cause: Garage held 27 GB per node (bucket `pbx-media`, 57.7 GiB logical, RF 3, ~2:1 compressed).
  Almost all of it were call recordings (16-bit 8 kHz WAV, ~25 MB per audio-hour per node on
  disk). The Monday peak produced ~2,000 recordings/h (14,631 that day, 10–20x earlier days).
  Nothing deleted recordings; the only cleanup was orphaned voicemail audio.

## What we did
1. `apt-get clean` + journal vacuum on the db nodes (~250 MB each).
2. Deleted recordings older than 7 days (1,650; rows then objects, from app-1 with the API's env).
   Garage freed the space ~10 min later (block GC delay).
3. Attached a 250 GB Volume per db node: ext4, fstab by UUID with `nofail`, mounted at
   `/var/lib/garage/data2`. garage.toml `data_dir` = old dir `read_only` + Volume (240G); Garage
   restarted one node at a time, waiting until every node saw the others healthy again.
   No copy of the old 27 GB was needed. Ansible: `garage_volume_data_dir` (production.ini
   `[db:vars]`), template + mount check in role `objectstore`.
4. API scheduler deletes recordings 7 days + 1 h old (`maintenance.ts` `cleanupOldRecordings`).

## Sizing
7 days at the 11-23 rate is ~130–170 GB per node; 250 GB leaves room for roughly 2x growth.
Volumes can be grown later (then raise `garage_volume_capacity`).

## Still open
- Disk-usage alert (> 70 %) did not exist / fire (CLAUDE.md §16 lists it).
- `garage repair -a --yes rebalance` off-peak moves the old blocks off the root disks.
- Recording as Opus/MP3 instead of WAV would cut storage 4–7x.
- Never remove the Volume entry from `data_dir`: Garage would no longer see the blocks on it.

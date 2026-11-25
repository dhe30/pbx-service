# 2026-11-25: platform disk stalls freeze logging processes on the call path

## What happened (UTC)
15:26-15:29 the grader counted REGISTER 714/min, phone_in 275/min, inbound 217/min, us 274/min
failures for our group only.

- media-4: `/proc/pressure/io` full 48-98 % from 15:25:30 to 15:27:30. Its journal has NO entries
  from 15:24:43 to 15:26:20, then 14,060 rtpengine lines at once. Prometheus: media-4's node
  exporter kept answering, its rtpengine scrape failed for ~75 s. rtpengine did not restart.
- Both edges: 15:25:06 rtpengine "timeout waiting reply" from 10.0.1.142 (media-4), then ~900
  "no available proxies" and ~270 "Unknown call-id".
- edge-2: io full 40-70 % at 15:26-15:27; its journal stalled 15:26:20-15:27:10 (2-4 lines per 10 s
  instead of ~150, then 1,205 at once); 480 "no pbx node" at 15:27.

The same stalls hit db-1 (Postgres commits 20-120 s, docs/incidents/2026-11-25-db-commit-stalls.md).
Our write volume was the same as on 11-24; only the storage latency changed. media-4 writes
almost nothing but logs. So the trigger is the platform's storage, not our load.

## Why a disk stall stops a process that barely uses the disk
journald writes the journal to disk. When the disk freezes, journald blocks, stops reading
/dev/log and the services' stdout streams, and their buffers fill. Then every process that logs
blocks inside syslog()/write(): rtpengine logs ~600 lines/s at log-level 6, so it stopped within
milliseconds and answered no ng commands. Kamailio's SIP workers block on xlog the same way.

## Change
roles/logging: journald `Storage=volatile` (RAM, RuntimeMaxUse 100M on edges, 800M on media nodes)
on the `edge` and `media` groups; every other group keeps the persistent journal.
Trade-off: those nodes' logs are lost on reboot (the old on-disk journal stays readable).

Not changed: rtpengine log-level. `pbx-call-audio` needs its level-6 "Final packet stats" lines,
which come from the same `core` subsystem as the noisy "Kernelizing media stream" lines.

## Still open
- sipdump on the edges writes ~1 MB/s of pcaps from its own process; during a stall its queue
  grows in shared memory (512 MB, max_used 273 MB). Not on the workers' path, but watch shm.
- Asterisk logs to files in /var/log/asterisk and the ARI app to the journal on pbx nodes (persistent).

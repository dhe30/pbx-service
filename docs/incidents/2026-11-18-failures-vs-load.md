# 2026-11-18: do failures grow with load because of our capacity?

**Question.** The course dashboard showed failures rising with traffic. The suspicion was that
our capacity is lower than we think and one node is a hidden bottleneck, or that a bug hits calls
in proportion to load.

**Answer.** Our capacity didn't limit calls at the 2026-11-17 peak. The share of failing legs did
not follow our load: it tripled at 15:30 while our CPUs got less busy. SIP shows no refusals from
us. The known main cause is phones answering after our 5 s no-reply timer
([2026-11-18-silent-legs-by-codec.md](2026-11-18-silent-legs-by-codec.md), fix PR #104). Three
smaller findings are below: both edges rebooted at the moment the failure rate jumped, the edges'
internal SIP socket drops some packets, and calls are spread unevenly across the pbx nodes.
Times are UTC. VM clocks appear to be UTC too (the sipdump file names match UTC).

Data was collected on 2026-11-18 between 13:00 and 15:00. The peak's SIP captures had already
expired (24 h retention), so the SIP-level numbers below are off-peak. Every command used is
read-only (§7).

## 1. Failure share against load (Prometheus, `load-shape.py`)

15-minute buckets, 2026-11-17 14:00 to 2026-11-18 14:00. "Silent" = `no_media` + `silent_from_party`
+ `silent_to_party` as a share of all `pbx_call_audio_legs_total{test="false"}`.

| Window (11-17) | calls/min | silent | `no_answer` | `failed` | busiest media CPU | pbx-2 load1 |
|---|---|---|---|---|---|---|
| 14:00-15:15 | 82-113 | 2.4-5.2 % | 12.9-18.1 % | <= 0.3 % | 71.6-73.8 % | 7.3-23.2 |
| 15:30-17:15 | 86-114 | **9.3-13.7 %** | **21.6-29.2 %** | <= 0.7 % | 49.5-60.8 % | 2.0-2.9 |
| 17:30 onward | 4-18 | 0-2 % | 0-17 % | ~0 (one bucket 3.3 %) | 12-39 % | ~1 |

- At 15:30 the call rate stayed flat and our load fell: media CPU went from ~73 % to ~55 %, and
  pbx-2 dropped from 115-155 to 58-78 calls when it was capped at 100. Silent legs and `no_answer`
  went UP anyway. A capacity limit would do the opposite.
- `failed` (our call app's own failures) stayed under 1 % throughout.
- The silent-legs incident counts customer legs by hour (13:00 1.4 % ... 16:00 7.9 %), a different
  denominator, and also shows the rise.

## 2. SIP: no refusals from us

- **Final replies** (`sip-codes.py`, newest 3 hourly sipdump files, 11-18 ~11:55-14:55, off-peak):
  edge-1 19,679 and edge-2 22,152 INVITE final replies. 0 were 5xx or 408, 1 was 480. The rest:
  200; 401/407 (authentication challenges); 487 (cancelled branches: losing simultaneous-ring legs,
  ring timeouts); 486; 403 (international calls from accounts without the add-on); 603 (6 in all).
- **pbx failover** (Kamailio journal, last 24 h): edge-1 logged 6 `pbx ... failed (500|503|408)`,
  edge-2 0. "no pbx node available": 0 on both. The node-marking amplifier in
  `failure_route[PBX_FAILOVER]` (`ds_mark_dst("ip")` on 503) did not fire in bursts. The edges
  rebooted at 15:33/15:37 (§4), so this only covers the peak if the journal is persistent.
- **Asterisk's call limit** counts calls, not channels: pbx-2 showed 36 channels, 18 calls
  (`core show channels count`). `grep "Maximum call limit"` in the journal found 0 on pbx-1/2.
  Not conclusive: Asterisk may log only to its own files. pbx-3 was not checked (no SSH host key yet).

## 3. Uneven pbx load (account hash)

Peak calls per node, 14:00-17:15: pbx-1 26-43, pbx-2 58-155, pbx-3 57-114. pbx-1 carried by far
the most calls in total (`calls processed` 13,787 against pbx-2's 2,464 since their last restarts),
but few at once at the peak. Dispatcher algorithm 7 hashes on the account (B5, kept so attended
transfer stays on one Asterisk), so the large accounts' peak calls land on pbx-2 and pbx-3 and pbx-1
sits idle. No failures traced to it now that pbx-2 is capped, but the capacity added by a third node
is mostly unused at the peak. This is the open item for the scaling analysis (README §3.5
"Affinity vs. balance").

## 4. Both edges rebooted when the failure share jumped

`uptime -s`: edge-1 up since 2026-11-17 15:33:52, edge-2 since 15:37:27. That is the 15:30 bucket
where silent legs tripled. A reboot drops the calls whose media that edge anchors and makes the
restarted edge pull every registration from its peer (DMQ full sync). That explains a short spike,
not two hours. What else changed at that reboot (resize, media-3, rtpengine set switch, config) is
not recorded in the repo. **Open:** ask whoever rebooted them (media-3 and the pbx-2 cap went live
"during the morning peak", commit 9201e3e).

## 5. Packet loss on our INVITEs to phones (`invite-delay.py`, off-peak)

For each INVITE an edge sent to the internet: the time to the first reply from that host and the
number of copies sent by then (sipdump records Kamailio's resends). 11-18 ~12:54-14:50.

| | UDP INVITEs | first reply < 100 ms | needed a resend | answered after the resend |
|---|---|---|---|---|
| edge-1 | 764 | 752 | 12 (1.6 %) | 0.45-0.6 s: 9, 0.1-0.45 s: 1, 0.6-1.4 s: 1, 1.4-1.6 s (3 copies): 1 |
| edge-2 | 565 | 557 | 8 (1.4 %) | 0.45-0.6 s: 7, 0.1-0.45 s: 1 |
| edge-2 TLS | 170 | 170 | - | - |

Per host: `.142` (vendors) 1.2 %; `.144` 3.2-3.6 %; `.25` 4.2 %; `.125` 1.2-5.3 %; `.68`, `.163`,
`.128`, `.56`, `.183` 0 %. No reply took over 1.6 s, so off-peak, phones are fast. A lost first
copy (or its reply) costs ~0.5 s of post-dial delay, not the call.
**Open:** the peak. The silent-legs incident found phones replying after up to 7.4 s at the peak.
That is close to the 4th UDP resend (0.5 + 1 + 2 + 4 = 7.5 s). Clusters at 3.5/7.5 s with more than
one copy would mean lost packets, not slow phones.

## 6. Host network: conntrack fine, edge port 5070 drops

- **conntrack:** edges 2,185 and 2,319 of 65,536 entries; media nodes 207-261 of 262,144; 0
  "table full" in 48 h of kernel log.
- **UDP receive-buffer drops** (`nstat -az UdpRcvbufErrors`, since the 11-17 reboots): edge-1
  1,396, edge-2 1,661; media-1/2/3 0. Per socket (`ss -uamnp`): the drops still attributable to
  open sockets are all on Kamailio's internal socket `<private IP>:5070` (edge-1 585, edge-2 770).
  The rest happened on sockets since closed. That socket carries SIP from the pbx nodes, relays
  from the peer edge, and DMQ (~195,000 replies per edge per 3 h). Its buffer is at the kernel
  cap: `net.core.rmem_max` = 212,992 (`rb425984`). PR #100 raised this on the pbx nodes only.
- Size: roughly 0.05 % of that socket's traffic. Asterisk (100 ms) and DMQ resend, so a drop
  mostly costs delay. Not the cause of a 10 % silent rate. The DMQ full syncs after the two
  reboots are a likely burst source; the counter has no timestamps.
- 0 new drops on either edge between the first reading and 14:49 (off-peak). The baseline for
  `nstat UdpRcvbufErrors` (delta mode) was set at 14:49.
- **README §3.3 #1** ("kernel drop counters stayed at 0", measured 2026-11-15) is out of date
  for the edges.

## Proposed changes (not made yet)

- Edge UDP buffers: `net.core.rmem_max`/`rmem_default` ~4 MB in the kamailio role (as PR #100 for
  Asterisk) and Kamailio's core `maxbuffer` raised to match (name and default to be checked in the
  Kamailio 6.0 core docs when this is made, with a verify-backlog row). Takes effect on restart; edges one at a time.
- pbx balance: decide between keeping account affinity (transfers) and spreading large accounts,
  e.g. weights per node or hashing with more buckets than nodes. Needs a design note.

## 7. Tools

All read-only, usage in each file header (`loadtest/diag/`, via `remote.sh`):
- `load-shape.py` on mon-1: per bucket calls/min, % per outcome, audio verdicts, peak calls per
  pbx node, busiest CPU and load.
- `sip-codes.py` on an edge: final replies by method and code from the newest sipdump files.
- `invite-delay.py` on an edge: first-reply delay and resends of our INVITEs to the internet.
- Kernel/conntrack check:
  `cat /proc/sys/net/netfilter/nf_conntrack_{count,max}; nstat -az UdpRcvbufErrors; ss -uamnp | tail -n +2 | paste - - | grep -E ",d[1-9]"`

## At the next peak (~14:00-17:00 UTC)

1. `invite-delay.py` on both edges with the newest file (`1`): do late replies cluster at the
   resend times? (§5)
2. `nstat UdpRcvbufErrors` on both edges before and after: do the 5070 drops grow with load? (§6)
3. `python3 loadtest/diag/silent-legs.py <10 min>` from the silent-legs incident: "late answer"
   should be near 0 if PR #104 runs. Check that Kamailio restarted after
   `/etc/kamailio/kamailio.cfg` changed (`systemctl show kamailio -p ActiveEnterTimestamp`).
4. `load-shape.py 6 15` afterwards: silent share against calls/min with the fixes in place.

# 2026-11-15: why our SIP and API p99 are the worst on the leaderboard

**Question.** On the course leaderboard (24 h to ~05:20 UTC on 2026-11-15) our SIP p99 was
736 ms, the worst of the active providers, and our API p99 was 3.5 s, while two groups were under
2 s. Earlier fixes (PR #39, NET-1 in the README) had barely moved either number. Is this just the
platform's network, or is there something in our system we can fix, and can we prove which?

**Answer.**
- **SIP:** not our processing, and not edge-1's capacity. We answer every REGISTER in under 5 ms
  (p99 4.5 ms). But since the large customer arrived, **~4.3% of our replies to the course's phone
  simulator at 130.245.136.125 are lost after they leave edge-1**, so the phone resends after SIP's
  500 ms timer. Replies to the other course hosts are lost 0.1–0.7% of the time in the same hours,
  through the same socket. This is outside our VMs; we can only report it.
- **API:** the API itself is fast (p99 0.15 s). Most of its requests over 1 s were the three DIDWW
  reference-list routes, which called the course's DID provider on every request. **Fixed in PR #63**
  (cache). The rest of the course's API tail happens before requests reach our edge.
- **Resizing edge-1** (1 → 2 vCPU) was considered and **not done**: no measurement showed it as a
  bottleneck, and with one public IP it would have caused an outage.

Times are UTC. Scripts are in `loadtest/diag/` (PR #63); each experiment says how it was run.

## 1. What the course data says

The leaderboard's raw histograms (`/api/leaderboard?range=day`, same data as its charts) give each
provider's transaction counts per latency bucket:

| Provider | SIP transactions (24 h) | Share > 300 ms | SIP p99 |
|---|---|---|---|
| bat | 544,866 | 1.29% | 534 ms |
| group-3 | 298,400 | 1.96% | 632 ms |
| claudey-meatballs | 183,356 | 2.17% | 639 ms |
| **group-4 (us)** | **38,628** | **7.49%** | **736 ms** |

Our tail is almost all one bucket: **2,644 transactions in 500–750 ms** but only 6 in 300–500 ms.
Nothing was "a bit slow". A first attempt went unanswered and the client's resend (SIP over UDP
resends after 500 ms, then 1 s, 2 s) was answered at once. The next buckets fit the same ladder:
211 at 1–2 s (second resend at 1.5 s), 26 at 2–5 s (third at 3.5 s).

| Provider | API requests (24 h) | Over 1 s | API p99 |
|---|---|---|---|
| bat | 731 | 13 (1.8%) | 1.8 s |
| claudey-meatballs | 915 | 18 (2.0%) | 1.9 s |
| cattle-not-pets (no customers) | 721 | 39 (5.4%) | 4.0 s |
| **group-4 (us)** | **1,037** | **31 (3.0%)** | **3.5 s** |

With ~1,000 requests, p99 is decided by about 10 requests. Ours sit in two clusters: 17 at 1.5–2 s
and 14 at 3–5 s. Every provider has both clusters, **including cattle-not-pets, which has no
customers**.

The Course Services tab breaks SIP p95 down by type (5-minute windows):

| | Before 02:00 | 02:00–05:25 (after the large customer signed up at 01:56) |
|---|---|---|
| REGISTER | 10–50 ms | **537–678 ms in every window** |
| INVITE → first response | 10–50 ms | 10–48 ms |
| re-INVITE (session refresh) → final | 19–40 ms | 100–660 ms |
| BYE → final | ~9 ms | ~10 ms, one spike to 625 ms (04:00) |

So the SIP tail is REGISTERs, and it started with the large customer (98 extensions, ~200 phones).
Since then about 95% of our transactions have been REGISTERs: that customer's phones re-register
constantly and we have few calls (541 in 24 h against bat's 13,800).

## 2. Experiment 1: is edge-1 dropping packets? (hypothesis refuted)

**Hypothesis.** The large customer's phones all registered within 6 s (8:56:13–8:56:19 PM ET in
the bank log), so they would re-register in synchronized waves. A wave could overflow Kamailio's
UDP receive buffer on edge-1, which is 1 vCPU, carries all public SIP and HTTPS, and has no buffer
tuning (`rmem_max`, `maxbuffer` and `netdev_max_backlog` are untouched in the repo).

**Method.** Kernel drop counters read twice a few minutes apart, and SIP packets per second for
120 s, on edge-1:

```
nstat -az UdpRcvbufErrors UdpInErrors TcpExtListenDrops; cat /proc/net/softnet_stat
timeout 120 tcpdump -lni ens3 -tt "udp dst port 5060" | cut -d. -f1 | uniq -c | sort -rn | head
```

**Result.**
- `UdpRcvbufErrors` 0 and `UdpInErrors` 0.
- softnet_stat: dropped 0; time_squeeze unchanged (0x3b) while 68,856 packets were processed.
- The busiest second had 28 SIP packets. There are no waves.

**Conclusion.** Edge-1 drops nothing and has no bursts. A bigger buffer or a bigger VM would not
change the REGISTER tail.

## 3. Experiment 2: which side loses the REGISTERs?

**Method.** `loadtest/diag/sip-retransmits.py` reads a capture of edge-1's public SIP socket. It
pairs every request from outside with our replies (Call-ID, CSeq, top Via branch, source IP) and
classifies each request the client sent twice:

- **answered-then-resent:** we replied to the first copy and the client still resent. Our reply
  was lost after leaving us, or ignored.
- **resent-before-answer:** we hadn't replied when the resend arrived. Kamailio ignored or
  delayed the first copy.
- **never-answered:** no reply from us at all.

It also checks reply size (fragmentation), the reply's destination `ip:port`, and whether resends
depend on how fast we replied. Data: a new 10-minute capture plus the existing ring buffer on
edge-1 (`/var/tmp/sipcap`, 2026-11-14 18:35 to 2026-11-15 05:56).

```
loadtest/diag/remote.sh edge-1 py loadtest/diag/sip-retransmits.py /var/tmp/sipcap/sip.pcap0 ... sip.pcap4
```

**Result (all files together).**

| | REGISTER | INVITE | BYE |
|---|---|---|---|
| Transactions from outside | 73,492 | 4,546 | 1,047 |
| Resent by the client | 3,082 (4.2%) | 7 (0.2%) | 8 (0.8%) |
| … of which we had already answered | **3,080** | 7 | 8 |
| Our first reply: p50 / p95 / p99 | 1.7 / 3.1 / 4.5 ms | 2.3 / 5.6 / 8.9 ms | 3.9 / 5.2 / 12.3 ms |

- All 76,747 REGISTER replies fit in one packet (401: 586 B, 200: 495 B). Every reply went to the
  `ip:port` the request came from.
- Our reply delay has the same distribution for resent and non-resent REGISTERs (≤0.5 ms: 48% vs
  47%; ≤5 ms: 46% vs 47%). The client is not dropping replies that arrive "too fast".
- Resends are spread over 1,209 ten-second windows, at most 10 in any one. This is steady random
  loss, not bursts.

**By source and over time.** One file of the ring buffer is about an hour:

| File (start) | REGISTER resent | from 130.245.136.125 | from 130.245.136.144 |
|---|---|---|---|
| 11-14 18:35 (before the large customer) | 0.9% of 2,193 | not present | 0.6% of 3,830 |
| 11-15 01:56 | 4.0% of 19,776 | **4.0%** of 19,713 | 0.5% of 573 |
| 03:02 | 4.3% of 19,715 | **4.3%** of 19,713 | 0.7% of 601 |
| 04:09 | 4.4% of 19,953 | **4.4%** of 19,939 | 0.7% of 562 |
| 05:16 | 4.5% of 12,229 | **4.5%** of 12,306 | 1.6% of 316 |

The carrier (130.245.136.142) had 1 resend in 881 transactions (0.1%).

**Conclusion.** Our part of every REGISTER takes under 5 ms. About 4.3% of our replies to the
course's phone simulator for the large customer (130.245.136.125, port 30070) never arrive, or
are discarded there. Replies to other course hosts in the same hours, from the same socket and
through the same NAT, are lost about 6× less often. The loss is on the path to that host or in the
host, outside our VMs. Our transactions are ~95% REGISTERs to that host, so it dominates our p99.
Providers with more call traffic dilute it.

**Correction.** `2026-11-15-g723-dtmf-answer.md` ("Also checked") put this at ~1% and blamed lost
packets on the client → edge path. Pairing each request with our replies shows the opposite
direction: the requests reach us, and our replies are what get lost. The ~1% figure was per whole
registration and from a shorter capture.

## 4. Experiment 3: where do slow API requests spend their time?

**Method.** Three views of the same 24 h, outermost first:
1. The course's histogram: what its client saw, including connection setup.
2. Edge-1's HAProxy log (`loadtest/diag/haproxy-slow.py`). Each request's time split into receive
   (TR), queue (Tw), connect to the app node (Tc), API response (Tr) and total (Ta). Ta starts once
   the TCP and TLS handshake is done.
3. The API's own histogram in Prometheus (`loadtest/diag/api-routes.sh`).

**Results.**

| View | Requests | p50 | p99 | Over 1 s |
|---|---|---|---|---|
| Course client | 1,037 | ~100 ms | 3.5 s | 31 (17 at 1.5–2 s, 14 at 3–5 s) |
| HAProxy on edge-1 (health checks excluded) | 60,834 | 6 ms | 217 ms | 56; max 2.9 s |
| API (Prometheus) | ~62,000 | 3 ms | 151 ms | 35 |

The API's 35 requests over 1 s, by route:

| Route | Over 1 s |
|---|---|
| GET /numbers/regions | 15 |
| GET /numbers/countries | 6 |
| GET /numbers/cities | 4 |
| GET /me | 4 |
| six other routes | 1 each |

The DIDWW routes take **~1.05 s** each time (HAProxy Tr 1,050–1,070 ms). They called the course's
DID provider on every request, and a new connection to it losing its first SYN costs the kernel's
1 s resend.

- **HAProxy's Tr histogram has a sharp spike:** 1,261 requests (2%) at 190–250 ms, against 12 at
  150–190 ms and 59 at 250–300 ms. That is TCP recovering one lost packet (minimum
  retransmission/loss-probe timer ~200 ms), not slow code.
- **Every private hop loses about 0.5% of TCP segments.** Per-peer retransmissions (`ss -ti`, 60 s
  of `nstat`):
  - edge-1: 28 of 5,775 segments (0.48%); to the db-2 replica 0.54%, app-2 0.48%.
  - app-2: to db-1 0.59%, mon-1 0.6–0.85%.

  This costs ~200 ms per hit but doesn't reach the >1 s tail.
- **The course's 3–5 s cluster never reaches HAProxy:** our slowest request there took 2.9 s. Those
  requests lost their time in connection setup or on the course's side. Every provider has the
  cluster, including one with no customers.
- **The listen queues aren't dropping connections now.** `TcpExtListenOverflows` 1,411 and
  `ListenDrops` 1,596 since boot (2026-11-11) didn't move during the session. `TCPSynRetrans` grew
  by 1 in 30 s.
- **Most traffic is the course's probe.** 55,758 of the 60,834 requests came from 130.245.136.85.
  The course's chart counts only ~1,000 requests a day for us, and we can't tell which ones, so the
  cache's effect on its p99 has to be measured after deploying.

**Conclusion.** One cause is ours and fixable: uncached DIDWW lookups, 25 of the API's 35 requests
over 1 s. The rest is packet loss on the platform network, the same ~0.5% everywhere, plus the
course-side cluster that every provider shows.

## 5. Changes and decisions

| What | Status |
|---|---|
| Cache DIDWW countries / regions / cities in the API. Per process: one shared load per key; after 1 h the cached list is returned at once and refreshed in the background; failures never cached; at most 500 keys | PR #63 (tests: `lookup-cache.test.ts`, `didww.test.ts`) |
| Diagnostic scripts used above: `sip-retransmits.py`, `haproxy-slow.py`, `api-routes.sh`, `remote.sh` | PR #63 |
| Report the lost replies to 130.245.136.125 to the course staff, with the per-host table from §3 | To do |
| Resize edge-1 to 2 vCPU / 4 GB | Not done (see below) |
| Bigger UDP buffers, randomized registration expiry | Not done: experiment 1 shows no drops or bursts |

**Why edge-1 wasn't resized.** Both SRV records (`sip1`) and the A record point at edge-1 (TTL
600 s). A resize powers the VM off for several minutes, which would stop all phone registrations,
the API and the website, and drop calls whose audio runs through edge-1. Nothing measured above
blames edge-1's CPU, so it would cost an outage for no gain on these metrics. If it is done later
(e.g. for transcoding capacity):
1. Move the A and `sip1` records to edge-2 on the Group tab and wait ≥ 15 min.
2. On edge-2, stop new calls using edge-1's rtpengine: `kamcmd rtpengine.enable udp:10.0.1.13:2223 0`.
3. Resize, using edge-2 as the SSH jump host meanwhile.
4. Re-run the playbook for edge-1 (`rtpengine_threads` follows the vCPU count at deploy time).
5. Re-enable edge-1's rtpengine, then move DNS back.

Step 1 is also an A/B test: if REGISTER p95 stays ~600 ms on edge-2, the cause is not edge-1.

## 6. After deploying PR #63

- `haproxy-slow.py` on both edges: `/numbers/regions`, `/countries` and `/cities` should have no
  requests over 1 s, except at most one per key and app node before the cache is warm.
- `api-routes.sh`: the API's count over 1 s should drop from ~35 to ~10 a day.
- The course's API p99. It may not move much: the 3–5 s cluster is outside our system.
- Re-run `sip-retransmits.py` on a fresh capture once the course has answered, to see whether the
  per-host loss changes.

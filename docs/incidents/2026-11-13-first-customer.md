# 2026-11-13: the first market customer (Golden Pharmacy) left after 3 hours

The first simulated customer to sign up after the repricing (PR #35) left the same evening with
"dissatisfaction 19.3". This page records what the course dashboard, Prometheus and the database
showed, what we concluded, what was fixed, and what is still open. All times are US Eastern unless
marked UTC (the customer's evening was 2026-11-14 00:00–03:00 UTC).

Sources:
- **Course dashboard**, Course Services tab: customer events, the Customers charts, the bank and
  vendor activity logs; Leaderboard tab (day view, read at 10:47 PM).
- **Prometheus** on mon-1 (through Grafana's data source proxy): `pbx_calls_total`,
  `pbx_vendor_legs_total`, `pbx_active_calls`, `pbx_api_http_request_duration_seconds`,
  `rtpengine_*`, `asterisk_*`.
- **Postgres** (`cdrs`, `support_tickets`, `blocked_numbers`) for the customer's account.
- **Logs** on edge-1/edge-2: rtpengine had nothing for the evening (log level 5, see F6).

## Timeline

| Time | Event | Source |
|---|---|---|
| 7:04:00–7:04:05 PM | Signed up: "small", 5 extensions, 1 number. Charged plan $7.54 + 4 extra extension slots × $7.54 + local number +14153072040 $2.22, all prorated to the period end; each charge less 2.9% + $0.30 | Customer events, bank log |
| 7:06 PM | First call (extension 105 → a US number) | CDRs |
| 7:06–9:57 PM | 56 CDR rows: 8 answered incoming calls to the number (all routed to extension 101), 2 blocked calls (4 rows, F2), 8 extension → extension, 12 `*98`, 12 direct calls to US numbers, 12 legs to extensions' external numbers. At most 4 calls at once | CDRs, `pbx_active_calls` |
| 7:30–10 PM | Course failures chart: repeated spikes for **Extension → US** (above the chart's 0.1/min top) and one for **Extension → extension**; none for PSTN → numbers | Customers charts |
| 9:56:42 PM | Left: "experience (dissatisfaction 19.3)" | Customer events |
| 9:56–9:57 PM | The last 4 calls (38 vendor minutes) end; active calls drop to 0 | Vendor log, `pbx_active_calls` |

The customer opened **no support tickets**. (Prometheus counted 2 tickets opened and closed in
the window; they belong to another account.)

## How we compared with the other providers (leaderboard, last 24 h)

| Provider | Customers | Calls | Success | SIP p99 | API p99 |
|---|---|---|---|---|---|
| bat | 2 | 26.8k | 88.16% | 581 ms | 1.4 s |
| claudey-meatballs | 12 | 6.6k | 77.70% | 590 ms | 1.1 s |
| **group-4 (us)** | 0 (after leaving) | 57 | 85.07% | 717 ms | **3.6 s** |

Our success rate is in the middle, but on 57 calls. API latency is our clear outlier.

## Findings

| # | Finding | Evidence | Status |
|---|---|---|---|
| F1 | **The caller's own number was rung.** At 8:09 PM +16315550728 called the shop; the number routes to extension 101, whose external numbers include +16315550728, so we rang the caller back. That leg "answered" after 1.1 s and the call was connected to itself for 1,863 s (31 min). Again at 9:01 PM (40 s) | CDRs (incoming row from 0728 + child outgoing leg to 0728, same talk time); US vendor log "1 call, 31 min (ended 01:40 UTC)" | **Fixed** in PR #38: external numbers equal to the PSTN caller are skipped (extensions and ring groups) |
| F2 | **Every blocked call was recorded twice.** +16315550772 is on the customer's blocklist; its calls were correctly rejected (403), but each produced two identical CDRs in the same second on the same pbx node, most likely the carrier retrying the DID's other trunk after the 403 | CDRs 8:15:22 ×2 and 9:56:14 ×2; `pbx_blocked_calls_total` +4 for 2 calls | **Fixed** in PR #38: a repeat of the same caller → DID within 10 s is rejected without a second CDR |
| F3 | **`*98` calls had no answer time.** All 12 were stored `answered` with `answered_at` null, because `ensureAnswered()` only set it for incoming calls | CDRs | **Fixed** in PR #38 |
| F4 | **Extensions with external numbers were always answered by the external number.** On every call to 101, 102 and 103 (8 incoming, 4 internal) the external number answered, never the desk phone. External numbers answered after 0.6–4.3 s; desk phones of 104/105 (no external numbers) answered internal calls after 3.2–7.1 s. 101's desk phone lost all 8 incoming calls, including 3 where the external number took 2.7–4.3 s, while it was clearly registered (it placed calls and dialed `*98`) | CDR ring times (`answered_at − started_at`) | **Open.** "First answer wins" is the spec, so a faster mobile is fine; but a desk phone that never wins suggests it may not have rung on forked carrier calls (e.g. a Path relay to the other edge). PR #38 added Kamailio fork logging to answer this; a forking test is still to run |
| F5 | **Failed legs the course counted but we did not.** Our ARI app logged 0 failed calls (incoming 8 answered + 2 blocked, internal 20 answered = 8 calls + 12 `*98`, outgoing 24 answered = 12 direct + 12 external-number legs, 24 US vendor legs). The course's "failed, silent or misrouted" series shows Extension → US and Extension → extension failures, so these were legs that connected but were silent or reached the wrong party | `pbx_calls_total`, `pbx_vendor_legs_total` (5 h); course failures chart | **Open.** F1 (call to itself) and F4 (external number instead of the desk phone) are candidates for "misrouted" |
| F6 | **Possible silent legs; no logs to check.** rtpengine counted 5 zero-packet streams (3 on edge-1, 2 on edge-2). Its transcoders that evening ran G723/G729/PCMA/opus → PCMU and PCMU → G723/opus, but never **PCMU → G729** or **PCMU → PCMA**, which a phone supporting only G.729 or only PCMA needs to hear anything. All five codecs are installed with encode + decode (`rtpengine --codecs`, rechecked). rtpengine logged nothing per call at log level 5 | `rtpengine_zero_packet_streams_total`, `rtpengine_transcoders` (max over 6 h, by chain) | **Open.** PR #38 raised rtpengine to log level 6 (codecs + final packet stats per call). Next: SIPp call to a G.729-only and a PCMA-only phone |
| F7 | **API latency, our worst metric (p99 3.6 s, client-side).** The time is spent in the network, not in the API: (1) **Server side is fast:** over the customer's evening the API served 3,182 customer requests (health checks excluded) with a p99 of **0.19 s**; only 2 took over 0.5 s and 1 over 1 s. (2) **Client side has a 1 s step:** the course's API histogram for us has ~50 of ~600 requests between 1 and 10 s, clustered at ~1.2–1.5 s and smaller groups near 2, 3 and 5 s, i.e. normal time plus the kernel's TCP SYN retransmit (1 s, then 2 s more). (3) **Where SYNs are lost:** edge → app node (47 of 6,021 requests over 6 h had HAProxy connect time ~1 s with a few ms of API time; edge-1 counted 125k SYN retransmits), and also client → edge: of 300 fresh HTTPS requests sent from a laptop on 2026-11-14, 3 took ~1.05 s, one in the TCP connect to the edge and two in the server phase (edge → app), each exactly +1 s. The slow Stripe-bound routes (`POST /billing/card`, `POST /businesses`) are real but were 2–3 requests: their per-route "p99" (4.9 s, 2.4 s) came from 1–2 samples and does not move the overall p99 | HAProxy logs (PR #39); `pbx_api_http_request_duration_seconds` (customer routes, 00:00–03:00 UTC); course API tail-latency chart; curl timing (`time_connect` / `time_appconnect` / `time_starttransfer`) | edge → app: **fix merged** in PR #39 (250 ms connect timeout + retry, connection reuse); the 2026-11-14 test still saw two +1 s server phases, so check it is deployed. client → edge: **open** (no change yet; find where SYNs are dropped). Stripe-bound routes: minor |
| F8 | **SIP response time above the others** (p99 717 ms vs ~585 ms). The course's p95 chart shows REGISTER spikes of 2–3 s and re-INVITE → final up to ~1 s | Course SIP charts | **Open**; the new Kamailio logging should show where REGISTERs wait |

## Ruled out

- **Leaked calls:** the long vendor calls (31 min; 4 calls / 38 min) match our own active-call
  counts minute by minute, and every counter (ARI active calls, Asterisk channels and bridges,
  rtpengine sessions) was 0 afterwards. The 38 minutes ended when the customer left.
- **Overcharging:** every purchase charge matches the published prices prorated to the period
  end (e.g. plan: $8.50 × 6.21 of 7 days = $7.54). Every call's `charge` is $0.00: all US calls
  were within the 500 included minutes.
- **Outages, vendor funds:** 0 outage minutes; every vendor balance stayed positive.
- **Wrong blocking:** the blocked number is on the customer's own blocklist (added at signup).

## Changes made because of this

| PR | Change |
|---|---|
| #37 | OpenAPI contract: the extension-limit error names `POST /billing/items {"kind":"extension"}` (the plan now includes 1 extension and this customer bought 4 slots); unknown fields ignored; Stripe-style Idempotency-Keys; signup chain spelled out |
| #38 | F1, F2, F3 fixed; Kamailio `devices:` fork logging; rtpengine log level 6 |
| #39 | F7, edge → app part: HAProxy connect timeout 250 ms + connection reuse to the app nodes |

## Still to do

1. **Forking test (F4):** a desk phone registered on each edge in turn, with an incoming carrier
   call to an extension that also has an external number. Check with the `devices:` log lines that
   the desk phone rings and can win.
2. **Codec test (F6):** SIPp phones that support only G.729 and only PCMA, with RTP both ways;
   check the rtpengine final packet stats for both directions.
3. **SYN loss (F7):** confirm PR #39 is live on both edges (`grep 'timeout connect' /etc/haproxy/haproxy.cfg`),
   then look for where SYNs are dropped on the public path (`nstat -az | grep -iE 'SynRetrans|ListenDrops|ListenOverflows'`
   on the edges and app nodes; HAProxy `Tc`/`Tr` per request). Re-measure with the curl timing loop.
   Minor: `POST /businesses` and `POST /billing/card` wait on Stripe round trips.
4. **REGISTER latency (F8)** from the new Kamailio logs.
5. After the next customer: rerun the CDR and ring-time queries below and compare.

## Queries used

Run on the current Patroni primary as `sudo -u postgres psql pbx -c "…"`.

```sql
-- Every leg of one customer
select to_char(c.started_at at time zone 'America/New_York','HH24:MI:SS') as start, c.direction,
       c.from_extension, c.from_number, c.to_number, c.to_extension, c.outcome, c.vendor,
       extract(epoch from (c.ended_at - c.answered_at))::int as talk_s, c.billable_sec, c.charge,
       c.hangup_cause, c.pbx_node, c.parent_id is not null as child
  from cdrs c join tenants t on t.id = c.tenant_id
 where t.name like 'Golden Pharmacy%' order by c.started_at;

-- Ring time of every answered leg
select to_char(c.started_at at time zone 'America/New_York','HH24:MI:SS') as start, c.direction,
       c.to_number, c.to_extension, c.parent_id is not null as child,
       round(extract(epoch from (c.answered_at - c.started_at))::numeric, 1) as ring_s
  from cdrs c join tenants t on t.id = c.tenant_id
 where t.name like 'Golden Pharmacy%' and c.answered_at is not null order by c.started_at, child;
```

Prometheus (Grafana → Explore, or `/api/datasources/proxy/uid/prometheus/api/v1/query`):

```
round(increase(pbx_calls_total[5h]))                 # by direction, outcome, pbx node
round(increase(pbx_vendor_legs_total[5h]))           # by vendor
increase(rtpengine_zero_packet_streams_total[5h])
max_over_time(rtpengine_transcoders[6h])             # by codec chain: which directions ran
histogram_quantile(0.99, sum by (le, method, route) (increase(pbx_api_http_request_duration_seconds_bucket[6h])))
sum(pbx_active_calls)                                # range query, step 60 s
```

#!/bin/sh
# What the API itself measured, per route: pbx_api_http_request_duration_seconds from Prometheus.
# Pair with haproxy-slow.py (what the edge saw) and the course's chart (what the client saw):
# a request slow for the course but fast here lost its time before or in front of the API.
#
# Run on mon-1 (Prometheus on localhost:9090), through edge-1 or edge-2 as jump host:
#   ssh -J root@130.245.136.131 root@10.0.1.81 'sh -s 24h' < loadtest/diag/api-routes.sh
set -eu
RANGE=${1:-24h}
# Prometheus listens on mon-1's private IP, not loopback.
PROM=${PROM:-http://$(hostname -I | awk '{print $1}'):9090}
M=pbx_api_http_request_duration_seconds
# Health checks and scrapes aren't customer requests.
SEL='route!~"/ready|/health|/metrics"'

q() {
  echo "== $1"
  curl -s "$PROM/api/v1/query" --data-urlencode "query=$2" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if d.get("status") != "success":
    sys.exit(str(d))
rows = sorted(d["data"]["result"], key=lambda r: -float(r["value"][1]))
for r in rows:
    v = float(r["value"][1])
    if v != v or v == 0:
        continue
    labels = " ".join(f"{k}={x}" for k, x in r["metric"].items())
    print(f"  {v:10.3f}  {labels}")
if not rows:
    print("  (none)")
'
}

q "requests per route ($RANGE)" \
  "round(sum by (method, route) (increase(${M}_count{$SEL}[$RANGE])))"
q "requests over 1 s per route ($RANGE)" \
  "round(sum by (method, route) (increase(${M}_count{$SEL}[$RANGE])) - sum by (method, route) (increase(${M}_bucket{$SEL,le=\"1\"}[$RANGE]))) > 0"
q "requests over 2.5 s per route ($RANGE)" \
  "round(sum by (method, route) (increase(${M}_count{$SEL}[$RANGE])) - sum by (method, route) (increase(${M}_bucket{$SEL,le=\"2.5\"}[$RANGE]))) > 0"
q "all routes together: p50 seconds ($RANGE)" \
  "histogram_quantile(0.5, sum by (le) (increase(${M}_bucket{$SEL}[$RANGE])))"
q "all routes together: p99 seconds ($RANGE)" \
  "histogram_quantile(0.99, sum by (le) (increase(${M}_bucket{$SEL}[$RANGE])))"
q "per app node: requests over 1 s ($RANGE)" \
  "round(sum by (instance) (increase(${M}_count{$SEL}[$RANGE])) - sum by (instance) (increase(${M}_bucket{$SEL,le=\"1\"}[$RANGE])))"

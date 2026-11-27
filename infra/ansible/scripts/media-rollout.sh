#!/bin/bash
# Restart rtpengine on media nodes ONE AT A TIME without dropping calls (role rtpengine records a
# pending restart instead of restarting: handlers/main.yml). Per node:
#   1. disable it on BOTH edges (kamcmd rtpengine.enable <url> 0): new calls go to the other nodes,
#      its calls in progress keep using it (rtpengine_allow_op, README 2.4 "Draining one media node")
#   2. wait until its sessions reach 0 (rtpengine_sessions{type="own"} on :2225/metrics)
#   3. restart rtpengine, check it answers, clear the pending marker
#   4. enable it again on both edges, wait until it takes new sessions, then the next node
# If a node doesn't drain within the wait, it is enabled again untouched and the script stops.
# Never more than one node is out of service. Off-peak only (calls drain faster).
#
#   infra/ansible/scripts/media-rollout.sh                  # nodes with a pending restart
#   infra/ansible/scripts/media-rollout.sh media-3 media-5  # these nodes
#   MAX_WAIT_MIN=45 infra/ansible/scripts/media-rollout.sh
set -euo pipefail
cd "$(dirname "$0")/.."
INV=${INV:-inventory/production.ini}
MAX_WAIT_MIN=${MAX_WAIT_MIN:-40}
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"

# name ansible_host private_ip for every [media] host; ansible_host of every [edge] host
section() { awk -v s="[$1]" '$0 == s {on = 1; next} /^\[/ {on = 0} on && /^[a-z]/' "$INV"; }
field() { sed -nE "s/.*\\b$1=([^ ]+).*/\\1/p"; }
mapfile -t MEDIA < <(section media | while read -r line; do echo "${line%% *} $(echo "$line" | field ansible_host) $(echo "$line" | field private_ip)"; done)
mapfile -t EDGES < <(section edge | field ansible_host)
[ ${#MEDIA[@]} -gt 0 ] && [ ${#EDGES[@]} -gt 0 ] || { echo "no [media] or [edge] hosts in $INV"; exit 1; }

sessions() { $SSH "root@$1" "curl -s -m 5 http://$2:2225/metrics | sed -nE 's/^rtpengine_sessions\\{type=\"own\"\\} ([0-9]+).*/\\1/p'"; }
set_enabled() {  # private_ip 0|1, on every edge
  for e in "${EDGES[@]}"; do $SSH "root@$e" "kamcmd rtpengine.enable udp:$1:2223 $2" >/dev/null; done
}
enabled_everywhere() {  # private_ip -> 0 if every edge shows it enabled (disabled: 0)
  for e in "${EDGES[@]}"; do
    $SSH "root@$e" "kamcmd rtpengine.show all" | awk -v u="url: udp:$1:2223" '$0 ~ u {f = 1} f && /disabled:/ {print $2; f = 0}' | grep -qv '^0$' && return 1
  done
  return 0
}

todo=()
for m in "${MEDIA[@]}"; do
  read -r name host ip <<< "$m"
  if [ $# -gt 0 ]; then
    for want in "$@"; do [ "$want" = "$name" ] && todo+=("$m"); done
  elif $SSH "root@$host" "test -f /var/lib/pbx-rtpengine-restart-pending"; then
    todo+=("$m")
  fi
done
if [ "${DRY_RUN:-0}" = 1 ]; then  # read-only: what would happen
  for m in "${MEDIA[@]}"; do
    read -r name host ip <<< "$m"
    pend=$($SSH "root@$host" "test -f /var/lib/pbx-rtpengine-restart-pending && echo pending || echo -")
    en=$(enabled_everywhere "$ip" && echo enabled || echo DISABLED)
    echo "$name $host $ip sessions=$(sessions "$host" "$ip") restart=$pend edges=$en"
  done
  echo "edges: ${EDGES[*]}"
  echo "would restart: $(printf '%s ' "${todo[@]%% *}")"
  exit 0
fi
[ ${#todo[@]} -gt 0 ] || { echo "no media node to restart"; exit 0; }
echo "will restart, one at a time: $(printf '%s ' "${todo[@]%% *}")"

for m in "${todo[@]}"; do
  read -r name host ip <<< "$m"
  # Only one node out at a time: every OTHER media node must be enabled on every edge.
  for other in "${MEDIA[@]}"; do
    read -r oname _ oip <<< "$other"
    [ "$oname" = "$name" ] && continue
    enabled_everywhere "$oip" || { echo "$oname is disabled on an edge: not taking $name out too. Stopping."; exit 1; }
  done

  echo "== $name ($ip): $(sessions "$host" "$ip") sessions; disabling on the edges"
  set_enabled "$ip" 0
  deadline=$(( $(date +%s) + MAX_WAIT_MIN * 60 ))
  while :; do
    n=$(sessions "$host" "$ip"); n=${n:-?}
    [ "$n" = 0 ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "   $n sessions left after $MAX_WAIT_MIN min: enabling $name again UNCHANGED and stopping"
      set_enabled "$ip" 1
      exit 1
    fi
    echo "   $(date -u +%H:%M:%S) $n sessions left"
    sleep 30
  done

  echo "   drained; restarting rtpengine"
  $SSH "root@$host" "systemctl restart rtpengine-daemon && sleep 3 && systemctl is-active rtpengine-daemon && rm -f /var/lib/pbx-rtpengine-restart-pending"
  for i in 1 2 3 4 5 6; do
    [ -n "$(sessions "$host" "$ip")" ] && break
    sleep 5
  done
  [ -n "$(sessions "$host" "$ip")" ] || { echo "   $name does not answer after the restart: left DISABLED on the edges. Stopping."; exit 1; }

  echo "   enabling $name on the edges"
  set_enabled "$ip" 1
  sleep 60
  echo "   $name: $(sessions "$host" "$ip") sessions a minute after enabling"
done
echo "done"

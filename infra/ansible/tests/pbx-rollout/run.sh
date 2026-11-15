#!/bin/bash
# Exercises tasks/pbx-rollout.yml against fake `asterisk` / `kamcmd` (bin/), on this machine only.
# Each case prints the play's messages and what the fakes were asked to do. Expected:
#   A  nothing pending           -> "no restart needed", no kamcmd calls, failed=0
#   B  drain times out           -> state d on both edges, then state a on both, play stops
#   C  drain reaches 0 calls     -> state d, counts 2,1,0, then restart (fails here: no root /
#                                   systemd), node left drained with instructions
#   D  pbx_drain=false           -> no kamcmd calls, straight to restart
# Run from WSL/Linux with ansible-core:  bash infra/ansible/tests/pbx-rollout/run.sh
set -u
cd "$(dirname "$0")"
export ANSIBLE_NOCOLOR=1 ANSIBLE_LOCALHOST_WARNING=0
R=$(cd ../../tasks && pwd)/pbx-rollout.yml
run() {
  name=$1; shift
  : > rollout.log
  echo "##### $name"
  ansible-playbook -i inventory.ini play.yml -e "rollout=$R" "$@" > out.txt 2>&1
  grep -E '"msg"|^fatal|failed=|FAILED - RETRYING' out.txt | cut -c1-240
  echo "--- fakes:"; cat rollout.log
}
echo 0 > calls; run 'A: nothing pending' -e '{"pbx_pending_restarts": []}'
echo 5 > calls; run 'B: drain timeout, back in service' -e '{"pbx_pending_restarts": ["ari-app"], "pbx_drain_wait_min": 0.25}'
echo 2 > calls; run 'C: drained to 0, restart (fails here), left drained' -e '{"pbx_pending_restarts": ["ari-app", "ari-app"], "pbx_drain_wait_min": 2}'
echo 3 > calls; run 'D: pbx_drain=false' -e '{"pbx_pending_restarts": ["asterisk"], "pbx_drain": false}'
rm -f calls rollout.log out.txt

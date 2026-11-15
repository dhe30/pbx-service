#!/bin/bash
# Exercises tasks/pbx-rollout.yml against fake `asterisk` / `kamcmd` (bin/), on this machine only.
# Each case prints the play's messages, what the fakes were asked to do and whether the restart
# marker is left. Expected:
#   A  nothing pending            -> "no restart needed", no kamcmd calls, failed=0
#   B  drain times out            -> state d on both edges, then a on both; stops; marker kept
#   C  drain reaches 0 calls      -> d, counts 2,1,0, restart (fails here: no root / systemd),
#                                    node left drained with instructions; marker kept
#   D  pbx_drain=false            -> no kamcmd calls, straight to restart
#   E  only the marker (an earlier run was stopped, nothing "changed" now) -> drains and restarts
#   F  the other pbx node is drained -> refuses before draining; no state d sent
# Run from WSL/Linux with ansible-core:  bash infra/ansible/tests/pbx-rollout/run.sh
set -u
cd "$(dirname "$0")"
export ANSIBLE_NOCOLOR=1 ANSIBLE_LOCALHOST_WARNING=0
R=$(cd ../../tasks && pwd)/pbx-rollout.yml
both_up() { printf '  URI: sip:10.9.9.9:5060\n  FLAGS: AP\n  URI: sip:10.9.9.8:5060\n  FLAGS: AP\n' > ds.list; }
other_down() { printf '  URI: sip:10.9.9.9:5060\n  FLAGS: AP\n  URI: sip:10.9.9.8:5060\n  FLAGS: DX\n' > ds.list; }
run() {
  name=$1; shift
  : > rollout.log
  echo "##### $name"
  ansible-playbook -i inventory.ini play.yml -e "rollout=$R" "$@" > out.txt 2>&1
  grep -E '"msg"|^fatal|failed=|FAILED - RETRYING' out.txt | cut -c1-240
  echo "--- fakes:"; cat rollout.log
  echo "--- marker: $(cat marker 2>/dev/null | tr '\n' ' ' || true)"
}
rm -f marker
both_up; echo 0 > calls; run 'A: nothing pending' -e '{"pbx_pending_restarts": []}'
both_up; echo 5 > calls; echo ari-app > marker; run 'B: drain timeout, back in service' -e '{"pbx_pending_restarts": ["ari-app"], "pbx_drain_wait_min": 0.25}'
both_up; echo 2 > calls; run 'C: drained to 0, restart (fails here), left drained' -e '{"pbx_pending_restarts": ["ari-app", "ari-app"], "pbx_drain_wait_min": 2}'
rm -f marker
both_up; echo 3 > calls; run 'D: pbx_drain=false' -e '{"pbx_pending_restarts": ["asterisk"], "pbx_drain": false}'
both_up; echo 1 > calls; printf 'asterisk\nari-app\n' > marker; run 'E: only the marker from a stopped run' -e '{"pbx_pending_restarts": [], "pbx_drain_wait_min": 1}'
other_down; echo 1 > calls; echo ari-app > marker; run 'F: other node drained: refuse' -e '{"pbx_pending_restarts": ["ari-app"]}'
rm -f calls rollout.log out.txt ds.list marker

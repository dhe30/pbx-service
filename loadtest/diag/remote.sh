#!/bin/bash
# Run the diagnostics in this folder on the cloud VMs from WSL, typing the key's passphrase once.
#
#   remote.sh agent                          start an ssh-agent (4 h) and add the key: asks for the
#                                            passphrase once; later calls reuse it without prompting
#   remote.sh <host> '<command>'             run a command (hosts: edge-1, edge-2, mon-1, or an IP)
#   remote.sh <host> py <script.py> [args]   run a local Python script there (python3 - args < script)
#   remote.sh <host> sh <script.sh> [args]   same for a shell script
#
# Private VMs (mon-1, or any 10.x address) are reached through edge-1, like the Ansible inventory.
set -euo pipefail

SOCK="$HOME/.ssh/pbx-diag-agent.sock"
KEY="${PBX_SSH_KEY:-$HOME/.ssh/id_ed25519_clanode}"
EDGE1=130.245.136.131

if [ "${1:-}" = agent ]; then
  set +e
  SSH_AUTH_SOCK="$SOCK" ssh-add -l >/dev/null 2>&1
  state=$?   # 0 = agent has keys, 1 = agent running without keys, 2 = no agent on the socket
  set -e
  if [ "$state" = 0 ]; then
    echo "agent already holds the key"
    exit 0
  fi
  if [ "$state" = 2 ]; then
    rm -f "$SOCK"
    ssh-agent -a "$SOCK" -t 4h >/dev/null
  fi
  SSH_AUTH_SOCK="$SOCK" ssh-add -t 4h "$KEY"
  echo "key added for 4 h; you can close this tab"
  exit 0
fi

[ $# -ge 2 ] || { sed -n '2,12p' "$0"; exit 2; }
case "$1" in
  edge-1) target=$EDGE1; jump= ;;
  edge-2) target=130.245.136.155; jump= ;;
  mon-1)  target=10.0.1.81; jump=$EDGE1 ;;
  10.*)   target=$1; jump=$EDGE1 ;;
  *)      target=$1; jump= ;;
esac
shift

export SSH_AUTH_SOCK="$SOCK"
opts=(-o BatchMode=yes -o ConnectTimeout=10)
[ -n "$jump" ] && opts+=(-J "root@$jump")

case "$1" in
  py) script=$2; shift 2; exec ssh "${opts[@]}" "root@$target" "python3 - $*" < "$script" ;;
  sh) script=$2; shift 2; exec ssh "${opts[@]}" "root@$target" "sh -s $*" < "$script" ;;
  *)  exec ssh "${opts[@]}" "root@$target" "$@" < /dev/null ;;
esac

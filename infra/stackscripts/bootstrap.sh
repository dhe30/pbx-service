#!/usr/bin/env bash
# Linode StackScript: first-boot bootstrap for every VM. See CLAUDE.md §15.
# <UDF name="role" label="Node role" oneOf="edge,pbx,app,db,mon" />
# <UDF name="ssh_pubkey" label="Team SSH public key" />
set -euo pipefail

# TODO: apt update/upgrade, install python3 (for Ansible) and docker as needed,
#       add team SSH key, basic nftables (SSH + role ports), set hostname,
#       optionally ansible-pull for "$ROLE".
echo "bootstrap: role=${ROLE:-unset}"

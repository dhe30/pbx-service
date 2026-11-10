#!/usr/bin/env bash
# Sets up the dev Garage node: layout, bucket, access key. Mirrors the objectstore Ansible role.
# Idempotent. Usage: npm run dev:s3
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET=pbx-media
# Fixed dev credentials (Garage formats: "GK" + 24 hex / 64 hex). Must match .env.
KEY_ID=GK000000000000000000000001
SECRET=0000000000000000000000000000000000000000000000000000000000000001

garage() { docker compose -f dev/docker-compose.yml exec -T garage /garage "$@"; }

# Wait for the node to answer.
for _ in $(seq 15); do garage status >/dev/null 2>&1 && break; sleep 1; done

if garage status | grep -q "NO ROLE ASSIGNED"; then
  node_id=$(garage node id -q | cut -d@ -f1)
  garage layout assign -z dc1 -c 1G "$node_id"
  garage layout apply --version 1
fi

garage bucket info "$BUCKET" >/dev/null 2>&1 || garage bucket create "$BUCKET"
garage key info pbx-media >/dev/null 2>&1 || garage key import --yes -n pbx-media "$KEY_ID" "$SECRET"
garage bucket allow --read --write --owner "$BUCKET" --key pbx-media >/dev/null
echo "garage ready: bucket $BUCKET, key $KEY_ID"

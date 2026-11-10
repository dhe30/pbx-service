#!/usr/bin/env bash
# Creates Kamailio's tables (db/kamailio/*.sql) in the dev Postgres, in schema `kamailio`, the
# same layout the db_schema Ansible role creates in production. The API writes
# kamailio.subscriber (one SIP account per extension). kamailio.location is created but unused:
# registrations live in Kamailio memory (usrloc db_mode=0).
# Idempotent: the tables are created only if missing; our extra subscriber columns
# (pbx-subscriber-columns.sql: tenant_id, extension_id) are applied on every run, like the Ansible
# role does, so an older dev DB picks them up too. Usage: npm run db:kamailio
set -euo pipefail
cd "$(dirname "$0")/.."

psql() {
  docker compose -f dev/docker-compose.yml exec -T postgres \
    psql -U pbx -d pbx -v ON_ERROR_STOP=1 -q "$@"
}

if [ "$(psql -tAc "select to_regclass('kamailio.subscriber') is not null")" = "t" ]; then
  echo "kamailio schema already present"
else
  {
    echo "begin;"
    echo "create schema kamailio;"
    echo "set local search_path = kamailio;"
    cat db/kamailio/standard-create.sql db/kamailio/auth_db-create.sql db/kamailio/usrloc-create.sql
    echo "commit;"
  } | psql
  echo "kamailio schema created"
fi

{
  echo "begin;"
  echo "set local search_path = kamailio;"
  echo "set local client_min_messages = warning;" # hide 'column already exists, skipping'
  cat db/kamailio/pbx-subscriber-columns.sql
  echo "commit;"
} | psql
echo "kamailio subscriber columns up to date"

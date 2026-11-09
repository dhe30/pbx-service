#!/usr/bin/env bash
# Creates Kamailio's tables (db/kamailio/*.sql) in the dev Postgres, in schema `kamailio`, the
# same layout the db_schema Ansible role creates in production. The API writes
# kamailio.subscriber (staff SIP accounts) and kamailio.location (cleared when staff are deleted).
# Idempotent: does nothing if the tables already exist. Usage: npm run db:kamailio
set -euo pipefail
cd "$(dirname "$0")/.."

psql() {
  docker compose -f dev/docker-compose.yml exec -T postgres \
    psql -U pbx -d pbx -v ON_ERROR_STOP=1 -q "$@"
}

if [ "$(psql -tAc "select to_regclass('kamailio.subscriber') is not null")" = "t" ]; then
  echo "kamailio schema already present"
  exit 0
fi

{
  echo "begin;"
  echo "create schema kamailio;"
  echo "set local search_path = kamailio;"
  cat db/kamailio/standard-create.sql db/kamailio/auth_db-create.sql db/kamailio/usrloc-create.sql
  echo "commit;"
} | psql
echo "kamailio schema created"

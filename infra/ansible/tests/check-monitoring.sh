#!/bin/sh
# Offline check of the monitoring configs (Linux/WSL; needs ansible-core and Debian's
# `prometheus`, `prometheus-alertmanager` and `prometheus-blackbox-exporter` packages):
#   1. render roles/monitoring for the 10-VM example inventory (render-monitoring.yml)
#   2. promtool check rules / check config, amtool check-config
# Output goes to infra/ansible/tests/.rendered-monitoring/ (gitignored).
#
#   sh infra/ansible/tests/check-monitoring.sh
# The same validators also run on mon-1 before each file is installed (roles/monitoring/tasks).
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=$ROOT/infra/ansible/tests/.rendered-monitoring
rm -rf "$OUT" && mkdir -p "$OUT"

cd "$ROOT/infra/ansible"
ANSIBLE_CONFIG=$ROOT/infra/ansible/ansible.cfg ansible-playbook -i inventory/staging.ini render-monitoring.yml \
  -e @tests/render-vars.yml -e render_dir="$OUT" >"$OUT/ansible.log" 2>&1 || { cat "$OUT/ansible.log"; exit 1; }

MON=$OUT/mon-1
# prometheus.yml loads rules from /etc/prometheus/rules/*.yml; point it at the rendered copy.
sed "s#/etc/prometheus/rules/\*.yml#$MON/pbx-alerts.yml#" "$MON/prometheus.yml" >"$MON/prometheus.test.yml"

status=0
check() {
  if "$@" >"$OUT/last.log" 2>&1; then echo "PASS $*"; else echo "FAIL $*"; cat "$OUT/last.log"; status=1; fi
}
check promtool check rules "$MON/pbx-alerts.yml"
check promtool check config "$MON/prometheus.test.yml"
check amtool check-config "$MON/alertmanager.yml"
check prometheus-blackbox-exporter --config.check --config.file="$MON/blackbox.yml"
exit $status

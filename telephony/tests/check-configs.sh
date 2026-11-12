#!/bin/sh
# Offline check of the telephony configs (Linux/WSL; needs ansible + kamailio 6.0):
#   1. render every template for a 2-edge/2-pbx test inventory (infra/ansible/render-telephony.yml)
#   2. `kamailio -c` each rendered edge config (syntax, module params, route fixups)
# Output goes to telephony/tests/.rendered/ (gitignored); services/ari-app/test/configs.test.ts
# then asserts on the rendered content (npm test).
#
#   KAMAILIO=~/kam/usr/sbin/kamailio KAMAILIO_MODULES=~/kam/usr/lib/x86_64-linux-gnu/kamailio/modules \
#     sh telephony/tests/check-configs.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/telephony/tests/.rendered
KAM=${KAMAILIO:-kamailio}
rm -rf "$OUT" && mkdir -p "$OUT"

cd "$ROOT/infra/ansible"
ANSIBLE_CONFIG=$ROOT/infra/ansible/ansible.cfg ansible-playbook -i tests/render-inventory.ini render-telephony.yml \
  -e @tests/render-vars.yml -e render_dir="$OUT" >"$OUT/ansible.log" 2>&1 || { cat "$OUT/ansible.log"; exit 1; }
echo "rendered: $(ls "$OUT")"

# Self-signed cert so the tls module can load during the check.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=test" -keyout "$OUT/key.pem" -out "$OUT/cert.pem" >/dev/null 2>&1

status=0
for edge in "$OUT"/edge-*; do
  name=$(basename "$edge")
  sed -e "s#^private_key = .*#private_key = $OUT/key.pem#" -e "s#^certificate = .*#certificate = $OUT/cert.pem#" \
    "$edge/tls.cfg" >"$edge/tls.test.cfg"
  sed -e "s#/etc/kamailio/tls.cfg#$edge/tls.test.cfg#" -e "s#/etc/kamailio/dispatcher.list#$edge/dispatcher.list#" \
    "$edge/kamailio.cfg" >"$edge/kamailio.test.cfg"
  MP=""
  [ -n "${KAMAILIO_MODULES:-}" ] && MP="-L $KAMAILIO_MODULES"
  mkdir -p "$edge/run"
  if LD_LIBRARY_PATH="${KAMAILIO_LIBS:-}" $KAM -c -Y "$edge/run" -f "$edge/kamailio.test.cfg" $MP >"$edge/kamailio-check.log" 2>&1; then
    echo "PASS kamailio -c $name" | tee -a "$OUT/results.txt"
  else
    echo "FAIL kamailio -c $name" | tee -a "$OUT/results.txt"
    grep -E "ERROR|CRITICAL|error" "$edge/kamailio-check.log" | head -20
    status=1
  fi
done
# HAProxy (optional: haproxy on PATH, or HAPROXY=/path/to/haproxy), with the test cert and the
# repo's test page in place of the edge paths.
HAP=${HAPROXY:-$(command -v haproxy || true)}
if [ -n "$HAP" ]; then
  cat "$OUT/cert.pem" "$OUT/key.pem" >"$OUT/site.pem"
  for edge in "$OUT"/edge-*; do
    name=$(basename "$edge")
    sed -e "s#/etc/haproxy/certs/site.pem#$OUT/site.pem#" \
      -e "s#/etc/haproxy/www/webrtc-test.html#$ROOT/telephony/webrtc-test/index.html#" \
      "$edge/haproxy.cfg" >"$edge/haproxy.test.cfg"
    if LD_LIBRARY_PATH="${HAPROXY_LIBS:-}" "$HAP" -c -f "$edge/haproxy.test.cfg" >"$edge/haproxy-check.log" 2>&1; then
      echo "PASS haproxy -c $name" | tee -a "$OUT/results.txt"
    else
      echo "FAIL haproxy -c $name" | tee -a "$OUT/results.txt"
      head -20 "$edge/haproxy-check.log"
      status=1
    fi
  done
fi
exit $status

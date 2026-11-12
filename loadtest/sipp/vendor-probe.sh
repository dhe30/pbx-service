#!/usr/bin/env bash
# Pre-deploy PSTN vendor probe (verify-backlog V-V3, V-V4, V-V5, V-V7, V-V8). Run from WSL, in the
# terminal where ssh-agent has the Clanode key; edge-1 does the calling, nothing is deployed:
#
#   loadtest/sipp/vendor-probe.sh us 2125550199 +1XXXXXXXXXX              # one test call, 2 formats
#   loadtest/sipp/vendor-probe.sh us <our DID> +1XXXXXXXXXX --capture     # + V-V8: does it come back?
#   loadtest/sipp/vendor-probe.sh intl +442071838750 +1XXXXXXXXXX
#
# Args: vendor (us|intl), the number to dial (any of 2125550199, 12125550199, +12125550199), the
# caller ID to present (+E.164; use one of OUR numbers, e.g. the one verify-course-services.ts
# bought), and --capture to also record carrier INVITEs (from 130.245.136.142) on both edges.
#
# It tries the number in both formats (+E.164 and digits only), one call each, and prints what
# the vendor answered. Costs: a few answered seconds per call, from the vendor's prepaid balance
# (fund it with ~$1 on the Course Services tab first; at $0 the vendor answers 402).
# Needs: edge-1's UDP 5060 free (run it BEFORE Kamailio is deployed there).
set -euo pipefail

VENDOR=${1:?usage: vendor-probe.sh us|intl <number> <caller-id +E.164> [--capture]}
NUMBER=${2:?number to dial}
CALLER=${3:?caller ID, +E.164}
CAPTURE=${4:-}
HERE=$(cd "$(dirname "$0")" && pwd)
INV=${INV:-$HOME/pbx-service/infra/ansible/inventory/production.ini}
CARRIER=130.245.136.142

case $VENDOR in
  us) VHOST=us-vendor.cse356.compas.cs.stonybrook.edu ;;
  intl) VHOST=intl-vendor.cse356.compas.cs.stonybrook.edu ;;
  *) echo "vendor must be us or intl" >&2; exit 2 ;;
esac

# edge-1 / edge-2 addresses from the inventory (ansible_host = public IP, private_ip = bind address)
hostvar() { awk -v h="$1" -v k="$2" '$1==h { for (i=2;i<=NF;i++) { split($i,a,"="); if (a[1]==k) print a[2] } }' "$INV"; }
E1_PUB=$(hostvar edge-1 public_ip); E1_PRIV=$(hostvar edge-1 private_ip); E2_PUB=$(hostvar edge-2 public_ip)
[ -n "$E1_PUB" ] && [ -n "$E1_PRIV" ] || { echo "edge-1 public_ip/private_ip not found in $INV" >&2; exit 1; }
E1=root@$E1_PUB; E2=root@$E2_PUB

digits=${NUMBER#+}; digits=${digits#011}
[ ${#digits} -eq 10 ] && digits=1$digits          # US 10-digit -> 1 + 10
FORMATS=("+$digits" "$digits")

read -rsp "Vendor ($VENDOR) digest username: " VUSER; echo
read -rsp "Vendor ($VENDOR) digest password: " VPASS; echo

echo "== edge-1 ($E1_PUB, binds $E1_PRIV): installing sipp + tcpdump if needed"
ssh "$E1" 'command -v sipp >/dev/null && command -v tcpdump >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sip-tester tcpdump >/dev/null'
if ssh "$E1" "ss -lun | grep -q ':5060 '"; then
  echo "UDP 5060 is in use on edge-1 (Kamailio deployed?). Stop it first or run this before the deploy." >&2
  exit 1
fi
scp -q "$HERE/uac_vendor_probe.xml" "$E1:/tmp/uac_vendor_probe.xml"
# Credentials go in a root-only file on edge-1 (never on this machine's command line); each call
# reads them into SIPp's -au/-ap. The file is removed at the end, and Authorization headers are
# redacted from the message logs right after each call.
printf 'SEQUENTIAL\n%s;%s\n' "$VUSER" "$VPASS" | ssh "$E1" 'umask 077; cat > /tmp/vprobe.csv'
unset VPASS
cleanup() { ssh "$E1" 'rm -f /tmp/vprobe.csv' || true; }
trap cleanup EXIT

if [ "$CAPTURE" = "--capture" ]; then
  echo "== capturing carrier INVITEs (from $CARRIER) on edge-1 and edge-2 for 60 s"
  for e in "$E1" "$E2"; do
    ssh "$e" "command -v tcpdump >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tcpdump >/dev/null; \
      nohup timeout 60 tcpdump -n -s0 -A -i any 'udp port 5060 and host $CARRIER' > /tmp/carrier.txt 2>/dev/null < /dev/null &" || true
  done
  sleep 2
fi

i=0
for f in "${FORMATS[@]}"; do
  i=$((i+1))
  echo; echo "== call $i: $VENDOR vendor, Request-URI user '$f', caller ID $CALLER"
  # Credentials: read on edge-1 from the root-only file and given to SIPp's -au/-ap (only root's
  # process list sees them for the call's few seconds; never this machine's command line).
  ssh "$E1" "cd /tmp && rm -f probe-$i.log && U=\$(sed -n 2p vprobe.csv | cut -d';' -f1) && P=\$(sed -n 2p vprobe.csv | cut -d';' -f2-) && \
      timeout 40 sipp -sf uac_vendor_probe.xml -au \"\$U\" -ap \"\$P\" \
      -key pubip $E1_PUB -key vhost $VHOST -key callerid '$CALLER' -key offer '0 8 18 4 96 101' \
      -s '$f' -i $E1_PRIV -p 5060 -m 1 -l 1 -timeout 30 -nostdin -trace_msg -message_file probe-$i.log \
      $VHOST:5060 >/dev/null 2>&1; echo \"  sipp exit \$? (0 = call completed, 1 = ended on a failure branch or error)\"; \
      sed -i -E 's/^((Proxy-)?Authorization:).*/\1 <redacted>/I' probe-$i.log 2>/dev/null; true"
  # What the vendor said: status lines, challenge realm, Server, Reason/Warning, and the answer SDP.
  ssh "$E1" "test -f /tmp/probe-$i.log && grep -E '^(SIP/2.0 [0-9]{3}|(WWW|Proxy)-Authenticate:|Server:|User-Agent:|Reason:|Warning:|m=audio|a=rtpmap)' /tmp/probe-$i.log \
      | grep -v pbx-vendor-probe | sed -E 's/(nonce|opaque)=\"[^\"]*\"/\1=\"...\"/g; s/^/    /' | uniq || echo '    (no message log)'"
  sleep 2
done

if [ "$CAPTURE" = "--capture" ]; then
  echo; echo "== waiting for the carrier capture to end"; sleep 20
  for e in "$E1" "$E2"; do
    echo "-- carrier messages on $e:"
    ssh "$e" "grep -E '^(INVITE |SIP/2.0 |To:|From:|m=audio|a=rtpmap|a=fmtp:101)' /tmp/carrier.txt | head -20 || true; echo '   ('\$(grep -c '^INVITE ' /tmp/carrier.txt 2>/dev/null || echo 0)' INVITE(s))'"
  done
fi
echo; echo "Full SIP logs stay on edge-1: /tmp/probe-*.log (copy them into the verify-backlog Result if useful)."

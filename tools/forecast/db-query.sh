#!/bin/sh
# Forced SSH command for the forecast tool's key on the db nodes (authorized_keys: from="<mon-1>",
# command="/usr/local/bin/pbx-forecast-query"). The only thing that key can do:
#
#   ssh postgres@<db node> snapshot "2026-11-26 03:00+00" "2026-11-26 04:00+00"
#
# runs the installed snapshot.sql for that window (at most 6 h) and prints its JSON line. It refuses
# to run on the Patroni primary, so it can only ever read from a replica (which cannot write), and
# the SQL itself runs in a read-only transaction with a statement timeout. mon-1 cannot send SQL.
set -eu
SQL=/usr/local/share/pbx-forecast/snapshot.sql
TS='[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:00\+00'

# The requested command, e.g.: snapshot "2026-11-26 03:00+00" "2026-11-26 04:00+00"
REQ=${SSH_ORIGINAL_COMMAND:-}
FROM=$(printf '%s' "$REQ" | sed -nE "s/^snapshot \"($TS)\" \"($TS)\"$/\1/p")
TO=$(printf '%s' "$REQ" | sed -nE "s/^snapshot \"($TS)\" \"($TS)\"$/\2/p")
[ -n "$FROM" ] && [ -n "$TO" ] || { echo "usage: snapshot \"YYYY-MM-DD HH:00+00\" \"YYYY-MM-DD HH:00+00\"" >&2; exit 2; }
START=$(date -ud "${FROM%+00}" +%s)
END=$(date -ud "${TO%+00}" +%s)
[ "$END" -gt "$START" ] && [ $((END - START)) -le 21600 ] || { echo "window must be 1 h .. 6 h" >&2; exit 2; }

cd /tmp
[ "$(psql -X -At -c 'select pg_is_in_recovery()')" = t ] || { echo "not a replica: refusing" >&2; exit 3; }
exec psql -X -q -At -d pbx -v from="$FROM" -v to="$TO" -f "$SQL"

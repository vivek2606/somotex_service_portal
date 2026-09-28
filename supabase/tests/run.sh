#!/usr/bin/env bash
# Runs the schema tests against a local PostgreSQL (default: socket /tmp, port 5433).
set -euo pipefail
cd "$(dirname "$0")"

# Supabase blocks UPDATE/DELETE statements without a WHERE clause (pg_safeupdate),
# which plain PostgreSQL allows, so check for them here.
if python3 - ../schema.sql <<'PY'
import re, sys
sql = open(sys.argv[1]).read()
sql = re.sub(r"--[^\n]*", "", sql)
bad = []
for stmt in re.split(r";", sql):
    s = " ".join(stmt.split()).lower()
    m = re.search(r"\b(delete from|update)\s+[\w.\"]+\b", s)
    if not m or "format(" in s[: m.start()][-20:]:
        continue
    tail = s[m.start():]
    if tail.startswith("update") and " set " not in tail:
        continue
    if " where " not in tail and "on conflict" not in s:
        bad.append(tail[:80])
if bad:
    print("Statements without WHERE (Supabase will refuse them):")
    for b in bad: print("  " + b)
    sys.exit(1)
PY
then :; else echo 'Schema tests FAILED'; exit 1; fi
PSQL="psql -h ${PGHOST:-/tmp} -p ${PGPORT:-5433} -U ${PGUSER:-postgres} -q -X --set=client_min_messages=warning"
$PSQL -c "drop database if exists schema_test" >/dev/null
$PSQL -c "create database schema_test" >/dev/null
OUT=$(mktemp)
if ! PGOPTIONS='-c client_min_messages=warning' $PSQL -d schema_test -v ON_ERROR_STOP=1 -f stub_supabase.sql -f ../schema.sql -f schema_test.sql >"$OUT" 2>&1; then
  grep -E 'ERROR|CONTEXT' "$OUT"
  echo 'Schema tests FAILED'
  exit 1
fi
grep 'All schema tests passed' "$OUT"
# Applying the schema a second time must also work (updates are re-runs).
PGOPTIONS='-c client_min_messages=warning' $PSQL -d schema_test -v ON_ERROR_STOP=1 -f ../schema.sql >/dev/null && echo 'Schema re-applies cleanly'

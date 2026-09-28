#!/usr/bin/env bash
# Runs the schema tests against a local PostgreSQL (default: socket /tmp, port 5433).
set -euo pipefail
cd "$(dirname "$0")"
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

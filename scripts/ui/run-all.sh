#!/bin/bash
# Runs the browser regression suite against a freshly seeded SUDS server. Usage (repo root): scripts/ui/run-all.sh
# Requires: npm i -D playwright && npx playwright install chromium   (not project dependencies)
set -u
export SUDS_ENV=development SUDS_DATA_DIR=/tmp/suds-ui-data PORT=${PORT:-8090} SUDS_ADMIN_PASSWORD='AdminPassw0rd!x'
rm -rf /tmp/suds-ui-data; mkdir -p /tmp/suds-ui-data
npm run -s seed >/dev/null
node --no-warnings=ExperimentalWarning server/index.js > /tmp/suds-ui-server.log 2>&1 &
SERVER=$!; trap 'kill $SERVER 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/meta/constants" >/dev/null && break; sleep 0.5; done
export SUDS_URL="http://127.0.0.1:$PORT"
fail=0
for s in desktop navigator-flow ux-features local-mode sync-two-way spreadsheets sample-data resource-profiles forms region dates; do
  echo "=== $s"
  if node scripts/ui/$s.mjs > /tmp/suds-ui-$s.log 2>&1; then grep -v '^\[2m' /tmp/suds-ui-$s.log | tail -6; else echo "FAILED"; grep -v '^\[2m' /tmp/suds-ui-$s.log | tail -25; fail=1; fi
done
exit $fail

#!/bin/bash
# Runs the browser regression suite against a freshly seeded SUDS server. Usage (repo root): scripts/ui/run-all.sh
# Requires: npm i -D playwright && npx playwright install chromium   (not project dependencies)
set -u
export SUDS_ENV=development SUDS_DATA_DIR=/tmp/suds-ui-data PORT=${PORT:-8090} SUDS_ADMIN_PASSWORD='AdminPassw0rd!x'
# Every script signs in afresh, several as more than one person; the office default of 20 sign-ins per
# address per 15 minutes was being hit part-way through the run and failing the later scripts at login.
export LOGIN_RATE_LIMIT=1000
# A server left over from an earlier run holds a port and the wizard then "cannot start" on it, which
# looks like an app defect. Say what is actually wrong instead.
STATIC_PORT=${STATIC_PORT:-8878}
for p in "$PORT" 8095 "${SETUP_PORT:-8496}" "$STATIC_PORT"; do
  if curl -sk -o /dev/null --max-time 2 "http://127.0.0.1:$p/" || curl -sk -o /dev/null --max-time 2 "https://127.0.0.1:$p/"; then
    echo "port $p is already in use (a server from an earlier run?). Stop it and start again." >&2; exit 2
  fi
done
rm -rf /tmp/suds-ui-data; mkdir -p /tmp/suds-ui-data
npm run -s seed >/dev/null
node --no-warnings=ExperimentalWarning server/index.js > /tmp/suds-ui-server.log 2>&1 &
SERVER=$!; trap 'kill $SERVER 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/meta/constants" >/dev/null && break; sleep 0.5; done
export SUDS_URL="http://127.0.0.1:$PORT"
# A second, unconfigured production server for the first-run wizard, in its own data directory. The
# wizard restarts it on SETUP_PORT with a self-signed certificate, so that port must be free too.
export SETUP_PORT=${SETUP_PORT:-8496}
rm -rf /tmp/suds-setup-data; mkdir -p /tmp/suds-setup-data
SUDS_ENV=production SUDS_DATA_DIR=/tmp/suds-setup-data PORT=8095 SUDS_ADMIN_PASSWORD= node --no-warnings=ExperimentalWarning server/index.js > /tmp/suds-setup-server.log 2>&1 &
SETUP_SERVER=$!; trap 'kill $SERVER $SETUP_SERVER 2>/dev/null; pkill -f "suds-setup-data" 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:8095/api/setup/status" >/dev/null && break; sleep 0.5; done
export SUDS_SETUP_URL="http://127.0.0.1:8095"
# The standalone static build: no office server, no database, nothing but the files a plain web host
# would serve. Built once here (build-local already ran above via package.json's build:local step, but
# build-static-site re-runs it defensively) and served with the office server's own static-file logic,
# so the check matches what a real static host returns.
rm -rf /tmp/suds-static-site
node scripts/build-static-site.js /tmp/suds-static-site >/dev/null
node scripts/serve-static.js /tmp/suds-static-site "$STATIC_PORT" > /tmp/suds-static-server.log 2>&1 &
STATIC_SERVER=$!; trap 'kill $SERVER $SETUP_SERVER $STATIC_SERVER 2>/dev/null; pkill -f "suds-setup-data" 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$STATIC_PORT/" >/dev/null && break; sleep 0.5; done
export SUDS_STATIC_URL="http://127.0.0.1:$STATIC_PORT"
fail=0
for s in desktop review-fixes navigator-flow navigator-fixes ux-features local-mode sync-two-way device-audit spreadsheets sample-data resource-profiles forms region dates setup static-site qa-retest; do
  echo "=== $s"
  if node scripts/ui/$s.mjs > /tmp/suds-ui-$s.log 2>&1; then grep -v '^\[2m' /tmp/suds-ui-$s.log | tail -6; else echo "FAILED"; grep -v '^\[2m' /tmp/suds-ui-$s.log | tail -25; fail=1; fi
done
exit $fail

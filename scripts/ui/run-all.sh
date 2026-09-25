#!/bin/bash
# Runs the browser regression suite against a freshly seeded SUDS server. Usage (repo root): scripts/ui/run-all.sh
# Requires: npm i -D playwright && npx playwright install chromium   (not project dependencies)
# SCRIPTS="a b" runs a subset, in that order (the servers are still started the same way).
set -u
# SUDS_UI_TMP (default /tmp) holds the servers' data directories and logs, and SETUP_BOOT_PORT (default 8095)
# is where the unconfigured wizard server starts: set both, with PORT/STATIC_PORT/SETUP_PORT/
# SUDS_UPGRADE_PORT/SUDS_MULTITAB_PORT, to run two suites side by side on one machine without them sharing
# a database.
T=${SUDS_UI_TMP:-/tmp}; SETUP_BOOT_PORT=${SETUP_BOOT_PORT:-8095}
export SUDS_ENV=development SUDS_DATA_DIR=$T/suds-ui-data PORT=${PORT:-8090} SUDS_ADMIN_PASSWORD='AdminPassw0rd!x'
# Every script signs in afresh, several as more than one person; the office default of 20 sign-ins per
# address per 15 minutes was being hit part-way through the run and failing the later scripts at login.
export LOGIN_RATE_LIMIT=1000
# Local mode (/?local=1) is off by default on an office server; the dev server the suite drives turns it on
# so the local-mode, sync and device scripts have a kernel to load. The first-run wizard's server below
# clears it again, so the wizard asks the question the way a county sees it.
export LOCAL_MODE_ENABLED=true
# A server left over from an earlier run holds a port and the wizard then "cannot start" on it, which
# looks like an app defect. Say what is actually wrong instead.
STATIC_PORT=${STATIC_PORT:-8878}
for p in "$PORT" "$SETUP_BOOT_PORT" "${SETUP_PORT:-8496}" "$STATIC_PORT" "${SUDS_UPGRADE_PORT:-8879}" "${SUDS_MULTITAB_PORT:-8881}"; do
  if curl -sk -o /dev/null --max-time 2 "http://127.0.0.1:$p/" || curl -sk -o /dev/null --max-time 2 "https://127.0.0.1:$p/"; then
    echo "port $p is already in use (a server from an earlier run?). Stop it and start again." >&2; exit 2
  fi
done
SERVER=; SETUP_SERVER=; STATIC_SERVER=
trap 'kill $SERVER $SETUP_SERVER $STATIC_SERVER 2>/dev/null; pkill -f "$T/suds-setup-data" 2>/dev/null' EXIT

# The office server every script that reads SUDS_URL drives. Scripts change its data (device-audit
# restores a backup, sync-two-way pushes a device's records, others add clients and notes), and a script
# that counted on the seed used to fail when it ran after one of them. So each of those scripts gets a
# freshly seeded server of its own: stop it, wipe the data directory, seed, start again (about 2 s).
: > $T/suds-ui-server.log
# Ready when /api/health answers (the suite used to probe /api/meta/constants, which needs a session and
# answers 401, so every start waited out the full 20 s loop).
start_office() {
  if [ -n "$SERVER" ]; then kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; SERVER=; fi
  rm -rf $T/suds-ui-data; mkdir -p $T/suds-ui-data
  npm run -s seed >/dev/null
  node --no-warnings=ExperimentalWarning server/index.js >> $T/suds-ui-server.log 2>&1 &
  SERVER=$!
  for i in $(seq 1 80); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && return 0; sleep 0.25; done
  echo "the office server did not start (see $T/suds-ui-server.log)" >&2; return 1
}
start_office || exit 2
export SUDS_URL="http://127.0.0.1:$PORT"
# A second, unconfigured production server for the first-run wizard, in its own data directory. The
# wizard restarts it on SETUP_PORT with a self-signed certificate, so that port must be free too.
export SETUP_PORT=${SETUP_PORT:-8496}
rm -rf $T/suds-setup-data; mkdir -p $T/suds-setup-data
SUDS_ENV=production SUDS_DATA_DIR=$T/suds-setup-data PORT=$SETUP_BOOT_PORT SUDS_ADMIN_PASSWORD= LOCAL_MODE_ENABLED= node --no-warnings=ExperimentalWarning server/index.js > $T/suds-setup-server.log 2>&1 &
SETUP_SERVER=$!
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$SETUP_BOOT_PORT/api/setup/status" >/dev/null && break; sleep 0.5; done
export SUDS_SETUP_URL="http://127.0.0.1:$SETUP_BOOT_PORT"
# The standalone static build: no office server, no database, nothing but the files a plain web host
# would serve. Built once here (build-local already ran above via package.json's build:local step, but
# build-static-site re-runs it defensively) and served like a plain static host (files, index.html for
# the root, real 404s — no rewrites), so the check matches what GitHub Pages or S3 would return.
rm -rf $T/suds-static-site
node scripts/build-static-site.js $T/suds-static-site >/dev/null
node scripts/serve-static.js $T/suds-static-site "$STATIC_PORT" > $T/suds-static-server.log 2>&1 &
STATIC_SERVER=$!
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$STATIC_PORT/" >/dev/null && break; sleep 0.5; done
export SUDS_STATIC_URL="http://127.0.0.1:$STATIC_PORT"
# qa-retest.mjs replays the tester's upgraded browser profile: the static site of an older commit first,
# then this build (SUDS_STATIC_DIR) at the same origin, on its own port.
export SUDS_STATIC_DIR=$T/suds-static-site SUDS_UPGRADE_PORT=${SUDS_UPGRADE_PORT:-8879}

fail=0; office_dirty=0; reset_secs=0; suite_start=$SECONDS
rows=()
for s in ${SCRIPTS:-desktop review-fixes navigator-flow navigator-fixes ux-features local-mode multitab sync-two-way device-audit spreadsheets sample-data resource-profiles forms region dates setup static-site qa-retest clinical-audit ux-polish signup load-review a11y-round4}; do
  echo "=== $s"
  if [ ! -f "scripts/ui/$s.mjs" ]; then echo "FAILED: no such script scripts/ui/$s.mjs"; rows+=("$s|-|FAIL|0"); fail=1; continue; fi
  # A script that uses the office server starts from the seed, whatever ran before it.
  if grep -q 'SUDS_URL' "scripts/ui/$s.mjs"; then
    if [ "$office_dirty" = 1 ]; then r0=$SECONDS; start_office || { rows+=("$s|-|FAIL|0"); fail=1; continue; }; reset_secs=$((reset_secs + SECONDS - r0)); fi
    office_dirty=1
  fi
  t0=$SECONDS
  if node scripts/ui/$s.mjs > $T/suds-ui-$s.log 2>&1; then result=pass; grep -v '^\[2m' $T/suds-ui-$s.log | tail -6; else result=FAIL; echo "FAILED"; grep -v '^\[2m' $T/suds-ui-$s.log | tail -25; grep -E "^ *FAIL " $T/suds-ui-$s.log | head -10; fail=1; fi
  # "name: 12/12 checks passed" is what makeChecks().finish() prints (scripts/ui/assert.mjs).
  checks=$(grep -oE '[0-9]+/[0-9]+ checks passed' $T/suds-ui-$s.log | tail -1 | cut -d' ' -f1)
  rows+=("$s|${checks:--}|$result|$((SECONDS - t0))")
done

echo
printf '%-20s %9s  %-6s %6s\n' script checks result secs
printf '%-20s %9s  %-6s %6s\n' -------------------- --------- ------ ------
for r in "${rows[@]}"; do IFS='|' read -r n c res sec <<< "$r"; printf '%-20s %9s  %-6s %6s\n' "$n" "$c" "$res" "$sec"; done
echo "total $((SECONDS - suite_start)) s (of which $reset_secs s reseeding the office server between scripts); $( [ $fail = 0 ] && echo 'all passed' || echo 'FAILURES above' )"
exit $fail

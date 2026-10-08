#!/usr/bin/env bash
# npm test on a California evening: TZ=America/Los_Angeles with the clock at 21:00 local today, when the UTC
# date is already tomorrow's. A "today" taken as the UTC date (new Date().toISOString().slice(0, 10), SQLite's
# date('now')) is then a day off from the programme's (server/local-date.js, fmt.today() in the browser), so
# this class of bug fails here, whatever time of day CI happens to run (evaluation of 1.25.0, E1: after 5pm an
# intake was dated tomorrow and CalOMS refused its admission as in the future). CI's `evening` job runs it.
#
# The clock is libfaketime's (the Ubuntu package `faketime`; a test tool on the runner, not a dependency of
# SUDS): one fixed offset for this process and every process it starts, so their clocks agree. Monotonic time
# is left alone (timers). File times are the kernel's and do not move: a test that compares a file's mtime
# with the clock sets that mtime itself (test/instance-lock.test.js).
#
#   scripts/test-evening.sh                      the whole suite (npm test's glob); options alone keep it
#   scripts/test-evening.sh test/episodes.test.js ...
#   SUDS_EVENING_TZ=America/Los_Angeles SUDS_EVENING_AT=21:00 (the defaults) to choose another zone or hour.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v faketime >/dev/null || { echo "test-evening: faketime (libfaketime) is not installed; on Debian or Ubuntu: sudo apt-get install faketime" >&2; exit 2; }
zone="${SUDS_EVENING_TZ:-America/Los_Angeles}"
at="${SUDS_EVENING_AT:-21:00}"
day="$(TZ="$zone" date +%F)"
offset=$(( $(TZ="$zone" date -d "$day $at" +%s) - $(date +%s) ))
spec="$(printf '%+d' "$offset")"
export TZ="$zone" FAKETIME_DONT_FAKE_MONOTONIC=1
# Refuse to pass vacuously: the shifted clock must be in effect, and the local date must differ from the UTC one.
faketime -f "$spec" node -e '
  const d = new Date(); const p = (n) => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; const utc = d.toISOString().slice(0, 10);
  console.log(`test-evening: ${d.toString()} (UTC ${d.toISOString()})`);
  if (local === utc) { console.error(`test-evening: the local date (${local}) is the UTC date: the clock or the zone did not take`); process.exit(1); }
'
# No test files named (only options, such as --test-reporter=spec, or nothing): npm test's glob, so node --test never
# falls back to its own discovery, which also runs test/fixtures/*.js and the thorough tests.
files=0; for a in "$@"; do case "$a" in -*) ;; *) files=1 ;; esac; done
[ "$files" = 1 ] || set -- "$@" 'test/*.test.js'
exec faketime -f "$spec" node --no-warnings=ExperimentalWarning --test "$@"

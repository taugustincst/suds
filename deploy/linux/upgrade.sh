#!/usr/bin/env bash
# SUDS Server: upgrade to another release, with the scripts/update.js sequence made safe for a packaged install
# (docs/SELF-HOSTING.md, "Upgrading"):
#
#   sudo /opt/suds/current/deploy/linux/upgrade.sh 1.18.0 [--source=suds-v1.18.0.zip --release-sha256=HEX] [--dry-run]
#
#  1. stage   the release at /opt/suds/<version>, checked against its SHA-256 (and its pinned Node.js, by checksum)
#  2. stop    SUDS, so nothing is written after the backup
#  3. back up an encrypted backup (scripts/backup.js, as the suds user with the service's keys) — refuse to go on without it
#  4. swap    /opt/suds/current (and /opt/suds/node) to the new release, and its systemd units
#  5. start   and wait for /api/health/ready (migrations run here; SUDS snapshots the database before them)
#  6. roll back if it does not become ready: the previous code, Node and units, the database restored from step 3
#  7. run the compliance check
#
# Never a downgrade (SUDS refuses a database written by a newer version; restore the matching backup instead).
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)
# shellcheck source=deploy/linux/lib.sh
. "$HERE/lib.sh"

VERSION='' RELEASE_ZIP='' RELEASE_SHA256='' NODE_TARBALL='' SKIP_CHECK=0 READY_SECS=300
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --source=*) RELEASE_ZIP=${arg#*=} ;;
    --release-sha256=*) RELEASE_SHA256=${arg#*=} ;;
    --node-tarball=*) NODE_TARBALL=${arg#*=} ;;
    --ready-timeout=*) READY_SECS=${arg#*=} ;;
    --skip-compliance-check) SKIP_CHECK=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) VERSION=$arg ;;
  esac
done
export DRY NODE_TARBALL RELEASE_ZIP RELEASE_SHA256
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: upgrade.sh <version X.Y.Z> [--source=ZIP --release-sha256=HEX] [--dry-run]"
(( DRY )) || [[ $EUID -eq 0 ]] || die "run as root"
detect_os; detect_arch

cur_link=$(readlink "$(P "$CODE_BASE/current")" 2>/dev/null || true)
[[ -n "$cur_link" ]] || die "no $CODE_BASE/current: install first with deploy/linux/install.sh"
CUR=$(basename "$cur_link")
older() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$1" && "$1" != "$2" ]]; }
[[ "$CUR" != "$VERSION" ]] || die "SUDS $VERSION is already the running version"
older "$CUR" "$VERSION" || die "$VERSION is older than the running $CUR: SUDS does not downgrade a database. Restore the backup that matches $VERSION instead (docs/SELF-HOSTING.md, Backup and restore)."
TLS_MODE=$(sed -n 's/^SUDS_TLS_MODE=//p' "$(P "$ETC/suds-server.conf")" 2>/dev/null || echo caddy); export TLS_MODE
say "SUDS Server upgrade: $CUR -> $VERSION"

say ""; say "== 1. Stage $VERSION =="
stage_release "$VERSION"
PIN_TREE=$STAGED_TREE; [[ -f "$PIN_TREE/deploy/linux/pins" ]] || PIN_TREE=$SRC
old_node=$(readlink "$(P "$CODE_BASE/node")" 2>/dev/null || true)
install_node "$PIN_TREE"

say ""; say "== 2-3. Stop SUDS and take a backup =="
act systemctl stop suds.service
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$DATA_DIR/backups/pre-upgrade-$stamp"
act install -d -m 0700 -o "$SUDS_USER" -g "$SUDS_USER" "$(P "$backup_dir")"
if ! as_suds scripts/backup.js "$backup_dir"; then act systemctl start suds.service; die "the backup failed: nothing was changed, SUDS $CUR restarted"; fi
backup_file=''
if (( ! DRY )); then backup_file=$(find "$(P "$backup_dir")" -maxdepth 1 -name 'suds-*.db.enc' -print | sort | tail -n1); [[ -s "$backup_file" ]] || { act systemctl start suds.service; die "no backup file appeared in $backup_dir: nothing was changed"; }; note "backup: $backup_file"; fi

say ""; say "== 4. Switch to $VERSION =="
use_node "$NODE_DIR"
point_current_at "$VERSION"
install_units "$STAGED_TREE"
act sed -i "s/^SUDS_VERSION=.*/SUDS_VERSION=$VERSION/" "$(P "$ETC/suds-server.conf")"
act systemctl daemon-reload

say ""; say "== 5. Start and check =="
act systemctl start suds.service
if wait_ready "$READY_SECS"; then
  note "SUDS $VERSION is ready"
else
  say ""; say "== 6. ROLLING BACK to $CUR =="
  warn "SUDS $VERSION did not become ready within ${READY_SECS}s (journalctl -u suds -n 200)"
  act systemctl stop suds.service
  point_current_at "$CUR"
  [[ -n "$old_node" ]] && use_node "$old_node"
  install_units "$(P "$CODE_BASE/$CUR")"
  act sed -i "s/^SUDS_VERSION=.*/SUDS_VERSION=$CUR/" "$(P "$ETC/suds-server.conf")"
  act systemctl daemon-reload
  # The new version may have migrated the database before failing: put back the backup taken in step 3.
  as_suds scripts/backup.js --restore "${backup_file#"$ROOT"}" "$DATA_DIR/suds.db" || die "the restore of $backup_file failed: SUDS is stopped. Restore it by hand (docs/SELF-HOSTING.md, Backup and restore) before starting SUDS $CUR."
  act systemctl start suds.service
  wait_ready 180 || die "SUDS $CUR did not come back either: journalctl -u suds -n 200"
  die "the upgrade to $VERSION failed and was rolled back: SUDS $CUR is running on the database as it was before the upgrade ($backup_file)."
fi

if (( ! SKIP_CHECK )); then run_compliance_check; fi
say ""; say "Upgraded to $VERSION. The previous release stays in $CODE_BASE/$CUR until you remove it; the pre-upgrade backup is $backup_dir."

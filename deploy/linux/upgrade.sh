#!/usr/bin/env bash
# SUDS Server: upgrade to another release, with the scripts/update.js sequence made safe for a packaged install
# (docs/SELF-HOSTING.md, "Upgrading"):
#
#   sudo /opt/suds/current/deploy/linux/upgrade.sh 1.18.0 --release-sha256=HEX [--source=suds-v1.18.0.zip] [--dry-run]
#
#  1. stage   the release at /opt/suds/<version>, checked against the SHA-256 you give (--release-sha256, from a
#             channel other than the download), and its pinned Node.js and Caddy, by checksum
#  2. stop    SUDS, so nothing is written after the backup
#  3. back up an encrypted backup (scripts/backup.js, as the suds user with the service's keys) — refuse to go on without it
#  4. swap    /opt/suds/current (and /opt/suds/node) to the new release, and its systemd units and Caddyfile
#  5. start   and wait for /api/health/ready (migrations run here; SUDS snapshots the database before them);
#             Caddy is restarted when its pinned version or the Caddyfile changed
#  6. roll back if it does not become ready: the previous code, Node, Caddy and units, and the database put back
#             from step 3 with `scripts/backup.js --restore-in-place`, which never opens the (migrated) live file
#  7. run the compliance check
#
# Options: --source=ZIP, --release-sha256=HEX, --trust-release-checksum (accept the .sha256 from the same release;
# recorded as a warning), --node-tarball=FILE, --caddy-tarball=FILE, --ready-timeout=SECONDS (default 300),
# --skip-compliance-check, --dry-run.
#
# Never a downgrade (SUDS refuses a database written by a newer version; restore the matching backup instead).
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)
# shellcheck source=deploy/linux/lib.sh
. "$HERE/lib.sh"

VERSION='' RELEASE_ZIP='' RELEASE_SHA256='' NODE_TARBALL='' CADDY_TARBALL='' SKIP_CHECK=0 READY_SECS=300 TRUST_RELEASE_CHECKSUM=0 RELEASE_CHECKSUM_SOURCE=''
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --source=*) RELEASE_ZIP=${arg#*=} ;;
    --release-sha256=*) RELEASE_SHA256=${arg#*=} ;;
    --trust-release-checksum) TRUST_RELEASE_CHECKSUM=1 ;;
    --node-tarball=*) NODE_TARBALL=${arg#*=} ;;
    --caddy-tarball=*) CADDY_TARBALL=${arg#*=} ;;
    --ready-timeout=*) READY_SECS=${arg#*=} ;;
    --skip-compliance-check) SKIP_CHECK=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) VERSION=$arg ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: upgrade.sh <version X.Y.Z> --release-sha256=HEX [--source=ZIP] [--dry-run]"
if ! { valid_digits "$READY_SECS" && (( READY_SECS >= 1 )); }; then die "--ready-timeout must be a number of seconds (digits)"; fi
[[ -z "$RELEASE_SHA256" ]] || [[ "$RELEASE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || die "--release-sha256 must be 64 hex characters"
RELEASE_SHA256=$(tr '[:upper:]' '[:lower:]' <<< "$RELEASE_SHA256")
for pair in "--source:$RELEASE_ZIP" "--node-tarball:$NODE_TARBALL" "--caddy-tarball:$CADDY_TARBALL"; do
  [[ -z "${pair#*:}" ]] || need_path "${pair%%:*}" "${pair#*:}"
done
export DRY NODE_TARBALL CADDY_TARBALL RELEASE_ZIP RELEASE_SHA256 TRUST_RELEASE_CHECKSUM
require_root
detect_os; detect_arch

cur_link=$(readlink "$(P "$CODE_BASE/current")" 2>/dev/null || true)
[[ -n "$cur_link" ]] || die "no $CODE_BASE/current: install first with deploy/linux/install.sh"
CUR=$(basename "$cur_link")
older() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$1" && "$1" != "$2" ]]; }
[[ "$CUR" != "$VERSION" ]] || die "SUDS $VERSION is already the running version"
older "$CUR" "$VERSION" || die "$VERSION is older than the running $CUR: SUDS does not downgrade a database. Restore the backup that matches $VERSION instead (docs/SELF-HOSTING.md, Backup and restore)."
TLS_MODE=$(conf_get SUDS_TLS_MODE); TLS_MODE=${TLS_MODE:-caddy}; export TLS_MODE
say "SUDS Server upgrade: $CUR -> $VERSION"

say ""; say "== 1. Stage $VERSION =="
stage_release "$VERSION"
PIN_TREE=$STAGED_TREE; [[ -f "$PIN_TREE/deploy/linux/pins" ]] || PIN_TREE=$SRC
old_node=$(readlink "$(P "$CODE_BASE/node")" 2>/dev/null || true)
install_node "$PIN_TREE"
# Caddy: the new release's pin, and its Caddyfile. Remember the old ones to restart only on a change, and to roll back.
old_caddy=$(readlink "$(P /opt/caddy/current)" 2>/dev/null || true)
caddyfile_changed=0
if [[ "$TLS_MODE" != none ]]; then
  cmp -s "$STAGED_TREE/Caddyfile" "$(P /etc/caddy/Caddyfile)" || caddyfile_changed=1
  install_caddy "$PIN_TREE"
fi
new_caddy=$(readlink "$(P /opt/caddy/current)" 2>/dev/null || true)
caddy_changed=0; [[ "$old_caddy" == "$new_caddy" ]] || caddy_changed=1
(( DRY )) && caddy_changed=1

say ""; say "== 2-3. Stop SUDS and take a backup =="
act systemctl stop suds.service
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$DATA_DIR/backups/pre-upgrade-$stamp"
act install -d -m 0700 -o "$SUDS_USER" -g "$SUDS_USER" "$(P "$DATA_DIR/backups")" "$(P "$backup_dir")"
put_back_caddy() { if [[ -n "$old_caddy" && "$old_caddy" != "$new_caddy" ]]; then act ln -sfn "$(basename "$old_caddy")" "$(P /opt/caddy/current.new)"; act mv -Tf "$(P /opt/caddy/current.new)" "$(P /opt/caddy/current)"; fi; }
if ! as_suds scripts/backup.js "$backup_dir"; then put_back_caddy; act systemctl start suds.service; die "the backup failed: nothing was changed, SUDS $CUR restarted"; fi
backup_file=''
if (( ! DRY )); then backup_file=$(find "$(P "$backup_dir")" -maxdepth 1 -name 'suds-*.db.enc' -print | sort | tail -n1); [[ -s "$backup_file" ]] || { put_back_caddy; act systemctl start suds.service; die "no backup file appeared in $backup_dir: nothing was changed"; }; note "backup: $backup_file"; fi

say ""; say "== 4. Switch to $VERSION =="
use_node "$NODE_DIR"
point_current_at "$VERSION"
install_units "$STAGED_TREE"
conf_set SUDS_VERSION "$VERSION"
[[ -z "$RELEASE_CHECKSUM_SOURCE" ]] || conf_set SUDS_RELEASE_CHECKSUM_SOURCE "$RELEASE_CHECKSUM_SOURCE"
# Passkeys need WEBAUTHN_RP_ID in production; a server installed before 1.20.0 lacks it. From the installed
# domain, unless the operator set it (or WEBAUTHN_ORIGINS).
webauthn_defaults "$(conf_get SUDS_DOMAIN)"
act systemctl daemon-reload

say ""; say "== 5. Start and check =="
act systemctl start suds.service
if wait_ready "$READY_SECS"; then
  note "SUDS $VERSION is ready"
  if (( caddy_changed || caddyfile_changed )); then
    note "Caddy $( (( caddy_changed )) && echo "is now ${CADDY_VERSION_PINNED:-the pinned version}")$( (( caddy_changed && caddyfile_changed )) && echo ' and')$( (( caddyfile_changed )) && echo ' has a new Caddyfile'): restarting it"
    act systemctl restart caddy.service
  fi
else
  say ""; say "== 6. ROLLING BACK to $CUR =="
  warn "SUDS $VERSION did not become ready within ${READY_SECS}s (journalctl -u suds -n 200)"
  act systemctl stop suds.service
  point_current_at "$CUR"
  [[ -n "$old_node" ]] && use_node "$old_node"
  put_back_caddy
  install_units "$(P "$CODE_BASE/$CUR")"
  conf_set SUDS_VERSION "$CUR"
  act systemctl daemon-reload
  # The new version may have migrated the database before failing: put back the backup taken in step 3. The
  # restore never opens the live file (this older code may not be able to read it any more): it moves it and
  # its -wal/-shm aside, sealed, and renames the checked backup into place (server/backup.js restoreInPlace).
  as_suds scripts/backup.js --restore-in-place "${backup_file#"$ROOT"}" || die "the restore of $backup_file failed: SUDS is stopped. Restore it by hand (docs/SELF-HOSTING.md, Backup and restore) before starting SUDS $CUR."
  act systemctl start suds.service
  (( caddy_changed || caddyfile_changed )) && act systemctl restart caddy.service
  wait_ready 180 || die "SUDS $CUR did not come back either: journalctl -u suds -n 200"
  die "the upgrade to $VERSION failed and was rolled back: SUDS $CUR is running on the database as it was before the upgrade ($backup_file)."
fi

if (( ! SKIP_CHECK )); then run_compliance_check; fi
say ""; say "Upgraded to $VERSION. The previous release stays in $CODE_BASE/$CUR until you remove it; the pre-upgrade backup is $backup_dir."

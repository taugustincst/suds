#!/usr/bin/env bash
# SUDS Server: upgrade to another release, with the scripts/update.js sequence made safe for a packaged install
# (docs/SELF-HOSTING.md, "Upgrading"):
#
#   sudo /root/suds-v1.21.0/deploy/linux/upgrade.sh 1.21.0 --source=/root/suds-v1.21.0.zip --release-sha256=HEX [--dry-run]
#
# the NEW release's own script, from its zip unpacked. Run as installed (/opt/suds/current/deploy/linux/upgrade.sh),
# it stages and checks the new release and then hands over to that release's upgrade.sh (from 1.21.0).
#
#  1. stage   the release at /opt/suds/<version>, checked against the SHA-256 you give (--release-sha256, from a
#             channel other than the download), and its pinned Node.js and Caddy, by checksum
#  2. stop    SUDS, so nothing is written after the backup
#  3. back up an encrypted backup (scripts/backup.js, as the suds user with the service's keys) — refuse to go on without it
#  4. swap    /opt/suds/current (and /opt/suds/node) to the new release, and its systemd units and Caddyfile (site
#             blocks an operator appended to /etc/caddy/Caddyfile are moved to /etc/caddy/Caddyfile.d/local.caddy;
#             any other local edit there stops the upgrade before step 2: deploy/linux/README.md)
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
# The upgrade is the new release's to run: it knows what that release needs (1.20.0's adds WEBAUTHN_RP_ID, which the
# 1.19.0 upgrade.sh installed under /opt/suds/current did not). Once the release is staged and checked, a different
# upgrade.sh or lib.sh in it takes over from here, with the same arguments; it finds the stage complete and goes on
# from step 1. Nothing has been stopped or changed yet. SUDS_UPGRADER_HANDOVER marks the hand-over, so it happens once.
staged_upgrader="$STAGED_TREE/deploy/linux/upgrade.sh"
# A dry run from a zip does not unpack it, so it cannot tell whether the release's upgrade.sh differs: it says what the
# real run will do, rather than show only this (installed) upgrader's plan as if it were the one that runs.
if (( DRY )) && [[ -z "${SUDS_UPGRADER_HANDOVER:-}" && ! -f "$staged_upgrader" ]]; then
  printf '+ if SUDS %s'"'"'s own upgrade.sh or lib.sh differs from this one, hand over to it (%s) with the same arguments: the steps below are then that upgrader'"'"'s\n' "$VERSION" "$CODE_BASE/$VERSION/deploy/linux/upgrade.sh"
fi
if [[ -z "${SUDS_UPGRADER_HANDOVER:-}" && -f "$staged_upgrader" && -f "$STAGED_TREE/deploy/linux/lib.sh" ]] \
  && ! { cmp -s "$HERE/upgrade.sh" "$staged_upgrader" && cmp -s "$HERE/lib.sh" "$STAGED_TREE/deploy/linux/lib.sh"; }; then
  if (( DRY )); then
    printf '+ hand over to SUDS %s'"'"'s own upgrade.sh (%s) with the same arguments\n' "$VERSION" "$CODE_BASE/$VERSION/deploy/linux/upgrade.sh"
  else
    note "SUDS $VERSION has its own upgrade.sh: handing over to it ($CODE_BASE/$VERSION/deploy/linux/upgrade.sh)"
    export SUDS_UPGRADER_HANDOVER=1
    exec bash "$staged_upgrader" "$@"
  fi
fi
# An operator's edit to /etc/caddy/Caddyfile, which step 4 replaces: moved to the site-local directory there, or
# refused now, before anything is stopped or changed (lib.sh caddy_local_edits). Never silently discarded.
if [[ "$TLS_MODE" != none ]]; then caddy_local_edits "$(P "$CODE_BASE/$CUR")/Caddyfile" "$STAGED_TREE/Caddyfile"; fi
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
caddy_move_local "$stamp"
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
    caddy_what=''; (( caddy_changed )) && caddy_what="is now ${CADDY_VERSION_PINNED:-the pinned version}"
    (( caddyfile_changed )) && caddy_what="${caddy_what:+$caddy_what and }has a new Caddyfile"
    note "Caddy $caddy_what: restarting it"
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
  # The operator's own Caddyfile, as it was, when step 4 moved its site blocks (the old one does not import them).
  [[ -z "$CADDY_LOCAL_SAVED" ]] || act install -m 0644 -o root -g root "$(P "$CADDY_LOCAL_SAVED")" "$(P /etc/caddy/Caddyfile)"
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

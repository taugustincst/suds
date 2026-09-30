#!/usr/bin/env bash
# SUDS Server: install the SUDS office server on a Linux VM, hardened, in one command (docs/SELF-HOSTING.md).
#
#   sudo deploy/linux/install.sh --domain=suds.county.gov --admin-cidr=10.20.0.0/16 \
#        --offsite=/mnt/suds-offsite --anchors=/mnt/worm/suds-anchors [--tls=caddy|county-cert] [--dry-run]
#
# Ubuntu 24.04 LTS or RHEL/Rocky/Alma 9, x86_64, run as root. Idempotent: run it again to repair a drifted host;
# it never replaces a key, never deletes data. --dry-run prints every action ("+ ...") and changes nothing.
#
# Options
#   --domain=NAME                the DNS name staff use (required)
#   --admin-cidr=CIDR            the only network SSH is allowed from (required)
#   --offsite=DIR                a mounted share on another host/site for the scheduled backups (required)
#   --anchors=DIR                a mounted write-once (WORM) share for audit anchors, outside /var/lib/suds (required)
#   --tls=caddy                  Caddy obtains the certificate (ACME; ports 443 and 80) — the default
#   --tls=county-cert --cert=PEM --key=PEM   a certificate from the county CA (port 443 only)
#   --acme-email=ADDRESS         contact for the ACME account (--tls=caddy)
#   --version=X.Y.Z              the SUDS release to install (default: this tree's package.json version)
#   --source=ZIP --release-sha256=HEX   a downloaded release zip and its checksum (else fetched from GitHub)
#   --node-tarball=FILE          an already-downloaded node-<v>-linux-x64.tar.xz (still checked against the pin)
#   --caddy-tarball=FILE         likewise for Caddy
#   --log-retention-days=N       journal retention (default 400)
#   --metrics                    generate a METRICS_TOKEN credential for GET /api/metrics
#   --accept-unencrypted-disk[=REASON]   continue although /var/lib/suds is not on an encrypted volume (recorded
#                                as an accepted risk in every compliance report; do not use for production PHI)
#   --console-access             allow the firewall to exclude the SSH session this runs from
#   --skip-compliance-check      do not run the compliance check at the end
#   --dry-run                    print the plan, change nothing
#
# SUDS_INSTALL_ROOT prefixes every host path (tests only).
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)
# shellcheck source=deploy/linux/lib.sh
. "$HERE/lib.sh"

DOMAIN='' ADMIN_CIDR='' OFFSITE='' ANCHORS='' TLS_MODE=caddy TLS_CERT='' TLS_KEY='' ACME_EMAIL='' VERSION=''
LOG_DAYS=400 METRICS=0 ACCEPT_UNENC='' CONSOLE=0 SKIP_CHECK=0
RELEASE_ZIP='' RELEASE_SHA256='' NODE_TARBALL='' CADDY_TARBALL=''
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --domain=*) DOMAIN=${arg#*=} ;;
    --admin-cidr=*) ADMIN_CIDR=${arg#*=} ;;
    --offsite=*) OFFSITE=${arg#*=} ;;
    --anchors=*) ANCHORS=${arg#*=} ;;
    --tls=*) TLS_MODE=${arg#*=} ;;
    --cert=*) TLS_CERT=${arg#*=} ;;
    --key=*) TLS_KEY=${arg#*=} ;;
    --acme-email=*) ACME_EMAIL=${arg#*=} ;;
    --version=*) VERSION=${arg#*=} ;;
    --source=*) RELEASE_ZIP=${arg#*=} ;;
    --release-sha256=*) RELEASE_SHA256=${arg#*=} ;;
    --node-tarball=*) NODE_TARBALL=${arg#*=} ;;
    --caddy-tarball=*) CADDY_TARBALL=${arg#*=} ;;
    --log-retention-days=*) LOG_DAYS=${arg#*=} ;;
    --metrics) METRICS=1 ;;
    --accept-unencrypted-disk) ACCEPT_UNENC=yes ;;
    --accept-unencrypted-disk=*) ACCEPT_UNENC=${arg#*=}; ACCEPT_UNENC=${ACCEPT_UNENC//[^A-Za-z0-9 ._,:;()\/-]/} ;;
    --console-access) CONSOLE=1 ;;
    --skip-compliance-check) SKIP_CHECK=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg (see --help)" ;;
  esac
done
export DRY NODE_TARBALL CADDY_TARBALL RELEASE_ZIP RELEASE_SHA256 TLS_MODE
[[ -n "$VERSION" ]] || VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$SRC/package.json")

dry_note=''; if (( DRY )); then dry_note=' (dry run: nothing is changed)'; fi
say "SUDS Server installer — SUDS $VERSION$dry_note"

# ---- 1. Preconditions: refuse early, before anything on the host changes ----
say ""; say "== Checking the host =="
(( DRY )) || [[ $EUID -eq 0 ]] || die "run as root (sudo $0 ...)"
detect_os; note "$OS_PRETTY ($OS_FAMILY family)"
detect_arch
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must be X.Y.Z"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "--domain=<the DNS name staff use> is required (e.g. suds.county.gov)"
[[ "$ADMIN_CIDR" =~ ^[0-9a-fA-F:.]+(/[0-9]{1,3})?$ ]] || die "--admin-cidr=<network SSH is allowed from> is required (e.g. 10.20.0.0/16)"
[[ "$LOG_DAYS" =~ ^[0-9]+$ ]] && (( LOG_DAYS >= 30 )) || die "--log-retention-days must be a number of days, at least 30"
case "$TLS_MODE" in
  caddy) ;;
  county-cert) [[ -r "$TLS_CERT" && -r "$TLS_KEY" ]] || die "--tls=county-cert needs --cert=<PEM chain> and --key=<PEM key>, both readable" ;;
  *) die "--tls must be caddy or county-cert" ;;
esac
[[ "$OFFSITE" == /* && "$ANCHORS" == /* ]] || die "--offsite=<mounted share> and --anchors=<mounted WORM share> are required, as absolute paths"
if path_within "$ANCHORS" "$DATA_DIR" || path_within "$DATA_DIR" "$ANCHORS"; then die "--anchors=$ANCHORS is inside the data directory $DATA_DIR (or contains it): anchors on the same disk as the database catch nothing a rewrite of that disk would hide. Use write-once storage elsewhere."; fi
if path_within "$OFFSITE" "$DATA_DIR" || path_within "$DATA_DIR" "$OFFSITE"; then die "--offsite=$OFFSITE is inside the data directory $DATA_DIR: an offsite copy must survive losing that disk."; fi
if path_within "$OFFSITE" "$ANCHORS" || path_within "$ANCHORS" "$OFFSITE"; then die "--offsite and --anchors must be different storage"; fi
for d in "$ANCHORS" "$OFFSITE"; do
  [[ -d "$(P "$d")" ]] || die "$d does not exist. Mount the share first: SUDS never creates it, because an unmounted share is an empty directory on the local disk."
  is_mountpoint "$d" || die "$d is not a mount point: it would be on this machine's own disk. Mount the share there first (and add it to /etc/fstab)."
done

# Disk encryption cannot be added by an installer after the fact: the data must already be on a LUKS volume.
set +e; enc_evidence=$(disk_encryption "$DATA_DIR"); enc=$?; set -e
note "data volume: $enc_evidence"
if (( enc != 0 )); then
  if [[ -z "$ACCEPT_UNENC" ]]; then
    unknown=''; if (( enc == 2 )); then unknown=' (it could not be determined)'; fi
    die "$DATA_DIR is not on an encrypted (LUKS/dm-crypt) volume$unknown. An installer cannot encrypt a disk in place: attach a LUKS-encrypted data disk and mount it at $DATA_DIR (docs/SELF-HOSTING.md, Prerequisites), then run this again. To continue anyway, knowingly, pass --accept-unencrypted-disk=<reason>; it is recorded as an accepted risk in every compliance report."
  fi
  warn "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  warn "!!! $DATA_DIR IS NOT ON AN ENCRYPTED VOLUME. Client records will sit on this disk unencrypted at rest"
  warn "!!! (only the PHI fields SUDS encrypts itself are protected). Accepted by the operator: $ACCEPT_UNENC"
  warn "!!! Every compliance report will carry this as RISK ACCEPTED until the data is moved to a LUKS volume."
  warn "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
fi

# The firewall will allow SSH from --admin-cidr only: refuse to cut off the session running this.
if [[ -n "${SSH_CONNECTION:-}" ]] && (( ! CONSOLE )); then
  client=${SSH_CONNECTION%% *}
  set +e; ip_in_cidr "$client" "$ADMIN_CIDR"; inside=$?; set -e
  if (( inside == 1 )); then die "this SSH session comes from $client, outside --admin-cidr=$ADMIN_CIDR: the firewall would lock it out. Run from the administration network, fix --admin-cidr, or pass --console-access if you have console access."; fi
  (( inside == 2 )) && warn "could not tell whether $client is inside $ADMIN_CIDR (not IPv4): make sure it is before the firewall is enabled"
fi

# A database already here was written with keys: never mint new ones over it.
existing_db=0; [[ -s "$(P "$DATA_DIR/suds.db")" ]] && existing_db=1

# ---- 2. OS packages (from the distribution's signed repositories) ----
say ""; say "== Packages =="
if [[ $OS_FAMILY == debian ]]; then
  act env DEBIAN_FRONTEND=noninteractive apt-get update -q
  act env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ca-certificates curl xz-utils unzip ufw unattended-upgrades systemd-timesyncd
else
  act dnf install -y -q ca-certificates curl xz unzip tar firewalld chrony dnf-automatic
fi

# ---- 3. Code, Node.js and Caddy: SUDS at /opt/suds/<version> (root-owned, read-only); Node.js and Caddy the
# releases pinned in that version's deploy/linux/pins, each checked against its pinned checksum ----
say ""; say "== Staging SUDS $VERSION =="
stage_release "$VERSION"
PIN_TREE=$STAGED_TREE; [[ -f "$PIN_TREE/deploy/linux/pins" ]] || PIN_TREE=$SRC
say ""; say "== Node.js (pinned: $(pin NODE_VERSION "$PIN_TREE")) =="
install_node "$PIN_TREE"
use_node "$NODE_DIR"
say ""; say "== Caddy (pinned: $(pin CADDY_VERSION "$PIN_TREE")) =="
install_caddy "$PIN_TREE"

# ---- 4. Accounts and directories ----
say ""; say "== Service account and directories =="
if id -u "$SUDS_USER" >/dev/null 2>&1; then note "user $SUDS_USER exists"; else act useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SUDS_USER"; fi
if id -u caddy >/dev/null 2>&1; then note "user caddy exists"; else act useradd --system --user-group --home-dir /var/lib/caddy --no-create-home --shell /usr/sbin/nologin caddy; fi
act install -d -m 0700 -o "$SUDS_USER" -g "$SUDS_USER" "$(P "$DATA_DIR")"
act install -d -m 0700 -o caddy -g caddy "$(P /var/lib/caddy)"
act install -d -m 0755 -o root -g root "$(P "$ETC")" "$(P /etc/caddy)" "$(P "$CODE_BASE")" "$(P /opt/caddy)"
act install -d -m 0700 -o root -g root "$(P "$CRED_DIR")"
# Existing files in the data directory: owned by the service user, never readable by anyone else.
if [[ -d "$(P "$DATA_DIR")" ]]; then
  act chown -R "$SUDS_USER:$SUDS_USER" "$(P "$DATA_DIR")"
  act chmod -R go-rwx "$(P "$DATA_DIR")"
fi
# The shares must be writable by the service user (tested as that user; nothing is written there by this script).
for d in "$ANCHORS" "$OFFSITE"; do
  if (( DRY )); then printf '+ check %s is writable by %s\n' "$d" "$SUDS_USER"; elif ! runuser -u "$SUDS_USER" -- test -w "$d"; then die "$d is not writable by the $SUDS_USER user: give it write access on the share (and nothing more on the anchor share: write-once)"; fi
done

# ---- 5. Code: /opt/suds/<version> is live from here on ----
say ""; say "== SUDS $VERSION =="
point_current_at "$VERSION"

# ---- 6. Keys: root-only files, loaded by systemd LoadCredential= ----
say ""; say "== Keys =="
new_keys=()
if (( existing_db )) && [[ ! -e "$(P "$CRED_DIR/suds_encryption_key")" ]]; then
  # A wizard install (data/keys.json) being moved under the installer: its keys come across; nothing new.
  kj="$(P "$DATA_DIR/keys.json")"
  [[ -r "$kj" ]] || die "$DATA_DIR/suds.db exists but there is no key for it here (no $CRED_DIR/suds_encryption_key, no keys.json). Put the escrowed keys in $CRED_DIR (one file per key, 64 hex characters, root 0600) and run this again. Never start this database with new keys."
  for k in "${KEY_NAMES[@]}"; do
    var=$(tr '[:lower:]' '[:upper:]' <<< "$k")
    if (( DRY )); then printf '+ copy %s from keys.json into %s (mode 0600, owner root:root)\n' "$var" "$(P "$CRED_DIR/$k")"; continue; fi
    val=$("$CODE_BASE/node/bin/node" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]]||"";process.stdout.write(/^[0-9a-fA-F]{64}$/.test(v)?v:"")' "$kj" "$var")
    if [[ -n "$val" ]]; then (umask 077; printf '%s' "$val" > "$(P "$CRED_DIR/$k")"); chmod 0600 "$(P "$CRED_DIR/$k")"; note "$k taken from keys.json"; fi
    unset val
  done
  warn "the keys were copied from $DATA_DIR/keys.json. Once SUDS has started and Security status is clean, and the keys are escrowed, remove keys.json (shred -u) so no key sits beside the data."
fi
for k in "${KEY_NAMES[@]}"; do
  if [[ "$k" == suds_encryption_key || "$k" == suds_index_key ]] && (( existing_db )) && [[ ! -e "$(P "$CRED_DIR/$k")" ]] && (( ! DRY )); then die "$k is missing for an existing database: restore it from escrow into $CRED_DIR/$k"; fi
  if gen_key "$(P "$CRED_DIR/$k")"; then new_keys+=("$k"); fi
done
if (( METRICS )); then if gen_key "$(P "$CRED_DIR/suds_metrics_token")"; then new_keys+=(suds_metrics_token); fi; fi
act chmod 0600 "$(P "$CRED_DIR")"/suds_*
act chown root:root "$(P "$CRED_DIR")"/suds_*

# ---- 7. Configuration (no secrets in any of these files) ----
say ""; say "== Configuration =="
metrics_cred=''; metrics_lines=''
if (( METRICS )); then metrics_cred=' suds_metrics_token'; metrics_lines="LoadCredential=suds_metrics_token:$CRED_DIR/suds_metrics_token
Environment=METRICS_TOKEN_FILE=%d/suds_metrics_token"; fi
put_file "$(P "$ETC/suds.env")" 0644 root:root <<EOF
# SUDS Server environment (non-secret), written by deploy/linux/install.sh. Keys are NOT here: they are
# systemd credentials (/etc/suds/credentials, LoadCredential= in suds.service). Never add a key to this file.
TRUST_PROXY=1
LOCAL_MODE_ENABLED=false
MFA_REQUIRED_ROLES=admin,supervisor,clinician,navigator,finance,readonly
AUDIT_ANCHOR_DIR=$ANCHORS
SUDS_PROVISION_FILE=$ETC/provision.json
SUDS_SKIP_SETUP=1
EOF
put_file "$(P "$ETC/provision.json")" 0644 root:root <<EOF
{
  "_comment": "Settings SUDS applies at start where none has been chosen yet (server/provision.js). Change them afterwards under Settings.",
  "settings": {
    "backup_schedule_hours": "4",
    "backup_offsite_dir": "$OFFSITE",
    "dr_drill_monthly": "1",
    "mfa_require_all": "1"
  }
}
EOF
put_file "$(P "$ETC/suds-server.conf")" 0644 root:root <<EOF
# SUDS Server site settings, written by deploy/linux/install.sh and read by scripts/compliance-check.js. Not secret.
SUDS_VERSION=$VERSION
SUDS_DOMAIN=$DOMAIN
SUDS_TLS_MODE=$TLS_MODE
SUDS_ADMIN_CIDR=$ADMIN_CIDR
SUDS_DATA_DIR=$DATA_DIR
SUDS_ANCHOR_DIR=$ANCHORS
SUDS_OFFSITE_DIR=$OFFSITE
SUDS_CREDENTIALS_DIR=$CRED_DIR
SUDS_CREDENTIALS=${KEY_NAMES[*]}$metrics_cred
SUDS_NODE_BIN=$CODE_BASE/node/bin/node
SUDS_LOG_RETENTION_DAYS=$LOG_DAYS
SUDS_ACCEPT_UNENCRYPTED_DISK=$ACCEPT_UNENC
SUDS_INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
act install -d -m 0755 -o root -g root "$(P /etc/systemd/system/suds.service.d)"
put_file "$(P /etc/systemd/system/suds.service.d/10-site.conf)" 0644 root:root <<EOF
# This site's mounts for suds.service (deploy/linux/install.sh). The unit itself is deploy/linux/suds.service.
[Unit]
RequiresMountsFor=$ANCHORS $OFFSITE
[Service]
ReadWritePaths=$ANCHORS $OFFSITE
$metrics_lines
EOF

# TLS: Caddy with the repository's Caddyfile; TLS 1.2+ only; HSTS from the Caddyfile.
if [[ $TLS_MODE == county-cert ]]; then
  act install -d -m 0750 -o root -g caddy "$(P /etc/caddy/tls)"
  act install -m 0644 -o root -g caddy "$TLS_CERT" "$(P /etc/caddy/tls/cert.pem)"
  act install -m 0640 -o root -g caddy "$TLS_KEY" "$(P /etc/caddy/tls/key.pem)"
  tls_directive="tls /etc/caddy/tls/cert.pem /etc/caddy/tls/key.pem {"
else
  tls_directive="tls${ACME_EMAIL:+ $ACME_EMAIL} {"
fi
put_file "$(P /etc/caddy/suds-tls.caddy)" 0644 root:root <<EOF
$tls_directive
	protocols tls1.2 tls1.3
}
EOF
put_file "$(P /etc/caddy/suds.env)" 0644 root:root <<EOF
SUDS_DOMAIN=$DOMAIN
SUDS_UPSTREAM=127.0.0.1:8080
SUDS_CADDY_TLS=/etc/caddy/suds-tls.caddy
SUDS_CADDY_ADMIN=off
EOF

# ---- 8. Host hardening: firewall, time, updates, journal ----
ports='443'; if [[ $TLS_MODE == caddy ]]; then ports='443 and 80'; fi
say ""; say "== Firewall ($ports; SSH from $ADMIN_CIDR only) =="
if [[ $OS_FAMILY == debian ]]; then
  act ufw default deny incoming
  act ufw default allow outgoing
  act ufw allow proto tcp from "$ADMIN_CIDR" to any port 22 comment 'SUDS Server: SSH from the administration network'
  act ufw allow 443/tcp comment 'SUDS Server: HTTPS'
  if [[ $TLS_MODE == caddy ]]; then act ufw allow 80/tcp comment 'SUDS Server: redirect and ACME'; else act ufw delete allow 80/tcp || true; fi
  for r in OpenSSH 22/tcp 22; do act ufw delete allow "$r" >/dev/null 2>&1 || true; done
  act ufw --force enable
else
  act systemctl enable --now firewalld
  zone=$( (( DRY )) && echo public || firewall-cmd --get-default-zone)
  family=ipv4; [[ "$ADMIN_CIDR" == *:* ]] && family=ipv6
  act firewall-cmd --permanent --zone="$zone" --add-service=https
  if [[ $TLS_MODE == caddy ]]; then act firewall-cmd --permanent --zone="$zone" --add-service=http; else act firewall-cmd --permanent --zone="$zone" --remove-service=http; fi
  act firewall-cmd --permanent --zone="$zone" --add-rich-rule="rule family=\"$family\" source address=\"$ADMIN_CIDR\" service name=\"ssh\" accept"
  act firewall-cmd --permanent --zone="$zone" --remove-service=ssh
  act firewall-cmd --permanent --zone="$zone" --remove-service=cockpit
  act firewall-cmd --reload
fi

say ""; say "== Time synchronisation (audit timestamps depend on it) =="
if [[ $OS_FAMILY == debian ]]; then act systemctl enable --now systemd-timesyncd; else act systemctl enable --now chronyd; fi
act timedatectl set-ntp true

say ""; say "== Automatic security updates (security only) =="
if [[ $OS_FAMILY == debian ]]; then
  put_file "$(P /etc/apt/apt.conf.d/20auto-upgrades)" 0644 root:root <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  act systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
else
  act sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' "$(P /etc/dnf/automatic.conf)"
  act systemctl enable --now dnf-automatic.timer
fi

say ""; say "== System journal: persistent, kept $LOG_DAYS days =="
act install -d -m 0755 -o root -g root "$(P /etc/systemd/journald.conf.d)"
put_file "$(P /etc/systemd/journald.conf.d/suds.conf)" 0644 root:root <<EOF
# SUDS Server (deploy/linux/install.sh): the journal survives reboots and keeps $LOG_DAYS days.
[Journal]
Storage=persistent
MaxRetentionSec=${LOG_DAYS}d
EOF
act install -d -m 2755 -o root -g systemd-journal "$(P /var/log/journal)"
act systemctl restart systemd-journald
if ! command -v auditd >/dev/null 2>&1 && [[ ! -x "$(P /sbin/auditd)" ]]; then note "recommended, not required: install auditd so the OS records logins, sudo and changes to /etc/suds"; fi

# ---- 9. Services ----
say ""; say "== Services =="
install_units "$STAGED_TREE"
act systemctl daemon-reload
act systemctl enable --now suds.service
act systemctl enable --now caddy.service
act systemctl enable --now suds-compliance.timer
act systemctl restart caddy.service
if ! wait_ready 180; then die "SUDS did not become ready within 3 minutes: journalctl -u suds -n 100"; fi
note "SUDS is up on 127.0.0.1:8080, served at https://$DOMAIN"

# ---- 10. What only the operator can do ----
if (( ${#new_keys[@]} )); then
  say ""
  say "==================================================================================================="
  say " KEY ESCROW — YOUR STEP, NOW. New keys were generated: ${new_keys[*]}"
  say " They are in $CRED_DIR (root only). Without them no backup can ever be restored and no record read."
  say " Copy that directory to your key custodian's escrow (the county secrets manager, or an encrypted"
  say " medium in a safe) as your key-custody procedure says, record who holds it, and prove it with a recovery"
  say " drill using the escrowed copy (Settings > System & backups). This installer does not do it for you."
  say " The values were not printed and are not in any log."
  say "==================================================================================================="
fi
if [[ -e "$(P "$DATA_DIR/first-admin-password.txt")" ]] || (( DRY )); then
  say ""; say "First sign-in: the temporary administrator password is in $DATA_DIR/first-admin-password.txt (sudo cat it once; it is deleted when changed). Sign in at https://$DOMAIN, change it and enrol two-step verification."
fi

if (( ! SKIP_CHECK )); then run_compliance_check; fi
say ""; say "Done. Upgrade with deploy/linux/upgrade.sh <version>; the weekly compliance report is on Settings > Security status."

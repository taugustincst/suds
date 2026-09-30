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
#   --admin-cidr=CIDR            the only network SSH is allowed from (required; a re-run with another CIDR
#                                removes the previous rule)
#   --offsite=DIR                a mounted share on another host/site for the scheduled backups (required)
#   --anchors=DIR                a mounted write-once (WORM) share for audit anchors, outside /var/lib/suds (required)
#   --tls=caddy                  Caddy obtains the certificate (ACME; ports 443 and 80) — the default
#   --tls=county-cert --cert=PEM --key=PEM   a certificate from the county CA (port 443 only)
#   --acme-email=ADDRESS         contact for the ACME account (--tls=caddy)
#   --ca-file=PEM                the county CA certificate, so the compliance check trusts a privately issued certificate
#   --connect-host=HOST          where the compliance check connects to test TLS (default: the domain)
#   --ntp-server=HOST[,HOST]     the county time source(s) (default: the distribution's pool)
#   --version=X.Y.Z              the SUDS release to install (default: this tree's package.json version)
#   --source=ZIP --release-sha256=HEX   a downloaded release zip and its SHA-256, from a channel other than the
#                                download (else the zip is fetched from GitHub; --release-sha256 is still required)
#   --trust-release-checksum     accept the .sha256 file from the same release instead (recorded as a warning)
#   --node-tarball=FILE          an already-downloaded node-<v>-linux-x64.tar.xz (still checked against the pin)
#   --caddy-tarball=FILE         likewise for Caddy
#   --log-retention-days=N       journal retention (default 400)
#   --journal-max-use=SIZE       the journal's disk cap, e.g. 8G (default 8G; docs/SELF-HOSTING.md, Sizing)
#   --metrics                    generate a METRICS_TOKEN credential for GET /api/metrics
#   --accept-unencrypted-disk[=REASON]   continue although /var/lib/suds is not on an encrypted volume (recorded
#                                as an accepted risk in every compliance report; do not use for production PHI)
#   --console-access             you are at the console: skip the check that the firewall will not cut off SSH
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
LOG_DAYS=400 JOURNAL_MAX=8G METRICS=0 ACCEPT_UNENC='' CONSOLE=0 SKIP_CHECK=0 CA_FILE='' CONNECT_HOST='' NTP_SERVERS=''
RELEASE_ZIP='' RELEASE_SHA256='' NODE_TARBALL='' CADDY_TARBALL='' TRUST_RELEASE_CHECKSUM=0 RELEASE_CHECKSUM_SOURCE=''
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
    --ca-file=*) CA_FILE=${arg#*=} ;;
    --connect-host=*) CONNECT_HOST=${arg#*=} ;;
    --ntp-server=*) NTP_SERVERS=${arg#*=} ;;
    --version=*) VERSION=${arg#*=} ;;
    --source=*) RELEASE_ZIP=${arg#*=} ;;
    --release-sha256=*) RELEASE_SHA256=${arg#*=} ;;
    --trust-release-checksum) TRUST_RELEASE_CHECKSUM=1 ;;
    --node-tarball=*) NODE_TARBALL=${arg#*=} ;;
    --caddy-tarball=*) CADDY_TARBALL=${arg#*=} ;;
    --log-retention-days=*) LOG_DAYS=${arg#*=} ;;
    --journal-max-use=*) JOURNAL_MAX=${arg#*=} ;;
    --metrics) METRICS=1 ;;
    --accept-unencrypted-disk) ACCEPT_UNENC=yes ;;
    --accept-unencrypted-disk=*) ACCEPT_UNENC=${arg#*=}; ACCEPT_UNENC=${ACCEPT_UNENC//[^A-Za-z0-9 ._,:;()\/-]/} ;;
    --console-access) CONSOLE=1 ;;
    --skip-compliance-check) SKIP_CHECK=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg (see --help)" ;;
  esac
done
[[ -n "$VERSION" ]] || VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$SRC/package.json")

dry_note=''; if (( DRY )); then dry_note=' (dry run: nothing is changed)'; fi
say "SUDS Server installer — SUDS $VERSION$dry_note"

# ---- 1. Preconditions: refuse early, before anything on the host changes ----
say ""; say "== Checking the host =="
require_root
detect_os; note "$OS_PRETTY ($OS_FAMILY family)"
detect_arch
# Every value that reaches a file, a unit or a command: a whitelist, not an escape.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must be X.Y.Z"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "--domain=<the DNS name staff use> is required (e.g. suds.county.gov)"
[[ "$ADMIN_CIDR" =~ ^[0-9a-fA-F:.]+(/[0-9]{1,3})?$ ]] || die "--admin-cidr=<network SSH is allowed from> is required (e.g. 10.20.0.0/16)"
valid_digits "$LOG_DAYS" && (( LOG_DAYS >= 30 )) || die "--log-retention-days must be a number of days (digits), at least 30"
valid_size "$JOURNAL_MAX" || die "--journal-max-use must be a size such as 8G (digits and an optional K, M, G or T)"
[[ -z "$ACME_EMAIL" ]] || valid_email "$ACME_EMAIL" || die "--acme-email must be an e-mail address (got: $(printf '%q' "$ACME_EMAIL"))"
[[ -z "$CONNECT_HOST" ]] || valid_host "$CONNECT_HOST" || die "--connect-host must be a host name or IP address"
if [[ -n "$NTP_SERVERS" ]]; then for s in ${NTP_SERVERS//,/ }; do valid_host "$s" || die "--ntp-server must be host names or IP addresses, separated by commas"; done; fi
[[ -z "$RELEASE_SHA256" ]] || [[ "$RELEASE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || die "--release-sha256 must be 64 hex characters"
RELEASE_SHA256=$(tr '[:upper:]' '[:lower:]' <<< "$RELEASE_SHA256")
[[ -n "$OFFSITE" && -n "$ANCHORS" ]] || die "--offsite=<mounted share> and --anchors=<mounted WORM share> are required, as absolute paths"
need_path --offsite "$OFFSITE"; need_path --anchors "$ANCHORS"
for pair in "--cert:$TLS_CERT" "--key:$TLS_KEY" "--ca-file:$CA_FILE" "--source:$RELEASE_ZIP" "--node-tarball:$NODE_TARBALL" "--caddy-tarball:$CADDY_TARBALL"; do
  [[ -z "${pair#*:}" ]] || need_path "${pair%%:*}" "${pair#*:}"
done
[[ -z "$CA_FILE" || -r "$CA_FILE" ]] || die "--ca-file=$CA_FILE is not readable"
case "$TLS_MODE" in
  caddy) ;;
  county-cert) [[ -r "$TLS_CERT" && -r "$TLS_KEY" ]] || die "--tls=county-cert needs --cert=<PEM chain> and --key=<PEM key>, both readable" ;;
  *) die "--tls must be caddy or county-cert" ;;
esac
export DRY NODE_TARBALL CADDY_TARBALL RELEASE_ZIP RELEASE_SHA256 TLS_MODE TRUST_RELEASE_CHECKSUM
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
  warn "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  warn "!!! $DATA_DIR IS NOT ON AN ENCRYPTED VOLUME. Client records will sit on this disk unencrypted at rest"
  warn "!!! (only the PHI fields SUDS encrypts itself are protected). Accepted by the operator: $ACCEPT_UNENC"
  warn "!!! Every compliance report will carry this as RISK ACCEPTED until the data is moved to a LUKS volume."
  warn "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
fi

# The firewall will allow SSH from --admin-cidr only: refuse to cut off this session, or any other SSH session.
# Under sudo SSH_CONNECTION is gone (env_reset): lib.sh ssh_lockout_guard also asks who -m, the parent
# processes and ss; if none can say, it refuses unless --console-access.
ssh_lockout_guard "$ADMIN_CIDR" "$CONSOLE"

# A database already here was written with keys: never mint new ones over it.
existing_db=0; [[ -s "$(P "$DATA_DIR/suds.db")" ]] && existing_db=1
# What a previous run recorded: the first install's date, the SSH rule to replace, settings not given again.
PREV_ADMIN_CIDR=$(conf_get SUDS_ADMIN_CIDR); INSTALLED_AT=$(conf_get SUDS_INSTALLED_AT)
[[ -n "$CONNECT_HOST" ]] || CONNECT_HOST=$(conf_get SUDS_CONNECT_HOST)
[[ -n "$NTP_SERVERS" ]] || NTP_SERVERS=$(conf_get SUDS_NTP_SERVERS)
ca_conf=''; if [[ -n "$CA_FILE" ]]; then ca_conf=$ETC/ca.pem; else ca_conf=$(conf_get SUDS_CA_FILE); fi
[[ "$INSTALLED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# chrony already there (Ubuntu images often have it): keep it, and do not install systemd-timesyncd beside it.
use_chrony=0
if [[ $OS_FAMILY == rhel ]] || [[ -x "$(P /usr/sbin/chronyd)" ]] || systemctl is-active --quiet chrony 2>/dev/null; then use_chrony=1; fi

# ---- 2. OS packages (from the distribution's signed repositories) ----
say ""; say "== Packages =="
curl_pkg=(curl); if command -v curl >/dev/null 2>&1; then curl_pkg=(); fi  # RHEL ships curl-minimal: installing curl would conflict
if [[ $OS_FAMILY == debian ]]; then
  time_pkg=(systemd-timesyncd); (( use_chrony )) && time_pkg=()
  act env DEBIAN_FRONTEND=noninteractive apt-get update -q
  act env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ca-certificates "${curl_pkg[@]}" xz-utils unzip ufw unattended-upgrades "${time_pkg[@]}"
else
  act dnf install -y -q ca-certificates "${curl_pkg[@]}" xz unzip tar firewalld chrony dnf-automatic
fi

# ---- 3. Code, Node.js and Caddy: SUDS at /opt/suds/<version> (root-owned, read-only); Node.js and Caddy the
# releases pinned in that version's deploy/linux/pins, each checked against its pinned checksum ----
say ""; say "== Staging SUDS $VERSION =="
stage_release "$VERSION"
[[ -n "$RELEASE_CHECKSUM_SOURCE" ]] || RELEASE_CHECKSUM_SOURCE=$(conf_get SUDS_RELEASE_CHECKSUM_SOURCE)
PIN_TREE=$STAGED_TREE; [[ -f "$PIN_TREE/deploy/linux/pins" ]] || PIN_TREE=$SRC
say ""; say "== Node.js (pinned: $(pin NODE_VERSION "$PIN_TREE")) =="
install_node "$PIN_TREE"
use_node "$NODE_DIR"
say ""; say "== Caddy (pinned: $(pin CADDY_VERSION "$PIN_TREE")) =="
install_caddy "$PIN_TREE"

# ---- 4. Accounts and directories: code 0755 root; data 0700 suds; credentials 0700 root ----
say ""; say "== Service account and directories =="
if id -u "$SUDS_USER" >/dev/null 2>&1; then note "user $SUDS_USER exists"; else act useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SUDS_USER"; fi
if id -u caddy >/dev/null 2>&1; then note "user caddy exists"; else act useradd --system --user-group --home-dir /var/lib/caddy --no-create-home --shell /usr/sbin/nologin caddy; fi
act install -d -m 0700 -o "$SUDS_USER" -g "$SUDS_USER" "$(P "$DATA_DIR")"
act install -d -m 0700 -o caddy -g caddy "$(P /var/lib/caddy)"
act install -d -m 0755 -o root -g root "$(P "$ETC")" "$(P /etc/caddy)" "$(P "$CODE_BASE")" "$(P /opt/caddy)"
act install -d -m 0700 -o root -g root "$(P "$CRED_DIR")"
# The compliance reports: written by root, readable by the suds group (Security status), writable by no one else.
act install -d -m 0750 -o root -g "$SUDS_USER" "$(P "$COMPLIANCE_DIR")"
# Existing files in the data directory: owned by the service user, never readable by anyone else.
if [[ -d "$(P "$DATA_DIR")" ]]; then
  act chown -R "$SUDS_USER:$SUDS_USER" "$(P "$DATA_DIR")"
  act chmod -R go-rwx "$(P "$DATA_DIR")"
fi
# The shares must be writable by the service user (tested as that user; nothing is written there by this script).
for d in "$ANCHORS" "$OFFSITE"; do
  if (( DRY )); then printf '+ check %s is writable by %s\n' "$d" "$SUDS_USER"; elif ! runuser -u "$SUDS_USER" -- test -w "$(P "$d")"; then die "$d is not writable by the $SUDS_USER user: give it write access on the share (and nothing more on the anchor share: write-once)"; fi
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
    val=$("$(P "$CODE_BASE/node/bin/node")" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]]||"";process.stdout.write(/^[0-9a-fA-F]{64}$/.test(v)?v:"")' "$kj" "$var")
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
# The compliance check's own signing key: root only, outside the credentials the service is given, so the
# service it audits can never sign a report about itself. Its public half is readable, for SUDS and the auditor.
if gen_key "$(P "$COMPLIANCE_KEY")"; then new_keys+=(compliance-signing-key); fi
if (( DRY )); then
  printf '+ write %s (mode 0644, owner root:root): the public half of %s\n' "$(P "$COMPLIANCE_PUB")" "$COMPLIANCE_KEY"
else
  pub=$("$(P "$CODE_BASE/node/bin/node")" -e 'const s=Buffer.from(require("fs").readFileSync(process.argv[1],"utf8").trim(),"hex");const i=require(process.argv[2]).publicInfo(s);process.stdout.write(i.public_key_pem+"\n# key id "+i.key_id)' "$(P "$COMPLIANCE_KEY")" "$STAGED_TREE/server/signing.js")
  compliance_key_id=${pub##*# key id }
  put_file "$(P "$COMPLIANCE_PUB")" 0644 root:root <<< "${pub%$'\n'# key id *}"
  note "compliance signing key id $compliance_key_id (public key $COMPLIANCE_PUB: give it to your auditor)"
fi

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
SUDS_COMPLIANCE_DIR=$COMPLIANCE_DIR
SUDS_COMPLIANCE_PUBLIC_KEY_FILE=$COMPLIANCE_PUB
EOF
# JSON by construction: every value escaped (and whitelisted above).
put_file "$(P "$ETC/provision.json")" 0644 root:root <<EOF
{
  "_comment": "Settings SUDS applies at start where none has been chosen yet (server/provision.js; it only tightens). Change them afterwards under Settings.",
  "settings": {
    "backup_schedule_hours": "4",
    "backup_offsite_dir": $(json_str "$OFFSITE"),
    "dr_drill_monthly": "1",
    "mfa_require_all": "1"
  }
}
EOF
if [[ -n "$CA_FILE" ]]; then act install -m 0644 -o root -g root "$CA_FILE" "$(P "$ETC/ca.pem")"; fi
managed=(SUDS_VERSION SUDS_DOMAIN SUDS_TLS_MODE SUDS_ADMIN_CIDR SUDS_DATA_DIR SUDS_ANCHOR_DIR SUDS_OFFSITE_DIR SUDS_CREDENTIALS_DIR SUDS_CREDENTIALS
  SUDS_NODE_BIN SUDS_LOG_RETENTION_DAYS SUDS_JOURNAL_MAX_USE SUDS_ACCEPT_UNENCRYPTED_DISK SUDS_INSTALLED_AT SUDS_LAST_INSTALL_RUN SUDS_COMPLIANCE_DIR
  SUDS_COMPLIANCE_SIGNING_KEY_FILE SUDS_CA_FILE SUDS_CONNECT_HOST SUDS_NTP_SERVERS SUDS_RELEASE_CHECKSUM_SOURCE)
kept=$(conf_unmanaged "${managed[@]}")
put_file "$(P "$ETC/suds-server.conf")" 0644 root:root <<EOF
# SUDS Server site settings, written by deploy/linux/install.sh and read by scripts/compliance-check.js. Not secret.
# Lines with other keys are kept when the installer runs again.
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
SUDS_JOURNAL_MAX_USE=$JOURNAL_MAX
SUDS_ACCEPT_UNENCRYPTED_DISK=$ACCEPT_UNENC
SUDS_COMPLIANCE_DIR=$COMPLIANCE_DIR
SUDS_COMPLIANCE_SIGNING_KEY_FILE=$COMPLIANCE_KEY
SUDS_CA_FILE=$ca_conf
SUDS_CONNECT_HOST=$CONNECT_HOST
SUDS_NTP_SERVERS=$NTP_SERVERS
SUDS_RELEASE_CHECKSUM_SOURCE=$RELEASE_CHECKSUM_SOURCE
SUDS_INSTALLED_AT=$INSTALLED_AT
SUDS_LAST_INSTALL_RUN=$(date -u +%Y-%m-%dT%H:%M:%SZ)
$kept
EOF
act install -d -m 0755 -o root -g root "$(P /etc/systemd/system)" "$(P /etc/systemd/system/suds.service.d)"
# The anchors are required (RequiresMountsFor): without the WORM share there is no tamper evidence. The offsite
# share is optional to the service ("-" prefix): an outage there fails the offsite copy (reported by Security
# status, /api/health and the compliance check), never SUDS itself.
put_file "$(P /etc/systemd/system/suds.service.d/10-site.conf)" 0644 root:root <<EOF
# This site's mounts for suds.service (deploy/linux/install.sh). The unit itself is deploy/linux/suds.service.
[Unit]
RequiresMountsFor=$ANCHORS
[Service]
ReadWritePaths=$ANCHORS -$OFFSITE
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
# quiet_act: a best-effort command whose failure (e.g. a rule that is not there) is expected; shown in a dry run.
quiet_act() { if (( DRY )); then act "$@"; else "$@" >/dev/null 2>&1 || true; fi; }
if [[ $OS_FAMILY == debian ]]; then
  act ufw default deny incoming
  act ufw default allow outgoing
  act ufw allow proto tcp from "$ADMIN_CIDR" to any port 22 comment 'SUDS Server: SSH from the administration network'
  act ufw allow 443/tcp comment 'SUDS Server: HTTPS'
  if [[ $TLS_MODE == caddy ]]; then act ufw allow 80/tcp comment 'SUDS Server: redirect and ACME'; else quiet_act ufw delete allow 80/tcp; fi
  for r in OpenSSH 22/tcp 22; do quiet_act ufw delete allow "$r"; done
  if [[ -n "$PREV_ADMIN_CIDR" && "$PREV_ADMIN_CIDR" != "$ADMIN_CIDR" ]]; then note "removing the previous SSH rule for $PREV_ADMIN_CIDR"; quiet_act ufw delete allow proto tcp from "$PREV_ADMIN_CIDR" to any port 22; fi
  act ufw --force enable
else
  act systemctl enable --now firewalld
  zone=$( (( DRY )) && echo public || firewall-cmd --get-default-zone)
  rich() { local fam=ipv4; [[ "$1" == *:* ]] && fam=ipv6; printf 'rule family="%s" source address="%s" service name="ssh" accept' "$fam" "$1"; }
  act firewall-cmd --permanent --zone="$zone" --add-service=https
  if [[ $TLS_MODE == caddy ]]; then act firewall-cmd --permanent --zone="$zone" --add-service=http; else act firewall-cmd --permanent --zone="$zone" --remove-service=http; fi
  act firewall-cmd --permanent --zone="$zone" --add-rich-rule="$(rich "$ADMIN_CIDR")"
  if [[ -n "$PREV_ADMIN_CIDR" && "$PREV_ADMIN_CIDR" != "$ADMIN_CIDR" ]]; then note "removing the previous SSH rule for $PREV_ADMIN_CIDR"; quiet_act firewall-cmd --permanent --zone="$zone" --remove-rich-rule="$(rich "$PREV_ADMIN_CIDR")"; fi
  act firewall-cmd --permanent --zone="$zone" --remove-service=ssh
  act firewall-cmd --permanent --zone="$zone" --remove-service=cockpit
  act firewall-cmd --reload
fi

say ""; say "== Time synchronisation (audit timestamps depend on it) =="
ntp_lines=''; for s in ${NTP_SERVERS//,/ }; do ntp_lines+="server $s iburst prefer"$'\n'; done
if [[ $OS_FAMILY == debian ]] && (( ! use_chrony )); then
  if [[ -n "$NTP_SERVERS" ]]; then
    act install -d -m 0755 -o root -g root "$(P /etc/systemd/timesyncd.conf.d)"
    put_file "$(P /etc/systemd/timesyncd.conf.d/suds.conf)" 0644 root:root <<EOF
[Time]
NTP=${NTP_SERVERS//,/ }
EOF
  fi
  act systemctl enable --now systemd-timesyncd
  [[ -z "$NTP_SERVERS" ]] || act systemctl restart systemd-timesyncd
  act timedatectl set-ntp true
elif [[ $OS_FAMILY == debian ]]; then
  note "chrony is installed: it keeps the time (systemd-timesyncd is not installed beside it)"
  if [[ -n "$NTP_SERVERS" ]]; then
    act install -d -m 0755 -o root -g root "$(P /etc/chrony/sources.d)"
    put_file "$(P /etc/chrony/sources.d/suds.sources)" 0644 root:root <<< "${ntp_lines%$'\n'}"
  fi
  act systemctl enable --now chrony
  [[ -z "$NTP_SERVERS" ]] || act systemctl restart chrony
else
  if [[ -n "$NTP_SERVERS" ]]; then
    act install -d -m 0755 -o root -g root "$(P /etc/chrony.d)"
    put_file "$(P /etc/chrony.d/suds.conf)" 0644 root:root <<< "${ntp_lines%$'\n'}"
    ensure_line "$(P /etc/chrony.conf)" 'include /etc/chrony.d/*.conf'
  fi
  act systemctl enable --now chronyd
  [[ -z "$NTP_SERVERS" ]] || act systemctl restart chronyd
  act timedatectl set-ntp true
fi

say ""; say "== Automatic security updates (security only) =="
if [[ $OS_FAMILY == debian ]]; then
  act install -d -m 0755 -o root -g root "$(P /etc/apt/apt.conf.d)"
  put_file "$(P /etc/apt/apt.conf.d/20auto-upgrades)" 0644 root:root <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  act systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
else
  act sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' "$(P /etc/dnf/automatic.conf)"
  act systemctl enable --now dnf-automatic.timer
fi

say ""; say "== System journal: persistent, kept $LOG_DAYS days, at most $JOURNAL_MAX =="
act install -d -m 0755 -o root -g root "$(P /etc/systemd/journald.conf.d)"
put_file "$(P /etc/systemd/journald.conf.d/suds.conf)" 0644 root:root <<EOF
# SUDS Server (deploy/linux/install.sh): the journal survives reboots and keeps $LOG_DAYS days, within $JOURNAL_MAX
# of disk (--journal-max-use; the compliance check warns if the cap deletes entries before $LOG_DAYS days).
[Journal]
Storage=persistent
MaxRetentionSec=${LOG_DAYS}d
SystemMaxUse=$JOURNAL_MAX
EOF
act install -d -m 2755 -o root -g systemd-journal "$(P /var/log/journal)"
act systemctl restart systemd-journald
if ! command -v auditd >/dev/null 2>&1 && [[ ! -x "$(P /sbin/auditd)" ]]; then note "recommended, not required: install auditd so the OS records logins, sudo and changes to /etc/suds"; fi

# ---- 9. Services ----
say ""; say "== Services =="
install_units "$STAGED_TREE"
# SELinux (RHEL): files unpacked or moved into place keep the label of where they came from; relabel them.
if [[ $OS_FAMILY == rhel ]] && command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce 2>/dev/null)" == Enforcing ]]; then
  act restorecon -R "$(P "$CODE_BASE")" "$(P /opt/caddy)" "$(P "$ETC")" "$(P /etc/caddy)" "$(P "$DATA_DIR")" "$(P "$COMPLIANCE_DIR")" "$(P /var/lib/caddy)" "$(P /etc/systemd/system)"
fi
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
  say " The compliance signing key ($COMPLIANCE_KEY) stays on this host; give its public key"
  say " ($COMPLIANCE_PUB) and key id to your auditor. The values were not printed and are not in any log."
  say "==================================================================================================="
fi
if [[ -e "$(P "$DATA_DIR/first-admin-password.txt")" ]] || (( DRY )); then
  say ""; say "First sign-in: the temporary administrator password is in $DATA_DIR/first-admin-password.txt (sudo cat it once; it is deleted when changed). Sign in at https://$DOMAIN, change it and enrol two-step verification."
fi

if (( ! SKIP_CHECK )); then run_compliance_check; fi
say ""; say "Done. On a new server the first scheduled backup (within 4 hours) and the first recovery drill (within a month, or run one now) show as \"pending first run\" until they have run. Upgrade with deploy/linux/upgrade.sh <version>; the weekly compliance report is on Settings > Security status."

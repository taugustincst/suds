# shellcheck shell=bash
# shellcheck disable=SC2034,SC2012  # names read by the scripts that source this file; ls -ld reads modes portably
# Shared by deploy/fleet/provision-tenant.sh, decommission-tenant.sh and escrow.sh. Sourced, never run.
# Reuses deploy/linux/lib.sh's helpers (say, note, warn, die, act, quoted, json_str, valid_email).
#
# Everything private (tenant settings, the register, escrow, credentials) lives under FLEET_HOME, a private
# directory OUTSIDE this public repository; every script refuses to run otherwise (deploy/fleet/README.md).
umask 077
FLEET_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "$FLEET_DIR/../.." && pwd -P)
# shellcheck source=deploy/linux/lib.sh
. "$FLEET_DIR/../linux/lib.sh"
DRY=1
POLL=${FLEET_POLL_SECONDS:-10} TRIES=${FLEET_POLL_TRIES:-90}
TAB=$'\t'
ZERO=$(printf '%064d' 0)
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
step() { say ""; say "== $* =="; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0; }
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# Mode bits as ls shows them: "other" must have none (directories), group and other none (secret files).
no_other() { [[ $(ls -ld "$1" | cut -c8-10) == --- ]]; }
private_file() { [[ -f "$1" && $(ls -ld "$1" | cut -c5-10) == ------ ]]; }
WHO=$(printf '%s@%s' "${FLEET_OPERATOR:-$(id -un)}" "$(hostname 2>/dev/null || echo unknown)" | tr -cd 'A-Za-z0-9@._-')

# FLEET_HOME: set, a directory, not inside this repository's working tree (nor any clone of SUDS), not world-readable.
fleet_home_ok() {
  local top
  [[ -n "${FLEET_HOME:-}" ]] || die "FLEET_HOME is not set: point it at the private ops directory (deploy/fleet/README.md, Prerequisites)"
  [[ -d "$FLEET_HOME" ]] || die "FLEET_HOME=$FLEET_HOME is not a directory"
  FLEET_HOME=$(cd "$FLEET_HOME" && pwd -P)
  case "$FLEET_HOME/" in "$REPO_ROOT"/*) die "FLEET_HOME=$FLEET_HOME is inside this repository's working tree ($REPO_ROOT). Tenant records, escrow and credentials must never be where a commit can publish them: use a private directory elsewhere." ;; esac
  top=$(git -C "$FLEET_HOME" rev-parse --show-toplevel 2>/dev/null || true)
  [[ -z "$top" || ! -e "$top/deploy/fleet/provision-tenant.sh" ]] || die "FLEET_HOME=$FLEET_HOME is inside a clone of SUDS ($top): use the private ops directory"
  no_other "$FLEET_HOME" || die "FLEET_HOME=$FLEET_HOME is readable by other users ($(ls -ld "$FLEET_HOME" | cut -c1-10)): chmod 0700 it"
  ESC_LOG=$FLEET_HOME/escrow/access.log
}

# under_home PATH — PATH (relative to FLEET_HOME, or absolute) resolved; refused unless inside FLEET_HOME.
under_home() {
  local p=$1 d; [[ "$p" == /* ]] || p=$FLEET_HOME/$p
  d=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P) || die "$1: no such directory"
  case "$d/" in "$FLEET_HOME"/*) printf '%s/%s' "$d" "$(basename "$p")" ;; *) die "$1 is outside FLEET_HOME ($FLEET_HOME)" ;; esac
}

KNOWN='TENANT_SLUG TENANT_DOMAIN DNS_ZONE WWW_REDIRECT ADMIN_CIDR ADMIN_CIDR6 ACME_EMAIL REGION AVAILABILITY_ZONE LIGHTSAIL_BUNDLE LIGHTSAIL_BLUEPRINT LIGHTSAIL_KEY_PAIR SSH_USER SUDS_VERSION RELEASE_SHA256 RELEASE_ZIP DATA_DISK_GB OFFSITE_DISK_GB ANCHORS_DISK_GB SSH_KEY_FILE PORKBUN_CREDENTIALS ESCROW_GPG_RECIPIENT'
# load_tenant FILE — read KEY=value lines (never sourced: nothing in it runs), check every value, derive the names.
load_tenant() {
  local f=$1 line k v
  [[ -n "$f" ]] || die "give the tenant's settings file (a copy of deploy/fleet/tenant.env.example in FLEET_HOME)"
  fleet_home_ok
  [[ "$f" == /* ]] || f=$PWD/$f; [[ -f "$f" ]] || die "$f does not exist"
  f=$(under_home "$f")
  for k in $KNOWN; do printf -v "$k" '%s' ''; done
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%%#*}; line=${line%"${line##*[![:space:]]}"}
    [[ -n "$line" ]] || continue
    [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] || die "$f: not a KEY=value line: $line"
    k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}; v=${v#\"}; v=${v%\"}
    [[ " $KNOWN " == *" $k "* ]] || die "$f: unknown setting $k (see deploy/fleet/tenant.env.example)"
    printf -v "$k" '%s' "$v"
  done < "$f"
  SLUG=$TENANT_SLUG
  [[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,28}[a-z0-9]$ && "$SLUG" != www ]] || die "TENANT_SLUG must be 3-30 lowercase letters, digits and hyphens"
  DNS_ZONE=${DNS_ZONE:-suds.systems}; TENANT_DOMAIN=${TENANT_DOMAIN:-$SLUG.$DNS_ZONE}
  TENANT_DOMAIN=${TENANT_DOMAIN,,}; DNS_ZONE=${DNS_ZONE,,}
  for v in "$TENANT_DOMAIN" "$DNS_ZONE"; do [[ "$v" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "not a domain name: $v"; done
  WWW_REDIRECT=${WWW_REDIRECT:-no}; [[ "$WWW_REDIRECT" =~ ^(yes|no)$ ]] || die "WWW_REDIRECT must be yes or no"
  [[ "$ADMIN_CIDR" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "ADMIN_CIDR must be an IPv4 network such as 203.0.113.10/32"
  [[ "$ADMIN_CIDR6" =~ ^[0-9a-fA-F:]*:[0-9a-fA-F:]*/[0-9]{1,3}$ ]] || die "ADMIN_CIDR6 must be an IPv6 network such as 2001:db8:1::/48 (SSH must be allowed on IPv4 and IPv6)"
  [[ -z "$ACME_EMAIL" ]] || valid_email "$ACME_EMAIL" || die "ACME_EMAIL is not an e-mail address"
  [[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "REGION must be an AWS region such as us-west-2"
  [[ "$AVAILABILITY_ZONE" =~ ^${REGION}[a-z]$ ]] || die "AVAILABILITY_ZONE must be in $REGION (e.g. ${REGION}a)"
  LIGHTSAIL_BLUEPRINT=${LIGHTSAIL_BLUEPRINT:-ubuntu_24_04}; SSH_USER=${SSH_USER:-ubuntu}
  for k in LIGHTSAIL_BUNDLE LIGHTSAIL_BLUEPRINT LIGHTSAIL_KEY_PAIR SSH_USER; do [[ "${!k}" =~ ^[A-Za-z0-9._-]+$ ]] || die "$k must be set (letters, digits, . _ -)"; done
  [[ "$SUDS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "SUDS_VERSION must be X.Y.Z (pinned per tenant)"
  RELEASE_SHA256=${RELEASE_SHA256,,}; [[ "$RELEASE_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "RELEASE_SHA256 must be the 64-hex SHA-256 of suds-v$SUDS_VERSION.zip, from the GitHub Release notes AND the version's CHANGELOG section on main"
  DATA_DISK_GB=${DATA_DISK_GB:-64} OFFSITE_DISK_GB=${OFFSITE_DISK_GB:-32} ANCHORS_DISK_GB=${ANCHORS_DISK_GB:-8}
  for k in DATA_DISK_GB OFFSITE_DISK_GB ANCHORS_DISK_GB; do valid_digits "${!k}" || die "$k must be a number of GB"; done
  (( OFFSITE_DISK_GB >= 8 && ANCHORS_DISK_GB >= 8 )) || die "the offsite and anchor disks must be at least 8 GB"
  (( OFFSITE_DISK_GB != ANCHORS_DISK_GB && DATA_DISK_GB != OFFSITE_DISK_GB && DATA_DISK_GB != ANCHORS_DISK_GB )) || die "DATA_DISK_GB, OFFSITE_DISK_GB and ANCHORS_DISK_GB must differ: the VM tells the disks apart by size"
  ESCROW_GPG_RECIPIENT=${ESCROW_GPG_RECIPIENT^^}; [[ "$ESCROW_GPG_RECIPIENT" =~ ^[0-9A-F]{40}$ ]] || die "ESCROW_GPG_RECIPIENT must be the owner's escrow key: its full 40-hex fingerprint"
  [[ -n "$SSH_KEY_FILE" && -n "$PORKBUN_CREDENTIALS" && -n "$RELEASE_ZIP" ]] || die "SSH_KEY_FILE, PORKBUN_CREDENTIALS and RELEASE_ZIP must be set"
  SSH_KEY=$(under_home "$SSH_KEY_FILE"); PB_FILE=$(under_home "$PORKBUN_CREDENTIALS")
  ZIP=$RELEASE_ZIP; [[ "$ZIP" == /* ]] || ZIP=$FLEET_HOME/$ZIP
  INSTANCE=suds-$SLUG; IP_NAME=$INSTANCE-ip; IP='<static-ip>'
  DISKS=(); (( DATA_DISK_GB > 0 )) && DISKS+=("data:$DATA_DISK_GB:/dev/xvdf"); DISKS+=("offsite:$OFFSITE_DISK_GB:/dev/xvdg" "anchors:$ANCHORS_DISK_GB:/dev/xvdh")
  NAMES=("$TENANT_DOMAIN"); [[ $WWW_REDIRECT == yes ]] && NAMES+=("www.$TENANT_DOMAIN")
  DNS_AUTO=0; [[ "$TENANT_DOMAIN" == "$DNS_ZONE" || "$TENANT_DOMAIN" == *".$DNS_ZONE" ]] && DNS_AUTO=1
  REG_DIR=$FLEET_HOME/register; REC=$REG_DIR/$SLUG.env; HIST=$REG_DIR/$SLUG.log; ESC_DIR=$FLEET_HOME/escrow/$SLUG
  SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$FLEET_HOME/known_hosts")
}

# ---- the register (one KEY=value file per tenant, plus its hash-chained history) and the escrow log ----
rec_get() { [[ -f "$REC" ]] || return 0; sed -n "s/^$1=//p" "$REC" | tail -n1; }
rec_set() {
  if (( DRY )); then printf '+ register %s:' "$REC"; printf ' %s=%s' "$@"; printf '\n'; return 0; fi
  install -d -m 0700 "$REG_DIR"
  [[ -f "$REC" ]] || printf '%s\n' "# SUDS tenant record (deploy/fleet). Private: never in the public repository." \
    "# The owner fills BAA_STATUS and QSOA_STATUS, and before teardown EXPORT_FILE, EXPORT_SHA256 and EXPORT_CONFIRMED_ON (YYYY-MM-DD)." \
    BAA_STATUS= QSOA_STATUS= EXPORT_FILE= EXPORT_SHA256= EXPORT_CONFIRMED_ON= > "$REC"
  local tmp=$REC.new.$$; cp "$REC" "$tmp"
  while (( $# )); do { grep -v "^$1=" "$tmp" || true; printf '%s=%s\n' "$1" "$2"; } > "$tmp.2"; mv "$tmp.2" "$tmp"; shift 2; done
  mv "$tmp" "$REC"
}
# chain FILE TEXT — append "TIME by=WHO TEXT prev=<SHA-256 of the previous line>": a hash chain, so an edited or
# removed line shows (escrow.sh verify). Append-only by convention and by evidence.
chain() {
  local prev=$ZERO; [[ -s "$1" ]] && prev=$(tail -n1 "$1" | sha256_of -)
  if (( DRY )); then printf '+ append to %s: %s\n' "$1" "$2"; return 0; fi
  install -d -m 0700 "$(dirname "$1")"
  printf '%s by=%s %s prev=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WHO" "$2" "$prev" >> "$1"
}

# ---- AWS Lightsail ----
ls_() { act aws --region "$REGION" lightsail "$@"; }
# lsq ARGS — a query's text output; "NotFound" when the resource does not exist; nothing in a dry run or on error.
lsq() {
  local out; (( DRY )) && return 0
  if out=$(aws --region "$REGION" lightsail "$@" --output text 2>&1); then printf '%s' "$out"
  elif [[ "$out" == *NotFound* || "$out" == *"does not exist"* ]]; then printf 'NotFound'; fi
}
exists() { local o; (( DRY )) && return 1; o=$(lsq "$@"); [[ -n "$o" && "$o" != NotFound ]]; }
# wait_eq WANT DESC ARGS — poll lsq ARGS until it answers WANT.
wait_eq() {
  local want=$1 desc=$2 got='' i; shift 2
  if (( DRY )); then printf '+ until aws lightsail %s answers %q (%s)\n' "$(quoted "$@")" "$want" "$desc"; return 0; fi
  for ((i = 0; i < TRIES; i++)); do got=$(lsq "$@"); [[ "$got" == "$want" ]] && { note "$desc"; return 0; }; sleep "$POLL"; done
  fail "$desc: still \"$got\", not \"$want\", after $TRIES tries"
}

# ---- DNS at Porkbun: the API key and secret go in the JSON body on stdin, never in argv or a log ----
load_porkbun() {
  private_file "$PB_FILE" || die "$PB_FILE must exist and be mode 0600 (PORKBUN_API_KEY=..., PORKBUN_SECRET_API_KEY=...)"
  PB_KEY=$(sed -n 's/^PORKBUN_API_KEY=//p' "$PB_FILE" | tail -n1); PB_SECRET=$(sed -n 's/^PORKBUN_SECRET_API_KEY=//p' "$PB_FILE" | tail -n1)
  [[ "$PB_KEY" =~ ^[A-Za-z0-9_]+$ && "$PB_SECRET" =~ ^[A-Za-z0-9_]+$ ]] || die "$PB_FILE must hold PORKBUN_API_KEY= and PORKBUN_SECRET_API_KEY="
}
# porkbun PATH [JSON-FIELDS] — POST to https://api.porkbun.com/api/json/v3/dns/PATH; fails unless "status":"SUCCESS".
porkbun() {
  local url=https://api.porkbun.com/api/json/v3/dns/$1 out
  if (( DRY )); then printf '+ curl -fsS -X POST %s --data @- (JSON on stdin: the key and secret from %s%s)\n' "$url" "$PB_FILE" "${2:+, $2}"; return 0; fi
  out=$(printf '{"apikey":%s,"secretapikey":%s%s}' "$(json_str "$PB_KEY")" "$(json_str "$PB_SECRET")" "${2:+,$2}" |
    curl -fsS --proto '=https' --tlsv1.2 --max-time 30 -X POST -H 'Content-Type: application/json' --data @- "$url") || fail "Porkbun $1: the request failed"
  [[ "$out" == *'"status":"SUCCESS"'* || "$out" == *'"status": "SUCCESS"'* ]] || fail "Porkbun $1: $out"
  printf '%s' "$out"
}
# The Porkbun subdomain of FQDN within DNS_ZONE ("" for the zone apex).
sub_of() { if [[ "$1" == "$DNS_ZONE" ]]; then printf ''; else printf '%s' "${1%."$DNS_ZONE"}"; fi; }
# Secure delete (GNU shred, or BSD rm -P). On SSDs and copy-on-write filesystems no overwrite is certain: what makes
# the keys unrecoverable is that the escrow copy is encrypted and every copy of it, offline ones too, is destroyed.
shred_file() { if command -v shred >/dev/null 2>&1; then shred -u -z "$1"; else rm -P "$1"; fi; }

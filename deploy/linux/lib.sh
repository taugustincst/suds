# shellcheck shell=bash
# Shared by deploy/linux/install.sh, upgrade.sh and uninstall.sh. Sourced, never run.
#
# Two conventions make the scripts testable (test/deploy-linux.test.js):
#   * every path on the host goes through P, which prefixes SUDS_INSTALL_ROOT (empty in production), so a
#     dry run can be pointed at a fake root filesystem;
#   * every command that changes the host goes through act (or put_file / gen_key), which under --dry-run
#     prints it ("+ ...") instead of running it. Commands that only look (findmnt, lsblk, id, mountpoint)
#     run in a dry run too, so the refusals are the real ones.

ROOT="${SUDS_INSTALL_ROOT:-}"
DRY=${DRY:-0}
SUDS_USER=suds
DATA_DIR=/var/lib/suds
CODE_BASE=/opt/suds
ETC=/etc/suds
CRED_DIR=/etc/suds/credentials
KEY_NAMES=(suds_encryption_key suds_index_key suds_backup_key suds_signing_key)
GITHUB_REPO="${SUDS_GITHUB_REPO:-taugustincst/suds}"

P() { printf '%s%s' "$ROOT" "$1"; }
say() { printf '%s\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }

# Print a command the way a shell would read it back.
quoted() { local out='' a; for a in "$@"; do out+="$(printf '%q' "$a") "; done; printf '%s' "${out% }"; }
act() {
  if (( DRY )); then printf '+ %s\n' "$(quoted "$@")"; else "$@"; fi
}
# put_file DEST MODE OWNER[:GROUP] <<< content — atomic (write beside, then rename), never partly written.
put_file() {
  local dest=$1 mode=$2 owner=$3 content
  content=$(cat)
  if (( DRY )); then printf '+ write %s (mode %s, owner %s, %s bytes)\n' "$dest" "$mode" "$owner" "${#content}"; return 0; fi
  local tmp="${dest}.suds-new.$$"
  (umask 077; printf '%s\n' "$content" > "$tmp")
  chown "$owner" "$tmp"; chmod "$mode" "$tmp"; mv -f "$tmp" "$dest"
}
# gen_key DEST — 32 random bytes as 64 hex characters, root 0600. Never printed, never logged, never replaced.
gen_key() {
  local dest=$1
  if [[ -e "$dest" ]]; then note "$(basename "$dest") exists: kept (keys are never regenerated)"; return 1; fi
  if (( DRY )); then printf '+ generate 32 random bytes as hex into %s (mode 0600, owner root:root)\n' "$dest"; return 0; fi
  local tmp="${dest}.suds-new.$$"
  (umask 077; od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$tmp")
  [[ $(wc -c < "$tmp") -eq 64 ]] || { rm -f "$tmp"; die "could not generate $(basename "$dest")"; }
  chown root:root "$tmp"; chmod 0600 "$tmp"; mv -n "$tmp" "$dest"
  return 0
}

# ---- facts about the host (read-only; run in a dry run too) ----
detect_os() {
  local f; f=$(P /etc/os-release)
  [[ -r "$f" ]] || die "cannot read /etc/os-release: SUDS Server supports Ubuntu 24.04 LTS and RHEL/Rocky/Alma 9"
  local id ver pretty
  id=$(sed -n 's/^ID=//p' "$f" | tr -d '"'); ver=$(sed -n 's/^VERSION_ID=//p' "$f" | tr -d '"'); pretty=$(sed -n 's/^PRETTY_NAME=//p' "$f" | tr -d '"')
  case "$id:$ver" in
    ubuntu:24.04) OS_FAMILY=debian ;;
    rhel:9*|rocky:9*|almalinux:9*) OS_FAMILY=rhel ;;
    *) die "${pretty:-$id $ver} is not supported. SUDS Server installs on Ubuntu 24.04 LTS or RHEL/Rocky/Alma Linux 9 only (docs/SELF-HOSTING.md). On anything else, follow docs/DEPLOYMENT.md by hand." ;;
  esac
  OS_PRETTY=${pretty:-$id $ver}
}
detect_arch() {
  local m; m=$(uname -m)
  [[ "$m" == x86_64 ]] || die "this machine is $m. The pinned Node.js and Caddy releases (deploy/linux/pins) are for x86_64 (linux-x64) only."
}
# pin NAME — a value from deploy/linux/pins of the given code tree (default this one).
pin() { sed -n "s/^$1=//p" "${2:-$SRC}/deploy/linux/pins"; }

# The block devices under a directory (or its nearest existing ancestor): 0 when one of them is dm-crypt,
# 1 when none is, 2 when it cannot be told. The evidence goes to stdout.
disk_encryption() {
  local dir=$1 probe src fstype chain
  probe=$dir; while [[ ! -e "$(P "$probe")" && "$probe" != / ]]; do probe=$(dirname "$probe"); done
  command -v findmnt >/dev/null 2>&1 || { echo "findmnt is not installed"; return 2; }
  read -r src fstype < <(findmnt -n -o SOURCE,FSTYPE --target "$(P "$probe")" 2>/dev/null) || true
  src=${src%%\[*}
  [[ -n "$src" ]] || { echo "findmnt could not resolve $probe"; return 2; }
  [[ "$src" == /dev/* ]] || { echo "$probe is on $fstype from $src (not a local block device)"; return 2; }
  chain=$(lsblk -s -n -r -o NAME,TYPE "$src" 2>/dev/null | awk '{printf "%s(%s) ", $1, $2}')
  echo "$probe is on $src ($fstype): ${chain:-no lsblk output}"
  [[ "$chain" == *"(crypt)"* ]] && return 0
  return 1
}
# Is $1 inside $2 (or the same), after resolving both? Either way round counts as the same disk for our purposes.
path_within() {
  local a b
  a=$(realpath -m "$1"); b=$(realpath -m "$2")
  [[ "$a" == "$b" || "$a" == "$b"/* ]]
}
is_mountpoint() { command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$(P "$1")"; }
# IPv4 address in CIDR? (0 yes, 1 no, 2 not IPv4)
ip_in_cidr() {
  local ip=$1 cidr=$2 net bits a b c d n1 n2 mask
  [[ "$ip" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 2
  a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
  n1=$(( (a << 24) | (b << 16) | (c << 8) | d ))
  net=${cidr%/*}; bits=${cidr#*/}; [[ "$cidr" == */* ]] || bits=32
  [[ "$net" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 2
  n2=$(( (BASH_REMATCH[1] << 24) | (BASH_REMATCH[2] << 16) | (BASH_REMATCH[3] << 8) | BASH_REMATCH[4] ))
  (( bits == 0 )) && return 0
  mask=$(( (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
  (( (n1 & mask) == (n2 & mask) ))
}

# ---- downloads, each checked against a pinned checksum before it is used ----
# fetch URL DEST — HTTPS only, TLS 1.2+, no redirects to plain HTTP.
fetch() { act curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"; }
# verify_sum sha256|sha512 FILE HEX — refuses on a mismatch; in a dry run a file that does not exist yet is planned.
verify_sum() {
  local algo=$1 file=$2 want=$3 have
  if [[ ! -f "$file" ]]; then
    (( DRY )) && { printf '+ %s\n' "$(quoted "${algo}sum" -c) <<< \"$want  $(basename "$file")\" (refuse on mismatch)"; return 0; }
    die "$file is missing"
  fi
  have=$("${algo}sum" "$file" | awk '{print $1}')
  [[ "$have" == "$want" ]] || die "checksum mismatch for $(basename "$file"): expected ${algo} $want, got $have. Refusing to install it (a corrupted or substituted download)."
  note "$(basename "$file"): ${algo} matches the pinned checksum"
}

# install_node CODE_TREE — the Node.js release pinned in CODE_TREE/deploy/linux/pins, into /opt/suds/node-<v>.
# NODE_TARBALL (install.sh --node-tarball) supplies the file for an offline install; it is checked all the same.
install_node() {
  local tree=$1 ver sum dir file tmp
  ver=$(pin NODE_VERSION "$tree"); sum=$(pin NODE_SHA256_LINUX_X64 "$tree")
  [[ "$ver" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$sum" =~ ^[0-9a-f]{64}$ ]] || die "deploy/linux/pins in $tree has no valid Node.js pin"
  dir="$CODE_BASE/node-$ver"; file="node-$ver-linux-x64.tar.xz"
  if [[ -x "$(P "$dir/bin/node")" ]] && [[ "$("$(P "$dir/bin/node")" --version 2>/dev/null)" == "$ver" ]]; then note "Node.js $ver already installed"; NODE_DIR=$dir; return 0; fi
  tmp=$(mktemp -d)
  if [[ -n "${NODE_TARBALL:-}" ]]; then cp "$NODE_TARBALL" "$tmp/$file"; else fetch "https://nodejs.org/dist/$ver/$file" "$tmp/$file"; fi
  verify_sum sha256 "$tmp/$file" "$sum"
  act mkdir -p "$(P "$dir")"
  act tar -xJf "$tmp/$file" -C "$(P "$dir")" --strip-components=1 --no-same-owner
  act chown -R root:root "$(P "$dir")"
  act chmod -R a-w "$(P "$dir")"
  rm -rf "$tmp"
  NODE_DIR=$dir
}
use_node() { act ln -sfn "$1" "$(P "$CODE_BASE/node.new")"; act mv -Tf "$(P "$CODE_BASE/node.new")" "$(P "$CODE_BASE/node")"; }

install_caddy() {
  local tree=$1 ver sum dir file tmp
  ver=$(pin CADDY_VERSION "$tree"); sum=$(pin CADDY_SHA512_LINUX_AMD64 "$tree")
  [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$sum" =~ ^[0-9a-f]{128}$ ]] || die "deploy/linux/pins has no valid Caddy pin"
  dir="/opt/caddy/$ver"; file="caddy_${ver}_linux_amd64.tar.gz"
  if [[ -x "$(P "$dir/caddy")" ]]; then note "Caddy $ver already installed"; else
    tmp=$(mktemp -d)
    if [[ -n "${CADDY_TARBALL:-}" ]]; then cp "$CADDY_TARBALL" "$tmp/$file"; else fetch "https://github.com/caddyserver/caddy/releases/download/v$ver/$file" "$tmp/$file"; fi
    verify_sum sha512 "$tmp/$file" "$sum"
    act mkdir -p "$(P "$dir")"
    act tar -xzf "$tmp/$file" -C "$(P "$dir")" --no-same-owner caddy
    act chown -R root:root "$(P "$dir")"
    act chmod 0755 "$(P "$dir/caddy")"
    rm -rf "$tmp"
  fi
  act ln -sfn "$dir" "$(P /opt/caddy/current.new)"; act mv -Tf "$(P /opt/caddy/current.new)" "$(P /opt/caddy/current)"
}

# stage_release VERSION — puts the code for VERSION at /opt/suds/VERSION (root-owned, read-only) and sets
# STAGED_TREE to a tree of it to read files from. From this tree when it is that version; else from RELEASE_ZIP
# (--source), or the GitHub release, checked against RELEASE_SHA256 (--release-sha256) or the .sha256 file
# published beside the zip.
stage_release() {
  local ver=$1 dest="$CODE_BASE/$1" src_ver tmp zip want top from
  if [[ -d "$(P "$dest")" ]]; then note "SUDS $ver already at $dest"; STAGED_TREE=$(P "$dest"); return 0; fi
  src_ver=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$SRC/package.json")
  if [[ "$src_ver" == "$ver" && -z "${RELEASE_ZIP:-}" ]]; then
    note "installing SUDS $ver from $SRC"
    from=$SRC
  else
    tmp=$(mktemp -d)
    zip=${RELEASE_ZIP:-$tmp/suds-v$ver.zip}
    if [[ -z "${RELEASE_ZIP:-}" ]]; then
      fetch "https://github.com/$GITHUB_REPO/releases/download/v$ver/suds-v$ver.zip" "$zip"
      if [[ -z "${RELEASE_SHA256:-}" ]]; then fetch "https://github.com/$GITHUB_REPO/releases/download/v$ver/suds-v$ver.zip.sha256" "$zip.sha256"; fi
    fi
    want=${RELEASE_SHA256:-}
    if [[ -z "$want" && -f "$zip.sha256" ]]; then want=$(awk '{print $1}' "$zip.sha256"); fi
    if [[ -z "$want" ]]; then
      if (( DRY )); then want="<the SHA-256 in suds-v$ver.zip.sha256>"; else die "no checksum for suds-v$ver.zip: pass --release-sha256=<hex> (from the release page) or put suds-v$ver.zip.sha256 beside it"; fi
    elif [[ ! "$want" =~ ^[0-9a-f]{64}$ ]]; then die "the release checksum is not a SHA-256"; fi
    verify_sum sha256 "$zip" "$want"
    if (( DRY )); then
      printf '+ unzip -q %s -d %s\n' "$zip" "$tmp"; from="$tmp/suds-v$ver"
    else
      command -v unzip >/dev/null 2>&1 || die "unzip is needed to unpack a release zip"
      unzip -q "$zip" -d "$tmp"
      top=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)
      [[ -f "$top/package.json" ]] || die "suds-v$ver.zip does not contain a SUDS release"
      grep -q "\"version\": \"$ver\"" "$top/package.json" || die "suds-v$ver.zip is not version $ver"
      from=$top
    fi
  fi
  act mkdir -p "$(P "$dest")"
  if (( DRY )); then
    printf '+ copy %s into %s (without .git, node_modules, data, test)\n' "$from" "$(P "$dest")"
    STAGED_TREE=$from
  else
    tar -C "$from" --exclude=./.git --exclude=./node_modules --exclude=./data --exclude=./test --exclude=./.env -cf - . | tar -C "$(P "$dest")" -xf - --no-same-owner
    STAGED_TREE=$(P "$dest")
  fi
  act chown -R root:root "$(P "$dest")"
  act chmod -R u=rwX,go=rX "$(P "$dest")"
  act chmod -R a-w "$(P "$dest")"
  if [[ -n "${tmp:-}" ]] && (( ! DRY )); then rm -rf "$tmp"; fi
  return 0
}
point_current_at() { act ln -sfn "$CODE_BASE/$1" "$(P "$CODE_BASE/current.new")"; act mv -Tf "$(P "$CODE_BASE/current.new")" "$(P "$CODE_BASE/current")"; }

# The systemd units shipped in a code tree, installed unchanged.
install_units() {
  local tree=$1 u
  for u in suds.service suds-compliance.service suds-compliance.timer; do act install -m 0644 -o root -g root "$tree/deploy/linux/$u" "$(P "/etc/systemd/system/$u")"; done
  if [[ "${TLS_MODE:-caddy}" != none ]]; then act install -m 0644 -o root -g root "$tree/deploy/linux/caddy.service" "$(P /etc/systemd/system/caddy.service)"; fi
  act install -m 0644 -o root -g root "$tree/Caddyfile" "$(P /etc/caddy/Caddyfile)"
}

# Run a command as the suds user with the service's keys, the way the service gets them (a transient unit
# with the same LoadCredential= lines): for backups and restores during an upgrade.
as_suds() {
  local args=(--quiet --wait --pipe --collect --uid="$SUDS_USER" --gid="$SUDS_USER" --working-directory="$CODE_BASE/current"
    -p EnvironmentFile=/etc/suds/suds.env -E SUDS_ENV=production -E SUDS_DATA_DIR="$DATA_DIR" -p UMask=0077) k
  for k in "${KEY_NAMES[@]}"; do args+=(-p "LoadCredential=$k:$CRED_DIR/$k"); done
  act systemd-run "${args[@]}" "$CODE_BASE/node/bin/node" --no-warnings=ExperimentalWarning "$@"
}

# Wait for SUDS to answer ready (database open, at this build's schema): 0 ready, 1 not within SECONDS.
wait_ready() {
  local secs=${1:-120} i
  (( DRY )) && { printf '+ wait up to %ss for http://127.0.0.1:8080/api/health/ready\n' "$secs"; return 0; }
  for ((i = 0; i < secs; i += 2)); do curl -fsS --max-time 3 http://127.0.0.1:8080/api/health/ready >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}

run_compliance_check() {
  say ""
  say "== Compliance check =="
  act "$CODE_BASE/node/bin/node" --no-warnings=ExperimentalWarning "$CODE_BASE/current/scripts/compliance-check.js" || warn "the compliance check reported failures (above): fix them, then run: systemctl start suds-compliance"
}

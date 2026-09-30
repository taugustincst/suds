# shellcheck shell=bash
# Shared by deploy/linux/install.sh, upgrade.sh and uninstall.sh. Sourced, never run.
#
# Two conventions make the scripts testable (test/deploy-linux.test.js):
#   * every path on the host goes through P, which prefixes SUDS_INSTALL_ROOT (empty in production), so a
#     run can be pointed at a fake root filesystem — a dry run, or a real run with stub system commands on
#     PATH (the tests' real-execution harness);
#   * every command that changes the host goes through act (or put_file / gen_key), which under --dry-run
#     prints it ("+ ...") instead of running it. Commands that only look (findmnt, lsblk, id, mountpoint, who,
#     ss) run in a dry run too, so the refusals are the real ones.
#
# The scripts run under umask 077 (nothing they create is readable by default), so every directory is made
# with an explicit mode (install -d -m): code 0755 root, data 0700 suds, credentials 0700 root.

ROOT="${SUDS_INSTALL_ROOT:-}"
DRY=${DRY:-0}
SUDS_USER=suds
DATA_DIR=/var/lib/suds
COMPLIANCE_DIR=/var/lib/suds-compliance
CODE_BASE=/opt/suds
ETC=/etc/suds
CRED_DIR=/etc/suds/credentials
COMPLIANCE_KEY=/etc/suds/compliance-signing-key
COMPLIANCE_PUB=/etc/suds/compliance-signing-key.pub.pem
KEY_NAMES=(suds_encryption_key suds_index_key suds_backup_key suds_signing_key)
GITHUB_REPO="${SUDS_GITHUB_REPO:-taugustincst/suds}"

P() { printf '%s%s' "$ROOT" "$1"; }
say() { printf '%s\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }

# Root is required, except against a fake root (SUDS_INSTALL_ROOT, the tests) or in a dry run.
require_root() { (( DRY )) || [[ -n "$ROOT" ]] || [[ $EUID -eq 0 ]] || die "run as root (sudo $0 ...)"; }

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
# ensure_line FILE LINE — append LINE to FILE unless it is there already.
ensure_line() {
  local f=$1 line=$2
  if (( DRY )); then printf '+ ensure %s contains the line: %s\n' "$f" "$line"; return 0; fi
  grep -qxF -- "$line" "$f" 2>/dev/null || printf '%s\n' "$line" >> "$f"
}

# ---- input: every value that reaches a file, a unit or a command is checked against a whitelist ----
valid_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]; }
valid_host() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$ ]]; }
valid_email() { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; }
valid_digits() { [[ "$1" =~ ^[0-9]{1,9}$ ]]; }
valid_size() { [[ "$1" =~ ^[0-9]{1,6}[KMGT]?$ ]]; }
# need_path FLAG VALUE — refuse a value that is not a plain absolute path (no spaces, quotes, $, newlines).
need_path() { valid_path "$2" || die "$1 must be an absolute path of letters, digits and . _ / - only (got: $(printf '%q' "$2"))"; }
# A JSON string, escaped: backslash, quote and control characters (values are whitelisted anyway).
json_str() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# ---- /etc/suds/suds-server.conf: read a value; carry over what the installer does not manage ----
conf_get() { local f; f=$(P "$ETC/suds-server.conf"); [[ -f "$f" ]] || return 0; sed -n "s/^$1=//p" "$f" | tail -n1; }
# conf_unmanaged KEY... — the lines of the current file whose key is not one of KEY (kept on a rewrite).
conf_unmanaged() {
  local f line k m keep; f=$(P "$ETC/suds-server.conf")
  [[ -f "$f" ]] || return 0
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    k=${line%%=*}; keep=1
    for m in "$@"; do [[ "$k" == "$m" ]] && keep=0; done
    (( keep )) && printf '%s\n' "$line"
  done < "$f"
  return 0
}
# conf_set KEY VALUE — change one value in suds-server.conf, keeping every other line.
conf_set() {
  local f; f=$(P "$ETC/suds-server.conf")
  if (( DRY )); then printf '+ set %s=%s in %s\n' "$1" "$2" "$f"; return 0; fi
  [[ -f "$f" ]] || return 0
  { grep -v "^$1=" "$f" || true; printf '%s=%s\n' "$1" "$2"; } | put_file "$f" 0644 root:root
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
  ip=${ip#::ffff:}
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

# ---- who is connected over SSH (the firewall must not cut them off) ----
# The address the administrator running this is connected from, or nothing (status 1). sudo's env_reset drops
# SSH_CONNECTION, so after it: `who -m` (the terminal's utmp entry), then SSH_CONNECTION in the environment of
# a parent process (the sshd session's shell, readable by root through /proc).
admin_ssh_peer() {
  local peer='' pid env status
  if [[ -n "${SSH_CONNECTION:-}" ]]; then printf '%s\n' "${SSH_CONNECTION%% *}"; return 0; fi
  if command -v who >/dev/null 2>&1; then peer=$(who -m 2>/dev/null | sed -n 's/.*(\([^)]*\)).*/\1/p' | head -n1); fi
  if [[ "$peer" =~ ^[0-9a-fA-F:.]+$ && "$peer" == *[.:]*[0-9a-fA-F] && "$peer" != :* ]]; then printf '%s\n' "$peer"; return 0; fi
  pid=${PPID:-}
  while [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )); do
    env=$(P "/proc/$pid/environ")
    if [[ -r "$env" ]]; then
      peer=$(tr '\0' '\n' < "$env" 2>/dev/null | sed -n 's/^SSH_CONNECTION=\([^ ]*\) .*/\1/p' | head -n1)
      if [[ -n "$peer" ]]; then printf '%s\n' "$peer"; return 0; fi
    fi
    status=$(P "/proc/$pid/status")
    pid=$(awk '/^PPid:/ {print $2}' "$status" 2>/dev/null || true)
  done
  return 1
}
# Every established inbound SSH connection's peer address, one per line (status 1 when ss cannot say).
ssh_established_peers() {
  command -v ss >/dev/null 2>&1 || return 1
  local out; out=$(ss -Htn state established '( sport = :22 )' 2>/dev/null) || return 1
  [[ -n "$out" ]] || return 0
  awk 'NF >= 4 {print $4}' <<< "$out" | sed -e 's/:[0-9]*$//' -e 's/^\[//' -e 's/\]$//' -e 's/^::ffff://'
}
# Refuse to enable a firewall that allows SSH only from ADMIN_CIDR while anyone is connected from outside it,
# or when it cannot be told where the administrator is connected from (unless --console-access).
ssh_lockout_guard() {
  local cidr=$1 console=$2 me='' est p inside unknown=0
  if (( console )); then note "--console-access: the SSH lock-out check is skipped (you are at the console)"; return 0; fi
  me=$(admin_ssh_peer) || me=''
  if est=$(ssh_established_peers); then :; else est=''; [[ -z "$me" ]] && unknown=1; fi
  if [[ -n "$me" ]]; then
    set +e; ip_in_cidr "$me" "$cidr"; inside=$?; set -e
    (( inside == 1 )) && die "this SSH session comes from $me, outside --admin-cidr=$cidr: the firewall would lock it out. Run from the administration network, fix --admin-cidr, or pass --console-access if you have console access."
    (( inside == 2 )) && die "could not tell whether this SSH session's address $me is inside --admin-cidr=$cidr (only IPv4 can be compared): run from the console with --console-access, or from an IPv4 address in the administration network."
    note "this session comes from $me, inside $cidr"
  fi
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    set +e; ip_in_cidr "$p" "$cidr"; inside=$?; set -e
    (( inside == 1 )) && die "an established SSH session comes from $p, outside --admin-cidr=$cidr: the firewall would cut it off. End it, fix --admin-cidr, or pass --console-access."
    (( inside == 2 )) && die "an established SSH session comes from $p, which cannot be compared with --admin-cidr=$cidr (only IPv4): pass --console-access if that is intended."
  done <<< "$est"
  (( unknown )) && die "could not tell where this session comes from (no SSH_CONNECTION, nothing from who -m or the parent processes, and ss is not available). If you are at the console, pass --console-access."
  return 0
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
  if [[ -n "${NODE_TARBALL:-}" ]]; then cp -- "$NODE_TARBALL" "$tmp/$file"; else fetch "https://nodejs.org/dist/$ver/$file" "$tmp/$file"; fi
  verify_sum sha256 "$tmp/$file" "$sum"
  act install -d -m 0755 -o root -g root "$(P "$CODE_BASE")" "$(P "$dir")"
  act tar -xJf "$tmp/$file" -C "$(P "$dir")" --strip-components=1 --no-same-owner --preserve-permissions
  act chown -R root:root "$(P "$dir")"
  # Readable and runnable by everyone (the suds user runs it), writable by no one: whatever the archive or umask said.
  act chmod -R u=rwX,go=rX "$(P "$dir")"
  act chmod -R a-w "$(P "$dir")"
  rm -rf "$tmp"
  NODE_DIR=$dir
}
# The symlinks are relative (node -> node-v22.x.y, current -> 1.18.0), so they resolve the same under a fake root.
use_node() { act ln -sfn "$(basename "$1")" "$(P "$CODE_BASE/node.new")"; act mv -Tf "$(P "$CODE_BASE/node.new")" "$(P "$CODE_BASE/node")"; }

# install_caddy CODE_TREE — the pinned Caddy into /opt/caddy/<v>, /opt/caddy/current pointed at it; checks the
# binary answers with that version. Sets CADDY_VERSION_PINNED.
install_caddy() {
  local tree=$1 ver sum dir file tmp have
  ver=$(pin CADDY_VERSION "$tree"); sum=$(pin CADDY_SHA512_LINUX_AMD64 "$tree")
  [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$sum" =~ ^[0-9a-f]{128}$ ]] || die "deploy/linux/pins has no valid Caddy pin"
  CADDY_VERSION_PINNED=$ver
  dir="/opt/caddy/$ver"; file="caddy_${ver}_linux_amd64.tar.gz"
  if [[ -x "$(P "$dir/caddy")" ]]; then note "Caddy $ver already installed"; else
    tmp=$(mktemp -d)
    if [[ -n "${CADDY_TARBALL:-}" ]]; then cp -- "$CADDY_TARBALL" "$tmp/$file"; else fetch "https://github.com/caddyserver/caddy/releases/download/v$ver/$file" "$tmp/$file"; fi
    verify_sum sha512 "$tmp/$file" "$sum"
    act install -d -m 0755 -o root -g root "$(P /opt/caddy)" "$(P "$dir")"
    act tar -xzf "$tmp/$file" -C "$(P "$dir")" --no-same-owner caddy
    act chown -R root:root "$(P "$dir")"
    act chmod 0755 "$(P "$dir")" "$(P "$dir/caddy")"
    rm -rf "$tmp"
  fi
  act ln -sfn "$ver" "$(P /opt/caddy/current.new)"; act mv -Tf "$(P /opt/caddy/current.new)" "$(P /opt/caddy/current)"
  if (( ! DRY )); then
    have=$("$(P /opt/caddy/current/caddy)" version 2>/dev/null | awk '{print $1}')
    [[ "$have" == "v$ver" ]] || die "/opt/caddy/current/caddy reports ${have:-nothing}, not the pinned v$ver"
    note "Caddy answers $have"
  fi
}

# A staged release is complete when its marker holds the SHA-256 of its manifest and every file matches it.
staged_ok() {
  local d=$1
  [[ -f "$d/.suds-staged" && -f "$d/.suds-manifest" ]] || return 1
  [[ "$(sha256sum < "$d/.suds-manifest" | awk '{print $1}')" == "$(cat "$d/.suds-staged" 2>/dev/null)" ]] || return 1
  (cd "$d" && sha256sum --quiet --strict -c .suds-manifest >/dev/null 2>&1)
}
write_manifest() {
  local d=$1
  (cd "$d" && find . -type f ! -name .suds-manifest ! -name .suds-staged -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$d/.suds-manifest"
  sha256sum < "$d/.suds-manifest" | awk '{print $1}' > "$d/.suds-staged"
}

# stage_release VERSION — puts the code for VERSION at /opt/suds/VERSION (root-owned, read-only) and sets
# STAGED_TREE to a tree of it to read files from, and RELEASE_CHECKSUM_SOURCE to how its zip was checked:
#   local-tree    this tree is that version (the operator checked the zip it came from before unpacking it);
#   operator      RELEASE_ZIP (--source, copied before it is hashed) or the GitHub download, checked against
#                 RELEASE_SHA256 (--release-sha256), a checksum from a channel other than the download;
#   same-release  the .sha256 published beside the zip — only with TRUST_RELEASE_CHECKSUM=1, and a warning.
# Staged into <version>.partial and renamed when complete, with a manifest; a leftover .partial is removed and
# an existing <version> without a valid marker and manifest is staged again.
stage_release() {
  local ver=$1 dest="$CODE_BASE/$1" part="$CODE_BASE/$1.partial" src_ver tmp='' zip want top from restage=0
  if [[ -e "$(P "$part")" ]]; then note "removing $part, left by an interrupted run"; act chmod -R u+w "$(P "$part")"; act rm -rf "$(P "$part")"; fi
  if [[ -d "$(P "$dest")" ]]; then
    if staged_ok "$(P "$dest")"; then note "SUDS $ver already at $dest (complete; every file matches its manifest)"; STAGED_TREE=$(P "$dest"); RELEASE_CHECKSUM_SOURCE=${RELEASE_CHECKSUM_SOURCE:-}; return 0; fi
    (( DRY )) || warn "$dest exists but is not a complete staged release (no marker, or files differ from its manifest): staging it again"
    restage=1
  fi
  src_ver=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$SRC/package.json")
  if [[ "$src_ver" == "$ver" && -z "${RELEASE_ZIP:-}" ]]; then
    note "installing SUDS $ver from $SRC"
    from=$SRC; RELEASE_CHECKSUM_SOURCE=local-tree
  else
    tmp=$(mktemp -d)
    zip="$tmp/suds-v$ver.zip"
    # A --source file is copied first and only the copy is hashed and unpacked: it cannot change in between.
    if [[ -n "${RELEASE_ZIP:-}" ]]; then cp -- "$RELEASE_ZIP" "$zip"; else fetch "https://github.com/$GITHUB_REPO/releases/download/v$ver/suds-v$ver.zip" "$zip"; fi
    if [[ -n "${RELEASE_SHA256:-}" ]]; then
      want=$RELEASE_SHA256; RELEASE_CHECKSUM_SOURCE=operator
    elif (( ${TRUST_RELEASE_CHECKSUM:-0} )); then
      if [[ -n "${RELEASE_ZIP:-}" ]]; then [[ -f "$RELEASE_ZIP.sha256" ]] && cp -- "$RELEASE_ZIP.sha256" "$zip.sha256"; else fetch "https://github.com/$GITHUB_REPO/releases/download/v$ver/suds-v$ver.zip.sha256" "$zip.sha256"; fi
      want=''; [[ -f "$zip.sha256" ]] && want=$(awk '{print $1}' "$zip.sha256")
      if [[ -z "$want" ]] && (( DRY )); then want="<the SHA-256 in suds-v$ver.zip.sha256>"; fi
      [[ -n "$want" ]] || die "no suds-v$ver.zip.sha256 to check the zip against"
      warn "suds-v$ver.zip is checked only against the .sha256 published beside it (--trust-release-checksum): whoever could replace the zip could replace that too. The compliance report records this (host.release_integrity)."
      RELEASE_CHECKSUM_SOURCE=same-release
    else
      die "no independent checksum for suds-v$ver.zip. Pass --release-sha256=<hex>, taken from a channel other than the download (the release notes AND the CHANGELOG entry at tag v$ver; they must agree: docs/SELF-HOSTING.md, Upgrading), or knowingly pass --trust-release-checksum to accept the .sha256 file from the same release."
    fi
    [[ "$want" =~ ^[0-9a-f]{64}$ ]] || (( DRY )) || die "the release checksum is not a SHA-256"
    verify_sum sha256 "$zip" "$want"
    if (( DRY )); then
      printf '+ unzip -q %s -d %s\n' "$zip" "$tmp"; from="$tmp/suds-v$ver"
    else
      command -v unzip >/dev/null 2>&1 || die "unzip is needed to unpack a release zip"
      unzip -q "$zip" -d "$tmp/x"
      top=$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -n1)
      [[ -n "$top" && -f "$top/package.json" ]] || die "suds-v$ver.zip does not contain a SUDS release"
      grep -q "\"version\": \"$ver\"" "$top/package.json" || die "suds-v$ver.zip is not version $ver"
      from=$top
    fi
  fi
  act install -d -m 0755 -o root -g root "$(P "$CODE_BASE")" "$(P "$part")"
  if (( DRY )); then
    printf '+ copy %s into %s (without .git, node_modules, data, test), write its manifest\n' "$from" "$(P "$part")"
  else
    tar -C "$from" --exclude=./.git --exclude=./node_modules --exclude=./data --exclude=./test --exclude=./.env -cf - . | tar -C "$(P "$part")" -xf - --no-same-owner
    write_manifest "$(P "$part")"
  fi
  act chown -R root:root "$(P "$part")"
  act chmod -R u=rwX,go=rX "$(P "$part")"
  act chmod -R a-w "$(P "$part")"
  if (( restage )); then
    act mv -T "$(P "$dest")" "$(P "$dest.replaced.$$")"
    act mv -T "$(P "$part")" "$(P "$dest")"
    act chmod -R u+w "$(P "$dest.replaced.$$")"; act rm -rf "$(P "$dest.replaced.$$")"
  else
    act mv -T "$(P "$part")" "$(P "$dest")"
  fi
  if (( DRY )); then STAGED_TREE=$from; else STAGED_TREE=$(P "$dest"); fi
  if [[ -n "${tmp:-}" ]] && (( ! DRY )); then rm -rf "$tmp"; fi
  return 0
}
point_current_at() { act ln -sfn "$1" "$(P "$CODE_BASE/current.new")"; act mv -Tf "$(P "$CODE_BASE/current.new")" "$(P "$CODE_BASE/current")"; }

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
  act "$(P "$CODE_BASE/node/bin/node")" --no-warnings=ExperimentalWarning "$(P "$CODE_BASE/current/scripts/compliance-check.js")" || warn "the compliance check reported failures (above): fix them, then run: systemctl start suds-compliance. On a new server the first backup and the first recovery drill show as \"pending first run (expected on day one)\"."
}

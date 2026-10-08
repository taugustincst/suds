# shellcheck shell=bash
# shellcheck disable=SC2034  # the settings below are read by install.sh, upgrade.sh and uninstall.sh, which source this file
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
# kv_get FILE KEY — the last KEY= value in FILE (a host path), or nothing.
kv_get() { local f; f=$(P "$1"); [[ -f "$f" ]] || return 0; sed -n "s/^$2=//p" "$f" | tail -n1; }
conf_get() { kv_get "$ETC/suds-server.conf" "$1"; }
env_get() { kv_get "$ETC/suds.env" "$1"; }
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
# verify_sum sha256|sha512 FILE HEX [WHAT] — refuses on a mismatch; in a dry run a file that does not exist yet is planned.
# WHAT names the checksum in the note ("the pinned checksum" unless given: the release zip's is the operator's).
verify_sum() {
  local algo=$1 file=$2 want=$3 what=${4:-the pinned checksum} have
  if [[ ! -f "$file" ]]; then
    (( DRY )) && { printf '+ %s\n' "$(quoted "${algo}sum" -c) <<< \"$want  $(basename "$file")\" (refuse on mismatch)"; return 0; }
    die "$file is missing"
  fi
  have=$("${algo}sum" "$file" | awk '{print $1}')
  [[ "$have" == "$want" ]] || die "checksum mismatch for $(basename "$file"): expected ${algo} $want, got $have. Refusing to install it (a corrupted or substituted download)."
  note "$(basename "$file"): ${algo} matches ${what}"
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

# How a staged release's zip was checked (stage_release), a file inside it, so its manifest covers it too.
CHECKSUM_RECORD=.suds-release-checksum
staged_checksum_source() {
  local v; v=$(head -n1 "$1/$CHECKSUM_RECORD" 2>/dev/null || true)
  case "$v" in local-tree|operator|same-release) printf '%s' "$v" ;; esac
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
    if staged_ok "$(P "$dest")"; then
      note "SUDS $ver already at $dest (complete; every file matches its manifest)"; STAGED_TREE=$(P "$dest")
      # How its zip was checked is recorded inside it when it is staged, so a run that stopped after staging
      # does not leave the next one without it (1.19.0 then wrote SUDS_RELEASE_CHECKSUM_SOURCE= empty). A stage
      # made before 1.20.0 has no record: the caller falls back to suds-server.conf.
      local recorded; recorded=$(staged_checksum_source "$(P "$dest")")
      if [[ -n "$recorded" ]]; then RELEASE_CHECKSUM_SOURCE=$recorded; note "its zip was checked when staged: $recorded"; else RELEASE_CHECKSUM_SOURCE=${RELEASE_CHECKSUM_SOURCE:-}; fi
      return 0
    fi
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
      die "no independent checksum for suds-v$ver.zip. Pass --release-sha256=<hex>, taken from a channel other than the download: the SHA-256 published in the GitHub Release notes for v$ver AND recorded in that version's CHANGELOG section on the main branch (not at the tag: the zip is built from the tagged commit, so its checksum is added after it); they must agree (docs/SELF-HOSTING.md, Upgrading). Or knowingly pass --trust-release-checksum to accept the .sha256 file from the same release."
    fi
    [[ "$want" =~ ^[0-9a-f]{64}$ ]] || (( DRY )) || die "the release checksum is not a SHA-256"
    case "$RELEASE_CHECKSUM_SOURCE" in
      same-release) verify_sum sha256 "$zip" "$want" "the .sha256 published beside it" ;;
      *) verify_sum sha256 "$zip" "$want" "the checksum given with --release-sha256" ;;
    esac
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
    printf '+ copy %s into %s (without .git, node_modules, data, test), record how its zip was checked (%s) in %s, write its manifest\n' "$from" "$(P "$part")" "$RELEASE_CHECKSUM_SOURCE" "$CHECKSUM_RECORD"
  else
    tar -C "$from" --exclude=./.git --exclude=./node_modules --exclude=./data --exclude=./test --exclude=./.env -cf - . | tar -C "$(P "$part")" -xf - --no-same-owner
    printf '%s\n' "$RELEASE_CHECKSUM_SOURCE" > "$(P "$part")/$CHECKSUM_RECORD"
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

# The systemd units shipped in a code tree, installed unchanged; the Caddyfile too, beside the site-local directory
# it imports (which nothing here ever writes into, except install.sh --www-redirect and caddy_move_local).
CADDY_SITE_DIR=/etc/caddy/Caddyfile.d
install_units() {
  local tree=$1 u
  for u in suds.service suds-compliance.service suds-compliance.timer; do act install -m 0644 -o root -g root "$tree/deploy/linux/$u" "$(P "/etc/systemd/system/$u")"; done
  if [[ "${TLS_MODE:-caddy}" != none ]]; then act install -m 0644 -o root -g root "$tree/deploy/linux/caddy.service" "$(P /etc/systemd/system/caddy.service)"; fi
  act install -d -m 0755 -o root -g root "$(P "$CADDY_SITE_DIR")"
  act install -m 0644 -o root -g root "$tree/Caddyfile" "$(P /etc/caddy/Caddyfile)"
}

# caddy_local_edits CURRENT_CADDYFILE NEW_CADDYFILE — called before anything is changed. /etc/caddy/Caddyfile is
# replaced by the release's copy, so an operator's edit to it would be lost without a word (1.25.1: the www redirect
# suds.systems appended by hand would have gone at the next upgrade). Nothing to do when it is the current or the new
# release's copy, or absent. When it is the current release's copy with site blocks appended after it (whole blocks:
# braces balanced) and the new copy imports $CADDY_SITE_DIR, those blocks are set aside in CADDY_LOCAL_BLOCKS for
# caddy_move_local. Anything else is refused, with what to do.
CADDY_LOCAL_BLOCKS=''
caddy_local_edits() {
  local cur=$1 new=$2 live extra size
  live=$(P /etc/caddy/Caddyfile); CADDY_LOCAL_BLOCKS=''
  [[ -f "$live" ]] || return 0
  if [[ ! -f "$new" ]] && (( DRY )); then printf '+ check %s for local changes against %s and the new release'"'"'s\n' "$live" "$cur"; return 0; fi
  cmp -s "$live" "$new" && return 0
  [[ -f "$cur" ]] && cmp -s "$live" "$cur" && return 0
  if [[ -f "$cur" ]] && grep -qxF "import $CADDY_SITE_DIR/*.caddy" "$new"; then
    size=$(wc -c < "$cur")
    if cmp -s -n "$size" "$live" "$cur"; then
      extra=$(tail -c +"$((size + 1))" "$live")
      if [[ -z "${extra//[[:space:]]/}" ]]; then return 0; fi
      if awk '{ for (i = 1; i <= length($0); i++) { c = substr($0, i, 1); if (c == "{") d++; else if (c == "}" && --d < 0) exit 1 } } END { exit (d != 0) }' <<< "$extra" \
        && [[ ! -e "$(P "$CADDY_SITE_DIR/local.caddy")" ]]; then
        CADDY_LOCAL_BLOCKS=$extra
        note "/etc/caddy/Caddyfile has site blocks added after the release's own: they will be moved to $CADDY_SITE_DIR/local.caddy, which the new Caddyfile imports"
        return 0
      fi
    fi
  fi
  die "/etc/caddy/Caddyfile has local changes that installing the release's Caddyfile would discard, and they are not only whole site blocks added at its end (or $CADDY_SITE_DIR/local.caddy exists already). SUDS and Caddy have not been touched: both are running as they were. Move what you added into a file $CADDY_SITE_DIR/<name>.caddy (whole site blocks; the SUDS Caddyfile imports every *.caddy file there, and upgrades never touch them), put the release's own Caddyfile back (cp ${cur#"$ROOT"} /etc/caddy/Caddyfile), and run this again. Caddy keeps serving its loaded configuration until it is restarted (deploy/linux/README.md, Site-local Caddy configuration)."
}
# caddy_move_local LABEL — write CADDY_LOCAL_BLOCKS (from caddy_local_edits) to $CADDY_SITE_DIR/local.caddy, and keep
# the operator's whole Caddyfile beside it as /etc/caddy/Caddyfile.local-LABEL (CADDY_LOCAL_SAVED), for a rollback.
CADDY_LOCAL_SAVED=''
caddy_move_local() {
  [[ -n "$CADDY_LOCAL_BLOCKS" ]] || return 0
  CADDY_LOCAL_SAVED=/etc/caddy/Caddyfile.local-$1
  act install -d -m 0755 -o root -g root "$(P "$CADDY_SITE_DIR")"
  act install -m 0644 -o root -g root "$(P /etc/caddy/Caddyfile)" "$(P "$CADDY_LOCAL_SAVED")"
  put_file "$(P "$CADDY_SITE_DIR/local.caddy")" 0644 root:root <<EOF
# Moved here from the end of /etc/caddy/Caddyfile by deploy/linux/$(basename "$0") ($1): the SUDS Caddyfile is replaced by every
# upgrade, and imports the *.caddy files in this directory, which no upgrade touches. The whole file as it was: $CADDY_LOCAL_SAVED
$CADDY_LOCAL_BLOCKS
EOF
  note "your site blocks are now in $CADDY_SITE_DIR/local.caddy (your Caddyfile as it was: $CADDY_LOCAL_SAVED)"
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

# Wait for SUDS to answer ready over HTTPS, through Caddy at the site's name (its certificate obtained or loaded,
# the proxy started): 0 when it does, 1 when not within SECONDS. The compliance check's TLS and HTTPS checks
# would otherwise catch Caddy still starting, or still waiting for its first ACME certificate.
wait_https() {
  local secs=${1:-90} dom conn ca i args
  # install.sh has them as options; upgrade.sh reads what the install recorded.
  dom=${DOMAIN:-$(conf_get SUDS_DOMAIN)}; conn=${CONNECT_HOST:-$(conf_get SUDS_CONNECT_HOST)}; ca=${ca_conf:-$(conf_get SUDS_CA_FILE)}
  [[ -n "$dom" ]] || return 0
  args=(-fsS --max-time 5 --proto '=https' --tlsv1.2)
  [[ -n "$ca" && -r "$(P "$ca")" ]] && args+=(--cacert "$(P "$ca")")
  [[ -n "$conn" && "$conn" != "$dom" ]] && args+=(--connect-to "$dom:443:$conn:443")
  if (( DRY )); then printf '+ wait up to %ss for https://%s/api/health/ready (through Caddy)\n' "$secs" "$dom"; return 0; fi
  for ((i = 0; i < secs; i += 3)); do curl "${args[@]}" "https://$dom/api/health/ready" >/dev/null 2>&1 && return 0; sleep 3; done
  return 1
}

# The compliance check, with the settings the weekly unit runs it with (suds-compliance.service:
# EnvironmentFile=/etc/suds/suds.env, SUDS_ENV=production, SUDS_DATA_DIR). Run without them (1.19.0), the app
# lines that read those settings reported what the service does not do: app.https failed for want of TRUST_PROXY
# on the installer's report and passed on the weekly one.
run_compliance_check() {
  local envs=() line f
  say ""
  say "== Compliance check =="
  if ! wait_https 90; then warn "https://${DOMAIN:-$(conf_get SUDS_DOMAIN)} did not answer through Caddy within 90 s (journalctl -u caddy -n 50): the TLS checks below may fail until it does; run systemctl start suds-compliance then."; fi
  f=$(P "$ETC/suds.env")
  if [[ -r "$f" ]]; then while IFS= read -r line || [[ -n "$line" ]]; do [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && envs+=("$line"); done < "$f"; fi
  if (( DRY )); then printf '+ (the compliance check below runs with every KEY=value line of %s in its environment, as suds-compliance.service does)\n' "$f"; fi
  act env "${envs[@]}" SUDS_ENV=production SUDS_DATA_DIR="$DATA_DIR" "$(P "$CODE_BASE/node/bin/node")" --no-warnings=ExperimentalWarning "$(P "$CODE_BASE/current/scripts/compliance-check.js")" || warn "the compliance check reported failures (above): fix them, then run: systemctl start suds-compliance. On a new server a first backup or recovery drill that has not run yet shows as \"pending first run (expected on day one)\", a warning."
}

# check_shares LABEL DIR [LABEL DIR ...] — each share must be writable (and searchable) by the service user,
# tested as that user. Every share is checked and one refusal names each that is not, with the commands that
# fix it: one fix and one more run, not one run per share. The account is created here if it does not exist
# yet, so that it can be tested as (in a dry run, the modes are read instead, as a warning).
SUDS_USER_PLANNED=0
check_shares() {
  local labels=() dirs=() bad=() i d st owner mode uid gid msg
  while (( $# )); do labels+=("$1"); dirs+=("$2"); shift 2; done
  if ! id -u "$SUDS_USER" >/dev/null 2>&1; then
    if (( DRY )); then
      act useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SUDS_USER"; SUDS_USER_PLANNED=1
      # A new account owns nothing: it can write a share only if everyone can (an ACL may say otherwise).
      for i in "${!dirs[@]}"; do
        st=$(stat -c '%U:%G %a' "$(P "${dirs[$i]}")" 2>/dev/null) || continue
        mode=${st##* }; (( (${mode: -1} & 3) == 3 )) || warn "${dirs[$i]} (${labels[$i]}; owner ${st% *}, mode $mode) will probably not be writable by the new $SUDS_USER user: the real run refuses then. Create the user first (the useradd above) and give it write access, e.g. chown $SUDS_USER:$SUDS_USER ${dirs[$i]} && chmod 0700 ${dirs[$i]}"
      done
      return 0
    fi
    note "creating the $SUDS_USER service account now, so the shares can be checked as it"
    act useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SUDS_USER"
  fi
  if (( DRY )); then for d in "${dirs[@]}"; do printf '+ check %s is writable by %s\n' "$d" "$SUDS_USER"; done; return 0; fi
  for i in "${!dirs[@]}"; do
    runuser -u "$SUDS_USER" -- test -w "$(P "${dirs[$i]}")" -a -x "$(P "${dirs[$i]}")" || bad+=("$i")
  done
  (( ${#bad[@]} )) || { note "the shares are writable by $SUDS_USER: ${dirs[*]}"; return 0; }
  uid=$(id -u "$SUDS_USER" 2>/dev/null || echo '?'); gid=$(id -g "$SUDS_USER" 2>/dev/null || echo '?')
  if (( ${#bad[@]} == 1 )); then msg="${dirs[${bad[0]}]} (${labels[${bad[0]}]}"; else msg="${#bad[@]} shares are not writable by the $SUDS_USER user (uid $uid, gid $gid):"$'\n'; fi
  for i in "${bad[@]}"; do
    st=$(stat -c '%U:%G %a' "$(P "${dirs[$i]}")" 2>/dev/null || echo '? ?')
    if (( ${#bad[@]} == 1 )); then msg+="; owner ${st% *}, mode ${st##* }) is not writable by the $SUDS_USER user (uid $uid, gid $gid)."$'\n'
    else msg+="  ${dirs[$i]} (${labels[$i]}; owner ${st% *}, mode ${st##* })"$'\n'; fi
  done
  msg+="Give the $SUDS_USER user write access, then run this again. Where root can change the mount's ownership (a local disk, or a share that keeps it):"$'\n'
  for i in "${bad[@]}"; do msg+="  chown $SUDS_USER:$SUDS_USER ${dirs[$i]} && chmod 0700 ${dirs[$i]}"$'\n'; done
  msg+="or keep the owner and add an ACL:"$'\n'
  for i in "${bad[@]}"; do msg+="  setfacl -m u:$SUDS_USER:rwx ${dirs[$i]}"$'\n'; done
  msg+="On an NFS or SMB share whose server decides ownership (root squashed, or mapped), grant uid $uid / gid $gid write access on the share's server instead. The anchor share needs create and write only: it is write-once."
  die "$msg"
}

# webauthn_defaults DOMAIN — passkeys (docs/FINGERPRINT.md) need the relying party in production: add
# WEBAUTHN_RP_ID=<domain> and WEBAUTHN_ORIGINS=https://<domain> to suds.env unless the operator set either.
webauthn_defaults() {
  local dom=${1,,} f; f=$(P "$ETC/suds.env")
  [[ -n "$dom" ]] && valid_host "$dom" || return 0
  if [[ -n "$(env_get WEBAUTHN_RP_ID)$(env_get WEBAUTHN_ORIGINS)" ]]; then note "passkeys: WEBAUTHN_RP_ID/WEBAUTHN_ORIGINS in $ETC/suds.env kept as set"; return 0; fi
  if (( DRY )); then printf '+ add WEBAUTHN_RP_ID=%s and WEBAUTHN_ORIGINS=https://%s to %s\n' "$dom" "$dom" "$f"; return 0; fi
  [[ -f "$f" ]] || return 0
  { cat "$f"; printf 'WEBAUTHN_RP_ID=%s\nWEBAUTHN_ORIGINS=https://%s\n' "$dom" "$dom"; } | put_file "$f" 0644 root:root
  note "passkeys: WEBAUTHN_RP_ID=$dom set in $ETC/suds.env"
}

#!/usr/bin/env bash
# SUDS fleet: open a tenant's escrowed keys, logged every time (deploy/fleet/README.md, Key escrow).
#
#   FLEET_HOME=<private ops directory> deploy/fleet/escrow.sh open <slug> --reason "why, and the ticket or incident"
#   FLEET_HOME=<private ops directory> deploy/fleet/escrow.sh verify
#
# open: logs who, when and why in the escrow access log BEFORE decrypting; checks the escrow file against the SHA-256
# in the tenant's record; decrypts it with the owner's key (gpg) into a new private temporary directory; logs the
# result. Shred what it wrote as soon as you are done (the command is printed). Every attempt is logged, failed ones
# too. verify: checks the hash chain of the escrow access log and of every tenant's history, and prints each chain's
# newest hash (keep it somewhere else: a chain cannot show its own last lines being removed).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/fleet/lib.sh
. "$HERE/lib.sh"
DRY=0
cmd=${1:-}; (( $# )) && shift
fleet_home_ok
case "$cmd" in
  open)
    SLUG=${1:-}; reason=''; (( $# )) && shift
    while (( $# )); do case "$1" in --reason) reason=${2:-}; shift; (( $# )) && shift ;; --reason=*) reason=${1#*=}; shift ;; *) die "unknown option $1" ;; esac; done
    [[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,28}[a-z0-9]$ ]] || die "usage: escrow.sh open <slug> --reason \"...\""
    reason=$(printf '%s' "$reason" | tr -c 'A-Za-z0-9 ._,:;()/#-' ' ' | cut -c1-200)
    [[ ${#reason} -ge 8 ]] || die "--reason \"<why the keys are needed; the ticket or incident>\" is required"
    REC=$FLEET_HOME/register/$SLUG.env; file=$(rec_get ESCROW_FILE); sha=$(rec_get ESCROW_SHA256)
    [[ -n "$file" && -f "$FLEET_HOME/$file" ]] || die "no escrow file for $SLUG in $REC"
    chain "$ESC_LOG" "open-requested slug=$SLUG file=$file reason=\"$reason\""
    if [[ $(sha256_of "$FLEET_HOME/$file") != "$sha" ]]; then chain "$ESC_LOG" "open-FAILED slug=$SLUG hash-mismatch"; fail "$file does not match ESCROW_SHA256 in $REC: it was changed or replaced. Logged."; fi
    out=$(mktemp -d "${TMPDIR:-/tmp}/suds-escrow-$SLUG.XXXXXX")
    if gpg --batch --quiet --decrypt --output "$out/keys.tar" "$FLEET_HOME/$file" && tar -C "$out" -xf "$out/keys.tar"; then
      shred_file "$out/keys.tar"; chain "$ESC_LOG" "opened slug=$SLUG into=$out"
    else
      rm -rf "$out"; chain "$ESC_LOG" "open-FAILED slug=$SLUG decrypt"; fail "could not decrypt $file (is the owner's escrow key available to gpg?). Logged."
    fi
    say "Opened into $out (yours only): $(cd "$out" && find . -type f | sed 's|^\./||' | tr '\n' ' ')"
    say "When done: find $out -type f -exec shred -u {} + && rm -rf $out"
    ;;
  verify)
    broken=0
    for f in "$ESC_LOG" "$FLEET_HOME"/register/*.log; do
      [[ -f "$f" ]] || continue
      prev=$ZERO n=0
      while IFS= read -r line; do
        n=$((n + 1)); [[ "${line##* prev=}" == "$prev" ]] || { say "BROKEN: $f line $n does not follow line $((n - 1))"; broken=1; break; }
        prev=$(printf '%s\n' "$line" | sha256_of -)
      done < "$f"
      note "$f: $n entries; newest hash $prev"
    done
    (( ! broken )) || fail "a log's hash chain is broken: a line was edited, inserted or removed"
    ;;
  *) usage ;;
esac

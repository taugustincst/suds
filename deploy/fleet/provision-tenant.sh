#!/usr/bin/env bash
# SUDS fleet (Option A): provision one tenant on its own AWS Lightsail VM. The runbook is deploy/fleet/README.md.
#
#   FLEET_HOME=<private ops directory> deploy/fleet/provision-tenant.sh <FLEET_HOME>/tenants/<slug>.env [--apply]
#
# Without --apply it is a dry run: it prints every step and command and calls nothing (no aws, DNS or SSH).
# With --apply, in order: the instance, static IP, disks and Lightsail firewall (aws lightsail), each checked
# before the next; the DNS records at Porkbun, checked through DNS-over-HTTPS; the VM's disks prepared
# (prepare-host.sh: a LUKS2 data volume at /var/lib/suds, the offsite and anchor disks); SUDS Server installed by
# deploy/linux/install.sh, unchanged; post-install asserts, any of which fails the run; the keys escrowed,
# encrypted for the owner (no escrow, no go-live); the tenant's record in the private register; first sign-in.
# Re-runnable: what already exists is kept. Never run --apply without the owner's go: it creates billable resources.
#
#   --allow-unencrypted-demo   a tenant for demonstration data only may run without LUKS: the assert warns
#                              instead of failing, and the tenant record says DEMO_ONLY=yes.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/fleet/lib.sh
. "$HERE/lib.sh"
DEMO=0 ENV_FILE=''
for a in "$@"; do case "$a" in --apply) DRY=0 ;; --allow-unencrypted-demo) DEMO=1 ;; -h|--help) usage ;; -*) die "unknown option $a" ;; *) ENV_FILE=$a ;; esac; done
load_tenant "$ENV_FILE"
W=/tmp/suds-fleet
# box CMD — run CMD on the VM over a new SSH connection (none is reused: ControlMaster=no).
box() { if (( DRY )); then printf "+ ssh <SSH options> %s@%s '%s'\n" "$SSH_USER" "$IP" "$1"; else boxq "$1"; fi; }
put() { if (( DRY )); then printf '+ scp <SSH options> %s %s@%s:%s\n' "$1" "$SSH_USER" "$IP" "$2"; else scp "${SSH_OPTS[@]}" "$1" "$SSH_USER@$IP:$2"; fi; }
# shellcheck disable=SC2029  # each remote command is built here, from checked values, on purpose
boxq() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "$1"; }
ssh_ok() { local i; for ((i = 0; i < $1; i++)); do [[ $(boxq 'echo suds-fleet-ssh-ok' 2>/dev/null) == suds-fleet-ssh-ok ]] && return 0; sleep "$POLL"; done; return 1; }
doh_ok() {
  local out ans; out=$(curl -fsS --proto '=https' --max-time 10 "https://dns.google/resolve?name=$1&type=A") || return 1
  ans=$(grep -o '"data": *"[^"]*"' <<< "$out" | sed 's/.*"\([^"]*\)"$/\1/' | sort -u || true); [[ "$ans" == "$2" ]]
}

say "SUDS fleet: provision $SLUG ($TENANT_DOMAIN), SUDS $SUDS_VERSION$( (( DRY )) && printf ' — DRY RUN: nothing is called; --apply to act')"
step "0. Preflight"
if (( DRY )); then
  for f in "$ZIP" "$SSH_KEY" "$PB_FILE"; do [[ -e "$f" ]] || warn "$f does not exist yet (--apply refuses without it)"; done
else
  for c in aws curl ssh scp gpg; do command -v "$c" >/dev/null 2>&1 || die "$c is not installed"; done
  [[ -f "$ZIP" && $(sha256_of "$ZIP") == "$RELEASE_SHA256" ]] || die "$ZIP is missing or its SHA-256 is not RELEASE_SHA256"
  private_file "$SSH_KEY" || die "$SSH_KEY must exist and be mode 0600"
  gpg --batch --list-keys "$ESCROW_GPG_RECIPIENT" >/dev/null 2>&1 || die "the escrow key $ESCROW_GPG_RECIPIENT is not in this keyring: no escrow, no go-live, so nothing is created without it"
  if (( DNS_AUTO )); then load_porkbun; fi
fi
was=$(rec_get SUDS_VERSION)
[[ -z "$was" || "$was" == "$SUDS_VERSION" ]] || die "$SLUG runs $was (its record) and SUDS_VERSION is $SUDS_VERSION: upgrade with deploy/linux/upgrade.sh on the VM, one tenant at a time, then set SUDS_VERSION in the record too (deploy/fleet/README.md, Upgrades). An upgrade never goes through install.sh."
note "release $ZIP (SHA-256 $RELEASE_SHA256); escrow for $ESCROW_GPG_RECIPIENT; register $REC"

step "1. Instance $INSTANCE ($LIGHTSAIL_BUNDLE, $LIGHTSAIL_BLUEPRINT, $AVAILABILITY_ZONE, dual-stack)"
if exists get-instance --instance-name "$INSTANCE" --query instance.name; then note "exists: kept"; else
  ls_ create-instances --instance-names "$INSTANCE" --availability-zone "$AVAILABILITY_ZONE" --blueprint-id "$LIGHTSAIL_BLUEPRINT" \
    --bundle-id "$LIGHTSAIL_BUNDLE" --key-pair-name "$LIGHTSAIL_KEY_PAIR" --ip-address-type dualstack --tags "key=suds-tenant,value=$SLUG"
fi
wait_eq running "instance $INSTANCE is running" get-instance --instance-name "$INSTANCE" --query instance.state.name
rec_set TENANT_SLUG "$SLUG" TENANT_DOMAIN "$TENANT_DOMAIN" INSTANCE_NAME "$INSTANCE" AVAILABILITY_ZONE "$AVAILABILITY_ZONE" STATUS provisioning

step "2. Static IP $IP_NAME"
exists get-static-ip --static-ip-name "$IP_NAME" --query staticIp.name || ls_ allocate-static-ip --static-ip-name "$IP_NAME"
[[ $(lsq get-static-ip --static-ip-name "$IP_NAME" --query staticIp.attachedTo) == "$INSTANCE" ]] || ls_ attach-static-ip --static-ip-name "$IP_NAME" --instance-name "$INSTANCE"
wait_eq "True$TAB$INSTANCE" "static IP attached to $INSTANCE" get-static-ip --static-ip-name "$IP_NAME" --query 'staticIp.[isAttached,attachedTo]'
(( DRY )) || IP=$(lsq get-static-ip --static-ip-name "$IP_NAME" --query staticIp.ipAddress)
(( DRY )) || [[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "no IPv4 address for $IP_NAME (got: $IP)"
note "address $IP"; rec_set STATIC_IP "$IP"

step "3. Disks (attached, not yet formatted: step 6 does that on the VM)"
for d in "${DISKS[@]}"; do
  IFS=: read -r role gb dev <<< "$d"; name=$INSTANCE-$role
  exists get-disk --disk-name "$name" --query disk.name || ls_ create-disk --disk-name "$name" --availability-zone "$AVAILABILITY_ZONE" --size-in-gb "$gb" --tags "key=suds-tenant,value=$SLUG"
  if [[ $(lsq get-disk --disk-name "$name" --query disk.attachedTo) != "$INSTANCE" ]]; then
    wait_eq available "disk $name ($gb GB) is available" get-disk --disk-name "$name" --query disk.state
    ls_ attach-disk --disk-name "$name" --instance-name "$INSTANCE" --disk-path "$dev"
  fi
  wait_eq "True$TAB$INSTANCE" "disk $name attached to $INSTANCE" get-disk --disk-name "$name" --query 'disk.[isAttached,attachedTo]'
done

step "4. Lightsail firewall: 443 and 80 (ACME) open; SSH from $ADMIN_CIDR and $ADMIN_CIDR6 only"
ls_ put-instance-public-ports --instance-name "$INSTANCE" --port-infos "fromPort=22,toPort=22,protocol=tcp,cidrs=$ADMIN_CIDR,ipv6Cidrs=$ADMIN_CIDR6" \
  "fromPort=443,toPort=443,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0" "fromPort=80,toPort=80,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0"
# shellcheck disable=SC2016  # JMESPath literals, not shell
wait_eq "22${TAB}80${TAB}443" "open ports are exactly 22, 80, 443" get-instance-port-states --instance-name "$INSTANCE" --query 'sort(portStates[?state==`open`].fromPort)'
# shellcheck disable=SC2016
wait_eq "$ADMIN_CIDR$TAB$ADMIN_CIDR6" "SSH limited to the administration networks" get-instance-port-states --instance-name "$INSTANCE" --query 'portStates[?fromPort==`22`] | [0].[cidrs[0],ipv6Cidrs[0]]'

step "5. DNS: ${NAMES[*]} → $IP"
for n in "${NAMES[@]}"; do
  sub=$(sub_of "$n"); rec="\"content\":\"$IP\",\"ttl\":\"600\""
  if (( ! DNS_AUTO )); then say "  - YOUR STEP: at the tenant's DNS provider, an A record $n → $IP (TTL 600); this run waits for it"
  elif (( DRY )); then porkbun "retrieveByNameType/$DNS_ZONE/A/$sub"; porkbun "create/$DNS_ZONE" "\"name\":$(json_str "$sub"),\"type\":\"A\",$rec (or editByNameType/$DNS_ZONE/A/$sub when it exists)"
  else
    got=$(porkbun "retrieveByNameType/$DNS_ZONE/A/$sub"); got=${got// /}
    if [[ "$got" == *'"records":[]'* ]]; then porkbun "create/$DNS_ZONE" "\"name\":$(json_str "$sub"),\"type\":\"A\",$rec" >/dev/null
    else porkbun "editByNameType/$DNS_ZONE/A/$sub" "$rec" >/dev/null; fi
  fi
  if (( DRY )); then say "+ until curl https://dns.google/resolve?name=$n&type=A answers only $IP (DNS-over-HTTPS, not this machine's resolver)"; continue; fi
  for ((i = 0; i < TRIES; i++)); do doh_ok "$n" "$IP" && break; sleep "$POLL"; done
  (( i < TRIES )) || fail "$n does not resolve to $IP through https://dns.google after $TRIES tries"
  note "$n → $IP (dns.google)"
done

step "6. The VM: SSH, release upload and check, disks prepared (LUKS2 data volume at /var/lib/suds)"
note "SSH options for every ssh and scp: $(quoted "${SSH_OPTS[@]}")"
if (( DRY )); then say "+ until ssh ${SSH_USER}@$IP answers (a new connection each try)"; else ssh_ok "$TRIES" || fail "no SSH to $SSH_USER@$IP"; fi
box "install -d -m 0700 $W"
put "$HERE/prepare-host.sh" "$W/prepare-host.sh"
put "$ZIP" "$W/suds-v$SUDS_VERSION.zip"
box "echo '$RELEASE_SHA256  $W/suds-v$SUDS_VERSION.zip' | sha256sum -c --quiet"
box "sudo bash $W/prepare-host.sh $DATA_DISK_GB $OFFSITE_DISK_GB $ANCHORS_DISK_GB"

step "7. SUDS Server $SUDS_VERSION with deploy/linux/install.sh (unchanged)"
iargs="--domain=$TENANT_DOMAIN --admin-cidr=$ADMIN_CIDR --admin-cidr6=$ADMIN_CIDR6 --offsite=/mnt/suds-offsite --anchors=/mnt/suds-anchors --tls=caddy --version=$SUDS_VERSION --source=$W/suds-v$SUDS_VERSION.zip --release-sha256=$RELEASE_SHA256"
[[ -z "$ACME_EMAIL" ]] || iargs+=" --acme-email=$ACME_EMAIL"
[[ $WWW_REDIRECT == no ]] || iargs+=" --www-redirect"
(( DEMO && DATA_DISK_GB == 0 )) && iargs+=" '--accept-unencrypted-disk=demo-only tenant, no real data (fleet --allow-unencrypted-demo)'"
box "cd $W && rm -rf src && mkdir src && unzip -q suds-v$SUDS_VERSION.zip -d src && sudo bash src/suds-v$SUDS_VERSION/deploy/linux/install.sh $iargs"

step "8. Post-install asserts (any failure fails the run)"
A=('a NEW SSH connection succeeds after the install session closed' 'ufw allows SSH (22) on IPv4 and on IPv6' 'systemctl is-active suds caddy'
  "https://$TENANT_DOMAIN/ answers 200 from outside" "https://$TENANT_DOMAIN/version.json is $SUDS_VERSION" "/var/lib/suds is on an encrypted (LUKS/dm-crypt) volume")
[[ $WWW_REDIRECT == no ]] || A+=('/etc/caddy/Caddyfile.d/www-redirect.caddy exists' "https://www.$TENANT_DOMAIN/ answers 301/308 to https://$TENANT_DOMAIN/")
if (( DRY )); then for a in "${A[@]}"; do say "+ assert: $a"; done; else
  bad=() luks=no
  check() { local d=$1; shift; if "$@"; then note "PASS: $d"; else say "  - FAIL: $d"; bad+=("$d"); fi; }
  failed() { rec_set STATUS failed-asserts; chain "$HIST" "provision asserts FAILED: $*"; fail "post-install assert(s) failed: $*. Not live: fix it and run this again (what exists is kept)."; }
  check "${A[0]}" ssh_ok 3
  (( ! ${#bad[@]} )) || failed "${A[0]} (the host firewall has probably locked SSH out, as at the launch of 2026-10-08, and the Lightsail browser terminal goes through the same port. No data is live yet: tear it down and provision again, or create a new instance from a snapshot of this one)"
  # Each ufw rule for port 22, as v4 or v6: "(v6)" in the line, or an IPv6 source address.
  fams=$(boxq 'sudo ufw status' | sed -n -E 's/ *#.*//; /^(22(\/tcp)?|OpenSSH)( \(v6\))? +(ALLOW|LIMIT)/p' |
    awk '/\(v6\)/ {print "v6"; next} {for (i = 2; i <= NF; i++) if ($i ~ /^(ALLOW|LIMIT)$/) {j = ($(i+1) == "IN") ? i + 2 : i + 1; print (($j ~ /:/) ? "v6" : "v4"); next}}' || true)
  check "${A[1]}: IPv4" grep -qx v4 <<< "$fams"
  check "${A[1]}: IPv6" grep -qx v6 <<< "$fams"
  check "${A[2]}" test "$(boxq 'systemctl is-active suds caddy' | tr -d '\r' | tr '\n' ' ')" = "active active "
  for ((i = 0; i < TRIES; i++)); do code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "https://$TENANT_DOMAIN/" || true); [[ $code == 200 ]] && break; sleep "$POLL"; done
  check "${A[3]}" test "$code" = 200
  check "${A[4]}" grep -qF "\"version\":\"$SUDS_VERSION\"" <<< "$(curl -fsS --max-time 20 "https://$TENANT_DOMAIN/version.json" | tr -d ' \n' || true)"
  # shellcheck disable=SC2016  # expanded on the VM
  lsblk_out=$(boxq 'src=$(findmnt -n -o SOURCE --target /var/lib/suds) && lsblk -s -n -r -o NAME,TYPE "${src%%\[*}"' || true)
  grep -q ' crypt$' <<< "$lsblk_out" && luks=yes
  if [[ $luks == yes ]] || (( ! DEMO )); then check "${A[5]}" test $luks = yes; else
    warn "!!! ${A[5]}: NO. Allowed by --allow-unencrypted-demo: DEMONSTRATION DATA ONLY on this tenant, never real client records (recorded: DEMO_ONLY=yes)"; fi
  if [[ $WWW_REDIRECT == yes ]]; then
    check "${A[6]}" test "$(boxq 'test -f /etc/caddy/Caddyfile.d/www-redirect.caddy && echo yes' || true)" = yes
    check "${A[7]}" grep -qE "^30[18] https://${TENANT_DOMAIN//./\\.}/?$" <<< "$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 "https://www.$TENANT_DOMAIN/" || true)"
  fi
  rec_set SUDS_VERSION "$SUDS_VERSION" LUKS "$luks" DEMO_ONLY "$( [[ $luks == no ]] && echo yes || echo no)"
  (( ! ${#bad[@]} )) || failed "${bad[*]}"
fi

step "9. Key escrow (no escrow, no go-live)"
out=$ESC_DIR/keys-$(date -u +%Y%m%dT%H%M%SZ).tar.gpg
keys=etc/suds/credentials; (( DATA_DISK_GB == 0 )) || keys+=' etc/suds-luks'
if (( DRY )); then say "+ ssh $SSH_USER@$IP 'sudo tar -C / -cf - $keys' | gpg --batch --trust-model always --encrypt --recipient $ESCROW_GPG_RECIPIENT --output $out  (the keys never touch this disk unencrypted)"; else
  install -d -m 0700 "$ESC_DIR"
  n=$(boxq 'sudo find /etc/suds/credentials -type f -name "suds_*" | wc -l' | tr -d ' \r')
  (( n >= 4 )) || fail "only ${n:-0} key files in /etc/suds/credentials on the VM: not escrowed, not live"
  boxq "sudo tar -C / -cf - $keys" | gpg --batch --yes --trust-model always --encrypt --recipient "$ESCROW_GPG_RECIPIENT" --output "$out.partial" || fail "escrow: copying or encrypting the keys failed: not live"
  [[ -s "$out.partial" ]] || fail "escrow: the encrypted copy is empty: not live"
  mv "$out.partial" "$out"; chmod 0400 "$out"; sha=$(sha256_of "$out")
  chain "$ESC_LOG" "put slug=$SLUG file=${out#"$FLEET_HOME"/} sha256=$sha keys=$n"
  rec_set ESCROW_FILE "${out#"$FLEET_HOME"/}" ESCROW_SHA256 "$sha" ESCROW_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  note "escrowed: $out (SHA-256 $sha). Copy it to the owner's offline escrow medium now."
fi

step "10. Register and go-live"
rec_set STATUS active PROVISIONED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
chain "$HIST" "provisioned version=$SUDS_VERSION ip=$IP luks=$( (( DRY )) && echo '?' || echo "$luks") escrow=$(rec_get ESCROW_SHA256)"
[[ -n "$(rec_get BAA_STATUS)" && -n "$(rec_get QSOA_STATUS)" ]] || warn "BAA_STATUS and QSOA_STATUS are blank in $REC: no real client data until both are signed (deploy/fleet/README.md, Agreements)"
say ""
say "First sign-in: open https://$TENANT_DOMAIN and sign in as \"guest\" (the first administrator) with the temporary password"
say "in /var/lib/suds/first-admin-password.txt on the VM (ssh $SSH_USER@$IP, then sudo cat it once; it is deleted when changed)."
say "You are asked to change it, then to enrol two-step verification. This run never prints the password."

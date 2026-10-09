#!/usr/bin/env bash
# SUDS fleet (Option A): decommission one tenant. IRREVERSIBLE. The runbook is deploy/fleet/README.md, Teardown.
#
#   FLEET_HOME=<private ops directory> deploy/fleet/decommission-tenant.sh <FLEET_HOME>/tenants/<slug>.env [--apply]
#
# Deletes the tenant's DNS records, its instance and disks (with every snapshot of them) and its static IP, and
# crypto-shreds the escrowed keys. Afterwards nobody can recover that tenant's records: not from the VM, not from the
# disks, not from escrow. It refuses unless the tenant's record holds an export receipt (EXPORT_FILE, EXPORT_SHA256 and
# EXPORT_CONFIRMED_ON: the export delivered to the tenant and the date they confirmed they had checked it, because
# Medi-Cal and county retention rules can require the records for years) and, with --apply, unless the operator types
# the tenant slug and then DESTROY at two separate prompts. Without --apply it is a dry run and calls nothing.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/fleet/lib.sh
. "$HERE/lib.sh"
ENV_FILE=''
for a in "$@"; do case "$a" in --apply) DRY=0 ;; -h|--help) usage ;; -*) die "unknown option $a" ;; *) ENV_FILE=$a ;; esac; done
load_tenant "$ENV_FILE"
say "SUDS fleet: DECOMMISSION $SLUG ($TENANT_DOMAIN)$( (( DRY )) && printf ' — DRY RUN: nothing is called; --apply to act')"

step "0. Export receipt (tenant record $REC)"
[[ -f "$REC" ]] || die "no tenant record $REC"
ef=$(rec_get EXPORT_FILE) es=$(rec_get EXPORT_SHA256) ed=$(rec_get EXPORT_CONFIRMED_ON)
if [[ -z "$ef" || ! "$es" =~ ^[0-9a-f]{64}$ || ! "$ed" =~ ^20[0-9]{2}-[01][0-9]-[0-3][0-9]$ ]]; then
  die "no export receipt in $REC. Before any teardown: export the tenant's records, deliver them, and fill EXPORT_FILE (where the export is), EXPORT_SHA256 (its SHA-256) and EXPORT_CONFIRMED_ON (YYYY-MM-DD, the day the tenant confirmed they checked it). Retention rules (Medi-Cal, county) can require the records for years. Nothing was deleted."
fi
f=$ef; [[ "$f" == /* ]] || f=$FLEET_HOME/$f
if [[ -f "$f" && $(sha256_of "$f") != "$es" ]]; then die "$ef does not match EXPORT_SHA256: nothing was deleted"; fi
note "export $ef (SHA-256 $es), checked by the tenant on $ed"
IP=$(rec_get STATIC_IP); IP=${IP:-'<static-ip>'}
say ""
say "THIS IS IRREVERSIBLE. It deletes $TENANT_DOMAIN's DNS, the instance $INSTANCE, its disks and every snapshot of"
say "them, the static IP $IP, and shreds the escrowed keys in $ESC_DIR. No one can restore this tenant afterwards."
if (( ! DRY )); then
  for c in aws curl; do command -v "$c" >/dev/null 2>&1 || die "$c is not installed"; done
  if (( DNS_AUTO )); then load_porkbun; fi
  read -r -p "Type the tenant slug to confirm: " a1 || true
  [[ "$a1" == "$SLUG" ]] || die "that is not the tenant slug: nothing was deleted"
  read -r -p "Type DESTROY to delete $SLUG for ever: " a2 || true
  [[ "$a2" == DESTROY ]] || die "DESTROY was not typed: nothing was deleted"
  chain "$HIST" "decommission confirmed export_sha256=$es export_confirmed_on=$ed"
  chain "$ESC_LOG" "decommission-start slug=$SLUG"
fi

step "1. DNS: ${NAMES[*]}"
for n in "${NAMES[@]}"; do
  sub=$(sub_of "$n")
  if (( ! DNS_AUTO )); then say "  - YOUR STEP: remove the A record $n at the tenant's DNS provider (it points at an IP being released)"
  elif (( DRY )); then porkbun "deleteByNameType/$DNS_ZONE/A/$sub"
  else
    got=$(porkbun "retrieveByNameType/$DNS_ZONE/A/$sub"); got=${got// /}
    if [[ "$got" == *'"records":[]'* ]]; then note "$n: no A record"; else porkbun "deleteByNameType/$DNS_ZONE/A/$sub" >/dev/null; note "$n: A record deleted"; fi
  fi
done

step "2. Instance $INSTANCE and its snapshots"
(( DRY )) && say "+ aws lightsail get-instance-snapshots / get-disk-snapshots: delete every snapshot of $INSTANCE and of its disks"
read -r -a snaps <<< "$(lsq get-instance-snapshots --query "instanceSnapshots[?fromInstanceName=='$INSTANCE'].name")"
for s in "${snaps[@]}"; do [[ "$s" == NotFound ]] || ls_ delete-instance-snapshot --instance-snapshot-name "$s"; done
if (( DRY )) || exists get-instance --instance-name "$INSTANCE" --query instance.name; then ls_ delete-instance --instance-name "$INSTANCE" --force-delete-add-ons; fi
wait_eq NotFound "instance $INSTANCE is gone" get-instance --instance-name "$INSTANCE" --query instance.name

step "3. Disks and their snapshots"
for d in "${DISKS[@]}"; do
  name=$INSTANCE-${d%%:*}
  read -r -a snaps <<< "$(lsq get-disk-snapshots --query "diskSnapshots[?fromDiskName=='$name'].name")"
  for s in "${snaps[@]}"; do [[ "$s" == NotFound ]] || ls_ delete-disk-snapshot --disk-snapshot-name "$s"; done
  if (( DRY )) || exists get-disk --disk-name "$name" --query disk.name; then
    wait_eq available "disk $name is detached" get-disk --disk-name "$name" --query disk.state
    ls_ delete-disk --disk-name "$name" --force-delete-add-ons
  fi
  wait_eq NotFound "disk $name is gone" get-disk --disk-name "$name" --query disk.name
done

step "4. Static IP $IP_NAME"
if (( DRY )) || exists get-static-ip --static-ip-name "$IP_NAME" --query staticIp.name; then ls_ release-static-ip --static-ip-name "$IP_NAME"; fi
wait_eq NotFound "static IP $IP_NAME is released" get-static-ip --static-ip-name "$IP_NAME" --query staticIp.name
if [[ -f "$FLEET_HOME/known_hosts" ]] && command -v ssh-keygen >/dev/null 2>&1; then act ssh-keygen -R "$IP" -f "$FLEET_HOME/known_hosts" || true; fi

step "5. Crypto-shred the escrowed keys ($ESC_DIR)"
shredded=0
if (( DRY )); then say "+ shred -u every file in $ESC_DIR, then remove it"; else
  for f in "$ESC_DIR"/*; do [[ -f "$f" ]] || continue; chmod u+w "$f"; shred_file "$f"; shredded=$((shredded + 1)); done
  [[ ! -d "$ESC_DIR" ]] || rmdir "$ESC_DIR"
  note "$shredded escrow file(s) shredded; $ESC_DIR removed"
fi

step "6. Tenant record"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
rec_set STATUS decommissioned DECOMMISSIONED_AT "$now" ESCROW_SHREDDED_AT "$now" ESCROW_FILE ''
note_text="decommissioned slug=$SLUG domain=$TENANT_DOMAIN escrow_sha256=$(rec_get ESCROW_SHA256) files_shredded=$shredded export_sha256=$es"
(( DRY )) || note_text+=" record_sha256=$(sha256_of "$REC")"
chain "$HIST" "$note_text"
chain "$ESC_LOG" "$note_text"
say ""
say "Done$( (( DRY )) && printf ' (dry run)'). Now destroy every OFFLINE copy of the escrow file (SHA-256 $(rec_get ESCROW_SHA256)) and"
say "record who did it and when in $REC. Keep the export receipt and this record for the retention period."

#!/usr/bin/env bash
# Runs ON a tenant's VM, as root, before deploy/linux/install.sh (provision-tenant.sh copies it there and runs it):
#
#   prepare-host.sh <data-gb|0> <offsite-gb> <anchors-gb>
#
# The blank disks are told apart by size (exactly N GiB, no partitions, not mounted). The data disk becomes a LUKS2
# volume opened at boot with a key file on the root disk (/etc/suds-luks, root only; escrowed with the SUDS keys)
# and mounted at /var/lib/suds; suds.service then requires that mount. The offsite and anchor disks get ext4 at
# /mnt/suds-offsite and /mnt/suds-anchors, owned by the suds account. Re-runnable: a mounted target is kept, and a
# disk that already holds anything is never formatted.
set -euo pipefail
umask 077
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 3 && "$1$2$3" =~ ^[0-9]+$ ]] || die "usage: prepare-host.sh <data-gb|0> <offsite-gb> <anchors-gb>"
[[ $EUID -eq 0 ]] || die "run as root"
KEY=/etc/suds-luks/suds-data.key
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get install -y -q --no-install-recommends cryptsetup unzip
id -u suds >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/suds --no-create-home --shell /usr/sbin/nologin suds

# The one blank disk of exactly $1 GiB.
disk_of() {
  local name size type found=()
  while read -r name size type; do
    [[ $type == disk && $size == $(( $1 * 1073741824 )) && $(lsblk -n -r -o NAME "/dev/$name" | wc -l) -eq 1 ]] || continue
    findmnt -n -S "/dev/$name" >/dev/null 2>&1 || found+=("/dev/$name")
  done < <(lsblk -b -d -n -r -o NAME,SIZE,TYPE)
  [[ ${#found[@]} -eq 1 ]] || die "expected exactly one blank, unmounted $1 GB disk, found: ${found[*]:-none} (is it attached?)"
  blkid "${found[0]}" >/dev/null 2>&1 && die "${found[0]} ($1 GB) already holds a filesystem or LUKS header: not formatting it"
  printf '%s' "${found[0]}"
}
mount_new() { # DEVICE DIR — ext4, by UUID in fstab, mounted
  mkfs.ext4 -q "$1"; install -d -m 0700 "$2"
  printf 'UUID=%s %s ext4 defaults,nofail 0 2\n' "$(blkid -o value -s UUID "$1")" "$2" >> /etc/fstab
  mount "$2"
}

if (( $1 > 0 )); then
  if mountpoint -q /var/lib/suds; then echo "  - /var/lib/suds is mounted: kept"; else
    dev=$(disk_of "$1")
    install -d -m 0700 /etc/suds-luks
    [[ -s $KEY ]] || head -c 64 /dev/urandom > "$KEY"; chmod 0400 "$KEY"
    cryptsetup luksFormat --type luks2 --batch-mode --key-file "$KEY" "$dev"
    printf 'suds-data UUID=%s %s luks,discard,nofail\n' "$(blkid -o value -s UUID "$dev")" "$KEY" >> /etc/crypttab
    cryptsetup open --key-file "$KEY" "$dev" suds-data
    mkfs.ext4 -q /dev/mapper/suds-data; install -d -m 0700 /var/lib/suds
    echo '/dev/mapper/suds-data /var/lib/suds ext4 defaults,nofail 0 2' >> /etc/fstab
    mount /var/lib/suds
  fi
  # Never start SUDS on the root disk when the encrypted volume is not mounted.
  install -d -m 0755 /etc/systemd/system/suds.service.d
  (umask 022; printf '[Unit]\nRequiresMountsFor=/var/lib/suds\n' > /etc/systemd/system/suds.service.d/20-fleet-data.conf)
fi
for pair in "$2:/mnt/suds-offsite" "$3:/mnt/suds-anchors"; do
  dir=${pair#*:}
  if mountpoint -q "$dir"; then echo "  - $dir is mounted: kept"; else dev=$(disk_of "${pair%%:*}"); mount_new "$dev" "$dir"; fi
  chown suds:suds "$dir"; chmod 0700 "$dir"
done
systemctl daemon-reload
lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS

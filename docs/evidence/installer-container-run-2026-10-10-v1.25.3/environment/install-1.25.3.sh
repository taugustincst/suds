#!/bin/bash
# The installer command of every 1.25.3 run here; extra arguments (--dry-run, --caddy-tarball=…, --admin-cidr=…) go
# last and win. The 1.23.0 run's options, unchanged.
cd /root/suds-v1.25.3 || exit 2
caddy=/root/caddy_2.10.2_linux_amd64.tar.gz
for a in "$@"; do case "$a" in --caddy-tarball=*) caddy=${a#*=} ;; esac; done
rest=(); for a in "$@"; do case "$a" in --caddy-tarball=*) ;; *) rest+=("$a") ;; esac; done
set -x
exec deploy/linux/install.sh --domain=suds.county.test --admin-cidr=10.20.0.0/16 \
  --offsite=/mnt/suds-offsite --anchors=/mnt/worm/suds-anchors --tls=county-cert --cert=/root/pki/site.pem \
  --key=/root/pki/site.key --ca-file=/root/pki/ca.pem --source=/root/suds-v1.25.3.zip \
  --release-sha256=d70101e1d0332beff63beef329cea7089bbe1afd4f58e34beb845a1e556239cc \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball="$caddy" \
  --ntp-server=time.county.test \
  --accept-unencrypted-disk="installer drill in a systemd container: no LUKS volume attached" --console-access "${rest[@]}"

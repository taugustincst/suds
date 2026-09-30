#!/bin/bash
# 1.19.0's own installer (the server to be upgraded). The suds user and the shares' owner are set first, as a
# 1.19.0 operator had to (finding 2 of the 1.19.0 run).
set -x
id -u suds >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/suds --no-create-home --shell /usr/sbin/nologin suds
chown suds:suds /mnt/suds-offsite /mnt/worm/suds-anchors && chmod 0700 /mnt/suds-offsite /mnt/worm/suds-anchors
cd /root/suds-v1.19.0 || exit 2
exec deploy/linux/install.sh --domain=suds.county.test --admin-cidr=10.20.0.0/16 \
  --offsite=/mnt/suds-offsite --anchors=/mnt/worm/suds-anchors --tls=county-cert --cert=/root/pki/site.pem \
  --key=/root/pki/site.key --ca-file=/root/pki/ca.pem --source=/root/suds-v1.19.0.zip \
  --release-sha256=c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz \
  --ntp-server=time.county.test \
  --accept-unencrypted-disk="installer drill in a systemd container: no LUKS volume attached" --console-access --skip-compliance-check

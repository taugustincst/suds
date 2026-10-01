#!/bin/bash
# 1.22.0's own installer (the server to be upgraded). The suds user and the shares' owner are set first so the
# run goes straight through (it would create the account and refuse once, naming both shares, as the fresh install of 1.23.0 here shows).
set -x
id -u suds >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/suds --no-create-home --shell /usr/sbin/nologin suds
chown suds:suds /mnt/suds-offsite /mnt/worm/suds-anchors && chmod 0700 /mnt/suds-offsite /mnt/worm/suds-anchors
cd /root/suds-v1.22.0 || exit 2
exec deploy/linux/install.sh --domain=suds.county.test --admin-cidr=10.20.0.0/16 \
  --offsite=/mnt/suds-offsite --anchors=/mnt/worm/suds-anchors --tls=county-cert --cert=/root/pki/site.pem \
  --key=/root/pki/site.key --ca-file=/root/pki/ca.pem --source=/root/suds-v1.22.0.zip \
  --release-sha256=0798dc42106c95139ff4ed7f72fb3d6b95f32b8ce9cb197e6f01a1970168f1c3 \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz \
  --ntp-server=time.county.test \
  --accept-unencrypted-disk="installer drill in a systemd container: no LUKS volume attached" --console-access --skip-compliance-check

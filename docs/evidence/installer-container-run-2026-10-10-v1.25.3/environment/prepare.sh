#!/bin/bash
# Container preparation for the installer run on 1.25.3 (docs/evidence/installer-container-run-2026-10-10-v1.25.3).
# $1: the release to unpack (1.25.1 or 1.25.3). As the 1.23.0 run's, with www.suds.county.test added to the hosts file
# and to the throwaway certificate, for the www redirect the upgrade from 1.25.1 carries over.
set -euo pipefail
# Docker mounts / with private propagation; systemd's LoadCredential= mounts need shared (a real boot has it).
mount --make-rshared /
grep -q ' suds.county.test' /etc/hosts || echo '127.0.0.1 suds.county.test www.suds.county.test' >> /etc/hosts
mkdir -p /root/pki && cd /root/pki
if [[ ! -f site.pem ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj '/CN=Throwaway County Test CA' -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj '/CN=suds.county.test' -keyout site.key -out site.csr 2>/dev/null
  printf 'subjectAltName=DNS:suds.county.test,DNS:www.suds.county.test\nextendedKeyUsage=serverAuth\n' > ext.cnf
  openssl x509 -req -in site.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -extfile ext.cnf -out site.pem 2>/dev/null
fi
cp /root/files/suds-v$1.zip /root/files/node-v22.23.3-linux-x64.tar.xz /root/files/caddy_2.10.2_linux_amd64.tar.gz /root/files/caddy-truncated.tar.gz /root/
cd /root && rm -rf suds-v$1 && unzip -q suds-v$1.zip
echo "prepared $1; shares: $(stat -c '%n %U:%G %a' /mnt/suds-offsite /mnt/worm/suds-anchors | tr '\n' ' ')"

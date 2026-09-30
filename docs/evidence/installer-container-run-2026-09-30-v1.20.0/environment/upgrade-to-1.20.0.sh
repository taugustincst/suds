#!/bin/bash
# The documented upgrade (docs/SELF-HOSTING.md, "Upgrading"): the INSTALLED release's upgrader, to 1.20.0.
cp /root/files/suds-v1.20.0.zip /root/
echo "$ grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env   (before)"; grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env
set -x
/opt/suds/current/deploy/linux/upgrade.sh 1.20.0 --source=/root/suds-v1.20.0.zip \
  --release-sha256=048e928499fa3569dfcfc59af86633ad4f8176d3bba1c0dd2fe61b62c35fb9ff \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz
rc=$?
set +x
echo "upgrade.sh exit $rc"
echo "$ readlink /opt/suds/current"; readlink /opt/suds/current
echo "$ grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf"; grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf
echo "$ grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env   (after)"; grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env
echo "$ curl https://suds.county.test/api/health"; curl -sS --cacert /root/pki/ca.pem -w '\nHTTP %{http_code}\n' https://suds.county.test/api/health
echo "$ ls /var/lib/suds/pre-migration"; ls /var/lib/suds/pre-migration

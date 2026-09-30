#!/bin/bash
# The same upgrade with 1.20.0's own upgrader, from the unpacked 1.20.0 zip, instead of the installed 1.19.0 one.
cp /root/files/suds-v1.20.0.zip /root/ && cd /root && rm -rf suds-v1.20.0 && unzip -q suds-v1.20.0.zip
echo "$ grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env   (before)"; grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env
set -x
/root/suds-v1.20.0/deploy/linux/upgrade.sh 1.20.0 --source=/root/suds-v1.20.0.zip \
  --release-sha256=048e928499fa3569dfcfc59af86633ad4f8176d3bba1c0dd2fe61b62c35fb9ff \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz
rc=$?
set +x
echo "upgrade.sh exit $rc"
echo "$ grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf"; grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf
echo "$ grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env   (after)"; grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env
echo "$ curl https://suds.county.test/api/health"; curl -sS --cacert /root/pki/ca.pem -w '\nHTTP %{http_code}\n' https://suds.county.test/api/health
mkdir -p /root/evidence && cp /var/lib/suds-compliance/compliance-*.json /etc/suds/compliance-signing-key.pub.pem /root/evidence/

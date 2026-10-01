#!/bin/bash
# The 1.21.0 hand-over, exercised: the INSTALLED 1.21.0 upgrade.sh upgrading to a probe build that differs from 1.21.0
# only in its version (1.21.99) and one comment line at the end of its deploy/linux/upgrade.sh, so that the staged
# upgrade.sh differs from the installed one. Not a release; it exists only in this throwaway container.
# (A 1.21.0 -> 1.21.0 re-run cannot show it: upgrade.sh stops with "SUDS 1.21.0 is already the running version".)
cp /root/files/suds-v1.21.99.zip /root/
echo "$ /opt/suds/current/deploy/linux/upgrade.sh 1.21.0 ...   (the same version again)"
/opt/suds/current/deploy/linux/upgrade.sh 1.21.0 --source=/root/suds-v1.21.0.zip \
  --release-sha256=b69f629f2cc9587c1f32b021de8a86cd24484aa0b34b8cafc331d5f4485f2207 2>&1 | tail -n 3
echo; echo "$ /opt/suds/current/deploy/linux/upgrade.sh 1.21.99 ... --dry-run"
/opt/suds/current/deploy/linux/upgrade.sh 1.21.99 --source=/root/suds-v1.21.99.zip \
  --release-sha256=74cee4516cf255f150ff4ba7d754ed7893703b276265a2c054d53d84790e338e \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz --dry-run 2>&1 | grep -E 'hand over|Stage|^SUDS Server upgrade'
echo "dry-run exit ${PIPESTATUS[0]}"
echo; echo "$ ls /opt/suds   (the dry run staged nothing)"; ls /opt/suds
echo
set -x
/opt/suds/current/deploy/linux/upgrade.sh 1.21.99 --source=/root/suds-v1.21.99.zip \
  --release-sha256=74cee4516cf255f150ff4ba7d754ed7893703b276265a2c054d53d84790e338e \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz
rc=$?
set +x
echo "upgrade.sh exit $rc"
echo "$ readlink /opt/suds/current"; readlink /opt/suds/current
echo "$ tail -n 1 /opt/suds/current/deploy/linux/upgrade.sh"; tail -n 1 /opt/suds/current/deploy/linux/upgrade.sh
echo "$ grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf"; grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf
echo "$ curl https://suds.county.test/api/health"; curl -sS --cacert /root/pki/ca.pem -w '\nHTTP %{http_code}\n' https://suds.county.test/api/health
exit $rc

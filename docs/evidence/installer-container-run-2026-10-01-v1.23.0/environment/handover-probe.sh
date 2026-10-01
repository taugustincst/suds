#!/bin/bash
# The hand-over, exercised on the server just upgraded to 1.23.0 (the real 1.22.0 -> 1.23.0 upgrade did not hand over:
# both releases ship the same upgrade.sh and lib.sh). The INSTALLED 1.23.0 upgrade.sh upgrading to a probe build that
# differs from 1.23.0 only in its version (1.23.99) and one comment line at the end of its deploy/linux/upgrade.sh, so
# that the staged upgrade.sh differs from the installed one. Not a release; it exists only in this throwaway container.
cp /root/files/suds-v1.23.99.zip /root/
echo "$ /opt/suds/current/deploy/linux/upgrade.sh 1.23.99 ... --dry-run   (the lines naming the hand-over)"
/opt/suds/current/deploy/linux/upgrade.sh 1.23.99 --source=/root/suds-v1.23.99.zip \
  --release-sha256=6fb714037d3eb534595ae7b078927618a25f7d3d0bb014e4ca84a569817a8e73 \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz --dry-run 2>&1 | grep -E 'hand over|^SUDS Server upgrade'
echo "dry-run exit ${PIPESTATUS[0]}"
echo
set -x
/opt/suds/current/deploy/linux/upgrade.sh 1.23.99 --source=/root/suds-v1.23.99.zip \
  --release-sha256=6fb714037d3eb534595ae7b078927618a25f7d3d0bb014e4ca84a569817a8e73 \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz
rc=$?
set +x
echo "upgrade.sh exit $rc"
echo "$ readlink /opt/suds/current"; readlink /opt/suds/current
echo "$ tail -n 1 /opt/suds/current/deploy/linux/upgrade.sh"; tail -n 1 /opt/suds/current/deploy/linux/upgrade.sh
echo "$ curl https://suds.county.test/api/health"; curl -sS --cacert /root/pki/ca.pem -w '\nHTTP %{http_code}\n' https://suds.county.test/api/health
exit $rc

#!/bin/bash
# After the installer: what an operator (and a monitor) sees on day one. Run as root in the container.
set -u
say() { printf '\n$ %s\n' "$*"; }
say "curl https://suds.county.test/api/health (through Caddy, the county CA)"
curl -sS --cacert /root/pki/ca.pem -w '\nHTTP %{http_code}\n' https://suds.county.test/api/health
say "curl -I http://suds.county.test/"
curl -sS -o /dev/null -w 'HTTP %{http_code} -> %{redirect_url}\n' http://suds.county.test/
say "response headers (HSTS)"
curl -sS -D - -o /dev/null --cacert /root/pki/ca.pem https://suds.county.test/ | grep -i '^strict-transport-security'
say "grep -E 'RELEASE_CHECKSUM|SUDS_VERSION' /etc/suds/suds-server.conf"
grep -E 'RELEASE_CHECKSUM|SUDS_VERSION' /etc/suds/suds-server.conf
say "cat /opt/suds/current/.suds-release-checksum"
cat /opt/suds/current/.suds-release-checksum
say "grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env"
grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env
say "ls -l /mnt/suds-offsite /var/lib/suds/backups (first backup and drill, made by the installer)"
ls -l /mnt/suds-offsite /var/lib/suds/backups
say "first administrator (guest, the temporary password from /var/lib/suds/first-admin-password.txt, not printed) signs in over HTTPS"
body=$(printf '{"username":"guest","password":"%s"}' "$(tr -d '\n' < /var/lib/suds/first-admin-password.txt)")
curl -sS --cacert /root/pki/ca.pem -H 'Content-Type: application/json' -H 'X-Requested-With: suds' -d "$body" -w '\nHTTP %{http_code}\n' https://suds.county.test/api/auth/login \
  | grep -oE '"(must_change_password|mfaPending|role|username)":[^,}]*|HTTP [0-9]+'

#!/bin/bash
# After the installer (or an upgrade): what an operator (and a monitor) sees on day one, and three of the live-test
# items 1.25.3 fixed (MINOR-2, INFO-2, INFO-3: docs/evidence/pentest-suds-systems-2026-10-08.md; MINOR-1 is
# lockout-probe.sh). Run as root in the container.
set -u
say() { printf '\n$ %s\n' "$*"; }
C=(--cacert /root/pki/ca.pem)
say "version running"; /opt/suds/node/bin/node -p 'require("/opt/suds/current/package.json").version'
say "curl https://suds.county.test/api/health (anonymous: only ok, uptime_seconds, database — MINOR-2)"
curl -sS "${C[@]}" -w '\nHTTP %{http_code}\n' https://suds.county.test/api/health
say "curl -I http://suds.county.test/"
curl -sS -o /dev/null -w 'HTTP %{http_code} -> %{redirect_url}\n' http://suds.county.test/
say "response headers of https://suds.county.test/: HSTS, and no Via or Server header (INFO-2)"
curl -sS -D - -o /dev/null "${C[@]}" https://suds.county.test/ | grep -iE '^(strict-transport-security|via|server):' || true
echo "  Via headers: $(curl -sS -D - -o /dev/null "${C[@]}" https://suds.county.test/ | grep -ci '^via:')"
say "file-like paths and other methods (INFO-3): /.env, /.git/HEAD, POST /"
for p in /.env /.git/HEAD; do curl -sS -o /dev/null "${C[@]}" -w "  GET $p HTTP %{http_code}\n" "https://suds.county.test$p"; done
curl -sS -o /dev/null "${C[@]}" -X POST -w '  POST / HTTP %{http_code}\n' https://suds.county.test/
say "grep -E 'RELEASE_CHECKSUM|SUDS_VERSION' /etc/suds/suds-server.conf"
grep -E 'RELEASE_CHECKSUM|SUDS_VERSION' /etc/suds/suds-server.conf
say "cat /opt/suds/current/.suds-release-checksum"
cat /opt/suds/current/.suds-release-checksum
say "grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env"
grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env
say "ls -l /mnt/suds-offsite /var/lib/suds/backups (first backup and drill, made by the installer)"
ls -l /mnt/suds-offsite /var/lib/suds/backups
say "ls -la /etc/caddy/Caddyfile.d; tail -n 3 /etc/caddy/Caddyfile"
ls -la /etc/caddy/Caddyfile.d; tail -n 3 /etc/caddy/Caddyfile
say "first administrator (guest, the temporary password from /var/lib/suds/first-admin-password.txt, not printed) signs in over HTTPS"
body=$(printf '{"username":"guest","password":"%s"}' "$(tr -d '\n' < /var/lib/suds/first-admin-password.txt)")
curl -sS "${C[@]}" -H 'Content-Type: application/json' -H 'X-Requested-With: suds' -d "$body" -w '\nHTTP %{http_code}\n' https://suds.county.test/api/auth/login \
  | grep -oE '"(must_change_password|mfaPending|role|username)":[^,}]*|HTTP [0-9]+'

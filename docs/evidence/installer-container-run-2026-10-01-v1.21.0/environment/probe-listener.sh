#!/bin/bash
# Finding probe: the routes that describe the listener (server/listener.js describe(), which calls
# os.networkInterfaces()), answered by the installed service, whose unit has RestrictAddressFamilies=AF_INET AF_INET6
# AF_UNIX. Signs in as the first administrator (temporary password from the file; not printed) and prints only
# status codes and error messages.
set -u
say() { printf '\n$ %s\n' "$*"; }
say "grep -n RestrictAddressFamilies /etc/systemd/system/suds.service"
grep -n RestrictAddressFamilies /etc/systemd/system/suds.service
say "os.networkInterfaces() in a unit with the same RestrictAddressFamilies, and without it"
systemd-run --quiet --wait --pipe --collect -p RestrictAddressFamilies="AF_INET AF_INET6 AF_UNIX" /opt/suds/node/bin/node -e 'try{console.log("restricted: "+Object.keys(require("os").networkInterfaces()).join(","))}catch(e){console.log("restricted: "+e.code+" "+e.message)}'
systemd-run --quiet --wait --pipe --collect /opt/suds/node/bin/node -e 'try{console.log("unrestricted: "+Object.keys(require("os").networkInterfaces()).join(","))}catch(e){console.log("unrestricted: "+e.code+" "+e.message)}'
say "journalctl -u suds: the start's 'listening on' line, and unhandled rejections"
journalctl -u suds --no-pager -o cat | grep -E 'listening on|unhandled rejection' | sed 's/^/  /'
jar=$(mktemp); body=$(printf '{"username":"guest","password":"%s"}' "$(tr -d '\n' < /var/lib/suds/first-admin-password.txt)")
say "POST /api/auth/login (guest, the temporary password from /var/lib/suds/first-admin-password.txt, not printed)"
curl -sS -c "$jar" --cacert /root/pki/ca.pem -H 'Content-Type: application/json' -H 'X-Requested-With: suds' -d "$body" -o /dev/null -w 'HTTP %{http_code}\n' https://suds.county.test/api/auth/login
for p in /api/setup/status /api/app/info; do
  say "GET $p (signed in)"
  curl -sS -b "$jar" --cacert /root/pki/ca.pem -H 'X-Requested-With: suds' -w '\nHTTP %{http_code}\n' "https://suds.county.test$p" | cut -c1-300
done
rm -f "$jar"

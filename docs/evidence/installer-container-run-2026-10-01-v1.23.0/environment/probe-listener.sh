#!/bin/bash
# The 1.21.0 run's finding 1, checked on 1.23.0 (fixed in 1.22.0: server/listener.js reads "no LAN addresses" when the
# service's sandbox refuses the interface list). The unit still has RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# (no AF_NETLINK), so os.networkInterfaces() still fails under it; SUDS should start and answer anyway: the start's
# "listening on" line, no unhandled rejection, and the two routes that describe the listener answering 200 for a
# signed-in session. Signs in as the first administrator (temporary password from the file; not printed) and prints
# only status codes and the listener's description.
set -u
say() { printf '\n$ %s\n' "$*"; }
since=$(systemctl show -p ActiveEnterTimestamp --value suds)
say "version running"
/opt/suds/node/bin/node -p 'require("/opt/suds/current/package.json").version'
say "grep -n RestrictAddressFamilies /etc/systemd/system/suds.service"
grep -n RestrictAddressFamilies /etc/systemd/system/suds.service
say "os.networkInterfaces() in a unit with the same RestrictAddressFamilies, and without it"
systemd-run --quiet --wait --pipe --collect -p RestrictAddressFamilies="AF_INET AF_INET6 AF_UNIX" /opt/suds/node/bin/node -e 'try{console.log("restricted: "+Object.keys(require("os").networkInterfaces()).join(","))}catch(e){console.log("restricted: "+e.code+" "+e.message)}'
systemd-run --quiet --wait --pipe --collect /opt/suds/node/bin/node -e 'try{console.log("unrestricted: "+Object.keys(require("os").networkInterfaces()).join(","))}catch(e){console.log("unrestricted: "+e.code+" "+e.message)}'
say "journalctl -u suds (since this start, $since): the 'listening on' line, and unhandled rejections"
journalctl -u suds --no-pager -o cat --since "$since" | grep -E 'listening on|unhandled rejection' | sed 's/^/  /'
echo "  unhandled rejections since this start: $(journalctl -u suds --no-pager -o cat --since "$since" | grep -c 'unhandled rejection')"
jar=$(mktemp); body=$(printf '{"username":"guest","password":"%s"}' "$(tr -d '\n' < /var/lib/suds/first-admin-password.txt)")
say "POST /api/auth/login (guest, the temporary password from /var/lib/suds/first-admin-password.txt, not printed)"
curl -sS -c "$jar" --cacert /root/pki/ca.pem -H 'Content-Type: application/json' -H 'X-Requested-With: suds' -d "$body" -o /dev/null -w 'HTTP %{http_code}\n' https://suds.county.test/api/auth/login
for p in /api/setup/status /api/app/info; do
  say "GET $p (signed in)"
  curl -sS -b "$jar" --cacert /root/pki/ca.pem -H 'X-Requested-With: suds' -w '\nHTTP %{http_code}\n' "https://suds.county.test$p" \
    | /opt/suds/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.lastIndexOf("\nHTTP ");const b=s.slice(0,i);const code=s.slice(i+6).trim();let j=null;try{j=JSON.parse(b)}catch{};const l=j&&(j.listener||(j.env&&j.env.listener));console.log("HTTP "+code+(j&&j.error?" error: "+j.error:"")+(l?" listener: "+JSON.stringify(l).slice(0,300):""))})'
done
rm -f "$jar"

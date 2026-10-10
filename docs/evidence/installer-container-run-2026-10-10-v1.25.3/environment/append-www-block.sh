#!/bin/bash
# What suds.systems did on launch day, on this 1.25.1 server: a www block appended by hand to /etc/caddy/Caddyfile, a
# redirect to the one name SUDS serves, then Caddy restarted. Launch day's block had only the redir line (Caddy got the
# www certificate by ACME); with no network here the block imports the county TLS file instead, whose certificate
# names www.suds.county.test too (prepare.sh).
set -u
echo '$ cmp /opt/suds/1.25.1/Caddyfile /etc/caddy/Caddyfile   (before: the release copy)'
cmp /opt/suds/1.25.1/Caddyfile /etc/caddy/Caddyfile && echo identical
cat >> /etc/caddy/Caddyfile <<'CADDY'

www.suds.county.test {
	import {$SUDS_CADDY_TLS:/dev/null}
	redir https://suds.county.test{uri} permanent
}
CADDY
echo '$ tail -n 5 /etc/caddy/Caddyfile'; tail -n 5 /etc/caddy/Caddyfile
echo '$ systemctl restart caddy'; systemctl restart caddy; sleep 2; systemctl is-active caddy
echo '$ curl -sI https://www.suds.county.test/foo'
curl -sS -D - -o /dev/null --cacert /root/pki/ca.pem https://www.suds.county.test/foo | grep -iE '^(HTTP|location|via)'

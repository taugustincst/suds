#!/bin/bash
# The upgrade 1.25.1 -> 1.25.3 with the upgrader installed with 1.25.1 (/opt/suds/current/deploy/linux/upgrade.sh), its
# dry run first. 1.25.3 changed deploy/linux/upgrade.sh and lib.sh, so the installed one hands over to 1.25.3's.
cp /root/files/suds-v1.25.3.zip /root/ && cd /root && rm -rf suds-v1.25.3 && unzip -q suds-v1.25.3.zip
up=/opt/suds/current/deploy/linux/upgrade.sh
A=(1.25.3 --source=/root/suds-v1.25.3.zip --release-sha256=d70101e1d0332beff63beef329cea7089bbe1afd4f58e34beb845a1e556239cc
   --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz)
echo "$ readlink /opt/suds/current   (before)"; readlink /opt/suds/current
echo "$ cmp the installed upgrade.sh and lib.sh with 1.25.3's (the hand-over happens only when one differs)"
for f in upgrade.sh lib.sh; do cmp -s /opt/suds/current/deploy/linux/$f /root/suds-v1.25.3/deploy/linux/$f && echo "  $f: identical" || echo "  $f: differs"; done
echo "$ $up ${A[*]} --dry-run"
"$up" "${A[@]}" --dry-run 2>&1
echo "dry-run exit $?"
set -x
"$up" "${A[@]}"
rc=$?
set +x
echo "upgrade.sh exit $rc"
echo "$ readlink /opt/suds/current"; readlink /opt/suds/current
echo "$ grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf"; grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf
echo "$ ls -la /etc/caddy /etc/caddy/Caddyfile.d"; ls -la /etc/caddy /etc/caddy/Caddyfile.d
echo "$ cat /etc/caddy/Caddyfile.d/local.caddy"; cat /etc/caddy/Caddyfile.d/local.caddy
echo "$ cmp /opt/suds/1.25.3/Caddyfile /etc/caddy/Caddyfile"; cmp /opt/suds/1.25.3/Caddyfile /etc/caddy/Caddyfile && echo identical
echo "$ curl -sI https://www.suds.county.test/foo   (the moved redirect, after the upgrade restarted Caddy)"
curl -sS -D - -o /dev/null --cacert /root/pki/ca.pem https://www.suds.county.test/foo | grep -iE '^(HTTP|location|via)'
mkdir -p /root/evidence && cp /var/lib/suds-compliance/compliance-*.json /etc/suds/compliance-signing-key.pub.pem /root/evidence/ 2>/dev/null
f=$(ls -t /var/lib/suds-compliance/compliance-*.json 2>/dev/null | head -n1)
[[ -n "$f" ]] && /opt/suds/node/bin/node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(r.report||r).checks;const n={};for(const x of c)n[x.result]=(n[x.result]||0)+1;console.log("upgrade report "+require("path").basename(process.argv[1])+": "+JSON.stringify(n));for(const x of c)if(x.result!=="pass")console.log("  "+x.id+": "+x.result+(x.evidence?" — "+String(x.evidence).replace(/\s+/g," ").slice(0,300):""))' "$f"
exit $rc

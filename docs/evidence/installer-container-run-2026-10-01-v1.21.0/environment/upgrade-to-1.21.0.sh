#!/bin/bash
# An upgrade to 1.21.0. $1 says which upgrade.sh runs it:
#   new        the documented command from 1.21.0 on (docs/SELF-HOSTING.md, "Upgrading"): 1.21.0's own upgrade.sh,
#              from the unpacked 1.21.0 zip
#   installed  the upgrade.sh installed with the running release (/opt/suds/current/deploy/linux/upgrade.sh), what an
#              operator who keeps the older habit runs
cp /root/files/suds-v1.21.0.zip /root/ && cd /root && rm -rf suds-v1.21.0 && unzip -q suds-v1.21.0.zip
case "${1:-}" in
  new) up=/root/suds-v1.21.0/deploy/linux/upgrade.sh ;;
  installed) up=/opt/suds/current/deploy/linux/upgrade.sh ;;
  *) echo "usage: $0 new|installed"; exit 2 ;;
esac
echo "$ readlink /opt/suds/current   (before)"; readlink /opt/suds/current
echo "$ grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env   (before)"; grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env
set -x
"$up" 1.21.0 --source=/root/suds-v1.21.0.zip \
  --release-sha256=b69f629f2cc9587c1f32b021de8a86cd24484aa0b34b8cafc331d5f4485f2207 \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz
rc=$?
set +x
echo "upgrade.sh exit $rc"
echo "$ readlink /opt/suds/current"; readlink /opt/suds/current
echo "$ grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf"; grep -E 'SUDS_VERSION|RELEASE_CHECKSUM' /etc/suds/suds-server.conf
echo "$ grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env   (after)"; grep -E 'WEBAUTHN|TRUST_PROXY' /etc/suds/suds.env
echo "$ curl https://suds.county.test/api/health"; curl -sS --cacert /root/pki/ca.pem -w '\nHTTP %{http_code}\n' https://suds.county.test/api/health
echo "$ ls /var/lib/suds/pre-migration"; ls /var/lib/suds/pre-migration
echo "$ journalctl -u suds (this start): lines naming WEBAUTHN_RP_ID"
journalctl -u suds --no-pager -o cat --since "$(systemctl show -p ActiveEnterTimestamp --value suds)" | grep -n -A3 'WEBAUTHN_RP_ID' || echo "(none)"
mkdir -p /root/evidence && cp /var/lib/suds-compliance/compliance-*.json /etc/suds/compliance-signing-key.pub.pem /root/evidence/ 2>/dev/null
f=$(ls -t /var/lib/suds-compliance/compliance-*.json 2>/dev/null | head -n1)
[[ -n "$f" ]] && /opt/suds/node/bin/node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(r.report||r).checks;const n={};for(const x of c)n[x.result]=(n[x.result]||0)+1;console.log("upgrade report "+require("path").basename(process.argv[1])+": "+JSON.stringify(n));for(const id of ["app.passkeys","app.https","app.backups","app.dr_drill","host.release_integrity","host.time_sync"]){const x=c.find(y=>y.id===id);console.log("  "+id+": "+(x?x.result+(x.result!=="pass"&&x.evidence?" — "+String(x.evidence).replace(/\s+/g," ").slice(0,400):""):"-"))}' "$f"
exit $rc

#!/bin/bash
# After the 1.19.0 -> 1.20.0 upgrade: the weekly compliance unit as installed, then the passkey setting added by hand
# (docs/SELF-HOSTING.md, "After the install", step 5), SUDS restarted, and the weekly unit again.
report() { journalctl -u suds-compliance --no-pager -o cat | grep -E '^Result:|^Wrote .*json' | tail -n 2; f=$(ls -t /var/lib/suds-compliance/compliance-*.json | head -n1); /opt/suds/node/bin/node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(r.report||r).checks;for(const id of ["app.passkeys","app.https","app.backups","app.dr_drill","host.release_integrity"]){const x=c.find(y=>y.id===id);console.log("  "+id+": "+(x?x.result:"-"))}' "$f"; }
echo '$ systemctl start suds-compliance'; systemctl start suds-compliance; report
echo; echo '$ printf "WEBAUTHN_RP_ID=suds.county.test\nWEBAUTHN_ORIGINS=https://suds.county.test\n" >> /etc/suds/suds.env && systemctl restart suds'
printf 'WEBAUTHN_RP_ID=suds.county.test\nWEBAUTHN_ORIGINS=https://suds.county.test\n' >> /etc/suds/suds.env && systemctl restart suds
for i in $(seq 1 60); do curl -fsS --cacert /root/pki/ca.pem https://suds.county.test/api/health/ready >/dev/null 2>&1 && break; sleep 1; done
echo '$ systemctl start suds-compliance'; systemctl start suds-compliance; report
mkdir -p /root/evidence && cp /var/lib/suds-compliance/compliance-*.json /etc/suds/compliance-signing-key.pub.pem /root/evidence/

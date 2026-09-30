#!/bin/bash
# The operator's step 6 (docs/SELF-HOSTING.md, "After the install"): a recovery drill against the offsite copy with
# the escrowed key file (here made from /etc/suds/credentials, as "Download key backup" would give it), then the
# weekly compliance unit, and the server's public keys for verifying the reports off the server.
set -u
umask 077
: > /root/escrowed-keys.env
for k in suds_encryption_key suds_index_key suds_backup_key suds_signing_key; do
  printf '%s=%s\n' "$(tr '[:lower:]' '[:upper:]' <<< "$k")" "$(cat /etc/suds/credentials/$k)" >> /root/escrowed-keys.env
done
echo '$ as-suds.sh scripts/dr-drill.js --offsite --keys-file /run/credentials/suds-ops.service/escrow'
/root/files/as-suds.sh scripts/dr-drill.js --offsite --keys-file /run/credentials/suds-ops.service/escrow
echo "exit $?"
shred -u /root/escrowed-keys.env
echo; echo '$ systemctl start suds-compliance'
systemctl start suds-compliance; echo "exit $? ($(systemctl show -p Result --value suds-compliance))"
journalctl -u suds-compliance --no-pager -o cat | grep -E '^Result:|^Wrote' | tail -n 3
mkdir -p /root/evidence
cp /var/lib/suds/backups/dr-drill-*.json /var/lib/suds/backups/dr-drill-*.txt /var/lib/suds-compliance/compliance-*.json /etc/suds/compliance-signing-key.pub.pem /root/evidence/
/root/files/as-suds.sh /root/files/pubkey.js > /root/evidence/suds-signing-key.pem
ls -l /root/evidence

#!/bin/bash
# The operator's step 6 (docs/SELF-HOSTING.md, "After the install"): a recovery drill against the offsite copy with
# the escrowed key file (here made from /etc/suds/credentials, as "Download key backup" would give it), then the
# weekly compliance unit, and the server's public keys for verifying the reports off the server. (As the 1.23.0 run's,
# with the evidence public key read before the escrow file is shredded: that run's harness read it after, and failed.)
set -u
umask 077
: > /root/escrowed-keys.env
for k in suds_encryption_key suds_index_key suds_backup_key suds_signing_key; do
  printf '%s=%s\n' "$(tr '[:lower:]' '[:upper:]' <<< "$k")" "$(cat /etc/suds/credentials/$k)" >> /root/escrowed-keys.env
done
echo '$ as-suds.sh scripts/dr-drill.js --offsite --keys-file /run/credentials/suds-ops.service/escrow'
/root/files/as-suds.sh scripts/dr-drill.js --offsite --keys-file /run/credentials/suds-ops.service/escrow
echo "exit $?"
mkdir -p /root/evidence
install -m 0644 /root/files/pubkey.js /tmp/pubkey.js   # the suds user cannot read /root/files
/root/files/as-suds.sh /tmp/pubkey.js > /root/evidence/suds-signing-key.pem
shred -u /root/escrowed-keys.env
echo; echo '$ systemctl start suds-compliance'
systemctl start suds-compliance; echo "exit $? ($(systemctl show -p Result --value suds-compliance))"
journalctl -u suds-compliance --no-pager -o cat | grep -E '^Result:|^Wrote' | tail -n 3
mkdir -p /root/evidence
cp /var/lib/suds/backups/dr-drill-*.json /var/lib/suds/backups/dr-drill-*.txt /var/lib/suds-compliance/compliance-*.json /etc/suds/compliance-signing-key.pub.pem /root/evidence/
ls -l /root/evidence

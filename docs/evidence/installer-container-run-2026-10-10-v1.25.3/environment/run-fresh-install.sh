#!/bin/bash
# Host side: the fresh install of 1.25.3 in container suds-a, step by step, each step's output to out-a/<n>-<what>.txt.
set -u
V=$(cd "$(dirname "$0")" && pwd); O="$V/out-a"; mkdir -p "$O"
x() { docker exec suds-a "$@"; }
"$V/start.sh" suds-a a 1.25.3 > "$O/0-start.txt" 2>&1
x /root/files/install-1.25.3.sh --dry-run > "$O/1-dry-run.txt" 2>&1; echo "exit $?" >> "$O/1-dry-run.txt"
x /root/files/install-1.25.3.sh > "$O/2-run-refused-shares.txt" 2>&1; echo "exit $?" >> "$O/2-run-refused-shares.txt"
x /root/files/show.sh 'ls -ld /opt/suds /etc/suds 2>&1' 'chown suds:suds /mnt/suds-offsite /mnt/worm/suds-anchors && chmod 0700 /mnt/suds-offsite /mnt/worm/suds-anchors' >> "$O/2-run-refused-shares.txt" 2>&1
x /root/files/install-1.25.3.sh --caddy-tarball=/root/caddy-truncated.tar.gz > "$O/3-run-stopped-after-staging-bad-caddy-tarball.txt" 2>&1; echo "exit $?" >> "$O/3-run-stopped-after-staging-bad-caddy-tarball.txt"
x /root/files/show.sh 'ls /opt/suds' 'cat /opt/suds/1.25.3/.suds-release-checksum' 'ls -ld /etc/suds 2>&1' >> "$O/3-run-stopped-after-staging-bad-caddy-tarball.txt" 2>&1
x /root/files/install-1.25.3.sh > "$O/4-run-complete.txt" 2>&1; echo "exit $?" >> "$O/4-run-complete.txt"
x /root/files/after-install.sh > "$O/5-day-one.txt" 2>&1
x /root/files/ufw-rules.sh > "$O/5b-firewall.txt" 2>&1
x /root/files/lockout-probe.sh nobody-zzz guest > "$O/5c-lockout-probe.txt" 2>&1
x /root/files/install-1.25.3.sh --admin-cidr=0.0.0.0/0 --skip-compliance-check > "$O/6-rerun-admin-cidr-anywhere.txt" 2>&1; echo "exit $?" >> "$O/6-rerun-admin-cidr-anywhere.txt"
x /root/files/ufw-rules.sh > "$O/6b-firewall-after-rerun.txt" 2>&1
x /root/files/install-1.25.3.sh --skip-compliance-check > "$O/6c-rerun-admin-cidr-back.txt" 2>&1; echo "exit $?" >> "$O/6c-rerun-admin-cidr-back.txt"
x /root/files/ufw-rules.sh > "$O/6d-firewall-after-second-rerun.txt" 2>&1
x /root/files/escrow-drill.sh > "$O/7-escrow-drill-and-weekly-compliance.txt" 2>&1
docker cp suds-a:/root/evidence "$O/evidence"
echo done

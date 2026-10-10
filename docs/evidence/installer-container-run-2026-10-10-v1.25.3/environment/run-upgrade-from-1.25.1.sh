#!/bin/bash
# Host side: 1.25.1 installed with its own installer, a www block appended to its Caddyfile by hand (as suds.systems
# on launch day), then the upgrade to 1.25.3 with the upgrader installed with 1.25.1, in container suds-b; each
# step's output to out-b/<n>-<what>.txt.
set -u
V=$(cd "$(dirname "$0")" && pwd); O="$V/out-b"; mkdir -p "$O"
x() { docker exec suds-b "$@"; }
"$V/start.sh" suds-b b 1.25.1 > "$O/0-start.txt" 2>&1
x /root/files/install-1.25.1.sh > "$O/1-install-1.25.1.txt" 2>&1; echo "exit $?" >> "$O/1-install-1.25.1.txt"
x /root/files/after-install.sh > "$O/1b-day-one-on-1.25.1.txt" 2>&1
x /root/files/lockout-probe.sh nobody-zzz > "$O/1c-lockout-probe-on-1.25.1.txt" 2>&1
x /root/files/append-www-block.sh > "$O/2-www-block-appended-by-hand.txt" 2>&1
x /root/files/upgrade-to-1.25.3.sh > "$O/3-upgrade-to-1.25.3-with-installed-1.25.1-upgrader.txt" 2>&1; echo "exit $?" >> "$O/3-upgrade-to-1.25.3-with-installed-1.25.1-upgrader.txt"
x /root/files/after-install.sh > "$O/4-after-upgrade.txt" 2>&1
x /root/files/lockout-probe.sh nobody-yyy > "$O/4b-lockout-probe-after-upgrade.txt" 2>&1
x /root/files/escrow-drill.sh > "$O/5-escrow-drill-and-weekly-compliance.txt" 2>&1
docker cp suds-b:/root/evidence "$O/evidence"
echo done

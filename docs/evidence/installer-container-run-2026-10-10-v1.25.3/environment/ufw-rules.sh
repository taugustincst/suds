#!/bin/bash
# The host firewall as it is now (the launch finding: the SSH rule must survive the installer's clean-up).
echo '$ ufw status verbose'; ufw status verbose
echo; echo "SSH (22) allow rules in force: $(ufw status | grep -cE '^(22(/tcp)?|OpenSSH)( \(v6\))? +(ALLOW|LIMIT)')"

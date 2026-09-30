#!/usr/bin/env bash
# SUDS Server: remove the service, its units, the code and the pinned Node.js and Caddy. Never the records:
# /var/lib/suds (the database, backups, reports), /etc/suds/credentials (the keys) and the anchor and offsite
# shares are left exactly as they are, and what to do with them is printed — they are PHI and its keys, and
# their disposal follows the programme's retention and media-sanitisation policy (45 CFR §164.310(d)(2)(i);
# 42 CFR §2.16(a)(2)(ii)), not an uninstaller.
#
#   sudo /opt/suds/current/deploy/linux/uninstall.sh [--dry-run]
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/linux/lib.sh
. "$HERE/lib.sh"
for arg in "$@"; do case "$arg" in --dry-run) DRY=1 ;; *) die "unknown option $arg" ;; esac; done
require_root

act systemctl disable --now suds-compliance.timer suds.service caddy.service
for u in suds.service suds-compliance.service suds-compliance.timer caddy.service; do act rm -f "$(P "/etc/systemd/system/$u")"; done
act rm -rf "$(P /etc/systemd/system/suds.service.d)"
act systemctl daemon-reload
act rm -rf "$(P "$CODE_BASE")" "$(P /opt/caddy)"
say ""
say "SUDS Server is stopped and its software removed. Left in place, deliberately:"
say "  $DATA_DIR            the database and backups (PHI)"
say "  $COMPLIANCE_DIR  the signed compliance reports (evidence: keep six years)"
say "  $CRED_DIR   the keys that decrypt them; $COMPLIANCE_KEY (and .pub.pem)"
say "  /etc/suds/*.env, provision.json, suds-server.conf; /etc/caddy; the firewall rules; the anchor and offsite shares"
say "Keep them for the retention period your policy sets, or sanitise the media under that policy. To reinstall,"
say "run deploy/linux/install.sh again: it finds the database and the keys and carries on with them."

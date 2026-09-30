# deploy/linux — SUDS Server on a Linux VM

The files that install and run SUDS Server on Ubuntu 24.04 LTS or RHEL/Rocky/Alma 9. The guide is
[docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md); this page is the reference for the files.

| File | What it is |
| --- | --- |
| `install.sh` | The installer. Idempotent; `--dry-run` prints every action. `--help` lists the options |
| `upgrade.sh` | `upgrade.sh <version>`: stage and verify, stop, back up, swap, start, health check, roll back on failure |
| `uninstall.sh` | Removes the service and the software; never the data, the keys or the shares |
| `lib.sh` | Shared by the three scripts |
| `pins` | The exact Node.js and Caddy releases and their checksums (Node's must equal `.github/workflows/ci.yml`'s; `test/deploy-linux.test.js` checks) |
| `suds.service` | The systemd unit — the one copy; docs/DEPLOYMENT.md refers to it |
| `suds-compliance.service`, `suds-compliance.timer` | The weekly compliance check (`scripts/compliance-check.js`) |
| `caddy.service` | Caddy terminating TLS with the repository's `Caddyfile` |

## What it puts where

| Path | Owner, mode | Contents |
| --- | --- | --- |
| `/opt/suds/<version>`, `/opt/suds/current` → it | root, read-only | The SUDS release |
| `/opt/suds/node-<v>`, `/opt/suds/node` → it | root, read-only | The pinned Node.js |
| `/opt/caddy/<v>`, `/opt/caddy/current` → it | root | The pinned Caddy |
| `/var/lib/suds` | suds, 0700 | Database, backups, logs, compliance reports (on the LUKS volume) |
| `/etc/suds/credentials/suds_*` | root, 0600 (directory 0700) | The keys, loaded with `LoadCredential=`; never in an environment |
| `/etc/suds/suds.env` | root, 0644 | Non-secret settings (`TRUST_PROXY`, `LOCAL_MODE_ENABLED=false`, `MFA_REQUIRED_ROLES`, `AUDIT_ANCHOR_DIR`, …) |
| `/etc/suds/provision.json` | root, 0644 | Database settings applied where unset: backups every 4 h to the offsite share, monthly drill, MFA for every role (server/provision.js) |
| `/etc/suds/suds-server.conf` | root, 0644 | Site facts for the compliance check (domain, shares, admin network, accepted risks) |
| `/etc/systemd/system/suds.service.d/10-site.conf` | root, 0644 | The anchor and offsite mounts (`RequiresMountsFor`, `ReadWritePaths`), the metrics credential |
| `/etc/caddy/Caddyfile`, `suds.env`, `suds-tls.caddy` | root, 0644 | The repository's Caddyfile and its site values; TLS 1.2+ |
| `/etc/systemd/journald.conf.d/suds.conf` | root, 0644 | Persistent journal, `MaxRetentionSec` |

## Testing it

`test/deploy-linux.test.js` runs `install.sh` and `upgrade.sh` with `--dry-run` against a fake root (`SUDS_INSTALL_ROOT`)
with stub commands on `PATH`, for both distribution families, and checks the plan and every refusal. The scripts are
shellcheck-clean where shellcheck is installed (the test skips that step otherwise). Before a production install, run
it on a staging VM of the same image with `--dry-run`, then for real.

Downloads without internet access: fetch `node-<v>-linux-x64.tar.xz` and `caddy_<v>_linux_amd64.tar.gz` (versions in
`pins`) and the release zip elsewhere, copy them over, and pass `--node-tarball`, `--caddy-tarball`, `--source` and
`--release-sha256`; each is still checked against its pinned or published checksum.

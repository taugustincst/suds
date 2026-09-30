# deploy/linux — SUDS Server on a Linux VM

The files that install and run SUDS Server on Ubuntu 24.04 LTS or RHEL/Rocky/Alma 9. The guide is
[docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md); this page is the reference for the files.

| File | What it is |
| --- | --- |
| `install.sh` | The installer. Idempotent; `--dry-run` prints every action. `--help` lists the options |
| `upgrade.sh` | `upgrade.sh <version> --release-sha256=<hex>`: stage and verify, stop, back up, swap (Caddy too when its pin changed), start, health check, roll back on failure with `--restore-in-place` |
| `uninstall.sh` | Removes the service and the software; never the data, the keys or the shares |
| `lib.sh` | Shared by the three scripts |
| `pins` | The exact Node.js and Caddy releases and their checksums (Node's must equal `.github/workflows/ci.yml`'s; `test/deploy-linux.test.js` checks) |
| `suds.service` | The systemd unit — the one copy; docs/DEPLOYMENT.md refers to it |
| `suds-compliance.service`, `suds-compliance.timer` | The weekly compliance check (`scripts/compliance-check.js`) |
| `caddy.service` | Caddy terminating TLS with the repository's `Caddyfile` |

## What it puts where

| Path | Owner, mode | Contents |
| --- | --- | --- |
| `/opt/suds/<version>`, `/opt/suds/current` → it | root, directories 0755 then read-only | The SUDS release, with `.suds-manifest` (SHA-256 of every file) and `.suds-staged` (the manifest's hash: the stage completed). Staged in `<version>.partial` first |
| `/opt/suds/node-<v>`, `/opt/suds/node` → it | root, 0755 then read-only | The pinned Node.js |
| `/opt/caddy/<v>`, `/opt/caddy/current` → it | root, 0755 | The pinned Caddy (its version is checked after install) |
| `/var/lib/suds` | suds, 0700 | Database, backups, logs (on the LUKS volume) |
| `/var/lib/suds-compliance` | root:suds, 0750 (reports 0640) | The signed compliance reports: SUDS reads them, only root writes them |
| `/etc/suds/credentials/suds_*` | root, 0600 (directory 0700) | The keys, loaded with `LoadCredential=`; never in an environment |
| `/etc/suds/compliance-signing-key` | root, 0600 | The compliance check's own signing key; never given to `suds.service` |
| `/etc/suds/compliance-signing-key.pub.pem` | root, 0644 | Its public half: SUDS verifies reports with it (`SUDS_COMPLIANCE_PUBLIC_KEY_FILE`); give it to the auditor |
| `/etc/suds/suds.env` | root, 0644 | Non-secret settings (`TRUST_PROXY`, `LOCAL_MODE_ENABLED=false`, `MFA_REQUIRED_ROLES`, `AUDIT_ANCHOR_DIR`, `SUDS_COMPLIANCE_DIR`, …) |
| `/etc/suds/provision.json` | root, 0644 | Database settings applied where unset, and only if they tighten: backups every 4 h to the offsite share, monthly drill, MFA for every role (server/provision.js) |
| `/etc/suds/suds-server.conf` | root, 0644 | Site facts for the compliance check (domain, shares, admin network, `SUDS_CA_FILE`, `SUDS_CONNECT_HOST`, NTP servers, how the release was checked, first install date, accepted risks). Lines the installer does not manage are kept on a re-run |
| `/etc/suds/ca.pem` | root, 0644 | `--ca-file`: the county CA, for the compliance check's TLS test |
| `/etc/systemd/system/suds.service.d/10-site.conf` | root, 0644 | The anchor mount (`RequiresMountsFor`), `ReadWritePaths=<anchors> -<offsite>` (the offsite share optional: its outage never stops SUDS), the metrics credential |
| `/etc/caddy/Caddyfile`, `suds.env`, `suds-tls.caddy` | root, 0644 | The repository's Caddyfile and its site values; TLS 1.2+ |
| `/etc/systemd/journald.conf.d/suds.conf` | root, 0644 | Persistent journal, `MaxRetentionSec`, `SystemMaxUse` (`--journal-max-use`, default 8G) |
| `/etc/systemd/timesyncd.conf.d/suds.conf`, `/etc/chrony/sources.d/suds.sources`, `/etc/chrony.d/suds.conf` | root, 0644 | `--ntp-server`: the county time source (chrony is kept where installed) |

## Testing it

`test/deploy-linux.test.js` runs `install.sh` and `upgrade.sh` with `--dry-run` against a fake root (`SUDS_INSTALL_ROOT`)
with stub commands on `PATH`, for both distribution families, and checks the plan and every refusal.
`test/deploy-linux-real.test.js` runs them **for real** into a fake root: package managers, `systemctl`, `ufw`,
`firewall-cmd`, `useradd` and `chown` are stubs that record what they were asked, `install` is the real one with the
ownership recorded and left out, `curl` serves fixture Node.js and Caddy tarballs whose checksums are in the test
tree's `pins`, and `systemd-run` runs the command with the credentials and environment file mapped into the root. It
checks the result on disk (every directory's mode, the keys, the manifest, the files' contents) and rolls an upgrade
back for real after the new release has migrated the database. The scripts are shellcheck-clean where shellcheck is
installed (the test skips that step otherwise). Neither is a real VM: before a production install, run it on a
staging VM of the same image with `--dry-run`, then for real (docs/SELF-HOSTING.md, *Operator checklist*).

Downloads without internet access: fetch `node-<v>-linux-x64.tar.xz` and `caddy_<v>_linux_amd64.tar.gz` (versions in
`pins`) and the release zip elsewhere, copy them over, and pass `--node-tarball`, `--caddy-tarball`, `--source` and
`--release-sha256` (from the release notes and the CHANGELOG at the tag, which must agree); each is still checked
against its pinned or given checksum. Every path option must be a plain absolute path (letters, digits, `. _ / -`).

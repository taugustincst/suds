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
| `/opt/suds/<version>`, `/opt/suds/current` → it | root, directories 0755 then read-only | The SUDS release, with `.suds-release-checksum` (how its zip was checked: `operator`, `same-release` or `local-tree`; a run that stops after staging leaves it for the next), `.suds-manifest` (SHA-256 of every file, that one included) and `.suds-staged` (the manifest's hash: the stage completed). Staged in `<version>.partial` first |
| `/opt/suds/node-<v>`, `/opt/suds/node` → it | root, 0755 then read-only | The pinned Node.js |
| `/opt/caddy/<v>`, `/opt/caddy/current` → it | root, 0755 | The pinned Caddy (its version is checked after install) |
| `/var/lib/suds` | suds, 0700 | Database, backups, logs (on the LUKS volume). On a new server the installer runs the first backup and recovery drill (`scripts/dr-drill.js --offsite`, as `suds`) before its compliance check |
| The `suds` account | system, no shell, no home | Created before the shares are checked (as it, both at once: one refusal names each unwritable share with its owner, mode and the `chown`/`chmod` or `setfacl` that fixes it) |
| `/var/lib/suds-compliance` | root:suds, 0750 (reports 0640) | The signed compliance reports: SUDS reads them, only root writes them |
| `/etc/suds/credentials/suds_*` | root, 0600 (directory 0700) | The keys, loaded with `LoadCredential=`; never in an environment |
| `/etc/suds/compliance-signing-key` | root, 0600 | The compliance check's own signing key; never given to `suds.service` |
| `/etc/suds/compliance-signing-key.pub.pem` | root, 0644 | Its public half: SUDS verifies reports with it (`SUDS_COMPLIANCE_PUBLIC_KEY_FILE`); give it to the auditor |
| `/etc/suds/suds.env` | root, 0644 | Non-secret settings (`TRUST_PROXY`, `LOCAL_MODE_ENABLED=false`, `MFA_REQUIRED_ROLES`, `AUDIT_ANCHOR_DIR`, `SUDS_COMPLIANCE_DIR`, `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` from `--domain` unless already set, …). Rewritten on a re-run, keeping an operator's `WEBAUTHN_*`; `upgrade.sh` adds `WEBAUTHN_*` when neither is there. The installer runs its compliance check with these, as `suds-compliance.service` does |
| `/etc/suds/provision.json` | root, 0644 | Database settings applied where unset, and only if they tighten: backups every 4 h to the offsite share, monthly drill, MFA for every role (server/provision.js) |
| `/etc/suds/suds-server.conf` | root, 0644 | Site facts for the compliance check (domain, shares, admin network, `SUDS_CA_FILE`, `SUDS_CONNECT_HOST`, NTP servers, how the release was checked, first install date, accepted risks). Lines the installer does not manage are kept on a re-run |
| `/etc/suds/ca.pem` | root, 0644 | `--ca-file`: the county CA, for the compliance check's TLS test |
| `/etc/systemd/system/suds.service.d/10-site.conf` | root, 0644 | The anchor mount (`RequiresMountsFor`), `ReadWritePaths=<anchors> -<offsite>` (the offsite share optional: its outage never stops SUDS), the metrics credential |
| `/etc/caddy/Caddyfile`, `suds.env`, `suds-tls.caddy` | root, 0644 | The repository's Caddyfile and its site values; TLS 1.2+. Replaced by every upgrade: do not edit it (below) |
| `/etc/caddy/Caddyfile.d/*.caddy` | root, 0644 (directory 0755) | Site-local Caddy configuration, imported at the end of the Caddyfile; never changed by an upgrade. `www-redirect.caddy` with `--www-redirect` |
| `/etc/systemd/journald.conf.d/suds.conf` | root, 0644 | Persistent journal, `MaxRetentionSec`, `SystemMaxUse` (`--journal-max-use`, default 8G) |
| `/etc/systemd/timesyncd.conf.d/suds.conf`, `/etc/chrony/sources.d/suds.sources`, `/etc/chrony.d/suds.conf` | root, 0644 | `--ntp-server`: the county time source (chrony is kept where installed) |

## Site-local Caddy configuration

`/etc/caddy/Caddyfile` is the release's own file: `install.sh` and `upgrade.sh` replace it with the release's copy.
Anything of your own goes in a file **`/etc/caddy/Caddyfile.d/<name>.caddy`** — whole site blocks, such as another
name to redirect — which the Caddyfile imports at its end (`import /etc/caddy/Caddyfile.d/*.caddy`; an empty directory
is not an error in the pinned Caddy) and which neither script ever changes. Restart Caddy after editing one
(`systemctl restart caddy`; `/opt/caddy/current/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
with the variables in `/etc/caddy/suds.env` checks it first).

- **`www.<domain>`**: `install.sh --www-redirect` (with `--tls=caddy`) writes `Caddyfile.d/www-redirect.caddy`, a
  permanent redirect from `www.<domain>` to `https://<domain>`; Caddy obtains the www certificate. A redirect, not a
  second name for the app: passkeys are bound to `<domain>` (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`).
- **Local edits to the Caddyfile itself** are never discarded without a word (from 1.25.3). Before anything is
  stopped or changed, `upgrade.sh` (and a re-run of `install.sh`) compares `/etc/caddy/Caddyfile` with the running
  release's copy. Whole site blocks **appended** after it are moved to `Caddyfile.d/local.caddy` during the switch,
  and your file as it was is kept as `/etc/caddy/Caddyfile.local-<time>` (a rollback puts it back). Any other edit
  stops the run with `REFUSED: /etc/caddy/Caddyfile has local changes …`, SUDS and Caddy untouched: move your
  additions into `Caddyfile.d`, put the release's file back (`cp /opt/suds/<running version>/Caddyfile
  /etc/caddy/Caddyfile`; Caddy keeps serving what it loaded until it restarts) and run it again.

### Before upgrading suds.systems from 1.25.1

The live server's `/etc/caddy/Caddyfile` is 1.25.1's with a `www.suds.systems { redir https://suds.systems{uri}
permanent }` block appended by hand (launch day). `upgrade.sh` 1.25.3 moves an appended block like that one by
itself; to move it by hand first instead (recommended: you see the result before the upgrade), in one sitting:

```bash
sudo install -d -m 0755 /etc/caddy/Caddyfile.d
sudo tee /etc/caddy/Caddyfile.d/www-redirect.caddy >/dev/null <<'EOF'
www.suds.systems {
	import {$SUDS_CADDY_TLS:/dev/null}
	header -Server
	redir https://suds.systems{uri} permanent
}
EOF
sudo cp /etc/caddy/Caddyfile /root/Caddyfile.launch-day                 # keep the edited file
sudo cp /opt/suds/1.25.1/Caddyfile /etc/caddy/Caddyfile                 # the release's own; do NOT restart Caddy now
sudo cmp /opt/suds/1.25.1/Caddyfile /etc/caddy/Caddyfile && echo ready  # the upgrade will find no local edit
```

Do not restart Caddy between these steps and the upgrade: 1.25.1's Caddyfile does not import `Caddyfile.d`, so www
would lose its certificate until the upgrade installs the 1.25.3 one (which imports it) and restarts Caddy. Then
upgrade as usual (docs/SELF-HOSTING.md, *Upgrading*) and check `curl -sI https://www.suds.systems/` answers `301`
with `Location: https://suds.systems/`, and that `https://suds.systems/` answers without a `Via` header. If the upgrade
rolls back, it puts 1.25.1's Caddyfile back and restarts Caddy: put `/root/Caddyfile.launch-day` back too
(`sudo cp /root/Caddyfile.launch-day /etc/caddy/Caddyfile && sudo systemctl restart caddy`).

## Testing it

`test/deploy-linux.test.js` runs `install.sh` and `upgrade.sh` with `--dry-run` against a fake root (`SUDS_INSTALL_ROOT`)
with stub commands on `PATH`, for both distribution families, and checks the plan and every refusal.
`test/deploy-linux-real.test.js` runs them **for real** into a fake root: package managers, `systemctl`, `ufw`,
`firewall-cmd`, `useradd`, `runuser` and `chown` are stubs that record what they were asked (`runuser` can be told
a share is not writable), `install` is the real one with the
ownership recorded and left out, `curl` serves fixture Node.js and Caddy tarballs whose checksums are in the test
tree's `pins`, and `systemd-run` runs the command with the credentials and environment file mapped into the root. It
checks the result on disk (every directory's mode, the keys, the manifest, the files' contents) and rolls an upgrade
back for real after the new release has migrated the database; on day one the installer's first recovery drill
runs for real against a database the `systemctl` stub creates. The scripts are shellcheck-clean where shellcheck is
installed (the test skips that step otherwise). Neither is a real VM: before a production install, run it on a
staging VM of the same image with `--dry-run`, then for real (docs/SELF-HOSTING.md, *Operator checklist*).

Downloads without internet access: fetch `node-<v>-linux-x64.tar.xz` and `caddy_<v>_linux_amd64.tar.gz` (versions in
`pins`) and the release zip elsewhere, copy them over, and pass `--node-tarball`, `--caddy-tarball`, `--source` and
`--release-sha256` (from the GitHub Release notes and the version's CHANGELOG section on `main`, which must agree —
not the tagged commit's own CHANGELOG, which cannot hold the checksum of a zip built from it); each is still checked
against its pinned or given checksum. Every path option must be a plain absolute path (letters, digits, `. _ / -`).

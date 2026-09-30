# Installer run in a systemd container — 2026-09-30 (SUDS 1.20.0)

> **Not a VM run.** As the [1.19.0 run](../installer-container-run-2026-09-30/README.md) before it, this is
> `deploy/linux/install.sh` and `upgrade.sh` run for real, as root, on Ubuntu 24.04 with systemd 255 as PID 1,
> inside a privileged Docker container in a development sandbox. It re-checks, on the released 1.20.0, the four
> findings of the 1.19.0 run that 1.20.0 set out to fix. The limits of the 1.19.0 run apply unchanged (no LUKS
> volume, no SSH, same-disk non-WORM "shares", no NTP, no network during the run, no reboot, **no RHEL 9**): the
> real-VM run on Ubuntu 24.04 and RHEL 9 is still owed ([../INSTALLER-VM-RUN.md](../INSTALLER-VM-RUN.md),
> owner-pending). The folder carries a version suffix because the 1.19.0 run holds `installer-container-run-2026-09-30/`.

## Environment

The 1.19.0 run's, re-used:

* Host: the development sandbox (kernel 6.18.44, cgroup v1, no `/dev/kvm`, no systemd); Docker 29.3.1 started there
  (`dockerd --data-root <scratch>/dockerroot`).
* Image: `suds-vm-ubuntu2404`, built from the 1.19.0 run's
  [environment/Dockerfile](../installer-container-run-2026-09-30/environment/Dockerfile) (Ubuntu 24.04.5,
  `systemd`, `dbus` and the packages the installer asks for, fetched at build time).
* Each container, from the host:

  ```bash
  docker run -d --name <name> --privileged --network none --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock -v <files>:/root/files:ro -v <dir>/offsite:/mnt/suds-offsite \
    -v <dir>/anchors:/mnt/worm/suds-anchors suds-vm-ubuntu2404
  docker exec <name> /root/files/prepare.sh <1.19.0|1.20.0>
  ```

  `<files>` holds the zips, the Node.js and Caddy tarballs (the 1.19.0 run's downloads, checked by the installer
  against `deploy/linux/pins`), a truncated copy of the Caddy tarball (`head -c 1000000`), and the scripts in
  [environment/](environment/). [prepare.sh](environment/prepare.sh) applies `mount --make-rshared /` (the 1.19.0
  run's container artefact: without it systemd's `LoadCredential=` mounts never appear), points `suds.county.test`
  at 127.0.0.1, makes a throwaway CA and a certificate for that name, and unpacks the release.
* Releases: `suds-v1.20.0.zip` = `git archive --format=zip --prefix=suds-v1.20.0/ 8f365b4`, SHA-256
  `048e928499fa3569dfcfc59af86633ad4f8176d3bba1c0dd2fe61b62c35fb9ff` (the value in
  [../RELEASE-HANDOFF.md](../RELEASE-HANDOFF.md) for `v1.20.0`); `suds-v1.19.0.zip` from `3dc20dc`, SHA-256
  `c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed`. Both passed as `--release-sha256`.
* Installer options as in the 1.19.0 run (`--tls=county-cert`, `--ca-file`, `--console-access`,
  `--accept-unencrypted-disk=…`, `--ntp-server=time.county.test`, offline `--source`/`--node-tarball`/`--caddy-tarball`):
  [environment/install-1.20.0.sh](environment/install-1.20.0.sh), [install-1.19.0.sh](environment/install-1.19.0.sh).

## Ubuntu 24.04: fresh install of 1.20.0 — [ubuntu-24.04-install-1.20.0/](ubuntu-24.04-install-1.20.0/)

The shares started **root-owned** and the `suds` user did not exist, as on the 1.19.0 run.

| Transcript | Outcome |
| --- | --- |
| [1-dry-run.txt](ubuntu-24.04-install-1.20.0/1-dry-run.txt) | `install-1.20.0.sh --dry-run`: exit 0. Plans the `useradd` and **warns for both shares** (owner, mode, the user to be made, the `chown`/`chmod` to run); plans "record how its zip was checked (operator) in .suds-release-checksum" and the first backup and drill |
| [2-run-refused-shares.txt](ubuntu-24.04-install-1.20.0/2-run-refused-shares.txt) | Exit 1: "creating the suds service account now, so the shares can be checked as it", then **one refusal naming both shares** (owner, mode, uid/gid 996) with the `chown`, `setfacl` and NFS/SMB remedies. `/opt/suds` and `/etc/suds` do not exist afterwards: **nothing was staged**. Then `chown suds:suds` and `chmod 0700` on both |
| [3-run-stopped-after-staging-bad-caddy-tarball.txt](ubuntu-24.04-install-1.20.0/3-run-stopped-after-staging-bad-caddy-tarball.txt) | `--caddy-tarball=/root/caddy-truncated.tar.gz`, to stop a run **after staging and before the configuration is written** (the condition of the 1.19.0 finding 1, there caused by the share refusals): exit 1, `REFUSED: checksum mismatch for caddy_2.10.2_linux_amd64.tar.gz`. `/opt/suds/1.20.0` is staged, `/etc/suds` does not exist, and `/opt/suds/1.20.0/.suds-release-checksum` says `operator` |
| [4-run-complete.txt](ubuntu-24.04-install-1.20.0/4-run-complete.txt) | The same command with the real tarball: **exit 0**. Keys, config, firewall, services; "SUDS is up … served at https://suds.county.test"; **"First backup and recovery drill": PASSED, 11/11** (the offsite copy it had just made, keys from server memory); compliance check **37 pass, 1 fail, 6 warning, 2 could not check** ([compliance-2026-09-30T21-21-25-089Z.json](ubuntu-24.04-install-1.20.0/compliance-2026-09-30T21-21-25-089Z.json)) |
| [5-day-one.txt](ubuntu-24.04-install-1.20.0/5-day-one.txt) | [after-install.sh](environment/after-install.sh): `https://suds.county.test/api/health` → **HTTP 200 `{"ok":true,…,"database":"ok"}`**; `http://` → 308 to `https://`; HSTS; `suds-server.conf` has `SUDS_RELEASE_CHECKSUM_SOURCE=operator`; `suds.env` has `TRUST_PROXY=1`, `WEBAUTHN_RP_ID=suds.county.test`, `WEBAUTHN_ORIGINS=https://suds.county.test`; the first backup on the offsite share and the signed drill report in `/var/lib/suds/backups`; `guest` signs in over HTTPS (HTTP 200, `must_change_password: true`; the temporary password is not printed) |
| [6-escrow-drill-and-weekly-compliance.txt](ubuntu-24.04-install-1.20.0/6-escrow-drill-and-weekly-compliance.txt) | [escrow-drill.sh](environment/escrow-drill.sh), the operator's step 6: `scripts/dr-drill.js --offsite --keys-file <escrow>` as `suds` with the service's credentials (the 1.19.0 run's `as-suds.sh`) → **PASSED, 11/11, keys from the escrow file**, the offsite copy restored, RTO 0.7 s, RPO 92 s; then `systemctl start suds-compliance` → **38 pass, 1 fail, 5 warning, 2 could not check** ([compliance-2026-09-30T21-22-57-310Z.json](ubuntu-24.04-install-1.20.0/compliance-2026-09-30T21-22-57-310Z.json)) |

The only failure on either report is `host.time_sync` (no network in the container: environment). Not checked:
`host.disk_encryption` (overlay filesystem; the accepted risk) and `host.suds_version` (no release feed). Warnings:
`host.auditd` (recommended), `app.mfa_coverage`, `app.sso`, `app.deprovisioning` (a new server's first
administrator, no identity provider), `app.audit_chain` ("not yet verified": the daily job had not run), and on the
installer's report `host.dr_evidence` (the first drill used the keys on the server; it passes once step 6 has run).

Signatures, checked on the host from this branch:

```bash
E=docs/evidence/installer-container-run-2026-09-30-v1.20.0/ubuntu-24.04-install-1.20.0
npm run verify-dr-report -- $E/dr-drill-2026-09-30T21-21-24-148Z.json --public-key $E/suds-signing-key.pem          # VERIFIED, key id b5bf39840e934b91
npm run verify-dr-report -- $E/dr-drill-2026-09-30T21-22-55-931Z.json --public-key $E/suds-signing-key.pem          # VERIFIED
npm run verify-compliance-report -- $E/compliance-2026-09-30T21-21-25-089Z.json --public-key $E/compliance-signing-key.pub.pem   # VERIFIED, key id aca180994c2dc5c3
npm run verify-compliance-report -- $E/compliance-2026-09-30T21-22-57-310Z.json --public-key $E/compliance-signing-key.pub.pem   # VERIFIED
```

(`suds-signing-key.pem` is the server's evidence key, read on the server as `suds`; `compliance-signing-key.pub.pem`
is `/etc/suds/compliance-signing-key.pub.pem`. No private key is in this folder.)

## Ubuntu 24.04: install 1.19.0, then the documented `upgrade.sh` to 1.20.0 — [ubuntu-24.04-upgrade-1.19.0-to-1.20.0/](ubuntu-24.04-upgrade-1.19.0-to-1.20.0/)

* [1-install-1.19.0.txt](ubuntu-24.04-upgrade-1.19.0-to-1.20.0/1-install-1.19.0.txt): 1.19.0's own `install.sh`
  (the user and the shares' owner set first, as 1.19.0 needed), `--skip-compliance-check`: exit 0.
* [2-upgrade-to-1.20.0.txt](ubuntu-24.04-upgrade-1.19.0-to-1.20.0/2-upgrade-to-1.20.0.txt)
  ([upgrade-to-1.20.0.sh](environment/upgrade-to-1.20.0.sh)): **the installed release's upgrader, as
  docs/SELF-HOSTING.md, *Upgrading*, says**: `/opt/suds/current/deploy/linux/upgrade.sh 1.20.0 --source=… --release-sha256=048e9284…`
  → **exit 0**: staged and checked, SUDS stopped, a pre-upgrade backup, switched, "SUDS 1.20.0 is ready" (migration
  60 ran; `pre-migration/suds.db.v59.….db.enc`); `SUDS_RELEASE_CHECKSUM_SOURCE=operator`; `/api/health` **HTTP 200,
  `ok: true`**, the backup *pending first run (expected on day one)* in `warnings`. Its compliance check: **30 pass,
  3 fail, 11 warning, 2 could not check**: `host.time_sync` (environment), **`app.passkeys`** (`WEBAUTHN_RP_ID is
  not set`) and **`app.https`** ("not configured"). `suds.env` still has no `WEBAUTHN_*` line.
* [3-after-upgrade-weekly-compliance-and-passkey-setting.txt](ubuntu-24.04-upgrade-1.19.0-to-1.20.0/3-after-upgrade-weekly-compliance-and-passkey-setting.txt)
  ([after-upgrade.sh](environment/after-upgrade.sh)): the weekly unit as installed → `app.https` **pass**,
  `app.passkeys` fail, `app.backups` and `app.dr_drill` **warn** (pending first run), `host.release_integrity` pass;
  then the two `WEBAUTHN_*` lines added to `/etc/suds/suds.env` by hand and `systemctl restart suds` → the weekly
  unit: **32 pass, 1 fail** (`host.time_sync`), `app.passkeys` **pass**.

**Why:** the command SELF-HOSTING.md gives runs the *installed* release's `upgrade.sh`, here 1.19.0's. The two
1.20.0 upgrade fixes live in 1.20.0's `upgrade.sh` and `lib.sh` (adding `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` from the
installed domain, and running the compliance check with `/etc/suds/suds.env`), so they take effect only from the
next upgrade after 1.20.0. See *New finding*, below.

## The same upgrade with 1.20.0's own upgrader — [ubuntu-24.04-upgrade-1.19.0-to-1.20.0-with-its-own-upgrader/](ubuntu-24.04-upgrade-1.19.0-to-1.20.0-with-its-own-upgrader/)

A third container: 1.19.0 installed the same way, then
`/root/suds-v1.20.0/deploy/linux/upgrade.sh 1.20.0 --source=/root/suds-v1.20.0.zip --release-sha256=048e9284…`
from the unpacked 1.20.0 zip ([upgrade-to-1.20.0-with-new-upgrader.sh](environment/upgrade-to-1.20.0-with-new-upgrader.sh)):
**exit 0**, "passkeys: WEBAUTHN_RP_ID=suds.county.test set in /etc/suds/suds.env", "SUDS 1.20.0 is ready", compliance
**32 pass, 1 fail** (`host.time_sync`), `app.passkeys` and `app.https` **pass**
([compliance-2026-09-30T21-26-45-639Z.json](ubuntu-24.04-upgrade-1.19.0-to-1.20.0-with-its-own-upgrader/compliance-2026-09-30T21-26-45-639Z.json)).
All four compliance reports of the two upgrade containers verify with their folder's `compliance-signing-key.pub.pem`
(key ids `9a492f86d70163af` and `95575ea7ab7fd7d2`).

## The four 1.19.0 findings, on 1.20.0

| # | 1.19.0 finding | 1.20.0 | Where this run shows it |
| --- | --- | --- | --- |
| 1 | A first run that stops after staging loses the release-checksum record (`SUDS_RELEASE_CHECKSUM_SOURCE=` empty; `host.release_integrity` could not check) | **Fixed** | Install run 3 stopped after staging with `.suds-release-checksum` = `operator` and no configuration; run 4 wrote `SUDS_RELEASE_CHECKSUM_SOURCE=operator` and `host.release_integrity` **passed** (runs 4 and 6, and both upgrades) |
| 2 | The share refusals come one at a time, and the `suds` user exists only after a first run | **Fixed** | Install run 1 (dry-run) warns for both; run 2 creates `suds` first and refuses once, naming both shares with their remedies, with nothing staged; one fix, one more run |
| 3 | Day one reads red: `app.backups` and `app.dr_drill` fail, `/api/health` 503 until the first scheduled backup; `app.https` fails on the installer's report | **Fixed** on a new install; on an upgrade, **fixed except the upgrade report's `app.https`** (below) | New install: the installer's first backup and drill (run 4), `app.backups`, `app.dr_drill` and `app.https` **pass** on its own report, `/api/health` **200 `ok: true`** (run 5). Upgraded 1.19.0 server: `/api/health` 200 `ok: true` with the backup *pending first run*, `app.backups`/`app.dr_drill` **warn** (not fail); `app.https` fails on the report the 1.19.0 upgrader runs and passes on the weekly one |
| 4 | `app.passkeys` fails on every new install and upgrade until the operator sets `WEBAUTHN_RP_ID` | **Fixed** on a new install and with 1.20.0's own upgrader; **not** by the documented 1.19.0 → 1.20.0 upgrade | Run 5: `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` in `suds.env`, `app.passkeys` pass. Documented upgrade: not added, `app.passkeys` fails until set by hand (SELF-HOSTING.md step 5). 1.20.0's upgrader: added, pass |

## New finding for the owner (no change made here)

**The documented upgrade from 1.19.0 does not bring 1.20.0's upgrade fixes.** SELF-HOSTING.md, *Upgrading*, runs
`/opt/suds/current/deploy/linux/upgrade.sh`, the installed release's script. Upgrading a 1.19.0 server that way to
1.20.0 leaves `WEBAUTHN_RP_ID` unset (`app.passkeys` fails: nobody can add a passkey) and its compliance report
fails `app.https`, although SELF-HOSTING.md step 5 and the 1.20.0 CHANGELOG say "`upgrade.sh` adds both to a server
installed before that". Both are fixed by running 1.20.0's own `upgrade.sh` from the unpacked zip (shown above) or by
adding the two lines by hand and restarting SUDS; a later upgrade from 1.20.0 onwards has the fix either way. Worth,
in a release: the upgrade section saying to add the two lines (or to run the new release's `upgrade.sh`) when
upgrading from 1.19.x or earlier, or the installed upgrader handing over to the staged release's `upgrade.sh` after
staging it.

## What this run could not exercise

The same as the 1.19.0 run: a LUKS data volume; SSH and the admin-network lock-out check; a real offsite host and a
WORM share; a working NTP source; package installation from the distribution's mirrors during the run; ACME
(`--tls=caddy`); a reboot; cloud security groups; RHEL 9 entirely (the sandbox's egress policy still denies the
RHEL-family mirrors, so it was not retried). The rollback path of `upgrade.sh` was not exercised here
(`test/deploy-linux-real.test.js` rolls one back for real in a fake root).

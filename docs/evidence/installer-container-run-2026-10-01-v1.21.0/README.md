# Installer run in a systemd container — 2026-10-01 (SUDS 1.21.0)

> **Not a VM run.** As the [1.20.0 run](../installer-container-run-2026-09-30-v1.20.0/README.md) and the
> [1.19.0 run](../installer-container-run-2026-09-30/README.md) before it, this is `deploy/linux/install.sh` and
> `upgrade.sh` run for real, as root, on Ubuntu 24.04 with systemd 255 as PID 1, inside a privileged Docker container in
> a development sandbox. It repeats the 1.20.0 run on the released 1.21.0, and checks what 1.21.0 changed in the
> upgrade: the documented command is now the new release's own `upgrade.sh`, the installed one hands over to it from
> 1.21.0 on, and SUDS names the missing `WEBAUTHN_RP_ID` at every start. The limits of the earlier runs apply unchanged
> (no LUKS volume, no SSH, same-disk non-WORM "shares", no NTP, no network during the run, no reboot, **no RHEL 9**):
> the real-VM run on Ubuntu 24.04 and RHEL 9 is still owed ([../INSTALLER-VM-RUN.md](../INSTALLER-VM-RUN.md),
> owner-pending).

## Environment

The 1.20.0 run's, re-used:

* Host: the development sandbox (kernel 6.18.44, cgroup v1, no `/dev/kvm`, no systemd); Docker 29.3.1 started there
  (`dockerd --data-root <scratch>/dockerroot`).
* Image: `suds-vm-ubuntu2404`, built from the 1.19.0 run's
  [environment/Dockerfile](../installer-container-run-2026-09-30/environment/Dockerfile) (Ubuntu 24.04.5, `systemd`,
  `dbus` and the packages the installer asks for, fetched at build time).
* Each container, from the host, one at a time: [environment/start.sh](environment/start.sh) `<name> <dir> <release>`
  (the 1.20.0 run's `docker run` line: `--privileged --network none --cgroupns=host`, `/sys/fs/cgroup` and the two
  "shares" mounted, the files below read-only at `/root/files`), which then runs
  [prepare.sh](environment/prepare.sh) (`mount --make-rshared /`, `suds.county.test` → 127.0.0.1, a throwaway CA and a
  certificate for that name, the release unpacked).
* Releases: `suds-v1.21.0.zip` = `git archive --format=zip --prefix=suds-v1.21.0/ 348e18c` (the v1.21.0 commit,
  "SBOM of the 1.21.0 stamp"), SHA-256 `b69f629f2cc9587c1f32b021de8a86cd24484aa0b34b8cafc331d5f4485f2207`, the command
  [../RELEASE-HANDOFF.md](../RELEASE-HANDOFF.md) gives for `v1.21.0` (whose row records the value in a later commit);
  `suds-v1.20.0.zip` from `8f365b4`, SHA-256 `048e928499fa3569dfcfc59af86633ad4f8176d3bba1c0dd2fe61b62c35fb9ff` (the
  hand-off's value); `suds-v1.19.0.zip` from `3dc20dc`, SHA-256
  `c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed`. Each passed as `--release-sha256`. Node.js
  v22.23.3 and Caddy 2.10.2 tarballs: the earlier runs' downloads, checked by the installer against
  `deploy/linux/pins` (unchanged in 1.21.0).
* Installer options as before (`--tls=county-cert`, `--ca-file`, `--console-access`, `--accept-unencrypted-disk=…`,
  `--ntp-server=time.county.test`, offline `--source`/`--node-tarball`/`--caddy-tarball`):
  [install-1.21.0.sh](environment/install-1.21.0.sh), [install-1.20.0.sh](environment/install-1.20.0.sh),
  [install-1.19.0.sh](environment/install-1.19.0.sh). The upgrades: [upgrade-to-1.21.0.sh](environment/upgrade-to-1.21.0.sh)
  `new` (1.21.0's own `upgrade.sh` from the unpacked zip) or `installed` (`/opt/suds/current/deploy/linux/upgrade.sh`).

## Ubuntu 24.04: fresh install of 1.21.0 — [ubuntu-24.04-install-1.21.0/](ubuntu-24.04-install-1.21.0/)

The 1.20.0 run's six steps, unchanged. The shares started **root-owned** and the `suds` user did not exist.

| Transcript | Outcome |
| --- | --- |
| [1-dry-run.txt](ubuntu-24.04-install-1.21.0/1-dry-run.txt) | `--dry-run`: exit 0. Plans the `useradd`, **warns for both shares**, plans "record how its zip was checked (operator)" and the first backup and drill |
| [2-run-refused-shares.txt](ubuntu-24.04-install-1.21.0/2-run-refused-shares.txt) | Exit 1: the `suds` account created first, then **one refusal naming both shares** (owner, mode, uid/gid 996) with the remedies; `/opt/suds` and `/etc/suds` do not exist afterwards. Then `chown suds:suds` and `chmod 0700` on both |
| [3-run-stopped-after-staging-bad-caddy-tarball.txt](ubuntu-24.04-install-1.21.0/3-run-stopped-after-staging-bad-caddy-tarball.txt) | A truncated Caddy tarball: exit 1, `REFUSED: checksum mismatch for caddy_2.10.2_linux_amd64.tar.gz`; `/opt/suds/1.21.0` staged with `.suds-release-checksum` = `operator`, no `/etc/suds` |
| [4-run-complete.txt](ubuntu-24.04-install-1.21.0/4-run-complete.txt) | **Exit 0**: "SUDS is up … served at https://suds.county.test"; **first backup and recovery drill PASSED, 11/11** (schema 63, 76 tables; the offsite copy it had just made; keys from server memory; RTO 0.4 s); compliance **38 pass, 1 fail, 6 warning, 2 could not check** of 47 checks ([compliance-2026-10-01T00-48-12-905Z.json](ubuntu-24.04-install-1.21.0/compliance-2026-10-01T00-48-12-905Z.json)) |
| [5-day-one.txt](ubuntu-24.04-install-1.21.0/5-day-one.txt) | `/api/health` → **HTTP 200 `{"ok":true,…,"database":"ok"}`**; `http://` → 308 to `https://`; HSTS; `SUDS_RELEASE_CHECKSUM_SOURCE=operator`; `suds.env` has `TRUST_PROXY=1`, `WEBAUTHN_RP_ID=suds.county.test`, `WEBAUTHN_ORIGINS=https://suds.county.test`; the first backup on the offsite share, the signed drill report in `/var/lib/suds/backups`; `guest` signs in over HTTPS (HTTP 200, `must_change_password: true`; the password is not printed) |
| [6-escrow-drill-and-weekly-compliance.txt](ubuntu-24.04-install-1.21.0/6-escrow-drill-and-weekly-compliance.txt) | The operator's step 6: `scripts/dr-drill.js --offsite --keys-file <escrow>` as `suds` → **PASSED, 11/11, keys from the escrow file**, RTO 0.3 s, RPO 29 s; then the weekly unit → **39 pass, 1 fail, 5 warning, 2 could not check** ([compliance-2026-10-01T00-48-41-801Z.json](ubuntu-24.04-install-1.21.0/compliance-2026-10-01T00-48-41-801Z.json)) |
| [6b-public-key.txt](ubuntu-24.04-install-1.21.0/6b-public-key.txt) | The server's evidence public key, read as `suds`. `escrow-drill.sh`'s last step, which reads it, fails as it did in the 1.20.0 run (the unit wants the escrow file the script has just shredded, and `suds` cannot read `/root/files`): a fault of this harness, not of SUDS. Read again from a world-readable copy of `pubkey.js` with an empty escrow file |

The only failure on any report of this install is `host.time_sync` (no network in the container). Not checked:
`host.disk_encryption` (overlay; the accepted risk), `host.suds_version` (no release feed). Warnings: `host.auditd`,
`app.mfa_coverage`, `app.sso`, `app.deprovisioning`, `app.audit_chain` (the daily verification had not run), and on the
installer's report `host.dr_evidence` (passes once step 6 has run). Against 1.20.0 (37 pass of 46), the one new check,
`app.authenticator_allowlist` (migration 63's allow-list), **passes** (off, as by default).

## Ubuntu 24.04: install 1.20.0, then the documented upgrade — [ubuntu-24.04-upgrade-1.20.0-to-1.21.0-with-its-own-upgrader/](ubuntu-24.04-upgrade-1.20.0-to-1.21.0-with-its-own-upgrader/)

1.20.0's own `install.sh` (exit 0, with its first backup and drill), then **the command docs/SELF-HOSTING.md, *Upgrading*,
gives from 1.21.0**: `/root/suds-v1.21.0/deploy/linux/upgrade.sh 1.21.0 --source=/root/suds-v1.21.0.zip
--release-sha256=b69f629f…` from the unpacked zip ([2-upgrade-to-1.21.0-with-1.21.0-upgrader.txt](ubuntu-24.04-upgrade-1.20.0-to-1.21.0-with-its-own-upgrader/2-upgrade-to-1.21.0-with-1.21.0-upgrader.txt)):
**exit 0**; staged and checked, SUDS stopped, a pre-upgrade backup, switched, "passkeys: WEBAUTHN_RP_ID/WEBAUTHN_ORIGINS
in /etc/suds/suds.env kept as set", "SUDS 1.21.0 is ready" (migrations 61–63 ran; `pre-migration/suds.db.v60.….db.enc`);
`SUDS_RELEASE_CHECKSUM_SOURCE=operator`; `/api/health` **HTTP 200 `ok: true`**; no `WEBAUTHN_RP_ID` warning at start.
Its compliance report: **38 pass, 1 fail** (`host.time_sync`), 6 warning, 2 could not check; `app.passkeys`, `app.https`,
`app.backups`, `app.dr_drill`, `host.release_integrity` **pass**. The weekly unit afterwards: the same
([3-after-upgrade-weekly-compliance.txt](ubuntu-24.04-upgrade-1.20.0-to-1.21.0-with-its-own-upgrader/3-after-upgrade-weekly-compliance.txt)).
No hand-over: the upgrader running is already 1.21.0's.

## The same upgrade with the installed 1.20.0 upgrader — [ubuntu-24.04-upgrade-1.20.0-to-1.21.0-with-the-installed-1.20.0-upgrader/](ubuntu-24.04-upgrade-1.20.0-to-1.21.0-with-the-installed-1.20.0-upgrader/)

What an operator who keeps the old habit gets: `/opt/suds/current/deploy/linux/upgrade.sh 1.21.0 …`, i.e. 1.20.0's
script ([2-upgrade-to-1.21.0-with-installed-1.20.0-upgrader.txt](ubuntu-24.04-upgrade-1.20.0-to-1.21.0-with-the-installed-1.20.0-upgrader/2-upgrade-to-1.21.0-with-installed-1.20.0-upgrader.txt)):
**exit 0**, the same steps and the same outcome as above (1.20.0's `upgrade.sh` already adds or keeps the
`WEBAUTHN_*` lines and runs the compliance check with `suds.env`): **38 pass, 1 fail** (`host.time_sync`),
`app.passkeys` and `app.https` pass, no warning at start. 1.20.0's script cannot hand over (that arrived in 1.21.0), and
nothing in 1.21.0's upgrade needed it to: `deploy/linux/upgrade.sh` differs between the two releases only by the
hand-over block, and `lib.sh` not at all. **From 1.20.0, either command gives the same result.**

## Install 1.19.0, then the installed 1.19.0 upgrader straight to 1.21.0 — [ubuntu-24.04-upgrade-1.19.0-to-1.21.0-with-the-installed-1.19.0-upgrader/](ubuntu-24.04-upgrade-1.19.0-to-1.21.0-with-the-installed-1.19.0-upgrader/)

The case 1.21.0's startup message is for: a server installed with 1.19.0 (no `WEBAUTHN_*` lines) upgraded with the
upgrade.sh installed with it, which neither adds them nor hands over.

* [2-upgrade-to-1.21.0-with-installed-1.19.0-upgrader.txt](ubuntu-24.04-upgrade-1.19.0-to-1.21.0-with-the-installed-1.19.0-upgrader/2-upgrade-to-1.21.0-with-installed-1.19.0-upgrader.txt):
  **exit 0**, migrations 60–63 (`pre-migration/suds.db.v59.….db.enc`), `/api/health` **200 `ok: true`** (the backup
  *pending first run*: 1.19.0's installer made none). `suds.env` still has no `WEBAUTHN_*` line, and **SUDS 1.21.0 says
  so at start**, in the journal:

  ```
  [suds] WARNING: WEBAUTHN_RP_ID is not set, so no one can add or use a passkey (fingerprint sign-in) on this server. Add these two lines to /etc/suds/suds.env and run: systemctl restart suds
    WEBAUTHN_RP_ID=suds.county.test
    WEBAUTHN_ORIGINS=https://suds.county.test
  (an upgrade run with the upgrade.sh of SUDS 1.19.0 or older does not add them; docs/SELF-HOSTING.md, "Upgrading").
  ```

  The compliance report 1.19.0's upgrader runs: **31 pass, 3 fail** (`host.time_sync`; **`app.passkeys`**, whose
  evidence carries the same two lines with the installed domain; **`app.https`** "not configured", because 1.19.0's
  upgrader runs the check without `suds.env`), 11 warning (day-one *pending first run* and the like), 2 could not check.
* [3-after-upgrade-weekly-compliance-and-passkey-setting.txt](ubuntu-24.04-upgrade-1.19.0-to-1.21.0-with-the-installed-1.19.0-upgrader/3-after-upgrade-weekly-compliance-and-passkey-setting.txt):
  the weekly unit → `app.https` **pass**, `app.passkeys` fail (32 pass, 2 fail); the two lines SUDS printed added to
  `/etc/suds/suds.env`, `systemctl restart suds` → no warning at that start, and the weekly unit: **33 pass, 1 fail**
  (`host.time_sync`), `app.passkeys` **pass**.

So the 1.20.0 run's finding is closed as 1.21.0 intended: the documented command (the new release's `upgrade.sh`) adds
the lines; an operator who runs an older installed upgrader is told, at every start and in the compliance report, the
exact two lines to add.

## The hand-over — [ubuntu-24.04-handover-probe/](ubuntu-24.04-handover-probe/)

1.21.0's installed `upgrade.sh` hands over to the staged release's own `upgrade.sh` when that differs. That needs a
release after 1.21.0, which does not exist yet; **a 1.21.0 → 1.21.0 re-run cannot show it**: `upgrade.sh` stops first
with `REFUSED: SUDS 1.21.0 is already the running version` ([3-…](ubuntu-24.04-handover-probe/3-handover-probe-1.21.0-to-1.21.99.txt),
first lines). So, in a fifth container with 1.21.0 freshly installed, it was exercised with a **probe build that is not a
release**: the 1.21.0 tree with `package.json` at `1.21.99` and one comment line appended to `deploy/linux/upgrade.sh`
(so the staged script differs from the installed one), zipped as `suds-v1.21.99.zip` (SHA-256
`74cee4516cf255f150ff4ba7d754ed7893703b276265a2c054d53d84790e338e`) and passed with `--release-sha256` like a release
([handover-probe.sh](environment/handover-probe.sh)). It existed only in that throwaway container.

* The real run: **exit 0**. After staging and checking the zip, "SUDS 1.21.99 has its own upgrade.sh: handing over to it
  (/opt/suds/1.21.99/deploy/linux/upgrade.sh)"; the staged script starts again from step 1, finds the stage complete
  ("already at /opt/suds/1.21.99 (complete; every file matches its manifest)") and goes on: stop, pre-upgrade backup,
  switch, "SUDS 1.21.99 is ready", its compliance check; `/opt/suds/current` → `1.21.99`, whose `upgrade.sh` ends with
  the probe's comment line; `/api/health` **200**. Nothing was stopped before the hand-over.
* The dry run of the same upgrade does **not** show the hand-over (finding 2 below):
  [4-dry-run-from-a-zip-does-not-show-the-hand-over.txt](ubuntu-24.04-handover-probe/4-dry-run-from-a-zip-does-not-show-the-hand-over.txt)
  (a second probe build, `1.21.100`, so that there was something to upgrade to).

The hand-over on a real next release (1.22.0 from 1.21.0) is still to be recorded when it ships.

## Signatures

Checked on the host from this branch:

```bash
E=docs/evidence/installer-container-run-2026-10-01-v1.21.0/ubuntu-24.04-install-1.21.0
npm run verify-dr-report -- $E/dr-drill-2026-10-01T00-48-12-168Z.json --public-key $E/suds-signing-key.pem          # VERIFIED, key id 6b3246f72a30ce4e
npm run verify-dr-report -- $E/dr-drill-2026-10-01T00-48-41-155Z.json --public-key $E/suds-signing-key.pem          # VERIFIED
npm run verify-compliance-report -- $E/compliance-2026-10-01T00-48-12-905Z.json --public-key $E/compliance-signing-key.pub.pem   # VERIFIED, key id 31f3c4e20a573593
npm run verify-compliance-report -- $E/compliance-2026-10-01T00-48-41-801Z.json --public-key $E/compliance-signing-key.pub.pem   # VERIFIED
```

The seven compliance reports of the three upgrade containers verify with their folder's `compliance-signing-key.pub.pem`
(key ids `f8966a7f450ce246`, `8d48a86761ee0c82`, `66553f019d0a3fbe`). No private key is in this folder; the first
administrator's temporary password is in no transcript.

## Findings

Recorded, not fixed here (no code was changed by this run).

1. **Product defect: `os.networkInterfaces()` fails inside the installed `suds.service`, and three things break with
   it.** `deploy/linux/suds.service` has `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, without `AF_NETLINK`
   (`caddy.service` and `suds-compliance.service` both list it). Node's `os.networkInterfaces()` (libuv
   `uv_interface_addresses`, glibc `getifaddrs`) opens a netlink socket, which that unit refuses, so it throws
   `ERR_SYSTEM_ERROR … uv_interface_addresses returned Unknown system error 97` (EAFNOSUPPORT). This is the unit's
   sandbox, not the container: the same call in a unit with the same `RestrictAddressFamilies` fails, and without it
   succeeds ([2-finding-listener-probe.txt](ubuntu-24.04-handover-probe/2-finding-listener-probe.txt), on the fresh
   1.21.0 install; [4-finding-listener-probe.txt](ubuntu-24.04-upgrade-1.19.0-to-1.21.0-with-the-installed-1.19.0-upgrader/4-finding-listener-probe.txt),
   on the upgraded server, where 1.19.0's start shows the same). `server/listener.js` `describe()` calls
   `lanAddresses()` unconditionally (its return value's `lan:` field), so on every installer-provisioned server:
   * at every start, `listener.start()` rejects after the port is bound: the journal shows `[suds] unhandled rejection:
     SystemError [ERR_SYSTEM_ERROR] … at lanAddresses (server/listener.js:18) … at describe (server/listener.js:48) …
     at Object.start (server/listener.js:67)` instead of `SUD Navigator Services Tracker listening on …`; SUDS keeps
     serving (`server/index.js` logs unhandled rejections and does not await `start()`), but the rest of `start()` is
     skipped, including the production "TLS not configured" warning and `server._handler = handler`, which
     `relisten()` (the setup wizard's switch of listener) relies on;
   * `GET /api/setup/status` with a signed-in session and `GET /api/app/info` with a signed-in session (or
     `PUBLIC_APP_INFO=1`) answer **HTTP 500** (both call `listener.describe()`). The app's start-up check of
     `/api/setup/status` catches the error and carries on, and `public/get-app.js` treats a non-OK `/api/app/info` as no
     information, so staff see no error; what is lost is everything that page fills in from the server for a
     signed-in browser (the programme's name, its address, the offline-copy note and the certificate fingerprint: it
     returns early on the failed fetch), and each such request is a 500.

   The installer runs of 1.19.0 and 1.20.0 had the same unit and the same journal lines; they were not looked for. Not
   seen by `test/deploy-linux-real.test.js` (stub system commands, no systemd sandbox) or by the API tests (no
   `RestrictAddressFamilies`). Two independent remedies for the owner to choose between: add `AF_NETLINK` to the
   unit's `RestrictAddressFamilies` (as the other two units have), and/or make `lanAddresses()` return `[]` when
   `os.networkInterfaces()` throws.
2. **Minor: `upgrade.sh --dry-run` from a zip does not show the hand-over.** In a dry run `stage_release` (lib.sh)
   only prints the `unzip`, so `STAGED_TREE` names a directory that does not exist, the hand-over test
   (`-f "$staged_upgrader"`) is false, and the dry run prints the *installed* upgrader's plan with no
   `+ hand over to SUDS <version>'s own upgrade.sh …` line, although the real run hands over. Harmless to the upgrade
   itself (the real run is right), but the preview is not what will run. Seen with the probe builds
   ([4-dry-run-from-a-zip-does-not-show-the-hand-over.txt](ubuntu-24.04-handover-probe/4-dry-run-from-a-zip-does-not-show-the-hand-over.txt)).
3. **Not a defect, noted:** the staging line says "suds-v1.21.0.zip: sha256 matches the pinned checksum" for the
   checksum the operator passed with `--release-sha256`, which is not pinned anywhere; the record written beside it
   (`operator`) is right. Wording only.

## What this run could not exercise

The same as the earlier runs: a LUKS data volume; SSH and the admin-network lock-out check; a real offsite host and a
WORM share; a working NTP source; package installation from the distribution's mirrors during the run; ACME
(`--tls=caddy`); a reboot; cloud security groups; RHEL 9 entirely. The rollback path of `upgrade.sh` was not exercised
here (`test/deploy-linux-real.test.js` rolls one back for real in a fake root). The hand-over to a real later release.

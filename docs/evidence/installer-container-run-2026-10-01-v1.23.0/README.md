# Installer run in a systemd container — 2026-10-01 (SUDS 1.23.0)

> **Not a VM run.** As the [1.21.0 run](../installer-container-run-2026-10-01-v1.21.0/README.md) and the runs before
> it, this is `deploy/linux/install.sh` and `upgrade.sh` run for real, as root, on Ubuntu 24.04 with systemd 255 as PID 1,
> inside a privileged Docker container in a development sandbox. It repeats the 1.21.0 run's fresh install on the
> released 1.23.0, checks the 1.21.0 run's findings (all three fixed in 1.22.0), and records the upgrade 1.22.0 → 1.23.0
> with the upgrader installed with 1.22.0, the first upgrade where both the installed and the new release have the
> hand-over. The limits of the earlier runs apply unchanged (no LUKS volume, no SSH, same-disk non-WORM "shares", no
> NTP, no network during the run, no reboot, **no RHEL 9**): the real-VM run on Ubuntu 24.04 and RHEL 9 is still owed
> ([../INSTALLER-VM-RUN.md](../INSTALLER-VM-RUN.md), owner-pending).

## Environment

The 1.21.0 run's, re-used:

* Host: the development sandbox (kernel 6.18.44, cgroup v1, no `/dev/kvm`, no systemd); Docker 29.3.1 started there
  (`dockerd --data-root <scratch>/dockerroot`).
* Image: `suds-vm-ubuntu2404`, built from the 1.19.0 run's
  [environment/Dockerfile](../installer-container-run-2026-09-30/environment/Dockerfile) (Ubuntu 24.04.5, `systemd`,
  `dbus` and the packages the installer asks for, fetched at build time).
* Each container, from the host, one at a time: [environment/start.sh](environment/start.sh) `<name> <dir> <release>`,
  which then runs [prepare.sh](environment/prepare.sh) (`mount --make-rshared /`, `suds.county.test` → 127.0.0.1, a
  throwaway CA and a certificate for that name, the release unpacked).
* Releases: `suds-v1.23.0.zip` = `git archive --format=zip --prefix=suds-v1.23.0/ 9877d07` (the v1.23.0 commit, "SBOM
  of the 1.23.0 stamp"), SHA-256 `aa785678b0fe28967732fdf4826c5a89a25337c7fcae03512ca7105e45795a81`, and
  `suds-v1.22.0.zip` from `8b136df` (the v1.22.0 commit), SHA-256
  `0798dc42106c95139ff4ed7f72fb3d6b95f32b8ce9cb197e6f01a1970168f1c3`: both the values
  [../RELEASE-HANDOFF.md](../RELEASE-HANDOFF.md) records, rebuilt here byte for byte. Each passed as
  `--release-sha256`. Node.js v22.23.3 and Caddy 2.10.2 tarballs: the earlier runs' downloads, checked by the installer
  against `deploy/linux/pins` (unchanged since 1.21.0).
* Installer options as before (`--tls=county-cert`, `--ca-file`, `--console-access`, `--accept-unencrypted-disk=…`,
  `--ntp-server=time.county.test`, offline `--source`/`--node-tarball`/`--caddy-tarball`):
  [install-1.23.0.sh](environment/install-1.23.0.sh), [install-1.22.0.sh](environment/install-1.22.0.sh). The upgrade:
  [upgrade-to-1.23.0.sh](environment/upgrade-to-1.23.0.sh) `installed` (`/opt/suds/current/deploy/linux/upgrade.sh`,
  i.e. 1.22.0's), with its dry run first. The listener check: [probe-listener.sh](environment/probe-listener.sh). The
  hand-over: [handover-probe.sh](environment/handover-probe.sh).

## Ubuntu 24.04: fresh install of 1.23.0 — [ubuntu-24.04-install-1.23.0/](ubuntu-24.04-install-1.23.0/)

The 1.21.0 run's six steps, unchanged, and a listener check. The shares started **root-owned** and the `suds` user did
not exist.

| Transcript | Outcome |
| --- | --- |
| [1-dry-run.txt](ubuntu-24.04-install-1.23.0/1-dry-run.txt) | `--dry-run`: exit 0. Plans the `useradd`, **warns for both shares**, plans the first backup and drill and the compliance check |
| [2-run-refused-shares.txt](ubuntu-24.04-install-1.23.0/2-run-refused-shares.txt) | Exit 1: the `suds` account created first, then **one refusal naming both shares** with the remedies; `/opt/suds` and `/etc/suds` do not exist afterwards. Then `chown suds:suds` and `chmod 0700` on both |
| [3-run-stopped-after-staging-bad-caddy-tarball.txt](ubuntu-24.04-install-1.23.0/3-run-stopped-after-staging-bad-caddy-tarball.txt) | A truncated Caddy tarball: exit 1, `REFUSED: checksum mismatch for caddy_2.10.2_linux_amd64.tar.gz`; `/opt/suds/1.23.0` staged with `.suds-release-checksum` = `operator`, no `/etc/suds`. The staging line now reads **"suds-v1.23.0.zip: sha256 matches the checksum given with --release-sha256"** (the 1.21.0 run's finding 3, fixed in 1.22.0) |
| [4-run-complete.txt](ubuntu-24.04-install-1.23.0/4-run-complete.txt) | **Exit 0**: "SUDS is up … served at https://suds.county.test"; **first backup and recovery drill PASSED, 11/11** (schema 67, 79 tables; the offsite copy it had just made; keys from server memory; RTO 0.4 s); compliance **38 pass, 1 fail, 6 warning, 2 could not check** of 47 checks ([compliance-2026-10-01T05-00-50-403Z.json](ubuntu-24.04-install-1.23.0/compliance-2026-10-01T05-00-50-403Z.json)) |
| [5-day-one.txt](ubuntu-24.04-install-1.23.0/5-day-one.txt) | `/api/health` → **HTTP 200 `{"ok":true,…,"database":"ok"}`**; `http://` → 308 to `https://`; HSTS; `SUDS_RELEASE_CHECKSUM_SOURCE=operator`; `suds.env` has `TRUST_PROXY=1`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`; the first backup on the offsite share, the signed drill report in `/var/lib/suds/backups`; `guest` signs in over HTTPS (HTTP 200, `must_change_password: true`; the password is not printed) |
| [5b-listener-fix-verified.txt](ubuntu-24.04-install-1.23.0/5b-listener-fix-verified.txt) | **The 1.21.0 run's finding 1, fixed.** The unit still has `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` and `os.networkInterfaces()` still fails under it (`ERR_SYSTEM_ERROR … Unknown system error 97`; unrestricted: `lo`), but the journal now shows **`[suds] SUD Navigator Services Tracker listening on http://localhost:8080 (production)`** and **0 unhandled rejections** since the start; signed in as `guest`, **`GET /api/setup/status` → HTTP 200** and **`GET /api/app/info` → HTTP 200**, each describing the listener with `"lan":[]` |
| [6-escrow-drill-and-weekly-compliance.txt](ubuntu-24.04-install-1.23.0/6-escrow-drill-and-weekly-compliance.txt) | The operator's step 6: `scripts/dr-drill.js --offsite --keys-file <escrow>` as `suds` → **PASSED, 12/12, keys from the escrow file**, RTO 0.4 s, RPO 33 s; then the weekly unit → **39 pass, 1 fail, 5 warning, 2 could not check** ([compliance-2026-10-01T05-01-23-772Z.json](ubuntu-24.04-install-1.23.0/compliance-2026-10-01T05-01-23-772Z.json)) |
| [6b-public-key.txt](ubuntu-24.04-install-1.23.0/6b-public-key.txt) | The server's evidence public key, read as `suds`, as in the 1.21.0 run (`escrow-drill.sh`'s own last step cannot read it: a fault of this harness, not of SUDS) |

The only failure on any report of this install is `host.time_sync` (no network in the container). Not checked:
`host.disk_encryption` (overlay; the accepted risk), `host.suds_version` (no release feed). Warnings: `host.auditd`,
`app.mfa_coverage`, `app.sso`, `app.deprovisioning`, `app.audit_chain` (the daily verification had not run), and on the
installer's report `host.dr_evidence` (passes once step 6 has run). The same 47 checks and the same results as on
1.21.0: 1.22.0 and 1.23.0 added no compliance check.

## Ubuntu 24.04: install 1.22.0, then upgrade with the installed 1.22.0 upgrader — [ubuntu-24.04-upgrade-1.22.0-to-1.23.0-with-the-installed-1.22.0-upgrader/](ubuntu-24.04-upgrade-1.22.0-to-1.23.0-with-the-installed-1.22.0-upgrader/)

* [1-install-1.22.0.txt](ubuntu-24.04-upgrade-1.22.0-to-1.23.0-with-the-installed-1.22.0-upgrader/1-install-1.22.0.txt):
  1.22.0's own `install.sh`, **exit 0**, its first backup and recovery drill PASSED, 11/11.
  [1b-listener-on-1.22.0.txt](ubuntu-24.04-upgrade-1.22.0-to-1.23.0-with-the-installed-1.22.0-upgrader/1b-listener-on-1.22.0.txt):
  the listener fix already in 1.22.0 (the "listening on" line, no unhandled rejection, both routes 200).
* [2-upgrade-to-1.23.0-with-installed-1.22.0-upgrader.txt](ubuntu-24.04-upgrade-1.22.0-to-1.23.0-with-the-installed-1.22.0-upgrader/2-upgrade-to-1.23.0-with-installed-1.22.0-upgrader.txt):
  * The **dry run** now says what the real run may do (the 1.21.0 run's finding 2, fixed in 1.22.0): `+ if SUDS 1.23.0's
    own upgrade.sh or lib.sh differs from this one, hand over to it (/opt/suds/1.23.0/deploy/linux/upgrade.sh) with the
    same arguments: the steps below are then that upgrader's`.
  * `cmp` of the installed and the new `deploy/linux/upgrade.sh` and `lib.sh`: **both identical**. 1.23.0 changed
    nothing under `deploy/linux/` (`git diff --stat 8b136df 9877d07 -- deploy/linux` is empty).
  * The real run: **exit 0**; staged and checked ("sha256 matches the checksum given with --release-sha256"), SUDS
    stopped, a pre-upgrade backup, switched, "passkeys: WEBAUTHN_RP_ID/WEBAUTHN_ORIGINS in /etc/suds/suds.env kept as
    set", "SUDS 1.23.0 is ready" (migration 67 ran: `pre-migration/suds.db.v66.….db.enc`);
    `SUDS_RELEASE_CHECKSUM_SOURCE=operator`; `/api/health` **HTTP 200 `ok: true`**; no `WEBAUTHN_RP_ID` warning at
    start. **No hand-over**: the installed 1.22.0 upgrader ran the whole upgrade itself, as it should when the new
    release's upgrader is the same (finding 1 below). Its compliance report: **38 pass, 1 fail** (`host.time_sync`), 6
    warning, 2 could not check; `app.passkeys`, `app.https`, `app.backups`, `app.dr_drill`, `host.release_integrity`
    **pass**.
* [3-after-upgrade-weekly-compliance.txt](ubuntu-24.04-upgrade-1.22.0-to-1.23.0-with-the-installed-1.22.0-upgrader/3-after-upgrade-weekly-compliance.txt):
  the weekly unit, the same result; `WEBAUTHN_RP_ID` set, nothing to add.
* [4-listener-after-upgrade.txt](ubuntu-24.04-upgrade-1.22.0-to-1.23.0-with-the-installed-1.22.0-upgrader/4-listener-after-upgrade.txt):
  on the upgraded server, the "listening on" line, no unhandled rejection, `/api/setup/status` and `/api/app/info`
  **200** for a signed-in session.
* [5-handover-probe-1.23.0-to-1.23.99.txt](ubuntu-24.04-upgrade-1.22.0-to-1.23.0-with-the-installed-1.22.0-upgrader/5-handover-probe-1.23.0-to-1.23.99.txt):
  since no real release pair differs, the hand-over was exercised again, on this server, with a **probe build that is
  not a release**, as in the 1.21.0 run: the 1.23.0 tree with `package.json` at `1.23.99` and one comment line appended
  to `deploy/linux/upgrade.sh`, zipped (SHA-256 `6fb714037d3eb534595ae7b078927618a25f7d3d0bb014e4ca84a569817a8e73`) and
  passed with `--release-sha256`. The dry run names the hand-over; the real run, with the installed **1.23.0**
  upgrader: "SUDS 1.23.99 has its own upgrade.sh: handing over to it (/opt/suds/1.23.99/deploy/linux/upgrade.sh)", the
  staged script finds the stage complete ("every file matches its manifest") and goes on to "SUDS 1.23.99 is ready";
  `/opt/suds/current/deploy/linux/upgrade.sh` ends with the probe's comment line; `/api/health` **200**; exit 0. The
  probe build existed only in this throwaway container, and its compliance report is not kept here.

1.23.0's own `upgrade.sh` (the documented command) was not run separately: it is byte-identical to the installed one, so
it would run the same steps.

## Signatures

Checked on the host from this branch:

```bash
E=docs/evidence/installer-container-run-2026-10-01-v1.23.0/ubuntu-24.04-install-1.23.0
npm run verify-dr-report -- $E/dr-drill-2026-10-01T05-00-49-587Z.json --public-key $E/suds-signing-key.pem          # VERIFIED, key id 17d2b6febb037ce8
npm run verify-dr-report -- $E/dr-drill-2026-10-01T05-01-23-064Z.json --public-key $E/suds-signing-key.pem          # VERIFIED
npm run verify-compliance-report -- $E/compliance-2026-10-01T05-00-50-403Z.json --public-key $E/compliance-signing-key.pub.pem   # VERIFIED, key id 60f2f478426afdb2
npm run verify-compliance-report -- $E/compliance-2026-10-01T05-01-23-772Z.json --public-key $E/compliance-signing-key.pub.pem   # VERIFIED
```

The two compliance reports of the upgrade container verify with its folder's `compliance-signing-key.pub.pem` (key id
`4dff7d29ba1dcb85`). No private key is in this folder; the first administrator's temporary password is in no
transcript (checked by searching every file for it before the containers were removed).

## Findings

Recorded, not fixed here (no code was changed by this run).

1. **The hand-over between two real releases has still not happened, and 1.22.0 → 1.23.0 cannot show it.** 1.22.0 and
   1.23.0 ship the same `deploy/linux/upgrade.sh` and `lib.sh`, so the installed 1.22.0 upgrader correctly ran the
   upgrade itself (the hand-over is only for a release whose upgrader differs). Not a defect: the dry run says exactly
   that ("if … differs … hand over"), and the mechanism works (the probe build above, as in the 1.21.0 run). The real
   hand-over is still to be recorded on the first release that changes `deploy/linux/upgrade.sh` or `lib.sh`.
2. **The 1.21.0 run's three findings are closed on 1.23.0**: the listener under the service sandbox (the "listening on"
   line, no unhandled rejection, `/api/setup/status` and `/api/app/info` 200 signed in, on a fresh install and after the
   upgrade; `suds.service` still lacks `AF_NETLINK`, which SUDS now does without); the dry run from a zip names the
   possible hand-over; the staging line names the operator's checksum.
3. **Harness only, as before:** `escrow-drill.sh` cannot read the public key as `suds` after shredding the escrow file
   it passes as a credential; read again with an empty escrow file (6b).

## What this run could not exercise

The same as the earlier runs: a LUKS data volume; SSH and the admin-network lock-out check; a real offsite host and a
WORM share; a working NTP source; package installation from the distribution's mirrors during the run; ACME
(`--tls=caddy`); a reboot; cloud security groups; RHEL 9 entirely. The rollback path of `upgrade.sh` was not exercised
here (`test/deploy-linux-real.test.js` rolls one back for real in a fake root). The hand-over to a real later release.

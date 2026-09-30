# Installer run in a systemd container — 2026-09-30 (SUDS 1.19.0)

> **Not a VM run.** This is `deploy/linux/install.sh` and `upgrade.sh` run for real, as root, on Ubuntu 24.04 with
> systemd 255 as PID 1 — but inside a privileged Docker container in a development sandbox, not on a virtual
> machine. It exercises far more than `test/deploy-linux-real.test.js` (real `apt`, `useradd`, `ufw`/iptables,
> systemd units with `LoadCredential=`, journald, Caddy terminating TLS, the weekly compliance timer, a backup, a
> recovery drill and an upgrade), but several things a VM has could not be exercised, and **RHEL 9 could not be run
> at all**. The real-VM run on fresh Ubuntu 24.04 and RHEL 9 VMs is still owed: the runbook is
> [../INSTALLER-VM-RUN.md](../INSTALLER-VM-RUN.md) (owner-pending).

## Environment

* Host: the development sandbox (Ubuntu 24.04 kernel 6.18.44, cgroup v1, no `/dev/kvm`, no systemd; so no VM,
  no `systemd-nspawn`, no qemu). A Docker 29.3.1 daemon could be started there.
* Image: `mirror.gcr.io/library/ubuntu:24.04` (24.04.5; Docker Hub answered 429) plus, at build time, `systemd`,
  `dbus` and the packages the installer asks for (`ca-certificates curl xz-utils unzip ufw unattended-upgrades
  systemd-timesyncd`), fetched through the sandbox's HTTPS proxy: [environment/Dockerfile](environment/Dockerfile).
  The container itself ran with **no network** (`--network none`): the installer's `apt-get update` fails soft
  (warnings, exit 0) and every package it asks for is already there; Node.js, Caddy and the release came from the
  documented offline options (`--node-tarball`, `--caddy-tarball`, `--source`), downloaded on the host from
  nodejs.org and the Caddy GitHub release and each checked by the installer against `deploy/linux/pins`.
* Release: `suds-v1.19.0.zip` = `git archive --format=zip --prefix=suds-v1.19.0/ 3dc20dc` (as `release.yml` builds
  it), SHA-256 `c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed`, passed as `--release-sha256`.
  The tag is not pushed, so the checksum could not be taken from the release notes and the CHANGELOG as an operator
  would.
* "Shares": the offsite and anchor directories were bind mounts from the host (real mount points, as the installer
  requires, but on the same disk, not another host, and **not WORM**).
* TLS: `--tls=county-cert` with a certificate for `suds.county.test` issued by a throwaway CA made in the
  container (`--ca-file`), and `suds.county.test` pointed at 127.0.0.1 in `/etc/hosts`.
* No LUKS volume could be attached: `--accept-unencrypted-disk="installer drill in a systemd container: no LUKS
  volume attached"` (printed as an accepted risk in every compliance report, as designed).
* `--console-access` (no SSH into a container); `--ntp-server=time.county.test` (unreachable).

## Ubuntu 24.04: fresh install of 1.19.0 — [ubuntu-24.04-install-1.19.0/](ubuntu-24.04-install-1.19.0/)

```bash
cd /root/suds-v1.19.0 && deploy/linux/install.sh --domain=suds.county.test --admin-cidr=10.20.0.0/16 \
  --offsite=/mnt/suds-offsite --anchors=/mnt/worm/suds-anchors --tls=county-cert --cert=/root/pki/site.pem \
  --key=/root/pki/site.key --ca-file=/root/pki/ca.pem --source=/root/suds-v1.19.0.zip \
  --release-sha256=c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed \
  --node-tarball=/root/node-v22.23.3-linux-x64.tar.xz --caddy-tarball=/root/caddy_2.10.2_linux_amd64.tar.gz \
  --ntp-server=time.county.test --accept-unencrypted-disk="…" --console-access [--dry-run]
```

| Transcript | Outcome |
| --- | --- |
| [1-dry-run.txt](ubuntu-24.04-install-1.19.0/1-dry-run.txt) | Exit 0: the plan (`+ …`), the unencrypted-disk warning, the three checksums matched |
| [2-run-refused-anchor-share.txt](ubuntu-24.04-install-1.19.0/2-run-refused-anchor-share.txt) | Exit 1 after staging the release, Node and Caddy: **REFUSED** `/mnt/worm/suds-anchors is not writable by the suds user` (correct: the share was root's). `chown suds:suds` on it |
| [3-run-refused-offsite-share.txt](ubuntu-24.04-install-1.19.0/3-run-refused-offsite-share.txt) | Exit 1: **REFUSED** the same for `/mnt/suds-offsite` (the refusals come one at a time). `chown` it too |
| [4-run-suds-not-ready-container-credentials.txt](ubuntu-24.04-install-1.19.0/4-run-suds-not-ready-container-credentials.txt) | Exit 1 after 3 min: keys, config, firewall, time, updates, journal and units all done, but **REFUSED: SUDS did not become ready**. The journal: `SUDS_ENCRYPTION_KEY_FILE names /run/credentials/suds.service/suds_encryption_key, which cannot be read (ENOENT)`. A **container artefact**: `LoadCredential=` failed for every unit, even a bare `systemd-run -p LoadCredential=x:/etc/hostname`, because Docker mounts `/` with private propagation, so the credential mount systemd makes never appeared. `mount --make-rshared /` (what systemd does itself when it boots a real machine) fixed it |
| [5-run-complete.txt](ubuntu-24.04-install-1.19.0/5-run-complete.txt) | **Exit 0 in 28.5 s.** Existing keys kept, ufw enabled (deny incoming; 443; SSH from 10.20.0.0/16), services enabled, "SUDS is up on 127.0.0.1:8080, served at https://suds.county.test", the first-admin password file, then the compliance check: **29 pass, 5 fail, 9 warning, 3 could not check** ([compliance-2026-09-30T18-54-53-902Z.json](ubuntu-24.04-install-1.19.0/compliance-2026-09-30T18-54-53-902Z.json)) |

Then, on the installed server:

* `https://suds.county.test/api/health` through Caddy with the county CA: `{"ok":false,"uptime_seconds":53,"database":"ok","warnings":["Scheduled backups are set for every 4 hours but the last one has never run."]}`; `http://` answers 308 to `https://`; responses carry HSTS (`max-age=31536000; includeSubDomains; preload`) and the CSP. The first administrator (`guest`, the temporary password from `/var/lib/suds/first-admin-password.txt`) signs in over HTTPS with `must_change_password: true`.
* A backup to the offsite share as the `suds` user with the service's credentials (the `systemd-run` of SELF-HOSTING.md, *Backup and restore*; [environment/as-suds.sh](environment/as-suds.sh)): `scripts/backup.js /mnt/suds-offsite` → 1,324 KB, encrypted.
* The recovery drill against the offsite copy **with an escrowed key file** (the four keys as `KEY=VALUE` lines, handed to the transient unit as a credential): `scripts/dr-drill.js --offsite --keys-file …` → **PASSED, 11/11** (the offsite copy was restored; RTO 0.4 s, RPO 13 s against the provisioned 4 h target): [dr-drill-2026-09-30T18-56-21-123Z.json](ubuntu-24.04-install-1.19.0/dr-drill-2026-09-30T18-56-21-123Z.json) / [.txt](ubuntu-24.04-install-1.19.0/dr-drill-2026-09-30T18-56-21-123Z.txt). `npm run verify-dr-report -- <it> --public-key suds-signing-key.pem` (the server's evidence key, [suds-signing-key.pem](ubuntu-24.04-install-1.19.0/suds-signing-key.pem), read on the server with [environment/pubkey.js](environment/pubkey.js)) → **VERIFIED**, key id `4a9d1f7c8fcaf8a9`.
* `systemctl start suds-compliance` (the weekly unit): **32 pass, 3 fail, 8 warning, 3 could not check** ([compliance-2026-09-30T18-56-52-500Z.json](ubuntu-24.04-install-1.19.0/compliance-2026-09-30T18-56-52-500Z.json)); the unit ends `failed` because the check's result is FAIL. Both reports: `npm run verify-compliance-report -- <file> --public-key compliance-signing-key.pub.pem` → **VERIFIED**, key id `1e42ef21cade8790` ([compliance-signing-key.pub.pem](ubuntu-24.04-install-1.19.0/compliance-signing-key.pub.pem)).

Passing on this host: `host.os`, `host.data_dir`, `host.keys`, `host.service`, `host.tls`, `host.http_redirect`,
`host.bind`, `host.firewall`, `host.security_updates`, `host.journald`, `host.node`, and every `app.*` check except
those below. After the drill, `host.dr_evidence`, `app.dr_drill` and `app.https` passed too.

Still failing or unchecked after the drill, and why:

| Check | Result | Why |
| --- | --- | --- |
| `host.time_sync` | fail | The container has no network, so the clock never synchronised: environment |
| `app.passkeys` | fail | `WEBAUTHN_RP_ID` is not set. The installer does not set it; SELF-HOSTING.md, *After the install*, step 5, makes it the operator's step. Expected on a new 1.19.0 install until that step is done |
| `app.backups` | fail | "every 4 h; last never": the first scheduled backup was not yet due. A backup made with `scripts/backup.js` does not count as the scheduled one |
| `host.disk_encryption` | could not check | overlay filesystem: no LUKS (accepted risk, above) |
| `host.suds_version` | could not check | no release feed (`UPDATE_FEED_URL`) in a sandbox |
| `host.release_integrity` | could not check | `SUDS_RELEASE_CHECKSUM_SOURCE` is empty in `/etc/suds/suds-server.conf` although every run passed `--release-sha256`: see *Findings*, 1 |

## Ubuntu 24.04: install 1.18.0, then `upgrade.sh` to 1.19.0 — [ubuntu-24.04-upgrade-1.18.0-to-1.19.0/](ubuntu-24.04-upgrade-1.18.0-to-1.19.0/)

A second container, with `mount --make-rshared /` applied first and the `suds` user and share ownership set before
the installer ran.

* [1-install-1.18.0.txt](ubuntu-24.04-upgrade-1.18.0-to-1.19.0/1-install-1.18.0.txt): 1.18.0's own `install.sh`
  from `git archive --format=zip --prefix=suds-v1.18.0/ 39e397e` (SHA-256 `23cc69ab…99a4cc`), `--skip-compliance-check`:
  exit 0. (An earlier attempt, not kept, stopped at `useradd: group suds exists`: a `groupadd` I had run by
  mistake; it had already staged the release.)
* [2-upgrade-to-1.19.0.txt](ubuntu-24.04-upgrade-1.18.0-to-1.19.0/2-upgrade-to-1.19.0.txt): the installed
  release's upgrader, as documented: `/opt/suds/current/deploy/linux/upgrade.sh 1.19.0 --release-sha256=c9278089…
  --source=/root/suds-v1.19.0.zip --node-tarball=… --caddy-tarball=…` → **exit 0 in 18.7 s**: staged and checked,
  Node and Caddy already at their pins, SUDS stopped, a pre-upgrade backup taken as `suds`, switched, "SUDS 1.19.0
  is ready" (migrations 58 and 59 ran; the database was snapshotted first: `pre-migration/suds.db.v57.….db.enc`),
  compliance check **30 pass, 5 fail, 9 warning, 2 could not check**
  ([compliance-2026-09-30T18-58-57-788Z.json](ubuntu-24.04-upgrade-1.18.0-to-1.19.0/compliance-2026-09-30T18-58-57-788Z.json),
  VERIFIED with [compliance-signing-key.pub.pem](ubuntu-24.04-upgrade-1.18.0-to-1.19.0/compliance-signing-key.pub.pem),
  key id `4975e46a64425840`). `/etc/suds/suds-server.conf` now says `SUDS_VERSION=1.19.0`,
  `SUDS_RELEASE_CHECKSUM_SOURCE=operator`. The database held only what a new install holds (no client records): the
  upgrade of real data is the [upgrade drill](../upgrade-drill-2026-09-30/README.md). The rollback path was not
  exercised here (`test/deploy-linux-real.test.js` rolls one back for real in a fake root).

## AlmaLinux 9 (RHEL family) — [almalinux-9/](almalinux-9/)

`mirror.gcr.io/library/almalinux:9` (9.8) boots with systemd 252, and the installer recognised the RHEL family,
but [it stopped at `dnf install`](almalinux-9/install-refused-no-package-repositories.txt): the sandbox's egress
policy denies every RHEL-family package mirror tried (repo.almalinux.org, mirrors.almalinux.org, dl.rockylinux.org,
the kernel.org mirrors, mirror.stream.centos.org, quay.io, registry.access.redhat.com), and the image has no
`unzip`, `firewalld`, `chrony` or `dnf-automatic`. **Nothing past the host checks was exercised on RHEL**: firewalld,
chrony, dnf-automatic, SELinux relabelling and the whole service start remain untested outside the fake root.

## What this run could not exercise

A LUKS data volume; SSH and the admin-network lock-out check (`--console-access`); a real offsite host and a WORM
share (and the checklist's overwrite/delete test); a working NTP source; package installation from the
distribution's mirrors during the run (preinstalled instead); the release checksum taken from the release notes and
the CHANGELOG at a pushed tag; ACME (`--tls=caddy`); a reboot (units coming back at boot, the crypttab unlock);
cloud security groups; RHEL 9 entirely. These are what [../INSTALLER-VM-RUN.md](../INSTALLER-VM-RUN.md) asks for.

## Findings for the owner (no change made here)

**Status (1.20.0):** all four were fixed in **1.20.0** (CHANGELOG, *1.20.0*, "Fixed: installer and day-one problems
found by a real install in a systemd container"), and the [1.20.0 container run](../installer-container-run-2026-09-30-v1.20.0/README.md)
verifies each on a fresh install: **1** its install runs 3 and 4 (a run stopped after staging, then
`SUDS_RELEASE_CHECKSUM_SOURCE=operator` and `host.release_integrity` pass); **2** runs 1 and 2 (both shares in one
refusal, the `suds` user made first, nothing staged); **3** runs 4 and 5 (the installer's first backup and drill,
`app.backups`, `app.dr_drill` and `app.https` pass, `/api/health` 200 `ok: true`); **4** run 5 (`WEBAUTHN_RP_ID` set,
`app.passkeys` pass). One gap remains on an **upgrade from 1.19.0** with the documented command, which runs the
installed 1.19.0 `upgrade.sh`: it does not add `WEBAUTHN_RP_ID` (4) and its report still fails `app.https` (3); 1.20.0's
own `upgrade.sh`, or the two lines added by hand, fixes both. That run's *New finding* has the detail. The findings
below are kept as they were written against 1.19.0.

1. **A first run that stops after staging loses the release-checksum record.** `stage_release` records
   `RELEASE_CHECKSUM_SOURCE=operator` when it checks the zip (deploy/linux/lib.sh:318), but a later run finds the
   stage complete and keeps only what it already had (lib.sh:304), which install.sh reads back from
   `suds-server.conf` (install.sh:167); the conf is written only after the directories step (install.sh:289). Here
   runs 2 and 3 stopped between the two (the share refusals), so every later run wrote
   `SUDS_RELEASE_CHECKSUM_SOURCE=` and `host.release_integrity` reports "could not check" until the next upgrade.
   Reproduced twice (both containers). A fix belongs in a release; an operator can meanwhile re-run with the
   staged directory removed, or set the line by hand.
2. **The share refusals come one at a time, and the `suds` user they name exists only after a first run.** An
   operator with root-owned shares runs the installer three times (as here). Worth one refusal that names both
   shares, or a note in SELF-HOSTING.md, *Prerequisites*, to create the user first
   (`useradd --system --user-group --home-dir /var/lib/suds --no-create-home --shell /usr/sbin/nologin suds`).
3. **Day one reads red in more places than SELF-HOSTING.md says.** It says `host.backup_files` and
   `host.dr_evidence` are warnings on day one; `app.backups` and `app.dr_drill` fail, and `/api/health` answers
   `ok: false` until the first scheduled backup (up to 4 hours), which a monitor would alarm on. `app.https` also
   failed on the installer's first report (and on the upgrade's) and passed on the next one, by which time HTTPS
   requests had reached SUDS; whether it waits for one was not looked into.
4. **`app.passkeys` fails on every new 1.19.0 install and upgrade** until the operator sets `WEBAUTHN_RP_ID`. The
   installer already knows the name (`--domain`); setting it (and `WEBAUTHN_ORIGINS`) there would remove a manual
   step. Documented as the operator's step today.

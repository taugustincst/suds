# SUDS Server: self-hosting guide

This is the guide for the county or CBO IT person who will run SUDS for a programme on a server of their own. **SUDS Server** is the existing SUDS office server, installed hardened by one command on a Linux VM (`deploy/linux/install.sh`), with a compliance check (`npm run compliance-check`) that records, every week and in a signed report, whether the host still matches the hardening policy — evidence for the organisation's own evaluation, not a certificate.

It is not a different product: the same code as any SUDS office server ([PLATFORM.md](PLATFORM.md)), installed the way [DEPLOYMENT.md](DEPLOYMENT.md) describes, with the choices made for you. A small office without a Linux server uses the setup wizard instead ([INSTALL.md](INSTALL.md)); a Docker host uses `docker-compose.yml` and [deploy/docker/README.md](../deploy/docker/README.md).

**Read the [compliance boundary](#compliance-boundary) before you tell anyone the programme is compliant.** No software makes an organisation compliant on its own.

## Contents

- [Sizing](#sizing)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [What the installer does, and why](#what-the-installer-does-and-why)
- [After the install](#after-the-install)
- [Upgrading](#upgrading)
- [Backup and restore](#backup-and-restore)
- [Recovery drill](#recovery-drill)
- [Monitoring](#monitoring)
- [The compliance check](#the-compliance-check)
- [Compliance boundary](#compliance-boundary)
- [Operator checklist](#operator-checklist)

## Sizing

SUDS is one Node.js process and one SQLite file ([DEPLOYMENT.md](DEPLOYMENT.md), *Single instance only*): it scales up, not out. The figures below come from [PERFORMANCE.md](PERFORMANCE.md) (a 20,000-client programme is a database of about 100 MB and is served comfortably by 4 vCPUs) with headroom for backups, recovery drills and the OS.

| Staff using it at once | vCPU | RAM | Encrypted data disk | Notes |
| --- | --- | --- | --- | --- |
| up to 25 (most programmes) | 2 | 4 GB | 20 GB | |
| 25 to 75 | 4 | 8 GB | 50 GB | a large programme with years of scanned forms |
| more than 75 | 4–8 | 16 GB | 100 GB | consider one SUDS per programme instead (ADR-0001) |

The data disk holds the database, 14 local backups (the default retention), frequent snapshots if you turn them on (about the database size × `backup_snapshot_retain` on the offsite share), a recovery drill's temporary copy (the database size, briefly) and the compliance reports (kilobytes each). A backup and a drill each need about three times the database size in memory at their peak ([security/BACKUP-AND-DR.md](security/BACKUP-AND-DR.md)). The OS disk needs 10 GB free for the journal and the releases kept in `/opt/suds`: the installer caps the journal at 8 GB (`SystemMaxUse`, `--journal-max-use=<size>`) and keeps it 400 days (`--log-retention-days`); if the cap is reached first, the compliance check warns (`host.journald` reports the oldest entry), so raise the cap or forward the journal to the SIEM.

## Prerequisites

Have these before you run the installer. It checks each one and refuses to go on without it.

1. **A VM running Ubuntu 24.04 LTS or RHEL / Rocky / Alma Linux 9**, x86_64, freshly installed, with SSH access for an administrator and outbound HTTPS to `nodejs.org`, `github.com` and the distribution's package mirrors (or the downloads staged by hand: `--node-tarball`, `--caddy-tarball`, `--source`). **Run it on a staging VM of the same image first** (`--dry-run`, then for real): the installer is tested against a fake root with stub system commands (`test/deploy-linux-real.test.js`) and has run for real on Ubuntu 24.04 in a systemd container ([evidence/installer-container-run-2026-09-30/](evidence/installer-container-run-2026-09-30/README.md)), but not yet on a real VM by the project, nor on RHEL 9 ([evidence/INSTALLER-VM-RUN.md](evidence/INSTALLER-VM-RUN.md)).
2. **A LUKS-encrypted data disk mounted at `/var/lib/suds`.** Encryption at rest cannot be added by an installer after the fact, so it must exist first: attach a second disk, `cryptsetup luksFormat` it (LUKS2), open it at boot (`/etc/crypttab`: a key file on the encrypted root, or the hypervisor's vTPM with `systemd-cryptenroll`, or a network-bound unlock such as Clevis/Tang — whatever your county's standard is), make a filesystem and mount it at `/var/lib/suds` in `/etc/fstab`. On a cloud VM whose disks are encrypted by the platform (EBS with a KMS key, an Azure managed disk with a customer-managed key) the encryption is not visible from inside the VM: layer LUKS on the disk anyway, or pass `--accept-unencrypted-disk="<why>"` — the reason then appears as an **accepted risk** in every compliance report.
3. **A DNS name** for the server (for example `suds.county.gov`) resolving to it; and either ports 80 and 443 reachable for a Let's Encrypt/ACME certificate, or a **certificate and key from the county CA** (`--tls=county-cert`, port 443 only).
4. **A write-once (WORM) share** mounted on the VM for the audit anchors, for example `/mnt/worm/suds-anchors` (NetApp SnapLock, Dell PowerScale SmartLock, Synology WriteOnce, S3 Object Lock through Mountpoint; how, per product: [security/LOGGING-AND-AUDIT.md](security/LOGGING-AND-AUDIT.md), *Pointing AUDIT_ANCHOR_DIR at write-once storage*). Outside `/var/lib/suds`, on different storage. The `suds` user must be able to create files there.
5. **An offsite backup share** mounted on the VM, for example `/mnt/suds-offsite`: on another host, preferably at another site, writable by the `suds` user, encrypted at rest on its own storage (the backups are encrypted by SUDS; the share's own encryption protects everything else on it). Not the anchor share. SUDS does not depend on it to run: if the share is down, the offsite copy fails and is reported (Security status, `/api/health`, `host.backup_files`), and SUDS keeps serving; the anchor share, by contrast, is required (`RequiresMountsFor=`).

   **Both shares writable by `suds`.** The `suds` account does not exist before the first run, so the installer creates it before anything else (a system account: no shell, no home) and then tests both shares as that user, together: if either is not writable it refuses once, naming each share with its owner and mode, the account's uid and gid, and the commands that fix it — `chown suds:suds <dir> && chmod 0700 <dir>` where root can change the mount's ownership, `setfacl -m u:suds:rwx <dir>` to keep the owner, or, on an NFS or SMB share whose server decides ownership, write access for that uid/gid on the share's server (the anchor share: create and write only). Fix both, run again. To prepare the shares before the first run, create the account yourself: `useradd --system --user-group --home-dir /var/lib/suds --no-create-home --shell /usr/sbin/nologin suds`. `--dry-run` cannot test as an account that does not exist yet: it reads the shares' modes and warns.
6. **A key custodian**: a named person (and a deputy) who will take the keys into escrow the moment the installer generates them, record who holds them, and bring them to the recovery drill. [security/ENCRYPTION-AND-KEYS.md](security/ENCRYPTION-AND-KEYS.md) describes the keys.
7. **The administration network** (a CIDR such as `10.20.0.0/16`) from which SSH will be allowed. Run the installer from inside it, or from the console: the firewall it enables allows SSH from nowhere else. It refuses to go on if this session, or any other established SSH session (`ss`), comes from outside that network, and — because `sudo` removes `SSH_CONNECTION` — it also asks `who -m` and the parent processes; if none of them can say where you are, it refuses unless you pass `--console-access` (you are at the console). Only IPv4 addresses can be compared. In a cloud, also restrict the security group's SSH rule to the same network: the host firewall is behind it.
8. **Optionally, the county's time source** (`--ntp-server=ntp1.county.gov,10.0.0.5`) and, for a county-issued certificate the host does not already trust, **the county CA certificate** (`--ca-file=/root/county-ca.pem`) so the compliance check can verify the chain (`--connect-host=<address>` if the check must reach the site by another address).

## Install

On the VM, as root, from an unpacked release: the zip from the GitHub release, checked against its SHA-256 **from two channels that must agree** — the release notes of its GitHub Release (`SHA-256 of suds-v<version>.zip: <hex>`) and the same line in that version's section of `CHANGELOG.md` on the `main` branch (`git show origin/main:CHANGELOG.md`). Not the tagged commit's own CHANGELOG: the zip is built from that commit, so that commit cannot contain its own checksum, which the maintainer adds to `main` after the release job has published it ([RELEASE.md](RELEASE.md), *The zip's SHA-256 in two places*) — and not only against the `.sha256` file beside the zip, which whoever could replace the zip could replace too (`sha256sum suds-v<version>.zip`, and compare):

```bash
sudo deploy/linux/install.sh --dry-run \
  --domain=suds.county.gov --admin-cidr=10.20.0.0/16 \
  --offsite=/mnt/suds-offsite --anchors=/mnt/worm/suds-anchors
# read the plan; then the same command without --dry-run
```

With a county certificate: add `--tls=county-cert --cert=/root/suds.county.gov.fullchain.pem --key=/root/suds.county.gov.key`. With Prometheus: add `--metrics` (a `METRICS_TOKEN` credential is generated). Every option: `deploy/linux/install.sh --help`, and [deploy/linux/README.md](../deploy/linux/README.md).

The installer is idempotent: run it again at any time to put a drifted host back. It never replaces a key and never deletes data. `--dry-run` prints every action it would take (`+ ...`) and changes nothing.

It ends by starting SUDS, running the **first backup and recovery drill** (below), printing the **key escrow** instruction (do it now; it is your step, not the installer's), the compliance signing key's id and the location of the first administrator's temporary password, and running the compliance check — once `https://<domain>` answers through Caddy (it waits up to 90 seconds, for Caddy to start and, with ACME, to obtain its certificate), and with the settings in `/etc/suds/suds.env`, exactly as the weekly `suds-compliance.service` runs it. (In 1.19.0 the installer's run lacked them, so `app.https` failed on its report and passed on the next weekly one.)

**Day one.** On a new server (no backup and no drill report yet) the installer runs `scripts/dr-drill.js --offsite` as the `suds` user with the service's keys, once SUDS is up: it takes the first scheduled backup (verified, copied to the offsite share), restores that offsite copy into a throwaway directory, checks it and records a signed report. So the first report normally shows the backup and the drill as done; `host.dr_evidence` still warns until a drill has used the **escrowed** key file (*After the install*, step 6). If the drill fails (the offsite share, most often), the installer says so and carries on: the failed drill is recorded as one (fix the cause, then run a drill from Settings → System & backups). If it could not run at all, SUDS takes the first backup and runs the monthly drill itself at its first hourly housekeeping pass. Until they have run, they are *pending first run (expected on day one)* — a **warning**, not a failure, everywhere: `host.backup_files` and `host.dr_evidence` for twice the backup interval and 31 days after `SUDS_INSTALLED_AT`; `app.backups` and `app.dr_drill` (Settings → Security status) for twice the interval and 31 days after the schedule and the monthly drill were turned on; and `/api/health` answers **200, `ok: true`**, with the pending backup in `warnings`, so a monitor does not alarm on a new server. After those windows a missing backup or drill fails, and `/api/health` answers 503.

## What the installer does, and why

Each step, the control it implements, and where the compliance check verifies it.

| Step | What | Why (control) | Checked by |
| --- | --- | --- | --- |
| Refusals first | Refuses an unsupported OS, a data directory not on dm-crypt/LUKS, anchors or offsite inside the data directory (resolved through `..` and symlinks), shares that are not mount points or not writable by the `suds` account (created first, both shares tested as it and named in one refusal with the commands that fix them), any SSH session outside `--admin-cidr` (or where it cannot tell), a path, e-mail, host or number that is not plainly one (whitelisted, never escaped), a release zip without a checksum from another channel | Nothing half-configured: the controls below depend on these | `host.os`, `host.disk_encryption`, `host.audit_verify`, `host.backup_files` |
| Node.js | The exact release CI tests on (`deploy/linux/pins`, the same pin as `.github/workflows/ci.yml`), downloaded over HTTPS and **checked against its pinned SHA-256 before it is unpacked**; never `curl \| sh`, never a floating package | Integrity of the runtime; patch management (§164.308(a)(1)(ii)(B)) | `host.node` |
| Caddy | The pinned static release, checked against its pinned SHA-512, run as the `caddy` user with only `CAP_NET_BIND_SERVICE`, with the repository's `Caddyfile`: TLS 1.2 and 1.3 only, HSTS for a year, port 80 only redirecting and answering ACME | Transmission security (§164.312(e)(1), (e)(2)(ii); 42 CFR §2.16(a)(2)(i)) | `host.tls`, `host.http_redirect` |
| Code | `/opt/suds/<version>`, root-owned and read-only (every directory 0755, made with `install -d -m` whatever the umask), behind the `current` symlink; staged into `<version>.partial` with a manifest and renamed when complete, so an interrupted run is redone, never used | A compromised process cannot rewrite the code it runs | `host.service`, `host.release_integrity` |
| Service account and data | The `suds` system user (no shell, no home), `/var/lib/suds` 0700, the database 0600 | Access control (§164.312(a)(1)) | `host.data_dir` |
| Keys | `SUDS_ENCRYPTION_KEY`, `SUDS_INDEX_KEY`, `SUDS_BACKUP_KEY`, `SUDS_SIGNING_KEY` (and `METRICS_TOKEN` with `--metrics`) generated as root-only files in `/etc/suds/credentials` (0600, directory 0700), handed to the service by systemd `LoadCredential=` and read through `*_FILE` (server/config.js): never in an environment file, never in the process environment, never printed or logged. A wizard install's `keys.json` is carried across, never replaced | Encryption and decryption (§164.312(a)(2)(iv)); key custody | `host.keys`, `app.phi_key`, `app.signing_key` |
| The unit | [deploy/linux/suds.service](../deploy/linux/suds.service), unchanged: `ProtectSystem=strict`, `NoNewPrivileges`, no capabilities, a system-call filter, bound to `127.0.0.1:8080`; site paths in a drop-in | Least privilege; SUDS reachable only through the TLS proxy | `host.service`, `host.bind` |
| Production settings | `LOCAL_MODE_ENABLED=false`; two-step verification for every role; `TRUST_PROXY=1` for Caddy; `AUDIT_ANCHOR_DIR` on the WORM share; `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` from `--domain` for passkeys (yours kept if set); and, through `SUDS_PROVISION_FILE`, scheduled backups every 4 hours to the offsite share, the monthly recovery drill, "require two-step verification for every role" (applied only where nobody has chosen yet; change them later under Settings) | Person authentication (§164.312(d)); device and media controls (§164.310(d)(1)); data backup plan (§164.308(a)(7)(ii)(A)) | `app.mfa_required`, `app.local_mode`, `app.backups`, `app.offsite` |
| Firewall | ufw (Ubuntu) or firewalld (RHEL): deny incoming, allow 443 (and 80 with ACME), SSH only from `--admin-cidr` (a re-run with another CIDR removes the old rule) | Network access control | `host.firewall` |
| Time | chrony where it is installed (always on RHEL; kept on Ubuntu rather than adding systemd-timesyncd beside it), else systemd-timesyncd; `--ntp-server` for the county's source | Audit timestamps are only evidence if the clock is right (§164.312(b)) | `host.time_sync` |
| Updates | unattended-upgrades with the `-security` origin (Ubuntu) or dnf-automatic with `upgrade_type = security` (RHEL) | Protection from malicious software, patching (§164.308(a)(5)(ii)(B)) | `host.security_updates` |
| Journal | `Storage=persistent`, `MaxRetentionSec` = `--log-retention-days` (default 400 days; the audit log itself is kept 7 years in the database), `SystemMaxUse` = `--journal-max-use` (default 8G) | Information system activity review (§164.308(a)(1)(ii)(D)) | `host.journald` (with the oldest entry) |
| SELinux (RHEL) | `restorecon -R` on everything installed when SELinux is enforcing, so files unpacked or moved into place carry the right labels | The OS's own mandatory access control stays on | — |
| auditd | Recommended, not installed: the OS's own record of logins, sudo and changes to `/etc/suds` | Audit controls at the OS layer | `host.auditd` (a warning when absent) |
| Weekly check | `suds-compliance.timer` runs the compliance check weekly as root with only the capabilities it needs; reports written to `/var/lib/suds-compliance` (0750 root:suds: SUDS reads them, cannot write them) and signed with the check's own key, `/etc/suds/compliance-signing-key` (root 0600, never given to `suds.service`); SUDS verifies them with its public half | Evaluation (§164.308(a)(8)) | Settings → Security status |

## After the install

1. **Escrow the keys** as the installer told you, before anything else. Without them no backup can be restored.
2. Read the temporary password once (`sudo cat /var/lib/suds/first-admin-password.txt`), sign in at `https://<domain>`, change it and enrol two-step verification.
3. Give your auditor two public keys, with their key ids, obtained on the server rather than from a report: the **evidence signing key** (Settings → Security status → *Download signing public key*), which verifies recovery-drill reports and audit exports, and the **compliance signing key** (`/etc/suds/compliance-signing-key.pub.pem`; the installer printed its id), which verifies compliance reports. SUDS itself cannot sign a compliance report: it never holds that key.
4. Configure single sign-on if the county has an identity provider ([DEPLOYMENT.md](DEPLOYMENT.md), *Single sign-on*): set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI` in `/etc/suds/suds.env` and the client secret as a credential (`/etc/suds/credentials/oidc_client_secret`, a `LoadCredential=oidc_client_secret:…` line and `Environment=OIDC_CLIENT_SECRET_FILE=%d/oidc_client_secret` in a drop-in), then `systemctl restart suds`.
5. **Fingerprint sign-in (passkeys)**, released in 1.19.0 ([FINGERPRINT.md](FINGERPRINT.md)): a passkey belongs
   to one host name and works only over **HTTPS**, so it needs the TLS set-up above and one setting, **required in
   production** (without it nobody can add or use a passkey, and Security status shows it in red):
   `WEBAUTHN_RP_ID`, the **same name as on the certificate and in the address staff open**. Since 1.20.0 the
   installer sets it from `--domain` in `/etc/suds/suds.env` (`WEBAUTHN_RP_ID=<domain>` and
   `WEBAUTHN_ORIGINS=https://<domain>`), and `upgrade.sh` adds both to a server installed before that; neither
   replaces a `WEBAUTHN_RP_ID` or `WEBAUTHN_ORIGINS` you set yourself (a re-run of the installer keeps yours). Change
   it only before anyone enrols if staff use another name (a passkey made for another name, or at an IP address,
   never works; one made before a rename must be added again), and then `systemctl restart suds`. Behind a proxy
   that changes what SUDS sees, list the exact page origins in `WEBAUTHN_ORIGINS`. It is on by default; Settings →
   Security policy switches sign-in and signing with it off, or requires a fingerprint or authenticator code for
   signing. SUDS stores no fingerprint, only each passkey's public key.
6. Run a **recovery drill with the escrowed key file** against the offsite copy (Settings → System & backups). The installer's first drill used the keys on the server, which proves the backup, not the escrow; the compliance check warns (`host.dr_evidence`) until a drill has used the escrowed copy, and fails after 90 days without a drill.
7. Remove `keys.json` from `/var/lib/suds` if the installer carried keys across from a wizard install (`shred -u`), once the escrow is confirmed.
8. Check Settings → Security status: the *Host (last compliance check)* section shows the installer's run.

## Upgrading

```bash
sudo /opt/suds/current/deploy/linux/upgrade.sh 1.18.0 --release-sha256=<hex>        # downloaded from the GitHub release
sudo /opt/suds/current/deploy/linux/upgrade.sh 1.18.0 --source=/root/suds-v1.18.0.zip --release-sha256=<hex>
```

`--release-sha256` is required: take it from a channel other than the download — the release notes of the GitHub Release **and** that version's section of `CHANGELOG.md` on the `main` branch (`git show origin/main:CHANGELOG.md`, or the file on GitHub), which must agree; the maintainer publishes it in both after the release job has built the zip (docs/RELEASE.md, *The zip's SHA-256 in two places*; for 1.16.3 to 1.20.0, [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)). The tagged commit's own CHANGELOG cannot have it: the zip is built from that commit. The staged release records how its zip was checked (`/opt/suds/<version>/.suds-release-checksum`, covered by its manifest), so a run that stops after staging and is run again still reports it (`host.release_integrity`). `--trust-release-checksum` accepts the `.sha256` file from the same release instead, with a warning, and every compliance report then says so (`host.release_integrity`). A `--source` zip is copied before it is hashed and unpacked.

It follows `scripts/update.js`'s rule (back up first, and never leave the service on code that has not been proven) for a packaged install: stage and verify the release (and its pinned Node.js), **stop SUDS**, take an encrypted backup as the `suds` user with the service's own credentials, switch `current` (and `node`) and the units, start, and wait for `/api/health/ready` (migrations run here; SUDS also snapshots the database before migrating). When the new release pins another Caddy, that one is installed (checked against its pinned SHA-512 and asked its version) and Caddy is restarted once SUDS is ready — as it is when the Caddyfile changed. If SUDS does not become ready it **rolls back**: the previous code, Node, Caddy and units, and the database put back from the backup just taken with `scripts/backup.js --restore-in-place`, which never opens the live database (the failed release may have migrated it beyond what the old code can read). It never downgrades. `--dry-run` prints the plan. Remove old releases from `/opt/suds` when you no longer need to roll back to them. `deploy/linux/uninstall.sh` removes the software and never the data or keys.

## Backup and restore

Backups are the app's own ([security/BACKUP-AND-DR.md](security/BACKUP-AND-DR.md)): every 4 hours (provisioned by the installer), encrypted with `SUDS_BACKUP_KEY`, read back after writing, 14 kept in `/var/lib/suds/backups` and each copied to the offsite share; an audit anchor is written with each. Turn on 15-minute snapshots under Settings → Scheduled backups for a recovery point in minutes. An outage of the offsite share does not stop SUDS (its unit lists the share as optional, `ReadWritePaths=-…`): the offsite copy fails and says so until the share is back; the local backups carry on. The installer's provisioning file (`/etc/suds/provision.json`) can only tighten settings (backups at least daily, the monthly drill on, two-step verification required, self sign-up off): a weaker value there is refused and logged.

Restore: Settings → System & backups → *Restore from a backup* (up to about 450 MB), or on the server:

```bash
sudo systemctl stop suds
sudo systemd-run --wait --pipe --collect --uid=suds --gid=suds --working-directory=/opt/suds/current \
  -p EnvironmentFile=/etc/suds/suds.env -E SUDS_ENV=production -E SUDS_DATA_DIR=/var/lib/suds \
  -p LoadCredential=suds_encryption_key:/etc/suds/credentials/suds_encryption_key \
  -p LoadCredential=suds_index_key:/etc/suds/credentials/suds_index_key \
  -p LoadCredential=suds_backup_key:/etc/suds/credentials/suds_backup_key \
  -p LoadCredential=suds_signing_key:/etc/suds/credentials/suds_signing_key \
  /opt/suds/node/bin/node scripts/backup.js --restore-in-place /mnt/suds-offsite/suds-<stamp>.db.enc
sudo systemctl start suds
```

(`server/config.js` finds each key in the transient unit's credential directory by its name.) `--restore-in-place` never opens the live database — it may be one a newer release migrated, which this code cannot read: it checks the backup, writes it beside the database and checks that copy, moves `suds.db` and its `-wal`/`-shm` aside into `suds.db.replaced-<stamp>/` (sealed like a backup), renames the copy into place, drops any journal and writes a `restore` audit anchor. `upgrade.sh` uses the same command for its rollback. On a replacement server: install with the same options, put the escrowed keys in `/etc/suds/credentials` **before** the first start, then restore.

## Recovery drill

Settings → System & backups → *Run a recovery drill now*, monthly from housekeeping (provisioned on), or from a shell as above with `scripts/dr-drill.js --keys-file <escrowed keys>`. Each drill restores a backup into a throwaway copy, proves it (integrity, keys, schema, audit chain and anchors, decryption, a sign-in with a second factor) and writes a report signed with the evidence key ([DEPLOYMENT.md](DEPLOYMENT.md), *Recovery drill*). The compliance check fails when the last drill is older than 90 days, failed, or its signed report does not verify, and warns until one has used the escrowed keys against the offsite copy.

## Monitoring

- Point the county's monitoring at `https://<domain>/api/health` (503 means an operator must act: a failed audit check, stale backups, an expiring certificate, low disk) — never as a liveness probe ([DEPLOYMENT.md](DEPLOYMENT.md), 4b). On a new server whose first scheduled backup has not run yet it answers 200 with `ok: true` and the pending backup in `warnings` (*Day one*); it turns 503 only if the backup is still missing after twice the interval.
- `systemctl status suds caddy suds-compliance`; logs with `journalctl -u suds -u caddy -u suds-compliance`. `suds-compliance.service` exits 1 when a check fails, so a monitor on failed units sees it.
- With `--metrics`: Prometheus scrapes `https://<domain>/api/metrics` with the token in `/etc/suds/credentials/suds_metrics_token`.
- Forward the journal to the county SIEM for longer retention or central review; SUDS's audit anchors can also go to syslog (`AUDIT_SYSLOG` in `/etc/suds/suds.env`).

## The compliance check

```bash
sudo systemctl start suds-compliance && journalctl -u suds-compliance -n 60     # a run now, as the timer does it
sudo /opt/suds/node/bin/node /opt/suds/current/scripts/compliance-check.js           # summary; signed reports in /var/lib/suds/compliance
sudo /opt/suds/node/bin/node /opt/suds/current/scripts/compliance-check.js --json    # the signed JSON on stdout
npm run verify-compliance-report -- compliance-<stamp>.html --public-key suds-signing-key.pem   # an auditor, anywhere
```

Run as root for every check; as the `suds` user the root-only checks say *could not check*, which is never counted as a pass. Weekly from `suds-compliance.timer`. It writes a JSON and a self-contained HTML report to `/var/lib/suds-compliance`, both signed with the compliance check's own Ed25519 key (`/etc/suds/compliance-signing-key`, root only; `report.host.signed_with` names the key), so an auditor verifies them with its public half alone (`/etc/suds/compliance-signing-key.pub.pem`); the HTML verifier also re-renders the page and fails if what it shows was edited. A signature records who produced a report and that it was not edited since; it does not make the report's findings true — the check can only observe what it lists below. Run as root, it never follows a path the `suds` user controls: reports are created new (`O_EXCL|O_NOFOLLOW`) and handed over through their descriptors, the database is read from a private copy (never opened in place, so no root-owned `-wal`/`-shm` appear), and the drill report named in the database must be a bare report file name. Its settings are in `/etc/suds/suds-server.conf` (written by the installer; lines it does not manage are kept on a re-run): `SUDS_CA_FILE` (`--ca-file`) and `SUDS_CONNECT_HOST` (`--connect-host`) for the TLS check. An unknown option is an error. Settings → Security status shows the app-level checks live (the same code) and the host checks as the last report found them, with its date; the server records each new report in the audit log (`security.compliance_report.generated`), and each view or download (`security.compliance_report.view`, `GET /api/admin/security/compliance-report`, `settings:manage`). Exit status: 1 if any check failed; `--strict` also exits 2 on a warning or a *could not check*.

| Check | What is observed | Rules |
| --- | --- | --- |
| `host.os` | `/etc/os-release` is a supported release | §164.308(a)(1)(ii)(B) |
| `host.data_dir` | `/var/lib/suds` 0700 owned by `suds`; `suds.db`, `-wal`, `-shm`, `keys.json` 0600 | §164.312(a)(1); 42 CFR §2.16(a)(2)(iii); Cal. Civ. Code §56.101(a) |
| `host.disk_encryption` | the data directory's device chain (`findmnt`, `lsblk -s`) has a dm-crypt layer; `cryptsetup status` type LUKS, and not `cipher_null` (which fails) | §164.312(a)(2)(iv); §164.310(d)(1); 42 CFR §2.16(a)(2)(i); §56.101(a) |
| `host.keys` | credentials 0600/0700 root; no secret in the unit's `Environment=`, in any `EnvironmentFile=`, or in the running process's environment; `LoadCredential=` present | §164.312(a)(2)(iv); §164.312(a)(1) |
| `host.service` | the effective unit settings (`systemctl show`): the sandbox as shipped, active, enabled | §164.312(a)(1); §164.308(a)(1)(ii)(B) |
| `host.tls` | a `node:tls` connection to the domain: TLS 1.2+ negotiated, TLS 1.0/1.1 refused, certificate valid more than 14 days and naming the domain, HSTS header | §164.312(e)(1); §164.312(e)(2)(ii); 42 CFR §2.16(a)(2)(i) |
| `host.http_redirect` | port 80 only redirects to https (or is closed) | §164.312(e)(1) |
| `host.bind` | `/proc/net/tcp{,6}`: SUDS listens on loopback only | §164.312(e)(1); §164.312(a)(1) |
| `host.firewall` | ufw / firewalld active, default deny, only 443 (80) and SSH from the admin network | §164.312(e)(1); §164.308(a)(1)(ii)(B) |
| `host.time_sync` | `timedatectl`: synchronised; `chronyc tracking` / timesyncd offset under 1 s | §164.312(b); §56.101(b)(1)(B) |
| `host.security_updates` | unattended-upgrades `-security` + timer, or dnf-automatic `upgrade_type = security`, applied | §164.308(a)(5)(ii)(B); §164.308(a)(1)(ii)(B) |
| `host.journald` | persistent, `MaxRetentionSec` at least the policy; the oldest entry as evidence, and a warning when the journal is younger than the policy on a server older than it (the size cap is deleting entries) | §164.312(b); §164.308(a)(1)(ii)(D) |
| `host.auditd` | auditd active (a warning if not: recommended) | §164.312(b); §164.308(a)(1)(ii)(D) |
| `host.node` | the Node the unit runs is the pinned release | §164.308(a)(1)(ii)(B) |
| `host.release_integrity` | how the installed release's zip was checked (`SUDS_RELEASE_CHECKSUM_SOURCE`): a warning when only against the `.sha256` from the same release | §164.308(a)(1)(ii)(B); §164.308(a)(5)(ii)(B) |
| `host.suds_version` | the release is supported (docs/RELEASE.md, *Supported versions*), against the release feed (`UPDATE_FEED_URL`) or `--latest-version`; *could not check* without either | §164.308(a)(1)(ii)(B); §164.308(a)(5)(ii)(B) |
| `host.backup_files` | the newest backup file locally and on the offsite share is younger than twice the interval (*pending first run* on a new server) | §164.308(a)(7)(ii)(A); §164.310(d)(2)(iv) |
| `host.dr_evidence` | the last drill passed within 90 days and its signed report verifies with the signing key (*pending first run* for 31 days after the install) | §164.308(a)(7)(ii)(D); §164.308(a)(7)(ii)(B) |
| `host.audit_verify` | the audit hash chain (server/audit.js) and the external anchors (server/audit-anchor.js) verified now; anchors configured outside the data directory | §164.312(b); §164.312(c)(1), (c)(2); §56.101(b)(1)(B); 42 CFR §2.16(a)(2)(iii) |
| `app.*` | every line of Settings → Security status: MFA required for every role and its coverage, SSO, deprovisioning, password policy, session timeout, backups, RPO, offsite, drills, plaintext copies, backup key, audit chain and anchors, audit retention, keys, record retention, HTTPS, local mode, monitoring | as listed in `server/compliance-rules.js` |

**What it cannot automate, and why.** It cannot see encryption done beneath the VM (a SAN's or cloud platform's disk encryption), a firewall outside the host (a cloud security group, a county perimeter firewall), whether the WORM share is actually write-once (only that anchors verify and are outside the data directory), whether the keys are really in escrow and who holds them, whether the offsite share is at another site, or anything about people, paper and premises. Those are recorded by the organisation (next section, and the [operator checklist](#operator-checklist)); the report's *scope* says so.

## Compliance boundary

**No software makes an organisation compliant on its own.** HIPAA's Security Rule and 42 CFR Part 2 bind the covered entity or Part 2 programme — its policies, people, premises and contracts as well as its systems. SUDS Server **implements** the technical safeguards it can, **supports** others with evidence and tooling, and leaves the rest to the organisation, with templates where we have them. It holds no SOC 2, ISO 27001, HITRUST, StateRAMP or FedRAMP attestation ([security/SOC2-READINESS.md](security/SOC2-READINESS.md)).

*Implements*: SUDS Server does it, and a named compliance check shows it — every *Implements* row gives its check id (`host.*` / `app.*`, the catalogue in `server/compliance-rules.js`; `test/compliance-check.test.js` fails a row without one). *Supports*: SUDS Server provides the mechanism, record or evidence; the organisation still has to do or decide it, or no check shows it. *Organisation*: outside any software.

### HIPAA Security Rule — administrative safeguards (45 CFR §164.308)

| Standard / implementation specification | Who | How |
| --- | --- | --- |
| (a)(1)(ii)(A) Risk analysis | **Organisation** | Your risk analysis must cover this system; [security/THREAT-MODEL.md](security/THREAT-MODEL.md) and [HIPAA.md](HIPAA.md) (*Risk register notes*) are inputs, not the analysis |
| (a)(1)(ii)(B) Risk management | Supports | Hardened install, pinned and verified software, security updates, the weekly check (`host.*`) |
| (a)(1)(ii)(C) Sanction policy | **Organisation** | Your HR policy; SUDS's audit log is the evidence it acts on |
| (a)(1)(ii)(D) Information system activity review | Supports | Audit log with break-glass, denial and export views; journal kept 400 days; you must review it (monthly: DEPLOYMENT.md §6) |
| (a)(2) Assigned security responsibility | **Organisation** | Name the security official |
| (a)(3) Workforce security (authorisation, clearance, termination) | Supports | Roles and per-user permissions; access requests approved by an administrator; SSO deprovisioning and SCIM (`app.deprovisioning`); clearance is yours |
| (a)(4) Information access management | Supports | Role-based access, caseload scoping, Part 2 consent gates on disclosure (`server/disclosure.js`); who is granted which role, and the access policy, are yours |
| (a)(5) Security awareness and training | **Organisation** | Workforce training; the in-app guidance is not training |
| (a)(5)(ii)(B) Protection from malicious software | Supports | Security updates (`host.security_updates`), read-only code, sandboxed service; endpoint protection on workstations is yours |
| (a)(5)(ii)(C) Log-in monitoring | Supports | Failed sign-ins audited, lockout, rate limits; reviewing them is yours (no compliance check) |
| (a)(5)(ii)(D) Password management | Supports | Policy enforced in code (`app.password_policy`), two-step verification for every role (`app.mfa_required`); the procedures for creating, changing and safeguarding passwords, and training on them, are yours |
| (a)(6) Security incident procedures | Supports | Incident register, automatic drafts on audit failures; the response procedure is yours ([security/INCIDENT-RESPONSE.md](security/INCIDENT-RESPONSE.md) is a template) |
| (a)(7)(ii)(A) Data backup plan | Implements | Scheduled encrypted backups offsite (`app.backups`, `host.backup_files`); the plan document is yours |
| (a)(7)(ii)(B) Disaster recovery plan | Supports | Restore tooling, warm standby pattern (DEPLOYMENT.md 4a); the plan and its approval are yours |
| (a)(7)(ii)(C) Emergency mode operation plan | **Organisation** | Your downtime procedure ([security/BACKUP-AND-DR.md](security/BACKUP-AND-DR.md) lists what SUDS offers) |
| (a)(7)(ii)(D) Testing and revision | Supports | Signed recovery drills, monthly (`host.dr_evidence`) |
| (a)(7)(ii)(E) Applications and data criticality analysis | **Organisation** | |
| (a)(8) Evaluation | Supports | The weekly signed compliance report; a periodic evaluation of the whole programme is yours |
| (b)(1) Business associate contracts | **Organisation** | A BAA with the hosting provider (cloud or county data centre operator) and any service PHI transits; [market/templates/BAA-QSOA-DRAFT.md](market/templates/BAA-QSOA-DRAFT.md) is a starting point for counsel |

### HIPAA Security Rule — physical safeguards (§164.310)

| Standard | Who | How |
| --- | --- | --- |
| (a)(1) Facility access controls | **Organisation** | The data centre or server room |
| (b) Workstation use, (c) Workstation security | **Organisation** | Staff workstations and phones: screen locks, disk encryption, MDM ([INSTALL.md](INSTALL.md)); SUDS signs out after 15 idle minutes |
| (d)(1) Device and media controls | Supports | Server data on LUKS (`host.disk_encryption`), local mode off (`app.local_mode`); disposal and re-use of media are yours |
| (d)(2)(iv) Data backup and storage | Implements | Encrypted backups, offsite copy (`host.backup_files`) |

### HIPAA Security Rule — technical safeguards (§164.312)

| Standard / implementation specification | Who | How |
| --- | --- | --- |
| (a)(1) Access control | Implements | Roles, caseloads, data directory 0700, loopback-only service (`host.data_dir`, `host.bind`) |
| (a)(2)(i) Unique user identification | Supports | Named accounts; no shared or stock administrator; SSO (`app.sso`); issuing one account per person is yours |
| (a)(2)(ii) Emergency access procedure | Supports | Break-glass access, audited; emergency administrator accounts under SSO; the procedure is yours |
| (a)(2)(iii) Automatic logoff | Implements | 15-minute idle timeout (`app.session_timeout`) |
| (a)(2)(iv) Encryption and decryption | Implements | AES-256-GCM on PHI fields, LUKS at rest (`host.disk_encryption`), keys as root-only credentials (`host.keys`) |
| (b) Audit controls | Implements | Hash-chained audit log with WORM anchors, verified weekly by the check (`host.audit_verify`), synchronised clock (`host.time_sync`) |
| (c)(1) Integrity; (c)(2) Mechanism to authenticate ePHI | Implements | The chain, anchors and Ed25519-signed evidence; note signatures (`host.audit_verify`, `app.audit_chain`, `app.audit_anchors`) |
| (d) Person or entity authentication | Implements | Password + TOTP for every role (`app.mfa_required`), or the IdP's MFA, or a passkey with user verification (fingerprint sign-in, `app.passkeys`; needs HTTPS and `WEBAUTHN_RP_ID` matching the domain) |
| (e)(1) Transmission security; (e)(2)(i) Integrity controls; (e)(2)(ii) Encryption | Implements | TLS 1.2+ only, HSTS (`host.tls`, `host.http_redirect`) |

### HIPAA — policies and documentation (§164.316)

| Standard | Who | How |
| --- | --- | --- |
| (a) Policies and procedures | **Organisation** | Write and adopt them; this guide and docs/security/ describe the system they govern |
| (b)(2)(i) Retention (six years) | Supports | Audit log kept 7 years, never under 6 (`app.audit_retention`); compliance reports kept in `/var/lib/suds-compliance` (retain them with your documentation) |

### 42 CFR Part 2 §2.16 — security for records

| Requirement | Who | How |
| --- | --- | --- |
| (a) Formal policies and procedures | **Organisation** | Yours ([compliance/PART2.md](compliance/PART2.md) describes SUDS's Part 2 features) |
| (a)(1) Paper records | **Organisation** | |
| (a)(2)(i) Creating, receiving, maintaining and transmitting electronic records | Supports | Encryption at rest and in transit (`host.disk_encryption`, `host.tls`, `app.phi_key`), consent-checked disclosure with accounting; the programme's formal policies for them are yours |
| (a)(2)(ii) Destroying records and sanitising media | Supports | Record retention and hard deletion (`app.client_retention`), sealed plaintext copies; media sanitisation is yours |
| (a)(2)(iii) Using and accessing electronic records | Implements | Access control, SUD counseling-note restrictions, audit (`host.data_dir`, `host.audit_verify`) |
| (a)(2)(iv) De-identification | Supports | De-identified exports and small-cell suppression; the determination is yours |

**California (CMIA, Civil Code §56.101).** (a): SUDS Server's encryption, access control and retention support preserving confidentiality in creating, storing and destroying records; the organisation's handling is its own. (b)(1)(A): the audit chain and its write-once anchors protect and show the integrity of the record (`host.audit_verify`, `app.audit_anchors`). (b)(1)(B), where the change record is kept: every change or deletion is an entry in the hash-chained audit log — who, when, which record and which fields, never the values (`app.audit_chain`); a client record also keeps every earlier value in its revision history (`client_revisions`, encrypted; the record's History tab); a signed note is never edited, only corrected by an addendum; a deletion is a soft delete with a required reason. **Gap:** for other records (visits, services, referrals and the rest), the audit log records that a field changed, and by whom and when, but not its earlier value. See also [compliance/CALAIM.md](compliance/CALAIM.md) and [HIPAA.md](HIPAA.md).

**Templates and evidence for the organisation's part**: [HIPAA.md](HIPAA.md), [compliance/](compliance/), [security/](security/) (threat model, incident response, data inventory, questionnaire), [market/templates/](market/templates/) (BAA/QSOA and DPA drafts, support SLA), [evidence/README.md](evidence/README.md).

## Operator checklist

What the installer and the compliance check cannot do or see, for the organisation to do and record. Keep the record with the compliance reports.

- [ ] **Test on a real VM first.** Run `install.sh --dry-run`, then for real, on a staging VM of the same image, and an `upgrade.sh` to the next release there, before production. The project tests the scripts against a fake root with stub system commands, and has run `install.sh` and `upgrade.sh` for real on Ubuntu 24.04 in a systemd container ([evidence/installer-container-run-2026-09-30/](evidence/installer-container-run-2026-09-30/README.md); what it found is fixed in 1.20.0); a run on a real VM of each supported distribution, and any run on RHEL 9, is still owed (the runbook: [evidence/INSTALLER-VM-RUN.md](evidence/INSTALLER-VM-RUN.md)).
- [ ] **Cloud security group / perimeter firewall.** Allow SSH (22) only from the administration network there too, and 443 (and 80 for ACME) from where staff connect. The host firewall cannot see or change it.
- [ ] **The LUKS key is not on unencrypted storage.** The data volume's key file (`/etc/crypttab`), if any, lives on the encrypted root disk or in the vTPM/Tang; never on an unencrypted boot partition or a share. Record how the volume is unlocked.
- [ ] **Encrypted swap.** Swap on an encrypted device (or none): memory with PHI and keys can be paged out.
- [ ] **Encrypted offsite share.** The offsite share is encrypted at rest by its own storage, on another host, preferably another site; record where.
- [ ] **WORM verified.** Prove the anchor share is write-once: as the `suds` user, try to overwrite and to delete an anchor file there; both must fail. Record the retention setting of the share.
- [ ] **Key escrow, and a drill with the escrowed copy.** The keys in `/etc/suds/credentials` are in escrow with the named custodian (and deputy); a recovery drill has been run with the escrowed key file against the offsite copy (`host.dr_evidence` passes only then). Repeat after every key rotation.
- [ ] **Remove `keys.json` after a migration.** If the installer carried keys across from a wizard install, `shred -u /var/lib/suds/keys.json` once SUDS runs and the escrow is confirmed (`host.keys` warns until then).
- [ ] **SIEM forwarding.** Forward the journal (`suds`, `caddy`, `suds-compliance`, sshd, sudo) and, if used, `AUDIT_SYSLOG` to the county SIEM for review and retention beyond the journal's.
- [ ] **Release publishers and pin bumps.** Know who can publish SUDS releases (the GitHub repository's maintainers); take each release's checksum from the two channels (the GitHub Release notes and the version's CHANGELOG section on `main`) and check they agree before `--release-sha256`; review each change to `deploy/linux/pins` (Node.js, Caddy and their checksums) in the release's diff before upgrading.
- [ ] **Auditor's public keys.** Give the auditor the evidence signing key and the compliance signing key (`/etc/suds/compliance-signing-key.pub.pem`) with their key ids, taken on the server.
- [ ] **SELinux (RHEL).** Leave it enforcing; the installer relabels what it installs (`restorecon`). If a denial appears (`ausearch -m avc`), fix the label, do not switch SELinux off.
- [ ] **Media sanitisation.** When a disk, VM image, snapshot or backup medium is retired, sanitise it under your policy (§164.310(d)(2)(i); 42 CFR §2.16(a)(2)(ii)); `uninstall.sh` never removes the data or the keys.

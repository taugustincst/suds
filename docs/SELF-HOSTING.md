# SUDS Server: self-hosting guide

This is the guide for the county or CBO IT person who will run SUDS for a programme on a server of their own. **SUDS Server** is the existing SUDS office server, installed hardened by one command on a Linux VM (`deploy/linux/install.sh`), with a compliance check (`npm run compliance-check`) that proves, every week and in a signed report, that the host still matches the hardening policy.

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

## Sizing

SUDS is one Node.js process and one SQLite file ([DEPLOYMENT.md](DEPLOYMENT.md), *Single instance only*): it scales up, not out. The figures below come from [PERFORMANCE.md](PERFORMANCE.md) (a 20,000-client programme is a database of about 100 MB and is served comfortably by 4 vCPUs) with headroom for backups, recovery drills and the OS.

| Staff using it at once | vCPU | RAM | Encrypted data disk | Notes |
| --- | --- | --- | --- | --- |
| up to 25 (most programmes) | 2 | 4 GB | 20 GB | |
| 25 to 75 | 4 | 8 GB | 50 GB | a large programme with years of scanned forms |
| more than 75 | 4–8 | 16 GB | 100 GB | consider one SUDS per programme instead (ADR-0001) |

The data disk holds the database, 14 local backups (the default retention), frequent snapshots if you turn them on (about the database size × `backup_snapshot_retain` on the offsite share), a recovery drill's temporary copy (the database size, briefly) and the compliance reports (kilobytes each). A backup and a drill each need about three times the database size in memory at their peak ([security/BACKUP-AND-DR.md](security/BACKUP-AND-DR.md)). The OS disk needs 10 GB free for the journal (400 days) and the releases kept in `/opt/suds`.

## Prerequisites

Have these before you run the installer. It checks each one and refuses to go on without it.

1. **A VM running Ubuntu 24.04 LTS or RHEL / Rocky / Alma Linux 9**, x86_64, freshly installed, with SSH access for an administrator and outbound HTTPS to `nodejs.org`, `github.com` and the distribution's package mirrors (or the downloads staged by hand: `--node-tarball`, `--caddy-tarball`, `--source`).
2. **A LUKS-encrypted data disk mounted at `/var/lib/suds`.** Encryption at rest cannot be added by an installer after the fact, so it must exist first: attach a second disk, `cryptsetup luksFormat` it (LUKS2), open it at boot (`/etc/crypttab`: a key file on the encrypted root, or the hypervisor's vTPM with `systemd-cryptenroll`, or a network-bound unlock such as Clevis/Tang — whatever your county's standard is), make a filesystem and mount it at `/var/lib/suds` in `/etc/fstab`. On a cloud VM whose disks are encrypted by the platform (EBS with a KMS key, an Azure managed disk with a customer-managed key) the encryption is not visible from inside the VM: layer LUKS on the disk anyway, or pass `--accept-unencrypted-disk="<why>"` — the reason then appears as an **accepted risk** in every compliance report.
3. **A DNS name** for the server (for example `suds.county.gov`) resolving to it; and either ports 80 and 443 reachable for a Let's Encrypt/ACME certificate, or a **certificate and key from the county CA** (`--tls=county-cert`, port 443 only).
4. **A write-once (WORM) share** mounted on the VM for the audit anchors, for example `/mnt/worm/suds-anchors` (NetApp SnapLock, Dell PowerScale SmartLock, Synology WriteOnce, S3 Object Lock through Mountpoint; how, per product: [security/LOGGING-AND-AUDIT.md](security/LOGGING-AND-AUDIT.md), *Pointing AUDIT_ANCHOR_DIR at write-once storage*). Outside `/var/lib/suds`, on different storage. The `suds` user must be able to create files there.
5. **An offsite backup share** mounted on the VM, for example `/mnt/suds-offsite`: on another host, preferably at another site, writable by the `suds` user. Not the anchor share.
6. **A key custodian**: a named person (and a deputy) who will take the keys into escrow the moment the installer generates them, record who holds them, and bring them to the recovery drill. [security/ENCRYPTION-AND-KEYS.md](security/ENCRYPTION-AND-KEYS.md) describes the keys.
7. **The administration network** (a CIDR such as `10.20.0.0/16`) from which SSH will be allowed. Run the installer from inside it, or from the console: the firewall it enables allows SSH from nowhere else.

## Install

On the VM, as root, from an unpacked release (the zip from the GitHub release, checked with `sha256sum -c suds-v<version>.zip.sha256`):

```bash
sudo deploy/linux/install.sh --dry-run \
  --domain=suds.county.gov --admin-cidr=10.20.0.0/16 \
  --offsite=/mnt/suds-offsite --anchors=/mnt/worm/suds-anchors
# read the plan; then the same command without --dry-run
```

With a county certificate: add `--tls=county-cert --cert=/root/suds.county.gov.fullchain.pem --key=/root/suds.county.gov.key`. With Prometheus: add `--metrics` (a `METRICS_TOKEN` credential is generated). Every option: `deploy/linux/install.sh --help`, and [deploy/linux/README.md](../deploy/linux/README.md).

The installer is idempotent: run it again at any time to put a drifted host back. It never replaces a key and never deletes data. `--dry-run` prints every action it would take (`+ ...`) and changes nothing.

It ends by starting SUDS, printing the **key escrow** instruction (do it now; it is your step, not the installer's) and the location of the first administrator's temporary password, and running the compliance check.

## What the installer does, and why

Each step, the control it implements, and where the compliance check verifies it.

| Step | What | Why (control) | Checked by |
| --- | --- | --- | --- |
| Refusals first | Refuses an unsupported OS, a data directory not on dm-crypt/LUKS, anchors or offsite inside the data directory (resolved through `..` and symlinks), shares that are not mount points, an SSH session outside `--admin-cidr` | Nothing half-configured: the controls below depend on these | `host.os`, `host.disk_encryption`, `host.audit_verify`, `host.backup_files` |
| Node.js | The exact release CI tests on (`deploy/linux/pins`, the same pin as `.github/workflows/ci.yml`), downloaded over HTTPS and **checked against its pinned SHA-256 before it is unpacked**; never `curl \| sh`, never a floating package | Integrity of the runtime; patch management (§164.308(a)(1)(ii)(B)) | `host.node` |
| Caddy | The pinned static release, checked against its pinned SHA-512, run as the `caddy` user with only `CAP_NET_BIND_SERVICE`, with the repository's `Caddyfile`: TLS 1.2 and 1.3 only, HSTS for a year, port 80 only redirecting and answering ACME | Transmission security (§164.312(e)(1), (e)(2)(ii); 42 CFR §2.16(a)(2)(i)) | `host.tls`, `host.http_redirect` |
| Code | `/opt/suds/<version>`, root-owned and read-only, behind the `current` symlink | A compromised process cannot rewrite the code it runs | `host.service` |
| Service account and data | The `suds` system user (no shell, no home), `/var/lib/suds` 0700, the database 0600 | Access control (§164.312(a)(1)) | `host.data_dir` |
| Keys | `SUDS_ENCRYPTION_KEY`, `SUDS_INDEX_KEY`, `SUDS_BACKUP_KEY`, `SUDS_SIGNING_KEY` (and `METRICS_TOKEN` with `--metrics`) generated as root-only files in `/etc/suds/credentials` (0600, directory 0700), handed to the service by systemd `LoadCredential=` and read through `*_FILE` (server/config.js): never in an environment file, never in the process environment, never printed or logged. A wizard install's `keys.json` is carried across, never replaced | Encryption and decryption (§164.312(a)(2)(iv)); key custody | `host.keys`, `app.phi_key`, `app.signing_key` |
| The unit | [deploy/linux/suds.service](../deploy/linux/suds.service), unchanged: `ProtectSystem=strict`, `NoNewPrivileges`, no capabilities, a system-call filter, bound to `127.0.0.1:8080`; site paths in a drop-in | Least privilege; SUDS reachable only through the TLS proxy | `host.service`, `host.bind` |
| Production settings | `LOCAL_MODE_ENABLED=false`; two-step verification for every role; `TRUST_PROXY=1` for Caddy; `AUDIT_ANCHOR_DIR` on the WORM share; and, through `SUDS_PROVISION_FILE`, scheduled backups every 4 hours to the offsite share, the monthly recovery drill, "require two-step verification for every role" (applied only where nobody has chosen yet; change them later under Settings) | Person authentication (§164.312(d)); device and media controls (§164.310(d)(1)); data backup plan (§164.308(a)(7)(ii)(A)) | `app.mfa_required`, `app.local_mode`, `app.backups`, `app.offsite` |
| Firewall | ufw (Ubuntu) or firewalld (RHEL): deny incoming, allow 443 (and 80 with ACME), SSH only from `--admin-cidr` | Network access control | `host.firewall` |
| Time | systemd-timesyncd (Ubuntu) or chrony (RHEL), NTP on | Audit timestamps are only evidence if the clock is right (§164.312(b)) | `host.time_sync` |
| Updates | unattended-upgrades with the `-security` origin (Ubuntu) or dnf-automatic with `upgrade_type = security` (RHEL) | Protection from malicious software, patching (§164.308(a)(5)(ii)(B)) | `host.security_updates` |
| Journal | `Storage=persistent`, `MaxRetentionSec` = `--log-retention-days` (default 400 days; the audit log itself is kept 7 years in the database) | Information system activity review (§164.308(a)(1)(ii)(D)) | `host.journald` |
| auditd | Recommended, not installed: the OS's own record of logins, sudo and changes to `/etc/suds` | Audit controls at the OS layer | `host.auditd` (a warning when absent) |
| Weekly check | `suds-compliance.timer` runs the compliance check weekly; reports kept in `/var/lib/suds/compliance` | Evaluation (§164.308(a)(8)) | Settings → Security status |

## After the install

1. **Escrow the keys** as the installer told you, before anything else. Without them no backup can be restored.
2. Read the temporary password once (`sudo cat /var/lib/suds/first-admin-password.txt`), sign in at `https://<domain>`, change it and enrol two-step verification.
3. Download the **signing public key** (Settings → Security status → *Download signing public key*) and give it, with its key id, to your auditor. They verify every recovery-drill report, audit export and compliance report with it.
4. Configure single sign-on if the county has an identity provider ([DEPLOYMENT.md](DEPLOYMENT.md), *Single sign-on*): set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI` in `/etc/suds/suds.env` and the client secret as a credential (`/etc/suds/credentials/oidc_client_secret`, a `LoadCredential=oidc_client_secret:…` line and `Environment=OIDC_CLIENT_SECRET_FILE=%d/oidc_client_secret` in a drop-in), then `systemctl restart suds`.
5. Run a **recovery drill with the escrowed key file** against the offsite copy (Settings → System & backups). The compliance check asks for one within 90 days.
6. Remove `keys.json` from `/var/lib/suds` if the installer carried keys across from a wizard install (`shred -u`), once the escrow is confirmed.
7. Check Settings → Security status: the *Host (last compliance check)* section shows the installer's run.

## Upgrading

```bash
sudo /opt/suds/current/deploy/linux/upgrade.sh 1.18.0            # from the GitHub release, checked against its .sha256
sudo /opt/suds/current/deploy/linux/upgrade.sh 1.18.0 --source=/root/suds-v1.18.0.zip --release-sha256=<from the release page>
```

It follows `scripts/update.js`'s rule (back up first, and never leave the service on code that has not been proven) for a packaged install: stage and verify the release (and its pinned Node.js), **stop SUDS**, take an encrypted backup as the `suds` user with the service's own credentials, switch `current` (and `node`) and the units, start, and wait for `/api/health/ready` (migrations run here; SUDS also snapshots the database before migrating). If it does not become ready it **rolls back**: the previous code, Node and units, and the database restored from the backup just taken. It never downgrades. `--dry-run` prints the plan. Remove old releases from `/opt/suds` when you no longer need to roll back to them. `deploy/linux/uninstall.sh` removes the software and never the data or keys.

## Backup and restore

Backups are the app's own ([security/BACKUP-AND-DR.md](security/BACKUP-AND-DR.md)): every 4 hours (provisioned by the installer), encrypted with `SUDS_BACKUP_KEY`, read back after writing, 14 kept in `/var/lib/suds/backups` and each copied to the offsite share; an audit anchor is written with each. Turn on 15-minute snapshots under Settings → Scheduled backups for a recovery point in minutes.

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

- Point the county's monitoring at `https://<domain>/api/health` (503 means an operator must act: a failed audit check, stale backups, an expiring certificate, low disk) — never as a liveness probe ([DEPLOYMENT.md](DEPLOYMENT.md), 4b).
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

Run as root for every check; as the `suds` user the root-only checks say *could not check*, which is never counted as a pass. Weekly from `suds-compliance.timer`. It writes a JSON and a self-contained HTML report, both signed with the server's Ed25519 evidence signing key (the key that signs drill reports and audit exports), so an auditor verifies them with the public key alone; the HTML verifier also re-renders the page and fails if what it shows was edited. Settings → Security status shows the app-level checks live (the same code) and the host checks as the last report found them, with its date; the server records each new report in the audit log (`security.compliance_report.generated`), and each view or download (`security.compliance_report.view`, `GET /api/admin/security/compliance-report`, `settings:manage`). Exit status: 1 if any check failed; `--strict` also exits 2 on a warning or a *could not check*.

| Check | What is observed | Rules |
| --- | --- | --- |
| `host.os` | `/etc/os-release` is a supported release | §164.308(a)(1)(ii)(B) |
| `host.data_dir` | `/var/lib/suds` 0700 owned by `suds`; `suds.db`, `-wal`, `-shm`, `keys.json` 0600 | §164.312(a)(1); 42 CFR §2.16(a)(2)(iii); Cal. Civ. Code §56.101(a) |
| `host.disk_encryption` | the data directory's device chain (`findmnt`, `lsblk -s`) has a dm-crypt layer; `cryptsetup status` type LUKS | §164.312(a)(2)(iv); §164.310(d)(1); 42 CFR §2.16(a)(2)(i); §56.101(a) |
| `host.keys` | credentials 0600/0700 root; no secret in the unit's `Environment=`, in any `EnvironmentFile=`, or in the running process's environment; `LoadCredential=` present | §164.312(a)(2)(iv); §164.312(a)(1) |
| `host.service` | the effective unit settings (`systemctl show`): the sandbox as shipped, active, enabled | §164.312(a)(1); §164.308(a)(1)(ii)(B) |
| `host.tls` | a `node:tls` connection to the domain: TLS 1.2+ negotiated, TLS 1.0/1.1 refused, certificate valid more than 14 days and naming the domain, HSTS header | §164.312(e)(1); §164.312(e)(2)(ii); 42 CFR §2.16(a)(2)(i) |
| `host.http_redirect` | port 80 only redirects to https (or is closed) | §164.312(e)(1) |
| `host.bind` | `/proc/net/tcp{,6}`: SUDS listens on loopback only | §164.312(e)(1); §164.312(a)(1) |
| `host.firewall` | ufw / firewalld active, default deny, only 443 (80) and SSH from the admin network | §164.312(e)(1); §164.308(a)(1)(ii)(B) |
| `host.time_sync` | `timedatectl`: synchronised; `chronyc tracking` / timesyncd offset under 1 s | §164.312(b); §56.101(b)(1)(B) |
| `host.security_updates` | unattended-upgrades `-security` + timer, or dnf-automatic `upgrade_type = security`, applied | §164.308(a)(5)(ii)(B); §164.308(a)(1)(ii)(B) |
| `host.journald` | persistent, `MaxRetentionSec` at least the policy | §164.312(b); §164.308(a)(1)(ii)(D) |
| `host.auditd` | auditd active (a warning if not: recommended) | §164.312(b); §164.308(a)(1)(ii)(D) |
| `host.node` | the Node the unit runs is the pinned release | §164.308(a)(1)(ii)(B) |
| `host.suds_version` | the release is supported (docs/RELEASE.md, *Supported versions*), against the release feed (`UPDATE_FEED_URL`) or `--latest-version`; *could not check* without either | §164.308(a)(1)(ii)(B); §164.308(a)(5)(ii)(B) |
| `host.backup_files` | the newest backup file locally and on the offsite share is younger than twice the interval | §164.308(a)(7)(ii)(A); §164.310(d)(2)(iv) |
| `host.dr_evidence` | the last drill passed within 90 days and its signed report verifies with the signing key | §164.308(a)(7)(ii)(D); §164.308(a)(7)(ii)(B) |
| `host.audit_verify` | the audit hash chain (server/audit.js) and the external anchors (server/audit-anchor.js) verified now; anchors configured outside the data directory | §164.312(b); §164.312(c)(1), (c)(2); §56.101(b)(1)(B); 42 CFR §2.16(a)(2)(iii) |
| `app.*` | every line of Settings → Security status: MFA required for every role and its coverage, SSO, deprovisioning, password policy, session timeout, backups, RPO, offsite, drills, plaintext copies, backup key, audit chain and anchors, audit retention, keys, record retention, HTTPS, local mode, monitoring | as listed in `server/compliance-rules.js` |

**What it cannot automate, and why.** It cannot see encryption done beneath the VM (a SAN's or cloud platform's disk encryption), a firewall outside the host (a cloud security group, a county perimeter firewall), whether the WORM share is actually write-once (only that anchors verify and are outside the data directory), whether the keys are really in escrow and who holds them, whether the offsite share is at another site, or anything about people, paper and premises. Those are recorded by the organisation (next section); the report's *scope* says so.

## Compliance boundary

**No software makes an organisation compliant on its own.** HIPAA's Security Rule and 42 CFR Part 2 bind the covered entity or Part 2 programme — its policies, people, premises and contracts as well as its systems. SUDS Server **implements** the technical safeguards it can, **supports** others with evidence and tooling, and leaves the rest to the organisation, with templates where we have them. It holds no SOC 2, ISO 27001, HITRUST, StateRAMP or FedRAMP attestation ([security/SOC2-READINESS.md](security/SOC2-READINESS.md)).

*Implements*: SUDS Server does it, and the compliance check shows it. *Supports*: SUDS Server provides the mechanism, record or evidence; the organisation still has to do or decide it. *Organisation*: outside any software.

### HIPAA Security Rule — administrative safeguards (45 CFR §164.308)

| Standard / implementation specification | Who | How |
| --- | --- | --- |
| (a)(1)(ii)(A) Risk analysis | **Organisation** | Your risk analysis must cover this system; [security/THREAT-MODEL.md](security/THREAT-MODEL.md) and [HIPAA.md](HIPAA.md) (*Risk register notes*) are inputs, not the analysis |
| (a)(1)(ii)(B) Risk management | Supports | Hardened install, pinned and verified software, security updates, the weekly check (`host.*`) |
| (a)(1)(ii)(C) Sanction policy | **Organisation** | Your HR policy; SUDS's audit log is the evidence it acts on |
| (a)(1)(ii)(D) Information system activity review | Supports | Audit log with break-glass, denial and export views; journal kept 400 days; you must review it (monthly: DEPLOYMENT.md §6) |
| (a)(2) Assigned security responsibility | **Organisation** | Name the security official |
| (a)(3) Workforce security (authorisation, clearance, termination) | Supports | Roles and per-user permissions; access requests approved by an administrator; SSO deprovisioning and SCIM (`app.deprovisioning`); clearance is yours |
| (a)(4) Information access management | Implements | Role-based access, caseload scoping, Part 2 consent gates on disclosure (`server/disclosure.js`) |
| (a)(5) Security awareness and training | **Organisation** | Workforce training; the in-app guidance is not training |
| (a)(5)(ii)(B) Protection from malicious software | Supports | Security updates (`host.security_updates`), read-only code, sandboxed service; endpoint protection on workstations is yours |
| (a)(5)(ii)(C) Log-in monitoring | Implements | Failed sign-ins audited, lockout, rate limits |
| (a)(5)(ii)(D) Password management | Implements | Policy enforced in code (`app.password_policy`), two-step verification for every role |
| (a)(6) Security incident procedures | Supports | Incident register, automatic drafts on audit failures; the response procedure is yours ([security/INCIDENT-RESPONSE.md](security/INCIDENT-RESPONSE.md) is a template) |
| (a)(7)(ii)(A) Data backup plan | Implements | Scheduled encrypted backups offsite (`app.backups`, `host.backup_files`) |
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
| (a)(2)(i) Unique user identification | Implements | Named accounts; no shared or stock administrator; SSO |
| (a)(2)(ii) Emergency access procedure | Supports | Break-glass access, audited; emergency administrator accounts under SSO; the procedure is yours |
| (a)(2)(iii) Automatic logoff | Implements | 15-minute idle timeout (`app.session_timeout`) |
| (a)(2)(iv) Encryption and decryption | Implements | AES-256-GCM on PHI fields, LUKS at rest (`host.disk_encryption`), keys as root-only credentials (`host.keys`) |
| (b) Audit controls | Implements | Hash-chained audit log with WORM anchors, verified weekly by the check (`host.audit_verify`), synchronised clock (`host.time_sync`) |
| (c)(1) Integrity; (c)(2) Mechanism to authenticate ePHI | Implements | The chain, anchors and Ed25519-signed evidence; note signatures |
| (d) Person or entity authentication | Implements | Password + TOTP for every role (`app.mfa_required`), or the IdP's MFA |
| (e)(1) Transmission security; (e)(2)(i) Integrity controls; (e)(2)(ii) Encryption | Implements | TLS 1.2+ only, HSTS (`host.tls`, `host.http_redirect`) |

### HIPAA — policies and documentation (§164.316)

| Standard | Who | How |
| --- | --- | --- |
| (a) Policies and procedures | **Organisation** | Write and adopt them; this guide and docs/security/ describe the system they govern |
| (b)(2)(i) Retention (six years) | Supports | Audit log kept 7 years, never under 6 (`app.audit_retention`); compliance reports kept in `/var/lib/suds/compliance` (retain them with your documentation) |

### 42 CFR Part 2 §2.16 — security for records

| Requirement | Who | How |
| --- | --- | --- |
| (a) Formal policies and procedures | **Organisation** | Yours ([compliance/PART2.md](compliance/PART2.md) describes SUDS's Part 2 features) |
| (a)(1) Paper records | **Organisation** | |
| (a)(2)(i) Creating, receiving, maintaining and transmitting electronic records | Implements | Encryption at rest and in transit, consent-checked disclosure with accounting |
| (a)(2)(ii) Destroying records and sanitising media | Supports | Record retention and hard deletion (`app.client_retention`), sealed plaintext copies; media sanitisation is yours |
| (a)(2)(iii) Using and accessing electronic records | Implements | Access control, SUD counseling-note restrictions, audit |
| (a)(2)(iv) De-identification | Supports | De-identified exports and small-cell suppression; the determination is yours |

**California (CMIA, Civil Code §56.101).** (a): SUDS Server's encryption, access control and retention support preserving confidentiality in creating, storing and destroying records; the organisation's handling is its own. (b)(1)(A)–(B): the audit log records every change with who and when, hash-chained and anchored (`host.audit_verify`). See also [compliance/CALAIM.md](compliance/CALAIM.md) and [HIPAA.md](HIPAA.md).

**Templates and evidence for the organisation's part**: [HIPAA.md](HIPAA.md), [compliance/](compliance/), [security/](security/) (threat model, incident response, data inventory, questionnaire), [market/templates/](market/templates/) (BAA/QSOA and DPA drafts, support SLA), [evidence/README.md](evidence/README.md).

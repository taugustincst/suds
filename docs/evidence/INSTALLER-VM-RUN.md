# Installer run on real VMs — runbook (owner-pending)

**Status: owner-pending.** SUDS Server's installer (`deploy/linux/install.sh`) and upgrader (`upgrade.sh`) are
tested against a fake root with stub system commands (`test/deploy-linux.test.js`, `test/deploy-linux-real.test.js`)
and were run for real on Ubuntu 24.04 **inside a systemd container** on 2026-09-30
([installer-container-run-2026-09-30/](installer-container-run-2026-09-30/README.md)). They have **not** been run on
a virtual machine, and **not at all on RHEL 9** (the sandbox could reach no RHEL-family package mirror). A
development sandbox cannot give a VM, so this run is for the owner or an IT partner. It takes about two hours per VM.

Do it once on a fresh **Ubuntu 24.04 LTS** VM and once on a fresh **RHEL 9** VM (Rocky or Alma 9 are acceptable
stand-ins; say which). Use **the latest release** (below, `<v>`: 1.20.0 when this was written) and, for the upgrade
step, the release before it (`<prev>`: 1.19.0). Record everything as below and commit it back (last section). Nothing here needs a real
client record: use a test domain and fictional data only.

## What you need, per VM

| Item | For this run |
| --- | --- |
| VM | x86_64, 2 vCPU, 4 GB RAM, 20 GB OS disk, a **second 20 GB disk** for the data; freshly installed from the distribution's own image; console access (hypervisor console or cloud serial console) as well as SSH |
| Network | outbound HTTPS to `nodejs.org`, `github.com` and the distribution's mirrors; an admin network CIDR you SSH from (e.g. `10.20.0.0/16`) and one machine **outside** it, to test the firewall |
| Name and certificate | a DNS name (e.g. `suds-test.county.gov`) resolving to the VM, and either ports 80/443 reachable for ACME (`--tls=caddy`) or a certificate, key and CA from the county CA (`--tls=county-cert`) |
| Shares | an NFS or SMB **offsite** share on another host, and a **WORM** share for audit anchors (SnapLock, SmartLock, Synology WriteOnce, S3 Object Lock via Mountpoint), both mountable on the VM |
| Time | the county NTP server(s) |
| Release | `suds-v<v>.zip` and its SHA-256 **from two channels that agree**: the GitHub release notes and the version's CHANGELOG section on `main` ([../RELEASE.md](../RELEASE.md), *The zip's SHA-256 in two places*). While the release is untagged, rebuild it from its commit with `git archive` and take the SHA-256 from [RELEASE-HANDOFF.md](RELEASE-HANDOFF.md) (1.20.0: `git archive --format=zip --prefix=suds-v1.20.0/ -o suds-v1.20.0.zip 8f365b4` gives `048e928499fa3569dfcfc59af86633ad4f8176d3bba1c0dd2fe61b62c35fb9ff`); record that this is how it was obtained. For the upgrade step, `suds-v<prev>.zip` likewise (1.19.0, `3dc20dc`: `c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed`) |
| People | the person running it, and a key custodian to take the generated keys into escrow |

Capture every command's output: run each step below inside `script`, for example
`sudo script -q -a /root/suds-vm-run.txt`, and `exit` at the end. Every block below says what to expect; note any
difference in the README you commit.

## 1. Record the VM

```bash
cat /etc/os-release; uname -r; systemctl --version | head -1; lsblk -f; timedatectl; getenforce 2>/dev/null
```

Expect: the distribution and version you meant; systemd ≥ 250 (Ubuntu 255, RHEL 252); on RHEL `Enforcing`.

## 2. LUKS data disk at /var/lib/suds

```bash
cryptsetup luksFormat --type luks2 /dev/<data-disk>       # type YES, choose a passphrase you escrow
cryptsetup open /dev/<data-disk> suds-data
mkfs.ext4 /dev/mapper/suds-data
mkdir -p /var/lib/suds
echo "suds-data UUID=$(blkid -s UUID -o value /dev/<data-disk>) none luks" >> /etc/crypttab   # or your county's unlock (vTPM, Tang)
echo "/dev/mapper/suds-data /var/lib/suds ext4 defaults 0 2" >> /etc/fstab
mount /var/lib/suds && findmnt -o TARGET,SOURCE,FSTYPE /var/lib/suds && lsblk -o NAME,TYPE,FSTYPE
```

Expect: `/var/lib/suds  /dev/mapper/suds-data  ext4`, and `lsblk` shows the disk as `crypto_LUKS` with a `crypt`
child. (The installer checks this; do **not** pass `--accept-unencrypted-disk` on this run.)

## 3. Shares, and the suds user first

The installer refuses a share the `suds` user cannot write, and creates that user itself, so create it first (the
same command the installer runs) and give it the shares (the container run needed three installer runs without
this: [finding 2](installer-container-run-2026-09-30/README.md#findings-for-the-owner-no-change-made-here)).

```bash
useradd --system --user-group --home-dir /var/lib/suds --no-create-home --shell /usr/sbin/nologin suds
mkdir -p /mnt/suds-offsite /mnt/worm/suds-anchors
# mount both shares (and add them to /etc/fstab), then on each share's server or here:
chown suds:suds /mnt/suds-offsite /mnt/worm/suds-anchors && chmod 0750 /mnt/suds-offsite /mnt/worm/suds-anchors
findmnt /mnt/suds-offsite; findmnt /mnt/worm/suds-anchors
```

Expect: both are mount points from other hosts (`SOURCE` is `host:/export`, `//host/share` or similar).

## 4. The release, checked

```bash
cd /root && sha256sum suds-v<v>.zip      # must equal the value from BOTH channels
unzip -q suds-v<v>.zip && cd suds-v<v>
```

## 5. Dry run

```bash
deploy/linux/install.sh --dry-run --domain=<name> --admin-cidr=<cidr> \
  --offsite=/mnt/suds-offsite --anchors=/mnt/worm/suds-anchors \
  [--tls=county-cert --cert=<pem> --key=<pem> --ca-file=<county CA pem>] \
  --ntp-server=<county ntp> --source=/root/suds-v<v>.zip --release-sha256=<hex>
```

Expect, exit 0: `SUDS Server installer — SUDS <v> (dry run: nothing is changed)`; under *Checking the host* the
OS and family (`debian` or `rhel`) and `data volume: /var/lib is on crypto_LUKS …` (no unencrypted-disk warning);
`suds-v<v>.zip: sha256 matches the pinned checksum`; then the planned actions (`+ …`) for packages, Node.js,
Caddy, the service account, keys, configuration, firewall (`ufw` or `firewall-cmd`), time (`systemd-timesyncd`,
`chrony` or `chronyd`), security updates (`unattended-upgrades` or `dnf-automatic`), the journal and the units.
On RHEL, a `restorecon` line.

## 6. The install

The same command without `--dry-run`. Expect, exit 0 in a minute or two:

* each section as in the dry run, now done; `Caddy answers v2.10.2`;
* `== Keys ==`: the four keys generated, and the **escrow instruction**: do it now, with the custodian;
* `== Firewall ==`: SSH only from `<cidr>`, 443 (and 80 with ACME);
* `== Services ==`: `SUDS is up on 127.0.0.1:8080, served at https://<name>`, and where the first administrator's
  temporary password is;
* `== Compliance check ==`: the report, `Signed (Ed25519 …, key id …)` and `Wrote /var/lib/suds-compliance/compliance-<stamp>.json`.

Day one (SELF-HOSTING.md, *Day one*; since 1.20.0): the installer runs the first backup and recovery drill once SUDS
is up, so the first report normally shows both as done; `host.dr_evidence` still **warns** until a drill has used the
escrowed key file (step 9), and a backup or drill that could not run yet is *pending first run*, a **warning**, not a
failure. `app.passkeys` should **pass**: the installer writes `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` from
`--domain`. `app.mfa_coverage`, `app.sso`, `app.deprovisioning`, `app.audit_chain`,
`app.audit_anchors`, `host.audit_verify`, `host.auditd` warn. Everything else should **pass** — in particular
`host.os`, `host.disk_encryption`, `host.keys`, `host.service`, `host.tls`, `host.http_redirect`, `host.bind`,
`host.firewall`, `host.time_sync`, `host.security_updates`, `host.journald`, `host.node`, `host.release_integrity`.
A failure in that list is a finding: record it with the report.

## 7. Idempotence

Run the same command again. Expect exit 0, every key `exists: kept (keys are never regenerated)`, `SUDS <v>
already at /opt/suds/<v>`, and `grep CHECKSUM /etc/suds/suds-server.conf` → `SUDS_RELEASE_CHECKSUM_SOURCE=operator`.

## 8. After the install (SELF-HOSTING.md, *After the install*)

```bash
cat /var/lib/suds/first-admin-password.txt        # once; sign in at https://<name>, change it, enrol TOTP
grep WEBAUTHN /etc/suds/suds.env                  # WEBAUTHN_RP_ID=<name> and WEBAUTHN_ORIGINS=https://<name>, from --domain
curl -sS https://<name>/api/health; curl -sSI http://<name>/ | head -1
```

Expect: sign-in over HTTPS works, the password change and TOTP enrolment succeed; `/api/health` answers with
`"database":"ok"` and `"ok":true` (on day one with a pending-first-backup warning if the installer's backup could not run); `http://` answers
`308` (or 301) to `https://`. In a browser with a fingerprint reader or security key, add a passkey under My
profile → Fingerprint sign-in, sign out and sign in with it.

## 9. Backup and recovery drill with the escrowed keys, against the offsite copy

Wait for the first scheduled backup (within 4 h; `ls /mnt/suds-offsite`), or take one now, then run the drill with
the escrowed key file (the custodian's copy, as `SUDS_ENCRYPTION_KEY=…` lines or the `keys.json` from *Download
key backup*): Settings → System & backups → *Run a recovery drill now* with the key file, or from the shell:

```bash
U='systemd-run --wait --pipe --collect --unit=suds-ops --uid=suds --gid=suds --working-directory=/opt/suds/current
  -p EnvironmentFile=/etc/suds/suds.env -E SUDS_ENV=production -E SUDS_DATA_DIR=/var/lib/suds
  -p LoadCredential=suds_encryption_key:/etc/suds/credentials/suds_encryption_key
  -p LoadCredential=suds_index_key:/etc/suds/credentials/suds_index_key
  -p LoadCredential=suds_backup_key:/etc/suds/credentials/suds_backup_key
  -p LoadCredential=suds_signing_key:/etc/suds/credentials/suds_signing_key
  -p LoadCredential=escrow:/root/escrowed-keys.env -p ReadWritePaths=/mnt/suds-offsite -p ReadWritePaths=/mnt/worm/suds-anchors'
$U /opt/suds/node/bin/node scripts/backup.js /mnt/suds-offsite
$U /opt/suds/node/bin/node scripts/dr-drill.js --offsite --keys-file /run/credentials/suds-ops.service/escrow
shred -u /root/escrowed-keys.env
```

Expect: `SUDS disaster-recovery drill — PASSED`, `Backup restored: … — the offsite copy in /mnt/suds-offsite`,
`Keys used: escrow file`, **11 of 11** `[PASS]`, the RTO and RPO against their targets, and
`Report: /var/lib/suds/backups/dr-drill-<stamp>.json`. Download the evidence signing public key (Settings → Security
status → *Download signing public key*) and verify on another machine:
`npm run verify-dr-report -- dr-drill-<stamp>.json --public-key suds-signing-key.pem` → `VERIFIED`.

## 10. The WORM share, the firewall and a reboot

```bash
f=$(ls /mnt/worm/suds-anchors | head -1)
sudo -u suds sh -c "echo x >> /mnt/worm/suds-anchors/$f"; echo "append exit $?"     # must fail
sudo -u suds rm -f "/mnt/worm/suds-anchors/$f"; echo "delete exit $?"               # must fail
```

From the machine **outside** the admin network: `nc -zv -w5 <vm> 22` must time out or be refused; `nc -zv <vm> 443`
must connect. Then `systemctl reboot`; after it (and the data disk's unlock: automatic with a key file on the
encrypted root, vTPM or Tang; typed at the console with a passphrase — record which), without logging in,
`https://<name>/api/health` answers; then `systemctl is-active suds caddy suds-compliance.timer` → `active` ×3 and
`findmnt /var/lib/suds` is the LUKS mapping.

## 11. Upgrade (and, optionally, rollback)

On a second fresh VM of the same image (or a snapshot taken before step 6), install **`<prev>`** exactly as in steps
2–6 from `suds-v<prev>.zip`, sign in once and create a test client and a signed note, then:

```bash
/opt/suds/current/deploy/linux/upgrade.sh <v> --source=/root/suds-v<v>.zip --release-sha256=<hex>
```

Expect, exit 0: *1. Stage `<v>`* (checksum matches), *2-3. Stop SUDS and take a backup* (`Encrypted backup written:
/var/lib/suds/backups/pre-upgrade-<stamp>/…`), *4. Switch to `<v>`*, *5. Start and check* (`SUDS <v> is ready`),
the compliance report, `Upgraded to <v>`. Then `ls /var/lib/suds/pre-migration` shows `suds.db.v<N>.<stamp>.db.enc`
(`<N>` the schema `<prev>` left: 59 for 1.19.0, which 1.20.0's migration 60 upgrades), and `grep WEBAUTHN
/etc/suds/suds.env` shows the two lines `upgrade.sh` adds when they were missing;
the test client and note are there and the note's signature shows as intact. Optional rollback: repeat on a fresh
`<prev>` snapshot with `--ready-timeout=1`; expect the rollback messages, `readlink /opt/suds/current` → `<prev>`,
and SUDS serving the `<prev>` database again.

## 12. The compliance report to collect

```bash
systemctl start suds-compliance        # the unit ends "failed" when the report's result is FAIL; that is by design
ls -t /var/lib/suds-compliance | head -2
```

Collect the newest `compliance-<stamp>.json` and `.html` and `/etc/suds/compliance-signing-key.pub.pem`, and on
another machine: `npm run verify-compliance-report -- compliance-<stamp>.json --public-key compliance-signing-key.pub.pem`
→ `VERIFIED`. After steps 8–10 the expected state is: every `host.*` and `app.*` check **passes** except warnings you
can explain (`host.auditd` if auditd is not installed, `app.sso`/`app.deprovisioning` without an identity
provider, `app.mfa_coverage` for accounts not yet enrolled) and a *pending first run* warning while a first backup
or drill has not run. Record every fail and could-not-check with its reason.

## What to commit back

A folder `docs/evidence/installer-vm-run-<date>/<ubuntu-24.04|rhel-9>/` per VM, on a branch, with:

* `README.md`: who ran it and when; the hypervisor or cloud and the VM image (name, version, date); the release zip's
  SHA-256 and the two channels it was checked against; each step above with its outcome (PASS, or what differed and
  why); the drill's RTO and RPO; the compliance counts; what could not be done;
* `transcript.txt`: the `script` capture (read it first and remove anything secret: it must not contain the
  temporary password, a key or a passphrase);
* `compliance-<stamp>.json` and `.html` (the last report), and `compliance-signing-key.pub.pem`;
* `dr-drill-<stamp>.json` and `.txt` (step 9) and `suds-signing-key.pem` (the evidence signing **public** key);
* for the upgrade VM, the upgrade transcript and its compliance report.

**Never commit** anything from `/etc/suds/credentials`, `/etc/suds/compliance-signing-key`, the escrowed key
file, the LUKS passphrase or key file, the TLS private key, `first-admin-password.txt`, the database, backups or
snapshots.

Then, in the same change: list the folder in [README.md](README.md) (*Artefacts in this folder*) and remove this
item from *Owner-pending* there and from HANDOFF.md; tick *Test on a real VM first* in
[../SELF-HOSTING.md](../SELF-HOSTING.md), *Operator checklist*, for that distribution; and raise any failure as an
issue.

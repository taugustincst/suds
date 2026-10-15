# Drill tenant runbook: prove the hosted fleet before the first customer

**What this is.** The step-by-step run of the drill tenant (`drill.suds.systems`) that [README.md](README.md),
*The drill tenant*, outlines: one real Lightsail tenant, provisioned, used with fictional records, recovered, upgraded
and destroyed, with the evidence written down. Hosting is in every published plan (owner decision of 2026-10-12), but
the fleet tooling has only ever run against stand-ins, so **no customer's real record goes onto a hosted instance until
this drill has passed** ([../../docs/market/HOSTING.md](../../docs/market/HOSTING.md)).

**What a pass proves, and what it closes:**

| Proves | Closes (where it is recorded as open) |
| --- | --- |
| `provision-tenant.sh --apply` builds a tenant against real AWS, Porkbun and DNS, and every assert passes | "the fleet tooling is tested against stand-ins only" (QUESTIONNAIRE #2, HOSTING.md, this folder's README) |
| The LUKS data volume unlocks unattended after a reboot, and the service waits for it | the fleet's version of the 2026-10-11 reboot test |
| The escrowed keys, opened with the owner's offline key, decrypt the offsite backup in a recovery drill | "the escrowed-key drill is unproven" (`host.dr_evidence`; the business work plan) |
| A data-disk snapshot opens with the escrowed LUKS key (optional stage G) | "a snapshot restore has never been proven" |
| `upgrade.sh` moves a fleet tenant to the next release and the re-run asserts pass (stage H) | the fleet's upgrade path, never run |
| `decommission-tenant.sh` leaves nothing behind | teardown, never run |

**Who and how long.** The **operator** (the owner's business assistant, or the owner) runs every command. The
**owner** supplies the credentials, holds the escrow key's private half, and gives the go at the two gates (*Gate 1*
before anything is created, *Gate 2* before anything is destroyed). About half a day; stage H waits for a second
release. **Cost:** Lightsail bills by the hour. The `medium_3_0` plan (about $24 a month) and 104 GB of block disks
(about $10 a month) come to a few dollars for a drill destroyed the same week; leaving it running costs about $35 a
month.

**Rules for the whole drill.** Fictional data only: nothing typed into the drill tenant is about a real person.
Everything that names the operator's networks, a key, a credential or the register stays in `FLEET_HOME` (the private
ops directory), never in this repository or in a public note. Stop at any **ABORT** line and write down why.

## 0. Before the day (owner)

1. The private ops directory, the AWS profile (Lightsail only, with MFA), the Lightsail key pair in `us-west-2`, the
   Porkbun API key with API access on `suds.systems`, and the escrow gpg key: [README.md](README.md), *Prerequisites*,
   steps 1–4. Confirm that the AWS account is **AugustInnovations LLC's** and that its AWS BAA is accepted in AWS
   Artifact; write the account's alias (not its number) in the ops record.
2. The release: the newest released version **before** the newest (so stage H has something to upgrade to). Today
   that is **1.25.7** (`v1.25.7`, zip SHA-256
   `ae11609a7f9b8896d88e89c828d7acfed4d3d3fe6d72f3202c9a079f2dd2d96f`, in its Release notes and in the CHANGELOG on
   `main`; they must agree). Download `suds-v1.25.7.zip` from the GitHub Release into `FLEET_HOME/releases/` and check
   it: `sha256sum releases/suds-v1.25.7.zip`.
3. Decide the drill's date, and that the operator runs it from a network whose address goes in `ADMIN_CIDR`
   (`curl -4 https://checkip.amazonaws.com`) and whose IPv6 network goes in `ADMIN_CIDR6`. Both are required (the
   scripts refuse a settings file without `ADMIN_CIDR6`). An operator with no IPv6 address, such as AWS CloudShell, sets
   a network from the documentation prefix `2001:db8::/32` (for example `2001:db8:1::/48`): it is never routed, so SSH
   over IPv6 stays closed.

## 1. Go / no-go (operator, with the owner) — Gate 1

All must be yes before `--apply`:

- [ ] `FLEET_HOME` exists, mode 0700, is a git repository, and is **not** inside any SUDS clone.
- [ ] `aws sts get-caller-identity --profile suds-fleet` answers with the operator's role in the LLC's account.
- [ ] `gpg --list-keys <ESCROW_GPG_RECIPIENT>` shows the owner's escrow key; its private half is **not** on the
      operator's machine.
- [ ] `credentials/porkbun.env` and `keys/suds-fleet.pem` are mode 0600.
- [ ] The release zip's SHA-256 equals the value in its Release notes and its CHANGELOG section.
- [ ] `https://dns.google/resolve?name=drill.suds.systems&type=A` has no answer (no leftover record).
- [ ] The owner has said go, today, for this drill.

**ABORT** if any is no.

## A. Settings and dry run

```bash
export FLEET_HOME=~/suds-ops AWS_PROFILE=suds-fleet
cp deploy/fleet/tenant.env.example "$FLEET_HOME/tenants/drill.env"
```

Edit `tenants/drill.env`: `TENANT_SLUG=drill`, `TENANT_DOMAIN=` (empty: `drill.suds.systems`), `WWW_REDIRECT=yes`,
`ADMIN_CIDR` / `ADMIN_CIDR6` (from step 0.3), `SUDS_VERSION=1.25.7`, `RELEASE_SHA256=` the value above,
`RELEASE_ZIP=releases/suds-v1.25.7.zip`, `ESCROW_GPG_RECIPIENT=` the 40-hex fingerprint. Leave the region, plan and disk
sizes as in the example.

```bash
deploy/fleet/provision-tenant.sh "$FLEET_HOME/tenants/drill.env"
```

**Expect:** every step printed, nothing called, exit 0. Read it: the instance `suds-drill`, the static IP, three disks
of 64, 32 and 8 GB, the firewall (443, 80; 22 only from the admin networks), the two DNS records, LUKS on the data
disk, install.sh with `--version=1.25.7` and `--release-sha256`. **ABORT** on any warning you cannot explain.

## B. Provision

```bash
deploy/fleet/provision-tenant.sh "$FLEET_HOME/tenants/drill.env" --apply 2>&1 | tee "$FLEET_HOME/register/drill-provision-$(date -u +%Y%m%dT%H%MZ).log"
```

**Expect** (README, *Provision a tenant*, steps 0–10): each step checked before the next; at step 8 every assert passes
— a **fresh** SSH connection after the install, port 22 allowed on IPv4 and IPv6 in ufw, `suds` and `caddy` active,
HTTPS 200 on `https://drill.suds.systems`, `/version.json` = `1.25.7`, `/var/lib/suds` on dm-crypt, `www.` redirecting;
then the escrow file written and `STATUS=active`, `LUKS=yes` in `register/drill.env`. Note the start and end times.

**If it fails:** fix the cause and run the same command again (it keeps what exists, never reformats a mounted disk).
If the fresh SSH connection fails (the host firewall locked SSH out), follow the README's recovery: an export receipt
of `none-never-live`, decommission, provision again. **ABORT** the drill if the same step fails twice.

**The same day:** copy `escrow/drill/keys-<time>.tar.gpg` to the owner's offline escrow medium, as for a real tenant.

## C. First sign-in and the server's own checks

1. On the VM, read the first administrator's name and temporary password once:
   `ssh -i "$FLEET_HOME/keys/suds-fleet.pem" ubuntu@drill.suds.systems sudo cat /var/lib/suds/first-admin-password.txt`.
   The name is `admin-` and six random characters (1.25.7). Sign in at `https://drill.suds.systems`, set a new password,
   enrol two-step verification.
2. **Settings → Security status.** Expect no *bad* line. Write down each *warn* line; expected ones: the first scheduled
   backup still pending, no recovery drill with escrowed keys yet (closed in stage F).
3. The host compliance check: `sudo systemctl start suds-compliance.service; sudo journalctl -u suds-compliance -n 60
   --no-pager`. Expect `host.disk_encryption` pass, `host.tls` pass, `host.firewall` pass (SSH only from the admin
   networks: unlike suds.systems, the drill keeps SSH closed to everyone else). Write down the pass / fail / warn counts.

## D. Fictional records and a verified backup

1. As the administrator, create a navigator account; as that navigator, two fictional clients (e.g. "Drill One",
   "Drill Two"), a visit with naloxone given, a referral and a note. Nothing about a real person.
2. **Settings → Scheduled backups:** every 4 hours, offsite folder `/mnt/suds-offsite` (install.sh set it); then
   **Back up now**.
3. On the VM, check the copy left the data disk and matches:
   `sudo ls -l /var/lib/suds/backups /mnt/suds-offsite` (the newest file in both, the same size) and
   `sudo sha256sum` of each (equal). **ABORT** if the offsite copy is empty or differs (the 1.25.3 defect).

## E. Reboot: the LUKS volume opens unattended

```bash
ssh -i "$FLEET_HOME/keys/suds-fleet.pem" ubuntu@drill.suds.systems sudo systemctl reboot
```

Wait two minutes, then: `curl -fsS https://drill.suds.systems/api/health` → `"ok":true`; on the VM,
`systemctl is-active suds caddy` → `active active`, `findmnt /var/lib/suds` shows the dm-crypt device, and the two
fictional clients are still there after sign-in. **ABORT** (and keep the VM for diagnosis) if SUDS does not come back on
its own.

## F. The escrowed keys open the offsite backup (the owner's key needed)

1. With the owner present (their private escrow key available to gpg):
   `deploy/fleet/escrow.sh open drill --reason "drill: prove the escrowed keys open the offsite backup"`.
   It logs first, checks the file's SHA-256, decrypts into a new private temporary directory and prints where.
2. The archive keeps the files' full paths: the keys are under `etc/suds/credentials/` in that directory (the LUKS
   key file beside them under `etc/`). Compare the `suds_*` names there with `sudo ls /etc/suds/credentials` on the VM
   (the same set).
3. Make the drill's key file, in that temporary directory, from the opened files (the format the recovery drill reads):
   ```bash
   cd <the directory escrow.sh printed>/etc/suds/credentials
   { printf 'SUDS_ENCRYPTION_KEY=%s\n' "$(cat suds_encryption_key)"; printf 'SUDS_INDEX_KEY=%s\n' "$(cat suds_index_key)";
     printf 'SUDS_BACKUP_KEY=%s\n' "$(cat suds_backup_key)"; } > drill-keys.txt && chmod 0600 drill-keys.txt
   ```
4. In SUDS, **Settings → System & backups → Run a recovery drill now**: *Which copy to restore* = the offsite copy;
   *Escrowed key backup file* = `drill-keys.txt` (uploaded once, never stored by SUDS). **Expect** a signed report
   with every check passing, including "the escrowed key file opens the backup" and "the offsite copy was the one
   restored", and its RTO. Download the report and save it in `FLEET_HOME/register/`.
5. `shred -u` every opened file (the keys, the LUKS key, `keys.tar`) and `drill-keys.txt`, remove the directory, then `deploy/fleet/escrow.sh verify`
   (every chain intact). Security status's escrowed-key warning should now be gone.

**ABORT** stage F (record it as failed, keep the VM) if the escrow does not open or the drill fails: that is the finding
this drill exists to catch.

## G. Optional: a data-disk snapshot opens with the escrowed LUKS key

Proves a snapshot is a usable backup, not only the scheduled files.

1. `aws lightsail create-disk-snapshot --disk-name suds-drill-data --disk-snapshot-name suds-drill-data-snap`; wait
   until `get-disk-snapshot` says `completed`.
2. `aws lightsail create-disk-from-snapshot --disk-snapshot-name suds-drill-data-snap --disk-name suds-drill-restore
   --availability-zone us-west-2a --size-in-gb 64`, then `attach-disk` it to `suds-drill` as `/dev/xvdh`.
3. On the VM, open it read-only with the escrowed LUKS key (opened as in stage F, step 1, copied for this one step to a
   root-only temporary file and shredded after), mount it read-only on a temporary directory, and check the database
   in it with the server's own Node (install.sh installs no `sqlite3`):
   `sudo /opt/suds/node/bin/node --no-warnings=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');
   console.log(new DatabaseSync(process.argv[1],{readOnly:true}).prepare('PRAGMA integrity_check').get())" <mount>/suds.db`
   → `{ integrity_check: 'ok' }`.
4. Unmount, close the LUKS mapping, detach and delete `suds-drill-restore`, delete the snapshot. Write down the time
   each step took.

## H. Upgrade, once the next release is out

When `v1.25.8` is released: download its zip and check it as in step 0.2; then per [README.md](README.md),
*Upgrades*: `scp` the zip to the VM, `sudo /opt/suds/current/deploy/linux/upgrade.sh 1.25.8 --source=<zip>
--release-sha256=<hex>`; set `SUDS_VERSION`, `RELEASE_SHA256` and `RELEASE_ZIP` in `tenants/drill.env` **and** in
`register/drill.env`; run `provision-tenant.sh --apply` again. **Expect** no change to anything that exists, every
assert passing with `/version.json` = `1.25.8`, a fresh escrow copy, and the fictional records intact. If the next
release is weeks away, skip H, finish the drill, and run H on the first real tenant's twin later.

## I. Teardown — Gate 2

1. Export something from the drill tenant (a backup file, or **Reports** as a spreadsheet) and record the receipt in
   `register/drill.env`: `EXPORT_FILE` (where it is), `EXPORT_SHA256` (`sha256sum`), `EXPORT_CONFIRMED_ON` (today).
2. Owner's go to destroy, then:
   ```bash
   deploy/fleet/decommission-tenant.sh "$FLEET_HOME/tenants/drill.env"            # dry run: read it
   deploy/fleet/decommission-tenant.sh "$FLEET_HOME/tenants/drill.env" --apply    # type: drill, then DESTROY
   ```
3. Check nothing is left: `aws lightsail get-instances`, `get-disks`, `get-static-ips`, `get-instance-snapshots`,
   `get-disk-snapshots` (no `suds-drill*`); `https://dns.google/resolve?name=drill.suds.systems&type=A` and the
   `www.` name have no answer; `escrow/drill/` is gone; `deploy/fleet/escrow.sh verify` passes. Destroy the offline
   copy of the drill's escrow file and record who did it and when.
4. Commit the ops repository (the register, the logs, the access log). Note its newest hash chain values somewhere else.

## Evidence: what to write down

In the private ops repository, everything. For the public record, a short note with **no** network address, key,
username, account number or register content, saved as `docs/evidence/fleet-drill-<date>.md` in this repository (the
public-docs test refuses operational secrets; run `npm test` before committing it):

| Item | Value |
| --- | --- |
| Date, release(s) | e.g. 2026-10-__, 1.25.7 → 1.25.8 |
| Stages run / passed | A B C D E F (G) (H) I |
| Provisioning time (start → `STATUS=active`) | |
| Host compliance counts (pass / fail / warn) | |
| Offsite copy matched (size and SHA-256) | yes / no |
| Reboot: back on its own, time to healthy | |
| Escrowed-key recovery drill: result, RTO, report signature verified | |
| Snapshot opened with escrowed LUKS key (G) | yes / no / not run |
| Upgrade (H): asserts passed after | yes / no / not run |
| Teardown: nothing left (instances, disks, IPs, snapshots, DNS) | yes / no |
| Findings, and what was changed because of them | |

## After a pass

Tell the development assistant (or edit, with the evidence linked): docs/market/HOSTING.md, this folder's
README (*Status*), docs/security/QUESTIONNAIRE.md #2, docs/market/templates/COUNTY-RFI-ANSWERS.md, the business work
plan (item 8) and docs/security/OPERATIVE-CONTROLS.md change from "tested against stand-ins only" to "drilled end to end
on <date>". Still true after a pass, and still to be said: no customer is hosted yet; no uptime commitment is
published; insurance and counsel's review of the BAA and QSOA are owed before the first customer's real records.

# Backup, disaster recovery and business continuity

## Objectives

| Objective | Default target | Set where | How it is evidenced |
| --- | --- | --- | --- |
| **RPO** (maximum data loss) | The backup interval (`backup_schedule_hours`), else 24 h | Settings → Scheduled backups → *Recovery point objective* (`dr_rpo_target_hours`) | Each recovery drill records the age of the newest backup at the time of the drill and whether it met the target |
| **RTO** (time to restore service) | 60 minutes | Settings → Scheduled backups → *Recovery time objective* (`dr_rto_target_minutes`) | Each drill measures seconds from starting the restore to the restored copy answering `/api/health` |

The county sets the targets in its contingency plan (HIPAA §164.308(a)(7)); SUDS measures against them. The drill's RTO is the *application* restore on the machine that runs it. For a lost site, add the time to reach the standby host (see below) and run the drill there to measure it.

## Backups

* **What:** a consistent snapshot of the whole database (`VACUUM INTO`, safe while serving), encrypted with AES-256-GCM (`server/backup.js`). Keys are not in the backup; `SUDS_BACKUP_KEY` decouples backups from PHI-key rotation.
* **When:** Settings → Scheduled backups (`backup_schedule_hours`; hourly housekeeping runs it when due). Also on demand (*Run a backup now*, download from System & backups, `npm run backup`).
* **Verified on write:** every scheduled backup is read back, decrypted and opened read-only before it counts (`server/scheduled-backup.js`).
* **Retention:** newest `backup_retain_count` (default 14) kept locally, oldest pruned first.
* **Offsite:** each backup copied to `backup_offsite_dir` — a share at a second site or replicated storage. A missing mount is reported, never silently created on the local disk.
* **Monitoring:** status on System & backups and Security status; `/api/health` answers 503 when backups stop or fail; failures are audited (`backup.scheduled`, success 0).
* **Each backup is also an audit anchor** (`server/audit-anchor.js`).

## Tested recovery: the drill

`npm run dr-drill`, Settings → System & backups → *Run a recovery drill now*, or monthly (Settings → *Recovery drill every month*, off by default). Implementation: `server/dr-drill.js` (parent), `server/dr-drill-child.js` (restored side). Tests: `test/security-evidence.test.js`.

What it does:

1. Takes the **newest backup on disk** (what a disaster would leave), or makes one if there is none; `--backup <file>` drills a specific file, e.g. one fetched back from the offsite share.
2. Decrypts it into a temporary directory (`<data>/.dr-drill/…`, 0700) — never over the live database.
3. Starts SUDS against that copy **in a separate process** that is given only the temporary paths; the keys are passed over the IPC channel, not the environment.
4. Checks, recording each as pass/fail:
   * SQLite `integrity_check`;
   * the keys in custody open it (key fingerprint);
   * the schema reaches this build's version (older backups are migrated, as a real restore would);
   * every table holds the rows the backup was taken with;
   * the **whole audit chain** verifies, and matches the anchors written before the backup;
   * a sample of every encrypted column decrypts;
   * `/api/health` answers 200;
   * a throwaway administrator (added to the copy only) signs in with a password **and a TOTP code**, and an authenticated read returns the restored record count.
5. Deletes the copy.
6. Writes `<data>/backups/dr-drill-<time>.json` — the report plus its SHA-256 and an HMAC under the index key over the canonical JSON (`verifyReport` in `server/dr-drill.js` checks it) — and a `.txt` summary; records the summary in settings (`dr_last_drill`) and as the audit entry `dr.drill`. The report also lists how many rows the live server holds beyond the backup (the exposure a loss at that moment would have caused).

The only writes to the live database are that settings row and the audit entries (`dr.drill.start`, `dr.drill`) — and, when no backup existed, the backup the drill made first.

A failed drill (wrong key, damaged file, failed check) is recorded exactly like a passed one, shows as "Action needed" on Security status, and its report says which check failed.

## Restore procedures

* **In the browser:** Settings → System & backups → *Restore from a backup*: preview first, administrator password and "REPLACE" to confirm; the replaced database is kept beside it (`suds.db.before-restore-<time>`); a restore writes a new database generation (devices re-offer what the backup lacks) and a `restore` audit anchor.
* **On the host:** `node scripts/backup.js --restore <file> <out.db>` then swap it in with the service stopped (`../DEPLOYMENT.md`, "Backups").
* **Older key:** a backup made before a key rotation needs the retired key (keep retired keys with the backups they open).

## Single-site risk and standby

SUDS runs as a single process on a single database; it does not cluster. Options, detailed in `../DEPLOYMENT.md`, "County hosting options and single-site risk":

* county VM with backups replicated to a second site;
* the county's own cloud tenant (Azure Government / AWS GovCloud), with the backup set replicated across regions and anchors in object-locked storage;
* **warm standby (active–passive)**: a second host, SUDS installed but stopped, reading the offsite backup set; drilled monthly with `npm run dr-drill -- --backup <newest offsite file>`; failover = restore the newest backup, start, repoint DNS. RPO ≈ backup interval; RTO ≈ the standby's drill time plus DNS/proxy change.

Not provided: automatic failover, synchronous replication, zero data loss.

## Continuity without the server

Staff can keep working on paper; the programme's downtime procedure is a county document. Local mode (off by default) can let named staff keep a caseload on a managed device and sync later (`../PLATFORM.md`), which a county may choose for continuity at the cost of PHI on devices.

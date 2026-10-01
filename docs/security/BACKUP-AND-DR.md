# Backup, disaster recovery and business continuity

## Objectives

| Objective | Default target | Set where | How it is evidenced |
| --- | --- | --- | --- |
| **RPO** (maximum data loss) | The shortest configured interval — online snapshots (`backup_schedule_minutes`) or scheduled backups (`backup_schedule_hours`) — else 24 h | Settings → Scheduled backups → *Recovery point objective* (`dr_rpo_target_hours`) | Security status shows the worst-case RPO the schedule gives (*Recovery point objective (worst case)*); each recovery drill records the age of the newest copy at the time of the drill and whether it met the target |
| **RTO** (time to restore service) | 60 minutes | Settings → Scheduled backups → *Recovery time objective* (`dr_rto_target_minutes`) | Each drill measures seconds from starting the restore to the restored copy answering `/api/health` |

The county sets the targets in its contingency plan (HIPAA §164.308(a)(7)); SUDS measures against them. The drill's RTO is the *application* restore on the machine that runs it. For a lost site, add the time to reach the standby host (see below) and run the drill there to measure it.

## Backups

* **What:** a consistent snapshot of the whole database, encrypted with AES-256-GCM (`server/backup.js`). Scheduled backups and snapshots use SQLite's online backup API and stream the encryption to the file 4 MB at a time, then (scheduled backups) decrypt the file back and run `PRAGMA integrity_check` in a worker thread — none of it holds the event loop (`createToFileAsync`, `verifyFileAsync`); the manual download and `npm run backup` use `VACUUM INTO`. Keys are not in the backup; `SUDS_BACKUP_KEY` decouples backups from PHI-key rotation.
* **When:** Settings → Scheduled backups (`backup_schedule_hours`; hourly housekeeping runs it when due). Also on demand (*Run a backup now*, download from System & backups, `npm run backup`). **A production install made with the setup wizard starts with backups every 4 hours**; one configured by environment variables starts with none, and **in production, backups switched off (0) are reported** as *Action needed* on Security status, as an alert on the administrator's Home page, and in the startup log (`server/startup-checks.js`).
* **Verified on write:** every scheduled backup is read back, decrypted and opened read-only before it counts (`server/scheduled-backup.js`).
* **Retention:** newest `backup_retain_count` (default 14) kept locally, oldest pruned first.
* **Offsite:** each backup copied to `backup_offsite_dir` — a share at a second site or replicated storage. A missing mount is reported, never silently created on the local disk.
* **Monitoring:** status on System & backups and Security status; `/api/health` answers 503 when backups stop or fail; failures are audited (`backup.scheduled`, success 0).
* **Each backup is also an audit anchor** (`server/audit-anchor.js`).

### Frequent online snapshots (RPO in minutes)

Settings → Scheduled backups → *Also snapshot every (minutes)* (`backup_schedule_minutes`, 0 = off, else 5–1440) with *Keep this many recent snapshots* (`backup_snapshot_retain`, default 24). Every N minutes the server takes a whole-database copy with SQLite's **online backup API** (`node:sqlite` `backup()`, which copies pages in batches and lets requests run between them; `VACUUM INTO` on a Node without it), encrypts it in 4 MB slices with the backup key, and writes it as `suds-snap-<time>.db.enc` to the offsite directory when one is configured (otherwise to `<data>/backups`, which protects against corruption and mistakes but not the loss of the disk — Security status says so). The oldest beyond the retention count are pruned; scheduled backups keep their own, longer retention. No new dependency: this is SQLite and `node:crypto`.

It is a full copy each time, not a page-level increment (SQLite has no incremental backup), so size the offsite share for `backup_snapshot_retain` × the database size. A failing or stale snapshot is shown on Security status and turns `/api/health` to 503; the change from working to failing is audited (`backup.snapshot.failed`). The recovery drill restores the newest copy, snapshot or backup.

**Measured cost** (4-core container, Node 22.22, SSD, `scripts`-free measurement of `server/backup.js`, a 107 MB database of 26,000 clients):

| Operation | Wall time | Longest event-loop stall |
| --- | --- | --- |
| Scheduled backup, old synchronous path up to 1.11.0 (`VACUUM INTO` + encrypt + read-back) | ~1.0 s | ~1.0 s (the whole operation) |
| Online snapshot, copy only (`backup()`, 256 pages/step) | 0.4–0.7 s | — |
| Online snapshot end to end (copy, sliced encrypt, write, rotate) | ~1.2 s | ~90 ms |

Scheduled backups after 1.11.0 (online copy, encryption streamed to the file, read-back decryption streamed to a temporary file, integrity check in a worker thread; `test/scheduled-backup.test.js` asserts the stall stays small): on a 311 MB database in a 4-core development container, **4.2 s wall time, longest event-loop stall 16 ms**, where the synchronous path it replaced stalled for the whole 6.3 s (3.8 s on the machine the problem was first measured on). Memory no longer scales with the database: nothing holds the whole database in one Buffer.

So a snapshot every 15 minutes costs about 0.1% of one core and at worst one ~90 ms pause (comparable to one password check) per run, and keeps 107 MB × `backup_snapshot_retain` on the share (2.6 GB for 24, six hours of 15-minute points). Memory peaks at about three times the database size during the copy. Scale roughly linearly with database size.

## Tested recovery: the drill

`npm run dr-drill`, Settings → System & backups → *Run a recovery drill now*, or monthly (Settings → *Recovery drill every month*, off by default). Implementation: `server/dr-drill.js` (parent), `server/dr-drill-child.js` (restored side). Tests: `test/security-evidence.test.js`.

What it does:

1. Takes the **newest copy that would survive the loss of this server**: when an offsite directory is configured, the newest backup or snapshot *in the offsite directory* (an unreachable or empty share fails the drill, which then measures the local copy so the RTO is still known); otherwise the newest in `<data>/backups`; or makes one if there is none. `--local` / `--offsite` (or *Which copy to restore* on the page) choose explicitly; `--backup <file>` drills a specific file. The report says which copy was restored and from where.
2. **Keys.** By default the drill uses the keys this server process holds. `--keys-file <keys.json>` (or *Escrowed key backup file* on the page, which uploads the file once and never stores it) makes it decrypt the backup and start the copy with **the escrowed key backup only** — the `keys.json` from *Download key backup*, or `SUDS_ENCRYPTION_KEY=…`/`SUDS_INDEX_KEY=…`/`SUDS_BACKUP_KEY=…` lines — so a pass proves the copy of the keys kept offline actually opens the backups. The report records which keys were used and short fingerprints, never the keys; Security status says when the last drill used server memory.
3. Decrypts it into a temporary directory (`<data>/.dr-drill/…`, 0700, with an `owner.json` naming the process) — never over the live database.
4. Starts SUDS against that copy **in a separate process** that is given only the temporary paths; the keys are passed over the IPC channel, not the environment.
5. Checks, recording each as pass/fail:
   * the escrowed key file opens the backup (with `--keys-file`), and the offsite copy was the one restored (when offsite is configured);
   * SQLite `integrity_check`;
   * the keys in custody open it (key fingerprint);
   * the schema reaches this build's version (older backups are migrated, as a real restore would);
   * every table holds the rows the backup was taken with;
   * the **whole audit chain** verifies, and matches the anchors written before the backup;
   * a sample of every encrypted column decrypts;
   * `/api/health` answers 200;
   * a throwaway administrator (added to the copy only) signs in with a password **and a TOTP code**, and an authenticated read returns the restored record count.
6. Overwrites the copy with zeros and deletes it. A drill that died part-way (a crash, a kill, a power cut) leaves its directory behind; **at every start and before every drill, drill directories whose process is gone, and plaintext `.backup-*`/`.inspect-*` temporary files over an hour old, are overwritten and removed** (audited as `dr.drill.swept`). Overwriting is best effort on SSDs and copy-on-write filesystems; full-disk encryption of the data volume is what protects blocks the filesystem keeps.
7. Writes `<data>/backups/dr-drill-<time>.json` — the report plus its SHA-256, an HMAC under the index key, and an **Ed25519 signature** over the canonical JSON with the signing key (`server/signing.js`; the key id is inside the signed report, the public key beside it) — and a `.txt` summary; records the summary in settings (`dr_last_drill`) and as the audit entry `dr.drill`. The report also lists how many rows the live server holds beyond the backup (the exposure a loss at that moment would have caused).

**Verifying a report with the public key only.** The HMAC proves nothing to an outsider (the index key is held by whoever runs the database); the signature does. The public key is published at `GET /api/admin/security/signing-key` (*Download signing public key* on Security status); the private key lives with the other keys (`SUDS_SIGNING_KEY` or `keys.json`), never in the database. An auditor verifies a report with nothing else:

```bash
npm run verify-dr-report -- dr-drill-2026-09-25T02-00-00-000Z.json --public-key suds-signing-key.pem
```

Exit 0 = verified (`scripts/verify-dr-report.js`, `server/dr-report.js`). Without `--public-key` it uses the key embedded in the report, which proves the report was not edited but not who signed it, and says so.

The only writes to the live database are that settings row and the audit entries (`dr.drill.start`, `dr.drill`) — and, when no backup existed, the backup the drill made first.

A failed drill (wrong key, damaged file, failed check) is recorded exactly like a passed one, shows as "Action needed" on Security status, and its report says which check failed.

## Exercised on every push, and the evidence

Backup and restore are not only tested by unit tests: the `dr-drill` CI job (`.github/workflows/ci.yml`) runs `scripts/dr-exercise.js` (`npm run dr-exercise`) on every push — seed a throwaway database, seal an audit anchor, take an encrypted backup through the scheduled-backup path, run this drill against it with an escrowed key file, restore it again with the host procedure (`scripts/backup.js --restore`) into a **fresh data directory**, start the server there and wait for `/api/health`, compare every table's row count with the source, verify the whole audit chain, and verify the signed drill report with the public key only. The signed report is printed in the job log (the repository uses no Actions at all, so no artifact upload). The release gate refuses a release whose `dr-drill` job did not pass ([RELEASE.md](../RELEASE.md#release-gate)).

Recorded runs on a 20,000-client database: **latest, 2026-10-01, on the released 1.23.0** (`9877d07`, schema 67), [docs/evidence/dr-drill-2026-10-01-v1.23.0/](../evidence/dr-drill-2026-10-01-v1.23.0/README.md) (172 MB backup) — drill RTO 4.5 s, host-procedure RTO 3 s, RPO at the time of the drill 5 s, 11/11 checks; on 1.21.0, [docs/evidence/dr-drill-2026-10-01-v1.21.0/](../evidence/dr-drill-2026-10-01-v1.21.0/README.md) (172 MB) — 4 s, 3.9 s, 11/11; on 1.20.0, [docs/evidence/dr-drill-2026-09-30-v1.20.0/](../evidence/dr-drill-2026-09-30-v1.20.0/README.md) (172 MB) — 3.6 s, 2.8 s, 11/11; on 1.19.0, [docs/evidence/dr-drill-2026-09-30/](../evidence/dr-drill-2026-09-30/README.md) (172 MB) — 5 s, 3.7 s, 11/11; on 1.16.2, [docs/evidence/dr-drill-2026-09-29.md](../evidence/dr-drill-2026-09-29.md) (172 MB) — 3.8 s, 4 s, 11/11; earlier, on 1.11.0, [docs/evidence/dr-drill-2026-09-25.md](../evidence/dr-drill-2026-09-25.md) (128 MB) — 3.3 s, 3.8 s, 11/11. Each is a **development-environment exercise on fictional data**, not a production drill: a county's own drill, on its production server with its offsite copy and escrowed keys, is what shows its recovery works.

**After an upgrade.** [docs/evidence/upgrade-drill-2026-10-01-v1.23.0/](../evidence/upgrade-drill-2026-10-01-v1.23.0/README.md): databases written by 1.21.0 and 1.22.0 (20,000 clients each, with a field device, a county release published, on 1.22.0 each programme's consent, the authenticator allow-list on with an attested passkey and one from before it, follow-up to-dos from a call and a visit, and a supervisor's reminder) were opened by 1.23.0, checked (schema identical to a fresh install, nothing lost, every kept row unchanged by the columns the older release had through migrations 64–67, the to-dos moved when their dates change and the reminder closed on signing), then backed up and drilled: 11/11 each, drill RTO 3.6 s and 4.5 s. The same drill to 1.21.0, [docs/evidence/upgrade-drill-2026-10-01-v1.21.0/](../evidence/upgrade-drill-2026-10-01-v1.21.0/README.md): databases written by 1.16.2, 1.19.0 and 1.20.0 (20,000 clients each, a signed and countersigned note, a TOTP user, a sync device; on 1.19.0 and 1.20.0 also a passkey and signed county submissions, one superseded, and on 1.20.0 a quarter the county entered) were opened by 1.21.0, checked (schema identical to a fresh install, nothing lost, every sampled value decrypting, the note and the audit chain verifying, every county submission, session, device and passkey kept unchanged through migrations 61–63), then backed up and drilled: 11/11 each, drill RTO 3.1 s, 3 s and 3.1 s (to 1.20.0: [docs/evidence/upgrade-drill-2026-09-30-v1.20.0/](../evidence/upgrade-drill-2026-09-30-v1.20.0/README.md); to 1.19.0: [docs/evidence/upgrade-drill-2026-09-30/](../evidence/upgrade-drill-2026-09-30/README.md)). On a server the 1.23.0 Linux installer set up (in a container, [docs/evidence/installer-container-run-2026-10-01-v1.23.0/](../evidence/installer-container-run-2026-10-01-v1.23.0/README.md)), the installer's own first backup and drill passed 11/11, and a drill of the offsite copy with the escrowed key file passed 12/12 (as on 1.21.0, 1.20.0 and 1.19.0: [docs/evidence/installer-container-run-2026-10-01-v1.21.0/](../evidence/installer-container-run-2026-10-01-v1.21.0/README.md), [docs/evidence/installer-container-run-2026-09-30-v1.20.0/](../evidence/installer-container-run-2026-09-30-v1.20.0/README.md), [docs/evidence/installer-container-run-2026-09-30/](../evidence/installer-container-run-2026-09-30/README.md)).

## Restore procedures

* **In the browser:** Settings → System & backups → *Restore from a backup*: preview first, administrator password and "REPLACE" to confirm; the replaced database is kept beside it, sealed like a backup once the restore has taken (`suds.db.before-restore-<time>.enc`, deleted after 14 days; up to 1.13.0 it stayed in plaintext). If sealing fails (a full disk, say), Security status shows *Unencrypted database copies* with the file and what to do, `/api/health` answers 503 naming it, and housekeeping retries every hour (1.16.0; before, only a log line and the next start); a restore writes a new database generation (devices re-offer what the backup lacks) and a `restore` audit anchor. Backup, snapshot, offsite copy, recovery drill and restore share one lock (`server/backup-lock.js`): a restore waits up to two minutes for one in flight, and is otherwise refused with a 409 that says what is running, with nothing touched; while it waits and runs, the backup, snapshot and drill timers skip their turn. The swap, the new generation and the anchor complete together, or the previous database is put back and the page says so (`test/backup-restore-race.test.js`).
* **On the host:** with the service stopped, `node scripts/backup.js --restore-in-place <file>`: checks the backup, writes it beside the database and checks it again, moves the live database and its -wal/-shm aside (sealed like a backup), renames the copy into place and writes a `restore` anchor. It never opens the live database, so it also rolls back an upgrade whose migration ran (`deploy/linux/upgrade.sh`). `--restore <file> <out.db>` only decrypts to a separate file (`../DEPLOYMENT.md`, "Backups").
* **Older key:** a backup made before a key rotation needs the retired key (keep retired keys with the backups they open).

## Single-site risk and standby

SUDS runs as a single process on a single database; it does not cluster. Options, detailed in `../DEPLOYMENT.md`, "County hosting options and single-site risk":

* county VM with backups replicated to a second site;
* the county's own cloud tenant (Azure Government / AWS GovCloud), with the backup set replicated across regions and anchors in object-locked storage;
* **warm standby (active–passive)**: a second host, SUDS installed but stopped, reading the offsite backup set; drilled monthly with `npm run dr-drill -- --offsite --keys-file <escrowed keys.json>`; failover = restore the newest backup or snapshot, start, repoint DNS. RPO ≈ the snapshot interval (or the backup interval without snapshots); RTO ≈ the standby's drill time plus DNS/proxy change. Failover remains a documented, manual procedure.

Not provided: automatic failover, synchronous replication, zero data loss.

## Continuity without the server

Staff can keep working on paper; the programme's downtime procedure is a county document. Local mode (off by default) can let named staff keep the records they may see (the whole programme under the 1.16.0 role defaults, a caseload after a deny of `clients:all`) on a managed device and sync later (`../PLATFORM.md`), which a county may choose for continuity at the cost of PHI on devices.

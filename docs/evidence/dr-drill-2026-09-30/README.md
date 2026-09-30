# Recovery drill evidence — 2026-09-30 (SUDS 1.19.0)

> **Development-environment exercise, not a production drill.** It was run on a throwaway database of
> fictional records (the sample data set plus 20,000 synthetic clients), in a 4-core, 16 GB Linux development
> container, with keys generated for the run and deleted with it. It proves that SUDS's own backup and restore
> code paths work end to end on a realistically sized database and measures them. It does **not** prove that a
> county's production backups, offsite share, escrowed keys or hosting can be recovered: that needs the same
> drill on the production server (`npm run dr-drill -- --offsite --keys-file <escrowed keys.json>`, or
> Settings → System & backups → *Run a recovery drill now*), recorded by the county. See
> [BACKUP-AND-DR.md](../../security/BACKUP-AND-DR.md).

This repeats the [2026-09-29 exercise](../dr-drill-2026-09-29.md) (SUDS 1.16.2, schema 48, 59 tables) exactly as
it was run, on the released **SUDS 1.19.0** (schema 59, 74 tables): the same script, the same scale, the same
steps. Only the version, the schema and the numbers differ.

## What ran, on which commit

* **Code:** `3dc20dc` ("Release 1.19.0", on `main`; `package.json` 1.19.0), as its released tree:
  `git archive 3dc20dc | tar -x -C <dir>` (the files of `suds-v1.19.0.zip`, which `release.yml` builds with
  `git archive` of the tag), with the repository's `node_modules` linked in (the exercise uses no npm package).
* **Runtime:** Node v22.22.2 (CI pins 22.23.3), Linux 6.18.44, 4 CPUs, 16 GB.
* **Command**, from that tree:

  ```bash
  node --no-warnings=ExperimentalWarning scripts/dr-exercise.js --clients 20000 --out <dir>
  ```

  Its console output is [`exercise-transcript.txt`](exercise-transcript.txt), unedited. The whole run took 33 s
  (18:33:09.7 to 18:33:42.3 UTC). Exit status 0.

`scripts/dr-exercise.js` runs each step in its own process against a new temporary directory, with four keys
(encryption, index, backup, signing) generated for the run and written to an `escrowed-keys.json` there (what
*Download key backup* gives); it exits non-zero if any step fails, and deletes the directory at the end.

| # | Step | Command / code path | Time | Result |
| --- | --- | --- | --- | --- |
| 1 | Seed the sample data | `npm run seed` (`scripts/seed.js`) | 2.5 s | 12 clients, 140 visits, 70 calls, 45 notes, 15 resources |
| 2 | Add volume | 20,000 fictional clients × 8 visits, each creation audited (`audit.log`) | 14.4 s | 20,012 clients, 160,140 visits, 20,001 audit entries |
| 3 | Seal an audit anchor outside the database | `server/audit-anchor.js` `safeWrite` into `AUDIT_ANCHOR_DIR` | 0.1 s | anchor at audit entry 20,001 |
| 4 | Encrypted backup | the scheduled-backup path, `server/scheduled-backup.js` `run()`: online copy, AES-256-GCM, read back, decrypted and `integrity_check`ed | 5.4 s | 172 MB, `sqlite-online-backup`, verified |
| 5 | Recovery drill with the escrowed keys | `npm run dr-drill -- --backup <file> --keys-file escrowed-keys.json --json` | 5.9 s | **PASSED, 11/11 checks** |
| 6 | Host restore into a fresh data directory | `node scripts/backup.js --restore <file> <fresh>/suds.db` | 3.4 s | 20,012 clients, schema 59 |
| 7 | Serve from the fresh directory | `node server/index.js` on it, poll `GET /api/health` | 3.7 s | HTTP 200 |
| 8 | Row counts | every one of 74 tables in the fresh directory vs the source at backup time | 0.3 s | all equal (audit_log 20,001 → 20,001) |
| 9 | Audit chain | `server/audit.js` `verifyChain()` on the fresh directory | — | ok, 20,001 entries checked |
| 10 | Report signature | `npm run verify-dr-report -- <report.json> --public-key suds-signing-key.pem` | 0.05 s | VERIFIED |

## Drill checks (step 5)

From the signed report [`dr-drill-2026-09-30T18-33-32-205Z.json`](dr-drill-2026-09-30T18-33-32-205Z.json)
(text copy: [`.txt`](dr-drill-2026-09-30T18-33-32-205Z.txt)):

* the escrowed key file (not the keys in the drill process's memory) opens the backup;
* SQLite `integrity_check` passes; the encryption key in custody opens it; schema is at this build's version (59);
* every table holds the rows the backup was taken with (74 tables);
* the audit chain verifies end to end (20,001 entries) and matches the anchors written before the backup (2 matched);
* a sample of every encrypted column decrypts (157 values across every `*_enc` column);
* the restored copy, started in a separate process that never saw the live database's path, answers `/api/health`;
* a throwaway administrator signs in with a password and a TOTP second factor; an authenticated read returns 20,012 clients.

## RTO and RPO measured

| Measure | 1.19.0 (this run) | 1.16.2 (2026-09-29) | 1.11.0 (2026-09-25) | What it measures |
| --- | --- | --- | --- | --- |
| **RTO, drill** | **5 s** | 3.8 s | 3.3 s | from starting the restore (reading and decrypting the backup) to the restored copy answering `/api/health` (report `rto.seconds`) |
| **RTO, host procedure** | **3.7 s** | 4 s | 3.8 s | from `scripts/backup.js --restore` starting to a server on the fresh data directory answering `/api/health` (summary `host_restore_to_health_seconds`) |
| **RPO, this exercise** | **5 s** | 7 s | 4 s | age of the backup when it was restored (report `rpo.seconds`): near zero only because the backup was taken moments before |
| Backup size | 172 MB | 172 MB | 128 MB | the same fictional volume; schema 59 holds 74 tables to 1.16.2's 59 |
| RPO, configured | the backup / snapshot interval | | | in production the worst-case loss is the scheduled interval (every 4 hours by default, or the snapshot interval, e.g. 15 minutes, when snapshots are on), shown on Security status as *Recovery point objective (worst case)* |

The drill RTO is about a second longer than on 1.16.2 for the same volume: the restored copy now has 74 tables
to check and start (schema 59), and single runs on a shared development container vary by that much. Both are
far inside the 60-minute target. Neither figure includes what a real recovery adds: noticing the failure,
provisioning or reaching the standby host, fetching the offsite copy and the escrowed keys, and repointing DNS or
the proxy. Those are organisational steps, measured only by a production drill.

## Integrity of this evidence

* Report SHA-256 `ae123b8cbeab490b8cff87e053be12e1fe1c2d9702cc7a6ad5400023fe4bdbdd` and its Ed25519 signature are inside the report file (`integrity`); signing key id `9d03a438194cfb3a`.
* Public key: [`suds-signing-key.pem`](suds-signing-key.pem). Verify:
  `npm run verify-dr-report -- docs/evidence/dr-drill-2026-09-30/dr-drill-2026-09-30T18-33-32-205Z.json --public-key docs/evidence/dr-drill-2026-09-30/suds-signing-key.pem` → `VERIFIED` (checked again from this branch before it was committed).
* The signing key was generated for this run and discarded with the work directory, so the public key beside the report is the only one that verifies it; that proves the report was not edited after signing, not who ran it. No private key is in this folder.
* Full exercise summary (steps, timings, host, `suds_version` 1.19.0): [`summary.json`](summary.json).

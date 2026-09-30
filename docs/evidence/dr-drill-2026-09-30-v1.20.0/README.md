# Recovery drill evidence — 2026-09-30 (SUDS 1.20.0)

> **Development-environment exercise, not a production drill.** It was run on a throwaway database of
> fictional records (the sample data set plus 20,000 synthetic clients), in a 4-core, 16 GB Linux development
> container, with keys generated for the run and deleted with it. It proves that SUDS's own backup and restore
> code paths work end to end on a realistically sized database and measures them. It does **not** prove that a
> county's production backups, offsite share, escrowed keys or hosting can be recovered: that needs the same
> drill on the production server (`npm run dr-drill -- --offsite --keys-file <escrowed keys.json>`, or
> Settings → System & backups → *Run a recovery drill now*), recorded by the county. See
> [BACKUP-AND-DR.md](../../security/BACKUP-AND-DR.md).

This repeats the [1.19.0 exercise of the same day](../dr-drill-2026-09-30/README.md) exactly as it was run, on
the released **SUDS 1.20.0** (schema 60, 74 tables): the same script, the same scale, the same steps. Only the
version, the schema and the numbers differ. It is the fourth development drill (2026-09-25 on 1.11.0,
2026-09-29 on 1.16.2, 2026-09-30 on 1.19.0, and this one); the folder carries a version suffix because the
1.19.0 run already holds `dr-drill-2026-09-30/`.

## What ran, on which commit

* **Code:** `8f365b4` ("SBOM of the 1.20.0 stamp", the commit the v1.20.0 tag hand-off names; `package.json`
  1.20.0), as its released tree: `git archive 8f365b4 | tar -x -C <dir>` (the files of `suds-v1.20.0.zip`,
  which `release.yml` builds with `git archive` of the tag), with the repository's `node_modules` linked in
  (the exercise uses no npm package).
* **Runtime:** Node v22.22.2 (CI pins 22.23.3), Linux 6.18.44, 4 CPUs, 16 GB.
* **Commands** (from a checkout of this repository):

  ```bash
  mkdir -p /tmp/tree120 && git archive 8f365b4 | tar -x -C /tmp/tree120
  ln -s "$PWD/node_modules" /tmp/tree120/node_modules
  cd /tmp/tree120
  node --no-warnings=ExperimentalWarning scripts/dr-exercise.js --clients 20000 --out /tmp/dr-out \
    > /tmp/dr-transcript.txt 2>&1          # exit status 0
  # then: the .json, .txt, .pem and summary.json from /tmp/dr-out, and the transcript, copied here
  ```

  Its console output is [`exercise-transcript.txt`](exercise-transcript.txt), unedited (its last line names
  the scratch directory the evidence was first written to). The whole run took 24 s (21:06:32.1 to
  21:06:56.4 UTC). Exit status 0.

`scripts/dr-exercise.js` runs each step in its own process against a new temporary directory, with four keys
(encryption, index, backup, signing) generated for the run and written to an `escrowed-keys.json` there (what
*Download key backup* gives); it exits non-zero if any step fails, and deletes the directory at the end.

| # | Step | Command / code path | Time | Result |
| --- | --- | --- | --- | --- |
| 1 | Seed the sample data | `npm run seed` (`scripts/seed.js`) | 1.2 s | 12 clients, 140 visits, 70 calls, 45 notes, 15 resources |
| 2 | Add volume | 20,000 fictional clients × 8 visits, each creation audited (`audit.log`) | 10.6 s | 20,012 clients, 160,140 visits, 20,001 audit entries |
| 3 | Seal an audit anchor outside the database | `server/audit-anchor.js` `safeWrite` into `AUDIT_ANCHOR_DIR` | 0.1 s | anchor at audit entry 20,001 |
| 4 | Encrypted backup | the scheduled-backup path, `server/scheduled-backup.js` `run()`: online copy, AES-256-GCM, read back, decrypted and `integrity_check`ed | 4.6 s | 172 MB, `sqlite-online-backup`, verified |
| 5 | Recovery drill with the escrowed keys | `npm run dr-drill -- --backup <file> --keys-file escrowed-keys.json --json` | 4.4 s | **PASSED, 11/11 checks** |
| 6 | Host restore into a fresh data directory | `node scripts/backup.js --restore <file> <fresh>/suds.db` | 2.6 s | 20,012 clients, schema 60 |
| 7 | Serve from the fresh directory | `node server/index.js` on it, poll `GET /api/health` | 2.8 s | HTTP 200 |
| 8 | Row counts | every one of 74 tables in the fresh directory vs the source at backup time | 0.3 s | all equal (audit_log 20,001 → 20,001) |
| 9 | Audit chain | `server/audit.js` `verifyChain()` on the fresh directory | — | ok, 20,001 entries checked |
| 10 | Report signature | `npm run verify-dr-report -- <report.json> --public-key suds-signing-key.pem` | 0.06 s | VERIFIED |

## Drill checks (step 5)

From the signed report [`dr-drill-2026-09-30T21-06-48-747Z.json`](dr-drill-2026-09-30T21-06-48-747Z.json)
(text copy: [`.txt`](dr-drill-2026-09-30T21-06-48-747Z.txt)):

* the escrowed key file (not the keys in the drill process's memory) opens the backup;
* SQLite `integrity_check` passes; the encryption key in custody opens it; schema is at this build's version (60);
* every table holds the rows the backup was taken with (74 tables, including the `county_submissions` table
  migration 60 rebuilt);
* the audit chain verifies end to end (20,001 entries) and matches the anchors written before the backup (2 matched);
* a sample of every encrypted column decrypts (157 values across every `*_enc` column);
* the restored copy, started in a separate process that never saw the live database's path, answers `/api/health`;
* a throwaway administrator signs in with a password and a TOTP second factor; an authenticated read returns 20,012 clients.

## RTO and RPO measured

| Measure | 1.20.0 (this run) | 1.19.0 (2026-09-30) | 1.16.2 (2026-09-29) | 1.11.0 (2026-09-25) | What it measures |
| --- | --- | --- | --- | --- | --- |
| **RTO, drill** | **3.6 s** | 5 s | 3.8 s | 3.3 s | from starting the restore (reading and decrypting the backup) to the restored copy answering `/api/health` (report `rto.seconds`) |
| **RTO, host procedure** | **2.8 s** | 3.7 s | 4 s | 3.8 s | from `scripts/backup.js --restore` starting to a server on the fresh data directory answering `/api/health` (summary `host_restore_to_health_seconds`) |
| **RPO, this exercise** | **5 s** | 5 s | 7 s | 4 s | age of the backup when it was restored (report `rpo.seconds`): near zero only because the backup was taken moments before |
| Backup size | 172 MB | 172 MB | 172 MB | 128 MB | the same fictional volume |
| RPO, configured | the backup / snapshot interval | | | | in production the worst-case loss is the scheduled interval (every 4 hours by default, or the snapshot interval, e.g. 15 minutes, when snapshots are on), shown on Security status as *Recovery point objective (worst case)* |

The four runs are within about a second and a half of each other for the same volume; single runs on a shared
development container vary by that much, so the 1.20.0 figures being the fastest says nothing about 1.20.0
itself. All are far inside the 60-minute target. None includes what a real recovery adds: noticing the
failure, provisioning or reaching the standby host, fetching the offsite copy and the escrowed keys, and
repointing DNS or the proxy. Those are organisational steps, measured only by a production drill.

## Integrity of this evidence

* Report SHA-256 `971b8cef878932e95ce7a7d583f19e9ead19bbf8dc739772ec73bbe65d02b968` and its Ed25519 signature are inside the report file (`integrity`); signing key id `5fe0e8f67a62681f`.
* Public key: [`suds-signing-key.pem`](suds-signing-key.pem). Verify:
  `npm run verify-dr-report -- docs/evidence/dr-drill-2026-09-30-v1.20.0/dr-drill-2026-09-30T21-06-48-747Z.json --public-key docs/evidence/dr-drill-2026-09-30-v1.20.0/suds-signing-key.pem` → `VERIFIED` (checked again from this branch before it was committed).
* The signing key was generated for this run and discarded with the work directory, so the public key beside the report is the only one that verifies it; that proves the report was not edited after signing, not who ran it. No private key is in this folder.
* Full exercise summary (steps, timings, host, `suds_version` 1.20.0): [`summary.json`](summary.json).

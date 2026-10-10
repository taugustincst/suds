# Recovery drill evidence — 2026-10-09 (SUDS 1.25.3)

> **Development-environment exercise, not a production drill.** It was run on a throwaway database of
> fictional records (the sample data set plus 20,000 synthetic clients), in a 4-core, 16 GB Linux development
> container, with keys generated for the run and deleted with it. It proves that SUDS's own backup and restore
> code paths work end to end on a realistically sized database and measures them. It does **not** prove that a
> county's production backups, offsite share, escrowed keys or hosting can be recovered: that needs the same
> drill on the production server (`npm run dr-drill -- --offsite --keys-file <escrowed keys.json>`, or
> Settings → System & backups → *Run a recovery drill now*), recorded by the county. See
> [BACKUP-AND-DR.md](../../security/BACKUP-AND-DR.md).

This repeats the [1.23.0 exercise](../dr-drill-2026-10-01-v1.23.0/README.md) exactly as it was run, on the
released **SUDS 1.25.3** (schema 71, 81 tables): the same script, the same scale, the same steps. Only the
version, the schema and the numbers differ. It is the seventh development drill (2026-09-25 on 1.11.0, 2026-09-29
on 1.16.2, 2026-09-30 on 1.19.0 and on 1.20.0, 2026-10-01 on 1.21.0 and on 1.23.0, and this one). No release from
1.23.1 to 1.25.2 was drilled on its own, so this run covers what they add together: the two tables of migration 70
(`incoming_referrals`, `incoming_referral_attempts`) are among the 81 whose row counts the drill and step 8 compare
(both empty in the sample data); migrations 68, 69 and 71 add or remap columns that travel with their tables.

## What ran, on which commit

* **Code:** `fdd248d0` (the commit the `v1.25.3` tag names, "SBOM of the 1.25.3 stamp"; `package.json` 1.25.3), as
  its released tree: `git archive v1.25.3 | tar -x -C <dir>`. The same `git archive` as a zip with the release's prefix
  reproduces `suds-v1.25.3.zip` byte for byte (SHA-256 `d70101e1…39cc`, the value
  [RELEASE-HANDOFF.md](../RELEASE-HANDOFF.md) records). The repository's `node_modules` was linked in (the exercise
  uses no npm package).
* **Runtime:** Node v22.23.3, the version CI and `deploy/linux/pins` pin (the 1.23.0 drill used v22.22.2), Linux
  6.18.44, 4 CPUs, 16 GB.
* **Commands** (from a checkout of this repository):

  ```bash
  mkdir -p /tmp/tree1253 && git archive v1.25.3 | tar -x -C /tmp/tree1253
  ln -s "$PWD/node_modules" /tmp/tree1253/node_modules
  cd /tmp/tree1253
  node --no-warnings=ExperimentalWarning scripts/dr-exercise.js --clients 20000 --out /tmp/dr-out \
    > /tmp/dr-transcript.txt 2>&1          # exit status 0
  # then: the .json, .txt, .pem and summary.json from /tmp/dr-out, and the transcript, copied here
  ```

  Its console output is [`exercise-transcript.txt`](exercise-transcript.txt), unedited except that the path of the
  scratch directory the evidence was first written to (its last line) reads `<scratch>`. The whole run took 32 s
  (23:50:42.5 to 23:51:15.0 UTC). Exit status 0.

`scripts/dr-exercise.js` runs each step in its own process against a new temporary directory, with four keys
(encryption, index, backup, signing) generated for the run and written to an `escrowed-keys.json` there (what
*Download key backup* gives); it exits non-zero if any step fails, and deletes the directory at the end.

| # | Step | Command / code path | Time | Result |
| --- | --- | --- | --- | --- |
| 1 | Seed the sample data | `npm run seed` (`scripts/seed.js`) | 1.5 s | 12 clients, 140 visits, 70 calls, 45 notes, 15 resources |
| 2 | Add volume | 20,000 fictional clients × 8 visits, each creation audited (`audit.log`) | 14.5 s | 20,012 clients, 160,140 visits, 20,001 audit entries |
| 3 | Seal an audit anchor outside the database | `server/audit-anchor.js` `safeWrite` into `AUDIT_ANCHOR_DIR` | 0.7 s | anchor at audit entry 20,001 |
| 4 | Encrypted backup | the scheduled-backup path, `server/scheduled-backup.js` `run()`: online copy, AES-256-GCM, read back, decrypted and `integrity_check`ed | 5.6 s | 172 MB, `sqlite-online-backup`, verified |
| 5 | Recovery drill with the escrowed keys | `npm run dr-drill -- --backup <file> --keys-file escrowed-keys.json --json` | 6.6 s | **PASSED, 11/11 checks** |
| 6 | Host restore into a fresh data directory | `node scripts/backup.js --restore <file> <fresh>/suds.db` | 2.7 s | 20,012 clients, schema 71 |
| 7 | Serve from the fresh directory | `node server/index.js` on it, poll `GET /api/health` | 3.1 s | HTTP 200 |
| 8 | Row counts | every one of 81 tables in the fresh directory vs the source at backup time | 0.2 s | all equal (audit_log 20,001 → 20,001) |
| 9 | Audit chain | `server/audit.js` `verifyChain()` on the fresh directory | — | ok, 20,001 entries checked |
| 10 | Report signature | `npm run verify-dr-report -- <report.json> --public-key suds-signing-key.pem` | 0.05 s | VERIFIED |

## Drill checks (step 5)

From the signed report [`dr-drill-2026-10-09T23-51-05-085Z.json`](dr-drill-2026-10-09T23-51-05-085Z.json)
(text copy: [`.txt`](dr-drill-2026-10-09T23-51-05-085Z.txt)):

* the escrowed key file (not the keys in the drill process's memory) opens the backup;
* SQLite `integrity_check` passes; the encryption key in custody opens it; schema is at this build's version (71);
* every table holds the rows the backup was taken with (81 tables);
* the audit chain verifies end to end (20,001 entries) and matches the anchors written before the backup (2 matched);
* a sample of every encrypted column decrypts (157 values across every `*_enc` column);
* the restored copy, started in a separate process that never saw the live database's path, answers `/api/health`;
* a throwaway administrator signs in with a password and a TOTP second factor; an authenticated read returns 20,012 clients.

## RTO and RPO measured

| Measure | 1.25.3 (this run) | 1.23.0 (2026-10-01) | 1.21.0 (2026-10-01) | 1.20.0 (2026-09-30) | 1.19.0 (2026-09-30) | 1.16.2 (2026-09-29) | What it measures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **RTO, drill** | **5.6 s** | 4.5 s | 4 s | 3.6 s | 5 s | 3.8 s | from starting the restore (reading and decrypting the backup) to the restored copy answering `/api/health` (report `rto.seconds`) |
| **RTO, host procedure** | **3.1 s** | 3 s | 3.9 s | 2.8 s | 3.7 s | 4 s | from `scripts/backup.js --restore` starting to a server on the fresh data directory answering `/api/health` (summary `host_restore_to_health_seconds`) |
| **RPO, this exercise** | **6 s** | 5 s | 5 s | 5 s | 5 s | 7 s | age of the backup when it was restored (report `rpo.seconds`): near zero only because the backup was taken moments before |
| Backup size | 172 MB | 172 MB | 172 MB | 172 MB | 172 MB | 172 MB | the same fictional volume |
| Schema / tables | 71 / 81 | 67 / 79 | 63 / 76 | 60 / 74 | 59 / 74 | 48 / 59 | |

The drill RTO (5.6 s) is about a second above 1.23.0's and within the 3.6–5.6 s range of the seven runs; the host
procedure (3.1 s) is unchanged. Single runs in a shared development container vary by that much, so the difference
says nothing about 1.25.3. All are far inside the 60-minute target. None includes what a real recovery adds: noticing
the failure, provisioning or reaching the standby host, fetching the offsite copy and the escrowed keys, and
repointing DNS or the proxy. Those are organisational steps, measured only by a production drill.

## Integrity of this evidence

* Report SHA-256 `06f596932cb750d67ea5db53f706a89babfa85af6488ca96e59f632d0f9bc742` and its Ed25519 signature are inside the report file (`integrity`); signing key id `77266bc2beaa1431`.
* Public key: [`suds-signing-key.pem`](suds-signing-key.pem). Verify:
  `npm run verify-dr-report -- docs/evidence/dr-drill-2026-10-09-v1.25.3/dr-drill-2026-10-09T23-51-05-085Z.json --public-key docs/evidence/dr-drill-2026-10-09-v1.25.3/suds-signing-key.pem` → `VERIFIED` (checked again from this branch before it was committed).
* The signing key was generated for this run and discarded with the work directory, so the public key beside the report is the only one that verifies it; that proves the report was not edited after signing, not who ran it. No private key is in this folder.
* Full exercise summary (steps, timings, host, `suds_version` 1.25.3): [`summary.json`](summary.json).

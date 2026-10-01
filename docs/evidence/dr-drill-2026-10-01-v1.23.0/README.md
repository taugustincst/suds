# Recovery drill evidence — 2026-10-01 (SUDS 1.23.0)

> **Development-environment exercise, not a production drill.** It was run on a throwaway database of
> fictional records (the sample data set plus 20,000 synthetic clients), in a 4-core, 16 GB Linux development
> container, with keys generated for the run and deleted with it. It proves that SUDS's own backup and restore
> code paths work end to end on a realistically sized database and measures them. It does **not** prove that a
> county's production backups, offsite share, escrowed keys or hosting can be recovered: that needs the same
> drill on the production server (`npm run dr-drill -- --offsite --keys-file <escrowed keys.json>`, or
> Settings → System & backups → *Run a recovery drill now*), recorded by the county. See
> [BACKUP-AND-DR.md](../../security/BACKUP-AND-DR.md).

This repeats the [1.21.0 exercise](../dr-drill-2026-10-01-v1.21.0/README.md) exactly as it was run, on the
released **SUDS 1.23.0** (schema 67, 79 tables): the same script, the same scale, the same steps. Only the
version, the schema and the numbers differ. It is the sixth development drill (2026-09-25 on 1.11.0,
2026-09-29 on 1.16.2, 2026-09-30 on 1.19.0 and on 1.20.0, 2026-10-01 on 1.21.0, and this one); 1.22.0 was not
drilled on its own, so this run covers what 1.22.0 and 1.23.0 add together. The three tables 1.22.0 adds
(`field_accounts`, migration 64; `county_publication_consents` and `county_publication_inputs`, migration 65)
are among the 79 whose row counts the drill and step 8 compare. The columns migrations 64, 66 and 67 add
(`devices.scope_set_by`, `passkeys.allowlist_grace_until`, `tasks.call_id`, `tasks.intervention_id`) travel with
their tables; none is encrypted. `county_publication_inputs.inputs_enc` is one of the `*_enc` columns the drill's decrypt
sample covers (it is empty here: the sample data publishes nothing to a county, so nothing in it is decrypted).

## What ran, on which commit

* **Code:** `9877d07` ("SBOM of the 1.23.0 stamp", the commit the v1.23.0 tag hand-off names; `package.json`
  1.23.0), as its released tree: `git archive 9877d07 | tar -x -C <dir>` (the files of `suds-v1.23.0.zip`,
  which `release.yml` builds with `git archive` of the tag), with the repository's `node_modules` linked in
  (the exercise uses no npm package).
* **Runtime:** Node v22.22.2 (CI pins 22.23.3), Linux 6.18.44, 4 CPUs, 16 GB. Other development work was running
  in the same container at the time.
* **Commands** (from a checkout of this repository):

  ```bash
  mkdir -p /tmp/tree123 && git archive -o /tmp/tree123.tar 9877d07 && tar -xf /tmp/tree123.tar -C /tmp/tree123
  ln -s "$PWD/node_modules" /tmp/tree123/node_modules
  cd /tmp/tree123
  node --no-warnings=ExperimentalWarning scripts/dr-exercise.js --clients 20000 --out /tmp/dr-out \
    > /tmp/dr-transcript.txt 2>&1          # exit status 0
  # then: the .json, .txt, .pem and summary.json from /tmp/dr-out, and the transcript, copied here
  ```

  Its console output is [`exercise-transcript.txt`](exercise-transcript.txt), unedited (its last line names
  the scratch directory the evidence was first written to). The whole run took 28 s (04:39:19.4 to
  04:39:47.1 UTC). Exit status 0.

`scripts/dr-exercise.js` runs each step in its own process against a new temporary directory, with four keys
(encryption, index, backup, signing) generated for the run and written to an `escrowed-keys.json` there (what
*Download key backup* gives); it exits non-zero if any step fails, and deletes the directory at the end.

| # | Step | Command / code path | Time | Result |
| --- | --- | --- | --- | --- |
| 1 | Seed the sample data | `npm run seed` (`scripts/seed.js`) | 1.1 s | 12 clients, 140 visits, 70 calls, 45 notes, 15 resources |
| 2 | Add volume | 20,000 fictional clients × 8 visits, each creation audited (`audit.log`) | 12.5 s | 20,012 clients, 160,140 visits, 20,001 audit entries |
| 3 | Seal an audit anchor outside the database | `server/audit-anchor.js` `safeWrite` into `AUDIT_ANCHOR_DIR` | 0.1 s | anchor at audit entry 20,001 |
| 4 | Encrypted backup | the scheduled-backup path, `server/scheduled-backup.js` `run()`: online copy, AES-256-GCM, read back, decrypted and `integrity_check`ed | 5.1 s | 172 MB, `sqlite-online-backup`, verified |
| 5 | Recovery drill with the escrowed keys | `npm run dr-drill -- --backup <file> --keys-file escrowed-keys.json --json` | 5.4 s | **PASSED, 11/11 checks** |
| 6 | Host restore into a fresh data directory | `node scripts/backup.js --restore <file> <fresh>/suds.db` | 2.6 s | 20,012 clients, schema 67 |
| 7 | Serve from the fresh directory | `node server/index.js` on it, poll `GET /api/health` | 3.0 s | HTTP 200 |
| 8 | Row counts | every one of 79 tables in the fresh directory vs the source at backup time | 0.3 s | all equal (audit_log 20,001 → 20,001) |
| 9 | Audit chain | `server/audit.js` `verifyChain()` on the fresh directory | — | ok, 20,001 entries checked |
| 10 | Report signature | `npm run verify-dr-report -- <report.json> --public-key suds-signing-key.pem` | 0.05 s | VERIFIED |

## Drill checks (step 5)

From the signed report [`dr-drill-2026-10-01T04-39-38-245Z.json`](dr-drill-2026-10-01T04-39-38-245Z.json)
(text copy: [`.txt`](dr-drill-2026-10-01T04-39-38-245Z.txt)):

* the escrowed key file (not the keys in the drill process's memory) opens the backup;
* SQLite `integrity_check` passes; the encryption key in custody opens it; schema is at this build's version (67);
* every table holds the rows the backup was taken with (79 tables, including `field_accounts`,
  `county_publication_consents` and `county_publication_inputs`, new in 1.22.0);
* the audit chain verifies end to end (20,001 entries) and matches the anchors written before the backup (2 matched);
* a sample of every encrypted column decrypts (157 values across every `*_enc` column);
* the restored copy, started in a separate process that never saw the live database's path, answers `/api/health`;
* a throwaway administrator signs in with a password and a TOTP second factor; an authenticated read returns 20,012 clients.

## RTO and RPO measured

| Measure | 1.23.0 (this run) | 1.21.0 (2026-10-01) | 1.20.0 (2026-09-30) | 1.19.0 (2026-09-30) | 1.16.2 (2026-09-29) | 1.11.0 (2026-09-25) | What it measures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **RTO, drill** | **4.5 s** | 4 s | 3.6 s | 5 s | 3.8 s | 3.3 s | from starting the restore (reading and decrypting the backup) to the restored copy answering `/api/health` (report `rto.seconds`) |
| **RTO, host procedure** | **3 s** | 3.9 s | 2.8 s | 3.7 s | 4 s | 3.8 s | from `scripts/backup.js --restore` starting to a server on the fresh data directory answering `/api/health` (summary `host_restore_to_health_seconds`) |
| **RPO, this exercise** | **5 s** | 5 s | 5 s | 5 s | 7 s | 4 s | age of the backup when it was restored (report `rpo.seconds`): near zero only because the backup was taken moments before |
| Backup size | 172 MB | 172 MB | 172 MB | 172 MB | 172 MB | 128 MB | the same fictional volume |
| Schema / tables | 67 / 79 | 63 / 76 | 60 / 74 | 59 / 74 | 48 / 59 | | |
| RPO, configured | the backup / snapshot interval | | | | | | in production the worst-case loss is the scheduled interval (every 4 hours by default, or the snapshot interval, e.g. 15 minutes, when snapshots are on), shown on Security status as *Recovery point objective (worst case)* |

The six runs are within about a second and a half of each other for the same volume. This one's drill RTO
(4.5 s) is half a second above 1.21.0's and its host procedure (3 s) nearly a second below; with other
development work sharing the container's four CPUs, single runs vary by that much, so neither difference says
anything about 1.23.0. The three new tables are empty in this data set and the four new columns are NULL, so the
backup is the same size (176,168 KB against 176,316 KB). All are far inside the 60-minute target. None includes
what a real recovery adds: noticing the failure, provisioning or reaching the standby host, fetching the offsite
copy and the escrowed keys, and repointing DNS or the proxy. Those are organisational steps, measured only by a
production drill.

## Integrity of this evidence

* Report SHA-256 `378407c92e0c8055daa961fa2a65bf8760007aa1a9257bd974a2581c3f425610` and its Ed25519 signature are inside the report file (`integrity`); signing key id `a7e8f4d1d96d05d1`.
* Public key: [`suds-signing-key.pem`](suds-signing-key.pem). Verify:
  `npm run verify-dr-report -- docs/evidence/dr-drill-2026-10-01-v1.23.0/dr-drill-2026-10-01T04-39-38-245Z.json --public-key docs/evidence/dr-drill-2026-10-01-v1.23.0/suds-signing-key.pem` → `VERIFIED` (checked again from this branch before it was committed).
* The signing key was generated for this run and discarded with the work directory, so the public key beside the report is the only one that verifies it; that proves the report was not edited after signing, not who ran it. No private key is in this folder.
* Full exercise summary (steps, timings, host, `suds_version` 1.23.0): [`summary.json`](summary.json).

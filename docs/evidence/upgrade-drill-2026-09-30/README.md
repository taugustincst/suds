# Upgrade drill evidence — 2026-09-30 (1.16.2 → 1.19.0 and 1.18.0 → 1.19.0)

> **Development-environment exercise, not a production upgrade.** Each run builds a throwaway database with an
> older release's own code (its sample data, 20,000 synthetic clients, and records written through its own API),
> opens it with SUDS 1.19.0, checks it, and then backs it up, restores it and drills it with 1.19.0. Fictional
> data, keys generated for the run and deleted with it, a 4-core, 16 GB Linux development container. It proves
> that 1.19.0's migrations carry a database the older release wrote to a structurally fresh-equivalent schema with
> nothing lost, and that the upgraded database backs up and recovers. It does not replace the operator's own
> upgrade on a staging copy of production (docs/SELF-HOSTING.md, *Upgrading*).

## What ran, on which commits

| | Older release (writes the database) | Newer release (opens, checks, backs up, drills) |
| --- | --- | --- |
| [from-1.16.2/](from-1.16.2/) | **1.16.2**: `git archive v1.16.2` (tag → `b519df7`, "Release 1.16.2"); schema 48, 59 tables | **1.19.0**: `git archive 3dc20dc` ("Release 1.19.0", on `main`); schema 59, 74 tables. Migrations **49 to 59** run |
| [from-1.18.0/](from-1.18.0/) | **1.18.0**: `git archive 39e397e` ("Release 1.18.0"; not tagged); schema 57, 71 tables | **1.19.0**, as above. Migrations **58 and 59** run (56 and 57, the county tables, were 1.18.0's own and hold its rows) |

Node v22.22.2, Linux 6.18.44, 4 CPUs, 16 GB. The driver is [`upgrade-drill.js`](upgrade-drill.js) (this folder;
evidence tooling, not part of the product): it runs every step with the named release's own code, in its own
process, with that release's tree as the working directory, against a new temporary directory. Commands:

```bash
git archive v1.16.2 | tar -x -C /tmp/suds-1.16.2
git archive 39e397e | tar -x -C /tmp/suds-1.18.0
git archive 3dc20dc | tar -x -C /tmp/suds-1.19.0      # each with the repository's node_modules linked in
node docs/evidence/upgrade-drill-2026-09-30/upgrade-drill.js --from /tmp/suds-1.16.2 --to /tmp/suds-1.19.0 --clients 20000 --out <dir>
node docs/evidence/upgrade-drill-2026-09-30/upgrade-drill.js --from /tmp/suds-1.18.0 --to /tmp/suds-1.19.0 --clients 20000 --out <dir>
```

Each folder holds the console output unedited (`transcript.txt`), `summary.json` (every step, its time and what it
observed), the signed drill report of the upgraded database (`dr-drill-*.json`, `.txt`) and the public key that
verifies it (`suds-signing-key.pem`; the private key was generated for the run and deleted with it). Both runs exit
0 with every step PASS (23 of 23 each).

## The steps

**With the older release's code:**

1. `npm run seed` (its sample data: 12 clients, 70 calls, 45 notes and more), then 20,000 fictional clients × 8
   visits, each creation audited (as `scripts/dr-exercise.js` adds volume).
2. Its server (`server/index.js`) started on the data directory and driven through its API: navigator `mrivera`
   writes a note (text with accents and CJK), **signs it** (password) and supervisor `jwalker` **countersigns it**;
   `mrivera` **enrols TOTP** (setup, then a valid code); the signed-in session is kept. On 1.18.0 the administrator
   also makes a county-submission signing key and rotates it (two rows in migration 56's `county_signing_keys`,
   private keys encrypted).
3. An audit anchor sealed outside the database; a manifest: every table's row count, a SHA-256 of the plaintext of
   up to 25 rows of every `*_enc` column (464 values over 33 columns from 1.16.2, 501 over 37 from 1.18.0), the
   note's signature hashes, the users, `verifyChain()`.

**With 1.19.0's code:**

4. Its server started on the same data directory: the upgrade runs at start. Then, through its API: the session the
   old release opened still answers `/api/auth/me`; `mrivera`'s password sign-in asks for the second factor, a wrong
   code is refused (401), nothing is readable before the code (401), the TOTP code signs in (200);
   `GET /api/notes/:id/verify` reports the signature and countersignature intact; a name search finds clients
   (blind indexes).
5. Structure and data: `schema_version` 59, `integrity_check` ok, no foreign-key violations; the schema **identical
   to a fresh install** by `test/migrations.test.js`'s comparison (every table's columns, indexes and triggers),
   against both `schema.sql` executed and a database 1.19.0 created itself; no table lost a row; every sampled
   value decrypts to the same plaintext; the note's hashes unchanged and recomputing to the stored value
   (`server/note-signature.js`); users unchanged, TOTP still enrolled; the audit chain verifies end to end; the
   sessions opened before the upgrade have `sync_client` 0, no `reauth_method`, no `passkey_id`; the pre-migration
   snapshot exists, is sealed, opens with the backup key and holds the old schema version.
6. After the upgrade: an encrypted backup through the scheduled-backup path; `npm run dr-drill -- --backup <file>
   --keys-file <escrowed keys>`; the host restore (`scripts/backup.js --restore`) into a fresh data directory,
   `server/index.js` on it, `mrivera` signs in there with password + TOTP and the note still verifies; row counts
   equal and the audit chain verifies in the fresh directory; `npm run verify-dr-report` with the public key only.

## Results

| | 1.16.2 → 1.19.0 | 1.18.0 → 1.19.0 |
| --- | --- | --- |
| Migrations run | 49–59 | 58–59 |
| Upgrade: 1.19.0 start to `/api/health` 200 (migrations included, 20,012 clients, 160k visits) | 4.0 s | 3.0 s |
| Schema vs fresh install (74 tables) | identical | identical |
| Rows lost | none (changes: `audit_log` +5, `sessions` +2, `settings` +1, from the new release's start and sign-ins) | none (`audit_log` +5, `sessions` +2) |
| Encrypted values compared | 464 / 464 same | 501 / 501 same |
| Signed + countersigned note | hashes unchanged, both intact (direct and `GET /verify`) | same |
| TOTP user | signs in with password + code after the upgrade and in the restored copy | same |
| Audit chain | 20,008 → 20,013 entries, verifies | 20,011 → 20,016, verifies |
| Sessions from the old release | 2, `sync_client` 0, still valid | 3, `sync_client` 0, still valid |
| County rows (56/57) | tables created empty | 2 signing keys kept, private keys decrypt |
| Pre-migration snapshot | `suds.db.v48.….db.enc`, schema 48, 20,012 clients | `suds.db.v57.….db.enc`, schema 57 |
| Backup after the upgrade | 172 MB, verified | 172 MB, verified |
| Drill on it (escrowed keys) | **11/11**, RTO 4.9 s, RPO 4 s | **11/11**, RTO 4.7 s, RPO 5 s |
| Host restore to healthy | 3.6 s | 3.1 s |
| Report verifies (public key only) | VERIFIED, key id `8386a676100406af` | VERIFIED, key id `170121230a64e32a` |

Verify the reports:

```bash
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-09-30/from-1.16.2/dr-drill-2026-09-30T18-42-09-837Z.json --public-key docs/evidence/upgrade-drill-2026-09-30/from-1.16.2/suds-signing-key.pem
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-09-30/from-1.18.0/dr-drill-2026-09-30T18-41-18-508Z.json --public-key docs/evidence/upgrade-drill-2026-09-30/from-1.18.0/suds-signing-key.pem
```

## What `npm test` covers as a result

`test/migrations.test.js` already upgraded databases written by 1.9.4, 1.11.0, 1.13.0, 1.15.3 and 1.16.4 (schema
48, so migrations 56–59 ran on it with their tables empty). Two gaps this drill showed are now closed there:

* **`test/fixtures/release-v1.18.0.sql`** (made by `test/fixtures/make-release-fixture.js --rich` from `39e397e`):
  a database 1.18.0 wrote, with rows in every table that has an encrypted column, including the county tables of
  migrations 56 and 57 (`county_connection`, a single-row table, holds its one row; the fixture maker learned to
  make it). It goes through the same upgrade test as the others: fresh-install shape, no rows lost, every value
  decrypts to what it was, blind indexes, the audit chain.
* **`SUDS 1.19.0's first start on a 1.18.0 database`**: sessions 1.18.0 opened (one signed in, one still owing its
  second factor) survive migrations 58 and 59 with `sync_client` 0, no `reauth_method`, no `passkey_id`; the signed-in
  one still resolves to its user (`auth.resolveSession`) and the other still owes its code; the passkey tables start
  empty; the county rows and the county connection's encrypted token are intact.

The drill itself (20,000 clients, the old releases' servers and API) is not in `npm test`: it takes about 45 s a
run and needs the old releases' trees.

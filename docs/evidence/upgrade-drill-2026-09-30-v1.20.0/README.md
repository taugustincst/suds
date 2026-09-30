# Upgrade drill evidence — 2026-09-30 (1.16.2, 1.18.0 and 1.19.0 → 1.20.0)

> **Development-environment exercise, not a production upgrade.** Each run builds a throwaway database with an
> older release's own code (its sample data, 20,000 synthetic clients, and records written through its own API),
> opens it with SUDS 1.20.0, checks it, and then backs it up, restores it and drills it with 1.20.0. Fictional
> data, keys generated for the run and deleted with it, a 4-core, 16 GB Linux development container. It proves
> that 1.20.0's migrations carry a database the older release wrote to a structurally fresh-equivalent schema with
> nothing lost, and that the upgraded database backs up and recovers. It does not replace the operator's own
> upgrade on a staging copy of production (docs/SELF-HOSTING.md, *Upgrading*).

This repeats the [1.19.0 upgrade drill](../upgrade-drill-2026-09-30/README.md) with 1.20.0 as the newer release,
adds 1.19.0 → 1.20.0, and covers **migration 60** (county-entered figures): `county_submissions` rebuilt from
`schema.sql` while it holds rows, and `county_programmes.on_suds` added. The folder carries a version suffix
because the 1.19.0 drill already holds `upgrade-drill-2026-09-30/`.

## What ran, on which commits

| | Older release (writes the database) | Newer release (opens, checks, backs up, drills) |
| --- | --- | --- |
| [from-1.16.2/](from-1.16.2/) | **1.16.2**: `git archive v1.16.2` (tag → `b519df7`, "Release 1.16.2"); schema 48, 59 tables | **1.20.0**: `git archive 8f365b4` (the v1.20.0 commit, "SBOM of the 1.20.0 stamp"); schema 60, 74 tables. Migrations **49 to 60** run (60 on an empty `county_submissions`: 1.16.2 has no county view) |
| [from-1.18.0/](from-1.18.0/) | **1.18.0**: `git archive 39e397e` ("Release 1.18.0"; not tagged); schema 57, 71 tables | **1.20.0**, as above. Migrations **58, 59 and 60** run; 60 rebuilds `county_submissions` holding 3 signed rows 1.18.0 imported |
| [from-1.19.0/](from-1.19.0/) | **1.19.0**: `git archive 3dc20dc` ("Release 1.19.0"); schema 59, 74 tables | **1.20.0**, as above. Migration **60** runs, on 3 signed rows 1.19.0 imported |

Node v22.22.2, Linux 6.18.44, 4 CPUs, 16 GB. The driver is [`upgrade-drill.js`](upgrade-drill.js) (this folder;
evidence tooling, not part of the product): the 1.19.0 drill's driver with the county steps added (below). It runs
every step with the named release's own code, in its own process, with that release's tree as the working
directory, against a new temporary directory. Commands, from a checkout of this repository:

```bash
mkdir -p /tmp/suds-1.16.2 /tmp/suds-1.18.0 /tmp/suds-1.19.0 /tmp/suds-1.20.0
git archive v1.16.2 | tar -x -C /tmp/suds-1.16.2
git archive 39e397e | tar -x -C /tmp/suds-1.18.0
git archive 3dc20dc | tar -x -C /tmp/suds-1.19.0
git archive 8f365b4 | tar -x -C /tmp/suds-1.20.0
for t in 1.16.2 1.18.0 1.19.0 1.20.0; do ln -s "$PWD/node_modules" /tmp/suds-$t/node_modules; done
for f in 1.16.2 1.18.0 1.19.0; do
  node docs/evidence/upgrade-drill-2026-09-30-v1.20.0/upgrade-drill.js --from /tmp/suds-$f --to /tmp/suds-1.20.0 \
    --clients 20000 --out /tmp/ud-out/from-$f > /tmp/ud-$f.log 2>&1      # exit status 0 each
done
# then each /tmp/ud-out/from-<v>/ copied here, with /tmp/ud-<v>.log as its transcript.txt
```

Each folder holds the console output unedited (`transcript.txt`; its first and last lines name the scratch
directories used), `summary.json` (every step, its time and what it observed), the signed drill report of the
upgraded database (`dr-drill-*.json`, `.txt`) and the public key that verifies it (`suds-signing-key.pem`; the
private key was generated for the run and deleted with it). All three runs exit 0 with every step PASS: 23 of 23
from 1.16.2, 25 of 25 from 1.18.0 and from 1.19.0 (the two county steps run only where the older release has the
county view).

## The steps

**With the older release's code:**

1. `npm run seed` (its sample data), then 20,000 fictional clients × 8 visits, each creation audited (as
   `scripts/dr-exercise.js` adds volume).
2. Its server (`server/index.js`) started on the data directory and driven through its API: navigator `mrivera`
   writes a note (text with accents and CJK), **signs it** (password) and supervisor `jwalker` **countersigns it**;
   `mrivera` **enrols TOTP**; the signed-in session is kept. On 1.18.0 and 1.19.0 the administrator also makes a
   county-submission signing key and rotates it (migration 56's `county_signing_keys`), and then — new in this
   drill — the server acts as its own county: it registers itself as a county programme with its current key
   (`POST /api/county/programmes`), makes its own **signed county files** (`GET /api/county-submission/file`) for
   January–March and April–June 2026 and imports them (`POST /api/county/submissions`), April–June twice, so the
   table holds three signed rows, one **superseded** by another (transcript: `imported, imported, superseded`).
3. An audit anchor sealed outside the database; a manifest: every table's row count, a SHA-256 of the plaintext of
   up to 25 rows of every `*_enc` column, the note's signature hashes, the users, `verifyChain()`, and every county
   submission (id, programme, key, period, hash, signature, `superseded_by`, a SHA-256 of its decrypted payload)
   with each programme and the NOT NULL flags of `key_id` and `signature`.

**With 1.20.0's code:**

4. Its server started on the same data directory: the upgrade runs at start. Then, through its API: the session the
   old release opened still answers `/api/auth/me`; `mrivera`'s password sign-in asks for the second factor, a wrong
   code is refused (401), nothing is readable before the code (401), the TOTP code signs in (200);
   `GET /api/notes/:id/verify` reports the signature and countersignature intact; a name search finds clients
   (blind indexes). **Migration 60 through the API** (1.18.0 and 1.19.0): `GET /api/county/submissions` lists the
   three files as `signed` (two current, one superseded); `GET /api/county/programmes` shows the programme
   `on_suds: true`; the combined view for January–June (`GET /api/county/view`) counts its two current files; and
   the rebuilt table takes 1.20.0's new rows — a programme registered as not on SUDS gets figures the county
   entered (`POST /api/county/programmes/:id/entries`, HTTP 201, `source: county_entered`).
5. Structure and data: `schema_version` 60, `integrity_check` ok, no foreign-key violations; the schema **identical
   to a fresh install** by `test/migrations.test.js`'s comparison (every table's columns, indexes and triggers),
   against both `schema.sql` executed and a database 1.20.0 created itself; no table lost a row; every sampled
   value decrypts to the same plaintext; the note's hashes unchanged and recomputing to the stored value; users
   unchanged, TOTP still enrolled; the audit chain verifies end to end; the sessions opened before the upgrade keep
   `sync_client` 0 and no `passkey_id`; **migration 60**: every county submission the old release wrote is still
   there with the same id, key, signature, hash, `superseded_by` and decrypted payload, now `source = 'signed'`
   with no `entered_via` or `source_ref_enc`; every programme it registered has `on_suds` 1; `key_id` and
   `signature` went from NOT NULL to nullable; the pre-migration snapshot exists, is sealed, opens with the backup
   key and holds the old schema version.
6. After the upgrade: an encrypted backup through the scheduled-backup path; `npm run dr-drill -- --backup <file>
   --keys-file <escrowed keys>`; the host restore (`scripts/backup.js --restore`) into a fresh data directory,
   `server/index.js` on it, `mrivera` signs in there with password + TOTP and the note still verifies; row counts
   equal and the audit chain verifies in the fresh directory; `npm run verify-dr-report` with the public key only.

## Results

| | 1.16.2 → 1.20.0 | 1.18.0 → 1.20.0 | 1.19.0 → 1.20.0 |
| --- | --- | --- | --- |
| Migrations run | 49–60 | 58–60 | 60 |
| Upgrade: 1.20.0 start to `/api/health` 200 (migrations included, 20,012 clients, 160k visits) | 3.7 s | 2.2 s | 2.0 s |
| Schema vs fresh install (74 tables) | identical | identical | identical |
| Rows lost | none (`audit_log` +5, `sessions` +2, `settings` +1, from the new release's start and sign-ins) | none (`audit_log` +11, `sessions` +3; `county_programmes` +1 and `county_submissions` +1 are step 4's entered figures) | none (same as 1.18.0) |
| Encrypted values compared | 464 / 464 same (33 columns) | 504 / 504 same (38 columns) | 504 / 504 same (38 columns) |
| Signed + countersigned note | hashes unchanged, both intact (direct and `GET /verify`) | same | same |
| TOTP user | signs in with password + code after the upgrade and in the restored copy | same | same |
| Audit chain | 20,008 → 20,013 entries, verifies | 20,019 → 20,030, verifies | 20,019 → 20,030, verifies |
| Sessions from the old release | 2, `sync_client` 0, still valid | 3, `sync_client` 0, still valid | 3, `sync_client` 0, `reauth_method` kept (`password`), still valid |
| **Migration 60: county submissions** | table rebuilt empty | **3 / 3 kept unchanged, `source` signed, 1 superseded kept**; listed and counted by the API | **3 / 3 kept unchanged, `source` signed, 1 superseded kept**; listed and counted by the API |
| **Migration 60: `on_suds`** | — (no programmes) | 1 for the programme 1.18.0 registered | 1 for the programme 1.19.0 registered |
| Entered figures in the rebuilt table (1.20.0 API) | — | HTTP 201, `county_entered` | HTTP 201, `county_entered` |
| Pre-migration snapshot | `suds.db.v48.….db.enc`, schema 48, 20,012 clients | `suds.db.v57.….db.enc`, schema 57 | `suds.db.v59.….db.enc`, schema 59 |
| Backup after the upgrade | 172 MB, verified | 172 MB, verified | 172 MB, verified |
| Drill on it (escrowed keys) | **11/11**, RTO 4.4 s, RPO 4 s | **11/11**, RTO 3.6 s, RPO 5 s | **11/11**, RTO 3.3 s, RPO 4 s |
| Host restore to healthy | 3.1 s | 3.2 s | 2.7 s |
| Report verifies (public key only) | VERIFIED, key id `33ba472e049cad2c` | VERIFIED, key id `ea77b149c10a3d6c` | VERIFIED, key id `a7106ce6a5461362` |

Verify the reports:

```bash
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-09-30-v1.20.0/from-1.16.2/dr-drill-2026-09-30T21-13-02-468Z.json --public-key docs/evidence/upgrade-drill-2026-09-30-v1.20.0/from-1.16.2/suds-signing-key.pem
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-09-30-v1.20.0/from-1.18.0/dr-drill-2026-09-30T21-13-39-465Z.json --public-key docs/evidence/upgrade-drill-2026-09-30-v1.20.0/from-1.18.0/suds-signing-key.pem
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-09-30-v1.20.0/from-1.19.0/dr-drill-2026-09-30T21-14-25-491Z.json --public-key docs/evidence/upgrade-drill-2026-09-30-v1.20.0/from-1.19.0/suds-signing-key.pem
```

(each prints `VERIFIED`; checked again from this branch before it was committed).

## What `npm test` covers as a result

`test/migrations.test.js` already upgraded databases written by 1.9.4, 1.11.0, 1.13.0, 1.15.3, 1.16.4 and 1.18.0,
and tested migration 60 on a database shaped by hand like 1.19.0's. Added with this drill:

* **`test/fixtures/release-v1.19.0.sql`** (made by `test/fixtures/make-release-fixture.js --rich` from `3dc20dc`,
  "Release 1.19.0": `git archive 3dc20dc server package.json | tar -x -C <dir>`, then
  `node test/fixtures/make-release-fixture.js <dir> test/fixtures/release-v1.19.0.sql --rich`): a database 1.19.0
  wrote, with rows in every table that has an encrypted column, including three signed `county_submissions` rows.
  It goes through the same upgrade test as the others: fresh-install shape, no rows lost, every value decrypts to
  what it was, blind indexes, the audit chain.
* **`SUDS 1.20.0's first start on a 1.19.0 database`**: on that fixture, with two sessions 1.19.0 opened (one signed
  in, one still owing its second factor): every county submission comes through migration 60 unchanged and as
  `signed` (its payload still decrypts to what it was), every programme gets `on_suds` 1, no foreign-key violation,
  the signed-in session still resolves to its user (`auth.resolveSession`) and the other still owes its code, and
  the audit chain verifies over every entry 1.19.0 wrote.

The drill itself (20,000 clients, the old releases' servers and API) is not in `npm test`: it takes 30 to 50 s a
run and needs the old releases' trees.

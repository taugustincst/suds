# Upgrade drill evidence — 2026-10-01 (1.16.2, 1.19.0 and 1.20.0 → 1.21.0)

> **Development-environment exercise, not a production upgrade.** Each run builds a throwaway database with an
> older release's own code (its sample data, 20,000 synthetic clients, and records written through its own API),
> opens it with SUDS 1.21.0, checks it, and then backs it up, restores it and drills it with 1.21.0. Fictional
> data, keys generated for the run and deleted with it, a 4-core, 16 GB Linux development container. It proves
> that 1.21.0's migrations carry a database the older release wrote to a structurally fresh-equivalent schema with
> nothing lost, and that the upgraded database backs up and recovers. It does not replace the operator's own
> upgrade on a staging copy of production (docs/SELF-HOSTING.md, *Upgrading*).

This repeats the [1.20.0 upgrade drill](../upgrade-drill-2026-09-30-v1.20.0/README.md) with 1.21.0 as the newer
release, adds 1.20.0 → 1.21.0, and covers **migrations 61 to 63**:

* **61** `county_publications` (a new, append-only table): exercised by publishing a screened county release through
  1.21.0's API over the county files and figures the older release kept;
* **62** `devices.sync_scope` (default `'full'`), `scope_changed_at`, `field_applied_at`; `sessions.device_id`;
  `clients.participant_code_enc`/`_idx` and their index: exercised with a sync device that signed in on the older
  release (a `devices` row and a sync session), which signs in again on 1.21.0 and is told scope `full`;
* **63** `passkeys.attestation` and `authenticator_metadata`: exercised with a passkey enrolled and used on the older
  release (1.19.0 and 1.20.0, which have passkeys), which signs in again on 1.21.0.

1.18.0 → 1.21.0 was not run: 1.18.0 → 1.20.0 is in the 1.20.0 drill, and 1.19.0 → 1.21.0 covers everything it adds
(migrations 60 to 63 on county rows 1.19.0 imported). The folder carries a version suffix to match the 1.20.0 one.

## What ran, on which commits

| | Older release (writes the database) | Newer release (opens, checks, backs up, drills) |
| --- | --- | --- |
| [from-1.16.2/](from-1.16.2/) | **1.16.2**: `git archive v1.16.2` (tag → `b519df7`, "Release 1.16.2"); schema 48, 59 tables | **1.21.0**: `git archive 348e18c` (the v1.21.0 commit, "SBOM of the 1.21.0 stamp"); schema 63, 76 tables. Migrations **49 to 63** run (no county view, no passkeys in 1.16.2: the county and passkey tables are made empty) |
| [from-1.19.0/](from-1.19.0/) | **1.19.0**: `git archive 3dc20dc` ("Release 1.19.0"); schema 59, 74 tables | **1.21.0**, as above. Migrations **60 to 63** run, on 3 signed county rows 1.19.0 imported, a passkey, a device and 5 sessions |
| [from-1.20.0/](from-1.20.0/) | **1.20.0**: `git archive 8f365b4` (the v1.20.0 commit); schema 60, 74 tables | **1.21.0**, as above. Migrations **61 to 63** run, on 3 signed county rows and 1 county-entered row 1.20.0 wrote, a passkey, a device and 5 sessions |

Node v22.22.2, Linux 6.18.44, 4 CPUs, 16 GB. The driver is [`upgrade-drill.js`](upgrade-drill.js) (this folder;
evidence tooling, not part of the product): the 1.20.0 drill's driver with the steps below marked *new* added. It
runs every step with the named release's own code, in its own process, with that release's tree as the working
directory, against a new temporary directory; the passkey is answered by this repository's software authenticator
(`test/authenticator.js`, which loads no release code). The runs were made one at a time. Commands, from a checkout
of this repository:

```bash
for c in v1.16.2:1.16.2 3dc20dc:1.19.0 8f365b4:1.20.0 348e18c:1.21.0; do
  mkdir -p /tmp/suds-${c#*:} && git archive -o /tmp/suds-${c#*:}.tar ${c%%:*} && tar -xf /tmp/suds-${c#*:}.tar -C /tmp/suds-${c#*:}
  ln -s "$PWD/node_modules" /tmp/suds-${c#*:}/node_modules
done
for f in 1.20.0 1.19.0 1.16.2; do
  node docs/evidence/upgrade-drill-2026-10-01-v1.21.0/upgrade-drill.js --from /tmp/suds-$f --to /tmp/suds-1.21.0 \
    --clients 20000 --out /tmp/ud-out/from-$f > /tmp/ud-$f.log 2>&1      # exit status 0 each
done
# then each /tmp/ud-out/from-<v>/ copied here, with /tmp/ud-<v>.log as its transcript.txt
```

Each folder holds the console output unedited (`transcript.txt`; its first and last lines name the scratch
directories used), `summary.json` (every step, its time and what it observed), the signed drill report of the
upgraded database (`dr-drill-*.json`, `.txt`) and the public key that verifies it (`suds-signing-key.pem`; the
private key was generated for the run and deleted with it). All three runs exit 0 with every step PASS: **25 of 25**
from 1.16.2, **27 of 27** from 1.19.0 and from 1.20.0 (the two county steps run only where the older release has the
county view).

## The steps

**With the older release's code:**

1. `npm run seed` (its sample data), then 20,000 fictional clients × 8 visits, each creation audited.
2. Its server driven through its API: navigator `mrivera` writes a note (text with accents and CJK), **signs it**
   and supervisor `jwalker` **countersigns it**. *New:* on 1.19.0 and 1.20.0, `mrivera` **enrols a passkey**
   (`POST /api/auth/passkeys/register/options` with the password, then `/register`) and **signs in with it**
   (`/api/auth/passkeys/login`, HTTP 200; that session is kept). *New:* `jwalker` signs in as a **sync device**
   (`X-Sync-Client`, `X-Device-Id: upgrade-drill-device-1`): a `devices` row and a sync session (kept). Then
   `mrivera` **enrols TOTP**; the session is kept. On 1.19.0 and 1.20.0 the administrator makes and rotates a
   county-submission signing key, registers this server as a county programme, makes its own **signed county files**
   for January–March and April–June 2026 and imports them, April–June twice (`imported, imported, superseded`).
   *New:* on 1.20.0, a programme **not on SUDS** gets January–March 2026 figures the **county entered**
   (`POST /api/county/programmes/:id/entries`; `source: county_entered`).
3. An audit anchor sealed outside the database; a manifest: every table's row count, a SHA-256 of the plaintext of up
   to 25 rows of every `*_enc` column, the note's signature hashes, the users, `verifyChain()`, every county
   submission and programme, and *(new)* every row of `sessions`, `devices` and `passkeys` by the columns an
   upgrade must not change.

**With 1.21.0's code:**

4. Its server started on the same data directory: the upgrade runs at start. Then, through its API: the browser
   session the old release opened answers `/api/auth/me`; `mrivera`'s password sign-in asks for the second factor, a
   wrong code is refused (401), nothing is readable before the code (401), the TOTP code signs in (200); the note
   verifies; a name search finds clients. *New:* the **passkey** and **device** sessions the old release opened
   still answer (200); the passkey enrolled on the old release **signs in again** (200); the device **signs in
   again** (200) and is told `device.scope: "full"`. The county (1.19.0, 1.20.0): the three signed files listed as
   `signed` (two current, one superseded), *(new)* 1.20.0's entered quarter listed as `county_entered` for a
   programme `on_suds: false`; the combined view counts the current files; new county-entered figures are accepted;
   and *(new, migration 61)* a **screened county release** for January–March 2026 is prepared
   (`POST /api/county/publications/prepare`, 200) and published (`POST /api/county/publications` with the reviewed
   hash, 201), and is listed.
5. Structure and data: `schema_version` 63, `integrity_check` ok, no foreign-key violations; the schema identical
   to a fresh install by `test/migrations.test.js`'s comparison, against both `schema.sql` executed and a database
   1.21.0 created itself; no table lost a row; every sampled value decrypts to the same plaintext; the note's hashes
   unchanged; users unchanged; the audit chain verifies end to end; *(new)* every session, device and passkey the
   old release wrote is still there with the same values; *(new, migrations 61–63)* `county_publications` holds
   exactly the release published in step 4, `authenticator_metadata` exists and is empty, every device written
   before the upgrade has `sync_scope 'full'` and no `scope_changed_at` or `field_applied_at`, no client has a
   participant code (`participant_code_enc` and `_idx` NULL for all 20,012) and `idx_clients_participant_code`
   exists, every passkey written before has `attestation` NULL, every session opened before has `device_id` NULL;
   every county submission the old release wrote unchanged (id, key, signature, hash, `superseded_by`, decrypted
   payload, and `source`, `entered_via`, `source_ref_enc`), every programme keeps its `on_suds`; the pre-migration
   snapshot exists, is sealed, opens with the backup key and holds the old schema version.
6. After the upgrade: an encrypted backup through the scheduled-backup path; `npm run dr-drill -- --backup <file>
   --keys-file <escrowed keys>`; the host restore into a fresh data directory, `server/index.js` on it, `mrivera`
   signs in there with password + TOTP and the note still verifies; row counts equal and the audit chain verifies in
   the fresh directory; `npm run verify-dr-report` with the public key only.

## Results

| | 1.16.2 → 1.21.0 | 1.19.0 → 1.21.0 | 1.20.0 → 1.21.0 |
| --- | --- | --- | --- |
| Steps | **25 / 25 PASS** | **27 / 27 PASS** | **27 / 27 PASS** |
| Migrations run | 49–63 | 60–63 | 61–63 |
| Upgrade: 1.21.0 start to `/api/health` 200 (migrations included, 20,012 clients, 160k visits) | 4.9 s | 2.9 s | 2.3 s |
| Schema vs fresh install (76 tables) | identical | identical | identical |
| Rows lost | none (`audit_log` +6, `sessions` +3, `settings` +1, from the new release's start and sign-ins) | none (`audit_log` +16, `sessions` +5, `webauthn_challenges` +1; `county_programmes` +1 and `county_submissions` +1 are step 4's entered figures; `county_publications` 1 is step 4's release) | none (`audit_log` +17, `county_programmes` 2 → 3; otherwise as 1.19.0) |
| Encrypted values compared | 464 / 464 same (33 columns) | 504 / 504 same (38 columns) | 506 / 506 same (39 columns) |
| Signed + countersigned note | hashes unchanged, both intact | same | same |
| TOTP user | signs in with password + code after the upgrade and in the restored copy | same | same |
| Audit chain | 20,009 → 20,015 entries, verifies | 20,022 → 20,038, verifies | 20,024 → 20,041, verifies |
| Sessions from the old release | 3 / 3 kept unchanged (browser and device), still answer; `device_id` NULL | 5 / 5 kept (password, passkey, sync device), all answer; `device_id` NULL | 5 / 5 kept, all answer; `device_id` NULL |
| **Migration 62: device** | 1 / 1 kept; `sync_scope` full; signs in again, told `full` | same | same |
| **Migration 62: participant codes** | none on 20,012 clients; index present | same | same |
| **Migration 63: passkey** | — (no passkeys in 1.16.2) | 1 / 1 kept, `attestation` NULL; **signs in again** (200) | same |
| **Migration 61: county release** | — (no county view) | prepared 200, **published 201**, listed; the table holds that 1 | same |
| County submissions | — | **3 / 3 kept unchanged**, `signed`, 1 superseded | **4 / 4 kept unchanged** (3 `signed`, 1 superseded; **1 `county_entered`**, its programme `on_suds` 0) |
| Pre-migration snapshot | `suds.db.v48.….db.enc`, schema 48, 20,012 clients | `suds.db.v59.….db.enc`, schema 59 | `suds.db.v60.….db.enc`, schema 60 |
| Backup after the upgrade | 172 MB, verified | 172 MB, verified | 172 MB, verified |
| Drill on it (escrowed keys) | **11/11**, RTO 3.1 s, RPO 5 s | **11/11**, RTO 3 s, RPO 4 s | **11/11**, RTO 3.1 s, RPO 4 s |
| Host restore to healthy | 3 s | 3 s | 3.8 s |
| Report verifies (public key only) | VERIFIED, key id `9fc14ad916e9bea4` | VERIFIED, key id `2fa85117ba478c75` | VERIFIED, key id `d23e25e5938dd395` |

Against the 1.20.0 drill (1.16.2 → 1.20.0: upgrade 3.7 s, RTO 4.4 s; 1.19.0 → 1.20.0: 2.0 s, 3.3 s), the figures are
the same within a shared container's run-to-run variation; the 1.16.2 upgrade (fifteen migrations over 20,012 clients
and 160,140 visits) is the slowest at 4.9 s.

A note on 1.16.2: its device sign-in has no `sessions.sync_client` to record (migration 59 adds it, 0 for every
existing session, as its comment in `server/db.js` says), so that one sync session comes through as a browser session
with `sync_client` 0. It still answers, and the device's next sign-in on 1.21.0 opens a sync session recording the
device (`device_id`). Not a defect: it is what migration 59 was written to do, and such a session ends within hours.

Verify the reports:

```bash
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-10-01-v1.21.0/from-1.16.2/dr-drill-2026-10-01T00-38-09-263Z.json --public-key docs/evidence/upgrade-drill-2026-10-01-v1.21.0/from-1.16.2/suds-signing-key.pem
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-10-01-v1.21.0/from-1.19.0/dr-drill-2026-10-01T00-37-23-102Z.json --public-key docs/evidence/upgrade-drill-2026-10-01-v1.21.0/from-1.19.0/suds-signing-key.pem
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-10-01-v1.21.0/from-1.20.0/dr-drill-2026-10-01T00-36-36-222Z.json --public-key docs/evidence/upgrade-drill-2026-10-01-v1.21.0/from-1.20.0/suds-signing-key.pem
```

(each prints `VERIFIED`; checked again from this branch before it was committed).

## What `npm test` covers as a result

`test/migrations.test.js` already upgraded databases written by 1.9.4, 1.11.0, 1.13.0, 1.15.3, 1.16.4, 1.18.0 and
1.19.0. Added with this drill:

* **`test/fixtures/release-v1.20.0.sql`**, made by `test/fixtures/make-release-fixture.js --rich` from `8f365b4` (the
  v1.20.0 commit: `git archive 8f365b4`, extracted, then
  `node test/fixtures/make-release-fixture.js <dir> test/fixtures/release-v1.20.0.sql --rich`): a database 1.20.0
  wrote, with rows in every table that has an encrypted column. The maker needed one addition for it: 1.20.0's
  `county_submissions` CHECK ties a signed row to its key and signature and an entered one to neither, which the rows
  `--rich` makes up cannot satisfy, so for a release with `county_submissions.source` the maker now writes the county
  rows through the release's own API, as this drill does (its signed files for two quarters, one superseded, and a
  quarter the county entered for a programme not on SUDS). Older fixtures are made as before. It goes through the
  same upgrade test as the others (fresh-install shape, no rows lost, every value decrypts, blind indexes, the
  audit chain).
* **`SUDS 1.21.0's first start on a 1.20.0 database`**: on that fixture, with a passkey, a sync device and three
  sessions 1.20.0 opened (a passkey sign-in, one still owing its code, a device's sync sign-in): every county
  submission (the signed ones and the county-entered one) comes through unchanged and still decrypts; every programme
  keeps `on_suds`; `county_publications` and `authenticator_metadata` exist, empty; the device keeps every value
  with `sync_scope 'full'`; no client has a participant code; the passkey keeps every value with no attestation; the
  sessions keep theirs with no `device_id`, the passkey one still signs its holder in and the other still owes its
  code; no foreign-key violation; the audit chain verifies over every entry 1.20.0 wrote.

`node --test test/migrations.test.js`: 30 tests, 30 pass (it was 28: the release-fixture loop's new 1.20.0 case and
the first-start test).

The drill itself (20,000 clients, the old releases' servers and API) is not in `npm test`: it takes 38 to 54 s a run
and needs the old releases' trees.

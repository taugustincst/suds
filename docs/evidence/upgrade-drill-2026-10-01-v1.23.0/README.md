# Upgrade drill evidence — 2026-10-01 (1.21.0 and 1.22.0 → 1.23.0)

> **Development-environment exercise, not a production upgrade.** Each run builds a throwaway database with an
> older release's own code (its sample data, 20,000 synthetic clients, and records written through its own API),
> opens it with SUDS 1.23.0, checks it, and then backs it up, restores it and drills it with 1.23.0. Fictional
> data, keys generated for the run and deleted with it, a 4-core, 16 GB Linux development container. It proves
> that 1.23.0's migrations carry a database the older release wrote to a structurally fresh-equivalent schema with
> nothing lost, and that the upgraded database backs up and recovers. It does not replace the operator's own
> upgrade on a staging copy of production (docs/SELF-HOSTING.md, *Upgrading*).

This follows the [1.21.0 upgrade drill](../upgrade-drill-2026-10-01-v1.21.0/README.md) with 1.23.0 as the newer
release, from the two releases before it, and covers **migrations 64 to 67**. 1.22.0 had no upgrade drill of its
own, so the run from 1.21.0 is also the first evidence for 1.22.0's migrations 64 to 66 on a database an older
release wrote. Before the upgrade, each older release holds, written through its own API, what those migrations
touch:

* **64** `field_accounts` and `devices.scope_set_by`: a peer navigator's synced phone narrowed to the **field scope**
  by an administrator (1.21.0 and 1.22.0), beside the supervisor's whole device;
* **65** `county_publication_consents` and `county_publication_inputs`: a **screened county release** of
  January–March 2026 published on the older release, and on 1.22.0 each programme's **written consent to
  publication** before it;
* **66** `passkeys.allowlist_grace_until`: the **authenticator allow-list** turned on over a metadata file, with a
  passkey enrolled before it (1.21.0 refuses it at once; 1.22.0 gives it a **grace period**) and an **attested**
  passkey of the listed model enrolled under it and signed in with;
* **67** `tasks.call_id` and `tasks.intervention_id`: a call and a visit with **follow-up dates**, and the to-dos the
  older release made for them; and a supervisor's **"Finish and sign your note" reminder** on a draft note (both
  releases have it; the 1.23.0 *Remind worker* for referrals is new and has nothing to carry over).

The metadata file is signed under the repository's TEST-ONLY root (`test/fixtures/fido-mds`), which a server
trusts only with `SUDS_ENV` development or test (`SUDS_TEST_FIDO_MDS_ROOT`; never in production), as the browser
suite does; the passkeys are answered by this repository's software authenticator (`test/authenticator.js`) and the
attestation made with `test/x509.js`, neither of which loads release code.

## What ran, on which commits

| | Older release (writes the database) | Newer release (opens, checks, backs up, drills) |
| --- | --- | --- |
| [from-1.21.0/](from-1.21.0/) | **1.21.0**: `git archive 348e18c` (the v1.21.0 commit, "SBOM of the 1.21.0 stamp"); schema 63, 76 tables | **1.23.0**: `git archive 9877d07` (the v1.23.0 commit, "SBOM of the 1.23.0 stamp"); schema 67, 79 tables. Migrations **64 to 67** run |
| [from-1.22.0/](from-1.22.0/) | **1.22.0**: `git archive 8b136df` (the v1.22.0 commit, "SBOM of the 1.22.0 stamp"); schema 66, 79 tables | **1.23.0**, as above. Migration **67** runs |

Node v22.22.2, Linux 6.18.44, 4 CPUs, 16 GB. The driver is [`upgrade-drill.js`](upgrade-drill.js) (this folder;
evidence tooling, not part of the product): the 1.21.0 drill's driver with what migrations 64 to 67 touch added
(its header lists every step). It runs every step with the named release's own code, in its own process, with that
release's tree as the working directory, against a new temporary directory. The runs were made one at a time.
Commands, from a checkout of this repository:

```bash
for c in 348e18c:1.21.0 8b136df:1.22.0 9877d07:1.23.0; do
  mkdir -p /tmp/suds-${c#*:} && git archive -o /tmp/suds-${c#*:}.tar ${c%%:*} && tar -xf /tmp/suds-${c#*:}.tar -C /tmp/suds-${c#*:}
  ln -s "$PWD/node_modules" /tmp/suds-${c#*:}/node_modules
done
for f in 1.22.0 1.21.0; do
  node docs/evidence/upgrade-drill-2026-10-01-v1.23.0/upgrade-drill.js --from /tmp/suds-$f --to /tmp/suds-1.23.0 \
    --clients 20000 --out /tmp/ud-out/from-$f > /tmp/ud-$f.log 2>&1      # exit status 0 each
done
# then each /tmp/ud-out/from-<v>/ copied here, with /tmp/ud-<v>.log as its transcript.txt
```

Each folder holds the console output unedited (`transcript.txt`; its first line names the scratch directories
used), `summary.json` (every step, its time and what it observed), the signed drill report of the upgraded database
(`dr-drill-*.json`, `.txt`) and the public key that verifies it (`suds-signing-key.pem`; the private key was
generated for the run and deleted with it). Both runs exit 0 with every step PASS: **28 of 28** from each. Each
took 53 s.

## The steps

**With the older release's code:**

1. `npm run seed` (its sample data), then 20,000 fictional clients × 8 visits, each creation audited.
2. Its server driven through its API: navigator `mrivera` writes a note, signs it, supervisor `jwalker`
   countersigns it. *New:* the administrator **loads the metadata file** (the password again), clinician `kpatel`
   **enrols a passkey while the list is off**, and the administrator **turns the allow-list on** for one model,
   confirming the one passkey it affects (`kpatel`'s then signs in: 403 on 1.21.0, 200 in its grace period on
   1.22.0). `mrivera` enrols a passkey **of the listed model with a packed attestation** and signs in with it (session
   kept). `jwalker` signs in as a sync device (session kept). *New:* peer navigator `dchen` signs in as a second sync
   device, the administrator **narrows it to the field scope** (`POST /api/admin/devices/:id/scope`), and it signs
   in again told `field` (session kept). `mrivera` enrols TOTP. *New:* `mrivera` records a **call** (follow-up
   20 October) and a **visit** (follow-up 21 October), and the older release makes their to-dos (*Call back: MAT
   intake*, *Follow up: Case Management*); `mrivera` leaves a second note as a **draft**, and `jwalker` sends the
   **reminder** to-do (`POST /api/tasks`, its details ending `Reference: supervision reminder for note <id>`). The
   county as in the 1.21.0 drill (a signing key made and rotated, this server registered as a programme, its signed
   files for two quarters imported, one superseded, a quarter the county entered for a programme not on SUDS). *New:*
   on 1.22.0, **a consent to publication for each programme**; then a **county release of January–March** prepared and
   published.
3. An audit anchor sealed outside the database; a manifest: every table's row count, a SHA-256 of the plaintext of up
   to 25 rows of every `*_enc` column, the note's hashes, the users, `verifyChain()`, the county submissions and
   programmes, and every row of `sessions`, `devices`, `passkeys`, *(new)* `tasks`, `county_publications`,
   `county_publication_consents` and `county_publication_inputs` by the columns an upgrade must not change (as the
   older release had them).

**With 1.23.0's code:**

4. Its server started on the same data directory: the upgrade runs at start. Then, through its API: the browser
   session answers; password + TOTP (a wrong code refused, nothing readable before the code); the note verifies; a
   name search finds clients. The passkey, device and browser sessions the older release opened answer `/api/auth/me`
   (200); the field device's sync session is still recognised and still held to syncing (403 `fieldDevice`, as on
   the older release; an ended session would be 401). The attested passkey **signs in again** (200). *New:*
   `kpatel`'s passkey from before the list is **still refused** (403 `not_allowed`) after 1.21.0 and **still in its
   grace period** (200) after 1.22.0. The whole device is told `full`; the field device **`field`**; and `dchen` on a
   **device the office has never seen** is told `field` too (the scope follows the account: migration 64). *New:*
   `mrivera` **changes the call's and the visit's follow-up dates** (`PUT`, 27 and 28 October): the to-dos the older
   release made **move** to the new dates, and there is still one of each; `mrivera` **signs the draft**, and the
   supervisor's **reminder closes**. The county: the older release's files and entered quarter listed as they were,
   new county-entered figures accepted (April–June); *new:* the older release's **consents current** (1.22.0), or
   consents recorded now (none existed before 1.22.0); the older release's **release listed, withdrawn**, and a
   **corrected release** of January–March **published** from what it was screened from (1.22.0 kept it) or
   **refused** (1.21.0 kept nothing to check it against: 409 `overlap`, the reason migration 65 gives); and a release
   of **April–June published**.
5. Structure and data: `schema_version` 67, `integrity_check` ok, no foreign-key violations; the schema identical to a
   fresh install by `test/migrations.test.js`'s comparison, against both `schema.sql` executed and a database 1.23.0
   created itself; no table lost a row; every sampled value decrypts to the same plaintext; the note's hashes
   unchanged; users unchanged; the audit chain verifies end to end; every kept row unchanged; *(new, migrations 64–67)*
   `field_accounts` holds `dchen` (bound by 1.22.0 as `admin`, or by the migration from 1.21.0's field device as
   `migration`); the devices keep their scopes (1.21.0's with `scope_set_by` NULL, 1.22.0's as it set them) and the
   new one is `field` by `account`; the attested passkey keeps its attestation, `kpatel`'s keeps 1.22.0's grace date
   or none; the allow-list is still on with its model and metadata; exactly the two edited follow-ups' to-dos are
   linked (`call_id`, `intervention_id`) and moved, the reminder is done, and no to-do was added; the older
   release's county release, consents and inputs kept, and what step 4 wrote added; the county submissions unchanged;
   the pre-migration snapshot exists, is sealed, opens with the backup key and holds the old schema version.
6. After the upgrade: an encrypted backup through the scheduled-backup path; `npm run dr-drill -- --backup <file>
   --keys-file <escrowed keys>`; the host restore into a fresh data directory, `server/index.js` on it, `mrivera`
   signs in there with password + TOTP and the note still verifies; row counts equal and the audit chain verifies in
   the fresh directory; `npm run verify-dr-report` with the public key only.

## Results

| | 1.21.0 → 1.23.0 | 1.22.0 → 1.23.0 |
| --- | --- | --- |
| Steps | **28 / 28 PASS** | **28 / 28 PASS** |
| Migrations run | 64–67 | 67 |
| Upgrade: 1.23.0 start to `/api/health` 200 (migrations included, 20,012 clients, 160k visits) | 2.6 s | 2.5 s |
| Schema vs fresh install (79 tables) | identical | identical |
| Rows lost | none (`audit_log` +38, `sessions` +8, `webauthn_challenges` +2, `devices` +1: step 4's sign-ins and the new device; `county_programmes` +1, `county_submissions` +1: step 4's entered figures; `county_publications` 1 → 3, and the new tables' rows: step 4's) | none (`audit_log` +36, `sessions` +9, `county_publications` 1 → 4, `county_publication_inputs` 1 → 3, `county_publication_consents` 2 → 3; otherwise as from 1.21.0) |
| Encrypted values compared | 507 / 507 same (40 columns) | 510 / 510 same (42 columns) |
| Kept rows (by the older release's columns) | sessions 9/9, devices 2/2, passkeys 2/2, tasks 30/30, county_publications 1/1 | sessions 10/10, devices 2/2, passkeys 2/2, tasks 30/30, county_publications 1/1, consents 2/2, inputs 1/1 |
| Signed + countersigned note; TOTP user | hashes unchanged, both intact; signs in after the upgrade and in the restored copy | same |
| Audit chain | 20,041 → 20,079 entries, verifies | 20,044 → 20,080, verifies |
| **Migration 64: field device** | kept `field`, signs in told `field`; `field_accounts` gets `dchen` (`migration`); a new device of `dchen`'s is `field` | kept `field` (`admin`), same; `field_accounts` keeps `dchen` (`admin`) |
| **Migration 65: county release, consents** | 1.21.0's release kept (no inputs); withdrawn; **corrected release refused (409 `overlap`)**; consents recorded for 3 programmes; April–June **published 201** | 1.22.0's release and 2 consents kept; withdrawn; **corrected release published 201**, correcting 1; April–June **published 201** |
| **Migration 66: passkeys under the allow-list** | attested passkey signs in again (200); `kpatel`'s still refused (403), grace NULL | attested passkey signs in again (200); `kpatel`'s still in its grace period (200; until 2026-10-15) |
| **Migration 67: follow-up to-dos, reminder** | call's and visit's to-dos moved 20→27 and 21→28 October, linked, one each; reminder closed on signing | same |
| Pre-migration snapshot | `suds.db.v63.….db.enc`, schema 63, 20,012 clients | `suds.db.v66.….db.enc`, schema 66 |
| Backup after the upgrade | 172 MB, verified | 172 MB, verified |
| Drill on it (escrowed keys) | **11/11**, RTO 3.6 s, RPO 4 s | **11/11**, RTO 4.5 s, RPO 4 s |
| Host restore to healthy | 3.2 s | 2.8 s |
| Report verifies (public key only) | VERIFIED, key id `9f9161ba3f297441` | VERIFIED, key id `a645046a95ce4441` |

Against the 1.21.0 drill (1.20.0 → 1.21.0: upgrade 2.3 s, drill RTO 3.1 s; 1.19.0 → 1.21.0: 2.9 s, 3 s), the figures
are the same within a shared container's run-to-run variation. Migration 67 adds two nullable columns and two
indexes on `tasks`; migrations 64 to 66 add one column and three tables; none rewrites a table, so the upgrade's
time is the server's start on a database of this size.

Two things this drill shows that are by design, not defects, and that an administrator may meet after an upgrade:

* **A release published before 1.22.0 cannot be corrected.** 1.21.0 kept no record of what a release was screened
  from, so once such a release is withdrawn its exact period cannot be published again (409, *"published before SUDS
  kept what a release was screened from"*): migration 65's comment and docs/COUNTY-VIEW.md say so. A county that
  published on 1.21.0 and needs to correct it must publish a different period.
* **A field device's sync session answers only the sync routes** (403 `fieldDevice` on `/api/auth/me`), on the older
  release and on 1.23.0 alike: the drill checks that the session survives the upgrade by that answer, not by a 200.

Verify the reports:

```bash
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-10-01-v1.23.0/from-1.21.0/dr-drill-2026-10-01T04-52-40-033Z.json --public-key docs/evidence/upgrade-drill-2026-10-01-v1.23.0/from-1.21.0/suds-signing-key.pem
npm run verify-dr-report -- docs/evidence/upgrade-drill-2026-10-01-v1.23.0/from-1.22.0/dr-drill-2026-10-01T04-51-39-953Z.json --public-key docs/evidence/upgrade-drill-2026-10-01-v1.23.0/from-1.22.0/suds-signing-key.pem
```

(each prints `VERIFIED`; checked again from this branch before it was committed).

## What `npm test` covers as a result

`test/migrations.test.js` already upgraded databases written by 1.9.4, 1.11.0, 1.13.0, 1.15.3, 1.16.4, 1.18.0,
1.19.0 and 1.20.0. Added with this drill:

* **`test/fixtures/release-v1.22.0.sql`**, made by `test/fixtures/make-release-fixture.js --rich` from `8b136df` (the
  v1.22.0 commit: `git archive 8b136df`, extracted, then
  `node test/fixtures/make-release-fixture.js <dir> test/fixtures/release-v1.22.0.sql --rich`): a database 1.22.0
  wrote, with rows in every table that has an encrypted column. The maker needed one addition for it: a
  `county_publications` row is CHECKed to its content (a release) or to the release it withdraws (a withdrawal), which
  rows `--rich` makes up cannot satisfy, so for a release with county publications the maker now writes them through
  the release's own API, as this drill does (each programme's consent where the release has consents; January–March
  published and withdrawn with a reason; its corrected release where the release keeps inputs; April–June; and one
  consent withdrawn and recorded again). Older fixtures are made as before. It goes through the same upgrade test as
  the others (fresh-install shape, no rows lost, every value decrypts, blind indexes, the audit chain).
* **`SUDS 1.23.0's first start on a 1.22.0 database`**: on that fixture, with what 1.22.0 held besides (a field
  device and its account in `field_accounts`, a whole device, an attested passkey and one in its grace period, their
  sessions and a field device's sync session, a call and a visit with follow-up dates and their to-dos, a supervisor's
  reminder on a draft): every row of the county publication tables, the county submissions and programmes,
  `field_accounts`, devices, passkeys and tasks unchanged **by the columns 1.22.0 had**, and every session; what each
  release was screened from, the withdrawal's reason and each agreement's reference still decrypt; the new `tasks`
  columns NULL on every to-do and their indexes present; the account still held to the field scope and the whole
  device whole; the passkey sessions still sign their holders in; the call's and the visit's to-dos found by title
  and date the first time their dates change (`server/rules/follow-ups.js`), linked and moved, with no second one;
  the reminder closes when the draft is signed; no foreign-key violation; the audit chain verifies over every entry
  1.22.0 wrote.

`node --test test/migrations.test.js`: 32 tests, 32 pass (it was 30: the release-fixture loop's new 1.22.0 case and
the first-start test).

The drill itself (20,000 clients, the old releases' servers and API) is not in `npm test`: it takes about 53 s a run
and needs the old releases' trees.

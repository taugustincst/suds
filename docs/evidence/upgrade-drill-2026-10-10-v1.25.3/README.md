# Upgrade drill evidence — 2026-10-10 (1.23.0, 1.24.0 and 1.25.1 → 1.25.3)

> **Development-environment exercise, not a production upgrade.** Each run builds a throwaway database with an
> older release's own code (its sample data, 20,000 synthetic clients, and records written through its own API),
> opens it with SUDS 1.25.3, checks it, and then backs it up, restores it and drills it with 1.25.3. Fictional
> data, keys generated for the run and deleted with it, a 4-core, 16 GB Linux development container. It proves
> that 1.25.3's migrations carry a database the older release wrote to a structurally fresh-equivalent schema with
> nothing lost, and that the upgraded database backs up and recovers. It does not replace the operator's own
> upgrade on a staging copy of production (docs/SELF-HOSTING.md, *Upgrading*).

This follows the [1.23.0 upgrade drill](../upgrade-drill-2026-10-01-v1.23.0/README.md) with 1.25.3 as the newer
release. No upgrade drill was run for 1.24.0 to 1.25.2, so these three runs are the first stored evidence for
**migrations 68 to 71** on a database an older release wrote:

* **from 1.23.0** (schema 67): migrations **68 to 71** run (68 possible duplicate time, 69 the draft a sign reminder opens,
  70 the incoming-referral tables, 71 the CalOMS dictionary remap);
* **from 1.24.0** (schema 70): migration **71** runs alone, the one that rewrites stored values;
* **from 1.25.1** (schema 71), the release suds.systems was installed from: **no migration**; the upgrade must keep
  everything and take no pre-migration snapshot.

Before the upgrade each older release writes, through its own API, the same records as in the 1.23.0 drill: a signed
and countersigned note, the authenticator allow-list with a passkey from before it and an attested one under it,
TOTP, a whole sync device and a field device, a call and a visit with follow-up to-dos, a draft note and its sign
reminder, the county files, consents and a published county release, and the sessions each opened. The metadata file
is signed under the repository's TEST-ONLY root (`test/fixtures/fido-mds`), which a server trusts only with `SUDS_ENV`
development or test; the passkeys are answered by this repository's software authenticator (`test/authenticator.js`).

## What ran, on which commits

| | Older release (writes the database) | Newer release (opens, checks, backs up, drills) |
| --- | --- | --- |
| [from-1.23.0/](from-1.23.0/) | **1.23.0**: `git archive v1.23.0` (`9877d07`); schema 67, 79 tables | **1.25.3**: `git archive v1.25.3` (`fdd248d0`); schema 71, 81 tables. Migrations **68 to 71** run |
| [from-1.24.0/](from-1.24.0/) | **1.24.0**: `git archive v1.24.0` (`d2fd172`); schema 70, 81 tables | **1.25.3**, as above. Migration **71** runs |
| [from-1.25.1/](from-1.25.1/) | **1.25.1**: `git archive v1.25.1` (`03bdca9a`); schema 71, 81 tables | **1.25.3**, as above. **No migration** |

Node v22.23.3 (the pinned version), Linux 6.18.44, 4 CPUs, 16 GB. The driver is [`upgrade-drill.js`](upgrade-drill.js)
(this folder; evidence tooling, not part of the product): the 1.23.0 drill's driver, unchanged in what it writes, with
three checks brought up to date, each explained in its header:

1. **Migration 71 rewrites stored CalOMS answers on purpose** (1.25.0: the DHCS Data Dictionary v3.0 codes), so a
   sampled `caloms_records.answers_enc` value written before schema 71 is not expected to decrypt to the same
   plaintext. The driver keeps the ciphertext the older release stored, applies **migration 71 as 1.25.3's own
   `server/db.js` defines it** to an in-memory copy of those rows, and checks that the upgraded database holds exactly
   that: every remapped answer, and the clear-text `service_type`. (The 1.23.0 driver, run unchanged from 1.23.0 to
   1.25.3 with 2,000 clients first, failed only this check — 506 of 510 values the same, the 4 others the CalOMS
   records — and the next one.)
2. **From 1.24.0 a whole device's sync session answers `/api/auth/me` with 403 `syncSession`** (CHANGELOG 1.24.0,
   L6: a sync session reaches only signing in, the second step and signing out under `/api/auth/`). The session is
   still recognised (an ended one would be 401), which is now the check, as it already was for a field device.
3. **An upgrade with no migration takes no pre-migration snapshot** (1.25.1 → 1.25.3), and the check is that none
   was made.

The runs were made one at a time. Commands, from a checkout of this repository:

```bash
for v in 1.23.0 1.24.0 1.25.1 1.25.3; do
  mkdir -p /tmp/suds-$v && git archive v$v | tar -x -C /tmp/suds-$v && ln -s "$PWD/node_modules" /tmp/suds-$v/node_modules
done
for f in 1.25.1 1.24.0 1.23.0; do
  node docs/evidence/upgrade-drill-2026-10-10-v1.25.3/upgrade-drill.js --from /tmp/suds-$f --to /tmp/suds-1.25.3 \
    --clients 20000 --out /tmp/ud-out/from-$f > /tmp/ud-$f.log 2>&1      # exit status 0 each
done
# then each /tmp/ud-out/from-<v>/ copied here, with /tmp/ud-<v>.log as its transcript.txt
```

Each folder holds the console output (`transcript.txt`, unedited except that the path of the scratch directory the
release trees were unpacked in reads `<scratch>`), `summary.json` (every step, its time and what it observed), the
signed drill report of the upgraded database (`dr-drill-*.json`, `.txt`) and the public key that verifies it
(`suds-signing-key.pem`; the private key was generated for the run and deleted with it). All three runs exit 0 with
every step PASS: **28 of 28** from each. They took 67 s (from 1.25.1), 90 s (from 1.24.0) and 90 s (from 1.23.0),
from 2026-10-09 23:58:54 to 2026-10-10 00:03:01 UTC.

## The steps

The 1.23.0 drill's six steps ([its README](../upgrade-drill-2026-10-01-v1.23.0/README.md), *The steps*), with 1.25.3
as the newer release: (1) seed and volume, (2) the older release's API as above, (3) an anchor and the manifest, (4)
1.25.3 started on the same directory and driven through its API, (5) structure and data, (6) backup, drill, host
restore and signature.

## Results

| | 1.23.0 → 1.25.3 | 1.24.0 → 1.25.3 | 1.25.1 → 1.25.3 |
| --- | --- | --- | --- |
| Steps | **28 / 28 PASS** | **28 / 28 PASS** | **28 / 28 PASS** |
| Migrations run | 68–71 | 71 | none |
| Upgrade: 1.25.3 start to `/api/health` 200 (migrations included, 20,012 clients, 160k visits) | 3.4 s | 3.1 s | 0.4 s |
| Schema vs fresh install (81 tables), against `schema.sql` and a database 1.25.3 created | identical | identical | identical |
| Rows lost | none (the step-4 additions as in the 1.23.0 drill; `settings` +4; new tables `incoming_referrals`, `incoming_referral_attempts`, empty) | none | none |
| Encrypted values compared | 510 / 510 (42 columns), **4 CalOMS answers equal to migration 71's remap**, `service_type` 4/4 | 567 / 567 (42 columns), **4 CalOMS answers equal to migration 71's remap**, `service_type` 4/4 | 567 / 567 the same |
| Kept rows (by the older release's columns) | sessions 10/10, devices 2/2, passkeys 2/2, tasks 30/30, county releases 1/1, consents 2/2, inputs 1/1 | same | same |
| Kept sessions on 1.25.3 | browser and passkey 200; whole device **403 `syncSession`**; field device 403 `fieldDevice` | same | same |
| Signed + countersigned note; TOTP user | hashes unchanged, both intact; signs in after the upgrade and in the restored copy | same | same |
| Audit chain | 20,046 → 20,083 entries, verifies | same | same |
| Passkeys, devices, follow-ups, county (migrations 64–67, kept from the older release) | attested passkey 200; the one from before the allow-list still in its grace period (200); devices `full` / `field`, a new device of the field account `field`; to-dos moved 20→27 and 21→28 October, one each, reminder closed; the release withdrawn, a corrected one and April–June **published 201** | same | same |
| Pre-migration snapshot | `suds.db.v67.….db.enc`, schema 67, 20,012 clients | `suds.db.v70.….db.enc`, schema 70 | **none, as expected** (no migration) |
| Backup after the upgrade | 172 MB, verified | 172 MB, verified | 172 MB, verified |
| Drill on it (escrowed keys) | **11/11**, RTO 3.9 s, RPO 6 s | **11/11**, RTO 4.1 s, RPO 5 s | **11/11**, RTO 4.1 s, RPO 4 s |
| Host restore to healthy | 3.9 s | 3.9 s | 3.5 s |
| Report verifies (public key only) | VERIFIED, key id `b0fc18d9cd39dba1` | VERIFIED, key id `d117ad5e859afa35` | VERIFIED, key id `9f9385066f4e0479` |

**What this does not show.** Migrations 68 to 70 add columns and tables that start NULL or empty for existing rows
(68 `time_entries.start_time` and `duplicate_of`, 69 `tasks.note_id`, 70 the two incoming-referral tables). The drill
shows they arrive exactly as a fresh install has them and that the older release's rows are kept, among them a sign
reminder made before migration 69, which still closes when its draft is signed; it does not exercise possible-duplicate
time or incoming referrals. Migration 71 is checked value for value only on the sample data's 4 CalOMS records, which
do not hold every old code it maps; `test/migrations.test.js` covers its remapping and its *runs once* rule.

Verify the reports:

```bash
U=docs/evidence/upgrade-drill-2026-10-10-v1.25.3
npm run verify-dr-report -- $U/from-1.23.0/dr-drill-2026-10-10T00-02-44-452Z.json --public-key $U/from-1.23.0/suds-signing-key.pem
npm run verify-dr-report -- $U/from-1.24.0/dr-drill-2026-10-10T00-01-12-807Z.json --public-key $U/from-1.24.0/suds-signing-key.pem
npm run verify-dr-report -- $U/from-1.25.1/dr-drill-2026-10-09T23-59-40-377Z.json --public-key $U/from-1.25.1/suds-signing-key.pem
```

(each prints `VERIFIED`; checked again from this branch before it was committed).

# ADR-0007: Schema migrations policy

- **Status:** accepted
- **Date recorded:** 2026-09-25 (37 migrations at 1.11.0; written down retrospectively)

## Context

A county upgrades by replacing the code and starting it; the database it keeps is the only copy of its
records. An upgrade is the one operation that cannot be retried. The browser kernel (ADR-0002) runs the same
migrations on devices.

## Decision

- **`server/schema.sql` is the only source of schema truth** for a fresh install. `server/schema-text.js` (for
  the browser) and the service-worker version stamp are generated from it (`scripts/gen-schema-text.js`); CI
  fails on drift.
- **Every schema change also gets a migration** appended to the `migrations` array in `server/db.js`. The
  schema version is the array length; migrations are never edited or reordered once released.
- Each migration runs in **one transaction with its version stamp**, foreign keys off (SQLite's table-rebuild
  recipe), followed by `PRAGMA foreign_key_check`: a migration that introduces a new orphan fails and rolls back;
  orphans that were already there are tolerated and reported, never silently dropped.
- Before migrating, a **consistent snapshot** is taken with `VACUUM INTO` into `pre-migration/` (last 5 kept);
  if the snapshot fails the upgrade does not start.
- A database from a **newer** build is refused rather than opened.
- Moving plaintext into an `_enc` column is done by migration (encrypt existing rows, drop the old column), and
  the old name is kept in `legacy` in `server/sync-tables.js` so older devices' pushes are upgraded.

## Consequences

- Fresh install and upgraded install must end up structurally identical; this is tested from a real 1.6.1
  database, so a migration that forgets a column, an index or a trigger fails CI.
- 37 migrations in ten days of development is a high rate. The release-cadence policy in
  [docs/RELEASE.md](../RELEASE.md) limits schema changes to feature releases, so a county does not take a
  migration in a fix release.
- Downgrade is by restoring the pre-migration snapshot or a backup, not by down-migrations.

## Read

`server/db.js` (`migrations`, `migrate`, `snapshotBeforeMigration`, `rebuildTable`), `server/schema.sql`,
`scripts/gen-schema-text.js`, `test/fixtures/schema-v4.sql`.

## Tests that pin it

`test/migrations.test.js` (upgrade a real 1.6.1 database and compare with a fresh install),
`test/name-index-migration.test.js` (a data migration re-deriving indexes), CI step *Local kernel and generated schema
match their sources*.

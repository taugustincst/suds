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
- **Numbering across branches (1.16.0).** Each entry is headed `// N: what it does`, N its position from 1, and
  a new one is appended with the next number. Branches developed in parallel can each write "migration 49"; the
  one merged second renumbers its own, which is why a migration is written self-contained and idempotent.
  `scripts/migration-order.js` (run by `test/migration-order.test.js` in `npm test`; CI's `test` job fetches
  the release tags so it cannot skip) compares the array with the previous release tag's and fails when a
  released migration moved, changed (comments and whitespace aside) or was removed, or a header does not carry
  its position (docs/RELEASE.md, "Migration numbering across branches"). The one exception is a reviewed edit
  recorded in `RELEASED_EDITS` there with the edited code's fingerprint and why it is safe: for a patch, which
  may not add a migration, when a database that already ran the released code is unaffected (first used for
  migration 71's duplicate race codes, evaluation of 1.25.0, E7). A migration that is not idempotent says so in
  its header and relies on running once (migration 71).
- Each migration runs in **one transaction with its version stamp**, foreign keys off (SQLite's table-rebuild
  recipe), followed by `PRAGMA foreign_key_check`: a migration that introduces a new orphan fails and rolls back;
  orphans that were already there are tolerated and reported, never silently dropped.
- Before migrating, a **consistent snapshot** is taken with `VACUUM INTO` into `pre-migration/` (last 5 kept);
  if the snapshot fails the upgrade does not start. Once the upgrade has succeeded the snapshot is **sealed** with the backup key (`<name>.enc`,
  restored like any backup) and the plaintext removed; a sealed snapshot is kept 14 days (1.14.0).
- A database from a **newer** build is refused rather than opened.
- Moving plaintext into an `_enc` column is done by migration (encrypt existing rows, drop the old column), and
  the old name is kept in `legacy` in `server/sync-tables.js` so older devices' pushes are upgraded. An upgrade that did
  so ends with a `VACUUM` and a truncating WAL checkpoint, and every connection runs with `PRAGMA secure_delete`, so
  the old plaintext is not left in free pages (1.14.0; before, it was: security review of 1.13.0, finding 3).

## Consequences

- Fresh install and upgraded install must end up structurally identical; this is tested from real 1.6.1,
  1.9.4, 1.11.0, 1.13.0 and 1.15.3 databases (the last four written by those releases themselves; 1.15.3's is
  schema 48, the starting point for every migration after it, with records whose ciphertext
  must still decrypt afterwards), so a migration that forgets a column, an index or a trigger, or loses a row,
  fails CI. A feature release that adds migrations should add a fixture of the release before it:
  `git archive v<x> server package.json | tar -x -C <dir>`, then `node test/fixtures/make-release-fixture.js <dir> test/fixtures/release-v<x>.sql`.
- 37 migrations in ten days of development is a high rate. The release-cadence policy in
  [docs/RELEASE.md](../RELEASE.md) limits schema changes to feature releases, so a county does not take a
  migration in a fix release.
- Downgrade is by restoring the pre-migration snapshot or a backup, not by down-migrations.

## Read

`server/db.js` (`migrations`, `migrate`, `snapshotBeforeMigration`, `rebuildTable`), `server/schema.sql`,
`scripts/gen-schema-text.js`, `test/fixtures/schema-v4.sql`, `test/fixtures/release-v*.sql`,
`test/fixtures/make-release-fixture.js`.

## Tests that pin it

`test/migrations.test.js` (upgrade real 1.6.1, 1.9.4, 1.11.0, 1.13.0 and 1.15.3 databases and compare with a fresh install),
`test/migration-order.test.js` (released migrations keep their position and code),
`test/name-index-migration.test.js` (a data migration re-deriving indexes), CI step *Local kernel and generated schema
match their sources*.

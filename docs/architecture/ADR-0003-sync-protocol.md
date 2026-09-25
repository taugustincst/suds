# ADR-0003: The sync protocol — pull, push, conflicts, tombstones, fencing

- **Status:** accepted
- **Date recorded:** 2026-09-25 (sync since 1.1.0, hardened release by release since; written down retrospectively)

## Context

A device running the browser kernel (ADR-0002) works offline and must exchange records with the office
server, which is the system of record ([docs/PLATFORM.md](../PLATFORM.md)). Sync must never become a way
round a role's permissions or the disclosure gate, and one bad row must never stop a device syncing again.

## Decision

**Transport.** `GET /api/sync/pull?since=<cursor>` and `POST /api/sync/push` (`server/routes/sync.js`), both
refused when local mode is off on the server. Attachments travel separately via `/api/sync/blob/...`. PHI is
decrypted for transport (TLS, authenticated session) and re-encrypted by the receiver with its own key; blind
indexes are recomputed by the receiver. What syncs, per table, is declared once in `server/sync-tables.js`
(encrypted columns, caseload column, write permission, parent table, blobs).

**Pull.** Rows changed since the cursor that the user may see (caseload scoping applied per table), at most
2,000 per table per response, each page ending on an `updated_at` boundary so no row with the same timestamp
is lost; `complete: false` means "come back". Other users' password hashes are replaced with a dummy. A
client that came onto the user's caseload inside a page's window (an active assignment of theirs created or
changed after the cursor, with none of theirs active before it) arrives whole: that page also carries every
row about the client older than the cursor — notes, consents, visits and the rest, within each table's scope
and read permission (`newlyInScope`, `backfillRows`). Assigning an existing client changes no client row, so
before this the device received the assignment and nothing it pointed at. A client taken off the caseload is
listed in `dropped_clients` for the device to purge; assigned again later, it arrives whole again.

**Push.** Each row is applied in its own savepoint; a failure rejects that row (with a reason the device
shows) and the rest land. Every row passes the same checks as its REST route: write permission, caseload,
Part 2 consent elements, budget-line cycles, cost attachment, attribution, approval fields (a device cannot
approve), signed notes immutable, countersignatures office-only, outcome scores recomputed. A referral that
shares information passes the disclosure gate (ADR-0004) and is accounted.

**Conflicts.** Newest `updated_at` wins, compared in server time (the device's clock offset is measured
each sync). The office copy wins ties. A device edit that loses is **not silent**: the columns that differed
(names, never values) are returned to the device and written to the audit log as `sync.conflict`. A consent
revocation from a device always applies. On the device, `sync_seen` records what was last exchanged so a row
the device never touched is never pushed back with a device timestamp (`local/sync.js`).

**Deletes.** Hard deletes travel as **tombstones** (`tombstones` table, migration 2). A tombstone newer than
a device edit wins. Tombstones are purged after a retention period and the horizon is recorded
(`tombstone_purged_before`); a device whose cursor is older is told `full_resync_required`.

**Fencing and restores.** Two fences: (1) on the device, the IndexedDB epoch fence (ADR-0002) stops a stale
page overwriting the database; (2) on the office, `db_generation` changes when the database is restored from a
backup (`server/backup.js`). A device that sees a new generation forgets what it thought was exchanged and
offers everything again (`resetExchangeState` in `local/sync.js`), so rows accepted after the backup are not
lost. Nothing is marked sent until the server acknowledges it — rows, tombstones and device audit rows.

## Consequences

- Last-writer-wins at row level: concurrent edits to different fields of one row still lose one side, but
  visibly (conflict list + audit). Field-level merge was rejected as too complex to verify.
- Every new synced table or `_enc` column must be declared in `server/sync-tables.js`, or
  `test/sync.test.js` fails.
- Every new REST-side rule for a synced table needs its push-side twin in `server/routes/sync.js`; this is
  the most likely place for a future permission bypass. Review both together.
- Clock skew is tolerated by measuring offset, not by trusting device clocks.

## Read

`server/routes/sync.js` (header comment first), `server/sync-tables.js`, `local/sync.js` (header comment),
`server/audit.js` (`purgeTombstones`), `server/backup.js` (`db_generation`), [docs/PLATFORM.md](../PLATFORM.md).

## Tests that pin it

`test/sync.test.js` (permission and caseload on push, conflicts, tombstones, paging, generation, every
`_enc` column declared), `test/concurrency.test.js`, `test/device-audit.test.js`, `test/devices.test.js`
(revoke / remote wipe), `test/disclosure-gates.test.js` (a device's consent push re-checked); browser scripts
`scripts/ui/sync-two-way.mjs`, `scripts/ui/multitab.mjs`.

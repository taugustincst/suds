# ADR-0006: Append-only, hash-chained audit log with anchors outside the database

- **Status:** accepted
- **Date recorded:** 2026-09-25 (hash chain since 1.0.0; triggers, sealed head and anchors added since; written down retrospectively)

## Context

HIPAA §164.312(b) requires audit controls; county IT asks for "immutable" logs. A log in the same database
as the data can be edited by anyone who can edit the data, and a server administrator holds both.

## Decision

Four layers, each catching what the previous one cannot:

1. **Hash chain.** Each `audit_log` row stores `prev_hash` and `hash = HMAC-SHA-256(index key, row fields |
   prev_hash)` (`server/audit.js` `log`). Rows before the keyed scheme verify under plain SHA-256 (`v2:` prefix
   tells them apart). Editing a row breaks every hash after it for anyone without the key.
2. **Append-only in SQLite.** Triggers `audit_log_no_update` / `audit_log_no_delete` (`server/schema.sql`)
   abort any UPDATE or DELETE unless the maintenance flag (`audit_maintenance` table) is raised inside the same
   transaction — only by the retention purge and index-key re-signing.
3. **Sealed head.** After each verification and purge the newest id, hash and row count are sealed with the
   index key into settings and written to the log file, so truncating the newest rows is detected.
4. **Anchors outside the database.** Every `AUDIT_ANCHOR_HOURS` (default 6), at each scheduled backup and on
   demand, the head is written as a new read-only file (`O_EXCL`) to `AUDIT_ANCHOR_DIR`, each naming the one
   before, optionally also to syslog (`server/audit-anchor.js`). Write-once only if the county points the
   directory at WORM / object-lock storage. Anchors carry no PHI.

Verification runs incrementally (from a sealed marker) and in full weekly; failures open a draft incident.
Signed audit exports (Ed25519) can be verified offline (`scripts/verify-audit-export.js`). What is logged
(by rule — see *Consequences*): PHI reads and writes through the API, sign-ins and failures, permission denials, exports and disclosures,
configuration and user changes, sync and device events. Audit details carry ids and reason codes, never PHI.

## Consequences

- Tamper-**evident**, not tamper-proof: someone with the database, the index key and the anchor storage could
  rewrite history. Separation of duties over the anchor store is the county's.
- Rows are removed only by the retention purge (7 years default, floor 6), which re-seals the head.
- Every new route that reads or writes PHI must call `audit.log` (CLAUDE.md); nothing enforces that
  automatically, so review and the route tests are the control.
- Audit writes are serialised through the one process (ADR-0001), which keeps the chain linear.

## Read

`server/audit.js`, `server/audit-anchor.js`, `server/audit-export.js`, the triggers near the end of
`server/schema.sql`, [docs/security/LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md).

## Tests that pin it

`test/audit-immutable.test.js` (triggers refuse UPDATE/DELETE outside maintenance),
`test/audit-retention.test.js` (retention floor), `test/security-evidence.test.js` (anchors, sealed head,
signed audit export), `test/api.test.js` (chain verification), `test/device-audit.test.js` (device audit rows
uploaded at sync).

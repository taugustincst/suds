# SUDS architecture: system map and decision records

For a new maintainer, a county's code owner ([docs/ADOPTION.md](../ADOPTION.md) §1) or a reviewer who has to
answer "does anyone understand how this works?". The security view of the same system, with trust boundaries
and data flows, is [docs/security/ARCHITECTURE.md](../security/ARCHITECTURE.md).

## How SUDS has been built — and why this folder exists

Most of SUDS was written with an AI coding assistant: of the 286 commits up to 1.12.4, 255 are authored by
Claude and 31 by the owner, over eleven days, with 41 schema migrations and 26 releases (1.12.0–1.12.4 in one
day, against the release policy — [docs/RELEASE.md](../RELEASE.md) records why and what now enforces it).
The owner set the direction, the rules in `CLAUDE.md` and the tests the work had to pass, and reviewed and
merged it. Automated gates carry much of the weight: several hundred API tests, a browser suite with
accessibility checks, CI drift checks and the release gate.

That pace creates a bus-factor risk: the reasoning behind the hardest parts (sync, the disclosure gate, the
audit chain) lived in code comments and commit messages. These decision records write it down, each with the
files to read and the tests that would fail if it were broken. This page and the records describe the code
as it is after 1.12.4 (*Since 1.11.0*, below, lists what changed). If you change one of these areas, update
its record in the same change.

## System map

```
                         ┌──────────────────────────── office server (one Node.js process, ADR-0001) ─────────────────────────────┐
 Browser (public/,       │ server/http.js ─> server/app.js pipeline: TLS/headers, CSP, rate limit, session (auth.js), CSRF        │
 vanilla ES modules) ──HTTPS──>   └─> route modules (server/routes/*.js, the one list in app.js)                                  │
                         │          ├─ RBAC matrix + caseload scoping ........ server/auth.js                                     │
                         │          ├─ generic client-scoped CRUD ............ server/crud.js                                     │
                         │          ├─ encryption / blind indexes ............ server/crypto.js            (ADR-0005)             │
                         │          ├─ audit log, anchors .................... server/audit.js, audit-anchor.js (ADR-0006)       │
                         │          ├─ disclosure gate + accounting .......... server/disclosure.js        (ADR-0004)             │
                         │          └─ SQLite (node:sqlite), migrations ...... server/db.js, schema.sql    (ADR-0007)             │
                         │   background: scheduled backups + offsite copy, audit verification + anchors, retention purge          │
                         └─────┬───────────────────────┬─────────────────────────────┬────────────────────────────────────────────┘
                               │ /api/sync (ADR-0003)  │ FHIR R4 / bulk export,       │ files: identified export, EHR hand-off,
                               │ local mode, off by    │ OAuth2 client credentials    │ CalOMS extract — all through the
                               ▼ default               ▼ (consent-enforced)           ▼ disclosure gate
 Device: local/kernel.js = the same server modules bundled for the browser (ADR-0002), sql.js in IndexedDB,
         sealed under a password-wrapped key (ADR-0008), fenced single writer; also published alone as
         "SUDS on this device" (GitHub Pages, no sync).
```

## Decision records

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-0001](ADR-0001-single-process-sqlite.md) | One process, one SQLite database per programme; second process refused | accepted |
| [ADR-0002](ADR-0002-browser-kernel.md) | The same server code compiled into the browser kernel | accepted |
| [ADR-0003](ADR-0003-sync-protocol.md) | Sync: pull/push, conflicts, tombstones, fencing | accepted |
| [ADR-0004](ADR-0004-disclosure-gate.md) | One disclosure gate for every path that leaves the programme | accepted |
| [ADR-0005](ADR-0005-encryption-and-blind-indexes.md) | Field-level encryption and blind indexes | accepted |
| [ADR-0006](ADR-0006-append-only-audit.md) | Append-only, hash-chained audit with external anchors | accepted |
| [ADR-0007](ADR-0007-migrations.md) | Schema migrations policy | accepted |
| [ADR-0008](ADR-0008-device-encryption.md) | The device database sealed under a key only an account password opens | accepted |
| [ADR-0009](ADR-0009-publication-release.md) | One audited publication release per ended period, shared by the funder, NDP and settlement reports; the submission to the funder first | accepted (statistical review pending) |

New decisions: copy the shape (status, date, context, decision, consequences, read, tests), number the next
one, and link it here. Supersede rather than delete.

## Since 1.11.0: what a maintainer of the 1.11 code needs to know

| Area | What it is now | Read | Tests |
| --- | --- | --- | --- |
| **Sync backfill paging** | A pull that finds newly assigned clients ends there; their existing rows follow in *backfill pages* of at most the page limit, table by table in keyset order, with the position carried in the cursor (1.12.0 sent them all on one page: 25 MB for one busy client). | ADR-0003; `server/routes/sync.js` (`newlyInScope`, `backfillPage`), `local/sync.js` | `test/sync-backfill.test.js` |
| **Device vault** | The on-device database is sealed under a random data key, wrapped once per device account under its password; the device is locked after every page load until someone signs in. | ADR-0008; `local/vault.js`, `local/kernel.js` (top), `local/shims/sqlite.js` (sealing, fencing) | `test/device-vault.test.js`, `scripts/ui/device-encryption.mjs` |
| **Backup lock** | One in-process FIFO lock for everything that copies or replaces the whole database (scheduled backup, snapshot, recovery drill, restore); timers skip their turn while a restore waits; a restore's post-swap steps complete or it is rolled back. | `server/backup-lock.js`, `server/backup.js` (`restoreWhenIdle`) | `test/backup-restore-race.test.js` |
| **Instance lock** | The lock file records host, container identity (root-mount digest, pid namespace, machine id), boot id and start time, and is heartbeated; another host's or container's lock is judged by its heartbeat alone, this host's by process facts. | ADR-0001; `server/instance-lock.js` (header) | `test/instance-lock.test.js` |
| **Programme profile** | A harm-reduction programme by default; the clinical modules (care plan, assessments, CalOMS, FHIR, EHR hand-off) are switched on per programme. Presentation and new-work gating, not permissions. | `server/programme.js` | `test/programme.test.js`, `test/programme-default.test.js` |
| **Publication release** | The funder, NDP and settlement reports for an ended period are one release, audited as a whole for what a reader of all three could work out (`server/sdc.js`), in a worker thread, on a budget of solver work; a table the check cannot show protected is withheld. A supervisor's default run is the submission to the funder (exact); anything but a release needs `reports:internal`. | ADR-0009; `server/publication-release.js`, `server/release-audit.js`, `server/sdc.js`, `server/small-cells.js` | `test/publication-release*.test.js` (full sweeps in the `thorough` CI job) |
| **Health probes** | `/api/health/live` (liveness) and `/api/health/ready` (readiness) are separate from `/api/health` (operational status for alerting), so a platform does not restart-loop SUDS over a warning. | `server/routes/app.js`; DEPLOYMENT.md 4b | `test/health-probes.test.js` |
| **Release governance** | The release gate also refuses a patch release that adds a migration, permission or route, unless overridden (`allow_patch_changes`, printed in the notes). | `scripts/release-gate.js`, `scripts/release-policy.js`; RELEASE.md | `test/release-gate.test.js`, `test/release-policy.test.js` |

Test layers added with them: `test/kernel-parity.test.js` bundles the kernel from the current sources and runs
one flow through it under sql.js in Node against the office server's answers; `test/migrations.test.js`
upgrades databases written by 1.6.1, 1.9.4 and 1.11.0; performance checks live in `test/thorough/` and run in
the `thorough` CI job (`npm run test:thorough`), not in `npm test`.

## Read these first (a new maintainer's first two days)

1. `CLAUDE.md` — the project rules. They bind people as much as the AI assistant.
2. [docs/PLATFORM.md](../PLATFORM.md) — the two ways SUDS runs and which copy is the system of record.
3. `server/app.js` then `server/auth.js` — every request's path, and who may do what.
4. `server/disclosure.js` (its header comment) and [ADR-0004](ADR-0004-disclosure-gate.md).
5. `server/routes/sync.js` and `local/sync.js` (header comments) with [ADR-0003](ADR-0003-sync-protocol.md).
6. `server/audit.js` and [ADR-0006](ADR-0006-append-only-audit.md).
7. `server/db.js` (`migrate`) and `test/migrations.test.js`.
8. [docs/HIPAA.md](../HIPAA.md), *Risk register notes* — the known weaknesses, in the maintainer's own words.
9. [docs/RELEASE.md](../RELEASE.md) — the release gate and cadence.

Then run `npm test`, `npm run seed && npm start`, and `scripts/ui/run-all.sh`, and read one failing test's
assertion message on purpose (change a permission in `server/auth.js`, watch which tests catch it, revert).

## Where the knowledge is thinnest

Honest list, for whoever reviews or takes over: the push-side rules in `server/routes/sync.js` duplicate
REST-route rules by hand (a new REST check needs its sync twin; plan below); `server/disclosure.js`'s legal
characterisations are the maintainer's reading and are flagged for counsel; the browser lock and fence in
`local/shims/sqlite.js` are tested only in a real browser (`scripts/ui/multitab.mjs`) — the kernel's request
path and the sql.js layer are now also run in Node (`test/kernel-parity.test.js`), but with one window and an
in-memory IndexedDB, so not its locking.

### Plan: one validator per table for REST and sync push

Not done in the 1.12.4 engineering review: `server/routes/sync.js` was being changed at the same time (sync
scopes), and moving every push rule at once is the kind of change that ships a hole. The plan, in steps that
each leave both paths tested:

1. **Inventory.** For each table in `server/sync-tables.js`, list the checks its REST route makes (validation
   shape, ownership — `OWNER` in sync.js mirrors `crud.js restrictOwner` —, consent elements, court-order
   fields, programme-module gating, server-owned columns) and the ones `push()` makes. A test fails for any
   table whose REST checks have no push counterpart, starting from today's known list.
2. **Extract, one table at a time**, into `server/validators/<table>.js` exporting
   `check(row, { user, existing, via: 'rest'|'sync' })` → `null` or a reason. The REST route and `push()`
   both call it; the reason text keeps sync's permanent-rejection phrasing (`sync-tables.js`). Consents and
   court orders first (their push checks, `consentPushProblem` and `courtOrderPushProblem`, are already
   separate functions), then the owner-scoped tables, then the rest.
3. **Pin it:** for each extracted table, a table-driven test sends the same bad row through REST and through
   `/api/sync/push` and requires both to refuse it (`test/sync.test.js` has the push half for several).
4. When every table has a validator, `sync-tables.js` declares it and the inventory test becomes "every synced
   table has one".

Each step is a patch-sized change with no migration, permission or route, so it can ship in fix releases. No person other than
the owner has yet reviewed the code end to end; an independent code review and penetration test are open items
in [docs/market/EVALUATION-RESPONSE.md](../market/EVALUATION-RESPONSE.md).

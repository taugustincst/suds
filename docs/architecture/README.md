# SUDS architecture: system map and decision records

For a new maintainer, a county's code owner ([docs/ADOPTION.md](../ADOPTION.md) §1) or a reviewer who has to
answer "does anyone understand how this works?". The security view of the same system, with trust boundaries
and data flows, is [docs/security/ARCHITECTURE.md](../security/ARCHITECTURE.md).

## How SUDS has been built — and why this folder exists

Most of SUDS was written with an AI coding assistant: of the 202 commits up to 1.11.0, 171 are authored by
Claude and 31 by the owner, over ten days, with 37 schema migrations and 21 releases. The owner set the
direction, the rules in `CLAUDE.md` and the tests the work had to pass, and reviewed and merged it. Automated
gates carry much of the weight: several hundred API tests, a browser suite with accessibility checks, and CI
drift checks.

That pace creates a bus-factor risk: the reasoning behind the hardest parts (sync, the disclosure gate, the
audit chain) lived in code comments and commit messages. These decision records write it down, each with the
files to read and the tests that would fail if it were broken. They describe the code as it is at 1.11.0.
If you change one of these areas, update its record in the same change.

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

New decisions: copy the shape (status, date, context, decision, consequences, read, tests), number the next
one, and link it here. Supersede rather than delete.

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
REST-route rules by hand (a new REST check needs its sync twin); `server/disclosure.js`'s legal
characterisations are the maintainer's reading and are flagged for counsel; the browser lock and fence in
`local/shims/sqlite.js` are tested only in a real browser (`scripts/ui/multitab.mjs`). No person other than
the owner has yet reviewed the code end to end; an independent code review and penetration test are open items
in [docs/market/EVALUATION-RESPONSE.md](../market/EVALUATION-RESPONSE.md).

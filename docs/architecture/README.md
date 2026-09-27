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
                         │          ├─ per-table rules, REST and sync push ... server/rules/ (+ push.js)                          │
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

Honest list, for whoever reviews or takes over: the rules a table's rows must satisfy are now declared once
and enforced at both doors (below), but a few REST routes still keep an action-shaped check of their own beside
them (CalOMS answer validation, completing a client form, re-opening an episode); `server/disclosure.js`'s legal
characterisations are the maintainer's reading and are flagged for counsel; the browser lock and fence in
`local/shims/sqlite.js` are tested only in a real browser (`scripts/ui/multitab.mjs`) — the kernel's request
path and the sql.js layer are now also run in Node (`test/kernel-parity.test.js`), but with one window and an
in-memory IndexedDB, so not its locking.

### Per-table rules: one declaration for REST and sync push (1.14.0)

Up to 1.13.0 `push()` in `server/routes/sync.js` (327 lines, 85 branches) re-implemented each REST route's checks
by hand, and a check added to a route had to be remembered in sync too; the 1.12.4 review found the two had
drifted. Now every synchronised table has **one rules declaration**, `server/rules/<table>.js`, read by both
doors:

```
                 REST routes                                        sync push (a device's rows)
  server/crud.js (8 tables) + hand-written routes          server/rules/push.js: prepare → authorise → validate
        │ shape = R.fields  canEdit = R.editableBy                  → resolve (last write wins) → normalise → apply
        │ restrictOwner = R.owner  rules.assertWrite()                        │
        └──────────────────────────► server/rules/<table>.js ◄──────────────────┘
                   fields · owner · editableBy/deletableBy · check · module · immutable · tombstone
```

A declaration (`server/rules/core.js` documents every key) holds the table's **fields** as the REST API names
them (a `validate.js` shape; `x` is the column `x_enc` when that is encrypted), **owner** (who did the work, and
the permission that may name someone else), **editableBy / deletableBy** (the REST edit and delete rule),
**check** (whether the values hang together: Part 2 consent elements, a budget line's room, one open episode),
**module** (the programme module that gates new work), **immutable** / **allowChange** (the legal record) and
push-only hooks (**normalise** for the columns the office keeps for itself, **afterApply** for side effects such
as the supply draw-down). `crud.build` takes its shape, canEdit and owner rule from it and runs its check on every
create and update; the hand-written routes call `rules.assertWrite(table, row, ctx, { existing })` and
`rules.assertEditable(...)` where they used to check inline. `push()` is now `new PushSession(user, payload).run()`:
a loop over tables and rows, each row in its own savepoint, through the stages above.

A refusal is **fatal** (the row is rejected for good, as REST refuses it) or **flagged**: a rule that depends on
the office's configuration or clock (a Settings → Lists value, a length limit, a module switch, a fund's period or
status, a second open episode, a disclosure basis the office cannot confirm). A flagged row still lands — it was
done offline under what the device had — and the device is told (`warnings[].flagged`) and the audit trail
records `sync.conflict` with `kept: 'device'`. Over REST every refusal is an error.

**Adding a table** (a supply ledger, a new instrument): declare it in `server/sync-tables.js` as before, write
`server/rules/<table>.js` with `define({ table, fields, ... })`, and add one line to `DECLARED` in
`server/rules/index.js` (static, because the browser kernel is bundled). Use `crud.build` for its REST routes, or
call `rules.assertWrite` from hand-written ones. `test/sync-rules-fixes.test.js` fails for a synced table with no
rules; add the table to `test/sync-rules.test.js` (`T`, plus its expected outcomes in
`test/fixtures/sync-rules-expect.js`, which `SUDS_CHARACTERISE=1` prints).

**Pinned by** `test/sync-rules.test.js`: for 28 tables, the same rows (valid, each invalid field, a client off the
caseload, another worker's record with and without a client, a role without the permission, the module off, a
tombstone, a device clock two hours fast, a lost update) through push and through REST, compared with
`test/fixtures/sync-rules-expect.js` — recorded against 1.13.0 first, so the refactor ran under it, with every
changed entry marked "was:". `test/sync-rules-fixes.test.js` checks what each decision below stores.
`test/thorough/sync-push-perf.test.js` times a 10,000-row push. Measured A/B in one process against the 1.13.0
`push()` (alternating, ten rounds, CPU time): 1.13.0 a median of 1,473 ms, 1.14.0 1,000 ms. The field checks
cost about 5%; asking each client's purge, merge and caseload questions once per push instead of once per row
(`PushSession.memo`) and reading each Settings → Lists list once per push (`options.cached`) more than repay it.

#### Where REST and sync disagreed, and what was decided

The rule: the stricter door wins, unless refusing would throw away work done offline, in which case the row lands
flagged. Each is an entry in the expectations file.

| Table | 1.13.0 push | 1.14.0 (both doors) |
| --- | --- | --- |
| every table | none of the REST shape checked (a 5,000-minute visit, a negative fund total, an unknown ASAM level landed) | the REST shape's types, fixed sets, ranges and required fields refuse; a Settings → Lists value or a length limit is flagged |
| interventions, calls, overdose, time, referrals, tasks, expenditures, patient requests, notes (drafts), ASAM, outcome measures, imports | another worker's record on a shared client could be edited and deleted by sync | the REST edit/delete rule (its worker, its author or a manager) refuses; the side effects of someone's own work still land (a discharge cancelling the client's to-dos, a referral's outcome, a consent revocation flagging referrals, an approver's ruling) |
| interventions, calls, overdose, time, tasks, expenditures | another worker's record with no client could be deleted by a tombstone | refused, as over REST |
| care plan, assessments, CalOMS | a module switched off at the office took pushes silently | flagged (REST refuses new work) |
| clients | an edit winning last-write-wins could lift a legal hold, set `deleted_at` or `merged_into` | those columns are the office's unless the user holds clients:legal-hold / clients:all / clients:merge; impossible contact details and closing a client with an episode open are flagged |
| assignments | a deactivated worker could be assigned; a discharge's end of the care team was refused without assignments:manage | the first refuses; the second lands, as POST /api/episodes/:id/close does it |
| episodes | a second open episode, a discharge before admission, deleting an episode | flagged; refused; ignored (no route deletes one) |
| interventions | a clientless case-management visit, a cost with no line or a line of another fund | refused (a cost outside its fund's period is flagged) |
| overdose events | `reported_by` could name anyone | attribution rule as for visits |
| expenditures | an approved item's amount could be changed by its submitter; an inactive fund or a line of another fund | refused; flagged; refused |
| referrals | could cite another client's consent | refused |
| notes | a signed note's title, format, date and links, and a clinical note's kind, could be changed; a note could arrive signed by someone else | kept as signed; kind fixed; refused |
| note addenda | an addendum made offline left the signed note "signed" | the note is marked amended, as over REST |
| disclosures | a manual disclosure recorded on a device was never checked | checked against the same gate; kept and flagged when unconfirmed (it records something that happened) |
| court orders, §2.22 notices | could be rewritten by sync (no REST route edits them) | immutable; an order can still be vacated |
| budget lines, funds | over-allocation, a line its own parent, a period that ends before it starts | refused |
| problems, goals, steps | bad ICD-10/Z codes, a goal on another client's problem, deleting others' goals and steps, deleting a problem | refused; ignored for problems and their history |
| client forms, attachments | a completed form edited or deleted without forms:manage; completed with required answers missing; more than 10 files | refused; flagged; flagged |
| patient requests | needed consents:write by sync, patient-requests:write over REST | patient-requests:write (crud.js now refuses to start if the two ever differ) |
| supply ledger (new in 1.14.0) | push checked kind, item, site, quantity, date, reason and permission (`ledgerPushProblem`) | also: a lot number's characters and damaged/expired/lost only taken off (refused), a fund only on a purchase and only a real one (refused), an item or site the office has retired (flagged: the delivery arrived); a lot taken below zero stays a flagged shortfall (`settlePushedEntry`) where REST refuses up front |
| visits' supply lines (new in 1.14.0) | checked as their visit (`linePushProblem`) | unchanged, now the table's authorise; the draw-down still runs once the whole push has landed (the interventions rules' `finish`), and a deleted visit or line puts back what it drew (`afterDelete`) |
| visits (supplies) | the supply site a pushed visit names was not checked | an unknown site is refused; one retired at the office is flagged (REST refuses a new one) |
| SUPRT-A assessments (new in 1.14.0) | nothing but clients:write and caseload | the REST checks, shared: fields and the answers the instrument asks refuse; the module, a future date, completeness and the order of a cycle are flagged (they depend on the office, or another device's baseline); the type is fixed once recorded, `exported_at` and the record-management answers are the office's, and one in a SPARS file is never deleted by sync |

The unlinked-row owner rule has one source, `server/sync-tables.js` (`clientOrNullScope` for SQL — pull, exports,
REST lists — and `mayReachUnlinked` for one row, which push asks before a device changes or deletes such a row).
The supply routes (`server/routes/supplies.js`) keep their action-shaped checks (a receipt, a transfer, an
adjustment); the ledger's push rules mirror them rather than share code, because the route builds the row.

Kept as they were, deliberately: a creator column (`created_by`) arrives as the device recorded it (a shared phone
carries several workers' work); a tombstone for shared reference data (resources, templates) still needs
clients:all, where REST soft-deletes; CalOMS answers are validated by `server/caloms.js` over REST only.

No person other than the owner has yet reviewed the code end to end; an independent code review and penetration test are open items
in [docs/market/EVALUATION-RESPONSE.md](../market/EVALUATION-RESPONSE.md).

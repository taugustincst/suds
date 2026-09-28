# Performance at scale

How SUDS behaves with a large programme's records, how to measure it, and what 1.14.0 changed and why. The
numbers below were taken on the development container (4 vCPU, Node 22, SQLite through `node:sqlite`) with the
benchmark in `scripts/bench/`; your hardware will differ, the ratios should not.

## Measuring

```sh
node scripts/bench/run.js --out after.json                 # seeds, measures, removes its data (about 4 minutes)
node scripts/bench/run.js --root ../suds-1.13 --out before.json   # the same harness against another checkout
node scripts/bench/run.js --compare before.json after.json # a Markdown table of the two
node scripts/bench/run.js --small                          # a tenth of the size, to try the harness out
node scripts/bench/frontend.mjs [--root <checkout>]        # first load on a phone over a mobile connection
```

`run.js` seeds (`scripts/bench/seed.js`, built on the reporting tests' `test/fixtures/funder-scale.js`) a
programme of **20,000 clients, 100,000 visits, 200,000 notes, 20,000 calls, a supply ledger of 50,000 rows,
2,000 SUPRT-A records and 300,000 audit entries**, with every client's name, date of birth, phone and address
encrypted and blind-indexed as the API writes them, a note body on every note, a navigator with a 2,000-client
caseload, fifty more with 400 each, and one client with 5,000 events. It removes SQLite's planner statistics
(`--analyze` keeps them): SUDS has never run `ANALYZE`, so a database in service has none, and the queries are
measured as an office runs them. Then it measures, in-process, each request's wall time and the longest the
event loop was held while it ran (`max_stall_ms`: how long anyone else's request would have waited), the
bytes of JSON and the bytes on the wire; and, against the real server process, start-up time, memory, and
fifty navigators working at once (client list, a client, their timeline, saving a visit that hands out
supplies) for twenty seconds.

`frontend.mjs` starts a server on a small seeded programme and drives a 390 px Chromium with the network at
"slow 4G" (150 ms round trip, 1.6 Mbit/s) and the CPU slowed four times: the sign-in page on a first visit and
a return visit (Largest Contentful Paint, when the form can be used, requests and kilobytes), signing in to
Home, and opening Clients and Supplies for the first time. The service worker is blocked, so what is measured is
what the server lets the browser keep.

The machine was shared with other work while these ran (load average 3–5 on 4 CPUs), so single figures move by
10–20% between runs; the changes below are far larger than that.

## Results (1.13 + the 1.14.0 streams, before and after this work)

Server, at 20,000 clients (`scripts/bench/run.js`; wall time / longest event-loop hold, in ms; the two runs
back to back on the same machine):

| What | Before | After |
|---|---|---|
| Home dashboard, fiscal year, administrator | 1,556 / 356 | 389 / 153 |
| Home dashboard, fiscal year, navigator (2,000 clients) | 680 / 144 | 221 / 59 |
| Home dashboard, last 90 days, administrator | 543 / 327 | 191 / 49 |
| Supplies page (`GET /api/supplies`) | 306 / 293; 485 kB | 37 / 25; 23 kB on the wire |
| Supplies alerts (Home, for whoever runs the cupboard) | 183 / 178 | 26 / 18 |
| Client list, administrator, page 100 | 114 / 109 | 39 / 30 |
| Client list, administrator, sorted by last contact | 188 / 183 | 193 / 186 (unchanged: see below) |
| Client list and search, navigator | 18–35 | 18–31 |
| Client timeline, 5,000 events, page 5 | 65 / 60 | 12 / 6 |
| Visits list, administrator, page 1 | 99 / 93 | 23 / 16 |
| Visits list, administrator, a fiscal year | 344 / 338 | 28 / 20 |
| Visits list, navigator | 101 / 95 | 71 / 64 |
| Notes list, navigator | 145 / 139 | 28 / 21 |
| Saving a visit that hands out 3 items (first-expiry-first-out draw-down), average | 12 | 6 |
| First sync of a 2,000-client caseload: 30 pages, 104,000 rows | 19.1 s; worst page 4,159; 79.5 MB | 5.5 s; worst page 237; 5.1 MB on the wire (79.7 MB of JSON) |
| First sync, administrator, 5 pages | 1,377; worst page 336; 25 MB | 1,025; worst page 322; 1.8 MB |
| Sync with nothing new | 161 / 156 | 23 / 9 |
| An audit entry (hash-chained, committed) | 292 µs | 262 µs |
| Server start-up to `/api/health/live`; memory | 201 ms; 81 MB | 202 ms; 81 MB |
| 50 navigators at once for 20 s (client list, a client, their timeline, save a visit) | 167 requests/s; p50/p95 ms: list 433/571, client 355/553, timeline 175/229, save 250/312; 187 MB | 248 requests/s; list 250/456, client 182/319, timeline 157/353, save 143/346; 159 MB |

The first sync's worst page was 4 seconds because a caseload that arrives inside a page's window is backfilled,
and the query that finds the newly assigned clients (a `NOT EXISTS` over the worker's own assignments) ran once
for each of 45 tables, at 0.3 s each; it now runs once per page, from `idx_assign_caseload`, in 3 ms. With
SQLite's planner statistics (`--analyze`) the old worst page was 0.5 s, the rest much the same.

A phone's first load (`scripts/bench/frontend.mjs`: 390 px, slow 4G, CPU slowed four times; 2,000 clients):

| What | Before | After |
|---|---|---|
| Sign-in page, first visit: Largest Contentful Paint; usable; downloaded | 5.8 s; 5.8 s; 954 kB in 45 requests | 1.5 s; 1.5 s; 85 kB in 13 requests |
| Sign-in page, return visit | 5.8 s; 5.8 s; 954 kB | 1.1 s; 1.1 s; 8 kB |
| Signing in to Home (administrator), until it shows | 9.2 s; 1,396 kB in 43 requests | 2.2 s; 80 kB in 26 requests |
| Opening Supplies the first time | 3.0 s; 555 kB | 0.4 s; 26 kB |
| Opening Clients the first time | 1.1 s; 115 kB | 0.8 s; 23 kB |

Under 50 navigators at once the server is bounded by committing: every audited request commits its audit entry
on its own, and a saved visit commits the visit, its draw-down and their audit entries separately (22% of the
server's time under that load). That is deliberate; see "Decided against".

## What changed, and why

**Compressed responses.** JSON answers of 1 kB or more are compressed when the request accepts it: brotli
(quality 4) when the browser offers it, which it does over HTTPS, else gzip. The work runs on libuv's thread
pool (`zlib`'s asynchronous API), never on the event loop (`server/http.js` `sendJsonTo`). A request without
`Accept-Encoding`, or with `q=0` for both, gets exactly the bytes it always did. Downloads that write their own
answer — CSV and spreadsheet exports, a document's file, a backup — are untouched: a workbook and a PDF are
already compressed, and a stream is not buffered to be squeezed. Compression is not a BREACH risk here: that
attack needs the victim's browser to send authenticated cross-site requests that reflect text the attacker
chose, and the session cookie is `SameSite=Strict`, so a cross-site request carries no session at all. A
first sync's 80 MB of JSON is about 4 MB on the wire.

**The app's files.** The modules, stylesheet and icons are compressed once per file (brotli at its best
setting, on the thread pool), kept in memory against the file's size and modification time, and sent
`Cache-Control: no-cache` with an ETag, so a return visit costs a 304 per file instead of the whole file. The
HTML pages, the service worker and `version.json` stay `no-store`; the versioned kernel stays immutable. None of
these files holds anything about a client, and the service worker already keeps the same files for offline use.
The modules' URLs cannot carry a version without a build step (an ES module's relative imports drop the query
string), so they are revalidated rather than kept for a year.

**Pages load when opened.** `public/main.js` imports the sign-in page and Home; every other page's module is
fetched the first time it is opened (`app.js` `lazyRoute`), and the sign-in page's module no longer pulls in
Administration. (`index.html` briefly preloaded the first screen's modules with `<link rel="modulepreload">`;
that was dropped before release: WebKit served the preloaded `app.js` from its HTTP cache without asking the
service worker, so on a host that sends `max-age` (GitHub Pages) a phone could keep running the previous build
after an update. Measured again without it, on the same 390 px, slow-4G, 4x-CPU profile: sign-in page usable in
1.6 s (1.5 s with it), Home in 2.2 s (unchanged), 87 kB in 13 requests: lazy loading is what made the difference.) Signing in renders Home once (it rendered twice, and fetched everything twice),
and Home asks for everything at once where it used to wait for each answer before asking the next question.

**Sync pull in two passes.** A device's pull used to read each table's first 2,000 rows whole, and then throw
most of them away, because every table's page ends at the same instant and another table's ended earlier: a
first sync read every row of the caseload again on each of its 30 pages. The first pass now reads only
timestamps, from indexes that carry the client and the owner with `updated_at` (`idx_*_sync`), to find where the
page ends; the second reads whole rows only for what it sends. A table with nothing newer than the device's
cursor (one index lookup) is skipped, so an incremental sync reads almost nothing. Pages, cursors and rows are
exactly those of the one-pass version (`test/perf-sync.test.js` walks both). A backfill page (the rows of
clients newly assigned to the worker) works out which clients arrived once, not once per table.

**Home.** The dashboard read the clients eight times, the period's visits four times (each whole row) and its
calls six times. It now reads each once, grouped by everything the figures break down by, and adds up the
figures from the groups; the visits come from a covering index (`idx_interventions_dashboard`) and the
unsigned-notes alert from a partial index of drafts (`idx_notes_drafts`). The figures and the order of every list
are unchanged (`test/perf-dashboard.test.js` runs the 1.13 queries beside it, ties and NULLs included).

**Supplies.** On hand is the sum of the ledger. The Supplies page summed the whole ledger twice, then again for
each item at each site, and found each item's last movement by sorting its rows. It now sums once, from a
covering index (`idx_supply_ledger_onhand`, which replaces `idx_supply_ledger_stock` with `quantity` added), and
reads the last movement from `idx_supply_ledger_item_created`. A visit's draw-down reads its lots from the same
index.

**Lists.** The client list, the notes list and a client's timeline find their page before reading its rows:
the client list used to work out who is assigned, last contact and overdue to-dos for every client before
sorting and keeping 50; the notes list sorted a caseload's notes, bodies and all, to keep 100
(`idx_notes_list`, which replaces `idx_notes_client`, holds what it filters on); the timeline decrypted every row
it fetched rather than the page it shows. A list's total no longer makes lookups that cannot change it (a
`LEFT JOIN` on a primary key, `server/crud.js` `countJoins`): 90 ms on every page of the visits list. A note's
addenda are counted from an index (`idx_note_addenda_note`; there was none).

**Every request.** Prepared statements are kept and reused (`server/db.js`), the time zone's date formatters are
made once (`server/routes/budget.js`), a timeline reads each list's labels once, a client list decrypts the six
fields a row shows rather than all sixteen, and a caseload is read from one index (`idx_assign_caseload`, which
replaces `idx_assign_user`).

Migration 47 creates the new indexes and drops the four they replace. On the 20,000-client database (710 MB)
the first start after the upgrade takes 9 seconds, most of it the pre-migration snapshot every migration takes
(`server/db.js`); later starts are unchanged.

## Decided against

- **`PRAGMA synchronous = NORMAL`.** Each audited request commits its audit entry with an fsync. NORMAL would
  roughly halve the cost of a write, and could lose the last moments of the audit trail and of PHI writes on a
  power cut. Durability of the record is not traded for speed.
- **Batching audit writes across requests** (group commit). An entry must be in the chain before the answer
  that it records goes out.
- **Caching the audit chain's head in memory** to skip one indexed read per entry: key rotation and the
  retention purge rewrite the head, and the saving is microseconds.
- **Running `ANALYZE` or `PRAGMA optimize`.** Statistics would change query plans across the application,
  including the reporting stream's, in ways no test pins down. Every plan measured here is good without them.
- **A columnar sync payload** (column names once, rows as arrays). Compression already removes the repeated keys
  on the wire, and a new format would need every device's kernel to understand it.
- **Yielding inside a sync page.** A page reads every table at one instant; yielding between tables would let
  writes land between them. The page's work is now small enough not to need it.
- **Sorting 20,000 clients by last contact.** The administrator's client list sorted by last contact (or by risk,
  or filtered to "not contacted in 30 days") works out every client's last visit and call: 9 µs a client, 190 ms
  for 20,000. A grouped join would be faster for the whole programme and slower for a caseload; the page is now
  found first, so only the sort key is worked out for every client, and the other columns for the 50 shown.
- **Deep offsets.** The visits list at offset 50,000 still walks 50,000 rows (220 ms). The screens page by 100
  and nobody pages that far; keyset paging would change the API.
- **Versioned URLs for the app's modules.** It needs a build step to rewrite imports (or an import map, which
  the Content-Security-Policy would have to allow inline); revalidation gets most of the benefit.

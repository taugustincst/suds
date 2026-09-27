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

RESULTS_TABLE

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
Administration. `index.html` preloads the five modules the first screen needs, so they arrive together rather
than one import level at a time. Signing in renders Home once (it rendered twice, and fetched everything twice),
and Home asks for everything at once where it used to wait for each answer before asking the next question.

**Sync pull in two passes.** A device's pull used to read each table's first 2,000 rows whole, and then throw
most of them away, because every table's page ends at the same instant and another table's ended earlier: a
first sync read every row of the caseload again on each of its 30 pages. The first pass now reads only
timestamps, from indexes that carry the client and the owner with `updated_at` (`idx_*_sync`), to find where the
page ends; the second reads whole rows only for what it sends. A table with nothing newer than the device's
cursor (one index lookup) is skipped, so an incremental sync reads almost nothing. Pages, cursors and rows are
exactly those of the one-pass version (`test/perf-sync.test.js` walks both).

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
made once (`server/routes/budget.js`), and a timeline reads each list's labels once.

Migration 46 creates the new indexes and drops the three they replace; on the 20,000-client database it takes
about three seconds, once, after the usual pre-migration snapshot.

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
- **Versioned URLs for the app's modules.** It needs a build step to rewrite imports (or an import map, which
  the Content-Security-Policy would have to allow inline); revalidation gets most of the benefit.

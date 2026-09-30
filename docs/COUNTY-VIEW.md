# The county view

*Released in 1.18.0. Tier 1 of [market/DATA-NETWORK.md](market/DATA-NETWORK.md): county aggregates from
exact submissions.*

A county that funds harm-reduction and treatment programmes with opioid settlement money needs to see, in one
place, what each programme spent and what it did with it. Each programme already sends the county its figures
under its funding contract. The county view puts those figures side by side and adds them up without any client of
any programme ever reaching the county. By default there is no link between the programmes' SUDS servers and the
county's: the signed file is the transport. The **county connection** ([Connecting](#connecting), below) is an
optional link, off unless the county switches it on, that carries the same signed file and nothing else.

It has two halves:

- **Send to the county** (a programme's server): on **Reports › Settlement outcomes**, a person who files the
  programme's funder submission makes a **county submission file** for a period (by default the last complete
  quarter), for one county, from the settlement funds that county pays for: a signed JSON file. The programme sends
  it to the county the way the county asks (email, the county's file drop); or, where the county has switched on the
  county connection, SUDS posts the same file to the county's server (see *Connecting*).
- **County view** (the county's own SUDS server): the county gives each programme its **county code**, registers
  each programme it funds by the public key the programme gives it, imports the files the programmes send, and sees
  them combined for a period (or quarter by quarter), on screen and as Excel, CSV or a long "tidy" CSV. For a
  grantee that does not run SUDS, the county's own staff enter its figures, marked everywhere as entered by the
  county (built for 1.20.0, not yet released: [County-entered figures](#county-entered-figures)).

The screens say "program" (US spelling, as Settings › Program does); this document keeps the codebase's
"programme".

`npm run seed` stays a programme's data. To try the county side on a development server:

- `node scripts/county-sample.js --register` registers three fictional programmes in this machine's development
  database (the one `npm run dev` serves) and imports their signed files for the last two complete quarters, made
  for that database's own county code: a presenter is set up in under a minute. It refuses to run when `SUDS_ENV` or
  `NODE_ENV` is `production`, before it reads any configuration.
- `node scripts/county-sample.js <dir> --county-code ABCD-EFGH` writes the programmes' public keys
  (`programmes.json`) and their files, made for the county whose code is given, to register and import by hand (or
  through the API, as the browser suite does). Nothing touches a database.
- `--register` also registers a fourth programme **not on SUDS** (Canyon Mobile Outreach) with figures entered by the
  county for the same two quarters (built for 1.20.0, not yet released; *County-entered figures*, below).

## What the file holds

The figures the Settlement outcomes page already computes (`server/settlement-outcomes.js` `figures()`, the same
code, never a second count), **for the settlement funds the person ticked**, at the exact level the county receives
under its contract today:

| Part | Holds |
| --- | --- |
| Header | Schema version, the programme's name (Settings › Program), the **recipient** (the county's code and name), the period, when it was made (`generated_at`), the SUDS version, `counts: "exact"` |
| Each chosen settlement fund | Its name, grant or agreement number, Exhibit E allowable use and California High Impact Abatement Activity; spending under its own category, under other categories, approved and pending; and its outcomes |
| Each allowable use of the chosen funds | Spending under it and its outcomes |
| All the chosen funds | Spending (approved, pending) and outcomes, counted over those funds alone |

The outcomes are the thirteen of the Settlement outcomes page (`server/settlement-outcome-map.js`): contacts,
naloxone kits, fentanyl test strips, syringes, reversals reported, people served, referrals made, people linked to
care (a referral admitted or completed: what the county means by a referral closed), people linked to medication
for OUD, treatment admissions, education sessions, people trained and staff training hours.

**Never in it:** a client, client code, participant code, name, date of birth, date of service, record id or any
single event. The payload is an **allow-list** (`server/county.js` `PAYLOAD`): the file is checked against it when
it is made, and again when the county imports it, and anything else refuses it. `payloadFrom` refuses figures that
lack a value the list expects (never a quiet 0). `test/county.test.js` walks a real file and fails on any key outside
the list or any client's name, code or date of birth inside it, and **freezes** the list (the values included) for
schema version 1: changing it is a new schema version.

### Which funds go in (data minimisation)

The card lists every settlement fund; **nothing is ticked until the person chooses**, and only the ticked funds go
into the file: their own rows, their categories, and every total counted over them alone (`figures(range,
{ fundIds })`, so a fund left out adds to nothing, the programme's people-served count included). After the first
file, the funds chosen for that county (by its code) are ticked again. Why not "every settlement fund" by default: a
programme often holds settlement money from more than one source (the county's share, a city's, the state's), and
sending the city's fund to the county is exactly the over-disclosure to avoid; SUDS cannot tell reliably which
funder is the county. Choosing once, then having it remembered, is safe and one click a quarter.

### Text a person typed

The programme's name, each fund's name and grant number, and the county's name are typed by people (the CBO's
administrators). They travel in the signed file and are shown on the county's screens and in its spreadsheets, so
they are held to one form: **no control characters** (C0, DEL, C1), no bidirectional overrides or isolates, no line
or paragraph separators, single spaces, trimmed, and at most 200 characters (a grant number 100). The programme's
server writes them that way (`cleanText`); the county's refuses a file whose text is not already in that form (a
signed file cannot be tidied without breaking its signature). `generated_at` must be strict ISO-8601 UTC as
`toISOString` writes it (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`, a real instant that reads back as itself), not before the
period's last day and not more than a day in the future; `suds_version` is at most 40 of `0-9 A-Z a-z . + -`. Only
the checked `generated_at`, programme name and version are kept in plain columns; the figures are in `payload_enc`.

Small numbers are **exact**, by design: the county receives exact figures under its funding contract today. The
file is for the county under that contract, **not for publication**, and the page says so. It is aggregate and
carries no PHI, so it is not a Part 2 disclosure and does not go through the disclosure gate; but it leaves the
programme, so making it is audited (`county_submission.export`) with the period, the county code, the key's
fingerprint and the SHA-256 of the payload (never the figures), and the page says in plain words that it leaves the
programme.

Who may make it: whoever files the funder submission (`reports:funder`) and sees the budget (`budget:read`), with
`export:read` for the file: finance, supervisors and administrators by default.

### The period

The card has its own period, apart from the page's dates: the **last complete calendar quarter** by default; the
eight quarters before today, each also named as its **California fiscal-year quarter** (the fiscal year runs July to
June: July to September is FY Q1); the last whole fiscal years; the last calendar year; and the dates on the page
when they have ended. The period is shown beside the button, and the button names it. A period that is not a single
quarter is warned about (a longer file counts only toward a period that contains it whole). A period that **ends
today or later is refused** ("the period is not over yet"): a quarter's file is made from the day after it ends. A
date must be a real day (`isDay`: not 2026-02-30), on both sides.

## The trust model

**Signed files, keys exchanged out of band, a county code to address them.**

- Each programme's office server has an **Ed25519 key** for county files, made the first time one is asked for —
  **Show the key for the county** makes it without making a file (`county_signing_keys`). The private half (the
  32-byte seed) is encrypted with the database key (`private_key_enc`, AES-256-GCM), so key rotation re-encrypts it
  with every other secret column and a copy of the database without the key file does not hold it. It is a separate
  key from the office's evidence-signing key (`SUDS_SIGNING_KEY`, the audit export and recovery-drill report): a
  county trusts it for one purpose only.
- The page shows the **public key** and its **fingerprint** (each with a Copy button; the key wraps on a phone): the
  first 32 hex characters of SHA-256 over the key's DER encoding, read out as eight groups of four. The programme
  gives the county the public key (email is fine: it is public) and **reads the fingerprint out** (by phone, at a
  contract meeting): that is what makes the key the programme's and not someone else's.
- The county registers the programme with that public key. SUDS shows the key's fingerprint as it is pasted, and
  **requires** either the fingerprint the county was read, typed (a key that does not match is refused), or an
  explicit tick: *I compared the fingerprint shown with the one the program read out, and they match*. The audit
  entry records which (`checked: typed | compared`).
- **The county code** (`settings.county_code`): eight Crockford base-32 characters (no I, L, O or U), shown as
  `ABCD-EFGH` on County view › Programs with a Copy button, made the first time it is asked for (audited
  `county.code.create`). The programme types it on its card; the file carries it signed (`recipient.county_code`,
  with the county's name as the programme typed it); **an import refuses a file whose code is not this county's**,
  saying which county it was made for. The code identifies the county; it is not a secret and proves nothing (the
  signature does that): it stops a file made for one county being loaded into another's figures. Why a code and not
  the county's name: names are typed differently by every programme, and a code is exact and short enough to read
  out with the fingerprint.
- A file carries its payload, a signature over the payload's **canonical serialisation** and the fingerprint of
  the key that made it. The canonical form is JSON with every object's keys sorted (by UTF-16 code unit), no
  whitespace, arrays in order, strings and numbers exactly as `JSON.stringify` writes them, and only finite numbers
  (`server/county.js` `canonical()`); so the bytes signed do not depend on how the file was laid out or re-saved.
- On import the county's server checks, in order: the size (256 KB at most); that it is JSON and a SUDS county
  submission of this schema version; the payload's allow-list, types, text and period (real dates, the start on or
  before the end, the end not after today, made after its period ended); that it is **for this county**; that the
  fingerprint is a **registered** key of an **active** programme; the **signature** under that key; that the same
  payload has not come from that programme before (a duplicate changes nothing); and that a new file is signed with
  the programme's **current** key. Any failure refuses the whole file with a sentence saying why (`reason`:
  `malformed`, `too_large`, `format`, `schema`, `period`, `recipient`, `unknown_key`, `inactive`, `signature`,
  `retired_key`), audited as `county.submission.refuse` with the reason (never the figures). Refusals are throttled
  (20 per person per 10 minutes); a throttled attempt is audited once per window (`county.submission.throttled`).
- Messages give dates as people read them ("Apr 1, 2026 to Jun 30, 2026").

What the signature does not do: it proves the file came from the server holding that key and was not changed, not
that the figures are right. The figures are what the programme recorded in SUDS, as on its own Settlement outcomes
page.

### Which file counts for a period: supersession by the signed time

Of one programme's files for **exactly the same period**, the one **made last** counts: the signed `generated_at`
(then the one received last), whatever order they arrive in. The others are kept, marked replaced
(`superseded_by`). So a corrected file sent after the first replaces it; **an older file that arrives after a newer
one is stored already replaced**, and the import says so ("it does not count: it was made on …, before the one that
counts"). The same payload twice from one programme is one submission; the duplicate check is per programme
(`UNIQUE(programme_id, sha256)`), so another programme's file is never "already imported".

### Withdraw and reinstate

A county manager can **withdraw** a file that counts, with a reason (kept in the audit entry,
`county.submission.withdraw`, with the file's identity and which file counts again — never figures). It is kept and
counts for nothing, and **whatever it had replaced for the same period counts again** (the rule above is applied
afresh, `resettle()`). A replaced file cannot be withdrawn (it does not count; withdraw the one that replaced it).
A withdrawn file can be **reinstated** (`POST /api/county/submissions/:id/reinstate`, `county.submission.reinstate`):
it takes its place by the same rule, so it counts again unless a file made later for the period counts. Importing a
withdrawn file again changes nothing and says to reinstate it (one path, not two).

### Key history (the county side)

Each programme has **one column** in the combined view and a **history of keys** (`county_programme_keys`): the
current one and the ones it replaced, each with when it was added and replaced.

- **Keys › Replace the key**: the programme's new public key, checked like a registration (fingerprint typed, or
  compared). The old key is kept with `replaced_at`. Files the old key signed **that were already imported keep
  counting**; a **new** file signed with the old key is refused (`retired_key`). A key a programme used before, or
  another programme's key, cannot be added.
- **Old key compromised — stop counting its files**: ticked when replacing, or later on the old key's row
  (`compromised_at`), every file that key signed stops counting (and the rule is applied afresh, so an earlier file
  of the same period by a trusted key counts again). It can be undone (**Trust again**). The current key cannot be
  marked compromised: replace it first. Audited `county.programme.key.replace`, `.compromised`, `.trusted`.
- A fingerprint belongs to one programme only.

### Key rotation (the programme side)

**Make a new key** on the card retires the current key (kept, `retired_at`, listed on the card) and makes a new one;
the page shows the new fingerprint to read to the county. Files made from then on are signed with the new key, and
the county must add it (Keys › Replace the key) before it imports them. Audited `county_submission.key.rotate` with
both fingerprints.

### Deactivating a programme

A programme that stops reporting is deactivated, not deleted. **Its new files are refused, and its files already
imported stop counting**, and it is no column of the view: the page names it ("Left out: … inactive"). Where its past
quarters still stand (a contract that ended), tick **While inactive, keep counting the files it already sent**
(`keep_files`): its files count again, and it has a column for any period it has files in. Why stop counting by
default: a programme is usually deactivated because something is wrong (a contract ended in dispute, a key exposed
before it could be replaced); keeping its figures in the totals should be a decision, not a side effect. The
navigation still shows County view while any programme is registered, active or not.

## What the county sees

**County view** (`#/county`, for `county:view`) for a chosen period:

- **The period** in a form (Enter applies): From, To, and presets — the last quarter; the current fiscal year to
  date and the last whole one (July to June), with their quarters that have ended; the last calendar year; the year
  to date. **Show**: the whole period, or **by quarter**.
- **The headline**: "N of M programs submitted for the whole period, K for part of it, J not at all" (on the page and
  in the export).
- **Who has submitted**: each programme, whether its files cover the whole period, part of it or none of it, which
  of its files count and which are left out, each file's received date.
- **Read this first**: a one-line summary always on screen; the caveats in full, the publication note and the
  counting rule one tap away.
- **Spending** from settlement funds (approved or reimbursed, and pending), **by allowable use** (Exhibit E, each
  fund's spending under its own category) and **by High Impact Abatement Activity** (everything the funds marked
  with each activity spent), each with a one-line explanation; and each **outcome**: one column per programme and
  **Total (N of M programs complete)**. A programme with nothing for the period shows **"— not submitted"** in words
  (not a greyed 0); a programme that covers part of it is marked "(part)". On a phone each programme's figure is
  labelled with a short name.
- **Counts of people** are labelled as what they are: "People served (each program's own count, summed)", and so
  for referrals, people linked to care or to MOUD and people trained. The word "unduplicated" is never on the county
  view or in its files.
- **By quarter**: the measures down the side and the quarters across (each whole calendar quarter in the range —
  the same months as the fiscal quarters — combined on its own by the same rule, with "N of M complete" in its
  heading); each quarter's per-programme figures behind a disclosure. At most 12 quarters; days outside whole
  quarters are said.
- **Download** as Excel (sheets About, Combined, Submissions, and Tidy), CSV, or a **long "tidy" CSV** (`program,
  period_from, period_to, fund, grant_number, measure_code, measure_label, value`: one row per programme, counted
  file, fund and measure, and the file's totals), all labelled *Internal — exact counts* (`county:view` and
  `export:read`).
- **Submissions** (`#/county?tab=submissions`): every file received, with when it was made and received, and its
  status — **Current**, **Replaced**, **Withdrawn** or **Not counted: key compromised**. Import (`county:manage`);
  **Withdraw** (with a reason) on a current file only; **Reinstate** on a withdrawn one. After either, the focus goes
  to the list's heading. Which files count toward a chosen period is on the combined view, not here.
- **Programs** (`#/county?tab=programmes`): this county's code; register, rename, add notes, deactivate (and keep
  counting); **Keys** for each programme's key history.

Every read and write is audited: `county.view`, `county.export`, `county.code.create`, `county.programme.add`,
`county.programme.update`, `county.programme.deactivate`, `county.programme.reactivate`,
`county.programme.key.replace|compromised|trusted`, `county.submission.import` (with its status: imported,
superseded or older) and `.duplicate`, `county.submission.refuse`, `county.submission.throttled`,
`county.submission.withdraw` (with the reason), `county.submission.reinstate`; for figures the county entered (built for
1.20.0, not yet released), `county.entry.create|update|import|refuse|withdraw|reinstate`. On the programme's side:
`county_submission.key.create`, `county_submission.key.rotate`, `county_submission.export`. The audit entries carry
ids, periods, fingerprints and hashes, never figures.

### Which submissions count for a period

Only a submission whose **whole period lies inside** the chosen period counts; nothing is pro-rated. Where two of
one programme's counting submissions overlap (a quarter and a month inside it), the **longer** one counts and the
other is left out, so no day is counted twice (between two of the same length, the earlier-starting, then the
later-received). A programme whose counting submissions cover only part of the period is shown as *part of the
period*. So a county choosing a quarter sees the quarterly files, and choosing a year sees every file inside the
year; a monthly file never counts toward a period it only partly overlaps. "Counting" means current (not replaced,
not withdrawn), signed by a key not marked compromised, from an active programme or one kept.

### Caveats, as the page states them

- **Each programme's own count, summed.** People are counted by each programme and added up. A person served by
  two programmes counts twice, and the design rules out ever removing that double counting across programmes: it
  would need a shared identifier, or a shared blind-index key, moving between organisations
  ([DATA-NETWORK.md](market/DATA-NETWORK.md), *What the design rules out*). Summing one programme's monthly files
  likewise counts a person served in two months twice.
- **Exact, for authorised county staff only.** Small numbers are shown as they are. Nothing on the page or in its
  files is for publication.
- **No cost per outcome across programmes.** Each programme's own page has it.

## Permissions

| Permission | Who holds it by default | What it allows |
| --- | --- | --- |
| `county:view` | Administrator, supervisor, finance | The combined view and its files (with `export:read`), the list of programmes and files, the county code |
| `county:manage` (sensitive) | Administrator | Register, change, deactivate programmes and replace or distrust their keys (it decides whose figures the county accepts); import, withdraw and reinstate files; register a programme not on SUDS and enter or import its figures (built for 1.20.0, not yet released) |

Neither can be granted to a role that does not see exact aggregate counts (`reports:exact` or `reports:funder`):
**read-only**, navigators and clinicians (`server/permissions.js` `grantProblem`). Read-only's reports are
publication releases only, and the county view's small counts are exact and not for publication. Finance may be
granted `county:manage` individually. A programme's server holds these permissions too, but shows no County view
entry until a programme is registered there, except to an administrator (who registers them).

## A county-only install

A county that runs SUDS only for the county view (it serves no clients itself) installs an office server as usual
([INSTALL.md](INSTALL.md)) and uses:

- **Roles**: an administrator (`county:manage`: registers programmes, imports and withdraws files) and finance or
  supervisor accounts for the analysts who read the view (`county:view`, with `export:read` for the files). Give no
  one a front-line role: there is no client work to record.
- **Modules**: none of the client modules are needed. Leave the sample data out (`npm run seed` is a programme's
  data) and local mode off (the county view is office-server only; a device has none). The navigation shows County
  view to the administrator from the start, and to finance and supervisors once a programme is registered.
- **Data**: no client data and no PHI. It holds the programmes' public keys, the signed files (aggregate figures,
  encrypted at rest like other figures kept for authorised staff), the county code and the audit log. Backups, TLS,
  sign-in and the audit log are the same as any office server's; its security review is short because no client
  record is ever on it.
## Connecting

*Released in 1.18.0. Optional, and off by default on both sides.*

Emailing the file works, and stays. Where the county runs SUDS and wants it, the programme's server can post the file
to the county's server directly, the county's own systems can read the combined view, and the programme can see which
periods the county still expects. `server/county-connect.js` (the county's side), `server/county-connect-client.js`
(the programme's side), `server/routes/county-connect.js`.

### What crosses the link

Only the **same signed county submission file** the download makes (the programme's side builds it with the same
steps: the Settlement outcomes figures, `county.js` `payloadFrom`'s allow-list, `signFile`), and in the other
direction the county's receipt (`status`, `reason`, `{ sha256, received_at }`) and its **status**: what it expects of
that one programme. Never a figure back, never another programme's anything, never client-level data.

### The trust model: a token *and* the signature

- The county issues a **connection token** per registered programme (County view › Programs › Connection tokens;
  `county:manage`). It is 256 random bits behind the prefix `sudscc_`, shown once, kept only as its SHA-256
  (`county_connect_tokens.token_hash`), optionally expiring (90 days, a year, two years or never), revocable, with the
  time and address of its last use recorded. Issued, revoked and every use audited.
- The token only says **which programme is calling**. The file must still verify through `county.js`'s own import
  path (`parseFile`, then `importParsed`: the allow-list, the period, this county's code, the current key of a
  registered and active programme, the signature, and which of the programme's files for the period counts). Before
  that import looks further, the key that signed the file must be one registered for the token's programme: an
  unknown key and another programme's key are refused with **one** reason to the caller (`not_this_programme`, the
  same words for both), so a token holder learns nothing about other programmes' keys, names or files; the county's
  audit log keeps which it was (`unknown_key` or `wrong_programme`). A token never makes a file count, and programme
  A's token cannot carry programme B's file.
- A connection token of a programme the county **deactivates** stops working at once (refused as
  `inactive_programme`), and deactivating the programme on County view › Programs revokes its live tokens, each
  audited (`county_connect.token.revoke`, `reason: programme_deactivated`), so reactivating it does not bring an old
  token back.
- Neither kind of token is ever a session: a county token presented anywhere else is not a sign-in, and a signed-in
  session (cookie or its token) does not open the machine routes.

### The county's side

- **Switch**: `county_connect_enabled`, off by default; **County connections** (`#/county-connect`), for
  `county:manage` **and** `settings:manage` (it exposes an endpoint). While off, every machine route answers 404 as if
  it did not exist.
- `POST /api/county-connect/v1/submissions` with `Authorization: Bearer sudscc_…` and the file as the JSON body.
  Answers `201 { status: "imported" | "superseded" | "older", reason: null, message, period, receipt }`,
  `200 { status: "duplicate", … }` or `422` (`413` over 256 KB) `{ status: "refused", reason, message, receipt }`,
  `reason` being `county.js`'s own refusal code (`recipient` for a file made for another county, `signature`,
  `retired_key` for a new file signed with a replaced key, …) or `not_this_programme` (an unknown key or another
  programme's; the audit log says which), and
  `message` the county view's own words (`county.js` `importMessage`; an `older` file is kept and does not count, as on
  import). The body is capped at **256 KB before it is read**,
  and only for a live connection token while the switch is on (`server/app.js` `bodyLimitFor`); anything else
  without a session keeps the 64 KB cap. Audited `county.submission.import|duplicate|refuse` with `via:
  "county-connect"` and the token's id; the actor is the token's prefix, never a user.
- `GET /api/county-connect/v1/status` (the same token): the county's code (`county.js` `countyCode()`, the one on
  County view › Programs, which the programme's file must name) and name, the **cadence** it expects (a setting:
  quarterly by calendar quarter, quarterly by the California fiscal year from July 1, or monthly; and an optional
  first period), the last year of complete periods and, for each, whether this programme's files cover it
  (`received`, and `coverage`: `whole`, `part` or `none`), the outstanding ones, and this programme's files with their
  receipts and status. Periods are made and named by `server/county-periods.js`, the helpers the county view and the
  Send to the county card use ("Apr – Jun 2026 (calendar Q2 2026 · FY 2025-26 Q4)"; the fiscal cadence puts the
  fiscal name first; months as "Feb 2026"). What counts is decided as the combined view decides it (`county.js`
  `countingSubs` and `coverage`): a withdrawn or replaced file, one signed by a key marked compromised, and every file
  of an inactive programme whose files are not kept, do not. Audited `county_connect.status`.
- **Read tokens** (`sudscr_…`; scope `county.read`) for the county's own systems: named, expiring after 90 days
  unless chosen (at most a year), revocable, last use recorded. `GET /api/county-connect/v1/combined?from&to
  [&format=json|tidy-csv]` answers the combined view from `county.js` `combined()` (the same inclusion rule) with
  `notes` saying the figures are **summed, not unduplicated** and **exact, internal, not for publication**, and the
  caveats; the tidy CSV has one row per programme and measure plus the total, with the notes in its headers.
  `GET /api/county-connect/v1/programs`: names, active, the current key's fingerprint and the key history
  (fingerprints, when added, replaced or marked compromised), last received, the periods of the files that count, by
  the same rule (no public or private keys). Audited `county.api.read`, never with figures.
- **Rate limits** (per 10 minutes, on top of the global API limit). Calls **without a good token** (none, unknown,
  expired, revoked, an inactive programme's) have limits of their own, checked first: 20 per address (then the address
  waits, good token or not) and 1,000 from all addresses together; they never count towards the limits of calls with
  a good token, so a flood of made-up tokens from many addresses cannot make a programme's real token wait. Calls
  with a good token: 120 per address across the machine routes, 2,000 from all addresses together, and per token 30
  sends, 60 status calls, 120 reads and 20 refused files. Refusals are written to the audit log ten an hour per token
  (or for unknown tokens together) and then counted; the hourly housekeeping writes the summary of every window whose
  hour is over (`county-connect.js` `sweepRefusals`), as does stopping the server.
- **Behind a proxy**, `TRUST_PROXY=1` is required: without it every programme is counted as the proxy's one address.
  County connections warns when the connection is on, `TRUST_PROXY` is unset and calls arrive with
  `X-Forwarded-For`.

### The programme's side

- **Connect to the county** (Settlement outcomes › Send to the county over the connection; `settings:manage`): the
  county's address and the connection token. The token is stored encrypted (`county_connection.token_enc`) and never
  returned to a browser once saved (only its first characters).
- **Test connection** (whoever may make the county file, or `settings:manage`): asks the county's `/status` and shows
  what it expects and what is outstanding.
- **Send to the county now** (`reports:funder`, `budget:read`, `export:read`: the same as making the file): sends
  exactly the file **Make the county file** downloads for the choices on the Send to the county card above it: its
  period, the county's name and the settlement funds ticked (with none ticked, it says so at the card, as the download
  does). The file names the county's code from its `/status` (asked for when not yet known; a county that gives no
  code gets no file); a code typed on the card must be that county's, or nothing is sent. The name and funds are
  remembered per county code, as the download remembers them (a person's send remembers; an automatic send only uses
  what a person chose, and never rewrites another code's choice); nothing is ever sent for "every fund". The
  county's code and name from `/status` are held to a file recipient's rules (`county.js`: a code of eight letters
  and digits, a name of at most 200 characters with no control characters or extra spaces) before they are stored
  or signed; anything else is a bad answer and nothing of it is kept. The county's receipt is shown. Each send is kept in a **send
  log** (`county_connect_sends`: period, payload SHA-256, the county's answer, when, who; never figures) and audited
  `county_submission.send` (period, county code, fingerprint, payload SHA-256, host, answer).
- **Automatic sending**, off by default (a checkbox beside the address): the hourly housekeeping, once a day at
  most, asks `/status` what is outstanding and sends those periods (four at most a day, oldest first), each logged
  and audited as automatic (`county_submission.auto` for the run). The county's list is checked, not trusted: each
  period must pass the checks a person's send passes (real dates, the start on or before the end, ended before today,
  at most a year) **and** be one of the periods of the county's cadence that ended in the last two years (8 quarters
  or 24 months, worked out here by `county-periods.js`); any other is skipped and audited
  (`county_submission.auto_skip`, with the reason and never a figure) and the rest are still sent. Nothing is sent
  automatically until a person has chosen the funds for this county's code (by sending or downloading once).
- **A county code that changes**: if `/status` gives a different county code from the one saved, SUDS does not take
  it. Automatic sending switches itself off, nothing is sent (by hand or automatically), both are audited
  (`county_connect.county_code.changed`), and the card asks an administrator to check with the county and confirm
  the new code (`PUT /api/county-connect/connection { confirm_county_code: true }`, audited
  `county_connect.county_code.confirm`); automatic sending can be switched on again only after that.
- **Outbound safety**: https only (plain http only to this machine, never in production); no redirect is ever
  followed (the token goes only to the configured host); one 15-second deadline for the whole exchange, the answer
  included (a county that drips its answer a byte at a time is cut off); the answer read to 64 KB at most. A public
  address goes through `server/outbound.js` (checked, resolved, and connected to the address that passed the check;
  a name resolving to a private address is refused). An address on a private network is refused in production
  unless the server is started with `SUDS_COUNTY_ALLOW_PRIVATE=1` (a county reached over a VPN or split DNS). Under
  that flag the name is resolved, every address checked and the connection pinned to a checked address
  (`outbound.privateNetworkFetch`): RFC 1918 (10/8, 172.16/12, 192.168/16) and IPv6 unique local (fc00::/7)
  addresses are allowed, so a normal name that resolves to one works; this machine (loopback), link-local
  (169.254/16, fe80::/10), the cloud metadata addresses, 0.0.0.0 and `::`, and the IPv4-mapped forms of all of them
  stay refused, and the request never goes through a proxy. Certificates are verified against the county's host
  name; a county whose certificate comes from its own CA is trusted with `NODE_EXTRA_CA_CERTS`.

### Exposure

The county's endpoint must be reachable from the programmes' servers: through the county's TLS reverse proxy on the
internet, or a VPN between them ([DEPLOYMENT.md](DEPLOYMENT.md), *Inbound from the internet*). Behind a proxy
`TRUST_PROXY=1` is **required**, so the per-address limits and the recorded last-use address are the caller's
(County connections warns when it sees proxied calls without it). A county may also
allow-list its programmes' addresses at its proxy or WAF (only `/api/county-connect/v1/` needs to be reachable).
Nothing else changes: the connection carries what the emailed file carried.

## County-entered figures

*Built for 1.20.0, not yet released. Office server only. Migration 60; `server/county-entry.js`.*

A county funds some grantees that do not run SUDS. Without them the combined view is not the county's portfolio, and
the only alternative is a spreadsheet beside it. So the county can register a programme as **not on SUDS** and its
own staff enter that programme's figures, marked everywhere as what they are: **entered by the county — not signed
by the program**.

- **Registering.** County view › Programs › **Add a program not on SUDS**: a name and notes, no key
  (`POST /api/county/programmes { name, notes, not_on_suds: true }`; `county_programmes.on_suds = 0`; audited
  `county.programme.add` with `on_suds: false`). It has no key, so it can send no signed file and gets no connection
  token. When it starts running SUDS, the county adds its key (**Keys**): it is then on SUDS, its entered figures stay
  (marked), and its signed files count by the usual rule (the one made last for a period counts).
- **Entering figures** (`county:manage`): **Enter figures** for a period — the period, the **source document** the
  figures come from (required: "Q2 report emailed 3 July 2026"), and for each fund its name, grant number, Exhibit E
  allowable use, High Impact Abatement Activity, spending (under its own category, under other categories, pending)
  and the thirteen outcomes. Exactly the fields a signed file carries for a fund: the entry is turned into a payload
  of the **same allow-list** (`county.js` `PAYLOAD`, checked by `checkPayload`), for this county's code, with the
  programme's registered name, "made" now. Each category's spending and outcomes are its funds' added up, and so are
  the totals (a signed file's people counts are unduplicated within the programme; an entered one's are the funds'
  counts added up, and the county types them as the programme reported them).
- **Importing a CSV** (`county:manage`): **Import a CSV** takes the long "tidy" layout the combined view downloads
  (`program, period_from, period_to, fund, grant_number, measure_code, measure_label, value`, and optionally `source`),
  so a county can fill it in from a grantee's report or send the layout to the grantee. **Check the file** reads it
  and says, by row and column, everything wrong with it (nothing is saved), or shows the periods and funds it holds
  and asks for each fund's Exhibit E use and HIAA (the layout has neither); **Import** then enters every period, all
  or none, each by the same path as the form. Rows of "All funds in the submission" give the totals: if present,
  every total is needed and the spending totals must equal the funds' added up.
- **What is checked**, form and CSV alike: strict numbers (digits and one decimal point: up to two decimals for money
  and hours, whole numbers for counts; no thousands separators, currency signs, spaces, signs, exponents, or blank
  for 0), every figure of every fund present, the allow-list's measures and categories only, no fund or CSV cell twice,
  real dates, the start on or before the end, a period that has ended; for a CSV, the header, the programme's own name
  on every row, at most 12 periods, 5,000 rows and 256 KB. Text is held to the signed files' rule (`cleanText`), and a
  cell the spreadsheet guard quoted (`'=…`) is read back as its text.
- **Stored** as a county submission with `source = 'county_entered'`, no key and no signature (a CHECK keeps a signed
  row signed and an entered one unsigned), the payload encrypted like a signed one's (`payload_enc`), who entered it
  (`received_by`), when (`received_at`), how (`entered_via`: `form` or `csv`) and the source document
  (`source_ref_enc`, encrypted; on the county's own Submissions list only, never in the read API). Entering figures
  again for the same period **replaces** the earlier ones by the signed files' rule (`resettle`: the one "made" last
  counts; the earlier kept, marked replaced); **Withdraw** and **Reinstate** are the signed files' own routes;
  **Correct** on a current entry opens the form filled in with it.
- **Counted by the same rule** (`countingSubs`, `coverage`, `filesCount`): an entered quarter counts in a quarter as a
  signed quarter does, and a programme's entered and signed files are combined as any two of its files are.
- **Marked everywhere.** The combined view: each programme's **Source** (*Signed by the program*, *Entered by the
  county — not signed by the program*, or both), "(entered)" beside every figure of such a programme and in its column
  heading, and under each total the part of it entered by the county; the **headline counts them separately** ("Of
  the 3 with figures, 1 has figures entered by the county — not signed by the program."). By quarter: the part of each
  quarter's total, and the count in its heading. Excel and CSV: the column heading, a column *Of the total, entered by
  the county*, the Submissions sheet's *Source* column and an About row. The tidy CSV: a ninth column, `source`. The
  read API: `source` per programme and per submission, `total_entered` per row, a tidy-CSV `source` column and rows
  of the entered part, and `/v1/programs`' `on_suds`, `source` and each period's `source`.
- **Leaving them out.** Counted by default; **Leave out figures entered by the county** on the combined view (and
  `&entered=exclude` on the view, its export and `/v1/combined`) takes them away before the counting rule is applied:
  a programme not on SUDS with no signed file is no column, a programme with both keeps its signed files only, and the
  page, headline and files say what was left out (`entered_left_out`). Every total then drops by exactly its entered
  part (`test/county-entry.test.js`).
- **Audited** without figures or typed text: `county.entry.create` (a first entry for the period) and
  `county.entry.update` (one that replaces figures or a file), `county.entry.import` (the file's SHA-256, its rows and
  each entry's id, period, hash and status), `county.entry.refuse` (the reason, the fields or the number of rows
  wrong; never the values), `county.entry.withdraw` (with the reason), `county.entry.reinstate`, and `county.view`
  with `what: "entry"` for the correction form.

What it is not: a way to make a programme's figures look signed. Nothing about an entered figure is signed; the
county's staff are accountable for it through the audit log and the source document, and the data contribution
agreement says what the county may enter ([market/templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md](market/templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md),
section 8).

## Not on SUDS on this device

The routes are office-server only (`server/app.js` `LOCAL_ROUTE_MODULES`; `test/county-device.test.js`): SUDS on
this device has no county relationship, signs nothing for one and imports nothing from one. The Settlement outcomes
page shows no Send to the county there, and the navigation no County view. The county connection's routes are
office-only too (`county-connect` in `LOCAL_ROUTE_MODULES`'s exclusions; `test/county-connect-device.test.js`).

## Deferred

- **Publication.** Nothing here publishes anything. Publishing combined figures needs **the publication screen
  over the combined release** (planned): the small-cell method audited over the county total *and* every
  programme's own releases it could be differenced against (DATA-NETWORK, *The basis*). The page and its files say
  so.
- **Award and contract amounts per fund** (spending against the award): needs the award in the file, so a schema
  version 2 of the payload.
- **Reporting-cadence reminders on the programme's side** (the quarter the county expects, and whether its file was
  made).
- **Benchmarks (Tier 2)**: distributions across programmes, rates per 100 people served, a minimum number of
  contributing programmes, an expert determination. Not built.
- **Unduplication across programmes: never** (above).
- **The county's own template.** The file carries SUDS's settlement categories and outcomes; a county's reporting
  template (and DHCS's current form) has not been checked against it (STRATEGY §2, *Dependency*).
- **Counsel.** Whether a county receiving these exact aggregates needs anything beyond the funding contract
  (DATA-NETWORK, *What counsel must review*, items 1 and 4) is for counsel; the design assumes the county receives
  exact submissions under its contract today.

## Code and tests

`server/county.js` (format, canonical form, text rules, keys, county code, allow-list, import, supersession,
withdraw and reinstate, the combined and by-quarter views), `server/routes/county.js`, `public/views/county.js`,
`server/county-periods.js` (calendar and fiscal periods; the browser's `public/county-periods.js` is generated from it by `scripts/gen-county-periods.js`, and `test/county-periods.test.js` checks the two agree), the Send to the county card in
`public/views/settlement.js`, `scripts/county-sample.js`; migration 56 (`server/db.js`: `county_signing_keys`,
`county_programmes`, `county_programme_keys`, `county_submissions`); tests `test/county.test.js` (each test stands
on its own), `test/county-device.test.js`; browser script `scripts/ui/county.mjs`, and the county pages and dialogs
in `scripts/ui/accessibility.mjs` (`A11Y_PAGES='county|settlement'` audits just them, in every pass).

County-entered figures (built for 1.20.0, not yet released): `server/county-entry.js`, the entry routes in
`server/routes/county.js`, the Add a program not on SUDS, Enter figures and Import a CSV dialogs in
`public/views/county.js`; migration 60 (`county_programmes.on_suds`; `county_submissions` rebuilt with `source`,
`entered_via`, `source_ref_enc`); tests `test/county-entry.test.js` and `test/migrations.test.js` (migration 60 on a
database with signed submissions); the browser script `scripts/ui/county.mjs` (section 4) and the dialogs in
`scripts/ui/accessibility.mjs`.

The county connection: `server/county-connect.js`, `server/county-connect-client.js`,
`server/routes/county-connect.js`, `public/views/countyconnect.js`; migration 57 (`county_connect_tokens`,
`county_connection`, `county_connect_sends`); tests `test/county-connect.test.js` (including a programme server
sending to a county server over HTTP end to end), `test/county-connect-device.test.js`; browser script
`scripts/ui/county-connect.mjs` (`A11Y_PAGES='county|settlement|county-connect'` audits the county pages and the
County connections page).

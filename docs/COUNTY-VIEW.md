# The county view

*Built for 1.18.0, not yet released. Tier 1 of [market/DATA-NETWORK.md](market/DATA-NETWORK.md): county aggregates from
exact submissions.*

A county that funds harm-reduction and treatment programmes with opioid settlement money needs to see, in one
place, what each programme spent and what it did with it. Each programme already sends the county its figures
under its funding contract. The county view puts those figures side by side and adds them up without any client of
any programme ever reaching the county. By default there is no link between the programmes' SUDS servers and the
county's: the signed file is the transport. The **county connection** ([Connecting](#connecting), below) is an
optional link, off unless the county switches it on, that carries the same signed file and nothing else.

It has two halves:

- **Send to the county** (a programme's server): on **Reports › Settlement outcomes**, a person who files the
  programme's funder submission makes a **county submission file** for the period on screen: a signed JSON file.
  The programme sends it to the county the way the county asks (email, the county's file drop); or, where the county
  has switched on the county connection, SUDS posts the same file to the county's server (see *Connecting*).
- **County view** (the county's own SUDS server): the county registers each programme it funds, by the public key
  the programme gives it; imports the files the programmes send; and sees them combined for a period, on screen
  and as an Excel or CSV file.

`npm run seed` stays a programme's data. To try the county side on a development server, run
`node scripts/county-sample.js <dir>`: it writes three fictional programmes' public keys (`programmes.json`) and
their signed files for the last two complete quarters, to register and import as below.

## What the file holds

The figures the Settlement outcomes page already computes (`server/settlement-outcomes.js` `figures()`, the same
code, never a second count), at the exact level the county receives under its contract today:

| Part | Holds |
| --- | --- |
| Header | Schema version, the programme's name (Settings › Program), the period, when it was made, the SUDS version, `counts: "exact"` |
| Each settlement fund | Its name, grant or agreement number, Exhibit E allowable use and California High Impact Abatement Activity; spending under its own category, under other categories, approved and pending; and its outcomes |
| Each allowable use | Spending under it and its outcomes |
| All settlement funds | Spending (approved, pending) and outcomes |

The outcomes are the thirteen of the Settlement outcomes page (`server/settlement-outcome-map.js`): contacts,
naloxone kits, fentanyl test strips, syringes, reversals reported, people served, referrals made, people linked to
care (a referral admitted or completed: what the county means by a referral closed), people linked to medication
for OUD, treatment admissions, education sessions, people trained and staff training hours.

**Never in it:** a client, client code, participant code, name, date of birth, date of service, record id or any
single event. The payload is an **allow-list** (`server/county.js` `PAYLOAD`): the file is checked against it when
it is made, and again when the county imports it, and anything else refuses it. `test/county.test.js` walks a
real file and fails on any key outside the list or any client's name, code or date of birth inside it.

Small numbers are **exact**, by design: the county receives exact figures under its funding contract today. The
file is for the county under that contract, **not for publication**, and the page says so. It is aggregate and
carries no PHI, so it is not a Part 2 disclosure and does not go through the disclosure gate; but it leaves the
programme, so making it is audited (`county_submission.export`) with the period, the key's fingerprint and the
SHA-256 of the payload (never the figures), and the page says in plain words that it leaves the programme.

Who may make it: whoever files the funder submission (`reports:funder`) and sees the budget (`budget:read`), with
`export:read` for the file: finance, supervisors and administrators by default.

## The trust model

**Signed files, keys exchanged out of band.**

- Each programme's office server has an **Ed25519 key** for county files, made the first time one is asked for
  (`county_signing_keys`). The private half (the 32-byte seed) is encrypted with the database key
  (`private_key_enc`, AES-256-GCM), so key rotation re-encrypts it with every other secret column and a copy of the
  database without the key file does not hold it. It is a separate key from the office's evidence-signing key
  (`SUDS_SIGNING_KEY`, the audit export and recovery-drill report): a county trusts it for one purpose only.
- The page shows the **public key** and its **fingerprint**: the first 32 hex characters of SHA-256 over the key's
  DER encoding, read out as eight groups of four. The programme gives the county the public key (email is fine: it
  is public) and **reads the fingerprint out** (by phone, at a contract meeting): that is what makes the key the
  programme's and not someone else's.
- The county registers the programme with that public key. SUDS shows the key's fingerprint to compare, and if the
  county types the fingerprint it was read, refuses a key that does not match.
- A file carries its payload, a signature over the payload's **canonical serialisation** and the fingerprint of
  the key that made it. The canonical form is JSON with every object's keys sorted (by UTF-16 code unit), no
  whitespace, arrays in order, strings and numbers exactly as `JSON.stringify` writes them, and only finite numbers
  (`server/county.js` `canonical()`); so the bytes signed do not depend on how the file was laid out or re-saved.
- On import the county's server checks, in order: the size (256 KB at most); that it is JSON and a SUDS county
  submission of this schema version; the payload's allow-list, types and period (real dates, the start on or
  before the end, the end not after today); that the fingerprint is a **registered, active** programme's; and the
  **signature** under that programme's registered key. Any failure refuses the whole file with a sentence saying
  why, audited as `county.submission.refuse` with the reason (never the figures), and refusals are throttled
  (20 per person per 10 minutes).
- A second file for the same programme and **exactly** the same period **supersedes** the first, which is kept
  (marked superseded). The same file again (the same payload SHA-256) changes nothing. A county manager can
  **withdraw** a file: it is kept and no longer counts.
- A programme that stops reporting is deactivated, not deleted: its files are kept, and a new one from it is refused.

What the signature does not do: it proves the file came from the server holding that key and was not changed, not
that the figures are right. The figures are what the programme recorded in SUDS, as on its own Settlement outcomes
page. There is no revocation list: a programme whose key is lost or exposed tells the county, which deactivates it
and registers the new key. Key rotation on the programme's side is not built (the key is kept until it is
replaced by hand in the database); it is listed under *Deferred*.

## What the county sees

**County view** (`#/county`, for `county:view`) for a chosen period:

- **Who has submitted**: each registered programme, whether its files cover the whole period, part of it or none
  of it, which of its files count and which are left out, each file's received date, and the key fingerprint.
- **Spending** from settlement funds (approved or reimbursed, and pending), **by allowable use** (Exhibit E, each
  fund's spending under its own category) and **by High Impact Abatement Activity** (everything the funds marked
  with each activity spent); and each **outcome**: one column per programme and a total.
- **Download** the same as Excel or CSV, labelled *Internal — exact counts* (`county:view` and `export:read`).
- **Submissions** (`#/county?tab=submissions`): every file received; import and withdraw (`county:manage`).
- **Programmes** (`#/county?tab=programmes`): register, rename, add notes, deactivate (`county:manage`).

Every read and write is audited: `county.view`, `county.export`, `county.programme.add`, `county.programme.update`,
`county.programme.deactivate`, `county.submission.import` (and `.duplicate` for a file already imported),
`county.submission.refuse`, `county.submission.withdraw`. The audit entries carry ids, periods, fingerprints and
hashes, never figures.

### Which submissions count for a period

Only a submission whose **whole period lies inside** the chosen period counts; nothing is pro-rated. Where two of
one programme's counting submissions overlap (a quarter and a month inside it), the **longer** one counts and the
other is left out, so no day is counted twice (between two of the same length, the earlier-starting, then the
later-received). A programme whose counting submissions cover only part of the period is shown as *part of the
period*. So a county choosing a quarter sees the quarterly files, and choosing a year sees every file inside the
year; a monthly file never counts toward a period it only partly overlaps.

### Caveats, as the page states them

- **Not unduplicated.** People are counted by each programme and added up: "people served per programme, summed".
  A person served by two programmes counts twice, and the design rules out ever unduplicating across programmes:
  it would need a shared identifier, or a shared blind-index key, moving between organisations
  ([DATA-NETWORK.md](market/DATA-NETWORK.md), *What the design rules out*). Summing one programme's monthly files
  likewise counts a person served in two months twice.
- **Exact, for authorised county staff only.** Small numbers are shown as they are. Nothing on the page or in its
  files is for publication.
- **No cost per outcome across programmes.** Each programme's own page has it.

## Permissions

| Permission | Who holds it by default | What it allows |
| --- | --- | --- |
| `county:view` | Administrator, supervisor, finance | The combined view and its file (with `export:read`), the list of programmes and files |
| `county:manage` (sensitive) | Administrator | Register, change and deactivate programmes (it decides whose figures the county accepts); import and withdraw files |

Neither can be granted to a role that does not see exact aggregate counts (`reports:exact` or `reports:funder`):
**read-only**, navigators and clinicians (`server/permissions.js` `grantProblem`). Read-only's reports are
publication releases only, and the county view's small counts are exact and not for publication. Finance may be
granted `county:manage` individually. A programme's server holds these permissions too, but shows no County view
entry until a programme is registered there, except to an administrator (who registers them).

## Connecting

*Built for 1.18.0, not yet released. Optional, and off by default on both sides.*

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

- The county issues a **connection token** per registered programme (County view › Programmes › Connection tokens;
  `county:manage`). It is 256 random bits behind the prefix `sudscc_`, shown once, kept only as its SHA-256
  (`county_connect_tokens.token_hash`), optionally expiring (90 days, a year, two years or never), revocable, with the
  time and address of its last use recorded. Issued, revoked and every use audited.
- The token only says **which programme is calling**. The file must still verify through `county.js`'s own import
  path (`parseFile`, then `importParsed`: the allow-list, the period, the county code, a registered and active
  programme's key, the signature). If the key that signed the file belongs to a different programme than the token,
  the import is rolled back and refused (`wrong_programme`): a token never makes a file count, and programme A's
  token cannot carry programme B's file.
- Neither kind of token is ever a session: a county token presented anywhere else is not a sign-in, and a signed-in
  session (cookie or its token) does not open the machine routes.

### The county's side

- **Switch**: `county_connect_enabled`, off by default; **County connections** (`#/county-connect`), for
  `county:manage` **and** `settings:manage` (it exposes an endpoint). While off, every machine route answers 404 as if
  it did not exist.
- `POST /api/county-connect/v1/submissions` with `Authorization: Bearer sudscc_…` and the file as the JSON body.
  Answers `201 { status: "imported" | "superseded" | "older", reason: null, message, period, receipt }`,
  `200 { status: "duplicate", … }` or `422` (`413` over 256 KB) `{ status: "refused", reason, message, receipt }`,
  `reason` being `county.js`'s refusal code or `wrong_programme`. The body is capped at **256 KB before it is read**,
  and only for a live connection token while the switch is on (`server/app.js` `bodyLimitFor`); anything else
  without a session keeps the 64 KB cap. Audited `county.submission.import|duplicate|refuse` with `via:
  "county-connect"` and the token's id; the actor is the token's prefix, never a user.
- `GET /api/county-connect/v1/status` (the same token): the county's code and name, the **cadence** it expects
  (a setting: quarterly by calendar quarter, quarterly by the state fiscal year from July 1, or monthly; and an
  optional first period), the last year of complete periods and, for each, whether it has a counting file, the outstanding
  ones, and this programme's files' periods and receipts. Audited `county_connect.status`.
- **Read tokens** (`sudscr_…`; scope `county.read`) for the county's own systems: named, expiring after 90 days
  unless chosen (at most a year), revocable, last use recorded. `GET /api/county-connect/v1/combined?from&to
  [&format=json|tidy-csv]` answers the combined view from `county.js` `combined()` (the same inclusion rule) with
  `notes` saying the figures are **summed, not unduplicated** and **exact, internal, not for publication**, and the
  caveats; the tidy CSV has one row per programme and measure plus the total, with the notes in its headers.
  `GET /api/county-connect/v1/programs`: names, active, fingerprints, last received, the counting files' periods (no
  public or private keys). Audited `county.api.read`, never with figures.
- **Rate limits** (per 10 minutes, on top of the global API limit): 120 per address across the machine routes, 2,000
  from all addresses together, 20 wrong tokens per address (then the address waits), per token 30 sends, 60 status
  calls, 120 reads, and 20 refused files. Refusals of callers without a good token are written to the audit log ten
  an hour per token (or for unknown tokens together) and then summarised, as secure referral links do.

### The programme's side

- **Connect to the county** (Settlement outcomes › Send to the county over the connection; `settings:manage`): the
  county's address and the connection token. The token is stored encrypted (`county_connection.token_enc`) and never
  returned to a browser once saved (only its first characters).
- **Test connection** (whoever may make the county file, or `settings:manage`): asks the county's `/status` and shows
  what it expects and what is outstanding.
- **Send to the county now** (`reports:funder`, `budget:read`, `export:read`: the same as making the file): builds
  the file for the period, posts it, and shows the county's receipt. The funds that go in are the ones chosen for this
  county on the Send to the county card (remembered per county code), or those given. Each send is kept in a **send
  log** (`county_connect_sends`: period, payload SHA-256, the county's answer, when, who; never figures) and audited
  `county_submission.send` (period, fingerprint, payload SHA-256, host, answer).
- **Automatic sending**, off by default (a checkbox beside the address): the hourly housekeeping, once a day at
  most, asks `/status` what is outstanding and sends those periods (four at most a day), each logged and audited as
  automatic (`county_submission.auto` for the run).
- **Outbound safety**: https only (plain http only to this machine, never in production); no redirect is ever
  followed (the token goes only to the configured host); a 15-second timeout; the answer read to 64 KB at most. A
  public address goes through `server/outbound.js` (checked, resolved, and connected to the address that passed the
  check; a name resolving to a private address is refused). An address on this machine or a private network is
  refused in production unless the server is started with `SUDS_COUNTY_ALLOW_PRIVATE=1` (a county reached over a
  VPN). Certificates are verified; a county whose certificate comes from its own CA is trusted with
  `NODE_EXTRA_CA_CERTS`.

### Exposure

The county's endpoint must be reachable from the programmes' servers: through the county's TLS reverse proxy on the
internet, or a VPN between them ([DEPLOYMENT.md](DEPLOYMENT.md), *Inbound from the internet*). Behind a proxy set
`TRUST_PROXY=1`, so the per-address limits and the recorded last-use address are the caller's. A county may also
allow-list its programmes' addresses at its proxy or WAF (only `/api/county-connect/v1/` needs to be reachable).
Nothing else changes: the connection carries what the emailed file carried.

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
- **Benchmarks (Tier 2)**: distributions across programmes, rates per 100 people served, a minimum number of
  contributing programmes, an expert determination. Not built.
- **Unduplication across programmes: never** (above).
- **Key rotation and revocation** on the programme's side (a new key, the old one retired, the county told); a
  file signed by a retired key.
- **The county's own template.** The file carries SUDS's settlement categories and outcomes; a county's reporting
  template (and DHCS's current form) has not been checked against it (STRATEGY §2, *Dependency*).
- **Counsel.** Whether a county receiving these exact aggregates needs anything beyond the funding contract
  (DATA-NETWORK, *What counsel must review*, items 1 and 4) is for counsel; the design assumes the county receives
  exact submissions under its contract today.

## Code and tests

`server/county.js` (format, canonical form, keys, allow-list, import, the combined view), `server/routes/county.js`,
`public/views/county.js`, the Send to the county card in `public/views/settlement.js`, `scripts/county-sample.js`;
migration 56 (`server/db.js`); tests `test/county.test.js`, `test/county-device.test.js`; browser script
`scripts/ui/county.mjs`. The county connection: `server/county-connect.js`, `server/county-connect-client.js`,
`server/routes/county-connect.js`, `public/views/countyconnect.js`; migration 57 (`county_connect_tokens`,
`county_connection`, `county_connect_sends`); tests `test/county-connect.test.js` (including a programme server
sending to a county server over HTTP end to end), `test/county-connect-device.test.js`; browser script
`scripts/ui/county-connect.mjs`.

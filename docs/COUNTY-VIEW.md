# The county view

*Built for 1.18.0, not yet released. Tier 1 of [market/DATA-NETWORK.md](market/DATA-NETWORK.md): county aggregates from
exact submissions.*

A county that funds harm-reduction and treatment programmes with opioid settlement money needs to see, in one
place, what each programme spent and what it did with it. Each programme already sends the county its figures
under its funding contract. The county view puts those figures side by side and adds them up, without any link
between the programmes' SUDS servers and the county's, and without any client of any programme ever reaching the
county.

It has two halves:

- **Send to the county** (a programme's server): on **Reports › Settlement outcomes**, a person who files the
  programme's funder submission makes a **county submission file** for the period on screen: a signed JSON file.
  The programme sends it to the county the way the county asks (email, the county's file drop); SUDS sends
  nothing itself.
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

## Not on SUDS on this device

The routes are office-server only (`server/app.js` `LOCAL_ROUTE_MODULES`; `test/county-device.test.js`): SUDS on
this device has no county relationship, signs nothing for one and imports nothing from one. The Settlement outcomes
page shows no Send to the county there, and the navigation no County view.

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
`scripts/ui/county.mjs`.

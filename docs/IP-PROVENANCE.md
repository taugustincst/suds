# IP provenance: the human direction behind SUDS

A factual record, for counsel and for anyone doing IP diligence on SUDS, of how SUDS is produced and of the owner's
recorded decisions that shaped it. It draws only on records already in this repository, each linked. It states facts
and where they are recorded; it draws **no legal conclusion** about authorship, ownership or what copyright protects.
Those are questions for counsel ([market/templates/COUNSEL-REVIEW-BRIEF.md](market/templates/COUNSEL-REVIEW-BRIEF.md),
*What the licence protects*).

**Started:** 2026-10-11, at SUDS 1.25.5. **Owner:** Tj. **Licensor:** AugustInnovations LLC ([`LICENSE`](../LICENSE)).

## How the code and documents are produced

- **AI coding assistants, under the owner's direction.** As [security/QUESTIONNAIRE.md](security/QUESTIONNAIRE.md)
  #36a states: of the 1,295 commits in the history of 1.28.0 up to its stamp, all but the repository's one-line
  initial commit were written with an AI coding assistant, or merge a pull request it wrote (the figure of 202 given
  before 1.26.0 was counted in a shallow clone); the work is done under the project rules in [`CLAUDE.md`](../CLAUDE.md) and gated by the tests and CI.
  The assistants commit and push to `main` themselves, on the owner's instructions and with the owner's GitHub
  access; there is no pull-request review (the last pull request was merged on 2026-09-28), no second human reviewer
  and no independent code review.
- **Who does what.** The owner decides what SUDS is for, what it contains, how it is licensed and released, and which
  findings are fixed. A development assistant writes the code, tests and documents and runs the checks. The owner's
  business assistant carries out business steps on the owner's instructions (*Business work plan*,
  [market/BUSINESS-WORKPLAN.md](market/BUSINESS-WORKPLAN.md)). Releases are tagged on the owner's instruction
  (QUESTIONNAIRE #39).
- **The level of the owner's instructions varies.** Some are specific (the Windows server instruction quoted below; an
  administrator able to change their own permissions; the participant-code and field-device defaults). Many set goals
  and scope and leave the specifics to the assistant (for example, for 1.21.0, to implement all five planned features
  and resolve all known issues, "loop until complete"; or "Fix everything now" for 1.25.0), with the owner then accepting, changing or refusing what
  comes back. This record does not measure, file by file, how much of any part is the owner's own expression.

## Where the owner's decisions are recorded

| Record | What it holds |
| --- | --- |
| [`HANDOFF.md`](../HANDOFF.md) | The dated notes between the assistants, including the owner's instructions and answers as given (to move to a private operations repository: BUSINESS-WORKPLAN item 10) |
| [RELEASE.md](RELEASE.md) | *Stabilisation (from 1.23.1)*, the owner's commitments; the exceptions table (its *Approved by* column); *Owner decisions inside a patch*; each release's *Record* entry; *Runner images* |
| [PLATFORM.md](PLATFORM.md) | The owner decisions on how SUDS runs (the licence, the Windows server executable, conservative defaults) |
| [architecture/](architecture/README.md) | The accepted design decisions (ADR-0001 to ADR-0009) and their reasons |
| [`CLAUDE.md`](../CLAUDE.md) | The project rules the assistants work under, including the owner decisions of 2026-10-03 |
| [`LICENSE`](../LICENSE), [`NOTICE`](../NOTICE) | The licence the owner chose, and the third-party components SUDS bundles under their own licences |

## The owner's recorded decisions (a selection)

| When | Decision | Recorded in |
| --- | --- | --- |
| 1.14.0–1.16.0 | Feature releases inside the monthly limit, approved by the owner as policy exceptions (per-user permission overrides; the owner's recovery code for SUDS on this device; the role-permission expansion) | RELEASE.md, exceptions table |
| 1.16.1 | SUD counselling notes readable only by their author, co-signer and staff with `notes:clinical:write`; a to-do for the primary worker when someone off the care team changes a client's record | RELEASE.md, *Owner decisions inside a patch* |
| 1.17.0–1.20.0 | The scope of four feature releases: the AI documentation copilot and its providers and cost limit; the cross-CBO funder view, the county connection and a self-hosted compliant server; fingerprint sign-in, authorization and signing; county-entered figures | RELEASE.md, exceptions table |
| 1.21.0 | Field devices and the participant-code default off unless an administrator turns them on; a 90-day window; only an administrator widens a device's scope | PLATFORM.md, *Owner decisions, conservative defaults* |
| 1.23.1 | A stabilisation release and its commitments (feature freeze, the supported line, releases through the gate) | RELEASE.md, *Stabilisation* |
| 1.23.6 | An administrator may change their own permissions, role and account, shipped in a patch | RELEASE.md, *Record: 1.23.6* |
| 2026-10-02 | A white-box penetration test of 1.23.6 authorised; then "Lift the freeze and release" for its fixes (1.24.0) | RELEASE.md, *Record: 1.24.0* |
| 2026-10-03 | SUDS becomes proprietary from 1.24.1 (AugustInnovations LLC); SUDS on this device stays free for real use; 1.24.0 and earlier stay MIT for those copies | PLATFORM.md; `LICENSE`; CLAUDE.md |
| 2026-10-03 | "The server should be launched in an exe. This is to simplify it for county IT." (the Windows server) | PLATFORM.md |
| 2026-10-05 | "Fix everything now, freeze lifts to 1.25.0" | RELEASE.md, *Record: 1.25.0* |
| 2026-10-09 | AugustInnovations LLC would operate a hosted service and sign its BAAs and QSOAs; the lockout policy stays as it is | HANDOFF.md; [market/HOSTING.md](market/HOSTING.md) |
| 2026-10-10 | AugustInnovations LLC is the licensor; SUDS stays on Ubuntu 24.04 in CI; the history rewrite approved in principle | HANDOFF.md; RELEASE.md, *Runner images* |
| 2026-10-11 | The release cadence that batches patches at most weekly | RELEASE.md, *Release cadence (adopted 2026-10-11)* |
| 2026-10-12 | The published prices reworked (a 90-day pilot at $14,500; Program $24,500, Multi-Site $49,500 and County-Wide $98,000 a year); vendor hosting offered, one isolated instance per customer, included in the annual plans | `public/procurement.json`; [market/HOSTING.md](market/HOSTING.md) |
| 2026-10-23 | The 90-day pilot reworked to $4,500 flat, credited in full ("rework the pilot price"; the market evaluation of that day found the old pilot cost more per month than the Program plan), and the hosted service described as single-tenant, not multi-tenant | `public/procurement.json`; [market/BUSINESS-PLAN.md](market/BUSINESS-PLAN.md) |
| 2026-10-24 | 1.27.0 released on an owner exception ("I approve the exception"), carrying both server configuration from the browser and the AI assistant (the owner's choice in the development session); the assistant's summaries widened to workers' free text on contacts, referrals and to-dos ("Make them as useful as possible"; "All of it"), never note content | HANDOFF (Folder, 2026-10-24); [RELEASE.md](RELEASE.md), *Record: 1.27.0* |
| 2026-10-24 | The pilot settled at $9,500 flat, credited in full; single-tenant wording kept; the app's Security & procurement page may carry the fee schedule (a procurement document), marketing websites carry no prices | HANDOFF (Folder, Tj's decisions of 2026-10-24); `public/procurement.json` |

The ADRs ([architecture/](architecture/README.md)) record each design and why it was chosen. They do not record, design
by design, which parts the owner proposed and which were an assistant's proposal the owner accepted.

## What is claimed, and what is not

**Claimed:**
- The decisions above were the owner's, as recorded at the time in the records named.
- SUDS's code and documents were produced by AI coding assistants under the owner's direction, and committed to `main`
  by the assistants on the owner's instructions, with no pull-request review (QUESTIONNAIRE #36a).
- Versions 1.24.0 and earlier were released under the MIT licence and stay MIT for the copies already received; from
  1.24.1 the SUDS Proprietary Licence applies ([`LICENSE`](../LICENSE)).

**Not claimed:**
- That any particular file, function or sentence was written by a person rather than an assistant.
- Any conclusion about which parts of SUDS copyright protects, or who owns them. The US Copyright Office's January 2025
  report (*Copyright and Artificial Intelligence, Part 2: Copyrightability*) discusses AI-generated material and human
  contribution; how it applies here is for counsel.
- That the LLC already holds the rights in writing: the written IP and copyright assignment from the individual
  contributor(s) is owed ([market/BUSINESS-WORKPLAN.md](market/BUSINESS-WORKPLAN.md), item 0; a draft for counsel,
  [market/templates/IP-ASSIGNMENT-DRAFT.md](market/templates/IP-ASSIGNMENT-DRAFT.md)).
- That this list is complete. The hand-off notes and the commit history hold more.

## Keeping this record

When the owner makes a product, design, licensing or release decision, record it where it belongs (the hand-off
notes, RELEASE.md, PLATFORM.md or an ADR) with its date and, where there is one, the owner's own words. Add a row here
when it bears on what SUDS is. If the hand-off notes move to a private repository, this file stays the public index of
the decisions.

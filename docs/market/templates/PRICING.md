# SUDS pricing (unvalidated hypothesis)

> **UNVALIDATED HYPOTHESIS — not a price list, a quote or an offer.** No programme has paid for SUDS yet. The
> ranges below are the owner's starting guesses, to be tested with the **first 3 pilot customers** and changed
> when evidence says so. Record what was learned in the table at the bottom. The owner must validate each
> range before quoting it.

The owner is weighing other models — per active user, per-organisation tiers, a county site licence covering
several CBOs, implementation packaged as forward-deployed services, and support tiers — in
[PRICING-OPTIONS.md](../PRICING-OPTIONS.md). Nothing there is decided; until it is, this page is the hypothesis.

## What is (and is not) being sold

- **Evaluation is free; production needs a licence agreement.** SUDS is proprietary software of
  AugustInnovations ([LICENSE](../../../LICENSE)). Anyone may evaluate an unmodified copy for up to 90 days with
  fictional data, without paying. Production use and real client records need a licence agreement signed by
  AugustInnovations; its price is **[owner to decide]** and not yet published (the Pricing line of the
  procurement page, `public/procurement.json`, is blank). Copies of 1.24.0 and earlier keep their MIT rights.
- **What is also paid for is services**: getting a programme running, supporting it, and (planned) running the
  server for programmes that cannot. Each is priced as a **flat annual amount per programme**, not per user, so
  a grant budget can carry it as one line and adding a part-time outreach worker costs nothing.

An earlier draft priced SUDS at $35–49 per user per month, with a discount for county hosting. That draft was
withdrawn: it included vendor hosting that does not exist, and it charged counties per user for software
(then MIT-licensed) they would run themselves.

## Offers

| Offer | What it covers | Price hypothesis | Status |
| --- | --- | --- | --- |
| **Implementation and onboarding** (one-time) | Setup-wizard walk-through with the programme's IT partner or county IT; lists, supplies, funding sources and budget lines; spreadsheet import; training (navigators, supervisors, finance, administrator); one restore drill with IT; funder-report check against the programme's grants | **$2,500–7,500** per programme, by data volume and number of grants | Available (owner delivers) |
| **Support subscription** (annual) | Business-hours support per [SUPPORT-SLA.md](SUPPORT-SLA.md); release notes and upgrade help; security-release notices; answers to security questionnaires from the evidence pack; one check-in a quarter | **$3,000–6,000 / year** for a programme of up to ~15 staff; **$6,000–10,000 / year** up to ~40 | Available, business hours only |
| **Vendor-hosted single-tenant tier** (annual) | One isolated instance, backups, monitoring, upgrades — *plus* the support subscription | **$10,000–20,000 / year** per programme (must cover the costs in [../HOSTING.md](../HOSTING.md)) | **Planned — not offered** until the HOSTING.md checklist is done |
| **Custom work** | Reports for a specific funder template, imports from another system | Quoted per job; folded into the SUDS code | Available |

Self-hosted and county-hosted programmes need the production licence, then buy only the services they want:
implementation, support, both or neither. Whether the licence fee differs by hosting model is **[owner to decide]**.

## Pilot terms (hypothesis)

| | |
| --- | --- |
| Pilot | 90 days ([PILOT-KIT.md](../PILOT-KIT.md)), self-hosted by the programme's IT partner or hosted by a sponsoring county |
| Price | A small fixed implementation fee at the low end of the range, paid from an administrative or settlement line, never waived: an unpaid pilot tests nothing about willingness to pay. Measured results and case-study permission are asked for, not traded for the fee. Support included for the pilot |
| Conversion | The pilot's implementation fee is credited against the first year's support subscription if the programme signs within 60 days |

## Where the money comes from (to check with each programme)

Programmes pay from grant budgets. Typical lines: data systems or administration in an opioid-settlement
allocation (check the county's allowable-use list), SOR / Naloxone Distribution Project administration, SABG
prevention set-aside administration or county general funds. Admin caps and allowability are the funder's
rules — ask the programme's fiscal lead which line and whether the cost must be competitively procured.

## What the pilots must answer

| Question | Evidence to collect | Learned |
| --- | --- | --- |
| Will a small harm-reduction CBO pay a flat support fee from grant funds? From which line? | Pilot conversions; the budget line used | |
| Is the implementation range right? How many hours did onboarding actually take? | Vendor time log per pilot | |
| How many support hours does a programme need per month? | Ticket log per pilot (feeds the HOSTING.md cost model) | |
| Is flat-per-programme right, or should it scale with clients served or grants reported? | Buyer feedback | |
| Do programmes without IT want vendor hosting at $10,000–20,000 / year, or a county sponsor instead? | Hosting choices; win/loss notes | |
| Is a year's price under the programme's (or county's) small-purchase threshold? | Purchasing feedback | |

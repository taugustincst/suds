# SUDS pricing (hypothesis)

> **HYPOTHESIS TO VALIDATE — not a price list or an offer.** These numbers come from the market brief and are
> to be tested with the first pilots and CBO references. Change them when evidence says so; record what was
> learned in the table at the bottom.

## What is being sold

The SUDS software is open source (MIT); anyone may run it without paying. The subscription is for the
**service around it**: hosting (vendor-hosted), implementation, spreadsheet migration, training, support with
response targets, security releases, and the assurance work (audits, pen tests, questionnaires) that a county
needs from a vendor.

## Subscription tiers (per named user, per month, billed annually)

| Tier | Users | Price / user / month | Example annual cost |
| --- | --- | --- | --- |
| Small | 1–10 | **$49** | 8 users: $4,704 |
| Programme | 11–40 | **$42** | 25 users: $12,600 |
| County | 41+ | **$35** | 60 users: $25,200 |

- **Read-only and finance users**: hypothesis — count at 50% (they use reports, not the caseload).
- **County-hosted** (county runs the server; vendor supplies support and releases): hypothesis — 20% below the
  tier price, since the vendor carries no hosting cost or uptime commitment.
- **Multi-year**: price held for the term; hypothesis — 5% off for a 3-year term.

## Pilot terms

| | |
| --- | --- |
| Pilot subscription | **$0–25 / user / month** for 90 days ([PILOT-KIT.md](../PILOT-KIT.md)); $0 in exchange for a signed reference and case-study permission |
| Implementation fee | **$3,000–8,000** one-time, depending on data volume, number of spreadsheets, CalOMS / EHR hand-off testing and training sessions |
| Conversion | Pilot fee credited against year-one subscription if the county signs within 60 days of the pilot's end |

## What is included

| Included | Subscription | Implementation fee |
| --- | --- | --- |
| Hosting, backups, monitoring (vendor-hosted) | Yes | — |
| Support desk per [SUPPORT-SLA.md](SUPPORT-SLA.md) | Yes | — |
| Security and feature releases | Yes | — |
| Security questionnaire answers, evidence pack | Yes | — |
| Setup wizard, configuration, lists, funding sources | — | Yes |
| Import of existing spreadsheets (clients, resources, visits, time, expenditures) | — | Yes |
| Training: navigators, supervisors, finance, administrator | — | Yes (up to `[4]` sessions) |
| CalOMS extract test / EHR hand-off / FHIR setup with county IT | — | Scoped per project |
| Custom development | No — quoted separately, and contributed back to the open-source code | — |

## Questions the pilots should answer

| Question | Evidence to collect | Learned |
| --- | --- | --- |
| Will a CBO pay $49/user from grant funds? Which grant line? | Pilot conversions; budget line used | |
| Is per-user right, or per programme / per client served? | Buyer feedback; seat churn | |
| Does county IT prefer county-hosted, and is the discount enough? | Hosting choices | |
| Is $3k–8k implementation accepted, or should it be bundled? | Win/loss notes | |
| Is the price under the county's small-purchase threshold for a typical programme? | Purchasing feedback | |

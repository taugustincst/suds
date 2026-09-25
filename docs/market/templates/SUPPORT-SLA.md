# SUDS support service levels (template)

> **TEMPLATE FOR COUNSEL REVIEW — not an offer and not legal advice.** It describes what a small vendor (today,
> one person) can honestly commit to. Nothing here is a commitment until it is written into a signed agreement
> reviewed by both parties' counsel. Bracketed values are placeholders to set per contract. Do not add
> after-hours or uptime commitments the vendor cannot staff ([../HOSTING.md](../HOSTING.md)).

## Who runs the server decides who owns uptime

| Hosting model ([../HOSTING.md](../HOSTING.md)) | Who operates the server and owns its uptime | What this SLA covers |
| --- | --- | --- |
| Self-hosted by the programme or its IT partner | The programme / IT partner | Software support in business hours |
| County-hosted | The county (its own uptime, monitoring and on-call) | Software support in business hours |
| Vendor-hosted single-tenant | The vendor — **only when that tier is offered** (it is planned, not offered today) | Software support, plus the *Vendor-hosted tier* section below |

## Coverage

| | |
| --- | --- |
| Support hours | Monday–Friday, 9:00–17:00 Pacific, excluding California state holidays and `[up to 10]` notified vendor absence days a year (with a named backup contact where one exists) |
| Outside those hours | No response commitment. Email is read the next business day. Security incidents: see *Security* below |
| Channels | Email `[address]` (no PHI in tickets — use client codes); a phone number `[number]` for Severity 1 in support hours |
| Who may open tickets | Up to `[3]` named contacts (programme administrator, programme lead, IT partner / county IT) |
| Language | English |

## Severity levels

| Severity | Definition | Examples |
| --- | --- | --- |
| **1 — Critical** | SUDS unusable for everyone, data integrity or confidentiality at risk, or a suspected security incident involving the software | Server will not start after an upgrade; audit chain fails verification; PHI shown to the wrong user; restore fails |
| **2 — High** | A core workflow unusable for many users, no workaround | Cannot log encounters; sign-in failing for a role; funder report wrong at a reporting deadline |
| **3 — Medium** | A feature impaired, a workaround exists | An import template rejects a valid column; a report filter misbehaves |
| **4 — Low** | Question, cosmetic issue, enhancement request | How-to; wording; a new list choice |

## Response targets (support hours only)

These are **targets**, measured from the time a ticket arrives within support hours. "First response" means a
person has read the ticket and replied with a first assessment, not that it is fixed.

| Severity | First response | Updates | Workaround or fix target |
| --- | --- | --- | --- |
| 1 | `[4]` support hours | Each business day | Workaround or rollback guidance within `[1]` business day; fix in a fix release as soon as safe |
| 2 | `[1]` business day | Every `[2]` business days | Next fix release |
| 3 | `[3]` business days | On change | A scheduled release |
| 4 | `[5]` business days | On change | Roadmap consideration |

For a server that is down, the operator (programme IT partner or county) restores service with the runbooks
in [docs/security/BACKUP-AND-DR.md](../../security/BACKUP-AND-DR.md) and [docs/DEPLOYMENT.md](../../DEPLOYMENT.md);
the vendor helps in support hours.

## Security

- A reported vulnerability is triaged within `[2]` business days and fixed in a security release; subscribers
  are told directly, with upgrade instructions (releases are tagged and checksummed, [docs/RELEASE.md](../../RELEASE.md)).
- A suspected breach at a customer is the customer's incident to lead (their privacy officer and IT); the vendor
  assists in support hours and, where a BAA applies, meets its notification duties under that BAA.

## Vendor-hosted tier (only when offered)

This section applies only after the vendor-hosted tier exists and the checklist in [../HOSTING.md](../HOSTING.md)
is complete. Until then, delete it from any contract.

| | |
| --- | --- |
| Uptime target | `[99.0]`% monthly in support hours, excluding scheduled maintenance. A higher or 24×7 target only with staffed after-hours on-call in place and named in the contract. SUDS is one server per programme (no clustering); recovery is by restore, not failover |
| Scheduled maintenance | Outside 8:00–18:00 Pacific, `[5]` business days' notice |
| Backups | Encrypted, offsite (separate account), at least `[daily]`, with `[30]` days kept; monthly restore drill with the result shared |
| Recovery targets | RTO and RPO set from the vendor's own measured drill for that instance, stated in the contract |
| Monitoring | Automated health, disk, certificate and backup-age checks with alerts to the vendor; response to alerts in support hours unless after-hours on-call is contracted |
| Service credit | `[to be agreed with counsel]` |

## Exclusions

Problems caused by the operator's own infrastructure, network, identity provider, or changes to the code the
operator made; use of local mode or SUDS on this device outside documented guidance; force majeure.

## Reporting

Quarterly for subscribers: tickets by severity and time to first response. Monthly uptime report for the
vendor-hosted tier, when offered.

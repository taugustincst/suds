# SUDS support service levels (template)

> **DRAFT template.** Targets below are the proposed starting point for contracts. They are commitments only
> once the vendor has the staffing to meet them and they are written into a signed agreement. Adjust per contract.

## Coverage

| | |
| --- | --- |
| Support hours | Monday–Friday, 8:00–17:00 Pacific, excluding California state holidays |
| Severity 1 outside hours | On-call by phone `[number]`, vendor-hosted customers (county-hosted: best effort) |
| Channels | Support portal / email `[address]` (no PHI in tickets — use client codes), phone for Severity 1 |
| Who may open tickets | Up to `[3]` named county contacts (administrator, programme lead, IT) |
| Language | English; user-facing help text in plain language |

## Severity levels

| Severity | Definition | Examples |
| --- | --- | --- |
| **1 — Critical** | SUDS unavailable to all users, data integrity or confidentiality at risk, or a suspected security incident | Server down; audit chain fails verification; PHI shown to the wrong user; failed restore |
| **2 — High** | A core workflow unusable for many users, with no workaround | Cannot record visits; sign-in failing for a role; funder report wrong at quarter end |
| **3 — Medium** | A feature impaired, a workaround exists | An import template rejects a valid column; a report filter misbehaves |
| **4 — Low** | Question, cosmetic issue, enhancement request | How-to; wording; new list choice |

## Response and resolution targets

| Severity | First response | Status updates | Target to restore / workaround | Target to fix |
| --- | --- | --- | --- | --- |
| 1 | 1 hour (24×7 for vendor-hosted) | Every 2 hours | 8 hours | Hotfix release as soon as safe |
| 2 | 4 business hours | Daily | 2 business days | Next patch release |
| 3 | 1 business day | Weekly | 10 business days | Scheduled release |
| 4 | 2 business days | On change | — | Roadmap consideration |

A security vulnerability is triaged as Severity 1 or 2 and fixed in a security release; county-hosted
customers are notified with upgrade instructions (releases are tagged and checksummed, `docs/RELEASE.md`).

## Availability

| | **Vendor-hosted** (planned) | **County-hosted** |
| --- | --- | --- |
| Uptime target | **99.5% monthly** (about 3.6 hours of unplanned downtime a month), excluding scheduled maintenance | County's responsibility — the vendor does not operate the server |
| Why not higher | SUDS is one server per programme by design (no clustering; `docs/DEPLOYMENT.md`, *Single instance only*). Recovery is by restore, not failover | — |
| Scheduled maintenance | Up to `[4]` hours a month, outside 7:00–19:00 Pacific, 5 business days' notice | County schedules its own upgrades |
| Backups | At least every `[4]` hours, encrypted, off-host; 30 days kept | County configures (built-in scheduler) |
| Recovery targets | RTO `[4]` hours, RPO `[4]` hours — to match the measured DR drill in `docs/security/` | County sets from its own drill |
| Monitoring | Health endpoint and metrics monitored 24×7 | County monitors `/api/health` |
| Service credit | `[5]%` of the monthly fee per 0.5% below target, capped at `[25]%` | — |
| Vendor duties either way | Software fixes, security releases, release notes, support desk per targets above | Same |

## Exclusions

Problems caused by the county's own infrastructure, network, identity provider or changes to the code the
county made; use of local mode or SUDS on this device outside documented guidance; force majeure.

## Reporting

Monthly for vendor-hosted: uptime, incidents, tickets by severity and time to respond. Quarterly service review
for contracts above `[50]` users.

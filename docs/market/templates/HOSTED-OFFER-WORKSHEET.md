# Hosted offer: cost and price worksheet

> **DRAFT — a worksheet for the owner; every `[INPUT]` is to be filled from real quotes and bills, not from this
> page.** The hosted service is **offered from October 2026** (owner decision of 2026-10-12), with no customer hosted
> yet ([../HOSTING.md](../HOSTING.md)); its price is the published plans, not this page. This worksheet checks the
> published prices against real costs: nothing here is a price or an offer. Item 8 of
> [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md). The planning ranges in HOSTING.md's *Unit-cost model* are
> assumptions; this worksheet replaces them with the owner's numbers.

**What is already decided or built.** The operator is AugustInnovations LLC (owner decision of 2026-10-09; see the
entity question, workplan item 0). SUDS is offered as a **fleet of single-tenant instances** (each customer its own server): the model is
**Option A: one SUDS Server per customer** on AWS Lightsail with the fleet tooling in
[`deploy/fleet/`](../../../deploy/fleet/README.md): its own VM, static IP, database and keys, a LUKS-encrypted data
disk, an "offsite" disk and an anchor disk, keys escrowed to the owner; never a shared database. The tooling is tested
against stand-ins only; its first real run is the drill tenant, which awaits the owner's go. The published prices
(owner decision of 2026-10-12; [`public/procurement.json`](../../../public/procurement.json)) are a 90-day pilot at
$4,500 flat (credited in full; $14,500 until 2026-10-23), Program at $24,500 a year, Multi-site at $49,500 a year and County-wide at $98,000 a
year. Hosting on the fleet is included in the annual plans; for a self-hosted office server the same prices exclude
the customer's infrastructure.

## 1. Per-customer infrastructure (monthly)

Fill from the AWS Lightsail price list for the region (`us-west-2` today) and, after the drill tenant, from its bill.

| Line | Fleet default (`deploy/fleet/tenant.env.example`) | Monthly cost |
| --- | --- | --- |
| VM (Lightsail instance, dual-stack) | `LIGHTSAIL_BUNDLE=medium_3_0` (the plan suds.systems ran at launch; HANDOFF reports $24/month) | `[INPUT]` |
| Static IP | one per tenant (free while attached, per Lightsail's terms: confirm) | `[INPUT]` |
| Data disk (LUKS2) | `DATA_DISK_GB=64` | `[INPUT]` |
| "Offsite" disk (same zone: not yet off-site) | `OFFSITE_DISK_GB=32` | `[INPUT]` |
| Anchor disk | `ANCHORS_DISK_GB=8` | `[INPUT]` |
| A copy that leaves the zone (needed for real data: [`deploy/fleet` *Limits*](../../../deploy/fleet/README.md)) | snapshots copied to another region, or object storage with object lock | `[INPUT]` |
| Snapshots kept (instance and disks) | `[N]` daily, `[N]` weekly | `[INPUT]` |
| Data transfer beyond the plan's allowance | small for SUDS | `[INPUT]` |
| DNS and certificates | DNS at the registrar; certificates free (ACME, Caddy) | `[INPUT]` |
| **Infrastructure per customer** | | **`[SUM]`** |

## 2. Per-customer operations (monthly)

| Line | Hours per month | Loaded hourly cost | Monthly cost |
| --- | --- | --- | --- |
| Upgrades (each release; HANDOFF's post-upgrade steps) | `[INPUT]` | `[INPUT]` | `[CALC]` |
| Monthly restore drill and its signed report | `[INPUT]` | `[INPUT]` | `[CALC]` |
| Weekly compliance report review | `[INPUT]` | `[INPUT]` | `[CALC]` |
| Support tickets (business hours, per [SUPPORT-SLA.md](SUPPORT-SLA.md)) | `[INPUT]` (measure in the first pilots) | `[INPUT]` | `[CALC]` |
| Onboarding, spread over the first year | `[INPUT]` | `[INPUT]` | `[CALC]` |
| **Operations per customer** | | | **`[SUM]`** |

## 3. Fixed costs of offering hosting (annual, shared across customers)

| Line | Annual cost | Source |
| --- | --- | --- |
| Monitoring and alerting service (health, disk, certificates, backup age, audit verification) | `[INPUT]` | HOSTING.md item 5 |
| On-call outside business hours: a second person or a contracted service | `[INPUT]` | HOSTING.md item 6 |
| Cyber liability and technology E&O insurance at hosted-service limits | `[INPUT]` | [INSURANCE-QUOTE-BRIEF.md](INSURANCE-QUOTE-BRIEF.md) |
| Independent penetration test of the application and the hosting environment, yearly | `[INPUT]` | [PEN-TEST-RFP.md](PEN-TEST-RFP.md) |
| Counsel: agreement updates, customer negotiations | `[INPUT]` | [COUNSEL-REVIEW-BRIEF.md](COUNSEL-REVIEW-BRIEF.md) |
| SOC 2 readiness and audit (when larger buyers require it) | `[INPUT]` | HOSTING.md item 12 |
| Key-escrow custody (offline hardware, safe storage) | `[INPUT]` | HOSTING.md item 10 |
| Business email, domain, accounting, bank | `[INPUT]` | |
| **Fixed costs per year** | **`[SUM]`** | |

## 4. The price

| | 5 customers | 10 customers | 20 customers |
| --- | --- | --- | --- |
| Infrastructure + operations per customer per year (sections 1–2 × 12) | `[CALC]` | `[CALC]` | `[CALC]` |
| Fixed costs per customer per year (section 3 ÷ customers) | `[CALC]` | `[CALC]` | `[CALC]` |
| **Cost per customer per year** | `[CALC]` | `[CALC]` | `[CALC]` |
| Target margin `[%]` | `[CALC]` | `[CALC]` | `[CALC]` |
| **Lowest price that covers it** | `[CALC]` | `[CALC]` | `[CALC]` |
| Published price of the customer's plan (Program $24,500, Multi-site $49,500, County-wide $98,000 a year), hosting included | `[INPUT]` | `[INPUT]` | `[INPUT]` |

## 5. Questions for the owner

Decided on 2026-10-12: **structure and price.** Hosting is included in the published Program, Multi-site and
County-wide plans, not an add-on, and has no separate price. Still open, each the owner's decision:

1. **The pilot.** Whether a pilot is hosted on the fleet: the published pilot text does not say.
2. **The check.** Whether section 4 shows the published prices cover the costs, at the number of customers expected.
3. **Minimum customers.** How many committed customers before the fixed costs (insurance, on-call, pen test) are taken
   on?
4. **On-call promise.** Business hours only (as the support template says today), or after-hours for an added fee, and
   who covers it.
5. **Uptime and recovery promises.** An availability target, RPO and RTO to publish, given one VM per customer and no
   automatic failover ([../../architecture/ADR-0001-single-process-sqlite.md](../../architecture/ADR-0001-single-process-sqlite.md)).
6. **Data residency and exit.** US region only; the export and destruction terms of the agreement (section 9.4).
7. **The drill tenant.** The go-ahead and the credentials for the first real fleet run, so section 1 can use a real
   bill.

## 6. Recording the result

The 2026-10-12 decision is recorded in `pricing` in `public/procurement.json` (and its static text in
`public/procurement.html`), [../HOSTING.md](../HOSTING.md) (status line, checklist, unit-cost model) and
QUESTIONNAIRE #2. A later change goes to the same places. The filled worksheet with real quotes stays outside the
repository; only the published price comes in.

# Hosting SUDS: who runs the server, and who answers at 2am

The critical evaluation's point 5.2 is fair: SUDS's office server is the system of record, so **every programme
needs someone to run a server** — patch it, back it up, restore it, and pick up the phone when it stops. The
software being free (MIT) does not make that work free. This page says who does it in each hosting model, what
must exist before the vendor can host anything, and what it costs.

**Current status (1.11.0): SUDS is not offered as a hosted service.** It is self-hosted by the programme, its
IT partner or its county. The vendor is one person, offering business-hours help. Nothing on this page should
be read as a hosted offer until the checklist in *Before the vendor-hosted tier can be offered* is complete and
this line is changed.

## The three hosting models

| | **A. Self-hosted by the programme or its IT partner** | **B. County-hosted** (the county runs it for a CBO or its own programme) | **C. Vendor-hosted, single-tenant** |
| --- | --- | --- | --- |
| Status | Available | Available | **Planned — not offered** |
| Typical buyer | A CBO with a managed-IT provider, or a staff member who runs servers | A county sponsoring a CBO pilot, or a county programme | A CBO with no IT capacity |
| Where it runs | The programme's VM, office server or container, or its own cloud account | County data centre or county cloud tenant | One VM or container per programme in a US cloud region under the cloud provider's BAA |
| System of record | The programme's server | The county's server | The vendor-operated instance |
| Keys held by | The programme | The county | The vendor, with documented custody (escrow copy to the programme on request) |
| Uptime is | The programme's / IT partner's | The county's | The vendor's SLA (when offered) |
| Vendor's role | Releases, documentation, optional support subscription | Same, plus county IT onboarding | Everything in the *vendor* column below |

## Who does what at 2am

| Event | A. Self-hosted | B. County-hosted | C. Vendor-hosted (planned) |
| --- | --- | --- | --- |
| Server down / `/api/health` failing | Programme's IT partner (their monitoring, their on-call) | County IT on-call | Vendor on-call — **requires a staffed rota**; one person cannot promise 24×7 |
| Disk full, certificate expired, OS patch broke start-up | IT partner | County IT | Vendor |
| Restore from backup | IT partner, with the runbook ([docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md)); vendor help in business hours if subscribed | County IT; same | Vendor |
| Suspected breach | Programme's privacy officer leads; IT partner contains; vendor assists in business hours | County privacy/IT lead; vendor assists | Vendor contains and notifies the programme within the BAA's deadline; programme decides notification to individuals |
| Security release published | IT partner installs (vendor notifies subscribers) | County installs | Vendor installs, pilot group first |
| Staff member locked out | Programme's SUDS administrator (in the app) | Same | Same |
| Software defect | Vendor, business hours, per [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md) | Same | Same |

What SUDS itself gives whoever holds the pager: a health endpoint and Prometheus metrics, JSON logs without
PHI, scheduled encrypted backups with an offsite copy, a recovery drill that measures RTO/RPO
(`npm run dr-drill`), pre-migration snapshots, and a warm-standby procedure ([docs/DEPLOYMENT.md](../DEPLOYMENT.md)).
It does not give automatic failover (single process by design — [ADR-0001](../architecture/ADR-0001-single-process-sqlite.md)).

## Before the vendor-hosted tier can be offered

All of these, not most of them:

| # | Requirement | Why | Status |
| --- | --- | --- | --- |
| 1 | Legal entity, business bank account | Contracts and BAAs are signed by an entity | Not started |
| 2 | Cloud provider **BAA** signed; only BAA-eligible services used | HIPAA; Part 2 records | Not started |
| 3 | **US region** only, stated in the DPA; backups in the US too | Data residency asks from counties | Not started |
| 4 | **Offsite backups** to a separate account/region with object lock; restore drill monthly, results shared | Recovery, ransomware | Tooling exists; hosting not started |
| 5 | **Monitoring and alerting** on health, disk, certificate, backup age, audit verification | Knowing before the customer does | Endpoints exist; no monitoring service |
| 6 | **On-call** that matches the SLA: a second person or contracted on-call before any after-hours promise | A one-person vendor cannot be on call 24×7 | Not started |
| 7 | **Insurance**: cyber liability and technology E&O at the limits counties ask for | Contract requirement; protects both sides | Not started |
| 8 | **Independent penetration test** of the application and the hosting environment, findings fixed | County IT gate | Not started ([docs/security/PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md) ready) |
| 9 | Hardened image, patch process, access control to the hosting account (MFA, least privilege, access log) | SOC 2 CC6/CC7 | Documented for county installs; not built for vendor hosting |
| 10 | Key custody procedure and escrow option | The vendor would hold PHI keys | Not started |
| 11 | BAA/QSOA and DPA templates reviewed by the vendor's counsel | Every hosted contract needs them | Drafts in [templates/](templates/) |
| 12 | SOC 2 Type 1 scoped to the hosted service (can follow the first customers, but must be planned) | Larger buyers | Readiness self-assessment only |

## Unit-cost model (planning assumptions, not quotes)

The model is **one small VM per programme**. Every figure below is an assumption to be replaced with real
quotes; the point is the shape of the cost, not the number.

| Line | Assumption | Per programme per month |
| --- | --- | --- |
| VM | 2 vCPU / 4 GB, BAA-eligible service, US region, reserved pricing | $30–60 |
| Encrypted disk | 50 GB SSD | $5–10 |
| Offsite backups | Object storage with object lock, ~30 days × daily + snapshots | $2–10 |
| Monitoring and log shipping | Share of an uptime/alerting service and log storage | $5–20 |
| Egress, DNS, certificates | Small; certificates free (ACME) | $1–5 |
| **Infrastructure subtotal** | | **≈ $45–105** |
| Routine operations | Upgrades, monthly restore drill, patch review: 2–3 hours × $75–100/hour loaded | $150–300 |
| Support tickets | 1–3 hours × $75–100/hour | $75–300 |
| **Variable cost per programme** | | **≈ $270–700 / month ≈ $3,300–8,400 / year** |

Fixed costs the vendor-hosted tier adds, spread across all hosted programmes (annual, assumptions):

| Line | Assumption (annual) |
| --- | --- |
| Cyber liability + tech E&O insurance | $3,000–10,000 |
| Penetration test | $8,000–25,000 |
| SOC 2 Type 1 (then Type 2) readiness tooling and audit | $15,000–40,000 |
| Contracted after-hours on-call (if offered) | $12,000–40,000 |
| Counsel review of templates | $3,000–10,000 |

**What it means.** Infrastructure is cheap; people and assurance are not. The fixed costs above total roughly
$29,000–125,000 a year (depending mainly on SOC 2 and after-hours on-call); with 5 hosted programmes that is
about $6,000–25,000 per programme per year on top of the variable cost, and with 20 about $1,500–6,000. A vendor-hosted
tier is only viable at a flat annual price that covers both, which is why [templates/PRICING.md](templates/PRICING.md)
prices it separately and marks it planned. Self-hosted and county-hosted programmes carry their own
infrastructure and on-call and pay only for the services they choose.

## Recommendation for the first pilots

Run the first 3 pilots as **A (IT partner self-hosted)** or **B (county-hosted, county as sponsor)**. Use them to
measure the real support hours per programme per month, and only then decide whether C can be offered at a
price programmes will pay. Record the measured hours in [templates/PRICING.md](templates/PRICING.md),
*What the pilots must answer*.

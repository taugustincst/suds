# Hosting SUDS: who runs the server, and who answers at 2am

The critical evaluation's point 5.2 is fair: SUDS's office server is the system of record, so **every programme
needs someone to run a server** — patch it, back it up, restore it, and pick up the phone when it stops. The
software's licence does not cover that work. This page says who does it in each hosting model, what the
vendor-hosted service has in place and what it still lacks, and what it costs.

**Current status (owner decision of 2026-10-12): vendor hosting is offered; no customer is hosted yet.**
AugustInnovations LLC operates it as a multi-tenant fleet: each customer runs in its own isolated instance (its own
VM, database and encryption keys; never a shared database), provisioned with the fleet tooling in
[`deploy/fleet/`](../../deploy/fleet/README.md). Hosting on the fleet is included in the published Program ($24,500 a
year), Multi-Site ($49,500 a year) and County-Wide ($98,000 a year) plans
([`public/procurement.json`](../../public/procurement.json)). Self-hosting by the programme, its IT partner or its
county remains available (since 1.18.0 optionally with SUDS Server, the hardened Linux installer and its weekly
signed compliance check: [../SELF-HOSTING.md](../SELF-HOSTING.md)); the published prices exclude the customer's own
infrastructure for a self-hosted office server.

What a buyer must be told about the hosted service today: the fleet tooling has been tested only against stand-ins,
and its first real drill tenant (*The drill tenant* in [`deploy/fleet/`](../../deploy/fleet/README.md)) has not been
run; no uptime commitment is published for hosted plans; cyber and technology E&O insurance is not yet bound; and the
BAA and Part 2 QSOA are drafts not yet reviewed by counsel ([BUSINESS-WORKPLAN.md](BUSINESS-WORKPLAN.md), items 2 and
6). The vendor is one person: paid plans include email support with a response within 2 business days, and there is
no 24×7 on-call.

**What is real today, and what is not done yet** (2026-10-12):

| | Real today | Not done yet |
| --- | --- | --- |
| **The hosted offer** | Offered from October 2026 (owner decision of 2026-10-12): hosting on the multi-tenant fleet is included in the Program, Multi-Site and County-Wide plans ([`public/procurement.json`](../../public/procurement.json)) | No customer is hosted; no uptime commitment is published for hosted plans |
| **Who operates the hosted service** | Decided by the owner on 2026-10-09: **AugustInnovations LLC**, the licensor, operates it and signs each customer's BAA and Part 2 QSOA (no separate operator company, so no further licence is needed) | Bank account, W-9 and county vendor registration in its name: not recorded here |
| **A production install** | **One: suds.systems**, the vendor's own SUDS Server on an AWS Lightsail VM (Ubuntu 24.04, `us-west-2`), installed from the 1.25.1 release with `deploy/linux/install.sh` on 2026-10-08. It holds **fictional data only**. It was installed without an encrypted data volume (the installer recorded that as an accepted risk); its data volume has been **encrypted (LUKS) since 2026-10-10**. Its compliance check, as reported by its operator (no signed report from the server is stored in this repository yet): **2026-10-08, launch (1.25.1):** 39 pass, 0 fail, 7 warnings, and its first backup and recovery drill passed; that firewall pass was taken while the 1.25.1 installer had dropped the SSH rule it had just added (fixed in 1.25.3). **2026-10-09, after the upgrade to 1.25.3:** 38 pass, **2 fail**, 6 warnings, 1 could not check. The fails: `host.firewall`, because SSH is open to `0.0.0.0/0` and `::/0` (the owner's choice; open), and `app.backups`, because every scheduled offsite copy was empty (the defect fixed in 1.25.4; the server was upgraded to 1.25.4 on 2026-10-10 and to 1.25.6 on 2026-10-11, and its offsite copies were then verified, 14 of 14 by size and SHA-256). Two-step sign-in was on for 0 of 1 accounts. The signed compliance and drill reports from the 1.25.4 upgrade will be stored in [../evidence/](../evidence/README.md) when the operator provides them. It is not a customer, a pilot or a reference site | The upgrade to 1.25.4 and its signed reports; SSH limited to an administration network; two-step sign-in on the administrator accounts |
| **Cloud provider BAA** | The **AWS Business Associate Addendum** was accepted, in AWS Artifact, for the AWS account that runs suds.systems, effective 2026-10-08. It covers AWS's infrastructure only and is not an agreement with any customer | Confirm that the account is held by AugustInnovations LLC, the operator; confirm with counsel that every AWS service used is HIPAA-eligible |
| **Fleet tooling** | [`deploy/fleet/`](../../deploy/fleet/README.md): one VM per customer, an encrypted (LUKS) data volume required before real data, escrowed keys with a logged access chain, and a two-confirmation teardown. Written and tested **against stand-ins only** (stub `aws`, `ssh`, DNS and `gpg`) | Its first real run (the drill tenant, `drill.suds.systems`, in its runbook), on the owner's go; nothing has been provisioned with it, and no customer instance exists |
| **Installer on a real VM** | Run once on Ubuntu 24.04 (suds.systems, above); its two findings (the firewall clean-up removed the SSH rule it had just added when the administration network was `0.0.0.0/0`; `www.<domain>` had no certificate) are fixed in 1.25.3 | RHEL 9 on a real VM ([../evidence/INSTALLER-VM-RUN.md](../evidence/INSTALLER-VM-RUN.md)) |
| **Penetration testing** | An owner-authorised test of suds.systems on 2026-10-08 by the vendor's own development assistant (not independent; no critical, high or medium finding; its minor findings fixed in 1.25.3): [../evidence/pentest-suds-systems-2026-10-08.md](../evidence/pentest-suds-systems-2026-10-08.md) | An independent test of the application and the hosting environment ([../security/PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md)) |
| **Agreements** | Drafts for counsel: a [licence and subscription agreement](templates/LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md), a [BAA and Part 2 QSOA](templates/BAA-QSOA-DRAFT.md), a [DPA](templates/DPA-DRAFT.md) and [support service levels](templates/SUPPORT-SLA.md) | Counsel's review; cyber and technology E&O insurance; staffed on-call. (The hosted price is set: hosting is included in the published plans, 2026-10-12) |

## The three hosting models

| | **A. Self-hosted by the programme or its IT partner** | **B. County-hosted** (the county runs it for a CBO or its own programme) | **C. Vendor-hosted** (multi-tenant fleet, one isolated instance per customer) |
| --- | --- | --- | --- |
| Status | Available | Available | **Offered from October 2026; no customer hosted yet** (the fleet's first real drill still to run) |
| Typical buyer | A CBO with a managed-IT provider, or a staff member who runs servers | A county sponsoring a CBO pilot, or a county programme | A CBO with no IT capacity |
| Where it runs | The programme's VM, office server or container, or its own cloud account | County data centre or county cloud tenant | One AWS Lightsail VM per customer, with its own database and keys, in a US region under the AWS business associate addendum |
| System of record | The programme's server | The county's server | The vendor-operated instance |
| Keys held by | The programme | The county | The vendor, with documented custody (escrow copy to the programme on request) |
| Uptime is | The programme's / IT partner's | The county's | The vendor's; **no uptime commitment is published** for hosted plans |
| Price | The published plans ([`public/procurement.json`](../../public/procurement.json)), excluding the programme's own infrastructure | Same, excluding the county's infrastructure | Included in the Program, Multi-Site and County-Wide plans |
| Vendor's role | Releases, documentation, email support on a paid plan | Same, plus county IT onboarding | Everything in the *vendor* column below |

## Who does what at 2am

| Event | A. Self-hosted | B. County-hosted | C. Vendor-hosted (no customer yet) |
| --- | --- | --- | --- |
| Server down / `/api/health` failing | Programme's IT partner (their monitoring, their on-call) | County IT on-call | Vendor, in business hours today — **24×7 needs a staffed rota**; one person cannot promise it, and none is promised |
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

## What the hosted service has, and what it still lacks

This list was written as the conditions for offering vendor hosting. The owner offered it on 2026-10-12 with several
items still open; each open item is stated to a buyer. Two hold before any real client record whatever else is open:
the fleet tooling requires the LUKS data volume before real data, and the customer's BAA and Part 2 QSOA are signed
first ([`deploy/fleet/`](../../deploy/fleet/README.md), *Agreements, isolation and who operates the fleet*).

| # | Requirement | Why | Status |
| --- | --- | --- | --- |
| 1 | Legal entity, business bank account | Contracts and BAAs are signed by an entity | **Entity decided:** AugustInnovations LLC operates the hosted service and signs the BAAs and QSOAs (owner decision, 2026-10-09). Business bank account: not recorded here |
| 2 | Cloud provider **BAA** signed; only BAA-eligible services used | HIPAA; Part 2 records | **AWS BAA accepted** for the AWS account that runs suds.systems (AWS Artifact, effective 2026-10-08). To confirm: the account is held by the operator, and each service used is HIPAA-eligible |
| 3 | **US region** only, stated in the DPA; backups in the US too | Data residency asks from counties | suds.systems runs in `us-west-2`; the fleet tooling takes the region per tenant. Not yet stated in a signed DPA |
| 4 | **Offsite backups** to a separate account/region with object lock; restore drill monthly, results shared | Recovery, ransomware | Tooling exists; the fleet's "offsite" disk is in the same zone (not yet a copy that leaves the zone: [deploy/fleet](../../deploy/fleet/README.md), *Limits*) |
| 5 | **Monitoring and alerting** on health, disk, certificate, backup age, audit verification | Knowing before the customer does | Endpoints exist; no monitoring service |
| 6 | **On-call** that matches the SLA: a second person or contracted on-call before any after-hours promise | A one-person vendor cannot be on call 24×7 | Not started |
| 7 | **Insurance**: cyber liability and technology E&O at the limits counties ask for | Contract requirement; protects both sides | Not bound; quote brief ready ([templates/INSURANCE-QUOTE-BRIEF.md](templates/INSURANCE-QUOTE-BRIEF.md)) |
| 8 | **Independent penetration test** of the application and the hosting environment, findings fixed | County IT gate | Not started ([docs/security/PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md) ready). The vendor's own owner-authorised test of suds.systems (2026-10-08) is not independent: [../evidence/pentest-suds-systems-2026-10-08.md](../evidence/pentest-suds-systems-2026-10-08.md) |
| 9 | Hardened image, patch process, access control to the hosting account (MFA, least privilege, access log) | SOC 2 CC6/CC7 | Documented for county installs; not built for vendor hosting |
| 10 | Key custody procedure and escrow option | The vendor would hold PHI keys | Tooling: [deploy/fleet](../../deploy/fleet/README.md) escrows each tenant's keys encrypted for the owner and logs every access; no custody procedure adopted |
| 11 | Licence and subscription agreement, BAA/QSOA and DPA templates reviewed by the vendor's counsel | Every hosted contract needs them | Drafts in [templates/](templates/), not yet reviewed by counsel |
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

Fixed costs the vendor-hosted service adds, spread across all hosted programmes (annual, assumptions):

| Line | Assumption (annual) |
| --- | --- |
| Cyber liability + tech E&O insurance | $3,000–10,000 |
| Penetration test | $8,000–25,000 |
| SOC 2 Type 1 (then Type 2) readiness tooling and audit | $15,000–40,000 |
| Contracted after-hours on-call (if offered) | $12,000–40,000 |
| Counsel review of templates | $3,000–10,000 |

**What it means.** Infrastructure is cheap; people and assurance are not. The fixed costs above total roughly
$29,000–125,000 a year (depending mainly on SOC 2 and after-hours on-call); with 5 hosted programmes that is
about $6,000–25,000 per programme per year on top of the variable cost, and with 20 about $1,500–6,000. Vendor
hosting is only viable at a flat annual price that covers both. The published plans (2026-10-12) include hosting in a
flat annual price per plan, from $24,500 a year for Program; the owner's own figures go in
[templates/HOSTED-OFFER-WORKSHEET.md](templates/HOSTED-OFFER-WORKSHEET.md). Self-hosted and county-hosted programmes
carry their own infrastructure and on-call.

## The first pilots

Vendor hosting (C) is offered, but no customer is hosted yet and the fleet's first real drill has not been run. A
pilot may be A, B or C. Whichever it is, measure the real support hours per programme per month, and the hosted
instance's real monthly cost where it is C, and record them in
[templates/HOSTED-OFFER-WORKSHEET.md](templates/HOSTED-OFFER-WORKSHEET.md) and
the earlier pricing hypothesis's *What the pilots must answer* ([../archive/PRICING-HYPOTHESIS.md](../archive/PRICING-HYPOTHESIS.md), archived). Recommended: run the drill tenant
(provision, sign in, open the escrow, export, tear down) before a pilot's real records are hosted.

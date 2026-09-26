# SUDS buyer guide: for IT partners, county IT and security

For whoever will run and review SUDS for a harm-reduction, outreach or prevention programme: a CBO's managed-IT
partner, a county IT team hosting a CBO's instance, or a county security and privacy reviewer. It answers the gate
questions — deployment, identity, data flows, security controls, recovery, accessibility, integration and
support — and points to the evidence for each. It is honest about what is not yet in place; see the
[readiness scorecard](README.md#readiness-scorecard).

**What SUDS is, in one line:** a single-server web application, Node.js built-ins only, that holds 42 CFR
Part 2 and HIPAA-protected programme records for non-billing harm-reduction and prevention programmes. It is
not an EHR, does not bill ([POSITIONING.md](POSITIONING.md)), and is **not a hosted service**: someone — you —
runs the server. Who does what, including at 2am: [HOSTING.md](HOSTING.md).

## Deployment options

| Option | Who runs it | System of record | Good for | Status |
| --- | --- | --- | --- | --- |
| **Self-hosted by the programme's IT partner** | The CBO's managed-IT provider or its own staff, on a VM, office server or container (`Dockerfile`, `docker-compose.yml` with a Caddy TLS proxy), or in the programme's own cloud account | The programme's server | CBOs with an IT partner | Available ([docs/INSTALL.md](../INSTALL.md), [docs/DEPLOYMENT.md](../DEPLOYMENT.md)) |
| **County-hosted** | County IT, for a county programme or a CBO the county sponsors | The county's server | County-sponsored pilots; data never leaves county infrastructure | Available (same) |
| **Vendor-hosted, single-tenant** | The vendor, one isolated instance per programme in a US cloud region under a BAA with the cloud provider | The vendor-hosted instance | CBOs with no IT capacity | **Planned — not offered.** Requires the checklist in [HOSTING.md](HOSTING.md) (cloud BAA, offsite backups, monitoring, on-call, insurance, pen test) |
| **SUDS on this device** | Nobody — runs in one browser | That browser | A single navigator with no server; not recommended for county programmes that share records | Available ([docs/WEB_APP.md](../WEB_APP.md)) |

Requirements (self-hosted or county-hosted): Node.js 22.13+, an encrypted disk for the data directory, TLS (built-in or a
reverse proxy such as IIS ARR, nginx, Caddy or a cloud load balancer), outbound internet not required. One
process and one SQLite database per programme; a second process is refused
([docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Single instance only*). Sized for dozens of users, not hundreds.

## What the operator does vs what the vendor provides

"Operator" is whoever hosts: the programme's IT partner or the county.

| | Self-hosted / county-hosted (operator) | Vendor-hosted (planned, not offered) |
| --- | --- | --- |
| Server, OS patching, disk encryption, firewall | Operator | Vendor |
| TLS certificate | Operator | Vendor |
| Encryption keys and custody | Operator (secrets manager or `data/keys.json`) | Vendor, with documented custody; programme may request a key-escrow arrangement |
| Backups, off-host copy, restore drills | Operator (built-in scheduler and drill help) | Vendor, with drill results shared |
| Identity provider (SSO), if any | Programme or county | Programme or county (vendor configures the OIDC client) |
| Upgrades | Operator installs tagged releases (vendor provides release, notes, checksum, business-hours help) | Vendor, pilot group first |
| User accounts, roles, MFA enrolment | Programme's SUDS administrator | Programme's SUDS administrator |
| Audit review, break-glass acknowledgement, participant requests | Programme | Programme |
| Software defects, security fixes, support | Vendor, business hours ([templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md)) | Vendor |
| BAA / Part 2 QSOA | Required if the vendor can access PHI (e.g. support on the server) | Required |
| Uptime and 2am on-call | The operator's own | Vendor, only as staffed and written into the contract ([HOSTING.md](HOSTING.md)) |

## Identity and access

- **Single sign-on** with the county identity provider (Entra ID / Azure AD, Okta, Keycloak, ADFS…) over OpenID
  Connect, Authorization Code + PKCE, RS256-verified ID tokens. SSO signs in only to accounts an administrator
  has linked; it never creates or promotes accounts ([docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Single sign-on*).
- **Local accounts** where SSO is not used: scrypt password hashing, 12-character policy, lockout, rate limiting.
- **MFA** (TOTP) required for every role by default, with a configurable grace period.
- **Role-based access** (navigator, clinician, supervisor, finance, readonly, admin) with caseload scoping;
  clinical notes restricted to clinical roles; administrator access to clinical notes only via audited
  break-glass, reviewed by a supervisor.
- **Account requests** (Sign up) wait for administrator approval and can be turned off.
- **Sessions**: 15-minute idle timeout (configurable, max 60), 12-hour absolute limit.
- Detail: [docs/HIPAA.md](../HIPAA.md) and [docs/security/IDENTITY.md](../security/IDENTITY.md).

## Data flows

```
Staff browser ──HTTPS (TLS 1.2+)──> SUDS server (county or vendor host) ──> SQLite on encrypted disk
                                        │                                      (PHI fields AES-256-GCM)
                                        ├──> Encrypted backups ──> off-host share (county-chosen)
                                        ├──> County IdP (OIDC discovery, keys)               [optional]
                                        ├──> FHIR R4 API / bulk export ──> county EHR / HIE  [optional, consent-enforced]
                                        ├──> Encounter hand-off / CalOMS extract (files) ──> county EHR / DHCS via county
                                        ├──> Microsoft Graph (OneNote import)                [optional, needs BAA]
                                        └──> Provider websites (resource pictures only, no PHI) [optional]
```

- **No third-party scripts, CDNs, analytics or telemetry.** The only outbound connections are ones an
  administrator configures (listed above). Nothing polls for updates.
- **Where PHI lives:** only in the SUDS database and its encrypted backups. Logs and audit details never
  contain names or note text.
- **Local mode** (offline copy on a device) is **off by default** and should stay off unless a documented
  field-work need exists ([docs/PLATFORM.md](../PLATFORM.md)).
- Data classification by table: [docs/HIPAA.md](../HIPAA.md), *Data classification inside the database*.

## Security controls and evidence

| Control | What SUDS does | Evidence |
| --- | --- | --- |
| Architecture | Single Node.js process, built-ins only, zero third-party runtime packages; CSP self-only, no inline scripts | [docs/security/ARCHITECTURE.md](../security/ARCHITECTURE.md), [docs/DEPLOYMENT.md](../DEPLOYMENT.md) |
| Encryption at rest | AES-256-GCM on identifying and free-text fields (names, contact details, dates of birth, notes, consents…), keys outside the database; blind-index (HMAC) search; coded reporting fields (status, substance, risk…) are not field-encrypted and rely on the required disk encryption — table-by-table in HIPAA.md, *Data classification* | [docs/HIPAA.md](../HIPAA.md), [docs/security/ENCRYPTION-AND-KEYS.md](../security/ENCRYPTION-AND-KEYS.md) |
| Encryption in transit | TLS 1.2+, HSTS, secure/HttpOnly/SameSite=Strict cookies | [docs/HIPAA.md](../HIPAA.md) |
| Key management | Three independently rotatable keys; rotation runbook; retired-key handling | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Key rotation runbook* |
| Audit | PHI reads and writes through the API (every route that touches PHI is required to log — `CLAUDE.md`, [ADR-0006](../architecture/ADR-0006-append-only-audit.md)), sign-ins, denials, exports, disclosures and configuration changes; tamper-evident hash chain, append-only in the database, anchored every 6 hours (write-once when the operator points `AUDIT_ANCHOR_DIR` at WORM storage), verified incrementally and weekly in full; 7-year retention | [docs/HIPAA.md](../HIPAA.md), [docs/security/LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md) |
| 42 CFR Part 2 | Consent elements enforced, referral gating, disclosure accounting, final-rule controls | [docs/HIPAA.md](../HIPAA.md), [docs/compliance/PART2.md](../compliance/PART2.md) |
| De-identification | Safe Harbor exports by default (year-only dates, 90+, ZIP3 with restricted areas as 000, no free text, random per-export record ids); small-cell suppression in the funder report, naloxone log and settlement report, with the publication label only for whole-programme, standard-period runs | [docs/HIPAA.md](../HIPAA.md) |
| Backup and recovery | Scheduled encrypted backups, off-host copy, restore from the UI, pre-migration snapshots; DR drill with measured RTO/RPO | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Backups*; [docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md) |
| Monitoring | `/api/health` readiness probe; Prometheus metrics; JSON logs; no PHI in logs | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Monitoring and logs* |
| Hardening | Checklist for host, TLS, proxy, permissions, firewall, MFA, keys | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Hardening checklist* |
| Supply chain and change control | Zero runtime packages on the server; release zips with SHA-256 checksums (not yet signed); Dependabot for the browser-kernel build tools. **Development is AI-assisted**: most commits are written with an AI coding assistant (171 of 202 up to 1.11.0) under the rules in `CLAUDE.md`, gated by automated tests and CI (API suite, browser suite with accessibility checks, drift checks) and reviewed and merged by the owner. There is no second human reviewer today. Branch protection and independent review of what you deploy are yours to configure ([ADOPTION.md](../ADOPTION.md) §1) | [docs/security/SDLC.md](../security/SDLC.md), [docs/RELEASE.md](../RELEASE.md), [docs/architecture/](../architecture/README.md) |
| Residual risks | Blind-index leakage, shared index/audit key, single instance, local-mode keys, experimental `node:sqlite` | [docs/HIPAA.md](../HIPAA.md), *Risk register notes* |
| Attestation | **SOC 2: readiness self-assessment only; no audit report yet. No third-party pen test yet.** | [docs/security/SOC2-READINESS.md](../security/SOC2-READINESS.md); timeline in [PROCUREMENT.md](PROCUREMENT.md) |

## Security questionnaire

A pre-answered security questionnaire (HECVAT-Lite and CSA CAIQ style questions, and the themes of city/county
supplier assessments such as San Francisco's, each answer pointing to evidence) is
[docs/security/QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md). Send us your own questionnaire as well; we answer
it from the same evidence and will not answer "yes" to a control that is not in place.

## Accessibility

- WCAG 2.1 AA self-audit and Accessibility Conformance Report (VPAT 2.x format):
  [docs/accessibility/ACR-WCAG21.md](../accessibility/ACR-WCAG21.md).
- Accessibility statement, known issues and how to report a barrier:
  [docs/accessibility/STATEMENT.md](../accessibility/STATEMENT.md).
- Every release runs an automated browser suite, including accessibility-tree checks; 44px touch targets,
  keyboard access and contrast in both themes are tested.
- This is a vendor self-assessment. The county may commission its own review; the contract template offers an
  accessibility warranty ([PROCUREMENT.md](PROCUREMENT.md)).

## Integration

| Need | How |
| --- | --- |
| County EHR (SmartCare, Netsmart…) | Encounter hand-off export of services the EHR needs to record or bill ([docs/SCOPE.md](../SCOPE.md)); FHIR R4 read API and bulk export with Part 2 consent enforcement ([docs/integration/FHIR.md](../integration/FHIR.md)) |
| State reporting | CalOMS Tx extract for the county's submission ([docs/compliance/CALOMS.md](../compliance/CALOMS.md)); built, but the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until verified with DHCS/county |
| Identity | OIDC single sign-on |
| Existing spreadsheets | Excel/CSV import with templates and validation ([docs/USER_GUIDE.md](../USER_GUIDE.md), *Importing spreadsheets*) |
| Field notes | Pocket AI and OneNote import through a review queue; write-only intake API keys ([docs/IMPORTS.md](../IMPORTS.md)) |
| BI / data warehouse | Excel/CSV of every table, de-identified by default; FHIR bulk export |
| Full API | [docs/API.md](../API.md) |

## Support model

- **Vendor support in business hours** with severity levels and response targets ([templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md)).
  The vendor is one person today; there is no 24×7 support and no vendor on-call.
- **Releases**: tagged, checksummed, with release notes; pilot-group-first rollout recommended
  ([docs/ADOPTION.md](../ADOPTION.md), section 3). Security fixes expedited.
- **Open source (MIT)**: the county can inspect, build and maintain the code without the vendor; there is no
  licence lock-in. The adoption plan asks the county to name a code owner whether or not it buys support.
- **Operator staffing** for a self-hosted or county-hosted install: 0.25–0.5 FTE system administrator, a key custodian, a
  monthly audit reviewer ([docs/ADOPTION.md](../ADOPTION.md), section 7).

## Before real client data

The go-live checklist in [docs/ADOPTION.md](../ADOPTION.md), section 8, plus: signed BAA / Part 2 QSOA
([templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md)) and DPA ([templates/DPA-DRAFT.md](templates/DPA-DRAFT.md))
where the vendor hosts or can access PHI; hardening checklist complete; restore drill done; HIPAA.md risk
register notes copied into the county register with owners.

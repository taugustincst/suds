# SUDS buyer guide: for county IT and security

For the CIO, IT security lead and privacy officer reviewing SUDS for a SUD programme. It answers the gate
questions — deployment, identity, data flows, security controls, recovery, accessibility, integration and
support — and points to the evidence for each. It is honest about what is not yet in place; see the
[readiness scorecard](README.md#readiness-scorecard).

**What SUDS is, in one line:** a single-server web application, Node.js built-ins only, that holds 42 CFR
Part 2 and HIPAA-protected programme records for non-billing SUD programmes. It is not an EHR and does not bill
([POSITIONING.md](POSITIONING.md)).

## Deployment options

| Option | Who runs it | System of record | Good for | Status |
| --- | --- | --- | --- | --- |
| **County-hosted office server** | County IT, on a VM, physical server or container (`Dockerfile`, `docker-compose.yml` with a Caddy TLS proxy) | The county's server | Most counties; data never leaves county infrastructure | Available ([docs/INSTALL.md](../INSTALL.md), [docs/DEPLOYMENT.md](../DEPLOYMENT.md)) |
| **Vendor-hosted** | The vendor, one isolated instance per programme in a US cloud region under a BAA with the cloud provider | The vendor-hosted instance | CBOs and small counties without server capacity | **Planned** — offered once the hosting environment, BAA chain and SOC 2 scope are in place ([PROCUREMENT.md](PROCUREMENT.md), vendor to-do) |
| **SUDS on this device** | Nobody — runs in one browser | That browser | A single navigator with no server; not recommended for county programmes that share records | Available ([docs/WEB_APP.md](../WEB_APP.md)) |

Requirements (county-hosted): Node.js 22.13+, an encrypted disk for the data directory, TLS (built-in or a
reverse proxy such as IIS ARR, nginx, Caddy or a cloud load balancer), outbound internet not required. One
process and one SQLite database per programme; a second process is refused
([docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Single instance only*). Sized for dozens of users, not hundreds.

## What the county hosts vs what the vendor provides

| | County-hosted | Vendor-hosted (planned) |
| --- | --- | --- |
| Server, OS patching, disk encryption, firewall | County | Vendor |
| TLS certificate | County | Vendor |
| Encryption keys and custody | County (secrets manager or `data/keys.json`) | Vendor, with documented custody; county may request a key-escrow arrangement |
| Backups, off-host copy, restore drills | County (built-in scheduler helps) | Vendor, with drill results shared |
| Identity provider (SSO) | County | County (vendor configures the OIDC client) |
| Upgrades | County installs tagged releases (vendor provides release, notes, checksum, support) | Vendor, pilot group first |
| User accounts, roles, MFA enrolment | County administrator | County administrator |
| Audit review, break-glass acknowledgement, patient requests | County | County |
| Software defects, security fixes, support desk | Vendor | Vendor |
| BAA / Part 2 QSOA | Required if the vendor can access PHI (e.g. support on the server) | Required |
| Uptime commitment | County's own | Vendor SLA ([templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md)) |

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
| Encryption at rest | AES-256-GCM on every PHI field, keys outside the database; blind-index (HMAC) search; disk encryption required | [docs/HIPAA.md](../HIPAA.md), [docs/security/ENCRYPTION-AND-KEYS.md](../security/ENCRYPTION-AND-KEYS.md) |
| Encryption in transit | TLS 1.2+, HSTS, secure/HttpOnly/SameSite=Strict cookies | [docs/HIPAA.md](../HIPAA.md) |
| Key management | Three independently rotatable keys; rotation runbook; retired-key handling | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Key rotation runbook* |
| Audit | Every PHI read/write, sign-in, denial, export and config change; tamper-evident hash chain, append-only in the database, anchored every 6 hours (write-once when the county points `AUDIT_ANCHOR_DIR` at WORM storage), verified incrementally and weekly in full; 7-year retention | [docs/HIPAA.md](../HIPAA.md), [docs/security/LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md) |
| 42 CFR Part 2 | Consent elements enforced, referral gating, disclosure accounting, final-rule controls | [docs/HIPAA.md](../HIPAA.md), [docs/compliance/PART2.md](../compliance/PART2.md) |
| De-identification | Safe Harbor exports by default; small-cell suppression in funder report | [docs/HIPAA.md](../HIPAA.md) |
| Backup and recovery | Scheduled encrypted backups, off-host copy, restore from the UI, pre-migration snapshots; DR drill with measured RTO/RPO | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Backups*; [docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md) |
| Monitoring | `/api/health` readiness probe; Prometheus metrics; JSON logs; no PHI in logs | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Monitoring and logs* |
| Hardening | Checklist for host, TLS, proxy, permissions, firewall, MFA, keys | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Hardening checklist* |
| Supply chain | Release zips with SHA-256 checksums; Dependabot; human review of every change | [docs/ADOPTION.md](../ADOPTION.md), [docs/RELEASE.md](../RELEASE.md) |
| Residual risks | Blind-index leakage, shared index/audit key, single instance, local-mode keys, experimental `node:sqlite` | [docs/HIPAA.md](../HIPAA.md), *Risk register notes* |
| Attestation | **SOC 2: readiness self-assessment only; no audit report yet. No third-party pen test yet.** | [docs/security/README.md](../security/README.md) (SOC 2 readiness); timeline in [PROCUREMENT.md](PROCUREMENT.md) |

## Security questionnaire

A completed security questionnaire (answers to the common county, CAIQ-lite and SIG-Lite style questions, each
pointing to evidence) is kept in [docs/security/README.md](../security/README.md). Send us your county's own questionnaire as
well; we answer it from the same evidence and will not answer "yes" to a control that is not in place.

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

- **Vendor support desk** with severity levels and response targets ([templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md)).
- **Releases**: tagged, checksummed, with release notes; pilot-group-first rollout recommended
  ([docs/ADOPTION.md](../ADOPTION.md), section 3). Security fixes expedited.
- **Open source (MIT)**: the county can inspect, build and maintain the code without the vendor; there is no
  licence lock-in. The adoption plan asks the county to name a code owner whether or not it buys support.
- **County staffing** for a county-hosted install: 0.25–0.5 FTE system administrator, a key custodian, a
  monthly audit reviewer ([docs/ADOPTION.md](../ADOPTION.md), section 7).

## Before real client data

The go-live checklist in [docs/ADOPTION.md](../ADOPTION.md), section 8, plus: signed BAA / Part 2 QSOA
([templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md)) and DPA ([templates/DPA-DRAFT.md](templates/DPA-DRAFT.md))
where the vendor hosts or can access PHI; hardening checklist complete; restore drill done; HIPAA.md risk
register notes copied into the county register with owners.

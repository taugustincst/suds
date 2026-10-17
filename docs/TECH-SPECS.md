# SUDS technical specifications

The facts an IT, security or procurement reviewer asks for first, one line each, with the document that gives the
detail. Version 1.25.9 (October 2026). Where a line and its source document disagree, the source document is right,
and the line is a defect to report.

## Product

| | |
| --- | --- |
| What it is | Case management and reporting for outreach, harm-reduction and SUD navigation programmes, with privacy controls built to support 42 CFR Part 2 ([SCOPE.md](SCOPE.md), [market/POSITIONING.md](market/POSITIONING.md)) |
| What it is not | An EHR; a Drug Medi-Cal billing system; an eMAR or e-prescribing system ([SCOPE.md](SCOPE.md)) |
| Vendor and licence | AugustInnovations LLC; proprietary, source visible. SUDS on this device is free for real use at its official address; the office server needs a signed agreement after a 90-day evaluation with fictional data ([../LICENSE](../LICENSE)) |
| Clients | The web app only, in any current browser; it can be added to the home screen on phones. There are no native apps ([PLATFORM.md](PLATFORM.md)) |
| Release cadence | Patches at most weekly (security fixes when ready); at most one feature release every 28 days; each release ships its own SBOM and checksums ([RELEASE.md](RELEASE.md)) |

## Ways to run it

| Option | Runs on | Detail |
| --- | --- | --- |
| SUDS on this device | The browser alone: records encrypted in that browser on that device, with device backups. No server | [WEB_APP.md](WEB_APP.md) |
| Office server, self-hosted | Linux: Ubuntu 24.04 or RHEL 9, with a hardened one-command installer (LUKS data disk, firewall, sandboxed service, a weekly signed compliance check). Windows: Server 2019/2022 or Windows 10/11 x64, as a service with no Node.js to install. Or Docker with a Caddy TLS proxy | [SELF-HOSTING.md](SELF-HOSTING.md), [WINDOWS-SERVER.md](WINDOWS-SERVER.md), [DEPLOYMENT.md](DEPLOYMENT.md) |
| Office server, hosted by the vendor | One AWS Lightsail VM per customer in a US region, with its own encrypted disk, database and keys, and escrowed key copies. No shared database. Offered from October 2026; no customer is hosted yet | [market/HOSTING.md](market/HOSTING.md), [architecture/COUNTY-MULTI-TENANT.md](architecture/COUNTY-MULTI-TENANT.md) |
| Offline field copy | Optional, off by default: an encrypted copy in the browser that syncs with the office server on command. The office server stays authoritative | [PLATFORM.md](PLATFORM.md) |

## Server sizing

| Staff using it at once | vCPU | RAM | Encrypted data disk |
| --- | --- | --- | --- |
| Up to 25 (most programmes) | 2 | 4 GB | 20 GB |
| 25 to 75 | 4 | 8 GB | 50 GB |
| More than 75 | 4–8 | 16 GB | 100 GB (or one SUDS per programme) |

The server is one Node.js process with one SQLite database. It scales up, not out. It is measured at 20,000 clients,
100,000 visits and 200,000 notes, with 50 navigators working at once ([PERFORMANCE.md](PERFORMANCE.md),
[SELF-HOSTING.md](SELF-HOSTING.md)).

## Stack and supply chain

| | |
| --- | --- |
| Server | Node.js 22 (≥ 22.13) built-ins only (`node:sqlite`, `node:crypto`, `node:http`). **No runtime npm packages** ([architecture/README.md](architecture/README.md)) |
| Web app | Vanilla JavaScript modules with no build step and no third-party scripts, under a strict Content Security Policy |
| Browser offline engine | A committed, reproducible bundle with seven small pinned libraries and SQLite (WebAssembly), all listed in the SBOM ([WEB_APP.md](WEB_APP.md)) |
| SBOM | CycloneDX 1.5 for every release ([evidence/sbom-1.25.9.cdx.json](evidence/sbom-1.25.9.cdx.json)) |
| Release integrity | Zip SHA-256 published in two channels; immutable GitHub Releases; a release run that waits for an approval ([security/OPERATIVE-CONTROLS.md](security/OPERATIVE-CONTROLS.md)) |

## Security

| | |
| --- | --- |
| Encryption at rest | AES-256-GCM on client identifiers and free text, with HMAC blind indexes for search; an encrypted disk is required for the rest ([security/ENCRYPTION-AND-KEYS.md](security/ENCRYPTION-AND-KEYS.md)) |
| Encryption in transit | TLS 1.2+ (built in, or behind a proxy), HSTS, `no-store` caching on every API response ([security/ARCHITECTURE.md](security/ARCHITECTURE.md)) |
| Keys | Generated per install; rotation scripts for the encryption and index keys; on the hosted service, per-customer keys with escrowed copies ([security/ENCRYPTION-AND-KEYS.md](security/ENCRYPTION-AND-KEYS.md)) |
| Sign-in | Passwords hashed with scrypt; TOTP MFA required for every role by default; passkeys (fingerprint or face, with no biometric data held); optional OIDC single sign-on and SCIM 2.0 provisioning ([security/IDENTITY.md](security/IDENTITY.md), [FINGERPRINT.md](FINGERPRINT.md)) |
| Access control | Role-based permissions (navigator, clinician, supervisor, finance, read-only, admin), each one changeable per person; caseload scoping; separation of duties for approvals; audited break-glass ([security/IDENTITY.md](security/IDENTITY.md)) |
| Audit | Every read and write of protected information, sign-in, export, disclosure and configuration change, in a hash-chained log whose head is sealed every 500 entries and at shutdown, and can be anchored outside the database; exportable and verifiable offline ([security/LOGGING-AND-AUDIT.md](security/LOGGING-AND-AUDIT.md)) |
| Part 2 | Consents naming the recipient; one disclosure gate that checks consent and purpose and writes the accounting of disclosures ([compliance/PART2.md](compliance/PART2.md)) |
| Exports | De-identified to HIPAA Safe Harbor by default; identified exports need a permission, a named recipient and a purpose, and are recorded as disclosures ([HIPAA.md](HIPAA.md)) |
| Testing | The vendor's own tests are published and labelled as the vendor's; **no independent penetration test yet**; the scope for one is published ([security/PEN-TEST-SCOPE.md](security/PEN-TEST-SCOPE.md)) |
| Certifications | None: no SOC 2, ISO 27001, HITRUST or StateRAMP. A SOC 2 readiness mapping is published ([security/SOC2-READINESS.md](security/SOC2-READINESS.md)) |
| Vulnerability reports | security@suds.systems or GitHub private vulnerability reporting ([../SECURITY.md](../SECURITY.md)) |

## Backup and recovery

| | |
| --- | --- |
| Backups | Scheduled, encrypted backups, with optional frequent online snapshots and an offsite copy ([security/BACKUP-AND-DR.md](security/BACKUP-AND-DR.md)) |
| Targets | RPO: the shortest configured interval (24 h by default; minutes with snapshots). RTO: a 60-minute target, measured by each recovery drill |
| Drills | A recovery drill restores from the copy that would survive losing the server and records the time taken (recorded runs at 20,000 clients) |
| Data lifecycle | Retention, legal holds, deletion and residency ([security/DATA-LIFECYCLE.md](security/DATA-LIFECYCLE.md), [security/DATA-INVENTORY.md](security/DATA-INVENTORY.md)) |

## Standards and integrations

| | |
| --- | --- |
| HIPAA / 42 CFR Part 2 | Controls mapped in [HIPAA.md](HIPAA.md) and [compliance/PART2.md](compliance/PART2.md) (shared responsibility: SUDS supports compliance, it does not provide it) |
| CalOMS Tx | Capture, checks and the extract file; code sets verified against the DHCS Data Dictionary v3.0; the upload file layout is confirmed with the county ([compliance/CALOMS.md](compliance/CALOMS.md)) |
| Funder reporting | Funder report, NDP-style log, syringe services summary, opioid-settlement report (with the DHCS and county layouts), SABG prevention events ([compliance/HARM-REDUCTION-REPORTING.md](compliance/HARM-REDUCTION-REPORTING.md)) |
| FHIR R4 | A read API (Patient, EpisodeOfCare, Encounter, Consent, ServiceRequest, Task, Observation, DocumentReference) and Bulk Data `$export`, shared only under a live Part 2 consent; imports from an EHR's FHIR export ([integration/FHIR.md](integration/FHIR.md), [integration/EHR-PART2-LAYER.md](integration/EHR-PART2-LAYER.md)) |
| REST API | Documented, with API keys for intake ([API.md](API.md)) |
| Spreadsheets and notes | Excel and CSV import and export; Pocket AI and OneNote note import ([IMPORTS.md](IMPORTS.md)) |
| PowerDMS (next feature release) | Policies linked to the county's PowerDMS documents, with the revision staff must sign and who signs it; staff sign-offs read from PowerDMS's signature or training report (Excel or CSV); no live API connection ([integration/POWERDMS.md](integration/POWERDMS.md)) |
| Accessibility | WCAG 2.1 AA, a self-assessment published as an ACR in VPAT 2.5 format; an automated check of every screen runs on each code change ([accessibility/ACR-WCAG21.md](accessibility/ACR-WCAG21.md)) |

## Optional features (off until an administrator turns them on)

AI documentation copilot (drafts only, after a BAA with QSOA terms and counsel's review;
[AI-COPILOT.md](AI-COPILOT.md)) · county connection ([COUNTY-VIEW.md](COUNTY-VIEW.md)) · one-time secure referral links
([security/REFERRAL-LINKS.md](security/REFERRAL-LINKS.md)) · field devices and participant codes first
([PLATFORM.md](PLATFORM.md)) · passkey authenticator allow-list ([FINGERPRINT.md](FINGERPRINT.md)) · offline field copies.

## Support

Paid plans: email support with a reply within 2 business days; security fixes ship as patches as soon as they are
verified; no 24×7 support and no uptime commitment yet ([SUPPORT.md](SUPPORT.md)). Contact: Licensing, AugustInnovations
LLC, info@suds.systems.

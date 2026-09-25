# SOC 2 readiness mapping

**Status: SUDS has no SOC 2 report** (Type 1 or Type 2), and no ISO/IEC 27001, HITRUST, StateRAMP or FedRAMP certification. This document is a *readiness mapping*, not an attestation. It maps the AICPA Trust Services Criteria (2017, revised points of focus 2022) to the technical controls SUDS provides, marks what the county must supply as policy or operation, and lists what an auditor would ask for.

Why this matters for a county: SUDS is software the county **operates**. A SOC 2 report attests to how a *service organisation* operates its controls over a period. With SUDS there is no service organisation between the county and its data — the county (or its hosting provider) is the operator. The meaningful assurance is therefore (a) the county's own controls, audited within its existing programme (internal audit, HIPAA risk analysis, a state audit), using the evidence SUDS produces; or (b) if a vendor hosts SUDS for the county, that vendor's SOC 2 Type 2 covering the hosting. Only an independent CPA firm can issue a SOC 2 report; this mapping shortens its work, it does not substitute for it.

Legend — **S**: provided by SUDS (technical control, with evidence); **C**: county policy/operation required; **S+C**: SUDS provides the mechanism, the county must operate it.

## Common Criteria (Security)

| TSC | Criterion (summary) | Control in SUDS / county | Type | Evidence an auditor would sample |
| --- | --- | --- | --- | --- |
| CC1.1–1.5 | Control environment: integrity, oversight, structure, competence, accountability | Code owner and change review (`../ADOPTION.md` §1); county HR, training, sanctions | C | Org chart, code-owner designation, training records, sanctions policy |
| CC2.1 | Information to support internal control | Security status page; audit log; drill reports | S | Security status export; audit export |
| CC2.2–2.3 | Internal and external communication | Privacy notice contact (`program_contact`); release notes (CHANGELOG) | S+C | Communication plan; notices |
| CC3.1–3.4 | Risk assessment, fraud risk, change in risk | Risk register notes to adopt (`../HIPAA.md`) | C | Risk analysis (§164.308(a)(1)), risk register |
| CC4.1–4.2 | Monitoring of controls; deficiency communication | Scheduled audit verification + anchor checks; `/api/health`; Security status; drill history | S+C | Monitoring dashboard, alert routing, Security status reviewed monthly |
| CC5.1–5.3 | Control activities, technology general controls, policies | Settings enforce policy (MFA, timeouts, SSO, retention) | S+C | Settings screenshots / `GET /api/admin/settings`; written policies |
| CC6.1 | Logical access: identification, authentication, encryption, keys | Unique accounts; scrypt; TOTP MFA (every role, enforceable); OIDC SSO with SSO-required mode; RBAC; AES-256-GCM field encryption; customer-held keys | S | [IDENTITY.md](IDENTITY.md), [ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md); `test/security-evidence.test.js`, `test/api.test.js` |
| CC6.2 | Registration and authorisation of new users | Admin-created accounts or approved access requests; role chosen at approval | S+C | Access-request approvals in audit log (`user.*`); county onboarding tickets |
| CC6.3 | Role changes, removal, least privilege | Role matrix (`server/auth.js` `PERMS`); deactivation revokes sessions and wipes devices; caseload scoping | S+C | Quarterly access review (Users & roles export), deactivation audit entries vs HR leavers |
| CC6.4 | Physical access | Host in county data centre / cloud | C | Data-centre controls; cloud provider's SOC 2 |
| CC6.5 | Disposal | Retention hard-delete; crypto-shredding on decommission | S+C | `client.purge` audit entries; disposal log |
| CC6.6 | Boundary protection | TLS; proxy; body caps; rate limits; CSP; host firewall | S+C | Firewall rules; `Caddyfile`; scan results |
| CC6.7 | Transmission and movement of data | TLS/HSTS; encrypted backups; disclosures accounted | S | [ARCHITECTURE.md](ARCHITECTURE.md); accounting of disclosures |
| CC6.8 | Malicious software, unauthorised software | Zero runtime dependencies; checksummed releases; read-only container/code | S+C | Dockerfile, systemd unit, endpoint protection on host |
| CC7.1 | Detection of configuration changes and vulnerabilities | `settings.update` audited; Dependabot; Security status | S+C | Audit entries; patch records |
| CC7.2 | Monitoring for anomalies | Audit log filters (denials, break-glass, exports, failures); health endpoint; metrics | S+C | SIEM alert rules; monthly audit review sign-off |
| CC7.3–7.5 | Incident evaluation, response, recovery | Incident register (Settings → Incidents), containment actions, evidence export | S+C | [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md); incident records; tabletop exercise |
| CC8.1 | Change management | Reviewed PRs, CI tests, tagged releases, staged rollout, migrations with pre-migration snapshot | S+C | CI history; release tags; deployment log ([SDLC.md](SDLC.md)) |
| CC9.1 | Business disruption risk mitigation | Backups, drills, standby | S+C | [BACKUP-AND-DR.md](BACKUP-AND-DR.md) |
| CC9.2 | Vendor and partner risk | No SUDS subprocessors; county's hosting / IdP / Microsoft BAAs | C | Vendor inventory, BAAs |

## Availability

| TSC | Control | Type | Evidence |
| --- | --- | --- | --- |
| A1.1 Capacity | Disk/health monitoring, metrics; single-instance sizing guidance | S+C | Metrics history; `/api/health` alerts |
| A1.2 Environmental protections, backups, recovery infrastructure | Encrypted scheduled backups verified on write; offsite copy; warm standby procedure | S+C | Backup status history (`backup.scheduled` audit entries), offsite listings |
| A1.3 Recovery plan testing | **Recovery drill** with measured RTO/RPO and signed reports; monthly schedule | S | `dr-drill-*.json` reports (verify with `verifyReport`), `dr.drill` audit entries |

## Confidentiality

| TSC | Control | Type | Evidence |
| --- | --- | --- | --- |
| C1.1 Identify and protect confidential information | Field-level encryption; data classification (`../HIPAA.md`); minimum-necessary roles; Part 2 consent enforcement | S | Schema (`*_enc`), `server/disclosure.js` |
| C1.2 Disposal | Retention purge; backup expiry; decommission | S+C | Purge audit entries; disposal log |

## Processing integrity (if in scope)

| TSC | Control | Type |
| --- | --- | --- |
| PI1.1–1.5 | Input validation, signed/locked notes with verifiable hashes, addenda not edits, idempotent writes, migrations in transactions with foreign-key checks, sync insert-only rules for legal records | S |

## Privacy (if in scope)

HIPAA individual rights (access, amendment, restriction, accounting) are tracked per client (`../HIPAA.md`); notices, consent language and the privacy programme are the county's (C).

## Gaps that need county policy or operation (not software)

1. Written information-security, access-control, change-management, incident-response, business-continuity, vendor-management and data-retention policies, approved and reviewed annually.
2. Named key custodians and a key-custodian log; secrets manager.
3. Periodic user-access reviews (quarterly), with evidence of leavers removed.
4. Monthly audit-log review with sign-off (Settings → Audit log shortcuts).
5. Monitoring and alert routing for `/api/health` and the SIEM.
6. Backup/restore and recovery-drill schedule with results reviewed; a documented RTO/RPO.
7. Security awareness training; HR screening; sanctions.
8. Risk analysis and risk register (adopt the register notes in `../HIPAA.md`).
9. Vendor inventory and BAAs (hosting, identity provider, Microsoft if Graph import is used).
10. Penetration test and vulnerability scanning of the deployed environment ([PEN-TEST-SCOPE.md](PEN-TEST-SCOPE.md)).

## Gaps in SUDS itself (known, tracked)

* No release signing / provenance attestation beyond SHA-256 checksums ([SDLC.md](SDLC.md)).
* The index key serves both blind indexes and the audit chain (`../HIPAA.md`, risk register).
* SSO sign-ins do not accept the IdP's MFA claim in place of SUDS TOTP.
* No SCIM provisioning; role mapping from IdP groups is manual.
* No SAST in CI yet.
* Single instance; no automatic failover.

## What an auditor would need from a county running SUDS

A system description (use [ARCHITECTURE.md](ARCHITECTURE.md)); the policies above; for the audit period: Security status snapshots, the audit export and anchor files (with verification output), recovery-drill reports, backup status history, access-review records, change/deployment log with CI evidence, incident register entries, vulnerability/patch records, and the hosting provider's own SOC 2 report where the host is outsourced. For a Type 2, these must cover the whole period (typically 6–12 months), which is why the drill, the anchors and the reviews are scheduled rather than done once.

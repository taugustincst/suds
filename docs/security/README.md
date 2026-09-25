# SUDS security evidence package

For county IT, security and privacy reviewers. Everything here describes controls that exist in the code, with the file that implements each one, so a claim can be checked rather than taken on trust. Where SUDS relies on the county (policy, hosting, key custody, staffing) the documents say so.

**What SUDS is not.** SUDS holds **no SOC 2, ISO/IEC 27001, HITRUST, StateRAMP or FedRAMP certification or attestation**, and no document here is one. It is open-source software a county runs on its own infrastructure. These documents map its controls to those frameworks so that a county (or its auditor) can assess an installation; independent attestation of a deployment requires an independent auditor examining the county's operation of it over time. See [SOC2-READINESS.md](SOC2-READINESS.md).

## What to read

| If you are asked about… | Read |
| --- | --- |
| What the system is, where PHI flows, trust boundaries | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Encryption at rest and in transit, keys, rotation, customer-managed keys | [ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md) |
| SSO, MFA, passwords, sessions, roles, break-glass | [IDENTITY.md](IDENTITY.md) |
| Audit logging, immutability, log collection, auditor export | [LOGGING-AND-AUDIT.md](LOGGING-AND-AUDIT.md) |
| Backups, RPO/RTO, tested recovery, standby | [BACKUP-AND-DR.md](BACKUP-AND-DR.md) |
| Retention, deletion, purge, data residency, subprocessors | [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) |
| Dependencies, patching, scanning | [VULNERABILITY-MANAGEMENT.md](VULNERABILITY-MANAGEMENT.md) |
| How changes are made, tested and released | [SDLC.md](SDLC.md) |
| Breach / incident handling | [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md) |
| SOC 2 Trust Services Criteria mapping and gaps | [SOC2-READINESS.md](SOC2-READINESS.md) |
| A pre-answered vendor security questionnaire (HECVAT-Lite / CAIQ style) | [QUESTIONNAIRE.md](QUESTIONNAIRE.md) |
| Scope and rules for a penetration test | [PEN-TEST-SCOPE.md](PEN-TEST-SCOPE.md) |

Related documents elsewhere: [../HIPAA.md](../HIPAA.md) (HIPAA Security Rule and 42 CFR Part 2 mapping, risk register), [../DEPLOYMENT.md](../DEPLOYMENT.md) (configuration, hardening checklist, hosting options), [../PLATFORM.md](../PLATFORM.md) (the two ways to run SUDS), [../ADOPTION.md](../ADOPTION.md) (governance of adopting it).

## Showing it live

An administrator's **Settings → Security status** page (`server/security-status.js`, `public/views/security.js`) reports, for the running installation: two-step verification coverage and the accounts without it, SSO status and whether password sign-in is disabled, password and session policy, the last scheduled backup and offsite copy, the last recovery drill with its measured RTO/RPO, audit-chain verification and the anchors outside the database, key source and age, retention settings and the last purge, local mode, HTTPS, version and monitoring. It is read-only and reads each value from where it is enforced. The same data is `GET /api/admin/security/status`.

Evidence an auditor can take away:

| Evidence | How to produce it |
| --- | --- |
| Recovery drill report (signed JSON + text) | Settings → System & backups → *Run a recovery drill now*, or `npm run dr-drill`; written to `<data>/backups/dr-drill-<time>.json` |
| Audit log, verifiable offline | Settings → Security status → *Download audit export*, or `GET /api/admin/audit/export`; verify with `npm run verify-audit-export -- <file> [--key …] [--anchors <dir>]` |
| Audit anchors | The files in `AUDIT_ANCHOR_DIR` (write-once storage), and the syslog collector if `AUDIT_SYSLOG` is set |
| Configuration and control status | Settings → Security status (print or save the page), `GET /api/admin/security/status` |
| Accounts without MFA | Settings → Security status, or `GET /api/admin/security/mfa-report` |
| Test results for a release | CI runs of `npm test` and the browser suite (`.github/workflows/ci.yml`) |

## Honest limits, in one place

* Single process, single SQLite database: no active–active high availability. Resilience is backups, a tested restore and a warm standby ([BACKUP-AND-DR.md](BACKUP-AND-DR.md)).
* The index key keys both the blind indexes and the audit chain ([../HIPAA.md](../HIPAA.md), risk register). Anchors on write-once storage are what make a rewrite by a key holder detectable.
* No built-in SIEM connector beyond structured logs, syslog for anchors and Prometheus metrics.
* SSO sign-ins still need SUDS's own TOTP where the role requires it; SUDS does not yet accept the identity provider's MFA claim in its place.
* No third-party penetration test has been commissioned by the project; [PEN-TEST-SCOPE.md](PEN-TEST-SCOPE.md) is written for a county that commissions one.

# Pre-answered security questionnaire

Answers to the questions county IT typically sends (HECVAT-Lite and CSA CAIQ style, and the themes of city/county supplier security assessments such as San Francisco's). Each answer is for **SUDS the software**, run by the county on infrastructure the county controls; where the answer depends on the county's deployment it says so. "Yes" answers cite the implementing file or document so they can be verified.

## Company and product

| # | Question | Answer |
| --- | --- | --- |
| 1 | Describe the product. | Case-management web app for county SUD navigation services: clients, visits, notes, referrals, consents (42 CFR Part 2), disclosures, budgets. Node.js server + SQLite, web client. [ARCHITECTURE.md](ARCHITECTURE.md) |
| 2 | Is it SaaS? | No. The county installs and operates it (county VM, container or the county's own cloud tenant). There is no vendor-hosted service. |
| 3 | Do you hold SOC 2 Type 2 / ISO 27001 / HITRUST / StateRAMP / FedRAMP? | **No.** There is no service organisation to attest; see [SOC2-READINESS.md](SOC2-READINESS.md) for the criteria mapping, and use the county's own audit programme (or the hosting provider's report where hosting is outsourced). |
| 4 | Will you sign a BAA? | The software's authors do not receive, store or process the county's PHI, so a BAA with them is not required for the software itself. A BAA is required with any party that hosts or supports the installation with access to PHI (cloud provider, support contractor). |
| 5 | Subprocessors / third parties with access to data? | None. No telemetry, analytics or vendor service. [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) |
| 6 | Is the source code available for review? | Yes (repository; MIT licence). |

## Data

| # | Question | Answer |
| --- | --- | --- |
| 7 | What data is stored? | PHI including SUD treatment information (42 CFR Part 2), staff accounts, audit log. Classification in `../HIPAA.md`. |
| 8 | Where is data stored (residency)? | Only where the county installs it and points its backups. Nothing leaves the county's infrastructure unless an administrator configures an integration. |
| 9 | Is data encrypted at rest? | Yes — PHI fields AES-256-GCM at the application layer, backups AES-256-GCM; county volume encryption in addition. [ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md) |
| 10 | Encrypted in transit? | Yes — TLS 1.2+ (native or proxy), HSTS, Secure cookies; LAN access cannot be enabled without HTTPS. |
| 11 | Who manages encryption keys? Customer-managed keys? | The county, always. Keys come from the county's secrets manager (or a 0600 key file for small installs). No vendor escrow. |
| 12 | Key rotation? | Yes, per key, scripted, audited (`npm run rotate-key`, `npm run rotate-index-key`). |
| 13 | Data retention and deletion? | Configurable client-record retention (default 7 years after last activity, minimum 6) with daily hard delete across all tables and legal hold; audit log 7 years; logs 30 days. [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) |
| 14 | Can data be exported/returned at contract end? | The county holds the database and keys at all times; exports built in. |
| 15 | Is production data used in test/dev? | No; development uses fictional seed data. |
| 16 | De-identification? | Safe Harbor de-identified exports by default; identified exports require a recipient/purpose and are accounted. |

## Identity and access

| # | Question | Answer |
| --- | --- | --- |
| 17 | SSO (SAML/OIDC)? | OIDC (Authorization Code + PKCE) with the county IdP. SAML: via an IdP that bridges to OIDC (Entra ID, Okta, ADFS, Keycloak all do). |
| 18 | Can password login be disabled? | Yes — *Require single sign-on*, with named break-glass admin accounts; emergency use is audited. |
| 19 | MFA? | TOTP for every role by default, enforced after a grace period; an explicit "every role" switch; a report of accounts without MFA. |
| 20 | Password policy? | 12+ chars, complexity, 90-day expiry (configurable), scrypt hashing, lockout after 5 failures. |
| 21 | Session timeout? | 15 min idle (max 60), 12 h absolute; configurable. |
| 22 | RBAC / least privilege? | Six roles; caseload scoping; de-identified roles; break-glass for clinical notes. [IDENTITY.md](IDENTITY.md) |
| 23 | Privileged access? | Administrators are separated from clinical content (break-glass with supervisor acknowledgement); all admin actions audited. |
| 24 | User provisioning (SCIM/LDAP)? | Yes — SCIM 2.0 `/scim/v2/Users` for Entra ID / Okta (create, update, deactivate; `userName eq` filter; `active=false` ends sessions and wipes devices; groups mapped to roles by a setting; bearer token scoped `scim`). SSO accounts the IdP has not vouched for in N days can be disabled automatically. No LDAP; no SAML (OIDC covers Entra, Okta and ADFS 2016+). [IDENTITY.md](IDENTITY.md) |

## Logging and monitoring

| # | Question | Answer |
| --- | --- | --- |
| 25 | Are access and changes logged? | Yes — every PHI read/write, auth event, denial, configuration change. [LOGGING-AND-AUDIT.md](LOGGING-AND-AUDIT.md) |
| 26 | Are logs tamper-evident / immutable? | Hash-chained (HMAC) audit log with sealed head and scheduled verification; chain head anchored every 6 h and at every backup to write-once storage (WORM) and optionally syslog, so even a rewrite by a DB administrator with the key is detected. Immutability of the anchor store is the county's storage configuration. |
| 27 | Log retention? | Audit 7 years (configurable); operational logs 30 days (ship to SIEM for longer). |
| 28 | SIEM integration? | JSON logs (`LOG_FORMAT=json`), syslog for anchors, Prometheus metrics, `/api/health`. |
| 29 | Can an auditor get the logs? | Yes — NDJSON export whose manifest is signed with Ed25519 (and MACed), verifiable offline with the published public key alone (`npm run verify-audit-export -- --public-key`). [LOGGING-AND-AUDIT.md](LOGGING-AND-AUDIT.md) |

## Resilience

| # | Question | Answer |
| --- | --- | --- |
| 30 | Backups? | Scheduled, encrypted, verified on write, retained N copies, copied offsite. |
| 31 | Tested recovery / RTO / RPO? | Yes — recovery drill (`npm run dr-drill` or Settings) restores the newest backup (the offsite copy when configured) into a throwaway copy, optionally with the escrowed key file rather than the server's keys, verifies it end to end, measures RTO and RPO against configured targets and writes an Ed25519-signed report (`npm run verify-dr-report`); optional monthly schedule. RPO can be minutes with online snapshots. [BACKUP-AND-DR.md](BACKUP-AND-DR.md) |
| 32 | High availability? | Single instance by design; warm-standby (active–passive) procedure with drilled failover. No automatic failover. |
| 33 | Business continuity plan? | County's plan; SUDS supplies drill evidence and the standby procedure. |

## Application security and SDLC

| # | Question | Answer |
| --- | --- | --- |
| 34 | Third-party dependencies? | Zero runtime npm dependencies; build-only dev dependencies watched by Dependabot. [VULNERABILITY-MANAGEMENT.md](VULNERABILITY-MANAGEMENT.md) |
| 35 | OWASP Top 10 controls? | Parameterised SQL, validation, CSP without inline script, CSRF header, secure cookies, rate limits, RBAC on every route, no stack traces to clients. |
| 36 | Automated tests / CI? | Yes — API/unit suite and browser suite on every push; migrations tested against a real old database. [SDLC.md](SDLC.md) |
| 37 | SAST/DAST? | Not in CI today (recommended: CodeQL/Semgrep); county may run DAST in its pen test. |
| 38 | Penetration test? | None commissioned by the project; scope provided for the county's test. [PEN-TEST-SCOPE.md](PEN-TEST-SCOPE.md) |
| 39 | Release integrity? | Releases built from tracked files with `git archive`, SHA-256 checksum published; not cryptographically signed yet. |
| 40 | Patch cadence? | Security fixes released promptly with a CHANGELOG note; county applies via staged rollout. Node runtime patched by the county per its policy. |
| 41 | Container hardening? | Non-root user, read-only root filesystem, all capabilities dropped, no-new-privileges, code not writable (`Dockerfile`, `docker-compose.yml`). |

## Incident response

| # | Question | Answer |
| --- | --- | --- |
| 42 | Incident response process? | County's plan; SUDS provides detection signals, containment actions, evidence export, and an incident register (Settings → Incidents). [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md) |
| 43 | Breach notification? | The county, as covered entity/Part 2 programme, decides and notifies; SUDS identifies affected clients via the audit log and accounting of disclosures. |

## Mobile and offline

| # | Question | Answer |
| --- | --- | --- |
| 44 | Mobile apps? | No native apps (removed in 1.9.3); the web app works on phones. |
| 45 | Offline data on devices? | Local mode is **off by default**; if enabled, caseload-scoped encrypted copies on approved devices, revocable and remotely wipeable. [../PLATFORM.md](../PLATFORM.md) |

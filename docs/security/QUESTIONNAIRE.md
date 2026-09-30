# Pre-answered security questionnaire

These are the questions county IT typically sends, pre-answered. They follow the style of HECVAT-Lite and CSA CAIQ, and the themes of city and county supplier security assessments such as San Francisco's.

**Who the answers cover.** Each answer is for **SUDS the software**, run by the county (or its IT partner) on infrastructure the county controls. Where the answer depends on the county's deployment, it says so.

**How to check them.** Every answer cites the file, test or document that shows it.

**Checked against:** 1.20.0 (30 September 2026: the release commit is the one after "Release 1.20.0" that adds its SBOM; live on GitHub Pages; its tag is pending the owner, [../evidence/RELEASE-HANDOFF.md](../evidence/RELEASE-HANDOFF.md)). The SBOM linked below describes 1.20.0. `test/doc-currency.test.js` fails when this line falls behind the minor line of the version `package.json` stamps.

**Markers used in the answers:**

- **Owner item.** Only the owner of the SUDS project can close it: an organisational fact, a repository setting, a contract. `[owner to complete]` marks a fact the owner must supply.
- **County.** The county's own decision or control.

Evidence that goes with this questionnaire:

- [../evidence/README.md](../evidence/README.md), the evidence index;
- [THREAT-MODEL.md](THREAT-MODEL.md);
- [DATA-INVENTORY.md](DATA-INVENTORY.md);
- the SBOM, [../evidence/sbom-1.20.0.cdx.json](../evidence/sbom-1.20.0.cdx.json).

## Company and product

| # | Question | Answer |
| --- | --- | --- |
| 1 | Describe the product. | A case-management web app for harm-reduction, outreach and SUD programmes. It covers clients, visits, naloxone and supplies, notes, referrals, consents (42 CFR Part 2), disclosures and budgets. It runs as one Node.js server with SQLite and a web client. [ARCHITECTURE.md](ARCHITECTURE.md), [../SCOPE.md](../SCOPE.md) |
| 2 | Is it SaaS? | **No.** The county or its IT partner installs and operates it: on a county VM, in a container, or in the county's own cloud tenant ([../DEPLOYMENT.md](../DEPLOYMENT.md)). A vendor-hosted option is **planned, not offered** ([../market/HOSTING.md](../market/HOSTING.md)). If it is ever offered, the answers below that assume county hosting change, and a BAA and a Part 2 QSOA are required. **Owner item.** |
| 3 | Do you hold SOC 2 Type 2 / ISO 27001 / HITRUST / StateRAMP / FedRAMP? | **No, none.** For a county-hosted installation there is no vendor-operated service to attest. [SOC2-READINESS.md](SOC2-READINESS.md) is a self-assessment that maps the controls to the criteria; it is not an attestation. Use the county's own audit programme, or the hosting provider's report where hosting is outsourced. The vendor's SOC 2 timeline is in [../market/PROCUREMENT.md](../market/PROCUREMENT.md). **Owner item.** |
| 4 | Will you sign a BAA? | It depends on who can reach PHI. **County-hosted, with no vendor access to PHI:** the vendor does not receive, store or process the county's PHI, so the software itself needs no BAA with the vendor. **Vendor-hosted, or vendor support with access to PHI** (support sessions on the server, receiving a database or a backup): a BAA and a 42 CFR Part 2 QSOA are required. Drafts are in [../market/templates/](../market/templates/); **they have not been reviewed by counsel (owner item).** A BAA is also required with any other party that hosts or supports the installation with access to PHI, such as a cloud provider or support contractor. **County.** |
| 5 | Subprocessors / third parties with access to data? | **County-hosted: none.** There is no telemetry, analytics, crash reporting or licence server. The optional outbound connections are all configured by an administrator: the identity provider, OneNote through the county's own Microsoft tenant, the release feed, provider pictures from public websites, and syslog. None receives PHI except OneNote, in the county's own tenant, and, from 1.17.0, the optional AI documentation copilot's provider (Anthropic's API; from 1.17.1 also Amazon Bedrock or Google Cloud Vertex AI): off by default, switched on only after the programme records its own BAA with Part 2 QSOA terms with that provider, which is then the programme's business associate, not SUDS's subprocessor ([../AI-COPILOT.md](../AI-COPILOT.md); [DATA-INVENTORY.md](DATA-INVENTORY.md) section 5). **The county connection (released in 1.18.0; optional, off by default on both sides; office servers only):** *outbound from a CBO's server* to its own county's SUDS server, over HTTPS with a county-issued connection token, carrying only the signed, aggregate county submission file (no client-level data; the file must also verify under the CBO's registered Ed25519 key) and receiving the county's receipt and status; *on a county's server* it adds inbound endpoints: the push endpoint `POST /api/county-connect/v1/submissions` (and `GET …/v1/status`) for the CBOs' connection tokens, and the read API `GET …/v1/combined` and `…/v1/programs` for the county's own BI tools, with expiring read tokens. The county is the CBO's funder, not a subprocessor, and receives no PHI ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *Connecting*). On SUDS Server the weekly compliance check may read the release feed (`UPDATE_FEED_URL`) to see whether the installed version is supported; it sends no data. The vendor has no access unless the county grants it (which then needs a BAA and QSOA, #4). [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md), [DATA-INVENTORY.md](DATA-INVENTORY.md) section 5 |
| 6 | Is the source code available for review? | **Yes.** The repository is public, under the MIT licence ([`LICENSE`](../../LICENSE), "Copyright (c) 2026 The SUDS contributors"; the owner may replace the holder with a legal entity once one exists, #6a). |
| 6a | Company details (legal entity, insurance, staff, references)? | `[owner to complete]`. Today there is no legal entity, no insurance, no staff beyond the one maintainer, and no customer references. See the status table in [../market/README.md](../market/README.md), *Organisational gaps*. **Owner item.** |

## Data

| # | Question | Answer |
| --- | --- | --- |
| 7 | What data is stored? | PHI, including SUD treatment information (42 CFR Part 2); staff accounts, and from 1.19.0 their passkeys' public keys (no biometric data, #19a) and the encrypted evidence of fingerprint-confirmed signatures; the audit log; from 1.18.0, on a server that uses the county view, the county signing keys and, on a county's server, the programmes' imported aggregate submissions and the county connection's tokens (as SHA-256); from 1.20.0, aggregate figures the county itself enters for a grantee not on SUDS (encrypted, with the source document's reference, and marked as county-entered wherever they are shown or exported). Every encrypted column, table by table, with what it holds, whether devices receive it and its retention: [DATA-INVENTORY.md](DATA-INVENTORY.md). `test/data-inventory.test.js` fails if `server/schema.sql` gains an encrypted column the inventory does not list |
| 8 | Where is data stored (residency)? | **Only where the county installs it** (`SUDS_DATA_DIR`) and points its backups, offsite copies and audit anchors. Nothing leaves the county's infrastructure unless an administrator configures an integration ([DATA-INVENTORY.md](DATA-INVENTORY.md) section 5), or, from 1.17.0, a worker sends a secure referral link to an organisation not on SUDS: off unless an administrator turns it on, and each one a disclosure checked against the client's consent and accounted ([REFERRAL-LINKS.md](REFERRAL-LINKS.md)). The county submission file (1.18.0) and the county connection carry aggregate figures only, to the programme's county (#5). If local mode is on, the county's approved devices also hold copies (#45). **County.** |
| 9 | Is data encrypted at rest? | **Yes.** Identifiers and free text are encrypted per field with AES-256-GCM (every `_enc` column; `server/crypto.js`). Backups are encrypted whole with AES-256-GCM (`server/backup.js`). Coded reporting fields are readable columns and rely on the county's volume encryption ([DATA-INVENTORY.md](DATA-INVENTORY.md) section 3); on SUDS Server that volume is LUKS and the weekly compliance report shows it (`host.disk_encryption`). Device copies are sealed whole ([ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md)) |
| 10 | Encrypted in transit? | **Yes.** TLS 1.2+ (native, or at a proxy; on SUDS Server the compliance report's `host.tls` shows the protocol negotiated, TLS 1.0/1.1 refused, the certificate's validity and HSTS), HSTS, and `Secure; HttpOnly; SameSite=Strict` cookies. The server cannot be opened to other devices without HTTPS, native or at a trusted proxy (`server/routes/admin.js`: "HTTPS is required when other devices can connect") |
| 11 | Who manages encryption keys? Customer-managed keys? | **The county, always.** Keys come from the county's secrets manager (any secret can be a file: `*_FILE`, systemd `LoadCredential=`, Docker secrets), or from a 0600 `keys.json` for small installs; on SUDS Server they are root-only credential files the compliance report checks (`host.keys`). The server refuses to start if the key does not match the database's fingerprint (`server/db.js` `checkKeyFingerprint`). There is no vendor escrow for a county-hosted installation. [ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md) |
| 12 | Key rotation? | **Yes**: scripted and audited, per key. `npm run rotate-key` finds every `_enc` column from the schema (`scripts/rotate-key.js`). `npm run rotate-index-key` re-derives the indexes and re-signs the audit chain. Tested in `test/backup.test.js` and `test/rotate-index-key.test.js` |
| 13 | Data retention and deletion? | Client records are kept for a configurable time: by default 7 years after the **last activity**, never less than 6. A daily hard delete runs across every client table in one transaction, and a legal hold exempts a record (`server/retention.js`). The audit log is kept 7 years (configurable, never less than 6). Operational logs 30 days; CalOMS submission files 90 days. An imported page keeps no copy of its text once it is filed as a note, and every import item filed for a client or suggested for them is deleted with that client (1.17.0; `test/import-text-retention.test.js`; [DATA-INVENTORY.md](DATA-INVENTORY.md) section 2). [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) |
| 14 | Can data be exported/returned at contract end? | **Yes.** The county holds the database and the keys at all times. Exports are built in: CSV/Excel of every table, FHIR bulk export. The database is a standard SQLite file |
| 15 | Is production data used in test/dev? | **No.** Development uses fictional seed data (`npm run seed`; "never seed production", CLAUDE.md). The committed recovery-drill evidence is from seeded data (`docs/evidence/`) |
| 16 | De-identification? | See the three points below the table. [../HIPAA.md](../HIPAA.md) |

**#16, de-identification, in detail:**

- **Exports are de-identified to HIPAA Safe Harbor by default** (`server/exports.js`; `test/deid-safe-harbor.test.js`). That means:
  - dates reduced to the year;
  - `90+` for ages over 89;
  - ZIP3, with `000` for sparsely populated areas;
  - an allow-list of columns, with no free text;
  - coded fields held to their lists;
  - a random record id for each export instead of the client code.

  Identified exports require a recipient and a purpose, and are accounted.
- **Some aggregate reports screen small cells.** The funder report, the naloxone log and the settlement report suppress counts of people under 11, with complementary suppression. They are labelled for publication only for the whole programme and one standard period that has ended; other aggregate reports are not.
- **A publication release can be withheld or refused.** A table the automated check cannot show protected is withheld. A **whole publication release is refused**, and nothing is published (always safe), when the check cannot finish within its limit or cannot confirm the release even with tables withheld.
  - In sampled programmes, fiscal years with from under 100 to over 300 overdose events were refused. No size is guaranteed to publish.
  - The exact submission to the funder is unaffected.
  - A year's quarters may be tried, each checked on its own, but they are no sure way round: in a sweep of seeded years, 28 of 72 quarters were refused too ([../PERFORMANCE.md](../PERFORMANCE.md), *Which programmes are refused*).
  - The method has not had an independent statistical review (**owner item**).

## Identity and access

| # | Question | Answer |
| --- | --- | --- |
| 17 | SSO (SAML/OIDC)? | **OIDC** (Authorization Code + PKCE) with the county IdP: `server/oidc.js`; `test/oidc.test.js`. **SAML** only through an IdP that bridges to OIDC (Entra ID, Okta, ADFS and Keycloak all do). [IDENTITY.md](IDENTITY.md) |
| 18 | Can password login be disabled? | **Yes.** *Require single sign-on* keeps passwords only for named break-glass administrator accounts, and every emergency use is audited (`server/auth.js` `ssoPolicy`; `test/security-evidence.test.js`) |
| 19 | MFA? | **TOTP for every role by default** (`MFA_REQUIRED_ROLES`, `server/config.js`). It is enforced after a grace period, 3 days by default (0 means at first sign-in), counted from creation or approval. After that the account can reach only enrolment (`test/mfa-grace.test.js`). There is an explicit "every role" switch and a report of accounts without MFA. The IdP's MFA claim can be trusted instead, but only if the county turns it on (off by default; `test/idp-lifecycle.test.js`) |
| 19a | Passwordless or biometric sign-in? Do you collect biometric data? | **Passkeys (fingerprint sign-in), released in 1.19.0; office server only.** Staff may sign in, finish two-step verification, sign and countersign notes and approve time and spending with a WebAuthn passkey on their device's own authenticator (Touch ID, Windows Hello, an Android fingerprint, or the device's screen lock), verified with `node:crypto` only. User verification is required and checked; HTTPS and the server's host name are required; challenges are single-use, two minutes, bound to purpose, user and session; a counter that goes backwards disables the passkey. A passkey with user verification counts as MFA (NIST SP 800-63B AAL2). **No biometric data is collected, received or stored**: the device matches the finger; SUDS keeps only each passkey's public key, id, counter, transports, AAGUID, a name and dates, so no biometric retention schedule applies (CCPA/CPRA, BIPA-style laws). Programmes can switch sign-in and signing with it off, or require a fingerprint or authenticator code for signing. [FINGERPRINT.md](../FINGERPRINT.md); `test/fingerprint.test.js` |
| 20 | Password policy? | 12 or more characters with complexity, 90-day expiry (configurable), scrypt hashing computed off the event loop. Lockout for 15 minutes after 5 failures, where a wrong authenticator code counts too (`server/config.js` `lockout`; `test/in-session-guessing.test.js`) |
| 21 | Session timeout? | 15 minutes idle (maximum 60), 12 hours absolute; configurable. Tokens are stored hashed. [IDENTITY.md](IDENTITY.md), *Sessions* |
| 22 | RBAC / least privilege? | Six roles. See the six points below the table. [IDENTITY.md](IDENTITY.md) |
| 23 | Privileged access? | Administrators are kept apart from clinical content. They reach it only through break-glass, with a written reason that is encrypted and acknowledged by a supervisor. An administrator cannot change their own role or permissions, and privileged grants go only to administrators (`server/permissions.js`; `test/user-permissions.test.js`). All admin actions are audited |
| 24 | User provisioning (SCIM/LDAP)? | **SCIM 2.0: yes.** `/scim/v2/Users` for Entra ID and Okta (`server/scim.js`; `test/scim.test.js`). `active=false` ends sessions and wipes devices. Groups map to roles through a setting. The bearer token is scoped `scim`. SSO accounts that the IdP has not vouched for in N days can be disabled automatically. **LDAP and SAML: no** (OIDC covers Entra, Okta and ADFS 2016+). [IDENTITY.md](IDENTITY.md) |

**#22, access control, in detail:**

- **The roles.** There are six. The de-identified roles (finance, read-only) cannot open a client record (`test/deidentified-roles.test.js`). Administrators reach clinical notes only through break-glass.
- **Least privilege is the default for new installs, and a setting for upgraded offices (1.17.0).** A new install starts with *New navigators and clinicians start held to their caseload* on: every account that becomes a navigator or clinician (created by an administrator, an approved sign-up, SCIM provisioning, or a role change) is denied *See every client* (`clients:all`) with an audited reason (`server/caseload-default.js`; `test/least-privilege-default.test.js`, `test/least-privilege-sso.test.js`). An office upgraded from 1.16.x starts with it off, so nothing changes silently, and is shown a recommendation to turn it on; existing staff change only through the one-off, confirmed *Apply to existing navigators and clinicians*.
  - The role defaults themselves are unchanged: since 1.16.0 navigators and clinicians hold `clients:all`, so an account the setting did not hold (made before it was on, or with it off) sees every client. Navigators read clinical notes, held or not, unless denied *Read clinical notes* per person.
- **SUD counseling notes are restricted** to their author, the co-signer and staff who write clinical notes (clinicians, supervisors; 1.16.1). Break-glass does not open them.
- **Client records are shared.** Anyone who sees a client may update the record. When someone not on the client's care team does, the primary worker is told which fields changed.
  - The field names are audited, and from 1.17.0 earlier values are kept: every change to the client record is kept as a revision with each changed field's value before and after (encrypted, readable by the client's care team, supervisors and administrators, and purged with the record). The primary worker or a supervisor can put a change back, which is itself a new revision (`server/client-revisions.js`; `test/client-revisions.test.js`; docs/HIPAA.md, *Integrity*).
- **Changing other workers' records** (visits, calls, notes, referrals, to-dos) is for supervisors and administrators only (`records:manage-others`). Both doors enforce it, REST and sync (`server/rules/`).
- **A programme holds a person to their caseload,** or keeps clinical notes from a navigator, with a per-user deny (with a reason, audited). Users & permissions shows who is held to their caseload and whether by the programme default.

## Logging and monitoring

| # | Question | Answer |
| --- | --- | --- |
| 25 | Are access and changes logged? | **Yes.** Every PHI read and write, authentication event, denial and configuration change (`server/audit.js`, called from every route; CLAUDE.md). Details never contain names, note text or typed reasons (`test/reason-privacy.test.js`). [LOGGING-AND-AUDIT.md](LOGGING-AND-AUDIT.md) |
| 26 | Are logs tamper-evident / immutable? | **Tamper-evident, and append-only in the database.** See the points below the table. `test/audit-immutable.test.js`, `test/security-evidence.test.js` |
| 27 | Log retention? | The audit log is kept 7 years, configurable but never below 6 (2,190 days). A lower `AUDIT_RETENTION_DAYS` is raised to that floor, logged and shown as a problem (`test/audit-retention.test.js`). Operational logs are kept 30 days; ship them to a SIEM for longer |
| 28 | SIEM integration? | JSON logs (`LOG_FORMAT=json`), syslog for anchors, Prometheus metrics (token-gated), and the `/api/health`, `/live` and `/ready` endpoints. There is no vendor-specific connector |
| 29 | Can an auditor get the logs? | **Yes.** An NDJSON export whose manifest is signed with Ed25519 (and MACed), verifiable offline with the published public key alone (`npm run verify-audit-export -- --public-key`). From 1.19.0 the evidence of a fingerprint-confirmed signature or approval is exported too (`GET /api/admin/signature-evidence`, `audit:read`) and re-verified offline, against the enrolment recorded in the audit export (`npm run verify-passkey-evidence -- <file> --audit <export>`); on SUDS Server the weekly compliance report is signed and verified the same way (`npm run verify-compliance-report`, #41a). [LOGGING-AND-AUDIT.md](LOGGING-AND-AUDIT.md) |

**#26, tamper evidence, in detail:**

- **A hash-chained audit log.** Each entry is chained by HMAC. The head is sealed, and the chain is verified on a schedule.
- **Append-only in the database.** SQLite triggers refuse `UPDATE` and `DELETE` outside the retention purge and index-key re-signing.
- **Anchors outside the database.** The chain head is anchored every hour, and at every backup, to `AUDIT_ANCHOR_DIR`, and optionally to syslog. In production, anchors kept on the data disk are reported as a failure.
- **The limit.** Only when `AUDIT_ANCHOR_DIR` is on WORM storage is a rewrite by a database administrator who holds the key detected. The immutability of the anchor store is the county's storage configuration. **County.**

## Resilience

| # | Question | Answer |
| --- | --- | --- |
| 30 | Backups? | Encrypted, verified on write, the newest N kept, and copied offsite when an offsite directory is set. Optional frequent snapshots (`backup_schedule_minutes`) bring the RPO down to minutes. The county configures the schedule and the offsite copy: production warns when they are not set, and the setup wizard defaults production to every 4 hours (`server/routes/setup.js`). [BACKUP-AND-DR.md](BACKUP-AND-DR.md). **County.** |
| 31 | Tested recovery / RTO / RPO? | **Yes, in development.** See the points below the table. [BACKUP-AND-DR.md](BACKUP-AND-DR.md) |
| 32 | High availability? | **Single instance by design.** A second process is refused (`server/instance-lock.js`). There is a documented warm-standby (active–passive) procedure, but the drill tests restore, not failover. There is no automatic failover |
| 33 | Business continuity plan? | **The county's plan.** SUDS supplies the drill evidence and the standby procedure. **County.** |

**#31, tested recovery, in detail:**

- **The drill.** The recovery drill (`npm run dr-drill`, or Settings) restores the newest backup into a throwaway copy, optionally with the escrowed key file. It verifies the copy end to end, measures RTO and RPO against targets, and writes an Ed25519-signed report.
- **In CI.** The `dr-drill` CI job runs it on every push.
- **Committed evidence.** Three development drills are in [../evidence/](../evidence/README.md); the latest, on the released 1.19.0 at 20,000 clients (2026-09-30), passed 11 of 11 checks with a drill RTO of 5 s and a host-procedure RTO of 3.7 s. An upgrade drill opened databases written by 1.16.2 and 1.18.0 with 1.19.0, found them structurally identical to a fresh install with nothing lost, and drilled them (11 of 11 each).
- **Installer.** The Linux installer and upgrader have run for real on Ubuntu 24.04 in a systemd container, with a drill on the installed server; not yet on a VM, and not on RHEL 9 (owner-pending: [../evidence/INSTALLER-VM-RUN.md](../evidence/INSTALLER-VM-RUN.md)).
- **Not yet done:** a drill on a real deployment, run by its operator. **County, in a pilot.**

## Application security and SDLC

| # | Question | Answer |
| --- | --- | --- |
| 34 | Third-party dependencies? | **Zero runtime npm dependencies:** the server requires only `node:` built-ins, and `scripts/sbom.js` fails otherwise. Seven small npm packages (sql.js, @noble/ciphers, @noble/hashes, fflate, buffer, base64-js, ieee754) are bundled into the browser kernel for local mode and SUDS on this device. They are built by esbuild, which never ships. All of these, with versions and hashes, are in the SBOM, [../evidence/sbom-1.20.0.cdx.json](../evidence/sbom-1.20.0.cdx.json) (CycloneDX 1.5; `test/sbom.test.js`). Dependabot watches them. [VULNERABILITY-MANAGEMENT.md](VULNERABILITY-MANAGEMENT.md) |
| 35 | OWASP Top 10 controls? | Parameterised SQL; validation per route (`server/validate.js`); CSP without inline script (`server/csp.js`); an HTML-sink lint (`test/html-sinks.test.js`); a CSRF header; secure cookies; rate limits; SSRF checks on outbound fetches (`test/ssrf.test.js`); stored files served sandboxed (`test/security-1161.test.js`); RBAC on every route; no stack traces to clients. [THREAT-MODEL.md](THREAT-MODEL.md) |
| 36 | Automated tests / CI? | **Yes, on every push** (`.github/workflows/ci.yml`): the API and unit suite; the browser suite, including a WCAG 2.1 AA accessibility script; Node 24; the full-size statistical-disclosure sweeps; the performance budgets; and a backup-and-restore drill. Migrations are tested against a real 1.6.1 database. The release gate refuses a commit unless all of these passed on it (`scripts/release-gate.js`). [SDLC.md](SDLC.md) |
| 36a | How is code written and reviewed? | **AI-assisted.** Of the 662 commits in the history of 1.19.0 (`3dc20dc`: 536 commits and 126 merges), **643 (97%) were written with an AI coding assistant**: 630 have the assistant as their author, and 13 more (the squash-merged pull requests #12 to #16 and #22 to #29, authored by the owner) carry it in a `Co-Authored-By:` trailer. The other 19 are the owner's: 13 pull-request merge commits, the initial commit, and the 5 squash-merged pull requests #17 to #21 (1.7.0 to 1.8.0) with no trailer, whose authorship the history does not record. All 149 commits since 1.16.4 are the assistant's. *Method:* every commit reachable from `3dc20dc`, counted by author (`git log 3dc20dc --format=%an`) and by `Co-authored-by` trailer (`--format=%(trailers:key=Co-authored-by,valueonly)`). The figure given until 1.18.0, "480 of 512 up to 1.16.4", counted authors only; that count on `6491308` gives 481 of 513. The work is done under the project rules in `CLAUDE.md`, gated by the tests and CI above, and reviewed and merged by the owner. **There is no second human reviewer and no independent code review (owner item).** Branch protection and independent review of what you deploy are yours to configure ([../ADOPTION.md](../ADOPTION.md) §1). Design decisions: [../architecture/README.md](../architecture/README.md). [SDLC.md](SDLC.md) |
| 37 | SAST/DAST? | **Not in CI today.** CodeQL is an owner setting (GitHub's default setup, which needs no workflow; [../RELEASE.md](../RELEASE.md) *Owner: repository settings*, step 8), and it is **not yet turned on (owner item)**. `npm test` includes narrow static checks: HTML sinks and fixed waits. A county may run DAST in its penetration test |
| 38 | Penetration test? | **None has been commissioned by the project (owner item).** The scope is written for a county's test ([PEN-TEST-SCOPE.md](PEN-TEST-SCOPE.md)), including the attack classes the project's own reviews fixed from 1.15.4 to 1.16.4 ([THREAT-MODEL.md](THREAT-MODEL.md)) |
| 39 | Release integrity? | See the points below the table. [SDLC.md](SDLC.md), [../RELEASE.md](../RELEASE.md) |
| 40 | Patch cadence? | The latest minor line gets every fix; the previous minor line gets security fixes for 30 days ([../RELEASE.md](../RELEASE.md), *Supported versions*). Security fixes are announced as a GitHub Security Advisory. **A security release waits for the owner to tag it, and no backup releaser is named (owner item).** The county applies releases through a staged rollout ([../ADOPTION.md](../ADOPTION.md)) and patches Node itself. **County.** |
| 41 | Container hardening? | Non-root user, read-only root filesystem, all capabilities dropped, no-new-privileges, code not writable by the service user, no `npm install` in the image (`Dockerfile`, `docker-compose.yml`). The base image is pinned to a minor line by tag, not by digest. Keys can be Docker secrets (`*_FILE`; [deploy/docker/README.md](../../deploy/docker/README.md)) |
| 41a | Host hardening? Can you show the host matches your policy? | **On SUDS Server, yes, weekly, signed.** `deploy/linux/install.sh` installs on Ubuntu 24.04 or RHEL 9 with a LUKS data disk (refused otherwise), pinned checksum-verified Node and Caddy, a sandboxed systemd unit on 127.0.0.1, keys as root-only systemd credentials, TLS 1.2+ with HSTS, a deny-by-default firewall, time sync, security-only automatic updates and a persistent journal. `npm run compliance-check` checks each of these (and the app's own controls) and writes a report signed with the compliance check's own key (root-only, never held by the SUDS service; its public half is `/etc/suds/compliance-signing-key.pub.pem`); cite the latest report ([../SELF-HOSTING.md](../SELF-HOSTING.md), *The compliance check*). What it cannot see is listed there, and is the county's |

**#39, release integrity, in detail.** What protects a release today:

- **The zip.** Releases are built from the tag with `git archive`, which is reproducible, and a SHA-256 checksum is published beside the zip.
- **The gate.** It requires green CI on the exact commit (`scripts/release-gate.js`).
- **Forged releases.** A GitHub Release not made by the workflow, or whose files differ from the tag's build, is refused (`scripts/release-existing.js`, 1.16.4).
- **The published web app** is checked byte for byte against the tag (`scripts/release-site-check.js`).
- **The SBOM** lists the hashes of every vendored file.
- **SUDS Server upgrades** (1.18.0) refuse a release zip unless its SHA-256 is given from a channel other than the download (`--release-sha256`: the GitHub release notes and the CHANGELOG on `main`, which must agree), and the compliance report records how the installed release was checked (`host.release_integrity`).

What is still missing:

- **Releases are not signed.** There is no Sigstore signature or provenance attestation.
- **The protections that stop a collaborator replacing a release or pushing a tag are owner settings, not yet in force (owner item):** release immutability, the tag and branch rulesets, and the environment reviewer.

## Incident response

| # | Question | Answer |
| --- | --- | --- |
| 42 | Incident response process? | **The county's plan.** SUDS provides detection signals, containment actions, evidence export and an incident and breach register with the 60-day notification clock (**Privacy & Part 2 → Incidents & breaches**; `server/incidents.js`). [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md). **County.** |
| 43 | Breach notification? | **The county decides and notifies**, as covered entity or Part 2 programme. SUDS identifies affected clients through the audit log and the accounting of disclosures. A large identified export opens a draft incident for review automatically. **County.** |

## Mobile and offline

| # | Question | Answer |
| --- | --- | --- |
| 44 | Mobile apps? | **No native apps** (removed in 1.9.3). The web app works on phones |
| 45 | Offline data on devices? | See the points below the table. [../PLATFORM.md](../PLATFORM.md) |
| 45a | SUDS on this device (the GitHub Pages build): shared origin? | Browser storage (IndexedDB, Cache Storage) and same-origin framing are per origin, and `<owner>.github.io/<repo>/` shares its origin with every other Pages site of that owner. The records are sealed with the device password. The service worker reads and deletes only its own caches within its own path. The pages carry the CSP and a frame guard (`scripts/static-site-security.js`). Even so, a dedicated origin (a custom domain, or a host name of its own) is recommended for real records. [../WEB_APP.md](../WEB_APP.md) |

**#45, offline data on devices, in detail:**

- **Off by default.** Local mode is off unless the setup wizard or IT (`LOCAL_MODE_ENABLED`) turns it on. The wizard recommends it for harm-reduction and outreach programmes.
- **Sealed copies.** If it is on, registered devices hold copies sealed under each person's password. Devices can be revoked and wiped remotely.
- **What a copy holds.** A copy holds what its user may see. **Under the 1.16.0 role defaults, that is the whole programme's records, clinical notes included**, unless the person is held to their caseload before the device first syncs: *See every client* denied to them, or, from 1.17.0, the least-privilege default, on for a new install, which holds every new navigator and clinician to their caseload (#22).
- **Shared devices.** On a device shared by several accounts, every account unlocks the same key. What separates them is the app's rules, not cryptography ([THREAT-MODEL.md](THREAT-MODEL.md), *Residual risks* 4).

## Evidence, vulnerability disclosure and support

| # | Question | Answer |
| --- | --- | --- |
| 46 | Can you provide an SBOM? | **Yes.** CycloneDX 1.5 JSON: [../evidence/sbom-1.20.0.cdx.json](../evidence/sbom-1.20.0.cdx.json). It is generated by `node scripts/sbom.js --ref <tag>`, which needs no npm packages, and `test/sbom.test.js` regenerates it from its recorded commit and requires the same bytes. It lists the runtime, SUDS's own code, the vendored browser files and bundled packages, all with hashes, and separately the build and test tooling that never ships |
| 47 | Threat model? Data-flow diagram? | [THREAT-MODEL.md](THREAT-MODEL.md) (the project's own; not independent); [ARCHITECTURE.md](ARCHITECTURE.md) (data-flow diagram, trust boundaries); [DATA-INVENTORY.md](DATA-INVENTORY.md) (every PHI field and flow) |
| 48 | Vulnerability disclosure policy? | Report privately, never in a public issue, through GitHub's private vulnerability reporting on the repository or the maintainer contact in your agreement ([VULNERABILITY-MANAGEMENT.md](VULNERABILITY-MANAGEMENT.md), [../SUPPORT.md](../SUPPORT.md)). Fixes ship as security releases with an advisory. The policy is [`SECURITY.md`](../../SECURITY.md): how to report, what to include (never real PHI), the scope (office server, SUDS on this device, the SUDS Server installer, the county connection, passkeys) and response targets. **Owner item:** turn on private vulnerability reporting in the repository settings, and confirm the response targets `SECURITY.md` marks `[owner to confirm]`. There is no bug bounty |
| 49 | Support channel and SLA? | See the points below the table. **Owner item.** |
| 50 | Accessibility? | WCAG 2.1 AA self-assessment and an ACR in VPAT 2.5 format ([../accessibility/ACR-WCAG21.md](../accessibility/ACR-WCAG21.md)). The browser suite's accessibility script fails any release with a WCAG 2.1 AA finding (axe-core). Screen-reader testing has not been done yet, and there has been no third-party review (**owner item**). [../accessibility/STATEMENT.md](../accessibility/STATEMENT.md) |

**#49, support, in detail:**

- **What exists today** ([../SUPPORT.md](../SUPPORT.md)):
  - the programme's administrator and its IT partner or county;
  - the public issue tracker, <https://github.com/taugustincst/suds/issues> (no client information);
  - private vulnerability reports;
  - accessibility reports, with their published targets.
- **There is no signed support agreement.** [../market/templates/SUPPORT-SLA.md](../market/templates/SUPPORT-SLA.md) is an owner template for counsel: its hours, contacts and response targets are `[owner to complete]`.
- **Not offered:** 24×7 support, vendor on-call, or an uptime commitment.

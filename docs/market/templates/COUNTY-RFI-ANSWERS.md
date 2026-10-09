# Answers to a county's IT and privacy RFI (template)

> **A template for the vendor to adapt to each RFI.** Every answer points at the file in this repository that
> shows it, so a county reviewer can check it. Organisational answers the software cannot give are marked
> **[owner to complete]** and must be filled in (or left saying so) before the answer is sent. SUDS holds **no**
> certification, attestation or independent audit (SOC 2, ISO 27001, HITRUST, StateRAMP, FedRAMP, a penetration
> test, a third-party accessibility review): never answer as if it did ([../README.md](../README.md), *Rules for
> anyone using this pack*).

It is written for the county pilot ([../COUNTY-KIT.md](../COUNTY-KIT.md)): the county runs one SUDS server for the
county view (no client data on it), and each CBO it funds runs its own office server. Where the answer differs
between the two, both are given. The longer, question-by-question version is
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md); the evidence index is
[../../evidence/README.md](../../evidence/README.md).

## Hosting and deployment

**Q. Is SUDS software-as-a-service? Who hosts it?**
No. The county (for the county view) and each CBO or its IT partner install and operate it: SUDS Server on a
Linux VM with the project's installer, a container, or the county's own cloud tenant. A vendor-hosted option is
planned, not offered. Evidence: [../../SELF-HOSTING.md](../../SELF-HOSTING.md),
[../../../deploy/linux/README.md](../../../deploy/linux/README.md), [../../DEPLOYMENT.md](../../DEPLOYMENT.md),
[../HOSTING.md](../HOSTING.md).

**Q. What does the county's server need?**
2 vCPU, 4 GB RAM and a 20 GB encrypted data disk for a county-only install (the smallest row of
[../../SELF-HOSTING.md](../../SELF-HOSTING.md), *Sizing*); Ubuntu 24.04 LTS or RHEL/Rocky/Alma 9. It holds no client
data: CBOs' public keys, their signed aggregate files, the county code and the audit log
([../../COUNTY-VIEW.md](../../COUNTY-VIEW.md), *A county-only install*).

**Q. Is it single-tenant?** Yes: one server per organisation, one process on one SQLite file, by design
([ADR-0001](../../architecture/ADR-0001-single-process-sqlite.md)).

## Data residency

**Q. Where is data stored and processed?**
Only where the county or CBO installs it and points its backups, offsite copies and audit anchors. Nothing is sent
to the SUDS project; there is no telemetry, analytics, crash reporting or licence server. Evidence:
[../../security/DATA-LIFECYCLE.md](../../security/DATA-LIFECYCLE.md), *Residency and subprocessors*;
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md) #8.

**Q. What crosses between a CBO and the county?**
Only a signed file of aggregate figures for the settlement funds the CBO chose, and, with the optional connection,
the county's receipt and its list of periods it expects. No client-level data, names, codes or dates of birth.
The payload is an allow-list checked when the file is made and when it is imported (`server/county.js` `PAYLOAD`;
`test/county.test.js`). Evidence: [../../COUNTY-VIEW.md](../../COUNTY-VIEW.md), *What the file holds* and
*What crosses the link*.

## Encryption

**Q. Encryption at rest?**
Yes. Identifiers and free text are encrypted per field with AES-256-GCM (every `_enc` column); backups are
encrypted whole; on SUDS Server the data volume is LUKS and the weekly compliance report checks it. On the
county's server the imported files' figures are encrypted at rest too (`county_submissions.payload_enc`).
Evidence: [../../security/ENCRYPTION-AND-KEYS.md](../../security/ENCRYPTION-AND-KEYS.md),
[../../security/DATA-INVENTORY.md](../../security/DATA-INVENTORY.md), `server/crypto.js`.

**Q. Encryption in transit?**
TLS 1.2+ (native or at the proxy), HSTS, `Secure; HttpOnly; SameSite=Strict` cookies; the server refuses to be
opened to other devices without HTTPS. The county connection is https only, never follows a redirect, and
verifies the county's certificate by host name. Evidence:
[../../security/ENCRYPTION-AND-KEYS.md](../../security/ENCRYPTION-AND-KEYS.md), *In transit*;
[../../COUNTY-VIEW.md](../../COUNTY-VIEW.md), *The programme's side* (*Outbound safety*).

## Keys

**Q. Who holds the encryption keys?**
The county or CBO that runs the server, always: from its secrets manager or as root-only systemd credentials on
SUDS Server. There is no vendor escrow. The server refuses to start with a key that does not match the database.
Scripted, audited rotation. Evidence: [../../security/ENCRYPTION-AND-KEYS.md](../../security/ENCRYPTION-AND-KEYS.md);
[../../DEPLOYMENT.md](../../DEPLOYMENT.md), *Key rotation runbook*; `test/backup.test.js`,
`test/rotate-index-key.test.js`.

**Q. How are the CBOs' county files signed, and what if a key is lost?**
Each CBO's server has an Ed25519 key used only for county files; its private half is encrypted with that CBO's
database key and never exported. The county registers the public key after the fingerprint is read out. A lost
or exposed key: the CBO makes a new one, the county replaces it and can mark the old one compromised so its files
stop counting. Evidence: [../../COUNTY-VIEW.md](../../COUNTY-VIEW.md), *The trust model*, *Key history*, *Key
rotation*.

## Identity: MFA, SSO and passkeys

**Q. SSO?** OIDC (Authorization Code with PKCE) with the county's identity provider; SAML through an IdP that
bridges to OIDC; SCIM 2.0 provisioning; password sign-in can be switched off except for named break-glass
administrators. Evidence: [../../security/IDENTITY.md](../../security/IDENTITY.md); `server/oidc.js`,
`server/scim.js`; `test/oidc.test.js`, `test/scim.test.js`.

**Q. Passwords and sign-in limits?** 12 or more characters with complexity; from 1.24.0 a password that contains the
username or the person's name, or is a common password with digits and symbols added, is refused. Lockout after 5
failures; failed sign-ins also count per username from an address under a per-address ceiling
(`LOGIN_RATE_LIMIT`, `LOGIN_IP_RATE_LIMIT`), and the same limits cover signing, approving and fingerprint sign-in.
Evidence: [../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md) #20; `test/security-1236-lows.test.js`.

**Q. MFA?** TOTP for every role by default, enforced after a grace period (3 days by default); the IdP's MFA
claim can be trusted instead if the county turns that on. Evidence:
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md) #19; `test/mfa-grace.test.js`.

**Q. Passwordless or biometric sign-in? Do you collect biometric data?**
Passkeys (WebAuthn, "fingerprint sign-in"), released in 1.19.0, office server only: sign-in, the second step,
and signing notes and approvals with the device's own authenticator. No biometric data reaches the server: the
fingerprint or face stays on the device, which only returns a signed assertion. An authenticator allow-list
(released in 1.21.0, off by default) limits passkeys to the authenticator models an administrator lists, each proven
by attestation. **With it on, synced passkeys (iCloud Keychain, Google Password Manager: attestation `none` or
`apple`) cannot be added.** Turning it on also stops existing unproven passkeys: at once under 1.21.0; with the grace period (released in 1.22.0)
only after a grace period the administrator sets (0 to 90 days, 14 by default), never for a model reported compromised
or revoked. Evidence:
[../../FINGERPRINT.md](../../FINGERPRINT.md); `server/webauthn.js`, `server/passkeys.js`, `server/attestation.js`.

**Q. Least privilege?** Six roles; the county view has two permissions of its own, `county:view` and the
sensitive `county:manage`, neither grantable to a role that does not see exact aggregates. Evidence:
[../../security/IDENTITY.md](../../security/IDENTITY.md); [../../COUNTY-VIEW.md](../../COUNTY-VIEW.md),
*Permissions*; `server/auth.js`, `server/permissions.js`.

## Audit and retention

**Q. Is access logged? Is the log tamper-evident?**
Every read and write of protected data, sign-in, denial and configuration change is audited, with no names or
figures in the details; the log is hash-chained, append-only in the database (triggers), and anchored outside it
every hour (on WORM storage, the county's configuration, a rewrite is detected). On the county's server every
view, export, import, refusal, withdrawal and registration is audited (`county.*`). An auditor gets a signed NDJSON
export verifiable offline. Evidence: [../../security/LOGGING-AND-AUDIT.md](../../security/LOGGING-AND-AUDIT.md);
`server/audit.js`, `server/audit-anchor.js`; `test/audit-immutable.test.js`.

**Q. Retention?** The audit log 7 years (never below 6); client records 7 years after last activity by default
(never below 6) on a CBO's server, with legal holds; operational logs 30 days. Evidence:
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md) #13, #27;
[../../security/DATA-LIFECYCLE.md](../../security/DATA-LIFECYCLE.md). The retention of the county's imported
files is the county's to set in the data contribution agreement
([DATA-CONTRIBUTION-AGREEMENT-DRAFT.md](DATA-CONTRIBUTION-AGREEMENT-DRAFT.md)); **[owner to complete]** whether
SUDS should purge them automatically (it does not today).

## Backups and disaster recovery

**Q. Backups, RTO/RPO, tested recovery?**
Encrypted backups, verified on write, kept locally and copied offsite; optional snapshots every few minutes; a
recovery drill that restores the newest backup into a throwaway copy, verifies it end to end, measures RTO and RPO
and writes an Ed25519-signed report. SUDS Server starts with backups every 4 hours and a monthly drill. Drill
evidence: six development drills in [../../evidence/](../../evidence/README.md) at 20,000 fictional clients; the
latest, on the released 1.23.0, passed 11 of 11 checks with a drill RTO of 4.5 s and a host-procedure RTO of 3 s
(on 1.21.0: 4 s and 3.9 s). An upgrade drill opened 1.21.0 and 1.22.0 databases with 1.23.0 and drilled them (11 of 11
each). **These are development drills, not a drill of the county's own deployment**, which
the pilot does. Evidence: [../../security/BACKUP-AND-DR.md](../../security/BACKUP-AND-DR.md);
[../../evidence/dr-drill-2026-10-01-v1.23.0/](../../evidence/dr-drill-2026-10-01-v1.23.0/README.md);
[../../evidence/upgrade-drill-2026-10-01-v1.23.0/](../../evidence/upgrade-drill-2026-10-01-v1.23.0/README.md).

**Q. High availability?** Single instance by design; a documented warm standby; no automatic failover
([../../security/BACKUP-AND-DR.md](../../security/BACKUP-AND-DR.md), *Single-site risk and standby*).

## Vulnerability management and SBOM

**Q. Dependencies and supply chain?**
Zero runtime dependencies: the server uses only Node.js built-ins; a production install runs no `npm install`.
Build-time tooling is listed separately. A CycloneDX SBOM per release, reproducible from the commit. Dependabot
for build tooling, the container base and CI actions. Evidence:
[../../security/VULNERABILITY-MANAGEMENT.md](../../security/VULNERABILITY-MANAGEMENT.md);
[../../evidence/sbom-1.25.3.cdx.json](../../evidence/sbom-1.25.3.cdx.json) (`node scripts/sbom.js`,
`test/sbom.test.js`).

**Q. Release integrity: how does the county know the build it runs is the released code?** **Releases 1.16.3 to
1.24.0 were published without a tag**, without a GitHub Release and without the release gate's approval. All are
tagged since 2026-10-05, and 1.24.1's tag has been through the gate and its GitHub Release is published; each is
recorded in the exceptions table ([../../RELEASE.md](../../RELEASE.md), *The exceptions in one place*).
`v1.24.2` and `v1.24.3` are tagged but superseded and will never publish. 1.24.4 is tagged, has been through
the gate, and its GitHub Release is published (2026-10-05). 1.25.0 is tagged, has been through the gate, and its
GitHub Release is published (2026-10-06). 1.25.1 is tagged, has been through the gate, and its GitHub Release is
published and marked Latest (2026-10-08) (docs/evidence/RELEASE-HANDOFF.md). 1.25.2 and 1.25.3, stamped 2026-10-08 and
2026-10-09, wait for the owner's tags; until they are pushed they are not published, and there is no tag or published
zip to check them against. Verify against the commit instead. Each
commit is listed in [../../evidence/RELEASE-HANDOFF.md](../../evidence/RELEASE-HANDOFF.md) with the SHA-256 of the
release zip, which anyone can rebuild with `git archive` and compare. `scripts/release-site-check.js` checks a
published web app byte for byte against the commit's build. The steps are in
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md) #39. Releases are not signed. **[owner to
complete]: push the owed tags, then turn on the release protections (RELEASE.md, *Owner: repository settings*).**

**Q. Penetration testing?** **No independent test has been done. [owner to complete]: an independent penetration
test and its remediation.** The owner authorised a white-box penetration test of 1.23.6, made with the source; its
two Medium findings (a consent's purpose not checked at a disclosure; a device's sync push bringing back a row the
office had deleted) and seven Low ones are fixed in 1.24.0 with tests (CHANGELOG 1.24.0). It is not independent. A scope for a county-commissioned test is in
[../../security/PEN-TEST-SCOPE.md](../../security/PEN-TEST-SCOPE.md). It covers the county view's import, read API
and push endpoint, and the areas 1.21.0 added and 1.22.0 changed: county publication (differencing, consent and corrected releases),
field devices and participant codes (the scope bound to the account), the authenticator allow-list and metadata upload
(with its grace period), the version 2 county file (award amounts), the SUDS Server upgrade hand-over and, from
1.24.0, the Windows server. The project's own reviews
and the attack classes fixed are in [../../security/THREAT-MODEL.md](../../security/THREAT-MODEL.md).

**Q. How are vulnerabilities reported and fixed?** Privately through GitHub's private vulnerability reporting on
the repository, as [SECURITY.md](../../../SECURITY.md) says (how to report, what to include, what to expect and
the scope; a programme with a signed support agreement may also use the security contact it names); fixed in a
security release with an advisory; the latest minor line gets every fix
([../../SUPPORT.md](../../SUPPORT.md); [../../RELEASE.md](../../RELEASE.md), *Supported versions*).
**[owner to complete]: turn on private vulnerability reporting (RELEASE.md, *Owner: repository settings*, step 8),
confirm SECURITY.md's response targets, and name a security contact address for the agreement.**

## Incident response

**Q. Incident response and breach notification?**
The county's (or CBO's) plan governs; SUDS supports it with an incident and breach register, detection signals
(audit chain or anchor failure, failed sign-ins, denials, break-glass, backup failures), containment actions and
evidence preservation steps. Evidence: [../../security/INCIDENT-RESPONSE.md](../../security/INCIDENT-RESPONSE.md).
**[owner to complete]: the vendor's own notification commitment to a customer** (the DPA and BAA drafts carry
placeholders: [DPA-DRAFT.md](DPA-DRAFT.md) section 5, [BAA-QSOA-DRAFT.md](BAA-QSOA-DRAFT.md)).

## Accessibility

**Q. Section 508 / WCAG 2.1 AA?**
The browser suite fails on any WCAG 2.1 A/AA finding from axe at desktop and phone widths, dark mode and 200%
text; an Accessibility Conformance Report (VPAT 2.5, WCAG edition) and a statement are published. They are
**self-assessments**, not a third-party review (**[owner to complete]**). Evidence:
[../../accessibility/ACR-WCAG21.md](../../accessibility/ACR-WCAG21.md),
[../../accessibility/STATEMENT.md](../../accessibility/STATEMENT.md),
[../../accessibility/DEVELOPERS.md](../../accessibility/DEVELOPERS.md).

## Part 2, HIPAA and CMIA: who is what

**Q. What are the parties' roles?**
- **Each CBO** is the HIPAA covered entity or Part 2 programme (where it is one) for its own clients' records,
  which stay on its own server. Many harm-reduction CBOs are neither; state law, funding contracts and promises to
  participants still apply ([../DATA-NETWORK.md](../DATA-NETWORK.md), *The legal starting point*).
- **The county**, for the county view, receives aggregate figures under its funding contract. The file carries no
  client-level data and is not treated as a Part 2 disclosure, but it leaves the CBO, so making it is audited.
  Whether a county receiving these exact aggregates needs anything beyond the funding contract is **for counsel**
  ([../../COUNTY-VIEW.md](../../COUNTY-VIEW.md), *Deferred*; [../DATA-NETWORK.md](../DATA-NETWORK.md), *What
  counsel must review*, items 1 and 4).
- **The vendor** receives no PHI from a county- or CBO-hosted server unless given access; if it is (support on
  the server, a database or backup), a BAA with Part 2 QSOA terms is required first. Drafts:
  [BAA-QSOA-DRAFT.md](BAA-QSOA-DRAFT.md), [DPA-DRAFT.md](DPA-DRAFT.md), **not reviewed by counsel
  ([owner to complete])**.
- **CMIA and Health and Safety Code §11845.5**: which applies to each CBO is for counsel
  ([../DATA-NETWORK.md](../DATA-NETWORK.md), item 6).

Evidence: [../../HIPAA.md](../../HIPAA.md), [../../compliance/PART2.md](../../compliance/PART2.md),
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md) #4.

## Subprocessors

**Q. Which subprocessors receive data?**
For a county- or CBO-hosted installation: **none**. The optional outbound connections are each configured by an
administrator and are the organisation's own services (its identity provider, its Microsoft tenant for OneNote
import, a syslog collector) or public websites, plus the optional AI copilot's provider on a CBO's server (off by
default; only after that CBO records its own BAA and Part 2 QSOA with the provider). The county view adds none.
Evidence: [../../security/DATA-LIFECYCLE.md](../../security/DATA-LIFECYCLE.md);
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md) #5. **[owner to complete]: the list, if the
vendor ever hosts.**

## Data ownership, exit and data return

**Q. Who owns the data? What happens at the end of the contract?**
The county owns the county server's data; each CBO owns its own. Both hold their databases and keys throughout.
Exports: CSV and Excel of every table, the county view's Excel, CSV and tidy CSV, FHIR bulk export on a CBO's
server; the database is a standard SQLite file. SUDS is proprietary: what may be kept running after the
contract ends is set by the licence agreement **[owner to decide]**. Any copy the vendor held for support is deleted within 30 days with a certificate. Evidence:
[../PILOT-KIT.md](../PILOT-KIT.md), section 6; [DPA-DRAFT.md](DPA-DRAFT.md), section 7;
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md) #14; the licence text is [../../../LICENSE](../../../LICENSE).

## Support

**Q. What support is offered?**
Today: the public issue tracker (best effort, never with client information) and private vulnerability reports.
Contracted business-hours support exists only under a signed agreement; the SLA is a template with placeholders.
No 24×7 support, no vendor on-call, no vendor-hosted service. Evidence: [../../SUPPORT.md](../../SUPPORT.md);
[SUPPORT-SLA.md](SUPPORT-SLA.md). **[owner to complete]: hours, contacts, response targets, and the price
([../PRICING-OPTIONS.md](../PRICING-OPTIONS.md)).**

## Company

**Q. Legal entity, insurance, references, certifications?**
**[owner to complete]: legal entity, W-9 and county vendor registration; insurance (general liability, tech E&O,
cyber); references.** Today there is no legal entity, no insurance, one maintainer and no customer references; no
certification or attestation of any kind ([../README.md](../README.md), *Organisational gaps*).

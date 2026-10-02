# SUDS buyer guide: for IT partners, county IT and security

For whoever will run and review SUDS for a harm-reduction, outreach or prevention programme: a CBO's managed-IT
partner, a county IT team hosting a CBO's instance, or a county security and privacy reviewer. It answers the gate
questions — deployment, identity, data flows, security controls, recovery, accessibility, integration and
support — and points to the evidence for each. It is honest about what is not yet in place; see the
[readiness scorecard](README.md#readiness-scorecard).

**Start with the evidence index**, [docs/evidence/README.md](../evidence/README.md): each common county IT review
question (encryption, access control, audit, backup and DR, vulnerability management, change control,
accessibility, Part 2) mapped to the document, test or CI job that answers it, and what is still the owner's to do.

**What SUDS is, in one line:** a single-server web application, Node.js built-ins only, that holds 42 CFR
Part 2 and HIPAA-protected programme records for non-billing harm-reduction and prevention programmes. It is
not an EHR, does not bill ([POSITIONING.md](POSITIONING.md)), and is **not a hosted service**: someone — you —
runs the server. Who does what, including at 2am: [HOSTING.md](HOSTING.md).

## Deployment options

| Option | Who runs it | System of record | Good for | Status |
| --- | --- | --- | --- | --- |
| **Self-hosted by the programme's IT partner** | The CBO's managed-IT provider or its own staff, on a VM, office server or container (`Dockerfile`, `docker-compose.yml` with a Caddy TLS proxy), or in the programme's own cloud account | The programme's server | CBOs with an IT partner | Available ([docs/INSTALL.md](../INSTALL.md), [docs/DEPLOYMENT.md](../DEPLOYMENT.md)). **SUDS Server** (released in 1.18.0): `deploy/linux/install.sh` sets up a hardened Ubuntu 24.04 or RHEL 9 VM (LUKS data disk, pinned Node and Caddy, sandboxed service, keys as root-only credentials, firewall) and a weekly signed compliance report ([docs/SELF-HOSTING.md](../SELF-HOSTING.md)). The installer is tested in a fake root with stub system commands; a run on a real VM of each distribution is still owed, so run it on a staging VM first |
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
- **Fingerprint sign-in and signing (released in 1.19.0; office server only):** WebAuthn passkeys on the device's
  own authenticator (Touch ID, Windows Hello, an Android fingerprint, or the screen lock), verified with
  `node:crypto` alone. User verification is required, so a passkey counts as two-step verification (NIST SP 800-63B
  AAL2). **No biometric data reaches SUDS**: the device matches the finger; the server keeps each passkey's public
  key, id, counter and a name. A signature or approval confirmed this way keeps signed evidence of exactly what was
  signed, which an auditor re-verifies offline (`npm run verify-passkey-evidence`). Needs HTTPS and
  `WEBAUTHN_RP_ID` set before anyone enrols; each can be switched off in Settings → Security policy
  ([docs/FINGERPRINT.md](../FINGERPRINT.md)). Not on SUDS on this device.
- **Authenticator allow-list (released in 1.21.0; office server only, off by default):** an administrator lists the
  authenticator models passkeys may use (by AAGUID) and loads the FIDO Metadata Service file (`blob.jwt`, downloaded
  by hand: SUDS makes no outbound call). Each new passkey must then prove its model by attestation (`packed`,
  `fido-u2f`, `tpm` or `android-key`, verified with `node:crypto`) against the roots and statuses in that file;
  synced passkeys (iCloud Keychain, Google Password Manager) give no attestation and are refused. Passkeys added
  before it was on stop at their next use, and the sessions they opened end, after the administrator confirms how
  many accounts that affects (with the grace period, released in 1.22.0: after a grace period of 0 to 90 days, 14 by
  default, during which their owners are told when they stop). Keep the file current: once it is past its `nextUpdate`, no passkey can be added
  ([docs/FINGERPRINT.md](../FINGERPRINT.md), *Authenticator allow-list*).
- **Role-based access** (navigator, clinician, supervisor, finance, readonly, admin). **Role defaults since
  1.16.0:** navigators and clinicians see every client, and navigators read clinical notes without writing
  them. From 1.16.1 SUD counseling notes are readable only by their author, the co-signer and staff who write clinical notes (clinicians, supervisors). Client records are shared: anyone who sees a client may update it, and the client's
  primary worker is told which fields changed when someone not on the care team does (field names are audited; from 1.17.0
  earlier values are kept too: each change is an encrypted revision with every changed field's value before and after,
  readable by the care team, supervisors and administrators, and a change can be put back as a new revision). Only supervisors and administrators change or delete other
  workers' visits, calls, notes, referrals and to-dos. **Least privilege for new staff (1.17.0):** with *New navigators
  and clinicians start held to their caseload* on (Settings → Users & permissions), every account that becomes a
  navigator or clinician — created by an administrator, an approved sign-up, SCIM provisioning (single sign-on links
  that account and creates none), or a role change — is denied *See every client* (`clients:all`), audited with the
  reason "programme default: held to caseload". It is **on for a new install** and **off for an office upgraded from
  1.16.x** (Users & permissions recommends turning it on); existing staff change only through the confirmed, audited
  *Apply to existing navigators and clinicians*. It does not take clinical notes from a navigator: a per-user deny of
  *Read clinical notes* does, as a per-user deny of `clients:all` holds anyone else — set before that person's data is
  imported or their device first syncs. The user list shows who is held to their caseload. Finance and
  read-only see client codes, never client records. Administrator access to clinical notes only via audited
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
                                        ├──> County submission file (signed, aggregate) ──> a person sends it to the county [optional]
                                        ├──> County connection: the same signed file ──HTTPS──> the county's SUDS server [optional, off by default]
                                        └──> Provider websites (resource pictures only, no PHI) [optional]
```

- **No third-party scripts, CDNs, analytics or telemetry.** The only outbound connections are ones an
  administrator configures (listed above). Nothing polls for updates.
- **Optional AI documentation copilot (1.17.0, off by default):** when the programme records its BAA/QSOA with
  the AI provider and switches it on, the office server (never the browser) sends session text a worker gives,
  with that client's known identifiers replaced, to the provider's API over HTTPS (`api.anthropic.com`, or a
  gateway set in `SUDS_AI_BASE_URL`; from 1.17.1 also Amazon Bedrock or Google Cloud Vertex AI, `SUDS_AI_PROVIDER`). The key (`ANTHROPIC_API_KEY`, or the cloud provider's credentials) is in the server environment only; no SDK or
  other package is added; each call is audited without its text and counted against a monthly cap. This is PHI
  to a business associate: see [docs/AI-COPILOT.md](../AI-COPILOT.md) for exactly what is sent and the residual
  risk.
- **Where PHI lives:** only in the SUDS database and its encrypted backups. Logs and audit details never
  contain names or note text.
- **Local mode** (offline copy on a device) is off unless the setup wizard or IT turns it on. The wizard
  **recommends it for a harm-reduction & outreach programme** (field work without signal) and not for a
  treatment-adjacent one; `LOCAL_MODE_ENABLED` overrides the answer ([docs/INSTALL.md](../INSTALL.md), Step 4;
  [docs/PLATFORM.md](../PLATFORM.md)). A device holds every record its user may see: **under the 1.16.0 role
  defaults that is the whole programme, clinical notes included** (about 460 MB of JSON on first sync at
  20,000 clients). Deny *See every client* to anyone whose device should hold only their caseload, before it
  first syncs; turn local mode off where no documented field-work need exists. **From 1.21.0, field devices:** an
  administrator can make a device (or every new device) a field device, which holds only its worker's own caseload
  seen in the last 90 days, with contact, intake, legal and clinical columns blank and no notes, consents or
  assessments. The office enforces it on every pull and push from its own record of the device, and the device's
  sync session is refused by every route but sync and, of `/api/auth/`, sign-in, the second step and sign-out.
  **From 1.22.0 the scope follows the account:** once any device of an account is a field device (or while new
  devices start as field devices), every device of that account is held to it whatever device id it sends, a sync
  sign-in that names no device is refused, and only a device an administrator marks *Keep everything* stays whole.
  On upgrade, a whole device of such an account becomes a field device at its next sync unless an administrator
  marks it first. It limits what the device
  holds, not what the account can reach from a browser ([docs/PLATFORM.md](../PLATFORM.md), *Field devices*).
- **1.23.0: the office app keeps something in the browser.** On a phone using the office SUDS (no offline copy), a
  street-outreach contact saved with no signal now waits in the browser's IndexedDB until it is sent, held to a
  contact that names nobody: never a client, participant code or notes (the screen will not keep one, and the office
  refuses them from the waiting list, `X-Suds-Queued`). It is not encrypted (it is about no one), it is kept per
  account and through sign-out for that worker's next sign-in, and another account on the phone neither sees nor sends
  it. Each contact's id is derived from the account and its Idempotency-Key, so it is counted once however late it is
  sent. Workers can also ask for a field device from the app (*Set up this phone for the field*): every
  administrator gets a to-do, and **Approve** under Settings › Synced devices holds the account to the field scope,
  which only narrows. A follow-up date added or changed by editing a call, visit or referral now makes, moves or
  cancels its to-do at both doors, the REST routes and sync push (migration 67). The new routes (the supervisor's
  reminder, the field-device request and its answer) use existing permissions; no port, connection or permission is
  added ([docs/security/DATA-INVENTORY.md](../security/DATA-INVENTORY.md); [docs/PLATFORM.md](../PLATFORM.md),
  *Field devices*).
- **Every PHI field and every flow**: [docs/security/DATA-INVENTORY.md](../security/DATA-INVENTORY.md) lists each
  encrypted column by table, whether devices receive it, every way data can leave the server (referrals,
  identified exports, EHR hand-off, CalOMS, SPARS, FHIR, publication, sync, backups) with its gate and record, and
  retention; a test fails if the schema gains an encrypted column it does not list. A shorter summary is in
  [docs/HIPAA.md](../HIPAA.md), *Data classification inside the database*.
- **Anonymous SSP participant codes (1.17.0)** are PHI-class: encrypted like names, counted by an HMAC blind index,
  never printed in a report or exported (a per-file random reference stands in), and not in publication releases
  ([docs/SUPPLIES.md](../SUPPLIES.md), *Participant codes*). **Prevention events** (1.17.0) hold no person-level data:
  a headcount per event and free-text notes, which are encrypted.
- **The AI copilot's outbound flow (released in 1.17.0)**, described above: it cannot be
  enabled until the programme records a BAA and a Part 2 QSOA with the provider; the remaining free text may still
  identify someone, so treat the provider as receiving PHI; the result is a draft a person edits and signs. Review
  it in your risk register before enabling it ([STRATEGY.md](STRATEGY.md), *Create 1*).
- **The county view (released in 1.18.0) adds one aggregate file; the county connection (released in 1.18.0,
  optional, off by default) can carry it.** A CBO's finance lead makes a **county submission file** for a quarter:
  aggregate counts and money for the settlement funds they tick, addressed to one county by its county code and
  signed with the CBO server's own Ed25519 key; no client, code, name, date of birth or single event (an allow-list,
  checked when made and on import). By default SUDS sends it nowhere: the CBO emails or uploads it as the county
  asks. The county's own SUDS server (which can be a county-only install with no client data) imports it after
  checking the county code, the signature under the key the CBO read out, and the file's shape. Keys are exchanged
  once, out of band, and can be replaced. Both ends audit every step without the figures
  ([docs/COUNTY-VIEW.md](../COUNTY-VIEW.md)).
  - **The county connection** replaces the email when both sides switch it on. The county issues each CBO a
    **connection token** (`sudscc_…`, shown once, stored only as its SHA-256, optionally expiring, revocable); the
    CBO's server posts **the same signed file** to `POST /api/county-connect/v1/submissions` over HTTPS. The token
    only says which programme is calling: the file must still pass the county's import checks **and** be signed by a
    key registered for that programme, so a token cannot make another programme's file count. Back come only the
    county's receipt and its **status** for that programme (`GET /api/county-connect/v1/status`: the periods it
    expects and which are outstanding), never figures or anything about other programmes. Optional automatic sending
    (off by default) sends outstanding periods once a day, only for funds a person already chose. Outbound from the
    CBO: https only, no redirects, a 15-second deadline, no private or metadata addresses unless
    `SUDS_COUNTY_ALLOW_PRIVATE=1` (a county over a VPN).
  - **The county's read API**, for its own BI tools: **read tokens** (`sudscr_…`) that always expire (90 days unless
    chosen, at most a year) and are revocable, for `GET /api/county-connect/v1/combined` (the combined view, JSON or
    tidy CSV, labelled summed not unduplicated, exact, internal, not for publication) and `/v1/programs` (names,
    key fingerprints, periods received; no keys). Every call is audited without figures and rate-limited per token
    and per address.
  - **What leaves a CBO** is only that aggregate file, as with email. **What the county exposes** is
    `/api/county-connect/v1/` on its server, reachable from the CBOs (its TLS proxy or a VPN); behind a proxy
    `TRUST_PROXY=1` is **required**, or every CBO counts as the proxy's one address for the rate limits and the audit
    log's addresses. The switch is off by default on both sides; while it is off, the county's machine routes answer
    404 ([docs/COUNTY-VIEW.md](../COUNTY-VIEW.md), *Connecting*).
  - **County-entered figures (released in 1.20.0)**, for a grantee that does not run SUDS: on the county's server,
    staff with `county:manage` register it with no key and enter its aggregate figures for a period, or import them
    from a CSV in the combined view's own layout, naming the source document (a grantee's emailed report, say). No
    new connection, port or permission: nothing is sent to or from the grantee. The figures pass the signed files'
    allow-list and strict number checks, are stored unsigned and marked `county_entered` (the source document
    encrypted, shown to `county:manage` only and never in the read API), and appear everywhere as *entered by the
    county — not signed by the program*; a signed file for the same period always outranks them, the county
    connection never counts them as received, and the view, its files and the read API can leave them out
    (`entered=exclude`). Audited as `county.entry.*` without figures or typed text
    ([docs/COUNTY-VIEW.md](../COUNTY-VIEW.md), *County-entered figures*).
  - **1.21.0 on the county side:** the county file's schema version 2 carries each fund's award amount (still
    aggregates; **upgrade the county's server first**: a county on 1.20 reads version 1 only, and a CBO sends it
    version 1 until it says otherwise), reminders on each CBO's Home when its county file is due, and **publication
    releases**: County view › Publish screens the combined figures for a period for small cells against every CBO's
    own publication release, records what was published (append-only, with its SHA-256) and offers it as CSV,
    Excel, JSON and read-API `GET /api/county-connect/v1/publications`. No new permission, port or connection
    ([docs/COUNTY-VIEW.md](../COUNTY-VIEW.md), *Publication*).
  - **1.22.0 on the county side:** a publication release names only CBOs whose written consent to publication the
    county has recorded (County view › Programs; the agreement's reference encrypted, `county:manage` only), checked
    again where the release is written; a withdrawn release's exact period can be published again as a correction
    audited against every total already printed; the award is also shown pro-rated to the period. A CBO's county
    file is **version 1 unless the county is known to read version 2** (its connection's `/status`, or the CBO's
    answer, once per county code, that the county runs SUDS 1.21 or later). Three new routes
    (`/api/county/programmes/:id/publication-consent`), no new permission, port or connection (migration 65;
    [docs/COUNTY-VIEW.md](../COUNTY-VIEW.md), *Publication* and *Which version a file is made in*).
- **Settlement outcomes and street outreach (1.17.0) add no data flow.** The settlement outcomes page and its
  Excel/CSV file are aggregate figures made in the browser session of the person who asks for them (audited);
  nothing is sent to the state or anyone else. A street outreach contact is an ordinary anonymous visit, saved on
  the server or, offline, on the device and pushed by the existing sync.

## Security controls and evidence

| Control | What SUDS does | Evidence |
| --- | --- | --- |
| Architecture | Single Node.js process, built-ins only, zero third-party runtime packages; CSP self-only, no inline scripts | [docs/security/ARCHITECTURE.md](../security/ARCHITECTURE.md), [docs/DEPLOYMENT.md](../DEPLOYMENT.md) |
| Encryption at rest | AES-256-GCM on identifying and free-text fields (names, contact details, dates of birth, notes, consents…), keys outside the database; blind-index (HMAC) search; coded reporting fields (status, substance, risk…) are not field-encrypted and rely on the required disk encryption — table-by-table in HIPAA.md, *Data classification* | [docs/HIPAA.md](../HIPAA.md), [docs/security/ENCRYPTION-AND-KEYS.md](../security/ENCRYPTION-AND-KEYS.md) |
| Encryption in transit | TLS 1.2+, HSTS, secure/HttpOnly/SameSite=Strict cookies | [docs/HIPAA.md](../HIPAA.md) |
| Key management | Three independently rotatable keys; rotation runbook; retired-key handling | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Key rotation runbook* |
| Audit | PHI reads and writes through the API (every route that touches PHI is required to log — `CLAUDE.md`, [ADR-0006](../architecture/ADR-0006-append-only-audit.md)), sign-ins, denials, exports, disclosures and configuration changes; tamper-evident hash chain, append-only in the database, anchored every hour (write-once when the operator points `AUDIT_ANCHOR_DIR` at WORM storage), verified incrementally and weekly in full; 7-year retention | [docs/HIPAA.md](../HIPAA.md), [docs/security/LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md) |
| 42 CFR Part 2 | Consent elements enforced, referral gating, disclosure accounting, final-rule controls | [docs/HIPAA.md](../HIPAA.md), [docs/compliance/PART2.md](../compliance/PART2.md) |
| De-identification | Safe Harbor exports by default (year-only dates, 90+, ZIP3 with restricted areas as 000, no free text, random per-export record ids); small-cell suppression in the funder report, naloxone log and settlement report, labelled *Publication release — small cells screened; review before sharing* only for whole-programme, standard-period runs, whose export needs a recorded review confirmation (a conservative screen, not an expert determination). A release the check cannot finish or confirm is refused whole (nothing published, always safe), and no size is guaranteed to publish. Since 1.17.0 a release gives overdose events as period totals and reversals by month, not the events by month, and in the project's sweeps 4 of 114 scaled fiscal years and 11 of 72 seeded quarters were refused (1.16.4: 34 and 28); the funder submission is unaffected. The audit log records each release's withheld tables and a refused release's reason; on a device the check runs in a Web Worker, off the page ([PERFORMANCE.md](../PERFORMANCE.md), *Which programmes are refused*) | [docs/HIPAA.md](../HIPAA.md) |
| Backup and recovery | Scheduled encrypted backups, off-host copy, restore from the UI, pre-migration snapshots; DR drill with measured RTO/RPO | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Backups*; [docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md) |
| Monitoring | `/api/health/live` and `/api/health/ready` probes, `/api/health` for alerting; Prometheus metrics; JSON logs; no PHI in logs | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Monitoring and logs* |
| Hardening | Checklist for host, TLS, proxy, permissions, firewall, MFA, keys. On **SUDS Server** (released in 1.18.0) the installer applies the host hardening and `npm run compliance-check` reports on it weekly: each host and app check against the HIPAA Security Rule, 42 CFR §2.16 or CMIA rule it evidences, signed with the check's own Ed25519 key (which the SUDS service never holds) and verifiable anywhere with `npm run verify-compliance-report`. It records what it observed, not compliance: what it cannot see (encryption beneath the VM, perimeter firewalls, key escrow, people and premises) is listed in the report's scope. The installer has been run for real on Ubuntu 24.04 in a systemd container, most recently on 1.23.0; 1.20.0 fixed what the first run found (both shares checked at once, the first backup and recovery drill run by the installer so day one is not red, `WEBAUTHN_RP_ID` set from `--domain`) and 1.22.0 what the 1.21.0 run found (the listener now starts cleanly under the service sandbox; the upgrade dry run says the release's own upgrader may take over); a run on a real VM, and any run on RHEL 9, is still owed ([docs/evidence/INSTALLER-VM-RUN.md](../evidence/INSTALLER-VM-RUN.md)) | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), *Hardening checklist*; [docs/SELF-HOSTING.md](../SELF-HOSTING.md), *The compliance check* |
| Supply chain and change control | Zero runtime packages on the server; seven small npm packages bundled into the browser kernel, and sql.js's WebAssembly, all listed with versions and hashes in a **CycloneDX SBOM** ([docs/evidence/sbom-1.23.0.cdx.json](../evidence/sbom-1.23.0.cdx.json), generated by `scripts/sbom.js` and checked by `test/sbom.test.js`), with the build and test tooling marked separately; release zips built reproducibly with `git archive`, with SHA-256 checksums (not yet signed; 1.16.3 to 1.23.5 have no tag or published zip yet and did not go through the release gate, and [QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) #39 says how to verify them against their commits); Dependabot for the browser-kernel build tools. The release gate, owner approval and tag rules are designed, but the repository settings that enforce them are **not yet turned on by the owner** ([docs/RELEASE.md](../RELEASE.md), *Owner: repository settings*). **Development is AI-assisted**: of the 808 commits up to 1.23.0's documentation pass, 789 were written with an AI coding assistant (776 authored by it, 13 more carrying it as co-author; method in [QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) #36a) under the rules in `CLAUDE.md`, gated by automated tests and CI (API suite, browser suite with accessibility checks, drift checks) and reviewed and merged by the owner. There is no second human reviewer today. Branch protection and independent review of what you deploy are yours to configure ([ADOPTION.md](../ADOPTION.md) §1) | [docs/security/SDLC.md](../security/SDLC.md), [docs/security/VULNERABILITY-MANAGEMENT.md](../security/VULNERABILITY-MANAGEMENT.md), [docs/RELEASE.md](../RELEASE.md), [docs/architecture/](../architecture/README.md) |
| Threat model and residual risks | Attackers, threats and mitigations by area; the attack classes fixed from 1.15.4 to 1.16.4 with their tests; residual risks, including repository settings not yet on, one maintainer, no pen test, shared devices separating accounts by rule rather than by key, blind-index leakage, the shared index/audit key, single instance, experimental `node:sqlite` | [docs/security/THREAT-MODEL.md](../security/THREAT-MODEL.md), [docs/HIPAA.md](../HIPAA.md), *Risk register notes* |
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
| County EHR (SmartCare, Netsmart…) | SUDS sits beside the EHR as the Part 2-controlled record of outreach, navigation and referral work, not in place of it. Encounter hand-off export of services the EHR needs to record or bill ([docs/SCOPE.md](../SCOPE.md)); FHIR R4 read API and bulk export with Part 2 consent enforcement ([docs/integration/FHIR.md](../integration/FHIR.md)) |
| State reporting | CalOMS Tx extract for the county's submission ([docs/compliance/CALOMS.md](../compliance/CALOMS.md)); built, but the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until verified with DHCS/county |
| Identity | OIDC single sign-on |
| Existing spreadsheets | Excel/CSV import with templates and validation ([docs/USER_GUIDE.md](../USER_GUIDE.md), *Importing spreadsheets*) |
| Field notes | Pocket AI and OneNote import through a review queue; write-only intake API keys ([docs/IMPORTS.md](../IMPORTS.md)) |
| BI / data warehouse | Excel/CSV of every table, de-identified by default; FHIR bulk export |
| Full API | [docs/API.md](../API.md) |

## Support model

- **What exists today** ([docs/SUPPORT.md](../SUPPORT.md)): the programme's own administrator, then whoever runs
  the server (IT partner or county), then the SUDS project's public issue tracker,
  <https://github.com/taugustincst/suds/issues> (defects, questions, accessibility barriers; never client
  information), and private vulnerability reports for security issues ([SECURITY.md](../../SECURITY.md)). Accessibility reports have published
  targets ([docs/accessibility/STATEMENT.md](../accessibility/STATEMENT.md)); everything else is best effort.
- **Contracted vendor support** exists only under a signed agreement; [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md)
  is an **owner template** whose hours, contacts and response targets are `[owner to complete]`, for counsel review.
  The vendor is one person today; there is no 24×7 support and no vendor on-call.
- **Releases**: tagged, checksummed, with release notes. The exception: **releases 1.16.3 to 1.23.4 were published without a tag**, a GitHub Release or the release gate's approval. They were pushed directly to `gh-pages` and recorded as policy exceptions. Until the owner pushes their tags, verify one of those builds against its commit. Rebuild the zip and compare its SHA-256 with [docs/evidence/RELEASE-HANDOFF.md](../evidence/RELEASE-HANDOFF.md), and check the web app with `scripts/release-site-check.js` ([QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) #39). A pilot-group-first rollout is recommended
  ([docs/ADOPTION.md](../ADOPTION.md), section 3). Security fixes expedited.
- **Freeze and support commitment (from 1.23.1, stabilisation):** no feature release before 2026-10-29 (1.24.0 at the earliest, and only through the release gate with a tag the owner pushes); no further release-policy exception except to ship a security fix; **1.23.x is the supported line**, with every defect and security fix until 1.24.0 and security fixes only for 30 days after 1.24.0's release date; every release tagged by the owner and published by the release workflow, with no direct publishing once the owed tags exist. CI checks the cadence and patch rules on every push (the `release-policy` job). These are a one-maintainer project's commitments, not a contractual SLA ([docs/RELEASE.md](../RELEASE.md), *Stabilisation (from 1.23.1)*)
- **Open source (MIT, [LICENSE](../../LICENSE))**: the county can inspect, build and maintain the code without the vendor; there is no
  licence lock-in. The adoption plan asks the county to name a code owner whether or not it buys support.
- **Operator staffing** for a self-hosted or county-hosted install: 0.25–0.5 FTE system administrator, a key custodian, a
  monthly audit reviewer ([docs/ADOPTION.md](../ADOPTION.md), section 7).

## Before real client data

The go-live checklist in [docs/ADOPTION.md](../ADOPTION.md), section 8, plus: signed BAA / Part 2 QSOA
([templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md)) and DPA ([templates/DPA-DRAFT.md](templates/DPA-DRAFT.md))
where the vendor hosts or can access PHI; hardening checklist complete; restore drill done; HIPAA.md risk
register notes copied into the county register with owners.

# Threat model

This document covers who might attack SUDS, how, what stops them, and what is left. It is for a county security reviewer, a penetration tester, and the next maintainer.

**Version.** It describes 1.17.0; what changed in 1.17.0 is marked "(1.17.0)".

**Who wrote it.** The SUDS project wrote it, from the code and from its own review rounds. **It is not an independent assessment.** No third-party penetration test or audit has been done (see [Residual risks](#residual-risks)).

**Where to check the details.** Every mitigation names the file that implements it and, where there is one, the test that pins it.

Related documents:

- [ARCHITECTURE.md](ARCHITECTURE.md): components and trust boundaries;
- [DATA-INVENTORY.md](DATA-INVENTORY.md): the data and where it can flow;
- [PEN-TEST-SCOPE.md](PEN-TEST-SCOPE.md): how to test this;
- [../HIPAA.md](../HIPAA.md), *Risk register notes*: the risks a county carries in its own register.

## What is being protected

| Asset | Why it matters |
| --- | --- |
| Client records: identity, SUD treatment, SUD counseling notes, consents, disclosures | HIPAA and 42 CFR Part 2 information. Disclosure harms the person, legally and socially |
| Integrity of the legal record: signatures, consents, the accounting of disclosures, the audit log, approvals of time and spending | Evidence in a complaint, an audit or a proceeding. Separation of duties protects grant money |
| Availability of the programme's records | Outreach and follow-up depend on them. A lost device must not lose the programme's data |
| Keys: `SUDS_ENCRYPTION_KEY`, `SUDS_INDEX_KEY`, `SUDS_BACKUP_KEY`, `SUDS_SIGNING_KEY`, device wraps and recovery codes | Whoever holds them can read or forge what the controls protect |
| The county signing key (built for 1.18.0, not yet released; `county_signing_keys.private_key_enc`), and on a county's server the registered programme keys | Whoever holds a programme's key can send the county figures in its name; whoever can register a key decides whose figures the county accepts |
| The code a county runs: release zips, the published web app | A tampered release or site reaches every installation |

## Ways SUDS runs, and where the boundaries are

1. **Office server** (the system of record). One Node.js process with no npm runtime packages and one SQLite file, run by the county or its IT partner behind TLS. The trust boundaries are listed in [ARCHITECTURE.md](ARCHITECTURE.md):
   - network to app;
   - session to data;
   - app to database file;
   - database administrator to audit evidence;
   - office to device;
   - the recovery drill.
2. **Local mode**, a device that syncs. It is off by default. The same server logic runs in the browser (the kernel) on a sealed copy of what the person may see, and pushes changes back. **Sync push is a second door into the database.** Every write rule lives once in `server/rules/` and is enforced at both doors (`server/rules/push.js`).
3. **SUDS on this device**, the GitHub Pages build. The kernel runs as a static site. Records stay in one browser and nothing syncs. Several people may have accounts on one device.
4. **Publication releases.** Aggregate reports meant for the public, screened for small cells by `server/sdc.js`, `server/publication-release.js` and `server/release-audit.js`. The attacker is anyone who reads the published numbers and knows the method.
5. **The release pipeline.** GitHub holds the repository, CI (`ci.yml`), the release workflow (`release.yml`) and the web-app publish (`web-app.yml`). The county installs a tagged release zip, and the public web app is published from a tag.
6. **Unauthenticated public pages (1.17.0).** `referral-link.html` and `POST /api/referral-links/open|ack` answer a recipient who has no account; they are rate limited per address, reveal nothing without a valid token (and, for a referral, its code), and are the only routes a person outside the programme reaches ([REFERRAL-LINKS.md](REFERRAL-LINKS.md)).

## Who might attack

| Actor | Starting point | Examples |
| --- | --- | --- |
| Outsider on the network | No account | Credential stuffing, exploiting input handling, cross-site attacks on a signed-in user |
| Staff member, any role | A valid account | Reading clients or notes beyond their role; changing another worker's records; approving their own time; signing as someone else |
| Removed or restricted staff member | An account with narrowed rights, or a device that synced before | Getting back onto a case; keeping data on a device |
| Another account on a shared device | The same browser | Reading what the device keeps for someone else |
| Device thief | A copied browser profile or a lost phone | Offline guessing of the device password |
| Host or database administrator | The database file, possibly the keys | Reading PHI; rewriting the audit log |
| Reader of published statistics | The published numbers and the method | Re-identifying a small group |
| Repository collaborator, compromised dependency or CI runner | Write access, or code running in CI | Shipping altered code; stealing the publish key; forging a release |
| GitHub or the Pages origin | Serves the on-device app's code | Serving altered code to SUDS on this device |

## Threats and mitigations

### Office server: the web and API edge

| Threat | Mitigation | Code / test |
| --- | --- | --- |
| Password guessing, stuffing | Account lockout after 5 failures, where a wrong authenticator code counts too. Limits of 20 failures per address per 15 minutes and 10 MFA attempts per user per 10 minutes. scrypt hashing. TOTP for every role by default, with SSO optional. Unknown usernames cost the same | `server/auth.js`; `test/in-session-guessing.test.js`, `test/mfa-enrol-hardening.test.js`, `test/signer-hardening.test.js` |
| Session theft, fixation, CSRF | 256-bit tokens stored hashed. Cookies are `HttpOnly; Secure; SameSite=Strict`. The `X-Requested-With` header is required on state changes. Idle timeout 15 minutes, absolute limit 12 hours | `server/auth.js`, `server/http.js` |
| XSS | Strict CSP with no inline script. The DOM is built with text nodes, and a lint fails on HTML sinks. Stored files are served sandboxed with `nosniff`, a disposition, and types read from their bytes (1.16.1) | `server/csp.js`, `scripts/check-html-sinks.js`; `test/html-sinks.test.js`, `test/output-escaping.test.js`, `test/security-1161.test.js` |
| Injection | Parameterised SQL. Table and column names come from code. Validation per route. Exported cells that look like formulas are neutralised | `server/validate.js`, `server/spreadsheet.js`; `test/spreadsheet.test.js` |
| SSRF through admin-configured outbound fetches | HTTPS only. The name is resolved and never allowed to be this machine or a private network, and the connection is pinned to the checked address, except through a configured proxy, which does its own resolving. The AI copilot's provider endpoint (1.17.0) is the one other direct fetch: its address comes from the server environment only, never from a user, and must be HTTPS unless it is this machine | `server/outbound.js`, `server/ai-copilot.js`; `test/ssrf.test.js`, `test/ssrf-pinning.test.js` |
| OIDC token forgery | RS256 only, with issuer, audience, expiry, nonce and PKCE checked. Accounts are never created by a sign-in. IdP MFA is trusted only when switched on | `server/oidc.js`; `test/oidc.test.js`, `test/idp-lifecycle.test.js` |
| Resource exhaustion | Body caps decided before reading. Rate limits. One instance by design | `server/app.js`, `server/http.js` |

### Authorisation and insiders (both doors)

| Threat | Mitigation | Code / test |
| --- | --- | --- |
| A role reads beyond itself | Permissions are checked on every route, with per-user denies (a deny always wins). Caseload scoping applies to anyone denied `clients:all`. De-identified roles cannot open a record, and cannot use search to ask whether a named person is a client (1.15.4 H2) | `server/auth.js`, `server/permissions.js`; `test/deidentified-roles.test.js`, `test/role-expansion.test.js`, `test/security-1154.test.js` |
| Escalating one's own rights | An administrator cannot change their own role or permissions. Privileged grants go only to administrators, and are dropped when the role changes (1.15.4 M2) | `server/permissions.js` `grantProblem`; `test/user-permissions.test.js` |
| Changing another worker's work, or recording work in their name | `records:manage-others` is required, for prevention events too (1.17.0). The creator columns are the office's: a device cannot name someone else (1.16.1 H2) | `server/rules/*`, `server/rules/push.js`, `server/rules/prevention_events.js`; `test/sync-attribution.test.js`, `test/security-1161.test.js`, `test/prevention.test.js` |
| New staff seeing every client by default (1.17.0) | *New navigators and clinicians start held to their caseload* denies `clients:all` to every account that becomes a navigator or clinician, by every path that makes one (administrator, approved sign-up, SCIM, role change, the device administrator), each audited with its cause. On for a new install; an upgraded office turns it on and applies it to existing staff (residual risk 5) | `server/caseload-default.js`; `test/least-privilege-default.test.js`, `test/least-privilege-sso.test.js`, `test/least-privilege-device.test.js` |
| Reading a client's earlier values, or erasing a change (1.17.0) | Every change to a client's own details is an encrypted revision, never updated or deleted (except with the record at retention). Only the care team and `records:manage-others` read the history, and a refusal is audited. It never synchronises. A revert is a new revision, passes the same rules as an edit and is refused once the fields hold something else | `server/client-revisions.js`, `server/rules/clients.js`; `test/client-revisions.test.js` |
| Approving one's own time or spending, directly or through a visit or a device | Approvals are the office's alone. Approval is refused to anyone who recorded, changed, resized or submitted the entry, read from the audit trail (1.15.4 H1; 1.16.1 M7; 1.16.2 M1) | `server/rules/shared.js` `officeRuling`, `server/routes/budget.js`, `server/routes/time.js`; `test/security-1154.test.js`, `test/security-1162.test.js` |
| Signing a note as someone else | A note's author is the account that syncs it. A signature must be the author's own and is bounded in time. A draft carries no signature (1.16.2 H1; 1.16.3 L1, L2) | `server/rules/notes.js`; `test/security-1162.test.js`, `test/security-1163.test.js` |
| Reading SUD counseling notes | Only the author, the co-signer and `notes:clinical:write` may read them, and break-glass does not open one (1.16.1). They are removed from devices that may no longer read them, including shared devices and paged pulls (1.16.2 M3; 1.16.3 M2; 1.16.4 N1, N6) | `server/rules/notes.js`, `server/routes/sync.js`, `local/sync.js`; `test/counseling-notes.test.js`, `test/counseling-drop-device.test.js`, `test/shared-device-drop.test.js`, `test/shared-device-navigators.test.js` |
| Taking a client off the care team, or getting back onto one | Discharge and re-admission belong to the care team or a manager. Someone off the team who opened an episode ends only their own part (1.16.3 M1). Standing on a case cannot be regained by sync: self-assignment is allowed only on a client the same push creates, restores follow only an episode change that landed, and every change is audited (1.16.4 N2, N4) | `server/rules/assignments.js`, `server/rules/episodes.js`; `test/security-1163.test.js`, `test/security-1164.test.js` |
| Silencing the notice that a record was changed | The notice belongs to the primary worker. It is known by its audit entry, never by its text, and the forged-text path of 1.16.1 was removed (1.16.2 M2; 1.16.3 L3; 1.16.4 N3, N5) | `server/rules/tasks.js`; `test/client-change-notice.test.js`, `test/security-1164.test.js` |
| Administrator reading clinical content | Break-glass requires a written, encrypted reason and is queued for a supervisor to acknowledge | `server/routes/notes.js`, `server/routes/supervision.js` |

### Devices and SUDS on this device

| Threat | Mitigation | Code / test |
| --- | --- | --- |
| Theft of a device or of a copied browser profile | The whole database image is sealed with AES-256-GCM. The key is wrapped per account with PBKDF2-SHA-256 at 600,000 iterations. The app locks after every load, on sign-out and when idle. A recovery code (140 bits) is shown once and stored nowhere | `local/vault.js`; `test/device-vault.test.js`, `test/device-recovery.test.js`; [ADR-0008](../architecture/ADR-0008-device-encryption.md) |
| A revoked person keeps the data | Deactivation queues a wipe. Revoke or wipe applies at the next contact. A narrowing of rights removes rows at the next sync. A device offline longer than the tombstones are kept is rebuilt from the office | `server/devices.js`, `server/routes/sync.js`; `test/sync-scope-change.test.js`, `test/devices.test.js` |
| Unsynced work lost on a shared device | A row with unsent changes is never deleted (1.16.3 M2) | `local/sync.js`; `test/shared-device-drop.test.js` |
| Framing, or another site on a shared Pages origin | The frame guard and the CSP are carried in the pages. The service worker is scoped to its own path. A dedicated origin is recommended ([QUESTIONNAIRE.md](QUESTIONNAIRE.md) #45a) | `scripts/static-site-security.js`; `test/static-site-csp.test.js`, `test/sw-phi.test.js` |
| Altered code served to the on-device app | Published only from an approved release tag, checked byte for byte against the tag's own build (1.16.4 M2). Counties can self-host the build | `scripts/release-site-check.js`, `.github/workflows/web-app.yml`; `test/release-site-check.test.js` |

### Data at rest, keys and audit

| Threat | Mitigation | Code / test |
| --- | --- | --- |
| A stolen database file or backup | Field encryption of identifiers and free text. Keys outside the database. Backups sealed whole. `secure_delete`, and pre-1.14 remnants scrubbed | `server/crypto.js`, `server/backup.js`; `test/plaintext-remnants.test.js`, `test/backup.test.js` |
| A key holder learns low-entropy values from blind indexes | A separate index key, generated per install. Documented as a residual risk | `test/blind-index-keys.test.js`, `test/key-separation.test.js` |
| Identifying an anonymous SSP participant from their code (1.17.0) | The code is encrypted and counted by a blind index that the receiver computes and a pull never sends. It is refused on a contact that has a client, at both doors, never printed in a report or exported (a random per-file reference stands in) and not in a publication release | `server/participant-code.js`, `server/rules/interventions.js`, `server/sync-tables.js`; `test/prevention.test.js` |
| An imported page's text outliving its record | Filing clears the item's copy of the text at both doors; the client purge deletes the client's items with a tombstone; the daily retention pass clears copies older versions left (1.17.0) | `server/routes/imports.js`, `server/rules/import_items.js`, `server/retention.js`; `test/import-text-retention.test.js` |
| A database administrator rewrites the audit log | Triggers make the log append-only. An HMAC chain and a sealed head. Hourly anchors outside the database, which are write-once where the county provides WORM storage, plus optional syslog. Scheduled verification | `server/audit.js`, `server/audit-anchor.js`; `test/audit-immutable.test.js`, `test/security-evidence.test.js` |
| Forged evidence (drill reports, audit exports) | Signed with Ed25519, and verified with the public key only | `server/signing.js`; `test/security-evidence.test.js` |
| The county signing key read from a copy of the database (built for 1.18.0, not yet released) | The seed is encrypted with the database key (`private_key_enc`), so key rotation re-encrypts it and a database copy without the key file does not hold it. A separate key from `SUDS_SIGNING_KEY`, so a county trusts it for county files only. **Make a new key** retires it (audited); the county then adds the new key under the programme (Keys › Replace the key) and can mark the old one compromised, so the files it signed stop counting, and a new file signed with a replaced key is refused ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *Key history*) | `server/county.js`; `test/county.test.js` |

### Disclosure and publication

| Threat | Mitigation | Code / test |
| --- | --- | --- |
| Identified data leaving without a lawful basis | One gate for referrals, identified exports, the EHR hand-off, CalOMS, SPARS and FHIR, with an accounting row per client ([DATA-INVENTORY.md](DATA-INVENTORY.md) section 5) | `server/disclosure.js`; `test/disclosure-gates.test.js`, `test/part2.test.js`, `test/fhir-oracle.test.js` |
| PHI sent to an AI provider without a basis, or more than one client's (1.17.0) | The copilot is off by default and cannot be switched on until an administrator records the BAA/QSOA; only the office server calls the provider, with the text given for one client, whose known identifiers are replaced first (not de-identification: the agreement is the basis). `ai:draft` is never grantable to finance or read-only; a signed note cannot be redrafted; each call is audited without its text; a per-person rate and a monthly cap | `server/ai-copilot.js`, `server/routes/ai.js`, `server/permissions.js`; `test/ai-copilot.test.js`, `test/ssrf.test.js`; [../AI-COPILOT.md](../AI-COPILOT.md) |
| Prompt injection or a wrong draft entering the record (1.17.0) | The session text is framed as material, not instructions; the result is a draft the author edits; nothing is saved, signed or submitted by the copilot; a note with drafted text is marked `ai_assisted` and signing it needs the author's review statement; CalOMS suggestions are checked against the code sets and applied one at a time | `server/ai-prompts.js`, `server/rules/notes.js`, `server/routes/notes.js`; `test/ai-copilot.test.js` |
| A secure referral link read by the wrong person, guessed or logged (1.17.0) | 256-bit tokens in the URL fragment (never in a server log or Referer), stored hashed; a live consent naming the recipient, re-checked at every open; an access code given separately; the first browser claims it; five wrong codes lock it; 1–7 days; withdrawable; accounted when first opened. Office server only | `server/referral-links.js`, `server/routes/referral-links.js`; `test/referral-links.test.js`; [REFERRAL-LINKS.md](REFERRAL-LINKS.md) |
| A scheduled CalOMS file disclosed without a person deciding (1.17.0) | A scheduled run only prepares a file, which is not a disclosure; a person with `export:identified` produces it, which accounts exactly those bytes, and is refused if a record changed since; every step is in the submission log. SUDS never uploads to DHCS | `server/caloms-schedule.js`, `server/routes/caloms.js`; `test/caloms-automation.test.js` |
| Re-identification from the programme's own outcome figures (1.17.0) | Settlement outcomes by fund put every count of people through the funder report's small-cell rules (suppressed by default, finance included; exact only on request for the roles the funder report allows), with no cost per outcome beside a hidden count; never a publication release. The prevention summary counts events and attendance, never people; *My shift* counts participant codes by blind index and shows none | `server/settlement-outcomes.js`, `server/settlement-outcome-map.js`, `server/prevention.js`, `server/outreach.js`; `test/settlement-outcomes.test.js`, `test/settlement-outcome-map.test.js`, `test/outreach.test.js` |
| Client-level data leaving in a county submission file (built for 1.18.0, not yet released) | The payload is an allow-list of aggregate figures (per fund, per allowable use, in total), checked when the file is made and again on import; it is built from the Settlement outcomes page's own `figures()`, never a second count. Making it needs `reports:funder`, `budget:read` and `export:read`, is office-server only, and is audited with the period, fingerprint and payload hash. The page says it leaves the programme and holds exact counts, for the county under the funding contract, not for publication | `server/county.js` `PAYLOAD`; `test/county.test.js` (every key on the allow-list; no client's name, code or date of birth) |
| Forged or altered county submissions, a file imported under the wrong programme, or a hostile file aimed at the county's importer (built for 1.18.0, not yet released) | Ed25519 signature over a canonical serialisation, checked with the key the county registered for the programme (exchanged out of band; the fingerprint is read out and either typed, and a mismatch refuses the key, or ticked as compared: registering needs one of the two); only a registered key of an active programme is accepted, and a new file only under its current key; the file must name this county's code (a file made for another county is refused); of one programme's files for a period, the one made last by its signed time counts, so an older file replayed after a newer one does not displace it; typed text in the file is refused if it carries control characters or bidirectional overrides; 256 KB limit, strict JSON parse, schema and allow-list checks with bounded lists and numbers before any database write; every refusal audited with its reason and throttled per person; `county:manage` (sensitive, administrators by default) to import or register | `server/county.js` `parseFile`, `importParsed`; `server/routes/county.js`; `test/county.test.js` |
| The county's exact combined figures published or differenced against programmes' own releases (built for 1.18.0, not yet released) | The county view has no publication output: its page and files are labelled internal and exact, for authorised county staff (`county:view`, never read-only); people are summed per programme, never unduplicated across programmes. Publication needs the screen over the combined release, which is not built | `server/county.js` `combined`; [../COUNTY-VIEW.md](../COUNTY-VIEW.md) |
| Re-identification from published counts | Suppression below 11 with complementary suppression, checked against an attacker who knows the method. A release that cannot be confirmed is refused whole. The 1.16.1 rule that leaked was withdrawn in 1.16.2 | `server/sdc.js`, `server/release-audit.js`; `test/publication-release.test.js`, `test/thorough/refusal-band.test.js`; [ADR-0009](../architecture/ADR-0009-publication-release.md) |

### Release pipeline and supply chain

| Threat | Mitigation | Code / test |
| --- | --- | --- |
| A malicious npm package in the server | There are none: the server uses Node built-ins only, which the SBOM script checks ([../evidence/sbom-1.17.0.cdx.json](../evidence/sbom-1.17.0.cdx.json)) | `scripts/sbom.js`; `test/sbom.test.js` |
| A malicious build tool changes the kernel | Few build tools, pinned by lockfile. The kernel is committed and CI rebuilds and compares it. esbuild and sql.js are updated by hand | `ci.yml` drift step, `scripts/kernel-build-options.js`; `test/kernel-parity.test.js` |
| Releasing untested or unapproved code | The gate requires every required job to be green on the exact commit, on `main`, from a `v*` tag matching the version, and runs `main`'s copy of the gate scripts. The owner approves the `release` environment | `scripts/release-gate.js`, `scripts/release-policy.js`; `test/release-gate.test.js`, `test/release-policy.test.js` |
| A backport released from the wrong line (1.17.0) | The gate accepts a commit on `origin/maint/X.Y` only for a patch of a minor older than `main`'s, measures it against the previous tag on its own line, and does not mark it Latest or publish the web app | `scripts/release-gate.js`, `scripts/release-policy.js`, `web-app.yml`; `test/release-gate.test.js`, `test/release-policy.test.js` |
| An edit silently changes what a released migration does (1.17.0) | The migration check fingerprints the helpers and `schema.sql` definitions each released migration depends on and fails unless a change is acknowledged with a reason | `scripts/migration-order.js`; `test/migration-order.test.js`, `test/migrations.test.js` |
| A forged GitHub Release for the owner's tag (1.16.4 H1) | The release must be made by the workflow's bot and hold only the zip and checksum, byte for byte what the tag builds. This is checked before approval, after approval and after publishing | `scripts/release-existing.js`; `test/release-existing.test.js` |
| A dependency steals the write token or the publish key (1.16.3 M2; 1.16.4 M1, M5) | npm runs only in jobs with a read-only token and no secret. The jobs that write run no npm and none of the released code. The deploy key was renamed so that older tags' workflows cannot read it | `release.yml`, `web-app.yml`; `test/release-policy.test.js` |
| Replacing a published zip, or republishing an old build | Immutable releases, the rulesets on `main`, `v*` tags and `gh-pages`, and one write deploy key. **All of these are owner settings, not yet in force** ([../RELEASE.md](../RELEASE.md), *Owner: repository settings*) | — |
| An owner setting switched off unnoticed (1.17.0) | A weekly, read-only workflow reads the settings RELEASE.md asks for and fails on any that is off or cannot be read | `.github/workflows/settings-check.yml`, `scripts/repo-settings-check.js`; `test/repo-settings-check.test.js`, `test/workflow-yaml.test.js` |

## Attack classes fixed from 1.15.4 to 1.16.4

These were found by the project's own security, engineering and UX reviews. They are fixed, and each is pinned by the tests named. A penetration tester should confirm them rather than rediscover them ([PEN-TEST-SCOPE.md](PEN-TEST-SCOPE.md)).

| Release | Class | Findings | Tests |
| --- | --- | --- | --- |
| 1.15.4 | A device approving time or spending, its owner's own included; countersignature escaped by push | H1 | `security-1154` |
| 1.15.4 | A de-identified role learning whether a named person is a client | H2 | `security-1154`, `deidentified-roles` |
| 1.15.4 | Permission overrides breaking caseload scoping; privileged grants surviving a role change | M1, M2 | `security-1154`, `user-permissions` |
| 1.15.4 | The recovery code outliving the device administrator; reasons for overrides in the audit log; drafts in a signed-out tab | L1–L3 | `security-1154`, `device-recovery` |
| 1.16.1 | Stored XSS through a pushed file type; every stored file now served as an opaque, sandboxed download | H1 | `security-1161` |
| 1.16.1 | Column smuggling and false attribution by sync | H2 | `security-1161`, `sync-attribution` |
| 1.16.1 | Attachments, supply lines, imports, SUPRT-A/CalOMS deletes and episodes changed by someone without the right; separation of duties | M1–M7 | `security-1161` |
| 1.16.1 | Pages published from any ref with no approval (engineering H2) | H2 | `release-policy` |
| 1.16.2 | Signing a note in someone else's name by sync | H1 | `security-1162` |
| 1.16.2 | Separation of duties bypassed through a visit or call | M1 | `security-1162` |
| 1.16.2 | The editor silencing the change notice; a flagged counseling note staying on a device | M2, M3 | `security-1162`, `counseling-drop-device` |
| 1.16.2 | A published withholding rule that leaked a month's count (engineering H1): withdrawn | H1 | `publication-release` |
| 1.16.3 | An opener off the care team discharging the client and ending the team | M1 | `security-1163` |
| 1.16.3 | A shared device deleting another account's unsynced edits | M2 | `shared-device-drop` |
| 1.16.3 | Signature time, signatures on drafts, a notice forged by its text | L1–L4 | `security-1163` |
| 1.16.3 | Release process: tag-only releases, the publish key isolated from third-party code, immutable releases designed | M1–M3 (engineering) | `release-policy`, `release-gate` |
| 1.16.4 | A flagged counseling note kept on a device two navigators share | N1 | `shared-device-navigators`, `shared-device-drop` |
| 1.16.4 | Standing on a case regained by sync (self-assignment, restore on a refused re-admission) | N2 | `security-1164` |
| 1.16.4 | Another worker's to-dos closed by push; two open episodes through a refused close; the 1.16.1 notice-text rule | N3–N5 | `security-1164` |
| 1.16.4 | A flag missed on a paged pull; smaller fixes (notification shows a code, not a name; creation times bounded) | N6, N7 | `security-1164` |
| 1.16.4 | A forged GitHub Release; npm isolated from write tokens; the published site checked against its tag; the deploy key renamed | H1, M1, M2, M5 (engineering) | `release-existing`, `release-site-check`, `release-policy` |

## Residual risks

These are open. Each is a reason for a county to add a control of its own, or to wait.

1. **The repository's protections are designed but not in force.** None of the following is on until the owner changes GitHub settings ([../RELEASE.md](../RELEASE.md), *Owner: repository settings*, steps 1–8):
   - the `release` environment reviewer;
   - the `main`, `v*` and `gh-pages` rulesets;
   - the single write deploy key;
   - the read-only default token;
   - release immutability;
   - CodeQL.

   Until then, anyone with write access can:
   - push a `v*` tag;
   - publish an old tag's build to the public web app, using that tag's workflow;
   - replace a published zip.

   Keep write collaborators to none, and verify a release's checksum against the one you recorded. **Owner action.**
2. **There is one maintainer, the code is AI-assisted, and there is no independent review.** Most commits are written with an AI coding assistant and merged by the owner. No second person has reviewed sync, disclosure or audit end to end. Security releases wait for the owner to push a tag, and no backup releaser is named. **Owner action:** an independent reviewer and a backup releaser.
3. **There has been no penetration test.** Every finding above came from the project's own reviews. [PEN-TEST-SCOPE.md](PEN-TEST-SCOPE.md) is ready for a county or the vendor to commission one.
4. **Shared devices protect accounts from each other by rule, not by cryptography.** Every account on a device unwraps the same database key. The per-account rules decide what a person sees on that device:
   - caseload denies;
   - counseling notes kept only for their readers (1.16.4 N1).

   These rules are enforced by the app, so a person with that device, their own password and the browser's developer tools can read every row stored there.

   Other accounts' permissions are the ones the device last received for them. A permission taken away at the office counts on that device only when that person syncs there again, or their account is deactivated.

   **Mitigations:**
   - give each person their own device where records differ by person;
   - keep local mode off where there is no field-work need;
   - deactivate leavers at once.
5. **Least privilege is a setting on an upgraded office.** A new install holds new navigators and clinicians to their caseload (1.17.0, `server/caseload-default.js`). An office upgraded from 1.16.x starts with that setting off, so until an administrator turns it on and applies it to existing staff, navigators and clinicians see every client and their devices hold the whole programme, unless the programme denies `clients:all` per person before the first sync ([QUESTIONNAIRE.md](QUESTIONNAIRE.md) #22). Navigators still read clinical notes unless denied per person.
6. **The client record's revision history starts at 1.17.0 and lives at the office.** Every change since then is kept with its earlier values (`client_revisions`, encrypted, never synchronised) and can be put back; a change made before 1.17.0 is put right from a backup. The history is readable by the care team and supervisors, so a supervisor who changes a record can read what they changed; the audit log records every read and revert.
7. **The index key doubles as the audit-chain key.** A holder of the index key could rebuild a consistent chain. Only the anchors on write-once storage and the log collector catch that ([../HIPAA.md](../HIPAA.md), risk register).
8. **The publication screen has not had an independent statistical review.** It is a conservative screen, not an expert determination. Releases that 1.16.1's withdrawn rule produced are unverified ([../HIPAA.md](../HIPAA.md)).
9. **Releases are checksummed, not signed.** The SHA-256 sits beside the zip on the same GitHub release. There is no Sigstore signature or provenance attestation yet ([SDLC.md](SDLC.md)). Tagged releases are reproducible with `git archive`, and the SBOM lists the hashes of the shipped third-party files.
10. **The policy script runs the released tree's server code** to learn its routes and permissions. A commit could understate its own surface ([../RELEASE.md](../RELEASE.md), *What running main's copy guarantees*).
11. **Single instance.** There is no high availability. Recovery is by restore, and the recovery drill is evidenced in development only (`docs/evidence/`).
12. **`node:sqlite` is experimental in Node 22.** The Docker base image is pinned by tag, not by digest. Test-only tools are pinned by version, not by hash.
13. **Data-lifecycle gaps** ([DATA-INVENTORY.md](DATA-INVENTORY.md) section 8). The one this model first listed, a committed import item's text outliving its client, is fixed in 1.17.0: filing clears the item's text, and the client purge deletes the client's items; backups made before the upgrade's first retention pass still hold the old copies until they age out.
14. **The AI copilot sends PHI to an outside provider when a programme turns it on (1.17.0).** Replacing the client's known identifiers is not de-identification: free text can name other people, places and rare events. The basis is the programme's BAA/QSOA with the provider, which SUDS records but cannot verify, and the provider's handling is outside SUDS's control ([../AI-COPILOT.md](../AI-COPILOT.md), *Residual risk*).

## Keeping this up to date

Update this document in the same change as any of these:

- a new flow out of the database;
- a new actor or deployment shape;
- a fixed security finding, which gets a row in the table of fixed classes;
- a residual risk that closes.

The data inventory and the SBOM are checked by tests; this document is not. Review it at each minor release.

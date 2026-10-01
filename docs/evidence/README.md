# Evidence index for county IT and procurement review

This page is for a county IT, security, privacy or procurement reviewer. Each common review question is mapped to the evidence that exists for it:

- the **document** that explains the control;
- the **test** that checks it (in `npm test` unless marked);
- the **CI job** that runs on every push (`.github/workflows/ci.yml`);
- the **artefact** a reviewer can take away.

**What is not here.** Nothing on this page is a certification, attestation or audit. SUDS has none of those ([../security/README.md](../security/README.md)). Items that are not in place are listed as **owner-pending** or **county**, not answered "yes".

**Version.** It describes 1.23.0: the stamp "Release 1.23.0" and the commit after it that adds its SBOM (on `main`, and published to GitHub Pages by a direct `gh-pages` push at the owner's request); the owner has not tagged it yet ([../RELEASE.md](../RELEASE.md), *Record: 1.23.0*; the tag hand-off is [RELEASE-HANDOFF.md](RELEASE-HANDOFF.md)). 1.23.0 is for the frontline worker: a follow-up date added or changed by editing a call, visit or referral makes, moves or cancels its to-do (the same rule in the REST routes and sync push, migration 67), the menu by role and programme and a phone Home that opens on today's to-dos, a street-outreach contact that names nobody kept in the office app's browser while there is no signal and counted once however late it is sent, a worker's request for a field device, and the supervisor's list of referrals waiting to hear what happened; the recovery, upgrade and installer evidence below was run on the released 1.23.0 itself (2026-10-01, for 1.23.1: *1.23.0: follow-ups, the worker's menu and outreach with no signal*, below). The SBOMs for 1.22.0 (`74852e5`), 1.21.0 (`f58128c`), 1.20.0 (`66a616b`), 1.19.0 (`3dc20dc`), 1.17.0 (`485548c`) and 1.16.4 (`6491308`) stay in this folder as history; none was made for 1.17.1 or 1.18.0. `test/doc-currency.test.js` fails when this line, the questionnaire's *Checked against* or the newest SBOM falls behind the minor line of the version `package.json` stamps. (Until the review of the 1.17.0 candidate this page named `d95b69a`, an earlier "Release 1.16.4" commit that is not on `main`, whose CI failed, and that was never published.)

**Other ways in.** The same ground is covered question by question in [../security/QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md), and for buyers in [../market/BUYER-GUIDE-IT.md](../market/BUYER-GUIDE-IT.md).

## Artefacts in this folder

| File | What it is | How to check it |
| --- | --- | --- |
| [sbom-1.23.0.cdx.json](sbom-1.23.0.cdx.json) | CycloneDX 1.5 software bill of materials for 1.23.0. See *The SBOM*, below. Generated from the stamp commit ("Release 1.23.0"), since the tag is not pushed yet, and added by the commit after it | `node scripts/sbom.js --ref $(git log -1 --format=%H --grep='^Release 1.23.0$' origin/main)` prints the same bytes, and `test/sbom.test.js` checks it |
| [sbom-1.22.0.cdx.json](sbom-1.22.0.cdx.json) | History: the SBOM for 1.22.0. See *The SBOM*, below. Generated from the stamp commit, since the tag is not pushed yet | `node scripts/sbom.js --ref 74852e525901eb921dbcf56364b66cc2837f3da8` prints the same bytes, and `test/sbom.test.js` checks it |
| [sbom-1.21.0.cdx.json](sbom-1.21.0.cdx.json) | History: the SBOM for 1.21.0. See *The SBOM*, below. Generated from the stamp commit, since the tag is not pushed yet | `node scripts/sbom.js --ref f58128c3080b464f874832856ff32d18658e3ab4` prints the same bytes, and `test/sbom.test.js` checks it |
| [sbom-1.20.0.cdx.json](sbom-1.20.0.cdx.json) | History: the SBOM for 1.20.0. See *The SBOM*, below. Generated from the stamp commit, since the tag is not pushed yet | `node scripts/sbom.js --ref 66a616b07799ea6be38a753c8c3cb379a556f0b7` prints the same bytes, and `test/sbom.test.js` checks it |
| [sbom-1.19.0.cdx.json](sbom-1.19.0.cdx.json) | History: the SBOM for 1.19.0. See *The SBOM*, below. Generated from the stamp commit, since the tag is not pushed yet | `node scripts/sbom.js --ref 3dc20dcfa27cefce0d7e715ac1229892d887f4fe` prints the same bytes, and `test/sbom.test.js` checks it |
| [sbom-1.17.0.cdx.json](sbom-1.17.0.cdx.json) | The SBOM for 1.17.0 (history) | `node scripts/sbom.js --ref 485548c7b076954cdbf1ec4445335d7459662048` prints the same bytes |
| [sbom-1.16.4.cdx.json](sbom-1.16.4.cdx.json) | The SBOM for 1.16.4 (history) | `node scripts/sbom.js --ref 6491308` prints the same bytes |
| [RELEASE-HANDOFF.md](RELEASE-HANDOFF.md) | The tag hand-off for the untagged releases, 1.16.3 to 1.23.4: the tag commands, the SHA-256 of each release zip the release workflow will build (rebuilt here from each commit, reproducibly), the one push, and what each tag's workflow runs will do | Rebuild a zip with `git archive --format=zip --prefix=suds-vX.Y.Z/ <commit>` and `sha256sum` it |
| [dr-drill-2026-10-01-v1.23.0/](dr-drill-2026-10-01-v1.23.0/README.md) | **The latest.** Recovery drill on the released 1.23.0 (`9877d07`, schema 67, 79 tables) at 20,000 fictional clients, run as the 1.21.0 one was: 11 of 11 checks, drill RTO 4.5 s, host-procedure RTO 3 s, RPO 5 s. A signed JSON report, the text report, the public key and the console transcript | `npm run verify-dr-report -- dr-drill-2026-10-01-v1.23.0/<report>.json --public-key dr-drill-2026-10-01-v1.23.0/suds-signing-key.pem` |
| [upgrade-drill-2026-10-01-v1.23.0/](upgrade-drill-2026-10-01-v1.23.0/README.md) | **The latest upgrade drill.** To 1.23.0: databases written by 1.21.0 and 1.22.0 (20,000 fictional clients each), each holding a field device, a county release published (on 1.22.0 with each programme's consent), the authenticator allow-list on with an attested passkey and one from before it (refused on 1.21.0, in its grace period on 1.22.0), follow-up to-dos from a call and a visit, and a supervisor's reminder to sign a draft, opened by 1.23.0 (migrations 64–67 and 67): schema identical to a fresh install, no rows lost, **every kept row unchanged by the columns the older release had**; the field device and its account's next device told `field`, both passkeys as their release left them, the to-dos moved when their dates change, the reminder closed on signing, a corrected county release published (1.22.0) or refused (1.21.0, which kept no inputs); then backed up and drilled, 11 of 11 each. Also made `test/fixtures/release-v1.22.0.sql` | As above, per folder |
| [installer-container-run-2026-10-01-v1.23.0/](installer-container-run-2026-10-01-v1.23.0/README.md) | **The latest installer run.** `install.sh` 1.23.0, and `upgrade.sh` 1.22.0 → 1.23.0 with the installed 1.22.0 upgrader, run for real on Ubuntu 24.04 with systemd, **in a container, not a VM**; first and escrowed-key drills (11/11, 12/12); signed compliance and drill reports. **The 1.21.0 run's three findings are closed** (under the service sandbox SUDS logs "listening on", no unhandled rejection, and `/api/setup/status` and `/api/app/info` answer 200 signed in). **One finding:** 1.22.0 and 1.23.0 ship the same `upgrade.sh` and `lib.sh`, so the installed upgrader rightly did not hand over; the hand-over itself was exercised with a probe build, and is still to be seen between two real releases | `npm run verify-compliance-report -- <report>.json --public-key <its folder>/compliance-signing-key.pub.pem` |
| [dr-drill-2026-10-01-v1.21.0/](dr-drill-2026-10-01-v1.21.0/README.md) | Recovery drill on the released 1.21.0 (`348e18c`, schema 63, 76 tables) at 20,000 fictional clients, run as the 1.20.0 one was: 11 of 11 checks, drill RTO 4 s, host-procedure RTO 3.9 s, RPO 5 s. A signed JSON report, the text report, the public key and the console transcript | `npm run verify-dr-report -- dr-drill-2026-10-01-v1.21.0/<report>.json --public-key dr-drill-2026-10-01-v1.21.0/suds-signing-key.pem` |
| [upgrade-drill-2026-10-01-v1.21.0/](upgrade-drill-2026-10-01-v1.21.0/README.md) | Upgrade drill to 1.21.0: databases written by 1.16.2, 1.19.0 and 1.20.0 (20,000 fictional clients each; signed county submissions on 1.19.0 and 1.20.0, a county-entered quarter on 1.20.0; a passkey on 1.19.0 and 1.20.0; a sync device and the sessions each opened), opened by 1.21.0 (migrations 49–63, 60–63 and 61–63): schema identical to a fresh install, no rows lost, **every county row, session, device and passkey kept unchanged; devices `sync_scope` full, no participant codes, passkeys unattested, older sessions no `device_id`**; the passkey and the device sign in again and a screened county release is published; then backed up and drilled, 11 of 11 each. Also made `test/fixtures/release-v1.20.0.sql` | As above, per folder |
| [installer-container-run-2026-10-01-v1.21.0/](installer-container-run-2026-10-01-v1.21.0/README.md) | `install.sh` 1.21.0, and `upgrade.sh` 1.20.0 → 1.21.0 (1.21.0's own, as documented, and the installed 1.20.0 one: the same result) and 1.19.0 → 1.21.0 (the installed 1.19.0 one: SUDS names the two `WEBAUTHN_*` lines at start and in `app.passkeys`), run for real on Ubuntu 24.04 with systemd, **in a container, not a VM**; the hand-over exercised with a probe build; first and escrowed-key drills; signed compliance and drill reports. **Two findings**, both fixed in 1.22.0 (`suds.service` lacks `AF_NETLINK`, so the listener now reads the LAN addresses as "none" under the sandbox instead of an unhandled rejection at every start and HTTP 500 from two signed-in routes; the dry run from a zip now says the release's own upgrader may take over) | `npm run verify-compliance-report -- <report>.json --public-key <its folder>/compliance-signing-key.pub.pem` |
| [dr-drill-2026-09-30-v1.20.0/](dr-drill-2026-09-30-v1.20.0/README.md) | Recovery drill on the released 1.20.0 (`8f365b4`, schema 60) at 20,000 fictional clients, run as the 1.19.0 one was: 11 of 11 checks, drill RTO 3.6 s, host-procedure RTO 2.8 s, RPO 5 s. A signed JSON report, the text report, the public key and the console transcript | `npm run verify-dr-report -- dr-drill-2026-09-30-v1.20.0/<report>.json --public-key dr-drill-2026-09-30-v1.20.0/suds-signing-key.pem` |
| [upgrade-drill-2026-09-30-v1.20.0/](upgrade-drill-2026-09-30-v1.20.0/README.md) | Upgrade drill to 1.20.0: databases written by 1.16.2, 1.18.0 and 1.19.0 (20,000 fictional clients each; on 1.18.0 and 1.19.0 also three signed county submissions, one superseded), opened by 1.20.0 (migrations 49–60, 58–60 and 60): schema identical to a fresh install, no rows lost, **migration 60 keeps every county submission unchanged as signed and sets `on_suds`**, the API lists and counts them and takes county-entered figures; then backed up and drilled, 11 of 11 each | As above, per folder |
| [installer-container-run-2026-09-30-v1.20.0/](installer-container-run-2026-09-30-v1.20.0/README.md) | `install.sh` 1.20.0, and `upgrade.sh` from 1.19.0 to 1.20.0, run for real on Ubuntu 24.04 with systemd, **in a container, not a VM**: the four 1.19.0 findings checked (fixed on a new install; one gap on the documented upgrade from 1.19.0, a new finding); the installer's first drill and an escrowed-key drill; signed compliance and drill reports | `npm run verify-compliance-report -- <report>.json --public-key <its folder>/compliance-signing-key.pub.pem` |
| [dr-drill-2026-09-30/](dr-drill-2026-09-30/README.md) | Recovery drill on the released 1.19.0 (`3dc20dc`, schema 59) at 20,000 fictional clients, run as the 1.16.2 one was: 11 of 11 checks, drill RTO 5 s, host-procedure RTO 3.7 s, RPO 5 s. A signed JSON report, the text report, the public key and the console transcript | `npm run verify-dr-report -- dr-drill-2026-09-30/<report>.json --public-key dr-drill-2026-09-30/suds-signing-key.pem` |
| [upgrade-drill-2026-09-30/](upgrade-drill-2026-09-30/README.md) | Upgrade drill to 1.19.0: databases written by 1.16.2 and by 1.18.0 (each with 20,000 fictional clients, a signed and countersigned note and a TOTP user), opened by 1.19.0 (migrations 49–59, and 58–59): schema identical to a fresh install, no rows lost, every sampled value decrypts, the note and the audit chain verify; then backed up and drilled, 11 of 11 each. Transcripts, summaries, signed reports and public keys | As above, per folder |
| [installer-container-run-2026-09-30/](installer-container-run-2026-09-30/README.md) | `deploy/linux/install.sh`, and `upgrade.sh` from 1.18.0 to 1.19.0, run for real on Ubuntu 24.04 with systemd, **in a container, not a VM**; a drill on the installed server; the signed compliance reports. RHEL 9 could not be run. Four findings for the owner, all fixed in 1.20.0 (verified by the 1.20.0 run) | `npm run verify-compliance-report -- <report>.json --public-key <its folder>/compliance-signing-key.pub.pem` |
| [INSTALLER-VM-RUN.md](INSTALLER-VM-RUN.md) | **Owner-pending.** The runbook for the installer run on fresh Ubuntu 24.04 and RHEL 9 VMs: commands, expected output, the compliance report to collect, what to commit back | — |
| [dr-drill-2026-09-29.md](dr-drill-2026-09-29.md) and [its folder](dr-drill-2026-09-29/) | Recovery drill on the released 1.16.2 at 20,000 fictional clients: 11 of 11 checks, drill RTO 3.8 s. A signed JSON report, the text report and the public key | `npm run verify-dr-report -- dr-drill-2026-09-29/<report>.json --public-key dr-drill-2026-09-29/suds-signing-key.pem` |
| [dr-drill-2026-09-25.md](dr-drill-2026-09-25.md) and [its folder](dr-drill-2026-09-25/) | The earlier drill (1.11.0 branch, schema 37) | As above |

**The SBOM** lists:

- the Node.js runtime CI pins (with its tarball hash) and the built-ins the server uses;
- SUDS's own code, as tree hashes;
- the vendored and generated browser files: kernel, `sql-wasm.wasm`, `qr.js` and compressed copies, with SHA-256 and SHA-512;
- the seven npm packages bundled into the browser kernel and the SQLite inside the wasm;
- separately, as scope *excluded*: build, test and CI tooling that never ships.

**The drills are development exercises, not production drills.** They prove SUDS's backup and restore code paths on a realistic database. They do not prove a county's own backups, keys or hosting can be recovered.

## Review questions and their evidence

### Encryption at rest

- **Documents:** [ENCRYPTION-AND-KEYS.md](../security/ENCRYPTION-AND-KEYS.md); [DATA-INVENTORY.md](../security/DATA-INVENTORY.md), which lists every encrypted column; [ADR-0005](../architecture/ADR-0005-encryption-and-blind-indexes.md); [ADR-0008](../architecture/ADR-0008-device-encryption.md).
- **Tests:** `crypto`, `data-inventory` (every `_enc` column is listed), `sync` (every `_enc` column declared for devices), `backup` (rotation finds every column), `plaintext-remnants`, `blind-index-keys`, `key-separation`, `device-vault`, `filename-encryption`.
- **CI:** `test`, `node24`.
- **Status:** In place. The coded reporting fields are readable and rely on the county's volume encryption. **County:** encrypted volume, key custody.

### Encryption in transit

- **Documents:** [ENCRYPTION-AND-KEYS.md](../security/ENCRYPTION-AND-KEYS.md), *In transit*; [../DEPLOYMENT.md](../DEPLOYMENT.md) (TLS, proxy).
- **Tests:** `security-hardening`, `health-probes`, `static-site-csp`.
- **CI:** `test`.
- **Status:** In place: TLS 1.2+, HSTS, `Secure` and `SameSite=Strict` cookies. Network access without HTTPS is refused. **County:** certificates and the proxy.

### Key management and rotation

- **Documents:** [ENCRYPTION-AND-KEYS.md](../security/ENCRYPTION-AND-KEYS.md); [../DEPLOYMENT.md](../DEPLOYMENT.md), *Key rotation runbook*.
- **Tests:** `rotate-index-key`, `backup`, `key-separation`, `security-evidence`.
- **CI:** `test`, `dr-drill` (escrowed key file).
- **Status:** In place. **County:** the secrets manager and the custodians.

### Access control, MFA and SSO

- **Documents:** [IDENTITY.md](../security/IDENTITY.md); [QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) #17–#24.
- **Tests:** `auth-permissions`, `role-expansion`, `user-permissions`, `deidentified-roles`, `mfa-grace`, `mfa-enrol-hardening`, `in-session-guessing`, `signer-hardening`, `oidc`, `oidc-reauth`, `idp-lifecycle`, `scim`, `security-1154` to `security-1164`, `security-1170`; passkeys (1.19.0): `fingerprint`, `fingerprint-review`, `fingerprint-r2`, `fingerprint-sso`, `fingerprint-regression`.
- **CI:** `test`; `browser` (`permissions-admin`, `signup`, `fingerprint`).
- **Status:** In place, with caveats. Least privilege is the default for a new install and a setting an upgraded office turns on (*New navigators and clinicians start held to their caseload*, 1.17.0; `least-privilege-default`, `least-privilege-sso`, `least-privilege-device`); an upgraded office that leaves it off keeps navigators and clinicians seeing every client. The client record keeps a revision history with revert from 1.17.0 (`client-revisions`), at the office only.

### Authorisation on the sync door (local mode)

- **Documents:** [THREAT-MODEL.md](../security/THREAT-MODEL.md), *Authorisation and insiders* and *Devices*; [ADR-0003](../architecture/ADR-0003-sync-protocol.md).
- **Tests:** `sync-rules`, `sync-attribution`, `sync-scope-change`, `shared-device-drop`, `shared-device-navigators`, `counseling-drop-device`, `kernel-parity`, `kernel-sync-parity`.
- **CI:** `test`; `browser` (`local-mode`, `sync-two-way`, `multitab`).
- **Status:** In place. Local mode is off by default. On a shared device, accounts are separated by rule, not by key (a residual risk).

### Audit logging and tamper evidence

- **Documents:** [LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md); [ADR-0006](../architecture/ADR-0006-append-only-audit.md).
- **Tests:** `audit-immutable`, `audit-retention`, `audit-anchor-interval`, `security-evidence` (anchors, signed export), `reason-privacy`, `clinical-audit`.
- **CI:** `test`; `dr-drill` (chain verified after restore).
- **Artefact:** A signed audit export (`npm run verify-audit-export`).
- **Status:** In place. **County:** WORM storage for `AUDIT_ANCHOR_DIR`, and a SIEM.

### Backup, disaster recovery and continuity

- **Documents:** [BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md); [../DEPLOYMENT.md](../DEPLOYMENT.md), *Backups*.
- **Tests:** `backup`, `scheduled-backup`, `backup-restore-race`, `restore-aside-seal`, `instance-lock`, `security-evidence`.
- **CI:** **`dr-drill`**, on every push and required by the release gate.
- **Artefact:** The drill reports above (development), the latest on 1.23.0 ([dr-drill-2026-10-01-v1.23.0/](dr-drill-2026-10-01-v1.23.0/README.md)); the upgrade drill (1.21.0 and 1.22.0 databases opened by 1.23.0, then drilled: [upgrade-drill-2026-10-01-v1.23.0/](upgrade-drill-2026-10-01-v1.23.0/README.md)); drills on a server the installer set up, in a container (the installer's own first drill, and one with the escrowed key file).
- **Status:** In place, and exercised in development only. **County:** a drill on the real deployment, run by its operator. Single instance; no automatic failover.

### Vulnerability management and supply chain

- **Documents:** [VULNERABILITY-MANAGEMENT.md](../security/VULNERABILITY-MANAGEMENT.md); [`SECURITY.md`](../../SECURITY.md) (how to report); the SBOM ([sbom-1.23.0.cdx.json](sbom-1.23.0.cdx.json)); `.github/dependabot.yml`.
- **Tests:** `sbom` (the server requires only Node built-ins; the committed SBOM equals a fresh run), `kernel-parity`.
- **CI:** `test` (the kernel and schema must match their sources); Node pinned by SHA-256.
- **Status:** The server has zero runtime npm packages, and the SBOM is published. The security policy is `SECURITY.md`. **Owner-pending:** CodeQL and secret scanning (repository settings), turning on private vulnerability reporting and confirming `SECURITY.md`'s response targets, and a penetration test. SAST and DAST are not in CI.

### Secure development, change control and releases

- **Documents:** [SDLC.md](../security/SDLC.md); [../RELEASE.md](../RELEASE.md) (the gate, the policy, the owner settings); `.github/CODEOWNERS`.
- **Tests:** `release-gate`, `release-policy`, `release-existing`, `release-site-check`, `migrations`, `migration-order`, `release-wording` `doc-currency` and `doc-content-currency` (the documents, and their content, keep up with a stamped release), and `release-state` (the release documents against the CHANGELOG, `main`, the tags and GitHub Pages; 1.21.0).
- **CI:** Every push: `test`, `thorough`, `thorough-sdc`, `browser`, `node24` and `dr-drill` (the gate's `REQUIRED_JOBS`); `webkit` is advisory.
- **Status:** The gate is designed and enforced by the workflow. **Owner-pending:** the repository settings that make the approval and the tag rules binding (not in force); an independent reviewer (708 of the 727 commits up to the 1.21.0 documentation pass were written with an AI assistant; method in [QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) #36a); signed releases.

### Threat model and penetration testing

- **Documents:** [THREAT-MODEL.md](../security/THREAT-MODEL.md); [PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md).
- **Tests:** The security review suites named in the threat model's table of fixed classes; from 1.21.0, `county-fuzz` (seeded fuzz and property tests of the county surface: the CSV import and entry form, the tidy CSV round trip, the signed-file verifier, a pasted key, the connection's request parsing; `SUDS_FUZZ_SEED` replays a run), twenty times larger in `thorough`.
- **Status:** The threat model is the project's own, and on 1.21.0 models the county surface, SUDS Server, publication releases, field devices and the allow-list; no penetration test has been done. **Owner-pending:** commission a penetration test.

### Data inventory, data flows and retention

- **Documents:** [DATA-INVENTORY.md](../security/DATA-INVENTORY.md); [DATA-LIFECYCLE.md](../security/DATA-LIFECYCLE.md); [ARCHITECTURE.md](../security/ARCHITECTURE.md) (the diagram).
- **Tests:** `data-inventory` (checked against the schema, the sync tables and retention), `load-review` (every client table is on the retention clock), `deid-safe-harbor`.
- **CI:** `test`.
- **Status:** In place. The committed-import-text gap the inventory found is fixed in 1.17.0 (`import-text-retention`; DATA-INVENTORY section 8).

### 42 CFR Part 2 and disclosures

- **Documents:** [../compliance/PART2.md](../compliance/PART2.md); [../HIPAA.md](../HIPAA.md); [ADR-0004](../architecture/ADR-0004-disclosure-gate.md); [../integration/FHIR.md](../integration/FHIR.md).
- **Tests:** `part2`, `part2-layer` (1.17.0), `referral-links` (secure referral links, 1.17.0; [REFERRAL-LINKS.md](../security/REFERRAL-LINKS.md)), `disclosure-gates`, `counseling-notes`, `fhir`, `fhir-oracle`, `fhir-hardening`, `compliance`, `witness-metadata-privacy`.
- **CI:** `test`.
- **Status:** Addressed in software. **Owner-pending:** counsel review of consent and notice wording, and an independent Part 2 review.

### AI documentation copilot (1.17.0, optional)

- **Documents:** [../AI-COPILOT.md](../AI-COPILOT.md) (what is sent, the residual risk, what is recorded); [DATA-INVENTORY.md](../security/DATA-INVENTORY.md) section 5; [THREAT-MODEL.md](../security/THREAT-MODEL.md).
- **Tests:** `ai-copilot`, `ssrf`, `role-expansion`; browser `r10-ai` (against a local fake provider).
- **CI:** `test`; `browser` (`r10-ai`).
- **Status:** Released in 1.17.0; off by default, and office server only. **Programme-pending:** a BAA with Part 2 QSOA terms with the AI provider, and counsel's review, before it is switched on.

### The county view and the county connection (1.18.0; office servers only)

- **Documents:** [../COUNTY-VIEW.md](../COUNTY-VIEW.md) (what the file holds, the trust model, *Connecting*); [DATA-INVENTORY.md](../security/DATA-INVENTORY.md) section 5; [THREAT-MODEL.md](../security/THREAT-MODEL.md); [ARCHITECTURE.md](../security/ARCHITECTURE.md) (the diagram and trust boundary 7); [PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md) (both sides of the connection).
- **Tests:** `county` (the allow-list, signing, import checks, supersession, withdraw and reinstate, key history), `county-periods`, `county-connect` (tokens, scopes, a programme's token with another's file, limits, the body caps, the programme's outbound checks, automatic sending), `county-device` and `county-connect-device` (none of it on SUDS on this device), `ssrf`.
- **CI:** `test`; `browser` (`county`, `county-connect`).
- **Artefact:** A county submission file verifies on import under the programme's registered Ed25519 key; every import, refusal, send and read is in the audit log without figures ([LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md), *Audit actions added in recent releases*; from 1.20.0 the county's own entries of a grantee's figures too, as `county.entry.*`).
- **Status:** Released in 1.18.0. The file carries aggregates only; the connection is off by default on both sides and, behind a proxy, needs `TRUST_PROXY=1` on the county's server. **County:** exposing `/api/county-connect/v1/` through its TLS proxy or a VPN, and data stewardship for the combined figures (internal; from 1.21.0 publishable only as a screened release, below). **Owner-pending:** counsel's review of the stewardship ([../market/DATA-NETWORK.md](../market/DATA-NETWORK.md)).

### SUDS Server's signed compliance report (1.18.0)

- **Documents:** [../SELF-HOSTING.md](../SELF-HOSTING.md) (*The compliance check*, *Compliance boundary*, the operator checklist); [`deploy/linux/`](../../deploy/linux/README.md).
- **Tests:** `compliance-check` (every host check against fixtures, TLS against local servers, the signed report and tamper detection), `compliance-safety` (the root-run check never follows a path the `suds` user controls), `compliance-report-route`, `compliance`, `deploy-linux`, `deploy-linux-real` (the installer in a fake root with stub system commands).
- **CI:** `test`.
- **Artefact:** `/var/lib/suds-compliance/compliance-<stamp>.json` and `.html`, signed with the compliance check's own Ed25519 key (root only; the SUDS service never holds it). Verify away from the server with the public half alone: `npm run verify-compliance-report -- compliance-<stamp>.html --public-key /etc/suds/compliance-signing-key.pub.pem` (`scripts/verify-compliance-report.js`; the HTML is re-rendered and compared, so an edit to what it shows fails). A report from a wizard or Docker install is signed with the server's evidence key instead (`report.host.signed_with` says which).
- **Status:** Released in 1.18.0. A report records what the check observed; it is not an attestation, and it lists what it cannot see. **Owner-pending:** a run of the installer and an upgrade on a real Ubuntu 24.04 and RHEL 9 VM. **County:** everything in *Compliance boundary*.

### Fingerprint signature evidence (1.19.0; office server only)

- **Documents:** [../FINGERPRINT.md](../FINGERPRINT.md) (the design, no biometric data, the evidence, the reviews); [IDENTITY.md](../security/IDENTITY.md); [DATA-INVENTORY.md](../security/DATA-INVENTORY.md) (`passkeys`, `webauthn_challenges`, `signature_evidence`).
- **Tests:** `fingerprint` (a software authenticator: ES256, EdDSA, RS256; registration, assertion, replay, cross-record and counter checks), `fingerprint-review`, `fingerprint-r2`, `fingerprint-sso`, `fingerprint-regression` (people without passkeys get what 1.18.0 gave them).
- **CI:** `test`; `browser` (`fingerprint`, with Chromium's virtual authenticator, and the accessibility audit of its dialogs).
- **Artefact:** For a signature or approval confirmed with a fingerprint, the evidence (the statement of exactly what was signed, the device's assertion and the passkey's public key) from `GET /api/admin/signature-evidence?record_type=note&record_id=<id>` (`audit:read`), verified offline, after the passkey is removed too: `npm run verify-passkey-evidence -- evidence.json --audit audit-export.ndjson --public-key suds-signing-key.pem` (`scripts/verify-passkey-evidence.js`; `--content <hash>` also checks the note's content hash). It checks the statement against the challenge, the origin and relying party, user verification, the signature, and that the key is the one enrolled (the SHA-256s in the enrolment's audit entry).
- **Status:** Released in 1.19.0. **County:** HTTPS and `WEBAUTHN_RP_ID` before anyone enrols; the policy switches; counsel on the biometric-law position (FINGERPRINT.md). Not on SUDS on this device.

### 1.21.0: publication releases, field devices and the allow-list

- **Documents:** [../COUNTY-VIEW.md](../COUNTY-VIEW.md) (*Publication*, *Award amounts*, *Reminders on the programme's side*, each with the owner's decisions); [../PLATFORM.md](../PLATFORM.md) (*Field devices*); [../FINGERPRINT.md](../FINGERPRINT.md) (*Authenticator allow-list*); [THREAT-MODEL.md](../security/THREAT-MODEL.md) (*What 1.21.0 adds*); [DATA-INVENTORY.md](../security/DATA-INVENTORY.md) (migrations 61 to 63).
- **Tests:** `county-publication` (permissions, screening, a brute-force differencing attack, refusal, the append-only record, withdrawal, the read API) and `county-publication-sdc` (the algorithm-aware differencing attacker; full size in `thorough-sdc`); `field-device`, `field-device-kernel` and `participant-code-default` (every synchronised table has a field-scope decision; pull and push enforced from the office's record of the device), `participant-code-outputs`; `attestation` (each attestation format, the Metadata Service file's signature chain and freshness, refused statuses, sessions ended); `county-award` (schema version 2, the award checks, spending against the award, and the reminders and county schedule); browser `county-publication`, `field-device`, `fingerprint` part 7.
- **CI:** `test`, `thorough-sdc`, `browser`.
- **Status:** Released in 1.21.0, office server only for publication, the allow-list and reminders. Field devices, participant codes first and the allow-list are **off** until an administrator turns them on. **County:** its small-cell threshold at least as high as its programmes' (COUNTY-VIEW, *Publication*, decision 2). **Owner-pending:** confirm the conservative defaults listed in COUNTY-VIEW, PLATFORM and FINGERPRINT (HANDOFF.md, 1.21.0 entry); an independent statistical review covers publication releases too.

### 1.23.0: follow-ups, the worker's menu and outreach with no signal

- **Documents:** [../USER_GUIDE.md](../USER_GUIDE.md) (*Follow-up dates and your to-dos*; *Street outreach*: *No signal on the office app* and *Set up this phone for the field*; *Supervision*: *Waiting to hear what happened*); [../PLATFORM.md](../PLATFORM.md) (*Field devices*: asking for one); [THREAT-MODEL.md](../security/THREAT-MODEL.md) (*What 1.23.0 changes*); [DATA-INVENTORY.md](../security/DATA-INVENTORY.md) (the street-outreach waiting list in the browser, field-device requests, migration 67); [LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md) (`referral.remind`, `device.field_request`, `<record>.create.replayed`).
- **Tests:** `follow-ups` and `follow-ups-kernel` (a follow-up date made, moved and cancelled on insert and on update, by the REST routes and by sync push, without a second to-do, and only while the to-do is as SUDS made it); `outreach-queue` (what the waiting list may carry, the keyed id answered once however late, a contact the office already has found before the write rules, field-device requests and who may answer them); `supervision-referrals` (which referrals are waiting, the reminder's to-do, encryption and audit, who may send one, both doors closing the to-dos); `nav-menu` (every role, profile and module switch: every page a role may open is in its menu and none it may not); browser scripts `menu-home`, `offline-outreach` and `worker-usefulness`, each with axe.
- **CI:** `test`, `browser`.
- **Artefact:** run on the released 1.23.0 (2026-10-01): the recovery drill ([dr-drill-2026-10-01-v1.23.0/](dr-drill-2026-10-01-v1.23.0/README.md)); the upgrade drill from 1.21.0 and 1.22.0 with migration 67's follow-up to-dos (and 64–66's field device, consents and grace period) written by the older release and moved by 1.23.0 ([upgrade-drill-2026-10-01-v1.23.0/](upgrade-drill-2026-10-01-v1.23.0/README.md)), and `test/migrations.test.js`'s *SUDS 1.23.0's first start on a 1.22.0 database*; the installer run ([installer-container-run-2026-10-01-v1.23.0/](installer-container-run-2026-10-01-v1.23.0/README.md)).
- **Status:** Released in 1.23.0. No new permission. The office app now keeps street-outreach contacts that name nobody in the browser of a phone with no signal (not encrypted: no PHI; per account, kept through sign-out). **Owner-pending:** screen-reader testing of the screens 1.21.0 to 1.23.0 added; the decisions listed in HANDOFF.md, 1.23.0 entry.

### 1.22.0: field scope, publication consent and the grace period

- **Documents:** [../PLATFORM.md](../PLATFORM.md) (*Field devices*: the scope follows the account); [../COUNTY-VIEW.md](../COUNTY-VIEW.md) (*Publication*: consent, a corrected release, decisions 3, 7 and 8; *Award amounts*: pro-rated to the period; *Which version a file is made in*); [../FINGERPRINT.md](../FINGERPRINT.md) (*Grace period*); [THREAT-MODEL.md](../security/THREAT-MODEL.md) (*What 1.22.0 changes*; residual risk 20); [PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md) (drawn from the threat model); [DATA-INVENTORY.md](../security/DATA-INVENTORY.md) (migrations 64 to 66); [../USER_GUIDE.md](../USER_GUIDE.md) (the day-to-day changes for workers).
- **Tests:** `field-device` (a missing device id with the default on, a rotated id, an administrator's whole device, a user who cannot widen, the sync session's reach into `/api/auth/`, a revoked or wiped device's open session); `county-publication` (consent recorded, withdrawn and checked again where a release is written; a corrected release and the brute-force differencing test across the withdrawn and corrected releases); `county-award` (the award pro-rated to the period, the version choice); `attestation` (the grace period with a fake clock, never for a compromised or revoked model, sessions ending with it); `worker-usefulness` (the call follow-up, Undo's delete and stock, the supervision queue's worker); `listener-sandbox`; `pen-test-scope` (every threat-model row maps to a scope row); `county-packet`; browser `worker-usefulness`, `field-device`, `county-publication`, `fingerprint` part 8.
- **CI:** `test`, `browser`.
- **Status:** Released in 1.22.0. On upgrade, a whole device of an account held to the field scope becomes a field device at its next sync unless an administrator marks it *Keep everything*; a county file made by hand is version 1 until the programme answers that its county runs SUDS 1.21 or later; the allow-list's grace period is 14 days unless set. **Owner-pending:** confirm the conservative defaults (HANDOFF.md, 1.22.0 entry); screen-reader testing of the screens 1.21.0 and 1.22.0 added.

### De-identification and publication

- **Documents:** [../HIPAA.md](../HIPAA.md), *Small cells*; [ADR-0009](../architecture/ADR-0009-publication-release.md); [../PERFORMANCE.md](../PERFORMANCE.md).
- **Tests:** `deid-safe-harbor`, `small-cell-suppression`, `publication-release`; in `thorough-sdc`, `thorough/refusal-band` and `thorough/refusal-quarters`.
- **CI:** `test`, `thorough-sdc`.
- **Status:** A conservative screen, not an expert determination. **Owner-pending:** an independent statistical review.

### Accessibility

- **Documents:** [../accessibility/ACR-WCAG21.md](../accessibility/ACR-WCAG21.md) (VPAT 2.5); [../accessibility/STATEMENT.md](../accessibility/STATEMENT.md).
- **Tests:** The browser suite: `accessibility` (axe-core, WCAG 2.1 AA, fails on any finding), `a11y-round4`.
- **CI:** `browser`, required.
- **Status:** A self-assessment; partially conformant. **Owner-pending:** screen-reader testing and a third-party review.

### Incident response and breach notification

- **Documents:** [INCIDENT-RESPONSE.md](../security/INCIDENT-RESPONSE.md).
- **Tests:** `part2` (draft incidents from a mass export or a broken audit chain), `disclosure-gates` (the register's encrypted snapshots), `security-evidence`.
- **CI:** `test`.
- **Status:** SUDS supplies the signals, the register and the evidence. **County:** the plan, and the decisions to notify.

### Container and host hardening

- **Documents:** [../SELF-HOSTING.md](../SELF-HOSTING.md) (SUDS Server: the hardened Linux install and its compliance boundary); [`deploy/linux/`](../../deploy/linux/README.md); [`deploy/docker/`](../../deploy/docker/README.md); `Dockerfile`, `docker-compose.yml`; [../DEPLOYMENT.md](../DEPLOYMENT.md), *Hardening checklist*.
- **Tests:** `deploy-linux` (the installer's plan and refusals for both distribution families, the unit's single source, the Node pin matching CI), `deploy-linux-real`, `compliance-check` (every host check against fixtures, TLS against local servers, the signed report and tamper detection), `compliance-report-route`, `secret-files`. The compliance report has its own section above.
- **CI:** `test` (packaging).
- **Artefact — the compliance report.** On SUDS Server, `scripts/compliance-check.js` runs weekly (`suds-compliance.timer`) and writes `/var/lib/suds-compliance/compliance-<stamp>.json` and `.html` (root-owned, readable by the `suds` group): every host and app-level check with the HIPAA Security Rule, 42 CFR §2.16 or CMIA rule it produces evidence for, what was observed and the remediation, signed with the compliance check's own Ed25519 key (`/etc/suds/compliance-signing-key`, root only, never given to the SUDS service). Verify it with that key's public half alone, taken on the server: `npm run verify-compliance-report -- <file> --public-key /etc/suds/compliance-signing-key.pub.pem` (the HTML is also re-rendered and compared, so an edit to what it shows fails). Download the last one from Settings → Security status (`GET /api/admin/security/compliance-report`, audited). Keep them with the audit evidence for six years. "Could not check" is never counted as a pass, and an accepted risk (an unencrypted data disk) is printed on every report.
- **Artefact — the installer run.** [installer-container-run-2026-10-01-v1.23.0/](installer-container-run-2026-10-01-v1.23.0/README.md) (1.23.0; the earlier [1.21.0](installer-container-run-2026-10-01-v1.21.0/README.md), [1.20.0](installer-container-run-2026-09-30-v1.20.0/README.md) and [1.19.0](installer-container-run-2026-09-30/README.md) runs): the installer and the upgrader run for real on Ubuntu 24.04 in a systemd container, with their signed compliance reports. Not a VM; RHEL 9 not run. The VM run is owner-pending ([INSTALLER-VM-RUN.md](INSTALLER-VM-RUN.md)).
- **Status:** A non-root, read-only container; on a VM, the installer's hardening, checked weekly. **County:** what the check cannot see — encryption beneath the VM, perimeter firewalls, the WORM property of the anchor share, key escrow — and everything in *Compliance boundary*.

### Support and vulnerability reporting

- **Documents:** [../SUPPORT.md](../SUPPORT.md); [`SECURITY.md`](../../SECURITY.md) (vulnerability reports: how, what to include, scope); [../market/templates/SUPPORT-SLA.md](../market/templates/SUPPORT-SLA.md) (an owner template).
- **Status:** Channels today: the public issue tracker and private vulnerability reports. **Owner-pending:** turning on private vulnerability reporting, confirming `SECURITY.md`'s response targets, a signed support agreement and contacts.

## Owner-pending: what only the owner can do

These close review questions that software cannot. The status of each is on the record in [../market/README.md](../market/README.md), *Organisational gaps*, and in [../RELEASE.md](../RELEASE.md), *Owner: repository settings*.

1. **Repository settings** ([../RELEASE.md](../RELEASE.md), steps 1–8). Keep screenshots of each for county IT. Until these are done, the release controls are documented but not in force.
   - the `release` environment's reviewer, limited to `v*` tags;
   - the `main` and `v*` rulesets;
   - the `gh-pages` ruleset with a single `PAGES_PUBLISH_KEY` deploy key;
   - a read-only default token;
   - immutable releases, with older releases' checksums recorded;
   - stale branches deleted;
   - CodeQL, secret scanning and push protection.
2. **Tag the released versions, in one push.** 1.16.3 (`fc5e9d7`), 1.16.4 (`6491308`), 1.17.0 (`485548c`), 1.17.1 (`ab90c2f`), 1.18.0 (`39e397e`), 1.19.0 (`3dc20dc`), 1.20.0 (`8f365b4`, after its stamp `66a616b`), 1.21.0 (`8dc7aa1`, after its stamp `f58128c`), 1.22.0 (`8b136df`, after its stamp `74852e5`), 1.23.0 (`9877d07`, after its stamp `48cc586`), 1.23.1 (`3bff36f`, its stamp "Release 1.23.1": a patch has no SBOM commit), 1.23.2 (`a45c716`, its stamp, "Release 1.23.2", likewise), 1.23.3 (`c02a261`, its stamp, "Release 1.23.3", likewise) and 1.23.4 (`598d08b`, its stamp, "Release 1.23.4", likewise; live on GitHub Pages) are released but not tagged. All fourteen go in **one** push (`git push origin v1.16.3 v1.16.4 v1.17.0 v1.17.1 v1.18.0 v1.19.0 v1.20.0 v1.21.0 v1.22.0 v1.23.0 v1.23.1 v1.23.2 v1.23.3 v1.23.4`), never an older one alone. [RELEASE-HANDOFF.md](RELEASE-HANDOFF.md) has the checks, the tag commands, the SHA-256 each release zip will have, what each tag's workflow runs will do, which runs to re-run with a `policy_exception`, and which `Web app` runs to approve or reject (only `v1.23.4`'s, which publishes 1.23.4, while `main` still says 1.23.4; reject any other). Then record each zip's SHA-256 in its release notes and in the CHANGELOG on `main`, the second channel SUDS Server's upgrades need. The SBOMs here describe `6491308`, `485548c`, `3dc20dc`, `66a616b`, `f58128c`, `74852e5` and the 1.23.0 stamp.
3. **Vulnerability disclosure.** `SECURITY.md` is in the repository. Turn on private vulnerability reporting (Settings → Code security → *Private vulnerability reporting*), and confirm the response targets it marks `[owner to confirm]`.
4. **Licence file.** `LICENSE` (MIT, "Copyright (c) 2026 The SUDS contributors") is in the repository; once a legal entity exists (item 5), the owner may name it as the holder.
5. **Organisation** `[owner to complete]`:
   - a legal entity, W-9 or Payee Data Record, and vendor registration;
   - insurance: general liability, tech E&O, cyber;
   - named support contacts, and the filled-in [SLA template](../market/templates/SUPPORT-SLA.md), reviewed by counsel.
6. **Counsel review.** The BAA and QSOA and the DPA drafts; instrument licensing (DAST-10, ASAM); the counseling-note rule and the shared-record model.
7. **Independent assurance.**
   - a penetration test against [PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md);
   - an independent code reviewer or second maintainer, and a named backup releaser;
   - an independent statistical review of the publication method;
   - a third-party accessibility review and screen-reader testing;
   - SOC 2, only if a hosted tier is ever offered.
8. **Release signing.** Sigstore signing or GitHub artifact attestations in the release workflow (a workflow change for the owner to approve).
9. **Installer run on real VMs.** `deploy/linux/install.sh` and `upgrade.sh` on a fresh Ubuntu 24.04 VM and a fresh RHEL 9 VM, recorded and committed back: [INSTALLER-VM-RUN.md](INSTALLER-VM-RUN.md). So far they have run in a fake root (tests) and, on Ubuntu only, in a systemd container ([1.19.0](installer-container-run-2026-09-30/README.md), [1.20.0](installer-container-run-2026-09-30-v1.20.0/README.md)).

**County:**

- key custody;
- volume encryption;
- WORM storage for audit anchors;
- a SIEM;
- a production recovery drill;
- the incident plan;
- per-user denies before the first sync, where least privilege is wanted.

## Producing this evidence again

| Evidence | Command |
| --- | --- |
| SBOM for a release | After the owner tags it: `node scripts/sbom.js --ref v<version> --out docs/evidence/sbom-<version>.cdx.json` (while a released version is untagged, as 1.16.4, 1.17.0, 1.19.0, 1.20.0, 1.21.0, 1.22.0 and 1.23.0 are, `--ref <stamp commit>`; the file records the full commit either way). One per minor line at least: `test/doc-currency.test.js` fails once a new minor is stamped without one. Commit the file on `main`: evidence follows the release, as the drill reports do. `test/sbom.test.js` checks the newest SBOM against its recorded commit wherever that commit is in the clone. In CI, that is once the tag exists, since the `test` job fetches the release tags |
| Recovery drill (development) | `node --no-warnings=ExperimentalWarning scripts/dr-exercise.js --clients 20000 --out docs/evidence/dr-drill-<date>`, from the released tree |
| Upgrade drill (development) | `node docs/evidence/upgrade-drill-2026-10-01-v1.23.0/upgrade-drill.js --from <older release tree> --to <new release tree> --clients 20000 --out <dir>`, each tree unpacked from its release commit ([its README](upgrade-drill-2026-10-01-v1.23.0/README.md)) |
| Installer run on a VM | [INSTALLER-VM-RUN.md](INSTALLER-VM-RUN.md) |
| Recovery drill (production, by the operator) | Settings → System & backups → *Run a recovery drill now*, or `npm run dr-drill -- --offsite --keys-file <escrowed keys.json>` |
| Audit export | Settings → Security status → *Download audit export*; verify with `npm run verify-audit-export -- <file> --public-key <key>.pem` |
| Live control status | Settings → Security status, or `GET /api/admin/security/status` |
| Test results for a commit | The CI run for that commit (`gh run list --workflow ci.yml --commit <sha>`) |
| A release zip's SHA-256, independently of the release page | `git archive --format=zip --prefix=suds-v<version>/ <tag or commit> -o suds-v<version>.zip && sha256sum suds-v<version>.zip` (what `release.yml` runs; [RELEASE-HANDOFF.md](RELEASE-HANDOFF.md)) |
| A compliance report (SUDS Server) | `sudo systemctl start suds-compliance`; verify with `npm run verify-compliance-report -- <report> --public-key /etc/suds/compliance-signing-key.pub.pem` |
| Fingerprint signature evidence | `GET /api/admin/signature-evidence?record_type=<type>&record_id=<id>`; verify with `npm run verify-passkey-evidence -- <file> --audit <audit export> --public-key <key>.pem` |

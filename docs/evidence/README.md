# Evidence index for county IT and procurement review

This page is for a county IT, security, privacy or procurement reviewer. Each common review question is mapped to the evidence that exists for it:

- the **document** that explains the control;
- the **test** that checks it (in `npm test` unless marked);
- the **CI job** that runs on every push (`.github/workflows/ci.yml`);
- the **artefact** a reviewer can take away.

**What is not here.** Nothing on this page is a certification, attestation or audit. SUDS has none of those ([../security/README.md](../security/README.md)). Items that are not in place are listed as **owner-pending** or **county**, not answered "yes".

**Version.** It describes 1.17.0, the stamp commit `485548c` ("Release 1.17.0", on `main`, and published to GitHub Pages by a direct `gh-pages` push at the owner's request); the owner has not tagged it yet ([../RELEASE.md](../RELEASE.md), *Record: 1.17.0*). The SBOM for 1.16.4 (`6491308`) stays in this folder for that release. (Until the review of the 1.17.0 candidate this page named `d95b69a`, an earlier "Release 1.16.4" commit that is not on `main`, whose CI failed, and that was never published.)

**Other ways in.** The same ground is covered question by question in [../security/QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md), and for buyers in [../market/BUYER-GUIDE-IT.md](../market/BUYER-GUIDE-IT.md).

## Artefacts in this folder

| File | What it is | How to check it |
| --- | --- | --- |
| [sbom-1.17.0.cdx.json](sbom-1.17.0.cdx.json) | CycloneDX 1.5 software bill of materials for 1.17.0. See *The SBOM*, below. Generated from the stamp commit, since the tag is not pushed yet | `node scripts/sbom.js --ref 485548c7b076954cdbf1ec4445335d7459662048` prints the same bytes, and `test/sbom.test.js` checks it |
| [sbom-1.16.4.cdx.json](sbom-1.16.4.cdx.json) | The SBOM for 1.16.4 | `node scripts/sbom.js --ref 6491308` prints the same bytes |
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
- **Tests:** `auth-permissions`, `role-expansion`, `user-permissions`, `deidentified-roles`, `mfa-grace`, `mfa-enrol-hardening`, `in-session-guessing`, `signer-hardening`, `oidc`, `oidc-reauth`, `idp-lifecycle`, `scim`, `security-1154` to `security-1164`, `security-1170`.
- **CI:** `test`; `browser` (`permissions-admin`, `signup`).
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
- **Artefact:** The drill reports above (development).
- **Status:** In place, and exercised in development only. **County:** a drill on the real deployment, run by its operator. Single instance; no automatic failover.

### Vulnerability management and supply chain

- **Documents:** [VULNERABILITY-MANAGEMENT.md](../security/VULNERABILITY-MANAGEMENT.md); the SBOM ([sbom-1.17.0.cdx.json](sbom-1.17.0.cdx.json)); `.github/dependabot.yml`.
- **Tests:** `sbom` (the server requires only Node built-ins; the committed SBOM equals a fresh run), `kernel-parity`.
- **CI:** `test` (the kernel and schema must match their sources); Node pinned by SHA-256.
- **Status:** The server has zero runtime npm packages, and the SBOM is published. **Owner-pending:** CodeQL and secret scanning (repository settings), private vulnerability reporting and a `SECURITY.md`, and a penetration test. SAST and DAST are not in CI.

### Secure development, change control and releases

- **Documents:** [SDLC.md](../security/SDLC.md); [../RELEASE.md](../RELEASE.md) (the gate, the policy, the owner settings); `.github/CODEOWNERS`.
- **Tests:** `release-gate`, `release-policy`, `release-existing`, `release-site-check`, `migrations`, `migration-order`.
- **CI:** Every push: `test`, `thorough`, `thorough-sdc`, `browser`, `node24` and `dr-drill` (the gate's `REQUIRED_JOBS`); `webkit` is advisory.
- **Status:** The gate is designed and enforced by the workflow. **Owner-pending:** the repository settings that make the approval and the tag rules binding (not in force); an independent reviewer (480 of 512 commits are AI-assisted); signed releases.

### Threat model and penetration testing

- **Documents:** [THREAT-MODEL.md](../security/THREAT-MODEL.md); [PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md).
- **Tests:** The security review suites named in the threat model's table of fixed classes.
- **Status:** The threat model is the project's own; no penetration test has been done. **Owner-pending:** commission a penetration test.

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

- **Documents:** `Dockerfile`, `docker-compose.yml`; [../DEPLOYMENT.md](../DEPLOYMENT.md), *Hardening checklist*.
- **CI:** `test` (packaging).
- **Status:** A non-root, read-only container. **County:** the host OS, patching and firewall.

### Support and vulnerability reporting

- **Documents:** [../SUPPORT.md](../SUPPORT.md); [../market/templates/SUPPORT-SLA.md](../market/templates/SUPPORT-SLA.md) (an owner template).
- **Status:** Channels today: the public issue tracker and private vulnerability reports. **Owner-pending:** a signed support agreement, contacts and a security address.

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
2. **Tag the released versions.** 1.16.3 (`fc5e9d7`), 1.16.4 (`6491308`) and 1.17.0 (`485548c`, live on GitHub Pages) are released but not tagged (HANDOFF.md, *Release waiting*; docs/RELEASE.md, *Record: 1.16.4 published without a tag*). All three go in **one** push, never 1.16.x alone, which would publish 1.16.4 over 1.17.0: `git fetch origin && git tag -a v1.16.3 fc5e9d7 -m "SUDS 1.16.3" && git tag -a v1.16.4 6491308 -m "SUDS 1.16.4" && git tag -a v1.17.0 485548c -m "SUDS 1.17.0" && git push origin v1.16.3 v1.16.4 v1.17.0`, then follow what RELEASE.md says each run does. The 1.16.4 SBOM describes `6491308`; the 1.17.0 SBOM describes `485548c`.
3. **Vulnerability disclosure.** Turn on private vulnerability reporting, add a `SECURITY.md`, and name a security contact `[owner to complete]`.
4. **Licence file.** `package.json` says MIT; add the `LICENSE` file `[owner to complete]`.
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
| SBOM for a release | After the owner tags it: `node scripts/sbom.js --ref v<version> --out docs/evidence/sbom-<version>.cdx.json` (while a released version is untagged, as 1.16.4 and 1.17.0 are, `--ref <stamp commit>`; the file records the full commit either way). Commit the file on `main`: evidence follows the release, as the drill reports do. `test/sbom.test.js` checks the newest SBOM against its recorded commit wherever that commit is in the clone. In CI, that is once the tag exists, since the `test` job fetches the release tags |
| Recovery drill (development) | `node --no-warnings=ExperimentalWarning scripts/dr-exercise.js --clients 20000 --out docs/evidence/dr-drill-<date>`, from the released tree |
| Recovery drill (production, by the operator) | Settings → System & backups → *Run a recovery drill now*, or `npm run dr-drill -- --offsite --keys-file <escrowed keys.json>` |
| Audit export | Settings → Security status → *Download audit export*; verify with `npm run verify-audit-export -- <file> --public-key <key>.pem` |
| Live control status | Settings → Security status, or `GET /api/admin/security/status` |
| Test results for a commit | The CI run for that commit (`gh run list --workflow ci.yml --commit <sha>`) |

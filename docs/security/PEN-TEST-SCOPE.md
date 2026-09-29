# Penetration test scope (template for a county-commissioned test)

The SUDS project has not commissioned an independent penetration test. This scope is written so a county can commission one against its own deployment and get results that are specific to how SUDS works.

## Target

* A **staging** installation of the release the county runs (never production PHI), seeded with fictional data (`npm run seed`), deployed exactly as production: same proxy, TLS, `SUDS_ENV=production`, same settings (MFA required, SSO if used, local mode as in production).
* One account per role (admin, supervisor, clinician, navigator, finance, readonly), plus two navigators with different caseloads held to them (per-user denies of `clients:all`, 1.16.0) and one with the role's defaults, an API key, and — if local mode will be enabled — a local-mode device.
* Source code access (white-box) is recommended; it is public.

## In scope

| Area | What to test | Reference |
| --- | --- | --- |
| Authentication | Password login, lockout and rate limits, TOTP enrolment and verification, MFA-deadline enforcement, session idle/absolute timeout, session fixation, cookie flags, CSRF header requirement | `server/auth.js`, `server/routes/auth.js` |
| SSO | OIDC flow: state/nonce/PKCE handling, ID-token validation (alg confusion, issuer/audience, expiry), account linking, SSO-required mode and emergency accounts | `server/oidc.js`, `server/routes/oidc.js` |
| Authorisation | Horizontal (another navigator's client, by id, through every client-scoped route, exports, timeline, documents, sync) and vertical (role escalation, admin routes, `audit:read`, `settings:manage`, break-glass bypass) | `server/auth.js` `PERMS`, `server/crud.js`, `server/routes/*` |
| Input handling | Injection (SQL, header, CSV/formula in exports, path traversal in uploads/static), XSS in every stored text field rendered back, JSON parsing, body-size limits, request smuggling behind the proxy | `server/validate.js`, `server/http.js`, `server/spreadsheet.js` |
| Disclosure controls | Referrals and identified exports without consent; de-identified exports leaking identifiers | `server/disclosure.js`, `server/exports.js` |
| Sync (if local mode enabled) | Pushing rows outside the caseload, editing another worker's records, altering signed notes/consents/court orders, lifting a legal hold, resurrecting deleted records, a push the REST route would refuse, revoked/wiped device handling | `server/routes/sync.js`, `server/rules/` (push.js and the per-table rules), `server/devices.js` |
| Audit integrity | Actions that avoid being audited; tampering with the audit table and whether verification and anchors detect it (given DB access in a separate, agreed phase) | `server/audit.js`, `server/audit-anchor.js` |
| Admin functions | Backup download/restore, recovery drill, audit export, network/TLS settings, API keys | `server/routes/admin.js`, `server/routes/security.js` |
| Transport | TLS configuration of the deployed proxy/app, HSTS, certificate handling | `Caddyfile`, `server/listener.js` |
| Host/container (optional) | Container escape surface, file permissions of `data/`, service hardening | `Dockerfile`, `../DEPLOYMENT.md` systemd unit |

### Classes fixed after the security reviews of 1.16.0 and 1.16.1 (confirm them)

These were found by the project's own reviews and fixed in 1.16.1 and 1.16.2 (CHANGELOG, *Security*). Test that
they stay fixed rather than rediscovering them; each has API tests in `test/`.

| Class | What to try | Reference |
| --- | --- | --- |
| Stored-file serving | Upload or sync a resource photo, form attachment or document whose declared type is `text/html`, SVG or script, or whose bytes are not what its type says; check every stored file is served with `nosniff`, a `Content-Disposition`, `Cross-Origin-Resource-Policy: same-origin` and a sandbox CSP, never as a page of the app's origin | `server/routes/resources.js`, `server/routes/forms.js`, `server/routes/sync.js` |
| Sync attribution and column smuggling | Push rows that name another worker as creator or discloser (`created_by`, `disclosed_by`, `given_by`, `recorded_by`, `opened_by`, `uploaded_by`), or carry columns the table's rules do not declare; neither may be stored as sent | `server/rules/push.js`, `server/rules/*` |
| Separation of duties | Record or change spending or time under a colleague's name (REST or sync), then approve it as the same account | `server/routes/budget.js`, `server/routes/time.js` |
| SUD counseling-note access | Read a counseling note as a navigator, through break-glass, and through sync (the note and its addenda, and a device that held them before) | `server/rules/notes.js`, `server/routes/notes.js`, `server/routes/sync.js` |
| Note signatures via sync | Sign, co-sign or change a signed note, or ask for a review of another worker's signed note, from a device, where the REST routes would refuse it | `server/rules/notes.js`, `server/rules/note_addenda.js` |
| Client-change notices | As someone off a client's care team, change the client and then edit, complete or delete the notice the primary worker receives | `server/rules/clients.js`, `server/rules/tasks.js` |

## Out of scope

* Denial-of-service beyond verifying rate limits and body caps (single-instance by design).
* The county identity provider itself, Microsoft Graph, GitHub Pages hosting, and physical security.
* Social engineering of county staff (unless the county adds it).

## Rules of engagement

* Test window agreed with county IT; staging only; no real PHI.
* Testers get a copy of the audit export before and after, to confirm their actions were recorded.
* Findings rated with CVSS v3.1/v4; critical/high reported immediately to the county's security officer and the SUDS code owner; fixes verified by retest.

## Deliverables

Executive summary; findings with reproduction steps and affected files; evidence that authorisation tests covered every route listed in `../API.md`; retest letter.

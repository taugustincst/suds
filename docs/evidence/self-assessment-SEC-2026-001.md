# Internal self-assessment SEC-2026-001 (SUDS 1.25.6)

> **This is the vendor's own internal self-assessment of its own product. It is not an independent penetration
> test and must never be presented as one.** AugustInnovations LLC ran it; its security practice is the licensor
> itself. The independent test is still owed ([../market/templates/PEN-TEST-RFP.md](../market/templates/PEN-TEST-RFP.md)).

| | |
| --- | --- |
| Target | SUDS 1.25.6 (tag `v1.25.6`, `f23a94e7`), office server, bound to 127.0.0.1 only, development mode, the product's fictional seed data |
| Date | 2026-10-12 |
| Method | OWASP WSTG, gray-box (source-assisted); one account per seeded role plus a caseload-held probe account |
| Result | **0 critical, 0 high, 0 medium; 1 low; 2 informational** |

## What was tested, and the result

| Area | Result |
| --- | --- |
| Recon and configuration: sensitive files, headers, CSP, error responses | Pass |
| Authentication and session: enumeration parity, lockout, the MFA deadline, TOTP replay, the temporary-password gate, CSRF, logout revocation | Pass |
| Role matrix and IDOR: all seven roles, masked lists, de-identified exports, caseload scoping, malformed IDs | Pass |
| 42 CFR Part 2 disclosure gate: recipient and purpose not covered, expired consent, override without permission, a positive control, revocation | Pass |
| Input handling: SQL and NoSQL injection, type confusion, content-sniffed uploads | Pass (F-02, informational) |
| Audit-chain integrity: append-only triggers, keyed chain detecting a forged row, anchors outside the database | Pass with F-01 (low) |

**Not tested:** a browser render of stored markup; the import commit path; CSV formula injection in exports; business
logic beyond the battery; passkeys; single sign-on; TLS (no TLS listener in the local instance); the idle and
absolute session expiries were checked in code only.

## Findings and what was done

| Id | Severity | Finding | Fix (after 1.25.7; CHANGELOG *Unreleased*) |
| --- | --- | --- | --- |
| F-01 | Low | Deleting the newest audit entries went undetected until a checkpoint sealed a newer head; a new or short-lived instance had a window | The head also advances every 500 entries and at a graceful stop (with an anchor), and never over a truncated chain (`server/audit.js` `advanceHead`; `test/sec-2026-001.test.js`, `test/audit-head-at-start.test.js`) |
| F-02 | Informational | Markup stored verbatim in client names; no execution path found | Names containing `<` or `>` are refused on create and edit, by the office server and in sync (`server/rules/clients.js`) |
| F-03 | Informational | The session cookie's Secure flag depends on the configuration | Security status reports it, with compliance check `app.session_cookie` |

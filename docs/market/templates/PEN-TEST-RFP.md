# Request for proposal: independent penetration test of SUDS

> **DRAFT — a vendor-neutral template to be completed before it is sent; it names no vendor.** Every `[BRACKET]` is for
> the owner to fill in outside this public repository. The scope is
> [../../security/PEN-TEST-SCOPE.md](../../security/PEN-TEST-SCOPE.md); this RFP must not contradict it. The owner's
> business assistant holds an owner-side RFP with a vendor shortlist (HANDOFF, 2026-10-06 and 2026-10-10): **that one
> is sent once the owner approves**, and this page is the public scope reference it is checked against. Item 3 of
> [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md).

**Issued by:** `[LICENSOR LEGAL ENTITY]`, the licensor of SUDS. **Contact:** `[CONTACT EMAIL]`.
**Issued:** `[DATE]`. **Questions by:** `[DATE]`. **Proposals by:** `[DATE]`. **Decision by:** `[DATE]`.

## 1. Background

SUDS is case-management software for California substance-use-disorder and harm-reduction programmes. It holds
protected health information and 42 CFR Part 2 records, so its buyers (counties and community-based organisations)
ask for an **independent** penetration test before they approve it. Two earlier tests were owner-authorised and run by
the vendor's own development assistant, and are not independent: a white-box test of 1.23.6, and a black-box test with
a code review of the live install on 2026-10-08
([../../evidence/pentest-suds-systems-2026-10-08.md](../../evidence/pentest-suds-systems-2026-10-08.md)). This test
replaces neither county's own right to test; it gives buyers a third party's report and retest letter.

The source is public (<https://github.com/taugustincst/suds>); the architecture, threat model and data inventory are in
[../../security/](../../security/README.md). The office server is a single Node.js 22 process with SQLite, zero runtime
npm packages, served behind Caddy; "SUDS on this device" is the same app running in the browser with a WebAssembly
SQLite and an encrypted on-device store.

## 2. Scope

As [../../security/PEN-TEST-SCOPE.md](../../security/PEN-TEST-SCOPE.md) *In scope*, in particular:

- **Web application and API** of the office server: authentication (password, TOTP, passkeys, SSO if configured),
  session handling, authorisation (horizontal and vertical, across every route in [../../API.md](../../API.md)), input
  handling, the disclosure and consent controls, audit integrity, administrative functions, file uploads and exports.
- **Sync** between a device and the office (local mode switched on for the test).
- **SUDS on this device** (the GitHub Pages build): on a copy published for the test, or read-only against the public
  one; the sealed device store and device backups.
- **The county surfaces** the scope lists (submissions, the connection, publication releases), switched on for the
  test.
- **The host**, optionally: a SUDS Server staging VM installed with `deploy/linux/install.sh` (firewall, the service
  sandbox, keys as systemd credentials, the weekly compliance check), and optionally the Windows server zip on a
  staging Windows Server VM.
- **Out of scope:** as the scope document says (denial of service beyond rate limits, the identity provider, GitHub's
  hosting, physical security, social engineering), plus `[ANY ADDITION]`.

## 3. Environments

| Environment | What it is | Provided by |
| --- | --- | --- |
| Staging office server | The latest SUDS release on a VM like a county's, `SUDS_ENV=production`, HTTPS, MFA required, fictional data (`npm run seed`), one account per role plus two caseload-held navigators, an API key, local mode on | `[LICENSOR / VENDOR]` |
| Staging SUDS Server host (optional) | A VM installed with the SUDS Server installer, with its compliance report | `[LICENSOR]` |
| SUDS on this device | A copy of the published build at a test address, or the official address read-only | `[LICENSOR]` |
| Windows server (optional) | The release's Windows zip on a staging Windows Server VM | `[LICENSOR / VENDOR]` |

**Never production data.** No real client record is used. Testing of the licensor's own production install
(suds.systems), which holds fictional data only, is `[IN / OUT OF]` scope.

## 4. Rules of engagement

- A written authorisation signed by the licensor before testing, naming the environments, addresses and window.
- Test window: `[DATES, HOURS, TIME ZONE]`. Staging only; no real data.
- Testers receive the audit export before and after, to confirm their actions were recorded.
- Critical and high findings are reported **at once**, privately, to `[SECURITY CONTACT]` (and never in a public
  issue); the rest in the report.
- No denial-of-service beyond verifying rate limits and body caps; no social engineering; no testing of third parties.
- Data handling: the vendor keeps test data and findings confidential, deletes them `[N]` days after the retest, and
  does not publish without the licensor's written consent.

## 5. Deliverables

1. An executive summary a county reviewer can read.
2. Findings, each with a severity rated with **CVSS v3.1 or v4.0** (vector string included), affected component and
   files, reproduction steps and evidence, and a recommended fix.
3. Evidence that authorisation testing covered every route in [../../API.md](../../API.md) (a coverage table).
4. A **retest** of every critical, high and medium finding after fixes, within `[N]` weeks of being told they are
   released, and a **retest letter** (or attestation) the licensor may share with buyers.
5. A short methodology statement (standards followed, tools, white-box or grey-box).

## 6. Timeline

| Milestone | Date |
| --- | --- |
| Kick-off and authorisation | `[DATE]` |
| Testing window | `[DATES]` |
| Draft report | within `[N]` business days of the window |
| Fixes released by the licensor | `[TARGET]` |
| Retest and letter | within `[N]` weeks of the fixes |

## 7. What the proposal must include

- **Price:** fixed price for the scope, the optional host and Windows items priced separately, and the retest included
  or priced.
- **Methodology:** the standard followed (for example OWASP WSTG, ASVS, PTES or NIST SP 800-115), white-box use of the
  source, and how authorisation coverage is shown.
- **A sample report** (redacted) and a sample retest letter.
- **Tester qualifications:** the people who will test, their relevant certifications and experience with healthcare,
  web applications and Node.js; whether any work is subcontracted.
- **Insurance:** professional liability and cyber liability held by the vendor, with limits.
- **Confidentiality and data handling:** where findings are stored and for how long; willingness to sign the licensor's
  confidentiality terms (and a business associate agreement if the vendor's view is that one is needed; none should be,
  with fictional data only).
- **Independence:** confirmation that the firm has no business relationship with the licensor beyond this test.
- **Availability:** earliest start date and the window length.
- **References:** two healthcare or public-sector clients, if they allow it.

## 8. Evaluation

| Criterion | Weight |
| --- | --- |
| Methodology and coverage of the scope (authorisation across every route, the device store, sync, the county surfaces) | 30% |
| Quality of the sample report and retest letter (clear severity, reproduction, fixes; usable by a county reviewer) | 20% |
| Tester qualifications and healthcare / web-application experience | 20% |
| Price, including the retest | 20% |
| Insurance, confidentiality terms and availability | 10% |

A proposal without a sample report, a retest, or the vendor's insurance is not considered.

## 9. Recording the result

The tester's summary and retest letter (as the tester allows) are stored in `docs/evidence/` with the date and release
tested; findings become issues (private for anything unfixed); QUESTIONNAIRE #38, the threat model and
[../HOSTING.md](../HOSTING.md) item 8 are updated ([../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md), item 3).

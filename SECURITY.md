# Security policy

SUDS holds health and substance-use treatment records (HIPAA, 42 CFR Part 2). Please report a vulnerability
privately, as below, and never in a public issue, a pull request or a discussion.

## Supported versions

The latest minor line gets every fix; the previous minor line gets security fixes for 30 days after the next minor
is released; older lines get nothing. Which lines those are today, and the exact rule, are in
[docs/RELEASE.md](docs/RELEASE.md), *Supported versions*. A security fix ships as a patch release with an *Advisory*
note in its CHANGELOG section and a GitHub Security Advisory naming the affected versions. The project has one
maintainer, and a release waits for the owner to tag it: this is a best-effort commitment, not a contractual SLA.

## How to report

Use **GitHub's private vulnerability reporting** for this repository: the **Security** tab → **Report a
vulnerability** (<https://github.com/taugustincst/suds/security/advisories/new>). Only the repository's maintainers
see the report. If your programme has a signed support agreement, you may also use the security contact it names.

If the **Report a vulnerability** button is missing, private reporting has not been switched on yet (an owner
setting); open a public issue titled only "Security contact request", **with no details**, and the maintainer will
arrange a private channel.

## What to include

- the SUDS version (the footer, or `version.json`) and how it runs: office server (wizard, Docker or SUDS Server),
  or SUDS on this device (the GitHub Pages build);
- the component and the route, page or file involved;
- the steps to reproduce, and what an attacker gains (read, change, sign-in bypass, escalation, audit tampering);
- the role or permissions the attacker needs, and whether local mode, single sign-on, the county connection or
  fingerprint sign-in must be on;
- a proof of concept against **fictional data** (`npm run seed` makes some), if you have one.

**Never send real PHI**: no client names, dates of birth, notes, screenshots of real records, database files,
backups or audit exports from a live programme. Describe the data instead, or reproduce it on seeded data.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of the report | `[owner to confirm]` business days |
| First assessment (confirmed or not, severity) | `[owner to confirm]` business days |
| Fix released for a confirmed critical or high issue | `[owner to confirm]` days |
| Fix released for a confirmed medium or low issue | `[owner to confirm]` days, or in the next release |

These targets are placeholders until the owner confirms them. Please give us a reasonable time to release a fix
before disclosing; we will credit you in the advisory unless you ask us not to. There is no bug bounty.

## Scope

In scope, in the code of this repository:

- **the office server** (`server/`, the web app in `public/`): sign-in, sessions, two-step verification, single
  sign-on and SCIM, permissions and caseload scoping, disclosures and exports, sync to local-mode devices, the audit
  log, backups and restore;
- **SUDS on this device**, the GitHub Pages build (`scripts/build-static-site.js`, `local/`): the device vault,
  device accounts and backups;
- **the SUDS Server installer** (`deploy/linux/`) and its compliance check (`scripts/compliance-check.js`,
  `scripts/verify-compliance-report.js`);
- **the county view and county connection** (`server/county*.js`, `server/routes/county*.js`), on both the
  programme's and the county's server;
- **passkeys** (fingerprint sign-in, authorization and signing: `server/webauthn.js`, `server/passkeys.js`,
  `scripts/verify-passkey-evidence.js`);
- the release machinery (`.github/workflows/`, `scripts/release-*.js`).

Out of scope: a county's or programme's own deployment choices (its proxy, firewall, identity provider, storage),
and denial of service by sheer volume. (An administrator reaching clinical content without break-glass, or any
account doing more than its permissions allow, is in scope.) Testing against someone else's live installation needs that programme's written
permission; test your own staging copy instead.

A county commissioning its own penetration test can start from [docs/security/PEN-TEST-SCOPE.md](docs/security/PEN-TEST-SCOPE.md).
How the project handles dependencies and fixes is in
[docs/security/VULNERABILITY-MANAGEMENT.md](docs/security/VULNERABILITY-MANAGEMENT.md); other support channels are in
[docs/SUPPORT.md](docs/SUPPORT.md).

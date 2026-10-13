# Getting help with SUDS

This page lists the support channels that exist today and what each one promises. It also says what does not exist yet.

The same channels are named in:

- the accessibility statement ([accessibility/STATEMENT.md](accessibility/STATEMENT.md));
- the refusal message of a publication release (`server/release-audit.js`);
- the IT buyer guide and the security questionnaire.

## Where to go, in order

| Who | For what | How |
| --- | --- | --- |
| **1. Your programme's SUDS administrator** | Accounts, passwords, two-step verification, permissions, settings, lists, anything about your own records | In person. The programme contact your county or programme set up is shown at the foot of the SUDS sign-in page and on its Accessibility page |
| **2. Whoever runs your server**: your IT partner or county IT, or, for a vendor-hosted programme, AugustInnovations LLC | The server being down, backups and restores, certificates, sign-in through your identity provider, upgrades, a lost or stolen device | Your programme's own IT arrangement for a self-hosted office server. For a vendor-hosted one (offered from October 2026; no customer is hosted yet), the vendor runs it, by email in business hours ([market/HOSTING.md](market/HOSTING.md)) |
| **3. The SUDS project's public issue tracker** | Defects, questions about how SUDS works, accessibility barriers (title them "Accessibility:"), a publication period SUDS refused, suggestions | <https://github.com/taugustincst/suds/issues>. **Never include client information**: no names, dates of birth, notes or screenshots of records. Give the version (shown in the footer), the page, what you did and what happened. Anyone can read the tracker. If you cannot use GitHub, ask your administrator to file it for you |
| **4. Security vulnerabilities**: privately, never in a public issue | A way to read or change data you should not be able to, bypass sign-in, or tamper with the audit log or a release | GitHub private vulnerability reporting on the repository (on since 2026-10-12: **Security → Report a vulnerability**), or the maintainer contact in your support agreement. Without a GitHub account, the owner-published security contact (**owner-pending**); never a public issue with details. How to report, what to include and the scope are in [SECURITY.md](../SECURITY.md); see also [security/VULNERABILITY-MANAGEMENT.md](security/VULNERABILITY-MANAGEMENT.md). Never send real client information |

## What each channel promises

- **Accessibility reports** (channel 3). The accessibility statement sets targets: acknowledgement within 2 business days, and a fix or workaround within 10 business days. A barrier that stops someone doing their job is treated as release-blocking ([accessibility/STATEMENT.md](accessibility/STATEMENT.md)).
- **Security reports** (channel 4). They are fixed in a security release and announced as a GitHub Security Advisory with the affected versions ([RELEASE.md](RELEASE.md), *Supported versions*).
  - **A security release waits for the owner to tag it.** No backup releaser is named today.
  - This is a best-effort commitment from a project with one maintainer, not a contractual SLA.
- **Everything else in the issue tracker** is best effort. There are no response-time commitments.
- **Contracted support** exists only under a signed agreement. The published paid plans include email support with a response within 2 business days (`public/procurement.json`). [market/templates/SUPPORT-SLA.md](market/templates/SUPPORT-SLA.md) is a **template for the owner and counsel to complete**: its hours, channels, contacts and other targets are placeholders until an agreement fills them in. No such agreement exists today.

## What is not offered

- **No 24×7 support, no phone line and no vendor on-call.** Out of hours, the operator restores service with the runbooks in [security/BACKUP-AND-DR.md](security/BACKUP-AND-DR.md) and [DEPLOYMENT.md](DEPLOYMENT.md). For a vendor-hosted programme the operator is the vendor, which is one person and works business hours.
- **No uptime commitment**: none for office servers on customer infrastructure, and none is published for hosted plans. Vendor hosting itself is offered from October 2026 (one isolated instance per customer), but no customer is hosted yet and the fleet's first real drill has not been run ([market/HOSTING.md](market/HOSTING.md)).
- **No vendor access to a self-hosted server or its data** unless you grant it. Granting it needs a BAA and a Part 2 QSOA first; a vendor-hosted programme signs both before its first real record ([security/QUESTIONNAIRE.md](security/QUESTIONNAIRE.md) #4).

## Staying informed

**Releases.** Watch the repository's releases (**Watch → Custom → Releases** on GitHub). Every release has a CHANGELOG section. Security fixes carry an *Advisory* note naming the affected versions.

**Which versions get fixes.** See [RELEASE.md](RELEASE.md), *Supported versions*:

- the latest minor line gets every fix;
- the previous minor line gets security fixes for 30 days.

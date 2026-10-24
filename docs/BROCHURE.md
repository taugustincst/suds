# SUDS: outreach, harm reduction and Part 2 privacy, in one place

**For** community-based organisations and county programmes doing street outreach, harm reduction, naloxone and
test-strip distribution, and SUD navigation, and for the county and settlement funders who pay for that work.
**From** AugustInnovations LLC, California. **Version 1.26.0** (October 2026).

## What it does

| Your team needs to | SUDS gives it |
| --- | --- |
| Log outreach where it happens | A one-handed phone screen for named or anonymous contacts. It works offline where the programme allows it, and records a participant code instead of a name if you prefer. |
| Keep supplies straight | Naloxone, test strips, syringes and other supplies tracked by site and lot with expiry dates. Contacts draw stock down, oldest lot first, and expiring lots are flagged. |
| Protect Part 2 records | Consents that name the recipient, one gate for every disclosure with an accounting of disclosures, encryption of client identifiers and free text, and an audit log that shows tampering. |
| Report to funders without retyping | Funder reports, an NDP-style naloxone log, a syringe services summary, and opioid-settlement spending and outcomes by fund. A county can receive each programme's signed aggregate file and see every funded programme side by side. No client records leave the programme. |
| Run the programme | Clients, referrals with loop closure, to-dos, notes with signatures, staff time and budgets with approvals, and a verified resource directory. Policies the county keeps in PowerDMS, with each person's sign-offs read from its report. |
| Work beside an EHR, or without one | An optional Part 2 module beside the EHR, a FHIR R4 read API, and CalOMS Tx capture with code sets verified against the DHCS data dictionary. SUDS is not an EHR and does not bill Drug Medi-Cal. |

## Three ways to use it

| | **SUDS on this device** | **Hosted by us** | **Your own server** |
| --- | --- | --- | --- |
| What | The web app at its official address, https://taugustincst.github.io/suds/. Records are encrypted and stay in that browser, on that device. | Your own isolated instance, with its own database and encryption keys, run by AugustInnovations LLC. | The office server on your Linux VM, Windows server or container. Staff use it from any browser. |
| For | One worker, or a few sharing one device. | A programme or county without IT staff to run a server. | A county or programme with its own IT. |
| Price | **Free** for real use | Included in the plans below | The plans below, plus your own infrastructure |

## Plans (USD)

| Plan | Price | Covers |
| --- | --- | --- |
| **90-day pilot** | **$9,500** flat, credited in full toward year one | One programme site; onboarding, the BAA and QSOA, CalOMS code-set validation, file layout confirmed with your county |
| **Program** | **$24,500** a year | One site, up to 30 staff accounts; hosting, updates, email support |
| **Multi-Site** | **$49,500** a year | Up to 5 sites and 150 staff accounts; plus onboarding help |
| **County-Wide** | **$98,000** a year | Unlimited sites and staff within one county; plus training and a named support contact |

Paid plans include email support with a reply within 2 business days. The pilot and Program prices sit
below many California counties' informal purchasing limits. A county can sponsor its grantees' pilots, for example from opioid-settlement funds; the county's
counsel decides which settlement category applies.

## Why SUDS

- **Built for the work, not adapted from an EHR.** It records an anonymous street contact in seconds, with no
  treatment-centred screens in the way.
- **Privacy is part of the design.** Every disclosure goes through one consent check and is written to the accounting
  of disclosures, and every read and write of protected information is audited.
- **It reports to the money.** Settlement outcomes by fund, with what was spent beside them, and a county view built
  from signed, exact files.
- **A small, checkable supply chain.** No third-party packages on the server, a software bill of materials with
  every release, and source code that buyers can review.
- **It works on a phone,** online or offline, and is built to WCAG 2.1 AA: an automated check of every screen runs on
  every code change, and the conformance report is published.

## Where things stand (October 2026)

SUDS is new. No customer runs it yet and no customer is hosted yet. The agreements (licence, BAA and QSOA, DPA, SLA)
are drafts that counsel has not yet reviewed. No independent penetration test has been done yet; the vendor's own tests
are published and labelled as the vendor's. There is no SOC 2 or other certification. CalOMS Tx code sets are verified
against the DHCS dictionary; the upload file layout is confirmed with your county during a pilot, and your county or
provider submits the file: SUDS sends nothing to DHCS. The security
questionnaire answers each of these in detail.

## Next steps

1. **Try it free**, today, at https://taugustincst.github.io/suds/ (on fictional records first, if you like).
2. **Read the specifics:** the [technical specifications](TECH-SPECS.md), the
   [security questionnaire](security/QUESTIONNAIRE.md), and the guides for
   [programme managers](market/BUYER-GUIDE-PROGRAM.md) and [IT](market/BUYER-GUIDE-IT.md).
3. **Talk to us:** Licensing, AugustInnovations LLC, **info@suds.systems**, https://sudsdata.com/#pilot.
   Security reports go to security@suds.systems.

*SUDS is proprietary software of AugustInnovations LLC ([LICENSE](../LICENSE)). SUDS on this device is free for real use
at its official address. The office server runs under a signed licence agreement after a 90-day evaluation with
fictional data. SUDS supports HIPAA and 42 CFR Part 2 compliance; it does not provide compliance by itself.*

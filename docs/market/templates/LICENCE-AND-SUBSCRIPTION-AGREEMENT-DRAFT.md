# SUDS Licence and Subscription Agreement

> **DRAFT — for review by counsel before use; not legal advice.** This is the owner's starting text for the
> "separate written licence agreement signed by the copyright holder" that [`LICENSE`](../../../LICENSE) section 3
> requires for every use beyond SUDS on this device and the 90-day evaluation. No customer has signed it, no counsel
> has reviewed it, and it is not an offer. Every `[[…]]` is a placeholder for the parties (and their counsel) to
> complete; where one shows a value, that value is only a suggestion. Drafting notes in *italics* are guidance for
> the parties and are deleted before signature. A county or public agency will usually require its own contract
> form: then this text is a list of the terms SUDS needs, to be carried into that form.
>
> It is written to match what is published today: the licence ([`LICENSE`](../../../LICENSE)), the introductory
> tiers and support terms on the procurement page ([`public/procurement.json`](../../../public/procurement.json)),
> the support template ([SUPPORT-SLA.md](SUPPORT-SLA.md)) and the hosting page ([../HOSTING.md](../HOSTING.md)). Where
> they change, change this text with them.

**This Agreement** is made on `[[Effective Date]]` between:

- **AugustInnovations LLC**, a `[[state of formation]]` limited liability company, `[[address]]` ("**Licensor**"),
  the copyright holder and licensor of SUDS and, for the Hosted Service, its operator; and
- `[[Customer legal name]]`, `[[type of entity, e.g. California nonprofit public benefit corporation / County of …]]`,
  `[[address]]` ("**Customer**").

## 1. Definitions

1.1 **"Software"** means SUDS (SUD Navigator Services Tracker): the office server, the web app it serves, the
Windows server zip, their documentation and every update Licensor makes available under this Agreement, in the
versions Licensor publishes at its official repository and releases. It excludes the third-party components listed
in the `NOTICE` file, which keep their own licences (`LICENSE` section 5).

1.2 **"Office Server Licence"** means Customer running the Software on infrastructure Customer (or its IT partner or
county) controls, under section 2.

1.3 **"Hosted Service"** means Licensor running a separate instance of the Software for Customer, under section 3.

1.4 **"Plan"** means the tier chosen in the Order Form (Exhibit A): the 90-day Pilot, Program, Multi-site or
County-wide.

1.5 **"Customer Data"** means every record Customer, its staff or its clients enter into, import into or generate
with the Software, including protected health information ("**PHI**", 45 CFR 160.103) and records covered by
42 CFR Part 2 ("**Part 2 records**").

1.6 **"Authorised Users"** means Customer's staff, volunteers and contractors to whom Customer gives a SUDS account,
within the Plan's limits.

1.7 **"Documentation"** means the documents in the Software's repository under `docs/` for the version in use.

## 2. Office Server Licence

2.1 **Grant.** Subject to this Agreement and payment of the fees, Licensor grants Customer a non-exclusive,
non-transferable, non-sublicensable licence, for the Term, to install and run the Software on infrastructure
Customer controls, and to let Authorised Users use it, solely for Customer's own programme operations at the sites
and within the staff-account limits of its Plan, with real client records including PHI and Part 2 records.

2.2 **Copies.** Customer may keep the copies reasonably needed for that use: one production installation per
`[[site / programme]]`, a staging or test installation, and backups and disaster-recovery copies.

2.3 **Restrictions.** Except as the Order Form expressly allows, Customer will not: modify the Software or create
derivative works of it; copy or redistribute it to anyone else; sublicense, sell, rent or lend it; offer it, or its
functionality, as a hosted or managed service to others; remove or hide any notice in it; or circumvent this
Agreement (`LICENSE` sections 3 and 4). Seeing, reading or downloading the source code gives no further rights.
`[[If Customer, its county or its IT partner is to make configuration changes beyond the Software's own settings, or
any code change, list them here.]]`

2.4 **Who runs it.** Under an Office Server Licence, Customer (or its IT partner or county) operates the server:
patching, backups, keys, monitoring, certificates and uptime are Customer's (../HOSTING.md, models A and B).
Licensor does not access Customer's production system or its backups unless Customer grants support access under
section 6.4.

2.5 **SUDS on this device.** Nothing in this Agreement limits anyone's right under `LICENSE` section 2A to use SUDS on
this device, free, at its official address.

## 3. Hosted Service

> *Drafting note: on `[[date of this draft: 2026-10-10]]` the Hosted Service is **not offered** (../HOSTING.md, "Before
> the vendor-hosted tier can be offered"). Licensor has decided that it, AugustInnovations LLC, will be the operator and
> will sign the BAAs and QSOAs; the provisioning tooling exists (`deploy/fleet/`) but has not yet been run against real
> infrastructure, the hosted price is not set, and insurance, on-call and counsel review are not in place. Delete this
> section from any agreement signed before the Hosted Service is offered.*

3.1 **The service.** Licensor will provide Customer with a single-tenant instance of the Software: a virtual machine
of its own, with its own disks, database, encryption keys and web address, in `[[US cloud region(s)]]`, operated by
Licensor under its cloud provider's business associate addendum. It is not shared with any other customer.

3.2 **What isolation means.** Each customer's instance is separate from every other customer's. It is not separate
from Licensor: Licensor's administrators hold administrative access to the instance and an escrowed copy of its
encryption keys, which they use only as this Agreement and Exhibits B and C allow; every use of the escrow is logged.
Licensor does not describe the Hosted Service as "zero-knowledge" or "end-to-end encrypted".

3.3 **Before any real record.** Customer will not enter or import any real client record, and Licensor will not
accept one, until: (a) Exhibit B (Business Associate Agreement) and Exhibit C (Qualified Service Organization
Agreement) are signed; (b) the instance's data volume is encrypted at rest; and (c) Licensor has given Customer the
instance's first administrator account and its first recovery-drill result.

3.4 **Licensor's operation.** Licensor will install releases (security releases promptly, other releases on a
schedule agreed with Customer), keep encrypted backups `[[frequency]]` with `[[N]]` days kept and a copy outside the
instance's availability zone, run a recovery drill `[[monthly]]` and share the result, and monitor health, disk,
certificate and backup age, all as Exhibit D states.

3.5 **Customer's part.** Customer administers its own users and settings in the app, keeps its accounts' credentials
and second factors secure, and tells Licensor promptly of any suspected compromise.

## 4. Plans, the pilot and fees

4.1 **Plans.** The Plans and their introductory prices, as published by Licensor on `[[date]]` (USD; excluding
Customer's own infrastructure for an Office Server Licence):

| Plan | Price | Scope |
| --- | --- | --- |
| **90-day Pilot** | $2,500 flat | A single programme site. Onboarding, the Business Associate Agreement, and CalOMS code-set validation against the DHCS dictionary included; the CalOMS file layout confirmed with Customer's county. Credited in full toward the first annual Plan |
| **Program** | $4,800 a year | A single site, up to 30 staff accounts. The Business Associate Agreement, all updates and email support included |
| **Multi-site** | $12,000 a year | Up to 5 sites and 150 staff accounts. Everything in Program, plus onboarding assistance |
| **County-wide** | `[[custom annual price]]` | Unlimited sites and staff. Onboarding, training and a named support contact |
| **Hosted Service** (if offered) | `[[annual price per instance, in addition to the Plan]]` | Section 3 |

*Drafting note: the Business Associate Agreement the published tiers include is Exhibit B; a Part 2 programme also
needs Exhibit C. For an Office Server Licence, Licensor needs them only if it will have access to Customer Data
(section 6.4); counsel decides.*

4.2 **The Pilot.** The Pilot runs for 90 days from `[[start date]]`, at one site, with real records only once
section 3.3 (Hosted Service) or section 6.4 (support access) is satisfied where it applies. Its fee is credited in full
against the first annual Plan if Customer signs it `[[within 30 days after the Pilot ends]]`. If Customer does not
continue, section 9 (export) applies and the Pilot ends without further fee.

4.3 **Invoicing and payment.** Fees are invoiced `[[annually in advance / at signature for the Pilot]]` and due
`[[30]]` days from the invoice date, in US dollars, by `[[method]]`. Fees exclude taxes, which Customer pays where
they apply (other than taxes on Licensor's income).

4.4 **Changes.** Licensor may change a Plan's price for a renewal Term by giving `[[60]]` days' written notice before
the renewal. Prices do not change during a Term.

4.5 **Staff accounts and sites.** If Customer exceeds its Plan's limits, the parties will agree a move to the next
Plan `[[pro rata for the rest of the Term]]`; Licensor will not disable accounts for exceeding a limit.

## 5. Updates and supported versions

5.1 Paid Plans include every update Licensor releases during the Term.

5.2 Licensor fixes security issues in the current minor release line and, for 30 days after a new minor release, in
the previous one (docs/RELEASE.md, *Supported versions*). Customer is responsible for installing updates on an Office
Server Licence; Licensor installs them on the Hosted Service.

5.3 Each release is published with its source-zip checksum, recorded before the release is tagged, and a software
bill of materials. Customer verifies a release's checksum before installing it (docs/SELF-HOSTING.md, *Upgrading*).

## 6. Support and service levels

6.1 **Published terms.** Paid Plans include email support with a response within 2 business days. Security fixes ship
as patches as soon as they are verified. No uptime commitment is made for office servers running on Customer's
infrastructure. The SUDS on this device build is provided as-is. (These are the terms on the procurement page on
`[[date]]`.)

6.2 **Detail.** Support hours, severities, contacts and the Hosted Service's targets are in Exhibit D (from
[SUPPORT-SLA.md](SUPPORT-SLA.md)). Where Exhibit D and section 6.1 differ, `[[the more favourable to Customer]]`
applies. Licensor makes no after-hours or uptime commitment it cannot staff; any such commitment must be written into
Exhibit D with the people who will meet it.

6.3 **County-wide.** County-wide includes a named support contact: `[[name, role, email]]`.

6.4 **Support access to an office server.** Licensor's staff access Customer's production system or its backups only
when Customer grants it for a ticket, through an individual, two-step-verified, time-limited account that the
Software's audit log records, and only with Exhibits B and C signed.

## 7. Customer Data

7.1 **Ownership.** Customer owns Customer Data. As between the parties, Licensor acquires no right, title or interest
in it, except the limited right to process it to provide the Hosted Service or support, as this Agreement and
Exhibits B and C allow.

7.2 **No other use.** Licensor will not sell Customer Data, use it for marketing, use it to train or improve any
machine-learning or AI model, or disclose it except as Exhibits B and C allow. `[[Licensor may / may not]]` use
de-identified, aggregate operational metrics (for example, counts of errors), never client-level data.

7.3 **Where it is.** Under an Office Server Licence, Customer Data stays on Customer's infrastructure and Licensor
receives none of it. On the Hosted Service, Customer Data is stored and backed up only in `[[US region(s)]]`.

7.4 **Exports at any time.** Customer may export Customer Data at any time, without Licensor's involvement, with the
Software's own exports (spreadsheet exports of its records, encrypted backups with their keys, and the FHIR export
where enabled).

## 8. Confidentiality

8.1 Each party will keep the other's Confidential Information confidential, use it only for this Agreement, and
protect it with at least reasonable care. "Confidential Information" is non-public information a party discloses and
marks or reasonably identifies as confidential; Customer Data is always Customer's Confidential Information and is
also governed by Exhibits B and C.

8.2 This does not cover information that is public through no fault of the receiving party, already known to it,
independently developed, or rightly received from a third party; nor disclosures required by law (including the
California Public Records Act for a public agency), after notice to the other party where the law allows.

8.3 The Software's source code is visible in the public repository; this Agreement does not make it Customer's
Confidential Information, and its visibility grants no rights (section 2.3).

## 9. Term, termination, export and retention

9.1 **Term.** The Pilot runs as section 4.2 says. An annual Plan runs for one year from `[[start date]]` and
`[[renews for further one-year terms unless either party gives 60 days' written notice / ends unless renewed in
writing]]` (the "**Term**").

9.2 **Termination for breach.** Either party may terminate this Agreement if the other materially breaches it and does
not cure the breach within `[[30]]` days of written notice. Customer may terminate immediately if Licensor materially
breaches Exhibit B or C and cure is not possible.

9.3 **Termination for convenience.** `[[Customer may terminate for convenience on 60 days' notice, with a pro-rata
refund of prepaid fees for the unused Term / no termination for convenience.]]` *Drafting note: public agencies
usually require a termination-for-convenience and a non-appropriation clause.*

9.4 **Export on termination.** On any expiry or termination:
- (a) **Office Server Licence:** Customer keeps its data where it is. Customer may continue to run the Software
  read-only for `[[90]]` days to export and archive its records, after which it stops using the Software and deletes
  every copy of the Software (not of its data).
- (b) **Hosted Service:** within `[[30]]` days Licensor delivers to Customer a complete export (spreadsheet exports of
  every record type, an encrypted backup of the database and its keys delivered separately, and the FHIR export where
  enabled), and keeps the instance available to Customer read-only for `[[30]]` days. Licensor destroys the instance,
  its backups and its escrowed keys only after Customer confirms in writing that it has received and checked the
  export, or `[[60]]` days after delivery if Customer does not answer, and certifies the destruction in writing.
  Where destruction is not feasible, Exhibit B (return or destruction) applies.

9.5 **Retention.** Customer is responsible for keeping its records for as long as the law and its contracts require
(for example Medi-Cal, county and grant record-retention terms, and 42 CFR Part 2). Licensor keeps Customer Data only
to provide the services and as section 9.4 allows; it keeps no copy after the destruction it certifies, except
`[[backups that expire on their own schedule within N days, protected under Exhibits B and C until they do]]`.

9.6 **Survival.** Sections 7, 8, 9.4 to 9.6, 10, 11, 13 and 14, and Exhibits B and C for as long as Licensor holds
any Customer Data, survive termination.

## 10. Warranties and disclaimers

10.1 **Limited warranty.** `[[Licensor warrants that, for 90 days after delivery, the Software will perform materially
as the Documentation for its version describes; Customer's remedy for a breach of this warranty is correction, or, if
Licensor cannot correct it, termination and a refund of prepaid fees for the unused Term.]]`

10.2 **Compliance.** The Software provides controls (encryption, access control, consent and disclosure accounting,
audit) that support Customer's compliance. It does not by itself make Customer compliant with HIPAA, 42 CFR Part 2,
the California Confidentiality of Medical Information Act or any other law; Customer's policies, staff and operation
remain Customer's responsibility (`LICENSE` section 8).

10.3 **Disclaimer.** `[[EXCEPT AS SECTION 10.1 STATES, THE SOFTWARE AND SERVICES ARE PROVIDED "AS IS", WITHOUT
WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
ACCURACY AND NON-INFRINGEMENT. — wording for counsel]]`

## 11. Limitation of liability

11.1 `[[Cap: except for the exclusions in 11.2, each party's total liability under this Agreement is limited to the
fees paid or payable by Customer in the 12 months before the event giving rise to the claim. — amount and structure
for counsel]]`

11.2 `[[Exclusions from the cap, for counsel: e.g. breach of Exhibit B or C or of section 8; a party's indemnity
obligations; gross negligence or wilful misconduct; Customer's payment obligations.]]`

11.3 `[[Exclusion of indirect, incidental, special and consequential damages, and lost profits — wording for
counsel.]]`

## 12. Insurance

12.1 `[[Licensor will maintain, during the Term and for 1 year after it: cyber liability insurance of at least $[[…]]
per claim and technology errors-and-omissions insurance of at least $[[…]] per claim, and will provide certificates
of insurance on request.]]`

> *Drafting note: on `[[2026-10-10]]` Licensor holds no such insurance (../HOSTING.md, checklist item 7). Do not sign
> with this clause filled in until the policies are bound, and do not offer the Hosted Service without them.*

## 13. Indemnification

13.1 `[[Licensor's indemnity for claims that the Software, as Licensor supplies it, infringes a third party's
intellectual-property right, with the usual conditions (prompt notice, control of the defence, cooperation) and
remedies (procure the right, modify, or terminate and refund) — for counsel.]]`

13.2 `[[Any indemnity for breach of Exhibit B or C, and any Customer indemnity — for counsel.]]`

## 14. General

14.1 **Governing law.** This Agreement is governed by the laws of the State of California, without regard to its
conflict-of-laws rules (as `LICENSE` section 10). Venue: `[[the state or federal courts for the County of …]]`.

14.2 **Order of precedence.** For Customer Data, Exhibits B and C prevail over the rest of this Agreement; otherwise
the body of this Agreement prevails over the Exhibits, and the Order Form prevails only for the Plan, fees and dates it
states.

14.3 **Continuity.** `[[Optional source-code escrow: Licensor deposits the source of each release, its build
instructions and release records with [[escrow agent]]; release to Customer on Licensor's insolvency or its ceasing to
support the Software, for Customer's continued internal use only. — for the parties to decide.]]` *Drafting note: the
source is already public, so an escrow adds the build and release know-how and a licence to keep using it.*

14.4 **Assignment.** Neither party may assign this Agreement without the other's written consent, except to a
successor to all or substantially all of its business that assumes it in writing, with notice.

14.5 **Notices.** In writing to the addresses above (or as updated by notice), by `[[email to … / post]]`. Security
and breach notices follow Exhibit B.

14.6 **Independent contractors; no third-party beneficiaries; force majeure; severability; waiver; entire agreement;
counterparts and electronic signatures.** `[[Standard clauses for counsel.]]`

14.7 **Public agency terms.** `[[Where Customer is a county or other public agency, its required contract terms
(for example non-appropriation, audit rights, conflict-of-interest and non-discrimination clauses) are attached as
Exhibit F and prevail over this Agreement where they conflict.]]`

## Signatures

| AugustInnovations LLC | `[[Customer legal name]]` |
| --- | --- |
| By: `[[name]]` | By: `[[name]]` |
| Title: `[[title]]` | Title: `[[title]]` |
| Date: `[[date]]` | Date: `[[date]]` |

## Exhibits

- **Exhibit A — Order Form:** Plan; Office Server Licence or Hosted Service; sites and staff-account limits; start
  date; fees and invoicing; County-wide price and named contact; any extra rights under section 2.3. `[[to complete]]`
- **Exhibit B — HIPAA Business Associate Agreement:** [BAA-QSOA-DRAFT.md](BAA-QSOA-DRAFT.md), Part A, with its
  Schedule (Part C).
- **Exhibit C — 42 CFR Part 2 Qualified Service Organization Agreement:** [BAA-QSOA-DRAFT.md](BAA-QSOA-DRAFT.md),
  Part B, with its Schedule (Part C).
- **Exhibit D — Support and service levels:** [SUPPORT-SLA.md](SUPPORT-SLA.md), completed.
- **Exhibit E — Data processing terms (optional):** [DPA-DRAFT.md](DPA-DRAFT.md).
- **Exhibit F — Public agency terms (where they apply).**

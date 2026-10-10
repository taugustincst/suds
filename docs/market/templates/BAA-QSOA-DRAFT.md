# Business Associate Agreement and 42 CFR Part 2 Qualified Service Organization Agreement

> **DRAFT — for review by counsel before use; not legal advice.** Two templates in one file: **Part A**, a HIPAA
> Business Associate Agreement (BAA) with the terms 45 CFR 164.504(e) and 164.314(a) require, and **Part B**, a
> 42 CFR Part 2 Qualified Service Organization Agreement (QSOA) with the elements of the definition in 42 CFR 2.11;
> **Part C** is the schedule both use. No counsel has reviewed them and no customer has signed them. Every `[[…]]` is a
> placeholder for the parties to complete (a value shown in one is only a suggestion). Citations marked *verify with
> counsel* are ones this draft could not confirm against the current text of the regulation. The Covered Entity's own
> BAA or QSOA form, if it has one, takes precedence; counsel for both parties must review and adapt these, including
> for the Part 2 final rule (89 FR 12472, February 16, 2024; compliance date February 16, 2026), the California
> Confidentiality of Medical Information Act (Civil Code 56 et seq.) and any state, county or grant terms.
>
> They are written for **the hosted service**, where AugustInnovations LLC operates the customer's SUDS instance and
> signs both agreements (owner decision of 2026-10-09; the hosted service is not offered yet: [../HOSTING.md](../HOSTING.md)),
> and they also serve where the vendor's staff can reach a customer-hosted production system or its backups for
> support. A customer-hosted install the vendor never reaches may not need either; counsel decides. They are Exhibits B
> and C of the [licence and subscription agreement](LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md).
>
> **A Part 2 programme needs both.** A BAA alone does not let a service provider receive Part 2 records; the QSOA does
> (42 CFR 2.12(c)(4)). The AWS business associate addendum that covers the hosting infrastructure is the operator's
> agreement with its cloud provider: it is not an agreement with the customer and replaces neither.

**Parties:** `[[Customer legal name]]` ("**Covered Entity**" in Part A; "**Part 2 Program**" in Part B) and
**AugustInnovations LLC**, `[[state of formation]]`, `[[address]]` ("**Business Associate**" in Part A; "**Qualified
Service Organization**" or "**QSO**" in Part B).
**Underlying agreement:** the SUDS Licence and Subscription Agreement dated `[[date]]` (the "**Services Agreement**").
**Effective date:** `[[date]]`.

## Part A — HIPAA Business Associate Agreement

**A1. Definitions.** Terms used and not defined here (including Breach, Data Aggregation, Designated Record Set,
Disclosure, Health Care Operations, Individual, Minimum Necessary, Protected Health Information ("PHI"), Required by
Law, Secretary, Security Incident, Subcontractor, Unsecured PHI and Use) have the meanings in 45 CFR 160.103,
164.304, 164.402 and 164.501. PHI here means PHI that Business Associate creates, receives, maintains or transmits on
behalf of Covered Entity.

**A2. Permitted uses and disclosures** (45 CFR 164.504(e)(2)(i)). Business Associate may use and disclose PHI only:
- (a) to perform the services in the Services Agreement for Covered Entity: operating, backing up, restoring and
  upgrading Covered Entity's SUDS instance; support Covered Entity asks for; implementation and data migration;
- (b) as Required by Law;
- (c) for Business Associate's proper management and administration or to carry out its legal responsibilities, where
  the disclosure is Required by Law or Business Associate obtains reasonable assurances from the recipient that it
  will hold the PHI confidentially, use or further disclose it only as Required by Law or for the purpose for which
  it was disclosed, and notify Business Associate of any instance in which its confidentiality has been breached
  (164.504(e)(4)); and
- (d) `[[for Data Aggregation services relating to Covered Entity's Health Care Operations — delete if not wanted]]`.

Business Associate will not use or disclose PHI in a manner that would violate Subpart E of 45 CFR Part 164 if done
by Covered Entity, except as (c) and (d) allow. It will limit its uses, disclosures and requests to the Minimum
Necessary (164.502(b)). It will not sell PHI (164.502(a)(5)(ii)), use or disclose it for marketing, or use it to train
or improve any machine-learning or AI model or for product analytics `[[beyond de-identified, aggregate operational
metrics that contain no client-level data]]`.

**A3. Safeguards** (164.504(e)(2)(ii)(B); 164.314(a)(2)(i)(A)). Business Associate will use appropriate safeguards,
and comply with Subpart C of 45 CFR Part 164 (the Security Rule) with respect to electronic PHI, to prevent use or
disclosure of PHI other than as this Agreement provides. For the hosted service this includes at least: a separate
virtual machine, database and encryption keys per customer; field-level AES-256-GCM encryption of PHI and an
encrypted data volume; TLS 1.2 or later in transit; encrypted backups; individual, two-step-verified administrator
accounts; and the hash-chained audit log of the Software (docs/HIPAA.md and docs/security/).

**A4. Reporting** (164.504(e)(2)(ii)(C); 164.314(a)(2)(i)(C); 164.410). Business Associate will report to Covered
Entity:
- (a) any use or disclosure of PHI not provided for by this Agreement of which it becomes aware;
- (b) any Security Incident of which it becomes aware `[[; the parties agree that unsuccessful attempts, such as pings,
  port scans and failed sign-ins that do not result in unauthorised access, are hereby reported and need no further
  notice]]`; and
- (c) any Breach of Unsecured PHI, without unreasonable delay and in no case later than `[[5 business days]]` after
  discovery (the regulation's outer limit is 60 calendar days, 164.410(b)), with, to the extent possible, the
  identification of each Individual affected and the other information Covered Entity needs to notify under 164.404
  (164.410(c)), supplemented as it becomes available.

Covered Entity decides whether and how Individuals, the Secretary and the media are notified; Business Associate
cooperates `[[and bears the reasonable cost of notification for a Breach caused by its own failure]]`.

**A5. Subcontractors** (164.504(e)(2)(ii)(D); 164.502(e)(1)(ii); 164.314(a)(2)(i)(B)). Business Associate will ensure
that every Subcontractor that creates, receives, maintains or transmits PHI on its behalf agrees in writing to the
same restrictions, conditions and requirements that apply to Business Associate. Its Subcontractors are listed in
Part C, and Business Associate will give Covered Entity `[[30]]` days' notice before adding one.
- **Hosting.** The cloud provider (Part C) is bound by its business associate addendum with Business Associate.
- **AI provider (only when the Software's AI documentation copilot is turned on).** The copilot (docs/AI-COPILOT.md;
  office server only, off by default) sends the text a worker gives for one client, with the identifiers SUDS holds
  replaced, to one named AI provider: `[[AI provider legal name; the provider the Software calls by default is named
  in docs/AI-COPILOT.md]]`. Where Business Associate hosts SUDS or holds the provider's API key, that provider is its
  Subcontractor: before the copilot is turned on it must be listed in Part C, bound by a flow-down BAA with Part 2 QSO
  terms (Part B), and bound in writing `[[to keep no request or response content beyond the call, or only for N days
  for abuse monitoring]]` and `[[never to use the content to train or improve any model]]`. **The exact retention and
  no-training terms are to be confirmed by counsel against the provider's current agreement; do not state them from
  this draft.** Where Covered Entity contracts with the provider itself and holds the key, the provider is Covered
  Entity's own business associate, and this item records only that Business Associate sends no PHI to any AI provider
  on its own account. The copilot is never used for SUD counseling notes (Part B, B6).

**A6. Access, amendment and accounting** (164.504(e)(2)(ii)(E)–(G)). Within `[[10]]` business days of Covered
Entity's request, Business Associate will make PHI in a Designated Record Set available to Covered Entity so that it
can meet 164.524 (access) and 164.526 (amendment, including incorporating amendments), and make available the
information Covered Entity needs to provide an accounting of disclosures under 164.528. (The Software produces the
exports, revision history and disclosure accounting itself; Covered Entity's administrators can usually do this
without Business Associate.) Business Associate forwards to Covered Entity any request it receives directly from an
Individual within `[[5]]` business days.

**A7. Covered Entity's obligations.** To the extent Business Associate carries out an obligation of Covered Entity
under Subpart E of 45 CFR Part 164, it will comply with the requirements of Subpart E that apply to Covered Entity in
performing that obligation (164.504(e)(2)(ii)(H)).

**A8. Books and records** (164.504(e)(2)(ii)(I)). Business Associate will make its internal practices, books and
records relating to the use and disclosure of PHI available to the Secretary for determining Covered Entity's
compliance.

**A9. Term and termination** (164.504(e)(2)(iii)). This Part A runs from the effective date until all PHI is returned
or destroyed under A10. Covered Entity may terminate the Services Agreement and this Agreement if Business Associate
has violated a material term of this Agreement and has not cured it within `[[30]]` days of written notice, or
immediately where cure is not possible.

**A10. Return or destruction** (164.504(e)(2)(ii)(J)). At termination, Business Associate will, if feasible, return to
Covered Entity (in the export format in Part C) or destroy all PHI it still maintains in any form, including backups
and escrowed keys, retain no copies, and certify the destruction in writing within `[[30]]` days of Covered Entity
confirming receipt of the export. If return or destruction is not feasible, Business Associate will tell Covered
Entity why, extend the protections of this Agreement to that PHI, and limit further uses and disclosures to the
purposes that make return or destruction infeasible, for as long as it maintains it.

**A11. Miscellaneous.** Any ambiguity is resolved to permit compliance with HIPAA. The parties will amend this
Agreement as needed for a change in the law. Nothing here creates rights for any third party. `[[Indemnification,
insurance (cyber liability) and limitation of liability: as the Services Agreement states, with any carve-outs counsel
agrees.]]`

_Signatures (Part A):_ Covered Entity `[[name, title, date]]` — AugustInnovations LLC `[[name, title, date]]`

## Part B — 42 CFR Part 2 Qualified Service Organization Agreement

The Part 2 Program is a "program" under 42 CFR 2.11 and holds patient records subject to 42 CFR Part 2. The QSO
provides it with services within 42 CFR 2.11's definition of a qualified service organization `[[data processing:
hosting, operating, backing up and supporting the Part 2 Program's SUDS case-management system]]`. Under 42 CFR
2.12(c)(4), Part 2's restrictions do not apply to communications between a Part 2 program and a QSO of information
the QSO needs to provide those services. To be a QSO, the QSO enters into this written agreement, under which it
**acknowledges and agrees that**:

**B1. Fully bound** (2.11, definition of qualified service organization). In receiving, storing, processing or
otherwise dealing with any patient records from the Part 2 Program, the QSO is fully bound by 42 CFR Part 2.

**B2. Resisting judicial efforts** (2.11). If necessary, the QSO will resist in judicial proceedings any efforts to
obtain access to patient identifying information related to substance use disorder diagnosis, treatment or referral
for treatment, except as permitted by 42 CFR Part 2 (including a court order under Subpart E that meets its
requirements). It will tell the Part 2 Program of any such effort, subpoena or request within `[[2]]` business days,
unless the law forbids it.

**B3. Use, disclosure and redisclosure.** The QSO uses Part 2 records only to provide the services above and
discloses them only back to the Part 2 Program, or as 42 CFR Part 2 otherwise permits. Any disclosure it is permitted
to make carries the notice 42 CFR 2.32 requires. It discloses records to a subcontractor or agent only as B8 allows.
*Verify with counsel* how the 2024 final rule's changes to 2.11 (business associates and QSOs) and 2.33 (redisclosure
by HIPAA covered entities and business associates) apply to this arrangement.

**B4. No use against the patient.** The QSO will not use or disclose Part 2 records, or testimony relaying their
content, in any civil, criminal, administrative or legislative proceeding against the patient, except as 42 CFR Part 2
permits (2.12(d), Subpart E).

**B5. Breach notification.** The 2024 final rule applies the HIPAA breach-notification requirements (45 CFR Part 164,
Subpart D) to breaches of records by Part 2 programs (42 CFR 2.16, as amended; *verify the exact paragraph with
counsel*). The QSO will report any breach of unsecured Part 2 records, and any use or disclosure not provided for by
this Agreement, to the Part 2 Program as Part A, A4 provides (no later than `[[5 business days]]` after discovery),
with the information the Part 2 Program needs to notify patients and the Secretary.

**B6. SUD counseling notes.** Records the Part 2 Program designates as SUD counseling notes (as the 2024 final rule
defines them in 2.11) are used or disclosed only with the separate patient consent the rule requires. SUDS keeps the
consent for them as its own consent type (docs/compliance/PART2.md); the QSO will not use or disclose them otherwise.

**B7. Security.** The QSO maintains formal policies and procedures to protect Part 2 records against unauthorized
uses and disclosures, including their secure storage, transmission, disposal and de-identification, at least to the
standard of 42 CFR 2.16 and of Part A, A3.

**B8. Subcontractors.** The QSO does not disclose Part 2 records to a subcontractor or agent unless that subcontractor
or agent is bound by written terms equivalent to this Part B, including B1 and B2, and is listed in Part C. *Verify
with counsel* whether the QSO's cloud provider, which stores encrypted records but provides no service to the program
itself, must sign Part 2 terms or is covered by the QSO's own agreement with it.

**B9. Term, termination and return.** As Part A, A9 and A10, applied to Part 2 records. Part B survives for as long as
the QSO holds any Part 2 record.

**B10. Penalties.** The QSO acknowledges that 42 CFR Part 2 is enforced with the civil and criminal penalties the 2024
final rule aligned with HIPAA's (42 USC 290dd-2(f), as amended by section 3221 of the CARES Act; 42 CFR 2.3; *verify
with counsel*).

_Signatures (Part B):_ Part 2 Program `[[name, title, date]]` — AugustInnovations LLC `[[name, title, date]]`

## Part C — Schedule (fill in)

| Item | Value |
| --- | --- |
| Services | `[[hosted SUDS instance / support access to a customer-hosted server]]` |
| Data location | `[[US cloud region(s)]]`; backups in `[[US region(s)]]` only |
| Encryption keys held by | `[[Business Associate, with an escrow copy whose every use is logged / Covered Entity]]` |
| Who at Business Associate can reach the data | `[[roles; named list maintained and given to Covered Entity on request]]` |
| Subcontractors | `[[cloud provider legal name, under its business associate addendum (infrastructure only); any other — ideally none]]` |
| AI provider (only if the copilot is turned on) | `[[none / provider legal name; whose agreement (Business Associate's or Covered Entity's); retention and no-training terms as confirmed by counsel; date turned on]]` |
| Incident contact (Covered Entity) | `[[privacy officer, phone, email]]` |
| Incident contact (Business Associate) | `[[security lead, phone, email]]` |
| Breach and incident notice deadline | `[[5]]` business days (A4, B5) |
| Requests from Individuals forwarded within | `[[5]]` business days (A6) |
| Export format at termination | Spreadsheet exports of every record type, an encrypted database backup with its keys delivered separately, and the FHIR export where enabled |
| Destruction after the export is confirmed | `[[30]]` days, with a written certificate (A10) |

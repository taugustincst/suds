# Business Associate Agreement and 42 CFR Part 2 Qualified Service Organization Agreement

> **DRAFT — for county counsel review, not legal advice.** This is a starting outline of the elements a
> combined HIPAA Business Associate Agreement (BAA) and 42 CFR Part 2 Qualified Service Organization
> Agreement (QSOA) usually contains. It is not a complete or reviewed contract. The county's own BAA template,
> if it has one, takes precedence; counsel for both parties must review and adapt it, including for the
> Part 2 final rule (effective April 2024, compliance date February 16, 2026), the California Confidentiality
> of Medical Information Act (Civil Code §56 et seq.) and any state or grant terms.

**Parties:** `[County / CBO name]` ("Covered Entity" / "Part 2 Program") and `[Vendor legal name]`
("Business Associate" / "Qualified Service Organization").
**Underlying agreement:** `[Subscription / services agreement, date]`.
**When it applies:** whenever the vendor creates, receives, maintains or transmits PHI or Part 2 records —
vendor-hosted SUDS, or vendor staff who can access a county-hosted production system or its backups for support.
A county-hosted install that the vendor never accesses may not need one; counsel decides.

## Part A — HIPAA Business Associate elements (45 CFR §164.504(e))

1. **Definitions** by reference to 45 CFR Parts 160 and 164 and 42 CFR Part 2.
2. **Permitted uses and disclosures**: only to provide the services in the underlying agreement (hosting,
   support, implementation, data migration), as the Covered Entity could, and for the Business Associate's
   proper management and administration or legal responsibilities as the rule allows. No sale of PHI; no use
   for marketing; **no use to train machine-learning models or for product analytics** beyond de-identified,
   aggregate operational metrics.
3. **Minimum necessary** access by vendor personnel; access only by named, trained staff; access logged in
   the SUDS audit log (vendor support accounts are individual, MFA-protected and time-limited).
4. **Safeguards**: comply with the Security Rule (Subpart C of Part 164); describe or reference the controls
   (`docs/HIPAA.md`, `docs/security/`), including encryption at rest and in transit, and key custody.
5. **Reporting**: report to the Covered Entity any use or disclosure not provided for by the agreement, any
   security incident, and any breach of unsecured PHI **without unreasonable delay and no later than
   `[5]` business days** after discovery (the rule's outer limit is 60 days; counties usually ask for less),
   with the information §164.410 requires as it becomes available.
6. **Subcontractors** (e.g. the cloud hosting provider): flow-down BAAs with the same restrictions;
   list maintained and notified to the Covered Entity (see DPA).
7. **Individual rights**: make PHI available for access (§164.524), amendment (§164.526) and accounting of
   disclosures (§164.528) within `[10]` business days of request — SUDS produces the accounting and exports.
8. **Books and records** available to the Secretary of HHS.
9. **Term and termination**: termination for material breach after a cure period, or immediately where
   cure is not possible.
10. **Return or destruction** of PHI at termination (all copies, including backups), with a written
    certificate; where infeasible, extend protections and limit further use.
11. **Indemnification and insurance** (cyber liability) — commercial terms, per the underlying agreement.

## Part B — 42 CFR Part 2 Qualified Service Organization elements (§2.11, §2.12(c)(4))

A QSOA lets the Part 2 program share records with a service provider without patient consent, for services
such as data processing. The Business Associate, as a Qualified Service Organization, **acknowledges and agrees
that**:

1. **It is fully bound by 42 CFR Part 2** in receiving, storing, processing or otherwise dealing with any
   patient records from the program.
2. **It will resist in judicial proceedings** any efforts to obtain access to patient identifying information
   related to SUD diagnosis, treatment or referral except as permitted by Part 2 (including a court order
   under Subpart E that meets Part 2's requirements), and will notify the program promptly of any such request.
3. **It will not redisclose** Part 2 records except back to the program or as Part 2 permits; any permitted
   redisclosure carries the §2.32 notice.
4. **No use against the patient**: records will not be used or disclosed in any civil, criminal,
   administrative or legislative proceeding against the patient except as Part 2 allows.
5. **Breach notification**: breaches of Part 2 records are handled under the HIPAA breach-notification
   requirements that the final rule applies to Part 2 (§2.16), as in Part A, item 5.
6. **SUD counseling notes** (as defined in the final rule) are used or disclosed only with the separate
   consent the rule requires; SUDS stores the consent type separately (`docs/compliance/PART2.md`).
7. **Security**: maintains formal policies and procedures to protect Part 2 records (§2.16), including
   secure storage, transmission, disposal and de-identification — referencing the same controls as Part A.
8. **Subcontractors** that receive Part 2 records are bound by equivalent written terms.

## Part C — SUDS-specific schedule (fill in)

| Item | Value |
| --- | --- |
| Deployment | `[vendor-hosted / county-hosted with vendor support access]` |
| Data location | `[US region(s)]` |
| Encryption keys held by | `[vendor, with custody procedure / county]` |
| Vendor personnel with access | `[roles; named list maintained]` |
| Subprocessors | `[cloud provider, email/support tool if it may receive PHI — ideally none]` |
| Incident notice contact (county) | `[privacy officer, phone, email]` |
| Incident notice contact (vendor) | `[security lead, phone, email]` |
| Breach notice deadline | `[5]` business days (Part A.5) |
| Data return format at exit | Excel/CSV of every table + encrypted database backup and keys; FHIR bulk export where enabled |
| Deletion deadline after return | `[30]` days, with certificate |

_Signatures: Covered Entity / Part 2 Program ______________  Business Associate / QSO ______________  Date ______

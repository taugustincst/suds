# Data Processing Addendum (DPA)

> **DRAFT — for county counsel review, not legal advice.** An outline of data-protection terms that sit beside
> the BAA/QSOA ([BAA-QSOA-DRAFT.md](BAA-QSOA-DRAFT.md)) and cover all customer data — including staff data,
> resource directories, budgets and de-identified data — not only PHI. Adapt to the county's standard terms and
> any DGS cloud/SaaS provisions the county adopts. Where this DPA and the BAA/QSOA conflict on PHI or Part 2
> records, the stricter term applies.

**Parties:** `[County / CBO]` ("Customer") and `[Vendor legal name]` ("Vendor").

## 1. Roles and ownership

- The Customer owns all Customer Data. The Vendor processes it only on the Customer's documented instructions
  to provide the services.
- "Customer Data" includes client records, staff accounts, audit logs, resource directory, budget and time
  records, uploaded forms and attachments, backups and exports.

## 2. Purpose limitation

- No sale, rental or sharing of Customer Data.
- No use for advertising, profiling, or **training or improving machine-learning / AI models**.
- Operational metrics the Vendor may collect are aggregate and contain no PHI (SUDS `/api/metrics` counts
  only; `docs/DEPLOYMENT.md`, *Monitoring and logs*).

## 3. Location and subprocessors

- Customer Data is stored and processed only in the United States `[and only in region ___]`.
- Current subprocessors: `[cloud hosting provider — list; ideally no other subprocessor receives Customer Data]`.
- `[30]` days' notice of a new subprocessor, with a right to object and, if unresolved, to terminate without penalty.
- SUDS itself loads no third-party scripts, CDNs, analytics or telemetry; the Vendor will not add any that
  receive Customer Data without written approval.

## 4. Security

- Security controls at least as described in `docs/HIPAA.md` and `docs/security/` at the effective date, and
  not materially reduced during the term.
- Annual independent assessment: `[SOC 2 Type 1 by ___ / Type 2 by ___]`; penetration test `[annually]`,
  summary shared under NDA. *(Until these exist, state the dates; do not claim them.)*
- Personnel with access: background-checked, trained on HIPAA/Part 2, bound by confidentiality, individual
  MFA-protected accounts, access reviewed quarterly.

## 5. Incidents

- Notice of a security incident affecting Customer Data without undue delay and within `[72 hours]` of
  discovery for suspected incidents; breach notification of PHI per the BAA (no later than `[5]` business days).
- Cooperation with the Customer's investigation, including relevant SUDS audit-log extracts and hosting logs.
- Costs of notification caused by the Vendor's breach: per the underlying agreement / insurance.

## 6. Customer rights

- Export at any time, in open formats (Excel/CSV of every table, FHIR bulk export where enabled), without
  additional fee.
- Audit: reasonable right to review the Vendor's security evidence once a year, and after a breach.
- Assistance with patient-rights requests, public-records requests (California Public Records Act, as they
  apply to the Customer) and litigation holds (SUDS legal hold).

## 7. Retention, return and deletion

- During the term, retention follows the Customer's settings (SUDS `client_retention_years`, audit retention).
- At termination: the Vendor returns Customer Data within `[30]` days (export + encrypted backup and keys),
  then deletes all copies including backups within `[30]` days of confirmed receipt, and certifies deletion in
  writing. Backups that cannot be deleted immediately stay encrypted and are deleted on their normal cycle,
  not exceeding `[90]` days.

## 8. Law

- California law; compliance with HIPAA, 42 CFR Part 2, the California Confidentiality of Medical Information
  Act and applicable state data-breach law (Civil Code §1798.82 as applicable).

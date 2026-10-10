# Insurance quote brief: cyber liability and technology errors and omissions

> **DRAFT — to be completed by the owner before it is sent to a broker; not insurance advice.** Every `[BRACKET]` is a
> fact only the owner can supply (revenue, customers, the entity), filled in **outside this public repository**.
> Facts below that come from the repository link to their evidence; nothing here is a claim about the business that
> the owner has not confirmed. Item 6 of [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md); it follows the entity
> filing (item 0).

## 1. The applicant

| Question | Answer |
| --- | --- |
| Legal entity, state and date of formation | `[ENTITY NAME]`, `[STATE]`, `[DATE]` (the licence names AugustInnovations LLC: [`LICENSE`](../../../LICENSE)) |
| Business address, contact | `[ADDRESS]`, `[CONTACT EMAIL]` |
| Years in business; staff | `[N]`; `[N]` people (development is done by the owner with AI coding assistants) |
| Revenue: last 12 months, next 12 months (estimate) | `[$]`, `[$]` |
| Customers | `[NONE YET / N]`; largest contract `[$]`; public-sector share `[%]` |
| Prior claims, incidents, regulatory actions | `[NONE / DETAILS]` |
| Other insurance held | `[NONE / GENERAL LIABILITY …]` |

## 2. What the business does

- **Product.** SUDS, proprietary case-management software for California substance-use-disorder (SUD) and
  harm-reduction programmes: outreach, naloxone and supply distribution, consent and disclosure accounting, state
  (CalOMS Tx) and funder reporting. Not an electronic health record; it does not bill or process payments.
- **Services.** Licences for a self-hosted office server; a 90-day pilot, annual plans and email support at published
  introductory prices ([`public/procurement.json`](../../../public/procurement.json)); implementation help. A hosted
  service run by the licensor is **planned, not offered** ([../HOSTING.md](../HOSTING.md)).
- **Customers.** Community-based organisations and California counties.

## 3. Data handled

| Question | Answer |
| --- | --- |
| Types | Protected health information (PHI) and **42 CFR Part 2** SUD treatment records (names, dates of birth, clinical notes, consents, services), held by the customer's SUDS |
| Who holds it today | **The customer.** Self-hosted office server: on the customer's infrastructure. SUDS on this device: in the user's browser. The licensor receives no client records in either model ([../../security/DATA-INVENTORY.md](../../security/DATA-INVENTORY.md)) |
| Does the licensor hold any | Only fictional data, on its own install (suds.systems) |
| If the hosted service starts | The licensor would hold customers' PHI and Part 2 records on AWS under the AWS business associate addendum, as their business associate and qualified service organisation; record counts `[ESTIMATE]` |
| Payment card data | None |

Ask the broker to quote **both**: the business as it is (no customer data held) and with the hosted service.

## 4. Security controls (with evidence)

| Control | In place | Evidence |
| --- | --- | --- |
| Encryption at rest of identifiers and free text (AES-256-GCM), searchable blind indexes; device copies sealed | Yes | [../../security/ENCRYPTION-AND-KEYS.md](../../security/ENCRYPTION-AND-KEYS.md) |
| TLS 1.2+ and HSTS | Yes | [../../evidence/README.md](../../evidence/README.md), *Encryption in transit* |
| Multi-factor authentication (TOTP, passkeys), SSO, role-based access, least privilege by default | Yes, in the product | [../../security/IDENTITY.md](../../security/IDENTITY.md) |
| Hash-chained, append-only audit log with external anchors | Yes | [../../security/LOGGING-AND-AUDIT.md](../../security/LOGGING-AND-AUDIT.md) |
| Encrypted backups, offsite copy checked by SHA-256, recovery drills with signed reports | Yes (development drills; the offsite copy on SUDS Server works from 1.25.4) | [../../security/BACKUP-AND-DR.md](../../security/BACKUP-AND-DR.md), [../../evidence/README.md](../../evidence/README.md) |
| Hardened Linux installer with a weekly signed compliance check | Yes | [../../SELF-HOSTING.md](../../SELF-HOSTING.md) |
| Secure development: CI on every push, a release gate, an SBOM per release, zero runtime npm dependencies | Yes | [../../security/SDLC.md](../../security/SDLC.md), [../../RELEASE.md](../../RELEASE.md) |
| Vulnerability disclosure policy | Yes | [`SECURITY.md`](../../../SECURITY.md) |
| Independent penetration test | **No** (vendor's own tests only, not independent) | [../../security/PEN-TEST-SCOPE.md](../../security/PEN-TEST-SCOPE.md) |
| SOC 2 or other certification | **No** (self-assessment only) | [../../security/SOC2-READINESS.md](../../security/SOC2-READINESS.md) |
| MFA on the business's own accounts (email, cloud, code host, domain registrar) | `[YES / NO, PER ACCOUNT]` | owner |
| Backups of the business's own systems; endpoint protection on the owner's machines | `[DETAILS]` | owner |
| Signed releases and binaries | **No** (procedure written; not in use) | [../../RELEASE.md](../../RELEASE.md) |

## 5. Incident response

- In the product: an incident and breach register with the 60-day notification clock, detection signals and
  evidence export ([../../security/INCIDENT-RESPONSE.md](../../security/INCIDENT-RESPONSE.md)).
- For the business: `[THE LICENSOR'S OWN INCIDENT RESPONSE PLAN — NOT WRITTEN YET / DATE]`; who is called first
  `[ROLE]`; outside counsel `[YES / NO]`.

## 6. What to quote

| Cover | Limit wanted | Notes |
| --- | --- | --- |
| Technology errors and omissions (professional liability) | `[$ PER CLAIM / AGGREGATE]` | Software failure, a defect causing a customer's loss |
| Cyber liability: first party (breach response, notification, forensics, restoration) and third party (privacy liability, regulatory defence and fines where insurable) | `[$]` | Include regulatory proceedings under HIPAA and state law |
| General liability (often required by county contracts) | `[$]` | |
| Additional insured: the customer, by endorsement | per contract | Counties usually ask |

Limits: use the limits in a prospective customer's contract when known; otherwise ask the broker what California
counties typically require of a software vendor of this size. `[KNOWN CONTRACT REQUIREMENTS]`.

## 7. Questions to ask each broker

1. Does the policy cover a software vendor that does **not** hold customer data today but licenses software that
   processes PHI and Part 2 records, and what changes when the hosted service starts?
2. Is regulatory defence and penalty cover included for HIPAA, 42 CFR Part 2 and California law, and are fines covered
   where insurable?
3. Is breach response (forensics, notification, call centre, credit monitoring) first-party cover, with the insurer's
   panel or our choice?
4. Are claims arising from code written with AI coding assistants treated any differently?
5. Retroactive date, and is prior-acts cover available for the releases already published?
6. Exclusions to note: unencrypted devices, failure to patch, war and state-actor events, contractual liability, open
   source components.
7. What controls does the underwriter require (MFA on email and remote access, offline backups, endpoint detection),
   and do any change the premium?
8. Can certificates name a county as additional insured, and how quickly are they issued?
9. Is the policy claims-made, and what does an extended reporting period cost?
10. Premium and deductible for each limit option; payment terms.

## 8. Recording the result

When policies are bound: the licence and subscription agreement's section 12 drafting note, [../HOSTING.md](../HOSTING.md)
item 7, QUESTIONNAIRE #6a and [../README.md](../README.md) *Organisational gaps* say so, with the cover types and
limits the owner chooses to publish. Policy numbers, premiums and the broker's details stay outside the repository.

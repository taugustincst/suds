# 42 CFR Part 2 — control matrix and operating guide

SUDS is case-management software for county substance use disorder (SUD) programmes, which are almost
always **Part 2 programmes**: federally assisted, holding themselves out as providing SUD diagnosis,
treatment or referral for treatment. This document maps each requirement of 42 CFR Part 2, **as amended by
the 2024 final rule** (89 FR 12472, effective 16 April 2024, compliance date 16 February 2026), to where
SUDS implements it, and says plainly what SUDS does not do.

> **SUDS provides controls, not legal advice.** It enforces what software can enforce (a consent cannot
> be saved without its required elements; a disclosure without a lawful basis is refused; a legal
> proceeding needs a recorded court order) and records the rest so it can be shown. Whether a particular
> disclosure is lawful, what the programme's forms and notices say, how staff are trained and what the
> programme does after a breach are the programme's decisions, to be made with **county counsel**.
> Section numbers below follow the 2024 rule; have counsel confirm them against the current eCFR before
> relying on this document in a contract or an audit response.

## How to read the matrix

* **Status**: **Present** — in SUDS before this review (1.10.2 or earlier); **Built** — added in this
  change (schema migration 29); **Programme** — a policy, form wording or human judgement SUDS cannot
  supply, with what SUDS does to support it.
* Files are relative to the repository root. Every route named is covered by an API test in
  `test/part2.test.js` (new controls) or `test/compliance.test.js` / `test/api.test.js` (earlier ones), and
  the screens by `scripts/ui/clinical-audit.mjs`.

## Review findings in one paragraph

The marketability review said SUDS had "no consent capture, tracking or revocation; no §2.31 workflow,
disclosure notice, segmentation or redisclosure control". Most of that already existed: consents with
required §2.31 elements and revocation, a disclosure gate (`server/disclosure.js`) on referrals and
identified exports, an accounting of disclosures, a redisclosure notice on the printed accounting and the
starter consent form, patient-rights requests with 30-day clocks, and a hash-chained audit log. The real
gaps against the **2024 rule** were: the §2.31 elements added in 2024 (revocation and refusal statements,
signer when not the patient) and the single TPO consent; SUD counseling notes; the 2024 §2.32 notice
text, and the notice travelling with *every* disclosure (identified exports, printed forms, the disclosure
record itself); a "court order" basis that needed no order; no block on use in proceedings against the
patient; general releases (ROI) accepted as Part 2 consent; identified exports with no lawful basis; agreed
restrictions not checked; no §2.22 patient notice; no complaint log; no breach register or notification
clock. All of those are closed below.

A later independent review (September 2026, schema migration 32) found the gate still open in four places,
each confirmed with a probe test, and each now closed (`test/disclosure-gates.test.js`):

1. **A consent was not tied to its recipient.** Only the FHIR API compared the consent's recipient with the
   organisation receiving the information; a referral, a manual disclosure, an identified export and the
   county EHR hand-off accepted any live consent, whoever it named (a consent for "Agency A only" let a
   navigator refer the client to Agency B and record a disclosure to Probation). Every path now uses the
   same match — see **The disclosure gate** below.
2. **The non-consent bases needed nothing on file.** Any role could record a disclosure for research, audit,
   a QSOA, a crime on the premises or a child-abuse report, and a referral could rest on any of them. A
   referral now rests only on consent, a medical emergency, a court order or the supervisor's override; a
   QSOA, research or audit disclosure names a registered agreement or approval with the recipient; research,
   audit, crime-on-premises and child-abuse disclosures are a supervisor's or administrator's; an
   `internal` export must go to this programme or its staff.
3. **A device's sync push bypassed §2.31.** A consent pushed from a device was stored without its elements
   being checked, and could then authorise a disclosure. A pushed consent (and court order) is now checked
   as the office's own forms check it, and the elements are re-checked whenever a consent is relied on.
4. **Smaller gaps:** the retention purge deleted an incident's record of the people it affected; incident
   titles were stored in plain text; the Part 2 programme could be switched off silently; and every test
   download of the CalOMS Tx extract was written to clients' accounting of disclosures as if submitted.

## Control matrix

| Requirement | Where SUDS implements it | Status |
| --- | --- | --- |
| **Applicability, §2.11–§2.12** — Part 2 covers records of a federally assisted programme that identify a patient as having a SUD. | Setting `part2_program` (on by default) — Privacy & Part 2 → Overview (`PUT /api/part2/settings`, `server/routes/part2.js`). While on: the client header shows the **42 CFR Part 2** label, general releases are refused as consent, and every disclosure, export and printout carries the §2.32 notice. Notes default to `part2_protected` and show the label. **Switching it off** needs a written reason (`part2_off_reason`, ≥ 20 characters), is audited (`part2.program.off`), is shown to administrators on Home until it is switched back on, and opens a draft incident (source `part2_program_off`, the reason in its encrypted description) for the privacy officer to confirm with counsel. | Built (setting, label); Present (note flag) |
| **Labelling / segmentation, §2.12(d)(2), §2.32** — records received under Part 2 need not be segregated, but what is disclosed must carry the notice. | Records are not segregated (not required). The label is on the client header (`public/views/client.js`, `part2Badge()` in `public/views/part2.js`), on printed notes (print-only marker in `public/views/notes.js`), on completed-form PDFs (`printFooter()` in `server/routes/forms.js`), on the consent PDF (`GET /api/consents/:id/pdf`), on the printed accounting, and on identified exports (below). | Built |
| **Minimum necessary, §2.13(a)** — disclose only what the purpose needs. | Each disclosure records *what* was disclosed (required); a Part 2 consent must state its scope; a court order records what it permits (§2.64(e)); the disclosure form reminds staff to stay within the consent's scope; de-identified exports carry only allow-listed columns (`server/exports.js` `DEID_COLUMNS`). Whether the content is the minimum is a human judgement. | Present + Programme |
| **Minors and incapacity, §2.14–§2.15** | The consent records who signed: the patient, a parent or guardian, a personal representative or a court-appointed guardian, and that person's name (encrypted, required unless the patient signed). Which minors may consent on their own is state law. | Built + Programme |
| **Security for records and breach notification, §2.16** (2024: applies the HIPAA Breach Notification Rule, 45 CFR §§164.400–414) | Technical safeguards: docs/HIPAA.md (encryption, RBAC, caseload scoping, MFA, audit chain, backups). **Incident register** (Privacy & Part 2 → Incidents & breaches; `server/routes/compliance.js`, `server/incidents.js`): discovery date, title and description (both encrypted), people affected and most in one state, the **four-factor risk assessment** (§164.402(2)) — required before "not a breach" can be recorded — the determination and its reason, law-enforcement delay, and dates the individuals, HHS and media were told. Deadlines are computed: **60 days from discovery** for individuals; HHS at the same time when **500 or more** are affected, otherwise in the **annual log** due 60 days after the end of the calendar year; media when **more than 500** residents of one state. An incident cannot be closed while a required notice is unrecorded. Home warns within 14 days of a deadline and when one has passed. **Security events open a draft automatically**: a failed audit-chain verification (scheduled or on demand) or an audit log that no longer matches its external anchors, a break-glass access flagged as a concern at review, and an identified file naming more clients than `mass_export_threshold` (default 500) — an identified export, the county EHR hand-off, the CalOMS Tx extract or a FHIR bulk export. Written security policies (§2.16(a)(1)–(2)) are the programme's. | Built + Programme |
| **Patient notice, §2.22** (2024: aligned with the HIPAA notice of privacy practices) | An administrator-editable **notice template** (Privacy & Part 2 → Patient notice; `GET /api/part2/notice`, `PUT /api/part2/settings`), with a built-in starting text covering the required header, uses and disclosures with and without consent, the bar on use in proceedings, patient rights (restrictions, confidential communications, access, accounting, revocation, paper copy, breach notice, fundraising opt-out), programme duties, complaints to the programme and the Secretary with no retaliation, contact and effective date. Each save is a new **version**. Per client: **+ Notice given** on the Consents tab records date, method, who gave it, the version, and whether the client signed an acknowledgement or declined (`POST /api/clients/:id/part2-notices`). The Overview says when it was given or that it is missing; Home counts active clients with none; Privacy & Part 2 → Notice not given lists them (`GET /api/part2/notices/missing`). The wording is counsel's to approve. | Built + Programme |
| **Patient access, §2.23; HIPAA §164.524** | Requests tab: access requests with a 30-day clock (`server/routes/patient-requests.js`). | Present |
| **Intermediaries, §2.24** (list of disclosures by an HIE or other intermediary under a general designation) | Not applicable: SUDS is not an intermediary. A county that runs one needs its own list. | N/A |
| **Accounting of disclosures, §2.25; HIPAA §164.528** | Every disclosure — referral, manual, identified export — writes a row through `server/disclosure.js` `record()`: recipient, purpose, what, method, basis, justification, consent or **court order** relied on, whether it was for a **legal proceeding** or included **counseling notes**, and which §2.32 **notice version** went with it. The audit entry for it names the registered **agreement** relied on and whether a supervisor **overrode** the recipient check (the override's written reason is the row's justification). Printable per client from the Consents tab (`GET /api/clients/:id/disclosures/accounting`, audited). Accounting requests are tracked on the Requests tab. | Present + Built (fields) |
| **Right to request restrictions, §2.26; HIPAA §164.522** | Restriction requests are tracked on the Requests tab. Once one is **fulfilled** (agreed), every disclosure except a required one (court order, emergency, mandated report, crime on premises) is refused until the worker confirms they have checked it — on manual disclosures, referrals, referral outcomes and identified exports (`restrictionReview` in `server/disclosure.js`; the forms ask and resend). Whether a request must be agreed (e.g. services paid for out of pocket) is the programme's decision. | Built + Programme |
| **Consent content, §2.31(a)** — patient name; who may disclose; description of the information; recipients by name or class; purpose; right to revoke and how; expiration date or event; signature (of the patient or authorised person) and date; redisclosure statement; consequences of refusing to sign. | Consent types `part2_disclosure`, `part2_tpo`, `part2_counseling_notes`, `part2_proceedings` (`server/constants.js`) are **refused** unless every element is recorded (`requirePart2Elements` in `server/routes/consents.js`): the patient (the client record), `discloser` (defaults to the programme name), `scope`, `recipient`, `purpose`, `revocation_right_given`, `expires_at` or `expires_event`, `signer_relationship` / `signer_name`, `signed_at` and evidence of signature (document reference, witness or "signed on paper"), `redisclosure_notice_given`, `refusal_consequences_given`. New consents carry `rule_version = '2024'`; ones recorded earlier show **Pre-2024 form** so they can be renewed. The elements are also checked on a consent **pushed from a device** (`server/routes/sync.js`; refused with the missing elements named, which the device shows as a sync conflict) and **re-checked whenever a consent is relied on** (`consentElementProblems` in `server/disclosure.js`), so a consent that reached the database any other way authorises nothing. A **legacy** consent (recorded before the 2024 element list, `rule_version` NULL) can still authorise a disclosure only if it records the pre-2024 elements SUDS captured — recipient, purpose, what information, an expiry date or event, and evidence of signature — **and** was signed before the 2024 rule's compliance date (16 February 2026); one signed on or after that date must be on the 2024 form. (Who may disclose was this programme; the revocation statement was on the programme's printed pre-2024 form, which the evidence of signature points to. Counsel should confirm this reading for the county's legacy forms.) The Consents tab marks a consent that cannot authorise a disclosure and says what it lacks. **Print** on each consent produces a PDF listing every element with the §2.32 notice. The consent form (`openConsentForm` in `public/views/part2.js`) marks every element. The consent's own wording is the programme's form. | Present + Built |
| **Single consent for TPO, §2.31(a)(4)(iii), (a)(5)(ii)** | Consent type `part2_tpo`; the form starts on it with the rule's sufficient wording for the recipient class and purpose. It authorises referrals and disclosures for treatment, payment and operations, never counseling notes or a proceeding — to a recipient it **names**, alone or within its class wording. The rule's class wording on its own ("my treating providers") names nobody SUDS can match; add the organisations' names to the consent, or a supervisor overrides with a written justification. | Built |
| **Recipients, §2.31(a)(4); §2.13(a)** — a consent authorises disclosure to the recipients it names. | Every path — referral, manual disclosure, identified export, county EHR hand-off, FHIR — checks the recipient against the consent with one function (`consentNamesRecipient` in `server/disclosure.js`; the rules are under **The disclosure gate** below). A referral is checked against the resource's name and organisation. Refused with **409** and the consent's recipient named; a supervisor or administrator may override with a written justification (`recipient_override` / `_recipient_override`, `disclosures:override`), which is audited and kept with the accounting record. Files under consent leave out the clients whose consent does not name the stated recipient and list them by code. | Built (migration 32) |
| **General authorisation is not enough, §2.31, §2.32** | In a Part 2 programme a general **ROI** cannot be relied on as consent: `requireBasis` refuses it with that explanation (it still records a non-Part 2 release, e.g. for housing). | Built |
| **Revocation, §2.31(a)(6)** | `POST /api/consents/:id/revoke` (reason recorded); revocation flags every open referral that relied on the consent; a revoked or expired consent can no longer authorise anything; sync can only revoke, never rewrite. | Present |
| **SUD counseling notes, §2.11, §2.31(b)** | A clinical note can be marked **SUD counseling note** (`notes.counseling_note`; only clinical notes). A disclosure that includes counseling notes must say so and is refused unless it rests on a `part2_counseling_notes` consent (which in turn covers nothing else) or a court order that expressly covers them. Notes never appear in exports, and counseling notes are never listed over FHIR (not even as DocumentReference metadata). | Built |
| **Consent for use in proceedings is separate, §2.31(d)** | Consent type `part2_proceedings` may be used only for a disclosure marked as for a legal proceeding, and a proceeding cannot rest on any other consent. | Built |
| **Notice to accompany disclosure, §2.32** (2024 wording) | The full 2024 text and the abbreviated form are constants (`PART2_REDISCLOSURE_NOTICE`, `PART2_NOTICE_SHORT` in `server/constants.js`, served to the browser with the other constants). A disclosure recorded under consent returns the notice, and the form shows it ready to copy onto the fax cover, letter or email. **Identified exports** carry it: Excel on the About sheet, CSV as the last row, and the abbreviated form in the `X-SUDS-Export` header. Completed-form PDFs, the consent PDF, the printed accounting and printed notes carry it too, as do the county EHR hand-off (About sheet / last CSV row), the CalOMS Tx extract's README, and every FHIR Bundle, bulk-export manifest and `OperationOutcome` — one text, `disclosure.notice()`. The starter Part 2 consent form's footer is the 2024 text. | Built |
| **Prohibition on use in proceedings against the patient, §2.12(d)(1); court orders, subpart E (§§2.61–2.67)** | **Court orders** are recorded per client (Consents tab → Court orders; `POST /api/clients/:id/court-orders`, supervisors and administrators; front-line staff can read): the kind of order (§2.64 non-criminal, §2.65 criminal investigation of the patient, §2.66 investigation of the programme, §2.67 undercover), court and case (encrypted), dates, recipient, purpose, what it permits, whether it records the required **findings** and whether the **notice and opportunity to respond** requirement was met, and whether it covers counseling notes. An order missing either is recorded but **cannot authorise a disclosure**; neither can a vacated or expired one. The `court_order` basis now requires a qualifying order for the same client, and any disclosure marked **for use in a legal proceeding** is refused unless it rests on such an order or a `part2_proceedings` consent. Identified exports cannot be made for a proceeding at all. A subpoena alone never suffices; the screens say so. The client's **legal hold** is a retention control (litigation hold), **not** authority to disclose. Whether an order meets subpart E is counsel's call. | Built + Programme |
| **Internal communications, §2.12(c)(3); QSO, §2.11, §2.12(c)(4); crime on premises, §2.12(c)(5); child abuse reporting, §2.12(c)(6)** | `internal` (exports only): the stated recipient must be this programme (its name under Settings) or one of its active staff — no identified file leaves as "internal". `qsoa`: the **agreements register** (Privacy & Part 2 → Agreements; `GET/POST /api/disclosure-agreements`, `POST /api/disclosure-agreements/:id/end`; table `disclosure_agreements`, kept by supervisors and administrators with `agreements:write`, read by everyone who records disclosures) holds each QSOA — organisation and its other names, services, date signed, expiry, where the signed agreement is kept; a QSOA disclosure (manual, export, hand-off) must rest on a live one whose organisation is the recipient (named with `agreement_id`, or found by the recipient's name). `crime_on_premises`, `child_abuse_report`: a supervisor or administrator (`disclosures:override`) and a written justification (≥ 20 characters). None of them can be a referral's basis. All accounted for. | Built (migration 32) |
| **Medical emergency, §2.51** | Basis `medical_emergency` requires a written justification (≥ 20 characters). | Present |
| **Research, §2.52; audit and evaluation, §2.53** | Bases `research`, `audit_evaluation`: a supervisor or administrator (`disclosures:override`), and a registered **approval** on the agreements register — the IRB, privacy board or oversight body, its reference and dates — whose organisation is the recipient. Identified exports state one of `consent`, `audit_evaluation`, `research`, `qsoa`, `internal`; with `consent`, only the clients whose live Part 2 consent names the stated recipient are in the file (the rest are left out and listed by code in the `X-SUDS-Export-Excluded` header and on the About sheet). De-identified exports follow HIPAA Safe Harbor (§164.514(b)(2)), which the 2024 rule adopts: dates reduced to the year, ages over 89 as `90+`, ZIP codes to three digits (`000` for sparsely populated areas), no free text, and a record id drawn at random for each export instead of the client code ([HIPAA.md](../HIPAA.md)). | Built (migration 32) |
| **Automated and system disclosures: FHIR API, county EHR hand-off, CalOMS Tx** | All three write through `server/disclosure.js` `record()` with the same accounting fields (notice version, `legal_proceeding = 0`, `counseling_notes = 0`). **FHIR** (`fhirCoverage`, docs/integration/FHIR.md): only for clients whose consent `requireBasis` would accept without a further question — `part2_disclosure` naming the organisation for the purpose of use, or `part2_tpo` naming it (alone or in a class wording); a general ROI only when `part2_program` is off; never a counseling-notes or proceedings consent; clients with an agreed restriction are withheld. **County EHR hand-off** (`server/routes/handoff.js`): its own basis choice (each client's consent naming the recipient — the others are left out and listed by code — a registered QSOA with the recipient, or a justified "other"), consent types as for a consent-based export (`fileConsentTypes`), the agreed-restriction confirmation (`requireRestrictionReview`), never a proceeding. **CalOMS Tx** (`server/routes/caloms.js`): required by law, recorded under the fixed `state_reporting` basis — no basis to choose, no consent checked, not stoppable by an agreed restriction (§164.522(a)(1)(v)). **Downloading** the extract is a test / preview: audited (`caloms.extract`, `preview: true`) and labelled so in its header, but nobody's accounting changes. **Mark as submitted** (`POST /api/caloms/submissions`, `export:identified`) is the disclosure: one accounting row per client in the extract for that period, the records stamped as sent, audited as `caloms.submitted`. | Built |
| **Complaints, §2.4** — a patient may complain to the programme and to the Secretary; no retaliation. | **Complaint log** (Privacy & Part 2 → Complaints; `/api/complaints`, supervisors and administrators, every read and write audited): received date, channel, from whom (a client, a representative, staff, anonymous — an anonymous complaint cannot name a client), summary (encrypted), status, resolution (encrypted, required to close), whether the complainant was told they may complain to **HHS**, and a **no-retaliation check**. Never deleted. Report: `GET /api/complaints/report`. Home counts open complaints. The complaint procedure itself is the programme's. | Built + Programme |
| **Disposition of records, §2.19; retention** | `server/retention.js` purges a discharged client's record from every table (court orders, notices and disclosures included) after the retention period; complaints are kept and unlinked; legal hold exempts. An **incident's link** to an affected client is kept as breach documentation (six years, §164.530(j)): the snapshot taken when the client was linked — client code and name (encrypted) — stays, the link to the purged record is unset, and the purge date is recorded (`privacy_incident_clients`, migration 32). | Present (+ new tables) |
| **Audit of access** | Every PHI read and write is audited in the hash-chained log, including every consent, disclosure, court order, notice, complaint and incident action. | Present |

## The disclosure gate

Every disclosure passes `requireBasis` (one client) or `requireExportBasis` (a file) in
`server/disclosure.js`; the FHIR API uses `consentCovers`, built on the same recipient match.

| Basis | Needs | Who | Referral? |
| --- | --- | --- | --- |
| `consent` | a live consent of a disclosing type, with the §2.31 elements, that **names the recipient** | anyone who records disclosures | yes |
| `court_order` | a qualifying subpart E order on file for the client | anyone who records disclosures | yes |
| `medical_emergency` (§2.51) | a written justification | anyone who records disclosures | yes |
| `other` | a written justification | supervisor / administrator | yes |
| `qsoa` (§2.12(c)(4)) | a live registered QSOA whose organisation is the recipient | anyone who records disclosures | no |
| `research` (§2.52) | a live registered research approval (IRB / privacy board) whose organisation is the recipient | supervisor / administrator | no |
| `audit_evaluation` (§2.53) | a live registered audit or evaluation approval whose organisation is the recipient | supervisor / administrator | no |
| `crime_on_premises` (§2.12(c)(5)), `child_abuse_report` (§2.12(c)(6)) | a written justification | supervisor / administrator | no |
| `internal` (§2.12(c)(3), exports only) | the recipient is this programme or one of its active staff | whoever may make identified exports | — |

**Recipient match** (`consentNamesRecipient`, used on every path including FHIR). Names are compared
normalised — case, accents, punctuation and spacing do not matter:

* a consent to a named recipient (`part2_disclosure`, and every other type) covers exactly the name it
  gives: "Agency A only" does not cover "Agency A", and a list or a class does not cover its members;
* the single TPO consent (`part2_tpo`) covers an organisation it names, alone or within a list or class
  wording ("County Behavioral Health and my other treating providers" covers County Behavioral Health); a
  class with no name in it covers nobody SUDS can match;
* a recipient is known by all its registered names: a referral's resource by its name and organisation,
  and any organisation on the agreements register, or registered as a FHIR client, by its other names.

When the consent does not name the recipient the disclosure is refused with **409** and a message giving
the consent's recipient. A supervisor or administrator may **override** — they have read the consent and it
does cover this recipient (a class, a variant spelling) — with a written justification of at least 20
characters: the disclosure row's justification begins "Recipient override", and its audit entry carries
`recipient_override: true`. Files (identified exports, the hand-off) have no override: a client not covered
is left out and listed by code.

**Before this review**, only the FHIR API matched the recipient; the human paths accepted any live consent.
Disclosures recorded before migration 32 were not checked against their recipient, and the non-consent bases
recorded before it rested on nothing on file. A privacy officer reviewing the accounting for that period
should look at `consent`, `qsoa`, `research`, `audit_evaluation`, `crime_on_premises` and
`child_abuse_report` disclosures made by front-line roles.

## Operating SUDS as a Part 2 programme

**Once, as administrator**

1. Privacy & Part 2 → Overview: confirm *This is a 42 CFR Part 2 programme* is ticked (the default).
2. Patient notice: replace the built-in text with the wording counsel has approved, set the effective date,
   and save. Print copies for the front desk.
3. Forms: install the starter *Consent to release information (42 CFR Part 2)* and have counsel adapt it.
4. Set the **mass export threshold** to what your privacy officer wants to review.
5. Decide who holds the registers: supervisors and administrators hold complaints, incidents, court
   orders and agreements by default (`complaints:*`, `incidents:*`, `court-orders:*`, `agreements:*` in
   `server/auth.js`).
6. Privacy & Part 2 → Agreements: register each qualified service organization agreement, and each IRB or
   oversight approval for research or an audit, with every name the organisation goes by. Until one is on
   file, nothing can be disclosed on that basis.

**At intake (front-line staff)**

1. Give the client the notice; record **+ Notice given** on the Consents tab (the Overview and Home remind
   you until you do).
2. Record the client's consents. Usually one **treatment, payment & operations** consent; a separate one
   for anything outside it, for counseling notes, or for a legal proceeding. Tick each statement only when
   the signed form actually contains it.

**Sharing information**

* A referral that names the client needs a live Part 2 consent **that names the provider** (or its
  organisation), a medical emergency, a court order, or a supervisor's justified override — SUDS refuses
  otherwise and records the disclosure itself. Write the providers' names on the TPO consent: the class
  wording alone ("my treating providers") names nobody SUDS can check.
* Anything else shared: Consents tab → **+ Disclosure**. Send the §2.32 notice SUDS shows you with any
  written disclosure.
* For a court, a lawyer or an investigator: never on a subpoena alone. Record the court order first (a
  supervisor), then the disclosure, ticked *for use in a legal proceeding*.
* Identified exports (supervisors and administrators): state the lawful basis; the file carries the notice.
  Under consent, clients whose consent does not name the recipient are left out and listed.
* CalOMS Tx: download the extract (a test / preview), submit it to DHCS, then **Mark as submitted** — that
  is when it is written to each client's accounting of disclosures.

**When something goes wrong**

* Record every possible breach under Privacy & Part 2 → Incidents & breaches the day it is discovered.
  Complete the four-factor assessment, make the determination, and record each notice as it is sent. The
  deadlines on the screen are the outer limits, not targets.
* Record every privacy complaint under Complaints, tell the complainant they may also complain to HHS, and
  check no adverse action followed.

## What the programme must supply

* Consent, notice and revocation **wording** approved by counsel; staff **training** on Part 2 and the 2024
  changes; written **security and breach policies** (§2.16); a **complaint procedure** (§2.4); a named
  **privacy officer** (shown on the sign-in page from `program_contact`).
* Legal judgement on each court order, each restriction request, each breach determination and each
  unusual disclosure. SUDS records the decision and the reasons; it does not make them.
* Breach **notices themselves** (letters, the HHS portal submission, media notice) and substitute notice
  where contact details are out of date.
* State law: minors' consent, mandatory reporting, and any retention period longer than seven years.

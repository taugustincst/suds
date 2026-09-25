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

## Control matrix

| Requirement | Where SUDS implements it | Status |
| --- | --- | --- |
| **Applicability, §2.11–§2.12** — Part 2 covers records of a federally assisted programme that identify a patient as having a SUD. | Setting `part2_program` (on by default) — Privacy & Part 2 → Overview (`PUT /api/part2/settings`, `server/routes/part2.js`). While on: the client header shows the **42 CFR Part 2** label, general releases are refused as consent, and every disclosure, export and printout carries the §2.32 notice. Notes default to `part2_protected` and show the label. | Built (setting, label); Present (note flag) |
| **Labelling / segmentation, §2.12(d)(2), §2.32** — records received under Part 2 need not be segregated, but what is disclosed must carry the notice. | Records are not segregated (not required). The label is on the client header (`public/views/client.js`, `part2Badge()` in `public/views/part2.js`), on printed notes (print-only marker in `public/views/notes.js`), on completed-form PDFs (`printFooter()` in `server/routes/forms.js`), on the consent PDF (`GET /api/consents/:id/pdf`), on the printed accounting, and on identified exports (below). | Built |
| **Minimum necessary, §2.13(a)** — disclose only what the purpose needs. | Each disclosure records *what* was disclosed (required); a Part 2 consent must state its scope; a court order records what it permits (§2.64(e)); the disclosure form reminds staff to stay within the consent's scope; de-identified exports carry only allow-listed columns (`server/exports.js` `DEID_COLUMNS`). Whether the content is the minimum is a human judgement. | Present + Programme |
| **Minors and incapacity, §2.14–§2.15** | The consent records who signed: the patient, a parent or guardian, a personal representative or a court-appointed guardian, and that person's name (encrypted, required unless the patient signed). Which minors may consent on their own is state law. | Built + Programme |
| **Security for records and breach notification, §2.16** (2024: applies the HIPAA Breach Notification Rule, 45 CFR §§164.400–414) | Technical safeguards: docs/HIPAA.md (encryption, RBAC, caseload scoping, MFA, audit chain, backups). **Incident register** (Privacy & Part 2 → Incidents & breaches; `server/routes/compliance.js`, `server/incidents.js`): discovery date, description (encrypted), people affected and most in one state, the **four-factor risk assessment** (§164.402(2)) — required before "not a breach" can be recorded — the determination and its reason, law-enforcement delay, and dates the individuals, HHS and media were told. Deadlines are computed: **60 days from discovery** for individuals; HHS at the same time when **500 or more** are affected, otherwise in the **annual log** due 60 days after the end of the calendar year; media when **more than 500** residents of one state. An incident cannot be closed while a required notice is unrecorded. Home warns within 14 days of a deadline and when one has passed. **Security events open a draft automatically**: a failed audit-chain verification (scheduled or on demand) or an audit log that no longer matches its external anchors, a break-glass access flagged as a concern at review, and an identified file naming more clients than `mass_export_threshold` (default 500) — an identified export, the county EHR hand-off, the CalOMS Tx extract or a FHIR bulk export. Written security policies (§2.16(a)(1)–(2)) are the programme's. | Built + Programme |
| **Patient notice, §2.22** (2024: aligned with the HIPAA notice of privacy practices) | An administrator-editable **notice template** (Privacy & Part 2 → Patient notice; `GET /api/part2/notice`, `PUT /api/part2/settings`), with a built-in starting text covering the required header, uses and disclosures with and without consent, the bar on use in proceedings, patient rights (restrictions, confidential communications, access, accounting, revocation, paper copy, breach notice, fundraising opt-out), programme duties, complaints to the programme and the Secretary with no retaliation, contact and effective date. Each save is a new **version**. Per client: **+ Notice given** on the Consents tab records date, method, who gave it, the version, and whether the client signed an acknowledgement or declined (`POST /api/clients/:id/part2-notices`). The Overview says when it was given or that it is missing; Home counts active clients with none; Privacy & Part 2 → Notice not given lists them (`GET /api/part2/notices/missing`). The wording is counsel's to approve. | Built + Programme |
| **Patient access, §2.23; HIPAA §164.524** | Requests tab: access requests with a 30-day clock (`server/routes/patient-requests.js`). | Present |
| **Intermediaries, §2.24** (list of disclosures by an HIE or other intermediary under a general designation) | Not applicable: SUDS is not an intermediary. A county that runs one needs its own list. | N/A |
| **Accounting of disclosures, §2.25; HIPAA §164.528** | Every disclosure — referral, manual, identified export — writes a row through `server/disclosure.js` `record()`: recipient, purpose, what, method, basis, justification, consent or **court order** relied on, whether it was for a **legal proceeding** or included **counseling notes**, and which §2.32 **notice version** went with it. Printable per client from the Consents tab (`GET /api/clients/:id/disclosures/accounting`, audited). Accounting requests are tracked on the Requests tab. | Present + Built (fields) |
| **Right to request restrictions, §2.26; HIPAA §164.522** | Restriction requests are tracked on the Requests tab. Once one is **fulfilled** (agreed), every disclosure except a required one (court order, emergency, mandated report, crime on premises) is refused until the worker confirms they have checked it — on manual disclosures, referrals, referral outcomes and identified exports (`restrictionReview` in `server/disclosure.js`; the forms ask and resend). Whether a request must be agreed (e.g. services paid for out of pocket) is the programme's decision. | Built + Programme |
| **Consent content, §2.31(a)** — patient name; who may disclose; description of the information; recipients by name or class; purpose; right to revoke and how; expiration date or event; signature (of the patient or authorised person) and date; redisclosure statement; consequences of refusing to sign. | Consent types `part2_disclosure`, `part2_tpo`, `part2_counseling_notes`, `part2_proceedings` (`server/constants.js`) are **refused** unless every element is recorded (`requirePart2Elements` in `server/routes/consents.js`): the patient (the client record), `discloser` (defaults to the programme name), `scope`, `recipient`, `purpose`, `revocation_right_given`, `expires_at` or `expires_event`, `signer_relationship` / `signer_name`, `signed_at` and evidence of signature (document reference, witness or "signed on paper"), `redisclosure_notice_given`, `refusal_consequences_given`. New consents carry `rule_version = '2024'`; ones recorded earlier show **Pre-2024 form** so they can be renewed. **Print** on each consent produces a PDF listing every element with the §2.32 notice. The consent form (`openConsentForm` in `public/views/part2.js`) marks every element. The consent's own wording is the programme's form. | Present + Built |
| **Single consent for TPO, §2.31(a)(4)(iii), (a)(5)(ii)** | Consent type `part2_tpo`; the form starts on it with the rule's sufficient wording for the recipient class and purpose. It authorises referrals and disclosures for treatment, payment and operations, never counseling notes or a proceeding. | Built |
| **General authorisation is not enough, §2.31, §2.32** | In a Part 2 programme a general **ROI** cannot be relied on as consent: `requireBasis` refuses it with that explanation (it still records a non-Part 2 release, e.g. for housing). | Built |
| **Revocation, §2.31(a)(6)** | `POST /api/consents/:id/revoke` (reason recorded); revocation flags every open referral that relied on the consent; a revoked or expired consent can no longer authorise anything; sync can only revoke, never rewrite. | Present |
| **SUD counseling notes, §2.11, §2.31(b)** | A clinical note can be marked **SUD counseling note** (`notes.counseling_note`; only clinical notes). A disclosure that includes counseling notes must say so and is refused unless it rests on a `part2_counseling_notes` consent (which in turn covers nothing else) or a court order that expressly covers them. Notes never appear in exports, and counseling notes are never listed over FHIR (not even as DocumentReference metadata). | Built |
| **Consent for use in proceedings is separate, §2.31(d)** | Consent type `part2_proceedings` may be used only for a disclosure marked as for a legal proceeding, and a proceeding cannot rest on any other consent. | Built |
| **Notice to accompany disclosure, §2.32** (2024 wording) | The full 2024 text and the abbreviated form are constants (`PART2_REDISCLOSURE_NOTICE`, `PART2_NOTICE_SHORT` in `server/constants.js`, served to the browser with the other constants). A disclosure recorded under consent returns the notice, and the form shows it ready to copy onto the fax cover, letter or email. **Identified exports** carry it: Excel on the About sheet, CSV as the last row, and the abbreviated form in the `X-SUDS-Export` header. Completed-form PDFs, the consent PDF, the printed accounting and printed notes carry it too, as do the county EHR hand-off (About sheet / last CSV row), the CalOMS Tx extract's README, and every FHIR Bundle, bulk-export manifest and `OperationOutcome` — one text, `disclosure.notice()`. The starter Part 2 consent form's footer is the 2024 text. | Built |
| **Prohibition on use in proceedings against the patient, §2.12(d)(1); court orders, subpart E (§§2.61–2.67)** | **Court orders** are recorded per client (Consents tab → Court orders; `POST /api/clients/:id/court-orders`, supervisors and administrators; front-line staff can read): the kind of order (§2.64 non-criminal, §2.65 criminal investigation of the patient, §2.66 investigation of the programme, §2.67 undercover), court and case (encrypted), dates, recipient, purpose, what it permits, whether it records the required **findings** and whether the **notice and opportunity to respond** requirement was met, and whether it covers counseling notes. An order missing either is recorded but **cannot authorise a disclosure**; neither can a vacated or expired one. The `court_order` basis now requires a qualifying order for the same client, and any disclosure marked **for use in a legal proceeding** is refused unless it rests on such an order or a `part2_proceedings` consent. Identified exports cannot be made for a proceeding at all. A subpoena alone never suffices; the screens say so. The client's **legal hold** is a retention control (litigation hold), **not** authority to disclose. Whether an order meets subpart E is counsel's call. | Built + Programme |
| **Internal communications, §2.12(c)(3); QSO, §2.12(c)(4); crime on premises, §2.12(c)(5); child abuse reporting, §2.12(c)(6)** | Lawful bases `internal` (exports only), `qsoa`, `crime_on_premises`, `child_abuse_report` in `server/disclosure.js`; all accounted for. | Present (+ `internal` Built) |
| **Medical emergency, §2.51** | Basis `medical_emergency` requires a written justification (≥ 20 characters). | Present |
| **Research, §2.52; audit and evaluation, §2.53** | Bases `research`, `audit_evaluation`. Identified exports must now state one of `consent`, `audit_evaluation`, `research`, `qsoa`, `internal`; with `consent`, every client in the file must have a live Part 2 consent. De-identified exports follow HIPAA Safe Harbor (§164.514(b)), which the 2024 rule adopts. | Present + Built |
| **Automated and system disclosures: FHIR API, county EHR hand-off, CalOMS Tx** | All three write through `server/disclosure.js` `record()` with the same accounting fields (notice version, `legal_proceeding = 0`, `counseling_notes = 0`). **FHIR** (`fhirCoverage`, docs/integration/FHIR.md): only for clients whose consent `requireBasis` would accept without a further question — `part2_disclosure` naming the organisation for the purpose of use, or `part2_tpo` naming it (alone or in a class wording); a general ROI only when `part2_program` is off; never a counseling-notes or proceedings consent; clients with an agreed restriction are withheld. **County EHR hand-off** (`server/routes/handoff.js`): its own basis choice (each client's consent, QSOA, or a justified "other"), consent types as for a consent-based export (`fileConsentTypes`), the agreed-restriction confirmation (`requireRestrictionReview`), never a proceeding. **CalOMS Tx** (`server/routes/caloms.js`): required by law, recorded under the fixed `state_reporting` basis — no basis to choose, no consent checked, not stoppable by an agreed restriction (§164.522(a)(1)(v)). | Built |
| **Complaints, §2.4** — a patient may complain to the programme and to the Secretary; no retaliation. | **Complaint log** (Privacy & Part 2 → Complaints; `/api/complaints`, supervisors and administrators, every read and write audited): received date, channel, from whom (a client, a representative, staff, anonymous — an anonymous complaint cannot name a client), summary (encrypted), status, resolution (encrypted, required to close), whether the complainant was told they may complain to **HHS**, and a **no-retaliation check**. Never deleted. Report: `GET /api/complaints/report`. Home counts open complaints. The complaint procedure itself is the programme's. | Built + Programme |
| **Disposition of records, §2.19; retention** | `server/retention.js` purges a discharged client's record from every table (court orders, notices and disclosures included) after the retention period; complaints are kept and unlinked; legal hold exempts. | Present (+ new tables) |
| **Audit of access** | Every PHI read and write is audited in the hash-chained log, including every consent, disclosure, court order, notice, complaint and incident action. | Present |

## Operating SUDS as a Part 2 programme

**Once, as administrator**

1. Privacy & Part 2 → Overview: confirm *This is a 42 CFR Part 2 programme* is ticked (the default).
2. Patient notice: replace the built-in text with the wording counsel has approved, set the effective date,
   and save. Print copies for the front desk.
3. Forms: install the starter *Consent to release information (42 CFR Part 2)* and have counsel adapt it.
4. Set the **mass export threshold** to what your privacy officer wants to review.
5. Decide who holds the registers: supervisors and administrators hold complaints, incidents and court
   orders by default (`complaints:*`, `incidents:*`, `court-orders:*` in `server/auth.js`).

**At intake (front-line staff)**

1. Give the client the notice; record **+ Notice given** on the Consents tab (the Overview and Home remind
   you until you do).
2. Record the client's consents. Usually one **treatment, payment & operations** consent; a separate one
   for anything outside it, for counseling notes, or for a legal proceeding. Tick each statement only when
   the signed form actually contains it.

**Sharing information**

* A referral that names the client needs a live Part 2 consent (or another lawful basis) — SUDS refuses
  otherwise and records the disclosure itself.
* Anything else shared: Consents tab → **+ Disclosure**. Send the §2.32 notice SUDS shows you with any
  written disclosure.
* For a court, a lawyer or an investigator: never on a subpoena alone. Record the court order first (a
  supervisor), then the disclosure, ticked *for use in a legal proceeding*.
* Identified exports (supervisors and administrators): state the lawful basis; the file carries the notice.

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

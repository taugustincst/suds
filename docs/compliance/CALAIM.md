# CalAIM documentation alignment

SUDS is built for non-billing substance use programmes — prevention, harm reduction, outreach, navigation and case management. Counties still review it against the **CalAIM Behavioral Health Documentation Redesign** (DHCS Behavioral Health Information Notice 22-019, superseded by BHIN 23-068), because the same staff and clients move between these programmes and Medi-Cal behavioural health services. This page maps what the redesign asks for to where SUDS does it, and says plainly what SUDS does not do.

The redesign's requirements are summarised here in our own words. Check the current BHIN and your county's DMC-ODS / SMHS documentation manual before relying on this for a Medi-Cal audit; DHCS updates them.

## What the redesign asks for, and where SUDS does it

| Redesign expectation | Where it is in SUDS | Notes |
|---|---|---|
| **Problem list** kept current: diagnoses (ICD-10-CM), social determinants of health (Z codes, Z55–Z65), and problems the client or other providers identify; who added each and when; problems resolved or removed as they change | Client → **Problems** tab (`problems` table; `GET/POST /api/clients/:id/problems`, `PUT /api/problems/:id`) | Problem text and codes are encrypted. ICD-10-CM codes are format-checked, not looked up (no code set is bundled). A built-in list of common Z55–Z65 codes is offered; any code in that range is accepted. Source: self-report, assessment, referral, other. Onset and resolved dates. Never deleted — resolved or inactive — and every change (who, when, old and new value) is kept in `problem_history`. |
| **Progress notes** that describe the service and how it addressed the client's needs, tied to the problem list; date, author, signature | **Notes** (existing: date of service, author, electronic signature with password re-entry, co-signature, addenda, tamper check) + **Problems this note addresses** on the note form (`notes.problem_ids`) | The linked problems are shown on the note; the Problems tab counts the notes per problem. A signed note (and its problem links) cannot change. Service type, duration, location and modality are on the linked **Intervention**; travel and documentation time are **Time** entries. |
| **Timeliness** of notes | Notes are saved as drafts and signed; **Supervision** lists unsigned drafts and notes awaiting countersignature | SUDS does not enforce a county's business-day deadline; supervisors see what is outstanding. |
| **Assessment** by domain — for DMC-ODS, the **ASAM Criteria** multidimensional assessment and level-of-care determination | Client → **Assessments → Six-dimension assessments (ASAM-aligned)** (`asam_assessments`; `/api/clients/:id/asam`) | A 0–4 risk rating per dimension with the reasoning (encrypted), the level of care recommended, the level referred to, and the reason for any difference (required when they differ). The latest sets the client's *ASAM level* and appears on the Overview; history is kept. Only dimension names (ASAM 3rd edition, as DHCS cites) and 0–4 ratings are stored. **SUDS does not include the ASAM Criteria**, which are copyrighted; "ASAM" is a trademark of the American Society of Addiction Medicine, and SUDS is not endorsed by ASAM. A programme that uses the Criteria for the rating definitions needs its own licence from ASAM. |
| **Care coordination** and, where still required (e.g. targeted case management, peer support), a **care plan** | Client → **Care plan** (`care_plan_goals`, `care_plan_steps`; `/api/clients/:id/care-plan`) | Goals in the client's own words, tied to problems; steps with who does them (client, staff, family/support, other provider) and by when; a step can create a to-do. Review date with an overdue alert on the plan and the Overview; *Reviewed* records the review. Printable one-page plan with signature lines. Referrals, warm hand-offs, consents and disclosures (existing) record the coordination with other providers. |
| **Screening and outcome information** used to guide care | Client → **Assessments → Outcome measures** (`outcome_measures`; `/api/clients/:id/outcomes`), **Reports → Outcome measures** | PHQ-9, GAD-7, AUDIT-C, a 0–10 self-rated wellbeing item and, when an administrator has enabled it, the DAST-10, scored automatically with published bands; answers encrypted; trend on the client page. PHQ-9 question 9 above "Not at all" raises a safety alert on save (urgent to-do, link to the safety plan). Programme report: baseline vs latest, mean change, % improved; de-identified CSV export (client code, months, scores). |
| **Safety planning** where risk is identified | Notes in the **Safety plan** format (existing), linked from the PHQ-9 alert and shown as a chip on the client page | |
| Confidentiality of SUD records (42 CFR Part 2) | Everything above is encrypted at rest, caseload-scoped, audited on every read and write, and synchronised to devices only for roles that may read it | See `docs/HIPAA.md`. |

## Who can do what

| | Problem list & care plan (`careplan:*`) | Six-dimension assessments & outcome measures (`assessments:*`) | Outcomes report (aggregate) | Outcomes export |
|---|---|---|---|---|
| Navigator | read / write (own caseload) | — | yes | de-identified |
| Clinician | read / write (own caseload) | read / write (own caseload) | yes | de-identified |
| Supervisor | read / write (all) | read / write (all) | yes | de-identified |
| Administrator | read | — (clinical content, as clinical notes) | yes | de-identified |
| Finance, read-only | — | — | yes (aggregate only) | finance: de-identified; read-only: none |

## Instruments

| Instrument | Items | Scoring in SUDS | Licence |
|---|---|---|---|
| PHQ-9 | 9, 0–3 each | 0–4 minimal, 5–9 mild, 10–14 moderate, 15–19 moderately severe, 20–27 severe; item 9 > 0 is a safety alert | Pfizer: no permission required to reproduce, translate, display or distribute |
| GAD-7 | 7, 0–3 each | 0–4 minimal, 5–9 mild, 10–14 moderate, 15–21 severe | Pfizer: as PHQ-9 |
| AUDIT-C | 3, 0–4 each | positive at 4+ (men) or 3+ (women); 3+ when not specified | WHO AUDIT questions: public domain |
| DAST-10 (optional, **off by default**) | 10, yes/no (question 3 reverse scored) | 0 none, 1–2 low, 3–5 moderate, 6–8 substantial, 9–10 severe | © Harvey A. Skinner; free for non-commercial clinical use with credit (the credit is shown on the form). Because SUDS may be supplied commercially, an administrator turns it on (Settings → Screening instruments) only after confirming the programme holds the rights to use it; the confirmation, who gave it and when are recorded and audited. Results already recorded stay visible if it is turned off. |
| Wellbeing | 1, 0–10 | 0–3 low, 4–6 moderate, 7–10 good; higher is better | Written for SUDS; not a validated instrument |

## Instrument licensing — for counsel

SUDS's licence (MIT) covers SUDS's own code, not third-party instruments. Before a paid pilot, vendor and programme counsel should confirm:

* **DAST-10** — the author's terms cover non-commercial clinical, research and training use with credit. Confirm that the programme's use (and, for a vendor-hosted or paid offering, the vendor's) is covered, or obtain permission from the copyright holder. SUDS keeps the DAST-10 off until an administrator confirms this.
* **ASAM Criteria and the "ASAM" name** — SUDS stores only the six dimension names and 0–4 ratings and labels the feature "six-dimension assessment (ASAM-aligned)"; it includes no Criteria text. A programme that uses The ASAM Criteria needs its own licence from ASAM. Level-of-care numbers (1.0, 2.1, 3.5…) are recorded as DHCS uses them.
* PHQ-9, GAD-7 (no permission required) and AUDIT-C (public domain) need no licence.

**Left out on purpose:** BAM (Brief Addiction Monitor), BARC-10, ARC and other instruments whose terms for use inside software could not be confirmed. A programme that holds a licence can build one as a county form (**Forms**), where it is stored and printed but not scored.

## Out of scope

SUDS does not do, and does not plan to do:

* **Billing and claims** — no CPT/HCPCS service coding, claim generation, 837 files, Medi-Cal eligibility checks or remittance. Programmes that bill Medi-Cal do so from their certified EHR.
* **eMAR** (electronic medication administration records) and **e-prescribing (eRx)**, including EPCS. MAT/MOUD status and medication are recorded as facts on the client record only.
* The **SMHS seven-domain assessment** content, **CANS** / **PSC-35**, and the DHCS **Adult/Youth Screening Tools** and **Transition of Care Tool** as built-in forms. A county can load its own versions as county forms.
* **Enforcing** a county's documentation deadlines, lock-out rules or medical-necessity determinations. SUDS surfaces what is outstanding (unsigned notes, overdue reviews); the county's policy decides what follows.

# What SUDS is for, and where it stops

SUDS is the operations system for **harm-reduction and outreach programmes, prevention-funded outreach included**:
outreach encounters (named or anonymous), naloxone and supply distribution, and grant/funder reporting, with
privacy controls built to support 42 CFR Part 2. Its users are community-based organisations and county programmes doing outreach, harm
reduction, naloxone and test-strip distribution, prevention and navigation, funded by opioid-settlement money,
SOR / the Naloxone Distribution Project, SABG prevention funds and similar grants. "Prevention" here means
prevention-funded outreach and distribution, and, since 1.17.0, **group and community prevention events** (SABG
primary prevention): each event's date, kind, CSAP strategy, IOM population category, audience, place, hours,
attendance (a headcount, never names; marked when estimated) and fund, with a *prevention activity summary* by
strategy and IOM category, including the people trained, as CSV or Excel. SUDS does **not** produce a PPSDS
submission file: the mapping of its fields to DHCS's Primary Prevention SUD Data Service awaits the DHCS PPSDS data
dictionary. It does not record an evidence-based programme's name or registry, attendance by demographic group, or
who attended (no participant lists).

## Core and optional modules

| | What | Who it is for |
| --- | --- | --- |
| **Core** | Outreach encounters, calls and texts; anonymous community distribution; overdose and reversal events; supplies by item, site and lot with a receiving log, transfers, adjustments, disposal of expired stock and first-expiry-first-out draw-down by visits, and syringe services (syringes and sharps returned, a syringe services summary; [SUPPLIES.md](SUPPLIES.md)); referrals and the resource directory; consents, the accounting of disclosures and the audit log; funding sources, budget lines, expenditures and staff time with approvals; the funder report and funder-style logs (a naloxone distribution log in the style of the DHCS Naloxone Distribution Project, an opioid-settlement expenditure report by allowable-use category — each to be checked against the funder's current template) | Every programme |
| **Optional (clinical)** | Care plan, problem list, six-dimension assessment, outcome measures, structured clinical notes with signature and countersignature, episodes of care, CalOMS Tx, the FHIR R4 API and the county EHR encounter hand-off below | Treatment-adjacent programmes that need them |

The **programme profile** setting chooses which set a programme sees: **Harm reduction & outreach** (the default;
clinical modules hidden) or **Treatment-adjacent** (clinical modules shown). Hiding a module does not delete its
records or change permissions; the disclosure gate and audit apply either way.

## Programme profile

A programme is set up as **Harm reduction & outreach** (the default for a new install) or **Treatment-adjacent**
(`server/programme.js`; the setup wizard asks, Settings → Programme changes it). The clinical modules — care plan
and problem list, assessments, CalOMS Tx, the FHIR API and the county EHR hand-off — are shown only to a
treatment-adjacent programme or when switched on one by one. A module that is off is hidden and refuses new
records (403) but keeps what was already recorded readable; permissions do not change. A database upgraded from
before profiles is treatment-adjacent if it already held any clinical record or CalOMS/FHIR set-up.

## The billing boundary

**SUDS does not bill.** It does not produce 837 transactions, Short-Doyle/Medi-Cal claims, or any other
claim, and it does not submit to Drug Medi-Cal. A county review found this disqualifies SUDS as the system
of record wherever the workflow must generate revenue, and that is deliberate: the market is programmes that
do not bill, and claims are not on the roadmap.

*Optional module.* Where some services *are* billed, the county EHR / billing system (SmartCare or its equivalent) is the system
of record for the claim, and SUDS hands encounters over to it:

- **Reports → State reporting → County EHR hand-off** (`GET /api/handoff/export`, `export:identified`): one
  row per client, per service day, per kind of service, per worker, per place, modality and fund, with the
  contacts, minutes, staff and title, and the client's name, date of birth and Medi-Cal ID — for a biller to
  key or import into the EHR. It is labelled *not a claim*; the EHR decides what is billable.
- It is an identified disclosure outside the program, so it goes through `server/disclosure.js`: a named
  recipient and purpose, and a lawful basis — each client's live consent (Part 2 disclosure or release of
  information; clients without one are left out and listed by code), a qualified service organization
  agreement for the whole file, or the supervisor/administrator "other" override with a written
  justification. Every client in the file gets an accounting-of-disclosures row (source `ehr_handoff`).
- `GET /api/handoff/summary` previews the period (rows, clients, minutes, client codes with no consent)
  without any name.

## State reporting

*Optional module.* Treatment programs that must report **CalOMS Tx** can collect, validate and extract it in SUDS
(`docs/compliance/CALOMS.md`). That is reporting, not billing. The extract is built, but the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until verified with DHCS/county.

## Reports not yet produced

Named here so nobody assumes them. Each is a candidate for the next feature release once a pilot programme
confirms it owes the report and provides the current template.

Since 1.14.0 SUDS does produce, with the limits each document states:

- **SUPRT-A** (SAMHSA's Unified Performance Reporting Tool, administrative part, which replaced GPRA for State
  Opioid Response client-level data on 1 October 2025): baseline, reassessment, annual and closeout records, the
  follow-ups due, completion rates, and a CSV for entry into SPARS (docs/compliance/SUPRT.md). Its items, answer
  codes and variable names are SUDS's reading of SAMHSA's and California's public descriptions, **not** SAMHSA's
  codebook or the SPARS batch upload template, which could not be read when it was built: check the file against
  the current SUPRT handbook and codebook before entering it. SUDS does not reproduce **SUPRT-C**, the client
  questionnaire; it records only whether it was completed.
- **The DHCS settlement expenditure layout** of the opioid settlement report (one row per activity, the fields
  of DHCS's Opioid Settlement Expenditure Reporting Form as SUDS understands them, the narrative left for the
  programme), and **one county template** matched by a column mapping set without code
  (docs/compliance/HARM-REDUCTION-REPORTING.md). Neither is the official form itself.

Still not produced:

- **SUPRT-C** (the client questionnaire) and SPARS's own batch upload file.
- **HMIS** (HUD homeless management information system) export, for outreach funded through housing and
  homelessness grants.
- **Other county templates** as they stand: a county report whose columns are not the settlement report's
  fields (SABG subrecipient reports, a county's own outcome measures) cannot be matched by the column mapping;
  the mapping covers only what the settlement report holds, and each county's form must still be checked.
- The naloxone log follows the published reporting fields as understood, not the official NDP template
  (docs/compliance/HARM-REDUCTION-REPORTING.md).

## Supplies: what it is, and is not

SUDS keeps a harm-reduction programme's stock: items by category (naloxone by product, test strips, syringes by
size, sharps containers and the rest), at the sites the programme sets up, in lots with expiry dates, as an
append-only ledger of what was received, moved, adjusted, disposed of and handed out ([SUPPLIES.md](SUPPLIES.md)).
It is not a purchasing or accounts-payable system: a purchase is recorded against a fund on Funding & spending,
and the delivery it paid for is received on Supplies. It does not order from the Naloxone Distribution Project
or the CDPH supply clearinghouse, and its syringe services summary and NDP-style log are layouts to check
against the current official templates, not the templates themselves.

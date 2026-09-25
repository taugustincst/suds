# What SUDS is for, and where it stops

SUDS is the operations system for **harm-reduction and prevention programmes**: outreach encounters (named or
anonymous), naloxone and supply distribution, and grant/funder reporting, with privacy controls built to the
42 CFR Part 2 standard. Its users are community-based organisations and county programmes doing outreach, harm
reduction, naloxone and test-strip distribution, prevention and navigation, funded by opioid-settlement money,
SOR / the Naloxone Distribution Project, SABG prevention funds and similar grants.

## Core and optional modules

| | What | Who it is for |
| --- | --- | --- |
| **Core** | Outreach encounters, calls and texts; anonymous community distribution; overdose and reversal events; the supply cupboard; referrals and the resource directory; consents, the accounting of disclosures and the audit log; funding sources, budget lines, expenditures and staff time with approvals; the funder report and funder-style logs (a naloxone distribution log in the style of the DHCS Naloxone Distribution Project, an opioid-settlement expenditure report by allowable-use category — each to be checked against the funder's current template) | Every programme |
| **Optional (clinical)** | Care plan, problem list, six-dimension assessment, outcome measures, structured clinical notes with signature and countersignature, episodes of care, CalOMS Tx, the FHIR R4 API and the county EHR encounter hand-off below | Treatment-adjacent programmes that need them |

The **programme profile** setting chooses which set a programme sees: **Harm reduction & outreach** (the default;
clinical modules hidden) or **Treatment-adjacent** (clinical modules shown). Hiding a module does not delete its
records or change permissions; the disclosure gate and audit apply either way.

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

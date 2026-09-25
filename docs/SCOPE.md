# What SUDS is for, and where it stops

SUDS is case-management and service tracking for county SUD navigation, outreach, prevention, harm-reduction
and non-billing treatment programs: clients, episodes of care, visits, calls, referrals, notes, consents and
the accounting of disclosures, funding and spending, and the reports those programs owe.

## The billing boundary

**SUDS does not bill.** It does not produce 837 transactions, Short-Doyle/Medi-Cal claims, or any other
claim, and it does not submit to Drug Medi-Cal. A county review found this disqualifies SUDS as the system
of record wherever the workflow must generate revenue, and that is deliberate: the recommended market is
programs that do not bill, and claims are not on the roadmap.

Where some services *are* billed, the county EHR / billing system (SmartCare or its equivalent) is the system
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

Treatment programs that must report **CalOMS Tx** can collect, validate and extract it in SUDS
(`docs/compliance/CALOMS.md`). That is reporting, not billing. The extract is built, but the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until verified with DHCS/county.

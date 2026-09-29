# SUDS as the Part 2 layer beside an EHR — integration guide

This guide is for a SUD treatment programme (or a county on behalf of its providers) that keeps its clinical
record in an EHR — eClinicalWorks, Epic, SmartCare, Netsmart or another — and wants SUDS to do the 42 CFR Part 2
work the EHR does not: consents, the accounting of disclosures, redisclosure notices, SUD counseling notes kept
apart, the breach register, patient requests and secure referrals. SUDS does not replace the EHR, and nothing
here makes either system "Part 2 compliant" by itself: SUDS provides controls; the programme's policies, forms,
training and counsel's review decide how they are used ([docs/compliance/PART2.md](../compliance/PART2.md)).

No EHR vendor has certified or reviewed this integration. It uses standard FHIR R4 in both directions, tested
against SUDS's own fixtures (`test/part2-layer.test.js`); try it with a de-identified export from your EHR first.

## 1. Switch the profile

Settings › Program → *What kind of program is this?* → **Part 2 compliance module (beside an EHR)** (or choose it
in the first-run setup wizard). What changes (`server/programme.js`, `public/app.js` NAV):

| | Part 2 compliance module profile |
| --- | --- |
| **Off by default** (EHR-like modules) | Care plan and problem list, assessments (ASAM, PHQ-9…), CalOMS Tx, the county EHR hand-off. Each can still be switched on under Settings › Program › Modules (a programme that reports CalOMS from SUDS rather than the EHR switches it on). |
| **On by default** | The FHIR R4 API (for the EHR to read consents and their provenance). |
| **Hidden from the sidebar** | Supplies, Street outreach, Overdose & reversals, My time, Funding & spending, Settlement outcomes, Funder report — harm-reduction pages a treatment programme's layer does not need. Their addresses still work for roles that may open them. |
| **Leads the sidebar** | Privacy & Part 2, opening on the **Part 2 layer** tab: consents, disclosures by source, the §2.32 notice, counseling notes, patient requests, breaches and complaints, secure referrals and the integration status, as counts (`GET /api/part2/layer`). |
| **Unchanged** | Every Part 2 control, permission and audit rule. The profile is presentation; nothing is deleted when it changes. |

## 2. What to connect

| Connection | Direction | How | Set up under |
| --- | --- | --- | --- |
| **Patients** | EHR → SUDS | The EHR's FHIR R4 export (a `Bundle`, or Bulk Data `$export` NDJSON) of `Patient` resources, uploaded to Import → *Patients from your EHR (FHIR export)*. Or a spreadsheet of clients, as before. | Import |
| **Encounters** | EHR → SUDS | The same export's `Encounter` resources → Import → *Encounters from your EHR*. They become visits, so the Part 2 work (a referral, a consent) has the context of when the person was seen. | Import |
| **Consents and their provenance** | SUDS → EHR | The EHR (or the HIE) reads `Consent` and `Provenance` from SUDS's FHIR R4 API as a registered FHIR client, over SMART Backend Services (signed JWT) or a client secret ([FHIR.md](FHIR.md)). | Settings › FHIR clients |
| **The other SUDS records** (optional) | SUDS → EHR | `Patient`, `EpisodeOfCare`, `Encounter`, `ServiceRequest` (referrals), `Task`, `Observation`, `DocumentReference` (note metadata, never counseling notes) — each only for clients whose consent names the EHR's organisation and covers that category. | Settings › FHIR clients (scopes) |
| **Referrals to providers not on SUDS** | SUDS → provider | A one-time secure link the provider opens in a browser ([docs/security/REFERRAL-LINKS.md](../security/REFERRAL-LINKS.md)). | Referrals → a referral → Secure link |

SUDS never connects out to the EHR. An administrator exports from the EHR and uploads to SUDS; the EHR calls
SUDS's FHIR API. There are no EHR credentials in SUDS.

### The import, step by step

1. In the EHR, export the patients whose Part 2 work SUDS will hold (usually the SUD programme's census) as FHIR
   R4: a `Bundle` (`.json`) or the NDJSON files of a Bulk Data export (`Patient.ndjson`, `Encounter.ndjson`).
2. In SUDS, Import → choose **Patients from your EHR (FHIR export)** → drop the file. SUDS reads each `Patient`
   (official name, a nickname as the preferred name, birth date, the mobile or home phone, email, first address,
   gender, language, active) into the rows a spreadsheet of clients would give and shows the usual preview: every
   row validated, possible duplicates of existing clients flagged. Nothing is saved until **Import**.
3. Then **Encounters from your EHR** with the same export. Each `Encounter` that took place (not `planned`,
   `cancelled` or `entered-in-error`) becomes a visit: its start time, minutes (from `length` or the period), the
   nearest SUDS visit type (intake, assessment, screening, case management, care coordination, peer support,
   crisis, discharge planning, an emergency visit; otherwise *other*), modality (`VR` → video; "phone" in its type
   → phone; otherwise in person), and "Imported from the EHR: *type*" as its summary. An encounter is matched to
   its SUDS client by the patient's name from the same file ("Last, First"), so import the patients first; one
   whose patient is not in the file, or whose name matches two SUDS clients, is shown as a row to fix.
4. Importing the same export again adds nothing twice (the spreadsheet import's row fingerprints).

Code: `server/importers/fhir-ehr.js` (conversion), `POST /api/imports/ehr/preview?entity=clients|interventions`
(preview; commit is `POST /api/imports/data/commit` with `source: "ehr_fhir"`, audited as such). Permissions are
the spreadsheet import's: `imports:write` and the entity's own write permission.

**Limits.** SUDS does not keep the EHR's patient id (MRN): a patient already in SUDS is flagged by name, as for any
import. Problems, medications, allergies, labs and notes are not imported: they stay in the EHR, which is the
clinical record. There is no scheduled or automatic import; re-export and re-import on the programme's schedule.

### FHIR Provenance for consents

For each `Consent` the EHR may read, SUDS also serves a `Provenance` (id `consent-<consent id>`): `target` the
Consent, `occurredDateTime` the signature date, `recorded` when SUDS recorded it, `agent` the programme as
custodian, `activity` create (or revise once revoked), and `policy` the eCFR addresses of §2.31 (consent) and
§2.32 (the prohibition on redisclosure). It is listed exactly when its Consent is: the same recipient, purpose and
category checks, the same accounting of disclosures, the same Part 2 security labels. It does not claim a US Core
profile. Scope: `system/Provenance.read`.

## 3. Data flows

```
            EHR (clinical record, billing)                           SUDS (Part 2 layer)
  ┌──────────────────────────────────────┐   FHIR export (file)   ┌─────────────────────────────────────────┐
  │ Patient, Encounter ───────────────────┼───────────────────────▶│ Import → preview → commit (audited)     │
  │                                      │                        │                                         │
  │ reads Consent + Provenance           │◀── FHIR R4 API ─────────│ Consents (§2.31), recipient-named       │
  │ (and, if consented, other records)   │  consent-gated,        │ Disclosure gate + accounting (§2.25)    │
  │                                      │  accounted per client  │ §2.32 notice on every disclosure        │
  └──────────────────────────────────────┘                        │ Counseling notes kept apart (§2.11)     │
                                                                  │ Breach register, complaints, requests   │
         Provider not on SUDS  ◀── secure referral link ──────────│ Secure referral links (consent-gated)   │
                                                                  └─────────────────────────────────────────┘
```

Every arrow that carries identified information out of SUDS passes `server/disclosure.js` and writes the
accounting of disclosures: FHIR per client per request, secure referral links when first opened.

**SUDS gates and accounts only the disclosures made through SUDS.** A disclosure the EHR makes (a record sent
from the EHR, a fax, an HIE query, a release-of-information request the EHR's staff answer) is not checked
against SUDS's consents and is not in SUDS's accounting: SUDS cannot see or stop it. For the accounting of
disclosures a patient asks for (§2.25 / §164.528) to be complete, record each one in SUDS by hand: the client's
**Consents** tab → *Accounting of disclosures* → **+ Disclosure** (`POST /api/clients/:id/disclosures`,
`consents:write`: recipient, purpose, what was disclosed, method, date and basis). Recording one runs the same
gate as any other disclosure (the consent must name the recipient, an agreed restriction must be confirmed), so a
disclosure the EHR made without a basis SUDS accepts is refused there — treat that as a finding for the privacy
officer, not a form to force through.

## 4. What stays in the EHR, and what lives in SUDS

| Stays in the EHR | Lives in SUDS |
| --- | --- |
| The legal medical record: assessments, diagnoses, treatment plans, progress notes other than those the programme chooses to keep as SUD counseling notes in SUDS | Part 2 consents and their revocation; the §2.22 patient notice given to each client |
| Orders, medications, e-prescribing, labs, MAR | Court orders relied on for a disclosure (§§2.61–2.67), QSOAs and research / audit approvals |
| Scheduling, billing, claims (837), eligibility | The accounting of disclosures made through SUDS, and each one's basis; disclosures the EHR makes, once staff record them by hand (above) |
| The EHR's own access log | SUDS's hash-chained audit log of every Part 2 action it takes |
| | SUD counseling notes, if the programme keeps them here, readable only by their author, their co-signer and staff who write clinical notes, never over FHIR |
| | The incident and breach register with its notification clock; privacy complaints; patient requests with their 30-day deadlines |
| | Referrals to organisations outside the programme, and their outcomes |

Decide with counsel where counseling notes live. If they stay in the EHR, SUDS's counseling-note controls simply
hold nothing; the EHR must then keep them apart itself.

## 5. Operating checklist

1. Settings › Program: the Part 2 compliance module profile; Privacy & Part 2 → Overview: *This is a 42 CFR Part 2
   program* ticked; the patient notice replaced with counsel's wording.
2. Settings › FHIR clients: register the EHR's organisation with every name its consents use (aliases), purpose
   `TREAT`, scopes `system/Consent.read system/Provenance.read` (add others only if the EHR needs them and the
   consents cover them). Prefer signed JWTs.
3. Import patients, then encounters, from the EHR's FHIR export.
4. Record each client's consents in SUDS as they are signed — naming each recipient — and give the §2.22 notice.
5. Referrals to providers outside: the referral with a consent naming the provider, then *Secure link* — once an
   administrator has switched secure referral links on (off by default; counsel reviews the design first, and the
   server must be reachable from the internet: docs/security/REFERRAL-LINKS.md).
6. Disclosures made from the EHR: record each on the client's Consents tab (+ Disclosure), so the accounting is
   complete.
7. Review the Part 2 layer tab weekly: expiring consents, patient requests near their deadline, open incidents.

## 6. What this is not

- Not an interface engine or an HIE: no HL7 v2, no CCDA, no automatic synchronisation, no write-back into the EHR.
- Not certified health IT, and not a determination that a disclosure is lawful: the gate enforces the rules the
  software can check; people make the judgements (docs/compliance/PART2.md, *What the programme must supply*).
- Not a multi-tenant service: one SUDS server per programme ([COUNTY-MULTI-TENANT.md](../architecture/COUNTY-MULTI-TENANT.md) for the county design).

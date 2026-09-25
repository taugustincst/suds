# FHIR R4 API

SUDS is a navigation and case-management tool for a county SUD programme. It is not trying to replace the county EHR (SmartCare or any other). It works next to it. The FHIR API is how the EHR, or a health information exchange, reads what SUDS knows about the people both systems serve. It uses the same standard every certified EHR already speaks, and it applies 42 CFR Part 2 on every request.

- **Read-only.** Nothing can be created or changed over FHIR. Inbound referrals are a later design (see [below](#inbound-referral-intake-design-placeholder)).
- **Office server only.** SUDS on this device (the GitHub Pages build) and a local-mode copy do not serve it. The route module is left out of `LOCAL_ROUTE_MODULES` in `server/app.js`.
- **Consent-gated.** A response includes a client's records only while that client has a live consent that names the calling organisation for its purpose of use. The accounting of disclosures records every response that names a client.
- Code: `server/routes/fhir.js` (routes), `server/fhir/resources.js` (mappings and search), `server/fhir/bulk.js` (`$export`), `server/fhir/clients.js` (clients, tokens, scopes), `server/disclosure.js` (`fhirCoverage`, `recordFhir`, the §2.32 notice). Tests: `test/fhir.test.js`.

## Endpoints

Base URL: `https://<suds-server>/fhir/R4`. Responses are `application/fhir+json`, except bulk files (`application/fhir+ndjson`) and the export manifest (`application/json`, as the Bulk Data IG specifies). Every error comes back as an `OperationOutcome`.

| Method | Path | Auth | What |
| --- | --- | --- | --- |
| GET | `/metadata` | public | CapabilityStatement: types, search parameters, profiles, token URL. Contains no PHI. |
| GET | `/.well-known/smart-configuration` | public | Token endpoint, grant types and scopes, for SMART Backend Services-style discovery. |
| POST | `/auth/token` | client credentials | OAuth2 `client_credentials` grant. Returns a bearer token that lasts 15 minutes. |
| GET | `/{type}` | bearer | Search. Returns a `searchset` Bundle. |
| GET | `/{type}/{id}` | bearer | Read. |
| GET | `/$export` | bearer | Bulk Data kick-off, system level (every type the client may read). |
| GET | `/Patient/$export` | bearer | Bulk Data kick-off, Patient level (Patient compartment types only). |
| GET | `/$export-status/{job}` | bearer | Status: `202` with `X-Progress` while the job runs, then `200` with the manifest. |
| DELETE | `/$export-status/{job}` | bearer | Cancels the job or deletes it (`202`). Its files are removed. |
| GET | `/$export-file/{job}/{file}` | bearer | An output file, in NDJSON. |

Administration (session login, `apikeys:manage`, which administrators hold): `GET/POST /api/admin/fhir-clients` and `DELETE /api/admin/fhir-clients/:id`. The UI for these is **Settings → FHIR clients**.

## Authentication and scopes

An administrator creates a **FHIR client** under **Settings → FHIR clients** and sets:

| Field | Meaning |
| --- | --- |
| Name | A label, e.g. "County EHR – SmartCare". |
| Recipient organisation | The organisation this client stands for, spelled the way consents name it. This is what a client's consent must name. Other spellings in use go in **aliases** (one per line). |
| Purpose of use | `TREAT` (treatment), `HPAYMT` (payment) or `HOPERAT` (health care operations), all HL7 v3 ActReason codes. The consent's purpose must cover it. |
| Scopes | `system/<Type>.read` for each type, or `system/*.read` for all types. Only read scopes exist. `.rs`, `.r`, `.s` and `.*` are also accepted and mean read. |
| Rate limit | Requests per minute for this client (default 120). Over the limit, the answer is `429` with `Retry-After: 60`. |

The client is stored as an API key (`api_keys`, the same mechanism as the intake keys, with scopes beginning `fhir`), plus its registration in `settings` under `fhir_client:<id>`. The secret is shown once, when the client is created. Creating a client, revoking one, issuing a token and every refusal are all audited.

There are two ways to authenticate:

1. **OAuth2 client credentials.** Call `POST /fhir/R4/auth/token` with `grant_type=client_credentials` and credentials in either form: `client_id=<id>&client_secret=<secret>` in the body, or `Authorization: Basic base64(id:secret)`. You may also pass `scope=` to ask for fewer scopes than the client holds. The response is `{ access_token, token_type: "bearer", expires_in: 900, scope }`. SUDS does not support JWT client assertions (the full SMART Backend Services profile).
2. **The secret itself as a bearer token.** It carries every scope granted to the client. This is simpler for a server-to-server integration on a private network.

Revoking the client stops both at once, including any token it has already been issued. Tokens are kept in memory, so after a server restart a client has to request a new one.

The intake keys and the FHIR clients are kept apart. An intake key cannot read FHIR, and a FHIR client's secret cannot stage notes through `/api/intake`.

## 42 CFR Part 2

Every FHIR answer that identifies a client is a disclosure from a Part 2 programme to the organisation the FHIR client stands for. SUDS enforces the rule on every request.

**Coverage.** A client is *covered* when they have a consent that meets all of these conditions:

- its type is `part2_disclosure` or `roi`
- it has not been revoked and has not expired (`expires_at` is empty or on or after today)
- its recipient matches the FHIR client's recipient or one of its aliases. The comparison ignores case, accents and punctuation.
- its purpose covers the FHIR client's purpose of use. The purpose text must contain *treatment* (or *care coordination*) for `TREAT`, *payment* (or *billing*/*claims*) for `HPAYMT`, or *operations* for `HOPERAT`. A consent that says *TPO*, or *treatment, payment and health care operations*, covers all three.

A general TPO consent that names no organisation is **not** honoured over FHIR. The organisation has to be named on the consent. This is the conservative reading, and it keeps the match mechanical and auditable. `fhirCoverage()` in `server/disclosure.js` holds the rule, and its result is cached until any consent changes or the date turns. A revocation therefore takes effect on the very next request.

**Omission, not refusal.** A search never fails with a 403 because some clients are not covered. Their resources are left out. An `OperationOutcome` entry (`search.mode = outcome`) always carries the §2.32 notice, and for a broad search it adds a warning with the count:

```
"5 patient(s) (7 Encounter resource(s)) on this page were withheld: no active consent names County Behavioral Health for this purpose of use."
```

A search that names one person (`identifier`, `family`, `given`, `birthdate`, `_id`, `patient`) never gives a count. For those searches the OperationOutcome has the same wording whether or not anyone was withheld. Otherwise "1 withheld" in reply to `identifier=X` would itself disclose that X is a client of the programme. For the same reason, reading a client who is not covered returns `404`, identical to the answer for a record that does not exist. The refusal is still audited internally (`fhir.read.withheld`).

**Labels and notice.**

- Every Bundle and every client resource carries `meta.security` with three codes. `R` (restricted, `v3-Confidentiality`). `42CFRPart2` (`v3-ActCode`). `NORDSLCD` (no redisclosure without consent directive, `v3-ActCode`).
- DocumentReference also carries these in `securityLabel`.
- The §2.32(a)(1) notice text is in the Bundle's OperationOutcome, in the bulk export's `OperationOutcome.ndjson` and in its manifest (`extension["urn:suds:part2"]`).
- The resource directory (Organization, Location, HealthcareService) is not PHI. It carries no labels, needs no consent and is not recorded as a disclosure.

**Accounting of disclosures.** SUDS writes one `disclosures` row per client for each request, all in one transaction. Each row has:

- `source = 'fhir'`, `method = 'FHIR API'` and `basis = 'consent'`
- `consent_id`: the covering consent
- the recipient
- the purpose, e.g. "Treatment (FHIR purpose of use TREAT)"
- what was sent, e.g. "FHIR search Encounter: 3 resources"
- `source_ref = fhir:<request id>`

A bulk export writes one row per client for the whole export (`source_ref = fhir-export:<job id>`). It is recorded when the export completes, conservatively, whether or not the files are ever downloaded. `disclosed_by` is the administrator who created the FHIR client, because disclosures must name a user. The audit rows name the client as `fhir:<name>`. These rows appear in the client's accounting (`GET /api/clients/:id/disclosures/accounting`) like any other disclosure.

**Audit.** Each request writes one `fhir.search`, `fhir.read`, `fhir.export.*` or `fhir.token.*` row. The row records the client, the parameter *names* (never their values, which can be PHI), and how many results were returned, covered and withheld. Each disclosed client also gets a `disclosure.record` row, and every refusal is written as `fhir.denied`.

## Resources and mappings

Profiles are declared in `meta.profile` only where the resource conforms: US Core Patient, Encounter, Organization and Location. The other types are base R4. SUDS's own codes use `urn:suds:codesystem:*` systems, because each county runs its own server and there is no single SUDS domain to publish them under.

| FHIR resource | SUDS source | Mapping notes |
| --- | --- | --- |
| **Patient** (US Core) | `clients` (not deleted or merged) | `identifier`: the client code (`urn:suds:client-code`, type MR) and the Medicaid ID (type MA) if recorded. `name`: official name and, as `usual`, the preferred name. `birthDate`, `gender` (female/male, transgender female→female, transgender male→male, non-binary/other→other, otherwise unknown), `telecom`, `address`, `communication`. The US Core race and ethnicity extensions come from `race_codes` (OMB codes; declined → ASKU, unknown → UNK). `active` is false for closed/inactive/deceased, and a deceased client has `deceasedBoolean`. Goals, flags and emergency contact are **not** shared. |
| **EpisodeOfCare** | `episodes` | `status` active/finished, `period` from opened/closed, `managingOrganization` = the programme. The presenting problem and discharge summary text are **not** shared. |
| **Encounter** (US Core) | `interventions` (id `iv-<id>`), `calls` (id `call-<id>`) | The intervention type becomes `type` (`urn:suds:codesystem:intervention-type`). `class`: VR for phone/video/text or telehealth, HH for home, FLD for field locations, otherwise AMB. A call is always VR, and a crisis call has priority EM. `period`/`length` come from the duration. No-show, declined and similar outcomes → `cancelled`. Visit and call summaries are **not** shared. |
| **Consent** | `consents` of type `part2_disclosure`/`roi` that name *this* recipient for this purpose | `status` active/inactive. `category`: LOINC 59284-0 plus the SUDS type. `policyRule`: 42CFRPart2 (Part 2) or `hipaa-auth` (ROI). `provision`: permit, `period`, `actor` IRCP (the recipient, as display) and `purpose` (ActReason codes derived from the purpose text). A client's consents to *other* organisations are never shown. |
| **ServiceRequest** | `referrals` | `intent` order. Category is SNOMED 3457005 "Patient referral". `code`: the resource category plus "Referral to <provider>". `status`: pending/contacted/accepted/scheduled → active, waitlisted → on-hold, admitted/completed/closed → completed, declined/no-show → revoked. `priority`: routine/urgent/stat. `requester` is the programme. `performer` is `Organization/<resource>` and `HealthcareService/<resource>`. Outcome, barrier and notes are **not** shared. |
| **Task** | `tasks` that belong to a client | `status`: requested, in-progress, completed or cancelled. `priority`, `description` (the to-do's title), `for`, `focus` (ServiceRequest, when the task follows up a referral), `restriction.period.end` (due date). The task's details text is **not** shared. Staff to-dos with no client are never exposed. |
| **Observation** | `clients.risk_level` (id `risk-<client>`) and `overdose_events` (id `od-<id>`) | Risk level: category survey, code `overdose-risk-level`, valueCodeableConcept low/moderate/high. Overdose event: code `overdose-event`, value overdose/reversal/fatal, plus components for naloxone used, naloxone doses, EMS called, hospitalized and survived. Substances and notes are **not** shared. |
| **DocumentReference** | signed or amended `notes` (not drafts, deleted notes or supervision notes) | **Metadata only.** Type is LOINC 11506-3 Progress note (18842-5 for discharge) plus the SUDS format. Also `category`, `date` (signed), `context.period` and `context.encounter`. The attachment has no data and no URL, and its title says the text is not shared. Note titles and text, including SUD counselling content, are **never** sent over FHIR. |
| **Organization** (US Core) | `resources` (one per directory entry) and `Organization/suds-program` (this programme, `org_name`) | Name (the resource's organisation, else its name), type `prov`, telecom and address. |
| **Location** (US Core) | `resources` | Name, status, telecom, address, `managingOrganization`. |
| **HealthcareService** | `resources` | Category, service tags (as `type`), `providedBy`, `location`, eligibility and populations, languages, hours, Medicaid/uninsured characteristics, and services/levels of care/MAT/intake/cost in `extraDetails`. The internal staff `notes` are not shared. |

Every reference resolves on this server. Clients are `Patient/<id>`, the programme is `Organization/suds-program`, providers are `Organization|Location|HealthcareService/<resource id>`, and a note's visit is `Encounter/iv-<id>`. A reader holding the right scope can follow each one.

## Search

Every type supports `_id`, `_lastUpdated`, `_count` (default 50, capped at 200) and `_offset`. Client-linked types also support `patient`, as `Patient/<id>` or a bare id.

| Type | Additional parameters |
| --- | --- |
| Patient | `identifier` (`urn:suds:client-code\|C26-0001` or a bare code), `family`, `given`, `birthdate` (exact `YYYY-MM-DD` only, because names and dates of birth are stored encrypted and searched by blind index) |
| EpisodeOfCare | `date` (opened), `status` |
| Encounter | `date` (start) |
| Consent | `date` (signed), `status` |
| ServiceRequest | `authored`, `status` |
| Task | `authored-on`, `status` |
| Observation | `date`, `category` (`survey` or `overdose-event`) |
| DocumentReference | `date` (signed) |
| Organization | `name`, `name:contains`, `name:exact`, `active` |
| Location | `name`, `address-city`, `address-postalcode`, `status` |
| HealthcareService | `name`, `active`, `service-category` |

Date parameters take the FHIR prefixes `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `sa` and `eb`. A partial date covers its whole range, so `date=2026-03` means all of March. Repeat a parameter to AND values (`date=ge2026-01-01&date=lt2026-04-01`), and separate values with commas to OR them. An **unknown parameter is refused with 400** instead of being ignored: a filter that is silently dropped would widen what the recipient gets. `_include`, `_revinclude`, `_sort` and chained parameters are not supported.

Paging returns `link` entries `self`, `next` and `previous`. Omitted clients are removed from a page after it is cut, so a page can hold fewer than `_count` entries. Keep following `next`.

## Bulk export

The export follows the [FHIR Bulk Data Access IG](https://hl7.org/fhir/uv/bulkdata/):

- Kick-off needs `Prefer: respond-async`. The accepted parameters are `_type` (a comma-separated list), `_since` (an instant) and `_outputFormat` (`application/fhir+ndjson`). Any other parameter gets a 400.
- System level exports every type the client may read. Patient level exports only the Patient compartment types.
- Each client may run at most two exports at once.
- Output: one NDJSON file per type with results, and an `OperationOutcome.ndjson` in `error[]`. That file carries the §2.32 notice and how many clients were left out for lack of consent.
- `requiresAccessToken` is `true`. Files are downloaded with the same bearer token, and only by the client that started the export (another client's job answers 404).
- **At rest:** the files are written to `<data dir>/fhir-export/<job>/`, encrypted with the database key (AES-256-GCM, `server/crypto.js`). They are deleted when the job is deleted or expires (`FHIR_EXPORT_TTL_MINUTES`, default 60; the manifest carries `Expires`). A sweep also removes files a previous server process left behind. Job state is in memory, so after a restart the client starts again. If the encryption key is rotated while a job's files still exist, those files answer 410.

## Examples

```sh
BASE=https://suds.county.local/fhir/R4
# Discovery (no auth)
curl -s $BASE/metadata | jq '.rest[0].resource[].type'

# Token (client credentials)
TOKEN=$(curl -s -X POST $BASE/auth/token \
  -d grant_type=client_credentials -d client_id=$CLIENT_ID -d client_secret=$CLIENT_SECRET \
  -d scope='system/Patient.read system/Encounter.read' | jq -r .access_token)

# Find a client by SUDS client code, then their encounters since January
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/Patient?identifier=urn:suds:client-code|C26-0001"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/Encounter?patient=Patient/<id>&date=ge2026-01-01&_count=100"

# The resource directory (no consent involved)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/HealthcareService?name:contains=detox"

# Bulk export
curl -si -H "Authorization: Bearer $TOKEN" -H 'Accept: application/fhir+json' -H 'Prefer: respond-async' \
  "$BASE/\$export?_type=Patient,Encounter,ServiceRequest&_since=2026-09-01T00:00:00Z" | grep -i content-location
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/\$export-status/<job>"      # 202 until done, then the manifest
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/\$export-file/<job>/Patient.ndjson"
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/\$export-status/<job>"
```

A search Bundle, shortened:

```json
{ "resourceType": "Bundle", "type": "searchset",
  "meta": { "security": [ { "system": "http://terminology.hl7.org/CodeSystem/v3-Confidentiality", "code": "R" },
                          { "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "42CFRPart2" },
                          { "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "NORDSLCD" } ] },
  "link": [ { "relation": "self", "url": ".../Patient?_count=50" } ],
  "entry": [
    { "fullUrl": ".../Patient/1f5a…", "resource": { "resourceType": "Patient", "id": "1f5a…", "...": "..." }, "search": { "mode": "match" } },
    { "resource": { "resourceType": "OperationOutcome", "issue": [
        { "severity": "information", "code": "informational", "diagnostics": "42 CFR §2.32 notice: This record which has been disclosed to you is protected by Federal confidentiality rules (42 CFR part 2). …" },
        { "severity": "warning", "code": "suppressed", "diagnostics": "5 patient(s) (5 Patient resource(s)) on this page were withheld: no active consent names County Behavioral Health for this purpose of use." } ] },
      "search": { "mode": "outcome" } } ] }
```

## Operating notes

- Put the office server behind HTTPS (docs/DEPLOYMENT.md) before giving a FHIR client its secret. The secret is a password for the programme's records.
- Behind a reverse proxy with `trustProxy` on, `X-Forwarded-Proto` and `X-Forwarded-Host` set the URLs in links, `fullUrl` and the export manifest.
- The per-IP API limit (600 requests a minute) applies in addition to each client's own limit.
- When a recipient organisation is renamed, add the old name as an alias. Consents that use the old name then keep working.

## Inbound referral intake (design placeholder)

This is not built. It records how an inbound path would fit, so the read API does not have to change when it is built.

**Goal.** Let the county EHR, a hospital or a 988 crisis line send a referral *to* the programme as a FHIR `ServiceRequest`. Staff review it before it becomes a client or a referral in SUDS, the same way `/api/intake/notes` stages Pocket AI notes.

**Proposed shape.**

- `POST /fhir/R4/ServiceRequest` (or a `Bundle` of type `transaction` containing the `ServiceRequest` plus a contained or bundled `Patient`). This needs a new write scope, `system/ServiceRequest.write`, granted per FHIR client. Nothing else becomes writable.
- The request must have `intent` `order` or `proposal`, `subject` pointing at the (contained) Patient, and `requester` naming the referring organisation. `reasonCode` or `note` gives the reason, and `priority` the urgency. `supportingInfo` may reference a `Consent`: the referring provider's consent for the disclosure, which the sender is responsible for under Part 2.
- On receipt, SUDS validates the resource and stores it *encrypted* in the import staging area (`imports` / `import_items`, `source = 'fhir'`). It answers `202 Accepted` with an `OperationOutcome` and a `Location` pointing at a staging record the sender may poll (`Task` with status `requested` → `accepted`/`rejected`). It does not answer `201 Created`: no SUDS record exists until a person accepts it.
- Staff see it under **Imports**. Accepting it runs the existing duplicate check (`POST /api/clients/check-duplicates`), creates or links the client, opens an episode, creates a referral note, and updates the Task. Every step is audited. Rejecting it records a reason, which the sender sees on the Task.
- Nothing is sent back to the referrer except that Task's status, unless a consent names the referrer. At that point the read API above applies to it like any other FHIR client.
- Open questions: matching on identifiers the EHR sends (MRN, Medicaid ID) against SUDS's encrypted fields; whether the sender's consent can be relied on or the programme must obtain its own; and a size limit and schema validation for the contained Patient.

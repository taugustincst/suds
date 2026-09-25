# FHIR R4 API

SUDS is a navigation and case-management tool for a county SUD programme. It is not trying to replace the county EHR (SmartCare or any other). It works next to it. The FHIR API is how the EHR, or a health information exchange, reads what SUDS knows about the people both systems serve. It uses the same standard every certified EHR already speaks, and it applies 42 CFR Part 2 on every request.

- **Read-only.** Nothing can be created or changed over FHIR. Inbound referrals are a later design (see [below](#inbound-referral-intake-design-placeholder)).
- **Office server only.** SUDS on this device (the GitHub Pages build) and a local-mode copy do not serve it. The route module is left out of `LOCAL_ROUTE_MODULES` in `server/app.js`.
- **Consent-gated.** A response includes a client's records only while that client has a live Part 2 consent that names the calling organisation for its purpose of use, and no agreed restriction (see *42 CFR Part 2* below). The accounting of disclosures records every response that names a client.
- Code: `server/routes/fhir.js` (routes), `server/fhir/resources.js` (mappings and search), `server/fhir/bulk.js` (`$export`), `server/fhir/clients.js` (clients, tokens, scopes, aliases), `server/fhir/jwt.js` (SMART Backend Services client assertions), `server/disclosure.js` (`fhirCoverage`, `recordFhir`, the §2.32 notice). Tests: `test/fhir.test.js`, `test/fhir-hardening.test.js`, `test/fhir-uscore.test.js`.

## Endpoints

Base URL: `https://<suds-server>/fhir/R4`. Responses are `application/fhir+json`, except bulk files (`application/fhir+ndjson`) and the export manifest (`application/json`, as the Bulk Data IG specifies). Every error comes back as an `OperationOutcome`.

| Method | Path | Auth | What |
| --- | --- | --- | --- |
| GET | `/metadata` | public | CapabilityStatement: types, search parameters, profiles, token URL. Contains no PHI. |
| GET | `/.well-known/smart-configuration` | public | Token endpoint, grant types and scopes, for SMART Backend Services-style discovery. |
| POST | `/auth/token` | client assertion (`private_key_jwt`) or client secret | OAuth2 `client_credentials` grant. Returns an access token that lasts 15 minutes. |
| GET | `/{type}` | access token | Search. Returns a `searchset` Bundle. |
| GET | `/{type}/{id}` | access token | Read. |
| GET | `/$export` | access token | Bulk Data kick-off, system level (every type the client may read). |
| GET | `/Patient/$export` | access token | Bulk Data kick-off, Patient level (Patient compartment types only). |
| GET | `/$export-status/{job}` | access token | Status: `202` with `X-Progress` while the job runs, then `200` with the manifest. |
| DELETE | `/$export-status/{job}` | access token | Cancels the job or deletes it (`202`). Its files are removed. |
| GET | `/$export-file/{job}/{file}` | access token | An output file, in NDJSON. Consent is checked again here (see *Bulk export*). |

Administration (session login, `apikeys:manage`, which administrators hold): `GET/POST /api/admin/fhir-clients`, `PATCH /api/admin/fhir-clients/:id` (aliases, public keys, JWT-only), `POST /api/admin/fhir-clients/alias-preview` (counts only) and `DELETE /api/admin/fhir-clients/:id`. The UI for these is **Settings → FHIR clients**.

## Authentication and scopes

An administrator creates a **FHIR client** under **Settings → FHIR clients** and sets:

| Field | Meaning |
| --- | --- |
| Name | A label, e.g. "County EHR – SmartCare". |
| Recipient organisation | The organisation this client stands for, spelled the way consents name it. This is what a client's consent must name. Other spellings in use go in **aliases** (one per line; see *Aliases* below: each must name this organisation and no other). |
| Purpose of use | `TREAT` (treatment), `HPAYMT` (payment) or `HOPERAT` (health care operations), all HL7 v3 ActReason codes. The consent's purpose must cover it. |
| Scopes | `system/<Type>.read` for each type, or `system/*.read` for all types. Only read scopes exist. `.rs`, `.r`, `.s` and `.*` are also accepted and mean read. |
| Rate limit | Requests per minute for this client (default 120). Over the limit, the answer is `429` with `Retry-After: 60`. |
| How it signs in | **Client secret**, **Signed JWT only** (SMART Backend Services `private_key_jwt`), or **Signed JWT or client secret** while the other system moves over. For a signed JWT, paste the client's public key set (JWKS) or give its https JWKS URL. |

The client is stored as an API key (`api_keys`, the same mechanism as the intake keys, with scopes beginning `fhir`), plus its registration in `settings` under `fhir_client:<id>`. The secret is shown once, when the client is created. Creating a client, revoking one, issuing a token and every refusal are all audited.

Every data request carries an **access token** (`Authorization: Bearer <token>`) from the token endpoint, `POST /fhir/R4/auth/token` (OAuth2 `grant_type=client_credentials`). A token lasts 15 minutes (`expires_in: 900`) and carries the client's scopes, or fewer if the request passes `scope=`. The response is `{ access_token, token_type: "bearer", expires_in: 900, scope }`. At the token endpoint the client proves who it is in one of two ways:

1. **A signed JWT (`private_key_jwt`, SMART Backend Services / RFC 7523).** The recommended way: no shared secret exists on either side. The administrator registers the client's **public** key set (paste the JWKS) or its JWKS URL. The client then posts

   ```
   grant_type=client_credentials
   &client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
   &client_assertion=<signed JWT>
   [&scope=system/Patient.read ...]
   ```

   The JWT must be signed with **RS384** (RSA, 2048 bits or more) or **ES384** (EC P-384), have `kid` naming a registered key (it may be left out when only one key fits), and carry these claims:

   | Claim | Rule |
   | --- | --- |
   | `iss`, `sub` | Both the client_id. |
   | `aud` | The token URL exactly as the client reaches it, e.g. `https://suds.county.local/fhir/R4/auth/token` (also in `/.well-known/smart-configuration`). |
   | `exp` | In the future and **no more than five minutes** ahead (60 seconds of clock skew allowed). |
   | `jti` | Unique. Each assertion works **once**: its jti is kept (hashed, in `fhir_jwt_assertions`) until it expires, so a replay is refused even after a restart. |
   | `iat`, `nbf` | Optional; if present, not in the future. |

   `alg: none`, HMAC algorithms, a key of the wrong type for the alg, and keys named inside the assertion (`jku`, `x5u`, `jwk`) are refused. A key set containing private key material is refused when it is registered.

   A **JWKS URL** must be `https` and on the public internet: it is fetched through the same guard as provider pictures (`server/region-pictures.js`), which refuses any address on the server itself or the county network, on every redirect. A fetched key set is cached for an hour; an assertion with an unknown `kid` refetches it (at most once a minute), so the client can rotate keys by publishing the new one first. For a system on the county's own network, paste its key set instead of giving a URL.

2. **The client secret** (`client_secret_post`: `client_id=<id>&client_secret=<secret>` in the body, or `client_secret_basic`: `Authorization: Basic base64(id:secret)`). The secret is shown once, when the client is created. An administrator can make a client **JWT-only** (Settings → FHIR clients → Edit → *Signed JWT only*), after which its secret gets `401 invalid_client`.

A failed client authentication is always `401 invalid_client` with no detail; the reason (bad signature, expired, replayed jti, wrong `aud`, secret on a JWT-only client…) is written to the audit trail as `fhir.token.denied`, never the assertion or secret itself.

**The secret is not a bearer token.** It works only at the token endpoint. Sent as `Authorization: Bearer` on a data request it gets `401` with an OperationOutcome that says to exchange it at `/auth/token`, and the attempt is audited as `fhir.denied` (`reason: client secret used as a bearer token`) against that client, so an administrator can see which integration still does it.

Revoking the client stops everything at once, including any token it has already been issued. Tokens are kept in memory, so after a server restart a client has to request a new one (it would within 15 minutes anyway); used JWT ids are kept in the database.

### Moving an existing integration off the secret-as-bearer

Up to SUDS 1.10 the secret itself was also accepted as a bearer token. An integration that did that now gets `401` on every data request. Nothing has to be re-registered:

1. **Now, no change on the SUDS side:** have the other system call `POST /fhir/R4/auth/token` with `grant_type=client_credentials`, `client_id` (the id shown when the client was created, also in the list) and `client_secret` (the same key it used as a bearer), and send the `access_token` it gets back. Request a new one before `expires_in` runs out (or on any `401`).
2. **Then, recommended:** have it generate an RS384 or ES384 key pair, and register the public key under **Settings → FHIR clients → Edit** (sign-in *Signed JWT or client secret*). Once it sends signed JWTs (the audit trail shows `fhir.token.issued` with `method: private_key_jwt`), switch the client to **Signed JWT only**, and the old secret stops working.

To find integrations still using the secret as a bearer, search the audit log for `fhir.denied` with that reason.

The intake keys and the FHIR clients are kept apart. An intake key cannot read FHIR, and a FHIR client's secret cannot stage notes through `/api/intake`.

## 42 CFR Part 2

Every FHIR answer that identifies a client is a disclosure from a Part 2 programme to the organisation the FHIR client stands for. SUDS enforces the rule on every request.

**Coverage.** FHIR answers are made with no worker in the loop, so a client is included only when `requireBasis` (`server/disclosure.js`, the gate every other disclosure passes) would let a worker make the same disclosure, to the same organisation, without asking anything further. The recipient is matched by one function, `consentNamesRecipient`, on every path — a referral, a manual disclosure, an identified export, the county EHR hand-off and FHIR — so a worker can never disclose to a recipient FHIR would refuse. (Before schema migration 32 only FHIR compared the consent's recipient; the human paths accepted any live consent. docs/compliance/PART2.md, *The disclosure gate*, has the rules for every path, and the supervisor's written override that only a worker can use.) A client is *covered* when they have a consent that meets all of these conditions:

- its type can authorise a disclosure in this programme (`disclosingConsentTypes()`), and is one that can name a recipient for treatment, payment or operations:
  - `part2_disclosure` (a Part 2 consent to a named recipient);
  - `part2_tpo`, the 2024 rule's single consent for all future treatment, payment and health care operations (§2.31(a)(4)(iii));
  - `roi` (a general release of information) **only when this programme is not a Part 2 programme** (Privacy & Part 2 → Overview, `part2_program` off). While `part2_program` is on — the default — a general release is not a Part 2 consent (§2.31, §2.32) and never covers FHIR, exactly as `requireBasis` refuses it for a referral.
  - A consent for SUD counseling notes only (`part2_counseling_notes`) or for a legal proceeding only (`part2_proceedings`) never covers FHIR: FHIR is always treatment, payment or operations, and never sends note text.
- it has not been revoked and has not expired (`expires_at` is empty or on or after today)
- it records the §2.31 elements: every 2024 element for a consent on the current form, or — for a consent recorded before the 2024 element list — the pre-2024 elements and a signature before 16 February 2026 (`consentElementProblems`; the same re-check `requireBasis` makes)
- its recipient names the FHIR client's organisation. The comparison ignores case, accents and punctuation.
  - `part2_disclosure` / `roi`: the recipient must *be* the organisation's recipient name or one of its aliases.
  - `part2_tpo`: the recipient may be a list or a class of recipients (the 2024 rule allows "my treating providers" wording); it covers the organisation when the name or an alias appears in it as whole words, e.g. "County Behavioral Health and my other treating providers". A class with no name in it ("my health plans") cannot be matched mechanically and is **not** honoured over FHIR — record the organisation's name on the consent. Because a name only has to *appear* in such wording, aliases are restricted (below).
- its purpose covers the FHIR client's purpose of use.
  - `part2_tpo` covers `TREAT`, `HPAYMT` and `HOPERAT` by definition.
  - Otherwise the purpose text must contain *treatment* (or *care coordination*) for `TREAT`, *payment* (or *billing*/*claims*) for `HPAYMT`, or *operations* for `HOPERAT`. A consent that says *TPO*, or *treatment, payment and health care operations*, covers all three.
- the client has **no agreed restriction** (a fulfilled `restriction` request on their Requests tab, §2.26 / §164.522). `requireBasis` makes a worker confirm that a disclosure respects an agreed restriction; there is no worker to confirm a FHIR answer, so a client with one is withheld entirely until the restriction is lifted.

A general TPO wording that names no organisation is **not** honoured over FHIR: the organisation has to be named on the consent. This is the conservative reading, and it keeps the match mechanical and auditable. `fhirCoverage()` in `server/disclosure.js` holds the rule, and its result is cached until any consent or patient request changes, the Part 2 programme setting changes, or the date turns. A revocation or a newly agreed restriction therefore takes effect on the very next request.

**Aliases.** A single TPO consent covers a FHIR client when the client's recipient name or an alias appears in its recipient wording as whole words. A one-word or generic alias would therefore match almost every consent that describes a class of recipients: "county" is in "my treating providers in the county", "health" in "my health plans". So an alias is accepted only when it names one organisation:

- it is not made only of generic words (county, health, services, department, behavioral, care, clinic, center, program, provider, plan and the like — `GENERIC_WORDS` in `server/fhir/clients.js`; "of", "the", "and" are ignored), and
- it has two specific words ("Riverbend Wellspring"), or one specific word within a name of three words or more ("Sacramento County Behavioral Health"), **or** it is exactly the name of an organisation in the resource directory ("Kaiser", when the directory has it).

"Sacramento County" is refused (one specific word, two words), as are "County Health" and "Department of Health Services". The recipient name itself is not restricted: it is the organisation the administrator registered the client for. Before saving, **Check aliases** (in the new-client and Edit dialogs; `POST /api/admin/fhir-clients/alias-preview`) shows, for the recipient and each alias, how many clients with a live consent it would cover for the chosen purpose of use — counts only, never who — and which aliases would be refused and why. The preview is audited (`fhir_client.alias_preview`, counts only). Aliases saved before this rule that break it are **ignored** for coverage and listed as ignored under Settings → FHIR clients; edit them to a specific name.

FHIR is never used for a legal proceeding against the patient (§2.12(d)); that disclosure needs a subpart E court order or a proceedings-only consent and is recorded one client at a time on the Consents tab. A client's retention *legal hold* keeps their record from being purged and does not change what FHIR discloses.

**SUD counseling notes** (`notes.counseling_note`, §2.11) are not listed as DocumentReference at all — not even as metadata — since they may be disclosed only under a consent given for counseling notes alone. A note's links to the problem list (`notes.problem_ids`) are not sent and do not affect this.

**Omission, not refusal.** A search never fails with a 403 because some clients are not covered. Their resources are left out. An `OperationOutcome` entry (`search.mode = outcome`) always carries the §2.32 notice, and for a broad search it adds a warning with the count:

```
"5 patient(s) (7 Encounter resource(s)) on this page were withheld: no active consent covers County Behavioral Health for this purpose of use, or the patient has an agreed restriction."
```

A search that names one person (`identifier`, `family`, `given`, `birthdate`, `_id`, `patient`) never gives a count. For those searches the OperationOutcome has the same wording whether or not anyone was withheld. Otherwise "1 withheld" in reply to `identifier=X` would itself disclose that X is a client of the programme. For the same reason, reading a client who is not covered returns `404`, identical to the answer for a record that does not exist. The refusal is still audited internally (`fhir.read.withheld`).

**Labels and notice.**

- Every Bundle and every client resource carries `meta.security` with three codes. `R` (restricted, `v3-Confidentiality`). `42CFRPart2` (`v3-ActCode`). `NORDSCLCD` (no redisclosure without consent directive, `v3-ActCode`; up to 1.10 SUDS sent `NORDSLCD`, which HL7 Terminology has retired).
- DocumentReference also carries these in `securityLabel`.
- The §2.32(a)(1) notice, in the 2024 final rule's wording, is in the Bundle's OperationOutcome, in the bulk export's `OperationOutcome.ndjson` and in its manifest (`extension["urn:suds:part2"]`). It is the one notice text SUDS uses everywhere (`PART2_REDISCLOSURE_NOTICE` in `server/constants.js`, via `disclosure.notice()`): identified exports, the CalOMS README, the county EHR hand-off, form and consent PDFs.
- The resource directory (Organization, Location, HealthcareService) is not PHI. It carries no labels, needs no consent and is not recorded as a disclosure.

**Accounting of disclosures.** SUDS writes one `disclosures` row per client for each request, all in one transaction. Each row has:

- `source = 'fhir'`, `method = 'FHIR API'` and `basis = 'consent'`
- `legal_proceeding = 0`, `counseling_notes = 0`, and `notice_version` (the §2.32 notice version the response carried, `2024`; empty outside a Part 2 programme)
- `consent_id`: the covering consent
- the recipient
- the purpose, e.g. "Treatment (FHIR purpose of use TREAT)"
- what was sent, e.g. "FHIR search Encounter: 3 resources"
- `source_ref = fhir:<request id>`

A bulk export is accounted when it is **downloaded**, not when it is built: building the files is audited (`fhir.export.complete`) but nothing has left the programme yet. The first download of each output file writes one row per client in that file (`source_ref = fhir-export:<job id>`, what e.g. "FHIR bulk export <job>: Encounter (3)"), under the consent that covers the client at that moment; downloading the same file again writes nothing more. The first download of an export naming more clients than the mass-export threshold opens a draft privacy incident, like any identified export. `disclosed_by` is the administrator who created the FHIR client, because disclosures must name a user. The audit rows name the client as `fhir:<name>`. These rows appear in the client's accounting (`GET /api/clients/:id/disclosures/accounting`) like any other disclosure.

**Audit.** Each request writes one `fhir.search`, `fhir.read`, `fhir.export.*` or `fhir.token.*` row. The row records the client, the parameter *names* (never their values, which can be PHI), and how many results were returned, covered and withheld. Each disclosed client also gets a `disclosure.record` row, and every refusal is written as `fhir.denied`.

## Resources and mappings

Profiles are declared in `meta.profile` for US Core Patient, Encounter, Organization and Location, which these resources are intended to conform to; the other types are base R4. SUDS's own codes use `urn:suds:codesystem:*` systems, because each county runs its own server and there is no single SUDS domain to publish them under.

**Profiles and conformance.** What has been checked, and what has not:

- `test/fhir-uscore.test.js` checks, on every test run, the US Core required elements, cardinalities and fixed structures for the elements SUDS populates (identifier system and value, name, gender, the race and ethnicity extensions' structure and OMB codes, Encounter status/class/type/subject, Organization active/name, Location name, no empty values) and that the CapabilityStatement names the same four profiles. These are SUDS's own structural tests.
- Sample output (a Patient with every field SUDS sends, one with race declined, a sparse one, visit and call Encounters, the programme and a directory Organization, a Location) was run through the **official HL7 FHIR validator** (validator_cli 6.10.4) against US Core **3.1.1, 4.0.0 and 5.0.1**: **0 errors** for all nine resources in each version, after two fixes it found (race *declined*/*unknown* is now said in the race extension's `text` only, because an `ombCategory` of ASKU/UNK is outside the OMB value set before US Core 6; and the retired `NORDSLCD` label became `NORDSCLCD`). That run was **offline**: the packages came from mirrors (npm and Maven Central) rather than packages.fhir.org, and no terminology server was used (`-tx n/a`), so codes in external code systems (OMB, BCP-47) were not checked against those systems.
- Remaining validator **warnings**, by design: `Encounter.type` uses SUDS's own intervention and contact codes, not the (extensible) US Core Encounter Type value set, because SUDS has no CPT/SNOMED code for a navigation visit; `42CFRPart2` is outside base R4's (extensible) security-labels value set; resources carry no narrative (`dom-6`, a best-practice recommendation); a preferred language SUDS cannot code is sent as text only (common languages are coded in BCP-47).
- **Not yet done:** validation against US Core 6.x/7.x, a run with a terminology server, and **Inferno** (the ONC test kit). A county that needs certification-grade evidence should run Inferno's US Core test kit against its own server.

To repeat the validator run: `FHIR_SAMPLE_DIR=/tmp/suds-fhir node --test test/fhir-uscore.test.js` writes the resources it checked, then `java -jar validator_cli.jar -version 4.0.1 -ig hl7.fhir.us.core#5.0.1 /tmp/suds-fhir/Patient-*.json /tmp/suds-fhir/Encounter-*.json /tmp/suds-fhir/Organization-*.json /tmp/suds-fhir/Location-*.json` (with internet access the validator fetches the packages itself).

| FHIR resource | SUDS source | Mapping notes |
| --- | --- | --- |
| **Patient** (US Core) | `clients` (not deleted or merged) | `identifier`: the client code (`urn:suds:client-code`, type MR) and the Medicaid ID (type MA) if recorded. `name`: official name and, as `usual`, the preferred name. `birthDate`, `gender` (female/male, transgender female→female, transgender male→male, non-binary/other→other, otherwise unknown), `telecom`, `address`, `communication`. The US Core race and ethnicity extensions come from `race_codes` (OMB codes; declined → ASKU, unknown → UNK). `active` is false for closed/inactive/deceased, and a deceased client has `deceasedBoolean`. Goals, flags and emergency contact are **not** shared. |
| **EpisodeOfCare** | `episodes` | `status` active/finished, `period` from opened/closed, `managingOrganization` = the programme. The presenting problem and discharge summary text are **not** shared. |
| **Encounter** (US Core) | `interventions` (id `iv-<id>`), `calls` (id `call-<id>`) | The intervention type becomes `type` (`urn:suds:codesystem:intervention-type`). `class`: VR for phone/video/text or telehealth, HH for home, FLD for field locations, otherwise AMB. A call is always VR, and a crisis call has priority EM. `period`/`length` come from the duration. No-show, declined and similar outcomes → `cancelled`. Visit and call summaries are **not** shared. |
| **Consent** | `consents` of type `part2_disclosure`, `part2_tpo` (or `roi` outside a Part 2 programme) that cover *this* recipient for this purpose, by the coverage rule above | `status` active/inactive. `category`: LOINC 59284-0 plus the SUDS type. `policyRule`: 42CFRPart2 (Part 2 types) or `hipaa-auth` (ROI). `provision`: permit, `period`, `actor` IRCP (the recipient, as display) and `purpose` (ActReason codes derived from the purpose text). A client's consents to *other* organisations are never shown. |
| **ServiceRequest** | `referrals` | `intent` order. Category is SNOMED 3457005 "Patient referral". `code`: the resource category plus "Referral to <provider>". `status`: pending/contacted/accepted/scheduled → active, waitlisted → on-hold, admitted/completed/closed → completed, declined/no-show → revoked. `priority`: routine/urgent/stat. `requester` is the programme. `performer` is `Organization/<resource>` and `HealthcareService/<resource>`. Outcome, barrier and notes are **not** shared. |
| **Task** | `tasks` that belong to a client | `status`: requested, in-progress, completed or cancelled. `priority`, `description` (the to-do's title), `for`, `focus` (ServiceRequest, when the task follows up a referral), `restriction.period.end` (due date). The task's details text is **not** shared. Staff to-dos with no client are never exposed. |
| **Observation** | `clients.risk_level` (id `risk-<client>`) and `overdose_events` (id `od-<id>`) | Risk level: category survey, code `overdose-risk-level`, valueCodeableConcept low/moderate/high. Overdose event: code `overdose-event`, value overdose/reversal/fatal, plus components for naloxone used, naloxone doses, EMS called, hospitalized and survived. Substances and notes are **not** shared. |
| **DocumentReference** | signed or amended `notes` (not drafts, deleted notes, supervision notes or SUD counseling notes) | **Metadata only.** Type is LOINC 11506-3 Progress note (18842-5 for discharge) plus the SUDS format. Also `category`, `date` (signed), `context.period` and `context.encounter`. The attachment has no data and no URL, and its title says the text is not shared. Note titles and text, including SUD counselling content, are **never** sent over FHIR. |
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
- Output: one NDJSON file per type with results, and an `OperationOutcome.ndjson` in `error[]`. That file carries the §2.32 notice and how many clients were left out (no covering consent, or an agreed restriction).
- `requiresAccessToken` is `true`. Files are downloaded with the same bearer token, and only by the client that started the export (another client's job answers 404).
- **Consent is checked at download.** A file is built from the clients covered at kick-off, but the disclosure happens when it is downloaded, so every client in a file must *still* be covered then. If any consent was revoked or expired, or a restriction was agreed, after the build (within the export's lifetime), that file answers **`410`** with an OperationOutcome (`business-rule`: start a new export), is not released, and the refusal is audited (`fhir.export.download.refused`, with a count, not who). A new export leaves that client out. Files that do not name the client are still released. The manifest's `extension["urn:suds:part2"].consent_checked_at` is `download`.
- **Accounting** is written at each file's first download (see *Accounting of disclosures* above).
- **At rest:** the files are written to `<data dir>/fhir-export/<job>/`, encrypted with the database key (AES-256-GCM, `server/crypto.js`). They are deleted when the job is deleted or expires (`FHIR_EXPORT_TTL_MINUTES`, default 60, counted from completion; the manifest carries `Expires`). If the encryption key is rotated while a job's files still exist, those files answer 410.
- **Restarts:** the job's state (never an access token) is kept beside its files as `job.json.enc`, encrypted likewise: which client started it, the output list, who is in each file, and which files were already downloaded and accounted. At startup (`restore()` in `server/fhir/bulk.js`, called by `server/index.js`) a finished export comes back as it was, so the client can keep downloading with a new access token and nothing is accounted twice; an export that was still being built is marked failed (its status answers `500` "the server restarted…"; start again) and its partial files are removed; a directory with no readable state (an older SUDS, a rotated key) is removed. A periodic sweep removes expired jobs.

## Examples

```sh
BASE=https://suds.county.local/fhir/R4
# Discovery (no auth)
curl -s $BASE/metadata | jq '.rest[0].resource[].type'

# Token with a client secret
TOKEN=$(curl -s -X POST $BASE/auth/token \
  -d grant_type=client_credentials -d client_id=$CLIENT_ID -d client_secret=$CLIENT_SECRET \
  -d scope='system/Patient.read system/Encounter.read' | jq -r .access_token)

# Token with a signed JWT (SMART Backend Services). $ASSERTION is a JWT the client signs with its private
# key (RS384 or ES384, header kid = the registered key): iss = sub = $CLIENT_ID, aud = "$BASE/auth/token",
# exp <= 5 minutes ahead, a fresh jti each time.
TOKEN=$(curl -s -X POST $BASE/auth/token \
  -d grant_type=client_credentials \
  -d client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer \
  -d client_assertion=$ASSERTION | jq -r .access_token)

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
                          { "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "NORDSCLCD" } ] },
  "link": [ { "relation": "self", "url": ".../Patient?_count=50" } ],
  "entry": [
    { "fullUrl": ".../Patient/1f5a…", "resource": { "resourceType": "Patient", "id": "1f5a…", "...": "..." }, "search": { "mode": "match" } },
    { "resource": { "resourceType": "OperationOutcome", "issue": [
        { "severity": "information", "code": "informational", "diagnostics": "42 CFR §2.32 notice: This record which has been disclosed to you is protected by Federal confidentiality rules (42 CFR part 2). …" },
        { "severity": "warning", "code": "suppressed", "diagnostics": "5 patient(s) (5 Patient resource(s)) on this page were withheld: no active consent covers County Behavioral Health for this purpose of use, or the patient has an agreed restriction." } ] },
      "search": { "mode": "outcome" } } ] }
```

## Operating notes

- Put the office server behind HTTPS (docs/DEPLOYMENT.md) before giving a FHIR client its secret. The secret is a password for the programme's records; prefer a signed JWT (no shared secret) and make the client JWT-only once it works.
- Behind a reverse proxy with `trustProxy` on, `X-Forwarded-Proto` and `X-Forwarded-Host` set the URLs in links, `fullUrl` and the export manifest.
- The per-IP API limit (600 requests a minute) applies in addition to each client's own limit.
- When a recipient organisation is renamed, add the old name as an alias (it must name the organisation specifically; see *Aliases*). Consents that use the old name then keep working.

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

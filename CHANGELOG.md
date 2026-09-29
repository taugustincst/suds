# Changelog

All notable changes to SUDS are documented here. The project follows semantic versioning.

## Unreleased

### AI documentation copilot

An optional module, **off by default** and **office server only**, that drafts documentation for staff to review
(`docs/AI-COPILOT.md`). A person always reviews and decides: the copilot never saves, signs or submits anything.

- **What it drafts.** Progress notes: from the author's own session notes or transcript, the sections of a DAP,
  SOAP, BIRP or GIRP note, or a narrative for the other formats (not a safety plan), in a folded "Draft with the AI
  copilot" section of the note form. Six-dimension assessments: a narrative and a *suggested* 0–4 rating per
  dimension; the clinician chooses each rating and must tick "reviewed" for all six before saving. Care plan:
  problem, goal, objective and intervention suggestions from an assessment and/or notes, each added one at a time
  through the ordinary care plan routes ("Suggest with AI"). CalOMS: suggested answers in the admission and
  discharge dialogs, each applied only on **Apply** and checked against the CalOMS code sets (read-only use of
  `server/caloms-spec.js`).
- **Review before signing.** Drafts show under "AI draft — review before signing". A note with AI-drafted text is
  marked `ai_assisted` (never cleared, kept as signed, shown as an **AI-assisted** badge), and signing it requires
  the author's statement that they reviewed and corrected it (`ai_reviewed`; the `note.sign` audit entry records
  both).
- **Gating.** An administrator must first record the programme's agreement with the provider — who signed, the
  date, the reference, and confirmation of a BAA with 42 CFR Part 2 QSOA terms and counsel's review — under
  Settings → **AI copilot**, then switch it on (`POST|DELETE /api/ai/attestation`, `GET|PUT /api/ai/settings`;
  audited). The provider key is `ANTHROPIC_API_KEY` in the server environment only. Model setting (default
  `claude-opus-5-5`) and a monthly cap per programme (default 500). Withdrawing the agreement switches it off.
  SUDS on this device and local mode have no copilot and say why (the route module is not in the kernel).
- **What is sent.** Only the text given for one client (and, for care plan suggestions, the one assessment chosen
  and the active problem wording), after the client's names, date of birth, phones, email, address, city, ZIP,
  Medi-Cal number, emergency contact, client code and the author's name are replaced with placeholders and phone,
  email, SSN, URL, street-address and long-number patterns are masked; names are put back on the server after.
  Never another client's data or anyone else's notes; a signed note cannot be redrafted. Documented as not
  de-identification, with the residual risks.
- **Permission** `ai:draft` ("Use the AI documentation copilot"): clinicians, supervisors and navigators by default
  (a navigator drafts administrative notes, care plan and CalOMS suggestions, not clinical notes or assessments, as each draft also needs the permission
  to write what it drafts); not administrators; never grantable to finance or read-only.
- **Provider call** with Node's built-in `fetch` (no new dependency): the Messages API with structured outputs,
  cached system instructions, a 90-second timeout, and for the default model effort `medium` and the provider's
  refusal fallback. Timeouts, rate limits, provider outages, refusals and unreadable answers are said in words
  and leave the form unchanged; each call is audited (`ai.draft`: who, client, feature, model, token counts,
  identifiers replaced — never the text) and counted in `ai_usage`. One person may ask for 12 drafts a minute.
- **Prompts** in one module, `server/ai-prompts.js`: SUD-specific, draft only from what is given, never invent,
  `[needs clinician input]` for gaps, person-first non-stigmatizing language, placeholders kept, the session text
  treated as material rather than instructions.
- **Migration 53**: `notes.ai_assisted`, and the `ai_usage` table (office server only, never synchronised).
  Migration 49 is a documented no-op and 52 is reserved for the publication-release change (no-op until then).
- Tests: `test/ai-copilot.test.js` (permission, gating, attestation, the request body, de-identification, audit,
  usage and cap, provider failures against a local fake provider, a draft never saved or signed). Browser script
  `scripts/ui/r10-ai.mjs` against a fake provider, with axe on the panels, dialogs and the Settings tab (the suite
  is now 50 scripts). Docs: `docs/AI-COPILOT.md`; HIPAA, Part 2, architecture, data lifecycle, deployment, user
  guide and buyer guides updated.

### Access

- **A programme-wide least-privilege default.** Settings → Users & permissions (administrators) has *New navigators
  and clinicians start held to their caseload*. While it is on, every account that becomes a navigator or clinician
  is given a per-user deny of *See every client* (`clients:all`) with the reason "programme default: held to
  caseload", each one audited (`user.permission.deny`, with its cause): an administrator creating the account
  (`POST /api/users`), an approved access request (`POST /api/users/:id/approve`), SCIM provisioning, a role change
  into navigator or clinician by an administrator or by SCIM, and, on SUDS on this device, the device administrator
  creating an account or making one a navigator or clinician. Single sign-on creates no account (its first sign-in
  links the account SCIM provisioned, which was held then). A device sign-up is held to its caseload as before,
  whatever the setting says (and denied clinical notes too). The reset-admin script makes administrators only.
  Only `clients:all` is denied: a navigator keeps reading clinical notes (the 1.16.0 decision); deny *Read clinical
  notes* per person. An individual decision already recorded about `clients:all` (a grant or a deny) is left alone,
  and moving an account out of navigator and clinician lifts the default's own deny, never an administrator's.
- **On for a new install; off for an upgraded office.** A new database starts with the setting on. A database from
  an earlier release starts with it off, recorded once at the first start (a settings row, `caseload_hold_new_staff`;
  no migration), so an upgrade changes nobody's access; while it is off, Users & permissions recommends turning it on.
  Turning it on or off changes no existing account (audited, `settings.caseload_default`).
- **Apply to existing navigators and clinicians.** A one-off action on the same card: a confirmation lists exactly
  who will be held (and who is left alone because they were granted *See every client* individually), and only
  those people change, each audited (`cause: applied_to_existing`), with a summary entry
  (`users.caseload_default.applied`).
- **Who is held, at a glance.** The user list has a *Clients* column: *Every client*, *Caseload only* (with *program
  default* when the setting did it), or *Client codes only* for finance and read-only.
- New routes: `GET`/`PUT /api/users/caseload-default` and `POST /api/users/caseload-default/apply` (`users:manage`).
  No new permission, no migration. Tests: `test/least-privilege-default.test.js` (every office path, role changes,
  apply-to-existing, and that the REST list, search, a record and sync pull then keep to the caseload),
  `test/least-privilege-sso.test.js` (SCIM and single sign-on), `test/least-privilege-device.test.js` (the browser
  kernel), `test/migrations.test.js` (off after an upgrade); browser script `scripts/ui/r10-lp.mjs`.
- Docs: QUESTIONNAIRE #22, IDENTITY.md, HIPAA.md, SOC2-READINESS.md, PART2.md, CALAIM.md, USER_GUIDE.md and the
  buyer pack (market/README.md, BUYER-GUIDE-IT.md, POSITIONING.md, PROCUREMENT.md, PILOT-KIT.md), with the
  threat model, the data inventory and the evidence index, no longer list
  "least privilege is not the default" as a gap for new installs; for upgraded offices it is a setting to turn on.

### Client records

- **Revision history with revert (market review r7 finding 3, r9 1.17.0 item 2).** Since 1.16.1 anyone who can see a
  client may change the record, and the primary worker was told only which fields changed; SUDS kept no earlier
  values, so a wrong date of birth came back only from a backup. Every change to a client's own details is now kept
  as a revision (`client_revisions`, migration 50): who made it, when, how it arrived (`rest`, `sync`, or the gaps a
  `merge` filled in on the record kept) and each changed field's value before and after, encrypted
  (`changes_enc`; the audit entry `client.revision` names the revision and the fields, never a value). Written by
  `PUT /api/clients/:id`, by a device's edit when its push lands (`server/rules/clients.js`) and by a merge; imports
  only create clients. `server/client-revisions.js`.
  - **Who reads it (minimum necessary):** the client's care team (an active assignment, any role on the case) and
    `records:manage-others` (supervisors, administrators), on the record's new **History** tab
    (`GET /api/clients/:id/history`, audited `client.history.view`). Anyone else who can open the record sees it as
    it is now; asking for its history is refused and audited.
  - **Put this change back** (`POST /api/clients/:id/history/:rev/revert`): the primary worker or
    `records:manage-others`. Only while the change's fields still hold what it set (otherwise 409, naming the fields,
    never a value); the same rules as any edit; a new revision naming the one it reverts (`client.revert`), and a
    change notice when the reverter is off the care team. Nothing in the history is updated or deleted.
  - **The change notice links to it.** Its audit entry names the revision; the card's **See what changed** opens the
    History at the changes it reports (`notice_revisions`), for the primary worker and supervisors.
  - **Kept at the office.** Revisions never synchronise (`server/sync-tables.js` `server_only`): a device that syncs
    keeps no earlier values and its History tab says to open the record at the office; its edits are recorded there
    when they land. SUDS on this device, which has no office, keeps its own.
  - **Retention:** purged with the client, leaving no tombstone; not activity (an edit does not extend a record's
    retention). Key rotation re-encrypts `changes_enc` like every `_enc` column.
  - Changes a discharge, an overdose event, a visit or an ASAM rating makes to the record (status, overdose history,
    naloxone, level of care) are recorded on those records, not as revisions. Values from before this release were
    never kept and are not in the history.
  - `server/sync-tables.js` now declares the encrypted columns of the tables that never synchronise too
    (`unsynced_enc`), and `test/sync.test.js` checks it against the schema. Migration 49 is a no-op (1.17.0's
    least-privilege default needed no schema change); this one is 50.
  - Docs: USER_GUIDE (*A client record's History*), HIPAA.md (integrity, amendment, retention), PART2.md (§2.16),
    QUESTIONNAIRE #22, POSITIONING, BUYER-GUIDE-IT and BUYER-GUIDE-PROGRAM (earlier values are now kept). Tests:
    `test/client-revisions.test.js`; browser: `scripts/ui/r10-hist.mjs`.

### Prevention and syringe services

A feature release item (1.17.0): migration 51, one new table, two new columns, new routes, no new permission.

- **Anonymous SSP participant code.** A contact with no client record (outreach, community distribution) can carry
  the participant code the person builds the same way each time by the programme's recipe (the visit form suggests
  one; SUDS stores only the code, never the details it is built from). It is kept in one form (capitals, letters and
  digits, 4–20 characters), **encrypted** (`interventions.participant_code_enc`) and counted by its **blind index**
  (`participant_code_idx`, HMAC under the index key; `scripts/rotate-index-key.js` re-derives it). A code on a
  contact with a client is refused, over REST and by sync alike (`server/rules/interventions.js`); a device's code is
  normalised and indexed with the office's key (`server/sync-tables.js` importRow), and a pull never sends the index.
  The **SSP summary** (`GET /api/reports/ssp`) now counts **Anonymous participants** — the different codes at the
  period's anonymous contacts — beside the participants served (clients), never added to them, under the same
  small-cell rule, with the anonymous contacts that had a code; its files print no code. A visits export,
  de-identified or identified, carries a **participant reference** (`P-…`, random for each file) instead of the
  code. The count is not part of any publication release. The docs no longer say that no field holds a participant
  code ([docs/SUPPLIES.md](docs/SUPPLIES.md), *Participant codes*).
- **Group and community prevention events** (SABG primary prevention). A **Prevention** page
  (`/api/prevention-events`, `interventions:read`/`interventions:write`; another worker's event is theirs or a
  holder of `records:manage-others`'s to change or delete, from a device as over REST —
  `server/rules/prevention_events.js`): date, what it was, kind of event, **CSAP strategy**, **IOM population
  category**, audience, place, hours, attendance (a headcount, marked when estimated; never names), fund and notes
  (encrypted). The strategies, IOM categories, kinds of event and audiences are Settings › Lists option lists with
  codes and labels; the CSAP strategies and IOM categories can be reworded but not added to, and *Training* cannot be
  retired. The table synchronises to every device whose role reads visits.
- **Prevention activity summary** (`GET /api/reports/prevention`, `reports:read`; `/export?format=xlsx|csv`, also
  `export:read`): events, hours, attendance and **people trained** (the attendance of training events) for a period,
  by strategy, by IOM category, by both and by kind of event. It is **not a PPSDS file**: the PPSDS field mapping
  awaits the DHCS PPSDS data dictionary, and the file and the page say so. Audited (`report.prevention`,
  `report.prevention.export`).
- Docs: the buyer guides, POSITIONING, SCOPE, the market scorecard (the SABG primary-prevention row now says
  exactly what exists and what does not), PILOT-KIT Q0, PROCUREMENT, HIPAA data classification and the USER_GUIDE.
  Browser script `scripts/ui/r10-prev.mjs` (the suite is 50 scripts); API tests in `test/prevention.test.js`.

**Not in this change:** a PPSDS-shaped export (needs the DHCS PPSDS data dictionary); an evidence-based programme
field and attendance by demographic group (only if the dictionary asks for them); anonymous participants in a
publication release (a new count of people in the release's audit needs the statistical review first).

### Part 2 layer, CalOMS and referrals

Schema migration 55 (52 and 54 are documented no-ops for the publication-release and settlement/outreach changes). New routes,
each with API tests; no new permission.

- **SUDS as the Part 2 layer beside an EHR.** A third programme profile, **Part 2 compliance module (beside an
  EHR)** (`part2_layer`; Settings › Program, and the setup wizard), for a treatment programme whose EHR
  (eClinicalWorks, Epic, SmartCare…) stays the clinical record: the care plan, assessments, CalOMS and the hand-off
  are off by default, the FHIR API on; Supplies, Street outreach, Overdose, My time, Funding, Settlement outcomes and the
  funder report leave the sidebar;
  Privacy & Part 2 leads it and opens on a new **Part 2 layer** tab — consents (live, expiring, pre-2024 form, active
  clients without one), disclosures by source, the §2.32 notice, counseling notes, patient requests and their
  deadlines, breaches and complaints, secure referrals and the EHR integration, as counts (`GET /api/part2/layer`,
  caseload-scoped). Every Part 2 control is the same in every profile.
- **Import from the EHR.** Import offers *Patients from your EHR* and *Encounters from your EHR*: a FHIR R4 Bundle or
  Bulk Data NDJSON is turned into the rows a spreadsheet would give and goes through the spreadsheet import's own
  preview, validation, duplicate check and commit (`POST /api/imports/ehr/preview`; `server/importers/fhir-ehr.js`).
  SUDS never connects to the EHR.
- **FHIR Provenance.** Each Consent the FHIR API serves has a `Provenance` (`consent-<id>`: who holds it, when it
  was signed and recorded, and §2.31/§2.32 as policy), listed exactly when its Consent is and accounted the same way.
- **Integration guide and positioning.** docs/integration/EHR-PART2-LAYER.md (what to connect, data flows, what
  stays in the EHR); docs/market/POSITIONING.md gains "the disclosure-compliance module your EHR doesn't have",
  stating plainly that it is software support for Part 2 controls, not a certification.
- **CalOMS Tx monthly automation.** An administrator can have SUDS check the previous month on a set day and
  **prepare** its submission file — program-wide, every implemented edit check — one file or one per provider ID. A
  prepared file is not a disclosure: nothing is accounted or stamped until someone with `export:identified`
  **produces** it (`POST /api/caloms/submissions/:id/produce`), which accounts exactly those bytes and sets
  `extracted_at` as a hand-produced submission does, and is refused if any record in it changed since (then
  **discard** and prepare again). A **worklist** assigns each validation error to the record's owner
  (`GET /api/caloms/worklist`; *Mine* / *Everyone's*). A **submission log** records who prepared, produced,
  downloaded, recorded the upload to DHCS (with the portal's reference) or discarded each file
  (`caloms_submission_events`). SUDS still does not submit to DHCS and holds no DHCS credentials.
- **County mode, the safe part.** Each CalOMS provider ID can carry its legal name and NPI (check digit verified), and
  a submission can be made for one provider. SUDS has no multi-organisation concept; several unrelated provider
  organisations on one server is not supported. The design for it is docs/architecture/COUNTY-MULTI-TENANT.md (until
  then: one instance per provider, hosted by the county).
- **Secure referral links.** A referral to an organisation not on SUDS can go as a one-time link the provider opens
  without an account (*Secure link* on a referral; `/referral-link.html`). With a live Part 2 consent naming the
  provider it carries a minimal referral (name, reason, urgency; phone and date of birth only if ticked), behind an
  access code given separately and claimed by the first browser; the consent is re-checked at every open and the
  disclosure is accounted when it is first opened. Without one, only a "please contact us" notice that names nobody.
  Tokens are 256-bit, in the URL fragment (never in a server log or Referer), stored hashed; links last 1–7 days, can
  be withdrawn, lock after five wrong codes, and every open is audited. The provider can say what happened, which
  gives the worker a to-do to record the outcome, and is invited to receive referrals through SUDS. Office server
  only. Threat model: docs/security/REFERRAL-LINKS.md.
- **Secure referral links are a programme setting, off by default** (market review of the 1.17.0 candidate): a new
  install and an upgrade start with it off; an administrator switches it on under Privacy & Part 2 → *Secure
  referral links* (`PUT /api/referral-links/settings { enabled }`, audited as `settings.update`; `GET` says whether
  it is on, and `GET /api/auth/me` tells the browser, which hides *Secure link* while it is off). Off, making a link
  is refused (`409`) and links already sent stop opening. The documents say counsel reviews the design as built
  before a programme switches it on, and that the office server must then be reachable from the internet.
  `test/referral-links.test.js`.
- Browser suite: `scripts/ui/r10-part2.mjs`.

### Settlement outcomes and street outreach

Two features for 1.17.0. No migration and no new permission; three new routes (`GET /api/reports/settlement-outcomes`,
`GET /api/reports/settlement-outcomes/export`, `GET /api/outreach/shift`).

- **Settlement outcomes** (sidebar → *Settlement outcomes*, for finance, supervisors and administrators:
  `reports:funder` or `reports:internal`, with `budget:read`). For each opioid settlement fund, each on its own (a
  county's, a city's and the state's share), what it spent beside what the programme recorded of the work charged to
  it: naloxone kits distributed and reversals reported for overdose-reversal spending; contacts, test strips and
  syringes for harm reduction; people served, admissions, referrals and people linked to care and to medication for
  OUD for treatment and recovery; education sessions, people trained and staff training hours for prevention and
  training. By Exhibit E category, by fund and by month, with the cost per outcome (spending under the fund's own
  category divided by it) where that means something. Which outcomes each category shows is one module,
  `server/settlement-outcome-map.js`, with its own tests. Every count of people goes through the funder report's
  small-cell rules and counting modes, protected across the settlement total, each category, each fund and each
  fund's months; the page and its files are **suppressed by default, for finance too** (`<11`, `suppressed`), exact
  on request for the roles the funder report allows, never a publication release, and **no cost per outcome is
  shown beside a hidden count**. Excel, CSV and a printed page, made when the signed-in person asks and audited
  (`report.settlement_outcomes`, `.export`); SUDS sends nothing anywhere. It says what it is: the programme's own
  figures, not an official state reporting system (docs/compliance/HARM-REDUCTION-REPORTING.md, section 5).
- **Street outreach** (**+ Log → Street outreach contact**, or the sidebar). One phone screen for anonymous field
  contacts, one-handed at 390 px with targets of 48 px: the kind of contact (the services that need no client), −
  count + for naloxone kits, test strips, syringes, wound care and the programme's other usual items (any other item
  from the supplies catalog one choice away), a coarse place and the supply site, and a line of notes without
  identifiers. A contact is an anonymous visit through `POST /api/interventions`: its supplies come off the stock by
  the supply rules, it syncs like any visit, and the funder report, the NDP log and the syringe services summary
  count it. It works with no connection on SUDS on this device and on a device that syncs with an office (the
  office draws its own stock down once, at the next sync). **My shift** (`GET /api/outreach/shift`) counts the
  worker's own contacts since the start of the day or of the shift they started, without notes. A worker can make it
  their start page (on the screen, or **My profile → Start page**; the `start_page` preference), used after
  sign-in and when SUDS is opened with no page in the address. The screen takes the anonymous SSP participant code
  (*Prevention and syringe services* above) as the visit form does, and **My shift** counts the different codes
  among the worker's contacts (`participants`, by blind index; never a code). Under the Part 2 compliance module
  profile both pages leave the sidebar, as Supplies and Funding & spending do.
- **Tests:** `test/settlement-outcome-map.test.js` (the mapping, the cost per outcome and the small-cell protection
  as pure functions), `test/settlement-outcomes.test.js` (the routes, roles, counting and files),
  `test/outreach.test.js` (contacts, stock, the shift summary, reports), `test/outreach-device.test.js` and
  `test/outreach-kernel-sync.test.js` (the browser kernel with no office, and a device that syncs with one), and the
  browser script `scripts/ui/r10-outreach.mjs` (in the suite, now 50 scripts).

### Privacy

- **A filed import page no longer outlives its note or its client.** When an imported page (a OneNote export, a
  Pocket AI transcript) was filed as a note, its `import_items` row kept its own encrypted copy of the text, title and
  the client-name hints sniffed from it. A client's retention purge only unlinked the row's suggested client, and
  purging the import deleted only staged and discarded pages, so the text stayed indefinitely after the record it
  belonged to was gone (evidence-pack review of 1.16.4). Now filing clears the item's text, title and hints (the note
  is the record; nothing needs the copy, as no import is deduplicated by its text), at both doors: `POST
  /api/imports/items/:id/commit` and a device's sync push of a committed item (`server/rules/import_items.js`).
  Purging a client hard-deletes (and tombstones) every import item filed as one of its notes or suggested for it,
  staged or committed (`counts.import_items` on the `client.purge` audit row, replacing `import_items_unlinked`).
  The daily retention pass clears the copies earlier versions left on committed items (`import.committed_text_cleared`,
  audited with a count only), and purging an import batch clears them for its committed items too. No migration: it
  is a data cleanup in the retention pass, done the next time it runs (within a day of the upgrade).
  The data inventory, the threat model and QUESTIONNAIRE #13 no longer list it as a gap. Tests:
  `test/import-text-retention.test.js`; `test/sync.test.js` now expects a purged client's import items deleted and
  tombstoned.

### Engineering

Release machinery and CI only: nothing here changes what SUDS does for a user, and no administrator action is needed
on a SUDS install. The owner has repository settings to make (below).

- **The repository settings are checked every week** (engineering reviews of 1.16.1 M2, 1.16.2 L5, 1.16.3 L6). A new
  workflow, *Repository settings* (`.github/workflows/settings-check.yml`, weekly and *Run workflow*, read-only, no
  action), reads through the GitHub API the settings RELEASE.md asks the owner to make (the rulesets for `main`,
  `maint/*`, `v*` tags and `gh-pages`, the `release` environment's reviewers and deployment refs, immutable
  releases, the default workflow token and allowed actions, the deploy key and its secret, stale `release/v*`
  branches) and fails, with one row per setting in the run summary, when a setting is off **or cannot be read**:
  a refused request is "cannot verify", never a pass. The workflow's own token cannot read the admin-only settings,
  so until the owner gives it a read-only token the run stays red on those rows. **Owner:** RELEASE.md, *Owner:
  repository settings*, step 9 (a fine-grained, read-only token as `SETTINGS_READ_TOKEN` in a `settings-check`
  environment limited to `main`). Ruleset bypass lists, which no read-only token can see, are listed to check by hand.
- **A 1.16.x security fix can be released after 1.17.0** (engineering review of 1.16.1, M3). A patch of a minor
  older than `main`'s may now be released from that minor's `maint/X.Y` branch: the gate accepts a commit on
  `origin/maint/X.Y` only for such a version, the release policy measures it against the previous tag on its own
  line (1.16.5 against v1.16.4), and the release is not marked Latest and does not publish the web app;
  `web-app.yml` now publishes only the newest release tag. **Owner:** add `maint/*` to the `main` ruleset and a ruleset
  that lets only an administrator create a `maint/*` branch (RELEASE.md, step 2); the procedure for making the
  branch and releasing a backport is in RELEASE.md, *Backports*.
- **The migration check also watches what released migrations depend on** (engineering review of 1.16.0, M6).
  `scripts/migration-order.js` fingerprints the helpers each released migration runs (`rebuildTable`,
  `encryptColumn`, functions it requires) and the `schema.sql` definitions it reads, and fails CI when one changed
  since the previous release unless the change is acknowledged, with a reason, in `DEPENDENCY_CHANGES`. Run over
  history it would have stopped 1.13.0 and 1.14.0 for such changes.
- **Workflow tests read the YAML as data** (engineering reviews of 1.16.1 L6, 1.16.3 L7). `scripts/workflow-yaml.js`
  parses the YAML the workflows use, with no new dependency (it gives the same data as PyYAML on all four), and
  refuses anything else with a line number; `test/workflow-yaml.test.js` checks write scopes, environments,
  triggers, actions and the required jobs as data. Checks of what a step's shell script does stay text matches.
  `actionlint` 1.7.7 is clean on all four workflows; it is not yet a CI step.
- **The browser suite gives `accessibility` 1,800 s** (about 600 s on CI, up to about 1,200 s on a loaded development
  container); every other script keeps the 900 s per-script limit, and `SUDS_SCRIPT_TIMEOUT` still overrides both
  (`scripts/ui/run-all.sh`).

Fixes from the engineering review of the 1.17.0 candidate (at `c1a3578`, before the stamp). Unlike the items above,
three change what a user sees: where the participant code sits on the visit form, and the AI copilot's cap and
messages. No migration, permission or route.

- **The whole browser suite is green on the merged candidate** (H1). Two streams had broken older scripts nobody
  re-ran after the merges, so the candidate's required `browser` job failed: `spreadsheets` looked for the Import
  page's file input by an accept list the FHIR import had grown (it now finds the input of the import card), and
  the SSP participant code put an eighth field on a new outreach or naloxone-distribution visit at 390 px (ux13's
  budget of seven): it now sits folded under **Participant code (optional)**, right below Client, one tap away,
  opening by itself when the visit or a resumed draft has a code or for an error. RELEASE.md: when several streams
  are merged, the whole suite must be green on the final merge commit before the stamp.
- **The check's step skips at most one value per count** (M1, `server/sdc.js` `widenRange`). As first merged it
  could skip at every step, never two in a row, so a count passing with a span of P = ceil(T/2) could alternate hole,
  value, hole and stand behind ceil(P/2)+1 values rather than P+1. With one skip a passing count has at least P.
  Every skip the review measured was a single one, so no publication rate changes. `test/sdc-skip-one.test.js`
  tests the step alone (random holes, the alternation) and on the attacker's families (in `SDC_SWEEPS`); ADR-0009
  says what the skip costs and corrects the enumeration-margin rationale (above).
- **The publication perf test** (M2) no longer asserts a wall-clock bound in `npm test` (the 1,500 ms event-loop
  bound runs in the thorough job only), and the server's worker-thread offload is tested again: since 1.17.0 the
  5,000-person year audits too lightly to tell the worker from the inline path, so a deliberately heavy release
  (`test/fixtures/heavy-audit.js`, about 30 million units) is audited both ways and the worker must hold the event
  loop under half as long.
- **A 1.16.4 upgrade fixture** (M3): `test/fixtures/release-v1.16.4.sql`, a `--rich` database the released 1.16.4
  (`6491308`) wrote, with a permission override, an import item filed with its text and CalOMS submissions. 1.17.0's
  first start on it is tested: the least-privilege default recorded off, every account's role, status and overrides
  unchanged (also after a restart), migration 55's defaults on the existing submissions, the retention pass clearing
  the filed item's text and keeping staged ones', and fresh and upgraded structurally identical.
- **AI copilot provider calls** (M4, `server/ai-copilot.js`). A failed call (rate limited, unavailable, timed out,
  refused as a request) is recorded and shown but **no longer counts against the monthly cap**, which counts drafts
  the provider returned (including one it declined or cut off). A 400 or 404 says the provider refused the request
  and to check the model setting (a 413 says to shorten the text), not "shorten the text". The deadline is 180 s (it
  was 90 s, for a non-streamed request of up to 16,000 output tokens from a model that always thinks), and it covers
  **one retry** after a 429, 5xx or 529 or a failed connection, after the provider's `retry-after` when that is at
  most 10 s. Settings shows failed calls apart from drafts used.
- **The settings check warns rather than fails until its token exists** (M6). With only the workflow's own token, a
  setting that token is refused is "cannot verify (add SETTINGS_READ_TOKEN)", a warning; a setting it reads and finds
  off still fails. With `SETTINGS_READ_TOKEN`, cannot-verify fails as before. The check also reads the
  `settings-check` environment's deployment rule (`main` only), and RELEASE.md step 9 gives the order: create the
  environment, limit it to `main`, then add the secret.
- **The maintainer map describes 1.17.0** (M5): `docs/architecture/README.md` has a row per new module (rule file or
  routes, tests, office-only or not); `docs/PERFORMANCE.md` describes the device's audit worker.
- **The device audit runner hands the worker one audit at a time** (L1), so its 75 s backstop counts an audit's own
  time, not the time it queued behind another; a worker that was only slow to start is tried once more before the
  page is used for the session. ADR-0009 says why the device's backstop is 75 s and the server's 60 s.
- **The CalOMS scheduled run is idempotent per provider** (L2): a provider whose file the schedule already prepared
  (still waiting to be produced) is not prepared again, and one whose file could not be prepared leaves the month
  open, so the next hourly pass tries only that provider instead of preparing every file twice.
- **CI's browser job has 50 minutes** (L3; it had 75): the 51 scripts take 23 to 27 minutes on CI, accessibility
  595 to 634 s.
- **1.16.4 is recorded as `6491308`** (H2), the commit on `main` that is live on GitHub Pages, not `d95b69a` (not on
  `main`, its CI failed, never published): the evidence README, the questionnaire, the SBOM (regenerated from it)
  and HANDOFF. RELEASE.md records its publication by a direct `gh-pages` push at the owner's request, and that until
  the owner tags `v1.16.3` (`fc5e9d7`) and `v1.16.4` (`6491308`) the release policy, the migration baseline and the
  backport procedure measure from `v1.16.2`.

### Security

Fixes from the security review of the 1.17.0 candidate (r10) and the copilot and referral-link rules from the market
review. No migration, no new permission, no new route; each with a test that failed first
(`test/security-1170.test.js`, `test/ai-copilot.test.js`, `test/referral-links.test.js`).

- **M1: the import previews no longer say whether someone is a client here.** The spreadsheet and EHR previews
  (`POST /api/imports/data/preview`, `/api/imports/ehr/preview`) matched each name against every record and gave
  back the client code, so a worker held to their caseload could learn that a person they cannot open is a client,
  and their code. Now they apply the live duplicate check's rule: a match the caller may open is shown; one they
  may not reads as no match, and a supervisor gets a review task on that record instead (not on the caller's list).
  At commit, *skip duplicates* skips only a visible match: a hidden one is imported and flagged for a supervisor to
  compare, as at intake. A preview of clients counts against the duplicate check's per-worker limit (60 per 15
  minutes), and its audit entry records counts only.
- **L1: an AI-assisted note is signed only with the review statement, by sync too.** A device's push could sign an
  `ai_assisted` note without the author's statement that they reviewed the drafted text. The notes rules now refuse
  it (`server/rules/notes.js`; the device sends the statement its own sign route asked for, and the `note.sign`
  audit records `ai_assisted`/`ai_reviewed` as over REST). A draft asked for in a saved note (`note_id`) now marks
  that note AI-assisted on the server; the `ai.draft` audit entry, with the note's id, is the authoritative record
  (docs/AI-COPILOT.md).
- **The copilot does not draft SUD counseling notes** (§2.11; market review): the draft route refuses a note flagged
  as one, or one being written with the box ticked, and the note form hides the copilot while it is ticked; a note
  with copilot text cannot be flagged as a counseling note (web and sync). As the strategy's risk table says, until
  counsel says otherwise.
- **L2: a referral link is not opened for a removed or merged record, or a closed referral**, and the recipient's
  names are kept with the packet when the link is made: the consent is re-checked against them and the accounting
  names that recipient, so renaming the directory entry afterwards changes neither.
- **L3: the public referral-link routes cannot flood a worker's list or the audit log.** A recipient's repeated
  answers update the link's one to-do rather than adding one each; refused opens are written one by one only for
  the first 10 an hour per link (and for unknown tokens together), then counted and summarised hourly with the
  busiest addresses; and all addresses together are limited (600 per 10 minutes) as well as each one.
- **L4: CalOMS files and a worker held to a caseload.** The submission list, download, log, discard and "uploaded"
  routes now apply the same rule as prepare and produce: a worker held to a caseload reaches only the files they
  produced themselves from their own caseload, not the whole programme's.
- **L5: copilot de-identification catches more of what SUDS knows.** Names match without accents or apostrophes
  (José/Jose, O'Brien/OBrien) and with a hyphen or a space; the date of birth in more forms (ordinals, year first,
  dots, day first, words); the street abbreviated or in lower case (Old Mill Rd); and any date written after "DOB"
  or "born". The author's surname alone is masked only written as a name (not "Patricia Jones", not "the jones
  family"). Still not de-identification: docs/AI-COPILOT.md lists what it misses.
- **L6: no copilot for a client with an agreed restriction.** SUDS cannot tell whether a granted §164.522 / §2.26
  restriction covers sending the client's text to the AI provider, so every draft for that client is refused before
  anything is sent, and audited.
- `server/caloms-schedule.js`: a prepared file is described as "checked against SUDS's own edits", not
  "submission-ready".

### Documentation

Evidence for county IT and procurement review, and the 1.17.0 go-to-market documents. Documentation only: no
migration, no new permission, no new route.

- **A software bill of materials.** `scripts/sbom.js` (Node built-ins and git only) writes a CycloneDX 1.5 SBOM of
  a tag or the working tree:
  - the Node.js release CI pins, with its tarball hash, and the built-ins the server uses (it fails if `server/`
    ever requires anything else);
  - the Docker base image;
  - SUDS's own `server/`, `public/` and `scripts/` trees;
  - the vendored and generated browser files (the kernel, `sql-wasm.wasm`, their compressed copies, `qr.js`,
    `schema-text.js`) with SHA-256 and SHA-512;
  - the seven npm packages bundled into the kernel, and the SQLite release inside the wasm;
  - separately, scoped *excluded*, the build tooling, the test-only tools CI installs and the pinned GitHub
    Actions.

  `docs/evidence/sbom-1.16.4.cdx.json` is generated from the released 1.16.4 commit (`6491308`; until the review of
  the 1.17.0 candidate it named `d95b69a`, an earlier 1.16.4 stamp that is not on `main` and was not released).
  `test/sbom.test.js` regenerates it and requires the same bytes wherever that commit is in the clone (in CI,
  once the tag exists), and runs the script on the current tree.
- **A threat model** (`docs/security/THREAT-MODEL.md`) covers:
  - the office server, local-mode sync as a second door, SUDS on this device, publication releases and the
    release pipeline;
  - the actors, and the threats and mitigations by area, each with its file and test;
  - the attack classes the project's reviews found and fixed from 1.15.4 to 1.16.4;
  - the residual risks, stated plainly: the owner's repository settings are not in force; there is one
    maintainer and no independent review; there has been no penetration test; shared devices separate accounts
    by rule, not by key; least privilege is a setting an upgraded office must turn on (the 1.17.0 default below).
- **A data inventory for privacy review** (`docs/security/DATA-INVENTORY.md`) gives:
  - every encrypted column by table, whether devices receive it and what retention does to it;
  - the readable columns that are still sensitive, and the blind indexes;
  - every flow out of the database, with who can start it, its gate and its record;
  - retention, and the known gaps.

  `test/data-inventory.test.js` fails when `schema.sql` gains or loses an `_enc` column the inventory does not
  list, or when the inventory disagrees with `server/sync-tables.js` or `server/retention.js`. Writing it found one
  gap: a committed import item kept its encrypted text after its client was purged, and nothing deleted it (fixed
  in 1.17.0, *Privacy* above).
- **The security questionnaire was checked against 1.16.4.**
  - Every answer cites its file or test, and owner items are marked.
  - New answers #46–#50 cover the SBOM, the threat model and data flows, vulnerability disclosure, support, and
    accessibility.
  - Corrected: the commit count (480 of 512 AI-assisted), the incident register's location, and the fact that
    there is no `LICENSE` file yet.
- **An evidence index** (`docs/evidence/README.md`) maps each common county IT review question to its documents,
  tests and CI jobs, and lists what is owner-pending.
- **Support, said once** (`docs/SUPPORT.md`): the programme's administrator, whoever runs the server, the public
  issue tracker and private vulnerability reports.
  - The SLA template's values are now all `[owner to complete: …]`, and the template is marked as an owner template
    that is not in force.
  - The IT buyer guide, the scorecard and the RFI boilerplate were brought in line.
- SDLC.md and VULNERABILITY-MANAGEMENT.md describe the current release flow and the SBOM. HIPAA.md's summary table
  points to the inventory, and no longer calls visit summaries and time and spending descriptions plaintext. The
  pen-test scope adds the 1.16.3–1.16.4 classes.
- **Go-to-market strategy for 1.17.0** (`docs/market/`). New: `STRATEGY.md` (the owner's strategy: segments, the
  create / capture / defend wedges, sequencing with the AI documentation copilot first, the forward-deployed
  (FDE) delivery model, built vs planned stated exactly, risks and metrics), `PRICING-OPTIONS.md` (pricing models
  for the owner to decide, with a worksheet; nothing decided, no competitor prices) and `DATA-NETWORK.md` (the
  de-identified outcomes dataset and the referral network as a design, not built, with the HIPAA §164.514, 42 CFR
  Part 2 §2.52–§2.54 and California analysis and what counsel must review). Positioning now leads with the Part 2
  layer beside the EHR, field-ready outreach and funder outcomes (`POSITIONING.md`, the pack's `README.md`, the
  top-level README); `PILOT-KIT.md` adds a county pilot delivered with the FDE service; the buyer guides, the
  pricing hypothesis and `docs/PLATFORM.md` say what is planned and what is built but not yet released (the copilot, *AI documentation copilot*
  above, is office-server only). The CalOMS extract is described as checked by SUDS's own edits and still to be verified
  against the DHCS data dictionary; SUDS does not submit to DHCS.
- **Pre-release corrections (market review of the 1.17.0 candidate).**
  - Secure referral links: `docs/market/DATA-NETWORK.md` says what was built (the client's name and reason behind a
    six-digit code, no account, a first-browser claim) and why it departs from the sign-in design, and that counsel
    reviews it before a programme switches it on; REFERRAL-LINKS.md and DEPLOYMENT.md say the office server must
    then be reachable from the internet; PILOT-KIT and the pack's README no longer call the links "not built".
  - The Part 2 layer's scope: POSITIONING and `docs/integration/EHR-PART2-LAYER.md` say SUDS gates and accounts only
    the disclosures made through SUDS, and that disclosures the EHR makes are recorded by hand (Consents tab →
    *+ Disclosure*, `POST /api/clients/:id/disclosures`); the unsourced claim about what EHRs lack is softened.
  - `STRATEGY.md` brought up to date: what is built for 1.17.0 under Create 1–3 and Capture 4–6, the refusal band
    1.17.0 leaves, the sequencing steps, and a risk table that is now true (counseling notes excluded); the pack's
    README (rules, the Finance row, the counsel rows), EVALUATION-RESPONSE's status line and the top-level README's
    profiles likewise.
  - One phrase for an unreleased feature, "built for X.Y.Z, not yet released", and `test/release-wording.test.js`,
    which fails once the version is stamped while a document still says so (added to docs/RELEASE.md's stamp
    checklist).

### Publication

Programmes with roughly 90 to 340 overdose events a year were refused a publication release whole (1.16.2 to
1.16.4), because the check of each month's overdose events not reversed failed at a cost the audit's budget could not
meet. No migration; no new permission or route.

- **The overdose events by month are no longer part of a publication release** (a choice of method, the same for
  every period and programme, made before any figure is read, so leaving them out says nothing about anyone). A
  release prints the period's events, reversals, fatal and community-reported totals, the reversals by month (the
  funder report's months and the NDP log's, one table) and the doses; the programme's own submission to its funder
  still has the events by month. The page, the release (`release.not_published`) and the funder report's About sheet
  say so. Why it is sound: without them a reader knows only that the reversals are at most the events, which the
  audit now states; each month's events not reversed can be anything up to the period's, which the audit already
  protects, and the algorithm-aware attacker checks every month's true events and events not reversed as hidden
  counts (docs/architecture/ADR-0009, *Events by month: not published*, with the options weighed: events by quarter
  still refused the benchmark year, a data-dependent choice is the 1.16.1 case, a reserved degrade budget cannot
  pay for the validation). Measured at the default threshold on the same programmes: the benchmark's 2,000-client
  year publishes in 0.25 million units of work (1.16.4 refused it after 400 million, about 9 s); 4 of 114 scaled
  fiscal years are refused (1.16.4: 34), none of 18 seeded years (6) and 11 of their 72 quarters (28). Not every
  period gains: 3 quarters that 1.16.4 published are refused now, among them the benchmark's last; what is still
  refused is small overdose counts beside small reversals by month, and tiny programmes at small thresholds are
  often refused as before (docs/PERFORMANCE.md, *Which programmes are refused*). The two thorough sweeps run in about
  1 and 3 minutes instead of 6 to 20 and 4 to 9. Of 300 tiny random programmes (1 to 12 people, T = 3 to 5), 182 are
  refused (212). **Do not publish again a period published under 1.16.x**: the two
  releases hide differently and can be set side by side (docs/HIPAA.md, *Across releases*).
- **The check steps over one value** (`server/sdc.js`): a suppressed count's range, stepped outward from its value,
  no longer stops at a single value no world that prints the release has (a month's reversals printed exactly when
  the other months' small reversals add up to the threshold), which refused quarters whose count ranged widely on
  both sides of it. It steps over **at most one value per count**, so a count that passes stands behind at least
  ceil(T/2) values that worlds printing the release show, one fewer than without the step (below, *Engineering*).
  The rule (the span of the values) is unchanged, and every value counted is still shown by a world found and run.
- **The audit log records what a release withheld, and why a release was refused.** Every report of a publication
  release (`report.funder`, `report.naloxone_ndp`, `report.opioid_settlement` and their exports) records the
  release's id and each withheld table with its reason code (`withheld: [{table, reason}]`, `protect` or `check`);
  a refused release writes `report.publication.refused` (not a success) with why (`budget`, `backstop`, `headline`
  or `unprotected`), how many counts the check could not show protected, the tables it had withheld and the
  audit's work. Table names and codes only, never a count of people; the person is still told why in words
  (`test/publication-audit-log.test.js`).
- **On a device the audit runs in a Web Worker**, off the page's thread (engineering reviews of 1.13.0 to 1.16.3:
  it ran on the page for up to the 60-second backstop and could hold a phone). The worker is a second generated
  bundle, `public/local/audit-worker.js` (built by `npm run build:local` beside the kernel, with its `.gz` and `.br`,
  precached by the service worker under the kernel's version); `local/audit-runner.js` starts one long-lived worker,
  refuses an audit it stops answering within 75 s and stops it, and where no worker can start (no Web Workers, the
  script does not load or does not start within 10 s) the audit runs on the page as before. The same code and budget
  either way, so a device's release is the office's (`test/device-audit-worker.test.js` runs the committed worker
  as a browser does).
- The degrade fixture is a new one (`test/fixtures/degraded-release.json`: 11 people at T = 4, the funding-source
  table withheld); 1.16.4's, degraded to the reversals total, is refused now (its degraded release could not be checked).
  The attacker's families gain three with months (three months; reversed, fatal and neither events with community
  reports; one or two doses a reversal), and every family with months checks the months' events and events not
  reversed. The attacker found no leak at T = 3, 5 and 11 in the existing families or the new ones (at T = 11, two
  months with 24 events, every split of events and reversals); a first run of the new outcome family, enumerated only
  two events past the sizes it checked, reported a suppressed total of 3 or 4 whose worlds, run further, include 6:
  a false alarm. The attacker is monotone (more worlds only widen what it holds possible), so a family enumerated
  too short can only raise false alarms, never hide a leak; the families are enumerated a few past, and a reported
  leak is enumerated further before it is acted on (docs/architecture/ADR-0009, *Known limits*).
  The month families run in a file of their own (`test/publication-release-months.test.js`, in `SDC_SWEEPS`) beside
  the others; `node scripts/test-thorough.js --part sdc` took 9.6 minutes on CI (the months file 5 minutes), inside
  the thorough-sdc job's 60 (about 27 minutes on a loaded 4-core development container).

### Frontline

Fixes from the frontline-UX review of the 1.17.0 candidate (round 10). No migration and no new permission or route;
the revert route takes an optional `fields`, the Notes list returns `ai_assisted`, and the referral-link open route
refuses a code that is not six digits without counting it.

- **No "null" on screen (H1).** *My shift* showed "nullnull" at the start of every shift, every AI copilot panel and
  the care plan suggestions showed "null", and so did the Secure link dialog: the DOM's own `append()` and
  `replaceChildren()` write a null as text, where `h()` leaves it out. Those calls (and the same shape in the
  signature check, the role baseline and the recovery drill card) now go through `h()` or `.filter(Boolean)`.
  `test/no-null-append.test.js` finds that shape in the browser code, and `STRAY_TEXT_PROBE` in `scripts/ui/assert.mjs`
  checks every page and dialog the accessibility audit and the r10 scripts open for "null", "undefined", NaN or
  "[object Object]" shown as text or in a name.
- **An AI draft never replaces what the clinician wrote without asking (H2).** An empty section is filled. When
  sections already hold the clinician's words, the panel asks, naming them (*You have already written in S
  (Subjective) and P (Plan). Keep what you wrote?*): **Keep mine, add the draft below it** (the default, where the
  focus lands), **Keep mine, fill only the empty ones**, **Replace what I wrote** or **Cancel**, which leaves the note
  as it was. The banner's **Undo: take the draft out** puts every section back. The six-dimension assessment follows the
  same rule for each dimension's notes.
- **Street outreach is logged where it happens (M1).** *Where* starts at Street (or the field, or the first place that
  is not the office), not the program's office default, and is asked right after *Contact*, before the supplies. The
  place is remembered as soon as it is chosen, not only after the first save.
- **Nothing covers the counters on a phone (M2).** The floating **+ Log** button is not shown on Street outreach (the
  screen is the logger), and **Start a new shift** is a 48 px target.
- **The AI copilot is out of sight while it is off (M3).** With no agreement recorded, the copilot switched off, or no
  provider configured, no panel is shown on the note, assessment or CalOMS forms and there is no **Suggest with AI** on
  the care plan; the administrator's Settings › AI copilot says staff see nothing of it until it is on. A monthly
  limit reached still says so in the panel; a cap of 0 reads *The AI copilot is paused for this program*.
- **Care plan suggestions are the clinician's before they are added (M4).** Each problem, goal and step is in a box to
  edit. **Add** waits, and says why beside it, while the text still holds *[needs clinician input…]*; a goal is added to
  a problem (the suggestion's own once it is added, or one already on the list: **The goal addresses**), and a step to
  its goal. The banner reads *AI suggestions — review before adding*.
- **No Secure link on a declined or closed referral (M5).** A referral the client or the provider declined, or one that
  is closed, has no **Secure link** button.
- **CalOMS provider IDs as rows (M6).** State reporting › Settings has a row of fields per provider — Provider ID, site
  or program name, legal name, NPI — with **+ Add a provider** and **Remove this provider**, in place of one line of
  "ID, name | legal name | NPI". A problem names the provider and what was typed (*Provider 2: 1234567890 is not a
  valid NPI (its check digit does not match)*), on that row, with the focus on the field; never *providers.0.npi*.
- **Focus follows the draft (M7).** **Draft** is no longer disabled while it works (which dropped the focus to the
  page); the focus moves to the draft's banner once the draft is in, on the note, the assessment, the care plan
  suggestions and the CalOMS suggestions.
- **Lows.** One review step for an AI-assisted note: the banner's **I have reviewed the draft** button (which did
  nothing) is gone; the statement ticked when signing is the review, and its message starts with a capital (L1). The
  Notes list and a client's Notes tab mark each **AI-assisted** note (L2). A put-back blocked by a later change names
  the field whether or not the History was opened before that change (*Phone has been changed again since, so it
  cannot be put back… City can still be put back on its own*), and offers **Put back that field** for the others (L3).
  The help under *What kind of program is this?* follows the choice before saving (L4). CalOMS says *1 client*, *12
  fatal errors*, *2 files* (not "(s)"), gives the problems' dates as the page does (*May 2, 2026*), shows an upload's
  log entry as *Uploaded on Sep 29, 2026 · DHCS reference BATCH-42*, and the produce dialog says how many records with
  fatal errors are held back and left out of the file (L5). The referral recipient page shows dates without seconds
  and the urgency in words (*Routine*); a code that is not six digits is caught in the browser, never sent, and the
  server refuses one without using up a try; the field takes 7 characters, not 12 (L6). The outreach toast and My shift
  say *2 Naloxone kits*, *1 Naloxone kit*, and the stat is *Fentanyl test strips*; the participant code's help says
  spaces and dashes are dropped (L7). Settlement outcomes' Counts choice fits a phone (*Hide small counts (as
  reported)*, *Exact counts (not for sharing)*) (L8). US spelling on the 1.17.0 screens: the AI settings and their
  messages say *program* and *organization*, Settlement outcomes *Uncategorized* (L9). The AI cap's help says *resets
  on the 1st of each month*, without "UTC" (L10). Saving a new assessment says *Assessment saved* (L11).
- **Browser checks:** r10-outreach, r10-ai, r10-part2, r10-hist, r10-lp and r10-prev check every page and dialog they
  open for stray "null" text, and each fix above; caloms fills the provider rows.
- **Not in this release:** the Settlement outcomes page's by-month cards and the message when the only fund is
  uncategorized (L8), "Check and prepare" on a part month (L5), and a divider line between the clinician's text and a
  draft added below it.

## 1.16.4 — 2026-09-29

### Security

Fixes from the security review of 1.16.3 (r9), and two findings of its UX review that are access rules. No migration,
no new permission, no new route.

- **A flagged SUD counseling note leaves a shared device (N1).** When the office tells a device to remove a note that
  became a SUD counseling note after the device pulled it, the device kept it whenever another account signed in
  there "may read it", judged against the device's own pre-flag copy, which every navigator may read: on a device two
  navigators share it stayed, unflagged, for good. The office now sends what makes the note unreadable
  (`counseling_note`, `author_id`, `cosigned_by`) with the instruction; the device marks its copy first and judges
  the other accounts against that. A device only navigators use removes it; one a clinician, the author or the
  co-signer also signs in to keeps it, hidden from everyone else there. Another account's permissions on the device
  are those the device last received for it: its role and active state as of anyone's last sync, its own grants and
  denies as of its own last sync there (so a counseling permission taken away at the office counts on that device
  once that person syncs again there, or their account is deactivated).
- **Standing on a case cannot be regained by sync (N2).** A worker without `assignments:manage` could push their own
  primary assignment on any client they had ever created, at any time: a worker a supervisor had taken off the case
  put themselves back on it (and, held to their caseload, regained the record), then discharged the client. The
  exception is now only for a client the same push creates (offline intake). A push's re-admission restored every
  assignment its discharge had ended even when the re-admission itself was refused or only flagged: the care team a
  discharge ends or a re-admission restores is now judged by the episode change that landed (those assignment rows
  wait for it), a re-admission while another episode is open is refused, as `POST /api/episodes/:id/reopen` refuses
  it, and a re-admission that leaves nobody on the team gives the worker who made it the case, as that route does.
  Every assignment a push creates, ends or restores is audited (`assignment.create`, `.end`, `.restore`,
  `via: sync`), and restoring an ended assignment needs the same reach as adding one.
- **Another worker's to-dos are closed by push only by a discharge (N3).** Any worker's device could mark any other
  worker's to-do done or cancelled (REST refused it): now only as part of a discharge of that to-do's client that
  landed in the same push, by the client's care team or a manager; a to-do with no client, never.
- **One open episode, counting only closes that land (N4).** A push that "closed" the open episode (refused) and
  opened a second one (accepted, because the close was counted) left two open, the second from someone off the
  team. Closes are applied first and only those that landed count. A new episode pushed already closed with past
  dates (an admission and discharge reports would count) is the care team's or a manager's.
- **The 1.16.1 notice rule is gone (N5).** A to-do reading "Reference: client record change by <user id>", followed by
  an edit of the client by that user within a minute (or, by push, backdated to one), was taken for a 1.16.1 change
  notice, a card naming whoever its title named. Without a migration to link the 1.16.1 notices to their audit
  entries, such a to-do is now an ordinary to-do (its assignee and its creator may change it). A notice's card names
  who made the change from the audit entry that raised it (`notice_by`), never from its title.
- **A paged pull names a flagged note on the page that carries it (N6).** Only a note flagged after the page's own
  start was named, so one flagged early in a pull of several pages and edited later stayed on the device. The pull
  cursor now carries where the pull started (`~from.`), until the pull completes.
- **Change notices (UX review of 1.16.3, M1 and M2).** Only the worker a notice was sent to marks it seen, at both
  doors; a supervisor may delete one (for a worker who has left) but no longer mark it seen for them. A notice pulled
  to a device is a notice there too: each pull names the notices among its to-dos, with whose edit each reports
  (`notices`), and the device takes the office's word for those rows only (never a to-do's text).
- **Smaller fixes (N7).** A flag found by the note's id whatever client its audit entry names. A device to-do that
  merely contains the notice line is stored as an ordinary to-do instead of being dropped without a word (only a
  device's own copy of a notice, which the office raises itself, is not taken). A new note's creation time from a
  device is never after the office's now (a future one hid the note from a later flag's removal). A desktop or
  lock-screen notification of a change notice names the client by code, never by name. The two-step enrolment link
  falls back to "SUDS" as its issuer when a programme name in a non-Latin script cannot be shortened to fit the QR
  code.

### Engineering

Fixes to the release process from the engineering review of 1.16.3. No migration, no new permission, no new route.

- **A GitHub Release someone else made for the owner's tag is refused (H1).** Anyone with write access can create
  a GitHub Release for an existing tag (no ruleset covers Releases), and until now the release job, finding a zip
  and checksum already attached, replaced nothing and went green, so a collaborator's zip could have been the
  release, for good once releases are immutable. `scripts/release-existing.js` (main's copy) now checks any Release
  that exists for the tag in the gate, before the owner is asked to approve, again in the release job, and once
  more after publishing: it must be made by `github-actions[bot]`, carry only the zip and its checksum, and each file
  it carries must be byte for byte the one built from the tag (`git archive` is reproducible). A draft the workflow
  itself left behind is published once checked (L1); any other is refused. A refusal says how to recover: delete
  that Release, keeping the tag, and run the release again, or release the next patch if it is immutable.
- **npm runs where there is nothing to steal (M5).** `release.yml` is three jobs: the gate; `verify`, which runs
  `npm ci`, the tests and the kernel drift check with a read-only token and no environment; and `release`, after
  the owner's approval, the only job with a write token, which runs no npm and none of the released commit's code.
  It builds the zip with `git archive` itself, and the policy exception's paragraph for the notes now comes from the
  gate. `ci.yml` runs with a read-only token (L4).
- **The published web app is checked against the tag (M2).** `web-app.yml`'s build job packs and uploads the site
  straight after building it, before Playwright and its apt packages run, fails if the kernel it rebuilt differs
  from the committed one, and runs its boot test on a copy unpacked from the archive. The publish job checks the site
  byte for byte against what the tag's own `public/` builds to (`scripts/release-site-check.js`, which loads no npm
  package: `build-static-site.js`'s page, service-worker and boot-script steps are now `stageShell()`, which it
  reuses); only the provider pictures, which only a download can make, are allowed besides, as JPEG, PNG or WebP
  files and a manifest.
- **The deploy key has a new name (M1).** It is `PAGES_PUBLISH_KEY`: the `v1.16.2` copy of `web-app.yml` read
  `PAGES_DEPLOY_KEY` in a job that also runs npm and Playwright, so approving a run on that tag would have handed
  it over. Each tag's web-app runs now queue on their own, so a run on another tag can no longer displace the real
  publish waiting for approval. The key file is removed however the step ends (L3).
- **Owner settings and hand-over (M4, L2).** docs/RELEASE.md: *Prevent self-review* stays off while the owner is the
  only reviewer (it made every release impossible to approve), with the trade-off explained; step 6 uses the new
  secret name and checks `v1.16.2` as well as `v1.16.0`; step 5's check includes the release's author; *Owner control*
  says what write access can still do. *Handing a release to the owner* gives the exact commands, tagging an
  explicit SHA after checking its CI, and says plainly that the maintaining assistant cannot push tags, so security
  releases wait for the owner until a backup releaser is named. A CHANGELOG date is the stamp's date; the release
  date is the tag's. HANDOFF.md has a *Release waiting* note: 1.16.3 at `fc5e9d7` awaits the owner's tag.

- **Quarters are measured (`test/thorough/refusal-quarters.test.js`, CI's `thorough-sdc` job).** 18 programmes
  seeded as the benchmark's is (1,100 to 2,600 clients, three seeds each); each fiscal year and each quarter is read
  as a publication release reads it, every table for that period, and audited. Every refusal is checked to be whole
  (nothing printed) with its own period's message; published releases withhold only by the check. The counts are
  recorded, not pinned. About 4 minutes.
- **The fiscal-year sweep (`test/thorough/refusal-band.test.js`) adds the 1.16.3 review's runs** (events and
  reversals moved independently by up to 3 or 4; 114 years, 34 refused), accepts a refusal for a failed check as
  well as for budget, still requires every refusal to be whole, and no longer fails when refusals leave a band.

### Documentation

- **A refused quarter no longer sends the person back to the year (market review of 1.16.3, finding 1).** A refused
  year's message offered its quarters, and a refused quarter's said "publish a longer standard period (a year)":
  year, quarters, year. Each now has its own step. A year's says its quarters *may be tried*, each checked on its
  own and possibly refused too, never beside the year. A quarter's says its year may be tried once it has ended,
  unless the year was refused too or another quarter of it is already published; otherwise the quarter cannot be
  published in this version. Both now say whom to tell: whoever supports the programme's SUDS (IT partner or
  county), or, for a programme with no one, the SUDS issue tracker (the period and the message only, never a
  client's details). The funder submission is unaffected, as before. The `protectFigures` docstring names all four
  ways a release is refused (headline, budget, backstop, and a release that fails its check with tables withheld).
- **No refusal band is quoted any more (engineering review of 1.16.3, M3).** 1.16.2 and 1.16.3 said a fiscal year
  with about 110 to 240 overdose events can be refused, and everything outside publishes. With each month's events
  and reversals moved independently, the review found refusals at 87 to 99 events (budget) and 301 to 341 (a
  failed check). PERFORMANCE.md, ADR-0009, HIPAA.md, the user guide and the buyer pack now say refusals were seen
  from under 100 to over 300 events in sampled programmes, that no size is guaranteed to publish, and that a
  refusal is always whole and safe.
- **"Quarters can be published instead" is replaced by what was measured.** Of 18 seeded programmes, 6 years and 28
  of 72 quarters were refused, and every refused year had at least one quarter refused too (PERFORMANCE.md, *Which
  programmes are refused*). BUYER-GUIDE-PROGRAM, BUYER-GUIDE-IT, the market scorecard and security questionnaire
  #16 now say quarters may be tried and are no sure way round. BUYER-GUIDE-PROGRAM also says a programme's own
  overdose events decide it, not its client count: a syringe services programme with many overdoses can be
  refused with far fewer clients.
- Questionnaire #37 points at the owner's CodeQL setting (RELEASE.md, step 8), not yet turned on. A CodeQL
  workflow was not added: uploading results needs a write-scoped token, and the owner's default setup needs no
  workflow at all.
- EVALUATION-RESPONSE's status line says "through 1.16.3" and no longer points at an *Unreleased* section.

### Frontline

Fixes from the frontline-UX review of 1.16.3. No migration, no new permission, no new route.

- **Only the person told marks a change notice seen (M2).** The notice card offers **Mark as seen** only to the primary
  worker it was sent to. Anyone else who opens it (a supervisor, the editor) sees *A change to a client's record*,
  **Sent to** *David Chen* and *Not seen yet by David Chen*, and no button; "your client" is said only to the one told. In
  the to-do list, a notice sent to someone else has no box to tick it off with. (The server enforces the same rule:
  see Security.)
- **The 2-step bar goes as soon as 2-step verification is on (M3).** It, and the header's **🔐 2-step** link, stayed until
  a reload, still saying access would end. My profile, the set-up dialog and the sign-in step now say *2-step
  verification*: **Set up 2-step verification**, **Turn on 2-step**, *2-step verification is on*, **Turn off 2-step**
  (the API names are unchanged).
- **Discharging from off the care team says what it does (M4).** Before submit, someone not on the client's care team is
  told that closing the episode ends only their own part and that the client stays open with the care team, by name.
  Afterwards a one-button dialog, *Episode closed — client stays open*, says who is still on the care team; the toast
  says *Episode closed*, and no discharge toast lists "0 assignment(s) ended, 0 to-do(s) closed" any more (only the
  counts that are not zero). The loose-ends dialog after an ordinary discharge has one button too.
- **Lows.** The timeline names a notice's editor once (L1). *· N changes to review* on the Open to-dos tile is shown only
  to the primary worker (L2). Cancelling the signature after **Save & sign** says the note is saved as a draft (L3). A
  table wider than its card says so above it, in words (every table in the frame, not only Reports), and the Outcome
  measures headings are shorter (L4). On a phone, Notes' **Import** is under **More** and the counseling-notes line is
  one line, so the first note is higher (L5). *Your first day* is not shown to someone who logged a visit or wrote a note
  before today (L6). Finance's Supervision page describes staff time, not countersignatures (L7).
- **Browser checks:** `scripts/ui/r9.mjs` (in the suite, now 44 scripts); r8, ux13 and signup follow the new wording.
- **Not in this release:** telling the primary worker when someone off the care team closes the client's only open
  episode, or reactivates a closed client by starting one (M4's last point, L8).

## 1.16.3 — 2026-09-29

### Engineering

Fixes from the engineering review of 1.16.2. No migration, no new permission, no new route.

- **One way to release, and the owner's settings fit it (M1).** 1.16.0 to 1.16.2 were released by *Run workflow* on
  a `release/v*` branch, and the workflow created the tag itself with the workflow token. The settings guide in
  docs/RELEASE.md then limited the `release` environment to `main` and `v*` tags, and let only the owner create
  `v*` tags: applied as written, the next release would have stopped after its approval. Now a release is always
  a `v*` tag the owner pushes at the version-stamp commit on `main` once its CI is green; the release workflow
  refuses a run on anything but a `v*` tag (its gate's first step), never creates a tag (`gh release create
  --verify-tag`), and checks the tag against `package.json` on every run. *Run workflow* only re-runs an existing
  tag (a retry, or with `policy_exception`). The guide limits the environment to `v*` tags only, no `release/v*`
  branch is made any more (a tag serves the same zip; *Release tags*), and *Cutting a release* says so.
- **The gh-pages deploy key is read only by a job that runs no third-party code (M2).** `web-app.yml` is two jobs:
  `build` (no environment, no secret, a read-only token) runs `npm ci`, Playwright and its apt packages and builds
  and checks the site; `publish` (the `release` environment) checks out nothing and installs nothing, takes the
  site as an artifact (GitHub's own `actions/upload-artifact` and `actions/download-artifact`, pinned to a commit:
  the only actions any workflow uses), checks its checksum and that it holds only files and directories (no link,
  no `.git`, no parent or absolute path), commits it with git's global and system configuration and hooks off, and
  pushes it with `PAGES_DEPLOY_KEY`. The run summary names the credential that pushed (the key, with its
  fingerprint, or the workflow token), and without the key a guarded `gh-pages` fails with a message saying what
  to add, not an opaque `GH013`. The guide now does the `main` and `v*` rulesets before the key (a write deploy key
  can push every ref no ruleset guards), and says the rulesets' *Deploy keys* bypass admits every write deploy key,
  so this must be the only one.
- **Immutable releases (M3).** A new settings step turns on GitHub's release immutability, which stops anyone
  replacing a published zip or checksum: every tag from v1.1.0 to v1.15.4 carries a `release.yml` whose *Run
  workflow* rebuilt the zip and uploaded it over the published one (`--clobber`), with no approval, and a
  collaborator could edit a release's files by hand. It applies to releases published after it is on; the guide
  says how to record the older releases' checksums.
- **The fiscal-year refusal band, corrected and tested (M4).** 1.16.2 said a year was refused with 126 to 237
  overdose events and published with 125 or fewer; the reviewer's runs refused 125, 123 and 113. It is **about 110
  to 240** (sampled; not a guarantee). `test/thorough/refusal-band.test.js` (CI's `thorough-sdc`) runs 84 scaled
  programmes: 23 refused, with 113 to 237 events; it checks that every refusal publishes nothing and every
  published release withheld only by its check, and fails when the band leaves 100 to 260. **Correction to the
  1.16.2 notes** (Engineering, H1, "What changes for a programme"): the band there, 126 to 237 events, is 110 to 240,
  and programmes of 110 to 125 events can be refused too. A refused year's message now says what to do (next
  section).
- **A flake in `npm test` (L1).** `test/release-worker-timeout.test.js` timed its first audit from the post, which
  included starting the worker: under load its 400 ms backstop refused it. The worker is now started before
  anything is timed, and the backstops leave room for the workers the queued audits move to.
- **The fixed-wait lint sees `new Promise(r => setTimeout(r, N))` (L2)**, in the script or in the page. The waits it
  found are replaced by `settle()` (ux13's two 1 s waits and ux-forms' 900 ms: a preference's debounced save counts
  as the page's work) or say why they stay (`// intentional:`: device-audit waiting for the next TOTP step and for a
  later timestamp; local-mode's slowed server and its proof that no second render lands); the allowlist entries
  that remain give their reason.
- **The stamp warning is in the run summary (L4)**, where the person approving the `release` environment sees it,
  not only in the log.
- **Docs drift (L8).** The architecture README's release-governance row and `web-app.yml`'s header describe the tag
  check, the stamp warning, the deploy key and the two jobs.
- **Not in this release:** a scheduled check that the owner's settings are in force (L5); recording the withheld
  tables and the refusal reason in a publication release's audit entry; a sound, affordable check for the overdose
  events by month (1.17.0 work). The owner's settings themselves are still the owner's to make: none is in force
  until then.

### Documentation

- **The fiscal-year refusal band is in the buyer pack (market review of 1.16.2, finding 2).** BUYER-GUIDE-PROGRAM,
  BUYER-GUIDE-IT, the market scorecard and its deferred table, and security questionnaire #16 now say that a whole
  publication release can be refused (not a table withheld), for a fiscal year with about 110 to 240 overdose events,
  and what to do: the exact funder submission is unaffected, and the year's quarters, each checked on its own, can
  be published instead.
- **The refusal message for a year says what to do.** It suggested only telling "whoever supports your SUDS server";
  it now offers the year's four quarters, each once its figures are complete and each checked on its own, warns not
  to publish the year beside them, and keeps the support step for a quarter that is refused too.
- **Finding a 1.16.1 release made under the withdrawn rule (HIPAA.md).** Neither the audit log nor the exported files
  say which tables a release withheld; the page did. HIPAA.md now says how to find one: list the publication releases
  made while 1.16.1 was installed from the audit log, and check each period's exact figures against the rule's
  condition (at least 12*T* overdose events and a month of 1 to *T*−1 events or not reversed); and what to do.
- **A recovery drill on the released 1.16.2** (`docs/evidence/dr-drill-2026-09-29.md`): the development exercise at
  20,000 clients, from the release's own files, passed 11/11 checks (drill RTO 3.8 s, host restore 4 s, RPO 7 s,
  schema 48); still a development exercise, not a production drill.
- EVALUATION-RESPONSE's status line reads "through 1.16.2"; the user guide's heading is "When someone not on the
  care team changes your client's record".

### Frontline

- **Two-step verification can be set up whatever the programme is called.** The enrolment link carries the
  programme's name twice; past about 40 characters it no longer fit the QR code and setup failed ("Data too long for
  QR generator"). The name in the link is now shortened from the end until it fits (`server/crypto.js`).

Fixes from the frontline-UX review of 1.16.2 (round 8). No migration, no new permission, no new route.

- **A change notice reads as what happened, wherever it shows (M1).** In a client's Recent activity it read as a
  to-do by the primary worker, with the text written to them ("You are this client's primary worker…") and its
  reference line, shown to everyone who opened the record. It now reads *"Maria Rivera (not on the care team)
  changed: Phone, Risk level — David Chen was told"*, attributed to the editor (whom the `client.change_notice`
  audit entry names), dated by the change, and opens the notice card. The timeline marks it `notice: true`. The
  Overview's **Open to-dos** tile leaves notices out ("· 1 change to review"), and warns only when a real to-do is
  overdue (`counts.overdue_tasks`).
- **The bell keeps notices apart (M2).** They are listed first under *Changes to your clients*, marked **New**
  (not "today"), and are not in the due count on the badge, which says "new" when a notice is all there is; the
  button's name says both ("9 to-dos due or overdue, 1 change to your clients"). A notice's title names the client
  as the lists do (the name where the reader may see names, else the code), and the card shows the name once
  with the code. On a device the bell asks again right after a sync instead of after its minute's cache.
- **+ Log on a client's record carries the client (M3).** Note, Log a visit, Call, Text, To-do, Make a referral,
  Time and Overdose from the floating + Log (and the top bar's) start with the client whose record is open, as the
  record's own buttons and the `n` shortcut already did; on a phone a note no longer failed "Client is required".
- **The notice card's When is the change (L2),** not the moment it was marked seen.
- **Notes name the client and say they open (L3),** as Visits, Calls and To-dos do (`client_name` on
  `GET /api/notes`, by code alone under break-glass), with an **Open** button on each row.
- **Notes and Referrals are two-line rows on a phone (L4),** as Visits are; a referral's buttons sit under its
  row.
- **Filters fold away on a phone (L5).** Visits, Notes, Referrals and Calls put their filters behind a
  **Filters** button (saying how many are on), so the first rows are on the first screen.
- **The floating + Log no longer sits on the first rows (L6).** With the filters folded, the first rows are above
  it; the page already had room below the last row to scroll it clear (now checked in the browser suite).
- **SOAP, DAP, BIRP, GIRP and safety plans ask for the text once (L7).** The Narrative box, built from the
  sections, folds away under them as *Narrative text (built from the sections)* and is not required; a draft whose
  narrative is still the built one keeps being built from its sections.
- **A clinician's new note starts as Clinical (L8)** (anyone who may write clinical notes).
- **Finance and Read-only are not told that what they add shows up elsewhere (L9).**
- **The development seed's programme is named for its profile (L1):** "County Treatment and Outreach Program"
  beside the treatment profile, not the harm-reduction default name. Behaviour is unchanged.

### Security

Fixes from the security review of 1.16.2. No migration, no new permission, no new route.

- **Opening an episode is not a way to take a client off their care team (M1).** A navigator off the care team
  could open an episode of their own on another worker's client (a second one, by sync, was only flagged), close
  it, and with it end the primary worker's assignment, or over REST discharge the client, cancel every open to-do
  including the change notice, and tell nobody. The opener of an episode may still close it, but ending the rest
  of the care team, cancelling their to-dos and discharging the client are for the care team (an active
  assignment) or `records:manage-others`; the opener's discharge ends only their own assignment and to-dos, and a
  client someone else is still working with stays open (the answer says so). A device's push ends an assignment
  only with a real discharge of an episode the office holds open (one it pushes new, even already closed,
  discharges nobody), and another worker's only for the care team or a manager; a second open episode from
  someone off the care team is refused, as over REST. No discharge, by anyone, cancels a change notice: it is
  the primary worker's to read.
- **A shared device keeps what another account on it may read, and every unsynced edit (M2).** When the office named
  a counseling note in `dropped_rows`, the next account to sync on a shared device deleted it, with a clinician's
  unsynced edit to it; and the office named every counseling note changed since the last pull, not only those that
  had become unreadable. Now the office names only a note flagged as a counseling note since that device's last pull
  and written before it (which also stops it naming counseling notes the device was never sent: L4); a device keeps
  a named row while another account signed in on it may read it, never deletes one with changes not yet sent (it
  says so), and a sync sends only the notes the syncing account may read, leaving a clinician's to them rather than
  having them refused for good under a navigator's account.
- **A signature's time is bounded (L1), and a draft carries no signature (L2).** A note signed by sync keeps the
  device's signing time, but never before the note was written nor after the office's now; a draft pushed with
  `signed_by`, `signed_at` or `signature_hash` stores none of them.
- **A change notice is known by how it was raised, not by its text (L3).** Anyone could write a to-do with the
  notice's wording and have it shown, to the worker it was assigned to, as a system notice naming someone else as
  the editor. A to-do is a notice only when the `client.change_notice` audit entry of the edit it reports names it
  and the worker it told (a notice raised by 1.16.1: the entry of its editor's edit, telling that worker about that
  client as it was written). The web app trusts only the API's `notice: true`, no longer the text. A device's own
  copy of a notice is not taken by the office, which raises its own when the edit arrives; on a device, a notice
  pulled from the office reads as an ordinary to-do.

## 1.16.2 — 2026-09-29

### Security

Fixes from the security review of 1.16.1. No migration, no new permission, no new route.

- **Nobody signs a note in someone else's name by sync (H1).** A push from a supervisor or administrator
  (`records:manage-others`) could create a note already signed in a clinician's name, or take a clinician's draft,
  rewrite it and push it back signed by them; the only trace was a `sync.overwrite`. A note's author is now the
  account that syncs it, as over REST (`records:manage-others` does not let anyone author as someone else), a
  signature arriving by sync is refused unless that account wrote the note and is signing it themselves, and the
  office works the signature hash out itself (a device's value is ignored) and audits it as `note.sign` (`via:
  sync`). Countersignatures were already never taken from a device; addenda keep their syncing author.
- **Separation of duties sees what a visit or call does (M1).** An approver could record a costed visit, or a visit
  or call that logs time, in another worker's name, add a cost to a colleague's visit, resize a colleague's
  submitted time by editing the visit, or submit a colleague's time for them, and then approve the expenditure or
  time that resulted. The expenditure and time entry a visit or call records or changes are now audited as the
  caller's (`expenditure.create`/`.update`, `time_entry.create`/`.update`), and submitting someone else's time
  counts as changing it, so the approval routes refuse them as they refuse an entry one recorded directly. The
  same writes from a device were already counted (`sync.record`, `sync.overwrite`).
- **The change notice cannot be silenced by the editor it reports on (M2).** The to-do that tells a client's
  primary worker that someone off the care team changed the record was recorded as the editor's, so the editor
  could close, retitle or delete it before it was seen. It is now the primary worker's own, and a change notice,
  including one raised by 1.16.1, is changed, closed or deleted only by its assignee or `records:manage-others`,
  over REST and by sync alike (a care-team member's discharge still closes it). Its text no longer carries a user
  id (a fixed reference line marks it; which editor it reports on is read from the `client.change_notice` audit
  entry, which now names the to-do), names the fields by the client form's labels ("ASAM level of care"), still
  never their values, and it has no due date: it is not overdue work in the bell, the check-in list, the
  supervisor's overdue count or `?overdue=1`. The bell lists open notices first (`notice: true`, and a `notices`
  count); every to-do the API returns says `notice: true` when it is one, and a client's `counts.notices` says how
  many of its open to-dos are notices. A notice raised by 1.16.1 keeps the due date it was given.
- **A note flagged as a SUD counseling note leaves the devices that may no longer read it (M3).** A clinical draft a
  navigator's device had pulled, then flagged as a counseling note, stayed on that device as it was. The next pull
  now names it, and its addenda, in `dropped_rows`; unflagged, it and its addenda come back.
- **A client's note count leaves out counseling notes its reader cannot read.** The Notes tab said 5 where the
  list, rightly, showed 4, which also told a navigator that a counseling note existed; the count now follows the
  list's rule.
- **Lows.** A supply line's worker is its visit's and is no longer a column a device may send (it was already set
  from the visit). The care plan's count of notes per problem leaves out counseling notes its reader cannot read.

### Frontline

Fixes from the frontline-UX review of 1.16.1 (round 7). No migration, no new permission, no new route.

- **A client-change notice is something to read (H2, M2).** The to-do the primary worker gets when someone off the
  care team changes their client's record opened as the full Edit to-do form, with a reference line holding a user
  id. It now opens as a card: who changed which fields (by the client form's labels), when, **View client** and
  **Mark as seen**, and that SUDS keeps which fields changed, not their earlier values. The to-do list shows
  *View change* instead of Edit and Delete, and never shows a notice as overdue. The bell's link opens the same card.
  Notices are recognised by one function (`changeNotice()` in `public/views/tasks.js`), from the task's `notice` flag
  (the text of a notice from an older server as a fallback); **Mark as seen** is offered only to the person it was sent to
  and to supervisors and administrators. The client **Edit** form
  tells someone off the care team that the primary worker will be told which fields they change.
- **Visits on a phone are two-line rows (M3)**, as Calls and To-dos are: who and what, then when, what was handed
  out and by whom. A row opens the visit.
- **Referrals fit a 1280 px window (M4).** Urgency, the appointment and the barrier sit under the status; the
  action buttons no longer end past the right-hand edge.
- **An anonymous visit says "Anonymous" (M5).** A naloxone distribution with no client was drawn as an empty link to
  `#/client/null` (an accessibility failure) and an empty Client row on a phone. The accessibility audit now logs one
  before it checks Visits.
- **A colleague's referral says what you can do (M6):** *"You can record the outcome; only David Chen or a supervisor
  can change the referral"*, not "view only" beside a working **Record outcome** button.
- **Smaller fixes.** The role select lists roles by name, and the chosen role's whole summary shows under it (it was
  cut off in the closed select); *My hours logged* is under *Your own work*, not among the program's tiles; Visits
  name the client (name and code, where the person may see names) as Calls and To-dos do; a new visit, when this
  browser has none remembered, starts at the programme's default location (the street for a harm-reduction
  programme), as before; a row whose Worker column names its owner says only *View only*; a supervisor editing a colleague's
  overdose event is told whose it is; no permission is labelled "(all)" (*Care plans (read, add, change own)*, and
  what the others allow); the Home welcome tips leave out what the person cannot do (Finance and Read-only log
  nothing and open no client record); New to-do does not offer Finance or Read-only accounts as assignees; the
  two-step verification reminder is one short line on a phone, still saying by when.

### Documentation

- The user guide no longer says navigators read SUD counseling notes (they have not since 1.16.1); the README's
  role table says the same. The client record keeps which fields were changed, not their earlier values: said in the
  user guide, POSITIONING, both buyer guides and the security questionnaire (#22), with revision history planned.
- A change notice is sent when the editor is not on the client's care team (POSITIONING and the buyer guides said
  "someone else").
- INSTALL's *Working offline* agrees with the wizard and Step 4: recommended for harm-reduction outreach, not for a
  treatment-adjacent programme without a field-work need.
- "Prevention" is qualified in the README and the RFI solution summary (prevention-funded outreach; SABG
  primary-prevention reporting is not supported), the README no longer speaks of a supply cupboard, and "built to
  the 42 CFR Part 2 standard" now reads "built to support 42 CFR Part 2".
- The pen-test scope lists the classes fixed in 1.16.1 and 1.16.2 for a tester to confirm: stored-file serving, sync
  attribution and column smuggling, separation of duties, SUD counseling-note access, note signatures via sync and
  client-change notices.
- The browser suite is 42 scripts (`scripts/ui/r7.mjs`).

### Engineering

Fixes from the engineering and release-process review of 1.16.1. No migration, no new permission, no new route.

- **1.16.1's published withholding rule is withdrawn: it leaked (H1).** 1.16.1 withheld the overdose events by
  month from the start, in a period of at least 12T overdose events with a month of 1 to T-1 events or not
  reversed, and its check counted every world that printed the same through the suppression and for which the rule
  decided the same, including worlds whose own release was refused. The project's own algorithm-aware attacker,
  run by the reviewer at the rule's gate (T = 3, two months, 36 events, every split: 9,139 worlds), found 6
  printouts that told it a month's events not reversed were not 1. Validating each such world by its own release,
  as the degrade step does, cost more than the budget wherever the rule fired (the benchmark's 2,000-client year:
  55 worlds at about 72 million units each), and one level of it still leaked in the suite's smallest two-month
  family with the gate lowered. So there is no published rule: `server/sdc.js` `protect` is 1.16.0's again, and
  the same attacker finds 0 leaks in all 4,883 printouts of the reviewer's family that print the 36 events
  (`test/publication-release.test.js`; the part with 0 to 2 and 32 reversals in the thorough run).
  **What changes for a programme:** a year like the benchmark's 2,000-client one is refused whole again, as in
  1.16.0 (refusal publishes nothing, so it is safe; the submission to the funder is unaffected). On scaled copies
  of that year at T = 11, 17 of 60 were refused, all with 126 to 237 overdose events in the year; more budget does
  not help, so there is no degrade-round budget floor (M1; docs/PERFORMANCE.md, *Which programmes are refused*).
  **A 1.16.1 publication release whose overdose events by month were withheld by that rule is unverified**
  (docs/HIPAA.md). ADR-0009, PERFORMANCE.md and HIPAA.md say what is actually guaranteed.
- **Release gate (M2, M3, L7).** The notes step runs the policy script from the same `main` commit the gate ran
  (a job output), not `main`'s tip at publish time; a pushed tag that is not `v<package.json version>` is refused by
  the gate, before the approval; the gate warns when the released commit is not the version-stamp commit.
  docs/RELEASE.md now says exactly what running `main`'s copy of the gate guarantees and what it does not (the
  workflow file at the released ref decides, the policy runs the released tree's server code, a loosening merged
  to `main` governs its own release), that there is no backport path yet (with a proposal), and that the released
  commit must be the version-stamp commit.
- **Pages publishing and repository settings (H2).** Refs made before 1.16.1 carry a `web-app.yml` that publishes
  to the public URL with no approval. `web-app.yml` now pushes `gh-pages` with a deploy key held as a secret of the
  `release` environment when there is one, and docs/RELEASE.md, *Owner: repository settings*, gives the owner the
  exact steps: the `release` environment's reviewer and refs, branch protection on `main`, a `v*` tag ruleset, a
  read-only default token, a `gh-pages` ruleset that admits only that key, stale branches, and CodeQL (optional).
  None of it is in force until the owner makes those settings.
- **Tests (L1, L2, L4).** The device-recovery test counts only the backoff's own timers; the browser suite's
  `r5` script waits for the draft to be kept instead of 700 ms, and `test/ui-fixed-waits.test.js` fails on a new
  fixed wait of 300 ms or more that does not say why; the `READ_SCOPE_PERMS` test records the permissions a real
  sync pull asks about instead of reading `sync.js` with a regular expression.
- **Release record (L5).** docs/RELEASE.md records the behaviour changes the owner decided inside 1.16.1 (the
  to-do for a client changed off the care team, the counseling-note restriction) as owner decisions within a patch.

## 1.16.1 — 2026-09-29

### Security

Fixes from the security review of 1.16.0. No migration, no new permission, no new route. With 1.16.0 most staff
see every client, so "who may change this row" can no longer be left to the caseload; these say it.

- **Stored files are never pages of this origin (H1).** A device could push a resource photo with the type
  `text/html` or `text/javascript`, upload a page or a script as its bytes, and have it served as this origin's
  (stored XSS, with a link from the resource's website field). A resource photo's type is now read from its bytes,
  and anything that is not a picture is an opaque download; every stored file (photos and thumbnails, form
  attachments, policy documents, the form library) is served with `nosniff`, a `Content-Disposition`,
  `Cross-Origin-Resource-Policy: same-origin` and `Content-Security-Policy: sandbox; default-src 'none'` (a PDF
  keeps the app's policy: browsers do not show one in a sandbox); sync refuses a photo whose type is not a picture
  or an attachment whose type the form library does not take, and the blob upload checks a photo's bytes.
- **A device writes only the columns a table's rules declare (H2).** Sync push stored every column a device
  sent, so it could make another worker's goal its own and then delete it, or name someone else as the person who
  made a disclosure (the §2.25 / §164.528 accounting). Anything a table's rules do not declare is now the office's,
  and who created a record (`created_by`, `disclosed_by`, `given_by`, `recorded_by`, `opened_by`, `uploaded_by`...)
  is the account that syncs it, kept as the office has it afterwards; a device that names someone else is told.
  This replaces 1.14.0's "a creator column arrives as the device recorded it" (docs/architecture/README.md).
- **Attachments follow their form (M1, M2).** The blob upload route replaced any attachment, including the signed
  copy on another worker's completed form. A device now fills in only the file of a row it created, while empty;
  replacing a file is its creator's or `records:manage-others`', never on a completed form. Nothing is removed from
  a completed form but by a supervisor (the signed copy is still attached after completing it), and voiding or removing a form, or removing an attachment, is
  the person's who started the form or added the file, or `records:manage-others'`, by REST as by sync.
- **Supply lines are their visit's (M3).** A device could add or remove the supplies on another worker's visit
  (changing its kit counts and the stock); a line now follows the visit's own edit rule.
- **Import items (M4).** Committing a staged import item is its importer's or `records:manage-others'`, as
  viewing, discarding and purging it already were.
- **SUPRT-A and CalOMS deletes (M5).** Deleting an assessment or a CalOMS record is its recorder's or
  `records:manage-others'`; a CalOMS record already sent to DHCS is corrected, never deleted, by anyone (it used to
  be deleted with a warning). Re-admitting a discharge made in error still takes its discharge record with it.
- **Episodes (M6).** A device changes an episode only as the REST routes do (open, discharge, re-admit); when,
  how and why a client was admitted is kept as the office has it, and `closed_by` is the account that discharged.
  Discharging or re-admitting, which ends the whole care team and cancels its to-dos, is for the client's care
  team, the person who opened the episode, or `records:manage-others` — at both doors, and for the care team a
  device's discharge ends.
- **Separation of duties (M7).** An approver could record spending or time under a colleague's name, or raise a
  colleague's pending amount, and then approve it. Approving is now refused to anyone who recorded or changed the
  entry, read from the audit trail (without a migration there is no creator column on these rows); a device's
  entry recorded for someone else is audited for it (`sync.record`). Returning an entry is unchanged.
- **SUD counseling notes are restricted by design** (the owner's decision). A counseling note (42 CFR §2.11) is
  read only by its author, its co-signer and staff who write clinical notes (`notes:clinical:write`); a navigator's
  `notes:clinical:read` reads every other clinical note, never a counseling note, and break-glass does not open one.
  Enforced on the note, note lists, the client timeline, the supervision queue and sync: a navigator's device is not
  sent one or its addenda, and a device that received them before is told to remove them at its next sync.
- **Changes to a client's record are told to their primary worker** (the owner's decision). Anyone who can see a
  client may still update the record; when the editor is not on the client's care team, the primary worker gets a
  to-do (the bell) naming who changed which fields, never the values. An edit arriving by sync does the same.
- **Smaller fixes (L1–L5).** A problem-list change arriving by sync is kept in the problem's history; a device
  cannot ask for a review of another worker's signed note; a spreadsheet import needs `imports:write` (as the
  Import page does), checks each record against its table's shape and rules, and audits each record; a goal's or
  step's wording is its author's or `records:manage-others'` to change (they keep no history); a resource photo
  removed by sync is removed, as over REST, instead of being dropped quietly.

### Frontline

Fixes from the frontline review of 1.16.0: the "see every client, change your own work" rule is now explained
wherever it applies. Screens and wording only: no migration, permission or route, and nobody can do more or less
than before.

- **Overdose & reversals.** Another worker's event opens read-only (it opened as a form that could be filled in and
  then refused the save), with *Reported by … Only they or a supervisor or administrator can change it*. On a phone,
  **Delete event** no longer covers **Save**: it now sits on the left of the form's own button row.
- **A colleague's visit or call can be read in full.** A row on Visits (and a client's Visits tab) opens the whole
  visit: summary, supplies, outcome, follow-up and funding. Only 120 characters of the summary showed before, and
  there was nothing to open. A desktop call opens the same way. Edit and Delete are in that dialog for the person
  who recorded it, or a supervisor or administrator.
- **Why Edit is missing.** Where Edit and Delete are hidden, the row says *Recorded by … — view only* (Visits, Calls &
  texts, Referrals), and a to-do says *Assigned to … — view only; you can mark it done*. A colleague's draft note says
  that only its author or a supervisor can finish, sign or delete it. A care-plan goal someone else added says who
  can delete it. On a phone, someone else's to-do opens to read, not as a form. The server's refusal of a change to
  someone else's record now says who can make it and what to do instead.
- **Roles described once.** New user, Edit user, approving an access request, a device's first account and the
  Permissions dialog use the same role summaries: what the role sees, what it records, and whether it changes other
  workers' records (only supervisors and administrators do). They follow the owner's decisions for this release: a
  client record is shared (anyone who sees a client may update it, and the primary worker is notified), and SUD
  counseling notes are read only by their author, the co-signer and staff who write clinical notes. Notes (and a
  client's Notes tab) say so to a navigator, where counseling notes are no longer listed. The device sign-up no longer says a clinician does
  "everything a navigator does": a navigator records spending and a clinician does not. The Permissions dialog no
  longer starts with "Since 1.16.0". Permission names say what they cover: *Visits & services (read, log, change
  own)* rather than *(all)*, and the same for calls, referrals, to-dos and overdose events.
- **Visits fit a 1280 px window.** Where-and-how and the start of the summary sit under the visit type, so the Edit
  column is no longer past the right edge.
- **Home** titles its tiles *The whole program at a glance* (or *Your caseload at a glance* for a person held to
  their caseload), and the check-in list is *Your clients who need a check-in*.
- **Smaller fixes.** The to-do list's two checkbox columns are headed *Done* and *Select* (both were read out as
  "Actions"). Referrals say **Edit**, not **Update**. The Supplies tabs wrap onto rows on a phone instead of
  scrolling past the edge. The client header says whose client it is (for example *David Chen's client (primary worker)*).
- **Setup wizard.** The offline-copy question now says what a copy holds: with the default roles, the whole
  program's records, clinical notes included, unless the person is denied *See every client* before their device
  first syncs.
- Tests: the browser script `scripts/ui/r6.mjs` (48 checks, including WCAG 2.1 AA on each changed dialog); the
  accessibility audit now opens a visit, a call and an overdose event from their rows.

### Documentation

- **The market and security pack now describes the 1.16.0 defaults.** The IT and programme buyer guides, the RFI
  boilerplate, the readiness scorecard, security questionnaire items 22 and 45, SOC 2 readiness CC6.3, the
  security architecture, CalAIM and the README said "caseload scoping" and "clinical notes restricted to clinical
  roles" as if they were the defaults. They now say that navigators and clinicians see every client,
  navigators read clinical notes but not SUD counseling notes, client records are shared with changes reported to
  the primary worker, and least privilege is a per-user deny, not the default.
- **"Who sees which clients?"** is a new objection answer in POSITIONING.md. The pilot kit's week −1 now decides
  per-user denies before any import or device sync.
- **Offline copies, said the same way everywhere.** The IT guide and questionnaire now match the setup wizard and
  INSTALL.md: local mode is off unless the wizard or IT turns it on, the wizard recommends it for outreach, and a
  device then holds the whole program's records under the default roles.
- **"Prevention", precisely.** SUDS supports prevention-funded outreach and distribution, not SABG
  primary-prevention (PPSDS) reporting. This is now stated in the positioning, scope, buyer guide, scorecard (as
  a known gap) and the pilot kit's eligibility check (new Q0). The scorecard also lists "least privilege by
  default" as a gap.
- **Supported versions** (RELEASE.md, VULNERABILITY-MANAGEMENT.md): the latest minor gets every fix; the previous
  minor gets security fixes for 30 days after the next minor; best effort, one maintainer.
- POSITIONING.md no longer calls supplies a "cupboard" (items, sites and lots), nor does the permission catalog.

### Engineering

Fixes from the engineering and release-process review of 1.16.0. No migration, no new permission, no new route.

- **A programme's year can be published again when a few months' overdoses were almost all reversed.** A
  2,000-person programme's fiscal-year publication release was refused whole: three months had 1, 2 and 3
  overdose events not reversed. The disclosure check had to try every candidate for those months, and the step
  that withholds a table instead of refusing ran out of budget re-running that check. Now, in a period with at
  least 12 × the threshold of overdose events, **Overdoses by month** is withheld from the start by a published
  rule whenever a month has 1 to T−1 events, or 1 to T−1 not reversed. The rest is published as before. That year
  now publishes in under a second with only that table withheld. A 20,000-client year is unchanged, and smaller
  periods are checked as before (docs/architecture/ADR-0009, *Withheld by rule*; docs/HIPAA.md).
- **A refused year says what to do.** The refusal told someone who had asked for a fiscal year to "publish a
  longer standard period". For a year it now says a year is the longest standard period and to tell whoever
  supports the server which period was refused; for a quarter it suggests a year. A refusal because the check ran
  out of budget is now logged on the server with the check's work (steps, rounds, tables withheld), as a refusal
  by the time limit was.
- **The web app (SUDS on this device) is published only from a release, with the owner's approval.** A bare `v*`
  tag push or a `release` event published it beside the release workflow rather than after it, so a tag whose
  gate failed, or that nobody approved, still reached the public site. A dispatch on a branch published
  unreleased code. `web-app.yml` now runs only when dispatched on a `v*` tag, and only if that tag's GitHub Release
  exists at the same commit. It runs in the `release` environment.
- **A published release's files are never replaced.** The release workflow refuses a version already tagged at
  another commit. When the GitHub Release exists, it no longer uploads over its zip and checksum (it did, with
  `--clobber`). Before, running the workflow on `main` after a release, without bumping the version, replaced the
  published zip and checksum with ones built from a different commit.
- **The release gate does not trust the commit it judges.** It runs `main`'s copy of `release-gate.js` and
  `release-policy.js` against the released tree, so a commit cannot relax the checks that release it. It refuses a
  commit that is not on `main`, whatever the policy exception. The 28-day feature-release check now fails when the
  previous feature release's date cannot be read (it only warned). Its refusal gives the exact time (after 1.16.0:
  2026-10-27 03:16 UTC).
- **One list of the permissions that widen reading.** `server/permissions.js` `READ_SCOPE_PERMS` and
  `CASELOAD_PERMS` replace hand-kept copies in the sync scope key, the device sign-up's caseload hold and the
  benchmark. A test checks that every permission the sync pull asks about is in the list or comes from a table.
- **The browser kernel builds to the same bytes anywhere.** It now builds through a worktree's symlinked
  `node_modules`, and from any directory. 1.16.0's release commit had to be rebuilt for this.
- **Browser suite:** the unsent-visit checks wait for the draft to be kept, not a fixed 700 ms. The accessibility
  reflow checks wait for the resized layout to settle, not 150 ms, which is the likely cause of an intermittent
  reflow failure.
- **Docs:** RELEASE.md records 1.15.0's policy exception, has a table of every exception, and corrects what it
  said about 1.15.1. The architecture overview no longer says a sync tombstone of shared data needs `clients:all`
  (it needs `records:manage-others`). ADR-0009 no longer claims the degrade step has a budget of its own or that
  no programme's release is refused. PERFORMANCE.md calls the 2,000-client refusal the defect it was. HANDOFF.md
  gives the right end of the feature freeze.

## 1.16.0 — 2026-09-29

### Roles and permissions

A feature release: the owner widened two roles' defaults. Expansion only: nobody loses a permission, and
supervisor, administrator, finance and read-only keep exactly what they could do (finance still never holds
`clients:read` or `export:identified`). One new permission string, `records:manage-others`, splits "manage other
workers' records" off `clients:all`; supervisors and administrators hold it. No migration, no new route; the sync
pull answer gains fields (below).

| Role | Added | Not added |
|---|---|---|
| navigator | `clients:all` (outreach engages whoever walks in, not only their caseload); `notes:clinical:read` | `notes:clinical:write`, `records:manage-others` |
| clinician | `clients:all` (coverage and on-call); `budget:read` (programme spending) | `budget:write`, `records:manage-others` |
| supervisor, administrator | `records:manage-others` (what `clients:all` gave them before; no new power) | |

**Administrators: upgrade note.** After upgrading, every navigator and clinician sees every client in the
program, and navigators can read clinical notes (SUD counseling notes included). To keep the old scoping for a
person, deny *See every client* (`clients:all`) — and, for a navigator, *Read clinical notes*
(`notes:clinical:read`) — under **Settings → Users & permissions → Permissions** (1.15.0), with a reason; do it
before their devices next sync if your program uses local mode (below). With **Caseload restriction** on (Program settings; the default), that person
is then held to their caseload everywhere it applied before: client list and search, a record and its timeline,
the duplicate check at intake, exports, the dashboard and reports, and what their devices sync
(`test/role-expansion.test.js`). Minimum necessary for navigators and clinicians is from now on the programme's
own per-user choice (docs/HIPAA.md).

What follows from `clients:all`, for a navigator or clinician who holds it:

- **Every client**, over REST, search, exports (de-identified, as before), the dashboard and the funder, NDP and
  settlement reports (their first run stays *internal, suppressed*; they may also ask for a publication release
  of the whole programme; still no exact counts), and in sync. A client they create is still assigned to them,
  now from a device as well as over REST, so a later deny leaves it on their caseload.
- **Seeing is not managing: `records:manage-others`** (new permission string, the owner's decision). A navigator
  or clinician sees every client and adds their own work to any record (a visit, a call, a note, a referral, a
  to-do), and sees another worker's records with no client (an anonymous call or outreach contact). They do NOT
  change or delete another worker's visits, calls, referrals, overdose reports, to-dos, care-plan goals and steps,
  assessments, outcome measures, rights requests or draft notes; record work under another worker's name; remove a
  client record; or see another worker's staged imports. Those powers were carried by `clients:all` and are now
  `records:manage-others`, held by supervisors and administrators (who held them through `clients:all` before, so
  nobody loses anything). It is used by `server/crud.js` (`ownerOrManager`, the owner column on insert), every
  `server/rules/*` `owner`/`editableBy`/`deletableBy` (so sync push refuses the same edits, deletions and
  attributions as REST), client removal (`DELETE /api/clients/:id` and the device's equivalent, and the button on
  the client page), a device's deletion of shared reference data, supply lines on another worker's visit with no
  client, the imports list, Home's staged-imports count and which imports a device pulls. The screens show Edit,
  Delete and Update only where the person may use them. In the catalog it is *Manage other workers' records*,
  rated sensitive; a grant through the 1.15.0 overrides is refused for a role without `clients:write` (finance,
  read-only), by the same rule as 1.15.4's other grants a role may not hold (`server/permissions.js`
  `grantProblem`): it is also removed when the person's role changes to one of those (audited as
  `user.permission.revoke`, `cause: "role_change"`) and ignored at request time, so a stray row does nothing (Users
  & permissions marks it *No effect*). `test/role-expansion.test.js`: a default navigator and clinician get 403 over REST and a refusal by
  sync push; a supervisor and an administrator still succeed. The sync-rules characterisation is back to its 1.15
  outcomes for another worker's records (the 1.16.0 `was:` notes remain only for "client off the caseload").
- **Clinical notes for navigators**: listed, opened, on the timeline and synced to their devices; still not written,
  signed or added to. That includes notes marked as SUD counseling notes (42 CFR §2.11), by the owner's decision: a
  programme whose policy keeps those to the treating clinician denies the navigator *Read clinical notes*
  (`notes:clinical:read`) under Settings → Users & permissions → Permissions (docs/compliance/PART2.md). Assessments
  stay clinicians' and supervisors'. An administrator still reads a clinical note only by break-glass; every Part 2
  disclosure rule is unchanged.
- **Budget for clinicians**: Funding & spending and the settlement report open; recording spending does not.
- **Home**: a navigator's or clinician's activity card counts the program's visits and says so (*What the team has
  been doing*), as the dashboard follows what a person can see. Their to-do counts, and the overdue pill, stay
  their own: the team's are for someone who countersigns and sees every client (a supervisor or administrator,
  as before; `tasks.team` in `GET /api/reports/dashboard`).
- **Devices (local mode).** A navigator's first sync is now the whole programme: at 20,000 clients, 503,742 rows in
  120 pages (29.3 MB on the wire, 460.3 MB of JSON, 19.3 s of server time) against 104,000 rows for a 2,000-client
  caseload (docs/PERFORMANCE.md, measured with `scripts/bench/run.js`, which now measures both). A programme that
  uses local mode should deny `clients:all` to the people who sync devices unless it is small.
- **A device follows a change to what its person may read** (new; before, it did not). A pull used to send only
  rows changed since the device's cursor, so a device that synced before a permission change kept what the person
  could no longer read, and received what they newly could only as its rows happened to change. Each pull answer
  now carries `scope` (a key of caseload scoping and the permissions sync depends on) and the device sends back
  the one it last saw: after a narrowing (a deny of `clients:all` or `notes:clinical:read`, a role change) the
  office names what to remove (`dropped_clients`, and `dropped_rows` for clinical notes, another worker's records
  with no client, another worker's imports, a table whose read permission went) and the device removes it, never
  echoing it back; after a widening the pull starts again from the beginning and the device receives the rest.
  A device that synced before 1.16.0 sends `legacy`, compared with the 1.15 role defaults: at its first sync after
  the upgrade a navigator's or clinician's device downloads the whole programme, unless the person was held to
  their caseload first (then nothing changes). `server/routes/sync.js` `syncScopeKey`, `local/sync.js`;
  `test/sync-scope-change.test.js` (the browser kernel against an office), `test/role-expansion.test.js`.
  Removing 18,000 clients after a deny names them in one 1.1 MB answer (159 ms at the office); the device's removal
  was not measured in a browser.
- **A device applies the office's per-user overrides and caseload restriction.** Each pull carries the person's
  own grants and denies (`permission_overrides`) and the office's `caseload_restriction`, and the device's kernel
  applies them, so on a local-mode browser that several office accounts sign in to, a person held to their
  caseload sees only their caseload there too. Before, overrides stayed at the office and a local-mode browser's
  caseload restriction was off (set so at its first account): the device was scoped only by what each account had
  pulled.
- **SUDS on this device.** The first account (the device administrator) keeps its role's defaults. Anyone who
  signs up on a shared device after it is given per-user denies of `clients:all` and `notes:clinical:read`, so they
  still see only their own clients; so is every such account on a device that upgrades. The denies stay if the
  device administrator makes the account a navigator or clinician, and go if it is made a supervisor or an
  administrator (`local/kernel.js`, `test/device-signup-scope.test.js`).

The sign-up and new-user role descriptions, the Caseload restriction setting, the permission catalog (*See every
client*, *Read clinical notes*, *Export data*), the Permissions dialog's role baseline for a navigator or clinician
(what widened, and the deny that holds someone to their caseload) and a clinician's first-day checklist (*Open the
client list*, or *Open your caseload* for one held to it) say what the roles now see. SUD counseling notes: whether
navigators read them is a programme policy decision (docs/compliance/PART2.md).
Tests that exercise caseload scoping use a navigator or clinician held to their caseload (`H.makeCaseloadUser`);
the sync-rules characterisation records the new outcomes with `was:` notes; `test/role-expansion.test.js` checks
the matrix against 1.15.3's (only the four grants moved) and that a deny restores caseload scoping in REST, search,
the duplicate check, exports, dashboard, reports and sync. The 1.15.3 ranked-search test now scopes a navigator held
to their caseload (`test/ux13.test.js`), as do the 1.15.4 caseload tests that relied on a navigator's old
defaults (`test/security-1154.test.js`). Caseload scoping still follows `clients:all` alone (1.15.4, M1), so a
per-user deny of it is what holds a navigator or clinician to their caseload, and a supervisor held to a caseload
cannot assign themselves past it, over REST or from a device (`test/role-expansion.test.js`).

### Engineering

Engineering and governance findings from the independent review of 1.15.3. These add no migration, permission or
route.

- **The release gate sees the device routes.** `scripts/release-policy.js` read only the server's route modules,
  so a patch release could add a route to the browser kernel unnoticed: 1.15.1 added three
  (`POST /api/local/recover`, `/api/local/recovery`, `/api/local/recovery/saved`), which the check now refuses
  as it refuses any new route in a patch release. The routes `local/kernel.js` and `local/sync.js` register are
  read from their source and added to the inventory it compares.
- **Patch releases stay small.** A patch release that adds more than 1,500 lines outside docs, tests and
  generated files (`git diff --numstat` against the previous tag) is refused like one that adds a migration,
  permission or route, naming its largest files; `policy_exception` remains the recorded override
  (docs/RELEASE.md, "Patch releases stay small"). 1.14.1, 1.15.1, 1.15.2 and 1.15.3 scored 24, 488, 176 and 649.
- **The owner is in the release path.** The release job runs in a `release` environment, so a required reviewer
  can hold it for the owner's approval; `.github/CODEOWNERS` names the owner for the release and CI files and for
  `server/auth.js`, `server/permissions.js`, `server/disclosure.js`, `server/crypto.js` and `local/vault.js`; and
  the release notes end with who released it (`github.actor`, and who re-ran it). The GitHub settings that make
  these binding (branch protection on `main` with pull requests, CI and code-owner review; the environment's
  required reviewer; a tag rule) are the owner's to turn on and are listed in docs/RELEASE.md, "Owner control over
  releases".
- **Migration numbering is checked.** A released migration keeps its position in `server/db.js` for good (the
  position is the schema version a database records). `scripts/migration-order.js`, run by
  `test/migration-order.test.js`, fails when a released migration moved, changed or was removed against the
  previous release tag, or a `// N:` header does not carry its position, so two branches that each add
  "migration 49" cannot both land unnoticed. CI's `test` job fetches the release tags for it. The convention is
  written above the array and in ADR-0007.
- **An upgrade test from a 1.15.x database.** `test/fixtures/release-v1.15.3.sql` was written by 1.15.3's own code
  (schema 48; its sample data, clients with names in other scripts, and at least three rows in each of the 36
  tables with an encrypted column); `test/migrations.test.js` opens it and checks every value still decrypts and
  every blind index still matches.
- **The thorough tests are two CI jobs.** The full-size SDC attacker sweeps took most of the `thorough` job's
  30 minutes; they now run in `thorough-sdc` (60-minute limit: on its own the sweep took 27 minutes on the
  development container, the rest 17 seconds), and the performance checks in `thorough`. Both
  are required by the release gate (`scripts/test-thorough.js --part sdc|rest`; `npm run test:thorough` still runs
  everything).
- **The permissions-admin browser script runs in CI.** It was not in `scripts/ui/run-all.sh`'s default list, so
  it never ran; the suite is now 39 scripts, and a test fails if a script in `scripts/ui/` is left out again.
- **Benchmarks.** `scripts/bench/run.js` measures a publication release for a fiscal year at 20,000 clients (wall
  time, and the longest the server's main thread was held), and a navigator's client list while one is audited;
  docs/PERFORMANCE.md records the numbers and re-measured first-load figures.
- **README** listed the Node 24 job as advisory; it has been required since 1.11.0. It now names the required
  jobs as the release gate does.
- **A restore's undo copy that cannot be encrypted is reported, and sealed later.** When a restore could not seal
  the copy of the database it set aside, the only sign was a warning in the log, and the whole database stayed
  beside the live one in plaintext until the next start. Now Settings → Security status shows *Unencrypted database
  copies* (bad) with the file, why the seal failed and what to do, `/api/health` answers 503 naming the file, and
  housekeeping tries to seal it (and any plaintext pre-migration snapshot) every hour.

The Frontline and Reporting and market sections are fixes from the independent frontline-UX and market reviews of
1.15.3. They add no migration or permission and change no role's permissions: finance's new reach (below) goes
through the existing `reports:funder` check. No new API route; the browser has one new page address (`#/ssp`, the
syringe services summary on its own page) over the existing `GET /api/reports/ssp`. One new setting:
`API_RATE_LIMIT`.

### Frontline

- **Repeat last visit copies what kind of visit it was, never how much.** It copied the last visit's supply lines
  and quantities (another worker's included), so a repeated visit nobody changed drew stock and counted kits a
  second time; the only warning was a tooltip. The same items are now on the form with every quantity empty, the
  kits and strips counts and any direct cost start at nothing, and a note at the top says whose visit it was
  copied from and when (*Copied from Jordan Walker's visit on 26 Sep 2026 … Supplies start at zero … This visit is
  recorded as yours*).
- **The bell's panel no longer says "null".** With eight or fewer to-dos due it showed the word *null* under the
  list. Four other places wrote a missing element into the page the same way and now do not: the profile's
  two-step card when two-step verification is required, the SCIM card without a token list or deprovisioning
  report, and the setup wizard's finished page without a key file.
- **A yes/no question nobody asked is "Not asked", not "No".** Veteran, history of overdose, justice involved,
  pregnant or parenting and co-occurring mental health were stored as *No* whenever they were left out, and
  SUPRT-A then pre-filled *no*. Like risk's *Not assessed* in 1.15.3: a client created by the intake form, Quick
  add, an import (a blank cell) or a device's sync without an answer stores none, the record shows **Not asked**,
  and the form asks **Yes / No / Not asked** instead of a checkbox. SUPRT-A pre-fills only what was recorded:
  *ever had an overdose* is *no* only when the record says so. Clients recorded before this keep their answers.
  An import whose yes/no column said "no" failed its row (*cannot be bound*); it now imports.
- **SUPRT-A is complete only when it is.** A baseline could be saved *complete* with its screenings, diagnoses and
  crisis questions blank. Every question of each section the assessment point asks is now needed (sections B-D at
  a baseline, reassessment or annual assessment, E at the follow-ups, F at a baseline without SUPRT-C; not the free
  text, nor the date of birth; the medication when MOUD is *yes*), each has a *Don't know / not recorded* or *Not
  screened* answer, and saving names every question still to answer, once, with each marked where it is. Gender,
  housing, insurance and route of use are lists with labels, not text boxes holding codes. With no grant ID set,
  the form says so and links to where it is set. The tab no longer says a baseline "is due once…" beside *Due
  now*. SUDS's reading of the handbook: verify it against the current SUPRT-A handbook.
- **Returned or reopened time is a to-do for the worker.** A supervisor returning (or reopening) time now puts a
  to-do on the worker's list, due at once so the bell shows it: which day and how long, who returned it and why
  (encrypted; one to-do per worker for a batch). The approval queue has **Select all**, and every row's buttons
  say which entry they act on (*Approve 2h 30m on 28 Sep 2026 for Maria Rivera*), on Supervision and the time page.
- **The note viewer names the client.** Its link read *view*; `GET /api/notes/:id` now carries the client code,
  and the name for a reader who may open the record, and the link says *Rivera, Maria (C26-0012)*.
- **Search says what it found.** A polite live region announces *3 clients and 1 resource found* or *No match*,
  the Down arrow moves into the results (Up, Down, Escape back to the box), and the box says *Find a client or
  resource* where the reader may see the directory.
- **Home's Calls tile counts what the worker may see**, as the visits tile does: their caseload's calls and their
  own calls with no client (it counted the whole programme's). A role that sees every client sees every call.
- **Signing a note closes its "Finish and sign your note" reminder**, at the office and when the signature arrives
  from a device; the author's other reminders stay.
- **Wording.** An error is said once: a message of its own (*Password must contain…*, *That recovery code is not
  right*, SUPRT-A's) no longer repeats the field messages shown under each field. The setup wizard's username help
  (the *guest* default stays) goes away once another name is typed, and its finished page points to *Settings →
  System & backups*. A production Home no longer suggests loading sample data. Read-only is described as
  *reports and de-identified lists; cannot open client records*. *Continue where you left off* does not promise
  "from any device" on SUDS on this device. The overdose form's help names the reversal choice as the list shows
  it. A supervisor's time page is **Staff time**. The consent recorded from a referral says so once. New time is
  charged to the worker's default fund, as a new visit is. On a client's record the `n` shortcut logs a visit for
  that client. The audit-anchor notice keeps its place (a security finding) and now says plainly that nothing in
  SUDS fixes it and what to ask IT, with **Copy the request for IT**.
- **From the live retest of 1.15.3.** The expiring-consent alert on a client's Overview read *the Part 2 consent
  consent to …*: "consent" is now said once (and still added for a type whose name lacks it). An empty
  **Waitlist** offers **Add someone to the waitlist** (the intake form, opened on the status Waitlist) to a role
  that may add clients, and tells anyone else who does. An inactive resource's profile was checked in the browser at
  1280 and 390 px: its badge is an item of the badge list, read as *Status: Inactive*, and the browser suite now
  asserts it. So is the unsent-visit offer after navigating away: *Resume your unsent visit?* restores the fields,
  and Discard clears them.
- **A publication release does not offer "Export everything to Excel"**, the program's own record-level workbook
  for internal checking; the submission run still does.

### Reporting and market

- **Settlement people served per activity.** The DHCS layout and county templates repeated a fund's whole count
  of services and people on every one of its activity rows. Services and people are now on the row of the
  activity they fall under, the fund's own Exhibit E category and HIAA; a fund's other rows carry its spending.
- **County templates map more.** A column can take the naloxone kits and test strips distributed and the
  reversals charged to the activity's fund (10 or fewer written "10 or fewer"). A template's rows can be one per
  fund of another type (a block grant (SABG), SOR or county general fund report), with the settlement-only columns
  left blank and every active fund of that type listed.
- **Finance runs the syringe services summary and SUPRT-A completion rates**, aggregate only, through the existing
  `reports:funder` check: the summary as the programme's own submission of the whole programme (an internal run is
  refused), from a link on the funder report (`#/ssp`); the completion rates of the whole programme, not the
  follow-ups due, which name clients.
- **`API_RATE_LIMIT`** (default 600 requests a minute per address) joins `LOGIN_RATE_LIMIT` as a setting, and
  DEPLOYMENT.md says how an office behind one NAT address raises both for a day of bulk imports.
- The market pack: the scorecard has SUPRT-A, supplies and syringe services, and finance reporting rows (SUPRT-A
  with its "verify against the handbook" caveat), EVALUATION-RESPONSE.md runs through 1.16.0, the programme
  buyer guide describes supplies by item, site and lot, and what is deferred is listed with why.
- **Deferred:** publication for programmes serving 20-40 people (a change to the disclosure method needs the
  independent statistical review first); SSP participants from anonymous contacts (no field holds a participant
  code; adding one is a schema change); the SUPRT-A codebook and SPARS batch file, and the official NDP and SSP
  templates (not available to check against); people trained (SUDS does not record training).

## 1.15.4 — 2026-09-29

### Security

Fixes from an independent security review of 1.15.3, for the 1.15.4 security release. No migration, no new
permission, no change to which roles hold a permission, and no new route.

**Advisory:** SUDS 1.15.3 and earlier are affected. H1, H2 and the self-assignment in M1 affect every release up to
and including 1.15.3; the permission-override findings (M1, M2, L2) affect 1.15.0–1.15.3; the recovery code (L1)
affects 1.15.1–1.15.3. Upgrade to 1.15.4.

- **H1 (High) — a device could approve time and spending, its owner's own included.** Sync push kept the status a
  device sent for a time entry, so a navigator's phone could push its own hours as *approved*, and a supervisor's
  could approve the supervisor's own; an approver's device could approve (or reimburse) the approver's own
  expenditure, which `POST /api/budget/expenditures/:id/approve` refuses. Rulings are now the office's alone, in
  the rules both doors share (`server/rules/shared.js` `officeRuling`, used by `server/rules/time_entries.js` and
  `server/rules/expenditures.js`): a push may submit time (draft → submitted, and resubmit time it was shown
  returned) and keeps everything else about the status, approver, date and note as the office has it. A ruling
  in a pushed row is not applied and not silently dropped: the row lands without it and is **flagged** to the
  device's sync screen and the audit trail (`sync.conflict`, `flagged: "ruling"`). The same holds for a note's
  countersignature (never taken from a device, now flagged) and for whether a note needs one: a trainee's device
  could push `cosign_required = 0` and escape countersigning; it now comes from the author's account, as over
  REST. On a device that syncs with an office, the approve, approve-batch, expenditure-approve and countersign
  routes answer 403 *done on the office SUDS* up front. The other columns that record the office's own acts were
  checked: a CalOMS record's extract date could be cleared by a push (putting the record in the next DHCS extract
  again) or set; it is now the office's, like a SUPRT-A assessment's SPARS export date, and a device that asserts
  either is flagged (`flagged: "office_mark"`). Note signatures (the author's own), referral outcomes (anyone on
  the caseload, as over REST) and the accounting of disclosures (append-only) take nothing more from a device
  than their REST routes do.
- **H2 (High) — a de-identified role could find out whether a named person is a client.** Finance and read-only
  accounts could search `GET /api/clients?q=` by name, date of birth or phone (including `rank=1`), and a match
  told them that person is a client — without showing a name, but 42 CFR Part 2 protects the fact itself. For a
  role without `clients:read`, `q` now matches an exact client code only; anything else finds nobody, in the same
  shape as no match, and the search box says to search by code. Every client search is audited by the field it
  looked in (`searched`: name, dob, phone or client_code; `search_refused` for a de-identified identifier search),
  never by what was typed.
- **M1 (Medium) — permission overrides broke caseload scoping.** Holding `clients:list-deidentified` exempted
  anyone from caseload scoping, so a navigator granted it saw every client's record; finance or read-only could be
  granted `clients:read` or `export:identified`; and `assignments:manage` let its holder put themselves on any
  client, which undid a deny of `clients:all`. Caseload scoping now follows `clients:all` alone (a de-identified
  account, which can open no record, is the only one not held to a caseload), so denying `clients:all` puts a
  person back on their caseload in lists, records, search, exports, sync pull, the dashboard and reports. One rule
  (`server/permissions.js` `grantProblem`) refuses, at grant time, `clients:read`, `clients:write` or
  `export:identified` to a de-identified role and `clients:list-deidentified` to a role that opens records, and
  `auth.effectivePerms` ignores such a grant at every request, so an older row does nothing (Users & permissions
  marks it *No effect*). Adding (or ending) a care-team assignment needs a client the actor can reach, or
  `clients:all`, at both doors (`server/rules/assignments.js`), and **Move a caseload** moves only such clients
  (the rest are counted as `not_on_caseload`, not named). `assignments:manage`, `clients:read` and `clients:list-deidentified` are rated
  *sensitive* in the permission catalog (risk labels only).
- **M2 (Medium) — privileged grants survived a role change, so a demoted account could promote itself.** An
  administrator granted `users:manage` and then made a navigator kept the grant, and could set their own role back
  to administrator. Grants a role may not hold are now ignored at every request (`effectivePerms`) and removed
  when the role changes (each audited as `user.permission.revoke`, `cause: "role_change"`), and nobody can change
  their own role (`PUT /api/users/:id`), up or down.
- **L1 (Low) — the recovery code outlived the device administrator.** On SUDS on this device, deactivating the
  person who manages the device left their recovery code working, and it made them a new administrator account.
  Now the code stops working the moment that account is deactivated or removed (audited
  `device.recovery_code.dropped`), the administrator who made the change becomes the one who manages the device,
  and Home and **This device** ask them to make a new code. The code screen offers **Print it** first and
  **Save to another device (as a file)**, and says to keep the file off the device.
- **L2 (Low) — override hygiene.** An override's reason is 10 to 300 characters, the form says to keep client
  details out of it, and the audit log records its length and SHA-256, not its words. Revoking an override needs a reason
  (`DELETE /api/users/:id/permissions/:permission` with `{ reason }`; the Revoke dialog asks). A deny is audited as
  `user.permission.deny` (it was logged as a grant). `npm run reset-admin` removes a deny of `users:manage` on the
  account it resets and says so, and says first, plainly, when it reactivates a deactivated administrator.
- **L3 (Low) — unsent visit drafts stayed in a signed-out tab's memory.** Choosing **Sign out** now clears
  what was being typed at once (and a form left open before it cannot put it back when the same person signs in
  again); after a sign-out for inactivity it is kept for 15 minutes for the same person to resume, then cleared.

## 1.15.3 — 2026-09-29

Fixes from QA of 1.15.2. No migration, no new permission, no change to which roles hold a permission, and no new
route.

- **Approved time is locked.** `PUT /api/time/:id` on an approved entry answered 200 and changed its minutes while it
  stayed *approved* — a signed-off time sheet could be rewritten. An approved entry can no longer be edited or
  deleted by anyone (the worker, or a manager with `time:all`): the API answers 409 *ask a supervisor to reopen it*,
  and a device's sync push of the same edit or deletion is refused for good (`not permitted`). The rule is in
  `server/rules/time_entries.js`, so both doors apply it. To correct approved time, a supervisor (`time:approve`,
  not their own time) presses **Reopen** on it in **My time** and gives a reason: the existing
  `POST /api/time/:id/approve` now accepts `decision: "rejected"` for an approved entry (audited `time.rejected`,
  `reopened: true`), and the worker corrects it and submits it again. Submitted time is still its worker's to
  correct until it is ruled on. Approved expenditures were already locked at both doors (checked by a new test).
- **Risk is "Not assessed" until someone assesses it.** A client created without a risk level was stored and shown
  as *Moderate* (the column's default). The intake form's Risk level now starts blank (*Not assessed*); a client
  created or imported without one has none, and badges, the client list, Home's caseload and the waitlist say
  *Not assessed*. The client list takes `risk=not_assessed`; the high-risk count and filter are unchanged. Clients
  already recorded as Moderate are left as they are.
- **Resource pictures: a photograph saved as PNG uploads.** A PNG stayed a PNG when shrunk and was still several MB
  at 1600 px, over the 2 MB picture limit, so the upload was refused and the Pictures card went blank — choosing a
  picture seemed to do nothing, on the office server and on this device. Such a picture is now sent as a JPEG that
  fits, and the card lists any picture that could not be added and why.
- **"Inactive" is read out where it is shown.** A deactivated resource's *Inactive* badge sat alone in a list column
  with no heading (a screen reader announced it under "Actions"), a directory card did not show it at all, and on
  its profile it ran into the other badges. It now sits with the name (the card's link and the list row's button
  say *Status: Inactive*) and the profile's badges are a list, as on a client's record. A list row's open button is
  no longer built from decorative text alone (a resource with no picture got a button with no name), and a funding
  source's status keeps its heading on a phone. The accessibility script checks resources, users and clients at
  1280 and 390 px.
- **Typos.** *the batch that expires first first* (Supplies help and the visit form) now reads *expires soonest
  first*; screen text uses US spelling throughout: *license* in the ASAM notices, and *program* / *organize* in the
  permission names and descriptions, a Settings field error, the publication refusal, a printed form starter, the
  device sync notice and the page description.
- The browser suite checks that a clinician's client record on a treatment-adjacent program shows **Care plan** and
  **Assessments** as tabs, not under More, at 1280 and 390 px (1.15.2's promotion; it holds).

Usability fixes (1.15.3). No migration, no new permission, no change to which roles hold a permission, and no new
route: the server changes are a query parameter on an existing route (`POST /api/clients/:id/assignments?restores=`,
the Undo after ending an assignment), a ranking option on another (`GET /api/clients?rank=1`) and three audit action
names for the undos.

- **Time is logged from a visit or call only when asked.** *Also log this as a time entry* starts unticked on every
  new visit (it started ticked and then remembered the last choice, so a duration nobody checked went on time
  sheets as hours worked), and so does a call's *Also log as time entry*. Ticked, its help says how many minutes of
  which category it adds; saving with the visit's prefilled 30 minutes untouched asks **Log this time?** (*Log 30
  minutes* or *Change the duration*, which returns to the field with nothing saved). **Log time** by hand for a day
  and client that a visit *or call* already logged time for now asks **Log this time as well?** on Save, as well as
  saying so while it is filled in (it looked only at visits, and never asked). The `visit_log_time` preference is
  no longer read. Help text and the user guide no longer say it starts on.
- **The bell keeps up.** It polled every five minutes; it now asks once a minute, a moment after anything is saved,
  and when the window gets focus or the tab comes back into view (`/api/tasks/due` still writes an audit entry only
  when its answer changes). The bell is a button that opens a panel: what is due (the first eight, overdue marked),
  **Updated just now / n min ago**, **Refresh** (announced) and *All to-dos due*.
- **Search ranks what it finds.** A name search lists exact name matches first, then the clients the searcher worked
  with lately (the same activity as Home's *Recent clients*), then names starting the same way, then sound-alikes.
  The search box at the top of every page (`?rank=1`) leaves sound-alikes out when anything matched better — a
  misspelling with no better match still finds them — also lists matching resource directory programs, and marks
  each result *Client* or *Resource* in words (the icon is hidden from screen readers). Caseload scoping and the
  `client.list` audit entry are exactly as before; only the order, and with `rank=1` the minimum, change.
- **An expiring consent is at the top of the Overview.** A consent that expires within 30 days is named, with its
  date and how many days are left, above everything else on a client's Overview, with a link to the Consents tab;
  one that has already expired while an open referral still relies on it is named too.
- **An unsent visit is offered back.** A new visit's draft now keeps everything — every field (a required one still
  empty, or a date half typed, no longer stops it being kept), the supply lines and a note's sections. Opening *Log
  a visit* again asks **Resume your unsent visit?** (*Resume* / *Discard*) instead of filling it in unasked, and after
  signing back in the same question is at the top of the page. Drafts stay where the design has always kept them —
  in the page's memory, never in browser storage (a reload loses them, as before) — and they are now the typist's
  only: another person signing in on the same tab starts with none (they used to be offered the previous person's
  drafts), and a save still queued when someone signs out cannot land in the next person's.
- **The same visit twice asks first.** Saving a new visit for a client who already has one of the same kind that day
  (read through the ordinary visits list, so it sees exactly what the worker may see) asks **Save another visit?**,
  saying when and by whom; *Cancel* keeps the form open with nothing saved.
- **A quicker visit form.** *Where & how* (location and modality, filled in from the last visit) is folded on a new
  visit, its heading saying what it holds, so a new visit of any type shows seven fields at 390 px before its
  sections: client, what was done, date & time, the supply picker's usual items and the summary. An edit shows it
  open.
- **Keyboard shortcuts.** **/** finds a client, **n** logs a visit, **?** lists the shortcuts, and **Ctrl/⌘ + Enter**
  saves the open form (it presses the form's own Save). The single keys act only outside text fields and dialogs, and
  **My profile → Keyboard shortcuts** turns them off for that person on every device (WCAG 2.1.4; the ACR now says
  *Supports*).
- **Undo instead of a question, where it can be undone.** Deactivating a resource, retiring a policy or contract and
  ending a care-team assignment now happen at once with an **Undo** toast (10 seconds, held while pointed at or
  focused, focus on Undo, announced through the live region). Undo reactivates the resource or document through its
  edit route (audited `resource.reactivate` / `document.reactivate`) or puts the same worker back on the case in the
  same role (`assignment.restore`, naming the assignment it undoes; the ended one stays in the history). Actions
  that cannot be undone keep their confirmation dialogs unchanged.
- **Empty lists say what to do next, or who can:** the care plan's problems and goals, incidents, documents,
  resources, supply stock, overdose events, the caseload on Home, "all caught up", the waitlist, the funder report's
  discharge reasons, CalOMS records, episodes, a client's forms and SUPRT-A switched off.
- **Your first day.** The welcome card on Home holds three first steps for the person's role (navigator, clinician,
  supervisor, finance, read-only), each with the button that does it and a tick box, counted as they are done
  (preference `first_day`); the old tips are folded under *A few things that help*. An administrator gets none: their
  *Finish setting up* card is that list. The role homes are otherwise unchanged.
- **Inline help** on the Part 2 consent form (*Is this consent a valid basis for sharing?*) and on Adjust stock,
  Dispose of and Move stock (*when to adjust, dispose or move*). The funder report's *Which file do I send?* (1.15.2)
  already covers the third.
- **200% zoom.** Settings' tab strip wraps onto a second row instead of scrolling tabs past the right-hand edge at
  640 CSS px (`pageTabs(…, { wrap: true })`); the client record (supervisor and clinician), the funder report and
  Supplies already reflowed and are now checked at 640×400 with device scale 2.
- A confirmation closed with ✕ or Escape now answers *Cancel*, so a form waiting on it is not left with Save disabled.
- Tests: `test/ux13.test.js` (search ranking, caseload scoping and audit, the three undos and their audit and
  permissions, time only when asked, the lists the duplicate checks read); browser script `scripts/ui/ux13.mjs`
  (the suite has 38 scripts); `ux-forms`, `frontline-review` and `review-fixes` follow the folded *Where & how* and
  the unticked time box.

## 1.15.2 — 2026-09-28

Fixes from a UI evaluation of all six roles (about 120 pages). No migration, no new permission, no change to
which roles hold a permission, and no new route: a reminder is an ordinary to-do (`POST /api/tasks`).

- **Supervision: act on the unsigned notes, not just see them.** Each draft under *Unsigned notes across your
  team* has **Open note** (the note opens over the queue, as countersigning does) and **Remind author**, which
  gives the author a to-do on that client's record, due today (high priority when overdue), asking them to finish
  and sign it. The to-do names the kind of note and the day it was started, nothing from the note; its title and
  details are encrypted like every to-do's, and creating it is audited (`task.create`). **Remind all overdue
  authors** confirms first and sends one reminder per overdue note, skipping any note whose author already has an
  open reminder for it (whoever sent it); a row with an open reminder shows *Sent* and its date instead of the
  button. You are never offered a reminder for your own draft. The queue's unsigned notes now carry `author_id`.
- **Individual permissions have their own place.** Settings → Users & permissions has a **Permissions** button on
  every row and a badge (*1 override*, *2 overrides*) on rows with individual overrides (`GET /api/users` counts
  them, for user managers only). It opens a Permissions dialog with exactly what the Edit dialog used to hold at
  its bottom: the role baseline, effective permissions with their provenance, the overrides and their reasons, and
  the grant/deny form with its risk flags and 10-character reason; deny still wins and every change is audited as
  before. The Edit dialog points to it (**Permissions…**).
- **Overrides in one trip.** Creating a user no longer ends with "Save the user first to manage individual
  permissions": once the temporary password has been noted, the new user's Permissions dialog opens, ready to
  grant or deny.
- **A supervisor's sidebar is their job.** Home, then **Supervision**, then Clients, Waitlist, To-dos, Visits,
  Calls & texts, Notes, Referrals and Settings (moving a caseload, the audit log): 10 entries instead of 23. The
  rest — Reports, the Funder report, Funding & spending, Policies & contracts, Supplies, Overdose & reversals,
  Forms, My time, the Resource directory, Privacy & Part 2, Import, State reporting and SUPRT-A — is under
  **More**, one click away; nothing is hidden. Decided from permissions (`supervising()` in `public/app.js`:
  countersigns and moves caseloads, but does not manage users or settings), not the role name. Administrators'
  and front-line sidebars are unchanged.
- **A read-only Home that does not talk to an actor.** An account that holds nothing but reading, reports and
  exports (decided with the deny-aware `can()`, not the role name) gets **Your reports** first — the Funder
  report, Reports and the Resource directory — above the figures it may see, and no *To-dos for today* or
  *Continue where you left off* card. Those two cards now follow `tasks:read` and client or note access, so a
  finance account no longer sees them either.
- **Client tabs by role.** Beside the six everyday tabs, a clinician's strip shows **Care plan** and
  **Assessments**, a supervisor's **Episodes** and **Care team** (when the modules are on); the rest stay under
  More. The tab strip still measures the row after promoting and folds what does not fit at 200% text (the
  1.15.1 reflow fix is untouched).
- **Funder report: which file do I send?** The three downloads are grouped under that heading, each with a line
  saying what it is for: **This report (Excel)** is the submission workbook for the funder (for a publication
  release, the file to publish once reviewed), **CSV** the same figures for a funder portal or data system, and
  **Export everything to Excel** every program sheet for your own checking, not for sending. The buttons and the
  publication review's gating are unchanged.
- Tests: `test/ui-eval.test.js` (the reminder through `POST /api/tasks`: assignee, creator, client, encrypted
  title and details, audit, found again by its reference, gone once done; the override count on the users list
  for user managers only). Browser: new `scripts/ui/ui-eval.mjs` (106 checks, with axe on each changed page),
  registered in `run-all.sh` (38 scripts); `ux-nav`, `programme` and `permissions-admin` follow the deliberate
  sidebar and Permissions-button changes.

## 1.15.1 — 2026-09-28

A way back in for the owner of SUDS on this device who has forgotten the password, and for an office
administrator who is locked out. No migration and no change on the office server's database; three new device
routes (`POST /api/local/recovery`, `POST /api/local/recover`, and `POST /api/local/recovery/saved`) that exist
only in the browser kernel, and one command-line script.

- **Recovery code for SUDS on this device.** When a device is set up, right after its first account is created,
  SUDS shows a recovery code once: seven groups of four letters and numbers. Download it as a text file or print
  it, keep it somewhere safe away from the device, and tick *I have saved my recovery code* to go on. SUDS never
  stores the code and can never show it again. Whoever has it can open every record on the device, like a key.
- **"Can't sign in?" on the device sign-in page** lists every way back in and says which keep the records:
  **Use your recovery code** (keeps every record: type the code and a new password; you are signed in and given
  a new code, and the one you used stops working), **Restore from a backup** (the backup's records, accounts
  and passwords; anything since the backup is lost) and **Start over on this device** (erases everything). A
  wrong code gets a plain message and each further try waits a little longer; after several the message says to
  check the saved file.
- **This device → Recovery code** shows whether the device has a code and when it was made. The person who
  manages the device can make a new one after typing their password again; the old code stops working at once.
- **Devices set up before this release have no recovery code.** When the person who manages one next signs in,
  Home asks them to make one. The reminder can be dismissed, but comes back at every sign-in until a code has
  been made and saved. Other accounts are not asked, and cannot make one.
- Using the code sets a new password for the person who manages the device, clears that account's lockout and
  turns off its two-step verification on the device (set it up again with the new phone). If that account has
  been removed or deactivated, the username typed becomes a new administrator account that manages the device.
  The audit log records who made or used a code (`device.recovery_code.created`, `device.recovered`), never the
  code.
- **Office server: `npm run reset-admin -- <username>`** lets whoever runs the server let a locked-out
  administrator back in (forgotten password, too many wrong attempts, or a lost authenticator phone). It prints a
  new temporary password once, which must be changed at the next sign-in, clears the lockout and two-step
  verification, ends the account's sessions and writes `admin.reset_cli` to the audit log. Having a shell on the
  server is the proof of ownership; there is still no shared or stock administrator password.

- **Client tabs fit at 200% text.** When the section you are on would have been under **More**, it took the place of
  the last tab that fitted but could be wider, and the row then ran past the screen (WCAG 1.4.10 reflow; found by
  the accessibility script at 200% text on a 1280 px screen). The row is now checked again after the swap.

## 1.15.0 — 2026-09-28

**Released under a policy exception.** 1.15.0 is a feature release one day after 1.14.0, where the release
policy allows one a month (docs/RELEASE.md). The owner approved the exception: the admin-managed per-user
permission overrides below are finished, reviewed and regression-tested, and a patch release cannot carry
them — they add schema migration 48 and five new API routes.

- **Per-user permission overrides.** The six fixed roles stay as defaults. An admin can now grant or revoke a
  single permission for one user, see their effective permissions with provenance (role / granted / denied),
  and every change is audit-logged with the reason, grantor and timestamp. Deny always wins, nobody can edit
  their own permissions, privileged grants stay admin-only, and reasons need at least 10 characters.
- **Deny-aware enforcement everywhere.** Effective permissions are recomputed on every request, on the server
  and in the browser kernel alike; the app's `can()` matches the server's deny ordering.
- **Mid-session refresh.** A signed-in user picks up permission changes from their profile without signing out
  and back in; `GET /api/me` serves the effective snapshot.
- "Users & roles" is now **Users & permissions**; per-user overrides are documented in
  `docs/security/IDENTITY.md`.
- The schema moves to version 48 (`user_permission_overrides`).

Note: overrides are not synced between the office server and devices — that sync needs its own design.

## 1.14.1 — 2026-09-28

A fix release from the retest of 1.14.0 on the live site. No migration, permission or route.

- **Home no longer blanks while it refreshes.** Home's 90-second refresh redrew the whole page, which showed
  "Loading…" with no heading until the figures came back, and each redraw started another refresh timer
  without stopping the last, so refreshes multiplied the longer Home stayed open. There is now one timer, and a
  refresh builds the new Home first and swaps it in whole, only while nobody is working in the page.
- The sign-in page's line reads "…with the privacy that substance-use records need".
- The phone/tablet page offers **Open SUDS** once; the notice that records stay on the device no longer
  repeats the link.

## 1.14.0 — 2026-09-27

**Released under a policy exception.** 1.14.0 is a feature release one day after 1.13.0, where the release
policy allows one a month (docs/RELEASE.md). The owner approved the exception so that the findings of the four
reviews of 1.13.0 (frontline, security, engineering, market) and of a usability evaluation ship together, with
the market gaps they named. The release gate now checks the monthly limit, so this exception is recorded, not
an oversight.

**Upgrade notes for administrators.** Four migrations run on start (schema 43 → 47), after the usual
pre-migration snapshot, which is now encrypted like a backup once the upgrade succeeds and deleted after 14 days:
44 adds SUPRT-A records; 45 moves supplies from one number per item to items, sites, lots and a stock ledger
(each 1.13 count becomes an opening balance at the Main office); 46 fills in a missing search index for sample
clients' preferred names; 47 adds indexes (the first start takes a few seconds longer on a large database).
The first start also compacts the database once, so values encrypted by earlier upgrades are not left in its
free pages. New permissions: `reports:funder` (finance, supervisor, administrator), `supplies:read`,
`supplies:receive` (navigator, clinician) and `supplies:*` (supervisor, administrator). Setting a supply count
now needs a supervisor or administrator. Downloading the key backup asks for the password or authenticator code
every time. Turning two-step verification off needs a current code.

### Frontline

- Home and the Reports dashboard now count visits recorded with no client — community naloxone distribution and street outreach. They used to leave them out, so an anonymous hand-out of ten kits appeared as two kits on Home while the funder report and NDP log said twelve. A supervisor's or administrator's visits, kits and test strips now match the funder report for the same period. A navigator's figures are their caseload's visits plus the anonymous outreach they logged themselves.
- The program's usual consent (Home → Finish setting up) now lets the administrator tick referral partners from the resource directory. Nothing is ticked in advance and crisis lines are not offered; ticked partners are remembered when the consent is reopened. It previously pre-filled six arbitrary directory entries, including 211 and 988, into a recipient too long to save. A consent's recipient can now be up to 2,000 characters. Form errors now say what to change in plain words ("… is too long: keep it under 2,000 characters") instead of "Validation failed: … max length 300".
- The setup wizard now asks what kind of funding the main fund is. For opioid settlement money it also asks the allowable use and California High Impact Abatement Activity, so the fund appears in the opioid settlement report. Previously every wizard fund was created as "other". When no fund is settlement money, or nothing was spent in the period, the settlement report now says so on the Reports page and in the file, instead of producing a header row with nothing under it.
- The overdose list now shows the naloxone doses that were recorded, and "given, doses not recorded" when none were entered. It used to show "1 dose" where the reports counted 0. The confirmation message now includes the doses, and a new overdose event starts on the worker's default fund, as a visit does.
- Home's setup checklist now has "Add your supplies": one click adds Naloxone kit and Fentanyl test strips to Supplies, and Supplies offers the same when they are missing. A visit that hands out kits or strips when the cupboard has no item for them now says they were not taken off Supplies, instead of silently leaving the count unchanged.
- Coded choices now read as words everywhere, exports included: "Court / probation", "EMS", "VA", "Opioids (fentanyl)", "Buprenorphine XR", "Non-binary", "24/7 crisis", "Co-occurring", "Read-only", "SOR grant", "SAMHSA". Patient-rights requests are now called client rights requests.
- A production server no longer offers "Load sample data" on Home; it remains under Settings › Program. The audit-anchor finding is now a plain sentence at the top of an administrator's Home, saying what is wrong, who fixes it and where the steps are, with a link to Security status. It is amber, turns red if an audit check has failed, and cannot be dismissed.
- A new account that must change its password no longer triggers a series of refused requests on the password page. "+ Log" now includes "Overdose or reversal". Home's activity card is headed for the role viewing it: finance and read-only no longer see "What you have been doing" over the program's visits. Countersigning several notes has a "Select all" checkbox.

### Usability: forms

- Recording a visit is a field note. The visit form shows what every visit has: who (optional for anonymous outreach and naloxone distribution), what was done, when, where and how, the supplies given and a short summary. Outcome & follow-up, Syringe services, Funding & cost, Time, Recorded by and Add a note are folded sections, opened from their headings with a mouse or the keyboard. A section opens by itself when it holds something or a field in it needs fixing, and otherwise stays as you last left it; folded, it says what it holds. A cost with no budget line is caught in the form. Nothing was removed.
- A new visit starts where your last one did. Your last visit's type, location and modality fill a new visit. Until you have one, the program's default location is used.
- The time a visit logs is visible, and not counted twice. "Also log this as a time entry" says what it adds ("adds 20 min of direct service to your time"). It is on the first time, because supervisors approve hours from these entries, and then keeps your last choice. Logging time by hand for a day and client a visit already covered says so before you save. Time entries now carry where they came from (visit, call or manual) in the API, so lists can mark them.
- A visit's note in the same dialog. "Add a note" in the visit form writes the note the summary cannot hold. It is saved with the visit in one step, as a draft on the client's record linked to the visit, with the Note form's permissions, formats, Part 2 flag, encryption and audit. If the note is refused, nothing is saved.
- Supplies with no item are said up front. When Supplies has no naloxone kit or fentanyl test strip item, the visit form says so before saving: the kits count on the visit and in reports but come off no stock. A supervisor or administrator can add the items right there. Kits are always entered in the one "Supplies given" list; the plain number fields appear only when the program keeps no supply items at all.
- New client is Quick add. "+ New client" asks for the name (or the name they go by), and a date of birth or phone if given. It creates the record and opens it, where "Add details" carries on with the rest of the intake. "Full intake" opens the whole form with what you typed. When an earlier discharged record is offered for re-admission, the reason is asked for in the same dialog. It needs 8 characters, not 15: that was the break-glass minimum, a different act. The offer rules and the supervisor's review are unchanged.
- A referral stays in one dialog. Recording a consent that names the provider, or adding a provider not in the directory, is now a step of the referral dialog, never a second dialog on top; Escape goes back. A new referral asks for its outcome and barrier only when it is entered as already over; otherwise they are recorded with "Record outcome".
- A consent asks what it covers once. The ticked categories are what a consent covers: SUDS enforces them, and they are written into the consent as its scope. Anything else the signed form says goes in an optional note marked "not enforced". What is enforced is unchanged, and no existing consent was changed.
- Referrals in and out. A client's intake asks "Who referred them to us"; the Referrals page is "Referrals we make".
- Save stays on screen. In every dialog, at every width, the row with Save and Cancel stays at the bottom of the screen while the dialog is longer than it. Tab and screen-reader order are unchanged.

### Usability: navigation and wording

- Reports, the funder report, Funding & spending, State reporting and SUPRT-A now say what they are working out while they load ("Checking small counts before the release is shown…") instead of a bare "Loading…". The funder report's submission is read from one snapshot of the data, as a publication release already was, so a visit saved while it runs can no longer appear in one table and not the next. (A reported 4–6 s load could not be reproduced: at seed size these pages open in under 0.4 s, and at 20,000 clients in about half a second.)
- The sidebar puts each role's daily pages first. A navigator's main list now includes Waitlist. The funder report is under their More menu, run for their own caseload, where it used to be missing. State reporting (CalOMS Tx and the county EHR hand-off) and SUPRT-A have their own menu entries whenever the program uses those modules.
- Every screen uses the same words for the same action: "Log a visit", "Make a referral", "Clients", and "To-dos for today" on Home. + Log and the client record's buttons both offer "Make a referral", which opens the referral form for that client with their consents.
- The client record shows the six sections used on every visit (Overview, Visits, Notes, To-dos, Consents, Referrals) on every screen size, with the rest under More. Care plan, Assessments and SUPRT-A tabs appear only when the module is on and the client has something in it or you can add to it. The Timeline tab is now "Recent activity" at the end of the Overview, and "All activity" opens the full history.
- The first-sign-in welcome is a single card on Home instead of a five-step dialog covering it, so a new worker can log a visit straight away. "Got it" puts it away, and "Help" at the foot of the menu brings it back.
- Your own overdue to-dos are counted in one place, the bell, and listed under To-dos for today. A supervisor's Home still shows the team's count, now labelled as such.
- Supplies has a "Hand out" button, on the page and on each item, for supplies given on the street. It opens the visit form as a naloxone distribution (or outreach for other supplies) with the item already on it, and the client optional. Home's "Naloxone kits given" now opens the visits that handed out kits, of any visit type, and those visits add up to the number shown.
- On a phone, tab strips that scroll sideways show a chevron on the side with more tabs, and the Supplies tab now reads "SSP report" instead of being cut off. The top bar's client-list shortcut now says "Clients", and the to-do bell's count stays inside the bell.

### Supplies and syringe services

- Supplies are kept by item, site and lot. An item has a category, and naloxone items record the product. Sites can be the office, a van, a drop-in or a partner site. Lots carry a lot number and an expiry date. Stock received, moved between sites, adjusted with a reason and disposed of is recorded in an append-only ledger, and what is on hand is its sum. Each count from 1.13 is carried in as an opening balance at the Main office.
- A visit or an anonymous outreach contact can record any item handed out, with the program's usual items one tap away. Stock is drawn from the visit's site, earliest expiry first. When the books hold less than was handed out, the difference is recorded as a flagged shortfall for a supervisor rather than the count going below zero. The naloxone and test-strip counts every report reads are now the sums of the visit's items; figures for visits recorded before 1.14 do not change.
- Visits record syringes and sharps returned, counted or estimated from the container's volume. A new syringe services summary gives participants, contacts, syringes out and back, the return ratio, sharps containers, naloxone by product, test strips and referrals, as CSV or Excel. Counts of people are small-cell suppressed.
- Expired and expiring lots, low stock and shortfalls appear on Home for supervisors and administrators. The NDP day log now names the naloxone product where the visit recorded it.
- Navigators and clinicians see the stock and record deliveries at their site. Items, sites, transfers, adjustments and disposal are for supervisors and administrators. Setting a count through the older supply routes now needs a supervisor or administrator.
- A device syncs supplies. Deliveries and counts recorded offline are checked at the office, and a visit's draw-down is worked out there once. The device's own draw-down shows correct stock in the field until the office's figures arrive.

### Reporting

- Finance can now write the funder report. A finance account runs the program's own submission of the funder report, the NDP log and the opioid settlement report: exact counts, for any date range or a single funding source. It still cannot open a client record, make an identified export or run an internal report, and its Home and Reports screens still show small counts as "<11". Before this, a small organisation's grants or finance person needed the supervisor role, which opens every client record. Each run is audited with who ran it, the purpose, the fund and the period.
- Publication releases can be switched off. Settings › Program › Modules › Publication releases is on by default. An administrator can switch it off while the program waits for an outside review of the small-cell method. Publication runs and their files are then refused with a message explaining why. Submissions to funders carry on, and read-only accounts are told they have nothing to run until releases are switched back on.
- SUPRT-A for State Opioid Response programs. Programs with a SOR grant funding source get SAMHSA's SUPRT-A record (baseline, reassessment, annual assessment and closeout) on each client's SUPRT-A tab. Answers SUDS already holds are filled in, and follow-ups due appear on the To-dos page. The SUPRT-A page shows completion rates and makes a file for entry into SPARS. That file names clients, so it needs each client's consent naming SAMHSA (or an evaluation approval on file) and is written to each client's accounting of disclosures. It uses SUDS's own item names and must be checked against the current SUPRT handbook; SUDS does not reproduce SUPRT-C.
- Settlement spending for DHCS or your county. The opioid settlement report can be downloaded in the DHCS settlement expenditure layout: one row per activity, with categories, amounts and people served filled in and the narrative left for the program to write. It can also be downloaded in a county's own template, which finance or an administrator sets up by listing the county's columns, with no code needed.

### Security

- Returning clients at intake: The intake duplicate check no longer offers a discharged record the worker cannot open when only the phone number matches. The surname and date of birth must match, and the offer says only that an earlier record exists and that a supervisor will review it: no client code, and not when or why the person was discharged. Each offer puts a review task on the record for a supervisor. The check is limited to 60 per worker in 15 minutes and every check is audited. Before this, typing phone numbers into a new-client form could reveal who had been discharged and why.
- Continue where you left off: The Home page's list of drafts and to-dos due today now leaves out clients the person can no longer open. Before, after an assignment ended, it still showed the client's name and to-do titles.
- Exports and unlinked records: Exports of calls, visits, to-dos and overdose events now follow the rule the screens already followed: a record with no client belongs to the worker who made it, or to a role that sees everyone. Before, a navigator's export could include another worker's crisis call that the screen refused to open.
- Time descriptions: Finance and other roles without access to client records now see another worker's time as category, fund and minutes, without the free-text description, which can name the client. Expense descriptions stay visible to finance, which approves spending by them, and the expense form now reminds staff not to name a client there.
- Password change and two-step verification: Wrong current passwords when changing a password or turning two-step verification off now count toward the account lockout and are audited, as they are at sign-in. Turning two-step verification off also needs a current code from the authenticator app. Before, these screens took unlimited guesses.
- Key backup: Downloading the encryption key backup now asks for the password or authenticator code every time, even just after signing in. Administrators who sign in through single sign-on confirm with the county sign-in, which covers one download.
- Plaintext left on disk after upgrades: SUDS now erases deleted data from the database file as it goes. After an upgrade that encrypted a field, it compacts the file so the old unencrypted values do not remain, and does this once on the first start of this release. The copy of the database taken before an upgrade is now encrypted like a backup once the upgrade has succeeded, and deleted after 14 days. Before, values encrypted by earlier upgrades could still be read from the file and from those copies.
- SUDS on this device, shared web addresses: The offline copy of the app now reads and clears only its own stored files, never those of other sites on the same web address (it used to delete other sites' caches on activate). The documentation recommends giving SUDS on this device a web address of its own, such as a custom domain, because browsers share stored data between sites on the same address.
- Publication releases: If one publication release check runs too long, only that release is refused. Others requested at the same time are no longer failed with it.
- The database a browser restore replaces is now kept encrypted like a backup (`suds.db.before-restore-<time>.enc`, opened with `node scripts/backup.js --restore`) and deleted after 14 days; copies an earlier version left in plaintext are sealed on the next start. Up to 1.13.0 it stayed beside the live database in plaintext.

### Sync

- Each table's write rules are now written once and enforced both by the office's screens and API and by a device's sync. Before, the sync code repeated each rule by hand and had drifted from the routes. Adding a rule to a table's rules file now applies it on both.
- A device's sync can no longer do what its user couldn't do in the app. It can't edit or delete another worker's visit, call, time entry, to-do, referral, expense, draft note or assessment, rewrite a court order or a Part 2 notice, change a signed note, or lift a client's legal hold. Work that belongs to a worker's own action still syncs: a discharge closing the client's to-dos and ending the care team, or recording a referral's outcome.
- Values the office would reject over the API are now rejected from devices too: unknown categories, out-of-range numbers, missing required fields, a cost without its budget line, a referral citing another client's consent, over-allocated budget lines. Work recorded offline that the office now rejects only because its lists, modules or fund periods changed while the phone was out is kept, shown on the device's sync screen, and recorded in the audit log for the office to review.
- An addendum written on a device now marks the signed note "amended" at the office, as it does in the office app. A disclosure recorded on a device is checked against the same consent rules as one recorded at the office, and flagged to the office if its basis can't be confirmed.
- Patient-rights (client rights) requests need the patient-requests permission to sync, the same one the office app needs.
- A large sync from a device is faster: a 10,000-row upload uses about a third less server time than in 1.13.0.
- SUPRT-A assessments recorded on a device pass the same checks as ones recorded at the office. Answers the instrument doesn't ask are refused. An assessment recorded while the module was on, dated ahead, or completed with answers missing is kept and flagged for the office to review. A device can't delete an assessment already sent in a SPARS file, and the client ID, grant and site in its answers are always the office's.
- Stock movements recorded on a device are held to what the Supplies page requires: damaged, expired or lost stock is only taken off, and a fund is named only on a purchase. A delivery to an item or site the office has since retired is kept and flagged.
- On a new program's Home page, "Add naloxone kits and test strips" adds the two standard supply items.

### Performance

- A device's first sync is much faster and a fraction of the download. The office server used to read every row of the caseload again on each page, and when newly assigned clients arrived it looked them up again for every table. A 2,000-client caseload took 19 seconds and 80 MB, and held the server for up to 4 seconds at a time. The server now finds where each page ends from its indexes and reads only the rows it sends: 5.5 seconds, 5 MB on the network, and no page holds the server for more than a quarter of a second. A sync with nothing new takes 23 ms instead of 160.
- Large answers from the office server are compressed. JSON answers of 1 kB or more are sent compressed (brotli, else gzip) whenever the browser or device says it can take them. That cuts a sync, the Supplies page and the lists to a tenth or less of what crossed the network. The compression runs off the server's main thread. Exports and file downloads are sent exactly as before.
- SUDS opens faster on a phone. The sign-in page used to download all 900 kB of the app first. It now loads the sign-in page and Home up front and fetches every other page the first time it is opened, compressed. The browser keeps the app's files and checks they are current rather than downloading them again. On a phone over a mobile connection the sign-in page is usable in 1.5 seconds instead of 5.8, and a return visit downloads 8 kB instead of 954. Signing in now draws Home once (it drew it twice), and Home asks for everything at once, so an administrator's Home appears in 2.2 seconds instead of 9.2.
- Home and the Reports dashboard are four times faster with a large program: 0.4 seconds instead of 1.6 for a fiscal year at 20,000 clients, holding up other people's requests for at most 0.15 seconds instead of 0.36. The figures are unchanged.
- The Supplies page and the supply alerts on Home open in a tenth of the time with a large stock ledger (37 ms instead of 306 at 50,000 entries). Saving a visit that hands out supplies takes half as long.
- The notes list, the visits list, deep pages of the client list and long client timelines are 3–12 times faster at 20,000 clients and 200,000 notes. With 50 people working at once the office server handles 48% more requests, and typical waits fall by a third to a half.
- For administrators: the upgrade adds indexes (migration 47), so the first start after it takes a few seconds longer on a large database (9 seconds at 20,000 clients, mostly the usual pre-migration snapshot). The app's own code files and icons are now sent Cache-Control: no-cache with an ETag instead of no-store, so browsers revalidate them rather than download them each time. They contain no client information. Pages, the service worker, version.json and every API answer stay no-store.
- For maintainers: scripts/bench/run.js seeds a 20,000-client program and measures the server, and scripts/bench/frontend.mjs measures a phone's first load (docs/PERFORMANCE.md).

### Engineering

- Small funds combined. A publication release now lists every fund that served fewer people than the threshold together in one row, "Other funds (n combined)". The row shows how many funds it holds and their staff hours; their people and services are withheld, as 1.13.0 already hid them. A year with 60, 80 or 120 small funds used to be refused because the check ran out of budget; it now publishes in a fraction of a second. The check's work budget now also counts the work of setting up each question and has been re-measured: 400 million units, about 2 to 7 seconds of one core.
- Reports no longer freeze the server. The publication release reads the database from one consistent snapshot in steps, so other users' requests keep being answered. A release that was already worked out is served without reading anything again, until the data changes. At 20,000 clients the longest pause fell from 0.6–1.5 s to 0.1–0.2 s, and a repeat request takes about 15 ms. The monthly report reads a month at a time (0.3 s → under 0.05 s). The opioid settlement report's services query is ten times faster with many settlement funds.
- Feature releases are checked too. The release workflow now refuses a minor or major release less than 28 days after the previous feature release, unless an administrator gives a policy exception. `policy_exception` is the new name for `allow_patch_changes`, which still works, and its reason is printed at the top of the release notes.
- Node 22 pinned. CI and the release run an exact, checksum-verified Node 22 release, as the Node 24 job already did. The deployment guide gives the plan for Node 22's end of life (30 April 2027): move to Node 24 LTS.
- Sample data search fix: preferred-name search index now written (and backfilled by migration 46 if done).
- Tests. Upgrade tests now use 1.13.0 and 1.11.0 databases with rows in every encrypted table. The browser-kernel parity tests now also cover the dashboard, a publication release and a full sync round trip.
- Idle keep-alive connections kept 65 s.

### Known limits

- The SUPRT-A items and variable names and the DHCS settlement layout were built from published summaries; the
  official SUPRT handbook and the DHCS reporting form could not be read from the build environment. Both exports
  say "check against the current handbook / form", and should be checked before a program relies on them.
- On a device (SUDS on this device, or a phone's copy), the publication release check still runs on the page's
  own thread (ADR-0009); the office server runs it in a worker.

## 1.13.0 — 2026-09-26

- A request that reaches the on-device database after it has locked (sign-out, idle, or a report still running) is answered as signed out and sends the person to sign-in, instead of logging an error.

### Frontline

From a second hands-on frontline review of 1.12.4.

- **A consent that backs a referral, from the referral.** When no live consent names the provider, the
  referral form offers **Record a consent naming <provider>**: the consent form opens filled in for it (a Part
  2 consent to disclose, the provider as recipient, "Referral and care coordination", and what the program's
  usual consent covers and when it expires), and on saving the worker is back in the referral with the new
  consent chosen. It used to open on the TPO class wording, which names nobody, so the referral was refused and
  the worker had to leave it and start again. Home's **Finish setting up** asks an administrator to save the
  program's usual consent naming its referral partners (filled in from the directory).
- **Small counts of people on Home and Reports for finance and read-only.** Those accounts run the funder
  report as publication releases only, yet the dashboard, monthly trends and outcome measures showed them exact
  small counts for any range. They now see a count of people from 1 to 10 as "<11" (the report's threshold),
  and a mean or rate over fewer people not at all; visits, calls, kits, hours and money stay exact. **Visits by
  worker** is shown only to supervisors and administrators. Consents expiring (client codes, recipients) are for
  roles that work with consents. Display-level consistency for insiders (docs/HIPAA.md), in
  `server/dashboard-mask.js`.
- **Client tabs in working order:** Overview, Visits, Notes, To-dos, Consents, Referrals, then the rest, on
  every width; Overview is no longer moved after Forms when the strip overflows. The tab is called **Consents**.
- **Referral list:** the client's name for roles that can open the client; **Consent on file** only when a live
  Part 2 consent names the provider, otherwise **No Part 2 consent** (was "ROI ✓" for any consent); **+ Referral**.
- **Finish setting up** also asks for a **default fund** when none is set, and for **the opioid-settlement
  category** of each settlement fund the settlement report would list as *Uncategorised*.
- **Wording:** "visit(s)" for the remaining "intervention(s)" (the Visits page count, Delete visit, imports'
  "Also log a visit"); **Program** for "Programme" in the screens and the user guide (code and setting keys
  unchanged); proper labels for coded choices ("Court or Probation", "Declined by Client", "Detox / Withdrawal
  Management", "Screening (SBIRT)", …) from `CODE_LABELS` in server/constants.js; badges wrap between words,
  never inside one, and stay on one line in a table on a wide screen.
- **Field defaults and small fixes:** a new Location, **Street / Outdoor**, is where a harm-reduction
  program's visits and overdose events start (the office for a treatment-adjacent one); the overdose *Where*
  never offers Phone or Telehealth; an overdose saved with *Doses given* empty no longer fails with a server
  error, and the confirmation says what was recorded; the client picker lists nobody until something is typed
  and closes when someone is chosen or focus moves on (a late answer no longer reopens it); either part of a
  double surname finds the client (*Vasquez* finds *Quintero-Vasquez*: each part's blind-index tokens are kept
  in `name_phonetic_idx`, no schema change, and existing clients are re-indexed once at start-up); a device copy
  no longer says "Also signed in on another computer … stays in sync"; the two-step verification bar, once
  dismissed, becomes a small **🔐 2-step** link in the header on every device instead of a 50 px bar.

### Funder reporting

- **The submission to your funder comes first.** A supervisor's or an administrator's funder report, NDP log
  and settlement report now open as the programme's own *Submission to your funder — not for publication*, with
  exact counts (what a funder asks for; *Small cells suppressed* is a choice). 1.12.4 opened a publication
  release whenever the period could be one, so the first click was often a refusal or a blank headline.
  Publication is an explicit step, **Prepare a publication release**, which lists anything withheld with the
  reason and asks for the review confirmation before a file is exported. Finance and read-only accounts, which
  run publication releases only, are told so and shown the release. The page says first, prominently, which kind
  of run it is; the notice above the figures is two plain lines, with the full counting statement behind *Why
  some numbers are hidden*. On Reports, *Kind of file* beside the NDP log and the settlement report offers the
  same three. **API:** with no `purpose`, a `reports:internal` role now gets `purpose=submission` (and
  `counts=exact` where it holds `reports:exact`; `counts=suppressed` turns it off); ask for
  `purpose=publication` to get a release. `suppression.label` names the kind of run.
- **Ordinary quarters publish again.** 1.12.4 refused the publication release of most quarters of 60 to 100
  people (the reviewer's simulation: 7 of 8 at 60, 6 of 8 at 80) and the fiscal year. The cause was the race
  codes: a code hidden beside a small one was hidden only when it pinned it, which said the small one was at
  least 2, and the check rightly refused. That hiding is now decided from the printout alone. The same
  simulation now publishes every quarter and month of 40 to 200 people with the headline shown and nothing
  withheld (docs/HIPAA.md has the table). The algorithm-aware attacker has a complete race-code family; it found
  a leak 1.12.4 published at a threshold of 3, and none now.
- **Degrade, don't refuse.** A table the check cannot show protected is withheld (listed, with a short reason, in
  `release.withheld_reasons` and on the page) and the rest is checked again and published; the release is refused
  only when even people served cannot be shown safely, when the degraded release fails too, or when the audit
  reaches its budget. A degraded release is checked against worlds that would have been degraded the same way.
- **The headline is never hidden beside figures that bound it.** When people served is hidden, new admissions
  and episodes opened are hidden with it (a 13-person programme printed served `suppressed` beside 13 new
  admissions).
- **Deterministic, and off the main thread.** The audit's budget is counted in solver work, not seconds, so the
  same figures give the same answer on an idle or a busy server (a 60-second backstop remains, logged). It runs in
  a worker thread: during a 5,000-person year's release the event loop is held about 120 ms (the read), not
  640 ms. The browser kernel runs it inline.
- **Reports dashboard.** A fiscal year's dashboard at 20,000 clients let the event loop go only at the end (0.7 to
  1.0 s held); it now yields after each query (about 0.18 s at most).
- **Docs.** docs/architecture/ADR-0009-publication-release.md records the design, its tests, its known limits and
  the pending independent statistical review.

### Engineering

- **Liveness and readiness probes.** `GET /api/health/live` (the process is up and its database answers) and
  `GET /api/health/ready` (database open, at this build's schema, no restore in progress) are new, and are
  what the Dockerfile `HEALTHCHECK` and the new `docker-compose.yml` healthcheck call. `/api/health` is
  unchanged but is for alerting only: it answers 503 for warnings a restart cannot fix (a certificate near
  expiry, a failed backup), so as a liveness probe it restart-looped SUDS. **Administrators:** point
  Kubernetes/ECS/load-balancer probes at the new endpoints (DEPLOYMENT.md, 4b). New routes, no migration.
- **Release policy enforced.** The release gate refuses a patch release that adds a schema migration, a
  permission or a route, unless the release is run with `allow_patch_changes` (the reason is printed at the top
  of the release notes). RELEASE.md records that 1.12.0–1.12.4 broke the cadence policy.
- **Tests.** Timing-dependent tests use condition waits and bounds relative to the machine; pure performance
  checks moved to `test/thorough/`, run by the `thorough` CI job (`npm run test:thorough`) instead of
  `npm test`. Migrations are now also tested from databases written by 1.9.4 and 1.11.0 (records present,
  ciphertext decrypts, audit chain verifies). A new test runs the browser kernel under sql.js in Node and
  requires the same answers as the office server for sign-up, client, visit, note, consent, referral and the
  funder report. It found a device defect, now fixed: a background save that landed while the funder report
  was running on a device (sql.js's export drops temporary tables) failed the report with "Something went
  wrong on this device"; saves now wait for the report to finish.
- **CI.** The Node 24 job installs a pinned version checked against a pinned SHA-256 (RELEASE.md says how to
  bump it). The WebKit job reports two service-worker cache checks that Playwright's WebKit on Linux cannot
  reproduce as skipped, with their diagnostics; iPhone offline-after-update is on the real-device checklist.
- **Docs.** The architecture overview describes the code after 1.12.4; RELEASE.md gives the browser suite's
  real size (31 scripts).

### Security

Fixes from the security review of 1.12.4.

- **Two-step enrolment can no longer be used to guess an existing code (high).** `POST /api/auth/mfa/enable`
  checked only that a user was attached to the session: someone with the password alone could skip
  `/mfa/verify` and its rate limit, guess the account's code there without limit or audit, and a right guess
  finished the sign-in. Enrolment is now only for a fully signed-in session of an account without two-step
  verification (forced enrolment after the grace period still works), shares the 10-per-10-minutes limit,
  is audited (`auth.mfa.enable.failed`), and every wrong code — at sign-in, enrolment or signing — counts
  toward the account lockout; for an account with two-step verification only the second factor clears it.
- **readonly (the default role for an unmapped SCIM user) can no longer open clients' filled forms (high).**
  `forms:read` is now the form library only; a client's forms, their PDFs and attachments need `clients:read`
  and the client on the caseload, and no single-client check passes for a role without `clients:read`
  except where the answer is keyed by client code only (finance's expenditures and time). A new test hits
  every GET route as finance and readonly with real ids and fails on any identifier. `scim_default_role`
  stays readonly, which can now be shown to identify nobody.
- **FHIR search no longer says whether an unconsented person is a client (medium).** Pages are drawn from
  consent-covered resources only, and a patient-type search with `_count=0` never has a `next` link.
- **A record with no client is its owner's (medium).** Unlinked calls (a crisis caller's name, number and
  words), outreach visits, community overdose reports, to-dos, time entries and expenditures were readable by
  every caseload-restricted worker, over the API and by sync. They are now visible to, and changeable by, the
  worker who recorded (or is assigned) them and roles with `clients:all` (`time:all`, `budget:approve`), the
  same over REST, sync pull and sync push.
- **SUDS on this device carries a Content-Security-Policy and a frame guard; `connect-src` is `'self'`
  (medium).** The static build had no CSP and could be framed; every page now has the office server's policy
  as a `<meta>` and `frame-guard.js` first. The office server's `connect-src` drops `https:` (every outside
  fetch is the server's). Local-mode sync defaults to the page's own origin; on a device a picture can be
  added from an address on this site only.
- **Sync sends only what the role could read (low).** Expenditures need `budget:read`; fund and budget-line
  amounts and grant details are left out for devices without it.
- **File names and document references are encrypted (low, migration 42).** A form attachment's and an
  import's file name and a consent's document reference move to `filename_enc` / `document_ref_enc`.
- **The key backup needs recent re-authentication.** `POST /api/admin/keys-backup` (was `GET`) asks for the
  password or authenticator code again, or a confirmation within the signing window, and is audited with the
  method; failures as `keys.download.failed`.
- **The shared OneNote notebook is for supervisors and administrators.** Browsing and fetching it needs the new
  `graph:import` permission; others import what they upload themselves.
- **The intake duplicate check no longer reveals clients on other caseloads.** It used to count them
  (`hidden_duplicates`) and refuse the intake. Now the worker's answer is the same as for no match, the intake
  goes ahead, and a supervisor gets a review task on the existing record. Visible matches and re-admission of
  a discharged record are unchanged; a device's warning names only records its user may open.
- **Outbound requests connect to the address that was checked.** The SSRF guard resolved and checked a name,
  then let `fetch()` resolve it again (DNS rebinding). Without a proxy the connection is now pinned to the
  checked address (Host and TLS name unchanged); a name that cannot be resolved is refused unless a proxy is
  really in use (`HTTPS_PROXY` *and* `NODE_USE_ENV_PROXY=1`), and then only for `ENOTFOUND`/`EAI_AGAIN`.
- **Purpose-separated subkeys.** New uses of `SUDS_INDEX_KEY` get an HKDF-SHA256 subkey (`crypto.subkey`); the
  single sign-on state cookie is the first. The audit chain and blind indexes keep the index key
  (docs/security/ENCRYPTION-AND-KEYS.md).
- **Audit anchors hourly by default (`AUDIT_ANCHOR_HOURS`, was 6).** Entries written after the newest anchor
  are what someone holding the database and the index key could delete undetected; the window is now
  documented (docs/security/LOGGING-AND-AUDIT.md). A year of hourly anchors is about 4 MB; writing one takes
  ~0.1 s and a full verification ~0.2 s.
- **A court order's and a registered agreement's document reference are encrypted (migration 43)**, as a consent's was: `document_ref` ("court order, J. Smith case file") moves to `document_ref_enc`; the API field keeps its name, and older kernels' pushes are mapped (sync-tables legacy).

## 1.12.4 — 2026-09-26

- **The first user is "guest".** A new office server creates its first administrator as `guest`
  (`SUDS_ADMIN_USERNAME` still names another); its password stays random per install, printed once and
  changed at the first sign-in, so no working credential is shared between installs. The setup wizard and the
  on-device first-account form suggest `guest`; the person chooses the password.
- `npm test` runs a sample of the publication-release disclosure sweeps; the full sweeps (`SUDS_THOROUGH=1`)
  run in a new CI job, `thorough`, which the release gate requires.

- **The pattern of what a publication release hides no longer gives counts away to someone who knows the
  method.** SUDS is open source, so an attacker can run the audit on every programme that could lie behind a
  printout and keep those that print the same. Against 1.12.3 that worked: 12 served beside "on MAT <11"
  was printed only when one person was on MAT (two or more hid the total), events 12 beside reversals "<11"
  meant one reversal, and a withheld table said the total was not 1, or that everyone served was on MAT.
  The audit decided which unprinted counts to protect, and which cell to hide first, from true values it
  does not print. Now:
  - whether a count must be protected is decided from its feasible range given what would be printed, never
    from its true value, and the cells hidden to protect it are taken in a fixed structural order;
  - a total whose every part is "<T" is hidden by the symbols alone, with the counts of at least T under it;
  - every cell a release hides is checked against the method: SUDS finds worlds with the same printed
    figures, runs them through the same suppression, and keeps those that print the identical release; the
    cell must be shown by those worlds able to be 1 and to range over half the threshold, or the release is
    refused. Against the printout alone the audit still asks for 1 and T-1, as near them as the printout's
    symbols allow (served "<11" beside women and men "<11" says there are at most 9 women whatever else is
    printed).
  A new test enumerates every world of small families (people served and a subset up to 25 people, women
  and men and MAT, overdose events and reversals in one and two months, two funds; thresholds 3, 5 and 11),
  runs the real release on each and checks every hidden cell over the worlds that print the same; it finds
  the reviewer's cases in 1.12.3 and nothing in this version. The price: a small programme at a small
  threshold is refused more often (publish a longer period); a 5,000-person year is still published: read, audited
  and checked in 0.6 to 1 s (0.15 s before the check). What the check does not prove, and what it leaves to the tests, is in
  docs/HIPAA.md ("The pattern of what is hidden" and the residual risks).
- **Publication releases are labelled for what they are.** "Suitable for publication" is gone: a release is
  *Publication release — small cells screened; review before sharing* on screen, in its counting statement,
  on its files' About sheet and in their filenames (`…-publication-screened-review-before-sharing`). Its
  files download only after the person ticks *I have reviewed the withheld and small figures before sharing*;
  the API needs `reviewed=1` on a publication release's export (428 otherwise) and writes
  `report.publication.reviewed` to the audit log with the report, the period and the release id. Internal and
  submission files are unchanged, and the `X-SUDS-Report-Purpose` header still says `publication`.
- docs/HIPAA.md states that any deterministic suppression pattern can leak to an attacker who knows the
  method, what this version does about it, what remains, and that the method is a conservative default, not
  an expert determination (45 CFR 164.514(b)(1)). docs/market/EVALUATION-RESPONSE.md is brought up to date
  through this version: the release gate, the instance lock, device encryption, and the published small-cell
  counts as open pending an independent statistical review.

## 1.12.3 — 2026-09-26

- **Which rows a publication release lists no longer gives anything away.** An independent attack on 1.12.2
  read the rows themselves: the NDP log listed only the months with a reversal, and the funder report only
  the months, discharge reasons and "given by" codes that were used, so ten rows marked `withheld` beside
  "staff <11" meant exactly one reversal a month. A publication release now lists every month of the period
  and every code of those lists, zero or not, in a fixed order (never by size, which told which hidden cell
  was larger), and a table withheld whole prints no rows. Episodes opened, closed and open at the end, and
  the naloxone doses used (every reversal records one to twenty), are now part of the audit, so they can no
  longer narrow a hidden count; doses are hidden with the reversals they would reveal. Closing an episode
  before the day it opened is refused.
- **A release the audit cannot verify is refused, not published.** Every hidden count is checked again when
  the audit stops; if any is still exposed, or the audit runs past 5 s, the three reports answer that the
  period cannot be published (internal runs are unaffected). The audited release is shared by the three
  reports, and rare typed-in values beyond the first ten per breakdown are combined as "Other (combined)":
  800 one-person languages audit in milliseconds instead of 20 s per report.
- The funder report, the Reports page and every publication file's About sheet say what to do before sharing
  a release: publish each period once and never nested or overlapping periods, review what is withheld, and
  treat the suppression as a conservative default, not an expert determination.
- docs/HIPAA.md no longer says read-only accounts hold `export:read` or that the monthly trends report is
  not audited.

## 1.12.2 — 2026-09-26

- **A publication release is audited as a whole.** An independent check of 1.12.1 still recovered hidden
  counts: the settlement report printed a total the funder report had hidden, and a month's reversals (never
  more than its overdose events) pinned a hidden cell. Protecting table by table kept missing links. Now a
  period's funder report, naloxone log and settlement report form one release, computed from one reading of
  the data. Every number the three print goes into one set of constraints (breakdowns add up, subsets and
  reversals are bounded, a settlement use lies between its funds). An exact integer solver (`server/sdc.js`,
  no dependencies) then checks how far each hidden cell could still range. Cells are hidden until none can be
  narrowed below the protection rule, or the table is withheld. A separately written attacker, searching all
  three reports of 250 random programmes, cannot pin a hidden cell. A year for 5,000 clients audits in about
  0.15 s. The price: a small programme sees more cells hidden and some sparse tables withheld.
- **Who the suppression protects is stated plainly** (docs/HIPAA.md): the recipients of a published release.
  Staff with reporting or export access can already see de-identified rows and exact figures; permissions and
  the audit log govern them. As defence in depth, internal and submission runs now need `reports:internal`
  (supervisors and administrators; navigators and clinicians for their own caseload). Read-only and finance
  accounts get publication releases, with money and hours exact. The monthly trends report is now audited.
- A navigator's caseload report counted overdoses and people per fund for the whole programme; it now counts
  the caseload only, and says so.
- "Back up now" reports why a backup failed instead of answering with a server error.
- On a device restored from a backup, an account dropped at the key change is told what happened and who can
  let it back in; the device audit names the accounts dropped.
- The multitab browser test now waits until the first window is really frozen before a second one takes
  over; an idle window never stopped at the debugger's pause, so that case sometimes tested nothing and then
  failed when it tried to resume.

## 1.12.1 — 2026-09-26

- **Small cells: publication releases that hold up.** Two leaks in 1.12.0's "suitable for publication" counts
  are closed. (1) Differencing across reports: a run filtered to one fund, or for a custom range, could be
  subtracted from the whole-programme report to reveal a small group. Only the whole programme, for one
  calendar month, quarter or year (starting January, April, July or October) that has ended, is now a
  publication release; every other run is *internal, not for publication* and asking to label it for
  publication is refused. (2) Within one report the total was hidden too late: a complete breakdown still
  printed it. Tables sharing a total are now protected together to a fixpoint, keeping the total visible
  when hiding more cells is enough, and the attacker is assumed to know that a `suppressed` cell is at least
  the threshold. Published, the NDP log is by month and matches the funder report's reversals; "Who gave the
  naloxone" counts reversals. Cross-period differencing (a quarter and its year) remains a documented
  residual risk (docs/HIPAA.md, *Small cells in aggregate reports*).
- **Restore and backups share one lock.** A restore while a scheduled backup, snapshot or recovery drill was
  running swapped the database, then failed to record the new sync generation and the restore's audit anchor
  (and the concurrent backup was written damaged). Backup, snapshot, drill, offsite copy and restore now take
  turns; a restore waits up to two minutes, then says what is running; after the swap the generation and the
  anchor are written or the previous database is put back.
- **Sync pages the history of newly assigned clients.** Up to 1.12.0 it all rode on one page (one client with
  40,000 visits: 40,531 rows, 25 MB); it now follows in pages within the limit, and older device builds keep
  working.
- **Instance lock tells containers apart.** Two containers with the same hostname (host networking, a fixed
  `hostname:`, a rescheduled pod) and the same process id are no longer taken for the same process: the lock
  also records the container's root filesystem and machine identity.
- **A restored device moves to a fresh key** the first time a backed-up account signs in, so the key inside
  the backup file no longer opens what the device records afterwards.
- **Sample data never has a time in the future.** "Today at 5 pm" was written before 5 pm, and such a record
  reached no device until its time came; the sync test that caught it failed now and then, depending on the
  time of day.

## 1.12.0 — 2026-09-26

Answers the critical evaluation. The owner chose to commit (its option B) and to reposition SUDS around
what it does best (option C): the operations system for harm-reduction and prevention programmes —
outreach, naloxone and supply distribution, and grant reporting — with Part 2-grade privacy. The clinical
modules stay, as options. Point-by-point response: `docs/market/EVALUATION-RESPONSE.md`.

- **Programme profile.** "Harm reduction & outreach" (new installs) or "Treatment-adjacent" (an upgraded
  database that holds any clinical record keeps everything visible). Care plan, assessments, CalOMS Tx, the
  FHIR API and the EHR hand-off can each be switched on or off in Settings › Programme; an off module refuses
  new work on the server and the FHIR API closes. Records already made stay readable.
- **Front-line screens.** Navigators and clinicians get a ten-item menu; programme pages sit in a Programme
  section for the roles that run it. One word per concept: Visit, To-do. On a phone the client page puts its
  actions under one "Add…" button and shows five tabs. Settings folds into sections; Reports groups its exports.
- **Notes and supervision.** "Save & sign" in the note editor; within 10 minutes of signing in (a setting)
  signing needs only a confirmation, otherwise the password or authenticator code. Supervisors see client
  names they may already open, rows open the record, and several notes can be countersigned at once.
- **Consent and referral.** A referral pre-selects the one live consent that names the provider; a duplicate
  consent is flagged; a programme can save its usual consent as a template.
- **Grant reporting.** The funder report runs about ten times faster (4.9 s to under 0.5 s at 20,000
  clients) and no longer stalls the server. Small cells are suppressed by default; the programme's own
  submission may use exact counts (`reports:exact`). Visits take the worker's or programme's default fund;
  unfunded visits and logged-but-unapproved hours are shown with warnings. New: a naloxone distribution and
  reversal log in the shape of the DHCS Naloxone Distribution Project's reporting, and opioid settlement
  spending by allowable-use and High Impact Abatement Activity category — both marked for checking against
  the current templates (`docs/compliance/HARM-REDUCTION-REPORTING.md`).
- **On-device records are encrypted at rest.** The device database and its field keys are sealed with
  AES-256-GCM under a key each device account's password unlocks (PBKDF2, 600,000 iterations); the app is
  locked after every reload until someone signs in; existing devices are sealed at the next sign-in and the
  plain copies erased. A forgotten password on a standalone device is unrecoverable without another account
  or a backup, and the app says so (`docs/architecture/ADR-0008-device-encryption.md`).
- **Release gate and recovery evidence.** A release is refused unless CI — tests, Node 24, the full browser
  suite and a backup-and-restore drill — passed on that exact commit. CI restores a 20,000-client backup
  into a fresh server on every push; a development-environment drill report is in `docs/evidence/`.
- **Reliability.** The instance lock no longer refuses to start after a crash when the server is process 1
  (Docker) or after a reboot; scheduled backups no longer block the server (longest pause 16 ms on a 311 MB
  database); a missing index is rebuilt or reported; a browser window frozen in the middle of a save can no
  longer hang another window that takes over. The browser job that failed on 1.11.0's main-branch CI was the
  multitab script unable to fetch the 1.9.0 build in a shallow clone; it now fetches that release's tag, and
  the suite repeats each failed script's last lines at the end of its log.
- **Security.** Two sync leaks closed (staged imports went to every device; ending an assignment never left
  the device) and a newly assigned client now arrives with its whole history; one guard for every outbound
  fetch (region pictures, OIDC, FHIR JWKS) closes an IPv4-mapped-IPv6 bypass; the service worker never caches
  FHIR or SCIM; download names with non-Latin characters no longer fail; HSTS behind a TLS proxy; a consent's
  witness and imported name hints are encrypted; new accounts have 3 days, not 14, to set up two-step
  verification; a later device sign-up cannot make itself administrator.
- **Honest documents.** Pitch rewritten around harm reduction; the software is MIT-licensed and free, paid
  offers are services priced as unvalidated hypotheses; a realistic business-hours support template; a
  hosting model saying who is called at 2am (`docs/market/HOSTING.md`); unmeasured time savings turned into
  a pilot measurement plan; development described as AI-assisted with automated gates. Architecture decision
  records for a new maintainer in `docs/architecture/`; feature releases at most monthly.
- **Found by an independent re-evaluation before release, and fixed:**
  - The instance lock records the host and the holder refreshes it every 10 s: a second replica or a second
    host on shared storage is refused while the holder lives (a crashed one is taken over after 45 s), and the
    same container restarting after a crash is let straight in.
  - A funder report filtered to one fund showed the whole programme's staff hours and unfunded counts.
  - Counts "suitable for publication" now hide every small count of people in every table — per fund,
    overdoses by month, the naloxone log, the settlement report — with complementary suppression so no hidden
    cell can be worked out from a total; kits, doses, services, hours and money stay exact.
  - A reversal is always counted as naloxone used, and its location uses the same list as distribution.
  - Wrong signature passwords count toward account lockout; an authenticator code is accepted once; staff who
    sign in through the county's single sign-on can confirm a signature with it.
  - Batch countersign takes a comment per note and refuses one comment across different clients.
  - Completing the setup wizard on the same computer no longer loops and rate-limits the first sign-in.
  - Harm-reduction wording on sign-in and the tour; flag labels instead of codes; a one-line two-step banner
    on phones; the wizard recommends offline copies for outreach programmes and can create the main fund.
- Schema migrations 38 (default funds, settlement categories), 39 (witness and import hints encrypted),
  40 (recent re-authentication), 41 (single-use authenticator codes).

## 1.11.0 — 2026-09-25

Answers the California county marketability review: SUDS as the operations system for grant-funded,
non-billing prevention, harm-reduction and outreach programmes, beside the county EHR. Market pack in
`docs/market/README.md` (positioning, buyer guides, pilot kit, procurement, readiness scorecard, draft
BAA/QSOA, DPA, SLA and pricing for counsel review).

- **42 CFR Part 2 (2024 final rule)** — control matrix in `docs/compliance/PART2.md`.
  - Consents record every §2.31 element (who may disclose, signer, right to revoke, consequences of refusing)
    and print as a PDF; a single consent for treatment, payment and operations; separate consents for SUD
    counseling notes and for legal proceedings. A general ROI is no longer accepted as Part 2 consent in a Part 2
    programme (`part2_program`, on by default).
  - Disclosures under a court order need a recorded, qualifying subpart E order; information for a proceeding
    against the client needs one (or a proceedings-only consent); counseling notes need their own consent;
    agreed restrictions must be confirmed before sharing. Identified exports state their lawful basis.
  - One 2024 §2.32 notice travels with every disclosure: referrals, exports (Excel About sheet, CSV last row,
    header), form and consent PDFs, printed accounting and notes, FHIR responses, the CalOMS extract and the
    county EHR hand-off. Client records carry a "42 CFR Part 2" label.
  - Privacy & Part 2 page: the §2.22 patient notice (editable, versioned, recorded per client, Home reminder), a
    §2.4 complaint log, and an incident/breach register with the 60-day, HHS and media notification clock. A
    failed audit check, audit anchors that no longer match, a flagged emergency access, or a very large
    identified export open a draft incident. An incident keeps its own snapshot of the clients affected, and
    its title is encrypted.
  - A consent covers a disclosure only when it names that recipient; a disclosure under any other basis (a
    qualified service organisation, research, audit or evaluation) needs an agreement on file in the new
    Agreements register. The §2.31 elements are checked again at the moment of disclosure and on consents that
    arrive by sync, not only in the form. Turning `part2_program` off needs a recorded reason.
  - Changing a referral's agency re-checks the consent against the new agency and accounts it; a referral
    pushed from a device (a new warm hand-off, one progressed offline, a new agency) passes the same gate.
  - De-identified exports now meet HIPAA Safe Harbor: dates to the year, ages over 89 as `90+`, restricted
    three-digit ZIP areas as `000`, coded values only (free text never leaves), and record ids drawn at random
    for each export. A client's discharge reason is chosen from a list. Row-level exports and most aggregate
    reports do not suppress small cells, and the docs say so.
- **County IT evidence** — `docs/security/` (architecture, encryption and keys, identity, audit, backup and DR,
  data lifecycle, vulnerability management, SDLC, incident response, SOC 2 readiness mapping, pre-answered
  questionnaire, pen-test scope). SUDS holds no SOC 2/ISO/HITRUST attestation and says so.
  - Recovery drill (`npm run dr-drill`, or Settings → System & backups): restores the newest backup into a
    temporary copy, never the live database, checks it end to end including a two-step sign-in, measures RTO and
    RPO against targets and writes a signed report; optional monthly schedule.
  - Audit anchors: the audit chain's head is sealed to `AUDIT_ANCHOR_DIR` (point it at write-once storage;
    optionally syslog) every 6 hours, at every backup and after a restore, so a rewrite of the whole log by a key holder is
    detected. Two anchors in the same millisecond no longer collide (one was silently dropped).
  - Auditor export of the audit log with a signed manifest, verifiable offline (`npm run verify-audit-export`).
  - "Require single sign-on" with named break-glass administrators; "Require two-step verification for every
    role"; a report of accounts without it. Settings → Security status: a read-only page for IT reviewers.
  - The audit log is append-only in the database itself: triggers refuse UPDATE and DELETE outside the
    retention purge. In production, anchors on the data disk are reported as a failure. Drill reports and audit
    exports are signed with Ed25519.
  - The drill can prove the escrowed keys (`--keys-file`) and restore from the offsite copy; stale drill copies
    are swept at startup. Snapshots every few minutes (`backup_schedule_minutes`); a warning when backups are off.
  - Audit retention cannot be set below six years (a lower setting is raised and reported). Reasons typed
    when deleting, merging, holding or reopening a record, or vacating a court order, are stored encrypted and
    kept out of the audit log; so are addendum and revocation reasons, countersignature and reviewer notes,
    transfer notes, time and expenditure descriptions, form notes and safe-contact notes.
  - Identity: trust the identity provider's MFA claim (opt-in; `mfa`, two factors of different kinds, or a
    configured `acr` — a lone one-time code is not enough), deprovision accounts not seen at the IdP for N
    days, and SCIM 2.0 user provisioning at `/scim/v2`. SAML is not supported (OIDC only).
  - Hardened Docker image, compose file and systemd unit; deployment guidance for county VMs, Azure Government /
    AWS GovCloud tenants and a warm standby.
- **Clinical depth (CalAIM documentation redesign)** — `docs/compliance/CALAIM.md`.
  - Problem list with optional ICD-10-CM and social-determinant Z codes, full change history; notes record the
    problems they address.
  - Care coordination plan: goals in the client's words, review dates with an overdue alert, steps that can
    create to-dos; printable.
  - ASAM-aligned six-dimension ratings (not an ASAM-endorsed instrument) with recommended vs referred level of care.
  - PHQ-9, GAD-7, AUDIT-C, DAST-10 (optional, off by default until the county confirms its licence) and a
    wellbeing rating, scored automatically with trends; PHQ-9 item 9 above
    zero raises a safety alert. Reports → Outcome measures with a de-identified export.
  - New permissions `careplan:*` and `assessments:*`; assessments sync only to roles that can read them.
  - No eMAR, e-prescribing or claims (out of scope).
- **CalOMS Tx and the billing boundary** — `docs/compliance/CALOMS.md`, `docs/SCOPE.md`.
  - Admission, discharge and annual-update records per episode (off by default; Reports → State reporting),
    DHCS-style edit checks with a validation report, and an extract with the monthly provider activity report;
    records with fatal errors are held back. The preview names nobody and cannot be submitted; "Produce submission
    file" builds the file once, keeps it encrypted with its hash, accounts each client in it as a state-reporting
    disclosure and serves exactly those bytes again. **The
    code sets and layout are not yet verified against the current DHCS data dictionary** (the spec could not be
    fetched); verify before a county submits.
  - County EHR hand-off: encounters per client per day for entry into SmartCare or billing, identified and
    accounted; a file-wide basis is a consent, QSOA or internal, never "other". SUDS does not submit Drug Medi-Cal (837/Short-Doyle) claims.
- **FHIR R4** — `docs/integration/FHIR.md`. A read-only API at `/fhir/R4` (Patient, EpisodeOfCare, Encounter,
  Consent, ServiceRequest, Task, Observation, DocumentReference metadata, the resource directory) with Bulk Data
  `$export`, SMART Backend Services sign-in (private_key_jwt, RS384/ES384) or a client secret usable only at the
  token endpoint, scopes and rate limits (Settings → FHIR clients). Bulk output is encrypted at rest, re-checked
  against consent at download and accounted at first download; export jobs survive a restart. Resources
  validate against US Core. A consent records the categories of information it covers, and FHIR serves only
  those; an existing consent covers everything over FHIR only when its wording plainly says so. The no-redisclosure label is now `NORDSCLCD` (HL7 retired `NORDSLCD`). A client's records are
  returned only under a live Part 2 consent naming the organisation for its purpose; counseling notes and
  restricted clients are never served; a search for one person never reveals whether they were withheld; every
  client disclosed gets an accounting row.
- **Accessibility (WCAG 2.1 AA)** — `docs/accessibility/ACR-WCAG21.md` (VPAT 2.5), `STATEMENT.md`, and an
  accessibility statement page linked from sign-in and the menu.
  - `scripts/ui/accessibility.mjs` (axe-core, test-only) audits every page, client tab, Settings tab and about
    60 dialogs for all roles on both builds, at desktop and phone widths, light and dark, and 200% text, plus
    keyboard-only walkthroughs; it runs in the browser suite and CI and fails on any finding.
  - Every page has its own title; focus goes to the new page's heading; dialogs make the page behind them inert;
    tabs are navigation with the current section marked; colour is never the only cue; dark-theme contrast,
    3:1 field borders and a clear focus ring; reflow at 320 px and 200% text; the idle warning has "Stay signed
    in"; Home's refresh can be turned off.
  - The conformance report says how each criterion was evaluated; 4.1.2 and 4.1.3 are "Partially Supports"
    until screen-reader testing is done. Scrolling tables keep a tab stop at 200% text.
  - Remaining partials are stated: untagged generated PDFs, uncaptioned pictures, the administrator's maximum
    session length, and screen-reader testing still to do.
- **Security fixes found along the way:** an intake API key must now carry the intake scope (any key could stage
  notes before).
- **Market documents say only what is true:** claims qualified throughout `docs/market/` and `docs/security/`.
- Reference lists (funding types and the like) no longer go empty for a moment while they reload.
- Schema migrations 29 (clinical depth), 30 (CalOMS), 31 (Part 2), 32 (FHIR sign-in), 33 (append-only audit and
  identity), 34 (disclosure gate), 35 (consent categories, CalOMS submissions), 36 and 37 (typed text encrypted).

## 1.10.2 — 2026-09-25

- **Pictures without the file window.** A resource's Pictures card has **Add from a web address** (an https
  address of a picture, or of a web page whose preview picture is used), and picture files can be dragged onto
  the card or pasted on the page. The office server downloads the address with the same checks as provider
  pictures and records only the site name in the audit log; on SUDS on this device the browser fetches it and
  explains when a site does not allow that. New route `POST /api/resources/:id/photos/from-url`
  (resources:write). **+ Add pictures** is unchanged.
- **Downloads refuse names that point inside the county network.** Provider pictures and "Add from a web
  address" now resolve each address (every redirect hop) before connecting and refuse loopback, private,
  link-local and similar addresses; before, only the name was checked, so a public-looking name that resolved
  to an internal server was fetched.
- **QA round 4 (what an automated tester reading the accessibility tree reported on 1.10.1).**
  - Home's numbers and bars link only to pages the viewer may open; a read-only account no longer lands on
    "Not available for your role".
  - The client header's badges are a list, and the status reads "Status: Inactive" to a screen reader instead
    of running into the risk badge.
  - A dialog no longer copies its title into the page's live region (a second "Add resource" / "New task" in
    the accessibility tree).
  - The Home empty-state sentence is under 100 characters (a tool that cuts text at 100 read "…or compute").
  - Sample data has a read-only account (`rreader`); new browser script `a11y-round4`.

## 1.10.1 — 2026-09-25

- **Signing out no longer draws the sign-in page twice.** The second draw blanked the screen for a moment (or,
  on a slow device, showed two sign-in forms); it is also what made the local-mode browser check fail
  intermittently in CI, where the click landed on the screen-reader status region during the blank. Full-screen
  pages (sign-in, set-up, MFA) are now built first and swapped in whole, and only the latest render wins.
  The same screen already showing is kept rather than replaced, so a re-render never throws away what was
  being typed into the sign-in form.
- **QA retest fixes (reproduced on the published build, as the tester uses it).**
  - SUDS on this device: supply items can be added and counted again — it has no office, so it no longer
    refuses supply changes with "kept at the office". On a device that syncs with an office, the Supplies
    buttons are disabled with the reason shown, and save errors also appear as a toast.
  - `#/getapp`, `#/phone`, `#/app` and `#/install` open "Use SUDS on your phone or tablet"; `#/devices` opens
    This device (on the office server, Settings › Synced devices for administrators).
  - Home and the welcome tour greet people by their whole display name, not its first word.
  - Date fields accept years 1900–2100, so Chrome's year box takes four digits, and a garbled date such as
    0006-09-05 is refused with a message instead of saved. Each date field has its own calendar button.
    Toasts no longer take taps or clicks meant for the page or dialog under them (a "saved" toast could sit
    over a dialog's date field).
  - "+ Add pictures" says a file window has opened (and when none was chosen). The import drop zones can be
    used from the keyboard and by screen readers.
  - Settings: new **Organisation time zone**, which overrides `ORG_TIMEZONE` for visit dates, report periods
    and "today", is sent to synced devices, and defaults to the browser's zone on SUDS on this device. Device
    copies no longer show the server backup schedule (it read "every 0 hours / keep 0") and link to This
    device (backup and restore) and the phone/tablet page instead. The office backup schedule says whether it
    is on and links to System & backups.

## 1.10.0 — 2026-09-24

- **The GitHub Pages build is now SUDS on this device, a production web app — not a demo.** The
  "Demo/evaluation build" banner and its `--demo-banner-h` layout machinery are gone, and no screen calls it a
  demo or an evaluation copy. It keeps its records encrypted in the browser that holds them, never syncs, and
  says so honestly (`docs/WEB_APP.md`, *Where your records live*). "Try it with sample data" remains, folded
  away below the Sign up form, and sample data is now only offered to an empty device (as on an office
  server), never mixed in with real records.
- **Log in / Sign up on the sign-in page**, on both builds: a two-option tab list (arrow keys, 44px targets on
  a phone), deep-linkable as `#/login?mode=login|signup`, with the programme contact in the footer.
  - *Office server:* Sign up requests an account (name, username, optional email, password, a line about the
    role). `POST /api/auth/signup` is unauthenticated, needs the CSRF header, is rate limited per address
    (`SIGNUP_RATE_LIMIT`, default 5/hour), answers the same whether or not the username exists, and is audited
    as `user.signup.requested`. The account cannot sign in until an administrator approves it under
    **Settings → Users & roles → Access requests (N)** (`POST /api/users/:id/approve` with the role and an
    optional supervisor, or `/decline`); the correct password on a pending account is told it is waiting,
    anything else gets the ordinary failure. The MFA grace period runs from approval. Home and the Users tab
    show administrators how many requests wait. New setting `self_signup` (on by default); off, Sign up says to
    ask an administrator and the route answers 403.
  - *On this device:* the first Sign up is the first-run set-up and makes that account the device's manager;
    later sign-ups create navigator accounts at once, and from the second account on everyone sees only their
    own caseload. The manager can turn sign-ups off (`/api/local/signup`, `/api/local/device`).
- **Safeguards for records that live only on a device.** First-run Sign up states once where records are kept
  and that clearing site data or losing the device loses them, and requires a checkbox. **This device** (the
  page formerly called Sync on this build) shows whether the browser has granted persistent storage
  (requested at account creation) and the last backup. **Download a backup** makes a passphrase-encrypted
  file (WebCrypto PBKDF2-SHA256, 600,000 iterations → AES-256-GCM; `local/backup.js`) holding the database and
  the keys that read it; **Restore from a backup** (also on an empty device's sign-in page) checks the
  passphrase and the file, shows what it holds, requires typing RESTORE, and writes the database under a newly
  claimed epoch (`local/shims/sqlite.js` `replaceWith`). Home reminds the device's manager after 7 days
  without a backup (dismissible for the day).
- **Settings:** `mfa_grace_days` is now on the form; `program_contact` is shown on the sign-in page; the unused
  `default_funding_source_id` is no longer accepted.
- Migration 25 adds `users.access_status`, `users.access_note` and `users.requested_at`. `access_note` is not
  sent to devices by sync.
- The browser suite gains `scripts/ui/signup.mjs`; `run-all.sh` takes `SUDS_UI_TMP` and `SETUP_BOOT_PORT` so two
  suites can run side by side. Docs: `WEB_APP.md` and `PLATFORM.md` rewritten for the two ways to run SUDS;
  README, INSTALL, HIPAA (risk register), DEPLOYMENT updated.
- **Completeness fixes.**
  - Local mode and SUDS on this device: "Everything as one Excel workbook" now works (no `setImmediate`; the
    zip falls back to synchronous compression).
  - A fatal overdose discharges the client as deceased after confirmation; changing the outcome or deleting
    the event restores the client, episode, care team and to-dos. Overdose events can be deleted.
  - Signed notes have **Verify signature** ("Signature intact" / "Changed after signing") and show the full
    hash on demand.
  - Finance no longer sees client links that lead to a 403; the client page says "Not available for your role".
  - Patient-rights requests can be edited and deleted from the client's Requests tab.
  - Reports: an Episodes of care card (admissions, discharges by reason) and single-table exports for
    episodes, overdose events, client forms and disclosures. `GET /api/episodes` returns period counts.
  - Discharge reasons, overdose options and request kinds come from the server's meta lists.
  - Supervision hides the note sections from roles that cannot countersign.
  - Imports: a staged item can only be discarded by the person who imported it, or a manager.
  - Docs: `API.md` regenerated; user guide updated.
- **Load-review fixes (2,000 clients, 64,000 records).**
  - Retention: the purge clock now runs from the last activity on a record (visits, calls, notes, referrals,
    to-dos, consents, disclosures, forms, overdose events, patient requests, time, expenditures, episodes,
    intake/discharge), not from the discharge date alone — a client discharged in 2018 but visited in 2024 is
    no longer purged in 2025. Records left inactive are now purged on the same clock (an unclosed episode does
    not exempt them); active and waitlisted records never are.
  - Search and duplicate detection work for names in any script and ignore accents: Arabic and Cyrillic names
    are searchable and flagged as duplicates, "Oster" finds "Øster", "Lecki" finds "Łecki". Migration 26
    rebuilds existing clients' name indexes.
  - Funder report: "people served" is one set per filter (visit or call in the period, deleted clients
    excluded, and only visits charged to the fund when a funding source is chosen), and every demographic
    breakdown and per-person count uses it.
  - Reports, the dashboard and exports treat from/to as calendar days in `ORG_TIMEZONE`: an evening visit on
    the last day of a fiscal year is in that year. A malformed date is refused.
  - With local mode off, device sync (pull, push, attachments) is refused with 403.
  - The daily audit-chain check is incremental and runs in batches that no longer freeze the server; the whole
    chain is still checked weekly and by the Verify button.
  - Outreach and community naloxone distribution can be recorded without a client; other types still require
    one, and the server enforces the same rule. Logging time on a visit with no client no longer fails.
  - Deactivating a user says how many clients and open to-dos are still assigned to them, and anyone who can
    manage assignments can move them to an active worker in the same step (audited as `caseload.transfer`).
    Move a caseload lists deactivated staff who still hold clients, marked "(inactive)", and Home warns
    supervisors when clients are assigned to inactive staff. New `GET /api/users/:id/caseload` and
    `GET /api/users/caseloads` (counts only). Moving a whole caseload also moves to-dos that name no client.
  - Creating a user, resetting a password and the setup wizard no longer hash passwords on the event loop.
  - Client list: the risk, no-contact-in-30-days, substance, MAT, consent-expiring and open-patient-request
    filters run on the server (`server/client-filters.js`, shared with the Home tiles), so a tile and the list
    it opens count the same people and every match is reachable. Client, visit, note, referral, call and
    waitlist lists have "Load more"; the waitlist is no longer capped at 500. The consent alert on Home counts
    clients, like the list it opens.
  - Saving a record someone else changed since you opened it is refused with "This record was changed by
    someone else since you opened it. Reload to see their changes." (409, `if_updated_at`) instead of silently
    overwriting their changes. The client form sends only the fields you changed.
  - A save retried after a dropped connection no longer creates duplicates (`Idempotency-Key`, remembered for
    24 hours, answers stored encrypted and never synchronised): one referral, one disclosure record, one
    follow-up, one visit and time entry.
  - Returning clients: when intake finds a discharged record outside your caseload (surname and date of birth,
    or phone), you can re-admit it yourself with a reason. It is assigned to you, opens a new episode, is
    audited, and goes to supervisors for review alongside emergency accesses.
  - Migration 27 adds `idempotency_keys` and `breakglass_events.kind`.
- **Settings → Lists: change the choices on documentation forms without a code change.** Administrators can
  reword, reorder, hide and add to the choices for visit type, location, modality and outcome, call and text
  outcomes and who was called, referral status ("What happened") and barrier, overdose "What happened" and
  "Given by", time category, note format, primary substance and discharge reason, or restore the defaults.
  Stored codes never change, so history and reports stay consistent; the wording is used on forms, lists,
  reports and Excel/CSV exports, and imports accept either. Choices SUDS acts on (a fatal overdose, a reached
  call, the visit types that need no client…) can be reworded but not hidden. A hidden choice is no longer
  offered on new records; editing a record that already has it keeps it. Referral statuses and overdose
  outcomes take no additions (each drives a rule or a count); reporting code sets (race, ethnicity, ASAM,
  consent types, patient-rights requests) are not editable and the page says why. Every change is audited.
- **Funding sources** can be added, renamed and deactivated from Settings → Lists; a **Manage** link sits
  beside every Funding source field for budget managers, and **Edit this list** beside list-driven fields for
  administrators. Editing a record charged to a deactivated funding source now keeps that source instead of
  clearing it.
- Migration 28 adds `option_overrides`, which devices receive from the office and cannot change.
- **"Download provider pictures" works, and the pictures show.**
  - On SUDS on this device, a browser cannot download pictures from providers' websites (no CORS), so every
    one failed. The site is now published with each starter-directory provider's picture, fetched at build
    time (`scripts/fetch-region-pictures.js`, `SUDS_REGION_PICTURES`); a program the build has no picture
    for says so.
  - A downloaded picture now shows on the directory card: the browser makes a real thumbnail instead of the
    card keeping the generated placeholder. Pressing the button again repairs pictures downloaded earlier.
  - The result (how many, and why the rest are missing) stays on screen and is shown as a toast. On a device
    that syncs with an office server the button is replaced by a note that pictures arrive with sync.
  - An office server that cannot reach the internet says so and names `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`
    (or `NODE_EXTRA_CA_CERTS`), instead of "fetch failed" for every program (`DEPLOYMENT.md`, *Outbound
    internet*).
  - API: `POST /api/regions/:id/pictures` results include `photo_id`/`resource_id`; `GET` returns `thumbs`;
    `PUT /api/resources/:id/photos/:pid` accepts `thumb_url`.

## 1.9.4 — 2026-09-24

- **The paused screen tells the truth in every event order.** A displaced tab says its work was "saved first"
  exactly when nothing is left unsaved (a save refused by the fence leaves it unsaved), on every path that
  pauses it; before, a frozen tab that had saved on its `freeze` event said "may need to be re-entered" or
  "saved first" depending on which of its queued callbacks ran first on waking (seen once in three CI runs).
  `scripts/ui/multitab.mjs` now expects the truthful answer for both variants and fails on the old code.
- **Safari: a record saved and the page reloaded straight away was lost.** The new WebKit CI job caught it:
  Safari's engine drops the last write made while a page unloads, and 1.9.3 batches saves every 250 ms. An
  explicit save from the interface now waits for the on-device write before the page says it is saved;
  background writes (note autosave, preferences, polls) stay batched. On a very large on-device caseload an
  explicit save takes a few tens of milliseconds longer.
- Safari's engine could leave the offline shell empty after an update and miss a cached page offline: the
  worker now falls back to a plain fetch-and-store when its reload-mode precache is refused, never skips its
  handler if building a request throws, and ignores `Vary` when looking up the shell offline.
- WebKit smoke checks report what the shell cache holds instead of crashing, and wait for the worker to finish
  filling it.

## 1.9.3 — 2026-09-24

Fixes from the critical review of 1.9.2, re-checked by an independent verifier with its own multi-tab, frozen-tab, old-tab-upgrade and phone scripts before release (no data loss in any scenario). **Upgrade note:** local mode is now off by default on the office server; a county that relies on it sets `LOCAL_MODE_ENABLED=true` (or answers Yes in the setup wizard). Schema 24 (`tasks.description` encrypted).

- The update banner appears only when the release running in the page differs from the published one (no banner right after an update); the build stamp is shown under the page title on phones; Home's overdue badge and due date wrap at 200% text instead of running off the screen.


- **The demo build loads sample data beside clients you already entered.** On the static (GitHub Pages)
  build, "Load sample data" no longer refuses once a client exists; the sample rows are tagged and "Remove
  sample data" takes away only them. An office server, and a browser copy it hands out, still offer it
  only to an empty program (`server/demo.js` `loadRefusal`/`offer`, `local/kernel.js`). The "local mode is
  off" page now names the setup wizard's answer and `server.json` `localModeEnabled`, not only the
  variable. Leftover native-app branches (`SudsNative`, `__sudsSecrets`, the `suds:` and Android WebView
  hosts) are gone from the web app.
- **Browser suite: order-independent, condition waits, summary table.** `scripts/ui/run-all.sh` reseeds
  and restarts the office server before every script that uses it, prints a per-script table (checks,
  result, seconds) and exits non-zero on any failure; its readiness probe no longer waits out 20 s on a
  401. Fixed sleeps are replaced by `settle()` / `saved()` (`scripts/ui/assert.mjs`), which wait on
  `window.__sudsActivity` (requests in flight, the pending prefs save and Home tour, the last rendered
  address) and on the kernel's unsaved state; the few sleeps left wait for time to pass on purpose.
- **Local mode is off by default on the office server.** `/?local=1` serves a short explanation unless the
  setup wizard's new question — *Allow staff to keep an offline copy on their devices? Recommended: No* —
  is answered Yes (stored in `data/server.json` as `localModeEnabled`) or `LOCAL_MODE_ENABLED=true` is set;
  the variable overrides the wizard either way. **Upgrading counties that rely on local mode must set
  `LOCAL_MODE_ENABLED=true`** (or add `"localModeEnabled": true` to `server.json`). The GitHub Pages demo
  is unaffected. `server/config.js`, `server/routes/setup.js`, `public/views/setup.js`;
  `test/local-mode-default.test.js`, `scripts/ui/setup.mjs`.
- **To-do details are encrypted.** `tasks.description` moves into `description_enc` (migration 24; the
  migration-19 rebuild now encrypts it first so a 1.6.x upgrade keeps it). The API field is still
  `description`; de-identified exports never include it, identified exports decrypt it; sync declares it.
  A 1.9.2 device that pushes a to-do's plaintext `description` has it carried into `description_enc` by
  the office (a `legacy` column map in `server/sync-tables.js`); an old kernel's empty value never erases
  the office copy. `test/task-description.test.js`, `test/sync.test.js`.
- **The native apps and launchers are removed** (`mobile/`, `launchers/`, `mobile-android.yml`,
  `mobile-ios.yml`, `probe.yml`, `scripts/android-keystore.sh`, `scripts/print-url.js`) and the native
  key-store lookups in `local/shims/config.js`; the code stays in git history. PLATFORM.md's roadmap had
  said they were deleted in 1.9.0; it now records 1.9.3.
- **The public demo is published on releases only** (`v*` tags, published releases, and `release.yml`'s
  explicit `gh workflow run web-app.yml --ref <tag>`), never on a push to `main`. Each run names the version
  it publishes; release QA checks the on-screen version (RELEASE.md, WEB_APP.md).
- **CI:** advisory `node24` job (`npm test` on Node 24 from the official tarball) and advisory `webkit` job
  (static-site and qa-retest in Playwright WebKit via the new `SUDS_BROWSER` variable). Dependabot ignores
  esbuild and sql.js (updated by hand with `npm run build:local`) and groups the other devDependencies monthly.
- **Docs:** new `docs/ADOPTION.md` (code owner, pilot, staged releases, real-device checklist, drills,
  independent review, staffing); HIPAA.md *Risk register notes* (blind-index leakage, index key also keying
  the audit chain, single instance, local-mode keys beside the data); Node 24 migration plan in DEPLOYMENT.md.
- **Phone review of the demo build (UX polish).** Dialogs start below the demo banner (`--demo-banner-h`),
  so titles and ✕ stay visible at any text size; Back closes the open dialog instead of leaving the page;
  a referral started from a provider page loads the chosen client's consents (and says what to do once);
  Home's "Load sample data" loads it in place; the demo no longer promises a sync it never does (setup,
  tour, Sync page) and offers "Try it with sample data"; the first screen says what SUDS is; 44px touch
  targets for to-do boxes and chart rows; text sizes in rem and no sideways overflow at 200% text; Title
  Case note formats and "Part 2 disclosure"; "<Field> is required"; 4.5:1 green badges; the last tour
  step says Done; greetings use the given name ("Dr. Patel" kept whole); `get-app.html` installs the app.
  Covered by `scripts/ui/ux-polish.mjs`.
- **Two windows can no longer erase each other's work on a device (fencing).** 1.9.2's takeover lost
  confirmed records four ways: taking a window back kept its stale in-memory copy and saved it over the
  other window's work; a tab still on 1.9.0/1.9.1 kept saving after being displaced; a frozen background
  tab was taken over without asking and saved over the new holder when it woke; a duplicated tab took over
  silently. Now every holder claims an `epoch` in IndexedDB, saves only under `db2:<its epoch>`, and an
  ordinary save checks the epoch in the same transaction as its put (a displaced page pauses instead);
  the unload save writes a key nobody reads once the page is displaced. The first start moves the database
  from the old `db` key, which older releases keep writing to unread — so work typed into a tab still on an
  old release after another took over is not carried across. Nothing is taken over without asking except
  a reload of the same tab, which waits for its previous page to let go. "Use SUDS here instead" reloads the
  page. The paused screen closes open dialogs, survives hash changes and the dashboard refresh, and says
  "saved first" only when it was. `local/shims/sqlite.js`, `local/kernel.js`, `server/db.js` (`openWith`
  always opens what it is given), `public/app.js`; `scripts/ui/multitab.mjs` (new), `scripts/ui/local-mode.mjs`.
- **Writes on a device answer in about 1–3 ms again** (1.9.1 exported the whole database on every write:
  ~37 ms at 1,500 clients). Saves are coalesced (250 ms) and the page saves on pagehide, when hidden and on
  `freeze`; the next page of the same tab waits for the lock before reading, so an edit made just before
  navigating away still survives (`scripts/ui/device-audit.mjs`, under the service worker). A failed save
  still raises the "stopped saving" banner.
- **A new release no longer reloads the page under someone.** When a new service worker takes over, or
  `version.json` (new; written by `npm run build:local`, never cached) names another version, the page
  shows *A new version of SUDS is ready — Reload*, and reloads on its own only when hidden or at the next
  page change — never with a dialog open, a form half-filled or a sync running, and once per release.
- **Build stamp**: "SUDS <version>" on the sign-in/start screens and in the sidebar.
- **Error beacon**: uncaught errors, unhandled rejections and 5xx answers are reported without PHI (message
  cut to 300 characters with long digit runs masked, file:line frames, route without query, version,
  browser family). The office app posts them to `POST /api/client-errors` (signed-in session, 10 a minute
  per person, application log at WARN, not the audit log); a device keeps the last 50 and lists them on its
  Sync page under *Errors on this device*. `server/routes/client-errors.js`, `test/client-errors.test.js`.
- **Service worker**: the office server's `no-store` is passed through instead of being weakened to
  `no-cache`, and a re-headed response no longer carries the original `Content-Encoding`/`Content-Length`.

## 1.9.2 — 2026-09-23

- **No more "SUDS is already open in another window" dead end on a phone.** The single-writer lock stays
  (two tabs writing the same on-device database would overwrite each other), but the screen now offers
  *Use SUDS in this window*: the other tab is asked to write out and step aside, is shown a "paused" screen
  with a way to take it back, and refuses every request from then on. A reload of the tab that holds the
  lock, or a holder whose heartbeat has stopped, takes over on its own with no screen at all; the case the
  release-time reload made common. `local/shims/sqlite.js`, `local/kernel.js`, `public/app.js`; covered by
  `scripts/ui/local-mode.mjs`.

## 1.9.1 — 2026-09-23

Second external retest of the published (static, always-local) build, in a browser profile that had been
set up on a build from before the first round of fixes. Replayed by `scripts/ui/qa-retest.mjs`
("upgraded profile": the static site of the old commit, then this build at the same origin) and
`scripts/ui/static-site.mjs`.

- **Stale app files after a release on a static host.** A host that sends `max-age` (GitHub Pages: ten
  minutes) let a plain reload keep running the previous build's `app.js` and views from the browser's own
  caches, with the service worker never asked — every fix of the first retest looked "still broken" for
  as long as that lasted. The worker now fills its shell with `cache: 'reload'`, fetches app files with
  `cache: 'no-cache'`, and hands the page every app file marked `no-cache` so the next reload comes back
  to it; a new worker taking control reloads the page once. Offline, `index.html` stands in only for a
  navigation; a missing script or image is a real failure. `get-app.html` is in the shell.
- **A write on the device is on disk before it answers.** With the worker answering navigations from its cache, the next page could arrive before the previous page's unload write was committed; every write request now persists before responding, so an edit made in the instant before leaving survives.
- **"+ Add pictures" is now a label over the file input itself** (`.file-btn`): a tap on the button is a tap
  on the input, so the picker opens as a direct gesture everywhere and an automated click aimed at the
  input is no longer "obscured" by the button that used to forward to it.
- **The greeting uses a one- or two-word display name whole** ("QA Tester", "QATEST"); only a longer formal
  name is shortened to the first name (`greetingName`). Never re-cased; username fallback.
- **The demo banner no longer intercepts taps** on a dialog scrolled up under it (`pointer-events: none`).
- **"Use SUDS on your phone or tablet" on the static build**: linked as `get-app.html` from the login tip,
  the Home card and the Settings card (a static host has no `/app` rewrite); the page hides the
  certificate download and office-address wording there and shows the offline-copy section.
  `scripts/serve-static.js` now behaves like a plain static host (no rewrites, real 404s).

## 1.9.0 — 2026-09-23

A hardening and audit release. Schema 23 (migrations 19–23); databases upgrade in place on first start — take a backup first. This is the first release under the web-first platform policy (`docs/PLATFORM.md`): the office server's web app is the only supported client; the native apps and launchers no longer build or ship.

Compliance review fixes (HIPAA / 42 CFR Part 2) and county IT hardening.

- **Web-first: native apps and launchers deprecated.** The web application served by the office SUDS
  server is the only supported client and the system of record; everything is managed and documented
  against it (`docs/PLATFORM.md`). The Android and iOS apps and the desktop launchers are deprecated and
  will be removed in a later release: their workflows run only by hand and attach nothing, the release
  carries the server zip alone, the office server no longer hosts an APK (`GET /api/app/android.apk`,
  `POST/DELETE /api/admin/app/android` and the `android` field of `/api/app/info` are gone), and Settings no
  longer offers an upload. `scripts/gen-schema-text.js` no longer stamps `build.gradle.kts` or
  `Info.plist`. `/app` is now "Use SUDS on your phone or tablet" (browser, home screen, certificate) and
  mentions the offline copy only when the server reports `local_mode`. Browser local mode stays, under the
  rules in PLATFORM.md; existing phone-app installs should sync once more and be uninstalled.

- **Sync cannot rewrite the legal record.** Consents, disclosures and note addenda are insert-only through
  `POST /api/sync/push`; the only change a device may make to an existing consent is to revoke it, and the
  revocation is attributed to the syncing user. Anything else is rejected as `immutable`.
- **Referral outcomes are consent-gated.** `POST /api/referrals/:id/outcome` applies the same lawful-basis
  check and disclosure record as creating or updating a referral.
- **Safe Harbor de-identification.** De-identified exports reduce every date to year-month, ZIP codes to
  three digits, omit city, band ages (DOB is never exported) and are labelled as such (CSV comment line,
  Excel *About* sheet). The funder report suppresses breakdown rows under 11 (`<11`). Exports now require
  `export:read` (supervisor, finance, admin); an identified export must name `recipient` and `purpose` and
  writes one accounting-of-disclosures row (basis `export`) per client it contains.
- **Disclosures without consent must be justified.** A medical-emergency basis needs a written justification
  (20+ characters, stored encrypted); "other" additionally needs the new `disclosures:override` permission
  (supervisor, admin).
- **Part 2 consents carry every §2.31 element.** A `part2_disclosure` consent requires recipient, purpose,
  scope, an expiry date or event, evidence of signature (document reference, witness or signed on paper) and
  confirmation that the redisclosure notice was given.
- **Break-glass review.** The reason must be at least 15 characters; every use is queued in
  `breakglass_events` and shown under Supervision → Break-glass access, with a count on the supervisor's
  home page, until acknowledged (`GET /api/supervision/breakglass`, `POST …/:id/ack`; nobody can acknowledge
  their own).
- **Audit head checkpoint.** After each scheduled verification and each purge the newest entry's id, hash
  and the row count are HMAC-sealed into settings and written to the log; verification reports `truncated`
  when the newest entries have been deleted.
- **Retention, legal hold and patient rights.** `clients.legal_hold` with `POST /api/clients/:id/legal-hold`
  (admin only); a `patient_requests` table and `/api/patient-requests` CRUD with a 30-day due date and a
  *Requests* tab on the client page; `GET /api/clients/:id/disclosures/accounting` and a *Print accounting*
  button; a daily retention job (`server/retention.js`, `client_retention_years`, default 7, minimum 6) that
  hard-deletes discharged records across every table unless held.
- **More columns encrypted.** `calls.purpose`, `referrals.outcome/barrier/notes`, `tasks.title` and
  `overdose_events.substances` move to `_enc` columns (API field names unchanged).
- **Roles and defaults.** `readonly` sees the de-identified client list and reports only (no `clients:all`,
  no exports); MFA is required of every role by default; `LOCAL_MODE_ENABLED=false` makes the server serve an
  explanation instead of the in-browser kernel; `CLIENT_RETENTION_YEARS` configures retention.

Schema 20. Navigator-facing fixes from a hands-on field review.

- **Tap to call, text or navigate.** Every phone number on the client page, the contact lists, the
  calls list and the resource directory is a `tel:` link with a `sms:` "Text" beside it; addresses open
  in maps. Call / Text buttons on the client page dial and then open the log, prefilled.
- **Offline is said out loud.** A save with no signal keeps the dialog open and says so in plain words; a
  persistent banner points at the phone app, including on a sign-in screen served from the cached shell.
- **Names, not codes**, on the to-do list, Calls & texts and My time (`client_name` on those list routes,
  never for a de-identified role). Compact two-line rows for Clients, To-do and Calls on a phone; the
  client page's tabs fold into a keyboard-accessible "More" menu instead of scrolling off the edge.
- **Intake opens the first episode of care** (`no_episode: true` opts out); the New client form no longer
  asks for a discharge; a closed episode can be reopened (`POST /api/episodes/:id/reopen`, re-admission).
- **Ask for a co-sign.** An author can request supervisor review on a draft or signed note
  (`notes.cosign_requested`, `POST /api/notes/:id/request-cosign`); it joins the countersignature queue.
- **Reminders that reach you**: a bell in the header with the count due within the hour or overdue
  (`GET /api/tasks/due`), an opt-in browser notification (Profile), and Home labels overdue items first.
- Accessibility: the closed phone drawer is `inert`; 44px tap targets on touch screens; warning text
  meets 4.5:1 in both themes. The + Log button clears the last card, hides behind the drawer, and toasts
  sit above it.
- Preferred name / alias search (`clients.preferred_name_idx`); caseload sort (last contact, overdue
  follow-ups, risk); shift hand-off notes with a Home card; a structured safety plan note shown as a chip on
  the client page; and a supply cupboard (`supply_stock`, `/api/supplies`) that visits draw down.

- Fixes from the outside retest of the published web app (local mode): "Add resource" saved nothing
  because a DOM error was thrown before the request (every form error now reaches the dialog's banner);
  Settings crashed on the device over a config key the local kernel's config shim did not define; a due
  date entered without a time was silently dropped (date & time fields are now a date plus an optional
  time, and a date-only value is kept as the calendar day); a client with a blank status showed no status
  (rendered as Active; migration 21 backfills such rows); the client search list no longer floats over
  the field below it, which blocked the date picker on phones; the greeting uses the display name as
  typed (username if blank); dialog titles no longer linger in the accessibility tree via the live
  region. Covered by `scripts/ui/qa-retest.mjs` on both the static build and `/?local=1`.

Sync and data integrity (from the weakness review).

- **Offline work reaches every device.** Rows a device pushes are stored with the office's clock, so other devices' incremental pulls receive them; the pull cursor is per office user, so a second person on a shared device gets their whole caseload.
- **Purged and merged records stay that way.** A push for a client the retention job purged (or any of its records) is refused as `purged` and the tombstone kept; the device deletes its copy. Records of a merged-away duplicate are re-pointed to the keeper and a pushed row can never move a record between clients.
- **Rejections say whether they are final.** Every rejection carries `permanent`; the device settles a permanent one (office wins), shows it once on the Sync page and never resends it. Transient failures still retry.
- **Supply stock is server-owned**: devices cannot push counts; a pushed visit draws stock down on the office by the delta, and deleting a visit restores it.
- Device-supplied owners are honoured only when the syncing user may act for them; creation timestamps no longer drift with the device clock; device pull applies row by row with savepoints, foreign keys are on for every open, and office tombstones are never echoed back.
- A restore from backup stamps a database generation; devices notice it on the next pull, reset their exchange state and re-offer their records, so nothing created on a phone is lost to a restore.
- Client codes are generated from a numeric counter (a collision rename no longer poisons the sequence; codes past 9999 work).

Security, exports, backups and finance (from the weakness review).

- Index-key rotation re-seals the audit head under the new key (it failed after the first scheduled verification). A pending device wipe is no longer consumed by anyone who knows the device id: the office answers the wipe instruction without changing state until valid credentials arrive on that device or the device acknowledges with a one-time token; the device now erases itself completely (the in-memory copy no longer writes itself back) and a revoke that carried a wipe wipes too.
- Navigators and clinicians can export de-identified data again; every Export button is permission-gated; the identified workbook asks for recipient and purpose and writes one accounting-of-disclosures row per client. CSV exports have no comment line and neutralise formula-triggering cells; de-identified datasets use explicit per-dataset column lists. The duplicate check on client create no longer reveals people outside the caller's caseload.
- A refused restore leaves the original database in place; a backup that fails to write is recorded, audited and surfaced by `/api/health`; the offsite copy is reported as failed when the share is not mounted rather than silently written to the local disk; a backup from a newer SUDS is refused with a plain message.
- Service dates use the organisation's time zone (`ORG_TIMEZONE`) for fiscal-period checks; expenditure approval follows a strict state machine (pending → approved | rejected, approved → reimbursed) with a supervisor-only overspend override and no self-approval for any role; money is rounded to cents on write and in every sum; budget structure is checked (period order, sub-allocations within their parent, lines within the fund); a pending expenditure cannot be moved outside the period.
- Re-importing a spreadsheet skips rows already imported; the due-reminder poll no longer floods the audit log; failed sign-ins for unknown usernames are audited hashed.

Functional audit before this release (every workflow walked by role, in the browser).

- **Settings no longer blank the policy on a fresh install**: saving any field used to store empty values and disable MFA for every role. Unset settings render their defaults; an empty MFA-roles value means "default", never "nobody"; the save is all-or-nothing.
- Returning a time entry requires a reason, shown to the worker; the time-approval queue shows all submitted time to finance and admins; `mfa_grace_days = 0` means immediately.
- Legal hold blocks merge in both directions; a discharge needs a reason; opening an episode makes the client active and a client with an open episode cannot be closed through Edit; a referral outcome closes only its own follow-up; editing or deleting a visit keeps the auto-created time entry in step; merged-away links redirect to the keeper; open patient-rights requests and overdue ones are counted on Home and in Supervision; contact-field validation (DOB, email, phone); expired consents are not offered for referrals; a crisis-escalated call is counted as a crisis.
- Forms no longer re-save a draft after a successful submit (the New client dialog reopened pre-filled with the person just created). Dialogs sit above banners on phones; the break-glass dialog enforces the reason length; unhandled errors surface as a toast; unknown routes show "Page not found".
- Local mode: idle sign-out fires even while the reminders poll runs; office-side sync errors show their real message; an office account with MFA is asked for its code inline instead of being sent to the device's own MFA screen; the service worker is registered in local mode and precaches the kernel so a home-screen install opens offline; writes in the last moments before leaving the page are flushed; field-created clients no longer trip an "assignments" rejection; a merged-away client is re-pointed on the device; a device-side edit of a server-owned supply count is overwritten by the office. The kernel and WebAssembly ship precompressed with immutable caching (Slow 3G cold start 57 s → 31 s). Sync from the demo site is refused up front with an honest message.
- Operations: a full disk answers 507 with a plain message; a double leading slash in a URL no longer hangs a request; `.webmanifest` has the right type; device revoke and user deactivation ask for confirmation; the restore-complete dialog has one action, "Sign in again"; the wizard hides the port when `PORT` is set by the environment.

## 1.8.0 — 2026-09-18

- **A fully standalone, browser-only web app.** No office server, no Node process, no database anywhere
  but the visitor's own browser — the same "local mode" the phone apps run, packaged as a static site and
  published to a public URL (GitHub Pages, or any static host). Open it on any phone or computer, add it
  to the home screen, and it works, including offline; sync with a real office SUDS later if the county
  has one. `docs/WEB_APP.md`; built by `scripts/build-static-site.js`; deployed by
  `.github/workflows/web-app.yml`; covered end to end by `scripts/ui/static-site.mjs`.

## 1.7.1 — 2026-09-18

Production-readiness fixes found by running the first-run wizard the way a county does, and by inspecting
what 1.7.0 added.

- **Username validation was silently off** on the setup wizard and the add-staff form. The HTML pattern
  reached the browser with an unescaped `-`, which modern Chrome rejects, logs, and ignores — so any
  string was accepted as a username. Fixed in both forms.
- **The database's write-ahead log and shared-memory files were world-readable** on a production server:
  SQLite creates them itself, and only the database file was being made private. In production the
  process now creates every file private by default, and existing `-wal`/`-shm` files are fixed on open.
- **Releasing from the Actions tab never built the Android app.** The tag the release workflow creates
  raises no push event, so the Android workflow's tag trigger never fired and the APK was quietly
  missing from every release started that way. The release workflow now starts the Android build itself.
  (The APK is attached only when the signing secrets are set — see docs/MOBILE_APPS.md.)
- **The first-run wizard is part of the browser suite** (`scripts/ui/setup.mjs`, run against an
  unconfigured production server): wizard, HTTPS restart, first sign-in, key-backup prompt, first
  backup, and that setup cannot be run twice. The desktop crawl also covers the screens 1.7.0 added
  (Supervision, Waitlist, Overdose, Funder report, Forms, the Texts filter). The suite refuses to start
  on a port a stale server is holding, instead of reporting an app defect that is not one.
- `scripts/android-keystore.sh` creates the county's Android signing key once, with the checks and the
  warnings that key deserves; keystores are ignored by git.

## 1.7.0 — 2026-09-17

This release came out of a detailed review of the platform. It fixes things that could break a county's
data, closes gaps between what the app recorded and what it actually enforced, and adds the workflows the
data model had no process around.

### Things that could have lost or leaked data

- **Sync could wedge itself permanently.** One unusable row aborted an entire push, and the device retried
  the same payload forever. Each row is now applied on its own: a bad one is rejected with a plain reason
  and everything else still lands. Three reproduced ways this happened are now covered by tests — a county
  form completed offline, the third device to create a client without a signal, and a record whose
  encryption could not be read.
- **Key rotation destroyed form PHI.** Re-keying the database skipped completed county forms and their
  attachments, so following the documented procedure made them permanently unreadable. The columns to
  re-encrypt are now read from the database itself, so a new one cannot be missed.
- **Sync let a device do what its user could not.** A navigator could write resources, funding sources and
  form templates through sync, and caseload limits were not applied at all to calls, to-dos, time entries
  or spending. Both are enforced now.
- **Finance could export identified client data.** The role kept its de-identified access but no longer
  holds the permission that turns names on.
- **A phone with two tabs open lost work.** Each kept its own copy of the database and saved by overwriting
  the whole thing. One window now holds it and the others say so. A committed change is written out
  immediately rather than on a timer, a failed save is reported instead of disappearing into the console,
  and a device whose security key has been cleared says so instead of silently making everything on it
  unreadable.
- **Restoring a backup no longer needs a terminal.** Administration can check what a backup contains and
  then restore it, keeping the replaced database aside. Backup, restore and key rotation had no tests at
  all; they do now.

### Consent, supervision and discharge

- **Consent is enforced where information actually leaves.** A referral that names a client to an outside
  agency is refused without a valid consent or another lawful basis, and writes the disclosure record that
  HIPAA §164.528 requires. Revoking a consent flags the open referrals that relied on it.
- **Countersignatures.** Only the author signs a note; a supervisor countersigns. Both names stay on the
  record — signing on a trainee's behalf used to erase who actually provided the service.
- **Supervision** (new menu item): notes waiting for a countersignature, drafts the team has not finished,
  staff time to approve, and referrals with no outcome recorded.
- **Staff time is submitted and approved**, in bulk or per entry, with the same rule expenditures have:
  nobody approves their own.
- **Episodes of care and discharge.** Closing an episode ends the assignments, closes the open to-dos that
  would otherwise sit overdue forever, and records why and where the client went. Reopening service brings
  a returning client back. There is a **waitlist** ordered by how long people have actually waited, and a
  **caseload transfer** that moves every client and open to-do at once when a worker leaves.
- **Referral outcomes.** Every referral gets a follow-up date whether or not one was set, and recording the
  outcome closes the loop, so "how many warm handoffs resulted in an admission" is answerable.

### Reporting

- **Funder report** (new menu item): unduplicated counts — people, not services — by fiscal period and
  funding source, with admissions, discharges, median length of stay, demographics and overdose figures.
- **Overdose & reversals** (new menu item): an event log including community reversals with nobody
  identified, which previously could not be recorded at all. Community naloxone distribution can be
  recorded as a service with no client attached.
- Race and ethnicity are recorded as codes a funder can count, alongside the free-text field.

### Contacts, referrals and the phone

- **Text messages are logged like calls.** + Log offers **Text message**, and a client's page has a
  **+ Text** button. A text has its own outcomes — replied, sent, no reply, undeliverable, wrong number,
  opted out — so "voicemail" and "busy" no longer stand in for them, and the two sets cannot be mixed up.
  A reply counts as having reached the client (an unanswered text does not), so texting somebody no longer
  leaves them on the *no contact in 30 days* list. What was said is encrypted like any other PHI, and the
  form says plainly that texting a client about treatment is itself a disclosure if someone else can read
  their phone.
- **A referral is no longer blocked by an empty directory.** On a phone that has not synced yet, the
  provider list was empty, offered only "—", and had nothing to type into. It now offers adding a provider
  without leaving the referral, and says why the list is empty.
- **The floating "+ Log" button no longer covers the last control on a phone screen**, and a long value can
  no longer push a page wider than the phone — which put buttons out of reach entirely.

### Working with client records

- **Entering the same person twice is caught.** A matching surname and date of birth, phone number or full
  name is flagged while you type — compared through blind indexes, so no name is ever in the clear.
  Duplicates that do get in can be **merged**.
- **Search tolerates typos and partial surnames**: "Ngu" and "Nguyan" both find Nguyen.
- **Starter forms**, including a 42 CFR Part 2 consent with the elements the rule requires. A new
  installation used to have no consent form at all.
- Unsaved work in a form is kept if the dialog is closed or an idle sign-out happens.

### Accessibility

- Clickable rows and the client picker were mouse-only. Rows are keyboard-reachable, the picker is a real
  combobox with arrow keys and Enter, dialogs keep Tab inside them and return focus where it came from, and
  validation errors are announced and focused rather than shown only as a red outline.

### Under the hood

- **The audit chain is keyed.** It is an HMAC over the previous entry rather than a plain hash, so somebody
  who can write to the database cannot recompute a chain that covers their changes. Entries written by
  earlier versions still verify, and the whole chain is checked daily.
- **The database is snapshotted before a migration runs** (`data/pre-migration/`, last five kept). A
  migration is the one operation a county cannot retry, and if the snapshot cannot be written the upgrade
  stops rather than proceeding unprotected.
- **Ending an assignment now takes effect at once.** Access was decided by date alone, so a worker a
  supervisor had just taken off a case kept the client until midnight.
- **Local mode in a plain browser says what it is.** Without a Keystore or Keychain it keeps its encryption
  keys in that browser profile beside the data, so the Sync screen and the documentation now say so: it is
  for trying SUDS out, not for real client information.
- Downloading pictures for a whole region is bounded by one time budget, so a slow provider website cannot
  outlive the request.
- Signing in no longer blocks every other request while the password is hashed.
- Pictures are served as cacheable images instead of base64 inside list responses, sync is paged and
  chunked, attachments travel separately, and the tables sync reads are indexed — a first sync used to be a
  single 40MB response the phone could not parse.
- Mandatory two-step verification is actually enforced, after a grace period so a new administrator is not
  locked out before they can enrol.
- There is a real health check, logs are written to dated files and rotated, and an unhandled error no
  longer takes down an unsupervised county workstation.
- Release builds fail if the committed phone kernel is stale, if tests fail (a shell precedence bug let a
  release publish with failing tests), or if an Android release is about to be signed with a throwaway key
  that would stop staff installing the update.

## 1.6.1 — 2026-09-17

### One record, one date, everywhere
- A reminder due on a calendar day (for example a follow-up from a call) showed as that day at noon on the client timeline but as the evening before on the To-do list and Home. Every screen now reads dates through one rule: a bare day is a day in your time zone, a timestamp is an instant, and something is "overdue" only after the day has ended. The server applies the same rule to overdue counts and to what Home lists as due today, and no longer turns a chosen day into midnight UTC when saving.
- The timeline shows task and note titles exactly as typed instead of re-capitalising them.
- Choosing **All** in the To-do list status filter returned nothing; it now lists everything (the same fix covers the expenditure and referral filters).
- On phones, list tables (to-do, referrals, calls, visits, time, spending) become stacked cards with a label on each value instead of seven columns squeezed into the screen width.
- The offline app shell now includes the Forms, Import and Sync screens.

## 1.6.0 — 2026-09-17

### Sacramento region starter directory
- **Add 81 programs in one click.** The Resource directory now offers a starter directory for the extended Sacramento metro: Sacramento, Yolo, Placer, El Dorado, Sutter, Yuba, Nevada and Colusa counties. It covers opioid treatment programs, office-based buprenorphine, residential treatment and detox, intensive outpatient and outpatient, sober living, shelters and day centres, harm reduction and naloxone, county access and crisis lines, community health centres, peer and recovery communities, food, legal aid, benefits offices and transport. Each entry carries a plain-language summary written for a navigator, service tags, populations served, how to refer, cost notes and contact details. Granite Wellness Centers appears as six separate programs (withdrawal management, Hope House, Serenity House, outpatient and MAT, adolescent, Truckee).
- **Loaded unverified, on purpose.** These programs were compiled from public web sources and were not confirmed with the providers. Every entry loads with no verification date, is flagged "needs verification" in the directory, and carries a staff note recording where it came from plus anything that needs checking, for example a conflicting address or a phone number that may belong to a commercial directory rather than the provider. Staff confirm each one and press "Verified today".
- **Never overwrites your work.** Loading fills in blanks on programs you already typed and adopts matching entries instead of duplicating them. Re-running checks for updates. Removing takes out only the programs nobody has used or verified; anything with a referral or a verification date is kept and simply deactivated.
- **Pictures.** Every program gets a category-coloured cover card generated on the spot, so the directory looks complete offline. **Download provider pictures** then visits each program's own website, finds the picture that site advertises for itself, and saves it as the main picture where it works. Programs whose site publishes nothing keep the generated card.

## 1.5.0 — 2026-09-17

### County form library
- **Forms** (new menu item): administrators and supervisors upload the county forms the program uses (PDF, Word or a picture of the paper form) and describe the fields to fill out. Fillable PDFs have their fields detected automatically; a "usual client header fields" button adds name, date of birth, phone, address, date and navigator in one click. Fields can be short or long answers, dates, numbers, checkboxes, choice lists, typed signatures, section headings and instruction text, marked required, and set to **pre-fill from the client record** (name, DOB, phone, address, insurance, Medicaid ID, client code, primary substance, worker name, program name, today's date).
- **Fill out from a client record** (new Forms tab, or "Fill out for a client" in the library): the form opens pre-filled from the chart, saves as you type, checks required fields when you mark it completed, and becomes read-only (supervisors can reopen). Every filled form is stored encrypted with the client record, prints to a clean **PDF**, and can hold the **signed or scanned copy** (photo or PDF, also encrypted). The original county form can always be downloaded to print blank; a blank PDF is generated for forms uploaded without a file.
- Forms sync to phones like everything else and work in the phone-only app. Client forms appear in exports (de-identified) and in the client's counts. Sample data includes three county forms and filled examples.

### Interactive cards
- Summary cards on Home, Reports, the client overview, Funding and System are now links: click "High-risk clients", "Open referrals", "Naloxone kits given", a fund's "Pending" and so on to jump to the matching filtered list. Chart bars (visits by type, clients by status or substance, MAT status, calls by outcome) are clickable too. The client list shows the active filter with a one-click clear.

## 1.4.0 — 2026-09-17

### Treatment center profiles
- Every resource in the directory now has a **profile page** (`#/resource/<id>`): a plain-language summary at the top, **services offered** as tick-box tags (detox, residential, IOP, MAT by medication, peer support, housing, telehealth, walk-in, 24/7 crisis and more), levels of care, populations served, how to refer, cost and capacity notes, contact details, referral outcomes and the recent referrals you may see.
- **Pictures**: staff with resource-edit rights add photos of the building, entrance and rooms from a phone or computer. Pictures are shrunk in the browser before saving (max 1600 px, plus a small thumbnail), checked on the server by their real bytes (JPEG/PNG/WebP only, 2 MB cap, 12 per resource), can be captioned, reordered (make main picture) and removed, and sync between phones and the office like any other record.
- The directory shows **cards with cover pictures** (or a list, your choice is remembered) and can be filtered by service. Referrals can be started from a profile.
- Excel/CSV import and export include the new profile columns. Sample data resources now come with summaries, tags and drawn placeholder pictures.
- Android app: the system photo picker opens for picture uploads.

## 1.3.0 — 2026-09-16

### Sample data
- **Load sample data** (Settings → Settings on the office SUDS; the Sync screen on a phone-only copy) adds 12 fictional clients with visits, calls, time, notes in several formats, referrals, reminders, consents, disclosures, resources, two funding sources and spending, so a new program can explore every screen. It is only offered while there are no clients yet, every record is tagged (`DEMO-` client codes) and **Remove sample data** deletes all of it in one click. A phone removes its sample data automatically before its first sync so it never reaches the office.
- The empty dashboard points new users at it. `npm run seed` uses the same generator (plus demo staff accounts) for development.

### Sync
- Device clock differences no longer decide conflicts: the office normalises timestamps using each device's reported time, and phones track exactly which rows were sent so nothing is re-sent or lost.
- Local database saves are flushed when the app goes to the background.

### Fixes
- Pages a role cannot use (for example Settings for a navigator) now show a clear message instead of failing requests.
- Collapsed sections in the new-client form are opened by the browser tests; the tour no longer opens on top of another screen.

### Build & test
- Browser regression suite (`scripts/ui/run-all.sh`, seven Playwright scripts covering desktop, the navigator workflow, UX features, phone-only mode, two-way sync, spreadsheets and sample data) runs in CI on every push.
- iOS simulator build workflow (`mobile-ios.yml`) compiles the SwiftUI wrapper on every release.

## 1.2.1 — 2026-09-16

### Security review fixes
- Sync: a device can no longer overwrite clients outside its user's caseload, delete rows it may not access, attribute work to other staff, self-approve spending, alter signed notes, or hard-delete clients, notes, consents or disclosures. Clinical notes are only synced to roles allowed to read them; MFA secrets never leave the server.
- Phone apps: database keys now live in the Android Keystore-backed encrypted store / iOS Keychain instead of web storage.
- iOS: the bundled app is served through a custom URL scheme so modules, fetch and WebAssembly work (file:// could not run the kernel).
- Local mode hides server-only settings (network, API keys, backups) and phone-connection cards.

## 1.2.0 — 2026-09-16

### Excel and CSV import / export
- **Export**: every table (clients, visits & services, calls, time, referrals, to-dos, resources, consents, funding, budget lines, expenditures) to Excel (.xlsx) or CSV, plus "Everything as one Excel workbook". De-identified by client code; an audited identified workbook for users with export rights. Buttons on Reports, Clients, Resources, Budget and the record lists.
- **Import**: Excel or CSV for clients, resources, visits & services, calls, time, to-dos and expenditures. Download a template with the exact columns, or upload your own file: columns are matched by name (with aliases such as "Surname", "DOB", "Drug of choice"), every row is validated with plain-language problems, clients are matched by code or name, duplicates are flagged, and nothing is saved until you confirm. Works in the phone app too.
- Spreadsheet engine implemented with built-ins only (CSV parser/writer, .xlsx reader incl. shared strings and Excel dates, .xlsx writer with frozen header and filters).

## 1.1.0 — 2026-09-16

### Phone app works on its own; sync on command
- The complete SUDS app now runs inside the phone app (local kernel: the server logic bundled with SQLite-in-WebAssembly and pure-JS encryption). Install from the APK, create a local account, and start working — no office computer needed at install time or while working.
- **Sync** screen: exchanges clients, visits, calls, time, notes, referrals, reminders, consents, funding and resources with the office SUDS in both directions when the user chooses. Newest change wins; deletions travel as tombstones; encrypted fields are re-encrypted with each side's own key; device audit entries are appended to the office audit log.
- First sync merges the device account into the office account with the same username; offline-created clients get `M` codes so they never collide with office `C` codes.
- Server: `/api/sync/pull` and `/api/sync/push` (caseload-scoped, role-checked), bearer-token login for sync clients, `updated_at` on all synced tables, tombstones table.
- Android: web app bundled as assets and launched directly in local mode; native bridge for office-server discovery, QR scan and file saving. iOS project updated the same way.
- Local mode can be tried in any browser at `/?local=1` on a SUDS server (data stays in that browser).

## 1.0.0 — 2026-09-16

First production release.

### Core
- Client records with encrypted identifiers, substance use profile, ASAM level, MAT status, overdose and naloxone history, risk level and safety flags
- Visits & services (25 navigation intervention types), calls, staff time, referrals with status pipeline, resource directory, to-do list and per-client timeline
- Funding sources, budget lines and expenditures with approval workflow and separation of duties
- Clinical and administrative notes (SOAP / DAP / BIRP / GIRP), electronic signature with tamper-evident hash, addenda, audited break-glass access
- 42 CFR Part 2 consents, releases of information and accounting of disclosures
- Import of notes from Pocket AI (JSON / Markdown / text), OneNote (MHT / HTML / DOCX / text), Microsoft Graph OneNote sync, pasted text and an API-key intake endpoint, all staged for review
- Dashboard, program summary, monthly trends and de-identified CSV exports

### Security and compliance
- AES-256-GCM field encryption with blind-index search, scrypt passwords, TOTP MFA with QR enrollment, lockout and rate limiting, 15-minute idle sign-out, role-based access with caseload scoping, CSRF and CSP protection
- Hash-chained audit log with integrity verification and retention purge
- Encrypted backups, key rotation, self-signed HTTPS generated in-app

### Zero-configuration deployment
- Browser setup wizard, double-click launchers for Windows, macOS and Linux
- Built-in mDNS responder (`https://suds.local`), standard HTTPS port with fallback
- Progressive web app with home-screen install on phones; per-user workspace and note drafts synchronized across devices

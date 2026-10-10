# Business work plan: the owner actions that move market readiness

**For:** the owner (Tj), who decides, and the owner's business assistant (Muse), who carries out the steps.
**As of:** 2026-10-10, SUDS 1.25.4. **Source:** the market-readiness evaluation of 1.25.4 (section 9, *Owner and
business actions*), HANDOFF.md's open owner decisions and the documents this repository already holds.

The software is not what holds SUDS back. The evaluation of 1.25.4 kept the market-readiness headline at **3.0 of 5**
because "every gating item is still an owner action": a buyer has nobody to contact, nothing reviewed to sign, no
independent penetration test, no signed binary, no confirmed CalOMS layout, no insurance, no reference and no hosted
price. Its smallest set to reach **3.5** is a published contact, a counsel-reviewed agreement, a completed independent
pen test with fixes released, and CI kept as stable as it is; **4.0** adds code signing with a county-like Windows
run, CalOMS confirmation, insurance and one reference pilot in production. This page puts those actions in order,
with what exists, what the owner must decide, the steps, and where each result is recorded afterwards.

**Rules for using this page.**
- Nothing here is a fact about the business until the owner confirms it. Placeholders are `[IN BRACKETS]`. This
  repository is public: personal names, personal email addresses, phone numbers, home addresses, account usernames
  and anything a third party shared privately stay **out** of it; they go into the filled copies outside the
  repository, or into the published page only when the owner chooses to publish them.
- Each **DECISION FOR TJ** is the owner's alone. Muse prepares the options and carries out the decision; neither
  assistant decides, signs, pays, or contacts anyone outside on the owner's behalf without the owner's own instruction
  naming that action.
- Headline effects are the evaluation's estimates, not promises.

## Summary

| # | Item | Owner | Status (2026-10-10) | Next step | Headline effect (evaluation of 1.25.4) |
| --- | --- | --- | --- | --- | --- |
| 0 | Legal entity: which LLC is filed and licenses SUDS | Tj | Open: the LLC is not filed yet (HANDOFF 2026-10-10); `LICENSE` names AugustInnovations LLC | **DECISION FOR TJ**, then file, then EIN | None on its own; items 1, 2, 6, 7 and 8 depend on it |
| 1 | Publish a procurement contact | Tj decides, Muse fills | Not done: the three contact fields are empty | **DECISION FOR TJ**: which role address and page | +0.25 together with item 2 |
| 2 | Counsel review: licence, agreement, BAA/QSOA, DPA, SLA | Tj engages, Muse prepares | Drafts only, unreviewed | Brief ready: [templates/COUNSEL-REVIEW-BRIEF.md](templates/COUNSEL-REVIEW-BRIEF.md) | +0.25 together with item 1 |
| 3 | Independent penetration test | Tj approves and pays, Muse runs the process | Not started; Muse's RFP and shortlist are unsent | **DECISION FOR TJ**: approve the send | +0.25 to +0.5 |
| 4 | Code signing for the Windows server | Tj | Not done: `suds.exe` and `suds-service.exe` unsigned | **DECISION FOR TJ**: certificate or signing service | +0.1 to +0.25 (with a county-like Windows run) |
| 5 | CalOMS layout confirmed with a county | Muse, with Tj's approval to send | Not done | Read the DHCS 2026 FAQ; send [templates/CALOMS-CONFIRMATION-REQUEST.md](templates/CALOMS-CONFIRMATION-REQUEST.md) | +0.1 to +0.25 |
| 6 | Insurance: cyber liability and technology E&O | Tj | None | Quotes with [templates/INSURANCE-QUOTE-BRIEF.md](templates/INSURANCE-QUOTE-BRIEF.md), after item 0 | +0.1 |
| 7 | A reference pilot under a signed agreement | Tj | None | After items 1, 2 and 6 | +0.25 to +0.5, over months |
| 8 | A hosted offer and its price | Tj | Operator decided; no price, insurance or on-call | Fill [templates/HOSTED-OFFER-WORKSHEET.md](templates/HOSTED-OFFER-WORKSHEET.md) | +0.25 once priced, insured and offered |
| 9 | Signed release tags; separate commit identities | Tj | Procedure written; `v1.25.4` unsigned, one shared identity | Make the signing key | Small; removes a supply-chain question |
| 10 | suds.systems hygiene | Muse, on Tj's directives | Runs 1.25.3; upgrade to 1.25.4 owed | Tj's directive naming the upgrade | Small, but it is the box a county is shown |
| 11 | The real-iPhone check | Tj or a pilot lead | None recorded | Run [../evidence/REAL-DEVICE-CHECK-TEMPLATE.md](../evidence/REAL-DEVICE-CHECK-TEMPLATE.md) | Can move the device-only verdict on iPhone |
| 12 | Opioid-settlement reporting collateral | Muse | Draft one-pager in the repository | Check against the current DHCS form; review | Sales, before the 30 Sept 2027 cycle |

**Muse's owner-side drafts.** Since 2026-10-06 Muse has held a business packet **outside this repository** (HANDOFF,
2026-10-10): a pen-test RFP with a vendor shortlist and a recommended first send, a 90-day pilot agreement template, a
BAA template, an executive one-pager, a pilot evaluation framework, a county outreach email draft and a
business-readiness checklist. They are not duplicated here. Each is reconciled with the in-repository document it
overlaps before either is used:

| Muse's draft (outside the repository) | Reconcile with | Who wins where they differ |
| --- | --- | --- |
| Pen-test RFP and vendor shortlist | [templates/PEN-TEST-RFP.md](templates/PEN-TEST-RFP.md) and [../security/PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md) | Muse's RFP (with the vendor choice) is the one sent once Tj approves; the in-repository RFP is the public, vendor-neutral scope reference it must not contradict |
| 90-day pilot agreement template | [templates/LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md](templates/LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md) (section 4, the pilot), [PILOT-KIT.md](PILOT-KIT.md) and the published pilot tier (`public/procurement.json`) | Counsel decides (item 2); until then, neither is offered |
| BAA template (with its Part 2 section) | [templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md) | Counsel decides (item 2) |
| Executive one-pager | The short version in [README.md](README.md), [POSITIONING.md](POSITIONING.md), [BUYER-GUIDE-PROGRAM.md](BUYER-GUIDE-PROGRAM.md) | The repository's wording rules ([README.md](README.md), *Rules for anyone using this pack*) |
| Pilot evaluation framework | [PILOT-KIT.md](PILOT-KIT.md), *Measurement plan and success metrics* and *Pilot evaluation template* | Merge into one before the first pilot |
| County outreach email draft | [COUNTY-KIT.md](COUNTY-KIT.md) and item 5's CalOMS request | The facts in the repository |
| Business-readiness checklist | This page, [README.md](README.md) *Organisational gaps* and [HOSTING.md](HOSTING.md) *Before the vendor-hosted tier can be offered* | Keep one list: this page, with Muse's copy pointing here |

## 0. The legal entity (first, because the rest depends on it)

- **Why it matters.** Every agreement, BAA, QSOA, insurance policy, county vendor registration and invoice names a
  legal entity. `LICENSE` names **AugustInnovations LLC** as the copyright holder and licensor, and the owner decided
  on 2026-10-09 that AugustInnovations LLC would operate a hosted service and sign its BAAs and QSOAs. Muse reports
  (HANDOFF, 2026-10-10) that the LLC is **not filed yet**, and refers to it as "Suds LLC". A contract signed in the
  name of an entity that does not exist, or a different one from the licence's, is a problem counsel will raise first.
- **What already exists.** [`LICENSE`](../../LICENSE) sections 1 and 11; `legal_entity` in
  [`public/procurement.json`](../../public/procurement.json); [HOSTING.md](HOSTING.md) checklist item 1; questionnaire
  #6a ([../security/QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md)); the agreement drafts' party blocks
  (`[[state of formation]]`, `[[address]]`). Muse holds the formation and statement-of-information drafts outside the
  repository.
- **DECISION FOR TJ.** Which entity name is filed, and is it the entity that licenses SUDS? If it differs from
  "AugustInnovations LLC", then `LICENSE`, `legal_entity` in `public/procurement.json` (and its static text in
  `public/procurement.html`), the agreement drafts, HOSTING.md, the market README, QUESTIONNAIRE #2 and #6a and every
  other document naming the licensor must change **before any agreement is signed**, and the copyright must be
  assigned in writing to that entity (QUESTIONNAIRE #6a lists the assignment as an owner item). Also: the state of
  formation, and whether the AWS account that holds the AWS BAA is (or moves to) that entity (HOSTING.md item 2).
- **Steps (Muse, after the decision).** Muse's stated critical path is **file the entity → EIN → insurance → counsel**:
  1. Tj files and signs the formation documents himself; Muse tracks the filing's confirmation.
  2. Tj obtains the EIN; Muse records that it exists (never the number) in the owner-side checklist.
  3. If the name differs from the licence's: a change request listing every file that names the licensor
     (`grep -rn "AugustInnovations" LICENSE NOTICE docs public README.md`), made as one documentation change in a
     release; the licence change itself needs counsel's wording (item 2).
  4. Business bank account, W-9 / Payee Data Record, then county vendor registration when a county asks.
- **Send to.** The state filing office (Tj); nobody else.
- **Done when.** The entity is filed, has an EIN, and the name in `LICENSE`, `procurement.json` and the drafts is that
  entity's.
- **Recorded in.** `legal_entity` in `public/procurement.json`; [README.md](README.md) *Organisational gaps* (the
  entity row); HOSTING.md item 1; QUESTIONNAIRE #6a (state of formation). No filing number, EIN or address goes in the
  repository unless the owner chooses to publish the business address.

## 1. Publish a procurement contact

- **Why it matters.** "Who do I contact and pay? **Nobody is named.**" (evaluation, section 7). The procurement page
  shows *Not yet published by the maintainer* for the contact name, email and web page. With item 2, worth about +0.25.
- **What already exists.** [`public/procurement.json`](../../public/procurement.json): `contact_email`, `contact_name`
  and `contact_url` are empty; `legal_entity`, `pricing` and `sla` are filled. The page is `public/procurement.html`,
  linked from every sign-in page; its static text must match the JSON word for word
  (`test/procurement-hardening.test.js`). An office server has its own copy under Settings › Program › Security &
  procurement page (`server/procurement.js`). Business email now exists on the product domain (HANDOFF, 2026-10-10):
  a mailbox on a **free trial that ends 2026-10-22** (keep-or-cancel decision due before then), with role forwards
  `info@` and `support@`; **DMARC is not configured yet**.
- **DECISION FOR TJ.**
  1. **The address.** Recommended: a **role address** on the product domain (for example the existing `info@`, or a
     new `sales@` or `procurement@` forward), never a personal mailbox, so it survives staff changes and does not
     publish a person's address. `[CONTACT EMAIL]`.
  2. **The name.** A role ("SUDS sales", "Licensing, AugustInnovations LLC") rather than a personal name.
     `[CONTACT NAME]`.
  3. **The web page.** `[CONTACT URL]`: for example the product domain's own page, if it will describe the
     offer, or the repository's procurement page.
  4. **Keep the mailbox** past the 2026-10-22 trial (the contact must not bounce after it is published).
- **Steps (Muse).**
  1. Before publishing: add a DMARC record for the product domain (start with `p=none` and a reporting address, tighten
     later), confirm SPF and the MX records, and send a test message to and from the role address.
  2. Prepare the change: the three fields in `public/procurement.json` and the matching static text in
     `public/procurement.html`; it goes out in the next release (the static site is published from a release), with
     `npm test` passing.
  3. On suds.systems, enter the same three values under Settings › Program › Security & procurement page.
  4. Set a monitored inbox rule: replies within the published SLA (2 business days, `procurement.json` `sla`).
- **Send to.** Nobody; this is publication.
- **Done when.** The procurement page, on the published site and on suds.systems, shows the three values, and a message
  to the address is answered.
- **Recorded in.** `public/procurement.json`; [README.md](README.md) (the paragraph on the contact block, which says
  "**Owner item:** fill the vendor's three"); [templates/COUNTY-RFI-ANSWERS.md](templates/COUNTY-RFI-ANSWERS.md) and
  QUESTIONNAIRE #6a and #49 where they say the contact is to be completed.

## 2. Counsel review of the licence and the agreements

- **Why it matters.** "What do I sign? A draft … none reviewed. Still nothing to sign." The evaluation gives a draft no
  credit until counsel has reviewed it. With item 1, about +0.25. `LICENSE` section 3 requires a signed agreement for
  every paid use, so no sale can close without it.
- **What already exists.** [`LICENSE`](../../LICENSE) (with section 2A, the free use of SUDS on this device);
  [templates/LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md](templates/LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md);
  [templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md); [templates/DPA-DRAFT.md](templates/DPA-DRAFT.md);
  [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md); [templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md](templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md);
  Muse's owner-side pilot agreement and BAA templates; the cover brief
  [templates/COUNSEL-REVIEW-BRIEF.md](templates/COUNSEL-REVIEW-BRIEF.md).
- **DECISION FOR TJ.** Which counsel (a California health-privacy and technology-contracts attorney), the budget, and
  the scope: all three sets at once, or the licence and subscription agreement with its BAA/QSOA first (the minimum to
  sign a paid pilot). Whether counsel waits for the entity (item 0) or advises on it.
- **Steps (Muse).**
  1. Complete the brief's `[BRACKETS]` that are facts the owner has confirmed; leave the rest as questions.
  2. Reconcile Muse's pilot agreement and BAA with the repository drafts (the table above) into a list of differences
     for counsel, rather than two competing texts.
  3. Collect two or three counsel candidates with a fixed-fee or capped quote for the scope; Tj chooses.
  4. Send the brief and the documents (links to the default branch, or a zip of the commit) once Tj approves.
  5. Turn counsel's mark-ups into a change to the templates, keeping the "DRAFT" banner until counsel signs off on a
     version, then replacing it with "Reviewed by counsel on `[DATE]`; version `[N]`" (never counsel's name unless
     they agree to be named).
- **Send to.** The chosen attorney.
- **Done when.** Counsel has returned written comments on each document in scope and the owner has accepted a version
  of the licence and subscription agreement with its BAA/QSOA exhibit to sign.
- **Recorded in.** The templates' banners; [README.md](README.md) *Organisational gaps* (the counsel row);
  [HOSTING.md](HOSTING.md) checklist item 11; QUESTIONNAIRE #6a; [PROCUREMENT.md](PROCUREMENT.md) *Vendor to-do list*.

## 3. An independent penetration test

- **Why it matters.** "The gating item" for county IT (evaluation, section 6): +0.25 to +0.5. The two tests so far were
  owner-authorised and run by the vendor's own development assistant, and are labelled not independent.
- **What already exists.** [../security/PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md) (the scope a county or the
  vendor commissions against); [../evidence/pentest-suds-systems-2026-10-08.md](../evidence/pentest-suds-systems-2026-10-08.md)
  (the vendor's own test); the vendor-neutral RFP [templates/PEN-TEST-RFP.md](templates/PEN-TEST-RFP.md); Muse's
  owner-side RFP with its vendor shortlist and recommended first send, ready since 2026-10-06 and **unsent**.
- **DECISION FOR TJ.** Approve sending Muse's RFP (and to which vendors), the budget, and the target environment:
  a staging copy of SUDS Server seeded with fictional data (recommended; PEN-TEST-SCOPE.md *Target*), or suds.systems
  itself (fictional data only, so acceptable, but a test there should not disturb what a county is shown).
- **Steps (Muse).**
  1. Check Muse's RFP against the in-repository one: same scope, rules of engagement, deliverables and retest.
  2. Prepare the target: a staging SUDS Server from the latest release, one account per role, local mode as in
     production, an API key, the audit export taken before testing.
  3. Send the RFP to the approved vendors; score the replies with the rubric in the RFP; Tj chooses and signs.
  4. During the test: be the contact for the agreed window; take the audit export again afterwards.
  5. Findings go to the maintainers as issues (critical and high at once, privately); fixes ship in releases; the vendor
     retests.
- **Send to.** The approved testing firms (by role: their sales or engagement contact).
- **Done when.** The tester's report and retest letter are received, every critical and high finding is fixed and
  retested, and the public summary is agreed with the tester.
- **Recorded in.** `docs/evidence/pentest-<vendor-neutral name>-<date>.md` (a summary and the retest letter, or the
  letter's attestation, as the tester allows; never exploit detail for unfixed findings); QUESTIONNAIRE #38;
  [HOSTING.md](HOSTING.md) item 8; [../security/THREAT-MODEL.md](../security/THREAT-MODEL.md); [README.md](README.md)
  *Organisational gaps*.

## 4. Code signing for the Windows server

- **Why it matters.** `suds.exe` and `suds-service.exe` in the Windows zip are unsigned (an empty Authenticode table), so
  Windows SmartScreen warns county IT and nothing ties the binary to the publisher. +0.1 to +0.25 with a county-like
  Windows run.
- **What already exists.** `release.yml`'s `windows-sign` job signs both executables **when the repository has two
  secrets**, `WINDOWS_CERT_PFX_BASE64` and `WINDOWS_CERT_PASSWORD`, and publishes the zip unsigned with a notice
  otherwise ([../RELEASE.md](../RELEASE.md), *Signing the Windows server*). The owner's steps are in
  [templates/CODE-SIGNING-SETUP.md](templates/CODE-SIGNING-SETUP.md).
- **DECISION FOR TJ.** An OV code-signing certificate from a certificate authority, or a cloud signing service; which
  provider; the budget. Two facts weigh on it: the publisher identity must be the entity of item 0 (an organisation
  certificate needs the entity to exist and be verifiable), and current industry rules keep code-signing private keys
  in hardware (a token or a cloud HSM), so a provider may not supply the exportable `.pfx` the workflow expects. In that
  case `windows-sign` needs a change to call the provider's signing tool: an engineering task for the maintainers,
  not a step for Muse.
- **Steps.** As [templates/CODE-SIGNING-SETUP.md](templates/CODE-SIGNING-SETUP.md): obtain, store as the repository
  secrets (or hand the maintainers the provider's integration details), re-run the release on its tag, verify.
- **Send to.** The certificate authority or signing service (Tj, as the applicant).
- **Done when.** A released zip's `suds.exe` and `suds-service.exe` verify (`signtool verify /pa`,
  `Get-AuthenticodeSignature` → `Valid`), and a Windows Server machine like a county's runs the install without a
  SmartScreen block.
- **Recorded in.** [../RELEASE.md](../RELEASE.md) *Signing the Windows server* (that signing is in use, the publisher
  name); QUESTIONNAIRE #39 ("Release artefacts are not signed either"); [../WINDOWS-SERVER.md](../WINDOWS-SERVER.md);
  a Windows run record in `docs/evidence/`.

## 5. CalOMS layout confirmation with a county

- **Why it matters.** The CalOMS Tx code values are verified against the DHCS dictionary, but the file's column names
  and layout are SUDS's own and unconfirmed; a county will not rely on an extract it cannot submit. +0.1 to +0.25.
- **What already exists.** [../compliance/CALOMS.md](../compliance/CALOMS.md) (the open item, and the DHCS *2026 CalOMS
  Tx and DATAR FAQ* to read first); [../evidence/caloms-dictionary-verification.md](../evidence/caloms-dictionary-verification.md);
  HANDOFF 2026-10-08 (the map of the export); the request
  [templates/CALOMS-CONFIRMATION-REQUEST.md](templates/CALOMS-CONFIRMATION-REQUEST.md); the published pilot tier says
  the file layout is "confirmed with your county".
- **DECISION FOR TJ.** Which county to ask (one already in conversation, or one whose CalOMS coordinator is reachable),
  and approval to send.
- **Steps (Muse).**
  1. Read the DHCS FAQ (the September 2026 version or newer) and note what it answers of the request's questions.
  2. Make the sample file: a fresh office server seeded with fictional clients (`node scripts/county-sample.js
     --register`), CalOMS switched on with a placeholder provider ID, then **Produce submission file** for one month,
     and check that every name in it is fictional before it leaves.
  3. Send the request with the sample to the county's CalOMS coordinator.
  4. Record the answer as the request says.
- **Send to.** A county CalOMS coordinator (the county behavioural-health department's CalOMS or data-reporting lead).
- **Done when.** The county confirms in writing the format its channel accepts, or lists the changes; the changes are
  made in a release; the open item in CALOMS.md is closed for that county.
- **Recorded in.** [../compliance/CALOMS.md](../compliance/CALOMS.md) (the open item) and a
  `docs/evidence/caloms-layout-confirmation-<county>-<date>.md` (the questions, the answers, who answered by role, the
  date; no personal contact details).

## 6. Insurance: cyber liability and technology errors and omissions

- **Why it matters.** Counties and CBOs require certificates of insurance; the agreement draft's section 12 says the
  licensor holds none and must not be signed with that clause filled in until policies are bound. +0.1, and a
  prerequisite of items 7 and 8.
- **What already exists.** [templates/INSURANCE-QUOTE-BRIEF.md](templates/INSURANCE-QUOTE-BRIEF.md) (the facts an
  underwriter asks for, with links to the evidence); [PROCUREMENT.md](PROCUREMENT.md) (the insurance a county contract
  usually asks for); [HOSTING.md](HOSTING.md) item 7.
- **DECISION FOR TJ.** After item 0: limits to quote (the county's or pilot customer's required limits, when known),
  broker, budget; whether to bind before the first paid pilot or only when a contract requires it.
- **Steps (Muse).** Complete the brief's confirmed facts; collect quotes from two or three brokers who place cyber and
  tech E&O for small software firms; compare on the questions in the brief; Tj binds.
- **Send to.** Insurance brokers (by role).
- **Done when.** Policies are bound and certificates can be issued.
- **Recorded in.** The agreement draft's section 12 drafting note; [HOSTING.md](HOSTING.md) item 7; QUESTIONNAIRE #6a;
  [README.md](README.md) *Organisational gaps*. Policy numbers and premiums stay outside the repository.

## 7. A reference pilot under a signed agreement

- **Why it matters.** +0.25 to +0.5, over months: a buyer asks who else runs it. "Insurance, references: None."
- **What already exists.** [PILOT-KIT.md](PILOT-KIT.md) (scope, measurement plan, exit plan, evaluation template);
  [COUNTY-KIT.md](COUNTY-KIT.md); [templates/CASE-STUDY-TEMPLATE.md](templates/CASE-STUDY-TEMPLATE.md); the published
  90-day pilot tier; Muse's pilot agreement and evaluation framework (owner-side).
- **DECISION FOR TJ.** Which prospective programme; paid at the published pilot price or otherwise; which deployment
  (office server self-hosted by the programme, or SUDS on this device, which needs no agreement); whether the
  programme agrees to be named as a reference.
- **Steps (Muse).** After items 1, 2 and 6: prepare the agreement from the reviewed template, the pilot plan from
  PILOT-KIT, the baseline measurements in week 0; track the plan; at day 90 the go/no-go and, with consent, a case study.
- **Send to.** The prospective programme's director (and its county sponsor, if any).
- **Done when.** A signed agreement, the pilot run with real data, the day-90 evaluation completed, and written consent
  to be named (or an anonymised reference).
- **Recorded in.** [README.md](README.md) *Organisational gaps* (pilots row); QUESTIONNAIRE #6a (references); a case
  study under `docs/market/` only with the programme's written consent.

## 8. A hosted offer and its price

- **Why it matters.** "CBO with no IT: No hosted offer, no hosted price." +0.25 once priced, insured and offered.
- **What already exists.** [HOSTING.md](HOSTING.md) (models, the 12-item checklist, a unit-cost model);
  [`deploy/fleet/`](../../deploy/fleet/README.md) (Option A: one Lightsail VM per tenant, tested against stand-ins only);
  the operator decision (AugustInnovations LLC, 2026-10-09); the published self-hosted tiers;
  [templates/HOSTED-OFFER-WORKSHEET.md](templates/HOSTED-OFFER-WORKSHEET.md).
- **DECISION FOR TJ.** The hosted price per programme; who is on call outside business hours (HOSTING.md item 6: one
  person cannot promise 24×7); the first real fleet run (the drill tenant, which awaits Tj's go and credentials).
- **Steps (Muse).** Fill the worksheet's inputs from real quotes and the drill tenant's actual bills; run the drill
  tenant on Tj's go; work through HOSTING.md's checklist; draft the hosted tier's text for `procurement.json` for Tj.
- **Send to.** Nobody until the offer exists.
- **Done when.** Every HOSTING.md checklist item is done and the hosted price is published.
- **Recorded in.** [HOSTING.md](HOSTING.md) (the status line and checklist); `pricing` in `public/procurement.json`;
  QUESTIONNAIRE #2.

## 9. Signed release tags and separate commit identities

- **Why it matters.** A county reviewer finds no accountable signature: tags are unsigned and made under the shared
  automation identity, which the assistants also commit under (evaluation, section 4; G7/F7). Small effect, but it
  removes a supply-chain question.
- **What already exists.** [../RELEASE.md](../RELEASE.md) *Signing a release tag* (an SSH or OpenPGP key, the
  allowed-signers file `docs/security/release-signing-keys`, `git tag -s`, `git tag -v`).
- **DECISION FOR TJ.** Make the key on the owner's own machine; the principal on the allowed-signers line (a role
  address or the owner's GitHub no-reply address, never a personal one); whether each assistant gets its own commit
  identity.
- **Steps.** Tj, per RELEASE.md steps 1–3; Muse prepares the documentation commit that publishes the key and its
  fingerprint (RELEASE.md, QUESTIONNAIRE #39, the procurement page) and switches the hand-off commands to `-s`.
- **Done when.** The next release's tag verifies with `git tag -v` against the published key.
- **Recorded in.** `docs/security/release-signing-keys`; QUESTIONNAIRE #39; [../evidence/RELEASE-HANDOFF.md](../evidence/RELEASE-HANDOFF.md).

## 10. suds.systems hygiene

- **Why it matters.** It is the box a county is shown. Its latest reported compliance run (2026-10-09, 1.25.3) has two
  fails: SSH open to the world, and the empty offsite copies fixed in 1.25.4 ([HOSTING.md](HOSTING.md),
  [../evidence/README.md](../evidence/README.md)).
- **What already exists.** HANDOFF's six post-upgrade steps (its entry "1.25.4 stamped"); deploy/linux's
  *Check your offsite backups*; [../evidence/README.md](../evidence/README.md) *What is still not here* (what to copy
  off the box and how to verify it).
- **DECISIONS FOR TJ.** (a) The directive naming the **upgrade to 1.25.4** (a tag or release order does not cover it).
  (b) Whether SSH stays open to `0.0.0.0/0` and `::/0` or is limited to an administration network; check first how the
  Lightsail browser terminal reaches the box, so narrowing it does not lock the operator out (the launch's finding cost
  a rebuild). (c) When LUKS is set up (before any real record: a rebuild onto an encrypted volume).
- **Steps (Muse, each on Tj's directive).**
  1. The upgrade to 1.25.4 and HANDOFF's six steps: escrow first, upgrade, count `status=31/SYS` in the journal, Back up
     now, compare offsite and local sizes, delete the unrepairable 0-byte files, compliance re-run, recovery drill from
     the offsite copy.
  2. Copy the signed compliance report and the drill report off the box, verify them
     (`npm run verify-compliance-report`, `verify-dr-report`) and commit them to `docs/evidence/` with a README.
  3. Two-step sign-in (MFA) on every administrator account (the compliance check reports 0 of 1).
  4. The owner-held escrow copy of `/etc/suds/credentials` and the backup passphrase, kept off AWS (snapshots in the same
     account are not escrow), and one **snapshot restore test**.
  5. LUKS on the data volume before any real data.
  6. DMARC for the domain (item 1).
  7. Housekeeping (the old release tree and launch-day files) and the pending reboot, as HANDOFF lists.
- **Send to.** Nobody.
- **Done when.** The compliance run after the upgrade has no fail other than any the owner accepts in writing, its
  signed reports are stored, and MFA, escrow and the restore test are done.
- **Recorded in.** `docs/evidence/` (the reports); [HOSTING.md](HOSTING.md) (the production install row);
  [../evidence/README.md](../evidence/README.md) *What is still not here*.

## 11. The real-iPhone check

- **Why it matters.** WebKit sign-in failures recur on CI (4 of 7 `main` runs after 1.25.3), and no run on a real
  iPhone has ever been recorded; iPhones are a primary target of the free device-only build. It is the one item that
  could move the device-only verdict on iPhone (evaluation, H1).
- **What already exists.** [../ADOPTION.md](../ADOPTION.md) §4 and the checklist
  [../evidence/REAL-DEVICE-CHECK-TEMPLATE.md](../evidence/REAL-DEVICE-CHECK-TEMPLATE.md).
- **DECISION FOR TJ.** Who runs it (the owner, or a pilot lead) and on which two iPhones.
- **Steps.** As the checklist; Muse collects the filled copy and screenshots and commits them.
- **Done when.** Two iPhones on the current release pass, or failures are recorded and reported.
- **Recorded in.** `docs/evidence/real-device-check-<date>-v<version>.md`; the evidence index; the flake register for
  any failure.

## 12. Sales collateral before the next opioid-settlement reporting cycle

- **Why it matters.** California's city and county opioid-settlement expenditure reports for a state fiscal year are
  due to DHCS on 30 September after the year ends (SFY 2025-26 was due 30 Sept 2026; the next is due **30 Sept 2027**,
  for SFY 2026-27); SUDS's funder
  reporting maps to that form (evaluation, section 7).
- **What already exists.** [../compliance/HARM-REDUCTION-REPORTING.md](../compliance/HARM-REDUCTION-REPORTING.md)
  sections 3–5; the draft [templates/OSF-REPORTING-ONE-PAGER.md](templates/OSF-REPORTING-ONE-PAGER.md). Muse's
  county brochure (owner-side): its HTML was revised to 1.25.0 wording, but **the PDF was not regenerated** and must not be
  sent as current; the six role pamphlets have **placeholders, not screenshots** (15 screens to recapture).
- **DECISION FOR TJ.** Approve the one-pager's wording for use; which counties to send it to, and when (ahead of the
  spring budgeting for the next cycle, not in September).
- **Steps (Muse).**
  1. Check the one-pager against the current DHCS online form and guidance for the cycle (the form changes).
  2. Regenerate the brochure PDF from the revised HTML; recapture the 15 pamphlet screenshots from fictional data on
     the current release, through a capture path that returns the image files.
  3. Keep every claim inside what the repository documents (no time saving or outcome a pilot has not measured).
- **Send to.** County behavioural-health and opioid-settlement coordinators, and CBO directors with settlement funds
  (by role), after Tj approves.
- **Done when.** The one-pager is approved and the brochure and pamphlets are current.
- **Recorded in.** The one-pager's "Checked against the DHCS form on `[DATE]`" line; the owner-side collateral folder.

## Other open items Muse holds

- The product-domain mailbox: keep or cancel before **2026-10-22** (item 1 needs it kept, or another role address).
- Verify the dedicated administrator account Tj created for Muse on suds.systems signs in (with two-step sign-in).
- Reconcile Muse's owner-side drafts with the repository documents (the table above), and keep one checklist: this page.

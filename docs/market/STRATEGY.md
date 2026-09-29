# SUDS go-to-market strategy (1.17.0)

**Status: the owner's strategy, written down and assessed, 29 September 2026.** It replaces nothing in the
rest of this pack until a row below says it is done. Everything described as *planned* is not in a released
version of SUDS. The 1.17.0 features are in progress on the development branch and are described as **planned
for 1.17.0** until that release is tagged; the next feature release waits for the freeze that ends
2026-10-27 ([docs/RELEASE.md](../RELEASE.md)).

The strategy has three parts:

- **Create** three things SUDS does not do today: an AI documentation copilot, opioid-settlement tracking with
  funder-facing outcome dashboards, and a real street-outreach mode.
- **Capture** four positions: the 42 CFR Part 2 layer beside any EHR, CalOMS automation as a county-wide wedge,
  the cross-organisation referral flow as a network, and pricing that reflects near-zero marginal cost.
- **Defend** with what public code cannot copy: county contracts, the referral network, a de-identified
  outcomes and benchmarking dataset, and the deployment service — the forward-deployed (FDE) model, in which
  the software is cheap and implementation is the paid work.

The first build is the AI copilot.

Each part below says what is built, what is planned, and an honest assessment. The companion documents are
[PRICING-OPTIONS.md](PRICING-OPTIONS.md) (pricing models for the owner to decide) and
[DATA-NETWORK.md](DATA-NETWORK.md) (the dataset and referral network as moats: a design, with the privacy
and legal analysis).

## Where SUDS stands (the starting line)

The independent market reviews of 1.16.2 and 1.16.3 rated SUDS **2.5 / 5** overall: **3.5 / 5** for a CBO pilot
with an IT partner, **1.5–2 / 5** for a county procurement or IT review. The software is ahead of the
organisation:

- Every organisational item that makes SUDS purchasable is *Not started* or *Drafts only*: legal entity,
  vendor registration, insurance, counsel review of the BAA/QSOA, DPA and SLA, a penetration test, an
  independent reviewer, the official reporting templates and a county sponsor
  ([README.md](README.md#organisational-gaps-owner-vendor--company)).
- The repository controls for releases are designed but not in force until the owner applies them
  ([docs/RELEASE.md](../RELEASE.md)).
- Least privilege is not the default, and the client record keeps no revision history (both 1.17.0
  candidates).
- There are no users yet, and so no measured time saving, support hours or willingness to pay.

No part of this strategy removes those items. Several make them more urgent: the copilot adds a data flow to an
outside AI provider, the dataset adds pooling across organisations, and the referral network adds organisations
that are not customers. **The organisational items are the critical path for every wedge below.**

## Segments

| Segment | Who buys | What they pay for | Fit today |
| --- | --- | --- | --- |
| **Harm-reduction and outreach CBOs** (roughly 3–40 staff; opioid-settlement, SOR / NDP, SABG prevention funding spent on outreach and distribution) | Programme director, from a grant line | Outreach, supplies and funder reporting; implementation and support | Core fit. Needs an IT partner or a county sponsor; SUDS is not hosted |
| **Counties as funders and sponsors** (county behavioural-health or public-health departments that allocate settlement money to CBOs) | County SUD / behavioural-health administrator; county IT gates it | Consistent outcome data from the CBOs they fund; a site licence or sponsored instances; implementation across CBOs | The "sell to the money" buyer. Procurement is 6–24+ months; nothing organisational is ready |
| **Treatment-adjacent programmes with an EHR** (county-contracted SUD providers that also do outreach, navigation or recovery support) | Programme director and county IT | Part 2-controlled work beside the EHR; a CalOMS extract where the EHR does not produce one | Optional modules exist; the CalOMS layout is not verified; no live EHR connection yet |
| **Organisations that receive referrals** (shelters, MAT clinics, recovery residences, hospital navigators) | Nobody at first: they are invited | Free participation in the referral flow | Planned only (see *Capture 6*) |

Out of scope, and still said plainly: DMC billing, e-prescribing, the treatment medical record and SABG
primary-prevention (PPSDS) reporting ([POSITIONING.md](POSITIONING.md), *The boundary*).

## Create

### 1. AI documentation copilot (first build; planned for 1.17.0)

**What it is to be.** A drafting assistant for SUD workflows: a worker's field note, a visit summary or a
structured note becomes a draft the worker edits and signs. The owner's constraints, which are the design:

| Constraint | What it means |
| --- | --- |
| **Office server only** | Not in SUDS on this device, and not from a device's offline copy. The office server makes the call, so the programme's server holds the audit record and the settings |
| **Off by default** | An administrator turns it on. A new install and an upgrade both start with it off |
| **Gated on a BAA / QSOA** | It cannot be enabled until the programme records that a business associate agreement and a 42 CFR Part 2 qualified service organisation agreement are in place with the AI provider |
| **De-identified before sending** | Names, dates of birth, phone numbers and other identifiers SUDS holds for the client are removed or replaced before the text leaves the server |
| **Drafts only** | Nothing the model writes is saved to the record on its own. A person reviews, edits and signs; the signature is the person's |

**What is built today.** Nothing that sends text to a model. What exists and the copilot can build on: the
review queue for imported notes (Pocket AI and OneNote notes are staged, reviewed and committed by a person,
[docs/IMPORTS.md](../IMPORTS.md)); structured note formats (SOAP, DAP, BIRP, GIRP) with signature and
countersignature; the audit log; field-level encryption.

**Assessment.**

- *Why first is right.* Documentation time is the complaint every outreach and SUD programme makes, and the one
  a pilot can measure (time from contact to signed note). It is visible in a first meeting, which the other
  wedges are not. It gives the FDE service a concrete deliverable (configuring prompts and note templates to a
  programme's funders).
- *Why it is the riskiest first build.* It is the first path by which client text leaves the programme's
  server for a third party. Every county privacy officer will ask about it first:
  - **De-identification of free text is not reliable.** Removing the identifiers SUDS holds (the client's name,
    date of birth, phone) does not remove a third party's name, a street corner, a nickname, a rare event or a
    date written in the note. Under HIPAA, text is de-identified only if it meets §164.514(b) (Safe Harbor's 18
    identifiers, including dates and small geographic units, with no actual knowledge of re-identification, or
    an expert determination). The honest description is **"identifiers SUDS holds are removed before sending;
    the rest of the text may still identify someone, which is why a BAA and QSOA are required"**, not "the AI
    never sees PHI". Say this in every buyer document.
  - **Part 2.** Sending a Part 2 record to an AI provider is a disclosure unless the provider is a qualified
    service organisation under a QSOA (42 CFR §2.11, §2.12(c)(4)). SUD counseling notes (§2.11) should be
    excluded from the copilot unless counsel says otherwise.
  - **Accuracy and liability.** A drafted note that is signed unread is the signer's note. The design answers
    this (drafts only, human signs); the pilot must measure how often drafts are changed, and training must say
    that the signer owns the content.
  - **Cost.** Model calls are the one cost that grows with use. See [PRICING-OPTIONS.md](PRICING-OPTIONS.md).
- *What must be true before it is sold.* Counsel has reviewed the BAA/QSOA template for an AI provider; the
  provider's terms (retention, training on inputs, region) are recorded; the outbound payload is audited
  without its content; a pilot has measured the time to a signed note, with and without the copilot.

### 2. Opioid-settlement tracking and funder-facing outcome dashboards ("sell to the money")

**What is built.** Settlement funds with the Exhibit E allowable use and the California High Impact Abatement
Activity per fund and per expenditure; the settlement expenditure report; a layout for DHCS's settlement
expenditure reporting form and for county templates; the funder report, the NDP log, the syringe services
summary and SUPRT-A completion rates, with exact submissions and screened publication releases
([docs/compliance/HARM-REDUCTION-REPORTING.md](../compliance/HARM-REDUCTION-REPORTING.md)). None of the layouts
has been checked against a current official template.

**What is planned (not scheduled).** A funder-facing view: a county or other funder sees, across the CBOs it
funds, spending by allowable use and outcomes (people reached, naloxone distributed, reversals, referrals
closed), without seeing a client.

**Assessment.**

- *Right buyer.* Counties and cities receive and allocate settlement money and report its use to DHCS; they need
  outcome evidence from the CBOs they fund. Selling the county a view of its grantees is a better sale than
  selling each CBO a tool, and it lets the county pay for the CBOs' instances.
- *Hard part is privacy, not charts.* A county view across CBOs is either (a) each CBO's exact submission, which
  the county receives today under its funding contract, or (b) a published dashboard, which must be screened.
  SUDS's publication screen refuses whole releases for some programme sizes (about 110–240 overdose events a
  year in sampled programmes; [README.md](README.md), *Deferred*), and it has had no independent statistical
  review. A public dashboard built on it inherits both. [DATA-NETWORK.md](DATA-NETWORK.md) sets out the design.
- *Dependency.* The value is the county's reporting template. Until the owner obtains a county settlement
  template and DHCS's current form, the layouts are "as SUDS understands them".

### 3. A real street-outreach mode (planned; not scheduled)

**What is built.** Anonymous outreach contacts that count in the funder report; Quick add (name only); phone
layout with one **+ Log** button; supplies drawn from a van or site; local mode, the offline copy, which syncs
with the office server on command, recommended by the setup wizard for a harm-reduction programme and off by
default ([docs/PLATFORM.md](../PLATFORM.md)).

**What "real" would add.** An offline-first flow designed around a contact that takes a minute: minimal
personal information by default (a participant code instead of a name, which is also the CDPH SSP norm and a
deferred schema change), a device that holds only what the worker needs rather than everything the worker may
see, and a sync that tolerates days without signal.

**Assessment.** It is the most differentiated of the three for harm-reduction buyers, and the one that fits the
product's privacy stance best: the least data collected is the least data to protect. Two cautions. First, a
device today holds every record its user may see, which under the 1.16.0 defaults is the whole programme; a
real outreach mode needs the least-privilege default (a 1.17.0 candidate) or a device scope of its own. Second,
offline sync is the area where most 1.16.x security findings were; each change to it needs the same review.

## Capture

### 4. Stop competing with EHRs: the Part 2 layer beside any EHR

**What is built.** A FHIR R4 read API and bulk export that enforce Part 2 consent; an encounter hand-off export
for services the EHR records or bills; consents that name the recipient; one disclosure gate with an accounting
of disclosures ([docs/integration/FHIR.md](../integration/FHIR.md), [docs/compliance/PART2.md](../compliance/PART2.md)).
**Not built:** inbound FHIR (a design placeholder), a live connection with any EHR or HIE, and any consent
service for records held in another system.

**Assessment.** This is the right boundary, and SUDS already says it is not an EHR. Two corrections to the
framing:

- SUDS is a Part 2 layer **for the records it holds** — the outreach, navigation and referral work around the
  EHR. It does not manage consent for records held in the EHR, and should not be described as if it did.
- "Any EHR" is a claim to earn one connection at a time. Say "a FHIR R4 feed with Part 2 consent enforcement;
  first live connection to be tested in a pilot" until one exists. No ONC certification is claimed or planned.

### 5. CalOMS automation as a county-wide wedge

**What is built.** CalOMS Tx admission, discharge and annual-update records captured in the workflow; SUDS's own
edit checks, with every problem listed by client code; an extract that holds back records with a fatal error;
the monthly provider activity report; the extract accounted as a disclosure required by law. **SUDS does not
submit to DHCS**: the county or provider uploads the files through its own channel
([docs/compliance/CALOMS.md](../compliance/CALOMS.md)).

**Assessment, stated precisely.** SUDS produces files checked by SUDS's own edits and intended for submission. It
does **not** yet produce "validated, submission-ready" files in the sense a county would take that to mean: the
layout, element names and code sets have **not been verified against the DHCS data dictionary**, CSV is produced
where the county's channel may need another format, and DHCS's own edits are authoritative. Until a county has
checked the layout and sent a real file through its channel, say "a CalOMS Tx extract with built-in checks, to
be verified against the DHCS data dictionary with the county". The wedge is sound in shape (every
county-contracted treatment provider reports CalOMS, and many do so by hand), but it:

- is a treatment-side wedge, while SUDS's core fit is harm reduction and outreach — it opens the
  treatment-adjacent segment, not the core one;
- depends on DHCS's processes and file specification, which SUDS does not control; a change there is a change
  to the wedge;
- competes with county EHRs that already submit CalOMS for their providers (keep CalOMS in the EHR where the EHR
  does it: [PILOT-KIT.md](PILOT-KIT.md), Q3).

### 6. The cross-organisation referral flow as a network effect (planned; not scheduled)

**What is built.** Referrals inside one programme to a verified resource directory, with a consent that must
name the recipient, warm hand-off, loop closure and an accounting of each disclosure. The recipient organisation
does not see anything in SUDS: loop closure is recorded by the referring worker.

**What is planned.** Secure referral links with invitations: the referring programme sends a link to an invited
organisation; the recipient accepts the referral and reports its outcome, so the loop closes from the receiving
side. Each organisation that joins to receive referrals is a potential customer.

**Assessment.** This is the only part of the strategy with a true network effect, and the hardest to build safely:
every referral link that names a client is a Part 2 disclosure, the recipient is bound by the redisclosure rule,
and a link is a bearer credential. The design questions (where the recipient's copy lives, how the recipient is
verified, what the link carries) are set out in [DATA-NETWORK.md](DATA-NETWORK.md). SUDS's single-server
architecture means each programme has its own server; a network across servers is new architecture, not a
feature.

### 7. Pricing that reflects near-zero marginal cost

The software's marginal cost is near zero. The cost of serving a programme is not: implementation, support, and
(if offered) hosting and assurance ([HOSTING.md](HOSTING.md), *Unit-cost model*), plus model calls for the
copilot. SUDS is MIT-licensed, so a per-user or site "licence" cannot be enforced on the code; what a price buys is
a service. [PRICING-OPTIONS.md](PRICING-OPTIONS.md) sets out the models and a worksheet for the owner.
[templates/PRICING.md](templates/PRICING.md) remains the published hypothesis until the owner decides.

## Moat: what public code cannot copy

| Moat | Why it holds when the code is public | State |
| --- | --- | --- |
| **County contracts** | A county contract, its security review and its sponsored CBOs take 6–24 months to win and are not forked with the code | None yet |
| **The referral network** | Organisations connected to each other are not copied by copying the software | Not built |
| **A de-identified outcomes and benchmarking dataset** | Data held under agreements with counties and CBOs, not in the repository | Not built; design and legal analysis in [DATA-NETWORK.md](DATA-NETWORK.md) |
| **The deployment service (FDE)** | Knowing how to stand up SUDS for a county's CBOs, map their grants and pass county IT is people and time | One person; no delivered engagement yet |

Public code is also a selling point, and should stay one: a county can inspect every line, and a programme can
keep running SUDS if the vendor disappears. The moat is everything around the code.

## The FDE model

**The idea.** SUDS is priced low; the paid work is forward-deployed implementation: discovery, deployment, data
migration, training and reporting setup, delivered on site or alongside a county's team. SUDS is the delivery
vehicle for a consulting practice.

**Why it fits.**

- It sells what SUDS buyers actually lack. Harm-reduction CBOs lack IT capacity, not software; counties lack
  implementation capacity across many small grantees.
- Services are fundable from grant administration and settlement lines in a way a software subscription often is
  not (to check with each funder).
- Each engagement feeds the product: every funder template obtained, every import mapped, becomes code.

**Where it strains.**

- **Capacity.** One person cannot run engagements, support, security fixes and a release process at once. The FDE
  model scales with people, and the owner's time is already the binding constraint. Decide early what a second
  person does (implementation, or review of sync, disclosure and audit) and how they are paid for.
- **Procurement.** Consulting services and software are bought differently by counties; a bundled offer may need
  to be split to pass purchasing ([PROCUREMENT.md](PROCUREMENT.md)).
- **Neutrality.** If the vendor both implements and runs the county's benchmarking, the county must be the data
  steward, not the vendor ([DATA-NETWORK.md](DATA-NETWORK.md)).

## Sequencing

| Step | What | Gate to the next step |
| --- | --- | --- |
| **0. Now (freeze to 2026-10-27)** | The organisational items in [README.md](README.md): entity, insurance, counsel review (now including the AI provider BAA/QSOA), repository settings in force, pen test commissioned, official templates requested, one county conversation | Counsel has the templates; repository controls in force |
| **1. 1.17.0** | The AI copilot, as specified above, planned alongside the 1.17.0 security candidates (least-privilege default, client revision history, publication for the refused band) | Released and tagged; the copilot's outbound payload reviewed |
| **2. First pilots with the FDE service** | Two or three CBOs under one county sponsor, delivered as paid implementation ([PILOT-KIT.md](PILOT-KIT.md), *County pilot with the FDE service*) | One accepted funder submission; measured time to a signed note; measured support and implementation hours |
| **3. County settlement view** | The funder-facing view for the sponsoring county, from the CBOs' exact submissions | County template in hand; counsel's view on the data flow |
| **4. Street-outreach mode** | Participant codes, minimal-PII capture, a device scope for field work | Least-privilege default released |
| **5. Referral links** | Invitations to one or two receiving organisations in the pilot county | Counsel's review of the design in [DATA-NETWORK.md](DATA-NETWORK.md) |
| **6. Benchmarking** | Aggregate benchmarks across the county's CBOs, county as steward | Expert determination or counsel-approved method; data use agreements signed |
| **Alongside** | CalOMS verification with a county that wants it | Dictionary obtained; a test file through the county's channel |

Why the copilot first, despite the risk: it is the only item a CBO director can see the value of in one meeting,
it is buildable inside the product's own boundaries, and its gate (BAA/QSOA, de-identification, drafts only) is
narrow enough to explain. The risk is managed by keeping it off by default and out of the harm-reduction pitch
until counsel and one pilot have looked at it.

## Built vs planned, exactly

| Capability | State on 29 September 2026 |
| --- | --- |
| Outreach, anonymous contacts, supplies, funder reporting, settlement report and DHCS/county layouts | **Built** (layouts not checked against current official templates) |
| Local mode (offline copy, office sync) | **Built**, off by default; the wizard recommends it for harm reduction |
| FHIR R4 read and bulk export with Part 2 consent; encounter hand-off | **Built**; no live EHR connection yet |
| CalOMS Tx capture, checks and extract | **Built; layout not verified** against the DHCS data dictionary; SUDS does not submit |
| Referrals with consent check and loop closure, inside one programme | **Built** |
| Note import review queue (Pocket AI, OneNote) | **Built** |
| AI documentation copilot | **Planned for 1.17.0** (in progress; not released) |
| Least-privilege default; client revision history | **1.17.0 candidates** |
| Funder-facing outcome view across CBOs | **Planned**, not scheduled |
| Street-outreach mode (participant code, minimal PII, field device scope) | **Planned**, not scheduled |
| Cross-organisation referral links with invitations | **Planned**, not scheduled |
| Inbound FHIR referrals | **Design placeholder** ([docs/integration/FHIR.md](../integration/FHIR.md)) |
| De-identified outcomes and benchmarking dataset | **Design only** ([DATA-NETWORK.md](DATA-NETWORK.md)) |
| Vendor-hosted tier | **Planned — not offered** ([HOSTING.md](HOSTING.md)) |

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| **Part 2 and HIPAA for the AI copilot** | First outbound flow of client text; free text is not reliably de-identified by removing known identifiers; the provider must be a business associate and a QSO | Off by default; BAA/QSOA gate; counseling notes excluded unless counsel says otherwise; honest wording ("identifiers SUDS holds are removed"); outbound calls audited without content; counsel review before any pilot uses it |
| **Part 2 and HIPAA for data pooling** | Pooling across organisations is itself a disclosure unless the data are de-identified to §164.514 or a Part 2 provision (§2.52 research, §2.53 audit and evaluation, §2.54 public health, de-identified) applies; small cells across CBOs can be differenced | County as steward; aggregate-only first; expert determination before any public benchmark ([DATA-NETWORK.md](DATA-NETWORK.md)) |
| **Single maintainer** | Every wedge, every engagement and every security fix goes through one person; most commits are AI-assisted and there is no independent reviewer | A second reviewer for sync, disclosure and audit; a second person for delivery; say "one person" to buyers, as the pack already does |
| **Public code** | Anyone may run SUDS without paying; a larger vendor may copy features | Price services, not code; the moat is contracts, network, data and delivery; public code stays a trust asset |
| **CalOMS dependence on DHCS** | The layout is unverified and DHCS owns the specification and the submission process | Say "to verify"; one county test file before selling the wedge; keep it optional |
| **Pricing vs support cost** | A low price per user does not cover business-hours support, implementation and assurance for small programmes; the copilot adds usage costs | Price services separately; measure support hours in pilots; floor per programme ([PRICING-OPTIONS.md](PRICING-OPTIONS.md)) |
| **Publication screen limits** | Public dashboards inherit the refused band and the absence of an independent statistical review | Funder views use exact submissions to the funder; public figures only after review |
| **Organisational readiness** | Nothing purchasable yet; county IT will ask for insurance, pen test and repository controls | Step 0 of the sequence, before any sale |
| **Scope creep toward an EHR** | The copilot, CalOMS and FHIR pull toward clinical depth | Keep *The boundary* in [POSITIONING.md](POSITIONING.md); qualify billing programmes out |

## Metrics to watch

| Area | Metric | Source |
| --- | --- | --- |
| Readiness | Organisational items done (of the list in [README.md](README.md)) | Owner |
| Pipeline | County conversations; CBOs in a sponsored pilot; signed implementation engagements | Owner |
| Copilot | Share of drafts signed with no edit, with minor edits, discarded; median time from contact to signed note, with and without; outbound calls audited; any identifier found in an outbound payload review (target zero) | Pilot metrics sheet; audit log |
| Copilot cost | Model cost per active user per month | Provider invoices |
| Settlement | Settlement dollars tracked in SUDS; share with an allowable use recorded; funder submissions accepted without rework | Settlement report; funder feedback |
| Outreach | Anonymous contacts and kits logged per worker-day; days offline before sync | Reports; sync log |
| Referrals | Referrals closed with an outcome within 30 days; (later) receiving organisations invited, and joined | Referral report |
| Delivery | Implementation hours per programme against estimate; support hours per programme per month | Vendor time log ([HOSTING.md](HOSTING.md)) |
| Revenue | Services revenue per engagement; support renewals; share of revenue from counties | Owner |
| Integrity | Records lost, shown to the wrong person, failed audit-chain checks (target zero) | Pilot metrics sheet |

## Rules that still apply

The rules at the end of [README.md](README.md) apply to this strategy: no certification claim, no time saving
before a pilot measures it, no hosting claim before it is offered, and "planned" with a release or "not
scheduled" for everything not built.

# The outcomes dataset and the referral network: design and legal analysis

**Status: a design. None of it is built.** This document describes how two of the moats in
[STRATEGY.md](STRATEGY.md) could work: a de-identified outcomes and benchmarking dataset across organisations,
and a referral network between organisations. It sets out the privacy and legal questions each raises. It is not
legal advice: every legal point below is for counsel to confirm, and the list at the end is what counsel must
review before any of it is built or sold.

## Why these are moats

The code is public. What cannot be forked with it:

- **Data held under agreements.** Outcomes across many programmes, held by a steward under data use agreements,
  let a county compare its grantees and a CBO compare itself with its peers. A competitor with the same code
  starts with none of it.
- **Connected organisations.** Each organisation that receives referrals through SUDS makes SUDS more useful to
  every organisation that sends them.

Both are only moats if they are trusted. A pooled dataset that leaks, or a referral link that exposes a
participant, ends the programme's relationship with its community and the county's with the vendor. The design
is therefore conservative by default.

## Part 1: the outcomes and benchmarking dataset

### The legal starting point

**Pooling records across organisations is itself a disclosure**, unless what is pooled is de-identified or a
specific provision permits it. The provisions that matter (counsel to confirm each, and their current text):

| Framework | What it says, in outline | Consequence for the design |
| --- | --- | --- |
| **HIPAA de-identification**, 45 CFR §164.514(a)–(b) | Information is de-identified by Safe Harbor (removing 18 identifiers, including dates more specific than the year and geographic units smaller than a state except the first three ZIP digits under conditions, with no actual knowledge of re-identification) or by an expert determination | Aggregates can be de-identified; record-level outreach data with dates and places generally is not, under Safe Harbor |
| **HIPAA limited data set**, §164.514(e) | Dates and some geography may be kept for research, public health or health care operations under a data use agreement | A possible route for research, not for a public benchmark |
| **HIPAA business associates**, §164.502(e), §164.504(e) | A business associate may de-identify PHI or provide data aggregation services only as its BAA permits | The vendor cannot build a dataset from customers' data unless each BAA says so |
| **42 CFR Part 2**, as amended in 2024 | Part 2's definition of de-identified follows HIPAA's §164.514(b) standard. §2.52 permits disclosure for **research** under conditions; §2.53 for **management audits, financial audits and programme evaluation**; §2.54 permits disclosure of **de-identified** records to a **public health authority**. Records that are not de-identified otherwise need written consent | The owner's strategy cited §2.52 and §2.54 as "research/audit" provisions; the audit and evaluation provision is §2.53, and §2.54 is the public-health one. A county public-health department receiving de-identified aggregates may fit §2.54; a benchmarking product run by the vendor does not fit any of them on its face |
| **California** | The Confidentiality of Medical Information Act (Civil Code §56 et seq.); Health and Safety Code §11845.5 on the confidentiality of records of DHCS-licensed or certified alcohol and drug programmes; the CCPA's provisions on de-identified patient information (Civil Code §1798.146–1798.148), including contract terms and a ban on re-identification | To verify with counsel: which applies to each CBO, and what contract terms a transfer of de-identified information needs |
| **Funding contracts** | County and state grant agreements often say who owns programme data and how it may be used | Read each; the county may already have the right to receive the data it needs |

Two practical points follow:

1. **Many harm-reduction CBOs are not HIPAA covered entities**, and some records are not Part 2 records. That does
   not make pooling free: state law, funding contracts and the programme's promises to participants still apply,
   and SUDS treats every programme's data with the same care ([POSITIONING.md](POSITIONING.md)).
2. **Aggregate counts are not automatically de-identified.** A count of 2 women over 60 who had an overdose in one
   ZIP code can identify someone. That is why SUDS screens small cells in publication releases.

### The basis: SUDS's publication release method

SUDS already has a statistical disclosure control (SDC) method for aggregate releases
([docs/HIPAA.md](../HIPAA.md#small-cells-in-aggregate-reports),
[docs/architecture/ADR-0009](../architecture/ADR-0009-publication-release.md)):

- every count of people below a threshold *T* is shown as `<T`;
- the funder report, NDP log and settlement report for a period are **one release**, audited together against
  an attacker who knows the method (the code is public), including every relationship between counts;
- a table the check cannot show protected is **withheld**, and a release that cannot be made safe is **refused**.

It is the right basis for pooled figures, with its known limits stated:

- **It is not an expert determination** and has had no independent statistical review. The pack says so, and
  any dataset built on it must say so until a review is done.
- **It refuses whole releases in a band** of programme sizes (about 110–240 overdose events a year in sampled
  programmes); pooled releases would meet the same behaviour at other sizes.
- **It protects one programme's release.** It does not model a reader who also has another release that
  overlaps: a county total published beside each CBO's own release lets a reader subtract. A pooled release must
  be audited together with every release it can be differenced against, or the component releases must not be
  published separately at the same granularity.

### Who holds the data: the county as steward

The natural steward is the **county** (its behavioural-health or public-health department), not the vendor:

- it funds the CBOs and usually already receives their exact submissions under its funding contracts;
- it may be a public health authority for §2.54 purposes (counsel to confirm);
- it is neutral between its grantees, and accountable to the public;
- it keeps the vendor in the role of processor under a BAA/QSOA and DPA, with no rights of its own in the data
  unless a contract grants them expressly.

A benchmark across counties, if ever wanted, is a later agreement between stewards, not a vendor database.

### Design, in three tiers

Build them in order; each tier needs the previous one to have worked.

**Tier 1: county aggregates from exact submissions.** Each CBO runs its funder submission for the period (exact
aggregate counts, no client-level data, as finance runs it today) and sends it to the county, as funding
contracts already require. A county-side view (planned) combines the submissions: spending by allowable use,
people reached, naloxone distributed, reversals, referrals closed. The county sees what it receives today, in
one place. **Nothing is published by this tier.** Anything the county publishes from it goes through the
publication screen, audited over the combined release.

**Tier 2: benchmarks.** Distributions across programmes (median, quartiles; rates per 100 people served rather
than counts), published only when:

- at least *K* programmes contribute to the figure (*K* [owner and counsel to decide]);
- no programme can be identified from its position without its written agreement;
- the combined release passes the publication screen, with the differencing point above addressed;
- an expert determination (§164.514(b)(1)) or counsel's approved alternative covers the method.

Each contributing CBO signs a data contribution agreement with the county: what is sent, how it is used, who
sees it, how long it is kept, and that re-identification is prohibited.

**Tier 3: a record-level de-identified research dataset.** Not recommended until Tiers 1 and 2 have run for a
year. Outreach records carry dates, places and rare events that Safe Harbor would strip and that make an
expert determination hard. If ever built: under §2.52 research conditions and an IRB or privacy board, or a
limited data set under a data use agreement, with the county as steward and a named researcher.

### What the design rules out

- **No unduplication across organisations** in Tiers 1–2. Counting a person once across CBOs needs a shared
  identifier or a shared blind-index key, which is identifiable data moving between organisations. Figures are
  "people served per programme", summed with a stated caveat, not unduplicated across programmes.
- **No vendor-owned dataset.** The vendor does not keep a copy for its own benchmarking product unless a
  contract with the steward grants it and counsel approves.
- **No identifiers in the pipeline.** Submissions carry aggregate counts only; client codes do not leave the
  programme.
- **No public figure without the screen.** An internal county view may show exact figures to authorised county
  staff; a public one never does.

## Part 2: the referral network

### What exists

Referrals inside one programme: the referral names a provider from the programme's resource directory; a Part 2
consent that names that provider must be on file; the referral passes the disclosure gate, which writes the
accounting record; the referring worker records the outcome. The recipient organisation uses nothing in SUDS
([docs/USER_GUIDE.md](../USER_GUIDE.md), *Referrals and resources*). An inbound FHIR referral path is a design
placeholder ([docs/integration/FHIR.md](../integration/FHIR.md)).

### What is released in 1.17.0: one-time secure referral links

What was built is narrower than the network below, and it departs from the conservative answers in the table
([docs/security/REFERRAL-LINKS.md](../security/REFERRAL-LINKS.md) has the design and threat model):

- **The link carries the referral itself**, not a sign-in: with a live Part 2 consent that names the recipient,
  the recipient opens a *packet* — the client's name, the reason for the referral as the worker wrote it and its
  urgency (phone and date of birth only if the worker ticks them) — behind a **six-digit access code** given
  separately, in a browser, with **no account and no MFA**. The first browser that gives the code claims the link;
  any other is refused. Links expire within 7 days and can be withdrawn. Without a consent, only a notice that
  names nobody can go.
- **Why a code and a first-browser claim rather than a sign-in.** Receiving organisations are not on SUDS and have
  no account on the sending programme's server; an external role with accounts, MFA enrolment and a directory of
  outside users is the larger build and the larger attack surface (option (a) below). The code, given by phone,
  means an intercepted or forwarded link alone opens nothing, and the claim limits it to one browser. The cost is
  that the recipient is identified by holding the link and the code, not by an account: the recipient named on the
  consent is accounted as the recipient.
- **The consent gate and the accounting are the ordinary ones**: checked when the link is made and again at each
  open; accounted when the recipient first opens it, to the recipient named when the link was made.
- **It is off by default.** "Secure referral links" is a programme setting an administrator switches on
  (Privacy & Part 2). **Counsel's review of this design as built is required before a programme switches it
  on** (*What counsel must review*, below), and the pack's rule stands: no referral link is used for real
  referrals before that review.
- **The office server must be reachable from the internet.** The recipient's browser opens the link on the
  sending programme's own server; an office server reachable only on the office network cannot serve one, and
  exposing it is a decision for the programme's IT and its risk register
  ([docs/DEPLOYMENT.md](../DEPLOYMENT.md)).

### What is proposed: the network, with invitations

The referring programme sends an invitation to a receiving organisation. The organisation's staff accept it and
can then receive referrals and report outcomes, so the loop closes from the receiving side.

### Design questions and the conservative answer to each

The conservative answers for the network. The one-time links above answer the first three differently, as they
say, and are gated on counsel's review instead.

| Question | Conservative answer |
| --- | --- |
| **Where does the recipient's copy live?** | Option (a): the recipient signs in to the *sending* programme's server with a narrow external role that sees only referrals addressed to its organisation. It fits SUDS's single-server architecture and keeps the record in one place. Option (b): SUDS servers exchange referrals with each other (federation). New architecture; later. Option (c): a FHIR `ServiceRequest` to the recipient's own system, as in the inbound design. Start with (a) |
| **What does the link carry?** | Nothing identifying. The e-mail or text says "you have a referral from [programme]" and links to a sign-in. No name, no reason, no date of birth in any message |
| **Who is the recipient?** | An organisation, verified by the sending programme when it sends the invitation (a named contact, confirmed out of band), and a person at it who signs in with MFA. A link alone never grants access |
| **Consent** | The existing rule: a Part 2 consent must name the recipient organisation. The invitation does not change it |
| **What is disclosed** | The minimum the referral needs, chosen by the worker; the disclosure gate records the accounting entry, as today |
| **Redisclosure** | Each disclosure carries the Part 2 notice prohibiting redisclosure (42 CFR §2.32) where it applies |
| **Outcome coming back** | The recipient's report of the outcome is a disclosure by the recipient. If it is a Part 2 programme, it needs its own basis (usually the client's consent to share the outcome with the referrer). The form asks for it |
| **Expiry and revocation** | Referral access expires when the referral closes or after a set time; revoking the consent or the invitation ends it; every access is audited on the sending server |
| **Abuse** | Rate limits on invitations; no directory of who is on the network visible to non-members; an organisation can be removed by the sending programme |

### Why it is hard

- It is the first time someone outside the programme would sign in to its server. The external role must be
  reviewed as carefully as the 1.16.x sync rules were.
- Receiving organisations are not customers and have no agreement with the vendor. The sending programme is
  responsible for them, and the terms must say so.
- A network across programmes' servers (option b) is new architecture and a new security boundary.

## What counsel must review

Before any tier is built for real use, and before any programme switches on the one-time referral links
released in 1.17.0:

1. Whether pooling each type of record (Part 2, HIPAA PHI, other) at the county is a disclosure, and on which basis
   it may be made: consent, §2.53 audit and evaluation, §2.54 public health (de-identified), §2.52 research, or the
   funding contract.
2. Whether aggregates screened by SUDS's publication method are "de-identified" for each framework, and what an
   expert determination would need to cover (the method, the threshold, differencing across releases).
3. The BAA/QSOA and DPA terms for the vendor's role: data aggregation, de-identification, and a prohibition on the
   vendor's own use unless expressly granted.
4. The county's status as a public health authority, and its authority to receive and publish grantees' data.
5. The data contribution agreement between each CBO and the county, including the re-identification prohibition
   and California's requirements for de-identified patient information.
6. The applicability of CMIA and Health and Safety Code §11845.5 to each type of programme.
7. For referral links: the one-time link design as built (a packet naming the client behind a six-digit code,
   no account, a first-browser claim, a server reachable from the internet), the notice with each disclosure,
   the consent to report an outcome back, and who is responsible for a receiving organisation's staff; for the
   network later, the external role's access.
8. For the AI copilot's interaction with either: copilot drafts are never pooled, and no free text enters the
   dataset.

## What would show it is working

| Measure | Target |
| --- | --- |
| Counties acting as steward under a signed agreement | At least one before Tier 2 |
| CBOs contributing under a data contribution agreement | All CBOs in a Tier 2 figure |
| Published figures that passed the screen over the combined release | All |
| Re-identification complaints or incidents | Zero |
| Referral loops closed by the receiving organisation | Rising share of all referrals closed |
| Receiving organisations invited, and later becoming customers | Tracked from the first pilot county |

# Counsel review brief: SUDS licence and customer agreements

> **DRAFT — a cover brief to be completed by the owner before it is sent; not legal advice.** Every `[BRACKET]` is for
> the owner to fill in outside this public repository (or to leave as a question for counsel). Nothing in it is a
> statement of fact about the business until the owner confirms it. It is item 2 of
> [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md).

**To:** `[COUNSEL NAME AND FIRM]` — a California attorney practising health-information privacy (HIPAA, 42 CFR Part 2,
the California Confidentiality of Medical Information Act) and technology contracts.
**From:** `[OWNER NAME, TITLE]`, `[LICENSOR LEGAL ENTITY]`. **Contact:** `[CONTACT EMAIL]`.
**Date:** `[DATE]`. **Scope and fee:** `[FIXED FEE / CAP AGREED]`.

## 1. What SUDS is

SUDS is proprietary case-management software for California substance-use-disorder (SUD) and harm-reduction programmes:
street outreach, naloxone and supply distribution, consent and disclosure accounting under 42 CFR Part 2, CalOMS Tx
reporting for treatment programmes, and funder reporting (opioid-settlement funds among them). It is not an electronic
health record and does not bill. Its licensor is `[LICENSOR LEGAL ENTITY — "AugustInnovations LLC" in LICENSE; see the
entity question in section 4]`. The source is publicly visible on GitHub
(<https://github.com/taugustincst/suds>); visibility grants no rights. Versions 1.24.0 and earlier were released under
the MIT licence and remain MIT for copies already received; from 1.24.1 the SUDS Proprietary Licence applies.

The licensor is a `[ONE-PERSON / N-PERSON]` business. It has `[NO CUSTOMERS YET / N CUSTOMERS]`, `[NO INSURANCE YET]`,
and no certification (no SOC 2, no HITRUST). Development is done with AI coding assistants under the owner's
direction; the owner `[DOES / DOES NOT]` hold the copyright in the code personally (see question L5).

## 2. The deployment models (who holds the data)

| Model | Who runs it | Who holds client records | Status |
| --- | --- | --- | --- |
| **SUDS on this device** | Nobody: a web app the licensor publishes on GitHub Pages; it runs in the user's browser | The user's own device only; the licensor receives none of it | Available; free for real use at its official address (`LICENSE` section 2A) |
| **Office server, self-hosted** | The programme, its IT partner, or its county, on its own infrastructure (Linux or Windows) | The programme | Available: 90-day evaluation with fictional data free; production needs a signed licence agreement (`LICENSE` sections 2 and 3) |
| **Hosted by the licensor** | `[LICENSOR LEGAL ENTITY]`, one cloud VM per customer on AWS (under the AWS business associate addendum) | The licensor, as business associate and Part 2 qualified service organisation | **Planned, not offered** ([../HOSTING.md](../HOSTING.md)) |

The licensor also runs one install of its own (suds.systems), with fictional data only; it is not a customer.

## 3. The documents, in priority order

Review links point at the repository's default branch; a zip of the exact commit can be supplied instead.

| # | Document | What it is | Status |
| --- | --- | --- | --- |
| 1 | [`LICENSE`](../../../LICENSE) | The SUDS Proprietary Licence: evaluation grant, the free-use grant for SUDS on this device (section 2A), everything else needs a signed agreement | In force since 1.24.1; written by the owner in plain English, never reviewed |
| 2 | [LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md](LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md) | The signed agreement `LICENSE` section 3 requires: office-server licence, the planned hosted service, the pilot, fees, data, termination, liability, insurance, escrow | Draft, unreviewed, unsigned |
| 3 | [BAA-QSOA-DRAFT.md](BAA-QSOA-DRAFT.md) | Exhibits B and C: a HIPAA business associate agreement (45 CFR 164.504(e)) and a Part 2 QSOA (42 CFR 2.11) | Draft, unreviewed |
| 4 | [DPA-DRAFT.md](DPA-DRAFT.md) | Data processing addendum | Draft, unreviewed |
| 5 | [SUPPORT-SLA.md](SUPPORT-SLA.md) | Support service levels (business hours; hosted terms only when offered) | Template, unreviewed |
| 6 | The owner's own drafts, held outside the repository: `[a 90-day pilot agreement template; a BAA template with a Part 2 section]` | Written separately; to be reconciled with 2 and 3 | Unreviewed. A list of their differences from 2 and 3 is attached: `[ATTACHMENT]` |
| 7 | [DATA-CONTRIBUTION-AGREEMENT-DRAFT.md](DATA-CONTRIBUTION-AGREEMENT-DRAFT.md) (optional, later) | A CBO-to-county agreement for aggregate figures | Draft; only when a county pilot needs it |

Background, not for review: [../PROCUREMENT.md](../PROCUREMENT.md) (how counties buy), [../../compliance/PART2.md](../../compliance/PART2.md)
(how SUDS maps the Part 2 rule), [../../HIPAA.md](../../HIPAA.md), [../HOSTING.md](../HOSTING.md),
[../../security/QUESTIONNAIRE.md](../../security/QUESTIONNAIRE.md), and the published prices and support terms
([`public/procurement.json`](../../../public/procurement.json)).

## 4. The questions

**The entity (first).**
- E1. The licence and the drafts name "AugustInnovations LLC". `[STATE WHICH ENTITY IS FILED, ITS NAME AND STATE OF
  FORMATION, OR THAT FILING IS PENDING]`. What must change, and in what order, so that the entity that signs customer
  agreements is the one that owns the software and the licence names it? Is a written assignment of copyright from the
  owner (and of any rights in contributions) to the entity needed, and what should it cover?

**`LICENSE`.**
- L1. Section 2A lets anyone use SUDS on this device at its official address free of charge for real records. Is the
  grant clear and limited enough (official address only; no copying, re-hosting or modification)? Does offering it
  free, with no agreement, create any duty to its users under HIPAA, Part 2 or the CMIA, given the licensor receives no
  records?
- L2. Are the warranty disclaimer (section 8) and limitation of liability (section 9) enforceable as written in
  California for a free grant and for the evaluation grant? Is anything needed for a public agency user?
- L3. The change from MIT (1.24.0 and earlier) to proprietary (1.24.1): is section 6's wording on earlier versions
  correct?
- L4. Is section 3's list of uses that need a signed agreement complete (for example, a county operating SUDS for
  several CBOs)?
- L5. Who owns code written with AI coding assistants under the owner's direction, and does anything need to be
  recorded or assigned?

**Licence and subscription agreement.**
- A1. Liability cap and exclusions (section 11): a structure that a small vendor can insure and a county will accept;
  which breaches (Exhibit B/C, confidentiality) sit outside the cap.
- A2. Data ownership and use (section 7): is 7.1–7.4 sufficient, including the bracketed choice on de-identified
  operational metrics?
- A3. Termination and data return (section 9): the export-on-termination terms for the office server (read-only use for
  a period) and the hosted service (export, read-only window, certified destruction), and retention under Part 2 and
  grant terms.
- A4. Insurance (section 12): the limits to require of ourselves once policies are bound; until then, how to word the
  clause honestly.
- A5. Source-code escrow (clause 14.3, bracketed): is it worth offering given the source is public; what an escrow
  should add (build and release know-how, a continuing-use licence); release conditions.
- A6. Public-agency terms (14.7): how to handle a county's own contract form, non-appropriation, audit rights and the
  California Public Records Act (8.2).
- A7. Warranty (10.1) and the compliance disclaimer (10.2): acceptable to buyers, and accurate.
- A8. The pilot (section 4): a flat-fee 90-day pilot credited toward the first annual plan, as published.

**BAA and QSOA.**
- B1. Is the QSOA language sufficient under 42 CFR 2.11 and 2.12(c)(4) as amended by the 2024 final rule (compliance
  date 16 February 2026), and is one combined document workable?
- B2. Breach notification: the deadlines and content to commit to under HIPAA, Part 2 (now aligned with the HIPAA
  breach rule) and California law (Civil Code 1798.82; Health and Safety Code 1280.15 where it applies).
- B3. CMIA (Civil Code 56 et seq.): anything the BAA must add for California medical information.
- B4. Subcontractors: the cloud provider under its own business associate addendum; anything the customer must be told
  or must approve.
- B5. When a BAA or QSOA is needed at all for a self-hosted office server the licensor's staff never reach, and for
  support sessions where they might.
- B6. Isolation "between tenants, not from the operator": how to disclose that the operator holds escrowed keys and
  root access on a hosted instance.

**DPA and SLA.**
- D1. Is a separate DPA useful for US public-sector buyers, or should it fold into the agreement?
- D2. US-only data residency and subprocessor terms.
- S1. Are the SLA's response targets and exclusions consistent with the agreement and with a one-person business; how
  to word service credits, if any.

## 5. Out of scope

- Corporate formation filings themselves, tax and accounting (the entity question E1 is in scope only as it affects
  the agreements and the licence).
- Opinions on whether SUDS's software features satisfy HIPAA or Part 2 (the documents describe controls; customers
  remain responsible for their compliance).
- The data contribution agreement (document 7) unless the owner adds it.
- Clinical-instrument licensing (DAST-10, ASAM), the AI copilot's data flow and the pooled-outcomes design: separate
  questions listed in [../README.md](../README.md) *Organisational gaps*, for a later engagement.
- Litigation, regulatory filings and any customer-specific negotiation.

## 6. What we ask back

Written comments (tracked changes or a memo) on each document in scope; a short list of anything that must change
before a first paid pilot is signed; and an estimate for later reviews of customer-specific changes.
`[DEADLINE]`.

## 7. Recording the result (owner and Muse, after the review)

The drafts are revised from counsel's comments; their banner changes only for a version counsel has reviewed
("Reviewed by counsel on `[DATE]`, version `[N]`"). Counsel's name appears only if counsel agrees. Status in
[../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md) item 2, [../README.md](../README.md) *Organisational gaps* and
[../HOSTING.md](../HOSTING.md) checklist item 11.

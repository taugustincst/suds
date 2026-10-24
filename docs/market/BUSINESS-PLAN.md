# SUDS business plan

**Owner:** AugustInnovations LLC. **As of:** 17 October 2026, SUDS 1.25.9.
**What this is:** the plan in one place: where SUDS stands, who buys it, what is sold, the order of work, the budget,
the risks and the measures. The detail behind each part is in the documents named in the last section. Figures marked
*estimate* are planning numbers, not quotes or forecasts. Nothing here is a claim to a buyer; the buyer documents say
what may be claimed ([README.md](README.md), *Rules for anyone using this pack*).

## 1. Summary

- **The software is ahead of the business.** In its first month SUDS became a broad, tested, accessible product. It
  covers outreach, harm reduction and SUD navigation, has a Part 2 consent layer, and supports CalOMS Tx and opioid-settlement
  reporting. What stops a buyer signing is organisational: agreements reviewed by counsel, insurance, an
  independent penetration test and a first reference.
- **The first buyers are county opioid-settlement administrators**, sponsoring harm-reduction pilots for programmes
  they already fund. County EHR replacement is not the target: SmartCare and the incumbent EHRs hold that ground.
  Settlement money is restricted, deadline-bound and reportable, which is exactly what SUDS reports on.
- **The order of work is fixed:** paperwork, then counsel and insurance, then the independent test, then the
  hosting drill, then pilots, then the first hosted customer. Every step from counsel onward costs money and weeks, so
  each starts as soon as the one before allows.

## 2. Where SUDS stands

| Area | State (October 2026) |
| --- | --- |
| Product | Released and tested: outreach on a phone (offline where allowed), supplies by lot, Part 2 consents and disclosures, funder and settlement reports, the county view, CalOMS Tx (code sets verified), passkeys, an optional AI copilot. 2,201 automated tests, a browser suite and 10,286 accessibility checks run on each code change |
| Ways to run it | SUDS on this device (free); the office server, self-hosted on Linux, Windows or Docker; vendor hosting, one isolated VM per customer (offered, no customer yet) |
| Release discipline | Weekly patches at most, a 28-day minimum between feature releases, an SBOM and two checksum channels per release; release approval and immutable releases on since 2026-10-13. Still to do: required review on `main`, tag and Pages rules, signed tags ([../security/OPERATIVE-CONTROLS.md](../security/OPERATIVE-CONTROLS.md)) |
| Security assurance | The vendor's own tests are published; the independent test is being procured; no certification |
| Legal and commercial | The LLC is registered; its overdue Statement of Information, the IP assignment and the agreements' counsel review are open; no insurance yet; prices and contacts are published |
| Customers | None yet: no pilot, no revenue, no reference |

Readiness, as the internal evaluations score it: **3.0 of 5** for market readiness. **3.5** needs a published contact
(done in 1.25.9), agreements reviewed by counsel and a completed independent test with its fixes released. **4.0**
adds code signing, a county-confirmed CalOMS layout, insurance and one reference pilot.

## 3. Market

| Layer | Organisations | Annual value (*estimate*, at the October 2026 list prices) |
| --- | --- | --- |
| All plausible California buyers | about 1,900 (counties, treatment providers, syringe services and outreach CBOs, ECM/CS navigators, health jurisdictions, tribal programmes) | far above what one vendor can serve |
| Those SUDS fits, with no mandated alternative | about 375 | small CBOs dominate; most cannot pay a full Program price from their own budget |
| Obtainable in three years by one small vendor | a few tens | capped by support capacity more than by demand |

The money is in counties' opioid-settlement allocations, which must be spent, accounted for and reported to DHCS each
year by 30 September. That is why the buyer is the county sponsor and the user is the programme it funds.
Purchase thresholds are low (many counties buy informally below $25,000–50,000), so the gates are in the contract:
insurance, agreements, security review and references. Outside California, Part 2, harm-reduction records and
settlement reporting carry over; CalOMS does not.

Segments, in order: (1) county settlement administrators sponsoring harm-reduction pilots; (2) syringe services,
naloxone and outreach CBOs, directly or under those grants, with the free device build as the way in; (3) treatment
programmes needing a Part 2 layer beside a non-SmartCare EHR; (4) ECM/CS navigators, health jurisdictions and tribal
programmes; (5) other states, after California references.

## 4. The offer

| Plan | Price | Covers |
| --- | --- | --- |
| SUDS on this device | Free | Real use at the official address; records stay on the device |
| 90-day pilot | $9,500 flat, credited in full | One site; onboarding, BAA and QSOA, CalOMS validation |
| Program | $24,500 a year | One site, 30 staff; hosting, updates, email support |
| Multi-Site | $49,500 a year | 5 sites, 150 staff; onboarding help |
| County-Wide | $98,000 a year | Unlimited within one county; training, a named contact |

Hosting is included: one AWS Lightsail VM per customer, with its own encrypted disk, database and keys, and never a
shared database ([HOSTING.md](HOSTING.md), [../../deploy/fleet/README.md](../../deploy/fleet/README.md)). Self-hosting
stays available. The published source of the prices is `public/procurement.json`.

## 5. The order of work

| Step | What | Who | Gate to the next |
| --- | --- | --- | --- |
| **A. Paperwork and controls** (now) | File the Statement of Information; confirm the tax standing; sign the IP assignment; file the Clinical Perimeter business name; finish the repository protections and make a tag-signing key | Owner | Filed and signed |
| **B. Assurance** (November–January) | Counsel reviews the licence, BAA and QSOA, DPA and SLA; cyber and technology E&O insurance is bound; an independent penetration test is run by a firm with no tie to the LLC, and its fixes are released | Owner engages and pays; the business assistant runs the processes; the development assistant fixes findings | Reviewed texts, a certificate of insurance and the test report in hand |
| **C. Prove the operation** (November–December) | Run the hosting drill end to end ([../../deploy/fleet/DRILL-RUNBOOK.md](../../deploy/fleet/DRILL-RUNBOOK.md)); prove a restore and the escrowed-key recovery on the vendor's server; run the real-iPhone check; publish a support and cover statement | Owner, with both assistants | Drill evidence recorded; the hosted-offer costs confirmed |
| **D. Settlement pilots** (letters from January 2027) | A shortlist of 5–10 counties; letters to their settlement coordinators ([templates/SETTLEMENT-PILOT-LETTER.md](templates/SETTLEMENT-PILOT-LETTER.md)); 90-day pilots with one to three programmes each, on fictional data first; the CalOMS layout and report templates confirmed with the sponsor | Owner | A signed pilot; then a day-90 decision and a written reference |
| **E. First hosted customer** (Q2–Q3 2027) | The first real tenant, provisioned the drilled way, under a signed BAA and QSOA with insurance in force; the first published reference | Owner | Running through one full drill cycle |
| **F. Scale** (from late 2027) | A second person for support, operations and release backup; then the referral network, de-identified benchmarking and EHR integration as buyers ask; other states after California references | Owner | References and capacity |

**Timing anchors.** County budgets are set in spring. The DHCS settlement report is due on 30 September each year, so a
pilot running by April 2027 can contribute to the 2027 report.

## 6. Product roadmap

The release rules hold: patches at most weekly (security fixes when ready), feature releases at least 28 days apart
([../RELEASE.md](../RELEASE.md)). The next feature release, 1.26.0, is built from evidence, not ideas: the independent
test's findings, what the drill and counsel's review require, the first county conversations, code signing, and the
PPSDS file once DHCS publishes its dictionary. Pilot-driven releases follow in 2027. Not before a buyer asks: the
referral network, benchmarking, a live EHR connection. Also planned: a secure-development statement that deals openly
with AI-written code, and static analysis in CI.

## 7. Budget for the next six months

| Item | One-off (*estimate*) | Yearly (*estimate*) |
| --- | --- | --- |
| Filings | $50–400 | — |
| Counsel review | $3,000–10,000 | — |
| Cyber and technology E&O insurance | — | $2,000–6,000 |
| Independent penetration test | $8,000–25,000 | about yearly after |
| Code signing | — | $100–500 |
| Drill and the vendor's server | under $100 | about $300 per VM |
| **Total** | **about $11,000–36,000** | **about $2,500–7,000** |

These are planning ranges from general market knowledge. Replace them with quotes before committing. The pilot is
priced to be easy to buy, not to fund this work (settled by the owner at $9,500 on 2026-10-24): the first annual plan it converts to
covers roughly the lower half of the up-front spend.

**Revenue outlook** (*estimate*, an inference rather than a forecast): $10,000–60,000 to the end of 2027 (1–3 pilots at
$9,500, 0–2 converting to a Program plan with the pilot credited); $50,000–150,000 a year in 2028 with references; $100,000–300,000 a year in 2029 only with a second
person. At these prices small CBOs rarely buy directly, so county sponsorship is the route.

## 8. Risks

| Risk | Response |
| --- | --- |
| Owner time is the scarcest input | Keep the order of work; the assistants prepare everything a decision needs |
| AI-written code with no human code reviewer | The independent test; a secure-development statement; static analysis; published tests and evidence |
| The licensor's own security practice is the same LLC | Never present the vendor's own tests as independent; the independent test comes from a firm with no tie to the LLC |
| Price against small CBO budgets | County sponsorship; the free device build as the entry |
| Hosting sold before it is proven | The drill runs before any hosted pilot is signed |
| Single maintainer and releaser | A backup operator or code escrow; a second person from 2028 |
| CalOMS layout owned by DHCS and the counties | "Code sets verified, layout confirmed with your county"; confirmed in the first pilot |
| Scope creep toward an EHR | Keep the boundary in [POSITIONING.md](POSITIONING.md); qualify billing programmes out |

## 9. Measures

| Measure | Now | By 31 March 2027 |
| --- | --- | --- |
| Market-readiness score | 3.0 | 3.5, with 4.0 in sight |
| Gates closed (entity, contact, counsel, insurance, independent test, drill) | contact done | all six |
| Repository controls in force | private reporting, checksums, release approval, immutable releases | all, signed tags included |
| County conversations / letters sent | 0 / 0 | at least 5 / 10 |
| Signed pilots | 0 | 1–2 |
| Integrity: records lost or shown to the wrong person | 0 | 0 |

## 10. Open decisions for the owner

Counsel and insurer; the penetration-test firm and budget; code signing (certificate or service); moving `main` to a
pull-request flow so that review and checks can be required; a backup operator or code escrow; whether to keep the
prices once the drill gives real costs; the first county shortlist.

## Where the detail is

[BUSINESS-WORKPLAN.md](BUSINESS-WORKPLAN.md) (each owner action with its steps) · [STRATEGY.md](STRATEGY.md) (the
go-to-market strategy and what is built) · [POSITIONING.md](POSITIONING.md) · [HOSTING.md](HOSTING.md) ·
[PILOT-KIT.md](PILOT-KIT.md) · [COUNTY-KIT.md](COUNTY-KIT.md) · [DATA-NETWORK.md](DATA-NETWORK.md) ·
[../security/OPERATIVE-CONTROLS.md](../security/OPERATIVE-CONTROLS.md) · [../BROCHURE.md](../BROCHURE.md) ·
[../TECH-SPECS.md](../TECH-SPECS.md)

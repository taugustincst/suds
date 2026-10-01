# SUDS pricing options (for the owner to decide)

**Status: options, not a price list.** Nothing here is decided, quoted or offered. Every value in the worksheet
is **[owner to decide]**. Until the owner decides, the published hypothesis is
[templates/PRICING.md](templates/PRICING.md) (free software; implementation and support at flat annual amounts
per programme), and it too is unvalidated: no programme has paid for SUDS yet.

The strategy asks for pricing that reflects near-zero marginal cost: per user at a fraction of incumbents, or a
county site licence ([STRATEGY.md](STRATEGY.md), *Capture 7*). This document sets out the models that could do
that, what each one actually charges for, and what the owner must decide.

## First principles

1. **The code is MIT-licensed and public.** Anyone may run it without paying. A per-user price or a site
   "licence" therefore cannot be a licence to the code; it can only be the price of a **service**: support,
   updates applied, hosting (when offered), the AI copilot's operation, an SLA, reporting setup, a named
   contact. Changing the licence is possible for future code but not for what is already released, would
   contradict the "you can keep running it without us" promise that county IT values, and is not recommended.
2. **Software marginal cost is near zero; delivery cost is not.** The unit-cost model in
   [HOSTING.md](HOSTING.md) puts routine operations and support at roughly 3–6 hours a programme a month (an
   assumption until pilots measure it), and the fixed costs of assurance (insurance, pen test, SOC 2 if pursued,
   counsel) at tens of thousands of dollars a year. Those are the costs a price must cover.
3. **The AI copilot has a real marginal cost.** Model calls are paid per use. They are small per note, but they
   grow with users and with how much each user drafts, so the copilot cannot be priced as if it were free.
4. **Buyers pay from grants.** Most CBO spending comes from grant lines with administrative caps and
   allowability rules. A price must fit a line the funder allows and, ideally, a small-purchase threshold
   ([PROCUREMENT.md](PROCUREMENT.md)). A county pays from its own budget or its settlement allocation.
5. **Services are the product under the FDE model.** Implementation is where the value and the hours are; it is
   priced as its own offer, not hidden inside a subscription ([STRATEGY.md](STRATEGY.md), *The FDE model*).

## How incumbents price, in general terms

Case-management and EHR vendors that sell to behavioural-health programmes commonly combine:

- a recurring fee per user (named or concurrent) or per organisation tier;
- one-time implementation fees, often large relative to the first year's subscription;
- paid add-ons for modules, interfaces, state reporting and custom reports;
- multi-year contracts.

No competitor price is cited here. Any figure used in a sales conversation must come from the buyer's own quote
or a public source, marked **to verify** with the source and date. "A fraction of incumbents" is a claim to make
only against a figure the buyer has given.

## The models

### A. Per active user (monthly subscription to a service)

| | |
| --- | --- |
| **Structure** | A monthly price per **active user**: a person who signed in during the month. Inactive accounts cost nothing. Optional floor per programme |
| **What it buys** | Business-hours support, update assistance, security notices, questionnaire answers; the copilot as an add-on (model E) |
| **For** | Programmes whose staff count changes with grants and seasons; buyers used to per-seat pricing |
| **Against** | Discourages adding part-time outreach workers and volunteers, the users SUDS most wants; staff count is a weak proxy for support effort (a 5-person programme with three grants can take more support than a 20-person one with one); without a floor it does not cover a small programme's support |
| **Mitigations** | A floor per programme; read-only, finance and volunteer accounts free or reduced; count active users, not accounts |

### B. Per organisation, in tiers

| | |
| --- | --- |
| **Structure** | A flat annual price per programme, by tier. Tiers by staff band (for example up to 15 and up to 40, as in [templates/PRICING.md](templates/PRICING.md)), or by number of funding sources reported |
| **What it buys** | As A, for the whole organisation |
| **For** | One predictable grant line; adding a worker costs nothing; closest to the current hypothesis |
| **Against** | Tier edges invite arguments; small programmes may still find it high; less upside as a programme grows |
| **Note** | Funding sources reported may track support effort better than headcount; pilots should test it |

### C. County site licence (a county pays for N CBOs)

| | |
| --- | --- |
| **Structure** | A county pays one annual amount covering support (and, when offered, hosting) for up to N CBOs it funds, with a price per additional CBO. Implementation for each CBO priced separately (model D) or as a per-CBO allowance inside the licence |
| **What it buys** | Support for each CBO; a county contact; one security review for all of them; and the **county view** across the CBOs (released in 1.18.0; [../COUNTY-VIEW.md](../COUNTY-VIEW.md)): the county's own SUDS server (a county-only install: no client data on it) set up with the county code and each CBO's key, key exchange at each CBO's kickoff, help importing the signed quarterly files, and support for the combined view, its quarter-by-quarter trend and its Excel, CSV and tidy CSV files. Publishing combined figures is in it on a build that has the publication screen (1.21.0: screened releases of the combined figures, naming only CBOs whose written consent to publication the county recorded, released in 1.22.0). Not in it: a published dashboard, benchmarks across CBOs (Tier 2). County-entered figures for grantees not on SUDS are released in 1.20.0: in it only on a build that has them |
| **For** | "Sell to the money": one buyer, one procurement, many programmes; CBOs without IT capacity get a sponsor; the county gets consistent outcome data |
| **Against** | Long procurement; the county may expect hosting, which is not offered; one contract concentrates revenue; the county, not the vendor, must be the data steward for any benchmarking ([DATA-NETWORK.md](DATA-NETWORK.md)) |
| **Note** | "Licence" is the buyer's word; the contract is for services. Say so in the proposal, to avoid a county expecting rights it already has under MIT |
| **The package** | What the county runs, what each CBO does, a 3-CBO timeline and the documents a county asks for: [COUNTY-KIT.md](COUNTY-KIT.md). Price nothing from it: every number here is [owner to decide] |

### D. Implementation and FDE services, packaged separately

Priced per engagement, fixed-fee where the scope is clear, time-and-materials where it is not. Each package has
a defined deliverable and an acceptance test.

| Package | Scope | Deliverable / acceptance | Pricing basis |
| --- | --- | --- | --- |
| **Discovery** | Workflows, funders and their templates, current data, IT and privacy constraints; eligibility check ([PILOT-KIT.md](PILOT-KIT.md), section 2) | Written scope, data map, go/no-go | Fixed fee per programme or per county |
| **Deployment** | Install with the IT partner or county IT; setup wizard; TLS, SSO, backups; hardening checklist; restore drill | Server live; restore drill timed | Fixed fee; more for county-hosted with SSO |
| **Data migration** | Spreadsheet or system export mapping; import; spot checks | Import reconciled against source row counts | By volume and number of sources |
| **Training** | Navigators, supervisors, finance, administrator; super-user coaching | Every pilot user signed in with MFA | Per session or per programme |
| **Reporting setup** | Funding sources and budget lines; each funder's template checked against SUDS's output; settlement categories; (when released) copilot templates | First month-end report reconciled with the programme's own | Per funder template |
| **County roll-out** | The above for N CBOs under one county, plus the county's view | Each CBO live; county sign-off | Per CBO, with a county programme-management fee |

Custom work (a new funder layout, an import from another system) is quoted per job and contributed back to the
public code, as today.

### E. The AI copilot as an add-on (when released)

| Option | Structure | For | Against |
| --- | --- | --- | --- |
| **E1. Included** | In the support subscription | Simple | Cost grows with use, not price |
| **E2. Per active copilot user** | A monthly add-on per user who drafted at least one note | Tracks cost; optional | Another meter |
| **E3. Pass-through** | The programme holds its own agreement with the AI provider and pays it directly; SUDS charges only for setup | No usage risk for the vendor; the programme owns the BAA/QSOA with the provider | More paperwork for small programmes |

E3 fits the design (the programme records its BAA/QSOA before enabling it) and removes usage risk; E2 suits
programmes that cannot contract with an AI provider themselves.

### F. Support tiers

| Tier | What | Notes |
| --- | --- | --- |
| **Community** | Public code, documentation, public issue tracker; no response target | Free; always available |
| **Standard** | Business-hours support per [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md); upgrade help; security notices; questionnaire answers | The base of models A–C |
| **Enhanced** | Standard plus a quarterly review, a named contact, faster business-hours targets, help with each release's upgrade | Only when capacity exists to honour it |
| **Hosted** | Vendor-hosted single-tenant instance plus Enhanced | **Planned — not offered** until the [HOSTING.md](HOSTING.md) checklist is done |

No tier may promise 24×7 support or an uptime figure until [HOSTING.md](HOSTING.md) says it is offered.

## How the models combine

The models are not exclusive. A plausible shape, for the owner to test rather than adopt:

- **CBO direct:** B (tier) or A (per active user with a floor) for support, plus D for implementation.
- **County:** C for the county's CBOs, plus D's county roll-out, with E3 for the copilot.
- **Everyone:** F's Community tier stays free.

## Worksheet

Fill in, then test with the first pilots. Keep the reasoning next to each number.

### Costs to cover (from pilots; see [HOSTING.md](HOSTING.md))

| Input | Value | Source |
| --- | --- | --- |
| Support hours per programme per month (measured) | [owner to decide] | Pilot ticket log |
| Implementation hours per programme (measured) | [owner to decide] | Vendor time log |
| Loaded hourly cost of delivery | [owner to decide] | Owner |
| Annual fixed assurance costs (insurance, pen test, counsel, SOC 2 if pursued) | [owner to decide] | Quotes |
| Expected number of supported programmes in year 1 | [owner to decide] | Pipeline |
| Copilot model cost per active user per month (measured) | [owner to decide] | Provider invoices |

### Model choice

| Decision | Value |
| --- | --- |
| Primary model for CBOs (A, B or both) | [owner to decide] |
| Primary model for counties (C) | [owner to decide] |
| Copilot pricing (E1, E2 or E3) | [owner to decide] |
| Support tiers offered at launch (F) | [owner to decide] |

### Model A: per active user

| Parameter | Value |
| --- | --- |
| Price per active user per month | [owner to decide] |
| Floor per programme per month | [owner to decide] |
| Roles free or reduced (read-only, finance, volunteers) | [owner to decide] |
| Definition of "active" | [owner to decide] (suggested: signed in at least once in the calendar month) |

### Model B: per organisation

| Tier | Boundary | Annual price |
| --- | --- | --- |
| Small | [owner to decide] | [owner to decide] |
| Medium | [owner to decide] | [owner to decide] |
| Large | [owner to decide] | [owner to decide] |

### Model C: county site licence

| Parameter | Value |
| --- | --- |
| CBOs included (N) | [owner to decide] |
| Annual amount for N | [owner to decide] |
| Price per additional CBO | [owner to decide] |
| Implementation included per CBO (hours or packages) | [owner to decide] |
| Contract length | [owner to decide] |

### Model D: services

| Package | Fixed fee or T&M | Price or rate |
| --- | --- | --- |
| Discovery | [owner to decide] | [owner to decide] |
| Deployment | [owner to decide] | [owner to decide] |
| Data migration | [owner to decide] | [owner to decide] |
| Training | [owner to decide] | [owner to decide] |
| Reporting setup (per funder template) | [owner to decide] | [owner to decide] |
| County roll-out (per CBO; programme-management fee) | [owner to decide] | [owner to decide] |

### Checks before quoting any number

- [ ] Covers measured support and implementation hours at the loaded rate, with the fixed costs spread across
      realistic year-1 volume.
- [ ] A small programme's total fits a grant line its funder allows and, if possible, its small-purchase threshold.
- [ ] Any comparison with an incumbent uses a figure the buyer gave, marked to verify.
- [ ] The proposal says the code is MIT-licensed and what the price buys instead.
- [ ] [templates/PRICING.md](templates/PRICING.md) updated to match the decision, and the "unvalidated" label kept
      until three pilots have paid.

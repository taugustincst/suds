# Supplies and syringe services

SUDS keeps a harm-reduction programme's supplies the way a syringe services programme (SSP) or a naloxone
distributor runs its cupboard: by item, at each site, in lots with an expiry date, with every movement in and out
recorded. Before 1.14 the cupboard was one number per item, and a visit drew down only naloxone kits and fentanyl
test strips.

Code: `server/supplies.js` (the model), `server/supply-names.js` (categories, products, sources, reasons),
`server/routes/supplies.js` (the Supplies routes), `server/routes/interventions.js` (a visit's supplies),
`server/ssp-report.js` (the SSP summary), `public/views/supplies.js` and the visit form in
`public/views/interventions.js`. Schema: migration 45 (`supply_sites`, `supply_items`, `supply_ledger`,
`intervention_supplies`, and four columns on `interventions`).

## Items, sites and lots

* **Items** have a category — naloxone, fentanyl test strips, xylazine test strips, syringes, sharps containers,
  cookers, cottons, alcohol pads, pipes and safer-smoking kits, wound care, condoms, hygiene kits, other — and a unit
  (kit, strip, syringe, container…). Naloxone items carry the **product** (nasal spray 4 mg, 8 mg or 3 mg;
  injectable 0.4 mg/mL vial or ampule, 0.4 mg prefilled syringe; other), which the NDP log reports. Syringes are one
  item per size ("Syringes 1 mL 29G"). An item marked *usual* is on every visit form, one tap away. An item can have
  a *running low at* level per site. Items are taken out of use, never deleted: their history stays.
* **Sites** are where stock is kept: the office, a van or mobile unit, a drop-in centre, a partner site. Every install
  starts with *Main office* (id `site-main`, the same on an office server and every device). A worker chooses the
  site their visits draw from (Supplies → *Your visits draw from*); otherwise the programme's default site.
* **Lots**: stock received with a lot number and an expiry date is kept by lot. What is on hand is per item, site
  and lot. Lots expiring within the warning window (60 days by default) and expired lots are flagged on the Supplies
  page and, for supervisors and administrators, on Home.

## The ledger

What is on hand is the sum of an **append-only ledger** (`supply_ledger`); a row is never changed or deleted, and a
mistake is corrected by another row. Each row records who, when (`occurred_on`), the item, the site, the lot and
expiry, and a signed quantity:

| Entry | When | Who |
| --- | --- | --- |
| Opening balance | An item's stock when it is first recorded; migration 45 carries each 1.13 count in as one, at the main office | supplies:manage |
| Received | A delivery: date, lot, expiry, source (DHCS Naloxone Distribution Project, CDPH syringe services supply clearinghouse, purchase with a fund, donation, other) and a reference (order or shipment number — no names) | supplies:receive |
| Transferred out / in | Stock moved between sites: a pair sharing a transfer id, per lot (the earliest-expiring stock moves first unless a lot is named) | supplies:manage |
| Adjustment | With a reason: count correction (enter what was counted, SUDS records the difference), damaged, expired, lost, other. Never below zero | supplies:manage |
| Disposed of | Expired, damaged or recalled stock destroyed; the whole lot unless a quantity is given | supplies:manage |
| Handed out on a visit / put back | A visit's draw-down, and its corrections (below) | interventions:write |

Permissions: `supplies:read` (see the stock, lots and history) and `supplies:receive` are held by navigators and
clinicians; supervisors and administrators hold `supplies:*` (`supplies:manage`: items, sites, settings,
transfers, adjustments, disposal). Finance and read-only accounts do not see the cupboard. Every change is audited
(`supply.*`); no supply row holds anything about a client.

## Visits hand supplies out

**Hand out** on the Supplies page (and on each item's row) is the way to record supplies given on the street,
to someone who gives no name: it opens the visit form preset to a naloxone distribution (or to outreach, for an
item that is not naloxone), with the item on it and the site chosen above, and the client left optional. It is an
ordinary visit, so the stock, the NDP log and the funder report count it like any other.

**Street outreach** (1.17.0; **+ Log → Street outreach contact**) is the same thing for a worker in the field logging
contact after contact on a phone: − count + for naloxone, test strips, syringes, wound care and the usual items (any
other item one choice away), the site the supplies came from, and a place. Each contact is an anonymous visit with
those items, drawn from the site's stock by the same rules, on a device too (offline, and again at the office once
it syncs), and *My shift* adds up what the worker has handed out ([USER_GUIDE.md](USER_GUIDE.md#street-outreach)).

The visit form lists the programme's usual items as rows with a − count + stepper; any other item is one choice
away, and anonymous outreach contacts use the same list. The visit records every item handed out
(`intervention_supplies`), the site the stock came from, and the **syringes and sharps brought back**: a count, or an
estimate from the container's volume at the programme's syringes-per-litre (Supplies → Items & sites → Settings;
100 by default — set your programme's own conversion).

* **Draw-down, first expiry first.** Saving a visit takes its items off its site's stock, the lot that expires first
  first (expired stock only when nothing else is on the books). Editing it takes or puts back the difference;
  deleting it puts everything back; moving it to another site puts the stock back there and takes it here. Saving
  the same visit again draws nothing more.
* **Never below zero.** A worker in the field does not stop because the books are behind. When a site's books hold
  less than was handed out, the rest is recorded as a **shortfall**: an adjustment that adds the missing stock,
  flagged for a supervisor (Home, and Supplies → History → *Shortfalls only*), and the draw-down against it.
* **Kits and strips with no item behind them.** While the programme keeps no naloxone kit or fentanyl test strip
  item, the visit form's *Supplies given* list still has a row for them (*not taken off stock*) and says, before the
  visit is saved, that they count on the visit and in reports but come off no stock; someone with `supplies:manage`
  on a copy that owns its configuration (`GET /api/supplies/catalog` `can_configure`) gets **Add naloxone kits and
  test strips** right there, which adds the items and moves what was entered onto them. The list is the one place
  kits are entered whenever the programme keeps any item; the two plain number fields appear only when it keeps
  none. The toast after saving stays as a fallback (1.14.0).
* **The naloxone and test strip counts every report reads** (`interventions.naloxone_kits`,
  `interventions.fentanyl_strips`) are the sums of the visit's naloxone and fentanyl test strip items. A request that
  sends only the counts (the API, a spreadsheet import, a device on an older kernel) still works: the counts move the
  visit's items, drawn from that category's usual item. Visits recorded before 1.14 keep their counts; their kits
  were already off the old count, so they are carried as *untracked* and never drawn again, and editing such a
  visit draws only what is new. The funder report, the NDP log and the settlement report give the same figures for
  them as before (test/supplies.test.js).

## Syringe services summary

Supplies → *SSP report* (the syringe services program report; and Reports → Harm-reduction reporting): for a period, participants served,
contacts (visits and anonymous outreach at which supplies were handed out or sharps brought back), syringes
distributed and returned and the returns per syringe distributed, sharps containers, naloxone by product, fentanyl
and xylazine test strips, the other supplies, and referrals made, by month and by site, as CSV or Excel
([HARM-REDUCTION-REPORTING.md](compliance/HARM-REDUCTION-REPORTING.md)). Counts of people are small-cell suppressed as
in the funder report; supply counts are not counts of people. It is the programme's own submission, never a
publication release. The layout follows what a CDPH-authorised SSP reports as SUDS understands it: check it against
your current reporting requirements before submitting it.

## On a device

Items, sites and the supply settings are the office's (pull-only). Stock received, moved, counted or disposed of on
a device is pushed to the office, which checks it as the routes do (the item and site exist, quantities have the
right sign, the role may record it) and records a flagged shortfall rather than refusing a movement that took a lot
below zero there. A visit recorded offline draws the device's own copy down at once, so the stock shown in the field
is right; those rows are provisional and never pushed. The office works the draw-down out from the visit, against
its own stock, and when its rows for the visit arrive the device's own are replaced (`local/sync.js`). SUDS on this
device, with no office, keeps its own items, sites and ledger.

## For the Home set-up step

`POST /api/supplies/items` with `opening: { quantity, site_id?, lot_number?, expires_on? }` creates an item and its
opening stock in one step. The single-number routes (`POST /api/supplies { item, quantity }`, `PUT
/api/supplies/:id { quantity | adjust }`, `DELETE /api/supplies/:id`) still work on the ledger, at the programme's
default site, for supervisors and administrators.

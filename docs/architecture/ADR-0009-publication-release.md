# ADR-0009: One audited publication release per ended period

- **Status:** accepted (independent statistical review pending; see *Known limits*)
- **Date recorded:** 2026-09-26 (the release object in 1.12.2, the check against the method in 1.12.4, the defaults, degrade step, work budget and worker thread in 1.13.0; written down retrospectively. 1.14.0: small funds combined, the read from a snapshot, the release kept by the data's version, the budget measured and reset, a timed-out audit refused on its own. 1.16.1: a table withheld by a published rule; 1.16.2: withdrawn, *Withheld by rule*. 1.17.0: the events by month left out of every release, *Events by month: not published*; one value skipped in the check's step; the device's audit in a Web Worker, *Where it runs*; the withheld tables and a refusal's reason in the audit log, *Consequences*)

## Context

The funder report, the Naloxone Distribution Project (NDP) log and the opioid settlement report print counts of
people. Printed for anyone outside the programme, a small count can identify someone, and so can two counts
subtracted from each other, or the pattern of which cells are hidden. Suppressing each report on its own (1.12.1)
leaked across reports; ordering rows by size, listing only the non-zero rows, and deciding what to hide from true
values leaked through the pattern (1.12.2, 1.12.3). A method-aware check (1.12.4) then refused most ordinary
quarters of 60 to 100 people (a market reviewer's simulation), and made the supervisor's first click a refusal.
Funders mostly want exact figures, which were never meant to be published.

## Decision

**What a run is for** (`server/funder-report.js` `countingMode`). A run is a *submission* to the funder, an
*internal* run, or a *publication release*. A role holding `reports:internal` (supervisor, administrator) gets
the submission unless it asks otherwise, with exact counts when it holds `reports:exact`; finance and read-only
get the publication release (they may run nothing else); a caseload-scoped role's run is internal. Only the whole
programme for one standard period that has ended can be a publication release, and a supervisor prepares one on
request. The page and every file say which kind of run it is (`suppression.label`).

**The release object** (`server/publication-release.js`). For such a period the three reports are one release:
their figures are read together, audited once, and each report prints its part; `release.id` is a digest of
everything the release prints. The read is one snapshot (`server/db.js` `readSnapshot`): a read transaction on
a second, read-only connection to the database file, which in WAL mode sees none of the commits writers make on
the main connection meanwhile, so the read lets the event loop go between its phases (until 1.14.0 it ran in
one synchronous pass, 0.6 to 1.5 s at 20,000 clients); the database calls made in the read's own asynchronous
context go to that connection (AsyncLocalStorage), everyone else's to the main one. Where there is no second
connection (an in-memory database, the browser kernel, a caller inside a transaction) the read runs straight
through. The release is kept for five minutes under the data's version - per table read, its row count and
latest `updated_at` (which every write stamps, as sync requires), and the tombstones - with the period and the
threshold, read inside the same snapshot: asking again, or for another report of the release, reads nothing
(1.13.0 kept it keyed by the figures, so it read everything to find it). The audit itself is still kept by the
figures it read.

**The constraint model** (`server/release-audit.js` `buildModel`). One integer variable per count of people any
of the three prints (and a few printed nowhere but tied to printed ones, such as a settlement fund no longer
active), every additive relationship the attacker knows (breakdowns add up, subsets are at most their total, race
codes cover it, the reversals are at most the events (1.17.0; before, a month's at most its events), doses bound reversals, ...), each checked against the
true figures (a relationship an import breaks is left out for that period), and what each cell shows: a number,
`<T` (1 to T−1), `suppressed` (at least T), `withheld`. Rows are listed from fixed domains in a fixed order.

**Small funds combined** (`server/funder-report.js` `foldFunds`, `server/release-audit.js` `buildModel`; 1.14.0).
Every fund with 1 to T−1 people is combined in one row, *Other funds (n combined)*: how many funds and their staff
hours, its people and services `withheld`. Which funds are combined follows from their symbols (each was `<T`),
so the combining says what the listing said; the row prints no count that 1.13.0 did not already hide. The
settlement report still counts combined settlement funds in its uses, so per use the model has the group's
people and services (printed nowhere, tied to the use as a fund is) and one count *x* that stands for any one
of the group's *k* funds: 1 ≤ x ≤ T−1, x ≤ group people ≤ x + (k−1)(T−1), group services ≥ x + k−1 - the exact
projection of the funds' own constraints onto one of them, and the funds are indistinguishable in the release,
so checking *x* checks each. *x* is a sensitive count printed nowhere (against the printout and the method);
the group's people only tie (`aux`, as the union of small funds was not protected before); the cover rule is
asked of *x* through the group (`model.watch`). Without it, 60, 80 or 120 small funds took a year's audit to its
budget and the release was refused; with it such a year takes 10 to 40 million units (docs/HIPAA.md, *Small
funds, combined*).

**The solver** (`server/sdc.js`). Every question - can this count be 1, T−1, how wide is this hidden cell's
range - is answered over the integers by branch and bound on a small dense two-phase simplex (Bland's rule),
restricted to the hidden cells connected to the question. A search that runs out answers in the cautious
direction ("not protected"). No dependencies.

**Suppression** (`sdc.js` `run`). Primary cells are `<T`; a total whose non-zero parts are all `<T` is hidden with
the counts of at least T under it; a cover (parts that together are at least a total) with a `<T` part hides its
first shown part whenever the printout would pin a small part were that part at the least value the printout
allows (a decision on the printout alone: 1.12.4 decided it on the part's value, which leaked and was refused);
the headline's companions (new admissions, episodes opened) are hidden whenever the headline is. Then, while a
sensitive count is under-protected, one more cell is hidden in a fixed structural order (the first that fixes it,
else the first that helps), and when nothing visible is left near it a table is withheld. The rule: a `<T` cell,
or a withheld or unprinted count the printout lets be small, must be able to be 1 and T−1 (as near as the symbols
allow); a `suppressed` count must range over ⌈T/2⌉ values.

**The check against the method** (`sdc.js` `consistent`). SUDS is open source, so for every hidden cell the audit
finds worlds with the same printed figures, runs each through the same suppression, keeps those that print the
identical release, and requires them to show the cell at 1 and over ⌈T/2⌉ values (a `suppressed` one ⌈T/2⌉ apart).

**Degrade, or refuse** (`sdc.js` `protect`). When the check fails, the tables of the counts it could not show
protected are withheld (`release.withheld`, `release.withheld_reasons`) and the release is suppressed and checked
again with them withheld from the start. That step's witnesses must fail the full release the same way (their own
suppression and check are run, once per printout), withheld cells of T or more must range over ⌈T/2⌉ values, and
counts worked out from the withheld tables' cells are held to the rule against the method. The release is refused
(422) when a table to withhold is the headline, when the degraded release fails, or when the budget runs out.

**Withheld by rule** (1.16.1; **withdrawn in 1.16.2**). The degrade step validates each witness world by running
that world's full release, check included; when the full release's check fails expensively (every candidate world
tried), each validation costs about as much as the first round, and the degrade step, which shares the first
round's budget, cannot finish. A 2,000-client year is refused this way (the per-month overdose events not reversed
are 1, 2 and 3; about 206 million units for the first round, the rest of the budget less than one validation;
raising the budget fourfold does not help). 1.16.1 withheld that table **from the start by a published rule**: in
a period with at least 12T overdose events, the events by month (`overdose.by_month.n`) whenever a month had 1 to
T-1 events or 1 to T-1 not reversed; the check counted every world that printed the same through the suppression
and for which the rule decided the same ("a dozen comparisons per world, not an audit").

That was not sound. Whether the rule fires depends on figures the release does not print, and a world that prints
the same through the suppression and fires the rule the same way can still have its own release refused (its own
check fails), so it is not behind the printout; counting it overstated the protection. The engineering review of
1.16.1 ran the attacker on the rule's own gate (T = 3, two months, 36 = 12T events, every split of events and
reversals): 6 printouts leaked, each saying that a month's events not reversed were not 1 (E 36, R 32, the months'
reversals 0 and 32 was printed only by E=1+35 and E=2+34); with the gate lowered, the suite's two-month families
leaked at T = 3 and 5. No test had put the rule under the attacker, because the gate kept it away from every family
the tests enumerate. The degrade step's standard - a world counts only if its own release, check included, prints
the same - was tried for 1.16.2: it removed those leaks, but it runs a whole check for each world the rule's check
counts, and wherever the rule fired at the size it was for it took the audit past its budget (the 2,000-client
year: 55 worlds at about 72 million units each), so the rule refused every year it was meant to publish. Nor was
it sound at one level (each world's own check counting worlds by the suppression and the rule alone, as the check
inside `sameFailure` does): with the gate lowered it still leaked at T = 3 in the suite's two-month family (E=2+2,
R=0+0 printed alone), because each of those worlds' own releases is in turn checked the stricter way. A rule's decision
depends on the figures, so a sound check of it is a fixed point over worlds' releases, which the audit cannot
afford. **So 1.16.2 publishes no rule**: `buildModel` returns no `preWithhold`, `server/sdc.js` `protect` is
1.16.0's, and a year like the benchmark's is refused whole again (refusal is always safe). No size of programme
is guaranteed to publish (docs/PERFORMANCE.md, *Which programmes are refused*): on scaled copies of that year at
T = 11, 34 of 114 were refused, 26 for want of budget with 87 to 237 overdose events and 8 because the release with
the events by month withheld still failed its check, with 301 to 341 (1.16.2 and 1.16.3 stated a band of about 110
to 240 from sweeps that moved each month's events and reversals together; moved independently, refusals fell
outside it on both sides). Quarters of seeded years, each read for itself, were refused too: 28 of 72, and every
refused year had at least one refused quarter (`test/thorough/refusal-band.test.js` and `refusal-quarters.test.js`
record both). A release 1.16.1 published with the events by month withheld by the rule is not
verified (docs/HIPAA.md). A rule that reads only a printed figure (withhold the months whenever the period has 12T
events) was tried too, and leaked the same way at 36 events: a world counted for the printout was refused by its
own check. A future rule of this kind needs a check whose witness worlds are shown to publish the same by their own
releases, at every level, at a cost the budget allows, and must be run under the attacker with its gate lowered
before it ships (`test/publication-release.test.js`, "the reviewer's case against
1.16.1's rule").

**Events by month: not published** (1.17.0). The expensive failure above is one table's: printed beside the
reversals by month (which the NDP log must print), the events by month make each month's events not reversed a
count of its own, a handful in most months of a programme with 90 to 340 overdose events a year, and the check of
those counts against the method is what failed at a cost the budget could not meet. Three ways round were weighed,
soundness first:

* *A coarsening chosen from the data* (publish the events by quarter when the year's events are in some range) is a
  rule on figures, the 1.16.1 case: whether it fires is itself published, and its check would have to be a fixed
  point over worlds' releases. Not taken. *Events by quarter for every year*, chosen by the period alone, is sound
  (a method, not a rule), but the benchmark year is still refused with it: its first and last quarters have 6 and 5
  events not reversed, the check fails, and the release with the quarters withheld fails too (58.6 million units).
* *A degrade budget reserved from round 1* does not help: the degrade step validates each witness by running that
  world's whole release, about as expensive as the first round, so what it needs is a multiple of the budget, not a
  share of it (1.16.2: four times the budget still refused the benchmark).
* **Taken: no publication release prints the events by month** - for every period and programme, whatever the
  figures, so its absence says nothing about anyone (`server/release-audit.js` `NOT_PUBLISHED`, stated on the page,
  in `release.not_published` and on the funder report's About sheet). The release prints the period's events,
  reversals, fatal and community-reported totals, the reversals by month (the funder report's months and the NDP
  log's, one table) and the doses; the programme's own submission to its funder still has the events by month.

Why it is sound: the model is what the printout says. What a reader knows of the months' events is that each is at
least its month's reversals and that they add up to E; projected onto the printed figures that is exactly
R <= E, which the model now states (before, it followed from the months). The months' events are then free beside
the reversals: any split of E - R over the months is consistent with every printout, and no world's release reads
them, so a month's events not reversed can be anything from 0 to E - R and a month's events anything from its
reversals to its reversals plus E - R. Each is therefore protected whenever E - R and the month's reversals are
(E - R is a derived count the audit already holds to the rule; a month's reversals are its cells), and neither is a
count of its own in the model. The attacker holds them to the rule regardless: `test/fixtures/pattern-attacker.js`
checks every month's true events (as a count printed nowhere, which must be able to be 1 and range) and events not
reversed over the worlds that print the same, in the two-month family and in three new ones (three months; two
months of reversed, fatal and neither events with community reports; two months of reversals with one or two doses)
at T = 3, the two-month family at T = 5, and at T = 11 two months with 24 events, every split of events and
reversals; the independent attacker models them as unprinted counts too. No leak was found in any (a first run of the
outcome family enumerated too near its checked sizes; *Known limits*).
Before and after are in docs/PERFORMANCE.md, *Which programmes are refused*.

What it costs: the published funder report loses its events by month. What it buys (measured, T = 11): the
benchmark's year publishes in 0.25 million units (about 60 ms; 1.16.x refused it after 400 million, about 9 s); of
the 114 scaled years 4 are refused, not 34 (1 for want of budget, at 87 events, and 3 because the release with
tables withheld still failed its check, at 93 to 150; 1.16.4: 26 and 8; the 4 were refused by 1.16.4 too, and
the other 30 publish); of the seeded programmes none of 18 years is refused, not 6, and 11 of 72 quarters, not 28.
Not every period gains: 3 quarters that 1.16.4 published are refused now (36 and 37 events; the
benchmark's last quarter among them), and of 300 of
the property test's tiny random programmes (1 to 12 people, T = 3 to 5) 182 are refused (1.16.4: 212; 31 newly
published, 1 newly refused). A release a programme
already published for a period under 1.16.x must not be published again under 1.17.0 for the same period: the two
patterns of what is hidden can be combined (docs/HIPAA.md, *Across releases*).

*One value skipped* (`server/sdc.js` `consistent`, 1.17.0). With the events by month gone, a month's reversals is
printed exactly when the other months' `<T` reversals add up to T (each can then be 1 and T-1 whatever the split)
and hidden otherwise, so no world that prints the release has the hidden count at that one value. The check's step
outward from a suppressed (or withheld, T or more) count's value stopped at the first value no world showed, and
refused quarters whose count ranged widely on both sides of it (with the events by month gone and without this step,
4 seeded quarters 1.16.4 published were refused; with it, 3, and 11 of 72 in all rather than 13). It now steps
over one such value, **at most once per count** (both directions together). The rule is unchanged - the span of the
values the worlds that print the release allow, which is what the attacker checks - and every value counted is still
shown by a world found and run. What the skip does change is how many values stand behind a span: a count that passes
with a span of P may have one value inside its range that no world shows, so at least **P distinct values** an
attacker cannot rule out rather than P+1 (at T = 3, 2 values: a single guess right one time in two rather than one in
three). As first merged the step could skip at every step, never two in a row, so a range could alternate hole,
value, hole: ceil(P/2)+1 values in the worst case, and the engineering review of the 1.17.0 candidate (M1) found
published cells behind only 2 values at T = 3 and T = 4 and 3 at T = 5. Every skip it saw was a single one, so
capping it at one changed no publication rate; `test/sdc-skip-one.test.js` checks the cap on the counts it widens.

**Determinism.** The audit's budget is counted in solver work (tableau cells touched, and since 1.14.0 the
constraint terms scanned to find each problem, which with many funds took as long as the solving; `STEP_LIMIT` =
400 million per release, the degrade step included: its share is at most eight times the first round's work
plus 2 million, out of what the first round left, not a budget of its own), so what is published depends on the
figures alone.
Measured in 1.14.0 (4-core cloud container, Node 22, one core, warmed up): 60 to 200 million units a second
across the tests' releases and a 20,000-client benchmark, so the budget is about 2 to 7 seconds; 1.13.0's 200
million, counting the solving only, was 0.6 to 1.2 seconds rather than the "few seconds" its comment claimed. A
withheld, unprinted or derived count that the printout does not let be small is answered before its targets
(an LP over most of the model) are worked out - the same answer, a third of the work at 120 funds. A 60-second
wall-clock backstop remains only to protect the server; a release it stops is refused and logged.

**Where it runs.** In a worker thread (`server/release-audit-worker.js`, one long-lived worker, unreferenced when
idle); the main thread reads the figures, then awaits the audit. The tests' API calls use the worker too, as the
server does (`test/helpers.js` does not set `SUDS_AUDIT_INLINE`; `test/publication-release.test.js` checks the
audit ran there); the pure tests call `protectFigures` directly, and `SUDS_AUDIT_INLINE=1` forces the inline path
(the performance test compares the two). An audit that does not answer within the backstop is refused on its
own and its worker stopped; the audits queued behind it on that worker start again on a new one (1.14.0; in
1.13.0 they were failed with it, `test/release-worker-timeout.test.js`). A refusal by the backstop is not kept
with the release (it says how busy the machine was, not what the figures are): asking again audits again.
The browser kernel has no worker threads (`node:worker_threads` is shimmed empty) and no second connection to
snapshot from, and serves requests as they come, so there the read runs straight through. **Since 1.17.0 the
kernel's audit runs in a Web Worker** (engineering reviews of 1.13.0 to 1.16.3: until then it ran on the page's
thread, held back only by the 60-second backstop, and the 2,000-client year 1.16.x refused held a server-class core
for about 7 s before refusing, longer on a phone). The worker is a second generated bundle, `public/local/audit-worker.js`
(built from `local/audit-worker.js` by `npm run build:local` beside the kernel, with its `.gz` and `.br`; the audit
alone, about 110 kB; CI's drift check covers `public/local`, so an unbuilt worker fails CI, not devices), precached
by the service worker under the kernel's version and started by `local/audit-runner.js`, which the kernel hands to
`server/publication-release.js` (`setDeviceAuditRunner`; `public/app.js` passes its URL). One long-lived worker,
handed one audit at a time (the next when the one before has answered), so that the backstop counts an audit's own
time and not the time it waited behind another (until the review of the 1.17.0 candidate, L1, the timer started at
dispatch and an audit queued behind a long one could be refused having barely run); an audit that does not answer
within the backstop is refused and its worker stopped, and the next audit waiting starts on a new one. **The device's
backstop is 75 s, the server's 60 s** (`server/release-audit.js` `AUDIT_BACKSTOP_MS`): a phone runs the same work
more slowly, and the wall clock is only a guard, not what decides: the budget in units of work decides what is
published, the same on both, so "a device's release is the office's" holds for every release either finishes within
its clock, and a device refuses by its clock only a release that took it 75 s. Where no worker can run - no Web
Workers, the constructor throws, the script fails to load or does not say it started within 10 s - the audit runs on
the page as before (after letting it paint once); a worker that was only slow to start is tried once more, for the
next audit, before the page is used for the rest of the session; once a worker has said it started, its audits are
never run twice. The same code and the same
budget run either way, so a device's release of some figures is the office's (`test/kernel-parity.test.js`); a
lower on-device budget was considered and not taken, because it would make a device refuse what the office
publishes. `test/device-audit-worker.test.js` runs the committed worker as a browser does and the runner with
stand-in workers (the same release, the fall-back to the page, the refusal of one that stops answering). What
remains on the page's thread is the read (straight through, as before) and, on a device where no worker can start,
the audit.

## Consequences

- A supervisor's first click is the submission, exact; publication is an explicit step with a review confirmation.
- In the reviewer's simulation (8 seeds per size, quarter and month) no release of 40 to 200 people was refused
  (1.12.4: 7 of 8 at 60, 6 of 8 at 80 per quarter); the random "realistic" property programmes refuse about 1 in 70.
  That is not a guarantee. 1.16.2 to 1.16.4 refused the benchmark's 2,000-client year whole, with 34 of 114 scaled
  copies of it and 28 of 72 quarters of seeded years (*Withheld by rule*); since 1.17.0, with the events by month
  left out of every release, the year publishes and 4 of the 114 and 11 of the 72 are refused (*Events by month: not
  published*): small overdose counts beside small reversals by month, where the release with tables withheld still
  fails its check.
- The audit log records each release's id and every table it withheld with the reason code, from every report of it
  (`FR.releaseAuditDetails`), and a refused release as `report.publication.refused` with why (budget, backstop,
  headline, unprotected), how many counts were unprotected, the tables it had withheld and the audit's work (1.17.0;
  market reviews of 1.16.2 and 1.16.3: until then a release 1.16.1's rule had affected could not be found from the
  log). Table names and codes only, never a count of people.
- A year for 5,000 people costs about 17 million units of work (4% of the budget; the release 0.6 to 0.9 s); while
  it runs the event loop is held only for the read's phases (0.1 to 0.2 s at 20,000 clients, 1.14.0; 0.6 to 1.5 s
  before, the whole read at once).
- A year of 120 funds, 80 of them small, publishes (1.13.0 refused 60 and more): 12 to 14 million units at 20,000
  clients, about 140 million with 800 one-person languages and 400 race codes beside them.
- Every future table must be modelled: its cells, its relationships to the others and its row domain.

## Known limits

- The check proves that its witness worlds print the release through the suppression (and, for a degraded
  release, fail the full release the same way); not that each would pass the check itself. The tests run the whole
  release, degrade step included, on every world of small families. That gap is what 1.16.1's rule turned into
  a leak (*Withheld by rule*): the families enumerated are the evidence, not a proof, and a family must reach
  whatever gate a mechanism has.
- Counts printed nowhere are held to the rule against the method only in a degraded release's withheld tables and
  by the tests' families; otherwise against the printout. The attacker's family of two small funds of one
  allowable use at T = 5 finds one such count - the people served not under that use - narrowed by the method
  in a few printouts, with the funds combined or listed alike.
- The people of several combined funds together are not a count held to the rule (each fund's are). A device
  whose browser cannot start the audit's Web Worker audits on the page's thread, as before 1.17.0 (above).
- A published release no longer has the overdose events by month, which some funders or the public may want; they are
  in the programme's submission only. A period some version before 1.17.0 published must not be published again: the
  two releases of the same figures hide differently (docs/HIPAA.md, *Across releases*).
- Still refused (1.17.0, measured at T = 11): 4 of 114 scaled years (87 to 150 events) and 11 of 72 seeded quarters
  (29 to 49), 3 of them quarters 1.16.4 published, the benchmark's last quarter among them; and, in the attacker's
  two-month family at T = 3, more printouts than 1.16.4 refused. What refuses them is the check against the method on
  small reversals by month beside hidden totals (its witness search finds too few worlds that print the same), not
  its budget; a cheaper sound check of those, or a reviewed coarsening of the reversals by month, which the NDP log
  prints by month, is further work. No option weighed here makes every period publish.
- **The attacker's enumeration margin can only raise false alarms, not hide a leak.** The attacker is monotone:
  every world it adds can only widen the set of values it holds possible for a cell, so a family enumerated too few
  sizes past the ones it checks makes a cell look narrower than it is (a false alarm), never wider. At T = 3 the
  two-month family of reversed, fatal and neither events enumerated only to 5 events reported a suppressed total of 3
  or 4 as a leak; enumerated further, its worlds include 6 (5 prints differently), and there was none. (Until the
  review of the 1.17.0 candidate this page said the families must reach past the sizes checked "because the check's
  step looks that far", which had it backwards.) So on a reported leak, enumerate that family further before acting,
  rather than tuning the margin until the test passes. The real limit of the attacker's coverage is **which sizes
  and thresholds it checks**: there is no three-month family at T = 11, for example, and the families at T = 11 are
  the two-month ones of `test/publication-release-months.test.js`.
- Nested or overlapping periods, the same period re-run after late entries, outside knowledge, and sums of several
  small cells of one breakdown are outside the audit (docs/HIPAA.md, residual risks).
- It is a conservative automated screen, **not a statistical expert determination** (45 CFR 164.514(b)(1)). An
  independent statistical disclosure-control review of the rule, the model and the check is pending; until then
  every publication release's export asks the person to confirm they reviewed it.

## Addendum (1.14.0): publication releases can be switched off

**Context.** The engineering reviewer asked for "the option to switch publication releases off" while
`server/sdc.js` awaits the independent statistical review named under *Known limits*: a programme whose
governance will not publish from an unreviewed method must be able to say so in the product, not just in a
policy, and must not be one careless click from a release.

**Decision.** Publication releases are a programme module (`server/programme.js`, key `publication`, setting
`module_publication`), on by default so nothing changes for a programme that does nothing. An administrator
switches it off in Settings › Program › Modules. While it is off:

* every publication run of the funder report, the NDP log and the settlement report, and every file of one, is
  refused (403, `module: 'publication'`) in `FR.countingMode`, the one place every publication path goes
  through, with a message saying releases are switched off and what the role can run instead;
* supervisors, administrators and finance (`reports:funder`) still run the programme's own **submission** to
  its funder, which never was a release; their first click is the submission already, so nothing moves;
* a read-only account, which runs publication releases only, is refused with a message that says it has
  nothing to run until releases are switched back on (`server/routes/reports.js` `requireReportRun`), and its
  screens offer no periods to publish;
* the screens drop "Prepare a publication release" and the publication choice, and say releases are off.

**Consequences.** Switching releases off removes the only aggregate report read-only accounts could run;
that is the intended trade-off while the method is unreviewed. It changes no audit, threshold or release
shape: switching back on restores exactly the behaviour above. The switch is audited as a programme settings
change (`settings.programme`) and synchronised to device copies with the other module switches.
`test/report-access.test.js` ("publication releases switched off") and `scripts/ui/funder-reporting.mjs`
cover it.

## Read

`server/publication-release.js`, `server/release-audit.js`, `server/sdc.js`, `server/funder-report.js`
(`countingMode`, `suppress`), `server/small-cells.js`; docs/HIPAA.md "Small cells in aggregate reports";
docs/compliance/HARM-REDUCTION-REPORTING.md.

## Tests

`test/publication-release.test.js` (the independent attacker `test/fixtures/release-attacker.js`, the
algorithm-aware attacker `test/fixtures/pattern-attacker.js` over families in `test/fixtures/release-worlds.js`
including the race-code cover, two small funds combined (`test/publication-release-funds.test.js`), the reviewer's two-month, 36-event family against 1.16.1's rule (`pattern.monthsWith`), and since 1.17.0 each month's events and events not reversed checked as hidden counts in every family with months, with three more such families (`pattern.months3`, `monthsOutcome`, `monthsDoses`; `test/publication-release-months.test.js`), realistic programmes, programmes of many small funds and random
programmes, their small funds combined, the degrade fixture `test/fixtures/degraded-release.json`, the reviewer reproductions, the
audit running in the worker; full sweeps with `SUDS_THOROUGH=1`), `test/publication-release-perf.test.js` (work,
determinism, event-loop stall, a year of 60 funds - 120 in the thorough run - most of them small; the benchmark year
publishes), `test/thorough/refusal-band.test.js` and `refusal-quarters.test.js` (which periods are refused, a
tripwire), `test/publication-audit-log.test.js` (what the audit log records), `test/device-audit-worker.test.js`
(the device's Web Worker),
`test/report-snapshot.test.js` (the snapshot read, the release kept by the data's version),
`test/kernel-parity.test.js` and `test/kernel-sync-parity.test.js` (the same release id from the kernel and the
office), `test/report-access.test.js` (defaults and permissions per role), `test/small-cell-suppression.test.js`,
`test/funder-report.test.js`, `scripts/ui/funder-reporting.mjs`.

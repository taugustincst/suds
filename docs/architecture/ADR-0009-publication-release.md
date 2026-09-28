# ADR-0009: One audited publication release per ended period

- **Status:** accepted (independent statistical review pending; see *Known limits*)
- **Date recorded:** 2026-09-26 (the release object in 1.12.2, the check against the method in 1.12.4, the defaults, degrade step, work budget and worker thread in 1.13.0; written down retrospectively. 1.14.0: small funds combined, the read from a snapshot, the release kept by the data's version, the budget measured and reset, a timed-out audit refused on its own)

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
codes cover it, a month's reversals are at most its events, doses bound reversals, ...), each checked against the
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

**Determinism.** The audit's budget is counted in solver work (tableau cells touched, and since 1.14.0 the
constraint terms scanned to find each problem, which with many funds took as long as the solving; `STEP_LIMIT` =
400 million per release, the degrade step its own share), so what is published depends on the figures alone.
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
snapshot from, and serves requests as they come, so there the read runs straight through and the audit runs
inline on the page's thread, after letting the page paint once. A Web Worker for the kernel's audit needs a
second generated bundle (built, committed and served beside `public/local/kernel.js`), precached by the service
worker under the kernel's version, and a fallback when it cannot start: considered for 1.14.0 and deferred,
because the release's generated files are rebuilt outside the change that would add it and an unbuilt bundle
would fail only on devices. What bounds it meanwhile: a device holds one browser's records, and with small
funds combined even a 120-fund year audits in tens of millions of units (well under a second); the budget's
worst case, a few seconds of a busy page, is the limit.

## Consequences

- A supervisor's first click is the submission, exact; publication is an explicit step with a review confirmation.
- In the reviewer's simulation (8 seeds per size, quarter and month) no release of 40 to 200 people is refused
  (1.12.4: 7 of 8 at 60, 6 of 8 at 80 per quarter); the random "realistic" property programmes refuse about 1 in 70.
- A year for 5,000 people costs about 17 million units of work (4% of the budget; the release 0.6 to 0.9 s); while
  it runs the event loop is held only for the read's phases (0.1 to 0.2 s at 20,000 clients, 1.14.0; 0.6 to 1.5 s
  before, the whole read at once).
- A year of 120 funds, 80 of them small, publishes (1.13.0 refused 60 and more): 12 to 14 million units at 20,000
  clients, about 140 million with 800 one-person languages and 400 race codes beside them.
- Every future table must be modelled: its cells, its relationships to the others and its row domain.

## Known limits

- The check proves that its witness worlds print the release through the suppression (and, for a degraded
  release, fail the full release the same way); not that each would pass the check itself. The tests run the whole
  release, degrade step included, on every world of small families.
- Counts printed nowhere are held to the rule against the method only in a degraded release's withheld tables and
  by the tests' families; otherwise against the printout. The attacker's family of two small funds of one
  allowable use at T = 5 finds one such count - the people served not under that use - narrowed by the method
  in a few printouts, with the funds combined or listed alike.
- The people of several combined funds together are not a count held to the rule (each fund's are); the browser
  kernel audits on the page's thread (above).
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
including the race-code cover and two small funds combined (`test/publication-release-funds.test.js`), realistic programmes, programmes of many small funds and random
programmes, their small funds combined, the degrade fixture `test/fixtures/degraded-release.json`, the reviewer reproductions, the
audit running in the worker; full sweeps with `SUDS_THOROUGH=1`), `test/publication-release-perf.test.js` (work,
determinism, event-loop stall, a year of 60 funds - 120 in the thorough run - most of them small),
`test/report-snapshot.test.js` (the snapshot read, the release kept by the data's version),
`test/kernel-parity.test.js` and `test/kernel-sync-parity.test.js` (the same release id from the kernel and the
office), `test/report-access.test.js` (defaults and permissions per role), `test/small-cell-suppression.test.js`,
`test/funder-report.test.js`, `scripts/ui/funder-reporting.mjs`.

# SUDS ROI worksheet

A simple worksheet a programme manager can fill in with their own numbers. Use the baselines from the pilot
([PILOT-KIT.md](../PILOT-KIT.md), section 5) where you have them; otherwise use honest estimates and say so.
The example column is **invented to show the arithmetic** — not a measured result, and not a claim about what
SUDS saves. No pilot has measured SUDS yet; do not show the example numbers to a funder or board.

## Inputs

| # | Input | Your programme | Example |
| --- | --- | --- | --- |
| A | Staff using SUDS (navigators / outreach workers) | | 8 |
| B | Visits and contacts logged per worker per week | | 25 |
| C | Minutes to log one visit today (spreadsheet / paper + re-keying) | | 8 |
| D | Minutes to log one visit in SUDS (measured in pilot) | | 4 |
| E | Loaded hourly cost of a navigator ($) | | 45 |
| F | Grant / funder reports per year | | 12 |
| G | Staff hours to prepare one report today | | 12 |
| H | Staff hours to prepare one report in SUDS | | 3 |
| I | Loaded hourly cost of report preparer ($) | | 60 |
| J | Supply spend per year (naloxone, test strips, hygiene kits) ($) | | 20,000 |
| K | Share of supplies wasted today (expired, lost, uncounted) (%) | | 8 |
| L | Share wasted with tracked stock (%) | | 4 |
| M | Annual cost: support subscription if bought ([PRICING.md](PRICING.md), unvalidated), plus your IT partner's hours to run the server | | 4,500 + 1,500 = 6,000 |
| N | One-time implementation fee, if bought ($) | | 5,000 |

## Calculations

| Line | Formula | Example |
| --- | --- | --- |
| 1. Visit-logging hours saved / year | A × B × 48 weeks × (C − D) ÷ 60 | 8 × 25 × 48 × 4 ÷ 60 = **640 h** |
| 2. Value of line 1 | line 1 × E | 640 × $45 = **$28,800** |
| 3. Report-preparation hours saved / year | F × (G − H) | 12 × 9 = **108 h** |
| 4. Value of line 3 | line 3 × I | 108 × $60 = **$6,480** |
| 5. Supply waste avoided / year | J × (K − L) ÷ 100 | $20,000 × 4% = **$800** |
| 6. Total annual value | 2 + 4 + 5 | **$36,080** |
| 7. Year-one cost | M + N | **$11,000** |
| 8. Year-one net | 6 − 7 | **$25,080** |
| 9. Payback (months) | 7 ÷ (6 ÷ 12) | **3.7 months** |

## Read it carefully

- **Time saved is capacity, not cash**, unless it changes staffing. Say what the hours go to: more outreach
  contacts, more follow-ups, less overtime at quarter end.
- **Not counted but real:** fewer audit findings from incomplete records, referral loops closed, stock-outs
  avoided on the day someone overdoses, grant compliance (unduplicated counts, consent records), staff
  turnover handled by caseload transfer instead of lost spreadsheets.
- **Costs not counted:** training time, the parallel run, and — for a county-hosted install — county IT time
  (0.25–0.5 FTE administrator, `docs/ADOPTION.md`). Line M includes an example IT-partner cost for a self-hosted
  install; use your partner's real quote ([../HOSTING.md](../HOSTING.md)).
- Replace example numbers with measured pilot numbers before showing this to a funder or board.

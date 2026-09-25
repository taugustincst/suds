# SUDS ROI worksheet

A simple worksheet a programme manager can fill in with their own numbers. Use the baselines from the pilot
([PILOT-KIT.md](../PILOT-KIT.md), section 5) where you have them; otherwise use honest estimates and say so.
The example column is illustrative only, not a measured result.

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
| M | SUDS annual cost (subscription; [PRICING.md](PRICING.md)) ($) | | 4,704 |
| N | One-time implementation fee ($) | | 5,000 |

## Calculations

| Line | Formula | Example |
| --- | --- | --- |
| 1. Visit-logging hours saved / year | A × B × 48 weeks × (C − D) ÷ 60 | 8 × 25 × 48 × 4 ÷ 60 = **640 h** |
| 2. Value of line 1 | line 1 × E | 640 × $45 = **$28,800** |
| 3. Report-preparation hours saved / year | F × (G − H) | 12 × 9 = **108 h** |
| 4. Value of line 3 | line 3 × I | 108 × $60 = **$6,480** |
| 5. Supply waste avoided / year | J × (K − L) ÷ 100 | $20,000 × 4% = **$800** |
| 6. Total annual value | 2 + 4 + 5 | **$36,080** |
| 7. Year-one cost | M + N | **$9,704** |
| 8. Year-one net | 6 − 7 | **$26,376** |
| 9. Payback (months) | 7 ÷ (6 ÷ 12) | **3.2 months** |

## Read it carefully

- **Time saved is capacity, not cash**, unless it changes staffing. Say what the hours go to: more outreach
  contacts, more follow-ups, less overtime at quarter end.
- **Not counted but real:** fewer audit findings from incomplete records, referral loops closed, stock-outs
  avoided on the day someone overdoses, grant compliance (unduplicated counts, consent records), staff
  turnover handled by caseload transfer instead of lost spreadsheets.
- **Costs not counted:** county IT time for a county-hosted install (0.25–0.5 FTE administrator,
  `docs/ADOPTION.md`), training time, the parallel run.
- Replace example numbers with measured pilot numbers before showing this to a funder or board.

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

## AI documentation copilot (optional, office server only)

Only for a programme that has turned the copilot on after recording its BAA and Part 2 QSOA with the AI
provider ([../../AI-COPILOT.md](../../AI-COPILOT.md)); it is never used for SUD counseling notes. **There is no
example column here:** no pilot has measured the copilot, and neither the minutes saved nor the provider's price
should be guessed. Fill in P from the pilot's copilot arm ([PILOT-KIT.md](../PILOT-KIT.md), section 5), and T and
U from the provider's current published price list or your contract.

| # | Input | Your programme | Where it comes from |
| --- | --- | --- | --- |
| O | Notes drafted with the copilot per year | ______ | Signed notes with `ai_assisted` in the pilot, scaled to a year |
| P | Documentation minutes saved per drafted note (median without the copilot minus median with) | ______ | Pilot copilot arm. Time from contact to signed note is elapsed time, not effort: use the timed sample of writing time where the pilot has one |
| Q | Loaded hourly cost of the staff who write the notes ($) | ______ | Finance |
| R | Input tokens per draft (average) | ______ | `ai_usage.input_tokens` for the pilot ÷ drafts |
| S | Output tokens per draft (average) | ______ | `ai_usage.output_tokens` for the pilot ÷ drafts |
| T | Provider price per million input tokens ($) | ______ | Provider price list or contract, for the model in Settings → AI copilot |
| U | Provider price per million output tokens ($) | ______ | As T |
| V | Drafts asked for per year, kept or not | ______ | `ai_usage` rows (or `ai.draft` audit entries) for the pilot, scaled to a year; every returned draft costs tokens, kept or discarded |

| Line | Formula | Your programme |
| --- | --- | --- |
| 10. Documentation hours saved / year | O × P ÷ 60 | ______ h |
| 11. Value of line 10 | line 10 × Q | $______ |
| 12. Model cost / year | V × (R × T + S × U) ÷ 1,000,000 | $______ |
| 13. Copilot net / year | 11 − 12 | $______ |

Line 12 is the provider's charge only. Count separately the counsel review of the agreements, staff training
(the signer owns the note), and the supervisor time to review drafts during the pilot. A copilot that saves no
measured time is a cost, however cheap the tokens.

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

# ADR-0004: One disclosure gate for everything that leaves the programme

- **Status:** accepted
- **Date recorded:** 2026-09-25 (2024 Part 2 final-rule bases and file exports through the gate in 1.11.0; written down retrospectively)

## Context

42 CFR Part 2 and HIPAA require that identifiable SUD information leaves a programme only on a lawful basis
(usually a consent that names the recipient) and that each disclosure is accounted for (§2.24/§2.25,
§164.528). If each feature checked consent its own way, one of them would be wrong.

## Decision

`server/disclosure.js` is the **only** place that decides whether identified client information may leave, and
the only writer of the accounting of disclosures (`disclosures` table). Every outbound path calls it:

| Path | Route / file | Gate call | Accounting `source` |
| --- | --- | --- | --- |
| Referral that shares information (REST) | `server/routes/referrals.js` | `requireBasis` | referral |
| Referral pushed from a device | `server/routes/sync.js` → `referrals.pushDisclosure` | `requireBasis` | referral |
| Manual disclosure recorded by staff | `server/routes/consents.js` | `requireBasis` | manual |
| Identified export (Excel/CSV) | `server/routes/reports.js` | `requireExportBasis` | export |
| County EHR hand-off file | `server/routes/handoff.js` | `requireExportBasis` / per-client consent | ehr_handoff |
| CalOMS Tx submission file | `server/routes/caloms.js` | `recordStateReport` (required by law) | state_reporting |
| FHIR read API and bulk `$export` | `server/routes/fhir.js`, `server/fhir/bulk.js` | `fhirCoverage`, then `recordFhir` | fhir (one row per client served) |

Rules the gate enforces: a consent covers a disclosure only if it is live, carries the §2.31 elements (checked
again at disclosure time, including for legacy and device-pushed consents) and **names the recipient**;
non-consent bases need their record on file (a qualifying court order, a registered QSOA / research /
audit approval) or a supervisor with a written justification; counseling notes and legal proceedings need their
own consent; agreed restrictions must be confirmed; bulk files cannot rest on a court order or emergency. Each
disclosure carries the §2.32 notice and writes an audit entry as well as the accounting row.

De-identified exports (HIPAA Safe Harbor) do not pass the gate because they are not disclosures of identified
information; `server/exports.js` enforces the de-identification.

## Consequences

- A new feature that sends a name, a date of birth or any identified record outside the programme **must**
  call the gate; there is no other supported way (CLAUDE.md). A reviewer's first question on such a change is
  "where is the `disclosure.*` call and its test?"
- The gate is conservative: it refuses rather than guesses (e.g. a consent to "Agency A" does not cover
  "Agency B" unless an alias is registered).
- Legal characterisations (e.g. CalOMS as §2.53 / §164.512(a)) are the maintainer's reading and are flagged
  for county counsel in [docs/compliance/PART2.md](../compliance/PART2.md).

## Read

`server/disclosure.js` (the comment block at the top lists every basis), `server/routes/referrals.js`,
`server/routes/reports.js` (identified exports), `server/routes/handoff.js`, `server/routes/fhir.js`,
[docs/compliance/PART2.md](../compliance/PART2.md), [docs/SCOPE.md](../SCOPE.md).

## Tests that pin it

`test/part2.test.js` (every control PART2.md claims), `test/disclosure-gates.test.js`,
`test/deid-safe-harbor.test.js`, `test/fhir.test.js` and `test/fhir-hardening.test.js` (consent enforcement per
request), `test/caloms.test.js` (submission accounted once), `test/reason-privacy.test.js`.

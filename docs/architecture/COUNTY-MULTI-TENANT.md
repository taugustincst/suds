# County mode: one county-hosted server for several provider organisations — design

- **Status:** proposed (design only; not built). What 1.17.0 did build is listed under *What exists today*.
- **Date:** 2026-09-29
- **Related:** [ADR-0001](ADR-0001-single-process-sqlite.md) (one process, one database per programme),
  [ADR-0004](ADR-0004-disclosure-gate.md) (the disclosure gate), [docs/compliance/CALOMS.md](../compliance/CALOMS.md).

## The question

A county behavioural-health department wants to host SUDS once and have several contracted provider
organisations (CBOs, treatment providers) use it, each reporting CalOMS Tx under its own provider number, with the
county seeing aggregate figures across them. Does SUDS have a multi-organisation concept?

**No.** SUDS has one programme per database: one `org_name`, one set of users whose roles span every client, one
consent gate in which "this programme" (the `internal` basis, §2.12(c)(3)) is the whole database, one accounting of
disclosures, one audit log, one encryption key set. ADR-0001 says so deliberately: "Multiple programmes = multiple
instances … never multi-tenancy inside one database."

That matters most for 42 CFR Part 2. Two provider organisations are **two Part 2 programmes**. Information passing
from one to the other is a *disclosure* that needs the patient's consent (or another basis) and an accounting row —
not an internal communication. A shared database where a caseload filter is the only thing between Provider A's
staff and Provider B's clients would turn every misconfigured permission into an unconsented, unaccounted
disclosure. So multi-tenancy cannot be a patch.

## What exists today (1.17.0, patch-sized and safe)

- **Several CalOMS provider IDs per server, each with its legal name and NPI** (Settings → State reporting; the
  NPI's check digit is verified; `caloms_providers` settings, not PHI).
- **One CalOMS file per provider**: `POST /api/caloms/submissions` takes `provider_id`, and the monthly run can
  prepare one file per provider (`caloms_split_by_provider`). Each file carries only that provider's records and
  provider-activity rows, and its README names the provider.

This serves **one organisation that reports under several provider numbers** (several sites or licensed
programmes of the same legal entity, which is one Part 2 programme with one set of staff). It does **not** make
one server safe for several unrelated organisations; for that, run one instance each (below).

## Recommended deployment now: one instance per provider, hosted by the county

The county runs N SUDS instances on its own infrastructure — one container or VM, one data directory and one key
set per provider organisation — behind its reverse proxy (`provider-a.suds.county.gov`, …). This is supported
today ([docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/market/HOSTING.md](../market/HOSTING.md)):

- each provider is its own Part 2 programme, with its own consents, accounting, audit log and keys;
- the county's identity provider signs staff into the instances they belong to (OIDC per instance);
- a county analyst receives each provider's de-identified exports and publication releases, or reads a
  provider's records over FHIR only where that provider's consents name the county;
- each provider produces its own CalOMS files; the county's DHCS submitter uploads them (SUDS never contacts DHCS).

Cost: N processes and N backups to run; fleet tooling (below) is the part worth building first.

## Full multi-tenant design (if it is ever built)

Only with a county sponsor, counsel's review of the Part 2 model, and a security review of the tenant boundary.

### Tenant model

- A new table `organisations` (id, legal name, NPI, CalOMS provider numbers, Part 2 programme flag, contact,
  status) and an `org_id` on **every** client-linked table, on users, resources (or a shared directory with an
  owner), forms, funds and settings that are per programme today.
- Users belong to exactly one organisation (a county user is a separate, aggregate-only role — below). A person who
  works for two providers has two accounts.
- The organisation is resolved **once per request** from the session and bound into every query by the data layer
  (`db.js` helpers that refuse a query on a tenant table without the tenant predicate; a test that fails for any
  SQL touching a tenant table without it), not left to each route — the same pattern as `crud.js` caseload scoping,
  but mandatory.
- Encryption: a data key per organisation (wrapped by the server key), so one tenant's rows cannot be decrypted with
  another's key even by a query that forgets its predicate, and a departing provider's data can be exported and
  crypto-shredded.
- Audit: one hash chain per organisation (or `org_id` in the chain payload), so each provider can verify and export
  its own log.

### Part 2 across tenants

- `disclosure.js` learns the organisation: `internal` means *this* organisation; anything reaching another
  organisation — a referral between two providers on the same server, a shared client record, the county reading
  identified data — is a disclosure through the gate, with the consent naming the receiving organisation and an
  accounting row on the sending side. A referral between two tenants could reuse the secure-referral-link packet
  (docs/security/REFERRAL-LINKS.md) delivered inside the server rather than by link.
- No shared client record across organisations. Duplicate detection stays within a tenant; a cross-tenant match is
  never shown (it would itself disclose that the person is in SUD treatment elsewhere).
- Break-glass is per organisation.

### The county's view

- A county role with **no client-level access**: aggregate reports, de-identified exports and publication releases
  per provider and across providers, with small-cell suppression applied across the combined figures (and the
  differencing risk between per-provider and combined tables reviewed — ADR-0009).
- Identified access for the county only by the same routes as any outside party: a QSOA or audit/evaluation
  approval on file with each provider, or per-client consent.
- CalOMS: each provider's files as today; a county "submission desk" view listing every provider's prepared and
  produced files, the upload log and the fatal errors outstanding — metadata only.

### Operations

- Sync (local mode) scoped to the device user's organisation; a device never holds two tenants.
- Backups per organisation (logical export) in addition to the whole database, so one provider can leave with its
  data; retention settings per organisation.
- Tenant provisioning and offboarding runbooks; per-tenant rate limits and storage quotas.

### Why this is not a patch

Every table, every query, the key hierarchy, the audit chain, sync, retention, the disclosure gate and the tests
change. It is at least a major release with its own migration and security review. Until then, the answer to
"can several providers share one server?" is **one instance each**.

### Fleet tooling (worth building first)

What would make N instances cheap for a county, without touching the tenant boundary: one command to create an
instance (data directory, keys, TLS, OIDC client); a status page across instances (version, backup age, audit
verification, CalOMS files awaiting upload); rolling upgrades; and a combined de-identified report built from each
instance's publication releases.

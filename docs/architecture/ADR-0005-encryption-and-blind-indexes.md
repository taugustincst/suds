# ADR-0005: Field-level encryption with blind indexes

- **Status:** accepted
- **Date recorded:** 2026-09-25 (in force since 1.0.0; written down retrospectively)

## Context

A SQLite file is easy to copy: a backup on a share, a laptop, a support engineer's download. Disk encryption
protects a powered-off disk, not a copied file or someone reading tables. Staff still need to find a client by
name, date of birth or phone number.

## Decision

- **Naming is the contract.** Every column holding identifying or free-text client information ends in `_enc`
  and is encrypted with **AES-256-GCM** (random 96-bit IV per value, format `v1:iv:tag:ciphertext`,
  `server/crypto.js` `encrypt`/`decrypt`). Searchable copies end in `_idx` and are an **HMAC-SHA-256 blind
  index** of a normalised form of the value (`foldText`: accents removed, case folded, scripts preserved).
  Coarse indexes (surname prefix, phonetic code) make search typo-tolerant.
- Coded fields needed for reporting (status, primary substance, risk level, dates, gender, race codes…) are
  **not** field-encrypted; they rely on disk encryption and access control. The table-by-table classification
  is in [docs/HIPAA.md](../HIPAA.md), *Data classification inside the database*.
- **Separate keys**, outside the database: `SUDS_ENCRYPTION_KEY` (field encryption), `SUDS_INDEX_KEY` (blind
  indexes and the audit chain HMAC), `SUDS_SIGNING_KEY` (Ed25519 evidence signatures). From the environment or
  a secrets manager; a 0600 `keys.json` only for small installs.
- The server refuses to start if the encryption key's fingerprint does not match the one recorded in the
  database (`checkKeyFingerprint`, `server/db.js`), rather than writing records under two keys.
- Key rotation re-encrypts / re-indexes every `_enc` / `_idx` column **discovered from the live schema**
  (`scripts/rotate-key.js`, `scripts/rotate-index-key.js`), so a new column is covered without editing the
  scripts. PHI never goes into plaintext columns, audit details or logs (CLAUDE.md).

## Consequences

- A stolen database or backup without the keys shows ciphertext for identifiers and notes, but **coded
  fields are readable**; that is a documented residual risk, mitigated by disk encryption.
- Blind indexes leak equality and frequency (two rows with the same name have the same index), and the
  coarse indexes leak more; documented in the risk register.
- The index key also keys the audit chain; separating them is an open risk-register item.
- No SQL `LIKE` on encrypted data: search is exact or prefix/phonetic via indexes; reports use coded fields.
- A new `_enc` column must also be declared in `server/sync-tables.js` (ADR-0003).
- Losing every copy of the encryption key makes the PHI unrecoverable, by design.

## Read

`server/crypto.js`, `server/db.js` (`checkKeyFingerprint`, the `_enc` migration helpers), `server/config.js`
(key loading), `scripts/rotate-key.js`, `scripts/rotate-index-key.js`,
[docs/security/ENCRYPTION-AND-KEYS.md](../security/ENCRYPTION-AND-KEYS.md).

## Tests that pin it

`test/crypto.test.js`, `test/api.test.js` (encryption at rest: raw rows are ciphertext),
`test/rotate-index-key.test.js`, `test/name-index-migration.test.js`, `test/reason-privacy.test.js` (typed
reasons out of plaintext and audit details), `test/sync.test.js` (every `_enc` column declared for sync).

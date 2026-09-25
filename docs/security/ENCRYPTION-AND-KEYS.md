# Encryption and key management

## At rest

| Layer | Algorithm | Key | Code |
| --- | --- | --- | --- |
| PHI fields (every `*_enc` column: names, DOB, contact details, notes, visit and call summaries, consents, disclosures, forms and attachments, MFA secrets…) | AES-256-GCM, a fresh 96-bit IV per value, 128-bit tag; stored as `v1:<iv>:<tag>:<ciphertext>` | `SUDS_ENCRYPTION_KEY` (256-bit) | `server/crypto.js` `encrypt`/`decrypt` |
| Searchable copies (`*_idx`) | HMAC-SHA256 over a normalised form of the value (blind index) | `SUDS_INDEX_KEY` (256-bit) | `server/crypto.js` `blindIndex`, `server/clients-model.js` |
| Audit chain | HMAC-SHA256 per entry, chained by previous hash; head sealed and anchored | `SUDS_INDEX_KEY` | `server/audit.js`, `server/audit-anchor.js` |
| Backups | AES-256-GCM over the whole database snapshot (`[IV][tag][ciphertext]`) | SHA-256(`SUDS_BACKUP_KEY` ‖ label), or SHA-256(`SUDS_ENCRYPTION_KEY` ‖ label) when no backup key is set | `server/backup.js` `backupKey` |
| Passwords | scrypt (N=32768, r=8, p=1), per-user salt; computed off the event loop | — | `server/crypto.js` `hashPasswordAsync` |
| API keys, session tokens | Only SHA-256 hashes stored; raw values shown once | — | `server/routes/admin.js`, `server/auth.js` |
| Database file, logs, keys.json | File mode 0600 (process umask 077 in production); the host volume should be encrypted (BitLocker / LUKS / cloud disk with KMS) | County-managed volume key | `server/index.js`, `server/db.js` |
| Local-mode / on-device copies | Same AES-256-GCM scheme in the browser; keys in the browser profile; device backups keyed by PBKDF2-SHA256 (600,000 iterations) from a passphrase | Per device | `local/`, `../WEB_APP.md` |

The field-level scheme means a stolen database file, a stolen backup, or a database administrator reading tables without the keys sees ciphertext. The known residual leak is equality/frequency of blind-indexed values (documented in `../HIPAA.md`, risk register).

At startup the server compares a fingerprint of the key it was given with the one recorded in the database and refuses to start on a mismatch rather than writing records under two keys (`server/db.js` `checkKeyFingerprint`).

## In transit

TLS 1.2+ either natively (`TLS_CERT_PATH`/`TLS_KEY_PATH`, or the setup wizard's self-signed ECDSA P-256 certificate and name-constrained private CA) or at a reverse proxy (`Caddyfile`, with HSTS). With native TLS the app sends HSTS itself (`server/http.js`). Network access from other devices cannot be enabled without HTTPS (`server/routes/admin.js` network settings). Session cookies are `HttpOnly; SameSite=Strict; Secure`. Outbound calls to an identity provider use HTTPS with Node's certificate validation.

## Where keys live and who holds them

| Deployment | Key location | Custodian |
| --- | --- | --- |
| IT-managed (recommended) | Environment variables injected from the county secrets manager (Azure Key Vault, AWS Secrets Manager / SSM, HashiCorp Vault, CyberArk…) into the service at start | County IT key custodian(s) named in the county's key-custodian log |
| Setup-wizard install (small office) | `<data>/keys.json`, mode 0600, generated on first start; the administrator must download the key backup (Settings → System & backups) and store it apart from the database backups | The programme's administrator and a named deputy |

SUDS (the project) never holds a county's keys: there is no vendor service, no key escrow and no telemetry. Losing every copy of `SUDS_ENCRYPTION_KEY` makes the PHI unrecoverable, by design.

### Customer-managed keys

Every key is supplied by the county, so they are customer-managed by construction. SUDS does not call a KMS API itself (no envelope-encryption integration); the pattern is:

* the three application keys are secrets in the county's KMS-backed secret store, released to the host at service start (systemd `EnvironmentFile`/`LoadCredential`, container secrets, cloud-init);
* the data volume is encrypted with a customer-managed key (Azure disk encryption set with a Key Vault key; EBS with a customer-managed KMS key; LUKS/BitLocker on premises);
* backups and offsite copies are already ciphertext; storing them in a bucket or share that is also encrypted with a customer-managed key adds a second layer.

Revoking the secret-store access (or the volume key) stops the service from starting, which is the "kill switch" a county can hold.

## Rotation

Procedures, with the server stopped and a backup taken first: `../DEPLOYMENT.md`, "Key rotation runbook".

| Key | Command | What it does | Evidence |
| --- | --- | --- | --- |
| `SUDS_ENCRYPTION_KEY` | `NEW_ENCRYPTION_KEY=… npm run rotate-key` | Re-encrypts every `*_enc` column, discovered from the schema (so new PHI columns cannot be missed; `test/backup.test.js`); records the new key fingerprint | audit entry `security.key_rotated` |
| `SUDS_INDEX_KEY` | `NEW_INDEX_KEY=… npm run rotate-index-key` | Re-derives every blind index from decrypted values, re-signs the audit chain in order after verifying it under the old key, re-seals the head, writes a new audit anchor under the new key | audit entry `security.index_key_rotated`; anchor with reason `index-key-rotation` |
| `SUDS_BACKUP_KEY` | change the variable | Next backup uses the new key; keep the retired key for as long as backups made with it are retained | — |

Recommended cadence: annually, on custodian change, and after any suspected exposure. Settings → Security status shows when the PHI key was last rotated (or first used) and flags it after 400 days.

## Cryptographic implementation

Node.js's built-in OpenSSL (`node:crypto`) only; no custom primitives. TOTP is RFC 6238 (HMAC-SHA1, 30 s, ±1 step) with timing-safe comparison (`server/crypto.js`). OIDC ID tokens: RS256 only; `none` and symmetric algorithms refused (`server/oidc.js`). FIPS: SUDS uses only FIPS-approved algorithms (AES-GCM, SHA-256, HMAC, and scrypt for password storage — scrypt is not FIPS-approved; a county that requires FIPS 140-validated modules should run Node against a FIPS-validated OpenSSL provider and raise the password-hash question with the project).

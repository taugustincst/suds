# Encryption and key management

## At rest

| Layer | Algorithm | Key | Code |
| --- | --- | --- | --- |
| PHI fields (every `*_enc` column: names, DOB, contact details, notes, visit and call summaries, consents, disclosures, forms and attachments, MFA secrets…) | AES-256-GCM, a fresh 96-bit IV per value, 128-bit tag; stored as `v1:<iv>:<tag>:<ciphertext>` | `SUDS_ENCRYPTION_KEY` (256-bit) | `server/crypto.js` `encrypt`/`decrypt` |
| Searchable copies (`*_idx`) | HMAC-SHA256 over a normalised form of the value (blind index) | `SUDS_INDEX_KEY` (256-bit) | `server/crypto.js` `blindIndex`, `server/clients-model.js` |
| Audit chain | HMAC-SHA256 per entry, chained by previous hash; head sealed and anchored | `SUDS_INDEX_KEY` | `server/audit.js`, `server/audit-anchor.js` |
| Evidence signatures (recovery-drill reports, audit-export manifests) | Ed25519 (RFC 8032) over the canonical report / the manifest; verified with the public key only (`npm run verify-dr-report`, `npm run verify-audit-export -- --public-key`) | `SUDS_SIGNING_KEY` (32-byte private key; env, else `keys.json`, generated there if absent; never in the database). Public key: `GET /api/admin/security/signing-key` | `server/signing.js`, `server/dr-report.js`, `server/audit-export.js` |
| Backups | AES-256-GCM over the whole database snapshot (`[IV][tag][ciphertext]`) | SHA-256(`SUDS_BACKUP_KEY` ‖ label), or SHA-256(`SUDS_ENCRYPTION_KEY` ‖ label) when no backup key is set | `server/backup.js` `backupKey` |
| Passwords | scrypt (N=32768, r=8, p=1), per-user salt; computed off the event loop | — | `server/crypto.js` `hashPasswordAsync` |
| API keys, session tokens | Only SHA-256 hashes stored; raw values shown once | — | `server/routes/admin.js`, `server/auth.js` |
| Database file, logs, keys.json | File mode 0600 (process umask 077 in production); the host volume should be encrypted (BitLocker / LUKS / cloud disk with KMS) | County-managed volume key | `server/index.js`, `server/db.js` |
| Local-mode / on-device copies | Same AES-256-GCM scheme for `*_enc` columns in the browser, but the database file itself is stored unencrypted in IndexedDB and the keys sit beside it in the same profile, so a lost device is protected only by its own disk encryption and lock (see "On-device build" below); device backups keyed by PBKDF2-SHA256 (600,000 iterations) from a passphrase | Per device | `local/`, `../WEB_APP.md` |

The field-level scheme means a stolen database file, a stolen backup, or a database administrator reading tables without the keys sees ciphertext. The known residual leak is equality/frequency of blind-indexed values (documented in `../HIPAA.md`, risk register).

At startup the server compares a fingerprint of the key it was given with the one recorded in the database and refuses to start on a mismatch rather than writing records under two keys (`server/db.js` `checkKeyFingerprint`).

### Blind indexes and key separation

A blind index is `HMAC-SHA256(SUDS_INDEX_KEY, normalised value)`: deterministic, so equal values can be found without decrypting anything. That is also its limit. For a low-entropy value anyone who holds the **index key** can recover the value by trying every candidate — there are about 36,500 dates of birth in a century (`dob_idx`), a few thousand three-letter surname prefixes and Soundex codes (`name_prefix_idx`, `name_phonetic_idx`), and at most ten billion phone digit strings (`phone_idx`). `test/blind-index-keys.test.js` recovers a DOB from its index in well under a second to keep that fact visible. ZIP code and city are not indexed; they are plaintext columns (`../HIPAA.md`, the table of what each table stores).

What keeps this acceptable:

* **Two keys.** `SUDS_INDEX_KEY` is a separate 256-bit key from `SUDS_ENCRYPTION_KEY`; the index key cannot decrypt a record, and the encryption key does not reproduce an index. A production server whose two keys (or `SUDS_BACKUP_KEY` and either of them) are the same value says so in the startup log, `/api/health` and Security status (`server/startup-checks.js` `keySeparationProblem`).
* **Where each lives.** Both come from the environment (the county's secret store) or, on a setup-wizard install, `<data>/keys.json` (mode 0600) — never the database. The index key has to be present wherever indexes are computed or the audit chain is verified (the office server, `scripts/rotate-index-key.js`, `scripts/verify-audit-export.js` with the key), so it is handed to more places than the encryption key; treat it as a secret of the same class.
* **Per install.** Each install generates its own index key, so an index value from one county (or one device) says nothing about the same person at another (`test/blind-index-keys.test.js`).
* **Rotation** re-derives every index under the new key (`npm run rotate-index-key`).

Someone with the database file **and** the index key can therefore learn dates of birth and phone numbers of every client, and test guesses at surnames, without the encryption key. Someone with the database file alone learns only which records share a value.

### On-device build (SUDS on this device, and a navigator's offline copy)

What a lost or stolen laptop or phone exposes, precisely. Code: `local/shims/sqlite.js`, `local/shims/config.js`, `local/shims/crypto.js`, `local/kernel.js`.

* **The database is not encrypted as a whole.** The kernel runs SQLite in the page (sql.js) and saves the complete database file, as ordinary SQLite bytes, to IndexedDB (database `suds-local`, object store `kv`, key `db2:<epoch>`) after each write.
* **PHI columns inside it are encrypted** with the same AES-256-GCM scheme as the office server (every `*_enc` column), and blind indexes use the same HMAC scheme.
* **The keys sit beside the data.** The encryption key (`suds.local.enc`) and the index key (`suds.local.idx`) are 256-bit random values generated on first run and stored as hex in the same browser profile's `localStorage`. They are **not derived from the device password or any passphrase**, and nothing wraps them: a browser has no Keystore or Keychain for a web page. The session token (`suds.local.session`) is in `localStorage` too.
* **So the field encryption does not protect a lost device.** Anyone who can open that browser profile — the device unlocked, or its disk readable because it is not encrypted, or the operating-system account's password known — can copy IndexedDB and `localStorage` and decrypt every record. Browsers do not encrypt IndexedDB or `localStorage` at rest themselves. The protection is the device's: full-disk encryption (BitLocker, FileVault, Android/iOS device encryption), a screen lock, and an operating-system account nobody else uses.
* **In plain text even without the keys:** every column that does not end in `_enc` — the client code; city and ZIP; gender, pronouns, race and ethnicity, language, veteran status; housing and insurance; status, risk level, and intake/referral/engagement/discharge dates; primary and secondary substance, route of use, ASAM level, MAT status and medication, overdose history and dates, naloxone dates; the justice-involved, pregnant-or-parenting and co-occurring flags; dates, types and durations of visits, calls, referrals and tasks; assignments; staff usernames, display names, roles and scrypt password hashes; and the device's audit log (who did what to which record id, and when). Combined, these identify a person and say they are in SUD treatment.
* **What the device does not keep:** the office password (typed at each sync; the sync session is signed out at the end of the run), MFA secrets (never sent to a device), and other staff members' password hashes (a placeholder is sent).
* **Removing it:** "Erase this device" deletes the IndexedDB store and the keys; an administrator's remote wipe takes effect the next time the device signs in to sync (`local/sync.js`). A client taken off the navigator's caseload at the office is removed from the device at its next sync (`server/routes/sync.js` `dropped_clients`). Device backups (`local/backup.js`) are the exception to all of the above: the whole database and both keys are encrypted with AES-256-GCM under a key derived from a passphrase (PBKDF2-SHA256, 600,000 iterations), so a backup file on its own is protected by that passphrase.

The device-setup screen and the Sync page say this in plain words before any record is entered (`public/views/login.js`, `public/views/local.js`).

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
| `SUDS_SIGNING_KEY` | change the variable (or the entry in `keys.json`) and restart | New reports and exports are signed with the new key; publish its public key to the auditor and keep the old public key to verify documents signed before the change | Security status → *Evidence signing key* shows the key id |

Recommended cadence: annually, on custodian change, and after any suspected exposure. Settings → Security status shows when the PHI key was last rotated (or first used) and flags it after 400 days.

## Cryptographic implementation

Node.js's built-in OpenSSL (`node:crypto`) only; no custom primitives. TOTP is RFC 6238 (HMAC-SHA1, 30 s, ±1 step) with timing-safe comparison (`server/crypto.js`). OIDC ID tokens: RS256 only; `none` and symmetric algorithms refused (`server/oidc.js`). FIPS: SUDS uses only FIPS-approved algorithms (AES-GCM, SHA-256, HMAC, Ed25519 — approved in FIPS 186-5 — and scrypt for password storage — scrypt is not FIPS-approved; a county that requires FIPS 140-validated modules should run Node against a FIPS-validated OpenSSL provider and raise the password-hash question with the project).

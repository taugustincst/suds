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
| Local-mode / on-device copies | Same AES-256-GCM scheme for `*_enc` columns in the browser; the whole database image is sealed with AES-256-GCM under a data-encryption key that is wrapped per device account under PBKDF2-SHA256 (600,000 iterations) of that account's password, and the column keys are sealed under it too — nothing readable without a password (see "On-device build" below, ADR-0008); device backups keyed by PBKDF2-SHA256 (600,000 iterations) from a passphrase | Per device, per account | `local/`, `../WEB_APP.md` |

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

What a lost or stolen laptop or phone exposes, precisely. Design: [ADR-0008](../architecture/ADR-0008-device-encryption.md). Code: `local/vault.js`, `local/kernel.js`, `local/shims/sqlite.js`, `local/backup.js`.

* **The whole database is sealed at rest.** The kernel runs SQLite in the page (sql.js) and saves the complete database after each burst of writes — but only as a sealed image: AES-256-GCM under a random 256-bit data-encryption key (DEK), a fresh 96-bit IV per save, stored in IndexedDB (database `suds-local`, object store `kv`, key `db2:<epoch>`, format `suds-sealed-db`). No database is ever written there in the clear; until a device has an account whose password can open its key, saves are held in memory rather than written.
* **The key is wrapped by the account passwords.** The DEK is never stored as it is. For each device account it is wrapped (AES-256-GCM) under a key derived from that account's password with PBKDF2-SHA-256, 600,000 iterations and a random 128-bit salt per wrap — the strongest KDF WebCrypto offers (it has no scrypt or Argon2). The wraps are in the same store under the key `vault`, looked up by a salted SHA-256 of the lower-cased username, so the vault holds no usernames. Any account on the device opens the same DEK, each only with its own password.
* **The column keys are sealed too.** The `*_enc` encryption key and the blind-index key are sealed under the DEK inside the vault. Nothing in `localStorage` is key material; the session token is kept only in the page's memory.
* **Locked after every page load.** Until someone signs in, the page has no database open and no key; it answers only the sign-in page's status (whether the device has accounts, whether sign-up is on, the programme's contact line — kept in the vault as `hints`, no names or records) and a sign-in. Signing out, or the idle limit (15 minutes; a backstop in the kernel as well as the page's own sign-out), saves, closes the database and zeroes the key: the password is needed again.
* **A new person needs someone to vouch.** On a locked device, Sign up asks for the username and password of someone who can already unlock it, because a new wrap gives its holder every record on the device. The same fields appear when an account with no wrap of its own signs in for the first time (an account from before this change on a shared device, or one restored from an old backup).
* **Password changes re-wrap.** A change of one's own password, an administrator setting a password on the device, an account created there, and a sync that brings down the office password for this account each wrap the DEK for the new password and replace the old wrap.
* **What is still exposed.** While someone is signed in, the decrypted database and the key are in the page's memory (as with any running app). A copy of the store can be attacked offline at the PBKDF2 rate: a weak password is the weak point, and the device's lockout counter cannot run while the database is sealed (the kernel slows repeated misses; it cannot stop an offline guesser). The sizes of the image and the timing of saves are visible.

**Forgotten passwords.** Nobody — not SUDS, not an administrator — can open the device's records without an account password. On *SUDS on this device*: another account on the same device that may manage users can set a new password (it is wrapped at that moment); otherwise the records come back only from a device backup, or not at all. The set-up screen says so before the first record, and **This device** repeats it. On an office-synced device: an administrator's password reset at the office reaches the device only through a sync run by someone who can unlock it (the sync brings the new office password down and re-wraps); a person who cannot unlock their device erases it ("Reset this device"), sets it up again and syncs — the caseload is re-downloaded from the office, and anything recorded on the device but not yet synced is lost.

**Device backups.** A backup (`local/backup.js`) holds the whole database and both column keys, sealed with AES-256-GCM under a key derived from a passphrase the person chooses (PBKDF2-SHA-256, 600,000 iterations), separate from any account password. It also carries each account's wrap, a fresh key for the device it will be restored onto, and that key sealed under this device's DEK — never this device's DEK. After a restore, the accounts in the backup sign in with the passwords they had when it was made and are re-wrapped at that sign-in. The backup file and its passphrase are the only way back from a forgotten password with no other account on the device; the backup dialog says so.

**Devices set up before encryption at rest.** A database found in the clear (and its keys in `localStorage`) is opened as before and sealed at the next successful sign-in: the first sealed save writes the vault, overwrites the plaintext image and deletes any older `db` copy in one IndexedDB transaction; the keys are then removed from `localStorage`, the store is read back to check that no plaintext image remains, and the device's audit log records `device.encrypted_at_rest`. On a device shared by several accounts, whoever signs in first seals it; the others are vouched for once.

**Removing it.** "Erase this device" deletes the IndexedDB store (sealed image and vault) and anything left in `localStorage`; an administrator's remote wipe takes effect the next time the device signs in to sync (`local/sync.js`). A client taken off the navigator's caseload at the office is removed from the device at its next sync (`server/routes/sync.js` `dropped_clients`).

**What the device does not keep:** the office password (typed at each sync; the sync session is signed out at the end of the run), MFA secrets (never sent to a device), and other staff members' password hashes (a placeholder is sent). Inside the sealed image, the same columns are plaintext as on the office server (every column that does not end in `_enc`: the client code, city and ZIP, demographics, substance use, dates, the audit log…) — they are now protected by the image seal, not only by the device's disk encryption.

The device-setup screen and the This device / Sync page say this in plain words before any record is entered (`public/views/login.js`, `public/views/local.js`). Full-disk encryption, a screen lock and an operating-system account nobody else uses remain good practice: they protect what is in memory while someone is signed in.

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

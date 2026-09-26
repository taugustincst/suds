# ADR-0008: The device database is sealed under a key only an account password opens

- **Status:** accepted
- **Date recorded:** 2026-09-25 (encryption at rest on the device; supersedes the "keys beside the data" design
  of local mode 1.1.0–1.11.0)

## Context

The browser kernel (ADR-0002) keeps a whole SQLite database in IndexedDB. Up to 1.11 that image was stored as
ordinary SQLite bytes, and the two `_enc` column keys were random values in the same profile's `localStorage`.
Field encryption therefore protected nothing on a lost or shared device: anyone who could open the browser
profile, or read its files from a disk without encryption, could copy both stores and read every record, and
everything outside the `_enc` columns (dates, substance use, risk, the audit log) was readable without any key.
SUDS is offered to outreach workers who carry laptops and phones into the field, so this is the likeliest
breach the product has.

A web page has no Keystore or Keychain, and WebCrypto offers no memory-hard KDF. The only secret the device
does not store is the password its people type.

## Decision

- **Envelope encryption.** The database image is sealed with AES-256-GCM under a random 256-bit
  data-encryption key (DEK) before it reaches IndexedDB (`local/vault.js` `seal`; a fresh 96-bit IV per save).
  The `_enc` column keys are sealed under the DEK too, inside the vault. Nothing in `localStorage` is key
  material, and the session token lives only in the page's memory.
- **One wrap per device account.** The DEK is wrapped (AES-256-GCM) under a key derived from each account's
  password with PBKDF2-SHA-256, 600,000 iterations, a random salt per wrap. The wraps live in the vault
  (IndexedDB key `vault`), found by a salted hash of the username so the vault stores no usernames. Any
  account on the device can unlock it; each only with its own password.
- **Locked by default.** After every page load the kernel has no database open and no key (`phase` `locked`):
  it answers only the sign-in page's status, a sign-in, and a vouched-for sign-up. A sign-in unwraps the DEK,
  unseals the image, opens it, then runs the ordinary login route (lockout, audit); a sign-in that then fails
  closes it again after saving what the attempt recorded. Signing out, or the kernel's idle backstop (the
  session's idle limit; two minutes open with nobody signed in), saves, closes the database and zeroes the key.
- **Wraps follow passwords.** Every moment a new password is known on an open device re-wraps: a password
  change, an administrator setting a password on the device, an account created there, a sign-in by an
  account with no wrap of its own yet, and a sync that brings the office password down for this account
  (`local/kernel.js` `afterPasswordEvent`). A wrap whose account was removed or deactivated goes (never the
  last one); a username change or an office merge re-points it (`reconcileVault`).
- **New people need someone to vouch.** A new wrap gives its holder the key to every record on the device,
  so on a locked device Sign up (and a first sign-in by an account that has no wrap) asks for the username and
  password of someone who can already unlock it. The kernel checks them and never passes them to a route.
- **Saves.** Coalesced as before (250 ms), stretched to twice the last save's cost (at most 4 s) for a large
  image. Ordinary saves seal with WebCrypto (async, off the main thread) and are dropped if a newer save was
  issued meanwhile; the unload save (pagehide, hidden, freeze) seals synchronously with the vendored
  `@noble/ciphers` GCM, because nothing asynchronous can be waited for on the way out. Both produce the same
  format. Saves of the image issue all their requests and commit at once, so a frozen page never holds the
  store (see *Consequences*); vault writes stay fenced (read the epoch, then write) so a displaced page cannot
  replace the holder's vault. Saves are withheld, never written in the clear, until the device has a key
  someone can open (the first account on a new device).
- **Migration.** A database found in the clear (1.9.3–1.11: `db2:<epoch>`, or `db` before that, keys in
  `localStorage`) is opened as before and sealed at the next successful sign-in: the first sealed save writes
  the vault, overwrites the plaintext image and deletes `db` in one transaction; then the `localStorage` keys are
  removed and the store is read back to prove no plaintext image remains (`eraseLegacyCopies`, audit action
  `device.encrypted_at_rest`). Every later sealed save also deletes `db`, which an old-release tab could
  still write.
- **Backups and restore.** A device backup (`local/backup.js`) was already sealed with a key derived from its
  passphrase (PBKDF2-SHA-256, 600,000 iterations); that does not change. It now also carries the accounts'
  wraps, a fresh key for the device it will be restored onto, and that key sealed under this device's DEK (the
  *chain*) — never this device's DEK. A restore seals the restored image under the fresh key and switches the
  page to it in place; the accounts log in with the passwords they had when the backup was made (wrap → old
  DEK → chain → new DEK) and are re-wrapped directly at their first sign-in. A backup from before this change
  carries no wraps: the first of its accounts to sign in, in that page, gets one, and the rest are vouched for.
- **Key rotation after a restore (1.12.1).** The fresh key a backup carries (`next_dek`) is written in the
  backup, so up to 1.12.0 whoever held the backup and its passphrase, and later the device's browser storage,
  could read everything recorded after the restore. A restored vault is now marked `rekey: 'restore'`; the
  first time an account from the backup proves its password on the device (its sign-in, or vouching for
  someone), `vault.rekeyAfterRestore` makes a new DEK, re-seals the column keys under it, wraps it for that
  account, keeps the other carried wraps (each opens the backed-up device's DEK, D0, with its password) and
  re-seals the chain **from D0 to the new DEK**, and drops any other wrap (an account enrolled before, which
  wraps the backup's key; it is vouched for again). The vault keeps the dropped wraps' lookup names (`dropped_after_restore`, salted hashes, never usernames) until each account has a wrap again, so that account's next sign-in is told *This device was restored from a backup and moved to a new key; your sign-in on this device must be re-approved by someone who can already sign in here* instead of *Username or password is incorrect*, and the `device.key_rotated` audit entry lists the dropped account ids (`dropped_accounts`). `local/kernel.js` `rekeyIfRestored` swaps the key and stores
  the re-sealed image with the new vault in one write, or changes nothing if that write does not land. Why
  this scheme: re-wrapping every account at once is impossible without their passwords, and sealing the new
  key under the backup's key would defeat the rotation; D0 is the one secret every backed-up account can reach
  and the backup's holder cannot (the backup holds only password-protected wraps of it). Rejected: rotating
  only when every account has signed in once (leaves the window open indefinitely on a shared device), and
  rotating only for a sole account. The window that remains — from the restore to the first such sign-in —
  holds only the restore's audit entry unless an account without a carried wrap is let in first (then the
  rotation waits for a backed-up account); stale copies the browser's storage engine keeps until compaction
  are outside SUDS's reach. The column keys are not rotated (the image that holds their ciphertext is sealed
  under the new DEK).

## Consequences

- A lost or stolen device, or a copied browser profile, exposes nothing without an account password — but a
  weak password is guessable offline at the PBKDF2 rate (the device's `failed_attempts` lockout cannot run
  while the database is sealed; the kernel only slows repeated misses). The password policy (12+ characters,
  mixed) is the real protection.
- **A forgotten password is unrecoverable** unless another account on the device can sign in (and resets it
  as device administrator — the new password is wrapped then) or a backup exists. The set-up screen and This
  device say so. On an office-synced device, an administrator's reset at the office reaches the device only
  through a sync by someone who can unlock it; otherwise the device is erased and set up again, and the
  caseload is re-downloaded from the office (anything not yet synced is lost).
- While someone is signed in, the database and its key are in the page's memory, as any running app's are.
- A page load always needs a sign-in, including the reload after a new release and "Use SUDS in this window".
- Holding the store is now callback-free for image saves. Before this, an ordinary save issued its put from the
  epoch read's callback; a holder frozen (or paused in a debugger) between the two kept its readwrite
  transaction open, and a window taking over hung at "Starting SUDS on this device…" behind it (the
  intermittent `multitab.mjs` failure, frozen-holder case). The dead copy a displaced page's blind save can
  leave is deleted as soon as the page learns it was displaced.
- Measured (headless Chromium on the development machine, 2026-09-25): a 5.3 MB database saves in about
  37 ms (export 4, seal 22 — WebCrypto, off the main thread — write 11), and a write reaches IndexedDB about
  325 ms after it is made (the 250 ms coalescing). A 57 MB database saves in about 400 ms (export 40, seal
  235, write 115), so writes coalesce for about 0.8 s. The unload save seals on the main thread with the pure
  JavaScript GCM: 0.2 s at 5 MB, 2.0 s at 57 MB — a very large device can lose the last background write
  (a preference, an autosave) if the browser kills the page first; explicit saves are awaited before the
  page says "saved" (public/app.js), so they never depend on it. `scripts/ui/device-encryption.mjs` prints
  the 5 MB figures on every run.

## Read

`local/vault.js` (format, KDF, wraps, chain), `local/kernel.js` (the section "encryption at rest", `enrol`,
`unlockWith`, `lockDevice`, `lockedAnswer`, `afterPasswordEvent`, the restore route), `local/shims/sqlite.js`
(sealer, `saveBytes` blind vs fenced, `readCurrent`, `replaceWith`), `public/views/login.js` (the
vouching fields), [docs/security/ENCRYPTION-AND-KEYS.md](../security/ENCRYPTION-AND-KEYS.md), *On-device build*.

## Tests that pin it

`test/device-vault.test.js` (sealing, wraps, iterations, per-wrap salts, key sealing, the backup chain, the
key rotation after a restore, plaintext detection — under Node's WebCrypto); browser `scripts/ui/device-encryption.mjs` (raw IndexedDB holds
no name, plaintext column or SQLite header; no key material in `localStorage`; locked after reload; wrong
password; second account; password change; ~5 MB save timings; migration from a plaintext store; after a
restore, the stored image and column keys stop opening with the key in the backup at the first sign-in, and the
other backed-up account still unlocks with its old password);
`scripts/ui/signup.mjs` (vouched sign-up, backup and restore with both accounts); `scripts/ui/multitab.mjs`
(fencing and takeover with sealed saves, an old-release tab's plaintext copy removed).

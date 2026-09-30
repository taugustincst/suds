# Fingerprint sign-in, authorization and signing (passkeys)

Built for 1.19.0, not yet released. Office server only.

Staff can sign in to SUDS, finish two-step verification, sign and countersign notes, approve time and spending, and
download the key backup with their **fingerprint** — or with whatever else their device uses to unlock (Face ID, a
Windows Hello PIN, an Android screen lock). This is done with **passkeys**: WebAuthn credentials held by the
device's own *platform authenticator* (Touch ID, Windows Hello, an Android phone's fingerprint reader). SUDS verifies
them with Node's built-in `node:crypto` only (`server/webauthn.js`), in keeping with its zero-dependency rule.

- Server: `server/webauthn.js` (CBOR, authenticator data, COSE keys, signature checks, offline evidence check),
  `server/passkeys.js` (relying party, challenges, enrolment, sign-in, signing), `server/routes/passkeys.js`,
  `auth.verifySigner` / `auth.verifyApprover` (the signing and approval step), migration 58.
- Browser: `public/passkey.js`; My profile → **Fingerprint sign-in**; the sign-in page; the second sign-in step;
  the signature and approval dialogs; Settings → Security policy.
- Tests: `test/fingerprint.test.js` with a software authenticator (`test/authenticator.js`);
  `test/fingerprint-review.test.js` for the review's fixes, with outside test vectors (`test/fixtures/webauthn/`: real
  browser and authenticator responses from py_webauthn's suite, BSD-licensed and attributed, and RFC 8949 Appendix A's
  CBOR examples); the browser script `scripts/ui/fingerprint.mjs` with Chromium's WebAuthn virtual authenticator.

## Principles

### SUDS never receives or stores a fingerprint

The fingerprint never leaves the device. The device's authenticator compares the finger with what it enrolled
itself (in its own secure hardware, under the operating system's control) and, if it matches, **signs** SUDS's
challenge with a private key that also never leaves the device. SUDS receives a signature and checks it with the
passkey's **public key**. There is no fingerprint image, template, minutiae, hash of a fingerprint or any other
measurement of a body in anything SUDS is sent, stores, logs or backs up.

What SUDS **does** store, per passkey (table `passkeys`, office server only, never synchronised to devices):

| Stored | Why |
| --- | --- |
| The credential's **public key** (SPKI, base64) and its **algorithm** (ES256, EdDSA or RS256) | To check its signatures. A public key opens nothing. |
| The **credential id** (random bytes the authenticator chose) | To find the public key |
| The **signature counter** | Clone detection (below) |
| **Transports** (`internal`) and the **AAGUID** the device reported | Which kind of authenticator it is, for information (not verified: attestation is not requested) |
| Whether it is **backed up / synced** (the BE/BS flags) | Information for the owner (a synced passkey, in iCloud Keychain or Google Password Manager, lives on their other devices too) |
| The **host it was made for** (the relying party ID) | An assertion must be for the same host |
| A **name** its owner gave it ("Maria's iPhone") | So people can tell their devices apart |
| **Dates**: added, last used; and, if the counter went backwards, when and why it was disabled | |

Also stored: the **challenges** waiting for an answer (table `webauthn_challenges`: SHA-256 of the challenge only,
purpose, user, session, expiry, used), and for every signature or approval confirmed with a fingerprint its
**evidence** (table `signature_evidence`, below). Neither holds anything biometric.

**For privacy officers and counsel.** This is SUDS's technical position, for the programme's counsel to confirm:

- **CCPA/CPRA "biometric information"** (Cal. Civ. Code §1798.140(c)) is physiological or behavioral characteristics
  "that can be used … to establish individual identity", including "imagery of the … fingerprint … from which an
  identifier template … can be extracted". SUDS collects none: it receives no imagery, template or measurement, and
  cannot derive one from a public key or a signature. What it stores is a staff credential's public key and metadata.
- **Illinois BIPA and similar laws** regulate the collection, capture, storage and disclosure of a "biometric
  identifier" (such as a fingerprint) or "biometric information" based on one. The matching happens on a device the
  person controls (often their own phone), by the device's maker's software; SUDS never possesses the identifier or
  information derived from it. Because SUDS holds **no biometric data**, it needs **no biometric retention and
  destruction schedule**; the passkey records above are credentials, kept for the life of the account, removed when
  their owner or an administrator removes them, and **removed when the account is deactivated** (Users, SCIM
  deprovisioning, deprovisioning by absence).
- **HIPAA.** Fingerprints are "biometric identifiers" in the de-identification standard (§164.514(b)(2)(i)(P)) — for
  *patients*. SUDS stores no one's. A passkey is a staff member's authentication credential under the Security Rule's
  person or entity authentication standard (§164.312(d)), below.
- A programme that lets staff use **their own phones** should say so in its acceptable-use policy: the fingerprint
  (or face) the phone enrolled is the phone's, not the programme's.

### User verification is required — and it may be the device PIN

Every request SUDS makes asks for `userVerification: 'required'`, and SUDS **checks the UV flag** in the
authenticator data itself (it does not trust the browser to have asked). A passkey used without the device verifying
its user (presence only, a tap) is **refused**, at sign-in, as a second step and for a signature alike.

The UV flag is **self-asserted by the authenticator**: SUDS asks for no attestation (below), so nothing proves the
device is the kind that really checks a finger or a PIN; a counterfeit or software authenticator could set the flag
without asking anyone. SUDS relies on the flag as every relying party that does not verify attestation must, and
states it here so a programme that needs more can add device management or an attestation policy.

WebAuthn cannot tell SUDS *how* the device verified its user: most platform authenticators accept the device's
**PIN, pattern or password** in place of the finger (or face), and some fall back to it after failed finger
attempts. SUDS's claim is therefore "**the device verified its user**", not "a finger was scanned". The screens say
"your fingerprint (or your device's screen lock)" for that reason. A programme that needs to know it was a finger
cannot get that from WebAuthn and should rely on device management instead.

### Where passkeys work: the relying party, HTTPS, the origin

- The **relying party ID** is the office server's host name: `WEBAUTHN_RP_ID` (or `"webauthnRpId"` in `server.json`),
  or, when only `WEBAUTHN_ORIGINS` is set (the server's public address), that address's host. It **must match the host
  on the TLS certificate and in the address staff open**; a passkey made for one host answers only there.
- **In production it is required** (the owner's decision): without it SUDS issues no passkey options at all —
  enrolment, sign-in and "Confirm with fingerprint" answer `503` with `passkeyUnavailable: "config"` and a message for
  the administrator, the sign-in page and My profile say fingerprint sign-in is not set up, and **Settings → Security
  status shows a red line** ("not working: WEBAUTHN_RP_ID is not set"). Only outside production (development, the
  test and browser suites) does it fall back to the request's `Host` header. A proxy's `X-Forwarded-Host` never chooses
  the RP ID: it is used only to check the address the browser used and to build the page's origin, behind a trusted
  proxy (`TRUST_PROXY`).
- **HTTPS is required.** On plain http SUDS refuses to issue options, except on `localhost` (or a loopback address)
  outside production, for development. An address typed as an **IP** (https://192.168.1.10) cannot have a passkey:
  browsers refuse an IP as a relying party ID, and SUDS says so rather than offering a button that cannot work.
- The **origin** in the client data must be the page SUDS served (`https://<host>[:port]`, or the exact list in
  `WEBAUTHN_ORIGINS` when a proxy makes it differ), and a page in another site's frame is refused: `crossOrigin` must
  be `false` (or absent), and a `topOrigin`, when the browser reports one, must be SUDS's own page too.

### Challenges

- **Enrolment and sign-in:** 32 random bytes.
- **A signature or an approval:** the SHA-256 of a canonical statement of exactly what is being signed (below).
- **Stored hashed** (SHA-256 of the challenge), **single use** (spent by the first answer, right or wrong),
  **bound to its purpose** and, once signed in, **to the user and the session**, and good for **two minutes**.
- The assertion is checked against the **stored** challenge (its hash, `webauthn.js verifyAssertion` `challengeHash`),
  never against a value read from the response itself.
- **Before anyone has signed in** (the sign-in page's options), at most **20 unanswered challenges per address** and
  5,000 in all may wait; more are refused (`429`). A sweep at most once an hour deletes challenges that expired over
  an hour ago (a used one is kept that long so a replay is told it was used).

### Sign count and clone detection

The device's signature counter is stored and must go up. If a counter that was in use (non-zero) comes back **equal
or lower**, the passkey may have been copied: the sign-in or signature is **refused**, the passkey is **flagged**
(`flagged_at`, refused from then on until it is removed and added again) and the event is audited as
`auth.passkey.clone_suspected`; Settings → Security status counts flagged passkeys. Many platform authenticators
(synced passkeys especially) always report 0; a counter that stays at 0 is accepted.

### Attestation: none

SUDS asks for `attestation: 'none'` and records the AAGUID the device reports, for information only. It does not
ask the device to prove its make and model: that would identify the device more precisely than a sign-in needs, and
SUDS does not restrict which authenticators staff may use (the owner's decision). **An allow-list of authenticator
models** (by AAGUID, with attestation verified against the FIDO Metadata Service) is the option for a programme that
must: it is not built, and would be a setting beside the others, off by default.

### What the verifier accepts

`server/webauthn.js` accepts only what WebAuthn sends: CBOR with definite lengths, no tags, no floating point, text
strings that are valid UTF-8, integers up to 2^53-1, and no map with the same key twice (byte-string keys compared by
their bytes); reserved encodings are refused as not well-formed. Keys: ES256 on P-256 with a point on the curve;
EdDSA with a 32-byte Ed25519 key, reported as `-8` or as the fully specified Ed25519 `-19`; RS256 with a modulus of
**2048 bits or more** (counted by the key, so leading zero bytes do not make a short modulus look long) and the
exponent **65537**. The same key checks apply when a stored key is used again (evidence included). Authenticator
data: `BS` (backed up) without `BE` (backup eligible) is refused, and so is attested credential data (`AT`) in an
assertion.

## Enrolment

My profile → **Fingerprint sign-in** → **Add a passkey on this device**: a name, the **password again**, and with
two-step verification on the **authenticator code** as well (an account that signs in only through single sign-on
confirms with the identity provider instead). Then the device's own prompt. Every wrong password or code counts toward
the account lockout and is audited (`auth.passkey.enrol.failed`). The enrolment's audit entry (`auth.passkey.enrolled`,
in the hash-chained log) **anchors the key**: it records the SHA-256 of the public key (SPKI) and of the credential
id, so evidence can later be tied to the key SUDS accepted then (below). The platform authenticator is asked for
(`authenticatorAttachment: 'platform'`), discoverable where it can be (`residentKey: 'preferred'`); ES256, EdDSA and
RS256 are accepted. At most **10 passkeys** per account. Rename; **remove** (the password again). Enrolment,
renaming and removal are audited (`auth.passkey.enrolled`, `.renamed`, `.removed`), without the key or the name.

The card is shown only on the office server, and says plainly when this device or address cannot make a passkey.

On My profile it is called **fingerprint sign-in on this device**; "passkey" is explained once. The list marks the
one added in this browser ("This device": WebAuthn does not tell a page which passkeys a device holds, so the browser
remembers the ones it made, and forgets if its data is cleared) and the synced ones. The default name is the browser
and the device ("Safari on iPhone"). The two-step verification card updates as soon as one is added, and **recommends
adding an authenticator app as well**, so a lost or replaced phone does not lock its owner out.

**Administrators** (`users:manage`) see how many passkeys each person has (Users & permissions, the MFA column) and
can revoke them (Edit → "Revoke this person's passkeys"; `DELETE /api/users/:id/passkeys`), audited as
`user.passkeys.revoked`. **Resetting a person's two-step verification or their password** (Users → Edit) removes their
passkeys too (audited as `auth.passkey.removed` with the cause): both are how an account someone else may have had is
recovered. **Removing a passkey ends the sessions it opened** (`sessions.passkey_id`; when every passkey goes, every
session a passkey opened): a lost phone's passkey revoked does not leave that phone signed in. The owner's own session,
which has just given the password to remove it, stays. **Offboarding removes them**: deactivating an account, SCIM
deactivation (`cutOff`) and deprovisioning by absence delete the account's passkeys, so re-enabling the account does
not bring them back.

## Sign-in

- **Sign in with fingerprint** on the sign-in page: **discoverable passkeys only**. The options never list an
  account's credentials (`allowCredentials` is empty), whatever username is typed or sent, so the answer is the same
  for everyone and says nothing about who has an account or how many passkeys. (A made-up credential id for unknown
  usernames was the alternative; it cannot be made to look like a real account with two passkeys.) Where the browser
  supports it, the username field also offers the device's passkeys as suggestions (conditional UI,
  `autocomplete="username webauthn"`).
- **The second step** of a password sign-in: with two-step verification on, the authenticator code *or* the
  fingerprint; for a role that requires two-step verification, an account whose only second factor is a passkey
  finishes its password sign-in with the fingerprint. Here the person is known, so the options list their passkeys
  (a non-discoverable one works too). A code field is shown only to an account with an authenticator app. **No
  passkey on this device?** says how to get back in: the device it was set up on, or an administrator resets two-step
  verification (SUDS has no backup codes), after which they sign in with the password and set it up again.
- The errors are told apart: cancelled or timed out (on the sign-in page, with "or this device has no fingerprint
  sign-in for SUDS yet": browsers do not say which), "No fingerprint sign-in for SUDS was found on this device" (the
  device offered a passkey SUDS does not know), and "the device did not verify you" (no fingerprint or screen lock).
- The sign-in's protections apply as to a password: the per-address limit, the **lockout** (a locked account cannot
  sign in with a passkey either; a signature that does not verify, or a missing fingerprint check, counts toward
  it), inactive and pending accounts, and **"Require single sign-on"** — where it is on, passkey sign-in is refused
  like a password, except for the named emergency (break-glass) administrators, as for passwords. A device syncing
  in local mode still signs in with its password.
- Audited as `auth.login` with `method: "passkey"` (and `mfa: true` for the second step); failures as
  `auth.login.failed` / `auth.mfa.failed` with `method: "passkey"` and a reason code.

### Two factors, and NIST SP 800-63B

A passkey used with user verification is a **multi-factor cryptographic authenticator** in NIST SP 800-63B terms:
possession of the device holding the private key, plus the fingerprint (inherence) or device PIN (knowledge) that
unlocks it — the verification is done by the authenticator, and SUDS checks the UV flag it signs. So:

- A passkey **keeps counting as two-step verification** (the owner's decision, with no authenticator allow-list). A
  passkey sign-in **satisfies `MFA_REQUIRED_ROLES`** ("Require two-step verification for every role") on its own:
  the session records `mfa_source = 'passkey'`, and an account with a passkey counts as enrolled (it is not given an
  enrolment deadline, and Security status does not list it as without two-step verification).
- SUDS claims **AAL2**: phishing-resistant (the origin and RP ID are bound into what is signed), replay-resistant
  (single-use challenges), with UV. It does not claim AAL3: SUDS does not require a hardware-bound, non-exportable key
  (synced passkeys are exportable to the person's other devices, which NIST's 2024 supplement on syncable
  authenticators accepts at AAL2) and does not verify attestation.
- With **"Allow fingerprint sign-in" off**, a passkey no longer counts as a second factor: accounts that relied on it
  need the authenticator code again (a session already signed in with a passkey is not ended). `publicUser.passkey_mfa`
  says whether an account's passkey counts now, and the "Two-step verification required" banner follows it.

## Authorization and signing

Everywhere SUDS asks for the signature password or an authenticator code to sign or approve, **Confirm with
fingerprint** is offered as an equal alternative:

| Where | Purpose | Bound to |
| --- | --- | --- |
| Signing a note (`POST /api/notes/:id/sign`) | `note.sign` | the note, and the signature hash the note will carry |
| Countersigning (`POST /api/notes/:id/cosign`) | `note.cosign` | the note, and the countersignature hash |
| Countersigning several (`POST /api/notes/cosign-batch`) | `note.cosign-batch` | exactly those notes, each with its hash |
| Approving time (`POST /api/time/:id/approve`, `/approve-batch`) | `time.approve` | exactly those entries (worker, date, minutes, category, fund, client, status, version) and the decision |
| Approving or reimbursing spending (`POST /api/budget/expenditures/:id/approve`) | `expenditure.approve` | the expenditure (amount, fund, line, date, status, version) and the new status |
| Downloading the key backup (`POST /api/admin/keys-backup`) | `keys.download` | that download |

Time and spending approval asked for no proof before 1.19.0 and still ask for none by default; a fingerprint (or the
password or code) is taken when given and recorded, and **required** — as a fingerprint or an authenticator code —
when the programme turns on **"Require fingerprint or authenticator for signing"**. Returning time or rejecting
spending never needs proof. The approval dialog asks only when it must (the policy, outside the quick-signing window)
or when the person chose **"Confirm my approvals of time and spending with my fingerprint"** on My profile; within the
quick-signing window a fingerprint or code gave, an approval goes with a confirmation alone.

**A code that is given must verify.** Wherever a password and an authenticator code are both sent, both are checked,
and a wrong code refuses the request (a failed attempt, audited, counted toward the lockout) — a password with a
made-up code is not a password and a code. With "Require fingerprint or authenticator for signing" on, the password
alone never signs or approves, and that includes **the key backup's password** (`POST /api/admin/keys-backup`), as the
table above lists. A fingerprint is one proof on its own: sent with a password or code, the request is refused.

**A note signed on a device** (local mode, synced later) under that policy: the device's signature rests on its
password, so the office refuses it **as a signature**: the note lands as a **draft**, the device is told why (a flagged
warning in its sync result), and it is audited (`sync.conflict` flagged `strong_signing`, and `note.sign.failed` with
`via: "sync"`). Its author signs it at the office. The rule is in `server/rules/notes.js`, beside the REST route's
`auth.verifySigner`.

The signature dialog puts **the fingerprint first**, as its one primary button, with the focus on it (after any field
to fill in first, such as the AI-review statement), and "Or use your password" (or the code) after it. An account that
signs in through single sign-on sees the fingerprint beside **Confirm with single sign-on**. Where a fingerprint or a
code is required and the person has neither, there is no Sign button: the dialog says so and links to My profile.
After a fingerprint that fails, the button is enabled again and gets the focus back; while the device's prompt is up
it is marked `aria-disabled` rather than disabled, so the focus stays on it. The reason is said once, in the dialog's
own live status line.

### What a fingerprint signature is bound to

The browser asks for a challenge for a purpose and its records (`POST /api/auth/passkeys/challenge`). SUDS builds a
**statement**

```json
{ "v": 1, "purpose": "note.sign", "record_type": "note", "record_ids": ["<note id>"],
  "content": "<the note's content hash>", "user_id": "<signer>", "rp_id": "<host>",
  "issued_at": "<time>", "nonce": "<16 random bytes, hex>" }
```

For a note, `content` is the note's **plaintext content hash** (`server/note-signature.js contentHash`, the owner's
decision): SHA-256 over the canonical JSON of what is signed — the note id, the signer, the act (`sign` or `cosign`),
the note's kind, title, text, structured sections, when it happened (`occurred_at`) and whose record it is
(`client_id`). It does not change when the encryption key does, so the evidence verifies after a key rotation. For
countersignatures given together (`note.cosign-batch`) the statement also carries `items`, each note id with its own
content hash, and `content` is the hash of that list. For time and spending, `content` hashes the decision and the
entries' fields as listed above (none encrypted).

and the WebAuthn challenge is **SHA-256 over its canonical JSON** (keys sorted, no whitespace). The device signs
`authenticatorData || SHA-256(clientDataJSON)`, and the client data contains that challenge. When the signature
arrives, the route **computes the same binding again from the record as it is now** and SUDS refuses the confirmation
if the challenge was for another purpose, other records (a confirmation for note A cannot sign note B), content that
has changed since (the note was edited, the time entry changed), another user or another session — or if it is
reused, expired, not user-verified, from another origin or RP ID, or its signature does not verify.

### The evidence, and how it is verified

For every signature or approval confirmed with a fingerprint, SUDS stores (table `signature_evidence`, `evidence_enc`
encrypted like PHI; office server only) the **statement**, its **hash**, the **credential id**, the passkey's **public
key** and algorithm, the **authenticator data** (with its flags and counter), the **client data JSON** (and its
hash), the **signature**, the origin and RP ID, and when. Ids, hashes and a public key: no PHI and nothing biometric.
Its id is in the audit entry (`note.sign`, `note.cosign`, `time.approved`, `expenditure.approved`, `keys.download`
with `identity`/`method: "passkey"` and `evidence: <id>`).

It can be **re-verified later, offline, even after the passkey is removed** (the public key is in the evidence):

1. SHA-256 of the canonical statement equals the challenge in the client data;
2. the client data is a `webauthn.get` from an **https** page of the relying party (http only on localhost), with
   `crossOrigin` false or absent and no other `topOrigin`;
3. the authenticator data's RP ID hash is the relying party's, which is also the RP ID the **statement** names, with
   UP and UV set and no attested credential data;
4. the signature is valid over `authenticatorData || SHA-256(clientDataJSON)` under the stored public key, and that
   key and the credential id are **the ones enrolled**: their SHA-256 is in the enrolment's audit entry;
5. (for a note) the statement's `content` is the note's content hash **now**, recomputed from the note as stored — for
   a batch countersignature, the note's own hash is among the statement's `items`, whose hash is its `content`.

**Verify signature** on a note does all five (`GET /api/notes/:id/verify` → `fingerprint: { verified, at,
content_hash, reason }`, and `cosign_fingerprint`). An auditor with `audit:read` exports the evidence
(`GET /api/admin/signature-evidence?record_type=note&record_id=<id>`, audited; each row carries its passkey's
`enrolment` record) and checks it with nothing but Node:
`npm run verify-passkey-evidence -- evidence.json --content <content hash> --audit <audit export> [--public-key <pem>]`
(`scripts/verify-passkey-evidence.js`, using `server/webauthn.js verifyEvidence`). With `--audit` the enrolment
record is read from an audit export (`GET /api/admin/audit/export`), which is verified first (its hash chain and,
with `--public-key`, its signature); without it, the record the evidence export carries is used, and the output says
so — someone able to rewrite the evidence export could rewrite that record too, but not the signed audit log.

### The note's signature hash and key rotation

A note's own **signature hash** (`notes.signature_hash`, `cosignature_hash`, audited as `note.sign`/`note.cosign`
`hash`) has been taken over the note's **ciphertext** since electronic signatures began, and it stays that way for
back-compatibility: every signed note, audit entry and export names it. Before this review a key rotation
(`npm run rotate-key`) re-encrypted every note and left that hash stale, so **Verify signature** said every signed note
had been changed. `scripts/rotate-key.js` now checks each hash under the old ciphertext first and, for every one that
was intact, recomputes it over the new ciphertext; one that was not intact is left as it was (a note changed after it
was signed still shows it), and the rotation's audit entry counts both. The fingerprint evidence does not depend on it:
it is bound to the plaintext content hash above. (A device's copy of a note is encrypted under the device's own key,
so the ciphertext hash is only meaningful at the office, where Verify signature runs.)

### The quick-signing window

Unchanged, and a fingerprint opens it the same way a password does: after a fingerprint confirmation (or a
fingerprint sign-in), signatures within `sign_reauth_minutes` need only the confirmation of the attestation. A failed
fingerprint confirmation closes it, as a wrong password does. The session records how the window was opened
(`sessions.reauth_method`: `password`, `totp`, `passkey`, `sso`); under **"Require fingerprint or authenticator for
signing"** only a window opened by a fingerprint or an authenticator code counts. The key backup has no window: a
fingerprint is accepted there because each confirmation is a fresh, single-use challenge bound to that download.

## Settings → Security policy

| Setting | Default | Effect |
| --- | --- | --- |
| **Allow fingerprint sign-in** (`passkey_signin`) | On | Sign in with a passkey, and count it as two-step verification |
| **Allow fingerprint to confirm signatures and approvals** (`passkey_signing`) | On | "Confirm with fingerprint" in the signature and approval dialogs |
| **Require fingerprint or authenticator for signing** (`sign_strong_required`) | Off | Signing, countersigning, approving time or spending **and downloading the key backup** need a fingerprint or an authenticator code; the password alone is refused. A note signed on a device and synced lands as a draft. Staff with neither must set one up (the dialogs link to My profile). |

Changing any of them is audited on its own line (`security.passkey_policy`). **Settings → Security status** shows
passkey adoption (accounts with one, sign-ins and confirmations in 30 days, flagged passkeys, the relying party).

## Not covered, or deferred

- **SUDS on this device** (local mode, the GitHub Pages build): **deferred.** Unlocking a device's encrypted vault with
  a passkey needs the WebAuthn PRF extension (a key derived on the authenticator, to wrap the vault key beside the
  password and recovery-code wraps), which is not yet available on every platform staff use, and a wrong design there
  loses records. Until then no fingerprint is offered on a device: the browser kernel is **built without** the
  WebAuthn code (`scripts/kernel-build-options.js` puts `local/shims/passkeys.js`, which refuses everything as not
  available, in place of `server/passkeys.js`, `server/webauthn.js` and the passkey routes, and no passkey route is
  mounted: `LOCAL_ROUTE_MODULES`), the policy reads "off" there, and the browser code never shows the buttons
  (`state.local`).
- **Break-glass access** (opening a clinical note outside one's role) asks for a written reason, not the password,
  and is unchanged; the reason and the event go to the supervision queue as before.
- **Addenda** are attributed and audited but not electronically signed, before and after this change.
- **Changing the password** and **turning two-step verification off** still take the password (and the code): a
  fingerprint does not replace them.
- **Knowing it was a finger** (not the device PIN): not possible with WebAuthn (above).
- **Attestation and an allow-list of authenticator models**: not done (above); the option is described there.

## Review of the fingerprint work (before 1.19.0)

The review's findings and what changed, with the owner's decisions (D1–D4); each is tested in
`test/fingerprint-review.test.js` (and the UX ones in `scripts/ui/fingerprint.mjs`):

- **D1** `WEBAUTHN_RP_ID` (or `WEBAUTHN_ORIGINS`) required in production; red on Security status; `X-Forwarded-Host`
  never sets the RP ID. **D2** under "Require fingerprint or authenticator for signing", a note pushed as signed lands
  as a draft, flagged and audited. **D3** fingerprint evidence bound to the note's plaintext content hash
  (`server/note-signature.js`, one helper for the sign route, Verify, sync push and the passkey binding); the
  ciphertext signature hash kept and recomputed by key rotation. **D4** a passkey keeps counting as two-step
  verification; no AAGUID allow-list (an option, above).
- A code sent with a password must verify (finding 1); weak RSA and malformed EC or Ed25519 keys refused (3); the
  enrolment audit entry anchors the key, and evidence checks the statement's RP ID, an https origin and no embedding
  (5); resets remove passkeys and revocation ends their sessions (6); discoverable-only sign-in options (7); challenge
  caps and sweeps, `topOrigin`, `BS` without `BE`, `AT` in an assertion, duplicate byte-string keys, UTF-8, tags,
  Ed25519 as `-19` (8); outside test vectors (9); the stored challenge compared (10); the MFA banner follows the policy
  (11); order-independent tests and a real key rotation in them (12); one migration helper and the challenge's user as
  a user reference (13); the documents and a test that keeps the browser suite's count true (14; the suite is 54
  scripts with `fingerprint.mjs`, as RELEASE.md says — the review's count of 55 included the `assert.mjs` helper).

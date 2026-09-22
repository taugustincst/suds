# Native mobile apps

The SUDS phone app is a **complete copy of SUDS that runs on the phone**. Nothing needs to be installed on, or running at, the office for a navigator to install the app and start working. When the navigator chooses **Sync**, the phone and the office SUDS exchange changes in both directions.

| | Android | iPhone / iPad |
| --- | --- | --- |
| Get it | `SUDS-android.apk` from the GitHub Release (or `https://suds.local/app` on an office SUDS) | `mobile/ios` via TestFlight (Apple requires a Mac + developer account) |
| Runs without a server | yes | yes |
| Sync | in-app **Sync** screen (sidebar badge "On this device · Sync") | same |

## How it works
- The APK bundles the web app (`public/`) plus a **local kernel** (`public/local/kernel.js`): the same server code that runs on the office computer, compiled for the browser with SQLite in WebAssembly and pure-JavaScript encryption. Data is stored encrypted in the app's private storage (keys generated on the device and held in the Android Keystore-backed store or the iOS Keychain — see *Security notes*); the app asks for fingerprint / PIN when reopened.
- First launch: create a local account (use your office username if you have one). Work normally: clients, visits, calls, notes, reminders — everything.
- **Sync**: enter the office address (found automatically on the office Wi-Fi, or scan the QR code from Settings → Network & devices, or type the address IT gave you), your office username and password. The app downloads what changed at the office since the last sync and uploads what changed on the phone. The newest change to any record wins; deletions are honoured on both sides; the device's audit trail is appended to the office audit log.
- The first sync merges your local account into your office account (same username). From then on the office password is used on the phone as well.
- Clients created on the phone get codes like `M26-0012` (office codes start with `C`), so codes never collide.
- **Sample data**: a phone with no clients yet offers **Load sample data** on the home screen and the Sync screen (fictional clients, visits, notes, referrals, funding). It is removed automatically before the first sync, so it never reaches the office.

## What syncs
Clients, care-team assignments, visits & services, calls, time entries, referrals, resources, reminders/tasks, funding sources, budget lines, expenditures, notes and addenda, consents and disclosures, program settings. Only records the office account may see (its caseload, unless a supervisor) are downloaded; uploads outside the caseload are rejected and reported.

## Android — the signing key (do this once)

Android identifies an app by the key its APK is signed with. An update signed with a different key does
not install over the existing one: staff would have to uninstall SUDS first, losing anything on the device
that has not synced. So the county needs **one** release key, created once and kept forever.

```bash
scripts/android-keystore.sh            # writes ./android-signing/suds-release.jks
```

Run it on a computer the county controls — not in CI, not in a throwaway environment. It generates an
RSA-4096 key valid for 10,000 days, checks that the keystore opens with the password it just set, and
prints the four values to add under **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | What it is |
| --- | --- |
| `SUDS_KEYSTORE_BASE64` | the keystore file, base64 on one line (the script writes it to a file for copying) |
| `SUDS_KEYSTORE_PASSWORD` | the store password it generated |
| `SUDS_KEY_ALIAS` | `suds` |
| `SUDS_KEY_PASSWORD` | the key password (the same one by default) |

Then **Actions → Android app → Run workflow**, and the signed `SUDS-android.apk` is attached to the
release for the version in `package.json`.

Afterwards: put the keystore and both passwords in the county password manager, keep a second copy off
that computer, and delete the base64 file. Until these secrets exist the workflow deliberately builds an
unsigned **debug** APK and does not publish it — a release signed with the runner's throwaway key would
get a different signature every build, which is the failure this key exists to prevent.

To build a signed APK locally instead, export `SUDS_KEYSTORE` (path), `SUDS_KEYSTORE_PASSWORD`,
`SUDS_KEY_ALIAS` and `SUDS_KEY_PASSWORD`, then `cd mobile/android && ./gradlew assembleRelease`.

## Android — building
Open `mobile/android` in Android Studio → Build → Build APK(s). The bundled web app is taken from the repository's `public/` folder, which already contains the prebuilt kernel. GitHub Actions rebuilds the kernel (`npm run build:local`) and publishes the APK on every release.

## iOS
`mobile/ios/README.md`. The app bundles the same `public/` folder and runs identically; distribution is through TestFlight.

## Trying local mode in a browser
Open `https://<your-suds>/?local=1`. The page runs the whole app locally in that browser profile (data stays there) and can sync with the same server.

**For testing and demonstrations only — do not put real client information in it.** A plain browser has no Keystore or Keychain, so the local kernel generates its encryption keys on first run and keeps them in that profile's `localStorage`, next to the encrypted database in IndexedDB. Anyone who can reach the browser profile — another user of a shared computer, anything with access to the profile folder, a backup of it — has both the data and the key that opens it. The native Android and iOS apps are the supported way to hold client information on a device; use sample data (**Load sample data**) in browser local mode.

## Security notes
- Data at rest on the device is AES-256-GCM encrypted. Where the keys live depends on how SUDS is running, and it matters:
  - **Android app** — Android Keystore-backed encrypted store (`SudsNative.getSecret`).
  - **iPhone / iPad app** — iOS Keychain, injected into the page at launch.
  - **Plain browser (`/?local=1`)** — `localStorage` in that browser profile, which is *not* protected storage. Testing only; see above.

  Use MDM to require a device passcode and allow a full remote wipe of the device itself — SUDS has no visibility into or control over the OS below its own storage.
- Sync uses HTTPS to the office server (self-signed certificate trusted once by fingerprint). Credentials are never stored on the phone; a short-lived session is used for each sync.
- "Erase data on this device" on the Sync screen removes the local database. An administrator can also trigger this remotely — see below.
- **Lost or stolen device**: Administration → Users → Synced devices (office server) lists every phone/tablet that has ever synced, by the account it last synced as. **Revoke** blocks that device from syncing again until an administrator clears it — nothing on the device is touched, so a device found again a day later just needs clearing. **Wipe** additionally tells the device to erase its local SUDS database the next time it tries to sync, and revokes it in the same moment. Neither can reach a device that is never opened again with network access, or that never attempts to sync — that is a limit of working offline, not a bug: for a device that may never come back, MDM's OS-level remote wipe (above) is the real backstop, and this is what to do first while deciding on that.
- **Offboarding, in any order.** A pending wipe or revocation is answered *before* the username and password are looked at (`server/auth.js` `login()`): a device the server knows gets the wipe instruction whether the account has since been deactivated, the password has been reset, or the phone is offering a wrong password. Deactivating an account, and an administrator resetting its password, both queue a wipe for every device that account syncs from (audited as `device.wipe.requested`, reason `deactivated` or `password_reset`; devices already revoked are left alone), so "deactivate first, think about the phone later" no longer leaves a phone full of records with no way to reach it. The response says nothing about the account — a known device gets the same answer whatever it sends.
- **What consumes a pending wipe.** Answering the instruction does not: anyone who learned a device id could otherwise make the server believe the phone had erased itself, and the wipe would be gone. The device stays "wipe pending" (and keeps being told to wipe on every attempt) until one of two things happens: the credentials sent from that device verify (any account that signs in on it, including a deactivated account with its correct password — proof the phone is in the hands of someone who can unlock it), or the device posts `POST /api/devices/wipe-ack` with `{ device_id, token }`, where `token` is the one-time `wipeAckToken` the `deviceWipeRequired` response carried (hashed on the server, valid 15 minutes, superseded by the next delivery). Either marks the device wiped: revoked, with the wipe request kept on the row, so a revoked device that reappears is answered `deviceRevoked` with `wipeRequested: true` and `deviceWipeRequired: true` in case the erase never finished. The sync client wipes on `deviceWipeRequired` as before and should then call `wipe-ack` best-effort; a bad or expired token is refused with 403 and audited (`device.wipe.ack.rejected`).
- **Password resets and wipes.** `PUT /api/users/:id` with a new `password` or `is_active: false` queues a wipe for every device that account syncs from unless `wipe_devices: false` is sent; the administration form shows the checkbox ("Also wipe this person's synced devices"), checked by default, with the number of devices it will reach.

## What is on the device
The device-data inventory, for the county's data map — everything below is in the on-device encrypted database once a sync has run:
- Every table in *What syncs* above, scoped to the account: clients on the caseload (all clients for a supervisor), their visits, calls, notes, referrals, consents, tasks, funding and budget rows, the resource directory, programme settings.
- **The whole `users` table** — every staff account's id, username, display name, title, role, active flag and supervisor, not only the syncing person's. The device needs them to name who did what on records it holds. Every *other* user's password hash is blanked before it leaves the office (`scrypt$0$…`, unusable); only the syncing account's own hash is sent, so the person can sign in to the phone offline. Treat the list as staff directory data: it is not PHI, but it is a roster of county employees on every synced phone.
- The device's own audit trail (uploaded to the office at each sync), the sync cursor, its stable device id and the office server address.
- Credentials are never stored: the sync session is created and destroyed within a single run.

**The `/app` download page and `/api/app/info`**: the office addresses, certificate fingerprint and whether an APK is hosted are shown only to a signed-in browser, unless the server runs with `PUBLIC_APP_INFO=1`. A phone that opens `/app` without signing in first sees the programme name and a prompt to sign in. The APK and CA certificate downloads themselves are unchanged.

## What the phone copy is built from
The office server runs on Node's built-ins alone. The browser kernel cannot: a browser has no `node:sqlite`, no `node:crypto` and no `node:zlib`. So `npm run build:local` compiles `server/` together with a small, pinned set of vendored libraries into `public/local/kernel.js`, and that bundle is what the apps ship:

| Library | Stands in for | Used for |
| --- | --- | --- |
| `sql.js` (+ `sql-wasm.wasm`) | `node:sqlite` | the database, in WebAssembly, persisted to IndexedDB |
| `@noble/ciphers`, `@noble/hashes` | `node:crypto` | AES-256-GCM, HMAC, SHA-256, scrypt |
| `fflate` | `node:zlib` | ZIP for Excel import/export |
| `buffer` (+ `base64-js`, `ieee754`) | `node:buffer` | `Buffer` in the browser |

They are development dependencies of this repository (`package.json`), not of the office server: installing and running SUDS on the office computer still pulls nothing at runtime. But they *are* code that runs on a navigator's phone, so treat them as part of the review surface — they are pinned, vendored into a committed bundle, and CI fails if the committed kernel drifts from the source it was built from.

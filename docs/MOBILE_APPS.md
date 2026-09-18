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

  Use MDM to require a device passcode and allow remote wipe.
- Sync uses HTTPS to the office server (self-signed certificate trusted once by fingerprint). Credentials are never stored on the phone; a short-lived session is used for each sync.
- "Erase data on this device" on the Sync screen removes the local database.

## What the phone copy is built from
The office server runs on Node's built-ins alone. The browser kernel cannot: a browser has no `node:sqlite`, no `node:crypto` and no `node:zlib`. So `npm run build:local` compiles `server/` together with a small, pinned set of vendored libraries into `public/local/kernel.js`, and that bundle is what the apps ship:

| Library | Stands in for | Used for |
| --- | --- | --- |
| `sql.js` (+ `sql-wasm.wasm`) | `node:sqlite` | the database, in WebAssembly, persisted to IndexedDB |
| `@noble/ciphers`, `@noble/hashes` | `node:crypto` | AES-256-GCM, HMAC, SHA-256, scrypt |
| `fflate` | `node:zlib` | ZIP for Excel import/export |
| `buffer` (+ `base64-js`, `ieee754`) | `node:buffer` | `Buffer` in the browser |

They are development dependencies of this repository (`package.json`), not of the office server: installing and running SUDS on the office computer still pulls nothing at runtime. But they *are* code that runs on a navigator's phone, so treat them as part of the review surface — they are pinned, vendored into a committed bundle, and CI fails if the committed kernel drifts from the source it was built from.

# Native mobile apps

The SUDS phone app is a **complete copy of SUDS that runs on the phone**. Nothing needs to be installed on, or running at, the office for a navigator to install the app and start working. When the navigator chooses **Sync**, the phone and the office SUDS exchange changes in both directions.

| | Android | iPhone / iPad |
| --- | --- | --- |
| Get it | `SUDS-android.apk` from the GitHub Release (or `https://suds.local/app` on an office SUDS) | `mobile/ios` via TestFlight (Apple requires a Mac + developer account) |
| Runs without a server | yes | yes |
| Sync | in-app **Sync** screen (sidebar badge "On this device · Sync") | same |

## How it works
- The APK bundles the web app (`public/`) plus a **local kernel** (`public/local/kernel.js`): the same server code that runs on the office computer, compiled for the browser with SQLite in WebAssembly and pure-JavaScript encryption. Data is stored encrypted in the app's private storage (keys generated on the device); the app asks for fingerprint / PIN when reopened.
- First launch: create a local account (use your office username if you have one). Work normally: clients, visits, calls, notes, reminders — everything.
- **Sync**: enter the office address (found automatically on the office Wi-Fi, or scan the QR code from Settings → Network & devices, or type the address IT gave you), your office username and password. The app downloads what changed at the office since the last sync and uploads what changed on the phone. The newest change to any record wins; deletions are honoured on both sides; the device's audit trail is appended to the office audit log.
- The first sync merges your local account into your office account (same username). From then on the office password is used on the phone as well.
- Clients created on the phone get codes like `M26-0012` (office codes start with `C`), so codes never collide.

## What syncs
Clients, care-team assignments, visits & services, calls, time entries, referrals, resources, reminders/tasks, funding sources, budget lines, expenditures, notes and addenda, consents and disclosures, program settings. Only records the office account may see (its caseload, unless a supervisor) are downloaded; uploads outside the caseload are rejected and reported.

## Android — building
Open `mobile/android` in Android Studio → Build → Build APK(s). The bundled web app is taken from the repository's `public/` folder, which already contains the prebuilt kernel. GitHub Actions rebuilds the kernel (`npm run build:local`) and publishes the APK on every release.

## iOS
`mobile/ios/README.md`. The app bundles the same `public/` folder and runs identically; distribution is through TestFlight.

## Trying local mode in a browser
Open `https://<your-suds>/?local=1`. The page runs the whole app locally in that browser profile (data stays there) and can sync with the same server — useful for testing.

## Security notes
- Data at rest on the device is AES-256-GCM encrypted with keys held in the app's private storage; Android app sandboxing and device encryption protect the keys. Use MDM to require a device passcode and allow remote wipe.
- Sync uses HTTPS to the office server (self-signed certificate trusted once by fingerprint). Credentials are never stored on the phone; a short-lived session is used for each sync.
- "Erase data on this device" on the Sync screen removes the local database.

# Web-first platform and data integrity policy

**Effective from SUDS 1.9.0; updated for the on-device web app in 1.9.5.** Direction from the product owner:
SUDS is managed and documented against the web version, to maintain data integrity. The native phone apps
and the desktop launchers were deprecated in 1.9.0 and **removed in 1.9.3**. From 1.9.5 the GitHub Pages
build is no longer a demonstration: it is **SUDS on this device**, a production way to run SUDS.

## Two ways to run SUDS

Both are the same web application, and both are production:

| | **Office server** | **SUDS on this device** (GitHub Pages) |
| --- | --- | --- |
| For | A programme whose staff share records | A person (or a few people sharing one device) with no office server |
| System of record | The office server's database | That browser on that device (`WEB_APP.md`, *Where your records live*) |
| Accounts | **Sign up** requests an account; an administrator approves it with a role (or creates it) | **Sign up** creates an account on the device; the first one manages it |
| Protection against loss | Scheduled server backups | Device backups the person downloads, with a reminder on Home |
| Sync between devices | Every device sees the same server | None; records never leave the device |

A record lives in exactly one of the two. There is no sync between an on-device copy and an office server,
so the "which copy is right?" question below never arises between them. A programme that starts on the
on-device app and later installs an office server re-enters (or imports, `IMPORTS.md`) its records there.

## The policy

1. **On an office server, the web application it serves is the only supported client and the system of
   record.** Every client record, note, consent, disclosure and audit entry lives in the office server's
   database. Staff use SUDS in a browser at the office address, on a computer, phone or tablet, and may add
   it to the home screen (see `/app` on any SUDS server, or *Using SUDS on a phone or tablet* below).
2. **All changes are made, managed and documented against the web application.** Features, fixes, tests,
   release notes and user documentation describe the web app served by the office server. Nothing is
   built, tested or documented for a native app or a launcher any more.
3. **The native Android and iOS apps and the desktop launchers were deprecated in 1.9.0 and removed in
   1.9.3** (roadmap below). `mobile/`, `launchers/`, their workflows and `scripts/android-keystore.sh` are
   gone from the tree; the code stays in git history (any tag up to `v1.9.2`), so the decision is
   reversible. Nothing builds, ships or advertises them: the release workflow attaches only the server zip,
   the office server does not host or serve an APK, and the Settings page offers no upload. (Earlier
   editions of this page said the directories were deleted in 1.9.0; they were not, until 1.9.3.)
4. **Browser "local mode" remains** as the web app's offline capability, under the rules in the next
   section. It is the same code the web app runs, held in a browser profile, and it syncs with the office
   server on command. **From 1.9.3 it is off by default** on the office server: the setup wizard asks
   *Allow staff to keep an offline copy on their devices? (Recommended: No)* and stores the answer in
   `data/server.json`; `LOCAL_MODE_ENABLED` overrides it either way.
5. **The GitHub Pages build is SUDS on this device** (`docs/WEB_APP.md`), the production web app for people
   without an office server. Its records live only in the browser that holds them, encrypted, and are
   protected by the device backups its users download; the first-run Sign up states this once and asks the
   person to confirm it. It never syncs with an office server: its **This device** page says so and sends
   nothing. (`ALLOW_STATIC_SYNC` is a no-op kept for compatibility.) It is always local (it has no server
   whose setting could apply), and it is republished only when a release is cut, never from an unreleased
   push to `main`. Until 1.9.4 it was a demonstration with a permanent banner; the banner is gone.

## Retiring an existing phone-app install

Each phone or tablet that has the former Android or iOS app installed should be retired as follows. The
navigator does steps 1–3; the administrator does 4–5.

1. **Sync one final time.** Open the app, go to *Sync with the office*, connect to the office Wi-Fi (or
   the address IT gave you), sign in with the office account and wait for the sync to report success with
   no changes waiting to send. If a change is rejected, note the reason: a permanent rejection is the office
   server's final ruling on that row (see *Rules* below) and is not a reason to keep the app.
2. **Erase the local copy.** On the same Sync screen choose **Erase data on this device**, which removes
   the app's encrypted database.
3. **Uninstall the app.** Android: hold the SUDS icon → *Uninstall*. iPhone/iPad: hold the icon → *Remove
   App* → *Delete App*. Then open the office address in the browser and add SUDS to the home screen instead.
4. **Administrator: revoke (or wipe) the device.** Settings → *Synced devices* lists every device that has
   ever synced. Choose **Revoke** for the retired device so that it can never sync again even if the app is
   reinstalled from a backup. If the device did not complete steps 1–2 (lost, broken, or the person has
   left), choose **Wipe** instead: the next time that device tries to sync it is told to erase itself and is
   revoked in the same moment. Deactivating the person's account, or resetting their password, queues a
   wipe for all their devices automatically. Neither can reach a device that never connects again; for
   that, use the county MDM's remote wipe of the whole device.
5. **Administrator: confirm.** When the row shows *revoked* (and *wiped* where a wipe was requested), record
   the device as retired in the county's device inventory. If the county deployed the CA certificate to
   phones only for the app's sake, it can stay: the browser uses it too.

## Rules for local mode (the offline copy)

Local mode is opened at `https://<office-suds>/?local=1`, or from the home-screen shortcut a browser makes
of that page. It runs the whole SUDS server inside the browser (SQLite in WebAssembly, encryption in
JavaScript) and stores an encrypted copy of the person's caseload in that browser profile. It is governed
by these rules, all of which the server enforces:

| Rule | What it means |
| --- | --- |
| **The office server is authoritative.** | Sync sends the device's changes to the office and applies what the office answers. Where both changed the same record, the newest change wins on the office's clock; approvals, signatures, countersignatures and other people's records are never taken from a device. |
| **Permanent sync rejections are final.** | When the office refuses a pushed row for a reason that cannot change — outside the caseload, no permission, immutable legal record, purged parent — it marks the rejection `permanent` and the device stops resending it. The row is not lost silently: the Sync screen lists it. Re-entering it on the device does not overrule the office. |
| **Purged and merged records cannot be resurrected.** | A client the retention job has purged, or a record merged into another, stays that way. A device that still holds the old row has it rejected (`purged`, `merged into another record`) and receives the tombstone. Nothing a device holds brings back a record the office has disposed of. |
| **A restored office database is re-synced to.** | Every restore from a backup (`server/backup.js`) starts a new `db_generation`, which every pull reports. A device that sees it change forgets what it believed was exchanged and offers every record it holds again (the office still keeps whichever copy is newer), so work synced after the backup was taken is not silently lost. The Sync screen says *The office database was restored from a backup; re-sending this device's records*. |
| **Per-user cursors.** | Each office account has its own sync position on a device (`sync_cursor:<user>`). A device used by two people does not let one person's position stand in for the other's, and a device that has been away longer than tombstones are kept is told to re-download rather than guess. |
| **Minimum necessary applies on the device.** | Only the syncing account's caseload (all clients for a supervisor) is downloaded; clinical notes only for clinical roles; nobody else's credentials. What is on a device is listed below. |
| **Devices are tracked.** | Every local-mode browser that syncs registers a device id. Settings → Synced devices shows them; an administrator can revoke or wipe any of them, and deactivating an account wipes its devices. |

**Recommendation for counties.** Leave local mode off — the default from 1.9.3, and the wizard's
recommended answer — unless there is a documented field-work need (navigators who record visits where
there is no signal). A plain browser has no protected key store:
the offline copy's encryption keys live in the browser profile beside the data, so anyone who can use that
profile can read it. Where the need exists, restrict local mode to county-managed devices with a device
passcode, disk encryption and MDM remote wipe, record which devices are approved, and review Synced devices
when someone leaves. With local mode off, the server serves a plain explanation at `/?local=1` and nothing
else, and the `/app` page does not mention it.

## What is on a device

The device-data inventory for the county's data map. Everything below is in the on-device encrypted
database once a sync has run:

- Every synchronised table, scoped to the account: clients on the caseload (all clients for a supervisor),
  their visits, calls, notes, referrals, consents, tasks, funding and budget rows, the resource directory,
  programme settings.
- **The whole `users` table** — every staff account's id, username, display name, title, role, active flag
  and supervisor, not only the syncing person's. The device needs them to name who did what on records it
  holds. Every *other* user's password hash is blanked before it leaves the office (`scrypt$0$…`, unusable);
  only the syncing account's own hash is sent, so the person can sign in offline. Treat the list as staff
  directory data: not PHI, but a roster of county employees on every synced device.
- The device's own audit trail (uploaded to the office at each sync), the sync cursor per user, its stable
  device id and the office server address.
- Credentials are never stored: the sync session is created and destroyed within a single run.

## Lost or stolen devices, and offboarding

- **Revoke** (Settings → Synced devices) blocks that device from syncing again until an administrator clears
  it — nothing on the device is touched, so a device found a day later just needs clearing.
- **Wipe** additionally tells the device to erase its local SUDS database the next time it tries to sync,
  and revokes it in the same moment. On the device the erase drops the database from IndexedDB, the copy in
  memory (so nothing can write it back before the page reloads), the sign-in token and the encryption keys
  from the browser profile; the device id lives inside the database and goes with it, and the
  acknowledgement (`wipe-ack`) is sent with the id captured before the erase. Neither can reach a device
  that is never opened again with network access; MDM's OS-level remote wipe is the backstop.
- **Offboarding, in any order.** A pending wipe or revocation is answered *before* the username and
  password are looked at (`server/auth.js` `login()`): a device the server knows gets the wipe instruction
  whether the account has since been deactivated, the password has been reset, or the device is offering a
  wrong password. Deactivating an account, and an administrator resetting its password, both queue a wipe
  for every device that account syncs from (audited as `device.wipe.requested`, reason `deactivated` or
  `password_reset`; devices already revoked are left alone). The response says nothing about the account.
- **What consumes a pending wipe.** Answering the instruction does not: anyone who learned a device id could
  otherwise make the server believe the device had erased itself. The device stays "wipe pending" until the
  credentials sent from it verify (proof it is in the hands of someone who can unlock the account), or it
  posts `POST /api/devices/wipe-ack` with `{ device_id, token }`, where `token` is the one-time
  `wipeAckToken` the `deviceWipeRequired` response carried (hashed on the server, valid 15 minutes). Either
  marks the device wiped: revoked, with the wipe request kept on the row. A bad or expired token is refused
  with 403 and audited (`device.wipe.ack.rejected`).
- **Password resets and wipes.** `PUT /api/users/:id` with a new `password` or `is_active: false` queues a
  wipe for every device that account syncs from unless `wipe_devices: false` is sent; the administration
  form shows the checkbox, checked by default, with the number of devices it will reach.

## Using SUDS on a phone or tablet

Nothing to install. On the office Wi-Fi open the office address (normally `https://suds.local`, or the
numeric address under Settings → Network & devices — Android browsers do not resolve `suds.local`), sign in,
then add it to the home screen: iPhone/iPad — Safari **Share → Add to Home Screen**; Android and desktop
Chrome/Edge — browser menu → **Install app**. SUDS needs a connection to the office server; the page says
so when it is offline. The `/app` page on every server carries these steps and the server's certificate.

## What changed and why

Until 1.7 SUDS shipped three ways to run it: the office server's web app, a native Android app (with an
iOS project) that bundled a complete copy of SUDS, and double-click launchers for a single workstation.
Three runtimes meant three places a record could be created, three sets of encryption keys, three things
to test and document, and — the reason for this policy — three places for the same record to drift apart.
A phone app with its own database is only as consistent as its last sync, and "which copy is right?" is
not a question a programme handling Part 2 records should have to ask.

From 1.9.0 there is one system of record per programme. On an office server, the web application it serves is where records live
and where every change is made; the browser's home-screen shortcut replaces the app icon; local mode
remains for genuine field work, under the rules above, and is off by default (from 1.9.3 in the server's
own configuration, not only in the guidance). The native apps and the launchers were deprecated in 1.9.0
and removed in 1.9.3, so that counties had releases to retire devices on before the code went.

## Removal roadmap

| What | Deprecated (1.9.0) | Removed |
| --- | --- | --- |
| Android app (`mobile/android`) | Not built on tags or releases; no APK attached to releases; no APK hosting or upload on the server | **Removed in 1.9.3**: directory, `mobile/DEPRECATED.md`, `scripts/android-keystore.sh` and `mobile-android.yml` deleted |
| iOS project (`mobile/ios`) | Workflow dispatch-only; nothing published | **Removed in 1.9.3** with `mobile-ios.yml` |
| Runner probe workflow (`probe.yml`) | Checked the runner's JDK/Gradle/Android SDK for the APK build | **Removed in 1.9.3** (served only the Android build) |
| Version stamping of `build.gradle.kts` / `Info.plist` | Removed from `scripts/gen-schema-text.js`, CI and tests | Removed in 1.9.0 |
| Desktop launchers (`launchers/`) | Documented as deprecated, evaluation-only; not in the install path | **Removed in 1.9.3**, with `scripts/print-url.js`, which only they used |
| Native key-store lookups in the kernel's config (`SudsNative.getSecret`, `__sudsSecrets`) | — | **Removed in 1.9.3** from `local/shims/config.js`. Detection branches that remain in `public/views/local.js` (`window.SudsNative` for discovery/QR scanning and the "protected keys" wording) are inert in a browser and go in a later release |
| `/app` page (`public/get-app.html`) | Repurposed: browser/home-screen instructions and certificate download, no APK | Stays |
| `GET /api/app/info` `android` field, `GET /api/app/android.apk`, `POST/DELETE /api/admin/app/android` | Removed | Removed in 1.9.0 |
| Browser local mode (`/?local=1`, `LOCAL_MODE_ENABLED`) | Stays, governed by this policy | Not planned. **Off by default from 1.9.3**; the setup wizard asks |
| GitHub Pages build (`web-app.yml`) | Stays. A demonstration until 1.9.4; **SUDS on this device, a production web app, from 1.9.5** | Not planned. Published on releases only from 1.9.3 |
| Device management (Synced devices, revoke, wipe) | Stays — local-mode browsers register devices | Not planned |

# SUDS for Android

The complete SUDS app runs **on the phone**: the web app and its server logic are bundled into the APK (SQLite in WebAssembly, data encrypted at rest on the device). Nothing needs to be running on the office computer to install or use it. When the user taps **Sync** in the app, changes are exchanged with the office SUDS in both directions (newest change wins).

Native pieces added by this wrapper: office-server discovery (DNS-SD `_suds._tcp`), one-time certificate trust by fingerprint, QR scan of the office address, device unlock (fingerprint/PIN) when reopening the app, saving/sharing exported files.

## Build (Android Studio, no command line)
1. Install Android Studio. File → Open → the `mobile/android` folder.
2. Build → Build Bundle(s) / APK(s) → **Build APK(s)**. The bundled web app comes from the repository's `public/` folder, which already contains the prebuilt local kernel (`public/local/`).

GitHub Actions (`.github/workflows/mobile-android.yml`) builds and publishes the APK on every release (it rebuilds the kernel first with `npm run build:local`).

## Distribute
Download the APK from the GitHub Release (or from Settings → Network & devices → Native apps on an office SUDS, which serves it at `https://suds.local/app`). Open the file on the phone and allow the install.

## Signing for production
Set `SUDS_KEYSTORE`, `SUDS_KEYSTORE_PASSWORD`, `SUDS_KEY_ALIAS`, `SUDS_KEY_PASSWORD` (or the `SUDS_KEYSTORE_BASE64` secret in CI). Updates must always be signed with the same key.

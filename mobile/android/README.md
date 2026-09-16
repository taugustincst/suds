# SUDS for Android

Native Android app that hosts the SUDS web app served by your SUDS server, so it is always the same version as the computer and needs no configuration: it finds the server on the office Wi-Fi by itself (DNS-SD `_suds._tcp`, then `https://suds.local`, then QR scan or typed address).

Extra native features: one-time certificate trust by fingerprint, device unlock (fingerprint/PIN) when reopening the app, file downloads, back navigation, swipe to refresh.

## Build (one click, no command line)
1. Install Android Studio (https://developer.android.com/studio).
2. File → Open → choose the `mobile/android` folder. Let it sync (it downloads what it needs).
3. Build → Build Bundle(s) / APK(s) → **Build APK(s)**. Click *locate* when it finishes: `app/build/outputs/apk/release/app-release.apk` (or debug).

GitHub Actions also builds the APK on every release once Actions is enabled for the repository (`.github/workflows/mobile-android.yml`).

## Distribute
In SUDS: Settings → Network & devices → **Native apps** → upload the APK. Staff then open **https://suds.local/app** on their phone and tap *Download SUDS for Android*. No Play Store account is needed (Android asks once to allow installs from this source). For managed county phones, IT can push the same APK with their MDM.

## Signing for production
Create a keystore once (Android Studio: Build → Generate Signed Bundle / APK) and set `SUDS_KEYSTORE`, `SUDS_KEYSTORE_PASSWORD`, `SUDS_KEY_ALIAS`, `SUDS_KEY_PASSWORD` as environment variables (locally) or repository secrets (CI). Unsigned/debug-signed builds install fine for testing; updates must always be signed with the same key.

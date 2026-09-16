# Native mobile apps

SUDS runs on phones in two ways. Both show exactly the same app as the computer and stay in sync automatically because every device talks to the same SUDS server.

| | Android | iPhone / iPad |
| --- | --- | --- |
| **No-install option** | open `https://suds.local` in Chrome → ⋮ → *Install app* | open `https://suds.local` in Safari → Share → *Add to Home Screen* |
| **Native app** | `mobile/android` — APK downloaded from your own server at **https://suds.local/app** | `mobile/ios` — distributed with TestFlight (needs an Apple Developer account and a Mac) |

The native apps add: automatic server discovery (Bonjour / DNS-SD `_suds._tcp`, advertised by the server), one-time certificate trust by fingerprint so there is no browser warning, device unlock (fingerprint / Face ID / PIN) when reopening the app, file downloads, and an app icon in the launcher. No third-party services and no app-store accounts are involved for Android.

## Android — getting the APK
Choose one:

1. **GitHub Actions (automatic).** Once Actions is enabled for the repository, every version tag (and *Run workflow* on the "Android app" workflow) builds `SUDS-android.apk` and attaches it to the release / workflow artifacts.
2. **Android Studio (one click).** Open the `mobile/android` folder → Build → *Build APK(s)*. Details in `mobile/android/README.md`.

Then, in SUDS, go to **Settings → Network & devices → Native apps** and upload the APK. Staff open **https://suds.local/app** on their phone, tap *Download SUDS for Android*, open the file, and allow the install when Android asks. The app then finds the server by itself.

Signing: for production, sign with a keystore you keep (see `mobile/android/README.md`); updates must use the same key.

## iOS
See `mobile/ios/README.md`. Apple does not allow installing apps outside the App Store / TestFlight / MDM, so the realistic paths are TestFlight ($99/yr developer program) or the Add-to-Home-Screen option, which is free and works today.

## How the apps find the server
The SUDS server answers multicast DNS for `suds.local` and advertises the service `_suds._tcp` with its port and whether TLS is on. The apps:
1. browse for `_suds._tcp` (NsdManager on Android, NWBrowser on iOS);
2. if nothing answers within a few seconds, try `https://suds.local`;
3. otherwise ask the user to scan the QR code (Android) or type the address shown under Settings → Network & devices.

The chosen address and the certificate fingerprint are stored on the device; *Forget server* in the certificate-changed dialog resets them.

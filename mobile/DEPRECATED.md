# Native apps — deprecated

The Android app (`android/`) and the iOS project (`ios/`) in this directory are **deprecated as of SUDS
1.9.0** and will be removed in a later release. See [`docs/PLATFORM.md`](../docs/PLATFORM.md): the web
application served by the office SUDS server is the only supported client and the system of record.

What this means today:

- Nothing builds them on a tag or a release. `.github/workflows/mobile-android.yml` and `mobile-ios.yml`
  can still be started by hand from the Actions tab, for evaluation only; the Android workflow attaches
  nothing to a release unless explicitly asked.
- The office server no longer hosts, serves or accepts an APK (`/api/app/android.apk` and
  `/api/admin/app/android` are gone), and the Settings page no longer offers an upload.
- `scripts/gen-schema-text.js` no longer stamps the version into `build.gradle.kts` or `Info.plist`; those
  files are left at whatever the last stamped release wrote, and CI no longer checks them.
- No documentation describes installing or using them. `docs/MOBILE_APPS.md` is a pointer.

Existing installs should sync one final time, erase their local copy and be uninstalled; the
administrator then revokes the device under Settings → Synced devices. The exact steps are in
`docs/PLATFORM.md` under *Retiring an existing phone-app install*.

The code stays in git so the decision is reversible. Do not add features here.

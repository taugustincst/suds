# SUDS for iPhone and iPad

Native iOS app (SwiftUI + WKWebView). The complete SUDS web app is bundled in the app (the repository's `public/` folder, including the prebuilt local kernel) and runs entirely on the device with its data encrypted at rest; no server is needed to use it. **Sync** in the app exchanges changes with the office SUDS when the user chooses. The wrapper adds Bonjour discovery of the office server, one-time certificate trust by fingerprint, Face ID / passcode when reopened, and the share sheet for exported files.

## What Apple requires
Building and installing iOS apps needs a Mac with Xcode and an Apple Developer account. There is no way around this; it is Apple's policy, not a SUDS limitation.

| Option | Cost | Who can install |
| --- | --- | --- |
| **Add to Home Screen** (no native app) | free | anyone, today — open `https://suds.local` in Safari → Share → Add to Home Screen |
| **TestFlight** | Apple Developer Program, $99/yr | up to 10,000 invited staff, no App Store review for internal testing |
| **Unlisted App Store / Apple Business Manager** | $99/yr | county-managed devices via MDM |

## Build
1. On a Mac, install Xcode from the App Store.
2. Open `mobile/ios/SUDS.xcodeproj`.
3. Select the *SUDS* target → Signing & Capabilities → choose your Team (bundle id `gov.county.suds`, change to your county's reverse domain).
4. Product → Archive → Distribute App → TestFlight (or Ad Hoc for a handful of devices).

Staff install TestFlight from the App Store, accept the invitation, and open SUDS: it finds the server by itself.

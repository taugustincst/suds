#!/bin/bash
# Creates the Android release signing key for SUDS and prints the four values GitHub Actions needs.
#
# Run this ONCE, on a computer the county controls, and keep what it produces forever. Android
# identifies an app by its signing key: an update signed with a different key will not install over the
# existing one, so staff would have to uninstall SUDS — losing anything on the device that has not synced.
# Losing this key means the same thing. Back it up in the county password manager, not only on this
# machine.
#
# Usage:  scripts/android-keystore.sh [output-directory]     (default: ./android-signing)
set -euo pipefail

OUT_DIR="${1:-android-signing}"
KEYSTORE="$OUT_DIR/suds-release.jks"
ALIAS="suds"
# Ten thousand days: Google Play requires a key valid past 2033, and a county app outlives its author.
VALID_DAYS=10000
DNAME="${SUDS_KEY_DNAME:-CN=SUDS, OU=SUD Navigation, O=County, L=, ST=, C=US}"

command -v keytool >/dev/null || { echo "keytool not found. Install a JDK (17 or newer): apt install default-jdk / brew install openjdk@17" >&2; exit 1; }

if [ -e "$KEYSTORE" ]; then
  echo "$KEYSTORE already exists." >&2
  echo "Refusing to overwrite it: a second key would lock every phone out of updates signed with the first." >&2
  echo "If you are certain this one was never used, move it aside first." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

# Passwords are generated here rather than typed, because this one is never entered by hand — it lives in
# the password manager and in the GitHub secret.
# Reads a fixed, finite amount first: piping /dev/urandom straight into `head` closes the pipe early,
# which under `set -o pipefail` kills the script with SIGPIPE rather than producing a password.
newpass() { LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 4096 /dev/urandom) | cut -c1-40; }
STORE_PASS="${SUDS_KEYSTORE_PASSWORD:-$(newpass)}"
KEY_PASS="${SUDS_KEY_PASSWORD:-$STORE_PASS}"

keytool -genkeypair \
  -keystore "$KEYSTORE" -storetype PKCS12 \
  -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity "$VALID_DAYS" \
  -dname "$DNAME" >/dev/null

chmod 600 "$KEYSTORE"
# Absolute, so the instructions below work from any directory (and when OUT_DIR was already absolute).
KEYSTORE_ABS="$(cd "$(dirname "$KEYSTORE")" && pwd)/$(basename "$KEYSTORE")"

# Prove it opens with the password we just set, before anyone relies on it.
keytool -list -keystore "$KEYSTORE" -storepass "$STORE_PASS" -alias "$ALIAS" >/dev/null
FINGERPRINT=$(keytool -list -v -keystore "$KEYSTORE" -storepass "$STORE_PASS" -alias "$ALIAS" | sed -n 's/.*SHA256: //p' | head -1)

# The workflow takes the keystore as base64 because a GitHub secret holds text, not files.
B64_FILE="$OUT_DIR/SUDS_KEYSTORE_BASE64.txt"
base64 -w0 < "$KEYSTORE" > "$B64_FILE" 2>/dev/null || base64 < "$KEYSTORE" | tr -d '\n' > "$B64_FILE"
chmod 600 "$B64_FILE"

# Round-trip check: what goes into the secret must come back out as the same keystore.
TMP_BACK="$(mktemp)"
base64 -d < "$B64_FILE" > "$TMP_BACK"
cmp -s "$KEYSTORE" "$TMP_BACK" || { rm -f "$TMP_BACK"; echo "base64 round-trip failed — do not use this output" >&2; exit 1; }
rm -f "$TMP_BACK"

cat <<EOF

Created $KEYSTORE
  alias        $ALIAS
  key          RSA 4096, valid $VALID_DAYS days
  SHA-256      $FINGERPRINT

Add these four repository secrets on GitHub — Settings → Secrets and variables → Actions → New
repository secret. The names must match exactly.

  SUDS_KEYSTORE_BASE64     the whole contents of $B64_FILE (one long line, no spaces)
  SUDS_KEYSTORE_PASSWORD   $STORE_PASS
  SUDS_KEY_ALIAS           $ALIAS
  SUDS_KEY_PASSWORD        $KEY_PASS

Then run the "Android app" workflow (Actions → Android app → Run workflow) and the signed
SUDS-android.apk is attached to the release for the version in package.json.

Before you close this window:
  1. Put $KEYSTORE_ABS and both passwords in the county password manager.
  2. Keep a second copy somewhere off this computer. There is no way to regenerate this key: without it,
     updating SUDS on a phone means uninstalling it first, and whatever is on that device and not yet
     synced is gone.
  3. Delete $B64_FILE once the secret is saved — it is the key itself, in text form.

To build a signed APK on this computer instead of in CI:
  export SUDS_KEYSTORE='$KEYSTORE_ABS' SUDS_KEYSTORE_PASSWORD='$STORE_PASS' SUDS_KEY_ALIAS='$ALIAS' SUDS_KEY_PASSWORD='$KEY_PASS'
  (cd mobile/android && ./gradlew assembleRelease)
EOF

'use strict';
// Generates server/schema-text.js from server/schema.sql. The browser kernel has no filesystem, so it needs
// the schema as a JS string; keeping that copy by hand is how it silently froze two versions behind.
// Run by `npm run build:local`; CI fails the build if the committed copy differs from this output.
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
const out = `'use strict';\n// GENERATED FILE — do not edit. Regenerate with: node scripts/gen-schema-text.js\n// Source: server/schema.sql\nmodule.exports = ${JSON.stringify(sql)};\n`;
const dest = path.join(__dirname, '..', 'server', 'schema-text.js');
const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
if (existing !== out) { fs.writeFileSync(dest, out); console.log('[suds] regenerated server/schema-text.js'); }
else console.log('[suds] server/schema-text.js already current');

// The version used to live in four hand-maintained places, so a release could easily ship with three of
// them bumped. Everything downstream of package.json is stamped from it here, and a test fails if any of
// them disagree.
const version = require('../package.json').version;
const stamp = (rel, pattern, replacement) => {
  const file = path.join(__dirname, '..', rel);
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(pattern, replacement);
  if (after !== before) { fs.writeFileSync(file, after); console.log(`[suds] stamped ${rel} with version ${version}`); }
};

// The service worker's cache name must change with every release, or phones keep serving the old shell
// against a new API.
stamp('public/sw.js', /(const VERSION = ')[^']*(')/, `$1suds-shell-${version}$2`);

// Android refuses to install an update whose versionCode did not increase; derive both from package.json.
const [maj, min, pat] = version.split('.').map(Number);
const versionCode = maj * 10000 + min * 100 + pat;
stamp('mobile/android/app/build.gradle.kts', /versionCode = \d+/, `versionCode = ${versionCode}`);
stamp('mobile/android/app/build.gradle.kts', /versionName = "[^"]*"/, `versionName = "${version}"`);
stamp('mobile/ios/SUDS/Info.plist', /(<key>CFBundleShortVersionString<\/key><string>)[^<]*(<\/string>)/, `$1${version}$2`);
stamp('mobile/ios/SUDS/Info.plist', /(<key>CFBundleVersion<\/key><string>)[^<]*(<\/string>)/, `$1${versionCode}$2`);

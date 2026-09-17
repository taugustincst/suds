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

// The service worker's cache name must change with every release or phones keep serving the old shell
// against a new API. It was a hand-edited literal; stamp it from package.json instead.
const swPath = path.join(__dirname, '..', 'public', 'sw.js');
if (fs.existsSync(swPath)) {
  const version = require('../package.json').version;
  const before = fs.readFileSync(swPath, 'utf8');
  const after = before.replace(/(const VERSION = ')[^']*(')/, `$1suds-shell-${version}$2`);
  if (after !== before) { fs.writeFileSync(swPath, after); console.log(`[suds] stamped public/sw.js with version ${version}`); }
}

'use strict';
// Generates public/county-periods.js (an ES module for the browser, which has no build step) from
// server/county-periods.js (CommonJS, the one copy, which the server requires). The body is the same code; only the
// module wrapper differs. Run by `npm run build:local`; test/county-periods.test.js fails if the committed copy
// differs from this output.
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'server', 'county-periods.js');
const DEST = path.join(__dirname, '..', 'public', 'county-periods.js');

/** The browser module's text for the CommonJS source's text. */
function generate(src) {
  const m = src.match(/\nmodule\.exports = \{ ([\w, ]+) \};\n$/);
  if (!m) throw new Error('server/county-periods.js must end with one line: module.exports = { name, … };');
  const body = src.slice(0, m.index + 1).replace(/^'use strict';\n/, '');
  if (/\brequire\(|\bmodule\.|\bexports\./.test(body)) throw new Error('server/county-periods.js must be pure: no require, module or exports in its body');
  return `// GENERATED FILE — do not edit. Regenerate with: node scripts/gen-county-periods.js (npm run build:local)\n// Source: server/county-periods.js\n${body}export { ${m[1]} };\n`;
}

/** Write public/county-periods.js when it differs from what the source makes. */
function run() {
  const out = generate(fs.readFileSync(SRC, 'utf8'));
  const existing = fs.existsSync(DEST) ? fs.readFileSync(DEST, 'utf8') : '';
  if (existing !== out) { fs.writeFileSync(DEST, out); console.log('[suds] regenerated public/county-periods.js'); }
  else console.log('[suds] public/county-periods.js already current');
}
if (require.main === module) run();
module.exports = { generate, run, SRC, DEST };

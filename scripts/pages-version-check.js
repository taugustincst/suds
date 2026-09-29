'use strict';
// The web app is never published over a newer one (1.17.1; engineering review of 1.17.0, H1). web-app.yml
// force-pushes the tag's build to gh-pages, and a device whose database a newer release has migrated cannot be
// opened by an older kernel (server/db.js refuses a schema newer than it knows), so publishing 1.16.4 over 1.17.0
// would lock every SUDS-on-this-device user out of their records. The newest-tag check in web-app.yml is not enough
// on its own: 1.17.0 was published by a direct push to gh-pages before it had a tag, so the tags alone said 1.16.4
// was the newest release. This compares the version being published with the version.json gh-pages serves now.
//
//   node scripts/pages-version-check.js <version being published> [<gh-pages version.json>]
//
// No second argument, or a file that does not exist: nothing is published yet (no gh-pages branch, or one from
// before version.json), so any version may go out. A file that exists but names no X.Y.Z version is refused (fail
// closed). The same version passes (a republish of the release that is live); an older one is refused. It loads only
// Node's own modules, so the publish job runs it from `git archive` of the tag, without npm.
const fs = require('node:fs');

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** < 0, 0 or > 0 as a is older than, the same as or newer than b (both X.Y.Z, a leading v allowed). */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`not an X.Y.Z version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
/**
 * Whether `version` may be published over what gh-pages serves. `published`: the text of gh-pages' version.json,
 * or null when there is none. Returns { ok, reason, live }.
 */
function check(version, published) {
  if (!parseVersion(version)) return { ok: false, reason: `the version being published (${version}) is not X.Y.Z`, live: null };
  if (published == null) return { ok: true, reason: 'gh-pages serves no version.json yet', live: null };
  let live = null;
  try { live = JSON.parse(published).version; } catch { live = null; }
  if (!parseVersion(live)) return { ok: false, reason: 'the version.json gh-pages serves names no X.Y.Z version; check gh-pages by hand before publishing over it', live: null };
  const c = compareVersions(version, live);
  if (c < 0) return { ok: false, reason: `gh-pages serves ${live}, newer than ${version}: publishing ${version} would take SUDS on this device back to older code, whose kernel refuses a database a newer release has migrated`, live };
  return { ok: true, reason: c === 0 ? `gh-pages serves ${live} already (a republish)` : `gh-pages serves ${live}, older than ${version}`, live };
}

if (require.main === module) {
  const [version, file] = process.argv.slice(2);
  const published = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const out = check(String(version || '').replace(/^v/, ''), published);
  console.log(out.ok ? `[pages-version] ${out.reason}` : `::error::The web app is not published: ${out.reason}.`);
  process.exitCode = out.ok ? 0 : 1;
}
module.exports = { parseVersion, compareVersions, check };

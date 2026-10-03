'use strict';
// The web app's publish job checks the site it is about to push against the tag it is published for
// (engineering review of 1.16.3, M2). web-app.yml's `build` job runs third-party code (npm ci, and Playwright with
// its apt packages), so what it hands over is only a claim. This rebuilds, from the tag's own public/, every file
// the static build copies or generates (scripts/build-static-site.js: public/ copied as it is, then stageShell()
// adds local-boot.js and frame-guard.js and rewrites the .html pages and sw.js), and requires the site to hold
// exactly those files with exactly those bytes. The only other files allowed are the provider pictures, which the
// build downloads from the providers' own sites and nothing can rebuild: region-pictures/<region>/ holding a
// manifest.json that parses and JPEG, PNG or WebP files that start as one (the same three types
// server/region-pictures.js keeps).
//
// It needs no npm package: this file, scripts/build-static-site.js (stageShell only), scripts/static-site-security.js
// and server/csp.js load only Node's own modules, so the publish job runs it from `git archive` of the tag with the
// runner's Node, without npm (test/release-site-check.test.js runs it that way). It is the tag's own code, as the
// workflow file running it is.
//
// From 1.24.1 the build also copies the tag's LICENSE and NOTICE (as LICENSE.txt and NOTICE.txt), so the tag tree
// holds them too.
//
//   node scripts/release-site-check.js <tag tree: a folder holding public/, scripts/, LICENSE and NOTICE> <site folder>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PICTURE = /^region-pictures\/[a-z0-9-]+\/(manifest\.json|[A-Za-z0-9_-]+\.(jpg|png|webp))$/;
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;

/** Every file under dir, as a Map of 'a/b.js' -> absolute path. Anything but a file or directory is refused. */
function listFiles(dir, base = dir, out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).split(path.sep).join('/');
    if (e.isDirectory()) listFiles(p, base, out);
    else if (e.isFile()) out.set(rel, p);
    else throw new Error(`${rel} is neither a file nor a directory`);
  }
  return out;
}

/** Whether bytes start as the picture type their name says. */
function pictureLooksRight(name, buf) {
  if (name.endsWith('.jpg')) return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (name.endsWith('.png')) return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (name.endsWith('.webp')) return buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  if (name.endsWith('manifest.json')) { try { JSON.parse(buf.toString('utf8')); return true; } catch { return false; } }
  return false;
}

/**
 * The differences between the expected site and the one handed over, as sentences. `expected` and `site` map a
 * relative path to its bytes (a Buffer), or to a function returning them.
 */
function compareSites(expected, site) {
  const bytes = (v) => (typeof v === 'function' ? v() : v);
  const problems = [];
  for (const [rel, want] of expected) {
    if (!site.has(rel)) { problems.push(`${rel} is missing`); continue; }
    if (!bytes(want).equals(bytes(site.get(rel)))) problems.push(`${rel} differs from the one built from the tag`);
  }
  for (const [rel, got] of site) {
    if (expected.has(rel)) continue;
    if (!PICTURE.test(rel)) { problems.push(`${rel} is not built from the tag and is not a provider picture`); continue; }
    const buf = bytes(got);
    if (buf.length > MAX_PICTURE_BYTES) problems.push(`${rel} is ${buf.length} bytes, over ${MAX_PICTURE_BYTES}`);
    else if (!pictureLooksRight(rel, buf)) problems.push(`${rel} is not the kind of file its name says`);
  }
  return problems;
}

/** The site scripts/build-static-site.js makes from tagRoot/public, pictures aside, in a temporary folder. */
function expectedSite(tagRoot) {
  const { stageShell, copyDir } = require(path.join(tagRoot, 'scripts', 'build-static-site.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-site-'));
  copyDir(path.join(tagRoot, 'public'), dir);
  stageShell(dir);
  return dir;
}

function main(argv) {
  const [tagRoot, siteDir] = argv;
  if (!tagRoot || !siteDir) { console.log('usage: node scripts/release-site-check.js <tag tree> <site folder>'); return 2; }
  const dir = expectedSite(path.resolve(tagRoot));
  try {
    const read = (m) => new Map([...m].map(([rel, p]) => [rel, () => fs.readFileSync(p)]));
    const expected = listFiles(dir);
    const problems = compareSites(read(expected), read(listFiles(path.resolve(siteDir))));
    for (const p of problems) console.log(`::error::The site is not the tag's: ${p}.`);
    if (problems.length) return 1;
    console.log(`[release-site-check] the site's ${expected.size} built files are the tag's, byte for byte; the rest are provider pictures`);
    return 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.log(`::error::The site check could not run: ${e.message}`); process.exitCode = 1; }
}
module.exports = { compareSites, pictureLooksRight, listFiles, expectedSite, PICTURE, main };

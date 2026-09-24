'use strict';
// Builds a fully standalone copy of the web app: public/ with the in-browser kernel already compiled
// in, plus one small extra script that switches the app straight into local mode. Point any static file
// host at the output (GitHub Pages, Netlify, S3, a USB drive with a laptop running `npx serve`, or the
// county's own web server) and it needs nothing else — no Node process, no database, no account on file
// anywhere. This is "SUDS on this device", the production web app for people without an office server:
// each person's records stay in their own browser, encrypted, like the office server's own local mode,
// and are protected by the device backups they download (docs/WEB_APP.md).
//
// public/ itself is untouched: it is also served by the office Node server, which must keep deciding for
// itself whether to run in local mode. Only the staged copy this script writes carries the always-local flag.
//
// Usage: node scripts/build-static-site.js [out-dir]   (default: _site)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.resolve(root, process.argv[2] || '_site');

// The kernel this ships has to be current, or the static site would carry a stale build of server logic.
require('./build-local.js');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) files += copyDir(s, d);
    else { fs.copyFileSync(s, d); files++; }
  }
  return files;
}

fs.rmSync(outDir, { recursive: true, force: true });
const count = copyDir(path.join(root, 'public'), outDir);

// One flag, set before main.js is even requested, so the very first render already knows: nothing here
// talks to a server. window.SUDS_LOCAL (set later, once local mode is already running) cannot be used for
// this — see the comment on isLocalMode() in app.js.
// SUDS_STATIC_HOST is an internal marker for the few things that differ on this build (SUDS on this
// device): it never syncs with an office server (local/sync.js), later sign-ups create accounts on the
// device, and the first-run set-up asks the person to confirm where their records are kept. Nothing is
// drawn on screen because of it.
fs.writeFileSync(path.join(outDir, 'local-boot.js'), [
  'window.SUDS_FORCE_LOCAL = true;',
  'window.SUDS_STATIC_HOST = true;',
  '',
].join('\n'));
const indexPath = path.join(outDir, 'index.html');
const before = fs.readFileSync(indexPath, 'utf8');
const marker = '<script type="module" src="main.js"></script>';
if (!before.includes(marker)) throw new Error(`build-static-site: expected to find ${JSON.stringify(marker)} in index.html`);
// A plain external script, not inline: this build is meant to be servable behind the same CSP the office
// server sends, which forbids inline scripts, even though a static host will not enforce it itself.
fs.writeFileSync(indexPath, before.replace(marker, `<script src="local-boot.js"></script>\n  ${marker}`));
// The "use SUDS on your phone or tablet" page is a plain file here (the office server serves it as /app,
// a rewrite a static host does not have). It loads the same boot script so it knows it is the static
// build — no certificate download, no office address.
const getAppPath = path.join(outDir, 'get-app.html');
const getApp = fs.readFileSync(getAppPath, 'utf8');
const getAppMarker = '<script src="get-app.js"></script>';
if (!getApp.includes(getAppMarker)) throw new Error(`build-static-site: expected to find ${JSON.stringify(getAppMarker)} in get-app.html`);
fs.writeFileSync(getAppPath, getApp.replace(getAppMarker, `<script src="local-boot.js"></script>${getAppMarker}`));

// The service worker is copied verbatim with public/ (above); this build's shell has one file more, the
// boot script, and it cannot be left out: a home-screen install that could not load it would open as the
// office login instead of local mode. Registered by app.js in local mode like everywhere else, so an
// installed copy opens with no connection at all.
const swPath = path.join(outDir, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
const shellMarker = "const SHELL = ['./', 'index.html',";
if (!sw.includes(shellMarker)) throw new Error('build-static-site: expected to find the SHELL list in sw.js');
if (!/'get-app\.html'/.test(sw)) throw new Error('build-static-site: sw.js must list get-app.html in its shell');
fs.writeFileSync(swPath, sw.replace(shellMarker, "const SHELL = ['./', 'index.html', 'local-boot.js',"));

console.log(`[suds] static site written to ${path.relative(root, outDir)}/ (${count + 1} files, always-local)`);

// Provider pictures for the starter directories. A browser cannot fetch them from the providers' own
// websites (those sites send no CORS headers), so "Download provider pictures" on this build reads copies
// published with the site, from region-pictures/<region>/ (server/region.js, bundledPicture). Best effort:
// a site that fails is left out, and a build with no network still succeeds, just without pictures.
//   SUDS_REGION_PICTURES unset or "fetch" — download them now (scripts/fetch-region-pictures.js)
//   SUDS_REGION_PICTURES=off              — leave them out (the browser suite's builds in CI)
//   SUDS_REGION_PICTURES=<folder>         — copy a folder written earlier by `npm run fetch-region-pictures`
(async () => {
  const mode = process.env.SUDS_REGION_PICTURES || 'fetch';
  const dest = path.join(outDir, 'region-pictures');
  try {
    if (mode === 'off') { console.log('[suds] provider pictures left out (SUDS_REGION_PICTURES=off)'); return; }
    if (mode !== 'fetch') {
      const src = path.resolve(root, mode);
      if (!fs.existsSync(src)) { console.warn(`[suds] warning: SUDS_REGION_PICTURES folder ${src} does not exist; this build has no provider pictures`); return; }
      console.log(`[suds] provider pictures copied from ${src} (${copyDir(src, dest)} files)`);
      return;
    }
    const { bundled, tried } = await require('./fetch-region-pictures.js').fetchAll({ outDir: dest });
    if (!bundled) console.warn(`[suds] warning: none of the ${tried} provider pictures could be downloaded (no network?). The site is complete without them; "Download provider pictures" says they are not available on this build.`);
  } catch (e) {
    console.warn(`[suds] warning: provider pictures skipped: ${e.message}`);
  }
})();

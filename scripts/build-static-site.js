'use strict';
// Builds a fully standalone copy of the web app: public/ with the in-browser kernel already compiled
// in, plus one small extra script that switches the app straight into local mode. Point any static file
// host at the output (GitHub Pages, Netlify, S3, a USB drive with a laptop running `npx serve`, or the
// county's own web server) and it needs nothing else — no Node process, no database, no account on file
// anywhere. Every county worker's data stays in their own browser, like the office server's own local mode.
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
// SUDS_STATIC_HOST marks this as a copy served by a host the county does not run: local/sync.js refuses
// to sync it with an office server unless that server opts in (ALLOW_STATIC_SYNC), and the banner below
// stays on screen for as long as the page is open, so nobody mistakes an evaluation copy for the office
// system and types a real person into it.
fs.writeFileSync(path.join(outDir, 'local-boot.js'), [
  'window.SUDS_FORCE_LOCAL = true;',
  'window.SUDS_STATIC_HOST = true;',
  "document.addEventListener('DOMContentLoaded', function () {",
  "  var b = document.createElement('div'); b.className = 'static-demo-banner'; b.setAttribute('role', 'note');",
  "  b.textContent = 'Demo/evaluation build \\u2014 do not enter real client information';",
  '  document.body.insertBefore(b, document.body.firstChild);',
  '});',
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
// build — no certificate download, no office address — and carries the same demo banner.
const getAppPath = path.join(outDir, 'get-app.html');
const getApp = fs.readFileSync(getAppPath, 'utf8');
const getAppMarker = '<script src="get-app.js"></script>';
if (!getApp.includes(getAppMarker)) throw new Error(`build-static-site: expected to find ${JSON.stringify(getAppMarker)} in get-app.html`);
fs.writeFileSync(getAppPath, getApp.replace(getAppMarker, `<script src="local-boot.js"></script>${getAppMarker}`));

// The service worker is copied verbatim with public/ (above); this build's shell has one file more, the
// boot script, and it cannot be left out: a home-screen install that could not load it would open as the
// office login instead of local mode. Registered by app.js in local mode like everywhere else, so an
// installed demo copy opens with no connection at all.
const swPath = path.join(outDir, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
const shellMarker = "const SHELL = ['./', 'index.html',";
if (!sw.includes(shellMarker)) throw new Error('build-static-site: expected to find the SHELL list in sw.js');
if (!/'get-app\.html'/.test(sw)) throw new Error('build-static-site: sw.js must list get-app.html in its shell');
fs.writeFileSync(swPath, sw.replace(shellMarker, "const SHELL = ['./', 'index.html', 'local-boot.js',"));

console.log(`[suds] static site written to ${path.relative(root, outDir)}/ (${count + 1} files, always-local)`);

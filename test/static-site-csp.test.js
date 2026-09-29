'use strict';
// Security review of 1.12.4, finding 5: the GitHub Pages build (SUDS on this device) had no Content-Security-
// Policy at all and nothing against being framed, though it holds every record in the browser. Every page of
// the build now carries the office server's policy as a <meta> (without frame-ancestors, which a meta cannot
// set) and loads a frame guard first.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../scripts/static-site-security');
const { CSP } = require('../server/csp');

const pub = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(pub).filter(f => f.endsWith('.html'));

test('every page of the static build gets the CSP meta and the frame guard before any other script', () => {
  assert.ok(pages.includes('index.html') && pages.includes('get-app.html'));
  for (const f of pages) {
    const out = S.hardenPage(fs.readFileSync(path.join(pub, f), 'utf8'), f);
    const head = out.slice(0, out.indexOf('</head>'));
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(head);
    assert.ok(meta, `${f}: CSP meta in <head>`);
    const csp = Object.fromEntries(meta[1].split(';').map(x => x.trim().split(/\s+/)).filter(x => x[0]).map(([k, ...v]) => [k, v]));
    assert.deepEqual(csp['connect-src'], ["'self'"], `${f}: connect-src is this site only (the build never syncs)`);
    assert.deepEqual(csp['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
    assert.deepEqual(csp['default-src'], ["'self'"]);
    assert.deepEqual(csp['base-uri'], ["'none'"]);
    assert.equal(csp['frame-ancestors'], undefined, 'a meta policy cannot set frame-ancestors; the guard does its job');
    assert.ok(out.indexOf(meta[0]) < out.search(/<script|<link rel="stylesheet"/), `${f}: the policy comes before anything it governs`);
    const firstScript = /<script[^>]*>/.exec(out);
    assert.ok(firstScript && firstScript[0].includes(`src="${S.FRAME_GUARD_FILE}"`), `${f}: the frame guard is the first script`);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(out), `${f}: no inline script`);
  }
});

test('the static policy is the office server\'s, minus frame-ancestors', () => {
  assert.equal(S.STATIC_CSP, CSP.split(';').map(x => x.trim()).filter(x => x && !x.startsWith('frame-ancestors')).join('; '));
});

test('the frame guard hides the page and breaks out when framed, and does nothing when not', () => {
  const run = (framed) => {
    const doc = { documentElement: { style: {} } };
    const self = { location: { href: 'https://example.github.io/suds/' } };
    let replaced = null;
    const top = framed ? { location: { replace: (u) => { replaced = u; } } } : self;
    new Function('window', 'document', S.FRAME_GUARD_JS)(Object.assign(self, { top, self }), doc);
    return { hidden: doc.documentElement.style.display === 'none', replaced };
  };
  assert.deepEqual(run(false), { hidden: false, replaced: null });
  assert.deepEqual(run(true), { hidden: true, replaced: 'https://example.github.io/suds/' });
});

test('the build script applies it to every page and writes the guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-static-site.js'), 'utf8');
  assert.match(src, /require\('\.\/static-site-security'\)/);
  assert.match(src, /hardenPage\(/);
  assert.match(src, /FRAME_GUARD_FILE/);
});

// 1.17.0: a secure referral link is opened against the office that made it; on SUDS on this device the page could
// only ever say the link is not valid, so the build leaves it out (stageShell, which the release site check reuses).
test('the static build leaves out the office-only referral-link page', () => {
  const os = require('node:os');
  const { stageShell, copyDir, OFFICE_ONLY_PAGES } = require('../scripts/build-static-site');
  assert.deepEqual(OFFICE_ONLY_PAGES, ['referral-link.html', 'referral-link.js']);
  for (const f of OFFICE_ONLY_PAGES) assert.ok(fs.existsSync(path.join(pub, f)), `public/${f} exists for the office server`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-static-'));
  try {
    copyDir(pub, dir);
    stageShell(dir);
    for (const f of OFFICE_ONLY_PAGES) assert.ok(!fs.existsSync(path.join(dir, f)), `${f} is not in the static build`);
    assert.ok(fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'get-app.html')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

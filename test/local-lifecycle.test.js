'use strict';
// The pieces of the 1.9.3 local-mode lifecycle fixes that run outside a browser: server/db.js openWith()
// always opening what it is given, the service worker's re-heading of app files (public/sw.js), and the
// version.json an open page compares itself with. The multi-window behaviour itself (fencing, takeover,
// paused screen) needs two real browser tabs: scripts/ui/multitab.mjs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('openWith closes the database it had open and opens the one it is given', () => {
  process.env.SUDS_ENV = process.env.SUDS_ENV || 'test';
  const db = require('../server/db');
  try { db.close(); } catch {}
  const first = db.openWith(null);
  db.setSetting('marker', 'first copy');
  const second = db.openWith(null);
  assert.notStrictEqual(second, first, 'a second call is not handed the stale handle');
  assert.equal(db.getSetting('marker', null), null, 'and nothing of the earlier copy is visible through it');
  assert.throws(() => first.prepare('SELECT 1').get(), 'the earlier copy is closed');
  db.close();
});

// Loads public/sw.js with a stub `self` and returns its fetch handler.
function loadWorker(fetchImpl) {
  const listeners = {};
  const self = { addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: () => {}, clients: { claim: () => {} } };
  const caches = { open: async () => ({ put: async () => {}, add: async () => {} }), match: async () => undefined, keys: async () => [] };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8'), { self, caches, fetch: fetchImpl, Request, Response, Headers, URL, Promise });
  return async (url, init = {}) => {
    let responded = null;
    listeners.fetch({ request: new Request(url, init), respondWith: (p) => { responded = p; } });
    return responded ? await responded : null;
  };
}

test('the service worker keeps the office server\'s no-store, and re-heads only cacheable responses', async () => {
  const origin = 'https://suds.example';
  const body = 'console.log(1)';
  let next;
  const handle = loadWorker(async () => next());
  next = () => new Response(body, { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript' } });
  const office = await handle(origin + '/app.js');
  assert.equal(office.headers.get('cache-control'), 'no-store', 'no-store passes through, never weakened to no-cache');
  next = () => new Response(body, { status: 200, headers: { 'Cache-Control': 'max-age=600', 'Content-Encoding': 'gzip', 'Content-Length': '999', 'Content-Type': 'text/javascript' } });
  const pages = await handle(origin + '/app.js');
  assert.equal(pages.headers.get('cache-control'), 'no-cache', 'a static host\'s max-age is replaced');
  assert.equal(pages.headers.get('content-encoding'), null, 'the decoded body does not claim an encoding');
  assert.equal(pages.headers.get('content-length'), null, 'nor the encoded length');
  assert.equal(await pages.text(), body);
});

test('version.json is never answered by the service worker', async () => {
  const handle = loadWorker(async () => new Response('{}'));
  assert.equal(await handle('https://suds.example/version.json'), null, 'left to the network');
  assert.equal(await handle('https://suds.example/api/clients'), null);
});

test('version.json names the release (npm run build:local)', () => {
  const version = require('../package.json').version;
  const v = JSON.parse(fs.readFileSync(path.join(root, 'public', 'version.json'), 'utf8'));
  assert.equal(v.version, version, 'public/version.json — run `npm run build:local`');
});

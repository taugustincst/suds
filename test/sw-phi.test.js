'use strict';
// The service worker (public/sw.js) may cache the application shell and nothing else: never an API answer,
// a FHIR or SCIM response, a request to another origin (the office server a device syncs with), or anything
// that is not a GET. Driven here through its real fetch handler with a recording Cache Storage.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://suds.county.example';

function loadWorker() {
  const listeners = {}; const puts = []; const fetched = [];
  const self = { addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: () => {}, clients: { claim: () => {} }, location: { origin: ORIGIN } };
  const cache = { put: async (req) => { puts.push(typeof req === 'string' ? req : req.url); }, add: async (req) => { puts.push(typeof req === 'string' ? req : req.url); } };
  const caches = { open: async () => cache, match: async () => undefined, keys: async () => [] };
  const fetchImpl = async (req) => { fetched.push(typeof req === 'string' ? req : req.url); return new Response('{"client":"PHI"}', { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); };
  vm.runInNewContext(SRC, { self, caches, fetch: fetchImpl, Request, Response, Headers, URL, Promise, location: self.location });
  const dispatch = async (url, init = {}) => {
    let responded = null;
    listeners.fetch({ request: new Request(url, init), respondWith: (p) => { responded = p; } });
    if (responded) await responded;
    await new Promise(r => setImmediate(r)); // let the cache.put chained after the response run
    return !!responded;
  };
  return { dispatch, puts, fetched };
}

test('API, FHIR, SCIM, other origins and non-GET requests are never intercepted or cached', async () => {
  const w = loadWorker();
  const never = [
    [`${ORIGIN}/api/clients/123`], [`${ORIGIN}/api/sync/pull?since=x`], [`${ORIGIN}/api/documents/1/file`], [`${ORIGIN}/api/consents/1/pdf`],
    [`${ORIGIN}/fhir/R4/Patient/1`], [`${ORIGIN}/fhir/R4/$export-file/job/Patient.ndjson`], [`${ORIGIN}/scim/v2/Users`],
    [`${ORIGIN}/suds/api/clients`], [`${ORIGIN}/version.json`],
    ['https://office.county.example/api/sync/pull'], ['https://office.county.example/clients.json'], ['https://tiles.example.org/1/2/3.png'],
    [`${ORIGIN}/app.js`, { method: 'POST', body: '{}' }], [`${ORIGIN}/index.html`, { method: 'PUT', body: 'x' }],
  ];
  for (const [url, init] of never) {
    const handled = await w.dispatch(url, init);
    assert.equal(handled, false, `${url} goes straight to the network`);
  }
  assert.deepEqual(w.puts, [], 'nothing was cached');
});

test('the shell is still cached, and the source keeps the rule where a reader will find it', async () => {
  const w = loadWorker();
  assert.equal(await w.dispatch(`${ORIGIN}/app.js`), true);
  assert.equal(await w.dispatch(`${ORIGIN}/views/client.js`), true);
  assert.deepEqual(w.puts, [`${ORIGIN}/app.js`, `${ORIGIN}/views/client.js`]);
  // Static analysis: the only cache writes are the fetch handler's shell copy and the install precache.
  assert.equal((SRC.match(/\.put\(/g) || []).length, 2, 'cache.put appears only in precache and the fetch handler');
  assert.match(SRC, /API responses \(PHI\) are NEVER cached/);
  // Nothing in the precache list is an API or data route.
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(SRC)[1];
  assert.ok(!/api\/|fhir\/|scim\//.test(shell));
});

// Security review of 1.13.0, item 8: SUDS on this device is published at <owner>.github.io/<repo>/, which is
// one origin with every other Pages site of that owner, and Cache Storage is per origin. The offline fallback
// read caches.match() - every cache on the origin - so another site's cached response for a SUDS address could
// be served as SUDS; and a new version deleted every cache on the origin that was not its own. The worker now
// reads only its own cache, answers only addresses inside its scope, and deletes only older SUDS shell caches.
const SITE = 'https://owner.github.io';
function sharedOriginWorker({ scope = `${SITE}/suds/` } = {}) {
  const VERSION = /const VERSION = '([^']*)'/.exec(SRC)[1];
  const listeners = {}; const deleted = [];
  const store = { [VERSION]: new Map([[`${scope}index.html`, 'SUDS SHELL']]), 'other-site-v1': new Map([[`${scope}app.js`, 'FOREIGN'], [`${scope}index.html`, 'FOREIGN']]), 'suds-shell-1.0.0': new Map() };
  const cacheOf = (name) => ({
    match: async (req) => { const u = typeof req === 'string' ? req : req.url; const hit = store[name] && store[name].get(u.split('?')[0]); return hit ? new Response(hit) : undefined; },
    put: async () => {}, add: async () => {},
  });
  const caches = {
    open: async (name) => { store[name] = store[name] || new Map(); return cacheOf(name); },
    match: async (req) => { for (const n of Object.keys(store)) { const r = await cacheOf(n).match(req); if (r) return r; } return undefined; },
    keys: async () => Object.keys(store),
    delete: async (n) => { deleted.push(n); delete store[n]; return true; },
  };
  const self = { addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: () => {}, clients: { claim: async () => {} }, location: { origin: SITE, href: `${scope}sw.js` }, registration: { scope } };
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  vm.runInNewContext(SRC, { self, caches, fetch: offline, Request, Response, Headers, URL, Promise, location: self.location });
  const get = async (url, mode) => {
    let responded = null;
    const request = new Request(url);
    const req = mode ? new Proxy(request, { get: (t, k) => (k === 'mode' ? mode : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) }) : request;
    listeners.fetch({ request: req, respondWith: (p) => { responded = p; } });
    if (!responded) return null;
    const r = await responded;
    return r.type === 'error' ? 'error' : r.text();
  };
  const activate = async () => { let p; listeners.activate({ waitUntil: (x) => { p = x; } }); await p; };
  return { get, activate, deleted };
}

test('offline, only SUDS\'s own cache answers: never another site\'s cache on the same origin', async () => {
  const w = sharedOriginWorker();
  assert.equal(await w.get(`${SITE}/suds/app.js`), 'error', 'a script SUDS has not cached fails, rather than coming from another site\'s cache');
  assert.equal(await w.get(`${SITE}/suds/`, 'navigate'), 'SUDS SHELL', 'a page load falls back to SUDS\'s own index.html');
});

test('an address outside SUDS\'s scope on the same origin is never answered by it', async () => {
  const w = sharedOriginWorker();
  assert.equal(await w.get(`${SITE}/other-repo/app.js`), null, 'another Pages site of the same owner goes to the network untouched');
});

test('a new version deletes only older SUDS shell caches, not other sites\' caches', async () => {
  const w = sharedOriginWorker();
  await w.activate();
  assert.deepEqual(w.deleted, ['suds-shell-1.0.0']);
});

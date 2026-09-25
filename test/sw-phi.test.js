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

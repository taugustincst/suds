'use strict';
// SUDS on this device has no county connection (docs/COUNTY-VIEW.md, "Connecting"): the browser kernel, bundled from
// the current sources (test/fixtures/kernel-harness.js), answers every county connection route as not found, the
// machine routes and the signed-in ones alike, for its administrator too.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup;
before(async () => { ({ L, cleanup } = await loadKernel({ staticHost: true })); });
after(() => cleanup());
const call = (...a) => kernelCaller(L)(...a);

test('the device refuses the county connection routes: no tokens, no connection, no push, no read API', async () => {
  assert.equal((await call('POST', '/api/local/signup', { display_name: 'Device Admin', username: 'devadmin', password: 'Orchid-Lamp-77!x', role: 'admin', storage_ack: true })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'devadmin', password: 'Orchid-Lamp-77!x' })).status, 200);
  for (const [m, p] of [['GET', '/api/county-connect/settings'], ['PUT', '/api/county-connect/settings'], ['GET', '/api/county-connect/tokens'], ['POST', '/api/county-connect/tokens'],
    ['GET', '/api/county-connect/connection'], ['PUT', '/api/county-connect/connection'], ['POST', '/api/county-connect/connection/test'], ['POST', '/api/county-connect/send'],
    ['POST', '/api/county-connect/v1/submissions'], ['GET', '/api/county-connect/v1/status'], ['GET', '/api/county-connect/v1/combined?from=2026-01-01&to=2026-03-31'], ['GET', '/api/county-connect/v1/programs']]) {
    const r = await call(m, p, m === 'GET' ? undefined : {});
    assert.equal(r.status, 404, `${m} ${p}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
});

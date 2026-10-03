'use strict';
// SUDS on this device has no county relationship (docs/COUNTY-VIEW.md): the browser kernel, bundled from the current
// sources (test/fixtures/kernel-harness.js), answers every county route as not found, for its administrator too, and
// its navigation is told there are no county programmes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup;
before(async () => { ({ L, cleanup } = await loadKernel({ staticHost: true })); });
after(() => cleanup());
const call = (...a) => kernelCaller(L)(...a);

test('the device refuses the county routes: no signing key, no file, no county view', async () => {
  assert.equal((await call('POST', '/api/local/signup', { display_name: 'Device Admin', username: 'devadmin', password: 'Orchid-Lamp-77!x', role: 'admin', storage_ack: true })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'devadmin', password: 'Orchid-Lamp-77!x' })).status, 200);
  const day = require('../server/routes/budget').localDate();
  for (const [m, p] of [['GET', '/api/county-submission/key'], ['POST', '/api/county-submission/key'], ['GET', `/api/county-submission/file?from=2026-01-01&to=${day}`],
    ['GET', '/api/county/programmes'], ['POST', '/api/county/programmes'], ['GET', '/api/county/submissions'], ['POST', '/api/county/submissions'], ['GET', `/api/county/view?from=2026-01-01&to=${day}`]]) {
    const r = await call(m, p, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 404, `${m} ${p}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.status, 200); assert.equal(me.data.programme.county_programmes, 0);
});

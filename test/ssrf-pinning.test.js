'use strict';
// Security review of 1.12.4, 8(d): server/outbound.js checked what a name resolved to, then let fetch()
// resolve it again to connect — a name that answers "public" to the check and "127.0.0.1" to the connection
// (DNS rebinding) got through. And any lookup failure was waved through whenever HTTPS_PROXY was set, even
// when Node was not using the proxy (it only does with NODE_USE_ENV_PROXY=1), so the connection was direct.
// Now the connection is made to the address that was checked (the lookup and the check are one step, at
// connect time; the Host header and TLS name stay the site's), and a failed lookup refuses unless a proxy is
// really doing the connecting.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const outbound = require('../server/outbound');

const ENV = ['HTTPS_PROXY', 'https_proxy', 'NODE_USE_ENV_PROXY'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const setEnv = (o) => { for (const k of ENV) { if (o[k] === undefined) delete process.env[k]; else process.env[k] = o[k]; } };
afterEach(() => { setEnv(saved); outbound._setLookupForTests(null); outbound._setFetchForTests(null); });

test('a name that rebinds to a private address after the check is refused at connect time', async () => {
  setEnv({}); // no proxy: SUDS connects itself
  let calls = 0;
  outbound._setLookupForTests(async () => (calls++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]));
  await assert.rejects(outbound.fetchChecked('https://rebind.example.org/x.png', { timeoutMs: 3000 }), /not on the public internet/);
  assert.ok(calls >= 2, 'the connection resolved the name itself, through the same check');
});

test('the connection lookup returns only checked addresses, in both callback shapes', async () => {
  outbound._setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }]);
  const one = await new Promise((res) => outbound.connectLookup('pics.example.org', {}, (err, address, family) => res({ err, address, family })));
  assert.deepEqual(one, { err: null, address: '93.184.216.34', family: 4 });
  const all = await new Promise((res) => outbound.connectLookup('pics.example.org', { all: true }, (err, list) => res({ err, list })));
  assert.equal(all.err, null); assert.deepEqual(all.list.map(x => x.address), ['93.184.216.34', '2606:4700::1111']);
  outbound._setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }]);
  const bad = await new Promise((res) => outbound.connectLookup('mixed.example.org', {}, (err) => res(err)));
  assert.match(String(bad && bad.message), /not on the public internet/);
});

test('a failed lookup refuses unless a proxy is really making the connection', async () => {
  outbound._setLookupForTests(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); });
  setEnv({});
  await assert.rejects(outbound.assertResolvesPublic('https://pics.example.org/x.png'));
  setEnv({ HTTPS_PROXY: 'http://proxy.county.example:3128' });
  await assert.rejects(outbound.assertResolvesPublic('https://pics.example.org/x.png'), 'HTTPS_PROXY alone: Node connects directly, so nothing else resolved it');
  setEnv({ HTTPS_PROXY: 'http://proxy.county.example:3128', NODE_USE_ENV_PROXY: '1' });
  await outbound.assertResolvesPublic('https://pics.example.org/x.png'); // the proxy resolves and connects
  outbound._setLookupForTests(async () => { throw Object.assign(new Error('boom'), { code: 'EBADNAME' }); });
  await assert.rejects(outbound.assertResolvesPublic('https://pics.example.org/x.png'), 'only "this machine cannot resolve outside names" is waved on to the proxy');
  outbound._setLookupForTests(async () => [{ address: '10.1.1.1' }]);
  await assert.rejects(outbound.assertResolvesPublic('https://pics.example.org/x.png'), /not on the public internet/, 'a private answer is refused even behind the proxy');
});

'use strict';
// 1.25.7, K2: CI's WebKit run of 1.25.6 saw SUDS on this device fail at a FIRST visit, before anything was stored:
// "Could not start SUDS on this device: Out of bounds memory access" — the SQLite engine (WebAssembly) failing inside
// itself as the empty database was created. 1.25.5's retry on a new engine (H1) covered sign-in only. The kernel
// (bundled from the current sources, run in Node: test/fixtures/kernel-harness.js) is started here with engines that
// fail as test/device-damaged-db.test.js makes them fail at sign-in: every engine is numbered, and those up to
// `faultUpTo` throw that error whenever a database is opened on them. Start-up must try once more on a new engine;
// when that fails too on a device with nothing stored, the error says so (the page then advises a reload, never
// Start over: public/app.js boot); a device with records keeps its locked sign-in and the damaged-records flow.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

const SQL_WASM = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.js'), 'utf8');
const OPEN_EXPORT = (/f\._sqlite3_open=\(a,b\)=>\(f\._sqlite3_open=Z\.(\w+)\)/.exec(SQL_WASM) || [])[1];
let engines = 0; let faultUpTo = 0;
function faultyEngines() {
  const wrap = (r) => {
    if (!r || !r.instance) return r;
    const n = ++engines; const real = r.instance.exports;
    const exports = { ...real, [OPEN_EXPORT]: (...a) => { if (n <= faultUpTo) throw new WebAssembly.RuntimeError('Out of bounds memory access'); return real[OPEN_EXPORT](...a); } };
    return { module: r.module, instance: { exports } };
  };
  for (const k of ['instantiate', 'instantiateStreaming']) { const real = WebAssembly[k].bind(WebAssembly); WebAssembly[k] = (...a) => real(...a).then(wrap); }
}
const quietly = async (fn) => { const seen = []; const e = console.error; const w = console.warn; console.error = console.warn = (...a) => seen.push(a.join(' ')); try { return { r: await fn(), seen }; } finally { console.error = e; console.warn = w; } };

let start; let cleanup;
before(async () => {
  assert.ok(OPEN_EXPORT, 'sql.js names its sqlite3_open export as this test expects');
  // Each start() below stands for a new document, but this process is one page. Node 24 has navigator.locks, and the
  // kernel holds its single-writer lock until the page is gone, so a second start() here would find it held ("open in
  // another window"; CI's node24 job on 1.25.7's candidate). The lock is not what this tests: it is left out, as on
  // Node 22, which has no navigator.locks (the lock's own checks: scripts/ui/multitab.mjs).
  if (globalThis.navigator && navigator.locks) Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  faultyEngines();
  ({ start, cleanup } = await loadKernel({ staticHost: true, start: false }));
});
after(() => { if (cleanup) cleanup(); });

test('a first visit whose engine fails twice: one retry on a new engine, then "nothing is stored" — not a reset', async () => {
  faultUpTo = Infinity;
  let out;
  try { out = await quietly(() => start().then(() => null, (e) => e)); } finally { faultUpTo = 0; }
  const e = out.r;
  assert.ok(e, 'the start fails');
  assert.equal(e.code, 'SUDS_ENGINE_FAILED');
  assert.equal(e.nothingStored, true, 'nothing is stored on this device yet');
  assert.match(e.message, /Out of bounds memory access/); assert.match(e.first, /Out of bounds memory access/);
  assert.equal(engines, 2, 'exactly one new engine was tried');
  assert.ok(out.seen.some((x) => /failed while starting; trying once more on a new engine: .*Out of bounds memory access/.test(x)), out.seen.join(' / '));
});

let L; let call;
test('a first visit whose first engine fails starts on a new engine, and set-up works', async () => {
  // The kernel is one module here, as a page is one document: the engine the last start ended on is the one this start
  // finds (a reload would start a new one). It fails; the new one started for the retry works.
  faultUpTo = engines;
  let out;
  try { out = await quietly(() => start()); } finally { faultUpTo = 0; }
  L = out.r; call = kernelCaller(L);
  assert.equal(L.phase(), 'fresh');
  assert.ok(out.seen.some((x) => /trying once more on a new engine/.test(x)), out.seen.join(' / '));
  const r = await call('POST', '/api/local/setup', { display_name: 'Owner', username: 'owner', password: 'Lantern-Harbor-2026!', role: 'admin', storage_ack: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call('POST', '/api/auth/login', { username: 'owner', password: 'Lantern-Harbor-2026!' })).status, 200);
  await call('POST', '/api/auth/logout', {});
  await L.flush({ force: true });
});

test('with records on the device, start-up is the locked sign-in as before: the engine is asked at sign-in, not here', async () => {
  const before = engines;
  const { r } = await quietly(() => start());
  assert.equal(r.phase(), 'locked', 'a sealed image and a vault: locked until an account signs in');
  assert.equal(engines, before, 'no new engine was needed to start');
});

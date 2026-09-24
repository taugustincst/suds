'use strict';
// The browser error beacon (server/routes/client-errors.js): a signed-in session only, ten reports a minute
// per person, written to the application log at WARN and never to the audit log, with nothing but the
// fixed, cleaned fields.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { sanitize } = require('../server/routes/client-errors');

let base;
before(async () => { base = await H.start(); });
after(async () => { await H.stop(); });

function captureWarn(fn) {
  const lines = []; const orig = console.warn;
  console.warn = (...a) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  return Promise.resolve().then(fn).finally(() => { console.warn = orig; }).then(() => lines);
}

test('a report needs a signed-in session', async () => {
  const r = await fetch(base + '/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ message: 'x' }) });
  assert.equal(r.status, 401);
});

test('a report is logged at WARN, cleaned, and not audited', async () => {
  const u = H.makeUser('beacon1', 'navigator');
  const c = H.client(); await c.login(u.username, u.password);
  const auditBefore = H.db.one(`SELECT COUNT(*) n FROM audit_log`).n;
  let res;
  const lines = await captureWarn(async () => {
    res = await c.post('/api/client-errors', {
      kind: 'error', message: 'Cannot read x of undefined for 5551234567 jane.doe@example.org 123-45-6789',
      stack: ['app.js:120', 'views/client.js:88', 'evil frame with spaces', 'main.js:1', 'a.js:2', 'b.js:3', 'c.js:4'],
      route: '#/client/abc?name=Jane', version: '1.9.2', browser: 'Chrome 120 / Android', extra: 'must not be logged', status: 500,
    });
  });
  assert.equal(res.status, 200);
  const line = lines.find(l => l.includes('[client-error]'));
  assert.ok(line, 'written to the application log');
  assert.doesNotMatch(line, /5551234567|jane\.doe|123-45-6789|name=Jane|must not be logged|evil frame/);
  const logged = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(logged.user, u.id);
  assert.equal(logged.route, '#/client/abc');
  assert.deepEqual(logged.stack, ['app.js:120', 'views/client.js:88', 'main.js:1', 'a.js:2']);
  assert.equal(logged.status, 500);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log`).n, auditBefore, 'diagnostics are not audit events');
});

test('ten reports a minute per person, then 429', async () => {
  const u = H.makeUser('beacon2', 'navigator');
  const c = H.client(); await c.login(u.username, u.password);
  const statuses = [];
  await captureWarn(async () => { for (let i = 0; i < 12; i++) statuses.push((await c.post('/api/client-errors', { message: 'loop ' + i })).status); });
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
  // Someone else is not held back by it.
  const v = H.makeUser('beacon3', 'navigator');
  const d = H.client(); await d.login(v.username, v.password);
  await captureWarn(async () => { assert.equal((await d.post('/api/client-errors', { message: 'mine' })).status, 200); });
});

test('sanitize keeps a fixed shape and cuts long messages', () => {
  const s = sanitize({ message: 'x'.repeat(1000), kind: 'nonsense', stack: 'not an array', route: 42, version: '<script>', browser: null });
  assert.equal(s.message.length, 300);
  assert.equal(s.kind, 'error');
  assert.deepEqual(s.stack, []);
  assert.equal(s.version, 'script');
  assert.deepEqual(Object.keys(s).sort(), ['browser', 'kind', 'message', 'route', 'stack', 'status', 'version']);
});

test('the route is office-only: a device keeps its own list instead', () => {
  const { ROUTE_MODULES, LOCAL_ROUTE_MODULES } = require('../server/app');
  assert.ok(ROUTE_MODULES.includes('client-errors'));
  assert.ok(!LOCAL_ROUTE_MODULES.includes('client-errors'));
});

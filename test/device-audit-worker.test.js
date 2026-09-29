'use strict';
// On a device, a publication release's audit runs in a Web Worker, not on the page's thread (1.17.0; engineering
// reviews of 1.13.0-1.16.3: the kernel audited on the page's thread for up to the 60-second backstop, which could
// hold a phone). The committed worker (public/local/audit-worker.js, built by npm run build:local from
// local/audit-worker.js; CI fails when it is out of date) is run here as a browser would run it, and the runner
// (local/audit-runner.js) with stand-in Workers: the same release as the page would make, a fall-back to the page
// when no worker can start, and a refusal when one stops answering. docs/architecture/ADR-0009, "Where it runs".
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('./helpers'); // the test environment (test keys), before any server module
const RA = require('../server/release-audit');
const PR = require('../server/publication-release');

const bundle = fs.readFileSync(path.join(__dirname, '..', 'public', 'local', 'audit-worker.js'), 'utf8');
const year = require('./fixtures/release-small-programme.json');
const inputsOf = (f) => ({ ...f.inputs, perFund: new Map(f.inputs.perFund) });

let auditRunner;
const wasInline = process.env.SUDS_AUDIT_INLINE;
before(async () => {
  ({ auditRunner } = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '..', 'local', 'audit-runner.js')).toString('base64')));
  // The kernel's path (server/publication-release.js inline(): there is no worker thread on a device).
  process.env.SUDS_AUDIT_INLINE = '1';
});
after(() => { PR.setDeviceAuditRunner(null); if (wasInline === undefined) delete process.env.SUDS_AUDIT_INLINE; else process.env.SUDS_AUDIT_INLINE = wasInline; });

/** The committed worker script, run as a browser runs a classic worker: its own global `self`, messages cloned. */
class BundleWorker {
  constructor(url) {
    this.url = url; this.terminated = false; this.posted = 0;
    const self = { postMessage: (d) => { const data = structuredClone(d); setImmediate(() => { if (!this.terminated && this.onmessage) this.onmessage({ data }); }); } };
    this.self = self;
    vm.runInNewContext(bundle, { self, console });
  }
  postMessage(m) { this.posted++; const data = structuredClone(m); setImmediate(() => { if (!this.terminated) this.self.onmessage({ data }); }); }
  terminate() { this.terminated = true; }
}

test('the committed worker script audits a release exactly as the page (and the office) would', () => {
  const posted = [];
  const self = { postMessage: (d) => posted.push(d) };
  vm.runInNewContext(bundle, { self, console });
  assert.deepEqual(posted, [{ ready: true }], 'it says it started');
  const T = year.T;
  self.onmessage({ data: { id: 7, inputs: structuredClone(inputsOf(year)), T, opts: {} } });
  const direct = RA.protectFigures(inputsOf(year), T);
  assert.equal(posted[1].id, 7);
  assert.ok(!posted[1].error, posted[1].error);
  assert.equal(posted[1].result.id, direct.id, 'the same release id');
  assert.deepEqual(posted[1].result.funder, direct.funder);
  assert.deepEqual(posted[1].result.withheld_tables, direct.withheld_tables);
  // An audit that throws is answered with the error, never left waiting.
  self.onmessage({ data: { id: 8, inputs: null, T, opts: {} } });
  assert.equal(posted[2].id, 8); assert.ok(posted[2].error);
});

test('the kernel audits in the worker: the page\'s thread is not used, and the release is the same', async () => {
  const made = [];
  PR.setDeviceAuditRunner(auditRunner('local/audit-worker.js?v=test', { WorkerCtor: class extends BundleWorker { constructor(u, o) { super(u, o); made.push(this); } } }));
  const before = { ...PR.auditStats };
  const r = await PR.runAudit(inputsOf(year), year.T);
  assert.equal(r.id, RA.protectFigures(inputsOf(year), year.T).id);
  assert.equal(PR.auditStats.device, before.device + 1, 'one audit, on the device runner');
  assert.equal(PR.auditStats.inline, before.inline, 'none on the page');
  // One long-lived worker: a second audit goes to the same one.
  await PR.runAudit(inputsOf(year), year.T);
  assert.equal(made.length, 1); assert.equal(made[0].posted, 2);
});

test('where no worker can start, the audit runs on the page as before', async () => {
  const cases = {
    'no Web Workers': undefined,
    'the constructor throws': class { constructor() { throw new Error('blocked'); } },
    'the script does not load': class { constructor() { setImmediate(() => this.onerror && this.onerror({ message: 'load failed', preventDefault() {} })); } postMessage() {} terminate() {} },
  };
  for (const [what, WorkerCtor] of Object.entries(cases)) {
    PR.setDeviceAuditRunner(auditRunner('local/audit-worker.js?v=test', { WorkerCtor: WorkerCtor || null }));
    const before = { ...PR.auditStats };
    const r = await PR.runAudit(inputsOf(year), year.T);
    assert.equal(r.id, RA.protectFigures(inputsOf(year), year.T).id, what);
    assert.equal(PR.auditStats.inline, before.inline + 1, `${what}: on the page`);
  }
  // A worker that never says it started is given up after startMs, and its audit runs on the page.
  const silent = class { postMessage() {} terminate() { this.stopped = true; } };
  PR.setDeviceAuditRunner(auditRunner('u', { WorkerCtor: silent, startMs: 30 }));
  const before = { ...PR.auditStats };
  const r = await PR.runAudit(inputsOf(year), year.T);
  assert.ok(r.id); assert.equal(PR.auditStats.inline, before.inline + 1);
});

test('a worker that stops answering is stopped, and its release refused as by the backstop; the next audit gets a new worker', async () => {
  const made = [];
  // Says it started, then never answers.
  class Hanging { constructor() { made.push(this); setImmediate(() => this.onmessage && this.onmessage({ data: { ready: true } })); } postMessage() {} terminate() { this.stopped = true; } }
  PR.setDeviceAuditRunner(auditRunner('u', { WorkerCtor: Hanging, backstopMs: 60 }));
  const r = await PR.runAudit(inputsOf(year), year.T);
  assert.ok(r.refused && r.refused.backstop, JSON.stringify(r).slice(0, 200));
  assert.match(r.refused.message, /cannot be published/);
  assert.ok(made[0].stopped, 'the worker was stopped');
  const r2 = await PR.runAudit(inputsOf(year), year.T);
  assert.ok(r2.refused && r2.refused.backstop);
  assert.equal(made.length, 2, 'a new worker for the next audit');
});

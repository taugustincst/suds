'use strict';
// Security review of 1.13.0, finding 9: a publication release audit that timed out stopped the shared audit
// worker, and the worker's exit then failed every other audit waiting on it — one runaway release took down
// the others asked for at the same time. Now only the audit that timed out is refused; the ones queued behind
// it on the same worker are sent to a new worker and answered.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '6'.repeat(64);
process.env.SUDS_INDEX_KEY = '7'.repeat(64);
const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const PR = require('../server/publication-release');

// The audit worker and its backstop timer are unreferenced (they never keep a server alive), so the test
// holds the event loop open itself while it waits for them.
const keepAlive = setInterval(() => {}, 1000);
after(() => { clearInterval(keepAlive); PR._setWorkerForTests({}); });

test('a hanging audit is refused on its own; the audits queued behind it still get their answers', async () => {
  PR._setWorkerForTests({ script: path.join(__dirname, 'fixtures', 'hanging-audit-worker.js'), backstop: 400 });
  const warn = console.warn; const warned = []; console.warn = (m) => warned.push(String(m));
  try {
    const first = PR.runAudit({ n: 1, delay: 10 }, 11);
    const hung = PR.runAudit({ hang: true }, 11);
    const behind = [PR.runAudit({ n: 2 }, 11), PR.runAudit({ n: 3 }, 11)];
    assert.deepEqual(await first, { echo: 1 }, 'the audit before it is answered');
    const r = await hung;
    assert.equal(r.refused.backstop, true, 'the hanging one is refused by the backstop');
    const rest = await Promise.allSettled(behind);
    assert.deepEqual(rest.map(x => x.status), ['fulfilled', 'fulfilled'], `the ones queued behind it are not failed with it: ${JSON.stringify(rest.map(x => x.reason && x.reason.message))}`);
    assert.deepEqual(rest.map(x => x.value), [{ echo: 2 }, { echo: 3 }]);
    assert.ok(warned.some(m => /moved to a new worker/.test(m)), 'the log says the others were moved');
    // And the next audit runs normally.
    assert.deepEqual(await PR.runAudit({ n: 4 }, 11), { echo: 4 });
  } finally { console.warn = warn; }
});

test('two hanging audits are each refused, and the one after them is still answered', async () => {
  PR._setWorkerForTests({ script: path.join(__dirname, 'fixtures', 'hanging-audit-worker.js'), backstop: 300 });
  const warn = console.warn; console.warn = () => {};
  try {
    const a = PR.runAudit({ hang: true }, 11), b = PR.runAudit({ hang: true }, 11), c = PR.runAudit({ n: 9 }, 11);
    assert.equal((await a).refused.backstop, true);
    assert.equal((await b).refused.backstop, true);
    assert.deepEqual(await c, { echo: 9 });
  } finally { console.warn = warn; }
});

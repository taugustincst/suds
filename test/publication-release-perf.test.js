'use strict';
// A publication release for a year of a 5,000-person programme - the funder report, the NDP log and the
// settlement report read and audited together (server/publication-release.js) - with small groups in it for
// the audit to work on.
//
// The audit's budget is counted in solver work, not time (server/sdc.js STEP_LIMIT), so what it publishes
// depends on the figures alone: these tests assert the work it takes, which is the same on an idle laptop and
// a loaded CI runner. Wall-clock bounds are checked only in the `thorough` job (SUDS_THOROUGH=1), generously,
// and the event loop is checked relative to the audit: the audit runs in a worker thread, so a request made
// while a year's release is audited is answered in a fraction of the audit's time.
const THOROUGH = process.env.SUDS_THOROUGH === '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const scale = require('./fixtures/funder-scale');
const { uuid } = require('../server/crypto');
const SDC = require('../server/sdc');

const YEAR = 'from=2025-07-01&to=2026-06-30';
const PUB = '&purpose=publication';
let admin;
before(async () => {
  await H.start();
  const fx = scale.seed(H.db, { clients: 5000, visits: 25000, calls: 5000, notes: 0, seedValue: 23 });
  // A settlement fund; a second one no longer active with four people; a few small groups.
  H.db.run(`UPDATE funding_sources SET source_type='opioid_settlement', settlement_use='treatment' WHERE id=?`, fx.funds[0]);
  const old = uuid();
  H.db.run(`INSERT INTO funding_sources(id,name,source_type,settlement_use,fiscal_year_start,fiscal_year_end,total_amount,is_active) VALUES(?,?,?,?,?,?,?,0)`, old, 'Old settlement', 'opioid_settlement', 'naloxone', '2025-07-01', '2026-06-30', 1000);
  const ids = H.db.all(`SELECT id FROM clients WHERE deleted_at IS NULL ORDER BY client_code LIMIT 12`).map(x => x.id);
  ids.slice(0, 4).forEach((id, i) => H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,funding_source_id) VALUES(?,?,?,?,?,?,?)`, uuid(), id, fx.userId, 'outreach', `2025-09-0${i + 1}T18:00:00.000Z`, 30, old));
  ids.slice(4, 7).forEach(id => H.db.run(`UPDATE clients SET gender='two_spirit' WHERE id=?`, id));
  ids.slice(7, 9).forEach(id => H.db.run(`UPDATE clients SET preferred_language='Russian' WHERE id=?`, id));
  for (let i = 0; i < 3; i++) H.db.run(`INSERT INTO overdose_events(id,occurred_at,kind,naloxone_used,naloxone_doses,administered_by,survived) VALUES(?,?,?,?,?,?,?)`, uuid(), `2026-02-1${i}T12:00:00Z`, 'reversal', 1, 1, 'pharmacist', 1);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
});
after(async () => { await H.stop(); });

/** The release's figures, read as release() reads them. */
function inputsOf(ctx, r, counting) {
  const FR = require('../server/funder-report'); const HR = require('../server/harm-reduction-reports'); const O = require('../server/options'); const PR = require('../server/publication-release');
  const { raw, perFund } = FR.runSync(FR.figures(ctx, r, null, { fold: counting.threshold }));
  return { funder: raw, perFund, settlement: HR.settlementFigures(r), domains: { months: PR.monthsOf(r.from, r.to), administered_by: O.known('ADMINISTERED_BY'), discharge_reasons: O.known('DISCHARGE_REASONS') } };
}
/** The longest the event loop was held while fn ran (a 5 ms timer, and how late each tick came). */
async function maxStall(fn) {
  let last = process.hrtime.bigint(); let worst = 0;
  const t = setInterval(() => { const now = process.hrtime.bigint(); worst = Math.max(worst, Number(now - last) / 1e6 - 5); last = now; }, 5);
  try { await fn(); await new Promise((resolve) => setTimeout(resolve, 20)); } finally { clearInterval(t); }
  return worst;
}

test('a year\'s publication release for 5,000 people: its audit\'s work is bounded, and the server keeps answering while it runs', async () => {
  const { range } = require('../server/routes/reports');
  const FR = require('../server/funder-report');
  const PR = require('../server/publication-release');
  const user = H.db.one(`SELECT * FROM users WHERE username='admin'`);
  const ctx = { user, query: new URLSearchParams(YEAR + PUB) };
  const r = range(ctx);
  const counting = FR.countingMode(ctx, r);
  assert.equal(counting.purpose, 'publication');
  // The audit's work, deterministic: the same figures take the same work, well inside the budget.
  const inputs = inputsOf(ctx, r, counting);
  const a = PR.protectFigures(inputs, counting.threshold); const b = PR.protectFigures(inputs, counting.threshold);
  assert.ok(!a.refused, JSON.stringify(a.refused));
  assert.equal(a.audit.steps, b.audit.steps, 'the same figures take the same work');
  assert.equal(a.id, b.id);
  assert.ok(a.audit.steps < SDC.STEP_LIMIT / 4, `the audit took ${a.audit.steps} of ${SDC.STEP_LIMIT} units of work`);
  // Through release(): read, then audited in the worker thread. Each run reads and audits afresh.
  const times = []; let rel;
  for (let k = 0; k < 3; k++) { PR.clearCache(); const t = process.hrtime.bigint(); rel = await PR.release(ctx, r, counting); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const ms = times.sort((x, y) => x - y)[1];
  if (THOROUGH) assert.ok(ms < 4000, `the release took ${ms.toFixed(0)} ms`);
  assert.equal(rel.id, a.id, 'the worker audits exactly what the pure function does');
  // The small groups are there and hidden.
  assert.equal(rel.funder.demographics.by_gender.find(x => x.k === 'two_spirit').n, '<11');
  assert.equal(rel.funder.overdose.by_administered_by.find(x => x.k === 'pharmacist').n, '<11');
  assert.equal(rel.settlement.services_by_use.find(x => x.use_code === 'naloxone').people, '<11');
  // The event loop while the audit runs: in the worker, it is held only while the figures are read, not for
  // the audit; inline (as in the browser kernel), for the whole of it.
  PR.clearCache();
  let auditMs = 0;
  const workerStall = await maxStall(async () => { const t = Date.now(); await PR.release(ctx, r, counting); auditMs = Date.now() - t; });
  process.env.SUDS_AUDIT_INLINE = '1'; PR.clearCache();
  let inlineStall;
  try { inlineStall = await maxStall(() => PR.release(ctx, r, counting)); } finally { delete process.env.SUDS_AUDIT_INLINE; }
  if (process.env.SUDS_PERF_VERBOSE) console.log(`[perf] publication release, 5,000 clients, 12 months: ${times.map(x => x.toFixed(0)).join(', ')} ms; audit work ${a.audit.steps} units; longest event-loop stall ${workerStall.toFixed(0)} ms in the worker, ${inlineStall.toFixed(0)} ms inline (release ${auditMs} ms)`);
  assert.ok(workerStall < inlineStall, `the worker holds the event loop less than the inline audit (${workerStall.toFixed(0)} vs ${inlineStall.toFixed(0)} ms)`);
  // And the three endpoints serve it, the same release.
  const [f, n, s] = await Promise.all(['funder', 'naloxone-ndp', 'opioid-settlement'].map(p => admin.get(`/api/reports/${p}?${YEAR}${PUB}`)));
  for (const x of [f, n, s]) { assert.equal(x.status, 200); assert.equal(x.data.release.id, rel.id); }
});

test('800 small free-text languages and 400 small race codes: the release is audited within a small part of its budget, and served once for all three reports', async () => {
  // An import that wrote hundreds of one-off values (1.12.2: K=800 languages over 20,000 people took 19.9 s
  // of audit, run once per report). A release lists FOLD_KEEP of them and combines the rest.
  const { range } = require('../server/routes/reports');
  const FR = require('../server/funder-report');
  const PR = require('../server/publication-release');
  const ids = H.db.all(`SELECT id FROM clients WHERE deleted_at IS NULL ORDER BY client_code LIMIT 3200 OFFSET 20`).map(x => x.id);
  H.db.transaction(() => {
    ids.slice(0, 2400).forEach((id, i) => H.db.run(`UPDATE clients SET preferred_language=? WHERE id=?`, `lang${String(i % 800).padStart(3, '0')}`, id));
    ids.slice(2400).forEach((id, i) => H.db.run(`UPDATE clients SET race_codes=? WHERE id=?`, `code${String(i % 400).padStart(3, '0')},white`, id));
  });
  const user = H.db.one(`SELECT * FROM users WHERE username='admin'`);
  const ctx = { user, query: new URLSearchParams(YEAR + PUB) };
  const r = range(ctx); const counting = FR.countingMode(ctx, r);
  PR.clearCache();
  const inputs = inputsOf(ctx, r, counting); const raw = inputs.funder;
  for (const k of ['by_language', 'by_race_code']) assert.ok(raw.demographics[k].filter(x => x.n < counting.threshold).length <= FR.FOLD_KEEP + 1, k);
  assert.ok(raw.demographics.by_language.some(x => x.k === FR.FOLDED));
  let t = process.hrtime.bigint();
  const p = PR.protectFigures(inputs, counting.threshold);
  const auditMs = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(!p.refused, JSON.stringify(p.refused));
  // The audit, and the check of every hidden cell against the method (worlds run through it again, 1.12.4).
  assert.ok(p.audit.steps < SDC.STEP_LIMIT / 4, `the audit took ${p.audit.steps} of ${SDC.STEP_LIMIT} units of work`);
  if (THOROUGH) assert.ok(auditMs < 3000, `the audit took ${auditMs.toFixed(0)} ms`);
  // Read and audited, all three reports: the audit runs once.
  t = process.hrtime.bigint();
  const [f, n, s] = await Promise.all(['funder', 'naloxone-ndp', 'opioid-settlement'].map(q => admin.get(`/api/reports/${q}?${YEAR}${PUB}`)));
  const allMs = Number(process.hrtime.bigint() - t) / 1e6;
  for (const x of [f, n, s]) { assert.equal(x.status, 200); assert.equal(x.data.release.id, f.data.release.id); }
  if (THOROUGH) assert.ok(allMs < 8000, `three reports took ${allMs.toFixed(0)} ms`);
  if (process.env.SUDS_PERF_VERBOSE) console.log(`[perf] 800 small languages, 400 small race codes: audit ${auditMs.toFixed(0)} ms, ${p.audit.steps} units of work; three reports ${allMs.toFixed(0)} ms`);
});

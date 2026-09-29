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
let admin; let base;
before(async () => {
  base = await H.start();
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

test('a year with 60 funds (120 in the thorough run), most of them small: the small ones are combined and the release publishes its headline within a small part of its budget', async () => {
  // 1.13.0 refused the year's release with 60, 80 or 120 small funds: every fund under the threshold was a cell
  // of the audit, with the counts worked out from it, and the audit reached its budget (an engineering review's
  // benchmark: 40 funds took 45% of it). A release now combines every fund with 1 to T-1 people in one row that
  // prints no people or services (server/funder-report.js foldFunds).
  const { range } = require('../server/routes/reports');
  const FR = require('../server/funder-report');
  const PR = require('../server/publication-release');
  const COUNT = THOROUGH ? 117 : 57; // with the three large funds, 120 or 60
  const uses = ['core_a', 'core_b', 'core_c', 'core_d', 'approved_a', 'approved_b', 'approved_c'];
  const visits = H.db.all(`SELECT id FROM interventions WHERE client_id IS NOT NULL AND occurred_at >= '2025-07-02' AND occurred_at < '2026-06-29' ORDER BY id`);
  let vi = 0;
  H.db.transaction(() => {
    for (let i = 0; i < COUNT; i++) {
      // 2 to 14 people each (most under 11); half of them settlement funds over seven allowable uses.
      const id = uuid(); const settle = i % 2 === 0;
      H.db.run(`INSERT INTO funding_sources(id,name,source_type,settlement_use,fiscal_year_start,fiscal_year_end,total_amount) VALUES(?,?,?,?,?,?,?)`, id, `Small fund ${String(i).padStart(3, '0')}`, settle ? 'opioid_settlement' : 'other', settle ? uses[i % uses.length] : null, '2025-07-01', '2026-06-30', 5000);
      for (let k = 0; k < 2 + (i * 7) % 13; k++) H.db.run(`UPDATE interventions SET funding_source_id=? WHERE id=?`, id, visits[vi++ % visits.length].id);
    }
  });
  const user = H.db.one(`SELECT * FROM users WHERE username='admin'`);
  // A request on a connection of its own (node:http, no agent): the audit below holds this process - client and
  // server both - for seconds, past the server's keep-alive timeout, and a pooled connection the server closes
  // meanwhile is reset under the next request (a harness effect, not the server's).
  const once = (method, p, body, cookie) => new Promise((resolve, reject) => {
    const r = require('node:http').request(base + p, { method, agent: false, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject); r.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const login = await once('POST', '/api/auth/login', { username: 'admin', password: 'AdminPassw0rd!x' });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const fresh = (p) => once('GET', p, undefined, cookie);
  for (const q of THOROUGH ? [YEAR, 'from=2026-01-01&to=2026-03-31'] : [YEAR]) {
    const ctx = { user, query: new URLSearchParams(q + PUB) };
    const r = range(ctx); const counting = FR.countingMode(ctx, r); const T = counting.threshold;
    const inputs = inputsOf(ctx, r, counting);
    const active = new Set(H.db.all(`SELECT id FROM funding_sources WHERE is_active=1`).map(x => x.id));
    const smallFunds = [...inputs.perFund].filter(([id, x]) => active.has(id) && x.clients_served > 0 && x.clients_served < T).length;
    const t = process.hrtime.bigint();
    const p = PR.protectFigures(inputs, T);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(!p.refused, `${q}: ${JSON.stringify(p.refused)}`);
    // The headline is published; nothing is withheld but, at most, the fund tables.
    assert.equal(typeof p.funder.unduplicated.served, 'number');
    // (and the overdose events by month, by the published rule when a month has 1 to T-1 events or not reversed: 1.16.1)
    assert.ok(p.withheld_tables.every(x => ['by_funding_source', 'settlement.services_by_use', 'overdose.by_month.n'].includes(x)), `${q}: withheld ${p.withheld_tables}`);
    // Every small fund is in the combined row, which prints no count of people or services.
    const row = p.funder.by_funding_source.find(f => f.combined);
    assert.ok(smallFunds > 10 && row && row.funds_combined === smallFunds, `${q}: ${smallFunds} small funds, combined ${row && row.funds_combined}`);
    assert.equal(row.clients_served, 'withheld'); assert.equal(row.services, 'withheld');
    assert.ok(!p.funder.by_funding_source.some(f => !f.combined && f.clients_served === `<${T}`), 'no small fund is listed on its own');
    // The data also hold the 800 languages and 400 race codes of the test before (combined): within half the budget.
    assert.ok(p.audit.steps < SDC.STEP_LIMIT / 2, `${q}: the audit took ${p.audit.steps} of ${SDC.STEP_LIMIT} units of work`);
    if (THOROUGH) assert.ok(ms < 10000, `${q}: the audit took ${ms.toFixed(0)} ms (${p.audit.steps} units of work)`);
    // Through the API, all three reports: one release (each on a connection of its own, above).
    PR.clearCache();
    const [f, n, s] = await Promise.all(['funder', 'naloxone-ndp', 'opioid-settlement'].map(x => fresh(`/api/reports/${x}?${q}${PUB}`)));
    for (const x of [f, n, s]) { assert.equal(x.status, 200, JSON.stringify(x.data).slice(0, 300)); assert.equal(x.data.release.id, f.data.release.id); }
    assert.equal(f.data.release.id, p.id);
    // The page and the files say so, and the row is on the page.
    assert.match(f.data.counting_statement, /listed together in one row, "Other funds"/);
    assert.equal(f.data.by_funding_source.find(x => x.combined).funds_combined, smallFunds);
    if (process.env.SUDS_PERF_VERBOSE) console.log(`[perf] ${COUNT + 3} funds (${smallFunds} small, combined), ${q}: audit ${ms.toFixed(0)} ms, ${p.audit.steps} units of work, withheld ${JSON.stringify(p.withheld_tables)}`);
  }
});

test('a year of a 2,000-client programme is refused whole within the budget, as in 1.16.0 (1.16.2 withdrew 1.16.1\'s rule)', () => {
  // The benchmark's small programme (test/fixtures/release-small-programme.json): three months with 1, 2 and 3
  // overdose events not reversed. The check fails for the months after trying every candidate world, and the
  // degrade step, which re-runs that check for each world it tries, runs out of budget. 1.16.1 published it by
  // withholding the events by month by a rule whose check leaked (test/publication-release.test.js, "the
  // reviewer's case against 1.16.1's rule"); checked soundly the rule cost more than the budget here too, so it
  // was withdrawn. A refusal is safe; raising the budget fourfold does not help (docs/PERFORMANCE.md).
  const RA = require('../server/release-audit');
  const { T, inputs } = require('./fixtures/release-small-programme.json');
  const p = RA.protectFigures({ ...inputs, perFund: new Map(inputs.perFund) }, T);
  assert.ok(p.refused, 'refused');
  assert.equal(p.refused.out_of_budget, true);
  assert.equal(p.funder, undefined, 'nothing printed');
  assert.equal(p.audit.rounds, 2);
  assert.deepEqual(p.audit.degraded, ['overdose.by_month.n'], 'the degrade step found the table, and could not afford to check without it');
  assert.ok(p.audit.steps <= SDC.STEP_LIMIT * 1.01, `the audit took ${p.audit.steps} of ${SDC.STEP_LIMIT} units of work`);
  assert.match(p.refused.message, /A year is the longest standard period/);
});

test('a refusal for want of budget is logged with the audit\'s work, and a refused year is not told to publish a longer period (1.16.1)', async () => {
  const PR = require('../server/publication-release');
  const warn = console.warn; const lines = [];
  console.warn = (...a) => { lines.push(a.join(' ')); };
  PR.setAuditOptions({ stepLimit: 1e5 });
  try {
    const r = await admin.get(`/api/reports/funder?${YEAR}${PUB}`);
    assert.equal(r.status, 422);
    assert.match(r.data.error, /reached its limit/);
    assert.match(r.data.error, /A year is the longest standard period/);
    assert.ok(!/Publish a longer standard period/.test(r.data.error));
  } finally { console.warn = warn; PR.setAuditOptions({}); }
  assert.ok(lines.some(l => /a publication release \(2025-07 to 2026-06\) was refused: its audit reached its budget \(\{"steps":\d+,"rounds":\d/.test(l)), lines.join('\n'));
  const RA = require('../server/release-audit');
  assert.match(RA.refusalMessage({ outOfBudget: true }, 1), /Publish a longer standard period \(a quarter or a year\)/);
  // 1.16.3: a refused year says what the person can do, not only whom to tell. 1.16.4 (market review of 1.16.3): it
  // does not promise the quarters will publish, and a refused quarter no longer sends the person back to the year it
  // came from without an end: each message has the step after it, and whom to tell.
  const year = RA.refusalMessage({ outOfBudget: true }, 12);
  assert.match(year, /Its four quarters may be tried instead/);
  assert.match(year, /each is checked on its own and may be refused too/);
  assert.ok(!/You can publish its four quarters/.test(year), 'the year does not promise its quarters publish');
  assert.match(year, /Never publish a quarter beside its year/);
  assert.match(year, /If the quarters are refused as well, this year cannot be published in this version of SUDS/);
  const quarter = RA.refusalMessage({}, 3);
  assert.match(quarter, /the check could not confirm that every small count in it is protected/);
  assert.ok(!/Publish a longer standard period/.test(quarter), 'a refused quarter is not simply told to publish the year');
  assert.match(quarter, /Its fiscal year may be tried instead once the year has ended, unless the year was refused too or another quarter of it is already published/);
  assert.match(quarter, /Otherwise this quarter cannot be published in this version of SUDS/);
  for (const m of [year, quarter]) {
    assert.match(m, /tell whoever supports your SUDS \(your IT partner or county\)/);
    assert.match(m, /https:\/\/github\.com\/taugustincst\/suds\/issues \(the period and this message only, never a client's details\)/);
    assert.match(m, /submission to its funder, which is not for publication, is unaffected/);
  }
});

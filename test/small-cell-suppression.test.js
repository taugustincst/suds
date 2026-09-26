'use strict';
// Small-cell suppression in every report labelled suitable for publication or sharing: the funder report,
// the NDP log and the opioid settlement report (server/small-cells.js; docs/HIPAA.md "Small cells in
// aggregate reports"). Every cell counting fewer people than the threshold is suppressed (primary), and
// wherever a suppressed cell could be worked out by subtracting the visible cells from a published total
// another cell is suppressed with it (complementary). Counts of things — kits, doses, test strips,
// services, hours, money — are not counts of people and stay exact.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PERIOD = 'from=2026-03-01&to=2026-04-30';
const EXACT = '&purpose=submission&counts=exact';
let admin, sup, ro, alpha, beta;

before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  H.makeUser('scsup', 'supervisor'); H.makeUser('scro', 'readonly');
  sup = H.client(); await sup.login('scsup', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('scro', 'StaffPassw0rd!x');
  alpha = (await admin.post('/api/budget/funds', { name: 'Alpha fund', fiscal_year_start: '2025-07-01', fiscal_year_end: '2026-06-30', total_amount: 1000 })).data.id;
  beta = (await admin.post('/api/budget/funds', { name: 'Beta settlement', source_type: 'opioid_settlement', fiscal_year_start: '2025-07-01', fiscal_year_end: '2026-06-30', total_amount: 1000 })).data.id;
  // Fifteen people: thirteen men and two women; three of them were also served under the Beta fund.
  const ids = [];
  for (let i = 0; i < 15; i++) {
    const c = await admin.post('/api/clients', { first_name: `Small${i}`, last_name: 'Cell', gender: i < 13 ? 'male' : 'female', confirm_duplicate: true });
    assert.equal(c.status, 201, JSON.stringify(c.data)); ids.push(c.data.id);
    assert.equal((await admin.post('/api/interventions', { client_id: c.data.id, type: 'outreach', occurred_at: '2026-03-10T18:00:00.000Z', funding_source_id: alpha })).status, 201);
    if (i < 3) assert.equal((await admin.post('/api/interventions', { client_id: c.data.id, type: 'outreach', occurred_at: '2026-03-11T18:00:00.000Z', funding_source_id: beta, naloxone_kits: 2 })).status, 201);
  }
  // Fourteen episodes closed in the period: twelve completed, two moved away.
  for (let i = 0; i < 14; i++) H.db.run(`INSERT INTO episodes(id,client_id,opened_at,closed_at,status,discharge_reason) VALUES(?,?,?,?,?,?)`, require('node:crypto').randomUUID(), ids[i], '2026-03-01', '2026-03-20', 'closed', i < 12 ? 'completed' : 'moved');
  // Eleven reversals on one day at one site by staff, and one in April reported by a bystander; three
  // overdoses with no naloxone.
  for (let i = 0; i < 11; i++) assert.equal((await admin.post('/api/overdose-events', { occurred_at: '2026-03-05T10:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 1, administered_by: 'staff', survived: true, location_type: 'field' })).status, 201);
  assert.equal((await admin.post('/api/overdose-events', { occurred_at: '2026-04-02T10:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 2, administered_by: 'bystander', survived: true, location_type: 'community' })).status, 201);
  for (const at of ['2026-03-06T10:00:00Z', '2026-03-07T10:00:00Z', '2026-04-03T10:00:00Z']) assert.equal((await admin.post('/api/overdose-events', { occurred_at: at, kind: 'overdose', survived: true })).status, 201);
  await seedAttacks();
});
after(async () => { await H.stop(); });

const isNum = (v) => typeof v === 'number';
/**
 * The subtraction attack: with a published total and the visible cells, can any suppressed cell be worked
 * out? The attacker knows the rule, so a cell shown as "<T" lies between 1 and T-1, and a cell shown as
 * "suppressed" was not small (it would have shown "<T"), so it is at least T. (Doses used in a hidden reversal
 * row are not people and may be 0: `secondaryLo` 0.) A cell is exposed when its possible range is one value.
 */
function exposed(cells, total, T, secondaryLo = T) {
  const hidden = cells.filter(v => !isNum(v));
  if (!hidden.length) return false;
  if (!isNum(total)) return false; // a suppressed or unpublished total: nothing to subtract from
  const S = total - cells.filter(isNum).reduce((a, b) => a + b, 0);
  const lo = hidden.map(v => (v === `<${T}` ? 1 : secondaryLo)); const hi = hidden.map(v => (v === `<${T}` ? T - 1 : Infinity));
  return hidden.some((_, i) => {
    const othersLo = lo.reduce((a, b, j) => a + (j === i ? 0 : b), 0); const othersHi = hi.reduce((a, b, j) => a + (j === i ? 0 : b), 0);
    return Math.max(lo[i], S - othersHi) === Math.min(hi[i], S - othersLo);
  });
}
/** A breakdown with no published total: one suppressed cell beside visible ones still invites guessing from a related total. */
const lonely = (cells) => cells.filter(v => !isNum(v)).length === 1 && cells.some(v => isNum(v) && v > 0);

test('funder report: every count of people under the threshold is suppressed, in every table', async () => {
  const d = (await sup.get(`/api/reports/funder?${PERIOD}`)).data;
  assert.equal(d.suppression.mode, 'suppressed');
  const T = d.suppression.threshold;
  // People per fund: Beta served three people.
  const b = d.by_funding_source.find(f => f.id === beta);
  assert.equal(b.clients_served, `<${T}`, 'people per fund is a count of people');
  assert.equal(b.services, 3, 'services are counts of visits, not people, and stay exact');
  // Overdose events by month: April had two, and one reversal.
  const apr = d.overdose.by_month.find(x => x.month === '2026-04');
  assert.equal(apr.n, `<${T}`); assert.equal(apr.reversals, `<${T}`);
  // Discharge reasons, gender, who gave the naloxone.
  assert.equal(d.episodes.by_discharge_reason.find(x => x.k === 'moved').n, `<${T}`);
  assert.equal(d.demographics.by_gender.find(x => x.k === 'female').n, `<${T}`);
  assert.equal(d.overdose.by_administered_by.find(x => x.k === 'bystander').n, `<${T}`);
  // Headline counts of people under the threshold, and nothing that is a count of people left exact below it.
  const T_ = (v) => isNum(v) && v > 0 && v < T;
  for (const [k, v] of Object.entries(d.unduplicated)) assert.ok(!T_(v), `unduplicated.${k} = ${v}`);
  for (const k of ['events', 'reversals', 'fatal', 'community_reported']) assert.ok(!T_(d.overdose[k]), `overdose.${k} = ${d.overdose[k]}`);
  for (const k of ['admissions', 'discharges', 'open_at_end']) assert.ok(!T_(d.episodes[k]), `episodes.${k}`);
  for (const f of d.by_funding_source) assert.ok(!T_(f.clients_served), `${f.name} people`);
  assert.ok(!T_(d.attribution.unattributed_clients));
  for (const rows of Object.values(d.demographics)) for (const x of rows) assert.ok(!T_(x.n), `${x.k}`);
  // Kits and strips are not people.
  assert.equal(d.naloxone_distribution.kits, 6);
  assert.match(d.counting_statement, /complementary|so that it cannot be worked out/i);
});

test('funder report: no suppressed cell can be recovered as total minus the visible cells', async () => {
  for (const q of [PERIOD, `${PERIOD}&funding_source_id=${beta}`, `${PERIOD}&funding_source_id=${alpha}`]) {
    const d = (await sup.get(`/api/reports/funder?${q}`)).data; const T = d.suppression.threshold;
    const tables = [
      ...['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity'].map(k => [k, d.demographics[k].map(x => x.n), d.unduplicated.served]),
      ['by_discharge_reason', d.episodes.by_discharge_reason.map(x => x.n), d.episodes.discharges],
      ['by_month.n', d.overdose.by_month.map(x => x.n), d.overdose.events],
      ['by_month.reversals', d.overdose.by_month.map(x => x.reversals), d.overdose.reversals],
      // Who gave the naloxone, in each reversal: adds up to the reversals.
      ['by_administered_by', d.overdose.by_administered_by.map(x => x.n), d.overdose.reversals],
    ];
    for (const [name, cells, total] of tables) assert.ok(!exposed(cells, total, T), `${q} ${name}: ${JSON.stringify(cells)} total ${total}`);
    for (const [name, cells] of [['by_race_code', d.demographics.by_race_code.map(x => x.n)], ['people per fund', d.by_funding_source.map(f => f.clients_served)]]) {
      assert.ok(!lonely(cells), `${q} ${name}: ${JSON.stringify(cells)}`);
    }
  }
  // The same data in the exported file: the "Who was served" rows carry the same suppressed values.
  const csv = String((await sup.get(`/api/reports/funder/export?${PERIOD}&format=csv`)).data);
  assert.ok(!/Discharge reason,moved,2\b/.test(csv), 'the export is suppressed too');
});

test('funder report: exact counts are unchanged for the programme\'s own submission', async () => {
  const d = (await sup.get(`/api/reports/funder?${PERIOD}${EXACT}`)).data;
  assert.equal(d.by_funding_source.find(f => f.id === beta).clients_served, 3);
  assert.deepEqual(d.overdose.by_month.map(x => [x.month, x.n, x.reversals]), [['2026-03', 13, 11], ['2026-04', 2, 1]]);
  assert.equal(d.episodes.by_discharge_reason.find(x => x.k === 'moved').n, 2);
  assert.equal(d.demographics.by_gender.find(x => x.k === 'female').n, 2);
  assert.equal(d.overdose.reversals, 12);
  assert.equal((await ro.get(`/api/reports/funder?${PERIOD}${EXACT}`)).status, 403);
});

test('NDP log: reversal rows are suppressed, complementary cells too; a read-only account runs publication releases only', async () => {
  // Two months is not a standard period, so this run is internal: refused to a read-only account, whose
  // figures could otherwise be subtracted from a release (test/report-access.test.js).
  assert.equal((await ro.get(`/api/reports/naloxone-ndp?${PERIOD}`)).status, 403);
  for (const c of [sup]) {
    const d = (await c.get(`/api/reports/naloxone-ndp?${PERIOD}`)).data; const T = d.suppression.threshold;
    assert.equal(d.suppression.mode, 'suppressed');
    const rev = d.rows.filter(r => r.entry === 'reversal');
    assert.equal(rev.length, 2);
    for (const r of rev) assert.ok(!isNum(r.reversals), `every reversal row is hidden: one is under ${T}, the other would give it away (${JSON.stringify(r)})`);
    assert.ok(!exposed(rev.map(r => r.reversals), d.totals.reversals, T), 'reversals');
    assert.ok(!exposed(rev.map(r => r.reversal_doses), d.totals.reversal_doses, T, 0), 'doses used in the suppressed reversals');
    assert.equal(d.totals.kits, 6, 'kits are not people');
    assert.match(d.counting_statement, /Small cells suppressed/);
  }
  assert.equal((await ro.get(`/api/reports/naloxone-ndp?${PERIOD}${EXACT}`)).status, 403, 'read-only cannot switch suppression off');
  const exact = (await sup.get(`/api/reports/naloxone-ndp?${PERIOD}${EXACT}`)).data;
  assert.deepEqual(exact.rows.filter(r => r.entry === 'reversal').map(r => r.reversals).sort(), [1, 11]);
  assert.equal(exact.suppression.mode, 'exact');
  const csv = await sup.get(`/api/reports/naloxone-ndp/export?${PERIOD}&format=csv`);
  assert.match(csv.headers.get('x-suds-report-counts'), /suppressed/);
  assert.match(csv.headers.get('content-disposition'), /suppressed/);
  assert.ok(!/Reversal reported,[^\n]*,1,2,/.test(String(csv.data)), 'the export is suppressed');
});

test('opioid settlement report: people per allowable use are suppressed, services and kits are not', async () => {
  const d = (await sup.get(`/api/reports/opioid-settlement?${PERIOD}`)).data;
  const row = d.services_by_use[0];
  assert.equal(row.people, `<${d.suppression.threshold}`);
  assert.equal(row.services, 3); assert.equal(row.naloxone_kits, 6);
  assert.equal((await sup.get(`/api/reports/opioid-settlement?${PERIOD}${EXACT}`)).data.services_by_use[0].people, 3);
});

test('the complementary suppression rule on its own', () => {
  const S = require('../server/small-cells');
  // One small cell and a published total: the next-smallest cell goes too.
  let t = S.table([{ n: 13 }, { n: 2 }, { n: 20 }], ['n'], { threshold: 11, totals: { n: 35 } });
  assert.deepEqual(t.rows.map(r => r.n), ['suppressed', '<11', 20]);
  // Two ones under a total that gives them away (35 - 33 = 2 = two cells of at least 1): a third goes.
  t = S.table([{ n: 1 }, { n: 1 }, { n: 33 }], ['n'], { threshold: 11, totals: { n: 35 } });
  assert.ok(!exposed(t.rows.map(r => r.n), t.totals.n, 11), JSON.stringify(t));
  // A total that is itself small is suppressed; nothing to subtract from.
  t = S.table([{ n: 1 }, { n: 2 }], ['n'], { threshold: 11, totals: { n: 3 } });
  assert.equal(t.totals.n, '<11');
  // Zero stays zero; exact mode changes nothing.
  t = S.table([{ n: 0 }, { n: 30 }], ['n'], { threshold: 11, totals: { n: 30 } });
  assert.deepEqual(t.rows.map(r => r.n), [0, 30]);
  t = S.table([{ n: 2 }, { n: 30 }], ['n'], { threshold: 11, totals: { n: 32 }, exact: true });
  assert.deepEqual(t.rows.map(r => r.n), [2, 30]);
});

// ---- one publication release, attacked with everything it publishes ----
// The people served are one marginal shared by many tables: the total; five single-valued breakdowns
// (gender, language, housing, insurance, ethnicity), each adding up to it; counts of some of those people
// (on MAT, referred, admitted, each fund, the "No funding source" row), each of which leaves a complement
// (the rest) that nobody printed but anyone can work out; and the race codes, each such a subset, which
// together add up to at least the total (everyone has at least one, if only "unknown").
const PARTS = ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity'];
const view = (d) => ({
  total: d.unduplicated.served,
  partitions: PARTS.map(k => d.demographics[k].map(x => x.n)),
  subsets: [d.unduplicated.on_mat, d.unduplicated.with_a_referral, d.unduplicated.admitted_after_referral, ...d.by_funding_source.map(f => f.clients_served)],
  cover: d.demographics.by_race_code.map(x => x.n),
});
/** The published release and the truth behind it, leaving out what the release withheld altogether. */
function views(pub, truth) {
  const p = view(pub); const t = view(truth); const gone = new Set(pub.withheld || []);
  const keepP = PARTS.map(k => !gone.has(k)); const keepS = p.subsets.map(v => v !== 'withheld');
  const trim = (v, cover) => ({ total: v.total, partitions: v.partitions.filter((_, g) => keepP[g]), subsets: v.subsets.filter((_, i) => keepS[i]), cover: gone.has('by_race_code') ? [] : cover });
  return [trim(p, p.cover), trim(t, t.cover)];
}
/** Every tuple of integers within bounds [[lo, hi]] that `ok(sum)` accepts, fed to `each(tuple)`. */
function tuples(bounds, ok, each, acc = [], sum = 0) {
  if (acc.length === bounds.length) { if (ok(sum)) each(acc); return; }
  const [lo, hi] = bounds[acc.length];
  for (let v = lo; v <= hi; v++) { acc.push(v); tuples(bounds, ok, each, acc, sum + v); acc.pop(); }
}
/**
 * Brute force: for every possible number of people served N (up to a cap well above the truth, which can
 * only make the attacker look stronger), every assignment of the hidden cells of each table that fits what
 * was published. Returns the sensitive values that have exactly one possible value: a "<T" cell, a "<T"
 * total, or the complement of a subset (N - s) when it is a small group of people (1 to T-1).
 */
function bruteForce(pub, truth, T) {
  const cap = truth.total + 2 * T + 2;
  const b = (shown, hi) => (isNum(shown) ? [shown, shown] : shown === `<${T}` ? [1, Math.min(T - 1, hi)] : [T, hi]);
  const seen = new Map(); const add = (k, v) => { if (!seen.has(k)) seen.set(k, new Set()); seen.get(k).add(v); };
  const [nlo, nhi] = b(pub.total, cap);
  for (let N = nlo; N <= Math.min(nhi, cap); N++) {
    const found = new Map(); const put = (k, v) => { if (!found.has(k)) found.set(k, new Set()); found.get(k).add(v); };
    let feasible = true;
    pub.partitions.forEach((p, g) => {
      let any = false;
      tuples(p.map(s => b(s, N)), (sum) => sum === N, (t) => { any = true; t.forEach((v, i) => put(`p${g}.${i}`, v)); });
      if (!any) feasible = false;
    });
    pub.subsets.forEach((s, i) => {
      const [lo, hi] = b(s, N); if (lo > hi) { feasible = false; return; }
      for (let v = lo; v <= hi; v++) { put(`s${i}`, v); put(`s${i}.rest`, N - v); }
    });
    let anyCover = false;
    tuples(pub.cover.map(s => b(s, N)), (sum) => sum >= N, (t) => { anyCover = true; t.forEach((v, i) => { put(`c${i}`, v); put(`c${i}.rest`, N - v); }); });
    if (pub.cover.length && !anyCover) feasible = false;
    if (!feasible) continue;
    add('total', N); for (const [k, vs] of found) for (const v of vs) add(k, v);
  }
  const out = [];
  const pinned = (k) => seen.has(k) && seen.get(k).size === 1;
  const small = (v) => v > 0 && v < T;
  if (pub.total === `<${T}` && pinned('total')) out.push(`total = ${truth.total}`);
  pub.partitions.forEach((p, g) => p.forEach((s, i) => { if (s === `<${T}` && pinned(`p${g}.${i}`)) out.push(`${PARTS[g]}[${i}] = ${truth.partitions[g][i]}`); }));
  pub.subsets.forEach((s, i) => {
    if (s === `<${T}` && pinned(`s${i}`)) out.push(`subset ${i} = ${truth.subsets[i]}`);
    if (small(truth.total - truth.subsets[i]) && pinned(`s${i}.rest`)) out.push(`the rest of subset ${i} = ${truth.total - truth.subsets[i]}`);
  });
  pub.cover.forEach((s, i) => {
    if (s === `<${T}` && pinned(`c${i}`)) out.push(`race code ${i} = ${truth.cover[i]}`);
    if (small(truth.total - truth.cover[i]) && pinned(`c${i}.rest`)) out.push(`the rest of race code ${i} = ${truth.total - truth.cover[i]}`);
  });
  return out;
}

// Two attacks found against 1.12.0, reproduced with data. January 2025: 34 people, 33 of them under fund A
// and one woman under fund B only. February 2025: 20 men, 10 stably housed and 10 homeless.
let fundA;
const JAN = 'from=2025-01-01&to=2025-01-31'; const FEB = 'from=2025-02-01&to=2025-02-28';
async function seedAttacks() {
  fundA = (await admin.post('/api/budget/funds', { name: 'Fund A', fiscal_year_start: '2024-07-01', fiscal_year_end: '2025-06-30', total_amount: 1000 })).data.id;
  const fundB = (await admin.post('/api/budget/funds', { name: 'Fund B', fiscal_year_start: '2024-07-01', fiscal_year_end: '2025-06-30', total_amount: 1000 })).data.id;
  const person = async (fields, at, fund) => {
    const c = await admin.post('/api/clients', { first_name: 'Diff', last_name: `Erence${Math.random()}`, confirm_duplicate: true, ...fields });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.equal((await admin.post('/api/interventions', { client_id: c.data.id, type: 'outreach', occurred_at: at, funding_source_id: fund })).status, 201);
  };
  for (let i = 0; i < 33; i++) await person({ gender: i < 20 ? 'male' : 'female' }, '2025-01-15T18:00:00.000Z', fundA);
  await person({ gender: 'female' }, '2025-01-16T18:00:00.000Z', fundB);
  for (let i = 0; i < 20; i++) await person({ gender: 'male', housing_status: i < 10 ? 'stable' : 'homeless' }, '2025-02-12T18:00:00.000Z', fundA);
}

test('attack 1, differencing: a fund-filtered or custom-period run is never a publication release', async () => {
  const whole = (await sup.get(`/api/reports/funder?${JAN}`)).data;
  assert.equal(whole.suppression.purpose, 'publication', 'a whole month that has ended, for the whole programme, is a publication release');
  assert.equal(whole.release.publishable, true); assert.equal(whole.release.period, 'month');
  // The fund-A run, which with the programme total gave away the one person (and her gender) under fund B only.
  const a = await sup.get(`/api/reports/funder?${JAN}&funding_source_id=${fundA}`);
  assert.equal(a.status, 200);
  assert.equal(a.data.suppression.purpose, 'internal', 'filtered to one fund, the run is internal');
  assert.match(a.data.counting_statement, /not for publication/i);
  assert.doesNotMatch(a.data.counting_statement, /Suitable for publication/i);
  assert.ok(a.data.release.not_publishable.some(x => /fund/i.test(x)), JSON.stringify(a.data.release));
  const asked = await sup.get(`/api/reports/funder?${JAN}&funding_source_id=${fundA}&purpose=publication`);
  assert.equal(asked.status, 400, 'asking for the publication label on a fund-filtered run is refused');
  assert.match(asked.data.error, /whole programme/i);
  // The same by two date ranges: January to June minus January to May.
  for (const q of ['from=2025-01-01&to=2025-06-30', 'from=2025-01-01&to=2025-05-31', 'from=2025-01-05&to=2025-01-31']) {
    assert.equal((await sup.get(`/api/reports/funder?${q}&purpose=publication`)).status, 400, `${q} is not a standard period`);
    const d = (await sup.get(`/api/reports/funder?${q}`)).data;
    assert.equal(d.suppression.purpose, 'internal', q); assert.match(d.counting_statement, /not for publication/i);
  }
  // Standard periods: a quarter and a fiscal year starting on a quarter; a period not yet over is not one.
  assert.equal((await sup.get('/api/reports/funder?from=2025-01-01&to=2025-03-31')).data.release.period, 'quarter');
  assert.equal((await sup.get('/api/reports/funder?from=2024-07-01&to=2025-06-30')).data.release.period, 'year');
  const today = new Date().toISOString().slice(0, 10); const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const open = (await sup.get(`/api/reports/funder?from=${monthStart}&to=${monthEnd}`)).data;
  assert.equal(open.suppression.purpose, 'internal', 'the current month has not ended: rerun tomorrow, it would give away today');
  assert.ok(open.release.not_publishable.some(x => /ended/i.test(x)));
  // Exact counts are never labelled for publication either; the funder's own submission still works.
  assert.equal((await sup.get(`/api/reports/funder?${JAN}&purpose=publication&counts=exact`)).status, 400);
  const sub = (await sup.get(`/api/reports/funder?${JAN}&funding_source_id=${fundA}&purpose=submission&counts=exact`)).data;
  assert.equal(sub.unduplicated.served, 33); assert.match(sub.counting_statement, /not for publication/i);
  // The publication release itself: fund A's 33 would leave "1 person not under fund A".
  assert.deepEqual(bruteForce(...views(whole, (await sup.get(`/api/reports/funder?${JAN}${EXACT}`)).data), whole.suppression.threshold), []);
  // The file says so too.
  const csv = String((await sup.get(`/api/reports/funder/export?${JAN}&funding_source_id=${fundA}&format=csv`)).data);
  assert.match(csv, /not for publication/i);
});

test('attack 2, one release: the total hidden too late is still printed by every complete breakdown', async () => {
  const d = (await sup.get(`/api/reports/funder?${FEB}`)).data; const T = d.suppression.threshold;
  assert.equal(d.suppression.purpose, 'publication');
  const truth = (await sup.get(`/api/reports/funder?${FEB}${EXACT}`)).data;
  assert.equal(truth.unduplicated.served, 20);
  assert.deepEqual(bruteForce(...views(d, truth), T), [], JSON.stringify(view(d)));
  // Housing cannot be protected while 20 is known, so the total is hidden, and so is every figure that would print it.
  assert.ok(!isNum(d.unduplicated.served));
  for (const k of PARTS) assert.ok(!d.demographics[k].every(x => isNum(x.n)), `${k} would add up to the hidden total: ${JSON.stringify(d.demographics[k])}`);
});

test('a total is kept visible when hiding more cells is enough', () => {
  const S = require('../server/small-cells');
  // 30 people: housing 12 / 2 / 16. Hiding 12 with the 2 protects it; the total and gender stay visible.
  const s = S.star({ total: 30, partitions: [[12, 2, 16], [30]] }, { threshold: 11 });
  assert.equal(s.total, 30); assert.deepEqual(s.partitions[0], ['suppressed', '<11', 16]); assert.deepEqual(s.partitions[1], [30]);
  // A cell shown "suppressed" is known to be at least the threshold: 11 and 1 under 12 left is not protected by 11 alone.
  const t = S.table([{ n: 20 }, { n: 11 }, { n: 1 }], ['n'], { threshold: 11, totals: { n: 32 } });
  assert.ok(!exposed(t.rows.map(r => r.n), t.totals.n, 11), JSON.stringify(t));
});

// A small seeded generator, so a failure can be replayed.
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
test('property: for random small programmes, nothing published in one release pins a suppressed count of people', () => {
  const FR = require('../server/funder-report');
  const r = rng(Number(process.env.SC_SEED) || 20260926);
  const pick = (xs, w) => { let u = r() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { u -= w[i]; if (u < 0) return xs[i]; } return xs[xs.length - 1]; };
  const count = (people, f) => { const m = new Map(); for (const p of people) for (const k of [].concat(f(p))) m.set(k, (m.get(k) || 0) + 1); return [...m].map(([k, n]) => ({ k, n })).sort((a, b) => (b.n - a.n) || String(a.k).localeCompare(String(b.k))); };
  let checked = 0;
  for (let run = 0; run < (Number(process.env.SC_RUNS) || 400); run++) {
    const T = 3 + Math.floor(r() * 3); const n = 1 + Math.floor(r() * 13);
    const skew = [1 + r() * 8, 1, r()];
    const people = Array.from({ length: n }, () => {
      const race = ['w', 'b', 'a'].filter(() => r() < 0.45);
      const funds = ['A', 'B', null].filter((_, i) => r() < [0.8, 0.3, 0.15][i]);
      return { gender: pick(['m', 'f', 'x'], skew), language: pick(['en', 'es'], [skew[0], 1]), housing: pick(['s', 'h', 'u'], [1, 1, r()]), insurance: pick(['a', 'b'], [skew[0], 1]),
        ethnicity: pick(['h', 'n', 'u'], skew), race: race.length ? race : ['unknown'], funds: funds.length ? funds : ['A'], mat: r() < 0.7, referred: r() < 0.6, admitted: r() < 0.4 };
    });
    const raw = {
      from: '2025-01-01', to: '2025-01-31', funding_source_id: null,
      unduplicated: { served: n, new_admissions: 0, with_a_referral: people.filter(p => p.referred).length, admitted_after_referral: people.filter(p => p.admitted).length, on_mat: people.filter(p => p.mat).length },
      demographics: { by_gender: count(people, p => p.gender), by_language: count(people, p => p.language), by_housing: count(people, p => p.housing), by_insurance: count(people, p => p.insurance), by_ethnicity: count(people, p => p.ethnicity), by_race_code: count(people, p => p.race) },
      episodes: { admissions: 0, discharges: 0, open_at_end: 0, by_discharge_reason: [], median_length_of_stay_days: null },
      overdose: { events: 0, reversals: 0, fatal: 0, community_reported: 0, naloxone_doses: 0, by_month: [], by_administered_by: [] },
      naloxone_distribution: { kits: 0, strips: 0, community_kits: 0 },
      by_funding_source: ['A', 'B', null].map(f => ({ id: f, name: f || 'No funding source', clients_served: people.filter(p => p.funds.includes(f)).length, services: 0, approved_minutes: 0, unapproved_minutes: 0 })),
      attribution: { unattributed_services: 0, unattributed_clients: 0, approved_minutes: 0, unapproved_minutes: 0 },
    };
    const pub = FR.suppress(JSON.parse(JSON.stringify(raw)), { threshold: T, exact: false });
    const leaks = bruteForce(...views(pub, raw), T);
    assert.deepEqual(leaks, [], `run ${run}, T=${T}: ${JSON.stringify(view(raw))} published as ${JSON.stringify(view(pub))}`);
    checked++;
  }
  assert.equal(checked, Number(process.env.SC_RUNS) || 400);
});

test('NDP log and settlement report: publication only for the whole programme and a standard period that has ended', async () => {
  const MARCH = 'from=2026-03-01&to=2026-03-31';
  for (const path of ['/api/reports/naloxone-ndp', '/api/reports/opioid-settlement']) {
    const custom = (await sup.get(`${path}?${PERIOD}`)).data;
    assert.equal(custom.suppression.purpose, 'internal', `${path}: a custom range is internal`);
    assert.match(custom.counting_statement, /not for publication/i);
    assert.equal((await sup.get(`${path}?${PERIOD}&purpose=publication`)).status, 400, `${path}: and cannot be labelled for publication`);
    const pub = (await sup.get(`${path}?${MARCH}`)).data;
    assert.equal(pub.suppression.purpose, 'publication', path);
    assert.match(pub.counting_statement, /Publication release — small cells screened; review before sharing/);
  }
  // Published, the NDP log is by month, and its reversals are the funder report's for the same release,
  // hidden the same way, so neither can be subtracted from the other.
  const ndp = (await sup.get(`/api/reports/naloxone-ndp?${MARCH}`)).data;
  for (const row of ndp.rows) assert.match(row.date, /^\d{4}-\d{2}$/, 'rows are months, not days');
  const funder = (await sup.get(`/api/reports/funder?${MARCH}`)).data;
  assert.deepEqual(ndp.rows.filter(x => x.entry === 'reversal').map(x => [x.date, x.reversals]), funder.overdose.by_month.filter(x => x.reversals !== 0).map(x => [x.month, x.reversals]));
  assert.deepEqual(ndp.totals.reversals, funder.overdose.reversals);
  // The day-by-day log is still there for the programme's own submission to the NDP.
  const own = (await sup.get(`/api/reports/naloxone-ndp?${MARCH}${EXACT}`)).data;
  assert.ok(own.rows.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date)));
  // A navigator's caseload-scoped run is never a publication release.
  H.makeUser('scnav', 'navigator'); const nav = H.client(); await nav.login('scnav', 'StaffPassw0rd!x');
  const n = (await nav.get(`/api/reports/naloxone-ndp?${MARCH}`)).data;
  assert.equal(n.suppression.purpose, 'internal'); assert.ok(n.release.not_publishable.some(x => /caseload/i.test(x)));
});

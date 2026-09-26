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
});
after(async () => { await H.stop(); });

const isNum = (v) => typeof v === 'number';
/**
 * The subtraction attack: with a published total and the visible cells, can any suppressed cell be worked
 * out? Suppressed cells shown as "<T" are known to lie between 1 and T-1; a cell suppressed only to protect
 * another is known to be at least 1. A cell is exposed when its possible range is a single value.
 */
function exposed(cells, total, T) {
  const hidden = cells.filter(v => !isNum(v));
  if (!hidden.length) return false;
  if (!isNum(total)) return false; // a suppressed or unpublished total: nothing to subtract from
  const S = total - cells.filter(isNum).reduce((a, b) => a + b, 0);
  const lo = hidden.map(() => 1); const hi = hidden.map(v => (v === `<${T}` ? T - 1 : Infinity));
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
    ];
    for (const [name, cells, total] of tables) assert.ok(!exposed(cells, total, T), `${q} ${name}: ${JSON.stringify(cells)} total ${total}`);
    for (const [name, cells] of [['by_race_code', d.demographics.by_race_code.map(x => x.n)], ['by_administered_by', d.overdose.by_administered_by.map(x => x.n)], ['people per fund', d.by_funding_source.map(f => f.clients_served)]]) {
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

test('NDP log: reversal rows are suppressed for publication, complementary cells too; a read-only account sees only that', async () => {
  for (const c of [ro, sup]) {
    const d = (await c.get(`/api/reports/naloxone-ndp?${PERIOD}`)).data; const T = d.suppression.threshold;
    assert.equal(d.suppression.mode, 'suppressed');
    const rev = d.rows.filter(r => r.entry === 'reversal');
    assert.equal(rev.length, 2);
    for (const r of rev) assert.ok(!isNum(r.reversals), `every reversal row is hidden: one is under ${T}, the other would give it away (${JSON.stringify(r)})`);
    assert.ok(!exposed(rev.map(r => r.reversals), d.totals.reversals, T), 'reversals');
    assert.ok(!exposed(rev.map(r => r.reversal_doses), d.totals.reversal_doses, T), 'doses used in the suppressed reversals');
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

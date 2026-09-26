'use strict';
// A publication release for a year of a 5,000-person programme - the funder report, the NDP log and the
// settlement report read and audited together (server/publication-release.js) - in under two seconds, with
// small groups in it for the audit to work on.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const scale = require('./fixtures/funder-scale');
const { uuid } = require('../server/crypto');

const YEAR = 'from=2025-07-01&to=2026-06-30';
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

test('a year\'s publication release for 5,000 people is computed and audited in under 2 s', async () => {
  const { range } = require('../server/routes/reports');
  const FR = require('../server/funder-report');
  const PR = require('../server/publication-release');
  const user = H.db.one(`SELECT * FROM users WHERE username='admin'`);
  const ctx = { user, query: new URLSearchParams(YEAR) };
  const r = range(ctx);
  const counting = FR.countingMode(ctx, r);
  assert.equal(counting.purpose, 'publication');
  const times = [];
  let rel;
  for (let k = 0; k < 3; k++) { const t = process.hrtime.bigint(); rel = PR.release(ctx, r, counting); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const ms = times.sort((a, b) => a - b)[1];
  assert.ok(ms < 2000, `the release took ${ms.toFixed(0)} ms`);
  if (process.env.SUDS_PERF_VERBOSE) console.log(`[perf] publication release, 5,000 clients, 12 months: ${times.map(x => x.toFixed(0)).join(', ')} ms`);
  // The small groups are there and hidden.
  assert.equal(rel.funder.demographics.by_gender.find(x => x.k === 'two_spirit').n, '<11');
  assert.equal(rel.funder.overdose.by_administered_by.find(x => x.k === 'pharmacist').n, '<11');
  assert.equal(rel.settlement.services_by_use.find(x => x.use_code === 'naloxone').people, '<11');
  // And the three endpoints serve it, the same release.
  const t = Date.now();
  const [f, n, s] = await Promise.all(['funder', 'naloxone-ndp', 'opioid-settlement'].map(p => admin.get(`/api/reports/${p}?${YEAR}`)));
  assert.ok(Date.now() - t < 6000);
  for (const x of [f, n, s]) { assert.equal(x.status, 200); assert.equal(x.data.release.id, rel.id); }
});

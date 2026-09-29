'use strict';
// What the audit log records of a publication release (1.17.0; market reviews of 1.16.2 and 1.16.3: the log did
// not say which tables a release withheld, so the releases 1.16.1's withdrawn rule affected could not be found from
// it). Each report that prints a release records its id and every table it withheld with the reason code; a refused
// release is recorded as report.publication.refused with why and what it had withheld. Table names, reason codes and
// counts of work only: never a count of people (docs/HIPAA.md, "Small cells in aggregate reports").
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, sup;
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  H.makeUser('palsup', 'supervisor');
  sup = H.client(); await sup.login('palsup', 'StaffPassw0rd!x');
  // A quarter with a handful of people, overdoses and discharges: small enough that the release hides and
  // withholds, large enough to publish.
  const post = async (p, b) => { const r = await admin.post(p, b); assert.ok(r.status < 300, `${p}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
  for (let i = 0; i < 14; i++) {
    const c = await post('/api/clients', { first_name: `Pal${i}`, last_name: 'Audit', gender: i < 9 ? 'male' : 'female', confirm_duplicate: true });
    await post('/api/interventions', { client_id: c.id, type: 'outreach', occurred_at: `2024-0${4 + (i % 3)}-1${i % 9}T12:00:00Z` });
  }
  for (let i = 0; i < 13; i++) {
    const reversed = i < 4; const fatal = !reversed && i < 6;
    await post('/api/overdose-events', { occurred_at: `2024-0${4 + (i % 3)}-0${1 + (i % 9)}T12:00:00Z`, kind: reversed ? 'reversal' : fatal ? 'fatal' : 'overdose', naloxone_used: reversed, naloxone_doses: reversed ? 1 : 0, administered_by: i < 2 ? 'staff' : 'bystander', survived: !fatal });
  }
});
after(async () => { await H.stop(); });

const Q = 'from=2024-04-01&to=2024-06-30&purpose=publication';
const last = (action) => { const row = H.db.one(`SELECT details, success FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return row && { ...JSON.parse(row.details), success: row.success }; };
// Nothing but these may be in a publication release's audit details: no count of people, no figure.
const RELEASE_KEYS = new Set(['from', 'to', 'funding_source_id', 'served', 'counts', 'purpose', 'format', 'rows', 'funds', 'release_id', 'withheld']);
const REFUSAL_KEYS = new Set(['path', 'from', 'to', 'threshold', 'reason', 'unprotected', 'withheld', 'steps', 'rounds']);
const TABLE = /^[a-z_]+(\.[a-z_]+)*$/;

test('each report of a publication release records its id and the tables it withheld, with why', async () => {
  const r = await sup.get(`/api/reports/funder?${Q}`);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const rel = r.data.release;
  const expected = rel.withheld_reasons.map(w => ({ table: w.table, reason: w.reason }));
  for (const [path, action] of [['/api/reports/funder', 'report.funder'], ['/api/reports/naloxone-ndp', 'report.naloxone_ndp'], ['/api/reports/opioid-settlement', 'report.opioid_settlement'],
    ['/api/reports/funder/export', 'report.funder.export'], ['/api/reports/naloxone-ndp/export', 'report.naloxone_ndp.export'], ['/api/reports/opioid-settlement/export', 'report.opioid_settlement.export']]) {
    const x = await sup.get(`${path}?${Q}&format=csv&reviewed=1`);
    assert.equal(x.status, 200, path);
    const d = last(action);
    assert.equal(d.release_id, rel.id, `${action}: the release id`);
    assert.deepEqual(d.withheld, expected, `${action}: the withheld tables and why`);
    for (const k of Object.keys(d)) if (k !== 'success') assert.ok(RELEASE_KEYS.has(k), `${action}: ${k} is not a figure`);
    for (const w of d.withheld) { assert.match(w.table, TABLE); assert.ok(['protect', 'check'].includes(w.reason), w.reason); }
  }
  // A run that is not a release records no release.
  assert.equal((await sup.get('/api/reports/funder?from=2024-04-01&to=2024-06-30&purpose=internal')).status, 200);
  const internal = last('report.funder');
  assert.equal(internal.release_id, undefined); assert.equal(internal.withheld, undefined);
});

test('a release with withheld tables records each of them with its reason', async () => {
  // The quarter above publishes with nothing withheld; here the audit's answer is taken as it is and two tables are
  // marked withheld (one per reason), through the device runner's hook (server/publication-release.js), to see
  // them reach the log from each report.
  const PR = require('../server/publication-release'); const RA = require('../server/release-audit');
  const was = process.env.SUDS_AUDIT_INLINE; process.env.SUDS_AUDIT_INLINE = '1';
  PR.setDeviceAuditRunner(async (inputs, T, opts) => {
    const p = RA.protectFigures(inputs, T, opts);
    const withheld = [...p.withheld_tables, 'demographics.by_housing', 'overdose.by_administered_by'];
    return { ...p, withheld_tables: withheld, withheld_reasons: RA.withheldReasons(withheld, ['overdose.by_administered_by']) };
  });
  try {
    for (const [path, action] of [['/api/reports/funder', 'report.funder'], ['/api/reports/naloxone-ndp/export', 'report.naloxone_ndp.export'], ['/api/reports/opioid-settlement', 'report.opioid_settlement']]) {
      const r = await sup.get(`${path}?${Q}&format=csv&reviewed=1`);
      assert.equal(r.status, 200, path);
      const d = last(action);
      assert.deepEqual(d.withheld, [{ table: 'demographics.by_housing', reason: 'protect' }, { table: 'overdose.by_administered_by', reason: 'check' }], action);
    }
  } finally { PR.setDeviceAuditRunner(null); if (was === undefined) delete process.env.SUDS_AUDIT_INLINE; else process.env.SUDS_AUDIT_INLINE = was; }
});

test('a refused release is recorded with why, the tables it had withheld and the audit\'s work, and no count of people', async () => {
  const PR = require('../server/publication-release');
  PR.setAuditOptions({ budget: 0 });
  try {
    const before = H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='report.publication.refused'`).n;
    for (const path of ['/api/reports/funder', '/api/reports/naloxone-ndp', '/api/reports/opioid-settlement/export?format=csv&reviewed=1']) {
      const r = await sup.get(`${path}${path.includes('?') ? '&' : '?'}${Q}`);
      assert.equal(r.status, 422, path);
      assert.equal(r.data.code, 'publication_refused');
      // The person is told why in words; the reason code and the tables are for the log, not the response.
      assert.equal(r.data.reason, undefined); assert.equal(r.data.withheld, undefined);
      const d = last('report.publication.refused');
      assert.equal(d.success, 0);
      assert.equal(d.path, path.split('?')[0]); assert.equal(d.from, '2024-04-01'); assert.equal(d.to, '2024-06-30'); assert.equal(d.threshold, 11);
      assert.ok(['budget', 'backstop', 'headline', 'unprotected'].includes(d.reason), d.reason);
      assert.ok(Array.isArray(d.withheld) && d.withheld.every(t => TABLE.test(t)), JSON.stringify(d.withheld));
      assert.equal(typeof d.steps, 'number');
      for (const k of Object.keys(d)) if (k !== 'success') assert.ok(REFUSAL_KEYS.has(k), `${k} is not a figure`);
    }
    // One entry per report asked, the kept refusal included (the second and third are served from the first).
    assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='report.publication.refused'`).n, before + 3);
  } finally { PR.setAuditOptions({}); }
});

test('a run that is not a release has no release details; a release has its id and each withheld table with its reason code only', () => {
  const FR = require('../server/funder-report');
  assert.deepEqual(FR.releaseAuditDetails({ suppression: { purpose: 'submission' }, release: { id: 'x' } }), {});
  assert.deepEqual(FR.releaseAuditDetails({ suppression: { purpose: 'publication' }, release: { id: 'abc', withheld_reasons: [{ table: 'overdose.reversals', label: 'Reversals', reason: 'check', why: '...' }] } }),
    { release_id: 'abc', withheld: [{ table: 'overdose.reversals', reason: 'check' }] });
});

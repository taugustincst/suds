'use strict';
// SUDS_THOROUGH=1 runs the full sweeps (a required CI job, `thorough`, runs them on every push); the default
// run takes a representative sample of the same generators so `npm test` stays quick.
const THOROUGH = process.env.SUDS_THOROUGH === '1';
// One publication release per period (server/publication-release.js), audited as one constraint system
// (server/sdc.js), and attacked with everything its three reports publish by an attacker that shares no code
// with it (test/fixtures/release-attacker.js). docs/HIPAA.md "Small cells in aggregate reports".
//
// The protection rule the attacker checks: a "<T" count, or an unprinted or withheld count of people that is
// truly 1..T-1, must still be able to be 1 and T-1 given everything published; a "suppressed" count of people
// must still range over at least ceil(T/2) values.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { attack, makeSolver } = require('./fixtures/release-attacker');

let admin, sup;
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  H.makeUser('prsup', 'supervisor');
  sup = H.client(); await sup.login('prsup', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }

// The API tests run first: the pure ones below hold the event loop for seconds, and a kept-alive connection
// idle that long can be closed under a request.
// ---- through the API: the three reports serve one audited release ----
const AUG = 'from=2026-08-01&to=2026-08-31';
const EXACT = '&purpose=submission&counts=exact';
// A supervisor's default run is the programme's submission to its funder (1.13.0): a publication release is asked for.
const PUB = '&purpose=publication';
async function seedAugust() {
  const fund = (await admin.post('/api/budget/funds', { name: 'Settlement', source_type: 'opioid_settlement', fiscal_year_start: '2025-07-01', fiscal_year_end: '2026-06-30', total_amount: 1000 })).data.id;
  for (let i = 0; i < 20; i++) {
    const c = await admin.post('/api/clients', { first_name: `Aug${i}`, last_name: 'Release', gender: i < 10 ? 'male' : 'female', confirm_duplicate: true });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const day = i === 19 ? '2026-08-31T18:00:00.000Z' : '2026-08-10T18:00:00.000Z';
    assert.equal((await admin.post('/api/interventions', { client_id: c.data.id, type: 'outreach', occurred_at: day, funding_source_id: fund })).status, 201);
  }
  return fund;
}
// The second quarter of 2024: April 18 overdoses of which 5 reversed, May 11 of which 11 reversed; 3 fatal.
const Q = 'from=2024-04-01&to=2024-06-30';
async function seedQuarter() {
  const post = async (b) => assert.equal((await admin.post('/api/overdose-events', b)).status, 201);
  for (let i = 0; i < 18; i++) {
    const reversed = i < 5; const fatal = !reversed && i < 8;
    await post({ occurred_at: `2024-04-${String(2 + i).padStart(2, '0')}T12:00:00Z`, kind: reversed ? 'reversal' : fatal ? 'fatal' : 'overdose', naloxone_used: reversed, naloxone_doses: reversed ? 1 : 0, administered_by: i < 3 ? 'staff' : 'bystander', survived: !fatal });
  }
  for (let i = 0; i < 11; i++) await post({ occurred_at: `2024-05-${String(2 + i).padStart(2, '0')}T12:00:00Z`, kind: 'reversal', naloxone_used: true, naloxone_doses: 2, administered_by: i < 4 ? 'staff' : 'bystander', survived: true });
}
// What anyone knows about a period: its months, and the code lists a breakdown lists in full.
function domainsOf(q) {
  const C = require('../server/constants'); const PR = require('../server/publication-release');
  const p = new URLSearchParams(q);
  return { months: PR.monthsOf(p.get('from'), p.get('to')), administered_by: C.ADMINISTERED_BY, discharge_reasons: C.DISCHARGE_REASONS };
}
async function releaseOf(q, who = sup) {
  const [funder, ndp, settlement] = await Promise.all(['/api/reports/funder', '/api/reports/naloxone-ndp', '/api/reports/opioid-settlement'].map(p => who.get(`${p}?${q}${PUB}`).then(x => x.data)));
  const [tf, ts] = await Promise.all(['/api/reports/funder', '/api/reports/opioid-settlement'].map(p => sup.get(`${p}?${q}${EXACT}`).then(x => x.data)));
  return { pub: { funder, ndp, settlement, domains: domainsOf(q) }, truth: { funder: tf, settlement: ts } };
}

test('API: the August release (reviewer e2e1) and the overdose quarter survive the attacker, all three reports together', async () => {
  await seedAugust(); await seedQuarter();
  for (const q of [AUG, Q]) {
    const { pub, truth } = await releaseOf(q);
    for (const d of [pub.funder, pub.ndp, pub.settlement]) assert.equal(d.suppression.purpose, 'publication', q);
    assert.deepEqual(attack(pub, truth, 11), [], `${q}: ${JSON.stringify({ served: pub.funder.unduplicated.served, gender: pub.funder.demographics.by_gender, funds: pub.funder.by_funding_source.map(f => [f.name, f.clients_served, f.services]), settlement: pub.settlement.services_by_use, od: pub.funder.overdose })}`);
    // One release: the same id on all three, and the NDP reversals are the funder report's.
    assert.ok(pub.funder.release.id && pub.funder.release.id === pub.ndp.release.id && pub.ndp.release.id === pub.settlement.release.id, JSON.stringify([pub.funder.release, pub.ndp.release]));
    // Every month of the period, with a reversal or not; none when the reversals by month are withheld.
    const revGone = pub.funder.release.withheld.includes('overdose.by_month.reversals');
    assert.deepEqual(pub.ndp.rows.filter(x => x.entry === 'reversal').map(x => [x.date, x.reversals]), revGone ? [] : pub.funder.overdose.by_month.map(x => [x.month, x.reversals]));
    assert.deepEqual(pub.funder.overdose.by_month.map(x => x.month), pub.domains.months);
    assert.deepEqual(pub.ndp.totals.reversals, pub.funder.overdose.reversals);
  }
});

test('API: the tests\' releases are audited in the worker thread, as the server\'s are', async () => {
  // docs/architecture/ADR-0009: the API tests exercise the worker path (test/helpers.js does not set
  // SUDS_AUDIT_INLINE); the pure tests below call the audit directly.
  const PR = require('../server/publication-release');
  assert.notEqual(process.env.SUDS_AUDIT_INLINE, '1');
  const before = { ...PR.auditStats };
  PR.clearCache();
  const r = await sup.get(`/api/reports/funder?${AUG}${PUB}`);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  assert.equal(PR.auditStats.worker, before.worker + 1, 'one audit, in the worker');
  assert.equal(PR.auditStats.inline, before.inline, 'none inline');
});

test('API: determinism - asking again, or for the export, serves the identical release', async () => {
  const first = await releaseOf(AUG);
  const again = await releaseOf(AUG);
  for (const k of ['funder', 'ndp', 'settlement']) assert.equal(again.pub[k].release.id, first.pub[k].release.id, k);
  const strip = (d) => JSON.parse(JSON.stringify(d, (key, v) => (key === 'generated_at' ? undefined : v)));
  assert.deepEqual(strip(again.pub.funder), strip(first.pub.funder));
  assert.deepEqual(again.pub.settlement.services_by_use, first.pub.settlement.services_by_use);
  // The files print the same cells.
  const csv = String((await sup.get(`/api/reports/funder/export?${AUG}${PUB}&format=csv&reviewed=1`)).data);
  assert.match(csv, /publication/i);
  for (const x of first.pub.funder.demographics.by_gender) assert.ok(csv.includes(`Gender,${x.k},${x.n}`), `${x.k} ${x.n}`);
  const sx = await sup.raw(`/api/reports/opioid-settlement/export?${AUG}${PUB}&format=xlsx&reviewed=1`);
  const wb = require('../server/spreadsheet').readWorkbook(Buffer.from(await sx.arrayBuffer()));
  const services = wb.find(s => s.name === 'Services');
  for (const x of first.pub.settlement.services_by_use) assert.ok(services.rows.some(row => row.map(String).includes(String(x.people))), `${x.people} in ${JSON.stringify(services.rows)}`);
});

test('API: a publication release\'s file is exported only once its review is confirmed, which the audit log records with the release id', async () => {
  const rel = (await sup.get(`/api/reports/funder?${AUG}${PUB}`)).data;
  assert.equal(rel.suppression.purpose, 'publication');
  assert.match(rel.counting_statement, /Publication release — small cells screened; review before sharing/);
  assert.doesNotMatch(rel.counting_statement, /Suitable for publication/i);
  const before = H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='report.publication.reviewed'`).n;
  for (const p of ['/api/reports/funder/export', '/api/reports/naloxone-ndp/export', '/api/reports/opioid-settlement/export']) {
    const r = await sup.get(`${p}?${AUG}${PUB}&format=csv`);
    assert.equal(r.status, 428, `${p}: ${r.status}`);
    assert.equal(r.data.code, 'publication_review_required');
    assert.match(r.data.error, /I have reviewed the withheld and small figures before sharing/);
  }
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='report.publication.reviewed'`).n, before, 'a refused export records no review');
  for (const [p, report] of [['/api/reports/funder/export', 'funder'], ['/api/reports/naloxone-ndp/export', 'naloxone-ndp'], ['/api/reports/opioid-settlement/export', 'opioid-settlement']]) {
    const r = await sup.raw(`${p}?${AUG}${PUB}&format=xlsx&reviewed=1`);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-disposition'), /publication-screened-review-before-sharing\.xlsx/);
    assert.equal(r.headers.get('x-suds-report-purpose'), 'publication');
    const row = H.db.one(`SELECT details FROM audit_log WHERE action='report.publication.reviewed' ORDER BY id DESC LIMIT 1`);
    const d = JSON.parse(row.details);
    assert.equal(d.report, report); assert.equal(d.release_id, rel.release.id); assert.equal(d.from, '2026-08-01');
  }
  const wb = require('../server/spreadsheet').readWorkbook(Buffer.from(await (await sup.raw(`/api/reports/funder/export?${AUG}${PUB}&format=xlsx&reviewed=1`)).arrayBuffer()));
  const about = wb.find(s => s.name === 'About').rows.map(r => r.join(' ')).join('\n');
  assert.match(about, /Publication release — small cells screened; review before sharing \(whole program, one standard period\)/);
  // Internal and submission runs are exported as before, with no confirmation.
  for (const q of [AUG, `${AUG}&purpose=internal`, `${AUG}${EXACT}`]) assert.equal((await sup.get(`/api/reports/funder/export?${q}&format=csv`)).status, 200, q);
});

test('API: a navigator\'s caseload run counts the caseload\'s overdoses and people per fund, not the programme\'s', async () => {
  // January 2024: two clients, one on the navigator's caseload, each with an overdose; one community event.
  H.makeCaseloadUser('prnav', 'navigator'); const nav = H.client(); await nav.login('prnav', 'StaffPassw0rd!x');
  const navId = H.db.one(`SELECT id FROM users WHERE username='prnav'`).id;
  const fund = (await admin.post('/api/budget/funds', { name: 'Jan fund', fiscal_year_start: '2023-07-01', fiscal_year_end: '2024-06-30', total_amount: 10 })).data.id;
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const c = await admin.post('/api/clients', { first_name: `Case${i}`, last_name: 'Load', confirm_duplicate: true }); ids.push(c.data.id);
    assert.equal((await admin.post('/api/interventions', { client_id: c.data.id, type: 'outreach', occurred_at: '2024-01-10T18:00:00.000Z', funding_source_id: fund })).status, 201);
    assert.equal((await admin.post('/api/overdose-events', { client_id: c.data.id, occurred_at: '2024-01-11T12:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 1, administered_by: 'staff', survived: true })).status, 201);
  }
  assert.equal((await admin.post('/api/overdose-events', { occurred_at: '2024-01-12T12:00:00Z', kind: 'overdose', survived: true })).status, 201);
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date) VALUES(lower(hex(randomblob(16))),?,?,'primary','2023-01-01')`, ids[0], navId);
  const q = 'from=2024-01-01&to=2024-01-31';
  const whole = (await sup.get(`/api/reports/funder?${q}${EXACT}`)).data;
  assert.equal(whole.overdose.events, 3); assert.equal(whole.overdose.community_reported, 1);
  assert.equal(whole.by_funding_source.find(f => f.id === fund).clients_served, 2);
  assert.equal(whole.caseload_scope_note, null);
  const r = await nav.get(`/api/reports/funder?${q}&purpose=internal`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.equal(d.suppression.purpose, 'internal');
  // One person, one event, both on the caseload (shown "<11"); the other client's and the community's are not counted.
  assert.equal(d.unduplicated.served, '<11');
  assert.equal(d.overdose.events, '<11'); assert.equal(d.overdose.community_reported, 0);
  assert.deepEqual(d.overdose.by_month.map(x => x.month), ['2024-01']);
  assert.match(d.caseload_scope_note, /caseload/); assert.match(d.caseload_scope_note, /community/);
  // The truth behind the "<11"s, from the same queries: one each.
  const FR = require('../server/funder-report');
  const { range } = require('../server/routes/reports');
  const navUser = H.db.one(`SELECT * FROM users WHERE id=?`, navId);
  const { raw } = FR.runSync(FR.figures({ user: navUser, query: new URLSearchParams(q) }, range({ query: new URLSearchParams(q) }), null));
  assert.equal(raw.overdose.events, 1); assert.equal(raw.overdose.reversals, 1); assert.equal(raw.overdose.community_reported, 0);
  assert.equal(raw.by_funding_source.find(f => f.id === fund).clients_served, 1);
  const csv = String((await nav.get(`/api/reports/funder/export?${q}&purpose=internal&format=csv`)).data);
  assert.match(csv, /About,Scope,/);
});

// ---- the reviewer's reproductions against 1.12.2, through the API ----
async function clientsServed(n, day, prefix) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const c = await admin.post('/api/clients', { first_name: `${prefix}${i}`, last_name: 'Release', confirm_duplicate: true });
    assert.equal(c.status, 201, JSON.stringify(c.data)); ids.push(c.data.id);
    if (day) assert.equal((await admin.post('/api/interventions', { client_id: c.data.id, type: 'outreach', occurred_at: `${day}T18:00:00.000Z` })).status, 201);
  }
  return ids;
}
const episode = (clientId, opened, closed, reason) => H.db.run(`INSERT INTO episodes(id,client_id,opened_at,status,closed_at,discharge_reason) VALUES(lower(hex(randomblob(16))),?,?,?,?,?)`, clientId, opened, closed ? 'closed' : 'open', closed, reason);
const csvLines = (csv, re) => String(csv).split(/\r?\n/).filter(l => re.test(l));

test('API: reviewer year2 - one reversal a month and nine discharge reasons; the rows listed say nothing', async () => {
  // 2022: one reversal by staff in each of January to October, nine episodes closed, one for each reason.
  // 1.12.2 listed ten "withheld" NDP month rows and "staff <11": each month exactly 1; and nine reasons
  // under "Closed <11": 9 or 10.
  const ids = await clientsServed(20, '2022-03-10', 'Y2-');
  for (let m = 1; m <= 10; m++) assert.equal((await admin.post('/api/overdose-events', { client_id: ids[m], occurred_at: `2022-${String(m).padStart(2, '0')}-15T12:00:00Z`, kind: 'reversal', naloxone_used: true, naloxone_doses: 1, administered_by: 'staff', survived: true })).status, 201);
  require('../server/constants').DISCHARGE_REASONS.forEach((reason, i) => episode(ids[i], '2022-02-01', '2022-06-15', reason));
  const q = 'from=2022-01-01&to=2022-12-31';
  const { pub, truth } = await releaseOf(q);
  assert.equal(pub.funder.suppression.purpose, 'publication');
  assert.deepEqual(attack(pub, truth, 11), [], JSON.stringify({ od: pub.funder.overdose, ep: pub.funder.episodes, withheld: pub.funder.release.withheld }));
  const ndpCsv = (await sup.get(`/api/reports/naloxone-ndp/export?${q}${PUB}&format=csv&reviewed=1`)).data;
  const revRows = csvLines(ndpCsv, /Reversal reported/);
  assert.ok(revRows.length === 12 || revRows.length === 0, revRows.join('\n'));
  const fCsv = (await sup.get(`/api/reports/funder/export?${q}${PUB}&format=csv&reviewed=1`)).data;
  const reasons = csvLines(fCsv, /^Discharge reason,/); const givenBy = csvLines(fCsv, /^Naloxone given by,/);
  assert.ok(reasons.length === 0 || reasons.length >= 9, reasons.join('\n'));
  assert.ok(givenBy.length === 0 || givenBy.length >= 6, givenBy.join('\n'));
  assert.ok(![...reasons, ...givenBy, ...revRows].some(l => /withheld/.test(l)), 'a row of a withheld table is printed');
});

test('API: reviewer year - one overdose a month, not reversed', async () => {
  await clientsServed(15, '2023-03-10', 'Y1-');
  for (let m = 1; m <= 10; m++) assert.equal((await admin.post('/api/overdose-events', { occurred_at: `2023-${String(m).padStart(2, '0')}-15T12:00:00Z`, kind: 'overdose', survived: true })).status, 201);
  const { pub, truth } = await releaseOf('from=2023-01-01&to=2023-12-31');
  assert.deepEqual(attack(pub, truth, 11), [], JSON.stringify(pub.funder.overdose));
});

test('API: reviewer e2e S1 - episodes opened, open at the end and closed are one system', async () => {
  // Q1 2025: 30 episodes opened in February, 25 still open, 5 closed in March; 25 people served. 1.12.2
  // printed Opened 30, Open at end 25 and Closed "<11": at least 5.
  const ids = await clientsServed(30, null, 'S1-');
  for (let i = 0; i < 25; i++) assert.equal((await admin.post('/api/interventions', { client_id: ids[i], type: 'outreach', occurred_at: '2025-02-10T18:00:00.000Z' })).status, 201);
  ids.forEach((id, i) => episode(id, '2025-02-01', i < 5 ? '2025-03-15' : null, i < 5 ? (i < 3 ? 'completed' : 'moved') : null));
  assert.equal((await admin.post('/api/overdose-events', { occurred_at: '2025-01-15T12:00:00Z', kind: 'overdose', survived: true })).status, 201);
  assert.equal((await admin.post('/api/overdose-events', { occurred_at: '2025-02-15T12:00:00Z', kind: 'overdose', survived: true })).status, 201);
  const q = 'from=2025-01-01&to=2025-03-31';
  const { pub, truth } = await releaseOf(q);
  assert.equal(truth.funder.episodes.admissions, 30); assert.equal(truth.funder.episodes.discharges, 5);
  assert.deepEqual(attack(pub, truth, 11), [], JSON.stringify(pub.funder.episodes));
  const e = pub.funder.episodes;
  assert.ok(!(typeof e.admissions === 'number' && typeof e.open_at_end === 'number' && e.discharges === '<11'), `opened ${e.admissions}, open at end ${e.open_at_end}, closed ${e.discharges}`);
});

test('API: an episode cannot be closed before it was opened', async () => {
  const [id] = await clientsServed(1, null, 'EP-');
  const opened = await admin.post(`/api/clients/${id}/episodes`, { opened_at: '2025-05-10' });
  let epId = opened.data && opened.data.id;
  if (opened.status !== 201) epId = H.db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, id).id; // the intake episode
  H.db.run(`UPDATE episodes SET opened_at='2025-05-10' WHERE id=?`, epId);
  const bad = await admin.post(`/api/episodes/${epId}/close`, { discharge_reason: 'completed', closed_at: '2025-05-09', keep_client_active: true });
  assert.equal(bad.status, 400, JSON.stringify(bad.data)); assert.match(bad.data.error, /before the episode was opened/);
  assert.equal(H.db.one(`SELECT status FROM episodes WHERE id=?`, epId).status, 'open');
  const ok = await admin.post(`/api/episodes/${epId}/close`, { discharge_reason: 'completed', closed_at: '2025-05-10', keep_client_active: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('API: a release the audit cannot verify is refused by all three reports and their files; the submission still works', async () => {
  const PR = require('../server/publication-release');
  // No search budget: no check can be settled, not even the headline's, so the release is refused whole.
  PR.setAuditOptions({ budget: 0 });
  try {
    for (const p of ['/api/reports/funder', '/api/reports/naloxone-ndp', '/api/reports/opioid-settlement', '/api/reports/funder/export', '/api/reports/naloxone-ndp/export?format=xlsx']) {
      const r = await sup.get(`${p}${p.includes('?') ? '&' : '?'}${AUG}${PUB}`);
      assert.equal(r.status, 422, `${p}: ${r.status}`);
      assert.match(r.data.error, /cannot be published/); assert.equal(r.data.code, 'publication_refused');
      assert.match(r.data.error, /submission to its funder, which is not for publication, is unaffected/);
    }
    const internal = await sup.get(`/api/reports/funder?${AUG}&purpose=internal`);
    assert.equal(internal.status, 200); assert.equal(internal.data.suppression.purpose, 'internal');
    const submission = await sup.get(`/api/reports/funder?${AUG}`);
    assert.equal(submission.status, 200); assert.equal(submission.data.suppression.purpose, 'submission');
  } finally { PR.setAuditOptions({}); }
  assert.equal((await sup.get(`/api/reports/funder?${AUG}${PUB}`)).status, 200);
});

// ---- the solver ----
test('the exact integer solver agrees with brute force on random small systems', () => {
  const SDC = require('../server/sdc');
  const r = rng(7);
  for (let run = 0; run < 300; run++) {
    const n = 2 + Math.floor(r() * 3);
    const lb = Array.from({ length: n }, () => Math.floor(r() * 3)); const ub = lb.map(l => (r() < 0.2 ? Infinity : l + Math.floor(r() * 6)));
    const rows = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ a: Array.from({ length: n }, () => [-1, 0, 1, 1, 2][Math.floor(r() * 5)]), op: ['<=', '>=', '='][Math.floor(r() * 3)], b: Math.floor(r() * 9) - 2 }));
    const c = Array.from({ length: n }, () => [-1, 0, 1][Math.floor(r() * 3)]);
    // Brute force over a box (an unbounded variable is capped at 40, and a maximum that reaches the cap is unbounded).
    const CAP = 40; const hi = ub.map(u => Math.min(u, CAP));
    let best = -Infinity; let known = null; const values = new Set(); let capped = false;
    const x = lb.slice();
    const rec = (j) => {
      if (j === n) {
        if (!rows.every(row => { const s = row.a.reduce((a, v, i) => a + v * x[i], 0); return row.op === '<=' ? s <= row.b : row.op === '>=' ? s >= row.b : s === row.b; })) return;
        const v = c.reduce((a, cv, i) => a + cv * x[i], 0); values.add(v);
        if (v > best) { best = v; }
        if (!known) known = x.slice();
        if (x.some((xi, i) => ub[i] === Infinity && xi === CAP)) capped = true;
        return;
      }
      for (let v = lb[j]; v <= hi[j]; v++) { x[j] = v; rec(j + 1); }
    };
    rec(0);
    if (!known) continue; // the engine is only ever asked about systems the truth satisfies
    const got = SDC.intMax({ n, rows, lb, ub }, c, known).value;
    if (got === Infinity) assert.ok(capped || c.some((cv, i) => cv > 0 && ub[i] === Infinity), `run ${run}: unbounded but brute force found ${best}`);
    else assert.equal(got, best, `run ${run}: ${JSON.stringify({ rows, lb, ub, c })}`);
    for (const v of [best, best - 1, best - 2]) {
      if (got === Infinity) break;
      assert.equal(SDC.intFeasible({ n, rows, lb, ub }, c, v).feasible, values.has(v), `run ${run}: can the objective be ${v}?`);
    }
  }
});

test('the attacker\'s own solver agrees with brute force', () => {
  const r = rng(11);
  for (let run = 0; run < 200; run++) {
    const n = 2 + Math.floor(r() * 3); const lo = Array.from({ length: n }, () => Math.floor(r() * 3)); const hi = lo.map(l => l + Math.floor(r() * 6));
    const cons = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ terms: Array.from({ length: n }, (_, i) => [i, [-1, 0, 1, 1][Math.floor(r() * 4)]]).filter(([, c]) => c), op: ['<=', '>=', '='][Math.floor(r() * 3)], rhs: Math.floor(r() * 9) - 2 }));
    const sols = []; const x = lo.slice();
    const rec = (j) => { if (j === n) { if (cons.every(k => { const s = k.terms.reduce((a, [i, c]) => a + c * x[i], 0); return k.op === '<=' ? s <= k.rhs : k.op === '>=' ? s >= k.rhs : s === k.rhs; })) sols.push(x.slice()); return; } for (let v = lo[j]; v <= hi[j]; v++) { x[j] = v; rec(j + 1); } };
    rec(0);
    let s;
    try { s = makeSolver(lo, hi, cons); } catch { assert.equal(sols.length, 0, `run ${run}`); continue; }
    for (let i = 0; i < n; i++) for (let v = lo[i]; v <= hi[i]; v++) assert.equal(s.can(i, v), sols.some(z => z[i] === v), `run ${run} x${i}=${v}`);
  }
});

// ---- the release, as a pure function of its figures ----
const PARTS = ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity'];
const { figuresOf, QUARTER, person, plain, many, pattern } = require('./fixtures/release-worlds');
/** Protect a programme's figures and put them the way the three reports publish them (the NDP log through its own code). */
function publish(prog, T, opts = {}) {
  const PR = require('../server/publication-release');
  const HR = require('../server/harm-reduction-reports');
  const p = PR.protectFigures(prog.inputs, T, { strict: true, ...opts });
  if (p.refused) return { p };
  const { funder: raw, settlement } = prog.inputs;
  const counting = { threshold: T, mode: 'suppressed', purpose: 'publication', release: { publishable: true, period: 'quarter', not_publishable: [] } };
  const pub = {
    funder: p.funder,
    settlement: { funds: prog.funds.filter(f => f.use).map(f => ({ id: f.id, settlement_use: f.use })), services_by_use: settlement.services_by_use.map((x, i) => ({ ...x, people: p.uses[i].people, services: p.uses[i].services })) },
    ndp: HR.ndpPublished(prog.range, counting, new Map(), p.ndp),
    // The list of funds is known (a combined fund is one of the active funds the fund table does not list).
    domains: prog.inputs.domains, withheld: p.withheld_tables, activeFunds: prog.funds.filter(f => f.active).map(f => f.id),
  };
  const truth = { funder: raw, settlement: { services_by_use: settlement.services_by_use }, inactiveFunds: prog.inactiveFunds, fundTruth: prog.fundTruth };
  return { p, pub, truth };
}
/** Whatever a report prints is true: a number is the count, "<T" a count of 1..T-1, "suppressed" at least T. */
function honest(shown, truth, T, people = true) {
  if (typeof shown === 'number') return shown === truth;
  if (shown === `<${T}`) return truth > 0 && truth < T;
  if (shown === 'suppressed') return !people || truth >= T;
  return shown === 'withheld';
}
const noPeople = (over = {}) => ({ people: [], funds: [], ...over });
/** A refused release publishes nothing (and says why): nothing to attack. */
const refusedRelease = (x) => { if (!x.p.refused) return false; assert.match(x.p.refused.message, /cannot be published/); assert.equal(x.p.funder, undefined); return true; };

test('reviewer reproduction: the overdose months, reversals at most the events of their month', () => {
  // Found against 1.12.1: [events, reversals] per month, reversals by who gave the naloxone, fatal events.
  const cases = [
    { months: [[18, 5], [11, 11]], by: [7, 9], fatal: 3 }, // r1 >= 11 and n1 = 11 forced r1 = 11, so r0 = 5
    { months: [[18, 1], [18, 11]], by: [11, 1], fatal: 24 }, // fatal 24 of 36 left one reversal
    { months: [[1, 1], [18, 17]], by: [5, 13], fatal: 1 },
    { months: [[15, 14], [3, 3]], by: [16, 1], fatal: 1 },
  ];
  for (const c of cases) {
    const events = [];
    c.months.forEach(([n, rv], m) => { for (let i = 0; i < n; i++) events.push({ month: `2026-0${m + 1}`, reversed: i < rv }); });
    let f = c.fatal; for (const e of events) if (!e.reversed && f > 0) { e.fatal = true; f--; }
    let b = 0; for (const e of events) if (e.reversed) { e.by = b < c.by[0] ? 'staff' : 'bystander'; b++; }
    const x = publish(figuresOf(noPeople({ events, period: ['2026-01', '2026-02', '2026-03'] })), 11);
    if (refusedRelease(x)) continue;
    const { pub, truth } = x;
    assert.deepEqual(attack(pub, truth, 11), [], `${JSON.stringify(c)} published as ${JSON.stringify(pub.funder.overdose)}`);
  }
});

test('reviewer reproduction: the funder report and the settlement report of one release', () => {
  // 20 people, 10 men and 10 women, all served under one settlement fund. 1.12.1 hid the total and both
  // genders in the funder report, and printed 20 people for the fund's use in the settlement report.
  const people = Array.from({ length: 20 }, (_, i) => ({ gender: i < 10 ? 'male' : 'female', language: 'en', housing: 'u', insurance: 'a', ethnicity: 'u', race: [], visits: { S: 1 } }));
  const prog = figuresOf({ people, funds: [{ id: 'S', use: 'uncategorised', active: true }] });
  const { pub, truth } = publish(prog, 11);
  assert.deepEqual(attack(pub, truth, 11), [], JSON.stringify({ served: pub.funder.unduplicated.served, gender: pub.funder.demographics.by_gender, settlement: pub.settlement.services_by_use }));
  // A fund's services bound its people (everyone served was served at least once), and the settlement
  // report prints its use's services, the sum of its funds': fund A served two people twice, fund B (same
  // use) twenty people, those two among them. A's services are the use's minus B's: 2.
  const two = figuresOf({ people: Array.from({ length: 50 }, (_, i) => ({ gender: 'm', language: 'en', housing: 'u', insurance: 'a', ethnicity: 'u', race: [], visits: i < 2 ? { A: 1, B: 1 } : i < 20 ? { B: 1 } : { C: 1 } })),
    funds: [{ id: 'A', use: 'u1', active: true }, { id: 'B', use: 'u1', active: true }, { id: 'C', use: null, active: true }] });
  const t2 = publish(two, 11);
  if (!refusedRelease(t2)) {
    assert.deepEqual(attack(t2.pub, t2.truth, 11), [], JSON.stringify({ funds: t2.pub.funder.by_funding_source, settlement: t2.pub.settlement.services_by_use }));
    assert.equal(t2.pub.funder.by_funding_source.find(f => f.id === 'A').clients_served, '<11');
  }
  // And the cross-report cases found by random search (cross.js): a fund, a use, and the total they share.
  const r = rng(5);
  for (let run = 0; run < 60; run++) {
    const n = 1 + Math.floor(r() * 30);
    const ppl = Array.from({ length: n }, () => ({ gender: r() < 0.5 ? 'm' : 'f', language: r() < 0.8 ? 'en' : 'es', housing: 'u', insurance: 'a', ethnicity: 'u', race: [], visits: r() < 0.7 ? { S: 1 + Math.floor(r() * 2) } : { C: 1 } }));
    const pr = figuresOf({ people: ppl, funds: [{ id: 'S', use: 'u1', active: true }, { id: 'C', use: null, active: true }] });
    const x = publish(pr, 11);
    if (refusedRelease(x)) continue;
    assert.deepEqual(attack(x.pub, x.truth, 11), [], `run ${run}`);
  }
});

// ---- random programmes, every report of the release attacked together ----
function randomProgramme(r, { fold = null } = {}) {
  const pick = (xs, w) => { let u = r() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { u -= w[i]; if (u < 0) return xs[i]; } return xs[xs.length - 1]; };
  const T = 3 + Math.floor(r() * 3);
  const skew = [1 + r() * 8, 1, r()];
  const funds = [{ id: 'A', use: 'u1', active: true }, { id: 'B', use: r() < 0.5 ? 'u1' : 'u2', active: true }, { id: 'C', use: null, active: true }];
  if (r() < 0.4) funds.push({ id: 'D', use: 'u2', active: false });
  const n = 1 + Math.floor(r() * 12);
  const people = Array.from({ length: n }, () => {
    const race = ['w', 'b', 'a'].filter(() => r() < 0.4);
    const visits = {};
    for (const [f, pr] of [['A', 0.6], ['B', 0.3], ['C', 0.3], ['D', 0.2], [null, 0.15]]) if (r() < pr && funds.some(x => x.id === f || f === null)) visits[f] = 1 + Math.floor(r() * 3);
    return { gender: pick(['m', 'f', 'x'], skew), language: pick(['en', 'es'], [skew[0], 1]), housing: pick(['s', 'h', 'u'], [1, 1, r()]), insurance: pick(['a', 'b'], [skew[0], 1]),
      ethnicity: pick(['h', 'n', 'u'], skew), race, visits, mat: r() < 0.6, referred: r() < 0.5, admitted: r() < 0.3 };
  });
  const anon = r() < 0.3 ? { A: 1 + Math.floor(r() * 3) } : {};
  const nm = 1 + Math.floor(r() * 3);
  const events = Array.from({ length: Math.floor(r() * 16) }, () => {
    const reversed = r() < 0.5; const fatal = !reversed && r() < 0.35;
    // Doses: 1 to 3 per reversal (sometimes none recorded, sometimes many), and naloxone that did not save a life.
    const doses = reversed ? (r() < 0.05 ? 0 : r() < 0.1 ? 20 : 1 + Math.floor(r() * 3)) : r() < 0.2 ? 1 + Math.floor(r() * 2) : 0;
    return { month: `2025-0${1 + Math.floor(r() * nm)}`, reversed, fatal, community: r() < 0.3, by: pick(['staff', 'bystander', 'ems'], [skew[0], 1, r()]), doses };
  });
  // Episodes: opened before the period or in it, closed in it or still open at its end (now and then one that
  // closed before it opened, which an import could write).
  const episodes = Array.from({ length: Math.floor(r() * 14) }, () => ({ opened: r() < 0.6 ? 'in' : 'before', state: r() < 0.5 ? 'closed' : 'open', reason: pick(['completed', 'moved', 'lost'], skew) }));
  if (r() < 0.05) episodes.push({ opened: 'in', state: 'closed-before' });
  return { T, prog: figuresOf({ people, anon, events, episodes, funds, ...(fold ? { fold: { T, ...fold } } : {}) }) };
}

test('property: nothing any report of a release publishes lets an attacker narrow a hidden count beyond the rule', () => {
  const r = rng(Number(process.env.PR_SEED) || 20260926);
  const runs = Number(process.env.PR_RUNS) || (THOROUGH ? 250 : 40);
  let hidden = 0; let secondary = 0; let withheld = 0; let refused = 0;
  for (let run = 0; run < runs; run++) {
    const { T, prog } = randomProgramme(r);
    const x = publish(prog, T);
    if (refusedRelease(x)) { refused++; continue; }
    const { p, pub, truth } = x;
    // Every published symbol is true.
    const m = p.model;
    m.vars.forEach((v, i) => { if (v.published) assert.ok(honest(p.status[i] === 'vis' ? v.value : p.status[i] === 'pri' ? `<${T}` : p.status[i] === 'sec' ? 'suppressed' : 'withheld', v.value, T, v.people), `run ${run}: ${v.id}`); });
    const leaks = attack(pub, truth, T);
    assert.deepEqual(leaks, [], `run ${run}, T=${T}: ${JSON.stringify(prog.inputs.funder.unduplicated)} ${JSON.stringify(prog.inputs.funder.overdose.by_month)}`);
    hidden += p.status.filter(s => s === 'pri' || s === 'sec').length; secondary += p.status.filter(s => s === 'sec').length; withheld += p.withheld_tables.length;
  }
  // The runs exercised the audit (something was hidden, some of it to protect another count). These are tiny
  // programmes at thresholds of 3 to 5, where the check refuses some releases it cannot show protected
  // (docs/HIPAA.md): about seven in ten of these, which the tests count; the rest are published.
  assert.ok(hidden > runs / 2, `hidden ${hidden}`); assert.ok(secondary > 0, `secondary ${secondary}, withheld ${withheld}`);
  assert.ok(runs - refused >= runs / 5, `refused ${refused} of ${runs}`);
  if (process.env.SUDS_PERF_VERBOSE) console.log(`[release] random programmes: ${refused} of ${runs} refused`);
});

// ---- small funds combined (1.14.0) ----
// A publication release combines every fund with 1 to T-1 people in one row, "Other funds (n combined)", which
// prints how many funds it holds and their staff hours but no people or services (server/funder-report.js
// foldFunds); what the settlement report says about them is modelled with one stand-in per allowable use
// (server/release-audit.js buildModel). The attacker models every combined fund on its own: the active funds
// the table does not list, each 1 to T-1 people. Two kinds of programme: many funds (four to six besides a main
// one, most of them small, settlement and other funds) with plain demographics, whose audits are quick and
// nearly always publish; and the random programmes above, every breakdown varied, most of them refused at these
// thresholds (the check cannot show such tiny programmes protected), so fewer of them.
function fundsProgramme(r, keep) {
  const T = r() < 0.6 ? 3 : 4;
  const funds = [{ id: 'A', use: 'u1', active: true }];
  const k = 4 + Math.floor(r() * 3);
  for (let i = 0; i < k; i++) funds.push({ id: `F${i}`, use: r() < 0.6 ? (r() < 0.5 ? 'u1' : 'u2') : null, active: true });
  if (r() < 0.3) funds.push({ id: 'Z', use: 'u2', active: false });
  const people = Array.from({ length: 2 * T + Math.floor(r() * 10) }, () => {
    const visits = {};
    if (r() < 0.85) visits.A = 1 + Math.floor(r() * 2);
    for (const f of funds.slice(1)) if (r() < (f.active ? 0.15 : 0.1)) visits[f.id] = 1 + Math.floor(r() * 2);
    if (r() < 0.1) visits[null] = 1;
    return person({ gender: r() < 0.8 ? 'm' : 'f', housing: r() < 0.7 ? 'u' : 's', visits, mat: r() < 0.5 });
  });
  const anon = r() < 0.3 ? { A: 1 + Math.floor(r() * 2), ...(r() < 0.5 ? { F0: 1 } : {}) } : {};
  return { T, prog: figuresOf({ people, anon, funds, fold: { T, keep } }) };
}
test('property: a release that combines its small funds lets nobody narrow any of them, or anything else, beyond the rule', () => {
  const r = rng(Number(process.env.PR_SEED) || 20261131);
  const runs = Number(process.env.PR_RUNS) || (THOROUGH ? 300 : 30);
  const rich = THOROUGH ? 60 : 10;
  let combined = 0; let two = 0; let refused = 0; let richPublished = 0;
  for (let run = 0; run < runs + rich; run++) {
    // Every small fund combined (as the server does), or the first listed and the rest combined.
    const keep = run % 3 === 2 ? 1 : 0;
    const { T, prog } = run < runs ? fundsProgramme(r, keep) : randomProgramme(r, { fold: { keep } });
    const x = publish(prog, T);
    if (refusedRelease(x)) { refused++; continue; }
    if (run >= runs) richPublished++;
    const { pub, truth } = x;
    const row = pub.funder.by_funding_source.find(f => f.combined);
    if (row) {
      combined++; if (row.funds_combined >= 2) two++;
      assert.equal(row.clients_served, 'withheld'); assert.equal(row.services, 'withheld');
      assert.equal(row.funds_combined, prog.combined.length);
      // Only small funds are combined, and the funds listed after the kept ones are not small.
      for (const id of prog.combined) assert.ok(prog.fundTruth[id].people > 0 && prog.fundTruth[id].people < T, `run ${run}: ${id}`);
      assert.ok(pub.funder.by_funding_source.filter(f => f.id && !f.combined && f.clients_served === `<${T}`).length <= keep, `run ${run}`);
    }
    assert.deepEqual(attack(pub, truth, T), [], `run ${run}, T=${T}, keep=${keep}: ${JSON.stringify(prog.fundTruth)}`);
  }
  assert.ok(combined > runs / 2, `combined in ${combined} of ${runs + rich - refused} published`);
  assert.ok(two > runs / 5, `two or more funds combined in ${two}`);
  assert.ok(richPublished > 0, 'a random programme was published');
  if (process.env.SUDS_PERF_VERBOSE) console.log(`[release] combined funds: ${combined} releases with a combined row (${two} with two or more funds), ${refused} of ${runs + rich} refused`);
});

// ---- realistic programmes (1.13.0) ----
// 1.12.4 refused the publication release of most quarters of 60 to 100 people: with six race codes of ten or
// so people each, one hidden to protect the small ones was hidden only when it pinned them, which said the
// small ones were at least 2, and the check (rightly) refused the release. The cover's complement is now
// chosen from the printout alone (server/sdc.js run), and a table the check cannot show protected is withheld
// rather than the release refused.
function realistic(r, N, { months = QUARTER, od = Math.max(2, Math.round(N / 10)) } = {}) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const people = Array.from({ length: N }, () => person({ gender: pick(['male', 'male', 'female', 'nonbinary']), race: [pick(['1', '2', '3', '5', '6', '7'])], language: pick(['en', 'en', 'en', 'es']),
    housing: pick(['unsheltered', 'sheltered', 'housed']), mat: r() < 0.3, visits: r() < 0.7 ? { S: 1 + Math.floor(r() * 3) } : { F: 1 + Math.floor(r() * 3) } }));
  const events = Array.from({ length: od }, () => { const reversed = r() < 0.7; return { month: pick(months), reversed, by: pick(['staff', 'bystander']), doses: reversed ? 2 : 0 }; });
  return figuresOf({ people, events, period: months, funds: [{ id: 'S', use: 'uncategorised', active: true }, { id: 'F', use: null, active: true }] });
}
test('realistic programmes: a quarter or a month of 40 to 100 people publishes its headline and its tables, and survives the attacker', () => {
  const r = rng(Number(process.env.PR_SEED) || 777);
  const sizes = THOROUGH ? [40, 60, 80, 100, 200] : [40, 60, 80, 100];
  let runs = 0; let withheld = 0; let refused = 0;
  for (const N of sizes) {
    for (let k = 0; k < (THOROUGH ? 6 : 2); k++) {
      for (const months of [QUARTER, [QUARTER[1]]]) {
        const prog = realistic(r, N, { months });
        const x = publish(prog, 11);
        const where = `N=${N}, ${months.length} month(s), run ${k}`;
        runs++;
        // The target (docs/HIPAA.md): the headline published in at least 19 releases in 20. A refusal is
        // never a leak; it is counted.
        if (refusedRelease(x)) { refused++; continue; }
        assert.equal(typeof x.pub.funder.unduplicated.served, 'number', `${where}: the headline is published`);
        assert.ok(x.p.withheld_tables.length <= 1, `${where}: withheld ${x.p.withheld_tables}`);
        assert.ok(x.pub.funder.demographics.by_race_code.length > 0, `${where}: the race codes are published`);
        assert.deepEqual(attack(x.pub, x.truth, 11), [], where);
        withheld += x.p.withheld_tables.length;
      }
    }
  }
  assert.ok(refused * 20 <= runs, `${refused} of ${runs} refused`);
  if (process.env.SUDS_PERF_VERBOSE) console.log(`[release] realistic programmes: ${runs - refused} of ${runs} published, ${withheld} tables withheld`);
});

test('the headline is never hidden beside figures that bound it: new admissions and episodes opened go with it', () => {
  // A 13-client programme (frontline review): people served hidden, 13 new admissions and 12 episodes opened shown.
  const people = many(13, (i) => person({ gender: i < 7 ? 'f' : 'm' }));
  const prog = figuresOf({ people, episodes: many(12, () => ({ opened: 'in', state: 'open' })), funds: [{ id: 'C', use: null, active: true }] });
  prog.inputs.funder.unduplicated.new_admissions = 13;
  const { p, pub, truth } = publish(prog, 11);
  assert.ok(!p.refused, JSON.stringify(p.refused));
  const u = pub.funder.unduplicated;
  assert.equal(typeof u.served, 'string', 'seven women and six men: the total is hidden with them');
  assert.equal(u.new_admissions, 'suppressed'); assert.equal(pub.funder.episodes.admissions, 'suppressed');
  assert.deepEqual(attack(pub, truth, 11), []);
  // The same in a run that is not a publication release (server/funder-report.js suppress): 11 women and one
  // man hide the total there, and the new admissions and episodes opened go with it. Nothing is hidden in an exact run.
  const FR = require('../server/funder-report');
  const twelve = figuresOf({ people: many(12, (i) => person({ gender: i < 11 ? 'f' : 'm' })), episodes: many(12, () => ({ opened: 'in', state: 'open' })), funds: [{ id: 'C', use: null, active: true }] }).inputs.funder;
  twelve.unduplicated.new_admissions = 12;
  const sup = FR.suppress(JSON.parse(JSON.stringify(twelve)), { threshold: 11, exact: false });
  assert.equal(typeof sup.unduplicated.served, 'string');
  assert.equal(sup.unduplicated.new_admissions, 'suppressed'); assert.equal(sup.episodes.admissions, 'suppressed');
  const exact = FR.suppress(JSON.parse(JSON.stringify(twelve)), { threshold: 11, exact: true });
  assert.deepEqual([exact.unduplicated.served, exact.unduplicated.new_admissions, exact.episodes.admissions], [12, 12, 12]);
});

test('degrade, not refuse: a table the check cannot show protected is withheld with its reason, and the rest of the release is published', () => {
  const { _about, T, ...spec } = require('./fixtures/degraded-release.json');
  const prog = figuresOf(spec);
  const x = publish(prog, T);
  assert.ok(!x.p.refused, JSON.stringify(x.p.refused));
  assert.deepEqual(x.p.audit.degraded, ['by_funding_source']);
  const why = x.p.withheld_reasons.find(r => r.table === 'by_funding_source');
  assert.equal(why.reason, 'check'); assert.equal(why.label, 'People and services by funding source'); assert.match(why.why, /could not confirm/);
  assert.ok(x.pub.funder.by_funding_source.every(f => f.clients_served === 'withheld'), JSON.stringify(x.pub.funder.by_funding_source));
  assert.ok(x.pub.funder.demographics.by_gender.length > 0, 'the rest is published');
  assert.deepEqual(attack(x.pub, x.truth, T), []);
  // Without the degrade step the same figures are refused whole (1.12.4).
  const whole = publish(prog, T, { degrade: false });
  assert.ok(whole.p.refused, 'refused without it');
  // The withholding depends on figures the release does not print, so the degraded release is checked against
  // worlds that would have been degraded the same way (server/sdc.js protect): in the two-month family below
  // (T = 3) every degraded candidate is refused rather than let the withholding say the events not reversed
  // were not 2.
});

test('determinism: the same figures give the same release, cell for cell', () => {
  const PR = require('../server/publication-release');
  const r = rng(99);
  for (let run = 0; run < (THOROUGH ? 20 : 6); run++) {
    const { T, prog } = randomProgramme(r);
    const copy = { funder: JSON.parse(JSON.stringify(prog.inputs.funder)), perFund: new Map(prog.inputs.perFund), settlement: JSON.parse(JSON.stringify(prog.inputs.settlement)), domains: JSON.parse(JSON.stringify(prog.inputs.domains)) };
    const a = PR.protectFigures(prog.inputs, T); const b = PR.protectFigures(copy, T);
    assert.deepEqual(a.funder, b.funder); assert.deepEqual(a.uses, b.uses); assert.deepEqual(a.ndp, b.ndp); assert.equal(a.id, b.id);
  }
});

// ---- the reviewer's shapes against 1.12.2 (row presence, episodes, doses) ----
const YEAR_2024 = Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, '0')}`);
const shapes = {
  // One reversal by staff in each of the first k months of the year (1.12.2: ten "withheld" NDP month rows,
  // each at least 1, and "staff <11" made the reversals exactly 10, one a month).
  oneReversalPerMonth: (r) => ({ period: YEAR_2024, events: Array.from({ length: 1 + Math.floor(r() * 11) }, (_, m) => ({ month: YEAR_2024[m], reversed: true, by: 'staff', doses: 1 })) }),
  // One overdose, not reversed, reported from the community, in each of the first k months (1.12.2: the listed
  // months pinned the events).
  oneOverdosePerMonth: (r) => ({ period: YEAR_2024, events: Array.from({ length: 1 + Math.floor(r() * 11) }, (_, m) => ({ month: YEAR_2024[m], community: true })) }),
  // One or two discharges for each of k reasons (1.12.2: nine listed reasons under "Closed <11" made it 9 or 10).
  manyReasons: (r) => ({ episodes: require('../server/constants').DISCHARGE_REASONS.slice(0, 1 + Math.floor(r() * 9)).flatMap(reason => Array.from({ length: 1 + Math.floor(r() * 2) }, () => ({ opened: r() < 0.5 ? 'in' : 'before', state: 'closed', reason }))) }),
  // Episodes opened in the period, most still open at its end, a few closed (1.12.2: opened 30, open at end 25
  // and closed "<11" made it at least 5).
  episodes: (r) => { const a = 10 + Math.floor(r() * 30); const closed = Math.floor(r() * 12); return { episodes: Array.from({ length: a }, (_, i) => ({ opened: 'in', state: i < closed ? 'closed' : 'open', reason: i % 2 ? 'moved' : 'completed' })).concat(Array.from({ length: Math.floor(r() * 4) }, () => ({ opened: 'before', state: r() < 0.5 ? 'open' : 'closed', reason: 'completed' }))) }; },
  // A few reversals with many doses each, and a few with one: the doses bound the reversals both ways.
  doses: (r) => ({ events: Array.from({ length: 1 + Math.floor(r() * 12) }, () => ({ month: QUARTER[Math.floor(r() * 3)], reversed: r() < 0.7, by: r() < 0.5 ? 'staff' : 'bystander', doses: r() < 0.5 ? 20 : 1 + Math.floor(r() * 3) })) }),
};
test('property: the reviewer\'s shapes - one reversal a month, many discharge reasons, episodes, doses - leak nothing', () => {
  const r = rng(Number(process.env.PR_SEED) || 20260927);
  for (const [name, make] of Object.entries(shapes)) {
    for (let run = 0; run < 24; run++) {
      const T = [3, 5, 11][run % 3];
      const people = Array.from({ length: Math.floor(r() * 30) }, () => person());
      const prog = figuresOf({ people, funds: [{ id: 'C', use: null, active: true }], ...make(r) });
      const x = publish(prog, T);
      // At the default threshold every one of these is published; at 3 and 5 the check may refuse one.
      if (T === 11) assert.ok(!x.p.refused, `${name} run ${run}: refused`);
      if (refusedRelease(x)) continue;
      const { pub, truth } = x;
      assert.deepEqual(attack(pub, truth, T), [], `${name} run ${run}, T=${T}: ${JSON.stringify({ od: pub.funder.overdose, ep: pub.funder.episodes, ndp: pub.ndp.rows, withheld: pub.withheld })}`);
      // Every month of the period and every code of the lists has a row, or the table has none.
      const months = pub.funder.overdose.by_month.map(x => x.month);
      assert.ok(!months.length || prog.inputs.domains.months.every(m => months.includes(m)), `${name}: months ${months}`);
      const ndpMonths = pub.ndp.rows.filter(x => x.entry === 'reversal').map(x => x.date);
      assert.ok(!ndpMonths.length || prog.inputs.domains.months.every(m => ndpMonths.includes(m)), `${name}: NDP months ${ndpMonths}`);
      const reasons = pub.funder.episodes.by_discharge_reason.map(x => x.k);
      assert.ok(!reasons.length || prog.inputs.domains.discharge_reasons.every(k => reasons.includes(k)), `${name}: reasons ${reasons}`);
      for (const [rows, table] of [[pub.funder.episodes.by_discharge_reason, 'episodes.by_discharge_reason'], [pub.funder.overdose.by_administered_by, 'overdose.by_administered_by']]) {
        assert.ok(!rows.some(x => x.n === 'withheld'), `${name}: a withheld row of ${table} is printed`);
      }
    }
  }
});

test('reviewer year2: one reversal by staff each month January-October and nine discharge reasons', () => {
  const C = require('../server/constants');
  const events = YEAR_2024.slice(0, 10).map(month => ({ month, reversed: true, by: 'staff', doses: 1 }));
  const episodes = C.DISCHARGE_REASONS.map(reason => ({ opened: 'before', state: 'closed', reason }));
  const prog = figuresOf({ people: Array.from({ length: 20 }, () => person()), funds: [{ id: 'C', use: null, active: true }], events, episodes, period: YEAR_2024 });
  const { pub, truth } = publish(prog, 11);
  assert.deepEqual(attack(pub, truth, 11), []);
  // The NDP log lists all twelve months or none, never only the ten with a reversal.
  const rows = pub.ndp.rows.filter(x => x.entry === 'reversal');
  assert.ok(rows.length === 0 || rows.length === 12, JSON.stringify(rows));
  assert.ok([0, C.DISCHARGE_REASONS.length].includes(pub.funder.episodes.by_discharge_reason.length));
});

test('the attacker catches the 1.12.2 listing: rows only for the months with a reversal pin each month', () => {
  // The same figures as 1.12.2 printed them: the ten NDP rows "withheld", staff "<11". The attacker, told
  // only what was printed, finds the months pinned (so the property test would have caught defect A).
  const events = YEAR_2024.slice(0, 10).map(month => ({ month, reversed: true, by: 'staff', doses: 1 }));
  const prog = figuresOf({ people: Array.from({ length: 20 }, () => person()), funds: [{ id: 'C', use: null, active: true }], events, period: YEAR_2024 });
  const { pub, truth } = publish(prog, 11);
  const old = { ...pub, withheld: ['overdose.by_month.n', 'overdose.by_month.reversals'],
    funder: { ...pub.funder, overdose: { ...pub.funder.overdose, reversals: '<11', events: '<11', naloxone_doses: 'suppressed', by_month: YEAR_2024.slice(0, 10).map(month => ({ month, n: 'withheld', reversals: 'withheld', suppressed: true })), by_administered_by: [{ k: 'staff', n: '<11', suppressed: true }] } },
    ndp: { ...pub.ndp, rows: YEAR_2024.slice(0, 10).map(date => ({ date, entry: 'reversal', reversals: 'withheld', reversal_doses: 'withheld' })), totals: { ...pub.ndp.totals, reversals: '<11', reversal_doses: 'suppressed' } } };
  const leaks = attack(old, truth, 11);
  assert.ok(leaks.some(l => /^r:2024-\d\d .*cannot be 10/.test(l)), leaks.join('\n'));
});

test('a release the audit cannot verify is refused, never published: no node budget, no time', () => {
  // With no search budget every check answers "not protected": the audit cannot settle the release, and
  // publishes nothing (1.12.2 gave up and published it: 111 of 150 programmes leaked).
  const r = rng(555);
  let refused = 0; let published = 0;
  const runs = THOROUGH ? 150 : 30;
  for (let run = 0; run < runs; run++) {
    const { T, prog } = randomProgramme(r);
    for (const budget of [0, 1]) {
      const { p, pub, truth } = publish(prog, T, { budget });
      if (p.refused) { refused++; assert.match(p.refused.message, /cannot be published/); assert.equal(p.funder, undefined); continue; }
      published++;
      assert.deepEqual(attack(pub, truth, T), [], `run ${run}, budget ${budget}`);
    }
  }
  assert.ok(refused > (2 * runs) / 3, `refused ${refused}, published ${published}`); // most, with no budget to settle them (150 runs: > 100)
  // Out of budget (solver work, so the same figures always stop at the same point): refused, and says so.
  const { T, prog } = randomProgramme(rng(3));
  const { p } = publish(prog, T, { stepLimit: 50 });
  assert.ok(p.refused && p.refused.out_of_budget && !p.refused.backstop, JSON.stringify(p.refused));
  assert.match(p.refused.message, /reached its limit/);
  assert.deepEqual(publish(prog, T, { stepLimit: 50 }).p.audit, p.audit, 'deterministic: the same work, the same answer');
  // The wall-clock backstop, which only protects the server: refused too, and says so.
  const b = publish(prog, T, { timeLimitMs: -1 }).p;
  assert.ok(b.refused && b.refused.backstop, JSON.stringify(b.refused));
  assert.match(b.refused.message, /time limit/);
});

test('the audit stays fast with many free-text categories, and a runaway audit is refused in bounded time', () => {
  const PR = require('../server/publication-release');
  const FR = require('../server/funder-report');
  // 20,000 people, 800 small languages. Unfolded, the audit is refused at its budget rather than holding the
  // server; folded as figures() folds a release (FR.foldOf), it takes a small part of it.
  const N = 20000; const K = 800;
  const small = Array.from({ length: K }, (_, i) => ({ k: `lang${String(i).padStart(3, '0')}`, n: 1 + (i % 10) }));
  const big = { k: 'en', n: N - small.reduce((a, x) => a + x.n, 0) };
  const one = (k) => [{ k, n: N }];
  const inputsWith = (language) => ({
    funder: { unduplicated: { served: N, new_admissions: 0, with_a_referral: 0, admitted_after_referral: 0, on_mat: 0 },
      demographics: { by_gender: one('m'), by_language: language, by_housing: one('h'), by_insurance: one('i'), by_ethnicity: one('e'), by_race_code: one('unknown') },
      episodes: { admissions: 0, discharges: 0, open_at_end: 0, by_discharge_reason: [], median_length_of_stay_days: null },
      overdose: { events: 0, reversals: 0, fatal: 0, community_reported: 0, naloxone_doses: 0, by_month: [], by_administered_by: [] }, naloxone_distribution: {},
      by_funding_source: [{ id: null, name: 'No funding source', clients_served: N, services: N }], attribution: {} },
    perFund: new Map([[null, { services: N, clients_served: N }]]), settlement: { services_by_use: [], fundKeys: [] }, domains: { months: QUARTER, administered_by: [], discharge_reasons: [] },
  });
  const SDC = require('../server/sdc');
  let t = Date.now();
  const LIMIT = 20e6;
  const slow = PR.protectFigures(inputsWith([big, ...small]), 11, { stepLimit: LIMIT });
  const slowMs = Date.now() - t;
  assert.ok(slow.refused && slow.refused.out_of_budget, 'unfolded, the audit reached its budget and was refused');
  // Stopped within one solve of its budget, however long that takes on this machine.
  assert.ok(slow.audit.steps < LIMIT * 1.5, `stopped at ${slow.audit.steps}`);
  const counts = new Map([[big.k, big.n], ...small.map(x => [x.k, x.n])]);
  const fold = FR.foldOf(counts, 11);
  const folded = new Map(); for (const [k, n] of counts) folded.set(fold(k), (folded.get(fold(k)) || 0) + n);
  const rows = [...folded].map(([k, n]) => ({ k, n }));
  assert.equal(rows.filter(x => x.n < 11).length, FR.FOLD_KEEP);
  t = Date.now();
  const fast = PR.protectFigures(inputsWith(rows), 11);
  const ms = Date.now() - t;
  assert.ok(!fast.refused, JSON.stringify(fast.refused));
  assert.ok(fast.audit.steps < SDC.STEP_LIMIT / 100, `folded, K=${K}: ${fast.audit.steps} units of work`);
  if (THOROUGH) assert.ok(ms < 1000, `folded, K=${K}: ${ms} ms`);
  if (process.env.SUDS_PERF_VERBOSE) console.log(`[perf] K=${K} small languages: unfolded refused after ${slowMs} ms (${slow.audit.steps} units), folded audited in ${ms} ms (${fast.audit.steps} units)`);
});

// ---- the algorithm-aware attacker (1.12.4): every world behind a printout, through the real release ----
// SUDS is open source: an attacker can run the audit on every programme that could lie behind a printout and
// keep those that print the same (test/fixtures/pattern-attacker.js). Against 1.12.3, whose decisions to hide
// more depended on counts it did not print, "served 12" beside "on MAT <11" was printed only when one person
// was on MAT.
const { attackAll } = require('./fixtures/pattern-attacker');
function assertNoPatternLeak(name, worlds, T) {
  const { leaks, checked, refused } = attackAll(worlds, T);
  assert.ok(checked > 0, `${name}: nothing published`);
  assert.deepEqual(leaks, [], `${name}, T=${T}: ${JSON.stringify(leaks.slice(0, 6), null, 1)}`);
  return { inner: worlds.filter(w => w.inner).length, refused };
}
test('algorithm-aware attacker: the reviewer\'s cases - 12 beside <11, events 12 beside reversals <11, withheld tables', () => {
  // Reviewer, 1.12.3: 12 served with 1 on MAT printed 12 and "<11"; with 2 on MAT, "suppressed". Now what is
  // printed beside "<11" does not depend on how many are on MAT.
  const PR = require('../server/publication-release');
  const served = (n, k) => JSON.stringify(PR.protectFigures(figuresOf({ funds: [], people: many(n, i => plain({ mat: i < k })) }).inputs, 11).funder.unduplicated.served);
  for (const n of [12, 15, 20]) { const shown = [1, 2, 5, 10].map(k => served(n, k)); assert.ok(shown.every(x => x === shown[0]), `${n} served printed ${shown} with 1, 2, 5 and 10 on MAT`); }
  // Events 12, reversals "<11": the events printed the same whatever the reversals.
  const events = (e, r) => JSON.stringify(PR.protectFigures(figuresOf({ funds: [], period: ['2025-01'], people: many(20, () => plain()), events: many(e, i => ({ month: '2025-01', reversed: i < r, by: 'staff', doses: i < r ? 1 : 0 })) }).inputs, 11).funder.overdose.events);
  for (const e of [12, 16]) { const shown = [1, 2, 5, 10].map(r => events(e, r)); assert.ok(shown.every(x => x === shown[0]), `${e} events printed ${shown} with 1, 2, 5 and 10 reversals`); }
  // Every world of each family, through the real release: nothing narrows a hidden count beyond the rule.
  assertNoPatternLeak('served and on MAT', pattern.subset(25, 35, 'mat'), 11);
  assertNoPatternLeak('events and reversals', pattern.events(22, 44, 20), 11);
  // The withheld-table shapes: "served <11" with MAT and gender (1.12.3 withheld them when served was 2 or
  // more, which said it was not 1; and when MAT was not all of them, which said all were on MAT).
  assertNoPatternLeak('gender and MAT', pattern.genderMat(10, 18), 11);
});
test('algorithm-aware attacker: small programmes at thresholds 3 and 5', () => {
  for (const T of THOROUGH ? [3, 5] : [3]) {
    assertNoPatternLeak('served and on MAT', pattern.subset(3 * T + 4, 5 * T + 4, 'mat'), T);
    assertNoPatternLeak('served and referred', pattern.subset(2 * T + 2, 4 * T + 2, 'referred'), T);
    assertNoPatternLeak('gender and MAT', pattern.genderMat(2 * T + 1, 3 * T + 1), T);
    assertNoPatternLeak('events and reversals', pattern.events(3 * T, 5 * T, 20), T);
    assertNoPatternLeak('two months', pattern.months(T + 2, 2 * T + 1), T);
    assertNoPatternLeak('two funds', pattern.funds(T + 1, 2 * T), T);
    // Two small funds combined in "Other funds (n combined)" (1.14.0): test/publication-release-funds.test.js.
    // Race codes, a cover: 1.12.4 refused most 60-100 person quarters here, and let this one leak at T = 3
    // (a=2 b=2 none=3 printed "<3", "<3", "suppressed": exactly 2 each).
    assertNoPatternLeak('race codes', T === 3 ? pattern.race(10, 15) : pattern.race(12, 18), T);
  }
});

test('algorithm-aware attacker: the reviewer\'s case against 1.16.1\'s rule - two months, 36 events at T = 3 - leaks nothing (1.16.2)', () => {
  // 1.16.1 withheld the events by month from the start by a published rule (a period of at least 12T events with a
  // month of 1 to T-1 events or not reversed), and its check counted every world that printed the same through the
  // suppression and for which the rule decided the same - some of them worlds whose own release was refused. At
  // T = 3 with 36 events (the rule's gate), "E 36, R 32, the months' reversals 0 and 32" was printed only by
  // E=1+35 and E=2+34: month 2's events not reversed were not 1 (six such printouts over every split). A check
  // that runs each such world's own release cost more than the budget wherever the rule fired, and one level of
  // it still leaked, so 1.16.2 withdrew the rule (docs/architecture/ADR-0009, "Withheld by rule").
  const RA = require('../server/release-audit');
  const { T, inputs } = require('./fixtures/release-small-programme.json');
  const { model } = RA.buildModel({ ...inputs, perFund: new Map(inputs.perFund), funder: RA.prepare(inputs.funder, inputs.domains) }, T);
  assert.equal(model.preWithhold, undefined, 'no published rule');
  // A family of one total of events has every world behind the printouts that print that total (and, here, the
  // reversals), not behind those that hide it: only those are checked.
  const printed = (e, rs) => (p) => p.funder.overdose.events === e && rs.includes(p.funder.overdose.reversals);
  const check = (name, worlds, only) => {
    const { leaks, checked } = attackAll(worlds, 3, { only });
    assert.ok(checked > 0, `${name}: nothing published`);
    assert.deepEqual(leaks, [], `${name}: ${JSON.stringify(leaks.slice(0, 6), null, 1)}`);
  };
  check('two months, 36 events, 32 reversals', pattern.monthsWith(36, [32]), printed(36, [32]));
  // Every printout the reviewer found leaking: the reversals 0 to 2 and 32 (and those near 32 beside them).
  if (THOROUGH) check('two months, 36 events', pattern.monthsWith(36, [0, 1, 2, 32], [28, 29, 30, 31, 33, 34, 35, 36]), printed(36, [0, 1, 2, '<3', 32]));
});

test('reviewer reproduction (1.12.4 market review): six race codes of about ten people each publish, with the small one protected', () => {
  // 80 people, race codes 17, 12, 11, 15, 16 and 9. 1.12.4 hid code 1 only when it pinned code 7 from below
  // (at most 24), which said code 7 was at least 2, and refused the quarter.
  const codes = [['1', 17], ['2', 12], ['3', 11], ['5', 15], ['6', 16], ['7', 9]];
  const people = codes.flatMap(([code, n]) => many(n, (i) => person({ race: [code], gender: i % 3 ? 'm' : 'f', mat: i % 4 === 0 })));
  const prog = figuresOf({ people, funds: [{ id: 'C', use: null, active: true }] });
  const { p, pub, truth } = publish(prog, 11);
  assert.ok(!p.refused, JSON.stringify(p.refused));
  assert.equal(pub.funder.unduplicated.served, 80);
  const race = Object.fromEntries(pub.funder.demographics.by_race_code.map(x => [x.k, x.n]));
  assert.equal(race['7'], '<11');
  assert.equal(race['1'], 'suppressed', 'the first code shown is hidden whatever it is, because the printout alone would let it pin code 7');
  assert.deepEqual(p.withheld_tables, []);
  assert.deepEqual(attack(pub, truth, 11), []);
  // Whatever code 1 is, from 17 to 40, the release prints the same: its hiding says nothing about code 7.
  const shown = [17, 25, 40].map((n) => { const ppl = [['1', n], ...codes.slice(1)].flatMap(([code, k]) => many(k, (i) => person({ race: [code], gender: i % 3 ? 'm' : 'f', mat: i % 4 === 0 }))); return JSON.stringify(publish(figuresOf({ people: ppl, funds: [{ id: 'C', use: null, active: true }] }), 11).pub.funder.demographics.by_race_code.find(x => x.k === '1')); });
  assert.ok(shown.every(x => x === shown[0]), shown.join(' '));
});

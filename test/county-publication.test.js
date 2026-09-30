'use strict';
// County publication releases (built for 1.21.0, not yet released; server/county-publication.js,
// server/county-publication-audit.js, the routes in server/routes/county.js; docs/COUNTY-VIEW.md "Publication"):
// the publication screen over the combined county release. Permissions (county:manage prepares, publishes and
// withdraws; county:view reads; export:read downloads), the screening (the same small-cell method as a programme's own
// release, audited against the county total and each programme's own published figures), a differencing attack,
// refusal when the check cannot protect a release, determinism, the immutable record and its withdrawal, the files,
// figures entered by the county (counted and named, or left out), overlapping periods, and the read API.
//
// Each test stands on its own: freshCounty() starts it from no programmes (the releases table is append-only by
// design, so each test publishes periods of its own).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const K = require('../server/county');
const PR = require('../server/publication-release');
const CPA = require('../server/county-publication-audit');
const SAMPLE = require('../scripts/county-sample');
const { rateLimitReset } = require('../server/app');

let base; let admin; let fin; let sup; let ro; let nav; let COUNTY; let samples;
const ok = (r, s = 201) => { assert.equal(r.status, s, typeof r.data === 'string' ? r.data.slice(0, 300) : JSON.stringify(r.data)); return r.data; };
const lastAudit = (action) => { const a = H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return a ? { ...a, details: a.details ? JSON.parse(a.details) : null } : null; };
const T = 11;

function freshCounty() {
  for (const t of ['county_connect_tokens', 'county_submissions', 'county_programme_keys', 'county_programmes']) H.db.run(`DELETE FROM ${t}`);
}
/** One fund of figures as the Enter figures form sends them; `people` sets every screened measure (a count of people or events). */
function fund(people, extra = {}) {
  const p = String(people);
  return { name: 'County settlement share', grant_number: 'OSF-1', category: 'core_h', hiaa: 'hiaa_4', spend_own_category: '1000.50', spend_other_categories: '0', spend_pending: '25',
    contacts: '120', naloxone_kits: '80', fentanyl_strips: '300', syringes: '900', education_contacts: '5', staff_training_hours: '12.5',
    reversals: p, treatment_admissions: p, referrals_made: p, people_served: p, people_linked: p, moud_linked: p, people_trained: p, ...extra };
}
/** A programme not on SUDS with the county's figures for each period: [[period, people], ...]. */
async function programme(name, figures) {
  const p = ok(await admin.post('/api/county/programmes', { name, not_on_suds: true }));
  for (const [period, people, extra] of figures) ok(await admin.post(`/api/county/programmes/${p.id}/entries`, { ...period, source_ref: 'Quarterly report', funds: [fund(people, extra)] }));
  return p;
}
const prepare = (body, c = admin) => c.post('/api/county/publications/prepare', body);
const publish = (body, c = admin) => c.post('/api/county/publications', body);
const screenedRow = (content, key) => content.rows.find(r => r.group === 'outcome' && r.key === key);
// Periods: every test uses its own years, so that the append-only releases of one never overlap another's.
const Q = (y, q) => ({ from: `${y}-${String(q * 3 - 2).padStart(2, '0')}-01`, to: `${y}-${String(q * 3).padStart(2, '0')}-${q === 1 || q === 4 ? 31 : 30}` });

/**
 * The differencing attack: a reader holds the county's release and each programme's own release, which shows its
 * figure when 0 or at least T and "<T" when 1 to T-1. For each screened measure, the programmes' small figures are
 * enumerated over the worlds that print the same; each must still be able to be the lowest small value the symbols
 * allow, and range over ceil(T/2) values (docs/HIPAA.md; test/fixtures/pattern-attacker.js asks the same). Returns the leaks.
 */
function differencingLeaks(values, content, T) {
  const P = Math.ceil(T / 2); const leaks = [];
  for (const m of CPA.SCREENED) {
    const shown = screenedRow(content, m).value;
    const own = values.map(v => v[m]);
    const small = own.map((x, i) => (x > 0 && x < T ? i : -1)).filter(i => i >= 0);
    if (!small.length) continue;
    const known = own.reduce((n, x) => n + (x > 0 && x < T ? 0 : x), 0);
    // Every split of the small programmes' figures (each 1 to T-1).
    const worlds = []; const rec = (i, acc) => { if (i === small.length) { worlds.push(acc); return; } for (let x = 1; x < T; x++) rec(i + 1, [...acc, x]); };
    rec(0, []);
    const total = (w) => known + w.reduce((a, b) => a + b, 0);
    const cls = (v) => (v === 0 ? '0' : v < T ? 'small' : 'big');
    const printsSame = (w) => (typeof shown === 'number' ? total(w) === shown : shown === `<${T}` ? cls(total(w)) === 'small' : shown === 'suppressed' ? total(w) >= T : true);
    const symbolic = (w) => (typeof shown === 'number' ? cls(total(w)) === cls(shown) : printsSame(w));
    small.forEach((prog, j) => {
      const vs = [...new Set(worlds.filter(printsSame).map(w => w[j]))].sort((a, b) => a - b);
      const sym = [...new Set(worlds.filter(symbolic).map(w => w[j]))].sort((a, b) => a - b);
      const L = sym[0]; const U = sym[sym.length - 1];
      if (!vs.includes(L)) leaks.push(`${m}: programme ${prog} cannot be ${L} (${vs.join(',')})`);
      else if (vs[vs.length - 1] - vs[0] < Math.min(P - 1, U - L)) leaks.push(`${m}: programme ${prog} ranges only ${vs.join(',')}`);
    });
    if (shown === 'suppressed') {
      const ts = worlds.filter(printsSame).map(total);
      if (Math.max(...ts) - Math.min(...ts) < P) leaks.push(`${m}: the suppressed total spans less than ${P}`);
    }
  }
  return leaks;
}

before(async () => {
  base = await H.start();
  H.db.setSetting('org_name', 'Publication Test County');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['cpfin', 'finance'], ['cpsup', 'supervisor'], ['cpro', 'readonly'], ['cpnav', 'navigator']]) H.makeUser(u, role);
  fin = H.client(); await fin.login('cpfin', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('cpsup', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('cpro', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('cpnav', 'StaffPassw0rd!x');
  COUNTY = { county_code: K.countyCode().code, county_name: 'Publication Test County' };
});
after(async () => { await H.stop(); });
beforeEach(() => { freshCounty(); for (const u of H.db.all(`SELECT id FROM users`)) rateLimitReset(`county-entry-refuse:${u.id}`); rateLimitReset('county-connect:127.0.0.1'); rateLimitReset('county-connect-bad:127.0.0.1'); });

// Hashes and ids are hex and can contain a figure's digits by chance: look for a figure outside them.
const noHex = (t) => String(t).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/[0-9a-f]{16,}/gi, '');
const hasFigure = (t, n) => new RegExp(`(^|[^0-9A-Za-z])${n}([^0-9A-Za-z]|$)`).test(noHex(t));

test('permissions: county:manage prepares, publishes and withdraws; county:view reads; export:read downloads; the rest are refused', async () => {
  const q = Q(2021, 1);
  await programme('Harbor Outreach', [[q, 200]]); await programme('Ridge Recovery', [[q, 150]]);
  const p = ok(await prepare(q), 200);
  for (const c of [fin, sup, ro, nav]) {
    assert.equal((await prepare(q, c)).status, 403);
    assert.equal((await publish({ ...q, sha256: p.sha256, reviewed: true }, c)).status, 403);
  }
  const rec = ok(await publish({ ...q, sha256: p.sha256, reviewed: true }));
  for (const c of [fin, sup]) {
    assert.equal(ok(await c.get('/api/county/publications'), 200).rows.length, 1);
    assert.equal(ok(await c.get(`/api/county/publications/${rec.id}`), 200).sha256, rec.sha256);
    assert.equal((await c.post(`/api/county/publications/${rec.id}/withdraw`, { reason: 'wrong period' })).status, 403);
  }
  // Finance holds export:read; a supervisor does not by default.
  assert.equal((await fin.raw(`/api/county/publications/${rec.id}/export`)).status, 200);
  for (const c of [ro, nav]) {
    assert.equal((await c.get('/api/county/publications')).status, 403);
    assert.equal((await c.get(`/api/county/publications/${rec.id}`)).status, 403);
    assert.equal((await c.raw(`/api/county/publications/${rec.id}/export`)).status, 403);
  }
  assert.equal((await admin.get('/api/county/publications/nope')).status, 404);
});

test('the release screens counts of people by the programme method, keeps money and other counts exact, and says nothing identifying', async () => {
  const q = Q(2021, 2);
  await programme('Harbor Outreach', [[q, 200]]); await programme('Ridge Recovery', [[q, 150]]);
  const p = ok(await prepare(q), 200);
  const c = p.content;
  assert.equal(c.format, 'suds-county-publication'); assert.equal(c.schema_version, 1); assert.deepEqual(c.period, { from: q.from, to: q.to });
  assert.equal(c.method.threshold, T); assert.deepEqual(c.method.screened_measures, CPA.SCREENED);
  assert.deepEqual(c.programmes.map(x => x.name), ['Harbor Outreach', 'Ridge Recovery']);
  for (const m of CPA.SCREENED) { const r = screenedRow(c, m); assert.equal(r.value, 350, m); assert.equal(r.screened, true); assert.ok(!r.suppressed); }
  assert.equal(screenedRow(c, 'naloxone_kits').value, 160); assert.ok(!screenedRow(c, 'naloxone_kits').screened);
  assert.equal(c.rows.find(r => r.key === 'spend_approved').value, 2001);
  assert.deepEqual(c.suppressed, []); assert.deepEqual(c.withheld, []);
  // Aggregates only: no programme's own figures (no "by"), no client, no file or record.
  assert.ok(c.rows.every(r => !('by' in r)));
  assert.ok(!/client|dob|birth|sha256|fingerprint|received/i.test(JSON.stringify(c).replace(/program's own|programs' own|program\\'s own/g, '')), 'no client-level or file-level keys');
  assert.equal(p.sha256, K.sha256Hex(K.canonical(c)));
  const a = lastAudit('county.publication.prepare');
  assert.equal(a.details.sha256, p.sha256); assert.equal(a.details.threshold, T); assert.deepEqual(a.details.suppressed, []);
  assert.ok(!hasFigure(JSON.stringify(a.details), 350), 'no figure in the audit entry');
  // Nothing is recorded by preparing.
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_publications WHERE period_from=?`, q.from).n, 0);
});

test('a differencing attack: a small programme beside others that publish their own figures - the total is suppressed, and no small figure can be worked out', async () => {
  const q = Q(2021, 3);
  await programme('Harbor Outreach', [[q, 200]]); await programme('Tiny Mobile Unit', [[q, 7]]); await programme('Ridge Recovery', [[q, 150]]);
  const c = ok(await prepare(q), 200).content;
  for (const m of CPA.SCREENED) {
    const r = screenedRow(c, m);
    // 357 - 200 - 150 = 7: the total cannot be printed beside the other programmes' own releases.
    assert.equal(r.value, 'suppressed', m); assert.equal(r.suppressed, 'complementary');
  }
  assert.ok(!hasFigure(JSON.stringify(c), 357), 'the suppressed total is never given');
  const s = c.suppressed.find(x => x.key === 'people_served');
  assert.equal(s.shown, 'suppressed'); assert.match(s.why, /subtracting the other programs' own published figures/);
  assert.deepEqual(differencingLeaks([{}, {}, {}].map((_, i) => Object.fromEntries(CPA.SCREENED.map(m => [m, [200, 7, 150][i]]))), c, T), []);
  // What a naive release would have printed leaks (the attack finds it): the check is not vacuous.
  const naive = { rows: CPA.SCREENED.map(m => ({ group: 'outcome', key: m, value: 357 })) };
  assert.ok(differencingLeaks([200, 7, 150].map(v => Object.fromEntries(CPA.SCREENED.map(m => [m, v]))), naive, T).length > 0);
});

test('differencing attack over many shapes: several small programmes, zeros, one programme alone, a small county total - no leak, and the release is deterministic', () => {
  const shapes = [[3], [0, 0, 5], [200, 3, 4], [200, 5, 6, 4], [7, 5, 120], [10, 10, 10], [30, 1, 2, 3, 4], [11, 12, 1], [0, 9, 0, 300], [2, 2], [50, 60, 70]];
  for (const shape of shapes) {
    const values = shape.map(v => Object.fromEntries(CPA.SCREENED.map(m => [m, v])));
    const inputs = { programmes: values.map(v => ({ values: v })) };
    const r = CPA.protectCounty(inputs, T);
    assert.ok(!r.refused, `${shape}: ${JSON.stringify(r.refused)}`);
    const content = { rows: CPA.SCREENED.map(m => ({ group: 'outcome', key: m, value: r.shown[m] })) };
    assert.deepEqual(differencingLeaks(values, content, T), [], `${shape}: ${JSON.stringify(r.shown)}`);
    // Deterministic: the same figures give the same release.
    assert.deepEqual(CPA.protectCounty(inputs, T).shown, r.shown);
    assert.equal(CPA.protectCounty(inputs, T).id, r.id);
  }
  // A small county total is "<T"; a total of big programmes is printed.
  const one = CPA.protectCounty({ programmes: [{ values: Object.fromEntries(CPA.SCREENED.map(m => [m, 3])) }] }, T);
  assert.equal(one.shown.people_served, '<11'); assert.equal(one.reason.people_served, 'small');
  assert.equal(CPA.protectCounty({ programmes: [50, 60].map(v => ({ values: Object.fromEntries(CPA.SCREENED.map(m => [m, v])) })) }, T).shown.people_served, 110);
});

test('the sdc generalisation: a cell another release prints (fixed) is never hidden or withheld, and its table is never the one withheld', () => {
  const r = CPA.protectCounty({ programmes: [200, 7, 150].map(v => ({ values: Object.fromEntries(CPA.SCREENED.map(m => [m, v])) })) }, T);
  assert.ok(r.parts.length > 1, 'the measures are audited in groups that share no relationship');
  for (const { model, status } of r.parts) model.vars.forEach((v, i) => { if (v.fixed) assert.equal(status[i], v.value > 0 && v.value < T ? 'pri' : 'vis', v.id); });
  assert.ok(r.withheld_tables.every(t => t.startsWith('total.')));
});

test('determinism and the record: preparing twice gives the same hash; publishing needs the review and the hash reviewed; the record is immutable', async () => {
  const q = Q(2021, 4);
  await programme('Harbor Outreach', [[q, 200]]); await programme('Tiny Mobile Unit', [[q, 7]]);
  const a = ok(await prepare(q), 200); const b = ok(await prepare(q), 200);
  assert.equal(a.sha256, b.sha256); assert.deepEqual(a.content, b.content);
  // No review confirmed: 428; a hash that is not the figures': 409, audited.
  const noReview = await publish({ ...q, sha256: a.sha256 });
  assert.equal(noReview.status, 428); assert.equal(noReview.data.reason, 'review_required');
  const stale = await publish({ ...q, sha256: 'f'.repeat(64), reviewed: true });
  assert.equal(stale.status, 409); assert.equal(stale.data.reason, 'changed');
  assert.equal(lastAudit('county.publication.refuse').details.reason, 'changed');
  const rec = ok(await publish({ ...q, sha256: a.sha256, reviewed: true }));
  assert.equal(rec.sha256, a.sha256); assert.equal(rec.status, 'published'); assert.equal(rec.threshold, T); assert.equal(rec.entered, 'include');
  assert.deepEqual(rec.content, a.content); assert.equal(rec.published_by, H.db.one(`SELECT display_name FROM users WHERE username='admin'`).display_name);
  const row = H.db.one(`SELECT * FROM county_publications WHERE id=?`, rec.id);
  assert.equal(K.sha256Hex(row.content), rec.sha256, 'the hash is of exactly what is stored');
  assert.equal(JSON.parse(row.method).threshold, T);
  const au = lastAudit('county.publication.publish');
  assert.equal(au.entity_id, rec.id); assert.equal(au.details.sha256, rec.sha256); assert.deepEqual(au.details.suppressed.sort(), CPA.SCREENED.map(m => `${m}:complementary`).sort());
  assert.ok(!/"207"|:207\b/.test(JSON.stringify(au.details)));
  // Immutable in the database itself.
  assert.throws(() => H.db.run(`UPDATE county_publications SET content='{}' WHERE id=?`, rec.id), /append-only/);
  assert.throws(() => H.db.run(`UPDATE county_publications SET sha256='x', created_by=NULL WHERE id=?`, rec.id), /append-only/);
  assert.throws(() => H.db.run(`DELETE FROM county_publications WHERE id=?`, rec.id), /append-only/);
  // A later file changes the figures: the hash reviewed no longer matches (and the period is published anyway).
  await programme('Late Programme', [[q, 40]]);
  assert.equal((await prepare(q)).status, 409);
});

test('withdraw: a record of its own, with the reason kept encrypted; a second withdrawal is refused; a withdrawn release still blocks overlapping periods', async () => {
  const y = Q(2022, 1); const year = { from: '2022-01-01', to: '2022-12-31' };
  await programme('Harbor Outreach', [[y, 200]]); await programme('Ridge Recovery', [[y, 150]]);
  const p = ok(await prepare(y), 200);
  const rec = ok(await publish({ ...y, sha256: p.sha256, reviewed: true }));
  assert.equal((await admin.post(`/api/county/publications/${rec.id}/withdraw`, { reason: '' })).status, 400);
  const w = ok(await admin.post(`/api/county/publications/${rec.id}/withdraw`, { reason: 'A grantee corrected its figures' }), 200);
  assert.equal(w.status, 'withdrawn'); assert.ok(w.withdrawal.at);
  const rows = H.db.all(`SELECT * FROM county_publications WHERE period_from=? ORDER BY created_at`, y.from);
  assert.equal(rows.length, 2); assert.equal(rows[1].kind, 'withdrawal'); assert.equal(rows[1].release_id, rec.id);
  assert.ok(!rows[1].reason_enc.includes('grantee'), 'the reason is encrypted');
  assert.equal(H.db.one(`SELECT content FROM county_publications WHERE id=?`, rec.id).content, rows[0].content, 'the release is unchanged');
  const a = lastAudit('county.publication.withdraw'); assert.equal(a.entity_id, rec.id); assert.ok(!JSON.stringify(a.details).includes('grantee'), 'the typed reason is not in the audit log');
  assert.equal(ok(await admin.get(`/api/county/publications/${rec.id}`), 200).withdrawal.reason, 'A grantee corrected its figures');
  assert.ok(!('reason' in ok(await fin.get(`/api/county/publications/${rec.id}`), 200).withdrawal), 'the reason is for county:manage');
  assert.equal((await admin.post(`/api/county/publications/${rec.id}/withdraw`, { reason: 'again' })).status, 409);
  // The same quarter, and the year around it, cannot be published: they could be subtracted from what was seen.
  for (const period of [y, year]) { const r = await prepare(period); assert.equal(r.status, 409); assert.equal(r.data.reason, 'overlap'); }
  assert.equal(lastAudit('county.publication.refuse').details.reason, 'overlap');
  // The next quarter can.
  await programme('Next Quarter Programme', [[Q(2022, 2), 90]]);
  assert.equal((await prepare(Q(2022, 2))).status, 200);
});

test('refusals: a period not over, a threshold below the county\'s, no figures, and a release the check cannot protect (audited with why)', async () => {
  const today = require('../server/routes/budget').localDate();
  const r1 = await prepare({ from: '2023-01-01', to: today }); assert.equal(r1.status, 400); assert.equal(r1.data.reason, 'period');
  assert.equal((await prepare({ from: '2023-02-30', to: '2023-03-31' })).status, 400);
  assert.equal((await prepare({ ...Q(2023, 1), threshold: 5 })).status, 400);
  assert.equal((await prepare({ ...Q(2023, 1), entered: 'maybe' })).status, 400);
  const none = await prepare(Q(2023, 1)); assert.equal(none.status, 422); assert.equal(none.data.reason, 'no_figures');
  await programme('Harbor Outreach', [[Q(2023, 2), 200]]); await programme('Tiny Mobile Unit', [[Q(2023, 2), 7]]);
  // A check with no budget cannot show the small figure protected: refused, never published unverified.
  PR.setAuditOptions({ stepLimit: 1 });
  try {
    const r = await prepare(Q(2023, 2));
    assert.equal(r.status, 422); assert.equal(r.data.reason, 'refused'); assert.match(r.data.error, /cannot be published/);
    const a = lastAudit('county.publication.refuse'); assert.equal(a.details.reason, 'budget'); assert.equal(a.success, 0);
  } finally { PR.setAuditOptions({}); }
  // A raised threshold is allowed and recorded.
  const hi = ok(await prepare({ ...Q(2023, 2), threshold: 20 }), 200);
  assert.equal(hi.content.method.threshold, 20); assert.equal(hi.threshold, 20);
});

test('figures entered by the county: counted and named by default (signed outranks entered, as the combined view), or left out', async () => {
  const q = Q(2024, 1);
  samples = SAMPLE.sample({ periods: [q], recipient: COUNTY });
  ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, compared: true }));
  ok(await admin.post('/api/county/submissions', { text: JSON.stringify(samples[0].files[0].file) }));
  await programme('Canyon Paper Reports', [[q, 60]]);
  const inc = ok(await prepare(q), 200).content;
  assert.deepEqual(inc.figures_entered_by_the_county, { counted: true, programmes: ['Canyon Paper Reports'], left_out: [] });
  assert.equal(inc.programmes.find(p => p.name === 'Canyon Paper Reports').source, 'county_entered');
  assert.equal(inc.programmes.find(p => p.name === samples[0].name).source, 'signed');
  assert.ok(inc.notes.some(n => n.includes('Canyon Paper Reports') && n.includes(K.ENTERED_LABEL)));
  const exc = ok(await prepare({ ...q, entered: 'exclude' }), 200).content;
  assert.deepEqual(exc.figures_entered_by_the_county, { counted: false, programmes: [], left_out: ['Canyon Paper Reports'] });
  assert.deepEqual(exc.programmes.map(p => p.name), [samples[0].name]);
  assert.equal(exc.method.entered, 'exclude');
  // The same combined view decides what counts: the published totals are the view's (screened).
  const view = ok(await fin.get(`/api/county/view?from=${q.from}&to=${q.to}&entered=exclude`), 200);
  assert.equal(exc.rows.find(r => r.key === 'naloxone_kits').value, view.rows.find(r => r.key === 'naloxone_kits').total);
  const p = ok(await prepare({ ...q, entered: 'exclude' }), 200);
  const rec = ok(await publish({ ...q, entered: 'exclude', sha256: p.sha256, reviewed: true }));
  assert.equal(rec.entered, 'exclude'); assert.equal(lastAudit('county.publication.publish').details.entered, 'exclude');
});

test('files: CSV and Excel with a Notes sheet that says what was suppressed and why (never the value); JSON; audited', async () => {
  const q = Q(2024, 2);
  await programme('Harbor Outreach', [[q, 200]]); await programme('Tiny Mobile Unit', [[q, 7]]);
  const p = ok(await prepare(q), 200);
  const rec = ok(await publish({ ...q, sha256: p.sha256, reviewed: true }));
  const csv = await admin.raw(`/api/county/publications/${rec.id}/export`);
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), new RegExp(`suds-county-publication-${q.from}_${q.to}\\.csv`));
  assert.equal(csv.headers.get('x-suds-report-purpose'), 'publication');
  const text = await csv.text();
  assert.ok(text.includes(rec.sha256)); assert.ok(text.includes('Suppressed or withheld')); assert.ok(!hasFigure(text, 207), 'the suppressed total is not in the file');
  const xl = await admin.raw(`/api/county/publications/${rec.id}/export?format=xlsx`);
  assert.equal(xl.status, 200);
  const sheets = require('../server/spreadsheet').readWorkbook(Buffer.from(await xl.arrayBuffer()));
  assert.deepEqual(sheets.map(s => s.name), ['About', 'Figures', 'Notes']);
  const notes = sheets.find(s => s.name === 'Notes').rows;
  assert.ok(notes.some(r => r.some(c => /People served/.test(String(c)))) && notes.some(r => r.some(c => /subtracting/.test(String(c)))));
  assert.ok(!hasFigure(JSON.stringify(sheets), 207));
  const js = await admin.raw(`/api/county/publications/${rec.id}/export?format=json`);
  const j = await js.json(); assert.equal(j.sha256, rec.sha256); assert.equal(K.sha256Hex(K.canonical(j.release)), rec.sha256, 'the JSON carries exactly the release hashed');
  const a = lastAudit('county.publication.export'); assert.equal(a.details.format, 'json'); assert.equal(a.details.sha256, rec.sha256);
  // A withdrawn release's files say so.
  ok(await admin.post(`/api/county/publications/${rec.id}/withdraw`, { reason: 'superseded by the annual release' }), 200);
  const w = await admin.raw(`/api/county/publications/${rec.id}/export`);
  assert.match(w.headers.get('content-disposition'), /WITHDRAWN/); assert.match(await w.text(), /WITHDRAWN on/);
});

test('the read API lists the releases as published, with their status (read token)', async () => {
  const q = Q(2024, 3);
  await programme('Harbor Outreach', [[q, 200]]); await programme('Ridge Recovery', [[q, 150]]);
  const p = ok(await prepare(q), 200);
  const rec = ok(await publish({ ...q, sha256: p.sha256, reviewed: true }));
  ok(await admin.put('/api/county-connect/settings', { enabled: true }), 200);
  try {
    const rt = ok(await admin.post('/api/county-connect/tokens', { scope: 'county.read', name: 'Dashboard' }));
    const res = await fetch(`${base}/api/county-connect/v1/publications`, { headers: { Authorization: `Bearer ${rt.token}` } });
    assert.equal(res.status, 200);
    const d = await res.json();
    const mine = d.rows.find(x => x.id === rec.id);
    assert.equal(mine.sha256, rec.sha256); assert.equal(mine.status, 'published'); assert.equal(K.sha256Hex(K.canonical(mine.release)), rec.sha256);
    assert.equal(lastAudit('county.api.read').details.what, 'publications');
    assert.equal((await fetch(`${base}/api/county-connect/v1/publications`)).status, 401);
  } finally { ok(await admin.put('/api/county-connect/settings', { enabled: false }), 200); }
  assert.equal((await fetch(`${base}/api/county-connect/v1/publications`)).status, 404, 'off: as if it did not exist');
});

test('the releases table is declared office-only with its encrypted reason, and the routes are office-only', () => {
  const SYNC = require('../server/sync-tables');
  assert.ok(SYNC.server_only.includes('county_publications'));
  assert.deepEqual(SYNC.unsynced_enc.county_publications, ['reason_enc']);
  const { LOCAL_ROUTE_MODULES } = require('../server/app');
  assert.ok(!LOCAL_ROUTE_MODULES.includes('county') && !LOCAL_ROUTE_MODULES.includes('county-connect'));
});

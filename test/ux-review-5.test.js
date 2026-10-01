'use strict';
// The frontline-UX and market reviews of 1.15.3 (fixed in 1.16.0). What the API decides: yes/no questions
// nobody asked stored as "not asked" rather than "no" (and SUPRT-A not reading them as "no"); SUPRT-A complete
// only with every section its assessment point asks, coded answers checked; returned or reopened time told to
// the worker as a to-do; the note viewer naming the client; Home's Calls tile scoped like its other tiles; a
// signed note closing its "finish and sign" reminder; finance running the syringe services summary and SUPRT-A
// completion rates; settlement people served per activity; and a county template with kits, strips and
// reversals, or with one row per fund of another type.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

const PW = 'StaffPassw0rd!x';
let admin, nav, nav2, sup, fin, ro, clin, U = {};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
// A CSV with quoted fields (labels carry commas), as the exports write it.
function csvRows(text) {
  const out = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\r') { /* part of \r\n */ } else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out.filter(r => r.length > 1 || r[0]);
}

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  for (const [k, role] of [['nav', 'navigator'], ['nav2', 'navigator'], ['sup', 'supervisor'], ['fin', 'finance'], ['ro', 'readonly'], ['clin', 'clinician']]) U[k] = H.makeUser(`r5${k}`, role).id;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('r5nav', PW);
  nav2 = H.client(); await nav2.login('r5nav2', PW);
  sup = H.client(); await sup.login('r5sup', PW);
  fin = H.client(); await fin.login('r5fin', PW);
  ro = H.client(); await ro.login('r5ro', PW);
  clin = H.client(); await clin.login('r5clin', PW);
});
after(H.stop);

const row = (id) => H.db.one(`SELECT veteran, overdose_history, justice_involved, pregnant_or_parenting, co_occurring_mh, naloxone_provided FROM clients WHERE id=?`, id);

test('a yes/no question nobody asked is stored as not asked (NULL), not "no": intake, Quick add, import and sync', async () => {
  const quick = await nav.post('/api/clients', { first_name: 'Nula', last_name: 'Asked', status: 'active' });
  assert.equal(quick.status, 201, JSON.stringify(quick.data));
  assert.deepEqual(row(quick.data.id), { veteran: null, overdose_history: null, justice_involved: null, pregnant_or_parenting: null, co_occurring_mh: null, naloxone_provided: 0 }, 'not asked; naloxone provided stays a fact the programme records (0)');
  // Asked and answered: yes and no are kept as given ("1"/"0" from the form's Yes/No, or booleans).
  const full = await nav.post('/api/clients', { first_name: 'Ana', last_name: 'Swered', veteran: '0', overdose_history: '1', justice_involved: false, co_occurring_mh: true, confirm_duplicate: true });
  assert.equal(full.status, 201, JSON.stringify(full.data));
  assert.deepEqual(row(full.data.id), { veteran: 0, overdose_history: 1, justice_involved: 0, pregnant_or_parenting: null, co_occurring_mh: 1, naloxone_provided: 0 });
  // Editing back to "Not asked" (the form's blank) clears it; an edit that leaves it out keeps it.
  assert.equal((await nav.put(`/api/clients/${full.data.id}`, { first_name: 'Ana', last_name: 'Swered', veteran: '' })).status, 200);
  assert.equal(row(full.data.id).veteran, null); assert.equal(row(full.data.id).overdose_history, 1);
  // What the record says, as read back.
  const got = (await nav.get(`/api/clients/${quick.data.id}`)).data;
  assert.equal(got.veteran, null); assert.equal(got.overdose_history, null);

  // Import: a blank cell is not an answer; "no" is.
  const commit = await admin.post('/api/imports/data/commit', { entity: 'clients', records: [
    { first_name: 'Imp', last_name: 'Blank', overdose_history: null },
    { first_name: 'Imp', last_name: 'No', overdose_history: false },
  ] });
  assert.equal(commit.status, 200, JSON.stringify(commit.data)); assert.equal(commit.data.created, 2);
  const byName = (last) => H.db.all(`SELECT id, last_name_enc FROM clients WHERE created_by=?`, H.db.one(`SELECT id FROM users WHERE username='admin'`).id).find(c => require('../server/crypto').decrypt(c.last_name_enc) === last).id;
  assert.equal(row(byName('Blank')).overdose_history, null); assert.equal(row(byName('Blank')).veteran, null);
  assert.equal(row(byName('No')).overdose_history, 0);

  // A client created on a device that sends none of them: not asked, as the office's own intake stores it.
  const devId = randomUUID(); const now = iso();
  const push = await nav.post('/api/sync/push', { device_now: now, tables: { clients: [{ id: devId, client_code: 'M26-0501', first_name_enc: 'Dev', last_name_enc: 'Unasked', status: 'active', intake_date: today, created_at: now, updated_at: now }] } });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.deepEqual(row(devId), { veteran: null, overdose_history: null, justice_involved: null, pregnant_or_parenting: null, co_occurring_mh: null, naloxone_provided: 0 });
  // A device that sends an answer keeps it.
  const devId2 = randomUUID();
  await nav.post('/api/sync/push', { device_now: now, tables: { clients: [{ id: devId2, client_code: 'M26-0502', first_name_enc: 'Dev', last_name_enc: 'Answered', status: 'active', intake_date: today, veteran: 1, overdose_history: 0, created_at: now, updated_at: now }] } });
  assert.equal(row(devId2).veteran, 1); assert.equal(row(devId2).overdose_history, 0);
});

test('SUPRT-A: an unasked question is not pre-filled as "no"; a baseline is complete only with every section it asks, and coded answers are checked', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'SOR r5', source_type: 'sor_grant', total_amount: 10000, fiscal_year_start: '2025-10-01', fiscal_year_end: '2026-12-31' });
  assert.equal(f.status, 201, JSON.stringify(f.data));
  const c = await nav.post('/api/clients', { first_name: 'Sup', last_name: 'Rta', status: 'active', intake_date: '2026-01-05', housing_status: 'Couch surfing', gender: 'female', confirm_duplicate: true });
  const id = c.data.id;
  const pre = (await nav.get(`/api/clients/${id}/suprt/prefill?type=baseline&date=2026-01-10`)).data;
  for (const k of ['B_overdose_ever', 'B_overdose_since_last', 'B_co_occurring_mh', 'F_veteran']) assert.equal(pre.answers[k], undefined, `${k}: not asked on the record, so asked at the interview`);
  assert.equal(pre.answers.F_gender, 'female', 'a coded answer on the list is pre-filled');
  assert.equal(pre.answers.F_housing, undefined, 'a free-text housing value that is not on the list is not pre-filled');
  // An explicit "no" on the record is still a "no".
  const c2 = await nav.post('/api/clients', { first_name: 'Sup', last_name: 'Rtb', status: 'active', intake_date: '2026-01-05', overdose_history: false, veteran: false, confirm_duplicate: true });
  const pre2 = (await nav.get(`/api/clients/${c2.data.id}/suprt/prefill?type=baseline&date=2026-01-10`)).data;
  assert.equal(pre2.answers.B_overdose_ever, 'no'); assert.equal(pre2.answers.B_overdose_since_last, 'no'); assert.equal(pre2.answers.F_veteran, 'no');

  // Complete with only section A: refused, naming what is missing.
  const bad = await nav.post(`/api/clients/${id}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10', status: 'complete', answers: { A_first_service_date: '2026-01-05', A_suprt_c: 'not_offered' } });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.match(bad.data.error, /Trauma screening result/); assert.match(bad.data.error, /Opioid use disorder diagnosis/); assert.match(bad.data.error, /Behavioral health crisis/); assert.match(bad.data.error, /Housing status/);
  assert.ok(bad.data.fields['answers.C_trauma_screen'] && bad.data.fields['answers.F_insurance'], 'each missing question is a field error');
  // A code that is not on the list is refused.
  const coded = await nav.post(`/api/clients/${id}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10', status: 'draft', answers: { F_housing: 'Couch surfing' } });
  assert.equal(coded.status, 400); assert.ok(coded.data.fields['answers.F_housing']);
  // A draft saves with anything missing.
  assert.equal((await nav.post(`/api/clients/${id}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10', status: 'draft', answers: {} })).status, 201);
  // Every required question answered (with "don't know" where it applies): complete.
  const S = require('../server/suprt');
  const answers = { A_first_service_date: '2026-01-05', A_suprt_c: 'not_offered' };
  for (const it of S.itemsFor('baseline', answers)) if (it.required && !it.readonly && !answers[it.key] && it.type === 'choice') answers[it.key] = it.options.some(o => o.value === 'unknown') ? 'unknown' : it.options.some(o => o.value === 'not_screened') ? 'not_screened' : it.options[0].value;
  const okc = await nav.post(`/api/clients/${c2.data.id}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10', status: 'complete', answers });
  assert.equal(okc.status, 201, JSON.stringify(okc.data));
  // MOUD "yes" asks which medication.
  const moud = S.cleanAnswers('baseline', { ...answers, B_moud: 'yes' });
  assert.ok(moud.missing.includes('B_moud_medication'));
  // Items: gender, housing and insurance are lists with labels, not text boxes.
  const items = (await nav.get('/api/suprt/items')).data.items;
  for (const k of ['F_gender', 'F_housing', 'F_insurance', 'B_route_of_use']) { const it = items.find(x => x.key === k); assert.equal(it.type, 'choice', k); assert.ok(it.options.every(o => o.label && o.label !== o.value || o.value === o.label.toLowerCase()), k); }
});

test('finance reads SUPRT-A completion rates for the whole programme (counts only); read-only does not', async () => {
  const r = await fin.get(`/api/suprt/completion?from=2026-01-01&to=2026-12-31`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.baselines_recorded >= 1, 'the whole programme, not a caseload finance does not have');
  assert.ok(!JSON.stringify(r.data).includes('Rtb'), 'no client data');
  assert.equal((await fin.get('/api/suprt/due')).status, 403, 'the to-do list names clients: not for finance');
  assert.equal((await ro.get('/api/suprt/completion')).status, 403);
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='suprt.completion' ORDER BY id DESC LIMIT 1`).details);
  assert.equal(a.whole_programme, true);
});

test('returned or reopened time is a to-do for the worker, due now (the bell); approving raises none', async () => {
  const mk = async (c, d, m) => { const t = await c.post('/api/time', { work_date: d, minutes: m, category: 'documentation' }); assert.equal(t.status, 201, JSON.stringify(t.data)); await c.post(`/api/time/${t.data.id}/submit`, {}); return t.data.id; };
  const t1 = await mk(nav, '2026-09-21', 150);
  const before = H.db.one(`SELECT COUNT(*) n FROM tasks WHERE assigned_to=?`, U.nav).n;
  assert.equal((await sup.post(`/api/time/${t1}/approve`, { decision: 'rejected', note: 'Split the travel from the paperwork' })).status, 200);
  const due = (await nav.get('/api/tasks/due?within=60')).data.rows;
  const t = due.find(x => /Correct your time for 21 Sep 2026 \(2h 30m\): returned by/.test(x.title));
  assert.ok(t, JSON.stringify(due.map(x => x.title)));
  const full = (await nav.get(`/api/tasks?status=open&limit=100`)).data.rows.find(x => x.id === t.id);
  assert.match(full.description, /Returned: Split the travel from the paperwork/);
  assert.equal(H.db.one(`SELECT client_id FROM tasks WHERE id=?`, t.id).client_id, null);
  assert.equal(H.db.one(`SELECT title_enc FROM tasks WHERE id=?`, t.id).title_enc.includes('Correct'), false, 'encrypted');
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='time.rejected' ORDER BY id DESC LIMIT 1`).details);
  assert.equal(a.task, t.id); assert.ok(!JSON.stringify(a).includes('travel'), 'the reason is not in the audit entry');

  // Reopening approved time: a to-do saying so.
  const t2 = await mk(nav, '2026-09-22', 30);
  assert.equal((await sup.post(`/api/time/${t2}/approve`, { decision: 'approved' })).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM tasks WHERE assigned_to=?`, U.nav).n, before + 1, 'approval raises no to-do');
  assert.equal((await sup.post(`/api/time/${t2}/approve`, { decision: 'rejected', note: 'Wrong fund' })).status, 200);
  assert.ok((await nav.get('/api/tasks/due?within=60')).data.rows.some(x => /reopened by/.test(x.title)));

  // A batch: one to-do per worker, naming how many entries.
  const b1 = await mk(nav, '2026-09-23', 60); const b2 = await mk(nav, '2026-09-24', 45); const b3 = await mk(nav2, '2026-09-24', 20);
  const r = await sup.post('/api/time/approve-batch', { ids: [b1, b2, b3], decision: 'rejected', note: 'Add descriptions' });
  assert.equal(r.status, 200); assert.equal(r.data.rejected, 3);
  assert.ok((await nav.get('/api/tasks/due?within=60')).data.rows.some(x => /Correct 2 of your time entries/.test(x.title)));
  assert.ok((await nav2.get('/api/tasks/due?within=60')).data.rows.some(x => /Correct your time for 24 Sep 2026 \(20m\)/.test(x.title)));
});

test('the note viewer names the client: the code always, the name for a reader who may open the record', async () => {
  const c = await clin.post('/api/clients', { first_name: 'Noa', last_name: 'Viewer', status: 'active', confirm_duplicate: true });
  const n = await clin.post('/api/notes', { client_id: c.data.id, kind: 'admin', content: 'Checked in.', occurred_at: iso() });
  assert.equal(n.status, 201, JSON.stringify(n.data));
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, c.data.id).client_code;
  const g = (await clin.get(`/api/notes/${n.data.id}`)).data.note;
  assert.equal(g.client_code, code); assert.equal(g.client_name, 'Viewer, Noa');
  const s = (await sup.get(`/api/notes/${n.data.id}`)).data.note;
  assert.equal(s.client_code, code); assert.equal(s.client_name, 'Viewer, Noa');
});

test('signing a note closes the supervisor\'s "finish and sign" reminder for it, and only that one', async () => {
  const c = await clin.post('/api/clients', { first_name: 'Rem', last_name: 'Inder', status: 'active', confirm_duplicate: true });
  const n1 = (await clin.post('/api/notes', { client_id: c.data.id, kind: 'admin', content: 'Draft one.', occurred_at: iso() })).data.id;
  const n2 = (await clin.post('/api/notes', { client_id: c.data.id, kind: 'admin', content: 'Draft two.', occurred_at: iso() })).data.id;
  const remind = (id) => sup.post('/api/tasks', { client_id: c.data.id, assigned_to: U.clin, title: 'Finish and sign your administrative note', description: `Please sign it.\nReference: supervision reminder for note ${id}`, due_at: today });
  const r1 = await remind(n1); const r2 = await remind(n2);
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  assert.equal((await clin.post(`/api/notes/${n1}/sign`, { password: PW })).status, 200);
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, r1.data.id).status, 'done');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, r2.data.id).status, 'open', 'the other note\'s reminder stays');
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' ORDER BY id DESC LIMIT 1`).details);
  assert.deepEqual(a.reminders_closed, [r1.data.id]);
  // Signed on a device and pushed: the office closes the reminder too.
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, n2);
  const push = await clin.post('/api/sync/push', { device_now: iso(), tables: { notes: [{ ...row, content_enc: 'Draft two.', title_enc: null, structured_enc: null, status: 'signed', signed_by: U.clin, signed_at: iso(), signature_hash: 'x'.repeat(64), updated_at: iso(Date.now() + 5000) }] } });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, n2).status, 'signed');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, r2.data.id).status, 'done');
});

test('Home\'s Calls tile counts what a caseload-scoped worker may see, like the visits tile', async () => {
  const mine = (await nav.post('/api/clients', { first_name: 'Cal', last_name: 'Lmine', status: 'active', confirm_duplicate: true })).data.id;
  const theirs = (await nav2.post('/api/clients', { first_name: 'Cal', last_name: 'Ltheirs', status: 'active', confirm_duplicate: true })).data.id;
  const q = `from=${from}&to=${today}`;
  // From 1.16.0 a navigator holds clients:all by default; one held to their caseload has it denied.
  H.deny({ id: U.nav }, 'clients:all');
  const base = { nav: (await nav.get(`/api/reports/dashboard?${q}`)).data.calls.total, sup: (await sup.get(`/api/reports/dashboard?${q}`)).data.calls.total };
  for (const [c, cid] of [[nav, mine], [nav2, theirs], [nav2, null]]) {
    const r = await c.post('/api/calls', { client_id: cid, direction: 'outbound', started_at: iso(Date.now() - 3600000), duration_minutes: 5, contact_type: cid ? 'client' : 'other', outcome: 'reached' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  assert.equal((await nav.get(`/api/reports/dashboard?${q}`)).data.calls.total, base.nav + 1, 'their own client\'s call only: not another caseload\'s, nor another worker\'s call with no client');
  assert.equal((await sup.get(`/api/reports/dashboard?${q}`)).data.calls.total, base.sup + 3, 'a supervisor (clients:all) counts every call');
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=? AND permission='clients:all'`, U.nav);
  assert.equal((await nav.get(`/api/reports/dashboard?${q}`)).data.calls.total, (await sup.get(`/api/reports/dashboard?${q}`)).data.calls.total, 'a navigator with the 1.16.0 default (clients:all) counts every call too');
});

test('finance runs the syringe services summary as the programme\'s own submission of the whole programme', async () => {
  const q = `from=${from}&to=${today}`;
  const r = await fin.get(`/api/reports/ssp?${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.suppression.purpose, 'submission'); assert.equal(r.data.caseload_scope_note, null);
  assert.equal((await fin.get(`/api/reports/ssp?${q}&purpose=internal`)).status, 403);
  assert.equal((await fin.raw(`/api/reports/ssp/export?${q}&format=xlsx`)).status, 200);
  assert.equal((await ro.get(`/api/reports/ssp?${q}`)).status, 403, 'read-only still cannot');
});

test('settlement layouts: services and people on the activity they fall under, not repeated on every row; a county template takes kits, strips and reversals, or one row per SABG fund', async () => {
  const Q = 'from=2026-01-01&to=2026-06-30';
  await admin.put('/api/admin/settings', { org_name: 'Harbor r5' });
  const f = (await admin.post('/api/budget/funds', { name: 'AAA settlement r5', grant_number: 'OS-5', source_type: 'opioid_settlement', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 50000, settlement_use: 'core_a', settlement_hiaa: 'hiaa_6' })).data.id;
  const e1 = await sup.post('/api/budget/expenditures', { funding_source_id: f, spent_at: '2026-02-05', amount: 1000, category: 'naloxone_supplies' });
  const e2 = await sup.post('/api/budget/expenditures', { funding_source_id: f, spent_at: '2026-02-06', amount: 500, category: 'training', settlement_use: 'approved_k', settlement_hiaa: 'none' });
  for (const e of [e1, e2]) assert.equal((await admin.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'approved' })).status, 200);
  for (let i = 0; i < 12; i++) {
    const c = await sup.post('/api/clients', { first_name: 'Set', last_name: `Tle${i}`, status: 'active', confirm_duplicate: true });
    assert.equal((await sup.post('/api/interventions', { client_id: c.data.id, type: 'naloxone_distribution', occurred_at: '2026-03-01T17:00:00.000Z', funding_source_id: f, naloxone_kits: 2, fentanyl_strips: 1 })).status, 201);
  }
  for (let i = 0; i < 3; i++) assert.equal((await sup.post('/api/overdose-events', { occurred_at: '2026-03-02T17:00:00.000Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 1, funding_source_id: f })).status, 201);
  const HR = require('../server/harm-reduction-reports');
  const x = await fin.raw(`/api/reports/opioid-settlement/export?${Q}&layout=dhcs`);
  assert.equal(x.status, 200);
  const rows = csvRows(await x.text()); const head = rows[0];
  const col = (k) => head.indexOf(HR.DHCS_FIELDS.find(d => d.key === k).label);
  const ours = rows.slice(1).filter(r => r.join(',').includes('AAA settlement r5'));
  assert.equal(ours.length, 2, 'two activities');
  const own = ours.find(r => r.join(',').includes('6. The purchase of naloxone')); const training = ours.find(r => r !== own);
  assert.equal(own[col('services')], '12'); assert.equal(own[col('people_served')], '12', 'the services fall under the fund\'s own category');
  assert.equal(training[col('services')], '0'); assert.equal(training[col('people_served')], '0', 'not the fund\'s total repeated');
  assert.equal(training[col('approved_amount')], '500');

  // A county template with the new fields.
  const layout = { name: 'County r5', columns: [{ label: 'Activity', source: 'exhibit_e_category' }, { label: 'Kits', source: 'naloxone_kits' }, { label: 'Strips', source: 'fentanyl_strips' }, { label: 'Reversals', source: 'reversals' }, { label: 'People', source: 'people_served' }] };
  assert.equal((await fin.put('/api/reports/settlement-layout', { county: layout })).status, 200);
  const cr = csvRows(await (await fin.raw(`/api/reports/opioid-settlement/export?${Q}&layout=county`)).text());
  assert.deepEqual(cr[0], ['Activity', 'Kits', 'Strips', 'Reversals', 'People']);
  assert.ok(cr.some(r => r[1] === '24' && r[2] === '12' && r[3] === '10 or fewer' && r[4] === '12'), JSON.stringify(cr));
  const got = (await fin.get('/api/reports/settlement-layout')).data;
  assert.ok(got.sources.some(s => s.value === 'reversals')); assert.ok(got.fund_types.some(t => t.value === 'state_block_grant'));

  // One row per fund of another type: a county's SABG template.
  const sabg = (await admin.post('/api/budget/funds', { name: 'SABG prevention r5', grant_number: 'SABG-9', source_type: 'state_block_grant', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 20000 })).data.id;
  const quiet = (await admin.post('/api/budget/funds', { name: 'SABG idle r5', source_type: 'state_block_grant', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 })).data.id;
  assert.ok(quiet);
  const c = await sup.post('/api/clients', { first_name: 'Sab', last_name: 'G', status: 'active', confirm_duplicate: true });
  assert.equal((await sup.post('/api/interventions', { client_id: c.data.id, type: 'education', occurred_at: '2026-04-01T17:00:00.000Z', funding_source_id: sabg })).status, 201);
  const sl = { name: 'County SABG quarterly', fund_type: 'state_block_grant', columns: [{ label: 'Fund', source: 'fund_name' }, { label: 'Grant', source: 'grant_number' }, { label: 'Services', source: 'services' }, { label: 'Category', source: 'exhibit_e_category' }] };
  assert.equal((await fin.put('/api/reports/settlement-layout', { county: { ...sl, fund_type: 'no_such' } })).status, 400);
  const put = await fin.put('/api/reports/settlement-layout', { county: sl });
  assert.equal(put.status, 200, JSON.stringify(put.data)); assert.equal(put.data.county.fund_type, 'state_block_grant');
  const sr = csvRows(await (await fin.raw(`/api/reports/opioid-settlement/export?${Q}&layout=county`)).text());
  assert.deepEqual(sr.slice(1).map(r => r[0]).sort(), ['SABG idle r5', 'SABG prevention r5'], 'every active SABG fund, and no settlement fund');
  assert.deepEqual(sr.find(r => r[0] === 'SABG prevention r5'), ['SABG prevention r5', 'SABG-9', '1', ''], 'settlement-only columns blank');
  await fin.put('/api/reports/settlement-layout', { county: null });
});

test('the global API rate limit is a setting (API_RATE_LIMIT) for an office behind one address', () => {
  const config = require('../server/config');
  assert.ok(Number.isFinite(config.apiRateLimit) && config.apiRateLimit > 0);
});

// Evaluation of 1.23.1 (R7): the reminder's details ended "Reference: supervision reminder for note <record id>". 1.23.2:
// no record id; its last line says what closes it (SIGN_REMINDER), and it closes once the author has signed their
// drafts on that client's record, at the office or on a device. A 1.23.1 reminder (the id line) still closes with its note.
test('a "finish and sign" reminder carries no record id and closes once the author\'s drafts on that client are signed (1.23.2)', async () => {
  const { SIGN_REMINDER } = require('../server/rules/notes');
  const c = await clin.post('/api/clients', { first_name: 'Rem', last_name: 'Indertwo', status: 'active', confirm_duplicate: true });
  const n1 = (await clin.post('/api/notes', { client_id: c.data.id, kind: 'admin', content: 'Draft one.', occurred_at: iso() })).data.id;
  const n2 = (await clin.post('/api/notes', { client_id: c.data.id, kind: 'admin', content: 'Draft two.', occurred_at: iso() })).data.id;
  // As public/views/supervision.js sends it.
  const r = await sup.post('/api/tasks', { client_id: c.data.id, assigned_to: U.clin, title: 'Finish and sign your administrative note from Oct 1, 2026', description: `Sup asked you to finish and sign this draft note. Open it from the client's Notes tab.\n${SIGN_REMINDER}`, due_at: today });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const seen = (await clin.get('/api/tasks?mine=1&status=open&limit=1000')).data.rows.find(t => t.id === r.data.id);
  assert.ok(!seen.description.includes(n1) && !seen.description.includes(n2) && !/Reference:/.test(seen.description), 'no record id in what the worker reads');
  // The worker's own to-do with the same words is not a reminder (1.23.3: the line is refused from them; one written
  // before 1.23.3 is left alone).
  assert.equal((await clin.post('/api/tasks', { client_id: c.data.id, title: 'Mine', description: SIGN_REMINDER, due_at: today })).status, 403);
  const own = { data: { id: legacyTask(c.data.id, U.clin, U.clin, SIGN_REMINDER) } };
  assert.equal((await clin.post(`/api/notes/${n1}/sign`, { password: PW })).status, 200);
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, r.data.id).status, 'open', 'another draft on this client is still unsigned');
  // The last draft, signed on a device and pushed: the office closes the reminder.
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, n2);
  const push = await clin.post('/api/sync/push', { device_now: iso(), tables: { notes: [{ ...row, content_enc: 'Draft two.', title_enc: null, structured_enc: null, status: 'signed', signed_by: U.clin, signed_at: iso(), signature_hash: 'x'.repeat(64), updated_at: iso(Date.now() + 5000) }] } });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, r.data.id).status, 'done', 'closed once the author has no draft left there');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, own.data.id).status, 'open', 'the worker\'s own to-do is left alone');
});

// Review of 1.23.2: the reminder is recognised by its last line, which a worker could paste into any to-do someone else
// gave them; and one whose last draft was deleted rather than signed stayed open.
test('only a to-do\'s maker can make it a sign reminder; deleting the last draft closes the reminder', async () => {
  const { SIGN_REMINDER } = require('../server/rules/notes');
  const c = await clin.post('/api/clients', { first_name: 'Rem', last_name: 'Inderthree', status: 'active', confirm_duplicate: true });
  const given = await sup.post('/api/tasks', { client_id: c.data.id, assigned_to: U.clin, title: 'Call the clinic', due_at: today });
  assert.equal(given.status, 201, JSON.stringify(given.data));
  const forged = await clin.put(`/api/tasks/${given.data.id}`, { description: `Noted.\n${SIGN_REMINDER}` });
  assert.equal(forged.status, 403, JSON.stringify(forged.data));
  assert.equal((await clin.put(`/api/tasks/${given.data.id}`, { description: 'Left a message.' })).status, 200, 'other edits stand');
  const n1 = (await clin.post('/api/notes', { client_id: c.data.id, kind: 'admin', content: 'Draft.', occurred_at: iso() })).data.id;
  const r = await sup.post('/api/tasks', { client_id: c.data.id, assigned_to: U.clin, title: 'Finish and sign your administrative note', description: `Sup asked you to finish and sign this draft note.\n${SIGN_REMINDER}`, due_at: today });
  assert.equal((await clin.put(`/api/tasks/${r.data.id}`, { due_at: today })).status, 200, 'the worker can still edit a real reminder');
  assert.equal((await clin.del(`/api/notes/${n1}`)).status, 200);
  // 1.23.3 (D5): closed as cancelled, not done: nothing was signed.
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, r.data.id).status, 'cancelled', 'no draft left to sign: the reminder is cancelled');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, given.data.id).status, 'open', 'the ordinary to-do is left alone');
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.delete' AND entity_id=?`, n1).details);
  assert.deepEqual(a.reminders_closed, [r.data.id]);
  // Market evaluation of 1.23.3 (N5): the cancelled reminder has its own task.update entry, as on the push path.
  const t = H.db.all(`SELECT details FROM audit_log WHERE action='task.update' AND entity_id=?`, r.data.id).map(x => JSON.parse(x.details || '{}'));
  assert.deepEqual(t.find(d => d.cause === 'deleted'), { status: 'cancelled', cause: 'deleted', note: n1 });
});

// A to-do as it could be written before 1.23.3: straight into the table, with the details encrypted.
function legacyTask(clientId, assignedTo, createdBy, description) {
  const id = randomUUID(); const { encrypt } = require('../server/crypto');
  H.db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority,status) VALUES(?,?,?,?,?,?,?,?,?)`, id, clientId, assignedTo, createdBy, encrypt('Finish and sign your administrative note'), encrypt(description), today, 'normal', 'open');
  return id;
}

// Market evaluation of 1.23.2 (D1): any staff member could make a to-do for a colleague whose details end with the
// reminder's line; Supervision then showed the colleague's draft as reminded (and hid Remind author), and signing closed
// it. 1.23.3: only someone who may send a reminder (notes:cosign, the supervision queue's) writes the line, over REST or
// a push, and only theirs is recognised (the `sign_reminder` mark, closing on sign).
test('only a supervisor who countersigns can send a sign reminder; a forged one is refused or not counted (1.23.3)', async () => {
  const { SIGN_REMINDER } = require('../server/rules/notes');
  const c = await clin.post('/api/clients', { first_name: 'Rem', last_name: 'Inderfour', status: 'active', confirm_duplicate: true });
  const draft = (await clin.post('/api/notes', { client_id: c.data.id, kind: 'admin', content: 'Draft.', occurred_at: iso() })).data.id;
  const body = { client_id: c.data.id, assigned_to: U.clin, title: 'Finish and sign your draft notes', description: `Asked to sign.\n${SIGN_REMINDER}`, due_at: today };
  // A navigator: refused over REST, new or as an edit of their own to-do.
  const forged = await nav.post('/api/tasks', body);
  assert.equal(forged.status, 403, JSON.stringify(forged.data));
  assert.match(forged.data.error || '', /countersigns notes/);
  const plain = await nav.post('/api/tasks', { ...body, description: 'Asked to sign.' });
  assert.equal(plain.status, 201, 'an ordinary to-do for a colleague still goes');
  assert.equal((await nav.put(`/api/tasks/${plain.data.id}`, { description: `Asked to sign.\n${SIGN_REMINDER}` })).status, 403, 'nor added to their own to-do later');
  // And by a push: the row is refused.
  const pushed = randomUUID();
  const push = await nav.post('/api/sync/push', { device_now: iso(), tables: { tasks: [{ id: pushed, client_id: c.data.id, assigned_to: U.clin, created_by: U.nav, title_enc: 'Finish and sign', description_enc: `Asked.\n${SIGN_REMINDER}`, due_at: today, priority: 'normal', status: 'open', created_at: iso(), updated_at: iso() }] } });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.equal(H.db.one(`SELECT id FROM tasks WHERE id=?`, pushed), undefined, 'the pushed reminder is not stored');
  assert.ok(push.data.rejected.some(x => x.id === pushed), JSON.stringify(push.data));
  // The same to-do without the line goes: the line is what was refused.
  const plainPushed = randomUUID();
  const push2 = await nav.post('/api/sync/push', { device_now: iso(), tables: { tasks: [{ id: plainPushed, client_id: c.data.id, assigned_to: U.clin, created_by: U.nav, title_enc: 'Finish and sign', description_enc: 'Asked.', due_at: today, priority: 'normal', status: 'open', created_at: iso(), updated_at: iso() }] } });
  assert.equal(push2.data.applied.tasks, 1, JSON.stringify(push2.data));
  // One made before 1.23.3 by a navigator: not marked, so Supervision does not count it, and signing leaves it open.
  const legacy = legacyTask(c.data.id, U.clin, U.nav, `Asked to sign.\n${SIGN_REMINDER}`);
  const legacyOld = legacyTask(c.data.id, U.clin, U.nav, `Asked.\nReference: supervision reminder for note ${draft}`);
  // A real one, from the supervisor: marked, and closed (done) when the draft is signed.
  const real = await sup.post('/api/tasks', body);
  assert.equal(real.status, 201, JSON.stringify(real.data));
  const rows = (await sup.get('/api/tasks?status=open&limit=1000')).data.rows;
  const mark = (id) => !!(rows.find(t => t.id === id) || {}).sign_reminder;
  assert.equal(mark(real.data.id), true, 'the supervisor\'s reminder is marked sign_reminder');
  assert.equal(mark(legacy), false, 'the navigator\'s is not');
  assert.equal(mark(legacyOld), false, 'nor their old-style one');
  assert.equal(mark(plain.data.id), false, 'nor an ordinary to-do');
  assert.equal((await clin.post(`/api/notes/${draft}/sign`, { password: PW })).status, 200);
  const st = (id) => H.db.one(`SELECT status FROM tasks WHERE id=?`, id).status;
  assert.equal(st(real.data.id), 'done', 'the supervisor\'s reminder closes on signing');
  assert.equal(st(legacy), 'open', 'the forged one does not');
  assert.equal(st(legacyOld), 'open', 'nor the forged old-style one');
});

// Review of 1.23.3: the write check looked only for the current line, recognition for the old one too, so the
// assignee of a supervisor's ordinary to-do could append the old "Reference: … note <id>" line and pass it for a reminder.
test('the old reminder line cannot be pasted into a to-do either', async () => {
  const c = await clin.post('/api/clients', { first_name: 'Rem', last_name: 'Inderfive', status: 'active', confirm_duplicate: true });
  const given = await sup.post('/api/tasks', { client_id: c.data.id, assigned_to: U.clin, title: 'Call the client', due_at: today });
  assert.equal(given.status, 201, JSON.stringify(given.data));
  const forged = await clin.put(`/api/tasks/${given.data.id}`, { description: 'Noted.\nReference: supervision reminder for note 0123456789abcdef' });
  assert.equal(forged.status, 403, JSON.stringify(forged.data));
  const row = (await clin.get('/api/tasks?mine=1&status=open&limit=1000')).data.rows.find(t => t.id === given.data.id);
  assert.ok(!row.sign_reminder, 'not taken for a reminder');
});

// Market evaluation of 1.23.3 (N1): the assignee of a real reminder could give it to a colleague or move it to another
// client, and it still counted there (Supervision's "Sent", Remind all skipping it). Only its maker, or someone who may
// send one, changes who or which record it is about, over REST or a push.
test('the assignee of a sign reminder cannot move it to a colleague or another client (1.23.4)', async () => {
  const { SIGN_REMINDER } = require('../server/rules/notes');
  const c = await clin.post('/api/clients', { first_name: 'Rem', last_name: 'Indersix', status: 'active', confirm_duplicate: true });
  const other = await clin.post('/api/clients', { first_name: 'Rem', last_name: 'Inderseven', status: 'active', confirm_duplicate: true });
  const body = { client_id: c.data.id, assigned_to: U.clin, title: 'Finish and sign your draft notes', description: `Asked to sign.\n${SIGN_REMINDER}`, due_at: today };
  const r = await sup.post('/api/tasks', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const moved = await clin.put(`/api/tasks/${r.data.id}`, { assigned_to: U.nav, client_id: other.data.id });
  assert.equal(moved.status, 403, JSON.stringify(moved.data));
  assert.match(moved.data.error || '', /supervisor who sent this reminder/);
  assert.equal((await clin.put(`/api/tasks/${r.data.id}`, { assigned_to: U.nav })).status, 403, 'nor to a colleague alone');
  assert.equal((await clin.put(`/api/tasks/${r.data.id}`, { client_id: other.data.id })).status, 403, 'nor to another client alone');
  assert.equal((await clin.put(`/api/tasks/${r.data.id}`, { due_at: today, priority: 'high' })).status, 200, 'other edits stand');
  // A push that moves it: the row is refused and the stored one is unchanged.
  const stored = H.db.one(`SELECT * FROM tasks WHERE id=?`, r.data.id);
  const push = await clin.post('/api/sync/push', { device_now: iso(), tables: { tasks: [{ ...stored, title_enc: 'Finish and sign your draft notes', description_enc: `Asked to sign.\n${SIGN_REMINDER}`, assigned_to: U.nav, client_id: other.data.id, updated_at: iso(Date.now() + 5000) }] } });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.ok(push.data.rejected.some(x => x.id === r.data.id), JSON.stringify(push.data));
  const after = H.db.one(`SELECT assigned_to, client_id FROM tasks WHERE id=?`, r.data.id);
  assert.deepEqual({ ...after }, { assigned_to: U.clin, client_id: c.data.id });
  // An ordinary to-do someone gave them can still be passed on.
  const plain = await sup.post('/api/tasks', { ...body, description: 'Asked to sign.' });
  assert.equal((await clin.put(`/api/tasks/${plain.data.id}`, { assigned_to: U.nav })).status, 200, 'an ordinary to-do moves');
  // Its maker can still reassign it.
  assert.equal((await sup.put(`/api/tasks/${r.data.id}`, { assigned_to: U.nav, client_id: other.data.id })).status, 200, 'the maker moves it');
  assert.deepEqual({ ...H.db.one(`SELECT assigned_to, client_id FROM tasks WHERE id=?`, r.data.id) }, { assigned_to: U.nav, client_id: other.data.id });
});

// Review of 1.23.4: a caseload transfer moved the departing worker's sign reminders to the receiving worker, where they
// passed for reminders about the receiver's drafts. They are cancelled instead (the drafts stay the departing author's).
test('a caseload transfer cancels the departing worker\'s sign reminders rather than handing them on', async () => {
  const { SIGN_REMINDER } = require('../server/rules/notes');
  const c = await clin.post('/api/clients', { first_name: 'Rem', last_name: 'Indersix', status: 'active', confirm_duplicate: true });
  const r = await sup.post('/api/tasks', { client_id: c.data.id, assigned_to: U.clin, title: 'Finish and sign your draft notes', description: `Please.\n${SIGN_REMINDER}`, due_at: today });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const other = await sup.post('/api/tasks', { client_id: c.data.id, assigned_to: U.clin, title: 'Call the clinic', due_at: today });
  const to = H.makeUser(`rcv${Date.now() % 100000}`, 'clinician');
  if (!H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND end_date IS NULL`, c.data.id, U.clin)) {
    assert.equal((await sup.post(`/api/clients/${c.data.id}/assignments`, { user_id: U.clin, role_on_case: 'primary' })).status, 201);
  }
  const t = await sup.post('/api/caseload/transfer', { from_user_id: U.clin, to_user_id: to.id, client_ids: [c.data.id] });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, r.data.id).status, 'cancelled', 'the reminder is cancelled');
  assert.equal(H.db.one(`SELECT assigned_to FROM tasks WHERE id=?`, other.data.id).assigned_to, to.id, 'an ordinary to-do moves as before');
});

'use strict';
// Security review of 1.16.0 (r6): the findings fixed in 1.16.1, each at both doors (REST and sync push) where
// it has two. H2 (the columns a device may write) is test/sync-attribution.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const U = {}; const C = {};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let enc, dec;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ encrypt: enc, decrypt: dec } = require('../server/crypto'));
  for (const [k, role] of [['navA', 'navigator'], ['navB', 'navigator'], ['clin', 'clinician'], ['clinB', 'clinician'], ['sup', 'supervisor'], ['sup2', 'supervisor'], ['fin', 'finance']]) {
    const u = H.makeUser(`s161_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
  for (const m of ['careplan', 'caloms', 'suprt', 'assessments']) H.db.setSetting(`module_${m}`, '1');
});
after(() => H.stop());

async function push(as, body) {
  const r = await C[as].post('/api/sync/push', { device_now: iso(), ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const rejected = (res, id) => res.rejected.some(r => r.id === id);
function mkClient(owner) {
  const id = randomUUID();
  H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,intake_date,created_by) VALUES(?,?,?,?,?,?,?)`, id, 'S-' + id.slice(0, 8), enc('Pat'), enc('Sec'), 'active', day(-30), U[owner]);
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, randomUUID(), id, U[owner], 'primary', day(-30), U.sup);
  return id;
}
function assertSafeFile(res, what) {
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /sandbox/, `${what}: sandboxed (${csp})`);
  assert.match(csp, /default-src 'none'/, `${what}: nothing loads from it`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', what);
  assert.match(res.headers.get('content-disposition') || '', /^(inline|attachment); filename=/, `${what}: a Content-Disposition`);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin', what);
}

// ---- H1: stored XSS through resource photos ----
test('H1: a device cannot give a resource photo a non-image type, and an upload must be a picture', async () => {
  const r = await C.sup.post('/api/resources', { name: 'H1 clinic', category: 'other' });
  const html = randomUUID(); const ok = randomUUID();
  const res = await push('navA', { tables: { resource_photos: [
    { id: html, resource_id: r.data.id, content_type: 'text/html', sort_order: 0, updated_at: iso() },
    { id: ok, resource_id: r.data.id, content_type: 'image/png', sort_order: 1, updated_at: iso() }] } });
  assert.ok(rejected(res, html), 'text/html refused');
  assert.ok(!rejected(res, ok));
  const bad = await C.navA.post(`/api/sync/blob/resource_photos/${ok}/data_b64`, { value: Buffer.from('<html><script>alert(1)</script></html>').toString('base64') });
  assert.equal(bad.status, 400, 'an HTML body is not a picture');
  const good = await C.navA.post(`/api/sync/blob/resource_photos/${ok}/data_b64`, { value: PNG });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  const got = await C.sup.raw(`/api/resources/${r.data.id}/photos/${ok}/image`);
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png');
  assertSafeFile(got, 'resource photo');
});

test('H1: a stored photo whose bytes are not a picture is served as an opaque download, whatever its recorded type', async () => {
  const r = await C.sup.post('/api/resources', { name: 'H1 legacy', category: 'other' });
  const p = randomUUID();
  H.db.run(`INSERT INTO resource_photos(id,resource_id,content_type,bytes,data_b64,thumb_b64,sort_order) VALUES(?,?,?,?,?,?,0)`, p, r.data.id, 'text/html', 10,
    Buffer.from('<script>alert(1)</script>').toString('base64'), Buffer.from('<svg onload=alert(1)>').toString('base64'));
  for (const kind of ['image', 'thumb']) {
    const got = await C.sup.raw(`/api/resources/${r.data.id}/photos/${p}/${kind}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream', kind);
    assert.match(got.headers.get('content-disposition'), /^attachment/, kind);
    assertSafeFile(got, `legacy ${kind}`);
  }
});

test('H1: every stored file is served sandboxed, with nosniff and a Content-Disposition (documents, form library, form attachments, photos)', async () => {
  const doc = await C.sup.post('/api/documents', { title: 'H1 doc', category: 'policy', file: `data:image/png;base64,${PNG}` });
  assert.equal(doc.status, 201, JSON.stringify(doc.data));
  for (const q of ['', '?inline=1']) assertSafeFile(await C.sup.raw(`/api/documents/${doc.data.id}/file${q}`), `document${q}`);
  const tpl = await C.sup.post('/api/forms/templates', { name: 'H1 form', file: `data:image/png;base64,${PNG}`, fields: [{ key: 'a', label: 'A', type: 'text' }] });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
  assertSafeFile(await C.sup.raw(`/api/forms/templates/${tpl.data.id}/file`), 'form template');
  const cid = mkClient('navB');
  const f = await C.navB.post(`/api/clients/${cid}/forms`, { template_id: tpl.data.id });
  const a = await C.navB.post(`/api/forms/${f.data.id}/files`, { file: `data:image/png;base64,${PNG}`, filename: 'signed.png' });
  assertSafeFile(await C.navB.raw(`/api/forms/${f.data.id}/files/${a.data.id}`), 'form attachment');
  const r = await C.sup.post('/api/resources', { name: 'H1 pics', category: 'other' });
  const ph = await C.sup.post(`/api/resources/${r.data.id}/photos`, { data_url: `data:image/png;base64,${PNG}`, thumb_url: `data:image/png;base64,${PNG}` });
  assert.equal(ph.status, 201, JSON.stringify(ph.data));
  for (const kind of ['image', 'thumb']) assertSafeFile(await C.sup.raw(`/api/resources/${r.data.id}/photos/${ph.data.id}/${kind}`), `photo ${kind}`);
});

test('H1: a form attachment pushed with a type the form library does not take is refused', async () => {
  const cid = mkClient('navA');
  const f = randomUUID(); H.db.run(`INSERT INTO client_forms(id,client_id,template_name,values_enc,status,created_by) VALUES(?,?,?,?,?,?)`, f, cid, 'T', enc('{}'), 'draft', U.navA);
  const x = randomUUID();
  const res = await push('navA', { tables: { client_form_files: [{ id: x, client_form_id: f, client_id: cid, content_type: 'text/html', filename_enc: 'a.html', updated_at: iso() }] } });
  assert.ok(rejected(res, x));
});

// ---- M1 / M2: form attachments and forms ----
async function completedForm(owner) {
  const tpl = await C.sup.post('/api/forms/templates', { name: 'M2 ' + randomUUID().slice(0, 6), fields: [{ key: 'a', label: 'A', type: 'text' }] });
  const cid = mkClient(owner);
  const f = await C[owner].post(`/api/clients/${cid}/forms`, { template_id: tpl.data.id });
  const a = await C[owner].post(`/api/forms/${f.data.id}/files`, { file: `data:image/png;base64,${PNG}`, filename: 'signed.png' });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  return { tpl: tpl.data.id, cid, form: f.data.id, file: a.data.id };
}

test('M1: the blob upload route cannot overwrite another worker\'s attachment, nor any attachment on a completed form', async () => {
  const x = await completedForm('navB');
  assert.equal((await C.navB.put(`/api/forms/${x.form}`, { status: 'completed', values: { a: 'x' } })).status, 200);
  const forged = await C.navA.post(`/api/sync/blob/client_form_files/${x.file}/data_enc`, { value: Buffer.from('forged').toString('base64') });
  assert.equal(forged.status, 403, JSON.stringify(forged.data));
  const own = await C.navB.post(`/api/sync/blob/client_form_files/${x.file}/data_enc`, { value: PNG });
  assert.equal(own.status, 403, 'a completed form\'s attachment is not replaced, even by its uploader');
  assert.equal(Buffer.from(dec(H.db.one(`SELECT data_enc FROM client_form_files WHERE id=?`, x.file).data_enc), 'base64').toString('base64'), PNG);
});

test('M1: a device uploads the file for an attachment it created offline, after the form was completed in the same sync', async () => {
  const cid = mkClient('navA');
  const f = randomUUID(); const x = randomUUID();
  const res = await push('navA', { tables: {
    client_forms: [{ id: f, client_id: cid, template_name: 'T', values_enc: '{}', fields_json: '[]', status: 'completed', completed_at: iso(), updated_at: iso() }],
    client_form_files: [{ id: x, client_form_id: f, client_id: cid, content_type: 'image/png', filename_enc: 'signed.png', updated_at: iso() }] } });
  assert.deepEqual(res.rejected, []);
  const up = await C.navA.post(`/api/sync/blob/client_form_files/${x}/data_enc`, { value: PNG });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(H.db.one(`SELECT completed_by FROM client_forms WHERE id=?`, f).completed_by, U.navA);
});

test('M2: another worker\'s form: its attachments, voiding it and deleting it need its owner or records:manage-others', async () => {
  const draft = await completedForm('navB');
  assert.equal((await C.navA.del(`/api/forms/${draft.form}/files/${draft.file}`)).status, 403, 'attachment on another worker\'s draft');
  assert.equal((await C.navA.put(`/api/forms/${draft.form}`, { status: 'void' })).status, 403, 'void another worker\'s draft');
  assert.equal((await C.navA.del(`/api/forms/${draft.form}`)).status, 403, 'delete another worker\'s draft');
  const tomb = await push('navA', { tombstones: [{ table_name: 'client_form_files', id: draft.file, deleted_at: iso(Date.now() + 60000) }] });
  assert.ok(rejected(tomb, draft.file), 'sync refuses the attachment\'s deletion too');
  const row = H.db.one(`SELECT * FROM client_forms WHERE id=?`, draft.form);
  const voided = await push('navA', { tables: { client_forms: [{ ...row, values_enc: dec(row.values_enc), status: 'void', updated_at: iso(Date.now() + 5000) }] } });
  assert.ok(rejected(voided, draft.form), 'and voiding it');
  const deleted = await push('navA', { tables: { client_forms: [{ ...row, values_enc: dec(row.values_enc), deleted_at: iso(), updated_at: iso(Date.now() + 6000) }] } });
  assert.ok(rejected(deleted, draft.form), 'and removing it');
  assert.equal(H.db.one(`SELECT status, deleted_at FROM client_forms WHERE id=?`, draft.form).status, 'draft');
  // The owner, and a supervisor, still may.
  assert.equal((await C.navB.del(`/api/forms/${draft.form}/files/${draft.file}`)).status, 200);
  assert.equal((await C.sup.put(`/api/forms/${draft.form}`, { status: 'void' })).status, 200);

  const done = await completedForm('navB');
  assert.equal((await C.navB.put(`/api/forms/${done.form}`, { status: 'completed', values: { a: 'x' } })).status, 200);
  assert.equal((await C.navA.del(`/api/forms/${done.form}/files/${done.file}`)).status, 403, 'attachment on another worker\'s completed form');
  assert.equal((await C.navB.del(`/api/forms/${done.form}/files/${done.file}`)).status, 403, 'a completed form is locked for its owner too');
  const attach = await C.navB.post(`/api/forms/${done.form}/files`, { file: `data:image/png;base64,${PNG}` });
  assert.equal(attach.status, 201, 'the signed copy is attached after the form is completed');
  assert.equal((await C.sup.del(`/api/forms/${done.form}/files/${done.file}`)).status, 200, 'a supervisor (forms:manage) may');
});

// ---- M3: supply lines on another worker's visit ----
test('M3: a device cannot add or remove supply lines on another worker\'s visit', async () => {
  const cid = mkClient('navB');
  const site = randomUUID(); H.db.run(`INSERT INTO supply_sites(id,name) VALUES(?,?)`, site, 'M3 office');
  const item = randomUUID(); H.db.run(`INSERT INTO supply_items(id,name,category) VALUES(?,?,?)`, item, 'M3 Narcan', 'naloxone');
  const v = await C.navB.post('/api/interventions', { client_id: cid, type: 'outreach', occurred_at: iso(), duration_minutes: 10 });
  assert.equal(v.status, 201);
  const line = randomUUID();
  const res = await push('navA', { tables: { intervention_supplies: [{ id: line, intervention_id: v.data.id, client_id: cid, user_id: U.navA, item_id: item, quantity: 7, untracked: 0, updated_at: iso() }] } });
  assert.ok(rejected(res, line), JSON.stringify(res));
  assert.equal(H.db.one(`SELECT naloxone_kits FROM interventions WHERE id=?`, v.data.id).naloxone_kits, 0);
  const own = randomUUID();
  H.db.run(`INSERT INTO intervention_supplies(id,intervention_id,client_id,user_id,item_id,quantity) VALUES(?,?,?,?,?,?)`, own, v.data.id, cid, U.navB, item, 2);
  const tomb = await push('navA', { tombstones: [{ table_name: 'intervention_supplies', id: own, deleted_at: iso(Date.now() + 60000) }] });
  assert.ok(rejected(tomb, own));
  assert.ok(H.db.one(`SELECT 1 FROM intervention_supplies WHERE id=?`, own));
  // The visit's own worker still may.
  const mine = randomUUID();
  const ok = await push('navB', { tables: { intervention_supplies: [{ id: mine, intervention_id: v.data.id, client_id: cid, user_id: U.navB, item_id: item, quantity: 1, untracked: 0, updated_at: iso() }] } });
  assert.ok(!rejected(ok, mine), JSON.stringify(ok));
});

// ---- M4: import item commit ----
test('M4: committing a staged import item is its importer\'s (or records:manage-others)', async () => {
  const up = await C.sup.post('/api/imports/upload', { source: 'generic', filename: 'x.txt', text: 'Staged page\n\nmore text' });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const it = H.db.one(`SELECT id FROM import_items WHERE import_id=?`, up.data.id);
  const cid = mkClient('navA');
  const r = await C.navA.post(`/api/imports/items/${it.id}/commit`, { client_id: cid, kind: 'admin' });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(H.db.one(`SELECT status FROM import_items WHERE id=?`, it.id).status, 'staged');
});

// ---- M5: SUPRT-A and CalOMS deletes ----
test('M5: SUPRT-A assessments and CalOMS records are deleted by their author or records:manage-others; an extracted CalOMS record by nobody', async () => {
  const cid = mkClient('navB');
  const s = await C.navB.post(`/api/clients/${cid}/suprt`, { assessment_type: 'baseline', assessment_date: day(0), status: 'draft', answers: {} });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal((await C.navA.del(`/api/suprt/${s.data.id}`)).status, 403);
  const t1 = await push('navA', { tombstones: [{ table_name: 'suprt_assessments', id: s.data.id, deleted_at: iso(Date.now() + 60000) }] });
  assert.ok(rejected(t1, s.data.id));
  assert.equal((await C.navB.del(`/api/suprt/${s.data.id}`)).status, 200, 'its author may');

  const e = randomUUID(); H.db.run(`INSERT INTO episodes(id,client_id,opened_at,opened_by) VALUES(?,?,?,?)`, e, cid, day(-5), U.navB);
  const mk = (extracted) => { const id = randomUUID(); H.db.run(`INSERT INTO caloms_records(id,client_id,episode_id,record_type,record_date,answers_enc,created_by,updated_by,extracted_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, cid, e, 'annual_update', day(0), enc('{}'), U.navB, U.navB, extracted ? iso() : null); return id; };
  const plain = mk(false);
  assert.equal((await C.navA.del(`/api/caloms/records/${plain}`)).status, 403);
  const t2 = await push('navA', { tombstones: [{ table_name: 'caloms_records', id: plain, deleted_at: iso(Date.now() + 60000) }] });
  assert.ok(rejected(t2, plain));
  assert.equal((await C.navB.del(`/api/caloms/records/${plain}`)).status, 200, 'its author may');
  const sent = mk(true);
  for (const who of ['navB', 'sup']) assert.equal((await C[who].del(`/api/caloms/records/${sent}`)).status, 409, `${who}: an extracted record is corrected, not deleted`);
  const t3 = await push('sup', { tombstones: [{ table_name: 'caloms_records', id: sent, deleted_at: iso(Date.now() + 60000) }] });
  assert.ok(rejected(t3, sent));
  assert.ok(H.db.one(`SELECT 1 FROM caloms_records WHERE id=?`, sent));
});

// ---- M6: episodes ----
test('M6: a device changes an episode only as the REST routes do (open, discharge, re-admit); the admission itself is the office\'s', async () => {
  const cid = mkClient('navB');
  const ep = await C.navB.post(`/api/clients/${cid}/episodes`, { presenting_problem: 'B problem', opened_at: day(-10) });
  assert.equal(ep.status, 201);
  const row = H.db.one(`SELECT * FROM episodes WHERE id=?`, ep.data.id);
  const res = await push('navB', { tables: { episodes: [{ ...row, presenting_problem_enc: 'rewritten', opened_at: day(-400), opened_by: U.sup, updated_at: iso(Date.now() + 5000) }] } });
  assert.deepEqual(res.rejected, []);
  const after1 = H.db.one(`SELECT * FROM episodes WHERE id=?`, ep.data.id);
  assert.equal(dec(after1.presenting_problem_enc), 'B problem'); assert.equal(after1.opened_at, day(-10)); assert.equal(after1.opened_by, U.navB);
  assert.ok(res.warnings.some(w => w.id === ep.data.id), 'the device is told');
  // Someone not on the care team cannot change or discharge it, by either door.
  const res2 = await push('navA', { tables: { episodes: [{ ...row, presenting_problem_enc: 'B problem', status: 'closed', closed_at: day(0), discharge_reason: 'completed', updated_at: iso(Date.now() + 6000) }] } });
  assert.ok(rejected(res2, ep.data.id));
  assert.equal((await C.navA.post(`/api/episodes/${ep.data.id}/close`, { discharge_reason: 'completed' })).status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND end_date IS NULL`, cid), 'the care team stands');
  // The care team discharges, by sync as over REST, and closed_by is the syncing user.
  const res3 = await push('navB', { tables: { episodes: [{ ...row, presenting_problem_enc: 'B problem', status: 'closed', closed_at: day(0), closed_by: U.sup, discharge_reason: 'completed', updated_at: iso(Date.now() + 7000) }] } });
  assert.deepEqual(res3.rejected, []);
  const after3 = H.db.one(`SELECT * FROM episodes WHERE id=?`, ep.data.id);
  assert.equal(after3.status, 'closed'); assert.equal(after3.closed_by, U.navB);
  // records:manage-others may re-admit anyone's.
  assert.equal((await C.sup.post(`/api/episodes/${ep.data.id}/reopen`, { reason: 'error' })).status, 200);
});

// ---- M7: separation of duties ----
test('M7: an approver cannot approve spending or time they recorded, or whose amount they changed', async () => {
  const f = await C.sup.post('/api/budget/funds', { name: 'M7 fund', source_type: 'other', total_amount: 50000, fiscal_year_start: day(-200), fiscal_year_end: day(100) });
  const x = await C.sup.post('/api/budget/expenditures', { funding_source_id: f.data.id, spent_at: day(0), amount: 900, category: 'transportation', user_id: U.navB });
  assert.equal(x.status, 201, JSON.stringify(x.data));
  const a = await C.sup.post(`/api/budget/expenditures/${x.data.id}/approve`, { status: 'approved' });
  assert.equal(a.status, 403, JSON.stringify(a.data));
  assert.equal((await C.sup2.post(`/api/budget/expenditures/${x.data.id}/approve`, { status: 'approved' })).status, 200, 'another approver may');

  const y = await C.navB.post('/api/budget/expenditures', { funding_source_id: f.data.id, spent_at: day(0), amount: 5, category: 'transportation' });
  assert.equal((await C.fin.put(`/api/budget/expenditures/${y.data.id}`, { amount: 4000 })).status, 200);
  assert.equal((await C.fin.post(`/api/budget/expenditures/${y.data.id}/approve`, { status: 'approved' })).status, 403, 'edited the amount, then approved it');
  assert.equal((await C.fin.post(`/api/budget/expenditures/${y.data.id}/approve`, { status: 'rejected', note: 'amount looks wrong' })).status, 200, 'returning it is still theirs');

  const t = await C.sup.post('/api/time', { work_date: day(0), minutes: 480, user_id: U.navB });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  H.db.run(`UPDATE time_entries SET status='submitted' WHERE id=?`, t.data.id);
  assert.equal((await C.sup.post(`/api/time/${t.data.id}/approve`, { decision: 'approved' })).status, 403);
  const batch = await C.sup.post('/api/time/approve-batch', { ids: [t.data.id], decision: 'approved' });
  assert.equal(batch.data.approved, 0); assert.equal(batch.data.skipped[0].reason, 'you recorded or changed it');
  assert.equal((await C.sup2.post(`/api/time/${t.data.id}/approve`, { decision: 'approved' })).status, 200);

  // A device's entry recorded for someone else counts the same.
  const pushed = randomUUID();
  const res = await push('sup', { tables: { expenditures: [{ id: pushed, funding_source_id: f.data.id, user_id: U.navB, spent_at: day(0), amount: 12, category: 'transportation', status: 'pending', updated_at: iso() }] } });
  assert.deepEqual(res.rejected, []);
  assert.equal((await C.sup.post(`/api/budget/expenditures/${pushed}/approve`, { status: 'approved' })).status, 403);
});

// ---- Lows ----
test('L1: a problem-list change arriving by sync is kept in the problem\'s history', async () => {
  const cid = mkClient('clinB');
  const p = await C.clinB.post(`/api/clients/${cid}/problems`, { problem: 'B problem' });
  assert.equal(p.status, 201);
  const row = H.db.one(`SELECT * FROM problems WHERE id=?`, p.data.id);
  const res = await push('clin', { tables: { problems: [{ ...row, problem_enc: 'rewritten', icd10_code_enc: null, icd10_description_enc: null, z_codes_enc: null, updated_at: iso(Date.now() + 5000) }] } });
  assert.deepEqual(res.rejected, []);
  const h = H.db.all(`SELECT * FROM problem_history WHERE problem_id=? ORDER BY rowid`, p.data.id);
  assert.equal(h.length, 2);
  assert.equal(h[1].changed_by, U.clin);
  assert.deepEqual(JSON.parse(dec(h[1].changes_enc)).problem, { from: 'B problem', to: 'rewritten' });
});

test('L2: a device cannot ask for a review of another worker\'s signed note', async () => {
  const cid = mkClient('navB');
  const n = await C.navB.post('/api/notes', { client_id: cid, kind: 'admin', content: 'B note', occurred_at: iso() });
  H.db.run(`UPDATE notes SET status='signed', signed_by=?, signed_at=? WHERE id=?`, U.navB, iso(), n.data.id);
  assert.equal((await C.navA.post(`/api/notes/${n.data.id}/request-cosign`, {})).status, 403);
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, n.data.id);
  await push('navA', { tables: { notes: [{ ...row, content_enc: 'B note', title_enc: null, structured_enc: null, cosign_note_enc: null, cosign_requested: 1, updated_at: iso(Date.now() + 5000) }] } });
  assert.equal(H.db.one(`SELECT cosign_requested FROM notes WHERE id=?`, n.data.id).cosign_requested, 0);
});

test('L3: a spreadsheet import needs imports:write, passes the table\'s rules, and audits each record', async () => {
  const cid = mkClient('navA');
  const bad = await C.navA.post('/api/imports/data/commit', { entity: 'interventions', records: [{ client_id: cid, occurred_at: iso(), type: 'not-a-real-type', duration_minutes: -50 }] });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, cid).n, 0);
  const ok = await C.navA.post('/api/imports/data/commit', { entity: 'interventions', records: [{ client_id: cid, occurred_at: iso(), type: 'outreach', duration_minutes: 20 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.created, 1);
  const made = H.db.one(`SELECT id FROM interventions WHERE client_id=?`, cid);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='intervention.create' AND entity_id=? AND user_id=?`, made.id, U.navA), 'each record is audited');
  const fin = await C.fin.post('/api/imports/data/commit', { entity: 'time_entries', records: [{ work_date: day(0), minutes: 30 }] });
  assert.equal(fin.status, 403, 'finance holds no imports:write');
  assert.equal((await C.fin.post('/api/imports/data/preview?entity=time_entries', { text: 'Date,Minutes\n2026-09-01,30' })).status, 403);
});

test('L4: a goal\'s or step\'s wording is its author\'s (or records:manage-others) to change; its status is anyone\'s', async () => {
  const cid = mkClient('navB');
  const g = await C.navB.post(`/api/clients/${cid}/goals`, { goal: 'B goal' });
  assert.equal((await C.navA.put(`/api/goals/${g.data.id}`, { goal: 'overwritten by A' })).status, 403);
  assert.equal((await C.navA.put(`/api/goals/${g.data.id}`, { status: 'met' })).status, 200);
  const row = H.db.one(`SELECT * FROM care_plan_goals WHERE id=?`, g.data.id);
  const res = await push('navA', { tables: { care_plan_goals: [{ ...row, goal_enc: 'rewritten by push', updated_at: iso(Date.now() + 5000) }] } });
  assert.ok(rejected(res, g.data.id));
  assert.equal(dec(H.db.one(`SELECT goal_enc FROM care_plan_goals WHERE id=?`, g.data.id).goal_enc), 'B goal');
  const s = await C.navB.post(`/api/goals/${g.data.id}/steps`, { step: 'B step' });
  assert.equal((await C.navA.put(`/api/steps/${s.data.id}`, { step: 'A step' })).status, 403);
  assert.equal((await C.navA.put(`/api/steps/${s.data.id}`, { status: 'done' })).status, 200);
  assert.equal((await C.sup.put(`/api/goals/${g.data.id}`, { goal: 'reworded by a supervisor' })).status, 200);
});

test('L5: a directory picture is removed by anyone who keeps the directory, by sync as over REST (sync no longer drops it quietly)', async () => {
  const r = await C.sup.post('/api/resources', { name: 'L5 clinic', category: 'other' });
  const a = await C.sup.post(`/api/resources/${r.data.id}/photos`, { data_url: `data:image/png;base64,${PNG}` });
  const b = await C.sup.post(`/api/resources/${r.data.id}/photos`, { data_url: `data:image/png;base64,${PNG}` });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await C.navA.del(`/api/resources/${r.data.id}/photos/${a.data.id}`)).status, 200);
  const t = await push('navA', { tombstones: [{ table_name: 'resource_photos', id: b.data.id, deleted_at: iso(Date.now() + 60000) }] });
  assert.ok(!rejected(t, b.data.id));
  assert.equal(H.db.one(`SELECT 1 x FROM resource_photos WHERE id=?`, b.data.id), undefined, 'removed, as over REST');
  // Still only for a role that keeps the directory.
  const c = await C.sup.post(`/api/resources/${r.data.id}/photos`, { data_url: `data:image/png;base64,${PNG}` });
  const t2 = await push('clin', { tombstones: [{ table_name: 'resource_photos', id: c.data.id, deleted_at: iso(Date.now() + 60000) }] });
  assert.ok(rejected(t2, c.data.id));
});

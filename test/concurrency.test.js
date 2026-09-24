'use strict';
// Load review, item 2: silent lost updates. Two workers open the same record, both save, and the second
// save quietly put back every field the first had changed. A save now carries the updated_at the form was
// opened with (`if_updated_at`); a stale one is refused with 409 and nothing is written. A save without
// the token (sync, imports, API callers, one-click actions) is accepted as before.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { decrypt } = require('../server/crypto');

const STALE = 'This record was changed by someone else since you opened it. Reload to see their changes.';
let sup, nav, clientId;
before(async () => {
  await H.start();
  H.makeUser('cc_sup', 'supervisor'); H.makeUser('cc_nav', 'navigator');
  sup = H.client(); await sup.login('cc_sup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('cc_nav', 'StaffPassw0rd!x');
  clientId = (await nav.post('/api/clients', { first_name: 'Concur', last_name: 'Rent', phone: '555-010-2222' })).data.id;
});
after(async () => { await H.stop(); });

/** Both workers load the record; the first saves; the second's save with the old token must be refused. */
async function lostUpdate(path, loaded, first, second) {
  assert.ok(loaded, `${path}: loaded`);
  const token = loaded.updated_at;
  assert.ok(token, `${path}: the loaded record carries updated_at`);
  const a = await sup.put(path, { ...first, if_updated_at: token });
  assert.equal(a.status, 200, `${path}: first save: ${JSON.stringify(a.data)}`);
  assert.ok(a.data.updated_at && a.data.updated_at !== token, `${path}: the response carries the new version`);
  const b = await nav.put(path, { ...second, if_updated_at: token });
  assert.equal(b.status, 409, `${path}: a save from a stale copy is refused`);
  assert.equal(b.data.error, STALE);
  assert.equal(b.data.stale, true);
  // With the version the first save returned, the same worker can save again straight away.
  const c = await sup.put(path, { ...first, if_updated_at: a.data.updated_at });
  assert.equal(c.status, 200, `${path}: chaining on the returned version works`);
  // And no token at all is still accepted (sync, imports, API integrations).
  assert.equal((await nav.put(path, second)).status, 200, `${path}: no token, accepted as before`);
}

test('client record: a stale save is refused and changes nothing; the conflict is audited', async () => {
  const loaded = (await nav.get(`/api/clients/${clientId}`)).data.client;
  const a = await sup.put(`/api/clients/${clientId}`, { housing_status: 'shelter', if_updated_at: loaded.updated_at });
  assert.equal(a.status, 200);
  const b = await nav.put(`/api/clients/${clientId}`, { housing_status: 'stable', goals: 'Get ID back', if_updated_at: loaded.updated_at });
  assert.equal(b.status, 409);
  assert.equal(b.data.error, STALE);
  const row = H.db.one(`SELECT housing_status, goals_enc FROM clients WHERE id=?`, clientId);
  assert.equal(row.housing_status, 'shelter', 'the first worker’s change survived');
  assert.equal(row.goals_enc, null, 'nothing from the refused save was written');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='client.update.conflict' AND entity_id=?`, clientId), 'the refusal is in the audit log');
  // Only the changed field travels, and the other worker's edit to a different field is kept.
  const fresh = (await nav.get(`/api/clients/${clientId}`)).data.client;
  const c = await nav.put(`/api/clients/${clientId}`, { goals: 'Get ID back', if_updated_at: fresh.updated_at });
  assert.equal(c.status, 200);
  const after = H.db.one(`SELECT housing_status, goals_enc FROM clients WHERE id=?`, clientId);
  assert.equal(after.housing_status, 'shelter');
  assert.equal(decrypt(after.goals_enc), 'Get ID back');
  await lostUpdate(`/api/clients/${clientId}`, (await nav.get(`/api/clients/${clientId}`)).data.client, { insurance: 'medicaid' }, { insurance: 'private' });
});

test('generic records (visits, calls, to-dos, time, referrals, overdose events) refuse stale saves', async () => {
  const visit = (await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-01T10:00:00Z', duration_minutes: 20 })).data.id;
  await lostUpdate(`/api/interventions/${visit}`, (await nav.get(`/api/interventions/${visit}`)).data.row, { duration_minutes: 30 }, { duration_minutes: 45 });
  const call = (await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: '2026-09-01T11:00:00Z', outcome: 'voicemail' })).data.id;
  await lostUpdate(`/api/calls/${call}`, (await nav.get(`/api/calls/${call}`)).data.row, { duration_minutes: 3 }, { duration_minutes: 9 });
  const task = (await nav.post('/api/tasks', { client_id: clientId, title: 'Call back' })).data.id;
  await lostUpdate(`/api/tasks/${task}`, (await nav.get(`/api/tasks/${task}`)).data.row, { priority: 'high' }, { priority: 'low' });
  const time = (await nav.post('/api/time', { client_id: clientId, work_date: '2026-09-01', minutes: 30 })).data.id;
  await lostUpdate(`/api/time/${time}`, (await nav.get(`/api/time/${time}`)).data.row, { minutes: 40 }, { minutes: 50 });
  const res = (await sup.post('/api/resources', { name: 'Conc Clinic', category: 'mat_otp' })).data.id;
  const ref = (await nav.post('/api/referrals', { client_id: clientId, resource_id: res, referred_at: '2026-09-02T09:00:00Z' })).data.id;
  await lostUpdate(`/api/referrals/${ref}`, (await nav.get(`/api/referrals/${ref}`)).data.row, { notes: 'first worker' }, { notes: 'second worker' });
  const od = await nav.post('/api/overdose-events', { client_id: clientId, kind: 'overdose', occurred_at: '2026-09-02T09:00:00Z' });
  assert.equal(od.status, 201, JSON.stringify(od.data));
  await lostUpdate(`/api/overdose-events/${od.data.id}`, (await nav.get(`/api/overdose-events/${od.data.id}`)).data.row, { naloxone_used: true }, { naloxone_used: false });
  // A one-click action (ticking a to-do done) sends no token and is not blocked by an earlier edit.
  assert.equal((await nav.put(`/api/tasks/${task}`, { status: 'done' })).status, 200);
});

test('notes, resources, funds and budget lines, documents and form templates refuse stale saves', async () => {
  const note = (await nav.post('/api/notes', { client_id: clientId, kind: 'admin', content: 'first draft', occurred_at: '2026-09-01T10:00:00Z' })).data.id;
  await lostUpdate(`/api/notes/${note}`, (await nav.get(`/api/notes/${note}`)).data.note, { content: 'supervisor edit' }, { content: 'navigator edit' });

  const res = (await sup.post('/api/resources', { name: 'Other Clinic', category: 'mat_otp' })).data.id;
  await lostUpdate(`/api/resources/${res}`, (await sup.get(`/api/resources/${res}`)).data.row, { phone: '555-000-1111' }, { phone: '555-000-2222' });

  const fund = (await sup.post('/api/budget/funds', { name: 'Grant C', fiscal_year_start: '2026-07-01', fiscal_year_end: '2027-06-30', total_amount: 1000 })).data.id;
  const loadFund = async () => (await sup.get('/api/budget/funds')).data.funds.find(f => f.id === fund);
  const f0 = await loadFund();
  const a = await sup.put(`/api/budget/funds/${fund}`, { total_amount: 2000, if_updated_at: f0.updated_at });
  assert.equal(a.status, 200);
  assert.equal((await sup.put(`/api/budget/funds/${fund}`, { total_amount: 3000, if_updated_at: f0.updated_at })).status, 409);
  const line = (await sup.post(`/api/budget/funds/${fund}/lines`, { category: 'staffing', allocated_amount: 100 })).data.id;
  const l0 = H.db.one(`SELECT updated_at FROM budget_lines WHERE id=?`, line).updated_at;
  assert.equal((await sup.put(`/api/budget/lines/${line}`, { allocated_amount: 150, if_updated_at: l0 })).status, 200);
  assert.equal((await sup.put(`/api/budget/lines/${line}`, { allocated_amount: 175, if_updated_at: l0 })).status, 409);

  const doc = await sup.post('/api/documents', { title: 'Policy', category: 'policy', file_url: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64') });
  assert.equal(doc.status, 201, JSON.stringify(doc.data));
  const d0 = H.db.one(`SELECT updated_at FROM policy_documents WHERE id=?`, doc.data.id).updated_at;
  assert.equal((await sup.put(`/api/documents/${doc.data.id}`, { description: 'one', if_updated_at: d0 })).status, 200);
  assert.equal((await sup.put(`/api/documents/${doc.data.id}`, { description: 'two', if_updated_at: d0 })).status, 409);

  const tpl = await sup.post('/api/forms/templates', { name: 'Intake checklist', category: 'intake_screening', fields: [{ key: 'a', label: 'A', type: 'text' }] });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
  {
    const t0 = H.db.one(`SELECT updated_at FROM form_templates WHERE id=?`, tpl.data.id).updated_at;
    assert.equal((await sup.put(`/api/forms/templates/${tpl.data.id}`, { description: 'one', if_updated_at: t0 })).status, 200);
    assert.equal((await sup.put(`/api/forms/templates/${tpl.data.id}`, { description: 'two', if_updated_at: t0 })).status, 409);
    const cf = await nav.post(`/api/clients/${clientId}/forms`, { template_id: tpl.data.id });
    assert.equal(cf.status, 201, JSON.stringify(cf.data));
    {
      const c0 = H.db.one(`SELECT updated_at FROM client_forms WHERE id=?`, cf.data.id).updated_at;
      const s1 = await nav.put(`/api/forms/${cf.data.id}`, { values: { a: 'x' }, if_updated_at: c0 });
      assert.equal(s1.status, 200);
      assert.equal((await sup.put(`/api/forms/${cf.data.id}`, { values: { a: 'y' }, if_updated_at: c0 })).status, 409);
      assert.equal((await nav.put(`/api/forms/${cf.data.id}`, { values: { a: 'z' }, if_updated_at: s1.data.updated_at })).status, 200, 'an autosave chains on the version the last save returned');
    }
  }
});

test('the local-mode sync push is not affected (it never sends a token)', async () => {
  const bearer = H.client(); const login = await bearer.login('cc_nav', 'StaffPassw0rd!x');
  assert.ok(login);
  const r = await bearer.post('/api/sync/push', { tables: { tasks: [{ id: require('../server/crypto').uuid(), client_id: clientId, created_by: H.db.one(`SELECT id FROM users WHERE username='cc_nav'`).id, title_enc: 'From a phone', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] } }, { 'X-Sync-Client': '1' });
  assert.ok([200, 207].includes(r.status), JSON.stringify(r.data));
});

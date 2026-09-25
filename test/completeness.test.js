'use strict';
// Gaps closed after the 1.9.4 completeness audit: a fatal overdose discharges the client and correcting the
// event undoes it, patient-rights requests can be edited and voided, the program-wide episode list, the meta
// lists the views read, and routes that had no API test at all.
// A data directory of its own: the certificate and key-backup downloads below write files into it.
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
process.env.SUDS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-completeness-'));
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const config = require('../server/config');

let admin, sup, nav, fin, ro, nav2, navId;
before(async () => {
  await H.start();
  navId = H.makeUser('cmpnav', 'navigator').id;
  H.makeUser('cmpsup', 'supervisor');
  H.makeUser('cmpfin', 'finance');
  H.makeUser('cmpro', 'readonly'); H.makeUser('cmpnav2', 'navigator');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('cmpsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('cmpnav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('cmpfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('cmpro', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('cmpnav2', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); fs.rmSync(process.env.SUDS_DATA_DIR, { recursive: true, force: true }); });

const newClient = async (who, first, last, extra = {}) => (await who.post('/api/clients', { first_name: first, last_name: last, confirm_duplicate: true, ...extra })).data;
const clientRow = (id) => H.db.one(`SELECT status, discharge_date, discharge_reason FROM clients WHERE id=?`, id);
const episodeRow = (id) => H.db.one(`SELECT status, discharge_reason, closed_at FROM episodes WHERE id=?`, id);

test('a fatal overdose goes through discharge: the open episode closes as deceased, the team ends, to-dos are cancelled', async () => {
  const c = await newClient(nav, 'Fatal', 'Discharge');
  assert.equal(episodeRow(c.episode_id).status, 'open');
  const task = await nav.post('/api/tasks', { client_id: c.id, title: 'Call back about housing', due_date: '2026-10-01' });
  assert.equal(task.status, 201);
  const ev = await nav.post('/api/overdose-events', { client_id: c.id, occurred_at: '2026-09-20T03:00:00Z', kind: 'fatal' });
  assert.equal(ev.status, 201);
  assert.deepEqual(clientRow(c.id), { status: 'deceased', discharge_date: '2026-09-20', discharge_reason: 'deceased' });
  assert.deepEqual(episodeRow(c.episode_id), { status: 'closed', discharge_reason: 'deceased', closed_at: '2026-09-20' });
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, task.data.id).status, 'cancelled');
  assert.equal(H.db.one(`SELECT end_date FROM assignments WHERE client_id=? AND user_id=?`, c.id, navId).end_date, '2026-09-20');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='overdose_event.fatal_outcome' AND entity_id=?`, ev.data.id);
  assert.ok(a, 'what the fatal outcome changed is audited');
  assert.equal(JSON.parse(a.details).prior_status, 'active');
});

test('changing a fatal event to a survived overdose restores the client, reopens the episode and the to-dos', async () => {
  const c = await newClient(nav, 'Fatal', 'Corrected');
  const task = await nav.post('/api/tasks', { client_id: c.id, title: 'Follow up', due_date: '2026-10-02' });
  const ev = await sup.post('/api/overdose-events', { client_id: c.id, occurred_at: '2026-09-21T03:00:00Z', kind: 'fatal' });
  assert.equal(clientRow(c.id).status, 'deceased');
  const r = await sup.put(`/api/overdose-events/${ev.data.id}`, { kind: 'reversal', survived: true, naloxone_used: true });
  assert.equal(r.status, 200);
  assert.deepEqual(clientRow(c.id), { status: 'active', discharge_date: null, discharge_reason: null });
  assert.equal(episodeRow(c.episode_id).status, 'open', 'the episode it closed is open again');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, task.data.id).status, 'open');
  assert.equal(H.db.one(`SELECT end_date FROM assignments WHERE client_id=? AND user_id=?`, c.id, navId).end_date, null, 'the care team is back');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='overdose_event.fatal_reverted' AND entity_id=?`, ev.data.id));
  // And back to fatal again: discharged a second time, and a delete undoes that too.
  assert.equal((await sup.put(`/api/overdose-events/${ev.data.id}`, { kind: 'fatal' })).status, 200);
  assert.equal(clientRow(c.id).status, 'deceased');
  assert.equal(episodeRow(c.episode_id).status, 'closed');
  assert.equal((await sup.del(`/api/overdose-events/${ev.data.id}`)).status, 200);
  assert.equal(clientRow(c.id).status, 'active');
  assert.equal(episodeRow(c.episode_id).status, 'open');
  assert.ok(!H.db.one(`SELECT 1 FROM overdose_events WHERE id=?`, ev.data.id));
});

test('deleting a fatal event restores the status the client had before (waitlist, with no episode to reopen)', async () => {
  const c = await newClient(sup, 'Fatal', 'Waitlisted', { status: 'waitlist' });
  const open = H.db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, c.id);
  if (open) await sup.post(`/api/episodes/${open.id}/close`, { discharge_reason: 'administrative', keep_client_active: true });
  H.db.run(`UPDATE clients SET status='waitlist' WHERE id=?`, c.id);
  const ev = await sup.post('/api/overdose-events', { client_id: c.id, occurred_at: '2026-09-22T03:00:00Z', kind: 'fatal' });
  assert.equal(clientRow(c.id).status, 'deceased');
  assert.equal((await sup.del(`/api/overdose-events/${ev.data.id}`)).status, 200);
  assert.equal(clientRow(c.id).status, 'waitlist');
});

test('a fatal event is not undone while another fatal report for the same person stands, or after a manual status change', async () => {
  const c = await newClient(sup, 'Fatal', 'Twice');
  const one = await sup.post('/api/overdose-events', { client_id: c.id, occurred_at: '2026-09-23T03:00:00Z', kind: 'fatal' });
  const two = await sup.post('/api/overdose-events', { client_id: c.id, occurred_at: '2026-09-23T04:00:00Z', kind: 'fatal' });
  assert.equal(two.status, 201);
  assert.equal((await sup.del(`/api/overdose-events/${two.data.id}`)).status, 200);
  assert.equal(clientRow(c.id).status, 'deceased', 'the duplicate report changed nothing and removing it changes nothing');
  // The remaining report is corrected: now the client is restored.
  assert.equal((await sup.put(`/api/overdose-events/${one.data.id}`, { kind: 'overdose' })).status, 200);
  assert.equal(clientRow(c.id).status, 'active');

  const d = await newClient(sup, 'Fatal', 'Handfixed');
  const ev = await sup.post('/api/overdose-events', { client_id: d.id, occurred_at: '2026-09-23T03:00:00Z', kind: 'fatal' });
  H.db.run(`UPDATE clients SET status='inactive' WHERE id=?`, d.id);
  assert.equal((await sup.del(`/api/overdose-events/${ev.data.id}`)).status, 200);
  assert.equal(clientRow(d.id).status, 'inactive', 'a later decision by a person is left alone');
});

test('a survived overdose changed to fatal discharges the client then', async () => {
  const c = await newClient(nav, 'Later', 'Fatal');
  const ev = await nav.post('/api/overdose-events', { client_id: c.id, occurred_at: '2026-09-19T03:00:00Z', kind: 'overdose' });
  assert.equal(clientRow(c.id).status, 'active');
  assert.equal((await nav.put(`/api/overdose-events/${ev.data.id}`, { kind: 'fatal' })).status, 200);
  assert.equal(clientRow(c.id).status, 'deceased');
  assert.equal(episodeRow(c.episode_id).discharge_reason, 'deceased');
  assert.equal(H.db.one(`SELECT survived FROM overdose_events WHERE id=?`, ev.data.id).survived, 0);
});

test('only the reporter or a manager can delete an overdose event; finance cannot', async () => {
  const ev = await sup.post('/api/overdose-events', { occurred_at: '2026-09-18T03:00:00Z', kind: 'reversal' });
  assert.equal((await nav.del(`/api/overdose-events/${ev.data.id}`)).status, 403);
  assert.equal((await fin.del(`/api/overdose-events/${ev.data.id}`)).status, 403);
  assert.equal((await sup.del(`/api/overdose-events/${ev.data.id}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='overdose_event.delete' AND entity_id=?`, ev.data.id));
});

// ---- patient-rights requests: edit and delete ----
test('a patient-rights request can be corrected and deleted by its handler or a manager; both are audited', async () => {
  const c = await newClient(nav, 'Rights', 'Request');
  const r = await nav.post('/api/patient-requests', { client_id: c.id, kind: 'access', received_at: '2026-09-01', notes: 'Asked in person for a copy' });
  assert.equal(r.status, 201);
  const edited = await nav.put(`/api/patient-requests/${r.data.id}`, { kind: 'amendment', due_at: '2026-10-31', notes: 'Asked to correct DOB' });
  assert.equal(edited.status, 200);
  const row = (await nav.get(`/api/patient-requests/${r.data.id}`)).data.row;
  assert.equal(row.kind, 'amendment'); assert.equal(row.due_at, '2026-10-31'); assert.equal(row.notes, 'Asked to correct DOB');
  const upd = H.db.one(`SELECT details FROM audit_log WHERE action='patient_request.update' AND entity_id=? ORDER BY id DESC`, r.data.id);
  assert.ok(upd, 'the edit is audited'); assert.ok(!/DOB/.test(upd.details), 'without the note text');
  assert.ok(H.db.one(`SELECT notes_enc FROM patient_requests WHERE id=?`, r.data.id).notes_enc.startsWith('v1:'), 'notes stay encrypted');
  // Someone else on the team without clients:all cannot change or delete it; finance has no access at all.
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date) VALUES(lower(hex(randomblob(16))),?,(SELECT id FROM users WHERE username='cmpnav2'),'secondary','2026-01-01')`, c.id);
  assert.equal((await nav2.put(`/api/patient-requests/${r.data.id}`, { status: 'denied' })).status, 403);
  assert.equal((await nav2.del(`/api/patient-requests/${r.data.id}`)).status, 403);
  assert.equal((await fin.del(`/api/patient-requests/${r.data.id}`)).status, 403);
  // Reopening a closed request clears its closed date.
  await nav.put(`/api/patient-requests/${r.data.id}`, { status: 'fulfilled' });
  assert.ok(H.db.one(`SELECT closed_at FROM patient_requests WHERE id=?`, r.data.id).closed_at);
  await sup.put(`/api/patient-requests/${r.data.id}`, { status: 'open' });
  assert.equal(H.db.one(`SELECT closed_at FROM patient_requests WHERE id=?`, r.data.id).closed_at, null);
  assert.equal((await sup.del(`/api/patient-requests/${r.data.id}`)).status, 200);
  assert.ok(!H.db.one(`SELECT 1 FROM patient_requests WHERE id=?`, r.data.id));
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='patient_request.delete' AND entity_id=?`, r.data.id), 'the deletion is audited');
});

// ---- program-wide episodes ----
test('GET /api/episodes lists admissions in a period with counts by discharge reason, scoped to the caseload', async () => {
  const a = await newClient(nav, 'Episode', 'Listed', { intake_date: '2026-08-02' });
  H.db.run(`UPDATE episodes SET opened_at='2026-08-02' WHERE id=?`, a.episode_id);
  assert.equal((await nav.post(`/api/episodes/${a.episode_id}/close`, { discharge_reason: 'completed', closed_at: '2026-08-20' })).status, 200);
  const b = await newClient(nav, 'Episode', 'Stillopen');
  H.db.run(`UPDATE episodes SET opened_at='2026-08-05' WHERE id=?`, b.episode_id);
  const r = await sup.get('/api/episodes?from=2026-08-01&to=2026-08-31&status=all');
  assert.equal(r.status, 200);
  assert.ok(r.data.rows.some(x => x.id === a.episode_id && x.status === 'closed' && x.discharge_reason === 'completed'));
  assert.ok(r.data.rows.some(x => x.id === b.episode_id && x.status === 'open'));
  assert.ok(r.data.summary.opened >= 2 && r.data.summary.still_open >= 1 && r.data.summary.since_closed >= 1);
  assert.ok(r.data.summary.discharges_by_reason.some(x => x.k === 'completed' && x.n >= 1));
  assert.equal(r.data.summary.discharged, r.data.summary.discharges_by_reason.reduce((s, x) => s + x.n, 0));
  const open = await sup.get('/api/episodes?from=2026-08-01&to=2026-08-31&status=open');
  assert.ok(open.data.rows.every(x => x.status === 'open'));
  // The navigator sees the client still on their caseload; the discharge ended their assignment to the other.
  const mine = await nav.get('/api/episodes?from=2026-08-01&to=2026-08-31&status=all');
  assert.ok(mine.data.rows.some(x => x.id === b.episode_id));
  assert.ok(!mine.data.rows.some(x => x.id === a.episode_id));
  // Another navigator's caseload does not include these clients.
  const other = await nav2.get('/api/episodes?from=2026-08-01&to=2026-08-31&status=all');
  assert.ok(!other.data.rows.some(x => x.id === a.episode_id || x.id === b.episode_id));
  assert.equal((await fin.get('/api/episodes')).status, 403, 'finance has no episode access');
  assert.equal((await ro.get('/api/episodes')).status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='episode.list' AND user_id=?`, navId));
});

// ---- the meta lists the views now read ----
test('the discharge-reason, overdose and patient-request option lists are served to any signed-in user', async () => {
  const d = await nav.get('/api/meta/discharge-reasons');
  assert.equal(d.status, 200); assert.ok(d.data.discharge_reasons.includes('deceased'));
  const o = await fin.get('/api/meta/overdose-options');
  assert.deepEqual(o.data.kinds, ['overdose', 'reversal', 'fatal']); assert.ok(o.data.administered_by.includes('bystander'));
  const p = await nav.get('/api/meta/patient-request-options');
  assert.deepEqual(p.data.kinds, ['access', 'amendment', 'restriction', 'accounting']); assert.equal(p.data.days_to_respond, 30);
  const anon = H.client();
  for (const u of ['/api/meta/discharge-reasons', '/api/meta/overdose-options', '/api/meta/patient-request-options']) assert.equal((await anon.get(u)).status, 401, u);
});

// ---- single-table exports newly offered on the Reports page ----
test('episodes, overdose events, client forms and disclosures export as single tables, de-identified, for export:read only', async () => {
  for (const kind of ['episodes', 'overdose_events', 'forms', 'disclosures']) {
    for (const [who, name] of [[nav, 'navigator'], [fin, 'finance']]) {
      const r = await who.get(`/api/reports/export/${kind}?from=2026-01-01&to=2026-12-31`);
      assert.equal(r.status, 200, `${kind} as ${name}`);
      assert.match(String(r.headers.get('content-disposition')), new RegExp(`suds-${kind}-.*deidentified`));
      const x = await who.get(`/api/reports/export/${kind}?from=2026-01-01&to=2026-12-31&format=xlsx`);
      assert.equal(x.status, 200); assert.match(x.headers.get('content-type'), /spreadsheetml/);
    }
    assert.equal((await ro.get(`/api/reports/export/${kind}`)).status, 403, `${kind} is refused without export:read`);
  }
  const ep = String((await nav.get('/api/reports/export/episodes?from=2026-01-01&to=2026-12-31')).data);
  assert.match(ep.split('\r\n')[0], /Client Code/);
  assert.ok(!/Episode Listed|Listed, Episode/.test(ep), 'no names in a de-identified export');
  // Asking for identified without the permission still gets a de-identified file.
  const sneaky = await fin.get('/api/reports/export/episodes?from=2026-01-01&to=2026-12-31&identified=1&basis=audit_evaluation&recipient=x&purpose=y');
  assert.match(String(sneaky.headers.get('content-disposition')), /deidentified/);
});

// ---- routes that had no API test ----
test('POST /api/auth/mfa/disable needs the password, is refused where the role requires MFA, and is audited', async () => {
  const u = H.makeUser('cmpmfa', 'navigator');
  const c = H.client(); await c.login(u.username, u.password);
  const setup = await c.post('/api/auth/mfa/setup', {});
  assert.equal((await c.post('/api/auth/mfa/' + 'enable', { code: require('../server/crypto').totp(setup.data.secret) })).status, 200);
  assert.equal((await H.client().post('/api/auth/mfa/disable', { password: u.password })).status, 401, 'not signed in');
  assert.equal((await c.post('/api/auth/mfa/disable', { password: 'wrong-password-123' })).status, 401);
  assert.equal((await c.post('/api/auth/mfa/disable', {})).status, 400, 'the password is required');
  H.db.setSetting('mfa_required_roles', 'navigator');
  try { assert.equal((await c.post('/api/auth/mfa/disable', { password: u.password })).status, 400, 'a role that requires MFA cannot turn it off'); }
  finally { H.db.run(`DELETE FROM settings WHERE key='mfa_required_roles'`); }
  assert.equal(H.db.one(`SELECT mfa_enabled FROM users WHERE id=?`, u.id).mfa_enabled, 1);
  assert.equal((await c.post('/api/auth/mfa/disable', { password: u.password })).status, 200);
  assert.deepEqual({ ...H.db.one(`SELECT mfa_enabled, mfa_secret_enc FROM users WHERE id=?`, u.id) }, { mfa_enabled: 0, mfa_secret_enc: null });
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.mfa.disabled' AND user_id=?`, u.id));
});

test('GET /api/waitlist lists waitlisted clients on the caller\'s caseload, longest-waiting first; needs clients:read', async () => {
  const w = await newClient(nav, 'Wait', 'Longest', { status: 'waitlist', intake_date: '2026-06-01' });
  const w2 = await newClient(nav, 'Wait', 'Shorter', { status: 'waitlist', intake_date: '2026-09-01' });
  for (const id of [w.id, w2.id]) { H.db.run(`UPDATE episodes SET status='closed', closed_at='2026-09-01', discharge_reason='administrative' WHERE client_id=?`, id); H.db.run(`UPDATE clients SET status='waitlist', risk_level='low' WHERE id=?`, id); }
  const r = await nav.get('/api/waitlist');
  assert.equal(r.status, 200);
  const ids = r.data.rows.map(x => x.id);
  assert.ok(ids.includes(w.id) && ids.includes(w2.id));
  assert.ok(ids.indexOf(w.id) < ids.indexOf(w2.id), 'the longest wait comes first');
  assert.ok(r.data.rows.every(x => typeof x.days_waiting === 'number'));
  assert.ok(!(await nav2.get('/api/waitlist')).data.rows.some(x => x.id === w.id), 'caseload-scoped');
  assert.equal((await fin.get('/api/waitlist')).status, 403);
  assert.equal((await ro.get('/api/waitlist')).status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='waitlist.view' AND user_id=?`, navId));
});

test('POST /api/time/submit-period submits the caller\'s own draft and rejected time in the range, nobody else\'s', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const mine = [];
  for (let i = 0; i < 2; i++) { const r = await nav.post('/api/time', { work_date: today, minutes: 30, category: 'admin' }); assert.equal(r.status, 201, JSON.stringify(r.data)); mine.push(r.data.id); }
  const theirs = (await nav2.post('/api/time', { work_date: today, minutes: 15, category: 'admin' })).data.id;
  assert.equal((await nav.post('/api/time/submit-period', { from: today })).status, 400, 'both ends of the period are required');
  const r = await nav.post('/api/time/submit-period', { from: today, to: today });
  assert.equal(r.status, 200); assert.ok(r.data.submitted >= 2);
  for (const id of mine) assert.equal(H.db.one(`SELECT status FROM time_entries WHERE id=?`, id).status, 'submitted');
  assert.equal(H.db.one(`SELECT status FROM time_entries WHERE id=?`, theirs).status, 'draft');
  assert.equal((await nav.post('/api/time/submit-period', { from: today, to: today })).data.submitted, 0, 'nothing left to submit');
  assert.equal((await fin.post('/api/time/submit-period', { from: today, to: today })).status, 403, 'finance logs no time of its own');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='time.submit.period' AND user_id=?`, navId));
});

test('GET /api/imports and discarding a staged item: own imports only, unless a manager', async () => {
  const up = await nav.post('/api/imports/upload', { source: 'pocket_ai', filename: 'export.json', text: JSON.stringify([{ id: 'c1', title: 'Check-in', transcript: 'Talked about housing.', created_at: '2026-09-06T15:00:00Z' }, { id: 'c2', title: 'Second', transcript: 'Another.', created_at: '2026-09-07T15:00:00Z' }]) });
  assert.equal(up.status, 201);
  const list = await nav.get('/api/imports');
  assert.equal(list.status, 200);
  const imp = list.data.imports.find(x => x.id === up.data.id);
  assert.equal(imp.staged, 2);
  assert.ok(!(await nav2.get('/api/imports')).data.imports.some(x => x.id === up.data.id), 'another worker does not see it');
  assert.ok((await sup.get('/api/imports')).data.imports.some(x => x.id === up.data.id), 'a manager does');
  assert.equal((await fin.get('/api/imports')).status, 403);
  const items = (await nav.get(`/api/imports/${up.data.id}`)).data.items;
  assert.equal((await nav2.post(`/api/imports/items/${items[0].id}/discard`, {})).status, 403, 'someone else\'s import is not theirs to discard');
  assert.equal((await fin.post(`/api/imports/items/${items[0].id}/discard`, {})).status, 403);
  assert.equal((await nav.post(`/api/imports/items/${items[0].id}/discard`, {})).status, 200);
  assert.equal((await nav.post(`/api/imports/items/${items[0].id}/discard`, {})).status, 400, 'already processed');
  assert.equal((await sup.post(`/api/imports/items/${items[1].id}/discard`, {})).status, 200, 'a manager may');
  assert.equal((await nav.post('/api/imports/items/nope/discard', {})).status, 404);
  assert.equal((await nav.get('/api/imports')).data.imports.find(x => x.id === up.data.id).discarded, 2);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='import.discard' AND entity_id=?`, items[0].id));
});

test('the OneNote (Microsoft Graph) routes report "not configured" instead of failing when Graph is not set up', async () => {
  const s = await nav.get('/api/imports/onenote/status');
  assert.equal(s.status, 200); assert.deepEqual(s.data, { configured: false, user: null });
  const nb = await nav.get('/api/imports/onenote/notebooks');
  assert.equal(nb.status, 502); assert.match(nb.data.error, /not configured/);
  const pg = await nav.get('/api/imports/onenote/sections/abc/pages');
  assert.equal(pg.status, 502); assert.match(pg.data.error, /not configured/);
  const f = await nav.post('/api/imports/onenote/fetch', { page_ids: ['p1'] });
  assert.equal(f.status, 502); assert.match(f.data.error, /not configured/);
  assert.equal((await nav.post('/api/imports/onenote/fetch', { page_ids: [] })).status, 400, 'at least one page');
  for (const [m, u] of [['GET', '/api/imports/onenote/status'], ['GET', '/api/imports/onenote/notebooks'], ['GET', '/api/imports/onenote/sections/abc/pages'], ['POST', '/api/imports/onenote/fetch']]) {
    assert.equal((await fin.req(m, u, m === 'POST' ? { page_ids: ['p1'] } : undefined)).status, 403, `${m} ${u} needs imports:write`);
  }
});

test('GET /api/admin/certificate serves the CA for phones to trust, to settings:manage only', async () => {
  assert.equal((await sup.get('/api/admin/certificate')).status, 403);
  assert.equal((await admin.get('/api/admin/certificate')).status, 404, 'no self-signed certificate yet');
  const dir = path.join(config.dataDir, 'certs'); fs.mkdirSync(dir, { recursive: true });
  const pem = '-----BEGIN CERTIFICATE-----\nTUlJQ0NFUlQ=\n-----END CERTIFICATE-----\n';
  fs.writeFileSync(path.join(dir, 'suds.crt'), 'leaf');
  fs.writeFileSync(path.join(dir, 'suds-ca.crt'), pem);
  const r = await admin.get('/api/admin/certificate');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/x-x509-ca-cert');
  assert.equal(r.data, pem, 'the CA, not the leaf, when both exist');
  fs.rmSync(path.join(dir, 'suds-ca.crt'));
  assert.equal((await admin.get('/api/admin/certificate')).data, 'leaf', 'an older certs folder still serves its leaf');
});

test('GET /api/admin/keys-backup downloads keys.json only when the keys come from that file, and records when', async () => {
  assert.equal((await sup.get('/api/admin/keys-backup')).status, 403);
  assert.equal((await nav.get('/api/admin/keys-backup')).status, 403);
  const was = config.keySource;
  try {
    config.keySource = 'env';
    const env = await admin.get('/api/admin/keys-backup');
    assert.equal(env.status, 400); assert.match(env.data.error, /environment/);
    config.keySource = 'file';
    const body = JSON.stringify({ SUDS_ENCRYPTION_KEY: 'a'.repeat(64), SUDS_INDEX_KEY: 'b'.repeat(64) });
    fs.writeFileSync(config.keysJsonPath, body);
    const r = await admin.get('/api/admin/keys-backup');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /suds-keys-KEEP-SECRET\.json/);
    assert.deepEqual(r.data, JSON.parse(body));
    assert.ok(H.db.getSetting('keys_backup_at', null), 'the dashboard can stop asking');
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='keys.download'`));
  } finally { config.keySource = was; fs.rmSync(config.keysJsonPath, { force: true }); }
});

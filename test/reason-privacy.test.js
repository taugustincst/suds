'use strict';
// A free-text reason (why a record was deleted, merged, put on or taken off legal hold, re-admitted, why a
// court order was vacated, why break-glass access was needed) can name the client or their situation. The
// audit log is not encrypted and travels whole in auditor exports, so the text is kept encrypted on the row
// it concerns and the audit entry says only that a reason was recorded.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const { decrypt, uuid, encrypt } = require('../server/crypto');

const SECRET = 'Zebra-Mercury';
const leaks = () => H.db.all(`SELECT action, details FROM audit_log WHERE details LIKE ?`, `%${SECRET}%`);

test('migration: plaintext court_orders.vacated_reason and clients.legal_hold_reason move into encrypted columns', () => {
  const db = require('../server/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-reason-'));
  const file = path.join(dir, 'suds.db');
  try {
    db.open(file);
    const latest = db.LATEST_SCHEMA_VERSION;
    const d = db.get();
    // Put the database back the way the migration before this one left it.
    const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const [t, c] of [['court_orders', 'vacated_reason_enc'], ['clients', 'legal_hold_reason_enc'], ['clients', 'legal_hold_cleared_reason_enc'], ['clients', 'removed_reason_enc'], ['episodes', 'reopen_reason_enc']]) {
      if (cols(t).includes(c)) d.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    }
    if (!cols('court_orders').includes('vacated_reason')) d.exec(`ALTER TABLE court_orders ADD COLUMN vacated_reason TEXT`);
    if (!cols('clients').includes('legal_hold_reason')) d.exec(`ALTER TABLE clients ADD COLUMN legal_hold_reason TEXT`);
    const user = uuid(), client = uuid(), order = uuid();
    d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`).run(user, 'm1', 'x', 'M One', 'supervisor');
    d.prepare(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,created_by,legal_hold,legal_hold_reason) VALUES(?,?,?,?,?,?,?,?)`)
      .run(client, 'M26-9001', encrypt('Ada'), encrypt('Lovelace'), 'active', user, 1, `Subpoena ${SECRET}`);
    d.prepare(`INSERT INTO court_orders(id,client_id,order_type,court_enc,issued_at,purpose_enc,scope_enc,status,vacated_at,vacated_reason,recorded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(order, client, 'noncriminal_2_64', encrypt('Court'), '2026-01-01', encrypt('p'), encrypt('s'), 'vacated', '2026-02-01', `Reversed ${SECRET}`, user);
    // 35: the version before migration 36 (later migrations are no-ops on columns already in their final form).
    d.prepare(`UPDATE settings SET value=? WHERE key='schema_version'`).run('35');
    db.close();
    db.open(file);
    assert.equal(db.getSetting('schema_version'), String(latest));
    assert.ok(!db.all(`PRAGMA table_info(court_orders)`).some((c) => c.name === 'vacated_reason'), 'plaintext vacated_reason is gone');
    assert.ok(!db.all(`PRAGMA table_info(clients)`).some((c) => c.name === 'legal_hold_reason'), 'plaintext legal_hold_reason is gone');
    const o = db.one(`SELECT vacated_reason_enc FROM court_orders WHERE id=?`, order);
    assert.match(o.vacated_reason_enc, /^v1:/); assert.equal(decrypt(o.vacated_reason_enc), `Reversed ${SECRET}`);
    const c = db.one(`SELECT legal_hold_reason_enc FROM clients WHERE id=?`, client);
    assert.equal(decrypt(c.legal_hold_reason_enc), `Subpoena ${SECRET}`);
    for (const col of ['legal_hold_cleared_reason_enc', 'removed_reason_enc']) assert.ok(db.all(`PRAGMA table_info(clients)`).some((x) => x.name === col), col);
    assert.ok(db.all(`PRAGMA table_info(episodes)`).some((x) => x.name === 'reopen_reason_enc'));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Migration 37: the remaining free text scoped to a client or a note — an addendum's reason, a consent's
// revocation reason, a countersignature note, an assignment's notes, a time entry's or expenditure's
// description and reviewer's note, a client form's notes and a client's contact preferences.
const MOVED_37 = [
  ['notes', 'cosign_note', 'cosign_note_enc'], ['note_addenda', 'reason', 'reason_enc'], ['consents', 'revoked_reason', 'revoked_reason_enc'],
  ['assignments', 'notes', 'notes_enc'], ['time_entries', 'description', 'description_enc'], ['time_entries', 'approval_note', 'approval_note_enc'],
  ['expenditures', 'description', 'description_enc'], ['expenditures', 'approval_note', 'approval_note_enc'], ['client_forms', 'notes', 'notes_enc'],
  ['clients', 'contact_preferences', 'contact_preferences_enc'],
];

test('migration 37: plaintext addendum, revocation, cosign, assignment, time, expenditure, form and contact text move into encrypted columns', () => {
  const db = require('../server/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-reason37-'));
  const file = path.join(dir, 'suds.db');
  try {
    db.open(file);
    const latest = db.LATEST_SCHEMA_VERSION;
    assert.ok(latest >= 37, 'migration 37 exists');
    const d = db.get();
    const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    // Put the database back the way migration 36 left it: the plaintext columns, not the encrypted ones.
    for (const [t, from, to] of MOVED_37) {
      if (cols(t).includes(to)) d.exec(`ALTER TABLE ${t} DROP COLUMN ${to}`);
      if (!cols(t).includes(from)) d.exec(`ALTER TABLE ${t} ADD COLUMN ${from} TEXT`);
    }
    const user = uuid(), client = uuid(), note = uuid(), addendum = uuid(), consent = uuid(), assignment = uuid(), fund = uuid(), time = uuid(), spend = uuid(), form = uuid();
    d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`).run(user, 'm37', 'x', 'M Seven', 'supervisor');
    d.prepare(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,created_by,contact_preferences) VALUES(?,?,?,?,?,?,?)`)
      .run(client, 'M26-9037', encrypt('Ada'), encrypt('Lovelace'), 'active', user, `Never call before noon, ${SECRET} reads texts`);
    d.prepare(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status,cosign_note) VALUES(?,?,?,?,?,?,?,?)`)
      .run(note, client, user, 'admin', encrypt('c'), '2026-09-01T10:00:00Z', 'signed', `Agree; ${SECRET} relapse noted`);
    d.prepare(`INSERT INTO note_addenda(id,note_id,author_id,content_enc,reason) VALUES(?,?,?,?,?)`).run(addendum, note, user, encrypt('a'), `Late entry about ${SECRET}`);
    d.prepare(`INSERT INTO consents(id,client_id,type,signed_at,revoked_at,revoked_reason,created_by) VALUES(?,?,?,?,?,?,?)`)
      .run(consent, client, 'roi', '2026-01-01', '2026-02-01', `Fell out with ${SECRET}`, user);
    d.prepare(`INSERT INTO assignments(id,client_id,user_id,start_date,notes) VALUES(?,?,?,?,?)`).run(assignment, client, user, '2026-01-01', `Took over from ${SECRET}`);
    d.prepare(`INSERT INTO funding_sources(id,name,fiscal_year_start,fiscal_year_end) VALUES(?,?,?,?)`).run(fund, 'Fund', '2026-01-01', '2026-12-31');
    d.prepare(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,description,approval_note) VALUES(?,?,?,?,?,?,?)`)
      .run(time, user, client, '2026-09-01', 30, `Drove ${SECRET} to detox`, `Wrong date for ${SECRET}`);
    d.prepare(`INSERT INTO expenditures(id,funding_source_id,user_id,client_id,spent_at,amount,category,description,approval_note) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(spend, fund, user, client, '2026-09-01', 12.5, 'client_assistance', `Motel night for ${SECRET}`, `Receipt names ${SECRET}`);
    d.prepare(`INSERT INTO client_forms(id,client_id,template_name,values_enc,created_by,notes) VALUES(?,?,?,?,?,?)`)
      .run(form, client, 'Intake', encrypt('{}'), user, `Signed at ${SECRET}'s house`);
    // Blank text stays blank rather than becoming an encrypted empty string.
    d.prepare(`INSERT INTO assignments(id,client_id,user_id,start_date,notes) VALUES(?,?,?,?,?)`).run(uuid(), client, user, '2026-01-02', '');
    d.prepare(`UPDATE settings SET value=? WHERE key='schema_version'`).run('36'); // as migration 36 left it: 37 and every later step run
    db.close();
    db.open(file);
    assert.equal(db.getSetting('schema_version'), String(latest));
    for (const [t, from, to] of MOVED_37) {
      const names = db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.ok(!names.includes(from), `plaintext ${t}.${from} is gone`);
      assert.ok(names.includes(to), `${t}.${to} exists`);
    }
    const dec = (t, col, id) => { const v = db.one(`SELECT ${col} FROM ${t} WHERE id=?`, id)[col]; assert.match(v, /^v1:/, `${t}.${col} is ciphertext`); return decrypt(v); };
    assert.equal(dec('clients', 'contact_preferences_enc', client), `Never call before noon, ${SECRET} reads texts`);
    assert.equal(dec('notes', 'cosign_note_enc', note), `Agree; ${SECRET} relapse noted`);
    assert.equal(dec('note_addenda', 'reason_enc', addendum), `Late entry about ${SECRET}`);
    assert.equal(dec('consents', 'revoked_reason_enc', consent), `Fell out with ${SECRET}`);
    assert.equal(dec('assignments', 'notes_enc', assignment), `Took over from ${SECRET}`);
    assert.equal(dec('time_entries', 'description_enc', time), `Drove ${SECRET} to detox`);
    assert.equal(dec('time_entries', 'approval_note_enc', time), `Wrong date for ${SECRET}`);
    assert.equal(dec('expenditures', 'description_enc', spend), `Motel night for ${SECRET}`);
    assert.equal(dec('expenditures', 'approval_note_enc', spend), `Receipt names ${SECRET}`);
    assert.equal(dec('client_forms', 'notes_enc', form), `Signed at ${SECRET}'s house`);
    assert.equal(db.one(`SELECT COUNT(*) n FROM assignments WHERE client_id=? AND notes_enc IS NULL`, client).n, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

let admin, sup, clin;
test('start the API', async () => {
  await H.start();
  H.makeUser('rp_sup', 'supervisor'); H.makeUser('rp_clin', 'clinician');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('rp_sup', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('rp_clin', 'StaffPassw0rd!x');
});
after(() => H.stop());

const newClient = async (c = sup) => { const r = await c.post('/api/clients', { first_name: 'Rea', last_name: `Son${Math.random().toString(36).slice(2, 7)}`, confirm_duplicate: true }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
const lastDetails = (action, entityId) => JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action=? AND entity_id=? ORDER BY id DESC LIMIT 1`, action, entityId).details || '{}');

test('legal hold: the reason is stored encrypted, shown to the client view, and not in the audit entry', async () => {
  const c = await newClient();
  assert.equal((await admin.post(`/api/clients/${c.id}/legal-hold`, { hold: true, reason: `Subpoena ${SECRET} v. County` })).status, 200);
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, c.id);
  assert.ok(!('legal_hold_reason' in row));
  assert.equal(decrypt(row.legal_hold_reason_enc), `Subpoena ${SECRET} v. County`);
  assert.equal((await admin.get(`/api/clients/${c.id}`)).data.client.legal_hold_reason, `Subpoena ${SECRET} v. County`);
  assert.deepEqual(lastDetails('client.legal_hold.set', c.id), { reason_recorded: true });
  assert.equal((await admin.post(`/api/clients/${c.id}/legal-hold`, { hold: false, reason: `Matter ${SECRET} settled` })).status, 200);
  const cleared = H.db.one(`SELECT * FROM clients WHERE id=?`, c.id);
  assert.equal(cleared.legal_hold_reason_enc, null);
  assert.equal(decrypt(cleared.legal_hold_cleared_reason_enc), `Matter ${SECRET} settled`);
  assert.deepEqual(lastDetails('client.legal_hold.clear', c.id), { reason_recorded: true });
  assert.equal((await admin.post(`/api/clients/${c.id}/legal-hold`, { hold: false })).status, 200);
  assert.deepEqual(lastDetails('client.legal_hold.clear', c.id), {});
  assert.deepEqual(leaks(), []);
});

test('delete and merge: the reason is kept encrypted on the removed record, the audit entry says only that one was given', async () => {
  const c = await newClient();
  assert.equal((await admin.del(`/api/clients/${c.id}`, { reason: `Duplicate entered for ${SECRET}` })).status, 200);
  assert.equal(decrypt(H.db.one(`SELECT removed_reason_enc FROM clients WHERE id=?`, c.id).removed_reason_enc), `Duplicate entered for ${SECRET}`);
  assert.deepEqual(lastDetails('client.delete', c.id), { reason_recorded: true });

  const keep = await newClient(); const dup = await newClient();
  const m = await sup.post(`/api/clients/${keep.id}/merge`, { source_id: dup.id, reason: `Same person, ${SECRET} alias` });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(decrypt(H.db.one(`SELECT removed_reason_enc FROM clients WHERE id=?`, dup.id).removed_reason_enc), `Same person, ${SECRET} alias`);
  const d = lastDetails('client.merge', keep.id);
  assert.equal(d.reason, undefined); assert.equal(d.reason_recorded, true); assert.equal(d.merged, dup.id);
  assert.deepEqual(leaks(), []);
});

test('episode reopen: the reason is stored encrypted on the episode, not in the audit entry', async () => {
  const c = await newClient();
  assert.equal((await sup.post(`/api/episodes/${c.episode_id}/close`, { discharge_reason: 'lost_contact' })).status, 200);
  assert.equal((await sup.post(`/api/episodes/${c.episode_id}/reopen`, { reason: `Discharged in error, ${SECRET} still attending` })).status, 200);
  const e = H.db.one(`SELECT reopen_reason_enc FROM episodes WHERE id=?`, c.episode_id);
  assert.equal(decrypt(e.reopen_reason_enc), `Discharged in error, ${SECRET} still attending`);
  const d = lastDetails('episode.reopen', c.episode_id);
  assert.equal(d.reason, undefined); assert.equal(d.reason_recorded, true);
  assert.deepEqual(leaks(), []);
});

test('court order vacate: the reason is encrypted in vacated_reason_enc and returned decrypted', async () => {
  const c = await newClient();
  const ORDER = { order_type: 'noncriminal_2_64', court: 'Superior Court, Dept 4', case_ref: '26-FL-0042', issued_at: '2026-09-01', purpose: 'Custody hearing', scope: 'Attendance dates only', findings_recorded: true, notice_requirement_met: true };
  const o = await sup.post(`/api/clients/${c.id}/court-orders`, ORDER);
  assert.equal(o.status, 201, JSON.stringify(o.data));
  assert.equal((await sup.post(`/api/court-orders/${o.data.id}/vacate`, { reason: `Reversed on appeal, ${SECRET}` })).status, 200);
  const row = H.db.one(`SELECT * FROM court_orders WHERE id=?`, o.data.id);
  assert.ok(!('vacated_reason' in row));
  assert.match(row.vacated_reason_enc, /^v1:/); assert.equal(decrypt(row.vacated_reason_enc), `Reversed on appeal, ${SECRET}`);
  const got = (await sup.get(`/api/court-orders/${o.data.id}`)).data.row;
  assert.equal(got.vacated_reason, `Reversed on appeal, ${SECRET}`); assert.equal(got.vacated_reason_enc, undefined);
  assert.deepEqual(lastDetails('court_order.vacate', o.data.id), { reason_recorded: true });
  assert.deepEqual(leaks(), []);
});

test('break-glass: the reason stays in the encrypted review queue; the audit entry points at the queued event', async () => {
  const c = await newClient(clin);
  const n = await clin.post('/api/notes', { client_id: c.id, kind: 'clinical', content: 'Relapse discussed.', occurred_at: '2026-09-05T10:00:00Z' });
  assert.equal(n.status, 201);
  const why = `Privacy officer investigation into ${SECRET} complaint`;
  assert.equal((await admin.get(`/api/notes/${n.data.id}`, { 'X-Break-Glass-Reason': why })).status, 200);
  assert.equal((await admin.get(`/api/notes?client_id=${c.id}&kind=clinical`, { 'X-Break-Glass-Reason': why })).status, 200);
  const events = H.db.all(`SELECT id, reason_enc FROM breakglass_events WHERE client_id=? ORDER BY at`, c.id);
  assert.equal(events.length, 2); assert.equal(decrypt(events[0].reason_enc), why);
  const view = lastDetails('note.view.breakglass', n.data.id);
  assert.deepEqual(view, { reason_recorded: true, breakglass_event: events[0].id });
  const list = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.list.breakglass' AND client_id=? ORDER BY id DESC LIMIT 1`, c.id).details);
  assert.deepEqual(list, { reason_recorded: true, breakglass_event: events[1].id });
  assert.deepEqual(leaks(), []);
});

// ---- migration 37's columns, through the API ----
const noEnc = (o, col) => assert.ok(!(col in o) || o[col] === undefined, `${col} is not sent to the browser`);

test('note addendum reason and countersignature note: stored encrypted, returned decrypted, not in the audit log', async () => {
  const c = await newClient(clin);
  const n = await clin.post('/api/notes', { client_id: c.id, kind: 'admin', content: 'Housing call.', occurred_at: '2026-09-05T10:00:00Z' });
  assert.equal(n.status, 201);
  assert.equal((await clin.post(`/api/notes/${n.data.id}/sign`, { password: 'StaffPassw0rd!x' })).status, 200);
  const a = await clin.post(`/api/notes/${n.data.id}/addenda`, { content: 'Correction.', reason: `Late entry: ${SECRET} called back` });
  assert.equal(a.status, 201);
  const row = H.db.one(`SELECT * FROM note_addenda WHERE id=?`, a.data.id);
  assert.ok(!('reason' in row)); assert.match(row.reason_enc, /^v1:/); assert.equal(decrypt(row.reason_enc), `Late entry: ${SECRET} called back`);
  const cs = await sup.post(`/api/notes/${n.data.id}/cosign`, { password: 'StaffPassw0rd!x', note: `Agree; watch ${SECRET} at the next visit` });
  assert.equal(cs.status, 200, JSON.stringify(cs.data));
  const nr = H.db.one(`SELECT * FROM notes WHERE id=?`, n.data.id);
  assert.ok(!('cosign_note' in nr)); assert.equal(decrypt(nr.cosign_note_enc), `Agree; watch ${SECRET} at the next visit`);
  const got = (await sup.get(`/api/notes/${n.data.id}`)).data.note;
  assert.equal(got.addenda[0].reason, `Late entry: ${SECRET} called back`); noEnc(got.addenda[0], 'reason_enc');
  assert.equal(got.cosign_note, `Agree; watch ${SECRET} at the next visit`); noEnc(got, 'cosign_note_enc');
  assert.deepEqual(lastDetails('note.addendum', n.data.id), { reason_recorded: true });
  assert.deepEqual(leaks(), []);
});

test('consent revocation reason: stored encrypted, returned decrypted, not in the audit log', async () => {
  const c = await newClient();
  const k = await sup.post(`/api/clients/${c.id}/consents`, { type: 'roi', signed_at: '2026-01-01', recipient: 'County clinic', purpose: 'Coordination' });
  assert.equal(k.status, 201, JSON.stringify(k.data));
  assert.equal((await sup.post(`/api/consents/${k.data.id}/revoke`, { reason: `Does not want ${SECRET} told` })).status, 200);
  const row = H.db.one(`SELECT * FROM consents WHERE id=?`, k.data.id);
  assert.ok(!('revoked_reason' in row)); assert.equal(decrypt(row.revoked_reason_enc), `Does not want ${SECRET} told`);
  const got = (await sup.get(`/api/clients/${c.id}/consents`)).data.consents.find((x) => x.id === k.data.id);
  assert.equal(got.revoked_reason, `Does not want ${SECRET} told`); noEnc(got, 'revoked_reason_enc');
  assert.equal(lastDetails('consent.revoke', k.data.id).reason_recorded, true);
  assert.equal((await sup.get(`/api/consents/${k.data.id}/pdf`)).status, 200);
  assert.deepEqual(leaks(), []);
});

test('assignment notes and contact preferences: stored encrypted, shown on the client record', async () => {
  const c = await newClient();
  const upd = await sup.put(`/api/clients/${c.id}`, { contact_preferences: `Text only; ${SECRET} checks the voicemail` });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const clinId = H.db.one(`SELECT id FROM users WHERE username='rp_clin'`).id;
  const a = await sup.post(`/api/clients/${c.id}/assignments`, { user_id: clinId, role_on_case: 'clinician', notes: `Knows ${SECRET} from the shelter` });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const cr = H.db.one(`SELECT * FROM clients WHERE id=?`, c.id);
  assert.ok(!('contact_preferences' in cr)); assert.equal(decrypt(cr.contact_preferences_enc), `Text only; ${SECRET} checks the voicemail`);
  const ar = H.db.one(`SELECT * FROM assignments WHERE id=?`, a.data.id);
  assert.ok(!('notes' in ar)); assert.equal(decrypt(ar.notes_enc), `Knows ${SECRET} from the shelter`);
  const got = (await sup.get(`/api/clients/${c.id}`)).data.client;
  assert.equal(got.contact_preferences, `Text only; ${SECRET} checks the voicemail`); noEnc(got, 'contact_preferences_enc');
  const ga = got.assignments.find((x) => x.id === a.data.id);
  assert.equal(ga.notes, `Knows ${SECRET} from the shelter`); noEnc(ga, 'notes_enc');
  assert.deepEqual(leaks(), []);
});

test('time entry description and reviewer note: stored encrypted, round-trip through the API, not in the audit log', async () => {
  const c = await newClient(clin);
  const t = await clin.post('/api/time', { client_id: c.id, work_date: '2026-09-05', minutes: 45, description: `Drove ${SECRET} to detox intake` });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  const row = H.db.one(`SELECT * FROM time_entries WHERE id=?`, t.data.id);
  assert.ok(!('description' in row)); assert.equal(decrypt(row.description_enc), `Drove ${SECRET} to detox intake`);
  assert.equal((await clin.put(`/api/time/${t.data.id}`, { description: `Drove ${SECRET} to detox intake (Kern)` })).status, 200);
  assert.equal(decrypt(H.db.one(`SELECT description_enc FROM time_entries WHERE id=?`, t.data.id).description_enc), `Drove ${SECRET} to detox intake (Kern)`);
  assert.equal((await clin.post(`/api/time/${t.data.id}/submit`)).status, 200);
  const q = (await sup.get('/api/supervision/queue')).data.time_awaiting_approval.find((x) => x.id === t.data.id);
  assert.ok(q, 'in the approval queue');
  assert.equal((await sup.post(`/api/time/${t.data.id}/approve`, { decision: 'rejected', note: `Wrong date: ${SECRET} was seen Tuesday` })).status, 200);
  assert.equal(decrypt(H.db.one(`SELECT approval_note_enc FROM time_entries WHERE id=?`, t.data.id).approval_note_enc), `Wrong date: ${SECRET} was seen Tuesday`);
  assert.equal(lastDetails('time.rejected', t.data.id).note_recorded, true);
  const got = (await clin.get(`/api/time/${t.data.id}`)).data.row;
  assert.equal(got.description, `Drove ${SECRET} to detox intake (Kern)`); assert.equal(got.approval_note, `Wrong date: ${SECRET} was seen Tuesday`);
  noEnc(got, 'description_enc'); noEnc(got, 'approval_note_enc');
  const list = (await clin.get(`/api/time?client_id=${c.id}`)).data.rows.find((x) => x.id === t.data.id);
  assert.equal(list.description, `Drove ${SECRET} to detox intake (Kern)`); noEnc(list, 'description_enc');
  assert.deepEqual(leaks(), []);
});

test('expenditure description and reviewer note: stored encrypted, round-trip through the API, the note is not in the audit log', async () => {
  const c = await newClient();
  const f = await admin.post('/api/budget/funds', { name: 'Reason privacy fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  assert.equal(f.status, 201, JSON.stringify(f.data));
  const e = await sup.post('/api/budget/expenditures', { client_id: c.id, funding_source_id: f.data.id, spent_at: '2026-09-05', amount: 40, category: 'client_assistance', vendor: 'Motel', description: `Night's stay for ${SECRET}` });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  const row = H.db.one(`SELECT * FROM expenditures WHERE id=?`, e.data.id);
  assert.ok(!('description' in row)); assert.equal(decrypt(row.description_enc), `Night's stay for ${SECRET}`);
  assert.equal((await admin.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'rejected', note: `Receipt shows ${SECRET}'s full name` })).status, 200);
  assert.equal(decrypt(H.db.one(`SELECT approval_note_enc FROM expenditures WHERE id=?`, e.data.id).approval_note_enc), `Receipt shows ${SECRET}'s full name`);
  const d = lastDetails('expenditure.rejected', e.data.id);
  assert.equal(d.note, undefined); assert.equal(d.note_recorded, true);
  const got = (await sup.get(`/api/budget/expenditures/${e.data.id}`)).data.row;
  assert.equal(got.description, `Night's stay for ${SECRET}`); assert.equal(got.approval_note, `Receipt shows ${SECRET}'s full name`);
  noEnc(got, 'description_enc'); noEnc(got, 'approval_note_enc');
  assert.deepEqual(leaks(), []);
});

test('client form notes: stored encrypted, returned decrypted', async () => {
  const c = await newClient();
  const tpl = await admin.post('/api/forms/templates', { name: 'Reason privacy form', category: 'intake_screening', fields: [{ key: 'a', label: 'A', type: 'text' }] });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
  const fm = await sup.post(`/api/clients/${c.id}/forms`, { template_id: tpl.data.id });
  assert.equal(fm.status, 201, JSON.stringify(fm.data));
  assert.equal((await sup.put(`/api/forms/${fm.data.id}`, { notes: `Signed at ${SECRET}'s sister's house` })).status, 200);
  const row = H.db.one(`SELECT * FROM client_forms WHERE id=?`, fm.data.id);
  assert.ok(!('notes' in row)); assert.equal(decrypt(row.notes_enc), `Signed at ${SECRET}'s sister's house`);
  const list = (await sup.get(`/api/clients/${c.id}/forms`)).data.forms.find((x) => x.id === fm.data.id);
  assert.equal(list.notes, `Signed at ${SECRET}'s sister's house`); noEnc(list, 'notes_enc');
  const one = (await sup.get(`/api/forms/${fm.data.id}`)).data.form;
  assert.equal(one.notes, `Signed at ${SECRET}'s sister's house`); noEnc(one, 'notes_enc');
  assert.deepEqual(leaks(), []);
});

test('sync: a kernel from before migration 37 still lands its plaintext column names, encrypted', async (t) => {
  // Devices sync only with local mode on (it is off by default on a server).
  const config = require('../server/config'); const was = config.localModeEnabled; config.localModeEnabled = true;
  t.after(() => { config.localModeEnabled = was; });
  const c = await newClient(clin);
  const clinId = H.db.one(`SELECT id FROM users WHERE username='rp_clin'`).id;
  const now = new Date().toISOString();
  const te = uuid(), note = uuid(), add = uuid();
  const r = await clin.post('/api/sync/push', { device_now: now, tables: {
    time_entries: [{ id: te, user_id: clinId, client_id: c.id, work_date: '2026-09-06', minutes: 20, category: 'direct_service', description: `Phoned ${SECRET}`, created_at: now, updated_at: now }],
    notes: [{ id: note, client_id: c.id, author_id: clinId, kind: 'admin', format: 'narrative', content_enc: 'Synced note', occurred_at: now, status: 'draft', created_at: now, updated_at: now }],
    note_addenda: [{ id: add, note_id: note, author_id: clinId, content_enc: 'Synced addendum', reason: `Late: ${SECRET}`, created_at: now, updated_at: now }],
  } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.rejected.length, 0, JSON.stringify(r.data.rejected));
  assert.equal(decrypt(H.db.one(`SELECT description_enc FROM time_entries WHERE id=?`, te).description_enc), `Phoned ${SECRET}`);
  assert.equal(decrypt(H.db.one(`SELECT reason_enc FROM note_addenda WHERE id=?`, add).reason_enc), `Late: ${SECRET}`);
  // What an office sends a device carries the new column names, decrypted for transport.
  const SYNC = require('../server/sync-tables');
  const spec = SYNC.tables.find((x) => x.name === 'time_entries');
  assert.equal(SYNC.exportRow(spec, H.db.one(`SELECT * FROM time_entries WHERE id=?`, te)).description_enc, `Phoned ${SECRET}`);
  assert.deepEqual(leaks(), []);
});

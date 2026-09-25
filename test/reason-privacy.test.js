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
    d.prepare(`UPDATE settings SET value=? WHERE key='schema_version'`).run(String(latest - 1));
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

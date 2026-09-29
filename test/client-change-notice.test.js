'use strict';
// 1.16.1, the owner's decision: anyone who can see a client may update their record, and when the editor is not
// on the client's care team the primary worker is told -- a to-do (the bell) naming who changed which fields,
// field names only, never the values. A device's edit tells them the same way.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const C = {}; const U = {};
let dec;
const notices = (clientId, to) => H.db.all(`SELECT * FROM tasks WHERE client_id=? AND assigned_to=? AND status='open'`, clientId, to)
  .map(t => ({ ...t, title: dec(t.title_enc), description: dec(t.description_enc) })).filter(t => t.description.includes('Reference: client record change'));

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ decrypt: dec } = require('../server/crypto'));
  for (const [k, role] of [['primary', 'navigator'], ['other', 'navigator'], ['clin', 'clinician']]) {
    const u = H.makeUser(`ccn_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
});
after(() => H.stop());

test('an edit by someone off the care team tells the primary worker which fields, never the values', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Nova', last_name: 'Notice', phone: '916-555-0101' })).data.id;
  const r = await C.other.put(`/api/clients/${id}`, { phone: '916-555-0199', risk_level: 'high' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const n = notices(id, U.primary);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /ccn_other changed .*record \(phone, risk level\)/);
  assert.ok(!n[0].title.includes('0199') && !n[0].description.includes('0199') && !n[0].description.includes('high'), 'no values');
  assert.ok(n[0].due_at, 'due now, so the bell shows it');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='client.change_notice' AND entity_id=? ORDER BY id DESC`, id);
  assert.deepEqual(JSON.parse(a.details).fields, ['phone', 'risk_level']);
  // A second edit the same day adds to the same to-do.
  await C.other.put(`/api/clients/${id}`, { status: 'inactive' });
  const again = notices(id, U.primary);
  assert.equal(again.length, 1); assert.match(again[0].title, /phone, risk level, status/);
});

test('the care team\'s own edits, and an edit that changes nothing, raise no notice', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Quiet', last_name: 'Notice' })).data.id;
  await C.primary.put(`/api/clients/${id}`, { phone: '916-555-0102' });
  assert.equal(notices(id, U.primary).length, 0);
  await C.other.put(`/api/clients/${id}`, { phone: '916-555-0102' });
  assert.equal(notices(id, U.primary).length, 0, 'the same value is no change');
});

test('a device\'s edit tells the primary worker the same way', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Sync', last_name: 'Notice', phone: '916-555-0103' })).data.id;
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, id);
  const res = await C.clin.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { clients: [{ id, client_code: row.client_code, first_name_enc: 'Sync', last_name_enc: 'Notice', phone_enc: '916-555-0177', status: row.status, updated_at: new Date(Date.now() + 5000).toISOString() }] } });
  assert.deepEqual(res.data.rejected, []);
  const n = notices(id, U.primary);
  assert.equal(n.length, 1); assert.match(n[0].title, /ccn_clin changed .*\(phone\)/);
});

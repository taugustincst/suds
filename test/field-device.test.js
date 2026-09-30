'use strict';
// Field devices (built for 1.21.0, not yet released; server/field-scope.js, docs/PLATFORM.md "Field devices").
// A device an administrator marks as a field device syncs only what a field worker needs: their own recent caseload's
// minimal record, their outreach contacts, supplies and lists, their own to-dos. The office enforces it on pull and on
// push, from its own record of the device the sync session signed in from, never from what the device says.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const SYNC = require('../server/sync-tables');
const FS = require('../server/field-scope');
const { uuid } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
const NEVER = '1970-01-01T00:00:00.000Z';
let admin; let office = {}; let nav; let other; let sup;
const ids = {};
const DEVICE = uuid();
const days = (n) => new Date(Date.now() - n * 86400000).toISOString();

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  nav = H.makeUser('fdnav', 'navigator', PW); other = H.makeUser('fdother', 'navigator', PW); sup = H.makeUser('fdsup', 'supervisor', PW);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const u of [nav, other, sup]) { office[u.username] = H.client(); await office[u.username].login(u.username, PW); }
  const mk = async (c, path, body) => { const r = await c.post(path, body); assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.data)}`); return r.data.id; };
  // A navigator's new client is assigned to them (routes/clients.js): the worker's own recent caseload.
  ids.recent = await mk(office.fdnav, '/api/clients', { first_name: 'Rhea', last_name: 'Fdrecent', dob: '1985-05-05', phone: '916-555-0101', address: '1 Field St' });
  ids.old = await mk(office.fdnav, '/api/clients', { first_name: 'Otto', last_name: 'Fdold', dob: '1970-01-02' });
  ids.theirs = await mk(office.fdother, '/api/clients', { first_name: 'Tia', last_name: 'Fdtheirs', dob: '1990-03-03' });
  // The old client was assigned long ago and has not been seen since: outside the 90-day window.
  H.db.run(`UPDATE assignments SET start_date=?, created_at=?, updated_at=? WHERE client_id=?`, days(400).slice(0, 10), days(400), days(400), ids.old);
  ids.visit = await mk(office.fdnav, '/api/interventions', { client_id: ids.recent, type: 'outreach', occurred_at: days(3), duration_minutes: 10 });
  ids.oldVisit = await mk(office.fdnav, '/api/interventions', { client_id: ids.recent, type: 'outreach', occurred_at: days(200), duration_minutes: 10 });
  ids.anon = await mk(office.fdnav, '/api/interventions', { type: 'outreach', occurred_at: days(1), participant_code: 'FDAB12' });
  ids.otherAnon = await mk(office.fdother, '/api/interventions', { type: 'outreach', occurred_at: days(1) });
  ids.note = await mk(office.fdnav, '/api/notes', { client_id: ids.recent, kind: 'admin', format: 'narrative', title: 'Fd note', content: 'Fd admin note', occurred_at: days(2) });
  ids.ownTask = await mk(office.fdnav, '/api/tasks', { client_id: ids.recent, title: 'Fd own task', assigned_to: nav.id });
  ids.otherTask = await mk(office.fdsup, '/api/tasks', { client_id: ids.recent, title: 'Fd someone else task', assigned_to: other.id });
  // One the navigator made and handed to someone else: theirs to change over REST, but not a to-do of their own.
  ids.handedTask = await mk(office.fdnav, '/api/tasks', { client_id: ids.recent, title: 'Fd handed on', assigned_to: other.id });
  ids.theirVisit = await mk(office.fdother, '/api/interventions', { client_id: ids.theirs, type: 'outreach', occurred_at: days(2), duration_minutes: 5 });
});
after(async () => { await H.stop(); });

const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 500)}`); return r.data; };
/** A device's sync session: the headers local/sync.js sends, signed in as `u`. */
async function deviceSession(u, deviceId = DEVICE, body = {}) {
  const c = H.client(); c.setHeader('X-Sync-Client', '1'); c.setHeader('X-Device-Id', deviceId);
  const r = ok(await c.post('/api/auth/login', { username: u.username, password: PW, ...body }), 200, 'device sign-in');
  return { c, login: r };
}
async function pullAll(c, since = NEVER, scope = null) {
  const tables = {}; let cursor = since; let last = null; const dropped = new Set();
  for (let i = 0; i < 50; i++) {
    last = ok(await c.get(`/api/sync/pull?since=${encodeURIComponent(cursor)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`), 200, 'pull');
    for (const [t, rows] of Object.entries(last.tables)) (tables[t] = tables[t] || []).push(...rows);
    for (const id of last.dropped_clients || []) dropped.add(id);
    cursor = last.cursor; scope = last.scope;
    if (last.complete) break;
  }
  return { tables, last, cursor, scope, dropped };
}
const idsOf = (rows) => (rows || []).map(r => r.id);

test('every synchronised table has an explicit field-device decision, and the decisions are well formed', () => {
  const names = SYNC.tables.map(t => t.name);
  for (const n of names) assert.ok(FS.TABLES[n], `${n} has no field-device decision in server/field-scope.js`);
  for (const n of Object.keys(FS.TABLES)) assert.ok(names.includes(n), `${n} is decided in field-scope.js but is not synchronised`);
  const cols = (t) => H.db.all(`PRAGMA table_info(${t})`).map(c => c.name);
  for (const [n, d] of Object.entries(FS.TABLES)) {
    assert.ok(['include', 'exclude', 'reduce'].includes(d.decision), `${n}: ${d.decision}`);
    assert.ok(d.why && d.why.length > 5, `${n} says why`);
    if (d.decision === 'reduce') assert.ok(d.rows || (d.blank && d.blank.length), `${n} is reduced by rows or by columns`);
    for (const c of d.blank || []) assert.ok(cols(n).includes(c), `${n}.${c} exists`);
    // A blanked column can never be one a row cannot do without.
    for (const c of d.blank || []) assert.equal(H.db.all(`PRAGMA table_info(${n})`).find(x => x.name === c).notnull, 0, `${n}.${c} is nullable`);
  }
  // Nothing clinical, legal or documentary is ever sent whole.
  for (const n of ['notes', 'note_addenda', 'consents', 'disclosures', 'episodes', 'client_forms', 'client_form_files', 'problems', 'care_plan_goals', 'asam_assessments', 'calls', 'referrals']) assert.equal(FS.TABLES[n].decision, 'exclude', n);
});

test('a device is a full device until an administrator makes it a field device; the change is audited', async () => {
  const { c, login } = await deviceSession(nav);
  assert.deepEqual(login.device, { scope: 'full' });
  const full = await pullAll(c);
  assert.equal(full.last.device_scope, 'full');
  assert.ok(idsOf(full.tables.clients).includes(ids.theirs), 'a navigator holds clients:all: the full scope carries every client');
  assert.ok(idsOf(full.tables.notes).includes(ids.note));
  ids.fullScope = full.scope; ids.fullCursor = full.cursor;
  // Only users:manage may change it.
  assert.equal((await office.fdsup.post(`/api/admin/devices/${DEVICE}/scope`, { scope: 'field' })).status, 403);
  assert.equal((await admin.post(`/api/admin/devices/${DEVICE}/scope`, { scope: 'everything' })).status, 400);
  const r = ok(await admin.post(`/api/admin/devices/${DEVICE}/scope`, { scope: 'field' }), 200, 'make field');
  assert.equal(r.changed, true);
  const listed = ok(await admin.get('/api/admin/devices'), 200, 'list').devices.find(d => d.id === DEVICE);
  assert.equal(listed.sync_scope, 'field');
  assert.equal(listed.field_applied_at, null, 'not applied until the device has pulled under it');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='device.scope' AND entity_id=? ORDER BY id DESC LIMIT 1`, DEVICE);
  assert.deepEqual(JSON.parse(a.details), { from: 'full', to: 'field', via: 'admin', device_user: nav.id });
});

test('before its first field pull the device may still send what it recorded under the full scope', async () => {
  const { c, login } = await deviceSession(nav);
  assert.deepEqual(login.device, { scope: 'field' });
  // An edit to the other worker's client, made offline while the device was a full device: not refused on the way in.
  const theirs = H.db.one(`SELECT * FROM clients WHERE id=?`, ids.theirs);
  const res = ok(await c.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { clients: [{ id: ids.theirs, client_code: theirs.client_code, first_name_enc: 'Tia', last_name_enc: 'Fdtheirs', city: 'Sacramento', updated_at: new Date().toISOString() }] } }), 200, 'push');
  assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected));
  assert.equal(H.db.one(`SELECT city FROM clients WHERE id=?`, ids.theirs).city, 'Sacramento');
});

test('a field device pulls only its worker\'s own recent caseload, minimal columns, own contacts and to-dos, nothing clinical', async () => {
  const { c } = await deviceSession(nav);
  // The key it last held was the full scope's: the office starts it again from the beginning, as a field device.
  const p = await pullAll(c, ids.fullCursor, ids.fullScope);
  const first = ok(await c.get(`/api/sync/pull?since=${encodeURIComponent(ids.fullCursor)}&scope=${encodeURIComponent(ids.fullScope)}`), 200, 'pull');
  assert.equal(first.field_reset, true, 'told to remove what it holds and start again');
  assert.equal(p.last.device_scope, 'field');
  assert.equal(p.last.field.window_days, 90);
  assert.match(p.last.field.holds, /own caseload/);
  const clients = idsOf(p.tables.clients);
  assert.deepEqual(clients, [ids.recent], 'only the recent client on their own caseload');
  const rec = p.tables.clients[0];
  assert.equal(rec.first_name_enc, 'Rhea');
  for (const col of ['dob_enc', 'phone_enc', 'address_enc']) assert.equal(rec[col], null, `${col} travels blank`);
  const visits = idsOf(p.tables.interventions);
  assert.ok(visits.includes(ids.visit) && visits.includes(ids.anon), 'the recent visit and their own anonymous contact');
  for (const x of [ids.oldVisit, ids.otherAnon, ids.theirVisit]) assert.ok(!visits.includes(x), 'nothing older than the window, nobody else\'s');
  assert.deepEqual(idsOf(p.tables.tasks), [ids.ownTask], 'their own to-do only');
  for (const t of ['notes', 'episodes', 'consents', 'calls', 'client_forms', 'referrals', 'time_entries']) assert.equal((p.tables[t] || []).length, 0, `${t} is never sent`);
  assert.ok((p.tables.supply_sites || []).length >= 1, 'supplies and sites are');
  const dev = H.db.one(`SELECT * FROM devices WHERE id=?`, DEVICE);
  assert.ok(dev.field_applied_at, 'from now on its pushes are held to the field scope');
  ids.fieldCursor = p.cursor; ids.fieldScope = p.scope;
});

test('a field device\'s sync session reaches the sync routes and nothing else', async () => {
  const { c } = await deviceSession(nav);
  const r = await c.get(`/api/clients/${ids.theirs}`);
  assert.equal(r.status, 403);
  assert.equal(r.data.fieldDevice, true);
  assert.equal((await c.get('/api/notes?client_id=' + ids.recent)).status, 403);
  // The same account in a browser is not a device: nothing changes for it.
  assert.equal((await office.fdnav.get(`/api/clients/${ids.theirs}`)).status, 200);
  // Attachments of a table a field device is never sent are not fetched by one either.
  assert.equal((await c.get(`/api/sync/blob/client_form_files/${uuid()}/data_enc`)).status, 403);
});

test('a field device cannot push outside its scope: excluded tables, other clients, other workers\' to-dos', async () => {
  const { c } = await deviceSession(nav);
  const now = new Date().toISOString();
  const res = ok(await c.post('/api/sync/push', { device_now: now, tables: {
    notes: [{ id: uuid(), client_id: ids.recent, kind: 'admin', format: 'narrative', title_enc: 'x', content_enc: 'y', occurred_at: now, status: 'draft', created_at: now, updated_at: now }],
    interventions: [
      { id: (ids.pushOk = uuid()), client_id: ids.recent, user_id: nav.id, type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now },
      { id: (ids.pushOther = uuid()), client_id: ids.theirs, user_id: nav.id, type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now },
      { id: (ids.pushOld = uuid()), client_id: ids.old, user_id: nav.id, type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now },
    ],
    tasks: [{ id: ids.handedTask, client_id: ids.recent, assigned_to: other.id, created_by: nav.id, title_enc: 'Changed by a field device', priority: 'normal', status: 'open', updated_at: now }],
  } }), 200, 'push');
  const why = Object.fromEntries(res.rejected.map(x => [x.id, x]));
  assert.ok(!why[ids.pushOk], 'a contact with a client in its set lands');
  assert.ok(H.db.one(`SELECT 1 FROM interventions WHERE id=?`, ids.pushOk));
  for (const id of [ids.pushOther, ids.pushOld, ids.handedTask]) {
    assert.ok(why[id], `refused: ${id}`);
    assert.match(why[id].reason, /outside this field device/);
    assert.equal(why[id].permanent, true, 'permanently: the device stops resending it');
  }
  assert.ok(res.rejected.some(x => x.table === 'notes' && /outside this field device/.test(x.reason)), 'a note is refused');
  assert.equal(H.db.one(`SELECT 1 AS x FROM interventions WHERE id=?`, ids.pushOther), undefined);
  // A to-do the office holds for someone else is untouched.
  assert.notEqual(require('../server/crypto').decrypt(H.db.one(`SELECT title_enc FROM tasks WHERE id=?`, ids.handedTask).title_enc), 'Changed by a field device');
  // Deleting outside the scope is refused the same way.
  const del = ok(await c.post('/api/sync/push', { device_now: now, tombstones: [{ table_name: 'interventions', id: ids.theirVisit, deleted_at: now }, { table_name: 'notes', id: ids.note, deleted_at: now }] }), 200, 'push tombstones');
  assert.equal(del.rejected.length, 2, JSON.stringify(del.rejected));
  assert.ok(H.db.one(`SELECT 1 AS x FROM interventions WHERE id=?`, ids.theirVisit));
});

test('a blank column a field device sends back never clears the office\'s value; a value it adds is kept', async () => {
  const { c } = await deviceSession(nav);
  const row = H.db.one(`SELECT client_code FROM clients WHERE id=?`, ids.recent);
  const res = ok(await c.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { clients: [{ id: ids.recent, client_code: row.client_code, first_name_enc: 'Rhea', last_name_enc: 'Fdrecent', dob_enc: null, phone_enc: null, address_enc: '', alt_phone_enc: '916-555-0199', flags_enc: 'dog', updated_at: new Date(Date.now() + 1000).toISOString() }] } }), 200, 'push');
  assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected));
  const M = require('../server/clients-model');
  const now = M.decryptRow(H.db.one(`SELECT * FROM clients WHERE id=?`, ids.recent));
  assert.equal(now.dob, '1985-05-05'); assert.equal(now.phone, '916-555-0101'); assert.equal(now.address, '1 Field St');
  assert.equal(now.alt_phone, '916-555-0199'); assert.equal(now.flags, 'dog');
});

test('a new client met in the field lands, with its assignment and first contact, in the same push', async () => {
  const { c } = await deviceSession(nav);
  const now = new Date().toISOString(); const id = (ids.newClient = uuid());
  const res = ok(await c.post('/api/sync/push', { device_now: now, tables: {
    clients: [{ id, client_code: 'M26-0901', first_name_enc: 'Nia', last_name_enc: 'Fdnew', status: 'active', created_at: now, updated_at: now }],
    assignments: [{ id: uuid(), client_id: id, user_id: nav.id, role_on_case: 'primary', start_date: now.slice(0, 10), created_at: now, updated_at: now }],
    interventions: [{ id: uuid(), client_id: id, user_id: nav.id, type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now }],
  } }), 200, 'push');
  assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected));
  assert.equal(res.applied.interventions, 1);
});

test('caseload transfer: a client moved to another worker leaves the field device, and its contacts are refused', async () => {
  const { c } = await deviceSession(nav);
  ok(await office.fdsup.post('/api/caseload/transfer', { from_user_id: nav.id, to_user_id: other.id, client_ids: [ids.newClient], reason: 'moved' }), 200, 'transfer');
  const p = await pullAll(c, ids.fieldCursor, ids.fieldScope);
  assert.ok(p.dropped.has(ids.newClient), 'named for removal');
  assert.ok(!p.dropped.has(ids.recent));
  assert.ok(!idsOf(p.tables.clients).includes(ids.newClient));
  ids.fieldCursor = p.cursor; ids.fieldScope = p.scope;
  const now = new Date().toISOString();
  const res = ok(await c.post('/api/sync/push', { device_now: now, tables: { interventions: [{ id: uuid(), client_id: ids.newClient, user_id: nav.id, type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now }] } }), 200, 'push');
  assert.equal(res.rejected.length, 1); assert.match(res.rejected[0].reason, /outside this field device/);
  // The worker it went to: a field device of theirs receives the client and what was recorded before (backfill).
  const theirDevice = uuid();
  ok(await admin.post('/api/admin/devices/' + theirDevice + '/scope', { scope: 'field' }), 404, 'an unknown device');
  const { c: oc } = await deviceSession(other, theirDevice);
  ok(await admin.post(`/api/admin/devices/${theirDevice}/scope`, { scope: 'field' }), 200, 'make field');
  const { c: oc2 } = await deviceSession(other, theirDevice);
  void oc;
  const q = await pullAll(oc2);
  assert.ok(idsOf(q.tables.clients).includes(ids.newClient), 'the moved client is on its new worker\'s field device');
  assert.ok(idsOf(q.tables.clients).includes(ids.theirs));
});

test('merge: a contact pushed for a merged-away client goes to the kept record only when that record is in the set', async () => {
  const { c } = await deviceSession(nav);
  // A second client of the navigator's, merged into the other worker's client.
  const dup = ok(await office.fdnav.post('/api/clients', { first_name: 'Tia', last_name: 'Fdtheirs', dob: '1990-03-04', confirm_duplicate: true }), 201, 'dup').id;
  let p = await pullAll(c, ids.fieldCursor, ids.fieldScope);
  assert.ok(idsOf(p.tables.clients).includes(dup));
  ids.fieldCursor = p.cursor; ids.fieldScope = p.scope;
  ok(await office.fdsup.post(`/api/clients/${ids.theirs}/merge`, { source_id: dup, reason: 'same person' }), 200, 'merge');
  // The navigator's assignment moved to the kept record, so it joins the set: it arrives with the merged row.
  p = await pullAll(c, ids.fieldCursor, ids.fieldScope);
  const got = idsOf(p.tables.clients);
  assert.ok(got.includes(ids.theirs), 'the kept record arrives');
  assert.ok(got.includes(dup), 'and the merged row, so the device re-points what it holds');
  ids.fieldCursor = p.cursor; ids.fieldScope = p.scope;
  // Then the kept record is moved to the other worker: a contact the device still records against the duplicate is
  // re-pointed at the kept record, which is no longer in its set, and refused.
  ok(await office.fdsup.post('/api/caseload/transfer', { from_user_id: nav.id, to_user_id: other.id, client_ids: [ids.theirs], reason: 'moved' }), 200, 'transfer');
  const now = new Date().toISOString();
  const res = ok(await c.post('/api/sync/push', { device_now: now, tables: { interventions: [{ id: uuid(), client_id: dup, user_id: nav.id, type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now }] } }), 200, 'push');
  assert.equal(res.rejected.length, 1, JSON.stringify(res.rejected)); assert.match(res.rejected[0].reason, /outside this field device/);
  p = await pullAll(c, ids.fieldCursor, ids.fieldScope);
  assert.ok(p.dropped.has(ids.theirs) && p.dropped.has(dup), 'both leave the device');
  ids.fieldCursor = p.cursor; ids.fieldScope = p.scope;
});

test('a client of their own caseload seen again comes back into the window, with what was recorded before', async () => {
  const { c } = await deviceSession(nav);
  ids.oldSeen = ok(await office.fdother.post('/api/interventions', { client_id: ids.old, type: 'outreach', occurred_at: days(1), duration_minutes: 5 }), 201, 'visit').id;
  const p = await pullAll(c, ids.fieldCursor, ids.fieldScope);
  assert.ok(idsOf(p.tables.clients).includes(ids.old), 'the client arrives');
  assert.ok(idsOf(p.tables.interventions).includes(ids.oldSeen));
  assert.ok(idsOf(p.tables.assignments).length >= 1, 'with the assignment that makes it the worker\'s');
  ids.fieldCursor = p.cursor; ids.fieldScope = p.scope;
});

test('the window is the programme\'s setting, within bounds', async () => {
  assert.equal((await admin.put('/api/admin/settings', { field_device_window_days: 3 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { field_device_window_days: 1000 })).status, 400);
  ok(await admin.put('/api/admin/settings', { field_device_window_days: 30 }), 200, 'set');
  const { c } = await deviceSession(nav);
  const p = await pullAll(c, ids.fieldCursor, ids.fieldScope);
  assert.equal(p.last.field.window_days, 30);
  const first = ok(await c.get(`/api/sync/pull?since=${encodeURIComponent(ids.fieldCursor)}&scope=${encodeURIComponent(ids.fieldScope)}`), 200, 'pull');
  assert.equal(first.field_reset, true, 'a changed window starts the device again');
  ok(await admin.put('/api/admin/settings', { field_device_window_days: null }), 200, 'back to the default');
});

test('an administrator makes it a full device again: the rest is sent, and blank columns still never clear the office\'s', async () => {
  ok(await admin.post(`/api/admin/devices/${DEVICE}/scope`, { scope: 'full' }), 200, 'make full');
  const { c, login } = await deviceSession(nav);
  assert.deepEqual(login.device, { scope: 'full' });
  // Sent before its first full pull: the row as a field device held it.
  const row = H.db.one(`SELECT client_code FROM clients WHERE id=?`, ids.recent);
  const res = ok(await c.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { clients: [{ id: ids.recent, client_code: row.client_code, first_name_enc: 'Rhea', last_name_enc: 'Fdrecent', dob_enc: null, phone_enc: null, updated_at: new Date(Date.now() + 5000).toISOString() }] } }), 200, 'push');
  assert.equal(res.rejected.length, 0);
  assert.equal(require('../server/clients-model').decryptRow(H.db.one(`SELECT * FROM clients WHERE id=?`, ids.recent)).dob, '1985-05-05');
  const first = ok(await c.get(`/api/sync/pull?since=${encodeURIComponent(ids.fieldCursor)}&scope=${encodeURIComponent(ids.fieldScope)}`), 200, 'pull');
  assert.equal(first.scope_widened, true, 'everything it may now hold is sent again');
  const p = await pullAll(c, ids.fieldCursor, ids.fieldScope);
  assert.ok(idsOf(p.tables.notes).includes(ids.note));
  assert.equal(H.db.one(`SELECT field_applied_at FROM devices WHERE id=?`, DEVICE).field_applied_at, null, 'whole again once a full pull completed');
  // Its user cannot widen a device, only narrow it.
  ok(await admin.post(`/api/admin/devices/${DEVICE}/scope`, { scope: 'field' }), 200, 'field');
  const again = await deviceSession(nav, DEVICE, { field_device: false });
  assert.deepEqual(again.login.device, { scope: 'field' });
});

test('its user may make a device a field device as they enrol it; the programme may make every new device one', async () => {
  const mine = uuid();
  const { login } = await deviceSession(nav, mine, { field_device: true });
  assert.deepEqual(login.device, { scope: 'field' });
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='device.scope' AND entity_id=? ORDER BY id DESC LIMIT 1`, mine);
  assert.equal(JSON.parse(a.details).via, 'enrolment');
  assert.equal((await admin.put('/api/admin/settings', { field_device_default: 'maybe' })).status, 400);
  ok(await admin.put('/api/admin/settings', { field_device_default: '1' }), 200, 'default on');
  const next = await deviceSession(nav, uuid());
  assert.deepEqual(next.login.device, { scope: 'field' });
  ok(await admin.put('/api/admin/settings', { field_device_default: '0' }), 200, 'default off');
  const plain = await deviceSession(nav, uuid());
  assert.deepEqual(plain.login.device, { scope: 'full' });
});

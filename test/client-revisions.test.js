'use strict';
// 1.17.0: client-record revision history with revert (server/client-revisions.js). Every change to a client's own
// fields keeps what each changed field held before and holds after, encrypted; the care team and records:manage-
// others read it; the primary worker or records:manage-others put a change back, which is a new revision.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const C = {}; const U = {};
let crypto;
const revs = (clientId) => H.db.all(`SELECT * FROM client_revisions WHERE client_id=? ORDER BY created_at, rowid`, clientId);
const changesOf = (r) => JSON.parse(crypto.decrypt(r.changes_enc));
const audits = (action, clientId) => H.db.all(`SELECT * FROM audit_log WHERE action=? AND client_id=? ORDER BY id`, action, clientId).map(a => ({ ...a, d: JSON.parse(a.details || '{}') }));

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  crypto = require('../server/crypto');
  for (const [k, role] of [['primary', 'navigator'], ['other', 'navigator'], ['second', 'navigator'], ['sup', 'supervisor'], ['fin', 'finance'], ['clin', 'clinician']]) {
    const u = H.makeUser(`rev_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
  C.admin = H.client(); await C.admin.login('admin', 'AdminPassw0rd!x');
});
after(() => H.stop());

async function newClient(extra = {}) {
  const r = await C.primary.post('/api/clients', { first_name: 'Rhea', last_name: `Revision${Math.random().toString(36).slice(2, 7)}`, phone: '916-555-0101', dob: '1990-02-03', ...extra, confirm_duplicate: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

test('an edit keeps each changed field\'s value before and after, encrypted, and nothing in plain text', async () => {
  const id = await newClient({ veteran: false });
  const r = await C.other.put(`/api/clients/${id}`, { phone: '916-555-0199', dob: '1990-02-04', veteran: true, city: 'Sacramento', first_name: 'Rhea' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.revision, 'the revision is named');
  const [row] = revs(id);
  assert.equal(row.id, r.data.revision); assert.equal(row.via, 'rest'); assert.equal(row.changed_by, U.other); assert.equal(row.reverts, null);
  assert.match(row.changes_enc, /^v1:/, 'encrypted like every _enc column');
  assert.ok(!/0199|0101|1990|Sacramento/.test(JSON.stringify(row)), 'no value in any column in plain text');
  assert.deepEqual(changesOf(row), { phone: { before: '916-555-0101', after: '916-555-0199' }, dob: { before: '1990-02-03', after: '1990-02-04' }, veteran: { before: 0, after: 1 }, city: { before: null, after: 'Sacramento' } },
    'only the fields that changed (first_name was sent unchanged)');
  // Audited by revision and field names, never a value.
  const a = audits('client.revision', id).at(-1);
  assert.deepEqual({ ...a.d, fields: [...a.d.fields].sort() }, { revision: row.id, via: 'rest', fields: ['city', 'dob', 'phone', 'veteran'] });
  assert.ok(!/0199|0101|1990|Sacramento/.test(H.db.all(`SELECT details FROM audit_log WHERE client_id=?`, id).map(x => x.details).join(' ')), 'no value in any audit entry');
  assert.equal(audits('client.update', id).at(-1).d.revision, row.id);
  // An edit that changes nothing keeps nothing.
  await C.primary.put(`/api/clients/${id}`, { phone: '916-555-0199' });
  assert.equal(revs(id).length, 1);
});

test('who reads the history: the care team and records:manage-others; not someone else who can open the record', async () => {
  const id = await newClient();
  await C.other.put(`/api/clients/${id}`, { phone: '916-555-0142' });
  assert.equal((await C.admin.post(`/api/clients/${id}/assignments`, { user_id: U.second, role_on_case: 'secondary' })).status, 201);
  for (const k of ['primary', 'second', 'sup', 'admin']) {
    const h = await C[k].get(`/api/clients/${id}/history`);
    assert.equal(h.status, 200, `${k}: ${JSON.stringify(h.data)}`);
    assert.equal(h.data.revisions.length, 1);
    const ch = h.data.revisions[0].changes[0];
    assert.deepEqual([ch.field, ch.label, ch.before, ch.after], ['phone', 'Phone', '916-555-0101', '916-555-0142']);
    assert.equal(h.data.revisions[0].by, 'rev_other'); assert.equal(h.data.revisions[0].via, 'rest');
  }
  // The editor off the care team can open the record (clients:all) but not its earlier values.
  const refused = await C.other.get(`/api/clients/${id}/history`);
  assert.equal(refused.status, 403);
  assert.ok(!JSON.stringify(refused.data).includes('0101'));
  assert.ok(audits('authz.denied', id).some(a => a.user_id === U.other && /client history/.test(a.d.reason)), 'the refusal is audited');
  // A de-identified role never reaches it.
  assert.equal((await C.fin.get(`/api/clients/${id}/history`)).status, 403);
  // Each read is audited by how many revisions it showed.
  assert.ok(audits('client.history.view', id).some(a => a.user_id === U.primary && a.d.revisions === 1));
  // The record tells each reader what they may do.
  const flags = async (k) => (await C[k].get(`/api/clients/${id}`)).data.client.history;
  assert.deepEqual(await flags('primary'), { read: true, revert: true, office_only: false });
  assert.deepEqual(await flags('second'), { read: true, revert: false, office_only: false });
  assert.deepEqual(await flags('sup'), { read: true, revert: true, office_only: false });
  assert.deepEqual(await flags('other'), { read: false, revert: false, office_only: false });
});

test('revert puts the fields back as a new revision, never deleting history; only the primary worker or a manager', async () => {
  const id = await newClient();
  const bad = (await C.other.put(`/api/clients/${id}`, { phone: '916-555-0666', dob: '1991-01-01' })).data.revision;
  assert.equal((await C.admin.post(`/api/clients/${id}/assignments`, { user_id: U.second, role_on_case: 'secondary' })).status, 201);
  assert.equal((await C.second.post(`/api/clients/${id}/history/${bad}/revert`, {})).status, 403, 'a secondary worker reads, but does not revert');
  assert.equal((await C.other.post(`/api/clients/${id}/history/${bad}/revert`, {})).status, 403, 'the editor off the care team cannot');
  assert.equal((await C.fin.post(`/api/clients/${id}/history/${bad}/revert`, {})).status, 403);
  assert.equal((await C.primary.post(`/api/clients/${id}/history/not-a-revision/revert`, {})).status, 404);
  const r = await C.primary.post(`/api/clients/${id}/history/${bad}/revert`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cur = (await C.primary.get(`/api/clients/${id}`)).data.client;
  assert.equal(cur.phone, '916-555-0101'); assert.equal(cur.dob, '1990-02-03');
  // Search by the restored values finds the client again (the blind indexes follow).
  assert.ok((await C.primary.get('/api/clients?q=916-555-0101')).data.clients.some(c => c.id === id));
  const all = revs(id);
  assert.equal(all.length, 2, 'the bad change is still there');
  assert.equal(all[1].reverts, bad); assert.equal(all[1].id, r.data.revision);
  assert.deepEqual(changesOf(all[1]), { phone: { before: '916-555-0666', after: '916-555-0101' }, dob: { before: '1991-01-01', after: '1990-02-03' } });
  const a = audits('client.revert', id).at(-1);
  assert.deepEqual({ ...a.d, fields: [...a.d.fields].sort() }, { reverted: bad, revision: r.data.revision, fields: ['dob', 'phone'] });
  const h = (await C.primary.get(`/api/clients/${id}/history`)).data.revisions;
  assert.deepEqual(h.find(x => x.id === bad).reverted_by, [r.data.revision]);
  assert.equal(h.find(x => x.id === r.data.revision).reverts, bad);
  // Reverting it again: the fields no longer hold what it set, so it is refused and named (never a value).
  const again = await C.primary.post(`/api/clients/${id}/history/${bad}/revert`, {});
  assert.equal(again.status, 409); assert.match(again.data.error, /(Phone, Date of birth|Date of birth, Phone) have been changed again since/);
  assert.ok(!/0666|0101/.test(JSON.stringify(again.data)));
  // A supervisor off the care team may revert (the revert of the revert), and the primary worker is told.
  const sup = await C.sup.post(`/api/clients/${id}/history/${r.data.revision}/revert`, {});
  assert.equal(sup.status, 200, JSON.stringify(sup.data));
  assert.equal((await C.primary.get(`/api/clients/${id}`)).data.client.phone, '916-555-0666');
  assert.ok(audits('client.change_notice', id).some(n => n.user_id === U.sup && n.d.revision === sup.data.revision), 'the notice names the revision');
});

test('revert follows the record\'s own rules: a name is never put back to nothing', async () => {
  const id = await newClient({ preferred_name: null });
  const rev = (await C.primary.put(`/api/clients/${id}`, { preferred_name: 'Ree' })).data.revision;
  assert.ok(rev);
  const back = await C.primary.post(`/api/clients/${id}/history/${rev}/revert`, {});
  assert.equal(back.status, 200);
  assert.equal((await C.primary.get(`/api/clients/${id}`)).data.client.preferred_name, null);
  // A first name "before" of nothing cannot happen through the form, but a revision recording one is refused.
  H.db.run(`INSERT INTO client_revisions(id,client_id,changed_by,via,changes_enc) VALUES(?,?,?,?,?)`, 'rev-noname', id, U.primary, 'rest', crypto.encrypt(JSON.stringify({ first_name: { before: null, after: 'Rhea' } })));
  assert.equal((await C.primary.post(`/api/clients/${id}/history/rev-noname/revert`, {})).status, 400);
});

test('a device\'s edit is kept as a revision when its push lands (via sync), and its notice links to it', async () => {
  const id = await newClient({ phone: '916-555-0461' });
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, id);
  const res = await C.clin.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { clients: [{ id, client_code: row.client_code, first_name_enc: 'Rhea', last_name_enc: crypto.decrypt(row.last_name_enc), phone_enc: '916-555-0177', status: row.status, updated_at: new Date(Date.now() + 5000).toISOString() }] } });
  assert.deepEqual(res.data.rejected, []);
  const [rev] = revs(id);
  assert.equal(rev.via, 'sync'); assert.equal(rev.changed_by, U.clin);
  assert.deepEqual(changesOf(rev), { phone: { before: '916-555-0461', after: '916-555-0177' } });
  const notice = (await C.primary.get(`/api/tasks?client_id=${id}`)).data.rows.find(t => t.notice);
  assert.ok(notice, 'the primary worker is told');
  assert.deepEqual(notice.notice_revisions, [rev.id], '"See what changed" links to the revision');
  assert.match(notice.description, /History/);
  // Revisions never travel to a device: the table is the office's.
  const SYNC = require('../server/sync-tables');
  assert.ok(SYNC.server_only.includes('client_revisions') && !SYNC.tables.some(t => t.name === 'client_revisions'));
  const pull = await C.primary.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
  assert.equal(pull.status, 200, JSON.stringify(pull.data).slice(0, 300));
  assert.ok(pull.data.tables && pull.data.tables.clients, 'a real pull');
  assert.ok(!('client_revisions' in pull.data.tables) && !JSON.stringify(pull.data).includes('916-555-0461'), 'no revision, and no earlier value, on the device');
});

test('a merge keeps what it filled in on the kept record as a revision; the duplicate\'s history stays with it', async () => {
  const keep = await newClient({ phone: null, email: null });
  const dup = await newClient({ phone: '916-555-0188', email: 'rhea@example.org' });
  await C.primary.put(`/api/clients/${dup}`, { city: 'Davis' });
  const dupRevs = revs(dup).map(r => r.id);
  const m = await C.sup.post(`/api/clients/${keep}/merge`, { source_id: dup, reason: 'same person' });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  const k = revs(keep);
  assert.equal(k.length, 1); assert.equal(k[0].via, 'merge');
  const ch = changesOf(k[0]);
  assert.deepEqual(ch.phone, { before: null, after: '916-555-0188' }); assert.deepEqual(ch.email, { before: null, after: 'rhea@example.org' }); assert.deepEqual(ch.city, { before: null, after: 'Davis' });
  assert.deepEqual(revs(dup).map(r => r.id), dupRevs, 'not moved onto the kept record');
  assert.equal(audits('client.merge', keep).at(-1).d.revision, k[0].id);
});

test('retention: the history is purged with the client, and leaves no tombstone', async () => {
  const id = await newClient();
  await C.primary.put(`/api/clients/${id}`, { phone: '916-555-0155' });
  const ids = revs(id).map(r => r.id);
  assert.equal(ids.length, 1);
  const R = require('../server/retention');
  assert.ok(R.DELETE_TABLES.includes('client_revisions') && R.NOT_ACTIVITY.includes('client_revisions'));
  H.db.run(`UPDATE tasks SET status='done' WHERE client_id=?`, id);
  const counts = R.purgeClient({ id, client_code: 'X', ended: '2010-01-01' });
  assert.equal(counts.client_revisions, 1);
  assert.equal(revs(id).length, 0);
  assert.ok(!H.db.one(`SELECT 1 FROM tombstones WHERE table_name='client_revisions' AND id=?`, ids[0]));
});

test('key rotation covers the history\'s encrypted column and leaves it readable', async () => {
  const id = await newClient();
  await C.primary.put(`/api/clients/${id}`, { phone: '916-555-0133' });
  const { encryptedColumns } = require('../scripts/rotate-key');
  const t = encryptedColumns(H.db).find(x => x.table === 'client_revisions');
  assert.deepEqual(t && t.cols, ['changes_enc'], 'found by the rotation script');
  const newKey = Buffer.from('44'.repeat(32), 'hex');
  const row = revs(id)[0];
  // The rotation loop (scripts/rotate-key.js), on this table only, and back.
  const rotate = (from, to) => { for (const r of H.db.all(`SELECT id, changes_enc FROM client_revisions`)) H.db.run(`UPDATE client_revisions SET changes_enc=? WHERE id=?`, crypto.encrypt(crypto.decrypt(r.changes_enc, from), to), r.id); };
  rotate(undefined, newKey);
  const rotated = H.db.one(`SELECT changes_enc FROM client_revisions WHERE id=?`, row.id).changes_enc;
  assert.notEqual(rotated, row.changes_enc);
  assert.deepEqual(JSON.parse(crypto.decrypt(rotated, newKey)).phone.after, '916-555-0133');
  rotate(newKey, undefined);
  assert.equal(changesOf(H.db.one(`SELECT changes_enc FROM client_revisions WHERE id=?`, row.id)).phone.after, '916-555-0133');
});

test('the migration: schema 50 creates the table on an existing database exactly as a fresh install has it', () => {
  const db = require('../server/db');
  assert.ok(db.LATEST_SCHEMA_VERSION >= 50);
  assert.ok(H.db.one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='client_revisions'`));
  assert.ok(H.db.one(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_client_revisions_client'`));
  // test/migrations.test.js upgrades a 1.6.1 database through every migration and compares it with a fresh one.
});

test('a device that syncs with an office keeps no history and says where it is', async () => {
  const config = require('../server/config');
  const id = await newClient();
  config.local = true;
  try {
    const r = await C.primary.put(`/api/clients/${id}`, { phone: '916-555-0122' });
    assert.equal(r.status, 200);
    assert.equal(revs(id).length, 0, 'no earlier values kept on the device');
    const h = await C.primary.get(`/api/clients/${id}/history`);
    assert.equal(h.status, 403); assert.equal(h.data.officeOnly, true); assert.match(h.data.error, /kept at the office/);
    assert.deepEqual((await C.primary.get(`/api/clients/${id}`)).data.client.history, { read: true, revert: true, office_only: true });
    // SUDS on this device has no office: it keeps its own.
    globalThis.SUDS_STATIC_HOST = true;
    await C.primary.put(`/api/clients/${id}`, { phone: '916-555-0123' });
    assert.equal(revs(id).length, 1);
  } finally { config.local = false; delete globalThis.SUDS_STATIC_HOST; }
});

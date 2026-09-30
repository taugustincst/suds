'use strict';
// Minimal personal information by default (released in 1.21.0): a programme setting,
// participant_code_default (off unless an administrator turns it on), starts new clients and outreach contacts with a
// syringe services participant code instead of a name. A client may be known by a code alone: stored encrypted,
// found and counted by its blind index (the same domain as an anonymous visit's code), and counted as a client.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { uuid } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
let admin; let nav; let navUser; let ro;
const ids = {};
before(async () => {
  await H.start();
  navUser = H.makeUser('pcnav', 'navigator', PW);
  H.makeUser('pcro', 'readonly', PW);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('pcnav', PW);
  ro = H.client(); await ro.login('pcro', PW);
});
after(async () => { await H.stop(); });
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 400)}`); return r.data; };

test('the setting is off by default, shown to every signed-in person, and only an administrator changes it', async () => {
  assert.equal(ok(await nav.get('/api/auth/me'), 200, 'me').programme.participant_code_default, false);
  assert.equal((await nav.put('/api/admin/settings', { participant_code_default: '1' })).status, 403);
  assert.equal((await admin.put('/api/admin/settings', { participant_code_default: 'yes' })).status, 400);
  ok(await admin.put('/api/admin/settings', { participant_code_default: '1' }), 200, 'on');
  assert.equal(ok(await nav.get('/api/auth/me'), 200, 'me').programme.participant_code_default, true);
  const s = ok(await admin.get('/api/admin/settings'), 200, 'settings');
  assert.equal(s.participant_code_default, '1');
});

test('a client may be created with a participant code and no name; never with neither', async () => {
  const bad = await nav.post('/api/clients', { status: 'active' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fields && bad.data.fields.first_name, JSON.stringify(bad.data));
  assert.equal((await nav.post('/api/clients', { participant_code: 'ab' })).status, 400, 'too short a code');
  const r = ok(await nav.post('/api/clients', { participant_code: 'ma-07 85' }), 201, 'coded client');
  ids.coded = r.id;
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, r.id);
  assert.notEqual(row.participant_code_enc, 'MA0785', 'stored encrypted');
  assert.equal(require('../server/crypto').decrypt(row.participant_code_enc), 'MA0785', 'as normalised');
  assert.equal(row.participant_code_idx, require('../server/participant-code').index('MA0785'));
  const c = ok(await nav.get(`/api/clients/${r.id}`), 200, 'open').client;
  assert.equal(c.participant_code, 'MA0785');
  assert.equal(c.display_name, 'Participant MA0785', 'shown by the code, never as a blank');
  // A name may be added later.
  ok(await nav.put(`/api/clients/${r.id}`, { first_name: 'Mae', last_name: 'Pcadded' }), 200, 'add a name');
  assert.equal(ok(await nav.get(`/api/clients/${r.id}`), 200, 'open').client.display_name, 'Pcadded, Mae');
  // A code may not be taken away from a client who has no name.
  const bare = ok(await nav.post('/api/clients', { participant_code: 'ZZ9901' }), 201, 'second').id;
  assert.equal((await nav.put(`/api/clients/${bare}`, { participant_code: null })).status, 400);
});

test('the client list finds a client by participant code, and the duplicate check matches on it', async () => {
  const list = ok(await nav.get('/api/clients?q=zz9901&status=all'), 200, 'search').clients;
  assert.equal(list.length, 1);
  assert.equal(list[0].display_name, 'Participant ZZ9901');
  const d = ok(await nav.post('/api/clients/check-duplicates', { participant_code: 'zz 99 01' }), 200, 'check');
  assert.equal(d.matches.length, 1);
  assert.deepEqual(d.matches[0].reasons, ['same participant code']);
  const dup = await nav.post('/api/clients', { participant_code: 'ZZ9901' });
  assert.equal(dup.status, 400, 'the same code again is a possible duplicate');
  // A role that knows clients by client code only cannot find one by participant code.
  assert.equal(ok(await ro.get('/api/clients?q=zz9901&status=all'), 200, 'readonly').clients.length, 0);
});

test('a coded client is a participant served; the same code at an anonymous contact is not counted again', async () => {
  const at = new Date(Date.now() - 3600000).toISOString();
  ok(await nav.post('/api/interventions', { client_id: ids.coded, type: 'naloxone_distribution', occurred_at: at, duration_minutes: 5, naloxone_kits: 1 }), 201, 'client visit');
  ok(await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at, naloxone_kits: 1, participant_code: 'MA0785' }), 201, 'same code, anonymous');
  ok(await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at, naloxone_kits: 1, participant_code: 'QQ1234' }), 201, 'another code');
  // The period's true figures (before small-cell suppression), as the report is built from them.
  const SSP = require('../server/ssp-report');
  const adminUser = H.db.one(`SELECT * FROM users WHERE username='admin'`);
  const t = SSP.figures({ user: adminUser }, { ts: (col) => `${col} >= ?`, tsP: [new Date(Date.now() - 7 * 86400000).toISOString()] }).totals;
  assert.equal(t.participants, 1, 'the coded client is a participant served');
  assert.equal(t.anonymous_participants, 1, 'QQ1234 only: MA0785 is the client already counted');
  assert.equal(t.coded_contacts, 2);
});

test('sync: a device\'s coded client lands with its code re-indexed by the office', async () => {
  require('../server/config').localModeEnabled = true;
  const dev = H.client(); dev.setHeader('X-Sync-Client', '1'); dev.setHeader('X-Device-Id', uuid());
  ok(await dev.post('/api/auth/login', { username: 'pcnav', password: PW }), 200, 'device');
  const now = new Date().toISOString(); const id = uuid();
  const res = ok(await dev.post('/api/sync/push', { device_now: now, tables: { clients: [{ id, client_code: 'M26-0077', participant_code_enc: 'kk 44 55', status: 'active', created_at: now, updated_at: now }],
    assignments: [{ id: uuid(), client_id: id, user_id: navUser.id, role_on_case: 'primary', start_date: now.slice(0, 10), created_at: now, updated_at: now }] } }), 200, 'push');
  assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected));
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, id);
  assert.equal(require('../server/crypto').decrypt(row.participant_code_enc), 'KK4455');
  assert.equal(row.participant_code_idx, require('../server/participant-code').index('KK4455'));
  assert.equal(require('../server/crypto').decrypt(row.first_name_enc), '');
  const none = ok(await dev.post('/api/sync/push', { device_now: now, tables: { clients: [{ id: uuid(), client_code: 'M26-0078', status: 'active', created_at: now, updated_at: now }] } }), 200, 'push');
  assert.equal(none.rejected.length, 1);
  assert.match(none.rejected[0].reason, /is missing a required field/);
});

test('merge: the kept record takes the name or the participant code it lacks from the same person\'s other record (review fix)', async () => {
  const { blindIndex } = require('../server/crypto');
  const PC = require('../server/participant-code');
  // A coded client kept, the named record merged in: the kept one gets the name and is found by it.
  const coded = ok(await admin.post('/api/clients', { participant_code: 'MRG-1234' }), 201, 'coded').id;
  const named = ok(await admin.post('/api/clients', { first_name: 'Rosalind', last_name: 'Mergetest', confirm_duplicate: true }), 201, 'named').id;
  ok(await admin.post(`/api/clients/${coded}/merge`, { source_id: named, reason: 'same person' }), 200, 'merge named into coded');
  const k = ok(await admin.get(`/api/clients/${coded}`), 200, 'kept').client;
  assert.equal(k.display_name, 'Mergetest, Rosalind');
  assert.equal(k.participant_code, 'MRG1234');
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, coded);
  assert.equal(row.last_name_idx, blindIndex('Mergetest'), 'found by surname');
  assert.equal(row.full_name_idx, blindIndex('MergetestRosalind'));
  assert.ok(ok(await admin.get('/api/clients?q=Mergetest&status=all'), 200, 'search').clients.some((c) => c.id === coded));
  // A named client kept, the coded record merged in: the kept one gets the code (and its index, for the SSP count).
  const named2 = ok(await admin.post('/api/clients', { first_name: 'Tobias', last_name: 'Mergekeep', confirm_duplicate: true }), 201, 'named2').id;
  const coded2 = ok(await admin.post('/api/clients', { participant_code: 'TMK-5566' }), 201, 'coded2').id;
  ok(await admin.post(`/api/clients/${named2}/merge`, { source_id: coded2, reason: 'same person' }), 200, 'merge coded into named');
  const k2 = ok(await admin.get(`/api/clients/${named2}`), 200, 'kept2').client;
  assert.equal(k2.display_name, 'Mergekeep, Tobias', 'the kept name stays');
  assert.equal(k2.participant_code, 'TMK5566');
  assert.equal(H.db.one(`SELECT participant_code_idx i FROM clients WHERE id=?`, named2).i, PC.index('TMK5566'));
  assert.ok(ok(await admin.get('/api/clients?q=TMK5566&status=all'), 200, 'search by code').clients.some((c) => c.id === named2));
});

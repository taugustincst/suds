'use strict';
// A record edited both on a device and at the office between two syncs is merged field by field (security review
// of 1.26.0, M2): what each side changed alone survives, and only a field both changed is decided by the newer edit
// -- reported to the device when the office's edit replaced its own. Before 1.26.1 the whole row went to whichever
// edit was newer, so a phone number corrected in the field was silently lost to an unrelated edit at the office.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base; let office;
const USER = 'mergesup'; const PASSWORD = 'Willow-Crane-48!q';
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  H.makeUser(USER, 'supervisor', PASSWORD);
  H.makeUser('mergeoffice', 'supervisor');
  office = H.client(); await office.login('mergeoffice', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); cleanup(); });
const device = (...a) => kernelCaller(L)(...a);
const ok = (r, s, what) => { assert.equal(r.status, s, `${what}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const tick = () => new Promise((r) => setTimeout(r, 15));
const sync = async () => ok(await device('POST', '/api/local/sync', { server: base, username: USER, password: PASSWORD }), 200, 'sync');
const onDevice = async (id) => ok(await device('GET', `/api/clients/${id}`), 200, 'client on the device').client;
const atOffice = async (id) => ok(await office.get(`/api/clients/${id}`), 200, 'client at the office').client;
const pick = (c) => ({ phone: c.phone, goals: c.goals, risk_level: c.risk_level, email: c.email });

test('a device edit and an office edit to different fields of one client both survive the next sync', async () => {
  const c = ok(await office.post('/api/clients', { first_name: 'Rowan', last_name: 'Ellery', phone: '916-555-0100', goals: 'Housing first', risk_level: 'moderate' }), 201, 'client');
  ok(await device('POST', '/api/local/setup', { display_name: 'Merge Sup', username: USER, password: PASSWORD, role: 'supervisor' }), 200, 'device set-up');
  ok(await device('POST', '/api/auth/login', { username: USER, password: PASSWORD }), 200, 'device sign-in');
  await sync();
  assert.equal((await onDevice(c.id)).phone, '916-555-0100', 'the client reached the device');

  // In the field: the phone number is corrected. Later, at the office: the goals are rewritten. The office edit is the newer.
  ok(await device('PUT', `/api/clients/${c.id}`, { phone: '916-555-0177' }), 200, 'device edit');
  await tick();
  ok(await office.put(`/api/clients/${c.id}`, { goals: 'Housing first; reconnect with family' }), 200, 'office edit');
  const s = await sync();
  assert.deepEqual((s.conflicts || []).filter(x => !x.reason), [], 'nothing was replaced, so nothing is reported');
  const want = { phone: '916-555-0177', goals: 'Housing first; reconnect with family' };
  for (const [where, row] of [['device', await onDevice(c.id)], ['office', await atOffice(c.id)]]) {
    assert.equal(row.phone, want.phone, `${where}: the device's phone number survived`);
    assert.equal(row.goals, want.goals, `${where}: the office's goals survived`);
  }
  // Settled: another sync changes nothing on either side.
  const again = await sync();
  assert.deepEqual((again.conflicts || []).filter(x => !x.reason), []);
  assert.deepEqual(pick(await onDevice(c.id)), pick(await atOffice(c.id)), 'device and office agree');
});

test('a field both sides changed goes to the newer edit, and the device is told when it lost one', async () => {
  const c = ok(await office.post('/api/clients', { first_name: 'Sable', last_name: 'Quint', phone: '916-555-0200', goals: 'Stable housing', risk_level: 'moderate' }), 201, 'client');
  await sync();
  // The device changes the risk level and the email; then the office changes the risk level too (newer).
  ok(await device('PUT', `/api/clients/${c.id}`, { risk_level: 'low', email: 'sable.q@example.org' }), 200, 'device edit');
  await tick();
  ok(await office.put(`/api/clients/${c.id}`, { risk_level: 'high' }), 200, 'office edit');
  const s = await sync();
  const lost = (s.conflicts || []).filter(x => !x.reason && x.id === c.id);
  assert.equal(lost.length, 1, `the replaced edit is reported: ${JSON.stringify(s.conflicts)}`);
  assert.deepEqual(lost[0].columns, ['risk_level'], 'only the field both changed, by name');
  for (const row of [await onDevice(c.id), await atOffice(c.id)]) {
    assert.equal(row.risk_level, 'high', 'the newer edit (the office\'s) decides the field both changed');
    assert.equal(row.email, 'sable.q@example.org', 'the device\'s other field still went up');
  }

  // Now the other way round: the office edits the goals first, the device edits them after (newer), with no sync between.
  ok(await office.put(`/api/clients/${c.id}`, { goals: 'Office goals' }), 200, 'office edit');
  await tick();
  ok(await device('PUT', `/api/clients/${c.id}`, { goals: 'Field goals' }), 200, 'device edit');
  const s2 = await sync();
  assert.deepEqual((s2.conflicts || []).filter(x => !x.reason), [], 'the device lost nothing');
  for (const row of [await onDevice(c.id), await atOffice(c.id)]) assert.equal(row.goals, 'Field goals', 'the newer edit (the device\'s) decides');
  const over = H.db.all(`SELECT details FROM audit_log WHERE action='sync.overwrite' AND entity_id=?`, c.id).map(r => JSON.parse(r.details));
  assert.ok(over.some(d => d.columns.includes('goals_enc')), 'the office records, by name, the field the device replaced');
});


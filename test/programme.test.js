'use strict';
// The programme profile (server/programme.js): harm reduction & outreach, or treatment-adjacent, with each
// clinical module switchable on its own in Settings › Programme. Presentation first — permissions do not
// change — but a module switched off refuses new records in it (403, saying where to switch it on), the FHIR
// API closes, and records already made stay readable.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const P = require('../server/programme');

let admin, sup, nav, navUser, clientId;
before(async () => {
  await H.start();
  navUser = H.makeUser('pgnav', 'navigator'); H.makeUser('pgsup', 'supervisor');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('pgsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('pgnav', 'StaffPassw0rd!x');
  clientId = (await nav.post('/api/clients', { first_name: 'Profile', last_name: 'Test', confirm_duplicate: true })).data.id;
});
after(H.stop);

const setProfile = (body) => admin.put('/api/admin/settings', body);

test('the suite runs treatment-adjacent; /api/auth/me says so with every module on', async () => {
  const me = (await nav.get('/api/auth/me')).data;
  assert.equal(me.programme.profile, 'treatment');
  assert.deepEqual(me.programme.modules, { careplan: true, assessments: true, caloms: true, fhir: true, handoff: true });
});

test('a record made while a module is on stays readable after it is switched off', async () => {
  const r = await nav.post(`/api/clients/${clientId}/problems`, { problem: 'Housing instability' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await setProfile({ programme_profile: 'harm_reduction' })).status, 200);
  const list = await nav.get(`/api/clients/${clientId}/problems`);
  assert.equal(list.status, 200);
  assert.equal(list.data.rows.length, 1, 'the problem recorded earlier is still there to read');
});

test('harm reduction: every clinical module is off, and /api/auth/me says so', async () => {
  const me = (await nav.get('/api/auth/me')).data;
  assert.equal(me.programme.profile, 'harm_reduction');
  assert.ok(Object.values(me.programme.modules).every(v => v === false), JSON.stringify(me.programme.modules));
  const s = (await admin.get('/api/admin/settings')).data;
  assert.equal(s.programme.profile, 'harm_reduction');
  assert.deepEqual(s.programme.module_list.map(m => m.key), ['careplan', 'assessments', 'caloms', 'fhir', 'handoff']);
});

test('a switched-off module refuses new records with a message that says where to switch it on', async () => {
  const cases = [
    ['careplan', () => nav.post(`/api/clients/${clientId}/problems`, { problem: 'x' })],
    ['careplan', () => nav.post(`/api/clients/${clientId}/goals`, { goal: 'x' })],
    ['assessments', () => sup.post(`/api/clients/${clientId}/asam`, {})],
    ['assessments', () => sup.post(`/api/clients/${clientId}/outcomes`, {})],
    ['caloms', () => nav.post('/api/episodes/nope/caloms', {})],
    ['caloms', () => sup.post('/api/caloms/submissions', {})],
    ['handoff', () => sup.get('/api/handoff/export?from=2026-01-01&to=2026-01-31&recipient=x&purpose=y&basis=consent')],
    ['fhir', () => admin.post('/api/admin/fhir-clients', { name: 'EHR', recipient: 'County EHR', scopes: ['system/*.read'] })],
  ];
  for (const [mod, call] of cases) {
    const r = await call();
    assert.equal(r.status, 403, `${mod}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, /switched off for this programme.*Settings › Programme/, mod);
  }
  // Permissions are checked first: a role that could never write care plans is told that, not about modules.
  const fin = H.makeUser('pgfin', 'finance'); const f = H.client(); await f.login(fin.username, fin.password);
  const denied = await f.post(`/api/clients/${clientId}/problems`, { problem: 'x' });
  assert.equal(denied.status, 403); assert.doesNotMatch(denied.data.error, /switched off/);
  // Reads of the module stay open.
  assert.equal((await sup.get(`/api/clients/${clientId}/asam`)).status, 200);
  assert.equal((await sup.get('/api/caloms/validation')).status, 200);
  assert.equal((await admin.get('/api/admin/fhir-clients')).status, 200);
});

test('the FHIR API closes with its module: no tokens, no data; the capability statement stays', async () => {
  const base = await H.start();
  const token = await fetch(base + '/fhir/R4/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=x&client_secret=y' });
  assert.equal(token.status, 403);
  assert.match((await token.json()).issue[0].diagnostics, /switched off/);
  assert.equal((await fetch(base + '/fhir/R4/Patient')).status, 403);
  assert.equal((await fetch(base + '/fhir/R4/metadata')).status, 200);
});

test('CalOMS reporting switched on but its module off asks no CalOMS questions', async () => {
  H.db.setSetting('caloms_enabled', '1');
  try {
    assert.equal((await nav.get('/api/caloms/config')).data.enabled, false);
    assert.equal((await setProfile({ module_caloms: '1' })).status, 200);
    assert.equal((await nav.get('/api/caloms/config')).data.enabled, true);
  } finally { H.db.setSetting('caloms_enabled', '0'); await setProfile({ module_caloms: null }); }
});

test('one module switched on by itself; blank returns it to the profile', async () => {
  assert.equal((await setProfile({ module_careplan: '1' })).status, 200);
  let me = (await nav.get('/api/auth/me')).data.programme;
  assert.equal(me.profile, 'harm_reduction');
  assert.equal(me.modules.careplan, true); assert.equal(me.modules.assessments, false);
  assert.equal((await nav.post(`/api/clients/${clientId}/problems`, { problem: 'Needs ID' })).status, 201);
  assert.equal((await sup.post(`/api/clients/${clientId}/asam`, {})).status, 403, 'assessments are still off');
  await setProfile({ module_careplan: null });
  me = (await nav.get('/api/auth/me')).data.programme;
  assert.equal(me.modules.careplan, false);
  assert.equal(H.db.getSetting('module_careplan', null), null, 'blank removes the switch rather than storing ""');
  // Treatment-adjacent with one module switched off.
  await setProfile({ programme_profile: 'treatment', module_fhir: '0' });
  me = (await nav.get('/api/auth/me')).data.programme;
  assert.equal(me.modules.careplan, true); assert.equal(me.modules.fhir, false);
  await setProfile({ programme_profile: 'harm_reduction', module_fhir: null });
});

test('bad values are refused, and only an administrator may change the profile', async () => {
  let r = await setProfile({ programme_profile: 'hospital' });
  assert.equal(r.status, 400); assert.ok(r.data.fields && r.data.fields.programme_profile);
  r = await setProfile({ programme_profile: null });
  assert.equal(r.status, 400, 'the profile cannot be blanked (it would be decided again at the next start)');
  r = await setProfile({ module_fhir: 'yes' });
  assert.equal(r.status, 400);
  assert.equal((await sup.put('/api/admin/settings', { programme_profile: 'treatment' })).status, 403);
  assert.equal(P.profile(), 'harm_reduction', 'nothing changed');
});

test('a change of profile or module is audited on its own', async () => {
  await setProfile({ programme_profile: 'treatment' });
  const row = H.db.one(`SELECT details FROM audit_log WHERE action='settings.programme' ORDER BY id DESC LIMIT 1`);
  assert.ok(row, 'settings.programme is logged');
  const d = JSON.parse(row.details);
  assert.equal(d.profile, 'treatment'); assert.equal(d.modules.handoff, true);
});

test('device copies follow the office: the profile and module switches synchronise', () => {
  const SYNC = require('../server/sync-tables');
  for (const k of ['programme_profile', 'module_careplan', 'module_assessments', 'module_caloms', 'module_fhir', 'module_handoff']) assert.ok(SYNC.settings_keys.includes(k), k);
});

'use strict';
// SCIM 2.0 provisioning (server/scim.js, server/routes/scim.js): what Entra ID and Okta actually send —
// find by userName, create, PATCH with Entra's "Replace"/string booleans and Okta's value objects, PUT,
// DELETE — authenticated by a token scoped "scim", every change audited, and no way to touch a break-glass
// account, grant a role the county did not map, or sign in with a password.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, stop, client, makeUser, db } = require('./helpers');

let base, admin, nav, token, tokenId;
const scim = async (method, p, body, tok = token) => {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/scim+json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') || '', data: text ? JSON.parse(text) : null };
};
before(async () => {
  base = await start();
  admin = client(); await admin.login('admin', 'AdminPassw0rd!x');
  const u = makeUser('scimnav', 'navigator');
  nav = client(); await nav.login('scimnav', u.password);
});
after(stop);

test('SCIM tokens: created and revoked by an administrator only; the token is shown once and kept out of the intake key list', async () => {
  assert.equal((await nav.post('/api/admin/scim/tokens', { name: 'Entra' })).status, 403);
  const r = await admin.post('/api/admin/scim/tokens', { name: 'Entra ID provisioning' });
  assert.equal(r.status, 201);
  assert.match(r.data.token, /^suds_scim_/);
  token = r.data.token; tokenId = r.data.id;
  const listed = (await admin.get('/api/admin/scim/tokens')).data.tokens;
  assert.equal(listed.length, 1); assert.ok(!('key_hash' in listed[0]));
  assert.ok(!(await admin.get('/api/admin/api-keys')).data.keys.some((k) => k.id === tokenId), 'not an intake key');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='scim.token.create'`));
});

test('no token, a wrong token or an intake key is refused with a SCIM error', async () => {
  assert.equal((await scim('GET', '/scim/v2/Users', undefined, 'nope')).status, 401);
  const intake = (await admin.post('/api/admin/api-keys', { name: 'intake' })).data.key;
  const r = await scim('GET', '/scim/v2/Users', undefined, intake);
  assert.equal(r.status, 401);
  assert.match(r.type, /scim\+json/);
  assert.deepEqual(r.data.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='scim.denied'`));
  assert.equal((await scim('GET', '/scim/v2/Nothing')).status, 404);
});

test('ServiceProviderConfig says what is supported', async () => {
  const r = await scim('GET', '/scim/v2/ServiceProviderConfig');
  assert.equal(r.status, 200);
  assert.equal(r.data.patch.supported, true); assert.equal(r.data.bulk.supported, false);
});

let created;
test('Entra/Okta flow: filter by userName finds nobody, POST creates the account with the mapped role and no password', async () => {
  assert.equal((await admin.put('/api/admin/settings', { scim_group_roles: 'SUD Navigators=navigator; SUD Supervisors=supervisor; bogus=superuser' })).status, 400, 'an unknown role is refused');
  assert.equal((await admin.put('/api/admin/settings', { scim_group_roles: 'SUD Navigators=navigator\nSUD Supervisors=supervisor' })).status, 200);
  assert.equal(db.getSetting('scim_group_roles'), 'SUD Navigators=navigator; SUD Supervisors=supervisor');
  const none = await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "ana.ortiz@county.gov"'));
  assert.equal(none.status, 200); assert.equal(none.data.totalResults, 0); assert.deepEqual(none.data.Resources, []);
  const r = await scim('POST', '/scim/v2/Users', {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], externalId: 'entra-oid-123', userName: 'ana.ortiz@county.gov', active: true,
    displayName: 'Ana Ortiz', name: { givenName: 'Ana', familyName: 'Ortiz' }, emails: [{ primary: true, type: 'work', value: 'ana.ortiz@county.gov' }],
    roles: [{ value: 'SUD Supervisors' }, { value: 'SUD Navigators' }], title: 'Navigator lead',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  created = r.data;
  assert.equal(created.userName, 'ana.ortiz@county.gov'); assert.equal(created.active, true); assert.equal(created.externalId, 'entra-oid-123');
  assert.equal(created.roles[0].value, 'supervisor', 'the most privileged mapped group wins');
  assert.match(created.meta.location, /\/scim\/v2\/Users\//);
  const row = db.one(`SELECT * FROM users WHERE id=?`, created.id);
  assert.equal(row.scim_external_id, 'entra-oid-123'); assert.ok(row.idp_seen_at);
  const pw = await client().post('/api/auth/login', { username: 'ana.ortiz@county.gov', password: '!scim-provisioned-no-password' });
  assert.equal(pw.status, 401, 'a provisioned account has no password to sign in with');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='scim.user.create' AND entity_id=?`, created.id));
  // Found by userName (case-insensitively) and by externalId afterwards.
  const found = await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "ANA.ORTIZ@county.gov"'));
  assert.equal(found.data.totalResults, 1); assert.equal(found.data.Resources[0].id, created.id);
  assert.equal((await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('externalId eq "entra-oid-123"'))).data.totalResults, 1);
  assert.equal((await scim('GET', `/scim/v2/Users/${created.id}`)).data.displayName, 'Ana Ortiz');
  // A second create is a uniqueness conflict; an unmapped person gets the default (least) role.
  const dup = await scim('POST', '/scim/v2/Users', { userName: 'ana.ortiz@county.gov' });
  assert.equal(dup.status, 409); assert.equal(dup.data.scimType, 'uniqueness');
  const plain = await scim('POST', '/scim/v2/Users', { userName: 'no.groups@county.gov', displayName: 'No Groups' });
  assert.equal(plain.data.roles[0].value, 'readonly');
  assert.equal((await scim('POST', '/scim/v2/Users', { userName: 'bad name with spaces' })).status, 400);
  assert.equal((await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('displayName co "Ana"'))).data.scimType, 'invalidFilter');
});

test('PATCH as Entra sends it ("Replace", "False") deactivates: sessions and devices are revoked; "True" reactivates', async () => {
  db.run(`UPDATE users SET password_hash=? WHERE id=?`, require('../server/crypto').hashPassword('Temp0rary!pass'), created.id);
  db.run(`UPDATE users SET must_change_password=0, password_changed_at=? WHERE id=?`, db.now(), created.id);
  const c = client(); await c.login('ana.ortiz@county.gov', 'Temp0rary!pass');
  db.run(`INSERT INTO devices(id,user_id,label) VALUES('dev-ana',?,'phone')`, created.id);
  const r = await scim('PATCH', `/scim/v2/Users/${created.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.active, false);
  assert.equal((await c.get('/api/auth/me')).status, 401, 'the session is gone at once');
  const dev = db.one(`SELECT * FROM devices WHERE id='dev-ana'`);
  assert.ok(dev.revoked_at && dev.wipe_requested_at, 'the device is revoked and told to wipe');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='scim.user.deactivate' AND entity_id=?`, created.id));
  const back = await scim('PATCH', `/scim/v2/Users/${created.id}`, { Operations: [{ op: 'replace', path: 'active', value: 'True' }] });
  assert.equal(back.data.active, true);
});

test('PATCH as Okta sends it (a value object), and path forms for name, email and roles', async () => {
  const r = await scim('PATCH', `/scim/v2/Users/${created.id}`, { Operations: [{ op: 'replace', value: { displayName: 'Ana M. Ortiz', active: true } }, { op: 'replace', path: 'emails[type eq "work"].value', value: 'aortiz@county.gov' }, { op: 'add', path: 'roles', value: [{ value: 'SUD Navigators' }] }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.displayName, 'Ana M. Ortiz'); assert.equal(r.data.emails[0].value, 'aortiz@county.gov'); assert.equal(r.data.roles[0].value, 'navigator');
  const log = db.one(`SELECT details FROM audit_log WHERE action='scim.user.update' AND entity_id=? ORDER BY id DESC LIMIT 1`, created.id);
  assert.match(log.details, /"to":"navigator"/);
  assert.equal((await scim('PATCH', `/scim/v2/Users/${created.id}`, { Operations: [{ op: 'move', path: 'x' }] })).status, 400);
  assert.equal((await scim('PATCH', `/scim/v2/Users/${created.id}`, { nope: 1 })).status, 400);
});

test('PUT replaces what it names; DELETE deactivates (never deletes); an unknown id is 404', async () => {
  const r = await scim('PUT', `/scim/v2/Users/${created.id}`, { userName: 'ana.ortiz@county.gov', displayName: 'Ana Ortiz', emails: [{ value: 'ana.ortiz@county.gov', primary: true }], active: true, externalId: 'entra-oid-123' });
  assert.equal(r.status, 200); assert.equal(r.data.displayName, 'Ana Ortiz');
  const d = await scim('DELETE', `/scim/v2/Users/${created.id}`);
  assert.equal(d.status, 204);
  assert.equal(db.one(`SELECT is_active FROM users WHERE id=?`, created.id).is_active, 0);
  assert.ok(db.one(`SELECT 1 FROM users WHERE id=?`, created.id), 'the row stays: the audit trail refers to it');
  assert.equal((await scim('GET', '/scim/v2/Users/not-a-user')).status, 404);
});

test('an emergency (break-glass) account cannot be changed or deactivated by provisioning', async () => {
  db.setSetting('sso_emergency_accounts', 'admin');
  try {
    const adminId = db.one(`SELECT id FROM users WHERE username='admin'`).id;
    const r = await scim('PATCH', `/scim/v2/Users/${adminId}`, { Operations: [{ op: 'replace', path: 'active', value: false }] });
    assert.equal(r.status, 403); assert.equal(r.data.scimType, 'mutability');
    assert.equal((await scim('DELETE', `/scim/v2/Users/${adminId}`)).status, 403);
    assert.equal(db.one(`SELECT is_active FROM users WHERE id=?`, adminId).is_active, 1);
  } finally { db.run(`DELETE FROM settings WHERE key='sso_emergency_accounts'`); }
});

test('pagination: startIndex and count', async () => {
  const all = await scim('GET', '/scim/v2/Users?startIndex=1&count=2');
  assert.equal(all.data.itemsPerPage, 2); assert.ok(all.data.totalResults >= 4);
  const next = await scim('GET', '/scim/v2/Users?startIndex=3&count=2');
  assert.notEqual(next.data.Resources[0].id, all.data.Resources[0].id);
});

test('a revoked token stops working', async () => {
  assert.equal((await admin.del(`/api/admin/scim/tokens/${tokenId}`)).status, 200);
  assert.equal((await scim('GET', '/scim/v2/Users')).status, 401);
  const { ROUTE_MODULES, LOCAL_ROUTE_MODULES } = require('../server/app');
  assert.ok(ROUTE_MODULES.includes('scim') && !LOCAL_ROUTE_MODULES.includes('scim'), 'never on a device');
});

test('identity settings are validated; trusting the provider MFA is audited on its own; the deprovisioning report is users:manage', async () => {
  assert.equal((await admin.put('/api/admin/settings', { sso_trust_idp_mfa: 'yes' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { sso_mfa_acr_values: 'bad value;drop' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { sso_deprovision_days: -1 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { scim_default_role: 'owner' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { sso_trust_idp_mfa: '1', sso_mfa_acr_values: 'urn:a, urn:b' })).status, 200);
  assert.equal(db.getSetting('sso_mfa_acr_values'), 'urn:a,urn:b');
  const log = db.one(`SELECT details FROM audit_log WHERE action='security.idp_mfa_trust' ORDER BY id DESC LIMIT 1`);
  assert.match(log.details, /"trusted":true/);
  assert.equal((await admin.put('/api/admin/settings', { sso_trust_idp_mfa: '0' })).status, 200);
  assert.equal((await nav.get('/api/admin/security/deprovisioning')).status, 403);
  const rep = await admin.get('/api/admin/security/deprovisioning');
  assert.equal(rep.status, 200); assert.equal(rep.data.days, 0);
  assert.equal((await admin.post('/api/admin/security/deprovisioning/run', {})).status, 400, 'nothing to run until a number of days is set');
  assert.equal((await admin.put('/api/admin/settings', { sso_deprovision_days: 60 })).status, 200);
  const run = await admin.post('/api/admin/security/deprovisioning/run', {});
  assert.equal(run.status, 200); assert.equal(run.data.days, 60);
  assert.equal((await nav.post('/api/admin/security/deprovisioning/run', {})).status, 403);
  await admin.put('/api/admin/settings', { sso_deprovision_days: 0 });
});

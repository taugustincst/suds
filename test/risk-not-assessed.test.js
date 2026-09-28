'use strict';
// QA 1.15.3, defect 3: a client created without a risk level was stored (and shown) as Moderate, the schema
// column's DEFAULT. Risk is a judgement somebody makes: not given means not assessed (NULL). The schema is not
// changed (fix release); the create paths write NULL explicitly, existing rows are left as they are, and the
// client list can find the ones nobody has assessed yet (risk=not_assessed).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let nav;
before(async () => {
  await H.start();
  H.makeUser('risk_nav', 'navigator');
  nav = H.client(); await nav.login('risk_nav', 'StaffPassw0rd!x');
});
after(() => H.stop());

const stored = (id) => H.db.one(`SELECT risk_level FROM clients WHERE id=?`, id).risk_level;

test('a client created without a risk level is not assessed, not Moderate', async () => {
  const r = await nav.post('/api/clients', { first_name: 'Nora', last_name: 'Unassessed', status: 'active' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(stored(r.data.id), null);
  assert.equal((await nav.get(`/api/clients/${r.data.id}`)).data.client.risk_level ?? null, null);
  // A blank choice from the form is the same.
  const b = await nav.post('/api/clients', { first_name: 'Blank', last_name: 'Riskfield', status: 'active', risk_level: '' });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.equal(stored(b.data.id), null);
});

test('a chosen risk level is kept, and can be cleared again', async () => {
  const r = await nav.post('/api/clients', { first_name: 'Hana', last_name: 'Assessed', status: 'active', risk_level: 'high' });
  assert.equal(stored(r.data.id), 'high');
  assert.equal((await nav.put(`/api/clients/${r.data.id}`, { risk_level: 'moderate' })).status, 200);
  assert.equal(stored(r.data.id), 'moderate');
  assert.equal((await nav.put(`/api/clients/${r.data.id}`, { risk_level: '' })).status, 200);
  assert.equal(stored(r.data.id), null);
});

test('an imported client with no risk column is not assessed', async () => {
  const commit = await nav.post('/api/imports/data/commit', { entity: 'clients', records: [{ first_name: 'Ivy', last_name: 'Importednorisk', status: 'active' }] });
  assert.equal(commit.status, 200, JSON.stringify(commit.data)); assert.equal(commit.data.created, 1);
  const row = H.db.one(`SELECT id FROM clients WHERE created_by=(SELECT id FROM users WHERE username='risk_nav') ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  assert.equal(stored(row.id), null);
});

test('the client list finds the clients not yet assessed, and the high-risk filter leaves them out', async () => {
  const none = await nav.get('/api/clients?risk=not_assessed&limit=200');
  assert.equal(none.status, 200);
  const names = none.data.clients.map(c => c.last_name);
  assert.ok(names.includes('Unassessed') && names.includes('Riskfield'), JSON.stringify(names));
  assert.ok(none.data.clients.every(c => !c.risk_level));
  const high = await nav.get('/api/clients?risk=high&limit=200');
  assert.ok(high.data.clients.every(c => ['high', 'critical'].includes(c.risk_level)));
});

'use strict';
// Security review of 1.13.0, design weakness 7: finance (time:all, no clients:read) read the free-text
// description of every worker's time entry — text the code itself says "can name the client" ("Drove Zebulon
// to detox intake"). A role without clients:read now sees another worker's time as category, fund and hours
// only, in REST (list, one entry) and in exports; its own entries keep their description. A role without
// clients:read cannot sync at all (GET /api/sync/pull is refused), so no device of theirs holds the text.
// An edit by such a role cannot blank the description it was never shown.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { decrypt } = require('../server/crypto');

let nav, sup, fin, finId, navEntry, finEntry;
const today = new Date().toISOString().slice(0, 10);
const SECRET = 'Drove Zebulon Quartermaine to detox intake';
before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  H.makeUser('td_nav', 'navigator'); H.makeUser('td_sup', 'supervisor'); finId = H.makeUser('td_fin', 'finance').id;
  nav = H.client(); await nav.login('td_nav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('td_sup', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('td_fin', 'StaffPassw0rd!x');
  const r = await nav.post('/api/time', { work_date: today, minutes: 45, category: 'travel', description: SECRET });
  assert.equal(r.status, 201, JSON.stringify(r.data)); navEntry = r.data.id;
  // Finance holds time:all but not time:write; an entry of its own is written directly, as an import would.
  finEntry = require('../server/crypto').uuid();
  H.db.run(`INSERT INTO time_entries(id,user_id,work_date,minutes,category,description_enc) VALUES(?,?,?,?,?,?)`, finEntry, finId, today, 30, 'admin', require('../server/crypto').encrypt('Month-end grant reconciliation'));
});
after(() => H.stop());

test('finance sees another worker\'s time as category, fund and hours, without the description', async () => {
  const list = await fin.get('/api/time?limit=1000');
  assert.equal(list.status, 200);
  const row = list.data.rows.find(x => x.id === navEntry);
  assert.ok(row, 'the entry is listed (time:all)');
  assert.equal(row.minutes, 45); assert.equal(row.category, 'travel');
  assert.equal(row.description, null);
  assert.equal(row.description_withheld, true);
  assert.ok(!JSON.stringify(list.data).includes('Zebulon'));
  const one = await fin.get(`/api/time/${navEntry}`);
  assert.equal(one.status, 200);
  assert.equal(one.data.row.description, null);
  assert.ok(!JSON.stringify(one.data).includes('Zebulon'));
});

test('their own entries keep their description', async () => {
  const one = await fin.get(`/api/time/${finEntry}`);
  assert.equal(one.data.row.description, 'Month-end grant reconciliation');
  assert.ok(!one.data.row.description_withheld);
});

test('the worker and a supervisor (clients:read) still read it', async () => {
  assert.equal((await nav.get(`/api/time/${navEntry}`)).data.row.description, SECRET);
  assert.equal((await sup.get(`/api/time/${navEntry}`)).data.row.description, SECRET);
});

test('finance\'s time export carries no description of anyone else\'s time', async () => {
  for (const kind of ['time', 'workbook']) {
    const r = await fin.raw(`/api/reports/export/${kind}?from=2020-01-01&to=2032-12-31${kind === 'time' ? '' : ''}`);
    assert.equal(r.status, 200);
    const body = kind === 'workbook' ? JSON.stringify(require('../server/spreadsheet').readWorkbook(Buffer.from(await r.arrayBuffer()))) : await r.text();
    assert.ok(!body.includes('Zebulon'), `${kind} export`);
  }
});

test('finance cannot edit the entry, so it cannot blank the description it was never shown', async () => {
  const before = (await fin.get(`/api/time/${navEntry}`)).data.row;
  const r = await fin.put(`/api/time/${navEntry}`, { minutes: 50, description: '', if_updated_at: before.updated_at });
  assert.equal(r.status, 403, 'finance holds no time:write');
  // Approving (time:approve) does not touch the description either.
  assert.equal((await nav.post(`/api/time/${navEntry}/submit`, {})).status, 200);
  assert.equal((await fin.post(`/api/time/${navEntry}/approve`, { decision: 'approved' })).status, 200);
  assert.equal(decrypt(H.db.one(`SELECT description_enc FROM time_entries WHERE id=?`, navEntry).description_enc), SECRET, 'the worker\'s description is untouched');
});

test('a role without clients:read cannot pull a device copy at all, so sync carries no description to it', async () => {
  assert.equal((await fin.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).status, 403);
  assert.equal(finId.length > 0, true);
});

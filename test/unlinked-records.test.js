'use strict';
// Security review of 1.12.4, findings 4 and 6.
// 4: a record with no client is outside caseload scoping, and the generic list allowed `client_id IS NULL OR
//    <caseload>` — so every navigator read every other worker's unlinked crisis call (caller's name, phone,
//    what they said), anonymous outreach summaries, community overdose notes and to-dos, over REST and by sync.
//    An unlinked record is now its owner's (or a clients:all holder's); time keeps time:all.
// 6: sync sent expenditures to devices without budget:read, fund and line amounts to every device, and other
//    workers' unlinked time entries, which REST hides.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let nav1, nav2, clin, sup;
const c = {};
before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  nav1 = H.makeCaseloadUser('unav1', 'navigator'); nav2 = H.makeCaseloadUser('unav2', 'navigator');
  clin = H.makeCaseloadUser('uclin', 'clinician'); sup = H.makeUser('usup', 'supervisor');
  require('../server/demo').seed({ actor: sup.id, workers: [nav1.id, nav2.id], clinician: clin.id, supervisor: sup.id });
  for (const u of [nav1, nav2, clin, sup]) { c[u.username] = H.client(); await c[u.username].login(u.username, u.password); }
});
after(() => H.stop());

async function pullAll(cl) {
  const tables = {}; let cursor = '';
  for (let i = 0; i < 50; i++) {
    const r = await cl.get('/api/sync/pull' + (cursor ? '?since=' + encodeURIComponent(cursor) : ''));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    for (const [k, v] of Object.entries(r.data.tables)) (tables[k] = tables[k] || []).push(...v);
    cursor = r.data.cursor; if (r.data.complete) break;
  }
  return tables;
}

const CASES = [
  { name: 'call', path: '/api/calls', table: 'calls', owner: 'user_id', body: { direction: 'inbound', method: 'phone', started_at: new Date().toISOString(), contact_name: 'Walk-in Caller Zed', phone: '916-555-7777', summary: 'Using fentanyl daily, wants detox', crisis: true }, needle: 'Walk-in Caller Zed' },
  { name: 'intervention', path: '/api/interventions', table: 'interventions', owner: 'user_id', body: { type: 'outreach', occurred_at: new Date().toISOString(), summary: 'Met Yolanda Q at the river camp, pregnant' }, needle: 'Yolanda Q' },
  { name: 'overdose event', path: '/api/overdose-events', table: 'overdose_events', owner: 'reported_by', body: { occurred_at: new Date().toISOString(), kind: 'reversal', notes: 'Bystander Xavier W revived behind the library' }, needle: 'Xavier W' },
  { name: 'task', path: '/api/tasks', table: 'tasks', owner: 'assigned_to', body: { title: 'Call Wendell P back about detox' }, needle: 'Wendell P' },
];

for (const k of CASES) {
  test(`another navigator cannot read an unlinked ${k.name}: not listed, not by id, not by sync; the owner and a supervisor can`, async () => {
    const created = await c.unav1.post(k.path, k.body);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    const list = await c.unav2.get(`${k.path}?limit=1000`);
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.data).includes(k.needle), `another navigator's ${k.name} list does not include it`);
    assert.equal((await c.unav2.get(`${k.path}/${id}`)).status, 403);
    assert.equal((await c.unav2.put(`${k.path}/${id}`, { summary: 'x' })).status, 403);
    assert.ok(!JSON.stringify(await pullAll(c.unav2)).includes(k.needle), 'nor is it synchronised to their device');
    assert.ok(!JSON.stringify(await pullAll(c.uclin)).includes(k.needle), 'nor to a clinician\'s');
    assert.ok(JSON.stringify((await c.unav1.get(`${k.path}?limit=1000`)).data).includes(k.needle), 'the owner still sees it');
    assert.equal((await c.unav1.get(`${k.path}/${id}`)).status, 200);
    assert.ok(JSON.stringify(await pullAll(c.unav1)).includes(k.needle), 'and gets it on their device');
    assert.equal((await c.usup.get(`${k.path}/${id}`)).status, 200, 'a supervisor (clients:all) sees it');
    assert.ok(JSON.stringify((await c.usup.get(`${k.path}?limit=1000`)).data).includes(k.needle));
  });
}

test('an expenditure with no client is its worker\'s, or budget:approve\'s (supervisor, finance), over REST and sync', async () => {
  const fund = H.db.one(`SELECT id FROM funding_sources WHERE is_active=1 LIMIT 1`).id;
  const created = await c.unav1.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: new Date().toISOString().slice(0, 10), amount: 12, category: 'transportation', description: 'Bus pass for Ulysses K' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.ok(!JSON.stringify((await c.unav2.get('/api/budget/expenditures?limit=1000')).data).includes('Ulysses K'));
  assert.equal((await c.unav2.get(`/api/budget/expenditures/${created.data.id}`)).status, 403);
  assert.ok(!JSON.stringify(await pullAll(c.unav2)).includes('Ulysses K'));
  assert.ok(JSON.stringify(await pullAll(c.unav1)).includes('Ulysses K'));
  assert.equal((await c.usup.get(`/api/budget/expenditures/${created.data.id}`)).status, 200);
});

test('a device cannot overwrite another worker\'s unlinked call by pushing its id', async () => {
  const created = await c.unav1.post('/api/calls', { direction: 'inbound', method: 'phone', started_at: new Date().toISOString(), summary: 'original words' });
  const id = created.data.id;
  const now = new Date(Date.now() + 5000).toISOString();
  const r = await c.unav2.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { calls: [{ id, client_id: null, user_id: nav2.id, direction: 'inbound', method: 'phone', started_at: now, summary_enc: 'overwritten', created_at: now, updated_at: now }] } });
  assert.equal(r.status, 200);
  assert.ok(JSON.stringify(r.data).includes('not permitted'), JSON.stringify(r.data));
  const row = H.db.one(`SELECT user_id, summary_enc FROM calls WHERE id=?`, id);
  assert.equal(row.user_id, nav1.id);
  assert.equal(require('../server/crypto').decrypt(row.summary_enc), 'original words');
});

test('sync sends time entries with no client only to their worker (or time:all), as REST does', async () => {
  const t = await c.unav1.post('/api/time', { work_date: new Date().toISOString().slice(0, 10), minutes: 30, category: 'admin', description: 'Drove Vernon T to the clinic' });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  assert.ok(!JSON.stringify(await pullAll(c.unav2)).includes('Vernon T'));
  assert.ok(!JSON.stringify(await pullAll(c.uclin)).includes('Vernon T'));
  assert.ok(JSON.stringify(await pullAll(c.unav1)).includes('Vernon T'));
});

test('a device without budget:read gets no expenditures and no fund or line amounts', async () => {
  // A clinician holds budget:read from 1.16.0 (was: no budget permission); one the programme denies it to is
  // the device without it.
  H.deny(clin, 'budget:read');
  const clinPull = await pullAll(c.uclin);
  assert.equal((clinPull.expenditures || []).length, 0, 'expenditures need budget:read');
  assert.ok((clinPull.funding_sources || []).length > 0, 'funds still travel: visits and time entries point at them');
  assert.ok(clinPull.funding_sources.every(f => !f.total_amount && !f.grant_number && !f.notes && !f.restrictions), 'but not their money or grant details');
  assert.ok((clinPull.budget_lines || []).every(l => !l.allocated_amount && !l.notes));
  const navPull = await pullAll(c.unav1);
  assert.ok((navPull.expenditures || []).length > 0, 'a navigator (budget:read) still gets them');
  assert.ok(navPull.funding_sources.some(f => f.total_amount > 0));
});

'use strict';
const LD = require('../server/local-date'); // the programme's calendar, as the server dates things
// QA 1.15.3, defect 1: an approved time entry is part of a signed-off time sheet, yet PUT /api/time/:id changed
// its minutes and left it "approved". It is now locked at both doors (REST and sync push, one rule in
// server/rules/time_entries.js): no edit and no delete, by the worker or by a manager, until a supervisor
// returns it (POST /api/time/:id/approve with decision "rejected" and a reason). Submitted time stays the
// worker's to correct, as before. Approved expenditures were already locked; checked here over REST too.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const today = LD.today();
const U = {}; const C = {};

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  for (const [k, role] of [['nav', 'navigator'], ['sup', 'supervisor'], ['sup2', 'supervisor']]) {
    const u = H.makeUser(`lock_${k}`, role); U[k] = u.id;
    C[k] = H.client(); await C[k].login(u.username, u.password);
  }
});
after(() => H.stop());

async function approvedEntry(minutes = 30) {
  const r = await C.nav.post('/api/time', { work_date: today, minutes, category: 'admin', description: 'Paperwork' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await C.nav.post(`/api/time/${r.data.id}/submit`, {})).status, 200);
  const a = await C.sup.post(`/api/time/${r.data.id}/approve`, { decision: 'approved' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  return r.data.id;
}
const row = (id) => H.db.one(`SELECT * FROM time_entries WHERE id=?`, id);

test('an approved time entry cannot be edited or deleted over REST, by the worker or a manager', async () => {
  const id = await approvedEntry(30);
  for (const who of ['nav', 'sup2']) {
    const put = await C[who].put(`/api/time/${id}`, { minutes: 300, description: 'Rewritten' });
    assert.equal(put.status, 409, `${who}: ${JSON.stringify(put.data)}`);
    assert.match(put.data.error, /approved/i);
    assert.match(put.data.error, /supervisor/i);
    const del = await C[who].del(`/api/time/${id}`);
    assert.equal(del.status, 409, `${who}: ${JSON.stringify(del.data)}`);
  }
  const t = row(id);
  assert.equal(t.minutes, 30); assert.equal(t.status, 'approved');
});

test('submitted time is still its worker\'s to correct', async () => {
  const r = await C.nav.post('/api/time', { work_date: today, minutes: 20, category: 'admin' });
  await C.nav.post(`/api/time/${r.data.id}/submit`, {});
  const put = await C.nav.put(`/api/time/${r.data.id}`, { minutes: 25 });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(row(r.data.id).minutes, 25);
  assert.equal(row(r.data.id).status, 'submitted');
});

test('a supervisor returns approved time with a reason; then the worker can correct and resubmit it', async () => {
  const id = await approvedEntry(40);
  // Not your own, and not without a reason.
  assert.equal((await C.sup.post(`/api/time/${id}/approve`, { decision: 'rejected' })).status, 400);
  const back = await C.sup.post(`/api/time/${id}/approve`, { decision: 'rejected', note: 'Wrong date, please fix' });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(row(id).status, 'rejected');
  const audit = H.db.one(`SELECT details FROM audit_log WHERE action='time.rejected' AND entity_id=? ORDER BY rowid DESC LIMIT 1`, id);
  assert.match(audit.details, /"reopened":true/);
  // Approving it again is still only for submitted time.
  assert.equal((await C.sup.post(`/api/time/${id}/approve`, { decision: 'approved' })).status, 400);
  assert.equal((await C.nav.put(`/api/time/${id}`, { minutes: 35 })).status, 200);
  assert.equal((await C.nav.post(`/api/time/${id}/submit`, {})).status, 200);
  assert.equal(row(id).minutes, 35);
});

test('sync push: a device cannot rewrite or delete approved time either', async () => {
  const id = await approvedEntry(50);
  const t = row(id);
  const pushed = { id, user_id: U.nav, work_date: t.work_date, minutes: 500, category: 'admin', status: 'approved', updated_at: iso(Date.now() + 5000) };
  const r = await C.nav.post('/api/sync/push', { device_now: iso(), tables: { time_entries: [pushed] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rejected.length, 1, JSON.stringify(r.data));
  assert.match(r.data.rejected[0].reason, /^not permitted/);
  assert.equal(r.data.rejected[0].permanent, true, 'the device stops resending it');
  // A manager's device neither.
  const r2 = await C.sup2.post('/api/sync/push', { device_now: iso(), tables: { time_entries: [{ ...pushed, updated_at: iso(Date.now() + 9000) }] } });
  assert.equal(r2.data.rejected.length, 1, JSON.stringify(r2.data));
  const d = await C.nav.post('/api/sync/push', { device_now: iso(), tables: {}, tombstones: [{ table_name: 'time_entries', id, deleted_at: iso(Date.now() + 5000) }] });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.ok(row(id), 'still there');
  assert.equal(row(id).minutes, 50);
  assert.equal(row(id).status, 'approved');
});

test('an approved expenditure cannot be edited or deleted over REST by its submitter', async () => {
  const fund = randomUUID();
  H.db.run(`INSERT INTO funding_sources(id,name,fiscal_year_start,fiscal_year_end,total_amount) VALUES(?,?,?,?,?)`, fund, 'Lock fund', '2020-01-01', '2035-12-31', 1000);
  const e = randomUUID();
  H.db.run(`INSERT INTO expenditures(id,funding_source_id,user_id,spent_at,amount,category,status,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?)`, e, fund, U.nav, today, 20, 'supplies', 'approved', U.sup, iso());
  for (const who of ['nav', 'sup']) {
    const put = await C[who].put(`/api/budget/expenditures/${e}`, { amount: 2000 });
    assert.ok([403, 409].includes(put.status), `${who}: ${put.status} ${JSON.stringify(put.data)}`);
    const del = await C[who].del(`/api/budget/expenditures/${e}`);
    assert.ok([403, 409].includes(del.status), `${who}: ${del.status} ${JSON.stringify(del.data)}`);
  }
  const x = H.db.one(`SELECT amount, status FROM expenditures WHERE id=?`, e);
  assert.equal(x.amount, 20); assert.equal(x.status, 'approved');
});

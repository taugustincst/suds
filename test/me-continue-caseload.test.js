'use strict';
// Security review of 1.13.0, finding 2: GET /api/me/continue (the Home page's "continue where you left off")
// ignored the caseload. After a navigator's assignment to a client ended, opening the client was refused (403)
// but /api/me/continue still listed the client's name and to-do titles ("Send ROI to Valley Behavioral"), and
// the same for a to-do another worker had assigned them on that worker's own client; the drafts list likewise.
// Now everything it lists for a client is scoped the way /api/tasks/due is: a client the person can no longer
// open is dropped.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;

let nav1, nav2, nav1Id, mine, theirs, kept;
const today = new Date().toISOString().slice(0, 10);
before(async () => {
  await H.start();
  nav1Id = H.makeCaseloadUser('mc_nav1', 'navigator').id; H.makeCaseloadUser('mc_nav2', 'navigator');
  nav1 = H.client(); await nav1.login('mc_nav1', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('mc_nav2', 'StaffPassw0rd!x');
  mine = (await nav1.post('/api/clients', { first_name: 'Jamie', last_name: 'Endedassign', dob: '1990-01-01' })).data.id;
  kept = (await nav1.post('/api/clients', { first_name: 'Kept', last_name: 'Stillmine', dob: '1991-01-01' })).data.id;
  theirs = (await nav2.post('/api/clients', { first_name: 'Other', last_name: 'Workersclient', dob: '1992-01-01' })).data.id;
  // A to-do on their own client, a draft note, a to-do another worker gave them on that worker's client.
  assert.equal((await nav1.post('/api/tasks', { client_id: mine, title: 'Send ROI to Valley Behavioral', due_at: today })).status, 201);
  assert.equal((await nav1.post('/api/tasks', { client_id: kept, title: 'Still my own to-do', due_at: today })).status, 201);
  assert.equal((await nav2.post('/api/tasks', { client_id: theirs, assigned_to: nav1Id, title: 'Bring detox paperwork', due_at: today })).status, 201);
  assert.equal((await nav1.post('/api/tasks', { title: 'Timesheet reminder', due_at: today })).status, 201);
  const note = await nav1.post('/api/notes', { client_id: mine, kind: 'admin', format: 'narrative', title: 'Draft about Jamie housing', content: 'Draft text', occurred_at: new Date().toISOString() });
  assert.equal(note.status, 201, JSON.stringify(note.data));
  await nav1.get(`/api/clients/${mine}`);
  // The supervisor ends navigator 1's assignment to Jamie.
  db.run(`UPDATE assignments SET ended_at=? WHERE client_id=? AND user_id=?`, new Date(Date.now() - 1000).toISOString(), mine, nav1Id);
  assert.equal((await nav1.get(`/api/clients/${mine}`)).status, 403);
  assert.equal((await nav1.get(`/api/clients/${theirs}`)).status, 403);
});
after(() => H.stop());

test('continue lists nothing about a client the person can no longer open', async () => {
  const r = await nav1.get('/api/me/continue');
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.data);
  for (const s of ['Endedassign', 'Jamie', 'Valley Behavioral', 'Workersclient', 'detox paperwork', 'Draft about Jamie']) assert.ok(!body.includes(s), `"${s}" is not in the answer`);
  assert.ok(!r.data.due_today.some(t => t.client_id === mine || t.client_id === theirs));
  assert.ok(!r.data.drafts.some(d => d.client_id === mine));
  assert.ok(!r.data.recent.some(c => c.id === mine));
});

test('what they can still open, and their own to-dos with no client, are still there', async () => {
  const r = await nav1.get('/api/me/continue');
  const titles = r.data.due_today.map(t => t.title);
  assert.ok(titles.includes('Still my own to-do'));
  assert.ok(titles.includes('Timesheet reminder'));
  const own = r.data.due_today.find(t => t.title === 'Still my own to-do');
  assert.match(own.client_name, /Stillmine/);
});

'use strict';
// A calendar-day deadline must mean the same day in every view, and be "overdue" only once that day has ended.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let nav, clientId;
const day = (off) => { const d = new Date(); d.setDate(d.getDate() + off); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
before(async () => {
  await H.start(); H.makeUser('nav1', 'navigator');
  nav = H.client(); await nav.login('nav1', 'StaffPassw0rd!x');
  clientId = (await nav.post('/api/clients', { first_name: 'Date', last_name: 'Check' })).data.id;
});
after(async () => { await H.stop(); });

test('follow-up tasks keep a calendar-day due date that every list agrees on', async () => {
  const today = day(0), yesterday = day(-1), tomorrow = day(1);
  // a call with a follow-up date creates a task due on that day
  const c = await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: new Date().toISOString(), duration_minutes: 3, contact_type: 'client', outcome: 'voicemail', follow_up_needed: true, follow_up_due: tomorrow, purpose: 'Check in' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const t1 = (await nav.post('/api/tasks', { client_id: clientId, title: 'Was due yesterday', due_at: yesterday })).data.id;
  const t2 = (await nav.post('/api/tasks', { client_id: clientId, title: 'Due today', due_at: today })).data.id;
  const list = (await nav.get('/api/tasks?limit=50&status=open')).data.rows;
  const follow = list.find(t => /Check in|follow/i.test(t.title) && t.client_id === clientId);
  assert.ok(follow, 'follow-up task exists'); assert.equal(follow.due_at, tomorrow, 'stored as the calendar day the user picked, not shifted by time zone');
  // the client timeline shows the same day for the same task
  const events = (await nav.get(`/api/clients/${clientId}/timeline`)).data.events;
  const ev = events.find(e => e.id === follow.id); assert.ok(ev); assert.equal(ev.at, tomorrow); assert.equal(ev.title, follow.title, 'timeline shows the title exactly as entered');
  // overdue is decided by the day, not by midnight UTC
  const overdue = (await nav.get('/api/tasks?limit=50&status=open&overdue=1')).data.rows.map(t => t.id);
  assert.ok(overdue.includes(t1), 'yesterday is overdue'); assert.ok(!overdue.includes(t2), 'today is not overdue yet'); assert.ok(!overdue.includes(follow.id), 'tomorrow is not overdue');
  const dash = (await nav.get('/api/reports/dashboard')).data; assert.equal(dash.tasks.overdue, 1);
  const cont = (await nav.get('/api/me/continue')).data; const ids = cont.due_today.map(t => t.id);
  assert.ok(ids.includes(t1) && ids.includes(t2) && !ids.includes(follow.id), 'home shows today and earlier, not tomorrow');
});

test('"All" in a status filter means all, not nothing', async () => {
  const all = (await nav.get('/api/tasks?limit=50&status=all')).data.rows;
  const open = (await nav.get('/api/tasks?limit=50&status=open')).data.rows;
  assert.ok(all.length >= open.length && all.length >= 3, `all=${all.length} open=${open.length}`);
});

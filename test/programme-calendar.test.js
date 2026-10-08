'use strict';
// Dates on the programme's calendar, the fixes from the evaluations of 1.25.1 (F3, BO4, BO5, CS4, CS5). The programme
// is twelve hours behind UTC (Etc/GMT+12), so its evening is always the next UTC day: whatever moment the suite runs,
// a "today" or a month taken from an instant's UTC date is wrong here.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const LD = require('../server/local-date');
const { randomUUID } = require('node:crypto');

const ZONE = 'Etc/GMT+12';
let admin, nav, navId, adminId;
before(async () => {
  await H.start();
  H.db.setSetting('org_timezone', ZONE);
  navId = H.makeCaseloadUser('pcnav', 'navigator').id;
  adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('pcnav', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

/** The last minute of the programme's day `date`: in this zone always on the next UTC date. */
const lateOn = (date) => new Date(Date.parse(LD.localMidnight(LD.addDays(date, 1))) - 60000).toISOString();

test('an impossible calendar date is refused, not rolled over to the next month (BO5)', async () => {
  const t = await nav.post('/api/time', { work_date: '2026-09-31', minutes: 30, category: 'documentation' });
  assert.equal(t.status, 400); assert.match(JSON.stringify(t.data), /work_date.*not a real date/);
  assert.equal((await nav.post('/api/time', { work_date: '2026-09-30', minutes: 30, category: 'documentation' })).status, 201, 'the last real day is fine');
  const f = await admin.post('/api/budget/funds', { name: 'Calendar fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  assert.equal(f.status, 201);
  const e = await admin.post('/api/budget/expenditures', { funding_source_id: f.data.id, spent_at: '2026-02-30', amount: 10, category: 'client_assistance' });
  assert.equal(e.status, 400); assert.match(JSON.stringify(e.data), /spent_at.*not a real date/);
  assert.equal((await admin.post('/api/budget/funds', { name: 'Bad period', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-06-31', total_amount: 1 })).status, 400);
  assert.equal((await admin.get('/api/reports/funder?from=2026-02-30&to=2026-09-30')).status, 400, 'a report period too');
  assert.equal((await admin.get('/api/reports/dashboard?from=2026-07-01&to=2026-09-31')).status, 400);
  assert.equal((await admin.get('/api/reports/dashboard?from=2026-07-01&to=2026-09-30')).status, 200);
  const v = await nav.post('/api/tasks', { title: 'Impossible', due_at: '2026-09-31T10:00:00Z' });
  assert.equal(v.status, 400, 'and the date part of a date and time');
});

test('a spreadsheet import refuses impossible, year-less and future dates, lists two-digit years, and dates an intake today (BO4, F3)', async () => {
  const today = LD.today(); const tomorrow = LD.addDays(today, 1);
  const mdy = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  const csv = ['First name,Last name,Date of birth,Intake date', 'Feb,Thirty,2/30/90,', `Future,Born,${mdy(tomorrow)},`, `Future,Intake,,${mdy(tomorrow)}`, 'No,Year,,10/8', 'Short,Year,7/9/81,', 'No,Intake,1/2/1980,'].join('\r\n');
  const prev = await nav.req('POST', '/api/imports/data/preview?entity=clients', csv, { 'Content-Type': 'text/csv', 'X-Filename': 'dates.csv' });
  assert.equal(prev.status, 200, JSON.stringify(prev.data));
  const rows = Object.fromEntries(prev.data.rows.map(r => [r.record.first_name + ' ' + r.record.last_name, r]));
  assert.match(rows['Feb Thirty'].errors.join(), /Date of birth: "2\/30\/90" is not a valid date/);
  assert.match(rows['Future Born'].errors.join(), /Date of birth cannot be in the future/);
  assert.match(rows['Future Intake'].errors.join(), /Intake date cannot be in the future/);
  assert.match(rows['No Year'].errors.join(), /Intake date: "10\/8" is not a valid date/);
  assert.deepEqual(rows['Short Year'].errors, []);
  assert.deepEqual(rows['Short Year'].dates, [{ field: 'Date of birth', raw: '7/9/81', value: '1981-07-09' }], 'the preview lists what a two-digit year was read as');
  assert.equal(prev.data.valid, 2);
  // The commit checks again: a record sent back with a future date of birth is refused, whatever the preview said.
  const bad = await nav.post('/api/imports/data/commit', { entity: 'clients', records: [{ first_name: 'Sent', last_name: 'Back', dob: tomorrow }] });
  assert.equal(bad.status, 400); assert.match(JSON.stringify(bad.data), /Date of birth cannot be in the future/);
  const ok = await nav.post('/api/imports/data/commit', { entity: 'clients', records: prev.data.rows.filter(r => !r.errors.length).map(r => r.record) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.created, 2);
  const id = H.db.one(`SELECT id FROM clients WHERE intake_date IS NOT NULL ORDER BY rowid DESC LIMIT 1`).id;
  assert.equal(H.db.one(`SELECT intake_date FROM clients WHERE id=?`, id).intake_date, today, 'no intake date: the programme\'s today, not the UTC date');
  assert.equal(H.db.one(`SELECT start_date FROM assignments WHERE client_id=? AND user_id=?`, id, navId).start_date, today);
});

test('a to-do due this evening is due today on Home and the dashboard (CS4)', async () => {
  const today = LD.today(); const evening = lateOn(today);
  assert.notEqual(evening.slice(0, 10), today, 'the instant is on the next UTC date');
  const count = async () => (await admin.get('/api/reports/dashboard')).data.tasks.due_today;
  const before = await count();
  const t = await admin.post('/api/tasks', { title: 'Evening group check-in', due_at: evening, assigned_to: adminId });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  assert.equal(await count(), before + 1, 'counted as due today');
  const tomorrow = await admin.post('/api/tasks', { title: 'Tomorrow morning', due_at: LD.localMidnight(LD.addDays(today, 1)), assigned_to: adminId });
  assert.equal(tomorrow.status, 201);
  assert.equal(await count(), before + 1, 'not one due at midnight tonight');
  const home = await admin.get('/api/me/continue');
  assert.equal(home.status, 200);
  assert.ok(home.data.due_today.some(x => x.id === t.data.id), 'Home lists the evening to-do');
  assert.ok(!home.data.due_today.some(x => x.id === tomorrow.data.id), 'and not tomorrow\'s');
});

test('the monthly report puts an evening visit on the last day of a month in that month (CS5)', async () => {
  const today = LD.today(); const thisMonth = today.slice(0, 7);
  const lastOfPrev = LD.addDays(`${thisMonth}-01`, -1); const prevMonth = lastOfPrev.slice(0, 7);
  const c = await nav.post('/api/clients', { first_name: 'Month', last_name: 'End', confirm_duplicate: true });
  assert.equal(c.status, 201);
  const monthly = async () => (await admin.get('/api/reports/monthly?months=2')).data;
  const n = (rows, m) => (rows.find(r => r.month === m) || {}).n || 0;
  const was = await monthly();
  const at = lateOn(lastOfPrev);
  assert.equal(at.slice(0, 7), thisMonth, 'the visit\'s UTC month is this one');
  H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome) VALUES(?,?,?,?,?,?,?,?,?)`, randomUUID(), c.data.id, navId, 'outreach', at, 30, 'field', 'in_person', 'completed');
  H.db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,duration_minutes,contact_type,outcome) VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), c.data.id, navId, 'outbound', at, 5, 'client', 'reached');
  const now = await monthly();
  assert.equal(n(now.interventions, prevMonth), n(was.interventions, prevMonth) + 1, 'the visit is last month\'s');
  assert.equal(n(now.interventions, thisMonth), n(was.interventions, thisMonth), 'not this month\'s');
  assert.equal(n(now.calls, prevMonth), n(was.calls, prevMonth) + 1, 'and the call');
  assert.ok(!now.interventions.some(r => r.month > thisMonth), 'no month after this one appears');
});

test('SUPRT reads an evening visit on the programme\'s day, not the next UTC day (CS5)', async () => {
  const S = require('../server/suprt');
  const day = LD.addDays(LD.today(), -10);
  const c = await nav.post('/api/clients', { first_name: 'Suprt', last_name: 'Evening', confirm_duplicate: true });
  assert.equal(c.status, 201);
  H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome,naloxone_kits) VALUES(?,?,?,?,?,?,?,?,?,?)`, randomUUID(), c.data.id, navId, 'outreach', lateOn(day), 30, 'field', 'in_person', 'completed', 2);
  const close = S.derive(c.data.id, { type: 'closeout', date: day });
  assert.equal(close.answers.A_first_service_date, day, 'the first date of service is that evening\'s date');
  assert.equal(close.answers.A_last_service_date, day, 'and so is the last, on or before an assessment that day');
  const re = S.derive(c.data.id, { type: 'reassessment', date: day, since: LD.addDays(day, -1) });
  assert.equal(re.answers.E_naloxone, 'yes', 'the visit is within the period that ends that day');
});

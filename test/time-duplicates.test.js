'use strict';
// Duplicate time entries (built for 1.24.0; server/rules/time_entries.js duplicatesOf, server/routes/time.js).
// A save that looks like time already logged -- the same worker and day, with overlapping times or the same minutes
// and description -- is answered 409 { duplicate, candidates } instead of saved: the form offers Merge, Save anyway
// or Cancel. Save anyway (save_anyway: true) saves and audits the override; Merge (POST /api/time/:id/merge) keeps
// the entry already there with the notes combined; approved time is never merged into; a device's push is never
// blocked but is marked for review (duplicate_of), which the approval queue shows and a supervisor merges or clears
// (POST /api/time/:id/not-duplicate). No description text reaches an audit entry.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');
const { encrypt } = require('../server/crypto');

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const U = {}; const C = {};
// Each test has a day of its own, so the entries of one never match another's.
let dayN = 0;
const nextDay = () => `2026-08-${String(++dayN).padStart(2, '0')}`;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  for (const [k, role] of [['nav', 'navigator'], ['nav2', 'navigator'], ['sup', 'supervisor'], ['sup2', 'supervisor'], ['fin', 'finance']]) {
    const u = H.makeUser(`dup_${k}`, role); U[k] = u.id;
    C[k] = H.client(); await C[k].login(u.username, u.password);
  }
});
after(() => H.stop());

const row = (id) => H.db.one(`SELECT * FROM time_entries WHERE id=?`, id);
const dayRows = (user, day) => H.db.all(`SELECT * FROM time_entries WHERE user_id=? AND work_date=?`, user, day);
const audits = (action, id) => H.db.all(`SELECT * FROM audit_log WHERE action=? AND entity_id=? ORDER BY rowid`, action, id);
async function logged(c, body) {
  const r = await c.post('/api/time', { category: 'admin', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

test('an overlapping entry for the same worker and day is asked about, and Cancel (not resending) saves nothing', async () => {
  const day = nextDay();
  const first = await logged(C.nav, { work_date: day, start_time: '09:00', minutes: 60, description: 'Outreach at the shelter' });
  const r = await C.nav.post('/api/time', { work_date: day, start_time: '09:30', minutes: 45, category: 'admin', description: 'Something else' });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.duplicate, true);
  assert.equal(r.data.candidates.length, 1);
  const cand = r.data.candidates[0];
  assert.equal(cand.id, first);
  assert.deepEqual(cand.reasons, ['overlap']);
  assert.equal(cand.description, 'Outreach at the shelter', 'the worker reads their own description');
  assert.equal(cand.start_time, '09:00');
  assert.equal(cand.locked, false); assert.equal(cand.may_merge, true);
  assert.equal(dayRows(U.nav, day).length, 1, 'nothing was saved');
  const warn = audits('time_entry.duplicate.warn', first);
  assert.equal(warn.length, 1, 'showing the candidate is an audited read');
  assert.doesNotMatch(warn[0].details, /shelter/i, 'no description text in the audit details');
  // Not overlapping (10:00 onwards) and a different description: no question.
  await logged(C.nav, { work_date: day, start_time: '10:00', minutes: 30, description: 'Something else' });
  // Another worker's time that day is never a duplicate of this one.
  await logged(C.nav2, { work_date: day, start_time: '09:15', minutes: 30, description: 'Outreach at the shelter' });
});

test('the same minutes and the same description (ignoring case and spacing) is asked about; blank descriptions are not', async () => {
  const day = nextDay();
  const first = await logged(C.nav, { work_date: day, minutes: 30, description: 'Drove client to detox' });
  const r = await C.nav.post('/api/time', { work_date: day, minutes: 30, category: 'travel', description: '  drove CLIENT to   detox ' });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.deepEqual(r.data.candidates.map(x => [x.id, x.reasons]), [[first, ['same_note']]]);
  // Different minutes, or a different description: saved without a question.
  await logged(C.nav, { work_date: day, minutes: 31, description: 'Drove client to detox' });
  await logged(C.nav, { work_date: day, minutes: 30, description: 'Drove client home' });
  // Two untitled half-hours are not "the same note".
  await logged(C.nav, { work_date: day, minutes: 45 });
  await logged(C.nav, { work_date: day, minutes: 45 });
});

test('Save anyway saves the entry and audits the override, naming ids only', async () => {
  const day = nextDay();
  const first = await logged(C.nav, { work_date: day, start_time: '13:00', minutes: 60, description: 'Group session notes' });
  const body = { work_date: day, start_time: '13:30', minutes: 60, category: 'admin', description: 'Group session notes' };
  assert.equal((await C.nav.post('/api/time', body)).status, 409);
  const r = await C.nav.post('/api/time', { ...body, save_anyway: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(dayRows(U.nav, day).length, 2);
  assert.equal(row(r.data.id).duplicate_of, null, 'answered, so not marked for review');
  const a = audits('time_entry.duplicate.override', r.data.id);
  assert.equal(a.length, 1);
  const d = JSON.parse(a[0].details);
  assert.deepEqual(d.candidates, [first]);
  assert.deepEqual(d.reasons.sort(), ['overlap', 'same_note']);
  assert.doesNotMatch(a[0].details, /Group session/);
});

test('Merge keeps the entry already there: notes combined, times the union of both ranges, one entry counted', async () => {
  const day = nextDay();
  const kept = await logged(C.nav, { work_date: day, start_time: '09:00', minutes: 60, description: 'Housing paperwork' });
  const entry = { work_date: day, start_time: '09:30', minutes: 60, category: 'admin', description: 'Called the landlord', billable: true };
  assert.equal((await C.nav.post('/api/time', entry)).status, 409);
  const before = row(kept);
  const m = await C.nav.post(`/api/time/${kept}/merge`, { entry, if_updated_at: before.updated_at });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(m.data.id, kept); assert.equal(m.data.merged, null);
  const rows = dayRows(U.nav, day);
  assert.equal(rows.length, 1, 'one entry');
  const g = await C.nav.get(`/api/time/${kept}`);
  assert.equal(g.data.row.description, 'Housing paperwork\nCalled the landlord');
  assert.equal(g.data.row.start_time, '09:00');
  assert.equal(g.data.row.minutes, 90, '09:00-10:30, not 60 + 60');
  assert.equal(g.data.row.billable, 1);
  const a = audits('time_entry.merge', kept);
  assert.equal(a.length, 1);
  const d = JSON.parse(a[0].details);
  assert.equal(d.merged, 'new entry'); assert.equal(d.times, 'union');
  assert.deepEqual(d.fields.sort(), ['billable', 'description', 'minutes']);
  assert.doesNotMatch(a[0].details, /landlord|Housing/);
  // The staff-hours totals count the merged entry once.
  const s = await C.nav.get(`/api/time/summary?from=${day}&to=${day}`);
  assert.equal(s.data.by_day[0].minutes, 90);
  // A stale form is told so, as a save is.
  const stale = await C.nav.post(`/api/time/${kept}/merge`, { entry: { ...entry, description: 'x' }, if_updated_at: before.updated_at });
  assert.equal(stale.status, 409); assert.equal(stale.data.stale, true);
});

test('Merge with times "keep" leaves the kept entry\'s range; the same description is not repeated', async () => {
  const day = nextDay();
  const kept = await logged(C.nav, { work_date: day, start_time: '14:00', minutes: 30, description: 'Intake call' });
  const m = await C.nav.post(`/api/time/${kept}/merge`, { entry: { work_date: day, start_time: '14:10', minutes: 40, category: 'admin', description: 'intake call' }, times: 'keep' });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  const t = row(kept);
  assert.equal(t.minutes, 30); assert.equal(t.start_time, '14:00');
  assert.equal((await C.nav.get(`/api/time/${kept}`)).data.row.description, 'Intake call');
  assert.equal((await C.nav.post(`/api/time/${kept}/merge`, { entry: { work_date: day, minutes: 5, category: 'admin' }, times: 'both' })).status, 400);
  // Only the same worker's time on the same day.
  assert.equal((await C.nav.post(`/api/time/${kept}/merge`, { entry: { work_date: nextDay(), minutes: 30, category: 'admin' } })).status, 400);
  assert.equal((await C.nav.post(`/api/time/${kept}/merge`, {})).status, 400);
});

test('approved time is never merged into (409), and the question says it is locked', async () => {
  const day = nextDay();
  const id = await logged(C.nav, { work_date: day, start_time: '08:00', minutes: 60, description: 'Signed off' });
  assert.equal((await C.nav.post(`/api/time/${id}/submit`, {})).status, 200);
  assert.equal((await C.sup.post(`/api/time/${id}/approve`, { decision: 'approved' })).status, 200);
  const entry = { work_date: day, start_time: '08:30', minutes: 30, category: 'admin', description: 'More' };
  const q = await C.nav.post('/api/time', entry);
  assert.equal(q.status, 409);
  assert.equal(q.data.candidates[0].locked, true); assert.equal(q.data.candidates[0].may_merge, false);
  for (const who of ['nav', 'sup2']) {
    const m = await C[who].post(`/api/time/${id}/merge`, { entry });
    assert.equal(m.status, 409, `${who}: ${JSON.stringify(m.data)}`);
    assert.match(m.data.error, /approved/i);
  }
  const t = row(id);
  assert.equal(t.minutes, 60); assert.equal(t.status, 'approved');
  // Nor merged away: a stored approved entry cannot be the one deleted either.
  const other = await logged(C.nav, { ...entry, save_anyway: true });
  assert.equal((await C.nav.post(`/api/time/${other}/merge`, { from_id: id })).status, 409);
  assert.ok(row(id));
});

test('an edit is asked about only when it changes the day, times, minutes or description', async () => {
  const day = nextDay();
  await logged(C.nav, { work_date: day, start_time: '11:00', minutes: 60, description: 'Morning' });
  const b = await logged(C.nav, { work_date: day, start_time: '12:00', minutes: 30, description: 'Noon' });
  assert.equal((await C.nav.put(`/api/time/${b}`, { category: 'travel' })).status, 200, 'a category change is not asked about');
  const put = await C.nav.put(`/api/time/${b}`, { start_time: '11:45' });
  assert.equal(put.status, 409, JSON.stringify(put.data));
  assert.equal(put.data.duplicate, true);
  assert.equal(row(b).start_time, '12:00', 'nothing changed');
  const again = await C.nav.put(`/api/time/${b}`, { start_time: '11:45', save_anyway: true });
  assert.equal(again.status, 200);
  assert.equal(audits('time_entry.duplicate.override', b).length, 1);
  assert.equal((await C.nav.put(`/api/time/${b}`, { start_time: 'noon' })).status, 400, 'a start time is HH:MM');
});

test('permissions: another worker cannot merge or clear your time; finance clears a mark but cannot merge', async () => {
  const day = nextDay();
  const a = await logged(C.nav, { work_date: day, start_time: '15:00', minutes: 30, description: 'Mine' });
  const entry = { work_date: day, start_time: '15:00', minutes: 30, category: 'admin', description: 'Mine' };
  const m = await C.nav2.post(`/api/time/${a}/merge`, { entry });
  assert.equal(m.status, 403, JSON.stringify(m.data));
  assert.equal((await C.nav2.post(`/api/time/${a}/not-duplicate`, {})).status, 403);
  assert.equal((await C.fin.post(`/api/time/${a}/merge`, { entry })).status, 403, 'finance has no time:write');
  // A manager (time:all) may merge a worker's time, naming the worker.
  const s = await C.sup.post(`/api/time/${a}/merge`, { entry: { ...entry, user_id: U.nav, description: 'Theirs too' } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal((await C.sup.post('/api/time/nope/merge', { entry })).status, 404);
  H.db.run(`UPDATE time_entries SET duplicate_of=? WHERE id=?`, randomUUID(), a);
  const f = await C.fin.post(`/api/time/${a}/not-duplicate`, {});
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.equal(row(a).duplicate_of, null);
  assert.equal(audits('time_entry.duplicate.dismiss', a).length, 1);
});

test('a match the worker may not read is never shown: the save goes ahead, marked for review', async () => {
  const day = nextDay();
  const cw = H.makeCaseloadUser('dup_case', 'navigator'); const cc = H.client(); await cc.login(cw.username, cw.password);
  const cl = await C.sup.post('/api/clients', { first_name: 'Hidden', last_name: 'Client', confirm_duplicate: true });
  assert.equal(cl.status, 201, JSON.stringify(cl.data));
  // Logged for a client who has since left this worker's caseload.
  const hidden = randomUUID();
  H.db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,start_time,minutes,category,description_enc) VALUES(?,?,?,?,?,?,?,?)`, hidden, cw.id, cl.data.id, day, '10:00', 60, 'admin', encrypt('Private'));
  const r = await cc.post('/api/time', { work_date: day, start_time: '10:15', minutes: 30, category: 'admin', description: 'Private' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(row(r.data.id).duplicate_of, hidden);
  assert.equal(audits('time_entry.duplicate.warn', hidden).length, 0);
});

test('a device\'s push is not blocked: the entry lands, marked for review, and the approval queue shows it', async () => {
  const day = nextDay();
  const first = await logged(C.nav, { work_date: day, start_time: '16:00', minutes: 60, description: 'Street outreach' });
  const pushedId = randomUUID();
  const pushed = { id: pushedId, user_id: U.nav, work_date: day, start_time: '16:30', minutes: 60, category: 'admin', description_enc: 'Street outreach, again', status: 'submitted', duplicate_of: null, updated_at: iso() };
  const p = await C.nav.post('/api/sync/push', { device_now: iso(), tables: { time_entries: [pushed] } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.rejected.length, 0, JSON.stringify(p.data));
  assert.ok(p.data.warnings.some(w => w.id === pushedId && w.flagged && /duplicate/.test(w.reason)), JSON.stringify(p.data.warnings));
  assert.equal(row(pushedId).duplicate_of, first);
  const conflict = H.db.one(`SELECT details FROM audit_log WHERE action='sync.conflict' AND entity_id=? ORDER BY rowid DESC LIMIT 1`, pushedId);
  assert.match(conflict.details, /"flagged":"duplicate"/);
  assert.doesNotMatch(conflict.details, /outreach/i);
  // A device cannot set or clear the mark itself.
  const p2 = await C.nav.post('/api/sync/push', { device_now: iso(), tables: { time_entries: [{ ...pushed, category: 'travel', duplicate_of: null, updated_at: iso(Date.now() + 2000) }] } });
  assert.equal(p2.status, 200);
  assert.equal(row(pushedId).duplicate_of, first, 'an edit that does not touch the check keeps the mark');
  // The approval queue shows the pair, with the other entry's hours.
  const q = await C.sup.get('/api/supervision/queue');
  assert.equal(q.status, 200, JSON.stringify(q.data));
  const item = q.data.time_awaiting_approval.find(x => x.id === pushedId);
  assert.ok(item, 'the pushed entry is waiting for approval');
  assert.equal(item.duplicate_of, first); assert.equal(item.duplicate_minutes, 60); assert.equal(item.duplicate_start_time, '16:00');
  const totalBefore = q.data.time_totals.minutes;
  // The supervisor merges the pushed entry into the earlier one: one entry, 16:00-17:30.
  const m = await C.sup.post(`/api/time/${first}/merge`, { from_id: pushedId });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(m.data.merged, pushedId);
  assert.equal(row(pushedId), null);
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='time_entries' AND id=?`, pushedId), 'devices are told it is gone');
  assert.equal(row(first).minutes, 90);
  assert.equal(audits('time_entry.delete', pushedId).length, 1);
  const q2 = await C.sup.get('/api/supervision/queue');
  assert.equal(q2.data.time_totals.minutes, totalBefore - 60, 'the merged-away entry is no longer counted');
  const sum = await C.sup.get(`/api/time/summary?from=${day}&to=${day}`);
  assert.equal(sum.data.by_day[0].minutes, 90, 'staff hours count the day once');
});

test('a pushed duplicate a supervisor reviews can be cleared as not a duplicate', async () => {
  const day = nextDay();
  const first = await logged(C.nav, { work_date: day, minutes: 20, description: 'Phone check-in' });
  const id = randomUUID();
  const p = await C.nav.post('/api/sync/push', { device_now: iso(), tables: { time_entries: [{ id, user_id: U.nav, work_date: day, minutes: 20, category: 'admin', description_enc: 'phone check-in', updated_at: iso() }] } });
  assert.equal(p.data.rejected.length, 0, JSON.stringify(p.data));
  assert.equal(row(id).duplicate_of, first);
  const d = await C.sup.post(`/api/time/${id}/not-duplicate`, {});
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(row(id).duplicate_of, null);
  // Deleting the earlier entry clears any mark pointing at it.
  H.db.run(`UPDATE time_entries SET duplicate_of=? WHERE id=?`, first, id);
  assert.equal((await C.nav.del(`/api/time/${first}`)).status, 200);
  assert.equal(row(id).duplicate_of, null);
});

'use strict';
// Findings from the functional audit, each reproduced before it was fixed: a Settings save that silently
// switched MFA off for everyone, a time entry returned with no reason, a newer backup that read as an
// internal error, a zero grace period that meant fourteen days, and the rest.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const config = require('../server/config');
const auth = require('../server/auth');

let admin, nav, fin, sup, ro;
before(async () => {
  await H.start();
  H.makeUser('fa_nav', 'navigator'); H.makeUser('fa_fin', 'finance'); H.makeUser('fa_sup', 'supervisor'); H.makeUser('fa_ro', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('fa_nav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('fa_fin', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('fa_sup', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('fa_ro', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

const ALL_ROLES = ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly'];

test('B1: saving the Settings form on a fresh install keeps every policy default, including MFA for all roles', async () => {
  const saved = config.mfaRequiredRoles;
  config.mfaRequiredRoles = ALL_ROLES;
  try {
    for (const k of ['session_idle_minutes', 'session_absolute_hours', 'password_max_age_days', 'mfa_required_roles', 'mfa_grace_days', 'backup_retain_count', 'client_retention_years'])
      H.db.run(`DELETE FROM settings WHERE key=?`, k);
    const s = await admin.get('/api/admin/settings');
    assert.equal(s.status, 200);
    for (const k of ['session_idle_minutes', 'session_absolute_hours', 'password_max_age_days', 'mfa_required_roles', 'mfa_grace_days'])
      assert.ok(s.data[k] === null || s.data[k] === undefined, `${k} is unset on a fresh install, not '' (got ${JSON.stringify(s.data[k])})`);
    assert.deepEqual(s.data.policy.mfaRequiredRoles, ALL_ROLES);
    // The form sends every field back, exactly as it received them, with only the county changed.
    const body = {}; for (const [k, v] of Object.entries(s.data)) if (k !== 'policy' && k !== 'env') body[k] = v;
    body.county_name = 'Clark';
    assert.equal((await admin.put('/api/admin/settings', body)).status, 200);
    const pol = auth.policy();
    assert.deepEqual(pol.mfaRequiredRoles, ALL_ROLES, 'MFA is still required of every role');
    assert.equal(pol.idleMinutes, 15); assert.equal(pol.absoluteHours, 12); assert.equal(pol.passwordMaxAgeDays, 90); assert.equal(pol.mfaGraceDays, 3);
    assert.equal(require('../server/scheduled-backup').settings().retain, 14);
    assert.equal(H.db.getSetting('mfa_required_roles', null), null, 'an empty roles field is "unset", never stored as an empty string');
    assert.equal(H.db.getSetting('county_name'), 'Clark');
    const again = await admin.get('/api/admin/settings');
    assert.equal(again.data.county_name, 'Clark');
    assert.ok(again.data.session_idle_minutes === null || again.data.session_idle_minutes === undefined);
  } finally { config.mfaRequiredRoles = saved; H.db.run(`DELETE FROM settings WHERE key IN ('county_name','mfa_required_roles')`); }
});

test('B1: a settings save is all-or-nothing', async () => {
  H.db.run(`DELETE FROM settings WHERE key='program_contact'`);
  const r = await admin.put('/api/admin/settings', { program_contact: 'Someone', session_idle_minutes: 999 });
  assert.equal(r.status, 400);
  assert.equal(H.db.getSetting('program_contact', null), null, 'the field before the bad one was not written on its own');
});

test('H3: an MFA grace period of 0 means enrol now, not the 3-day default; other policy numbers refuse 0', async () => {
  assert.equal((await admin.put('/api/admin/settings', { mfa_grace_days: 0, mfa_required_roles: 'navigator' })).status, 200);
  try {
    assert.equal(auth.policy().mfaGraceDays, 0);
    const u = H.makeUser('fa_grace0', 'navigator');
    const c = H.client();
    const login = await c.post('/api/auth/login', { username: u.username, password: u.password });
    assert.equal(login.status, 200);
    assert.equal(login.data.mfaSetupRequired, true);
    assert.ok(Date.parse(login.data.mfaSetupDeadline) <= Date.now(), 'the deadline is now, so the banner says "Set it up now"');
    const blocked = await c.get('/api/clients');
    assert.equal(blocked.status, 403); assert.equal(blocked.data.mfaSetupRequired, true);
    // A zero here would silently mean the default; it is refused instead of ignored.
    for (const k of ['session_idle_minutes', 'session_absolute_hours', 'password_max_age_days', 'backup_retain_count'])
      assert.equal((await admin.put('/api/admin/settings', { [k]: 0 })).status, 400, `${k}=0 is refused`);
    assert.equal((await admin.put('/api/admin/settings', { backup_schedule_hours: 0 })).status, 200, '0 hours legitimately means "off"');
  } finally { H.db.run(`DELETE FROM settings WHERE key IN ('mfa_grace_days','mfa_required_roles','backup_schedule_hours')`); }
});

test('H1: returning staff time needs a reason, and the worker sees it', async () => {
  const t = await nav.post('/api/time', { work_date: '2026-09-02', minutes: 45, category: 'direct_service' });
  assert.equal(t.status, 201);
  assert.equal((await nav.post(`/api/time/${t.data.id}/submit`, {})).status, 200);
  const bare = await sup.post(`/api/time/${t.data.id}/approve`, { decision: 'rejected' });
  assert.equal(bare.status, 400); assert.match(bare.data.error, /why/i);
  assert.equal((await sup.post('/api/time/approve-batch', { ids: [t.data.id], decision: 'rejected' })).status, 400, 'the batch route too');
  assert.equal(H.db.one(`SELECT status FROM time_entries WHERE id=?`, t.data.id).status, 'submitted');
  assert.equal((await sup.post('/api/time/approve-batch', { ids: [t.data.id], decision: 'rejected', note: 'Wrong date' })).status, 200);
  const mine = (await nav.get('/api/time?limit=50')).data.rows.find(x => x.id === t.data.id);
  assert.equal(mine.status, 'rejected'); assert.equal(mine.approval_note, 'Wrong date');
  // Approval stays one click.
  assert.equal((await nav.post(`/api/time/${t.data.id}/submit`, {})).status, 200);
  assert.equal((await sup.post(`/api/time/${t.data.id}/approve`, { decision: 'approved' })).status, 200);
});

test('M1: finance sees every submitted time entry on the Supervision queue and can approve it', async () => {
  const t = await nav.post('/api/time', { work_date: '2026-09-03', minutes: 30, category: 'travel' });
  await nav.post(`/api/time/${t.data.id}/submit`, {});
  const q = await fin.get('/api/supervision/queue');
  assert.equal(q.status, 200);
  assert.ok(q.data.time_awaiting_approval.some(x => x.id === t.data.id), 'finance holds time:all, so nothing is filtered to "supervised staff"');
  assert.ok(q.data.time_totals.entries >= 1);
  assert.equal((await fin.post(`/api/time/${t.data.id}/approve`, { decision: 'approved' })).status, 200);
});

test('H2: a backup made by a newer SUDS is refused with a clear message, not an internal error', async () => {
  const backup = require('../server/backup');
  H.db.setSetting('schema_version', '99');
  let enc; try { enc = backup.create(); } finally { H.db.setSetting('schema_version', String(H.db.LATEST_SCHEMA_VERSION)); }
  const file_b64 = enc.toString('base64');
  const p = await admin.post('/api/admin/restore/preview', { file_b64 });
  assert.equal(p.status, 400); assert.match(p.data.error, /newer version of SUDS \(schema 99/);
  const r = await admin.post('/api/admin/restore', { file_b64, password: 'AdminPassw0rd!x', confirm: 'REPLACE' });
  assert.equal(r.status, 400); assert.match(r.data.error, /newer version of SUDS/);
  const junk = await admin.post('/api/admin/restore/preview', { file_b64: Buffer.from('not a backup at all, really not').toString('base64') });
  assert.equal(junk.status, 400); assert.match(junk.data.error, /could not be read|does not look like/);
});

test('M2: a fund period must end after it starts, and allocations cannot exceed what holds them', async () => {
  assert.equal((await admin.post('/api/budget/funds', { name: 'Backwards', source_type: 'other', fiscal_year_start: '2026-12-31', fiscal_year_end: '2026-01-01', total_amount: 100 })).status, 400);
  const f = await admin.post('/api/budget/funds', { name: 'Structure limits', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  assert.equal(f.status, 201);
  assert.equal((await admin.put(`/api/budget/funds/${f.data.id}`, { fiscal_year_end: '2025-06-30' })).status, 400, 'nor can an edit move the end before the start');
  const a = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', label: 'A', allocated_amount: 600 });
  assert.equal(a.status, 201);
  const tooMuch = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', label: 'B', allocated_amount: 500 });
  assert.equal(tooMuch.status, 400); assert.match(tooMuch.data.error, /1,?000/);
  const b = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', label: 'B', allocated_amount: 400 });
  assert.equal(b.status, 201, 'exactly the fund total is fine');
  assert.equal((await admin.put(`/api/budget/lines/${b.data.id}`, { allocated_amount: 401 })).status, 400, 'an edit is held to the same limit');
  const sub1 = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', label: 'A1', allocated_amount: 500, parent_id: a.data.id });
  assert.equal(sub1.status, 201);
  const sub2 = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', label: 'A2', allocated_amount: 101, parent_id: a.data.id });
  assert.equal(sub2.status, 400); assert.match(sub2.data.error, /600/);
  assert.equal((await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', label: 'A2', allocated_amount: 100, parent_id: a.data.id })).status, 201);
  // Moving a line under a parent that has no room for it is refused the same way.
  assert.equal((await admin.put(`/api/budget/lines/${b.data.id}`, { parent_id: a.data.id })).status, 400);
});

test('M3: editing a pending expenditure cannot move it outside the fund period or into the future', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'Period edits', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-06-30', total_amount: 1000 });
  const e = await nav.post('/api/budget/expenditures', { funding_source_id: f.data.id, spent_at: '2026-03-05', amount: 10, category: 'other' });
  assert.equal(e.status, 201);
  const late = await nav.put(`/api/budget/expenditures/${e.data.id}`, { spent_at: '2026-08-01' });
  assert.equal(late.status, 400); assert.match(late.data.error, /outside the period/);
  const future = await nav.put(`/api/budget/expenditures/${e.data.id}`, { spent_at: '2099-01-01' });
  assert.equal(future.status, 400); assert.match(future.data.error, /future/);
  assert.equal((await nav.put(`/api/budget/expenditures/${e.data.id}`, { spent_at: '2026-04-01' })).status, 200);
  const other = await admin.post('/api/budget/funds', { name: 'Other period', source_type: 'other', fiscal_year_start: '2026-07-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  assert.equal((await nav.put(`/api/budget/expenditures/${e.data.id}`, { funding_source_id: other.data.id })).status, 400, 'nor onto a fund whose period does not cover the date');
});

test('M5: nobody approves their own expenditure, administrators included', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'Self-approval', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  const e = await admin.post('/api/budget/expenditures', { funding_source_id: f.data.id, spent_at: '2026-03-05', amount: 25, category: 'other' });
  assert.equal(e.status, 201);
  const r = await admin.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'approved' });
  assert.equal(r.status, 400); assert.match(r.data.error, /your own/);
  assert.equal((await sup.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'approved' })).status, 200);
});

test('L2: the supply cupboard is for staff who record visits; a read-only account cannot list it', async () => {
  assert.equal((await ro.get('/api/supplies')).status, 403);
  assert.equal((await fin.get('/api/supplies')).status, 403);
  assert.equal((await nav.get('/api/supplies')).status, 200);
  assert.equal((await sup.get('/api/supplies')).status, 200);
});

test('L3: a full disk answers 507 with a message for the office, not "Internal server error"', async () => {
  const db = H.db; const real = db.run;
  db.run = () => { throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full' }); };
  try {
    const r = await admin.post('/api/admin/api-keys', { name: 'disk full' });
    assert.equal(r.status, 507);
    assert.match(r.data.error, /disk is full; contact IT/);
  } finally { db.run = real; }
  assert.equal((await admin.get('/api/admin/api-keys')).status, 200);
});

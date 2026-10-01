'use strict';
// "Set up this phone for the field" (1.23.0; docs/USER_GUIDE.md "Street outreach", docs/PLATFORM.md "Field devices").
//
// A worker in the office app who needs to work with no signal asks for their phone to be set up as a field device
// (server/field-scope.js): it then keeps only what a field worker needs. The request goes to every active
// administrator who manages accounts and devices (users:manage) as a to-do, and Settings › Synced devices lists it
// with Approve and Decline.
//
// The 1.22.0 field-scope rules stand. Making a device a field device NARROWS what it holds, so:
//  - a worker may still do it on their own as they enrol the phone (the Sync screen's "Keep only what I need in
//    the field", server/auth.js login, devices.setScope via 'enrolment'); this request does not replace that;
//  - Approve holds the worker's account to the field scope (devices.bindAccount via 'admin'): every device the
//    account syncs from, now or later, is a field device, until an administrator marks one device "Hold everything";
//  - nothing here widens anything. Only an administrator widens, per device, under Synced devices, as before.
// An office whose offline copies are switched off (LOCAL_MODE_ENABLED / server.json) cannot have field devices at
// all; the to-do says so, and Approve still records the decision for when they are switched on.
//
// The request is kept in settings (`field_request:<user id>`: when, its state, and the to-dos it made), not in a table:
// it holds nothing about a client, one per worker, and is office-only. Audited as device.field_request(.approve|.decline).
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const config = require('./config');
const { HttpError, notFound } = require('./http');
const { uuid, encrypt } = require('./crypto');

const PREFIX = 'field_request:';
const read = (userId) => { try { const v = JSON.parse(db.getSetting(PREFIX + userId, 'null')); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const write = (userId, v) => db.setSetting(PREFIX + userId, JSON.stringify(v));
const officeOnly = () => { if (config.local) throw new HttpError(404, 'Setting up a phone for the field is asked of the office SUDS, not of a device.'); };

/** The administrators who decide: active accounts holding users:manage. */
function deciders() {
  return db.all(`SELECT * FROM users WHERE is_active=1 ORDER BY display_name`).filter(u => auth.hasPerm(u, 'users:manage'));
}

/** What the worker's page shows: whether offline copies are allowed, their devices, and their request. */
function status(user) {
  const devices = db.all(`SELECT id, label, sync_scope, last_seen_at, revoked_at FROM devices WHERE user_id=? ORDER BY last_seen_at DESC`, user.id)
    .map(d => ({ id: d.id, label: d.label, scope: d.sync_scope, last_seen_at: d.last_seen_at, revoked: !!d.revoked_at }));
  const r = read(user.id);
  return {
    local_mode: !!config.localModeEnabled,
    account_field: require('./devices').accountFieldBound(user.id),
    devices,
    request: r ? { status: r.status, requested_at: r.at, decided_at: r.decided_at || null } : null,
  };
}

function request(ctx) {
  officeOnly();
  const user = ctx.user;
  const prior = read(user.id);
  if (prior && prior.status === 'open') return { ok: true, already: true, ...status(user) };
  const admins = deciders().filter(a => a.id !== user.id);
  const at = db.now();
  const title = `Field device: ${user.display_name || user.username} asks for their phone to be set up for the field`;
  const desc = [
    `${user.display_name || user.username} (${user.username}) asked to work with no signal on their phone.`,
    config.localModeEnabled
      ? 'Offline copies are allowed on this server. Approve under Settings › Synced devices › Field-device requests: their phone then keeps only what a field worker needs (their own recent clients with the minimum of the record, their contacts, to-dos, supplies and lists). They set the phone up themselves from the office app.'
      : 'Offline copies are switched off on this server (the setup wizard\'s answer, server.json localModeEnabled, or LOCAL_MODE_ENABLED), so no phone can keep one yet. Decide whether field work needs them (docs/PLATFORM.md); approving records that this worker\'s phones are field devices once they are allowed.',
    'Approving narrows what their devices hold; it never widens anything.',
  ].join('\n\n');
  const tasks = [];
  db.transaction(() => {
    for (const a of admins) {
      const id = uuid();
      db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority) VALUES(?,?,?,?,?,?,?,?)`, id, null, a.id, user.id, encrypt(title), encrypt(desc), at.slice(0, 10), 'normal');
      tasks.push(id);
    }
    write(user.id, { status: 'open', at, tasks });
  });
  audit.log({ user, action: 'device.field_request', entity: 'user', entityId: user.id, ip: ctx.ip, details: { administrators: tasks.length, local_mode: !!config.localModeEnabled } });
  ctx.status = 201;
  return { ok: true, administrators: tasks.length, ...status(user) };
}

/** Open requests, for Settings › Synced devices. */
function pending() {
  const rows = db.all(`SELECT key, value FROM settings WHERE key LIKE 'field_request:%'`);
  const out = [];
  for (const r of rows) {
    let v; try { v = JSON.parse(r.value); } catch { continue; }
    if (!v || v.status !== 'open') continue;
    const u = db.one(`SELECT id, username, display_name, role, is_active FROM users WHERE id=?`, r.key.slice(PREFIX.length));
    if (!u || !u.is_active) continue;
    out.push({ user_id: u.id, username: u.username, display_name: u.display_name, role: u.role, requested_at: v.at, account_field: require('./devices').accountFieldBound(u.id) });
  }
  return out.sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
}

function decide(ctx, approve) {
  officeOnly();
  const userId = ctx.params.userId;
  const r = read(userId);
  if (!r || r.status !== 'open') throw notFound('There is no open field-device request from that person.');
  db.transaction(() => {
    // Narrowing only (devices.js): every device of the account is a field device from its next sync.
    if (approve) require('./devices').bindAccount(userId, 'admin', { actor: ctx.user, ip: ctx.ip });
    const now = db.now();
    for (const id of r.tasks || []) db.run(`UPDATE tasks SET status=?, completed_at=?, updated_at=? WHERE id=? AND status IN ('open','in_progress')`, approve ? 'done' : 'cancelled', now, now, id);
    write(userId, { ...r, status: approve ? 'approved' : 'declined', decided_at: now, decided_by: ctx.user.id });
  });
  audit.log({ user: ctx.user, action: approve ? 'device.field_request.approve' : 'device.field_request.decline', entity: 'user', entityId: userId, ip: ctx.ip });
  return { ok: true, status: approve ? 'approved' : 'declined' };
}

function routes(r) {
  r.get('/api/me/field-device', auth.requireAuth, (ctx) => status(ctx.user));
  r.post('/api/me/field-device/request', auth.requireAuth, (ctx) => request(ctx));
  r.get('/api/admin/field-requests', auth.requireAuth, auth.requirePerm('users:manage'), () => ({ requests: pending() }));
  r.post('/api/admin/field-requests/:userId/approve', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => decide(ctx, true));
  r.post('/api/admin/field-requests/:userId/decline', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => decide(ctx, false));
}

module.exports = { routes, status, pending };

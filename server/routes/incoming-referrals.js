'use strict';
// The intake queue: referrals TO the programme (server/incoming-referrals.js has the model, the workflow and the
// visibility and Part 2 decisions). Every read and write of a referral is audited by id, status and field names only.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const IR = require('../incoming-referrals');
const { validate, paging } = require('../validate');
const { uuid, blindIndex } = require('../crypto');
const { badRequest, notFound, conflict, HttpError } = require('../http');

// Five minutes' grace for a clock a little ahead of the server's.
const FUTURE_GRACE_MS = 5 * 60_000;
const notFuture = (field, iso) => { if (iso && Date.parse(iso) > Date.now() + FUTURE_GRACE_MS) throw badRequest('Validation failed', { fields: { [field]: 'cannot be in the future' } }); };

function officeOnly(ctx) {
  if (IR.keptHere()) return;
  throw new HttpError(403, IR.OFFICE_ONLY, { officeOnly: true });
}
const guard = (ctx) => { officeOnly(ctx); };

function load(id) {
  const row = db.one(`SELECT * FROM incoming_referrals WHERE id=?`, id);
  if (!row) throw notFound('Referral not found');
  return row;
}
/**
 * An open referral is nobody's client yet, so the whole queue sees it (intake is a shared desk). An accepted one has
 * become a client's record: a person held to their caseload sees it only when that client is on it, as they would the
 * client (review of the 1.24.0 tree: the queue showed the name, date of birth, phone, reasons, notes and attempts of
 * every accepted referral, the client's id and code included, to a navigator who could not open the client).
 * visibleFilter is the same rule as SQL, for the list.
 */
function visibleFilter(user) {
  if (!auth.hasPerm(user, 'clients:read')) return { sql: 'client_id IS NULL', params: [] }; // canAccessClient opens no client for them
  const f = auth.caseloadFilter(user, 'client_id');
  return f.sql === '1=1' ? f : { sql: `(client_id IS NULL OR ${f.sql})`, params: f.params };
}
function assertVisible(ctx, row) {
  if (row.client_id) auth.assertClientAccess(ctx, row.client_id);
}
function assertOpen(row) {
  if (!IR.OPEN.includes(row.status)) throw conflict(row.status === 'accepted' ? 'This referral was accepted and is closed' : 'This referral is closed. Reopen it first.');
}

/** An assignee is an active account that may work the queue. */
function checkAssignee(id) {
  if (!id) return;
  const u = db.one(`SELECT id, role, is_active, access_status FROM users WHERE id=?`, id);
  if (!u || !u.is_active || (u.access_status && u.access_status !== 'active')) throw badRequest('Validation failed', { fields: { assigned_to: 'is not an active account' } });
  if (!auth.hasPerm({ id: u.id, role: u.role }, 'intake:read')) throw badRequest('Validation failed', { fields: { assigned_to: 'cannot see incoming referrals' } });
}

/** A name, or a phone number in its place: someone the programme can try to reach. */
function checkPerson(v, row = null) {
  const val = (k) => (v[k] !== undefined ? v[k] : row ? IR.matchDetails(row)[k] : undefined);
  if (!String(val('first_name') || '').trim() && !String(val('last_name') || '').trim() && !String(val('phone') || '').trim()) {
    throw badRequest('Give the person\'s name, or a phone number to reach them on', { fields: { last_name: 'is required unless a first name or phone is given' } });
  }
  if (v.dob && v.dob > require('../local-date').today()) throw badRequest('Validation failed', { fields: { dob: 'cannot be in the future' } });
  notFuture('received_at', v.received_at);
}

function update(id, cols) {
  const keys = Object.keys(cols);
  db.run(`UPDATE incoming_referrals SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => cols[k]), db.now(), id);
}

module.exports = (r) => {
  const read = [auth.requireAuth, auth.requirePerm('intake:read'), guard];
  // Working the queue needs seeing it: a person denied intake:read records nothing into it.
  const write = [auth.requireAuth, auth.requirePerm('intake:write'), auth.requirePerm('intake:read'), guard];

  // The queue, filtered: status (open = new and contacting, the default; closed; all; or one status), assignee (me,
  // none, or an account id), urgency, and q (a surname, matched on its blind index, or the referring organisation).
  r.get('/api/incoming-referrals', ...read, (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 100, max: 500 });
    const status = ctx.query.get('status') || 'open';
    const assignee = ctx.query.get('assigned_to') || '';
    const urgency = ctx.query.get('urgency') || '';
    const q = (ctx.query.get('q') || '').trim();
    const where = []; const params = [];
    if (status === 'open') where.push(`status IN ('new','contacting')`);
    else if (status === 'closed') where.push(`status NOT IN ('new','contacting')`);
    else if (status !== 'all') { if (!IR.STATUSES.includes(status)) throw badRequest('Unknown status'); where.push('status=?'); params.push(status); }
    if (assignee === 'me') { where.push('assigned_to=?'); params.push(ctx.user.id); }
    else if (assignee === 'none') where.push('assigned_to IS NULL');
    else if (assignee) { where.push('assigned_to=?'); params.push(assignee); }
    if (urgency) { if (!IR.URGENCY.includes(urgency)) throw badRequest('Unknown urgency'); where.push('urgency=?'); params.push(urgency); }
    if (q) { where.push(`(last_name_idx=? OR referring_org LIKE ? ESCAPE '\\')`); params.push(blindIndex(q), `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
    const seen = visibleFilter(ctx.user); if (seen.sql !== '1=1') { where.push(seen.sql); params.push(...seen.params); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // Open: the urgent first, then the longest waiting. Otherwise the newest first.
    const order = status === 'open' || status === 'new' || status === 'contacting'
      ? `CASE urgency WHEN 'urgent' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END, received_at`
      : `COALESCE(closed_at, received_at) DESC`;
    const rows = db.all(`SELECT * FROM incoming_referrals ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = db.one(`SELECT COUNT(*) n FROM incoming_referrals ${w}`, ...params).n;
    audit.log({ user: ctx.user, action: 'incoming_referral.list', entity: 'incoming_referral', ip: ctx.ip, details: { status, assigned_to: assignee || undefined, urgency: urgency || undefined, q: q ? '[redacted]' : undefined, count: rows.length, offset: offset || undefined } });
    return { rows: rows.map(IR.present), total, limit, offset };
  });

  // Counts for Home and Supervision, and time to first contact. Nobody named, so not an access to anyone's record.
  r.get('/api/incoming-referrals/summary', ...read, (ctx) => {
    const days = Math.min(365, Math.max(7, Number(ctx.query.get('days')) || 90));
    return IR.summary(ctx.user, { days });
  });

  r.post('/api/incoming-referrals', ...write, (ctx) => {
    const v = validate(ctx.body, IR.shape({ create: true }));
    checkPerson(v);
    checkAssignee(v.assigned_to);
    const id = uuid();
    const cols = { id, ...IR.toColumns(v), received_at: v.received_at || db.now(), urgency: v.urgency || 'routine', status: 'new', created_by: ctx.user.id };
    const keys = Object.keys(cols);
    db.run(`INSERT INTO incoming_referrals(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
    audit.log({ user: ctx.user, action: 'incoming_referral.create', entity: 'incoming_referral', entityId: id, ip: ctx.ip, details: { source_type: v.source_type, received_via: v.received_via, urgency: cols.urgency, fields: Object.keys(v).filter(k => v[k] !== null && v[k] !== undefined && k !== 'assigned_to'), assigned_to: v.assigned_to || undefined } });
    ctx.status = 201;
    return { id, row: IR.present(load(id)) };
  });

  r.get('/api/incoming-referrals/:id', ...read, (ctx) => {
    const row = load(ctx.params.id);
    assertVisible(ctx, row);
    audit.log({ user: ctx.user, action: 'incoming_referral.read', entity: 'incoming_referral', entityId: row.id, clientId: row.client_id || undefined, ip: ctx.ip, details: { status: row.status } });
    return { row: IR.present(row), attempts: IR.attempts(row.id), may: { write: auth.hasPerm(ctx.user, 'intake:write'), link: auth.hasPerm(ctx.user, 'clients:read'), create_client: auth.hasPerm(ctx.user, 'clients:write') } };
  });

  // Change an open referral's details or its assignee (assigned_to: null to unassign).
  r.put('/api/incoming-referrals/:id', ...write, (ctx) => {
    const row = load(ctx.params.id);
    assertOpen(row);
    const v = validate(ctx.body, IR.shape(), { partial: true });
    if (v.source_type === null || v.received_via === null) throw badRequest('Validation failed', { fields: { [v.source_type === null ? 'source_type' : 'received_via']: 'required' } });
    if (v.received_at === null) delete v.received_at;
    if (v.urgency === null) v.urgency = 'routine';
    checkPerson(v, row);
    if (v.assigned_to !== undefined) checkAssignee(v.assigned_to);
    const cols = IR.toColumns(v);
    if (!Object.keys(cols).length) return { row: IR.present(row) };
    update(row.id, cols);
    const fields = Object.keys(v).filter(k => k !== 'assigned_to');
    if (fields.length) audit.log({ user: ctx.user, action: 'incoming_referral.update', entity: 'incoming_referral', entityId: row.id, ip: ctx.ip, details: { fields } });
    if (v.assigned_to !== undefined && (v.assigned_to || null) !== row.assigned_to) audit.log({ user: ctx.user, action: 'incoming_referral.assign', entity: 'incoming_referral', entityId: row.id, ip: ctx.ip, details: { assigned_to: v.assigned_to || null, was: row.assigned_to || null } });
    return { row: IR.present(load(row.id)) };
  });

  // An attempt to reach the person. The first one starts the clock's end (first_contact_at) and moves a new referral
  // to contacting.
  r.post('/api/incoming-referrals/:id/attempts', ...write, (ctx) => {
    const row = load(ctx.params.id);
    assertOpen(row);
    const v = validate(ctx.body, { attempted_at: { type: 'datetime' }, method: { type: 'string', enum: IR.ATTEMPT_METHODS, required: true }, outcome: { type: 'string', enum: IR.ATTEMPT_OUTCOMES, required: true }, notes: { type: 'string', maxLen: 2000 } });
    const at = v.attempted_at && /T/.test(v.attempted_at) ? v.attempted_at : v.attempted_at ? new Date(v.attempted_at).toISOString() : db.now();
    notFuture('attempted_at', at);
    if (Date.parse(at) < Date.parse(row.received_at) - FUTURE_GRACE_MS) throw badRequest('Validation failed', { fields: { attempted_at: 'is before the referral was received' } });
    const id = uuid();
    db.transaction(() => {
      db.run(`INSERT INTO incoming_referral_attempts(id,referral_id,attempted_at,method,outcome,notes_enc,user_id) VALUES(?,?,?,?,?,?,?)`, id, row.id, at, v.method, v.outcome, v.notes ? require('../crypto').encrypt(v.notes) : null, ctx.user.id);
      const first = !row.first_contact_at || Date.parse(at) < Date.parse(row.first_contact_at) ? at : row.first_contact_at;
      update(row.id, { first_contact_at: first, status: row.status === 'new' ? 'contacting' : row.status });
    });
    audit.log({ user: ctx.user, action: 'incoming_referral.attempt', entity: 'incoming_referral', entityId: row.id, ip: ctx.ip, details: { attempt: id, method: v.method, outcome: v.outcome, first: !row.first_contact_at, status: row.status === 'new' ? 'contacting' : row.status } });
    ctx.status = 201;
    return { id, row: IR.present(load(row.id)), attempts: IR.attempts(row.id) };
  });

  // Existing clients who may be this person (the intake duplicate check, on the referral's own details): only the
  // records the caller may open are shown, and none they may not is counted, as at intake (server/routes/clients.js).
  r.get('/api/incoming-referrals/:id/matches', ...write, auth.requirePerm('clients:read'), (ctx) => {
    const row = load(ctx.params.id);
    assertVisible(ctx, row);
    const C = require('./clients');
    if (!require('../app').rateLimit(`duplicate-check:${ctx.user.id}`, C.DUPLICATE_CHECKS, C.DUPLICATE_CHECK_WINDOW_MS)) {
      audit.log({ user: ctx.user, action: 'client.duplicate_check', ip: ctx.ip, success: false, details: { reason: 'rate limited', source: 'incoming_referral' } });
      throw new HttpError(429, 'Too many duplicate checks. Wait a few minutes, or search for the client by name.');
    }
    const d = IR.matchDetails(row);
    const all = C.possibleDuplicates(d);
    const matches = all.filter(m => C.mayOpen(ctx.user, m.id));
    audit.log({ user: ctx.user, action: 'client.duplicate_check', entity: 'incoming_referral', entityId: row.id, ip: ctx.ip, details: { source: 'incoming_referral', asked: Object.keys(d).filter(k => d[k]), matches: all.length, hidden: all.length - matches.length, shown: matches.map(m => m.client_code) } });
    return { matches };
  });

  // Accept: the referral becomes (or joins) a client record the caller may open. client_id is an existing record
  // (chosen from the duplicate check or the client search) or the one just made from the referral (POST /api/clients
  // with the referral's details, its own duplicate check included): accepted_as says which, from the record itself.
  r.post('/api/incoming-referrals/:id/accept', ...write, auth.requirePerm('clients:read'), (ctx) => {
    const row = load(ctx.params.id);
    assertOpen(row);
    const v = validate(ctx.body, { client_id: { type: 'string', required: true, maxLen: 64 } });
    const client = db.one(`SELECT id, client_code, created_at, created_by, deleted_at, merged_into FROM clients WHERE id=?`, v.client_id);
    if (!client || client.deleted_at) throw badRequest('Validation failed', { fields: { client_id: 'is not a client record' } });
    if (client.merged_into) throw badRequest('That record was merged into another client: choose the one it was merged into', { merged_into: client.merged_into });
    auth.assertClientAccess(ctx, client.id);
    const asNew = client.created_by === ctx.user.id && Date.parse(client.created_at) > Date.parse(row.created_at)
      && !db.one(`SELECT 1 x FROM incoming_referrals WHERE client_id=? AND id<>?`, client.id, row.id);
    const at = db.now();
    update(row.id, { status: 'accepted', client_id: client.id, accepted_as: asNew ? 'new' : 'existing', closed_at: at, closed_by: ctx.user.id });
    audit.log({ user: ctx.user, action: 'incoming_referral.accept', entity: 'incoming_referral', entityId: row.id, clientId: client.id, ip: ctx.ip, details: { client_code: client.client_code, accepted_as: asNew ? 'new' : 'existing', from: row.status } });
    return { row: IR.present(load(row.id)) };
  });

  // Close without a client: declined (why), unable to reach, or referred elsewhere (to whom).
  r.post('/api/incoming-referrals/:id/close', ...write, (ctx) => {
    const row = load(ctx.params.id);
    assertOpen(row);
    const v = validate(ctx.body, { status: { type: 'string', enum: IR.CLOSE_STATUSES, required: true }, reason: { type: 'string', maxLen: 2000 } });
    if (!v.reason && v.status !== 'unable_to_reach') throw badRequest('Validation failed', { fields: { reason: v.status === 'declined' ? 'say why it was declined' : 'say where they were referred' } });
    update(row.id, { status: v.status, outcome_reason_enc: v.reason ? require('../crypto').encrypt(v.reason) : null, closed_at: db.now(), closed_by: ctx.user.id });
    audit.log({ user: ctx.user, action: 'incoming_referral.close', entity: 'incoming_referral', entityId: row.id, ip: ctx.ip, details: { status: v.status, from: row.status, reason_given: !!v.reason } });
    return { row: IR.present(load(row.id)) };
  });

  // Reopen a referral closed without a client (a decline recorded by mistake, the person called back). An accepted
  // one stays accepted: its client record carries on from there.
  r.post('/api/incoming-referrals/:id/reopen', ...write, (ctx) => {
    const row = load(ctx.params.id);
    if (IR.OPEN.includes(row.status)) throw conflict('This referral is already open');
    if (row.status === 'accepted') throw conflict('This referral was accepted and is closed: carry on in the client\'s record');
    const status = row.first_contact_at ? 'contacting' : 'new';
    update(row.id, { status, closed_at: null, closed_by: null, outcome_reason_enc: null });
    audit.log({ user: ctx.user, action: 'incoming_referral.reopen', entity: 'incoming_referral', entityId: row.id, ip: ctx.ip, details: { from: row.status, status } });
    return { row: IR.present(load(row.id)) };
  });
};

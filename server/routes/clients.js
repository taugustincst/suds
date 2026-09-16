'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, notFound, forbidden } = require('../http');
const { validate, paging } = require('../validate');
const { blindIndex, uuid, decrypt } = require('../crypto');
const M = require('../clients-model');

const shape = {
  first_name: { type: 'string', required: true, maxLen: 100 }, last_name: { type: 'string', required: true, maxLen: 100 },
  preferred_name: { type: 'string', maxLen: 100 }, dob: { type: 'date' }, phone: { type: 'string', maxLen: 40 }, alt_phone: { type: 'string', maxLen: 40 },
  email: { type: 'string', maxLen: 200 }, address: { type: 'string', maxLen: 300 }, city: { type: 'string', maxLen: 100 }, zip: { type: 'string', maxLen: 12 },
  gender: { type: 'string', maxLen: 40 }, pronouns: { type: 'string', maxLen: 40 }, race_ethnicity: { type: 'string', maxLen: 100 }, preferred_language: { type: 'string', maxLen: 60 },
  veteran: { type: 'boolean' }, housing_status: { type: 'string', maxLen: 60 }, insurance: { type: 'string', maxLen: 100 }, medicaid_id: { type: 'string', maxLen: 40 },
  emergency_contact: { type: 'string', maxLen: 300 },
  status: { type: 'string', enum: ['waitlist', 'active', 'inactive', 'closed', 'deceased'] }, intake_date: { type: 'date' }, discharge_date: { type: 'date' }, discharge_reason: { type: 'string', maxLen: 200 },
  referral_source: { type: 'string', maxLen: 120 }, primary_substance: { type: 'string', maxLen: 60 }, secondary_substances: { type: 'string', maxLen: 200 }, route_of_use: { type: 'string', maxLen: 60 },
  asam_level: { type: 'string', maxLen: 20 }, mat_status: { type: 'string', enum: ['none', 'interested', 'referred', 'active', 'discontinued', 'unknown'] }, mat_medication: { type: 'string', maxLen: 60 },
  overdose_history: { type: 'boolean' }, last_overdose_date: { type: 'date' }, naloxone_provided: { type: 'boolean' }, naloxone_last_date: { type: 'date' },
  risk_level: { type: 'string', enum: ['low', 'moderate', 'high', 'critical'] }, justice_involved: { type: 'boolean' }, pregnant_or_parenting: { type: 'boolean' }, co_occurring_mh: { type: 'boolean' },
  goals: { type: 'string', maxLen: 2000 }, flags: { type: 'string', maxLen: 300 }, contact_preferences: { type: 'string', maxLen: 300 }, ok_to_text: { type: 'boolean' }, ok_to_voicemail: { type: 'boolean' },
};

function loadClient(ctx, id, { write = false } = {}) {
  const row = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL`, id);
  if (!row) throw notFound('Client not found');
  auth.assertClientAccess(ctx, id);
  return row;
}

module.exports = (r) => {
  r.get('/api/clients', auth.requireAuth, auth.requirePerm('clients:read', 'clients:list-deidentified'), (ctx) => {
    const deidentify = !auth.hasPerm(ctx.user, 'clients:read');
    const { limit, offset } = paging(ctx.query);
    const where = ['c.deleted_at IS NULL']; const params = [];
    const cf = auth.caseloadFilter(ctx.user); where.push(cf.sql); params.push(...cf.params);
    const status = ctx.query.get('status');
    if (status && status !== 'all') { where.push('c.status=?'); params.push(status); }
    const q = (ctx.query.get('q') || '').trim();
    if (q) {
      if (/^C\d{2}-\d+$/i.test(q)) { where.push('c.client_code=?'); params.push(q.toUpperCase()); }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(q)) { where.push('c.dob_idx=?'); params.push(blindIndex(q)); }
      else if (/^[\d\-() .+]{7,}$/.test(q)) { where.push('c.phone_idx=?'); params.push(blindIndex(q.replace(/\D/g, ''))); }
      else {
        // last name exact (blind index) OR "last, first" / "first last"
        const parts = q.split(/[,\s]+/).filter(Boolean);
        const idxs = parts.map(p => blindIndex(p));
        where.push(`(c.last_name_idx IN (${idxs.map(() => '?').join(',')}) OR c.full_name_idx IN (?,?))`);
        params.push(...idxs, blindIndex(parts.join('')), blindIndex([...parts].reverse().join('')));
      }
    }
    const assigned = ctx.query.get('assigned_to');
    if (assigned) { where.push(`c.id IN (SELECT client_id FROM assignments WHERE user_id=? AND (end_date IS NULL OR end_date >= date('now')))`); params.push(assigned); }
    const w = 'WHERE ' + where.join(' AND ');
    const rows = db.all(`SELECT c.*, (SELECT GROUP_CONCAT(u.display_name, ', ') FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.client_id=c.id AND (a.end_date IS NULL OR a.end_date >= date('now'))) AS assigned_workers,
      (SELECT MAX(occurred_at) FROM interventions i WHERE i.client_id=c.id) AS last_contact
      FROM clients c ${w} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = db.one(`SELECT COUNT(*) n FROM clients c ${w}`, ...params).n;
    audit.log({ user: ctx.user, action: 'client.list', ip: ctx.ip, details: { q: q ? '[redacted]' : '', status, count: rows.length, deidentified: deidentify } });
    return { clients: rows.map(x => ({ ...M.summary(x, { deidentify }), assigned_workers: x.assigned_workers, last_contact: x.last_contact })), total, limit, offset };
  });

  r.post('/api/clients', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    const v = validate(ctx.body, shape);
    const id = uuid();
    const enc = M.encryptFields(v);
    enc.full_name_idx = blindIndex((v.last_name || '') + (v.first_name || ''));
    const cols = { id, client_code: M.nextClientCode(), ...enc, created_by: ctx.user.id };
    for (const f of M.PLAIN_FIELDS) if (v[f] !== undefined) cols[f] = v[f];
    if (!cols.intake_date) cols.intake_date = new Date().toISOString().slice(0, 10);
    const keys = Object.keys(cols).filter(k => cols[k] !== undefined);
    db.transaction(() => {
      db.run(`INSERT INTO clients(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
      // auto-assign creator if they are a caseload-restricted worker
      if (auth.caseloadRestricted(ctx.user) || ['navigator', 'clinician'].includes(ctx.user.role)) {
        db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, uuid(), id, ctx.user.id, 'primary', cols.intake_date, ctx.user.id);
      }
    });
    audit.log({ user: ctx.user, action: 'client.create', entity: 'client', entityId: id, clientId: id, ip: ctx.ip });
    ctx.status = 201;
    return { id, client_code: cols.client_code };
  });

  r.get('/api/clients/:id', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    const client = M.decryptRow(row);
    client.assignments = db.all(`SELECT a.*, u.display_name, u.role AS user_role FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.client_id=? ORDER BY a.end_date IS NOT NULL, a.start_date DESC`, row.id);
    client.active_consents = db.all(`SELECT id,type,recipient,purpose,signed_at,expires_at FROM consents WHERE client_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now'))`, row.id);
    client.counts = {
      interventions: db.one(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, row.id).n,
      calls: db.one(`SELECT COUNT(*) n FROM calls WHERE client_id=?`, row.id).n,
      notes: db.one(`SELECT COUNT(*) n FROM notes WHERE client_id=? AND deleted_at IS NULL`, row.id).n,
      referrals: db.one(`SELECT COUNT(*) n FROM referrals WHERE client_id=?`, row.id).n,
      open_tasks: db.one(`SELECT COUNT(*) n FROM tasks WHERE client_id=? AND status IN ('open','in_progress')`, row.id).n,
      minutes: db.one(`SELECT COALESCE(SUM(minutes),0) n FROM time_entries WHERE client_id=?`, row.id).n,
      spent: db.one(`SELECT COALESCE(SUM(amount),0) n FROM expenditures WHERE client_id=? AND status<>'rejected'`, row.id).n,
    };
    audit.log({ user: ctx.user, action: 'client.view', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip });
    return { client };
  });

  r.put('/api/clients/:id', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    const v = validate(ctx.body, { ...shape, first_name: { ...shape.first_name, required: false }, last_name: { ...shape.last_name, required: false } }, { partial: true });
    const enc = M.encryptFields(v);
    if (v.first_name !== undefined || v.last_name !== undefined) {
      const cur = M.decryptRow(row);
      enc.full_name_idx = blindIndex((v.last_name ?? cur.last_name ?? '') + (v.first_name ?? cur.first_name ?? ''));
    }
    const cols = { ...enc };
    for (const f of M.PLAIN_FIELDS) if (v[f] !== undefined) cols[f] = v[f];
    const keys = Object.keys(cols).filter(k => cols[k] !== undefined);
    if (!keys.length) return { ok: true };
    db.run(`UPDATE clients SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => cols[k]), db.now(), row.id);
    audit.log({ user: ctx.user, action: 'client.update', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, details: { fields: Object.keys(v) } });
    return { ok: true };
  });

  r.delete('/api/clients/:id', auth.requireAuth, auth.requirePerm('clients:all'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, 'clients:write')) throw forbidden();
    const { reason } = validate(ctx.body || {}, { reason: { type: 'string', required: true, maxLen: 300 } });
    db.run(`UPDATE clients SET deleted_at=?, updated_at=? WHERE id=?`, db.now(), db.now(), row.id);
    audit.log({ user: ctx.user, action: 'client.delete', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, details: { reason } });
    return { ok: true };
  });

  // Unified timeline for a client: interventions, calls, notes (metadata only), referrals, tasks/milestones, consents, expenditures
  r.get('/api/clients/:id/timeline', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    const id = row.id;
    const canClinical = auth.hasPerm(ctx.user, 'notes:clinical:read');
    const events = [];
    for (const x of db.all(`SELECT i.*, u.display_name AS worker FROM interventions i JOIN users u ON u.id=i.user_id WHERE client_id=?`, id))
      events.push({ kind: 'intervention', id: x.id, at: x.occurred_at, title: x.type.replace(/_/g, ' '), detail: x.summary, worker: x.worker, meta: { duration: x.duration_minutes, outcome: x.outcome, location: x.location } });
    for (const x of db.all(`SELECT c.*, u.display_name AS worker FROM calls c JOIN users u ON u.id=c.user_id WHERE client_id=?`, id))
      events.push({ kind: 'call', id: x.id, at: x.started_at, title: `${x.direction} call (${x.contact_type})`, detail: x.summary_enc ? decrypt(x.summary_enc) : x.purpose, worker: x.worker, meta: { duration: x.duration_minutes, outcome: x.outcome, crisis: !!x.crisis } });
    for (const x of db.all(`SELECT n.id,n.kind,n.format,n.title,n.occurred_at,n.status,n.source,u.display_name AS worker FROM notes n JOIN users u ON u.id=n.author_id WHERE client_id=? AND deleted_at IS NULL`, id))
      if (x.kind === 'admin' || canClinical) events.push({ kind: 'note', id: x.id, at: x.occurred_at, title: `${x.kind} note: ${x.title || x.format}`, detail: null, worker: x.worker, meta: { status: x.status, note_kind: x.kind, source: x.source } });
    for (const x of db.all(`SELECT r.*, res.name AS resource_name, u.display_name AS worker FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN users u ON u.id=r.user_id WHERE client_id=?`, id))
      events.push({ kind: 'referral', id: x.id, at: x.referred_at, title: `Referral: ${x.resource_name}`, detail: x.notes, worker: x.worker, meta: { status: x.status, outcome: x.outcome } });
    for (const x of db.all(`SELECT t.*, u.display_name AS worker FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE client_id=?`, id))
      events.push({ kind: x.is_milestone ? 'milestone' : 'task', id: x.id, at: x.completed_at || x.due_at || x.created_at, title: x.title, detail: x.description, worker: x.worker, meta: { status: x.status, priority: x.priority, due_at: x.due_at } });
    for (const x of db.all(`SELECT * FROM consents WHERE client_id=?`, id))
      events.push({ kind: 'consent', id: x.id, at: x.signed_at, title: `Consent: ${x.type.replace(/_/g, ' ')}${x.recipient ? ' → ' + x.recipient : ''}`, detail: x.purpose, meta: { expires_at: x.expires_at, revoked_at: x.revoked_at } });
    if (auth.hasPerm(ctx.user, 'budget:read'))
      for (const x of db.all(`SELECT e.*, f.name AS fund FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE client_id=?`, id))
        events.push({ kind: 'expense', id: x.id, at: x.spent_at, title: `$${x.amount.toFixed(2)} ${x.category.replace(/_/g, ' ')}`, detail: x.description, meta: { fund: x.fund, status: x.status } });
    events.push({ kind: 'milestone', id: 'intake', at: row.intake_date, title: 'Program intake', meta: {} });
    if (row.discharge_date) events.push({ kind: 'milestone', id: 'discharge', at: row.discharge_date, title: `Discharge: ${row.discharge_reason || ''}`, meta: {} });
    events.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    audit.log({ user: ctx.user, action: 'client.timeline', entity: 'client', entityId: id, clientId: id, ip: ctx.ip });
    return { events };
  });
};

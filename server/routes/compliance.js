'use strict';
// The privacy officer's two registers: complaints (42 CFR §2.4 — a patient may complain to the programme
// and to HHS, and may not be retaliated against) and privacy/security incidents, with the breach
// notification clock the 2024 Part 2 rule applies to them (server/incidents.js). Both are held by
// supervisors and administrators only, audited on every read and write, and never synchronised to devices.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const crud = require('../crud');
const incidents = require('../incidents');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { encrypt, decrypt, uuid } = require('../crypto');

const CHANNELS = ['in_person', 'phone', 'mail', 'email', 'web', 'other'];
const COMPLAINANTS = ['client', 'representative', 'staff', 'anonymous', 'other'];
const COMPLAINT_STATUSES = ['open', 'investigating', 'resolved', 'closed'];
const DETERMINATIONS = ['pending', 'breach', 'not_breach'];
const MIN_REASON = 20;

const dec = (v) => (v ? decrypt(v) : null);
function encComplaint(v) {
  for (const f of ['summary', 'resolution']) if (v[f] !== undefined) { v[`${f}_enc`] = v[f] ? encrypt(v[f]) : null; delete v[f]; }
}

// ---- incidents ----
const INCIDENT_ENC = ['description', 'risk_nature', 'risk_recipient', 'risk_acquired', 'risk_mitigation', 'determination_reason'];
const INCIDENT_SHAPE = {
  title: { type: 'string', maxLen: 200 }, discovered_at: { type: 'date' }, occurred_at: { type: 'date' }, description: { type: 'string', maxLen: 8000 },
  part2_records: { type: 'boolean' }, affected_count: { type: 'number', integer: true, min: 0, max: 100000000 }, max_in_one_state: { type: 'number', integer: true, min: 0, max: 100000000 },
  risk_nature: { type: 'string', maxLen: 4000 }, risk_recipient: { type: 'string', maxLen: 4000 }, risk_acquired: { type: 'string', maxLen: 4000 }, risk_mitigation: { type: 'string', maxLen: 4000 },
  determination: { type: 'string', enum: DETERMINATIONS }, determination_reason: { type: 'string', maxLen: 4000 }, law_enforcement_delay_until: { type: 'date' },
  individuals_notified_at: { type: 'date' }, hhs_notified_at: { type: 'date' }, media_notified_at: { type: 'date' }, status: { type: 'string', enum: ['open', 'closed'] },
};
function presentIncident(row, { full = false } = {}) {
  const out = { ...row };
  for (const f of INCIDENT_ENC) { if (full) out[f] = dec(row[`${f}_enc`]); delete out[`${f}_enc`]; }
  out.obligations = incidents.obligations(row);
  return out;
}
function loadIncident(id) { const i = db.one(`SELECT * FROM privacy_incidents WHERE id=?`, id); if (!i) throw notFound('Incident not found'); return i; }

module.exports = (r) => {
  crud.build(r, {
    table: 'complaints', entity: 'complaint', base: '/api/complaints', perm: 'complaints', clientRequired: false,
    dateCol: 'received_at', ownerCol: 'handled_by', creatorCol: 'created_by',
    order: `CASE complaints.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END, complaints.received_at DESC`,
    joins: 'LEFT JOIN clients c ON c.id=complaints.client_id LEFT JOIN users u ON u.id=complaints.handled_by',
    select: 'complaints.*, c.client_code, u.display_name AS handler',
    shape: {
      client_id: { type: 'string' }, received_at: { type: 'date', required: true }, channel: { type: 'string', enum: CHANNELS }, complainant: { type: 'string', enum: COMPLAINANTS },
      summary: { type: 'string', required: true, maxLen: 4000 }, status: { type: 'string', enum: COMPLAINT_STATUSES }, resolution: { type: 'string', maxLen: 4000 }, resolved_at: { type: 'date' },
      hhs_referral_given: { type: 'boolean' }, retaliation_reviewed: { type: 'boolean' }, handled_by: { type: 'string' },
    },
    filters: (ctx, where, params) => { const s = ctx.query.get('status'); if (s === 'open') where.push(`complaints.status IN ('open','investigating')`); else if (s && s !== 'all') { where.push('complaints.status=?'); params.push(s); } },
    beforeInsert: (ctx, v) => {
      if (v.complainant === 'anonymous' && v.client_id) throw badRequest('An anonymous complaint cannot name the client; record it without one');
      if (['resolved', 'closed'].includes(v.status) && !v.resolution) throw badRequest('Say how the complaint was resolved before closing it');
      if (['resolved', 'closed'].includes(v.status) && !v.resolved_at) v.resolved_at = new Date().toISOString().slice(0, 10);
      encComplaint(v);
    },
    beforeUpdate: (ctx, v, row) => {
      for (const k of ['received_at', 'channel', 'complainant', 'status', 'hhs_referral_given', 'retaliation_reviewed']) if (v[k] === null) delete v[k];
      if (v.summary === null) throw badRequest('A complaint needs its summary');
      const closing = ['resolved', 'closed'].includes(v.status) && !['resolved', 'closed'].includes(row.status);
      if (closing && !v.resolution && !row.resolution_enc) throw badRequest('Say how the complaint was resolved before closing it');
      if (closing && !v.resolved_at) v.resolved_at = new Date().toISOString().slice(0, 10);
      if (v.status && ['open', 'investigating'].includes(v.status)) v.resolved_at = null;
      encComplaint(v);
    },
    afterLoad: (ctx, row) => ({ ...row, summary: dec(row.summary_enc), resolution: dec(row.resolution_enc), summary_enc: undefined, resolution_enc: undefined }),
    // A complaint is part of the programme's record of how it answered it: closed, never deleted.
    canDelete: () => false,
  });
  // How complaints were handled over a period: counts only.
  r.get('/api/complaints/report', auth.requireAuth, auth.requirePerm('complaints:read', 'complaints:write'), (ctx) => {
    const from = ctx.query.get('from') || `${new Date().getUTCFullYear()}-01-01`; const to = ctx.query.get('to') || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest('from and to must be YYYY-MM-DD');
    const w = `received_at BETWEEN ? AND ?`;
    const by = (col) => db.all(`SELECT ${col} k, COUNT(*) n FROM complaints WHERE ${w} GROUP BY ${col} ORDER BY n DESC`, from, to);
    const days = db.all(`SELECT julianday(resolved_at)-julianday(received_at) d FROM complaints WHERE ${w} AND resolved_at IS NOT NULL ORDER BY d`, from, to).map(x => x.d);
    const out = {
      from, to, total: db.one(`SELECT COUNT(*) n FROM complaints WHERE ${w}`, from, to).n,
      open: db.one(`SELECT COUNT(*) n FROM complaints WHERE ${w} AND status IN ('open','investigating')`, from, to).n,
      by_status: by('status'), by_channel: by('channel'), by_complainant: by('complainant'),
      hhs_referral_given: db.one(`SELECT COUNT(*) n FROM complaints WHERE ${w} AND hhs_referral_given=1`, from, to).n,
      retaliation_reviewed: db.one(`SELECT COUNT(*) n FROM complaints WHERE ${w} AND retaliation_reviewed=1`, from, to).n,
      median_days_to_resolve: days.length ? Math.round(days[Math.floor(days.length / 2)]) : null,
    };
    audit.log({ user: ctx.user, action: 'complaint.report', ip: ctx.ip, details: { from, to, total: out.total } });
    return out;
  });

  // ---- incident register ----
  r.get('/api/incidents', auth.requireAuth, auth.requirePerm('incidents:read', 'incidents:write'), (ctx) => {
    const s = ctx.query.get('status');
    const rows = db.all(`SELECT i.*, (SELECT COUNT(*) FROM privacy_incident_clients x WHERE x.incident_id=i.id) linked_clients FROM privacy_incidents i ${s && s !== 'all' ? 'WHERE i.status=?' : ''} ORDER BY i.status='open' DESC, i.discovered_at DESC LIMIT 500`, ...(s && s !== 'all' ? [s] : []))
      .map(x => presentIncident(x));
    audit.log({ user: ctx.user, action: 'incident.list', ip: ctx.ip, details: { count: rows.length } });
    return { rows, thresholds: { notice_days: incidents.NOTICE_DAYS, hhs_immediate_at: incidents.HHS_IMMEDIATE_AT, media_over: incidents.MEDIA_OVER } };
  });
  r.get('/api/incidents/:id', auth.requireAuth, auth.requirePerm('incidents:read', 'incidents:write'), (ctx) => {
    const i = loadIncident(ctx.params.id);
    const clients = db.all(`SELECT x.client_id, x.notified_at, c.client_code FROM privacy_incident_clients x JOIN clients c ON c.id=x.client_id WHERE x.incident_id=? ORDER BY c.client_code`, i.id);
    audit.log({ user: ctx.user, action: 'incident.view', entity: 'privacy_incident', entityId: i.id, ip: ctx.ip, details: { linked_clients: clients.length } });
    return { row: { ...presentIncident(i, { full: true }), clients } };
  });
  r.post('/api/incidents', auth.requireAuth, auth.requirePerm('incidents:write'), (ctx) => {
    const v = validate(ctx.body, { ...INCIDENT_SHAPE, title: { ...INCIDENT_SHAPE.title, required: true }, discovered_at: { type: 'date', required: true } });
    if (v.discovered_at > new Date().toISOString().slice(0, 10)) throw badRequest('An incident cannot be discovered in the future');
    const id = uuid();
    const cols = { id, title: v.title, discovered_at: v.discovered_at, occurred_at: v.occurred_at || null, part2_records: v.part2_records === undefined ? 1 : v.part2_records,
      affected_count: v.affected_count || 0, max_in_one_state: v.max_in_one_state || 0, reported_by: ctx.user.id, source: 'manual' };
    for (const f of INCIDENT_ENC) if (v[f]) cols[`${f}_enc`] = encrypt(v[f]);
    const keys = Object.keys(cols);
    db.run(`INSERT INTO privacy_incidents(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
    audit.log({ user: ctx.user, action: 'incident.create', entity: 'privacy_incident', entityId: id, ip: ctx.ip });
    ctx.status = 201; return { id, obligations: incidents.obligations(loadIncident(id)) };
  });
  r.put('/api/incidents/:id', auth.requireAuth, auth.requirePerm('incidents:write'), (ctx) => {
    const i = loadIncident(ctx.params.id);
    const v = validate(ctx.body, INCIDENT_SHAPE, { partial: true });
    // A form sends every field: a cleared count is zero, and a cleared title, date or choice keeps what it had.
    for (const k of ['affected_count', 'max_in_one_state']) if (v[k] === null) v[k] = 0;
    for (const k of ['title', 'discovered_at', 'determination', 'status', 'part2_records']) if (v[k] === null) delete v[k];
    const merged = { ...i }; for (const [k, x] of Object.entries(v)) merged[INCIDENT_ENC.includes(k) ? `${k}_enc` : k] = x;
    const has = (f) => (v[f] !== undefined ? !!(v[f] && String(v[f]).trim()) : !!i[`${f}_enc`]);
    // The determination is the decision the notification rule turns on, so it has to be argued. "Not a
    // breach" rebuts the presumption only with all four factors assessed (§164.402(2)).
    if (v.determination && v.determination !== 'pending' && v.determination !== i.determination) {
      const reason = v.determination_reason !== undefined ? String(v.determination_reason || '') : dec(i.determination_reason_enc) || '';
      if (reason.trim().length < MIN_REASON) throw badRequest(`Record the reason for the determination (at least ${MIN_REASON} characters)`);
      if (v.determination === 'not_breach') {
        const missing = [['risk_nature', 'the nature and extent of the information'], ['risk_recipient', 'who received or used it'], ['risk_acquired', 'whether it was actually acquired or viewed'], ['risk_mitigation', 'how the risk was mitigated']].filter(([f]) => !has(f)).map(([, l]) => l);
        if (missing.length) throw badRequest(`"Not a breach" needs the four-factor risk assessment: ${missing.join('; ')}`, { missing });
      }
      merged.determined_by = ctx.user.id; merged.determined_at = db.now();
    }
    if (v.status === 'closed' && i.status !== 'closed') {
      if (merged.determination === 'pending') throw badRequest('Make a determination (breach or not) before closing the incident');
      const ob = incidents.obligations(merged);
      const owed = [['individuals', 'the individuals'], ['hhs', 'HHS'], ['media', 'the media']].filter(([k]) => ob[k].required && !ob[k].done).map(([, l]) => l);
      if (owed.length) throw badRequest(`Record when ${owed.join(', ')} ${owed.length === 1 ? 'was' : 'were'} notified before closing this breach`, { owed });
      merged.closed_at = db.now();
    }
    if (v.status === 'open') merged.closed_at = null;
    const sets = []; const params = [];
    for (const k of Object.keys(v)) {
      const col = INCIDENT_ENC.includes(k) ? `${k}_enc` : k;
      sets.push(`${col}=?`); params.push(INCIDENT_ENC.includes(k) ? (v[k] ? encrypt(v[k]) : null) : v[k]);
    }
    for (const k of ['determined_by', 'determined_at', 'closed_at']) if (merged[k] !== i[k]) { sets.push(`${k}=?`); params.push(merged[k]); }
    if (sets.length) db.run(`UPDATE privacy_incidents SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, db.now(), i.id);
    audit.log({ user: ctx.user, action: 'incident.update', entity: 'privacy_incident', entityId: i.id, ip: ctx.ip, details: { fields: Object.keys(v), determination: v.determination || undefined, status: v.status || undefined } });
    return { ok: true, obligations: incidents.obligations(loadIncident(i.id)) };
  });
  // The clients an incident touched: each needs its own notice if it is a breach.
  r.post('/api/incidents/:id/clients', auth.requireAuth, auth.requirePerm('incidents:write'), (ctx) => {
    const i = loadIncident(ctx.params.id);
    const { client_ids } = validate(ctx.body, { client_ids: { type: 'array', required: true, maxLen: 5000 } });
    let added = 0;
    db.transaction(() => {
      for (const cid of client_ids) {
        if (typeof cid !== 'string' || !db.one(`SELECT 1 FROM clients WHERE id=?`, cid)) throw badRequest('Unknown client');
        auth.assertClientAccess(ctx, cid);
        added += db.run(`INSERT OR IGNORE INTO privacy_incident_clients(id,incident_id,client_id) VALUES(?,?,?)`, uuid(), i.id, cid).changes;
      }
      // The count the notification thresholds use is never smaller than the people actually linked.
      const linked = db.one(`SELECT COUNT(*) n FROM privacy_incident_clients WHERE incident_id=?`, i.id).n;
      if (linked > (i.affected_count || 0)) db.run(`UPDATE privacy_incidents SET affected_count=?, updated_at=? WHERE id=?`, linked, db.now(), i.id);
    });
    for (const cid of client_ids) audit.log({ user: ctx.user, action: 'incident.client.link', entity: 'privacy_incident', entityId: i.id, clientId: cid, ip: ctx.ip });
    return { ok: true, added };
  });
  r.put('/api/incidents/:id/clients/:clientId', auth.requireAuth, auth.requirePerm('incidents:write'), (ctx) => {
    const i = loadIncident(ctx.params.id);
    const link = db.one(`SELECT * FROM privacy_incident_clients WHERE incident_id=? AND client_id=?`, i.id, ctx.params.clientId); if (!link) throw notFound('That client is not linked to this incident');
    auth.assertClientAccess(ctx, link.client_id);
    const v = validate(ctx.body, { notified_at: { type: 'date' } });
    db.run(`UPDATE privacy_incident_clients SET notified_at=?, updated_at=? WHERE id=?`, v.notified_at || null, db.now(), link.id);
    audit.log({ user: ctx.user, action: 'incident.client.notified', entity: 'privacy_incident', entityId: i.id, clientId: link.client_id, ip: ctx.ip, details: { notified: !!v.notified_at } });
    return { ok: true };
  });
  r.delete('/api/incidents/:id/clients/:clientId', auth.requireAuth, auth.requirePerm('incidents:write'), (ctx) => {
    const i = loadIncident(ctx.params.id);
    const link = db.one(`SELECT * FROM privacy_incident_clients WHERE incident_id=? AND client_id=?`, i.id, ctx.params.clientId); if (!link) throw notFound('That client is not linked to this incident');
    auth.assertClientAccess(ctx, link.client_id);
    db.run(`DELETE FROM privacy_incident_clients WHERE id=?`, link.id);
    audit.log({ user: ctx.user, action: 'incident.client.unlink', entity: 'privacy_incident', entityId: i.id, clientId: link.client_id, ip: ctx.ip });
    return { ok: true };
  });
  r.get('/api/meta/compliance-options', auth.requireAuth, () => ({ channels: CHANNELS, complainants: COMPLAINANTS, complaint_statuses: COMPLAINT_STATUSES, determinations: DETERMINATIONS }));
};
module.exports.CHANNELS = CHANNELS;

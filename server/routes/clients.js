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
  goals: { type: 'string', maxLen: 2000 }, flags: { type: 'string', maxLen: 300 }, race_codes: { type: 'string', maxLen: 200 }, contact_preferences: { type: 'string', maxLen: 300 }, ok_to_text: { type: 'boolean' }, ok_to_voicemail: { type: 'boolean' },
};

function loadClient(ctx, id) {
  const row = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL`, id);
  if (!row) throw notFound('Client not found');
  auth.assertClientAccess(ctx, id);
  return row;
}

module.exports = (r) => {
  r.get('/api/clients', auth.requireAuth, auth.requirePerm('clients:read', 'clients:list-deidentified'), (ctx) => {
    const deidentify = !auth.hasPerm(ctx.user, 'clients:read');
    const { limit, offset } = paging(ctx.query);
    const where = ['c.deleted_at IS NULL', 'c.merged_into IS NULL']; const params = [];
    const cf = auth.caseloadFilter(ctx.user); where.push(cf.sql); params.push(...cf.params);
    const status = ctx.query.get('status');
    if (status && status !== 'all') { where.push('c.status=?'); params.push(status); }
    const q = (ctx.query.get('q') || '').trim();
    if (q) {
      if (/^[CM]\d{2}-\d+(-D)?$/i.test(q)) { where.push('c.client_code=?'); params.push(q.toUpperCase()); }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(q)) { where.push('c.dob_idx=?'); params.push(blindIndex(q)); }
      else if (/^[\d\-() .+]{7,}$/.test(q)) { where.push('c.phone_idx=?'); params.push(blindIndex(q.replace(/\D/g, ''))); }
      else {
        // Exact surname or full name first, then the coarse indexes so a partial surname ("ngu") or a
        // misspelling ("Nguyan") still finds the person. Blind indexes cannot do prefix matching, so the
        // tolerance comes from indexing a 3-letter prefix and a Soundex code at write time.
        const parts = q.split(/[,\s]+/).filter(Boolean);
        const idxs = parts.map(p => blindIndex(p));
        const clauses = [`c.last_name_idx IN (${idxs.map(() => '?').join(',')})`, 'c.full_name_idx IN (?,?)'];
        params.push(...idxs, blindIndex(parts.join('')), blindIndex([...parts].reverse().join('')));
        if (ctx.query.get('exact') !== '1') {
          for (const part of parts) {
            const pfx = M.namePrefixIndex(part); if (pfx) { clauses.push('c.name_prefix_idx=?'); params.push(pfx); }
            const snd = M.namePhoneticIndex(part); if (snd) { clauses.push('c.name_phonetic_idx=?'); params.push(snd); }
          }
        }
        where.push(`(${clauses.join(' OR ')})`);
      }
    }
    const assigned = ctx.query.get('assigned_to');
    if (assigned) { where.push(`c.id IN (SELECT client_id FROM assignments WHERE user_id=? AND (end_date IS NULL OR end_date >= date('now')))`); params.push(assigned); }
    const w = 'WHERE ' + where.join(' AND ');
    const rows = db.all(`SELECT c.*, (SELECT GROUP_CONCAT(u.display_name, ', ') FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.client_id=c.id AND (a.end_date IS NULL OR a.end_date >= date('now'))) AS assigned_workers,
      (SELECT MAX(t) FROM (SELECT MAX(occurred_at) t FROM interventions i WHERE i.client_id=c.id UNION ALL SELECT MAX(started_at) FROM calls ca WHERE ca.client_id=c.id AND ca.outcome='reached')) AS last_contact
      FROM clients c ${w} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = db.one(`SELECT COUNT(*) n FROM clients c ${w}`, ...params).n;
    audit.log({ user: ctx.user, action: 'client.list', ip: ctx.ip, details: { q: q ? '[redacted]' : '', status, count: rows.length, deidentified: deidentify } });
    return { clients: rows.map(x => ({ ...M.summary(x, { deidentify }), assigned_workers: x.assigned_workers, last_contact: x.last_contact })), total, limit, offset };
  });

  /**
   * Existing clients who look like this one. Import already did this; direct entry did not, which is how a
   * caseload ends up with the same person three times under three spellings.
   * Matching is done entirely on blind indexes — no name is ever compared in the clear.
   */
  function possibleDuplicates(v, excludeId = null) {
    const clauses = []; const params = [];
    const add = (sql, ...p) => { clauses.push(sql); params.push(...p); };
    if (v.dob && v.last_name) add('(c.dob_idx=? AND c.last_name_idx=?)', blindIndex(v.dob), blindIndex(v.last_name));
    if (v.phone) add('c.phone_idx=?', blindIndex(String(v.phone).replace(/\D/g, '')));
    if (v.first_name && v.last_name) add('c.full_name_idx=?', blindIndex((v.last_name || '') + (v.first_name || '')));
    if (!clauses.length) return [];
    const rows = db.all(`SELECT c.* FROM clients c WHERE c.deleted_at IS NULL AND (${clauses.join(' OR ')}) ${excludeId ? 'AND c.id<>?' : ''} LIMIT 10`, ...params, ...(excludeId ? [excludeId] : []));
    return rows.map(x => {
      const d = M.decryptRow(x);
      const reasons = [];
      if (v.dob && v.last_name && x.dob_idx === blindIndex(v.dob) && x.last_name_idx === blindIndex(v.last_name)) reasons.push('same surname and date of birth');
      if (v.phone && x.phone_idx === blindIndex(String(v.phone).replace(/\D/g, ''))) reasons.push('same phone number');
      if (v.first_name && v.last_name && x.full_name_idx === blindIndex((v.last_name || '') + (v.first_name || ''))) reasons.push('same full name');
      return { id: x.id, client_code: x.client_code, display_name: d.display_name, dob: d.dob, status: x.status, intake_date: x.intake_date, reasons };
    });
  }

  // Check before entering, so the worker sees the match while they are still typing.
  r.post('/api/clients/check-duplicates', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    const v = validate(ctx.body, { first_name: { type: 'string', maxLen: 100 }, last_name: { type: 'string', maxLen: 100 }, dob: { type: 'date' }, phone: { type: 'string', maxLen: 40 }, exclude_id: { type: 'string' } });
    const matches = possibleDuplicates(v, v.exclude_id || null).filter(m => auth.canAccessClient(ctx.user, m.id) || auth.hasPerm(ctx.user, 'clients:all'));
    return { matches };
  });

  r.post('/api/clients', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    const v = validate(ctx.body, { ...shape, confirm_duplicate: { type: 'boolean' } });
    // Refuse a likely duplicate unless the worker has looked at the match and said it is a different person.
    if (!v.confirm_duplicate) {
      const matches = possibleDuplicates(v);
      if (matches.length) throw badRequest('A client with these details may already exist', { duplicates: matches, confirm_field: 'confirm_duplicate' });
    }
    delete v.confirm_duplicate;
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

  /**
   * Merge a duplicate into the record that is being kept. Everything attached to the duplicate moves; the
   * duplicate itself is kept (pointing at the keeper) rather than deleted, so audit entries, old links and
   * anything already synced to a device still resolve to something.
   * The child tables are discovered from the schema's foreign keys, so a table added later is not missed.
   */
  r.post('/api/clients/:id/merge', auth.requireAuth, auth.requirePerm('clients:merge'), (ctx) => {
    const keep = loadClient(ctx, ctx.params.id);
    const v = validate(ctx.body, { source_id: { type: 'string', required: true }, reason: { type: 'string', maxLen: 300 } });
    if (v.source_id === keep.id) throw badRequest('Choose a different record to merge in');
    const source = db.one(`SELECT * FROM clients WHERE id=?`, v.source_id);
    if (!source) throw notFound('The record to merge was not found');
    if (source.merged_into) throw badRequest('That record has already been merged into another client');
    if (source.deleted_at) throw badRequest('That record has been deleted');
    auth.assertClientAccess(ctx, source.id);

    // Every column in the database that points at clients(id), minus the clients table itself.
    const links = [];
    for (const t of db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)) {
      if (t.name === 'clients') continue;
      for (const fk of db.all(`PRAGMA foreign_key_list(${t.name})`)) if (fk.table === 'clients') links.push([t.name, fk.from]);
    }

    const moved = {};
    db.transaction(() => {
      for (const [table, col] of links) {
        const cols = db.all(`PRAGMA table_info(${table})`).map(c => c.name);
        const touch = cols.includes('updated_at') ? ', updated_at=?' : '';
        const params = touch ? [keep.id, db.now(), source.id] : [keep.id, source.id];
        const n = db.run(`UPDATE ${table} SET ${col}=?${touch} WHERE ${col}=?`, ...params).changes;
        if (n) moved[`${table}.${col}`] = (moved[`${table}.${col}`] || 0) + n;
      }
      // Fill gaps in the kept record from the duplicate rather than losing what was only entered once.
      const fills = {};
      for (const col of ['dob_enc', 'phone_enc', 'alt_phone_enc', 'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc', 'preferred_name_enc', 'goals_enc', 'flags_enc']) {
        if (!keep[col] && source[col]) fills[col] = source[col];
      }
      for (const col of M.PLAIN_FIELDS) if ((keep[col] === null || keep[col] === '' || keep[col] === undefined) && source[col]) fills[col] = source[col];
      // The earlier intake date is the one that describes when this person actually started.
      if (source.intake_date && (!keep.intake_date || source.intake_date < keep.intake_date)) fills.intake_date = source.intake_date;
      const keys = Object.keys(fills);
      if (keys.length) db.run(`UPDATE clients SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => fills[k]), db.now(), keep.id);
      // Recompute the kept record's blind indexes in case a name field was filled in from the duplicate.
      const after = db.one(`SELECT * FROM clients WHERE id=?`, keep.id);
      const plain = M.decryptRow(after);
      db.run(`UPDATE clients SET dob_idx=?, phone_idx=?, name_prefix_idx=?, name_phonetic_idx=?, updated_at=? WHERE id=?`,
        plain.dob ? blindIndex(plain.dob) : null, plain.phone ? blindIndex(String(plain.phone).replace(/\D/g, '')) : null,
        M.namePrefixIndex(plain.last_name || ''), M.namePhoneticIndex(plain.last_name || ''), db.now(), keep.id);

      db.run(`UPDATE clients SET merged_into=?, status='closed', deleted_at=?, updated_at=? WHERE id=?`, keep.id, db.now(), db.now(), source.id);
      moved._filled_fields = keys.length;
    });
    // The detail of what moved is structural, never PHI.
    audit.log({ user: ctx.user, action: 'client.merge', entity: 'client', entityId: keep.id, clientId: keep.id, ip: ctx.ip, details: { merged: source.id, merged_code: source.client_code, moved, reason: v.reason || undefined } });
    audit.log({ user: ctx.user, action: 'client.merged_away', entity: 'client', entityId: source.id, clientId: source.id, ip: ctx.ip, details: { into: keep.id } });
    return { ok: true, kept: keep.id, merged: source.id, moved };
  });

  r.get('/api/clients/:id', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    const client = M.decryptRow(row);
    client.assignments = db.all(`SELECT a.*, u.display_name, u.role AS user_role FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.client_id=? ORDER BY a.end_date IS NOT NULL, a.start_date DESC`, row.id);
    client.active_consents = db.all(`SELECT id,type,recipient_enc,purpose_enc,signed_at,expires_at FROM consents WHERE client_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now'))`, row.id)
      .map(x => ({ id: x.id, type: x.type, recipient: x.recipient_enc ? decrypt(x.recipient_enc) : null, purpose: x.purpose_enc ? decrypt(x.purpose_enc) : null, signed_at: x.signed_at, expires_at: x.expires_at }));
    client.counts = {
      interventions: db.one(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, row.id).n,
      calls: db.one(`SELECT COUNT(*) n FROM calls WHERE client_id=?`, row.id).n,
      notes: db.one(`SELECT COUNT(*) n FROM notes WHERE client_id=? AND deleted_at IS NULL`, row.id).n,
      forms: db.one(`SELECT COUNT(*) n FROM client_forms WHERE client_id=? AND deleted_at IS NULL`, row.id).n,
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
    // A client with years of history has thousands of events; the page shows the most recent ones and
    // pages back through the rest, rather than decrypting every call summary on every view.
    const { limit, offset } = paging(ctx.query, { limit: 100, max: 500 });
    const per = limit + offset + 1; // enough of each kind that the merged, sorted page is complete
    const before = ctx.query.get('before') || null;
    const cut = (col) => (before ? `AND ${col} < ?` : '');
    const cutP = before ? [before] : [];
    const events = [];
    for (const x of db.all(`SELECT i.*, u.display_name AS worker FROM interventions i JOIN users u ON u.id=i.user_id WHERE client_id=? ${cut('i.occurred_at')} ORDER BY i.occurred_at DESC LIMIT ?`, id, ...cutP, per))
      events.push({ kind: 'intervention', id: x.id, at: x.occurred_at, title: x.type.replace(/_/g, ' '), detail: x.summary_enc ? decrypt(x.summary_enc) : null, worker: x.worker, meta: { duration: x.duration_minutes, outcome: x.outcome, location: x.location } });
    for (const x of db.all(`SELECT c.*, u.display_name AS worker FROM calls c JOIN users u ON u.id=c.user_id WHERE client_id=? ${cut('c.started_at')} ORDER BY c.started_at DESC LIMIT ?`, id, ...cutP, per))
      events.push({ kind: 'call', id: x.id, at: x.started_at, title: `${x.direction} call (${x.contact_type})`, detail: x.summary_enc ? decrypt(x.summary_enc) : x.purpose, worker: x.worker, meta: { duration: x.duration_minutes, outcome: x.outcome, crisis: !!x.crisis } });
    for (const x of db.all(`SELECT n.id,n.kind,n.format,n.title_enc,n.occurred_at,n.status,n.source,u.display_name AS worker FROM notes n JOIN users u ON u.id=n.author_id WHERE client_id=? AND deleted_at IS NULL ${cut('n.occurred_at')} ORDER BY n.occurred_at DESC LIMIT ?`, id, ...cutP, per))
      if (x.kind === 'admin' || canClinical) events.push({ kind: 'note', id: x.id, at: x.occurred_at, title: `${x.kind} note: ${x.title_enc ? decrypt(x.title_enc) : x.format}`, detail: null, worker: x.worker, meta: { status: x.status, note_kind: x.kind, source: x.source } });
    for (const x of db.all(`SELECT r.*, res.name AS resource_name, u.display_name AS worker FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN users u ON u.id=r.user_id WHERE client_id=? ${cut('r.referred_at')} ORDER BY r.referred_at DESC LIMIT ?`, id, ...cutP, per))
      events.push({ kind: 'referral', id: x.id, at: x.referred_at, title: `Referral: ${x.resource_name}`, detail: x.notes, worker: x.worker, meta: { status: x.status, outcome: x.outcome } });
    for (const x of db.all(`SELECT t.*, u.display_name AS worker FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE client_id=? ORDER BY COALESCE(t.completed_at, t.due_at, t.created_at) DESC LIMIT ?`, id, per))
      events.push({ kind: x.is_milestone ? 'milestone' : 'task', id: x.id, at: x.completed_at || x.due_at || x.created_at, title: x.title, detail: x.description, worker: x.worker, meta: { status: x.status, priority: x.priority, due_at: x.due_at } });
    for (const x of db.all(`SELECT * FROM consents WHERE client_id=? ORDER BY signed_at DESC LIMIT ?`, id, per))
      events.push({ kind: 'consent', id: x.id, at: x.signed_at, title: `Consent: ${x.type.replace(/_/g, ' ')}${x.recipient_enc ? ' → ' + decrypt(x.recipient_enc) : ''}`, detail: x.purpose_enc ? decrypt(x.purpose_enc) : null, meta: { expires_at: x.expires_at, revoked_at: x.revoked_at } });
    if (auth.hasPerm(ctx.user, 'budget:read'))
      for (const x of db.all(`SELECT e.*, f.name AS fund FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE client_id=? ORDER BY e.spent_at DESC LIMIT ?`, id, per))
        events.push({ kind: 'expense', id: x.id, at: x.spent_at, title: `$${x.amount.toFixed(2)} ${x.category.replace(/_/g, ' ')}`, detail: x.description, meta: { fund: x.fund, status: x.status } });
    events.push({ kind: 'milestone', id: 'intake', at: row.intake_date, title: 'Program intake', meta: {} });
    if (row.discharge_date) events.push({ kind: 'milestone', id: 'discharge', at: row.discharge_date, title: `Discharge: ${row.discharge_reason || ''}`, meta: {} });
    events.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    const page = events.slice(offset, offset + limit);
    audit.log({ user: ctx.user, action: 'client.timeline', entity: 'client', entityId: id, clientId: id, ip: ctx.ip, details: { events: page.length } });
    return { events: page, limit, offset, more: events.length > offset + limit };
  });
};

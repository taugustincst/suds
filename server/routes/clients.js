'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, notFound, forbidden, conflict, HttpError } = require('../http');
const { validate, paging } = require('../validate');
const { blindIndex, uuid, decrypt, encrypt } = require('../crypto');
const M = require('../clients-model');
const F = require('../client-filters');
const O = require('../options');

// discharge_reason is a code from the DISCHARGE_REASONS list, like an episode's. A reason typed in before
// it became a list stays on the record and does not block editing it (validate's `existing`); only a new
// value is checked. A de-identified export writes anything outside the list as "other" (server/exports.js).
const shape = {
  first_name: { type: 'string', required: true, maxLen: 100 }, last_name: { type: 'string', required: true, maxLen: 100 },
  preferred_name: { type: 'string', maxLen: 100 }, dob: { type: 'date' }, phone: { type: 'string', maxLen: 40 }, alt_phone: { type: 'string', maxLen: 40 },
  email: { type: 'string', maxLen: 200 }, address: { type: 'string', maxLen: 300 }, city: { type: 'string', maxLen: 100 }, zip: { type: 'string', maxLen: 12 },
  gender: { type: 'string', maxLen: 40 }, pronouns: { type: 'string', maxLen: 40 }, race_ethnicity: { type: 'string', maxLen: 100 }, preferred_language: { type: 'string', maxLen: 60 },
  veteran: { type: 'boolean' }, housing_status: { type: 'string', maxLen: 60 }, insurance: { type: 'string', maxLen: 100 }, medicaid_id: { type: 'string', maxLen: 40 },
  emergency_contact: { type: 'string', maxLen: 300 },
  status: { type: 'string', enum: ['waitlist', 'active', 'inactive', 'closed', 'deceased'] }, intake_date: { type: 'date' }, discharge_date: { type: 'date' }, discharge_reason: { type: 'string', maxLen: 200, list: 'DISCHARGE_REASONS' },
  referral_source: { type: 'string', maxLen: 120 }, referral_date: { type: 'date' }, engagement_date: { type: 'date' }, primary_substance: { type: 'string', maxLen: 60, list: 'SUBSTANCES' }, secondary_substances: { type: 'string', maxLen: 200 }, route_of_use: { type: 'string', maxLen: 60 },
  asam_level: { type: 'string', maxLen: 20 }, mat_status: { type: 'string', enum: ['none', 'interested', 'referred', 'active', 'discontinued', 'unknown'] }, mat_medication: { type: 'string', maxLen: 60 },
  overdose_history: { type: 'boolean' }, last_overdose_date: { type: 'date' }, naloxone_provided: { type: 'boolean' }, naloxone_last_date: { type: 'date' },
  risk_level: { type: 'string', enum: ['low', 'moderate', 'high', 'critical'] }, justice_involved: { type: 'boolean' }, pregnant_or_parenting: { type: 'boolean' }, co_occurring_mh: { type: 'boolean' },
  goals: { type: 'string', maxLen: 2000 }, flags: { type: 'string', maxLen: 300 }, race_codes: { type: 'string', maxLen: 200 }, contact_preferences: { type: 'string', maxLen: 300 }, ok_to_text: { type: 'boolean' }, ok_to_voicemail: { type: 'boolean' },
};

function loadClient(ctx, id) {
  const row = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL`, id);
  if (!row) {
    // A duplicate that was merged away is kept, pointing at the record that replaced it, so an old link
    // (a bookmark, a to-do, a synced phone) can be sent on to the keeper instead of dead-ending on 404.
    const merged = db.one(`SELECT merged_into FROM clients WHERE id=? AND merged_into IS NOT NULL`, id);
    if (merged) throw new HttpError(404, 'This record was merged into another client', { merged_into: merged.merged_into });
    throw notFound('Client not found');
  }
  auth.assertClientAccess(ctx, id);
  return row;
}

// Contact details that cannot be right are worse than none: a birth date in the future, "notanemail", a
// phone number with no digits. The form checks the same things, so a worker sees it before saving.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function checkContactFields(v) {
  const fields = {};
  if (v.dob) {
    const today = require('./budget').localDate();
    if (v.dob > today) fields.dob = 'cannot be in the future';
    else if (v.dob < '1900-01-01') fields.dob = 'must be after 1900';
  }
  if (v.email && !EMAIL_RE.test(v.email)) fields.email = 'is not a valid email address';
  for (const f of ['phone', 'alt_phone']) if (v[f] && String(v[f]).replace(/\D/g, '').length < 7) fields[f] = 'must contain at least 7 digits';
  if (Object.keys(fields).length) throw badRequest('Validation failed', { fields });
}

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

// ---- returning clients ----
// A person discharged years ago walks back in, often out of hours, and the worker on duty has no way to
// them: search is caseload-scoped (and stays that way), opening the record is refused, and intake used to
// end at "outside your caseload — ask a supervisor". The one exception made here is narrow and after-the-
// fact reviewed, the same shape as break-glass access to clinical notes: the duplicate check at intake may
// say that an earlier, discharged record exists, and a worker who can admit people may re-admit it onto
// their own caseload, giving a reason. That assigns them, opens a new episode, writes an audit entry and
// puts the event in the supervisors' review queue (breakglass_events, kind 'readmission'), which the Home
// page and Supervision already surface until someone acknowledges it.

/** Matched on something only the person (or their paperwork) supplies, not on a name alone. */
const strongMatch = (m) => m.reasons.includes('same surname and date of birth') || m.reasons.includes('same phone number');
/** Discharged and nobody's: closed or inactive, no open episode, no active assignment. */
function isDischarged(id) {
  return !!db.one(`SELECT 1 FROM clients c WHERE c.id=? AND c.deleted_at IS NULL AND c.merged_into IS NULL AND c.status IN ('closed','inactive')
    AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.client_id=c.id AND e.status='open')
    AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.client_id=c.id AND ${auth.activeAssignment('a.')})`, id);
}
const canReadmit = (user) => auth.hasPerm(user, 'clients:write') && auth.hasPerm(user, 'episodes:write');
/** Hidden matches this worker may re-admit, described without anything from the stored record's PHI. */
function readmitOffers(ctx, hidden) {
  if (!canReadmit(ctx.user)) return [];
  return hidden.filter(m => strongMatch(m) && isDischarged(m.id)).map(m => {
    const c = db.one(`SELECT client_code, status, discharge_date, discharge_reason FROM clients WHERE id=?`, m.id);
    return { id: m.id, client_code: c.client_code, status: c.status, discharge_date: c.discharge_date, discharge_reason: c.discharge_reason, reasons: m.reasons };
  });
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
      if (/^[A-Z]+\d*-\d+(-D)?$/i.test(q)) { where.push('c.client_code=?'); params.push(q.toUpperCase()); }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(q)) { where.push('c.dob_idx=?'); params.push(blindIndex(q)); }
      else if (/^[\d\-() .+]{7,}$/.test(q)) { where.push('c.phone_idx=?'); params.push(blindIndex(q.replace(/\D/g, ''))); }
      else {
        // Exact surname or full name first, then the coarse indexes so a partial surname ("ngu") or a
        // misspelling ("Nguyan") still finds the person. Blind indexes cannot do prefix matching, so the
        // tolerance comes from indexing a 3-letter prefix and a Soundex code at write time.
        const parts = q.split(/[,\s]+/).filter(Boolean);
        const idxs = parts.map(p => blindIndex(p));
        const clauses = [`c.last_name_idx IN (${idxs.map(() => '?').join(',')})`, 'c.full_name_idx IN (?,?)', `c.first_name_idx IN (${idxs.map(() => '?').join(',')})`, `c.preferred_name_idx IN (${idxs.map(() => '?').join(',')})`];
        params.push(...idxs, blindIndex(parts.join('')), blindIndex([...parts].reverse().join('')), ...parts.map(p => blindIndex(p.toLowerCase())), ...parts.map(p => M.preferredNameIndex(p)));
        if (ctx.query.get('exact') !== '1') {
          for (const part of parts) {
            const pfx = M.namePrefixIndex(part); if (pfx) { clauses.push('c.name_prefix_idx=?'); params.push(pfx); clauses.push('c.first_name_prefix_idx=?'); params.push(pfx); }
            const snd = M.namePhoneticIndex(part); if (snd) { clauses.push('c.name_phonetic_idx=?'); params.push(snd); }
          }
        }
        where.push(`(${clauses.join(' OR ')})`);
      }
    }
    const assigned = ctx.query.get('assigned_to');
    if (assigned) { where.push(`c.id IN (SELECT client_id FROM assignments WHERE user_id=? AND ${auth.activeAssignment()})`); params.push(assigned); }
    // The Home page's tiles and alerts link here. Each filter is the same predicate the dashboard counts
    // with (server/client-filters.js), applied inside the caseload-scoped query, so the total is right
    // and every page after the first is reachable — not a filter over whatever the first page held.
    const filters = [];
    const addFilter = (name, f) => { where.push(f.sql); params.push(...f.params); filters.push(name); };
    const risk = ctx.query.get('risk');
    if (risk && ['high', 'low', 'moderate', 'critical'].includes(risk)) addFilter('risk', F.risk(risk));
    if (ctx.query.get('stale') === '1') addFilter('stale', F.noContactSince());
    const substance = (ctx.query.get('substance') || '').slice(0, 60);
    if (substance) addFilter('substance', F.substance(substance));
    const mat = (ctx.query.get('mat') || '').slice(0, 60);
    if (mat) addFilter('mat', F.mat(mat));
    const consentWindow = ctx.query.get('consent_expiring') === '1' ? F.consentWindow() : null;
    if (consentWindow) addFilter('consent_expiring', F.consentExpiring(consentWindow));
    if (ctx.query.get('patient_requests') === '1' && (auth.hasPerm(ctx.user, 'patient-requests:read') || auth.hasPerm(ctx.user, 'patient-requests:write'))) addFilter('patient_requests', F.openPatientRequest());
    const w = 'WHERE ' + where.join(' AND ');
    // Caseload sort orders a navigator actually works a list by: who has gone longest without contact,
    // who has follow-ups slipping, and who is highest risk. Anything else is most-recently-touched first.
    const sort = ctx.query.get('sort') || '';
    const order = { last_contact: 'last_contact IS NOT NULL, last_contact ASC', overdue: 'overdue_tasks DESC, last_contact ASC',
      risk: `CASE c.risk_level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, last_contact ASC` }[sort] || 'c.updated_at DESC';
    const rows = db.all(`SELECT c.*, (SELECT GROUP_CONCAT(u.display_name, ', ') FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.client_id=c.id AND ${auth.activeAssignment('a.')}) AS assigned_workers,
      (SELECT MAX(t) FROM (SELECT MAX(occurred_at) t FROM interventions i WHERE i.client_id=c.id UNION ALL SELECT MAX(started_at) FROM calls ca WHERE ca.client_id=c.id AND ca.outcome IN ('reached','replied'))) AS last_contact,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id=c.id AND t.status IN ('open','in_progress') AND (CASE WHEN length(t.due_at)=10 THEN t.due_at < date('now','localtime') ELSE t.due_at < ? END)) AS overdue_tasks
      ${consentWindow ? `, (SELECT MIN(co.expires_at) FROM consents co WHERE co.client_id=c.id AND co.revoked_at IS NULL AND co.expires_at BETWEEN ? AND ?) AS consent_expires_at` : ''}
      FROM clients c ${w} ORDER BY ${order}, c.id LIMIT ? OFFSET ?`, db.now(), ...(consentWindow ? [consentWindow.from, consentWindow.to] : []), ...params, limit, offset);
    const total = db.one(`SELECT COUNT(*) n FROM clients c ${w}`, ...params).n;
    audit.log({ user: ctx.user, action: 'client.list', ip: ctx.ip, details: { q: q ? '[redacted]' : '', status, sort: sort || undefined, filters: filters.length ? filters : undefined, offset: offset || undefined, count: rows.length, deidentified: deidentify } });
    return { clients: rows.map(x => ({ ...M.summary(x, { deidentify }), assigned_workers: x.assigned_workers, last_contact: x.last_contact, overdue_tasks: x.overdue_tasks, ...(consentWindow ? { consent_expires_at: x.consent_expires_at } : {}) })), total, limit, offset };
  });

  // Check before entering, so the worker sees the match while they are still typing.
  r.post('/api/clients/check-duplicates', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    const v = validate(ctx.body, { first_name: { type: 'string', maxLen: 100 }, last_name: { type: 'string', maxLen: 100 }, dob: { type: 'date' }, phone: { type: 'string', maxLen: 40 }, exclude_id: { type: 'string' } });
    const all = possibleDuplicates(v, v.exclude_id || null);
    const visible = (m) => auth.canAccessClient(ctx.user, m.id) || auth.hasPerm(ctx.user, 'clients:all');
    const matches = all.filter(visible);
    const hidden = all.filter(m => !visible(m));
    const readmit = readmitOffers(ctx, hidden);
    if (all.length) audit.log({ user: ctx.user, action: 'client.duplicate_check', ip: ctx.ip, details: { matches: all.length, hidden: hidden.length, shown: matches.map(m => m.client_code), readmit_offered: readmit.map(m => m.client_code) } });
    return { matches, hidden_duplicates: hidden.length, readmit };
  });

  r.post('/api/clients', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    const v = validate(ctx.body, { ...shape, confirm_duplicate: { type: 'boolean' }, no_episode: { type: 'boolean' } });
    checkContactFields(v);
    // Refuse a likely duplicate unless the worker has looked at the match and said it is a different person.
    if (!v.confirm_duplicate) {
      // Exactly the filter /check-duplicates applies: a match outside the caller's caseload is a fact they
      // may be told exists, never a record they may be shown. The check is audited before anything is
      // returned, whichever way it goes, because it is a read of other people's records.
      const all = possibleDuplicates(v);
      const visible = all.filter(m => auth.canAccessClient(ctx.user, m.id) || auth.hasPerm(ctx.user, 'clients:all'));
      const hidden = all.length - visible.length;
      const readmit = readmitOffers(ctx, all.filter(m => !visible.includes(m)));
      if (all.length) audit.log({ user: ctx.user, action: 'client.duplicate_check', ip: ctx.ip, details: { matches: all.length, hidden, shown: visible.map(m => m.client_code), readmit_offered: readmit.length ? readmit.map(m => m.client_code) : undefined } });
      if (visible.length) throw badRequest('A client with these details may already exist', { duplicates: visible, hidden_duplicates: hidden, readmit, confirm_field: 'confirm_duplicate' });
      if (readmit.length) throw badRequest('An earlier record exists for this person and they were discharged. Re-admit it to carry on their record rather than starting a new one.', { hidden_duplicates: hidden, readmit, confirm_field: 'confirm_duplicate' });
      if (hidden) throw badRequest('A possible duplicate exists that is outside your caseload — ask a supervisor', { hidden_duplicates: hidden, confirm_field: 'confirm_duplicate' });
    }
    delete v.confirm_duplicate;
    const noEpisode = !!v.no_episode; delete v.no_episode;
    const id = uuid();
    const enc = M.encryptFields(v);
    enc.full_name_idx = blindIndex((v.last_name || '') + (v.first_name || ''));
    const cols = { id, client_code: M.nextClientCode(), ...enc, created_by: ctx.user.id };
    for (const f of M.PLAIN_FIELDS) if (v[f] !== undefined) cols[f] = v[f];
    if (!cols.intake_date) cols.intake_date = new Date().toISOString().slice(0, 10);
    const keys = Object.keys(cols).filter(k => cols[k] !== undefined);
    let episodeId = null;
    db.transaction(() => {
      db.run(`INSERT INTO clients(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
      // auto-assign creator if they are a caseload-restricted worker
      if (auth.caseloadRestricted(ctx.user) || ['navigator', 'clinician'].includes(ctx.user.role)) {
        db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, uuid(), id, ctx.user.id, 'primary', cols.intake_date, ctx.user.id);
      }
      // Intake is an admission: it opens the first episode of care, so discharges are countable from day one
      // instead of every client sitting "active" with nothing to close. A waitlisted person has not started
      // services yet, and a caller that manages episodes itself passes no_episode.
      if (!noEpisode && cols.status !== 'waitlist' && cols.status !== 'closed' && cols.status !== 'deceased') {
        episodeId = uuid();
        db.run(`INSERT INTO episodes(id,client_id,opened_at,opened_by,referral_source) VALUES(?,?,?,?,?)`, episodeId, id, cols.intake_date, ctx.user.id, cols.referral_source || null);
      }
    });
    audit.log({ user: ctx.user, action: 'client.create', entity: 'client', entityId: id, clientId: id, ip: ctx.ip, details: episodeId ? { episode: episodeId } : undefined });
    if (episodeId) audit.log({ user: ctx.user, action: 'episode.open', entity: 'episode', entityId: episodeId, clientId: id, ip: ctx.ip, details: { at_intake: true } });
    ctx.status = 201;
    return { id, client_code: cols.client_code, episode_id: episodeId };
  });

  // Re-admit a discharged client found by the intake duplicate check (see the comment above readmitOffers).
  // The caller proves they are dealing with this person by sending the details that matched (surname and
  // date of birth, or phone number), not just an id, and says why; the record must be discharged and on
  // nobody's caseload. Everything else about access is unchanged: this is the only door, and it is logged
  // and reviewed.
  r.post('/api/clients/:id/readmit', auth.requireAuth, auth.requirePerm('clients:write'), auth.requirePerm('episodes:write'), (ctx) => {
    const v = validate(ctx.body, { first_name: { type: 'string', maxLen: 100 }, last_name: { type: 'string', maxLen: 100 }, dob: { type: 'date' }, phone: { type: 'string', maxLen: 40 },
      reason: { type: 'string', required: true, maxLen: 300 }, referral_source: { type: 'string', maxLen: 120 } });
    if (v.reason.length < 15) throw badRequest('Say why you are re-admitting this person (at least 15 characters) — a supervisor reviews every re-admission', { fields: { reason: 'must be at least 15 characters' } });
    const row = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL AND merged_into IS NULL`, ctx.params.id);
    if (!row) throw notFound('Client not found');
    const match = possibleDuplicates(v).find(m => m.id === row.id);
    if (!match || !strongMatch(match)) {
      audit.log({ user: ctx.user, action: 'authz.denied', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, success: false, details: { reason: 'readmit: details do not match the record' } });
      throw forbidden('Those details do not match that record. Enter the surname and date of birth, or the phone number, as the person gives them.');
    }
    if (!isDischarged(row.id)) {
      audit.log({ user: ctx.user, action: 'client.readmit.refused', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, success: false, details: { status: row.status } });
      throw conflict('This record is not a discharged one: it is active or on someone\'s caseload. Ask a supervisor to assign it to you.');
    }
    const hadAccess = auth.canAccessClient(ctx.user, row.id);
    const today = require('./budget').localDate();
    const episodeId = uuid();
    db.transaction(() => {
      db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, uuid(), row.id, ctx.user.id, 'primary', today, ctx.user.id);
      db.run(`INSERT INTO episodes(id,client_id,opened_at,opened_by,referral_source) VALUES(?,?,?,?,?)`, episodeId, row.id, today, ctx.user.id, v.referral_source || null);
      // The same status change opening an episode makes (routes/episodes.js): a returning client is active.
      db.run(`UPDATE clients SET status='active', discharge_date=NULL, discharge_reason=NULL, updated_at=? WHERE id=?`, db.now(), row.id);
      // A worker who could not see this record has just put it on their caseload: a supervisor looks at it.
      if (!hadAccess) db.run(`INSERT INTO breakglass_events(id,user_id,client_id,note_id,reason_enc,at,kind) VALUES(?,?,?,?,?,?,?)`, uuid(), ctx.user.id, row.id, null, encrypt(v.reason), db.now(), 'readmission');
    });
    // The reason stays in the review queue, encrypted; it may describe the person, so it is not in the log.
    audit.log({ user: ctx.user, action: 'client.readmit', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, details: { episode: episodeId, prior_status: row.status, discharged: row.discharge_date || undefined, outside_caseload: !hadAccess, matched_on: match.reasons } });
    audit.log({ user: ctx.user, action: 'episode.open', entity: 'episode', entityId: episodeId, clientId: row.id, ip: ctx.ip, details: { readmission: true } });
    return { id: row.id, client_code: row.client_code, episode_id: episodeId };
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
    // A record on legal hold has to stay exactly as it is: merging it would delete it (the duplicate ends
    // up soft-deleted) or rewrite it (the keeper is filled in from the duplicate), and the hold would go
    // with it. Refused, and the refusal is audited, since counsel may ask who tried.
    if (keep.legal_hold || source.legal_hold) {
      const held = keep.legal_hold && source.legal_hold ? 'Both records are' : keep.legal_hold ? `This record (${keep.client_code}) is` : `The record to merge in (${source.client_code}) is`;
      audit.log({ user: ctx.user, action: 'client.merge.refused', entity: 'client', entityId: keep.id, clientId: keep.id, ip: ctx.ip, success: false, details: { source: source.id, reason: 'legal_hold', keep_on_hold: !!keep.legal_hold, source_on_hold: !!source.legal_hold } });
      throw conflict(`${held} on legal hold and cannot be merged until an administrator clears the hold`);
    }

    // Every column in the database that points at clients(id), minus the clients table itself.
    const links = [];
    for (const t of db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)) {
      if (t.name === 'clients') continue;
      for (const fk of db.all(`PRAGMA foreign_key_list(${t.name})`)) if (fk.table === 'clients') links.push([t.name, fk.from]);
    }

    const moved = {};
    // The duplicate's open episode, if any: after the move the keeper may have two, and a person is in
    // one episode of care at a time.
    const sourceOpenEpisodes = db.all(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, source.id).map(e => e.id);
    db.transaction(() => {
      // An incident that already lists both records lists the person once (UNIQUE incident_id, client_id).
      db.run(`DELETE FROM privacy_incident_clients WHERE client_id=? AND incident_id IN (SELECT incident_id FROM privacy_incident_clients WHERE client_id=?)`, source.id, keep.id);
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
      db.run(`UPDATE clients SET dob_idx=?, phone_idx=?, name_prefix_idx=?, name_phonetic_idx=?, preferred_name_idx=?, updated_at=? WHERE id=?`,
        plain.dob ? blindIndex(plain.dob) : null, plain.phone ? blindIndex(String(plain.phone).replace(/\D/g, '')) : null,
        M.namePrefixIndex(plain.last_name || ''), M.namePhoneticIndex(plain.last_name || ''), M.preferredNameIndex(plain.preferred_name), db.now(), keep.id);

      // A worker assigned to both records is now assigned to the keeper twice. Keep the assignment that
      // started first; the rest are duplicates, not history.
      const dupAssignments = db.all(`SELECT a.id FROM assignments a WHERE a.client_id=? AND ${auth.activeAssignment('a.')} AND a.id <> (
          SELECT b.id FROM assignments b WHERE b.client_id=a.client_id AND b.user_id=a.user_id AND ${auth.activeAssignment('b.')} ORDER BY b.start_date, b.created_at, b.id LIMIT 1)`, keep.id);
      for (const a of dupAssignments) { db.run(`DELETE FROM assignments WHERE id=?`, a.id); db.tombstone('assignments', a.id); }
      if (dupAssignments.length) moved._duplicate_assignments_removed = dupAssignments.length;
      // At most one open episode: if both records had one, the duplicate's is closed as merged — the care
      // continues under the keeper's.
      if (db.one(`SELECT COUNT(*) n FROM episodes WHERE client_id=? AND status='open'`, keep.id).n > 1) {
        const today = new Date().toISOString().slice(0, 10);
        for (const id of sourceOpenEpisodes) db.run(`UPDATE episodes SET status='closed', closed_at=?, closed_by=?, discharge_reason='merged', discharge_disposition='merged into duplicate record', updated_at=? WHERE id=? AND status='open'`, today, ctx.user.id, db.now(), id);
        moved._episodes_closed_as_merged = sourceOpenEpisodes.length;
      }
      // Import suggestions are a plain (non-FK) pointer, so the loop above did not move them.
      db.run(`UPDATE import_items SET suggested_client_id=?, updated_at=? WHERE suggested_client_id=?`, keep.id, db.now(), source.id);
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
    client.days_to_engagement = M.daysToEngagement(client);
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
      episodes: db.one(`SELECT COUNT(*) n FROM episodes WHERE client_id=?`, row.id).n,
    };
    client.open_episode = !!db.one(`SELECT 1 FROM episodes WHERE client_id=? AND status='open'`, row.id);
    // The most recent signed safety plan this person may read, so the overview can say one is on file
    // without pulling the note itself (that is a separate, audited read when they open it). A draft is
    // not a plan anyone should act on, so it does not earn the chip.
    const kinds = ['admin', 'clinical'].filter(k => auth.hasPerm(ctx.user, `notes:${k}:read`) || auth.hasPerm(ctx.user, `notes:${k}:write`));
    const sp = kinds.length ? db.one(`SELECT id, occurred_at, status FROM notes WHERE client_id=? AND format='safety_plan' AND deleted_at IS NULL AND status IN ('signed','amended') AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY occurred_at DESC LIMIT 1`, row.id, ...kinds) : null;
    client.safety_plan = sp || null;
    // 42 CFR Part 2: whether the record carries the Part 2 label, and when the client was last given the
    // §2.22 notice (the Overview says so, or says it is missing).
    client.part2 = { program: require('../disclosure').part2Program(), notice: require('./part2').latestNotice(row.id) };
    audit.log({ user: ctx.user, action: 'client.view', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip });
    return { client };
  });

  r.put('/api/clients/:id', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    require('../crud').assertFresh(ctx, row, 'client');
    const v = validate(ctx.body, { ...shape, first_name: { ...shape.first_name, required: false }, last_name: { ...shape.last_name, required: false } }, { partial: true, existing: row });
    checkContactFields(v);
    // Closing a client is a discharge, and a discharge is what closes the episode, ends the care team and
    // clears the open to-dos. Setting the status by hand while an episode is open would leave all of that
    // running against a "closed" person, so it has to go through the Episodes tab.
    if ((v.status === 'closed' || v.status === 'deceased') && v.status !== row.status && db.one(`SELECT 1 FROM episodes WHERE client_id=? AND status='open'`, row.id)) {
      throw badRequest(`This client has an open episode of care. To ${v.status === 'deceased' ? 'record a death' : 'close the record'}, discharge them on the Episodes tab — that closes the episode and sets the status.`, { fields: { status: 'discharge on the Episodes tab instead' }, open_episode: true });
    }
    const enc = M.encryptFields(v);
    if (v.first_name !== undefined || v.last_name !== undefined) {
      const cur = M.decryptRow(row);
      enc.full_name_idx = blindIndex((v.last_name ?? cur.last_name ?? '') + (v.first_name ?? cur.first_name ?? ''));
    }
    const cols = { ...enc };
    for (const f of M.PLAIN_FIELDS) if (v[f] !== undefined) cols[f] = v[f];
    const keys = Object.keys(cols).filter(k => cols[k] !== undefined);
    if (!keys.length) return { ok: true, updated_at: row.updated_at };
    const stamp = db.now();
    db.run(`UPDATE clients SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => cols[k]), stamp, row.id);
    audit.log({ user: ctx.user, action: 'client.update', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, details: { fields: Object.keys(v) } });
    return { ok: true, updated_at: stamp };
  });

  // A legal hold keeps the record out of the retention purge (server/retention.js) and blocks deletion
  // until an administrator clears it. Only administrators, because the hold usually comes from counsel.
  r.post('/api/clients/:id/legal-hold', auth.requireAuth, auth.requirePerm('clients:legal-hold'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    const v = validate(ctx.body, { hold: { type: 'boolean', required: true }, reason: { type: 'string', maxLen: 300 } });
    if (v.hold && !v.reason) throw badRequest('A legal hold needs a reason (the matter or request it relates to)');
    db.run(`UPDATE clients SET legal_hold=?, legal_hold_reason=?, updated_at=? WHERE id=?`, v.hold ? 1 : 0, v.hold ? v.reason : null, db.now(), row.id);
    audit.log({ user: ctx.user, action: v.hold ? 'client.legal_hold.set' : 'client.legal_hold.clear', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, details: { reason: v.reason || undefined } });
    return { ok: true, legal_hold: v.hold ? 1 : 0 };
  });

  r.delete('/api/clients/:id', auth.requireAuth, auth.requirePerm('clients:all'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, 'clients:write')) throw forbidden();
    if (row.legal_hold) throw badRequest('This record is on legal hold and cannot be deleted until the hold is cleared');
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
      events.push({ kind: 'intervention', id: x.id, at: x.occurred_at, title: O.labelOf('INTERVENTION_TYPES', x.type), detail: x.summary_enc ? decrypt(x.summary_enc) : null, worker: x.worker, meta: { duration: x.duration_minutes, outcome: x.outcome, outcome_label: x.outcome ? O.labelOf('OUTCOMES', x.outcome) : null, location: x.location } });
    for (const x of db.all(`SELECT c.*, u.display_name AS worker FROM calls c JOIN users u ON u.id=c.user_id WHERE client_id=? ${cut('c.started_at')} ORDER BY c.started_at DESC LIMIT ?`, id, ...cutP, per))
      events.push({ kind: 'call', id: x.id, at: x.started_at, title: `${x.direction} ${x.method === 'text' ? 'text message' : 'call'} (${O.labelOf('CALL_CONTACT_TYPES', x.contact_type)})`, detail: x.summary_enc ? decrypt(x.summary_enc) : (x.purpose_enc ? decrypt(x.purpose_enc) : null), worker: x.worker, meta: { duration: x.duration_minutes, outcome: x.outcome, outcome_label: x.outcome ? O.labelOf(x.method === 'text' ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES', x.outcome) : null, crisis: !!x.crisis } });
    for (const x of db.all(`SELECT n.id,n.kind,n.format,n.title_enc,n.occurred_at,n.status,n.source,u.display_name AS worker FROM notes n JOIN users u ON u.id=n.author_id WHERE client_id=? AND deleted_at IS NULL ${cut('n.occurred_at')} ORDER BY n.occurred_at DESC LIMIT ?`, id, ...cutP, per))
      if (x.kind === 'admin' || canClinical) events.push({ kind: 'note', id: x.id, at: x.occurred_at, title: `${x.kind} note: ${x.title_enc ? decrypt(x.title_enc) : O.labelOf('NOTE_FORMATS', x.format)}`, detail: null, worker: x.worker, meta: { status: x.status, note_kind: x.kind, source: x.source } });
    for (const x of db.all(`SELECT r.*, res.name AS resource_name, u.display_name AS worker FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN users u ON u.id=r.user_id WHERE client_id=? ${cut('r.referred_at')} ORDER BY r.referred_at DESC LIMIT ?`, id, ...cutP, per))
      events.push({ kind: 'referral', id: x.id, at: x.referred_at, title: `Referral: ${x.resource_name}`, detail: x.notes_enc ? decrypt(x.notes_enc) : null, worker: x.worker, meta: { status: x.status, outcome: x.outcome_enc ? decrypt(x.outcome_enc) : null } });
    for (const x of db.all(`SELECT t.*, u.display_name AS worker FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE client_id=? ORDER BY COALESCE(t.completed_at, t.due_at, t.created_at) DESC LIMIT ?`, id, per))
      events.push({ kind: x.is_milestone ? 'milestone' : 'task', id: x.id, at: x.completed_at || x.due_at || x.created_at, title: x.title_enc ? decrypt(x.title_enc) : '', detail: x.description_enc ? decrypt(x.description_enc) : null, worker: x.worker, meta: { status: x.status, priority: x.priority, due_at: x.due_at } });
    for (const x of db.all(`SELECT * FROM consents WHERE client_id=? ORDER BY signed_at DESC LIMIT ?`, id, per))
      events.push({ kind: 'consent', id: x.id, at: x.signed_at, title: `Consent: ${x.type.replace(/_/g, ' ')}${x.recipient_enc ? ' → ' + decrypt(x.recipient_enc) : ''}`, detail: x.purpose_enc ? decrypt(x.purpose_enc) : null, meta: { expires_at: x.expires_at, revoked_at: x.revoked_at } });
    if (auth.hasPerm(ctx.user, 'budget:read'))
      for (const x of db.all(`SELECT e.*, f.name AS fund FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE client_id=? ORDER BY e.spent_at DESC LIMIT ?`, id, per))
        events.push({ kind: 'expense', id: x.id, at: x.spent_at, title: `$${x.amount.toFixed(2)} ${x.category.replace(/_/g, ' ')}`, detail: x.description, meta: { fund: x.fund, status: x.status } });
    events.push({ kind: 'milestone', id: 'intake', at: row.intake_date, title: 'Program intake', meta: {} });
    if (row.referral_date) events.push({ kind: 'milestone', id: 'referral', at: row.referral_date, title: 'Referred in', meta: {} });
    if (row.engagement_date) events.push({ kind: 'milestone', id: 'engagement', at: row.engagement_date, title: 'Engaged with services', meta: {} });
    if (row.discharge_date) events.push({ kind: 'milestone', id: 'discharge', at: row.discharge_date, title: `Discharge: ${row.discharge_reason ? (/^[a-z_]+$/.test(row.discharge_reason) ? O.labelOf('DISCHARGE_REASONS', row.discharge_reason) : row.discharge_reason) : ''}`, meta: {} });
    events.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    const page = events.slice(offset, offset + limit);
    audit.log({ user: ctx.user, action: 'client.timeline', entity: 'client', entityId: id, clientId: id, ip: ctx.ip, details: { events: page.length } });
    return { events: page, limit, offset, more: events.length > offset + limit };
  });
};
module.exports.possibleDuplicates = possibleDuplicates;

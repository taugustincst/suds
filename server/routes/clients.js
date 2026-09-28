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

// A client's fields, and what they must satisfy (contact details that can be right; a record closed only by a
// discharge), are the table's rules: server/rules/clients.js, which sync push applies to a device's rows too.
const rules = require('../rules');
const shape = rules.forTable('clients').fields;

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
// Surname and date of birth together: what the person at the desk says about themselves. A phone number alone
// does not tell a worker that a record they cannot open exists (security review of 1.13.0, finding 1: a
// navigator typed numbers into the check and was told who had been discharged, when, and why). A number is
// shared, recycled and easy to guess. It still counts as a match for a record the caller can already open.
const SURNAME_DOB = 'same surname and date of birth';
/** Discharged and nobody's: closed or inactive, no open episode, no active assignment. */
function isDischarged(id) {
  return !!db.one(`SELECT 1 FROM clients c WHERE c.id=? AND c.deleted_at IS NULL AND c.merged_into IS NULL AND c.status IN ('closed','inactive')
    AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.client_id=c.id AND e.status='open')
    AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.client_id=c.id AND ${auth.activeAssignment('a.')})`, id);
}
const canReadmit = (user) => auth.hasPerm(user, 'clients:write') && auth.hasPerm(user, 'episodes:write');
// What a worker who cannot open the record is told: an earlier record exists, and a supervisor will look at
// it. Not its client code, status, discharge date or reason: those come from the stored record, and a
// discharge reason ("incarcerated", "deceased") is itself sensitive.
const OFFER_MESSAGE = 'An earlier record exists for this person. A supervisor will be asked to review it.';
/**
 * Hidden matches this worker may re-admit: on surname and date of birth only, never on a phone number alone,
 * and described by nothing from the stored record (its id, to re-admit it by, and a fixed sentence). Each
 * offer puts a review task on the record for a supervisor (reviewTask, as a hidden duplicate at intake does).
 * A caller holding clients:all can open every record, so nothing is hidden from them and this does not apply:
 * they see the record itself, with its code and status, among the matches.
 */
// The re-admission reason is for the supervisor who reviews it (the review task and the review queue), so it
// has to say something ("walked in", "released from jail") -- not "x". It was 15 characters, the break-glass
// minimum, which is a different act (opening notes outside a role, docs/HIPAA.md); no rule or document asks 15
// of a re-admission, and a worker with the person in front of them wrote padding to reach it (1.14.0).
const READMIT_REASON_MIN = 8;
function readmitOffers(ctx, hidden) {
  if (!canReadmit(ctx.user)) return [];
  return hidden.filter(m => m.reasons.includes(SURNAME_DOB) && isDischarged(m.id)).map(m => {
    reviewTask(ctx.user, m.id, `Earlier record offered for re-admission at intake: review ${m.client_code}`);
    return { id: m.id, reasons: [SURNAME_DOB], message: OFFER_MESSAGE };
  });
}

// A match the caller may not open: 8(c) of the 1.12.4 security review. The duplicate check stays (two
// records for one person is a safety problem), but it must not become a way to ask "is this person a client
// here?": the caller's answer is the same as for no match at all, and a supervisor gets a review task instead.
const mayOpen = (user, id) => auth.canAccessClient(user, id) || auth.hasPerm(user, 'clients:all');
/**
 * One high-priority, unassigned to-do on a record, for a supervisor. Put on a record the creator cannot open,
 * it is on a supervisor's list and not on the creator's. The live duplicate check runs while the worker types,
 * so an open task with the same title, record and creator is not added again.
 */
function reviewTask(user, clientId, title) {
  const open = db.all(`SELECT title_enc FROM tasks WHERE client_id=? AND created_by=? AND assigned_to IS NULL AND priority='high' AND status IN ('open','in_progress')`, clientId, user.id);
  if (open.some(t => { try { return decrypt(t.title_enc) === title; } catch { return false; } })) return;
  db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,priority) VALUES(?,?,?,?,?,?)`, uuid(), clientId, null, user.id, encrypt(title), 'high');
}
/**
 * Record possible duplicates of a new client for a supervisor: audited by code and reason (never names), and
 * one high-priority task to compare them. The task goes on a matching record the creator cannot open when
 * there is one, so it is on a supervisor's list and not on the creator's (its title names both codes).
 */
function flagForReview(user, { id, client_code, matches, source, ip }) {
  if (!matches.length) return;
  audit.log({ user, action: 'client.possible_duplicate', entity: 'client', entityId: id, clientId: id, ip, details: { client_code, matches: matches.map(m => ({ id: m.id, client_code: m.client_code, reasons: m.reasons })), source } });
  const hidden = matches.find(m => !mayOpen(user, m.id));
  reviewTask(user, hidden ? hidden.id : id, `Possible duplicate record: compare ${client_code} with ${matches.map(m => m.client_code).join(', ')}`);
}
// The live check reads other people's records on every call, so it is limited per worker (not per address: an
// office shares one). Plenty for a busy intake desk; too few to walk a list of names and birth dates.
const DUPLICATE_CHECKS = 60; const DUPLICATE_CHECK_WINDOW_MS = 15 * 60_000;

module.exports = (r) => {
  r.get('/api/clients', auth.requireAuth, auth.requirePerm('clients:read', 'clients:list-deidentified'), (ctx) => {
    const deidentify = !auth.hasPerm(ctx.user, 'clients:read');
    const { limit, offset } = paging(ctx.query);
    const where = ['c.deleted_at IS NULL', 'c.merged_into IS NULL']; const params = [];
    const cf = auth.caseloadFilter(ctx.user); where.push(cf.sql); params.push(...cf.params);
    const status = ctx.query.get('status');
    if (status && status !== 'all') { where.push('c.status=?'); params.push(status); }
    const q = (ctx.query.get('q') || '').trim();
    // A name search ranks what it finds (1.15.3): see nameTier below.
    let nameTier = null;
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
        // A word of a compound surname ("Vasquez" for Quintero-Vasquez): its tokens sit after the whole
        // surname's code in name_phonetic_idx (clients-model namePhoneticIndex), so they are looked for in it.
        for (const part of parts) for (const t of M.searchPartTokens(part, { exact: ctx.query.get('exact') === '1' })) { clauses.push('instr(c.name_phonetic_idx, ?) > 0'); params.push(t); }
        if (ctx.query.get('exact') !== '1') {
          for (const part of parts) {
            const pfx = M.namePrefixIndex(part); if (pfx) { clauses.push('c.name_prefix_idx=?'); params.push(pfx); clauses.push('c.first_name_prefix_idx=?'); params.push(pfx); }
            const snd = M.namePhoneticIndex(part); if (snd) { clauses.push('c.name_phonetic_idx=?'); params.push(snd); }
          }
        }
        where.push(`(${clauses.join(' OR ')})`);
        // How well each record matched: 0 the full name, 1 a surname, first name, preferred name or word of a
        // compound surname exactly, 2 the start of a name (its first three letters), 3 only sounds alike
        // (Soundex). A name search is ordered by it (see pageOrder below): exact matches first, then the
        // clients this person worked with lately, then the rest, best match first. Nothing is matched that
        // was not before; only the order changes, except with ?rank=1 below.
        const exactParts = parts.flatMap(p => M.searchPartTokens(p, { exact: true }));
        const prefixes = parts.flatMap(p => [M.namePrefixIndex(p)]).filter(Boolean);
        const inList = (n) => Array(n).fill('?').join(',');
        nameTier = {
          sql: `(CASE WHEN c.full_name_idx IN (?,?) THEN 0
            WHEN c.last_name_idx IN (${inList(idxs.length)}) OR c.first_name_idx IN (${inList(parts.length)}) OR c.preferred_name_idx IN (${inList(parts.length)})${exactParts.map(() => ' OR instr(c.name_phonetic_idx, ?) > 0').join('')} THEN 1
            ${prefixes.length ? `WHEN c.name_prefix_idx IN (${inList(prefixes.length)}) OR c.first_name_prefix_idx IN (${inList(prefixes.length)})${prefixes.map(() => ' OR instr(c.name_phonetic_idx, ?) > 0').join('')} THEN 2` : ''}
            ELSE 3 END)`,
          params: [blindIndex(parts.join('')), blindIndex([...parts].reverse().join('')), ...idxs, ...parts.map(p => blindIndex(p.toLowerCase())), ...parts.map(p => M.preferredNameIndex(p)), ...exactParts, ...prefixes, ...prefixes, ...prefixes],
        };
        // ?rank=1 (the search box at the top of every page) sets a minimum: a record that only sounds like the
        // name is left out when something matched better, so a short list is not padded with look-alikes.
        // When nothing matched better, the sound-alikes are the answer (a misspelling) and stay.
        if (ctx.query.get('rank') === '1') {
          const best = db.one(`SELECT MIN(${nameTier.sql}) t FROM clients c WHERE ${where.join(' AND ')}`, ...nameTier.params, ...params);
          if (best && best.t !== null && best.t < 3) { where.push(`${nameTier.sql} < 3`); params.push(...nameTier.params); }
        }
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
    if (risk && ['high', 'low', 'moderate', 'critical', 'not_assessed'].includes(risk)) addFilter('risk', F.risk(risk));
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
    // The page is found first, computing only what it is sorted by, and the columns that are shown (who is
    // assigned, last contact, overdue to-dos, consent expiry) are then worked out for its rows alone. One query
    // used to work every one of them out for every client in the list before sorting and cutting it to a page:
    // 200 ms for a sort of 20,000 clients, 90 ms to reach page 100 of the default order.
    const now = db.now();
    const LAST_CONTACT = `(SELECT MAX(t) FROM (SELECT MAX(occurred_at) t FROM interventions i WHERE i.client_id=c.id UNION ALL SELECT MAX(started_at) FROM calls ca WHERE ca.client_id=c.id AND ca.outcome IN ('reached','replied')))`;
    const OVERDUE = `(SELECT COUNT(*) FROM tasks t WHERE t.client_id=c.id AND t.status IN ('open','in_progress') AND (CASE WHEN length(t.due_at)=10 THEN t.due_at < date('now','localtime') ELSE t.due_at < ? END))`;
    let sortCols = sort === 'overdue' ? { sql: `, ${OVERDUE} AS overdue_tasks, ${LAST_CONTACT} AS last_contact`, params: [now] }
      : sort === 'last_contact' || sort === 'risk' ? { sql: `, ${LAST_CONTACT} AS last_contact`, params: [] } : { sql: '', params: [] };
    let pageOrder = order;
    if (nameTier && !sort) {
      // This person's recent clients: the same activity Home's "Recent clients" is drawn from (only ever used
      // to order rows the caseload filter above already allows).
      const recent = db.all(`SELECT client_id FROM audit_log WHERE user_id=? AND client_id IS NOT NULL AND action IN ('client.view','client.create','client.update','intervention.create','call.create','note.create','note.update') GROUP BY client_id ORDER BY MAX(at) DESC LIMIT 20`, ctx.user.id).map(x => x.client_id);
      sortCols = { sql: `, ${nameTier.sql} AS match_tier, (c.id IN (SELECT value FROM json_each(?))) AS is_recent`, params: [...nameTier.params, JSON.stringify(recent)] };
      // Exact name matches (tiers 0 and 1), then recent clients, then everyone else; within each, best match.
      pageOrder = 'CASE WHEN match_tier <= 1 THEN 0 WHEN is_recent THEN 1 ELSE 2 END, match_tier, is_recent DESC, c.updated_at DESC';
    }
    const pageIds = db.all(`SELECT c.id ${sortCols.sql} FROM clients c ${w} ORDER BY ${pageOrder}, c.id LIMIT ? OFFSET ?`, ...sortCols.params, ...params, limit, offset).map(x => x.id);
    const byId = new Map(db.all(`SELECT c.*, (SELECT GROUP_CONCAT(u.display_name, ', ') FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.client_id=c.id AND ${auth.activeAssignment('a.')}) AS assigned_workers,
      ${LAST_CONTACT} AS last_contact, ${OVERDUE} AS overdue_tasks
      ${consentWindow ? `, (SELECT MIN(co.expires_at) FROM consents co WHERE co.client_id=c.id AND co.revoked_at IS NULL AND co.expires_at BETWEEN ? AND ?) AS consent_expires_at` : ''}
      FROM clients c WHERE c.id IN (SELECT value FROM json_each(?))`, now, ...(consentWindow ? [consentWindow.from, consentWindow.to] : []), JSON.stringify(pageIds)).map(x => [x.id, x]));
    const rows = pageIds.map(id => byId.get(id));
    const total = db.one(`SELECT COUNT(*) n FROM clients c ${w}`, ...params).n;
    audit.log({ user: ctx.user, action: 'client.list', ip: ctx.ip, details: { q: q ? '[redacted]' : '', status, sort: sort || undefined, filters: filters.length ? filters : undefined, offset: offset || undefined, count: rows.length, deidentified: deidentify } });
    return { clients: rows.map(x => ({ ...M.summary(x, { deidentify }), assigned_workers: x.assigned_workers, last_contact: x.last_contact, overdue_tasks: x.overdue_tasks, ...(consentWindow ? { consent_expires_at: x.consent_expires_at } : {}) })), total, limit, offset };
  });

  // Check before entering, so the worker sees the match while they are still typing.
  r.post('/api/clients/check-duplicates', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    if (!require('../app').rateLimit(`duplicate-check:${ctx.user.id}`, DUPLICATE_CHECKS, DUPLICATE_CHECK_WINDOW_MS)) {
      audit.log({ user: ctx.user, action: 'client.duplicate_check', ip: ctx.ip, success: false, details: { reason: 'rate limited' } });
      throw new HttpError(429, 'Too many duplicate checks. Wait a few minutes; the check is made again when the client is saved.');
    }
    const v = validate(ctx.body, { first_name: { type: 'string', maxLen: 100 }, last_name: { type: 'string', maxLen: 100 }, dob: { type: 'date' }, phone: { type: 'string', maxLen: 40 }, exclude_id: { type: 'string' } });
    const all = possibleDuplicates(v, v.exclude_id || null);
    const matches = all.filter(m => mayOpen(ctx.user, m.id));
    const hidden = all.filter(m => !mayOpen(ctx.user, m.id));
    const readmit = readmitOffers(ctx, hidden);
    // Every check is audited, found or not: which details were given (never their values) and what matched.
    audit.log({ user: ctx.user, action: 'client.duplicate_check', ip: ctx.ip, details: { asked: ['first_name', 'last_name', 'dob', 'phone'].filter(k => v[k]), matches: all.length, hidden: hidden.length, shown: matches.map(m => m.client_code), readmit_offered: readmit.length ? readmit.map(m => hidden.find(x => x.id === m.id).client_code) : undefined } });
    // No count of the matches the caller cannot open: that answered "is this person a client here?".
    return { matches, readmit };
  });

  r.post('/api/clients', auth.requireAuth, auth.requirePerm('clients:write'), (ctx) => {
    const v = validate(ctx.body, { ...shape, confirm_duplicate: { type: 'boolean' }, no_episode: { type: 'boolean' } });
    rules.assertWrite('clients', rules.toColumns('clients', v), ctx);
    // Refuse a likely duplicate unless the worker has looked at the match and said it is a different person.
    if (!v.confirm_duplicate) {
      // Exactly the filter /check-duplicates applies: a match the caller can open is shown; one they cannot is
      // neither shown nor counted (the intake goes ahead and a supervisor is asked to compare, below). The
      // check is audited before anything is returned, whichever way it goes: it reads other people's records.
      const all = possibleDuplicates(v);
      const visible = all.filter(m => mayOpen(ctx.user, m.id));
      const readmit = readmitOffers(ctx, all.filter(m => !visible.includes(m)));
      if (all.length) audit.log({ user: ctx.user, action: 'client.duplicate_check', ip: ctx.ip, details: { matches: all.length, hidden: all.length - visible.length, shown: visible.map(m => m.client_code), readmit_offered: readmit.length ? readmit.map(m => all.find(x => x.id === m.id).client_code) : undefined } });
      if (visible.length) throw badRequest('A client with these details may already exist', { duplicates: visible, readmit, confirm_field: 'confirm_duplicate' });
      if (readmit.length) throw badRequest('An earlier record exists for this person and they were discharged. Re-admit it to carry on their record rather than starting a new one.', { readmit, confirm_field: 'confirm_duplicate' });
    }
    delete v.confirm_duplicate;
    const noEpisode = !!v.no_episode; delete v.no_episode;
    const id = uuid();
    const enc = M.encryptFields(v);
    enc.full_name_idx = blindIndex((v.last_name || '') + (v.first_name || ''));
    const cols = { id, client_code: M.nextClientCode(), ...enc, created_by: ctx.user.id };
    for (const f of M.PLAIN_FIELDS) if (v[f] !== undefined) cols[f] = v[f];
    if (!cols.intake_date) cols.intake_date = new Date().toISOString().slice(0, 10);
    // Risk is somebody's judgement, never a default (QA 1.15.3): the column's schema DEFAULT 'moderate' stored
    // every client created without one as Moderate. Not given means not assessed (NULL, shown "Not assessed").
    if (cols.risk_level === undefined) cols.risk_level = null;
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
    // Matches the creator cannot open (whether or not they confirmed a visible one): a supervisor compares.
    flagForReview(ctx.user, { id, client_code: cols.client_code, matches: possibleDuplicates(v, id).filter(m => !mayOpen(ctx.user, m.id)), source: 'intake', ip: ctx.ip });
    ctx.status = 201;
    return { id, client_code: cols.client_code, episode_id: episodeId };
  });

  // Re-admit a discharged client found by the intake duplicate check (see the comment above readmitOffers).
  // The caller proves they are dealing with this person by sending the details that matched (surname and
  // date of birth; a phone number only for a record they can already open), not just an id, and says why; the record must be discharged and on
  // nobody's caseload. Everything else about access is unchanged: this is the only door, and it is logged
  // and reviewed.
  r.post('/api/clients/:id/readmit', auth.requireAuth, auth.requirePerm('clients:write'), auth.requirePerm('episodes:write'), (ctx) => {
    const v = validate(ctx.body, { first_name: { type: 'string', maxLen: 100 }, last_name: { type: 'string', maxLen: 100 }, dob: { type: 'date' }, phone: { type: 'string', maxLen: 40 },
      reason: { type: 'string', required: true, maxLen: 300 }, referral_source: { type: 'string', maxLen: 120 } });
    const why = v.reason.trim();
    if (why.length < READMIT_REASON_MIN) throw badRequest(`Say why you are re-admitting this person (at least ${READMIT_REASON_MIN} characters, for example "walked in") — a supervisor reviews every re-admission`, { fields: { reason: `must be at least ${READMIT_REASON_MIN} characters` } });
    const row = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL AND merged_into IS NULL`, ctx.params.id);
    if (!row) throw notFound('Client not found');
    const match = possibleDuplicates(v).find(m => m.id === row.id);
    // Someone who cannot open the record proves they are dealing with this person by surname and date of
    // birth, as the offer was made (readmitOffers); a phone number is enough only for a record they can open.
    const proven = match && (mayOpen(ctx.user, row.id) ? strongMatch(match) : match.reasons.includes(SURNAME_DOB));
    if (!proven) {
      audit.log({ user: ctx.user, action: 'authz.denied', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, success: false, details: { reason: 'readmit: details do not match the record' } });
      throw forbidden('Those details do not match that record. Enter the surname and date of birth as the person gives them.');
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
      for (const col of ['dob_enc', 'phone_enc', 'alt_phone_enc', 'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc', 'preferred_name_enc', 'goals_enc', 'flags_enc', 'contact_preferences_enc']) {
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
      // Why the duplicate went: free text that can describe the person, so encrypted on the merged-away row.
      db.run(`UPDATE clients SET merged_into=?, status='closed', deleted_at=?, removed_reason_enc=?, updated_at=? WHERE id=?`, keep.id, db.now(), v.reason ? encrypt(v.reason) : null, db.now(), source.id);
      moved._filled_fields = keys.length;
    });
    // The detail of what moved is structural, never PHI; the reason is on the merged-away row, encrypted.
    audit.log({ user: ctx.user, action: 'client.merge', entity: 'client', entityId: keep.id, clientId: keep.id, ip: ctx.ip, details: { merged: source.id, merged_code: source.client_code, moved, reason_recorded: v.reason ? true : undefined } });
    audit.log({ user: ctx.user, action: 'client.merged_away', entity: 'client', entityId: source.id, clientId: source.id, ip: ctx.ip, details: { into: keep.id } });
    return { ok: true, kept: keep.id, merged: source.id, moved };
  });

  r.get('/api/clients/:id', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    const client = M.decryptRow(row);
    client.days_to_engagement = M.daysToEngagement(client);
    client.assignments = db.all(`SELECT a.*, u.display_name, u.role AS user_role FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.client_id=? ORDER BY a.end_date IS NOT NULL, a.start_date DESC`, row.id)
      .map(a => ({ ...a, notes: a.notes_enc ? decrypt(a.notes_enc) : null, notes_enc: undefined }));
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
      // For the record's module tabs, which show only when the module is on and has something on this record
      // or the reader may add to it (public/views/client.js): counts only, for a role that may read them.
      problems: auth.hasPerm(ctx.user, 'careplan:read') ? db.one(`SELECT COUNT(*) n FROM problems WHERE client_id=?`, row.id).n : null,
      goals: auth.hasPerm(ctx.user, 'careplan:read') ? db.one(`SELECT COUNT(*) n FROM care_plan_goals WHERE client_id=?`, row.id).n : null,
      assessments: auth.hasPerm(ctx.user, 'assessments:read') ? db.one(`SELECT (SELECT COUNT(*) FROM asam_assessments WHERE client_id=?) + (SELECT COUNT(*) FROM outcome_measures WHERE client_id=?) n`, row.id, row.id).n : null,
      suprt: db.one(`SELECT COUNT(*) n FROM suprt_assessments WHERE client_id=?`, row.id).n,
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
    // Contact details, and closing a client only by a discharge (the Episodes tab): the table's rules.
    rules.assertWrite('clients', { id: row.id, ...rules.toColumns('clients', v) }, ctx, { existing: row });
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
    // The reason (a matter, a request, often naming people) is kept encrypted on the record; the audit entry
    // says only whether one was given, because audit details are plaintext and travel in auditor exports.
    if (v.hold) db.run(`UPDATE clients SET legal_hold=1, legal_hold_reason_enc=?, updated_at=? WHERE id=?`, encrypt(v.reason), db.now(), row.id);
    else db.run(`UPDATE clients SET legal_hold=0, legal_hold_reason_enc=NULL, legal_hold_cleared_reason_enc=?, updated_at=? WHERE id=?`, v.reason ? encrypt(v.reason) : null, db.now(), row.id);
    audit.log({ user: ctx.user, action: v.hold ? 'client.legal_hold.set' : 'client.legal_hold.clear', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, details: { reason_recorded: v.reason ? true : undefined } });
    return { ok: true, legal_hold: v.hold ? 1 : 0 };
  });

  r.delete('/api/clients/:id', auth.requireAuth, auth.requirePerm('clients:all'), (ctx) => {
    const row = loadClient(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, 'clients:write')) throw forbidden();
    if (row.legal_hold) throw badRequest('This record is on legal hold and cannot be deleted until the hold is cleared');
    const { reason } = validate(ctx.body || {}, { reason: { type: 'string', required: true, maxLen: 300 } });
    db.run(`UPDATE clients SET deleted_at=?, removed_reason_enc=?, updated_at=? WHERE id=?`, db.now(), encrypt(reason), db.now(), row.id);
    audit.log({ user: ctx.user, action: 'client.delete', entity: 'client', entityId: row.id, clientId: row.id, ip: ctx.ip, details: { reason_recorded: true } });
    return { ok: true };
  });

  // Unified timeline for a client: interventions, calls, notes (metadata only), referrals, tasks/milestones, consents, expenditures
  // O.cached: each list's labels are read once for the whole timeline, not once per event.
  r.get('/api/clients/:id/timeline', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => O.cached(() => {
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
    // Every kind's most recent rows are merged and sorted by date, and only the page's are then built: the
    // summaries, titles and recipients are decrypted (and list labels looked up) for the events shown, not for
    // every row fetched to find them (page 5 of a long history decrypted 2,500 values to show 100).
    const events = [];
    const add = (at, build) => events.push({ at, build });
    for (const x of db.all(`SELECT i.*, u.display_name AS worker FROM interventions i JOIN users u ON u.id=i.user_id WHERE client_id=? ${cut('i.occurred_at')} ORDER BY i.occurred_at DESC LIMIT ?`, id, ...cutP, per))
      add(x.occurred_at, () => ({ kind: 'intervention', id: x.id, at: x.occurred_at, title: O.labelOf('INTERVENTION_TYPES', x.type), detail: x.summary_enc ? decrypt(x.summary_enc) : null, worker: x.worker, meta: { duration: x.duration_minutes, outcome: x.outcome, outcome_label: x.outcome ? O.labelOf('OUTCOMES', x.outcome) : null, location: x.location } }));
    for (const x of db.all(`SELECT c.*, u.display_name AS worker FROM calls c JOIN users u ON u.id=c.user_id WHERE client_id=? ${cut('c.started_at')} ORDER BY c.started_at DESC LIMIT ?`, id, ...cutP, per))
      add(x.started_at, () => ({ kind: 'call', id: x.id, at: x.started_at, title: `${x.direction} ${x.method === 'text' ? 'text message' : 'call'} (${O.labelOf('CALL_CONTACT_TYPES', x.contact_type)})`, detail: x.summary_enc ? decrypt(x.summary_enc) : (x.purpose_enc ? decrypt(x.purpose_enc) : null), worker: x.worker, meta: { duration: x.duration_minutes, outcome: x.outcome, outcome_label: x.outcome ? O.labelOf(x.method === 'text' ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES', x.outcome) : null, crisis: !!x.crisis } }));
    for (const x of db.all(`SELECT n.id,n.kind,n.format,n.title_enc,n.occurred_at,n.status,n.source,u.display_name AS worker FROM notes n JOIN users u ON u.id=n.author_id WHERE client_id=? AND deleted_at IS NULL ${cut('n.occurred_at')} ORDER BY n.occurred_at DESC LIMIT ?`, id, ...cutP, per))
      if (x.kind === 'admin' || canClinical) add(x.occurred_at, () => ({ kind: 'note', id: x.id, at: x.occurred_at, title: `${x.kind} note: ${x.title_enc ? decrypt(x.title_enc) : O.labelOf('NOTE_FORMATS', x.format)}`, detail: null, worker: x.worker, meta: { status: x.status, note_kind: x.kind, source: x.source } }));
    for (const x of db.all(`SELECT r.*, res.name AS resource_name, u.display_name AS worker FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN users u ON u.id=r.user_id WHERE client_id=? ${cut('r.referred_at')} ORDER BY r.referred_at DESC LIMIT ?`, id, ...cutP, per))
      add(x.referred_at, () => ({ kind: 'referral', id: x.id, at: x.referred_at, title: `Referral: ${x.resource_name}`, detail: x.notes_enc ? decrypt(x.notes_enc) : null, worker: x.worker, meta: { status: x.status, outcome: x.outcome_enc ? decrypt(x.outcome_enc) : null } }));
    for (const x of db.all(`SELECT t.*, u.display_name AS worker FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE client_id=? ORDER BY COALESCE(t.completed_at, t.due_at, t.created_at) DESC LIMIT ?`, id, per))
      add(x.completed_at || x.due_at || x.created_at, () => ({ kind: x.is_milestone ? 'milestone' : 'task', id: x.id, at: x.completed_at || x.due_at || x.created_at, title: x.title_enc ? decrypt(x.title_enc) : '', detail: x.description_enc ? decrypt(x.description_enc) : null, worker: x.worker, meta: { status: x.status, priority: x.priority, due_at: x.due_at } }));
    for (const x of db.all(`SELECT * FROM consents WHERE client_id=? ORDER BY signed_at DESC LIMIT ?`, id, per))
      add(x.signed_at, () => ({ kind: 'consent', id: x.id, at: x.signed_at, title: `Consent: ${x.type.replace(/_/g, ' ')}${x.recipient_enc ? ' → ' + decrypt(x.recipient_enc) : ''}`, detail: x.purpose_enc ? decrypt(x.purpose_enc) : null, meta: { expires_at: x.expires_at, revoked_at: x.revoked_at } }));
    if (auth.hasPerm(ctx.user, 'budget:read'))
      for (const x of db.all(`SELECT e.*, f.name AS fund FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE client_id=? ORDER BY e.spent_at DESC LIMIT ?`, id, per))
        add(x.spent_at, () => ({ kind: 'expense', id: x.id, at: x.spent_at, title: `$${x.amount.toFixed(2)} ${x.category.replace(/_/g, ' ')}`, detail: x.description_enc ? decrypt(x.description_enc) : null, meta: { fund: x.fund, status: x.status } }));
    add(row.intake_date, () => ({ kind: 'milestone', id: 'intake', at: row.intake_date, title: 'Program intake', meta: {} }));
    if (row.referral_date) add(row.referral_date, () => ({ kind: 'milestone', id: 'referral', at: row.referral_date, title: 'Referred in', meta: {} }));
    if (row.engagement_date) add(row.engagement_date, () => ({ kind: 'milestone', id: 'engagement', at: row.engagement_date, title: 'Engaged with services', meta: {} }));
    if (row.discharge_date) add(row.discharge_date, () => ({ kind: 'milestone', id: 'discharge', at: row.discharge_date, title: `Discharge: ${row.discharge_reason ? (/^[a-z_]+$/.test(row.discharge_reason) ? O.labelOf('DISCHARGE_REASONS', row.discharge_reason) : row.discharge_reason) : ''}`, meta: {} }));
    events.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    const page = events.slice(offset, offset + limit).map(e => e.build());
    audit.log({ user: ctx.user, action: 'client.timeline', entity: 'client', entityId: id, clientId: id, ip: ctx.ip, details: { events: page.length } });
    return { events: page, limit, offset, more: events.length > offset + limit };
  }));
};
module.exports.possibleDuplicates = possibleDuplicates;
module.exports.flagForReview = flagForReview;
module.exports.mayOpen = mayOpen;

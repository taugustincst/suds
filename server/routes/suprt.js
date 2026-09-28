'use strict';
// SUPRT-A records for a State Opioid Response grant (server/suprt.js, docs/compliance/SUPRT.md): each client's
// assessments, what is due on the to-do lists, completion rates, and the file for entry into SPARS.
//
// Who may do what: whoever may read a client's record (clients:read, within their caseload) reads its SUPRT-A
// assessments; whoever may change it (clients:write) records them, while the module is on (server/programme.js
// 'suprt'); the due list and the completion rates cover the caseload a role can open. The SPARS entry file
// names clients, so it is a disclosure: export:identified (supervisor, administrator), through the disclosure
// gate (server/disclosure.js), with one accounting row per client in it.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const S = require('../suprt');
const { requireModule } = require('../programme');
const { badRequest, notFound, HttpError } = require('../http');
const { validate } = require('../validate');
const { encrypt, decrypt, uuid } = require('../crypto');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dec = (v) => { if (!v) return null; try { return decrypt(v); } catch { return null; } };
const answersOf = (row) => { try { return JSON.parse(dec(row.answers_enc) || '{}'); } catch { return {}; } };

function clientFor(ctx, clientId) {
  const c = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL`, clientId);
  if (!c) throw notFound('Client not found');
  auth.assertClientAccess(ctx, clientId);
  return c;
}
const fieldError = (field, message) => badRequest('Validation failed', { fields: { [field]: message } });

/** A client's assessments, oldest first. */
const assessmentsOf = (clientId) => db.all(`SELECT * FROM suprt_assessments WHERE client_id=? ORDER BY assessment_date, created_at`, clientId);
/** Services ended: a closed, inactive or deceased client with a discharge date. */
const dischargeOf = (c) => (c && ['closed', 'inactive', 'deceased'].includes(c.status) && c.discharge_date ? String(c.discharge_date).slice(0, 10) : null);
/** The first SOR-funded service after `after` (a date, or '' for any). */
function firstSorService(clientId, after = '') {
  const r = db.one(`SELECT MIN(substr(i.occurred_at,1,10)) d FROM interventions i JOIN funding_sources f ON f.id=i.funding_source_id WHERE i.client_id=? AND f.source_type='sor_grant' AND substr(i.occurred_at,1,10) > ?`, clientId, after);
  return (r && r.d) || null;
}

/**
 * The client's current SUPRT cycle: the latest baseline, what followed it, and its closeout if any; and the
 * schedule of what is due (server/suprt.js schedule), with a baseline needed when the client received a
 * SOR-funded service and has no cycle open.
 */
function cycleOf(c, rows = assessmentsOf(c.id), on = S.today()) {
  const complete = rows.filter(r => r.status === 'complete');
  const baselines = complete.filter(r => r.assessment_type === 'baseline');
  const baseline = baselines.length ? baselines[baselines.length - 1] : null;
  const after = baseline ? complete.filter(r => r.assessment_date >= baseline.assessment_date && r !== baseline) : [];
  const closeoutRow = after.find(r => r.assessment_type === 'closeout') || null;
  const closeout = closeoutRow ? closeoutRow.assessment_date : null;
  const due = baseline ? S.schedule({ baseline: baseline.assessment_date, done: after.map(r => ({ type: r.assessment_type, date: r.assessment_date })), closeout, discharge: dischargeOf(c), on, reassessDays: S.reassessmentDays() }) : [];
  // A baseline is needed once the client has had a SOR-funded service and no cycle is open (none yet, or the
  // last one closed out before this service).
  if (!baseline || closeout) {
    const first = firstSorService(c.id, closeout || '');
    if (first) {
      const closes = S.addDays(first, S.ENTRY_DAYS);
      due.push({ type: 'baseline', occurrence: 1, due: closes, opens: first, closes, status: 'open', overdue: on > closes, done_date: null, in_window: false, first_sor_service: first });
    }
  }
  const last = [...complete].reverse().find(r => r.assessment_date <= on) || null;
  return { baseline: baseline ? baseline.assessment_date : null, closeout, due, last_date: last ? last.assessment_date : null };
}

/** The previous completed assessment before `date` in the same cycle: what "since the last assessment" means. */
function previousDate(clientId, date, exceptId = null) {
  const r = db.one(`SELECT MAX(assessment_date) d FROM suprt_assessments WHERE client_id=? AND status='complete' AND assessment_date < ? AND id IS NOT ?`, clientId, date, exceptId);
  return (r && r.d) || null;
}

function present(row) {
  const answers = answersOf(row);
  return { id: row.id, client_id: row.client_id, assessment_type: row.assessment_type, assessment_date: row.assessment_date, status: row.status, answers,
    derived_keys: String(row.derived_keys || '').split(',').filter(Boolean), exported_at: row.exported_at, created_at: row.created_at, updated_at: row.updated_at,
    missing: S.cleanAnswers(row.assessment_type, answers).missing };
}

/** Checks the new or changed assessment against the client's others: the order of a cycle. */
function checkOrder(clientId, type, date, exceptId = null) {
  const others = assessmentsOf(clientId).filter(r => r.id !== exceptId && r.status === 'complete');
  const baselines = others.filter(r => r.assessment_type === 'baseline' && r.assessment_date <= date);
  const baseline = baselines.length ? baselines[baselines.length - 1] : null;
  const closedAfter = baseline ? others.find(r => r.assessment_type === 'closeout' && r.assessment_date >= baseline.assessment_date && r.assessment_date <= date) : null;
  if (type === 'baseline') {
    if (baseline && !closedAfter) throw fieldError('assessment_type', `a baseline is already on file (${baseline.assessment_date}) and its cycle has not been closed out: record a reassessment, annual assessment or closeout instead`);
    return;
  }
  if (!baseline) throw fieldError('assessment_type', 'record the baseline first: a reassessment, annual assessment or closeout follows one');
  if (closedAfter) throw fieldError('assessment_type', `this client's cycle was closed out on ${closedAfter.assessment_date}; record a new baseline if they are receiving SOR-funded services again`);
}

/**
 * The record-management answers that are the record's own, whatever the form sent: the client code, the
 * programme's grant and site IDs (Settings, as they are when it is saved) and the assessment's type and date.
 */
function recordManagement(c, type, date) {
  const grant = db.getSetting('suprt_grant_id', '') || undefined; const site = db.getSetting('suprt_site_id', '') || undefined;
  return { A_client_id: c.client_code, ...(grant ? { A_grant_id: grant } : {}), ...(site ? { A_site_id: site } : {}), A_assessment_type: type, A_assessment_date: date };
}

// The fields of an assessment, and what a new or changed one must satisfy (not dated in the future, answers the
// instrument asks, complete only with every required answer and in the order of a cycle, never deleted once in a
// SPARS file): the table's rules, server/rules/suprt_assessments.js, which sync push applies to a device's too.
const rules = require('../rules');
const shape = rules.forTable('suprt_assessments').fields;

/** Which saved answers are the client record's own (they equal what SUDS would pre-fill today). */
function derivedKeys(clientId, type, date, answers, exceptId) {
  const d = S.derive(clientId, { type, date, since: previousDate(clientId, date, exceptId) });
  return d.derived.filter(k => answers[k] !== undefined && answers[k] === d.answers[k]).join(',') || null;
}

/** The clients a role's due list and completion rates cover: SUPRT clients within the caseload it can open. */
function scopedClients(ctx, { mine = false, whole = false } = {}) {
  const cf = whole ? { sql: '1=1', params: [] } : auth.caseloadFilter(ctx.user, 'c.id');
  const mineSql = mine ? ` AND c.id IN (SELECT client_id FROM assignments WHERE user_id=? AND ${auth.activeAssignment()})` : '';
  return db.all(`SELECT c.* FROM clients c WHERE c.deleted_at IS NULL AND c.merged_into IS NULL AND ${cf.sql}${mineSql}
      AND (c.id IN (SELECT client_id FROM suprt_assessments) OR c.id IN (SELECT i.client_id FROM interventions i JOIN funding_sources f ON f.id=i.funding_source_id WHERE f.source_type='sor_grant'))
    ORDER BY c.client_code`, ...cf.params, ...(mine ? [ctx.user.id] : []));
}

module.exports = (r) => {
  // What the form asks, and when: the items, sections and assessment points. No client data.
  r.get('/api/suprt/items', auth.requireAuth, () => ({ types: S.TYPES.map(t => ({ value: t, label: S.TYPE_LABEL[t] })), sections: S.SECTIONS, items: S.ITEMS,
    window_days: S.WINDOW_DAYS, reassessment_days: S.reassessmentDays(), grant_id: db.getSetting('suprt_grant_id', '') || null, site_id: db.getSetting('suprt_site_id', '') || null,
    export_note: S.EXPORT_NOTE, default_recipient: S.DEFAULT_RECIPIENT, default_purpose: S.DEFAULT_PURPOSE, export_bases: S.EXPORT_BASES }));

  r.get('/api/clients/:id/suprt', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const c = clientFor(ctx, ctx.params.id);
    const rows = assessmentsOf(c.id);
    audit.log({ user: ctx.user, action: 'suprt.view', entity: 'client', entityId: c.id, clientId: c.id, ip: ctx.ip, details: { count: rows.length } });
    return { rows: rows.map(present), cycle: cycleOf(c, rows) };
  });

  // What SUDS already knows for a new assessment: shown pre-filled in the form, every answer editable.
  r.get('/api/clients/:id/suprt/prefill', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const c = clientFor(ctx, ctx.params.id);
    const type = ctx.query.get('type') || 'baseline'; const date = ctx.query.get('date') || S.today();
    if (!S.TYPES.includes(type)) throw badRequest(`type must be one of ${S.TYPES.join(', ')}`);
    if (!DAY.test(date)) throw badRequest('date must be a date (YYYY-MM-DD)');
    const since = type === 'baseline' ? null : previousDate(c.id, date);
    const d = S.derive(c.id, { type, date, since });
    audit.log({ user: ctx.user, action: 'suprt.prefill', entity: 'client', entityId: c.id, clientId: c.id, ip: ctx.ip, details: { type, date, derived: d.derived.length } });
    return { type, date, since, ...d };
  });

  r.post('/api/clients/:id/suprt', auth.requireAuth, auth.requirePerm('clients:write'), requireModule('suprt'), (ctx) => {
    const c = clientFor(ctx, ctx.params.id);
    const v = validate(ctx.body || {}, shape);
    const status = v.status || 'draft';
    rules.assertWrite('suprt_assessments', { client_id: c.id, assessment_type: v.assessment_type, assessment_date: v.assessment_date, status, answers_enc: v.answers || {} }, ctx);
    const clean = S.cleanAnswers(v.assessment_type, v.answers || {});
    // The assessment's own type and date are what the record says, whatever the form sent.
    const answers = { ...clean.answers, ...recordManagement(c, v.assessment_type, v.assessment_date) };
    const missing = S.cleanAnswers(v.assessment_type, answers).missing;
    const id = uuid(); const now = db.now();
    db.run(`INSERT INTO suprt_assessments(id,client_id,assessment_type,assessment_date,status,answers_enc,derived_keys,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, c.id, v.assessment_type, v.assessment_date, status, encrypt(JSON.stringify(answers)), derivedKeys(c.id, v.assessment_type, v.assessment_date, answers, id), ctx.user.id, ctx.user.id, now, now);
    audit.log({ user: ctx.user, action: 'suprt.create', entity: 'suprt_assessment', entityId: id, clientId: c.id, ip: ctx.ip, details: { type: v.assessment_type, status, answered: Object.keys(answers).length, missing: missing.length || undefined } });
    ctx.status = 201;
    return present(db.one(`SELECT * FROM suprt_assessments WHERE id=?`, id));
  });

  r.put('/api/suprt/:id', auth.requireAuth, auth.requirePerm('clients:write'), requireModule('suprt'), (ctx) => {
    const row = db.one(`SELECT * FROM suprt_assessments WHERE id=?`, ctx.params.id);
    if (!row) throw notFound('Assessment not found');
    const c = clientFor(ctx, row.client_id);
    const v = validate(ctx.body || {}, { assessment_date: { type: 'date' }, status: { type: 'string', enum: ['draft', 'complete'] }, answers: { type: 'object' } });
    const date = v.assessment_date || row.assessment_date;
    const status = v.status || row.status;
    rules.assertWrite('suprt_assessments', { id: row.id, assessment_date: date, status, answers_enc: v.answers === undefined ? answersOf(row) : v.answers }, ctx, { existing: row });
    const clean = S.cleanAnswers(row.assessment_type, v.answers === undefined ? answersOf(row) : v.answers);
    const answers = { ...clean.answers, ...recordManagement(c, row.assessment_type, date) };
    db.run(`UPDATE suprt_assessments SET assessment_date=?, status=?, answers_enc=?, derived_keys=?, updated_by=?, updated_at=? WHERE id=?`,
      date, status, encrypt(JSON.stringify(answers)), derivedKeys(c.id, row.assessment_type, date, answers, row.id), ctx.user.id, db.now(), row.id);
    audit.log({ user: ctx.user, action: 'suprt.update', entity: 'suprt_assessment', entityId: row.id, clientId: c.id, ip: ctx.ip, details: { type: row.assessment_type, status, was_exported: row.exported_at ? true : undefined } });
    return present(db.one(`SELECT * FROM suprt_assessments WHERE id=?`, row.id));
  });

  r.delete('/api/suprt/:id', auth.requireAuth, auth.requirePerm('clients:write'), requireModule('suprt'), (ctx) => {
    const row = db.one(`SELECT * FROM suprt_assessments WHERE id=?`, ctx.params.id);
    if (!row) throw notFound('Assessment not found');
    clientFor(ctx, row.client_id);
    // One already put in a SPARS entry file stays: the accounting of disclosures points at it (the table's rules).
    rules.assertEditable('suprt_assessments', ctx, row, { deleting: true });
    db.run(`DELETE FROM suprt_assessments WHERE id=?`, row.id); db.tombstone('suprt_assessments', row.id);
    audit.log({ user: ctx.user, action: 'suprt.delete', entity: 'suprt_assessment', entityId: row.id, clientId: row.client_id, ip: ctx.ip, details: { type: row.assessment_type, status: row.status } });
    return { ok: true };
  });

  // The to-do list: what is due now (open windows, overdue ones, baselines and closeouts owed), for the
  // caseload this role can open. mine=1: only clients assigned to the caller.
  r.get('/api/suprt/due', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const on = S.today(); const mine = ctx.query.get('mine') === '1';
    const rows = [];
    for (const c of scopedClients(ctx, { mine })) {
      const cy = cycleOf(c, assessmentsOf(c.id), on);
      for (const e of cy.due) {
        if (!['open', 'missed'].includes(e.status) || (e.status === 'missed' && e.type !== 'closeout')) continue;
        rows.push({ client_id: c.id, client_code: c.client_code, name: [dec(c.first_name_enc), dec(c.last_name_enc)].filter(Boolean).join(' '), ...e });
      }
    }
    const workers = new Map();
    for (const a of db.all(`SELECT a.client_id, u.display_name FROM assignments a JOIN users u ON u.id=a.user_id WHERE ${auth.activeAssignment('a.')}`)) {
      if (!workers.has(a.client_id)) workers.set(a.client_id, []);
      workers.get(a.client_id).push(a.display_name);
    }
    for (const x of rows) x.workers = workers.get(x.client_id) || [];
    rows.sort((a, b) => a.due.localeCompare(b.due) || a.client_code.localeCompare(b.client_code));
    audit.log({ user: ctx.user, action: 'suprt.due.view', ip: ctx.ip, details: { rows: rows.length, mine: mine || undefined } });
    return { today: on, rows, overdue: rows.filter(x => x.overdue || x.status === 'missed').length };
  });

  // Completion rates per period: of the assessments due in the period whose window has closed (or that were
  // done), how many were done within their window. Counts of the caseload a role can open.
  // Whoever writes the funder report (reports:funder: finance) reads the rates too (1.16.0): counts of the whole
  // programme's assessments, no client data, as its funder report is. Anyone else needs clients:read and counts
  // the caseload they can open.
  r.get('/api/suprt/completion', auth.requireAuth, (ctx) => {
    const clientLevel = auth.hasPerm(ctx.user, 'clients:read');
    if (!clientLevel && !auth.submissionRunAllowed(ctx.user)) {
      audit.log({ user: ctx.user, action: 'authz.denied', ip: ctx.ip, success: false, details: { perms: ['clients:read|reports:funder'], path: ctx.path } });
      throw require('../http').forbidden();
    }
    const whole = !clientLevel;
    const on = S.today();
    const to = ctx.query.get('to') || on; const from = ctx.query.get('from') || S.addDays(to, -89);
    if (!DAY.test(from) || !DAY.test(to)) throw badRequest('from and to must be dates (YYYY-MM-DD)');
    const blank = () => ({ due: 0, done_in_window: 0, done_outside_window: 0, missed: 0, still_open: 0 });
    const by = Object.fromEntries(['reassessment', 'annual', 'closeout'].map(t => [t, blank()]));
    let baselines = 0; let baselinesOwed = 0;
    for (const c of scopedClients(ctx, { whole })) {
      const rows = assessmentsOf(c.id);
      baselines += rows.filter(x => x.status === 'complete' && x.assessment_type === 'baseline' && x.assessment_date >= from && x.assessment_date <= to).length;
      const cy = cycleOf(c, rows, on);
      for (const e of cy.due) {
        if (e.type === 'baseline') { if (e.opens <= to) baselinesOwed += 1; continue; }
        if (e.due < from || e.due > to || e.status === 'not_required' || e.status === 'upcoming') continue;
        const b = by[e.type]; b.due += 1;
        if (e.status === 'done') { if (e.in_window) b.done_in_window += 1; else b.done_outside_window += 1; } else if (e.status === 'missed') b.missed += 1; else b.still_open += 1;
      }
    }
    const rate = (b) => { const settled = b.due - b.still_open; return settled ? Math.round(1000 * b.done_in_window / settled) / 10 : null; };
    const total = Object.values(by).reduce((t, b) => { for (const k of Object.keys(t)) t[k] += b[k]; return t; }, blank());
    audit.log({ user: ctx.user, action: 'suprt.completion', ip: ctx.ip, details: { from, to, whole_programme: whole || undefined } });
    return { from, to, today: on, baselines_recorded: baselines, baselines_owed: baselinesOwed,
      by_type: Object.entries(by).map(([type, b]) => ({ type, label: S.TYPE_LABEL[type], ...b, rate: rate(b) })), total: { ...total, rate: rate(total) },
      note: 'Rate: done within the window, of those due in the period whose window has closed or that were done. Still open are not counted yet.' };
  });

  // The file for entry into SPARS: one row per completed assessment in the period, SUDS's variable names in
  // SUPRT-A section order. set=closeout gives the closeouts only (SPARS takes them last, in a separate file);
  // otherwise baselines, reassessments and annual assessments. A disclosure: the gate decides who may be in it.
  r.get('/api/suprt/export', auth.requireAuth, auth.requirePerm('export:identified'), requireModule('suprt'), (ctx) => {
    const from = ctx.query.get('from') || ''; const to = ctx.query.get('to') || '';
    if (!DAY.test(from) || !DAY.test(to)) throw badRequest('from and to must be dates (YYYY-MM-DD)');
    const set = ctx.query.get('set') === 'closeout' ? 'closeout' : 'main';
    const recipient = (ctx.query.get('recipient') || S.DEFAULT_RECIPIENT).trim(); const purpose = (ctx.query.get('purpose') || S.DEFAULT_PURPOSE).trim();
    const basis = ctx.query.get('basis') || 'consent';
    if (!S.EXPORT_BASES.includes(basis)) throw badRequest(`A SPARS entry file is disclosed under each client's Part 2 consent naming the recipient (basis=consent), or an audit or evaluation approval on file with it (basis=audit_evaluation); not "${basis}".`);
    const disclosure = require('../disclosure');
    const gate = { basis, restriction_reviewed: ctx.query.get('restriction_reviewed') === '1', recipient, agreement_id: ctx.query.get('agreement_id') || undefined, user: ctx.user };
    disclosure.requireExportBasis([], gate);
    const cf = auth.caseloadFilter(ctx.user, 'c.id');
    const types = set === 'closeout' ? ['closeout'] : ['baseline', 'reassessment', 'annual'];
    const rows = db.all(`SELECT s.*, c.client_code FROM suprt_assessments s JOIN clients c ON c.id=s.client_id WHERE s.status='complete' AND s.assessment_date BETWEEN ? AND ?
        AND s.assessment_type IN (${types.map(() => '?').join(',')}) AND c.deleted_at IS NULL AND ${cf.sql} ORDER BY c.client_code, s.assessment_date, s.created_at`, from, to, ...types, ...cf.params);
    const ids = [...new Set(rows.map(x => x.client_id))];
    if (!ids.length) throw badRequest(`No completed SUPRT-A ${set === 'closeout' ? 'closeout' : 'baseline, reassessment or annual assessment'} is dated in this period.`);
    let g;
    try { g = disclosure.requireExportBasis(ids, gate); }
    catch (e) { audit.log({ user: ctx.user, action: 'suprt.export.refused', ip: ctx.ip, success: false, details: { basis, set, clients: ids.length, reason: String(e.message).slice(0, 200) } }); throw e; }
    const out = new Set(g.excluded);
    const excludedCodes = [...new Set(rows.filter(x => out.has(x.client_id)).map(x => x.client_code))].sort();
    const included = ids.filter(id => !out.has(id));
    if (!included.length) {
      audit.log({ user: ctx.user, action: 'suprt.export.refused', ip: ctx.ip, success: false, details: { basis, set, clients: ids.length, reason: 'no client has a consent naming the recipient' } });
      throw new HttpError(409, `None of the ${ids.length} client${ids.length === 1 ? '' : 's'} with an assessment in this period has a Part 2 consent on file naming "${recipient}", so nothing can be put in the file. Record each client's consent to SPARS reporting (Consents tab), or use an audit or evaluation approval on file with the recipient.`, { code: 'no_consent', excluded: excludedCodes });
    }
    const exportId = uuid(); const stamp = db.now();
    const kept = rows.filter(x => !out.has(x.client_id));
    db.transaction(() => {
      for (const clientId of included) {
        const n = kept.filter(x => x.client_id === clientId).length;
        disclosure.record({ clientId, consentId: g.consentOf.get(clientId) || null, agreementId: g.agreement?.id || null, recipient, purpose, what: `SUPRT-A ${set === 'closeout' ? 'closeout' : 'assessment'} record${n === 1 ? '' : 's'} (${n}, ${from} to ${to}) for entry into SPARS`, method: 'export', basis, source: 'suprt', sourceRef: `suprt:${exportId}`, user: ctx.user, ip: ctx.ip });
      }
      for (const x of kept) db.run(`UPDATE suprt_assessments SET exported_at=?, updated_at=? WHERE id=?`, stamp, stamp, x.id);
    });
    require('../incidents').maybeMassExport({ clients: included.length, kind: 'suprt', user: ctx.user });
    audit.log({ user: ctx.user, action: 'suprt.export', ip: ctx.ip, details: { export_id: exportId, from, to, set, basis, assessments: kept.length, clients_disclosed: included.length, left_out: excludedCodes.length || undefined } });
    const Sp = require('../spreadsheet');
    const data = kept.map(x => { const a = answersOf(x); return Object.fromEntries(S.EXPORT_COLUMNS.map(col => [col.key, a[col.key] ?? ''])); });
    let body = Sp.toCsv(data, S.EXPORT_COLUMNS);
    // The label travels with the data: after a blank row, the note (and, in a Part 2 programme, the §2.32 notice).
    const tail = [S.EXPORT_NOTE, disclosure.fileNotice()].filter(Boolean);
    body += '\r\n' + tail.map(t => Sp.toCsv([{ n: t }], [{ key: 'n', label: '' }]).split('\r\n')[1]).map(l => `\r\n${l}`).join('');
    const headerSafe = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 900);
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-suprt-a-${set}-${from}_${to}-for-entry-into-SPARS-check-against-current-handbook.csv"`,
      'X-SUDS-Export': headerSafe(`Identified - PHI. SUPRT-A records for entry into SPARS - check against the current handbook. Disclosed to: ${recipient}. Basis: ${basis}. ${included.length} client(s), accounted for. Generated ${stamp}.`),
      'X-SUDS-Export-Excluded': excludedCodes.join(',').slice(0, 900) });
    ctx.res.end(body);
  });
};
module.exports.cycleOf = cycleOf;
module.exports.checkOrder = checkOrder;
module.exports.recordManagement = recordManagement;
module.exports.derivedKeys = derivedKeys;

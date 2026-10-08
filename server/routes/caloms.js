'use strict';
// CalOMS Tx state reporting: settings, each episode's admission / discharge / annual update records, the
// validation report, and the extract for DHCS. The layout and edit checks are in server/caloms*.js.
//
// Who may do what: every signed-in role can read whether CalOMS is on (the forms need to know); an
// administrator (settings:manage) sets it up; whoever can write episodes records the answers for clients on
// their caseload; whoever can read episodes sees the validation report for their caseload; and only a role
// that may make an identified export (export:identified) produces the state extract, which is a disclosure.
const { requireModule } = require('../programme');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../caloms');
const { badRequest, notFound, HttpError } = require('../http');
const { validate } = require('../validate');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The reporting period: from/to calendar days; by default the current month to date. */
function period(ctx) {
  const today = require('../local-date').localDate();
  const to = ctx.query.get('to') || today;
  const from = ctx.query.get('from') || `${to.slice(0, 7)}-01`;
  for (const v of [from, to]) if (!DAY.test(v) || !Number.isFinite(Date.parse(v))) throw badRequest('from and to must be dates (YYYY-MM-DD)');
  if (from > to) throw badRequest('from must not be after to');
  return { from, to };
}
const scopeFor = (user) => (col) => auth.caseloadFilter(user, col);

function episodeFor(ctx, id) {
  const e = db.one(`SELECT * FROM episodes WHERE id=?`, id);
  if (!e) throw notFound('Episode not found');
  auth.assertClientAccess(ctx, e.client_id);
  return e;
}

/** The records one episode should have and does not: its admission, its discharge, anniversaries due. */
function expectedFor(e, records) {
  const out = [];
  const has = (t) => records.some(r => r.record_type === t);
  if (!has('admission')) out.push({ record_type: 'admission', record_date: e.opened_at.slice(0, 10), message: 'CalOMS admission record not yet completed' });
  if (e.status === 'closed' && !has('discharge')) out.push({ record_type: 'discharge', record_date: e.closed_at, message: 'CalOMS discharge record not yet completed' });
  const today = require('../local-date').localDate();
  const end = e.closed_at && e.closed_at < today ? e.closed_at : today;
  for (let n = 1; n < 100; n++) {
    const anniv = C.addYears(e.opened_at.slice(0, 10), n);
    if (C.addDays(anniv, -C.ANNUAL_EARLY) > end) break;
    const done = records.some(r => r.record_type === 'annual_update' && r.record_date >= C.addDays(anniv, -C.ANNUAL_EARLY) && r.record_date <= C.addDays(anniv, C.ANNUAL_LATE));
    if (!done && anniv <= C.addDays(end, C.ANNUAL_EARLY)) out.push({ record_type: 'annual_update', record_date: anniv, message: `Annual update due for the anniversary on ${anniv}` });
  }
  return out;
}

// A record's fields, and that a discharge record needs a discharged episode: the table's rules
// (server/rules/caloms_records.js), which sync push applies to a device's records as well.
const rules = require('../rules');
const RECORD_SHAPE = rules.forTable('caloms_records').fields;

function saveRecord(ctx, e, v, id = null) {
  rules.assertWrite('caloms_records', { episode_id: e.id, record_type: v.record_type }, ctx);
  // A discharge record is dated by the discharge itself, so the two can never disagree.
  const date = v.record_type === 'discharge' ? e.closed_at : (v.record_date || (v.record_type === 'admission' ? e.opened_at.slice(0, 10) : null));
  const r = db.transaction(() => C.save({ episode: e, record_type: v.record_type, provider_id: v.provider_id, record_date: date, answers: v.answers, user: ctx.user, id }));
  audit.log({ user: ctx.user, action: 'caloms.record.save', entity: 'caloms_record', entityId: r.id, clientId: e.client_id, ip: ctx.ip, details: { record_type: v.record_type, updated: r.updated || undefined, warnings: r.warnings.length || undefined } });
  return r;
}

module.exports = (r) => {
  // The switch, the provider IDs and the layout. Not PHI; the admission and discharge forms read it.
  r.get('/api/caloms/config', auth.requireAuth, () => C.config());

  r.put('/api/caloms/settings', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const v = validate(ctx.body, { enabled: { type: 'boolean' }, providers: { type: 'array', maxLen: 20 }, start_date: { type: 'date' },
      // 1.17.0: the monthly run (server/caloms-schedule.js) and county mode's one file per provider.
      schedule: { type: 'string', enum: ['off', 'monthly'] }, schedule_day: { type: 'number', integer: true, min: 1, max: 28 }, split_by_provider: { type: 'boolean' } });
    const provs = v.providers === undefined ? C.providers() : (v.providers || []).map((p) => {
      const o = { id: String((p && p.id) || '').trim(), name: String((p && p.name) || '').trim().slice(0, 120) };
      const legal = String((p && p.legal_name) || '').trim().slice(0, 200); const npi = String((p && p.npi) || '').replace(/\s/g, '');
      if (legal) o.legal_name = legal; if (npi) o.npi = npi;
      return o;
    });
    const fields = {};
    provs.forEach((p, i) => { if (!C.PROVIDER_ID.test(p.id)) fields[`providers.${i}.id`] = 'must be 4 to 10 letters or digits (the CalOMS provider ID DHCS assigned)'; });
    provs.forEach((p, i) => { if (p.npi && !C.validNpi(p.npi)) fields[`providers.${i}.npi`] = 'must be a 10-digit National Provider Identifier (its check digit does not match)'; });
    if (new Set(provs.map(p => p.id)).size !== provs.length) fields.providers = 'lists the same provider ID twice';
    const on = v.enabled === undefined ? db.getSetting('caloms_enabled', '0') === '1' : !!v.enabled;
    if (on && !provs.length) fields.providers = 'add at least one CalOMS provider ID before turning CalOMS reporting on';
    if (Object.keys(fields).length) throw badRequest('Validation failed', { fields });
    db.transaction(() => {
      db.setSetting('caloms_enabled', on ? '1' : '0');
      db.setSetting('caloms_providers', JSON.stringify(provs));
      // Records are expected from the day reporting starts, not for every episode the programme ever had.
      if (v.start_date !== undefined && v.start_date !== null) db.setSetting('caloms_start_date', v.start_date);
      else if (on && !C.startDate()) db.setSetting('caloms_start_date', require('../local-date').localDate());
      if (v.schedule !== undefined && v.schedule !== null) db.setSetting('caloms_schedule', v.schedule);
      if (v.schedule_day !== undefined && v.schedule_day !== null) db.setSetting('caloms_schedule_day', String(v.schedule_day));
      if (v.split_by_provider !== undefined && v.split_by_provider !== null) db.setSetting('caloms_split_by_provider', v.split_by_provider ? '1' : '0');
    });
    audit.log({ user: ctx.user, action: 'caloms.settings.update', ip: ctx.ip, details: { enabled: on, providers: provs.length, schedule: C.schedule().frequency, split_by_provider: C.schedule().split_by_provider } });
    return C.config();
  });

  // One episode's CalOMS records, with the problems each has and the records it is still missing.
  r.get('/api/episodes/:id/caloms', auth.requireAuth, auth.requirePerm('episodes:read', 'episodes:write'), (ctx) => {
    const e = episodeFor(ctx, ctx.params.id);
    const cx = C.contextFor(e);
    const records = cx.records.map(rec => ({ ...rec, issues: C.check(rec, cx) }));
    audit.log({ user: ctx.user, action: 'caloms.record.view', entity: 'episode', entityId: e.id, clientId: e.client_id, ip: ctx.ip, details: { count: records.length } });
    return { enabled: C.enabled(), records, expected: expectedFor(e, records) };
  });

  r.post('/api/episodes/:id/caloms', auth.requireAuth, auth.requirePerm('episodes:write'), requireModule('caloms'), (ctx) => {
    const e = episodeFor(ctx, ctx.params.id);
    const res = saveRecord(ctx, e, validate(ctx.body, RECORD_SHAPE));
    ctx.status = res.updated ? 200 : 201;
    return { id: res.id, updated: res.updated, warnings: res.warnings };
  });

  r.put('/api/caloms/records/:id', auth.requireAuth, auth.requirePerm('episodes:write'), requireModule('caloms'), (ctx) => {
    const rec = db.one(`SELECT * FROM caloms_records WHERE id=?`, ctx.params.id);
    if (!rec) throw notFound('CalOMS record not found');
    const e = episodeFor(ctx, rec.episode_id);
    const v = validate({ record_type: rec.record_type, ...ctx.body }, RECORD_SHAPE);
    if (v.record_type !== rec.record_type) throw badRequest('A record cannot change its type; delete it and record the other kind');
    const res = saveRecord(ctx, e, v, rec.id);
    return { id: res.id, updated: true, warnings: res.warnings };
  });

  r.delete('/api/caloms/records/:id', auth.requireAuth, auth.requirePerm('episodes:write'), requireModule('caloms'), (ctx) => {
    const rec = db.one(`SELECT * FROM caloms_records WHERE id=?`, ctx.params.id);
    if (!rec) throw notFound('CalOMS record not found');
    episodeFor(ctx, rec.episode_id);
    require('../rules').assertEditable('caloms_records', ctx, rec, { deleting: true }); // its recorder's; never once extracted
    db.transaction(() => { db.run(`DELETE FROM caloms_records WHERE id=?`, rec.id); db.tombstone('caloms_records', rec.id); });
    audit.log({ user: ctx.user, action: 'caloms.record.delete', entity: 'caloms_record', entityId: rec.id, clientId: rec.client_id, ip: ctx.ip, details: { record_type: rec.record_type } });
    return { ok: true };
  });

  // The validation report: every fatal error and warning in the period, by client code and field. Codes,
  // field names and dates only — no answers, no names — so it can be worked through by the whole team.
  r.get('/api/caloms/validation', auth.requireAuth, auth.requirePerm('episodes:read', 'episodes:write'), (ctx) => {
    const { from, to } = period(ctx);
    const rep = C.report({ from, to, scope: scopeFor(ctx.user) });
    audit.log({ user: ctx.user, action: 'caloms.validate', ip: ctx.ip, details: { from, to, records: rep.summary.records, fatal: rep.summary.fatal, warnings: rep.summary.warnings } });
    const rows = rep.rows;
    if (ctx.query.get('format') === 'csv') {
      const cols = ['severity', 'client_code', 'record_type', 'record_date', 'provider_id', 'field_label', 'code', 'message'].map(k => ({ key: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }));
      ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="caloms-validation-${from}_${to}.csv"` });
      ctx.res.end(require('../spreadsheet').toCsv(rows, cols));
      return;
    }
    return { from, to, spec_version: rep.spec_version, enabled: rep.enabled, providers: rep.providers, start_date: rep.start_date, summary: rep.summary, rows };
  });

  // The preview, and the submission.
  //   GET /api/caloms/extract is a preview for checking the file before it is sent. It is unmistakably not
  //   the submission: every file in it is named PREVIEW-, its README opens with PREVIEW - NOT FOR SUBMISSION,
  //   and its records carry PREVIEW / NOT FOR SUBMISSION where the name goes and no date of birth — so it is
  //   not an identified file, cannot be accepted by DHCS, and nobody's accounting changes. Audited.
  //   POST /api/caloms/submissions produces the submission: the file is built once, kept (encrypted, with its
  //   SHA-256), accounted for per client under the state-reporting basis against that submission's id, and
  //   its records are stamped as sent. GET /api/caloms/submissions/:id/file serves exactly those bytes, so
  //   what goes to DHCS is what was accounted — never a file rebuilt later from records edited since.
  //   Records with a fatal error are held back from both.
  function extractFor(ctx, opts = {}) {
    const { from, to } = period(ctx);
    if (!C.enabled()) throw badRequest('CalOMS Tx reporting is switched off for this program (Reports → State reporting → Settings)');
    if (!C.providers().length) throw badRequest('Add this program\'s CalOMS provider ID first (Reports → State reporting → Settings)');
    return { from, to, x: C.buildExtract({ from, to, scope: scopeFor(ctx.user), generatedBy: ctx.user.display_name || ctx.user.username, ...opts }) };
  }
  const zipOf = (files) => require('../spreadsheet').zip(files);
  const sha256 = (buf) => require('node:crypto').createHash('sha256').update(buf).digest('hex');
  const headerSafe = (v) => String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 900);

  r.get('/api/caloms/extract', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const { from, to, x } = extractFor(ctx, { preview: true });
    const disclosure = require('../disclosure');
    const stamp = db.now();
    audit.log({ user: ctx.user, action: 'caloms.extract', ip: ctx.ip, details: { from, to, preview: true, ...x.counts, held_back: x.excluded, provider_months: x.activity_rows, no_activity_months: x.no_activity_months, clients: x.clientIds.length } });
    const body = zipOf(x.files);
    ctx.res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="caloms-tx-PREVIEW-NOT-FOR-SUBMISSION-${from}_${to}.zip"`,
      'X-SUDS-Export': headerSafe(`CalOMS Tx Preview - not for submission: names replaced and dates of birth left out; produce the submission file to send to DHCS. ${x.clientIds.length} client(s).${disclosure.fileNotice({ short: true }) ? ` ${disclosure.fileNotice({ short: true })}` : ''} Generated ${stamp}.`),
      'X-SUDS-CalOMS-Counts': `admission=${x.counts.admission}; discharge=${x.counts.discharge}; annual_update=${x.counts.annual_update}; held_back=${x.excluded}` });
    ctx.res.end(body);
  });

  r.post('/api/caloms/submissions', auth.requireAuth, auth.requirePerm('export:identified'), requireModule('caloms'), (ctx) => {
    const v = validate(ctx.body || {}, { from: { type: 'date', required: true }, to: { type: 'date', required: true }, provider_id: { type: 'string', maxLen: 10 } });
    if (v.provider_id && !C.providers().some(p => p.id === v.provider_id)) throw badRequest('That is not one of this program\'s CalOMS provider IDs', { fields: { provider_id: 'unknown provider' } });
    ctx.query.set('from', v.from); ctx.query.set('to', v.to);
    const id = require('../crypto').uuid();
    const { from, to, x } = extractFor(ctx, { submissionId: id, providerId: v.provider_id || null });
    if (!x.clientIds.length) throw badRequest('There is nothing to submit for this period: no record passed the edit checks.');
    const disclosure = require('../disclosure');
    const { encrypt } = require('../crypto');
    const body = zipOf(x.files);
    const hash = sha256(body);
    const fileName = `caloms-tx-SUBMISSION-${from}_${to}${v.provider_id ? `-${v.provider_id}` : ''}-${id.slice(0, 8)}.zip`;
    const stamp = db.now();
    db.transaction(() => {
      db.run(`INSERT INTO caloms_submissions(id,period_from,period_to,file_name,sha256,bytes,clients,counts,file_enc,created_by,created_at,updated_at,status,origin,provider_id,record_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'produced','manual',?,?)`,
        id, from, to, fileName, hash, body.length, x.clientIds.length, JSON.stringify({ ...x.counts, held_back: x.excluded }), encrypt(body.toString('base64')), ctx.user.id, stamp, stamp, v.provider_id || null, JSON.stringify(x.ready.map(rec => rec.id)));
      require('../caloms-schedule').logEvent(id, 'produced', ctx.user, hash);
      disclosure.recordStateReport({ clientIds: x.clientIds, what: `CalOMS Tx records (${from} to ${to}): ${x.counts.admission} admission, ${x.counts.discharge} discharge, ${x.counts.annual_update} annual update; submission file ${fileName}, SHA-256 ${hash}`, sourceRef: `caloms:${id}`, user: ctx.user, ip: ctx.ip });
      for (const rec of x.ready) db.run(`UPDATE caloms_records SET extracted_at=?, updated_at=? WHERE id=?`, stamp, stamp, rec.id);
    });
    // A submission naming a great many people at once is reviewed like any other mass identified export,
    // required by law or not (server/incidents.js); the review is a formality when it went to DHCS as recorded.
    require('../incidents').maybeMassExport({ clients: x.clientIds.length, kind: 'caloms', user: ctx.user });
    audit.log({ user: ctx.user, action: 'caloms.submitted', entity: 'caloms_submission', entityId: id, ip: ctx.ip, details: { from, to, ...x.counts, held_back: x.excluded, clients_disclosed: x.clientIds.length, sha256: hash } });
    return { ok: true, id, from, to, submitted_at: stamp, file_name: fileName, sha256: hash, bytes: body.length, clients_disclosed: x.clientIds.length, counts: x.counts, held_back: x.excluded };
  });

  // A file covers the whole programme unless a worker held to a caseload produced it themselves from their own
  // caseload (POST /api/caloms/submissions: the extract is scoped to the caller). Held to a caseload, a worker
  // reaches only those; the monthly run's files, and anyone else's, are the whole programme's (security review
  // of 1.17.0, L4: the same rule as prepare and produce).
  const ownOnly = (ctx) => auth.caseloadRestricted(ctx.user);
  const mayReach = (ctx, sub, what) => {
    if (ownOnly(ctx) && !(sub.origin === 'manual' && sub.created_by === ctx.user.id)) {
      audit.log({ user: ctx.user, action: 'caloms.submission.refused', entity: 'caloms_submission', entityId: sub.id, ip: ctx.ip, success: false, details: { what, reason: 'held to a caseload' } });
      throw require('../http').forbidden(`This file covers the whole program; someone who is held to a caseload cannot ${what} it`);
    }
    return sub;
  };

  // What was produced, when and by whom: periods, counts and hashes, never who was in it.
  r.get('/api/caloms/submissions', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const own = ownOnly(ctx);
    const rows = db.all(`SELECT s.id, s.period_from, s.period_to, s.file_name, s.sha256, s.bytes, s.clients, s.counts, s.created_at, s.file_cleared_at, s.file_enc IS NOT NULL AS has_file, u.display_name AS created_by_name,
        s.status, s.origin, s.provider_id, s.uploaded_at, s.dhcs_reference, up.display_name AS uploaded_by_name,
        (SELECT COUNT(*) FROM caloms_submission_events ev WHERE ev.submission_id=s.id AND ev.action='downloaded') AS downloads
      FROM caloms_submissions s JOIN users u ON u.id=s.created_by LEFT JOIN users up ON up.id=s.uploaded_by ${own ? `WHERE s.origin='manual' AND s.created_by=?` : ''} ORDER BY s.created_at DESC LIMIT 200`, ...(own ? [ctx.user.id] : []))
      .map(r => { let counts = {}; try { counts = JSON.parse(r.counts || '{}'); } catch { /* keep {} */ } const o = { ...r, counts, file_available: !!r.has_file }; delete o.has_file; return o; });
    audit.log({ user: ctx.user, action: 'caloms.submission.list', ip: ctx.ip, details: { count: rows.length, own_only: own || undefined } });
    return { rows, keep_days: require('../retention').CALOMS_FILE_DAYS };
  });

  // The submission file itself: exactly the bytes that were accounted, checked against the stored hash.
  r.get('/api/caloms/submissions/:id/file', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const sub = db.one(`SELECT * FROM caloms_submissions WHERE id=?`, ctx.params.id);
    if (!sub) throw notFound('Submission not found');
    mayReach(ctx, sub, 'download');
    // A prepared file has not been accounted: it is produced first (below), which is the disclosure.
    if (sub.status !== 'produced') throw new HttpError(409, sub.status === 'prepared' ? 'This file was prepared by the monthly run and has not been produced yet. Produce it first: that is when it is written to each client\'s accounting of disclosures.' : 'This file was discarded.', { status: sub.status });
    if (!sub.file_enc) throw new HttpError(410, `This submission's file is no longer kept (files are kept ${require('../retention').CALOMS_FILE_DAYS} days, and removed when a client in it is purged). Its record and hash remain; produce a new submission if the records must be sent again.`);
    const body = Buffer.from(require('../crypto').decrypt(sub.file_enc), 'base64');
    if (sha256(body) !== sub.sha256) {
      audit.log({ user: ctx.user, action: 'caloms.submission.download', entity: 'caloms_submission', entityId: sub.id, ip: ctx.ip, success: false, details: { reason: 'hash mismatch' } });
      throw new HttpError(500, 'The stored submission file does not match the hash recorded when it was produced; it will not be served. Report this to an administrator.');
    }
    // Every download of an identified file naming many clients is reviewed as a mass export.
    require('../incidents').maybeMassExport({ clients: sub.clients, kind: 'caloms', user: ctx.user });
    audit.log({ user: ctx.user, action: 'caloms.submission.download', entity: 'caloms_submission', entityId: sub.id, ip: ctx.ip, details: { from: sub.period_from, to: sub.period_to, clients: sub.clients, sha256: sub.sha256 } });
    require('../caloms-schedule').logEvent(sub.id, 'downloaded', ctx.user, sub.sha256);
    const disclosure = require('../disclosure');
    ctx.res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${sub.file_name}"`, 'X-SUDS-SHA256': sub.sha256,
      'X-SUDS-Export': headerSafe(`Identified - PHI. CalOMS Tx submission for DHCS (state reporting, required by law), accounted for ${sub.clients} client(s) on ${sub.created_at}. Send this file unchanged.${disclosure.fileNotice({ short: true }) ? ` ${disclosure.fileNotice({ short: true })}` : ''}`) });
    ctx.res.end(body);
  });

  // ---- 1.17.0: the monthly run, prepared files, the submission log and the worklist (server/caloms-schedule.js) ----
  const SCHED = require('../caloms-schedule');
  const subFor = (id) => { const sub = db.one(`SELECT * FROM caloms_submissions WHERE id=?`, id); if (!sub) throw notFound('Submission not found'); return sub; };
  const wholeProgramme = (ctx, what) => { if (auth.caseloadRestricted(ctx.user)) throw require('../http').forbidden(`A prepared file covers the whole program; someone who is held to a caseload cannot ${what} one`); };

  // Run the monthly job now for a period (the previous month by default): full validation and prepared files.
  // Preparing is not a disclosure; producing is (below).
  r.post('/api/caloms/schedule/run', auth.requireAuth, auth.requirePerm('export:identified'), requireModule('caloms'), (ctx) => {
    const v = validate(ctx.body || {}, { from: { type: 'date' }, to: { type: 'date' } });
    if (!C.enabled()) throw badRequest('CalOMS Tx reporting is switched off for this program');
    if (!C.providers().length) throw badRequest('Add this program\'s CalOMS provider ID first');
    wholeProgramme(ctx, 'prepare');
    const { from, to } = v.from && v.to ? v : SCHED.previousMonth(require('../local-date').localDate());
    if (from > to) throw badRequest('from must not be after to');
    return SCHED.run({ from, to, user: ctx.user, ip: ctx.ip, origin: 'manual' });
  });

  // Produce a prepared file: account exactly its bytes, per client, and mark its records as sent — unless any
  // of them changed, went, or was sent in another file since it was prepared.
  r.post('/api/caloms/submissions/:id/produce', auth.requireAuth, auth.requirePerm('export:identified'), requireModule('caloms'), (ctx) => {
    const sub = subFor(ctx.params.id);
    if (sub.status !== 'prepared') throw new HttpError(409, sub.status === 'produced' ? 'This file has already been produced.' : 'This file was discarded.');
    if (!sub.file_enc) throw new HttpError(410, 'This prepared file is no longer kept (a client in it was purged). Prepare a new one.');
    wholeProgramme(ctx, 'produce');
    const ids = JSON.parse(sub.record_ids || '[]');
    const recs = ids.length ? db.all(`SELECT id, client_id, updated_at, extracted_at FROM caloms_records WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
    // A record already sent in any file (extracted_at set, before or after this one was prepared) is stale too
    // (1.17.1; engineering review of 1.17.0, M1): producing it again would disclose and send it twice.
    const stale = ids.length - recs.length + recs.filter(x => x.updated_at > sub.created_at || x.extracted_at).length;
    if (stale) throw new HttpError(409, `${stale} record(s) in this file were changed or removed after it was prepared, or were already sent in another file, so it no longer matches what is left to send. Discard it and prepare a new one.`, { stale });
    const clientIds = [...new Set(recs.map(x => x.client_id))];
    const counts = JSON.parse(sub.counts || '{}');
    const stamp = db.now();
    const disclosure = require('../disclosure');
    db.transaction(() => {
      db.run(`UPDATE caloms_submissions SET status='produced', created_by=?, updated_at=? WHERE id=?`, ctx.user.id, stamp, sub.id);
      disclosure.recordStateReport({ clientIds, what: `CalOMS Tx records (${sub.period_from} to ${sub.period_to}): ${counts.admission || 0} admission, ${counts.discharge || 0} discharge, ${counts.annual_update || 0} annual update; submission file ${sub.file_name}, SHA-256 ${sub.sha256}`, sourceRef: `caloms:${sub.id}`, user: ctx.user, ip: ctx.ip });
      for (const rec of recs) db.run(`UPDATE caloms_records SET extracted_at=?, updated_at=? WHERE id=?`, stamp, stamp, rec.id);
      SCHED.logEvent(sub.id, 'produced', ctx.user, sub.sha256);
    });
    require('../incidents').maybeMassExport({ clients: clientIds.length, kind: 'caloms', user: ctx.user });
    audit.log({ user: ctx.user, action: 'caloms.submitted', entity: 'caloms_submission', entityId: sub.id, ip: ctx.ip, details: { from: sub.period_from, to: sub.period_to, prepared: true, provider_id: sub.provider_id || undefined, clients_disclosed: clientIds.length, sha256: sub.sha256 } });
    return { ok: true, id: sub.id, submitted_at: stamp, file_name: sub.file_name, sha256: sub.sha256, clients_disclosed: clientIds.length, counts };
  });

  r.post('/api/caloms/submissions/:id/discard', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const sub = mayReach(ctx, subFor(ctx.params.id), 'discard');
    if (sub.status !== 'prepared') throw new HttpError(409, 'Only a prepared file that has not been produced can be discarded; a produced one is a disclosure on record.');
    db.transaction(() => {
      db.run(`UPDATE caloms_submissions SET status='discarded', file_enc=NULL, file_cleared_at=?, updated_at=? WHERE id=?`, db.now(), db.now(), sub.id);
      SCHED.logEvent(sub.id, 'discarded', ctx.user);
    });
    audit.log({ user: ctx.user, action: 'caloms.submission.discard', entity: 'caloms_submission', entityId: sub.id, ip: ctx.ip, details: { from: sub.period_from, to: sub.period_to } });
    return { ok: true };
  });

  // SUDS does not upload to DHCS; the person who did records it here, with the reference the portal gave.
  r.post('/api/caloms/submissions/:id/uploaded', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const sub = mayReach(ctx, subFor(ctx.params.id), 'record the upload of');
    const v = validate(ctx.body || {}, { uploaded_on: { type: 'date', required: true }, dhcs_reference: { type: 'string', maxLen: 60, pattern: /^[A-Za-z0-9 ._/#-]*$/ } });
    if (sub.status !== 'produced') throw new HttpError(409, 'Produce the file first: a prepared file has not been accounted, so it cannot have been sent.');
    if (v.uploaded_on > require('../local-date').localDate()) throw badRequest('The upload date cannot be in the future', { fields: { uploaded_on: 'in the future' } });
    // Against when it was produced, not when it was prepared (1.17.1; engineering review of 1.17.0, L4): a file the
    // monthly run prepared on the 5th and a person produced on the 12th cannot have been uploaded on the 8th.
    const produced = db.one(`SELECT created_at FROM caloms_submission_events WHERE submission_id=? AND action='produced' ORDER BY created_at LIMIT 1`, sub.id);
    if (v.uploaded_on < require('../local-date').dayOf(produced ? produced.created_at : sub.created_at)) throw badRequest('The upload date is before the file was produced', { fields: { uploaded_on: 'before the file existed' } });
    db.transaction(() => {
      db.run(`UPDATE caloms_submissions SET uploaded_at=?, uploaded_by=?, dhcs_reference=?, updated_at=? WHERE id=?`, v.uploaded_on, ctx.user.id, v.dhcs_reference || null, db.now(), sub.id);
      SCHED.logEvent(sub.id, 'uploaded', ctx.user, [v.uploaded_on, v.dhcs_reference].filter(Boolean).join(' '));
    });
    audit.log({ user: ctx.user, action: 'caloms.submission.uploaded', entity: 'caloms_submission', entityId: sub.id, ip: ctx.ip, details: { uploaded_on: v.uploaded_on, reference: !!v.dhcs_reference } });
    return { ok: true, uploaded_at: v.uploaded_on, dhcs_reference: v.dhcs_reference || null };
  });

  r.get('/api/caloms/submissions/:id/events', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const sub = mayReach(ctx, subFor(ctx.params.id), 'read the log of');
    const rows = db.all(`SELECT e.action, e.detail, e.created_at, COALESCE(u.display_name, 'Scheduled run') AS who FROM caloms_submission_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.submission_id=? ORDER BY e.created_at, e.rowid`, sub.id);
    audit.log({ user: ctx.user, action: 'caloms.submission.log', entity: 'caloms_submission', entityId: sub.id, ip: ctx.ip, details: { count: rows.length } });
    return { id: sub.id, file_name: sub.file_name, sha256: sub.sha256, status: sub.status, rows };
  });

  // The errors to fix, each assigned to the record's owner: whoever last saved the record, or — for a record
  // that is missing — the client's primary worker, else whoever opened the episode. Codes, fields and dates
  // only, as the validation report. mine=1: only the caller's.
  r.get('/api/caloms/worklist', auth.requireAuth, auth.requirePerm('episodes:read', 'episodes:write'), (ctx) => {
    const today = require('../local-date').localDate();
    const from = ctx.query.get('from') || C.startDate() || C.addDays(today, -365);
    const to = ctx.query.get('to') || today;
    for (const d of [from, to]) if (!DAY.test(d) || !Number.isFinite(Date.parse(d))) throw badRequest('from and to must be dates (YYYY-MM-DD)');
    const rep = C.report({ from, to, scope: scopeFor(ctx.user) });
    const ownerCache = new Map(); const names = new Map();
    const nameOf = (id) => { if (!id) return null; if (!names.has(id)) names.set(id, (db.one(`SELECT display_name FROM users WHERE id=?`, id) || {}).display_name || null); return names.get(id); };
    const ownerOf = (row) => {
      const key = row.record_id ? `r:${row.record_id}` : `e:${row.episode_id}`;
      if (ownerCache.has(key)) return ownerCache.get(key);
      let owner = null;
      if (row.record_id) { const rec = db.one(`SELECT updated_by, created_by FROM caloms_records WHERE id=?`, row.record_id); owner = rec && (rec.updated_by || rec.created_by); }
      if (!owner) owner = (db.one(`SELECT user_id FROM assignments WHERE client_id=? AND role_on_case='primary' AND ended_at IS NULL AND (end_date IS NULL OR end_date >= ?) ORDER BY start_date DESC LIMIT 1`, row.client_id, today) || {}).user_id || null;
      if (!owner) owner = (db.one(`SELECT opened_by FROM episodes WHERE id=?`, row.episode_id) || {}).opened_by || null;
      ownerCache.set(key, owner); return owner;
    };
    let rows = rep.rows.map(x => { const o = ownerOf(x); return { ...x, owner_id: o, owner_name: nameOf(o), mine: o === ctx.user.id }; });
    const mineOnly = ctx.query.get('mine') === '1';
    if (mineOnly) rows = rows.filter(x => x.mine);
    const byOwner = {};
    for (const x of rows) { const k = x.owner_name || 'Unassigned'; byOwner[k] = byOwner[k] || { fatal: 0, warnings: 0 }; byOwner[k][x.severity === 'fatal' ? 'fatal' : 'warnings']++; }
    audit.log({ user: ctx.user, action: 'caloms.worklist', ip: ctx.ip, details: { from, to, rows: rows.length, mine: mineOnly || undefined } });
    return { from, to, rows, by_owner: byOwner, mine: rows.filter(x => x.mine).length, schedule: C.schedule() };
  });
};

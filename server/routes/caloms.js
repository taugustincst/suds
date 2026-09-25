'use strict';
// CalOMS Tx state reporting: settings, each episode's admission / discharge / annual update records, the
// validation report, and the extract for DHCS. The layout and edit checks are in server/caloms*.js.
//
// Who may do what: every signed-in role can read whether CalOMS is on (the forms need to know); an
// administrator (settings:manage) sets it up; whoever can write episodes records the answers for clients on
// their caseload; whoever can read episodes sees the validation report for their caseload; and only a role
// that may make an identified export (export:identified) produces the state extract, which is a disclosure.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../caloms');
const S = require('../caloms-spec');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The reporting period: from/to calendar days; by default the current month to date. */
function period(ctx) {
  const today = require('./budget').localDate();
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
  const today = require('./budget').localDate();
  const end = e.closed_at && e.closed_at < today ? e.closed_at : today;
  for (let n = 1; n < 100; n++) {
    const anniv = C.addYears(e.opened_at.slice(0, 10), n);
    if (C.addDays(anniv, -C.ANNUAL_EARLY) > end) break;
    const done = records.some(r => r.record_type === 'annual_update' && r.record_date >= C.addDays(anniv, -C.ANNUAL_EARLY) && r.record_date <= C.addDays(anniv, C.ANNUAL_LATE));
    if (!done && anniv <= C.addDays(end, C.ANNUAL_EARLY)) out.push({ record_type: 'annual_update', record_date: anniv, message: `Annual update due for the anniversary on ${anniv}` });
  }
  return out;
}

const RECORD_SHAPE = {
  record_type: { type: 'string', required: true, enum: S.RECORD_TYPES }, provider_id: { type: 'string', maxLen: 20 },
  record_date: { type: 'date' }, answers: { type: 'object', required: true },
};

function saveRecord(ctx, e, v, id = null) {
  if (v.record_type === 'discharge' && e.status !== 'closed') throw badRequest('A CalOMS discharge record is completed when the episode is discharged (Discharge on the Episodes tab)');
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
    const v = validate(ctx.body, { enabled: { type: 'boolean' }, providers: { type: 'array', maxLen: 20 }, start_date: { type: 'date' } });
    const provs = v.providers === undefined ? C.providers() : (v.providers || []).map((p) => ({ id: String((p && p.id) || '').trim(), name: String((p && p.name) || '').trim().slice(0, 120) }));
    const fields = {};
    provs.forEach((p, i) => { if (!C.PROVIDER_ID.test(p.id)) fields[`providers.${i}.id`] = 'must be 4 to 10 letters or digits (the CalOMS provider ID DHCS assigned)'; });
    if (new Set(provs.map(p => p.id)).size !== provs.length) fields.providers = 'lists the same provider ID twice';
    const on = v.enabled === undefined ? C.enabled() : !!v.enabled;
    if (on && !provs.length) fields.providers = 'add at least one CalOMS provider ID before turning CalOMS reporting on';
    if (Object.keys(fields).length) throw badRequest('Validation failed', { fields });
    db.transaction(() => {
      db.setSetting('caloms_enabled', on ? '1' : '0');
      db.setSetting('caloms_providers', JSON.stringify(provs));
      // Records are expected from the day reporting starts, not for every episode the programme ever had.
      if (v.start_date !== undefined && v.start_date !== null) db.setSetting('caloms_start_date', v.start_date);
      else if (on && !C.startDate()) db.setSetting('caloms_start_date', require('./budget').localDate());
    });
    audit.log({ user: ctx.user, action: 'caloms.settings.update', ip: ctx.ip, details: { enabled: on, providers: provs.length } });
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

  r.post('/api/episodes/:id/caloms', auth.requireAuth, auth.requirePerm('episodes:write'), (ctx) => {
    const e = episodeFor(ctx, ctx.params.id);
    const res = saveRecord(ctx, e, validate(ctx.body, RECORD_SHAPE));
    ctx.status = res.updated ? 200 : 201;
    return { id: res.id, updated: res.updated, warnings: res.warnings };
  });

  r.put('/api/caloms/records/:id', auth.requireAuth, auth.requirePerm('episodes:write'), (ctx) => {
    const rec = db.one(`SELECT * FROM caloms_records WHERE id=?`, ctx.params.id);
    if (!rec) throw notFound('CalOMS record not found');
    const e = episodeFor(ctx, rec.episode_id);
    const v = validate({ record_type: rec.record_type, ...ctx.body }, RECORD_SHAPE);
    if (v.record_type !== rec.record_type) throw badRequest('A record cannot change its type; delete it and record the other kind');
    const res = saveRecord(ctx, e, v, rec.id);
    return { id: res.id, updated: true, warnings: res.warnings };
  });

  r.delete('/api/caloms/records/:id', auth.requireAuth, auth.requirePerm('episodes:write'), (ctx) => {
    const rec = db.one(`SELECT id, client_id, episode_id, record_type, extracted_at FROM caloms_records WHERE id=?`, ctx.params.id);
    if (!rec) throw notFound('CalOMS record not found');
    episodeFor(ctx, rec.episode_id);
    db.transaction(() => { db.run(`DELETE FROM caloms_records WHERE id=?`, rec.id); db.tombstone('caloms_records', rec.id); });
    audit.log({ user: ctx.user, action: 'caloms.record.delete', entity: 'caloms_record', entityId: rec.id, clientId: rec.client_id, ip: ctx.ip, details: { record_type: rec.record_type, was_extracted: rec.extracted_at ? true : undefined } });
    return { ok: true, warning: rec.extracted_at ? 'This record was already sent to DHCS in an extract; the state copy must be corrected through the county\'s CalOMS process.' : null };
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

  // The extract, and the submission. Downloading the file is identified, so export:identified, and audited —
  // but a download is not a disclosure until the file actually goes to DHCS: it is labelled a test / preview,
  // and nobody's accounting of disclosures changes. "Mark as submitted" (POST /api/caloms/submissions) is the
  // disclosure: required by law, it is accounted for per client under the state-reporting basis
  // (server/disclosure.js) and stamps the records as sent. Records with a fatal error are held back from both.
  function extractFor(ctx) {
    const { from, to } = period(ctx);
    if (!C.enabled()) throw badRequest('CalOMS Tx reporting is switched off for this program (Reports → State reporting → Settings)');
    if (!C.providers().length) throw badRequest('Add this program\'s CalOMS provider ID first (Reports → State reporting → Settings)');
    return { from, to, x: C.buildExtract({ from, to, scope: scopeFor(ctx.user), generatedBy: ctx.user.display_name || ctx.user.username }) };
  }
  r.get('/api/caloms/extract', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const { from, to, x } = extractFor(ctx);
    const disclosure = require('../disclosure');
    const stamp = db.now();
    audit.log({ user: ctx.user, action: 'caloms.extract', ip: ctx.ip, details: { from, to, preview: true, ...x.counts, held_back: x.excluded, provider_months: x.activity_rows, no_activity_months: x.no_activity_months, clients: x.clientIds.length } });
    const body = require('../spreadsheet').zip(x.files);
    ctx.res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="caloms-tx-${from}_${to}.zip"`,
      'X-SUDS-Export': `Identified - PHI. CalOMS Tx submission for DHCS (state reporting, required by law). Test / preview - not accounted until marked as submitted. ${x.clientIds.length} client(s).${disclosure.fileNotice({ short: true }) ? ` ${disclosure.fileNotice({ short: true })}` : ''} Generated ${stamp}.`,
      'X-SUDS-CalOMS-Counts': `admission=${x.counts.admission}; discharge=${x.counts.discharge}; annual_update=${x.counts.annual_update}; held_back=${x.excluded}` });
    ctx.res.end(body);
  });
  r.post('/api/caloms/submissions', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const v = validate(ctx.body || {}, { from: { type: 'date', required: true }, to: { type: 'date', required: true } });
    ctx.query.set('from', v.from); ctx.query.set('to', v.to);
    const { from, to, x } = extractFor(ctx);
    if (!x.clientIds.length) throw badRequest('There is nothing to submit for this period: no record passed the edit checks.');
    const disclosure = require('../disclosure');
    const stamp = db.now();
    db.transaction(() => {
      disclosure.recordStateReport({ clientIds: x.clientIds, what: `CalOMS Tx records (${from} to ${to}): ${x.counts.admission} admission, ${x.counts.discharge} discharge, ${x.counts.annual_update} annual update`, sourceRef: `caloms:${from}_${to}`, user: ctx.user, ip: ctx.ip });
      for (const rec of x.ready) db.run(`UPDATE caloms_records SET extracted_at=?, updated_at=? WHERE id=?`, stamp, stamp, rec.id);
    });
    // A submission naming a great many people at once is reviewed like any other mass identified export,
    // required by law or not (server/incidents.js); the review is a formality when it went to DHCS as recorded.
    require('../incidents').maybeMassExport({ clients: x.clientIds.length, kind: 'caloms', user: ctx.user });
    audit.log({ user: ctx.user, action: 'caloms.submitted', ip: ctx.ip, details: { from, to, ...x.counts, held_back: x.excluded, clients_disclosed: x.clientIds.length } });
    return { ok: true, from, to, submitted_at: stamp, clients_disclosed: x.clientIds.length, counts: x.counts, held_back: x.excluded };
  });
};

'use strict';
// The county view (server/county.js; docs/COUNTY-VIEW.md). Office server only: the local kernel leaves this module
// out (LOCAL_ROUTE_MODULES in server/app.js), so SUDS on this device neither makes nor imports a county file.
//
//   The programme's side (a CBO's server), for whoever files its funder submission (reports:funder) and sees the
//   budget (budget:read):
//     GET  /api/county-submission/key      this server's county signing key (public half and fingerprint), or null
//     POST /api/county-submission/key      make it, if there is none
//     GET  /api/county-submission/file     the signed county submission file for ?from&to (also export:read)
//   The county's side:
//     GET  /api/county/programmes          the registered programmes (county:view)
//     POST /api/county/programmes          register one: name, public key, notes (county:manage)
//     PUT  /api/county/programmes/:id      rename, change the notes, deactivate or reactivate (county:manage)
//     POST /api/county/fingerprint         the fingerprint of a pasted public key, to compare before saving (county:manage)
//     GET  /api/county/submissions         every imported submission, without figures (county:view)
//     POST /api/county/submissions         import a file: { text } (county:manage)
//     POST /api/county/submissions/:id/withdraw   withdraw one (county:manage)
//     GET  /api/county/view                the combined view for ?from&to (county:view)
//     GET  /api/county/view/export         the same as Excel (format=xlsx) or CSV (county:view and export:read)
// Every read and write is audited; a refused import is audited with why, and refusals are throttled per person.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const K = require('../county');
const SO = require('../settlement-outcomes');
const MAP = require('../settlement-outcome-map');
const { validate } = require('../validate');
const { badRequest, notFound, conflict, HttpError } = require('../http');

/** Refused imports per person per 10 minutes before the next is refused unread (a wrong file is a mistake; 20 is not). */
const REFUSALS_PER_10_MIN = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const today = () => require('./budget').localDate();
/** The period asked for: real dates, from on or before to, ending no later than today. */
function periodOf(ctx) {
  const from = ctx.query.get('from') || ''; const to = ctx.query.get('to') || '';
  if (!DAY.test(from) || !DAY.test(to) || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) throw badRequest('Choose a period: from and to must be dates (YYYY-MM-DD).');
  if (from > to) throw badRequest(`The start date (${from}) is after the end date (${to}). Choose a start date on or before the end date.`);
  return { from, to };
}

module.exports = (r) => {
  // ---- the programme's side ----
  const cboPerms = [auth.requireAuth, auth.requirePerm('reports:funder'), auth.requirePerm('budget:read')];
  r.get('/api/county-submission/key', ...cboPerms, () => ({ key: K.currentKey() }));
  r.post('/api/county-submission/key', ...cboPerms, (ctx) => {
    const { key, created } = K.ensureKey(ctx.user);
    if (created) audit.log({ user: ctx.user, action: 'county_submission.key.create', ip: ctx.ip, details: { fingerprint: key.fingerprint } });
    ctx.status = created ? 201 : 200;
    return { key, created };
  });
  r.get('/api/county-submission/file', ...cboPerms, auth.requirePerm('export:read'), async (ctx) => {
    const { from, to } = periodOf(ctx);
    if (to > today()) throw badRequest(`The period ends in the future (${to}). A county submission reports a period that has happened: choose an end date of today or earlier.`);
    const range = require('./reports').range(ctx);
    const raw = await db.readSnapshot(async () => SO.figures(range));
    const payload = K.payloadFrom(raw, { programme: db.getSetting('org_name', '') });
    const { key, created } = K.ensureKey(ctx.user);
    if (created) audit.log({ user: ctx.user, action: 'county_submission.key.create', ip: ctx.ip, details: { fingerprint: key.fingerprint } });
    const { file, sha256, fingerprint } = K.signFile(payload);
    // It leaves the programme: aggregate counts and money only, no client-level data, not PHI and not a Part 2
    // disclosure. Recorded with what identifies the file, not its figures.
    audit.log({ user: ctx.user, action: 'county_submission.export', ip: ctx.ip, details: { from, to, fingerprint, sha256, funds: payload.funds.length, leaves_programme: true, content: 'aggregate counts and money; no client-level data' } });
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-county-submission-${from}_${to}.json"`,
      'X-SUDS-Export': 'County submission: exact aggregate figures for the county under the funding contract; not for publication. No client-level data.' });
    ctx.res.end(JSON.stringify(file, null, 2) + '\n');
  });

  // ---- the county's side ----
  const view = [auth.requireAuth, auth.requirePerm('county:view')];
  const manage = [auth.requireAuth, auth.requirePerm('county:manage')];
  const programme = (id) => { const p = db.one(`SELECT * FROM county_programmes WHERE id=?`, id); if (!p) throw notFound('Programme not found'); return p; };

  r.get('/api/county/programmes', ...view, (ctx) => {
    const rows = db.all(`SELECT p.*, (SELECT COUNT(*) FROM county_submissions s WHERE s.programme_id=p.id AND s.superseded_by IS NULL AND s.withdrawn_at IS NULL) current_submissions,
      (SELECT MAX(received_at) FROM county_submissions s WHERE s.programme_id=p.id) last_received FROM county_programmes p ORDER BY p.active DESC, p.name COLLATE NOCASE`);
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'programmes', count: rows.length } });
    return { rows: rows.map(p => ({ ...K.programmeOut(p), current_submissions: p.current_submissions, last_received: p.last_received })) };
  });
  r.post('/api/county/fingerprint', ...manage, (ctx) => {
    const v = validate(ctx.body, { public_key: { type: 'string', required: true, maxLen: 4000 } });
    let k; try { k = K.parsePublicKey(v.public_key); } catch (e) { throw badRequest(e.message, { fields: { public_key: e.message } }); }
    const taken = db.one(`SELECT name FROM county_programmes WHERE fingerprint=?`, k.fingerprint);
    return { fingerprint: k.fingerprint, fingerprint_display: K.formatFingerprint(k.fingerprint), registered_as: taken ? taken.name : null };
  });
  r.post('/api/county/programmes', ...manage, (ctx) => {
    const v = validate(ctx.body, { name: { type: 'string', required: true, maxLen: 200 }, public_key: { type: 'string', required: true, maxLen: 4000 }, notes: { type: 'string', maxLen: 2000 }, fingerprint: { type: 'string', maxLen: 100 } });
    if (!String(v.name).trim()) throw badRequest('Give the programme\'s name', { fields: { name: 'required' } });
    let k; try { k = K.parsePublicKey(v.public_key); } catch (e) { throw badRequest(e.message, { fields: { public_key: e.message } }); }
    // The fingerprint the programme read out, when the person typed it: it must match the key they pasted.
    if (v.fingerprint && K.normaliseFingerprint(v.fingerprint) !== k.fingerprint) throw badRequest(`The fingerprint you typed does not match this key (its fingerprint is ${K.formatFingerprint(k.fingerprint)}). Check the key with the programme before registering it.`, { fields: { fingerprint: 'does not match the key' } });
    const taken = db.one(`SELECT name FROM county_programmes WHERE fingerprint=?`, k.fingerprint);
    if (taken) throw conflict(`This key is already registered, for ${taken.name}.`);
    const id = require('../crypto').uuid(); const now = db.now();
    db.run(`INSERT INTO county_programmes(id,name,public_key,fingerprint,active,notes,created_at,created_by,updated_at) VALUES(?,?,?,?,1,?,?,?,?)`, id, String(v.name).trim(), k.pem, k.fingerprint, v.notes || null, now, ctx.user.id, now);
    audit.log({ user: ctx.user, action: 'county.programme.add', entity: 'county_programme', entityId: id, ip: ctx.ip, details: { fingerprint: k.fingerprint } });
    ctx.status = 201;
    return K.programmeOut(programme(id));
  });
  r.put('/api/county/programmes/:id', ...manage, (ctx) => {
    const p = programme(ctx.params.id);
    const v = validate(ctx.body, { name: { type: 'string', maxLen: 200 }, notes: { type: 'string', maxLen: 2000 }, active: { type: 'boolean' } }, { partial: true });
    const name = v.name !== undefined && v.name !== null ? String(v.name).trim() : p.name;
    if (!name) throw badRequest('Give the programme\'s name', { fields: { name: 'required' } });
    const active = v.active === undefined || v.active === null ? !!p.active : !!v.active;
    db.run(`UPDATE county_programmes SET name=?, notes=?, active=?, updated_at=? WHERE id=?`, name, v.notes !== undefined ? (v.notes || null) : p.notes, active ? 1 : 0, db.now(), p.id);
    const action = !!p.active && !active ? 'county.programme.deactivate' : 'county.programme.update';
    audit.log({ user: ctx.user, action, entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { fingerprint: p.fingerprint, changed: ['name', 'notes', 'active'].filter(k => v[k] !== undefined), active } });
    return K.programmeOut(programme(p.id));
  });

  r.get('/api/county/submissions', ...view, (ctx) => {
    const pid = ctx.query.get('programme_id');
    const rows = db.all(`SELECT s.*, p.name programme, p.fingerprint FROM county_submissions s JOIN county_programmes p ON p.id=s.programme_id ${pid ? 'WHERE s.programme_id=?' : ''} ORDER BY s.received_at DESC LIMIT 500`, ...(pid ? [pid] : []));
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'submissions', count: rows.length } });
    return { rows: rows.map(s => ({ ...K.summary(s), programme: s.programme, fingerprint: s.fingerprint, fingerprint_display: K.formatFingerprint(s.fingerprint) })) };
  });
  r.post('/api/county/submissions', ...manage, (ctx) => {
    const { rateLimit, rateLimited } = require('../app');
    const key = `county-refuse:${ctx.user.id}`;
    if (rateLimited(key, REFUSALS_PER_10_MIN)) throw new HttpError(429, 'Too many files were refused in the last few minutes. Wait ten minutes, and check with the programme that it sent the file SUDS made.');
    const textIn = ctx.body && typeof ctx.body.text === 'string' ? ctx.body.text : '';
    const fileSha = textIn ? require('../crypto').sha256(textIn) : null;
    try {
      const parsed = K.parseFile(textIn, { today: today() });
      const out = K.importParsed(parsed, ctx.user);
      const s = out.submission;
      const action = out.status === 'duplicate' ? 'county.submission.duplicate' : 'county.submission.import';
      audit.log({ user: ctx.user, action, entity: 'county_submission', entityId: s.id, ip: ctx.ip, details: { programme_id: out.programme.id, fingerprint: parsed.fingerprint, from: s.period_from, to: s.period_to, sha256: s.sha256, superseded: out.replaced || undefined } });
      ctx.status = out.status === 'duplicate' ? 200 : 201;
      const said = out.status === 'duplicate' ? `This file was already imported on ${s.received_at.slice(0, 10)}; nothing changed.`
        : out.status === 'superseded' ? `Imported ${out.programme.name}'s submission for ${s.period_from} to ${s.period_to}. It replaces the one received earlier for the same period, which is kept but no longer counts.`
          : `Imported ${out.programme.name}'s submission for ${s.period_from} to ${s.period_to}.`;
      return { status: out.status, message: said, submission: { ...s, programme: out.programme.name }, replaced: out.replaced };
    } catch (e) {
      if (!(e instanceof K.SubmissionError)) throw e;
      rateLimit(key, REFUSALS_PER_10_MIN, 10 * 60_000);
      audit.log({ user: ctx.user, action: 'county.submission.refuse', ip: ctx.ip, success: false, details: { reason: e.code, file_sha256: fileSha, bytes: textIn ? Buffer.byteLength(textIn) : 0 } });
      throw new HttpError(e.code === 'too_large' ? 413 : 422, e.message, { reason: e.code });
    }
  });
  r.post('/api/county/submissions/:id/withdraw', ...manage, (ctx) => {
    const s = db.one(`SELECT * FROM county_submissions WHERE id=?`, ctx.params.id);
    if (!s) throw notFound('Submission not found');
    if (s.withdrawn_at) throw conflict('This submission was already withdrawn.');
    const v = validate(ctx.body || {}, { reason: { type: 'string', maxLen: 500 } }, { partial: true });
    db.run(`UPDATE county_submissions SET withdrawn_at=?, withdrawn_by=? WHERE id=?`, db.now(), ctx.user.id, s.id);
    // The reason is the county's own words about a file, not PHI; kept to its length in the audit log only.
    audit.log({ user: ctx.user, action: 'county.submission.withdraw', entity: 'county_submission', entityId: s.id, ip: ctx.ip, details: { programme_id: s.programme_id, from: s.period_from, to: s.period_to, sha256: s.sha256, reason_given: !!(v.reason && v.reason.trim()) } });
    return K.summary(db.one(`SELECT * FROM county_submissions WHERE id=?`, s.id));
  });

  r.get('/api/county/view', ...view, (ctx) => {
    const { from, to } = periodOf(ctx);
    const d = K.combined(from, to);
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'combined', from, to, programmes: d.programmes.length, submitted: d.submitted, submissions: d.programmes.reduce((n, p) => n + p.submissions.length, 0) } });
    return { ...d, indicators: MAP.INDICATORS };
  });
  r.get('/api/county/view/export', ...view, auth.requirePerm('export:read'), (ctx) => {
    const { from, to } = periodOf(ctx);
    const d = K.combined(from, to); const xlsx = ctx.query.get('format') === 'xlsx';
    const S = require('../spreadsheet');
    const progCols = d.programmes.map((p, i) => ({ key: `p${i}`, label: p.name }));
    const matrix = d.rows.map(x => ({ group: { spending: 'Spending', use: 'Spent by allowable use (Exhibit E)', hiaa: 'Spent by High Impact Abatement Activity', outcome: 'Outcomes' }[x.group], measure: x.label,
      ...Object.fromEntries(d.programmes.map((p, i) => [`p${i}`, x.by[p.id]])), total: x.total }));
    const matrixCols = [{ key: 'group', label: 'Section' }, { key: 'measure', label: 'Measure' }, ...progCols, { key: 'total', label: 'Total (summed, not unduplicated)' }];
    const about = [
      { k: 'Report', v: 'County view: settlement spending and outcomes from the programmes\' signed submissions' }, { k: 'Period', v: `${from} to ${to}` },
      { k: 'County', v: db.getSetting('org_name', '') || '' },
      { k: 'Classification', v: 'Internal — exact counts. For authorised county staff only; not for publication or sharing.' },
      ...d.caveats.map((c, i) => ({ k: `Caveat ${i + 1}`, v: c })),
      { k: 'Which submissions count', v: d.rule }, { k: 'Publication', v: d.publication_note },
      { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
    ];
    const subs = d.programmes.flatMap(p => [...p.submissions.map(s => ({ ...s, used: 'Counted' })), ...p.left_out.map(s => ({ ...s, used: s.why === 'overlaps' ? 'Left out: overlaps a longer submission' : 'Left out: not wholly inside the period' }))]
      .map(s => ({ programme: p.name, fingerprint: p.fingerprint_display, period: `${s.period_from} to ${s.period_to}`, received: s.received_at, used: s.used, sha256: s.sha256 })));
    if (!d.programmes.length) subs.push({ programme: 'No programmes registered', fingerprint: '', period: '', received: '', used: '', sha256: '' });
    for (const p of d.programmes) if (p.status === 'none') subs.push({ programme: p.name, fingerprint: p.fingerprint_display, period: '', received: '', used: 'No submission for this period', sha256: '' });
    const subCols = [['programme', 'Programme'], ['fingerprint', 'Key fingerprint'], ['period', 'Period'], ['received', 'Received'], ['used', 'In the combined figures'], ['sha256', 'SHA-256 of the payload']].map(([key, label]) => ({ key, label }));
    audit.log({ user: ctx.user, action: 'county.export', ip: ctx.ip, details: { from, to, programmes: d.programmes.length, submitted: d.submitted, format: xlsx ? 'xlsx' : 'csv' } });
    ctx.res.writeHead(200, { 'Content-Type': xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-county-view-${from}_${to}-internal-exact.${xlsx ? 'xlsx' : 'csv'}"`,
      'X-SUDS-Export': 'County view: exact aggregate figures from programmes\' signed submissions, for authorised county staff; not for publication. No client-level data.',
      'X-SUDS-Report-Counts': 'exact', 'X-SUDS-Report-Purpose': 'internal' });
    ctx.res.end(xlsx
      ? S.writeWorkbook([{ name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: about }, { name: 'Combined', columns: matrixCols, rows: matrix }, { name: 'Submissions', columns: subCols, rows: subs }])
      : S.toCsv([...about.map(a => ({ group: 'About', measure: a.k, total: a.v })), ...matrix], matrixCols));
  });
};

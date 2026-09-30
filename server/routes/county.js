'use strict';
// The county view (server/county.js; docs/COUNTY-VIEW.md). Office server only: the local kernel leaves this module
// out (LOCAL_ROUTE_MODULES in server/app.js), so SUDS on this device neither makes nor imports a county file.
//
//   The programme's side (a CBO's server), for whoever files its funder submission (reports:funder) and sees the
//   budget (budget:read):
//     GET  /api/county-submission/key      this server's current county signing key (public half and fingerprint)
//                                          or null, and the keys it retired
//     POST /api/county-submission/key      make it, if there is none (Show the key for the county)
//     POST /api/county-submission/key/new  Make a new key: the current one is retired, a new one made
//     GET  /api/county-submission/options  the settlement funds to choose from, and the counties this server made
//                                          files for (their codes, names and the funds chosen last time)
//     GET  /api/county-submission/file     the signed county submission file for ?from&to&county_code&county_name
//                                          &funds=id,id (also export:read)
//   The county's side:
//     GET  /api/county/code                this county's code, for programs to type on their card (county:view)
//     GET  /api/county/programmes          the registered programs, each with its key history (county:view)
//     POST /api/county/programmes          register one: name, public key, the fingerprint read out or "compared",
//                                          notes (county:manage)
//     PUT  /api/county/programmes/:id      rename, change the notes, deactivate or reactivate, keep counting an
//                                          inactive program's files (county:manage)
//     POST /api/county/programmes/:id/keys          replace its key (the old one kept; optionally "compromised")
//     PUT  /api/county/programmes/:id/keys/:keyId   mark a replaced key compromised, or not (county:manage)
//     POST /api/county/fingerprint         the fingerprint of a pasted public key, to compare before saving (county:manage)
//     GET  /api/county/submissions         every imported submission, without figures (county:view)
//     POST /api/county/submissions         import a file: { text } (county:manage)
//     POST /api/county/submissions/:id/withdraw    withdraw one, with a reason (county:manage)
//     POST /api/county/submissions/:id/reinstate   put a withdrawn one back (county:manage)
//     GET  /api/county/view                the combined view for ?from&to, or by quarter (&by=quarter) (county:view)
//     GET  /api/county/view/export         the same as Excel (format=xlsx), CSV, or a long "tidy" CSV (format=tidy)
//                                          (county:view and export:read)
// Every read and write is audited; a refused import is audited with why, refusals are throttled per person, and
// a throttled attempt is audited once per window.
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
const WINDOW_MS = 10 * 60_000;
const IS_FUND = `(source_type='opioid_settlement' OR settlement_use IS NOT NULL OR settlement_hiaa IS NOT NULL)`;

const today = () => require('./budget').localDate();
/** The period asked for: real dates (K.isDay: not 2026-02-30), from on or before to. */
function periodOf(ctx) {
  const from = ctx.query.get('from') || ''; const to = ctx.query.get('to') || '';
  if (!K.isDay(from) || !K.isDay(to)) throw badRequest('Choose a period: from and to must be real dates (YYYY-MM-DD).');
  if (from > to) throw badRequest(`The start date (${K.humanDay(from)}) is after the end date (${K.humanDay(to)}). Choose a start date on or before the end date.`);
  return { from, to };
}
/** The counties this server made files for: { CODE: { name, fund_ids, used_at } } (settings, not PHI). */
function recipients() { try { const o = JSON.parse(db.getSetting('county_submission_recipients', '{}')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }

module.exports = (r) => {
  // ---- the programme's side ----
  const cboPerms = [auth.requireAuth, auth.requirePerm('reports:funder'), auth.requirePerm('budget:read')];
  const keyCreated = (ctx, key) => audit.log({ user: ctx.user, action: 'county_submission.key.create', ip: ctx.ip, details: { fingerprint: key.fingerprint } });
  r.get('/api/county-submission/key', ...cboPerms, () => ({ key: K.currentKey(), retired: K.retiredKeys() }));
  r.post('/api/county-submission/key', ...cboPerms, (ctx) => {
    const { key, created } = K.ensureKey(ctx.user);
    if (created) keyCreated(ctx, key);
    ctx.status = created ? 201 : 200;
    return { key, created, retired: K.retiredKeys() };
  });
  r.post('/api/county-submission/key/new', ...cboPerms, (ctx) => {
    const { old, key } = K.rotateKey(ctx.user);
    // The county must register the new key (its fingerprint read out again) before it imports a file signed with it.
    audit.log({ user: ctx.user, action: 'county_submission.key.rotate', ip: ctx.ip, details: { retired_fingerprint: old ? old.fingerprint : null, fingerprint: key.fingerprint } });
    ctx.status = 201;
    return { key, retired: K.retiredKeys() };
  });
  r.get('/api/county-submission/options', ...cboPerms, () => {
    const funds = db.all(`SELECT id, name, grant_number, is_active FROM funding_sources WHERE ${IS_FUND} ORDER BY is_active DESC, name COLLATE NOCASE, id`);
    const counties = Object.entries(recipients()).map(([code, x]) => ({ code, code_display: K.formatCode(code), name: x.name || '', fund_ids: Array.isArray(x.fund_ids) ? x.fund_ids.filter(id => funds.some(f => f.id === id)) : [], used_at: x.used_at || null }))
      .sort((a, b) => String(b.used_at || '').localeCompare(String(a.used_at || '')));
    return { funds: funds.map(f => ({ ...f, is_active: !!f.is_active })), counties, today: today() };
  });
  r.get('/api/county-submission/file', ...cboPerms, auth.requirePerm('export:read'), async (ctx) => {
    const { from, to } = periodOf(ctx);
    if (to >= today()) throw badRequest(`The period is not over yet: it ends ${K.humanDay(to)}, and today is ${K.humanDay(today())}. A county file reports a period that has ended (for a quarter, make it from the day after the quarter ends).`, { fields: { to: 'the period is not over yet' } });
    const code = K.normaliseCode(ctx.query.get('county_code'));
    if (!code) throw badRequest('Type the county code the county gave you: eight letters and digits, as its County view › Programs page shows it.', { fields: { county_code: 'required' } });
    const countyName = K.cleanText(ctx.query.get('county_name'), K.TEXT_MAX.county_name);
    if (!countyName) throw badRequest('Type the county\'s name, as the file should show it.', { fields: { county_name: 'required' } });
    const ids = String(ctx.query.get('funds') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) throw badRequest('Choose the settlement funds this county pays for: only they go into the file.', { fields: { funds: 'required' } });
    if (ids.length > 200) throw badRequest('Too many funds.');
    const known = new Set(db.all(`SELECT id FROM funding_sources WHERE ${IS_FUND} AND id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).map(x => x.id));
    const unknown = ids.filter(id => !known.has(id));
    if (unknown.length) throw badRequest('One of the funds chosen is not an opioid settlement fund here. Reload the page and choose again.', { fields: { funds: 'not a settlement fund' } });
    const range = require('./reports').range(ctx);
    const raw = await db.readSnapshot(async () => SO.figures(range, { fundIds: [...known] }));
    // The allow-list is checked here too: a figure it does not expect is said, never sent.
    let payload;
    try { payload = K.payloadFrom(raw, { programme: db.getSetting('org_name', ''), recipient: { county_code: code, county_name: countyName } }); }
    catch (e) { if (e instanceof K.SubmissionError) throw badRequest(`The county file could not be made: ${e.message}`); throw e; }
    const { key, created } = K.ensureKey(ctx.user);
    if (created) keyCreated(ctx, key);
    const { file, sha256, fingerprint } = K.signFile(payload);
    // Remembered for next time, for this county: its name and the funds chosen (the card offers them again).
    const rec = recipients(); rec[code] = { name: countyName, fund_ids: [...known], used_at: db.now() };
    db.setSetting('county_submission_recipients', JSON.stringify(rec));
    // It leaves the programme: aggregate counts and money only, no client-level data, not PHI and not a Part 2
    // disclosure. Recorded with what identifies the file, not its figures.
    audit.log({ user: ctx.user, action: 'county_submission.export', ip: ctx.ip, details: { from, to, county_code: code, fingerprint, sha256, funds: payload.funds.length, leaves_programme: true, content: 'aggregate counts and money; no client-level data' } });
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-county-submission-${K.slug(payload.programme)}-${from}_${to}.json"`,
      'X-SUDS-Export': 'County submission: exact aggregate figures for the county under the funding contract; not for publication. No client-level data.' });
    ctx.res.end(JSON.stringify(file, null, 2) + '\n');
  });

  // ---- the county's side ----
  const view = [auth.requireAuth, auth.requirePerm('county:view')];
  const manage = [auth.requireAuth, auth.requirePerm('county:manage')];
  const programme = (id) => { const p = db.one(`SELECT * FROM county_programmes WHERE id=?`, id); if (!p) throw notFound('Program not found'); return p; };
  const code = (ctx) => { const c = K.countyCode(); if (c.created) audit.log({ user: ctx.user, action: 'county.code.create', ip: ctx.ip, details: { county_code: c.code } }); return c.code; };
  /** The key a person pasted, checked against the fingerprint they typed, or their word that they compared it. */
  const checkedKey = (v) => {
    let k; try { k = K.parsePublicKey(v.public_key); } catch (e) { throw badRequest(e.message, { fields: { public_key: e.message } }); }
    if (v.fingerprint) {
      if (K.normaliseFingerprint(v.fingerprint) !== k.fingerprint) throw badRequest(`The fingerprint you typed does not match this key (its fingerprint is ${K.formatFingerprint(k.fingerprint)}). Check the key with the program before registering it.`, { fields: { fingerprint: 'does not match the key' } });
    } else if (!v.compared) {
      throw badRequest('Check the key before trusting it: type the fingerprint the program read out to you, or tick that you compared the fingerprint shown with the one the program read out.', { fields: { fingerprint: 'type the fingerprint the program read out, or tick that you compared it' } });
    }
    const taken = db.one(`SELECT k.programme_id, p.name FROM county_programme_keys k JOIN county_programmes p ON p.id=k.programme_id WHERE k.fingerprint=?`, k.fingerprint);
    return { k, taken };
  };
  const keyFields = { public_key: { type: 'string', required: true, maxLen: 4000 }, fingerprint: { type: 'string', maxLen: 100 }, compared: { type: 'boolean' } };

  r.get('/api/county/code', ...view, (ctx) => { const c = code(ctx); return { code: c, code_display: K.formatCode(c), name: db.getSetting('org_name', '') || '' }; });
  r.get('/api/county/programmes', ...view, (ctx) => {
    const rows = db.all(`SELECT p.*, (SELECT COUNT(*) FROM county_submissions s JOIN county_programme_keys k ON k.id=s.key_id WHERE s.programme_id=p.id AND s.superseded_by IS NULL AND s.withdrawn_at IS NULL AND k.compromised_at IS NULL) current_submissions,
      (SELECT MAX(received_at) FROM county_submissions s WHERE s.programme_id=p.id) last_received FROM county_programmes p ORDER BY p.active DESC, p.name COLLATE NOCASE`);
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'programmes', count: rows.length } });
    return { rows: rows.map(p => ({ ...K.programmeOut(p), current_submissions: p.current_submissions, last_received: p.last_received })), county_code: K.formatCode(code(ctx)) };
  });
  r.post('/api/county/fingerprint', ...manage, (ctx) => {
    const v = validate(ctx.body, { public_key: { type: 'string', required: true, maxLen: 4000 } });
    let k; try { k = K.parsePublicKey(v.public_key); } catch (e) { throw badRequest(e.message, { fields: { public_key: e.message } }); }
    const taken = db.one(`SELECT p.name, k.replaced_at FROM county_programme_keys k JOIN county_programmes p ON p.id=k.programme_id WHERE k.fingerprint=?`, k.fingerprint);
    return { fingerprint: k.fingerprint, fingerprint_display: K.formatFingerprint(k.fingerprint), registered_as: taken ? taken.name : null, registered_as_old_key: !!(taken && taken.replaced_at) };
  });
  r.post('/api/county/programmes', ...manage, (ctx) => {
    const v = validate(ctx.body, { name: { type: 'string', required: true, maxLen: 200 }, notes: { type: 'string', maxLen: 2000 }, ...keyFields });
    const name = K.cleanText(v.name, 200);
    if (!name) throw badRequest('Give the program\'s name', { fields: { name: 'required' } });
    const { k, taken } = checkedKey(v);
    if (taken) throw conflict(`This key is already registered, for ${taken.name}.`);
    const id = require('../crypto').uuid(); const now = db.now();
    db.transaction(() => {
      db.run(`INSERT INTO county_programmes(id,name,active,keep_files,notes,created_at,created_by,updated_at) VALUES(?,?,1,0,?,?,?,?)`, id, name, v.notes || null, now, ctx.user.id, now);
      db.run(`INSERT INTO county_programme_keys(id,programme_id,public_key,fingerprint,added_at,added_by) VALUES(?,?,?,?,?,?)`, require('../crypto').uuid(), id, k.pem, k.fingerprint, now, ctx.user.id);
    });
    audit.log({ user: ctx.user, action: 'county.programme.add', entity: 'county_programme', entityId: id, ip: ctx.ip, details: { fingerprint: k.fingerprint, checked: v.fingerprint ? 'typed' : 'compared' } });
    ctx.status = 201;
    return K.programmeOut(programme(id));
  });
  r.put('/api/county/programmes/:id', ...manage, (ctx) => {
    const p = programme(ctx.params.id);
    const v = validate(ctx.body, { name: { type: 'string', maxLen: 200 }, notes: { type: 'string', maxLen: 2000 }, active: { type: 'boolean' }, keep_files: { type: 'boolean' } }, { partial: true });
    const name = v.name !== undefined && v.name !== null ? K.cleanText(v.name, 200) : p.name;
    if (!name) throw badRequest('Give the program\'s name', { fields: { name: 'required' } });
    const active = v.active === undefined || v.active === null ? !!p.active : !!v.active;
    const keep = v.keep_files === undefined || v.keep_files === null ? !!p.keep_files : !!v.keep_files;
    db.run(`UPDATE county_programmes SET name=?, notes=?, active=?, keep_files=?, updated_at=? WHERE id=?`, name, v.notes !== undefined ? (v.notes || null) : p.notes, active ? 1 : 0, keep ? 1 : 0, db.now(), p.id);
    const action = !!p.active && !active ? 'county.programme.deactivate' : !p.active && active ? 'county.programme.reactivate' : 'county.programme.update';
    // A deactivated programme's county connection tokens stop working (county-connect.js lookup) and are revoked,
    // each audited, so reactivating it later does not bring an old token back.
    const revoked = action === 'county.programme.deactivate' ? require('../county-connect').revokeForProgramme(p.id, ctx.user, ctx.ip) : 0;
    audit.log({ user: ctx.user, action, entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { changed: ['name', 'notes', 'active', 'keep_files'].filter(k => v[k] !== undefined), active, keep_files: keep, connection_tokens_revoked: revoked || undefined } });
    return K.programmeOut(programme(p.id));
  });
  r.post('/api/county/programmes/:id/keys', ...manage, (ctx) => {
    const p = programme(ctx.params.id);
    const v = validate(ctx.body, { ...keyFields, old_compromised: { type: 'boolean' } });
    const { k, taken } = checkedKey(v);
    if (taken) throw conflict(taken.programme_id === p.id ? `This key was ${p.name}'s before (it was replaced). Ask the program for its new key.` : `This key is already registered, for ${taken.name}.`);
    const old = db.one(`SELECT * FROM county_programme_keys WHERE programme_id=? AND replaced_at IS NULL`, p.id);
    const now = db.now();
    db.transaction(() => {
      if (old) db.run(`UPDATE county_programme_keys SET replaced_at=?, replaced_by=?, compromised_at=?, compromised_by=? WHERE id=?`, now, ctx.user.id, v.old_compromised ? now : null, v.old_compromised ? ctx.user.id : null, old.id);
      db.run(`INSERT INTO county_programme_keys(id,programme_id,public_key,fingerprint,added_at,added_by) VALUES(?,?,?,?,?,?)`, require('../crypto').uuid(), p.id, k.pem, k.fingerprint, now, ctx.user.id);
      if (v.old_compromised) K.resettleProgramme(p.id);
      db.run(`UPDATE county_programmes SET updated_at=? WHERE id=?`, now, p.id);
    });
    audit.log({ user: ctx.user, action: 'county.programme.key.replace', entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { old_fingerprint: old ? old.fingerprint : null, fingerprint: k.fingerprint, old_compromised: !!v.old_compromised, checked: v.fingerprint ? 'typed' : 'compared' } });
    ctx.status = 201;
    return K.programmeOut(programme(p.id));
  });
  r.put('/api/county/programmes/:id/keys/:keyId', ...manage, (ctx) => {
    const p = programme(ctx.params.id);
    const key = db.one(`SELECT * FROM county_programme_keys WHERE id=? AND programme_id=?`, ctx.params.keyId, p.id);
    if (!key) throw notFound('Key not found');
    const v = validate(ctx.body, { compromised: { type: 'boolean', required: true } });
    if (!key.replaced_at) throw conflict('This is the program\'s current key. If it is compromised, replace it first (Replace the key, and tick that the old key was compromised).');
    const want = !!v.compromised;
    if (!!key.compromised_at === want) return K.programmeOut(p);
    db.transaction(() => {
      db.run(`UPDATE county_programme_keys SET compromised_at=?, compromised_by=? WHERE id=?`, want ? db.now() : null, want ? ctx.user.id : null, key.id);
      K.resettleProgramme(p.id);
    });
    const files = db.one(`SELECT COUNT(*) n FROM county_submissions WHERE key_id=?`, key.id).n;
    audit.log({ user: ctx.user, action: want ? 'county.programme.key.compromised' : 'county.programme.key.trusted', entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { fingerprint: key.fingerprint, files } });
    return K.programmeOut(programme(p.id));
  });

  r.get('/api/county/submissions', ...view, (ctx) => {
    const pid = ctx.query.get('programme_id');
    const rows = db.all(`SELECT s.*, p.name programme, k.fingerprint key_fingerprint, k.replaced_at key_replaced_at, k.compromised_at key_compromised_at FROM county_submissions s JOIN county_programmes p ON p.id=s.programme_id
      JOIN county_programme_keys k ON k.id=s.key_id ${pid ? 'WHERE s.programme_id=?' : ''} ORDER BY s.received_at DESC LIMIT 500`, ...(pid ? [pid] : []));
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'submissions', count: rows.length } });
    return { rows: rows.map(s => ({ ...K.summary(s), programme: s.programme })) };
  });
  r.post('/api/county/submissions', ...manage, (ctx) => {
    const { rateLimit, rateLimited } = require('../app');
    const key = `county-refuse:${ctx.user.id}`;
    if (rateLimited(key, REFUSALS_PER_10_MIN)) {
      // Audited once per window, not once per attempt: the refusals that led here are each audited already.
      if (rateLimit(`county-throttle-audit:${ctx.user.id}`, 1, WINDOW_MS)) audit.log({ user: ctx.user, action: 'county.submission.throttled', ip: ctx.ip, success: false, details: { refusals: REFUSALS_PER_10_MIN, window_minutes: WINDOW_MS / 60_000 } });
      throw new HttpError(429, 'Too many files were refused in the last few minutes. Wait ten minutes, and check with the program that it sent the file SUDS made.');
    }
    const textIn = ctx.body && typeof ctx.body.text === 'string' ? ctx.body.text : '';
    const fileSha = textIn ? require('../crypto').sha256(textIn) : null;
    try {
      const parsed = K.parseFile(textIn, { today: today(), now: db.now() });
      const out = K.importParsed(parsed, ctx.user, { countyCode: code(ctx) });
      const s = out.submission; const who = out.programme.name;
      const action = out.status === 'duplicate' ? 'county.submission.duplicate' : 'county.submission.import';
      audit.log({ user: ctx.user, action, entity: 'county_submission', entityId: s.id, ip: ctx.ip, details: { programme_id: out.programme.id, fingerprint: parsed.fingerprint, from: s.period_from, to: s.period_to, sha256: s.sha256, status: out.status, superseded: out.replaced || undefined } });
      ctx.status = out.status === 'duplicate' ? 200 : 201;
      const said = K.importMessage(out);
      return { status: out.status, message: said, submission: { ...s, programme: who }, replaced: out.replaced, counting: out.counting };
    } catch (e) {
      if (!(e instanceof K.SubmissionError)) throw e;
      rateLimit(key, REFUSALS_PER_10_MIN, WINDOW_MS);
      audit.log({ user: ctx.user, action: 'county.submission.refuse', ip: ctx.ip, success: false, details: { reason: e.code, file_sha256: fileSha, bytes: textIn ? Buffer.byteLength(textIn) : 0 } });
      throw new HttpError(e.code === 'too_large' ? 413 : 422, e.message, { reason: e.code });
    }
  });
  r.post('/api/county/submissions/:id/withdraw', ...manage, (ctx) => {
    const v = validate(ctx.body || {}, { reason: { type: 'string', required: true, maxLen: 500 } });
    const reason = K.cleanText(v.reason, 500);
    if (reason.length < 3) throw badRequest('Say why the file is withdrawn (it is kept in the audit log).', { fields: { reason: 'required' } });
    let out;
    try { out = K.withdraw(ctx.params.id, ctx.user); } catch (e) { if (e instanceof K.SubmissionError) throw conflict(e.message); throw e; }
    if (!out) throw notFound('Submission not found');
    // The reason is the county's own words about a file (never figures); kept in the audit log with the file's
    // identity, and which file counts again in its place.
    audit.log({ user: ctx.user, action: 'county.submission.withdraw', entity: 'county_submission', entityId: out.submission.id, ip: ctx.ip, details: { programme_id: out.programme_id, from: out.submission.period_from, to: out.submission.period_to, sha256: out.submission.sha256, reason, counts_again: out.restored ? out.restored.id : null } });
    return { ...out.submission, restored: out.restored };
  });
  r.post('/api/county/submissions/:id/reinstate', ...manage, (ctx) => {
    let out;
    try { out = K.reinstate(ctx.params.id); } catch (e) { if (e instanceof K.SubmissionError) throw conflict(e.message); throw e; }
    if (!out) throw notFound('Submission not found');
    audit.log({ user: ctx.user, action: 'county.submission.reinstate', entity: 'county_submission', entityId: out.submission.id, ip: ctx.ip, details: { programme_id: out.programme_id, from: out.submission.period_from, to: out.submission.period_to, sha256: out.submission.sha256, counts: out.counts, replaces: out.displaced } });
    const s = out.submission;
    const message = out.counts ? `Reinstated. It counts again for ${K.humanPeriod(s.period_from, s.period_to)}${out.displaced ? ', in place of the file that counted' : ''}.`
      : s.status === 'key_compromised' ? 'Reinstated, but it does not count: the key that signed it is marked compromised.'
        : `Reinstated, but it does not count: a file made later for ${K.humanPeriod(s.period_from, s.period_to)} counts. It is kept as replaced.`;
    return { ...s, counts: out.counts, message };
  });

  r.get('/api/county/view', ...view, (ctx) => {
    const { from, to } = periodOf(ctx);
    if (ctx.query.get('by') === 'quarter') {
      const d = K.byQuarter(from, to);
      audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'by_quarter', from, to, quarters: d.quarters.length } });
      return { ...d, by: 'quarter', caveats: K.CAVEATS, caveat_summary: K.CAVEAT_SUMMARY, publication_note: K.PUBLICATION_NOTE, rule: K.PERIOD_RULE };
    }
    const d = K.combined(from, to);
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'combined', from, to, programmes: d.programmes.length, submitted: d.submitted, submissions: d.programmes.reduce((n, p) => n + p.submissions.length, 0) } });
    return { ...d, indicators: MAP.INDICATORS };
  });
  r.get('/api/county/view/export', ...view, auth.requirePerm('export:read'), (ctx) => {
    const { from, to } = periodOf(ctx);
    const format = ['xlsx', 'tidy'].includes(ctx.query.get('format')) ? ctx.query.get('format') : 'csv';
    const d = K.combined(from, to);
    const S = require('../spreadsheet');
    const notSubmitted = '— (not submitted)';
    const progCols = d.programmes.map((p, i) => ({ key: `p${i}`, label: p.status === 'part' ? `${p.name} (part of the period)` : p.status === 'none' ? `${p.name} (not submitted)` : p.name }));
    const matrix = d.rows.map(x => ({ group: { spending: 'Spending', use: 'Spent by allowable use (Exhibit E)', hiaa: 'Spent by High Impact Abatement Activity', outcome: 'Outcomes' }[x.group], measure: x.label,
      ...Object.fromEntries(d.programmes.map((p, i) => [`p${i}`, x.by[p.id] === null ? notSubmitted : x.by[p.id]])), total: x.total }));
    const matrixCols = [{ key: 'group', label: 'Section' }, { key: 'measure', label: 'Measure' }, ...progCols, { key: 'total', label: `Total (${d.whole} of ${d.of} programs complete)` }];
    const about = [
      { k: 'Report', v: 'County view: settlement spending and outcomes from the programs\' signed submissions' }, { k: 'Period', v: `${from} to ${to}` },
      { k: 'County', v: db.getSetting('org_name', '') || '' },
      { k: 'Who submitted', v: d.headline },
      { k: 'Classification', v: 'Internal — exact counts. For authorised county staff only; not for publication or sharing.' },
      ...d.caveats.map((c, i) => ({ k: `Caveat ${i + 1}`, v: c })),
      { k: 'Which submissions count', v: d.rule }, { k: 'Publication', v: d.publication_note },
      ...(d.inactive_left_out.length ? [{ k: 'Inactive programs left out', v: d.inactive_left_out.map(p => p.name).join('; ') }] : []),
      { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
    ];
    const subs = d.programmes.flatMap(p => [...p.submissions.map(s => ({ ...s, used: 'Counted' })), ...p.left_out.map(s => ({ ...s, used: s.why === 'overlaps' ? 'Left out: overlaps a longer submission' : 'Left out: not wholly inside the period' }))]
      .map(s => ({ programme: p.name, fingerprint: s.key_fingerprint_display, period: `${s.period_from} to ${s.period_to}`, made: s.generated_at, received: s.received_at, used: s.used, sha256: s.sha256 })));
    if (!d.programmes.length) subs.push({ programme: 'No programs registered', fingerprint: '', period: '', made: '', received: '', used: '', sha256: '' });
    for (const p of d.programmes) if (p.status === 'none') subs.push({ programme: p.name, fingerprint: '', period: '', made: '', received: '', used: 'No submission for this period', sha256: '' });
    const subCols = [['programme', 'Program'], ['fingerprint', 'Key fingerprint'], ['period', 'Period'], ['made', 'Made'], ['received', 'Received'], ['used', 'In the combined figures'], ['sha256', 'SHA-256 of the payload']].map(([key, label]) => ({ key, label }));
    // The long ("tidy") form: one row per program, submission, fund and measure, for a county analyst's own tools.
    const tidy = [];
    const spendMeasures = [['spend_own_category', 'Spent under the fund\'s own Exhibit E category ($)'], ['spend_other_categories', 'Spent under other categories ($)'], ['spend_approved', 'Spent, approved or reimbursed ($)'], ['spend_pending', 'Pending approval ($)']];
    const subRows = db.all(`SELECT id, payload_enc FROM county_submissions WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(d.programmes.flatMap(p => p.submissions.map(s => s.id))));
    const payloads = new Map(subRows.map(s => [s.id, JSON.parse(require('../crypto').decrypt(s.payload_enc))]));
    for (const p of d.programmes) for (const s of p.submissions) {
      const pl = payloads.get(s.id); if (!pl) continue;
      const base = { program: p.name, period_from: s.period_from, period_to: s.period_to };
      for (const f of pl.funds) {
        const fb = { ...base, fund: f.name, grant_number: f.grant_number || '' };
        for (const [code, label] of spendMeasures) tidy.push({ ...fb, measure_code: code, measure_label: label, value: f.spend[code.replace(/^spend_/, '')] });
        for (const k of K.VALUE_KEYS) tidy.push({ ...fb, measure_code: k, measure_label: K.measureLabel(k), value: f.values[k] });
      }
      const tb = { ...base, fund: 'All funds in the submission', grant_number: '' };
      tidy.push({ ...tb, measure_code: 'spend_approved', measure_label: 'Spent, approved or reimbursed ($)', value: pl.total.spend.approved }, { ...tb, measure_code: 'spend_pending', measure_label: 'Pending approval ($)', value: pl.total.spend.pending });
      for (const k of K.VALUE_KEYS) tidy.push({ ...tb, measure_code: k, measure_label: K.measureLabel(k), value: pl.total.values[k] });
    }
    const tidyCols = ['program', 'period_from', 'period_to', 'fund', 'grant_number', 'measure_code', 'measure_label', 'value'].map(key => ({ key, label: key }));
    audit.log({ user: ctx.user, action: 'county.export', ip: ctx.ip, details: { from, to, programmes: d.programmes.length, submitted: d.submitted, format } });
    const ext = format === 'xlsx' ? 'xlsx' : 'csv';
    ctx.res.writeHead(200, { 'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-county-view-${from}_${to}${format === 'tidy' ? '-tidy' : ''}-internal-exact.${ext}"`,
      'X-SUDS-Export': 'County view: exact aggregate figures from programs\' signed submissions, for authorised county staff; not for publication. No client-level data.',
      'X-SUDS-Report-Counts': 'exact', 'X-SUDS-Report-Purpose': 'internal' });
    ctx.res.end(format === 'xlsx'
      ? S.writeWorkbook([{ name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: about }, { name: 'Combined', columns: matrixCols, rows: matrix }, { name: 'Submissions', columns: subCols, rows: subs }, { name: 'Tidy', columns: tidyCols, rows: tidy }])
      : format === 'tidy' ? S.toCsv(tidy, tidyCols)
        : S.toCsv([...about.map(a => ({ group: 'About', measure: a.k, total: a.v })), ...matrix], matrixCols));
  });
};

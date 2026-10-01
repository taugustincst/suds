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
//                                          &funds=id,id (also export:read); schema version 2 (each fund's award) unless
//                                          &schema_version=1, for a county on SUDS 1.20 or earlier
//   Reporting-cadence reminders (released in 1.21.0; server/county-schedule.js), for the same people:
//     GET    /api/county-submission/reminders          each county's expected periods, when each file is due, whether
//                                                      it was made or sent, and the reminders (the periods not done)
//     PUT    /api/county-submission/schedules/:code    the programme's own schedule for a county: { county_name,
//                                                      cadence, due_days, start }
//     DELETE /api/county-submission/schedules/:code    remove it
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
//   County-entered figures for a programme not on SUDS (released in 1.20.0; server/county-entry.js):
//     POST /api/county/programmes          with { not_on_suds: true }: register one with no key (county:manage)
//     POST /api/county/programmes/:id/entries         its figures for a period, from the form (county:manage)
//     POST /api/county/programmes/:id/entries/import  a tidy CSV of its figures: { text, source_ref, funds, preview }
//                                          (county:manage); with preview, nothing is written
//     GET  /api/county/programmes/:id/entries/template  the long CSV's header and a row per measure of each of its
//                                          funds for ?from&to, values empty, to fill in (county:manage)
//     GET  /api/county/entries/:id         an entry's figures in the form's shape, to correct them (county:manage)
//   Withdraw and reinstate above take entered figures too. The view and its files take &entered=exclude.
//     GET  /api/county/view                the combined view for ?from&to, or by quarter (&by=quarter) (county:view)
//     GET  /api/county/view/export         the same as Excel (format=xlsx), CSV, or a long "tidy" CSV (format=tidy)
//                                          (county:view and export:read)
//   Publication releases of the combined figures (released in 1.21.0; server/county-publication.js):
//     POST /api/county/publications/prepare  screen a period's combined figures: { from, to, entered, threshold } ->
//                                          the content and its SHA-256, nothing recorded (county:manage)
//     POST /api/county/publications        publish it: the same choices, the SHA-256 reviewed and reviewed: true
//                                          (county:manage)
//     GET  /api/county/publications        the releases published, and withdrawn (county:view)
//     GET  /api/county/publications/:id    one, as published (county:view; the withdrawal's reason for county:manage)
//     GET  /api/county/publications/:id/export  as CSV, Excel (with a Notes sheet) or JSON (county:view, export:read)
//     POST /api/county/publications/:id/withdraw  withdraw one, with a reason: a record of its own (county:manage)
//   Publication governance (built for 1.22.0): prepare and publish take without_consent (refuse, the default, or
//   leave_out); a corrected release of exactly the period of a withdrawn one is allowed (county-publication.js).
//     GET  /api/county/programmes/:id/publication-consent           its consents, current and withdrawn (county:view;
//                                          the agreement's reference for county:manage only)
//     POST /api/county/programmes/:id/publication-consent           record its written agreement { agreed_on,
//                                          reference } (county:manage)
//     POST /api/county/programmes/:id/publication-consent/withdraw  withdraw it (county:manage)
// Every read and write is audited; a refused import is audited with why, refusals are throttled per person, and
// a throttled attempt is audited once per window.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const K = require('../county');
const E = require('../county-entry');
const SO = require('../settlement-outcomes');
const MAP = require('../settlement-outcome-map');
const { validate } = require('../validate');
const { badRequest, notFound, conflict, HttpError } = require('../http');

/** Refused imports per person per 10 minutes before the next is refused unread (a wrong file is a mistake; 20 is not). */
const REFUSALS_PER_10_MIN = 20;
const WINDOW_MS = 10 * 60_000;
const IS_FUND = `(source_type='opioid_settlement' OR settlement_use IS NOT NULL OR settlement_hiaa IS NOT NULL)`;

const today = () => require('./budget').localDate();
/** A fund's spending in the long CSV, in order, with its labels. */
const spendMeasures = [['spend_own_category', 'Spent under the fund\'s own Exhibit E category ($)'], ['spend_other_categories', 'Spent under other categories ($)'], ['spend_approved', 'Spent, approved or reimbursed ($)'], ['spend_pending', 'Pending approval ($)']];
/** The period asked for: real dates (K.isDay: not 2026-02-30), from on or before to. */
function periodOf(ctx) {
  const from = ctx.query.get('from') || ''; const to = ctx.query.get('to') || '';
  if (!K.isDay(from) || !K.isDay(to)) throw badRequest('Choose a period: from and to must be real dates (YYYY-MM-DD).');
  if (from > to) throw badRequest(`The start date (${K.humanDay(from)}) is after the end date (${K.humanDay(to)}). Choose a start date on or before the end date.`);
  return { from, to };
}
/**
 * Whether a view leaves out the figures the county entered: ?entered=exclude leaves them out, ?entered=include (or
 * no entered at all) counts them; anything else is refused, never read as "include" (a typo must not quietly give
 * the figures the person asked to leave out). The read API's /v1/combined uses the same rule.
 */
function enteredOf(ctx) {
  const v = ctx.query.get('entered');
  if (v === null || v === 'include') return true;
  if (v === 'exclude') return false;
  throw badRequest('entered must be include or exclude (leave it out to count figures entered by the county).', { fields: { entered: 'must be include or exclude' } });
}
/**
 * Refused attempts per person are throttled (a wrong file is a mistake; twenty in ten minutes is not): `bucket`
 * names the count, `action` the audit entry written once per window when it bites. The signed import and the
 * figures the county enters (form and CSV) each have their own count, by the same rule.
 */
function throttle(ctx, bucket, action, message) {
  const { rateLimit, rateLimited } = require('../app');
  const key = `${bucket}:${ctx.user.id}`;
  if (rateLimited(key, REFUSALS_PER_10_MIN)) {
    // Audited once per window, not once per attempt: the refusals that led here are each audited already.
    if (rateLimit(`${bucket}-throttle-audit:${ctx.user.id}`, 1, WINDOW_MS)) audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { refusals: REFUSALS_PER_10_MIN, window_minutes: WINDOW_MS / 60_000 } });
    throw new HttpError(429, message);
  }
  return () => rateLimit(key, REFUSALS_PER_10_MIN, WINDOW_MS);
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
    // The file's version: the latest (each fund's award in it) unless the person asks for version 1, which a county
    // still on SUDS 1.20 or earlier reads (it refuses version 2).
    const sv = ctx.query.get('schema_version');
    if (sv !== null && sv !== '' && !K.SCHEMA_VERSIONS.map(String).includes(sv)) throw badRequest(`schema_version must be ${K.SCHEMA_VERSIONS.join(' or ')}.`, { fields: { schema_version: 'not a version SUDS makes' } });
    const schemaVersion = sv ? Number(sv) : K.SCHEMA_VERSION;
    const range = require('./reports').range(ctx);
    const raw = await db.readSnapshot(async () => SO.figures(range, { fundIds: [...known] }));
    // The allow-list is checked here too: a figure it does not expect is said, never sent.
    let payload;
    try { payload = K.payloadFrom(raw, { programme: db.getSetting('org_name', ''), recipient: { county_code: code, county_name: countyName }, schemaVersion }); }
    catch (e) { if (e instanceof K.SubmissionError) throw badRequest(`The county file could not be made: ${e.message}`); throw e; }
    const { key, created } = K.ensureKey(ctx.user);
    if (created) keyCreated(ctx, key);
    const { file, sha256, fingerprint } = K.signFile(payload);
    // Remembered for next time, for this county: its name and the funds chosen (the card offers them again).
    const rec = recipients(); rec[code] = { name: countyName, fund_ids: [...known], used_at: db.now() };
    db.setSetting('county_submission_recipients', JSON.stringify(rec));
    // Made: the reminders count the period done for this county (county-schedule.js).
    require('../county-schedule').recordMade({ county_code: code, from, to, sha256, schema_version: payload.schema_version, via: 'download' });
    // It leaves the programme: aggregate counts and money only, no client-level data, not PHI and not a Part 2
    // disclosure. Recorded with what identifies the file, not its figures.
    audit.log({ user: ctx.user, action: 'county_submission.export', ip: ctx.ip, details: { from, to, county_code: code, fingerprint, sha256, schema_version: payload.schema_version, funds: payload.funds.length, leaves_programme: true, content: 'aggregate counts and money; no client-level data' } });
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-county-submission-${K.slug(payload.programme)}-${from}_${to}.json"`,
      'X-SUDS-Export': 'County submission: exact aggregate figures for the county under the funding contract; not for publication. No client-level data.' });
    ctx.res.end(JSON.stringify(file, null, 2) + '\n');
  });

  // ---- reporting-cadence reminders (county-schedule.js) ----
  const SCH = require('../county-schedule');
  r.get('/api/county-submission/reminders', ...cboPerms, () => SCH.reminders());
  r.put('/api/county-submission/schedules/:code', ...cboPerms, (ctx) => {
    const v = validate(ctx.body, { county_name: { type: 'string', maxLen: 400 }, cadence: { type: 'string', required: true, maxLen: 40 }, due_days: { type: 'number', integer: true }, start: { type: 'string', maxLen: 10 } });
    let out;
    try { out = SCH.saveSchedule({ county_code: ctx.params.code, county_name: v.county_name, cadence: v.cadence, due_days: v.due_days, start: v.start || null }); }
    catch (e) { if (e.field) throw badRequest(e.message, { fields: { [e.field]: e.message } }); throw e; }
    audit.log({ user: ctx.user, action: 'county_submission.schedule.save', ip: ctx.ip, details: { county_code: out.code, cadence: out.schedule.cadence, due_days: out.schedule.due_days, start: out.schedule.start } });
    return SCH.reminders();
  });
  r.delete('/api/county-submission/schedules/:code', ...cboPerms, (ctx) => {
    const code = K.normaliseCode(ctx.params.code);
    if (!code || !SCH.removeSchedule(code)) throw notFound('No schedule for that county code');
    audit.log({ user: ctx.user, action: 'county_submission.schedule.remove', ip: ctx.ip, details: { county_code: code } });
    return SCH.reminders();
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
  /**
   * A programme's name must be its own: two programmes of one name (whatever the case or spacing) are refused, on
   * registering either kind and on renaming. The long CSV matches a row to its programme by name, and the county's
   * people tell programmes apart by it, so a programme not on SUDS must never share a signed programme's name.
   */
  const uniqueName = (name, exceptId = null) => {
    const want = name.trim().toLowerCase();
    const other = db.all(`SELECT id, name FROM county_programmes`).find(x => x.id !== exceptId && K.cleanText(x.name, 200).toLowerCase() === want);
    if (other) throw new HttpError(409, `A program named "${other.name}" is already registered. Give each program its own name (add the city or the service, for example): the county's files and the long CSV tell programs apart by name.`, { fields: { name: 'is already another program\'s name' }, reason: 'duplicate_name' });
  };
  const keyFields = { public_key: { type: 'string', required: true, maxLen: 4000 }, fingerprint: { type: 'string', maxLen: 100 }, compared: { type: 'boolean' } };

  r.get('/api/county/code', ...view, (ctx) => { const c = code(ctx); return { code: c, code_display: K.formatCode(c), name: db.getSetting('org_name', '') || '' }; });
  r.get('/api/county/programmes', ...view, (ctx) => {
    const rows = db.all(`SELECT p.*, (SELECT COUNT(*) FROM county_submissions s LEFT JOIN county_programme_keys k ON k.id=s.key_id WHERE s.programme_id=p.id AND s.superseded_by IS NULL AND s.withdrawn_at IS NULL AND k.compromised_at IS NULL) current_submissions,
      (SELECT MAX(received_at) FROM county_submissions s WHERE s.programme_id=p.id) last_received FROM county_programmes p ORDER BY p.active DESC, p.name COLLATE NOCASE`);
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'programmes', count: rows.length } });
    // The outcomes a submission carries, for the Enter figures form (one programme's own count: never "unduplicated" here).
    const measures = K.VALUE_KEYS.map(k => ({ key: k, label: MAP.INDICATORS[k].label.replace(/\s*\(unduplicated\)/, '').replace(/unduplicated /, '') }));
    // Each programme's current consent to publication (built for 1.22.0): its date and who recorded it; the
    // agreement's reference (typed text) is read on the programme's own consent route, by county:manage.
    const consent = require('../county-publication').consents();
    return { rows: rows.map(p => ({ ...K.programmeOut(p), current_submissions: p.current_submissions, last_received: p.last_received, publication_consent: consent.get(p.id) || null })), county_code: K.formatCode(code(ctx)), measures };
  });
  r.post('/api/county/fingerprint', ...manage, (ctx) => {
    const v = validate(ctx.body, { public_key: { type: 'string', required: true, maxLen: 4000 } });
    let k; try { k = K.parsePublicKey(v.public_key); } catch (e) { throw badRequest(e.message, { fields: { public_key: e.message } }); }
    const taken = db.one(`SELECT p.name, k.replaced_at FROM county_programme_keys k JOIN county_programmes p ON p.id=k.programme_id WHERE k.fingerprint=?`, k.fingerprint);
    return { fingerprint: k.fingerprint, fingerprint_display: K.formatFingerprint(k.fingerprint), registered_as: taken ? taken.name : null, registered_as_old_key: !!(taken && taken.replaced_at) };
  });
  r.post('/api/county/programmes', ...manage, (ctx) => {
    if (ctx.body && ctx.body.not_on_suds === true) {
      // A grantee that does not run SUDS: no key, and figures only the county enters (county-entry.js).
      const v = validate(ctx.body, { name: { type: 'string', required: true, maxLen: 200 }, notes: { type: 'string', maxLen: 2000 }, not_on_suds: { type: 'boolean' } });
      const name = K.cleanText(v.name, 200);
      if (!name) throw badRequest('Give the program\'s name', { fields: { name: 'required' } });
      uniqueName(name);
      const id = require('../crypto').uuid(); const now = db.now();
      db.run(`INSERT INTO county_programmes(id,name,active,keep_files,notes,created_at,created_by,updated_at,on_suds) VALUES(?,?,1,0,?,?,?,?,0)`, id, name, v.notes || null, now, ctx.user.id, now);
      audit.log({ user: ctx.user, action: 'county.programme.add', entity: 'county_programme', entityId: id, ip: ctx.ip, details: { on_suds: false } });
      ctx.status = 201;
      return K.programmeOut(programme(id));
    }
    const v = validate(ctx.body, { name: { type: 'string', required: true, maxLen: 200 }, notes: { type: 'string', maxLen: 2000 }, ...keyFields });
    const name = K.cleanText(v.name, 200);
    if (!name) throw badRequest('Give the program\'s name', { fields: { name: 'required' } });
    uniqueName(name);
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
    uniqueName(name, p.id);
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
    // A programme not on SUDS that now runs it: its first key. Its entered figures stay, marked as entered: they can
    // be withdrawn and reinstated but no longer corrected or added to (county-entry.js programmeFor refuses a
    // programme on SUDS), and a signed file outranks them wherever the two overlap (county.js resettle, choose).
    const joins = p.on_suds === 0;
    db.transaction(() => {
      if (joins) db.run(`UPDATE county_programmes SET on_suds=1 WHERE id=?`, p.id);
      if (old) db.run(`UPDATE county_programme_keys SET replaced_at=?, replaced_by=?, compromised_at=?, compromised_by=? WHERE id=?`, now, ctx.user.id, v.old_compromised ? now : null, v.old_compromised ? ctx.user.id : null, old.id);
      db.run(`INSERT INTO county_programme_keys(id,programme_id,public_key,fingerprint,added_at,added_by) VALUES(?,?,?,?,?,?)`, require('../crypto').uuid(), p.id, k.pem, k.fingerprint, now, ctx.user.id);
      if (v.old_compromised) K.resettleProgramme(p.id);
      db.run(`UPDATE county_programmes SET updated_at=? WHERE id=?`, now, p.id);
    });
    audit.log({ user: ctx.user, action: 'county.programme.key.replace', entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { old_fingerprint: old ? old.fingerprint : null, fingerprint: k.fingerprint, old_compromised: !!v.old_compromised, checked: v.fingerprint ? 'typed' : 'compared', joined_suds: joins || undefined } });
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

  // ---- publication consent, per programme (built for 1.22.0; server/county-publication.js) ----
  const consentErr = (e) => { if (e instanceof require('../county-publication').PublicationError) return new HttpError(e.status, e.message, { reason: e.code, ...(e.code === 'agreed_on' || e.code === 'reference' ? { fields: { [e.code]: e.message } } : {}) }); return e; };
  r.get('/api/county/programmes/:id/publication-consent', ...view, (ctx) => {
    const p = programme(ctx.params.id);
    const manages = auth.hasPerm(ctx.user, 'county:manage');
    const rows = require('../county-publication').consentHistory(p.id, { reference: manages });
    audit.log({ user: ctx.user, action: 'county.view', entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { what: 'publication_consent', count: rows.length, references: manages || undefined } });
    return { programme: { id: p.id, name: p.name }, current: rows.find(x => !x.withdrawn_at) || null, rows };
  });
  r.post('/api/county/programmes/:id/publication-consent', ...manage, (ctx) => {
    const p = programme(ctx.params.id);
    const v = validate(ctx.body || {}, { agreed_on: { type: 'string', required: true, maxLen: 10 }, reference: { type: 'string', required: true, maxLen: 200 } });
    let c; try { c = require('../county-publication').recordConsent(p.id, v, ctx.user, { today: today() }); } catch (e) { throw consentErr(e); }
    // The agreement's reference is typed text, kept encrypted with the consent: not in the audit log.
    audit.log({ user: ctx.user, action: 'county.publication.consent.record', entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { consent_id: c.id, agreed_on: c.agreed_on } });
    ctx.status = 201;
    return c;
  });
  r.post('/api/county/programmes/:id/publication-consent/withdraw', ...manage, (ctx) => {
    const p = programme(ctx.params.id);
    let c; try { c = require('../county-publication').withdrawConsent(p.id, ctx.user); } catch (e) { throw consentErr(e); }
    audit.log({ user: ctx.user, action: 'county.publication.consent.withdraw', entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { consent_id: c.id, agreed_on: c.agreed_on } });
    return c;
  });

  r.get('/api/county/submissions', ...view, (ctx) => {
    const pid = ctx.query.get('programme_id');
    const rows = db.all(`SELECT s.*, p.name programme, p.on_suds programme_on_suds, k.fingerprint key_fingerprint, k.replaced_at key_replaced_at, k.compromised_at key_compromised_at FROM county_submissions s JOIN county_programmes p ON p.id=s.programme_id
      LEFT JOIN county_programme_keys k ON k.id=s.key_id ${pid ? 'WHERE s.programme_id=?' : ''} ORDER BY s.received_at DESC LIMIT 500`, ...(pid ? [pid] : []));
    // Entered figures carry the source document's reference, for those who enter and correct them (county:manage)
    // only: someone who may only view (county:view) sees that they were entered, not the document's reference.
    const manages = auth.hasPerm(ctx.user, 'county:manage');
    const entered = rows.filter(s => s.source === K.ENTERED);
    const refs = manages ? E.sourceRefs(entered.map(s => s.id)) : new Map();
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'submissions', count: rows.length, entered: entered.length || undefined, source_refs: refs.size || undefined } });
    // programme_on_suds: an entered row of a programme that has since joined SUDS can be withdrawn or reinstated, not
    // corrected (its figures are not entered any more once it signs its own files).
    return { rows: rows.map(s => ({ ...K.summary(s), programme: s.programme, programme_on_suds: s.programme_on_suds !== 0, ...(refs.has(s.id) ? { source_ref: refs.get(s.id) } : {}) })) };
  });
  r.post('/api/county/submissions', ...manage, (ctx) => {
    const refused = throttle(ctx, 'county-refuse', 'county.submission.throttled', 'Too many files were refused in the last few minutes. Wait ten minutes, and check with the program that it sent the file SUDS made.');
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
      refused();
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
    const entered = out.submission.source === K.ENTERED;
    audit.log({ user: ctx.user, action: entered ? 'county.entry.withdraw' : 'county.submission.withdraw', entity: 'county_submission', entityId: out.submission.id, ip: ctx.ip, details: { programme_id: out.programme_id, from: out.submission.period_from, to: out.submission.period_to, sha256: out.submission.sha256, reason, counts_again: out.restored ? out.restored.id : null } });
    return { ...out.submission, restored: out.restored };
  });
  r.post('/api/county/submissions/:id/reinstate', ...manage, (ctx) => {
    let out;
    try { out = K.reinstate(ctx.params.id); } catch (e) { if (e instanceof K.SubmissionError) throw conflict(e.message); throw e; }
    if (!out) throw notFound('Submission not found');
    audit.log({ user: ctx.user, action: out.submission.source === K.ENTERED ? 'county.entry.reinstate' : 'county.submission.reinstate', entity: 'county_submission', entityId: out.submission.id, ip: ctx.ip, details: { programme_id: out.programme_id, from: out.submission.period_from, to: out.submission.period_to, sha256: out.submission.sha256, counts: out.counts, replaces: out.displaced } });
    const s = out.submission;
    const message = out.counts ? `Reinstated. It counts again for ${K.humanPeriod(s.period_from, s.period_to)}${out.displaced ? ', in place of the file that counted' : ''}.`
      : s.status === 'key_compromised' ? 'Reinstated, but it does not count: the key that signed it is marked compromised.'
        : out.counting && out.counting.source !== K.ENTERED && s.source === K.ENTERED ? `Reinstated, but the figures do not count: a signed file for ${K.humanPeriod(s.period_from, s.period_to)} counts, and a signed file outranks figures the county entered. They are kept as replaced.`
          : `Reinstated, but it does not count: a file made later for ${K.humanPeriod(s.period_from, s.period_to)} counts. It is kept as replaced.`;
    return { ...s, counts: out.counts, message };
  });

  // ---- figures the county enters for a programme not on SUDS (county-entry.js) ----
  /** A refused entry: audited with why and where (field names, row numbers), never a figure or a typed value. */
  const entryRefused = (ctx, e, programmeId, via, extra = {}) => {
    audit.log({ user: ctx.user, action: 'county.entry.refuse', entity: 'county_programme', entityId: programmeId, ip: ctx.ip, success: false,
      details: { reason: e.code, via, fields: e.fields ? Object.keys(e.fields).slice(0, 40) : undefined, errors: e.errors ? e.errors.length : undefined, ...extra } });
    if (e.code === 'on_suds' || e.code === 'inactive') return new HttpError(409, e.message, { reason: e.code });
    if (e.code === 'invalid') return badRequest(e.message, { reason: e.code, fields: e.fields || {} });
    return new HttpError(422, e.message, { reason: e.code, errors: e.errors || [] });
  };
  const ENTRY_THROTTLED = 'Too many entries were refused in the last few minutes. Wait ten minutes, then check the figures against the program\'s document.';
  r.post('/api/county/programmes/:id/entries', ...manage, (ctx) => {
    const refused = throttle(ctx, 'county-entry-refuse', 'county.entry.throttled', ENTRY_THROTTLED);
    let out;
    try { out = E.enter(ctx.params.id, ctx.body, ctx.user, { today: today() }); }
    catch (e) { if (e instanceof E.EntryError) { refused(); throw entryRefused(ctx, e, ctx.params.id, 'form'); } throw e; }
    if (!out) throw notFound('Program not found');
    const s = out.submission;
    audit.log({ user: ctx.user, action: out.status === 'superseded' ? 'county.entry.update' : 'county.entry.create', entity: 'county_submission', entityId: s.id, ip: ctx.ip,
      details: { programme_id: out.programme.id, from: s.period_from, to: s.period_to, sha256: s.sha256, via: 'form', status: out.status, replaces: out.replaced || undefined, replaces_source: out.replaced_source || undefined } });
    ctx.status = 201;
    return { status: out.status, message: E.entryMessage(out.programme, s.period_from, s.period_to, out.status, out.replaced_source, out.counting_source), submission: { ...s, programme: out.programme.name }, replaced: out.replaced };
  });
  r.post('/api/county/programmes/:id/entries/import', ...manage, (ctx) => {
    const refused = throttle(ctx, 'county-entry-refuse', 'county.entry.throttled', ENTRY_THROTTLED);
    const text = ctx.body && typeof ctx.body.text === 'string' ? ctx.body.text : '';
    const fileSha = text ? require('../crypto').sha256(text) : null;
    const preview = !!(ctx.body && ctx.body.preview);
    let out;
    try { out = E.importCsv(ctx.params.id, ctx.body, ctx.user, { today: today() }); }
    catch (e) { if (e instanceof E.EntryError) { refused(); throw entryRefused(ctx, e, ctx.params.id, 'csv', { file_sha256: fileSha, bytes: text ? Buffer.byteLength(text) : 0, preview: preview || undefined }); } throw e; }
    if (!out) throw notFound('Program not found');
    if (out.preview) return { preview: true, rows: out.rows, funds: out.funds, periods: out.periods, warnings: out.warnings, others: out.others };
    audit.log({ user: ctx.user, action: 'county.entry.import', entity: 'county_programme', entityId: out.programme.id, ip: ctx.ip,
      details: { programme_id: out.programme.id, via: 'csv', file_sha256: fileSha, rows: out.rows, other_rows: out.others.reduce((n, o) => n + o.rows, 0) || undefined, entries: out.entries.map(e => ({ id: e.id, from: e.from, to: e.to, sha256: e.sha256, status: e.status, replaces: e.replaced || undefined })) } });
    ctx.status = 201;
    const n = out.entries.length; const counting = out.entries.filter(e => e.status !== 'older').length;
    const othersSaid = out.others.length ? ` ${out.warnings[out.warnings.length - 1]}` : '';
    return { preview: false, rows: out.rows, periods: out.periods, others: out.others, entries: out.entries.map(e => ({ ...e.submission, programme: out.programme.name, status_on_entry: e.status })),
      message: `Imported ${out.programme.name}'s figures for ${n} period${n === 1 ? '' : 's'}, ${K.ENTERED_LABEL}.${counting < n ? ` ${n - counting} of them do${n - counting === 1 ? 'es' : ''} not count: ${out.entries.some(e => e.status === 'older' && e.counting_source === 'signed') ? 'a signed file counts for that period, and a signed file outranks figures the county entered' : 'figures entered later for that period count'}.` : ''}${othersSaid}` };
  });
  // A template of the long CSV for one programme not on SUDS and one period: its header, and a row for every measure
  // of each of its funds (those of its latest entered figures; one fund to name if it has none), the values empty.
  // Figures come only from the programme; nothing but the fund names and grant numbers is filled in.
  r.get('/api/county/programmes/:id/entries/template', ...manage, (ctx) => {
    const p = programme(ctx.params.id);
    if (p.on_suds !== 0) throw conflict(`${p.name} runs SUDS and signs its own files: it has no template of figures to enter.`);
    const { from, to } = periodOf(ctx);
    const last = db.one(`SELECT payload_enc FROM county_submissions WHERE programme_id=? AND source=? ORDER BY received_at DESC, id DESC LIMIT 1`, p.id, K.ENTERED);
    const funds = last ? JSON.parse(require('../crypto').decrypt(last.payload_enc)).funds.map(f => ({ name: f.name, grant_number: f.grant_number || '' })) : [{ name: '', grant_number: '' }];
    const rows = [];
    for (const f of funds) {
      const b = { program: p.name, period_from: from, period_to: to, fund: f.name, grant_number: f.grant_number, value: '' };
      for (const [code, label] of spendMeasures) rows.push({ ...b, measure_code: code, measure_label: label });
      for (const k of K.VALUE_KEYS) rows.push({ ...b, measure_code: k, measure_label: K.measureLabel(k) });
      // The award, optional: fill in all three (the amount, the award period's first and last days) or leave all empty.
      for (const [code, label] of E.AWARD_MEASURES) rows.push({ ...b, measure_code: code, measure_label: label });
    }
    audit.log({ user: ctx.user, action: 'county.entry.template', entity: 'county_programme', entityId: p.id, ip: ctx.ip, details: { from, to, funds: funds.length } });
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="suds-county-entry-template-${K.slug(p.name)}-${from}_${to}.csv"` });
    ctx.res.end(require('../spreadsheet').toCsv(rows, E.CSV_COLUMNS.map(key => ({ key, label: key }))));
  });
  r.get('/api/county/entries/:id', ...manage, (ctx) => {
    const f = E.entryForm(ctx.params.id);
    if (!f) throw notFound('No figures entered by the county with that id');
    audit.log({ user: ctx.user, action: 'county.view', entity: 'county_submission', entityId: f.id, ip: ctx.ip, details: { what: 'entry', programme_id: f.programme_id, from: f.from, to: f.to } });
    return f;
  });

  r.get('/api/county/view', ...view, (ctx) => {
    const { from, to } = periodOf(ctx);
    const entered = enteredOf(ctx);
    if (ctx.query.get('by') === 'quarter') {
      const d = K.byQuarter(from, to, { entered });
      audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'by_quarter', from, to, quarters: d.quarters.length, entered_excluded: !entered || undefined } });
      return { ...d, by: 'quarter', caveats: K.CAVEATS, caveat_summary: K.CAVEAT_SUMMARY, publication_note: K.PUBLICATION_NOTE, rule: K.PERIOD_RULE };
    }
    const d = K.combined(from, to, { entered });
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'combined', from, to, programmes: d.programmes.length, submitted: d.submitted, submissions: d.programmes.reduce((n, p) => n + p.submissions.length, 0), entered_programmes: d.entered_programmes || undefined, entered_excluded: !entered || undefined } });
    return { ...d, indicators: MAP.INDICATORS };
  });
  r.get('/api/county/view/export', ...view, auth.requirePerm('export:read'), (ctx) => {
    const { from, to } = periodOf(ctx);
    const format = ['xlsx', 'tidy'].includes(ctx.query.get('format')) ? ctx.query.get('format') : 'csv';
    const entered = enteredOf(ctx);
    const d = K.combined(from, to, { entered });
    // Figures the county entered are marked wherever they appear: the programme's column, the total's own column
    // (the part of it they make up), each submission's row, and each tidy row's source.
    const isEnteredCol = (p) => p.source === K.ENTERED || p.source === 'mixed';
    const anyEntered = d.programmes.some(isEnteredCol);
    const sourceText = (src) => (src === K.ENTERED ? K.ENTERED_LABEL : 'signed by the program');
    const S = require('../spreadsheet');
    const notSubmitted = '— (not submitted)';
    const progCols = d.programmes.map((p, i) => ({ key: `p${i}`, label: `${p.status === 'part' ? `${p.name} (part of the period)` : p.status === 'none' ? `${p.name} (not submitted)` : p.name}${p.source === K.ENTERED ? ` (${K.ENTERED_LABEL})` : p.source === 'mixed' ? ` (some figures ${K.ENTERED_LABEL})` : ''}` }));
    // A programme with figures whose files carry no award has "— (award not in file)" in the award rows (or "— (no
    // award recorded)"), never a 0; the award totals are over the programmes whose files carry it (said in About).
    const cellOf = (x, p) => (x.by[p.id] !== null ? x.by[p.id] : x.by_note && x.by_note[p.id] ? `— (${x.by_note[p.id]})` : notSubmitted);
    const matrix = d.rows.map(x => ({ group: { spending: 'Spending', use: 'Spent by allowable use (Exhibit E)', hiaa: 'Spent by High Impact Abatement Activity', outcome: 'Outcomes', award: `Award (total over ${x.total_over ?? 0} of ${d.award.of} programs)` }[x.group], measure: x.label,
      ...Object.fromEntries(d.programmes.map((p, i) => [`p${i}`, cellOf(x, p)])), total: x.total === null ? `— (${K.AWARD_NOT_IN_FILE} for every program)` : x.total, total_entered: x.total_entered }));
    const matrixCols = [{ key: 'group', label: 'Section' }, { key: 'measure', label: 'Measure' }, ...progCols, { key: 'total', label: `Total (${d.whole} of ${d.of} programs complete)` },
      ...(anyEntered ? [{ key: 'total_entered', label: `Of the total, ${K.ENTERED_LABEL}` }] : [])];
    const about = [
      { k: 'Report', v: `County view: settlement spending and outcomes from the programs' signed submissions${anyEntered ? `, and figures ${K.ENTERED_LABEL}` : ''}` }, { k: 'Period', v: `${from} to ${to}` },
      { k: 'County', v: db.getSetting('org_name', '') || '' },
      { k: 'Who submitted', v: d.headline },
      { k: 'Classification', v: 'Internal — exact counts. For authorised county staff only; not for publication or sharing.' },
      ...d.caveats.map((c, i) => ({ k: `Caveat ${i + 1}`, v: c })),
      { k: 'Which submissions count', v: d.rule }, { k: 'Publication', v: d.publication_note },
      { k: 'Award', v: d.award.note },
      { k: 'Source (long CSV and Tidy sheet)', v: `The source column is "signed" (a file the program's key signed) or "${K.ENTERED}" (${K.ENTERED_LABEL}), as the read API says it; source_label says the same in words.` },
      { k: 'Figures entered by the county', v: entered ? `Counted, and marked "${K.ENTERED_LABEL}". ${d.entered_note}` : `Left out${d.entered_left_out.length ? `: ${d.entered_left_out.map(p => p.name).join('; ')}` : ''}. Only files the programs signed are counted.` },
      ...(d.inactive_left_out.length ? [{ k: 'Inactive programs left out', v: d.inactive_left_out.map(p => p.name).join('; ') }] : []),
      { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
    ];
    const subs = d.programmes.flatMap(p => [...p.submissions.map(s => ({ ...s, used: 'Counted' })), ...p.left_out.map(s => ({ ...s, used: `Left out: ${s.reason}` }))]
      .map(s => ({ programme: p.name, source: sourceText(s.source), fingerprint: s.key_fingerprint_display, period: `${s.period_from} to ${s.period_to}`, made: s.generated_at, received: s.received_at, used: s.used, sha256: s.sha256 })));
    if (!d.programmes.length) subs.push({ programme: 'No programs registered', source: '', fingerprint: '', period: '', made: '', received: '', used: '', sha256: '' });
    for (const p of d.programmes) if (p.status === 'none') subs.push({ programme: p.name, source: '', fingerprint: '', period: '', made: '', received: '', used: 'No submission for this period', sha256: '' });
    const subCols = [['programme', 'Program'], ['source', 'Source'], ['fingerprint', 'Key fingerprint'], ['period', 'Period'], ['made', 'Made or entered'], ['received', 'Received'], ['used', 'In the combined figures'], ['sha256', 'SHA-256 of the payload']].map(([key, label]) => ({ key, label }));
    // The long ("tidy") form: one row per program, submission, fund and measure, for a county analyst's own tools.
    const tidy = [];
    const subRows = db.all(`SELECT id, payload_enc FROM county_submissions WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(d.programmes.flatMap(p => p.submissions.map(s => s.id))));
    const payloads = new Map(subRows.map(s => [s.id, JSON.parse(require('../crypto').decrypt(s.payload_enc))]));
    for (const p of d.programmes) for (const s of p.submissions) {
      const pl = payloads.get(s.id); if (!pl) continue;
      const base = { program: p.name, period_from: s.period_from, period_to: s.period_to, source: s.source === K.ENTERED ? K.ENTERED : 'signed', source_label: sourceText(s.source) };
      for (const f of pl.funds) {
        const fb = { ...base, fund: f.name, grant_number: f.grant_number || '' };
        for (const [code, label] of spendMeasures) tidy.push({ ...fb, measure_code: code, measure_label: label, value: f.spend[code.replace(/^spend_/, '')] });
        for (const k of K.VALUE_KEYS) tidy.push({ ...fb, measure_code: k, measure_label: K.measureLabel(k), value: f.values[k] });
        // The fund's award (schema version 2), in the layout county-entry.js imports: the amount, and the award
        // period's first and last days in the value column. A fund with no award, or a version 1 file, has none.
        if (f.award) for (const [code, label] of E.AWARD_MEASURES) tidy.push({ ...fb, measure_code: code, measure_label: label, value: f.award[code.replace(/^award_/, '')] });
      }
      const tb = { ...base, fund: 'All funds in the submission', grant_number: '' };
      tidy.push({ ...tb, measure_code: 'spend_approved', measure_label: 'Spent, approved or reimbursed ($)', value: pl.total.spend.approved }, { ...tb, measure_code: 'spend_pending', measure_label: 'Pending approval ($)', value: pl.total.spend.pending });
      for (const k of K.VALUE_KEYS) tidy.push({ ...tb, measure_code: k, measure_label: K.measureLabel(k), value: pl.total.values[k] });
    }
    // The layout county-entry.js imports; a ninth column, source, says who each figure is from as a code (signed or
    // county_entered, as the read API says it), and a tenth, source_label, in words.
    const tidyCols = [...E.CSV_COLUMNS, 'source', 'source_label'].map(key => ({ key, label: key }));
    audit.log({ user: ctx.user, action: 'county.export', ip: ctx.ip, details: { from, to, programmes: d.programmes.length, submitted: d.submitted, format, entered_programmes: d.entered_programmes || undefined, entered_excluded: !entered || undefined } });
    const ext = format === 'xlsx' ? 'xlsx' : 'csv';
    ctx.res.writeHead(200, { 'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-county-view-${from}_${to}${format === 'tidy' ? '-tidy' : ''}${entered ? '' : '-signed-only'}-internal-exact.${ext}"`,
      'X-SUDS-Export': `County view: exact aggregate figures from programs' signed submissions${anyEntered ? ' and figures entered by the county (not signed by the program)' : ''}, for authorised county staff; not for publication. No client-level data.`,
      'X-SUDS-Report-Counts': 'exact', 'X-SUDS-Report-Purpose': 'internal' });
    ctx.res.end(format === 'xlsx'
      ? S.writeWorkbook([{ name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: about }, { name: 'Combined', columns: matrixCols, rows: matrix }, { name: 'Submissions', columns: subCols, rows: subs }, { name: 'Tidy', columns: tidyCols, rows: tidy }])
      : format === 'tidy' ? S.toCsv(tidy, tidyCols)
        : S.toCsv([...about.map(a => ({ group: 'About', measure: a.k, total: a.v })), ...matrix], matrixCols));
  });

  // ---- publication releases of the combined figures (released in 1.21.0; server/county-publication.js) ----
  const PUB = require('../county-publication');
  /** The period and choices of a release to prepare or publish, from a JSON body. */
  const pubChoices = (body) => {
    const v = validate(body || {}, { from: { type: 'string', required: true, maxLen: 10 }, to: { type: 'string', required: true, maxLen: 10 }, entered: { type: 'string', maxLen: 10 }, threshold: { type: 'number', integer: true }, without_consent: { type: 'string', maxLen: 10 } });
    if (v.entered !== undefined && v.entered !== null && v.entered !== '' && !['include', 'exclude'].includes(v.entered)) throw badRequest('entered must be include or exclude.', { fields: { entered: 'must be include or exclude' } });
    // A programme with no consent to publication: refuse the release (the default), or leave it out (built for 1.22.0).
    if (v.without_consent !== undefined && v.without_consent !== null && v.without_consent !== '' && !PUB.WITHOUT_CONSENT.includes(v.without_consent)) throw badRequest('without_consent must be refuse or leave_out.', { fields: { without_consent: 'must be refuse or leave_out' } });
    return { from: v.from, to: v.to, entered: v.entered !== 'exclude', threshold: v.threshold === undefined || v.threshold === null ? null : v.threshold, withoutConsent: v.without_consent === 'leave_out' ? 'leave_out' : 'refuse' };
  };
  /** Prepare a release, or say why not: a refusal is audited with why (never a figure). */
  const preparePub = async (ctx, c, action) => {
    code(ctx);
    try { return await PUB.prepare(c, { today: today() }); } catch (e) {
      if (!(e instanceof PUB.PublicationError)) throw e;
      audit.log({ user: ctx.user, action: 'county.publication.refuse', ip: ctx.ip, success: false, details: { step: action, from: c.from, to: c.to, entered: c.entered ? 'include' : 'exclude', threshold: c.threshold || undefined, reason: e.code, ...(e.refusal || {}), ...(e.programmes ? { without_consent: e.programmes.map(p => p.id) } : {}) } });
      throw new HttpError(e.status, e.message, { reason: e.code, ...(e.programmes ? { programmes: e.programmes } : {}) });
    }
  };
  const pubDetails = (c, p) => ({ from: c.from, to: c.to, threshold: p.T, entered: c.entered ? 'include' : 'exclude', sha256: p.sha256, release_id: p.content.release_id, programmes: p.content.programmes.length,
    entered_programmes: p.content.figures_entered_by_the_county.programmes.length || undefined, suppressed: p.content.suppressed.map(x => `${x.key}:${x.reason}`), withheld: p.content.withheld.map(x => x.key),
    left_out_without_consent: p.content.left_out_without_consent ? p.content.left_out_without_consent.length : undefined, corrects: p.content.corrects ? p.content.corrects.map(x => x.sha256) : undefined });
  r.post('/api/county/publications/prepare', ...manage, async (ctx) => {
    const c = pubChoices(ctx.body);
    const p = await preparePub(ctx, c, 'prepare');
    audit.log({ user: ctx.user, action: 'county.publication.prepare', ip: ctx.ip, details: pubDetails(c, p) });
    return { content: p.content, sha256: p.sha256, threshold: p.T, county_threshold: PUB.countyThreshold(), max_threshold: PUB.MAX_THRESHOLD, review_confirmation: PUB.REVIEW_CONFIRMATION };
  });
  r.post('/api/county/publications', ...manage, async (ctx) => {
    const c = pubChoices(ctx.body);
    const v = validate(ctx.body || {}, { sha256: { type: 'string', required: true, maxLen: 64 } });
    if (!ctx.body || ctx.body.reviewed !== true) throw new HttpError(428, `Before publishing, review the release and confirm it: "${PUB.REVIEW_CONFIRMATION}" (reviewed: true). Small figures are screened automatically, which is a conservative default, not a guarantee or an expert determination.`, { reason: 'review_required' });
    const p = await preparePub(ctx, c, 'publish');
    // What is published is exactly what the person reviewed: a file that came or went since is a new release to review.
    if (p.sha256 !== v.sha256) {
      audit.log({ user: ctx.user, action: 'county.publication.refuse', ip: ctx.ip, success: false, details: { step: 'publish', from: c.from, to: c.to, reason: 'changed', reviewed_sha256: v.sha256, sha256: p.sha256 } });
      throw new HttpError(409, 'The figures changed since you prepared this release (a file was imported, withdrawn or reinstated, or figures were entered). Prepare it again and review what would be published.', { reason: 'changed' });
    }
    let rec;
    try { rec = PUB.record(p, c, ctx.user); } catch (e) { if (e instanceof PUB.PublicationError) throw new HttpError(e.status, e.message, { reason: e.code }); throw e; }
    audit.log({ user: ctx.user, action: 'county.publication.publish', entity: 'county_publication', entityId: rec.id, ip: ctx.ip, details: { ...pubDetails(c, p), method: p.content.method.name, confirmation: PUB.REVIEW_CONFIRMATION } });
    ctx.status = 201;
    return rec;
  });
  r.get('/api/county/publications', ...view, (ctx) => {
    const rows = PUB.list();
    audit.log({ user: ctx.user, action: 'county.view', ip: ctx.ip, details: { what: 'publications', count: rows.length } });
    return { rows };
  });
  r.get('/api/county/publications/:id', ...view, (ctx) => {
    const rec = PUB.get(ctx.params.id, { reasons: auth.hasPerm(ctx.user, 'county:manage') });
    if (!rec) throw notFound('Publication release not found');
    audit.log({ user: ctx.user, action: 'county.view', entity: 'county_publication', entityId: rec.id, ip: ctx.ip, details: { what: 'publication', from: rec.period_from, to: rec.period_to } });
    return rec;
  });
  r.get('/api/county/publications/:id/export', ...view, auth.requirePerm('export:read'), (ctx) => {
    const rec = PUB.get(ctx.params.id);
    if (!rec) throw notFound('Publication release not found');
    const format = ['xlsx', 'json'].includes(ctx.query.get('format')) ? ctx.query.get('format') : 'csv';
    audit.log({ user: ctx.user, action: 'county.publication.export', entity: 'county_publication', entityId: rec.id, ip: ctx.ip, details: { from: rec.period_from, to: rec.period_to, format, sha256: rec.sha256, status: rec.status } });
    const S = require('../spreadsheet');
    const x = PUB.sheets(rec);
    const name = `suds-county-publication-${rec.period_from}_${rec.period_to}${rec.status === 'withdrawn' ? '-WITHDRAWN' : ''}`;
    const type = format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8';
    ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}.${format}"`,
      'X-SUDS-Export': `County publication release ${rec.id}: combined figures screened for small cells, for publication${rec.status === 'withdrawn' ? ' (WITHDRAWN: do not use)' : ''}. No client-level data.`,
      'X-SUDS-Report-Counts': `suppressed (threshold ${rec.threshold})`, 'X-SUDS-Report-Purpose': 'publication' });
    if (format === 'json') { ctx.res.end(JSON.stringify({ id: rec.id, sha256: rec.sha256, status: rec.status, published_at: rec.published_at, withdrawn_at: rec.withdrawal ? rec.withdrawal.at : null, release: rec.content }, null, 2) + '\n'); return; }
    ctx.res.end(format === 'xlsx'
      ? S.writeWorkbook([{ name: 'About', columns: x.aboutCols, rows: x.about }, { name: 'Figures', columns: x.figureCols, rows: x.figures }, { name: 'Notes', columns: x.noteCols, rows: x.notes }])
      : S.toCsv([...x.about.map(a => ({ section: 'About', measure: a.k, value: a.v })), ...x.figures, ...x.notes.map(n => ({ section: 'Suppressed or withheld', measure: n.measure, value: n.shown, note: n.why }))], x.figureCols));
  });
  r.post('/api/county/publications/:id/withdraw', ...manage, (ctx) => {
    const v = validate(ctx.body || {}, { reason: { type: 'string', required: true, maxLen: 500 } });
    const reason = K.cleanText(v.reason, 500);
    if (reason.length < 3) throw badRequest('Say why the release is withdrawn.', { fields: { reason: 'required' } });
    let rec;
    try { rec = PUB.withdraw(ctx.params.id, reason, ctx.user); } catch (e) { if (e instanceof PUB.PublicationError) throw new HttpError(e.status, e.message, { reason: e.code }); throw e; }
    if (!rec) throw notFound('Publication release not found');
    // The reason is kept encrypted with the withdrawal (typed text), not in the audit log.
    audit.log({ user: ctx.user, action: 'county.publication.withdraw', entity: 'county_publication', entityId: rec.id, ip: ctx.ip, details: { from: rec.period_from, to: rec.period_to, sha256: rec.sha256, withdrawal_id: rec.withdrawal.id } });
    return rec;
  });
};

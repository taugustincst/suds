'use strict';
// The county connection (server/county-connect.js, server/county-connect-client.js; docs/COUNTY-VIEW.md,
// "Connecting"). Released in 1.18.0. Office server only (LOCAL_ROUTE_MODULES in server/app.js).
//
//   The county's machine routes: a bearer token, never a session, and 404 while the county has not switched the
//   connection on (county_connect_enabled):
//     POST /api/county-connect/v1/submissions   the signed county submission file as the body (connection token)
//     GET  /api/county-connect/v1/status        what the county expects of the calling programme (connection token)
//     GET  /api/county-connect/v1/combined      the combined view for ?from&to[&format=json|tidy-csv] (read token)
//     GET  /api/county-connect/v1/programs      the programmes and their files' periods (read token)
//     GET  /api/county-connect/v1/publications  the county's publication releases, each as published, withdrawn ones
//                                               marked (read token; released in 1.21.0)
//   The county's settings and tokens (signed in):
//     GET  /api/county-connect/settings          on or off, the cadence, the endpoints (county:view)
//     PUT  /api/county-connect/settings          switch on or off, the cadence and start, and how many days after a
//                                                period ends its file is due (due_days; county:manage and settings:manage)
//     GET  /api/county-connect/tokens            every token issued, never the token itself (county:manage)
//     POST /api/county-connect/tokens            issue one, shown once (county:manage)
//     POST /api/county-connect/tokens/:id/revoke revoke one (county:manage)
//   The programme's side (signed in):
//     GET    /api/county-connect/connection        the county's address, whether a token is saved, the send log (settings:manage, or reports:funder with budget:read)
//     PUT    /api/county-connect/connection        save the address and token (settings:manage); the token is never returned
//     DELETE /api/county-connect/connection        disconnect (settings:manage)
//     POST   /api/county-connect/connection/test   ask the county what it expects (settings:manage, or reports:funder with budget:read)
//     POST   /api/county-connect/send              send the county file for { from, to[, funds, county_code, county_name] }
//                                                  (reports:funder, budget:read, export:read): the same file the Send to
//                                                  the county card's download makes for the same choices
// Everything is audited; the machine routes' refusals are throttled in the audit log (county-connect.js logRefusal).
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const CC = require('../county-connect');
const CL = require('../county-connect-client');
const { validate } = require('../validate');
const { badRequest, notFound, forbidden, unauthorized, HttpError } = require('../http');

const K = require('../county');
const isDay = K.isDay;

/** A period from the query or a body: real dates (county.js isDay: not 2026-02-30), the start on or before the end. */
function period(from, to) {
  if (!isDay(from) || !isDay(to)) throw badRequest('Choose a period: from and to must be real dates (YYYY-MM-DD).');
  if (from > to) throw badRequest(`The start date (${K.humanDay(from)}) is after the end date (${K.humanDay(to)}). Choose a start date on or before the end date.`);
  return { from, to };
}

/**
 * The gate every machine route passes before it does anything: switched on (else 404, as if the route did not
 * exist), a live token of the right scope in the Authorization header (a session is never looked at), then the
 * address, all addresses together and the token within their limits. Returns the token row.
 *
 * Callers without a good token have limits of their own, checked first and counted only for them: per address
 * (badPerIp; an address over it waits, good token or not) and all addresses together (badAll). They never count
 * towards the limits of calls with a good token (perIp, all, per token), so a flood of made-up tokens from many
 * addresses cannot make a programme's real token wait.
 */
function machine(ctx, scope, perToken) {
  if (!CC.enabled()) throw notFound('Not found');
  ctx.res.setHeader('Cache-Control', 'no-store');
  CC.noteForwarded(ctx);
  const { rateLimit, rateLimited } = require('../app');
  const badKey = `county-connect-bad:${ctx.ip}`;
  if (rateLimited(badKey, CC.LIMITS.badPerIp)) throw new HttpError(429, 'Too many requests with a token that is not valid from this address. Wait ten minutes.');
  const r = CC.lookup(ctx);
  if (r.refused) {
    rateLimit(badKey, CC.LIMITS.badPerIp, CC.WINDOW_MS);
    // Past the limit for all addresses together, a caller without a good token is told to wait, unlogged (the
    // refusals already logged are summarised); a good token is never held back by it.
    if (!rateLimit('county-connect-bad:*', CC.LIMITS.badAll, CC.WINDOW_MS)) throw new HttpError(429, 'Too many requests with a token that is not valid. Wait ten minutes.');
    CC.logRefusal({ action: 'county_connect.refuse', token: r.token || null, ip: ctx.ip, reason: r.refused, details: { path: ctx.path } });
    ctx.res.setHeader('WWW-Authenticate', 'Bearer realm="suds-county-connect"');
    throw unauthorized(r.refused === 'no_token' ? 'A county connection bearer token is required.' : 'The token is not valid: it is unknown, expired or revoked.');
  }
  const t = r.token;
  if (!rateLimit(`county-connect:${ctx.ip}`, CC.LIMITS.perIp, CC.WINDOW_MS)) throw new HttpError(429, 'Too many requests from this address. Wait ten minutes.');
  if (!rateLimit('county-connect:*', CC.LIMITS.all, CC.WINDOW_MS)) throw new HttpError(429, 'Too many requests. Wait ten minutes.');
  if (t.scope !== scope) {
    CC.logRefusal({ action: 'county_connect.refuse', token: t, ip: ctx.ip, reason: 'wrong_scope', details: { path: ctx.path, scope: t.scope } });
    throw forbidden(scope === CC.SCOPES.read ? 'A connection token cannot read the combined view: use a read token.' : 'A read token cannot send or ask for a program\'s status: use the program\'s connection token.');
  }
  if (!rateLimit(`county-connect-token:${t.id}`, perToken, CC.WINDOW_MS)) throw new HttpError(429, 'Too many requests with this token. Wait ten minutes.');
  CC.touch(t, ctx.ip);
  return t;
}

function cboCan(ctx) { return auth.hasPerm(ctx.user, 'reports:funder') && auth.hasPerm(ctx.user, 'budget:read'); }
/** settings:manage, or whoever files the funder submission and sees the budget (who may make the county file). */
function configOrFiler(ctx) {
  if (!ctx.user) throw unauthorized();
  if (auth.hasPerm(ctx.user, 'settings:manage') || cboCan(ctx)) return;
  audit.log({ user: ctx.user, action: 'authz.denied', ip: ctx.ip, success: false, details: { perms: ['settings:manage', 'reports:funder+budget:read'], path: ctx.path } });
  throw forbidden('You do not have permission for this action');
}

module.exports = (r) => {
  // The push's body is the signed file: up to 256 KB for a live connection token while the connection is on, decided
  // before the body is read (server/app.js bodyLimit); every other request without a session keeps the 64 KB cap.
  require('../app').bodyLimitFor('/api/county-connect/v1/submissions', CC.pushBodyLimit);

  // ---- the county's machine routes ----
  r.post('/api/county-connect/v1/submissions', async (ctx) => {
    const t = machine(ctx, CC.SCOPES.submit, CC.LIMITS.pushPerToken);
    const { rateLimit, rateLimited } = require('../app');
    const refusedKey = `county-connect-refused:${t.id}`;
    if (rateLimited(refusedKey, CC.LIMITS.refusedPerToken)) throw new HttpError(429, 'Too many files were refused under this token in the last few minutes. Wait ten minutes, and check the file is the one SUDS made.');
    // The file as sent. A JSON body was parsed by the pipeline (after the size cap); its canonical payload, which is
    // what is signed and hashed, does not depend on the layout, so re-serialising it loses nothing.
    const textIn = ctx.rawBody && ctx.rawBody.length ? ctx.rawBody.toString('utf8') : ctx.body && Object.keys(ctx.body).length ? JSON.stringify(ctx.body) : '';
    const fileSha = textIn ? require('../crypto').sha256(textIn) : null;
    const receivedAt = db.now();
    try {
      const parsed = K.parseFile(textIn, { today: CC.today(), now: new Date().toISOString() });
      // county.js decides that the file is for this county (recipient), whose key signed it, that the key is the
      // programme's current one (retired_key) and the signature good, and which of its files for the period counts
      // (older); the token decides who is calling. They must be the same programme, or nothing is kept (the import is
      // rolled back). Every refusal is county.js's own, with its reason code, passed through as it is.
      const here = CC.countyCode({ user: CC.actor(t), ip: ctx.ip });
      // The key that signed the file must be one the county registered for this token's programme, decided before
      // county.js looks further (so nothing it would say about another programme's key, name or files is said to
      // this caller). An unknown key and another programme's key are one refusal to the caller (CC.NOT_THIS_KEY);
      // which it was is kept in the county's audit log.
      if (parsed.payload && parsed.payload.recipient && parsed.payload.recipient.county_code === here) {
        const key = db.one(`SELECT programme_id FROM county_programme_keys WHERE fingerprint=?`, parsed.fingerprint);
        if (!key) throw new K.SubmissionError('unknown_key', CC.NOT_THIS_KEY);
        if (key.programme_id !== t.programme_id) throw new K.SubmissionError('wrong_programme', CC.NOT_THIS_KEY);
      }
      const out = db.transaction(() => {
        const o = K.importParsed(parsed, null, { countyCode: here });
        if (o.programme.id !== t.programme_id) throw new K.SubmissionError('wrong_programme', CC.NOT_THIS_KEY);
        return o;
      });
      const s = out.submission;
      audit.log({ user: CC.actor(t), action: out.status === 'duplicate' ? 'county.submission.duplicate' : 'county.submission.import', entity: 'county_submission', entityId: s.id, ip: ctx.ip,
        details: { via: 'county-connect', token_id: t.id, programme_id: t.programme_id, fingerprint: parsed.fingerprint, from: s.period_from, to: s.period_to, sha256: s.sha256, status: out.status, superseded: out.replaced || undefined } });
      ctx.status = out.status === 'duplicate' ? 200 : 201;
      return { status: out.status, reason: null, period: { from: s.period_from, to: s.period_to },
        message: K.importMessage(out, { audience: 'programme' }),
        receipt: { sha256: s.sha256, received_at: s.received_at } };
    } catch (e) {
      if (!(e instanceof K.SubmissionError)) throw e;
      rateLimit(refusedKey, CC.LIMITS.refusedPerToken, CC.WINDOW_MS);
      CC.logRefusal({ action: 'county.submission.refuse', token: t, ip: ctx.ip, reason: e.code, details: { via: 'county-connect', token_id: t.id, programme_id: t.programme_id, file_sha256: fileSha, bytes: textIn ? Buffer.byteLength(textIn) : 0 } });
      ctx.status = e.code === 'too_large' ? 413 : 422;
      const merged = e.code === 'unknown_key' || e.code === 'wrong_programme';
      return { status: 'refused', reason: merged ? CC.NOT_THIS_KEY_REASON : e.code, message: merged ? CC.NOT_THIS_KEY : e.message, receipt: { sha256: null, received_at: receivedAt } };
    }
  });

  r.get('/api/county-connect/v1/status', (ctx) => {
    const t = machine(ctx, CC.SCOPES.submit, CC.LIMITS.statusPerToken);
    const s = CC.statusFor(t, { user: CC.actor(t), ip: ctx.ip });
    audit.log({ user: CC.actor(t), action: 'county_connect.status', entity: 'county_programme', entityId: t.programme_id, ip: ctx.ip, details: { token_id: t.id, outstanding: s.outstanding.length } });
    return s;
  });

  r.get('/api/county-connect/v1/combined', (ctx) => {
    const t = machine(ctx, CC.SCOPES.read, CC.LIMITS.readPerToken);
    const { from, to } = period(ctx.query.get('from') || '', ctx.query.get('to') || '');
    const format = ctx.query.get('format') || 'json';
    if (!['json', 'tidy-csv'].includes(format)) throw badRequest('format must be json or tidy-csv');
    // Figures the county entered for a programme not on SUDS are counted unless ?entered=exclude, and each programme
    // and figure says where it came from (source: signed, county_entered or mixed).
    // Only include or exclude (none counts them): anything else is refused, never read as include (routes/county.js).
    const ev = ctx.query.get('entered');
    if (ev !== null && ev !== 'include' && ev !== 'exclude') throw badRequest('entered must be include or exclude');
    const entered = ev !== 'exclude';
    const d = K.combined(from, to, { entered });
    audit.log({ user: CC.actor(t), action: 'county.api.read', ip: ctx.ip, details: { what: 'combined', token_id: t.id, from, to, format, programmes: d.programmes.length, submitted: d.submitted, entered_excluded: !entered || undefined } });
    const notes = { counts: 'exact', purpose: 'internal', classification: 'Exact, internal, not for publication: for authorised county staff and systems only.', unduplicated: false,
      not_unduplicated: 'People are counted by each program and summed: a person served by two programs counts twice. Not unduplicated across programs.',
      caveats: d.caveats, rule: d.rule, publication_note: d.publication_note,
      entered: entered ? 'counted' : 'left out', entered_label: K.ENTERED_LABEL, entered_note: d.entered_note,
      award: `${d.award.note} A programme with figures whose files carry no award has value null in the award rows, and its award.status says why (not_in_file: version 1 files; none: no fund with an award). unit percent: spent against the award, in per cent.`,
      source: 'Each programme and submission has a source: "signed" (a file the program\'s key signed), "county_entered" (' + K.ENTERED_LABEL + ') or, for a programme, "mixed". Each row\'s total_entered is the part of its total entered by the county.' };
    if (format === 'json') {
      const { caveats, rule, publication_note, entered_note, entered_label, ...rest } = d; // eslint-disable-line no-unused-vars
      return { ...rest, notes };
    }
    // Tidy: one row per programme and measure, and one per measure for the total; the notes in the headers.
    const S = require('../spreadsheet');
    const rows = [];
    const anyEntered = d.programmes.some(p => p.source === K.ENTERED || p.source === 'mixed');
    for (const x of d.rows) {
      for (const p of d.programmes) rows.push({ from, to, programme_id: p.id, programme: p.name, programme_status: p.status, source: p.source || '', group: x.group, measure_key: x.key, measure: x.label, unit: x.percent ? 'percent' : x.money ? 'money' : 'count', value: x.by[p.id] });
      rows.push({ from, to, programme_id: '', programme: 'Total (summed, not unduplicated)', programme_status: '', source: '', group: x.group, measure_key: x.key, measure: x.label, unit: x.percent ? 'percent' : x.money ? 'money' : 'count', value: x.total });
      if (anyEntered) rows.push({ from, to, programme_id: '', programme: `Of the total, ${K.ENTERED_LABEL}`, programme_status: '', source: K.ENTERED, group: x.group, measure_key: x.key, measure: x.label, unit: x.percent ? 'percent' : x.money ? 'money' : 'count', value: x.total_entered });
    }
    const cols = ['from', 'to', 'programme_id', 'programme', 'programme_status', 'source', 'group', 'measure_key', 'measure', 'unit', 'value'].map(key => ({ key, label: key }));
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="suds-county-combined-${from}_${to}-internal-exact.csv"`,
      'X-SUDS-Report-Counts': 'exact', 'X-SUDS-Report-Purpose': 'internal',
      'X-SUDS-Export': `County view: exact aggregate figures from programs' signed submissions${anyEntered ? ' and figures entered by the county (not signed by the program; source column)' : ''}, for authorised county staff; not for publication; summed, not unduplicated. No client-level data.` });
    ctx.res.end(S.toCsv(rows, cols));
  });

  r.get('/api/county-connect/v1/programs', (ctx) => {
    const t = machine(ctx, CC.SCOPES.read, CC.LIMITS.readPerToken);
    const progs = db.all(`SELECT * FROM county_programmes ORDER BY name COLLATE NOCASE, id`);
    // The files that count, by the combined view's own rule (county.js countingSubs): a replaced, withdrawn or
    // compromised-key file is not listed, nor any file of an inactive programme whose files the county stopped counting.
    const subs = K.countingSubs();
    const rows = progs.map(p => {
      // The current key and the key history from county.js (county_programme_keys): fingerprints and dates only.
      const out = K.programmeOut(p);
      const mine = K.filesCount(p) ? subs.filter(s => s.programme_id === p.id) : [];
      // source: a programme on SUDS signs its files; one not on SUDS has only figures the county entered.
      return { id: p.id, name: p.name, active: !!p.active, keep_files: !!p.keep_files, files_count: K.filesCount(p), on_suds: out.on_suds, source: out.on_suds ? 'signed' : K.ENTERED, fingerprint: out.fingerprint, fingerprint_display: out.fingerprint_display,
        keys: out.keys.map(k => ({ fingerprint: k.fingerprint, added_at: k.added_at, replaced_at: k.replaced_at, compromised_at: k.compromised_at, current: k.current })),
        last_received: mine.reduce((m, s) => (s.received_at > m ? s.received_at : m), '') || null,
        periods: mine.map(s => ({ from: s.period_from, to: s.period_to, generated_at: s.generated_at, received_at: s.received_at, sha256: s.sha256, key_fingerprint: s.key_fingerprint, source: s.source || 'signed' })) };
    });
    audit.log({ user: CC.actor(t), action: 'county.api.read', ip: ctx.ip, details: { what: 'programs', token_id: t.id, programmes: rows.length } });
    return { rows, notes: { classification: 'Internal: for authorised county staff and systems only.', source: `A programme's source is "signed" (it runs SUDS and signs its files) or "county_entered" (not on SUDS: ${K.ENTERED_LABEL}); each period's source says which its figures are.` } };
  });

  // The county's publication releases (server/county-publication.js): each exactly as published (its screened content
  // and SHA-256), a withdrawn one marked with when. Public figures, but read here with the same read token and limits.
  r.get('/api/county-connect/v1/publications', (ctx) => {
    const t = machine(ctx, CC.SCOPES.read, CC.LIMITS.readPerToken);
    const PUB = require('../county-publication');
    const rows = PUB.list().map(x => { const rec = PUB.get(x.id); return { id: rec.id, period: { from: rec.period_from, to: rec.period_to }, status: rec.status, published_at: rec.published_at, withdrawn_at: rec.withdrawal ? rec.withdrawal.at : null, sha256: rec.sha256, release: rec.content }; });
    audit.log({ user: CC.actor(t), action: 'county.api.read', ip: ctx.ip, details: { what: 'publications', token_id: t.id, releases: rows.length } });
    return { rows, notes: { classification: 'Publication releases: screened for small cells, for publication. A withdrawn release must not be used.', hash: 'sha256 is of the release\'s canonical JSON (keys sorted, no whitespace), as recorded when it was published.' } };
  });

  // ---- the county's settings and tokens ----
  r.get('/api/county-connect/settings', auth.requireAuth, auth.requirePerm('county:view'), (ctx) => CC.settings({ user: ctx.user, ip: ctx.ip }));
  r.put('/api/county-connect/settings', auth.requireAuth, auth.requirePerm('county:manage'), auth.requirePerm('settings:manage'), (ctx) => {
    const v = validate(ctx.body, { enabled: { type: 'boolean' }, cadence: { type: 'string', enum: Object.keys(CC.CADENCES) }, start: { type: 'string', maxLen: 10 }, due_days: { type: 'number', integer: true } }, { partial: true });
    if (v.start && !isDay(v.start)) throw badRequest('The first period expected must start on a date (YYYY-MM-DD).', { fields: { start: 'must be a date' } });
    if (v.due_days !== undefined && v.due_days !== null && (v.due_days < 1 || v.due_days > CC.DUE_DAYS_MAX)) throw badRequest(`Files are due 1 to ${CC.DUE_DAYS_MAX} days after a period ends.`, { fields: { due_days: `must be 1 to ${CC.DUE_DAYS_MAX}` } });
    const was = CC.enabled();
    const changed = CC.saveSettings({ enabled: v.enabled === undefined || v.enabled === null ? undefined : !!v.enabled, cadence: v.cadence, start: ctx.body && 'start' in ctx.body ? (v.start || null) : undefined, dueDays: v.due_days === undefined || v.due_days === null ? undefined : v.due_days });
    audit.log({ user: ctx.user, action: 'county_connect.settings', ip: ctx.ip, details: { changed, enabled: CC.enabled(), was_enabled: was, cadence: CC.cadence(), due_days: CC.dueDays() } });
    return CC.settings({ user: ctx.user, ip: ctx.ip });
  });
  r.get('/api/county-connect/tokens', auth.requireAuth, auth.requirePerm('county:manage'), (ctx) => {
    const rows = CC.listTokens();
    audit.log({ user: ctx.user, action: 'county_connect.token.list', ip: ctx.ip, details: { count: rows.length } });
    return { rows, enabled: CC.enabled() };
  });
  r.post('/api/county-connect/tokens', auth.requireAuth, auth.requirePerm('county:manage'), (ctx) => {
    const v = validate(ctx.body, { scope: { type: 'string', required: true, enum: Object.values(CC.SCOPES) }, programme_id: { type: 'string', maxLen: 64 }, name: { type: 'string', maxLen: 120 }, expires_days: { type: 'number', integer: true } });
    let out;
    try { out = CC.issue({ scope: v.scope, programmeId: v.programme_id || null, name: v.name || '', expiresDays: v.expires_days === undefined || v.expires_days === null ? undefined : v.expires_days, user: ctx.user }); }
    catch (e) { throw badRequest(e.message); }
    audit.log({ user: ctx.user, action: 'county_connect.token.issue', entity: 'county_connect_token', entityId: out.row.id, ip: ctx.ip, details: { scope: out.row.scope, programme_id: out.row.programme_id || undefined, prefix: out.row.prefix, expires_at: out.row.expires_at } });
    ctx.status = 201;
    return { ...out.row, token: out.token, note: 'Copy the token now: it is not shown again. Only its SHA-256 is kept.' };
  });
  r.post('/api/county-connect/tokens/:id/revoke', auth.requireAuth, auth.requirePerm('county:manage'), (ctx) => {
    const out = CC.revoke(ctx.params.id, ctx.user);
    if (!out) throw notFound('Token not found');
    audit.log({ user: ctx.user, action: 'county_connect.token.revoke', entity: 'county_connect_token', entityId: out.row.id, ip: ctx.ip, details: { scope: out.row.scope, programme_id: out.row.programme_id || undefined, prefix: out.row.prefix, already: !!out.before.revoked_at } });
    return out.row;
  });

  // ---- the programme's side ----
  r.get('/api/county-connect/connection', auth.requireAuth, configOrFiler, (ctx) => {
    const c = CL.describe(); const log = CL.sends();
    audit.log({ user: ctx.user, action: 'county_connect.connection.view', ip: ctx.ip, details: { connected: c.connected, sends: log.length } });
    return { ...c, sends: log, can_configure: auth.hasPerm(ctx.user, 'settings:manage'), can_send: cboCan(ctx) && auth.hasPerm(ctx.user, 'export:read') };
  });
  r.put('/api/county-connect/connection', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const v = validate(ctx.body, { base_url: { type: 'string', maxLen: 500 }, token: { type: 'string', maxLen: 200 }, auto_send: { type: 'boolean' }, confirm_county_code: { type: 'boolean' } }, { partial: true });
    let out;
    try { out = CL.save({ baseUrl: v.base_url, token: v.token, autoSend: v.auto_send === undefined || v.auto_send === null ? undefined : !!v.auto_send, confirmCode: !!v.confirm_county_code }, ctx.user); }
    catch (e) {
      if (e instanceof CL.ConnectError) throw badRequest(e.message, { fields: e.field ? { [e.field]: e.message } : /token/i.test(e.message) && !/address/.test(e.message) ? { token: e.message } : { base_url: e.message } });
      throw e;
    }
    if (out.confirmed) audit.log({ user: ctx.user, action: 'county_connect.county_code.confirm', ip: ctx.ip, details: { host: out.host, previous: out.confirmed.previous, county_code: out.confirmed.code } });
    audit.log({ user: ctx.user, action: 'county_connect.connection.save', ip: ctx.ip, details: { host: out.host, base_url_changed: out.changed.base_url, token_changed: out.changed.token, auto_send: CL.describe().auto_send } });
    return CL.describe();
  });
  r.delete('/api/county-connect/connection', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const had = CL.remove();
    audit.log({ user: ctx.user, action: 'county_connect.connection.remove', ip: ctx.ip, details: { had: !!had, host: had ? new URL(had.base_url).host : undefined } });
    return CL.describe();
  });
  r.post('/api/county-connect/connection/test', auth.requireAuth, configOrFiler, async (ctx) => {
    if (!CL.describe().connected) throw badRequest('Save the county\'s address and token first.');
    const out = await CL.test({ user: ctx.user, ip: ctx.ip });
    audit.log({ user: ctx.user, action: 'county_connect.connection.test', ip: ctx.ip, success: out.ok, details: { host: new URL(CL.describe().base_url).host, ok: out.ok, reason: out.reason || undefined, outstanding: out.ok ? out.status.outstanding.length : undefined } });
    return { ...out, connection: CL.describe() };
  });
  r.post('/api/county-connect/send', auth.requireAuth, auth.requirePerm('reports:funder'), auth.requirePerm('budget:read'), auth.requirePerm('export:read'), async (ctx) => {
    const v = validate(ctx.body, { from: { type: 'string', required: true, maxLen: 10 }, to: { type: 'string', required: true, maxLen: 10 }, county_code: { type: 'string', maxLen: 20 }, county_name: { type: 'string', maxLen: 400 } });
    const funds = Array.isArray(ctx.body.funds) ? ctx.body.funds.slice(0, 201) : undefined;
    if (funds && (funds.length > 200 || funds.some(x => typeof x !== 'string' || x.length > 64))) throw badRequest('funds must be a list of fund ids.');
    const { from, to } = period(v.from, v.to);
    if (to >= CC.today()) throw badRequest(`The period is not over yet (it ends ${to}). A county file reports a period that has ended.`);
    if (!CL.describe().connected) throw badRequest('This server is not connected to a county. An administrator saves the county\'s address and token under Send to the county › Connect to the county.');
    try { return await CL.send({ from, to, user: ctx.user, ip: ctx.ip, funds, countyCode: v.county_code || null, countyName: v.county_name || null }); }
    catch (e) {
      if (e instanceof K.SubmissionError) throw badRequest(`The county file could not be made: ${e.message}`);
      if (e instanceof CL.ConnectError) throw badRequest(e.message);
      throw e;
    }
  });
};

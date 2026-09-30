'use strict';
// The county connection, the county's side (docs/COUNTY-VIEW.md, "Connecting"). Built for 1.18.0, not yet released.
//
// A county that runs the county view (server/county.js) may let the programmes it funds post their signed county
// submission file to it, instead of emailing it, and let its own systems read the combined view. Both are machine
// routes with a bearer token and no session (server/routes/county-connect.js):
//
//   connection token (scope county.submit)  issued per registered programme. POST /api/county-connect/v1/submissions
//                                           (the exact signed file as the body) and GET /api/county-connect/v1/status
//                                           (what the county expects of that programme, and nothing of anyone else's).
//   read token       (scope county.read)    for the county's own systems. GET /api/county-connect/v1/combined and
//                                           /v1/programs: the combined view and who has submitted, no keys' private
//                                           parts and no programme's file.
//
// The trust model does not change: the token says which programme is calling, and the FILE must still verify under
// that programme's registered key through county.js's own import path (parseFile, importParsed): the token alone
// never makes a file count, and a file signed by programme A under programme B's token is refused. Tokens are 256
// random bits, shown once, stored as their SHA-256; they may expire (read tokens always do) and be revoked; each use
// records when and from which address. Neither kind is ever a session, and a session never opens these routes.
//
// Off unless the county switches it on (county_connect_enabled): off, every machine route answers 404 as if it did
// not exist. Office server only (LOCAL_ROUTE_MODULES in server/app.js leaves the routes out of the device kernel).
const db = require('./db');
const audit = require('./audit');
const K = require('./county');
const P = require('./county-periods');
const { sha256, randomToken, uuid } = require('./crypto');

const SETTING_ENABLED = 'county_connect_enabled';
const SETTING_CADENCE = 'county_connect_cadence';
const SETTING_START = 'county_connect_start';
// A calendar quarter and a California fiscal quarter cover the same months; the two quarterly cadences differ only in
// which name comes first in a period's label (county-periods.js describe() names both, as the Send to the county
// card does).
const CADENCES = {
  quarterly_calendar: 'Quarterly (calendar quarters: January to March, …)',
  quarterly_fiscal: 'Quarterly (California fiscal year from July 1: Q1 is July to September)',
  monthly: 'Monthly',
};
const SCOPES = { submit: 'county.submit', read: 'county.read' };
const PREFIX = { 'county.submit': 'sudscc_', 'county.read': 'sudscr_' };
/** A connection token may be issued without an expiry, or with one of up to three years; a read token always expires. */
const CONNECTION_MAX_DAYS = 3 * 366;
const READ_DEFAULT_DAYS = 90;
const READ_MAX_DAYS = 366;
/** How many complete periods back /status lists as expected (a year of quarters, or of months). */
const EXPECTED_QUARTERS = 4;
const EXPECTED_MONTHS = 12;
/** The push route's body: the signed file itself, no larger than the upload path takes (county.js MAX_FILE_BYTES). */
const MAX_PUSH_BYTES = 256 * 1024;

// ---- rate limits (per 10 minutes; process-local, as every limit in SUDS is: server/app.js rateLimit) ----
const LIMITS = {
  perIp: 120,          // every machine route together, per address
  all: 2000,           // every address together: a flood spread over many addresses is still bounded
  badPerIp: 20,        // a missing, unknown, expired or revoked token, per address, before the next is refused unread
  pushPerToken: 30,
  statusPerToken: 60,
  readPerToken: 120,
  refusedPerToken: 20, // files refused under one token, as the upload path allows a person (routes/county.js)
};
const WINDOW_MS = 10 * 60_000;

const enabled = () => db.getSetting(SETTING_ENABLED, '0') === '1';
function cadence() { const c = db.getSetting(SETTING_CADENCE, 'quarterly_calendar'); return CADENCES[c] ? c : 'quarterly_calendar'; }
function startDate() { const s = db.getSetting(SETTING_START, ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
const today = () => require('./routes/budget').localDate();

/**
 * The county's code (county.js countyCode(): settings.county_code, made the first time it is asked for, and
 * audited then as the county view's own route does), which a programme's file must name as its recipient.
 */
function countyCode({ user = null, ip = null } = {}) {
  const c = K.countyCode();
  if (c.created) audit.log({ user, action: 'county.code.create', ip, details: { county_code: c.code, via: 'county-connect' } });
  return c.code;
}

// ---- settings ------------------------------------------------------------------------------------------------------
function settings(who = {}) {
  const code = countyCode(who);
  return { enabled: enabled(), cadence: cadence(), cadences: Object.entries(CADENCES).map(([value, label]) => ({ value, label })), start: startDate(),
    county_code: code, county_code_display: K.formatCode(code), county_name: db.getSetting('org_name', '') || null,
    endpoints: { submissions: '/api/county-connect/v1/submissions', status: '/api/county-connect/v1/status', combined: '/api/county-connect/v1/combined', programs: '/api/county-connect/v1/programs' },
    limits: { max_file_bytes: MAX_PUSH_BYTES, read_default_days: READ_DEFAULT_DAYS, read_max_days: READ_MAX_DAYS, connection_max_days: CONNECTION_MAX_DAYS } };
}
function saveSettings({ enabled: on, cadence: c, start }) {
  const changed = [];
  if (on !== undefined && on !== null) { db.setSetting(SETTING_ENABLED, on ? '1' : '0'); changed.push(SETTING_ENABLED); }
  if (c !== undefined && c !== null) { if (!CADENCES[c]) throw new Error(`cadence must be one of ${Object.keys(CADENCES).join(', ')}`); db.setSetting(SETTING_CADENCE, c); changed.push(SETTING_CADENCE); }
  if (start !== undefined) { if (start) db.setSetting(SETTING_START, start); else db.run(`DELETE FROM settings WHERE key=?`, SETTING_START); changed.push(SETTING_START); }
  return changed;
}

// ---- tokens ----------------------------------------------------------------------------------------------------------
function tokenState(t, now = Date.now()) { return t.revoked_at ? 'revoked' : t.expires_at && Date.parse(t.expires_at) <= now ? 'expired' : 'live'; }
function tokenOut(t) {
  return { id: t.id, scope: t.scope, kind: t.scope === SCOPES.submit ? 'connection' : 'read', programme_id: t.programme_id || null, programme: t.programme || null, name: t.name, prefix: t.prefix,
    expires_at: t.expires_at, created_at: t.created_at, created_by_name: t.created_by_name || null, last_used_at: t.last_used_at, last_used_ip: t.last_used_ip,
    revoked_at: t.revoked_at, state: tokenState(t) };
}
function listTokens() {
  return db.all(`SELECT t.*, p.name programme, u.display_name created_by_name FROM county_connect_tokens t LEFT JOIN county_programmes p ON p.id=t.programme_id LEFT JOIN users u ON u.id=t.created_by
    ORDER BY (t.revoked_at IS NULL) DESC, t.created_at DESC, t.id`).map(tokenOut);
}
const addDays = (days) => new Date(Date.now() + days * 86400000).toISOString();

/**
 * Issue a token: 256 random bits (base64url) behind a prefix that says its kind. Returns { token, row }: the token
 * itself is returned here once and never again (only its SHA-256 is kept). Throws Error with a sentence.
 */
function issue({ scope, programmeId = null, name = '', expiresDays, user }) {
  if (!Object.values(SCOPES).includes(scope)) throw new Error('A token is a connection token (county.submit) or a read token (county.read).');
  let expiresAt = null; let label = String(name || '').trim().slice(0, 120);
  if (scope === SCOPES.submit) {
    const p = programmeId ? db.one(`SELECT * FROM county_programmes WHERE id=?`, programmeId) : null;
    if (!p) throw new Error('Choose the program this connection token is for.');
    if (!p.active) throw new Error(`${p.name} is not an active program here. Reactivate it before connecting it.`);
    if (expiresDays !== undefined && expiresDays !== null) {
      if (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > CONNECTION_MAX_DAYS) throw new Error(`A connection token expires after 1 to ${CONNECTION_MAX_DAYS} days, or never.`);
      expiresAt = addDays(expiresDays);
    }
    if (!label) label = `Connection for ${p.name}`;
  } else {
    if (programmeId) throw new Error('A read token is the county\'s own and belongs to no program.');
    const d = expiresDays === undefined || expiresDays === null ? READ_DEFAULT_DAYS : expiresDays;
    if (!Number.isInteger(d) || d < 1 || d > READ_MAX_DAYS) throw new Error(`A read token expires after 1 to ${READ_MAX_DAYS} days (${READ_DEFAULT_DAYS} unless you choose).`);
    expiresAt = addDays(d);
    if (!label) throw new Error('Name the read token after the system that will use it (for example "County data warehouse").');
  }
  const token = PREFIX[scope] + randomToken(32);
  const id = uuid();
  db.run(`INSERT INTO county_connect_tokens(id,scope,programme_id,name,token_hash,prefix,expires_at,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)`,
    id, scope, scope === SCOPES.submit ? programmeId : null, label, sha256(token), token.slice(0, 12), expiresAt, db.now(), user ? user.id : null);
  return { token, row: tokenOut(db.one(`SELECT t.*, p.name programme FROM county_connect_tokens t LEFT JOIN county_programmes p ON p.id=t.programme_id WHERE t.id=?`, id)) };
}
function revoke(id, user) {
  const t = db.one(`SELECT * FROM county_connect_tokens WHERE id=?`, id);
  if (!t) return null;
  db.run(`UPDATE county_connect_tokens SET revoked_at=COALESCE(revoked_at, ?), revoked_by=COALESCE(revoked_by, ?) WHERE id=?`, db.now(), user ? user.id : null, id);
  return { before: t, row: tokenOut(db.one(`SELECT t.*, p.name programme FROM county_connect_tokens t LEFT JOIN county_programmes p ON p.id=t.programme_id WHERE t.id=?`, id)) };
}

/** The bearer token on a request (the Authorization header only; never a cookie, a query string or a body). */
function bearer(ctx) {
  const h = String(ctx.headers.authorization || '');
  return /^Bearer [A-Za-z0-9_-]{20,200}$/.test(h) ? h.slice(7) : null;
}
/**
 * The token row a request presents, or { refused: why } (missing, unknown, expired, revoked). The scope is checked
 * by the caller, so a token of the other kind is told "not for this", not "unknown".
 */
function lookup(ctx) {
  const token = bearer(ctx);
  if (!token) return { refused: 'no_token' };
  const t = db.one(`SELECT t.*, p.name programme, p.active programme_active FROM county_connect_tokens t LEFT JOIN county_programmes p ON p.id=t.programme_id WHERE t.token_hash=?`, sha256(token));
  if (!t) return { refused: 'unknown_token' };
  const st = tokenState(t);
  if (st !== 'live') return { refused: `${st}_token`, token: t };
  return { token: t };
}
function touch(t, ip) { db.run(`UPDATE county_connect_tokens SET last_used_at=?, last_used_ip=? WHERE id=?`, db.now(), ip ? String(ip).slice(0, 64) : null, t.id); }
/** Who a machine call is, in the audit log: the token by its prefix (never the token), with no user account. */
const actor = (t) => ({ id: null, username: `county-token:${t.prefix}` });

/** The push route's body cap, decided before a byte is read (server/app.js bodyLimit): the file's cap for a live connection token while the endpoint is on, else the no-session cap. */
function pushBodyLimit(ctx) {
  if (ctx.method !== 'POST' || !enabled()) return null;
  const r = lookup(ctx);
  return r.token && !r.refused && r.token.scope === SCOPES.submit ? MAX_PUSH_BYTES : null;
}

// ---- refusals of callers without a good token, in the audit log without growing it without limit ---------------------
// As secure referral links do (server/referral-links.js logRefusal): per token (or, for requests that present no
// known token, all of them together) the first ten in an hour are written one by one, then one entry saying the rest
// are counted, and when the hour is over one summary with the count and the busiest twenty addresses.
const REFUSALS_LOGGED_PER_HOUR = 10;
const REFUSAL_WINDOW_MS = 3600_000;
const refusals = new Map();
function summarise(key, w) {
  if (!w.extra) return;
  const addresses = [...w.byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([ip, n]) => ({ ip, n }));
  audit.log({ user: w.user, action: w.action, entity: w.entity, entityId: w.entityId, ip: null, success: false,
    details: { reason: 'refused_summary', count: w.extra, window_start: new Date(w.start).toISOString(), window_end: new Date(Math.min(Date.now(), w.start + REFUSAL_WINDOW_MS)).toISOString(), addresses } });
}
function flushRefusals() { for (const [key, w] of refusals) summarise(key, w); refusals.clear(); }
function logRefusal({ action, token = null, ip, reason, details = {} }) {
  const key = `${action}|${token ? token.id : 'unknown'}`;
  const now = Date.now();
  let w = refusals.get(key);
  if (w && now - w.start >= REFUSAL_WINDOW_MS) { summarise(key, w); refusals.delete(key); w = null; }
  if (!w) { w = { start: now, logged: 0, extra: 0, byIp: new Map(), action, user: token ? actor(token) : null, entity: token ? 'county_connect_token' : null, entityId: token ? token.id : null }; refusals.set(key, w); }
  if (w.logged < REFUSALS_LOGGED_PER_HOUR) {
    w.logged++;
    audit.log({ user: w.user, action, entity: w.entity, entityId: w.entityId, ip, success: false, details: { reason, ...details } });
    if (w.logged === REFUSALS_LOGGED_PER_HOUR) audit.log({ user: w.user, action, entity: w.entity, entityId: w.entityId, ip, success: false, details: { reason: 'counting', note: 'further refusals this hour are counted and summarised, not written one by one' } });
    return;
  }
  w.extra++; w.byIp.set(ip || '?', (w.byIp.get(ip || '?') || 0) + 1);
  if (refusals.size > 5000) flushRefusals();
}

// ---- periods ------------------------------------------------------------------------------------------------------
/**
 * The complete periods the county expects, oldest first: for the cadence, those that ended before `day`, at most a
 * year of them, none starting before the county's start date. Built and named by county-periods.js, the helpers the
 * county view and the Send to the county card use, so a period reads the same everywhere ("Apr – Jun 2026 (calendar
 * Q2 2026 · FY 2025-26 Q4)", "Feb 2026"). A fiscal quarter covers the same months as a calendar one; the fiscal
 * cadence puts the fiscal name first ("FY 2025-26 Q4 (Apr – Jun 2026)").
 */
function expectedPeriods(c = cadence(), day = today(), start = startDate()) {
  let out;
  if (c === 'monthly') out = P.completeMonths(day, EXPECTED_MONTHS).map(m => ({ from: m.from, to: m.to, label: P.monthsLabel(m.from, m.to) }));
  else {
    out = P.completeQuarters(day, EXPECTED_QUARTERS).map((q) => {
      const both = P.describe(q.from, q.to); // "calendar Q2 2026 · FY 2025-26 Q4"
      const fiscal = both.split(' · ')[1];
      return { from: q.from, to: q.to, label: c === 'quarterly_fiscal' ? `${fiscal} (${P.monthsLabel(q.from, q.to)})` : `${P.monthsLabel(q.from, q.to)} (${both})` };
    });
  }
  out.reverse();
  return start ? out.filter(p => p.from >= start) : out;
}

/**
 * What the county tells one programme through /status: the county's code and name, the cadence and the periods it
 * expects, which of them are covered and which are outstanding, and the programme's own files with their receipts.
 * Nothing of any other programme, and no figures. Counted as the combined view counts (county.js countingSubs and
 * coverage): a replaced or withdrawn file, or one signed by a key the county marked compromised, does not count, nor
 * does any file of an inactive programme whose files the county stopped counting; a period is received when the
 * programme's counting files cover all of it.
 */
function statusFor(t, who = {}) {
  const prog = db.one(`SELECT id, name, active, keep_files FROM county_programmes WHERE id=?`, t.programme_id);
  const counting = K.filesCount(prog) ? K.countingSubs(prog.id) : [];
  const expected = expectedPeriods().map(p => { const cov = K.coverage(counting, p.from, p.to); return { ...p, received: cov.status === 'whole', coverage: cov.status }; });
  const files = db.all(`${K.SUBS} WHERE s.programme_id=? ORDER BY s.received_at DESC, s.id LIMIT 40`, prog.id).map(K.summary);
  return {
    county: { code: countyCode(who), name: db.getSetting('org_name', '') || null },
    programme: { id: prog.id, name: prog.name, active: !!prog.active, files_count: K.filesCount(prog) },
    cadence: cadence(), cadence_label: CADENCES[cadence()], start: startDate(), today: today(),
    expected, outstanding: expected.filter(p => !p.received).map(({ received, ...p }) => p), // eslint-disable-line no-unused-vars
    received: files.map(s => ({ from: s.period_from, to: s.period_to, sha256: s.sha256, received_at: s.received_at, generated_at: s.generated_at, status: s.status })),
    max_file_bytes: MAX_PUSH_BYTES,
  };
}

module.exports = {
  SETTING_ENABLED, SETTING_CADENCE, SETTING_START, CADENCES, SCOPES, PREFIX, LIMITS, WINDOW_MS, MAX_PUSH_BYTES, READ_DEFAULT_DAYS, READ_MAX_DAYS, CONNECTION_MAX_DAYS,
  REFUSALS_LOGGED_PER_HOUR, enabled, cadence, startDate, countyCode, settings, saveSettings, issue, revoke, listTokens, tokenOut, tokenState, bearer, lookup, touch, actor,
  pushBodyLimit, logRefusal, flushRefusals, expectedPeriods, statusFor, today,
};

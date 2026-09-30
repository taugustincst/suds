'use strict';
// The county connection, the programme's side (docs/COUNTY-VIEW.md, "Connecting"). Released in 1.18.0.
//
// A programme whose county runs SUDS with the connection switched on can send its county submission file straight to
// the county's server, instead of downloading it and emailing it. What is sent is exactly the file the download makes
// (buildFile: the Settlement outcomes figures, county.js payloadFrom's allow-list, signed by signFile), so nothing new
// leaves the programme: aggregate counts and money, no client-level data. The county still checks the signature
// against the key it registered for this programme; the token only says which programme is calling.
//
// The connection is the county's address and the token the county issued (county_connection: the token encrypted,
// never returned to a browser once saved). Test connection asks the county's /status what it expects; Send posts the
// file and keeps the county's receipt in a send log (county_connect_sends, no figures). Automatic sending is off by
// default; switched on, the hourly housekeeping sends, once a day at most, each period the county says is outstanding.
//
// Outbound safety (docs/DEPLOYMENT.md, "Outbound internet"): https only (plain http only to this machine outside
// production, for development and tests); never a redirect; one deadline for the whole exchange (a county that drips
// its answer a byte at a time is cut off); the answer read to 64 KB at most; the host is the configured one only (the
// token never goes anywhere else). A county address on a private network is refused in production unless
// SUDS_COUNTY_ALLOW_PRIVATE=1 (a county reached over a VPN or split DNS); even then this machine, link-local and cloud
// metadata addresses are refused, the name is resolved and checked, and the connection pinned to the checked address
// (outbound.privateNetworkFetch). A public address goes through server/outbound.js: checked, resolved, and connected
// to the address that passed the check. TLS certificates are verified against the county's host name; a county whose
// certificate is issued by its own CA is trusted with NODE_EXTRA_CA_CERTS.
//
// What the county's server says is not trusted beyond what it may decide: its county code and name are checked as a
// file's recipient is (county.js) before they are stored or signed, a county code different from the one saved
// switches automatic sending off until an administrator confirms it, and each period it calls outstanding is sent
// automatically only if it is a real, ended period of the county's cadence within the last two years.
// Office server only: SUDS on this device has no county relationship.
const db = require('./db');
const config = require('./config');
const audit = require('./audit');
const outbound = require('./outbound');
const { encrypt, decrypt, uuid } = require('./crypto');

const TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 64 * 1024;
const AUTO_EVERY_MS = 24 * 3600_000;
const AUTO_MAX_PERIODS = 4;
/** How far back an automatic send goes: the periods of the cadence that ended in the last two years. */
const AUTO_LOOKBACK = { quarters: 8, months: 24 };
/** Settings key: a county code the county's server started giving that differs from the saved one, awaiting an administrator. */
const PENDING_CODE = 'county_connect_pending_code';
let timeoutMs = TIMEOUT_MS;
function _setTimeoutForTests(ms) { timeoutMs = ms || TIMEOUT_MS; }

class ConnectError extends Error { constructor(message, extra = {}) { super(message); Object.assign(this, extra); } }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
const allowPrivate = () => process.env.SUDS_COUNTY_ALLOW_PRIVATE === '1';
/** Whether a host is this machine or a private network, by its name or literal address (not what it resolves to). */
function privateHost(host) {
  if (LOOPBACK.has(host)) return true;
  try { outbound.assertPublicHttps(`https://${host.includes(':') ? `[${host}]` : host}/`); return false; } catch { return true; }
}
/** Under SUDS_COUNTY_ALLOW_PRIVATE: a private-network host a county may be at (not this machine, link-local or metadata). */
function privateNetworkHost(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return outbound.isAllowedPrivateNetworkAddress(host);
  return !/^(localhost|.*\.localhost|metadata\.google\.internal)$/i.test(host);
}

/**
 * The county's address as a person typed it, checked and normalised (no trailing slash), or a ConnectError saying
 * what is wrong. https only; plain http only to this machine and never in production; no user name or password,
 * query or fragment; and in production nothing on this machine or a private network unless SUDS_COUNTY_ALLOW_PRIVATE=1.
 */
function checkBaseUrl(value) {
  let u; try { u = new URL(String(value || '').trim()); } catch { throw new ConnectError('The county\'s address is not a web address. Type it as the county gave it, for example https://suds.county.example.'); }
  if (u.username || u.password) throw new ConnectError('The county\'s address must not have a user name or password in it.');
  if (u.search || u.hash) throw new ConnectError('Type the county\'s address without anything after a ? or #.');
  const host = hostOf(u);
  if (u.protocol === 'http:') {
    if (config.isProd || !LOOPBACK.has(host)) throw new ConnectError('The county\'s address must start with https://. SUDS sends the token and the file only over an encrypted connection.');
  } else if (u.protocol !== 'https:') throw new ConnectError('The county\'s address must start with https://.');
  if (privateHost(host) && (config.isProd || !LOOPBACK.has(host))) {
    if (!allowPrivate()) throw new ConnectError('That address is on this computer or a private network. SUDS sends to a county there only when the server is started with SUDS_COUNTY_ALLOW_PRIVATE=1 (a county reached over a VPN; docs/DEPLOYMENT.md).');
    if (!privateNetworkHost(host)) throw new ConnectError('That address is this computer, a link-local address or a cloud metadata address. SUDS never sends the county file there, even with SUDS_COUNTY_ALLOW_PRIVATE=1.');
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

// ---- the saved connection ---------------------------------------------------------------------------------------------
const row = () => db.one(`SELECT * FROM county_connection WHERE id='county'`);
/** The connection as a browser may see it: never the token, only its first characters. */
function describe() {
  const c = row();
  if (!c) return { connected: false, base_url: null, token_hint: null, auto_send: false, county_code: null, county_name: null, pending_county_code: null, last_checked_at: null, last_check_ok: null, last_check_error: null, last_auto_at: db.getSetting('county_connect_auto_at', null) };
  const p = pendingCode();
  const K = require('./county');
  const st = lastStatus();
  // The county's SUDS reads only older file versions (1.20 or earlier): said on the screen that makes the file.
  const older = !!st && !countyReads(K.SCHEMA_VERSION, st);
  return { connected: true,
    county_reads: st ? (st.accepts_schema_versions || [1]) : null, county_older: older, send_version: st ? versionForCounty(st) : null,
    county_older_note: older ? `The county's SUDS reads county files of version ${(st.accepts_schema_versions || [1]).join(' and ')} only (SUDS 1.20 or earlier): files sent over the connection are made in version ${versionForCounty(st)}, without the award amounts. Ask the county to upgrade SUDS; until then, a file you download for it must be version 1 too.` : null, base_url: c.base_url, token_hint: c.token_hint, auto_send: !!c.auto_send, county_code: c.county_code, county_name: c.county_name,
    pending_county_code: p ? { code: p.code, code_display: K.formatCode(p.code), name: p.name, previous: p.previous, previous_display: K.formatCode(p.previous), seen_at: p.at } : null,
    last_checked_at: c.last_checked_at, last_check_ok: c.last_check_ok === null ? null : !!c.last_check_ok, last_check_error: c.last_check_error, updated_at: c.updated_at,
    last_auto_at: db.getSetting('county_connect_auto_at', null) };
}
/** A county code the county's server started giving that is not the saved one: { code, name, previous, at }, or null. */
function pendingCode() {
  try { const p = JSON.parse(db.getSetting(PENDING_CODE, 'null')); return p && typeof p === 'object' && typeof p.code === 'string' ? p : null; } catch { return null; }
}
const clearPending = () => db.run(`DELETE FROM settings WHERE key=?`, PENDING_CODE);
/**
 * What the county's /status last said about what it expects and what it reads (released in 1.21.0),
 * held to what SUDS can use (statusFacts): { county_code, cadence, due_days, start, expected, accepts_schema_versions,
 * at }. Read by the programme's reminders (county-schedule.js) and by send (which file version to make). Cleared with
 * the connection, or when the address or token changes.
 */
const LAST_STATUS = 'county_connect_last_status';
function lastStatus() {
  try { const o = JSON.parse(db.getSetting(LAST_STATUS, 'null')); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}
const clearLastStatus = () => db.run(`DELETE FROM settings WHERE key=?`, LAST_STATUS);
const CADENCE_CODES = ['quarterly_calendar', 'quarterly_fiscal', 'monthly'];
/**
 * The parts of a county's /status the programme keeps, checked (the county's server is not trusted beyond what it may
 * decide): a cadence SUDS knows (or null), due_days a whole number of 1 to 365 days (or null), each expected period
 * real dates in order with a label of plain text, at most 24 of them, and the file versions it reads (whole numbers;
 * null when the county does not say, as a county on SUDS 1.20 or earlier does not: it reads version 1 only).
 */
function statusFacts(data, code) {
  const K = require('./county');
  const day = (v) => (K.isDay(v) ? v : null);
  const cadence = CADENCE_CODES.includes(data.cadence) ? data.cadence : null;
  const dueDays = Number.isInteger(data.due_days) && data.due_days >= 1 && data.due_days <= 365 ? data.due_days : null;
  const expected = (Array.isArray(data.expected) ? data.expected : []).slice(0, 24).filter(p => p && typeof p === 'object' && day(p.from) && day(p.to) && p.from <= p.to)
    .map(p => ({ from: p.from, to: p.to, label: typeof p.label === 'string' ? K.cleanText(p.label, 120) : '', received: p.received === true, due_by: day(p.due_by) }));
  const versions = Array.isArray(data.accepts_schema_versions) ? data.accepts_schema_versions.filter(v => Number.isInteger(v) && v >= 1 && v <= 99).slice(0, 10) : null;
  return { county_code: code, cadence, due_days: dueDays, start: day(data.start), expected, accepts_schema_versions: versions && versions.length ? versions : null, at: db.now() };
}
/** Whether the connected county reads county files of version `v` (a county that does not say reads version 1 only). */
function countyReads(v, st = lastStatus()) {
  if (!st) return v === 1;
  return Array.isArray(st.accepts_schema_versions) ? st.accepts_schema_versions.includes(v) : v === 1;
}
/** The file version to send the connected county: the latest this SUDS makes that the county reads. */
function versionForCounty(st = lastStatus()) {
  const K = require('./county');
  return [...K.SCHEMA_VERSIONS].sort((a, b) => b - a).find(v => countyReads(v, st)) || 1;
}
/**
 * Save the county's address, and the token when one is given (required the first time). `confirmCode`: the
 * administrator confirms a county code the county's server started giving (pendingCode), which then becomes the saved
 * one. Automatic sending cannot be switched on while such a code waits. Returns what changed.
 */
function save({ baseUrl, token, autoSend, confirmCode = false }, user) {
  const have = row();
  const url = baseUrl !== undefined && baseUrl !== null ? checkBaseUrl(baseUrl) : have ? have.base_url : null;
  if (!url) throw new ConnectError('Type the county\'s address.');
  const t = token === undefined || token === null ? '' : String(token).trim();
  if (t && !/^sudscc_[A-Za-z0-9_-]{40,60}$/.test(t)) throw new ConnectError('That is not a county connection token. Paste the whole token the county gave you: it starts with sudscc_.');
  if (!have && !t) throw new ConnectError('Paste the connection token the county gave you.');
  const auto = autoSend === undefined || autoSend === null ? (have ? !!have.auto_send : false) : !!autoSend;
  const changed = { base_url: !have || have.base_url !== url, token: !!t, auto_send: !have || !!have.auto_send !== auto };
  const reset = !!have && (changed.base_url || changed.token);
  let pending = have && !reset ? pendingCode() : null;
  let confirmed = null;
  if (pending && confirmCode) {
    db.run(`UPDATE county_connection SET county_code=?, county_name=? WHERE id='county'`, pending.code, pending.name || null);
    clearPending(); confirmed = { code: pending.code, previous: pending.previous }; pending = null;
  } else if (confirmCode && !pending) throw new ConnectError('There is no new county code to confirm. Test the connection again.', { field: 'confirm_county_code' });
  if (pending && auto && !have.auto_send) throw new ConnectError(`The county's server now gives a different county code (${require('./county').formatCode(pending.code)}, was ${require('./county').formatCode(pending.previous)}). Check with the county that it is theirs and confirm it before switching automatic sending on.`, { field: 'auto_send' });
  if (have) {
    // A new address or token: what the county said before no longer applies.
    if (reset) { clearPending(); clearLastStatus(); }
    db.run(`UPDATE county_connection SET base_url=?, token_enc=COALESCE(?, token_enc), token_hint=COALESCE(?, token_hint), auto_send=?, updated_at=?, updated_by=?${reset ? ', county_code=NULL, county_name=NULL, last_checked_at=NULL, last_check_ok=NULL, last_check_error=NULL' : ''} WHERE id='county'`,
      url, t ? encrypt(t) : null, t ? t.slice(0, 12) : null, auto ? 1 : 0, db.now(), user ? user.id : null);
  } else {
    db.run(`INSERT INTO county_connection(id,base_url,token_enc,token_hint,auto_send,updated_at,updated_by) VALUES('county',?,?,?,?,?,?)`, url, encrypt(t), t.slice(0, 12), auto ? 1 : 0, db.now(), user ? user.id : null);
  }
  return { changed, host: new URL(url).host, confirmed };
}
function remove() { const had = row(); db.run(`DELETE FROM county_connection WHERE id='county'`); clearPending(); clearLastStatus(); return had; }

// ---- talking to the county -----------------------------------------------------------------------------------------
/** A request over node:http(s) straight to the address (this machine outside production, or a county allowed on a private network). */
function directRequest(url, { method, headers, body }) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? require('node:http') : require('node:https');
  // One deadline for the whole exchange (AbortSignal.timeout), not only for a socket that goes quiet: a county that
  // drips its answer a byte at a time is cut off when it fires.
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })); req.destroy(); };
    const req = mod.request(u, { method, headers, timeout: timeoutMs, signal }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_ANSWER_BYTES) { req.destroy(); reject(new ConnectError('The county\'s server sent a longer answer than SUDS reads.')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, contentType: String(res.headers['content-type'] || ''), text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    req.on('error', reject);
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', onAbort));
    if (body) req.write(body);
    req.end();
  });
}
/** A request to a public county address through server/outbound.js (checked, resolved, pinned or via the proxy). */
async function publicRequest(url, { method, headers, body }) {
  outbound.assertPublicHttps(url);
  await outbound.assertResolvesPublic(url);
  const res = await outbound.transport(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error', maxBytes: MAX_ANSWER_BYTES });
  if (Number(res.headers.get('content-length') || 0) > MAX_ANSWER_BYTES) throw new ConnectError('The county\'s server sent a longer answer than SUDS reads.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ANSWER_BYTES) throw new ConnectError('The county\'s server sent a longer answer than SUDS reads.');
  return { status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type') || '', text: buf.toString('utf8') };
}
/** A request to a county on a private network (SUDS_COUNTY_ALLOW_PRIVATE=1): resolved, checked and pinned (outbound.privateNetworkFetch). */
async function privateRequest(url, { method, headers, body }) {
  const res = await outbound.privateNetworkFetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error', maxBytes: MAX_ANSWER_BYTES });
  if (Number(res.headers.get('content-length') || 0) > MAX_ANSWER_BYTES) throw new ConnectError('The county\'s server sent a longer answer than SUDS reads.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ANSWER_BYTES) throw new ConnectError('The county\'s server sent a longer answer than SUDS reads.');
  return { status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type') || '', text: buf.toString('utf8') };
}
function describeFailure(e) {
  if (e instanceof ConnectError) return e;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timed out/.test(e.message))) return new ConnectError(`The county's server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, { reason: 'timeout' });
  // redirect: 'error' makes fetch throw on a redirect (the proxy path); the pinned path hands the 3xx back.
  if (e && /redirect/i.test(String(e.message || '') + String(e.cause && e.cause.message || ''))) return new ConnectError('The county\'s server answered with a redirect. SUDS never follows one with the token: check the county\'s address.', { reason: 'redirect' });
  const n = outbound.describeNetworkError(e);
  if (n) return new ConnectError(`The county's server could not be reached: ${n.message}`, { reason: 'network' });
  if (e && e.soft) return new ConnectError(`The county's server could not be reached: ${e.message}.`, { reason: 'refused_address' });
  return new ConnectError('The county\'s server could not be reached.', { reason: 'network' });
}
/**
 * One request to the county: `path` under the saved address, with the saved token. Resolves to { status, data }
 * (data: the county's JSON answer), or throws ConnectError. A redirect is never followed.
 */
async function call(method, path, body) {
  const c = row();
  if (!c) throw new ConnectError('This server is not connected to a county. Save the county\'s address and token first.', { reason: 'not_connected' });
  const url = checkBaseUrl(c.base_url) + path;
  const headers = { Authorization: `Bearer ${decrypt(c.token_enc)}`, Accept: 'application/json', 'User-Agent': `SUDS/${config.version}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const u = new URL(url);
  // Plain http, or this machine outside production (development and tests): straight there. A county allowed on a
  // private network: resolved, checked and pinned, private addresses allowed (never loopback, link-local or
  // metadata), so a name that resolves to 10.x through split DNS works. Anything else: the public guard.
  const devLocal = u.protocol === 'http:' || (!config.isProd && LOOPBACK.has(hostOf(u)));
  const how = devLocal ? directRequest : allowPrivate() ? privateRequest : publicRequest;
  let res;
  try { res = await how(url, { method, headers, body }); }
  catch (e) { throw describeFailure(e); }
  if (res.status >= 300 && res.status < 400) throw new ConnectError(`The county's server answered with a redirect (${res.status}). SUDS never follows one with the token: check the county's address.`, { reason: 'redirect', status: res.status });
  let data = null;
  if (/json/.test(res.contentType)) { try { data = JSON.parse(res.text); } catch { data = null; } }
  if (res.status === 404) throw new ConnectError('The county\'s server has no county connection here: it is switched off there, or the address is wrong.', { reason: 'not_found', status: 404 });
  if (res.status === 401) throw new ConnectError('The county did not accept the token: it is wrong, expired or revoked. Ask the county for a new connection token.', { reason: 'token', status: 401 });
  if (res.status === 403) throw new ConnectError('The county\'s server refused: this token cannot do that.', { reason: 'scope', status: 403 });
  if (res.status === 429) throw new ConnectError('The county\'s server asked SUDS to slow down. Try again in ten minutes.', { reason: 'rate_limited', status: 429 });
  if (!data || typeof data !== 'object') throw new ConnectError(`The county's server answered ${res.status} with something that is not a SUDS county connection answer.`, { reason: 'bad_answer', status: res.status });
  return { status: res.status, data };
}

/**
 * The county's code and name from its /status, held to what a file's recipient must be (county.js checkPayload): a
 * code of eight letters and digits (or none), a name of at most 200 characters with no control characters and no
 * extra spaces (or none). Anything else is a bad answer, and nothing of it is stored or signed.
 */
function countyFromStatus(county) {
  const K = require('./county');
  const c = county && typeof county === 'object' && !Array.isArray(county) ? county : {};
  let code = null; let name = null;
  if (c.code !== null && c.code !== undefined) {
    if (typeof c.code !== 'string' || c.code.length > 20 || !(code = K.normaliseCode(c.code))) throw new ConnectError('The county\'s server gave a county code SUDS cannot use (a county code is eight letters and digits). Nothing was saved; ask the county to check its SUDS.', { reason: 'bad_answer' });
  }
  if (c.name !== null && c.name !== undefined && c.name !== '') {
    if (typeof c.name !== 'string' || c.name.length > K.TEXT_MAX.county_name || K.cleanText(c.name, K.TEXT_MAX.county_name) !== c.name) throw new ConnectError(`The county's server gave a county name SUDS cannot put in a file (at most ${K.TEXT_MAX.county_name} characters, no control characters, no extra spaces). Nothing was saved; ask the county to check its SUDS.`, { reason: 'bad_answer' });
    name = c.name;
  }
  return { code, name };
}

/**
 * Ask the county what it expects (GET /status). Records whether it worked, and the county's code and name. A code
 * different from the one saved is not taken: it is kept as pending (pendingCode) for an administrator to confirm,
 * automatic sending is switched off, and both are audited (county_connect.county_code.changed).
 */
async function test({ user = null, ip = null } = {}) {
  try {
    const r = await call('GET', '/api/county-connect/v1/status');
    if (r.status !== 200 || !r.data.programme || !Array.isArray(r.data.expected)) throw new ConnectError(`The county's server answered ${r.status}: ${String(r.data.error || 'not a status').slice(0, 200)}`, { reason: 'bad_answer' });
    const county = countyFromStatus(r.data.county);
    const cur = row();
    if (cur.county_code && county.code && county.code !== cur.county_code) {
      const before = pendingCode();
      const pending = { code: county.code, name: county.name, previous: cur.county_code, at: db.now() };
      db.setSetting(PENDING_CODE, JSON.stringify(pending));
      db.run(`UPDATE county_connection SET last_checked_at=?, last_check_ok=1, last_check_error=NULL, auto_send=0 WHERE id='county'`, db.now());
      if (!before || before.code !== pending.code || cur.auto_send) {
        audit.log({ user: user || { username: 'system' }, action: 'county_connect.county_code.changed', ip, success: false,
          details: { host: new URL(cur.base_url).host, previous: cur.county_code, county_code: county.code, auto_send_switched_off: !!cur.auto_send } });
      }
      return { ok: true, status: r.data, code_changed: { code: county.code, previous: cur.county_code } };
    }
    if (county.code && cur.county_code === county.code) clearPending();
    // What the county expects and reads, kept for the reminders and for which file version to send (never figures).
    db.setSetting(LAST_STATUS, JSON.stringify(statusFacts(r.data, county.code || cur.county_code || null)));
    db.run(`UPDATE county_connection SET last_checked_at=?, last_check_ok=1, last_check_error=NULL, county_code=COALESCE(?, county_code), county_name=? WHERE id='county'`, db.now(), county.code, county.name);
    return { ok: true, status: r.data };
  } catch (e) {
    if (!(e instanceof ConnectError)) throw e;
    db.run(`UPDATE county_connection SET last_checked_at=?, last_check_ok=0, last_check_error=? WHERE id='county'`, db.now(), e.message.slice(0, 300));
    return { ok: false, error: e.message, reason: e.reason || null };
  }
}

// ---- the file ---------------------------------------------------------------------------------------------------------
const IS_FUND = `(source_type='opioid_settlement' OR settlement_use IS NOT NULL OR settlement_hiaa IS NOT NULL)`;
/** The counties this server made files for, as the file route remembers them: { CODE: { name, fund_ids, used_at } }. */
function recipients() { try { const o = JSON.parse(db.getSetting('county_submission_recipients', '{}')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
/**
 * Which settlement funds go into the file for this county: those given (the boxes ticked on the Send to the county
 * card; each must be a settlement fund here), else the ones last chosen for this county's code there (the file route
 * remembers them, and so does a send). Never "every fund": as on the card, a county's file holds only the funds that
 * county pays for, so with none chosen nothing is sent.
 */
function fundsFor(code, given) {
  const remembered = code && recipients()[code] && Array.isArray(recipients()[code].fund_ids) ? recipients()[code].fund_ids : null;
  const ids = Array.isArray(given) ? given.map(String).filter(Boolean).slice(0, 200) : remembered;
  if (!ids || !ids.length) throw new ConnectError('Choose the settlement funds this county pays for (tick them on the Send to the county card): only they go into the file.', { reason: 'funds' });
  const known = new Set(db.all(`SELECT id FROM funding_sources WHERE ${IS_FUND} AND id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).map(x => x.id));
  if (ids.some(id => !known.has(id))) throw new ConnectError('One of the funds chosen is not an opioid settlement fund here. Reload the page and choose again.', { reason: 'funds' });
  if (!known.size) throw new ConnectError('Choose the settlement funds this county pays for: only they go into the file.', { reason: 'funds' });
  return [...known];
}
/**
 * The signed county submission file for [from, to]: the same as GET /api/county-submission/file makes for the same
 * choices (the Settlement outcomes figures for the chosen funds, then county.js payloadFrom and signFile).
 * `recipient` is { county_code, county_name }: the county's code from its /status, for the file's signed recipient
 * field. `fundIds`: the settlement funds that county pays for (fundsFor), never none. Throws county.js's
 * SubmissionError when the allow-list refuses the figures. Returns { file, sha256, fingerprint, payload, keyCreated }.
 */
async function buildFile({ from, to, user, recipient, fundIds, remember = true, schemaVersion }) {
  if (!Array.isArray(fundIds) || !fundIds.length) throw new ConnectError('Choose the settlement funds this county pays for: only they go into the file.', { reason: 'funds' });
  const K = require('./county');
  const SO = require('./settlement-outcomes');
  const range = require('./routes/reports').range({ query: new URLSearchParams({ from, to }) });
  const raw = await db.readSnapshot(async () => SO.figures(range, { fundIds }));
  const payload = K.payloadFrom(raw, { programme: db.getSetting('org_name', ''), recipient, ...(schemaVersion ? { schemaVersion } : {}) });
  const { key, created } = K.ensureKey(user);
  const { file, sha256, fingerprint } = K.signFile(payload);
  // Remembered for this county, as the file route does: the card offers the same name and funds next time. Only a
  // person's send remembers: an automatic one uses what a person chose and never rewrites it.
  if (remember) { const rec = recipients(); rec[payload.recipient.county_code] = { name: payload.recipient.county_name, fund_ids: fundIds, used_at: db.now() }; db.setSetting('county_submission_recipients', JSON.stringify(rec)); }
  return { file, sha256, fingerprint, payload, keyCreated: created ? key : null };
}

const WORDS = {
  imported: 'The county imported the file.',
  superseded: 'The county imported the file. It replaces the one it had for the same period.',
  older: 'The county kept the file, but a newer one it already has for the same period is the one that counts.',
  duplicate: 'The county already had this file; nothing changed.',
};
/**
 * Send the file for [from, to] to the county. `automatic`: the scheduled send (no person). Logs the send
 * (county_connect_sends) and audits it (county_submission.send: the period, the payload's SHA-256, the key's
 * fingerprint, the county's answer; never a figure). Returns { status, reason, message, receipt, send }.
 */
async function send({ from, to, user = null, ip = null, automatic = false, funds, countyCode = null, countyName = null }) {
  const K = require('./county');
  const c = row();
  if (!c) throw new ConnectError('This server is not connected to a county. Save the county\'s address and token first.', { reason: 'not_connected' });
  // The file names its recipient: the county's code from its /status (the last Test connection, or asked for now).
  if (!c.county_code) {
    const t = await test({ user, ip });
    if (!t.ok) throw new ConnectError(`The county file was not sent: SUDS could not ask the county for its county code. ${t.error}`, { reason: t.reason || 'network' });
  }
  const cur = row();
  const pend = pendingCode();
  if (pend) throw new ConnectError(`The county's server now gives a different county code (${K.formatCode(pend.code)}; this server was connected to ${K.formatCode(pend.previous)}). Nothing was sent. An administrator checks with the county and confirms the new code under Send to the county › Change the connection.`, { reason: 'county_code_changed' });
  if (!cur.county_code) throw new ConnectError('The county\'s server did not say its county code, so SUDS cannot address the file to it (a county refuses a file made for another county). Ask the county to update its SUDS, then Test connection again.', { reason: 'no_county_code' });
  // What the Send to the county card has chosen, so Send sends what Download would: the code typed there must be this
  // county's, and the name typed there is the one in the file (else the county's own, else the one last used).
  if (countyCode !== null && countyCode !== undefined && String(countyCode).trim()) {
    const typed = K.normaliseCode(countyCode);
    if (typed !== cur.county_code) throw new ConnectError(`The county code on the Send to the county card (${typed ? K.formatCode(typed) : String(countyCode).slice(0, 20)}) is not the code of the county this server is connected to (${K.formatCode(cur.county_code)}${cur.county_name ? `, ${cur.county_name}` : ''}). Correct the code on the card, or download the file for the other county.`, { reason: 'recipient' });
  }
  const remembered = recipients()[cur.county_code];
  const name = K.cleanText(countyName, K.TEXT_MAX.county_name) || cur.county_name || (remembered && K.cleanText(remembered.name, K.TEXT_MAX.county_name)) || '';
  if (!name) throw new ConnectError('Type the county\'s name on the Send to the county card, as the file should show it.', { reason: 'recipient' });
  const recipient = { county_code: cur.county_code, county_name: name };
  // The file version the county reads: what its /status last said (asked now if it has not said since the connection
  // was saved). A county on SUDS 1.20 or earlier says nothing, and is sent version 1, without the award amounts.
  if (!lastStatus()) await test({ user, ip });
  const schemaVersion = versionForCounty();
  // An automatic send uses only the funds a person last chose for this county's code, never a list given to it.
  const made = await buildFile({ from, to, user, recipient, fundIds: fundsFor(recipient.county_code, automatic ? undefined : funds), remember: !automatic, schemaVersion });
  if (made.keyCreated) audit.log({ user, action: 'county_submission.key.create', ip, details: { fingerprint: made.keyCreated.fingerprint } });
  const host = new URL(c.base_url).host;
  let status; let reason = null; let message; let receipt = null;
  try {
    const r = await call('POST', '/api/county-connect/v1/submissions', JSON.stringify(made.file));
    status = String(r.data.status || '');
    if (!['imported', 'superseded', 'older', 'duplicate', 'refused'].includes(status)) throw new ConnectError(`The county's server answered ${r.status} without saying what it did with the file.`, { reason: 'bad_answer' });
    reason = r.data.reason || null;
    receipt = r.data.receipt && typeof r.data.receipt === 'object' ? { sha256: String(r.data.receipt.sha256 || '').slice(0, 64) || null, received_at: String(r.data.receipt.received_at || '').slice(0, 40) || null } : null;
    message = status === 'refused' ? `The county refused the file: ${String(r.data.message || reason || '').slice(0, 500)}` : WORDS[status];
    if (receipt && receipt.sha256 && status !== 'refused' && receipt.sha256 !== made.sha256) { message += ' The county\'s receipt names a different file: ask the county to check.'; }
  } catch (e) {
    if (!(e instanceof ConnectError)) throw e;
    status = 'failed'; reason = e.reason || 'network'; message = e.message;
  }
  const id = uuid();
  // Made, whatever the county answered: the programme's reminders (county-schedule.js) count the period as made, and as
  // sent once the county accepted it (county_connect_sends).
  require('./county-schedule').recordMade({ county_code: recipient.county_code, from, to, sha256: made.sha256, schema_version: made.payload.schema_version, via: automatic ? 'auto' : 'send' });
  db.run(`INSERT INTO county_connect_sends(id,period_from,period_to,sha256,status,reason,county_received_at,base_url,automatic,sent_at,sent_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, from, to, made.sha256, status, reason ? String(reason).slice(0, 60) : null, receipt ? receipt.received_at : null, c.base_url, automatic ? 1 : 0, db.now(), user ? user.id : null);
  audit.log({ user: user || { username: 'system' }, action: 'county_submission.send', entity: 'county_connect_send', entityId: id, ip, success: !['failed', 'refused'].includes(status),
    details: { from, to, county_code: recipient.county_code, fingerprint: made.fingerprint, sha256: made.sha256, schema_version: made.payload.schema_version, host, status, reason: reason || undefined, automatic, funds: made.payload.funds.length, leaves_programme: status !== 'failed', content: 'aggregate counts and money; no client-level data' } });
  return { status, reason, message, receipt, send: sendOut(db.one(`SELECT s.*, u.display_name sent_by_name FROM county_connect_sends s LEFT JOIN users u ON u.id=s.sent_by WHERE s.id=?`, id)) };
}
function sendOut(s) { return { id: s.id, period_from: s.period_from, period_to: s.period_to, sha256: s.sha256, status: s.status, reason: s.reason, county_received_at: s.county_received_at, host: (() => { try { return new URL(s.base_url).host; } catch { return null; } })(), automatic: !!s.automatic, sent_at: s.sent_at, sent_by_name: s.sent_by_name || (s.automatic ? 'Automatic' : null) }; }
function sends(limit = 50) { return db.all(`SELECT s.*, u.display_name sent_by_name FROM county_connect_sends s LEFT JOIN users u ON u.id=s.sent_by ORDER BY s.sent_at DESC, s.id LIMIT ?`, limit).map(sendOut); }

/**
 * The periods an automatic send may send for the county's cadence, as this server works them out
 * (county-periods.js, as the county's own server does): those that ended in the last two years. Null for a cadence
 * SUDS does not know.
 */
function cadencePeriods(cadence, day) {
  const P = require('./county-periods');
  if (cadence === 'monthly') return P.completeMonths(day, AUTO_LOOKBACK.months);
  if (cadence === 'quarterly_calendar' || cadence === 'quarterly_fiscal') return P.completeQuarters(day, AUTO_LOOKBACK.quarters);
  return null;
}
/**
 * Why a period the county called outstanding is not sent automatically, or null: the manual route's checks (real
 * dates, the start on or before the end, ended before today, at most a year) and one of the periods of the cadence
 * within the lookback (cadencePeriods).
 */
function periodProblem(p, allowed, day) {
  const K = require('./county');
  if (!p || typeof p !== 'object' || !K.isDay(p.from) || !K.isDay(p.to)) return 'not_dates';
  if (p.from > p.to) return 'reversed';
  if (p.to >= day) return 'not_over';
  const y = Number(p.from.slice(0, 4));
  const yearOn = new Date(Date.UTC(y + 1, Number(p.from.slice(5, 7)) - 1, Number(p.from.slice(8, 10)))).toISOString().slice(0, 10);
  if (p.to >= yearOn) return 'longer_than_a_year';
  if (!allowed || !allowed.some(x => x.from === p.from && x.to === p.to)) return 'not_a_period_of_the_cadence';
  return null;
}
/** Errors that say nothing more can be sent this run (not the period's fault). */
const RUN_STOPPERS = new Set(['funds', 'not_connected', 'no_county_code', 'county_code_changed', 'recipient']);

/**
 * The automatic send, from the hourly housekeeping (server/index.js), once a day at most and only while switched on:
 * ask the county what is outstanding, and send each such period (the oldest first, four at most) that this server
 * has not already sent and had accepted. Every send is logged and audited as one a person makes, as automatic.
 * The county's list is checked, not trusted: a period that is not a real, ended period of the county's cadence in
 * the last two years is skipped and audited (county_submission.auto_skip, no figures), and never stops the rest;
 * nothing is sent unless a person has chosen the funds for this county's code.
 */
let autoRunning = false;
async function autoSendIfDue({ force = false } = {}) {
  const c = row();
  if (!c || !c.auto_send || autoRunning) return null;
  const last = db.getSetting('county_connect_auto_at', null);
  if (!force && last && Date.now() - Date.parse(last) < AUTO_EVERY_MS) return null;
  autoRunning = true;
  const system = { username: 'system' };
  try {
    db.setSetting('county_connect_auto_at', db.now());
    const host = new URL(c.base_url).host;
    const t = await test();
    if (!t.ok) { audit.log({ user: system, action: 'county_submission.auto', success: false, details: { host, error: t.reason || 'failed' } }); return { sent: [], error: t.error }; }
    if (t.code_changed) { audit.log({ user: system, action: 'county_submission.auto', success: false, details: { host, error: 'county_code_changed' } }); return { sent: [], error: 'county_code_changed' }; }
    const cur = row();
    const chosen = cur && cur.county_code ? recipients()[cur.county_code] : null;
    if (!chosen || !Array.isArray(chosen.fund_ids) || !chosen.fund_ids.length) {
      audit.log({ user: system, action: 'county_submission.auto', success: false, details: { host, error: 'funds', note: 'no settlement funds chosen for this county yet: a person sends once from the Send to the county card first' } });
      return { sent: [], error: 'funds' };
    }
    const day = require('./county-connect').today();
    const allowed = cadencePeriods(t.status.cadence, day);
    const listed = Array.isArray(t.status.outstanding) ? t.status.outstanding.slice(0, 100) : [];
    const done = new Set(db.all(`SELECT period_from, period_to FROM county_connect_sends WHERE status IN ('imported','superseded','duplicate','older')`).map(s => `${s.period_from}|${s.period_to}`));
    const good = []; let skipped = 0;
    const safeDay = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    for (const p of listed) {
      const why = periodProblem(p, allowed, day);
      if (why) {
        skipped++;
        if (skipped <= 10) audit.log({ user: system, action: 'county_submission.auto_skip', success: false, details: { host, from: safeDay(p && p.from), to: safeDay(p && p.to), reason: why, cadence: typeof t.status.cadence === 'string' ? t.status.cadence.slice(0, 40) : null } });
        continue;
      }
      const k = `${p.from}|${p.to}`;
      if (done.has(k) || good.some(x => `${x.from}|${x.to}` === k)) continue;
      good.push({ from: p.from, to: p.to });
    }
    const todo = good.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)).slice(0, AUTO_MAX_PERIODS);
    const sent = [];
    for (const p of todo) {
      // One period's failure (the file could not be made, the county refused it) is recorded and the next is tried;
      // a failure that is not the period's (no funds chosen, no county code) is said once and stops the run.
      try { sent.push({ from: p.from, to: p.to, ...(await send({ from: p.from, to: p.to, automatic: true })) }); }
      catch (e) {
        const reason = e.reason || e.code || (e.status ? `http_${e.status}` : 'error');
        if (!(e instanceof ConnectError) && !(e instanceof require('./county').SubmissionError) && !(e instanceof require('./http').HttpError)) console.error('[suds] county connection automatic send', e && e.message || e);
        sent.push({ from: p.from, to: p.to, status: 'failed', reason, message: e.message });
        if (e instanceof ConnectError && RUN_STOPPERS.has(e.reason)) break;
      }
    }
    audit.log({ user: system, action: 'county_submission.auto', details: { host, outstanding: listed.length, skipped, sent: sent.length } });
    return { sent, skipped };
  } finally { autoRunning = false; }
}

module.exports = { TIMEOUT_MS, MAX_ANSWER_BYTES, AUTO_LOOKBACK, LAST_STATUS, lastStatus, statusFacts, countyReads, versionForCounty, ConnectError, checkBaseUrl, describe, save, remove, call, test, buildFile, send, sends, autoSendIfDue, cadencePeriods, periodProblem, countyFromStatus, _setTimeoutForTests };

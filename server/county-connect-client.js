'use strict';
// The county connection, the programme's side (docs/COUNTY-VIEW.md, "Connecting"). Built for 1.18.0, not yet released.
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
// production, for development and tests); never a redirect; a timeout; the answer read to 64 KB at most; the host is
// the configured one only (the token never goes anywhere else). A county address on this machine or a private network
// is refused in production unless SUDS_COUNTY_ALLOW_PRIVATE=1 (a county reached over a VPN). A public address goes
// through server/outbound.js: checked, resolved, and connected to the address that passed the check. TLS
// certificates are verified; a county whose certificate is issued by its own CA is trusted with NODE_EXTRA_CA_CERTS.
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
  if (privateHost(host) && !allowPrivate() && (config.isProd || !LOOPBACK.has(host))) {
    throw new ConnectError('That address is on this computer or a private network. SUDS sends to a county there only when the server is started with SUDS_COUNTY_ALLOW_PRIVATE=1 (a county reached over a VPN; docs/DEPLOYMENT.md).');
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

// ---- the saved connection ---------------------------------------------------------------------------------------------
const row = () => db.one(`SELECT * FROM county_connection WHERE id='county'`);
/** The connection as a browser may see it: never the token, only its first characters. */
function describe() {
  const c = row();
  if (!c) return { connected: false, base_url: null, token_hint: null, auto_send: false, county_code: null, county_name: null, last_checked_at: null, last_check_ok: null, last_check_error: null, last_auto_at: db.getSetting('county_connect_auto_at', null) };
  return { connected: true, base_url: c.base_url, token_hint: c.token_hint, auto_send: !!c.auto_send, county_code: c.county_code, county_name: c.county_name,
    last_checked_at: c.last_checked_at, last_check_ok: c.last_check_ok === null ? null : !!c.last_check_ok, last_check_error: c.last_check_error, updated_at: c.updated_at,
    last_auto_at: db.getSetting('county_connect_auto_at', null) };
}
/** Save the county's address, and the token when one is given (required the first time). Returns what changed. */
function save({ baseUrl, token, autoSend }, user) {
  const have = row();
  const url = baseUrl !== undefined && baseUrl !== null ? checkBaseUrl(baseUrl) : have ? have.base_url : null;
  if (!url) throw new ConnectError('Type the county\'s address.');
  const t = token === undefined || token === null ? '' : String(token).trim();
  if (t && !/^sudscc_[A-Za-z0-9_-]{40,60}$/.test(t)) throw new ConnectError('That is not a county connection token. Paste the whole token the county gave you: it starts with sudscc_.');
  if (!have && !t) throw new ConnectError('Paste the connection token the county gave you.');
  const auto = autoSend === undefined || autoSend === null ? (have ? !!have.auto_send : false) : !!autoSend;
  const changed = { base_url: !have || have.base_url !== url, token: !!t, auto_send: !have || !!have.auto_send !== auto };
  if (have) {
    // A new address or token: what the county said before no longer applies.
    const reset = changed.base_url || changed.token;
    db.run(`UPDATE county_connection SET base_url=?, token_enc=COALESCE(?, token_enc), token_hint=COALESCE(?, token_hint), auto_send=?, updated_at=?, updated_by=?${reset ? ', county_code=NULL, county_name=NULL, last_checked_at=NULL, last_check_ok=NULL, last_check_error=NULL' : ''} WHERE id='county'`,
      url, t ? encrypt(t) : null, t ? t.slice(0, 12) : null, auto ? 1 : 0, db.now(), user ? user.id : null);
  } else {
    db.run(`INSERT INTO county_connection(id,base_url,token_enc,token_hint,auto_send,updated_at,updated_by) VALUES('county',?,?,?,?,?,?)`, url, encrypt(t), t.slice(0, 12), auto ? 1 : 0, db.now(), user ? user.id : null);
  }
  return { changed, host: new URL(url).host };
}
function remove() { const had = row(); db.run(`DELETE FROM county_connection WHERE id='county'`); return had; }

// ---- talking to the county -----------------------------------------------------------------------------------------
/** A request over node:http(s) straight to the address (this machine outside production, or a county allowed on a private network). */
function directRequest(url, { method, headers, body }) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? require('node:http') : require('node:https');
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_ANSWER_BYTES) { req.destroy(); reject(new ConnectError('The county\'s server sent a longer answer than SUDS reads.')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, contentType: String(res.headers['content-type'] || ''), text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    req.on('error', reject);
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
  const direct = u.protocol === 'http:' || (privateHost(hostOf(u)) && (allowPrivate() || (!config.isProd && LOOPBACK.has(hostOf(u)))));
  let res;
  try { res = await (direct ? directRequest : publicRequest)(url, { method, headers, body }); }
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

/** Ask the county what it expects (GET /status). Records whether it worked, and the county's code and name. */
async function test() {
  try {
    const r = await call('GET', '/api/county-connect/v1/status');
    if (r.status !== 200 || !r.data.programme || !Array.isArray(r.data.expected)) throw new ConnectError(`The county's server answered ${r.status}: ${String(r.data.error || 'not a status').slice(0, 200)}`, { reason: 'bad_answer' });
    const county = r.data.county || {};
    db.run(`UPDATE county_connection SET last_checked_at=?, last_check_ok=1, last_check_error=NULL, county_code=?, county_name=? WHERE id='county'`, db.now(), county.code ? String(county.code).slice(0, 40) : null, county.name ? String(county.name).slice(0, 200) : null);
    return { ok: true, status: r.data };
  } catch (e) {
    if (!(e instanceof ConnectError)) throw e;
    db.run(`UPDATE county_connection SET last_checked_at=?, last_check_ok=0, last_check_error=? WHERE id='county'`, db.now(), e.message.slice(0, 300));
    return { ok: false, error: e.message, reason: e.reason || null };
  }
}

// ---- the file ---------------------------------------------------------------------------------------------------------
/**
 * The signed county submission file for [from, to]: the same as GET /api/county-submission/file makes (the
 * Settlement outcomes figures, county.js payloadFrom and signFile). `recipient` is the county's { county_code,
 * county_name } from its status, for the file's recipient field (fix/county-view-r1). Throws county.js's
 * SubmissionError when the allow-list refuses the figures. Returns { file, sha256, fingerprint, payload, keyCreated }.
 */
async function buildFile({ from, to, user, recipient }) {
  const K = require('./county');
  const SO = require('./settlement-outcomes');
  const range = require('./routes/reports').range({ query: new URLSearchParams({ from, to }) });
  const raw = await db.readSnapshot(async () => SO.figures(range));
  const payload = K.payloadFrom(raw, { programme: db.getSetting('org_name', ''), recipient });
  const { key, created } = K.ensureKey(user);
  const { file, sha256, fingerprint } = K.signFile(payload);
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
async function send({ from, to, user = null, ip = null, automatic = false }) {
  const c = row();
  if (!c) throw new ConnectError('This server is not connected to a county. Save the county\'s address and token first.', { reason: 'not_connected' });
  // The county's code, for the file's recipient: from the last status, or asked for now.
  if (!c.county_code) await test();
  const cur = row();
  const recipient = cur.county_code ? { county_code: cur.county_code, county_name: cur.county_name || '' } : undefined;
  const made = await buildFile({ from, to, user, recipient });
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
  db.run(`INSERT INTO county_connect_sends(id,period_from,period_to,sha256,status,reason,county_received_at,base_url,automatic,sent_at,sent_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, from, to, made.sha256, status, reason ? String(reason).slice(0, 60) : null, receipt ? receipt.received_at : null, c.base_url, automatic ? 1 : 0, db.now(), user ? user.id : null);
  audit.log({ user: user || { username: 'system' }, action: 'county_submission.send', entity: 'county_connect_send', entityId: id, ip, success: !['failed', 'refused'].includes(status),
    details: { from, to, fingerprint: made.fingerprint, sha256: made.sha256, host, status, reason: reason || undefined, automatic, funds: made.payload.funds.length, leaves_programme: status !== 'failed', content: 'aggregate counts and money; no client-level data' } });
  return { status, reason, message, receipt, send: sendOut(db.one(`SELECT s.*, u.display_name sent_by_name FROM county_connect_sends s LEFT JOIN users u ON u.id=s.sent_by WHERE s.id=?`, id)) };
}
function sendOut(s) { return { id: s.id, period_from: s.period_from, period_to: s.period_to, sha256: s.sha256, status: s.status, reason: s.reason, county_received_at: s.county_received_at, host: (() => { try { return new URL(s.base_url).host; } catch { return null; } })(), automatic: !!s.automatic, sent_at: s.sent_at, sent_by_name: s.sent_by_name || (s.automatic ? 'Automatic' : null) }; }
function sends(limit = 50) { return db.all(`SELECT s.*, u.display_name sent_by_name FROM county_connect_sends s LEFT JOIN users u ON u.id=s.sent_by ORDER BY s.sent_at DESC, s.id LIMIT ?`, limit).map(sendOut); }

/**
 * The automatic send, from the hourly housekeeping (server/index.js), once a day at most and only while switched on:
 * ask the county what is outstanding, and send each such period (the oldest first, four at most) that this server
 * has not already sent and had accepted. Every send is logged and audited as one a person makes, as automatic.
 */
let autoRunning = false;
async function autoSendIfDue({ force = false } = {}) {
  const c = row();
  if (!c || !c.auto_send || autoRunning) return null;
  const last = db.getSetting('county_connect_auto_at', null);
  if (!force && last && Date.now() - Date.parse(last) < AUTO_EVERY_MS) return null;
  autoRunning = true;
  try {
    db.setSetting('county_connect_auto_at', db.now());
    const t = await test();
    if (!t.ok) { audit.log({ user: { username: 'system' }, action: 'county_submission.auto', success: false, details: { host: new URL(c.base_url).host, error: t.reason || 'failed' } }); return { sent: [], error: t.error }; }
    const done = new Set(db.all(`SELECT period_from, period_to FROM county_connect_sends WHERE status IN ('imported','superseded','duplicate','older')`).map(s => `${s.period_from}|${s.period_to}`));
    const todo = (t.status.outstanding || []).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.from) && /^\d{4}-\d{2}-\d{2}$/.test(p.to) && !done.has(`${p.from}|${p.to}`)).slice(0, AUTO_MAX_PERIODS);
    const sent = [];
    for (const p of todo) sent.push({ from: p.from, to: p.to, ...(await send({ from: p.from, to: p.to, automatic: true })) });
    audit.log({ user: { username: 'system' }, action: 'county_submission.auto', details: { host: new URL(c.base_url).host, outstanding: (t.status.outstanding || []).length, sent: sent.length } });
    return { sent };
  } finally { autoRunning = false; }
}

module.exports = { TIMEOUT_MS, MAX_ANSWER_BYTES, ConnectError, checkBaseUrl, describe, save, remove, call, test, buildFile, send, sends, autoSendIfDue, _setTimeoutForTests };

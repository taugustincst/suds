'use strict';
// The county connection (server/county-connect.js, server/county-connect-client.js, server/routes/county-connect.js;
// docs/COUNTY-VIEW.md, "Connecting"): a county's connection and read tokens, the machine routes a programme's server
// posts its signed file to and asks what is expected, the county's read API, and the programme's side (the county's
// address and token, Test connection, Send, the send log) with its outbound safety. The test server plays the county
// and, through a second listener on another port over the same app, a programme that sends to it end to end.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const H = require('./helpers');
const K = require('../server/county');
const CC = require('../server/county-connect');
const CL = require('../server/county-connect-client');
const SAMPLE = require('../scripts/county-sample');
const config = require('../server/config');
const outbound = require('../server/outbound');

let base; let admin; let fin; let sup; let nav;
let samples; let progA; let progB; let own; let fund; let COUNTY;
const Q1 = { from: '2026-01-01', to: '2026-03-31' }; const Q2 = { from: '2026-04-01', to: '2026-06-30' };
const lastAudit = (action) => { const a = H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return a ? { ...a, details: a.details ? JSON.parse(a.details) : null } : null; };
const auditCount = (action) => H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action=?`, action).n;
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const { rateLimitReset } = require('../server/app');

/** A machine call: no cookie, a bearer token (or none), a JSON (or given) body. */
async function bearer(method, path, token, body, { contentType = 'application/json', to = base } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': contentType } : {}) };
  const res = await fetch(to + path, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text() };
}
const issue = async (c, body) => c.post('/api/county-connect/tokens', body);
const enable = (on = true) => admin.put('/api/county-connect/settings', { enabled: on });

before(async () => {
  base = await H.start();
  H.db.setSetting('org_name', 'Connected Test Programme');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['ccfin', 'finance'], ['ccsup', 'supervisor'], ['ccnav', 'navigator']]) H.makeUser(u, role);
  fin = H.client(); await fin.login('ccfin', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('ccsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('ccnav', 'StaffPassw0rd!x');
  // The sample programmes' files are made for this server's own county code (county.js countyCode), as a real
  // programme's are for the code its county gave it; the county refuses a file made for another county.
  const code = ok(await admin.get('/api/county/code'), 200);
  COUNTY = { county_code: code.code, county_name: 'Connected Test County' };
  samples = SAMPLE.sample({ periods: [Q1, Q2], recipient: COUNTY });
  // Registered as the county view's register route requires (fix/county-view-r1): the fingerprint the programme read
  // out typed (and checked against the key), or the person's word that they compared it.
  progA = ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, fingerprint: samples[0].fingerprint_display }));
  progB = ok(await admin.post('/api/county/programmes', { name: samples[1].name, public_key: samples[1].public_key, compared: true }));
  // This server's own county signing key, registered as a programme: the end-to-end test sends its own file.
  const key = (await admin.post('/api/county-submission/key', {})).data.key;
  own = ok(await admin.post('/api/county/programmes', { name: 'Connected Test Programme', public_key: key.public_key, fingerprint: key.fingerprint }));
  // Some settlement work in Q2, so the file sent end to end has figures in it.
  fund = ok(await admin.post('/api/budget/funds', { name: 'Connected settlement share', grant_number: 'OSF-CC-1', source_type: 'opioid_settlement', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 50000, settlement_use: 'core_a', settlement_hiaa: 'hiaa_6' })).id;
  const e = ok(await admin.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: '2026-05-05', amount: 777.25, category: 'naloxone_supplies' })).id;
  ok(await sup.post(`/api/budget/expenditures/${e}/approve`, { status: 'approved' }), 200);
});
after(async () => { await H.stop(); });
beforeEach(() => { rateLimitReset('county-connect:127.0.0.1'); rateLimitReset('county-connect-bad:127.0.0.1'); });

// ---------------------------------------------------------------- the county's settings and tokens
test('off by default: every machine route is 404, even with a good token; switching on needs county:manage and settings:manage', async () => {
  assert.equal(CC.enabled(), false);
  const t = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  const rt = ok(await issue(admin, { scope: 'county.read', name: 'Warehouse' }));
  for (const [m, p, tok] of [['POST', '/api/county-connect/v1/submissions', t.token], ['GET', '/api/county-connect/v1/status', t.token], ['GET', `/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}`, rt.token], ['GET', '/api/county-connect/v1/programs', rt.token], ['GET', '/api/county-connect/v1/status', null]]) {
    const r = await bearer(m, p, tok, m === 'POST' ? JSON.stringify(samples[0].files[0].file) : undefined);
    assert.equal(r.status, 404, `${m} ${p}`); assert.deepEqual(r.data, { error: 'Not found' });
  }
  const s = await fin.get('/api/county-connect/settings');
  assert.equal(s.status, 200); assert.equal(s.data.enabled, false); assert.equal(s.data.cadence, 'quarterly_calendar');
  assert.equal((await nav.get('/api/county-connect/settings')).status, 403);
  assert.equal((await sup.put('/api/county-connect/settings', { enabled: true })).status, 403, 'county:view is not enough');
  assert.equal((await fin.put('/api/county-connect/settings', { enabled: true })).status, 403);
  assert.equal((await admin.put('/api/county-connect/settings', { cadence: 'weekly' })).status, 400);
  assert.equal((await admin.put('/api/county-connect/settings', { start: '2026-13-01' })).status, 400);
  const on = await enable();
  assert.equal(on.status, 200); assert.equal(on.data.enabled, true);
  const a = lastAudit('county_connect.settings'); assert.equal(a.details.enabled, true); assert.equal(a.details.was_enabled, false);
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', t.token)).status, 200);
});

test('tokens: 256 random bits shown once, kept as SHA-256; expiry rules; revocable; issuing and revoking audited', async () => {
  assert.equal((await fin.post('/api/county-connect/tokens', { scope: 'county.read', name: 'x' })).status, 403, 'county:view cannot issue');
  assert.equal((await sup.get('/api/county-connect/tokens')).status, 403);
  assert.equal((await issue(admin, { scope: 'county.submit' })).status, 400, 'a connection token needs a programme');
  assert.equal((await issue(admin, { scope: 'county.read' })).status, 400, 'a read token needs a name');
  assert.equal((await issue(admin, { scope: 'county.read', name: 'W', expires_days: 400 })).status, 400, 'at most a year');
  assert.equal((await issue(admin, { scope: 'county.read', name: 'W', programme_id: progA.id })).status, 400, 'a read token has no programme');
  assert.equal((await issue(admin, { scope: 'county.submit', programme_id: progA.id, expires_days: 0 })).status, 400);
  assert.equal((await issue(admin, { scope: 'admin', programme_id: progA.id })).status, 400);
  const c = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id, expires_days: 30 }));
  assert.match(c.token, /^sudscc_[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(c.token.slice(7), 'base64url').length, 32, '256 bits');
  assert.equal(c.kind, 'connection'); assert.equal(c.programme, samples[0].name); assert.equal(c.state, 'live');
  assert.ok(Math.abs(Date.parse(c.expires_at) - Date.now() - 30 * 86400000) < 60000);
  const r = ok(await issue(admin, { scope: 'county.read', name: 'County data warehouse' }));
  assert.match(r.token, /^sudscr_/); assert.ok(Math.abs(Date.parse(r.expires_at) - Date.now() - 90 * 86400000) < 60000, 'a read token expires after 90 days by default');
  const row = H.db.one(`SELECT * FROM county_connect_tokens WHERE id=?`, c.id);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(c.token).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(c.token), 'the token itself is not stored');
  const list = ok(await admin.get('/api/county-connect/tokens'), 200);
  const txt = JSON.stringify(list);
  assert.ok(!txt.includes(c.token) && !txt.includes(r.token) && !txt.includes(row.token_hash), 'never listed again, nor its hash');
  assert.ok(list.rows.some(x => x.id === c.id && x.prefix === c.token.slice(0, 12)));
  const ai = lastAudit('county_connect.token.issue');
  assert.equal(ai.details.scope, 'county.read'); assert.ok(!JSON.stringify(ai.details).includes(r.token));
  // Revoked: refused from then on, audited, and revoking twice is harmless.
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', c.token)).status, 200);
  const rv = ok(await admin.post(`/api/county-connect/tokens/${c.id}/revoke`, {}), 200);
  assert.equal(rv.state, 'revoked');
  assert.equal(lastAudit('county_connect.token.revoke').entity_id, c.id);
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', c.token)).status, 401);
  assert.equal((await admin.post(`/api/county-connect/tokens/${c.id}/revoke`, {})).status, 200);
  assert.equal((await admin.post('/api/county-connect/tokens/nope/revoke', {})).status, 404);
  // Expired: refused.
  const e = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id, expires_days: 1 }));
  H.db.run(`UPDATE county_connect_tokens SET expires_at=? WHERE id=?`, new Date(Date.now() - 1000).toISOString(), e.id);
  const er = await bearer('GET', '/api/county-connect/v1/status', e.token);
  assert.equal(er.status, 401); assert.match(er.headers.get('www-authenticate') || '', /^Bearer/);
  assert.equal(lastAudit('county_connect.refuse').details.reason, 'expired_token');
  // Last use recorded: when, and from which address.
  const used = H.db.one(`SELECT last_used_at, last_used_ip FROM county_connect_tokens WHERE id=?`, c.id);
  assert.ok(used.last_used_at); assert.match(used.last_used_ip, /127\.0\.0\.1/);
});

// ---------------------------------------------------------------- the push
test('push: the programme\'s own file under its own token is imported, with a receipt and no figures; again is a duplicate', async () => {
  const t = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  const f = samples[0].files[0];
  const r = await bearer('POST', '/api/county-connect/v1/submissions', t.token, JSON.stringify(f.file));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, 'imported'); assert.equal(r.data.reason, null);
  assert.equal(r.data.receipt.sha256, f.sha256); assert.ok(r.data.receipt.received_at);
  assert.deepEqual(Object.keys(r.data).sort(), ['message', 'period', 'reason', 'receipt', 'status']);
  assert.ok(!/naloxone|values|total/.test(JSON.stringify(r.data)), 'never figures in the answer');
  const a = lastAudit('county.submission.import');
  assert.equal(a.details.via, 'county-connect'); assert.equal(a.details.token_id, t.id); assert.equal(a.details.sha256, f.sha256);
  assert.match(a.username, /^county-token:sudscc_/); assert.equal(a.user_id, null);
  assert.ok(!/naloxone|values/.test(a.details ? JSON.stringify(a.details) : ''));
  const again = await bearer('POST', '/api/county-connect/v1/submissions', t.token, JSON.stringify(f.file, null, 2));
  assert.equal(again.status, 200); assert.equal(again.data.status, 'duplicate'); assert.equal(again.data.receipt.sha256, f.sha256);
  assert.equal(lastAudit('county.submission.duplicate').details.via, 'county-connect');
  // A body sent as text rather than JSON is read the same way.
  const t2 = await bearer('POST', '/api/county-connect/v1/submissions', t.token, JSON.stringify(samples[0].files[1].file), { contentType: 'text/plain' });
  assert.equal(t2.status, 201, JSON.stringify(t2.data)); assert.equal(t2.data.status, 'imported');
  assert.equal(t2.data.message, K.importMessage({ status: 'imported', programme: { name: samples[0].name }, submission: { period_from: Q2.from, period_to: Q2.to } }), 'county.js\'s own words');
  // A file made before the one the county has for the period is kept, and does not count (county.js: the one made
  // last counts, whatever order they arrive in); the programme is told so in the county view's words.
  const earlier = K.signWithSeed(SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1, 1.5, { recipient: COUNTY, generatedAt: `${Q1.to}T12:00:00.000Z` }), samples[0].seed);
  const old = await bearer('POST', '/api/county-connect/v1/submissions', t.token, JSON.stringify(earlier.file));
  assert.equal(old.status, 201, JSON.stringify(old.data)); assert.equal(old.data.status, 'older'); assert.equal(old.data.reason, null);
  assert.match(old.data.message, /does not count/); assert.doesNotMatch(old.data.message, /withdraw/, 'the county\'s own advice is for the county');
  assert.equal(K.countingSubs(progA.id).find(x => x.period_from === Q1.from).sha256, f.sha256, 'the later-made file still counts');
});

test('push: county.js\'s refusals pass through with their reasons: a file for another county, an unknown key', async () => {
  const t = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  const other = SAMPLE.sample({ periods: [Q1], recipient: SAMPLE.SAMPLE_COUNTY })[0].files[0];
  const r = await bearer('POST', '/api/county-connect/v1/submissions', t.token, JSON.stringify(other.file));
  assert.equal(r.status, 422); assert.equal(r.data.status, 'refused'); assert.equal(r.data.reason, 'recipient');
  assert.match(r.data.message, new RegExp(`This county's code is ${K.formatCode(COUNTY.county_code)}`));
  const stranger = K.signWithSeed(SAMPLE.payloadFor(SAMPLE.PROGRAMMES[2], Q1, 1, { recipient: COUNTY }), crypto.randomBytes(32));
  const u = await bearer('POST', '/api/county-connect/v1/submissions', t.token, JSON.stringify(stranger.file));
  assert.equal(u.status, 422); assert.equal(u.data.reason, 'unknown_key');
  assert.equal(lastAudit('county.submission.refuse').details.reason, 'unknown_key');
});

test('push: a file signed by another programme is refused under this token, and nothing is kept', async () => {
  const tA = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  const fB = samples[1].files[0];
  const before = H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n;
  const r = await bearer('POST', '/api/county-connect/v1/submissions', tA.token, JSON.stringify(fB.file));
  assert.equal(r.status, 422); assert.equal(r.data.status, 'refused'); assert.equal(r.data.reason, 'wrong_programme');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, before, 'rolled back');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions WHERE sha256=?`, fB.sha256).n, 0);
  const a = lastAudit('county.submission.refuse'); assert.equal(a.details.reason, 'wrong_programme'); assert.equal(a.details.via, 'county-connect'); assert.equal(a.success, 0);
  // B's own token takes it.
  const tB = ok(await issue(admin, { scope: 'county.submit', programme_id: progB.id }));
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', tB.token, JSON.stringify(fB.file))).data.status, 'imported');
});

test('push: a changed file is refused by county.js\'s signature check; a malformed one by its reader', async () => {
  const t = ok(await issue(admin, { scope: 'county.submit', programme_id: progB.id }));
  const tampered = JSON.parse(JSON.stringify(samples[1].files[1].file)); tampered.payload.total.values.naloxone_kits += 1;
  const r = await bearer('POST', '/api/county-connect/v1/submissions', t.token, JSON.stringify(tampered));
  assert.equal(r.status, 422); assert.equal(r.data.reason, 'signature');
  const extra = JSON.parse(JSON.stringify(samples[1].files[1].file)); extra.payload.client_code = 'M26-0001';
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', t.token, JSON.stringify(extra))).data.reason, 'schema', 'the allow-list');
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', t.token, '{"format":"x"}')).data.reason, 'format');
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', t.token, 'not json', { contentType: 'text/plain' })).data.reason, 'malformed');
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', t.token)).data.reason, 'malformed', 'no body');
});

test('push: the body is capped at 256 KB before it is parsed; without a good token at the 64 KB no-session cap', async () => {
  const t = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  const huge = '{' + ' '.repeat(300 * 1024) + '"x":1}';
  const r = await bearer('POST', '/api/county-connect/v1/submissions', t.token, huge);
  assert.equal(r.status, 413, 'refused as too large, not parsed (it is valid JSON)');
  const bad = '[' + '1,'.repeat(150 * 1024) + '1'; // invalid JSON: a parse would say 400
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', t.token, bad)).status, 413);
  // Between 64 KB and 256 KB: taken with a connection token, not without one.
  const mid = JSON.stringify({ ...samples[0].files[0].file, pad: 'x'.repeat(100 * 1024) });
  const withTok = await bearer('POST', '/api/county-connect/v1/submissions', t.token, mid);
  assert.equal(withTok.status, 422); assert.equal(withTok.data.reason, 'schema', 'read, and refused for its extra field');
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', 'sudscc_' + 'A'.repeat(43), mid)).status, 413);
  const rt = ok(await issue(admin, { scope: 'county.read', name: 'W' }));
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', rt.token, mid)).status, 413, 'nor with a read token');
});

// ---------------------------------------------------------------- wrong tokens, scopes and sessions
test('no token, an unknown one, or one of the wrong kind; a session never opens these routes, and a token never a session', async () => {
  const conn = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  const read = ok(await issue(admin, { scope: 'county.read', name: 'Warehouse' }));
  const file = JSON.stringify(samples[0].files[0].file);
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', null)).status, 401);
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', 'sudscc_' + 'x'.repeat(43))).status, 401);
  assert.equal(lastAudit('county_connect.refuse').details.reason, 'unknown_token');
  // A read token cannot push or ask for a status; a connection token cannot read.
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', read.token, file)).status, 403);
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', read.token)).status, 403);
  assert.equal((await bearer('GET', `/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}`, conn.token)).status, 403);
  assert.equal((await bearer('GET', '/api/county-connect/v1/programs', conn.token)).status, 403);
  assert.equal(lastAudit('county_connect.refuse').details.reason, 'wrong_scope');
  // The administrator's session (cookie) opens none of them; nor does the session token as a bearer token.
  assert.equal((await admin.get('/api/county-connect/v1/status')).status, 401);
  assert.equal((await admin.get('/api/county-connect/v1/programs')).status, 401);
  assert.equal((await admin.post('/api/county-connect/v1/submissions', samples[0].files[0].file)).status, 401);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ username: 'ccsup', password: 'StaffPassw0rd!x' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0].split('=')[1];
  assert.equal((await bearer('GET', '/api/auth/me', cookie)).status, 200, 'the session token itself is a session');
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', cookie)).status, 401, 'but not a county token');
  // A county token is never a session: not for /me, the county view or anything else.
  for (const tok of [conn.token, read.token]) {
    for (const p of ['/api/auth/me', `/api/county/view?from=${Q1.from}&to=${Q1.to}`, '/api/county/programmes', '/api/county-connect/tokens', '/api/clients']) assert.equal((await bearer('GET', p, tok)).status, 401, p);
  }
});

test('rate limits: per token, and wrong tokens per address', async () => {
  const { rateLimit } = require('../server/app');
  const t = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  for (let i = 0; i < CC.LIMITS.statusPerToken; i++) assert.equal((await bearer('GET', '/api/county-connect/v1/status', t.token)).status, 200, `call ${i + 1}`);
  const over = await bearer('GET', '/api/county-connect/v1/status', t.token);
  assert.equal(over.status, 429);
  rateLimitReset('county-connect:127.0.0.1');
  const other = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', other.token)).status, 200, 'another token is not held back');
  for (let i = 0; i < CC.LIMITS.badPerIp; i++) assert.equal((await bearer('GET', '/api/county-connect/v1/status', 'sudscc_' + String(i).padStart(43, 'z'))).status, 401);
  const blocked = await bearer('GET', '/api/county-connect/v1/status', other.token);
  assert.equal(blocked.status, 429, 'after too many wrong tokens this address waits, good token or not');
  rateLimitReset('county-connect-bad:127.0.0.1');
  // Refused files per token.
  for (let i = 0; i < CC.LIMITS.refusedPerToken; i++) rateLimit(`county-connect-refused:${other.id}`, CC.LIMITS.refusedPerToken, CC.WINDOW_MS);
  assert.equal((await bearer('POST', '/api/county-connect/v1/submissions', other.token, '{}')).status, 429);
  // The per-address limit on every machine route together.
  for (let i = 0; i < CC.LIMITS.perIp; i++) rateLimit('county-connect:127.0.0.1', CC.LIMITS.perIp, CC.WINDOW_MS);
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', other.token)).status, 429);
  // Refusals of callers without a good token: the first ten an hour are written one by one, then counted.
  const n0 = auditCount('county_connect.refuse');
  rateLimitReset('county-connect:127.0.0.1');
  for (let i = 0; i < 15; i++) { rateLimitReset('county-connect-bad:127.0.0.1'); await bearer('GET', '/api/county-connect/v1/status', 'sudscc_' + String(i).padStart(43, 'q')); }
  assert.ok(auditCount('county_connect.refuse') - n0 <= 11, 'the audit log does not grow one row per refusal');
});

// ---------------------------------------------------------------- status
test('status: what the county expects of this programme, and only this programme', async () => {
  const t = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  const r = await bearer('GET', '/api/county-connect/v1/status', t.token);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.data.programme.id, progA.id); assert.equal(r.data.cadence, 'quarterly_calendar');
  assert.equal(r.data.county.code, COUNTY.county_code, 'the county code a programme\'s file must name (county.js countyCode)');
  assert.match(r.data.county.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.deepEqual(r.data.expected.map(p => [p.from, p.to]), CC.expectedPeriods().map(p => [p.from, p.to]));
  const q1 = r.data.expected.find(p => p.from === Q1.from); assert.ok(q1 && q1.received, 'A\'s Q1 file was received');
  assert.ok(r.data.outstanding.every(p => !r.data.received.some(x => x.from === p.from && x.to === p.to && x.status === 'current')));
  assert.ok(r.data.received.length >= 1 && r.data.received.every(x => x.sha256 && x.from && x.to));
  const txt = JSON.stringify(r.data);
  assert.ok(!txt.includes(samples[1].name) && !txt.includes(samples[1].fingerprint) && !txt.includes(samples[1].files[0].sha256), 'nothing of programme B');
  assert.ok(!/naloxone|values/.test(txt), 'no figures');
  assert.equal(lastAudit('county_connect.status').entity_id, progA.id);
  // The cadence and start are the county's settings.
  ok(await admin.put('/api/county-connect/settings', { cadence: 'monthly' }), 200);
  const m = (await bearer('GET', '/api/county-connect/v1/status', t.token)).data;
  assert.equal(m.expected.length, 12); assert.ok(m.expected.every(p => p.from.endsWith('-01')));
  ok(await admin.put('/api/county-connect/settings', { cadence: 'quarterly_fiscal', start: Q1.from }), 200);
  const f = (await bearer('GET', '/api/county-connect/v1/status', t.token)).data;
  assert.ok(f.expected.every(p => p.from >= Q1.from)); assert.ok(f.expected.some(p => /^FY 2025-26 Q[34] \((Jan – Mar|Apr – Jun) 2026\)$/.test(p.label)), JSON.stringify(f.expected));
  ok(await admin.put('/api/county-connect/settings', { cadence: 'quarterly_calendar', start: null }), 200);
});

test('the period arithmetic: calendar and fiscal quarters, months, and a start date, named as the county view names them', () => {
  const cal = CC.expectedPeriods('quarterly_calendar', '2026-09-30', null);
  assert.deepEqual(cal.map(p => `${p.from}/${p.to}/${p.label}`),
    ['2025-07-01/2025-09-30/Jul – Sep 2025 (calendar Q3 2025 · FY 2025-26 Q1)', '2025-10-01/2025-12-31/Oct – Dec 2025 (calendar Q4 2025 · FY 2025-26 Q2)',
      '2026-01-01/2026-03-31/Jan – Mar 2026 (calendar Q1 2026 · FY 2025-26 Q3)', '2026-04-01/2026-06-30/Apr – Jun 2026 (calendar Q2 2026 · FY 2025-26 Q4)']);
  // Word for word what the Send to the county card offers for the same quarters (county-periods.js submissionPeriods).
  const card = require('../server/county-periods').submissionPeriods('2026-09-30');
  for (const p of cal) assert.equal(card.find(x => x.from === p.from && x.to === p.to).label, p.label);
  assert.deepEqual(CC.expectedPeriods('quarterly_fiscal', '2026-10-01', null).map(p => p.label), ['FY 2025-26 Q2 (Oct – Dec 2025)', 'FY 2025-26 Q3 (Jan – Mar 2026)', 'FY 2025-26 Q4 (Apr – Jun 2026)', 'FY 2026-27 Q1 (Jul – Sep 2026)']);
  const months = CC.expectedPeriods('monthly', '2026-03-15', '2025-12-01');
  assert.deepEqual(months.map(p => p.from), ['2025-12-01', '2026-01-01', '2026-02-01']); assert.equal(months[2].to, '2026-02-28');
  assert.deepEqual(months.map(p => p.label), ['Dec 2025', 'Jan 2026', 'Feb 2026']);
  assert.equal(CC.expectedPeriods('monthly', '2026-03-15', null).length, 12);
});

// ---------------------------------------------------------------- the read API
test('read API: the combined view with its notes, as JSON or tidy CSV, and the programmes; audited without figures', async () => {
  const rt = ok(await issue(admin, { scope: 'county.read', name: 'County data warehouse' }));
  const r = await bearer('GET', `/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}`, rt.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = K.combined(Q1.from, Q1.to);
  assert.deepEqual(r.data.rows, JSON.parse(JSON.stringify(d.rows)), 'the combined view builder\'s own rows');
  assert.equal(r.data.notes.unduplicated, false); assert.match(r.data.notes.not_unduplicated, /not unduplicated/i);
  assert.match(r.data.notes.classification, /not for publication/); assert.equal(r.data.notes.counts, 'exact'); assert.deepEqual(r.data.notes.caveats, K.CAVEATS);
  const a = lastAudit('county.api.read');
  assert.equal(a.details.what, 'combined'); assert.equal(a.details.token_id, rt.id); assert.ok(!/naloxone|values|rows/.test(JSON.stringify(a.details)));
  const csv = await bearer('GET', `/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}&format=tidy-csv`, rt.token);
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.equal(csv.headers.get('x-suds-report-counts'), 'exact');
  const lines = csv.data.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'from,to,programme_id,programme,programme_status,group,measure_key,measure,unit,value');
  assert.equal(lines.length - 1, d.rows.length * (d.programmes.length + 1), 'one row per programme and measure, and the total');
  assert.equal((await bearer('GET', `/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}&format=xml`, rt.token)).status, 400);
  assert.equal((await bearer('GET', '/api/county-connect/v1/combined?from=2026-05-01&to=2026-04-01', rt.token)).status, 400);
  assert.equal((await bearer('GET', '/api/county-connect/v1/combined', rt.token)).status, 400);
  const p = await bearer('GET', '/api/county-connect/v1/programs', rt.token);
  assert.equal(p.status, 200);
  const a1 = p.data.rows.find(x => x.id === progA.id);
  assert.equal(a1.fingerprint, samples[0].fingerprint); assert.ok(a1.periods.some(x => x.from === Q1.from)); assert.ok(a1.last_received);
  assert.ok(!JSON.stringify(p.data).includes('PRIVATE') && !JSON.stringify(p.data).includes('BEGIN PUBLIC KEY'));
  assert.equal(lastAudit('county.api.read').details.what, 'programs');
  // B makes a new key and says the old one was compromised (county view › Keys): /v1/programs gives the current
  // key's fingerprint and the history, and B's old files stop counting there, in the combined view and in B's status,
  // by the county view's own rule. A file its old key signed that the county does not have yet is refused.
  const tB = ok(await issue(admin, { scope: 'county.submit', programme_id: progB.id }));
  assert.ok((await bearer('GET', '/api/county-connect/v1/status', tB.token)).data.expected.find(x => x.from === Q1.from).received, 'B\'s Q1 file counts');
  const fresh = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  ok(await admin.post(`/api/county/programmes/${progB.id}/keys`, { public_key: fresh, compared: true, old_compromised: true }));
  const p2 = (await bearer('GET', '/api/county-connect/v1/programs', rt.token)).data.rows.find(x => x.id === progB.id);
  assert.equal(p2.fingerprint, K.fingerprintOf(fresh)); assert.equal(p2.keys.length, 2);
  assert.deepEqual(p2.keys.map(k => [k.current, !!k.compromised_at, k.fingerprint]), [[true, false, K.fingerprintOf(fresh)], [false, true, samples[1].fingerprint]]);
  assert.deepEqual(p2.periods, [], 'files a compromised key signed do not count');
  const c2 = (await bearer('GET', `/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}`, rt.token)).data;
  assert.equal(c2.programmes.find(x => x.id === progB.id).status, 'none');
  const sB = (await bearer('GET', '/api/county-connect/v1/status', tB.token)).data;
  assert.equal(sB.expected.find(x => x.from === Q1.from).received, false);
  assert.ok(sB.received.length && sB.received.every(x => x.status === 'key_compromised'), JSON.stringify(sB.received));
  const retired = await bearer('POST', '/api/county-connect/v1/submissions', tB.token, JSON.stringify(samples[1].files[1].file));
  assert.equal(retired.status, 422); assert.equal(retired.data.reason, 'retired_key');
  // A's withdrawn file stops counting the same way.
  const tA = ok(await issue(admin, { scope: 'county.submit', programme_id: progA.id }));
  const aQ2 = H.db.one(`SELECT id FROM county_submissions WHERE programme_id=? AND period_from=? AND superseded_by IS NULL AND withdrawn_at IS NULL`, progA.id, Q2.from);
  ok(await admin.post(`/api/county/submissions/${aQ2.id}/withdraw`, { reason: 'Sent in error' }), 200);
  const sA = (await bearer('GET', '/api/county-connect/v1/status', tA.token)).data;
  assert.equal(sA.expected.find(x => x.from === Q2.from).received, false);
  assert.equal(sA.received.find(x => x.from === Q2.from && x.status === 'withdrawn').from, Q2.from);
  ok(await admin.post(`/api/county/submissions/${aQ2.id}/reinstate`, {}), 200);
  assert.equal((await bearer('GET', '/api/county-connect/v1/status', tA.token)).data.expected.find(x => x.from === Q2.from).received, true);
});

// ---------------------------------------------------------------- the programme's side
test('the connection: who may see and save it; the address checked; the token encrypted and never returned', async () => {
  const tok = ok(await issue(admin, { scope: 'county.submit', programme_id: own.id }));
  assert.equal((await nav.get('/api/county-connect/connection')).status, 403);
  const empty = ok(await fin.get('/api/county-connect/connection'), 200);
  assert.equal(empty.connected, false); assert.equal(empty.can_configure, false); assert.equal(empty.can_send, true);
  assert.equal((await fin.put('/api/county-connect/connection', { base_url: 'https://county.example.org', token: tok.token })).status, 403, 'saving it is settings:manage');
  for (const bad of ['http://county.example.org', 'ftp://county.example.org', 'https://user:pw@county.example.org', 'https://10.1.2.3', 'https://192.168.1.10', 'https://169.254.169.254', 'https://county.internal', 'https://county.example.org/?x=1', 'not a url']) {
    const r = await admin.put('/api/county-connect/connection', { base_url: bad, token: tok.token });
    assert.equal(r.status, 400, bad); assert.ok(r.data.fields.base_url, bad);
  }
  assert.equal((await admin.put('/api/county-connect/connection', { base_url: 'https://county.example.org' })).status, 400, 'a token the first time');
  assert.equal((await admin.put('/api/county-connect/connection', { base_url: 'https://county.example.org', token: 'sudscr_' + 'a'.repeat(43) })).status, 400, 'a read token is not a connection token');
  const saved = ok(await admin.put('/api/county-connect/connection', { base_url: 'https://county.example.org/suds/', token: tok.token }), 200);
  assert.equal(saved.base_url, 'https://county.example.org/suds'); assert.equal(saved.token_hint, tok.token.slice(0, 12)); assert.equal(saved.auto_send, false);
  const got = await admin.get('/api/county-connect/connection');
  assert.ok(!JSON.stringify(got.data).includes(tok.token), 'the token is never returned');
  const row = H.db.one(`SELECT * FROM county_connection`);
  assert.ok(!row.token_enc.includes(tok.token) && require('../server/crypto').decrypt(row.token_enc) === tok.token, 'encrypted at rest');
  const a = lastAudit('county_connect.connection.save'); assert.equal(a.details.host, 'county.example.org'); assert.ok(!JSON.stringify(a.details).includes(tok.token));
  // In production: plain http and this machine are refused, unless a county on a private network is allowed.
  const prod = config.isProd;
  try {
    config.isProd = true;
    for (const bad of ['http://127.0.0.1:9999', 'https://127.0.0.1:9999', 'https://localhost']) assert.throws(() => CL.checkBaseUrl(bad), CL.ConnectError, bad);
    process.env.SUDS_COUNTY_ALLOW_PRIVATE = '1';
    assert.equal(CL.checkBaseUrl('https://10.20.30.40:8443/'), 'https://10.20.30.40:8443');
    assert.throws(() => CL.checkBaseUrl('http://10.20.30.40'), /https/, 'still https');
  } finally { config.isProd = prod; delete process.env.SUDS_COUNTY_ALLOW_PRIVATE; }
  assert.equal(CL.checkBaseUrl('http://127.0.0.1:9999'), 'http://127.0.0.1:9999', 'outside production, this machine over http (development and tests)');
  ok(await admin.del('/api/county-connect/connection'), 200);
  assert.equal(lastAudit('county_connect.connection.remove').details.had, true);
  assert.equal((await admin.get('/api/county-connect/connection')).data.connected, false);
});

test('outbound: a public name that resolves to a private address is refused at the call; a redirect is never followed', async () => {
  const tok = ok(await issue(admin, { scope: 'county.submit', programme_id: own.id }));
  ok(await admin.put('/api/county-connect/connection', { base_url: 'https://county.example.org', token: tok.token }), 200);
  const seen = [];
  try {
    outbound._setLookupForTests(async (h) => (h === 'county.example.org' ? [{ address: '10.0.0.7' }] : [{ address: '93.184.216.34' }]));
    outbound._setFetchForTests(async (url, opts) => { seen.push([url, opts.redirect]); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); });
    const r = ok(await admin.post('/api/county-connect/connection/test', {}), 200);
    assert.equal(r.ok, false); assert.equal(r.reason, 'refused_address'); assert.deepEqual(seen, [], 'nothing was sent');
    // A public address: through the shared guard, redirect: 'error', and the token only to that host.
    outbound._setLookupForTests(async () => [{ address: '93.184.216.34' }]);
    const status = { county: { code: null, name: 'Test County' }, programme: { id: own.id, name: 'x', active: true }, cadence: 'quarterly_calendar', expected: [], outstanding: [], received: [] };
    outbound._setFetchForTests(async (url, opts) => { seen.push([url, opts.redirect, opts.headers.Authorization]); return new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } }); });
    const g = ok(await fin.post('/api/county-connect/connection/test', {}), 200);
    assert.equal(g.ok, true, JSON.stringify(g)); assert.equal(g.connection.county_name, 'Test County');
    assert.deepEqual(seen, [['https://county.example.org/api/county-connect/v1/status', 'error', `Bearer ${tok.token}`]]);
    assert.ok(!JSON.stringify(g).includes(tok.token));
    // A 307 on the public path is not followed.
    seen.length = 0;
    outbound._setFetchForTests(async (url) => { seen.push(url); return new Response('', { status: 307, headers: { location: 'https://elsewhere.example.net/steal' } }); });
    const red = ok(await admin.post('/api/county-connect/connection/test', {}), 200);
    assert.equal(red.ok, false); assert.equal(red.reason, 'redirect'); assert.deepEqual(seen, ['https://county.example.org/api/county-connect/v1/status']);
    // An answer larger than 64 KB is not read.
    outbound._setFetchForTests(async () => new Response('x'.repeat(CL.MAX_ANSWER_BYTES + 10), { status: 200, headers: { 'content-type': 'application/json' } }));
    assert.equal((await admin.post('/api/county-connect/connection/test', {})).data.ok, false);
  } finally { outbound._setFetchForTests(null); outbound._setLookupForTests(null); }
  assert.ok(lastAudit('county_connect.connection.test'));
  assert.equal((await nav.post('/api/county-connect/connection/test', {})).status, 403);
});

/** A stand-in for a county server on this machine: `answer(req, res)` decides what it says. */
async function fakeCounty(answer) {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); answer(req, res); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r); }) };
}

test('outbound over this machine: a 307 from the county is not followed, and a county that does not answer times out', async () => {
  const tok = ok(await issue(admin, { scope: 'county.submit', programme_id: own.id }));
  const target = await fakeCounty((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const redirecting = await fakeCounty((req, res) => { res.writeHead(307, { location: `${target.url}${req.url}` }); res.end(); });
  try {
    ok(await admin.put('/api/county-connect/connection', { base_url: redirecting.url, token: tok.token }), 200);
    const r = ok(await admin.post('/api/county-connect/connection/test', {}), 200);
    assert.equal(r.ok, false); assert.equal(r.reason, 'redirect'); assert.match(r.error, /redirect/);
    assert.equal(redirecting.hits.length, 1); assert.equal(target.hits.length, 0, 'the redirect was not followed');
    // Send asks the county for its county code first (the file must name it): refused at that step, and never followed.
    const s = await fin.post('/api/county-connect/send', { ...Q2, funds: [fund] });
    assert.equal(s.status, 400); assert.match(s.data.error, /county code.*redirect/s); assert.equal(target.hits.length, 0);
  } finally { await redirecting.close(); await target.close(); }
  // A county whose status names no county code: nothing is sent, and the programme is told why.
  const noCode = await fakeCounty((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ county: { code: null, name: 'Old County' }, programme: { id: own.id, name: 'x', active: true }, cadence: 'quarterly_calendar', expected: [], outstanding: [], received: [] }));
  });
  try {
    ok(await admin.put('/api/county-connect/connection', { base_url: noCode.url }), 200);
    const s = await fin.post('/api/county-connect/send', { ...Q2, funds: [fund] });
    assert.equal(s.status, 400); assert.match(s.data.error, /did not say its county code/);
    assert.ok(noCode.hits.every(h => h === '/api/county-connect/v1/status'), 'no file was posted');
  } finally { await noCode.close(); }
  const silent = await fakeCounty(() => { /* never answers */ });
  CL._setTimeoutForTests(300);
  try {
    ok(await admin.put('/api/county-connect/connection', { base_url: silent.url }), 200);
    const r = ok(await admin.post('/api/county-connect/connection/test', {}), 200);
    assert.equal(r.ok, false); assert.equal(r.reason, 'timeout');
    assert.equal(r.connection.last_check_ok, false);
  } finally { CL._setTimeoutForTests(null); await silent.close(); }
});

// ---------------------------------------------------------------- end to end
test('end to end: this programme\'s server sends its real signed file to the county\'s over HTTP, and it shows in the combined view', async () => {
  // The county: a second listener on another port over the same app (one database plays both, as in county.test.js).
  const county = http.createServer(require('../server/app').createHandler());
  await new Promise(r => county.listen(0, '127.0.0.1', r));
  const countyUrl = `http://127.0.0.1:${county.address().port}`;
  try {
    const tok = ok(await issue(admin, { scope: 'county.submit', programme_id: own.id }));
    ok(await admin.put('/api/county-connect/connection', { base_url: countyUrl, token: tok.token }), 200);
    // Test connection: the county's expected periods.
    const t = ok(await fin.post('/api/county-connect/connection/test', {}), 200);
    assert.equal(t.ok, true, JSON.stringify(t)); assert.equal(t.status.programme.id, own.id);
    assert.ok(t.status.outstanding.some(p => p.from === Q2.from && p.to === Q2.to), 'Q2 is outstanding');
    // Only whoever may make the county file may send it.
    assert.equal((await nav.post('/api/county-connect/send', Q2)).status, 403);
    assert.equal((await fin.post('/api/county-connect/send', { from: Q2.from, to: '2099-01-01' })).status, 400, 'a period that has not ended');
    assert.equal(t.status.county.code, COUNTY.county_code);
    // The funds that go in: settlement funds only (as the file route checks); none chosen and none remembered for
    // this county is refused, never "every fund".
    assert.equal((await fin.post('/api/county-connect/send', { ...Q2, funds: [fund, 'not-a-fund'] })).status, 400, 'a fund that is not a settlement fund here');
    const none = await fin.post('/api/county-connect/send', Q2);
    assert.equal(none.status, 400); assert.match(none.data.error, /settlement funds this county pays for/);
    // The Send to the county card's choices: a county code that is not the connected county's is refused.
    const wrong = await fin.post('/api/county-connect/send', { ...Q2, funds: [fund], county_code: 'SAMP-1E00', county_name: 'Elsewhere' });
    assert.equal(wrong.status, 400); assert.match(wrong.data.error, /not the code of the county this server is connected to/);
    const card = { county_code: K.formatCode(COUNTY.county_code).toLowerCase(), county_name: 'Connected Test County' };
    const s = ok(await fin.post('/api/county-connect/send', { ...Q2, funds: [fund], ...card }), 200);
    assert.equal(s.status, 'imported', JSON.stringify(s));
    // The same file the card's download makes for the same choices (the same payload but for generated_at).
    const dl = await fin.get(`/api/county-submission/file?from=${Q2.from}&to=${Q2.to}&county_code=${card.county_code}&county_name=${encodeURIComponent(card.county_name)}&funds=${fund}`);
    assert.equal(dl.status, 200, JSON.stringify(dl.data));
    const dlFile = typeof dl.data === 'string' ? JSON.parse(dl.data) : dl.data;
    const sent = H.db.one(`SELECT * FROM county_submissions WHERE sha256=?`, s.receipt.sha256);
    assert.ok(sent, 'the county has it'); assert.equal(sent.programme_id, own.id);
    const sentPayload = JSON.parse(require('../server/crypto').decrypt(sent.payload_enc));
    assert.deepEqual(sentPayload.recipient, COUNTY);
    assert.deepEqual({ ...sentPayload, generated_at: null }, { ...dlFile.payload, generated_at: null });
    // Both remember the county's name and funds for the card (county_submission_recipients), keyed by its code.
    assert.deepEqual(JSON.parse(H.db.getSetting('county_submission_recipients'))[COUNTY.county_code].fund_ids, [fund]);
    assert.equal(s.send.status, 'imported'); assert.equal(s.send.sha256, s.receipt.sha256); assert.equal(s.send.automatic, false);
    const audit = lastAudit('county_submission.send');
    assert.equal(audit.details.status, 'imported'); assert.equal(audit.details.leaves_programme, true); assert.equal(audit.details.sha256, s.receipt.sha256);
    assert.equal(audit.details.county_code, COUNTY.county_code);
    assert.ok(!/naloxone|values|777/.test(JSON.stringify(audit.details)), 'no figures in the audit');
    // The county's combined view counts it.
    const rt = ok(await issue(admin, { scope: 'county.read', name: 'E2E' }));
    const comb = (await bearer('GET', `/api/county-connect/v1/combined?from=${Q2.from}&to=${Q2.to}`, rt.token, undefined, { to: countyUrl })).data;
    const col = comb.programmes.find(p => p.id === own.id);
    assert.equal(col.status, 'whole');
    assert.equal(comb.rows.find(x => x.key === 'spend_approved').by[own.id], 777.25);
    // The send log, and sending again (the remembered funds, the county's own name) is a duplicate or a newer file.
    const again = ok(await fin.post('/api/county-connect/send', Q2), 200);
    assert.ok(['duplicate', 'superseded'].includes(again.status), again.status);
    const log = ok(await fin.get('/api/county-connect/connection'), 200).sends;
    assert.ok(log.length >= 2); assert.ok(log.every(x => !('figures' in x) && x.period_from && x.status));
    // Test connection now shows Q2 received.
    const t2 = ok(await fin.post('/api/county-connect/connection/test', {}), 200);
    assert.ok(t2.status.expected.find(p => p.from === Q2.from).received);
    // Automatic sending (off by default): switched on, it sends what is outstanding and says so in the log and audit.
    assert.equal(await CL.autoSendIfDue({ force: true }), null, 'off: nothing');
    ok(await admin.put('/api/county-connect/connection', { auto_send: true }), 200);
    const auto = await CL.autoSendIfDue({ force: true });
    assert.ok(auto && Array.isArray(auto.sent), JSON.stringify(auto));
    assert.ok(auto.sent.every(x => x.status === 'imported' && x.send.automatic), JSON.stringify(auto.sent.map(x => [x.from, x.status, x.reason])));
    assert.ok(lastAudit('county_submission.auto'));
    assert.equal((await CL.autoSendIfDue()), null, 'not again the same day');
    ok(await admin.put('/api/county-connect/connection', { auto_send: false }), 200);
  } finally { await new Promise(r => { county.closeAllConnections(); county.close(r); }); }
});

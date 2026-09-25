'use strict';
// FHIR API hardening (docs/integration/FHIR.md): SMART Backend Services client authentication
// (private_key_jwt), the client secret working only at the token endpoint, aliases that cannot widen a FHIR
// client to most TPO consents, bulk export checked and accounted when it is downloaded rather than when it is
// built, and export job state that survives a restart.
// A data directory of its own: the restart test runs the startup restore over <data dir>/fhir-export, which
// must not see the exports other test files are building at the same time in the shared ./data.
const os = require('node:os');
process.env.SUDS_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(os.tmpdir(), 'suds-fhir-hardening-'));
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const H = require('./helpers');
const { encrypt, decrypt } = require('../server/crypto');
const config = require('../server/config');

const RECIPIENT = 'County Behavioral Health';
let base, admin, nav, adminId, tokenUrl;
const ids = {};

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
/** A signed client assertion (compact JWS). `claims` override the SMART defaults for client `id`. */
function assertion(id, key, { alg = 'RS384', kid = 'k1', claims = {}, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg, typ: 'JWT', ...(kid ? { kid } : {}), ...header };
  const c = { iss: id, sub: id, aud: tokenUrl, exp: now + 240, jti: nodeCrypto.randomUUID(), ...claims };
  const input = `${b64u(h)}.${b64u(c)}`;
  let sig;
  if (alg === 'RS384') sig = nodeCrypto.sign('sha384', Buffer.from(input), key);
  else if (alg === 'ES384') sig = nodeCrypto.sign('sha384', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'HS384') sig = nodeCrypto.createHmac('sha384', key).update(input).digest();
  else sig = Buffer.alloc(0);
  return `${input}.${sig.toString('base64url')}`;
}
const pubJwk = (kp, kid, extra = {}) => ({ ...kp.publicKey.export({ format: 'jwk' }), kid, ...extra });
async function tokenPost(body, headers = {}) {
  // This file asks for far more tokens than the per-address limit (30 a minute) allows one caller.
  const { rateLimitReset } = require('../server/app');
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) rateLimitReset(`fhirtoken:${ip}`);
  const r = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
  return { status: r.status, data: await r.json() };
}
const jwtBody = (a, extra = {}) => ({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: a, ...extra });
async function fhirGet(p, token, extra = {}) {
  const res = await fetch(base + p, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json', ...extra } });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: ct.includes('json') && !ct.includes('ndjson') && text ? JSON.parse(text) : text };
}
async function secretToken(c) {
  const r = await tokenPost({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.key });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.access_token;
}
const lastDenied = () => JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='fhir.token.denied' ORDER BY rowid DESC LIMIT 1`).details || '{}');
const patch = (c, p, body) => c.req('PATCH', p, body);

async function newClient(first, last) {
  const r = await admin.post('/api/clients', { first_name: first, last_name: last, dob: '1990-01-01', status: 'active', confirm_duplicate: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
function consent(clientId, { type = 'part2_disclosure', recipient = RECIPIENT, purpose = 'Treatment' } = {}) {
  const id = nodeCrypto.randomUUID();
  H.db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,signed_on_paper,redisclosure_notice_given,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, clientId, type, encrypt(recipient), encrypt(purpose), encrypt('Navigation record'), '2026-01-10', '2030-01-01', 1, 1, adminId);
  return id;
}

const rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa2 = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });

before(async () => {
  base = await H.start();
  tokenUrl = `${base}/fhir/R4/auth/token`;
  H.makeUser('hnav', 'navigator');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('hnav', 'StaffPassw0rd!x');
  adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  await admin.post('/api/resources', { name: 'Kaiser', category: 'other', organization: 'Kaiser' });
  ids.a = await newClient('Ann', 'Covered'); ids.aConsent = consent(ids.a);
  ids.b = await newClient('Bo', 'Covered'); ids.bConsent = consent(ids.b);
  // A TPO consent whose class wording names no organisation: a one-word alias like "health" matched it.
  ids.tpoClass = await newClient('Cal', 'Classonly'); consent(ids.tpoClass, { type: 'part2_tpo', recipient: 'My treating providers and health plans in the county', purpose: 'Treatment, payment and health care operations' });
});
after(async () => {
  const bulk = require('../server/fhir/bulk');
  for (const id of bulk._jobs.keys()) fs.rmSync(path.join(config.dataDir, 'fhir-export', id), { recursive: true, force: true });
  await H.stop();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------
test('discovery advertises private_key_jwt with RS384 and ES384', async () => {
  const smart = await (await fetch(base + '/fhir/R4/.well-known/smart-configuration')).json();
  assert.ok(smart.token_endpoint_auth_methods_supported.includes('private_key_jwt'));
  assert.deepEqual(smart.token_endpoint_auth_signing_alg_values_supported.sort(), ['ES384', 'RS384']);
  assert.ok(smart.capabilities.includes('client-confidential-asymmetric'));
  const cs = await (await fetch(base + '/fhir/R4/metadata')).json();
  assert.equal(cs.rest[0].security.service[0].coding[0].code, 'SMART-on-FHIR');
});

test('registering keys: public RSA or EC P-384 only, never private key material; admins only', async () => {
  const mk = (extra) => admin.post('/api/admin/fhir-clients', { name: 'K', recipient: 'Regional HIE', scopes: ['system/Patient.read'], ...extra });
  const priv = { ...rsa.privateKey.export({ format: 'jwk' }), kid: 'p' };
  let r = await mk({ jwks: { keys: [priv] } });
  assert.equal(r.status, 400); assert.match(r.data.fields.jwks, /private key material/);
  r = await mk({ jwks: { keys: [{ kty: 'oct', k: 'c2VjcmV0', kid: 'h' }] } });
  assert.equal(r.status, 400, 'a symmetric key is refused');
  const p256 = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  r = await mk({ jwks: { keys: [pubJwk(p256, 'p256')] } });
  assert.equal(r.status, 400, 'only P-384 for ES384');
  const small = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  r = await mk({ jwks: { keys: [pubJwk(small, 'small')] } });
  assert.equal(r.status, 400); assert.match(r.data.fields.jwks, /2048/);
  r = await mk({ jwks: 'not json' });
  assert.equal(r.status, 400);
  r = await mk({ jwks_url: 'http://keys.example.org/jwks.json' });
  assert.equal(r.status, 400, 'https only'); assert.match(r.data.fields.jwks_url, /https/);
  r = await mk({ jwks_url: 'https://127.0.0.1/jwks.json' });
  assert.equal(r.status, 400, 'never this machine or the county network');
  r = await mk({ jwt_only: true });
  assert.equal(r.status, 400, 'JWT-only needs a key'); assert.ok(r.data.fields.jwt_only);
  assert.equal((await nav.post('/api/admin/fhir-clients', { name: 'K', recipient: 'Regional HIE', scopes: ['system/Patient.read'], jwks: { keys: [pubJwk(rsa, 'k1')] } })).status, 403);
  // JWT-only: no secret is ever shown.
  r = await mk({ jwks: JSON.stringify({ keys: [pubJwk(rsa, 'k1'), pubJwk(ec, 'e1')] }), jwt_only: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.key, null); assert.equal(r.data.jwt_only, true);
  const row = (await admin.get('/api/admin/fhir-clients')).data.clients.find(c => c.id === r.data.id);
  assert.deepEqual(row.auth.jwks_keys.map(k => k.kid), ['k1', 'e1']);
  assert.equal(row.auth.client_secret, false); assert.equal(row.auth.private_key_jwt, true);
  assert.ok(!JSON.stringify(row).includes(rsa.privateKey.export({ format: 'jwk' }).d), 'no private parts anywhere');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir_client.create' AND entity_id=? AND details LIKE '%"jwt_only":true%'`, r.data.id));
});

test('private_key_jwt: RS384 and ES384 assertions get a token; every SMART claim rule is enforced', async () => {
  const c = (await admin.post('/api/admin/fhir-clients', { name: 'EHR (JWT)', recipient: RECIPIENT, scopes: ['system/Patient.read'], jwks: { keys: [pubJwk(rsa, 'k1'), pubJwk(ec, 'e1')] }, jwt_only: true })).data;
  // RS384, client_id given in the body.
  let r = await tokenPost(jwtBody(assertion(c.id, rsa.privateKey), { client_id: c.id }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.token_type, 'bearer'); assert.equal(r.data.scope, 'system/Patient.read');
  assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.a}`, r.data.access_token)).status, 200, 'the token reads data');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.token.issued' AND entity_id=? AND details LIKE '%private_key_jwt%'`, c.id));
  // ES384, client_id taken from iss.
  r = await tokenPost(jwtBody(assertion(c.id, ec.privateKey, { alg: 'ES384', kid: 'e1' })));
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const refused = async (a, why, extra) => {
    const x = await tokenPost(jwtBody(a, extra));
    assert.equal(x.status, 401, `${why}: ${JSON.stringify(x.data)}`);
    assert.equal(x.data.error, 'invalid_client', why);
    return lastDenied().reason;
  };
  // Replay: the same assertion twice.
  const once = assertion(c.id, rsa.privateKey);
  assert.equal((await tokenPost(jwtBody(once))).status, 200);
  assert.match(await refused(once, 'replayed jti'), /already been used/);
  assert.ok(H.db.one(`SELECT COUNT(*) n FROM fhir_jwt_assertions WHERE api_key_id=?`, c.id).n >= 3, 'used jtis are kept in the database (a restart does not reopen them)');
  assert.match(await refused(assertion(c.id, rsa.privateKey, { claims: { aud: `${base}/fhir/R4` } }), 'aud is not the token URL'), /aud/);
  assert.match(await refused(assertion(c.id, rsa.privateKey, { claims: { exp: Math.floor(Date.now() / 1000) + 3600 } }), 'exp an hour away'), /five minutes/);
  assert.match(await refused(assertion(c.id, rsa.privateKey, { claims: { exp: Math.floor(Date.now() / 1000) - 600 } }), 'expired'), /expired/);
  assert.match(await refused(assertion(c.id, rsa.privateKey, { claims: { exp: undefined } }), 'no exp'), /exp/);
  assert.match(await refused(assertion(c.id, rsa.privateKey, { claims: { sub: 'someone-else' } }), 'sub differs'), /iss and sub/);
  assert.match(await refused(assertion(c.id, rsa.privateKey, { claims: { jti: undefined } }), 'no jti'), /jti/);
  assert.match(await refused(assertion(c.id, rsa2.privateKey), 'signed by an unregistered key'), /signature/);
  assert.match(await refused(assertion(c.id, rsa.privateKey, { kid: 'nope' }), 'unknown kid'), /No registered key/);
  // alg confusion: HMAC "signed" with the public key's bytes, and alg none.
  assert.match(await refused(assertion(c.id, JSON.stringify(pubJwk(rsa, 'k1')), { alg: 'HS384' }), 'HS384'), /not accepted/);
  assert.match(await refused(assertion(c.id, null, { alg: 'none' }), 'alg none', { client_id: c.id }), /not accepted/);
  assert.match(await refused(assertion(c.id, null, { alg: 'none' }), 'alg none, client from iss'), /not accepted/);
  assert.match(await refused(assertion(c.id, rsa.privateKey, { header: { jku: 'https://evil.example/jwks' } }), 'a key URL inside the assertion'), /jku/);
  assert.match(await refused(assertion(c.id, rsa.privateKey, { alg: 'ES384', kid: 'k1' }), 'RSA key used for ES384'), /No registered key/);
  // An assertion for one client never authenticates another.
  const other = (await admin.post('/api/admin/fhir-clients', { name: 'Other', recipient: 'Regional HIE', scopes: ['system/Patient.read'], jwks: { keys: [pubJwk(rsa2, 'o1')] } })).data;
  await refused(assertion(c.id, rsa.privateKey), 'client_id and iss disagree', { client_id: other.id });
  // Wrong assertion type, and mixing methods.
  assert.equal((await tokenPost({ ...jwtBody(assertion(c.id, rsa.privateKey)), client_assertion_type: 'urn:other' })).status, 400);
  assert.equal((await tokenPost(jwtBody(assertion(c.id, rsa.privateKey), { client_secret: 'x' }))).status, 400);
  assert.ok(!H.db.all(`SELECT details FROM audit_log WHERE action LIKE 'fhir.token.%'`).some(r => /eyJ/.test(r.details || '')), 'no assertion is written to the audit log');
});

test('JWT-only refuses the secret; a secret client can add keys and switch to JWT-only (PATCH)', async () => {
  const c = (await admin.post('/api/admin/fhir-clients', { name: 'Migrating EHR', recipient: RECIPIENT, scopes: ['system/Patient.read'] })).data;
  assert.equal((await tokenPost({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.key })).status, 200, 'the secret works at the token endpoint');
  assert.equal((await tokenPost(jwtBody(assertion(c.id, rsa.privateKey)))).status, 401, 'no key registered yet');
  assert.match(lastDenied().reason, /no public key/);
  assert.equal((await patch(nav, `/api/admin/fhir-clients/${c.id}`, { jwks: { keys: [pubJwk(rsa, 'k1')] } })).status, 403, 'administrators only');
  let r = await patch(admin, `/api/admin/fhir-clients/${c.id}`, { jwks: { keys: [pubJwk(rsa, 'k1')] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.auth.private_key_jwt, true); assert.equal(r.data.auth.client_secret, true);
  assert.equal((await tokenPost(jwtBody(assertion(c.id, rsa.privateKey)))).status, 200, 'both methods work during the move');
  assert.equal((await tokenPost({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.key })).status, 200);
  r = await patch(admin, `/api/admin/fhir-clients/${c.id}`, { jwt_only: true });
  assert.equal(r.status, 200); assert.equal(r.data.auth.jwt_only, true);
  const s = await tokenPost({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.key });
  assert.equal(s.status, 401, 'a JWT-only client cannot use its secret');
  assert.match(lastDenied().reason, /signed JWT/);
  assert.equal((await tokenPost(jwtBody(assertion(c.id, rsa.privateKey)))).status, 200);
  assert.equal((await patch(admin, `/api/admin/fhir-clients/${c.id}`, { jwks: null, jwks_url: null })).status, 400, 'a JWT-only client cannot drop its last key');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir_client.update' AND entity_id=?`, c.id));
  assert.equal((await patch(admin, `/api/admin/fhir-clients/${nodeCrypto.randomUUID()}`, { jwt_only: false })).status, 404);
});

test('a JWKS URL is fetched through the SSRF guard, cached, and refetched when the client rotates keys', async () => {
  const pics = require('../server/region-pictures');
  const J = require('../server/fhir/jwt');
  let served = { keys: [pubJwk(rsa, 'u1')] }; let fetches = 0;
  pics._setFetchForTests(async (url) => { fetches++; assert.equal(url, 'https://keys.example.org/jwks.json'); const body = JSON.stringify(served); return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }); });
  try {
    const c = (await admin.post('/api/admin/fhir-clients', { name: 'URL client', recipient: RECIPIENT, scopes: ['system/Patient.read'], jwks_url: 'https://keys.example.org/jwks.json', jwt_only: true })).data;
    assert.equal((await tokenPost(jwtBody(assertion(c.id, rsa.privateKey, { kid: 'u1' })))).status, 200);
    assert.equal((await tokenPost(jwtBody(assertion(c.id, rsa.privateKey, { kid: 'u1' })))).status, 200);
    assert.equal(fetches, 1, 'the key set is cached');
    // The client rotates to a new key: an unknown kid refetches the set.
    served = { keys: [pubJwk(rsa2, 'u2')] };
    J._jwksCache.get('https://keys.example.org/jwks.json').tried = 0;
    assert.equal((await tokenPost(jwtBody(assertion(c.id, rsa2.privateKey, { kid: 'u2' })))).status, 200, JSON.stringify(lastDenied()));
    assert.equal(fetches, 2);
    // A key set that contains a private key is refused, like one pasted in.
    served = { keys: [{ ...rsa.privateKey.export({ format: 'jwk' }), kid: 'bad' }] };
    J._jwksCache.clear();
    assert.equal((await tokenPost(jwtBody(assertion(c.id, rsa.privateKey, { kid: 'bad' })))).status, 401);
  } finally { pics._setFetchForTests(null); }
});

// ---------------------------------------------------------------------------------------------------------
test('aliases: generic or one-word aliases are refused, directory names allowed, legacy ones ignored', async () => {
  const mk = (aliases) => admin.post('/api/admin/fhir-clients', { name: 'Alias test', recipient: 'Sacramento County Behavioral Health', scopes: ['system/Patient.read'], aliases });
  for (const bad of ['county', 'Health', 'County Health', 'Department of Health Services', 'Behavioral Health Care Center', 'Sacramento County']) {
    const r = await mk(bad);
    assert.equal(r.status, 400, `"${bad}" is refused`);
    assert.ok(r.data.fields && r.data.fields.aliases, `"${bad}" is reported on the aliases field`);
  }
  for (const good of ['Sacramento County Behavioral Health Services', 'Regional Health Information Exchange', 'Kaiser', 'Sacramento County Department of Health Services', 'Riverbend Wellspring']) {
    const r = await mk(good);
    assert.equal(r.status, 201, `"${good}" is allowed: ${JSON.stringify(r.data)}`);
  }
  // A registration saved before the rule, with "health" as an alias, covered a TPO consent that names no
  // organisation ("... health plans in the county"). The alias is now ignored and listed as such.
  const legacy = (await admin.post('/api/admin/fhir-clients', { name: 'Legacy', recipient: 'Legacy Org Name', scopes: ['system/Patient.read'] })).data;
  const reg = JSON.parse(H.db.getSetting(`fhir_client:${legacy.id}`));
  H.db.setSetting(`fhir_client:${legacy.id}`, JSON.stringify({ ...reg, aliases: ['health', 'county'] }));
  const tok = await secretToken(legacy);
  assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.tpoClass}`, tok)).status, 404, 'a one-word alias no longer matches a class wording');
  const row = (await admin.get('/api/admin/fhir-clients')).data.clients.find(c => c.id === legacy.id);
  assert.deepEqual(row.aliases_ignored.map(a => a.alias), ['health', 'county']);
  // The same rule applies when aliases are edited.
  assert.equal((await patch(admin, `/api/admin/fhir-clients/${legacy.id}`, { aliases: 'services' })).status, 400);
  assert.equal((await patch(admin, `/api/admin/fhir-clients/${legacy.id}`, { aliases: 'Legacy Organisation Formerly Known' })).status, 200);
  assert.deepEqual((await admin.get('/api/admin/fhir-clients')).data.clients.find(c => c.id === legacy.id).aliases_ignored, []);
});

test('alias preview: counts of clients each name would cover, never who; admins only; audited', async () => {
  assert.equal((await nav.post('/api/admin/fhir-clients/alias-preview', { recipient: RECIPIENT, aliases: 'county' })).status, 403);
  const r = await admin.post('/api/admin/fhir-clients/alias-preview', { recipient: RECIPIENT, aliases: 'health\nRegional Health Information Exchange', purpose: 'TREAT' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.recipient.clients, 2, 'the two clients whose consent names the recipient');
  const [health, rhie] = r.data.aliases;
  assert.equal(health.ok, false); assert.match(health.problem, /generic/);
  assert.equal(health.clients, 1, 'the preview shows what the too-broad alias would have matched');
  assert.equal(rhie.ok, true); assert.equal(rhie.clients, 0);
  assert.equal(r.data.total, 2, 'the total counts only the aliases that would be saved');
  const text = JSON.stringify(r.data);
  for (const id of [ids.a, ids.b, ids.tpoClass]) assert.ok(!text.includes(id), 'no client ids');
  assert.ok(!/Ann|Covered|Classonly/.test(text), 'no names');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='fhir_client.alias_preview' ORDER BY rowid DESC LIMIT 1`);
  assert.ok(a && !/health|Regional/i.test(a.details), 'audited, with counts and not the names typed');
});

// ---------------------------------------------------------------------------------------------------------
async function exportJob(token, q = '_type=Patient') {
  const k = await fhirGet(`/fhir/R4/$export?${q}`, token, { Prefer: 'respond-async' });
  assert.equal(k.status, 202);
  const loc = k.headers.get('content-location').replace(/^https?:\/\/[^/]+/, '');
  for (let i = 0; i < 200; i++) {
    const r = await fhirGet(loc, token);
    if (r.status !== 202) { assert.equal(r.status, 200, JSON.stringify(r.data)); return { id: loc.split('/').pop(), loc, manifest: r.data }; }
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error('export never finished');
}
const rel = (u) => u.replace(/^https?:\/\/[^/]+/, '');
const accounted = (jobId) => H.db.all(`SELECT client_id, consent_id, what_enc FROM disclosures WHERE source_ref=?`, `fhir-export:${jobId}`).map(r => ({ ...r, what: decrypt(r.what_enc) }));

test('bulk export: accounted at first download (not at build), once per file, under the consent live then', async () => {
  const c = (await admin.post('/api/admin/fhir-clients', { name: 'Bulk EHR', recipient: RECIPIENT, scopes: ['system/*.read'] })).data;
  const tok = await secretToken(c);
  const { id, manifest } = await exportJob(tok, '_type=Patient,Organization');
  assert.equal(accounted(id).length, 0, 'building the export discloses nothing yet');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.export.complete' AND entity_id=?`, id), 'the build is audited');
  assert.equal(manifest.extension['urn:suds:part2'].consent_checked_at, 'download');
  const patients = manifest.output.find(o => o.type === 'Patient');
  const org = manifest.output.find(o => o.type === 'Organization');
  assert.equal((await fhirGet(rel(org.url), tok)).status, 200);
  assert.equal(accounted(id).length, 0, 'the directory is not a disclosure');
  const f = await fhirGet(rel(patients.url), tok);
  assert.equal(f.status, 200);
  const rows = accounted(id);
  assert.deepEqual(rows.map(r => r.client_id).sort(), [ids.a, ids.b].sort(), 'one row per patient in the file');
  assert.match(rows[0].what, /Patient \(1\)/);
  assert.equal(rows.find(r => r.client_id === ids.a).consent_id, ids.aConsent);
  assert.equal((await fhirGet(rel(patients.url), tok)).status, 200, 'downloading again is allowed');
  assert.equal(accounted(id).length, 2, 'but not accounted twice');
});

test('bulk export: a consent revoked after the build stops the download of any file naming that patient', async () => {
  const c = (await admin.post('/api/admin/fhir-clients', { name: 'Bulk EHR 2', recipient: RECIPIENT, scopes: ['system/*.read'] })).data;
  const tok = await secretToken(c);
  const victim = await newClient('Vi', 'Revokes'); const cid = consent(victim);
  H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,outcome) VALUES(?,?,?,?,?,?)`, nodeCrypto.randomUUID(), ids.a, adminId, 'outreach', '2026-03-05T17:00:00.000Z', 'completed');
  const { id, manifest } = await exportJob(tok, '_type=Patient,Encounter');
  const patients = manifest.output.find(o => o.type === 'Patient');
  const encounters = manifest.output.find(o => o.type === 'Encounter');
  assert.equal(patients.count, 3);
  // Within the export's lifetime, the patient withdraws their consent.
  assert.equal((await admin.post(`/api/consents/${cid}/revoke`, { reason: 'Client withdrew' })).status, 200);
  const refused = await fhirGet(rel(patients.url), tok);
  assert.equal(refused.status, 410, 'the file naming them is not released');
  assert.equal(refused.data.resourceType, 'OperationOutcome');
  assert.match(refused.data.issue[0].diagnostics, /no longer covered.*start a new export/);
  assert.ok(!JSON.stringify(refused.data).includes(victim), 'without saying who');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.export.download.refused' AND entity_id=?`, id));
  assert.equal(accounted(id).length, 0, 'nothing refused is accounted');
  // A file that does not name them is still released (and accounted).
  assert.equal((await fhirGet(rel(encounters.url), tok)).status, 200);
  assert.deepEqual(accounted(id).map(r => r.client_id), [ids.a]);
  // A new export leaves them out.
  const again = await exportJob(tok, '_type=Patient');
  assert.equal(again.manifest.output.find(o => o.type === 'Patient').count, 2);
});

test('bulk export state survives a restart: finished jobs carry on, half-built and unreadable ones are removed', async () => {
  const bulk = require('../server/fhir/bulk');
  const c = (await admin.post('/api/admin/fhir-clients', { name: 'Bulk EHR 3', recipient: RECIPIENT, scopes: ['system/*.read'] })).data;
  const tok = await secretToken(c);
  const done = await exportJob(tok, '_type=Patient');
  const patients = done.manifest.output.find(o => o.type === 'Patient');
  assert.equal((await fhirGet(rel(patients.url), tok)).status, 200);
  assert.equal(accounted(done.id).length, 2);
  const root = path.join(config.dataDir, 'fhir-export');
  assert.ok(fs.readFileSync(path.join(root, done.id, 'job.json.enc'), 'utf8').startsWith('v1:'), 'the job state is encrypted at rest');
  assert.ok(!fs.readFileSync(path.join(root, done.id, 'job.json.enc'), 'utf8').includes(ids.a));
  // A job the "previous process" was still building, and a directory with no state at all.
  const building = { ...bulk._jobs.get(done.id), id: nodeCrypto.randomUUID(), status: 'in-progress', progress: 'exporting Patient', outputs: [], errors: [], expiresAt: null, downloaded: {} };
  fs.mkdirSync(path.join(root, building.id), { recursive: true });
  fs.writeFileSync(path.join(root, building.id, 'job.json.enc'), encrypt(JSON.stringify(building)));
  fs.writeFileSync(path.join(root, building.id, 'Patient.ndjson.enc'), encrypt('{"partial":true}\n'));
  const orphan = nodeCrypto.randomUUID();
  fs.mkdirSync(path.join(root, orphan), { recursive: true });
  fs.writeFileSync(path.join(root, orphan, 'Patient.ndjson.enc'), 'left behind');
  // Restart: the in-memory job table is gone; startup restores from disk.
  bulk._resetForTests();
  bulk.restore();
  assert.ok(!fs.existsSync(path.join(root, orphan)), 'a directory with no readable state is removed at startup');
  assert.ok(!fs.existsSync(path.join(root, building.id, 'Patient.ndjson.enc')), 'a half-built export loses its partial files');
  const st = await fhirGet(`/fhir/R4/$export-status/${building.id}`, tok);
  assert.equal(st.status, 500); assert.match(st.data.issue[0].diagnostics, /restarted/);
  const m = await fhirGet(done.loc, tok);
  assert.equal(m.status, 200, 'the finished export is still there after the restart');
  assert.equal((await fhirGet(rel(patients.url), tok)).status, 200, 'and its files can still be downloaded');
  assert.equal(accounted(done.id).length, 2, 'without accounting them a second time');
  // Deleting still removes everything.
  const del = await fetch(base + done.loc, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(del.status, 202);
  assert.ok(!fs.existsSync(path.join(root, done.id)));
});

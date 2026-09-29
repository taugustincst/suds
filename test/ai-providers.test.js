'use strict';
// The AI copilot's providers (server/ai-providers.js, docs/AI-COPILOT.md "Providers") and its cost estimate
// (server/ai-cost.js): AWS Signature Version 4 against AWS's published examples, the service account JWT, drafts
// sent to fake Amazon Bedrock and Google Vertex AI endpoints (the path, headers and body each expects), a redirect
// refused, the agreement tied to the provider it was recorded for, and the prices and spending limit in Settings.
// Every provider is a local fake HTTP server: no call ever leaves this machine.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const AP = require('../server/ai-providers');

const MODEL_JSON = (data, extra = {}) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 1000, output_tokens: 200 }, ...extra });
let fake, fakeUrl;
const calls = [];
let reply = null; // (req) => { status, json, headers }
let admin, sup, clin, clientId, tmp;
const ENV = ['SUDS_AI_PROVIDER', 'SUDS_AI_BASE_URL', 'ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS', 'SUDS_AI_VERTEX_PROJECT', 'SUDS_AI_VERTEX_REGION', 'SUDS_AI_TIMEOUT_MS'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const AWS_SECRET = 'bedrock-test-secret-key-do-not-log';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

function useBedrock() {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { SUDS_AI_PROVIDER: 'bedrock', SUDS_AI_BASE_URL: fakeUrl, AWS_ACCESS_KEY_ID: 'AKIATESTBEDROCK', AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_SESSION_TOKEN: 'session-token-test', AWS_REGION: 'us-west-2' });
}
function useVertex(keyFile) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { SUDS_AI_PROVIDER: 'vertex', SUDS_AI_BASE_URL: fakeUrl, GOOGLE_APPLICATION_CREDENTIALS: keyFile, SUDS_AI_VERTEX_PROJECT: 'county-health-123', SUDS_AI_VERTEX_REGION: 'us-east5' });
}
function useAnthropic() {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { SUDS_AI_BASE_URL: fakeUrl, ANTHROPIC_API_KEY: 'test-provider-key' });
}
function keyFile(name, extra = {}) {
  const f = path.join(tmp, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify({ type: 'service_account', project_id: 'county-health-123', private_key_id: `kid-${name}`, private_key: privateKey,
    client_email: `suds-copilot-${name}@county-health-123.iam.gserviceaccount.com`, token_uri: `${fakeUrl}/token`, ...extra }));
  return f;
}
const fresh = () => { for (const u of H.db.all(`SELECT id FROM users`)) require('../server/app').rateLimitReset(`ai:${u.id}`); };
const lastAudit = (action) => H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action);
async function attest(provider) {
  await admin.del('/api/ai/attestation');
  const a = await admin.post('/api/ai/attestation', { provider, signed_by: 'County counsel', agreement_date: '2026-01-15', reference: 'BAA-2026-042', baa: true, qsoa: true, counsel_reviewed: true });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const e = await admin.put('/api/ai/settings', { enabled: true, model: '' });
  assert.equal(e.status, 200, JSON.stringify(e.data));
}
const draft = (text = 'Client reported cravings this week and attended group.') => clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'narrative', source_text: text });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-ai-providers-'));
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch { body = null; }
      const call = { method: req.method, path: req.url, headers: req.headers, body, raw };
      calls.push(call);
      let r;
      if (req.url === '/elsewhere' || req.url.startsWith('/elsewhere')) r = { status: 200, json: MODEL_JSON({ narrative: 'redirected', gaps: [] }) };
      else if (reply) r = reply(call);
      if (!r && req.url === '/token') r = { status: 200, json: { access_token: 'ya29.test-access-token', expires_in: 3599, token_type: 'Bearer' } };
      if (!r) r = { status: 200, json: MODEL_JSON({ narrative: 'Client reported cravings and attended group.', gaps: [] }) };
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(r.raw !== undefined ? r.raw : JSON.stringify(r.json || {}));
    });
  });
  await new Promise(ok => fake.listen(0, '127.0.0.1', ok));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  useAnthropic();
  await H.start();
  H.makeUser('apclin', 'clinician'); H.makeUser('apsup', 'supervisor');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('apsup', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('apclin', 'StaffPassw0rd!x');
  const c = await clin.post('/api/clients', { first_name: 'Jordan', last_name: 'Reyes', dob: '1990-02-03', confirm_duplicate: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  clientId = c.data.id;
});
after(async () => {
  await H.stop(); await new Promise(ok => fake.close(ok));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- AWS Signature Version 4
// AWS's published Signature Version 4 examples: the aws-sig-v4-test-suite (get-vanilla, post-vanilla,
// get-vanilla-query-order-key-case) and the IAM ListUsers example of the "Create a signed AWS API request" guide.
const EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const EXAMPLE_TIME = new Date('2015-08-30T12:36:00Z');
test('SigV4: AWS\'s published test vectors', () => {
  const sign = (o) => AP.sigv4({ region: 'us-east-1', service: 'service', credentials: EXAMPLE, now: EXAMPLE_TIME, ...o });
  const get = sign({ method: 'GET', url: 'https://example.amazonaws.com/' });
  assert.equal(get.canonicalRequest, 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(get.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
  assert.equal(get.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', 'get-vanilla');
  assert.equal(get.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(get.headers.host, undefined, 'host is signed but left for fetch to send');
  assert.equal(sign({ method: 'POST', url: 'https://example.amazonaws.com/' }).signature, '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b', 'post-vanilla');
  assert.equal(sign({ method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' }).signature, 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500', 'get-vanilla-query-order-key-case');
  const iam = sign({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', service: 'iam', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } });
  assert.equal(crypto.createHash('sha256').update(iam.canonicalRequest).digest('hex'), 'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59', 'IAM example canonical request');
  assert.equal(iam.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7', 'IAM example signature');
});

test('SigV4: a session token is signed; the path is encoded again, as every service but S3 expects', () => {
  const s = AP.sigv4({ method: 'POST', url: 'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-x-v1%3A0/invoke', body: '{}', region: 'us-west-2', service: 'bedrock',
    credentials: { ...EXAMPLE, sessionToken: 'tok' }, now: EXAMPLE_TIME, headers: { 'content-type': 'application/json' } });
  assert.match(s.canonicalRequest, /^POST\n\/model\/us\.anthropic\.claude-x-v1%253A0\/invoke\n\n/);
  assert.match(s.headers.authorization, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/);
  assert.equal(s.headers['x-amz-security-token'], 'tok');
});

// ---------------------------------------------------------------- the service account JWT
test('JWT: RS256, verifiable with the service account\'s public key; the claims Google\'s token endpoint wants', () => {
  const sa = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey, private_key_id: 'abc123', token_uri: 'https://oauth2.googleapis.com/token' };
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);
  const jwt = AP.serviceAccountAssertion(sa, now);
  const [h, c, sig] = jwt.split('.');
  assert.ok(!/[+/=]/.test(jwt), 'base64url, unpadded');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: 'abc123' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: sa.token_uri, iat: now / 1000, exp: now / 1000 + 3600 });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')), 'the signature verifies');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  assert.ok(!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), other, Buffer.from(sig, 'base64url')), 'and not with another key');
  const t = AP.signJwt({ a: 1 }, privateKey);
  assert.deepEqual(JSON.parse(Buffer.from(t.split('.')[0], 'base64url')), { alg: 'RS256', typ: 'JWT' });
});

test('the request in each provider\'s form: Bedrock and Vertex take the version in the body and the model in the URL, and no fallbacks', () => {
  const AI = require('../server/ai-copilot');
  const { body, headers } = AI.buildRequest({ system: 's', user: 'u', schema: { type: 'object' } }, 'claude-opus-5-5');
  assert.equal(AP.adapt(body, headers, 'anthropic').body, body);
  for (const [p, version] of [['bedrock', 'bedrock-2023-05-31'], ['vertex', 'vertex-2023-10-16']]) {
    const a = AP.adapt(body, headers, p);
    assert.equal(a.body.anthropic_version, version); assert.equal(a.body.model, undefined); assert.equal(a.body.fallbacks, undefined);
    assert.equal(a.body.max_tokens, body.max_tokens); assert.deepEqual(a.body.output_config, body.output_config); assert.deepEqual(a.body.system, body.system);
    assert.deepEqual(a.headers, { 'content-type': 'application/json', accept: 'application/json' });
  }
  assert.ok(AP.isDefaultModel('anthropic.claude-opus-5-5') && AP.isDefaultModel('us.anthropic.claude-opus-5-5') && AP.isDefaultModel('claude-opus-5-5') && !AP.isDefaultModel('claude-sonnet-5-5'));
});

// ---------------------------------------------------------------- Amazon Bedrock, end to end
test('Bedrock: credentials from the environment, the region required, the model id checked for Bedrock', async () => {
  fresh(); useBedrock();
  const s = (await admin.get('/api/ai/settings')).data;
  assert.equal(s.provider.id, 'bedrock'); assert.equal(s.provider.label, 'Amazon Bedrock'); assert.equal(s.provider.region, 'us-west-2');
  assert.equal(s.default_model, 'anthropic.claude-opus-5-5'); assert.equal(s.key_configured, true);
  assert.ok(!JSON.stringify(s).includes(AWS_SECRET) && !JSON.stringify(s).includes('session-token-test'), 'no credential in the settings answer');
  const bad = await admin.put('/api/ai/settings', { model: 'claude-opus-5-5' });
  assert.equal(bad.status, 400); assert.match(bad.data.fields.model, /Bedrock/);
  delete process.env.AWS_SECRET_ACCESS_KEY;
  assert.equal((await admin.get('/api/ai/settings')).data.key_configured, false, 'no secret key: not configured');
  useBedrock(); delete process.env.AWS_REGION;
  assert.match((await admin.get('/api/ai/settings')).data.endpoint_problem, /AWS_REGION/);
});

test('Bedrock: a draft is InvokeModel, SigV4-signed; the answer is read as from the Claude API', async () => {
  fresh(); useBedrock();
  await attest('Amazon Web Services');
  assert.equal(JSON.parse(lastAudit('ai.attestation.record').details).configured_provider, 'bedrock');
  const n = calls.length;
  const r = await draft();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft.narrative, 'Client reported cravings and attended group.');
  assert.equal(calls.length, n + 1);
  const c = calls[calls.length - 1];
  assert.equal(c.method, 'POST'); assert.equal(c.path, '/model/anthropic.claude-opus-5-5/invoke');
  assert.equal(c.body.anthropic_version, 'bedrock-2023-05-31'); assert.equal(c.body.model, undefined); assert.equal(c.body.fallbacks, undefined);
  assert.equal(c.body.output_config.effort, 'medium', 'the default model\'s effort, on Bedrock too'); assert.ok(c.body.output_config.format.schema);
  assert.equal(c.body.system[0].cache_control.type, 'ephemeral'); assert.equal(c.body.messages[0].role, 'user');
  assert.equal(c.headers['x-api-key'], undefined); assert.equal(c.headers['anthropic-beta'], undefined); assert.equal(c.headers['anthropic-version'], undefined);
  assert.equal(c.headers['x-amz-security-token'], 'session-token-test'); assert.match(c.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  const day = c.headers['x-amz-date'].slice(0, 8);
  assert.match(c.headers.authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIATESTBEDROCK/${day}/us-west-2/bedrock/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$`));
  // The signature is the one AWS would compute for what arrived.
  const d = c.headers['x-amz-date'];
  const again = AP.sigv4({ method: 'POST', url: `${fakeUrl}${c.path}`, body: c.raw, region: 'us-west-2', service: 'bedrock', headers: { 'content-type': c.headers['content-type'], accept: c.headers.accept },
    credentials: { accessKeyId: 'AKIATESTBEDROCK', secretAccessKey: AWS_SECRET, sessionToken: 'session-token-test' }, now: new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`) });
  assert.equal(c.headers.authorization, again.headers.authorization);
  const a = JSON.parse(lastAudit('ai.draft').details);
  assert.equal(a.outcome, 'ok'); assert.equal(a.input_tokens, 1000); assert.equal(a.output_tokens, 200);
});

test('Bedrock: an inference profile id with a version goes in the path encoded; usage from Bedrock\'s headers when the body has none', async () => {
  fresh(); useBedrock();
  assert.equal((await admin.put('/api/ai/settings', { model: 'us.anthropic.claude-sonnet-5-5-v1:0' })).status, 200);
  reply = () => { const j = MODEL_JSON({ narrative: 'ok', gaps: [] }); delete j.usage; delete j.model; return { status: 200, json: j, headers: { 'x-amzn-bedrock-input-token-count': '321', 'x-amzn-bedrock-output-token-count': '45' } }; };
  try {
    const r = await draft();
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = calls[calls.length - 1];
    assert.equal(c.path, '/model/us.anthropic.claude-sonnet-5-5-v1%3A0/invoke');
    assert.equal(c.body.output_config.effort, undefined, 'another model: without the default model\'s options');
    assert.deepEqual(r.data.usage, { input_tokens: 321, output_tokens: 45 });
    assert.equal(r.data.model, 'us.anthropic.claude-sonnet-5-5-v1:0');
  } finally { reply = null; await admin.put('/api/ai/settings', { model: '' }); }
});

test('Bedrock: a refused signature is "auth", throttling is retried once; a redirect is never followed', async () => {
  fresh(); useBedrock();
  reply = () => ({ status: 403, json: { message: 'The request signature we calculated does not match' } });
  try {
    const r = await draft();
    assert.equal(r.status, 502); assert.equal(r.data.ai_error, 'auth');
  } finally { reply = null; }
  let n = 0;
  reply = () => (++n === 1 ? { status: 429, json: { message: 'ThrottlingException' }, headers: { 'retry-after': '0' } } : null);
  try { const r = await draft(); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(n, 2); } finally { reply = null; }
  fresh();
  const logs = []; const warn = console.warn; const log = console.log; console.warn = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' '));
  reply = (c) => (c.path.startsWith('/model/') ? { status: 307, json: {}, headers: { location: `${fakeUrl}/elsewhere` } } : null);
  try {
    const before = calls.length;
    const r = await draft();
    assert.equal(r.status, 502); assert.equal(r.data.ai_error, 'redirect'); // refused, not retried (security-1171)
    assert.ok(!calls.slice(before).some(c => c.path.startsWith('/elsewhere')), 'the redirect was not followed');
  } finally { reply = null; console.warn = warn; console.log = log; }
  assert.ok(logs.every(l => !l.includes(AWS_SECRET) && !l.includes('session-token-test') && !l.includes('cravings')), 'no credential or text in the log');
});

// ---------------------------------------------------------------- the agreement names the provider
test('the agreement is tied to the provider it was recorded for: another provider is refused until it is recorded again', async () => {
  fresh(); useBedrock();
  process.env.SUDS_AI_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'test-provider-key';
  const st = (await clin.get('/api/ai/status')).data;
  assert.equal(st.available, false); assert.equal(st.code, 'provider_changed');
  assert.match(st.reason, /agreement recorded is with Amazon Bedrock, but this server sends drafts to Anthropic/);
  const before = calls.length;
  const r = await draft();
  assert.equal(r.status, 409); assert.equal(r.data.ai_unavailable, 'provider_changed');
  assert.equal(calls.length, before, 'nothing was sent');
  // An agreement recorded before 1.17.1 (no configured_provider) was with Anthropic, the only provider then.
  const AI = require('../server/ai-copilot');
  assert.equal(AI.attestedProvider({ provider: 'Anthropic' }), 'anthropic');
  process.env.SUDS_AI_PROVIDER = 'nonsense';
  assert.match((await admin.get('/api/ai/settings')).data.endpoint_problem, /SUDS_AI_PROVIDER must be anthropic, bedrock or vertex/);
  assert.equal((await admin.post('/api/ai/attestation', { provider: 'X', signed_by: 'Y', agreement_date: '2026-01-15', reference: 'Z', baa: true, qsoa: true, counsel_reviewed: true })).status, 400);
});

// ---------------------------------------------------------------- Google Vertex AI, end to end
test('Vertex: a signed JWT exchanged for an access token (kept), then rawPredict with it', async () => {
  fresh(); useVertex(keyFile('main')); AP.clearTokenCache();
  const s = (await admin.get('/api/ai/settings')).data;
  assert.equal(s.provider.id, 'vertex'); assert.equal(s.provider.project, 'county-health-123'); assert.equal(s.provider.region, 'us-east5'); assert.equal(s.key_configured, true);
  assert.equal(s.endpoint_problem, null);
  assert.ok(!JSON.stringify(s).includes('PRIVATE KEY'), 'the key is never in the settings answer');
  await attest('Google Cloud');
  const before = calls.length;
  const r = await draft();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = calls.slice(before);
  assert.equal(sent.length, 2, 'a token, then the draft');
  const [tok, call] = sent;
  assert.equal(tok.path, '/token'); assert.match(tok.headers['content-type'], /application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(tok.raw);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, c, sig] = form.get('assertion').split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')), 'the assertion is signed with the service account key');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.iss, 'suds-copilot-main@county-health-123.iam.gserviceaccount.com'); assert.equal(claims.aud, `${fakeUrl}/token`);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform'); assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(call.path, '/v1/projects/county-health-123/locations/us-east5/publishers/anthropic/models/claude-opus-5-5:rawPredict');
  assert.equal(call.headers.authorization, 'Bearer ya29.test-access-token');
  assert.equal(call.body.anthropic_version, 'vertex-2023-10-16'); assert.equal(call.body.model, undefined); assert.equal(call.body.fallbacks, undefined);
  assert.equal(call.body.output_config.effort, 'medium'); assert.equal(call.headers['anthropic-beta'], undefined); assert.equal(call.headers['x-api-key'], undefined);
  fresh();
  const b2 = calls.length;
  assert.equal((await draft()).status, 200);
  assert.deepEqual(calls.slice(b2).map(x => x.path), [call.path], 'the access token is kept until it expires');
});

test('Vertex: a key the token service refuses is "auth"; a redirect of the token or the draft is never followed', async () => {
  fresh(); useVertex(keyFile('refused')); AP.clearTokenCache();
  reply = (c) => (c.path === '/token' ? { status: 400, json: { error: 'invalid_grant' } } : null);
  try {
    const before = calls.length;
    const r = await draft();
    assert.equal(r.status, 502); assert.equal(r.data.ai_error, 'auth');
    assert.ok(!calls.slice(before).some(c => c.path.includes('rawPredict')), 'no draft sent without a token');
  } finally { reply = null; }
  fresh(); AP.clearTokenCache();
  reply = (c) => (c.path === '/token' ? { status: 302, json: {}, headers: { location: `${fakeUrl}/elsewhere-token` } } : null);
  try {
    const before = calls.length;
    const r = await draft();
    assert.equal(r.status, 502); assert.equal(r.data.ai_error, 'redirect'); // refused, not retried (security-1171)
    assert.ok(!calls.slice(before).some(c => c.path.startsWith('/elsewhere') || c.path.includes('rawPredict')));
  } finally { reply = null; }
  fresh(); AP.clearTokenCache();
  reply = (c) => (c.path.includes('rawPredict') ? { status: 308, json: {}, headers: { location: `${fakeUrl}/elsewhere` } } : null);
  try {
    const before = calls.length;
    const r = await draft();
    assert.equal(r.status, 502); assert.equal(r.data.ai_error, 'redirect'); // refused, not retried (security-1171)
    assert.ok(!calls.slice(before).some(c => c.path.startsWith('/elsewhere')), 'the redirect was not followed');
  } finally { reply = null; }
});

test('Vertex: the key file, the project and the region are required; a key file\'s token_uri must be https', async () => {
  useVertex(path.join(tmp, 'missing.json'));
  assert.equal((await admin.get('/api/ai/settings')).data.key_configured, false);
  useVertex(keyFile('noregion')); delete process.env.SUDS_AI_VERTEX_REGION;
  assert.match((await admin.get('/api/ai/settings')).data.endpoint_problem, /SUDS_AI_VERTEX_REGION/);
  useVertex(keyFile('plain', { token_uri: 'http://tokens.example.com/token' }));
  assert.match((await admin.get('/api/ai/settings')).data.endpoint_problem, /token_uri must be https/);
  fs.writeFileSync(path.join(tmp, 'broken.json'), '{"private_key": "-----BEGIN PRIVATE KEY----- not json');
  useVertex(path.join(tmp, 'broken.json'));
  assert.equal((await admin.get('/api/ai/settings')).data.key_configured, false);
});

// ---------------------------------------------------------------- the cost estimate
test('prices and the spending limit: administrators only, non-negative numbers, audited', async () => {
  useAnthropic();
  assert.equal((await sup.put('/api/ai/settings', { price_input: 4, price_output: 20 })).status, 403, 'a supervisor cannot set prices');
  assert.equal((await clin.put('/api/ai/settings', { price_input: 4 })).status, 403, 'a clinician cannot');
  const neg = await admin.put('/api/ai/settings', { price_input: -1, price_output: 20 });
  assert.equal(neg.status, 400); assert.ok(neg.data.fields.price_input);
  const word = await admin.put('/api/ai/settings', { price_output: 'twenty' });
  assert.equal(word.status, 400); assert.ok(word.data.fields.price_output);
  const huge = await admin.put('/api/ai/settings', { price_output: 1e9 });
  assert.equal(huge.status, 400);
  const capNeg = await admin.put('/api/ai/settings', { monthly_cost_cap: -5 });
  assert.equal(capNeg.status, 400); assert.ok(capNeg.data.fields.monthly_cost_cap);
  const unpriced = await admin.put('/api/ai/settings', { monthly_cost_cap: 50 });
  assert.equal(unpriced.status, 400, 'a dollar limit needs the prices'); assert.match(unpriced.data.fields.monthly_cost_cap, /prices/);
  const ok = await admin.put('/api/ai/settings', { price_input: 4, price_output: 20.5 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.price_input, 4); assert.equal(ok.data.price_output, 20.5);
  const a = JSON.parse(lastAudit('ai.settings.update').details);
  assert.deepEqual(a.changed, ['price_input', 'price_output']); assert.equal(a.price_input, 4); assert.equal(a.price_output, 20.5);
  const s = (await admin.get('/api/ai/settings')).data;
  const expected = (s.usage.input_tokens * 4 + s.usage.output_tokens * 20.5) / 1e6;
  assert.ok(s.usage.input_tokens > 0); assert.ok(Math.abs(s.usage.estimated_cost - expected) < 1e-9, 'the month\'s tokens at those prices');
  const clearIn = await admin.put('/api/ai/settings', { price_input: null });
  assert.equal(clearIn.status, 200); assert.equal(clearIn.data.price_input, null);
  assert.equal((await admin.get('/api/ai/settings')).data.usage.estimated_cost, null, 'no estimate without both prices');
});

test('the monthly spending limit: once this month\'s estimate reaches it, no call is sent', async () => {
  fresh(); useAnthropic();
  await attest('Anthropic');
  assert.equal((await admin.put('/api/ai/settings', { price_input: 4, price_output: 20, monthly_cost_cap: 1000 })).status, 200);
  assert.equal((await clin.get('/api/ai/status')).data.available, true);
  const spent = (await admin.get('/api/ai/settings')).data.usage.estimated_cost;
  assert.equal((await admin.put('/api/ai/settings', { monthly_cost_cap: Math.floor(spent * 100) / 100 })).status, 200);
  const st = (await clin.get('/api/ai/status')).data;
  assert.equal(st.available, false); assert.equal(st.code, 'cap'); assert.match(st.reason, /spending limit/);
  const before = calls.length;
  const r = await draft();
  assert.equal(r.status, 429); assert.equal(calls.length, before, 'nothing was sent');
  const clearPrices = await admin.put('/api/ai/settings', { price_input: null });
  assert.equal(clearPrices.status, 400, 'the prices cannot be cleared while a spending limit needs them');
  assert.equal((await admin.put('/api/ai/settings', { monthly_cost_cap: null })).status, 200);
  assert.equal((await clin.get('/api/ai/status')).data.available, true, 'no dollar limit: drafts again');
});

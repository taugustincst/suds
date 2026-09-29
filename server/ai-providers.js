'use strict';
// Where the AI documentation copilot's requests go (docs/AI-COPILOT.md, "Providers"): the same Claude model,
// reached through one of three services, chosen by SUDS_AI_PROVIDER in the office server's environment.
//
//   anthropic  Anthropic's own API (the default): POST {base}/v1/messages, the key in x-api-key (ANTHROPIC_API_KEY).
//   bedrock    Amazon Bedrock InvokeModel: POST {base}/model/{model id}/invoke, signed with AWS Signature
//              Version 4 from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN) in AWS_REGION.
//   vertex     Google Cloud Vertex AI rawPredict: POST {base}/v1/projects/{p}/locations/{r}/publishers/anthropic/
//              models/{model}:rawPredict, with an OAuth access token got from a service account key file
//              (GOOGLE_APPLICATION_CREDENTIALS) by a signed JWT, kept until shortly before it expires.
//
// Many counties already have a business associate agreement with AWS or Google, so they can use the copilot under
// it; the agreement the administrator records names the provider it is with, and a draft is refused while it does
// not match the provider this server is set up for (server/ai-copilot.js status()).
//
// Nothing else about a draft changes with the provider: the gating, the identifier replacement, the audit (never the
// text) and the caps are the copilot's (server/ai-copilot.js). This module only turns the one Messages API request
// into the provider's form, authenticates it and sends it. Every fetch here refuses a redirect (redirect: 'error'):
// a redirect is never followed with PHI in the body. Credentials are read from the environment (or the key file)
// at each call, never stored, never logged, never sent to a browser; errors carry only the kind of failure.
// Node built-ins only: node:crypto for SigV4 (HMAC-SHA256) and the JWT (RS256).
const crypto = require('node:crypto');
const fs = require('node:fs');
const config = require('./config');

const DEFAULT_MODEL = 'claude-opus-5-5';
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude API)', defaultModel: DEFAULT_MODEL,
    model: /^claude-[a-z0-9][a-z0-9.-]{1,62}$/, modelHint: 'a model id such as claude-…',
    credentials: 'ANTHROPIC_API_KEY',
  },
  bedrock: {
    // A Bedrock model id (anthropic.claude-…) or a cross-region inference profile id (us.anthropic.claude-…).
    label: 'Amazon Bedrock', defaultModel: `anthropic.${DEFAULT_MODEL}`,
    model: /^(?:[a-z]{2,6}\.)?anthropic\.claude-[a-z0-9][a-z0-9.:-]{1,80}$/, modelHint: 'a Bedrock model id such as anthropic.claude-… or us.anthropic.claude-…',
    credentials: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_REGION)',
  },
  vertex: {
    label: 'Google Cloud Vertex AI', defaultModel: DEFAULT_MODEL,
    model: /^claude-[a-z0-9][a-z0-9.@-]{1,62}$/, modelHint: 'a Vertex AI model id such as claude-…',
    credentials: 'GOOGLE_APPLICATION_CREDENTIALS (a service account key file)',
  },
};
const BEDROCK_VERSION = 'bedrock-2023-05-31';
const VERTEX_VERSION = 'vertex-2023-10-16';
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

// ---------------------------------------------------------------- which provider, and is it set up
/** The provider named by SUDS_AI_PROVIDER (default anthropic), lower-cased; may be one SUDS does not know. */
const id = () => (process.env.SUDS_AI_PROVIDER || 'anthropic').trim().toLowerCase() || 'anthropic';
const current = () => PROVIDERS[id()] || null;
const label = (p = id()) => (PROVIDERS[p] ? PROVIDERS[p].label : p);
const defaultModel = () => (current() || PROVIDERS.anthropic).defaultModel;
const modelOk = (model) => { const p = current(); return !!p && p.model.test(String(model || '')); };
/** Whether `model` is the copilot's default model, however the provider writes it (anthropic.… on Bedrock). */
const isDefaultModel = (model) => String(model || '').replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '') === DEFAULT_MODEL;

const awsRegion = () => (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '').trim();
const vertexRegion = () => (process.env.SUDS_AI_VERTEX_REGION || '').trim();

/** The service account key file, parsed, or null. Its contents are never logged, even in an error. */
function serviceAccount() {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!file) return null;
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!k || typeof k !== 'object' || typeof k.client_email !== 'string' || typeof k.private_key !== 'string' || !k.client_email || !k.private_key) return null;
    return k;
  } catch { return null; }
}
const vertexProject = () => (process.env.SUDS_AI_VERTEX_PROJECT || (serviceAccount() || {}).project_id || '').trim();

/** Whether this provider's credentials are in the server's environment (not whether they work). */
function credentialsConfigured() {
  switch (id()) {
    case 'anthropic': return !!config.ai.apiKey;
    case 'bedrock': return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    case 'vertex': return !!serviceAccount();
    default: return false;
  }
}

/** The endpoint requests go to: SUDS_AI_BASE_URL if set (a gateway, a private endpoint, a test double), else the provider's. */
function baseUrl() {
  if (process.env.SUDS_AI_BASE_URL) return process.env.SUDS_AI_BASE_URL.replace(/\/+$/, '');
  switch (id()) {
    case 'bedrock': return `https://bedrock-runtime.${awsRegion()}.amazonaws.com`;
    case 'vertex': { const r = vertexRegion(); return r === 'global' ? 'https://aiplatform.googleapis.com' : `https://${r}-aiplatform.googleapis.com`; }
    default: return config.ai.baseUrl;
  }
}
/** An https URL, or plain http only to this machine (a test double). */
function urlProblem(value, name) {
  let u; try { u = new URL(value); } catch { return `${name} is not a URL`; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
  return `${name} must be https (plain http only to this machine)`;
}

/**
 * What is wrong with this server's provider set-up, in words for the administrator, or null. `model` is the model
 * the copilot will ask for (a model id for one provider is not one for another). Never names a credential's value.
 */
function configProblem(model) {
  const p = current();
  if (!p) return `SUDS_AI_PROVIDER must be anthropic, bedrock or vertex (it is "${String(id()).slice(0, 40)}")`;
  if (id() === 'bedrock' && !/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(awsRegion())) return 'Amazon Bedrock needs AWS_REGION (for example us-west-2)';
  if (id() === 'vertex') {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(vertexRegion())) return 'Vertex AI needs SUDS_AI_VERTEX_REGION (a region such as us-east5, or global)';
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(vertexProject())) return 'Vertex AI needs SUDS_AI_VERTEX_PROJECT (the Google Cloud project id), or a project_id in the key file';
    const sa = serviceAccount();
    if (sa) { const t = urlProblem(sa.token_uri || GOOGLE_TOKEN_URI, 'the key file\'s token_uri'); if (t) return t; }
  }
  const e = urlProblem(baseUrl(), process.env.SUDS_AI_BASE_URL ? 'SUDS_AI_BASE_URL' : 'the provider endpoint');
  if (e) return e;
  if (model !== undefined && !p.model.test(String(model || ''))) return `the model setting (${String(model).slice(0, 80)}) is not ${p.modelHint} for ${p.label}: change it in Settings → AI copilot`;
  return null;
}

/** For Settings: which provider, where, and which environment variables it reads. Never a credential. */
function describe() {
  const p = current();
  return {
    id: id(), label: label(), known: !!p, credentials_hint: p ? p.credentials : 'SUDS_AI_PROVIDER', model_hint: p ? p.modelHint : null, default_model: defaultModel(),
    region: id() === 'bedrock' ? awsRegion() || null : id() === 'vertex' ? vertexRegion() || null : null,
    project: id() === 'vertex' ? vertexProject() || null : null,
  };
}

// ---------------------------------------------------------------- the request, in the provider's form
/**
 * The Messages API request (server/ai-copilot.js buildRequest) as this provider takes it. Bedrock and Vertex name
 * the model in the URL, not the body, and take an anthropic_version in the body instead of the header; neither
 * offers the provider's server-side safeguard fallback, so it and its beta header are left out there.
 */
function adapt(body, headers, provider = id()) {
  if (provider === 'anthropic') return { body, headers: { ...headers } };
  const { model, fallbacks, ...rest } = body; // eslint-disable-line no-unused-vars
  const h = { 'content-type': 'application/json', accept: 'application/json' };
  return { body: { anthropic_version: provider === 'bedrock' ? BEDROCK_VERSION : VERTEX_VERSION, ...rest }, headers: h };
}

/** A path segment, percent-encoded (RFC 3986 unreserved characters kept), optionally keeping some others. */
const seg = (s, keep = '') => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  .replace(/%40/g, keep.includes('@') ? '@' : '%40');

/**
 * Send one request. `body` and `headers` are the Messages API request; `model` the model id; `signal` the caller's
 * deadline. Resolves to a fetch Response (the provider's answer, or one standing for a refused credential) or throws
 * as fetch does (a network failure, the deadline, a redirect).
 */
async function request({ body, headers, model, signal }) {
  const provider = id();
  const a = adapt(body, headers, provider);
  const payload = JSON.stringify(a.body);
  const base = baseUrl();
  if (provider === 'anthropic') {
    return fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...a.headers, 'x-api-key': config.ai.apiKey }, body: payload, signal, redirect: 'error' });
  }
  if (provider === 'bedrock') {
    const url = `${base}/model/${seg(model)}/invoke`;
    const { headers: signed } = sigv4({ method: 'POST', url, headers: a.headers, body: payload, region: awsRegion(), service: 'bedrock',
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN || null } });
    const res = await fetch(url, { method: 'POST', headers: signed, body: payload, signal, redirect: 'error' });
    return res.ok ? bedrockAnswer(res, model) : res;
  }
  if (provider === 'vertex') {
    const token = await vertexToken(signal);
    if (token.refused) return new Response('{}', { status: token.refused, headers: { 'content-type': 'application/json' } });
    const url = `${base}/v1/projects/${seg(vertexProject())}/locations/${seg(vertexRegion())}/publishers/anthropic/models/${seg(model, '@')}:rawPredict`;
    return fetch(url, { method: 'POST', headers: { ...a.headers, authorization: `Bearer ${token.token}` }, body: payload, signal, redirect: 'error' });
  }
  throw new Error('unknown AI provider');
}

/**
 * Bedrock returns the Messages API answer as it is; if its usage is missing, the token counts Bedrock reports in its
 * headers are used, so the cap and the cost estimate still count them.
 */
async function bedrockAnswer(res, model) {
  let json; try { json = await res.json(); } catch { return new Response('not json', { status: 200 }); }
  if (json && typeof json === 'object' && !json.usage) {
    const n = (h) => Number(res.headers.get(h) || 0);
    json.usage = { input_tokens: n('x-amzn-bedrock-input-token-count'), output_tokens: n('x-amzn-bedrock-output-token-count') };
  }
  if (json && typeof json === 'object' && typeof json.model !== 'string') json.model = model;
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------- AWS Signature Version 4
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ percent-encoded, upper-case hex. */
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const amzDate = (d) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

/**
 * Sign a request with AWS Signature Version 4 (the "Authorization header" form). Returns { headers } to send:
 * the caller's, plus x-amz-date, x-amz-security-token (temporary credentials) and authorization. `host` is signed
 * from the URL (fetch sends the same) and not returned. The path is encoded again, segment by segment, as every
 * AWS service but S3 expects (an already-encoded model id's %3A is signed as %253A). `now` is for the tests.
 */
function sigv4({ method, url, headers = {}, body = '', region, service, credentials, now = new Date() }) {
  const u = new URL(url);
  const date = amzDate(now); const day = date.slice(0, 8);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v);
  h.host = u.host;
  h['x-amz-date'] = date;
  if (credentials.sessionToken) h['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map(n => `${n}:${h[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const path = u.pathname.split('/').map(uriEncode).join('/') || '/';
  const query = [...u.searchParams].map(([k, v]) => [uriEncode(k), uriEncode(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256(body || '')].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  const out = { ...h };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  // The intermediate strings are returned for the tests; only `headers` is sent.
  return { headers: out, canonicalRequest, stringToSign, signature };
}

// ---------------------------------------------------------------- Google: service account JWT → access token
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
/** An RS256-signed JWT (RFC 7519) with these claims, signed with the PEM private key. */
function signJwt(claims, privateKey, kid) {
  const header = { alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${data}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(data), privateKey))}`;
}
/** The JWT a service account presents for an access token (RFC 7523): iss, scope, aud, iat, exp (an hour). */
function serviceAccountAssertion(sa, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  return signJwt({ iss: sa.client_email, scope: VERTEX_SCOPE, aud: sa.token_uri || GOOGLE_TOKEN_URI, iat, exp: iat + 3600 }, sa.private_key, sa.private_key_id);
}

// One access token per service account, kept until a minute before it expires; one exchange at a time.
const tokens = new Map();
async function vertexToken(signal) {
  const sa = serviceAccount();
  if (!sa) return { refused: 401 };
  const uri = sa.token_uri || GOOGLE_TOKEN_URI;
  const k = `${sa.client_email}\n${uri}\n${sa.private_key_id || ''}`;
  const have = tokens.get(k);
  if (have && have.token && have.expires - 60000 > Date.now()) return have;
  if (have && have.pending) return have.pending;
  const pending = (async () => {
    let res;
    try {
      res = await fetch(uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal, redirect: 'error',
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(sa) }).toString() });
    } finally { if (tokens.get(k) && tokens.get(k).pending) tokens.delete(k); }
    let json = null; try { json = await res.json(); } catch { json = null; }
    // The token service refusing the key is the provider refusing this server's credentials (401); its being
    // busy or down, the provider being so (429, 503), so the copilot's one retry applies.
    if (!res.ok || !json || typeof json.access_token !== 'string') return { refused: res.status === 429 ? 429 : res.status >= 500 ? 503 : 401 };
    const t = { token: json.access_token, expires: Date.now() + Math.max(60, Number(json.expires_in) || 3600) * 1000 };
    tokens.set(k, t);
    return t;
  })();
  tokens.set(k, { pending });
  return pending;
}
const clearTokenCache = () => tokens.clear();

module.exports = { PROVIDERS, DEFAULT_MODEL, id, current, label, defaultModel, modelOk, isDefaultModel, credentialsConfigured, baseUrl, configProblem, describe,
  adapt, request, sigv4, signJwt, serviceAccountAssertion, vertexToken, clearTokenCache };

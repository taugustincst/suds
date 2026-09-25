'use strict';
// FHIR clients: the outside systems (a county EHR, an HIE) that may read SUDS over FHIR. Each is an API key
// (the api_keys table, the same mechanism as the intake keys) whose scopes start with "fhir", plus a
// registration kept in settings under fhir_client:<key id> — the recipient organisation it stands for,
// its purpose of use and its rate limit. The recipient is what a client's consent must name (see
// fhirCoverage in server/disclosure.js).
//
// Two ways to authenticate, both "Authorization: Bearer ...":
//   * the API key itself, carrying every scope the administrator granted;
//   * an OAuth2 client-credentials access token from POST /fhir/R4/auth/token (client_id = the key id,
//     client_secret = the key), optionally narrowed to fewer scopes, valid for 15 minutes.
const db = require('../db');
const audit = require('../audit');
const { sha256, randomToken } = require('../crypto');
const { FhirError } = require('./common');

// Every FHIR resource type SUDS serves, and whether it identifies a client (and so is a Part 2 disclosure).
const RESOURCE_TYPES = {
  Patient: true, EpisodeOfCare: true, Encounter: true, Consent: true, ServiceRequest: true, Task: true, Observation: true, DocumentReference: true,
  Organization: false, Location: false, HealthcareService: false,
};
const TOKEN_TTL_SECONDS = 900;
const DEFAULT_RATE_LIMIT = 120; // requests per minute per FHIR client
const KEY_PREFIX = 'sudsfhir_';
const SCOPE_RE = /^system\/(\*|[A-Za-z]+)\.(read|rs|r|s|\*)$/;

/** Validate and normalise a list of scopes. Only read (system/<Type>.read, .rs, .r, .s or .*) exists. */
function parseScopes(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean)) {
    const m = raw.match(SCOPE_RE);
    if (!m || (m[1] !== '*' && !(m[1] in RESOURCE_TYPES))) throw new FhirError(400, `"${raw}" is not a scope this server grants (system/<ResourceType>.read or system/*.read)`, { code: 'invalid' });
    const norm = `system/${m[1]}.read`;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}
const scopesOfKey = (k) => String(k.scopes || '').split(/\s+/).filter(s => s.startsWith('system/'));
function hasScope(scopes, type) { return scopes.includes('system/*.read') || scopes.includes(`system/${type}.read`); }

function registration(keyId) {
  try { return JSON.parse(db.getSetting(`fhir_client:${keyId}`, 'null')) || null; } catch { return null; }
}
function present(k) {
  const reg = registration(k.id) || {};
  return { id: k.id, name: k.name, prefix: k.prefix, scopes: scopesOfKey(k), recipient: reg.recipient || k.name, aliases: reg.aliases || [], purpose: reg.purpose || 'TREAT',
    rate_limit: reg.rate_limit || DEFAULT_RATE_LIMIT, created_at: k.created_at, created_by: k.created_by, created_by_name: k.created_by_name, last_used_at: k.last_used_at, revoked_at: k.revoked_at };
}
function list() {
  return db.all(`SELECT k.*, u.display_name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id=k.created_by WHERE k.scopes LIKE 'fhir%' ORDER BY k.created_at DESC`).map(present);
}
function create({ name, recipient, aliases = [], purpose = 'TREAT', scopes, rate_limit }, user) {
  const granted = parseScopes(scopes);
  if (!granted.length) throw new FhirError(400, 'Grant at least one scope', { code: 'invalid' });
  const raw = KEY_PREFIX + randomToken(32);
  const id = require('../crypto').uuid();
  db.transaction(() => {
    db.run(`INSERT INTO api_keys(id,name,key_hash,prefix,scopes,created_by) VALUES(?,?,?,?,?,?)`, id, name, sha256(raw), raw.slice(0, 14), ['fhir', ...granted].join(' '), user.id);
    db.setSetting(`fhir_client:${id}`, JSON.stringify({ recipient, aliases, purpose, rate_limit: rate_limit || DEFAULT_RATE_LIMIT }));
  });
  return { id, key: raw, scopes: granted };
}
function revoke(id) {
  const k = db.one(`SELECT id FROM api_keys WHERE id=? AND scopes LIKE 'fhir%'`, id);
  if (!k) return false;
  db.run(`UPDATE api_keys SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?`, db.now(), id);
  for (const [t, v] of tokens) if (v.keyId === id) tokens.delete(t);
  return true;
}

// Issued access tokens, by hash. Process-local on purpose: SUDS is one process per database, and a restart
// simply makes clients ask for a new token (they have 15 minutes at most anyway).
const tokens = new Map();
function sweepTokens() { const now = Date.now(); for (const [t, v] of tokens) if (v.exp < now) tokens.delete(t); }

/** The FHIR client behind an API key, with everything a request needs to know about it. */
function load(k, scopes) {
  const reg = registration(k.id) || {};
  const recipient = reg.recipient || k.name;
  return {
    id: k.id, name: k.name, prefix: k.prefix, createdBy: k.created_by, scopes: scopes || scopesOfKey(k),
    recipient, recipients: [recipient, ...(reg.aliases || [])], purpose: reg.purpose || 'TREAT', rateLimit: reg.rate_limit || DEFAULT_RATE_LIMIT,
    // Who the audit trail and the accounting of disclosures name: the administrator who registered the
    // client answers for it (disclosures.disclosed_by must be a user), labelled with the client itself.
    actor: { id: k.created_by, username: `fhir:${k.name}`.slice(0, 120) },
  };
}
const activeKey = (where, ...params) => db.one(`SELECT * FROM api_keys WHERE ${where} AND revoked_at IS NULL AND scopes LIKE 'fhir%'`, ...params);

/** OAuth2 client credentials (RFC 6749 §4.4). Returns the token response, or throws an OAuth error. */
function issueToken({ clientId, clientSecret, scope }, ctx) {
  const k = clientSecret ? activeKey('key_hash=?', sha256(String(clientSecret))) : null;
  if (!k || (clientId && clientId !== k.id)) {
    audit.log({ user: null, action: 'fhir.token.denied', ip: ctx.ip, success: false });
    const e = new FhirError(401, 'invalid_client'); e.oauth = { error: 'invalid_client', error_description: 'Unknown or revoked client credentials' }; throw e;
  }
  const allowed = scopesOfKey(k);
  let granted = allowed;
  if (scope) {
    let asked;
    try { asked = parseScopes(scope); } catch { const e = new FhirError(400, 'invalid_scope'); e.oauth = { error: 'invalid_scope', error_description: 'Scopes must be system/<ResourceType>.read or system/*.read' }; throw e; }
    // A wildcard grant covers any single type; a single-type grant never widens to the wildcard.
    granted = asked.filter(s => allowed.includes(s) || allowed.includes('system/*.read'));
    if (!granted.length) { const e = new FhirError(400, 'invalid_scope'); e.oauth = { error: 'invalid_scope', error_description: 'None of the requested scopes were granted to this client' }; throw e; }
  }
  sweepTokens();
  const token = randomToken(32);
  tokens.set(sha256(token), { keyId: k.id, scopes: granted, exp: Date.now() + TOKEN_TTL_SECONDS * 1000 });
  db.run(`UPDATE api_keys SET last_used_at=? WHERE id=?`, db.now(), k.id);
  audit.log({ user: load(k).actor, action: 'fhir.token.issued', entity: 'api_key', entityId: k.id, ip: ctx.ip, details: { scopes: granted } });
  return { access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_SECONDS, scope: granted.join(' ') };
}

/** Resolve the Bearer credential on a FHIR request. Throws 401 when there is none or it is not valid. */
function authenticate(ctx) {
  const h = String(ctx.headers['authorization'] || '');
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!bearer) throw new FhirError(401, 'A bearer token is required (see /fhir/R4/metadata)', { code: 'login' });
  const hash = sha256(bearer);
  const t = tokens.get(hash);
  let k, scopes;
  if (t && t.exp > Date.now()) { k = activeKey('id=?', t.keyId); scopes = t.scopes; }
  else { if (t) tokens.delete(hash); k = activeKey('key_hash=?', hash); }
  if (!k) {
    audit.log({ user: null, action: 'fhir.denied', ip: ctx.ip, success: false, details: { reason: 'invalid token', path: ctx.path.slice(0, 120) } });
    throw new FhirError(401, 'The bearer token is not valid, has expired, or was revoked', { code: 'login' });
  }
  // Last used: at most once a minute, so a busy client is not a write per request.
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60_000) db.run(`UPDATE api_keys SET last_used_at=? WHERE id=?`, db.now(), k.id);
  return load(k, scopes);
}

/** 403 unless the client holds a read scope for this resource type. */
function requireScope(ctx, client, type) {
  if (hasScope(client.scopes, type)) return;
  audit.log({ user: client.actor, action: 'fhir.denied', entity: type, ip: ctx.ip, success: false, details: { reason: 'scope', needed: `system/${type}.read` } });
  throw new FhirError(403, `This client has not been granted system/${type}.read`, { code: 'forbidden' });
}

module.exports = { RESOURCE_TYPES, TOKEN_TTL_SECONDS, DEFAULT_RATE_LIMIT, KEY_PREFIX, parseScopes, hasScope, list, create, revoke, issueToken, authenticate, requireScope, present };

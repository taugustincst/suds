'use strict';
// FHIR clients: the outside systems (a county EHR, an HIE) that may read SUDS over FHIR. Each is an API key
// (the api_keys table, the same mechanism as the intake keys) whose scopes start with "fhir", plus a
// registration kept in settings under fhir_client:<key id> — the recipient organisation it stands for,
// its purpose of use, its rate limit and how it authenticates. The recipient is what a client's consent
// must name (see fhirCoverage in server/disclosure.js).
//
// Authentication happens only at the token endpoint (POST /fhir/R4/auth/token, OAuth2 client credentials),
// which issues a 15-minute bearer token. The client proves who it is there in one of two ways:
//   * private_key_jwt (SMART Backend Services): a JWT signed with a key whose public half the administrator
//     registered (a pasted JWKS or an https JWKS URL; server/fhir/jwt.js);
//   * client_secret: the API key, sent as client_secret (client_id = the key id), unless the administrator
//     made the client JWT-only.
// The API key itself is never accepted as a bearer on a data request: a static, non-expiring bearer is
// exactly what a leaked log line or proxy header would hand to someone else.
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
const MAX_ALIASES = 20;
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

// ---- recipient names and aliases ----
// A client's consent covers this FHIR client when it names the recipient organisation or an alias. For a
// single TPO consent (part2_tpo) the name only has to appear, as whole words, inside a list or class wording
// ("County Behavioral Health and my other treating providers"). A one-word alias such as "county" or "health"
// appears in almost every such wording, so it would quietly widen the FHIR client to most TPO consents in
// the programme. An alias must therefore be specific: not made only of generic words (GENERIC_WORDS), and
// either two specific words, or one specific word within a name of three words or more (filler such as "of"
// and "the" left out), or exactly the name of an organisation in the resource directory. The recipient name
// itself is what the administrator registered the client for and is not restricted. Aliases saved before this rule existed that break it are ignored (and listed as such).
const FILLER_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'at', 'in', 'on', 'to', 'by', 'my', 'our', 'its', 'or', 'with']);
const GENERIC_WORDS = new Set(('county counties city state states region regional district national federal public community communities local area '
  + 'health healthcare wellness medical medicine hospital hospitals clinic clinics clinical center centre centers centres care services service '
  + 'department dept division office offices agency agencies bureau board program programs programme programmes system systems network networks '
  + 'behavioral behavioural mental substance use disorder disorders sud aod alcohol drug drugs addiction recovery treatment treating provider providers '
  + 'plan plans insurer insurance payer payers managed human social family families child children youth adult adults integrated primary '
  + 'group groups partners association foundation trust inc llc corp corporation co company organization organisation organizations organisations '
  + 'other others all any team teams unit staff').split(' '));
// The same comparison fhirCoverage makes (server/disclosure.js): case, accents and punctuation ignored.
const normalise = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const wordsOf = (s) => normalise(s).split(' ').filter(Boolean);
/** Every organisation and service name in the resource directory, normalised. */
function directoryNames() {
  const out = new Set();
  for (const r of db.all(`SELECT name, organization FROM resources`)) { if (r.name) out.add(normalise(r.name)); if (r.organization) out.add(normalise(r.organization)); }
  return out;
}
/** Why an alias would be too broad, or null when it is specific enough. `dir` is directoryNames(), if known. */
function aliasProblem(alias, dir) {
  const meaningful = wordsOf(alias).filter(w => !FILLER_WORDS.has(w));
  const specific = meaningful.filter(w => !GENERIC_WORDS.has(w));
  const quoted = `"${String(alias).slice(0, 80)}"`;
  if (!meaningful.length) return 'is empty';
  if (!specific.length) return `${quoted} is made only of generic words (such as county, health, services), so it would match almost any consent that describes a class of recipients`;
  // Two specific words ("Riverbend Recovery" has one: recovery is generic), or one within a longer name
  // ("Sacramento County Behavioral Health"), or exactly an organisation the directory knows.
  if (specific.length >= 2 || (specific.length === 1 && meaningful.length >= 3)) return null;
  if ((dir || directoryNames()).has(normalise(alias))) return null;
  return `${quoted} is too short to name one organisation; use its full name (for example "Sacramento County Behavioral Health", not "Sacramento County"), or a name that exactly matches an organisation in the resource directory`;
}
function splitAliases(v) { return (Array.isArray(v) ? v : String(v || '').split(/[;\n]/)).map(x => String(x).trim()).filter(Boolean); }
/** Check a list of aliases; returns errors keyed by field ({ aliases }), or null. */
function namingProblems(aliases) {
  const fields = {};
  if (aliases.length > MAX_ALIASES) fields.aliases = `at most ${MAX_ALIASES} aliases`;
  else if (aliases.length) {
    const dir = directoryNames();
    const bad = aliases.map(a => aliasProblem(a, dir)).filter(Boolean);
    if (bad.length) fields.aliases = bad.join('; ');
  }
  return Object.keys(fields).length ? fields : null;
}
/** The names that count for coverage: the recipient and every alias that passes the rule above. */
function effectiveNames(reg, fallback) {
  const recipient = reg.recipient || fallback;
  const aliases = reg.aliases || [];
  if (!aliases.length) return { recipient, aliases: [], ignored: [] };
  const dir = directoryNames();
  const ok = [], ignored = [];
  for (const a of aliases) { const p = aliasProblem(a, dir); if (p) ignored.push({ alias: a, problem: p }); else ok.push(a); }
  return { recipient, aliases: ok, ignored };
}
const fieldError = (fields) => { const e = new FhirError(400, Object.values(fields).join('; '), { code: 'invalid' }); e.fields = fields; return e; };

function registration(keyId) {
  try { return JSON.parse(db.getSetting(`fhir_client:${keyId}`, 'null')) || null; } catch { return null; }
}
function present(k) {
  const reg = registration(k.id) || {};
  const names = effectiveNames(reg, k.name);
  return { id: k.id, name: k.name, prefix: k.prefix, scopes: scopesOfKey(k), recipient: names.recipient, aliases: reg.aliases || [], aliases_ignored: names.ignored, purpose: reg.purpose || 'TREAT',
    rate_limit: reg.rate_limit || DEFAULT_RATE_LIMIT,
    // How it may authenticate at the token endpoint. Public keys and the URL are not secrets; they are shown.
    auth: { client_secret: !reg.jwt_only, private_key_jwt: !!(reg.jwks || reg.jwks_url), jwt_only: !!reg.jwt_only, jwks_url: reg.jwks_url || null,
      jwks_keys: (reg.jwks?.keys || []).map(x => ({ kid: x.kid || null, kty: x.kty, alg: x.alg || (x.kty === 'EC' ? 'ES384' : 'RS384') })) },
    created_at: k.created_at, created_by: k.created_by, created_by_name: k.created_by_name, last_used_at: k.last_used_at, revoked_at: k.revoked_at };
}
function list() {
  return db.all(`SELECT k.*, u.display_name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id=k.created_by WHERE k.scopes LIKE 'fhir%' ORDER BY k.created_at DESC`).map(present);
}

/** The key-related registration fields (jwks, jwks_url, jwt_only), validated. Throws FhirError with `fields`. */
function keyRegistration({ jwks, jwks_url, jwt_only }, current = {}) {
  const J = require('./jwt');
  const out = { jwks: current.jwks || null, jwks_url: current.jwks_url || null, jwt_only: !!current.jwt_only };
  if (jwks !== undefined) {
    if (jwks === null || jwks === '') out.jwks = null;
    else { try { out.jwks = J.parseJwks(jwks); } catch (e) { if (e.jwt) throw fieldError({ jwks: e.message }); throw e; } }
  }
  if (jwks_url !== undefined) {
    if (jwks_url === null || jwks_url === '') out.jwks_url = null;
    else { try { out.jwks_url = J.checkJwksUrl(jwks_url); } catch (e) { if (e.jwt) throw fieldError({ jwks_url: e.message }); throw e; } }
  }
  if (jwt_only !== undefined) out.jwt_only = !!jwt_only;
  if (out.jwt_only && !out.jwks && !out.jwks_url) throw fieldError({ jwt_only: 'A JWT-only client needs a public key set (JWKS) or a JWKS URL' });
  return out;
}

function create({ name, recipient, aliases = [], purpose = 'TREAT', scopes, rate_limit, jwks, jwks_url, jwt_only }, user) {
  const granted = parseScopes(scopes);
  if (!granted.length) throw new FhirError(400, 'Grant at least one scope', { code: 'invalid' });
  const list = splitAliases(aliases);
  const problems = namingProblems(list);
  if (problems) throw fieldError(problems);
  const keys = keyRegistration({ jwks, jwks_url, jwt_only });
  // A JWT-only client still has an api_keys row (its id is the client_id), but nobody is ever shown the key.
  const raw = KEY_PREFIX + randomToken(32);
  const id = require('../crypto').uuid();
  db.transaction(() => {
    db.run(`INSERT INTO api_keys(id,name,key_hash,prefix,scopes,created_by) VALUES(?,?,?,?,?,?)`, id, name, sha256(raw), raw.slice(0, 14), ['fhir', ...granted].join(' '), user.id);
    db.setSetting(`fhir_client:${id}`, JSON.stringify({ recipient, aliases: list, purpose, rate_limit: rate_limit || DEFAULT_RATE_LIMIT, ...keys }));
  });
  return { id, key: keys.jwt_only ? null : raw, scopes: granted, jwt_only: keys.jwt_only };
}

/** Change a client's aliases or how it authenticates (keys, JWKS URL, JWT-only). Returns its new view, or null. */
function update(id, { aliases, jwks, jwks_url, jwt_only }) {
  const k = db.one(`SELECT * FROM api_keys WHERE id=? AND scopes LIKE 'fhir%' AND revoked_at IS NULL`, id);
  if (!k) return null;
  const reg = registration(id) || { recipient: k.name };
  const next = { ...reg, ...keyRegistration({ jwks, jwks_url, jwt_only }, reg) };
  if (aliases !== undefined) {
    const list = splitAliases(aliases);
    const problems = namingProblems(list);
    if (problems && problems.aliases) throw fieldError({ aliases: problems.aliases });
    next.aliases = list;
  }
  db.setSetting(`fhir_client:${id}`, JSON.stringify(next));
  return present(k);
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
  const { recipient, aliases } = effectiveNames(reg, k.name);
  return {
    id: k.id, name: k.name, prefix: k.prefix, createdBy: k.created_by, scopes: scopes || scopesOfKey(k),
    recipient, recipients: [recipient, ...aliases], purpose: reg.purpose || 'TREAT', rateLimit: reg.rate_limit || DEFAULT_RATE_LIMIT,
    // Who the audit trail and the accounting of disclosures name: the administrator who registered the
    // client answers for it (disclosures.disclosed_by must be a user), labelled with the client itself.
    actor: { id: k.created_by, username: `fhir:${k.name}`.slice(0, 120) },
  };
}
const activeKey = (where, ...params) => db.one(`SELECT * FROM api_keys WHERE ${where} AND revoked_at IS NULL AND scopes LIKE 'fhir%'`, ...params);
const oauthError = (status, error, description) => { const e = new FhirError(status, error); e.oauth = { error, error_description: description }; return e; };

/**
 * OAuth2 client credentials (RFC 6749 §4.4), the client authenticated with a signed assertion
 * (private_key_jwt: RFC 7523 §2.2, SMART Backend Services) or its secret (client_secret_post or
 * client_secret_basic). Returns the token response, or throws an OAuth error. `tokenUrl` is the aud an
 * assertion must carry.
 */
async function issueToken({ clientId, clientSecret, assertionType, assertion, scope, tokenUrl }, ctx) {
  let k = null, method = null, reason = 'unknown or revoked client credentials';
  if (assertionType || assertion) {
    const J = require('./jwt');
    if (assertionType !== J.ASSERTION_TYPE) throw oauthError(400, 'invalid_request', `client_assertion_type must be ${J.ASSERTION_TYPE}`);
    if (clientSecret) throw oauthError(400, 'invalid_request', 'Use one client authentication method, not both');
    let id = clientId;
    if (!id) { try { id = J.unverifiedIssuer(assertion); } catch (e) { if (!e.jwt) throw e; reason = e.message; } }
    const cand = id ? activeKey('id=?', String(id)) : null;
    const reg = cand ? registration(cand.id) || {} : {};
    if (cand && (reg.jwks || reg.jwks_url)) {
      try { await J.verifyClientAssertion(assertion, { keyId: cand.id, reg, tokenUrl }); k = cand; method = 'private_key_jwt'; }
      catch (e) { if (!e.jwt) throw e; reason = e.message; }
    } else if (cand) reason = 'no public key is registered for this client';
  } else if (clientSecret) {
    const cand = activeKey('key_hash=?', sha256(String(clientSecret)));
    if (cand && clientId && clientId !== cand.id) reason = 'client_id does not match the secret';
    else if (cand && (registration(cand.id) || {}).jwt_only) reason = 'this client must authenticate with a signed JWT (private_key_jwt)';
    else if (cand) { k = cand; method = 'client_secret'; }
  }
  if (!k) {
    // The reason goes to the audit trail for the administrator; the caller learns only that it failed.
    audit.log({ user: null, action: 'fhir.token.denied', ip: ctx.ip, success: false, details: { reason: String(reason).slice(0, 200) } });
    throw oauthError(401, 'invalid_client', 'Client authentication failed');
  }
  const allowed = scopesOfKey(k);
  let granted = allowed;
  if (scope) {
    let asked;
    try { asked = parseScopes(scope); } catch { throw oauthError(400, 'invalid_scope', 'Scopes must be system/<ResourceType>.read or system/*.read'); }
    // A wildcard grant covers any single type; a single-type grant never widens to the wildcard.
    granted = asked.filter(s => allowed.includes(s) || allowed.includes('system/*.read'));
    if (!granted.length) throw oauthError(400, 'invalid_scope', 'None of the requested scopes were granted to this client');
  }
  sweepTokens();
  const token = randomToken(32);
  tokens.set(sha256(token), { keyId: k.id, scopes: granted, exp: Date.now() + TOKEN_TTL_SECONDS * 1000 });
  db.run(`UPDATE api_keys SET last_used_at=? WHERE id=?`, db.now(), k.id);
  audit.log({ user: load(k).actor, action: 'fhir.token.issued', entity: 'api_key', entityId: k.id, ip: ctx.ip, details: { scopes: granted, method } });
  return { access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_SECONDS, scope: granted.join(' ') };
}

/** Resolve the Bearer access token on a FHIR request. Throws 401 when there is none or it is not valid. */
function authenticate(ctx) {
  const h = String(ctx.headers['authorization'] || '');
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!bearer) throw new FhirError(401, 'A bearer token is required (see /fhir/R4/metadata)', { code: 'login' });
  const hash = sha256(bearer);
  const t = tokens.get(hash);
  let k = null;
  if (t && t.exp > Date.now()) k = activeKey('id=?', t.keyId);
  else if (t) tokens.delete(hash);
  if (!k) {
    // Up to SUDS 1.10 the client secret itself was accepted as a bearer. Say how to move on, and record which
    // client is still doing it so the administrator can find the integration that needs changing.
    const legacy = !t && bearer.startsWith(KEY_PREFIX) ? activeKey('key_hash=?', hash) : null;
    audit.log({ user: legacy ? load(legacy).actor : null, action: 'fhir.denied', entity: legacy ? 'api_key' : null, entityId: legacy ? legacy.id : null, ip: ctx.ip, success: false,
      details: { reason: legacy ? 'client secret used as a bearer token' : 'invalid token', path: ctx.path.slice(0, 120) } });
    if (legacy) throw new FhirError(401, 'The client secret is not a bearer token. Exchange it for an access token at POST /fhir/R4/auth/token (grant_type=client_credentials) and send that token instead.', { code: 'login' });
    throw new FhirError(401, 'The bearer token is not valid, has expired, or was revoked', { code: 'login' });
  }
  // Last used: at most once a minute, so a busy client is not a write per request.
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60_000) db.run(`UPDATE api_keys SET last_used_at=? WHERE id=?`, db.now(), k.id);
  return load(k, t.scopes);
}

/** 403 unless the client holds a read scope for this resource type. */
function requireScope(ctx, client, type) {
  if (hasScope(client.scopes, type)) return;
  audit.log({ user: client.actor, action: 'fhir.denied', entity: type, ip: ctx.ip, success: false, details: { reason: 'scope', needed: `system/${type}.read` } });
  throw new FhirError(403, `This client has not been granted system/${type}.read`, { code: 'forbidden' });
}

module.exports = { RESOURCE_TYPES, TOKEN_TTL_SECONDS, DEFAULT_RATE_LIMIT, KEY_PREFIX, GENERIC_WORDS, parseScopes, hasScope, list, create, update, revoke, issueToken, authenticate, requireScope, present,
  splitAliases, aliasProblem, namingProblems, directoryNames, registration };

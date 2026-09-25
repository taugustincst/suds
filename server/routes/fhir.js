'use strict';
// Read-only FHIR R4 API under /fhir/R4 (docs/integration/FHIR.md), so SUDS can sit beside the county EHR:
// the EHR (or an HIE) reads what SUDS knows about the clients who have agreed to it being shared.
//
// Every answer that identifies a client is a 42 CFR Part 2 disclosure to the organisation the FHIR client
// was registered for. It is made only for clients whose live consent names that organisation for the
// client's purpose of use (server/disclosure.js fhirCoverage); everyone else is left out of the answer, the
// Bundle says how many were left out, each resource and Bundle carries the Part 2 security labels and
// §2.32 notice, and one accounting-of-disclosures row is written per client per request.
//
// Office-server only: the local kernel leaves this module out (LOCAL_ROUTE_MODULES in server/app.js).
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const disclosure = require('../disclosure');
const { rateLimit } = require('../app');
const { HttpError, badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');
const C = require('../fhir/clients');
const R = require('../fhir/resources');
const bulk = require('../fhir/bulk');
const { FhirError, FHIR_VERSION, PART2_SECURITY, outcome, send, sendError, baseUrl } = require('../fhir/common');

/** Wrap a FHIR handler: authenticate the client, apply its rate limit, and answer failures as OperationOutcome. */
function fhir(fn, { open = false } = {}) {
  return async (ctx) => {
    try {
      let client = null;
      if (!open) {
        client = C.authenticate(ctx);
        if (!rateLimit(`fhirclient:${client.id}`, client.rateLimit, 60_000)) throw new FhirError(429, `Rate limit of ${client.rateLimit} requests a minute exceeded`, { code: 'throttled', headers: { 'Retry-After': '60' } });
      }
      await fn(ctx, client);
    } catch (e) {
      if (e instanceof FhirError || e instanceof HttpError) sendError(ctx.res, e.status, e.message, { code: e.code, headers: e.headers || {} });
      else {
        console.error(`[suds] ${ctx.method} ${ctx.path}:`, e);
        try { audit.log({ user: null, action: 'server.error', ip: ctx.ip, success: false, details: { path: ctx.path.slice(0, 120), message: String(e.message).slice(0, 300) } }); } catch { /* still answer */ }
        sendError(ctx.res, 500, 'Internal server error');
      }
    }
  };
}

const count = (ctx) => {
  const raw = ctx.query.get('_count');
  if (raw === null) return R.DEFAULT_COUNT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new FhirError(400, '_count must be a whole number', { code: 'invalid' });
  return Math.min(n, R.MAX_COUNT);
};
const offsetOf = (ctx) => {
  const n = Number(ctx.query.get('_offset') || 0);
  if (!Number.isInteger(n) || n < 0) throw new FhirError(400, '_offset must be a whole number', { code: 'invalid' });
  return n;
};
const typeOf = (ctx) => { const t = ctx.params.type; if (!R.DEFS[t]) throw new FhirError(404, `Resource type "${String(t).slice(0, 60)}" is not served here`, { code: 'not-supported' }); return t; };
// Per resource type: a consent covers only the categories of information it names (disclosure.CATEGORY_OF_FHIR_TYPE).
const coverageFor = (client, type) => disclosure.fhirCoverage({ cacheKey: client.id, recipients: client.recipients, purposeOfUse: client.purpose, resourceType: type });
const requestId = () => uuid();

/** Record who received what: one accounting row per client, one audit row for the request. */
function account({ ctx, client, type, interaction, perClient, returned, omittedPatients, reqId }) {
  const what = (n) => `FHIR ${interaction} ${type}: ${n} resource${n === 1 ? '' : 's'}`;
  for (const e of perClient.values()) e.what = what(e.n);
  disclosure.recordFhir({ perClient, recipient: client.recipient, purposeOfUse: client.purpose, sourceRef: `fhir:${reqId}`, user: client.actor, ip: ctx.ip });
  // Parameter names only: their values (a name, a date of birth) would be PHI in the audit trail.
  audit.log({ user: client.actor, action: `fhir.${interaction}`, entity: type, entityId: interaction === 'read' ? ctx.params.id : null, clientId: interaction === 'read' && perClient.size === 1 ? [...perClient.keys()][0] : null, ip: ctx.ip,
    details: { client: client.prefix, request: reqId, params: [...new Set(ctx.query.keys())], returned, patients: perClient.size, omitted_patients: omittedPatients } });
}

function search(ctx, client) {
  const type = typeOf(ctx);
  C.requireScope(ctx, client, type);
  const d = R.DEFS[type];
  const n = count(ctx), offset = offsetOf(ctx);
  const filter = R.where(type, ctx.query);
  const rows = R.page(type, filter, { count: n + 1, offset });
  const hasNext = rows.length > n; if (hasNext) rows.length = n;
  const coverage = d.phi ? coverageFor(client, type) : null;
  const base = baseUrl(ctx);
  const entries = []; const perClient = new Map(); const omitted = new Set(); let omittedRows = 0;
  for (const row of rows) {
    if (d.phi && !coverage.has(row._cid)) { omittedRows++; omitted.add(row._cid); continue; }
    const r = R.toResource(type, row);
    if (!r || (d.keep && !d.keep(r.full, client))) continue;
    entries.push({ fullUrl: `${base}/${type}/${r.resource.id}`, resource: r.resource, search: { mode: 'match' } });
    if (d.phi) { const e = perClient.get(row._cid) || { consentId: coverage.get(row._cid), n: 0 }; e.n++; perClient.set(row._cid, e); }
  }
  const link = (off) => { const q = new URLSearchParams(ctx.query); q.set('_count', String(n)); if (off) q.set('_offset', String(off)); else q.delete('_offset'); return `${base}/${type}?${q}`; };
  const links = [{ relation: 'self', url: link(offset) }];
  if (hasNext) links.push({ relation: 'next', url: link(offset + n) });
  if (offset > 0) links.push({ relation: 'previous', url: link(Math.max(0, offset - n)) });
  const bundle = { resourceType: 'Bundle', id: uuid(), meta: { lastUpdated: new Date().toISOString() }, type: 'searchset', link: links, entry: entries };
  if (d.phi) {
    bundle.meta.security = PART2_SECURITY;
    const issues = [{ severity: 'information', code: 'informational', diagnostics: `42 CFR §2.32 notice: ${disclosure.notice().text}` }];
    // A search that names one person gets the same words whether or not anyone was withheld: "1 withheld"
    // in answer to identifier=X would itself tell the recipient that X is a client of this programme.
    if (R.identifying(type, ctx.query)) issues.push({ severity: 'information', code: 'suppressed', diagnostics: `Results include only patients whose active consent covers ${client.recipient} for this purpose of use.` });
    else if (omitted.size) issues.push({ severity: 'warning', code: 'suppressed', diagnostics: `${omitted.size} patient(s) (${omittedRows} ${type} resource(s)) on this page were withheld: no active consent covers ${client.recipient} for this purpose of use, or the patient has an agreed restriction.` });
    bundle.entry.push({ resource: { ...outcome(issues), id: uuid() }, search: { mode: 'outcome' } });
    const reqId = requestId();
    account({ ctx, client, type, interaction: 'search', perClient, returned: entries.length, omittedPatients: R.identifying(type, ctx.query) ? undefined : omitted.size, reqId });
  } else {
    audit.log({ user: client.actor, action: 'fhir.search', entity: type, ip: ctx.ip, details: { client: client.prefix, params: [...new Set(ctx.query.keys())], returned: entries.length } });
  }
  send(ctx.res, 200, bundle);
}

function read(ctx, client) {
  const type = typeOf(ctx);
  C.requireScope(ctx, client, type);
  const d = R.DEFS[type];
  const id = String(ctx.params.id || '');
  if (!/^[A-Za-z0-9\-.]{1,64}$/.test(id)) throw new FhirError(404, 'Not found', { code: 'not-found' });
  const [row] = R.page(type, { sql: '_fid = ?', params: [id] }, { count: 1, offset: 0 });
  // A client whose consent does not cover this recipient is answered exactly like one that does not exist.
  const withheld = row && d.phi && !coverageFor(client, type).has(row._cid);
  const r = row && !withheld ? R.toResource(type, row) : null;
  if (!r || (d.keep && !d.keep(r.full, client))) {
    if (withheld) audit.log({ user: client.actor, action: 'fhir.read.withheld', entity: type, entityId: id, clientId: row._cid, ip: ctx.ip, success: false, details: { client: client.prefix, reason: 'no covering consent' } });
    throw new FhirError(404, `${type}/${id} is not available`, { code: 'not-found' });
  }
  if (d.phi) {
    const perClient = new Map([[row._cid, { consentId: coverageFor(client, type).get(row._cid), n: 1 }]]);
    account({ ctx, client, type, interaction: 'read', perClient, returned: 1, omittedPatients: undefined, reqId: requestId() });
  } else {
    audit.log({ user: client.actor, action: 'fhir.read', entity: type, entityId: id, ip: ctx.ip, details: { client: client.prefix } });
  }
  send(ctx.res, 200, r.resource, { ETag: `W/"${Date.parse(r.resource.meta?.lastUpdated || 0) || 0}"` });
}

// ---- CapabilityStatement and discovery (public, no PHI) ----
const PARAM_TYPES = { _id: 'token', _lastUpdated: 'date', patient: 'reference', date: 'date', authored: 'date', 'authored-on': 'date', identifier: 'token', family: 'string', given: 'string', birthdate: 'date',
  status: 'token', category: 'token', name: 'string', active: 'token', 'address-city': 'string', 'address-postalcode': 'string', 'service-category': 'token' };
const PROFILES = { Patient: 'us-core-patient', Encounter: 'us-core-encounter', Organization: 'us-core-organization', Location: 'us-core-location' };
function capability(ctx) {
  const base = baseUrl(ctx);
  return {
    resourceType: 'CapabilityStatement', id: 'suds', status: 'active', date: new Date().toISOString().slice(0, 10), publisher: 'SUDS', kind: 'instance',
    instantiates: ['http://hl7.org/fhir/uv/bulkdata/CapabilityStatement/bulk-data'],
    software: { name: 'SUDS', version: config.version },
    implementation: { description: 'SUDS read-only FHIR R4 API (42 CFR Part 2: consent-gated)', url: base },
    fhirVersion: FHIR_VERSION, format: ['json'],
    implementationGuide: ['http://hl7.org/fhir/us/core/ImplementationGuide/hl7.fhir.us.core', 'http://hl7.org/fhir/uv/bulkdata/ImplementationGuide/hl7.fhir.uv.bulkdata'],
    rest: [{
      mode: 'server',
      documentation: 'Read-only. Resources about a patient are returned only while the patient has an active consent naming the calling client\'s organisation for its purpose of use (42 CFR Part 2); other patients are omitted and counted in an OperationOutcome entry. Unknown search parameters are rejected.',
      security: {
        cors: false,
        service: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/restful-security-service', code: 'SMART-on-FHIR', display: 'SMART-on-FHIR' }], text: 'OAuth2 client credentials (SMART Backend Services): private_key_jwt with RS384 or ES384, or client_secret_post / client_secret_basic where the client allows it. Data requests take the access token only.' }],
        extension: [{ url: 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris', extension: [{ url: 'token', valueUri: `${base}/auth/token` }] }],
      },
      resource: Object.keys(R.DEFS).map(type => ({
        type, ...(PROFILES[type] ? { supportedProfile: [R.US_CORE + PROFILES[type]] } : {}),
        interaction: [{ code: 'read' }, { code: 'search-type' }],
        searchParam: R.searchParams(type).filter(p => !p.includes(':')).map(name => ({ name, type: PARAM_TYPES[name] || 'token' })),
        ...(type === 'Patient' ? { operation: [{ name: 'export', definition: 'http://hl7.org/fhir/uv/bulkdata/OperationDefinition/patient-export' }] } : {}),
      })),
      operation: [{ name: 'export', definition: 'http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export' }],
    }],
  };
}

// ---- OAuth2 token endpoint ----
async function tokenRequest(ctx) {
  const ip = ctx.ip;
  const reply = (status, body) => { const s = JSON.stringify(body); ctx.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store', Pragma: 'no-cache' }); ctx.res.end(s); };
  if (!rateLimit(`fhirtoken:${ip}`, 30, 60_000)) return reply(429, { error: 'slow_down', error_description: 'Too many token requests' });
  const ct = String(ctx.headers['content-type'] || '');
  const form = ct.includes('application/json') ? new URLSearchParams(Object.entries(ctx.body || {}).map(([k, v]) => [k, String(v)])) : new URLSearchParams((ctx.rawBody || Buffer.alloc(0)).toString('utf8'));
  let clientId = form.get('client_id'); let clientSecret = form.get('client_secret');
  const basic = String(ctx.headers.authorization || '');
  if (basic.startsWith('Basic ')) {
    const [id, ...rest] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
    clientId = decodeURIComponent(id || ''); clientSecret = decodeURIComponent(rest.join(':'));
  }
  if (form.get('grant_type') !== 'client_credentials') return reply(400, { error: 'unsupported_grant_type', error_description: 'Only grant_type=client_credentials is supported' });
  try {
    return reply(200, await C.issueToken({ clientId, clientSecret, assertionType: form.get('client_assertion_type'), assertion: form.get('client_assertion'), scope: form.get('scope'), tokenUrl: `${baseUrl(ctx)}/auth/token` }, ctx));
  } catch (e) { if (e.oauth) return reply(e.status, e.oauth); throw e; }
}

// ---- administration (Settings -> FHIR clients) ----
const KEY_FIELDS = { jwks: { type: 'string', maxLen: 40000 }, jwks_url: { type: 'string', maxLen: 500 }, jwt_only: { type: 'boolean' } };
const asBad = (e) => (e instanceof FhirError ? badRequest(e.message, e.fields ? { fields: e.fields } : undefined) : e);
// A JWKS may arrive as JSON text (the form's textarea) or as an object (an API caller).
const jwksOf = (body) => (body && body.jwks && typeof body.jwks === 'object' ? JSON.stringify(body.jwks) : body?.jwks);

function adminCreate(ctx) {
  const v = validate({ ...ctx.body, jwks: jwksOf(ctx.body) }, {
    name: { type: 'string', required: true, maxLen: 100 }, recipient: { type: 'string', required: true, maxLen: 200 }, aliases: { type: 'string', maxLen: 2000 },
    purpose: { type: 'string', enum: Object.keys(disclosure.FHIR_PURPOSES) }, scopes: { type: 'array', required: true, maxLen: 20 }, rate_limit: { type: 'number', integer: true, min: 1, max: 6000 }, ...KEY_FIELDS,
  });
  let created;
  try { created = C.create({ name: v.name, recipient: v.recipient, aliases: v.aliases || '', purpose: v.purpose || 'TREAT', scopes: v.scopes, rate_limit: v.rate_limit, jwks: v.jwks || undefined, jwks_url: v.jwks_url || undefined, jwt_only: v.jwt_only }, ctx.user); }
  catch (e) { throw asBad(e); }
  audit.log({ user: ctx.user, action: 'fhir_client.create', entity: 'api_key', entityId: created.id, ip: ctx.ip, details: { name: v.name, purpose: v.purpose || 'TREAT', scopes: created.scopes, rate_limit: v.rate_limit || C.DEFAULT_RATE_LIMIT, jwt: !!(v.jwks || v.jwks_url), jwt_only: !!created.jwt_only } });
  ctx.status = 201;
  return { id: created.id, key: created.key, scopes: created.scopes, jwt_only: created.jwt_only,
    note: created.key ? 'Store this key now; it will not be shown again. Use it as client_secret (client_id is the id above) at the token URL to get an access token; it is not itself a bearer token.'
      : 'This client authenticates only with a JWT signed by its registered key (private_key_jwt); client_id is the id above.' };
}

/** Change a client's aliases, its public keys or JWKS URL, or whether it must use JWT. */
function adminUpdate(ctx) {
  const v = validate({ ...ctx.body, jwks: jwksOf(ctx.body) }, { aliases: { type: 'string', maxLen: 2000 }, ...KEY_FIELDS });
  const patch = {};
  for (const k of ['aliases', 'jwks', 'jwks_url', 'jwt_only']) if (ctx.body && k in ctx.body) patch[k] = ctx.body[k] === null ? null : v[k] ?? '';
  let out;
  try { out = C.update(ctx.params.id, patch); } catch (e) { throw asBad(e); }
  if (!out) throw notFound();
  audit.log({ user: ctx.user, action: 'fhir_client.update', entity: 'api_key', entityId: ctx.params.id, ip: ctx.ip, details: { changed: Object.keys(patch), jwt_only: out.auth.jwt_only, keys: out.auth.jwks_keys.length, jwks_url: !!out.auth.jwks_url } });
  return out;
}

/**
 * Before an administrator saves aliases: how many clients each name would cover today, and whether each alias
 * is specific enough. Counts only — never who — so the preview itself discloses nothing.
 */
function adminAliasPreview(ctx) {
  const v = validate(ctx.body, { recipient: { type: 'string', maxLen: 200 }, aliases: { type: 'string', maxLen: 2000 }, purpose: { type: 'string', enum: Object.keys(disclosure.FHIR_PURPOSES) } });
  const purpose = v.purpose || 'TREAT';
  const aliases = C.splitAliases(v.aliases || '').slice(0, 20);
  const dir = C.directoryNames();
  const covered = (names) => disclosure.fhirCoverage({ cacheKey: 'alias-preview', recipients: names, purposeOfUse: purpose }).size;
  const recipient = String(v.recipient || '').trim();
  const rows = aliases.map(alias => { const problem = C.aliasProblem(alias, dir); return { alias, ok: !problem, problem, clients: covered([alias]) }; });
  const valid = aliases.filter((a, i) => rows[i].ok);
  const out = { purpose, recipient: recipient ? { name: recipient, clients: covered([recipient]) } : null, aliases: rows,
    total: recipient || valid.length ? covered([recipient, ...valid].filter(Boolean)) : 0 };
  // Working this out decrypts consents: record that it was done, with the counts and never the names.
  audit.log({ user: ctx.user, action: 'fhir_client.alias_preview', ip: ctx.ip, details: { purpose, aliases: aliases.length, rejected: rows.filter(r => !r.ok).length, total: out.total } });
  return out;
}

module.exports = (r) => {
  // Discovery: public, and nothing in it is about anyone.
  r.get('/fhir/R4/metadata', fhir((ctx) => send(ctx.res, 200, capability(ctx)), { open: true }));
  r.get('/fhir/R4/.well-known/smart-configuration', fhir((ctx) => {
    const base = baseUrl(ctx);
    const body = { token_endpoint: `${base}/auth/token`, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_post', 'client_secret_basic'],
      token_endpoint_auth_signing_alg_values_supported: Object.keys(require('../fhir/jwt').ALGS),
      scopes_supported: ['system/*.read', ...Object.keys(R.DEFS).map(t => `system/${t}.read`)], capabilities: ['client-confidential-asymmetric', 'client-confidential-symmetric'] };
    const s = JSON.stringify(body); ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) }); ctx.res.end(s);
  }, { open: true }));
  r.post('/fhir/R4/auth/token', fhir(tokenRequest, { open: true }));

  // Bulk Data export. Static paths win over /:type/:id in the router, so these are never taken for a read.
  r.get('/fhir/R4/\\$export', fhir((ctx, client) => bulk.kickoff(ctx, client, 'system')));
  r.get('/fhir/R4/Patient/\\$export', fhir((ctx, client) => bulk.kickoff(ctx, client, 'patient')));
  r.get('/fhir/R4/\\$export-status/:id', fhir((ctx, client) => bulk.status(ctx, client)));
  r.delete('/fhir/R4/\\$export-status/:id', fhir((ctx, client) => bulk.cancel(ctx, client)));
  r.get('/fhir/R4/\\$export-file/:id/:file', fhir((ctx, client) => bulk.file(ctx, client)));

  r.get('/fhir/R4/:type', fhir(search));
  r.get('/fhir/R4/:type/:id', fhir(read));

  r.get('/api/admin/fhir-clients', auth.requireAuth, auth.requirePerm('apikeys:manage'), () => ({
    clients: C.list(), purposes: Object.entries(disclosure.FHIR_PURPOSES).map(([code, p]) => ({ code, label: p.display })),
    resource_types: Object.entries(C.RESOURCE_TYPES).map(([type, phi]) => ({ type, phi })), token_path: '/fhir/R4/auth/token', base_path: '/fhir/R4',
  }));
  r.post('/api/admin/fhir-clients', auth.requireAuth, auth.requirePerm('apikeys:manage'), adminCreate);
  r.post('/api/admin/fhir-clients/alias-preview', auth.requireAuth, auth.requirePerm('apikeys:manage'), adminAliasPreview);
  r.patch('/api/admin/fhir-clients/:id', auth.requireAuth, auth.requirePerm('apikeys:manage'), adminUpdate);
  r.delete('/api/admin/fhir-clients/:id', auth.requireAuth, auth.requirePerm('apikeys:manage'), (ctx) => {
    if (!C.revoke(ctx.params.id)) throw notFound();
    audit.log({ user: ctx.user, action: 'fhir_client.revoke', entity: 'api_key', entityId: ctx.params.id, ip: ctx.ip });
    return { ok: true };
  });
};

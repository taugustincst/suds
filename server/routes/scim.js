'use strict';
// SCIM 2.0 endpoint for the county identity provider (server/scim.js has the model and what SCIM may and may
// not do). Authenticated by a bearer token scoped "scim" (the api_keys table, like the intake and FHIR keys),
// created by an administrator under Settings → Security status → Provisioning (SCIM). Office server only: a
// device has no identity provider (LOCAL_ROUTE_MODULES in server/app.js).
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const scim = require('../scim');
const { rateLimit } = require('../app');
const { HttpError, notFound } = require('../http');
const { validate } = require('../validate');
const { sha256, randomToken, uuid } = require('../crypto');

function send(ctx, status, body) {
  const text = body === null ? '' : JSON.stringify(body);
  ctx.res.writeHead(status, { 'Content-Type': 'application/scim+json; charset=utf-8', 'Cache-Control': 'no-store', ...(text ? { 'Content-Length': Buffer.byteLength(text) } : {}) });
  ctx.res.end(text);
}
function fail(ctx, e) {
  if (e instanceof scim.ScimError) return send(ctx, e.status, scim.errorBody(e.status, e.message, e.scimType));
  if (e instanceof HttpError) return send(ctx, e.status, scim.errorBody(e.status, e.message));
  throw e;
}
const baseUrl = (ctx) => `${ctx.headers['x-forwarded-proto'] === 'https' || ctx.req.socket.encrypted ? 'https' : 'http'}://${ctx.headers.host || 'localhost'}`;

function tokenAuth(ctx) {
  if (!rateLimit(`scim:${ctx.ip}`, 600, 60_000)) throw new HttpError(429, 'Too many requests');
  const h = String(ctx.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const k = token ? db.one(`SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL`, sha256(token)) : null;
  if (!k || !String(k.scopes || '').split(/[\s,]+/).includes('scim')) {
    audit.log({ user: null, action: 'scim.denied', ip: ctx.ip, success: false, details: { path: ctx.path } });
    throw new scim.ScimError(401, 'A valid SCIM bearer token is required');
  }
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60_000) db.run(`UPDATE api_keys SET last_used_at=? WHERE id=?`, db.now(), k.id);
  return { id: k.created_by, username: `scim:${k.name}` };
}
/** Wrap a SCIM handler: authenticate, run, answer in SCIM's own error format. */
const handler = (fn) => async (ctx) => {
  try { const actor = tokenAuth(ctx); const out = await fn(ctx, actor); if (out !== undefined) send(ctx, out.status || 200, out.body); }
  catch (e) { fail(ctx, e); }
};

module.exports = (r) => {
  r.get('/scim/v2/ServiceProviderConfig', handler(() => ({ body: scim.serviceProviderConfig() })));
  r.get('/scim/v2/Users', handler((ctx) => ({ body: scim.list({ filter: ctx.query.get('filter'), startIndex: ctx.query.get('startIndex'), count: ctx.query.get('count') ?? 100 }, baseUrl(ctx)) })));
  r.post('/scim/v2/Users', handler((ctx, actor) => ({ status: 201, body: scim.create(ctx.body, actor, baseUrl(ctx)) })));
  r.get('/scim/v2/Users/:id', handler((ctx) => ({ body: scim.toResource(scim.find(ctx.params.id), baseUrl(ctx)) })));
  r.put('/scim/v2/Users/:id', handler((ctx, actor) => ({ body: scim.replace(ctx.params.id, ctx.body, actor, baseUrl(ctx)) })));
  r.patch('/scim/v2/Users/:id', handler((ctx, actor) => ({ body: scim.patch(ctx.params.id, ctx.body, actor, baseUrl(ctx)) })));
  r.delete('/scim/v2/Users/:id', handler((ctx, actor) => { scim.deactivate(ctx.params.id, actor); return { status: 204, body: null }; }));

  // ---- SCIM tokens, for administrators ----
  r.get('/api/admin/scim/tokens', auth.requireAuth, auth.requirePerm('users:manage'), () =>
    ({ tokens: db.all(`SELECT k.id,k.name,k.prefix,k.created_at,k.last_used_at,k.revoked_at,u.display_name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id=k.created_by WHERE k.scopes='scim' ORDER BY k.created_at DESC`), endpoint: '/scim/v2' }));
  r.post('/api/admin/scim/tokens', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const { name } = validate(ctx.body, { name: { type: 'string', required: true, maxLen: 100 } });
    const raw = 'suds_scim_' + randomToken(32);
    const id = uuid();
    db.run(`INSERT INTO api_keys(id,name,key_hash,prefix,scopes,created_by) VALUES(?,?,?,?,?,?)`, id, name, sha256(raw), raw.slice(0, 16), 'scim', ctx.user.id);
    audit.log({ user: ctx.user, action: 'scim.token.create', entity: 'api_key', entityId: id, ip: ctx.ip, details: { name } });
    ctx.status = 201;
    return { id, token: raw, endpoint: '/scim/v2', note: 'Give this token and the SCIM endpoint to the identity provider now; it will not be shown again.' };
  });
  r.delete('/api/admin/scim/tokens/:id', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const k = db.one(`SELECT id FROM api_keys WHERE id=? AND scopes='scim'`, ctx.params.id); if (!k) throw notFound();
    db.run(`UPDATE api_keys SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?`, db.now(), k.id);
    audit.log({ user: ctx.user, action: 'scim.token.revoke', entity: 'api_key', entityId: k.id, ip: ctx.ip });
    return { ok: true };
  });
};

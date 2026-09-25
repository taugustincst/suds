'use strict';
// Machine intake endpoint for Pocket AI (or any app that can POST JSON / share to a URL) using an API key.
// POST /api/intake/notes  Authorization: Bearer suds_xxx   body: Pocket AI JSON (single note, array, or {notes:[...]})
const db = require('../db');
const audit = require('../audit');
const { rateLimit } = require('../app');
const { HttpError, unauthorized, badRequest } = require('../http');
const { sha256 } = require('../crypto');
const pocket = require('../importers/pocketai');
const importsRoutes = require('./imports');

function apiKeyAuth(ctx) {
  if (!rateLimit(`intake:${ctx.ip}`, 60, 60_000)) throw new HttpError(429, 'Too many requests');
  const h = ctx.headers['authorization'] || ''; const key = h.startsWith('Bearer ') ? h.slice(7).trim() : (ctx.headers['x-api-key'] || '');
  if (!key) throw unauthorized('API key required');
  let k = db.one(`SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL`, sha256(key));
  // Only an intake key may stage notes: a FHIR client's key (scopes "fhir ...") is for reading, elsewhere.
  if (k && !String(k.scopes || '').split(/[\s,]+/).includes('intake')) k = null;
  if (!k) { audit.log({ user: null, action: 'intake.denied', ip: ctx.ip, success: false }); throw unauthorized('Invalid API key'); }
  db.run(`UPDATE api_keys SET last_used_at=? WHERE id=?`, db.now(), k.id);
  return k;
}

module.exports = (r) => {
  r.post('/api/intake/notes', (ctx) => {
    const k = apiKeyAuth(ctx);
    let payload = ctx.body;
    if (ctx.rawBody && (!payload || !Object.keys(payload).length)) payload = ctx.rawBody.toString('utf8');
    if (!payload || (typeof payload === 'object' && !Object.keys(payload).length)) throw badRequest('Empty payload');
    let items;
    try { items = typeof payload === 'string' ? pocket.parse(payload) : (Array.isArray(payload) ? payload : (payload.notes || payload.items || payload.recordings || [payload])).map(pocket.normalizeItem); }
    catch (e) { throw badRequest('Could not parse payload: ' + e.message); }
    const id = importsRoutes.stageFn({ source: 'api', filename: `api:${k.name}`, items, importedBy: k.created_by, metadata: { api_key: k.prefix } });
    audit.log({ user: { id: k.created_by, username: `apikey:${k.name}` }, action: 'intake.received', entity: 'import', entityId: id, ip: ctx.ip, details: { count: items.length } });
    ctx.status = 202; return { import_id: id, staged: items.length, message: 'Notes staged for review in SUDS → Imports' };
  });
  r.get('/api/intake/ping', (ctx) => { const k = apiKeyAuth(ctx); return { ok: true, key: k.name }; });
};

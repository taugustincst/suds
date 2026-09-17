'use strict';
// Starter resource directories: load a whole region's programs into the resource directory in one click.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const region = require('../region');
const { badRequest, notFound } = require('../http');

// Well inside any proxy or browser patience for one request; the leftovers are one more click away.
const BATCH_BUDGET_MS = 45000;

module.exports = (r) => {
  r.get('/api/regions', auth.requireAuth, auth.requirePerm('resources:read', 'resources:write'), () => ({ regions: region.list() }));

  r.post('/api/regions/:id/load', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    if (!region.REGIONS[ctx.params.id]) throw notFound('Unknown region');
    const out = region.load({ regionId: ctx.params.id, actor: ctx.user.id });
    audit.log({ user: ctx.user, action: 'region.load.request', ip: ctx.ip, details: { region: ctx.params.id, ...out } });
    return out;
  });

  r.delete('/api/regions/:id', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    if (!region.REGIONS[ctx.params.id]) throw notFound('Unknown region');
    const out = region.remove({ regionId: ctx.params.id, actor: ctx.user.id });
    audit.log({ user: ctx.user, action: 'region.remove.request', ip: ctx.ip, details: { region: ctx.params.id, ...out } });
    return out;
  });

  // Programs still showing the generated placeholder card, whose website publishes a picture we could try to download.
  r.get('/api/regions/:id/pictures', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    if (!region.REGIONS[ctx.params.id]) throw notFound('Unknown region');
    const pending = region.pictureTargets(ctx.params.id).filter(t => !db.one(`SELECT COUNT(*) n FROM resource_photos WHERE resource_id=? AND caption NOT LIKE '%(placeholder%'`, t.id).n);
    return { pending: pending.map(t => ({ key: t.key, name: t.name, url: t.url })), total: region.pictureTargets(ctx.params.id).length };
  });
  // Downloads provider logos/photos from the providers' own websites (office server only; needs internet access).
  r.post('/api/regions/:id/pictures', auth.requireAuth, auth.requirePerm('resources:write'), async (ctx) => {
    if (!region.REGIONS[ctx.params.id]) throw notFound('Unknown region');
    const keys = Array.isArray(ctx.body.keys) ? ctx.body.keys.slice(0, 10) : null;
    if (!keys || !keys.length) throw badRequest('keys is required');
    const targets = region.pictureTargets(ctx.params.id).filter(t => keys.includes(t.key));
    const results = [];
    // Each target can need two slow fetches from somebody else's web server, so a batch of ten could
    // otherwise outlive the request. Give the whole batch one budget and report the rest as retryable
    // rather than leaving the browser waiting on a connection that has already been dropped.
    const deadline = Date.now() + BATCH_BUDGET_MS;
    for (const t of targets) {
      results.push({ name: t.name, ...(await region.fetchPicture(t, { actor: ctx.user.id, deadline })) });
    }
    audit.log({ user: ctx.user, action: 'region.pictures.request', ip: ctx.ip, details: { region: ctx.params.id, tried: results.length, ok: results.filter(x => x.ok).length } });
    return { results };
  });
};

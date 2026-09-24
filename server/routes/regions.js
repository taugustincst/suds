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
    // `thumbs`: pictures already downloaded that still need a thumbnail made in the browser (see
    // region.picturesNeedingThumbnails) — the directory shows a picture's thumbnail on its card.
    return { pending: pending.map(t => ({ key: t.key, name: t.name, url: t.url })), total: region.pictureTargets(ctx.params.id).length, thumbs: region.picturesNeedingThumbnails(ctx.params.id) };
  });
  // Downloads provider logos/photos: on the office server from the providers' own websites (it needs
  // outbound internet access), on SUDS on this device from the pictures that build was published with.
  // Each successful result carries photo_id and resource_id so the browser can save a thumbnail for it.
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
    // Two sites in a row that the server could not reach at all means the server has no way out (no
    // internet, or a proxy it is not using), not two broken websites: say so for the rest of the batch
    // instead of waiting out a connection timeout for each of them.
    let unreachable = 0;
    for (const t of targets) {
      const out = unreachable >= 2 ? { key: t.key, ok: false, error: results[results.length - 1].error, network: true, skipped: true }
        : await region.fetchPicture(t, { actor: ctx.user.id, deadline });
      unreachable = out.network ? unreachable + 1 : 0;
      results.push({ name: t.name, ...out });
    }
    audit.log({ user: ctx.user, action: 'region.pictures.request', ip: ctx.ip, details: { region: ctx.params.id, tried: results.length, ok: results.filter(x => x.ok).length } });
    return { results };
  });
};

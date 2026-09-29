'use strict';
// Secure referral links (server/referral-links.js; docs/security/REFERRAL-LINKS.md).
//
//   Staff (signed in):
//     GET  /api/referrals/:id/links          the links made for a referral and what became of them (referrals:read)
//     POST /api/referrals/:id/links          make one (referrals:write; a packet passes the disclosure gate)
//     POST /api/referral-links/:id/revoke    withdraw one (referrals:write)
//     GET  /api/referral-links/settings      whether links are switched on, the invitation link and the choices of expiry (any signed-in role)
//     PUT  /api/referral-links/settings      switch links on or off, set the invitation link (settings:manage)
//   The recipient (no account; the page at /referral-link.html posts the token from the URL's fragment):
//     POST /api/referral-links/open          open it (the access code the first time, the claim afterwards)
//     POST /api/referral-links/ack           say what happened
//   The public routes are rate limited per address, and all addresses together, on top of the global API limit;
//   a wrong access code counts against the link itself as well.
//
//   "Secure referral links" is a programme setting, off unless an administrator switches it on (security and
//   market reviews of 1.17.0): off, no link can be made and none opens.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const RL = require('../referral-links');
const { validate } = require('../validate');
const { notFound, HttpError, badRequest } = require('../http');

const PUBLIC_PER_10_MIN = 30;
// Every address together: a flood spread over many addresses (IPv6, or a proxy misconfigured) is still bounded.
const PUBLIC_ALL_PER_10_MIN = 600;
function limit(ctx) {
  const { rateLimit } = require('../app');
  if (!rateLimit(`referral-link:${ctx.ip}`, PUBLIC_PER_10_MIN, 10 * 60_000)) throw new HttpError(429, 'Too many attempts from this address. Wait a few minutes and try again.');
  if (!rateLimit('referral-link:*', PUBLIC_ALL_PER_10_MIN, 10 * 60_000)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
}

function referralFor(ctx, id) {
  const r = db.one(`SELECT * FROM referrals WHERE id=?`, id);
  if (!r) throw notFound('Referral not found');
  auth.assertClientAccess(ctx, r.client_id);
  return r;
}

module.exports = (r) => {
  r.get('/api/referral-links/settings', auth.requireAuth, () => ({ enabled: RL.enabled(), invite_url: RL.invite().url, ttl_hours: RL.TTL_HOURS, default_ttl_hours: RL.DEFAULT_TTL_HOURS, max_failed: RL.MAX_FAILED }));
  r.put('/api/referral-links/settings', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const v = validate(ctx.body, { enabled: { type: 'boolean' }, invite_url: { type: 'string', maxLen: 300 } }, { partial: true });
    if (v.invite_url && !/^https:\/\/[^\s<>"']+$/i.test(v.invite_url)) throw badRequest('The invitation link must be an https:// address', { fields: { invite_url: 'must start with https://' } });
    const changed = [];
    if (v.enabled !== undefined && v.enabled !== null) { db.setSetting(RL.SETTING, v.enabled ? '1' : '0'); changed.push(RL.SETTING); }
    if (v.invite_url !== undefined) { if (v.invite_url) db.setSetting('referral_invite_url', v.invite_url); else db.run(`DELETE FROM settings WHERE key='referral_invite_url'`); changed.push('referral_invite_url'); }
    audit.log({ user: ctx.user, action: 'settings.update', ip: ctx.ip, details: { changed, referral_links_enabled: changed.includes(RL.SETTING) ? RL.enabled() : undefined } });
    return { enabled: RL.enabled(), invite_url: RL.invite().url };
  });

  r.get('/api/referrals/:id/links', auth.requireAuth, auth.requirePerm('referrals:read', 'referrals:write'), (ctx) => {
    const ref = referralFor(ctx, ctx.params.id);
    const rows = RL.listFor(ref.id);
    audit.log({ user: ctx.user, action: 'referral_link.list', entity: 'referral', entityId: ref.id, clientId: ref.client_id, ip: ctx.ip, details: { count: rows.length } });
    return { rows, ttl_hours: RL.TTL_HOURS, default_ttl_hours: RL.DEFAULT_TTL_HOURS };
  });

  r.post('/api/referrals/:id/links', auth.requireAuth, auth.requirePerm('referrals:write'), (ctx) => {
    const ref = referralFor(ctx, ctx.params.id);
    const v = validate(ctx.body || {}, {
      kind: { type: 'string', required: true, enum: RL.KINDS }, consent_id: { type: 'string', maxLen: 64 }, message: { type: 'string', maxLen: 1000 },
      include_phone: { type: 'boolean' }, include_dob: { type: 'boolean' }, expires_hours: { type: 'number', integer: true }, _restriction_reviewed: { type: 'boolean' },
    });
    ctx.status = 201;
    return db.transaction(() => RL.create({ referral: ref, user: ctx.user, ip: ctx.ip, v: { ...v, restriction_reviewed: v._restriction_reviewed } }));
  });

  r.post('/api/referral-links/:id/revoke', auth.requireAuth, auth.requirePerm('referrals:write'), (ctx) => {
    const link = db.one(`SELECT * FROM referral_links WHERE id=?`, ctx.params.id);
    if (!link) throw notFound('Link not found');
    auth.assertClientAccess(ctx, link.client_id);
    return RL.revoke({ link, user: ctx.user, ip: ctx.ip });
  });

  // ---- the recipient's side: no session, the token in the body ----
  r.post('/api/referral-links/open', (ctx) => {
    limit(ctx);
    const v = validate(ctx.body || {}, { token: { type: 'string', required: true, maxLen: 100 }, code: { type: 'string', maxLen: 20 }, claim: { type: 'string', maxLen: 100 } });
    return RL.open({ token: v.token, code: v.code, claim: v.claim, ip: ctx.ip });
  });
  r.post('/api/referral-links/ack', (ctx) => {
    limit(ctx);
    const v = validate(ctx.body || {}, { token: { type: 'string', required: true, maxLen: 100 }, claim: { type: 'string', maxLen: 100 }, status: { type: 'string', required: true, enum: RL.ACK_STATUSES },
      by: { type: 'string', required: true, maxLen: 120 }, note: { type: 'string', maxLen: 1000 } });
    return RL.acknowledge({ ...v, ip: ctx.ip });
  });
};

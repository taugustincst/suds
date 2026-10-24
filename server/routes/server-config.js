'use strict';
// Settings › Server configuration (1.27.0, server/server-config.js): what an office server took only from its
// environment until then, set by an administrator in the browser. Office server only (a device has no server).
//
//   GET    /api/admin/server-config         every entry, where its value comes from; a secret only as set or not
//   PUT    /api/admin/server-config/:name   { value } set it here (refused when the environment sets it: that wins)
//   DELETE /api/admin/server-config/:name   remove what was set here
//
// All need settings:manage. A change to a secret, or to anything that decides where data or sign-in goes (an entry
// marked `sensitive`), also needs the administrator's password or authenticator code given again with the request
// (auth.verifySigner, fresh: no window after signing in), as downloading the key backup does: a session alone, at a
// workstation left unlocked, is not enough to hand the copilot's key or the sign-in to someone else. Every change is
// audited with the name, and with the new value for anything but a secret.
const auth = require('../auth');
const audit = require('../audit');
const { HttpError } = require('../http');
const SC = require('../server-config');

module.exports = (r) => {
  const thrown = (e) => { if (e && e.status && !(e instanceof HttpError)) throw new HttpError(e.status, e.message); throw e; };
  const entryOf = (ctx) => { const e = SC.entry(ctx.params.name); if (!e) throw new HttpError(404, 'No such setting'); return e; };
  const confirm = async (ctx, e, verb) => {
    if (!e.sensitive) return null;
    return auth.verifySigner(ctx, ctx.body || {}, { action: 'server_config.update.failed', purpose: `${verb} ${e.label}`, fresh: true });
  };

  r.get('/api/admin/server-config', auth.requireAuth, auth.requirePerm('settings:manage'), () => SC.list());

  r.put('/api/admin/server-config/:name', auth.requireAuth, auth.requirePerm('settings:manage'), async (ctx) => {
    const e = entryOf(ctx);
    const body = ctx.body || {};
    if (!('value' in body)) throw new HttpError(400, 'A value is required');
    // Checked before the password is asked for, so a mistyped value costs no attempt.
    try { SC.check(e.name, body.value); } catch (err) { thrown(err); }
    const method = await confirm(ctx, e, 'change');
    let out;
    try { out = SC.set(e.name, body.value, ctx.user); } catch (err) { thrown(err); }
    audit.log({ user: ctx.user, action: 'server_config.update', entity: 'server_config', entityId: e.name, ip: ctx.ip, details: { name: e.name, ...(e.type === 'secret' ? { secret: true } : { value: out.value }), ...(method ? { method } : {}) } });
    return { ok: true, ...out, restart: !!e.restart };
  });

  r.delete('/api/admin/server-config/:name', auth.requireAuth, auth.requirePerm('settings:manage'), async (ctx) => {
    const e = entryOf(ctx);
    const method = await confirm(ctx, e, 'remove');
    let had;
    try { had = SC.clear(e.name); } catch (err) { thrown(err); }
    if (had) audit.log({ user: ctx.user, action: 'server_config.clear', entity: 'server_config', entityId: e.name, ip: ctx.ip, details: { name: e.name, ...(method ? { method } : {}) } });
    return { ok: true, removed: had, restart: !!e.restart };
  });
};

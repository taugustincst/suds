'use strict';
// Settings → Lists: an administrator changes the choices on documentation forms without a new release.
// Rename a choice, put the list in a different order, retire (hide) a choice the programme does not use,
// add the programme's own, or put a list back as it came. The code stored on records never changes; see
// server/options.js for how the lists are resolved and why some choices are protected.
//
// Every change is audited (list, code, what changed; labels are programme wording, not PHI). The lists are
// the office's: a device that syncs with an office gets them from there and cannot change them here.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const O = require('../options');
const { badRequest, notFound, forbidden } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');

// SUDS on this device (the published static build) has no office behind it, so its administrator keeps
// its lists; a device that syncs with an office server receives them from there (option_overrides is
// pull-only, server/sync-tables.js), and an edit made on it could never reach anyone else.
function assertEditable() {
  const staticHost = typeof window !== 'undefined' && window.SUDS_STATIC_HOST === true;
  if (config.local && !staticHost) throw forbidden('Lists are managed on the office SUDS. Changes made there reach this device when it syncs.');
}

function listOr404(key) { if (!O.has(key)) throw notFound('No such list'); return O.def(key); }
function row(key, code) { return db.one(`SELECT * FROM option_overrides WHERE list_key=? AND code=?`, key, code); }
// One choice's stored differences, created on first change. Only the columns passed are touched.
function upsert(ctx, key, code, fields) {
  const existing = row(key, code); const stamp = db.now();
  if (existing) {
    const keys = Object.keys(fields);
    db.run(`UPDATE option_overrides SET ${keys.map(k => `${k}=?`).join(', ')}, updated_by=?, updated_at=? WHERE id=?`, ...keys.map(k => fields[k]), ctx.user.id, stamp, existing.id);
    return existing.id;
  }
  const id = uuid();
  const cols = { id, list_key: key, code, hidden: 0, is_custom: 0, ...fields, updated_by: ctx.user.id, created_at: stamp, updated_at: stamp };
  db.run(`INSERT INTO option_overrides(${Object.keys(cols).join(',')}) VALUES(${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols));
  return id;
}
function cleanLabel(raw) {
  const label = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!label) throw badRequest('Enter the wording for this choice', { fields: { label: 'required' } });
  if (label.length > O.MAX_LABEL) throw badRequest(`Keep it to ${O.MAX_LABEL} characters`, { fields: { label: `max length ${O.MAX_LABEL}` } });
  return label;
}
// Two choices that read the same cannot be told apart on a form or in a report.
function assertUniqueLabel(key, label, exceptCode) {
  const clash = O.entries(key).find(e => e.code !== exceptCode && e.label.toLowerCase() === label.toLowerCase());
  if (clash) throw badRequest(`"${clash.label}" is already a choice in this list${clash.hidden ? ' (hidden)' : ''}`, { fields: { label: 'already in this list' } });
}

module.exports = (r) => {
  const manage = [auth.requireAuth, auth.requirePerm('settings:manage')];

  r.get('/api/admin/lists', ...manage, () => {
    const staticHost = typeof window !== 'undefined' && window.SUDS_STATIC_HOST === true;
    return { ...O.describe(), editable: !config.local || staticHost };
  });

  // Reword a choice and/or retire or bring it back. A protected choice can be reworded, never hidden.
  r.put('/api/admin/lists/:key/entries/:code', ...manage, (ctx) => {
    assertEditable();
    const l = listOr404(ctx.params.key); const code = ctx.params.code;
    const entry = O.entries(l.key).find(e => e.code === code);
    if (!entry) throw notFound('That choice is not in this list');
    const v = validate(ctx.body, { label: { type: 'string', maxLen: 200 }, hidden: { type: 'boolean' } }, { partial: true });
    const fields = {}; const details = { list: l.key, code };
    if (v.label !== undefined) {
      // A blank label on a built-in choice means "back to the built-in wording".
      if ((v.label === null || v.label === '') && !entry.custom) { fields.label = null; details.label = entry.default_label; }
      else { const label = cleanLabel(v.label); assertUniqueLabel(l.key, label, code); fields.label = entry.custom || label !== entry.default_label ? label : null; details.label = label; details.was = entry.label; }
    }
    if (v.hidden !== undefined) {
      if (v.hidden && entry.protected) throw badRequest(`"${entry.label}" is used by SUDS (${entry.protected}), so it cannot be hidden. It can be reworded.`);
      if (v.hidden && O.visible(l.key).length <= 1 && !entry.hidden) throw badRequest('A list needs at least one choice people can pick');
      fields.hidden = v.hidden ? 1 : 0; details.hidden = !!v.hidden;
    }
    if (!Object.keys(fields).length) throw badRequest('Nothing to change');
    upsert(ctx, l.key, code, fields);
    audit.log({ user: ctx.user, action: 'options.update', entity: 'option_list', entityId: l.key, ip: ctx.ip, details });
    return { ok: true, entries: O.entries(l.key) };
  });

  // Add the programme's own choice. Its code is made from the wording and never matches another choice in
  // the list, built-in or added earlier, so it can never be mistaken for one SUDS relies on.
  r.post('/api/admin/lists/:key/entries', ...manage, (ctx) => {
    assertEditable();
    const l = listOr404(ctx.params.key);
    if (l.custom === false) throw badRequest(l.why || 'Choices cannot be added to this list');
    const v = validate(ctx.body, { label: { type: 'string', required: true, maxLen: 200 } });
    const label = cleanLabel(v.label); assertUniqueLabel(l.key, label);
    const all = O.entries(l.key);
    const taken = new Set([...l.codes, ...all.map(e => e.code), ...db.all(`SELECT code FROM option_overrides WHERE list_key=?`, l.key).map(x => x.code)]);
    const code = O.slug(label, taken);
    // At the end of the list as it is shown now.
    const orders = db.all(`SELECT sort_order FROM option_overrides WHERE list_key=? AND sort_order IS NOT NULL`, l.key).map(x => x.sort_order);
    const sort = Math.max(1000 + l.codes.length, ...orders.map(n => n + 1), 2000 + all.filter(e => e.custom).length);
    upsert(ctx, l.key, code, { label, is_custom: 1, hidden: 0, sort_order: sort });
    audit.log({ user: ctx.user, action: 'options.add', entity: 'option_list', entityId: l.key, ip: ctx.ip, details: { list: l.key, code, label } });
    ctx.status = 201;
    return { code, entries: O.entries(l.key) };
  });

  // The whole list in its new order: every code it has, each once.
  r.put('/api/admin/lists/:key/order', ...manage, (ctx) => {
    assertEditable();
    const l = listOr404(ctx.params.key);
    const v = validate(ctx.body, { codes: { type: 'array', required: true, of: 'string', maxLen: 500 } });
    const current = O.entries(l.key).map(e => e.code);
    const given = v.codes;
    if (new Set(given).size !== given.length || given.length !== current.length || !given.every(c => current.includes(c))) throw badRequest('Send every choice in the list, each once, in the new order');
    db.transaction(() => { given.forEach((code, i) => upsert(ctx, l.key, code, { sort_order: i })); });
    audit.log({ user: ctx.user, action: 'options.reorder', entity: 'option_list', entityId: l.key, ip: ctx.ip, details: { list: l.key, order: given } });
    return { ok: true, entries: O.entries(l.key) };
  });

  // Put a list back as SUDS ships it: built-in wording, order and every built-in choice offered again. The
  // programme's own choices are hidden rather than deleted — records may use them, and they keep their
  // wording there — and can be brought back one by one.
  r.post('/api/admin/lists/:key/reset', ...manage, (ctx) => {
    assertEditable();
    const l = listOr404(ctx.params.key);
    const rows = db.all(`SELECT * FROM option_overrides WHERE list_key=?`, l.key);
    db.transaction(() => {
      for (const x of rows) {
        if (x.is_custom) upsert(ctx, l.key, x.code, { hidden: 1, sort_order: null });
        else upsert(ctx, l.key, x.code, { label: null, sort_order: null, hidden: 0 });
      }
    });
    audit.log({ user: ctx.user, action: 'options.reset', entity: 'option_list', entityId: l.key, ip: ctx.ip, details: { list: l.key, changed: rows.length } });
    return { ok: true, entries: O.entries(l.key) };
  });
};

'use strict';
// Harm-reduction supply inventory: what is on the shelf, and the automatic draw-down when a visit records
// kits or strips handed out. Mounted from routes/interventions.js (the visit is what consumes stock), so it
// reaches local-mode devices through the same route module without touching server/app.js.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');

// Intervention count column -> stock item it draws down. Matching is by name, case-insensitive.
const DRAWDOWN = { naloxone_kits: 'Naloxone kit', fentanyl_strips: 'Fentanyl test strips' };
const list = () => db.all(`SELECT s.*, u.display_name AS updated_by_name FROM supply_stock s LEFT JOIN users u ON u.id=s.updated_by ORDER BY s.item COLLATE NOCASE`);

/**
 * Change the shelf count of each tracked item by `deltas[col]` (positive puts stock back, negative takes it
 * out). Silent when the item is not tracked; never below zero, since a negative shelf count is a
 * data-entry problem to fix by hand. `action` names the audit entry.
 */
function applyDelta(ctx, deltas, { intervention = null, action = 'supply.drawdown' } = {}) {
  for (const [col, item] of Object.entries(DRAWDOWN)) {
    const delta = Number(deltas[col] || 0);
    if (!delta) continue;
    const s = db.one(`SELECT * FROM supply_stock WHERE item=? COLLATE NOCASE`, item);
    if (!s) continue;
    const q = Math.max(0, s.quantity + delta);
    db.run(`UPDATE supply_stock SET quantity=?, updated_by=?, updated_at=? WHERE id=?`, q, ctx.user.id, db.now(), s.id);
    audit.log({ user: ctx.user, action, entity: 'supply_stock', entityId: s.id, ip: ctx.ip, details: { item, delta, quantity: q, intervention } });
  }
}
/** Reduce stock by what a visit handed out (or by the difference when a visit is edited). */
function drawDown(ctx, row, prev = null) {
  const deltas = {};
  for (const col of Object.keys(DRAWDOWN)) deltas[col] = -(Number(row[col] || 0) - Number(prev ? prev[col] || 0 : 0));
  applyDelta(ctx, deltas, { intervention: row.id });
}
/** Put back what a visit had drawn down — called when the visit is deleted. */
function restore(ctx, row) {
  const deltas = {};
  for (const col of Object.keys(DRAWDOWN)) deltas[col] = Number(row[col] || 0);
  applyDelta(ctx, deltas, { intervention: row.id, action: 'supply.restore' });
}

module.exports = (r) => {
  // Every role may see what is on hand; changing it is a field-staff action (navigator, clinician, supervisor, admin).
  // The cupboard belongs to the staff who record the visits that draw it down. A read-only or finance
  // account has no visits to record, so it has no reason to see the shelf count either.
  r.get('/api/supplies', auth.requireAuth, auth.requirePerm('interventions:read'), () => ({ rows: list(), drawdown: DRAWDOWN }));
  r.post('/api/supplies', auth.requireAuth, auth.requirePerm('interventions:write'), (ctx) => {
    const v = validate(ctx.body, { item: { type: 'string', required: true, maxLen: 80 }, quantity: { type: 'number', required: true, integer: true, min: 0, max: 1000000 } });
    const item = v.item.trim(); if (!item) throw badRequest('Item name is required');
    const existing = db.one(`SELECT id FROM supply_stock WHERE item=? COLLATE NOCASE`, item);
    let id = existing ? existing.id : null;
    if (existing) db.run(`UPDATE supply_stock SET quantity=?, updated_by=?, updated_at=? WHERE id=?`, v.quantity, ctx.user.id, db.now(), id);
    else { id = uuid(); db.run(`INSERT INTO supply_stock(id,item,quantity,updated_by) VALUES(?,?,?,?)`, id, item, v.quantity, ctx.user.id); }
    audit.log({ user: ctx.user, action: existing ? 'supply.update' : 'supply.create', entity: 'supply_stock', entityId: id, ip: ctx.ip, details: { item, quantity: v.quantity } });
    ctx.status = existing ? 200 : 201; return { id, item, quantity: v.quantity };
  });
  r.put('/api/supplies/:id', auth.requireAuth, auth.requirePerm('interventions:write'), (ctx) => {
    const s = db.one(`SELECT * FROM supply_stock WHERE id=?`, ctx.params.id);
    if (!s) throw notFound('Supply item not found');
    const v = validate(ctx.body, { item: { type: 'string', maxLen: 80 }, quantity: { type: 'number', integer: true, min: 0, max: 1000000 }, adjust: { type: 'number', integer: true, min: -1000000, max: 1000000 } }, { partial: true });
    const quantity = v.quantity !== undefined && v.quantity !== null ? v.quantity : Math.max(0, s.quantity + Number(v.adjust || 0));
    const item = v.item ? v.item.trim() : s.item;
    db.run(`UPDATE supply_stock SET item=?, quantity=?, updated_by=?, updated_at=? WHERE id=?`, item, quantity, ctx.user.id, db.now(), s.id);
    audit.log({ user: ctx.user, action: 'supply.update', entity: 'supply_stock', entityId: s.id, ip: ctx.ip, details: { item, quantity, was: s.quantity } });
    return { ok: true, quantity };
  });
  r.delete('/api/supplies/:id', auth.requireAuth, auth.requirePerm('interventions:write'), (ctx) => {
    const s = db.one(`SELECT * FROM supply_stock WHERE id=?`, ctx.params.id);
    if (!s) throw notFound('Supply item not found');
    db.run(`DELETE FROM supply_stock WHERE id=?`, s.id); db.tombstone('supply_stock', s.id);
    audit.log({ user: ctx.user, action: 'supply.delete', entity: 'supply_stock', entityId: s.id, ip: ctx.ip, details: { item: s.item } });
    return { ok: true };
  });
};
module.exports.drawDown = drawDown;
module.exports.restore = restore;
module.exports.applyDelta = applyDelta;
module.exports.DRAWDOWN = DRAWDOWN;

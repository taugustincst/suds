'use strict';
// Supplies (docs/SUPPLIES.md): items kept at sites in lots, a receiving log, transfers between sites,
// adjustments with a reason and disposal of expired stock, all as rows of an append-only ledger
// (server/supplies.js). A visit's own draw-down happens in server/routes/interventions.js. Mounted from
// routes/interventions.js (the visit is what consumes stock), so it reaches local-mode devices through the
// same route module without touching server/app.js.
//
// Permissions (server/auth.js): supplies:read to see the stock, supplies:receive to record stock received,
// supplies:manage for everything else. Items, sites and the supply settings are the office's on a device that
// syncs with one (pull-only, server/sync-tables.js); stock movements recorded on it are pushed and checked there.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const S = require('../supplies');
const N = require('../supply-names');
const { badRequest, notFound, HttpError } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');

const QTY = { type: 'number', integer: true, min: 1, max: S.MAX_QTY };
const LOT = { lot_number: { type: 'string', maxLen: 60 }, expires_on: { type: 'date' } };

// SUDS on this device (the published static build) has no office behind it, so it keeps its own items and
// sites; a device that syncs with an office receives them from there and could never send a change back.
function assertConfigurable() {
  const staticHost = typeof window !== 'undefined' && window.SUDS_STATIC_HOST === true;
  if (config.local && !staticHost) throw new HttpError(403, 'Supply items, sites and settings are kept at the office: change them in the office SUDS. Stock you receive, move or count here is sent there when you sync.', { serverOwned: true });
}
const configurable = () => { try { assertConfigurable(); return true; } catch { return false; } };

function itemOr404(id) { const it = S.item(id); if (!it) throw notFound('Supply item not found'); return it; }
function siteOr404(id, label = 'site') { const s = S.site(id); if (!s) throw notFound(`Supply ${label} not found`); return s; }
function activeSiteOr400(id, field = 'site_id') { const s = S.site(id); if (!s) throw badRequest('Validation failed', { fields: { [field]: 'is not one of this program\'s supply sites' } }); if (!s.is_active) throw badRequest('Validation failed', { fields: { [field]: `${s.name} is no longer in use` } }); return s; }
const dateOr = (d) => d || S.today();
function checkLot(v) {
  if (v.lot_number !== undefined && v.lot_number !== null && /[\u0000-\u001f]/.test(v.lot_number)) throw badRequest('Validation failed', { fields: { lot_number: 'has characters a lot number does not use' } });
}
const log = (ctx, action, entry, details = {}) => audit.log({ user: ctx.user, action, entity: 'supply_ledger', entityId: entry ? entry.id : null, ip: ctx.ip, details: { ...details } });

/** Items as the old single-number cupboard listed them (GET /api/supplies rows), for screens and scripts that read it. */
function legacyRows(stock) {
  const users = new Map(db.all(`SELECT id, display_name FROM users`).map(u => [u.id, u.display_name]));
  return S.items().filter(i => i.is_active).map(i => {
    const q = stock.bySite.filter(x => x.item_id === i.id).reduce((n, x) => n + x.quantity, 0);
    const last = db.one(`SELECT user_id, created_at FROM supply_ledger WHERE item_id=? ORDER BY created_at DESC LIMIT 1`, i.id);
    return { id: i.id, item: i.name, quantity: q, category: i.category, unit: i.unit, updated_at: last ? last.created_at : i.updated_at, updated_by_name: users.get(last ? last.user_id : i.updated_by) || null };
  });
}
const meta = () => ({
  categories: N.CATEGORIES, products: N.NALOXONE_PRODUCTS, sources: N.SOURCES, adjust_reasons: N.ADJUST_REASONS, disposal_reasons: N.DISPOSAL_REASONS,
  site_kinds: N.SITE_KINDS, kinds: N.KIND_LABELS,
});
function settingsOut() {
  return { default_site_id: S.defaultSiteId(), expiry_warn_days: S.expiryWarnDays(), syringes_per_litre: S.syringesPerLitre() };
}

/** Create an item (and, given `opening`, its opening stock): shared by POST /items and the older POST /api/supplies. */
function createItem(ctx, v) {
  const name = v.name.trim(); if (!name) throw badRequest('Validation failed', { fields: { name: 'is required' } });
  if (S.nameTaken('supply_items', name)) throw badRequest('Validation failed', { fields: { name: `${name} is already on the list` } });
  const category = v.category || N.categoryFromName(name);
  if (v.product && category !== 'naloxone') throw badRequest('Validation failed', { fields: { product: 'is recorded for naloxone only' } });
  const id = uuid();
  const order = (db.one(`SELECT COALESCE(MAX(sort_order),0) n FROM supply_items`).n || 0) + 1;
  db.run(`INSERT INTO supply_items(id,name,category,product,unit,quick,low_stock,sort_order,updated_by) VALUES(?,?,?,?,?,?,?,?,?)`,
    id, name, category, v.product || null, (v.unit || '').trim() || N.unitFor(category, name), v.quick ? 1 : 0, v.low_stock ?? null, order, ctx.user.id);
  audit.log({ user: ctx.user, action: 'supply.item.create', entity: 'supply_items', entityId: id, ip: ctx.ip, details: { name, category, product: v.product || undefined } });
  return id;
}

module.exports = (r) => {
  const read = [auth.requireAuth, auth.requirePerm('supplies:read')];
  const manage = [auth.requireAuth, auth.requirePerm('supplies:manage')];
  // The office's own configuration: on a device that syncs with an office the reason it cannot change is said
  // first, whoever asks (a navigator there is told the same as a supervisor).
  const officeOwned = () => assertConfigurable();
  const configure = [auth.requireAuth, officeOwned, auth.requirePerm('supplies:manage')];

  // Everything the Supplies page shows: items, sites, stock per site and per lot, and the alerts. The rows in
  // the shape the single-number cupboard had (id, item, quantity) are kept for anything that still reads them.
  r.get('/api/supplies', ...read, (ctx) => {
    const stock = S.stock();
    const me = db.one(`SELECT default_site_id FROM users WHERE id=?`, ctx.user.id);
    const al = S.alerts({ date: stock.date, stock });
    const naloxone = S.defaultItemFor('naloxone'); const fts = S.defaultItemFor('fentanyl_test_strips');
    return {
      rows: legacyRows(stock),
      // Which items a visit's naloxone and fentanyl test strip counts are drawn from when it lists no items.
      drawdown: { naloxone_kits: naloxone ? naloxone.name : null, fentanyl_strips: fts ? fts.name : null },
      items: S.items(), sites: S.sites(), stock: stock.bySite, lots: stock.lots,
      alerts: { counts: al.counts, expired: al.expired, expiring: al.expiring, low: al.low, shortfalls: al.shortfalls, warn_days: al.warn_days },
      settings: settingsOut(), my_site_id: me && S.activeSite(me.default_site_id) ? me.default_site_id : null, my_effective_site_id: S.siteForUser(ctx.user.id),
      meta: meta(), date: stock.date,
      can: { receive: auth.hasPerm(ctx.user, 'supplies:receive'), manage: auth.hasPerm(ctx.user, 'supplies:manage'), configure: auth.hasPerm(ctx.user, 'supplies:manage') && configurable(), choose_site: configurable() },
    };
  });

  // What the visit form needs: the items a worker can hand out, the sites, and where this worker draws from.
  // Anyone who records visits (interventions:write) may read it.
  r.get('/api/supplies/catalog', auth.requireAuth, auth.requirePerm('interventions:write', 'supplies:read'), (ctx) => ({
    items: S.items({ all: false }).map(({ id, name, category, product, unit, quick }) => ({ id, name, category, product, unit, quick })),
    sites: S.sites({ all: false }).map(({ id, name, kind }) => ({ id, name, kind })),
    site_id: S.siteForUser(ctx.user.id), syringes_per_litre: S.syringesPerLitre(), categories: N.CATEGORIES, products: N.NALOXONE_PRODUCTS,
    // Whether this caller can add an item here (supplies:manage, on a copy that owns its configuration): the
    // visit form offers "Add naloxone kits and test strips" when the programme keeps neither, else says who can.
    can_configure: auth.hasPerm(ctx.user, 'supplies:manage') && configurable(),
  }));

  // The expiry and stock alerts, for the Home page of whoever runs the cupboard.
  r.get('/api/supplies/alerts', ...read, () => S.alerts());

  // The ledger: every movement, newest first. Filters: item_id, site_id, kind, from, to (dates), flagged=1.
  r.get('/api/supplies/ledger', ...read, (ctx) => {
    const q = ctx.query; const where = ['1=1']; const p = [];
    for (const k of ['item_id', 'site_id', 'kind']) if (q.get(k)) { where.push(`l.${k}=?`); p.push(q.get(k)); }
    if (q.get('from')) { where.push('l.occurred_on >= ?'); p.push(q.get('from')); }
    if (q.get('to')) { where.push('l.occurred_on <= ?'); p.push(q.get('to')); }
    if (q.get('flagged') === '1') where.push('l.flagged=1');
    const limit = Math.min(500, Math.max(1, Number(q.get('limit') || 100))); const offset = Math.max(0, Number(q.get('offset') || 0));
    const rows = db.all(`SELECT l.*, i.name AS item_name, i.unit, s.name AS site_name, u.display_name AS user_name, f.name AS fund_name FROM supply_ledger l
      JOIN supply_items i ON i.id=l.item_id JOIN supply_sites s ON s.id=l.site_id LEFT JOIN users u ON u.id=l.user_id LEFT JOIN funding_sources f ON f.id=l.funding_source_id
      WHERE ${where.join(' AND ')} ORDER BY l.occurred_on DESC, l.created_at DESC, l.id LIMIT ? OFFSET ?`, ...p, limit, offset);
    const total = db.one(`SELECT COUNT(*) n FROM supply_ledger l WHERE ${where.join(' AND ')}`, ...p).n;
    return { rows, total, limit, offset };
  });

  // ---- items and sites (supplies:manage; the office's own, or SUDS on this device's) ----
  const ITEM = { name: { type: 'string', required: true, maxLen: 80 }, category: { type: 'string', enum: N.codes(N.CATEGORIES) }, product: { type: 'string', enum: N.codes(N.NALOXONE_PRODUCTS) },
    unit: { type: 'string', maxLen: 30 }, quick: { type: 'boolean' }, low_stock: { type: 'number', integer: true, min: 0, max: S.MAX_QTY }, is_active: { type: 'boolean' }, sort_order: { type: 'number', integer: true, min: 0, max: 100000 } };
  r.post('/api/supplies/items', ...configure, (ctx) => {
    const v = validate(ctx.body, { ...ITEM, opening: { type: 'object' } });
    // Optional opening stock with the item, so a first set-up is one step: { quantity, site_id?, lot_number?, expires_on? }.
    const o = v.opening ? validate(v.opening, { quantity: { ...QTY, required: true }, site_id: { type: 'string' }, ...LOT }) : null;
    if (o) { checkLot(o); if (o.site_id) activeSiteOr400(o.site_id); else if (!S.defaultSiteId()) throw badRequest('Add a supply site first'); }
    let id;
    db.transaction(() => {
      id = createItem(ctx, v);
      if (o) { const e = S.addEntry({ item_id: id, site_id: o.site_id || S.defaultSiteId(), kind: 'opening', quantity: o.quantity, lot_number: o.lot_number, expires_on: o.expires_on }, ctx.user); log(ctx, 'supply.opening', e, { item: v.name, quantity: o.quantity }); }
    });
    ctx.status = 201; return { id };
  });
  r.put('/api/supplies/items/:id', ...configure, (ctx) => {
    const it = itemOr404(ctx.params.id);
    const v = validate(ctx.body, ITEM, { partial: true });
    if (v.name !== undefined) { v.name = v.name.trim(); if (!v.name) throw badRequest('Validation failed', { fields: { name: 'is required' } }); if (S.nameTaken('supply_items', v.name, it.id)) throw badRequest('Validation failed', { fields: { name: `${v.name} is already on the list` } }); }
    const category = v.category || it.category;
    if ((v.product ?? it.product) && category !== 'naloxone') { if (v.product) throw badRequest('Validation failed', { fields: { product: 'is recorded for naloxone only' } }); v.product = null; }
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    if (keys.length) db.run(`UPDATE supply_items SET ${keys.map(k => `${k}=?`).join(', ')}, updated_by=?, updated_at=? WHERE id=?`, ...keys.map(k => v[k]), ctx.user.id, db.now(), it.id);
    audit.log({ user: ctx.user, action: 'supply.item.update', entity: 'supply_items', entityId: it.id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true };
  });
  const SITE = { name: { type: 'string', required: true, maxLen: 80 }, kind: { type: 'string', enum: N.codes(N.SITE_KINDS) }, is_active: { type: 'boolean' }, sort_order: { type: 'number', integer: true, min: 0, max: 100000 } };
  r.post('/api/supplies/sites', ...configure, (ctx) => {
    const v = validate(ctx.body, SITE);
    const name = v.name.trim(); if (!name) throw badRequest('Validation failed', { fields: { name: 'is required' } });
    if (S.nameTaken('supply_sites', name)) throw badRequest('Validation failed', { fields: { name: `${name} is already a site` } });
    const id = uuid(); const order = (db.one(`SELECT COALESCE(MAX(sort_order),0) n FROM supply_sites`).n || 0) + 1;
    db.run(`INSERT INTO supply_sites(id,name,kind,sort_order,updated_by) VALUES(?,?,?,?,?)`, id, name, v.kind || 'other', v.sort_order ?? order, ctx.user.id);
    audit.log({ user: ctx.user, action: 'supply.site.create', entity: 'supply_sites', entityId: id, ip: ctx.ip, details: { name, kind: v.kind || 'other' } });
    ctx.status = 201; return { id };
  });
  r.put('/api/supplies/sites/:id', ...configure, (ctx) => {
    const s = siteOr404(ctx.params.id);
    const v = validate(ctx.body, SITE, { partial: true });
    if (v.name !== undefined) { v.name = v.name.trim(); if (!v.name) throw badRequest('Validation failed', { fields: { name: 'is required' } }); if (S.nameTaken('supply_sites', v.name, s.id)) throw badRequest('Validation failed', { fields: { name: `${v.name} is already a site` } }); }
    if (v.is_active === 0 && !db.one(`SELECT 1 FROM supply_sites WHERE is_active=1 AND id<>?`, s.id)) throw badRequest('This is the only site in use. Add another before taking this one out of use.');
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    if (keys.length) db.run(`UPDATE supply_sites SET ${keys.map(k => `${k}=?`).join(', ')}, updated_by=?, updated_at=? WHERE id=?`, ...keys.map(k => v[k]), ctx.user.id, db.now(), s.id);
    audit.log({ user: ctx.user, action: 'supply.site.update', entity: 'supply_sites', entityId: s.id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true };
  });
  // The programme's supply settings: the default site, how early an expiry is flagged, and the syringes a litre
  // of returned sharps is counted as when a return is estimated from its container.
  r.put('/api/supplies/settings', ...configure, (ctx) => {
    const v = validate(ctx.body, { default_site_id: { type: 'string' }, expiry_warn_days: { type: 'number', integer: true, min: 1, max: 365 }, syringes_per_litre: { type: 'number', min: 1, max: 1000 } }, { partial: true });
    if (v.default_site_id) activeSiteOr400(v.default_site_id, 'default_site_id');
    if (v.default_site_id !== undefined) db.setSetting('default_supply_site_id', v.default_site_id || '');
    if (v.expiry_warn_days !== undefined && v.expiry_warn_days !== null) db.setSetting('supply_expiry_warn_days', v.expiry_warn_days);
    if (v.syringes_per_litre !== undefined && v.syringes_per_litre !== null) db.setSetting('supply_syringes_per_litre', v.syringes_per_litre);
    audit.log({ user: ctx.user, action: 'supply.settings', ip: ctx.ip, details: { fields: Object.keys(v) } });
    return settingsOut();
  });
  // The site a worker's own visits draw from unless the visit names another. Anyone who sees the stock may choose theirs.
  r.put('/api/supplies/my-site', auth.requireAuth, officeOwned, auth.requirePerm('supplies:read'), (ctx) => {
    const v = validate(ctx.body, { site_id: { type: 'string' } });
    if (v.site_id) activeSiteOr400(v.site_id);
    db.run(`UPDATE users SET default_site_id=?, updated_at=? WHERE id=?`, v.site_id || null, db.now(), ctx.user.id);
    audit.log({ user: ctx.user, action: 'supply.my_site', entity: 'users', entityId: ctx.user.id, ip: ctx.ip, details: { site_id: v.site_id || null } });
    return { site_id: v.site_id || null, effective_site_id: S.siteForUser(ctx.user.id) };
  });

  // ---- stock movements (each a ledger row, never changed afterwards) ----
  // Stock received: a delivery from the NDP, the CDPH clearinghouse, a purchase or a donation. Field staff record their site's.
  r.post('/api/supplies/receipts', auth.requireAuth, auth.requirePerm('supplies:receive'), (ctx) => {
    const v = validate(ctx.body, { item_id: { type: 'string', required: true }, site_id: { type: 'string', required: true }, quantity: { ...QTY, required: true }, ...LOT,
      received_on: { type: 'date' }, source: { type: 'string', enum: N.codes(N.SOURCES) }, funding_source_id: { type: 'string' }, reference: { type: 'string', maxLen: 120 } });
    checkLot(v);
    const it = itemOr404(v.item_id); if (!it.is_active) throw badRequest('Validation failed', { fields: { item_id: `${it.name} is no longer offered` } });
    activeSiteOr400(v.site_id);
    if (v.funding_source_id && !db.one(`SELECT 1 FROM funding_sources WHERE id=?`, v.funding_source_id)) throw badRequest('Validation failed', { fields: { funding_source_id: 'is not one of this program\'s funding sources' } });
    if (v.funding_source_id && v.source && v.source !== 'purchase') throw badRequest('Validation failed', { fields: { funding_source_id: 'is recorded for a purchase only' } });
    const e = S.addEntry({ item_id: it.id, site_id: v.site_id, kind: 'received', quantity: v.quantity, lot_number: v.lot_number, expires_on: v.expires_on, occurred_on: dateOr(v.received_on),
      source: v.source || null, funding_source_id: v.funding_source_id || null, reference: v.reference || null }, ctx.user);
    log(ctx, 'supply.receive', e, { item: it.name, site: v.site_id, quantity: v.quantity, source: v.source || undefined });
    ctx.status = 201; return { id: e.id, on_hand: S.onHand(it.id, v.site_id) };
  });

  // A transfer between sites: out of one and into the other in the same step. A lot named moves that lot;
  // otherwise the earliest-expiring stock moves first. Never more than the sending site holds.
  r.post('/api/supplies/transfers', ...manage, (ctx) => {
    const v = validate(ctx.body, { item_id: { type: 'string', required: true }, from_site_id: { type: 'string', required: true }, to_site_id: { type: 'string', required: true }, quantity: { ...QTY, required: true }, ...LOT, occurred_on: { type: 'date' }, reference: { type: 'string', maxLen: 120 } });
    checkLot(v);
    const it = itemOr404(v.item_id); siteOr404(v.from_site_id, 'site to move from'); activeSiteOr400(v.to_site_id, 'to_site_id');
    if (v.from_site_id === v.to_site_id) throw badRequest('Validation failed', { fields: { to_site_id: 'must be a different site' } });
    const date = dateOr(v.occurred_on); const transferId = uuid();
    const lotNamed = v.lot_number !== undefined && v.lot_number !== null || !!v.expires_on;
    const source = lotNamed ? [{ lot_number: v.lot_number || '', expires_on: v.expires_on || null, quantity: S.lotOnHand(it.id, v.from_site_id, v.lot_number || '', v.expires_on || null) }] : S.lots(it.id, v.from_site_id, { date });
    const available = source.reduce((n, l) => n + Math.max(0, l.quantity), 0);
    if (available < v.quantity) throw badRequest(`Only ${available} ${it.unit} of ${it.name} ${lotNamed ? 'in that lot ' : ''}on hand at that site`, { fields: { quantity: `at most ${available}` } });
    const moved = [];
    db.transaction(() => {
      let left = v.quantity;
      for (const l of source) {
        if (left <= 0) break; const take = Math.min(left, l.quantity); if (take <= 0) continue;
        const common = { item_id: it.id, lot_number: l.lot_number, expires_on: l.expires_on, occurred_on: date, transfer_id: transferId, reference: v.reference || null };
        moved.push(S.addEntry({ ...common, site_id: v.from_site_id, kind: 'transfer_out', quantity: -take }, ctx.user), S.addEntry({ ...common, site_id: v.to_site_id, kind: 'transfer_in', quantity: take }, ctx.user));
        left -= take;
      }
    });
    log(ctx, 'supply.transfer', moved[0], { item: it.name, from: v.from_site_id, to: v.to_site_id, quantity: v.quantity, transfer: transferId });
    ctx.status = 201; return { transfer_id: transferId, entries: moved.length };
  });

  // An adjustment with a reason: a count correction (give `counted`, what is on the shelf, or `quantity`, the
  // change), damaged, expired, lost or other. It never takes a lot below zero.
  r.post('/api/supplies/adjustments', ...manage, (ctx) => {
    const v = validate(ctx.body, { item_id: { type: 'string', required: true }, site_id: { type: 'string', required: true }, quantity: { type: 'number', integer: true, min: -S.MAX_QTY, max: S.MAX_QTY }, counted: { type: 'number', integer: true, min: 0, max: S.MAX_QTY },
      reason: { type: 'string', required: true, enum: N.codes(N.ADJUST_REASONS) }, ...LOT, occurred_on: { type: 'date' } });
    checkLot(v);
    const it = itemOr404(v.item_id); siteOr404(v.site_id);
    const lot = v.lot_number || ''; const exp = v.expires_on || null;
    const had = S.lotOnHand(it.id, v.site_id, lot, exp);
    let delta;
    if (v.counted !== undefined && v.counted !== null) delta = v.counted - had;
    else if (v.quantity !== undefined && v.quantity !== null) delta = v.quantity;
    else throw badRequest('Validation failed', { fields: { quantity: 'give the change, or what was counted on the shelf' } });
    if (!delta) throw badRequest('That is what the books already show: nothing to adjust.');
    if (v.reason !== 'count_correction' && v.reason !== 'other' && delta > 0) throw badRequest('Validation failed', { fields: { quantity: 'stock damaged, expired or lost is taken off: enter it as a negative number' } });
    if (had + delta < 0) throw badRequest(`Only ${had} ${it.unit} of ${it.name} ${lot || exp ? 'in that lot ' : ''}on the books at that site: an adjustment cannot take it below zero`, { fields: { quantity: `at least ${-had}` } });
    const e = S.addEntry({ item_id: it.id, site_id: v.site_id, kind: 'adjustment', quantity: delta, lot_number: lot, expires_on: exp, reason: v.reason, occurred_on: dateOr(v.occurred_on) }, ctx.user);
    log(ctx, 'supply.adjust', e, { item: it.name, site: v.site_id, quantity: delta, reason: v.reason });
    ctx.status = 201; return { id: e.id, quantity: delta, on_hand: S.onHand(it.id, v.site_id) };
  });

  // Disposal: expired, damaged or recalled stock destroyed. The whole lot unless a quantity is given.
  r.post('/api/supplies/disposals', ...manage, (ctx) => {
    const v = validate(ctx.body, { item_id: { type: 'string', required: true }, site_id: { type: 'string', required: true }, quantity: QTY, reason: { type: 'string', required: true, enum: N.codes(N.DISPOSAL_REASONS) }, ...LOT, occurred_on: { type: 'date' } });
    checkLot(v);
    const it = itemOr404(v.item_id); siteOr404(v.site_id);
    const lot = v.lot_number || ''; const exp = v.expires_on || null;
    const had = S.lotOnHand(it.id, v.site_id, lot, exp);
    const q = v.quantity ?? had;
    if (!(had > 0)) throw badRequest('Nothing of that lot is on hand at that site');
    if (q > had) throw badRequest(`Only ${had} ${it.unit} in that lot at that site`, { fields: { quantity: `at most ${had}` } });
    const e = S.addEntry({ item_id: it.id, site_id: v.site_id, kind: 'disposal', quantity: -q, lot_number: lot, expires_on: exp, reason: v.reason, occurred_on: dateOr(v.occurred_on) }, ctx.user);
    log(ctx, 'supply.dispose', e, { item: it.name, site: v.site_id, quantity: q, reason: v.reason, lot: lot || undefined });
    ctx.status = 201; return { id: e.id, quantity: q };
  });

  // ---- the single-number cupboard's routes (1.13 and earlier), kept working on the ledger ----
  // POST { item, quantity }: the item (created if new) is set to that count at the programme's default site
  // (an opening balance for a new item, a count correction otherwise). PUT { adjust } or { quantity } likewise;
  // DELETE takes the item out of use (its history stays). All supplies:manage.
  function setCount(ctx, it, quantity) {
    const siteId = S.defaultSiteId(); if (!siteId) throw badRequest('Add a supply site first');
    const had = S.onHand(it.id, siteId);
    if (quantity === had) return had;
    const fresh = !db.one(`SELECT 1 FROM supply_ledger WHERE item_id=? AND site_id=?`, it.id, siteId);
    if (quantity < had) {
      // Taken off the stock that expires first, lot by lot, so no lot goes below zero.
      let cut = had - quantity;
      for (const l of S.lots(it.id, siteId)) { if (cut <= 0) break; const c = Math.min(cut, l.quantity); S.addEntry({ item_id: it.id, site_id: siteId, kind: 'adjustment', quantity: -c, lot_number: l.lot_number, expires_on: l.expires_on, reason: 'count_correction' }, ctx.user); cut -= c; }
    } else S.addEntry({ item_id: it.id, site_id: siteId, kind: fresh ? 'opening' : 'adjustment', quantity: quantity - had, reason: fresh ? null : 'count_correction' }, ctx.user);
    audit.log({ user: ctx.user, action: fresh ? 'supply.opening' : 'supply.adjust', entity: 'supply_items', entityId: it.id, ip: ctx.ip, details: { item: it.name, quantity, was: had } });
    return quantity;
  }
  r.post('/api/supplies', ...configure, (ctx) => {
    const v = validate(ctx.body, { item: { type: 'string', required: true, maxLen: 80 }, quantity: { type: 'number', required: true, integer: true, min: 0, max: S.MAX_QTY } });
    const name = v.item.trim(); if (!name) throw badRequest('Item name is required');
    let it = db.one(`SELECT * FROM supply_items WHERE name=? COLLATE NOCASE`, name);
    const created = !it;
    db.transaction(() => {
      if (!it) it = S.item(createItem(ctx, { name, quick: ['naloxone', 'fentanyl_test_strips'].includes(N.categoryFromName(name)) }));
      else if (!it.is_active) db.run(`UPDATE supply_items SET is_active=1, updated_by=?, updated_at=? WHERE id=?`, ctx.user.id, db.now(), it.id);
      setCount(ctx, it, v.quantity);
    });
    ctx.status = created ? 201 : 200; return { id: it.id, item: it.name, quantity: v.quantity };
  });
  r.put('/api/supplies/:id', ...configure, (ctx) => {
    const it = itemOr404(ctx.params.id);
    const v = validate(ctx.body, { item: { type: 'string', maxLen: 80 }, quantity: { type: 'number', integer: true, min: 0, max: S.MAX_QTY }, adjust: { type: 'number', integer: true, min: -S.MAX_QTY, max: S.MAX_QTY } }, { partial: true });
    const siteId = S.defaultSiteId();
    let quantity;
    db.transaction(() => {
      if (v.item && v.item.trim() && v.item.trim() !== it.name) {
        if (S.nameTaken('supply_items', v.item, it.id)) throw badRequest('Validation failed', { fields: { item: `${v.item.trim()} is already on the list` } });
        db.run(`UPDATE supply_items SET name=?, updated_by=?, updated_at=? WHERE id=?`, v.item.trim(), ctx.user.id, db.now(), it.id);
      }
      const had = siteId ? S.onHand(it.id, siteId) : 0;
      quantity = setCount(ctx, it, v.quantity !== undefined && v.quantity !== null ? v.quantity : Math.max(0, had + Number(v.adjust || 0)));
    });
    return { ok: true, quantity };
  });
  r.delete('/api/supplies/:id', ...configure, (ctx) => {
    const it = itemOr404(ctx.params.id);
    db.run(`UPDATE supply_items SET is_active=0, quick=0, updated_by=?, updated_at=? WHERE id=?`, ctx.user.id, db.now(), it.id);
    audit.log({ user: ctx.user, action: 'supply.item.retire', entity: 'supply_items', entityId: it.id, ip: ctx.ip, details: { item: it.name } });
    return { ok: true };
  });
};

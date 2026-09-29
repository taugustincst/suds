'use strict';
// The supply model (docs/SUPPLIES.md): items kept at sites in lots, an append-only stock ledger whose sum is
// what is on hand, and the items a visit hands out. The routes (server/routes/supplies.js), the visit route
// (server/routes/interventions.js), sync (server/rules/: interventions, intervention_supplies, supply_ledger) and the reports all go through here, and so
// does the browser kernel, which runs this same file.
//
// Who draws stock down for a visit. A visit's items (intervention_supplies) are the record of what was handed
// out; the ledger rows that take them off the shelf are worked out from them by reconcileVisit(), by
// difference from what the ledger already holds for that visit, so saving the same visit twice draws once.
// On the office server that is the only draw-down there is. A device that syncs with an office draws down its
// own copy too, so what a worker sees offline is right, but those rows are provisional: they are never pushed
// (the office works the draw-down out from the visit, against its own stock) and are replaced by the office's
// rows when they arrive (local/sync.js). SUDS on this device has no office, and its own rows are its ledger.
const db = require('./db');
const audit = require('./audit');
const N = require('./supply-names');
const { uuid } = require('./crypto');
const { badRequest } = require('./http');

const KINDS = ['opening', 'received', 'transfer_out', 'transfer_in', 'adjustment', 'disposal', 'distributed', 'restored'];
const POSITIVE = ['opening', 'received', 'transfer_in', 'restored'];
const NEGATIVE = ['transfer_out', 'disposal', 'distributed'];
// Visit draw-downs, and the shortfall adjustments a draw-down writes: always the office's own work.
const VISIT_KINDS = ['distributed', 'restored'];
const SHORTFALL = 'shortfall';
const DEFAULTS = { expiry_warn_days: 60, syringes_per_litre: 100 };
const MAX_QTY = 1000000;

const budget = () => require('./routes/budget');
const today = () => budget().localDate();
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** The calendar day a visit's supplies left the shelf: its service date in the programme's time zone. */
function dayOf(at) { if (!at) return today(); const s = String(at); return s.length === 10 ? s : (budget().localDate(s) || s.slice(0, 10)); }

// ---- settings ----
function setting(key) {
  const raw = db.getSetting(`supply_${key}`, null);
  const n = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULTS[key];
}
const expiryWarnDays = () => Math.min(365, Math.round(setting('expiry_warn_days')));
const syringesPerLitre = () => setting('syringes_per_litre');

// ---- items and sites ----
const item = (id) => (id ? db.one(`SELECT * FROM supply_items WHERE id=?`, id) : null);
const site = (id) => (id ? db.one(`SELECT * FROM supply_sites WHERE id=?`, id) : null);
const activeSite = (id) => (id ? db.one(`SELECT * FROM supply_sites WHERE id=? AND is_active=1`, id) : null);
const items = ({ all = true } = {}) => db.all(`SELECT * FROM supply_items ${all ? '' : 'WHERE is_active=1'} ORDER BY is_active DESC, sort_order, name COLLATE NOCASE`);
const sites = ({ all = true } = {}) => db.all(`SELECT * FROM supply_sites ${all ? '' : 'WHERE is_active=1'} ORDER BY is_active DESC, sort_order, name COLLATE NOCASE`);
/** The programme's default site: the one chosen in Supplies settings, else the main office, else the first active one. */
function defaultSiteId() {
  for (const id of [db.getSetting('default_supply_site_id', null), db.MAIN_SITE_ID]) if (activeSite(id)) return id;
  const first = db.one(`SELECT id FROM supply_sites WHERE is_active=1 ORDER BY sort_order, name COLLATE NOCASE LIMIT 1`);
  return first ? first.id : null;
}
/** The site a worker's visits draw from unless the visit names one: their own, else the programme's. */
function siteForUser(userId) {
  const u = userId ? db.one(`SELECT default_site_id FROM users WHERE id=?`, userId) : null;
  return (u && activeSite(u.default_site_id) ? u.default_site_id : null) || defaultSiteId();
}
/** The first active item of a category, the programme's usual one first: where a bare count is drawn from. */
function defaultItemFor(category) {
  return db.one(`SELECT * FROM supply_items WHERE category=? AND is_active=1 ORDER BY quick DESC, sort_order, name COLLATE NOCASE LIMIT 1`, category) || null;
}
const nameTaken = (table, name, id = null) => !!db.one(`SELECT 1 FROM ${table} WHERE name=? COLLATE NOCASE AND id<>?`, String(name).trim(), id || '');

// ---- the ledger ----
/** Append one ledger row. Returns it. `actor` is who recorded it. */
function addEntry(e, actor) {
  const row = {
    id: e.id || uuid(), item_id: e.item_id, site_id: e.site_id, kind: e.kind, quantity: e.quantity, lot_number: e.lot_number || '',
    expires_on: e.expires_on || null, occurred_on: e.occurred_on || today(), source: e.source || null, funding_source_id: e.funding_source_id || null,
    reference: e.reference || null, reason: e.reason || null, transfer_id: e.transfer_id || null, intervention_id: e.intervention_id || null,
    flagged: e.flagged ? 1 : 0, user_id: actor && actor.id && db.one(`SELECT 1 FROM users WHERE id=?`, actor.id) ? actor.id : null,
  };
  const stamp = db.now();
  db.run(`INSERT INTO supply_ledger(id,item_id,site_id,kind,quantity,lot_number,expires_on,occurred_on,source,funding_source_id,reference,reason,transfer_id,intervention_id,flagged,user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.item_id, row.site_id, row.kind, row.quantity, row.lot_number, row.expires_on, row.occurred_on, row.source,
    row.funding_source_id, row.reference, row.reason, row.transfer_id, row.intervention_id, row.flagged, row.user_id, stamp, stamp);
  return row;
}
/** The lots of an item at a site with something on hand (or everything, `all`), first-expiry-first-out on `date`. */
function lots(itemId, siteId, { date = today(), all = false } = {}) {
  const rows = db.all(`SELECT lot_number, expires_on, SUM(quantity) quantity FROM supply_ledger WHERE item_id=? AND site_id=? GROUP BY lot_number, expires_on ${all ? '' : 'HAVING SUM(quantity) > 0'}`, itemId, siteId);
  // Unexpired stock first, earliest expiry first, then stock with no expiry recorded; expired stock last,
  // so it is drawn only when nothing else is on the books (and shows as expired on the Supplies page).
  const rank = (l) => (l.expires_on && l.expires_on < date ? 2 : l.expires_on ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || String(a.expires_on || '').localeCompare(String(b.expires_on || '')) || a.lot_number.localeCompare(b.lot_number));
}
const onHand = (itemId, siteId) => db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=? AND site_id=?`, itemId, siteId).n;
const lotOnHand = (itemId, siteId, lot, expires) => db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=? AND site_id=? AND lot_number=? AND expires_on IS ?`, itemId, siteId, lot || '', expires || null).n;

/**
 * Take `qty` of an item from a site's lots, first expiry first. What the books do not hold was still handed out
 * (a worker in the field does not stop because the count is behind), so the rest is recorded as a shortfall:
 * an adjustment adding the missing stock, flagged for a supervisor to look at, and the draw-down against it.
 * The count never goes below zero. Returns { entries, shortfall }.
 */
function drawFEFO(itemId, siteId, qty, { date, kind = 'distributed', interventionId = null, extra = {} }, actor) {
  const entries = []; let left = qty;
  for (const l of lots(itemId, siteId, { date })) {
    if (left <= 0) break;
    const take = Math.min(left, l.quantity);
    entries.push(addEntry({ item_id: itemId, site_id: siteId, kind, quantity: -take, lot_number: l.lot_number, expires_on: l.expires_on, occurred_on: date, intervention_id: interventionId, ...extra }, actor));
    left -= take;
  }
  if (left > 0) {
    entries.push(addEntry({ item_id: itemId, site_id: siteId, kind: 'adjustment', quantity: left, reason: SHORTFALL, flagged: 1, occurred_on: date, intervention_id: interventionId }, actor));
    entries.push(addEntry({ item_id: itemId, site_id: siteId, kind, quantity: -left, occurred_on: date, intervention_id: interventionId, ...extra }, actor));
  }
  return { entries, shortfall: Math.max(0, left) };
}

// ---- a visit's supplies ----
function visitLines(visitId) {
  return db.all(`SELECT l.*, i.name AS item_name, i.category, i.product, i.unit FROM intervention_supplies l JOIN supply_items i ON i.id=l.item_id WHERE l.intervention_id=? ORDER BY i.sort_order, i.name COLLATE NOCASE`, visitId);
}
/** The site a visit draws from: the one it names, else its worker's. */
function siteOfVisit(v) { return (v.supply_site_id && site(v.supply_site_id) ? v.supply_site_id : null) || siteForUser(v.user_id); }

/**
 * Bring the ledger in line with what a visit handed out (or, once it is deleted, with nothing): by difference
 * from what is already drawn for it, so it can run any number of times. Stock drawn at another site than the
 * visit's, or for an item it no longer lists, goes back to the lots it came from. Returns what moved.
 */
function reconcileVisit(visitId, actor, { ip = null } = {}) {
  const visit = db.one(`SELECT id, occurred_at, user_id, client_id, supply_site_id FROM interventions WHERE id=?`, visitId);
  const want = new Map();
  if (visit) for (const l of db.all(`SELECT item_id, quantity, untracked FROM intervention_supplies WHERE intervention_id=?`, visitId)) {
    const q = l.quantity - l.untracked; if (q > 0) want.set(l.item_id, (want.get(l.item_id) || 0) + q);
  }
  const at = visit ? siteOfVisit(visit) : null;
  const date = visit ? dayOf(visit.occurred_at) : today();
  const drawn = db.all(`SELECT item_id, site_id, lot_number, expires_on, -SUM(quantity) drawn FROM supply_ledger WHERE intervention_id=? AND kind IN ('distributed','restored') GROUP BY item_id, site_id, lot_number, expires_on`, visitId).filter(r => r.drawn > 0);
  if (!want.size && !drawn.length) return { drawn: [], restored: [] };
  const moved = { drawn: [], restored: [] };
  const putBack = (rows, qty) => {
    // The reverse of first-expiry-first-out: the lots drawn last go back first.
    const order = [...rows].sort((a, b) => String(b.expires_on || '9999').localeCompare(String(a.expires_on || '9999')) || b.lot_number.localeCompare(a.lot_number));
    let left = qty;
    for (const r of order) {
      if (left <= 0) break;
      const back = Math.min(left, r.drawn);
      addEntry({ item_id: r.item_id, site_id: r.site_id, kind: 'restored', quantity: back, lot_number: r.lot_number, expires_on: r.expires_on, occurred_on: date, intervention_id: visitId }, actor);
      left -= back;
    }
    if (qty - left > 0) moved.restored.push({ item_id: rows[0].item_id, site_id: rows[0].site_id, quantity: qty - left });
  };
  db.transaction(() => {
    const groups = new Map();
    for (const r of drawn) { const k = `${r.item_id}|${r.site_id}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    for (const [k, rows] of groups) {
      const [itemId, siteId] = k.split('|');
      const total = rows.reduce((n, r) => n + r.drawn, 0);
      if (!at || siteId !== at || !want.has(itemId)) putBack(rows, total);
      else if (want.get(itemId) < total) putBack(rows, total - want.get(itemId));
    }
    if (at) for (const [itemId, q] of want) {
      const have = (groups.get(`${itemId}|${at}`) || []).reduce((n, r) => n + r.drawn, 0);
      if (q > have) { const r = drawFEFO(itemId, at, q - have, { date, interventionId: visitId }, actor); moved.drawn.push({ item_id: itemId, site_id: at, quantity: q - have, shortfall: r.shortfall }); }
    }
  });
  const nameOf = (id) => (item(id) || {}).name || id;
  for (const x of moved.drawn) audit.log({ user: actor, action: 'supply.drawdown', entity: 'supply_ledger', ip, details: { intervention: visitId, item: nameOf(x.item_id), site: x.site_id, quantity: x.quantity, shortfall: x.shortfall || undefined } });
  for (const x of moved.restored) audit.log({ user: actor, action: 'supply.restore', entity: 'supply_ledger', ip, details: { intervention: visitId, item: nameOf(x.item_id), site: x.site_id, quantity: x.quantity } });
  return moved;
}

/**
 * The supply lines a visit should have after a save, and the two counts the reports read from the visit.
 *   existing: the visit's lines now; prev: the visit row before this save (null for a new visit);
 *   desired: the items the request lists ([{ item_id, quantity }]), or null when it lists none;
 *   given: naloxone_kits / fentanyl_strips as the request gave them (only the keys it gave).
 * With a list, the list is the whole truth and each count is the sum of its category (a count given for a
 * category the list does not cover is kept, and drawn from that category's usual item when there is one).
 * Without one, a count that changed moves that category's lines to match: an API client, a spreadsheet import
 * or a device on an older kernel still sends only the counts. Counts recorded before items existed (a 1.13
 * visit's kits) are carried as `untracked`: already off the old cupboard count, never drawn again.
 * Returns null when nothing about the visit's supplies changes, else { lines, counts }.
 */
function planLines({ existing = [], prev = null, desired = null, given = {} }) {
  const byId = new Map();
  const itemOf = (id) => { if (!byId.has(id)) byId.set(id, item(id)); return byId.get(id); };
  for (const l of existing) byId.set(l.item_id, { id: l.item_id, category: l.category, is_active: 1, name: l.item_name });
  const catOf = (id) => (itemOf(id) || {}).category;
  const COUNTED = Object.entries(N.COUNTED);
  let want;
  if (desired) {
    if (!Array.isArray(desired)) throw badRequest('Validation failed', { fields: { supplies: 'must be a list of items and quantities' } });
    const merged = new Map();
    for (const d of desired) {
      const id = d && typeof d.item_id === 'string' ? d.item_id : null; const q = Number(d && d.quantity);
      if (!id) throw badRequest('Validation failed', { fields: { supplies: 'each item needs an item_id' } });
      if (!Number.isInteger(q) || q < 0 || q > 100000) throw badRequest('Validation failed', { fields: { supplies: 'each quantity must be a whole number from 0 to 100,000' } });
      const it = itemOf(id);
      if (!it) throw badRequest('Validation failed', { fields: { supplies: 'lists an item this program does not keep' } });
      if (!it.is_active && !existing.some(l => l.item_id === id)) throw badRequest('Validation failed', { fields: { supplies: `${it.name} is no longer offered` } });
      if (q > 0) merged.set(id, (merged.get(id) || 0) + q);
    }
    want = [...merged].map(([item_id, quantity]) => ({ item_id, quantity }));
    for (const [col, cat] of COUNTED) {
      if (!(given[col] > 0) || want.some(l => catOf(l.item_id) === cat)) continue;
      const d = defaultItemFor(cat); if (d) { byId.set(d.id, d); want.push({ item_id: d.id, quantity: given[col] }); }
    }
  } else {
    const changed = COUNTED.filter(([col]) => col in given && given[col] !== null && given[col] !== undefined && (!prev || Number(given[col] || 0) !== Number(prev[col] || 0)));
    if (!changed.length) return null;
    want = existing.map(l => ({ item_id: l.item_id, quantity: l.quantity }));
    for (const [col, cat] of changed) {
      const target = Number(given[col] || 0);
      const mine = want.filter(l => catOf(l.item_id) === cat);
      const sum = mine.reduce((n, l) => n + l.quantity, 0);
      if (target > sum) {
        if (mine.length) mine[mine.length - 1].quantity += target - sum;
        else { const d = defaultItemFor(cat); if (d) { byId.set(d.id, d); want.push({ item_id: d.id, quantity: target - sum }); } }
      } else {
        let cut = sum - target;
        for (const l of [...mine].reverse()) { const c = Math.min(cut, l.quantity); l.quantity -= c; cut -= c; }
      }
    }
    want = want.filter(l => l.quantity > 0);
  }
  // What earlier saves recorded without a line (the visit's counts before items), per category.
  const carried = {};
  for (const [col, cat] of COUNTED) {
    const mine = existing.filter(l => l.category === cat);
    carried[cat] = mine.reduce((n, l) => n + (l.untracked || 0), 0) + Math.max(0, Number(prev ? prev[col] || 0 : 0) - mine.reduce((n, l) => n + l.quantity, 0));
  }
  const lines = want.map(l => {
    const cat = catOf(l.item_id);
    const untracked = carried[cat] ? Math.min(l.quantity, carried[cat]) : 0;
    if (untracked) carried[cat] -= untracked;
    return { ...l, untracked };
  });
  const counts = {};
  for (const [col, cat] of COUNTED) {
    const mine = lines.filter(l => catOf(l.item_id) === cat);
    const had = Number(prev ? prev[col] || 0 : 0);
    // A list says nothing about a category the programme keeps no item of: the visit keeps its count.
    counts[col] = mine.length ? mine.reduce((n, l) => n + l.quantity, 0)
      : col in given && given[col] !== null && given[col] !== undefined ? Number(given[col] || 0)
        : !desired || !defaultItemFor(cat) ? had : 0;
  }
  return { lines, counts };
}

/** Write a visit's planned lines: one row per item, ids kept for the items that stay, removed ones tombstoned. */
function writeLines(visit, lines) {
  const existing = db.all(`SELECT * FROM intervention_supplies WHERE intervention_id=?`, visit.id);
  const stamp = db.now(); const keep = new Set();
  for (const l of lines) {
    const e = existing.find(x => x.item_id === l.item_id && !keep.has(x.id));
    if (e) {
      keep.add(e.id);
      if (e.quantity !== l.quantity || e.untracked !== l.untracked || e.client_id !== (visit.client_id || null) || e.user_id !== visit.user_id) {
        db.run(`UPDATE intervention_supplies SET quantity=?, untracked=?, client_id=?, user_id=?, updated_at=? WHERE id=?`, l.quantity, l.untracked, visit.client_id || null, visit.user_id, stamp, e.id);
      }
    } else {
      const id = uuid(); keep.add(id);
      db.run(`INSERT INTO intervention_supplies(id,intervention_id,client_id,user_id,item_id,quantity,untracked,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, visit.id, visit.client_id || null, visit.user_id, l.item_id, l.quantity, l.untracked, stamp, stamp);
    }
  }
  for (const e of existing) if (!keep.has(e.id)) { db.run(`DELETE FROM intervention_supplies WHERE id=?`, e.id); db.tombstone('intervention_supplies', e.id); }
}
/** A visit's client or worker changed: its lines follow (they are scoped by them, on the office and on devices). */
function relinkLines(visit) {
  db.run(`UPDATE intervention_supplies SET client_id=?, user_id=?, updated_at=? WHERE intervention_id=? AND (client_id IS NOT ? OR user_id IS NOT ?)`, visit.client_id || null, visit.user_id, db.now(), visit.id, visit.client_id || null, visit.user_id);
}

/** The estimate of syringes in a returned container, from its volume (the programme's own conversion). */
const estimateReturns = (litres) => Math.round(Number(litres || 0) * syringesPerLitre());

// ---- stock views ----
/**
 * On hand per item and site, and per lot, with expiry state on `date`. One pass over the ledger, read from its
 * covering index (idx_supply_ledger_onhand: the rows themselves are never read); a lot whose movements add up
 * to nothing is left out. The Supplies page used to make this pass twice (once more for the alerts) and then
 * add up each item at each site again, a third of a second at 50,000 ledger rows.
 */
function stock({ date = today() } = {}) {
  const warnBy = addDays(date, expiryWarnDays());
  const sums = db.all(`SELECT item_id, site_id, lot_number, expires_on, SUM(quantity) quantity FROM supply_ledger GROUP BY item_id, site_id, lot_number, expires_on`);
  const lotRows = sums.filter(l => l.quantity !== 0)
    .map(l => ({ ...l, state: !l.expires_on ? 'no_expiry' : l.expires_on < date ? 'expired' : l.expires_on <= warnBy ? 'expiring' : 'ok' }));
  const totals = new Map();
  for (const l of lotRows) { const k = `${l.item_id}|${l.site_id}`; totals.set(k, (totals.get(k) || 0) + l.quantity); }
  const out = { lots: lotRows, bySite: [...totals].map(([k, quantity]) => { const [item_id, site_id] = k.split('|'); return { item_id, site_id, quantity }; }), warn_by: warnBy, date };
  // What alerts() needs from the same pass, kept off the object the routes send: on hand per item and site
  // (lots that add up to nothing included, as SUM over the ledger has them).
  Object.defineProperty(out, 'onHandOf', { enumerable: false, value: (itemId, siteId) => totals.get(`${itemId}|${siteId}`) || 0 });
  return out;
}
/**
 * What needs a supervisor's attention: expired and expiring lots, items running low at a site, recent shortfalls.
 * `stock` is stock({ date }) when the caller already has it (GET /api/supplies shows both).
 */
function alerts({ date = today(), stock: s = null } = {}) {
  if (!s || s.date !== date) s = stock({ date });
  const positive = s.lots.filter(l => l.quantity > 0);
  const lowRows = [];
  for (const it of db.all(`SELECT id, name, low_stock FROM supply_items WHERE is_active=1 AND low_stock IS NOT NULL`)) {
    for (const st of db.all(`SELECT id, name FROM supply_sites WHERE is_active=1 AND id IN (SELECT site_id FROM supply_ledger WHERE item_id=?)`, it.id)) {
      const q = s.onHandOf(it.id, st.id); if (q <= it.low_stock) lowRows.push({ item_id: it.id, site_id: st.id, quantity: q, low_stock: it.low_stock });
    }
  }
  const since = addDays(date, -90);
  const shortfalls = db.all(`SELECT id, item_id, site_id, quantity, occurred_on FROM supply_ledger WHERE flagged=1 AND occurred_on >= ? ORDER BY occurred_on DESC LIMIT 100`, since);
  return {
    expired: positive.filter(l => l.state === 'expired'), expiring: positive.filter(l => l.state === 'expiring'), low: lowRows, shortfalls,
    counts: { expired: positive.filter(l => l.state === 'expired').length, expiring: positive.filter(l => l.state === 'expiring').length, low: lowRows.length, shortfalls: shortfalls.length },
    warn_days: expiryWarnDays(), date,
  };
}

// ---- sync: what a device may push (the tables' rules call these: server/rules/supply_ledger.js,
// intervention_supplies.js, and interventions.js, whose finish() settles each visit once the whole push has landed) ----
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Why a stock ledger row pushed by a device cannot be accepted, or null. A device records stock received, moved,
 * adjusted and disposed of offline, with the same permissions as the routes; a visit's draw-down (and the
 * shortfall it may record) is the office's to work out from the visit, so a pushed one is refused for good and
 * the device keeps the office's instead. Existing rows are append-only (sync-tables.js immutable).
 */
function ledgerPushProblem(user, raw) {
  const auth = require('./auth');
  if (VISIT_KINDS.includes(raw.kind) || raw.intervention_id || raw.reason === SHORTFALL || raw.flagged) return 'drawn down at the office from the visit it belongs to';
  if (!KINDS.includes(raw.kind)) return `has a value the office does not accept (supply entry "${String(raw.kind).slice(0, 30)}")`;
  if (!item(raw.item_id)) return 'refers to a record the office server does not have (the supply item)';
  if (!site(raw.site_id)) return 'refers to a record the office server does not have (the supply site)';
  const q = Number(raw.quantity);
  if (!Number.isInteger(q) || q === 0 || Math.abs(q) > MAX_QTY) return 'has a value the office does not accept (the quantity must be a whole number, not zero)';
  if (POSITIVE.includes(raw.kind) && q < 0) return 'has a value the office does not accept (stock received or moved in cannot be negative)';
  if (NEGATIVE.includes(raw.kind) && q > 0) return 'has a value the office does not accept (stock moved out or disposed of is taken off, so it is negative)';
  if (!raw.occurred_on || !DAY.test(String(raw.occurred_on))) return 'is missing a required field: the date of the supply entry';
  if (raw.expires_on && !DAY.test(String(raw.expires_on))) return 'has a value the office does not accept (the expiry date)';
  if (raw.kind === 'received' && raw.source && !N.codes(N.SOURCES).includes(raw.source)) return 'has a value the office does not accept (where the stock came from)';
  if (raw.kind === 'adjustment' && !N.codes(N.ADJUST_REASONS).includes(raw.reason)) return 'has a value the office does not accept (the reason for the adjustment)';
  if (raw.kind === 'disposal' && !N.codes(N.DISPOSAL_REASONS).includes(raw.reason)) return 'has a value the office does not accept (the reason for the disposal)';
  const perm = ['opening', 'received'].includes(raw.kind) ? 'supplies:receive' : 'supplies:manage';
  if (!auth.hasPerm(user, perm)) return `your role cannot record ${N.KIND_LABELS[raw.kind].toLowerCase()} supplies`;
  return null;
}
/**
 * After a device's stock movement lands: a lot taken below zero (someone else moved or handed out the same stock
 * while the device was offline) is not refused, since the movement happened; the missing stock is recorded as a
 * flagged shortfall for a supervisor, so the count stays at zero or above.
 */
function settlePushedEntry(user, row) {
  if (!(row.quantity < 0)) return null;
  const n = lotOnHand(row.item_id, row.site_id, row.lot_number, row.expires_on);
  if (n >= 0) return null;
  const s = addEntry({ item_id: row.item_id, site_id: row.site_id, kind: 'adjustment', quantity: -n, lot_number: row.lot_number, expires_on: row.expires_on, reason: SHORTFALL, flagged: 1, occurred_on: row.occurred_on }, user);
  audit.log({ user, action: 'supply.shortfall', entity: 'supply_ledger', entityId: s.id, ip: 'device', details: { item: (item(row.item_id) || {}).name, site: row.site_id, quantity: -n, after: row.id } });
  return s;
}
/**
 * Why a visit's supply line pushed by a device cannot be accepted, or null. It belongs to its visit: the visit
 * must be on the office (it is pushed first), one this person may write to, and the line takes the visit's
 * client and worker whatever the device sent, so a line cannot be a way onto someone else's record.
 */
function linePushProblem(user, raw, existing) {
  const auth = require('./auth');
  const visit = db.one(`SELECT id, client_id, user_id FROM interventions WHERE id=?`, raw.intervention_id);
  if (!visit) return 'refers to a record the office server does not have (the visit)';
  if (existing && existing.intervention_id !== raw.intervention_id) return 'has a value the office does not accept (a supply line cannot move to another visit)';
  if (visit.client_id && !auth.canAccessClient(user, visit.client_id)) return 'not on caseload';
  // Whoever may edit the visit (PUT /api/interventions/:id: its worker, or records:manage-others), linked to a
  // client or not (security review of 1.16.0, M3: a client-linked visit was left to caseload scoping alone).
  if (require('./rules').forTable('interventions').editableBy(user, visit)) return 'not permitted';
  const it = item(raw.item_id);
  if (!it) return 'refers to a record the office server does not have (the supply item)';
  const q = Number(raw.quantity); const u = Number(raw.untracked || 0);
  if (!Number.isInteger(q) || q < 1 || q > 100000) return 'has a value the office does not accept (the quantity handed out)';
  if (!Number.isInteger(u) || u < 0 || u > q || (u > 0 && !Object.values(N.COUNTED).includes(it.category))) return 'has a value the office does not accept (the part recorded before supplies were kept by item)';
  raw.client_id = visit.client_id; raw.user_id = visit.user_id; raw.untracked = u;
  return null;
}
/**
 * The office's side of a pushed visit, once the whole batch has landed. `prev` is the visit as the office had it
 * before the push (null when new), `linesPushed` whether the device sent the visit's lines. A device on an older
 * kernel sends only the counts: its lines are worked out from them here. A current one sends its lines, and the
 * counts follow them. Then the stock is drawn down (or put back) by difference.
 */
function settlePushedVisit(user, visitId, { prev = null, countsPushed = false, linesPushed = false } = {}) {
  const visit = db.one(`SELECT * FROM interventions WHERE id=?`, visitId);
  if (visit && countsPushed && !linesPushed) {
    const given = {}; for (const col of Object.keys(N.COUNTED)) given[col] = visit[col];
    const plan = planLines({ existing: visitLines(visitId), prev, given });
    if (plan) writeLines(visit, plan.lines);
  } else if (visit && linesPushed) {
    const lines = visitLines(visitId);
    const sets = []; const params = [];
    for (const [col, cat] of Object.entries(N.COUNTED)) {
      const mine = lines.filter(l => l.category === cat);
      if (mine.length) { const n = mine.reduce((s, l) => s + l.quantity, 0); if (n !== visit[col]) { sets.push(`${col}=?`); params.push(n); } }
    }
    if (sets.length) db.run(`UPDATE interventions SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, db.now(), visitId);
  }
  return reconcileVisit(visitId, user, { ip: 'device' });
}

module.exports = {
  KINDS, POSITIVE, NEGATIVE, VISIT_KINDS, SHORTFALL, DEFAULTS, MAX_QTY, N,
  today, addDays, dayOf, setting, expiryWarnDays, syringesPerLitre,
  item, site, activeSite, items, sites, defaultSiteId, siteForUser, defaultItemFor, nameTaken,
  addEntry, lots, onHand, lotOnHand, drawFEFO,
  visitLines, siteOfVisit, reconcileVisit, planLines, writeLines, relinkLines, estimateReturns,
  stock, alerts,
  ledgerPushProblem, settlePushedEntry, linePushProblem, settlePushedVisit,
};

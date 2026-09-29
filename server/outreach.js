'use strict';
// Street outreach (1.17.0, docs/USER_GUIDE.md "Street outreach"): the phone screen a harm-reduction worker
// logs field contacts on (public/views/outreach.js). A contact is an ordinary visit with no client
// (constants.CLIENTLESS_INTERVENTION_TYPES), saved through POST /api/interventions: its supplies are its
// supply lines and draw the stock down by the supply rules (server/supplies.js, server/rules/interventions.js),
// it syncs like any visit, and every report that counts anonymous visits and distribution counts it. On SUDS on
// this device, and on a device that syncs with an office, the same code runs in the browser kernel, so the
// screen works with no connection.
//
// This module is the worker's "my shift" summary: what they logged since their shift began, in figures (no
// notes, no identifiers; anonymous contacts have none). A contact's notes are the visit's summary, encrypted
// like every summary; the screen asks for them without names or descriptions of anyone.
//
// An anonymous contact may carry an SSP participant code (1.17.0, server/participant-code.js): the screen sends it
// with the contact, and `participants` below counts the different codes among this shift's contacts by their blind
// index (never decrypting one; a device counts by its own index key, as its SSP summary does).
const db = require('./db');
const auth = require('./auth');
const C = require('./constants');
const { badRequest } = require('./http');

// A shift longer than this is not one: the summary reads at most a day and a half back.
const MAX_SHIFT_MS = 36 * 3600 * 1000;

/** The start of today in the programme's time zone, as an instant. */
function startOfToday() { const B = require('./routes/budget'); return B.localMidnight(B.localDate()); }

function shift(user, since) {
  const now = Date.now();
  let from = since || startOfToday();
  const t = Date.parse(from);
  if (!Number.isFinite(t)) throw badRequest('since must be a date and time (ISO 8601)');
  if (t > now + 5 * 60000) throw badRequest('since is in the future');
  if (now - t > MAX_SHIFT_MS) from = new Date(now - MAX_SHIFT_MS).toISOString();
  else from = new Date(t).toISOString();
  const types = C.CLIENTLESS_INTERVENTION_TYPES;
  const mine = `i.user_id=? AND i.client_id IS NULL AND i.type IN (${types.map(() => '?').join(',')}) AND i.occurred_at >= ?`;
  const p = [user.id, ...types, from];
  const visits = db.all(`SELECT i.id, i.type, i.occurred_at, i.location, i.supply_site_id, i.naloxone_kits, i.fentanyl_strips, i.syringes_returned, i.participant_code_idx FROM interventions i WHERE ${mine} ORDER BY i.occurred_at DESC`, ...p);
  const lines = db.all(`SELECT l.intervention_id, l.quantity, it.id AS item_id, it.name, it.category, it.unit FROM intervention_supplies l JOIN supply_items it ON it.id=l.item_id JOIN interventions i ON i.id=l.intervention_id WHERE ${mine}`, ...p);
  const items = new Map(); const byVisit = new Map();
  for (const l of lines) {
    if (!items.has(l.item_id)) items.set(l.item_id, { item_id: l.item_id, item: l.name, category: l.category, unit: l.unit, quantity: 0 });
    items.get(l.item_id).quantity += l.quantity;
    if (!byVisit.has(l.intervention_id)) byVisit.set(l.intervention_id, []);
    byVisit.get(l.intervention_id).push({ item: l.name, quantity: l.quantity });
  }
  const sites = new Map(db.all(`SELECT id, name FROM supply_sites`).map(s => [s.id, s.name]));
  const byType = new Map(); for (const v of visits) byType.set(v.type, (byType.get(v.type) || 0) + 1);
  const sum = (k) => visits.reduce((n, v) => n + (v[k] || 0), 0);
  return {
    since: from,
    contacts: visits.length,
    by_type: [...byType].map(([type, n]) => ({ type, n })),
    naloxone_kits: sum('naloxone_kits'), fentanyl_strips: sum('fentanyl_strips'), syringes_returned: sum('syringes_returned'),
    supplies: [...items.values()].sort((a, b) => a.item.localeCompare(b.item)),
    participants: new Set(visits.map(v => v.participant_code_idx).filter(Boolean)).size,
    // The last few contacts, to check one was saved: when, what, where, what was given. Never the notes.
    recent: visits.slice(0, 8).map(v => ({ id: v.id, occurred_at: v.occurred_at, type: v.type, location: v.location, site: v.supply_site_id ? sites.get(v.supply_site_id) || null : null, supplies: byVisit.get(v.id) || [] })),
  };
}

function routes(r) {
  // Only the worker's own anonymous contacts, in figures: nothing about anyone, so it is not audited as a read
  // of a record (each contact was audited when it was saved).
  r.get('/api/outreach/shift', auth.requireAuth, auth.requirePerm('interventions:write'), (ctx) => shift(ctx.user, ctx.query.get('since') || null));
}

module.exports = { shift, routes, startOfToday, MAX_SHIFT_MS };

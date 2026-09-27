'use strict';
// The rules for the stock ledger (docs/SUPPLIES.md). Append-only: on hand is its sum, and a correction is another
// row, so a device may add stock received, moved, adjusted or disposed of, never change or delete a row. Each
// movement is checked as the supply routes check it (server/supplies.js ledgerPushProblem: the kind, item, site,
// quantity and its sign, the date, the reason, and supplies:receive or supplies:manage for the kind), plus what
// only the routes checked before 1.14.0 (below). A visit's draw-down is the office's to work out from the visit,
// so a pushed one is refused for good. A lot a device's movement takes below zero (someone else moved the same
// stock while it was offline) is not refused, since the movement happened: the office records the missing stock
// as a flagged shortfall (settlePushedEntry), where the REST route refuses it up front.
const db = require('../db');
const { define, refuse, flag } = require('./core');

module.exports = define({
  table: 'supply_ledger',
  fields: { lot_number: { type: 'string', maxLen: 60 }, expires_on: { type: 'date' }, reference: { type: 'string', maxLen: 120 } },
  immutable: true, tombstone: 'never',
  check(row, c) {
    if (c.existing) return null;
    const S = require('../supplies');
    const problem = S.ledgerPushProblem(c.user, row);
    if (problem) return refuse(problem);
    const out = [];
    if (row.lot_number && /[\u0000-\u001f]/.test(row.lot_number)) out.push(refuse('has a value the office does not accept (the lot number)', { message: 'Validation failed', fields: { lot_number: 'has characters a lot number does not use' } }));
    // Damaged, expired or lost stock is taken off (routes/supplies.js adjustments): only a count correction adds.
    if (row.kind === 'adjustment' && row.reason !== 'count_correction' && row.reason !== 'other' && Number(row.quantity) > 0) out.push(refuse('has a value the office does not accept (stock damaged, expired or lost is taken off, so it is negative)'));
    if (row.kind === 'received') {
      // A fund is named for a purchase only, and must be one of the programme's.
      if (row.funding_source_id && !db.one(`SELECT 1 FROM funding_sources WHERE id=?`, row.funding_source_id)) out.push(refuse('refers to a record the office server does not have (the funding source)'));
      else if (row.funding_source_id && row.source && row.source !== 'purchase') out.push(refuse('has a value the office does not accept (a funding source is recorded for a purchase only)'));
      // An item or site retired at the office while the device was out: the delivery still arrived, so flagged.
      const it = S.item(row.item_id); const site = S.site(row.site_id);
      if (it && !it.is_active) out.push(flag(`was accepted, but ${it.name} is no longer offered at the office; the office will review it`, { code: 'item_inactive', message: 'Validation failed', fields: { item_id: `${it.name} is no longer offered` } }));
      if (site && !site.is_active) out.push(flag(`was accepted, but the site ${site.name} is no longer in use at the office; the office will review it`, { code: 'site_inactive', message: 'Validation failed', fields: { site_id: `${site.name} is no longer in use` } }));
    }
    return out;
  },
  afterApply(row, o, c) { require('../supplies').settlePushedEntry(c.user, { ...o, id: row.id }); },
});

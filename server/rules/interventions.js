'use strict';
// The rules for interventions (visits and services), for POST/PUT /api/interventions (crud.js) and sync push.
// A client is required except for the services that genuinely have none; attaching a cost, fund or budget line
// is budget:write, not interventions:write alone, and a cost is charged to a line of its fund inside the fund's
// period; a visit is its worker's (or a manager's) to change; kits and strips handed out draw down the shelf.
const db = require('../db');
const auth = require('../auth');
const C = require('../constants');
const { define, refuse, flag } = require('./core');
const { periodProblem, ownedBy } = require('./shared');
const PC = require('../participant-code');
const FU = require('./follow-ups');

// The date a service "happened on", for the grant it is charged to: the calendar date in the organisation's
// time zone, or the service_date a REST caller gave explicitly.
const serviceDate = (row) => row.service_date || require('../routes/budget').localDate(row.occurred_at);

module.exports = define({
  table: 'interventions',
  fields: {
    // Optional: community naloxone distribution and street outreach are services with no identified client.
    client_id: { type: 'string' }, user_id: { type: 'string' },
    type: { type: 'string', required: true, list: 'INTERVENTION_TYPES' }, occurred_at: { type: 'datetime', required: true },
    duration_minutes: { type: 'number', integer: true, min: 0, max: 1440 }, location: { type: 'string', list: 'LOCATIONS' }, modality: { type: 'string', list: 'MODALITIES' },
    outcome: { type: 'string', list: 'OUTCOMES' }, stage_of_change: { type: 'string', enum: C.STAGES }, naloxone_kits: { type: 'number', integer: true, min: 0 },
    fentanyl_strips: { type: 'number', integer: true, min: 0 }, funding_source_id: { type: 'string' }, budget_line_id: { type: 'string' }, cost: { type: 'number', min: 0 },
    summary: { type: 'string', maxLen: 2000 }, follow_up_due: { type: 'date' },
    // Request-only: whether to log a time entry with the visit, its category, and the calendar date the service
    // belongs to when it is not the org-timezone date of occurred_at.
    log_time: { type: 'boolean', sync: false }, time_category: { type: 'string', list: 'TIME_CATEGORIES', sync: false }, service_date: { type: 'date', sync: false },
    // The items handed out ([{ item_id, quantity }]: request-only, they travel by sync as intervention_supplies rows),
    // the site they came from, and syringe services returns (docs/SUPPLIES.md).
    supplies: { type: 'array', maxLen: 50, sync: false }, supply_site_id: { type: 'string' },
    syringes_returned: { type: 'number', integer: true, min: 0, max: 100000 }, returns_estimated: { type: 'boolean' }, sharps_returned_litres: { type: 'number', min: 0, max: 1000 },
    // An anonymous contact's SSP participant code (1.17.0, server/participant-code.js): stored encrypted, counted
    // by its blind index, and only on a contact with no client record (check below).
    participant_code: { type: 'string', maxLen: 60 },
    // Request-only (1.14.0): a note written with the visit ({ kind, format, title, content, part2_protected, ... }),
    // created with it in one step and linked to it (routes/interventions.js; the note's own rules apply).
    note: { type: 'object', sync: false },
  },
  owner: { col: 'user_id', all: 'records:manage-others' },
  editableBy: ownedBy(['user_id'], 'records:manage-others'),
  authorise(row, c) {
    // Only when the value is actually changing (or being set on a new row): a device re-syncing an unrelated
    // edit to a row that already, legitimately, carries a cost must not suddenly need budget:write.
    if (!auth.hasPerm(c.user, 'budget:write')) {
      const e = c.existing;
      const changed = !e || row.cost !== e.cost || row.funding_source_id !== e.funding_source_id || row.budget_line_id !== e.budget_line_id;
      if (changed && ((row.cost && row.cost > 0) || row.funding_source_id || row.budget_line_id)) return refuse('you do not have permission to attach a cost to a funding source', { status: 403, message: 'You do not have permission to attach a cost to a funding source' });
    }
    return null;
  },
  check(row, c) {
    const e = c.existing || {};
    const val = (k) => (row[k] !== undefined ? row[k] : e[k]);
    const touched = (...ks) => !c.existing || ks.some(k => row[k] !== undefined && String(row[k] ?? '') !== String(e[k] ?? ''));
    const out = [];
    // The site the stock came from is one of the programme's, in use (an earlier visit keeps a site since retired).
    // A site retired at the office while the device was out is flagged, not refused: the kits were handed out.
    if (row.supply_site_id && touched('supply_site_id')) {
      const site = require('../supplies').site(row.supply_site_id);
      if (!site) out.push(refuse('refers to a record the office server does not have (the supply site)', { message: 'Validation failed', fields: { supply_site_id: 'is not one of this program\'s supply sites in use' } }));
      else if (!site.is_active) out.push(flag('was accepted, but the supply site it names is no longer in use at the office; the office will review it', { message: 'Validation failed', fields: { supply_site_id: 'is not one of this program\'s supply sites in use' }, code: 'site_inactive' }));
    }
    // A participant code stands in for a client record on an anonymous contact: a contact with a client is
    // counted by the client, so it carries no code (the form clears it when a client is chosen).
    if (touched('participant_code_enc', 'client_id')) {
      const code = c.plain('participant_code_enc');
      const bad = PC.problem(code);
      if (bad) out.push(refuse(`has a value the office does not accept (participant code: ${bad})`, { message: 'Validation failed', fields: { participant_code: bad } }));
      else if (PC.normalise(code) && val('client_id')) out.push(refuse('has a value the office does not accept (a participant code on a contact with a client)', { message: 'A participant code is for an anonymous contact. This visit has a client: remove the code, or the client.', fields: { participant_code: 'is only for a contact with no client record' } }));
    }
    // Anything else logged with no client is a visit nobody can find again on anyone's record.
    if (touched('type', 'client_id') && !val('client_id') && !C.CLIENTLESS_INTERVENTION_TYPES.includes(val('type'))) {
      out.push(refuse('is missing a required field (a client: only outreach and community naloxone distribution can be recorded without one)',
        { message: 'Choose the client this service was for. Only outreach and community naloxone distribution can be recorded without one.', fields: { client_id: 'Client is required for this type of service' } }));
    }
    // A direct cost against a fund names the specific line it draws down, inside the fund's period. Only checked
    // when this write touches cost, fund, line or date: an old record's unrelated edit is not held to it.
    if (touched('cost', 'funding_source_id', 'budget_line_id', 'occurred_at', 'service_date')) {
      const cost = val('cost'); const fund = val('funding_source_id'); const line = val('budget_line_id');
      if (cost && cost > 0) {
        if (!fund) out.push(refuse('is missing a required field (a funding source for its cost)', { message: 'A funding source is required when a cost is entered' }));
        else if (!line) out.push(refuse('is missing a required field (a budget line for its cost)', { message: 'A budget line is required when a cost is entered, so it is deducted from the right allocation' }));
        else if (!db.one(`SELECT 1 FROM budget_lines WHERE id=? AND funding_source_id=?`, line, fund)) out.push(refuse('has a value the office does not accept (its budget line belongs to another fund)', { message: 'Budget line does not belong to the selected funding source' }));
        else if (val('occurred_at')) out.push(periodProblem(db.one(`SELECT * FROM funding_sources WHERE id=?`, fund), serviceDate({ ...e, ...row }), 'Date of service'));
      } else if (line && !fund) out.push(refuse('is missing a required field (the funding source of its budget line)', { message: 'A funding source is required when a budget line is selected' }));
    }
    return out;
  },
  // The code as stored, whoever typed it how (upper case, letters and digits): its blind index is worked out
  // from this by sync-tables importRow, so "ab-07 85" on a phone and "AB0785" at the office count as one.
  normalise(row) {
    if (row.participant_code_enc !== undefined) row.participant_code_enc = participantCode(row.participant_code_enc).code;
    return null;
  },
  // A visit that handed supplies out draws the office stock down once the whole batch has landed (finish), by the
  // difference from what the office already drew for it, so a re-sent row counts once.
  afterApply(row, o, c) {
    const SUP = require('../supplies');
    const e = c.existing;
    const countsPushed = Object.keys(SUP.N.COUNTED).some(col => o[col] !== undefined && (!e || Number(o[col] || 0) !== Number(e[col] || 0)));
    const visits = supplyVisits(c.session);
    touchVisit(c.session, row.id, visits.has(row.id) ? { countsPushed: countsPushed || visits.get(row.id).countsPushed } : { prev: e || null, countsPushed });
    // Its follow-up to-do, once the whole push has landed (server/rules/follow-ups.js).
    FU.track('interventions', row, c);
  },
  // A deleted visit's untouched follow-up to-do is cancelled before the row goes (server/rules/follow-ups.js).
  beforeDelete(row, s) { FU.pushDeleted('interventions', row, s); },
  // A deleted visit puts back what it drew.
  afterDelete(row, s) { touchVisit(s, row.id, { linesPushed: true }); },
  // The office's draw-down for every visit this push touched, after the rows, the items (intervention_supplies) and
  // the deletions have all landed, so a device's visit and its items are weighed together. One visit's failure is
  // its own: the device is told, and the rest of the push stands.
  finish(s) {
    const SUP = require('../supplies');
    for (const [id, how] of supplyVisits(s)) {
      db.savepoint(() => SUP.settlePushedVisit(s.user, id, how), (err) => s.warnings.push({ table: 'interventions', id, reason: `supplies not drawn down: ${String(err && err.message || err).slice(0, 160)}` }));
    }
    FU.finish('interventions', s);
  },
});
/** The visits whose supplies this push touched: id -> { prev, countsPushed, linesPushed } (settlePushedVisit). */
function supplyVisits(s) { return s.state.supplyVisits || (s.state.supplyVisits = new Map()); }
function touchVisit(s, id, patch) {
  if (typeof id !== 'string') return;
  const m = supplyVisits(s);
  m.set(id, { prev: null, countsPushed: false, linesPushed: false, ...(m.get(id) || {}), ...patch });
}
module.exports.touchVisit = touchVisit;

/**
 * An SSP participant code as every door stores it (1.17.1; engineering review of 1.17.0, L2): `code` its
 * program-wide form (server/participant-code.js normalise; null when blank), to be encrypted, and `idx` the blind
 * index it is counted by. The visit routes (routes/interventions.js encodeCode), sync push (normalise above) and
 * sync-tables importRow all take both from here, so a code typed at the office and one pushed by a device are one.
 */
function participantCode(value) {
  const code = PC.normalise(value);
  return { code, idx: PC.index(code) };
}
module.exports.participantCode = participantCode;

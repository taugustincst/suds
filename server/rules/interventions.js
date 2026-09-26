'use strict';
// The rules for interventions (visits and services), for POST/PUT /api/interventions (crud.js) and sync push.
// A client is required except for the services that genuinely have none; attaching a cost, fund or budget line
// is budget:write, not interventions:write alone, and a cost is charged to a line of its fund inside the fund's
// period; a visit is its worker's (or a manager's) to change; kits and strips handed out draw down the shelf.
const db = require('../db');
const auth = require('../auth');
const C = require('../constants');
const { define, refuse } = require('./core');
const { periodProblem, ownedBy } = require('./shared');

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
  },
  owner: { col: 'user_id', all: 'clients:all' },
  editableBy: ownedBy(['user_id'], 'clients:all'),
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
  // By the difference from what the office already had, so a re-sent row counts once.
  afterApply(row, o, c) {
    const supplies = require('../routes/supplies');
    const counts = { id: row.id };
    for (const col of Object.keys(supplies.DRAWDOWN)) counts[col] = o[col] !== undefined ? o[col] : (c.existing ? c.existing[col] : 0);
    supplies.drawDown({ user: c.user, ip: 'device' }, counts, c.existing);
  },
});

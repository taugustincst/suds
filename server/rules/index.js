'use strict';
// Every synchronised table's rules, by name: one file per table in this folder (core.js says what a declaration
// holds). The REST routes and sync push (push.js) both read them from here. Adding a table: write its
// server/rules/<table>.js with define({...}) and add one line below; test/sync-rules.test.js fails for a table
// in server/sync-tables.js that has none.
const core = require('./core');

// Listed, not discovered: the browser kernel is bundled by esbuild, which needs every require to be static.
const DECLARED = {
  users: () => require('./users'),
  resources: () => require('./resources'),
  resource_photos: () => require('./resource_photos'),
  policy_documents: () => require('./policy_documents'),
  funding_sources: () => require('./funding_sources'),
  budget_lines: () => require('./budget_lines'),
  clients: () => require('./clients'),
  assignments: () => require('./assignments'),
  episodes: () => require('./episodes'),
  caloms_records: () => require('./caloms_records'),
  interventions: () => require('./interventions'),
  overdose_events: () => require('./overdose_events'),
  calls: () => require('./calls'),
  time_entries: () => require('./time_entries'),
  consents: () => require('./consents'),
  court_orders: () => require('./court_orders'),
  part2_notices: () => require('./part2_notices'),
  referrals: () => require('./referrals'),
  tasks: () => require('./tasks'),
  expenditures: () => require('./expenditures'),
  notes: () => require('./notes'),
  note_addenda: () => require('./note_addenda'),
  disclosures: () => require('./disclosures'),
  imports: () => require('./imports'),
  import_items: () => require('./import_items'),
  form_templates: () => require('./form_templates'),
  client_forms: () => require('./client_forms'),
  client_form_files: () => require('./client_form_files'),
  patient_requests: () => require('./patient_requests'),
  problems: () => require('./problems'),
  problem_history: () => require('./problem_history'),
  care_plan_goals: () => require('./care_plan_goals'),
  care_plan_steps: () => require('./care_plan_steps'),
  asam_assessments: () => require('./asam_assessments'),
  outcome_measures: () => require('./outcome_measures'),
  supply_stock: () => require('./supply_stock'),
  option_overrides: () => require('./option_overrides'),
  disclosure_agreements: () => require('./disclosure_agreements'),
};

const loaded = new Map();
/** A table's rules. Throws for a table with no declaration, so a new synced table cannot slip through unruled. */
function forTable(name, { optional = false } = {}) {
  let R = loaded.get(name);
  if (R) return R;
  const load = DECLARED[name];
  // A table that never travels by sync (the privacy officer's complaints register) may have no rules file: the
  // REST route that writes it is its only door. Every synchronised table must have one.
  if (!load && optional && !require('../sync-tables').tables.some(t => t.name === name)) { R = core.define({ table: name }); loaded.set(name, R); return R; }
  if (!load) throw new Error(`server/rules: no rules are declared for table "${name}" (add server/rules/${name}.js and list it in server/rules/index.js)`);
  R = load();
  if (R.table !== name) throw new Error(`server/rules/${name}.js declares rules for "${R.table}"`);
  loaded.set(name, R);
  return R;
}
const declaredTables = () => Object.keys(DECLARED);

/**
 * The REST door: run a table's check (and, for an existing row, who may change it) against the row a route is
 * about to write, and throw the first refusal as the route's HTTP error. `row` is the row as it will be stored,
 * encrypted columns in plain text; `existing` the stored row being changed, if any.
 */
function assertWrite(table, row, ctx, { existing = null, editable = true } = {}) {
  const R = forTable(table, { optional: true });
  const c = restContext(R, ctx, existing, row);
  // editable: false for a route whose own rule says who may act (recording a referral's outcome, a discharge).
  if (existing && editable && R.editableBy) core.assertNone(R.editableBy(ctx.user, existing));
  if (R.authorise) core.assertNone(R.authorise(row, c));
  if (R.check) core.assertNone(R.check(row, c));
}
/** Throw if this user may not change (or, with `deleting`, delete) this stored row: the REST canEdit. */
function assertEditable(table, ctx, existing, { deleting = false } = {}) {
  const R = forTable(table);
  const fn = deleting && R.deletableBy ? R.deletableBy : R.editableBy;
  if (!fn) return;
  const no = fn(ctx.user, existing, {});
  if (no && no !== 'skip') throw no.toHttp ? no.toHttp() : new (require('../http').HttpError)(403, no.message || no.reason);
}
function restContext(R, ctx, existing, row) {
  const { decrypt } = require('../crypto');
  const encCols = (R.sync && R.sync.enc) || [];
  return {
    user: ctx.user, existing, via: 'rest', ctx,
    changed() { return existing ? Object.keys(row).filter(k => k !== 'id' && row[k] !== undefined && String(row[k] ?? '') !== String(this.was(k) ?? '')) : Object.keys(row); },
    was: (col) => (!existing ? undefined : existing[col] && encCols.includes(col) ? (() => { try { return decrypt(existing[col]); } catch { return null; } })() : existing[col]),
    plain(col) { return row[col] !== undefined ? row[col] : this.was(col); },
  };
}
/** The row a REST body describes, as it will be stored: API names mapped to their columns (x -> x_enc). */
function toColumns(table, v) {
  const R = forTable(table);
  const o = {};
  for (const [k, val] of Object.entries(v)) { if (val === undefined || k.startsWith('_')) continue; o[R.columns[k] || k] = val; }
  return o;
}

module.exports = { ...core, forTable, declaredTables, assertWrite, assertEditable, toColumns };

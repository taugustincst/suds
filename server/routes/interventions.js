'use strict';
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const C = require('../constants');
const O = require('../options');
const { badRequest, forbidden } = require('../http');
const { validate } = require('../validate');
const { uuid, encrypt, decrypt } = require('../crypto');
const supplies = require('./supplies');
const S = require('../supplies');
const SN = require('../supply-names');
// What the visit form calls a count that no supply item took off (insertResult below).
const UNTRACKED_NAMES = { naloxone_kits: 'Naloxone kit', fentanyl_strips: 'Fentanyl test strips' };
const { localDate, cents } = require('./budget');

// The date a service "happened on", for the grant it is charged to and the time sheet it lands on: the
// calendar date in the organisation's time zone (config.orgTimezone), or the service_date the caller gave
// explicitly. Slicing occurred_at to its first ten characters took the UTC date, so a 9pm visit on the
// last day of a fiscal year was refused as "outside the period" and its cost landed in the next year.
function serviceDate(v) { return v._service_date || localDate(v.occurred_at); }

// Attaching a cost, fund or budget line is financial data: interventions:write alone is not enough to attach a
// cost to a fund, the same way it is not enough to POST an expenditure directly. A request that names any of
// them needs budget:write; what a cost must be (a line of its fund, inside the fund's period) is the table's rule
// (server/rules/interventions.js), which sync push applies to a device's visits as well.
function checkCostPermission(ctx, v) {
  if (('cost' in v || 'funding_source_id' in v || 'budget_line_id' in v) && !auth.hasPerm(ctx.user, 'budget:write')) throw forbidden('You do not have permission to attach a cost to a funding source');
}
// Recording a service that draws on a fund is a real financial transaction, so it posts a pending
// expenditure the same way the budget page's own "Record expenditure" does — pending, not approved, so the
// existing separation-of-duties approval workflow still gates whether it counts as spent. Handles insert
// (no existing row), update (amend the still-pending one, or create/remove one as the cost is added or
// cleared) and is a no-op once the linked expenditure has been approved/rejected/reimbursed: that is real
// money that has already moved, and an edit to the service record must not silently rewrite it.
function syncExpenditure(row) {
  const existing = db.one(`SELECT * FROM expenditures WHERE intervention_id=?`, row.id);
  if (existing && existing.status !== 'pending') return;
  const wantsCost = row.cost > 0 && row.funding_source_id && row.budget_line_id;
  if (!wantsCost) { if (existing) { db.run(`DELETE FROM expenditures WHERE id=?`, existing.id); db.tombstone('expenditures', existing.id); } return; }
  const line = db.one(`SELECT * FROM budget_lines WHERE id=? AND funding_source_id=?`, row.budget_line_id, row.funding_source_id);
  if (!line) return; // already validated on the way in; guards against a reference that went stale in between
  const desc = `Auto-recorded from ${row.type.replace(/_/g, ' ')}`;
  const spentAt = serviceDate(row);
  if (existing) db.run(`UPDATE expenditures SET funding_source_id=?, budget_line_id=?, client_id=?, spent_at=?, amount=?, category=?, description_enc=?, updated_at=? WHERE id=?`,
    row.funding_source_id, row.budget_line_id, row.client_id || null, spentAt, cents(row.cost), line.category, encrypt(desc), db.now(), existing.id);
  else db.run(`INSERT INTO expenditures(id,funding_source_id,budget_line_id,client_id,user_id,intervention_id,spent_at,amount,category,description_enc) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    uuid(), row.funding_source_id, row.budget_line_id, row.client_id || null, row.user_id, row.id, spentAt, cents(row.cost), line.category, encrypt(desc));
}

// A visit that logged its own time entry keeps that entry right when the visit is corrected: a duration
// or date typed wrong and fixed on the visit used to leave the time sheet with the wrong number, and a
// supervisor approving hours nobody had actually worked. Only while the entry is still unapproved —
// approved or rejected time has been ruled on and is not rewritten behind the approver's back.
function syncTimeEntry(row, prev) {
  if (row.duration_minutes === prev.duration_minutes && row.occurred_at === prev.occurred_at && !row._service_date) return;
  const te = db.one(`SELECT * FROM time_entries WHERE intervention_id=?`, row.id);
  if (!te || (te.status !== 'draft' && te.status !== 'submitted')) return;
  if (!(row.duration_minutes > 0)) { db.run(`DELETE FROM time_entries WHERE id=?`, te.id); db.tombstone('time_entries', te.id); return; }
  db.run(`UPDATE time_entries SET minutes=?, work_date=?, updated_at=? WHERE id=?`, row.duration_minutes, serviceDate(row), db.now(), te.id);
}

// The visit summary is clinical narrative about a named person, so it is stored encrypted like any other
// PHI field and decrypted on the way out.
function encodeSummary(v) { if (v.summary !== undefined) { v.summary_enc = v.summary ? require('../crypto').encrypt(v.summary) : null; delete v.summary; } }
function decodeSummary(row) {
  let summary = null;
  // A value that cannot be decrypted (a row written before this column was encrypted, or one whose key has
  // been rotated away) must not take the whole list down with it.
  if (row.summary_enc) { try { summary = require('../crypto').decrypt(row.summary_enc); } catch { summary = '[could not be read]'; } }
  return { ...row, summary, summary_enc: undefined };
}

// ---- a note written with the visit (1.14.0) ----
// The visit form's "Add a note": the note a substantive visit needs (the summary holds no names or health
// details) written in the same dialog and saved with the visit in one request. It is an ordinary draft note,
// linked to the visit and its client, under the Note form's permissions, rules, encryption and audit
// (routes/notes.js checkNewNote/insertNote). Everything is checked before the visit is written, and the
// note is inserted in the visit's own transaction, so a refused note never leaves the visit saved alone.
const notes = require('./notes');
const NOTE_KEYS = ['kind', 'format', 'title', 'content', 'structured', 'part2_protected', 'counseling_note', 'cosign_requested'];
function planNote(ctx, v) {
  const raw = v.note; delete v.note;
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Validation failed', { fields: { note: 'must be an object' } });
  if (!v.client_id) throw badRequest('A note is about a client: choose the client this visit was with, or save the visit without the note.', { fields: { client_id: 'is required to add a note' } });
  const body = { client_id: v.client_id, occurred_at: v.occurred_at, source: 'manual' };
  for (const k of NOTE_KEYS) if (raw[k] !== undefined) body[k] = raw[k];
  let nv;
  try { nv = validate(body, notes.noteShape); }
  catch (e) {
    // Named as the visit form names them ("Note"), so the error lands under the note's own fields.
    const f = e.extra && e.extra.fields;
    if (f) e.extra.fields = Object.fromEntries(Object.entries(f).map(([k, m]) => [`note_${k}`, m]));
    throw e;
  }
  notes.checkNewNote(ctx, nv);
  nv._with_visit = true;
  v._note = nv;
}

// ---- supplies handed out (docs/SUPPLIES.md) ----
// `supplies` on a request is the whole list of items the visit handed out ([{ item_id, quantity }]); the
// naloxone_kits and fentanyl_strips counts every report reads are the sums of its naloxone and fentanyl test
// strip items (server/supplies.js planLines). A request with counts and no list (an older form, the API, a
// device on an older kernel) still works: the counts move the lines. The plan is made before the row is
// written, so the counts land with it; the lines are written, and the stock drawn down, just after.
const COUNT_COLS = Object.keys(SN.COUNTED);
function planSupplies(ctx, v, row = null) {
  const desired = v.supplies !== undefined && v.supplies !== null ? v.supplies : null; delete v.supplies;
  if (v.supply_site_id) {
    const site = S.site(v.supply_site_id);
    if (!site || (!site.is_active && (!row || row.supply_site_id !== v.supply_site_id))) throw badRequest('Validation failed', { fields: { supply_site_id: 'is not one of this program\'s supply sites in use' } });
  }
  const given = {}; for (const c of COUNT_COLS) if (v[c] !== undefined) given[c] = v[c];
  const plan = S.planLines({ existing: row ? S.visitLines(row.id) : [], prev: row, desired, given });
  if (plan) {
    for (const c of COUNT_COLS) v[c] = plan.counts[c];
    // The site the stock came from is fixed when the visit first hands something out: the worker's site then,
    // unless the form named one. A later change of the worker's site does not move an earlier visit's stock.
    if (plan.lines.length && !v.supply_site_id && !(row && row.supply_site_id)) v.supply_site_id = S.siteForUser(v.user_id || (row && row.user_id) || ctx.user.id);
  }
  // Syringes and sharps brought back: a count, or an estimate from the container's volume.
  if (v.returns_estimated && v.sharps_returned_litres && (v.syringes_returned === undefined || v.syringes_returned === null)) v.syringes_returned = S.estimateReturns(v.sharps_returned_litres);
  if (v.syringes_returned === null) v.syringes_returned = 0;
  v._supply_plan = plan;
}
function applySupplies(ctx, row, plan) {
  if (plan) S.writeLines(row, plan.lines);
  S.reconcileVisit(row.id, ctx.user, { ip: ctx.ip });
}
function withLines(row) {
  const lines = S.visitLines(row.id);
  return { ...row, supplies: lines.map(l => ({ id: l.id, item_id: l.item_id, item: l.item_name, category: l.category, product: l.product, unit: l.unit, quantity: l.quantity })) };
}

module.exports = (r) => {
  crud.build(r, {
    table: 'interventions', entity: 'intervention', perm: 'interventions', clientRequired: false, dateCol: 'occurred_at',
    joins: 'JOIN users u ON u.id=interventions.user_id LEFT JOIN clients c ON c.id=interventions.client_id LEFT JOIN funding_sources f ON f.id=interventions.funding_source_id',
    select: 'interventions.*, u.display_name AS worker, c.client_code, f.name AS funding_source',
    // shape (supplies and returns included), owner and canEdit: server/rules/interventions.js (crud.js reads them from there).
    filters: (ctx, where, params) => {
      const t = ctx.query.get('type'); if (t) { where.push('interventions.type=?'); params.push(t); }
      // The funder report's "No funding source" warning links here, to the visits that need one.
      if (ctx.query.get('funding') === 'none') where.push('interventions.funding_source_id IS NULL');
    },
    afterLoad: (ctx, row) => withLines(decodeSummary(row)),
    beforeInsert: (ctx, v) => { planNote(ctx, v); v._log_time = v.log_time; delete v.log_time; v._time_category = v.time_category; delete v.time_category; v._service_date = v.service_date || null; delete v.service_date; if (v.cost !== undefined && v.cost !== null) v.cost = cents(v.cost); encodeSummary(v); checkCostPermission(ctx, v);
      // Nobody chose a fund (the field was not on the form: a role not shown it, or an API client): the
      // worker's default fund, else the programme's. An explicit "none" (null) is left as chosen.
      if (!('funding_source_id' in v)) { const f = require('./budget').defaultFundFor(v.user_id || ctx.user.id); if (f) v.funding_source_id = f; }
      planSupplies(ctx, v);
    },
    beforeUpdate: (ctx, v, row) => {
      if (v.note !== undefined && v.note !== null) throw badRequest('A note is added to a visit when it is recorded. To write one about an existing visit, use + Note on the client record.');
      delete v.note;
      delete v.log_time; delete v.time_category; v._service_date = v.service_date || null; delete v.service_date; if (v.cost !== undefined && v.cost !== null) v.cost = cents(v.cost); encodeSummary(v);
      checkCostPermission(ctx, v);
      planSupplies(ctx, v, row);
    },
    afterInsert: (ctx, row) => {
      // Optional automatic time entry + naloxone tracking on client
      if (row._log_time && row.duration_minutes > 0) {
        db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,funding_source_id,intervention_id,description_enc) VALUES(?,?,?,?,?,?,?,?,?)`,
          uuid(), row.user_id, row.client_id ?? null, serviceDate(row), row.duration_minutes, row._time_category || 'direct_service', row.funding_source_id || null, row.id, encrypt(O.labelOf('INTERVENTION_TYPES', row.type)));
      }
      // Community distribution has no client record to update, and no client to follow up with.
      if (row.naloxone_kits > 0 && row.client_id) db.run(`UPDATE clients SET naloxone_provided=1, naloxone_last_date=?, updated_at=? WHERE id=?`, serviceDate(row), db.now(), row.client_id);
      if (row.follow_up_due && row.client_id) db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,due_at,priority) VALUES(?,?,?,?,?,?,?)`,
        uuid(), row.client_id, row.user_id, ctx.user.id, require('../crypto').encrypt(`Follow up: ${O.labelOf('INTERVENTION_TYPES', row.type)}`), row.follow_up_due, 'normal');
      syncExpenditure(row);
      applySupplies(ctx, row, row._supply_plan);
      // The note written with the visit: in the same transaction, so both are saved or neither is.
      if (row._note) row._note.id = notes.insertNote(ctx, { ...row._note, intervention_id: row.id });
    },
    afterUpdate: (ctx, row, prev) => {
      syncExpenditure(row); syncTimeEntry(row, prev);
      if (row.client_id !== prev.client_id || row.user_id !== prev.user_id) S.relinkLines(row);
      applySupplies(ctx, row, row._supply_plan);
    },
    // Kits or strips handed out with no supply item to take them off (the form tells the worker): a count the
    // programme keeps no item of stays on the visit, with no line and nothing drawn down.
    insertResult: (ctx, row) => {
      const lines = S.visitLines(row.id);
      const u = Object.entries(SN.COUNTED).filter(([col, cat]) => Number(row[col] || 0) > 0 && !lines.some(l => l.category === cat))
        .map(([col]) => ({ item: UNTRACKED_NAMES[col], quantity: Number(row[col]) }));
      return { ...(u.length ? { supplies_untracked: u } : {}), ...(row._note && row._note.id ? { note_id: row._note.id } : {}) };
    },
    // The FKs from expenditures.intervention_id and time_entries.intervention_id are ON DELETE SET NULL, so
    // this has to run before the delete — after it, there is no longer any way to find the records this
    // intervention created.
    beforeDelete: (ctx, row) => {
      const existing = db.one(`SELECT * FROM expenditures WHERE intervention_id=?`, row.id);
      if (existing && existing.status === 'pending') { db.run(`DELETE FROM expenditures WHERE id=?`, existing.id); db.tombstone('expenditures', existing.id); }
      // The visit's automatic time entry: gone with the visit while nobody has approved it; once approved
      // it is part of a signed-off time sheet, so it is detached and marked instead of silently rewritten.
      const te = db.one(`SELECT * FROM time_entries WHERE intervention_id=?`, row.id);
      if (te && (te.status === 'draft' || te.status === 'submitted')) { db.run(`DELETE FROM time_entries WHERE id=?`, te.id); db.tombstone('time_entries', te.id); }
      else if (te) db.run(`UPDATE time_entries SET intervention_id=NULL, description_enc=?, updated_at=? WHERE id=?`, encrypt(`${te.description_enc ? decrypt(te.description_enc) : ''} (the visit this was logged from was deleted)`.trim()), db.now(), te.id);
      // What this visit drew from the shelf goes back: a deleted visit handed nothing out. Its lines go
      // with it (ON DELETE CASCADE), so the stock is put back before the row is deleted.
      db.transaction(() => {
        for (const l of db.all(`SELECT id FROM intervention_supplies WHERE intervention_id=?`, row.id)) { db.run(`DELETE FROM intervention_supplies WHERE id=?`, l.id); db.tombstone('intervention_supplies', l.id); }
        S.reconcileVisit(row.id, ctx.user, { ip: ctx.ip });
      });
    },
  });
  // Only ever called post-login (public/app.js's loadRefData(), itself only reached after /api/auth/me
  // succeeds) — no reason for this to be the one route in the app reachable without a session.
  supplies(r);
  // The lists as this programme has set them up (Settings → Lists): each managed list is the choices a new
  // record may use, in order, and option_lists carries the wording, including for retired choices an old
  // record still shows.
  // DEFAULT_LOCATION: where a new visit or overdose event starts (server/programme.js defaultLocation).
  r.get('/api/meta/constants', auth.requireAuth, () => { const m = O.meta(); return { ...C, ...m.visible, option_lists: m.option_lists, DEFAULT_LOCATION: require('../programme').defaultLocation(m.visible.LOCATIONS || C.LOCATIONS) }; });
};

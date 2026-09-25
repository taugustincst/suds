'use strict';
// Record retention. A discharged (or long-inactive) client's record is kept for the retention period the
// county sets (client_retention_years, default seven — HIPAA's documentation floor, and longer than most
// state SUD rules), counted from the last activity on it, and then hard-deleted, every table at once, so a
// record that should be gone is actually gone rather than soft-deleted and still readable by anyone with
// the database. A legal hold, or an episode that is still open on a closed record, exempts it until
// someone lifts it.
const db = require('./db');
const config = require('./config');
const audit = require('./audit');

// Every client-scoped table, children before parents. Tables whose client link is financial or
// staff-time bookkeeping (time_entries, expenditures) keep their rows with the client link removed:
// the money was spent and the hours were worked whether or not the person's record still exists.
// A disclosure cites the court order it relied on, so disclosures go before court_orders.
const DELETE_TABLES = ['care_plan_steps', 'care_plan_goals', 'problem_history', 'problems', 'asam_assessments', 'outcome_measures', 'client_form_files', 'client_forms', 'disclosures', 'court_orders', 'part2_notices', 'consents', 'patient_requests', 'referrals', 'tasks', 'calls', 'overdose_events', 'interventions', 'caloms_records', 'episodes', 'assignments', 'breakglass_events', 'privacy_incident_clients'];
// A complaint is the programme's record of how it answered one, and stays (unlinked) when the person's
// record goes; the incident register keeps its counts when a linked client is purged.
const UNLINK_TABLES = ['time_entries', 'expenditures', 'complaints'];
// Tables that never synchronise leave no tombstone behind.
const NO_TOMBSTONE = ['breakglass_events', 'privacy_incident_clients'];

function retentionYears() {
  const v = Number(db.getSetting('client_retention_years', ''));
  return Number.isFinite(v) && v > 0 ? v : config.clientRetentionYears;
}

// Every dated thing that can happen on a client's record, as `SELECT <date>` rows for client ?c. The
// retention clock runs from the latest of them — not from the discharge date alone: a visit logged in 2024
// against a client discharged in 2018 (outreach to a former client is real work) is the record's last
// activity, and purging it in 2025 would destroy a live record. When a new client-linked table is added,
// it belongs here too (test/load-review.test.js checks every client_id table is either listed here or in
// NOT_ACTIVITY).
const ACTIVITY = {
  clients: ['intake_date', 'discharge_date'],
  episodes: ['opened_at', 'closed_at'],
  caloms_records: ['record_date'],
  interventions: ['occurred_at'],
  calls: ['started_at'],
  notes: ['occurred_at', 'signed_at', 'cosigned_at'],
  note_addenda: ['created_at'],
  referrals: ['referred_at', 'appointment_at', 'admitted_at', 'closed_at', 'outcome_recorded_at'],
  tasks: ['due_at', 'completed_at'],
  consents: ['signed_at', 'revoked_at'],
  disclosures: ['disclosed_at'],
  client_forms: ['completed_at'],
  client_form_files: ['created_at'],
  overdose_events: ['occurred_at'],
  patient_requests: ['received_at', 'closed_at'],
  problems: ['onset_date', 'resolved_date', 'updated_at'],
  problem_history: ['created_at'],
  care_plan_goals: ['start_date', 'reviewed_at', 'updated_at'],
  care_plan_steps: ['completed_at', 'updated_at'],
  asam_assessments: ['assessed_at'],
  outcome_measures: ['administered_at'],
  court_orders: ['issued_at'],
  part2_notices: ['given_at'],
  time_entries: ['work_date'],
  expenditures: ['spent_at'],
};
// Client-linked tables that are not activity on the record: who was assigned, and emergency reads of it.
// A privacy complaint or an incident that touched the record is not care given to the person either.
const NOT_ACTIVITY = ['assignments', 'breakglass_events', 'complaints', 'privacy_incident_clients'];

function lastActivitySql() {
  const parts = [];
  for (const [t, cols] of Object.entries(ACTIVITY)) {
    for (const col of cols) {
      if (t === 'clients') parts.push(`SELECT substr(c.${col},1,10) d`);
      // Neither table has an index on a client column of its own; both are reached through their parent's.
      else if (t === 'note_addenda') parts.push(`SELECT MAX(substr(a.${col},1,10)) FROM note_addenda a JOIN notes n ON n.id=a.note_id WHERE n.client_id=c.id`);
      else if (t === 'client_form_files') parts.push(`SELECT MAX(substr(x.${col},1,10)) FROM client_form_files x JOIN client_forms f ON f.id=x.client_form_id WHERE f.client_id=c.id`);
      else parts.push(`SELECT MAX(substr(${col},1,10)) FROM ${t} WHERE client_id=c.id`);
    }
  }
  return `(SELECT MAX(d) FROM (${parts.join(' UNION ALL ')}))`;
}

/**
 * Clients whose record has passed the retention period and carries no hold. The clock starts at the last
 * activity of any kind on the record (ACTIVITY above). Closed and deceased records are due once that is
 * older than the period and every episode is closed. A record left "inactive" — a person who drifted
 * away and was never formally discharged — is due on the same clock: inactive is not a discharge, but
 * seven years with nothing at all recorded is the same record a discharge would have left, and an
 * episode nobody ever closed does not keep it forever. Active and waitlisted records are never due. A
 * record merged into another is purged with that record (same person), never on its own clock.
 */
function expiredClients(years = retentionYears(), now = new Date()) {
  const cutoff = new Date(now.getTime() - years * 365.25 * 86400000).toISOString().slice(0, 10);
  return db.all(`SELECT * FROM (
      SELECT c.id, c.client_code, c.legal_hold, c.status, ${lastActivitySql()} AS ended
      FROM clients c
      WHERE c.legal_hold=0
        AND c.merged_into IS NULL
        AND (c.status='inactive' OR (c.status IN ('closed','deceased') AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.client_id=c.id AND e.status='open')))
    ) WHERE ended IS NOT NULL AND ended <> '' AND ended < ?`, cutoff);
}

/**
 * Why a record that is past retention still cannot go: work that is still open on it. A purge would take
 * an open referral or request with it, and nobody would know it had ever been waiting. Empty when clear.
 */
function purgeBlockers(clientId) {
  const out = {};
  const n = (sql) => db.one(sql, clientId).n;
  const referrals = n(`SELECT COUNT(*) n FROM referrals WHERE client_id=? AND status IN ('pending','contacted','accepted','waitlisted','scheduled')`);
  const tasks = n(`SELECT COUNT(*) n FROM tasks WHERE client_id=? AND status IN ('open','in_progress')`);
  const requests = n(`SELECT COUNT(*) n FROM patient_requests WHERE client_id=? AND status='open'`);
  if (referrals) out.open_referrals = referrals;
  if (tasks) out.open_tasks = tasks;
  if (requests) out.open_requests = requests;
  return out;
}

/** Hard-delete one client and everything that hangs off the record. Audited by client code only. */
function purgeClient(client, { user = { username: 'system' }, reason = 'retention' } = {}) {
  const counts = {};
  db.transaction(() => {
    const noteIds = db.all(`SELECT id FROM notes WHERE client_id=?`, client.id).map(n => n.id);
    for (const id of noteIds) { db.run(`DELETE FROM note_addenda WHERE note_id=?`, id); }
    counts.notes = db.run(`DELETE FROM notes WHERE client_id=?`, client.id).changes;
    for (const id of noteIds) db.tombstone('notes', id);
    for (const t of DELETE_TABLES) {
      const ids = db.all(`SELECT id FROM ${t} WHERE client_id=?`, client.id).map(r => r.id);
      counts[t] = ids.length;
      if (!ids.length) continue;
      db.run(`DELETE FROM ${t} WHERE client_id=?`, client.id);
      if (!NO_TOMBSTONE.includes(t)) for (const id of ids) db.tombstone(t, id);
    }
    for (const t of UNLINK_TABLES) counts[t] = db.run(`UPDATE ${t} SET client_id=NULL, updated_at=? WHERE client_id=?`, db.now(), client.id).changes;
    // An import item that was guessed to be this person keeps a plain (non-FK) pointer; it must not dangle.
    counts.import_items_unlinked = db.run(`UPDATE import_items SET suggested_client_id=NULL, updated_at=? WHERE suggested_client_id=?`, db.now(), client.id).changes;
    // Records merged into this one are the same person: they go with it, not on a clock of their own.
    for (const dup of db.all(`SELECT id, client_code, legal_hold FROM clients WHERE merged_into=?`, client.id)) {
      if (dup.legal_hold) { db.run(`UPDATE clients SET merged_into=NULL, updated_at=? WHERE id=?`, db.now(), dup.id); continue; }
      purgeClient({ ...dup, ended: client.ended }, { user, reason: `merged into ${client.client_code} (${reason})` });
      counts.merged_records = (counts.merged_records || 0) + 1;
    }
    db.run(`DELETE FROM clients WHERE id=?`, client.id);
    db.tombstone('clients', client.id);
  });
  // The client id stays on the audit row (it is how the accounting of what was purged is found); the
  // code is the only identifier, and nothing about the person.
  audit.log({ user, action: 'client.purge', entity: 'client', entityId: client.id, clientId: client.id, details: { client_code: client.client_code, reason, ended: client.ended, counts } });
  return counts;
}

/** The housekeeping pass: purge everything past retention. Returns what was purged (codes only). */
function purgeExpiredClients(opts = {}) {
  const years = retentionYears();
  const purged = [];
  const skipped = [];
  for (const c of expiredClients(years)) {
    const blockers = purgeBlockers(c.id);
    if (Object.keys(blockers).length) {
      // Skipped, not silently: the record is due and someone has to close what is still open on it.
      console.warn(`[suds] retention: not purging ${c.client_code}: ${Object.entries(blockers).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}`);
      audit.log({ user: opts.user || { username: 'system' }, action: 'client.purge.skipped', entity: 'client', entityId: c.id, clientId: c.id, details: { client_code: c.client_code, ...blockers } });
      skipped.push(c.client_code);
      continue;
    }
    try { purgeClient(c, opts); purged.push(c.client_code); }
    catch (e) { console.error(`[suds] retention: could not purge ${c.client_code}: ${e.message}`); }
  }
  if (purged.length) console.log(`[suds] retention: purged ${purged.length} client record(s) older than ${years} years`);
  db.setSetting('client_retention_ran_at', db.now());
  return { years, purged, skipped };
}

/** Run at most once a day from the hourly housekeeping pass. */
function runIfDue() {
  const last = db.getSetting('client_retention_ran_at', null);
  if (last && Date.now() - Date.parse(last) < 86400000) return null;
  return purgeExpiredClients();
}

module.exports = { ACTIVITY, NOT_ACTIVITY, retentionYears, expiredClients, purgeBlockers, purgeClient, purgeExpiredClients, runIfDue, DELETE_TABLES, UNLINK_TABLES };

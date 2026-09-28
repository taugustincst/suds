'use strict';
// The rules for clients, for POST/PUT /api/clients and sync push: who a person is, contact details that can be
// right, and the columns only the office's own actions change (a legal hold, a removal, a merge).
const db = require('../db');
const auth = require('../auth');
const { define, flag } = require('./core');

// discharge_reason is a code from the DISCHARGE_REASONS list, like an episode's. A reason typed in before it
// became a list stays on the record and does not block editing it (validate's `existing`); only a new value is
// checked. A de-identified export writes anything outside the list as "other" (server/exports.js).
const FIELDS = {
  first_name: { type: 'string', required: true, maxLen: 100 }, last_name: { type: 'string', required: true, maxLen: 100 },
  preferred_name: { type: 'string', maxLen: 100 }, dob: { type: 'date' }, phone: { type: 'string', maxLen: 40 }, alt_phone: { type: 'string', maxLen: 40 },
  email: { type: 'string', maxLen: 200 }, address: { type: 'string', maxLen: 300 }, city: { type: 'string', maxLen: 100 }, zip: { type: 'string', maxLen: 12 },
  gender: { type: 'string', maxLen: 40 }, pronouns: { type: 'string', maxLen: 40 }, race_ethnicity: { type: 'string', maxLen: 100 }, preferred_language: { type: 'string', maxLen: 60 },
  veteran: { type: 'boolean' }, housing_status: { type: 'string', maxLen: 60 }, insurance: { type: 'string', maxLen: 100 }, medicaid_id: { type: 'string', maxLen: 40 },
  emergency_contact: { type: 'string', maxLen: 300 },
  status: { type: 'string', enum: ['waitlist', 'active', 'inactive', 'closed', 'deceased'] }, intake_date: { type: 'date' }, discharge_date: { type: 'date' }, discharge_reason: { type: 'string', maxLen: 200, list: 'DISCHARGE_REASONS' },
  referral_source: { type: 'string', maxLen: 120 }, referral_date: { type: 'date' }, engagement_date: { type: 'date' }, primary_substance: { type: 'string', maxLen: 60, list: 'SUBSTANCES' }, secondary_substances: { type: 'string', maxLen: 200 }, route_of_use: { type: 'string', maxLen: 60 },
  asam_level: { type: 'string', maxLen: 20 }, mat_status: { type: 'string', enum: ['none', 'interested', 'referred', 'active', 'discontinued', 'unknown'] }, mat_medication: { type: 'string', maxLen: 60 },
  overdose_history: { type: 'boolean' }, last_overdose_date: { type: 'date' }, naloxone_provided: { type: 'boolean' }, naloxone_last_date: { type: 'date' },
  risk_level: { type: 'string', enum: ['low', 'moderate', 'high', 'critical'] }, justice_involved: { type: 'boolean' }, pregnant_or_parenting: { type: 'boolean' }, co_occurring_mh: { type: 'boolean' },
  goals: { type: 'string', maxLen: 2000 }, flags: { type: 'string', maxLen: 300 }, race_codes: { type: 'string', maxLen: 200 }, contact_preferences: { type: 'string', maxLen: 300 }, ok_to_text: { type: 'boolean' }, ok_to_voicemail: { type: 'boolean' },
};

// Columns only an office action changes, and the permission that action needs: a device holding the permission
// may send them (the kernel has the same routes); anyone else's device keeps the office's values, so an edit to
// a client's address made before a legal hold was set can never lift the hold by winning last-write-wins.
const GUARDED = [
  [['legal_hold', 'legal_hold_reason_enc', 'legal_hold_cleared_reason_enc'], (u) => auth.hasPerm(u, 'clients:legal-hold')],
  [['deleted_at', 'removed_reason_enc'], (u) => auth.hasPerm(u, 'clients:all') && auth.hasPerm(u, 'clients:write')],
  [['merged_into'], (u) => auth.hasPerm(u, 'clients:merge')],
];
const DEFAULTS = { legal_hold: 0, legal_hold_reason_enc: null, legal_hold_cleared_reason_enc: null, deleted_at: null, removed_reason_enc: null, merged_into: null };

// Contact details that cannot be right are worse than none: a birth date in the future, "notanemail", a phone
// number with no digits. The form checks the same things, so a worker sees it before saving.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function contactProblems(row) {
  const fields = {};
  const dob = row.dob_enc;
  if (dob) {
    const today = require('../routes/budget').localDate();
    if (dob > today) fields.dob = 'cannot be in the future';
    else if (dob < '1900-01-01') fields.dob = 'must be after 1900';
  }
  if (row.email_enc && !EMAIL_RE.test(row.email_enc)) fields.email = 'is not a valid email address';
  for (const f of ['phone', 'alt_phone']) if (row[`${f}_enc`] && String(row[`${f}_enc`]).replace(/\D/g, '').length < 7) fields[f] = 'must contain at least 7 digits';
  return fields;
}

/** Find a client code no other client is using. Devices generate codes offline, so collisions are normal. */
function freeClientCode(code, id) {
  let candidate = code || 'M00-0000';
  for (let i = 0; i < 100; i++) {
    const clash = db.one(`SELECT id FROM clients WHERE client_code=? AND id<>?`, candidate, id);
    if (!clash) return candidate;
    candidate = `${code}-D${i + 2}`;
  }
  return `${code}-${id.slice(0, 8)}`;
}

/**
 * A client created on a device that matches an existing record by the intake form's duplicate rules. There is
 * no way to ask the worker in the field, so the row is accepted, audited (codes and reasons only) and a task is
 * raised for a supervisor (clients.js flagForReview). The device is told only about matches its user may open:
 * naming one they may not would say that person is a client here.
 */
function flagPossibleDuplicate(user, raw, clientCode, warnings) {
  let matches = [];
  try {
    matches = require('../routes/clients').possibleDuplicates({ first_name: raw.first_name_enc, last_name: raw.last_name_enc, dob: raw.dob_enc, phone: raw.phone_enc }, raw.id);
  } catch (e) {
    // Not fatal to the sync, but a duplicate nobody is told about is how two records for one person start.
    console.error('[suds] sync: the possible-duplicate check failed; no supervisor task was raised:', e && e.message);
    return;
  }
  if (!matches.length) return;
  const C = require('../routes/clients');
  C.flagForReview(user, { id: raw.id, client_code: clientCode, matches, source: 'sync', ip: 'device' });
  const codes = matches.filter(m => C.mayOpen(user, m.id)).map(m => m.client_code);
  if (codes.length) warnings.push({ table: 'clients', id: raw.id, reason: `possible duplicate of ${codes.length} existing record${codes.length === 1 ? '' : 's'} (${codes.join(', ')}); a supervisor has been asked to check` });
}

module.exports = define({
  table: 'clients',
  fields: FIELDS,
  tombstone: 'never', // clients are never hard-deleted through sync
  check(row, c) {
    const e = c.existing || {};
    const out = [];
    // Only what this write changes: an old record's unchanged phone number is not held to today's rule.
    const touched = Object.fromEntries(['dob_enc', 'email_enc', 'phone_enc', 'alt_phone_enc'].map(k => [k, row[k] !== undefined && (!c.existing || String(row[k] ?? '') !== String(c.was(k) ?? '')) ? row[k] : undefined]));
    const fields = contactProblems(touched);
    if (Object.keys(fields).length) out.push(flag(`was accepted, but its ${Object.keys(fields).map(f => f.replace('_', ' ')).join(' and ')} ${Object.keys(fields).length === 1 ? 'does' : 'do'} not look right (${Object.entries(fields).map(([k, m]) => `${k.replace('_', ' ')} ${m}`).join('; ')}); the office will review it`, { message: 'Validation failed', fields, code: 'contact' }));
    // Closing a client is a discharge, and a discharge is what closes the episode, ends the care team and clears
    // the open to-dos: it goes through the Episodes tab. (A device's own discharge sends the closed episode in
    // the same push, so an episode the batch closes does not count as open.)
    if ((row.status === 'closed' || row.status === 'deceased') && row.status !== e.status && c.existing) {
      const closing = new Set(((c.session && c.session.tables.episodes) || []).filter(x => x && x.status === 'closed').map(x => x.id));
      const open = db.all(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, row.id || e.id).filter(x => !closing.has(x.id));
      if (open.length) out.push(flag(`was accepted, but it was ${row.status === 'deceased' ? 'marked deceased' : 'closed'} while an episode of care is open; a discharge on the Episodes tab closes both`, { code: 'open_episode',
        message: `This client has an open episode of care. To ${row.status === 'deceased' ? 'record a death' : 'close the record'}, discharge them on the Episodes tab — that closes the episode and sets the status.`, fields: { status: 'discharge on the Episodes tab instead' }, extra: { open_episode: true } }));
    }
    return out;
  },
  normalise(row, c) {
    // Not sent means not written: the office's value (or, on a new record, the column's default) stands.
    for (const [cols, may] of GUARDED) if (!may(c.user)) for (const col of cols) row[col] = c.existing ? undefined : DEFAULTS[col];
    return null;
  },
  // A client that arrives with no creator was created by whoever is sending it (POST /api/clients records the
  // same); the assignments rules rely on it.
  beforeStore(row, c) { if (!c.existing && !row.created_by) row.created_by = c.user.id; },
  storeRow(o, row) { o.client_code = freeClientCode(o.client_code, row.id); },
  afterApply(row, o, c) {
    if (c.existing) return;
    // The office's own auto-assignment for a client created in the field, unless the device is sending the one
    // it made (server/rules/assignments.js), in which case that row is the assignment. A navigator or clinician
    // is assigned whether or not they are caseload-scoped, as POST /api/clients does: from 1.16.0 they hold
    // clients:all, and the assignment is what keeps the client on their caseload (and in reach) if the
    // programme later holds them to it.
    const own = (c.session.state.assignments || {}).selfForClient;
    if ((auth.caseloadRestricted(c.user) || ['navigator', 'clinician'].includes(c.user.role)) && !(own && own.get(row.id))) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, require('../crypto').uuid(), row.id, c.user.id, 'primary', (row.intake_date || db.now()).slice(0, 10), c.user.id);
    // A person entered on a phone may already be on the office books under another spelling. The row still
    // lands (the worker cannot check from the field), but a supervisor is told to look.
    flagPossibleDuplicate(c.user, row, o.client_code, c.session.warnings);
  },
});
module.exports.freeClientCode = freeClientCode;
module.exports.contactProblems = contactProblems;

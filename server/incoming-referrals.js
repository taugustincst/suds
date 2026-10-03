'use strict';
// Incoming referrals (1.24.0): referrals TO the programme — from an emergency department or hospital, a jail's re-entry
// team, a detox / withdrawal-management unit, probation, parole or a court, another provider, the person themselves, or
// their family or friends — and the intake queue that works them. docs/USER_GUIDE.md "Incoming referrals".
//
//   new ──(an attempt to reach the person is logged)──> contacting ──> accepted   (linked to a client record: an existing
//    │                                                       │                    one found by the duplicate check or the
//    └───────────────────────────────────────────────────────┴──> declined         client search, or a new one made from
//                                                                 unable_to_reach  the referral's details)
//                                                                 referred_elsewhere
//   A closed referral other than an accepted one can be reopened (a decline recorded by mistake).
//
// Who sees what: intake:read sees every open referral. A referred person is nobody's client yet, so there is no caseload
// to scope an open referral by; intake is a shared desk, and a programme that wants someone kept out of it denies them
// intake:read. Once accepted, the referral is the client's: a person held to their caseload lists and opens it only
// when that client is on their caseload (routes/incoming-referrals.js visibleFilter; 403 otherwise, as for the client),
// and the client record is reached as every client record is: accepting into an existing record needs that record to
// be one the person may open. The counts (summary) name nobody and cover the whole queue.
//
// Part 2 / HIPAA: receiving a referral is not a disclosure (nothing leaves the programme), so nothing here goes through
// server/disclosure.js. Nothing is ever sent back to the referrer either: telling a hospital or a court that the person
// became a client here would be a disclosure, and SUDS offers no such action. A worker who must answer the referrer does
// so under a consent, recorded on the client's Consents tab, as for any other disclosure.
//
// PHI: the person's name, date of birth and phone, the reason and needs, the notes, the outcome reason, each attempt's
// note and the referrer's own name, phone and email are encrypted (_enc); the surname's blind index (_idx) is the
// queue's search. The referring organisation's name is not PHI (it names a hospital or an agency, not the person). The
// audit trail records which fields and statuses, never a value. Office server only (server/sync-tables.js server_only):
// a device that syncs with an office refuses the routes; SUDS on this device keeps its own queue.
const db = require('./db');
const { encrypt, decrypt, blindIndex } = require('./crypto');

const SOURCE_TYPES = ['er_hospital', 'jail_reentry', 'detox', 'justice', 'other_provider', 'self', 'family_friend', 'other'];
const SOURCE_LABELS = { er_hospital: 'Emergency department or hospital', jail_reentry: 'Jail or re-entry', detox: 'Detox or withdrawal management', justice: 'Probation, parole or court', other_provider: 'Another provider or agency', self: 'Self-referral', family_friend: 'Family or friend', other: 'Other' };
const VIA = ['phone', 'fax', 'email', 'walk_in', 'ereferral'];
const URGENCY = ['routine', 'soon', 'urgent'];
const STATUSES = ['new', 'contacting', 'accepted', 'declined', 'unable_to_reach', 'referred_elsewhere'];
const OPEN = ['new', 'contacting'];
const CLOSE_STATUSES = ['declined', 'unable_to_reach', 'referred_elsewhere'];
const ATTEMPT_METHODS = ['phone', 'text', 'email', 'in_person', 'letter', 'other'];
const ATTEMPT_OUTCOMES = ['reached', 'left_message', 'no_answer', 'wrong_number', 'other'];

// The API's field names for the encrypted columns (x is x_enc).
const ENC = ['referrer_name', 'referrer_phone', 'referrer_email', 'reason', 'first_name', 'last_name', 'dob', 'phone', 'notes', 'outcome_reason'];
const PLAIN = ['source_type', 'referring_org', 'received_at', 'received_via', 'urgency'];

/** The details a referral is recorded with, as validate.js shapes them. `create` makes the required ones required. */
function shape({ create = false } = {}) {
  return {
    source_type: { type: 'string', enum: SOURCE_TYPES, required: create },
    referring_org: { type: 'string', maxLen: 200 },
    referrer_name: { type: 'string', maxLen: 200 },
    referrer_phone: { type: 'string', maxLen: 40 },
    referrer_email: { type: 'string', maxLen: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    received_at: { type: 'datetime' },
    received_via: { type: 'string', enum: VIA, required: create },
    urgency: { type: 'string', enum: URGENCY },
    reason: { type: 'string', maxLen: 4000 },
    first_name: { type: 'string', maxLen: 100 },
    last_name: { type: 'string', maxLen: 100 },
    dob: { type: 'date' },
    phone: { type: 'string', maxLen: 40 },
    notes: { type: 'string', maxLen: 4000 },
    assigned_to: { type: 'string', maxLen: 64 },
  };
}

/**
 * Whether this database keeps the queue. The office does; SUDS on this device (no office) keeps its own; a device that
 * syncs with an office does not (the queue is the office's, never synchronised), so the routes refuse there rather than
 * keep referrals the office would never see. The same test client revision history uses (server/client-revisions.js).
 */
function keptHere() { return require('./client-revisions').keptHere(); }
const OFFICE_ONLY = 'Incoming referrals are kept at the office. Open the office SUDS to record or work one.';

/** The column values for the encrypted and plain fields `v` carries (only those it carries). */
function toColumns(v) {
  const cols = {};
  for (const k of PLAIN) if (v[k] !== undefined) cols[k] = v[k];
  for (const k of ENC) if (v[k] !== undefined) cols[`${k}_enc`] = v[k] === null || v[k] === '' ? null : encrypt(String(v[k]));
  if (v.last_name !== undefined) cols.last_name_idx = v.last_name ? blindIndex(v.last_name) : null;
  if (v.assigned_to !== undefined) cols.assigned_to = v.assigned_to || null;
  return cols;
}

const dec = (x) => { if (!x) return null; try { return decrypt(x); } catch { return null; } };
const userName = (id) => (id ? (db.one(`SELECT display_name FROM users WHERE id=?`, id) || {}).display_name || null : null);

/** Hours from received to the first attempt to reach the person, to one decimal; null when nobody has tried yet. */
function hoursToFirstContact(row) {
  if (!row.first_contact_at || !row.received_at) return null;
  const ms = Date.parse(row.first_contact_at) - Date.parse(row.received_at);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 360000) / 10) : null;
}

/** A stored row as the API returns it: the encrypted fields decrypted, names of the staff it mentions. */
function present(row) {
  const out = { id: row.id };
  for (const k of PLAIN) out[k] = row[k];
  for (const k of ENC) out[k] = dec(row[`${k}_enc`]);
  out.display_name = [out.first_name, out.last_name].filter(Boolean).join(' ') || 'Name not given';
  out.source_label = SOURCE_LABELS[row.source_type] || row.source_type;
  Object.assign(out, {
    status: row.status, assigned_to: row.assigned_to, assignee_name: userName(row.assigned_to),
    first_contact_at: row.first_contact_at, hours_to_first_contact: hoursToFirstContact(row),
    client_id: row.client_id, client_code: row.client_id ? (db.one(`SELECT client_code FROM clients WHERE id=?`, row.client_id) || {}).client_code || null : null,
    accepted_as: row.accepted_as, closed_at: row.closed_at, closed_by: row.closed_by, closed_by_name: userName(row.closed_by),
    created_by: row.created_by, created_by_name: userName(row.created_by), created_at: row.created_at, updated_at: row.updated_at,
    open: OPEN.includes(row.status),
  });
  const a = db.one(`SELECT COUNT(*) n, MAX(attempted_at) last FROM incoming_referral_attempts WHERE referral_id=?`, row.id);
  out.attempts_count = a.n; out.last_attempt_at = a.last || null;
  return out;
}

/** A referral's attempts to reach the person, oldest first, their notes decrypted. */
function attempts(referralId) {
  return db.all(`SELECT a.*, u.display_name AS user_name FROM incoming_referral_attempts a LEFT JOIN users u ON u.id=a.user_id WHERE a.referral_id=? ORDER BY a.attempted_at, a.created_at`, referralId)
    .map(a => ({ id: a.id, attempted_at: a.attempted_at, method: a.method, outcome: a.outcome, notes: dec(a.notes_enc), user_id: a.user_id, user_name: a.user_name, created_at: a.created_at }));
}

/** The person's details the duplicate check matches on (server/routes/clients.js possibleDuplicates). */
function matchDetails(row) {
  return { first_name: dec(row.first_name_enc) || undefined, last_name: dec(row.last_name_enc) || undefined, dob: dec(row.dob_enc) || undefined, phone: dec(row.phone_enc) || undefined };
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10; };

/**
 * The queue in numbers, for Home and Supervision: counts only, no person. Time to first contact is over the
 * referrals received in the last `days` days: how many there were, how many somebody has tried to reach, the median
 * hours from received to that first attempt, and how many were tried within 24 hours.
 */
function summary(user, { days = 90, now = new Date() } = {}) {
  const n = (sql, ...p) => db.one(sql, ...p).n;
  const open = `status IN ('new','contacting')`;
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const recent = db.all(`SELECT received_at, first_contact_at FROM incoming_referrals WHERE received_at >= ?`, since);
  const hours = recent.map(hoursToFirstContact).filter(x => x !== null);
  const oldest = db.one(`SELECT MIN(received_at) at FROM incoming_referrals WHERE status='new'`).at || null;
  return {
    new: n(`SELECT COUNT(*) n FROM incoming_referrals WHERE status='new'`),
    contacting: n(`SELECT COUNT(*) n FROM incoming_referrals WHERE status='contacting'`),
    open: n(`SELECT COUNT(*) n FROM incoming_referrals WHERE ${open}`),
    unassigned: n(`SELECT COUNT(*) n FROM incoming_referrals WHERE ${open} AND assigned_to IS NULL`),
    urgent: n(`SELECT COUNT(*) n FROM incoming_referrals WHERE ${open} AND urgency='urgent'`),
    new_urgent: n(`SELECT COUNT(*) n FROM incoming_referrals WHERE status='new' AND urgency='urgent'`),
    mine: user ? n(`SELECT COUNT(*) n FROM incoming_referrals WHERE ${open} AND assigned_to=?`, user.id) : 0,
    oldest_new_at: oldest,
    first_contact: { days, received: recent.length, contacted: hours.length, median_hours: median(hours), within_24h: hours.filter(h => h <= 24).length },
  };
}

module.exports = { SOURCE_TYPES, SOURCE_LABELS, VIA, URGENCY, STATUSES, OPEN, CLOSE_STATUSES, ATTEMPT_METHODS, ATTEMPT_OUTCOMES, ENC, PLAIN, shape, keptHere, OFFICE_ONLY, toColumns, present, attempts, matchDetails, hoursToFirstContact, summary, median };

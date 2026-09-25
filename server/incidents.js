'use strict';
// The privacy incident register and what the breach notification rule makes of an incident. Since the 2024
// Part 2 final rule, a breach of Part 2 records is notified exactly as HIPAA requires (45 CFR §§164.400-414,
// applied by 42 CFR §2.16): a breach is presumed unless a documented four-factor risk assessment shows a low
// probability that the information was compromised, and notice is due without unreasonable delay and in no
// case later than 60 calendar days after discovery. This module computes those deadlines; deciding whether
// something is a breach, and what the notices say, is the programme's (and its counsel's) job.
const db = require('./db');
const audit = require('./audit');
const { uuid, encrypt } = require('./crypto');

const DAY = 86400000;
const NOTICE_DAYS = 60;
// §164.408(b): 500 or more individuals → the Secretary is told at the same time as the individuals.
const HHS_IMMEDIATE_AT = 500;
// §164.406: more than 500 residents of one State or jurisdiction → prominent media outlets there too.
const MEDIA_OVER = 500;
// How close a deadline has to be for Home to start warning about it.
const WARN_DAYS = 14;

const addDays = (date, n) => new Date(Date.parse(String(date).slice(0, 10) + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * What the breach notification rule requires of this incident, and by when. Every obligation is
 * { required, due, done, overdue }. Only an incident determined to be a breach owes notices; one still
 * 'pending' carries the same clock (it runs from discovery, not from the determination) so the
 * determination is not left until the deadline has passed.
 */
function obligations(i) {
  const deadline = addDays(i.discovered_at, NOTICE_DAYS);
  // A law-enforcement delay (§164.412) moves the deadline, never earlier than it was.
  const due = i.law_enforcement_delay_until && i.law_enforcement_delay_until > deadline ? i.law_enforcement_delay_until.slice(0, 10) : deadline;
  const breach = i.determination === 'breach'; const live = i.determination !== 'not_breach';
  const t = today();
  const ob = (required, when, doneAt) => ({ required, due: required ? when : null, done: !!doneAt, done_at: doneAt || null, overdue: required && !doneAt && when < t });
  // Fewer than 500: the Secretary is told in the annual log, within 60 days of the end of the calendar year
  // the breach was discovered in (§164.408(c)).
  const year = Number(String(i.discovered_at).slice(0, 4));
  const hhsDue = (i.affected_count || 0) >= HHS_IMMEDIATE_AT ? due : addDays(`${year}-12-31`, NOTICE_DAYS);
  const out = {
    deadline: due,
    days_left: Math.round((Date.parse(due) - Date.parse(t)) / DAY),
    determination_overdue: i.determination === 'pending' && due < t,
    individuals: ob(breach, due, i.individuals_notified_at),
    hhs: ob(breach, hhsDue, i.hhs_notified_at),
    hhs_route: (i.affected_count || 0) >= HHS_IMMEDIATE_AT ? 'contemporaneous' : 'annual_log',
    media: ob(breach && (i.max_in_one_state || 0) > MEDIA_OVER, due, i.media_notified_at),
  };
  // Anything owed and not done, or a determination not yet made, is what Home warns about.
  const open = [out.individuals, out.hhs, out.media].filter(o => o.required && !o.done);
  out.attention = i.status === 'open' && live && (i.determination === 'pending' || open.length > 0);
  out.next_due = i.determination === 'pending' ? due : open.map(o => o.due).sort()[0] || null;
  out.warn = out.attention && out.next_due && Math.round((Date.parse(out.next_due) - Date.parse(t)) / DAY) <= WARN_DAYS;
  out.overdue = out.determination_overdue || open.some(o => o.overdue);
  return out;
}

/**
 * Open a draft incident for a security event that might be a breach. At most one open draft per source and
 * reference, so the same broken audit chain checked every night does not open a new incident every night.
 * `description` must not contain PHI beyond what the incident needs; it is stored encrypted regardless.
 */
function draft({ source, sourceRef = null, title, description = '', user = null }) {
  const existing = db.one(`SELECT id FROM privacy_incidents WHERE source=? AND COALESCE(source_ref,'')=? AND status='open' AND determination='pending'`, source, sourceRef || '');
  if (existing) return existing.id;
  const id = uuid();
  db.run(`INSERT INTO privacy_incidents(id,title,discovered_at,source,source_ref,description_enc,reported_by) VALUES(?,?,?,?,?,?,?)`,
    id, title, today(), source, sourceRef, description ? encrypt(description) : null, user && user.id && !String(user.id).startsWith('system') ? user.id : null);
  audit.log({ user: user || { username: 'system' }, action: 'incident.draft', entity: 'privacy_incident', entityId: id, details: { source } });
  return id;
}

/** An identified export of this many clients or more opens a draft incident for review. */
function massExportThreshold() { const v = Number(db.getSetting('mass_export_threshold', '')); return Number.isFinite(v) && v > 0 ? v : 500; }
function maybeMassExport({ clients, kind, user }) {
  if (clients < massExportThreshold()) return null;
  return draft({ source: 'mass_export', sourceRef: `${kind}:${new Date().toISOString().slice(0, 10)}:${user.id}`, title: `Identified export of ${clients} clients (${kind})`,
    description: `An identified export (${kind}) naming ${clients} clients was made by ${user.display_name || user.username}. Confirm it was authorised and went where it was recorded as going; if so, determine "not a breach" with that reason.`, user });
}

/** The audit chain failed verification (scheduled, or an administrator's check). */
function chainFailure(r, user = null) {
  return draft({ source: 'audit_chain', sourceRef: 'audit_log', title: 'Audit log failed its integrity check',
    description: `The audit log's hash chain did not verify (${r.truncated ? `truncated: ${r.reason || 'rows missing from the end'}` : `first bad entry ${r.firstBadId}`}). Establish whether audit entries were altered or removed, and whether that concealed access to client records.`, user });
}

module.exports = { obligations, draft, chainFailure, maybeMassExport, massExportThreshold, NOTICE_DAYS, HHS_IMMEDIATE_AT, MEDIA_OVER, WARN_DAYS };

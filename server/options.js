'use strict';
// The choices on documentation forms, as the programme has set them up (Settings → Lists).
//
// Each list has built-in choices, defined in code (server/constants.js), and an administrator may reword
// them, put them in a different order, retire (hide) the ones the programme does not use, and add its own.
// Only the differences are stored, one row per changed choice in option_overrides. The stored code never
// changes, so an old record keeps its meaning and every report keeps counting it the same way; only the
// words people see change.
//
// This is the one resolver: the forms (GET /api/meta/*), server-side validation (validate.js `list:`),
// exports and imports all ask it, so a renamed choice reads the same everywhere, a retired one is refused
// on a new record but kept on an old one, and a programme's own choice is accepted like a built-in one.
const db = require('./db');
const C = require('./constants');

// The same wording rules as fmt.label() in public/app.js, for a code nobody has given a label.
function humanize(s) {
  if (!s) return '';
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSbirt\b/, 'SBIRT').replace(/\bMat\b/g, 'MAT').replace(/\bOtp\b/, 'OTP').replace(/\bObot\b/, 'OBOT').replace(/\bEd\b/, 'ED').replace(/\bMh\b/, 'MH').replace(/\bRx\b/, 'Rx').replace(/\bIds\b/, 'IDs').replace(/\bRoi\b/, 'ROI').replace(/\bPart2 Disclosure\b/, 'Part 2 disclosure').replace(/\bPart2\b/g, 'Part 2');
}

// Why a choice cannot be retired. Each of these codes appears literally in server logic (a count, a
// consent check, an automatic status change); hiding it would quietly break that, so it can be reworded
// only. The note is shown next to it on the Lists page as "Used by SUDS: …".
const OPEN_SHARED = 'the provider has been told who the client is (consent check), and the referral counts as open';
const LISTS = [
  { key: 'INTERVENTION_TYPES', group: 'Visits & services', name: 'What did you do?', codes: C.INTERVENTION_TYPES,
    protect: { outreach: 'can be recorded without a client', naloxone_distribution: 'can be recorded without a client' } },
  { key: 'LOCATIONS', group: 'Visits & services', name: 'Location', codes: C.LOCATIONS },
  { key: 'MODALITIES', group: 'Visits & services', name: 'Modality', codes: C.MODALITIES },
  { key: 'OUTCOMES', group: 'Visits & services', name: 'Outcome', codes: C.OUTCOMES },
  { key: 'CALL_CONTACT_TYPES', group: 'Calls & texts', name: 'Who', codes: C.CALL_CONTACT_TYPES },
  { key: 'CALL_OUTCOMES', group: 'Calls & texts', name: 'Outcome (phone call)', codes: C.CALL_OUTCOMES,
    protect: { reached: 'counts as contact with the client (last contact, "no contact in 30 days")', crisis_escalated: 'marks the call as a crisis' } },
  { key: 'TEXT_OUTCOMES', group: 'Calls & texts', name: 'Outcome (text message)', codes: C.TEXT_OUTCOMES,
    protect: { replied: 'counts as contact with the client (last contact, "no contact in 30 days")', sent: 'what a text with no outcome is recorded as' } },
  // No additions: every status means something to the consent check, loop closure and the open/closed
  // counts (server/routes/referrals.js SHARED_STATUSES / CLOSED_STATUSES, reports.js), and a new one would
  // silently mean none of them.
  { key: 'REFERRAL_STATUSES', group: 'Referrals', name: 'Status / What happened', codes: C.REFERRAL_STATUSES, custom: false,
    protect: { pending: 'a new referral starts here and counts as open', contacted: OPEN_SHARED, accepted: OPEN_SHARED, waitlisted: OPEN_SHARED, scheduled: OPEN_SHARED,
      admitted: 'records an admission (funder report, loop closure)', completed: 'counts as a successful referral and closes it', closed: 'closes the referral',
      declined_by_client: 'closes the referral', declined_by_provider: 'closes the referral' },
    why: 'Statuses can be reworded, but not added to: each one tells SUDS whether the provider has been told who the client is, and whether the referral is open, closed or successful.' },
  { key: 'REFERRAL_BARRIERS', group: 'Referrals', name: 'If it did not happen, why', codes: C.REFERRAL_BARRIERS },
  // No additions: overdose_events.kind has a CHECK constraint, and each kind is a different count.
  { key: 'OVERDOSE_KINDS', group: 'Overdose & reversals', name: 'What happened', codes: C.OVERDOSE_KINDS, custom: false,
    labels: { overdose: 'Overdose (no naloxone given)', reversal: 'Overdose reversed with naloxone', fatal: 'Fatal overdose' },
    protect: { overdose: 'counted as an overdose in reports', reversal: 'counted as a naloxone reversal in reports', fatal: 'marks the client deceased and closes their episode' },
    why: 'These can be reworded, but not added to: each is a separate count in the overdose and funder reports.' },
  { key: 'ADMINISTERED_BY', group: 'Overdose & reversals', name: 'Given by', codes: C.ADMINISTERED_BY,
    labels: { bystander: 'A bystander', first_responder: 'A first responder', staff: 'Our staff', self: 'The person themselves', family: 'Family member', unknown: 'Unknown' },
    protect: { unknown: 'a blank answer is counted as Unknown in reports' } },
  { key: 'TIME_CATEGORIES', group: 'Time', name: 'Category', codes: C.TIME_CATEGORIES,
    protect: { direct_service: 'time logged automatically from visits and calls' } },
  { key: 'NOTE_FORMATS', group: 'Notes', name: 'Format', codes: C.NOTE_FORMATS,
    labels: { handoff: 'Shift hand-off (for the next worker on)', safety_plan: 'Safety plan (structured)' },
    protect: { narrative: 'the default format, and what imported notes are saved as', SOAP: 'has its own structured sections', DAP: 'has its own structured sections',
      BIRP: 'has its own structured sections', GIRP: 'has its own structured sections', handoff: 'listed in shift hand-offs', safety_plan: 'shown as the client\'s safety plan' } },
  { key: 'SUBSTANCES', group: 'Clients', name: 'Primary substance', codes: C.SUBSTANCES,
    protect: { unknown: 'a blank answer is counted as Unknown in reports and filters' } },
  { key: 'DISCHARGE_REASONS', group: 'Episodes of care', name: 'Reason for discharge', codes: C.DISCHARGE_REASONS,
    labels: { completed: 'Completed the program', transferred: 'Transferred to another provider', incarcerated: 'Incarcerated', moved: 'Moved out of the area', lost_contact: 'Lost contact',
      declined: 'Declined further services', deceased: 'Deceased', administrative: 'Administrative closure', other: 'Other' },
    protect: { deceased: 'marks the client deceased' } },
];
const BY_KEY = new Map(LISTS.map(l => [l.key, l]));

// Lists that are deliberately not editable, and why (shown on the Lists page so nobody goes looking).
const EXCLUDED = [
  { name: 'Race and ethnicity', why: 'Federal (OMB) reporting categories that funder reports count as they are.' },
  { name: 'ASAM level of care', why: 'The ASAM criteria levels: a national standard, not a programme choice.' },
  { name: 'Stage of change', why: 'The stages of the transtheoretical model: a clinical standard.' },
  { name: 'Consent type', why: 'Each type is a different legal authority under 42 CFR Part 2 and HIPAA.' },
  { name: 'Patient-rights request', why: 'The four HIPAA rights (access, amendment, restriction, accounting), each with its own legal deadline.' },
  { name: 'Funding type', why: 'Grouped by funder in reports; add funding sources themselves under Funding sources below.' },
  { name: 'Phone call or text', why: 'Fixed by the database: each has its own outcomes list above.' },
];

const MAX_LABEL = 80;
const RESERVED = new Set(['all', 'open', 'none_selected']);

function has(key) { return BY_KEY.has(key); }
function def(key) { const l = BY_KEY.get(key); if (!l) throw new Error(`Unknown option list ${key}`); return l; }
function overrideRows(key) {
  try { return db.all(`SELECT * FROM option_overrides WHERE list_key=?`, key); }
  catch { return []; } // a database that predates migration 28 (opened read-only by a script) has no lists of its own
}

/**
 * Every choice in a list, built-in and the programme's own, in the order the administrator set, with
 * hidden ones included (flagged). { code, label, default_label, hidden, custom, protected }.
 */
function entries(key) {
  const l = def(key);
  const rows = new Map(overrideRows(key).map(r => [r.code, r]));
  const out = l.codes.map((code, i) => {
    const r = rows.get(code);
    const dflt = (l.labels && l.labels[code]) || humanize(code);
    return { code, label: (r && r.label) || dflt, default_label: dflt, hidden: !!(r && r.hidden) && !(l.protect && l.protect[code]), custom: false,
      protected: (l.protect && l.protect[code]) || null, _order: r && r.sort_order !== null && r.sort_order !== undefined ? r.sort_order : 1000 + i };
  });
  const builtin = new Set(l.codes);
  let n = 0;
  for (const r of rows.values()) {
    if (builtin.has(r.code) || !r.is_custom) continue;
    out.push({ code: r.code, label: r.label || humanize(r.code), default_label: null, hidden: !!r.hidden, custom: true, protected: null,
      _order: r.sort_order !== null && r.sort_order !== undefined ? r.sort_order : 2000 + (n++) });
  }
  out.sort((a, b) => a._order - b._order);
  return out.map(({ _order, ...e }) => e);
}
/** The codes a new record may use, in order. */
function visible(key) { return entries(key).filter(e => !e.hidden).map(e => e.code); }
/** Every code the list knows, hidden or not. */
function known(key) { return entries(key).map(e => e.code); }
/**
 * Whether a submitted value is acceptable: one the list offers now, or — when a record is being edited —
 * the value that record already has (a choice retired since it was recorded is kept, not refused).
 */
function accepts(key, value, existing) {
  if (value === null || value === undefined || value === '') return true;
  if (existing !== undefined && existing !== null && value === existing) return true;
  return visible(key).includes(value);
}
/** code -> label for one list. */
function labelMap(key) { return Object.fromEntries(entries(key).map(e => [e.code, e.label])); }
function labelOf(key, code) { if (code === null || code === undefined || code === '') return code; if (!has(key)) return humanize(code); return labelMap(key)[code] || humanize(code); }

/** Everything the forms need: visible codes per list (as the plain arrays they always used) and the details. */
function meta() {
  const option_lists = {}; const visibleLists = {};
  for (const l of LISTS) { const es = entries(l.key); option_lists[l.key] = es; visibleLists[l.key] = es.filter(e => !e.hidden).map(e => e.code); }
  return { visible: visibleLists, option_lists };
}

/** The Lists page: every editable list, grouped, and the ones that are not editable. */
function describe() {
  return {
    lists: LISTS.map(l => ({ key: l.key, group: l.group, name: l.name, custom_allowed: l.custom !== false, note: l.why || null, entries: entries(l.key) })),
    excluded: EXCLUDED,
  };
}

// A code for a programme's own choice: from its label, lower case, words joined by underscores; never one
// the list already has (built-in or added earlier), so it cannot be mistaken for a built-in.
function slug(label, taken) {
  let base = String(label).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '');
  if (!base || RESERVED.has(base)) base = base ? `${base}_custom` : 'custom';
  let code = base; let i = 2;
  while (taken.has(code)) code = `${base}_${i++}`;
  return code;
}

module.exports = { LISTS, EXCLUDED, MAX_LABEL, has, def, entries, visible, known, accepts, labelMap, labelOf, meta, describe, slug, humanize };

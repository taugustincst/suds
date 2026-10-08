'use strict';
// Reporting-cadence reminders, the programme's side (released in 1.21.0; docs/COUNTY-VIEW.md,
// "Reminders on the programme's side").
//
// A programme sends its county a county submission file for each period the county expects (a quarter, usually). This
// works out, for each county the programme reports to, which periods are expected, by when, and whether the file for
// each was made or sent, so the programme's Home and its Send to the county card can say "County file for
// Jul – Sep 2026 due by Oct 30, 2026 — not yet made".
//
// Where the schedule comes from:
//   - A county connected over the county connection (county-connect-client.js) publishes its cadence, the periods it
//     expects, when each is due and which it has received, through its /status. The last answer is kept
//     (county_connect_last_status, checked there) and used for that county: it is the county's own word, and it counts
//     a file the programme emailed and the county imported by hand as received too.
//   - Otherwise the programme records the schedule itself for a county code: the cadence, how many days after a period
//     ends its file is due, and the first period to remind about (county_submission_schedules). Nothing before that is
//     ever reminded about: a programme that sent earlier files by email is not told they are missing.
//
// What counts as done: for a county not connected, the file for the period made on this server (downloaded; SUDS
// cannot see the email that carries it); for the connected county, the period received by the county (its /status), or
// sent over the connection and accepted. The files made are recorded as they are made (county_submission_made: the
// county code, the period, the payload's SHA-256, the version, how; no figures), as the file route's audit entry
// (county_submission.export) and the send log (county_connect_sends) already record them.
//
// Settings only (no figures, no PHI; not synced to devices: sync-tables.js settings_keys does not list them). Office
// server only, as the file is: SUDS on this device cannot make a county file (the county route module is left out of the
// device kernel), so it has no reminders either.
const db = require('./db');

const SETTING_SCHEDULES = 'county_submission_schedules';
const SETTING_MADE = 'county_submission_made';
/** The most made-file records kept (four quarters a year for a few counties, for years). */
const MADE_MAX = 200;
const CADENCES = ['quarterly_calendar', 'quarterly_fiscal', 'monthly'];
const DUE_DAYS_DEFAULT = 30;
const DUE_DAYS_MAX = 180;

const K = () => require('./county');
const plusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const today = () => require('./local-date').localDate();

function readJson(key, fallback) {
  try { const v = JSON.parse(db.getSetting(key, 'null')); return v === null || v === undefined ? fallback : v; } catch { return fallback; }
}

// ---- files made -------------------------------------------------------------------------------------------------------
/** Every county file this server made, newest first: [{ county_code, from, to, sha256, schema_version, via, at }]. */
function made() { const v = readJson(SETTING_MADE, []); return Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []; }
/** Record a file made (the download route, or a send): its county code, period, hash, version and how (download, send, auto). */
function recordMade({ county_code: code, from, to, sha256, schema_version: v, via }) {
  const list = [{ county_code: code, from, to, sha256, schema_version: v, via, at: db.now() }, ...made()].slice(0, MADE_MAX);
  db.setSetting(SETTING_MADE, JSON.stringify(list));
}

// ---- the programme's own schedules ---------------------------------------------------------------------------------------
/** The schedules the programme recorded: { CODE: { name, cadence, due_days, start, set_at } }. */
function schedules() { const v = readJson(SETTING_SCHEDULES, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
/**
 * The first period a new schedule reminds about, unless the person chooses: the start of the latest complete period of
 * the cadence, so the file due now is reminded about and nothing earlier (sent before SUDS kept a record) is.
 */
function defaultStart(cadence, day = today()) {
  const P = require('./county-periods');
  const last = cadence === 'monthly' ? P.completeMonths(day, 1)[0] : P.completeQuarters(day, 1)[0];
  return last ? last.from : day;
}
/**
 * Save the schedule for one county: its code, its name as the card shows it, the cadence, the days after a period's
 * end its file is due, and the first period to remind about. Throws Error with { field } and a sentence.
 */
function saveSchedule({ county_code: rawCode, county_name: rawName, cadence, due_days: dueDays, start }) {
  const C = K();
  const bad = (field, message) => Object.assign(new Error(message), { field });
  const code = C.normaliseCode(rawCode);
  if (!code) throw bad('county_code', 'Type the county code the county gave you (eight letters and digits).');
  if (!CADENCES.includes(cadence)) throw bad('cadence', 'Choose how often the county expects the file: every quarter or every month.');
  const due = dueDays === undefined || dueDays === null || dueDays === '' ? DUE_DAYS_DEFAULT : Number(dueDays);
  if (!Number.isInteger(due) || due < 1 || due > DUE_DAYS_MAX) throw bad('due_days', `The file is due 1 to ${DUE_DAYS_MAX} days after a period ends: type a whole number of days.`);
  const first = start ? String(start) : defaultStart(cadence);
  if (!C.isDay(first)) throw bad('start', 'The first period to remind about must start on a real date (YYYY-MM-DD).');
  const name = C.cleanText(rawName, C.TEXT_MAX.county_name) || (schedules()[code] || {}).name || '';
  const all = schedules();
  all[code] = { name, cadence, due_days: due, start: first, set_at: db.now() };
  db.setSetting(SETTING_SCHEDULES, JSON.stringify(all));
  return { code, schedule: all[code] };
}
/** Remove one county's schedule. Returns whether there was one. */
function removeSchedule(rawCode) {
  const code = K().normaliseCode(rawCode);
  const all = schedules();
  if (!code || !all[code]) return false;
  delete all[code];
  db.setSetting(SETTING_SCHEDULES, JSON.stringify(all));
  return true;
}

// ---- reminders ---------------------------------------------------------------------------------------------------------
/** The periods a cadence expects, as the county's own /status lists them (county-connect.js expectedPeriods). */
const expectedFor = (cadence, day, start) => require('./county-connect').expectedPeriods(cadence, day, start);
const CADENCE_LABELS = () => require('./county-connect').CADENCES;

/**
 * Every county the programme reports to on a schedule, with each expected period and what became of its file. For
 * each period: due_by, made (the latest file made for it, or null), sent (accepted over the connection), received (the
 * connected county says so), state ('received' | 'sent' | 'made' | 'made_not_sent' | 'due' | 'overdue') and done.
 * `reminders` is the periods not done, oldest first: what Home and the card say.
 */
function reminders(day = today()) {
  const C = K();
  const CL = require('./county-connect-client');
  const conn = CL.describe();
  const st = conn.connected ? CL.lastStatus() : null;
  const connectedCode = conn.connected ? conn.county_code : null;
  const madeList = made();
  const accepted = conn.connected ? db.all(`SELECT period_from, period_to, status, sent_at FROM county_connect_sends WHERE status IN ('imported','superseded','duplicate','older') ORDER BY sent_at DESC`) : [];
  const all = schedules();
  const codes = [...new Set([...(connectedCode && st && st.cadence ? [connectedCode] : []), ...Object.keys(all)])];
  const counties = codes.map((code) => {
    const own = all[code] || null;
    const fromCounty = code === connectedCode && st && st.cadence && st.county_code === code;
    const cadence = fromCounty ? st.cadence : own.cadence;
    const dueDays = fromCounty ? (st.due_days || (own && own.due_days) || DUE_DAYS_DEFAULT) : own.due_days;
    // The county's own list (its periods and what it received), or the programme's (from its first period on).
    const periods = fromCounty
      ? st.expected.filter(p => !own || !own.start || p.from >= own.start).map(p => ({ from: p.from, to: p.to, label: p.label, due_by: p.due_by || plusDays(p.to, dueDays), received: !!p.received }))
      : expectedFor(cadence, day, own.start).map(p => ({ ...p, due_by: plusDays(p.to, dueDays), received: false }));
    const rows = periods.map((p) => {
      const m = madeList.find(x => x.county_code === code && x.from === p.from && x.to === p.to) || null;
      const sent = code === connectedCode ? accepted.find(s => s.period_from === p.from && s.period_to === p.to) || null : null;
      const late = p.due_by < day;
      const state = p.received ? 'received' : sent ? 'sent' : m ? (code === connectedCode ? 'made_not_sent' : 'made') : late ? 'overdue' : 'due';
      return { ...p, made: m ? { at: m.at, via: m.via, schema_version: m.schema_version } : null, sent: sent ? { at: sent.sent_at, status: sent.status } : null, state, overdue: late,
        done: ['received', 'sent', 'made'].includes(state) };
    });
    const name = (own && own.name) || (code === connectedCode ? conn.county_name : '') || '';
    return { county_code: code, county_code_display: C.formatCode(code), county_name: name, source: fromCounty ? 'county' : 'programme', connected: code === connectedCode,
      cadence, cadence_label: CADENCE_LABELS()[cadence] || cadence, due_days: dueDays, start: own ? own.start : (st && st.start) || null, schedule: own, checked_at: fromCounty ? st.at : null, periods: rows };
  });
  const out = [];
  for (const c of counties) for (const p of c.periods) if (!p.done) out.push({ county_code: c.county_code, county_code_display: c.county_code_display, county_name: c.county_name, from: p.from, to: p.to, label: p.label, due_by: p.due_by, state: p.state, overdue: p.overdue, text: reminderText(c, p) });
  out.sort((a, b) => a.due_by.localeCompare(b.due_by) || a.county_code.localeCompare(b.county_code));
  // The connected county's SUDS, as its /status last said: whether it reads the version this SUDS makes (a county on
  // 1.20 or earlier does not), so the card can warn and offer a version 1 file for it.
  const connection = conn.connected ? { connected: true, county_code: conn.county_code, county_code_display: conn.county_code ? C.formatCode(conn.county_code) : null, county_name: conn.county_name,
    county_older: conn.county_older, county_older_note: conn.county_older_note, county_reads: conn.county_reads } : { connected: false };
  return { today: day, counties, reminders: out, connection, schema_version: C.SCHEMA_VERSION, schema_versions: C.SCHEMA_VERSIONS, cadences: CADENCES.map(v => ({ value: v, label: CADENCE_LABELS()[v] })), due_days_default: DUE_DAYS_DEFAULT, due_days_max: DUE_DAYS_MAX };
}
/** "County file for Jul – Sep 2026 (…) due by Oct 30, 2026 — not yet made", for one period. */
function reminderText(c, p) {
  const C = K();
  const who = c.county_name ? ` to ${c.county_name}` : '';
  const what = p.state === 'made_not_sent' ? `made on ${C.humanDay(p.made.at)}, not yet received by the county` : c.connected ? 'not yet made or sent' : 'not yet made';
  return `County file${who} for ${p.label || C.humanPeriod(p.from, p.to)} ${p.overdue ? 'was due' : 'due'} by ${C.humanDay(p.due_by)} — ${what}`;
}

module.exports = { SETTING_SCHEDULES, SETTING_MADE, CADENCES, DUE_DAYS_DEFAULT, DUE_DAYS_MAX, MADE_MAX, made, recordMade, schedules, saveSchedule, removeSchedule, defaultStart, reminders, reminderText };

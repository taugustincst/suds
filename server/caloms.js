'use strict';
// CalOMS Tx: the programme's settings, the stored records, their edit checks and the state extract.
// The layout itself (code sets, data elements, requiredness) is server/caloms-spec.js.
//
// Records live in caloms_records, one row per admission, discharge or annual update, tied to an episode of
// care. The answers are PHI about a named person (arrests, pregnancy, disability, drug use) and are kept
// encrypted as one JSON document (answers_enc); only the operational codes a list or report needs without
// decrypting stay in the clear: which record, which provider, its date, the service type and the discharge
// status (the same kind of value as episodes.discharge_reason and clients.primary_substance).
const db = require('./db');
const S = require('./caloms-spec');
const { encrypt, decrypt } = require('./crypto');

// ---- settings ----
function enabled() { return db.getSetting('caloms_enabled', '0') === '1'; }
function providers() {
  try { const v = JSON.parse(db.getSetting('caloms_providers', '[]') || '[]'); return Array.isArray(v) ? v.filter(p => p && p.id) : []; }
  catch { return []; }
}
function startDate() { return db.getSetting('caloms_start_date', null) || null; }
const PROVIDER_ID = /^[0-9A-Za-z]{4,10}$/;

/** The configuration and layout the forms need, as plain data (requiredness functions become 'conditional'). */
function config() {
  return {
    enabled: enabled(), providers: providers(), start_date: startDate(),
    spec: {
      version: S.SPEC_VERSION, source: S.SPEC_SOURCE, sets: S.SETS, record_types: S.RECORD_TYPES, multi_max: S.MULTI_MAX,
      administrative_discharge: S.ADMINISTRATIVE_DISCHARGE,
      fields: S.FIELDS.map(f => ({ key: f.key, name: f.name, label: f.label, set: f.set || null, type: f.type || (f.set ? 'code' : 'text'), multi: !!f.multi, min: f.min, max: f.max, in: f.in, group: f.group, help: f.help || null,
        req: typeof f.req === 'function' ? 'conditional' : f.req })),
    },
    from_suds: S.FROM_SUDS,
  };
}

// ---- dates ----
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v) => typeof v === 'string' && DAY.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const addYears = (d, n) => { const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y + n, m - 1, dd)); if (t.getUTCMonth() !== m - 1) t.setUTCDate(0); return t.toISOString().slice(0, 10); };
function ageOn(dob, day) {
  const [by, bm, bd] = dob.split('-').map(Number); const [y, m, d] = day.split('-').map(Number);
  return y - by - ((m < bm || (m === bm && d < bd)) ? 1 : 0);
}
function today() { try { return require('./routes/budget').localDate(); } catch { return new Date().toISOString().slice(0, 10); } }
// Annual updates: due on each anniversary of the admission. Accepted from ANNUAL_EARLY days before to
// ANNUAL_LATE days after it (window to verify against the DHCS guide).
const ANNUAL_EARLY = 60, ANNUAL_LATE = 30;

// ---- answers ----
const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
/** Keep only the elements this record type carries, in a stable shape (codes as strings, lists as arrays). */
function normalize(type, raw = {}) {
  const out = {};
  for (const f of S.fieldsFor(type)) {
    let v = raw[f.key];
    if (empty(v)) continue;
    if (f.multi) v = (Array.isArray(v) ? v : String(v).split(/[,;]/)).map(x => String(x).trim()).filter(Boolean);
    else if (f.type === 'int') v = typeof v === 'number' ? v : (/^-?\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : String(v));
    else v = String(v).trim();
    if (!empty(v)) out[f.key] = v;
  }
  return out;
}

// Cross-record problems are about another record (the admission a discharge follows). They are reported and
// they block the extract, but they never stop a worker saving the record in front of them: a discharge must
// be recordable even when the admission it follows still needs fixing.
const CROSS_RECORD = new Set(['no_admission', 'admission_has_errors']);

/**
 * The edit checks for one record. rec: { record_type, provider_id, record_date, answers }.
 * ctx: { dob, episode: { opened_at, closed_at }, admission: answers|null, admissionDate, admissionFatal,
 *        dischargeDate, providers: [ids], today }.
 * Returns [{ field, severity: 'fatal'|'warning', code, message }].
 */
function check(rec, ctx) {
  const out = [];
  const add = (field, code, message, severity = 'fatal') => out.push({ field, severity, code, message });
  const type = rec.record_type; const a = rec.answers || {};
  const label = (k) => (S.FIELD[k] || {}).label || k;
  if (!S.RECORD_TYPES.includes(type)) { add('record_type', 'invalid_record_type', `"${type}" is not a CalOMS record type`); return out; }

  if (empty(rec.provider_id)) add('provider_id', 'provider_missing', 'Provider ID is required');
  else if (!(ctx.providers || []).includes(rec.provider_id)) add('provider_id', 'provider_unknown', `Provider ID ${rec.provider_id} is not one of this program's CalOMS provider IDs (Settings)`);
  const date = rec.record_date;
  const dateLabel = type === 'admission' ? 'Admission date' : type === 'discharge' ? 'Discharge date' : 'Annual update date';
  const dateOk = validDay(date);
  if (!dateOk) add('record_date', 'date_invalid', `${dateLabel} is required as a real date (YYYY-MM-DD)`);
  else if (date > (ctx.today || today())) add('record_date', 'date_future', `${dateLabel} is in the future`);

  const standard = type !== 'discharge' || !S.ADMINISTRATIVE_DISCHARGE.includes(a.discharge_status);
  const rctx = { record_type: type, admission: ctx.admission, standard };
  for (const f of S.fieldsFor(type)) {
    const v = a[f.key];
    const required = f.req === 'always' || (f.req === 'standard' && standard) || (typeof f.req === 'function' && f.req(a, rctx));
    if (empty(v)) { if (required) add(f.key, 'required', `${f.label} is required`); continue; }
    if (f.set) {
      const codes = S.SETS[f.set].map(c => c.code);
      const vals = f.multi ? (Array.isArray(v) ? v : [v]) : [v];
      if (!f.multi && Array.isArray(v)) { add(f.key, 'invalid_code', `${f.label} takes one answer`); continue; }
      const bad = vals.filter(x => !codes.includes(String(x)));
      if (bad.length) add(f.key, 'invalid_code', `${f.label}: ${bad.join(', ')} is not a valid code`);
      if (f.multi && vals.length > S.MULTI_MAX) add(f.key, 'too_many_codes', `${f.label} takes at most ${S.MULTI_MAX} answers`);
      if (f.multi && new Set(vals).size !== vals.length) add(f.key, 'duplicate_code', `${f.label} lists the same answer twice`);
    } else if (f.type === 'int') {
      if (typeof v !== 'number' || !Number.isInteger(v)) add(f.key, 'not_a_number', `${f.label} must be a whole number`);
      else if (v < f.min || v > f.max) add(f.key, 'out_of_range', `${f.label} must be between ${f.min} and ${f.max}`);
    } else if (f.type === 'date') {
      if (!validDay(v)) add(f.key, 'date_invalid', `${f.label} must be a real date (YYYY-MM-DD)`);
    } else if (f.type === 'zip') {
      if (!/^\d{5}$/.test(v)) add(f.key, 'zip_invalid', `${f.label} must be 5 digits`);
    }
  }
  const has = (k) => !empty(a[k]);
  const num = (k) => (typeof a[k] === 'number' ? a[k] : null);

  if (type === 'admission') {
    if (!ctx.dob || !validDay(ctx.dob)) add('dob', 'dob_missing', 'The client\'s date of birth is required for a CalOMS admission (add it on the client record)');
    else if (dateOk) {
      if (ctx.dob > date) add('dob', 'admission_before_birth', 'Admission date is before the client\'s date of birth');
      else {
        const age = ageOn(ctx.dob, date);
        if (age > 110) add('dob', 'age_out_of_range', `Age at admission (${age}) is over 110; check the date of birth`);
        else if (age < 12) add('dob', 'age_under_12', `Age at admission is ${age}; confirm the date of birth`, 'warning');
        for (const k of ['primary_age_first_use', 'secondary_age_first_use']) if (num(k) !== null && num(k) > age) add(k, 'first_use_after_admission', `${label(k)} (${num(k)}) is older than the client's age at admission (${age})`);
      }
    }
    if (a.pregnant === 'Y' && a.sex_at_birth && a.sex_at_birth !== 'F') add('pregnant', 'pregnant_not_female', 'Pregnant can only be Yes when sex at birth is Female');
    if (a.primary_drug === '00') add('primary_drug', 'primary_drug_none', 'Primary drug cannot be None');
    if (has('secondary_drug') && a.secondary_drug !== '00' && a.secondary_drug === a.primary_drug) add('secondary_drug', 'secondary_same_as_primary', 'Secondary drug must differ from the primary drug');
    if (a.iv_use_30 === 'Y' && a.iv_use_12m === 'N') add('iv_use_12m', 'needle_use_inconsistent', 'Needle use in the past 30 days means needle use in the past 12 months too');
    if (num('children_cps') !== null && num('children_under_18') !== null && num('children_cps') > num('children_under_18')) add('children_cps', 'children_cps_exceeds', 'Children living with others by protective order cannot exceed the number of children under 18');
    for (const [k, exclusive] of [['disability', ['1', '9']], ['race', ['19']]]) {
      const vals = Array.isArray(a[k]) ? a[k] : [];
      if (vals.length > 1 && vals.some(x => exclusive.includes(x))) add(k, 'exclusive_code_combined', `${label(k)}: "${S.SETS[S.FIELD[k].set].find(c => c.code === vals.find(x => exclusive.includes(x))).label}" cannot be combined with other answers`);
    }
    if (dateOk && ctx.episode && ctx.episode.opened_at && ctx.episode.opened_at.slice(0, 10) !== date) add('record_date', 'admission_date_differs', `Admission date differs from the episode's start (${ctx.episode.opened_at.slice(0, 10)})`, 'warning');
  }
  // Repeated measures: the same checks wherever they appear.
  const secondaryDrug = type === 'admission' ? a.secondary_drug : (ctx.admission || {}).secondary_drug;
  if ((secondaryDrug === '00') && num('secondary_days_used') > 0) add('secondary_days_used', 'secondary_days_without_drug', 'Days secondary drug used must be 0 or blank when there is no secondary drug');
  if (num('jail_days_30') !== null && num('prison_days_30') !== null && num('jail_days_30') + num('prison_days_30') > 30) add('prison_days_30', 'jail_prison_over_30', 'Days in jail and in prison together cannot exceed 30');
  if (num('hospital_nights_30') !== null && num('psych_inpatient_days_30') !== null && num('hospital_nights_30') + num('psych_inpatient_days_30') > 30) add('psych_inpatient_days_30', 'inpatient_over_30', 'Hospital nights and psychiatric inpatient days together exceed 30; check both', 'warning');

  if (type === 'discharge' || type === 'annual_update') {
    if (!ctx.admission) add('record_type', 'no_admission', `There is no CalOMS admission record for this episode, so this ${type === 'discharge' ? 'discharge' : 'annual update'} cannot be submitted`);
    else if (ctx.admissionFatal) add('record_type', 'admission_has_errors', 'The admission this record follows has fatal errors; fix the admission first');
  }
  const admitted = ctx.admissionDate || (ctx.episode && ctx.episode.opened_at ? ctx.episode.opened_at.slice(0, 10) : null);
  if (type === 'discharge' && dateOk && admitted) {
    if (date < admitted) add('record_date', 'discharge_before_admission', `Discharge date is before the admission date (${admitted})`);
    if (validDay(a.last_service_date) && (a.last_service_date > date || a.last_service_date < admitted)) add('last_service_date', 'last_service_outside_episode', `Date of last service must fall between admission (${admitted}) and discharge (${date})`);
  }
  if (type === 'annual_update' && dateOk && admitted) {
    if (date < addDays(addYears(admitted, 1), -ANNUAL_EARLY)) add('record_date', 'annual_update_too_early', `An annual update is due from ${addDays(addYears(admitted, 1), -ANNUAL_EARLY)} (the first anniversary of admission ${admitted}, less ${ANNUAL_EARLY} days)`);
    if (ctx.dischargeDate && date > ctx.dischargeDate) add('record_date', 'annual_update_after_discharge', `Annual update date is after the discharge (${ctx.dischargeDate})`);
  }
  return out;
}
const fatal = (issues) => issues.filter(i => i.severity === 'fatal');
/** The fatal problems that stop a worker saving (everything but the cross-record ones). */
const blocking = (issues) => fatal(issues).filter(i => !CROSS_RECORD.has(i.code));

// ---- stored records ----
function present(row) {
  if (!row) return null;
  const o = { ...row };
  let answers = {};
  try { answers = row.answers_enc ? JSON.parse(decrypt(row.answers_enc)) : {}; } catch { answers = {}; }
  o.answers = answers; delete o.answers_enc;
  return o;
}
function recordsForEpisode(episodeId) { return db.all(`SELECT * FROM caloms_records WHERE episode_id=? ORDER BY record_date, created_at`, episodeId).map(present); }

/** Everything check() needs to know about the episode a record belongs to. */
function contextFor(episode, { records = null, dob = undefined } = {}) {
  const recs = records || recordsForEpisode(episode.id);
  const adm = recs.find(r => r.record_type === 'admission') || null;
  const dis = recs.find(r => r.record_type === 'discharge') || null;
  if (dob === undefined) { const c = db.one(`SELECT dob_enc FROM clients WHERE id=?`, episode.client_id); try { dob = c && c.dob_enc ? decrypt(c.dob_enc) : null; } catch { dob = null; } }
  const base = { dob, episode, providers: providers().map(p => p.id), today: today() };
  let admissionFatal = false;
  if (adm) admissionFatal = fatal(check(adm, { ...base, admission: null })).length > 0;
  return { ...base, admission: adm ? adm.answers : null, admissionDate: adm ? adm.record_date : null, admissionFatal, dischargeDate: dis ? dis.record_date : (episode.closed_at || null), records: recs };
}

/**
 * Validate and write one record (insert, or update the episode's existing admission/discharge, or the
 * annual update with the same date). Throws a 400 listing each blocking problem by field. Caller audits.
 */
function save({ episode, record_type, provider_id, record_date, answers, user, id = null }) {
  const { badRequest } = require('./http');
  const ctx = contextFor(episode);
  const provs = ctx.providers;
  // A discharge or annual update is reported under the provider that admitted the client, unless told otherwise.
  const admittedUnder = (ctx.records.find(r => r.record_type === 'admission') || {}).provider_id;
  const rec = { record_type, provider_id: provider_id || (record_type !== 'admission' && admittedUnder) || (provs.length === 1 ? provs[0] : null), record_date, answers: normalize(record_type, answers) };
  const issues = check(rec, ctx);
  const stop = blocking(issues);
  if (stop.length) throw badRequest(`The CalOMS ${record_type.replace('_', ' ')} record has ${stop.length} problem${stop.length === 1 ? '' : 's'}: ${stop.map(i => i.message).join('; ')}`, { fields: Object.fromEntries(stop.map(i => [`caloms_${i.field}`, i.message])), caloms_issues: stop });
  let existing = id ? db.one(`SELECT * FROM caloms_records WHERE id=? AND episode_id=?`, id, episode.id) : null;
  if (!existing && record_type !== 'annual_update') existing = db.one(`SELECT * FROM caloms_records WHERE episode_id=? AND record_type=?`, episode.id, record_type);
  if (!existing && record_type === 'annual_update') existing = db.one(`SELECT * FROM caloms_records WHERE episode_id=? AND record_type='annual_update' AND record_date=?`, episode.id, record_date);
  const enc = encrypt(JSON.stringify(rec.answers));
  const service = record_type === 'admission' ? rec.answers.service_type || null : null;
  const dstatus = record_type === 'discharge' ? rec.answers.discharge_status || null : null;
  let recId;
  if (existing) {
    recId = existing.id;
    db.run(`UPDATE caloms_records SET record_type=?, provider_id=?, record_date=?, service_type=?, discharge_status=?, answers_enc=?, updated_by=?, updated_at=? WHERE id=?`,
      record_type, rec.provider_id, record_date, service, dstatus, enc, user.id, db.now(), recId);
  } else {
    recId = require('./crypto').uuid();
    db.run(`INSERT INTO caloms_records(id,client_id,episode_id,record_type,provider_id,record_date,service_type,discharge_status,answers_enc,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      recId, episode.client_id, episode.id, record_type, rec.provider_id, record_date, service, dstatus, enc, user.id, user.id);
  }
  return { id: recId, updated: !!existing, warnings: issues.filter(i => i.severity === 'warning' || CROSS_RECORD.has(i.code)) };
}

// ---- the validation report ----
/**
 * Every problem in a period: each record dated in it, checked; and each episode active in it (and opened
 * on or after the CalOMS start date) checked for the records it should have — an admission, a discharge
 * once closed, an annual update on each anniversary. `scope(col)` returns the caseload filter for a client
 * id column (auth.caseloadFilter); without one, every client is in scope.
 */
function report({ from, to, scope = () => ({ sql: '1=1', params: [] }) }) {
  const now = today();
  const start = startDate();
  const recs = db.all(`SELECT r.*, c.client_code, e.opened_at, e.closed_at, e.status AS episode_status FROM caloms_records r JOIN clients c ON c.id=r.client_id JOIN episodes e ON e.id=r.episode_id
    WHERE r.record_date BETWEEN ? AND ? AND c.deleted_at IS NULL AND ${scope('r.client_id').sql} ORDER BY r.record_date, c.client_code`, from, to, ...scope('r.client_id').params).map(present);
  const epWhere = `e.opened_at <= ? AND (e.closed_at IS NULL OR e.closed_at >= ?) AND c.deleted_at IS NULL AND c.merged_into IS NULL AND ${scope('e.client_id').sql}${start ? ' AND e.opened_at >= ?' : ''}`;
  const eps = db.all(`SELECT e.*, c.client_code, c.dob_enc FROM episodes e JOIN clients c ON c.id=e.client_id WHERE ${epWhere} ORDER BY c.client_code`, to, from, ...scope('e.client_id').params, ...(start ? [start] : []));
  const ctxCache = new Map();
  const ctxOf = (episodeId) => {
    if (ctxCache.has(episodeId)) return ctxCache.get(episodeId);
    const e = db.one(`SELECT e.*, c.dob_enc FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.id=?`, episodeId);
    let dob = null; try { dob = e.dob_enc ? decrypt(e.dob_enc) : null; } catch {}
    const c = contextFor(e, { dob }); ctxCache.set(episodeId, c); return c;
  };
  const rows = [];
  const labelOf = (field) => (S.FIELD[field] || {}).label || ({ provider_id: 'Provider ID', record_date: 'Record date', dob: 'Date of birth', record_type: 'Record' }[field] || field);
  const checked = [];
  for (const r of recs) {
    const issues = check(r, ctxOf(r.episode_id));
    checked.push({ record: r, issues });
    for (const i of issues) rows.push({ client_code: r.client_code, client_id: r.client_id, episode_id: r.episode_id, record_id: r.id, record_type: r.record_type, record_date: r.record_date, provider_id: r.provider_id, field: i.field, field_label: labelOf(i.field), severity: i.severity, code: i.code, message: i.message });
  }
  // Missing records.
  for (const e of eps) {
    const c = ctxOf(e.id); const has = (t) => c.records.some(r => r.record_type === t);
    const base = { client_code: e.client_code, client_id: e.client_id, episode_id: e.id, record_id: null, provider_id: null, field: 'record_type', field_label: 'Record' };
    if (!has('admission')) rows.push({ ...base, record_type: 'admission', record_date: e.opened_at.slice(0, 10), severity: 'fatal', code: 'missing_admission', message: `No CalOMS admission record for the episode opened ${e.opened_at.slice(0, 10)}` });
    if (e.status === 'closed' && !has('discharge')) rows.push({ ...base, record_type: 'discharge', record_date: e.closed_at, severity: 'fatal', code: 'missing_discharge', message: `The episode was closed on ${e.closed_at} but has no CalOMS discharge record` });
    const opened = e.opened_at.slice(0, 10); const endBy = e.closed_at && e.closed_at < now ? e.closed_at : now;
    for (let n = 1; n < 100; n++) {
      const anniv = addYears(opened, n);
      if (anniv > endBy || anniv > to) break;
      if (anniv < from && addDays(anniv, ANNUAL_LATE) < from) continue;
      const done = c.records.some(r => r.record_type === 'annual_update' && r.record_date >= addDays(anniv, -ANNUAL_EARLY) && r.record_date <= addDays(anniv, ANNUAL_LATE));
      if (done) continue;
      const overdue = now > addDays(anniv, ANNUAL_LATE);
      rows.push({ ...base, record_type: 'annual_update', record_date: anniv, severity: overdue ? 'fatal' : 'warning', code: overdue ? 'annual_update_overdue' : 'annual_update_due',
        message: overdue ? `Annual update for the ${ordinal(n)} anniversary (${anniv}) is overdue` : `Annual update for the ${ordinal(n)} anniversary (${anniv}) is due by ${addDays(anniv, ANNUAL_LATE)}` });
    }
  }
  rows.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'fatal' ? -1 : 1) || String(x.client_code).localeCompare(String(y.client_code)) || String(x.record_date).localeCompare(String(y.record_date)));
  const ready = checked.filter(x => !fatal(x.issues).length);
  const summary = {
    records: recs.length, ready: ready.length, blocked: recs.length - ready.length,
    fatal: rows.filter(r => r.severity === 'fatal').length, warnings: rows.filter(r => r.severity === 'warning').length,
    by_type: Object.fromEntries(S.RECORD_TYPES.map(t => [t, { records: recs.filter(r => r.record_type === t).length, ready: ready.filter(x => x.record.record_type === t).length }])),
    missing: rows.filter(r => r.code.startsWith('missing_') || r.code === 'annual_update_overdue').length,
    not_yet_extracted: ready.filter(x => !x.record.extracted_at).length,
  };
  return { from, to, spec_version: S.SPEC_VERSION, enabled: enabled(), providers: providers(), start_date: start, summary, rows, checked };
}
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;

// ---- the extract ----
/** Months (YYYY-MM) from `from` to `to` inclusive. */
function monthsBetween(from, to) {
  const out = []; let [y, m] = from.slice(0, 7).split('-').map(Number); const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 240) break; }
  return out;
}
const MULTI_COLS = (f) => Array.from({ length: S.MULTI_MAX }, (_, i) => ({ key: `${f.key}_${i + 1}`, name: `${f.name}${i + 1}` }));
function columnsFor(type) {
  const cols = [...S.ID_COLUMNS, { key: 'record_date', name: type === 'admission' ? 'AdmissionTransactionDate' : type === 'discharge' ? 'DischargeDate' : 'AnnualUpdateDate' }];
  for (const f of S.fieldsFor(type)) { if (f.multi) cols.push(...MULTI_COLS(f)); else cols.push({ key: f.key, name: f.name }); }
  return cols;
}

/**
 * Build the submission: one CSV per record type (the records in the period with no fatal error), the
 * provider activity report (per provider per month, "no activity" when nothing was reported), and a
 * README. Returns the files, which clients they cover (for the accounting of disclosures) and counts.
 */
function buildExtract({ from, to, scope, generatedBy }) {
  const rep = report({ from, to, scope });
  const ready = rep.checked.filter(x => !fatal(x.issues).length).map(x => x.record);
  const names = new Map();
  const nameOf = (clientId) => {
    if (names.has(clientId)) return names.get(clientId);
    const c = db.one(`SELECT client_code, first_name_enc, last_name_enc, dob_enc FROM clients WHERE id=?`, clientId);
    const d = (v) => { try { return v ? decrypt(v) : ''; } catch { return ''; } };
    const o = { client_id: c.client_code, first_name: d(c.first_name_enc), last_name: d(c.last_name_enc), dob: d(c.dob_enc) };
    names.set(clientId, o); return o;
  };
  const admissionDate = (episodeId) => (db.one(`SELECT record_date FROM caloms_records WHERE episode_id=? AND record_type='admission'`, episodeId) || {}).record_date || '';
  const T = require('./spreadsheet');
  const files = []; const counts = {};
  const FILE = { admission: 'admissions.csv', discharge: 'discharges.csv', annual_update: 'annual_updates.csv' };
  for (const type of S.RECORD_TYPES) {
    const cols = columnsFor(type);
    const rows = ready.filter(r => r.record_type === type).map(r => {
      const o = { record_type: S.RECORD_CODE[type], provider_id: r.provider_id, ...nameOf(r.client_id), admission_date: type === 'admission' ? r.record_date : admissionDate(r.episode_id), record_date: r.record_date };
      for (const f of S.fieldsFor(type)) {
        const v = r.answers[f.key];
        if (f.multi) (Array.isArray(v) ? v : []).forEach((x, i) => { o[`${f.key}_${i + 1}`] = x; });
        else o[f.key] = v === undefined ? '' : v;
      }
      return o;
    });
    counts[type] = rows.length;
    files.push([FILE[type], T.toCsv(rows, cols.map(c => ({ key: c.key, label: c.name })))]);
  }
  // Provider activity: every configured provider, every month of the period.
  const activity = [];
  for (const p of providers()) for (const month of monthsBetween(from, to)) {
    const inMonth = ready.filter(r => r.provider_id === p.id && r.record_date.slice(0, 7) === month);
    const n = (t) => inMonth.filter(r => r.record_type === t).length;
    activity.push({ provider_id: p.id, report_month: month.replace('-', ''), admissions: n('admission'), discharges: n('discharge'), annual_updates: n('annual_update'), no_activity: inMonth.length ? 'N' : 'Y' });
  }
  files.push(['provider_activity.csv', T.toCsv(activity, [{ key: 'provider_id', label: 'ProviderID' }, { key: 'report_month', label: 'ReportMonth' }, { key: 'admissions', label: 'Admissions' }, { key: 'discharges', label: 'Discharges' }, { key: 'annual_updates', label: 'AnnualUpdates' }, { key: 'no_activity', label: 'NoActivity' }])]);
  const excluded = rep.summary.blocked;
  files.push(['README.txt', readme({ from, to, counts, excluded, activity, generatedBy, missing: rep.summary.missing })]);
  return { files, ready, clientIds: [...new Set(ready.map(r => r.client_id))], counts, excluded, activity_rows: activity.length, no_activity_months: activity.filter(a => a.no_activity === 'Y').length };
}

function readme({ from, to, counts, excluded, activity, generatedBy, missing }) {
  return [
    'CalOMS Tx submission prepared by SUDS',
    '====================================',
    '',
    'CONTAINS PHI. Identified client records for the California Department of Health Care Services (DHCS),',
    'disclosed as required by law for state treatment outcome reporting. The disclosure is recorded in each',
    'client\'s accounting of disclosures in SUDS. Transmit only through the county\'s approved DHCS channel.',
    '',
    `Period: ${from} to ${to}`,
    `Generated: ${db.now()}${generatedBy ? ` by ${generatedBy}` : ''}`,
    `Layout: ${S.SPEC_VERSION}`,
    `Source: ${S.SPEC_SOURCE}`,
    '',
    'Files',
    `  admissions.csv          ${counts.admission} admission record(s)`,
    `  discharges.csv          ${counts.discharge} discharge record(s)`,
    `  annual_updates.csv      ${counts.annual_update} annual update record(s)`,
    `  provider_activity.csv   ${activity.length} provider-month row(s); NoActivity=Y marks a month with nothing to report`,
    '',
    `Records held back because of fatal errors: ${excluded}. Missing or overdue records: ${missing}.`,
    'Fix them in SUDS (Reports -> State reporting -> Validation) and produce the extract again.',
    '',
    'IMPORTANT: the code values and column names in these files follow SUDS\'s CalOMS Tx layout, which has',
    'NOT been verified against the current DHCS CalOMS Tx data dictionary / file specification. Before the',
    'first submission the county must check every code table (server/caloms-spec.js, docs/compliance/CALOMS.md)',
    'against the dictionary DHCS has issued, and convert these CSV files to the DHCS upload format if it is',
    'not CSV. Dates are YYYY-MM-DD; multi-answer elements (race, disability) are split into numbered columns.',
    '',
    'How to submit (county process)',
    '  1. Resolve every fatal error in the SUDS validation report for the period.',
    '  2. Produce this extract (it holds back anything still in error).',
    '  3. Load the files through the county\'s CalOMS Tx submission tool or DHCS upload, per the county\'s',
    '     CalOMS Tx procedure, by the monthly deadline. Submit a provider activity (no activity) report for',
    '     any month with no admissions, discharges or annual updates.',
    '  4. Resolve any errors DHCS returns in SUDS and resubmit.',
    '',
  ].join('\r\n');
}

module.exports = { enabled, providers, startDate, config, PROVIDER_ID, normalize, check, fatal, blocking, CROSS_RECORD, present, recordsForEpisode, contextFor, save, report, buildExtract, monthsBetween, columnsFor, ANNUAL_EARLY, ANNUAL_LATE, addYears, addDays };

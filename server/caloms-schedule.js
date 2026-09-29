'use strict';
// CalOMS Tx automation (1.17.0; docs/compliance/CALOMS.md, "Monthly automation").
//
// SUDS does not submit anything to DHCS: it has no DHCS connection or credentials. What it automates is the
// month-end work around the upload a person makes:
//   * the scheduled run: on the configured day of each month (caloms_schedule 'monthly', caloms_schedule_day),
//     the previous calendar month is validated in full against every implemented edit rule, programme-wide, and
//     a file is PREPARED for it, checked against SUDS's own edits (not DHCS's): one file, or one per provider (caloms_split_by_provider, a
//     county server reporting for several provider organisations). A prepared file is built once and kept
//     encrypted, but it is not a disclosure: nothing has left, nobody's accounting changes and no record is
//     stamped as sent. Records with a fatal error are held back and appear on the worklist (below);
//   * producing it (POST /api/caloms/submissions/:id/produce, export:identified) is the disclosure, as a
//     submission produced by hand always was: those exact bytes are accounted per client under the
//     state-reporting basis and its records' extracted_at is stamped. It is refused if any record in it was
//     changed, deleted or sent in another file since it was prepared — then a new one is prepared;
//   * the submission log (caloms_submission_events): prepared, produced, each download, the upload a person
//     records (with the DHCS portal's reference), a discarded file.
const db = require('./db');
const audit = require('./audit');
const C = require('./caloms');
const { uuid, encrypt } = require('./crypto');

const ALL = () => ({ sql: '1=1', params: [] });
const zipOf = (files) => require('./spreadsheet').zip(files);
const sha256 = (buf) => require('node:crypto').createHash('sha256').update(buf).digest('hex');

function logEvent(submissionId, action, user, detail = null) {
  db.run(`INSERT INTO caloms_submission_events(id,submission_id,action,user_id,detail) VALUES(?,?,?,?,?)`, uuid(), submissionId, action, user ? user.id : null, detail ? String(detail).slice(0, 200) : null);
}

/** The calendar month before `day` (YYYY-MM-DD): { from, to }. */
function previousMonth(day) {
  const [y, m] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1)); const last = new Date(Date.UTC(y, m - 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/**
 * Build and keep a file without disclosing it. `user` is null for the scheduled run. Returns the new
 * submission's summary, or { empty: true } when no record in the period (for that provider) passes the checks.
 */
function prepare({ from, to, providerId = null, origin = 'scheduled', user = null, ip = null }) {
  const id = uuid();
  const x = C.buildExtract({ from, to, scope: ALL, generatedBy: user ? (user.display_name || user.username) : 'SUDS scheduled run', submissionId: id, providerId });
  if (!x.ready.length) return { empty: true, provider_id: providerId, held_back: x.excluded };
  const body = zipOf(x.files); const hash = sha256(body);
  const fileName = `caloms-tx-SUBMISSION-${from}_${to}${providerId ? `-${providerId}` : ''}-${id.slice(0, 8)}.zip`;
  const stamp = db.now();
  // created_by is NOT NULL: a scheduled run's row names the first active administrator as its keeper; the
  // log says it was the schedule (user_id NULL, origin 'scheduled').
  const keeper = user || db.one(`SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY created_at LIMIT 1`) || db.one(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
  db.transaction(() => {
    db.run(`INSERT INTO caloms_submissions(id,period_from,period_to,file_name,sha256,bytes,clients,counts,file_enc,created_by,created_at,updated_at,status,origin,provider_id,record_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`,
      id, from, to, fileName, hash, body.length, x.clientIds.length, JSON.stringify({ ...x.counts, held_back: x.excluded }), encrypt(body.toString('base64')), keeper.id, stamp, stamp, origin, providerId, JSON.stringify(x.ready.map(r => r.id)));
    logEvent(id, 'prepared', user, hash);
  });
  audit.log({ user, action: 'caloms.submission.prepare', entity: 'caloms_submission', entityId: id, ip, details: { from, to, provider_id: providerId || undefined, origin, ...x.counts, held_back: x.excluded, clients: x.clientIds.length, sha256: hash } });
  return { id, from, to, provider_id: providerId, clients: x.clientIds.length, counts: x.counts, held_back: x.excluded, sha256: hash, file_name: fileName };
}

/** A file the scheduled run already prepared for this period and provider, not yet produced or discarded. */
function alreadyPrepared(from, to, providerId) {
  return db.one(`SELECT id FROM caloms_submissions WHERE period_from=? AND period_to=? AND origin='scheduled' AND status='prepared' AND file_enc IS NOT NULL AND provider_id IS ? ORDER BY created_at LIMIT 1`, from, to, providerId);
}

/**
 * The whole run for one period: full validation, then one prepared file (or one per provider). The scheduled run
 * is idempotent per (period, provider) (engineering review of the 1.17.0 candidate, L2): a provider whose file the
 * schedule already prepared, and that is still waiting to be produced, is not prepared again, and a provider whose
 * file could not be prepared (an error) leaves the run incomplete, so the next hourly pass tries that provider
 * again - and only that one - instead of the month counting as done or every file being prepared twice.
 */
function run({ from, to, user = null, ip = null, origin = 'scheduled' }) {
  const S = C.schedule();
  const rep = C.report({ from, to, scope: ALL });
  const targets = S.split_by_provider ? C.providers().map(p => p.id) : [null];
  const prepared = []; const empty = []; const kept = []; const failed = [];
  for (const p of targets) {
    const had = origin === 'scheduled' ? alreadyPrepared(from, to, p) : null;
    if (had) { kept.push(had.id); continue; }
    try { const r = prepare({ from, to, providerId: p, origin, user, ip }); if (r.empty) empty.push(p || 'all'); else prepared.push(r.id); }
    catch (e) { failed.push(p || 'all'); console.error(`[suds] CalOMS scheduled run: the file for ${p || 'the programme'} (${from}..${to}) could not be prepared: ${e.message}`); }
  }
  const summary = { period: `${from}..${to}`, from, to, ran_at: db.now(), prepared: [...kept, ...prepared], empty, failed, records: rep.summary.records, ready: rep.summary.ready, fatal: rep.summary.fatal, warnings: rep.summary.warnings, missing: rep.summary.missing };
  db.setSetting('caloms_schedule_last', JSON.stringify(summary));
  audit.log({ user, action: 'caloms.schedule.run', ip, details: { from, to, origin, prepared: prepared.length, already_prepared: kept.length || undefined, failed: failed.length || undefined, fatal: rep.summary.fatal, warnings: rep.summary.warnings } });
  return summary;
}

/** Hourly from housekeeping (server/index.js): once a month, on or after the configured day, for the month before. */
function runIfDue(today = null) {
  if (!C.enabled() || !C.providers().length) return null;
  const S = C.schedule();
  if (S.frequency !== 'monthly') return null;
  const day = today || require('./routes/budget').localDate();
  if (Number(day.slice(8, 10)) < Math.min(28, Math.max(1, S.day))) return null;
  const { from, to } = previousMonth(day);
  // Done for the month once a run for it prepared every provider's file (or found none to prepare).
  if (S.last && S.last.from === from && S.last.to === to && !(S.last.failed && S.last.failed.length)) return null;
  return run({ from, to });
}

module.exports = { prepare, run, runIfDue, previousMonth, logEvent, alreadyPrepared };

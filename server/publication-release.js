'use strict';
// One publication release per standard period that has ended, for the whole programme (docs/HIPAA.md "Small
// cells in aggregate reports"; docs/compliance/HARM-REDUCTION-REPORTING.md;
// docs/architecture/ADR-0009-publication-release.md).
//
// The funder report, the NDP log (by month) and the opioid settlement report for such a period are three
// views of one release. Their figures are read together from one snapshot of the data (db.readSnapshot: a read
// transaction on a second connection, so the read lets the event loop go between its phases while writers
// carry on, and sees none of their commits; where there is no second connection it runs straight through), and
// audited as one constraint system (server/release-audit.js, server/sdc.js); each report then prints its part
// of the same result, and every response carries the release's id, a digest of every number it prints.
// Whichever report is asked for, and however often, the same data give the same release: the audit is
// deterministic, and its budget is counted in solver work, not time. The release is kept under the data's
// version (dataVersion), so asking again reads nothing.
//
// The audit runs in a worker thread (server/release-audit-worker.js), so a year's release does not stop the
// server answering anyone else while it is checked; in the browser kernel (local mode), which has no worker
// threads, it runs in a Web Worker (setDeviceAuditRunner, below; 1.17.0), and inline where the page cannot start
// one or when SUDS_AUDIT_INLINE=1 (the tests' API calls use the worker thread, as the server does). A wall-clock
// backstop (release-audit.js AUDIT_BACKSTOP_MS) protects the server from a runaway audit: a release it stops is
// refused and logged.
//
// A table the audit cannot show protected is withheld (listed, with why, in release.withheld_reasons) and the
// rest is published; the whole release is refused (422) only when even the headline (people served) cannot
// be shown safely, or the audit reaches its budget.
const db = require('./db');
const FR = require('./funder-report');
const SC = require('./small-cells');
const RA = require('./release-audit');
const { HttpError } = require('./http');

// Options every audit runs with (tests set a budget of 0 to check that an unverifiable release is refused).
let auditOptions = {};
function setAuditOptions(o = {}) { auditOptions = { ...o }; clearCache(); }

// ---- where the audit runs ----
let WorkerCtor = null;
try { WorkerCtor = require('node:worker_threads').Worker; } catch { WorkerCtor = null; }
const inline = () => typeof WorkerCtor !== 'function' || process.env.SUDS_AUDIT_INLINE === '1' || !!require('./config').local;
// One worker at a time, handling audits in the order they were sent. Each pending audit remembers the worker
// it was posted to, so when a worker has to go only that worker's audits are affected: an audit that stops
// answering is refused on its own, and the audits queued behind it on the same worker are sent to a new one
// rather than failed with it (1.13.0 failed every pending audit when one timed out).
let worker = null; let seq = 0; const pending = new Map();
let workerScript = require('node:path').join(__dirname, 'release-audit-worker.js');
let backstopMs = RA.AUDIT_BACKSTOP_MS + 15000;
/** Tests only: a stand-in worker script and a shorter backstop (test/release-worker-timeout.test.js). */
function _setWorkerForTests({ script, backstop } = {}) {
  if (worker) { const w = worker; worker = null; w.terminate().catch(() => {}); }
  workerScript = script || require('node:path').join(__dirname, 'release-audit-worker.js');
  backstopMs = backstop || RA.AUDIT_BACKSTOP_MS + 15000;
}
/** Fail the audits still waiting on worker `w` (it failed or exited on its own). */
function failWorker(w, err) { for (const [id, p] of pending) if (p.w === w) { clearTimeout(p.timer); pending.delete(id); p.reject(err); } }
function auditWorker() {
  if (worker) return worker;
  const w = new WorkerCtor(workerScript);
  w.on('message', ({ id, result, error }) => {
    const p = pending.get(id); if (!p || p.w !== w) return;
    pending.delete(id); clearTimeout(p.timer);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  });
  w.on('error', (e) => { if (worker === w) worker = null; failWorker(w, e); });
  w.on('exit', () => { if (worker === w) worker = null; failWorker(w, new Error('the publication audit worker stopped')); });
  // Unreferenced after its listeners are attached (attaching one references it again): an idle audit worker
  // never keeps the process alive.
  w.unref();
  worker = w;
  return w;
}
// How many audits ran where (the tests check that theirs ran in the worker, as the server's do).
const auditStats = { worker: 0, inline: 0, device: 0 };
/** Send pending audit `id` to the current worker, with its own backstop. */
function dispatch(id) {
  const p = pending.get(id); if (!p) return;
  clearTimeout(p.timer);
  p.w = auditWorker();
  p.timer = setTimeout(() => timedOut(id), backstopMs);
  if (p.timer.unref) p.timer.unref();
  p.w.postMessage(p.msg);
}
// Beyond the audit's own backstop: an audit whose worker does not answer is refused, the worker is stopped,
// and whatever else was queued on it starts again on a new one (each with a fresh backstop: it had not begun).
function timedOut(id) {
  const p = pending.get(id); if (!p) return;
  pending.delete(id);
  const w = p.w;
  if (worker === w) worker = null;
  const queued = [...pending].filter(([, q]) => q.w === w).map(([qid]) => qid);
  for (const qid of queued) dispatch(qid);
  w.terminate().catch(() => {});
  console.warn(`[suds] a publication release audit did not answer within ${Math.round(backstopMs / 1000)} s; its worker was stopped and the release refused${queued.length ? ` (${queued.length} other audit(s) moved to a new worker)` : ''}`);
  p.resolve(backstopRefusal(p.msg.inputs));
}
/** A release refused because its audit did not answer within the backstop (server worker or device worker). */
function backstopRefusal(inputs) {
  return { refused: { out_of_budget: true, backstop: true, message: RA.refusalMessage({ backstop: true }, ((inputs.domains && inputs.domains.months) || []).length) } };
}
// ---- on a device ----
// The browser kernel has no worker threads, and its requests are answered on the page's own thread. Where the
// page can start a Web Worker, local/kernel.js hands this module a runner that audits in one (local/audit-runner.js,
// public/local/audit-worker.js), so a year's release does not hold the page (1.17.0; before, the audit ran on the
// page's thread for up to the backstop). Where it cannot (no Web Workers, or the worker's script does not load),
// the audit runs on the page as before. The same code and the same budget either way: the release a device
// makes is the one the office makes of the same figures (test/kernel-parity.test.js).
let deviceRunner = null;
/** local/kernel.js: the Web Worker runner for this device's audits (null: audit on the page). */
function setDeviceAuditRunner(fn) { deviceRunner = typeof fn === 'function' ? fn : null; clearCache(); }
function inlineAudit(inputs, T, opts, kind) {
  auditStats.inline++;
  return new Promise((resolve) => require('./spreadsheet').defer(resolve)).then(() => (kind === 'county' ? require('./county-publication-audit').protectCounty : RA.protectFigures)(inputs, T, opts));
}
/**
 * The audit of one release's figures, off the main thread where there is one. kind 'county': a county publication
 * release (server/county-publication.js; office server only, so never on a device's runner).
 */
function runAudit(inputs, T, { kind } = {}) {
  const opts = { ...auditOptions };
  if (kind === 'county') {
    if (inline()) return inlineAudit(inputs, T, opts, kind);
    auditStats.worker++;
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject, timer: null, w: null, msg: { id, inputs, T, opts, kind } });
      dispatch(id);
    });
  }
  // On a device, in its Web Worker where it has one; otherwise inline (the browser kernel without one, or
  // SUDS_AUDIT_INLINE=1), after letting the event loop go once, so the page can paint between the read and the
  // audit (docs/architecture/ADR-0009, "Where it runs").
  if (inline()) {
    if (!deviceRunner) return inlineAudit(inputs, T, opts);
    auditStats.device++;
    return deviceRunner(inputs, T, opts).catch((e) => {
      if (e && e.code === 'SUDS_NO_WORKER') return inlineAudit(inputs, T, opts);
      if (e && e.code === 'SUDS_AUDIT_BACKSTOP') { console.warn('[suds] a publication release audit did not answer within the backstop on this device; its worker was stopped and the release refused'); return backstopRefusal(inputs); }
      throw e;
    });
  }
  auditStats.worker++;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, timer: null, w: null, msg: { id, inputs, T, opts } });
    dispatch(id);
  });
}

// The audited release, kept for a few minutes so that the three reports of one release, and their exports,
// asked for together, run the audit once. Keyed by everything the audit reads (the true figures, the lists
// and the threshold), so a change to any figure is a different key and nothing stale is served.
const CACHE_MS = 5 * 60 * 1000; const CACHE_MAX = 4;
const cache = new Map();
function audited(inputs, T) {
  const key = JSON.stringify([T, inputs.domains, inputs.funder, [...inputs.perFund], inputs.settlement.services_by_use, inputs.settlement.fundKeys]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const p = runAudit(inputs, T).then((r) => {
    const period = `${inputs.domains.months[0] || ''} to ${inputs.domains.months[inputs.domains.months.length - 1] || ''}`;
    if (r.refused && r.refused.backstop) console.warn(`[suds] a publication release (${period}) was refused: its audit ran past the wall-clock backstop`);
    // Figures of the audit's own work only (no count of people): what support needs to see why a period was refused.
    else if (r.refused && r.refused.out_of_budget) console.warn(`[suds] a publication release (${period}) was refused: its audit reached its budget (${JSON.stringify(r.audit || {})})`);
    return r;
  });
  // A refusal by the wall-clock backstop says how busy the machine was, not what the figures are: not kept.
  p.then((r) => { if (r.refused && r.refused.backstop) cache.delete(key); }, () => cache.delete(key));
  cache.delete(key); cache.set(key, { p, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}
function clearCache() { cache.clear(); released.clear(); }

// ---- the data's version ----
// What the release reads, in a few indexed lookups: for each table it reads, how many rows it holds and its
// latest change (every write stamps updated_at, which sync relies on: a row pushed from a device is stamped in
// server time; a hard delete leaves a tombstone). Asked inside the release's snapshot, so it is the version of
// exactly the data read. The same version, period and threshold give the same release, so the release is kept
// under that key and served again without reading anything (1.13.0 read everything again to find its cached
// audit: 0.6 to 1.4 s of held event loop at 20,000 clients for a release it already had). A table the release
// comes to read must be listed here (test/report-snapshot.test.js checks that every table a release reads is);
// the supplies tables are not read: the published NDP log is by month, without the naloxone product.
const VERSION_TABLES = ['clients', 'interventions', 'calls', 'referrals', 'episodes', 'overdose_events', 'funding_sources', 'time_entries', 'expenditures', 'settings', 'option_overrides'];
function dataVersion() {
  const out = VERSION_TABLES.map((t) => {
    try { const r = db.one(`SELECT COUNT(*) n, MAX(updated_at) u FROM ${t}`); return [r.n, r.u]; }
    catch { try { const r = db.one(`SELECT COUNT(*) n, MAX(rowid) u FROM ${t}`); return [r.n, r.u]; } catch { return null; } }
  });
  const ts = db.one(`SELECT COUNT(*) n, MAX(deleted_at) u FROM tombstones`);
  return JSON.stringify([out, [ts.n, ts.u]]);
}
// Releases by (threshold, period, data version): the pending or finished release (a promise), kept CACHE_MS.
const released = new Map();

/**
 * A refused release, as the audit log records it (1.17.0): why (budget, backstop, headline, or unprotected: the
 * release with tables withheld still failed its check), how many counts the check could not show protected, the
 * tables it had withheld before it gave up, and the audit's work. Table names, reason codes and counts of work
 * only, never a count of people.
 */
function refusalDetails(p) {
  const r = p.refused || {};
  return {
    reason: r.backstop ? 'backstop' : r.out_of_budget ? 'budget' : r.headline ? 'headline' : 'unprotected',
    unprotected: r.unprotected || 0, withheld: p.withheld_tables || [], ...(p.audit ? { steps: p.audit.steps, rounds: p.audit.rounds } : {}),
  };
}

/** The release for a period, and each report's part of it. counting: FR.countingMode for a publication run. */
async function release(ctx, range, counting) {
  try { return await releaseOf(ctx, range, counting); } catch (e) {
    // Every report asked of a refused release records the refusal, with why and what it had withheld (the reports
    // that print a release record its id and withheld tables: FR.releaseAuditDetails).
    if (e && e.status === 422 && e.extra && e.extra.code === 'publication_refused') {
      require('./audit').log({ user: ctx.user, action: 'report.publication.refused', ip: ctx.ip, success: false, details: { path: ctx.path, from: range.from, to: range.to, threshold: counting.threshold, ...(e.refusal || refusalDetails({})) } });
    }
    throw e;
  }
}
async function releaseOf(ctx, range, counting) {
  const T = counting.threshold;
  // One snapshot of the data for everything the release reads. Where there is a second connection to read it
  // from, the read lets the event loop go between its phases; elsewhere it runs straight through (db.readSnapshot).
  const read = await db.readSnapshot(async (canYield) => {
    const key = JSON.stringify([T, range.from, range.to, dataVersion()]);
    const hit = released.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { hit };
    // Claimed before the read, so the other reports of the release, asked for at the same time, wait for this
    // one rather than reading the same data again.
    let settle; const p = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    // A refusal (422) is a property of the data too, and kept like a release; anything else is not kept, nor
    // is a refusal by the wall-clock backstop (a busy machine, not the figures).
    p.catch((e) => { if (!(e && e.status === 422) || (e.extra && e.extra.backstop)) released.delete(key); });
    released.set(key, { at: Date.now(), p });
    while (released.size > CACHE_MAX) released.delete(released.keys().next().value);
    // With no snapshot to read from, the phases run straight through: nothing else runs in between.
    try { return { key, settle, p, figures: canYield ? await FR.runAsync(readFigures(ctx, range, T)) : FR.runSync(readFigures(ctx, range, T)) }; }
    catch (e) { settle.reject(e); throw e; }
  });
  if (read.hit) return structuredClone(await read.hit.p);
  try { read.settle.resolve(await assemble(read.figures, range, counting)); }
  catch (e) { read.settle.reject(e); }
  return structuredClone(await read.p);
}

/** Everything the release prints, in phases (a generator: `yield` marks where the event loop may be let go). */
function* readFigures(ctx, range, T) {
  const HR = require('./harm-reduction-reports');
  const O = require('./options');
  const { raw, perFund } = yield* FR.figures(ctx, range, null, { fold: T });
  yield;
  const settle = HR.settlementFigures(range);
  yield;
  const dist = HR.distributionRows(ctx, range, true);
  const domains = { months: RA.monthsOf(range.from, range.to), administered_by: O.known('ADMINISTERED_BY'), discharge_reasons: O.known('DISCHARGE_REASONS') };
  const ndpSettings = HR.ndpSettings();
  return { raw, perFund, settle, dist, domains, ndpSettings };
}

/** The audited release, as each report prints it (a refusal throws 422). */
async function assemble({ raw, perFund, settle, dist, domains, ndpSettings }, range, counting) {
  const HR = require('./harm-reduction-reports');
  const T = counting.threshold;
  const p = await audited({ funder: raw, perFund, settlement: settle, domains }, T);
  if (p.refused) {
    const e = new HttpError(422, p.refused.message, { code: 'publication_refused', ...(p.refused.backstop ? { backstop: true } : {}) });
    // What the audit log records of the refusal (not sent to the person: they have the message).
    e.refusal = refusalDetails(p);
    throw e;
  }
  // not_published: what no publication release prints, whatever the figures (a choice of method: RA.NOT_PUBLISHED).
  const rel = { ...counting.release, id: p.id, reports: ['funder', 'naloxone-ndp', 'opioid-settlement'], withheld: p.withheld_tables, withheld_reasons: p.withheld_reasons, not_published: RA.NOT_PUBLISHED };
  const withRelease = (d) => ({ ...d, release: rel });
  const { fundKeys, ...s } = settle;
  return {
    id: p.id,
    funder: withRelease({ ...FR.header(counting, range.from, range.to, null), ...p.funder }),
    settlement: withRelease({ ...s, funds: s.funds.map(({ is_active, ...f }) => f), ...HR.header(counting),
      services_by_use: s.services_by_use.map((x, i) => ({ ...SC.withCell(x, 'people', p.uses[i].people), services: p.uses[i].services })) }),
    ndp: withRelease(HR.ndpPublished(range, counting, dist, p.ndp, ndpSettings)),
  };
}

module.exports = { release, runAudit, auditStats, setDeviceAuditRunner, dataVersion, VERSION_TABLES, setAuditOptions, clearCache, _setWorkerForTests, protectFigures: RA.protectFigures, buildModel: RA.buildModel, prepare: RA.prepare, digest: RA.digest, monthsOf: RA.monthsOf, AUDIT_BACKSTOP_MS: RA.AUDIT_BACKSTOP_MS };

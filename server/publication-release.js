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
// threads, and when SUDS_AUDIT_INLINE=1, it runs inline (the tests' API calls use the worker, as the server
// does). A wall-clock backstop (release-audit.js AUDIT_BACKSTOP_MS) protects the server from a runaway audit:
// a release it stops is refused and logged.
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
let worker = null; let seq = 0; const pending = new Map();
function failAll(err) { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); } pending.clear(); }
function auditWorker() {
  if (worker) return worker;
  const w = new WorkerCtor(require('node:path').join(__dirname, 'release-audit-worker.js'));
  w.on('message', ({ id, result, error }) => {
    const p = pending.get(id); if (!p) return;
    pending.delete(id); clearTimeout(p.timer);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  });
  w.on('error', (e) => { if (worker === w) worker = null; failAll(e); });
  w.on('exit', () => { if (worker === w) worker = null; failAll(new Error('the publication audit worker stopped')); });
  // Unreferenced after its listeners are attached (attaching one references it again): an idle audit worker
  // never keeps the process alive.
  w.unref();
  worker = w;
  return w;
}
// How many audits ran where (the tests check that theirs ran in the worker, as the server's do).
const auditStats = { worker: 0, inline: 0 };
/** The audit of one release's figures, off the main thread where there is one. */
function runAudit(inputs, T) {
  const opts = { ...auditOptions };
  // Inline (the browser kernel, which has no worker threads), after letting the event loop go once, so the page
  // can paint between the read and the audit (docs/architecture/ADR-0009, "Where it runs").
  if (inline()) { auditStats.inline++; return new Promise((resolve) => require('./spreadsheet').defer(resolve)).then(() => RA.protectFigures(inputs, T, opts)); }
  auditStats.worker++;
  return new Promise((resolve, reject) => {
    const id = ++seq; const w = auditWorker();
    // Beyond the audit's own backstop: a worker that does not answer is stopped (and a new one started next time).
    const timer = setTimeout(() => {
      console.warn(`[suds] a publication release audit did not answer within ${Math.round((RA.AUDIT_BACKSTOP_MS + 15000) / 1000)} s; its worker was stopped and the release refused`);
      pending.delete(id); w.terminate().catch(() => {}); if (worker === w) worker = null;
      resolve({ refused: { out_of_budget: true, backstop: true, message: RA.refusalMessage({ backstop: true }) } });
    }, RA.AUDIT_BACKSTOP_MS + 15000);
    if (timer.unref) timer.unref();
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, inputs, T, opts });
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
    if (r.refused && r.refused.backstop) console.warn(`[suds] a publication release (${inputs.domains.months[0] || ''} to ${inputs.domains.months[inputs.domains.months.length - 1] || ''}) was refused: its audit ran past the wall-clock backstop`);
    return r;
  });
  p.catch(() => cache.delete(key));
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
// audit: 0.6 to 1.4 s of held event loop at 20,000 clients for a release it already had).
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

/** The release for a period, and each report's part of it. counting: FR.countingMode for a publication run. */
async function release(ctx, range, counting) {
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
    // A refusal (422) is a property of the data too, and kept like a release; anything else is not kept.
    p.catch((e) => { if (!(e && e.status === 422)) released.delete(key); });
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
  if (p.refused) throw new HttpError(422, p.refused.message, { code: 'publication_refused' });
  const rel = { ...counting.release, id: p.id, reports: ['funder', 'naloxone-ndp', 'opioid-settlement'], withheld: p.withheld_tables, withheld_reasons: p.withheld_reasons };
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

module.exports = { release, runAudit, auditStats, dataVersion, setAuditOptions, clearCache, protectFigures: RA.protectFigures, buildModel: RA.buildModel, prepare: RA.prepare, digest: RA.digest, monthsOf: RA.monthsOf, AUDIT_BACKSTOP_MS: RA.AUDIT_BACKSTOP_MS };

'use strict';
// FHIR Bulk Data export ($export, system and Patient level), following the Bulk Data Access IG:
//   kick-off   GET /fhir/R4/$export (or /fhir/R4/Patient/$export), Prefer: respond-async -> 202 + Content-Location
//   status     GET /fhir/R4/$export-status/:id -> 202 (X-Progress) while running, 200 + manifest when done
//   files      GET /fhir/R4/$export-file/:id/:name -> application/fhir+ndjson (the manifest's output urls)
//   cancel     DELETE /fhir/R4/$export-status/:id -> 202, files removed
//
// Output files are written to <data dir>/fhir-export/<job id>/, each one encrypted with the database key
// (AES-256-GCM, server/crypto.js), readable only through the file URL by the FHIR client that asked, and
// deleted when the job expires (FHIR_EXPORT_TTL_MINUTES, default 60) or is cancelled. Job state is kept in
// memory: SUDS is one process, and a restart makes a client start its export again (the files left behind
// are swept by age). A key rotation during that window makes the files unreadable; the file URL then
// answers 410 and the client starts again.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const audit = require('../audit');
const disclosure = require('../disclosure');
const { encrypt, decrypt, uuid } = require('../crypto');
const R = require('./resources');
const C = require('./clients');
const { FhirError, FHIR_NDJSON, PART2_SECURITY, outcome, send, baseUrl } = require('./common');

const TTL_MS = Math.max(1, Number(process.env.FHIR_EXPORT_TTL_MINUTES) || 60) * 60_000;
const MAX_ACTIVE_PER_CLIENT = 2;
const PAGE = 500;
const OUTPUT_FORMATS = ['application/fhir+ndjson', 'application/ndjson', 'ndjson'];
const dir = () => path.join(config.dataDir, 'fhir-export');
const jobs = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.expiresAt && j.expiresAt < now) removeJob(id);
  // Files a previous run of the server left behind (its jobs died with it) go once they are past the TTL.
  let entries = [];
  try { entries = fs.readdirSync(dir()); } catch { return; }
  for (const e of entries) {
    if (jobs.has(e)) continue;
    const p = path.join(dir(), e);
    try { if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.rmSync(p, { recursive: true, force: true }); } catch { /* raced with another sweep */ }
  }
}
// (esbuild bundles every route module into the local kernel, unused there; nothing here may assume Node timers.)
const later = (fn) => (globalThis.setImmediate || setTimeout)(fn);
const sweeper = setInterval(sweep, 5 * 60_000); if (sweeper && sweeper.unref) sweeper.unref();

function removeJob(id) {
  jobs.delete(id);
  try { fs.rmSync(path.join(dir(), id), { recursive: true, force: true }); } catch { /* already gone */ }
}

/** The types a kick-off asked for, checked against the client's scopes and the export level. */
function exportTypes(ctx, client, level) {
  const all = Object.keys(R.DEFS).filter(t => level === 'system' || R.DEFS[t].phi);
  const asked = ctx.query.get('_type');
  if (!asked) {
    const types = all.filter(t => C.hasScope(client.scopes, t));
    if (!types.length) throw new FhirError(403, 'This client has no read scope for any exportable resource type', { code: 'forbidden' });
    return types;
  }
  const types = [...new Set(asked.split(',').map(s => s.trim()).filter(Boolean))];
  for (const t of types) {
    if (!R.DEFS[t]) throw new FhirError(400, `"${t}" is not a resource type this server exports`, { code: 'not-supported' });
    if (!all.includes(t)) throw new FhirError(400, `${t} is not in the Patient compartment; use the system-level $export for it`, { code: 'invalid' });
    C.requireScope(ctx, client, t);
  }
  return types;
}

function kickoff(ctx, client, level) {
  sweep();
  if (!/respond-async/i.test(String(ctx.headers.prefer || ''))) throw new FhirError(400, 'Bulk export requires the header "Prefer: respond-async"', { code: 'required' });
  const accept = String(ctx.headers.accept || '');
  if (accept && !/json|\*\/\*/i.test(accept)) throw new FhirError(406, 'Accept must be application/fhir+json', { code: 'not-supported' });
  for (const k of ctx.query.keys()) if (!['_type', '_since', '_outputFormat'].includes(k)) throw new FhirError(400, `Export parameter "${k}" is not supported (supported: _type, _since, _outputFormat)`, { code: 'not-supported' });
  const fmt = ctx.query.get('_outputFormat');
  if (fmt && !OUTPUT_FORMATS.includes(fmt)) throw new FhirError(400, `_outputFormat must be application/fhir+ndjson`, { code: 'not-supported' });
  let since = null;
  if (ctx.query.get('_since')) {
    const t = Date.parse(ctx.query.get('_since'));
    if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(ctx.query.get('_since'))) throw new FhirError(400, '_since must be a FHIR instant (e.g. 2026-01-01T00:00:00Z)', { code: 'invalid' });
    since = new Date(t).toISOString();
  }
  const types = exportTypes(ctx, client, level);
  const running = [...jobs.values()].filter(j => j.keyId === client.id && j.status === 'in-progress').length;
  if (running >= MAX_ACTIVE_PER_CLIENT) throw new FhirError(429, `This client already has ${running} exports running; wait for one to finish`, { code: 'throttled', headers: { 'Retry-After': '30' } });
  const base = baseUrl(ctx);
  const job = { id: uuid(), keyId: client.id, level, types, since, request: `${base}${level === 'patient' ? '/Patient' : ''}/$export${ctx.query.toString() ? '?' + ctx.query.toString() : ''}`,
    transactionTime: db.now(), status: 'in-progress', progress: 'queued', outputs: [], errors: [], expiresAt: null, base };
  jobs.set(job.id, job);
  audit.log({ user: client.actor, action: 'fhir.export.kickoff', entity: 'fhir_export', entityId: job.id, ip: ctx.ip, details: { client: client.prefix, level, types, since: !!since } });
  later(() => { run(job, client, ctx.ip).catch(() => { /* recorded on the job */ }); });
  send(ctx.res, 202, outcome([{ severity: 'information', code: 'informational', diagnostics: `Export ${job.id} accepted; poll the Content-Location URL for its status.` }]), { 'Content-Location': `${base}/$export-status/${job.id}` });
}

async function run(job, client, ip) {
  const jobDir = path.join(dir(), job.id);
  try {
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const coverage = disclosure.fhirCoverage({ cacheKey: client.id, recipients: client.recipients, purposeOfUse: client.purpose });
    const perClient = new Map(); const omitted = new Set(); let total = 0;
    for (const type of job.types) {
      if (!jobs.has(job.id)) return; // cancelled
      job.progress = `exporting ${type}`;
      const d = R.DEFS[type];
      const filter = R.where(type, new URLSearchParams(), { since: job.since });
      const lines = [];
      for (let offset = 0; ; offset += PAGE) {
        const rows = R.page(type, filter, { count: PAGE, offset });
        for (const row of rows) {
          if (d.phi && !coverage.has(row._cid)) { omitted.add(row._cid); continue; }
          const r = R.toResource(type, row);
          if (!r || (d.keep && !d.keep(r.full, client))) continue;
          lines.push(JSON.stringify(r.resource));
          if (d.phi) {
            const e = perClient.get(row._cid) || { consentId: coverage.get(row._cid), counts: {} };
            e.counts[type] = (e.counts[type] || 0) + 1; perClient.set(row._cid, e);
          }
        }
        if (rows.length < PAGE) break;
        await new Promise(res => later(res)); // let other requests in between pages
      }
      if (lines.length) {
        const file = `${type}.ndjson`;
        fs.writeFileSync(path.join(jobDir, file + '.enc'), encrypt(lines.join('\n') + '\n'), { mode: 0o600 });
        job.outputs.push({ type, file, count: lines.length });
        total += lines.length;
      }
    }
    if (!jobs.has(job.id)) return;
    // What was withheld, and the redisclosure notice, travel with the export as an OperationOutcome file.
    const phi = job.types.some(t => R.DEFS[t].phi);
    if (phi) {
      const issues = [{ severity: 'information', code: 'informational', diagnostics: `42 CFR §2.32 notice: ${disclosure.notice().text}` }];
      if (omitted.size) issues.push({ severity: 'warning', code: 'suppressed', diagnostics: `${omitted.size} patient(s) were left out of this export: no active consent covers ${client.recipient} for this purpose of use, or the patient has an agreed restriction.` });
      const oo = { ...outcome(issues), meta: { security: PART2_SECURITY } };
      fs.writeFileSync(path.join(jobDir, 'OperationOutcome.ndjson.enc'), encrypt(JSON.stringify(oo) + '\n'), { mode: 0o600 });
      job.errors.push({ type: 'OperationOutcome', file: 'OperationOutcome.ndjson', count: 1 });
    }
    // One accounting-of-disclosures row per patient for the whole export.
    for (const e of perClient.values()) e.what = `FHIR bulk export ${job.id}: ${Object.entries(e.counts).map(([t, n]) => `${t} (${n})`).join(', ')}`;
    disclosure.recordFhir({ perClient, recipient: client.recipient, purposeOfUse: client.purpose, sourceRef: `fhir-export:${job.id}`, user: client.actor, ip });
    // A bulk export naming a great many people is a mass identified export like any other (server/incidents.js).
    require('../incidents').maybeMassExport({ clients: perClient.size, kind: 'fhir-bulk', user: client.actor });
    audit.log({ user: client.actor, action: 'fhir.export.complete', entity: 'fhir_export', entityId: job.id, ip, details: { client: client.prefix, types: job.types, resources: total, patients: perClient.size, omitted_patients: omitted.size } });
    job.status = 'complete'; job.progress = 'complete'; job.expiresAt = Date.now() + TTL_MS;
  } catch (e) {
    job.status = 'error'; job.message = 'The export failed on the server'; job.expiresAt = Date.now() + TTL_MS;
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* nothing written */ }
    console.error(`[suds] FHIR export ${job.id} failed:`, e.message);
    audit.log({ user: client.actor, action: 'fhir.export.failed', entity: 'fhir_export', entityId: job.id, ip, success: false, details: { message: String(e.message).slice(0, 200) } });
  }
}

function ownJob(ctx, client) {
  sweep();
  const j = jobs.get(ctx.params.id);
  // Another client's job is reported exactly as a job that does not exist.
  if (!j || j.keyId !== client.id) throw new FhirError(404, 'No such export (it may have expired or been deleted)', { code: 'not-found' });
  return j;
}

function status(ctx, client) {
  const j = ownJob(ctx, client);
  if (j.status === 'in-progress') { ctx.res.writeHead(202, { 'X-Progress': j.progress, 'Retry-After': '2', 'Content-Length': 0 }); ctx.res.end(); return; }
  if (j.status === 'error') throw new FhirError(500, j.message, { code: 'exception' });
  const url = (f) => `${j.base}/$export-file/${j.id}/${f.file}`;
  const manifest = {
    transactionTime: j.transactionTime, request: j.request, requiresAccessToken: true,
    output: j.outputs.map(f => ({ type: f.type, url: url(f), count: f.count })),
    error: j.errors.map(f => ({ type: f.type, url: url(f) })),
    extension: { 'urn:suds:part2': { security: j.types.some(t => R.DEFS[t].phi) ? PART2_SECURITY : [], notice: j.types.some(t => R.DEFS[t].phi) ? disclosure.notice().text : undefined, expires: new Date(j.expiresAt).toISOString() } },
  };
  const body = JSON.stringify(manifest);
  ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), Expires: new Date(j.expiresAt).toUTCString() });
  ctx.res.end(body);
}

function cancel(ctx, client) {
  const j = ownJob(ctx, client);
  removeJob(j.id);
  audit.log({ user: client.actor, action: 'fhir.export.delete', entity: 'fhir_export', entityId: j.id, ip: ctx.ip, details: { client: client.prefix, status: j.status } });
  send(ctx.res, 202, outcome([{ severity: 'information', code: 'informational', diagnostics: `Export ${j.id} deleted` }]));
}

function file(ctx, client) {
  const j = ownJob(ctx, client);
  const f = [...j.outputs, ...j.errors].find(x => x.file === ctx.params.file);
  if (j.status !== 'complete' || !f) throw new FhirError(404, 'No such export file', { code: 'not-found' });
  let body;
  try { body = decrypt(fs.readFileSync(path.join(dir(), j.id, f.file + '.enc'), 'utf8')); }
  catch { throw new FhirError(410, 'This export file can no longer be read (expired, or the server key changed); start a new export', { code: 'not-found' }); }
  audit.log({ user: client.actor, action: 'fhir.export.download', entity: 'fhir_export', entityId: j.id, ip: ctx.ip, details: { client: client.prefix, type: f.type, count: f.count } });
  ctx.res.writeHead(200, { 'Content-Type': FHIR_NDJSON, 'Content-Length': Buffer.byteLength(body) });
  ctx.res.end(body);
}

module.exports = { kickoff, status, cancel, file, sweep, TTL_MS, _jobs: jobs };

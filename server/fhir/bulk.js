'use strict';
// FHIR Bulk Data export ($export, system and Patient level), following the Bulk Data Access IG:
//   kick-off   GET /fhir/R4/$export (or /fhir/R4/Patient/$export), Prefer: respond-async -> 202 + Content-Location
//   status     GET /fhir/R4/$export-status/:id -> 202 (X-Progress) while running, 200 + manifest when done
//   files      GET /fhir/R4/$export-file/:id/:name -> application/fhir+ndjson (the manifest's output urls)
//   cancel     DELETE /fhir/R4/$export-status/:id -> 202, files removed
//
// Output files are written to <data dir>/fhir-export/<job id>/, each one encrypted with the database key
// (AES-256-GCM, server/crypto.js), readable only through the file URL by the FHIR client that asked, and
// deleted when the job expires (FHIR_EXPORT_TTL_MINUTES, default 60) or is cancelled. A key rotation during
// that window makes the files unreadable; the file URL then answers 410 and the client starts again.
//
// Part 2 timing. Building the files is audited (fhir.export.complete) but is not yet a disclosure: nothing
// has left the programme. The disclosure happens when a file is downloaded, so that is when it is checked
// and accounted. At each download every patient in the file must still be covered: a consent revoked (or
// expired, or a restriction agreed) after the build makes the file answer 410, and the client must start a
// new export, which leaves that patient out. The first download of each file writes one accounting row per
// patient in it, under the consent that covers them at that moment.
//
// Job state (never access tokens) is kept beside the files as job.json.enc, encrypted likewise, so a restart
// neither orphans a finished export nor forgets which files were already accounted. A job that was still
// being built when the process stopped is marked failed (the client starts again) and its partial files are
// removed; a directory with no readable state is removed at startup (restore(), called by server/index.js).
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
const STATE = 'job.json.enc';
const dir = () => path.join(config.dataDir, 'fhir-export');
const jobs = new Map();

/** Write a job's state beside its files (encrypted: the per-file patient lists say who was exported). */
function save(job) {
  try {
    fs.mkdirSync(path.join(dir(), job.id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir(), job.id, STATE), encrypt(JSON.stringify(job)), { mode: 0o600 });
  } catch (e) { console.error(`[suds] FHIR export ${job.id}: could not save its state:`, e.message); }
}

let restored = false;
/**
 * Bring back the jobs a previous server process left: finished ones carry on where they were; one that was
 * mid-build is marked failed and its partial files removed; a directory with no readable state (written by
 * an older SUDS, or under a key since rotated) or past its expiry is removed. Runs once per process, at
 * startup (server/index.js), when this process is the only one using the data directory (instance-lock.js).
 */
function restore() {
  if (restored) return;
  restored = true;
  let entries = [];
  try { entries = fs.readdirSync(dir()); } catch { return; }
  const now = Date.now();
  for (const e of entries) {
    if (jobs.has(e)) continue;
    const p = path.join(dir(), e);
    let job = null;
    try { job = JSON.parse(decrypt(fs.readFileSync(path.join(p, STATE), 'utf8'))); } catch { /* no readable state */ }
    if (!job || job.id !== e || (job.expiresAt && job.expiresAt < now)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* raced */ } continue; }
    if (job.status === 'in-progress') {
      job.status = 'error'; job.message = 'The server restarted while this export was being built; start a new export';
      job.expiresAt = now + TTL_MS; job.outputs = []; job.errors = [];
      try { for (const f of fs.readdirSync(p)) if (f !== STATE) fs.rmSync(path.join(p, f), { force: true }); } catch { /* nothing written */ }
      save(job);
    }
    jobs.set(job.id, job);
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.expiresAt && j.expiresAt < now) removeJob(id);
  // Anything else in the directory that no job owns (a crash between mkdir and the first save, or a
  // process that never ran restore()) goes once it is past the TTL.
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
    transactionTime: db.now(), status: 'in-progress', progress: 'queued', outputs: [], errors: [], expiresAt: null, base, downloaded: {}, massChecked: false };
  jobs.set(job.id, job);
  save(job);
  audit.log({ user: client.actor, action: 'fhir.export.kickoff', entity: 'fhir_export', entityId: job.id, ip: ctx.ip, details: { client: client.prefix, level, types, since: !!since } });
  later(() => { run(job, client, ctx.ip).catch(() => { /* recorded on the job */ }); });
  send(ctx.res, 202, outcome([{ severity: 'information', code: 'informational', diagnostics: `Export ${job.id} accepted; poll the Content-Location URL for its status.` }]), { 'Content-Location': `${base}/$export-status/${job.id}` });
}

async function run(job, client, ip) {
  const jobDir = path.join(dir(), job.id);
  try {
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const coverage = disclosure.fhirCoverage({ cacheKey: client.id, recipients: client.recipients, purposeOfUse: client.purpose });
    const patients = new Set(); const omitted = new Set(); let total = 0;
    for (const type of job.types) {
      if (!jobs.has(job.id)) return; // cancelled
      job.progress = `exporting ${type}`;
      const d = R.DEFS[type];
      const filter = R.where(type, new URLSearchParams(), { since: job.since });
      const lines = []; const inFile = {};
      for (let offset = 0; ; offset += PAGE) {
        const rows = R.page(type, filter, { count: PAGE, offset });
        for (const row of rows) {
          if (d.phi && !coverage.has(row._cid)) { omitted.add(row._cid); continue; }
          const r = R.toResource(type, row);
          if (!r || (d.keep && !d.keep(r.full, client))) continue;
          lines.push(JSON.stringify(r.resource));
          if (d.phi) { inFile[row._cid] = (inFile[row._cid] || 0) + 1; patients.add(row._cid); }
        }
        if (rows.length < PAGE) break;
        await new Promise(res => later(res)); // let other requests in between pages
      }
      if (lines.length) {
        const file = `${type}.ndjson`;
        fs.writeFileSync(path.join(jobDir, file + '.enc'), encrypt(lines.join('\n') + '\n'), { mode: 0o600 });
        // Who is in each file (client id -> resources): checked again, and accounted, when it is downloaded.
        job.outputs.push({ type, file, count: lines.length, patients: d.phi ? inFile : null });
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
    // Built, not yet disclosed: audited now, accounted per file at its first download (file() below).
    audit.log({ user: client.actor, action: 'fhir.export.complete', entity: 'fhir_export', entityId: job.id, ip, details: { client: client.prefix, types: job.types, resources: total, patients: patients.size, omitted_patients: omitted.size } });
    job.status = 'complete'; job.progress = 'complete'; job.expiresAt = Date.now() + TTL_MS;
    save(job);
  } catch (e) {
    job.status = 'error'; job.message = 'The export failed on the server'; job.expiresAt = Date.now() + TTL_MS; job.outputs = []; job.errors = [];
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* nothing written */ }
    if (jobs.has(job.id)) save(job);
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
    extension: { 'urn:suds:part2': { security: j.types.some(t => R.DEFS[t].phi) ? PART2_SECURITY : [], notice: j.types.some(t => R.DEFS[t].phi) ? disclosure.notice().text : undefined, expires: new Date(j.expiresAt).toISOString(),
      consent_checked_at: 'download' } },
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
  const who = f.patients ? Object.keys(f.patients) : [];
  let perClient = null;
  if (who.length) {
    // The disclosure happens now, so the consent is checked now: everyone in this file must still be covered.
    const coverage = disclosure.fhirCoverage({ cacheKey: client.id, recipients: client.recipients, purposeOfUse: client.purpose });
    const lapsed = who.filter(cid => !coverage.has(cid));
    if (lapsed.length) {
      audit.log({ user: client.actor, action: 'fhir.export.download.refused', entity: 'fhir_export', entityId: j.id, ip: ctx.ip, success: false, details: { client: client.prefix, type: f.type, lapsed_patients: lapsed.length } });
      throw new FhirError(410, 'Since this export was built, a patient in this file is no longer covered by a consent to this recipient (revoked, expired, or a restriction was agreed). The file will not be released; start a new export.', { code: 'business-rule' });
    }
    if (!j.downloaded[f.file]) perClient = new Map(who.map(cid => [cid, { consentId: coverage.get(cid), what: `FHIR bulk export ${j.id}: ${f.type} (${f.patients[cid]})` }]));
  }
  let body;
  try { body = decrypt(fs.readFileSync(path.join(dir(), j.id, f.file + '.enc'), 'utf8')); }
  catch { throw new FhirError(410, 'This export file can no longer be read (expired, or the server key changed); start a new export', { code: 'not-found' }); }
  if (perClient) {
    // First download of this file: one accounting-of-disclosures row per patient in it.
    disclosure.recordFhir({ perClient, recipient: client.recipient, purposeOfUse: client.purpose, sourceRef: `fhir-export:${j.id}`, user: client.actor, ip: ctx.ip });
    if (!j.massChecked) {
      // A bulk export naming a great many people is a mass identified export like any other (server/incidents.js).
      j.massChecked = true;
      const everyone = new Set(j.outputs.flatMap(o => (o.patients ? Object.keys(o.patients) : [])));
      require('../incidents').maybeMassExport({ clients: everyone.size, kind: 'fhir-bulk', user: client.actor });
    }
  }
  if (!j.downloaded[f.file]) { j.downloaded[f.file] = new Date().toISOString(); save(j); }
  audit.log({ user: client.actor, action: 'fhir.export.download', entity: 'fhir_export', entityId: j.id, ip: ctx.ip, details: { client: client.prefix, type: f.type, count: f.count, patients: who.length, accounted: !!perClient } });
  ctx.res.writeHead(200, { 'Content-Type': FHIR_NDJSON, 'Content-Length': Buffer.byteLength(body) });
  ctx.res.end(body);
}

module.exports = { kickoff, status, cancel, file, sweep, restore, TTL_MS, _jobs: jobs, _resetForTests: () => { jobs.clear(); restored = false; } };

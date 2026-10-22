'use strict';
// Reading an uploaded file off the event loop (1.26.1; code evaluation of 1.26.0, M3). SUDS is one process: while it
// parses a large spreadsheet or Word file, every other request waits. Each job here runs in a short-lived worker thread
// (server/offload-worker.js) with its own memory limit and a time limit, so a file that is too big or too slow to read
// fails alone, as a 400, instead of stalling or ending the server for everyone. The jobs are the pure readers:
//   spreadsheet  server/spreadsheet.js parseFile (xlsx or CSV), for data imports and the PowerDMS report;
//   doc-text     server/doc-text.js extractText (a policy document's searchable text);
//   docx         server/importers/text.js docxToText (a Word file of notes).
// Where there is no worker_threads (the browser kernel: local/shims/empty.js), or with SUDS_OFFLOAD=inline, a job runs
// inline, as before. Node built-ins only.
let WorkerCtor = null;
try { WorkerCtor = require('node:worker_threads').Worker; } catch { WorkerCtor = null; }
const JOBS = {
  spreadsheet: () => require('./spreadsheet').parseFile,
  'doc-text': () => require('./doc-text').extractText,
  docx: () => require('./importers/text').docxToText,
};
const LIMITS = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 };
const TIMEOUT_MS = 60_000;
const TOO_MUCH = 'This file is too large or too complex to read here. Split it into smaller files.';

/** Run `job` with `args` (plain data and Buffers), resolving with its result; rejects with an Error whose message says why. */
function offload(job, ...args) {
  if (!JOBS[job]) return Promise.reject(new Error(`no such job: ${job}`));
  if (!WorkerCtor || process.env.SUDS_OFFLOAD === 'inline') {
    try { return Promise.resolve(JOBS[job]()(...args)); } catch (e) { return Promise.reject(e); }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const w = new WorkerCtor(require('node:path').join(__dirname, 'offload-worker.js'), { workerData: { job, args }, resourceLimits: LIMITS });
    const end = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); w.terminate().catch(() => {}); fn(v); };
    const timer = setTimeout(() => end(reject, new Error(TOO_MUCH)), TIMEOUT_MS);
    w.on('message', (m) => (m && m.ok ? end(resolve, m.value) : end(reject, new Error((m && m.message) || 'The file could not be read'))));
    // Out of memory (ERR_WORKER_OUT_OF_MEMORY) or any other death: that file, not the server.
    w.on('error', (e) => end(reject, new Error(e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? TOO_MUCH : (e && e.message) || 'The file could not be read')));
    w.on('exit', (code) => end(reject, new Error(code ? TOO_MUCH : 'The file could not be read')));
  });
}

module.exports = { offload, JOBS: Object.keys(JOBS), TIMEOUT_MS };

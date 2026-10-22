'use strict';
// The worker thread server/offload.js starts for one job: read the file, post the result (or why not), and end.
const { parentPort, workerData } = require('node:worker_threads');
const JOBS = {
  spreadsheet: () => require('./spreadsheet').parseFile,
  'doc-text': () => require('./doc-text').extractText,
  docx: () => require('./importers/text').docxToText,
};
try {
  // Buffers arrive as Uint8Arrays: the readers want Buffers.
  const args = (workerData.args || []).map((a) => (a instanceof Uint8Array && !Buffer.isBuffer(a) ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : a));
  parentPort.postMessage({ ok: true, value: JOBS[workerData.job]()(...args) });
} catch (e) {
  parentPort.postMessage({ ok: false, message: String((e && e.message) || e).slice(0, 300) });
}

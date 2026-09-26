'use strict';
// The worker thread a publication release's audit runs in (server/publication-release.js runAudit): the audit
// is pure computation on the figures it is sent (server/release-audit.js), so the server keeps answering
// everyone else while a year's release is checked. One message in, one out.
const { parentPort } = require('node:worker_threads');
const RA = require('./release-audit');

parentPort.on('message', ({ id, inputs, T, opts }) => {
  let out;
  try { out = { id, result: RA.protectFigures(inputs, T, opts || {}) }; } catch (e) { out = { id, error: String((e && e.message) || e) }; }
  parentPort.postMessage(out);
});

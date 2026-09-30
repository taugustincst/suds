'use strict';
// The worker thread a publication release's audit runs in (server/publication-release.js runAudit): the audit
// is pure computation on the figures it is sent (server/release-audit.js), so the server keeps answering
// everyone else while a year's release is checked. One message in, one out.
const { parentPort } = require('node:worker_threads');
const RA = require('./release-audit');

// kind 'county': a county publication release (server/county-publication-audit.js, built for 1.21.0, not yet released).
parentPort.on('message', ({ id, inputs, T, opts, kind }) => {
  let out;
  try { out = { id, result: (kind === 'county' ? require('./county-publication-audit').protectCounty : RA.protectFigures)(inputs, T, opts || {}) }; } catch (e) { out = { id, error: String((e && e.message) || e) }; }
  parentPort.postMessage(out);
});

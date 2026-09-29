// The Web Worker a publication release's audit runs in on a device (SUDS on this device, or an office's device
// copy): built by scripts/build-local.js into public/local/audit-worker.js, beside the kernel, and started by
// local/audit-runner.js. The audit is pure computation on the figures it is sent (server/release-audit.js, the
// same code the office server runs in its worker thread, server/release-audit-worker.js), so the page keeps
// answering taps while a year's release is checked (engineering reviews of 1.13.0-1.16.3: the audit ran on
// the page's thread and could hold a phone for seconds). One message in, one out.
import RA from '../server/release-audit.js';

self.onmessage = (ev) => {
  const { id, inputs, T, opts } = ev.data || {};
  let out;
  try { out = { id, result: RA.protectFigures(inputs, T, opts || {}) }; } catch (e) { out = { id, error: String((e && e.message) || e) }; }
  self.postMessage(out);
};
// Says it started: the runner falls back to the page's thread only when this never arrives (a browser that
// cannot start the worker), never once an audit has begun here.
self.postMessage({ ready: true });

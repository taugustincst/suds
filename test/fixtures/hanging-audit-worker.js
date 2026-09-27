'use strict';
// A stand-in for server/release-audit-worker.js (test/release-worker-timeout.test.js): answers each audit
// with what it was sent, after `delay` ms, except one marked `hang`, which it never answers. Messages are
// handled in order, like the real worker, so jobs sent after the hanging one queue behind it.
const { parentPort } = require('node:worker_threads');
let busy = Promise.resolve();
parentPort.on('message', ({ id, inputs }) => {
  busy = busy.then(() => new Promise((resolve) => {
    if (inputs && inputs.hang) { setInterval(() => {}, 1 << 30); return; } // never settles: the worker is stuck
    setTimeout(() => { parentPort.postMessage({ id, result: { echo: inputs && inputs.n } }); resolve(); }, (inputs && inputs.delay) || 0);
  }));
});

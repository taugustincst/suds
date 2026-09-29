// Runs a publication release's audit in a Web Worker on a device (local/audit-worker.js, built to
// public/local/audit-worker.js), so the page's thread stays free while a year's release is checked: the kernel
// answers the app's requests on the page's own thread, and before 1.17.0 the audit ran there too, for up to the
// 60-second backstop (engineering reviews of 1.13.0-1.16.3; docs/architecture/ADR-0009, "Where it runs").
// server/publication-release.js calls the runner that local/kernel.js gives it (setDeviceAuditRunner); the server
// runs the same audit in a worker thread instead (server/release-audit-worker.js).
//
// One long-lived worker, started on the first audit. The runner rejects with code SUDS_NO_WORKER when the worker
// cannot be used - the browser has no Web Workers, the constructor throws, or the script fails to load or does
// not say it started within startMs - and publication-release.js then runs the audit on the page, as before;
// once a worker has said it started, its audits are never run twice. A worker that did not say it started in time
// (a slow phone) is tried once more, for the next audit, before the device gives up on workers for the session; a
// constructor that throws or a script that does not load is not retried.
// The audits are handed to the worker one at a time (1.17.0; engineering review of its candidate, L1): the next is
// posted when the one before it has answered, so the backstop counts the audit's own time, never the time it
// waited behind another. An audit that does not answer within backstopMs of being posted is rejected with code
// SUDS_AUDIT_BACKSTOP (the release is refused, as on the server), its worker is stopped, and the next one waiting
// goes to a new one. The device's backstop is 75 s, the server's 60 s (server/release-audit.js AUDIT_BACKSTOP_MS):
// a phone is slower, and the budget in units of work, not time, decides what is published, the same on both, so
// a device refuses by the clock only a release the office would have refused by its budget or its clock too.
const noWorker = (why) => Object.assign(new Error(`the publication audit cannot run in a Web Worker here (${why})`), { code: 'SUDS_NO_WORKER' });

/** A function (inputs, T, opts) -> Promise of release-audit.js protectFigures' result, run in a Web Worker at `url`. */
export function auditRunner(url, { WorkerCtor = globalThis.Worker, backstopMs = 75000, startMs = 10000 } = {}) {
  let worker = null; let seq = 0; let broken = typeof WorkerCtor !== 'function' || !url ? 'no Web Worker' : null;
  // Whether a worker that did not start in time may be tried again (once).
  let retryStart = true;
  const pending = new Map(); const waiting = []; let current = null;
  const settle = (id, how, value) => {
    const p = pending.get(id); if (!p) return;
    pending.delete(id); clearTimeout(p.timer); p[how](value);
    if (current === id) { current = null; pump(); }
  };
  // Everything waiting (posted to worker w, or queued behind it), failed with err.
  const failAll = (err) => { const ids = [current, ...waiting].filter((x) => x != null); waiting.length = 0; current = null; for (const id of ids) { const p = pending.get(id); if (!p) continue; pending.delete(id); clearTimeout(p.timer); p.reject(err); } };
  const drop = (w) => { if (worker === w) worker = null; try { w.terminate(); } catch { /* already gone */ } };
  function spawn() {
    let w;
    try { w = new WorkerCtor(url, { name: 'suds-publication-audit' }); } catch (e) { broken = `it could not be started: ${e && e.message}`; retryStart = false; return null; }
    w.suds = { ready: false, startTimer: null };
    // A worker that has not said it started within startMs is given up (it may never load): its audits run on the page.
    w.suds.startTimer = setTimeout(() => { if (w.suds.ready) return; broken = 'it did not start'; drop(w); failAll(noWorker(broken)); }, startMs);
    w.onmessage = (ev) => {
      const d = (ev && ev.data) || {};
      if (d.ready) { w.suds.ready = true; clearTimeout(w.suds.startTimer); return; }
      const p = pending.get(d.id); if (!p || p.w !== w) return;
      if (d.error) settle(d.id, 'reject', new Error(d.error)); else settle(d.id, 'resolve', d.result);
    };
    w.onerror = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      clearTimeout(w.suds.startTimer);
      drop(w);
      if (!w.suds.ready) { broken = 'its script did not load'; retryStart = false; failAll(noWorker(broken)); } else failAll(new Error('the publication audit worker stopped'));
    };
    worker = w;
    return w;
  }
  // Post the next waiting audit, if none is running.
  function pump() {
    if (current != null) return;
    const id = waiting.shift(); if (id == null) return;
    const p = pending.get(id); if (!p) { pump(); return; }
    const w = worker || (broken ? null : spawn());
    if (!w) { failAll(noWorker(broken)); pending.delete(id); p.reject(noWorker(broken)); return; }
    current = id; p.w = w;
    p.timer = setTimeout(() => {
      if (!pending.has(id)) return;
      // Stopped, like the server's worker: this audit is refused, and the next one waiting starts on a new worker.
      drop(w);
      settle(id, 'reject', Object.assign(new Error('the publication audit did not answer in time'), { code: 'SUDS_AUDIT_BACKSTOP' }));
    }, backstopMs);
    try { w.postMessage(p.msg); } catch (e) { settle(id, 'reject', e); }
  }
  const run = (inputs, T, opts = {}) => new Promise((resolve, reject) => {
    // A worker that did not start in time is tried once more before the page is used for good.
    if (broken === 'it did not start' && retryStart && !worker) { broken = null; retryStart = false; }
    const id = ++seq;
    pending.set(id, { resolve, reject, timer: null, w: null, msg: { id, inputs, T, opts } });
    waiting.push(id);
    pump();
  });
  run.stats = () => ({ broken, running: current != null ? 1 : 0, waiting: waiting.length, started: !!(worker && worker.suds.ready) });
  return run;
}

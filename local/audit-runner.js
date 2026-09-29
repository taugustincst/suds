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
// once a worker has said it started, its audits are never run twice. An audit that does not answer within
// backstopMs is rejected with code SUDS_AUDIT_BACKSTOP (the release is refused, as on the server), its worker is
// stopped, and whatever else was waiting on it is sent to a new one.
const noWorker = (why) => Object.assign(new Error(`the publication audit cannot run in a Web Worker here (${why})`), { code: 'SUDS_NO_WORKER' });

/** A function (inputs, T, opts) -> Promise of release-audit.js protectFigures' result, run in a Web Worker at `url`. */
export function auditRunner(url, { WorkerCtor = globalThis.Worker, backstopMs = 75000, startMs = 10000 } = {}) {
  let worker = null; let seq = 0; let broken = typeof WorkerCtor !== 'function' || !url ? 'no Web Worker' : null;
  const pending = new Map();
  const settle = (id, how, value) => { const p = pending.get(id); if (!p) return; pending.delete(id); clearTimeout(p.timer); p[how](value); };
  // Everything waiting on worker w, failed with err.
  const failAll = (w, err) => { for (const [id, p] of [...pending]) if (p.w === w) settle(id, 'reject', err); };
  const drop = (w) => { if (worker === w) worker = null; try { w.terminate(); } catch { /* already gone */ } };
  function spawn() {
    let w;
    try { w = new WorkerCtor(url, { name: 'suds-publication-audit' }); } catch (e) { broken = `it could not be started: ${e && e.message}`; return null; }
    w.suds = { ready: false, startTimer: null };
    // A worker that has not said it started within startMs is given up (it may never load): its audits run on the page.
    w.suds.startTimer = setTimeout(() => { if (w.suds.ready) return; broken = 'it did not start'; drop(w); failAll(w, noWorker(broken)); }, startMs);
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
      if (!w.suds.ready) { broken = 'its script did not load'; failAll(w, noWorker(broken)); } else failAll(w, new Error('the publication audit worker stopped'));
    };
    worker = w;
    return w;
  }
  function dispatch(id) {
    const p = pending.get(id); if (!p) return;
    const w = worker || (broken ? null : spawn());
    if (!w) { settle(id, 'reject', noWorker(broken)); return; }
    p.w = w;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (!pending.has(id)) return;
      // Stopped, like the server's worker: this audit is refused, and the others queued on it start again on a new one.
      const others = [...pending].filter(([qid, q]) => qid !== id && q.w === w).map(([qid]) => qid);
      settle(id, 'reject', Object.assign(new Error('the publication audit did not answer in time'), { code: 'SUDS_AUDIT_BACKSTOP' }));
      drop(w);
      for (const qid of others) dispatch(qid);
    }, backstopMs);
    try { w.postMessage(p.msg); } catch (e) { settle(id, 'reject', e); }
  }
  const run = (inputs, T, opts = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, timer: null, w: null, msg: { id, inputs, T, opts } });
    dispatch(id);
  });
  run.stats = () => ({ broken, running: pending.size, started: !!(worker && worker.suds.ready) });
  return run;
}

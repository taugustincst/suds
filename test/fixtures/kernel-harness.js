'use strict';
// The browser kernel, bundled from the CURRENT sources exactly as scripts/build-local.js bundles it
// (scripts/kernel-build-options.js) and loaded in Node with sql.js and the few browser APIs it needs
// (WebCrypto and fetch are Node's own; IndexedDB and Web Storage are small in-memory stand-ins below), for
// test/kernel-parity.test.js and test/kernel-sync-parity.test.js. One kernel per test process: the kernel is
// a singleton, as it is in a page.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', '..');
const WASM_URL = 'https://suds.invalid/local/sql-wasm.wasm';

// ---- the browser APIs the kernel touches that Node lacks ----
function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
// IndexedDB, as much of it as local/shims/sqlite.js uses: one database, object stores of key -> structured
// clone, requests with onsuccess, transactions that run one after another, complete when their last request's
// callback has run, and roll back on abort().
function fakeIndexedDB() {
  const dbs = new Map();
  let chain = Promise.resolve();
  const cmp = (a, b) => (typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a === 'number' ? -1 : 1);
  const inRange = (range) => (k) => !range || ((range.lower === undefined || cmp(k, range.lower) >= 0) && (range.upper === undefined || cmp(k, range.upper) <= 0));
  function database(name) {
    const stores = dbs.get(name);
    return {
      objectStoreNames: { contains: (s) => stores.has(s) },
      createObjectStore(s) { stores.set(s, new Map()); return {}; },
      close() {},
      transaction(storeName) {
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null, aborted: false, queue: [] };
        const data = new Map(stores.get(storeName));
        const request = (op) => { const r = { result: undefined, error: null, onsuccess: null, onerror: null }; tx.queue.push(() => { r.result = op(); if (r.onsuccess) r.onsuccess({ target: r }); }); return r; };
        const store = {
          get: (k) => request(() => structuredClone(data.get(k))),
          put: (v, k) => request(() => { data.set(k, structuredClone(v)); return k; }),
          delete: (k) => request(() => { data.delete(k); }),
          clear: () => request(() => { data.clear(); }),
          getAll: () => request(() => [...data.keys()].sort(cmp).map((k) => structuredClone(data.get(k)))),
          getAllKeys: (range) => request(() => [...data.keys()].sort(cmp).filter(inRange(range))),
        };
        tx.objectStore = () => store;
        tx.commit = () => {};
        tx.abort = () => { tx.aborted = true; tx.error = new Error('AbortError'); };
        chain = chain.then(() => new Promise((resolve) => setTimeout(() => {
          while (tx.queue.length && !tx.aborted) tx.queue.shift()();
          if (tx.aborted) { if (tx.onabort) tx.onabort({ target: tx }); } else { stores.set(storeName, data); if (tx.oncomplete) tx.oncomplete({ target: tx }); }
          resolve();
        }, 0)));
        return tx;
      },
    };
  }
  return {
    open(name) {
      const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        r.result = database(name);
        if (fresh && r.onupgradeneeded) r.onupgradeneeded({ target: r });
        if (r.onsuccess) r.onsuccess({ target: r });
      }, 0);
      return r;
    },
  };
}

/**
 * Bundle and start the kernel. staticHost: SUDS on this device (the published web app; Sign up creates the
 * account, no office sync) or a device that syncs with an office server. Returns { L, cleanup }.
 */
async function loadKernel({ staticHost = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-kernel-'));
  const outfile = path.join(tmp, 'kernel.mjs');
  await require('esbuild').build(require('../../scripts/kernel-build-options').kernelBuildOptions(outfile));
  const wasm = fs.readFileSync(path.join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
  const realFetch = globalThis.fetch;
  Object.assign(globalThis, {
    window: globalThis, localStorage: storage(), sessionStorage: storage(), indexedDB: fakeIndexedDB(),
    IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) },
    // No BroadcastChannel: the kernel then skips the cross-window hand-over (one "window" here), and no
    // channel holds the test process open.
    BroadcastChannel: undefined,
    SUDS_STATIC_HOST: staticHost,
    fetch: (url, opts) => (String(url) === WASM_URL ? Promise.resolve(new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } })) : realFetch(url, opts)),
  });
  // The kernel's timers (heartbeat, idle lock) are for a page that lives on; here they must not keep the
  // process alive after the last test.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...a) => { const t = realSetInterval(...a); if (t && t.unref) t.unref(); return t; };
  const kernel = await import(pathToFileURL(outfile).href);
  const L = await kernel.start({ wasmUrl: WASM_URL });
  return { L, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
/** Call the kernel as the page does; { status, data }. */
const kernelCaller = (L) => async (method, p, body) => { const r = await L.handle(method, p, body); return { status: r.status, data: r.json !== undefined ? r.json : r.body }; };
// Ids, timestamps and the like differ between any two runs; the counts, labels and suppression decisions must not.
function strip(x) {
  if (Array.isArray(x)) return x.map(strip);
  if (!x || typeof x !== 'object') return x;
  const o = {};
  for (const [k, v] of Object.entries(x)) {
    if (/(^|_)(id|at|generated|generated_at|run_id|ref)$/.test(k) || ['version', 'timezone', 'org_name', 'programme', 'program'].includes(k)) continue;
    o[k] = strip(v);
  }
  return o;
}

module.exports = { loadKernel, kernelCaller, strip, WASM_URL };

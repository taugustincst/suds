'use strict';
// The same server code runs in two places: on the office server over node:sqlite, and in the browser as the
// local kernel (local/kernel.js, bundled with esbuild), over sql.js through local/shims/sqlite.js and the other
// shims. Until this test nothing in `npm test` ran the second: a shim that answered a query differently, or a
// server module that reached for something the browser does not have, was found by the browser suite at best.
//
// This bundles the CURRENT sources exactly as scripts/build-local.js does (scripts/kernel-build-options.js),
// loads the bundle in Node with sql.js and the few browser APIs it needs (WebCrypto and fetch are Node's own;
// IndexedDB and Web Storage are small in-memory stand-ins below), and drives one representative flow through
// SUDS_LOCAL.handle — sign up (SUDS on this device), sign in, a client, a visit, a note, a consent, a referral
// that discloses under it, the funder report for internal use — then runs the same flow against the office
// server's API and requires the same answers.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-kernel-parity-'));
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

let L;
before(async () => {
  // Bundle the current sources (not the committed public/local/kernel.js, which may lag them until
  // `npm run build:local`) the way the build script does.
  const outfile = path.join(tmp, 'kernel.mjs');
  await require('esbuild').build(require('../scripts/kernel-build-options').kernelBuildOptions(outfile));

  const wasm = fs.readFileSync(path.join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
  const realFetch = globalThis.fetch;
  Object.assign(globalThis, {
    window: globalThis, localStorage: storage(), sessionStorage: storage(), indexedDB: fakeIndexedDB(),
    IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) },
    // No BroadcastChannel: the kernel then skips the cross-window hand-over (one "window" here), and no
    // channel holds the test process open.
    BroadcastChannel: undefined,
    SUDS_STATIC_HOST: true, // SUDS on this device (the published web app): Sign up creates the account
    fetch: (url, opts) => (String(url) === WASM_URL ? Promise.resolve(new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } })) : realFetch(url, opts)),
  });
  // The kernel's timers (heartbeat, idle lock) are for a page that lives on; here they must not keep the
  // process alive after the last test.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...a) => { const t = realSetInterval(...a); if (t && t.unref) t.unref(); return t; };

  const kernel = await import(pathToFileURL(outfile).href);
  L = await kernel.start({ wasmUrl: WASM_URL });

  await H.start();
  // A new device database is a harm-reduction programme (server/programme.js DEFAULT_PROFILE); the office
  // server is given the same profile so the two answer under the same module switches.
  H.db.setSetting('programme_profile', require('../server/programme').DEFAULT_PROFILE);
});
after(async () => { await H.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

const kernelCall = async (method, p, body) => { const r = await L.handle(method, p, body); return { status: r.status, data: r.json !== undefined ? r.json : r.body }; };

// One flow, written once, run against both. Returns what the two must agree on.
async function flow(call) {
  const out = {};
  const expectStatus = (r, s, what) => { assert.equal(r.status, s, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
  const client = expectStatus(await call('POST', '/api/clients', { first_name: 'Parity', last_name: 'Client', dob: '1985-03-02', phone: '(555) 010-0177', primary_substance: 'opioids_fentanyl', risk_level: 'high', status: 'active', intake_date: '2026-08-01' }), 201, 'create client');
  const gotBody = expectStatus(await call('GET', `/api/clients/${client.id}`), 200, 'read client'); const got = gotBody.client || gotBody;
  out.client = { first_name: got.first_name, last_name: got.last_name, dob: got.dob, phone: got.phone, risk_level: got.risk_level, status: got.status, primary_substance: got.primary_substance, code_shape: String(got.client_code).replace(/\d/g, '9').replace(/^[A-Z]/, 'X') }; // a device numbers its clients M…, the office C…, by design
  const visit = expectStatus(await call('POST', '/api/interventions', { client_id: client.id, type: 'naloxone_distribution', occurred_at: '2026-08-02T15:00:00.000Z', duration_minutes: 20, naloxone_kits: 2, summary: 'Two kits at the library' }), 201, 'log visit');
  const visits = expectStatus(await call('GET', `/api/interventions?client_id=${client.id}`), 200, 'list visits');
  const v = (visits.interventions || visits.rows || visits).find((x) => x.id === visit.id);
  out.visit = { type: v.type, naloxone_kits: v.naloxone_kits, duration_minutes: v.duration_minutes, summary: v.summary, occurred_at: v.occurred_at };
  const note = expectStatus(await call('POST', '/api/notes', { client_id: client.id, kind: 'admin', title: 'Follow-up', content: 'Asked about MAT; prefers texts.', occurred_at: '2026-08-02T15:30:00.000Z' }), 201, 'write note');
  const noteBody = expectStatus(await call('GET', `/api/notes/${note.id}`), 200, 'read note'); const n = noteBody.note || noteBody;
  out.note = { kind: n.kind, title: n.title, content: n.content, status: n.status };
  const consent = expectStatus(await call('POST', `/api/clients/${client.id}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT referral', signed_at: '2026-08-01', scope: 'Referral summary and MAT status', expires_at: '2027-08-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true }), 201, 'record consent');
  const resource = expectStatus(await call('POST', '/api/resources', { name: 'County OTP', category: 'mat_otp', phone: '555-0199', accepts_medicaid: true }), 201, 'add resource');
  const noConsent = await call('POST', '/api/referrals', { client_id: client.id, resource_id: resource.id, referred_at: '2026-08-03T09:00:00.000Z', urgency: 'urgent', warm_handoff: true });
  out.refusedWithoutConsent = noConsent.status;
  const referral = expectStatus(await call('POST', '/api/referrals', { client_id: client.id, resource_id: resource.id, referred_at: '2026-08-03T09:00:00.000Z', urgency: 'urgent', warm_handoff: true, consent_id: consent.id }), 201, 'refer');
  const acc = expectStatus(await call('GET', `/api/clients/${client.id}/disclosures/accounting`), 200, 'accounting of disclosures');
  const rows = acc.disclosures || acc.rows || acc;
  out.accounting = rows.map((d) => ({ recipient: d.recipient, consent: d.consent_id === consent.id, source: d.source, referral: d.source_ref === referral.id }));
  const report = expectStatus(await call('GET', '/api/reports/funder?from=2026-08-01&to=2026-08-31&purpose=internal'), 200, 'funder report (internal)');
  out.funder = strip(report);
  // And with exact counts (the programme's own submission): with one client every internal count is "<11".
  out.funderExact = strip(expectStatus(await call('GET', '/api/reports/funder?from=2026-08-01&to=2026-08-31&purpose=submission&counts=exact'), 200, 'funder report (exact)'));
  return out;
}
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

test('the browser kernel (sql.js and the shims) answers a representative flow exactly as the office server does', async () => {
  // SUDS on this device: the first Sign up creates the device's account, then it signs in.
  const signup = await kernelCall('POST', '/api/local/signup', { display_name: 'Parity Admin', username: 'parity', password: 'ParityPassw0rd!x', role: 'admin', storage_ack: true });
  assert.equal(signup.status, 200, JSON.stringify(signup.data));
  const login = await kernelCall('POST', '/api/auth/login', { username: 'parity', password: 'ParityPassw0rd!x' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const device = await flow(kernelCall);

  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  const office = await flow((m, p, b) => admin.req(m, p, b));

  if (process.env.PARITY_DEBUG) console.log(JSON.stringify({ device, office }, null, 1));
  assert.equal(device.refusedWithoutConsent, 400, 'a warm hand-off without consent is refused on the device too');
  assert.deepEqual(device.client, office.client, 'the client reads back the same');
  assert.deepEqual(device.visit, office.visit);
  assert.deepEqual(device.note, office.note);
  assert.deepEqual(device.accounting, office.accounting, 'the referral wrote the same accounting of disclosures');
  assert.ok(device.accounting.length >= 1 && device.accounting[0].consent);
  assert.deepEqual(device.funder, office.funder, 'the funder report (internal, suppressed) counts the same');
  assert.deepEqual(device.funderExact, office.funderExact, 'and with exact counts');
  // Not two identical empty answers: the flow's own records are in them.
  assert.equal(device.client.first_name, 'Parity'); assert.equal(device.client.dob, '1985-03-02');
  assert.equal(device.note.content, 'Asked about MAT; prefers texts.');
  assert.equal(device.funder.unduplicated.served, '<11', 'one client is a small cell for internal use');
  assert.equal(device.funderExact.unduplicated.served, 1);
  assert.equal(device.funderExact.unduplicated.with_a_referral, 1);
  assert.equal(device.funderExact.naloxone_distribution.kits, 2);
});

test('a save during the funder report does not drop its working table (sql.js export reopens the database)', async () => {
  // Found by the parity test on a loaded machine: the report keeps its served set in a TEMP table across the
  // event-loop turns it yields between phases, and a coalesced save in one of those turns (sql.js export()
  // closes and reopens the database, dropping TEMP tables) failed it with "no such table". Here a save is
  // asked for at every point where the report lets the event loop go (server/funder-report.js breathe(), which
  // is setImmediate here), instead of waiting for a busy machine to line one up.
  await L.flush({ force: true }); // nothing in flight, so the next save exports at once
  const realSetImmediate = globalThis.setImmediate;
  let turns = 0;
  globalThis.setImmediate = (f, ...a) => realSetImmediate(() => { turns++; L.flush({ force: true }).catch(() => {}); f(...a); });
  let r;
  try { r = await L.handle('GET', '/api/reports/funder?from=2026-08-01&to=2026-08-31&purpose=submission&counts=exact', null); }
  finally { globalThis.setImmediate = realSetImmediate; }
  assert.ok(turns > 0, 'the report yielded (and a save was asked for) at least once');
  assert.equal(r.status, 200, `the report survived ${turns} save attempts: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.unduplicated.served, 1);
  await L.flush({ force: true });
  assert.equal(L.isDirty(), false, 'and the deferred save still happens once the report is done');
});

test('the device database is really sql.js behind the shim, sealed in the store it was given', async () => {
  // Guard against the test passing because the kernel quietly fell back to something else: the device
  // saved its database sealed (no SQLite header in the clear) under its epoch, with the vault that opens it.
  await L.flush({ force: true });
  const stored = await new Promise((res) => {
    const r = globalThis.indexedDB.open('suds-local', 1);
    r.onsuccess = () => { const t = r.result.transaction('kv', 'readonly'); const s = t.objectStore('kv'); const k = s.getAllKeys(); const v = s.getAll(); v.onsuccess = () => res(k.result.map((key, i) => [key, v.result[i]])); };
  });
  const keys = stored.map(([k]) => k);
  assert.ok(keys.includes('epoch') && keys.includes('vault'), `store keys: ${keys.join(', ')}`);
  const image = stored.find(([k]) => String(k).startsWith('db2:'));
  assert.ok(image, 'the database image is stored under its epoch');
  const sealed = image[1];
  assert.ok(sealed && sealed.iv instanceof Uint8Array && sealed.ct instanceof Uint8Array && sealed.ct.length > 4096, 'as a sealed image (local/vault.js)');
  assert.ok(!Buffer.from(sealed.ct).includes('SQLite format 3'), 'and not in the clear');
});

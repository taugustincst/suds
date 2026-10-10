'use strict';
// 1.25.4, G2: a WebKit CI run of SUDS on this device failed a sign-in after a reload with "malformed database
// schema (audit_log) - string or blob too big". The image is sealed with AES-GCM, so a write cut short in the store
// fails authentication instead; what can reach SQLite is a valid seal over a bad image (or an engine that misreads a
// good one). Here the kernel (bundled from the current sources, run in Node: test/fixtures/kernel-harness.js) is
// handed exactly that: WebCrypto is made to seal a damaged image at sign-out, as if the image had been bad before it
// was sealed. The sign-in must then refuse plainly (503, deviceDamaged), open nothing, write nothing over the stored
// copy, keep a copy of it (with the vault that opens it) where a restore does not reach, and offer it as a file. Once
// the stored image is good again the same account signs in and the records are there.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let call;
const PW = 'Lantern-Harbor-2026!';
const IMAGE_AAD = 'suds-device-db/v1';
let damage = null; // what the next sealed save of the database image does to the image first
// An engine that fails inside itself (1.25.5, H1; WebKit: "Out of bounds memory access" at sign-in): every SQLite
// engine the kernel starts is numbered, and those up to `faultUpTo` throw that error whenever a database is opened
// on them. The kernel must ask a new engine before it calls a good image damaged.
const SQL_WASM = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.js'), 'utf8');
const OPEN_EXPORT = (/f\._sqlite3_open=\(a,b\)=>\(f\._sqlite3_open=Z\.(\w+)\)/.exec(SQL_WASM) || [])[1];
let engines = 0; let faultUpTo = 0;
function faultyEngines() {
  const wrap = (r) => {
    if (!r || !r.instance) return r;
    const n = ++engines; const real = r.instance.exports;
    const exports = { ...real, [OPEN_EXPORT]: (...a) => { if (n <= faultUpTo) throw new WebAssembly.RuntimeError('Out of bounds memory access'); return real[OPEN_EXPORT](...a); } };
    return { module: r.module, instance: { exports } };
  };
  for (const k of ['instantiate', 'instantiateStreaming']) { const real = WebAssembly[k].bind(WebAssembly); WebAssembly[k] = (...a) => real(...a).then(wrap); }
}
before(async () => {
  assert.ok(OPEN_EXPORT, 'sql.js names its sqlite3_open export as this test expects');
  faultyEngines();
  ({ L, cleanup } = await loadKernel({ staticHost: true })); call = kernelCaller(L);
  const subtle = globalThis.crypto.subtle; const real = subtle.encrypt.bind(subtle);
  subtle.encrypt = (alg, key, data) => {
    if (damage && alg && alg.additionalData && new TextDecoder().decode(alg.additionalData) === IMAGE_AAD) { data = damage(Uint8Array.from(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength))); damage = null; }
    return real(alg, key, data);
  };
});
after(async () => { if (cleanup) cleanup(); });

const store = (fn) => new Promise((res, rej) => {
  const r = globalThis.indexedDB.open('suds-local', 1);
  r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); const s = t.objectStore('kv'); let out; fn(s, (v) => { out = v; }); t.oncomplete = () => res(out); t.onabort = () => rej(t.error); };
});
const imageKey = async () => store((s, set) => { const k = s.getAllKeys(); k.onsuccess = () => set(k.result.find((x) => String(x).startsWith('db2:'))); });
const getKey = (k) => store((s, set) => { const g = s.get(k); g.onsuccess = () => set(g.result); });
const putKey = (k, v) => store((s) => { s.put(v, k); });
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const signIn = (password = PW) => call('POST', '/api/auth/login', { username: 'owner', password });
const quietly = async (fn) => { const seen = []; const e = console.error; const w = console.warn; console.error = console.warn = (...a) => seen.push(a.join(' ')); try { return { r: await fn(), seen }; } finally { console.error = e; console.warn = w; } };
const b64 = (text) => Buffer.from(text).toString('base64');
let cutShortCopy = null; // the saved copy of a genuinely damaged image, for the restore tests below

let good; // the last good sealed image, and its key
test('set-up: a device with an account and a client, signed out (locked), its sealed image stored', async () => {
  assert.equal((await call('POST', '/api/local/signup', { display_name: 'Device Owner', username: 'owner', password: PW, role: 'admin', storage_ack: true })).status, 200);
  assert.equal((await signIn()).status, 200);
  assert.equal((await call('POST', '/api/clients', { first_name: 'Kept', last_name: 'Record', status: 'active' })).status, 201);
  await call('POST', '/api/auth/logout', {});
  assert.equal(L.phase(), 'locked');
  const key = await imageKey(); good = { key, value: await getKey(key) };
  assert.ok(good.value && good.value.ct, 'a sealed image is stored');
  assert.equal(await L.damagedCopy(), null, 'no damaged copy on a healthy device');
});

// Each: what is done to the image before it is sealed, and what the refusal must say was found.
const cases = [
  ['cut short to half its length', (b) => b.slice(0, Math.floor(b.length / 2 / 4096) * 4096 + 1000), /not a whole number of 4096-byte pages/],
  ['cut short at a page boundary (the header still counts every page)', (b) => b.slice(0, b.length - 4096), /the header counts \d+ pages, the image holds \d+/],
  ['a page in the middle zeroed', (b) => { const p = Math.floor(b.length / 4096 / 2); b.fill(0, p * 4096, (p + 1) * 4096); return b; }, /quick_check|malformed/],
  ['the schema page overwritten with garbage', (b) => { for (let i = 100; i < 4096; i++) b[i] = (i * 131) & 255; return b; }, /malformed|not a database|quick_check/],
  ['not a database at all', (b) => b.fill(7), /does not start with the SQLite header/],
];
for (const [what, fn, why] of cases) {
  test(`a sealed image of a damaged database (${what}) is refused plainly, kept, and never written over`, async () => {
    // A session whose sign-out seals the damaged image (WebCrypto sees the damaged bytes; the seal itself is valid).
    assert.equal((await signIn()).status, 200);
    damage = fn;
    await call('POST', '/api/auth/logout', {});
    assert.equal(damage, null, 'the sign-out sealed and stored the image');
    assert.equal(L.phase(), 'locked');
    const key = await imageKey(); const stored = await getKey(key);
    const vaultBefore = await getKey('vault');
    const errors = []; const realError = console.error; console.error = (...a) => errors.push(a.join(' '));
    let r; try { r = await signIn(); } finally { console.error = realError; }
    assert.equal(r.status, 503, JSON.stringify(r.data));
    assert.equal(r.data.deviceDamaged, true); assert.equal(r.data.locked, true);
    assert.match(r.data.error, /could not be opened/); assert.match(r.data.error, /Nothing has been deleted/);
    assert.match(r.data.error, /Restore from a backup/, 'the way back is named');
    assert.match(r.data.error, /save the damaged copy.*Restore from a backup.*Start over/s, 'saving the copy comes first, Start over last');
    assert.ok(errors.some((e) => why.test(e)), `the console says what was found: ${errors.join(' / ')}`);
    assert.equal(L.phase(), 'locked', 'nothing was opened');
    assert.equal((await call('GET', '/api/clients')).status, 401, 'no request reaches a database');
    // Nothing written over: the stored image and the vault are exactly as they were.
    assert.equal(await imageKey(), key); assert.ok(same((await getKey(key)).ct, stored.ct), 'the stored image is untouched');
    assert.deepStrictEqual(await getKey('vault'), vaultBefore);
    // A copy is kept under its own key, with the vault that opens it, and is offered as a file.
    const kept = await getKey('damaged_db');
    assert.ok(kept && same(kept.image.ct, stored.ct) && same(kept.image.iv, stored.iv), 'the damaged copy is kept');
    assert.deepStrictEqual(kept.vault, vaultBefore); assert.match(kept.why, why);
    const text = await L.damagedCopy(); if (!cutShortCopy) cutShortCopy = text;
    const file = JSON.parse(text);
    assert.equal(file.format, 'suds-damaged-device-db');
    assert.ok(same(Buffer.from(file.image.ct.b64, 'base64'), stored.ct), 'the saved file holds the damaged image');
    // Asked again, the answer is the same and still nothing changes (a person tries twice).
    assert.equal((await signIn()).status, 503);
    assert.ok(same((await getKey(key)).ct, stored.ct));
    // The good image back under the same key (what a restore puts back): the same account signs in, records intact.
    await putKey(key, good.value);
    assert.equal((await signIn()).status, 200, 'with a good image the device opens again');
    assert.equal(L.phase(), 'open');
    const list = (await call('GET', '/api/clients')).data; assert.ok(list.clients.some((c) => c.last_name === 'Record'), 'the client is there');
    await call('POST', '/api/auth/logout', {});
    good = { key: await imageKey(), value: await getKey(await imageKey()) };
  });
}

// 1.25.5, H2: a flipped byte in the stored seal (a torn or altered write) fails AES-GCM. It is damage like the above:
// refused with 503, the copy kept and offered, said as an integrity failure; a wrong password stays a wrong password.
test('an image whose seal no longer checks is refused as damaged (integrity), and a wrong password is still a wrong password', async () => {
  const key = await imageKey(); const stored = await getKey(key);
  const flipped = { ...stored, ct: Uint8Array.from(stored.ct) }; flipped.ct[Math.floor(flipped.ct.length / 2)] ^= 1;
  await putKey(key, flipped);
  const wrong = await signIn('Not-The-Password-2026!');
  assert.equal(wrong.status, 401); assert.ok(!wrong.data.deviceDamaged, 'a wrong password is not "damaged"'); assert.match(wrong.data.error, /incorrect/);
  const { r, seen } = await quietly(() => signIn());
  assert.equal(r.status, 503, JSON.stringify(r.data));
  assert.equal(r.data.deviceDamaged, true); assert.equal(r.data.integrity, true);
  assert.match(r.data.error, /failed its integrity check/); assert.match(r.data.error, /Nothing has been deleted/);
  assert.ok(seen.some((x) => /could not be decrypted/.test(x)), seen.join(' / '));
  assert.equal(L.phase(), 'locked');
  assert.ok(same((await getKey('damaged_db')).image.ct, flipped.ct), 'the altered image is kept');
  assert.ok(same(Buffer.from(JSON.parse(await L.damagedCopy()).image.ct.b64, 'base64'), flipped.ct), 'and offered as a file');
  await putKey(key, stored);
  assert.equal((await signIn()).status, 200, 'the good image opens again');
  await call('POST', '/api/auth/logout', {});
});

// 1.25.5, H1: the engine, not the image. One engine that fails: a new one is asked and the sign-in goes through, and
// nothing is kept as damaged. Every engine failing: the records are called damaged, first as "may be this browser".
test('a good image that one engine fails on is opened on a new engine; nothing is called damaged', async () => {
  const keptBefore = await getKey('damaged_db');
  faultUpTo = engines;
  let out; try { out = await quietly(() => signIn()); } finally { faultUpTo = 0; }
  assert.equal(out.r.status, 200, JSON.stringify(out.r.data));
  assert.ok(out.seen.some((x) => /trying once more on a new SQLite engine: .*Out of bounds memory access/.test(x)), out.seen.join(' / '));
  assert.ok(engines > 1, 'a new engine was started');
  assert.ok(same((await getKey('damaged_db')).image.ct, keptBefore.image.ct), 'no new damaged copy was kept');
  assert.ok((await call('GET', '/api/clients')).data.clients.some((c) => c.last_name === 'Record'));
  await call('POST', '/api/auth/logout', {});
  assert.equal((await signIn()).status, 200, 'and the next sign-in works on the new engine');
  await call('POST', '/api/auth/logout', {});
});

let goodCopy = null; // the copy kept when every engine failed on a good image
test('when every engine fails, the records are called damaged: first "this may be this browser", then not', async () => {
  faultUpTo = Infinity;
  try {
    let { r, seen } = await quietly(() => signIn());
    assert.equal(r.status, 503, JSON.stringify(r.data)); assert.equal(r.data.deviceDamaged, true); assert.equal(r.data.repeated, false);
    assert.match(r.data.error, /This may be this browser rather than the records/);
    assert.match(r.data.error, /save the damaged copy, then close the browser completely and log in again\. If it still does not open, use Restore from a backup/);
    assert.ok(seen.some((x) => /would not open: Out of bounds memory access/.test(x)), seen.join(' / '));
    goodCopy = await L.damagedCopy();
    ({ r } = await quietly(() => signIn()));
    assert.equal(r.status, 503); assert.equal(r.data.repeated, true);
    assert.match(r.data.error, /could not be opened again: the copy stored in this browser is damaged/); assert.doesNotMatch(r.data.error, /may be this browser/);
  } finally { faultUpTo = 0; }
  assert.equal(L.phase(), 'locked');
  assert.equal((await signIn()).status, 200, 'with a working engine the same image opens');
});

// 1.25.5, H1: Restore from a backup takes the saved copy. One that opens (the engine misread a good image) brings the
// records back; one that is damaged, altered or opened with a wrong password is refused whole and nothing changes.
test('Restore from a backup takes a saved damaged copy: a sound one comes back, a damaged one is refused whole', async () => {
  assert.equal(L.phase(), 'open');
  const restore = (text, passphrase, confirm) => call('POST', confirm ? '/api/local/restore' : '/api/local/restore/preview', { file_b64: b64(text), passphrase, ...(confirm ? { confirm } : {}) });
  const clientsBefore = (await call('GET', '/api/clients')).data.clients.length;
  let r = await restore(goodCopy, 'Not-The-Password-2026!');
  assert.equal(r.status, 400); assert.equal(r.data.backupError, 'passphrase'); assert.match(r.data.error, /password of an account/);
  ({ r } = await quietly(() => restore(cutShortCopy, PW)));
  assert.equal(r.status, 400, JSON.stringify(r.data)); assert.equal(r.data.backupError, 'tampered'); assert.match(r.data.error, /damaged here too/);
  ({ r } = await quietly(() => restore(cutShortCopy, PW, 'RESTORE')));
  assert.equal(r.status, 400, 'nor restored');
  const altered = JSON.parse(goodCopy); const ct = Buffer.from(altered.image.ct.b64, 'base64'); ct[100] ^= 1; altered.image.ct.b64 = ct.toString('base64');
  r = await restore(JSON.stringify(altered), PW);
  assert.equal(r.status, 400); assert.match(r.data.error, /changed since it was saved/);
  assert.equal((await restore('{"format":"suds-damaged-device-db","image":null}', PW)).status, 400, 'an incomplete one');
  assert.equal(L.phase(), 'open'); assert.equal((await call('GET', '/api/clients')).data.clients.length, clientsBefore, 'nothing changed');
  r = await restore(goodCopy, PW);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.damaged_copy, true); assert.ok(r.data.clients >= 1);
  r = await restore(goodCopy, PW, 'RESTORE');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await signIn()).status, 200, 'an account from the copy signs in with its password');
  assert.ok((await call('GET', '/api/clients')).data.clients.some((c) => c.last_name === 'Record'), 'and the records are back');
  assert.equal(L.rekeyPending(), false, 'the device moved to a key of its own at that sign-in');
  const a = (await call('GET', '/api/admin/audit?action=device.restore')).data;
  assert.ok(a.rows.some((x) => x.details && x.details.from === 'damaged_copy'), 'the restore is audited as from the saved copy');
  await call('POST', '/api/auth/logout', {});
  assert.equal((await signIn()).status, 200, 'and signs in again after a sign-out');
  await call('POST', '/api/auth/logout', {});
});

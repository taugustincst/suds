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
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let call;
const PW = 'Lantern-Harbor-2026!';
const IMAGE_AAD = 'suds-device-db/v1';
let damage = null; // what the next sealed save of the database image does to the image first
before(async () => {
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
const signIn = () => call('POST', '/api/auth/login', { username: 'owner', password: PW });

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
    const file = JSON.parse(await L.damagedCopy());
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

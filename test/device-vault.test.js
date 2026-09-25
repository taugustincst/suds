'use strict';
// The on-device encryption-at-rest helpers (local/vault.js, docs/architecture/ADR-0008-device-encryption.md),
// run under Node's WebCrypto (globalThis.crypto.subtle) — the same API the browser kernel uses.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let V;
// local/ is ES modules bundled for the browser, in a CommonJS package: loaded as a module from its source.
before(async () => { V = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '..', 'local', 'vault.js')).toString('base64')); });

const sqliteLike = (n = 4096) => { const b = new Uint8Array(n); b.set(new TextEncoder().encode('SQLite format 3\0')); for (let i = 16; i < n; i++) b[i] = i & 255; return b; };
const ascii = (u8) => Buffer.from(u8).toString('latin1');

test('a sealed image holds no SQLite header or plaintext, and opens only with its key', async () => {
  const dek = V.newDek(); const key = await V.importDek(dek);
  const plain = sqliteLike(); new TextEncoder().encodeInto('Client Name Zebedee', plain.subarray(100));
  const sealed = await V.seal(key, plain);
  assert.ok(V.isSealed(sealed));
  assert.ok(!V.isPlainSqlite(sealed.ct));
  assert.ok(!ascii(sealed.ct).includes('SQLite format 3') && !ascii(sealed.ct).includes('Zebedee'));
  assert.deepStrictEqual(await V.open(key, sealed), plain);
  // Another key, or one flipped bit, is refused (GCM authenticates the image).
  await assert.rejects(V.open(await V.importDek(V.newDek()), sealed), (e) => e.code === 'tampered');
  const bent = { ...sealed, ct: Uint8Array.from(sealed.ct) }; bent.ct[10] ^= 1;
  await assert.rejects(V.open(key, bent), (e) => e.code === 'tampered');
  // Two seals of the same image never repeat an IV.
  const again = await V.seal(key, plain);
  assert.notDeepStrictEqual(again.iv, sealed.iv);
});

test('the synchronous seal (the unload path) produces the same format', async () => {
  const { gcm } = await import('@noble/ciphers/aes');
  const dek = V.newDek(); const key = await V.importDek(dek);
  const plain = sqliteLike(10000);
  const sealed = V.sealSync(gcm, dek, plain);
  assert.ok(V.isSealed(sealed));
  assert.deepStrictEqual(await V.open(key, sealed), plain, 'WebCrypto opens what the synchronous path sealed');
});

test('the DEK is wrapped per account under PBKDF2-SHA-256 (600,000 iterations) and unwraps only with that password', async () => {
  const dek = V.newDek(); const key = await V.importDek(dek);
  let v = await V.create(key, { enc: 'a'.repeat(64), idx: 'b'.repeat(64) });
  assert.equal(v.iterations, 600000);
  assert.ok(v.iterations >= 600000);
  v = V.withWrap(v, await V.wrapDek(dek, 'Correct-Horse-1', { userId: 'u1', name: await V.nameHash(v.salt, 'Alice') }));
  v = V.withWrap(v, await V.wrapDek(dek, 'Other-Person-22', { userId: 'u2', name: await V.nameHash(v.salt, 'bob') }));
  assert.equal(v.wraps.length, 2);
  assert.ok(!JSON.stringify(v).includes('Alice') && !JSON.stringify(v).toLowerCase().includes('alice'), 'the vault does not store usernames');
  for (const w of v.wraps) assert.ok(!Buffer.from(w.ct).equals(Buffer.from(dek)), 'the DEK is never stored as it is');
  assert.notDeepStrictEqual(v.wraps[0].salt, v.wraps[1].salt, 'each wrap has its own salt');
  // Either account unlocks the same DEK; the username is matched without regard to case.
  const a = await V.unlock(v, 'alice', 'Correct-Horse-1'); assert.ok(a); assert.deepStrictEqual(a.dek, dek);
  const b = await V.unlock(v, 'BOB', 'Other-Person-22'); assert.ok(b); assert.deepStrictEqual(b.dek, dek);
  assert.equal(await V.unlock(v, 'alice', 'Other-Person-22'), null, 'another account\'s password does not open this account\'s wrap');
  assert.equal(await V.unlock(v, 'alice', 'wrong'), null);
  assert.equal(await V.unlock(v, 'nobody', 'Correct-Horse-1'), null);
  // Re-wrapping (a password change) replaces the account's wrap: the old password stops working.
  v = V.withWrap(v, await V.wrapDek(dek, 'New-Password-333', { userId: 'u1', name: await V.nameHash(v.salt, 'alice') }));
  assert.equal(v.wraps.length, 2);
  assert.equal(await V.unlock(v, 'alice', 'Correct-Horse-1'), null);
  assert.ok(await V.unlock(v, 'alice', 'New-Password-333'));
  // A vault that claims a silly iteration count is refused rather than hanging the page.
  const bad = { ...v, wraps: v.wraps.map(w => ({ ...w, iterations: 1000 })) };
  await assert.rejects(V.unlock(bad, 'alice', 'New-Password-333'), (e) => e.code === 'tampered');
});

test('the column keys are sealed under the DEK', async () => {
  const dek = V.newDek(); const key = await V.importDek(dek);
  const keys = { enc: '0123456789abcdef'.repeat(4), idx: 'fedcba9876543210'.repeat(4) };
  const v = await V.create(key, keys);
  assert.ok(!JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x)).includes(keys.enc));
  assert.deepStrictEqual(await V.openKeys(key, v.keys), keys);
  await assert.rejects(V.openKeys(await V.importDek(V.newDek()), v.keys));
});

test('a backup carries the accounts\' wraps and a fresh key for the restored device, never this device\'s key', async () => {
  const dek = V.newDek(); const key = await V.importDek(dek);
  const keys = { enc: '1'.repeat(64), idx: '2'.repeat(64) };
  let v = await V.create(key, keys);
  v = V.withWrap(v, await V.wrapDek(dek, 'Owner-Password-1', { userId: 'u1', name: await V.nameHash(v.salt, 'owner') }));
  v = V.withWrap(v, await V.wrapDek(dek, 'Second-Password-2', { userId: 'u2', name: await V.nameHash(v.salt, 'second') }));
  const next = V.newDek();
  const rec = await V.backupRecord(v, key, next);
  const text = JSON.stringify(rec);
  assert.ok(!text.includes(Buffer.from(dek).toString('hex')) && !text.includes(Buffer.from(dek).toString('base64')), 'this device\'s DEK is not in the backup');
  // Restored elsewhere: both accounts open the new device's key with their passwords, through the chain.
  const r = await V.fromBackupRecord(JSON.parse(text), keys, { users: 2 });
  assert.deepStrictEqual(r.dek, next);
  assert.ok(r.vault.chain && r.vault.wraps.every(w => w.chained));
  for (const [u, p] of [['owner', 'Owner-Password-1'], ['second', 'Second-Password-2']]) {
    const got = await V.unlock(r.vault, u, p);
    assert.ok(got, `${u} unlocks the restored device`);
    assert.deepStrictEqual(got.dek, next);
  }
  assert.equal(await V.unlock(r.vault, 'owner', 'Second-Password-2'), null);
  assert.deepStrictEqual(await V.openKeys(r.key, r.vault.keys), keys);
  // Each account's first sign-in replaces its carried wrap with its own; the chain goes with the last one.
  let rv = V.withWrap(r.vault, await V.wrapDek(r.dek, 'Owner-Password-1', { userId: 'u1', name: await V.nameHash(r.vault.salt, 'owner') }));
  assert.ok(rv.chain);
  rv = V.withWrap(rv, await V.wrapDek(r.dek, 'Second-Password-2', { userId: 'u2', name: await V.nameHash(r.vault.salt, 'second') }));
  assert.ok(!rv.chain && rv.wraps.every(w => !w.chained));
  assert.deepStrictEqual((await V.unlock(rv, 'second', 'Second-Password-2')).dek, next);
  assert.equal(await V.fromBackupRecord(undefined, keys), null, 'a backup from before encryption at rest carries none');
});

test('plaintext detection finds a database stored in the clear, in any binary form', () => {
  const plain = sqliteLike();
  assert.ok(V.isPlainSqlite(plain));
  assert.ok(V.isPlainSqlite(plain.buffer));
  assert.ok(V.isPlainSqlite(Buffer.from(plain)));
  assert.ok(!V.isPlainSqlite({ format: 'suds-sealed-db', iv: new Uint8Array(12), ct: new Uint8Array(4) }));
  assert.deepStrictEqual(V.plaintextLeft([['db', plain], ['db2:1', { format: 'x' }], ['epoch', 5]]), ['db']);
  assert.deepStrictEqual(V.plaintextLeft([['epoch', 5]]), []);
});

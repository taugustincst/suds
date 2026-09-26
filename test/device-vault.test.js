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

// 1.12.0 defect: the restored device's key (`next_dek`) travels inside the backup, so whoever held the backup
// and its passphrase and later got the device's browser storage could read everything recorded after the
// restore. The first sign-in after a restore now moves the device to a key the backup never held.
test('the first sign-in after a restore moves the device to a key the backup never held, and no account is locked out', async () => {
  const dek0 = V.newDek(); const key0 = await V.importDek(dek0);
  const keys = { enc: '3'.repeat(64), idx: '4'.repeat(64) };
  let v = await V.create(key0, keys);
  v = V.withWrap(v, await V.wrapDek(dek0, 'Owner-Password-1', { userId: 'u1', name: await V.nameHash(v.salt, 'owner') }));
  v = V.withWrap(v, await V.wrapDek(dek0, 'Second-Password-2', { userId: 'u2', name: await V.nameHash(v.salt, 'second') }));
  const rec = JSON.parse(JSON.stringify(await V.backupRecord(v, key0, V.newDek())));
  const known = Uint8Array.from(Buffer.from(rec.next_dek, 'hex')); // what the backup's holder knows
  const r = await V.fromBackupRecord(rec, keys, { users: 3 });
  assert.equal(r.vault.rekey, 'restore', 'a restored vault is marked: its key is written in the backup');
  // Someone enrolled on the restored device before any backed-up account signed in (vouched for, say): a wrap
  // of the key the backup holds.
  const rv = V.withWrap(r.vault, await V.wrapDek(r.dek, 'Third-Password-3', { userId: 'u3', name: await V.nameHash(r.vault.salt, 'third') }));
  assert.ok(rv.chain, 'the carried wraps still need the chain');

  assert.equal(await V.rekeyAfterRestore(rv, r.dek, 'owner', 'wrong password', { userId: 'u1', keys }), null, 'a wrong password rotates nothing');
  assert.equal(await V.rekeyAfterRestore(rv, r.dek, 'third', 'Third-Password-3', { userId: 'u3', keys }), null, 'an account with no carried wrap cannot rotate (it cannot reach the backed-up device\'s key)');
  const out = await V.rekeyAfterRestore(rv, r.dek, 'owner', 'Owner-Password-1', { userId: 'u1', keys });
  assert.ok(out, 'the backed-up owner\'s first sign-in rotates the key');
  assert.notDeepStrictEqual(out.dek, known, 'to a key that is not the one in the backup');
  assert.ok(!out.vault.rekey, 'and the mark is cleared');
  // Nothing in the new vault, nor an image sealed under the new key, opens with the key the backup holds.
  const knownKey = await V.importDek(known);
  await assert.rejects(V.openKeys(knownKey, out.vault.keys));
  assert.deepStrictEqual(await V.openKeys(out.key, out.vault.keys), keys);
  const image = await V.seal(out.key, sqliteLike());
  await assert.rejects(V.open(knownKey, image));
  await assert.rejects(V.open(knownKey, { format: 'suds-sealed-db', version: 1, iv: out.vault.chain.iv, ct: out.vault.chain.ct }, 'suds-device-dek-chain/v1'), 'the chain is not sealed under the backup\'s key either');
  // The owner opens the new key with an ordinary wrap; the second backed-up account, which has not signed in
  // yet, still reaches it with the password it had (its wrap -> the backed-up device's key -> the new chain).
  const o = await V.unlock(out.vault, 'owner', 'Owner-Password-1'); assert.deepStrictEqual(o.dek, out.dek); assert.ok(!o.wrap.chained);
  const s = await V.unlock(out.vault, 'second', 'Second-Password-2'); assert.deepStrictEqual(s.dek, out.dek);
  // The wrap made before the rotation opened the backup's key: it is dropped, and that account is vouched for next time.
  assert.equal(await V.unlock(out.vault, 'third', 'Third-Password-3'), null);
  assert.deepStrictEqual(out.dropped, ['u3']);
  // The vault remembers which account was dropped (by its salted username hash, as a wrap is looked up), so
  // its next sign-in can be told what happened rather than "Username or password is incorrect".
  assert.equal(await V.droppedAfterRestore(out.vault, 'third'), true, 'the dropped account is recognised by its username');
  assert.equal(await V.droppedAfterRestore(out.vault, 'THIRD'), true, 'whatever its case');
  assert.equal(await V.droppedAfterRestore(out.vault, 'owner'), false);
  assert.equal(await V.droppedAfterRestore(out.vault, 'nobody'), false, 'an unknown username is not');
  assert.ok(!JSON.stringify(out.vault.dropped_after_restore).includes('third'), 'no username is stored in the clear');
  // Once someone vouches for it again it has a wrap under the new key, and is no longer marked dropped.
  const back = V.withWrap(out.vault, await V.wrapDek(out.dek, 'Third-Password-3', { userId: 'u3', name: await V.nameHash(out.vault.salt, 'third') }));
  assert.equal(await V.droppedAfterRestore(back, 'third'), false);
  assert.ok(!back.dropped_after_restore || !back.dropped_after_restore.length);
  // The second account's first sign-in gives it its own wrap; the chain goes with the last carried wrap.
  const done = V.withWrap(out.vault, await V.wrapDek(out.dek, 'Second-Password-2', { userId: 'u2', name: await V.nameHash(out.vault.salt, 'second') }));
  assert.ok(!done.chain && done.wraps.every(w => !w.chained));
  assert.equal(await V.rekeyAfterRestore(done, out.dek, 'second', 'Second-Password-2', { userId: 'u2', keys }), null, 'once rotated, never again');
});

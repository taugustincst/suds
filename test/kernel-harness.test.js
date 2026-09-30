'use strict';
// The IndexedDB stand-in the kernel tests run on (test/fixtures/kernel-harness.js) must keep the one guarantee
// the kernel's saves rely on: readwrite transactions run one after another, each seeing what the ones before
// it committed. The stand-in used to copy the store when a transaction was CREATED, so a database save created
// just before a vault write and run just after it put the old vault back, and device-recovery.test.js failed
// now and then under load (the node24 job of 1.18.0).
const { test } = require('node:test');
const assert = require('node:assert');
const { fakeIndexedDB } = require('./fixtures/kernel-harness');

const open = (idb) => new Promise((res) => {
  const r = idb.open('suds-local', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
});
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error); });
const read = (d, key) => new Promise((res) => { const g = d.transaction('kv', 'readwrite').objectStore('kv').get(key); g.onsuccess = () => res(g.result); });

test('two transactions created before either runs both land: the later one does not write back a stale copy', async () => {
  const d = await open(fakeIndexedDB());
  await done((() => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put({ wraps: ['owner'] }, 'vault'); return t; })());
  // As the kernel does: a vault write, and a coalesced save of the database image started meanwhile.
  const vaultTx = d.transaction('kv', 'readwrite'); vaultTx.objectStore('kv').put({ wraps: ['owner', 'nav'] }, 'vault');
  const imageTx = d.transaction('kv', 'readwrite'); imageTx.objectStore('kv').put('sealed-image', 'db2:1');
  await Promise.all([done(vaultTx), done(imageTx)]);
  assert.deepStrictEqual(await read(d, 'vault'), { wraps: ['owner', 'nav'] }, 'the vault write survives the image save created after it');
  assert.equal(await read(d, 'db2:1'), 'sealed-image');
  // And the other way round: an image save created first, then a vault write.
  const imageTx2 = d.transaction('kv', 'readwrite'); imageTx2.objectStore('kv').put('sealed-image-2', 'db2:1');
  const vaultTx2 = d.transaction('kv', 'readwrite'); vaultTx2.objectStore('kv').put({ wraps: ['owner', 'nav', 'third'] }, 'vault');
  await Promise.all([done(imageTx2), done(vaultTx2)]);
  assert.equal(await read(d, 'db2:1'), 'sealed-image-2', 'the image save survives the vault write created after it');
  assert.deepStrictEqual(await read(d, 'vault'), { wraps: ['owner', 'nav', 'third'] });
});

test('a transaction reads what an earlier one committed, even if it was created before that one ran', async () => {
  const d = await open(fakeIndexedDB());
  const w = d.transaction('kv', 'readwrite'); w.objectStore('kv').put(7, 'epoch');
  const r = d.transaction('kv', 'readwrite'); const g = r.objectStore('kv').get('epoch');
  await Promise.all([done(w), done(r)]);
  assert.equal(g.result, 7);
});

test('an aborted transaction changes nothing, and does not undo the one before it', async () => {
  const d = await open(fakeIndexedDB());
  const w = d.transaction('kv', 'readwrite'); w.objectStore('kv').put('kept', 'a');
  const x = d.transaction('kv', 'readwrite'); x.objectStore('kv').put('dropped', 'b');
  const g = x.objectStore('kv').get('a'); g.onsuccess = () => x.abort();
  await done(w); await assert.rejects(done(x));
  assert.equal(await read(d, 'a'), 'kept'); assert.equal(await read(d, 'b'), undefined);
});

'use strict';
// Client-record PHI is bound to its cell (independent evaluation, item 2): each encrypted client column is
// sealed as a v2 AES-GCM payload whose AAD is its table|column|id, so a ciphertext moved to another row or
// column no longer decrypts. These tests cover the crypto primitive, the clients-model read/write, the merge
// re-seal, the end-to-end create/read, and the v1->v2 operation migration 76 performs.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const crypto = require('../server/crypto');
const M = require('../server/clients-model');

let admin;
before(async () => { await H.start(); admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x'); });
after(async () => { await H.stop(); });

test('crypto: a bound value decrypts only with its own table|column|id AAD', () => {
  const aadA = crypto.aadFor('clients', 'dob_enc', 'client-A');
  const aadB = crypto.aadFor('clients', 'dob_enc', 'client-B');
  const ct = crypto.encrypt('1990-01-01', undefined, aadA);
  assert.ok(ct.startsWith('v2:'), 'an AAD makes a v2 payload');
  assert.equal(crypto.decrypt(ct, undefined, aadA), '1990-01-01', 'opens in its own cell');
  assert.throws(() => crypto.decrypt(ct, undefined, aadB), /unable to authenticate|bad decrypt|auth/i, 'not in another row');
  assert.throws(() => crypto.decrypt(ct, undefined, null), /bound to its row and column/, 'not with no binding at all');
});

test('crypto.boundAad: only the listed client columns are bound, and only with an id', () => {
  assert.equal(crypto.boundAad('clients', 'dob_enc', 'id1'), crypto.aadFor('clients', 'dob_enc', 'id1'));
  assert.equal(crypto.boundAad('clients', 'dob_enc', null), null, 'no id -> no binding (stays v1)');
  assert.equal(crypto.boundAad('clients', 'participant_code_enc', 'id1'), null, 'participant_code is not a bound column');
  assert.equal(crypto.boundAad('interventions', 'summary_enc', 'id1'), null, 'another table is not bound');
});

test('clients-model: encryptFields binds to the id and decryptRow needs the same id', () => {
  const cols = M.encryptFields({ dob: '1988-07-02', phone: '5551234567' }, 'the-client');
  assert.ok(cols.dob_enc.startsWith('v2:') && cols.phone_enc.startsWith('v2:'), 'written bound');
  const row = { id: 'the-client', dob_enc: cols.dob_enc, phone_enc: cols.phone_enc };
  assert.equal(M.decryptRow(row).dob, '1988-07-02', 'reads back with the right id');
  assert.throws(() => M.decryptRow({ id: 'someone-else', dob_enc: cols.dob_enc }), /auth|bad decrypt|unable/i, 'the wrong id cannot read it');
  assert.throws(() => M.decryptRow({ dob_enc: cols.dob_enc }), /bound to its row and column/, 'no id cannot read it');
});

test('crypto.reseal moves a bound value from one cell to another', () => {
  const ct = crypto.encrypt('secret@example.org', undefined, crypto.boundAad('clients', 'email_enc', 'from-id'));
  const moved = crypto.reseal(ct, 'clients', 'email_enc', 'from-id', 'to-id');
  assert.equal(crypto.decrypt(moved, undefined, crypto.boundAad('clients', 'email_enc', 'to-id')), 'secret@example.org');
  assert.throws(() => crypto.decrypt(moved, undefined, crypto.boundAad('clients', 'email_enc', 'from-id')), /auth|bad decrypt|unable/i);
  assert.equal(crypto.reseal(null, 'clients', 'email_enc', 'from-id', 'to-id'), null, 'a null stays null');
});

test('migration 76 operation: a v1 client value re-seals to v2, bound to its id, same plaintext', () => {
  const v1 = crypto.encrypt('123 Main St', undefined, null); // as written before item 2
  assert.ok(v1.startsWith('v1:'));
  const v2 = crypto.reseal(v1, 'clients', 'address_enc', null, 'row-77');
  assert.ok(v2.startsWith('v2:'));
  assert.equal(crypto.decrypt(v2, undefined, crypto.boundAad('clients', 'address_enc', 'row-77')), '123 Main St');
});

test('end to end: a created client stores bound (v2) PHI and reads back correctly', async () => {
  const r = await admin.post('/api/clients', { first_name: 'Bound', last_name: 'Client', dob: '1979-03-15', phone: '(555) 900-2000', confirm_duplicate: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const stored = H.db.one(`SELECT id, first_name_enc, last_name_enc, dob_enc, phone_enc FROM clients WHERE id=?`, r.data.id);
  for (const c of ['first_name_enc', 'last_name_enc', 'dob_enc', 'phone_enc']) assert.ok(String(stored[c]).startsWith('v2:'), `${c} is bound`);
  // Moving one client's cell into another's row makes it unreadable there: decryptRow with the other id cannot open it.
  assert.throws(() => M.decryptRow({ id: 'a-different-id', dob_enc: stored.dob_enc }), /auth|bad decrypt|unable/i);
  const got = await admin.get(`/api/clients/${r.data.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.client.dob, '1979-03-15', 'the API still returns the client\'s dob');
});

test('end to end: merging a gap-filling duplicate re-seals the moved value into the kept record', async () => {
  // Kept record has no dob; the duplicate carries one. After the merge the kept record shows the dob — only
  // possible if its ciphertext was re-sealed to the kept id (a raw copy would no longer decrypt).
  const keep = await admin.post('/api/clients', { first_name: 'Robin', last_name: 'Vega', phone: '(555) 410-0001', confirm_duplicate: true });
  const dup = await admin.post('/api/clients', { first_name: 'Robin', last_name: 'Vega', dob: '1992-12-01', confirm_duplicate: true });
  assert.equal(keep.status, 201); assert.equal(dup.status, 201);
  const merged = await admin.post(`/api/clients/${keep.data.id}/merge`, { source_id: dup.data.id });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  const kept = H.db.one(`SELECT id, dob_enc FROM clients WHERE id=?`, keep.data.id);
  assert.ok(String(kept.dob_enc).startsWith('v2:'), 'the filled dob is bound to the kept record');
  assert.equal(M.decryptRow(kept).dob, '1992-12-01', 'and decrypts to the duplicate\'s dob in its new cell');
});

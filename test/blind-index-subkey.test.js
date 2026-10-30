'use strict';
// Per-column blind-index subkeys (independent evaluation, item 4): equal values no longer share an index
// across columns, and name/dob/phone search and duplicate detection still work through the new derivation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const crypto = require('../server/crypto');
const M = require('../server/clients-model');

let admin;
before(async () => { await H.start(); admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x'); });
after(async () => { await H.stop(); });

test('blindIndex: a purpose domain-separates the hash, and no purpose is the legacy raw-key index', () => {
  assert.notEqual(crypto.blindIndex('smith', 'clients.last_name'), crypto.blindIndex('smith', 'clients.first_name'),
    'the same value hashes differently per column');
  assert.equal(crypto.blindIndex('smith', 'clients.last_name'), crypto.blindIndex('smith', 'clients.last_name'), 'deterministic');
  assert.notEqual(crypto.blindIndex('smith'), crypto.blindIndex('smith', 'clients.last_name'), 'the raw-key index differs from a purposed one');
  assert.equal(crypto.blindIndex(null, 'clients.dob'), null);
});

test('clients-model: the per-column helpers separate a value shared across columns', () => {
  // "Morgan" as a surname and as a first name no longer collide; a DOB-shaped and phone-shaped equal digit string either.
  assert.notEqual(M.idxLast('Morgan'), M.idxFirst('Morgan'));
  assert.notEqual(M.idxDob('19900101'), M.idxPhone('19900101'));
  assert.notEqual(M.idxFull('Morgan', 'Lee'), M.idxLast('MorganLee'));
});

test('a client whose surname equals another client\'s first name has distinct stored indexes, and both are still found', async () => {
  const a = await admin.post('/api/clients', { first_name: 'Dana', last_name: 'Morgan', dob: '1990-01-01', phone: '(555) 700-1000', confirm_duplicate: true });
  const b = await admin.post('/api/clients', { first_name: 'Morgan', last_name: 'Ellis', confirm_duplicate: true });
  assert.equal(a.status, 201, JSON.stringify(a.data)); assert.equal(b.status, 201, JSON.stringify(b.data));
  const ra = H.db.one(`SELECT last_name_idx, first_name_idx FROM clients WHERE id=?`, a.data.id);
  const rb = H.db.one(`SELECT last_name_idx, first_name_idx FROM clients WHERE id=?`, b.data.id);
  assert.ok(ra.last_name_idx && rb.first_name_idx);
  assert.notEqual(ra.last_name_idx, rb.first_name_idx, 'surname "Morgan" and first name "Morgan" index differently');

  // Search still works through the new derivation: surname, first name, full name, dob, phone.
  const find = async (q) => (await admin.get(`/api/clients?q=${encodeURIComponent(q)}`)).data.clients.map(c => c.id);
  assert.ok((await find('Morgan')).includes(a.data.id), 'surname search finds Dana Morgan');
  assert.ok((await find('Morgan')).includes(b.data.id), 'first-name search finds Morgan Ellis');
  assert.ok((await find('Morgan, Dana')).includes(a.data.id), 'full-name search finds Dana Morgan');
  assert.ok((await find('1990-01-01')).includes(a.data.id), 'dob search finds her');
  assert.ok((await find('5557001000')).includes(a.data.id), 'phone search finds her');

  // Duplicate detection still fires on the same full name / dob+surname / phone (a create without
  // confirm_duplicate is refused with 400 and the matches listed).
  const dup = await admin.post('/api/clients', { first_name: 'Dana', last_name: 'Morgan', dob: '1990-01-01' });
  assert.equal(dup.status, 400, JSON.stringify(dup.data));
  assert.ok((dup.data.duplicates || []).some(d => d.id === a.data.id), 'the existing Dana Morgan is flagged');
});

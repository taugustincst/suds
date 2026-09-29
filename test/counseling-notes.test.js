'use strict';
// 1.16.1, the owner's decision: a SUD counseling note (42 CFR §2.11) is read only by its author, its co-signer and
// staff who write clinical notes (notes:clinical:write). notes:clinical:read alone -- a navigator, from 1.16.0 --
// reads every other clinical note and never a counseling note, on every path that reads notes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const C = {}; const U = {};
let clientId, counsel, plain, addendum;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  for (const [k, role] of [['author', 'clinician'], ['clin2', 'clinician'], ['nav', 'navigator'], ['sup', 'supervisor'], ['admin2', 'admin']]) {
    const u = H.makeUser(`cn_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
  clientId = (await C.author.post('/api/clients', { first_name: 'Casey', last_name: 'Counsel' })).data.id;
  const at = new Date().toISOString();
  counsel = (await C.author.post('/api/notes', { client_id: clientId, kind: 'clinical', title: 'Session 4', content: 'Counseling content: processing grief', occurred_at: at, counseling_note: true })).data.id;
  plain = (await C.author.post('/api/notes', { client_id: clientId, kind: 'clinical', title: 'Progress note', content: 'Ordinary clinical content', occurred_at: at })).data.id;
  H.db.run(`UPDATE notes SET status='signed', signed_by=author_id, signed_at=? WHERE id IN (?,?)`, at, counsel, plain);
  addendum = (await C.author.post(`/api/notes/${counsel}/addenda`, { content: 'Counseling addendum', reason: 'late entry' })).data.id;
  assert.ok(counsel && plain && addendum);
});
after(() => H.stop());

test('the note itself: its author, clinical writers and a supervisor read it; a navigator does not, and is audited', async () => {
  for (const who of ['author', 'clin2', 'sup']) assert.equal((await C[who].get(`/api/notes/${counsel}`)).status, 200, who);
  const r = await C.nav.get(`/api/notes/${counsel}`);
  assert.equal(r.status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.view.denied' AND entity_id=? AND user_id=?`, counsel, U.nav));
  assert.equal((await C.nav.get(`/api/notes/${counsel}/verify`)).status, 403);
  assert.equal((await C.nav.get(`/api/notes/${plain}`)).status, 200, 'another clinical note stays readable with notes:clinical:read');
  const glass = await C.admin2.get(`/api/notes/${counsel}`, { 'X-Break-Glass-Reason': 'Client in crisis at the front desk, need the plan' });
  assert.equal(glass.status, 403, 'break-glass does not open a counseling note');
});

test('lists and the client timeline leave it out for a navigator', async () => {
  const list = (await C.nav.get(`/api/notes?client_id=${clientId}`)).data.rows.map(x => x.id);
  assert.ok(list.includes(plain)); assert.ok(!list.includes(counsel));
  assert.ok((await C.clin2.get(`/api/notes?client_id=${clientId}`)).data.rows.some(x => x.id === counsel));
  const tl = (await C.nav.get(`/api/clients/${clientId}/timeline`)).data;
  const ids = (tl.events || tl.rows || []).map(e => e.id);
  assert.ok(ids.includes(plain), JSON.stringify(Object.keys(tl))); assert.ok(!ids.includes(counsel));
});

test('a navigator\'s device is never sent it or its addenda, and one that holds it from before 1.16.1 is told to remove it', async () => {
  const pull = (await C.nav.get('/api/sync/pull')).data;
  assert.ok(pull.tables.notes.some(n => n.id === plain));
  assert.ok(!pull.tables.notes.some(n => n.id === counsel));
  assert.ok(!pull.tables.note_addenda.some(a => a.id === addendum));
  const clin = (await C.clin2.get('/api/sync/pull')).data;
  assert.ok(clin.tables.notes.some(n => n.id === counsel));
  // The key a device kept from a 1.16.0 office: no counseling part.
  const oldKey = pull.scope.split(';').filter(x => !x.startsWith('counseling=')).join(';');
  const again = (await C.nav.get(`/api/sync/pull?since=${encodeURIComponent(pull.cursor)}&scope=${encodeURIComponent(oldKey)}`)).data;
  assert.ok(again.scope_changed, JSON.stringify(again).slice(0, 300));
  const dropped = again.dropped_rows.map(([t, id]) => `${t}:${id}`);
  assert.ok(dropped.includes(`notes:${counsel}`)); assert.ok(dropped.includes(`note_addenda:${addendum}`));
  assert.ok(!dropped.includes(`notes:${plain}`));
});

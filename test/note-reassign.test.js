'use strict';
// A departed worker's draft notes, handed on (1.24.0; market evaluation of 1.23.4, D5). A draft is its author's to
// finish and sign; once the author's account is inactive a supervisor or administrator (records:manage-others) may
// give it to another worker: POST /api/notes/:id/reassign, and every draft at once with /api/notes/reassign-drafts.
// The rule is server/rules/notes.js reassignRefusal: only a draft, only from an inactive author, only to an active
// worker who may write that kind of note and reach the client, and a SUD counseling note only to someone who
// writes clinical notes. Each move is audited as note.reassign, with user ids and no note text.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { uuid } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
let admin, sup, nav, clin2c, leaver, clin2, navUser, held, clientId, otherClient;
const ids = {};
const note = (id) => H.db.one(`SELECT * FROM notes WHERE id=?`, id);
const audits = (id) => H.db.all(`SELECT * FROM audit_log WHERE action='note.reassign' AND entity_id=? ORDER BY rowid`, id);

before(async () => {
  await H.start();
  leaver = H.makeUser('rleaver', 'clinician'); clin2 = H.makeUser('rclin2', 'clinician'); navUser = H.makeUser('rnav', 'navigator');
  held = H.makeCaseloadUser('rheld', 'clinician');
  H.makeUser('rsup', 'supervisor');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('rsup', PW);
  nav = H.client(); await nav.login('rnav', PW);
  clin2c = H.client(); await clin2c.login('rclin2', PW);
  const lv = H.client(); await lv.login('rleaver', PW);
  clientId = (await lv.post('/api/clients', { first_name: 'Reassign', last_name: 'Client' })).data.id;
  otherClient = (await lv.post('/api/clients', { first_name: 'Second', last_name: 'Client' })).data.id;
  const at = '2026-09-01T10:00:00Z';
  const mk = async (body) => { const r = await lv.post('/api/notes', { client_id: clientId, occurred_at: at, ...body }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
  ids.clinical = await mk({ kind: 'clinical', title: 'Progress', content: 'Unfinished progress note' });
  ids.admin = await mk({ kind: 'admin', title: 'Housing', content: 'Called the shelter' });
  ids.counseling = await mk({ kind: 'clinical', title: 'Session', content: 'Counseling content', counseling_note: true });
  ids.signed = await mk({ kind: 'admin', title: 'Signed one', content: 'Done and signed' });
  H.db.run(`UPDATE notes SET status='signed', signed_by=author_id, signed_at=? WHERE id=?`, H.db.now(), ids.signed);
  ids.bulkA = await mk({ kind: 'clinical', title: 'Bulk A', content: 'Another draft' });
  ids.bulkB = await mk({ kind: 'clinical', title: 'Bulk B', content: 'Counseling in bulk', counseling_note: true });
  ids.bulkC = (await lv.post('/api/notes', { client_id: otherClient, occurred_at: at, kind: 'admin', content: 'Admin draft on the other client' })).data.id;
  ids.active = (await clin2c.post('/api/notes', { client_id: clientId, occurred_at: at, kind: 'admin', content: 'An active worker\'s draft' })).data.id;
  // The worker leaves.
  assert.equal((await admin.put(`/api/users/${leaver.id}`, { is_active: false })).status, 200);
});
after(() => H.stop());

test('only records:manage-others may hand a draft on; a navigator or clinician is refused', async () => {
  for (const c of [nav, clin2c]) {
    const r = await c.post(`/api/notes/${ids.admin}/reassign`, { to_user_id: clin2.id });
    assert.equal(r.status, 403, 'refused');
    assert.equal(note(ids.admin).author_id, leaver.id, 'the draft is still the departed author\'s');
    assert.equal((await c.get('/api/notes/departed-drafts')).status, 403);
    assert.equal((await c.post('/api/notes/reassign-drafts', { from_user_id: leaver.id, to_user_id: clin2.id })).status, 403);
  }
  // A supervisor denied records:manage-others is refused too (the permission, not the role name).
  const s2 = H.deny(H.makeUser('rsup2', 'supervisor'), 'records:manage-others');
  const c = H.client(); await c.login(s2.username, PW);
  assert.equal((await c.post(`/api/notes/${ids.admin}/reassign`, { to_user_id: clin2.id })).status, 403);
  assert.equal(audits(ids.admin).length, 0, 'nothing audited as a reassignment');
});

test('the departed author\'s drafts are counted for a manager, with no note text', async () => {
  const r = await sup.get('/api/notes/departed-drafts');
  assert.equal(r.status, 200);
  const a = r.data.authors.find(x => x.id === leaver.id);
  assert.ok(a, 'the departed author is listed');
  assert.equal(a.drafts, 6, 'every draft, not the signed note');
  assert.equal(a.counseling, 2);
  assert.deepEqual(Object.keys(a).sort(), ['clinical', 'counseling', 'display_name', 'drafts', 'id', 'role']);
  assert.ok(!r.data.authors.some(x => x.id === clin2.id), 'an active author is not listed');
  assert.ok(!JSON.stringify(r.data).includes('Unfinished'), 'no note content');
});

test('a signed note is refused: its author never changes', async () => {
  const r = await sup.post(`/api/notes/${ids.signed}/reassign`, { to_user_id: clin2.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /legal record/);
  assert.equal(note(ids.signed).author_id, leaver.id);
  assert.equal(audits(ids.signed).length, 0);
});

test('an active author\'s draft is theirs to finish, not handed on', async () => {
  const r = await sup.post(`/api/notes/${ids.active}/reassign`, { to_user_id: navUser.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /still active/);
  assert.equal(note(ids.active).author_id, clin2.id);
});

test('a SUD counseling note cannot go to a worker who does not write clinical notes', async () => {
  const r = await sup.post(`/api/notes/${ids.counseling}/reassign`, { to_user_id: navUser.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /counseling note/);
  assert.ok(r.data.fields && r.data.fields.to_user_id, 'the field is named');
  assert.equal(note(ids.counseling).author_id, leaver.id);
  assert.equal(audits(ids.counseling).length, 0);
  // Nor a clinical note to a navigator (notes:clinical:write), nor anything to an inactive or unknown account.
  assert.match((await sup.post(`/api/notes/${ids.clinical}/reassign`, { to_user_id: navUser.id })).data.error, /cannot write clinical notes/);
  assert.equal((await sup.post(`/api/notes/${ids.clinical}/reassign`, { to_user_id: leaver.id })).status, 400);
  assert.equal((await sup.post(`/api/notes/${ids.clinical}/reassign`, { to_user_id: uuid() })).status, 404);
  assert.equal((await sup.post(`/api/notes/${uuid()}/reassign`, { to_user_id: clin2.id })).status, 404);
  assert.equal((await sup.post(`/api/notes/${ids.clinical}/reassign`, {})).status, 400, 'to_user_id is required');
});

test('a worker held to their caseload cannot be given a draft about a client who is not on it', async () => {
  const r = await sup.post(`/api/notes/${ids.clinical}/reassign`, { to_user_id: held.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /caseload/);
});

test('a manager hands a draft on: the new author edits it as theirs, and the move is audited without PHI', async () => {
  const r = await sup.post(`/api/notes/${ids.counseling}/reassign`, { to_user_id: clin2.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.author_id, clin2.id);
  const n = note(ids.counseling);
  assert.equal(n.author_id, clin2.id); assert.equal(n.status, 'draft');
  const a = audits(ids.counseling);
  assert.equal(a.length, 1, 'one note.reassign entry');
  assert.equal(a[0].client_id, clientId);
  const d = JSON.parse(a[0].details);
  assert.equal(d.from, leaver.id); assert.equal(d.to, clin2.id); assert.equal(d.counseling_note, true);
  assert.ok(!a[0].details.includes('Counseling content') && !a[0].details.includes('Session'), 'no title or content in the audit details');
  // The new author edits it as theirs (only the author edits a draft without records:manage-others).
  const put = await clin2c.put(`/api/notes/${ids.counseling}`, { content: 'Counseling content, finished by the new author' });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  // An administrator may hand on an administrative draft too.
  const ad = await admin.post(`/api/notes/${ids.admin}/reassign`, { to_user_id: navUser.id });
  assert.equal(ad.status, 200, JSON.stringify(ad.data));
  assert.equal(note(ids.admin).author_id, navUser.id);
});

test('every draft at once: each checked on its own, the ineligible ones left and counted', async () => {
  const r = await sup.post('/api/notes/reassign-drafts', { from_user_id: leaver.id, to_user_id: navUser.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Left: clinical, bulkA (clinical), bulkB (counseling); bulkC (admin) moves.
  assert.equal(r.data.moved, 1);
  assert.equal(note(ids.bulkC).author_id, navUser.id);
  assert.equal(note(ids.bulkB).author_id, leaver.id, 'the counseling note stays');
  const reasons = Object.fromEntries(r.data.skipped.map(s => [s.reason, s.count]));
  assert.ok(Object.keys(reasons).some(k => /counseling/.test(k)), 'the counseling note is counted with its reason');
  assert.equal(r.data.skipped.reduce((n, s) => n + s.count, 0), 3);
  assert.equal(JSON.parse(audits(ids.bulkC)[0].details).bulk, true);
  const r2 = await sup.post('/api/notes/reassign-drafts', { from_user_id: leaver.id, to_user_id: clin2.id });
  assert.equal(r2.data.moved, 3);
  assert.equal(note(ids.bulkB).author_id, clin2.id);
  assert.equal(note(ids.signed).author_id, leaver.id, 'the signed note is never moved');
  assert.ok(!(await sup.get('/api/notes/departed-drafts')).data.authors.some(x => x.id === leaver.id), 'nothing left behind');
  // From an active worker: refused outright.
  assert.equal((await sup.post('/api/notes/reassign-drafts', { from_user_id: clin2.id, to_user_id: navUser.id })).status, 400);
});

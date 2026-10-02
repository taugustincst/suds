'use strict';
// Built for 1.24.0: a supervisor's "finish and sign" reminder opens the draft it is about (tasks.note_id, migration 69,
// server/rules/tasks.js noteLinkRefusal / dropNoteLink). The link names the to-do's assignee's own live draft on the
// to-do's client; only a holder of notes:cosign sets or changes it, on a sign reminder, over REST and sync push alike; a
// link to a note that is not a live draft is dropped, not refused. Closing is 1.23.3's: the reminder closes when the
// author's last draft on that client is signed or deleted; signing or deleting the linked one while others are left keeps
// it open and drops the link (the to-do opens the client's drafts list again).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

const PW = 'StaffPassw0rd!x';
let nav, sup, clin, clin2, U = {};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true; // sync push
  for (const [k, role] of [['nav', 'navigator'], ['sup', 'supervisor'], ['clin', 'clinician'], ['clin2', 'clinician']]) U[k] = H.makeUser(`tnl${k}`, role).id;
  nav = H.client(); await nav.login('tnlnav', PW);
  sup = H.client(); await sup.login('tnlsup', PW);
  clin = H.client(); await clin.login('tnlclin', PW);
  clin2 = H.client(); await clin2.login('tnlclin2', PW);
});
after(H.stop);

const { SIGN_REMINDER } = require('../server/rules/notes');
const reminder = (clientId, noteId, extra = {}) => ({ client_id: clientId, assigned_to: U.clin, note_id: noteId, title: 'Finish and sign your draft notes', description: `Sup asked you to finish and sign your draft notes.\n${SIGN_REMINDER}`, due_at: today, ...extra });
const link = (id) => H.db.one(`SELECT note_id FROM tasks WHERE id=?`, id).note_id;
const status = (id) => H.db.one(`SELECT status FROM tasks WHERE id=?`, id).status;
async function clientWithDrafts(last, n = 2) {
  const c = await clin.post('/api/clients', { first_name: 'Link', last_name: last, status: 'active', confirm_duplicate: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const drafts = [];
  for (let i = 0; i < n; i++) drafts.push((await clin.post('/api/notes', { client_id: c.data.id, kind: 'admin', content: `Draft ${i + 1}.`, occurred_at: iso() })).data.id);
  return { id: c.data.id, drafts };
}

test('a supervisor links a sign reminder to the author\'s draft; the to-do carries it and opens with it', async () => {
  const c = await clientWithDrafts('Supok');
  const r = await sup.post('/api/tasks', reminder(c.id, c.drafts[0]));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(link(r.data.id), c.drafts[0]);
  const got = (await clin.get(`/api/tasks/${r.data.id}`)).data.row;
  assert.equal(got.note_id, c.drafts[0], 'the worker\'s to-do names the draft');
  assert.equal(got.sign_reminder, true);
  // The worker opens it: the office's own note read, audited as ever.
  const n = await clin.get(`/api/notes/${c.drafts[0]}`);
  assert.equal(n.status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.view' AND entity_id=? AND user_id=?`, c.drafts[0], U.clin), 'the note read is audited');
  // A colleague who may not read it is still refused by the office (the link changes no access check).
  const counsel = (await clin.post('/api/notes', { client_id: c.id, kind: 'clinical', counseling_note: true, content: 'Counseling draft.', occurred_at: iso() }));
  assert.equal(counsel.status, 201, JSON.stringify(counsel.data));
  const rc = await sup.post('/api/tasks', reminder(c.id, counsel.data.id));
  assert.equal(rc.status, 201, JSON.stringify(rc.data));
  assert.equal((await nav.get(`/api/notes/${counsel.data.id}`)).status, 403, 'a navigator cannot open the linked counseling note');
  // The audit entry for the to-do names no PHI: ids and field names only.
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='task.create' AND entity_id=?`, r.data.id);
  assert.ok(!a.details || !/Draft|Finish/.test(a.details));
});

test('a navigator cannot link a to-do to a draft, nor can the worker re-point their reminder; an ordinary to-do takes no link', async () => {
  const c = await clientWithDrafts('Navno');
  const byNav = await nav.post('/api/tasks', { client_id: c.id, assigned_to: U.clin, note_id: c.drafts[0], title: 'Finish your note', due_at: today });
  assert.equal(byNav.status, 403, JSON.stringify(byNav.data));
  assert.match(byNav.data.error || '', /countersigns notes/);
  const plain = await sup.post('/api/tasks', { client_id: c.id, assigned_to: U.clin, note_id: c.drafts[0], title: 'Look at this', description: 'An ordinary to-do.', due_at: today });
  assert.equal(plain.status, 400, 'only a reminder to sign notes links to a draft');
  const r = await sup.post('/api/tasks', reminder(c.id, c.drafts[0]));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await clin.put(`/api/tasks/${r.data.id}`, { note_id: c.drafts[1] })).status, 403, 'the worker cannot re-point it');
  assert.equal(link(r.data.id), c.drafts[0]);
  assert.equal((await clin.put(`/api/tasks/${r.data.id}`, { due_at: today })).status, 200, 'other edits stand, and keep the link');
  assert.equal(link(r.data.id), c.drafts[0]);
  assert.equal((await sup.put(`/api/tasks/${r.data.id}`, { note_id: c.drafts[1] })).status, 200, 'the supervisor can');
  assert.equal(link(r.data.id), c.drafts[1]);
});

test('a link must be the assignee\'s own draft on the to-do\'s client', async () => {
  const c = await clientWithDrafts('Wrong', 1);
  const other = await clientWithDrafts('Otherclient', 1);
  const wrongClient = await sup.post('/api/tasks', reminder(c.id, other.drafts[0]));
  assert.equal(wrongClient.status, 400, JSON.stringify(wrongClient.data));
  assert.ok(wrongClient.data.fields && wrongClient.data.fields.note_id);
  const theirs = (await clin2.post('/api/notes', { client_id: c.id, kind: 'admin', content: 'A colleague\'s draft.', occurred_at: iso() }));
  assert.equal(theirs.status, 201, JSON.stringify(theirs.data));
  const wrongAuthor = await sup.post('/api/tasks', reminder(c.id, theirs.data.id));
  assert.equal(wrongAuthor.status, 400, JSON.stringify(wrongAuthor.data));
  // Given to someone else or moved to another client later: the link no longer fits and is dropped.
  const r = await sup.post('/api/tasks', reminder(c.id, c.drafts[0]));
  assert.equal(r.status, 201);
  assert.equal((await sup.put(`/api/tasks/${r.data.id}`, { assigned_to: U.clin2 })).status, 200);
  assert.equal(link(r.data.id), null, 'reassigned: the link is dropped');
});

test('a link to a deleted, signed or unknown note is dropped, not refused', async () => {
  const c = await clientWithDrafts('Gone', 2);
  assert.equal((await clin.del(`/api/notes/${c.drafts[0]}`)).status, 200);
  const deleted = await sup.post('/api/tasks', reminder(c.id, c.drafts[0]));
  assert.equal(deleted.status, 201, JSON.stringify(deleted.data));
  assert.equal(link(deleted.data.id), null, 'a deleted draft: the reminder is made, without the link');
  const unknown = await sup.post('/api/tasks', reminder(c.id, randomUUID()));
  assert.equal(unknown.status, 201);
  assert.equal(link(unknown.data.id), null);
});

test('signing or deleting the linked draft while others are left keeps the reminder open and drops the link; the last one closes it', async () => {
  const c = await clientWithDrafts('Close', 3);
  const r = await sup.post('/api/tasks', reminder(c.id, c.drafts[0]));
  assert.equal(r.status, 201);
  assert.equal((await clin.post(`/api/notes/${c.drafts[0]}/sign`, { password: PW })).status, 200);
  assert.equal(status(r.data.id), 'open', 'other drafts are left');
  assert.equal(link(r.data.id), null, 'the linked draft is signed: the reminder opens the drafts list again');
  assert.equal((await sup.put(`/api/tasks/${r.data.id}`, { note_id: c.drafts[1] })).status, 200);
  assert.equal((await clin.del(`/api/notes/${c.drafts[1]}`)).status, 200);
  assert.equal(status(r.data.id), 'open');
  assert.equal(link(r.data.id), null, 'deleted: dropped too');
  assert.equal((await clin.post(`/api/notes/${c.drafts[2]}/sign`, { password: PW })).status, 200);
  assert.equal(status(r.data.id), 'done', 'the last draft signed: closed as in 1.23.3');
  // A reminder made before (no link) still closes with the last draft.
  const c2 = await clientWithDrafts('Oldstyle', 1);
  const old = await sup.post('/api/tasks', reminder(c2.id, undefined));
  assert.equal(old.status, 201);
  assert.equal(link(old.data.id), null);
  assert.equal((await clin.post(`/api/notes/${c2.drafts[0]}/sign`, { password: PW })).status, 200);
  assert.equal(status(old.data.id), 'done');
});

test('over sync push the device carries the link, under the same rules', async () => {
  const c = await clientWithDrafts('Sync', 2);
  const row = (id, extra = {}) => ({ id, client_id: c.id, assigned_to: U.clin, created_by: U.sup, title_enc: 'Finish and sign', description_enc: `Asked.\n${SIGN_REMINDER}`, due_at: today, priority: 'normal', status: 'open', created_at: iso(), updated_at: iso(), ...extra });
  // A supervisor's device: kept.
  const ok = randomUUID();
  const p1 = await sup.post('/api/sync/push', { device_now: iso(), tables: { tasks: [row(ok, { note_id: c.drafts[0] })] } });
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  assert.equal(link(ok), c.drafts[0]);
  // A navigator's device: an ordinary to-do with a link is refused (the line too would be).
  const byNav = randomUUID();
  const p2 = await nav.post('/api/sync/push', { device_now: iso(), tables: { tasks: [row(byNav, { created_by: U.nav, description_enc: 'Asked.', note_id: c.drafts[0] })] } });
  assert.equal(p2.status, 200);
  assert.equal(H.db.one(`SELECT id FROM tasks WHERE id=?`, byNav), undefined);
  assert.ok(p2.data.rejected.some(x => x.id === byNav), JSON.stringify(p2.data));
  // The worker's device re-pointing the supervisor's reminder: refused.
  const t = H.db.one(`SELECT * FROM tasks WHERE id=?`, ok);
  const p3 = await clin.post('/api/sync/push', { device_now: iso(), tables: { tasks: [{ ...t, title_enc: 'Finish and sign', description_enc: `Asked.\n${SIGN_REMINDER}`, note_id: c.drafts[1], updated_at: iso(Date.now() + 5000) }] } });
  assert.equal(p3.status, 200);
  assert.equal(link(ok), c.drafts[0], JSON.stringify(p3.data));
  // Sending it back unchanged is fine (marking it done on the device).
  const p4 = await clin.post('/api/sync/push', { device_now: iso(), tables: { tasks: [{ ...t, title_enc: 'Finish and sign', description_enc: `Asked.\n${SIGN_REMINDER}`, status: 'in_progress', updated_at: iso(Date.now() + 10000) }] } });
  assert.equal(p4.status, 200);
  assert.equal(status(ok), 'in_progress', JSON.stringify(p4.data));
  assert.equal(link(ok), c.drafts[0]);
  // A supervisor's device linking a deleted draft, or another client's: dropped / refused as over REST.
  assert.equal((await clin.del(`/api/notes/${c.drafts[1]}`)).status, 200);
  const dead = randomUUID();
  const p5 = await sup.post('/api/sync/push', { device_now: iso(), tables: { tasks: [row(dead, { note_id: c.drafts[1] })] } });
  assert.equal(p5.status, 200);
  assert.equal(status(dead), 'open', JSON.stringify(p5.data));
  assert.equal(link(dead), null, 'a deleted draft: the link is dropped, the reminder kept');
  const other = await clientWithDrafts('Syncother', 1);
  const wrong = randomUUID();
  const p6 = await sup.post('/api/sync/push', { device_now: iso(), tables: { tasks: [row(wrong, { note_id: other.drafts[0] })] } });
  assert.equal(p6.status, 200);
  assert.equal(H.db.one(`SELECT id FROM tasks WHERE id=?`, wrong), undefined, 'another client\'s draft: refused');
});

test('integration of 1.24.0 with 1.23.3\'s isSignReminder: a to-do with the line that is not a reminder (given to its maker) takes no link', async () => {
  const c = await clientWithDrafts('Selfmade');
  // A to-do a supervisor gives themselves is not a sign reminder (rules/notes.js isSignReminder: given to someone else),
  // so it may not link to a draft, even with the line in its details.
  const own = await sup.post('/api/tasks', reminder(c.id, c.drafts[0], { assigned_to: U.sup }));
  assert.equal(own.status, 400, JSON.stringify(own.data));
  assert.match(own.data.error || '', /Only a reminder to sign notes can link to a draft/);
  // Given to the author it is one, and takes the link.
  const r = await sup.post('/api/tasks', reminder(c.id, c.drafts[0]));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(link(r.data.id), c.drafts[0]);
});

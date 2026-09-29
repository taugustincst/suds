'use strict';
// Rule logic the REST routes and sync push share through server/rules/ (1.17.1; engineering review of 1.17.0, L2):
// the AI review statement (rules/notes.js aiReviewed), "AI-assisted stays set" (rules/notes.js keepAiAssisted) and
// the SSP participant code's stored form and blind index (rules/interventions.js participantCode). Each is asked of
// both doors here, with the same inputs, and must come out the same.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
let clin, nav, clinId, navId, clientId;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  clinId = H.makeUser('par_clin', 'clinician').id; navId = H.makeUser('par_nav', 'navigator').id;
  clin = H.client(); await clin.login('par_clin', PW);
  nav = H.client(); await nav.login('par_nav', PW);
  clientId = expect(await clin.post('/api/clients', { first_name: 'Pari', last_name: 'Ty', confirm_duplicate: true }), 201, 'client').id;
});
after(() => H.stop());

const aiNote = async () => expect(await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'AI drafted text', occurred_at: iso(), ai_assisted: true }), 201, 'note').id;
const pushSign = async (id, extra) => {
  const row = H.db.one('SELECT * FROM notes WHERE id=?', id);
  const r = expect(await clin.post('/api/sync/push', { device_now: iso(), tables: { notes: [{ ...row, content_enc: 'AI drafted text', title_enc: null, structured_enc: null, cosign_note_enc: null, status: 'signed', signed_by: row.author_id, signed_at: iso(), updated_at: iso(Date.now() + 1000), ...extra }] } }), 200, 'push');
  return r.rejected.length === 0;
};
const restSign = async (id, extra) => (await clin.post(`/api/notes/${id}/sign`, { password: PW, ...extra })).status === 200;

test('the AI review statement: REST sign and sync push accept exactly the same values', async () => {
  const R = require('../server/rules/notes');
  const cases = [[true, true], [1, true], ['1', true], ['true', true], [false, false], [0, false], ['0', false], ['yes', false], ['TRUE', false], [null, false], [undefined, false]];
  for (const [v, want] of cases) assert.equal(R.aiReviewed(v), want, `aiReviewed(${JSON.stringify(v)})`);
  // Through both doors, a value only one of them used to accept ('true': sync yes, REST no until 1.17.1) and one
  // neither accepts.
  for (const [v, want] of [['true', true], ['yes', false], [undefined, false]]) {
    const extra = v === undefined ? {} : { ai_reviewed: v };
    const viaRest = await restSign(await aiNote(), extra);
    const viaSync = await pushSign(await aiNote(), extra);
    assert.equal(viaRest, want, `REST with ai_reviewed=${JSON.stringify(v)}`);
    assert.equal(viaSync, want, `sync with ai_reviewed=${JSON.stringify(v)}`);
  }
});

test('AI-assisted stays set: neither a REST save nor a push takes the mark off a draft', async () => {
  const R = require('../server/rules/notes');
  assert.equal(R.keepAiAssisted(0, { ai_assisted: 1 }), 1);
  assert.equal(R.keepAiAssisted(0, { ai_assisted: 0 }), 0);
  assert.equal(R.keepAiAssisted(1, { ai_assisted: 0 }), 1);
  assert.equal(R.keepAiAssisted(0, null), 0, 'a new note is what it says');
  const a = await aiNote();
  expect(await clin.put(`/api/notes/${a}`, { ai_assisted: false, content: 'Edited by hand' }), 200, 'REST save');
  assert.equal(H.db.one('SELECT ai_assisted FROM notes WHERE id=?', a).ai_assisted, 1, 'REST');
  const b = await aiNote();
  const row = H.db.one('SELECT * FROM notes WHERE id=?', b);
  const p = expect(await clin.post('/api/sync/push', { device_now: iso(), tables: { notes: [{ ...row, content_enc: 'Edited on a phone', title_enc: null, structured_enc: null, cosign_note_enc: null, ai_assisted: 0, updated_at: iso(Date.now() + 1000) }] } }), 200, 'push');
  assert.equal(p.rejected.length, 0, JSON.stringify(p));
  assert.equal(H.db.one('SELECT ai_assisted FROM notes WHERE id=?', b).ai_assisted, 1, 'sync');
});

test('an SSP participant code typed at the office and one pushed by a device are stored and indexed alike', async () => {
  const { decrypt } = require('../server/crypto');
  const R = require('../server/rules/interventions');
  const PC = require('../server/participant-code');
  assert.deepEqual(R.participantCode(' ab-07 85 '), { code: 'AB0785', idx: PC.index('AB0785') });
  assert.deepEqual(R.participantCode(''), { code: null, idx: null });
  assert.deepEqual(R.participantCode(null), { code: null, idx: null });
  for (const typed of ['zz-99 01', 'Zz9901', 'ZZ.99.01']) {
    const rest = expect(await nav.post('/api/interventions', { type: 'outreach', occurred_at: '2026-08-05T18:00:00.000Z', participant_code: typed }), 201, 'REST').id;
    const id = randomUUID();
    const p = expect(await nav.post('/api/sync/push', { device_now: iso(), tables: { interventions: [{ id, user_id: navId, type: 'outreach', occurred_at: '2026-08-05T18:00:00.000Z', participant_code_enc: typed, created_at: iso(), updated_at: iso() }] } }), 200, 'push');
    assert.equal(p.rejected.length, 0, JSON.stringify(p));
    const [x, y] = [rest, id].map(k => H.db.one('SELECT participant_code_enc, participant_code_idx FROM interventions WHERE id=?', k));
    assert.equal(decrypt(x.participant_code_enc), 'ZZ9901', `REST ${typed}`);
    assert.equal(decrypt(y.participant_code_enc), 'ZZ9901', `sync ${typed}`);
    assert.equal(x.participant_code_idx, y.participant_code_idx);
    assert.equal(x.participant_code_idx, R.participantCode(typed).idx);
  }
});

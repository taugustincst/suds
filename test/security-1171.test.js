'use strict';
// The security review of 1.17.0 as released (r11), the findings fixed in 1.17.1:
//   1  the copilot's monthly cap holds under concurrent drafts: a draft on its way to the provider is reserved
//      before anything is sent and counted by status() until its outcome is recorded.
//   2  a copilot draft asked for in a note not saved yet marks the note it goes into AI-assisted on the office,
//      over REST and sync push, whatever the browser sends (server/rules/notes.js).
//   3  a referral link is not opened under a worker who has been deactivated or can no longer reach the client;
//      deactivating a worker withdraws the links they made.
//   4  a forwarded link opened again and again, and a withheld packet, are audited through the refusal throttle.
//   5  the copilot never follows a redirect from the provider's address.
// The AI provider and the redirect target are local fake HTTP servers: nothing leaves this machine.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral summary', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };

let fake, target;
const calls = []; const targetCalls = [];
let reply = null; // () => { status, json, delay, headers }
const okJson = (data) => ({ status: 200, json: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 10, output_tokens: 5 } } });

let admin, clin, clin2, nav, held, anon;
let clinUser, clientId, otherClientId;

before(async () => {
  target = http.createServer((req, res) => { targetCalls.push(req.url); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(okJson({ narrative: 'from the redirect target' }).json)); });
  await new Promise(ok => target.listen(0, '127.0.0.1', ok));
  fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      calls.push(req.url);
      const r = reply ? reply() : okJson({ narrative: 'Draft.', gaps: [] });
      if (r.delay) await new Promise(ok => setTimeout(ok, r.delay));
      if (res.destroyed) return;
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.json || {}));
    });
  });
  await new Promise(ok => fake.listen(0, '127.0.0.1', ok));
  process.env.SUDS_AI_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-provider-key';
  delete process.env.SUDS_AI_TIMEOUT_MS;

  await H.start();
  require('../server/config').localModeEnabled = true;
  clinUser = H.makeUser('s171_clin', 'clinician'); H.makeUser('s171_clin2', 'clinician'); H.makeUser('s171_nav', 'navigator'); H.makeCaseloadUser('s171_held', 'navigator');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  clin = H.client(); await clin.login('s171_clin', PW);
  clin2 = H.client(); await clin2.login('s171_clin2', PW);
  nav = H.client(); await nav.login('s171_nav', PW);
  held = H.client(); await held.login('s171_held', PW);
  anon = H.client();
  clientId = expect(await clin.post('/api/clients', { first_name: 'Ada', last_name: 'Draftwell', confirm_duplicate: true }), 201, 'client').id;
  otherClientId = expect(await clin.post('/api/clients', { first_name: 'Ben', last_name: 'Otherone', confirm_duplicate: true }), 201, 'client 2').id;
  expect(await admin.post('/api/ai/attestation', { provider: 'Anthropic', signed_by: 'Counsel', agreement_date: '2026-01-15', reference: 'BAA-1', baa: true, qsoa: true, counsel_reviewed: true }), 201, 'attestation');
  expect(await admin.put('/api/ai/settings', { enabled: true }), 200, 'enable');
  H.db.setSetting('referral_links_enabled', '1');
});
after(async () => { await H.stop(); await new Promise(ok => fake.close(ok)); await new Promise(ok => target.close(ok)); });

const fresh = () => {
  for (const u of H.db.all(`SELECT id FROM users`)) require('../server/app').rateLimitReset(`ai:${u.id}`);
  require('../server/rules/notes').pendingDrafts.clear();
  reply = null;
};
const draft = (c, body = {}) => c.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'narrative', source_text: 'Session text.', ...body });
const aiOf = (id) => H.db.one(`SELECT ai_assisted FROM notes WHERE id=?`, id).ai_assisted;
const newNote = (c, body = {}) => c.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Text.', occurred_at: iso(), ...body });

// ---------------------------------------------------------------------------------------------------- 1
test('1: concurrent drafts at cap - 1: one is sent, the rest are refused with the cap message', async () => {
  fresh();
  const AI = require('../server/ai-copilot');
  const used = AI.usage().calls;
  expect(await admin.put('/api/ai/settings', { monthly_cap: used + 1 }), 200, 'cap');
  try {
    reply = () => ({ ...okJson({ narrative: 'Slow draft.', gaps: [] }), delay: 400 });
    const before = calls.length;
    const rs = await Promise.all(Array.from({ length: 6 }, () => draft(clin)));
    const ok = rs.filter(r => r.status === 200); const capped = rs.filter(r => r.status === 429);
    assert.equal(ok.length, 1, rs.map(r => r.status).join(','));
    assert.equal(capped.length, 5);
    for (const r of capped) { assert.equal(r.data.ai_error, 'cap'); assert.match(r.data.error, /used its/); }
    assert.equal(calls.length - before, 1, 'only one request reached the provider');
    assert.equal(AI.usage().calls, used + 1, 'the cap is not overshot');
    assert.equal(AI.pending(), 0, 'the reservation is released once the draft is recorded');

    // A failed call releases its reservation too, and does not use up the cap.
    expect(await admin.put('/api/ai/settings', { monthly_cap: used + 2 }), 200, 'cap + 1');
    fresh(); reply = () => ({ status: 401, json: { type: 'error' }, delay: 100 });
    const [a, b] = await Promise.all([draft(clin), draft(clin)]);
    assert.deepEqual([a.status, b.status].sort(), [429, 502], 'while one is on its way, the last draft of the month is reserved');
    assert.equal(AI.pending(), 0);
    assert.equal((await clin.get('/api/ai/status')).data.available, true, 'the failed call gave its reservation back');
  } finally {
    expect(await admin.put('/api/ai/settings', { monthly_cap: 500 }), 200, 'reset cap');
  }
});

// ---------------------------------------------------------------------------------------------------- 2 (REST)
test('2: a draft for a note not saved yet marks the note it goes into, over REST, whatever the browser sends', async () => {
  fresh();
  // Asked twice (the author asked again), then saved without ai_assisted: marked, once.
  expect(await draft(clin), 200, 'draft'); expect(await draft(clin), 200, 'draft again');
  const n = expect(await newNote(clin, { content: 'Pasted draft, no flag from the browser.' }), 201, 'note');
  assert.equal(aiOf(n.id), 1, 'marked by the office');
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.create' AND entity_id=?`, n.id).details);
  assert.equal(a.ai_assisted, true); assert.equal(a.ai_from_draft, true);
  const sign = await clin.post(`/api/notes/${n.id}/sign`, { password: PW });
  assert.equal(sign.status, 400); assert.equal(sign.data.ai_review_required, true, 'so signing needs the review statement');
  // Used up: the author's next note is their own.
  const plain = expect(await newNote(clin, { content: 'Own words.' }), 201, 'plain');
  assert.equal(aiOf(plain.id), 0);
  assert.equal((await clin.post(`/api/notes/${plain.id}/sign`, { password: PW })).status, 200);

  // Only that author, only that client.
  expect(await draft(clin), 200, 'draft');
  const other = expect(await newNote(clin, { client_id: otherClientId }), 201, 'another client');
  assert.equal(aiOf(other.id), 0);
  const colleague = expect(await newNote(clin2), 201, 'a colleague');
  assert.equal(aiOf(colleague.id), 0);

  // A saved draft note given new text after a draft asked for without its id: marked on that update.
  const saved = expect(await newNote(clin), 201, 'this one takes the pending draft');
  assert.equal(aiOf(saved.id), 1);
  const early = expect(await newNote(clin, { content: 'Started before asking.' }), 201, 'saved first');
  assert.equal(aiOf(early.id), 0);
  expect(await draft(clin), 200, 'draft, the browser leaving out note_id');
  expect(await clin.put(`/api/notes/${early.id}`, { problem_ids: [] }), 200, 'no new text');
  assert.equal(aiOf(early.id), 0, 'a change that writes no text does not take the draft');
  expect(await clin.put(`/api/notes/${early.id}`, { content: 'Now with the draft.', ai_assisted: false }), 200, 'new text');
  assert.equal(aiOf(early.id), 1);
  assert.equal(JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.update' AND entity_id=? ORDER BY id DESC LIMIT 1`, early.id).details).ai_from_draft, true);

  // A SUD counseling note is refused while a draft is waiting for a note, and allowed once it is saved.
  expect(await draft(clin), 200, 'draft');
  const counsel = await newNote(clin, { counseling_note: true, content: 'Session analysis.' });
  assert.equal(counsel.status, 400, JSON.stringify(counsel.data)); assert.match(counsel.data.error, /not been saved in a note/);
  assert.equal(aiOf(expect(await newNote(clin), 201, 'the drafted note').id), 1, 'the refusal did not use the draft up');
  expect(await newNote(clin, { counseling_note: true, content: 'Session analysis.' }), 201, 'counseling note after');

  // A draft in a saved note marks that note, and leaves nothing waiting for the next.
  const inNote = expect(await newNote(clin), 201, 'note');
  expect(await draft(clin, { note_id: inNote.id }), 200, 'draft in it');
  assert.equal(aiOf(inNote.id), 1);
  assert.equal(aiOf(expect(await newNote(clin), 201, 'next').id), 0);
});

// ---------------------------------------------------------------------------------------------------- 2 (sync)
test('2: the same over sync push: a pushed note takes the pending draft, and cannot be signed without the statement', async () => {
  fresh();
  const row = (extra = {}) => ({ id: require('node:crypto').randomUUID(), client_id: clientId, author_id: clinUser.id, kind: 'clinical', format: 'narrative', content_enc: 'Pushed text', title_enc: null, structured_enc: null,
    occurred_at: iso(), status: 'draft', created_at: iso(), updated_at: iso(), ...extra });
  const push = (r) => clin.post('/api/sync/push', { device_now: iso(), tables: { notes: [r] } });

  expect(await draft(clin), 200, 'draft');
  const d = row();
  const p = expect(await push(d), 200, 'push draft');
  assert.equal(p.rejected.length, 0, JSON.stringify(p));
  assert.equal(aiOf(d.id), 1, 'marked by the office though the device did not say so');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.ai_assisted' AND entity_id=?`, d.id), 'audited');
  const plain = row();
  expect(await push(plain), 200, 'next push');
  assert.equal(aiOf(plain.id), 0, 'used up');

  // Signed on the device without the review statement: refused, and the draft still waits for it.
  expect(await draft(clin), 200, 'draft');
  const s = row({ status: 'signed', signed_by: clinUser.id, signed_at: iso() });
  const r1 = expect(await push(s), 200, 'push signed');
  assert.equal(r1.rejected.length, 1, JSON.stringify(r1)); assert.match(r1.rejected[0].reason, /review/i);
  assert.ok(!H.db.one(`SELECT 1 FROM notes WHERE id=?`, s.id));
  const r2 = expect(await push({ ...s, ai_reviewed: true, updated_at: iso(Date.now() + 1000) }), 200, 'with the statement');
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2));
  const stored = H.db.one(`SELECT status, ai_assisted FROM notes WHERE id=?`, s.id);
  assert.equal(stored.status, 'signed'); assert.equal(stored.ai_assisted, 1);

  // An existing draft given new text by a push.
  const existing = row(); expect(await push(existing), 200, 'plain draft'); assert.equal(aiOf(existing.id), 0);
  expect(await draft(clin), 200, 'draft');
  expect(await push({ ...existing, content_enc: 'Now with the draft', updated_at: iso(Date.now() + 2000) }), 200, 'update');
  assert.equal(aiOf(existing.id), 1);

  // And a pushed counseling note is refused while a draft waits.
  expect(await draft(clin), 200, 'draft');
  const c = row({ counseling_note: 1 });
  const r3 = expect(await push(c), 200, 'push counseling');
  assert.equal(r3.rejected.length, 1, JSON.stringify(r3)); assert.match(r3.rejected[0].reason, /counseling/i);
});

// ---------------------------------------------------------------------------------------------------- 3 / 4
async function linkSetup(c, name, kind = 'packet') {
  const client = expect(await c.post('/api/clients', { first_name: 'Link', last_name: name, status: 'active', confirm_duplicate: true }), 201, 'client').id;
  const res = expect(await c.post('/api/resources', { name: `Clinic ${name}`, category: 'outpatient' }), 201, 'resource').id;
  const consent = expect(await c.post(`/api/clients/${client}/consents`, { type: 'part2_disclosure', recipient: `Clinic ${name}`, purpose: 'Referral for treatment', ...ELEMENTS }), 201, 'consent').id;
  const ref = expect(await c.post('/api/referrals', { client_id: client, resource_id: res, referred_at: '2026-09-03T09:00:00Z', status: 'pending', warm_handoff: false }), 201, 'referral').id;
  const made = expect(await c.post(`/api/referrals/${ref}/links`, kind === 'packet' ? { kind, consent_id: consent } : { kind }), 201, 'link');
  return { client, res, consent, ref, made, token: made.path.split('#')[1] };
}
const disclosures = (clientId) => H.db.one('SELECT COUNT(*) n FROM disclosures WHERE client_id=?', clientId).n;
const lastOpen = (linkId) => JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='referral_link.open' AND entity_id=? ORDER BY id DESC LIMIT 1`, linkId).details);

test('3: a packet is withheld when its creator is inactive or can no longer reach the client', async () => {
  // Inactive (an account switched off by a path that does not withdraw links, e.g. directly in the database).
  const u = H.makeUser('s171_gone', 'navigator'); const gone = H.client(); await gone.login(u.username, PW);
  const s = await linkSetup(gone, 'Gonex');
  H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, u.id);
  const o = expect(await anon.post('/api/referral-links/open', { token: s.token, code: s.made.code }), 200, 'open');
  assert.equal(o.withheld, true); assert.equal(o.packet, undefined);
  assert.equal(disclosures(s.client), 0, 'nothing accounted: nothing went');
  assert.equal(lastOpen(s.made.id).reason, 'creator_inactive');

  // Off the creator's caseload since.
  const h = await linkSetup(held, 'Heldx');
  assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE client_id=?`, h.client), 'the held worker\'s own client is assigned to them');
  H.db.run(`DELETE FROM assignments WHERE client_id=?`, h.client);
  const o2 = expect(await anon.post('/api/referral-links/open', { token: h.token, code: h.made.code }), 200, 'open');
  assert.equal(o2.withheld, true); assert.equal(o2.packet, undefined); assert.equal(disclosures(h.client), 0);
  assert.equal(lastOpen(h.made.id).reason, 'creator_no_access');

  // Still active and in reach: opened as before.
  const ok = await linkSetup(nav, 'Finex');
  const o3 = expect(await anon.post('/api/referral-links/open', { token: ok.token, code: ok.made.code }), 200, 'open');
  assert.ok(o3.packet); assert.equal(disclosures(ok.client), 1);
});

test('3: deactivating a worker withdraws the links they made (Users, SCIM and deprovisioning)', async () => {
  const u = H.makeUser('s171_leaver', 'navigator'); const leaver = H.client(); await leaver.login(u.username, PW);
  const a = await linkSetup(leaver, 'Leavera'); const b = await linkSetup(leaver, 'Leaverb', 'contact_notice');
  expect(await admin.put(`/api/users/${u.id}`, { is_active: false }), 200, 'deactivate');
  for (const l of [a, b]) {
    const row = H.db.one(`SELECT revoked_at, revoked_by FROM referral_links WHERE id=?`, l.made.id);
    assert.ok(row.revoked_at, 'withdrawn'); assert.equal(row.revoked_by, H.db.one(`SELECT id FROM users WHERE username='admin'`).id);
    const au = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='referral_link.revoke' AND entity_id=?`, l.made.id).details);
    assert.equal(au.cause, 'creator_deactivated');
    assert.equal((await anon.post('/api/referral-links/open', { token: l.token, code: l.made.code })).status, 404);
  }
  // SCIM and SSO deprovisioning cut an account off through scim.cutOff.
  const v = H.makeUser('s171_scim', 'navigator'); const sc = H.client(); await sc.login(v.username, PW);
  const c = await linkSetup(sc, 'Scimx');
  H.db.transaction(() => { H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, v.id); require('../server/scim').cutOff(v.id, { username: 'scim' }); });
  const row = H.db.one(`SELECT revoked_at, revoked_by FROM referral_links WHERE id=?`, c.made.id);
  assert.ok(row.revoked_at); assert.equal(row.revoked_by, null);
  // A password reset is not a deactivation: links stay.
  const w = H.makeUser('s171_reset', 'navigator'); const rs = H.client(); await rs.login(w.username, PW);
  const d = await linkSetup(rs, 'Resetx');
  expect(await admin.put(`/api/users/${w.id}`, { password: 'AnotherPassw0rd!x' }), 200, 'reset');
  assert.equal(H.db.one(`SELECT revoked_at FROM referral_links WHERE id=?`, d.made.id).revoked_at, null);
});

test('4: a forwarded link opened again and again, and a withheld packet, go through the refusal throttle', async () => {
  const RL = require('../server/referral-links');
  const N = RL.REFUSALS_LOGGED_PER_HOUR + 8;
  const count = (id) => H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=? AND success=0`, id).n;

  const s = await linkSetup(nav, 'Forwardx');
  expect(await anon.post('/api/referral-links/open', { token: s.token, code: s.made.code }), 200, 'claimed');
  RL.flushRefusals();
  const before = count(s.made.id);
  // Called directly, so the per-address HTTP limit does not stop the flood first.
  for (let i = 0; i < N; i++) assert.throws(() => RL.open({ token: s.token, ip: `10.1.0.${i % 2}` }), /already been opened/);
  assert.equal(count(s.made.id) - before, RL.REFUSALS_LOGGED_PER_HOUR + 1, 'the first few one by one, then a note that the rest are counted');
  const firsts = H.db.all(`SELECT details FROM audit_log WHERE entity_id=? AND success=0 ORDER BY id DESC LIMIT ?`, s.made.id, RL.REFUSALS_LOGGED_PER_HOUR + 1).map(r => JSON.parse(r.details).reason);
  assert.equal(firsts.filter(x => x === 'claimed_elsewhere').length, RL.REFUSALS_LOGGED_PER_HOUR); assert.ok(firsts.includes('counting'));
  RL.flushRefusals();
  const sum = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE entity_id=? ORDER BY id DESC LIMIT 1`, s.made.id).details);
  assert.equal(sum.reason, 'refused_summary'); assert.equal(sum.count, N - RL.REFUSALS_LOGGED_PER_HOUR);

  // Withheld (the consent revoked since): the page still answers each time, but the audit rows are throttled.
  const w = await linkSetup(nav, 'Withheldx');
  expect(await nav.post(`/api/consents/${w.consent}/revoke`, { reason: 'Client withdrew consent in person' }), 200, 'revoke consent');
  const b2 = count(w.made.id);
  for (let i = 0; i < N; i++) assert.equal(RL.open({ token: w.token, code: w.made.code, ip: '10.2.0.1' }).withheld, true);
  assert.equal(count(w.made.id) - b2, RL.REFUSALS_LOGGED_PER_HOUR + 1);
  const first = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE entity_id=? AND success=0 AND details LIKE '%withheld%' ORDER BY id LIMIT 1`, w.made.id).details);
  assert.equal(first.reason, 'consent_not_valid'); assert.equal(first.withheld, true);
  assert.equal(disclosures(w.client), 0);
  RL.flushRefusals();
});

// ---------------------------------------------------------------------------------------------------- 5
test('5: a redirect from the provider\'s address is not followed: the draft fails closed', async () => {
  fresh();
  const before = calls.length; const tBefore = targetCalls.length;
  reply = () => ({ status: 307, headers: { location: `http://127.0.0.1:${target.address().port}/v1/messages` }, json: {} });
  const r = await draft(clin);
  assert.equal(r.status, 502, JSON.stringify(r.data)); assert.equal(r.data.ai_error, 'redirect'); assert.match(r.data.error, /redirect/);
  assert.equal(targetCalls.length, tBefore, 'the redirect target was never contacted');
  assert.equal(calls.length - before, 1, 'and it is not retried');
  assert.equal(JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='ai.draft' ORDER BY id DESC LIMIT 1`).details).outcome, 'redirect');
  // Nothing is waiting for a note: no draft came back.
  assert.equal(require('../server/rules/notes').draftPending(clinUser.id, clientId), false);
  reply = null;
});

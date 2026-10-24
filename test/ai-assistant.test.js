'use strict';
// The AI assistant (server/ai-assistant.js, server/ai-context.js, POST /api/ai/ask; docs/AI-COPILOT.md, "The
// assistant"): who may use it, that it is off until the copilot is on, its own switch is on and the agreement is
// recorded as covering assistant use, what is sent (summaries of records the person may see, de-identified),
// that answers cite only what was sent, the audit and usage trail (never the text), and that nothing is written.
// The provider is a local fake HTTP server: no call ever leaves this machine.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const H = require('./helpers');

let fake;
const calls = [];
let reply = null; // (body) => { status, json, delay, raw }
function okJson(data, extra = {}) {
  return { status: 200, json: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0 }, ...extra } };
}

let admin, nav, clin, fin;
before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = null; try { body = JSON.parse(raw); } catch { body = null; }
      calls.push({ path: req.url, body, raw });
      const r = reply ? reply(body) : okJson({ answer: 'x', citations: [], missing: [] });
      if (r.delay) await new Promise(ok => setTimeout(ok, r.delay));
      if (res.destroyed) return;
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(r.raw !== undefined ? r.raw : JSON.stringify(r.json));
    });
  });
  await new Promise(ok => fake.listen(0, '127.0.0.1', ok));
  process.env.SUDS_AI_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-provider-key';
  delete process.env.SUDS_AI_TIMEOUT_MS;
  await H.start();
  H.makeUser('asnav', 'navigator'); H.makeUser('asclin', 'clinician'); H.makeUser('asfin', 'finance');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('asnav', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('asclin', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('asfin', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); await new Promise(ok => fake.close(ok)); });

const AGREEMENT = { provider: 'Anthropic', signed_by: 'County counsel office', agreement_date: '2026-01-15', reference: 'BAA-2026-017', baa: true, qsoa: true, counsel_reviewed: true };
const lastAudit = (action) => H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action);

// ---------------------------------------------------------------- Task 1: permission, switch, agreement scope

test('ai:ask: clinicians, supervisors and navigators by default; not administrators, finance or read-only', () => {
  const auth = require('../server/auth');
  const P = require('../server/permissions');
  for (const role of ['clinician', 'supervisor', 'navigator']) assert.ok(auth.hasPerm({ role }, 'ai:ask'), role);
  for (const role of ['admin', 'finance', 'readonly']) assert.ok(!auth.hasPerm({ role }, 'ai:ask'), role);
  const entry = P.PERMISSION_CATALOG.find(p => p.name === 'ai:ask');
  assert.ok(entry, 'in the catalogue');
  assert.equal(entry.risk, 'sensitive', 'record summaries go to the provider: a sensitive permission');
  assert.match(entry.description, /never changes a record/);
  // The same grant rule as ai:draft: only a role that documents client work.
  assert.match(P.grantProblem('finance', auth.rolePerms ? auth.rolePerms('finance') : [], 'ai:ask') || '', /documents client work/);
  assert.equal(P.grantProblem('navigator', auth.rolePerms ? auth.rolePerms('navigator') : ['clients:write'], 'ai:ask'), null);
});

test('the assistant is unavailable until its switch is on and the agreement is recorded as covering it', async () => {
  const AI = require('../server/ai-copilot');
  // No agreement: the copilot's own reason, word for word.
  let st = (await nav.get('/api/ai/status')).data;
  assert.equal(st.assistant.available, false);
  assert.equal(st.assistant.code, 'no_agreement');
  assert.equal(st.can_ask, true, 'a navigator holds ai:ask');
  assert.equal((await fin.get('/api/ai/status')).data.can_ask, false, 'finance does not');
  // An agreement recorded without the assistant statement (as every one recorded before the assistant was).
  assert.equal((await admin.post('/api/ai/attestation', AGREEMENT)).status, 201);
  assert.equal((await admin.put('/api/ai/settings', { enabled: true })).status, 200);
  st = AI.status();
  assert.equal(st.available, true, 'drafts work under it as before');
  assert.equal(st.assistant.code, 'assistant_off', 'the assistant stays off, even with the copilot on');
  // The switch refuses while the agreement does not cover assistant use.
  const refused = await admin.put('/api/ai/settings', { assistant_enabled: true });
  assert.equal(refused.status, 400);
  assert.match(refused.data.fields.assistant_enabled, /not confirmed to cover assistant use/);
  // An agreement switched on by hand before it covered the assistant (or written another way) reads as out of scope.
  H.db.setSetting('ai_assistant_enabled', '1');
  assert.equal(AI.status().assistant.code, 'agreement_scope');
  // Recorded again with the fourth statement: stored, audited, and the switch then works.
  const a = await admin.post('/api/ai/attestation', { ...AGREEMENT, covers_assistant: true });
  assert.equal(a.status, 201);
  assert.equal(a.data.attestation.covers_assistant, true);
  assert.equal(JSON.parse(lastAudit('ai.attestation.record').details).covers_assistant, true);
  assert.equal((await admin.put('/api/ai/settings', { assistant_enabled: true })).status, 200);
  assert.deepEqual(JSON.parse(lastAudit('ai.settings.update').details).changed, ['assistant_enabled']);
  st = (await nav.get('/api/ai/status')).data;
  assert.deepEqual(st.assistant, { available: true, code: null, reason: null });
  // Recorded again without it: the assistant goes off with the statement; drafts carry on.
  assert.equal((await admin.post('/api/ai/attestation', AGREEMENT)).status, 201);
  assert.equal(AI.status().assistant.code, 'assistant_off');
  assert.equal(AI.status().available, true);
  // The copilot off takes the assistant off, with the copilot's reason.
  assert.equal((await admin.post('/api/ai/attestation', { ...AGREEMENT, covers_assistant: true })).status, 201);
  assert.equal((await admin.put('/api/ai/settings', { assistant_enabled: true })).status, 200);
  assert.equal((await admin.put('/api/ai/settings', { enabled: false })).status, 200);
  assert.equal(AI.status().assistant.code, 'off');
  assert.equal((await admin.put('/api/ai/settings', { enabled: true })).status, 200);
  assert.equal(AI.status().assistant.available, true);
  // Withdrawing the agreement switches both off.
  assert.equal((await admin.del('/api/ai/attestation')).status, 200);
  assert.equal(AI.settings().assistant_enabled, false);
  assert.equal(calls.length, 0, 'nothing reached the provider');
});

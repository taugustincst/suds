'use strict';
// The AI documentation copilot (server/ai-copilot.js, server/routes/ai.js, docs/AI-COPILOT.md): who may use it,
// that it is off until an administrator records the BAA/QSOA and switches it on, what is sent to the provider
// (identifiers replaced, the request body's shape), the audit and usage trail (never the text), the monthly cap,
// what happens when the provider fails, and that a draft is never saved or signed by the copilot: a note it
// helped with is marked AI-assisted and signed only with the author's review statement.
// The provider is a local fake HTTP server: no call ever leaves this machine.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const H = require('./helpers');

let fake, fakeUrl;
const calls = [];
let reply = null; // (body) => { status, json, delay, raw }
function okJson(data, extra = {}) {
  return { status: 200, json: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 0 }, ...extra } };
}

let admin, sup, clin, nav, fin, clin2;
let clinUser, clientId, otherClientId, clientCode;
const SESSION = 'Maria Lopez (goes by Mari) came in with her sister Rosa. Mari said she has used fentanyl twice this week. Call her at (555) 201-3344 or mari.lopez@example.org. She lives at 42 Birch Street, Oakdale 95361. DOB 03/14/1988. Medi-Cal 91234567A. Counselor Pat Jones reviewed naloxone. Her SSN 123-45-6789 was on a form. Case 7654321. She grew up in Oakdale.';

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = null; try { body = JSON.parse(raw); } catch { body = null; }
      calls.push({ path: req.url, headers: req.headers, body, raw });
      const r = reply ? reply(body) : okJson({ narrative: 'x', gaps: [] });
      if (r.delay) await new Promise(ok => setTimeout(ok, r.delay));
      if (res.destroyed) return;
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(r.raw !== undefined ? r.raw : JSON.stringify(r.json));
    });
  });
  await new Promise(ok => fake.listen(0, '127.0.0.1', ok));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  process.env.SUDS_AI_BASE_URL = fakeUrl;
  process.env.ANTHROPIC_API_KEY = 'test-provider-key';
  delete process.env.SUDS_AI_TIMEOUT_MS;

  await H.start();
  clinUser = H.makeUser('aiclin', 'clinician');
  H.db.run(`UPDATE users SET display_name='Pat Jones' WHERE id=?`, clinUser.id);
  H.makeUser('aisup', 'supervisor'); H.makeUser('ainav', 'navigator'); H.makeUser('aifin', 'finance');
  H.makeCaseloadUser('aiclin2', 'clinician');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('aisup', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('aiclin', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('ainav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('aifin', 'StaffPassw0rd!x');
  clin2 = H.client(); await clin2.login('aiclin2', 'StaffPassw0rd!x');
  const c = await clin.post('/api/clients', { first_name: 'Maria', last_name: 'Lopez', preferred_name: 'Mari', dob: '1988-03-14', phone: '555-201-3344', email: 'mari.lopez@example.org',
    address: '42 Birch Street, Oakdale', city: 'Oakdale', zip: '95361', medicaid_id: '91234567A', emergency_contact: 'Rosa Lopez (sister) 555 777 8899', confirm_duplicate: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  clientId = c.data.id;
  clientCode = H.db.one(`SELECT client_code FROM clients WHERE id=?`, clientId).client_code;
  otherClientId = (await clin.post('/api/clients', { first_name: 'Other', last_name: 'Person', confirm_duplicate: true })).data.id;
});
after(async () => { await H.stop(); await new Promise(ok => fake.close(ok)); });

// Each person may ask for a dozen drafts a minute (routes/ai.js); the tests ask for more than that.
const fresh = () => { for (const u of H.db.all(`SELECT id FROM users`)) require('../server/app').rateLimitReset(`ai:${u.id}`); };
const lastAudit = (action) => H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action);
async function attestAndEnable() {
  const a = await admin.post('/api/ai/attestation', { provider: 'Anthropic', signed_by: 'County counsel office', agreement_date: '2026-01-15', reference: 'BAA-2026-017', baa: true, qsoa: true, counsel_reviewed: true });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const e = await admin.put('/api/ai/settings', { enabled: true });
  assert.equal(e.status, 200, JSON.stringify(e.data));
}

// ---------------------------------------------------------------- permission
test('ai:draft: clinicians, supervisors and navigators by default; not administrators, finance or read-only', () => {
  const auth = require('../server/auth');
  for (const role of ['clinician', 'supervisor', 'navigator']) assert.ok(auth.hasPerm({ role }, 'ai:draft'), role);
  for (const role of ['admin', 'finance', 'readonly']) assert.ok(!auth.hasPerm({ role }, 'ai:draft'), role);
  const P = require('../server/permissions');
  const entry = P.PERMISSION_CATALOG.find(p => p.name === 'ai:draft');
  assert.ok(entry && entry.risk === 'sensitive', 'in the catalog, as sensitive');
  assert.match(P.grantProblem('finance', auth.rolePerms ? auth.rolePerms('finance') : [], 'ai:draft') || '', /documents client work/);
});

test('a grant of ai:draft to a de-identified role is refused; a deny takes it from a clinician', async () => {
  fresh();
  const finId = H.db.one(`SELECT id FROM users WHERE username='aifin'`).id;
  const g = await admin.post(`/api/users/${finId}/permissions`, { permission: 'ai:draft', mode: 'grant', reason: 'test' });
  assert.equal(g.status, 400, JSON.stringify(g.data));
  H.deny(H.db.one(`SELECT id FROM users WHERE username='aiclin2'`), 'ai:draft');
  const c2 = H.client(); await c2.login('aiclin2', 'StaffPassw0rd!x');
  const r = await c2.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'DAP', source_text: 'x' });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------- gating
test('off by default: no attestation, no draft, and nothing is sent', async () => {
  fresh();
  const st = (await clin.get('/api/ai/status')).data;
  assert.equal(st.available, false); assert.equal(st.code, 'no_agreement'); assert.equal(st.can_draft, true);
  assert.match(st.reason, /agreement \(BAA \/ QSOA\)/);
  const before = calls.length;
  const r = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'DAP', source_text: 'Session text' });
  assert.equal(r.status, 409); assert.equal(r.data.ai_unavailable, 'no_agreement');
  assert.equal(calls.length, before, 'no call reached the provider');
});

test('settings: administrators only; switching on needs the attestation, whose every statement must be confirmed', async () => {
  fresh();
  assert.equal((await sup.get('/api/ai/settings')).status, 403);
  assert.equal((await clin.put('/api/ai/settings', { enabled: true })).status, 403);
  assert.equal((await sup.post('/api/ai/attestation', {})).status, 403);
  const on = await admin.put('/api/ai/settings', { enabled: true });
  assert.equal(on.status, 400); assert.ok(on.data.fields.enabled);
  const partial = await admin.post('/api/ai/attestation', { provider: 'Anthropic', signed_by: 'Director', agreement_date: '2026-01-15', reference: 'BAA-1', baa: true });
  assert.equal(partial.status, 400); assert.ok(partial.data.fields.qsoa && partial.data.fields.counsel_reviewed);
  const future = await admin.post('/api/ai/attestation', { provider: 'Anthropic', signed_by: 'Director', agreement_date: '2999-01-01', reference: 'BAA-1', baa: true, qsoa: true, counsel_reviewed: true });
  assert.equal(future.status, 400);
  const missingWho = await admin.post('/api/ai/attestation', { provider: 'Anthropic', agreement_date: '2026-01-15', reference: 'BAA-1', baa: true, qsoa: true, counsel_reviewed: true });
  assert.equal(missingWho.status, 400);
  // No provider key on the server: recorded, but it cannot be switched on.
  const key = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal((await admin.post('/api/ai/attestation', { provider: 'Anthropic', signed_by: 'Director', agreement_date: '2026-01-15', reference: 'BAA-1', baa: true, qsoa: true, counsel_reviewed: true })).status, 201);
    const nokey = await admin.put('/api/ai/settings', { enabled: true });
    assert.equal(nokey.status, 400); assert.match(nokey.data.error, /ANTHROPIC_API_KEY/);
  } finally { process.env.ANTHROPIC_API_KEY = key; }
  await attestAndEnable();
  const rec = lastAudit('ai.attestation.record');
  const d = JSON.parse(rec.details);
  assert.equal(d.reference, 'BAA-2026-017'); assert.equal(d.signed_by, 'County counsel office'); assert.equal(d.counsel_reviewed, true);
  const upd = JSON.parse(lastAudit('ai.settings.update').details);
  assert.equal(upd.enabled, true); assert.equal(upd.model, 'claude-opus-5-5');
  const s = (await admin.get('/api/ai/settings')).data;
  assert.equal(s.enabled, true); assert.equal(s.key_configured, true); assert.equal(s.attestation.reference, 'BAA-2026-017'); assert.equal(s.default_model, 'claude-opus-5-5');
  assert.ok(!JSON.stringify(s).includes('test-provider-key'), 'the key never leaves the server');
  assert.equal((await admin.put('/api/ai/settings', { model: 'gpt-4' })).status, 400, 'a model id is checked');
  assert.equal((await admin.put('/api/ai/settings', { monthly_cap: -1 })).status, 400);
  assert.equal((await clin.get('/api/ai/status')).data.available, true);
});

// ---------------------------------------------------------------- what is sent
test('a DAP note draft: the request body, identifiers replaced before sending, names put back after', async () => {
  fresh();
  reply = () => okJson({ sections: { D: '[CLIENT_PREFERRED_NAME] reported fentanyl use twice this week; [COUNSELOR] reviewed naloxone. Reach at [PHONE].', A: '[needs clinician input: assessment]', P: 'Follow up with [CLIENT_FIRST_NAME] [CLIENT_LAST_NAME] next week.' }, gaps: ['client response'] });
  const before = calls.length;
  const r = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'DAP', source_text: `${SESSION} Client code ${clientCode}.` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls.length, before + 1);
  const call = calls[calls.length - 1];
  // The request: the Messages API, the key in a header, the default model with its options.
  assert.equal(call.path, '/v1/messages');
  assert.equal(call.headers['x-api-key'], 'test-provider-key');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  const b = call.body;
  assert.equal(b.model, 'claude-opus-5-5'); assert.equal(b.max_tokens, 16000); assert.equal(b.fallbacks, 'default');
  assert.equal(b.output_config.effort, 'medium');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.deepEqual(b.output_config.format.schema.properties.sections.required, ['D', 'A', 'P']);
  assert.equal(b.output_config.format.schema.additionalProperties, false);
  assert.equal(b.system.length, 1); assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral' });
  assert.match(b.system[0].text, /never invent/i); assert.match(b.system[0].text, /\[needs clinician input\]/); assert.match(b.system[0].text, /person-first/);
  assert.match(b.system[0].text, /DAP format/);
  assert.equal(b.messages.length, 1); assert.equal(b.messages[0].role, 'user');
  assert.ok(!('thinking' in b) && !('temperature' in b));
  // Nothing SUDS knows about this client, nor the author's name, is in what was sent.
  for (const s of ['Maria', 'Lopez', 'Mari', 'Rosa', '201-3344', '(555) 201', 'mari.lopez', '42 Birch', 'Oakdale', '95361', '03/14/1988', '91234567A', '123-45-6789', '7654321', clientCode, 'Pat Jones', 'Jones']) {
    assert.ok(!call.raw.includes(s), `"${s}" was sent to the provider`);
  }
  const u = b.messages[0].content;
  for (const t of ['[CLIENT_FULL_NAME]', '[CLIENT_PREFERRED_NAME]', '[CONTACT_NAME]', '[PHONE]', '[EMAIL]', '[ADDRESS]', '[CITY]', '[ZIP]', '[DOB]', '[ID]', '[SSN]', '[NUMBER]', '[COUNSELOR]', '[CLIENT_CODE]']) assert.ok(u.includes(t), `${t} in the prompt`);
  assert.ok(u.includes('fentanyl twice this week'), 'the clinical content itself is sent');
  // The draft, with the names back and the other placeholders left for the author.
  assert.equal(r.data.structured, true); assert.equal(r.data.format, 'DAP');
  assert.equal(r.data.draft.sections.D, 'Mari reported fentanyl use twice this week; Pat Jones reviewed naloxone. Reach at [PHONE].');
  assert.equal(r.data.draft.sections.P, 'Follow up with Maria Lopez next week.');
  assert.deepEqual(r.data.gaps, ['client response']);
  assert.equal(r.data.notice, 'AI draft — review before signing');
  assert.ok(r.data.identifiers_replaced.name >= 3);
});

test('audit and usage: who, which client, feature, model, tokens; never the text', async () => {
  fresh();
  const a = lastAudit('ai.draft');
  assert.equal(a.client_id, clientId); assert.equal(a.user_id, clinUser.id); assert.equal(a.success, 1);
  const d = JSON.parse(a.details);
  assert.equal(d.feature, 'note'); assert.equal(d.format, 'DAP'); assert.equal(d.kind, 'clinical'); assert.equal(d.model, 'claude-opus-5-5');
  assert.equal(d.input_tokens, 1200); assert.equal(d.output_tokens, 340); assert.equal(d.outcome, 'ok');
  for (const s of ['fentanyl', 'Maria', 'Mari', 'naloxone', 'Birch']) assert.ok(!a.details.includes(s), `"${s}" in the audit details`);
  const u = H.db.one(`SELECT * FROM ai_usage ORDER BY at DESC LIMIT 1`);
  assert.equal(u.feature, 'note'); assert.equal(u.outcome, 'ok'); assert.equal(u.user_id, clinUser.id); assert.equal(u.input_tokens, 1200);
  assert.ok(!Object.keys(u).some(k => /client|text|prompt/.test(k)), 'no client or text column');
});

test('a draft is never saved: no note is written; the author saves it, marked AI-assisted, and signs only with the review statement', async () => {
  fresh();
  const n0 = H.db.one(`SELECT COUNT(*) n FROM notes`).n;
  reply = () => okJson({ narrative: 'Draft text.', gaps: [] });
  assert.equal((await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'narrative', source_text: 'text' })).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM notes`).n, n0, 'the draft route writes no note');
  const saved = await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', format: 'narrative', content: 'Reviewed and corrected text.', occurred_at: new Date().toISOString(), ai_assisted: true });
  assert.equal(saved.status, 201);
  const row = H.db.one(`SELECT status, ai_assisted FROM notes WHERE id=?`, saved.data.id);
  assert.equal(row.status, 'draft'); assert.equal(row.ai_assisted, 1);
  assert.equal(JSON.parse(lastAudit('note.create').details).ai_assisted, true);
  // The mark cannot be taken off by a later save.
  assert.equal((await clin.put(`/api/notes/${saved.data.id}`, { ai_assisted: false, content: 'Edited again.' })).status, 200);
  assert.equal(H.db.one(`SELECT ai_assisted FROM notes WHERE id=?`, saved.data.id).ai_assisted, 1);
  const noReview = await clin.post(`/api/notes/${saved.data.id}/sign`, { password: 'StaffPassw0rd!x' });
  assert.equal(noReview.status, 400); assert.equal(noReview.data.ai_review_required, true);
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, saved.data.id).status, 'draft');
  const signed = await clin.post(`/api/notes/${saved.data.id}/sign`, { password: 'StaffPassw0rd!x', ai_reviewed: true });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  const after = H.db.one(`SELECT status, ai_assisted FROM notes WHERE id=?`, saved.data.id);
  assert.equal(after.status, 'signed'); assert.equal(after.ai_assisted, 1, 'the signed note records it was AI-assisted');
  const sign = JSON.parse(lastAudit('note.sign').details);
  assert.equal(sign.ai_assisted, true); assert.equal(sign.ai_reviewed, true);
  assert.equal((await clin.get(`/api/notes/${saved.data.id}`)).data.note.ai_assisted, 1);
  // A signed note cannot be redrafted by the copilot.
  const redo = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'narrative', source_text: 'x', note_id: saved.data.id });
  assert.equal(redo.status, 400);
  // A note without AI text signs as before.
  const plain = await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Own words.', occurred_at: new Date().toISOString() });
  assert.equal((await clin.post(`/api/notes/${plain.data.id}/sign`, { password: 'StaffPassw0rd!x' })).status, 200);
});

test('Part 2: the copilot drafts only in the author\'s own note, for a client in their reach, of a kind they may write', async () => {
  fresh();
  reply = () => okJson({ narrative: 'x', gaps: [] });
  const supNote = await sup.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Supervisor draft', occurred_at: new Date().toISOString() });
  const other = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x', note_id: supNote.data.id });
  assert.equal(other.status, 403); assert.match(other.data.error, /your own note/);
  const wrongClient = await clin.post('/api/ai/draft/note', { client_id: otherClientId, kind: 'clinical', source_text: 'x', note_id: supNote.data.id });
  assert.equal(wrongClient.status, 404);
  assert.equal((await nav.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x' })).status, 403, 'a navigator writes no clinical notes');
  assert.equal((await nav.post('/api/ai/draft/note', { client_id: clientId, kind: 'admin', format: 'contact', source_text: 'Called about housing.' })).status, 200, 'a navigator drafts an admin note');
  assert.equal((await fin.post('/api/ai/draft/note', { client_id: clientId, kind: 'admin', source_text: 'x' })).status, 403);
  assert.equal((await admin.post('/api/ai/draft/note', { client_id: clientId, kind: 'admin', source_text: 'x' })).status, 403, 'administrators do not hold ai:draft');
  assert.equal((await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'safety_plan', source_text: 'x' })).status, 400, 'no safety plans');
  assert.equal((await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x'.repeat(30001) })).status, 400, 'text is capped');
});

test('a caseload-scoped clinician cannot draft for a client outside their caseload', async () => {
  fresh();
  const cs = H.makeCaseloadUser('aiclin3', 'clinician');
  const c3 = H.client(); await c3.login(cs.username, cs.password);
  const before = calls.length;
  const r = await c3.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x' });
  assert.ok([403, 404].includes(r.status), String(r.status));
  assert.equal(calls.length, before);
});

// ---------------------------------------------------------------- the other features
test('six-dimension assessment: narratives and suggested ratings, checked; nothing saved', async () => {
  fresh();
  const dims = { d1: { narrative: 'No withdrawal signs reported by [CLIENT_FIRST_NAME].', suggested_rating: '1', rationale: 'r' }, d2: { narrative: '[needs clinician input]', suggested_rating: 'insufficient information', rationale: '' },
    d3: { narrative: 'n', suggested_rating: '2', rationale: 'r' }, d4: { narrative: 'n', suggested_rating: '7', rationale: 'r' }, d5: { narrative: 'n', suggested_rating: '3', rationale: 'r' }, d6: { narrative: 'n', suggested_rating: '0', rationale: 'r' } };
  reply = () => okJson({ dimensions: dims, gaps: ['medical history'] });
  const a0 = H.db.one(`SELECT COUNT(*) n FROM asam_assessments`).n;
  const r = await clin.post('/api/ai/draft/asam', { client_id: clientId, source_text: SESSION });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.dimensions.d1.narrative, 'No withdrawal signs reported by Maria.');
  assert.equal(r.data.dimensions.d1.suggested_rating, 1);
  assert.equal(r.data.dimensions.d2.suggested_rating, null);
  assert.equal(r.data.dimensions.d4.suggested_rating, null, 'an out-of-range rating is dropped');
  assert.equal(r.data.dimensions.d6.suggested_rating, 0);
  const schema = calls[calls.length - 1].body.output_config.format.schema;
  assert.deepEqual(schema.properties.dimensions.required, ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
  assert.ok(!calls[calls.length - 1].raw.includes('Lopez'));
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM asam_assessments`).n, a0);
  assert.equal((await nav.post('/api/ai/draft/asam', { client_id: clientId, source_text: 'x' })).status, 403, 'assessments:write needed');
});

test('care plan: from this client\'s assessment (de-identified) and notes; another client\'s assessment is refused', async () => {
  fresh();
  const asam = await clin.post(`/api/clients/${clientId}/asam`, { assessed_at: '2026-09-01', d1_rating: 1, d2_rating: 0, d3_rating: 2, d4_rating: 2, d5_rating: 3, d6_rating: 3, dimension_notes: { d5: 'Maria Lopez reports cravings daily.', d6: 'Staying with Rosa.' }, summary: 'Mari wants outpatient.' });
  assert.equal(asam.status, 201, JSON.stringify(asam.data));
  const otherAsam = await clin.post(`/api/clients/${otherClientId}/asam`, { assessed_at: '2026-09-01', d1_rating: 0, d2_rating: 0, d3_rating: 0, d4_rating: 0, d5_rating: 0, d6_rating: 0 });
  assert.equal((await clin.post('/api/ai/draft/careplan', { client_id: clientId, assessment_id: otherAsam.data.id })).status, 404, 'never another client\'s data');
  assert.equal((await clin.post('/api/ai/draft/careplan', { client_id: clientId })).status, 400);
  reply = () => okJson({ entries: [{ problem: 'Daily cravings', goal: '"I want to stop using" says [CLIENT_PREFERRED_NAME]', objectives: ['Attend 2 groups weekly for 4 weeks'], interventions: ['Relapse prevention counseling'], evidence: 'd5' }], gaps: [] });
  const r = await clin.post('/api/ai/draft/careplan', { client_id: clientId, assessment_id: asam.data.id, source_text: 'Wants help with housing.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.entries.length, 1); assert.equal(r.data.entries[0].goal, '"I want to stop using" says Mari');
  const call = calls[calls.length - 1];
  assert.ok(call.body.messages[0].content.includes('[CLIENT_FULL_NAME] reports cravings daily'));
  for (const s of ['Maria', 'Lopez', 'Rosa', 'Mari ']) assert.ok(!call.raw.includes(s), `"${s}" sent`);
  assert.equal(JSON.parse(lastAudit('ai.draft').details).assessment_id, asam.data.id);
  assert.equal((await fin.post('/api/ai/draft/careplan', { client_id: clientId, source_text: 'x' })).status, 403);
});

test('CalOMS: suggestions checked against the code sets; identifying elements are never asked for', async () => {
  fresh();
  reply = () => okJson({ suggestions: [
    { field: 'primary_drug', value: '21', evidence: 'fentanyl' }, { field: 'primary_route', value: '9', evidence: 'bad code' },
    { field: 'race', value: '01, 19, 77', evidence: 'said' }, { field: 'primary_days_used', value: '2', evidence: 'twice' }, { field: 'prior_episodes', value: '-3', evidence: 'x' },
    { field: 'primary_drug', value: '01', evidence: 'duplicate' }], gaps: [] });
  const r = await clin.post('/api/ai/draft/caloms', { client_id: clientId, record_type: 'admission', source_text: SESSION });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const by = Object.fromEntries(r.data.suggestions.map(s => [s.field, s.value]));
  assert.deepEqual(by, { primary_drug: '21', race: ['01', '19'], primary_days_used: 2 });
  assert.equal(r.data.dropped, 3);
  const schema = calls[calls.length - 1].body.output_config.format.schema;
  const fields = schema.properties.suggestions.items.properties.field.enum;
  assert.ok(fields.includes('primary_drug')); assert.ok(!fields.includes('zip_code'));
  assert.equal((await fin.post('/api/ai/draft/caloms', { client_id: clientId, record_type: 'admission', source_text: 'x' })).status, 403);
});

// ---------------------------------------------------------------- failures
test('provider failures: rate limit, down, overloaded, refusal, cut off, unreadable, timeout; the form is untouched and it is audited', async () => {
  fresh();
  const cases = [
    [() => ({ status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, headers: { 'retry-after': '30' } }), 503, 'rate_limited'],
    [() => ({ status: 500, json: { type: 'error', error: { type: 'api_error', message: 'x' } } }), 503, 'unavailable'],
    [() => ({ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'x' } } }), 503, 'unavailable'],
    [() => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'x' } } }), 502, 'auth'],
    [() => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'x' } } }), 502, 'rejected'],
    [() => okJson({}, { stop_reason: 'refusal', content: [] }), 422, 'refused'],
    [() => okJson({ narrative: 'half' }, { stop_reason: 'max_tokens' }), 502, 'truncated'],
    [() => ({ status: 200, raw: '{"content":[{"type":"text","text":"not json"}],"stop_reason":"end_turn"}' }), 502, 'bad_response'],
  ];
  for (const [fn, status, kind] of cases) {
    reply = fn; fresh();
    const n0 = H.db.one(`SELECT COUNT(*) n FROM notes`).n;
    const r = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', format: 'SOAP', source_text: 'Session' });
    assert.equal(r.status, status, `${kind}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.ai_error, kind);
    assert.match(r.data.error, /form is unchanged/);
    assert.equal(H.db.one(`SELECT COUNT(*) n FROM notes`).n, n0);
    const a = lastAudit('ai.draft'); assert.equal(a.success, 0); assert.equal(JSON.parse(a.details).outcome, kind);
    assert.equal(H.db.one(`SELECT outcome FROM ai_usage ORDER BY rowid DESC LIMIT 1`).outcome, kind);
    if (kind === 'rate_limited') assert.equal(r.data.retry_after, '30');
  }
  process.env.SUDS_AI_TIMEOUT_MS = '1000';
  try {
    reply = () => ({ ...okJson({ narrative: 'late', gaps: [] }), delay: 1600 });
    const r = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'Session' });
    assert.equal(r.status, 504); assert.equal(r.data.ai_error, 'timeout');
  } finally { delete process.env.SUDS_AI_TIMEOUT_MS; }
  // Unreachable: nothing listening there.
  const url = process.env.SUDS_AI_BASE_URL; process.env.SUDS_AI_BASE_URL = 'http://127.0.0.1:1';
  try {
    const r = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'Session' });
    assert.equal(r.status, 503); assert.equal(r.data.ai_error, 'unreachable');
  } finally { process.env.SUDS_AI_BASE_URL = url; }
  // A remote endpoint must be https.
  process.env.SUDS_AI_BASE_URL = 'http://ai.example.org';
  try {
    const st = (await clin.get('/api/ai/status')).data;
    assert.equal(st.available, false); assert.equal(st.code, 'endpoint');
  } finally { process.env.SUDS_AI_BASE_URL = url; }
});

test('the monthly cap: once reached, no call is sent until next month', async () => {
  fresh();
  reply = () => okJson({ narrative: 'x', gaps: [] });
  const used = (await admin.get('/api/ai/settings')).data.usage.calls;
  assert.ok(used > 0);
  assert.equal((await admin.put('/api/ai/settings', { monthly_cap: used + 1 })).status, 200);
  assert.equal((await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x' })).status, 200);
  const before = calls.length;
  const r = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x' });
  assert.equal(r.status, 429); assert.equal(r.data.ai_error, 'cap'); assert.match(r.data.error, /used its/);
  assert.equal(calls.length, before);
  const st = (await clin.get('/api/ai/status')).data;
  assert.equal(st.code, 'cap'); assert.equal(st.used_this_month, used + 1);
  assert.equal((await admin.put('/api/ai/settings', { monthly_cap: 500 })).status, 200);
});

test('another model: the setting is used, without the default model\'s options', async () => {
  fresh();
  reply = () => okJson({ narrative: 'x', gaps: [] });
  assert.equal((await admin.put('/api/ai/settings', { model: 'claude-test-model' })).status, 200);
  assert.equal((await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x' })).status, 200);
  const call = calls[calls.length - 1];
  assert.equal(call.body.model, 'claude-test-model');
  assert.ok(!('fallbacks' in call.body) && !('effort' in call.body.output_config) && !call.headers['anthropic-beta']);
  assert.equal(JSON.parse(lastAudit('ai.draft').details).model, 'claude-opus-5-5', 'the model the provider reports serving');
  assert.equal((await admin.put('/api/ai/settings', { model: '' })).status, 200);
  assert.equal((await admin.get('/api/ai/settings')).data.model, 'claude-opus-5-5');
});

test('withdrawing the attestation switches the copilot off at once', async () => {
  fresh();
  const r = await admin.del('/api/ai/attestation');
  assert.equal(r.status, 200);
  const st = (await clin.get('/api/ai/status')).data;
  assert.equal(st.available, false); assert.equal(st.enabled, false); assert.equal(st.code, 'no_agreement');
  assert.ok(lastAudit('ai.attestation.withdraw'));
  assert.equal((await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x' })).status, 409);
  await attestAndEnable();
});

test('a device has no copilot: the local kernel does not load its routes', () => {
  const { LOCAL_ROUTE_MODULES, ROUTE_MODULES } = require('../server/app');
  assert.ok(ROUTE_MODULES.includes('ai')); assert.ok(!LOCAL_ROUTE_MODULES.includes('ai'));
  const kernel = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'local', 'kernel.js'), 'utf8');
  assert.ok(!/routes\/ai\.js/.test(kernel));
});

// ---------------------------------------------------------------- de-identification (pure)
test('de-identification: patterns masked whoever they belong to; names only put back', () => {
  const A = require('../server/ai-copilot');
  const d = A.deidentify('Call 916.555.0100 or +1 (530) 555-0199, write to a.b@c.io, see https://x.org/p, SSN 111 22 3333, MRN 12345678, CIN 98765432B, lives at 1200 N Main St Apt 4. Took 20 mg on 3/2.', []);
  assert.equal(d.text, 'Call [PHONE] or [PHONE], write to [EMAIL], see [URL], SSN [SSN], MRN [NUMBER], CIN [ID], lives at [ADDRESS]. Took 20 mg on 3/2.');
  assert.deepEqual(d.counts, { phone: 2, email: 1, url: 1, ssn: 1, number: 1, id: 1, address: 1 });
  // A placeholder never matches a later pattern, and a name inside another word is left alone.
  const ids = [{ pattern: /(?<![\p{L}\p{N}])Ann(?![\p{L}\p{N}])/giu, token: 'CLIENT_FIRST_NAME', kind: 'name', reinsert: 'Ann' }];
  assert.equal(A.deidentify('Ann met Anne at the annex; ANN left.', ids).text, '[CLIENT_FIRST_NAME] met Anne at the annex; [CLIENT_FIRST_NAME] left.');
  assert.deepEqual(A.reidentify({ a: ['[CLIENT_FIRST_NAME] called [PHONE]'] }, ids), { a: ['Ann called [PHONE]'] });
});

test('one person may ask for a dozen drafts a minute', async () => {
  fresh(); reply = () => okJson({ narrative: 'x', gaps: [] });
  for (let i = 0; i < 12; i++) assert.equal((await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x' })).status, 200);
  const before = calls.length;
  const r = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x' });
  assert.equal(r.status, 429); assert.equal(calls.length, before);
  fresh();
});

// ---------------------------------------------------------------- 1.17.0 pre-release reviews (r10)
test('a draft asked for in a saved note marks that note AI-assisted on the server (security review r10, L1)', async () => {
  fresh(); reply = () => okJson({ narrative: 'Draft.', gaps: [] });
  const n = await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Own words so far.', occurred_at: new Date().toISOString() });
  assert.equal(n.status, 201);
  assert.equal(H.db.one(`SELECT ai_assisted FROM notes WHERE id=?`, n.data.id).ai_assisted, 0);
  assert.equal((await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x', note_id: n.data.id })).status, 200);
  assert.equal(H.db.one(`SELECT ai_assisted FROM notes WHERE id=?`, n.data.id).ai_assisted, 1, 'set by the draft route, not left to the browser');
  assert.equal(JSON.parse(lastAudit('ai.draft').details).note_id, n.data.id, 'the draft is recorded against the note');
  const noReview = await clin.post(`/api/notes/${n.data.id}/sign`, { password: 'StaffPassw0rd!x' });
  assert.equal(noReview.status, 400, 'so signing asks for the review statement'); assert.equal(noReview.data.ai_review_required, true);
});

test('the copilot does not draft a SUD counseling note, and a note with copilot text cannot become one (market review r10, 1)', async () => {
  fresh(); reply = () => okJson({ narrative: 'Draft.', gaps: [] });
  const before = calls.length;
  const c = await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Session analysis.', occurred_at: new Date().toISOString(), counseling_note: true });
  assert.equal(c.status, 201);
  const r = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x', note_id: c.data.id });
  assert.equal(r.status, 400, JSON.stringify(r.data)); assert.equal(r.data.ai_error, 'counseling_note');
  const unsaved = await clin.post('/api/ai/draft/note', { client_id: clientId, kind: 'clinical', source_text: 'x', counseling_note: true });
  assert.equal(unsaved.status, 400, 'nor one being written that is ticked as one');
  assert.equal(calls.length, before, 'nothing was sent');
  assert.equal(H.db.one(`SELECT ai_assisted FROM notes WHERE id=?`, c.data.id).ai_assisted, 0);
  // The other way round: an AI-assisted note cannot be flagged a counseling note, nor created as both.
  const a = await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Drafted.', occurred_at: new Date().toISOString(), ai_assisted: true });
  assert.equal((await clin.put(`/api/notes/${a.data.id}`, { counseling_note: true })).status, 400);
  assert.equal(H.db.one(`SELECT counseling_note FROM notes WHERE id=?`, a.data.id).counseling_note, 0);
  assert.equal((await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'x', occurred_at: new Date().toISOString(), ai_assisted: true, counseling_note: true })).status, 400);
});

test('a client with an agreed restriction: the copilot refuses to send their text (security review r10, L6)', async () => {
  fresh(); reply = () => okJson({ narrative: 'Draft.', gaps: [] });
  const r0 = await clin.post('/api/clients', { first_name: 'Rhea', last_name: 'Restricted', confirm_duplicate: true });
  const adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  H.db.run(`INSERT INTO patient_requests(id,client_id,kind,received_at,due_at,status,created_by) VALUES(?,?,?,?,?,?,?)`, require('node:crypto').randomUUID(), r0.data.id, 'restriction', '2026-09-01', '2026-10-01', 'fulfilled', adminId);
  const before = calls.length;
  for (const [path, body] of [['/api/ai/draft/note', { kind: 'clinical', source_text: 'x' }], ['/api/ai/draft/asam', { source_text: 'x' }], ['/api/ai/draft/caloms', { record_type: 'admission', source_text: 'x' }]]) {
    const r = await clin.post(path, { client_id: r0.data.id, ...body });
    assert.equal(r.status, 409, `${path}: ${JSON.stringify(r.data)}`); assert.equal(r.data.ai_error, 'restriction'); assert.match(r.data.error, /restriction/);
  }
  assert.equal(calls.length, before, 'nothing was sent');
  const a = JSON.parse(lastAudit('ai.draft').details);
  assert.equal(a.outcome, 'restriction');
});

test('de-identification: accents, apostrophes, more date-of-birth forms, abbreviated streets; the counselor\'s surname only as a name (security review r10, L5)', async () => {
  const A = require('../server/ai-copilot');
  const c = await clin.post('/api/clients', { first_name: 'José', last_name: "O'Brien-Nakamura", preferred_name: 'JoJo', dob: '1988-03-04', phone: '(555) 201-3345', address: '1200 Old Mill Road Apt 4, Oakdale', city: 'Oakdale', zip: '95361', confirm_duplicate: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const ids = A.identifiersFor(c.data.id, { display_name: 'Pat Jones' });
  const d = (s) => A.deidentify(s, ids).text;
  assert.equal(d('Jose OBrien came in'), '[CLIENT_FIRST_NAME] [CLIENT_LAST_NAME] came in');
  assert.equal(d('JOSÉ said'), '[CLIENT_FIRST_NAME] said');
  assert.equal(d('Obrien-Nakamura, Jose'), '[CLIENT_FULL_NAME]');
  assert.equal(d('Obrien Nakamura was late'), '[CLIENT_LAST_NAME] was late');
  for (const dob of ['March 4th, 1988', 'march 4 1988', '4th March 1988', 'Mar. 4th, 1988', '1988/03/04', '1988/3/4', '03.04.1988', '3.4.1988', '4/3/88', '04/03/1988']) assert.equal(d(`DOB ${dob}.`), 'DOB [DOB].', dob);
  assert.equal(d('lives on Old Mill Rd'), 'lives on [ADDRESS]');
  assert.equal(d('at 1200 old mill road'), 'at [ADDRESS]');
  assert.equal(d('someone else born 1/2/1990'), 'someone else born [DOB]', 'a date said to be a birth date is masked whoever it belongs to');
  assert.equal(d('Pat said'), '[COUNSELOR] said');
  assert.equal(d('Counselor Jones reviewed it. Jones will call.'), 'Counselor [COUNSELOR] reviewed it. [COUNSELOR] will call.');
  assert.equal(d('Patricia Jones visited'), 'Patricia Jones visited', 'another person who shares the surname is not the counselor');
  assert.equal(d('she keeps up with the jones family'), 'she keeps up with the jones family', 'lower case: a word, not the counselor');
  // Put back as the record spells them.
  assert.deepEqual(A.reidentify({ t: '[CLIENT_FIRST_NAME] [CLIENT_LAST_NAME]' }, ids), { t: "José O'Brien-Nakamura" });
});

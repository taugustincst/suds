'use strict';
// Direct unit tests for three modules the suite exercised only indirectly (independent evaluation of 1.28.0,
// item 7): the client-list/dashboard filter fragments, the password-weakness floor, and the AI prompt builders.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const filters = require('../server/client-filters');
const { weakness, COMMON } = require('../server/password-strength');
const prompts = require('../server/ai-prompts');

before(async () => { await H.start(); });
after(async () => { await H.stop(); });

// ---- client-filters: the fragments are shaped right AND are valid SQL against the real schema ----
test('client-filters: risk levels map high→high+critical, blank→not_assessed, else exact', () => {
  assert.deepEqual(filters.risk('high'), { sql: `c.risk_level IN ('high','critical')`, params: [] });
  assert.match(filters.risk('not_assessed').sql, /COALESCE\(c\.risk_level,''\)=''/);
  assert.deepEqual(filters.risk('low'), { sql: 'c.risk_level=?', params: ['low'] });
});

test('client-filters: substance/mat fold a blank into "unknown"', () => {
  assert.deepEqual(filters.substance('opioids'), { sql: `COALESCE(c.primary_substance,'unknown')=?`, params: ['opioids'] });
  assert.deepEqual(filters.mat('none'), { sql: `COALESCE(c.mat_status,'unknown')=?`, params: ['none'] });
});

test('client-filters: consentWindow is today..+30d, and consentExpiring uses it', () => {
  const w = filters.consentWindow();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(w.from) && /^\d{4}-\d{2}-\d{2}$/.test(w.to), 'ISO dates');
  assert.ok(w.to > w.from, 'the window runs forward');
  const e = filters.consentExpiring(w);
  assert.match(e.sql, /expires_at BETWEEN \? AND \?/);
  assert.deepEqual(e.params, [w.from, w.to]);
});

test('client-filters: every fragment is valid SQL against the real schema (aliased c)', () => {
  const run = (f) => H.db.one(`SELECT COUNT(*) n FROM clients c WHERE ${f.sql}`, ...f.params).n;
  for (const f of [filters.risk('high'), filters.risk('not_assessed'), filters.risk('low'),
    filters.substance('opioids'), filters.mat('none'), filters.noContactSince(), filters.consentExpiring(),
    filters.openPatientRequest()]) {
    assert.equal(typeof run(f), 'number', `fragment ran: ${f.sql.slice(0, 40)}`);
  }
});

// ---- password-strength: the weakness floor ----
test('password-strength: refuses the username and the person\'s name, leet included', () => {
  assert.match(weakness('jsmith2026!', { username: 'jsmith' }), /username/);
  assert.match(weakness('Jsm1th-2026!', { username: 'jsmith' }), /username/, 'look-alikes read back as letters');
  assert.match(weakness('Rosalind99!!', { display_name: 'Rosalind Nguyen' }), /name/);
  assert.equal(weakness('unrelated-tokens-42!', { username: 'jsmith', display_name: 'Rosalind Nguyen' }), null);
});

test('password-strength: refuses a common word dressed up, and too few distinct characters', () => {
  assert.match(weakness('Password2026!'), /too common/);
  assert.match(weakness('Summer2026!!'), /too common/);
  assert.match(weakness('P@ssw0rd1234'), /too common/, 'leetspeak is unmasked');
  assert.match(weakness('Aa1!Aa1!Aa1!'), /too few different characters/);
});

test('password-strength: a passphrase of unrelated words passes, and a non-string is ignored', () => {
  assert.equal(weakness('violet-anchor-ledger-7', {}), null);
  assert.equal(weakness(undefined, {}), null);
  assert.ok(Array.isArray(COMMON) && COMMON.includes('password') && COMMON.includes('suds'));
});

// ---- ai-prompts: the prompt builders ----
test('ai-prompts: assistantPrompt carries the draft + assistant rules, scopes the citable section ids, and rejects an unknown scope', () => {
  for (const scope of ['client', 'day', 'programme']) {
    const p = prompts.assistantPrompt(scope);
    assert.ok(p.system.includes('substance use disorder'), 'the draft RULES travel with it');
    assert.ok(p.system.includes('answering a staff member'), 'the assistant rules follow');
    assert.deepEqual(p.schema.properties.citations.items.properties.section.enum, prompts.ASSISTANT_SECTIONS[scope],
      'only this scope\'s section ids may be cited');
  }
  assert.throws(() => prompts.assistantPrompt('nope'), /Unknown assistant scope/);
});

test('ai-prompts: note/asam/careplan/caloms builders return a system prompt and a schema; caloms enumerates its fields', () => {
  const note = prompts.notePrompt({ format: 'SOAP', kind: 'progress', text: 'seen today' });
  assert.ok(note.system && note.schema, 'note prompt has system + schema');
  assert.ok(prompts.asamPrompt({ text: 'x' }).schema && prompts.careplanPrompt({ text: 'x' }).schema);
  const fields = prompts.calomsFields('admission');
  assert.ok(Array.isArray(fields) && fields.length > 0);
  const caloms = prompts.calomsPrompt({ type: 'admission', text: 'intake notes' });
  assert.ok(caloms.system.includes('CalOMS Tx admission'));
  assert.equal(caloms.schema.properties.suggestions.items.properties.field.enum.length, fields.length, 'every field is a valid suggestion target');
});

test('ai-prompts: the identifier placeholders include the sensitive ones the copilot names back', () => {
  for (const ph of ['CLIENT_FULL_NAME', 'DOB', 'SSN', 'PHONE', 'ADDRESS']) assert.ok(prompts.PLACEHOLDERS.includes(ph), ph);
  assert.ok(prompts.NOTE_FORMATS.includes('narrative') && prompts.NOTE_FORMATS.includes('SOAP'));
});

// The AI documentation copilot (1.17.0, docs/AI-COPILOT.md) in a real browser, against a fake AI provider this
// script runs itself (run-all.sh points the office server at it: SUDS_AI_BASE_URL, ANTHROPIC_API_KEY). Nothing
// leaves the machine.
//   1. Settings › AI copilot: the data-handling explanation and counsel notice, the agreement recorded, the
//      copilot switched on; axe-clean before and after.
//   2. A clinician's note: the copilot panel in the note form (axe-clean), a DAP draft put into the sections
//      under "AI draft — review before signing", the client's name never sent and put back after; Save & sign
//      asks for the review statement, and the signed note is AI-assisted.
//   3. The provider overloaded: the error is said, the form is exactly as it was and saves by hand.
//   4. The six-dimension assessment: narratives drafted, ratings suggested but not chosen, and the form will not
//      save until every dimension is marked reviewed.
//   5. Care plan suggestions, added one at a time (axe-clean dialog).
//   6. CalOMS suggestions in the admission dialog, applied one by one.
//   7. SUDS on this device: no copilot, and it says why.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const staticBase = process.env.SUDS_STATIC_URL || null;
const PW = 'Navigator2026!!';
const FAKE_PORT = Number(process.env.SUDS_AI_FAKE_PORT || 8097);
const { ok, eq, fail, finish } = makeChecks('r10-ai');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const errors = [];

// ---------------------------------------------------------------- the fake provider
// Answers in the shape each feature's request asks for (its JSON schema), echoing placeholders so the
// re-insertion of names can be seen in the browser. `mode` makes it fail.
const calls = [];
let mode = 'ok';
function answerFor(schema) {
  const p = schema.properties || {};
  if (p.sections) return { sections: Object.fromEntries(Object.keys(p.sections.properties).map((k) => [k, `${k}: [CLIENT_FIRST_NAME] discussed cravings and coping skills. [needs clinician input: client response]`])), gaps: ['client response to the intervention'] };
  if (p.narrative) return { narrative: '[CLIENT_FIRST_NAME] attended and discussed housing.', gaps: [] };
  if (p.dimensions) return { dimensions: Object.fromEntries(Object.keys(p.dimensions.properties).map((k, i) => [k, { narrative: `${k}: what the intake notes say about [CLIENT_FIRST_NAME].`, suggested_rating: i === 1 ? 'insufficient information' : String(i % 4), rationale: 'from the intake notes' }])), gaps: ['medical history'] };
  if (p.entries) return { entries: [{ problem: 'Daily cravings', goal: '[needs clinician input: confirm in client\'s words] Stop using fentanyl', objectives: ['Attend two groups a week for four weeks'], interventions: ['Relapse prevention counseling weekly'], evidence: 'dimension 5' }], gaps: [] };
  if (p.suggestions) return { suggestions: [{ field: 'primary_drug', value: '21', evidence: 'uses fentanyl' }, { field: 'primary_route', value: '2', evidence: 'smokes it' }], gaps: [] };
  return { gaps: [] };
}
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { body = null; }
    calls.push({ raw, body, key: req.headers['x-api-key'] });
    if (mode === 'overloaded') { res.writeHead(529, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })); return; }
    const data = answerFor(body?.output_config?.format?.schema || {});
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: body?.model || 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 900, output_tokens: 200 } }));
  });
});
await new Promise((ok2, bad) => { fake.once('error', bad); fake.listen(FAKE_PORT, '127.0.0.1', ok2); });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
async function session(username, password, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('response', r => { if (r.status() >= 500 && !/\/api\/ai\/draft/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 });
  await page.evaluate((h) => fetch('/api/me/prefs', { method: 'PUT', headers: h, body: JSON.stringify({ tour_done: true }) }), H);
  await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body, h }) => { const r = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body, h: H });
  const go = async (hash) => { await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await settle(page); };
  return { ctx, page, api, go };
}
async function axe(page, where) {
  if (!axeSource) { fail('axe-core is not installed (npm i --no-save axe-core)'); return; }
  await page.evaluate(axeSource + ';0');
  const v = await page.evaluate(async () => {
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading', 'landmark-unique'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
}
const openPanel = async (page, key) => {
  await page.click(`[data-ai-panel="${key}"] > summary`);
  await page.waitForSelector(`[data-ai-panel="${key}"] textarea`, { timeout: 10000 });
};

try {
  // ------------------------------------------------------------------------------------------------ 1
  const admin = await session('admin', 'AdminPassw0rd!x');
  {
    const { page, api, go } = admin;
    const s0 = await api('GET', '/api/ai/settings');
    eq(s0.status, 200, 'the administrator reads the copilot settings');
    ok(s0.data && s0.data.key_configured, 'the office server has a provider key (run-all.sh sets ANTHROPIC_API_KEY for the fake provider)', s0.data);
    eq(s0.data && s0.data.enabled, false, 'the copilot is off by default');
    await go('admin?tab=ai');
    await page.waitForSelector('[data-ai-settings]');
    ok(await page.$('[data-ai-counsel]'), 'Settings › AI copilot says counsel must review this use');
    ok(/not de-identification/.test(await page.textContent('[data-ai-settings]')), 'and says plainly the masking is not de-identification');
    ok(await page.$('[data-ai-attestation="none"]'), 'no agreement is recorded yet');
    await axe(page, 'Settings › AI copilot, no agreement');
    // Switching on first is refused, with the reason.
    const early = await api('PUT', '/api/ai/settings', { enabled: true });
    eq(early.status, 400, 'the copilot cannot be switched on before the agreement is recorded');
    const f = '[data-ai-attestation] form';
    await page.fill(`${f} input[name=signed_by]`, 'Dana Director, Program Director');
    await page.fill(`${f} input[name=agreement_date]`, '2026-01-15');
    await page.fill(`${f} input[name=reference]`, 'BAA-2026-017');
    for (const n of ['baa', 'qsoa', 'counsel_reviewed']) await page.check(`${f} input[name=${n}]`);
    await page.click(`${f} button[type=submit]`);
    await page.waitForSelector('[data-ai-attestation="recorded"]', { timeout: 10000 });
    ok(/BAA-2026-017/.test(await page.textContent('[data-ai-attestation]')), 'the recorded agreement shows its reference');
    await page.check('[data-ai-switch] input[name=enabled]');
    await page.click('[data-ai-switch] button[type=submit]');
    await until(async () => (await api('GET', '/api/ai/settings')).data.enabled === true);
    eq((await api('GET', '/api/ai/settings')).data.enabled, true, 'the copilot is on');
    await page.waitForSelector('[data-ai-usage]');
    await axe(page, 'Settings › AI copilot, agreement recorded and switched on');
    // CalOMS reporting on, for step 6.
    const cal = await api('PUT', '/api/caloms/settings', { enabled: true, providers: [{ id: '123456', name: 'Main' }] });
    eq(cal.status, 200, 'CalOMS reporting is on for the CalOMS step');
  }

  // ------------------------------------------------------------------------------------------------ 2
  const clin = await session('kpatel', PW);
  const { page, api, go } = clin;
  const created = await api('POST', '/api/clients', { first_name: 'Aurelia', last_name: 'Quintero', dob: '1990-02-03', phone: '530-555-0142', confirm_duplicate: true });
  eq(created.status, 201, 'a client for the copilot steps');
  const clientId = created.data.id;
  {
    await page.evaluate(async (id) => (await import('./views/notes.js')).openNoteForm(null, { clientId: id, clientDisplay: 'Quintero, Aurelia' }), clientId);
    await page.waitForSelector('.modal select[name=format]');
    await page.selectOption('.modal select[name=format]', 'DAP');
    await openPanel(page, 'note');
    ok(await page.$('[data-ai-panel="note"] [data-ai-what-is-sent]'), 'the panel says what is sent and what is not');
    await axe(page, 'Note form with the AI copilot panel open');
    await page.fill('[data-ai-panel="note"] textarea', 'Aurelia Quintero said she used twice this week; call 530-555-0142. Reviewed naloxone.');
    const before = calls.length;
    await page.click('[data-ai-draft="note"]');
    await page.waitForSelector('.modal [data-ai-draft-banner]', { timeout: 20000 });
    eq(calls.length, before + 1, 'one call reached the (fake) provider');
    const sent = calls[calls.length - 1].raw;
    ok(!/Aurelia|Quintero|555-0142/.test(sent), 'the client\'s name and phone were not sent');
    ok(/\[CLIENT_FULL_NAME\]/.test(sent) && /\[PHONE\]/.test(sent), 'placeholders were sent in their place');
    ok(/AI draft — review before signing/.test(await page.textContent('.modal [data-ai-draft-banner]')), 'the draft is marked "AI draft — review before signing"');
    const d = await page.inputValue('.modal textarea[data-sec=D]');
    ok(/^D: Aurelia discussed cravings/.test(d), 'the Data section holds the draft, with the name put back', d);
    ok(/needs clinician input/.test(await page.inputValue('.modal textarea[data-sec=A]')), 'gaps are left for the clinician');
    await axe(page, 'Note form with an AI draft in it');
    // A SUD counseling note (§2.11) is written without the copilot: a note with copilot text cannot be ticked as one.
    ok(await page.$eval('.modal input[name=counseling_note]', i => i.disabled), 'a note with copilot text cannot be ticked as a SUD counseling note');
    ok(await page.$eval('.modal [data-counseling-ai-note]', e => !e.hidden), 'and the form says why');
    // Save & sign: the review statement is asked for, and required.
    await page.click('.modal button[data-save-sign]');
    await page.waitForSelector('[data-signature-dialog]', { timeout: 10000 });
    ok(await page.$('[data-signature-dialog] input[name=ai_reviewed]'), 'signing asks the author to confirm they reviewed the AI-drafted text');
    await axe(page, 'Signature dialog for an AI-assisted note');
    const pwBox = await page.$('[data-signature-dialog] input[name=password]');
    if (pwBox) await pwBox.fill(PW);
    await page.click('[data-signature-dialog] button[type=submit]');
    await until(async () => page.$('[data-signature-dialog] .field[data-field=ai_reviewed].error, [data-signature-dialog] .err:not(:empty)'));
    ok(await page.$('[data-signature-dialog]'), 'it will not sign without the statement');
    await page.check('[data-signature-dialog] input[name=ai_reviewed]');
    if (pwBox) await pwBox.fill(PW);
    await page.click('[data-signature-dialog] button[type=submit]');
    await until(async () => !(await page.$('.modal-bg')), { timeout: 15000 });
    const notes = (await api('GET', `/api/notes?client_id=${clientId}`)).data.rows;
    eq(notes.length, 1, 'one note was saved, by the author');
    const note = (await api('GET', `/api/notes/${notes[0].id}`)).data.note;
    eq(note.status, 'signed', 'and signed by the author');
    eq(note.ai_assisted, 1, 'the signed note records that it was AI-assisted');
    await page.evaluate(async (id) => (await import('./views/notes.js')).openNote(id), note.id);
    await page.waitForSelector('.modal [data-ai-assisted]');
    ok(await page.$('.modal [data-ai-signed]'), 'the signed note says it was drafted with the copilot and reviewed');
    await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg')));
  }

  // ------------------------------------------------------------------------------------------------ 3
  {
    mode = 'overloaded';
    await page.evaluate(async (id) => (await import('./views/notes.js')).openNoteForm(null, { clientId: id, clientDisplay: 'Quintero, Aurelia' }), clientId);
    await page.waitForSelector('.modal textarea[name=content]');
    await page.fill('.modal textarea[name=content]', 'My own words about the session.');
    await openPanel(page, 'note');
    await page.check('.modal input[name=counseling_note]');
    ok(await page.$eval('[data-ai-panel="note"]', e => e.hidden), 'ticking "SUD counseling note" hides the copilot');
    await page.uncheck('.modal input[name=counseling_note]');
    ok(await page.$eval('[data-ai-panel="note"]', e => !e.hidden), 'and unticking it shows the copilot again');
    await page.fill('[data-ai-panel="note"] textarea', 'Session text');
    await page.click('[data-ai-draft="note"]');
    await until(async () => (await page.textContent('[data-ai-panel="note"] [data-ai-error]')).trim(), { timeout: 20000 });
    ok(/form is unchanged/.test(await page.textContent('[data-ai-panel="note"] [data-ai-error]')), 'a provider failure is said, and says the form is unchanged');
    eq(await page.inputValue('.modal textarea[name=content]'), 'My own words about the session.', 'the narrative is exactly as typed');
    ok(!(await page.$('.modal [data-ai-draft-banner]')), 'and nothing is marked as an AI draft');
    await page.click('.modal form button[type=submit]:not([data-save-sign])');
    await until(async () => !(await page.$('.modal-bg')), { timeout: 10000 });
    const rows = (await api('GET', `/api/notes?client_id=${clientId}&status=draft`)).data.rows;
    eq(rows.length, 1, 'the note saves by hand as before');
    eq((await api('GET', `/api/notes/${rows[0].id}`)).data.note.ai_assisted, 0, 'and is not marked AI-assisted');
    mode = 'ok';
  }

  // ------------------------------------------------------------------------------------------------ 4
  {
    await go(`client/${clientId}/assessments`);
    await page.click('[data-add-asam]');
    await page.waitForSelector('.modal [data-ai-panel="asam"]');
    await openPanel(page, 'asam');
    await axe(page, 'Six-dimension assessment with the AI copilot panel');
    await page.fill('[data-ai-panel="asam"] textarea', 'Intake: Aurelia reports daily use, no withdrawal now, lives with a partner who uses.');
    await page.click('[data-ai-draft="asam"]');
    await page.waitForSelector('.modal [data-ai-asam-suggest="d6"]', { timeout: 20000 });
    ok(/d1: what the intake notes say about Aurelia/.test(await page.inputValue('.modal textarea[name=note_d1]')), 'each dimension\'s notes hold the draft');
    eq(await page.inputValue('.modal select[name=d1_rating]'), '', 'no rating is chosen for the clinician');
    ok(/not enough information/.test(await page.textContent('.modal [data-ai-asam-suggest="d2"]')), 'a dimension without enough information says so');
    await axe(page, 'Six-dimension assessment with AI suggestions');
    for (const k of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) await page.selectOption(`.modal select[name=${k}_rating]`, '1');
    await page.click('.modal [data-ai-use-rating="d4"]');
    eq(await page.inputValue('.modal select[name=d4_rating]'), '3', '"Use 3" fills that rating when the clinician chooses to');
    await page.click('.modal form button[type=submit]');
    await until(async () => (await page.textContent('.modal form')).includes('I have reviewed'), { timeout: 5000 });
    ok(await page.$('.modal form'), 'the assessment is not saved until every dimension is marked reviewed');
    eq(((await api('GET', `/api/clients/${clientId}/asam`)).data.rows || []).length, 0, 'nothing was saved');
    for (const k of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) await page.check(`.modal [data-ai-dim-reviewed="${k}"]`);
    await page.click('.modal form button[type=submit]');
    await until(async () => !(await page.$('.modal-bg')), { timeout: 10000 });
    eq(((await api('GET', `/api/clients/${clientId}/asam`)).data.rows || []).length, 1, 'once reviewed, the clinician saves it');
  }

  // ------------------------------------------------------------------------------------------------ 5
  {
    await go(`client/${clientId}/careplan`);
    await page.click('[data-ai-careplan-open]');
    await page.waitForSelector('.modal [data-ai-careplan]');
    await axe(page, 'Care plan suggestions dialog');
    await page.click('.modal [data-ai-draft="careplan"]');
    await page.waitForSelector('.modal [data-ai-careplan-entry="0"]', { timeout: 20000 });
    await axe(page, 'Care plan suggestions listed');
    eq(((await api('GET', `/api/clients/${clientId}/care-plan`)).data.goals || []).length, 0, 'nothing is added until the clinician adds it');
    await page.click('.modal [data-ai-add-problem="0"]'); await until(async () => /added/.test(await page.textContent('.modal [data-ai-add-problem="0"]')));
    await page.click('.modal [data-ai-add-goal="0"]'); await until(async () => /added/.test(await page.textContent('.modal [data-ai-add-goal="0"]')));
    await page.click('.modal [data-ai-add-step="0"] >> nth=0'); await until(async () => /added/.test(await page.textContent('.modal [data-ai-add-step="0"] >> nth=0')));
    const plan = (await api('GET', `/api/clients/${clientId}/care-plan`)).data.goals;
    eq(plan.length, 1, 'the goal the clinician added is on the care plan');
    eq(plan[0].steps.length, 1, 'with the one step they added');
    ok(plan[0].problem === 'Daily cravings', 'tied to the problem they added', plan[0].problem);
    await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg')));
    await settle(page);
  }

  // ------------------------------------------------------------------------------------------------ 6
  {
    const other = await api('POST', '/api/clients', { first_name: 'Bram', last_name: 'Okafor', confirm_duplicate: true });
    const eps = (await api('GET', `/api/clients/${other.data.id}/episodes`)).data.episodes || [];
    for (const e of eps.filter(x => x.status === 'open')) await api('POST', `/api/episodes/${e.id}/close`, { discharge_reason: 'moved', closed_at: new Date().toISOString().slice(0, 10), caloms: { answers: { discharge_status: '4', last_service_date: new Date().toISOString().slice(0, 10) } } });
    await go(`client/${other.data.id}/episodes`);
    await page.click('button:has-text("Start")');
    await page.waitForSelector('.modal [data-ai-panel="caloms-admission"]', { timeout: 10000 });
    await openPanel(page, 'caloms-admission');
    await page.fill('[data-ai-panel="caloms-admission"] textarea', 'Bram smokes fentanyl daily.');
    await page.click('[data-ai-draft="caloms-admission"]');
    await page.waitForSelector('.modal [data-ai-caloms-suggestion="primary_route"]', { timeout: 20000 });
    await axe(page, 'Admission dialog with CalOMS suggestions');
    eq(await page.inputValue('.modal select[name=caloms_primary_route]'), '', 'a suggestion is not applied by itself');
    await page.click('.modal [data-ai-caloms-apply="primary_route"]');
    eq(await page.inputValue('.modal select[name=caloms_primary_route]'), '2', 'Apply fills that CalOMS answer');
    await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg')));
  }

  // ------------------------------------------------------------------------------------------------ 7
  const audit = (await admin.api('GET', '/api/admin/audit?action=ai.draft&limit=50')).data.rows;
  ok(audit.length >= 5, 'every draft is in the audit log', audit.length);
  ok(audit.every(a => !/Aurelia|Quintero|fentanyl|cravings/.test(JSON.stringify(a.details))), 'the audit entries carry no text');
  if (staticBase) {
    const ctx = await browser.newContext();
    const sp = await ctx.newPage();
    await sp.goto(staticBase + '/');
    const st = await sp.evaluate(async () => { try { const m = await import('./views/ai.js'); const { state } = await import('./app.js'); state.local = true; return await m.aiStatus({ fresh: true }); } catch (e) { return { error: e.message }; } });
    ok(st && st.available === false && /office server/.test(st.reason || ''), 'SUDS on this device has no copilot, and says why', st);
    await ctx.close();
  }
} catch (e) {
  fail(`step threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e}`);
}
for (const e of errors) fail(e);
await browser.close();
fake.close();
finish();

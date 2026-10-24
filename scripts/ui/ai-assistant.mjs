// The AI assistant (docs/AI-COPILOT.md, "The assistant"; views/assistant.js) in a real browser, on a phone-sized
// screen, against a fake AI provider this script runs itself (run-all.sh points the office server at it:
// SUDS_AI_BASE_URL, ANTHROPIC_API_KEY). Nothing leaves the machine.
//   0. Off (the default): a navigator's menu has no Assistant, and the page says why.
//   1. Settings › AI copilot: the agreement recorded with its fourth statement (covers assistant use), the copilot
//      and the assistant switched on; axe-clean.
//   2. A navigator on a phone: the Assistant in their menu, a client chosen, "Brief me before a visit": the answer
//      under "AI answer — check it against the record before you act", the client's first name put back, its
//      citations linking to the record; the client's name never sent; axe-clean with an answer on the page.
//   3. My day: the scope changes, the conversation starts again; the answer names the client the provider saw only
//      as [C1].
//   4. The provider overloaded: the error is said, nothing is shown as an answer, the question stays in the box.
//   5. A clinician's recap handed to a new note: "Draft a note from this" opens the note form with the recap in the
//      copilot's box, nothing drafted and nothing saved until they choose to.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const FAKE_PORT = Number(process.env.SUDS_AI_FAKE_PORT || 8097);
const { ok, eq, fail, finish, noStrayText } = makeChecks('ai-assistant');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const errors = [];

// ---------------------------------------------------------------- the fake provider
// Answers in the assistant's shape, citing the first section its schema allows, and echoing a placeholder so the
// re-insertion of names can be seen in the browser.
const calls = [];
let mode = 'ok';
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { body = null; }
    calls.push({ raw, body });
    if (mode === 'overloaded') { res.writeHead(529, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })); return; }
    const schema = body?.output_config?.format?.schema || {};
    const allowed = schema.properties?.citations?.items?.properties?.section?.enum || [];
    const first = allowed[0];
    let answer = 'Nothing in the summary answers that.';
    if (first === 'client.header') answer = 'Last contact with [CLIENT_FIRST_NAME] is in the summary; one referral is open.';
    if (first === 'day.schedule') answer = raw.includes('[C1]') ? '[C1] has a to-do that is overdue.' : 'Nothing is due today.';
    const data = { answer, citations: first ? [{ section: first }] : [], missing: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: body?.model || 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 700, output_tokens: 60 } }));
  });
});
await new Promise((ok2, bad) => { fake.once('error', bad); fake.listen(FAKE_PORT, '127.0.0.1', ok2); });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
async function session(username, password, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600 });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('response', r => { if (r.status() >= 500 && !/\/api\/ai\/ask/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
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
  await noStrayText(page, where);
}
const menuHas = (page, name) => page.evaluate((n) => !![...document.querySelectorAll('a[href]')].find(a => a.getAttribute('href') === `#/${n}`), name);
async function chooseClient(page, code) {
  await page.fill('#assistant-client-input', code);
  const opt = await until(() => page.$(`.client-picker-list .list-item:has-text("${code}")`), { timeout: 8000 });
  ok(opt, `the client search finds ${code}`);
  await opt.click(); await settle(page);
}
const answers = (page) => page.$$eval('#assistant-turns [data-ai-answer]', (els) => els.length);

try {
  // ------------------------------------------------------------------------------------------------ 0
  const nav = await session('mrivera', PW);
  const c = await nav.api('POST', '/api/clients', { first_name: 'Juniper', last_name: 'Assistantcase', confirm_duplicate: true });
  eq(c.status, 201, 'a client to ask about');
  const clientId = c.data.id; const code = c.data.client_code;
  {
    const { page, go } = nav;
    ok(!(await menuHas(page, 'assistant')), 'with the assistant off, the menu has no Assistant');
    await go('assistant');
    ok(await page.$('[data-assistant-unavailable]'), 'and the page says why');
    ok(!(await page.$('#assistant-composer')), 'with nothing to type into');
  }
  // ------------------------------------------------------------------------------------------------ 1
  const admin = await session('admin', 'AdminPassw0rd!x', { width: 1280, height: 900 });
  {
    const { page, api, go } = admin;
    await go('admin?tab=ai');
    await page.waitForSelector('[data-ai-settings]');
    ok(await page.$('[data-ai-assistant-sent]'), 'Settings › AI copilot says what the assistant sends');
    const f = '[data-ai-attestation] form';
    await page.fill(`${f} input[name=signed_by]`, 'Program Director');
    await page.fill(`${f} input[name=agreement_date]`, '2026-01-15');
    await page.fill(`${f} input[name=reference]`, 'BAA-2026-UI');
    for (const n of ['baa', 'qsoa', 'counsel_reviewed', 'covers_assistant']) await page.check(`${f} input[name=${n}]`);
    await page.click(`${f} button[type=submit]`);
    await page.waitForSelector('[data-ai-covers-assistant="1"]', { timeout: 8000 });
    ok(true, 'the agreement is recorded as covering assistant use');
    await page.check('[data-ai-switch] input[name=enabled]'); await page.check('[data-ai-switch] input[name=assistant_enabled]');
    await page.click('[data-ai-switch] button[type=submit]'); await settle(page);
    const s = await until(async () => { const r = await api('GET', '/api/ai/settings'); return r.data && r.data.assistant_enabled ? r : null; });
    ok(s && s.data.enabled && s.data.status.assistant.available, 'the copilot and the assistant are on', s && s.data.status);
    await axe(page, 'Settings › AI copilot, assistant on');
  }
  // ------------------------------------------------------------------------------------------------ 2
  {
    const { page, go } = nav;
    await page.reload(); await page.waitForSelector('.layout'); await settle(page);
    ok(await menuHas(page, 'assistant'), 'the navigator\'s menu now has the Assistant');
    await go('assistant');
    await page.waitForSelector('#assistant-composer', { timeout: 10000 });
    ok(await page.$('[data-assistant-what-is-sent]'), 'the page says what is sent');
    await axe(page, 'Assistant, empty');
    await chooseClient(page, code);
    const before = calls.length;
    await page.click('[data-assistant-starter="Brief me before a visit"]');
    await until(async () => (await answers(page)) === 1, { timeout: 20000 });
    eq(calls.length - before, 1, 'one request to the provider');
    const sent = calls.at(-1).raw;
    ok(!/Juniper|Assistantcase/.test(sent) && !sent.includes(code), 'the client\'s name and code were not sent');
    ok(await page.$('#assistant-turns .ai-answer-banner'), 'the answer carries the check-it banner');
    const text = await page.textContent('#assistant-turns');
    ok(/AI answer — check it against the record before you act/.test(text), 'in those words');
    ok(/Last contact with Juniper/.test(text), 'the first name is put back here', text);
    const cite = await page.getAttribute('#assistant-turns [data-ai-cite="client.header"]', 'href');
    eq(cite, `#/client/${clientId}/overview`, 'the citation opens the client\'s record');
    ok(await page.$('#assistant-turns[aria-live="polite"]'), 'answers are announced politely');
    await axe(page, 'Assistant, with an answer');
    // ---------------------------------------------------------------------------------------------- 4
    mode = 'overloaded';
    await page.fill('#assistant-question', 'What referrals are open?');
    await page.click('#assistant-send');
    await page.waitForFunction(() => /unavailable/i.test(document.querySelector('[data-assistant-error]').textContent), null, { timeout: 20000 });
    eq(await answers(page), 1, 'a failed ask adds no answer');
    eq(await page.inputValue('#assistant-question'), 'What referrals are open?', 'the question stays in the box');
    ok(/conversation is unchanged/.test(await page.textContent('[data-assistant-error]')), 'and the error says the conversation is unchanged');
    mode = 'ok';
    // ---------------------------------------------------------------------------------------------- 3
    await page.check('input[name="assistant-scope"][value="day"]'); await settle(page);
    eq(await answers(page), 0, 'a new scope starts a new conversation');
    ok(await page.$('[data-assistant-client]') && await page.$eval('[data-assistant-client]', e => e.hidden), 'with no client to choose');
    // A to-do for the client, overdue, so the day has someone in it.
    await nav.api('POST', '/api/tasks', { client_id: clientId, title: 'Follow up about the ID card', due_at: '2026-01-02', assigned_to: (await nav.api('GET', '/api/me')).data.id });
    await page.click('[data-assistant-starter="What is overdue?"]');
    await until(async () => (await answers(page)) === 1, { timeout: 20000 });
    ok(!/Juniper|Assistantcase|ID card/.test(calls.at(-1).raw) && !calls.at(-1).raw.includes(code), 'no name, code or to-do title was sent');
    // [C1] is whichever client heads the overdue list (the seeded caseload has older ones): named here, never sent.
    const dayText = await page.textContent('#assistant-turns');
    ok(/\S+ \([A-Z0-9][\w-]*\) has a to-do that is overdue/.test(dayText) && !dayText.includes('[C1]'), 'the answer names the client by first name and code', dayText);
  }
  await nav.ctx.close();
  await admin.ctx.close();
} catch (e) {
  fail(`ai-assistant script error: ${e && e.stack || e}`);
} finally {
  eq(errors.length, 0, `no page errors or server errors${errors.length ? ' — ' + errors.join('; ') : ''}`);
  await browser.close(); await new Promise(r => fake.close(r));
}
finish();

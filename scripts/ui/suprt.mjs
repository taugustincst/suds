// SUPRT-A in a browser (server/suprt.js, public/views/suprt.js, docs/compliance/SUPRT.md): the module switches
// on with a SOR grant fund; a navigator records a baseline from the client record's SUPRT-A tab, with what SUDS
// already holds pre-filled, on a phone as well as a desktop; follow-ups due appear on the To-dos page; a
// supervisor sees the completion rates and makes the SPARS entry file, which is refused until a client's
// consent names the recipient and is accounted for when it is made. WCAG 2.1 AA with axe on each screen.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('suprt');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const browser = await chromium.launch();
const errors = [];

async function session(username, password, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[01349]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 });
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) }));
  await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
  return { ctx, page, api, go };
}
async function axe(page, where) {
  if (!axeSource) { fail('axe-core is not installed (npm i --no-save axe-core)'); return; }
  await page.evaluate(axeSource + ';0');
  const v = await page.evaluate(async () => {
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading', 'landmark-unique', 'page-has-heading-one'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
}

try {
  const admin = await session('admin', 'AdminPassw0rd!x');
  // SUPRT-A is on by default only for a programme with a SOR grant fund: off without one, on with one.
  eq((await admin.api('PUT', '/api/admin/settings', { module_suprt: '0' })).status, 200, 'SUPRT-A switched off');
  await admin.go('tasks');
  eq((await admin.api('GET', '/api/auth/me')).data.programme.modules.suprt, false, 'switched off, it is off');
  eq((await admin.api('PUT', '/api/admin/settings', { module_suprt: null })).status, 200, 'back to the default');
  let sor = ((await admin.api('GET', '/api/budget/funds')).data.funds || []).find(x => x.source_type === 'sor_grant');
  if (!sor) sor = (await admin.api('POST', '/api/budget/funds', { name: 'State Opioid Response IV', source_type: 'sor_grant', total_amount: 250000, fiscal_year_start: '2025-10-01', fiscal_year_end: '2026-12-31' })).data;
  ok(sor && sor.id, 'the programme has a SOR grant fund');
  const f = { data: sor };
  eq((await admin.api('GET', '/api/auth/me')).data.programme.modules.suprt, true, 'so SUPRT-A is on by default');
  // The SUPRT-A page's settings: the grant and site IDs every record carries.
  await admin.go('suprt');
  ok(await admin.page.$('[data-suprt-settings]'), 'the SUPRT-A page has its settings for an administrator');
  await admin.page.fill('[data-suprt-settings] input[name=suprt_grant_id]', 'TI-085555');
  await admin.page.fill('[data-suprt-settings] input[name=suprt_site_id]', 'CA-SOR-7');
  await admin.page.click('[data-suprt-settings] button[type=submit]'); await settle(admin.page);
  eq((await admin.api('GET', '/api/suprt/items')).data.grant_id, 'TI-085555', 'the grant ID is saved');

  // Two of the navigator's clients receive SOR-funded services.
  const nav = await session('mrivera', PW);
  const mine = (await nav.api('GET', '/api/clients?limit=5')).data.clients;
  ok(mine.length >= 2, 'the navigator has clients', mine.length);
  const today = new Date().toISOString().slice(0, 10);
  for (const c of mine.slice(0, 2)) eq((await nav.api('POST', '/api/interventions', { client_id: c.id, type: 'case_management', occurred_at: new Date().toISOString(), funding_source_id: f.data.id })).status, 201, 'a SOR-funded visit');
  await nav.page.reload(); await settle(nav.page);
  const c = mine[0];
  await nav.go(`client/${c.id}/suprt`);
  ok(await nav.page.$('[data-suprt-tab]'), 'the client record has a SUPRT-A tab');
  ok(/Baseline/.test(await nav.page.textContent('[data-suprt-due]')), 'a baseline is due: the client received a SOR-funded service');
  await axe(nav.page, 'the SUPRT-A tab');
  await nav.page.click('[data-suprt-add=baseline]'); await nav.page.waitForSelector('[data-suprt-form=baseline]');
  ok(/TI-085555/.test(await nav.page.textContent('[data-suprt-form]')), 'the form shows the grant ID it will carry');
  ok(/Pre-filled from the client record/.test(await nav.page.textContent('[data-suprt-form]')), 'and says which answers came from the client record');
  ok(await nav.page.$('[data-suprt-form] select[name="answers.A_suprt_c"]'), 'the client questionnaire question is asked');
  await axe(nav.page, 'the SUPRT-A baseline form');
  // Mark complete without the questionnaire answer: refused, with the field named.
  await nav.page.click('[data-suprt-form] button[type=submit]');
  ok(await until(async () => /Client questionnaire/.test(await nav.page.textContent('[data-suprt-form] .banner.danger').catch(() => ''))), 'completing it without a required answer says which one');
  await nav.page.selectOption('[data-suprt-form] select[name="answers.A_suprt_c"]', 'declined');
  await nav.page.selectOption('[data-suprt-form] select[name="answers.C_trauma_screen"]', 'not_screened');
  await nav.page.click('[data-suprt-form] button[type=submit]'); await settle(nav.page);
  ok(await until(async () => !(await nav.page.$('[data-suprt-form]'))), 'the baseline is saved');
  ok(await until(async () => /Complete/.test(await nav.page.textContent('[data-suprt-tab]'))), 'and listed as complete');
  const saved = (await nav.api('GET', `/api/clients/${c.id}/suprt`)).data.rows[0];
  eq(saved.answers.A_grant_id, 'TI-085555', 'the record carries the grant ID');
  eq(saved.answers.A_suprt_c, 'declined', 'and the answer given');
  ok(saved.derived_keys.includes('A_first_service_date'), 'and says which answers came from the record', saved.derived_keys);

  // The To-dos page: the other client still needs a baseline.
  await nav.go('tasks');
  ok(await nav.page.$('[data-suprt-due-card]'), 'the To-dos page lists the SUPRT-A follow-ups due');
  ok((await nav.page.textContent('[data-suprt-due-card]')).includes(mine[1].client_code), 'including the client who needs a baseline');
  await axe(nav.page, 'the To-dos page with SUPRT-A follow-ups');

  // On a phone: the form in one column, nothing wider than the screen.
  const phone = await session('mrivera', PW, { width: 390, height: 844 });
  await phone.go(`client/${mine[1].id}/suprt`);
  await phone.page.click('[data-suprt-add=baseline]'); await phone.page.waitForSelector('[data-suprt-form=baseline]');
  ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'on a 390 px phone the form does not scroll sideways');
  await axe(phone.page, 'the SUPRT-A form on a phone');
  await phone.ctx.close();

  // The supervisor: completion rates, and the SPARS entry file (a disclosure).
  const sup = await session('jwalker', PW);
  await sup.go(`suprt?from=${today.slice(0, 4)}-01-01&to=${today}`);
  ok(await sup.page.$('[data-suprt-completion]'), 'the SUPRT-A page shows the completion rates');
  ok(await sup.page.$('[data-suprt-due-card]'), 'and the team\'s follow-ups due');
  await axe(sup.page, 'the SUPRT-A page');
  await sup.page.click('[data-suprt-export-button]'); await sup.page.waitForSelector('[data-suprt-export-form]');
  await axe(sup.page, 'the SPARS entry file form');
  await sup.page.click('[data-suprt-export-form] button[type=submit]');
  ok(await until(async () => /consent on file naming/.test(await sup.page.textContent('[data-suprt-export-form] .banner.danger').catch(() => ''))), 'without a consent naming the recipient, the file is refused and the page says why');
  await sup.page.keyboard.press('Escape'); await settle(sup.page);
  eq((await nav.api('POST', `/api/clients/${c.id}/consents`, { type: 'part2_disclosure', recipient: 'SAMHSA', purpose: 'SOR performance reporting', signed_at: today, scope: 'SUPRT-A performance data', expires_at: '2099-01-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true })).status, 201, 'the client consents to SPARS reporting');
  await sup.page.click('[data-suprt-export-button]'); await sup.page.waitForSelector('[data-suprt-export-form]');
  const [dl] = await Promise.all([sup.page.waitForEvent('download'), sup.page.click('[data-suprt-export-form] button[type=submit]')]);
  ok(/for-entry-into-SPARS-check-against-current-handbook\.csv$/.test(dl.suggestedFilename()), 'the file downloads, labelled for entry into SPARS', dl.suggestedFilename());
  const body = fs.readFileSync(await dl.path(), 'utf8');
  ok(body.replace(/^\uFEFF/, '').startsWith('A_client_id,'), 'in SUPRT-A section order, SUDS variable names first', body.slice(0, 40));
  ok(body.includes(c.client_code), 'with the consenting client');
  ok(/check against the current SUPRT handbook/.test(body), 'and the note to check it against the handbook');
  const acc = (await nav.api('GET', `/api/clients/${c.id}/disclosures/accounting`)).data;
  ok(JSON.stringify(acc).includes('SPARS'), 'the disclosure is in the client\'s accounting', JSON.stringify(acc).slice(0, 300));
  await sup.ctx.close(); await nav.ctx.close(); await admin.ctx.close();
} catch (e) {
  fail(`the script stopped: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
}
finish(errors);
await browser.close();

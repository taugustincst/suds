// 1.17.0, the programme-wide least-privilege default (server/caseload-default.js), in a browser:
//   Settings -> Users & permissions has "New navigators and clinicians start held to their caseload" (on for a new
//   install), and says prominently that turning it on is recommended while it is off;
//   a navigator created there is held to their caseload (the Permissions dialog says so, and the user list's
//   Clients column shows "Caseload only · program default"); seeded accounts from before still show "Every client";
//   "Apply to existing navigators and clinicians" lists exactly who changes before anything does, and after it
//   they show as held, and a held navigator's Clients page is their caseload ("My clients").
// The card, the list and the confirmation are checked with axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish, noStrayText } = makeChecks('r10-lp');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const errors = [];

async function session(username, password, viewport = { width: 1360, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  await api('PUT', '/api/me/prefs', { tour_done: true });
  await page.reload(); await page.waitForSelector('.layout'); await settle(page);
  const go = async (hash) => { await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 15000 }).catch(() => {}); await settle(page); };
  return { ctx, page, api, go };
}
async function axe(page, where) {
  if (!axeSource) { fail('axe-core is not installed (npm i --no-save axe-core)'); return; }
  await page.evaluate(axeSource + ';0');
  const v = await page.evaluate(async () => {
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
  // Every page and dialog checked here: no "null" or "undefined" written out as text (r10 H1, assert.mjs).
  await noStrayText(page, where);
}
const closeModals = async (page) => { for (let i = 0; i < 5 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await settle(page); } };
const toastText = (page, re) => until(async () => { const t = await page.$$eval('#toasts .toast', ts => ts.map(x => x.textContent).join(' | ')); return re.test(t) ? t : null; }, { timeout: 6000 });
// The Clients cell of a user's row in Users & permissions.
const scopeOf = (page, username) => page.evaluate((u) => {
  const btn = document.querySelector(`[data-user-permissions="${u}"]`); const row = btn && btn.closest('tr');
  const cell = row && row.querySelector('[data-client-scope]');
  return cell ? { scope: cell.getAttribute('data-client-scope'), byDefault: cell.getAttribute('data-held-by-default'), text: cell.textContent } : null;
}, username);
const tag = Date.now().toString().slice(-5);

try {
  const admin = await session('admin', 'AdminPassw0rd!x');
  const { page } = admin;

  // ---- the setting, on for a new install ----
  await admin.go('admin?tab=users');
  const card = await until(() => page.$('[data-caseload-default]'), { timeout: 8000 });
  ok(card, 'Users & permissions has the least-privilege default card');
  eq(await page.getAttribute('[data-caseload-default]', 'data-caseload-default'), 'on', 'a new install starts with it on');
  ok(await page.isChecked('[data-caseload-default] input[type=checkbox]'), 'the box is ticked');
  ok(/New navigators and clinicians start held to their caseload/.test(await page.textContent('[data-caseload-default] label')), 'its label says what it does');
  ok(!(await page.$('[data-caseload-default-recommend]')), 'no recommendation while it is on');
  await axe(page, 'Users & permissions with the default on');

  // ---- off: the recommendation is prominent ----
  await page.uncheck('[data-caseload-default] input[type=checkbox]');
  await page.click('[data-caseload-default] button[type=submit]');
  ok(await toastText(page, /will see every client/), 'turning it off says what that means');
  await until(async () => (await page.getAttribute('[data-caseload-default]', 'data-caseload-default').catch(() => null)) === 'off', { timeout: 8000 });
  const rec = await until(() => page.$('[data-caseload-default-recommend]'), { timeout: 5000 });
  ok(rec && /Recommended: turn this on/.test(await rec.textContent()), 'off, the card recommends turning it on', rec && await rec.textContent());
  await axe(page, 'Users & permissions with the default off');
  eq((await admin.api('GET', '/api/users/caseload-default')).data.enabled, false, 'saved off');
  await page.check('[data-caseload-default] input[type=checkbox]');
  await page.click('[data-caseload-default] button[type=submit]');
  ok(await toastText(page, /will start held to their caseload/), 'and back on');
  await until(async () => (await page.getAttribute('[data-caseload-default]', 'data-caseload-default').catch(() => null)) === 'on', { timeout: 8000 });

  // ---- a navigator created here is held ----
  const uname = 'lpnav' + tag;
  await page.click('button:has-text("+ New user")');
  await page.waitForSelector('.modal form'); await settle(page);
  ok(await page.$('.modal [data-new-user-held]'), 'the New user form says a new navigator or clinician starts held to their caseload');
  await page.fill('.modal input[name=username]', uname); await page.fill('.modal input[name=display_name]', 'Lee Heldnav');
  await page.selectOption('.modal select[name=role]', 'navigator');
  await page.fill('.modal input[name=password]', PW + 'x');
  await page.click('.modal button[type=submit]');
  const intro = await until(() => page.$('[data-perm-just-created]'), { timeout: 10000 });
  ok(intro && /held to their caseload by the program default/.test(await intro.textContent()), 'the new navigator\'s Permissions dialog says they are held to their caseload', intro && await intro.textContent());
  ok(await until(async () => /programme default: held to caseload/.test(await page.textContent('[data-perm-overrides]').catch(() => ''))), 'and lists the deny with its reason');
  await closeModals(page);
  await admin.go('admin?tab=users');
  await page.waitForSelector('.main table');
  const held = await scopeOf(page, uname);
  eq(held && held.scope, 'caseload', 'the user list shows the new navigator as Caseload only');
  eq(held && held.byDefault, '1', 'by the program default');
  ok(held && /Caseload only/.test(held.text) && /program default/.test(held.text), 'in words', held && held.text);
  eq((await scopeOf(page, 'mrivera'))?.scope, 'all', 'a navigator from before still shows Every client');
  eq((await scopeOf(page, 'afinance'))?.scope, 'codes', 'finance shows client codes only');

  // ---- apply to existing: the confirmation lists who changes ----
  const applyBtn = await page.$('button[data-apply-existing]');
  ok(applyBtn, 'there is an Apply to existing navigators and clinicians button');
  const n = Number(await page.getAttribute('button[data-apply-existing]', 'data-apply-existing'));
  ok(n >= 3, 'counting the seeded navigators and clinician', n);
  await page.click('button[data-apply-existing]');
  const dlg = await until(() => page.$('[data-apply-dialog]'), { timeout: 5000 });
  ok(dlg, 'a confirmation opens');
  const listed = await page.$$eval('[data-apply-list] li', lis => lis.map(li => li.textContent));
  eq(listed.length, n, 'listing each person who will change');
  ok(listed.some(t => /Maria Rivera/.test(t)) && listed.some(t => /Kiran Patel/.test(t)), 'by name and role', listed);
  ok(!listed.some(t => /Lee Heldnav/.test(t)), 'not someone already held');
  eq((await admin.api('GET', '/api/users/caseload-default')).data.would_change.length, n, 'nothing changed before confirming');
  await axe(page, 'the Apply to existing confirmation');
  await page.click('[data-apply-confirm]');
  ok(await toastText(page, new RegExp(`${n} people are now held to their caseload`)), 'the toast says how many changed');
  await until(async () => (await scopeOf(page, 'mrivera'))?.scope === 'caseload', { timeout: 8000 });
  const mr = await scopeOf(page, 'mrivera');
  eq(mr && mr.scope, 'caseload', 'Maria Rivera now shows Caseload only');
  eq(mr && mr.byDefault, '1', 'by the program default');
  ok(await page.$('[data-apply-existing="0"]'), 'and the button gives way to a note that everyone is held');
  await axe(page, 'Users & permissions after applying');
  await admin.ctx.close();

  // ---- the held navigator sees their caseload ----
  const nav = await session('mrivera', PW);
  const me = await nav.api('GET', '/api/auth/me');
  eq(me.data.user.caseload_restricted, true, 'Maria Rivera is caseload-scoped');
  await nav.go('clients');
  ok(await until(() => nav.page.$('[data-my-clients]'), { timeout: 8000 }), 'her Clients page says it shows her clients');
  const all = (await nav.api('GET', '/api/clients?status=all&limit=500')).data.clients;
  const mine = (await nav.api('GET', '/api/clients?status=all&limit=500&assigned_to=' + me.data.user.id)).data.clients;
  eq(all.length, mine.length, 'and lists only the clients assigned to her');
  await nav.ctx.close();
} catch (e) {
  fail(`crashed: ${e.stack || e.message}`);
}
await browser.close();
eq(errors.length, 0, `no page errors, console errors or 5xx${errors.length ? ': ' + errors.join(' / ') : ''}`);
finish();

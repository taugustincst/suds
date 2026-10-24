// Settings, made to be found (1.27.0; views/settings-overview.js, settings-nav.js, server-config.js):
//   1. an administrator opening Settings lands on All settings; the box narrows the list as they type;
//   2. every link in that list lands on what it names: its tab, and the setting marked and its control focused;
//   3. Server configuration: a plain setting saved and removed in the browser; a secret (the metrics token) saved only
//      after the password is given again, never shown afterwards; a setting the environment sets is shown as such;
//   4. the AI copilot tab carries the provider's connection inline; Program has "On this page", whose links open the
//      folded section; a status line links to its setting;
//   5. axe on each page.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, settle, until } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { ok, eq, fail, finish } = makeChecks('settings');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];

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

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message}`));
page.on('console', m => { if (m.type() === 'error' && !/40[01349]/.test(m.text())) errors.push(`CONSOLE ${m.text().slice(0, 200)}`); });
const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
/** The setting a link names is on the page, marked, and holds the focus (or its control does). */
const landed = (target) => until(() => page.evaluate((t) => {
  const el = document.querySelector(`[data-setting="${CSS.escape(t)}"]`) || document.querySelector(`[name="${CSS.escape(t)}"]`);
  if (!el) return null;
  const marked = !!el.closest('.setting-flash') || !!el.querySelector('.setting-flash') || el.classList.contains('setting-flash') || !!document.querySelector('.setting-flash');
  const focused = el === document.activeElement || el.contains(document.activeElement);
  const r = el.getBoundingClientRect();
  return marked && focused && r.top < innerHeight && r.bottom > 0 ? { marked, focused } : null;
}, target), { timeout: 8000 });

try {
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', 'admin'); await page.fill('input[name=password]', 'AdminPassw0rd!x'); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);

  // 1. All settings first, and the search.
  await go('admin');
  ok(await page.$('[data-settings-overview]'), 'Settings opens on All settings');
  const all = await page.$$eval('[data-overview-item]', els => els.length);
  ok(all > 40, 'it lists every setting', all);
  await page.fill('#settings-find', 'password');
  const shown = await page.$$eval('[data-overview-item]:not([hidden]) a', els => els.map(e => e.textContent));
  ok(shown.length > 0 && shown.length < all && shown.some(t => /Password expiry/.test(t)), 'typing narrows the list to what matches', shown);
  await page.fill('#settings-find', 'zzzz-nothing');
  ok(await page.isVisible('[data-settings-overview] [role=status]'), '…and says so when nothing does');
  await page.fill('#settings-find', '');
  await axe(page, 'All settings');

  // 2. Every link lands where it says.
  const links = await page.$$eval('[data-overview-link]', els => els.map(e => ({ href: e.getAttribute('href'), key: e.dataset.overviewLink })));
  const missed = [];
  for (const l of links) {
    const [tab, target] = l.key.split(':');
    await page.goto(base + '/' + l.href); await settle(page);
    const onTab = await page.evaluate((t) => { const b = [...document.querySelectorAll('.tabs [aria-selected="true"], .tabs .active')]; return b.length ? b.map(x => x.textContent).join('|') : ''; }, tab);
    if (!target) { if (!onTab) missed.push(`${l.key}: no tab selected`); continue; }
    if (!(await landed(target))) missed.push(l.key);
  }
  ok(missed.length === 0, `all ${links.length} links land on their setting, marked and focused`, missed);

  // 3. Server configuration.
  await go('admin?tab=server');
  ok(await page.$('[data-server-config]'), 'Server configuration is a tab');
  const envRow = await page.getAttribute('[data-setting="LOGIN_RATE_LIMIT"]', 'data-source');
  eq(envRow, 'environment', 'a limit the server\'s environment sets is shown as set there');
  ok(!(await page.$('[data-setting="LOGIN_RATE_LIMIT"] [data-setting-save]')), '…with no Save: the environment wins');
  // A plain setting.
  await page.fill('#sc-TOMBSTONE_RETENTION_DAYS', '200');
  await page.click('[data-setting-save="TOMBSTONE_RETENTION_DAYS"]');
  ok(await until(() => page.getAttribute('[data-setting="TOMBSTONE_RETENTION_DAYS"]', 'data-source').then(s => s === 'here'), { timeout: 8000 }), 'a plain setting is saved here, with no password asked');
  await page.click('[data-setting-remove="TOMBSTONE_RETENTION_DAYS"]');
  ok(await until(() => page.getAttribute('[data-setting="TOMBSTONE_RETENTION_DAYS"]', 'data-source').then(s => s === 'default'), { timeout: 8000 }), '…and removed back to the default');
  // A secret.
  await page.fill('#sc-METRICS_TOKEN', 'metrics-token-from-the-browser-123');
  await page.click('[data-setting-save="METRICS_TOKEN"]');
  await page.waitForSelector('.modal input[name=password]', { timeout: 8000 });
  ok(true, 'a secret asks for the password again');
  await axe(page, 'confirming a secret');
  await page.fill('.modal input[name=password]', 'AdminPassw0rd!x');
  await page.click('.modal button[type=submit]');
  ok(await until(() => page.getAttribute('[data-setting="METRICS_TOKEN"]', 'data-source').then(s => s === 'here'), { timeout: 8000 }), '…and is kept once it is given');
  eq(await page.inputValue('#sc-METRICS_TOKEN'), '', 'the box is empty: a secret is never shown again');
  ok(!(await page.content()).includes('metrics-token-from-the-browser-123'), '…nor anywhere on the page');
  const metrics = await page.evaluate(async (b) => (await fetch(`${b}/api/metrics`, { headers: { Authorization: 'Bearer metrics-token-from-the-browser-123' } })).status, base);
  eq(metrics, 200, 'and it is in force at once: /api/metrics answers with it');
  await page.click('[data-setting-remove="METRICS_TOKEN"]');
  await page.waitForSelector('.modal input[name=password]', { timeout: 8000 });
  await page.fill('.modal input[name=password]', 'AdminPassw0rd!x'); await page.click('.modal button[type=submit]');
  ok(await until(() => page.getAttribute('[data-setting="METRICS_TOKEN"]', 'data-source').then(s => s === 'default'), { timeout: 8000 }), 'removing it asks again, then it is gone');
  await axe(page, 'Server configuration');

  // 4. AI copilot, Program, a status line.
  await go('admin?tab=ai');
  ok(await page.$('[data-setting="SUDS_AI_PROVIDER"]') && await page.$('[data-setting="ANTHROPIC_API_KEY"]'), 'the AI copilot tab has the provider and its key inline');
  eq(await page.getAttribute('[data-setting="ANTHROPIC_API_KEY"]', 'data-source'), 'environment', '…the key shown as set in the environment here');
  await page.click('[data-setting-link="SUDS_AI_PROVIDER"]'); await settle(page);
  ok(await landed('SUDS_AI_PROVIDER'), '"Change the provider" goes to it');
  await axe(page, 'AI copilot');
  await go('admin?tab=settings');
  ok(await page.$('.settings-layout nav.on-this-page'), 'Program has "On this page"');
  await page.click('.on-this-page a:has-text("Security policy")'); await settle(page);
  ok(await landed('session_idle_minutes'), '…whose link opens the folded section at its first setting');
  await page.click('[data-setting-link="modules"]'); await settle(page);
  ok(await page.evaluate(() => /^module_/.test(document.activeElement && document.activeElement.name || '')), '"Choose the modules" goes to the module choices');
  await axe(page, 'Program');
} catch (e) { fail(`threw: ${e.stack || e.message}`); }
await browser.close();
for (const e of errors) fail(e);
finish();

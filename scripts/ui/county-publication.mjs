// County publication releases (released in 1.21.0; docs/COUNTY-VIEW.md "Publication"), in the
// browser: County view › Publish.
//   1. The county's administrator prepares a release for a quarter with the keyboard (Enter in a date checks the
//      figures): what would be published takes the focus, names the programs and marks the figures the county
//      entered, shows the people served "suppressed" (a small program beside a big one: the total minus the big
//      one's own figure would give the small one away) and says why without the value. Publish without the review
//      ticked is refused at the box (focus there); ticked with the keyboard, it publishes: said, the focus to the list's
//      heading, the release listed. View release opens it in a dialog (Escape gives the focus back); CSV downloads.
//      The same quarter again is refused as an alert that takes the focus (overlapping releases could be subtracted).
//      Withdraw asks for a reason; the release is listed withdrawn, the focus to the list's heading.
//   2. axe (WCAG 2.1 A/AA) on the Publish tab with what would be published, and on the release's dialog, at 1280
//      and 390 px; nothing sideways at 390 and 320 px.
//   3. Finance sees the releases (county:view) but prepares, publishes and withdraws nothing; read-only is refused.
// The programmes are made through the API as programs not on SUDS with figures the county entered, in a year no
// release on this server covers yet (releases are append-only, so a second run uses an earlier year).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const require = createRequire(import.meta.url);
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('county-publication');
let axeSource = null;
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* reported below */ }
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const STRUCTURE = ['landmark-one-main', 'landmark-no-duplicate-main', 'landmark-unique', 'page-has-heading-one', 'heading-order', 'empty-heading', 'aria-dialog-name', 'empty-table-header'];

const browser = await chromium.launch();
const errors = [];
function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0-9]|42[0-9]/.test(m.text())) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
}
async function signIn(user, pw, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true }); const page = await ctx.newPage(); watch(page, user);
  await page.goto(base + '/#/login'); await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true, first_day_skip: true }) })); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  return { ctx, page };
}
const api = (page, method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, [method, p, body]);
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
const toast = (page, re) => until(async () => { const t = await page.$$eval('.toast', e => e.map(x => x.textContent)); return t.find(x => re.test(x)) || null; });
const focused = (page, sel) => page.evaluate((s) => !!document.activeElement && document.activeElement.matches(s), sel);
async function axe(page, where) {
  if (!axeSource) { fail(`${where}: axe-core is not installed (npm i --no-save playwright axe-core)`); return; }
  await page.evaluate(axeSource + ';0').catch(() => {});
  const v = await page.evaluate(async ({ tags, extra }) => {
    const rules = [...new Set([...window.axe.getRules(tags).map(r => r.ruleId), ...extra])];
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  }, { tags: TAGS, extra: STRUCTURE });
  ok(v.length === 0, `${where}: no WCAG 2.1 A/AA violations`, v);
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

try {
  // ---------------- 1. prepare, review, publish, view, refuse, withdraw ----------------
  const { ctx: admCtx, page: adm } = await signIn('admin', 'AdminPassw0rd!x');
  // A year no release here covers yet (releases are append-only; each run takes an earlier year).
  const published = (await api(adm, 'GET', '/api/county/publications')).data.rows;
  let year = 2019; while (published.some(r => r.period_from <= `${year}-12-31` && r.period_to >= `${year}-01-01`)) year--;
  const q = { from: `${year}-01-01`, to: `${year}-03-31` }; const q2 = { from: `${year}-04-01`, to: `${year}-06-30` };
  const measures = (await api(adm, 'GET', '/api/county/programmes')).data.measures.map(m => m.key);
  const people = new Set(['reversals', 'treatment_admissions', 'referrals_made', 'people_served', 'people_linked', 'moud_linked', 'people_trained']);
  const fund = (n) => ({ name: 'County settlement share', grant_number: `OSF-${year}`, category: 'core_h', hiaa: 'hiaa_4', spend_own_category: '5000', spend_other_categories: '0', spend_pending: '0',
    ...Object.fromEntries(measures.map(k => [k, people.has(k) ? String(n) : k === 'staff_training_hours' ? '4' : '50'])) });
  for (const [name, n] of [[`Harbor Outreach ${year}`, 200], [`Tiny Mobile Unit ${year}`, 7]]) {
    const p = await api(adm, 'POST', '/api/county/programmes', { name, not_on_suds: true });
    eq(p.status, 201, `a program not on SUDS for the release (${name})`);
    for (const period of [q, q2]) eq((await api(adm, 'POST', `/api/county/programmes/${p.data.id}/entries`, { ...period, source_ref: 'Quarterly report (fictional)', funds: [fund(n)] })).status, 201, `with its figures for ${period.from} to ${period.to}`);
  }

  await go(adm, 'county?tab=publish');
  ok(await adm.$('[data-pub-intro]') && /small-cell method/.test(await adm.textContent('[data-pub-intro]')), 'Publish says what a publication release is');
  ok(await adm.$('[data-pub-preparer]'), 'the administrator can prepare one');
  await adm.fill('#cpub-from', q.from); await adm.fill('#cpub-to', q.to);
  await adm.focus('#cpub-to'); await adm.keyboard.press('Enter');
  ok(await until(() => adm.$('[data-pub-result][data-pub-outcome="prepared"]')), 'Enter in a date checks the figures and shows what would be published');
  ok(await until(() => focused(adm, '[data-pub-result]')), 'which takes the focus');
  ok(/What would be published for/.test(await adm.textContent('#cpub-result-h')), 'under a heading that names the period');
  ok((await adm.$$eval('[data-pub-programmes] li', ls => ls.map(l => l.textContent))).some(t => t.includes(`Tiny Mobile Unit ${year}`) && /entered by the county/.test(t)), 'the programs are named, the figures the county entered marked');
  eq((await adm.textContent('[data-pub-review] [data-pub-value="people_served"]')).trim(), 'suppressed', 'people served is suppressed: 207 less the big program\'s own 200 would give the small one away');
  ok(await adm.$('[data-pub-review] [data-pub-suppressed="people_served"]'), 'marked in words beside it');
  const why = await adm.textContent('[data-pub-review] [data-pub-why]');
  ok(/subtracting the other programs' own published figures/.test(why) && !why.includes('207'), 'why it is suppressed is said, never its value');
  eq((await adm.textContent('[data-pub-review] [data-pub-value="naloxone_kits"]')).trim(), '100', 'counts that are not of people are exact');
  await axe(adm, 'Publish, with what would be published (1280)');
  // Publish without the review ticked: refused at the box.
  await adm.click('[data-pub-publish]');
  ok(/Tick that you reviewed/.test(await adm.textContent('#cpub-reviewed-err')), 'Publish without the review ticked is refused at the box');
  ok(await focused(adm, '#cpub-reviewed'), 'and the focus goes to it');
  await adm.keyboard.press('Space');
  ok(await adm.isChecked('#cpub-reviewed'), 'the review is ticked with the keyboard');
  await adm.click('[data-pub-publish]');
  ok(await toast(adm, /Published\. The release is recorded/), 'publishing says so');
  ok(await until(() => focused(adm, '#cpub-list-h')), 'and the focus goes to the list of releases');
  const row = await until(() => adm.$(`[data-pub-rows] tr:has-text("${year}")`));
  ok(row && /Published/.test(await row.textContent()), 'the release is listed as published');
  // View release: a dialog, Escape gives the focus back.
  const viewBtn = adm.locator(`[data-pub-rows] tr:has-text("${year}") [data-pub-open]`).first();
  await viewBtn.click(); await adm.waitForSelector('.modal [data-pub-view]');
  ok(/SHA-256 of what was published/.test(await adm.textContent('.modal')), 'the release opens with the hash of what was published');
  await axe(adm, 'a published release (dialog, 1280)');
  await adm.keyboard.press('Escape'); await until(async () => !(await adm.$('.modal')));
  ok(await focused(adm, '[data-pub-open]'), 'Escape closes it and the focus goes back to View release');
  // CSV.
  const [dl] = await Promise.all([adm.waitForEvent('download'), adm.locator(`[data-pub-rows] tr:has-text("${year}") [data-pub-export="csv"]`).first().click()]);
  eq(dl.suggestedFilename(), `suds-county-publication-${q.from}_${q.to}.csv`, 'the CSV is named after the period');
  const csvPath = await dl.path(); const csv = fs.readFileSync(csvPath, 'utf8');
  ok(csv.includes('Suppressed or withheld') && !csv.includes('207'), 'and says what was suppressed without the value');
  // The same quarter again: refused, as an alert that takes the focus.
  await adm.click('[data-pub-prepare]');
  ok(await until(() => adm.$('[data-pub-result][data-pub-outcome="refused"]')), 'the same quarter again is refused');
  ok(/already published/.test(await adm.textContent('[data-pub-result]')) && (await adm.getAttribute('[data-pub-result]', 'role')) === 'alert', 'saying why, as an alert');
  ok(await focused(adm, '[data-pub-result]'), 'which takes the focus');
  // Withdraw, with a reason.
  await adm.locator(`[data-pub-rows] tr:has-text("${year}") [data-pub-withdraw]`).first().click();
  await adm.waitForSelector('.modal input[id^="confirm-reason"]');
  ok(await focused(adm, '.modal input[id^="confirm-reason"]'), 'Withdraw asks why, the focus in the reason');
  await adm.keyboard.type('A grantee corrected its report');
  await adm.click('.modal .btn-row .btn.danger');
  ok(await toast(adm, /Withdrawn\. The release is kept/), 'withdrawing says the release is kept, marked');
  ok(await until(async () => /Withdrawn/.test(await adm.textContent(`[data-pub-rows] tr:has-text("${year}")`))), 'it is listed withdrawn');
  ok(await until(() => focused(adm, '#cpub-list-h')), 'and the focus goes to the list\'s heading');
  ok(!(await adm.$(`[data-pub-rows] tr:has-text("${year}") [data-pub-withdraw]`)), 'a withdrawn release offers no Withdraw');

  // ---------------- 2. narrow screens ----------------
  for (const width of [390, 320]) {
    await adm.setViewportSize({ width, height: 844 });
    await go(adm, 'county?tab=publish');
    await adm.fill('#cpub-from', q2.from); await adm.fill('#cpub-to', q2.to);
    await adm.click('[data-pub-prepare]');
    ok(await until(() => adm.$('[data-pub-result][data-pub-outcome="prepared"]')), `what would be published at ${width} px`);
    ok(await noSideScroll(adm), `Publish at ${width} px: nothing sideways`);
    if (width === 390) {
      await axe(adm, `Publish at ${width} px`);
      await adm.locator('[data-pub-open]').first().click(); await adm.waitForSelector('.modal [data-pub-view]');
      await axe(adm, `a published release (dialog, ${width})`); ok(await noSideScroll(adm), `the release's dialog at ${width} px: nothing sideways`);
      await adm.keyboard.press('Escape');
    }
  }
  await admCtx.close();

  // ---------------- 3. finance and read-only ----------------
  const { ctx: finCtx, page: fin } = await signIn('afinance', PW);
  await go(fin, 'county?tab=publish');
  ok(await until(() => fin.$(`[data-pub-rows] tr:has-text("${year}")`)), 'finance sees the releases');
  ok(!(await fin.$('[data-pub-preparer]')) && !(await fin.$('[data-pub-withdraw]')), 'but prepares and withdraws nothing');
  eq((await api(fin, 'POST', '/api/county/publications/prepare', { from: `${year}-07-01`, to: `${year}-09-30` })).status, 403, 'and the server refuses finance a release');
  await finCtx.close();
  const { ctx: roCtx, page: ro } = await signIn('rreader', PW);
  eq((await api(ro, 'GET', '/api/county/publications')).status, 403, 'read-only is refused the releases');
  await roCtx.close();
} catch (e) {
  fail(`the script stopped: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
}
finish(errors);
await browser.close();

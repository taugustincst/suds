// The funder report's counting choice and funding-attribution warnings, the visit form's default fund, and
// the harm-reduction reports on the Reports page (docs/compliance/HARM-REDUCTION-REPORTING.md).
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';
import fs from 'node:fs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { readWorkbook } = await import('../../server/spreadsheet.js');
const browser = await chromium.launch();
const { ok, eq, finish } = makeChecks('funder-reporting');
const errors = [];
async function signIn(user, pw) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1300, height: 950 } }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${user} PAGEERROR ${e.message}`)); page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push(`${user} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  return page;
}
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => { const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, [method, path, body]);

// ---- the programme default fund pre-fills a new visit ----
const admin = await signIn('admin', 'AdminPassw0rd!x');
const funds = (await api(admin, 'GET', '/api/budget/funds')).data.funds;
ok(funds.length >= 1, 'the seed has a funding source', funds.length);
const fund = funds[0];
eq((await api(admin, 'PUT', '/api/admin/settings', { default_fund_id: fund.id })).status, 200, 'an administrator sets the programme default fund');
await admin.goto(base + '/#/admin?tab=settings'); await settle(admin);
eq(await admin.$eval('select[name=default_fund_id]', s => s.value), fund.id, 'Settings shows the programme default fund');

const sup = await signIn('jwalker', 'Navigator2026!!');
await sup.goto(base + '/#/interventions'); await settle(sup);
await sup.click('text=+ Log a visit'); await sup.waitForSelector('.modal select[name=funding_source_id]');
eq(await sup.$eval('.modal select[name=funding_source_id]', s => s.value), fund.id, 'a new visit is pre-filled with the default fund');
await sup.keyboard.press('Escape'); await settle(sup);

// ---- funder report: counting mode, attribution warnings ----
// A visit charged to no fund, so the warning has something to point at.
eq((await api(sup, 'POST', '/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), funding_source_id: null })).status, 201, 'a visit charged to no fund');
const today = new Date().toISOString().slice(0, 10); const yearStart = `${today.slice(0, 4)}-01-01`;
await sup.goto(`${base}/#/funder?from=${yearStart}&to=${today}`); await settle(sup);
eq(await sup.$eval('[data-counting-mode]', e => e.dataset.countingMode), 'suppressed', 'the funder report says small cells are suppressed by default');
ok(await sup.$('[data-no-fund-row]'), 'By funding source has a "No funding source" row');
ok(await sup.$('[data-unattributed]'), 'and a warning that services have no funding source');
await sup.selectOption('select[data-counts]', 'exact'); await sup.click('.filters button.primary'); await settle(sup);
eq(await sup.$eval('[data-counting-mode]', e => e.dataset.countingMode), 'exact', 'a supervisor can choose exact counts for the programme\'s own submission');
const [fx] = await Promise.all([sup.waitForEvent('download'), sup.click('[data-funder-export=xlsx]')]);
ok(/exact-counts\.xlsx$/.test(fx.suggestedFilename()), 'the exported report is named for its counting mode', fx.suggestedFilename());
const fwb = readWorkbook(fs.readFileSync(await fx.path()));
const about = fwb.find(s => s.name === 'About');
ok(about && about.rows.some(r => /Exact counts/.test(r.join(' '))), 'and its About sheet states it', about && about.rows.map(r => r.join(':')).join(' | '));
await sup.click('[data-unattributed] a'); await settle(sup);
ok(await until(() => sup.$('[data-no-fund-filter]')), 'the warning opens the visits with no funding source');
ok(/funding=none/.test(sup.url()), 'filtered to them', sup.url());

// ---- harm-reduction reports on the Reports page ----
await sup.goto(`${base}/#/reports?from=${yearStart}&to=${today}`); await settle(sup);
ok(await sup.$('[data-harm-reduction-reports]'), 'Reports has the harm-reduction reporting entries');
const [nd] = await Promise.all([sup.waitForEvent('download'), sup.click('[data-ndp-export=xlsx]')]);
const nwb = readWorkbook(fs.readFileSync(await nd.path()));
ok(/naloxone-ndp-log/.test(nd.suggestedFilename()), 'the NDP log downloads', nd.suggestedFilename());
eq((nwb[0].rows[0] || []).slice(0, 5).join(','), 'Date,Entry,Site type,Recipient type,Kits distributed', 'with the NDP-style columns');
ok(nwb.some(s => s.name === 'About' && s.rows.some(r => /not the official NDP template/.test(r.join(' ')))), 'labelled as not the official NDP template');
const [sd] = await Promise.all([sup.waitForEvent('download'), sup.click('[data-settlement-export=xlsx]')]);
const swb = readWorkbook(fs.readFileSync(await sd.path()));
ok(swb.some(s => s.name === 'By allowable use' && s.rows.length > 10), 'the opioid settlement report lists every allowable use', swb.map(s => s.name).join(','));

// A read-only account sees neither export.
const ro = await signIn('rreader', 'Navigator2026!!');
await ro.goto(base + '/#/reports'); await settle(ro);
ok(!(await ro.$('[data-harm-reduction-reports]')), 'a read-only account is not offered the exports');
await api(admin, 'PUT', '/api/admin/settings', { default_fund_id: null });
finish(errors);
await browser.close();

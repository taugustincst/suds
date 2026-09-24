import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';
import fs from 'node:fs'; fs.mkdirSync('/tmp/suds-shots', { recursive: true });
async function dismissTour(p) { await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await settle(p); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); }
fs.writeFileSync('/tmp/suds-shots/clients-import.csv', 'First Name,Last Name,DOB,Phone,Status,Substance,Risk\nAmy,Sheetimport,5/2/1988,555-0300,active,fentanyl,high\nBob,Sheetimport,1975-01-15,555-0301,waitlist,alcohol,low\nBad,Row,notadate,,,,\n');
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch(); const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1300, height: 950 } }); const page = await ctx.newPage();
const { ok, finish } = makeChecks('spreadsheets');
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'jwalker'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout'); await dismissTour(page); await page.keyboard.press('Escape');
await page.goto(base + '/#/reports'); await settle(page);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Everything as one Excel workbook')]);
const path = await dl.path(); const { readWorkbook } = await import('../../server/spreadsheet.js'); const wb = readWorkbook(fs.readFileSync(path));
ok(/\.xlsx$/.test(dl.suggestedFilename()), 'the whole programme downloads as one workbook', dl.suggestedFilename());
ok(wb.length >= 5 && wb.every(sh => sh.rows.length >= 1), 'with a sheet per record type, each with a header row', wb.map(sh => `${sh.name}:${sh.rows.length - 1}`).join(' '));
ok(wb.some(sh => sh.rows.length > 1), 'and data in them');
await page.goto(base + '/#/imports'); await settle(page);
await page.selectOption('select >> nth=0', 'clients'); await page.setInputFiles('input[type=file][accept=".xlsx,.csv"]', '/tmp/suds-shots/clients-import.csv'); await page.waitForSelector('button:has-text("Import 2 rows")', { timeout: 15000 }).catch(() => {});
await page.screenshot({ path: '/tmp/suds-shots/xl_import.png', fullPage: true });
const badges = await page.$$eval('.card .badge', b => b.map(x => x.textContent).join(' | '));
ok(/2/.test(badges), 'the preview counts the rows that will import', badges);
ok(/1/.test(badges), 'and the row it cannot read', badges);
await page.click('button:has-text("Import 2 rows")'); await page.waitForSelector('.modal button.primary'); await page.click('.modal button.primary'); await settle(page);
ok(await until(async () => /import/i.test((await page.$$eval('.toast', e => e.map(x => x.textContent))).join('|'))), 'the import reports what it did');
await page.goto(base + '/#/clients?q=sheetimport&status=all'); await settle(page);
ok(await until(async () => await page.$$eval('tbody tr', r => r.length) >= 2), 'both readable rows became clients');
// local mode: template download + import preview through the in-page kernel
const lp = await (await browser.newContext({ acceptDownloads: true })).newPage(); lp.on('pageerror', e => errors.push('LOCAL PAGEERROR ' + e.message));
await lp.goto(base + '/?local=1#/'); await settle(lp);
await lp.fill('input[name=display_name]', 'L'); await lp.fill('input[name=username]', 'localnav'); await lp.fill('input[name=password]', 'Navigator2026!!'); await lp.fill('input[name=confirm]', 'Navigator2026!!'); await lp.click('button[type=submit]'); await lp.waitForSelector('.layout'); await settle(lp); for (let i = 0; i < 5; i++) { const b = await lp.$('.modal button.primary'); if (!b) break; await b.click(); await settle(lp); }
await lp.goto(base + '/?local=1#/imports'); await settle(lp);
const [ldl] = await Promise.all([lp.waitForEvent('download'), lp.click('text=Download Excel template')]); const lwb = readWorkbook(fs.readFileSync(await ldl.path()));
ok(/First name/i.test(lwb[0].rows[0].join(',')), 'a phone with no server still builds the Excel template', lwb[0].rows[0].slice(0, 3).join(','));
await lp.setInputFiles('input[type=file][accept=".xlsx,.csv"]', '/tmp/suds-shots/clients-import.csv'); await lp.waitForSelector('button:has-text("Import 2 rows")', { timeout: 15000 }).catch(() => {});
await lp.click('button:has-text("Import 2 rows")'); await lp.waitForSelector('.modal button.primary'); await lp.click('.modal button.primary'); await settle(lp);
ok(await until(async () => /import/i.test((await lp.$$eval('.toast', e => e.map(x => x.textContent))).join('|'))), 'and imports a spreadsheet on the device itself');
finish(errors);
await browser.close();

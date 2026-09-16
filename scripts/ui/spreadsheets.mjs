import { chromium } from 'playwright';
import fs from 'node:fs'; fs.mkdirSync('/tmp/suds-shots', { recursive: true });
async function dismissTour(p) { await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await p.waitForTimeout(700); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); }
fs.writeFileSync('/tmp/suds-shots/clients-import.csv', 'First Name,Last Name,DOB,Phone,Status,Substance,Risk\nAmy,Sheetimport,5/2/1988,555-0300,active,fentanyl,high\nBob,Sheetimport,1975-01-15,555-0301,waitlist,alcohol,low\nBad,Row,notadate,,,,\n');
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch(); const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1300, height: 950 } }); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'jwalker'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout'); await dismissTour(page); await page.keyboard.press('Escape');
await page.goto(base + '/#/reports'); await page.waitForTimeout(900);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Everything as one Excel workbook')]);
const path = await dl.path(); const { readWorkbook } = await import('../../server/spreadsheet.js'); const wb = readWorkbook(fs.readFileSync(path));
console.log('workbook:', dl.suggestedFilename(), wb.map(s => `${s.name}:${s.rows.length - 1}`).join(' '));
await page.goto(base + '/#/imports'); await page.waitForTimeout(900);
await page.selectOption('select >> nth=0', 'clients'); await page.setInputFiles('input[type=file][accept=".xlsx,.csv"]', '/tmp/suds-shots/clients-import.csv'); await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/suds-shots/xl_import.png', fullPage: true });
console.log('badges:', await page.$$eval('.card .badge', b => b.map(x => x.textContent).slice(0, 6).join(' | ')));
await page.click('button:has-text("Import 2 rows")'); await page.waitForTimeout(300); await page.click('.modal button.primary'); await page.waitForTimeout(1200);
console.log('toast:', (await page.$$eval('.toast', e => e.map(x => x.textContent))).join('|'));
await page.goto(base + '/#/clients?q=sheetimport&status=all'); await page.waitForTimeout(900); console.log('imported clients found:', await page.$$eval('tbody tr', r => r.length));
// local mode: template download + import preview through the in-page kernel
const lp = await (await browser.newContext({ acceptDownloads: true })).newPage(); lp.on('pageerror', e => errors.push('LOCAL PAGEERROR ' + e.message));
await lp.goto(base + '/?local=1#/'); await lp.waitForTimeout(2500);
await lp.fill('input[name=display_name]', 'L'); await lp.fill('input[name=username]', 'localnav'); await lp.fill('input[name=password]', 'Navigator2026!!'); await lp.fill('input[name=confirm]', 'Navigator2026!!'); await lp.click('button[type=submit]'); await lp.waitForSelector('.layout'); await lp.waitForTimeout(600); for (let i = 0; i < 5; i++) { const b = await lp.$('.modal button.primary'); if (!b) break; await b.click(); await lp.waitForTimeout(120); }
await lp.goto(base + '/?local=1#/imports'); await lp.waitForTimeout(1200);
const [ldl] = await Promise.all([lp.waitForEvent('download'), lp.click('text=Download Excel template')]); const lwb = readWorkbook(fs.readFileSync(await ldl.path())); console.log('local template:', ldl.suggestedFilename(), lwb[0].rows[0].slice(0, 3).join(','));
await lp.setInputFiles('input[type=file][accept=".xlsx,.csv"]', '/tmp/suds-shots/clients-import.csv'); await lp.waitForTimeout(1500);
await lp.click('button:has-text("Import 2 rows")'); await lp.waitForTimeout(300); await lp.click('.modal button.primary'); await lp.waitForTimeout(1200);
console.log('local toast:', (await lp.$$eval('.toast', e => e.map(x => x.textContent))).join('|'));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO ERRORS'); if (errors.length) process.exitCode = 1;
await browser.close();

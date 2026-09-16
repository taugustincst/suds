// Phone-only copy: a brand-new device offers sample data, loads it, shows it everywhere, and removes it cleanly.
import { chromium } from 'playwright';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
await page.goto(base + '/?local=1#/'); await page.waitForTimeout(2500);
if (!await page.$('input[name=username]')) { console.log('device already set up; wiping'); await page.evaluate(() => window.SUDS_LOCAL.wipe()); await page.reload(); await page.waitForTimeout(2500); }
await page.fill('input[name=display_name]', 'Sample Nav'); await page.fill('input[name=username]', 'samplenav'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 }); await page.waitForTimeout(1200);
for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await page.waitForTimeout(150); }
const banner = await page.$('[data-sample-banner]'); console.log('dashboard offers sample data:', !!banner); if (!banner) errors.push('no sample banner on empty dashboard');
await page.goto(base + '/?local=1#/sync'); await page.waitForTimeout(1200);
console.log('sync card state:', await page.getAttribute('[data-sample]', 'data-sample'));
await page.click('button:has-text("Load sample data")'); await page.waitForSelector('[data-sample=loaded]', { timeout: 20000 }); await page.waitForTimeout(500);
console.log('after load:', (await page.textContent('[data-sample]')).replace(/\s+/g, ' ').slice(0, 120));
await page.goto(base + '/?local=1#/clients'); await page.waitForTimeout(1500); const rows = await page.$$eval('tbody tr', r => r.length); console.log('client rows (active by default):', rows); if (rows !== 9) errors.push('expected 9 active sample clients, saw ' + rows);
await page.click('tbody tr.click'); await page.waitForTimeout(1200); console.log('client page:', page.url().split('#')[1], (await page.textContent('h1')).trim());
const cid = page.url().split('/client/')[1].split('/')[0];
for (const t of ['timeline', 'notes', 'referrals', 'budget']) { await page.goto(`${base}/?local=1#/client/${cid}/${t}`); await page.waitForTimeout(800); if (await page.$('.main .boot')) errors.push('still loading ' + t); }
await page.goto(base + '/?local=1#/'); await page.waitForTimeout(1500); console.log('dashboard banner gone:', !(await page.$('[data-sample-banner]')));
await page.goto(base + '/?local=1#/reports'); await page.waitForTimeout(1500); console.log('reports has numbers:', /\d/.test(await page.textContent('.main')));
// remove
await page.goto(base + '/?local=1#/sync'); await page.waitForTimeout(1200); await page.click('button:has-text("Remove sample data")'); await page.waitForTimeout(300); await page.click('.modal button.danger, .modal button.primary'); await page.waitForSelector('[data-sample=empty]', { timeout: 20000 });
await page.goto(base + '/?local=1#/clients'); await page.waitForTimeout(1200); const rows2 = await page.$$eval('tbody tr', r => r.length); console.log('rows after remove:', rows2); if (rows2 !== 0) errors.push('sample rows remain: ' + rows2);
await page.evaluate(() => window.SUDS_LOCAL.wipe());
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO ERRORS'); if (errors.length) process.exitCode = 1;
await browser.close();

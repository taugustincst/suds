import { chromium, devices } from 'playwright';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
import('node:fs').then(m => m.mkdirSync('/tmp/suds-shots', { recursive: true }));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push('CONSOLE ' + m.text()); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: null, theme: null }) })); await page.reload(); await page.waitForSelector('.layout');
await page.waitForTimeout(900); await page.screenshot({ path: '/tmp/suds-shots/ux_tour.png' });
console.log('tour shown:', !!(await page.$('.modal')));
for (let i = 0; i < 5; i++) { await page.click('.modal button.primary'); await page.waitForTimeout(150); }
console.log('tour closed:', !(await page.$('.modal')));
await page.waitForTimeout(500); await page.screenshot({ path: '/tmp/suds-shots/ux_dashboard.png' });
// global search
await page.fill('.gsearch input', 'nguyen'); await page.waitForTimeout(600); console.log('search results:', await page.$$eval('.search-results a', a => a.length));
await page.click('.search-results a'); await page.waitForTimeout(600); console.log('opened', page.url());
// quick log → note with autosave
await page.click('.appbar .btn.quick'); await page.waitForTimeout(300); await page.click('.quick-list button:has-text("Note")'); await page.waitForSelector('.modal textarea[name=content]');
const cid = page.url().split('/client/')[1].split('/')[0];
await page.evaluate((id) => { const hid = document.querySelector('.modal input[name=client_id]'); hid.value = id; }, cid);
await page.fill('.modal textarea[name=content]', 'Autosave test from desktop.'); await page.waitForTimeout(3200);
const st = await page.textContent('.modal .autosave'); console.log('autosave status:', st);
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
const drafts = await page.evaluate(() => fetch('/api/me/continue').then(r => r.json())); console.log('drafts on server:', drafts.drafts.length, 'recent:', drafts.recent.length);
// help tip
await page.goto(base + '/#/interventions'); await page.waitForTimeout(600); await page.click('.help-btn'); await page.waitForTimeout(200); console.log('help visible:', !(await page.$eval('.helptip', e => e.classList.contains('hidden'))));
await page.screenshot({ path: '/tmp/suds-shots/ux_help.png' });
// new client form collapsible
await page.goto(base + '/#/clients'); await page.waitForTimeout(500); await page.click('text=+ New client'); await page.waitForSelector('.modal'); console.log('details sections:', await page.$$eval('.modal details.section', d => d.map(x => x.open))); await page.screenshot({ path: '/tmp/suds-shots/ux_client_form.png' }); await page.keyboard.press('Escape');
// theme pref synced
await page.click('text=Light/dark'); await page.waitForTimeout(1200); const prefs = await page.evaluate(() => fetch('/api/me/prefs').then(r => r.json())); console.log('prefs on server:', JSON.stringify(prefs.prefs));
await page.click('text=Light/dark'); await page.waitForTimeout(1000);
// mobile
const m = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage(); m.on('pageerror', e => errors.push('M PAGEERROR ' + e.message));
await m.goto(base + '/#/login'); await m.fill('input[name=username]', 'mrivera'); await m.fill('input[name=password]', 'Navigator2026!!'); await m.click('button[type=submit]'); await m.waitForSelector('.layout'); await m.waitForTimeout(800);
console.log('tour on second device (should be false):', !!(await m.$('.modal')));
await m.screenshot({ path: '/tmp/suds-shots/ux_m_home.png' });
await m.click('.fab button'); await m.waitForTimeout(300); await m.screenshot({ path: '/tmp/suds-shots/ux_m_quick.png' }); console.log('fab opens quick list:', !!(await m.$('.quick-list')));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO ERRORS'); if (errors.length) process.exitCode = 1;
await browser.close();

// The same reminder must show the same day on the to-do list, the client timeline and Home.
import { chromium } from 'playwright';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch(); const errors = [];
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }); let loggedIn = false;
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout'); loggedIn = true;
await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await page.waitForTimeout(1200); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
// pick a client, add a reminder due on a calendar day
await page.goto(base + '/#/clients'); await page.waitForTimeout(800); await page.click('tbody tr.click'); await page.waitForTimeout(800);
const cid = page.url().split('/client/')[1].split('/')[0];
const d = new Date(); d.setDate(d.getDate() + 3); const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const expected = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
await page.click('button:has-text("+ Task")'); await page.waitForSelector('.modal input[name=title]'); await page.fill('.modal input[name=title]', 'Bring ID to DMV appt'); await page.fill('.modal input[name=due_at]', iso + 'T17:00'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(900);
const timeline = async () => { await page.goto(`${base}/#/client/${cid}/timeline`); await page.waitForTimeout(900); return (await page.$$eval('.timeline li', li => li.map(x => x.textContent.replace(/\s+/g, ' ')))).find(t => /Bring ID to DMV appt/.test(t)) || ''; };
const tl = await timeline(); console.log('timeline:', tl.slice(0, 80));
await page.goto(base + '/#/tasks'); await page.waitForTimeout(900);
const row = (await page.$$eval('tbody tr', tr => tr.map(x => x.textContent.replace(/\s+/g, ' ')))).find(t => /Bring ID to DMV appt/.test(t)) || ''; console.log('to-do:', row.slice(0, 90));
if (!tl.includes(expected)) errors.push(`timeline shows a different day: expected "${expected}" in "${tl.slice(0, 80)}"`);
if (!row.includes(expected)) errors.push(`to-do shows a different day: expected "${expected}" in "${row.slice(0, 90)}"`);
if (/Bring Id To Dmv/.test(tl)) errors.push('timeline re-cased the title');
// mark it done on the to-do list; the timeline must reflect it without a reload trick
await page.$eval('tbody tr:has-text("Bring ID to DMV appt") input[type=checkbox]', el => el.click()); await page.waitForTimeout(900);
const tl2 = await timeline(); console.log('timeline after done:', /Done/.test(tl2)); if (!/Done/.test(tl2)) errors.push('timeline did not pick up the completed task');
// phone width: to-do list renders as readable cards, no horizontal overflow
await page.setViewportSize({ width: 390, height: 800 }); await page.goto(base + '/#/tasks?status=all'); await page.waitForTimeout(1000);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth); const labelled = await page.$$eval('.table-wrap td[data-label="Due"]', t => t.length);
console.log('phone overflow:', overflow, '| labelled cells:', labelled); if (overflow) errors.push('to-do list overflows on a phone'); if (!labelled) errors.push('phone cards missing labels');
await page.screenshot({ path: '/tmp/suds-shots/todo-phone.png' });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO ERRORS'); if (errors.length) process.exitCode = 1;
await browser.close();

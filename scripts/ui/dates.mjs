// The same reminder must show the same day on the to-do list, the client timeline and Home.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch(); const errors = [];
const { ok, finish } = makeChecks('dates');
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }); let loggedIn = false;
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout'); loggedIn = true;
await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
// pick a client, add a reminder due on a calendar day
await page.goto(base + '/#/clients'); await settle(page); await page.waitForSelector('tbody tr.click', { timeout: 15000 }); await page.click('tbody tr.click'); await settle(page);
const cid = page.url().split('/client/')[1].split('/')[0];
const d = new Date(); d.setDate(d.getDate() + 3); const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const expected = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
await page.click('button:has-text("+ Task")'); await page.waitForSelector('.modal input[name=title]'); await page.fill('.modal input[name=title]', 'Bring ID to DMV appt'); await page.fill('.modal input[name=due_at]', iso); await page.fill('.modal input[name=due_at_time]', '17:00'); await page.click('.modal button[type=submit]'); await settle(page);
const timeline = async () => { await page.goto(`${base}/#/client/${cid}/timeline`); await settle(page); return (await page.$$eval('.timeline li', li => li.map(x => x.textContent.replace(/\s+/g, ' ')))).find(t => /Bring ID to DMV appt/.test(t)) || ''; };
const tl = await timeline();
ok(tl.length > 0, 'the reminder appears on the client timeline');
await page.goto(base + '/#/tasks'); await settle(page);
const row = await until(async () => (await page.$$eval('tbody tr', tr => tr.map(x => x.textContent.replace(/\s+/g, ' ')))).find(t => /Bring ID to DMV appt/.test(t))) || '';
ok(row.length > 0, 'and on the to-do list');
ok(tl.includes(expected), `the timeline shows the day it is due (${expected})`, tl.slice(0, 80));
ok(row.includes(expected), `the to-do list shows the same day (${expected})`, row.slice(0, 90));
ok(!/Bring Id To Dmv/.test(tl), 'the title is shown as it was typed, not re-cased');
// mark it done on the to-do list; the timeline must reflect it without a reload trick
await page.$eval('tbody tr:has-text("Bring ID to DMV appt") input[type=checkbox]', el => el.click()); await settle(page);
const tl2 = await timeline();
ok(/Done/.test(tl2), 'ticking it off on the to-do list shows as done on the timeline');
// phone width: to-do list renders as readable cards, no horizontal overflow
await page.setViewportSize({ width: 390, height: 800 }); await page.goto(base + '/#/tasks?status=all'); await settle(page);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth); const labelled = await page.$$eval('.table-wrap td[data-label="Due"]', t => t.length);
ok(!overflow, 'the to-do list does not scroll sideways on a phone');
ok(labelled > 0, 'and its cards label each value', labelled);
await page.screenshot({ path: '/tmp/suds-shots/todo-phone.png' });
finish(errors);
await browser.close();

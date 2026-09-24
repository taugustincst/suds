// Phone-only copy: a brand-new device offers sample data, loads it, shows it everywhere, and removes it cleanly.
import { chromium } from 'playwright';
import { makeChecks, settle } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { ok, eq, finish } = makeChecks('sample-data');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
await page.goto(base + '/?local=1#/'); await settle(page);
if (!await page.$('input[name=username]')) { console.log('device already set up; wiping'); await page.evaluate(() => window.SUDS_LOCAL.wipe()); await page.reload(); await settle(page); }
await page.fill('input[name=display_name]', 'Sample Nav'); await page.fill('input[name=username]', 'samplenav'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 }); await settle(page);
for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); }
ok(await page.$('[data-sample-banner]'), 'an empty device offers sample data on the dashboard');

await page.goto(base + '/?local=1#/sync'); await settle(page);
// A phone with no Keystore keeps its keys in the browser profile, and has to say so before anyone types
// real client details into it.
ok(await page.$('.banner.warn'), 'a browser copy warns that its keys live in this browser profile');
eq(await page.getAttribute('[data-sample]', 'data-sample'), 'empty', 'the sync screen starts with no sample data');
// The page must not be wider than the phone: a screen that scrolls sideways puts its last controls out of reach.
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(overflow <= 1, 'the sync screen fits the width of a phone', overflow);

await page.click('button:has-text("Load sample data")'); await page.waitForSelector('[data-sample=loaded]', { timeout: 20000 }); await settle(page);
const loadedText = (await page.textContent('[data-sample]')).replace(/\s+/g, ' ');
ok(/fictional clients/.test(loadedText), 'the card reports what was loaded', loadedText.slice(0, 120));

await page.goto(base + '/?local=1#/clients'); await settle(page);
eq(await page.$$eval('tbody tr', r => r.length), 9, 'the client list shows the active sample clients');
// On a phone the list is the compact row list (app.js table() compact); the table rows exist but are not shown.
const rowSel = (await page.$eval('.compact-list', l => getComputedStyle(l).display !== 'none').catch(() => false)) ? '.compact-row.click' : 'tbody tr.click';
await page.waitForSelector(rowSel, { timeout: 15000 }); await page.click(rowSel); await settle(page);
ok(/^\/client\//.test(page.url().split('#')[1] || ''), 'a row opens the client', page.url().split('#')[1]);
ok((await page.textContent('h1')).trim().length > 0, 'the client page has a name in its heading');
const cid = page.url().split('/client/')[1].split('/')[0];
for (const t of ['timeline', 'notes', 'referrals', 'budget']) {
  await page.goto(`${base}/?local=1#/client/${cid}/${t}`); await settle(page);
  ok(!(await page.$('.main .boot')), `the ${t} tab finishes loading`);
}
await page.goto(base + '/?local=1#/'); await settle(page);
ok(!(await page.$('[data-sample-banner]')), 'the offer disappears once sample data is loaded');
await page.goto(base + '/?local=1#/reports'); await settle(page);
ok(/\d/.test(await page.textContent('.main')), 'reports are populated from the sample data');

// remove
await page.goto(base + '/?local=1#/sync'); await settle(page); await page.click('button:has-text("Remove sample data")'); await page.waitForSelector('.modal button.danger, .modal button.primary'); await page.click('.modal button.danger, .modal button.primary'); await page.waitForSelector('[data-sample=empty]', { timeout: 20000 });
await page.goto(base + '/?local=1#/clients'); await settle(page);
eq(await page.$$eval('tbody tr', r => r.length), 0, 'removing the sample data leaves nothing behind');
// A copy the office server hands out may hold real clients: once one exists, sample data is refused
// there (the static demo build is the one place it is added alongside; static-site.mjs).
const refused = await page.evaluate(async () => {
  await window.SUDS_LOCAL.handle('POST', '/api/clients', { first_name: 'Real', last_name: 'Person' }, { 'X-Requested-With': 'suds' });
  const r = await window.SUDS_LOCAL.handle('POST', '/api/local/demo', {}, { 'X-Requested-With': 'suds' });
  return { status: r.status, error: r.json && r.json.error };
});
ok(refused.status === 400 && /no clients yet/.test(refused.error || ''), 'with a client on the device, the office-served copy refuses sample data', refused);
await page.goto(base + '/?local=1#/sync'); await settle(page);
ok(await page.$('[data-sample-refused]'), 'and the Sync page says why instead of offering the button');
await page.evaluate(() => window.SUDS_LOCAL.wipe());
finish(errors);
await browser.close();

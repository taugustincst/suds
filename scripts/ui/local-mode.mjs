import { chromium } from 'playwright';
import { makeChecks, until } from './assert.mjs';
const { ok, eq, fail, finish } = makeChecks('local-mode');
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
import('node:fs').then(m => m.mkdirSync('/tmp/suds-shots', { recursive: true }));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
await page.goto(base + '/?local=1#/'); await page.waitForTimeout(2500);
const bootText = (await page.textContent('#app')).slice(0, 120).replace(/\s+/g, ' ');
console.log('hash:', page.url().split('#')[1], '| boot text:', bootText);
// This whole block used to be inside `if (await page.$(...))`, so when the kernel failed to boot and the
// page rendered nothing, the script printed "NO ERRORS" and exited 0. A dead phone app is a failure.
ok(await page.$('input[name=username]'), 'the local kernel booted and offered first-run setup', bootText);
{
  await page.fill('input[name=display_name]', 'Phone Nav'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 }); await page.waitForTimeout(800);
  ok(await page.$('.layout'), 'the app is usable straight after setup');
  ok(await page.$('text=On this device'), 'and says it is running on this device');
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await page.waitForTimeout(150); }
  // create a client locally
  await page.click('text=+ Log'); await page.waitForTimeout(300); await page.click('.quick-list button:has-text("New client")'); await page.waitForSelector('.modal input[name=first_name]');
  await page.fill('.modal input[name=first_name]', 'Local'); await page.fill('.modal input[name=last_name]', 'Phoneclient'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(1000);
  ok(/^\/client\//.test(page.url().split('#')[1] || ''), 'a client created on the device opens its own page', page.url().split('#')[1]);
  await page.click('text=+ Intervention'); await page.waitForSelector('.modal select[name=type]'); await page.selectOption('.modal select[name=type]', 'outreach'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
  const toasts = await until(async () => { const t = await page.$$eval('.toast', e => e.map(x => x.textContent)); return t.length ? t : null; }) || [];
  ok(toasts.length > 0 && !toasts.some(t => /error|failed|could not/i.test(t)), 'recording a visit on the device confirms it saved', toasts);
  // persistence across reload
  await page.waitForTimeout(800); await page.reload(); await page.waitForTimeout(2500);
  ok(await page.$('.layout'), 'the device is still signed in after a reload', (await page.textContent('#app')).slice(0, 80));
  await page.goto(base + '/?local=1#/clients'); await page.waitForTimeout(1200);
  const rowsBefore = await page.$$eval('tbody tr', r => r.length);
  ok(rowsBefore >= 1, 'the client entered on the device survived the reload', rowsBefore);
  // sync against the dev server (same host)
  await page.goto(base + '/?local=1#/sync'); await page.waitForTimeout(1200);
  await page.fill('input[name=server]', base); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!');
  await page.click('button[type=submit]'); await page.waitForTimeout(6000);
  // The sync log stays empty until the round trip finishes; an empty read is not a pass or a failure.
  const log = await until(async () => (await page.textContent('.card:nth-of-type(2) .small.muted.mt')) || '', { timeout: 20000 }) || '';
  ok(!/fail|error|could not/i.test(log), 'the sync reported no failure', log.slice(0, 200));
  await page.goto(base + '/?local=1#/clients'); await page.waitForTimeout(1500);
  const rowsAfter = await until(async () => { const n = await page.$$eval('tbody tr', r => r.length); return n > rowsBefore ? n : 0; }) || await page.$$eval('tbody tr', r => r.length);
  ok(rowsAfter > rowsBefore, 'syncing brought the office caseload onto the device', { before: rowsBefore, after: rowsAfter });
  await page.screenshot({ path: '/tmp/suds-shots/local_clients.png' });
  // Locked out or forgot the password, with no office admin to ask: the login screen offers a self-service
  // reset instead of a dead end.
  await page.click('text=Sign out'); await page.waitForSelector('input[name=username]', { timeout: 8000 });
  ok(!(await page.$('input[name=display_name]')), 'signing out lands back on the login screen, not first-run setup', page.url());
  ok(await page.$('text=Reset this device'), 'a locked-out device offers a self-service reset instead of only "ask an admin"');
  await page.click('text=Reset this device'); await page.waitForSelector('.modal');
  await page.fill('#reset-device-confirm', 'nope');
  await page.click('.modal button.danger'); await page.waitForTimeout(400);
  ok(!!(await page.$('.modal')), 'a wrong confirmation phrase does not erase the device');
  await page.fill('#reset-device-confirm', 'ERASE');
  await page.click('.modal button.danger'); await page.waitForSelector('input[name=display_name]', { timeout: 10000 });
  ok(!!(await page.$('input[name=display_name]')), 'typing ERASE wipes the device and returns to first-run setup', page.url());
}
finish(errors.slice(0, 8));
await browser.close();

import { chromium } from 'playwright';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
import('node:fs').then(m => m.mkdirSync('/tmp/suds-shots', { recursive: true }));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
await page.goto(base + '/?local=1#/'); await page.waitForTimeout(2500);
console.log('hash:', page.url().split('#')[1], '| boot text:', (await page.textContent('#app')).slice(0, 80).replace(/\s+/g, ' '));
if (await page.$('input[name=username]')) {
  await page.fill('input[name=display_name]', 'Phone Nav'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 }); await page.waitForTimeout(800);
  console.log('after setup:', page.url().split('#')[1], 'local badge:', !!(await page.$('text=On this device')));
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await page.waitForTimeout(150); }
  // create a client locally
  await page.click('text=+ Log'); await page.waitForTimeout(300); await page.click('.quick-list button:has-text("New client")'); await page.waitForSelector('.modal input[name=first_name]');
  await page.fill('.modal input[name=first_name]', 'Local'); await page.fill('.modal input[name=last_name]', 'Phoneclient'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(1000);
  console.log('client created:', page.url().split('#')[1]);
  await page.click('text=+ Intervention'); await page.waitForSelector('.modal select[name=type]'); await page.selectOption('.modal select[name=type]', 'outreach'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
  console.log('toasts:', (await page.$$eval('.toast', e => e.map(x => x.textContent))).join('|'));
  // persistence across reload
  await page.waitForTimeout(800); await page.reload(); await page.waitForTimeout(2500);
  console.log('after reload:', page.url().split('#')[1], (await page.textContent('#app')).slice(0, 60).replace(/\s+/g, ' '));
  await page.goto(base + '/?local=1#/clients'); await page.waitForTimeout(1200); console.log('local clients rows:', await page.$$eval('tbody tr', r => r.length));
  // sync against the dev server (same host)
  await page.goto(base + '/?local=1#/sync'); await page.waitForTimeout(1200);
  await page.fill('input[name=server]', base); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!');
  await page.click('button[type=submit]'); await page.waitForTimeout(6000);
  console.log('sync log:', (await page.textContent('.card:nth-of-type(2) .small.muted.mt')).slice(0, 300));
  await page.goto(base + '/?local=1#/clients'); await page.waitForTimeout(1500); console.log('local clients after sync:', await page.$$eval('tbody tr', r => r.length));
  await page.screenshot({ path: '/tmp/suds-shots/local_clients.png' });
}
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO ERRORS'); if (errors.length) process.exitCode = 1;
await browser.close();

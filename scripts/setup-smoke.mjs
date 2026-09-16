// Browser smoke test of the first-run setup wizard. Start a fresh production server first:
//   SUDS_ENV=production SUDS_DATA_DIR=/tmp/sudsfresh PORT=8095 node server/index.js
// then: node scripts/setup-smoke.mjs   (needs a global Playwright install: npm i -g playwright)
import { chromium } from 'playwright';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8095';
const port = Number(process.env.SETUP_PORT || 8496);
const browser = await chromium.launch(); const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push('CONSOLE ' + m.text()); });
await page.goto(base + '/'); await page.waitForTimeout(800);
console.log('landed on', page.url());
await page.fill('input[name=org_name]', 'Demo County SUD Navigation'); await page.fill('input[name=admin_display_name]', 'Pat Admin'); await page.fill('input[name=admin_username]', 'padmin');
await page.fill('input[name=admin_password]', 'SetupPassw0rd!x'); await page.fill('input[name=confirm]', 'SetupPassw0rd!x'); await page.fill('input[name=port]', String(port));
await page.click('button[type=submit]'); await page.waitForTimeout(2500);
const after = `https://127.0.0.1:${port}`;
await page.goto(after + '/#/login'); await page.waitForTimeout(800);
await page.fill('input[name=username]', 'padmin'); await page.fill('input[name=password]', 'SetupPassw0rd!x'); await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 8000 });
console.log('logged in over https at', page.url());
await page.keyboard.press('Escape');
await page.goto(after + '/#/admin?tab=system'); await page.waitForTimeout(700);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download encrypted backup')]); console.log('backup download:', dl.suggestedFilename());
const again = await page.evaluate(() => fetch('/api/setup/status').then(r => r.json())); console.log('setup needed after:', again.needed);
console.log(errors.length ? errors.join('\n') : 'NO ERRORS');
await browser.close();

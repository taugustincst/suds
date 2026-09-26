// First-run setup where the address does not change: "Only this computer", HTTPS off, the port fixed by
// PORT. The wizard's "Go to sign-in" (and its automatic move there) is then only a change of the #hash on
// the same page, and up to 1.12.0 the page still believed setup was needed: #/setup sent it to #/login,
// the app sent it back to #/setup, several hundred times a second. Every request the server saw from that
// computer for the next minute was refused (429, the API limit of 600 a minute), the first sign-in with it.
//
// Starts its own unconfigured production server in a fresh data directory (under SUDS_UI_TMP) on a free
// port, so it depends on nothing else in the suite.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { makeChecks, until, settle } from './assert.mjs';

const { ok, eq, finish } = makeChecks('setup-same-origin');
const port = await new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const dataDir = mkdtempSync(path.join(process.env.SUDS_UI_TMP || '/tmp', 'suds-setup-same-origin-'));
const env = { ...process.env, SUDS_ENV: 'production', SUDS_DATA_DIR: dataDir, PORT: String(port), SUDS_ADMIN_PASSWORD: '', LOCAL_MODE_ENABLED: '', LOGIN_RATE_LIMIT: '' };
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], { env, stdio: 'ignore' });
const base = `http://localhost:${port}`;
const up = await until(() => fetch(`${base}/api/setup/status`).then(r => r.ok).catch(() => false), { timeout: 20000, every: 250 });
ok(up, 'a fresh unconfigured server starts', base);

const browser = await chromium.launch();
const errors = [];
try {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/40[13]|net::ERR|Failed to fetch/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
  let apiCalls = 0, tooMany = 0;
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls++; });
  page.on('response', r => { if (r.status() === 429) tooMany++; });

  await page.goto(base + '/'); await settle(page);
  ok(/#\/setup$/.test(page.url()), 'the wizard opens', page.url());
  await page.fill('input[name=org_name]', 'Same Origin Programme'); await page.fill('input[name=admin_display_name]', 'Sam Admin'); await page.fill('input[name=admin_username]', 'sadmin');
  await page.fill('input[name=admin_password]', 'SetupPassw0rd!x'); await page.fill('input[name=confirm]', 'SetupPassw0rd!x');
  await page.selectOption('select[name=network]', 'local');
  await page.uncheck('input[name=https]');
  await page.click('button[type=submit]');
  ok(await until(() => page.textContent('#app').then(t => /Setup complete/.test(t)), { timeout: 20000 }), 'the wizard completes');
  const link = await page.getAttribute('a.btn.primary', 'href');
  eq(new URL(link).origin, base, 'and its sign-in address is this same page (only the #hash changes)');

  const before = apiCalls;
  await page.click('a.btn.primary'); // Go to sign-in
  await page.waitForSelector('input[name=username]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500); // long enough for a redirect loop to show itself in the count
  ok(apiCalls - before < 20, 'going to sign-in is a handful of requests, not a redirect loop between #/setup and #/login', apiCalls - before);
  eq(tooMany, 0, 'and nothing is refused as too many requests');
  ok(/#\/login/.test(page.url()), 'the sign-in form is shown', page.url());

  await page.fill('input[name=username]', 'sadmin', { timeout: 5000 }).catch(() => {}); await page.fill('input[name=password]', 'SetupPassw0rd!x', { timeout: 5000 }).catch(() => {});
  await page.click('button[type=submit]', { timeout: 5000 }).catch(() => {});
  ok(await page.waitForSelector('.layout', { timeout: 10000 }).then(() => true).catch(() => false), 'the new administrator signs in straight away');
  eq(tooMany, 0, 'without a single 429 along the way');
} finally {
  await browser.close();
  server.kill();
  if (server.exitCode === null && server.signalCode === null) await new Promise(r => server.once('exit', r));
  rmSync(dataDir, { recursive: true, force: true });
}
finish(errors);

// First-load cost of the web app on a phone over a mobile connection (docs/PERFORMANCE.md): a 390 px wide
// Chromium, the network throttled to "slow 4G" (150 ms round trip, 1.6 Mbit/s down, 750 kbit/s up) and the CPU
// slowed four times (a mid-range phone). Measures the sign-in page on a first visit (nothing cached) and on a
// return visit (whatever the server let the browser keep), then signing in to Home: Largest Contentful Paint,
// when the page can be used, requests, and bytes on the wire.
//
//   node scripts/bench/frontend.mjs [--root <checkout>] [--out results.json] [--port 9930]
//
// Starts its own server on a seeded database (scripts/bench/run.js --seed-only --small) and stops it after.
// Needs Playwright and Chromium, as the browser suite does (scripts/ui/run-all.sh). Not part of the tests.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(opt('--root', path.join(here, '..', '..')));
const PORT = Number(opt('--port', 9930));
const DATA = path.join(os.tmpdir(), `suds-bench-fe-${process.pid}`);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, SUDS_ENV: 'test', SUDS_DATA_DIR: DATA, SUDS_DB_PATH: path.join(DATA, 'suds.db'), SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x', SUDS_ADMIN_USERNAME: 'admin', MFA_REQUIRED_ROLES: '', LOCAL_MODE_ENABLED: 'true', PORT: String(PORT), HOST: '127.0.0.1' };

console.log(`# seeding a small programme for ${ROOT}`);
execFileSync(process.execPath, ['--no-warnings', path.join(here, 'run.js'), '--root', ROOT, '--seed-only', '--small', '--data', DATA], { env, stdio: ['ignore', 'ignore', 'inherit'] });
const server = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/index.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
for (let i = 0; ; i++) { try { if ((await fetch(base + '/api/health/live')).ok) break; } catch {} if (i > 600) throw new Error('server did not start'); await new Promise(r => setTimeout(r, 50)); }

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', serviceWorkers: 'block' });
await context.addInitScript(() => {
  window.__lcp = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = Math.max(window.__lcp, e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
let bytes = 0; let requests = 0;
const urls = new Map(); const seen = [];
cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; requests++; if (process.env.BENCH_URLS) seen.push(`${Math.round(e.encodedDataLength / 1024)} kB ${urls.get(e.requestId)}`); });
const reset = () => { bytes = 0; requests = 0; };
const results = { root: ROOT, at: new Date().toISOString(), network: 'slow 4G (150 ms RTT, 1.6 Mbit/s)', cpu: '4x slower', viewport: '390x844', rows: [] };
const out = (row) => { results.rows.push(row); console.log(JSON.stringify(row)); };

async function signInPage(label) {
  reset();
  const t0 = Date.now();
  // A full load every time (a query string makes it a new document, not a hash change within the old one).
  await page.goto(`${base}/?visit=${results.rows.length}#/login`, { waitUntil: 'load' });
  const loaded = Date.now() - t0;
  // Usable: the app has replaced the static first-paint shell with the real, enabled sign-in form.
  await page.waitForFunction(() => { const i = document.querySelector('input[name=username]'); return i && !i.disabled && !document.getElementById('app').hasAttribute('aria-busy'); }, null, { timeout: 60000 });
  const usable = Date.now() - t0;
  await page.waitForTimeout(300);
  const lcp = await page.evaluate(() => Math.round(window.__lcp));
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: Math.round(n.domContentLoadedEventEnd) }; });
  out({ label, lcp_ms: lcp, dom_content_loaded_ms: nav.dcl, load_ms: loaded, usable_ms: usable, requests, kb: Math.round(bytes / 1024) });
}
async function signIn(label) {
  reset();
  const t0 = Date.now();
  await page.fill('input[name=username]', 'admin'); await page.fill('input[name=password]', 'AdminPassw0rd!x');
  await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 60000 });
  await page.waitForFunction(() => { const m = document.querySelector('main#main'); return m && m.children.length && !m.querySelector('.boot'); }, null, { timeout: 120000 });
  out({ label, home_ready_ms: Date.now() - t0, requests, kb: Math.round(bytes / 1024) });
  if (process.env.BENCH_URLS) { console.log(seen.join('\n')); seen.length = 0; }
}
async function openPage(label, hash) {
  reset();
  const t0 = Date.now();
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction(() => { const m = document.querySelector('main#main'); return m && m.children.length && !m.querySelector('.boot'); }, null, { timeout: 120000 });
  out({ label, ready_ms: Date.now() - t0, requests, kb: Math.round(bytes / 1024) });
}

try {
  await cdp.send('Network.clearBrowserCache');
  await signInPage('sign-in page, first visit (nothing cached)');
  await signIn('sign in to Home, first visit');
  await openPage('open Clients, first time', '#/clients');
  await openPage('open Supplies, first time', '#/supplies');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'suds' } }));
  await signInPage('sign-in page, return visit');
  await signIn('sign in to Home, return visit');
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise(r => server.once('exit', r));
  fs.rmSync(DATA, { recursive: true, force: true });
}
const file = opt('--out', null);
if (file) fs.writeFileSync(file, JSON.stringify(results, null, 2));

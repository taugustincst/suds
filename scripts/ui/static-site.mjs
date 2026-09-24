// The standalone static build (scripts/build-static-site.js): no office server anywhere behind it, on a
// phone-width viewport, using nothing but a plain static file server — the same as GitHub Pages, S3, or
// a county web server would provide. This is the thing docs/WEB_APP.md tells someone to open on their
// phone, so it gets the same end-to-end proof the office app and the phone apps get.
import * as pw from 'playwright';
const { devices } = pw;
import { makeChecks, until, settle } from './assert.mjs';
// SUDS_BROWSER=webkit (or firefox) runs this script in that engine instead of Chromium; CI's WebKit smoke
// job uses it as the nearest thing to iPhone Safari a Linux runner has.
const browserType = pw[process.env.SUDS_BROWSER || 'chromium'];
if (!browserType || !browserType.launch) throw new Error(`SUDS_BROWSER=${process.env.SUDS_BROWSER} is not a Playwright browser (chromium, webkit, firefox)`);
const base = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8877';
const { ok, eq, finish } = makeChecks('static-site');
const browser = await browserType.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
// /app and views/no-such-view.js are requested on purpose below, to prove they are real 404s.
const probe = (u) => /\/app$|no-such-view/.test(u);
page.on('console', m => { if (m.type() === 'error' && !probe(m.location()?.url || '') && !/404/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 250)); });
page.on('response', r => { if (r.status() >= 400 && !probe(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(base + '/'); await settle(page);
ok(await page.evaluate(() => window.SUDS_FORCE_LOCAL === true), 'the built site forces local mode before app.js even loads');
ok(await page.evaluate(() => window.SUDS_STATIC_HOST === true), 'and marks itself as served from a static host, which is what makes sync ask the office server for permission');
eq(await page.$eval('.static-demo-banner', b => b.textContent), 'Demo/evaluation build — do not enter real client information', 'the demo/evaluation banner is on screen from the first paint');
ok(await page.$('input[name=display_name]'), 'so opening it with no query string at all still lands on first-run setup, not a login screen for a server that does not exist');

await page.fill('input[name=display_name]', 'Static Nav'); await page.fill('input[name=username]', 'staticnav');
await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
await page.click('button[type=submit]');
await page.waitForSelector('.layout', { timeout: 10000 }).catch(() => {});
ok(await page.$('.layout'), 'setup completes with no server round trip');
ok(await page.evaluate(() => !!window.SUDS_LOCAL), 'the in-browser kernel is what answered every request');
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'the page fits a phone screen width');

// data survives a reload — this is IndexedDB, not memory, and it is the whole point of running locally
await page.goto(base + '/#/clients'); await settle(page);
await page.click('button:has-text("New client")'); await page.waitForSelector('.modal');
await page.fill('.modal input[name=first_name]', 'Offline'); await page.fill('.modal input[name=last_name]', 'Test');
await page.click('.modal button[type=submit]'); await settle(page);
ok(/\/client\//.test(page.url()), 'a client can be created with no network connection at all');
await page.reload(); await settle(page);
ok(await page.$('.layout'), 'the session survives a reload without signing in again');
await page.goto(base + '/#/clients'); await settle(page);
eq(await page.$$eval('tbody tr', r => r.length), 1, 'and the client entered offline is still there');

// Sample data beside what someone typed in: the demo holds nothing real, so a client entered while trying
// SUDS out no longer locks the sample data away (an office-served copy still refuses; test/demo.test.js).
await page.goto(base + '/#/sync'); await settle(page);
ok(!(await page.$('[data-sample-refused]')), 'the demo does not refuse sample data because a client already exists');
ok(await page.$('[data-sample-alongside]'), 'it offers to add the sample clients beside the one entered here');
await page.click('[data-sample] button:has-text("Load sample data")');
await page.waitForSelector('[data-sample=loaded]', { timeout: 20000 }).catch(() => {});
ok(await page.$('[data-sample=loaded]'), 'and loads them');
await page.goto(base + '/#/clients?status=all'); await settle(page);
ok(await page.$$eval('tbody tr', r => r.length) > 1 && await page.$('tbody tr:has-text("Offline")'), 'the sample clients sit beside the client entered offline', await page.$$eval('tbody tr', r => r.length));
await page.goto(base + '/#/sync'); await settle(page);
await page.click('button:has-text("Remove sample data")'); await page.waitForSelector('.modal button.danger');
await page.click('.modal button.danger'); await page.waitForSelector('[data-sample=empty]', { timeout: 20000 }).catch(() => {});
await page.goto(base + '/#/clients?status=all'); await settle(page);
eq(await page.$$eval('tbody tr', r => r.length), 1, 'removing the sample data leaves only the client entered offline');

// installable as a home-screen app: the manifest has to actually resolve and be well-formed, not just linked
const manifest = await page.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]')?.href; if (!href) return null;
  const r = await fetch(href); if (!r.ok) return null;
  return r.json();
});
ok(manifest && manifest.display === 'standalone' && Array.isArray(manifest.icons) && manifest.icons.length > 0, 'the page is installable to a home screen (a valid, standalone manifest with icons)', manifest);

// "Use SUDS on your phone or tablet" is a plain file here. The office server serves it as /app, a rewrite
// no static host has, so nothing on this build may link to /app: the tester could not find the page at all.
eq(await page.evaluate(async () => (await fetch('app')).status), 404, 'a plain static host answers 404 for /app (this suite\'s server does not imitate the office rewrite)');
await page.goto(base + '/get-app.html'); await page.waitForSelector('#static-url, #url', { timeout: 10000 }).catch(() => {});
eq(await page.title(), 'Use SUDS on your phone or tablet', 'get-app.html is in the build and opens');
ok(await page.$('.static-demo-banner'), 'with the demo banner on it too');
ok(await page.$eval('[data-static]:not(.hidden)', el => /demo\/evaluation copy/.test(el.textContent)), 'it says this is the evaluation copy that runs in the browser');
ok(await page.$$eval('[data-office]', els => els.every(el => el.classList.contains('hidden'))), 'the office-address and "stay connected" wording is hidden');
ok(await page.$eval('#cert', el => el.classList.contains('hidden')), 'there is no certificate to download');
ok(await page.$eval('#signin-note', el => el.classList.contains('hidden')), 'and no "sign in first" note for a server that does not exist');
ok(await page.$eval('#static-local', el => !el.classList.contains('hidden') && /Offline copy/.test(el.textContent)), 'the offline-copy section is shown');
eq(await page.$eval('#static-local a', a => a.getAttribute('href')), './', 'and its link opens this site');
ok(await page.$eval('#static-url', el => /127\.0\.0\.1/.test(el.textContent) && !/get-app/.test(el.textContent)), 'the address shown is this site\'s, not a server\'s', await page.$eval('#static-url', el => el.textContent));
// every way into that page uses the file name: the login screen's tip, the offline banner, the admin card
await page.goto(base + '/'); await page.waitForSelector('.layout', { timeout: 10000 });
await page.evaluate(async () => (await import('./app.js')).logout());
await page.waitForSelector('input[name=username]', { timeout: 10000 });
eq(await page.$eval('.login-wrap a[href="get-app.html"]', a => a.textContent), 'Use SUDS on your phone or tablet', 'the login screen links the page by file name');
await page.fill('input[name=username]', 'staticnav'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]');
await page.waitForSelector('.layout', { timeout: 10000 });
ok(await page.$('.layout'), 'signed back in');
eq(await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => /(^|\/)app\/?$/.test(h)).length), 0, 'nothing on the page links to /app');

// The demo build never syncs (docs/WEB_APP.md): the Sync screen says so instead of offering a form that
// could only fail, and nothing is sent to any office address.
await page.goto(base + '/#/sync'); await page.waitForSelector('[data-static-no-sync], input[name=office_password]', { timeout: 10000 }).catch(() => {});
ok(await page.$('[data-static-no-sync]'), 'the Sync screen says sync is not available from the demo site');
eq(await page.$eval('[data-static-no-sync]', b => /Sync is not available from the demo site/.test(b.textContent)), true, 'in those words');
ok(!(await page.$('input[name=office_password]')), 'and offers no office sign-in form');
const syncAttempt = await page.evaluate(() => window.SUDS_LOCAL.handle('POST', '/api/local/sync', { server: 'https://suds.local', username: 'x', password: 'y' }, {}).then(r => r.json));
ok(syncAttempt && /not available from the demo site/.test(syncAttempt.error) && syncAttempt.staticSyncRefused, 'the kernel refuses a sync outright, before any credential leaves the browser', syncAttempt);

// Installed to a home screen, it has to open with no connection: the service worker caches the kernel.
const swActive = await until(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))), { timeout: 15000 });
ok(swActive, 'the demo build registers its service worker');
const cachedBoot = await until(() => page.evaluate(async () => { for (const k of await caches.keys()) { const c = await caches.open(k); if (await c.match('local-boot.js') && await c.match('local/kernel.js', { ignoreSearch: true })) return true; } return false; }), { timeout: 15000 });
ok(cachedBoot, 'the boot script and the kernel are in its shell cache');
ok(await page.evaluate(async () => { for (const k of await caches.keys()) { const c = await caches.open(k); if (await c.match('get-app.html') && await c.match('get-app.js')) return true; } return false; }), 'so is the phone/tablet page');
// a request for a file that does not exist gets a real 404 from the network — and offline a real failure,
// not index.html: only a navigation falls back to the app shell
eq(await page.evaluate(async () => (await fetch('views/no-such-view.js')).status), 404, 'a missing file is a 404 through the worker');
await ctx.setOffline(true);
await page.reload().catch(() => {});
await until(() => page.$('.layout, input[name=username], input[name=display_name]'), { timeout: 20000 });
ok(await page.$('.layout'), 'with no connection at all the installed demo still opens, signed in', (await page.textContent('body')).slice(0, 120));
ok(await page.evaluate(() => fetch('views/no-such-view.js').then(r => r.status !== 200 && !/<!doctype/i.test(r.headers.get('content-type') || ''), () => true)), 'offline, a missing script is a failure, not index.html served as a 200');
ok(await page.evaluate(() => fetch('get-app.html').then(r => r.ok && r.headers.get('content-type').includes('html'))), 'offline, the phone/tablet page still opens from the shell cache');
await ctx.setOffline(false);

finish(errors);
await browser.close();

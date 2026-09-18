// The standalone static build (scripts/build-static-site.js): no office server anywhere behind it, on a
// phone-width viewport, using nothing but a plain static file server — the same as GitHub Pages, S3, or
// a county web server would provide. This is the thing docs/WEB_APP.md tells someone to open on their
// phone, so it gets the same end-to-end proof the office app and the phone apps get.
import { chromium, devices } from 'playwright';
import { makeChecks, until } from './assert.mjs';
const base = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8877';
const { ok, eq, finish } = makeChecks('static-site');
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 250)); });
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(base + '/'); await page.waitForTimeout(2000);
ok(await page.evaluate(() => window.SUDS_FORCE_LOCAL === true), 'the built site forces local mode before app.js even loads');
ok(await page.$('input[name=display_name]'), 'so opening it with no query string at all still lands on first-run setup, not a login screen for a server that does not exist');

await page.fill('input[name=display_name]', 'Static Nav'); await page.fill('input[name=username]', 'staticnav');
await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
await page.click('button[type=submit]');
await page.waitForSelector('.layout', { timeout: 10000 }).catch(() => {});
ok(await page.$('.layout'), 'setup completes with no server round trip');
ok(await page.evaluate(() => !!window.SUDS_LOCAL), 'the in-browser kernel is what answered every request');
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'the page fits a phone screen width');

// data survives a reload — this is IndexedDB, not memory, and it is the whole point of running locally
await page.goto(base + '/#/clients'); await page.waitForTimeout(1000);
await page.click('button:has-text("New client")'); await page.waitForSelector('.modal');
await page.fill('.modal input[name=first_name]', 'Offline'); await page.fill('.modal input[name=last_name]', 'Test');
await page.click('.modal button[type=submit]'); await page.waitForTimeout(1000);
ok(/\/client\//.test(page.url()), 'a client can be created with no network connection at all');
await page.reload(); await page.waitForTimeout(2000);
ok(await page.$('.layout'), 'the session survives a reload without signing in again');
await page.goto(base + '/#/clients'); await page.waitForTimeout(1200);
eq(await page.$$eval('tbody tr', r => r.length), 1, 'and the client entered offline is still there');

// installable as a home-screen app: the manifest has to actually resolve and be well-formed, not just linked
const manifest = await page.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]')?.href; if (!href) return null;
  const r = await fetch(href); if (!r.ok) return null;
  return r.json();
});
ok(manifest && manifest.display === 'standalone' && Array.isArray(manifest.icons) && manifest.icons.length > 0, 'the page is installable to a home screen (a valid, standalone manifest with icons)', manifest);

finish(errors);
await browser.close();

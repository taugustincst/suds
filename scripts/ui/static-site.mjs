// The standalone static build (scripts/build-static-site.js): no office server anywhere behind it, on a
// phone-width viewport, using nothing but a plain static file server — the same as GitHub Pages, S3, or
// a county web server would provide. This is the thing docs/WEB_APP.md tells someone to open on their
// phone, so it gets the same end-to-end proof the office app and the phone apps get.
import * as pw from 'playwright';
const { devices } = pw;
import { makeChecks, until, settle } from './assert.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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
// A build published without provider pictures answers 404 for region-pictures/…/manifest.json, which is how
// the kernel learns there are none (checked below).
// The web-address check below asks for the office server's health check from this origin, which it refuses (no CORS).
const probe = (u) => /\/app$|no-such-view|region-pictures\/|\/api\/health$/.test(u);
page.on('console', m => { if (m.type() === 'error' && !probe(m.location()?.url || '') && !/404/.test(m.text()) && !/\/api\/health' from origin .* has been blocked by CORS/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 250)); });
page.on('response', r => { if (r.status() >= 400 && !probe(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(base + '/'); await settle(page);
ok(await page.evaluate(() => window.SUDS_FORCE_LOCAL === true), 'the built site forces local mode before app.js even loads');
ok(await page.evaluate(() => window.SUDS_STATIC_HOST === true), 'and marks itself as served from a static host (the internal marker that turns office sync off)');
// The production on-device app: no demo/evaluation banner, and no wording that says so, anywhere.
ok(!(await page.$('.static-demo-banner')), 'there is no demo banner on the page');
ok(!/demo|evaluation|do not enter real client/i.test(await page.textContent('body')), 'and nothing on the first screen calls this a demo or an evaluation copy', (await page.textContent('body')).slice(0, 200));
ok(await page.$('input[name=display_name]'), 'so opening it with no query string at all still lands on first-run setup, not a login screen for a server that does not exist');
eq(await page.getAttribute('[data-mode-tab=signup]', 'aria-selected'), 'true', 'first-run set-up is the Sign up option, selected because the device has no account');
ok(await page.$('[data-storage-notice]') && /nowhere else/.test(await page.textContent('[data-storage-notice]')), 'it says once where the records are kept');

await page.fill('input[name=display_name]', 'Static Nav'); await page.fill('input[name=username]', 'staticnav');
await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
await page.click('button[type=submit]'); await settle(page);
ok(!(await page.$('.layout')) && /where your records are kept/.test(await page.textContent('.login-wrap')), 'without ticking the storage confirmation the account is not created');
await page.check('input[name=storage_ack]');
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

// The on-device app holds real records now: fictional sample clients are only offered to an empty device
// (as on an office server), never mixed in beside a real one (ux-polish.mjs loads them on an empty device).
await page.goto(base + '/#/sync'); await settle(page);
eq(await page.textContent('h1'), 'This device', 'the device page is called "This device"');
ok(await page.$('[data-sample-refused]'), 'with a client on the device, sample data is refused');
ok(!(await page.$('[data-sample-alongside]')), 'and not offered beside the real client');
const refusedLoad = await page.evaluate(() => window.SUDS_LOCAL.handle('POST', '/api/local/demo', {}, {}).then(r => r.status));
eq(refusedLoad, 400, 'the kernel refuses it too');
await page.goto(base + '/#/clients?status=all'); await settle(page);
eq(await page.$$eval('tbody tr', r => r.length), 1, 'the device still holds only the client entered offline');

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
ok(!(await page.$('.static-demo-banner')) && !/demo|evaluation/i.test(await page.textContent('body')), 'with no demo banner or evaluation wording on it either');
ok(await page.$eval('[data-static]:not(.hidden)', el => /SUDS on this device runs entirely inside your browser/.test(el.textContent)), 'it says SUDS on this device runs in the browser');
ok(await page.$$eval('[data-office]', els => els.every(el => el.classList.contains('hidden'))), 'the office-address and "stay connected" wording is hidden');
ok(await page.$eval('#cert', el => el.classList.contains('hidden')), 'there is no certificate to download');
ok(await page.$eval('#signin-note', el => el.classList.contains('hidden')), 'and no "sign in first" note for a server that does not exist');
ok(await page.$eval('#static-local', el => !el.classList.contains('hidden') && /Your records stay on this device/.test(el.textContent) && /backup/.test(el.textContent)), 'the "your records stay on this device" section is shown, with the advice to back up');
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

// "Download provider pictures" on this build. A browser cannot read a provider's own website (no CORS
// headers there), so every download used to fail with "Failed to fetch". The build now carries the pictures
// (region-pictures/<region>/, scripts/fetch-region-pictures.js). run-all.sh serves the site from
// SUDS_STATIC_DIR: two fixture pictures go there — a large one that needs a thumbnail made in the browser, a
// small one that is its own — and the directory's cards must then show them instead of the generated cards.
// Without SUDS_STATIC_DIR (the Pages workflow checking its real build) whatever the build bundled is used.
{
  const require = createRequire(import.meta.url);
  const providers = require('../../server/regions')['sacramento-metro'].providers.filter(p => p.website || p.image_url);
  const [big, small] = providers;
  let fixture = false;
  if (process.env.SUDS_STATIC_DIR) {
    const png = require('../../server/png');
    const dir = path.join(process.env.SUDS_STATIC_DIR, 'region-pictures', 'sacramento-metro'); fs.mkdirSync(dir, { recursive: true });
    const solid = (w, hgt, [r, g, b], noise) => { const px = Buffer.alloc(w * hgt * 3); for (let i = 0; i < px.length; i += 3) { const n = noise ? Math.floor(Math.random() * noise) : 0; px[i] = r - n; px[i + 1] = g + n; px[i + 2] = b - n; } return png.encode(w, hgt, px); };
    const bigPng = solid(900, 506, [250, 0, 250], 12); const smallPng = solid(64, 36, [0, 170, 0], 0);
    ok(bigPng.length > 96 * 1024 && bigPng.length < 2 * 1024 * 1024 && smallPng.length < 96 * 1024, 'fixture pictures: one too big to be its own thumbnail, one small enough', [bigPng.length, smallPng.length]);
    fs.writeFileSync(path.join(dir, 'big.png'), bigPng); fs.writeFileSync(path.join(dir, 'small.png'), smallPng);
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ region: 'sacramento-metro', fetched_at: at, pictures: {
      [big.key]: { file: 'big.png', content_type: 'image/png', bytes: bigPng.length, source_url: 'https://pictures.example.org/big.png', fetched_at: at },
      [small.key]: { file: 'small.png', content_type: 'image/png', bytes: smallPng.length, source_url: 'https://pictures.example.org/small.png', fetched_at: at },
    }, failures: {} }));
    fixture = true;
  }
  const bundled = fixture || await page.evaluate(() => fetch('region-pictures/sacramento-metro/manifest.json').then(r => r.ok, () => false));
  await page.goto(base + '/#/resources'); await settle(page);
  await page.click('[data-region=sacramento-metro] button:has-text("Add")');
  await page.waitForSelector('[data-region=sacramento-metro] button:has-text("Download provider pictures")', { timeout: 90000 });
  await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  await page.click('[data-region=sacramento-metro] button:has-text("Download provider pictures")');
  const outcome = await until(() => page.$eval('[data-picture-status] .banner', b => b.textContent).catch(() => null), { timeout: 120000 });
  await settle(page, { timeout: 30000 });
  const toastSeen = await page.evaluate(() => document.querySelector('#toasts')?.textContent || '');
  if (bundled) {
    ok(/provider pictures downloaded/.test(outcome || ''), 'the download reports how many provider pictures it got', outcome);
    ok(/provider pictures downloaded/.test(toastSeen), 'and says so in a toast too, where a phone user is looking', toastSeen);
    // The outcome stays on screen after the refresh that shows the new pictures (it used to be wiped by it).
    ok(await page.$('[data-picture-status] .banner'), 'the outcome is still on screen after the directory refreshes');
  } else {
    ok(/not available on this device build/.test(outcome || ''), 'a build published without pictures says so plainly, once', outcome);
    ok(/not available on this device build/.test(toastSeen), 'in a toast as well', toastSeen);
  }
  if (fixture) {
    ok(/2 of \d+ provider pictures downloaded/.test(outcome), 'exactly the two bundled pictures were downloaded', outcome);
    ok(/not available on this device build/.test(outcome), 'and the rest say they are not in this build', outcome);
    // The directory card of each program shows its picture, not the generated initials card.
    const cardColour = (name) => page.evaluate(async (n) => {
      const card = [...document.querySelectorAll('.res-card')].find(c => c.querySelector('b')?.textContent === n);
      const im = card && card.querySelector('img.res-cover'); if (!im) return null; im.scrollIntoView(); // the covers load lazily
      for (let i = 0; i < 50 && !(im.complete && im.naturalWidth > 1); i++) await new Promise(r => setTimeout(r, 100));
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; return [d[0], d[1], d[2], im.naturalWidth];
    }, name);
    const bigColour = await until(async () => { const v = await cardColour(big.name); return v && v[0] > 200 && v[1] < 70 && v[2] > 200 ? v : null; }, { timeout: 15000 });
    ok(bigColour, `the card for ${big.name} now shows its provider picture`, bigColour || await cardColour(big.name));
    const smallColour = await until(async () => { const v = await cardColour(small.name); return v && v[0] < 60 && v[1] > 130 && v[2] < 60 ? v : null; }, { timeout: 15000 });
    ok(smallColour, `and so does the card for ${small.name}`, smallColour || await cardColour(small.name));
    const photos = await page.evaluate(async (n) => {
      const list = await window.SUDS_LOCAL.handle('GET', '/api/resources?limit=1000', undefined, {}).then(r => r.json.rows);
      const row = list.find(x => x.name === n);
      const one = await window.SUDS_LOCAL.handle('GET', `/api/resources/${row.id}`, undefined, {}).then(r => r.json.row);
      const main = one.photos[0];
      const thumb = await window.SUDS_LOCAL.handle('GET', main.thumb_url, undefined, {});
      return { caption: main.caption, bytes: main.bytes, hasThumb: main.has_thumb, thumbType: thumb.headers['content-type'], thumbBytes: thumb.body && thumb.body.length, cover: row.cover_url, count: one.photos.length };
    }, big.name);
    ok(/From pictures\.example\.org/.test(photos.caption) && photos.count === 2, 'the downloaded picture is the main one, ahead of the generated card', photos);
    ok(photos.hasThumb && photos.thumbType === 'image/jpeg' && photos.thumbBytes < 96 * 1024 && photos.thumbBytes < photos.bytes, 'and it has a real thumbnail, made on the device from the picture', photos);
    ok(/\/thumb$/.test(photos.cover), 'which is what the card shows', photos.cover);
    // Pressing it again finds nothing left to fetch and says so, rather than doing nothing.
    await page.click('[data-region=sacramento-metro] button:has-text("Download provider pictures")');
    const again = await until(() => page.$eval('[data-picture-status] .banner', b => b.textContent).then(t => (/not available on this device build/i.test(t) && !/2 of/.test(t) ? t : null)).catch(() => null), { timeout: 60000 });
    ok(again, 'pressing it again reports the programs this build has no picture for', again);
  }
  await page.screenshot({ path: '/tmp/suds-shots/static-site-provider-pictures.png' }).catch(() => {});
}

// "Add from a web address" on this build: the page fetches the picture itself (the kernel is this page and
// no provider site sends CORS headers), then saves it like any upload. A picture on this site's own origin
// can always be read; an address on another origin with no CORS headers gets the explanation instead.
// Only getByRole clicks: the way a person, or an automated tester that cannot use a file window, adds one.
if (process.env.SUDS_STATIC_DIR) {
  const require = createRequire(import.meta.url);
  const png = require('../../server/png');
  const px = Buffer.alloc(400 * 300 * 3); for (let i = 0; i < px.length; i += 3) { px[i] = 20; px[i + 1] = 40; px[i + 2] = 240; }
  fs.writeFileSync(path.join(process.env.SUDS_STATIC_DIR, 'web-picture.png'), png.encode(400, 300, px));
  const rid = await page.evaluate(() => window.SUDS_LOCAL.handle('POST', '/api/resources', { name: 'Web Picture House', category: 'residential' }, {}).then(r => r.json.id));
  await page.goto(`${base}/#/resource/${rid}`); await settle(page);
  const count = () => page.evaluate((id) => window.SUDS_LOCAL.handle('GET', `/api/resources/${id}/photos`, undefined, {}).then(r => r.json.photos), rid);
  eq((await count()).length, 0, 'web address: the new program starts with no pictures');
  await page.getByRole('button', { name: 'Add from a web address' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a picture from a web address' });
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Address of the picture').fill(`${base}/web-picture.png`);
  await dialog.getByLabel('Caption (optional)').fill('Blue door');
  await dialog.getByRole('button', { name: 'Add picture', exact: true }).click();
  const added = await until(async () => { const p = await count(); return p.length === 1 ? p : null; }, { timeout: 15000 });
  ok(added && added[0].caption === 'Blue door' && added[0].content_type === 'image/png', 'web address: the picture at an address on this site is saved, with its caption', added);
  ok(await until(() => dialog.count().then(n => n === 0)), 'web address: and the dialog closes');
  const heroBlue = await until(() => page.evaluate(() => { const im = document.querySelector('.gallery .hero img'); if (!im || !im.complete || im.naturalWidth < 2) return null; const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(5, 5, 1, 1).data; return d[2] > 200 && d[0] < 60 ? [d[0], d[1], d[2]] : null; }), { timeout: 10000 });
  ok(heroBlue, 'web address: the gallery shows it', heroBlue);
  await page.goto(base + '/#/resources'); await settle(page);
  const cover = await until(() => page.evaluate(async () => {
    const card = [...document.querySelectorAll('.res-card')].find(c => c.querySelector('b')?.textContent === 'Web Picture House');
    const im = card && card.querySelector('img.res-cover'); if (!im) return null; im.scrollIntoView();
    if (!(im.complete && im.naturalWidth > 1)) return null;
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; return d[2] > 200 && d[0] < 60 ? [d[0], d[1], d[2]] : null;
  }), { timeout: 15000 });
  ok(cover, 'web address: and it is the directory card\'s cover picture', cover);
  // Another origin with no CORS headers (the office server's health check): the browser will not hand the
  // page its bytes, and the dialog says what to do instead of failing silently.
  await page.goto(`${base}/#/resource/${rid}`); await settle(page);
  await page.getByRole('button', { name: 'Add from a web address' }).click();
  await dialog.waitFor({ timeout: 5000 });
  const other = `${process.env.SUDS_URL || 'http://127.0.0.1:8090'}/api/health`;
  await dialog.getByLabel('Address of the picture').fill(other);
  await dialog.getByRole('button', { name: 'Add picture', exact: true }).click();
  const why = await until(() => dialog.locator('.banner.danger').textContent().then(t => /does not allow its pictures to be copied/.test(t) ? t : null).catch(() => null), { timeout: 15000 });
  ok(why && /\+ Add pictures/.test(why) && /drag it onto this card/.test(why), 'web address: a site that does not allow copying gets the explanation and the other ways in', why);
  ok(/does not allow its pictures/.test(await page.textContent('#toasts')), 'web address: in a toast as well');
  eq((await count()).length, 1, 'web address: and nothing is added');
  // https only, apart from this site and this computer
  await dialog.getByLabel('Address of the picture').fill('http://pictures.example.org/a.png');
  await dialog.getByRole('button', { name: 'Add picture', exact: true }).click();
  ok(await until(() => dialog.locator('.banner.danger').textContent().then(t => /Only https/.test(t)).catch(() => false)), 'web address: a plain-http address elsewhere is refused before anything is fetched');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
}

// The on-device app never syncs (docs/WEB_APP.md): its device page says so instead of offering a form that
// could only fail, and nothing is sent to any office address.
await page.goto(base + '/#/sync'); await page.waitForSelector('[data-static-no-sync], input[name=office_password]', { timeout: 10000 }).catch(() => {});
ok(await page.$('[data-static-no-sync]'), 'the device page says it does not sync with an office server');
eq(await page.$eval('[data-static-no-sync]', b => /does not sync with an office server/.test(b.textContent)), true, 'in those words');
ok(!(await page.$('input[name=office_password]')), 'and offers no office sign-in form');
const syncAttempt = await page.evaluate(() => window.SUDS_LOCAL.handle('POST', '/api/local/sync', { server: 'https://suds.local', username: 'x', password: 'y' }, {}).then(r => r.json));
ok(syncAttempt && /does not sync with an office server/.test(syncAttempt.error) && syncAttempt.staticSyncRefused, 'the kernel refuses a sync outright, before any credential leaves the browser', syncAttempt);

// Installed to a home screen, it has to open with no connection: the service worker caches the kernel.
const swActive = await until(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))), { timeout: 15000 });
ok(swActive, 'the on-device build registers its service worker');
const cachedBoot = await until(() => page.evaluate(async () => { for (const k of await caches.keys()) { const c = await caches.open(k); if (await c.match('local-boot.js') && await c.match('local/kernel.js', { ignoreSearch: true })) return true; } return false; }), { timeout: 15000 });
ok(cachedBoot, 'the boot script and the kernel are in its shell cache');
ok(await page.evaluate(async () => { for (const k of await caches.keys()) { const c = await caches.open(k); if (await c.match('get-app.html') && await c.match('get-app.js')) return true; } return false; }), 'so is the phone/tablet page');
// a request for a file that does not exist gets a real 404 from the network — and offline a real failure,
// not index.html: only a navigation falls back to the app shell
eq(await page.evaluate(async () => (await fetch('views/no-such-view.js')).status), 404, 'a missing file is a 404 through the worker');
await ctx.setOffline(true);
await page.reload().catch(() => {});
await until(() => page.$('.layout, input[name=username], input[name=display_name]'), { timeout: 20000 });
ok(await page.$('.layout'), 'with no connection at all the installed app still opens, signed in', (await page.textContent('body')).slice(0, 120));
ok(await page.evaluate(() => fetch('views/no-such-view.js').then(r => r.status !== 200 && !/<!doctype/i.test(r.headers.get('content-type') || ''), () => true)), 'offline, a missing script is a failure, not index.html served as a 200');
const offlineGetApp = await page.evaluate(async () => {
  // Diagnostics for engines where this has failed (WebKit): what the worker holds, and what fetch() saw.
  const keys = []; for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) if (/get-app|index\.html/.test(r.url)) keys.push(`${k}:${new URL(r.url).pathname}`); }
  const controlled = !!navigator.serviceWorker.controller;
  try { const r = await fetch('get-app.html'); return { ok: r.ok && (r.headers.get('content-type') || '').includes('html'), status: r.status, type: r.headers.get('content-type'), controlled, keys }; }
  catch (e) { return { ok: false, error: String(e), controlled, keys }; }
});
ok(offlineGetApp.ok, 'offline, the phone/tablet page still opens from the shell cache', offlineGetApp);
await ctx.setOffline(false);

finish(errors);
await browser.close();

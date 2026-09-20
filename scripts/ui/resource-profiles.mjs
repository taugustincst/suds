// Treatment center profiles: directory cards with cover pictures, profile page, picture upload/caption/remove, works in office and phone-only mode.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { makeChecks } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { ok, eq, finish } = makeChecks('resource-profiles');
const browser = await chromium.launch();
const errors = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxAADYAYAF6cCAt3iLYAAAAAASUVORK5CYII=', 'base64'); // 2x2 PNG
fs.mkdirSync('/tmp/suds-shots', { recursive: true }); fs.writeFileSync('/tmp/suds-shots/tiny.png', png);
async function run(label, url, login) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label} PAGEERROR ${e.message}`)); let loggedIn = false; page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push(`${label} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(url); await page.waitForTimeout(2500);
  await login(page); loggedIn = true;
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await page.waitForTimeout(150); }
  await page.goto(url.split('#')[0] + '#/resources'); await page.waitForTimeout(1200);
  const cards = await page.$$('.res-card'); const covers = await page.$$('.res-card img.res-cover');
  ok(cards.length > 0, `${label}: the directory shows resource cards`, cards.length);
  ok(covers.length > 0, `${label}: cards carry cover pictures`, covers.length);
  await page.click('.res-card:has(img.res-cover)'); await page.waitForTimeout(1200); await page.screenshot({ path: `/tmp/suds-shots/resource-profile-${label}.png`, fullPage: true });
  ok(/^\/resource\//.test(page.url().split('#')[1] || ''), `${label}: a card opens its profile`, page.url().split('#')[1]);
  ok((await page.textContent('h1')).trim().length > 0, `${label}: the profile is titled with the programme name`);
  ok(((await page.textContent('.res-lead').catch(() => '')) || '').trim().length > 20, `${label}: the profile leads with a summary of services`);
  // Count photos, not <img> elements: the gallery shows one hero plus a thumbnail strip that only appears
  // once there is more than one picture, so the element count jumps by two when going from one to two.
  const rid = page.url().split('/resource/')[1];
  const photoCount = () => page.evaluate((id) => {
    const path = `/api/resources/${id}/photos`;
    // In local mode there is no server behind that path; the page's own kernel answers it.
    const get = window.SUDS_LOCAL ? window.SUDS_LOCAL.handle('GET', path, undefined, {}).then(r => r.json) : fetch(path).then(r => r.json());
    return get.then(d => ((d && d.photos) || []).length);
  }, rid);
  const before = await photoCount();
  // upload a picture
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("+ Add pictures")')]);
  await chooser.setFiles('/tmp/suds-shots/tiny.png'); await page.waitForTimeout(2000);
  eq(await photoCount(), before + 1, `${label}: uploading a picture adds one to the profile`);
  ok(await page.$('.gallery img'), `${label}: the gallery shows the picture just uploaded`);
  // An <img> tag existing is not the same as it having actually loaded anything — in local mode a
  // freshly-uploaded picture used to carry a data: URL straight through to the gallery, and the shared
  // img() helper (built for server paths, resolved through the local kernel) silently failed on it and
  // left the element on a 1x1 transparent placeholder forever. Check it actually decoded real pixels.
  const heroLoaded = await page.waitForFunction(() => {
    const el = document.querySelector('.gallery .hero img');
    return el && el.complete && el.naturalWidth > 1 ? true : null;
  }, { timeout: 5000 }).then(() => true).catch(() => false);
  ok(heroLoaded, `${label}: the just-uploaded picture actually renders, not a blank placeholder`);
  // open lightbox on the last thumbnail (or hero), caption, remove
  const thumbs = await page.$$('.thumb-btn'); if (thumbs.length) await thumbs[thumbs.length - 1].click(); else await page.click('.gallery .hero img');
  await page.waitForSelector('.lightbox'); page.once('dialog', d => d.accept('Front door')); await page.click('.lightbox button:has-text("Caption")'); await page.waitForTimeout(500);
  eq((await page.textContent('.lightbox .muted')).trim(), 'Front door', `${label}: a caption typed in the lightbox is shown`);
  await page.click('.lightbox button:has-text("Remove")'); await page.waitForTimeout(300); await page.click('.modal-bg:last-child button.danger'); await page.waitForTimeout(800);
  eq(await photoCount(), before, `${label}: removing the picture puts the count back`);
  // edit form shows tag grid
  await page.click('button:has-text("Edit")'); await page.waitForSelector('.modal .tag-grid');
  ok(await page.$$eval('.modal .tag-grid input:checked', e => e.length) > 0, `${label}: the edit form shows the services this programme offers, ticked`);
  await page.keyboard.press('Escape');
  // list view + tag filter
  await page.goto(url.split('#')[0] + '#/resources?view=list&tag=mat_buprenorphine'); await page.waitForTimeout(1000);
  ok(await page.$$eval('tbody tr', r => r.length) > 0, `${label}: filtering the list by a service finds programmes offering it`);
  await page.screenshot({ path: `/tmp/suds-shots/resource-${label}.png` });
  await ctx.close();
}
await run('office', base + '/#/login', async (p) => { await p.fill('input[name=username]', 'mrivera'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 8000 }); await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await p.waitForTimeout(700); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); });
await run('local', base + '/?local=1#/', async (p) => {
  if (await p.$('input[name=display_name]')) { await p.fill('input[name=display_name]', 'Pic Nav'); await p.fill('input[name=username]', 'picnav'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.fill('input[name=confirm]', 'Navigator2026!!'); await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 10000 }); await p.waitForTimeout(800); }
  // phone-only copy: load sample data so there are resources with pictures
  await p.goto(base + '/?local=1#/sync'); await p.waitForTimeout(1200); if (await p.$('button:has-text("Load sample data")')) { await p.click('button:has-text("Load sample data")'); await p.waitForSelector('[data-sample=loaded]', { timeout: 30000 }); }
});
finish(errors);
await browser.close();

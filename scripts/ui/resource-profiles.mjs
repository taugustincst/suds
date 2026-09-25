// Treatment center profiles: directory cards with cover pictures, profile page, picture upload/caption/remove, works in office and phone-only mode.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { makeChecks, settle, until } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { ok, eq, finish } = makeChecks('resource-profiles');
const browser = await chromium.launch();
const errors = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxAADYAYAF6cCAt3iLYAAAAAASUVORK5CYII=', 'base64'); // 2x2 PNG
fs.mkdirSync('/tmp/suds-shots', { recursive: true }); fs.writeFileSync('/tmp/suds-shots/tiny.png', png);
// The web-address checks below are refused on purpose: the office answers 400, a device's fetch of an
// unreachable address fails. The browser logs both; they are what is being tested, not errors.
const expectedFailure = (m) => /127\.0\.0\.1:9\/|\/photos\/from-url/.test(`${m.location()?.url || ''} ${m.text()}`);
async function run(label, url, login) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label} PAGEERROR ${e.message}`)); let loggedIn = false; page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text())) && !expectedFailure(m)) errors.push(`${label} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(url); await settle(page);
  await login(page); loggedIn = true;
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); }
  await page.goto(url.split('#')[0] + '#/resources'); await settle(page);
  const cards = await page.$$('.res-card'); const covers = await page.$$('.res-card img.res-cover');
  ok(cards.length > 0, `${label}: the directory shows resource cards`, cards.length);
  ok(covers.length > 0, `${label}: cards carry cover pictures`, covers.length);
  await page.click('.res-card:has(img.res-cover)'); await settle(page); await page.screenshot({ path: `/tmp/suds-shots/resource-profile-${label}.png`, fullPage: true });
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
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('label.file-btn:has-text("+ Add pictures")')]);
  await chooser.setFiles('/tmp/suds-shots/tiny.png'); await until(async () => (await photoCount()) === before + 1, { timeout: 15000 }); await settle(page);
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
  await page.waitForSelector('.lightbox'); page.once('dialog', d => d.accept('Front door')); await page.click('.lightbox button:has-text("Caption")'); await settle(page);
  eq((await page.textContent('.lightbox .muted')).trim(), 'Front door', `${label}: a caption typed in the lightbox is shown`);
  await page.click('.lightbox button:has-text("Remove")'); await page.waitForSelector('.modal-bg:last-child button.danger'); await page.click('.modal-bg:last-child button.danger'); await settle(page);
  eq(await photoCount(), before, `${label}: removing the picture puts the count back`);
  // Ways in that need no operating-system file window (a testing tool cannot drive one): drop a picture on
  // the card, paste one, or give a web address.
  const n0 = await photoCount();
  const dropped = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const card = document.querySelector('[data-pictures-card]');
    card.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const highlighted = card.classList.contains('drop-over');
    card.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { highlighted, after: card.classList.contains('drop-over') };
  }, png.toString('base64'));
  ok(dropped.highlighted && !dropped.after, `${label}: dragging a picture over the Pictures card highlights it, and dropping clears the highlight`, dropped);
  eq(await until(async () => (await photoCount()) === n0 + 1, { timeout: 15000 }) && await photoCount(), n0 + 1, `${label}: a picture dropped on the Pictures card is added`);
  ok(/1 picture added/.test(await until(() => page.textContent('[data-pictures-card]').then(t => /picture added/.test(t) && t))), `${label}: and the card says so`);
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, png.toString('base64'));
  eq(await until(async () => (await photoCount()) === n0 + 2, { timeout: 15000 }) && await photoCount(), n0 + 2, `${label}: a picture pasted on the profile page is added`);
  await settle(page);
  // "Add from a web address": a real button, a dialog, and a clear refusal for an address it cannot use.
  const addressBtn = page.getByRole('button', { name: 'Add from a web address' });
  eq(await addressBtn.count(), 1, `${label}: the Pictures card offers "Add from a web address"`);
  eq(await page.getByRole('button', { name: /Add pictures/ }).count(), 1, `${label}: and "+ Add pictures" is still the one file button`);
  await addressBtn.click();
  const dialog = page.getByRole('dialog', { name: 'Add a picture from a web address' });
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Address of the picture').fill('ftp://example.org/a.png');
  await dialog.getByRole('button', { name: 'Add picture', exact: true }).click();
  const refused = await until(() => dialog.locator('.banner.danger').textContent().then(t => t.trim() || null).catch(() => null));
  ok(/Only https/.test(refused || ''), `${label}: an address that is not https is refused with a reason`, refused);
  // An https address that cannot be used: the office server refuses the local network; a device cannot
  // reach it from the browser and says what to do instead.
  await dialog.getByLabel('Address of the picture').fill('https://127.0.0.1:9/x.png');
  await dialog.getByRole('button', { name: 'Add picture', exact: true }).click();
  const expectMsg = label === 'office' ? /not on the public internet/ : /does not allow its pictures to be copied from a browser.*drag it onto this card/;
  const why = await until(() => dialog.locator('.banner.danger').textContent().then(t => expectMsg.test(t) ? t : null).catch(() => null), { timeout: 15000 });
  ok(why, `${label}: an address it cannot fetch explains itself`, why || await dialog.locator('.banner.danger').textContent().catch(() => ''));
  eq(await photoCount(), n0 + 2, `${label}: and adds nothing`);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await settle(page);
  // edit form shows tag grid
  await page.click('button:has-text("Edit")'); await page.waitForSelector('.modal .tag-grid');
  ok(await page.$$eval('.modal .tag-grid input:checked', e => e.length) > 0, `${label}: the edit form shows the services this programme offers, ticked`);
  await page.keyboard.press('Escape');
  // list view + tag filter
  await page.goto(url.split('#')[0] + '#/resources?view=list&tag=mat_buprenorphine'); await settle(page);
  ok(await page.$$eval('tbody tr', r => r.length) > 0, `${label}: filtering the list by a service finds programmes offering it`);
  await page.screenshot({ path: `/tmp/suds-shots/resource-${label}.png` });
  await ctx.close();
}
await run('office', base + '/#/login', async (p) => { await p.fill('input[name=username]', 'mrivera'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 8000 }); await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await settle(p); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); });
await run('local', base + '/?local=1#/', async (p) => {
  if (await p.$('input[name=display_name]')) { await p.fill('input[name=display_name]', 'Pic Nav'); await p.fill('input[name=username]', 'picnav'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.fill('input[name=confirm]', 'Navigator2026!!'); await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 10000 }); await settle(p); }
  // phone-only copy: load sample data so there are resources with pictures
  await p.goto(base + '/?local=1#/sync'); await settle(p); if (await p.$('button:has-text("Load sample data")')) { await p.click('button:has-text("Load sample data")'); await p.waitForSelector('[data-sample=loaded]', { timeout: 30000 }); }
});
finish(errors);
await browser.close();

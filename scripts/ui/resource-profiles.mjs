// Treatment center profiles: directory cards with cover pictures, profile page, picture upload/caption/remove, works in office and phone-only mode.
import { chromium } from 'playwright';
import fs from 'node:fs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
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
  console.log(label, 'cards:', cards.length, 'with cover pictures:', covers.length); if (!cards.length) errors.push(label + ': no resource cards');
  if (covers.length === 0 && cards.length) errors.push(label + ': no cover pictures on cards (sample pictures missing)');
  await page.click('.res-card:has(img.res-cover)'); await page.waitForTimeout(1200); await page.screenshot({ path: `/tmp/suds-shots/resource-profile-${label}.png`, fullPage: true });
  console.log(label, 'profile:', page.url().split('#')[1], '|', (await page.textContent('h1')).trim(), '| lead:', ((await page.textContent('.res-lead').catch(() => '')) || '').slice(0, 50));
  if (!await page.$('.res-lead')) errors.push(label + ': no summary on profile');
  // Count photos, not <img> elements: the gallery shows one hero plus a thumbnail strip that only appears
  // once there is more than one picture, so the element count jumps by two when going from one to two.
  const rid = page.url().split('/resource/')[1];
  const photoCount = () => page.evaluate((id) => fetch(`/api/resources/${id}`).then(r => r.json()).then(d => d.row.photos.length), rid);
  const before = await photoCount(); console.log(label, 'pictures:', before);
  // upload a picture
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("+ Add pictures")')]);
  await chooser.setFiles('/tmp/suds-shots/tiny.png'); await page.waitForTimeout(2000);
  const after = await photoCount(); console.log(label, 'pictures after upload:', after);
  if (after !== before + 1) errors.push(`${label}: upload did not add a picture (${before} -> ${after})`);
  if (!(await page.$('.gallery img'))) errors.push(`${label}: the gallery shows no picture after uploading one`);
  // open lightbox on the last thumbnail (or hero), caption, remove
  const thumbs = await page.$$('.thumb-btn'); if (thumbs.length) await thumbs[thumbs.length - 1].click(); else await page.click('.gallery .hero img');
  await page.waitForSelector('.lightbox'); page.once('dialog', d => d.accept('Front door')); await page.click('.lightbox button:has-text("Caption")'); await page.waitForTimeout(500);
  console.log(label, 'caption shown:', (await page.textContent('.lightbox .muted')).trim());
  await page.click('.lightbox button:has-text("Remove")'); await page.waitForTimeout(300); await page.click('.modal-bg:last-child button.danger'); await page.waitForTimeout(800);
  const final = await photoCount(); console.log(label, 'pictures after remove:', final); if (final !== before) errors.push(`${label}: remove failed (${final} vs ${before})`);
  // edit form shows tag grid
  await page.click('button:has-text("Edit")'); await page.waitForSelector('.modal .tag-grid'); const ticked = await page.$$eval('.modal .tag-grid input:checked', e => e.length); console.log(label, 'ticked service tags in form:', ticked); await page.keyboard.press('Escape');
  // list view + tag filter
  await page.goto(url.split('#')[0] + '#/resources?view=list&tag=mat_buprenorphine'); await page.waitForTimeout(1000); console.log(label, 'list rows for MAT buprenorphine:', await page.$$eval('tbody tr', r => r.length));
  await page.screenshot({ path: `/tmp/suds-shots/resource-${label}.png` });
  await ctx.close();
}
await run('office', base + '/#/login', async (p) => { await p.fill('input[name=username]', 'mrivera'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 8000 }); await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await p.waitForTimeout(700); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); });
await run('local', base + '/?local=1#/', async (p) => {
  if (await p.$('input[name=display_name]')) { await p.fill('input[name=display_name]', 'Pic Nav'); await p.fill('input[name=username]', 'picnav'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.fill('input[name=confirm]', 'Navigator2026!!'); await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 10000 }); await p.waitForTimeout(800); }
  // phone-only copy: load sample data so there are resources with pictures
  await p.goto(base + '/?local=1#/sync'); await p.waitForTimeout(1200); if (await p.$('button:has-text("Load sample data")')) { await p.click('button:has-text("Load sample data")'); await p.waitForSelector('[data-sample=loaded]', { timeout: 30000 }); }
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO ERRORS'); if (errors.length) process.exitCode = 1;
await browser.close();

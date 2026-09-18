// Form library + clickable cards: library cards, designer, fill from a client record with autofill, complete, PDF, attach a signed copy; office and phone-only mode.
import { chromium } from 'playwright';
import { makeChecks, until } from './assert.mjs';
import fs from 'node:fs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch(); const errors = [];
const { ok, eq, finish } = makeChecks('forms');
fs.mkdirSync('/tmp/suds-shots', { recursive: true });
const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxAADYAYAF6cCAt3iLYAAAAAASUVORK5CYII=', 'base64'); fs.writeFileSync('/tmp/suds-shots/sig.png', tiny);
async function settle(p) { for (let i = 0; i < 8; i++) { await p.waitForTimeout(500); if (await p.$('.modal-bg')) break; } await dismiss(p); }
async function dismiss(p) { for (let i = 0; i < 3; i++) { const skip = await p.$('.modal-bg:last-child .modal button:has-text("Skip")'); if (!skip) break; await skip.click({ force: true }); await p.waitForTimeout(150); } await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); }
async function run(label, root, login) {
  const ctx = await browser.newContext({ viewport: { width: 1250, height: 900 } }); const page = await ctx.newPage(); let loggedIn = false;
  page.on('pageerror', e => errors.push(`${label} PAGEERROR ${e.message}`)); page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push(`${label} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(root + '#/'); await page.waitForTimeout(2500); await login(page); loggedIn = true; await settle(page); await page.goto(root + '#/'); await page.waitForTimeout(1000); await settle(page);
  // --- clickable cards ---
  await page.goto(root + '#/'); await page.waitForTimeout(1200);
  ok(await page.$$eval('a.card.stat', a => a.length) >= 5, `${label}: the numbers on Home are links to what they count`);
  await page.click('a.card.stat:has-text("Active clients")'); await page.waitForTimeout(900);
  ok(page.url().includes('#/clients'), `${label}: "Active clients" opens the client list`, page.url().split('#')[1]);
  await page.goto(root + '#/'); await page.waitForTimeout(1000); await dismiss(page); const bar = await page.$('a.bar.link');
  if (ok(!!bar, `${label}: the bars on Home are clickable`)) { await bar.click(); await page.waitForTimeout(800); ok(page.url().includes('interventions?type='), `${label}: a bar opens the visits it counts`, page.url().split('#')[1]); }
  await page.goto(root + '#/clients?status=active&risk=high'); await page.waitForTimeout(900);
  ok(await page.$('.badge:has-text("risk")'), `${label}: a filtered list says what it is filtered by`);
  // --- library ---
  await page.goto(root + '#/forms'); await page.waitForTimeout(1200);
  ok((await page.$$('.tpl-card')).length >= 3, `${label}: the library holds the starter forms`);
  await page.click('.tpl-open-name'); await page.waitForSelector('.modal');
  ok((await page.textContent('.modal h2')).trim().length > 0, `${label}: a form card opens the form`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  // --- fill from the client record ---
  await page.goto(root + '#/clients'); await page.waitForTimeout(900); await page.waitForSelector('tbody tr.click', { timeout: 15000 }); await page.click('tbody tr.click'); await page.waitForTimeout(900);
  const cid = page.url().split('/client/')[1].split('/')[0];
  await page.goto(root + `#/client/${cid}/forms`); await page.waitForTimeout(900); const before = await page.$$eval('tbody tr', r => r.length);
  await page.click('button:has-text("+ Fill out a form")'); await page.waitForSelector('.modal .quick-item'); await page.click('.modal .quick-item:has-text("Consent for Release")'); await page.waitForSelector('.ff-modal', { timeout: 10000 });
  const prefilled = await page.inputValue('.ff-modal [data-field=client_name] input');
  ok(!!prefilled, `${label}: the form opens with the client's details already filled in`, prefilled);
  await page.fill('.ff-modal [data-field=recipient] input', 'County OTP'); await page.fill('.ff-modal [data-field=purpose] textarea', 'MAT intake coordination'); await page.selectOption('.ff-modal [data-field=info] select', 'Referral summary'); await page.fill('.ff-modal [data-field=expires] input', '2027-01-01'); await page.check('.ff-modal [data-field=redisclosure] input'); await page.fill('.ff-modal [data-field=client_sig] input', prefilled);
  await page.click('.ff-modal button:has-text("Mark completed")'); await page.waitForTimeout(300); await page.click('.modal-bg:last-child button.primary'); await page.waitForTimeout(1200);
  await until(async () => (await page.$$eval('tbody tr', r => r.length)) === before + 1);
  const rows = await page.$$eval('tbody tr', r => r.map(x => x.textContent));
  eq(rows.length, before + 1, `${label}: the completed form is attached to the client record`);
  ok(/Completed/.test(rows[0] || ''), `${label}: and shows as completed`, (rows[0] || '').replace(/\s+/g, ' ').slice(0, 80));
  // reopen, attach a signed copy, print
  await page.waitForSelector('tbody tr.click', { timeout: 15000 }); await page.click('tbody tr.click'); await page.waitForSelector('.ff-modal');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.ff-modal button:has-text("Attach photo or PDF")')]); await chooser.setFiles('/tmp/suds-shots/sig.png'); await page.waitForTimeout(1500);
  ok(await page.$('.ff-modal a:has-text("sig.png")'), `${label}: a photo of the signed copy attaches to the form`);
  if (label === 'office') { await page.evaluate(() => { window.__opened = null; window.open = (u) => { window.__opened = u; return null; }; }); await page.click('.ff-modal button:has-text("Print / PDF")'); const u = await page.evaluate(() => window.__opened); const r = await ctx.request.get(base + u); const body = await r.body(); ok(body.slice(0, 4).toString().startsWith('%PDF'), `${label}: the form prints as a real PDF`, u); }
  else { const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.ff-modal button:has-text("Print / PDF")')]); ok(/\.pdf$/.test(dl.suggestedFilename()), `${label}: the phone builds the PDF itself`, dl.suggestedFilename()); }
  await page.screenshot({ path: `/tmp/suds-shots/form-filler-${label}.png` });
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await ctx.close();
}
async function designer() {
  const ctx = await browser.newContext({ viewport: { width: 1250, height: 900 } }); const page = await ctx.newPage(); let loggedIn = false;
  page.on('pageerror', e => errors.push(`designer PAGEERROR ${e.message}`)); page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push(`designer CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'jwalker'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout'); loggedIn = true; await settle(page); await page.goto(base + '/#/'); await page.waitForTimeout(800); await settle(page);
  await page.goto(base + '/#/forms'); await page.waitForTimeout(1000); const n0 = await page.$$eval('.tpl-card', x => x.length);
  await page.click('button:has-text("+ Add a county form")'); await page.waitForSelector('.modal .designer');
  await page.fill('.modal input[name=name]', 'Housing Assistance Application'); await page.selectOption('.modal select[name=category]', 'housing');
  await page.click('.modal button:has-text("+ Usual client header fields")'); await page.click('.modal button:has-text("+ Field")'); await page.fill('.modal .dfield:last-child input', 'Monthly income'); 
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.modal button:has-text("Upload file")')]); await chooser.setFiles('/tmp/suds-shots/sig.png'); await page.waitForTimeout(800);
  await page.click('.modal button[type=submit]'); await page.waitForTimeout(1500);
  await until(async () => (await page.$$eval('.tpl-card', x => x.length)) === n0 + 1);
  eq(await page.$$eval('.tpl-card', x => x.length), n0 + 1, 'designer: a county form built by hand joins the library');
  const txt = await page.textContent(`.tpl-card:has-text("Housing Assistance Application")`);
  ok(/7 fields/.test(txt), 'designer: with the fields that were added', txt.replace(/\s+/g, ' ').slice(0, 120));
  ok(/Picture attached/.test(txt), 'designer: and the uploaded county original');
  await page.screenshot({ path: '/tmp/suds-shots/forms-library.png' });
  // --- library-level upload / download shortcuts ---
  ok(await page.$('button:has-text("Upload form")'), 'designer: the library offers an upload-form shortcut');
  const [uploadChooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("Upload form")')]);
  await uploadChooser.setFiles('/tmp/suds-shots/sig.png'); await page.waitForSelector('.modal .designer');
  eq(await page.inputValue('.modal input[name=name]'), 'sig', 'designer: uploading a file jumps straight into the designer with the name guessed from the filename');
  ok(/sig\.png will be saved/.test(await page.textContent('.modal')), 'designer: and the file already attached, not waiting to be uploaded again');
  await page.click('.modal button[type=submit]'); await page.waitForTimeout(1200);
  await until(async () => (await page.$$eval('.tpl-card', x => x.length)) === n0 + 2);
  eq(await page.$$eval('.tpl-card', x => x.length), n0 + 2, 'designer: the uploaded form joins the library without a trip through "+ Add a county form"');
  ok(await page.$('button:has-text("Download forms")'), 'designer: the library offers a bulk download for everything currently in view');
  const [bulkDl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download forms")')]);
  ok(!!bulkDl.suggestedFilename(), 'designer: clicking it starts downloading the library\'s forms', bulkDl.suggestedFilename());
  await ctx.close();
}
await run('office', base + '/', async (p) => { await p.goto(base + '/#/login'); await p.fill('input[name=username]', 'mrivera'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 8000 }); await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await p.waitForTimeout(700); });
await designer();
await run('local', base + '/?local=1', async (p) => {
  if (await p.$('input[name=display_name]')) { await p.fill('input[name=display_name]', 'Form Nav'); await p.fill('input[name=username]', 'formnav'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.fill('input[name=confirm]', 'Navigator2026!!'); await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 10000 }); await p.waitForTimeout(800); }
  await p.goto(base + '/?local=1#/sync'); await p.waitForTimeout(1200); if (await p.$('button:has-text("Load sample data")')) { await p.click('button:has-text("Load sample data")'); await p.waitForSelector('[data-sample=loaded]', { timeout: 40000 }); }
});
finish(errors);
await browser.close();

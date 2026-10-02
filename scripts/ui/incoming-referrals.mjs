// Incoming referrals (built for 1.24.0; public/views/incoming.js), in a browser, as the seed's navigator:
//   1. + Incoming referral on the queue records one, and opens it;
//   2. it is on Home ("new referral", to the queue's New filter) and in the queue;
//   3. Log an attempt moves it to Contacting and sets the time to first contact;
//   4. Accept → Create a new client from this referral opens New client — full intake filled in from the referral, and
//      saving it links the referral (Accepted, with the client to open);
//   5. axe on the queue, the form, a referral and the accept dialog.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, settle, until } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('incoming-referrals');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];

async function axe(page, where) {
  if (!axeSource) { fail('axe-core is not installed (npm i --no-save axe-core)'); return; }
  await page.evaluate(axeSource + ';0');
  const v = await page.evaluate(async () => {
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading', 'landmark-unique', 'page-has-heading-one'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[134]/.test(m.text())) errors.push(`CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', PW); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
  const surname = `Intakeui${Date.now().toString(36).slice(-5)}`;

  // 1. Record one from the queue.
  await go('incoming');
  ok(await page.$('[data-incoming-queue]'), 'the queue opens for a navigator');
  ok(await page.evaluate(() => [...document.querySelectorAll('.sidebar a')].some(a => /#\/incoming$/.test(a.getAttribute('href') || ''))), 'Incoming referrals is in the menu');
  await axe(page, 'the queue');
  await page.click('[data-new-incoming]');
  await page.waitForSelector('.modal [data-incoming-form] form');
  await axe(page, 'the incoming referral form');
  await page.fill('.modal [name=first_name]', 'Lucia');
  await page.fill('.modal [name=last_name]', surname);
  await page.fill('.modal [name=phone]', '555-0144');
  await page.selectOption('.modal [name=source_type]', 'jail_reentry');
  await page.fill('.modal [name=referring_org]', 'County Jail Re-entry Unit');
  await page.selectOption('.modal [name=received_via]', 'fax');
  await page.selectOption('.modal [name=urgency]', 'soon');
  await page.fill('.modal [name=reason]', 'Release next week, wants MAT continuity');
  await page.click('.modal button[type=submit]');
  ok(await until(() => page.evaluate(() => /^#\/incoming\/[\w-]+/.test(location.hash) && !!document.querySelector('[data-incoming-detail]'))), 'saving opens the referral', await page.evaluate(() => location.hash));
  await settle(page);
  const id = await page.evaluate(() => document.querySelector('[data-incoming-detail]').dataset.incomingDetail);
  ok(await page.evaluate((s) => document.querySelector('[data-incoming-detail] h2').textContent.includes(s), surname), 'it shows the person');
  eq(await page.evaluate(() => document.title.includes('Lucia')), false, 'the person\'s name is not in the page title');

  // 2. Home and the queue.
  await go('dashboard');
  const pill = await until(() => page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => /new referral/.test(x.textContent)); return a ? { text: a.textContent, href: a.getAttribute('href') } : null; }));
  ok(pill && pill.href === '#/incoming?status=new', 'Home shows the new referrals, linking to the queue', pill);
  await go('incoming?status=new');
  ok(await page.evaluate((s) => [...document.querySelectorAll('[data-incoming-queue] table tbody tr')].some(tr => tr.textContent.includes(s) && tr.textContent.includes('Soon')), surname), 'the queue lists it, with its urgency');

  // 3. An attempt.
  await go(`incoming/${id}`);
  await axe(page, 'a referral');
  eq(await page.evaluate(() => document.querySelector('[data-first-contact]').dataset.firstContact), '0', 'nobody has tried to reach them yet');
  await page.click('[data-log-attempt]');
  await page.waitForSelector('.modal form [name=outcome]');
  await page.selectOption('.modal [name=outcome]', 'reached');
  await page.fill('.modal [name=notes]', 'Spoke with her, wants an intake appointment');
  await page.click('.modal button[type=submit]');
  ok(await until(() => page.evaluate(() => document.querySelector('[data-first-contact]')?.dataset.firstContact === '1')), 'the attempt sets the time to first contact');
  await settle(page);
  ok(await page.evaluate(() => [...document.querySelectorAll('.badge')].some(b => b.textContent === 'Contacting')), 'and moves it to Contacting');
  ok(await page.evaluate(() => [...document.querySelectorAll('table tbody tr')].some(tr => tr.textContent.includes('Reached them'))), 'the attempt is listed');

  // 4. Accept into a new client.
  await page.click('[data-accept]');
  await page.waitForSelector('.modal [data-accept-dialog]');
  await settle(page);
  await axe(page, 'the accept dialog');
  await page.click('[data-accept-new]');
  await page.waitForSelector('.modal [name=last_name]');
  eq(await page.inputValue('.modal [name=last_name]'), surname, 'New client is filled in from the referral (surname)');
  eq(await page.inputValue('.modal [name=phone]'), '555-0144', '…and phone');
  eq(await page.inputValue('.modal [name=referral_source]'), 'jail', '…and who referred them (Jail)');
  await page.click('.modal button[type=submit]');
  const accepted = await until(() => page.evaluate(() => document.querySelector('[data-accepted-client]')?.dataset.acceptedClient), { timeout: 15000 });
  ok(accepted, 'saving the client accepts the referral and links it', await page.evaluate(() => [...document.querySelectorAll('.modal .err, .modal .banner')].map(x => x.textContent).filter(Boolean)));
  await settle(page);
  ok(await page.evaluate(() => [...document.querySelectorAll('.badge')].some(b => b.textContent === 'Accepted')), 'it shows Accepted');
  ok(await page.evaluate(() => /a new client/.test(document.querySelector('[data-accepted-client]').textContent)), 'as a new client');
  if (accepted) {
    await page.click('[data-accepted-client] a');
    ok(await until(() => page.evaluate((c) => location.hash.startsWith(`#/client/${c}`), accepted)), 'the client opens from the referral');
  }
  await go('incoming');
  ok(await page.evaluate((s) => ![...document.querySelectorAll('[data-incoming-queue] table tbody tr')].some(tr => tr.textContent.includes(s)), surname), 'it has left the open queue');
  await ctx.close();
} catch (e) { fail(`threw: ${e.stack || e.message}`); }
await browser.close();
for (const e of errors) fail(e);
finish();

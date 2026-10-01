// Day-to-day usefulness for frontline workers (1.22.0, docs/USER_GUIDE.md): what changed on the screens a navigator,
// an outreach worker, a peer, a clinician and a supervisor use most, at phone width where that is how they work.
//   * a client's Overview opens with "Where things stand" (last contact, next to-do, open referrals), before the
//     identity details, at 390 px;
//   * due and follow-up dates have quick choices (Today, Tomorrow, In 3 days, In a week); a new to-do has no Status;
//   * a call-back date ticks "Follow-up needed" and the to-do is made;
//   * Street outreach: Save contact stays in reach, "Same as last contact" fills the last bundle in one tap, and Undo
//     takes back a contact just saved without moving the keyboard focus off the form;
//   * a clinician's note format is remembered, and a structured note's section boxes are labelled;
//   * the supervision queue says who made each referral waiting for an outcome, and for how long;
//   * the search box's hint fits a phone;
//   * on a device that syncs with the office, the header says whether anything is waiting to be sent.
// Every new state is put through axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, settle, until, passRecoveryCode } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('worker-usefulness');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const browser = await chromium.launch();
const errors = [];
const PHONE = { width: 390, height: 844 };

function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[134]|Failed to load resource/.test(m.text())) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${who} HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
}
async function session(username, password, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage(); watch(page, username);
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 });
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) }));
  await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
  return { ctx, page, api, go };
}
async function axe(page, where) {
  if (!axeSource) { fail('axe-core is not installed (npm i --no-save axe-core)'); return; }
  await page.evaluate(axeSource + ';0');
  const v = await page.evaluate(async () => {
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading', 'landmark-unique'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
}
const toastSays = (page, re) => until(async () => re.test((await page.$$eval('.toast', els => els.map(e => e.textContent))).join(' | ')));
const localDay = (page, days) => page.evaluate((n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, days);
// The phone's "Add…" list on a client record, then one of its entries.
async function addOnPhone(page, label) {
  await page.click('[data-client-add]');
  await page.click(`.add-list button:text-is("${label}")`);
  await page.waitForSelector('.modal form');
}

try {
  // ======== a navigator's day, at 390 px ========
  const nav = await session('mrivera', PW, PHONE);
  const clients = (await nav.api('GET', '/api/clients?status=all&limit=50&q=DEMO-0001')).data.clients;
  const cid = clients[0].id;
  await nav.go(`client/${cid}`);
  // ---- Where things stand ----
  ok(await nav.page.$('[data-glance]'), 'a client\'s Overview has "Where things stand"');
  const order = await nav.page.evaluate(() => {
    const g = document.querySelector('[data-glance]'); const id = [...document.querySelectorAll('.card h2')].find(x => /Identity & contact/.test(x.textContent));
    return !!(g && id && (g.compareDocumentPosition(id) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  ok(order, 'it comes before the identity details');
  const top = await nav.page.$eval('[data-glance]', el => el.getBoundingClientRect().top);
  ok(top < 844, 'and is on the first screen at 390 px, without scrolling', top);
  const glance = await nav.page.textContent('[data-glance]');
  ok(/Last contact/.test(glance) && /ago|today|yesterday/.test(glance) && /Maria Rivera/.test(glance), 'it says when the client was last seen or spoken to, and by whom', glance.slice(0, 200));
  eq(await nav.page.$eval('[data-glance-todo]', el => el.dataset.glanceTodo), 'overdue', 'it names the next to-do, overdue here');
  ok(await nav.page.$('[data-glance-todo-link][href$="/tasks"]'), 'which opens the client\'s To-dos');
  ok(await nav.page.$('[data-glance-referrals]'), 'and counts the open referrals');
  await axe(nav.page, 'client Overview with Where things stand (390 px)');

  // ---- + To-do: no Status on a new one, and quick due dates ----
  await addOnPhone(nav.page, 'To-do');
  ok(!(await nav.page.$('.modal select[name=status]')), 'a new to-do does not ask for a Status');
  ok(await nav.page.$('.modal [data-quick-dates="due_at"][role=group]'), 'its Due date has quick choices');
  await nav.page.fill('.modal input[name=title]', 'Check on the bed at Hope Street');
  await nav.page.click('.modal [data-quick-dates="due_at"] [data-quick-date="1"]');
  eq(await nav.page.inputValue('.modal input[name=due_at]'), await localDay(nav.page, 1), '"Tomorrow" sets the due date to tomorrow');
  await axe(nav.page, 'New to-do with quick dates (390 px)');
  await nav.page.click('.modal button[type=submit]');
  ok(await toastSays(nav.page, /To-do saved/), 'the to-do is saved');
  await settle(nav.page);
  const tasks = (await nav.api('GET', `/api/tasks?client_id=${cid}&limit=100`)).data.rows;
  const made = tasks.find(t => t.title === 'Check on the bed at Hope Street');
  ok(made && String(made.due_at).slice(0, 10) === await localDay(nav.page, 1) && made.status === 'open', 'open, due tomorrow', made && [made.due_at, made.status]);

  // ---- + Call: a call-back date ticks Follow-up needed, and the to-do is made ----
  await nav.go(`client/${cid}`);
  await addOnPhone(nav.page, 'Call');
  await nav.page.fill('.modal input[name=purpose]', 'Bed callback');
  await nav.page.selectOption('.modal select[name=outcome]', 'voicemail');
  ok(!(await nav.page.isChecked('.modal input[name=follow_up_needed]')), 'Follow-up needed starts unticked');
  await nav.page.click('.modal [data-quick-dates="follow_up_due"] [data-quick-date="3"]');
  eq(await nav.page.inputValue('.modal input[name=follow_up_due]'), await localDay(nav.page, 3), '"In 3 days" sets the call-back date');
  ok(await nav.page.isChecked('.modal input[name=follow_up_needed]'), 'and ticks Follow-up needed');
  await nav.page.click('.modal button[type=submit]');
  ok(await toastSays(nav.page, /Call logged/), 'the call is logged');
  await settle(nav.page);
  const after = (await nav.api('GET', `/api/tasks?client_id=${cid}&limit=100`)).data.rows; const in3 = await localDay(nav.page, 3);
  ok(after.some(t => t.title === 'Call back: Bed callback' && String(t.due_at).slice(0, 10) === in3), 'its call-back to-do is on the list', after.map(t => t.title));

  // ---- + Log a visit: the follow-up date has the same quick choices ----
  await nav.go(`client/${cid}`);
  await addOnPhone(nav.page, 'Log a visit');
  ok(await nav.page.$('.modal [data-quick-dates="follow_up_due"]'), 'a visit\'s follow-up date has quick choices too');
  await nav.page.click('.modal .btn-row button:text-is("Cancel")');

  // ---- the search box's hint fits a phone ----
  const ph = await nav.page.$eval('.appbar .gsearch input', i => i.placeholder);
  eq(ph, 'Name, code or exact phone…', 'on a phone the search hint is short enough to read whole');
  const fits = await nav.page.$eval('.appbar .gsearch input', (i) => { const c = document.createElement('canvas').getContext('2d'); const s = getComputedStyle(i); c.font = `${s.fontSize} ${s.fontFamily}`; return c.measureText(i.placeholder).width <= i.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight); });
  ok(fits, 'and it fits in the box');
  await nav.ctx.close();

  // ======== street outreach, a peer at 390 px ========
  const peer = await session('dchen', PW, PHONE);
  await peer.go('outreach');
  const saveBox = await peer.page.$eval('[data-outreach-save]', b => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  ok(saveBox.bottom <= 844 && saveBox.top >= 0, 'Save contact is on screen without scrolling', saveBox);
  ok(await peer.page.$eval('[data-outreach-same]', b => b.hidden), 'no "Same as last contact" before the first contact');
  const contacts = async () => Number(await peer.page.$eval('[data-outreach-shift] .stat .v, [data-outreach-shift] .stat', el => el.textContent.match(/\d+/)[0]));
  const c0 = await contacts();
  const rows = await peer.page.$$('[data-outreach-item]');
  const first = await rows[0].getAttribute('data-outreach-item'); const second = await rows[1].getAttribute('data-outreach-item');
  await peer.page.click(`[data-outreach-item="${first}"] [data-step="1"]`);
  await peer.page.click(`[data-outreach-item="${second}"] [data-step="1"]`); await peer.page.click(`[data-outreach-item="${second}"] [data-step="1"]`);
  await peer.page.click('[data-outreach-save]');
  await peer.page.waitForSelector('[data-undo-toast]');
  await settle(peer.page);
  eq(await contacts(), c0 + 1, 'the contact is counted in My shift');
  ok(!(await peer.page.evaluate(() => !!document.activeElement.closest('[data-undo-toast]'))), 'the keyboard focus stays on the form, not on Undo');
  ok(!(await peer.page.$eval('[data-outreach-same]', b => b.hidden)), '"Same as last contact" appears');
  const same = await peer.page.textContent('[data-outreach-same]');
  ok(/Same as last contact/.test(same) && /\b1\b/.test(same) && /\b2\b/.test(same), 'and says what it fills in', same);
  await axe(peer.page, 'Street outreach after a contact, with Undo and Same as last contact (390 px)');
  // Undo takes it back.
  await peer.page.click('[data-undo-toast] [data-undo]');
  ok(await toastSays(peer.page, /Undone/), 'Undo takes the contact back');
  await settle(peer.page);
  eq(await contacts(), c0, 'and My shift no longer counts it');
  // 1.23.0: the undone contact's bundle is not offered again; with no contact before it, there is nothing to offer.
  ok(await peer.page.$eval('[data-outreach-same]', b => b.hidden), 'after Undo of the only contact, "Same as last contact" is gone');
  await peer.page.click(`[data-outreach-item="${first}"] [data-step="1"]`);
  await peer.page.click(`[data-outreach-item="${second}"] [data-step="1"]`); await peer.page.click(`[data-outreach-item="${second}"] [data-step="1"]`);
  await peer.page.click('[data-outreach-save]');
  await peer.page.waitForSelector('[data-undo-toast]'); await settle(peer.page);
  eq(await contacts(), c0 + 1, 'saved again, it counts once');
  // Same as last contact fills the counts in one tap.
  await peer.page.click('[data-outreach-same]');
  eq(await peer.page.inputValue(`[data-outreach-item="${first}"] input`), '1', '"Same as last contact" fills in the first item');
  eq(await peer.page.inputValue(`[data-outreach-item="${second}"] input`), '2', 'and the second');
  await peer.ctx.close();

  // ======== a counselor writes a structured note ========
  const cl = await session('kpatel', PW);
  await cl.go(`client/${cid}`);
  await cl.page.click('.client-actions.wide button:text-is("+ Note")'); await cl.page.waitForSelector('.modal form');
  await cl.page.selectOption('.modal select[name=format]', 'SOAP');
  await cl.page.waitForSelector('.modal textarea[data-sec="S"]');
  const unlabelled = await cl.page.$$eval('.modal textarea[data-sec]', els => els.filter(t => !t.id || !document.querySelector(`label[for="${t.id}"]`)).length);
  eq(unlabelled, 0, 'every SOAP section box has its own label');
  await axe(cl.page, 'New SOAP note');
  for (const k of ['S', 'O', 'A', 'P']) await cl.page.fill(`.modal textarea[data-sec="${k}"]`, `Section ${k} written for the usefulness check.`);
  await cl.page.click('.modal .btn-row button[type=submit]:not([data-save-sign])');
  ok(await toastSays(cl.page, /Saved as a draft/), 'the note is saved as a draft');
  await settle(cl.page);
  await cl.page.click('.client-actions.wide button:text-is("+ Note")'); await cl.page.waitForSelector('.modal form');
  eq(await cl.page.inputValue('.modal select[name=format]'), 'SOAP', 'the next new note starts in SOAP, the format last used');
  ok(await cl.page.$('.modal textarea[data-sec="S"]'), 'with its sections showing');
  await cl.page.click('.modal .btn-row button:text-is("Cancel")');
  await cl.ctx.close();

  // ======== a supervisor's queue ========
  const sup = await session('jwalker', PW);
  await sup.go('supervision');
  const heads = await sup.page.$$eval('[data-awaiting-outcome] th', ths => ths.map(t => t.textContent.trim()));
  ok(heads.includes('Made by'), 'referrals waiting for an outcome say who made them', heads);
  ok(await sup.page.$('[data-awaiting-outcome] [data-referral-waiting]'), 'and how long ago they were sent');
  await axe(sup.page, 'Supervision queue');
  await sup.ctx.close();

  // ======== a device that syncs with the office: the header says what is waiting ========
  const dctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true }); const dev = await dctx.newPage(); watch(dev, 'device');
  await dev.goto(base + '/?local=1#/'); await settle(dev);
  await dev.fill('input[name=display_name]', 'Field Phone'); await dev.fill('input[name=username]', 'dchen');
  await dev.fill('input[name=password]', PW); await dev.fill('input[name=confirm]', PW);
  await dev.click('button[type=submit]');
  await dev.waitForSelector('.layout', { timeout: 20000 }); await settle(dev); await passRecoveryCode(dev);
  const dapi = (m, p, b) => dev.evaluate(([m, p, b]) => window.SUDS_LOCAL.handle(m, p, b, {}).then(r => r.json), [m, p, b]);
  ok(await dev.$('[data-sync-chip]'), 'the header of a device copy shows its sync state');
  await until(async () => (await dev.getAttribute('[data-sync-chip]', 'data-sync-chip')) !== 'loading');
  eq(await dev.getAttribute('[data-sync-chip]', 'data-sync-chip'), 'never', 'before the first sync it says so');
  const s1 = await dapi('POST', '/api/local/sync', { server: base, username: 'dchen', password: PW });
  ok(s1 && s1.ok, 'the device syncs with the office', s1 && s1.error);
  await dapi('POST', '/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), location: 'street', modality: 'in_person' });
  await dev.goto(base + '/?local=1#/outreach'); await settle(dev);
  await until(async () => (await dev.getAttribute('[data-sync-chip]', 'data-sync-chip')) === 'pending');
  eq(await dev.getAttribute('[data-sync-chip]', 'data-sync-chip'), 'pending', 'a contact not yet sent shows as waiting');
  ok(/1 to send/.test(await dev.textContent('[data-sync-chip]')), 'in words: "1 to send"', await dev.textContent('[data-sync-chip]'));
  eq(await dev.getAttribute('[data-sync-chip]', 'href'), '#/sync', 'and it opens This device');
  ok(await dev.isVisible('[data-sync-chip] .sync-short'), 'at 390 px it shows the short form ("⇅ 1"), leaving the search box its width');
  ok(/1 change on this device not sent/.test(await dev.evaluate(() => document.querySelector('[data-sync-chip] .sr-only').textContent)), 'and a screen reader hears it in full');
  await axe(dev, 'device copy header with the sync state (390 px)');
  await dctx.close();
} catch (e) { fail(`the script stopped: ${e.message}`); console.error(e); }
await browser.close();
finish(errors);

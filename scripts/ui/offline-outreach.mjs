// 1.23.0: Street outreach with no signal on the office app, and "Set up this phone for the field".
//   * a phone goes offline (Playwright's context.setOffline): a contact that names nobody is kept on the phone, the
//     header says "1 contact waiting to send", the screen lists it; the offline banner says what is kept and points at
//     setting this phone up for the field, not at get-app.html;
//   * a contact with notes is not kept as it is: the screen offers to keep it without them, and what is kept holds no
//     notes or participant code; Discard removes one for good;
//   * back online, the waiting contact is sent by itself, once: one contact at the office, its kit drawn once;
//   * with the session gone, Send now opens the sign-in screen (not "no signal"), and signing in sends the contact;
//   * Undo of a contact puts "Same as last contact" back to the bundle before it, or hides it when there was none;
//   * a worker asks for their phone to be set up for the field; an administrator approves it under Synced devices;
//   * 1.23.1: the office app's service worker installs and activates although the server answers 404 for local/*
//     (an office server with local mode off: before, the unread 404s held every connection and the install never
//     finished); with no signal, Clients, To-dos and Street outreach open from the menu; a reload with no signal
//     loads the app from the worker's copy and shows a plain offline page (not "Failed to fetch dynamically imported
//     module") that links to Street outreach, whose waiting list still works and is sent when the signal is back;
//   * 1.23.1: a to-do opens the record it came from: a supervisor's reminder opens the referral's Record outcome form
//     (from the list at 1280 px and from the to-do on a phone), with no record id in its details; a visit's
//     follow-up opens the visit.
// Every new state is put through axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, settle, until } from './assert.mjs';

// The worker's own requests (its install) go through context.route only with this set; read at launch.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('offline-outreach');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const browser = await chromium.launch();
const errors = [];
let offline = false;

function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[134]|Failed to load resource/.test(m.text()) && !(offline && /ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError/.test(m.text()))) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${who} HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
}
async function session(username, password, viewport = { width: 1280, height: 900 }, prepare = null) {
  const ctx = await browser.newContext({ viewport, ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
  if (prepare) await prepare(ctx);
  const page = await ctx.newPage(); watch(page, username);
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 });
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true, first_day_skip: true }) }));
  await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
  // A reload, for preferences changed through the API (the page reads them as it starts).
  const fresh = async (hash) => { await page.goto(`${base}/#/${hash}`); await page.reload(); await page.waitForSelector('.layout'); await settle(page); };
  return { ctx, page, api, go, fresh };
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
const chipCount = (page) => page.$eval('[data-queue-chip]', e => (e.hidden ? 0 : Number(e.dataset.queueChip))).catch(() => 0);
const waitingInBrowser = (page) => page.evaluate(async () => { const q = await import('./outreach-queue.js'); return (await q.waiting()).map(x => x.payload); });

try {
  // ======== an outreach worker on a phone, at the office ========
  const nav = await session('mrivera', PW, { width: 390, height: 844 });
  const since = new Date(Date.now() - 60000).toISOString();
  const shift = async () => (await nav.api('GET', `/api/outreach/shift?since=${encodeURIComponent(since)}`)).data;
  const cat = (await nav.api('GET', '/api/supplies/catalog')).data;
  const kit = cat.items.filter(i => i.category === 'naloxone').sort((a, b) => b.quick - a.quick)[0];
  const strip = cat.items.filter(i => i.category === 'fentanyl_test_strips').sort((a, b) => b.quick - a.quick)[0];
  ok(kit && strip, 'the sample supplies have a naloxone kit and test strips');
  // Start with no "Same as last contact" (a fresh worker).
  await nav.api('PUT', '/api/me/prefs', { outreach_last: null });
  await nav.fresh('outreach');
  const plus = (id) => nav.page.click(`[data-outreach-item="${id}"] button[data-step="1"]`);
  const before = await shift();
  const kitBefore = (before.supplies.find(s => s.item_id === kit.id) || { quantity: 0 }).quantity;

  // ---- 1. no signal: a contact that names nobody waits on the phone ----
  await plus(kit.id);
  await nav.ctx.setOffline(true); offline = true;
  await nav.page.click('[data-outreach-save]');
  ok(await toastSays(nav.page, /kept on this phone/), 'saving with no signal says the contact is kept on this phone');
  ok(await until(async () => (await chipCount(nav.page)) === 1), 'the header says 1 contact is waiting to send');
  ok(/1 contact waiting to send/.test(await nav.page.$eval('[data-queue-chip]', e => e.textContent)), 'in words', await nav.page.$eval('[data-queue-chip]', e => e.textContent));
  eq(await nav.page.$eval('[data-outreach-waiting]', e => e.dataset.outreachWaiting), '1', 'the screen lists it under Waiting to send');
  eq(await nav.page.inputValue(`[data-outreach-item="${kit.id}"] input`), '0', 'and the form is ready for the next contact');
  const bannerEl = await nav.page.$('#banners [data-banner="offline"]');
  ok(bannerEl && /kept on this phone/.test(await bannerEl.textContent()), 'the offline banner says what happens to a contact in hand');
  ok(bannerEl && await bannerEl.$('a[href="#/field-phone"]'), 'and points at setting this phone up for the field');
  ok(bannerEl && !(await bannerEl.$('a[href="get-app.html"]')), 'not at SUDS on this device');
  await axe(nav.page, 'Street outreach with a contact waiting (offline)');

  // ---- 2. notes are not kept: keep it without them; discard ----
  await plus(strip.id);
  await nav.page.fill('[data-outreach-notes]', 'Asked about the van schedule');
  await nav.page.click('[data-outreach-save]');
  ok(await until(() => nav.page.$('[data-outreach-keep-bare]')), 'a contact with notes is not kept as it is: the screen offers to keep it without them');
  eq(await nav.page.inputValue('[data-outreach-notes]'), 'Asked about the van schedule', 'and the notes are still in the form until then');
  await axe(nav.page, 'Street outreach offering to keep a contact without its notes');
  await nav.page.click('[data-outreach-keep-bare]');
  ok(await until(async () => (await chipCount(nav.page)) === 2), 'kept without them: 2 waiting');
  const kept = await waitingInBrowser(nav.page);
  eq(kept.length, 2, 'two contacts in the browser\'s waiting list');
  ok(kept.every(p => !('summary' in p) && !('participant_code' in p) && !('client_id' in p)), 'none holds notes, a participant code or a client', kept);
  // Discard the second.
  const keys = await nav.page.$$eval('[data-outreach-discard]', els => els.map(e => e.dataset.outreachDiscard));
  await nav.page.click(`[data-outreach-discard="${keys[1]}"]`);
  await nav.page.waitForSelector('.modal-bg .modal');
  await axe(nav.page, 'Discard this contact? dialog');
  await nav.page.click('.modal-bg .modal button:text-is("Discard")');
  ok(await until(async () => (await chipCount(nav.page)) === 1), 'Discard removes it: 1 waiting');

  // ---- 3. back online: sent by itself, once ----
  await nav.ctx.setOffline(false); offline = false;
  ok(await until(async () => (await chipCount(nav.page)) === 0, { timeout: 15000 }), 'back online, the waiting contact is sent and the header count goes');
  ok(await toastSays(nav.page, /1 waiting contact sent/), 'with a message that it was sent');
  ok(!(await nav.page.$('#banners [data-banner="offline"]')), 'the offline banner goes');
  const after1 = await shift();
  eq(after1.contacts, before.contacts + 1, 'one contact at the office (the discarded one was never sent)');
  eq((after1.supplies.find(s => s.item_id === kit.id) || { quantity: 0 }).quantity, kitBefore + 1, 'its kit drawn once');
  // Sending again (Send now, a second tab) changes nothing.
  const flushed = await nav.page.evaluate(async () => (await import('./outreach-queue.js')).flush({ all: true }));
  eq(flushed.sent, 0, 'nothing left to send');
  eq((await shift()).contacts, before.contacts + 1, 'still one contact');

  // ---- 3b. the session ended while a contact waited (review of 1.23.0): Send now asks to sign in, not "no signal",
  // and the contact is sent once the worker has signed in again ----
  await nav.go('outreach');
  await nav.ctx.setOffline(true); offline = true;
  await plus(kit.id);
  await nav.page.click('[data-outreach-save]');
  ok(await until(async () => (await chipCount(nav.page)) === 1), 'a second contact waits with no signal');
  await nav.ctx.clearCookies();
  const refused = nav.page.waitForResponse(r => r.url().includes('/api/interventions') && r.request().method() === 'POST' && r.status() === 401, { timeout: 15000 }).then(() => true, () => false);
  await nav.ctx.setOffline(false); offline = false;
  ok(await refused, 'back online with the session gone, the office refuses to take it (401)');
  eq(await chipCount(nav.page), 1, 'and it stays on the phone');
  await nav.page.click('[data-outreach-send-now]');
  ok(await until(() => nav.page.$('input[name=username]')), 'Send now with the session gone opens the sign-in screen');
  ok(await toastSays(nav.page, /session has ended/), 'and says the session ended, not that there is no signal');
  ok(!/Still no signal/.test((await nav.page.$$eval('.toast', els => els.map(e => e.textContent))).join(' | ')), 'no "Still no signal" message');
  await nav.page.fill('input[name=username]', 'mrivera'); await nav.page.fill('input[name=password]', PW); await nav.page.click('button[type=submit]');
  await nav.page.waitForSelector('.layout', { timeout: 15000 });
  ok(await until(async () => (await shift()).contacts === before.contacts + 2, { timeout: 15000 }), 'signed in again, the waiting contact is sent');
  ok(await until(async () => (await chipCount(nav.page)) === 0), 'and the header count goes');

  // ---- 3c. a waiting contact the office had made, and the worker had undone since (1.23.1): not "sent" ----
  // The screen's attempt reached the office (its answer lost), the contact was deleted, and the waiting list then
  // sends it: the office answers that it was undone, and the toast says it was not recorded rather than "sent".
  const undoneKey = `ui-undone-${Date.now()}`;
  const undonePayload = { type: 'outreach', occurred_at: new Date(Date.now() - 120000).toISOString(), location: 'street', modality: 'in_person', duration_minutes: 0, supplies: [] };
  const made = await nav.page.evaluate(async ({ k, p }) => (await import('./app.js')).post('/api/interventions', p, { idempotencyKey: k, quiet: true }), { k: undoneKey, p: undonePayload });
  eq((await nav.api('DELETE', `/api/interventions/${made.id}`)).status, 200, 'the contact is deleted at the office');
  await nav.page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); // the last step's toasts
  const undoneFlush = await nav.page.evaluate(async ({ k, p }) => { const q = await import('./outreach-queue.js'); await q.keep({ key: k, payload: p, what: 'no supplies' }); return q.flush({ all: true }); }, { k: undoneKey, p: undonePayload });
  eq(undoneFlush.undone, 1, `the waiting list counts it as undone: ${JSON.stringify(undoneFlush)}`);
  eq(undoneFlush.sent, 0, 'not as sent');
  ok(await toastSays(nav.page, /1 waiting contact was not recorded: it had been undone/), 'the toast says it was not recorded because it had been undone');
  ok(!/waiting contact sent/.test((await nav.page.$$eval('.toast', els => els.map(e => e.textContent))).join(' | ')), 'and not that it was sent');
  eq((await waitingInBrowser(nav.page)).length, 0, 'it is no longer waiting');
  eq((await nav.api('GET', `/api/interventions/${made.id}`)).status, 404, 'and the office did not make it again');

  // ---- 4. Undo puts "Same as last contact" back ----
  await nav.go('outreach');
  // What it offers now: the last contact entered (the one kept without its notes, a test strip).
  const sameBefore = await nav.page.$eval('[data-outreach-same]', e => (e.hidden ? '' : e.textContent));
  ok(sameBefore.includes(strip.name.slice(0, 8)), 'Same as last contact offers the last contact entered', sameBefore);
  await plus(kit.id); await plus(kit.id);
  await nav.page.click('[data-outreach-save]');
  ok(await toastSays(nav.page, /Contact saved/), 'a contact with two kits is saved');
  ok(await nav.page.$eval('[data-outreach-same]', (e, name) => e.textContent.includes(`2 ${name}`.slice(0, 6)) && e.textContent.includes(name.slice(0, 8)), kit.name), 'Same as last contact now offers the two kits', await nav.page.$eval('[data-outreach-same]', e => e.textContent));
  await nav.page.click('.undo-toast [data-undo]');
  ok(await toastSays(nav.page, /Undone/), 'Undo takes it back');
  ok(await until(async () => (await nav.page.$eval('[data-outreach-same]', e => (e.hidden ? '' : e.textContent))) === sameBefore), 'and Same as last contact is the bundle before it again', await nav.page.$eval('[data-outreach-same]', e => e.textContent));
  // With no bundle before: hidden after Undo.
  await nav.api('PUT', '/api/me/prefs', { outreach_last: null });
  await nav.fresh('outreach');
  ok(await nav.page.$eval('[data-outreach-same]', e => e.hidden), 'with no last contact there is no Same as last contact');
  await plus(kit.id);
  await nav.page.click('[data-outreach-save]');
  ok(await until(() => nav.page.$eval('[data-outreach-same]', e => !e.hidden)), 'after a save it is offered');
  await nav.page.click('.undo-toast [data-undo]');
  ok(await until(() => nav.page.$eval('[data-outreach-same]', e => e.hidden)), 'Undo of the only contact hides it again');

  // ---- 5. Set up this phone for the field ----
  await nav.go('field-phone');
  eq((await nav.page.textContent('.main h1')).trim(), 'Set up this phone for the field', 'the page opens');
  ok(/Set up this phone for the field/.test(await nav.page.title()), 'with its own title', await nav.page.title());
  ok(await nav.page.$('[data-field-self] a[data-field-open-copy]'), 'where offline copies are allowed, it says how to set it up yourself (Keep only what I need in the field)');
  await axe(nav.page, 'Set up this phone for the field');
  await nav.page.click('[data-field-request]');
  ok(await until(async () => (await nav.page.$eval('[data-field-request-status]', e => e.dataset.fieldRequestStatus)) === 'open'), 'Ask my administrator: the request is open');
  await axe(nav.page, 'Set up this phone for the field, asked');

  const admin = await session('admin', 'AdminPassw0rd!x');
  const due = (await admin.api('GET', '/api/tasks?limit=200')).data.rows || [];
  ok(due.some(t => /Field device: .* asks for their phone/.test(t.title || '')), 'the administrator has a to-do');
  await admin.go('admin?tab=devices');
  ok(await admin.page.$('[data-field-requests="1"]'), 'Synced devices lists the request');
  await axe(admin.page, 'Synced devices with a field-device request');
  const uid = await admin.page.$eval('[data-field-request-user]', e => e.dataset.fieldRequestUser);
  await admin.page.click(`[data-field-approve="${uid}"]`);
  await admin.page.waitForSelector('.modal-bg .modal');
  await admin.page.click('.modal-bg .modal button:text-is("Approve")');
  ok(await until(async () => !(await admin.page.$('[data-field-requests]'))), 'Approve answers it');
  await nav.fresh('field-phone');
  eq(await nav.page.$eval('[data-field-request-status]', e => e.dataset.fieldRequestStatus), 'approved', 'the worker sees it approved');
  await admin.ctx.close();
  await nav.ctx.close();

  // ---- 6. the office app's service worker, and the app with no signal (evaluation of 1.23.0) ----
  // The suite's server has local mode on; an office server has it off and answers 404 for local/*. The worker's
  // requests for those three files are sent to an address the server does not have: a real 404 on a real connection.
  const phone = await session('mrivera', PW, { width: 390, height: 844 }, (ctx) => ctx.route(/\/local\/(kernel\.js|sql-wasm\.wasm|audit-worker\.js)/, (r) => r.continue({ url: `${base}/local/no-such-file.js` })));
  const p = phone.page;
  const swState = await p.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(r => (r.active ? r.active.state : 'none')), new Promise(r => setTimeout(() => r('timed out'), 20000))]));
  ok(['activating', 'activated'].includes(swState), 'the office app\'s service worker installs and activates with local/* answering 404', swState);
  const shell = await p.evaluate(async () => { const c = await caches.open((await caches.keys()).find(k => /^suds-shell-/.test(k))); return (await c.keys()).map(r => new URL(r.url).pathname); });
  ok(shell.length >= 59 && ['/views/clients.js', '/views/tasks.js', '/views/outreach.js', '/outreach-queue.js'].every(f => shell.includes(f)), `the whole shell is cached (${shell.length} files)`, shell.length);
  ok(await until(() => p.evaluate(() => !!navigator.serviceWorker.controller)), 'and the worker controls the page');
  const health = await p.evaluate(() => navigator.serviceWorker.controller && fetch('/api/health').then(r => r.status, () => 0));
  eq(health, 200, 'a request after the install is answered (it used to wait for ever)');
  const raw = async () => /Failed to fetch|dynamically imported module|could not be shown/i.test(await p.textContent('.main'));
  const fromMenu = async (hash) => {
    await p.click('.mobilebar button[aria-controls=sidebar]');
    await until(() => p.$eval('.sidebar', e => e.classList.contains('open')));
    const link = `.sidebar a[href="#/${hash}"]`;
    if (!(await p.isVisible(link))) await p.click('.sidebar details.nav-more > summary');
    await p.click(link); await settle(p);
  };
  const shift6 = async () => (await phone.api('GET', `/api/outreach/shift?since=${encodeURIComponent(since)}`)).data.contacts;
  const officeBefore = await shift6();
  await phone.go('dashboard');
  await phone.ctx.setOffline(true); offline = true;
  for (const [hash, name] of [['clients', 'Clients'], ['tasks', 'To-dos']]) {
    await fromMenu(hash);
    ok(await p.$('[data-offline-page]'), `with no signal, ${name} opens from the menu: a page that says the app is offline`);
    ok(!(await raw()), `${name}: not the browser's "Failed to fetch dynamically imported module"`, (await p.textContent('.main')).slice(0, 200));
  }
  await axe(p, 'the offline page');
  await fromMenu('outreach');
  eq((await p.textContent('.main h1')).trim(), 'Street outreach', 'with no signal, Street outreach opens from the menu');
  // A reload with no signal: the app comes from the worker's copy, and knows who is signed in in this tab.
  await phone.go('tasks');
  await p.reload(); await p.waitForSelector('.layout', { timeout: 15000 }); await settle(p);
  ok(await p.$('[data-offline-page]'), 'a reload with no signal loads the app and shows the plain offline page');
  ok(!(await raw()), 'not the raw error', (await p.textContent('.main')).slice(0, 200));
  ok(!(await p.$('input[name=password]')), 'not the sign-in form, which cannot work with no signal');
  ok(await p.$('#banners [data-banner="offline"]'), 'the offline banner is up');
  await axe(p, 'the offline page after a reload with no signal');
  await p.click('[data-offline-page] a[data-offline-outreach]'); await settle(p);
  eq((await p.textContent('.main h1')).trim(), 'Street outreach', 'its link opens Street outreach');
  await p.click('[data-outreach-item="naloxone_kits"] button[data-step="1"]');
  await p.click('[data-outreach-save]');
  ok(await toastSays(p, /kept on this phone/), 'a contact saved after the offline reload is kept on this phone');
  ok(await until(async () => (await chipCount(p)) === 1), 'and the header says 1 contact is waiting to send');
  await phone.ctx.setOffline(false); offline = false;
  ok(await until(async () => (await chipCount(p)) === 0, { timeout: 15000 }), 'back online, it is sent');
  ok(await until(async () => (await shift6()) === officeBefore + 1), 'and the office has it, once');
  await phone.ctx.close();

  // ---- 7. a to-do opens the record it came from (evaluation of 1.23.0) ----
  const boss = await session('jwalker', PW);
  const waitingRef = ((await boss.api('GET', '/api/supervision/queue')).data.referrals_awaiting_outcome || []).find(x => x.may_remind && !x.reminded_at && x.worker === 'Maria Rivera');
  ok(waitingRef, 'the sample data has a referral of Maria\'s waiting to hear what happened');
  const sent = await boss.api('POST', `/api/supervision/referrals/${waitingRef.id}/remind`, {});
  eq(sent.status, 200, 'the supervisor reminds her', sent.data);
  await boss.ctx.close();
  const desk = await session('mrivera', PW);
  const reminder = ((await desk.api('GET', '/api/tasks?status=open&limit=500')).data.rows || []).find(t => t.id === sent.data.task);
  ok(reminder && !reminder.description.includes(waitingRef.id) && !/Reference:/.test(reminder.description), 'the reminder\'s details carry no record id', reminder && reminder.description);
  ok(reminder && /\(sent [A-Z][a-z]{2} \d{1,2}, \d{4}\)/.test(reminder.description), 'and give the date as the app does ("Jun 19, 2026")', reminder && reminder.description);
  await desk.go('tasks');
  const srcBtn = `tr:has-text("${reminder.title}") [data-task-source="referral"]`;
  ok(await desk.page.$(srcBtn), 'the reminder\'s row offers Open the referral');
  await desk.page.click(srcBtn);
  await desk.page.waitForSelector('.modal-bg .modal');
  ok(/Referral to /.test(await desk.page.textContent('.modal-bg .modal h2')) && await desk.page.$('.modal-bg .modal button[type=submit]:text-is("Record outcome")'), 'it opens the referral\'s Record outcome form', await desk.page.textContent('.modal-bg .modal h2'));
  await axe(desk.page, 'Record outcome opened from a reminder to-do');
  await desk.page.click('.modal-bg .modal button:text-is("Cancel")');
  // A visit's follow-up opens the visit.
  const cl = ((await desk.api('GET', '/api/caseload')).data.caseload || [])[0];
  const visit = await desk.api('POST', '/api/interventions', { client_id: cl.id, type: 'case_management', occurred_at: new Date().toISOString(), duration_minutes: 15, follow_up_due: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) });
  eq(visit.status, 201, 'a visit with a follow-up date', visit.data);
  const fu = ((await desk.api('GET', '/api/tasks?status=open&limit=500')).data.rows || []).find(t => t.intervention_id === visit.data.id);
  ok(fu, 'makes its follow-up to-do');
  await desk.go(`tasks?id=${fu.id}`);
  await desk.page.waitForSelector('.modal-bg .modal [data-task-source="visit"]');
  await axe(desk.page, 'Edit to-do with Open the visit');
  await desk.page.click('.modal-bg .modal [data-task-source="visit"]');
  ok(await until(() => desk.page.$(`[data-visit-view="${visit.data.id}"]`)), 'Edit to-do offers Open the visit, which opens it');
  await desk.ctx.close();
  // On a phone, the reminder (a row that opens the to-do) offers it too.
  const mob = await session('mrivera', PW, { width: 390, height: 844 });
  await mob.go('tasks');
  await mob.page.click(`.compact-row:has-text("${reminder.title}") .secondary`);
  await mob.page.waitForSelector('.modal-bg .modal [data-task-source="referral"]');
  await mob.page.click('.modal-bg .modal [data-task-source="referral"]');
  ok(await until(() => mob.page.$('.modal-bg .modal button[type=submit]:text-is("Record outcome")')), 'on a phone, the reminder\'s Open the referral opens Record outcome');
  await mob.ctx.close();
} catch (e) {
  fail(`threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
}
await browser.close();
finish(errors);

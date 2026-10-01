// Field devices and minimal personal information (released in 1.21.0), in a real browser:
//   1. Settings › Program › Minimal personal information: "Outreach records use a participant code by default",
//      "New devices start as field devices" and the field device's window;
//   2. with the participant code on, New client asks for the code first and keeps the name behind "Add a name",
//      and Street outreach asks for the code right under the kind of contact;
//   3. Settings › Synced devices shows what each device holds and makes one a field device;
//   4. the device itself, after its next sync, says "Field device: holds only …" on This device, and holds less.
// Every page and dialog it opens is checked with axe (WCAG 2.1 A/AA), as scripts/ui/accessibility.mjs does.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle, passRecoveryCode, saved } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('field-device');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const browser = await chromium.launch();
const errors = [];

function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[134]|Failed to load resource/.test(m.text())) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
}
async function session(username, password, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
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
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading', 'landmark-unique', 'page-has-heading-one'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
}
const visible = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.closest('[hidden]') && el.getClientRects().length > 0; }, sel);

try {
  const admin = await session('admin', 'AdminPassw0rd!x');
  // ---- 1. the settings ----
  await admin.go('admin?tab=settings&section=minimal');
  ok(await visible(admin.page, 'select[name=participant_code_default]'), 'Program settings offer "Outreach records use a participant code by default", opened from the link');
  eq(await admin.page.$eval('select[name=participant_code_default]', s => s.value), '0', 'and it is off by default');
  ok(await visible(admin.page, 'select[name=field_device_default]'), 'and "New devices start as field devices"');
  eq(await admin.page.$eval('select[name=field_device_default]', s => s.value), '0', 'off by default too');
  eq(await admin.page.$eval('input[name=field_device_window_days]', s => s.value), '90', 'a field device holds 90 days unless changed');
  await axe(admin.page, 'Settings › Program, minimal personal information open');
  await admin.page.selectOption('select[name=participant_code_default]', '1');
  await admin.page.click('.card:has(h2:text("Program settings")) button[type=submit]');
  await until(async () => (await admin.api('GET', '/api/admin/settings')).data.participant_code_default === '1');
  eq((await admin.api('GET', '/api/admin/settings')).data.participant_code_default, '1', 'saving the form turns the participant code on');

  // ---- 2. participant-code mode for a navigator ----
  const nav = await session('mrivera', PW, { width: 390, height: 844 });
  ok((await nav.api('GET', '/api/auth/me')).data.programme.participant_code_default, 'the navigator\'s session knows the programme starts with a code');
  await nav.go('clients');
  await nav.page.evaluate(async () => (await import('/views/clients.js')).openClientForm(null));
  await nav.page.waitForSelector('[data-quick-add]');
  ok(await visible(nav.page, '[data-quick-add] input[name=participant_code]'), 'New client asks for the participant code');
  ok(!(await visible(nav.page, '[data-quick-add] input[name=first_name]')), 'the name is not asked for');
  ok(!(await visible(nav.page, '[data-quick-add] input[name=dob]')), 'nor the date of birth');
  ok(await visible(nav.page, '[data-add-name]'), '"Add a name" is one step away');
  await axe(nav.page, 'New client in participant-code mode');
  await nav.page.focus('[data-add-name]'); await nav.page.keyboard.press('Enter');
  ok(await visible(nav.page, '[data-quick-add] input[name=first_name]'), '"Add a name" shows the name fields');
  eq(await nav.page.evaluate(() => document.activeElement && document.activeElement.name), 'first_name', 'and moves the focus to the first name');
  await nav.page.fill('[data-quick-add] input[name=participant_code]', 'ui 77-01');
  await nav.page.click('[data-quick-add] button[type=submit]');
  await nav.page.waitForFunction(() => /#\/client\//.test(location.hash), null, { timeout: 15000 }); await settle(nav.page);
  const id = await nav.page.evaluate(() => location.hash.split('/')[2].split('?')[0]);
  const created = (await nav.api('GET', `/api/clients/${id}`)).data.client;
  eq(created.participant_code, 'UI7701', 'the client is created with the code (normalised) and no name');
  eq(created.display_name, 'Participant UI7701', 'and shown by it');
  ok(await nav.page.evaluate(() => document.body.innerText.includes('Participant UI7701')), 'the record says who it is by the code');
  await nav.go('outreach');
  const order = await nav.page.evaluate(() => { const f = document.querySelector('[data-outreach-form]'); const kids = [...f.children]; return { code: kids.findIndex(k => k.matches('.outreach-code')), where: kids.findIndex(k => k.matches('.outreach-where')), types: kids.findIndex(k => k.matches('[data-outreach-types]')) }; });
  ok(order.types < order.code && order.code < order.where, 'Street outreach asks for the participant code right under the kind of contact', order);
  eq(await nav.page.$eval('.outreach-code label', l => l.textContent), 'Participant code', 'labelled as the way to record the person');
  await axe(nav.page, 'Street outreach in participant-code mode');

  // ---- 3 and 4. a device, made a field device ----
  const dctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const dev = await dctx.newPage(); watch(dev, 'device');
  await dev.goto(base + '/?local=1#/'); await settle(dev);
  await dev.fill('input[name=display_name]', 'Field Phone'); await dev.fill('input[name=username]', 'mrivera');
  await dev.fill('input[name=password]', PW); await dev.fill('input[name=confirm]', PW);
  await dev.click('button[type=submit]');
  await dev.waitForSelector('.layout', { timeout: 15000 }); await settle(dev); await passRecoveryCode(dev);
  const dapi = (m, p, b) => dev.evaluate(([m, p, b]) => window.SUDS_LOCAL.handle(m, p, b, {}).then(r => r.json), [m, p, b]);
  const sync = () => dapi('POST', '/api/local/sync', { server: base, username: 'mrivera', password: PW });
  const s1 = await sync();
  ok(s1 && s1.ok, 'the device\'s first sync completes', s1 && s1.error);
  const fullClients = (await dapi('GET', '/api/clients?status=all&limit=500')).clients.length;
  ok(fullClients > 1, 'as a full device it holds the clients its navigator may see', fullClients);
  await dev.goto(base + '/?local=1#/sync'); await settle(dev);
  eq(await dev.$eval('[data-device-holds]', e => e.dataset.deviceHolds), 'full', 'This device says it holds everything its user may see');
  ok(await visible(dev, 'input[name=field_device]'), 'and offers to keep only what is needed in the field');

  await admin.go('admin?tab=devices');
  ok(await visible(admin.page, '[data-device-scope="full"]'), 'Synced devices shows what the device holds');
  ok(await visible(admin.page, '[data-field-device-help]'), 'and says what a field device holds');
  await axe(admin.page, 'Settings › Synced devices');
  await admin.page.click('[data-device-scope-change]');
  await admin.page.waitForSelector('.modal-bg .modal');
  ok(await admin.page.evaluate(() => /sends what it has recorded/.test(document.querySelector('.modal-bg .modal').innerText)), 'the confirmation says what happens at its next sync');
  await axe(admin.page, 'Make field device confirmation');
  await admin.page.click('.modal-bg .modal button.primary');
  await until(async () => admin.page.$('[data-device-scope="field"]'));
  ok(await admin.page.$('[data-device-scope="field"]'), 'the device is listed as a field device');

  const s2 = await sync();
  ok(s2 && s2.ok, 'the device syncs as a field device', s2 && s2.error);
  ok((s2.notices || []).some(n => /now a field device/.test(n)), 'and is told it is one now', s2.notices);
  const fieldClients = (await dapi('GET', '/api/clients?status=all&limit=500')).clients.length;
  ok(fieldClients < fullClients, 'it holds fewer clients: only its navigator\'s own recent caseload', { fullClients, fieldClients });
  await saved(dev);
  // This device again, drawn afresh (the page was already on it).
  await dev.evaluate(() => { location.hash = '#/dashboard'; }); await settle(dev);
  await dev.evaluate(() => { location.hash = '#/sync'; }); await settle(dev);
  eq(await dev.$eval('[data-device-holds]', e => e.dataset.deviceHolds), 'field', 'This device says it is a field device');
  ok(await dev.$eval('[data-field-device-status]', e => /^Field device: holds only/.test(e.textContent)), 'with "Field device: holds only …"');
  ok(!(await dev.$('input[name=field_device]')), 'and no longer offers the choice');
  await axe(dev, 'This device, a field device');

  // ---- 5. the scope follows the account (built for 1.22.0) ----
  await admin.go('admin?tab=devices');
  eq(await admin.page.$eval('[data-device-scope="field"]', e => e.dataset.deviceAccountField), '1', 'Synced devices knows the navigator\'s account is now held to the field scope');
  ok(await admin.page.$eval('[data-field-device-help]', e => /every device they sync from is one/.test(e.textContent)), 'and says every device of theirs is a field device unless one is marked "Hold everything"');
  // A field device's sync session cannot change the account: the office refuses it and points to the browser.
  const refused = await dev.evaluate(async (base) => {
    const h = { 'Content-Type': 'application/json', 'X-Sync-Client': '1', 'X-Requested-With': 'suds', 'X-Device-Id': 'ui-field-device-check' };
    const login = await fetch(base + '/api/auth/login', { method: 'POST', credentials: 'omit', headers: h, body: JSON.stringify({ username: 'mrivera', password: 'Navigator2026!!' }) }).then(r => r.json());
    const r = await fetch(base + '/api/auth/sessions', { credentials: 'omit', headers: { ...h, Authorization: 'Bearer ' + login.token } });
    const body = await r.json();
    await fetch(base + '/api/auth/logout', { method: 'POST', credentials: 'omit', headers: { ...h, Authorization: 'Bearer ' + login.token }, body: '{}' });
    return { scope: login.device && login.device.scope, status: r.status, error: body.error };
  }, base);
  eq(refused.scope, 'field', 'a new device id of the same account signs in as a field device');
  eq(refused.status, 403, 'and its sync session cannot reach account management');
  ok(/web browser/.test(refused.error || ''), 'the refusal says to use a web browser', refused.error);
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
}

finish(errors);
await browser.close();

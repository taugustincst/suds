// Client-record revision history with revert (1.17.0, server/client-revisions.js), in a browser:
//   * Maria, off the care team, changes David's client: David's change notice has "See what changed", which opens the
//     record's History at that change (outlined and focused), with each field's value before and after;
//   * David, the primary worker, puts the change back: the fields return, the History keeps both changes (the
//     revert names the one it put back, which has no revert button any more);
//   * a supervisor sees the History with its revert buttons; Maria, who can open the record, is not shown its earlier
//     values; a phone shows the same History.
// The History tab and the notice card are checked with axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('r10-hist');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
const PHONE = [{ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }];

async function session(username, password = PW, viewport = { width: 1280, height: 900 }, extra = {}, prefs = { tour_done: true }) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  await api('PUT', '/api/me/prefs', prefs);
  await page.reload(); await page.waitForSelector('.layout'); await settle(page);
  const go = async (hash) => { await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 15000 }).catch(() => {}); await settle(page); };
  return { ctx, page, api, go };
}
async function axe(page, where) {
  if (!axeSource) { fail('axe-core is not installed (npm i --no-save axe-core)'); return; }
  await page.evaluate(axeSource + ';0');
  const v = await page.evaluate(async () => {
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
}
const toastText = (page, re) => until(async () => { const t = await page.$$eval('#toasts .toast', ts => ts.map(x => x.textContent).join(' | ')); return re.test(t) ? t : null; }, { timeout: 5000 });
/** The Before and After cells of a field's row in one revision's table. */
const cells = (page, rev, field) => page.$$eval(`[data-revision="${rev}"] tbody tr`, (trs, field) => {
  const tr = trs.find(t => t.querySelector('td') && t.querySelector('td').textContent.trim() === field);
  return tr ? [...tr.querySelectorAll('td')].slice(1).map(td => td.textContent.trim()) : null;
}, field);
const tag = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

try {
  // ------------------------------------------------------------------ David's client; Maria (off the team) changes it
  const dchen = await session('dchen');
  const made = await dchen.api('POST', '/api/clients', { first_name: 'Hana', last_name: `History${tag}`, phone: '555-301-1100', dob: '1988-04-12', confirm_duplicate: true });
  eq(made.status, 201, 'David adds a client (he becomes the primary worker)');
  const cid = made.data.id;
  await dchen.ctx.close();
  const maria = await session('mrivera');
  const put = await maria.api('PUT', `/api/clients/${cid}`, { phone: '555-301-9999', dob: '1988-04-21' });
  eq(put.status, 200, 'Maria, off the care team, changes the phone number and date of birth');
  const rev = put.data && put.data.revision;
  ok(rev, 'the change is kept as a revision');
  // Maria can open the record but not its earlier values.
  eq((await maria.api('GET', `/api/clients/${cid}`)).data.client.history.read, false, 'Maria is not offered the History');
  await maria.go(`client/${cid}`);
  await maria.page.waitForSelector('.main button[data-tab="overview"]');
  ok(!(await maria.page.$('.main button[data-tab="history"]')), 'and her record has no History tab');
  await maria.go(`client/${cid}/history`);
  ok(await until(() => maria.page.$('.main [data-client-history="refused"]')), 'an address that names it says it is for the care team and supervisors');
  ok(!/555-301-1100|1988/.test(await maria.page.textContent('.main')), 'and shows none of the earlier values');
  await maria.ctx.close();

  // ------------------------------------------------------------------ David: the notice's "See what changed"
  const david = await session('dchen');
  const notice = (await david.api('GET', `/api/tasks?client_id=${cid}&status=open`)).data.rows.find(t => t.notice === true);
  ok(notice, 'David has a change notice');
  eq(JSON.stringify(notice && notice.notice_revisions), JSON.stringify([rev]), 'it names the revision it reports');
  await david.go(`client/${cid}`);
  ok(await until(() => david.page.$('.main button[data-tab="history"]')), 'David\'s record has a History tab');
  const link = await until(() => david.page.$('.main [data-timeline-notice] a'));
  if (link) {
    await link.click();
    const card = await until(() => david.page.$('.modal [data-change-notice]'));
    ok(card, 'the notice opens as a card');
    const see = await until(() => david.page.$('.modal a[data-notice-history]'));
    ok(see, 'with See what changed');
    ok(/before and after/.test(await david.page.textContent('.modal')), 'which says the History has each field before and after');
    if (see) eq(await see.getAttribute('href'), `#/client/${cid}/history?rev=${rev}`, 'linking to the record\'s History at this change');
    await axe(david.page, 'the change notice card with See what changed');
    if (see) await see.click();
  } else fail('the client\'s Recent activity has no notice');
  const hi = await until(() => david.page.$(`.main .rev-highlight[data-revision="${rev}"]`));
  ok(hi, 'the History opens with the change outlined');
  ok(await until(() => david.page.evaluate((r) => document.activeElement && document.activeElement.dataset.revision === r, rev)), 'and focused, so a screen reader starts there');
  eq(JSON.stringify(await cells(david.page, rev, 'Phone')), JSON.stringify(['555-301-1100', '555-301-9999']), 'Phone: before and after');
  const dob = await cells(david.page, rev, 'Date of birth');
  ok(dob && dob.length === 2 && /1988/.test(dob[0]) && /12/.test(dob[0]) && /21/.test(dob[1]), 'Date of birth: before and after, as dates', JSON.stringify(dob));
  ok(/Maria Rivera/.test(await david.page.textContent(`[data-revision="${rev}"] h3`)), 'named by who made it');
  ok(await david.page.$('.main button[data-tab="history"][aria-current="page"]'), 'the record\'s History tab is the one shown');
  await axe(david.page, 'the History tab');

  // ------------------------------------------------------------------ David puts it back
  await david.page.click(`[data-revert="${rev}"]`);
  const dlg = await until(() => david.page.$('.modal'));
  ok(dlg && /Put this change back\?/.test(await dlg.textContent()), 'a confirmation says what will go back');
  await axe(david.page, 'the put-back confirmation');
  await david.page.click('.modal button:text-is("Put it back")');
  ok(await toastText(david.page, /Change put back/), 'the toast says it is put back');
  const back = (await david.api('GET', `/api/clients/${cid}`)).data.client;
  eq(back.phone, '555-301-1100', 'the phone number is what it was');
  eq(back.dob, '1988-04-12', 'and the date of birth');
  await david.go(`client/${cid}/history`);
  const entries = await until(async () => { const n = await david.page.$$eval('.main [data-revision]', els => els.map(e => e.dataset.revision)); return n.length >= 2 ? n : null; });
  eq(entries && entries.length, 2, 'the History keeps both changes');
  if (entries) {
    const newest = entries[0];
    ok(newest !== rev && /Put back an earlier change/.test(await david.page.textContent(`[data-revision="${newest}"]`)), 'the newest is the put-back, and says so');
    eq(JSON.stringify(await cells(david.page, newest, 'Phone')), JSON.stringify(['555-301-9999', '555-301-1100']), 'its Phone goes from Maria\'s number back to the first');
    ok(/Put back later/.test(await david.page.textContent(`[data-revision="${rev}"]`)), 'Maria\'s change says it was put back later');
    ok(!(await david.page.$(`[data-revert="${rev}"]`)), 'and offers no second put-back');
  }
  await david.ctx.close();

  // ------------------------------------------------------------------ a supervisor; and a phone
  const jw = await session('jwalker');
  eq(JSON.stringify((await jw.api('GET', `/api/clients/${cid}`)).data.client.history), JSON.stringify({ read: true, revert: true, office_only: false }), 'a supervisor reads the History and may put a change back');
  await jw.go(`client/${cid}/history`);
  ok(await until(() => jw.page.$('.main [data-client-history="list"] [data-revert]')), 'the supervisor\'s History has Put this change back');
  await jw.ctx.close();
  const dphone = await session('dchen', PW, ...PHONE);
  await dphone.go(`client/${cid}/history`);
  ok(await until(() => dphone.page.$('.main [data-client-history="list"] [data-revision]')), 'on a phone the History lists the changes');
  const overflow = await dphone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, 'without scrolling sideways (WCAG 1.4.10)', String(overflow));
  await axe(dphone.page, 'the History tab on a phone');
  await dphone.ctx.close();
} catch (e) {
  fail(`crashed: ${e.stack || e.message}`);
}
await browser.close();
eq(errors.length, 0, `no page errors, console errors or 5xx${errors.length ? ': ' + errors.join(' / ') : ''}`);
finish();

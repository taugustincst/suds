// The frontline-UX review of 1.16.1 (fixed in 1.16.2), in a browser:
//   H2 a client-change notice opens as a read-only card (who changed which fields, View client, Mark as seen),
//      never as the Edit to-do form, and without the reference line; M2 the client Edit form tells someone off the
//      care team that the primary worker will be told which fields change;
//   M3 Visits on a phone are compact two-line rows; M4 the Referrals actions fit a 1280 px window; M5 a visit with
//      no client says "Anonymous" (no empty link to #/client/null); M6 a colleague's referral says the outcome can
//      still be recorded rather than "view only";
//   L2 "My hours logged" is not among the program's tiles; L3 Visits name the client as Calls do; L4 a new visit
//      starts at the programme's default location when nothing is remembered; L6 a supervisor editing a colleague's overdose event is told
//      whose it is; L7 no permission is labelled "(all)"; L8 Finance's welcome tips are things Finance can do;
//      L9 Finance and Read-only are not offered as to-do assignees; L10 the two-step banner is one line on a phone.
// Pages and dialogs it changes are checked with axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('r7');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
const PHONE = [{ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }];

async function session(username, password = PW, viewport = { width: 1280, height: 900 }, extra = {}, { tour = true } = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  if (tour) await api('PUT', '/api/me/prefs', { tour_done: true });
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
const closeModals = async (page) => { for (let i = 0; i < 5 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await settle(page); } };
const rowWith = (page, text, sel = '.main tbody tr') => until(async () => { for (const tr of await page.$$(sel)) if ((await tr.textContent()).includes(text)) return tr; return null; });
const tag = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

try {
  // ------------------------------------------------------------------ David's client, and his records
  const dchen = await session('dchen');
  const made = await dchen.api('POST', '/api/clients', { first_name: 'Rhea', last_name: `Notice${tag}`, confirm_duplicate: true });
  eq(made.status, 201, 'David adds a client (he becomes the primary worker)');
  const cid = made.data.id;
  const now = new Date().toISOString();
  const ev = await dchen.api('POST', '/api/overdose-events', { occurred_at: now, kind: 'reversal', naloxone_used: 1, naloxone_doses: 1, city: `Town${tag}` });
  eq(ev.status, 201, 'and records a reversal');
  await dchen.ctx.close();

  // ------------------------------------------------------------------ Maria, a navigator, at 1280 px
  const maria = await session('mrivera');
  let { page, go, api } = maria;
  // M2: editing a client whose care team she is not on.
  await go(`client/${cid}`);
  await page.click('.main button:text-is("Edit")');
  const warn = await until(() => page.$('.modal [data-change-notice-warning]'));
  ok(warn && /David Chen is this client's primary worker\..*told which fields you change/.test(await warn.textContent()), 'the client Edit form tells Maria the primary worker will be told which fields change', warn && await warn.textContent());
  await axe(page, 'client Edit, off the care team');
  await closeModals(page);
  const put = await api('PUT', `/api/clients/${cid}`, { phone: '555-201-7788', risk_level: 'high' });
  eq(put.status, 200, 'Maria changes the phone number and risk level');

  // M5 / L3 / L5: Visits.
  const anon = await api('POST', '/api/interventions', { type: 'naloxone_distribution', occurred_at: now, naloxone_kits: 2, summary: `Anon${tag}` });
  eq(anon.status, 201, 'Maria logs an anonymous naloxone distribution');
  await go('interventions');
  eq(await page.locator('.main a[href="#/client/null"]').count(), 0, 'no visit links to #/client/null');
  let row = await rowWith(page, `Anon${tag}`);
  ok(row && (await (await row.$('td[data-label=Client]')).textContent()).trim() === 'Anonymous', 'a visit with no client says Anonymous, as text');
  const named = await page.$$eval('.main td[data-label=Client] a', as => as.map(a => a.textContent));
  ok(named.some(t => /,/.test(t)), 'visits name the client (Last, First) as Calls and To-dos do', named.slice(0, 3).join(' | '));
  await axe(page, 'Visits with an anonymous visit');
  // L4: with no visit remembered on this browser, a new visit starts at the programme's default location (the
  // street for a harm-reduction programme), not a fixed "Office" and not another visit fetched for it.
  const where = (await api('GET', '/api/meta/constants')).data.DEFAULT_LOCATION;
  await api('PUT', '/api/me/prefs', { visit_last: null });
  await page.evaluate(async () => { const { state } = await import('/app.js'); delete state.prefs.visit_last; });
  await page.evaluate(async () => (await import('/views/interventions.js')).openInterventionForm(null, {}));
  await page.waitForSelector('.modal select[name=location]', { state: 'attached' });
  eq(await page.$eval('.modal select[name=location]', s => s.value), where, "with nothing remembered, a new visit starts at the programme's default location");
  await closeModals(page);

  // M4 / M6: Referrals at 1280 px.
  await go('referrals?status=all');
  const fit = await page.evaluate(() => { const w = document.querySelector('.main .table-wrap'); const bs = [...document.querySelectorAll('.main tbody button')]; return { over: w ? w.scrollWidth - w.clientWidth : -1, right: Math.max(0, ...bs.map(b => b.getBoundingClientRect().right)) }; });
  ok(fit.over <= 1 && fit.right <= 1280, 'the Referrals table and its action buttons fit a 1280 px window', JSON.stringify(fit));
  const colleague = await rowWith(page, 'You can record the outcome');
  ok(colleague, 'a colleague\'s open referral says Maria can record the outcome');
  if (colleague) {
    ok(/only .+ or a supervisor can change the referral/.test(await colleague.textContent()), 'and who can change the referral');
    ok(await colleague.$('button:has-text("Record outcome")'), 'beside a Record outcome button');
    ok(!/view only/.test(await colleague.textContent()), 'and it no longer says "view only"');
  }
  await axe(page, 'Referrals');

  // L2: Maria's own hours are not one of the program's tiles.
  await go('dashboard');
  // The tiles fold under their heading (1.23.0): the heading is the fold's summary, the tiles its content.
  const tiles = await page.evaluate(() => { const fold = document.querySelector('[data-tiles-heading]')?.closest('[data-home-fold]'); const grid = fold && fold.querySelector(':scope > .grid'); return grid ? grid.textContent : ''; });
  ok(tiles && !tiles.includes('My hours logged'), 'the program tiles do not hold Maria\'s own hours');
  ok(/Your own work/.test(await page.textContent('[data-own-tiles]').catch(() => '')), 'which sit under "Your own work"');
  // L9: to-do assignees.
  await page.evaluate(async () => (await import('/views/tasks.js')).openTaskForm(null, {}));
  const people = await page.$$eval('.modal select[name=assigned_to] option', os => os.map(o => o.textContent));
  ok(people.length > 2 && !people.some(p => /\((Finance|Readonly|Read-only)\)/i.test(p)), 'New to-do does not offer Finance or Read-only accounts', people.join(' | '));
  await closeModals(page);
  await maria.ctx.close();

  // ------------------------------------------------------------------ H2: David reads the notice
  const david = await session('dchen');
  ({ page, go, api } = david);
  const notices = (await api('GET', '/api/tasks?status=open&mine=1&limit=300')).data.rows.filter(t => t.client_id === cid && (t.notice === true || /changed/.test(t.title)));
  eq(notices.length, 1, 'David has one notice about Maria\'s change');
  const notice = notices[0];
  await go('tasks');
  row = await rowWith(page, `Notice${tag}`);
  ok(row, 'the notice is in David\'s to-do list');
  if (row) {
    ok(!(await row.$('button:text-is("Edit")')), 'with no Edit button');
    ok(!/Reference|record change by/.test(await row.textContent()), 'and no reference line in its text');
    await (await row.$('[data-open-notice]')).click();
  }
  let card = await until(() => page.$('.modal [data-change-notice]'));
  ok(card, 'the notice opens as a card');
  if (card) {
    const text = await card.textContent();
    ok(!(await page.$('.modal input[name=title], .modal select[name=assigned_to]')), 'not as the Edit to-do form');
    ok(/Maria Rivera changed/.test(text) && /Phone/.test(text) && /Risk level/i.test(text), 'saying who changed which fields, by their labels', text.slice(0, 300));
    ok(!/Reference|[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), 'with no reference or user id showing');
    ok(/before and after/.test(text), 'and that the History has what the fields held before and after (1.17.0)');
    ok(await page.$(`.modal a[data-notice-client][href="#/client/${cid}"]`), 'with View client');
    await axe(page, 'change notice card');
    await page.click('.modal [data-notice-seen]');
    await until(async () => !(await page.$('.modal [data-change-notice]')));
    eq((await until(async () => { const s = (await api('GET', `/api/tasks/${notice.id}`)).data?.row?.status; return s === 'done' ? s : null; }, { timeout: 5000 })), 'done', 'Mark as seen closes the notice');
  }
  await david.ctx.close();
  // On a phone the bell's link (tasks?id=) opens the same card.
  const put2 = await (await session('mrivera')).api('PUT', `/api/clients/${cid}`, { preferred_name: `Ree${tag}` });
  eq(put2.status, 200, 'Maria changes the preferred name as well');
  const dphone = await session('dchen', PW, ...PHONE);
  const again = (await dphone.api('GET', '/api/tasks?status=open&mine=1&limit=300')).data.rows.find(t => t.client_id === cid && (t.notice === true || /changed/.test(t.title)));
  ok(again, 'a new notice is raised');
  if (again) {
    await dphone.go(`tasks?id=${again.id}`);
    card = await until(() => dphone.page.$('.modal [data-change-notice]'));
    ok(card && !(await dphone.page.$('.modal input[name=title]')), 'on a phone, the bell\'s link opens the notice card, not the form');
    await closeModals(dphone.page);
  }
  // M3: Visits on a phone are two-line rows.
  await dphone.go('interventions');
  const compact = await dphone.page.evaluate(() => { const rows = [...document.querySelectorAll('.main .compact-list .compact-row')].filter(r => r.offsetParent); const t = document.querySelector('.main .table-wrap table'); return { n: rows.length, tall: Math.max(0, ...rows.slice(0, 10).map(r => r.getBoundingClientRect().height)), table: t ? getComputedStyle(t).display : '' }; });
  ok(compact.n > 0 && compact.table === 'none', 'on a phone, Visits are compact rows, not stacked cards', JSON.stringify(compact));
  ok(compact.tall > 0 && compact.tall < 140, 'each about two lines tall', `${compact.tall}px`);
  const anonRow = await rowWith(dphone.page, `Anonymous`, '.main .compact-row');
  ok(anonRow, 'the anonymous visit reads "Anonymous" there too');
  await axe(dphone.page, 'Visits on a phone');
  // L10: the two-step reminder is one line on a phone and still says by when.
  const mfa = await dphone.page.$('[data-banner="mfa-required"]');
  if (mfa) {
    const b = await mfa.boundingBox();
    ok(b && b.height <= 56, 'on a phone the two-step reminder is one short line', b && `${Math.round(b.height)}px`);
    ok(/2-step due (now|by .+)\./.test(await mfa.innerText()), 'and still says by when', await mfa.innerText());
  } else ok(await dphone.page.$('[data-mfa-link]'), 'the two-step reminder is the header link once dismissed');
  await dphone.ctx.close();

  // ------------------------------------------------------------------ L6: a supervisor edits David's event
  const jw = await session('jwalker');
  await jw.go('overdose');
  const evRow = await rowWith(jw.page, `Town${tag}`);
  if (evRow) {
    await (await evRow.$('.row-open')).click();
    const line = await until(() => jw.page.$('.modal [data-others-record]'));
    ok(line && /Reported by David Chen\. You are changing another worker's record\./.test(await line.textContent()), 'a supervisor editing David\'s event is told whose it is');
    await closeModals(jw.page);
  } else fail('the supervisor does not see David\'s event');
  await jw.ctx.close();

  // ------------------------------------------------------------------ L7: permission labels; L8: Finance's tips
  const admin = await session('admin', 'AdminPassw0rd!x');
  const cat = (await admin.api('GET', '/api/permissions/catalog')).data.permissions;
  eq(cat.filter(p => /\(all\)/.test(p.label)).map(p => p.name).join(', '), '', 'no permission is labelled "(all)"');
  eq((cat.find(p => p.name === 'careplan:*') || {}).label, 'Care plans (read, add, change own)', 'care plans say a goal\'s wording is its author\'s');
  await admin.ctx.close();
  const fin = await session('afinance', PW, undefined, {}, { tour: false });
  await fin.go('dashboard?welcome=1');
  const tips = await fin.page.textContent('.welcome-steps').catch(() => '');
  ok(tips && !/\+ Log/.test(tips) && !/Open a client/.test(tips), 'Finance\'s welcome tips leave out + Log and opening clients', tips.slice(0, 200));
  await fin.ctx.close();
} catch (e) {
  fail(`crashed: ${e.stack || e.message}`);
}
await browser.close();
eq(errors.length, 0, `no page errors, console errors or 5xx${errors.length ? ': ' + errors.join(' / ') : ''}`);
finish();

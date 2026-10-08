// The same reminder must show the same day on the to-do list, the client timeline and Home.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch(); const errors = [];
const { ok, eq, finish } = makeChecks('dates');
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }); let loggedIn = false;
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout'); loggedIn = true;
await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
// pick a client, add a reminder due on a calendar day
await page.goto(base + '/#/clients'); await settle(page); await page.waitForSelector('tbody tr.click', { timeout: 15000 }); await page.click('tbody tr.click'); await settle(page);
const cid = page.url().split('/client/')[1].split('/')[0];
const d = new Date(); d.setDate(d.getDate() + 3); const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const expected = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
await page.click('button:has-text("+ To-do")'); await page.waitForSelector('.modal input[name=title]'); await page.fill('.modal input[name=title]', 'Bring ID to DMV appt'); await page.fill('.modal input[name=due_at]', iso); await page.fill('.modal input[name=due_at_time]', '17:00'); await page.click('.modal button[type=submit]'); await settle(page);
const timeline = async () => { await page.goto(`${base}/#/client/${cid}/timeline`); await settle(page); return (await page.$$eval('.timeline li', li => li.map(x => x.textContent.replace(/\s+/g, ' ')))).find(t => /Bring ID to DMV appt/.test(t)) || ''; };
const tl = await timeline();
ok(tl.length > 0, 'the reminder appears on the client timeline');
await page.goto(base + '/#/tasks'); await settle(page);
const row = await until(async () => (await page.$$eval('tbody tr', tr => tr.map(x => x.textContent.replace(/\s+/g, ' ')))).find(t => /Bring ID to DMV appt/.test(t))) || '';
ok(row.length > 0, 'and on the to-do list');
ok(tl.includes(expected), `the timeline shows the day it is due (${expected})`, tl.slice(0, 80));
ok(row.includes(expected), `the to-do list shows the same day (${expected})`, row.slice(0, 90));
ok(!/Bring Id To Dmv/.test(tl), 'the title is shown as it was typed, not re-cased');
// mark it done on the to-do list; the timeline must reflect it without a reload trick
await page.$eval('tbody tr:has-text("Bring ID to DMV appt") input[type=checkbox]', el => el.click()); await settle(page);
const tl2 = await timeline();
ok(/Done/.test(tl2), 'ticking it off on the to-do list shows as done on the timeline');
// phone width: to-do list renders as readable cards, no horizontal overflow
await page.setViewportSize({ width: 390, height: 800 }); await page.goto(base + '/#/tasks?status=all'); await settle(page);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth); const labelled = await page.$$eval('.table-wrap td[data-label="Due"]', t => t.length);
ok(!overflow, 'the to-do list does not scroll sideways on a phone');
ok(labelled > 0, 'and its cards label each value', labelled);
await page.screenshot({ path: '/tmp/suds-shots/todo-phone.png' });

// ---- A browser in Los Angeles (1.25.2): dates on the calendar the person is on, typed as people type them ----
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, timezoneId: 'America/Los_Angeles' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('PAGEERROR (LA) ' + e.message));
  const sign = async (u, pw) => { await p.goto(base + '/#/login'); await p.fill('input[name=username]', u); await p.fill('input[name=password]', pw); await p.click('button[type=submit]'); await p.waitForSelector('.layout'); await settle(p); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); };
  await sign('mrivera', 'Navigator2026!!');
  const api = (method, path, body) => p.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const here = await p.evaluate(() => { const d = new Date(); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; });
  const [y, mo, da] = here; const today = `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  const daysFrom = (n) => { const d = new Date(y, mo - 1, da + n); return d; };
  const mdy = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

  // CS2: a consent whose last day is today is in force all day, on the Consents tab as everywhere else.
  const cl = await api('POST', '/api/clients', { first_name: 'Lastday', last_name: 'Consent', confirm_duplicate: true });
  eq(cl.status, 201, 'a client for the consent');
  const k = await api('POST', `/api/clients/${cl.data.id}/consents`, { type: 'roi', signed_at: ymd(daysFrom(-30)), expires_at: today });
  eq(k.status, 201, 'a consent that expires today', k.data);
  await p.goto(`${base}/#/client/${cl.data.id}/consents`); await settle(p);
  const row = await until(async () => (await p.$$eval('tbody tr', tr => tr.map(x => x.textContent.replace(/\s+/g, ' ')))).find(t => /Expired|Active/.test(t))) || '';
  ok(/Active/.test(row) && !/Expired|\(expired\)/.test(row), 'the Consents tab shows a consent expiring today as Active, not Expired', row.slice(0, 160));

  // F2 and FL3: a date box reads what people type by its field.
  await p.goto(base + '/#/time'); await settle(p);
  await p.click('button:has-text("+ Log time")'); await p.waitForSelector('.modal input[name=work_date]');
  await p.fill('.modal input[name=work_date]', `${mo}/${da}`); await p.press('.modal input[name=work_date]', 'Tab');
  eq(await p.inputValue('.modal input[name=work_date]'), `${mo}/${da}/${y}`, 'a month and day alone is this year\'s, tidied to M/D/YYYY');
  // FL10: an earlier attempt's error is gone, words and all, once the date is fixed and Save asks something else.
  const first = daysFrom(-2);
  eq((await api('POST', '/api/time', { work_date: ymd(first), minutes: 45, start_time: '10:00', category: 'direct_service' })).status, 201, 'time already logged two days ago');
  await p.fill('.modal input[name=work_date]', '13/45'); await p.fill('.modal input[name=minutes]', '45'); await p.fill('.modal input[name=start_time]', '10:00');
  await p.click('.modal button[type=submit]');
  ok(await until(async () => /Check the highlighted date/.test(await p.textContent('.modal'))), 'an impossible date is refused');
  await p.fill('.modal input[name=work_date]', mdy(first)); await p.click('.modal button[type=submit]');
  ok(await until(() => p.$('.modal [data-time-duplicate]')), 'with the date fixed, Save asks whether it is time already logged');
  ok(!/Check the highlighted date/.test(await p.textContent('.modal')), 'and the old date error is no longer on the page', (await p.textContent('.modal')).slice(0, 200));
  await p.click('.modal [data-time-dup-answer="cancel"]'); await p.keyboard.press('Escape'); await settle(p);
  await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));

  // A date of birth (its max is today) reads a two-digit year into the past; a follow-up date looks ahead.
  await p.goto(base + '/#/clients'); await settle(p);
  await p.click('button:has-text("New client")'); await p.waitForSelector('.modal input[name=first_name]');
  const dobSel = '.modal input[name=dob]';
  await p.evaluate(() => document.querySelectorAll('.modal details.section').forEach(d => { d.open = true; }));
  const yy = String((y + 1) % 100).padStart(2, '0');
  await p.fill(dobSel, `1/5/${yy}`); await p.press(dobSel, 'Tab');
  eq(await p.inputValue(dobSel), `1/5/${y + 1 - 100}`, 'a date of birth "1/5/' + yy + '" is last century\'s, not next year');
  await p.keyboard.press('Escape'); await settle(p); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const yesterday = daysFrom(-1);
  if (yesterday.getFullYear() === y) {
    await p.goto(`${base}/#/client/${cl.data.id}`); await settle(p);
    await p.click('.client-actions.wide button:has-text("+ Log a visit")'); await p.waitForSelector('.modal');
    await p.click('.modal details[data-section-key="outcome"] > summary');
    await p.fill('.modal input[name=follow_up_due]', `${yesterday.getMonth() + 1}/${yesterday.getDate()}`); await p.press('.modal input[name=follow_up_due]', 'Tab');
    eq(await p.inputValue('.modal input[name=follow_up_due]'), `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${y + 1}`, 'a follow-up typed as a month and day that has gone this year is next year\'s');
    await p.keyboard.press('Escape'); await settle(p);
  }

  // BO4: the import preview lists each two-digit year with what it was read as.
  await p.goto(base + '/#/imports'); await settle(p);
  const card = '.card:has([data-import-entity])';
  await p.selectOption('[data-import-entity]', 'clients');
  await p.setInputFiles(`${card} input[type=file]`, { name: 'short-years.csv', mimeType: 'text/csv', buffer: Buffer.from('First name,Last name,Date of birth\r\nShort,Yearsample,7/9/81\r\nBad,Datesample,2/30/90\r\n') });
  ok(await until(() => p.$('[data-import-dates]')), 'the preview lists dates written with a two-digit year');
  const shown = (await p.textContent('[data-import-dates]')).replace(/\s+/g, ' ');
  ok(/7\/9\/81/.test(shown) && /1981/.test(shown), 'with what each was read as', shown.slice(0, 200));
  ok(/2\/30\/90" is not a valid date/.test(await p.textContent(card)), 'and an impossible date is a row that needs attention');
  await ctx.close();

  // CS16: the monthly trend names its months as the app does ("Oct 2026"), not "2026-10".
  const sctx = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const s = await sctx.newPage();
  await s.goto(base + '/#/login'); await s.fill('input[name=username]', 'jwalker'); await s.fill('input[name=password]', 'Navigator2026!!'); await s.click('button[type=submit]'); await s.waitForSelector('.layout');
  await s.goto(base + '/#/reports'); await settle(s);
  const months = await until(async () => { const m = await s.$$eval('[data-month]', els => els.map(e => [e.dataset.month, e.textContent])); return m.length ? m : null; }, { timeout: 15000 }) || [];
  ok(months.length > 0 && months.every(([ym, t]) => /^\d{4}-\d{2}$/.test(ym) && /^[A-Z][a-z]+\.? \d{4}$/.test(t)), 'the monthly trend shows months as "Oct 2026"', months.slice(0, 3));
  await sctx.close();
}
finish(errors);
await browser.close();

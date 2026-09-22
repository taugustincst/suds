// The defects an outside tester found on the published (static, always-local) build, replayed on both the
// static site and the office server's /?local=1 so a regression on either surface fails the suite:
//   P0 "Add resource" did nothing (a thrown DOM error before the request; now every error reaches the banner)
//   P0 Settings crashed on the device (config.oidc missing from the local kernel's config shim)
//   P1 a due date typed without a time was silently dropped (date + optional time controls now)
//   P1 a client with a blank status showed no status at all (rendered as Active; migration 19 backfills)
//   P2 the date picker could not be opened while the client search list was open over it
//   P3 the greeting must use the display name as typed, and the dialog title must not linger in the a11y tree
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import { makeChecks, until } from './assert.mjs';
const { ok, eq, fail, finish } = makeChecks('qa-retest');
const surfaces = [
  ['static site', (process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8877') + '/'],
  ['office server in local mode', (process.env.SUDS_URL || 'http://127.0.0.1:8090') + '/?local=1'],
];
const png = '/tmp/suds-qa-retest.png';
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVQI12P4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
const browser = await chromium.launch();
const errors = [];
const a11yHas = async (page, re) => { const walk = (n) => !!n && (re.test(n.name || '') || (n.children || []).some(walk)); return walk(await page.accessibility.snapshot()); };

for (const [label, base] of surfaces) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label}: PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${label}: CONSOLE ${m.text().slice(0, 250)}`); });
  const go = (hash) => page.goto(base + '#/' + hash);
  await go(''); await page.waitForSelector('input[name=display_name]', { timeout: 15000 });
  // The tester's own account: a one-word, all-capitals display name, administrator.
  await page.fill('input[name=display_name]', 'QATEST'); await page.selectOption('select[name=role]', 'admin');
  await page.fill('input[name=username]', 'qatest'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 });
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await page.waitForTimeout(150); }

  // P3-1 greeting
  const h1 = (await page.textContent('h1')) || '';
  ok(/^Good (morning|afternoon|evening), QATEST$/.test(h1.trim()), `${label}: the greeting shows the display name exactly as typed`, h1.trim());
  const fallback = await page.evaluate(async () => { const m = await import('./app.js'); return [m.firstName('', 'jdoe'), m.firstName('Dr. Kiran Patel'), m.clientStatus({ status: '' }), m.clientStatus({ status: null }), m.clientStatus({ status: 'inactive' })]; });
  eq(fallback[0], 'jdoe', `${label}: a blank display name greets by username`);
  eq(fallback[1], 'Kiran', `${label}: an honorific is skipped`);
  eq(fallback[2], 'active', `${label}: a client with an empty status is shown as Active, not blank`);
  eq(fallback[3], 'active', `${label}: a client with a null status is shown as Active, not blank`);
  eq(fallback[4], 'inactive', `${label}: a real status is left alone`);

  // P0-1 add a resource; first with nothing filled in, so the validation error has to be visible
  await go('resources'); await page.waitForSelector('button:has-text("+ Add resource")', { timeout: 10000 });
  await page.click('button:has-text("+ Add resource")'); await page.waitForSelector('.modal input[name=name]');
  await page.click('.modal button[type=submit]');
  const banner = await until(async () => { const b = await page.$('.modal .banner.danger:not(.hidden)'); return b ? (await b.textContent()) : null; }, { timeout: 5000 });
  ok(banner && /fill in/i.test(banner), `${label}: submitting the resource form with nothing filled in shows what is missing, inside the dialog`, banner);
  await page.fill('.modal input[name=name]', 'Riverbend Outpatient'); await page.selectOption('.modal select[name=category]', 'outpatient');
  await page.click('.modal button[type=submit]');
  await page.waitForURL(/#\/resource\//, { timeout: 10000 }).catch(() => {});
  ok(/#\/resource\//.test(page.url()), `${label}: a resource with a name and category saves and opens its profile`, page.url().split('#')[1]);
  ok(!(await page.$('.modal')), `${label}: the Add resource dialog closed after saving`);
  // ... and pictures can be added to it and are served back on the device
  await page.waitForSelector('input[type=file]', { timeout: 5000 }).catch(() => {});
  const fileInput = await page.$('input[type=file]');
  ok(!!fileInput, `${label}: the profile offers to add pictures`);
  if (fileInput) {
    await fileInput.setInputFiles(png);
    const shown = await until(async () => page.$$eval('.gallery img', i => i.filter(x => x.naturalWidth > 0).length), { timeout: 8000 });
    ok(shown > 0, `${label}: an uploaded picture is stored and displayed from the device's own database`, shown);
    const resUrl = page.url();
    await page.goto(resUrl.replace(/\?_=\d+$/, '') + '?_=' + Date.now()); await page.waitForSelector('.gallery', { timeout: 8000 }).catch(() => {});
    const again = await until(async () => page.$$eval('.gallery img', i => i.filter(x => x.naturalWidth > 0).length), { timeout: 8000 });
    ok(again > 0, `${label}: the picture is still reachable after reopening the profile`, again);
  }
  await go('resources'); await page.waitForSelector('.res-cards, .table-wrap', { timeout: 8000 }).catch(() => {});
  ok(/1 of 1 resources/.test((await page.textContent('#main')) || ''), `${label}: the directory counts the new resource`);

  // P0-2 every Settings tab on the device renders
  for (const tab of ['users', 'settings', 'caseload', 'audit']) {
    await go(`admin?tab=${tab}`);
    const text = await until(async () => { const t = (await page.textContent('#main')) || ''; return /Loading…/.test(t) ? null : t; }, { timeout: 10000 }) || '';
    ok(!/Something went wrong|Request failed/i.test(text), `${label}: Settings › ${tab} renders on the device`, text.replace(/\s+/g, ' ').slice(0, 120));
    if (tab === 'settings') ok(/Program settings/.test(text) && await page.$('input[name=org_name]'), `${label}: the Settings tab shows the programme settings form`);
  }
  // P3-2 the dialog title is not left behind in the accessibility tree once the dialog is gone
  const stray = await until(async () => !(await a11yHas(page, /add resource/i)), { timeout: 8000 });
  ok(stray, `${label}: no stray "Add resource" node remains in the accessibility tree on the Settings page`);

  // P2 and P1-1: with clients on the device, open a reminder, touch the client search, then use the date
  await page.evaluate(async () => { for (let i = 0; i < 6; i++) await window.SUDS_LOCAL.handle('POST', '/api/clients', { first_name: 'Test' + i, last_name: 'Client' + i }, { 'X-Requested-With': 'suds' }); });
  await go('tasks'); await page.waitForSelector('button:has-text("Add a reminder")', { timeout: 10000 });
  await page.click('button:has-text("Add a reminder")'); await page.waitForSelector('.modal input[name=title]');
  await page.click('.modal input[role=combobox]');
  await until(async () => page.$('.modal [role=listbox]:not(.hidden)'), { timeout: 5000 });
  const due = await page.$('.modal input[name=due_at]'); const box = await due.boundingBox();
  let clickable = false;
  try { await page.click('.modal input[name=due_at]', { position: { x: box.width - 10, y: box.height / 2 }, timeout: 4000 }); clickable = true; } catch (e) { fail(`${label}: the due date's picker button is still obscured: ${e.message.split('\n')[0]}`); }
  ok(clickable, `${label}: the due date's picker region can be clicked right after using the client search (no element intercepts it)`);
  ok(!(await page.$('.modal [role=listbox]:not(.hidden)')), `${label}: the client list closed when focus left it`);
  await page.fill('.modal input[name=title]', 'Bring ID to the appointment');
  await page.fill('.modal input[name=due_at]', '2031-10-01');
  await page.click('.modal button[type=submit]');
  await until(async () => !(await page.$('.modal')), { timeout: 8000 });
  ok(!(await page.$('.modal')), `${label}: a reminder with a date but no time saves`);
  const row = await until(async () => (await page.$$eval('tbody tr', tr => tr.map(x => x.textContent.replace(/\s+/g, ' ')))).find(t => /Bring ID to the appointment/.test(t)), { timeout: 8000 }) || '';
  ok(/Oct 1, 2031/.test(row), `${label}: the date-only due date was kept and is shown on the to-do list`, row.slice(0, 120));
  ok(!/12:00 AM/.test(row), `${label}: a date-only due date shows as a day, not as midnight`, row.slice(0, 120));
  // and an impossible date is refused rather than dropped
  await page.click('button:has-text("Add a reminder")'); await page.waitForSelector('.modal input[name=title]');
  await page.fill('.modal input[name=title]', 'Bad date');
  await page.evaluate(() => { const t = document.querySelector('.modal input[name=due_at_time]'); t.value = '09:30'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('.modal button[type=submit]');
  const dateErr = await until(async () => { const b = await page.$('.modal .banner.danger:not(.hidden)'); return b ? (await b.textContent()) : null; }, { timeout: 5000 });
  ok(dateErr && /date/i.test(dateErr), `${label}: a time without a date is refused with a visible message instead of being dropped`, dateErr);
  ok(await page.$('.modal'), `${label}: and the dialog stays open for it to be fixed`);
  await page.keyboard.press('Escape');
  await ctx.close();
}
finish(errors.slice(0, 8));
await browser.close();

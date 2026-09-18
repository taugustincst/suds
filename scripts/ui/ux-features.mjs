import { chromium, devices } from 'playwright';
import { makeChecks, until } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
import('node:fs').then(m => m.mkdirSync('/tmp/suds-shots', { recursive: true }));
const { ok, eq, finish } = makeChecks('ux-features');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push('CONSOLE ' + m.text()); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: null, theme: null }) })); await page.reload(); await page.waitForSelector('.layout');
await page.waitForTimeout(900); await page.screenshot({ path: '/tmp/suds-shots/ux_tour.png' });
ok(!!(await page.$('.modal')), 'tour shown');
for (let i = 0; i < 5; i++) { await page.click('.modal button.primary'); await page.waitForTimeout(150); }
ok(!(await page.$('.modal')), 'the tour closes and stays closed');
await page.waitForTimeout(500); await page.screenshot({ path: '/tmp/suds-shots/ux_dashboard.png' });
// global search
await page.fill('.gsearch input', 'nguyen'); await page.waitForTimeout(600);
const hits = await page.$$eval('.search-results a', a => a.length);
ok(hits > 0, 'global search finds a client by surname', hits);
await page.click('.search-results a'); await page.waitForTimeout(600);
ok(/#\/client\//.test(page.url()), 'clicking a search result opens that client', page.url());
// quick log → note with autosave
await page.click('.appbar .btn.quick'); await page.waitForTimeout(300); await page.click('.quick-list button:has-text("Note")'); await page.waitForSelector('.modal textarea[name=content]');
const cid = page.url().split('/client/')[1].split('/')[0];
await page.evaluate((id) => { const hid = document.querySelector('.modal input[name=client_id]'); hid.value = id; }, cid);
await page.fill('.modal textarea[name=content]', 'Autosave test from desktop.'); await page.waitForTimeout(3200);
// "Saving…" is the state on the way to "Saved": wait for it to land rather than reading mid-flight.
const st = await until(async () => {
  const t = await page.textContent('.modal .autosave');
  return /saved|draft/i.test(t || '') ? t : '';
}) || await page.textContent('.modal .autosave');
ok(/saved|draft/i.test(st || ''), 'a note in progress autosaves', st);
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
const drafts = await page.evaluate(() => fetch('/api/me/continue').then(r => r.json()));
ok(drafts.drafts.length > 0, 'the draft reached the server, so it survives closing the tab', drafts.drafts.length);
ok(drafts.recent.length > 0, 'recently opened clients are remembered', drafts.recent.length);
// help tip
await page.goto(base + '/#/interventions'); await page.waitForTimeout(600); await page.click('.help-btn'); await page.waitForTimeout(200);
ok(!(await page.$eval('.helptip', e => e.classList.contains('hidden'))), 'the help tip opens');
await page.screenshot({ path: '/tmp/suds-shots/ux_help.png' });
// new client form collapsible
await page.goto(base + '/#/clients'); await page.waitForTimeout(500); await page.click('text=+ New client'); await page.waitForSelector('.modal');
const sections = await page.$$eval('.modal details.section', d => d.map(x => x.open));
ok(sections.length > 0 && sections.some(o => !o), 'the client form keeps the optional sections collapsed', sections); await page.screenshot({ path: '/tmp/suds-shots/ux_client_form.png' }); await page.keyboard.press('Escape');
// theme pref synced
await page.click('text=Light/dark'); await page.waitForTimeout(1200);
const prefs = await page.evaluate(() => fetch('/api/me/prefs').then(r => r.json()));
ok(prefs.prefs && prefs.prefs.theme, 'the theme choice is saved to the account, not just this browser', prefs.prefs);
await page.click('text=Light/dark'); await page.waitForTimeout(1000);
// mobile
const m = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage(); m.on('pageerror', e => errors.push('M PAGEERROR ' + e.message));
await m.goto(base + '/#/login'); await m.fill('input[name=username]', 'mrivera'); await m.fill('input[name=password]', 'Navigator2026!!'); await m.click('button[type=submit]'); await m.waitForSelector('.layout'); await m.waitForTimeout(800);
ok(!(await m.$('.modal')), 'the tour does not run again on a second device — it is per person, not per browser');
await m.screenshot({ path: '/tmp/suds-shots/ux_m_home.png' });
await m.click('.fab button'); await m.waitForTimeout(300); await m.screenshot({ path: '/tmp/suds-shots/ux_m_quick.png' }); ok(!!(await m.$('.quick-list')), 'fab opens quick list');
// ---- keyboard and screen reader ----
// Clickable rows and the client picker were mouse-only, and modals let Tab escape into the page behind.
await page.goto(base + '/#/clients'); await page.waitForTimeout(800);
const firstRow = await page.$('tbody tr');
ok(firstRow && await firstRow.getAttribute('tabindex') === '0', 'a clickable table row can be reached with the keyboard');
ok(firstRow && await firstRow.getAttribute('role') === 'button', 'and is announced as something that can be activated');
await firstRow.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(700);
ok(/#\/client\//.test(page.url()), 'pressing Enter on a row opens it', page.url());

await page.goto(base + '/#/interventions'); await page.waitForTimeout(600);
await page.click('text=+ Log a visit or service'); await page.waitForSelector('.modal');
ok(await page.$eval('.modal', el => el.getAttribute('aria-modal') === 'true' && !!el.getAttribute('aria-labelledby')), 'a dialog is announced with its title');
// Tab all the way round; focus must stay inside the dialog.
for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
ok(await page.evaluate(() => !!document.querySelector('.modal')?.contains(document.activeElement)), 'Tab stays inside the dialog');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
ok(!(await page.$('.modal')), 'Escape closes the dialog');

// The client picker is a combobox: type, arrow down, Enter.
await page.click('text=+ Log a visit or service'); await page.waitForSelector('.modal');
const picker = await page.$('.modal [role=combobox]');
ok(picker, 'the client picker is a combobox');
if (picker) {
  // Type the first three letters of a client this user actually has, rather than a name that may not be
  // on their caseload — the point is that a partial surname finds them.
  const surname = await page.evaluate(() => fetch('/api/clients?limit=1').then(r => r.json()).then(d => (d.clients[0]?.display_name || '').split(',')[0].trim()));
  await picker.fill(surname.slice(0, 3).toLowerCase()); await page.waitForTimeout(900);
  ok(await page.$eval('.modal [role=combobox]', el => el.getAttribute('aria-expanded') === 'true'), 'typing opens the list of matches');
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150);
  ok(await page.$('.modal .list-item.active'), 'arrow keys move through the matches');
  await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  ok(await page.$eval('.modal input[name=client_id]', el => !!el.value), 'Enter picks the highlighted client');
}
await page.keyboard.press('Escape');

// A validation failure has to be announced, not just outlined in red.
ok(await page.$('[aria-live]'), 'the page has a live region for status messages');

finish(errors);
await browser.close();

import { chromium } from 'playwright';
import { makeChecks, until } from './assert.mjs';
async function dismissTour(p) { await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await p.waitForTimeout(700); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); }
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const { ok, finish } = makeChecks('desktop');
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
let loggedIn = false;
page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push('CONSOLE: ' + m.text()); });
page.on('response', r => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = async (name) => page.screenshot({ path: `/tmp/suds-shots/${name}.png`, fullPage: false });
// "Has it finished loading?" is a question about a few seconds, not about one instant: a slower machine
// answers no at 600ms and yes at 900ms. Wait for the placeholder to go, then assert on what is left.
const loaded = async () => { await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); return !(await page.$('.main .boot')); };
await page.goto(base + '/#/login');
await page.fill('input[name=username]', 'jwalker'); await page.fill('input[name=password]', 'Navigator2026!!');
await page.click('button[type=submit]');
await page.waitForSelector('.layout', { timeout: 8000 }); loggedIn = true; await dismissTour(page);
await shot('dashboard');
const views = ['clients', 'tasks', 'interventions', 'calls', 'time', 'referrals', 'resources', 'notes', 'imports', 'budget', 'reports', 'admin', 'profile', 'admin?tab=audit', 'admin?tab=settings', 'admin?tab=apikeys', 'admin?tab=system', 'budget?tab=expenditures', 'budget?tab=analysis'];
for (const v of views) {
  await page.goto(`${base}/#/${v}`); await page.waitForTimeout(700);
  ok(await loaded(), `${v} finishes loading`);
  const stuckModal = await page.$('.modal-bg');
  ok(!stuckModal, `${v} leaves no dialog open behind it`);
  if (stuckModal) await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  await shot(v.replace(/[?=]/g, '_'));
}
// client detail tabs
await page.goto(base + '/#/clients'); await page.waitForTimeout(600);
await page.waitForSelector('tbody tr.click', { timeout: 15000 }); await page.click('tbody tr.click');
await page.waitForTimeout(700);
const cid = page.url().split('/client/')[1];
ok(!!cid, 'a row in the client list opens that client');
for (const t of ['overview', 'timeline', 'interventions', 'calls', 'notes', 'referrals', 'tasks', 'consents', 'time', 'budget', 'team']) {
  await page.goto(`${base}/#/client/${cid}/${t}`); await page.waitForTimeout(600);
  ok(await loaded(), `the client's ${t} tab finishes loading`);
  await shot('client_' + t);
}
// open modals
await page.goto(`${base}/#/client/${cid}/overview`); await page.waitForTimeout(500);
await page.click('text=+ Intervention'); await page.waitForTimeout(300); ok(await page.$('.modal'), 'the intervention form opens'); await shot('modal_intervention'); await page.keyboard.press('Escape');
await page.click('text=+ Note'); await page.waitForTimeout(300); await page.selectOption('select[name=format]', 'SOAP'); await page.waitForTimeout(200); ok(await page.$('.modal textarea, .modal input'), 'the note form opens and takes a format'); await shot('modal_note'); await page.keyboard.press('Escape');
await page.click('text=Edit'); await page.waitForTimeout(300); ok(await page.$('.modal'), 'the client edit form opens'); await shot('modal_client_edit'); await page.keyboard.press('Escape');
// open a note
await page.goto(`${base}/#/client/${cid}/notes`); await page.waitForTimeout(600); await page.waitForSelector('tbody tr.click', { timeout: 15000 }); await page.click('tbody tr.click'); await page.waitForTimeout(500);
ok(await page.$('.modal'), 'a note opens from the list'); await shot('note_view'); await page.keyboard.press('Escape');
// imports: paste
await page.goto(base + '/#/imports'); await page.waitForTimeout(500);
await page.fill('textarea', '# Field visit with Nguyen, Jamie\nDate: 2026-09-10\nMet at shelter, provided naloxone.\n\n---\n\n# Call re: C26-0002\nLeft voicemail.');
await page.click('text=Stage pasted text'); await page.waitForTimeout(800); await shot('import_review');
ok(await until(() => /#\/imports\/.+/.test(page.url())), 'pasted field notes are staged and opened for review', page.url());
finish(errors);
await browser.close();

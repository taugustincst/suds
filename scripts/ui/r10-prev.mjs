// 1.17.0 "Prevention and syringe services", in a browser:
//   Prevention page: a navigator records a training event (CSAP strategy, IOM category, attendance, hours); another
//   navigator opens it read-only; a supervisor edits it and is told it is another worker's; the activity summary
//   counts the people trained and says it is not a PPSDS file, and exports; read-only staff see the summary alone.
//   Participant code: the visit form offers it only for a contact that may have no client, and not with a client;
//   the saved code comes back normalised; the SSP report counts anonymous participants and says how.
// Every page and dialog it opens is checked with axe (WCAG 2.1 A/AA), at desktop and phone width.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('r10-prev');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
const PHONE = [{ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }];

async function session(username, password = PW, viewport = { width: 1280, height: 900 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); const ct = r.headers.get('content-type') || ''; return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text(), disposition: r.headers.get('content-disposition') }; }, { method, path, body });
  await api('PUT', '/api/me/prefs', { tour_done: true });
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
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const tag = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const today = new Date().toISOString().slice(0, 10);
const title = `Naloxone training ${tag}`;

try {
  // ------------------------------------------------------------------ a navigator records a training event
  const maria = await session('mrivera');
  await maria.go('prevention');
  eq((await maria.page.textContent('.main h1')).trim(), 'Prevention', 'the Prevention page opens');
  ok(await maria.page.$('[data-prevention-events]'), 'on its list of events');
  await axe(maria.page, 'the Prevention page');
  await maria.page.click('[data-new-prevention]');
  await maria.page.waitForSelector('.modal form');
  eq(await maria.page.textContent('.modal h2'), 'Record a prevention event', 'the form opens');
  await axe(maria.page, 'the prevention event form');
  await maria.page.fill('.modal input[name=title]', title);
  await maria.page.selectOption('.modal select[name=event_type]', 'training');
  await maria.page.selectOption('.modal select[name=strategy]', 'education');
  await maria.page.selectOption('.modal select[name=iom_category]', 'selective');
  await maria.page.selectOption('.modal select[name=audience]', 'first_responders');
  await maria.page.fill('.modal input[name=attendance]', '18');
  await maria.page.fill('.modal input[name=hours]', '2.5');
  await maria.page.fill('.modal input[name=location]', 'Fire station 4');
  await maria.page.click('.modal button[type=submit]');
  ok(await toastText(maria.page, /Event recorded: Naloxone training .* \(18 trained\)/), 'the toast says it was recorded, with the people trained');
  await settle(maria.page);
  ok(await until(async () => (await maria.page.textContent('[data-prevention-events]')).includes(title)), 'and it is on the list');
  const list = await maria.api('GET', `/api/prevention-events?from=${today}&to=${today}`);
  const ev = list.data.rows.find(x => x.title === title);
  ok(ev && ev.strategy === 'education' && ev.iom_category === 'selective' && ev.attendance === 18 && ev.hours === 2.5 && ev.audience === 'first_responders', 'saved with its strategy, IOM category, attendance, hours and audience');
  await maria.ctx.close();

  // ------------------------------------------------------------------ another navigator reads it; cannot change it
  const david = await session('dchen');
  await david.go(`prevention?from=${today}&to=${today}`);
  await david.page.click(`[data-prevention-events] tbody tr:has-text("${title}")`);
  await david.page.waitForSelector('.modal [data-prevention-view]');
  ok(/Only they or a supervisor or administrator can change it/.test(await david.page.textContent('.modal')), 'another navigator sees it read-only, and whose it is');
  ok(!(await david.page.$('.modal form')), 'with no form to change it');
  await axe(david.page, 'a prevention event opened read-only');
  await david.ctx.close();

  // ------------------------------------------------------------------ a supervisor edits it; the summary
  const jw = await session('jwalker');
  await jw.go(`prevention?from=${today}&to=${today}`);
  await jw.page.click(`[data-prevention-events] tbody tr:has-text("${title}")`);
  await jw.page.waitForSelector('.modal form');
  ok(await jw.page.$('.modal [data-others-record]'), 'a supervisor editing it is told it is another worker\'s');
  await jw.page.fill('.modal input[name=attendance]', '20');
  await jw.page.click('.modal button[type=submit]');
  ok(await toastText(jw.page, /Event updated/), 'and saves the change');
  await jw.go(`prevention?tab=summary&from=${today}&to=${today}`);
  ok(await jw.page.$('[data-prevention-summary]'), 'the activity summary opens');
  const trained = await jw.page.$$eval('.stat', els => { const s = els.find(e => /People trained/.test(e.textContent)); return s ? s.textContent : null; });
  ok(trained && /20/.test(trained), `People trained counts the training's attendance (${trained})`);
  ok(/not a PPSDS submission file/.test(await jw.page.textContent('[data-ppsds-note]')), 'and it says it is not a PPSDS file');
  ok(/Education/.test(await jw.page.textContent('[data-by-strategy]')) && /Selective/.test(await jw.page.textContent('[data-by-iom]')), 'totals by CSAP strategy and by IOM category');
  ok(await jw.page.$('[data-prevention-export="xlsx"]') && await jw.page.$('[data-prevention-export="csv"]'), 'with Excel and CSV exports');
  const csv = await jw.api('GET', `/api/reports/prevention/export?from=${today}&to=${today}`);
  ok(csv.status === 200 && /prevention-activity-summary/.test(csv.disposition || '') && /People trained,20/.test(csv.data), 'the CSV is the prevention activity summary, with the people trained');
  await axe(jw.page, 'the prevention activity summary');
  await jw.ctx.close();

  // ------------------------------------------------------------------ read-only staff: the summary alone
  const rr = await session('rreader');
  await rr.go('prevention');
  ok(await rr.page.$('[data-prevention-summary]'), 'read-only staff open the prevention page on its summary');
  ok(!(await rr.page.$('[data-new-prevention]')) && !(await rr.page.$('[data-prevention-events]')), 'with no events list and nothing to record');
  await rr.ctx.close();

  // ------------------------------------------------------------------ participant code on an anonymous contact (phone)
  const mp = await session('mrivera', PW, ...PHONE);
  await mp.go('prevention');
  ok(await noSideScroll(mp.page), 'the Prevention page fits a phone without sideways scrolling');
  await axe(mp.page, 'the Prevention page on a phone');
  await mp.go('interventions');
  await mp.page.evaluate(async () => { await (await import('./views/interventions.js')).openInterventionForm(null, {}); });
  await mp.page.waitForSelector('.modal form');
  const codeHidden = () => mp.page.$eval('.modal [data-field="participant_code"]', el => el.hidden);
  await mp.page.selectOption('.modal select[name=type]', 'case_management');
  ok(await codeHidden(), 'the participant code is not offered for a service that needs a client');
  await mp.page.selectOption('.modal select[name=type]', 'outreach');
  ok(!(await codeHidden()), 'it is offered for outreach, which may have no client');
  await axe(mp.page, 'the visit form with the participant code on a phone');
  await mp.page.fill('.modal input[name=participant_code]', `m${tag.slice(0, 1)}-07 85`);
  await mp.page.click('.modal button[type=submit]');
  ok(await toastText(mp.page, /Visit logged/), 'an anonymous outreach contact is saved with its code');
  const visits = await mp.api('GET', '/api/interventions?type=outreach&mine=1&limit=5');
  const coded = visits.data.rows.find(x => !x.client_id && x.participant_code);
  eq(coded && coded.participant_code, `M${tag.slice(0, 1).toUpperCase()}0785`, 'the code is kept in the program\'s form (upper case, letters and digits)');
  await mp.ctx.close();

  // ------------------------------------------------------------------ the SSP report counts anonymous participants
  const js = await session('jwalker');
  await js.go('ssp');
  ok(await js.page.$('[data-ssp-report]'), 'the SSP report opens');
  ok(/Anonymous participants \(codes\)/.test(await js.page.textContent('[data-ssp-report]')), 'it shows the anonymous participants counted from codes');
  ok(/not added together/.test(await js.page.textContent('[data-participant-code-note]')), 'and says they are not added to the clients served');
  await axe(js.page, 'the SSP report with anonymous participants');
  await js.ctx.close();
} catch (e) {
  fail(`crashed: ${e.stack || e.message}`);
}
await browser.close();
eq(errors.length, 0, `no page errors, console errors or 5xx${errors.length ? ': ' + errors.join(' / ') : ''}`);
finish();

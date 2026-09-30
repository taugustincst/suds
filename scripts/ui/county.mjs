// The county view (docs/COUNTY-VIEW.md), in the browser:
//   1. A programme's finance lead makes the county file from Settlement outcomes (a download): signed, aggregate
//      only, the key's fingerprint on the page is the file's; the card says the file leaves the program and holds
//      exact counts. On SUDS on this device the card and the County view entry are not offered.
//   2. The county's administrator registers programmes (the key's fingerprint shown to compare; the dialog is
//      keyboard-operable and gives focus back), imports their files (the outcome is announced and takes the focus;
//      a tampered file is refused the same way) and sees the combined view: per programme and the total, who has
//      not submitted, the caveats; and downloads it, labelled internal and exact.
//   3. Finance sees the County view once programmes are registered and cannot register one; read-only never.
//   4. axe (WCAG 2.1 A/AA) on the three county pages, the programme dialog and the settlement card at 1280 and 390 px.
// The fictional programmes' keys and files come from scripts/county-sample.js (the dev server stays a programme's).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeChecks, until, settle } from './assert.mjs';

const require = createRequire(import.meta.url);
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('county');
let axeSource = null;
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* reported below */ }
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const STRUCTURE = ['landmark-one-main', 'landmark-no-duplicate-main', 'landmark-unique', 'page-has-heading-one', 'heading-order', 'empty-heading', 'aria-dialog-name', 'empty-table-header'];

// The sample programmes, written by the sample script in a process of its own (it loads SUDS's modules as the tests do).
const tmp = fs.mkdtempSync(path.join(process.env.SUDS_UI_TMP || os.tmpdir(), 'suds-county-'));
execFileSync(process.execPath, ['--no-warnings', path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'county-sample.js'), tmp], { stdio: 'ignore' });
const programmes = JSON.parse(fs.readFileSync(path.join(tmp, 'programmes.json'), 'utf8'));
const filesOf = (slug) => fs.readdirSync(tmp).filter(f => f.startsWith(`${slug}-`)).sort().map(f => path.join(tmp, f));
const [riverbend, eastside, hillview] = programmes;
const slugs = ['riverbend', 'eastside', 'hillview'];

const today = new Date().toISOString().slice(0, 10);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const lq = (() => { let y = Number(today.slice(0, 4)); let q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) - 1; if (q < 0) { q = 3; y--; } const m1 = q * 3 + 1; return { from: `${y}-${String(m1).padStart(2, '0')}-01`, to: lastDay(y, m1 + 2) }; })();

const browser = await chromium.launch();
const errors = [];
function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0-9]|42[0-9]/.test(m.text())) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
}
async function signIn(user, pw, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true }); const page = await ctx.newPage(); watch(page, user);
  await page.goto(base + '/#/login'); await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true, first_day_skip: true }) })); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  return { ctx, page };
}
const api = (page, method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, [method, p, body]);
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
const toast = (page, re) => until(async () => { const t = await page.$$eval('.toast', e => e.map(x => x.textContent)); return t.find(x => re.test(x)) || null; });
async function axe(page, where) {
  if (!axeSource) { fail(`${where}: axe-core is not installed (npm i --no-save playwright axe-core)`); return; }
  await page.evaluate(axeSource + ';0').catch(() => {});
  const v = await page.evaluate(async ({ tags, extra }) => {
    const rules = [...new Set([...window.axe.getRules(tags).map(r => r.ruleId), ...extra])];
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  }, { tags: TAGS, extra: STRUCTURE });
  ok(v.length === 0, `${where}: no WCAG 2.1 A/AA violations`, v);
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

try {
  // ---------------- 1. the programme's side: Send to the county ----------------
  const { ctx: finCtx, page: fin } = await signIn('afinance', PW);
  await go(fin, `settlement?from=${lq.from}&to=${lq.to}`);
  ok(await fin.$('[data-so-county]'), 'Settlement outcomes has a Send to the county card for finance');
  ok(/leaves the program/i.test(await fin.textContent('[data-so-county-leaves]')), 'it says the file leaves the program');
  ok(/not for publication/i.test(await fin.textContent('[data-so-county]')) && /exact counts/i.test(await fin.textContent('[data-so-county]')), 'and that it holds exact counts, not for publication');
  ok(/no names, client codes, dates of birth/i.test(await fin.textContent('[data-so-county]')), 'and that it names no one');
  const [dl] = await Promise.all([fin.waitForEvent('download'), fin.click('[data-so-county-file]')]);
  eq(dl.suggestedFilename(), `suds-county-submission-${lq.from}_${lq.to}.json`, 'Make the county file downloads the period\'s file');
  const ownPath = path.join(tmp, 'own.json'); await dl.saveAs(ownPath);
  const ownText = fs.readFileSync(ownPath, 'utf8'); const own = JSON.parse(ownText);
  eq(own.format, 'suds-county-submission', 'the file is a county submission');
  ok(await toast(fin, /County file made/), 'a message says it was made and where it goes');
  const fp = (await until(() => fin.$('[data-so-county-fingerprint]')) && (await fin.textContent('[data-so-county-fingerprint]')).trim());
  eq(fp.replace(/\s/g, ''), own.signature.key_fingerprint, 'the fingerprint on the page is the file\'s key');
  await fin.click('[data-so-county-key] details > summary');
  const pem = (await fin.textContent('[data-so-county-pem]')).trim();
  ok(/^-----BEGIN PUBLIC KEY-----/.test(pem), 'the public key is on the page to give the county');
  const allowed = new Set(['counts', 'funds', 'categories', 'generated_at', 'period', 'programme', 'schema_version', 'suds_version', 'total', 'from', 'to', 'category', 'grant_number', 'hiaa', 'name', 'spend', 'values',
    'approved', 'other_categories', 'own_category', 'pending', 'key', 'spend_own_category', 'contacts', 'naloxone_kits', 'fentanyl_strips', 'syringes', 'reversals', 'treatment_admissions', 'education_contacts',
    'staff_training_hours', 'referrals_made', 'people_served', 'people_linked', 'moud_linked', 'people_trained']);
  const keys = new Set(); const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } }; walk(own.payload);
  eq([...keys].filter(k => !allowed.has(k)).join(','), '', 'every field in the file is an aggregate one on the allow-list');
  await axe(fin, 'settlement with Send to the county (1280)');
  // SUDS on this device offers neither (the same page and navigation, told they are on a device).
  const onDevice = await fin.evaluate(async () => { const a = await import('./app.js'); a.state.local = true; const n = a.NAV.find(x => x.name === 'county'); const placed = a.navPlacement(n); a.state.local = false; return placed; });
  eq(onDevice, null, 'on SUDS on this device there is no County view entry');
  await fin.evaluate(async () => { const a = await import('./app.js'); a.state.local = true; await a.render(); });
  await settle(fin);
  ok(await fin.$('[data-settlement-outcomes]') && !(await fin.$('[data-so-county]')), 'and Settlement outcomes offers no Send to the county');
  await fin.evaluate(async () => { const a = await import('./app.js'); a.state.local = false; });
  const finNav0 = await fin.$$eval('.sidebar a', as => as.map(a => a.getAttribute('href')));
  ok(!finNav0.includes('#/county'), 'before any programme is registered, finance has no County view entry');

  // ---------------- 2. the county's side ----------------
  const { ctx: admCtx, page: adm } = await signIn('admin', 'AdminPassw0rd!x');
  await go(adm, 'county');
  eq((await adm.textContent('.main h1')).trim(), 'County view', 'an administrator reaches the County view');
  ok(await adm.$('.empty-state'), 'with nothing registered it says what to do first');
  await go(adm, 'county?tab=programmes');
  // Register the first programme with the keyboard: the dialog opens on its first field, the key's fingerprint
  // shows once it is pasted, and Escape gives the focus back.
  await adm.focus('[data-cp-add]'); await adm.keyboard.press('Enter');
  await adm.waitForSelector('.modal-bg .modal');
  eq(await adm.evaluate(() => document.activeElement && document.activeElement.name), 'name', 'the dialog opens with the focus on the programme name');
  await adm.keyboard.press('Escape');
  await until(async () => !(await adm.$('.modal-bg')));
  eq(await adm.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-cp-add')), '1', 'Escape closes it and gives the focus back to Register a programme');
  await adm.click('[data-cp-add]'); await adm.waitForSelector('.modal-bg .modal');
  await axe(adm, 'Register a programme dialog (1280)');
  await adm.fill('.modal [name=name]', riverbend.name);
  await adm.fill('.modal [name=public_key]', riverbend.public_key);
  await adm.focus('.modal [name=fingerprint]');
  const computed = await until(async () => { const t = await adm.textContent('[data-cp-computed]'); return t.includes(riverbend.fingerprint) ? t : null; });
  ok(computed, 'the key\'s fingerprint shows once it is pasted, to compare with the one read out', await adm.textContent('[data-cp-computed]'));
  await adm.fill('.modal [name=fingerprint]', '0000 1111 2222 3333 4444 5555 6666 7777');
  await adm.click('.modal button[type=submit]');
  const fpErr = await until(async () => { const t = await adm.$eval('.modal [data-field=fingerprint] .err', e => e.textContent).catch(() => ''); return t || null; });
  ok(/does not match/.test(fpErr || ''), 'a fingerprint that does not match the key is refused at the field', fpErr);
  eq(await adm.evaluate(() => document.activeElement && document.activeElement.name), 'fingerprint', 'and the focus goes to it');
  await adm.fill('.modal [name=fingerprint]', riverbend.fingerprint);
  await adm.click('.modal button[type=submit]');
  ok(await toast(adm, new RegExp(`Registered ${riverbend.name}`)), 'the programme is registered');
  await settle(adm);
  ok((await adm.textContent('[data-cp-list]')).includes(riverbend.name), 'and listed with its fingerprint');
  for (const p of [eastside, hillview]) eq((await api(adm, 'POST', '/api/county/programmes', { name: p.name, public_key: p.public_key })).status, 201, `${p.name} registered`);
  eq((await api(adm, 'POST', '/api/county/programmes', { name: 'Our own programme', public_key: pem })).status, 201, 'the programme above is registered with the key it showed');

  // Import through the page: the outcome is said where the person is.
  await go(adm, 'county?tab=submissions');
  await axe(adm, 'county submissions (1280)');
  const importFile = async (file) => {
    await adm.setInputFiles('#cs-file', file);
    await adm.click('[data-cs-import]');
    return until(async () => { const o = await adm.getAttribute('[data-cs-result]', 'data-cs-outcome'); return o ? { outcome: o, role: await adm.getAttribute('[data-cs-result]', 'role'), text: await adm.textContent('[data-cs-result]'), focused: await adm.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-cs-result')) } : null; });
  };
  const rb = filesOf('riverbend');
  let r = await importFile(rb[rb.length - 1]);
  eq(r.outcome, 'ok', 'a signed file imports'); eq(r.role, 'status', 'and the outcome is a status message');
  ok(r.focused, 'which takes the focus'); ok(new RegExp(`Imported ${riverbend.name}`).test(r.text), 'naming the programme and period', r.text);
  ok(await until(async () => (await adm.textContent('[data-cs-list]')).includes(riverbend.name)), 'the file is listed');
  const tampered = JSON.parse(fs.readFileSync(filesOf('eastside')[1], 'utf8')); tampered.payload.total.values.naloxone_kits += 5;
  const tamperedPath = path.join(tmp, 'tampered.json'); fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  await adm.evaluate(() => { const e = document.querySelector('[data-cs-result]'); e.removeAttribute('data-cs-outcome'); });
  r = await importFile(tamperedPath);
  eq(r.outcome, 'refused', 'a file changed after it was signed is refused'); eq(r.role, 'alert', 'as an alert');
  ok(r.focused, 'which takes the focus'); ok(/Not imported\. The signature does not match/.test(r.text), 'saying why', r.text);
  await adm.evaluate(() => { const e = document.querySelector('[data-cs-result]'); e.removeAttribute('data-cs-outcome'); });
  r = await importFile(filesOf('eastside')[1]);
  eq(r.outcome, 'ok', 'the programme\'s own, unchanged file imports');
  // Hillview sent only the older quarter; our own programme's file is for the last quarter.
  eq((await api(adm, 'POST', '/api/county/submissions', { text: fs.readFileSync(filesOf('hillview')[0], 'utf8') })).status, 201, 'Hillview\'s earlier quarter imports');
  eq((await api(adm, 'POST', '/api/county/submissions', { text: ownText })).status, 201, 'the programme\'s own file imports');

  // The combined view for the last quarter.
  await go(adm, `county?from=${lq.from}&to=${lq.to}`);
  const who = await adm.textContent('[data-cv-who]');
  ok(/3 of 4 programmes submitted; 1 did not/.test(who), 'who has submitted: three of four', who);
  const hvRow = await adm.$$eval('[data-cv-who] tbody tr', (trs, n) => { const tr = trs.find(t => t.textContent.includes(n)); return tr ? tr.textContent : ''; }, hillview.name);
  ok(/Not submitted/.test(hvRow), 'Hillview is shown as not submitted for the quarter', hvRow);
  const want = [JSON.parse(fs.readFileSync(rb[rb.length - 1], 'utf8')), JSON.parse(fs.readFileSync(filesOf('eastside')[1], 'utf8')), own].reduce((n, f) => n + f.payload.total.values.naloxone_kits, 0);
  const kitsRow = await adm.$$eval('[data-cv-group=outcome] tbody tr', (trs) => { const tr = trs.find(t => /^Naloxone kits distributed/.test(t.cells[0].textContent)); return tr ? tr.cells[tr.cells.length - 1].textContent : ''; });
  eq(Number(kitsRow.replace(/[^\d.]/g, '')), want, 'the total naloxone kits is the three files\' sum');
  ok(/not unduplicated/i.test(await adm.textContent('[data-cv-caveats]')), 'the caveat says people are not unduplicated across programmes');
  ok(/publication screen over the combined release \(planned\)/.test(await adm.textContent('[data-cv-publication]')), 'and that publishing needs the publication screen (planned)');
  const [cv] = await Promise.all([adm.waitForEvent('download'), adm.click('[data-cv-export=csv]')]);
  eq(cv.suggestedFilename(), `suds-county-view-${lq.from}_${lq.to}-internal-exact.csv`, 'the combined view downloads as a file labelled internal and exact');
  await axe(adm, 'county combined view (1280)');
  await go(adm, 'county?tab=programmes'); await axe(adm, 'county programmes (1280)');
  // A period that ends before it starts is said at the dates.
  await go(adm, `county?from=${lq.from}&to=${lq.to}`);
  await adm.fill('#cv-from', lq.to); await adm.fill('#cv-to', lq.from); await adm.click('[data-cv-apply]');
  ok(/after the end date/.test(await adm.textContent('#cv-range-err')), 'a backwards period is refused at the dates');

  // Phone width.
  const { ctx: phCtx, page: ph } = await signIn('admin', 'AdminPassw0rd!x', { width: 390, height: 844 });
  for (const hash of [`county?from=${lq.from}&to=${lq.to}`, 'county?tab=submissions', 'county?tab=programmes']) {
    await go(ph, hash); await axe(ph, `${hash.split('&')[0]} (390)`); ok(await noSideScroll(ph), `${hash.split('&')[0]}: nothing scrolls sideways at 390 px`);
  }
  await go(ph, 'county?tab=programmes'); await ph.click('[data-cp-add]'); await ph.waitForSelector('.modal-bg .modal'); await axe(ph, 'Register a programme dialog (390)');
  const { ctx: finPh, page: fph } = await signIn('afinance', PW, { width: 390, height: 844 });
  await go(fph, `settlement?from=${lq.from}&to=${lq.to}`); await axe(fph, 'settlement with Send to the county (390)');
  await phCtx.close(); await finPh.close();

  // ---------------- 3. finance and read-only ----------------
  await fin.goto(base + '/'); await fin.reload(); await settle(fin);
  const finNav = await fin.$$eval('.sidebar a', as => as.map(a => a.getAttribute('href')));
  ok(finNav.includes('#/county'), 'once programmes are registered, finance has the County view entry');
  await go(fin, `county?from=${lq.from}&to=${lq.to}`);
  ok(await fin.$('[data-cv-who]'), 'and sees the combined view');
  await go(fin, 'county?tab=programmes');
  ok(!(await fin.$('[data-cp-add]')), 'but cannot register a programme');
  await go(fin, 'county?tab=submissions');
  ok(!(await fin.$('[data-cs-importer]')), 'nor import a file');
  await finCtx.close();
  const { ctx: roCtx, page: ro } = await signIn('rreader', PW);
  const roNav = await ro.$$eval('.sidebar a', as => as.map(a => a.getAttribute('href')));
  ok(!roNav.includes('#/county'), 'read-only has no County view entry');
  eq((await api(ro, 'GET', `/api/county/view?from=${lq.from}&to=${lq.to}`)).status, 403, 'and the server refuses it the view');
  await roCtx.close(); await admCtx.close();
} catch (e) {
  fail(`the script stopped: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
finish(errors);
await browser.close();

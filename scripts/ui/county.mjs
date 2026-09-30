// The county view (docs/COUNTY-VIEW.md), in the browser:
//   1. A program's finance lead on Settlement outcomes › Send to the county: shows the key without making a file
//      (fingerprint and public key, each with a Copy button; the key wraps at 320 px), types the county's code and
//      name, ticks the fund the county pays for (nothing is ticked until they do), keeps the default period (the last
//      complete quarter, shown beside the button; a period that is not a quarter is warned about) and makes the
//      file: signed, aggregate only, named after the program, the key's fingerprint on the page is the file's. Make a
//      new key retires the old one and shows the new fingerprint to read out. On SUDS on this device the card and
//      the County view entry are not offered.
//   2. The county's administrator: the county code on Programs; registers programs (the fingerprint shown as the
//      key is typed; neither typed nor compared is refused at the field; the dialog is keyboard-operable and gives
//      focus back), imports their files (the outcome is announced and takes the focus; a tampered file is refused
//      the same way) and sees the combined view: the headline (whole, part, not at all), per program and the total
//      "N of M complete", "— not submitted" in words, never "unduplicated", the caveats folded behind a one-line
//      summary; the presets and Enter apply a period; by quarter; downloads (Excel, CSV, tidy CSV). Submissions:
//      Current / Replaced / Withdrawn, Withdraw (with a reason) only on a current file, the focus to the list's
//      heading, Reinstate.
//   3. Finance sees the County view once programs are registered and cannot register one; read-only never.
//   4. axe (WCAG 2.1 A/AA) on the county pages, the dialogs and the settlement card at 1280 and 390 px; nothing
//      sideways at 390 px, and the settlement card with its key open at 320 px.
// The fictional programs' keys and files come from scripts/county-sample.js (the dev server stays a program's).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeChecks, until, settle } from './assert.mjs';

const require = createRequire(import.meta.url);
const { lastQuarters } = require('../county-sample.js');
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('county');
let axeSource = null;
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* reported below */ }
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const STRUCTURE = ['landmark-one-main', 'landmark-no-duplicate-main', 'landmark-unique', 'page-has-heading-one', 'heading-order', 'empty-heading', 'aria-dialog-name', 'empty-table-header'];

const localToday = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
const [lq] = lastQuarters(localToday, 1);

const browser = await chromium.launch();
const errors = [];
function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0-9]|42[0-9]/.test(m.text())) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
}
async function signIn(user, pw, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true }); const page = await ctx.newPage(); watch(page, user);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
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
const mainText = (page) => page.evaluate(() => document.querySelector('.main').innerText);

const tmp = fs.mkdtempSync(path.join(process.env.SUDS_UI_TMP || os.tmpdir(), 'suds-county-'));
try {
  // ---------------- 1. the program's side: Send to the county ----------------
  const { ctx: finCtx, page: fin } = await signIn('afinance', PW);
  // The county code this server gives out (it plays the county below too).
  const code = await api(fin, 'GET', '/api/county/code');
  eq(code.status, 200, 'the county code is there for whoever sees the county view');
  // The sample programs' files, made for this county by the sample script in a process of its own.
  execFileSync(process.execPath, ['--no-warnings', path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'county-sample.js'), tmp, '--county-code', code.data.code_display], { stdio: 'ignore' });
  const programmes = JSON.parse(fs.readFileSync(path.join(tmp, 'programmes.json'), 'utf8'));
  const filesOf = (slug) => fs.readdirSync(tmp).filter(f => f.startsWith(`${slug}-`)).sort().map(f => path.join(tmp, f));
  const [riverbend, eastside, hillview] = programmes;

  await go(fin, 'settlement');
  ok(await until(() => fin.$('[data-so-county-form]')), 'Settlement outcomes has a Send to the county card for finance');
  ok(/leaves the program/i.test(await fin.textContent('[data-so-county-leaves]')), 'it says the file leaves the program');
  ok(/not for publication/i.test(await fin.textContent('[data-so-county]')) && /exact counts/i.test(await fin.textContent('[data-so-county]')), 'and that it holds exact counts, not for publication');
  ok(/no names, client codes, dates of birth/i.test(await fin.textContent('[data-so-county]')), 'and that it names no one');
  // U8: the key, shown without making a file.
  ok(await fin.$('[data-so-county-show-key]'), 'with no key yet, the card offers to show it');
  await fin.click('[data-so-county-show-key]');
  const fp0 = await until(async () => { const e = await fin.$('[data-so-county-fingerprint]'); return e ? (await e.textContent()).trim() : null; });
  ok(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/.test(fp0 || ''), 'Show the key makes it and shows its fingerprint, without a file', fp0);
  ok(await fin.$('[data-so-county-copy-fingerprint]') && await fin.$('[data-so-county-copy-pem]'), 'with a Copy button for the fingerprint and the public key');
  await fin.click('[data-so-county-copy-fingerprint]');
  ok(await toast(fin, /Fingerprint copied|Could not copy/), 'Copy says what happened');
  // U3: the period, the last complete quarter by default, shown beside the button.
  eq(await fin.$eval('[data-so-county-period-select]', s => s.selectedIndex), 0, 'the period defaults to the last complete quarter');
  ok((await fin.$eval('[data-so-county-period-select]', s => s.options[0].text)).includes(String(lq.to.slice(0, 4))), 'which is the quarter before this one');
  const shownPeriod = (await fin.textContent('[data-so-county-period]')).trim();
  ok(shownPeriod.length > 8 && /Make the county file for/.test(await fin.textContent('[data-so-county-file]')), 'the period is shown beside the button, and the button names it', shownPeriod);
  ok(/calendar Q\d \d{4} · FY \d{4}-\d{2} Q\d/.test(await fin.$eval('[data-so-county-period-select]', s => s.options[0].text)), 'each quarter is said as its California fiscal quarter too');
  eq((await fin.textContent('[data-so-county-period-warn]')).trim(), '', 'a quarter: no warning');
  const cy = await fin.$eval('[data-so-county-period-select]', s => [...s.options].find(o => /^Calendar year/.test(o.text)).value);
  await fin.selectOption('[data-so-county-period-select]', cy);
  ok(/not a single quarter/.test(await fin.textContent('[data-so-county-period-warn]')), 'a period that is not a quarter is warned about');
  await fin.selectOption('[data-so-county-period-select]', { index: 0 });
  // S5: nothing ticked until the person chooses; the file is refused without a fund, at the fund.
  eq(await fin.$$eval('[data-so-county-fund]', bs => bs.filter(b => b.checked).length), 0, 'no fund is ticked until the person chooses');
  await fin.fill('[data-so-county-code]', code.data.code_display.toLowerCase());
  await fin.fill('[data-so-county-name]', 'Sample County Behavioral Health');
  await fin.click('[data-so-county-file]');
  ok(/Tick the settlement funds/.test(await fin.textContent('[data-so-county-error]')), 'no fund ticked: said at the card');
  ok(await fin.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-so-county-fund')), 'and the focus goes to the funds');
  await fin.check('[data-so-county-fund]');
  const [dl] = await Promise.all([fin.waitForEvent('download'), fin.click('[data-so-county-file]')]);
  ok(/^suds-county-submission-[a-z0-9-]+-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()) && dl.suggestedFilename().includes(`${lq.from}_${lq.to}`), 'Make the county file downloads the quarter\'s file, named after the program', dl.suggestedFilename());
  const ownPath = path.join(tmp, 'own.json'); await dl.saveAs(ownPath);
  const ownText = fs.readFileSync(ownPath, 'utf8'); const own = JSON.parse(ownText);
  eq(own.format, 'suds-county-submission', 'the file is a county submission');
  eq(own.payload.recipient.county_code, code.data.code, 'made for the county whose code was typed');
  eq(own.payload.funds.length, 1, 'with the one fund ticked');
  ok(await toast(fin, /County file for .* made/), 'a message says it was made and where it goes');
  eq(fp0.replace(/\s/g, ''), own.signature.key_fingerprint, 'the fingerprint on the page is the file\'s key');
  await fin.click('[data-so-county-key] details > summary');
  const pem = (await fin.textContent('[data-so-county-pem]')).trim();
  ok(/^-----BEGIN PUBLIC KEY-----/.test(pem), 'the public key is on the page to give the county');
  const allowed = new Set(['counts', 'funds', 'categories', 'generated_at', 'period', 'programme', 'recipient', 'county_code', 'county_name', 'schema_version', 'suds_version', 'total', 'from', 'to', 'category', 'grant_number', 'hiaa', 'name', 'spend', 'values',
    'approved', 'other_categories', 'own_category', 'pending', 'key', 'spend_own_category', 'contacts', 'naloxone_kits', 'fentanyl_strips', 'syringes', 'reversals', 'treatment_admissions', 'education_contacts',
    'staff_training_hours', 'referrals_made', 'people_served', 'people_linked', 'moud_linked', 'people_trained']);
  const keys = new Set(); const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } }; walk(own.payload);
  eq([...keys].filter(k => !allowed.has(k)).join(','), '', 'every field in the file is an aggregate one on the allow-list');
  await axe(fin, 'settlement with Send to the county (1280)');
  // The same card remembers the county and the fund next time.
  await go(fin, 'settlement'); await fin.reload(); await settle(fin); await until(() => fin.$('[data-so-county-form]'));
  eq(await fin.inputValue('[data-so-county-code]'), code.data.code_display, 'the county code is remembered');
  eq(await fin.$$eval('[data-so-county-fund]', bs => bs.filter(b => b.checked).length), 1, 'and the fund chosen for it');
  // SUDS on this device offers neither (the same page and navigation, told they are on a device).
  const onDevice = await fin.evaluate(async () => { const a = await import('./app.js'); a.state.local = true; const n = a.NAV.find(x => x.name === 'county'); const placed = a.navPlacement(n); a.state.local = false; return placed; });
  eq(onDevice, null, 'on SUDS on this device there is no County view entry');
  await fin.evaluate(async () => { const a = await import('./app.js'); a.state.local = true; await a.render(); });
  await settle(fin);
  ok(await fin.$('[data-settlement-outcomes]') && !(await fin.$('[data-so-county]')), 'and Settlement outcomes offers no Send to the county');
  await fin.evaluate(async () => { const a = await import('./app.js'); a.state.local = false; await a.render(); });
  await settle(fin);
  const finNav0 = await fin.$$eval('.sidebar a', as => as.map(a => a.getAttribute('href')));
  ok(!finNav0.includes('#/county'), 'before any program is registered, finance has no County view entry');

  // ---------------- 2. the county's side ----------------
  const { ctx: admCtx, page: adm } = await signIn('admin', 'AdminPassw0rd!x');
  await go(adm, 'county');
  eq((await adm.textContent('.main h1')).trim(), 'County view', 'an administrator reaches the County view');
  ok(await adm.$('.empty-state'), 'with nothing registered it says what to do first');
  ok(await adm.$('nav.tabs.wrapped'), 'U7: the section tabs wrap rather than scroll');
  await go(adm, 'county?tab=programmes');
  eq((await adm.textContent('[data-cp-code]')).trim(), code.data.code_display, 'Programs shows this county\'s code to give the programs');
  // Register the first program with the keyboard: the dialog opens on its first field, the key's fingerprint
  // shows as the key is typed, and Escape gives the focus back.
  await adm.focus('[data-cp-add]'); await adm.keyboard.press('Enter');
  await adm.waitForSelector('.modal-bg .modal');
  eq(await adm.evaluate(() => document.activeElement && document.activeElement.name), 'name', 'the dialog opens with the focus on the program name');
  await adm.keyboard.press('Escape');
  await until(async () => !(await adm.$('.modal-bg')));
  eq(await adm.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-cp-add')), '1', 'Escape closes it and gives the focus back to Register a program');
  await adm.click('[data-cp-add]'); await adm.waitForSelector('.modal-bg .modal');
  await axe(adm, 'Register a program dialog (1280)');
  await adm.fill('.modal [name=name]', riverbend.name);
  await adm.fill('.modal [name=public_key]', riverbend.public_key);
  const computed = await until(async () => { const t = await adm.textContent('[data-cp-computed]'); return t.includes(riverbend.fingerprint) ? t : null; });
  ok(computed, 'U6: the key\'s fingerprint shows as the key is typed, without leaving the field', await adm.textContent('[data-cp-computed]'));
  eq(await adm.evaluate(() => document.activeElement && document.activeElement.name), 'public_key', 'the focus stayed in the key');
  await adm.click('.modal button[type=submit]');
  let fpErr = await until(async () => { const t = await adm.$eval('.modal [data-field=fingerprint] .err', e => e.textContent).catch(() => ''); return t || null; });
  ok(/compared/.test(fpErr || ''), 'neither the fingerprint typed nor "I compared it" ticked: refused at the fingerprint', fpErr);
  await adm.fill('.modal [name=fingerprint]', '0000 1111 2222 3333 4444 5555 6666 7777');
  await adm.click('.modal button[type=submit]');
  fpErr = await until(async () => { const t = await adm.$eval('.modal [data-field=fingerprint] .err', e => e.textContent).catch(() => ''); return /does not match/.test(t) ? t : null; });
  ok(fpErr, 'a fingerprint that does not match the key is refused at the field', fpErr);
  eq(await adm.evaluate(() => document.activeElement && document.activeElement.name), 'fingerprint', 'and the focus goes to it');
  await adm.fill('.modal [name=fingerprint]', '');
  await adm.check('.modal [name=compared]');
  await adm.click('.modal button[type=submit]');
  ok(await toast(adm, new RegExp(`Registered ${riverbend.name}`)), 'ticking "I compared it" registers the program');
  await settle(adm);
  ok((await adm.textContent('[data-cp-list]')).includes(riverbend.name), 'and it is listed with its fingerprint');
  for (const p of [eastside, hillview]) eq((await api(adm, 'POST', '/api/county/programmes', { name: p.name, public_key: p.public_key, compared: true })).status, 201, `${p.name} registered`);
  eq((await api(adm, 'POST', '/api/county/programmes', { name: 'Our own program', public_key: pem, fingerprint: fp0 })).status, 201, 'the program above is registered with the key it showed');
  await go(adm, 'county?tab=programmes');
  await adm.click(`[data-cp-keys]`); await adm.waitForSelector('[data-cp-keys-dialog]');
  ok(/Replace the key/.test(await adm.textContent('.modal')), 'Keys shows a program\'s key history and replacing it');
  await axe(adm, 'Keys dialog (1280)');
  await adm.keyboard.press('Escape'); await until(async () => !(await adm.$('.modal-bg')));

  // Import through the page: the outcome is said where the person is.
  await go(adm, 'county?tab=submissions');
  await axe(adm, 'county submissions (1280)');
  const importFile = async (file) => {
    await adm.evaluate(() => { const e = document.querySelector('[data-cs-result]'); if (e) e.removeAttribute('data-cs-outcome'); });
    await adm.setInputFiles('#cs-file', file);
    await adm.click('[data-cs-import]');
    return until(async () => { const o = await adm.getAttribute('[data-cs-result]', 'data-cs-outcome'); return o ? { outcome: o, role: await adm.getAttribute('[data-cs-result]', 'role'), text: await adm.textContent('[data-cs-result]'), focused: await adm.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-cs-result')) } : null; });
  };
  const rb = filesOf('riverbend');
  let r = await importFile(rb[rb.length - 1]);
  eq(r.outcome, 'ok', 'a signed file imports'); eq(r.role, 'status', 'and the outcome is a status message');
  ok(r.focused, 'which takes the focus'); ok(new RegExp(`Imported ${riverbend.name}`).test(r.text), 'naming the program and period', r.text);
  ok(/[A-Z][a-z]{2} \d{1,2}, \d{4} to [A-Z][a-z]{2} \d{1,2}, \d{4}/.test(r.text), 'U9: the period in words people read', r.text);
  ok(await until(async () => (await adm.textContent('[data-cs-list]')).includes(riverbend.name)), 'the file is listed');
  const tampered = JSON.parse(fs.readFileSync(filesOf('eastside')[1], 'utf8')); tampered.payload.total.values.naloxone_kits += 5;
  const tamperedPath = path.join(tmp, 'tampered.json'); fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  r = await importFile(tamperedPath);
  eq(r.outcome, 'refused', 'a file changed after it was signed is refused'); eq(r.role, 'alert', 'as an alert');
  ok(r.focused, 'which takes the focus'); ok(/Not imported\. The signature does not match/.test(r.text), 'saying why', r.text);
  r = await importFile(filesOf('eastside')[1]);
  eq(r.outcome, 'ok', 'the program\'s own, unchanged file imports');
  // Hillview sent only the older quarter; our own program's file is for the last quarter.
  eq((await api(adm, 'POST', '/api/county/submissions', { text: fs.readFileSync(filesOf('hillview')[0], 'utf8') })).status, 201, 'Hillview\'s earlier quarter imports');
  eq((await api(adm, 'POST', '/api/county/submissions', { text: ownText })).status, 201, 'the program\'s own file imports');

  // The combined view for the last quarter.
  await go(adm, `county?from=${lq.from}&to=${lq.to}`);
  const headline = (await adm.textContent('[data-cv-headline]')).trim();
  eq(headline, '3 of 4 programs submitted for the whole period, 0 for part of it, 1 not at all.', 'U2: the headline says whole, part and not at all');
  const hvRow = await adm.$$eval('[data-cv-who] tbody tr', (trs, n) => { const tr = trs.find(t => t.textContent.includes(n)); return tr ? tr.textContent : ''; }, hillview.name);
  ok(/Not submitted/.test(hvRow), 'Hillview is shown as not submitted for the quarter', hvRow);
  ok(!(await adm.$$eval('[data-cv-who] th', ths => ths.map(t => t.textContent))).some(t => /fingerprint/i.test(t)), 'U13: no fingerprint column on the combined view');
  const want = [JSON.parse(fs.readFileSync(rb[rb.length - 1], 'utf8')), JSON.parse(fs.readFileSync(filesOf('eastside')[1], 'utf8')), own].reduce((n, f) => n + f.payload.total.values.naloxone_kits, 0);
  const kitsRow = await adm.$$eval('[data-cv-group=outcome] tbody tr', (trs) => { const tr = trs.find(t => /^Naloxone kits distributed/.test(t.cells[0].textContent)); return tr ? tr.cells[tr.cells.length - 1].textContent : ''; });
  eq(Number(kitsRow.replace(/[^\d.]/g, '')), want, 'the total naloxone kits is the three files\' sum');
  const totalHead = await adm.$eval('[data-cv-group=outcome] thead th:last-child', th => th.textContent);
  eq(totalHead, 'Total (3 of 4 programs complete)', 'M6: the total says how many programs are complete');
  ok(/— not submitted/.test(await adm.$eval('[data-cv-group=outcome] tbody', b => b.textContent)), 'M6: a program that did not submit shows "—" and the words');
  ok(/People served \(each program's own count, summed\)/.test(await adm.textContent('[data-cv-group=outcome]')), 'U1: people served is each program\'s own count, summed');
  ok(!/unduplicated/i.test(await mainText(adm)), 'U1: the page never says "unduplicated"');
  ok(await adm.isVisible('[data-cv-caveat-summary]') && !(await adm.isVisible('[data-cv-caveats-full] ul')), 'U13: the caveats fold behind an always-visible summary');
  await adm.click('[data-cv-caveats-full] > summary');
  ok(/counted twice/.test(await adm.textContent('[data-cv-caveats]')), 'the caveats in full say a person may be counted twice');
  ok(/publication screen over the combined release \(planned\)/.test(await adm.textContent('[data-cv-publication]')), 'and that publishing needs the publication screen (planned)');
  const [cv] = await Promise.all([adm.waitForEvent('download'), adm.click('[data-cv-export=csv]')]);
  eq(cv.suggestedFilename(), `suds-county-view-${lq.from}_${lq.to}-internal-exact.csv`, 'the combined view downloads as a file labelled internal and exact');
  const [tidy] = await Promise.all([adm.waitForEvent('download'), adm.click('[data-cv-export=tidy]')]);
  eq(tidy.suggestedFilename(), `suds-county-view-${lq.from}_${lq.to}-tidy-internal-exact.csv`, 'M7: and as a long, tidy CSV');
  await axe(adm, 'county combined view (1280)');
  // U12: a preset fills the dates; Enter in a date applies them.
  const fyOpt = await adm.$eval('[data-cv-preset]', s => { const o = [...s.options].find(x => /^FY \d{4}-\d{2} Q\d/.test(x.text)); return o ? o.value : null; });
  ok(fyOpt, 'the presets offer California fiscal quarters');
  await adm.selectOption('[data-cv-preset]', fyOpt);
  const presetFrom = await adm.inputValue('#cv-from');
  await adm.focus('#cv-to'); await adm.keyboard.press('Enter');
  ok(await until(async () => adm.evaluate((f) => location.hash.includes(`from=${f}`), presetFrom)), 'Enter in a date applies the period the preset filled in');
  await settle(adm);
  // M5: by quarter.
  await go(adm, `county?from=${rbPeriod(rb[0]).from}&to=${lq.to}`);
  await adm.selectOption('[data-cv-mode]', 'quarter'); await adm.click('[data-cv-apply]');
  ok(await until(() => adm.$('[data-cv-by-quarter]')), 'M5: By quarter shows the measures by quarter');
  await settle(adm);
  eq(await adm.$eval('[data-cv-quarter-group=outcome] thead', t => t.querySelectorAll('th').length), 3, 'a column for each of the two quarters');
  await adm.click('[data-cv-per-program] > summary');
  ok(await adm.isVisible('[data-cv-quarter="0"] table'), 'each program\'s figures behind a disclosure');
  await axe(adm, 'county by quarter (1280)');
  await go(adm, 'county?tab=programmes'); await axe(adm, 'county programs (1280)');
  // A period that ends before it starts is said at the dates.
  await go(adm, `county?from=${lq.from}&to=${lq.to}`);
  await adm.fill('#cv-from', lq.to); await adm.fill('#cv-to', lq.from); await adm.click('[data-cv-apply]');
  ok(/after the end date/.test(await adm.textContent('#cv-range-err')), 'a backwards period is refused at the dates');

  // U4/U5/S3: Submissions — Current / Replaced / Withdrawn; Withdraw only on a current file, with a reason; the
  // focus to the list's heading; Reinstate. The program makes its file again: the first becomes Replaced.
  await go(fin, 'settlement'); await until(() => fin.$('[data-so-county-form]'));
  const [dl2] = await Promise.all([fin.waitForEvent('download'), fin.click('[data-so-county-file]')]);
  const own2 = path.join(tmp, 'own2.json'); await dl2.saveAs(own2);
  eq((await api(adm, 'POST', '/api/county/submissions', { text: fs.readFileSync(own2, 'utf8') })).data.status, 'superseded', 'a file made again for the same quarter replaces the first');
  await go(adm, 'county?tab=submissions');
  const statusOf = (n) => adm.$$eval('[data-cs-list] tbody tr', (trs, name) => trs.filter(t => t.cells[0].textContent.includes(name)).map(t => [t.textContent, !!t.querySelector('[data-cs-withdraw]')]), n);
  const ours = await statusOf('Our own program');
  ok(ours.some(([t, w]) => /Current/.test(t) && w) && ours.some(([t, w]) => /Replaced/.test(t) && !w), 'Current has Withdraw; Replaced has none', ours);
  ok(!/Counts|Left out/.test(await adm.textContent('[data-cs-list] thead')), 'no "Counts" or "Left out" on the Submissions list');
  const current = await adm.$$eval('[data-cs-list] tbody tr', (trs) => trs.find(t => t.cells[0].textContent.includes('Our own program') && /Current/.test(t.textContent)).querySelector('[data-cs-withdraw]').getAttribute('data-cs-withdraw'));
  await adm.click(`[data-cs-withdraw="${current}"]`); await adm.waitForSelector('.modal');
  await axe(adm, 'Withdraw dialog (1280)');
  await adm.fill('.modal input', 'Made before the last expenditures were approved');
  await adm.click('.modal .btn.danger');
  ok(await until(async () => adm.evaluate(() => document.activeElement && document.activeElement.id === 'cs-list-h')), 'U5: after Withdraw the focus is on the Files received heading');
  ok(await toast(adm, /earlier file .* counts again/), 'and it says the earlier file counts again');
  const after = await statusOf('Our own program');
  ok(after.some(([t]) => /Withdrawn/.test(t)) && after.some(([t]) => /Current/.test(t)), 'the withdrawn file is Withdrawn and the earlier one Current again', after);
  await adm.click(`[data-cs-reinstate="${current}"]`);
  ok(await toast(adm, /Reinstated\. It counts again/), 'Reinstate puts it back');
  ok(await until(async () => adm.evaluate(() => document.activeElement && document.activeElement.id === 'cs-list-h')), 'with the focus on the heading again');

  // S4: Make a new key on the program's side: the old one retired, the new fingerprint shown to read out.
  await go(fin, 'settlement'); await until(() => fin.$('[data-so-county-newkey-btn]'));
  await fin.click('[data-so-county-newkey-btn]'); await fin.waitForSelector('.modal');
  await fin.click('.modal .btn.danger');
  const nk = await until(async () => { const e = await fin.$('[data-so-county-newkey]'); return e ? e.textContent() : null; });
  const fp1 = (await fin.textContent('[data-so-county-fingerprint]')).trim();
  ok(nk && nk.includes(fp1) && fp1 !== fp0, 'Make a new key shows the new fingerprint to read to the county', nk);
  ok(await fin.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-so-county-newkey')), 'and takes the focus to it');
  ok((await fin.textContent('[data-so-county-retired]')).includes(fp0), 'the old key is listed as retired');

  // Phone width.
  const { ctx: phCtx, page: ph } = await signIn('admin', 'AdminPassw0rd!x', { width: 390, height: 844 });
  for (const hash of [`county?from=${lq.from}&to=${lq.to}`, `county?from=${rbPeriod(rb[0]).from}&to=${lq.to}&by=quarter`, 'county?tab=submissions', 'county?tab=programmes']) {
    await go(ph, hash); await axe(ph, `${hash.replace(/from=[^&]*&to=[^&]*&?/, '')} (390)`); ok(await noSideScroll(ph), `${hash}: nothing scrolls sideways at 390 px`);
  }
  await go(ph, `county?from=${lq.from}&to=${lq.to}`);
  const card = await ph.$eval('[data-cv-group=outcome] tbody tr td:nth-child(2)', td => td.getAttribute('data-label'));
  ok(card && card.length <= 15, 'U10: a program\'s figures carry a short name on a phone', card);
  await go(ph, 'county?tab=programmes'); await ph.click('[data-cp-add]'); await ph.waitForSelector('.modal-bg .modal'); await axe(ph, 'Register a program dialog (390)');
  const { ctx: finPh, page: fph } = await signIn('afinance', PW, { width: 320, height: 700 });
  await go(fph, 'settlement'); await until(() => fph.$('[data-so-county-key] details'));
  await fph.click('[data-so-county-key] details > summary');
  ok(await noSideScroll(fph), 'U8: at 320 px the public key wraps, nothing scrolls sideways');
  await fph.setViewportSize({ width: 390, height: 844 }); await axe(fph, 'settlement with Send to the county, key open (390)');
  await phCtx.close(); await finPh.close();

  // ---------------- 3. finance and read-only ----------------
  await fin.goto(base + '/'); await fin.reload(); await settle(fin);
  const finNav = await fin.$$eval('.sidebar a', as => as.map(a => a.getAttribute('href')));
  ok(finNav.includes('#/county'), 'once programs are registered, finance has the County view entry');
  await go(fin, `county?from=${lq.from}&to=${lq.to}`);
  ok(await fin.$('[data-cv-who]'), 'and sees the combined view');
  await go(fin, 'county?tab=programmes');
  ok(!(await fin.$('[data-cp-add]')), 'but cannot register a program');
  await go(fin, 'county?tab=submissions');
  ok(!(await fin.$('[data-cs-importer]')) && !(await fin.$('[data-cs-withdraw]')), 'nor import or withdraw a file');
  await finCtx.close();
  const { ctx: roCtx, page: ro } = await signIn('rreader', PW);
  const roNav = await ro.$$eval('.sidebar a', as => as.map(a => a.getAttribute('href')));
  ok(!roNav.includes('#/county'), 'read-only has no County view entry');
  eq((await api(ro, 'GET', `/api/county/view?from=${lq.from}&to=${lq.to}`)).status, 403, 'and the server refuses it the view');
  await roCtx.close(); await admCtx.close();
} catch (e) {
  fail(`the script stopped: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
}
/** The period of a sample file, from its name. */
function rbPeriod(file) { const m = /(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/.exec(file); return { from: m[1], to: m[2] }; }
fs.rmSync(tmp, { recursive: true, force: true });
finish(errors);
await browser.close();

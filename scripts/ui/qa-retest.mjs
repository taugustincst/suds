// The defects an outside tester found on the published (static, always-local) build, replayed on both the
// static site and the office server's /?local=1 so a regression on either surface fails the suite:
//   P0 "Add resource" did nothing (a thrown DOM error before the request; now every error reaches the banner)
//   P0 Settings crashed on the device (config.oidc missing from the local kernel's config shim)
//   P1 a due date typed without a time was silently dropped (date + optional time controls now)
//   P1 a client with a blank status showed no status at all (rendered as Active; migration 19 backfills)
//   P2 the date picker could not be opened while the client search list was open over it
//   P3 the greeting must use the display name as typed, and the dialog title must not linger in the a11y tree
// Retest round two: the tester's browser profile carried state from a build *before* those fixes (an
// IndexedDB database, an account, a client set to inactive there, a service worker registered by the
// old build) and every finding "was still broken". The "upgraded profile" section at the end replays
// exactly that: the static site built from the pre-fix commit, a profile set up on it, then the current
// build served at the same origin into the same profile — the situation a fresh profile never covers.
import * as pw from 'playwright';
const { devices } = pw;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeChecks, until, settle } from './assert.mjs';
// A page of the older build has no activity hook (window.__sudsActivity) to wait on; pace it the old way.
const pace = async (p) => ((await p.evaluate(() => !!window.__sudsActivity).catch(() => false)) ? settle(p) : p.waitForTimeout(150));
// SUDS_BROWSER=webkit (or firefox) runs this script in that engine instead of Chromium; CI's WebKit smoke
// job uses it as the nearest thing to iPhone Safari a Linux runner has.
const browserType = pw[process.env.SUDS_BROWSER || 'chromium'];
if (!browserType || !browserType.launch) throw new Error(`SUDS_BROWSER=${process.env.SUDS_BROWSER} is not a Playwright browser (chromium, webkit, firefox)`);
const { ok, eq, fail, finish } = makeChecks('qa-retest');
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { plainStatic } = require(path.join(repo, 'scripts/serve-static.js'));
const VERSION = require(path.join(repo, 'package.json')).version;
// The commit the tester's profile was set up on. Its static build is cached across runs.
const OLD_COMMIT = 'cf4897983d80d5b5f9e965afb8d15c046ca76043'; // the build before the first retest's fixes
const surfaces = [
  ['static site', (process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8877') + '/'],
  ['office server in local mode', (process.env.SUDS_URL || 'http://127.0.0.1:8090') + '/?local=1'],
];
const png = '/tmp/suds-qa-retest.png';
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVQI12P4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
const browser = await browserType.launch();
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
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 }); await settle(page);
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); }

  // P3-1 greeting
  const h1 = (await page.textContent('h1')) || '';
  ok(/^Good (morning|afternoon|evening), QATEST$/.test(h1.trim()), `${label}: the greeting shows the display name exactly as typed`, h1.trim());
  const fallback = await page.evaluate(async () => { const m = await import('./app.js'); return [m.greetingName('', 'jdoe'), m.greetingName('Dr. Kiran Patel'), m.clientStatus({ status: '' }), m.clientStatus({ status: null }), m.clientStatus({ status: 'inactive' }), m.greetingName('QA Tester'), m.greetingName('QATEST'), m.greetingName('Maria de la Cruz Jones'), m.greetingName('Dr. Patel'), m.firstName('Dr. Kiran Patel')]; });
  eq(fallback[0], 'jdoe', `${label}: a blank display name greets by username`);
  eq(fallback[1], 'Dr. Patel', `${label}: a name with an honorific greets as honorific + surname`);
  eq(fallback[5], 'QA', `${label}: an ordinary two-word name greets by its first word, as typed (not re-cased)`);
  eq(fallback[6], 'QATEST', `${label}: a one-word, all-capitals name is neither cut nor re-cased`);
  eq(fallback[7], 'Maria', `${label}: a long formal name is shortened to the first name`);
  eq(fallback[8], 'Dr. Patel', `${label}: "Dr. Patel" keeps the honorific with the surname`);
  eq(fallback[9], 'Kiran', `${label}: firstName (the welcome tour) still gives the first name`);
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
  // ... and pictures can be added to it and are served back on the device. Two ways in, both with a real
  // click and no setInputFiles shortcut: a person taps the "+ Add pictures" button; a testing tool aims at
  // the <input type=file> itself (the retest called that control "obscured by a div" when it was off-screen).
  await page.waitForSelector('input[type=file]', { timeout: 5000 }).catch(() => {});
  const fileInput = await page.$('input[type=file]');
  ok(!!fileInput, `${label}: the profile offers to add pictures`);
  if (fileInput) {
    const chooser1 = page.waitForEvent('filechooser', { timeout: 5000 }).then(() => true).catch(() => false);
    await page.click('text=+ Add pictures', { timeout: 5000 }).catch(e => fail(`${label}: clicking "+ Add pictures" failed: ${e.message.split('\n')[0]}`));
    ok(await chooser1, `${label}: a real click on "+ Add pictures" opens the file picker`);
    const chooser2 = page.waitForEvent('filechooser', { timeout: 5000 }).then(() => true).catch(() => false);
    let inputClick = true;
    await fileInput.click({ timeout: 5000 }).catch(e => { inputClick = false; fail(`${label}: the <input type=file> itself cannot be clicked: ${e.message.split('\n')[0]}`); });
    ok(inputClick && await chooser2, `${label}: a real click on the file input itself (no force) also opens the picker — nothing obscures it`);
    ok(await page.evaluate(() => { const i = document.querySelector('input[type=file]'); const r = i.getBoundingClientRect(); return r.width > 40 && r.height > 20 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === i; }), `${label}: the file input is the size of the button and is what a tap in the middle of it hits`);
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
  const pickerHit = () => page.evaluate(() => { const i = document.querySelector('.modal input[name=due_at]'); const r = i.getBoundingClientRect(); const el = document.elementFromPoint(r.right - 10, r.y + r.height / 2); return el === i ? 'input' : (el ? el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\s+/).join('.') : '') : 'nothing'); });
  eq(await pickerHit(), 'input', `${label}: with the client list closed, the date input's picker region is what a tap there hits`);
  await page.click('.modal input[role=combobox]');
  await until(async () => page.$('.modal [role=listbox]:not(.hidden)'), { timeout: 5000 });
  eq(await pickerHit(), 'input', `${label}: with the client list open, the picker region is still the date input (the list does not float over it)`);
  // the dialog scrolled so the field sits at the top of the screen, where the sticky banners are
  await page.evaluate(() => { const bg = document.querySelector('.modal-bg'); const el = document.querySelector('.modal input[name=due_at]'); bg.scrollTop += el.getBoundingClientRect().top - 2; });
  eq(await pickerHit(), 'input', `${label}: scrolled up under the top banners, the picker region is still the date input (the demo banner does not intercept)`);
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
// ---------------------------------------------------------------------------------------------------
// Upgraded profile: the static site from OLD_COMMIT, a profile set up on it, then the current build at the
// same origin into the same profile. Skipped (with a failure) when the old build cannot be produced.
// ---------------------------------------------------------------------------------------------------
const oldSite = process.env.SUDS_OLD_STATIC_DIR || path.join(os.tmpdir(), `suds-static-${OLD_COMMIT.slice(0, 7)}`);
const newSite = process.env.SUDS_STATIC_DIR || '';
function buildOldSite() {
  if (fs.existsSync(path.join(oldSite, 'sw.js'))) return true;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-old-wt-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    // CI checks out with --depth 1, so the old commit is not in the clone until it is fetched by hash.
    try { git('rev-parse', '--verify', '--quiet', OLD_COMMIT + '^{commit}'); }
    catch { git('fetch', '--depth=1', 'origin', OLD_COMMIT); }
    git('worktree', 'add', '--detach', wt, OLD_COMMIT);
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
    execFileSync('node', [path.join(wt, 'scripts/build-static-site.js'), oldSite], { stdio: 'pipe', cwd: wt });
    return true;
  } catch (e) { fail(`could not build the ${OLD_COMMIT} static site: ${String(e.stderr || e.message).slice(0, 300)}`); return false; }
  finally { try { git('worktree', 'remove', '--force', wt); } catch {} }
}
if (!newSite || !fs.existsSync(path.join(newSite, 'sw.js'))) fail('SUDS_STATIC_DIR must point at the current static build (run-all.sh sets it)');
else if (buildOldSite()) {
  const port = Number(process.env.SUDS_UPGRADE_PORT || 8879); const base = `http://127.0.0.1:${port}`;
  let handler = plainStatic(oldSite);
  const server = http.createServer((q, r) => handler(q, r)); await new Promise(r => server.listen(port, r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-qa-profile-'));
  const phone = { ...devices['iPhone 13'], isMobile: true, hasTouch: true };
  const label = 'upgraded profile';
  const dismissTour = async (page) => { await pace(page); for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await pace(page); } };
  try {
    // --- the tester's history, on the old build ---
    let ctx = await browserType.launchPersistentContext(profile, phone);
    let page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(base + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 15000 });
    await page.fill('input[name=display_name]', 'QATEST'); await page.selectOption('select[name=role]', 'admin');
    await page.fill('input[name=username]', 'qatest'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
    await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 15000 }); await dismissTour(page);
    ok(/QATEST$/.test((await page.textContent('h1')).trim()), `${label}: set up as QATEST on the ${OLD_COMMIT} build`);
    await page.goto(base + '/#/clients'); await page.waitForSelector('button:has-text("New client")', { timeout: 10000 });
    await page.click('button:has-text("New client")'); await page.waitForSelector('.modal input[name=first_name]');
    await page.fill('.modal input[name=first_name]', 'Mona'); await page.fill('.modal input[name=last_name]', 'Retest');
    await page.click('.modal button[type=submit]'); await page.waitForURL(/#\/client\//, { timeout: 10000 });
    const clientUrl = page.url();
    await page.click('button:has-text("Edit")'); await page.waitForSelector('.modal select[name=status]');
    await page.selectOption('.modal select[name=status]', 'inactive'); await page.click('.modal button[type=submit]');
    await until(async () => /Inactive/.test((await page.textContent('#main')) || ''), { timeout: 8000 });
    ok(/M26-0001/.test(await page.textContent('#main')) && /Inactive/.test(await page.textContent('#main')), `${label}: client M26-0001 set to Inactive on the old build`);
    // the old build's "Add resource" was the P0 defect (it saved nothing), so the resource is added after the upgrade
    await page.evaluate(() => window.SUDS_LOCAL.flush && window.SUDS_LOCAL.flush()); // evaluate awaits the flush's promise: written when it returns
    await ctx.close();

    // --- the current build, same origin, same profile ---
    handler = plainStatic(newSite);
    ctx = await browserType.launchPersistentContext(profile, phone);
    page = ctx.pages()[0] || await ctx.newPage();
    const upErrors = [];
    page.on('pageerror', e => upErrors.push(`${label}: PAGEERROR ${e.message}`));
    await page.goto(base + '/'); await page.waitForSelector('.layout, input[name=username]', { timeout: 15000 });
    if (await page.$('input[name=username]')) { await page.fill('input[name=username]', 'qatest'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 15000 }); }
    await dismissTour(page);
    // the new worker takes over the profile and the page runs the current files
    const swNow = await until(() => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); const keys = await caches.keys(); return r && r.active && navigator.serviceWorker.controller ? keys : null; }), { timeout: 20000 });
    ok(Array.isArray(swNow) && swNow.includes(`suds-shell-${VERSION}`) && swNow.every(k => k === `suds-shell-${VERSION}`), `${label}: the current release's service worker controls the page and older shell caches are gone`, swNow);
    ok(await page.evaluate(async () => typeof (await import('./app.js')).greetingName === 'function'), `${label}: the page runs the current app.js, not the old build's copy`);
    const swSrc = await page.evaluate(() => fetch('sw.js', { cache: 'no-store' }).then(r => r.text()));
    ok(/cache: 'reload'/.test(swSrc) && /cache: 'no-cache'/.test(swSrc) && /mode === 'navigate'/.test(swSrc), `${label}: the worker fills its shell from the network, revalidates app files, and falls back to index.html only for navigations`);
    // A host that sends max-age (GitHub Pages: ten minutes) must not pin the device to the files it has: with
    // app.js fresh in the HTTP cache, a new deploy of app.js has to be running after one reload.
    const withMaxAge = (dir) => { const inner = plainStatic(dir); return (q, r) => { const wh = r.writeHead.bind(r); r.writeHead = (st, hd = {}) => wh(st, { ...hd, 'Cache-Control': 'public, max-age=600' }); return inner(q, r); }; };
    handler = withMaxAge(newSite); await page.reload(); await page.waitForSelector('.layout', { timeout: 15000 });
    const deployB = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-deploy-b-'));
    fs.cpSync(newSite, deployB, { recursive: true });
    fs.appendFileSync(path.join(deployB, 'app.js'), "\nwindow.SUDS_BUILD_MARK = 'B';\n");
    handler = withMaxAge(deployB); await page.reload(); await page.waitForSelector('.layout', { timeout: 15000 });
    eq(await page.evaluate(() => window.SUDS_BUILD_MARK), 'B', `${label}: a new deploy of app.js is running after one reload even though the HTTP cache still calls the old copy fresh (max-age=600)`);
    handler = plainStatic(newSite); try { fs.rmSync(deployB, { recursive: true, force: true }); } catch {}
    // item 4: greeting from the account the old build created
    const h1 = (await page.textContent('h1')).trim();
    ok(/^Good (morning|afternoon|evening), QATEST$/.test(h1), `${label}: the greeting shows the old build's display name whole`, h1);
    // item 3: the inactive client from the old database
    await page.goto(clientUrl); await until(async () => /M26-0001/.test((await page.textContent('#main')) || ''), { timeout: 10000 });
    const badges = await page.$$eval('#main .badge', b => b.map(x => x.textContent.trim()));
    ok(badges.includes('Inactive'), `${label}: M26-0001's header shows the Inactive badge after the upgrade`, badges);
    ok(/Status\s*Inactive/.test((await page.textContent('#main')).replace(/\s+/g, ' ')), `${label}: and the Overview's Status row says Inactive`);
    const stored = await page.evaluate(async (id) => { const r = await window.SUDS_LOCAL.handle('GET', '/api/clients/' + id, null, { 'X-Requested-With': 'suds' }); const c = r.json && r.json.client; return c && [c.client_code, c.status]; }, clientUrl.split('/client/')[1].split(/[/?]/)[0]);
    ok(stored && stored[0] === 'M26-0001' && stored[1] === 'inactive', `${label}: the stored status on the device is still "inactive"`, stored);
    await page.goto(base + '/#/clients?status=all'); await until(async () => (await page.$$('tbody tr')).length > 0, { timeout: 8000 });
    ok(/Inactive/.test(await page.textContent('tbody')), `${label}: the client list shows the status too`);
    // item 1: pictures, both paths, with real clicks
    await page.goto(base + '/#/resources'); await page.waitForSelector('button:has-text("+ Add resource")', { timeout: 10000 });
    await page.click('button:has-text("+ Add resource")'); await page.waitForSelector('.modal input[name=name]');
    await page.fill('.modal input[name=name]', 'Riverbend Outpatient'); await page.selectOption('.modal select[name=category]', 'outpatient');
    await page.click('.modal button[type=submit]'); await page.waitForURL(/#\/resource\//, { timeout: 10000 }).catch(() => {});
    ok(/#\/resource\//.test(page.url()), `${label}: a resource saves on the upgraded profile`);
    for (const [vp, size] of [['phone', null], ['desktop', { width: 1280, height: 800 }]]) {
      if (size) await page.setViewportSize(size);
      await page.waitForSelector('input[type=file]', { timeout: 5000 });
      const c1 = page.waitForEvent('filechooser', { timeout: 5000 }).then(() => true).catch(() => false);
      await page.click('text=+ Add pictures', { timeout: 5000 }).catch(e => fail(`${label} ${vp}: "+ Add pictures" click failed: ${e.message.split('\n')[0]}`));
      ok(await c1, `${label} ${vp}: a real click on "+ Add pictures" opens the file picker`);
      const c2 = page.waitForEvent('filechooser', { timeout: 5000 }).then(() => true).catch(() => false);
      await page.click('input[type=file]', { timeout: 5000 }).catch(e => fail(`${label} ${vp}: the file input is obscured: ${e.message.split('\n')[0]}`));
      ok(await c2, `${label} ${vp}: a real click on the file input itself opens the picker`);
    }
    await page.setInputFiles('input[type=file]', png);
    const shown = await until(async () => page.$$eval('.gallery img', i => i.filter(x => x.naturalWidth > 0).length), { timeout: 8000 });
    ok(shown > 0, `${label}: the picture is stored and shown`, shown);
    await page.setViewportSize(phone.viewport);
    // item 2: the date picker, client list closed, open, and scrolled under the banners
    await page.goto(base + '/#/tasks'); await page.waitForSelector('button:has-text("Add a reminder")', { timeout: 10000 });
    await page.click('button:has-text("Add a reminder")'); await page.waitForSelector('.modal input[name=due_at]');
    const hit = () => page.evaluate(() => { const i = document.querySelector('.modal input[name=due_at]'); const r = i.getBoundingClientRect(); const el = document.elementFromPoint(r.right - 10, r.y + r.height / 2); return el === i ? 'input' : (el ? el.tagName.toLowerCase() + '.' + String(el.className).split(/\s+/).join('.') : 'nothing'); });
    eq(await hit(), 'input', `${label}: the date picker region is the date input (client list closed)`);
    await page.click('.modal input[role=combobox]'); await until(async () => page.$('.modal [role=listbox]:not(.hidden)'), { timeout: 5000 });
    eq(await hit(), 'input', `${label}: the date picker region is the date input (client list open)`);
    await page.evaluate(() => { const bg = document.querySelector('.modal-bg'); const el = document.querySelector('.modal input[name=due_at]'); bg.scrollTop += el.getBoundingClientRect().top - 2; });
    eq(await hit(), 'input', `${label}: the date picker region is the date input when scrolled up under the demo banner`);
    let clicked = true; await page.click('.modal input[name=due_at]', { position: { x: 150, y: 20 }, timeout: 4000 }).catch(e => { clicked = false; fail(`${label}: the date input's picker region cannot be clicked: ${e.message.split('\n')[0]}`); });
    ok(clicked, `${label}: a real click on the picker region succeeds`);
    await page.keyboard.press('Escape');
    // item 5: the phone/tablet page on a plain static host
    const getApp = await page.evaluate(async (b) => { const r = await fetch(b + '/get-app.html'); const t = await r.text(); return [r.status, /Use SUDS on your phone or tablet/.test(t)]; }, base);
    ok(getApp[0] === 200 && getApp[1], `${label}: get-app.html is served by the plain static host`, getApp);
    eq((await page.evaluate(async (b) => (await fetch(b + '/app')).status, base)), 404, `${label}: /app is a real 404 on a plain static host (no rewrite to rely on)`);
    ok(await page.evaluate((v) => caches.open('suds-shell-' + v).then(c => c.match('get-app.html')).then(r => !!r), VERSION), `${label}: get-app.html is in the shell cache`);
    // item 6: no stray dialog title in the accessibility tree
    await page.goto(base + '/#/admin?tab=settings'); await until(async () => !/Loading…/.test((await page.textContent('#main')) || ''), { timeout: 10000 });
    ok(await until(async () => !(await a11yHas(page, /add a reminder|add resource/i)), { timeout: 8000 }), `${label}: no stray dialog title remains in the accessibility tree`);
    errors.push(...upErrors);
    await ctx.close();
  } catch (e) { fail(`${label}: ${e.message.split('\n')[0]}`); }
  finally { await new Promise(r => server.close(r)); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
}
finish(errors.slice(0, 8));
await browser.close();

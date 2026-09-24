// Two windows on one device, one on-device database. Each case here is a way the single-writer lock used to
// lose confirmed records (1.9.2): a tab taking the database back kept its stale in-memory copy and saved it
// over the other tab's work; a tab from an older release kept writing after being displaced; a frozen
// background holder woke up and saved over the new holder; a duplicated tab took over silently. The fix is
// fencing (local/shims/sqlite.js): every save is checked against an epoch in IndexedDB that each new holder
// bumps, and the database lives under a key an older release never writes.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeChecks, until, settle, saved } from './assert.mjs';
// A page of the 1.9.0 build has no activity hook (window.__sudsActivity) to wait on; pace it the old way.
const pace = async (p) => ((await p.evaluate(() => !!window.__sudsActivity).catch(() => false)) ? settle(p) : p.waitForTimeout(150));

const { ok, eq, fail, finish } = makeChecks('multitab');
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch();
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', e => errors.push(`PAGEERROR (${tag}) ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_|SUDS is open in another/.test(m.text())) errors.push(`CONSOLE (${tag}) ${m.text().slice(0, 300)}`); });
  return page;
};
// Service workers are kept out of these contexts: what is under test is two live documents sharing one
// IndexedDB store, and a worker taking control part-way would reload them under the test.
const newCtx = () => browser.newContext({ viewport: { width: 1100, height: 850 }, serviceWorkers: 'block' });
const api = (page, m, p, b) => page.evaluate(([m, p, b]) => window.SUDS_LOCAL.handle(m, p, b, {}).then(r => ({ status: r.status, json: r.json })), [m, p, b]);
const addClient = (page, last) => api(page, 'POST', '/api/clients', { first_name: 'Tab', last_name: last });
const clientNames = async (page) => { const r = await api(page, 'GET', '/api/clients?limit=500'); return JSON.stringify(r.json || {}); };
const PROMPT = 'button:has-text("Use SUDS in this window")';
const TAKE_BACK = 'button:has-text("Use SUDS here instead")';
const booted = (page) => page.waitForSelector('.layout, input[name=username], input[name=display_name]', { timeout: 20000 });
const isPaused = async (page) => /paused/i.test((await page.textContent('#app').catch(() => '')) || '');
async function setup(page, url) {
  await page.goto(url);
  await page.waitForSelector('input[name=display_name]', { timeout: 20000 });
  await page.fill('input[name=display_name]', 'Tab Tester'); await page.fill('input[name=username]', 'tabs');
  await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 15000 });
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await pace(page); }
}
async function takeOver(page) {
  await page.waitForSelector(PROMPT, { timeout: 20000 });
  await page.click(PROMPT);
  await booted(page).catch(async (e) => { throw new Error(`did not boot after taking over: ${((await page.textContent('#app').catch(() => '')) || '').slice(0, 200)}`); });
  await until(() => page.evaluate(() => !!window.SUDS_LOCAL), { timeout: 10000 });
}

// ---- 1. two tabs, take over, write in B, take back in A: B's record must survive ----
{
  const ctx = await newCtx();
  const A = watch(await ctx.newPage(), 'A'); await setup(A, base + '/?local=1#/');
  eq((await addClient(A, 'Alpha')).status, 201, 'tab A records a client');
  const B = watch(await ctx.newPage(), 'B'); await B.goto(base + '/?local=1#/');
  await takeOver(B);
  eq((await addClient(B, 'Bravo')).status, 201, 'tab B, having taken over, records a client');
  await until(() => isPaused(A), { timeout: 10000 });
  ok(await isPaused(A), 'tab A shows the paused screen');
  eq(await A.getAttribute('[data-paused]', 'data-paused'), 'saved', 'and says its work was saved first (it wrote out before answering)');
  ok(!(await A.$('.modal-bg')), 'with no dialog left open over it');
  await A.evaluate(() => [...document.querySelectorAll('button')].find(b => /Use SUDS here instead/.test(b.textContent)).click());
  await booted(A); await until(() => A.evaluate(() => !!window.SUDS_LOCAL && !document.querySelector('.boot.error')), { timeout: 15000 });
  ok(/Bravo/.test(await clientNames(A)), 'taking it back in A shows the record B made (no stale in-memory copy)');
  eq((await addClient(A, 'Charlie')).status, 201, 'tab A records another client after taking back');
  await until(() => isPaused(B), { timeout: 10000 });
  ok(await isPaused(B), 'tab B, displaced in turn, shows the paused screen');
  // Paused means paused: a hash change, or the dashboard's own 90-second refresh (which is a hash change to
  // #/dashboard?_=<time>), must not render the app back over it against a database this tab no longer owns.
  await B.evaluate(() => { location.hash = '#/clients'; });
  await settle(B); // the render that hash change starts has run (and kept the paused screen)
  ok(await isPaused(B), 'the paused screen survives a hash change');
  await B.evaluate(() => { location.hash = '#/dashboard?_=' + Date.now(); });
  await settle(B);
  ok(await isPaused(B) && !(await B.$('.layout')), 'and the dashboard refresh', (await B.textContent('#app')).slice(0, 80));
  await saved(A);
  await A.reload(); await booted(A); await until(() => A.evaluate(() => !!window.SUDS_LOCAL), { timeout: 10000 });
  const after = await clientNames(A);
  ok(/Alpha/.test(after) && /Bravo/.test(after) && /Charlie/.test(after), 'after a reload all three records are on the device', after.match(/"last_name":"[^"]*"/g));
  await ctx.close();
}

// ---- 2. a frozen holder with a save pending wakes up after another tab took over ----
// A is stopped dead with the debugger (headless Chromium ignores Page.setWebLifecycleState for a visible
// page), which is what a frozen background tab amounts to: no timers, no channel messages, no answer.
// Twice: once the way a browser freezes a tab, with the `freeze` event first (the page saves on it), and
// once without, so A wakes with its write still pending on the coalescing timer: the timer then fires into
// the fence, not over B's data.
for (const freezeSave of [true, false]) {
  const tag = freezeSave ? '' : ' (no freeze event)';
  const ctx = await newCtx();
  const A = watch(await ctx.newPage(), 'A'); await setup(A, base + '/?local=1#/');
  const cdp = await ctx.newCDPSession(A); await cdp.send('Debugger.enable');
  eq((await addClient(A, 'Delta')).status, 201, `tab A records a client, then is frozen before anything else runs${tag}`);
  if (freezeSave) await A.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await cdp.send('Debugger.pause');
  const B = watch(await ctx.newPage(), 'B'); await B.goto(base + '/?local=1#/');
  // A stale or silent holder is never displaced without asking.
  ok(await B.waitForSelector(PROMPT, { timeout: 20000 }).catch(() => null), `a second tab asks before displacing a holder that is not answering${tag}`);
  await takeOver(B);
  eq((await addClient(B, 'Echo')).status, 201, `tab B records a client while A is frozen${tag}`);
  const deltaInB = /Delta/.test(await clientNames(B));
  if (freezeSave) ok(deltaInB, 'the write made just before A was frozen was saved on the freeze and reached B');
  else ok(!deltaInB, 'without it, A\'s last write had not reached the store when B took over', deltaInB);
  await saved(B);
  await cdp.send('Debugger.resume');
  // A wakes: its pending save timer and the queued takeover message both get their chance to write.
  await until(() => isPaused(A), { timeout: 10000 });
  ok(await isPaused(A), `tab A, on waking, finds it was displaced and pauses${tag}`);
  // What A tells the person must match what actually happened to its last write, whichever of its queued
  // callbacks runs first on waking: saved on the freeze (and carried into B's copy) → "saved first"; still
  // pending when B took over → "may need to be re-entered".
  eq(await A.getAttribute('[data-paused]', 'data-paused'), freezeSave ? 'saved' : 'unsaved', `the paused tab says truthfully whether its last write was saved first${tag}`);
  ok(freezeSave ? /saved first/.test(await A.textContent('#app')) : /may need to be re-entered/.test(await A.textContent('#app')), `and words it that way${tag}`);
  await A.waitForTimeout(800); // intentional: give A's pending save timer its chance to fire into the fence
  await B.reload(); await booted(B); await until(() => B.evaluate(() => !!window.SUDS_LOCAL), { timeout: 10000 });
  ok(/Echo/.test(await clientNames(B)), `B's record survives A waking up${tag}`);
  await ctx.close();
}

// ---- 3. a duplicated tab (sessionStorage copied) asks; a reload of the same tab does not ----
{
  const ctx = await newCtx();
  const A = watch(await ctx.newPage(), 'A'); await setup(A, base + '/?local=1#/');
  eq((await addClient(A, 'Foxtrot')).status, 201, 'tab A records a client');
  const session = await A.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
  const D = watch(await ctx.newPage(), 'D');
  await D.addInitScript((s) => { if (!sessionStorage.getItem('__dup')) { for (const [k, v] of Object.entries(JSON.parse(s))) sessionStorage.setItem(k, v); sessionStorage.setItem('__dup', '1'); } }, session);
  await D.goto(base + '/?local=1#/');
  const prompt = await D.waitForSelector(PROMPT, { timeout: 20000 }).catch(() => null);
  ok(prompt, 'a duplicated tab (same sessionStorage) is asked, not given the database silently');
  ok(!(await isPaused(A)), 'and the original tab keeps working until someone chooses');
  await D.close();
  // A reload of the holding tab is the same window: straight back in, and nothing written just before is lost.
  eq((await addClient(A, 'Golf')).status, 201, 'tab A records a client just before reloading');
  await A.reload(); await booted(A);
  ok(!(await A.$(PROMPT)) && (await A.$('.layout')), 'reloading the holding tab boots straight back in with no prompt');
  await until(() => A.evaluate(() => !!window.SUDS_LOCAL), { timeout: 10000 });
  ok(/Golf/.test(await clientNames(A)), 'the record written right before the reload is there');
  await ctx.close();
}

// ---- 3b. the order a frozen tab's queued work runs in on waking must not decide what it tells the person ----
// Deterministic version of a race CI hit once in three runs: the displaced tab ran an unload-style save (no
// fence: it writes its own key) before handling the takeover message, found nothing left unsaved, and said
// "your work here was saved first" although that save went to a key nobody reads. Here another window's claim
// is made directly in the store, then the tab does the unload save, then receives the takeover message.
{
  const ctx = await newCtx();
  const A = watch(await ctx.newPage(), 'A'); await setup(A, base + '/?local=1#/');
  // One step, so the regular 250 ms save timer cannot run in between and hide the race: a write leaves the
  // page with unsaved work, another window's claim moves the epoch, the unload save writes the page's own
  // (now dead) key, and only then does the takeover message arrive.
  const status = await A.evaluate(async () => {
    const r = await window.SUDS_LOCAL.handle('POST', '/api/clients', { first_name: 'Tab', last_name: 'Racer' }, {});
    await new Promise((res, rej) => { const o = indexedDB.open('suds-local', 1); o.onsuccess = () => { const d = o.result; const t = d.transaction('kv', 'readwrite'); const st = t.objectStore('kv'); const g = st.get('epoch'); g.onsuccess = () => st.put((g.result || 0) + 1000, 'epoch'); t.oncomplete = () => { d.close(); res(); }; t.onerror = () => rej(t.error); }; o.onerror = () => rej(o.error); });
    window.dispatchEvent(new Event('pagehide'));
    new BroadcastChannel('suds-local-lock').postMessage({ type: 'takeover', from: 'another-window' });
    return r.status;
  });
  eq(status, 201, 'tab A records a client (queued-work order case)');
  await until(() => isPaused(A), { timeout: 10000 });
  eq(await A.getAttribute('[data-paused]', 'data-paused').catch(() => null), 'unsaved', 'a tab whose last write was refused by the fence (another window claimed first) does not claim it was saved');
  await ctx.close();
}

// ---- 4. a tab still running 1.9.0 (no takeover handling, no fencing) and a new tab ----
// Built from the 1.9.0 release commit into a temporary worktree, and served at the same origin as this build
// (a switchable static handler), which is exactly the state of a phone during the first minutes after a
// deploy: one tab on the old files, a new one on the new.
const OLD_COMMIT = '84516ab';
const oldSite = path.join(os.tmpdir(), `suds-static-${OLD_COMMIT}`);
const newSite = process.env.SUDS_STATIC_DIR || '';
function buildOld() {
  if (fs.existsSync(path.join(oldSite, 'sw.js'))) return true;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-old-wt-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    try { git('rev-parse', '--verify', '--quiet', OLD_COMMIT + '^{commit}'); } catch { git('fetch', '--depth=50', 'origin'); }
    git('worktree', 'add', '--detach', wt, OLD_COMMIT);
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
    execFileSync('node', [path.join(wt, 'scripts/build-static-site.js'), oldSite], { stdio: 'pipe', cwd: wt });
    return true;
  } catch (e) { fail(`could not build the ${OLD_COMMIT} static site: ${String(e.stderr || e.message).slice(0, 300)}`); return false; }
  finally { try { git('worktree', 'remove', '--force', wt); } catch {} }
}
if (!newSite || !fs.existsSync(path.join(newSite, 'sw.js'))) fail('SUDS_STATIC_DIR must point at the current static build (run-all.sh sets it)');
else if (buildOld()) {
  const { plainStatic } = require(path.join(repo, 'scripts/serve-static.js'));
  const port = Number(process.env.SUDS_MULTITAB_PORT || 8881); const sbase = `http://127.0.0.1:${port}`;
  let handler = plainStatic(oldSite);
  const server = http.createServer((q, r) => handler(q, r)); await new Promise(r => server.listen(port, r));
  try {
    const ctx = await newCtx();
    const A = watch(await ctx.newPage(), 'old'); await setup(A, sbase + '/');
    eq((await addClient(A, 'Oldone')).status, 201, 'a tab on 1.9.0 records a client');
    await A.waitForTimeout(600); // intentional: the 1.9.0 tab saves on its own timer and exposes nothing to wait on
    handler = plainStatic(newSite);
    const B = watch(await ctx.newPage(), 'new'); await B.goto(sbase + '/');
    await takeOver(B);
    ok(/Oldone/.test(await clientNames(B)), 'the new build picks up what the 1.9.0 tab had saved');
    eq((await addClient(B, 'Newone')).status, 201, 'the new tab records a client');
    await saved(B);
    // The old tab does not know it was displaced and keeps saving its own copy.
    const late = await addClient(A, 'Oldtwo');
    ok(late.status === 201, 'the 1.9.0 tab still accepts a write (it cannot know better)', late.status);
    await A.waitForTimeout(800); // intentional: let the 1.9.0 tab's save timer fire (nothing observable to wait on)
    await B.reload(); await booted(B); await until(() => B.evaluate(() => !!window.SUDS_LOCAL), { timeout: 10000 });
    const names = await clientNames(B);
    ok(/Newone/.test(names) && /Oldone/.test(names), 'the new tab\'s data is intact after the old tab saved again', names.match(/"last_name":"[^"]*"/g));
    await ctx.close();
  } finally { server.close(); }
}

await browser.close();
finish(errors);

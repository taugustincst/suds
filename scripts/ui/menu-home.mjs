// The worker-first menu and phone Home (1.23.0), checked in a browser at 390 × 844:
//   1. the menu by role and programme profile (public/nav.js): Street outreach in the main menu for a navigator and a
//      peer navigator in the harm-reduction and treatment-adjacent profiles; the monthly pages (reports, state
//      reporting, import) under More; at most 12 top-level entries (More counted as one) in a front-line phone menu;
//      everything a role may open still in the menu, and still opens at its address;
//   2. the phone Home: to-dos for today on the first screen (the top 700 px), even on a first sign-in with the welcome
//      card showing; the welcome dismissed for good from its own close button; the program-wide cards folded and
//      remembered per user (prefs home_folded); the auto-refresh switch below today's work;
//   3. the desktop Home keeps its layout (heading, then the welcome card, then the today cards);
//   4. axe on the phone Home and the open phone menu.
// Measurements are printed as "measure:" lines (before/after figures for the release notes).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, settle, until } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('menu-home');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const browser = await chromium.launch();
const errors = [];
const measure = (what, value) => console.log(`measure: ${what} = ${JSON.stringify(value)}`);
const PHONE = { width: 390, height: 844 };

async function session(username, password = PW, viewport = PHONE) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 });
  await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
  return { ctx, page, api, go };
}
async function axe(page, where) {
  if (!axeSource) { fail('axe-core is not installed (npm i --no-save axe-core)'); return; }
  await page.evaluate(axeSource + ';0');
  const v = await page.evaluate(async () => {
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading', 'landmark-unique', 'page-has-heading-one'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
}
// The menu as built: the top-level links, More counted as one entry, and what is under More.
const menu = (page) => page.evaluate(() => {
  const nav = document.querySelector('.sidebar nav.nav');
  const more = nav.querySelector('details.nav-more');
  const name = (a) => [...a.childNodes].filter(n => !(n.classList && n.classList.contains('ico'))).map(n => n.textContent).join('').trim();
  const main = [...nav.querySelectorAll(':scope > a')].map(name);
  const under = more ? [...more.querySelectorAll('a')].map(name) : [];
  return { main, more: under, top: main.length + (more ? 1 : 0) };
});
// Home on this screen: its height, where "To-dos for today" sits, and what is above it.
const home = (page) => page.evaluate(() => {
  window.scrollTo(0, 0);
  const h2 = [...document.querySelectorAll('.main h2')].find(x => x.textContent.trim() === 'To-dos for today');
  const top = h2 ? Math.round(h2.getBoundingClientRect().top) : null;
  const above = [];
  if (h2) for (const el of document.querySelectorAll('.main h2, .main h1, .main label, .main a.badge, .main .banner, .main [data-welcome]')) {
    const r = el.getBoundingClientRect(); if (r.height && r.top < top) above.push(el.textContent.trim().slice(0, 40));
  }
  return { height: document.documentElement.scrollHeight, todosTop: top, above };
});

try {
  // ------------------------------------------------------------------------------------------- 1. the menu
  const admin = await session('admin', 'AdminPassw0rd!x', { width: 1280, height: 900 });
  const setProfile = async (p) => eq((await admin.api('PUT', '/api/admin/settings', { programme_profile: p })).status, 200, `the programme profile is set to ${p}`);
  const people = [['mrivera', 'navigator'], ['dchen', 'peer navigator'], ['kpatel', 'clinician'], ['jwalker', 'supervisor']];
  for (const profile of ['treatment', 'harm_reduction', 'part2_layer']) {
    await setProfile(profile);
    for (const [who, label] of people) {
      const s = await session(who);
      const m = await menu(s.page);
      measure(`${label} phone menu (${profile}) top-level entries`, m.top);
      measure(`${label} phone menu (${profile}) total entries`, m.main.length + m.more.length);
      if (label !== 'supervisor') {
        ok(m.top <= 12, `${label} (${profile}): the phone menu has at most 12 top-level entries`, m);
        if (profile === 'part2_layer') ok(!m.main.includes('Street outreach') && !m.more.includes('Street outreach'), `${label} (${profile}): no Street outreach in a Part 2 layer's menu`, m);
        else ok(m.main.includes('Street outreach'), `${label} (${profile}): Street outreach is in the main menu`, m);
        for (const p of ['Reports', 'Import', ...(profile === 'part2_layer' ? [] : ['Funder report'])]) ok(m.more.includes(p) && !m.main.includes(p), `${label} (${profile}): ${p} is under More`, m);
        if (profile === 'harm_reduction') ok(m.more.includes('Waitlist'), `${label} (${profile}): Waitlist is under More in a harm-reduction programme`, m);
        if (profile === 'treatment') ok(m.main.includes('Waitlist'), `${label} (${profile}): Waitlist stays in the main menu of a treatment-adjacent programme`, m);
        // Nothing the role may open has gone: Funding & spending and Policies & contracts are under More now.
        for (const p of ['Funding & spending', 'Policies & contracts']) if (profile !== 'part2_layer' || p !== 'Funding & spending') ok(m.main.includes(p) || m.more.includes(p), `${label} (${profile}): ${p} is reachable from the menu`, m);
      }
      if (who === 'dchen' && profile === 'harm_reduction') {
        // The menu opens from ☰, Street outreach is a tap away, and the open drawer passes axe.
        await s.page.click('.mobilebar button[aria-controls=sidebar]');
        await until(() => s.page.$eval('.sidebar', e => e.classList.contains('open')));
        await axe(s.page, 'the open phone menu of a peer navigator');
        if (await s.page.$('.sidebar nav.nav > a[href="#/outreach"]')) {
          await s.page.click('.sidebar nav.nav > a[href="#/outreach"]'); await settle(s.page);
          eq((await s.page.textContent('.main h1')).trim(), 'Street outreach', 'the peer\'s menu entry opens Street outreach');
        } else fail('the peer\'s open menu has no Street outreach link at the top level');
        // Presentation only: a page under More still opens at its address.
        await s.go('budget');
        ok(!/Not available for your role/.test(await s.page.textContent('#main')), 'Funding & spending still opens at its address');
      }
      await s.ctx.close();
    }
  }
  await setProfile('harm_reduction');

  // --------------------------------------------------------------------------------------- 2. the phone Home
  for (const [who, label] of [['mrivera', 'navigator'], ['dchen', 'peer navigator']]) {
    // A first sign-in: the welcome card is showing.
    const s = await session(who);
    await s.api('PUT', '/api/me/prefs', { tour_done: false, home_folded: null });
    await s.go('dashboard?_=1'); await s.page.reload(); await settle(s.page);
    const first = await home(s.page);
    measure(`${label} Home at 390 px: height (px)`, first.height);
    measure(`${label} Home at 390 px: "To-dos for today" top (px)`, first.todosTop);
    measure(`${label} Home at 390 px: above "To-dos for today"`, first.above);
    ok(first.todosTop !== null && first.todosTop < 700, `${label}: "To-dos for today" is on the first screen (top ${first.todosTop} px < 700) on a first sign-in`, first);
    const todos = await s.page.evaluate(() => { const h2 = [...document.querySelectorAll('.main h2')].find(x => x.textContent.trim() === 'To-dos for today'); const card = h2.closest('.card'); return { items: card.querySelectorAll('.today-item').length, next: !!card.querySelector('.empty button, .empty a, .empty-state button, .empty-state a') }; });
    ok(todos.items > 0 || todos.next, `${label}: the to-dos card lists what is due, or says what to do next`, todos);
    const welcomeTop = await s.page.evaluate(() => { const w = document.querySelector('[data-welcome]'); return w ? Math.round(w.getBoundingClientRect().top) : null; });
    ok(welcomeTop !== null && welcomeTop > first.todosTop, `${label}: the welcome card still shows on a first sign-in, below today's work`, { welcomeTop, todosTop: first.todosTop });
    if (who === 'dchen') await axe(s.page, 'the phone Home on a first sign-in');
    // The auto-refresh switch is below today's work.
    const below = await s.page.evaluate(() => { const t = [...document.querySelectorAll('.main h2')].find(x => x.textContent.trim() === 'To-dos for today').getBoundingClientRect().top; const a = document.querySelector('[data-home-autorefresh]'); return a ? a.getBoundingClientRect().top > t : null; });
    eq(below, true, `${label}: the "Update this page" switch sits below "To-dos for today"`);
    // Dismissed from its own close button, and not shown again after a reload.
    if (await s.page.$('[data-welcome-dismiss]')) await s.page.click('[data-welcome-dismiss]'); else { fail(`${label}: the welcome card has no close button`); await s.page.click('[data-welcome-done]'); }
    await until(async () => !(await s.page.$('[data-welcome]')), { timeout: 5000 }); await settle(s.page);
    await s.page.reload(); await settle(s.page);
    ok(!(await s.page.$('[data-welcome]')), `${label}: the dismissed welcome does not come back after a reload`);
    // Program-wide cards fold, and stay folded for this person.
    const folds = await s.page.$$eval('[data-home-fold]', e => e.map(x => x.dataset.homeFold));
    ok(folds.length >= 2, `${label}: the program-wide cards can be folded`, folds);
    const key = folds[0];
    if (key) {
    const openBefore = await s.page.$eval(`[data-home-fold="${key}"]`, d => d.open);
    await s.page.click(`[data-home-fold="${key}"] > summary`);
    await until(() => s.page.evaluate(() => !(window.__sudsActivity && window.__sudsActivity.pending)));
    await s.page.evaluate(async () => { const { prefs } = await import('./app.js'); await prefs.flush(); });
    await s.page.reload(); await settle(s.page);
    eq(await s.page.$eval(`[data-home-fold="${key}"]`, d => d.open), !openBefore, `${label}: the folded state of "${key}" is remembered after a reload`);
    }
    const after = await home(s.page);
    measure(`${label} Home at 390 px after dismissing the welcome: height (px)`, after.height);
    measure(`${label} Home at 390 px after dismissing the welcome: "To-dos for today" top (px)`, after.todosTop);
    await s.ctx.close();
  }

  // ------------------------------------------------------------------------------------------- 3. desktop
  {
    const s = await session('mrivera', PW, { width: 1280, height: 900 });
    await s.api('PUT', '/api/me/prefs', { tour_done: false, home_folded: null });
    await s.go('dashboard?_=2'); await s.page.reload(); await settle(s.page);
    const folds = await s.page.$$eval('[data-home-fold]', e => e.map(x => [x.dataset.homeFold, x.open]));
    ok(folds.length >= 2 && folds.every(([, open]) => open), 'desktop Home: the program-wide cards start open on a computer', folds);
    const order = await s.page.evaluate(() => {
      const w = document.querySelector('[data-welcome]'); const t = [...document.querySelectorAll('.main h2')].find(x => x.textContent.trim() === 'To-dos for today');
      const auto = document.querySelector('[data-home-autorefresh]');
      return { welcomeFirst: !!(w && t && (w.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)), autoInHead: !!(auto && auto.closest('.topbar')) };
    });
    eq(order.welcomeFirst, true, 'desktop Home: the welcome card still comes before the today cards');
    eq(order.autoInHead, true, 'desktop Home: the auto-refresh switch stays in the page heading');
    measure('navigator Home at 1280 px with the welcome: height (px)', (await home(s.page)).height);
    await s.api('PUT', '/api/me/prefs', { tour_done: true });
    await s.page.reload(); await settle(s.page);
    measure('navigator Home at 1280 px without the welcome: height (px)', (await home(s.page)).height);
    await s.ctx.close();
  }
  await admin.ctx.close();
} catch (e) { fail(`threw: ${e.stack || e.message}`); }
await browser.close();
for (const e of errors) fail(e);
finish();

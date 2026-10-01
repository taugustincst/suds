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
//   1.23.1: Notes in a clinician's phone menu; the open menu over the banners; Home's to-dos capped at 5 with "N more";
//   the + Log button clear of the alert badges; a short offline banner.
//   1.23.2: a to-do on Home is marked done by its box alone (the title opens it) and "Done" has an Undo; nothing is
//   left under the + Log button at the end of a page.
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
        // 1.23.1: a clinician's day is notes: Notes stays in their phone menu; a navigator's is under More.
        if (label === 'clinician') ok(m.main.includes('Notes') && !m.more.includes('Notes'), `${label} (${profile}): Notes is in the phone main menu`, m);
        else ok(m.more.includes('Notes') && !m.main.includes('Notes'), `${label} (${profile}): Notes is under More on a navigator's phone`, m);
        // Nothing the role may open has gone: Funding & spending and Policies & contracts are under More now.
        for (const p of ['Funding & spending', 'Policies & contracts']) if (profile !== 'part2_layer' || p !== 'Funding & spending') ok(m.main.includes(p) || m.more.includes(p), `${label} (${profile}): ${p} is reachable from the menu`, m);
      }
      if (who === 'dchen' && profile === 'harm_reduction') {
        // The menu opens from ☰, Street outreach is a tap away, and the open drawer passes axe.
        await s.page.click('.mobilebar button[aria-controls=sidebar]');
        await until(() => s.page.$eval('.sidebar', e => e.classList.contains('open')));
        // 1.23.1: a banner (here the 2-step one) no longer sits over the open drawer's brand and programme name.
        await until(() => s.page.$eval('.sidebar', e => e.getAnimations().every(a => a.playState !== 'running'))); // the drawer has slid in
        const cover = await s.page.evaluate(() => {
          const b = document.querySelector('.sidebar .brand').getBoundingClientRect();
          const pts = [[b.left + 12, b.top + b.height / 2], [b.left + b.width / 2, b.top + b.height / 2]];
          return { banners: document.querySelectorAll('#banners .banner').length, onTop: pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.closest('.sidebar') ? 'menu' : e && e.closest('#banners') ? 'banner' : (e && e.tagName); }) };
        });
        ok(cover.banners > 0, 'a banner is showing above the page (the 2-step reminder)', cover);
        eq(cover.onTop.join(','), 'menu,menu', 'the open phone menu\'s brand and programme name are on top of the banners', cover);
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

  // ------------------------------------------------- 2a. a first sign-in, cold, five times (1.23.3, external retest)
  // "To-dos for today" was on the first screen on some first sign-ins at 390 × 844 and about 940 px down on others:
  // Home chose its layout once, from the width when its figures came back, and a phone browser whose window was still
  // at another width at that moment kept the computer's layout. Home now follows the width. Each load here is a new
  // browser on a first sign-in; the odd ones are sized to the phone only once the sign-in has been sent, the even ones
  // only after Home has been drawn (the two moments the retest's loads differed by).
  for (let n = 0; n < 5; n++) {
    const who = n % 2 ? 'dchen' : 'mrivera';
    const ctx = await browser.newContext({ viewport: n === 0 ? PHONE : { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${who} cold load ${n} PAGEERROR ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/40[134]/.test(m.text())) errors.push(`${who} cold load ${n} CONSOLE ${m.text().slice(0, 200)}`); });
    await page.goto(base + '/#/login'); await settle(page);
    await page.fill('input[name=username]', who); await page.fill('input[name=password]', PW); await page.click('button[type=submit]');
    if (n % 2) await page.setViewportSize(PHONE);
    await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
    if (n && !(n % 2)) { await page.setViewportSize(PHONE); await settle(page); }
    await until(() => page.$('[data-home-layout="phone"]'), { timeout: 5000 }); await settle(page);
    const cold = await home(page);
    const layout = await page.evaluate(() => document.querySelector('[data-home-layout]')?.dataset.homeLayout);
    measure(`cold first sign-in ${n + 1} (${who}): "To-dos for today" top (px)`, cold.todosTop);
    eq(layout, 'phone', `cold first sign-in ${n + 1} (${who}): Home is laid out for the phone`);
    ok(cold.todosTop !== null && cold.todosTop < 700, `cold first sign-in ${n + 1} (${who}): "To-dos for today" is in the top 700 px (${cold.todosTop})`, cold);
    // The next load is a first sign-in again.
    await page.evaluate(async () => { await fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: false, home_folded: null, first_day_skip: null }) }); });
    await ctx.close();
  }

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
    // 1.23.1: at most five to-dos, overdue first, then "N more" to the to-do list.
    const due = ((await s.api('GET', '/api/me/continue')).data || {}).due_today || [];
    const capped = await s.page.evaluate(() => { const card = [...document.querySelectorAll('.main h2')].find(x => x.textContent.trim() === 'To-dos for today').closest('.card'); const more = card.querySelector('[data-today-more]');
      return { rows: [...card.querySelectorAll('.today-item')].map(e => e.dataset.overdue), more: more ? Number(more.dataset.todayMore) : 0, href: more ? more.querySelector('a').getAttribute('href') : null, text: more ? more.textContent : null }; });
    measure(`${label} Home at 390 px: to-dos due (of which shown)`, [due.length, capped.rows.length]);
    ok(capped.rows.length === Math.min(5, due.length), `${label}: "To-dos for today" shows at most 5 rows (${due.length} due)`, capped);
    eq(capped.rows.join(''), [...capped.rows].sort().reverse().join(''), `${label}: overdue to-dos come first`);
    if (due.length > 5) {
      eq(capped.more, due.length - 5, `${label}: "N more" counts the rest`);
      ok(capped.href === '#/tasks' && /more due to-do/.test(capped.text), `${label}: and opens To-dos`, capped);
    } else eq(capped.more, 0, `${label}: no "more" link with 5 or fewer`);
    if (who === 'dchen') ok(due.length > 5, 'the seed gives the peer navigator more than five to-dos due, so the cap is exercised', due.length);
    if (who === 'dchen') {
      // 1.23.2 (evaluation of 1.23.1, N1): tapping a to-do's title marked it done (the title was inside the box's label).
      // Now the box alone completes it, named "Mark done: <title>"; the title opens it; "Done" has an Undo.
      const first = await s.page.evaluate(() => { const row = document.querySelector('.today-item[data-today-task]'); const box = row.querySelector('input[type=checkbox]'); const open = row.querySelector('[data-today-open]');
        const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
        return { id: row.dataset.todayTask, name: box.getAttribute('aria-label'), title: open && open.textContent, openIsButton: open && open.tagName === 'BUTTON', titleInLabel: !!(open && open.closest('label')), boxTarget: r(box.closest('label') || box), openTarget: open && r(open) }; });
      eq(first.name, `Mark done: ${first.title}`, 'N1: the box is named "Mark done: <title>"');
      ok(first.openIsButton && !first.titleInLabel, 'N1: the title is its own button, outside the box\'s label', first);
      ok(first.boxTarget[0] >= 24 && first.boxTarget[1] >= 24 && first.openTarget[1] >= 24, 'N1: the box and the title are each at least 24 px to hit', first);
      const status = async () => (await s.api('GET', `/api/tasks/${first.id}`)).data.row.status;
      await s.page.click(`[data-today-open="${first.id}"]`);
      ok(await until(() => s.page.$('.modal')), 'N1: the title opens the to-do (or the record it came from)');
      eq(await status(), 'open', 'N1: and opening it does not mark it done');
      await axe(s.page, 'a to-do opened from Home');
      await s.page.keyboard.press('Escape'); await until(async () => !(await s.page.$('.modal-bg')));
      await s.page.check(`[data-today-task="${first.id}"] input[type=checkbox]`);
      ok(await until(async () => (await status()) === 'done'), 'N1: the box marks it done');
      ok(await until(() => s.page.$('.undo-toast [data-undo]')), 'N1: the "Done" message offers Undo');
      await s.page.click('.undo-toast [data-undo]');
      ok(await until(async () => (await status()) === 'open'), 'N1: Undo reopens it');
      ok(await until(() => s.page.$(`[data-today-task="${first.id}"]`)), 'N1: and it is back on Home');
      await axe(s.page, 'the phone Home after Undo');
      // 1.23.3: "Done" offers "View in Done" beside Undo, which opens To-dos showing Done, with the to-do in it.
      await s.page.check(`[data-today-task="${first.id}"] input[type=checkbox]`);
      ok(await until(async () => (await status()) === 'done'), 'View in Done: the box marks it done again');
      const btns = await until(() => s.page.evaluate(() => { const t = document.querySelector('.undo-toast'); return t && t.querySelector('[data-toast-also]') ? [...t.querySelectorAll('button')].map(b => ({ text: b.textContent, name: b.getAttribute('aria-label') })) : null; }));
      eq(btns && btns.map(b => b.text).join(' | '), 'Undo | View in Done', 'View in Done: the "Done" message offers Undo and View in Done');
      eq(btns && btns[1].name, `View in Done: Done: ${first.title}`, 'View in Done: the button is named with what was done');
      await s.page.focus('.undo-toast [data-undo]'); await s.page.keyboard.press('Tab');
      ok(await s.page.evaluate(() => !!document.activeElement?.closest('.undo-toast [data-toast-also]')), 'View in Done: Tab moves from Undo to View in Done');
      await axe(s.page, 'the "Done" message with Undo and View in Done (390 px)');
      ok(await s.page.$('.undo-toast [data-toast-also]'), 'View in Done: the message is still there while its buttons have focus');
      await s.page.keyboard.press('Enter');
      ok(await until(() => s.page.evaluate(() => /^#\/tasks\?status=done&mine=1(&|$)/.test(location.hash))), 'View in Done from Home: opens To-dos showing Done, assigned to me', await s.page.evaluate(() => location.hash));
      await settle(s.page);
      eq(await s.page.$eval('.main .filters select', e => e.value), 'done', 'View in Done from Home: the Status filter reads Done');
      ok(await until(() => s.page.evaluate((title) => [...document.querySelectorAll('.main .compact-row, .main tbody tr')].some(r => r.offsetParent && r.textContent.includes(title)), first.title)), `View in Done from Home: "${first.title}" is in the list`);
      ok(!(await s.page.$('.undo-toast')), 'View in Done: the message is put away');
      // N4: at the end of every page with the + Log button, nothing is left under it (the program-wide cards open).
      for (const page of ['dashboard', 'tasks', 'clients', 'calls', 'interventions', 'referrals']) {
        await s.go(page);
        await s.page.evaluate(() => document.querySelectorAll('.main details').forEach(d => { d.open = true; }));
        const under = await s.page.evaluate(async () => {
          window.scrollTo(0, document.documentElement.scrollHeight); await new Promise(r => requestAnimationFrame(r));
          const fe = document.querySelector('.fab'); if (!fe || getComputedStyle(fe).display === 'none') return null;
          const f = fe.getBoundingClientRect();
          return [...document.querySelectorAll('.main a, .main button, .main input, .main select, .main summary')].filter(a => { const b = a.getBoundingClientRect(); return b.width && b.height && a.checkVisibility() && b.bottom > f.top && b.top < f.bottom && b.right > f.left && b.left < f.right; }).map(a => a.textContent.trim().slice(0, 30) || a.tagName);
        });
        ok(under !== null, `N4: ${page} has the + Log button at 390 px`);
        eq((under || []).join(' | '), '', `N4: at the end of ${page}, no link or button is under the + Log button`);
      }
      await s.go('dashboard');
    }
    // 1.23.1: the + Log button never covers a Home alert badge (the Part 2 notice one), wherever the page is scrolled.
    const fabHits = await s.page.evaluate(() => { const f = document.querySelector('.fab').getBoundingClientRect(); return [...document.querySelectorAll('.home-alerts a.badge')].filter(b => b.getBoundingClientRect().right > f.left).map(b => b.textContent.trim()); });
    eq(fabHits.join(' | '), '', `${label}: the Home alert badges stop short of the + Log button's column`);
    // 1.23.1: offline, the banner is one short line and a link (it was five lines), beside the 2-step one.
    await s.ctx.setOffline(true); await s.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await until(() => s.page.$('#banners [data-banner="offline"]'));
    const off = await s.page.evaluate(() => { const b = document.querySelector('#banners [data-banner="offline"]'); const all = document.getElementById('banners').getBoundingClientRect().height; return { h: Math.round(b.getBoundingClientRect().height), all: Math.round(all), link: b.querySelector('a[href="#/field-phone"]')?.textContent, text: b.textContent }; });
    measure(`${label} offline banners at 390 px (offline banner, all banners) px`, [off.h, off.all]);
    ok(off.h <= 56 && off.link, `${label}: the offline banner is short (${off.h} px) and links to Working offline`, off);
    ok(off.all <= 100, `${label}: the banners together take at most 100 px of the 844 px screen`, off);
    if (who === 'dchen') await axe(s.page, 'the phone Home offline');
    await s.ctx.setOffline(false); await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await until(async () => !(await s.page.$('#banners [data-banner="offline"]')));
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
    // 1.23.3: Home follows the width both ways: narrowed to a phone it takes the phone's order, widened again the computer's.
    await s.page.setViewportSize(PHONE);
    ok(await until(() => s.page.$('[data-home-layout="phone"]')), 'desktop Home narrowed to 390 px is laid out for the phone'); await settle(s.page);
    ok((await home(s.page)).todosTop < 700, 'and "To-dos for today" is on its first screen');
    await s.page.setViewportSize({ width: 1280, height: 900 });
    ok(await until(() => s.page.$('[data-home-layout="computer"]')), 'widened again, it is the computer\'s layout'); await settle(s.page);
    // 1.23.3: the To-dos list's own box (a computer's table), on everyone's to-dos: View in Done keeps "everyone's".
    await s.go('tasks?status=open&mine=0');
    const title = await s.page.evaluate(() => { const box = [...document.querySelectorAll('.main tbody input[type=checkbox]')].find(i => /^Mark ".*" done$/.test(i.getAttribute('aria-label') || '')); return box ? box.getAttribute('aria-label').replace(/^Mark "(.*)" done$/, '$1') : null; });
    ok(title, 'the To-dos list (everyone\'s, open) has a to-do to mark done');
    if (title) {
      await s.page.check(`.main tbody input[type=checkbox][aria-label=${JSON.stringify(`Mark "${title}" done`)}]`);
      ok(await until(() => s.page.$('.undo-toast [data-toast-also]')), 'the list\'s "Done" message offers View in Done');
      eq(await s.page.$$eval('.undo-toast button', b => b.map(x => x.textContent).join(' | ')), 'Undo | View in Done', 'with Undo beside it');
      await axe(s.page, 'the "Done" message with Undo and View in Done (1280 px)');
      await s.page.click('.undo-toast [data-toast-also]');
      ok(await until(() => s.page.evaluate(() => /^#\/tasks\?status=done&mine=0(&|$)/.test(location.hash))), 'View in Done from the list: opens Done and keeps "everyone\'s"', await s.page.evaluate(() => location.hash));
      await settle(s.page);
      eq(await s.page.$eval('.main .filters select', e => e.value), 'done', 'View in Done from the list: the Status filter reads Done');
      ok(await s.page.evaluate((t) => [...document.querySelectorAll('.main tbody tr')].some(r => r.textContent.includes(t)), title), `View in Done from the list: "${title}" is in the list`);
    }
    await s.ctx.close();
  }
  await admin.ctx.close();
} catch (e) { fail(`threw: ${e.stack || e.message}`); }
await browser.close();
for (const e of errors) fail(e);
finish();

// The usability review of navigation (1.14.0), replayed in a browser, with its measurements:
//   1. report, funder and budget pages open in under a second at seed size, and say what they are working out
//      while they do (never a bare "Loading…");
//   2. the sidebar per role: a navigator's daily pages (Waitlist included) in the main list, the funder report
//      under More for their own caseload; State reporting and SUPRT-A entries when the module is on;
//   3. one word per action: "Log a visit", "Make a referral", "Clients", "To-dos for today";
//   4. + Log and the client record both offer "Make a referral", the client's opens for that client;
//   5. the client record: six everyday tabs and a More menu; Timeline is the Overview's recent activity;
//   6. the two-step verification bar: one line until dismissed, then a header link that adds no height;
//   7. the welcome is one card on Home, not a dialog: + Log works while it shows; Help brings it back;
//   8. own overdue to-dos are counted on the bell only; a supervisor's team count says it is the team's;
//   9. Supplies → Hand out opens the visit form preset to a naloxone distribution, client optional; Home's kit
//      count opens the visits that handed out kits, of any type;
//  10. at 390 px the Supplies tab strip scrolls with a visible cue and a short "SSP report" label, and the
//      bell's count stays on screen.
// Measurements are printed as "measure:" lines (before/after figures for the release notes).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('ux-nav');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const browser = await chromium.launch();
const errors = [];
const measure = (what, value) => console.log(`measure: ${what} = ${JSON.stringify(value)}`);

async function session(username, password, viewport = { width: 1280, height: 900 }, { tourDone = true } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 });
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  if (tourDone) await api('PUT', '/api/me/prefs', { tour_done: true });
  await settle(page);
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
const sidebar = (page) => page.evaluate(() => {
  const nav = document.querySelector('.sidebar nav.nav');
  const more = nav.querySelector('details.nav-more');
  const name = (a) => [...a.childNodes].filter(n => !(n.classList && n.classList.contains('ico'))).map(n => n.textContent).join('').trim();
  return { main: [...nav.querySelectorAll(':scope > a')].map(name), more: more ? [...more.querySelectorAll('a')].map(name) : [] };
});
// Open the sidebar's folded "More" group (a no-op when it is already open).
const openMore = (page) => page.evaluate(() => { const d = document.querySelector('.sidebar details.nav-more'); if (d) d.open = true; });
// How long a page takes from the address changing to its content replacing the loading line, and what that line said.
async function timePage(s, hash) {
  await s.go('profile');
  const t0 = Date.now();
  await s.page.evaluate((h) => { window.__loadingSaid = null; const seen = new MutationObserver(() => { const b = document.querySelector('.main .boot'); if (b && !window.__loadingSaid) window.__loadingSaid = b.textContent; }); seen.observe(document.body, { childList: true, subtree: true }); window.__stopSeen = () => seen.disconnect(); location.hash = h; }, hash);
  await s.page.waitForFunction(() => document.querySelector('.main') && !document.querySelector('.main .boot'), null, { timeout: 30000, polling: 20 });
  const ms = Date.now() - t0;
  const said = await s.page.evaluate(() => { window.__stopSeen(); return window.__loadingSaid; });
  await settle(s.page);
  return { ms, said };
}

try {
  const today = new Date().toISOString().slice(0, 10);
  // ------------------------------------------------------------------------------------------------------ 1
  const sup = await session('jwalker', PW);
  const nav = await session('mrivera', PW);
  const fin = await session('afinance', PW);
  const q = new Date(); const qm = Math.floor(q.getUTCMonth() / 3) * 3;
  const lastQ = [new Date(Date.UTC(q.getUTCFullYear(), qm - 3, 1)).toISOString().slice(0, 10), new Date(Date.UTC(q.getUTCFullYear(), qm, 0)).toISOString().slice(0, 10)];
  const times = {};
  for (const [who, s] of [['supervisor', sup], ['navigator', nav], ['finance', fin]]) {
    for (const [label, hash] of [['reports', '#/reports'], ['funder', '#/funder'], ['funder publication', `#/funder?from=${lastQ[0]}&to=${lastQ[1]}&purpose=publication`], ['budget', '#/budget']]) {
      if (who === 'navigator' && label === 'funder publication') continue;
      const r = await timePage(s, hash);
      times[`${who} ${label}`] = r.ms;
      ok(r.ms < 1000, `${who}: ${label} opens in under a second at seed size (${r.ms} ms)`, r.ms);
      if (r.said) ok(!/^Loading…$/.test(r.said), `${who}: while ${label} is worked out it says what it is doing ("${r.said}")`, r.said);
    }
  }
  measure('report page load ms (seed size, hash change to content)', times);

  // ------------------------------------------------------------------------------------------------------ 2
  const me = (await sup.api('GET', '/api/auth/me')).data;
  const mods = (me.programme && me.programme.modules) || {};
  const counts = {};
  {
    const sb = await sidebar(nav.page);
    counts.navigator = { main: sb.main.length, more: sb.more.length };
    for (const want of ['Home', 'Clients', 'Waitlist', 'To-dos', 'Visits', 'Calls & texts', 'Notes', 'Supplies', 'Referrals']) ok(sb.main.includes(want), `a navigator's main list has ${want}`, sb.main);
    ok(!sb.main.includes('My clients'), 'the client list is "Clients", not "My clients"', sb.main);
    ok(sb.more.includes('Funder report'), 'the funder report is under a navigator\'s More (their caseload\'s internal run), not gone', sb.more);
    ok(sb.more.includes('Reports') && !sb.more.includes('Waitlist'), 'Reports stays under More; Waitlist moved up', sb.more);
    await nav.go('funder');
    ok(await nav.page.$('[data-run-kind]'), 'the navigator\'s funder report opens');
    ok(/caseload/i.test(await nav.page.textContent('#main')), 'and says it counts their caseload');
  }
  {
    const sb = await sidebar(sup.page);
    counts.supervisor = { main: sb.main.length, more: sb.more.length };
    // 1.15.2: a supervisor's reporting pages are under More (their main list is the supervision queue, the
    // caseloads and the team's daily pages), still there exactly when the module is on.
    const all = [...sb.main, ...sb.more];
    eq(all.includes('State reporting'), !!mods.caloms || !!mods.handoff, `a supervisor sees State reporting exactly when CalOMS or the hand-off is on (${JSON.stringify({ caloms: mods.caloms, handoff: mods.handoff })})`);
    eq(all.includes('SUPRT-A'), !!mods.suprt, 'and SUPRT-A exactly when it is on');
    if (all.includes('State reporting')) { await openMore(sup.page); await sup.page.click('.sidebar a[href="#/caloms"]'); await settle(sup.page); eq(await sup.page.title(), 'State reporting — SUDS', 'the State reporting entry opens its page'); }
  }
  // Switching SUPRT-A on puts its entry in the menu; switching it off takes it away again.
  const admin = await session('admin', 'AdminPassw0rd!x');
  const suprtWas = !!mods.suprt;
  eq((await admin.api('PUT', '/api/admin/settings', { module_suprt: '1' })).status, 200, 'an administrator switches SUPRT-A on');
  await sup.page.reload(); await sup.page.waitForSelector('.layout'); await settle(sup.page);
  ok((await sidebar(sup.page)).more.includes('SUPRT-A'), 'SUPRT-A is in the supervisor\'s sidebar (under More) once it is on', await sidebar(sup.page));
  await openMore(sup.page); await sup.page.click('.sidebar a[href="#/suprt"]'); await settle(sup.page);
  ok(/SUPRT-A/.test(await sup.page.textContent('.main h1')), 'and opens its page');
  eq((await admin.api('PUT', '/api/admin/settings', { module_suprt: '0' })).status, 200, 'switched off again');
  await sup.page.reload(); await sup.page.waitForSelector('.layout'); await settle(sup.page);
  ok(![...(await sidebar(sup.page)).main, ...(await sidebar(sup.page)).more].includes('SUPRT-A'), 'and its entry goes');
  if (suprtWas) await admin.api('PUT', '/api/admin/settings', { module_suprt: '1' });
  counts.finance = (await sidebar(fin.page)).main.length;
  counts.admin = (await sidebar(admin.page)).main.length;
  measure('sidebar entries visible (main list, More)', counts);

  // ------------------------------------------------------------------------------------------------ 3 + 4
  await nav.go('dashboard');
  await nav.page.click('.appbar .quick'); await nav.page.waitForSelector('.modal .quick-list');
  const quick = await nav.page.$$eval('.modal .quick-list button', b => b.map(x => x.textContent.trim()));
  ok(quick.some(t => /Log a visit$/.test(t)), '+ Log offers "Log a visit"', quick);
  ok(quick.some(t => /Make a referral$/.test(t)), 'and "Make a referral"', quick);
  await nav.page.click('.modal .quick-list button:has-text("Make a referral")');
  ok(await until(() => nav.page.$('.modal .client-picker input[type=text]')), '+ Log › Make a referral opens the referral form, asking for the client');
  eq((await nav.page.textContent('.modal h2')).trim(), 'Make a referral', 'titled "Make a referral"');
  await nav.page.keyboard.press('Escape'); await settle(nav.page);
  ok(await nav.page.$('.card h2:text-is("To-dos for today")'), 'Home\'s to-do card is "To-dos for today"');
  await nav.go('clients'); eq((await nav.page.textContent('.main h1')).trim(), 'Clients', 'the client list is headed "Clients"');
  const restricted = (await nav.api('GET', '/api/auth/me')).data.user.caseload_restricted;
  eq(!!(await nav.page.$('[data-my-clients]')), !!restricted, '"My clients" is said only on a caseload-scoped worker\'s list');

  const { data: list } = await nav.api('GET', '/api/clients?limit=5&status=active');
  const cid = list.clients[0].id; const cname = list.clients[0].display_name;
  await nav.go(`client/${cid}/overview`);
  const acts = await nav.page.$$eval('.client-actions.wide button', b => b.map(x => x.textContent.trim()));
  ok(acts.includes('+ Log a visit') && acts.includes('+ Make a referral'), 'the client\'s quick actions include "+ Log a visit" and "+ Make a referral"', acts);
  await nav.page.click('.client-actions.wide button:has-text("+ Make a referral")');
  await until(() => nav.page.$('.modal select[name=consent_id], .modal [name=resource_id], .modal .client-picker'));
  const chosen = await nav.page.evaluate(() => { const m = document.querySelector('.modal'); const hid = m && m.querySelector('[name=client_id]'); const txt = m && m.querySelector('.client-picker input[type=text]'); return { id: hid ? hid.value : null, text: txt ? txt.value : (m ? m.textContent : '') }; });
  ok(chosen.id === cid || (chosen.text || '').includes(cname), 'the referral form opens with this client already chosen', { chosen, cid, cname });
  await nav.page.keyboard.press('Escape'); await settle(nav.page);

  // ------------------------------------------------------------------------------------------------------ 5
  const tabs = await nav.page.evaluate(() => {
    const strip = document.querySelector('.main nav.tabs');
    return { shown: [...strip.querySelectorAll(':scope > button[data-tab]')].filter(b => !b.hidden).map(b => b.dataset.tab), all: strip.querySelectorAll(':scope > button[data-tab]').length, more: strip.querySelector('.tabs-more')?.textContent.trim() };
  });
  measure('client record tabs at 1280 px (in the strip, in all)', { strip: tabs.shown.length, all: tabs.all });
  eq(tabs.shown.join(','), 'overview,interventions,notes,tasks,consents,referrals', 'at 1280 px the strip holds the six everyday sections');
  ok(/^More \(\d+\)/.test(tabs.more || ''), 'the rest are under More', tabs.more);
  ok(!(await nav.page.$('.main nav.tabs button[data-tab=timeline]')), 'Timeline is no longer a tab');
  ok(await nav.page.$('[data-recent-activity] .timeline li'), 'the Overview ends with the recent activity');
  await nav.page.click('.main nav.tabs .tabs-more');
  const more = await nav.page.$$eval('.main nav.tabs .tabs-menu button', b => b.map(x => x.textContent.trim()));
  ok(more.some(t => /^Calls/.test(t)) && more.includes('Care team'), 'More holds Calls, Care team and the rest', more);
  await axe(nav.page, 'client record, More open');
  await nav.page.keyboard.press('Escape');
  const allLink = await nav.page.$('[data-all-activity-link]');
  if (allLink) { await allLink.click(); await settle(nav.page); ok(await nav.page.$('[data-all-activity] .timeline li'), '"All activity" opens the whole history'); }
  else { await nav.go(`client/${cid}/timeline`); ok(await nav.page.$('[data-all-activity]'), 'the old Timeline address still opens the whole history'); }

  // ---------------------------------------------------------------------------------------------------- 6
  const banners = {};
  for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const s = await session('jwalker', PW, vp);
    await s.go('dashboard');
    const barH = await s.page.evaluate(() => { const b = document.querySelector('#banners [data-banner="mfa-required"]'); return b ? Math.round(b.getBoundingClientRect().height) : 0; });
    const appbar0 = await s.page.evaluate(() => Math.round(document.querySelector('.appbar').getBoundingClientRect().height));
    const dismiss = await s.page.$('#banners [data-banner="mfa-required"] button[aria-label=Dismiss]');
    if (dismiss) {
      await dismiss.click(); await settle(s.page);
      await s.page.reload(); await s.page.waitForSelector('.layout'); await settle(s.page);
      const after = await s.page.evaluate(() => ({ bar: !!document.querySelector('#banners [data-banner="mfa-required"]'), link: (() => { const l = document.querySelector('[data-mfa-link]'); return l ? Math.round(l.getBoundingClientRect().height) : 0; })(), appbar: Math.round(document.querySelector('.appbar').getBoundingClientRect().height) }));
      banners[vp.width] = { bar_before: barH, appbar_before: appbar0, bar_after: after.bar, link_height: after.link, appbar_after: after.appbar };
      ok(!after.bar && after.link > 0, `${vp.width} px: dismissed, the bar becomes the header's 2-step link`, after);
      ok(after.appbar <= appbar0 + 2, `${vp.width} px: the link adds no height to the header (${appbar0} → ${after.appbar} px)`, after);
      await s.api('PUT', '/api/me/prefs', { mfa_banner_collapsed: false });
    } else banners[vp.width] = { bar_before: barH, note: 'no two-step bar for this account' };
    ok(barH <= 50, `${vp.width} px: the two-step bar is one line (${barH} px)`, barH);
    // ---- 10: the bell's count on screen
    const bell = await s.page.evaluate(() => { const c = document.querySelector('.bell-count:not(.hidden)'); if (!c) return null; const r = c.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), vw: document.documentElement.clientWidth }; });
    if (bell) ok(bell.right <= bell.vw && bell.left >= 0 && bell.top >= 0, `${vp.width} px: the bell's count is fully on screen`, bell);
    await s.ctx.close();
  }
  measure('two-step bar and header (px)', banners);

  // ------------------------------------------------------------------------------------------------------ 7
  {
    const s = await session('dchen', PW, { width: 390, height: 844 }, { tourDone: false });
    await s.api('PUT', '/api/me/prefs', { tour_done: false });
    await s.go('dashboard');
    ok(await s.page.$('[data-welcome]'), 'a first sign-in shows the welcome as a card on Home');
    ok(!(await s.page.$('.modal-bg')), 'and no dialog over the page');
    measure('welcome: blocking dialogs on first sign-in', await s.page.$$eval('.modal-bg', m => m.length));
    await axe(s.page, 'Home with the welcome card at 390 px');
    await s.page.click('.fab button'); await s.page.waitForSelector('.modal .quick-list');
    await s.page.click('.modal .quick-list button:has-text("Log a visit")');
    ok(await until(() => s.page.$('.modal select[name=type]')), 'with the welcome showing, + Log › Log a visit opens the visit form at once');
    await s.page.keyboard.press('Escape'); await settle(s.page);
    await s.page.click('[data-welcome-done]'); await settle(s.page);
    ok(!(await s.page.$('[data-welcome]')), '"Got it" puts it away');
    eq(await s.page.evaluate(() => document.activeElement?.tagName), 'H1', 'and focus goes to the page heading');
    await s.go('dashboard?_=1'); ok(!(await s.page.$('[data-welcome]')), 'and it stays away');
    await s.go('dashboard?welcome=1'); ok(await s.page.$('[data-welcome]'), 'Help (#/dashboard?welcome=1) brings it back');
    ok(await s.page.$('.sidebar a[data-help-link]'), 'the menu has Help');
    await s.ctx.close();
  }

  // ------------------------------------------------------------------------------------------------------ 8
  await nav.go('dashboard');
  const navPills = await nav.page.$$eval('.main a.badge', b => b.map(x => x.textContent));
  ok(!navPills.some(t => /overdue to-do/.test(t)), 'a navigator\'s own overdue to-dos are not repeated as a pill on Home (the bell counts them)', navPills);
  const bellN = await nav.page.evaluate(() => document.querySelector('.bell-count')?.textContent || '0');
  const listed = await nav.page.$$eval('.today-item[data-overdue="1"]', x => x.length);
  measure('places the navigator\'s overdue to-do count appears (bell, pills, card)', { bell: Number(bellN), pills: navPills.filter(t => /overdue/.test(t)).length, listed_in_card: listed });
  await sup.go('dashboard');
  const supPills = await sup.page.$$eval('.main a.badge', b => b.map(x => x.textContent));
  const teamPill = supPills.find(t => /overdue to-do/.test(t));
  if (teamPill) ok(/across the team/.test(teamPill), 'a supervisor\'s pill says it is the team\'s count', teamPill);

  // ------------------------------------------------------------------------------------------------------ 9
  await nav.go('supplies');
  ok(await nav.page.$('[data-supply-hand-out]'), 'Supplies has "Hand out"');
  await nav.page.click('[data-supply-hand-out]');
  await nav.page.waitForSelector('.modal select[name=type]');
  eq(await nav.page.$eval('.modal select[name=type]', s => s.value), 'naloxone_distribution', 'Hand out opens the visit form as a naloxone distribution');
  eq((await nav.page.textContent('.modal h2')).trim(), 'Log a visit', 'titled "Log a visit"');
  ok(/optional/i.test(await nav.page.textContent('.modal [data-field="client_id"] label')), 'with the client optional (an anonymous handout)');
  await nav.page.keyboard.press('Escape'); await settle(nav.page);
  const row = await nav.page.$('[data-hand-out-item]');
  if (row) {
    const item = await row.getAttribute('data-hand-out-item');
    await row.click(); await nav.page.waitForSelector('.modal [data-supply-picker]');
    eq(await nav.page.$eval(`.modal [data-supply-row="${item}"] input`, i => i.value), '1', 'an item\'s Hand out puts one of it on the visit');
    await nav.page.keyboard.press('Escape'); await settle(nav.page);
  }
  // An anonymous handout saved from here counts on Home, and Home's tile opens the visits behind it.
  const d0 = (await nav.api('GET', '/api/reports/dashboard')).data.interventions.naloxone_kits;
  eq((await nav.api('POST', '/api/interventions', { type: 'post_overdose_follow_up', client_id: cid, occurred_at: new Date().toISOString(), naloxone_kits: 2 })).status, 201, 'two kits handed out on a follow-up visit');
  const d1 = (await nav.api('GET', '/api/reports/dashboard')).data.interventions.naloxone_kits;
  eq(d1, d0 + 2, 'Home\'s kit count includes kits on a visit that is not a distribution');
  await nav.go('dashboard');
  await nav.page.click('.stat:has-text("Naloxone kits given")'); await settle(nav.page);
  ok(await nav.page.$('[data-naloxone-filter]'), 'the tile opens the visits that handed out kits');
  const sum = await nav.api('GET', `/api/interventions?naloxone=1&limit=500&${new URL(nav.page.url()).hash.split('?')[1]}`);
  eq(sum.data.rows.reduce((n, x) => n + x.naloxone_kits, 0), d1, 'and those visits add up to the tile');

  // ----------------------------------------------------------------------------------------------------- 10
  {
    const s = await session('mrivera', PW, { width: 390, height: 844 });
    await s.go('supplies');
    const strip = await s.page.evaluate(() => {
      const t = document.querySelector('.main nav.tabs'); const ssp = t.querySelector('[data-tab=ssp]'); const r = ssp.getBoundingClientRect();
      return { label: ssp.textContent.trim(), cue: !!document.querySelector('.tabs-scroll.more-right [data-tabs-cue=right]') && getComputedStyle(document.querySelector('[data-tabs-cue=right]')).display !== 'none', scrolls: t.scrollWidth > t.clientWidth, right: Math.round(r.right), vw: document.documentElement.clientWidth };
    });
    measure('Supplies tab strip at 390 px', strip);
    ok(/^SSP report/.test(strip.label), 'the tab reads "SSP report"', strip.label);
    ok(/syringe services/i.test(strip.label), 'its accessible name keeps the full name', strip.label);
    if (strip.scrolls) ok(strip.cue, 'a strip wider than the screen shows a › cue', strip);
    else ok(strip.right <= strip.vw, 'the whole strip fits the screen', strip);
    await s.page.click('.main nav.tabs [data-tab=ssp]'); await settle(s.page);
    ok(await s.page.$('[data-ssp-report] h2'), 'the SSP report opens, headed with its full name');
    const vis = await s.page.evaluate(() => { const a = document.querySelector('.main nav.tabs [data-tab=ssp]'); const r = a.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth + 1; });
    ok(vis, 'and its tab is scrolled into view');
    await axe(s.page, 'Supplies › SSP report at 390 px');
    await s.ctx.close();
  }
} catch (e) { fail(`the script stopped: ${e.stack || e.message}`); }
await browser.close();
finish(errors);

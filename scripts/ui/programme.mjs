// The repositioning around harm reduction & outreach, checked in a browser:
//   1. the programme profile — Settings › Programme chooses harm reduction or treatment-adjacent, and switches
//      single clinical modules; a module switched off leaves the client tabs, the Overview and Reports;
//   2. role-based navigation — a navigator's sidebar is the pages they use every day, the programme's pages
//      grouped under "Programme" for the roles that run it; no budget tile on a navigator's Home;
//   3. one word per concept — "Visit" and "To-do" wherever they are offered;
//   4. the client record on a 390×844 phone — one "Add…" button, the everyday tabs, and the tab strip in the
//      upper half of the screen;
//   5. Settings › Programme in folded sections with headings, opened from the keyboard;
//   6. the Reports exports in three described groups.
// The dev seed is a treatment-adjacent programme (scripts/seed.js); this script switches the profile itself.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('programme');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
const browser = await chromium.launch();
const errors = [];

async function session(username, password, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 });
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) }));
  await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
  return { ctx, page, api, go };
}
// WCAG 2.1 A/AA with axe, as scripts/ui/accessibility.mjs runs it, on what is on screen now.
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
  // A link's name without its icon (the icon is aria-hidden).
  const name = (a) => [...a.childNodes].filter(n => !(n.classList && n.classList.contains('ico'))).map(n => n.textContent).join('').trim();
  const main = [...nav.querySelectorAll(':scope > a')].map(name);
  return { main, sections: [...nav.querySelectorAll(':scope > .sec')].map(s => s.textContent.trim()), more: more ? [...more.querySelectorAll('a')].map(name) : null, moreOpen: more ? more.open : null };
});

try {
  // ------------------------------------------------------------------------------------------------ 2 + 3
  const nav = await session('mrivera', PW);
  {
    const sb = await sidebar(nav.page);
    // 1.23.0: Street outreach joined the main list (12 pages; test/nav-menu.test.js holds the placement per role and profile).
    ok(sb.main.length <= 12, `a navigator's sidebar shows ${sb.main.length} pages, not 19`, sb.main);
    for (const want of ['Home', 'Clients', 'Waitlist', 'To-dos', 'Visits', 'Calls & texts', 'Supplies', 'Street outreach', 'Resource directory']) ok(sb.main.includes(want), `the navigator's sidebar has ${want}`, sb.main);
    // The funder report is under More (1.14.0): a navigator runs it for their own caseload.
    ok(!sb.main.includes('Settings') && !(sb.more || []).includes('Settings'), 'Settings is not in a navigator\'s sidebar', sb);
    // 1.23.0: every page a navigator may open is in the menu: the programme's money and contracts under More.
    for (const p of ['Funding & spending', 'Policies & contracts']) ok(!sb.main.includes(p) && (sb.more || []).includes(p), `${p} is under a navigator's More, not in the everyday list`, sb);
    ok(!sb.main.includes('Import'), 'Import is not in the everyday list', sb.main);
    ok(!sb.sections.includes('Program'), 'a navigator has no Program section', sb.sections);
    ok(sb.more && sb.more.includes('Reports') && sb.more.includes('Funder report') && sb.more.includes('My time') && sb.more.includes('Import'), 'the rest of what a navigator may open is folded under More', sb.more);
    eq(sb.moreOpen, false, 'and More starts closed');
    // More is a native disclosure: the keyboard opens it.
    await nav.page.focus('.sidebar details.nav-more > summary'); await nav.page.keyboard.press('Enter');
    eq(await nav.page.$eval('.sidebar details.nav-more', d => d.open), true, 'Enter on "More" opens it');
    // The pages are still reachable at their address: presentation, not permission.
    await nav.go('budget');
    ok(!/Not available for your role/.test(await nav.page.textContent('#main')), 'a navigator can still open Funding & spending by its address (permissions unchanged)');
    await nav.go('dashboard');
    ok(!/Spent of budget/.test(await nav.page.textContent('#main')), 'a navigator\'s Home has no budget tile');
    ok(/Visits \(90 days\)/.test(await nav.page.textContent('#main')), 'Home counts "Visits"');
    // + Log speaks the same words as the rest of the app.
    await nav.page.click('.appbar .quick'); await nav.page.waitForSelector('.modal .quick-list');
    const quick = await nav.page.$$eval('.modal .quick-list button', b => b.map(x => x.textContent.trim()));
    ok(quick.some(t => /^✚\s*Log a visit$/.test(t)) && quick.some(t => /^☑\s*To-do$/.test(t)), '+ Log offers "Log a visit" and "To-do"', quick);
    ok(!quick.some(t => /service|Reminder/.test(t)), 'not "Visit or service" or "Reminder / to-do"', quick);
    await nav.page.keyboard.press('Escape');
    await nav.go('interventions'); eq((await nav.page.textContent('.main h1')).trim(), 'Visits', 'the Visits page is called Visits');
    await nav.go('tasks'); eq((await nav.page.textContent('.main h1')).trim(), 'To-dos', 'the To-dos page is called To-dos');
  }
  const sup = await session('jwalker', PW);
  {
    const sb = await sidebar(sup.page);
    // 1.15.2: a supervisor's main list is their supervision queue, caseloads (Settings › Move a caseload) and the
    // team's daily pages; the programme's pages are one click away under More, not gone.
    ok(sb.sections.includes('Program'), 'a supervisor has the Program section (for Settings: caseloads and the audit log)', sb.sections);
    ok(sb.main.includes('Settings'), 'with Settings in the main list', sb.main);
    for (const want of ['Funding & spending', 'Policies & contracts', 'Funder report', 'Import', 'Reports']) ok((sb.more || []).includes(want), `and ${want} under More`, sb);
    ok(/Spent of budget/.test(await sup.page.textContent('#main')), 'a supervisor\'s Home keeps the budget tile');
  }

  // ---------------------------------------------------------------------------------------------------- 4
  const { data: list } = await nav.api('GET', '/api/clients?limit=5&status=active');
  const cid = list.clients[0].id;
  const phone = await session('mrivera', PW, { width: 390, height: 844 });
  {
    await phone.go(`client/${cid}/overview`);
    const m = await phone.page.evaluate(() => {
      const strip = document.querySelector('.main nav.tabs'); const r = strip.getBoundingClientRect();
      const shown = [...strip.querySelectorAll(':scope > button[data-tab]')].filter(b => !b.hidden).map(b => b.dataset.tab);
      const wide = document.querySelector('.client-actions.wide'); const add = document.querySelector('[data-client-add]');
      return { top: Math.round(r.top + window.scrollY), shown, wideShown: !!wide && getComputedStyle(wide).display !== 'none', addShown: !!add && add.offsetParent !== null, banner: !!document.querySelector('#banners .banner') };
    });
    ok(m.top < 844 / 2, `at 390×844 the client's tab strip starts in the upper half of the screen (y=${m.top}${m.banner ? ', with the two-step banner showing' : ''})`, m);
    eq(m.shown.join(','), 'overview,interventions,notes,tasks,consents,referrals', 'the strip shows the everyday sections; the rest are under More');
    ok(!m.wideShown && m.addShown, 'the row of action buttons is one "Add…" button on a phone', m);
    const labels = await phone.page.$$eval('.main nav.tabs > button[data-tab]:not([hidden])', b => b.map(x => x.textContent.trim()));
    ok(labels.some(t => /^Visits \(\d+\)$/.test(t)) && labels.some(t => /^To-dos \(\d+\)$/.test(t)), 'its tabs say "Visits" and "To-dos"', labels);
    await phone.page.click('[data-client-add]');
    const items = await phone.page.$$eval('.client-actions.narrow .add-list button', b => b.map(x => x.textContent.trim()));
    ok(['Log a visit', 'Call', 'Text message', 'Note', 'To-do', 'Make a referral'].every(x => items.includes(x)), 'Add… lists Log a visit, Call, Text message, Note, To-do and Make a referral', items);
    eq(await phone.page.$eval('[data-client-add]', b => b.getAttribute('aria-expanded')), 'true', 'Add… says it is expanded');
    eq(await phone.page.evaluate(() => document.activeElement?.textContent.trim()), items[0], 'focus moves to the first thing to add');
    await axe(phone.page, 'client record on a phone, Add… open');
    await phone.page.keyboard.press('Escape');
    eq(await phone.page.evaluate(() => document.activeElement?.dataset.clientAdd), '1', 'Escape closes it and focus returns to Add…');
    await phone.page.click('[data-client-add]'); await phone.page.click('.client-actions.narrow .add-list button:has-text("To-do")');
    ok(await until(() => phone.page.$('.modal input[name=title]')), 'choosing To-do opens the to-do form for this client');
    await phone.page.keyboard.press('Escape');
    // Past the everyday tabs: More still reaches every section.
    await phone.page.click('.main nav.tabs .tabs-more');
    const more = await phone.page.$$eval('.main nav.tabs .tabs-menu button', b => b.map(x => x.textContent.trim()));
    // Timeline is the Overview's recent activity since 1.14.0, not a tab.
    ok(more.includes('Care team') && more.some(t => /^Calls/.test(t)), 'the other sections are under More', more);
    await phone.page.keyboard.press('Escape');
    // A dismissed two-step banner comes back as a small link in the header, not a bar.
    if (m.banner && await phone.page.$('#banners [data-banner="mfa-required"] button[aria-label=Dismiss]')) {
      await phone.page.click('#banners [data-banner="mfa-required"] button[aria-label=Dismiss]'); await settle(phone.page);
      await phone.page.reload(); await phone.page.waitForSelector('.layout'); await settle(phone.page);
      ok(!(await phone.page.$('#banners [data-banner="mfa-required"]')), 'the two-step banner, dismissed once, does not come back as a bar');
      ok(await phone.page.$('.appbar [data-mfa-link]'), 'it is a link in the header instead');
    }
  }

  // ------------------------------------------------------------------------------------------------ 5 + 1
  const admin = await session('admin', 'AdminPassw0rd!x');
  {
    await admin.go('admin?tab=settings');
    const tabs = await admin.page.$$eval('.main nav.tabs button', b => b.map(x => x.textContent.trim()));
    ok(tabs.includes('Program') && !tabs.includes('Settings'), 'the Settings tab inside Settings is now "Program"', tabs);
    eq(await admin.page.title(), 'Program · Settings — SUDS', 'and the page title says so');
    const secs = await admin.page.$$eval('details.section[data-section]', d => d.map(x => ({ h: x.querySelector('summary h3')?.textContent.trim(), open: x.open })));
    ok(secs.length >= 4 && secs.every(s => s.h), 'the programme settings are in sections, each with a heading', secs);
    ok(secs[0] && secs[0].open && secs.slice(1).every(s => !s.open), 'the first is open and the rest folded', secs);
    const tall = await admin.page.$eval('[data-section]', d => d.closest('.card').getBoundingClientRect().height);
    ok(tall < 2000, `the settings card is ${Math.round(tall)}px tall with its sections folded`, tall);
    await admin.page.focus('details.section[data-section="Security policy"] > summary'); await admin.page.keyboard.press('Enter');
    eq(await admin.page.$eval('details.section[data-section="Security policy"]', d => d.open), true, 'a section opens from the keyboard');
    await admin.page.evaluate(() => document.querySelectorAll('details.section').forEach(d => { d.open = true; }));
    await axe(admin.page, 'Settings › Program, every section open');
    // The programme profile.
    ok(await admin.page.$('[data-programme-profile=treatment]'), 'the seeded programme is treatment-adjacent');
    ok(await admin.page.$('.main nav.tabs button[data-tab=fhir]'), 'with the FHIR clients tab');
    await admin.page.selectOption('select[name=programme_profile]', 'harm_reduction');
    await admin.page.click('button[type=submit]:has-text("Save program profile")');
    ok(await until(() => admin.page.$('[data-programme-profile=harm_reduction]')), 'switching to harm reduction & outreach saves');
    ok(!(await admin.page.$('.main nav.tabs button[data-tab=fhir]')), 'and the FHIR clients tab goes with the FHIR module');
    eq(await admin.page.$eval('[data-modules-on]', e => e.dataset.modulesOn), '0', 'no clinical module is on');
  }
  {
    // A navigator's client record, Overview and Reports without the clinical modules.
    const n2 = await session('mrivera', PW);
    await n2.go(`client/${cid}/overview`);
    const t = await n2.page.$$eval('.main nav.tabs button[data-tab]', b => b.map(x => x.dataset.tab));
    ok(!t.includes('problems') && !t.includes('careplan') && !t.includes('assessments'), 'the client record has no Problems, Care plan or Assessments tab', t);
    ok(!(await n2.page.$('[data-overview-problems], [data-overview-careplan], [data-overview-asam]')), 'and the Overview no clinical picture');
    await n2.go(`client/${cid}/careplan`);
    ok(!/This page could not be shown/.test(await n2.page.textContent('#main')), 'a care plan made earlier can still be opened at its address');
    // 1.24.0: opened at its address while the module is off, it is read only: it says so, and offers no form the server would refuse.
    ok(await until(() => n2.page.$('[data-module-off=careplan]')), 'the care plan opened at its address says the module is switched off');
    ok(!(await n2.page.$('[data-add-goal], [data-empty-action=goal], [data-edit-goal], [data-add-step]')), 'and offers no goal or step to add or edit');
    await n2.go(`client/${cid}/problems`);
    ok(await until(() => n2.page.$('[data-module-off=careplan]')), 'the problem list at its address says so too');
    ok(!(await n2.page.$('[data-add-problem], [data-empty-action=problem], [data-edit-problem], [data-resolve-problem]')), 'and offers no problem to add, edit or resolve');
    {
      const c2 = await session('kpatel', PW);
      await c2.go(`client/${cid}/assessments`);
      ok(await until(() => c2.page.$('[data-module-off=assessments]')), 'a clinician\'s Assessments at its address says the module is switched off');
      ok(!(await c2.page.$('[data-add-asam], [data-add-outcome]')), 'and offers no six-dimension assessment or screening to fill in (the save would be refused)');
      await c2.ctx.close();
    }
    await n2.go('reports');
    ok(!(await n2.page.$('[data-state-reporting-link]')) && !(await n2.page.$('[data-outcomes-report]')), 'Reports has no State reporting or outcome measures card');
    const r = await n2.api('POST', `/api/clients/${cid}/problems`, { problem: 'x' });
    eq(r.status, 403, 'a new problem-list entry is refused while the module is off');
    await n2.ctx.close();
    // One module back on its own.
    await admin.page.selectOption('select[name=module_careplan]', '1');
    await admin.page.click('button[type=submit]:has-text("Save program profile")');
    ok(await until(async () => (await admin.page.$eval('[data-modules-on]', e => e.dataset.modulesOn).catch(() => '0')) === '1'), 'the care plan module switches on by itself');
    const n3 = await session('mrivera', PW);
    await n3.go(`client/${cid}/overview`);
    const t3 = await n3.page.$$eval('.main nav.tabs button[data-tab]', b => b.map(x => x.dataset.tab));
    ok(t3.includes('careplan') && t3.includes('problems'), 'and Problems and Care plan are back on the client record', t3);
    await n3.ctx.close();
    // Back as the seed had it, for anything run after.
    await admin.api('PUT', '/api/admin/settings', { programme_profile: 'treatment', module_careplan: null });
  }
  {
    // QA 1.15.3, item 24: with the treatment-adjacent profile (its clinical modules on), a clinician's client
    // record promotes Care plan and Assessments into the tab strip (1.15.2), at desktop and phone widths:
    // shown as tabs, not folded under More.
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const cl = await session('kpatel', PW, viewport);
      const W = `clinician at ${viewport.width}px`;
      const mods = await cl.page.evaluate(async () => { const a = await import('./app.js'); return ['careplan', 'assessments'].map(m => a.moduleOn(m)); });
      eq(mods.join(','), 'true,true', `${W}: the treatment-adjacent profile has Care plan and Assessments on`);
      if (viewport.width === 1280) {
        // 1.24.0: a programme not known yet means a module is off (no form the server might refuse), and it is fetched again.
        const unknown = await cl.page.evaluate(async () => { const a = await import('./app.js'); a.state.programme = null; return a.moduleOn('assessments'); });
        eq(unknown, false, `${W}: with the programme unknown, a module counts as off`);
        ok(await until(() => cl.page.evaluate(async () => (await import('./app.js')).moduleOn('assessments'))), `${W}: and the programme is fetched again, so the module is back on`);
      }
      const kid = (await cl.api('GET', '/api/clients?limit=1')).data.clients[0].id;
      await cl.go(`client/${kid}/overview`);
      await until(() => cl.page.$('.main nav.tabs button[data-tab=careplan]'));
      const strip = await cl.page.evaluate(() => {
        const vis = (b) => !!b && !b.hidden && b.offsetParent !== null && b.getBoundingClientRect().width > 0;
        const tab = (k) => document.querySelector(`.main nav.tabs button[data-tab=${k}]`);
        const more = [...document.querySelectorAll('.main nav.tabs [role=menuitem]')].map(x => x.textContent.trim());
        return { careplan: vis(tab('careplan')), assessments: vis(tab('assessments')), more };
      });
      ok(strip.careplan, `${W}: Care plan is a visible tab`, strip);
      ok(strip.assessments, `${W}: Assessments is a visible tab`, strip);
      ok(!strip.more.some(x => /^(Care plan|Assessments)/.test(x)), `${W}: and neither is under More`, strip.more);
      await cl.ctx.close();
    }
  }

  // ---------------------------------------------------------------------------------------------------- 6
  {
    await sup.go('reports');
    const groups = await sup.page.$$eval('[data-export-group]', g => g.map(x => ({ k: x.dataset.exportGroup, h: x.querySelector('h3')?.textContent.trim(), p: !!x.querySelector('p') })));
    eq(groups.map(g => g.k).join(','), 'programme,deidentified,identified', 'a supervisor sees the exports in three groups');
    ok(groups.every(g => g.h && g.p), 'each with a heading and a description', groups);
    ok(await sup.page.$('[data-export-group=deidentified] button:has-text("Visits (Excel)")'), 'the Visits export is a de-identified record');
    ok(await sup.page.$('[data-export-group=identified] [data-identified-export]'), 'the identified workbook is in its own group');
    await axe(sup.page, 'Reports with the export groups');
    await nav.go('reports');
    const ng = await nav.page.$$eval('[data-export-group]', g => g.map(x => x.dataset.exportGroup));
    eq(ng.join(','), 'programme,deidentified', 'a navigator (no identified exports) sees two');
  }
  await admin.ctx.close(); await sup.ctx.close(); await nav.ctx.close(); await phone.ctx.close();
} catch (e) { fail(e.message.split('\n')[0]); }
finish(errors);
await browser.close();

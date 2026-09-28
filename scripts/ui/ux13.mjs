// The 1.15.3 usability fixes, in a browser, one block per item of the owner's list:
//    2/12. "Also log this as a time entry" starts unticked on every visit (and call); ticked, the minutes are said
//          and a prefilled duration nobody changed is confirmed; time by hand on a day and client a visit already
//          logged asks before saving;
//    4/16. the bell opens a panel (what is due, "Updated …", Refresh) and asks again after a save and on focus;
//    5/14. the search box ranks: exact name first, sound-alikes dropped when something matched better, each result
//          says what it is;
//    6/17. an expiring consent is named at the top of the client's Overview, with the way to the Consents tab;
//      10. an unsent visit is offered back ("Resume your unsent visit?") to the same person only;
//      11. the same client, day and kind of visit asks before a second is saved;
//      13. a new visit shows at most seven fields at 390 px (a new visit, outreach, naloxone distribution);
//      15. keyboard shortcuts (/, n, ?, Ctrl+Enter), and the profile switch that turns the single keys off;
//      18. deactivate a resource, retire a document, end an assignment: done at once, with an Undo toast;
//      19. an empty list says what to do next, or who can;
//      20. "Your first day" in the welcome card, per role (none for an administrator: "Finish setting up");
//      21. the inline help on the Part 2 consent form and the supply adjustments, and the funder report's own;
//      22. 200% browser zoom (640×400 CSS px at device scale 2): no sideways scroll and no tab past the edge.
// Pages it changes are checked with axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('ux13');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function signIn(page, username, password) {
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
}
async function session(username, password = PW, ctxOpts = { viewport: { width: 1280, height: 900 } }, prefs = { tour_done: true }) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await signIn(page, username, password);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  await api('PUT', '/api/me/prefs', { visit_sections: null, visit_last: null, shortcuts_off: null, ...prefs });
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
const top = '#modal-root > .modal-bg:last-child';
const dialogTitle = (page) => page.$eval(`${top} h2`, e => e.textContent.trim()).catch(() => null);
const dialogs = (page) => page.$$eval('#modal-root > .modal-bg', x => x.length);
const closeModals = async (page) => { for (let i = 0; i < 5 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await settle(page); } };
const openVisit = async (page, opts = {}) => {
  await page.evaluate(async (o) => (await import('./views/interventions.js')).openInterventionForm(null, o), opts);
  await page.waitForSelector('.modal select[name=type]'); await settle(page);
};
const save = async (page) => { await page.click(`${top} .btn-row button[type=submit]`); await settle(page); };
// The question a Save may ask first (a duplicate visit): answered the way this step needs, if it was asked.
const answerIf = async (page, title, button) => { if ((await dialogTitle(page)) === title) { await page.click(`${top} .btn-row button:has-text("${button}")`); await settle(page); return true; } return false; };
// First names unique to this run, so a second run against the same server is not refused as a duplicate.
const tag = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const liveText = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map(e => e.textContent).join(' | '));

try {
  const nav = await session('mrivera');
  const sup = await session('jwalker');
  const admin = await session('admin', 'AdminPassw0rd!x');
  const meNav = (await nav.api('GET', '/api/auth/me')).data.user;
  const mine = (await nav.api('GET', '/api/clients?limit=20')).data.clients;
  ok(mine.length >= 3, 'the navigator has clients on their caseload', mine.length);
  const [c1, c2, c3] = mine;

  // ------------------------------------------------------------------------------------------ 2 / 12: time
  {
    const { page, api } = nav;
    await openVisit(page, { clientId: c3.id, clientDisplay: c3.display_name });
    ok(!(await page.isChecked('.modal input[name=log_time]')), 'a new visit starts with "Also log this as a time entry" unticked');
    ok(/starts unticked on every visit/.test(await page.textContent('.modal [data-field="log_time"] .help')), 'and its help says so, not that it starts on');
    await page.selectOption('.modal select[name=type]', 'case_management');
    await page.fill('.modal textarea[name=summary]', 'ux13 time check');
    await page.click('.modal details[data-section-key="time"] > summary');
    await page.check('.modal input[name=log_time]');
    ok(/Adds 30 min of direct service to your time/.test(await page.textContent('.modal [data-field="log_time"] .help')), 'ticked, it says how many minutes it adds');
    await save(page);
    await answerIf(page, 'Save another visit?', 'Save another');
    eq(await dialogTitle(page), 'Log this time?', 'Save with the prefilled 30 minutes asks before logging them');
    ok(/adds 30 minutes/.test(await page.textContent(`${top} p`)), 'naming the minutes', await page.textContent(`${top} p`).catch(() => ''));
    await page.click(`${top} .btn-row button:has-text("Change the duration")`); await settle(page);
    eq(await dialogs(page), 1, '"Change the duration" goes back to the visit, nothing saved');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.name === 'duration_minutes'), 'with the cursor in Duration');
    await page.fill('.modal input[name=duration_minutes]', '45');
    const resp = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/interventions');
    await save(page);
    await answerIf(page, 'Save another visit?', 'Save another');
    const saved = await (await resp).json();
    await until(async () => (await dialogs(page)) === 0);
    const te = (await api('GET', `/api/time?source=visit&from=${today}&to=${today}`)).data.rows.find(r => r.intervention_id === saved.id);
    eq(te && te.minutes, 45, 'a duration the person changed is logged without asking again');
    await openVisit(page, { clientId: c3.id, clientDisplay: c3.display_name });
    ok(!(await page.isChecked('.modal input[name=log_time]')), 'the next visit starts unticked again (the last choice is not remembered)');
    await closeModals(page);
    // A call starts unticked too.
    await page.evaluate(async () => (await import('./views/calls.js')).openCallForm(null, {}));
    await page.waitForSelector('.modal input[name=log_time]');
    ok(!(await page.isChecked('.modal input[name=log_time]')), 'a new call starts with "Also log as time entry" unticked');
    await page.check('.modal input[name=log_time]');
    ok(/Adds 5 min/.test(await page.textContent('.modal [data-field="log_time"] .help')), 'and ticked, says the minutes it adds');
    await closeModals(page);
    // Time by hand for that client and day: the notice, then a question on Save.
    await page.evaluate(async ({ id, name }) => (await import('./views/time.js')).openTimeForm(null, { clientId: id, clientDisplay: name }), { id: c3.id, name: c3.display_name });
    await page.waitForSelector('.modal input[name=minutes]');
    const warn = await until(async () => { const t = await page.$eval('.modal [data-time-overlap]', e => (e.classList.contains('hidden') ? '' : e.textContent)).catch(() => ''); return t || null; });
    ok(warn && /already logged by .*visit/.test(warn), 'the time form says a visit already logged time with this client that day', warn);
    await page.fill('.modal input[name=minutes]', '20');
    const before = (await api('GET', `/api/time?source=manual&from=${today}&to=${today}`)).data.rows.length;
    await save(page);
    eq(await dialogTitle(page), 'Log this time as well?', 'Log time asks before saving what may be the same work twice');
    await page.click(`${top} .btn-row button:has-text("Go back")`); await settle(page);
    eq((await api('GET', `/api/time?source=manual&from=${today}&to=${today}`)).data.rows.length, before, '"Go back" saves nothing');
    await save(page);
    await page.click(`${top} .btn-row button:has-text("Log it anyway")`); await settle(page);
    await until(async () => (await dialogs(page)) === 0);
    eq((await api('GET', `/api/time?source=manual&from=${today}&to=${today}`)).data.rows.length, before + 1, '"Log it anyway" saves it: a warning, not a block');
  }

  // --------------------------------------------------------------------------------------- 4 / 16: the bell
  {
    const { page, api, go } = nav;
    await go('dashboard');
    eq(await page.getAttribute('[data-due-bell]', 'aria-expanded'), 'false', 'the bell is a button that opens a panel');
    const count = () => page.$eval('[data-due-bell] .bell-count', c => (c.classList.contains('hidden') ? 0 : Number(c.textContent)));
    await page.click('[data-due-bell]'); await settle(page);
    ok(await page.isVisible('[data-due-panel]'), 'the panel opens');
    eq(await page.getAttribute('[data-due-bell]', 'aria-expanded'), 'true', 'and the button says so');
    ok(/^Updated (just now|\d+ min ago)$/.test((await page.textContent('[data-due-updated]')).trim()), 'it says when the list was last asked for', await page.textContent('[data-due-updated]'));
    ok(await page.$('[data-due-panel] [data-due-refresh]'), 'with a Refresh button');
    await page.click('[data-due-refresh]'); await settle(page);
    ok(/Updated just now/.test(await liveText(page)), 'Refresh says, out loud, that it updated');
    await page.keyboard.press('Escape'); await settle(page);
    ok(!(await page.isVisible('[data-due-panel]')), 'Escape puts the panel away');
    const n0 = await count();
    // Saved through the app (as a form does): the bell asks again shortly, not in five minutes.
    await page.evaluate(async (id) => (await import('./app.js')).post('/api/tasks', { title: 'ux13 bell after a save', due_at: new Date(Date.now() - 60000).toISOString(), assigned_to: id }), meNav.id);
    eq(await until(async () => ((await count()) === n0 + 1 ? n0 + 1 : null), { timeout: 8000 }), n0 + 1, 'a to-do saved in the app shows on the bell within seconds');
    // Saved elsewhere (another device): the window getting focus asks again.
    await api('POST', '/api/tasks', { title: 'ux13 bell on focus', due_at: new Date(Date.now() - 60000).toISOString(), assigned_to: meNav.id });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    eq(await until(async () => ((await count()) === n0 + 2 ? n0 + 2 : null), { timeout: 8000 }), n0 + 2, 'one saved on another device shows when the window gets focus');
    await page.click('[data-due-bell]'); await settle(page);
    ok(/ux13 bell on focus/.test(await page.textContent('[data-due-panel]')), 'the panel lists what is due');
    await axe(page, 'Home with the bell panel open');
    await page.keyboard.press('Escape');
  }

  // --------------------------------------------------------------------------------- 5 / 14: ranked search
  {
    const { page, api, go } = sup;
    for (const [first, last] of [['Vic', 'Brackenburne'], ['Wyn', 'Brekenberry'], ['Ula', 'Brackenbury']]) eq((await api('POST', '/api/clients', { first_name: first + tag, last_name: last, no_episode: true })).status, 201, `a client ${first} ${last}`);
    await go('dashboard');
    const box = '.topbar .gsearch input[type=search], .appbar .gsearch input[type=search]';
    const input = (await page.$$(box)).length ? box : '.gsearch input[type=search]';
    await page.fill(input, 'Brackenbury');
    const hits = await until(async () => { const r = await page.$$eval('.search-results:not(.hidden) a.search-hit', as => as.map(a => ({ text: a.textContent.trim(), kind: a.dataset.searchKind, label: [...(a.querySelector('[data-result-type]')?.childNodes || [])].filter(n => !(n.getAttribute && n.getAttribute('aria-hidden') === 'true')).map(n => n.textContent).join('').trim() }))); return r.length ? r : null; });
    ok(hits && /Brackenbury, Ula/.test(hits[0].text), 'the exact surname is the first result', hits);
    ok(hits && hits.some(h => /Brackenburne/.test(h.text)), 'a name starting the same way is listed after it', hits);
    ok(hits && !hits.some(h => /Brekenberry/.test(h.text)), 'a name that only sounds alike is left out when something matched better', hits);
    ok(hits && hits.filter(h => h.kind === 'client').every(h => /^Client$/.test(h.label)), 'each result says in words what it is ("Client"), the icon hidden from screen readers', hits);
    await axe(page, 'Home with search results open');
    await page.fill(input, 'Brekenbery');
    const typo = await until(async () => { const r = await page.$$eval('.search-results:not(.hidden) a.search-hit', as => as.map(a => a.textContent)); return r.some(t => /Brekenberry/.test(t)) ? r : null; });
    ok(typo && typo.some(t => /Brekenberry/.test(t)), 'a misspelling with nothing better still finds the sound-alike', typo);
    await page.fill(input, '');
  }

  // ----------------------------------------------------------------------------- 6 / 17: expiring consent
  {
    const { page, api, go } = sup;
    const c = (await api('POST', '/api/clients', { first_name: 'Cora' + tag, last_name: 'Expiring', no_episode: true })).data.id;
    eq((await api('POST', `/api/clients/${c}/consents`, { type: 'roi', recipient: 'County Housing', signed_at: today, expires_at: inDays(10) })).status, 201, 'a consent that runs out in 10 days');
    await go(`client/${c}`);
    const alert = await page.$('[data-consent-alert]');
    ok(alert, 'the Overview starts with a warning about it');
    const text = alert ? await alert.textContent() : '';
    ok(/County Housing/.test(text) && /in 10 days/.test(text), 'naming the consent and when it expires', text);
    ok(await page.$(`[data-consent-alert] a[href="#/client/${c}/consents"]`), 'with a link to the Consents tab');
    const first = await page.evaluate(() => { const g = document.querySelector('.main .grid.cols-2'); return g && g.firstElementChild && g.firstElementChild.hasAttribute('data-consent-alert'); });
    ok(first, 'at the top of the Overview');
    await axe(page, 'client Overview with the consent warning');
    const quiet = (await api('POST', '/api/clients', { first_name: 'Quinn' + tag, last_name: 'Covered', no_episode: true })).data.id;
    await api('POST', `/api/clients/${quiet}/consents`, { type: 'roi', recipient: 'County Housing', signed_at: today, expires_at: inDays(200) });
    await go(`client/${quiet}`);
    ok(!(await page.$('[data-consent-alert]')), 'a consent good for months says nothing');
  }

  // --------------------------------------------------------------------------- 10: resume an unsent visit
  {
    const { page } = nav;
    await nav.go('dashboard');
    await openVisit(page);
    await page.selectOption('.modal select[name=type]', 'outreach');
    await page.fill('.modal textarea[name=summary]', 'ux13 unsent visit');
    const plus = await page.$('.modal [data-supply-picker] button[aria-label^="One more"]');
    if (plus) await plus.click();
    const noteSec = await page.$('.modal details[data-section-key="note"] > summary');
    if (noteSec) { await noteSec.click(); await page.fill('.modal textarea[name=note_content]', 'ux13 unsent note'); }
    await page.waitForTimeout(700); // the draft is kept 400 ms after the last keystroke
    await closeModals(page);
    await openVisit(page);
    ok(await page.$('.modal [data-resume-question]'), 'opening Log a visit again asks about the unsent one');
    ok(/Resume your unsent visit\?/.test(await page.textContent('.modal [data-resume-question]')), 'in those words');
    eq(await page.inputValue('.modal textarea[name=summary]'), '', 'without filling it in unasked');
    await page.click('.modal [data-resume-answer="resume"]'); await settle(page);
    eq(await page.inputValue('.modal textarea[name=summary]'), 'ux13 unsent visit', 'Resume puts the fields back');
    eq(await page.inputValue('.modal select[name=type]'), 'outreach', 'every field');
    if (plus) eq(await page.$eval('.modal [data-supply-picker] input.supply-qty', i => i.value), '1', 'and the supply lines');
    if (noteSec) eq(await page.inputValue('.modal textarea[name=note_content]'), 'ux13 unsent note', 'and the note written with it');
    await page.waitForTimeout(700);
    await closeModals(page);
    ok(await page.evaluate(() => !Object.keys(localStorage).some(k => /draft/i.test(k) || /ux13 unsent/.test(localStorage.getItem(k) || ''))), 'nothing of it is in browser storage (memory only, as every draft)');
    // Signed out and back in (an idle sign-out keeps it in memory): offered at the top of the page.
    await page.evaluate(async () => (await import('./app.js')).logout());
    await signIn(page, 'mrivera', PW);
    ok(await page.$('#banners [data-resume-draft="intervention:new"]'), 'back in, the same person is asked "Resume your unsent visit?" at the top');
    await page.click('#banners [data-resume-draft-discard="intervention:new"]'); await settle(page);
    await openVisit(page);
    ok(!(await page.$('.modal [data-resume-question]')), 'Discard drops it: the next visit starts fresh');
    await page.fill('.modal textarea[name=summary]', 'ux13 someone else must not see this');
    await page.waitForTimeout(700);
    await closeModals(page);
    // Someone else signing in at the same screen gets neither the question nor the draft.
    await page.evaluate(async () => (await import('./app.js')).logout());
    await signIn(page, 'jwalker', PW);
    ok(!(await page.$('#banners [data-resume-draft]')), 'another person signing in on the same tab is not offered it');
    await openVisit(page);
    ok(!(await page.$('.modal [data-resume-question]')), 'nor asked about it in the visit form');
    eq(await page.inputValue('.modal textarea[name=summary]'), '', 'and it is not filled in');
    await closeModals(page);
    await page.evaluate(async () => (await import('./app.js')).logout());
    await signIn(page, 'mrivera', PW);
    ok(!(await page.$('#banners [data-resume-draft]')), 'and it is gone for its author too once someone else signed in there');
  }

  // --------------------------------------------------------------------------------- 11: duplicate visit
  {
    const { page, api } = nav;
    eq((await api('POST', '/api/interventions', { client_id: c2.id, type: 'housing_assistance', occurred_at: new Date().toISOString(), duration_minutes: 20 })).status, 201, 'a visit already recorded today');
    const count = async () => (await api('GET', `/api/interventions?client_id=${c2.id}&type=housing_assistance&from=${today}&to=${today}`)).data.rows.length;
    const n = await count();
    await openVisit(page, { clientId: c2.id, clientDisplay: c2.display_name });
    await page.selectOption('.modal select[name=type]', 'housing_assistance');
    await page.fill('.modal textarea[name=summary]', 'ux13 second housing visit');
    await save(page);
    eq(await dialogTitle(page), 'Save another visit?', 'the same client, day and kind of visit asks first');
    ok(/already recorded for .* today/.test(await page.textContent(`${top} p`)), 'saying what is already there', await page.textContent(`${top} p`).catch(() => ''));
    await page.click(`${top} .btn-row button:has-text("Cancel")`); await settle(page);
    eq(await dialogs(page), 1, 'Cancel leaves the visit open');
    eq(await count(), n, 'and nothing was saved');
    await save(page);
    await page.click(`${top} .btn-row button:has-text("Save another")`); await settle(page);
    await until(async () => (await dialogs(page)) === 0);
    eq(await count(), n + 1, '"Save another" saves it: a warning, not a block');
  }

  // --------------------------------------------------------------------------- 13: quick visit at 390 px
  {
    const phone = await session('mrivera', PW, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const fieldsShown = () => phone.page.evaluate(() => {
      const m = [...document.querySelectorAll('#modal-root .modal')].pop();
      const vis = (e) => !!e.offsetParent && !e.closest('details:not([open])');
      // A field is something to fill in: a labelled field of the form (a date and its time are one), and each
      // item of the supply picker; the picker's "Another item…" is a way to add one, not a field.
      const plain = [...m.querySelectorAll('.form-grid .field')].filter(vis).filter(f => !f.closest('[data-supply-picker]')).map(f => f.dataset.field);
      const supplies = [...m.querySelectorAll('[data-supply-picker] .supply-row')].filter(vis).map(r => `supply:${r.dataset.supplyRow}`);
      return [...plain, ...supplies];
    });
    for (const type of [null, 'outreach', 'naloxone_distribution']) {
      await openVisit(phone.page);
      if (type) { await phone.page.selectOption('.modal select[name=type]', type); await settle(phone.page); }
      const shown = await fieldsShown();
      ok(shown.length <= 7, `a new visit${type ? ` (${type})` : ''} shows at most seven fields at 390 px before its sections`, shown);
      ok(['client_id', 'type', 'occurred_at', 'summary'].every(f => shown.includes(f)), 'client, what was done, when and the summary among them', shown);
      ok(/— .+/.test(await phone.page.textContent('.modal details[data-section-key="where"] summary')), 'Where & how is folded, saying what it holds', await phone.page.textContent('.modal details[data-section-key="where"] summary'));
      await closeModals(phone.page);
    }
    await openVisit(phone.page);
    await axe(phone.page, 'the visit form at 390 px');
    await closeModals(phone.page);
    await phone.ctx.close();
  }

  // ------------------------------------------------------------------------------ 15: keyboard shortcuts
  {
    const { page, go } = nav;
    await go('dashboard');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('/');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.matches('.gsearch input[type=search]')), '"/" puts the cursor in the search box');
    await page.keyboard.type('ab/');
    eq(await page.evaluate(() => document.activeElement.value), 'ab/', 'typing "/" in a field types it (the shortcut does not take it)');
    await page.evaluate(() => { document.activeElement.value = ''; document.activeElement.blur(); });
    await page.keyboard.press('n');
    await until(() => page.$('.modal select[name=type]'));
    ok(await page.$('.modal select[name=type]'), '"n" opens Log a visit');
    await page.keyboard.press('?'); await settle(page);
    ok(!(await page.$('[data-shortcuts-help]')), 'single keys do nothing while a dialog is open');
    await closeModals(page);
    await page.keyboard.press('?'); await settle(page);
    ok(await page.$('[data-shortcuts-help]'), '"?" opens the list of shortcuts');
    ok(/Ctrl \+ Enter/.test(await page.textContent('[data-shortcuts-help]')), 'which lists Ctrl + Enter too');
    await axe(page, 'the keyboard shortcuts dialog');
    await closeModals(page);
    // Ctrl+Enter presses the open form's own Save.
    await page.evaluate(async () => (await import('./views/time.js')).openTimeForm(null, {}));
    await page.waitForSelector('.modal input[name=minutes]');
    await page.fill('.modal input[name=minutes]', '15');
    await page.fill('.modal input[name=description]', 'ux13 ctrl enter');
    const resp = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/time');
    await page.keyboard.press('Control+Enter');
    eq((await resp).status(), 201, 'Ctrl+Enter saves the open form');
    await until(async () => (await dialogs(page)) === 0);
    // The profile switch (WCAG 2.1.4): the single keys off, Ctrl+Enter still on.
    await go('profile');
    ok(await page.isChecked('[data-shortcuts-on]'), 'My profile has the switch, on by default');
    await page.uncheck('[data-shortcuts-on]'); await settle(page);
    await page.waitForTimeout(1000);
    await go('dashboard');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('/'); await page.keyboard.press('n'); await settle(page);
    ok(await page.evaluate(() => !document.activeElement.matches('.gsearch input')) && !(await page.$('.modal')), 'switched off, "/" and "n" do nothing');
    await go('profile');
    await page.check('[data-shortcuts-on]'); await page.waitForTimeout(1000);
  }

  // ------------------------------------------------------------------------------------ 18: undo toasts
  {
    const { page, api, go } = sup;
    const res = (await api('POST', '/api/resources', { name: 'ux13 Undo Clinic', category: 'outpatient' })).data.id;
    await go(`resource/${res}`);
    await page.click(`[data-resource-deactivate="${res}"]`); await settle(page);
    ok(!(await page.$('.modal')), 'Deactivate is done at once (it can be undone), no dialog');
    eq((await api('GET', `/api/resources/${res}`)).data.row.is_active, 0, 'the resource is deactivated');
    ok(await page.isVisible('[data-undo-toast]'), 'an Undo toast shows');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-undo')), 'with the keyboard on its Undo');
    ok(/Undo is available for 10 seconds/.test(await liveText(page)), 'announced through the live region');
    await axe(page, 'a page with the Undo toast');
    await page.click('[data-undo]'); await settle(page);
    eq((await api('GET', `/api/resources/${res}`)).data.row.is_active, 1, 'Undo puts it back');
    // Retiring a document (an administrator).
    const doc = (await admin.api('POST', '/api/documents', { title: 'ux13 Undo Policy', category: 'policy', file_url: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64'), filename: 'undo.pdf' })).data.id;
    await admin.go('documents');
    await admin.page.click(`[data-document-retire="${doc}"]`); await settle(admin.page);
    ok(await admin.page.isVisible('[data-undo-toast]'), 'retiring a document shows an Undo toast');
    await admin.page.click('[data-undo]'); await settle(admin.page);
    ok((await admin.api('GET', '/api/documents')).data.documents.some(d => d.id === doc && d.is_active), 'and Undo puts it back in effect');
    // Ending an assignment.
    const c = (await api('POST', '/api/clients', { first_name: 'Una' + tag, last_name: 'Assigned', no_episode: true })).data.id;
    const kp = (await api('GET', '/api/users')).data.users.find(u => u.role === 'clinician');
    eq((await api('POST', `/api/clients/${c}/assignments`, { user_id: kp.id, role_on_case: 'clinician' })).status, 201, 'a clinician on the care team');
    await go(`client/${c}/team`);
    const endBtn = await page.$('[data-assignment-end]');
    ok(endBtn, 'the care team has End');
    if (endBtn) { await endBtn.click(); await settle(page); }
    ok(!(await page.$('.modal')) && await page.isVisible('[data-undo-toast]'), 'End is done at once, with an Undo toast');
    await page.click('[data-undo]'); await settle(page);
    const team = (await api('GET', `/api/clients/${c}`)).data.client.assignments.filter(a => a.user_id === kp.id);
    ok(team.some(a => !a.end_date) && team.some(a => a.end_date), 'Undo puts the clinician back on the case; the ended assignment stays in the history', team.map(a => a.end_date));
    // Irreversible actions keep their confirmation.
    const call = (await api('POST', '/api/calls', { client_id: c, direction: 'outbound', started_at: new Date().toISOString(), duration_minutes: 2, contact_type: 'client', outcome: 'reached' })).data.id;
    await go(`client/${c}/calls`);
    const del = await page.$('button[aria-label="Delete this call"]');
    if (del) { await del.click(); await settle(page); ok(/Delete call/.test(await dialogTitle(page) || ''), 'deleting a call still asks first (it cannot be undone)'); await closeModals(page); }
    else ok(call, 'the call exists (its delete button is on the Calls tab)');
  }

  // ------------------------------------------------------------------------------ 19: empty-state actions
  {
    await admin.go('documents?q=zzqqxx-none');
    ok(await admin.page.$('.main [data-empty-action="document"]'), 'no documents found: an administrator gets "+ Upload a document"');
    await nav.go('documents?q=zzqqxx-none');
    ok(!(await nav.page.$('.main [data-empty-action]')) && /uploads the program's policies/.test(await nav.page.textContent('.main')), 'a navigator, who may not upload, is told who does');
    await nav.go('resources?q=zzqqxx-none');
    const empty = await nav.page.textContent('.main');
    ok(/No resources match/.test(empty) && (await nav.page.$('.main .empty button, .main [data-empty-action], .main button:has-text("+ Add resource")') || /adds programs to the directory/.test(empty)), 'no resources found: the way to add one, or who adds them');
  }

  // ------------------------------------------------------------------------------- 20: your first day
  {
    for (const [who, pw, role] of [['mrivera', PW, 'navigator'], ['jwalker', PW, 'supervisor'], ['admin', 'AdminPassw0rd!x', null]]) {
      const s = await session(who, pw, { viewport: { width: 1280, height: 900 } }, { tour_done: false, first_day: null });
      await s.go('dashboard');
      ok(await s.page.$('[data-welcome]'), `${who}: the welcome card is on Home the first time`);
      if (role) {
        const steps = await s.page.$$eval(`[data-first-day="${role}"] li`, ls => ls.length);
        eq(steps, 3, `${who}: it holds three first-day steps for a ${role}`);
        eq((await s.page.textContent('[data-first-day-count]')).trim(), '0 of 3 done', 'none done yet');
        await s.page.check('[data-first-day-step]'); await settle(s.page);
        eq((await s.page.textContent('[data-first-day-count]')).trim(), '1 of 3 done', 'ticking one counts it');
        eq(await s.page.$$eval('.main [data-welcome]', x => x.length), 1, 'one welcome card, not a second checklist beside it');
        await axe(s.page, `${who}: Home with the first-day list`);
      } else {
        ok(!(await s.page.$('[data-first-day]')), 'an administrator gets no first-day list: "Finish setting up" is theirs');
      }
      await s.ctx.close();
    }
  }

  // --------------------------------------------------------------------------------- 21: inline help
  {
    const { page, go } = sup;
    await go(`client/${c1.id}`);
    await page.evaluate(async (id) => (await import('./views/part2.js')).openConsentForm(id, {}), c1.id);
    await page.waitForSelector('.modal [data-consent-basis]');
    await page.click('.modal [data-consent-basis] .help-btn');
    ok(/valid basis|a basis for sharing/.test(await page.textContent('.modal [data-consent-basis]')) && /counseling notes/.test(await page.textContent('.modal [data-consent-basis]')), 'the Part 2 consent form explains what makes a consent a valid basis');
    await axe(page, 'the consent form with its help open');
    await closeModals(page);
    await go('supplies');
    const adjust = await page.$('button[aria-label^="Adjust "]');
    if (adjust) {
      await adjust.click(); await page.waitForSelector('.modal [data-supply-which="adjust"]');
      await page.click('.modal [data-supply-which="adjust"] .help-btn');
      const t = await page.textContent('.modal [data-supply-which="adjust"]');
      ok(/Dispose of stock/.test(t) && /Move stock/.test(t) && /Adjust only when/.test(t), 'Adjust stock says when to adjust, dispose or move instead', t);
      await closeModals(page);
    } else ok(false, 'the supervisor has an Adjust button on Supplies');
    await go('funder');
    ok(/Which file do I send\?/.test(await page.textContent('.main')), 'the funder report says which file to send (1.15.2)');
  }

  // ------------------------------------------------------------------------- 22: 200% zoom (640×400 @2x)
  {
    const reflow = async (s, hash, where) => {
      await s.go(hash);
      const r = await s.page.evaluate(() => {
        const vw = innerWidth;
        const past = [...document.querySelectorAll('.main nav.tabs button, .main .tabs-more')].filter(b => b.offsetParent && !b.closest('.tabs-menu')).map(b => ({ t: b.textContent.trim().slice(0, 24), right: Math.round(b.getBoundingClientRect().right) })).filter(x => x.right > vw + 0.5);
        return { sw: document.documentElement.scrollWidth, vw, past };
      });
      ok(r.sw <= r.vw, `${where}: no sideways scroll at 200% zoom (${r.sw} ≤ ${r.vw})`, r);
      eq(r.past.length, 0, `${where}: no tab or More past the right-hand edge`, r.past);
      await axe(s.page, `${where} at 200% zoom`);
    };
    const zoom = { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 };
    const zs = await session('jwalker', PW, zoom);
    const zc = await session('kpatel', PW, zoom);
    const za = await session('admin', 'AdminPassw0rd!x', zoom);
    const supClient = (await zs.api('GET', '/api/clients?limit=1')).data.clients[0];
    const cliClient = (await zc.api('GET', '/api/clients?limit=1')).data.clients[0];
    await reflow(zs, `client/${supClient.id}`, 'client record (supervisor)');
    await reflow(zc, `client/${cliClient.id}`, 'client record (clinician)');
    await reflow(za, 'admin?tab=users', 'Settings → Users & permissions');
    await reflow(zs, 'funder', 'funder report');
    await reflow(zs, 'supplies', 'Supplies');
    for (const s of [zs, zc, za]) await s.ctx.close();
  }
} catch (e) {
  fail(`the script stopped: ${e.stack || e.message}`);
}
eq(errors.length, 0, `no page errors, console errors or server errors${errors.length ? ' — ' + errors.slice(0, 5).join(' | ') : ''}`);
await browser.close();
finish();

// The frontline-UX and market reviews of 1.15.3 (fixed in 1.16.0), in a browser:
//    1. Repeat last visit copies what kind of visit it was, never the supply quantities, and says whose visit it was;
//    2. the bell's panel never shows the word "null" (nor does any list the DOM writes null into);
//    3. a yes/no question nobody asked reads "Not asked", and the intake form offers Yes / No / Not asked;
//    4. SUPRT-A: coded answers are lists with labels, "complete" needs every section, an unset grant ID says where
//       it is set, and the error is said once;
//    5. the approval queue has Select all, and every row's buttons say which entry they act on;
//    6. the note viewer's link names the client;
//    7. the search box says what it found (a live region) and that it finds resources too;
//   10. wording: the supervisor's time page, the Read-only role, the overdose help, the "n" shortcut on a client;
//   11. a publication release does not offer "Export everything to Excel";
//   market 3. finance opens the syringe services summary from the funder report, and SUPRT-A completion;
//   retest of 1.15.3: the expiring-consent alert says "consent" once; an empty Waitlist offers a next step; an
//   inactive resource's profile reads "Status: Inactive" in its badge list (1280 and 390 px); an unsent visit left by
//   navigating away is offered back, restored by Resume and cleared by Discard.
// Pages it changes are checked with axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('r5');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const daysAgo = (n) => { const d = new Date(Date.now() - n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function session(username, password = PW, ctxOpts = { viewport: { width: 1280, height: 900 } }) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  await api('PUT', '/api/me/prefs', { tour_done: true, visit_sections: null, visit_last: null, shortcuts_off: null });
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
const dialogs = (page) => page.$$eval('#modal-root > .modal-bg', x => x.length);
const closeModals = async (page) => { for (let i = 0; i < 5 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await settle(page); } };
const tag = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

try {
  const nav = await session('mrivera');
  const sup = await session('jwalker');
  const admin = await session('admin', 'AdminPassw0rd!x');
  const fin = await session('afinance');
  const mine = (await nav.api('GET', '/api/clients?limit=20')).data.clients;
  ok(mine.length >= 2, 'the navigator has clients on their caseload', mine.length);
  const [c1, c2] = mine;

  // ------------------------------------------------------------------------------ 1: Repeat last visit
  {
    // The client's most recent visit is the supervisor's, and it handed out kits and strips.
    const v = await sup.api('POST', '/api/interventions', { client_id: c1.id, type: 'naloxone_distribution', occurred_at: new Date().toISOString(), naloxone_kits: 3, fentanyl_strips: 5, summary: 'r5 repeat source' });
    eq(v.status, 201, 'the supervisor logs a visit with supplies for the client');
    const { page, go } = nav;
    await go(`client/${c1.id}/interventions`);
    await page.click('.client-actions.wide button:has-text("Repeat last visit")');
    await page.waitForSelector('.modal select[name=type]'); await settle(page);
    const note = await page.$('.modal [data-repeat-note]');
    ok(note, 'the repeated visit says what it was copied from');
    eq(await note.getAttribute('data-repeat-note'), 'other', 'another worker\'s visit');
    const text = await note.textContent();
    ok(/Jordan Walker's visit/.test(text) && /Supplies start at zero/.test(text) && /recorded as yours/.test(text), 'naming whose visit it was, that supplies start at zero, and that this one is yours', text);
    eq(await page.inputValue('.modal select[name=type]'), 'naloxone_distribution', 'what was done is copied');
    const qty = await page.$$eval('.modal input.supply-qty', els => els.map(e => e.value));
    ok(qty.length > 0 && qty.every(x => x === '' || x === '0'), 'every supply quantity starts empty', qty);
    const counts = await page.$$eval('.modal input[name=naloxone_kits], .modal input[name=fentanyl_strips]', els => els.map(e => e.value));
    ok(counts.every(x => x === '' || x === '0'), 'and so do the kits and strips counts', counts);
    await axe(page, 'Repeat last visit');
    await closeModals(page);
  }

  // ---------------------------------------------------------------------------------------- 2: the bell
  {
    const { page } = nav;
    await page.click('[data-due-bell]'); await settle(page);
    await until(async () => !/Not updated yet/.test(await page.textContent('[data-due-updated]')));
    const t = await page.textContent('[data-due-panel]');
    ok(!/\bnull\b/.test(t), 'the bell\'s panel never shows "null"', t.slice(0, 200));
    await page.keyboard.press('Escape'); await settle(page);
  }

  // ------------------------------------------------------------------------------- 3: "Not asked"
  {
    const { page, api, go } = nav;
    const r = await api('POST', '/api/clients', { first_name: `Nota${tag}`, last_name: 'Asked', status: 'active' });
    eq(r.status, 201, 'a client made with Quick add');
    await go(`client/${r.data.id}`);
    const kv = await page.textContent('.main');
    ok(/Veteran\s*Not asked/.test(kv) && /Overdose history\s*Not asked/.test(kv) && /Justice involved\s*Not asked/.test(kv), 'the Overview says "Not asked", not "No"', kv.match(/Veteran[^A-Z]*/)?.[0]);
    await page.click('.client-actions.wide button:has-text("Edit")'); await page.waitForSelector('.modal select[name=veteran]'); await settle(page);
    const opts = await page.$$eval('.modal select[name=veteran] option', o => o.map(x => x.textContent));
    eq(opts.join('|'), 'Not asked|Yes|No', 'Veteran is Yes / No / Not asked, not a checkbox');
    eq(await page.inputValue('.modal select[name=overdose_history]'), '', 'an unasked question opens as "Not asked"');
    await closeModals(page);
  }

  // ------------------------------------------------------------------------------------- 4: SUPRT-A
  {
    const f = await admin.api('POST', '/api/budget/funds', { name: `SOR r5 ${tag}`, source_type: 'sor_grant', total_amount: 10000, fiscal_year_start: daysAgo(200), fiscal_year_end: daysAgo(-200) });
    eq(f.status, 201, 'a SOR grant fund switches SUPRT-A on');
    await admin.api('PUT', '/api/admin/settings', { suprt_grant_id: '' });
    const { page, go } = nav;
    await page.reload(); await page.waitForSelector('.layout'); await settle(page);
    await go(`client/${c2.id}/suprt`);
    await page.click('[data-suprt-add="baseline"]'); await page.waitForSelector('.modal [data-suprt-form]'); await settle(page);
    ok(await page.$('.modal [data-suprt-no-grant]'), 'an unset grant ID is a plain prompt');
    ok(/SPARS takes no record without it/.test(await page.textContent('.modal [data-suprt-no-grant]')), 'saying why it matters');
    for (const k of ['F_housing', 'F_insurance', 'F_gender']) {
      const opts = await page.$$eval(`.modal select[name="answers.${k}"] option`, o => o.map(x => x.textContent)).catch(() => []);
      ok(opts.length > 2 && !opts.some(x => /_/.test(x)), `${k} is a list of labelled choices, not a text box of codes`, opts);
    }
    await page.selectOption('.modal select[name="answers.A_suprt_c"]', 'not_offered').catch(() => {});
    await page.click(`${top} .btn-row button[type=submit]`); await settle(page);
    const err = await page.textContent(`${top} .banner.danger`);
    ok(/Trauma screening result/.test(err) && /before marking it complete/.test(err), 'Complete with sections unanswered is refused, naming what is missing', err.slice(0, 200));
    const said = (err.match(/Trauma screening result/g) || []).length;
    eq(said, 1, 'the message is said once, not repeated after it');
    ok(await page.$(`${top} [data-field="answers.C_trauma_screen"].error`), 'and the question is marked where it is');
    await axe(page, 'SUPRT-A baseline form');
    await closeModals(page);
    // Finance: the completion rates, counts only.
    await fin.page.reload(); await fin.page.waitForSelector('.layout'); await settle(fin.page);
    await fin.go('suprt');
    ok(await fin.page.$('[data-suprt-completion]'), 'finance sees SUPRT-A completion rates');
    ok(!(await fin.page.$('[data-suprt-due-card]')), 'but not the follow-ups due, which name clients');
  }

  // ------------------------------------------------------------------------------- 5: the approval queue
  {
    for (const [d, m] of [[daysAgo(3), 150], [daysAgo(4), 45]]) {
      const t = await nav.api('POST', '/api/time', { work_date: d, minutes: m, category: 'documentation' });
      await nav.api('POST', `/api/time/${t.data.id}/submit`, {});
    }
    const { page, go } = sup;
    await go('supervision');
    ok(await page.$('[data-time-select-all]'), 'the approval queue has Select all');
    const names = await page.$$eval('button[aria-label^="Approve "]', b => b.map(x => x.getAttribute('aria-label')));
    ok(names.some(n => /^Approve 2h 30m on .+ for Maria Rivera$/.test(n)), 'each Approve names the entry: "Approve 2h 30m on … for Maria Rivera"', names.slice(0, 3));
    ok(await page.$('button[aria-label^="Return 45m on "]'), 'and each Return');
    await page.check('[data-time-select-all]'); await settle(page);
    const all = await page.$$eval('[data-time-select]', b => b.every(x => x.checked));
    ok(all, 'Select all ticks every row');
    await axe(page, 'Supervision (approval queue)');
    await go('time');
    eq((await page.textContent('.main h1')).trim(), 'Staff time', 'a supervisor\'s time page is not "My time"');
    const reopen = await page.$$eval('button[data-time-reopen], .main button[aria-label^="Approve "]', b => b.map(x => x.getAttribute('aria-label')));
    ok(reopen.every(n => / on .+ for /.test(n)), 'row buttons on the time page are named too', reopen.slice(0, 2));
  }

  // ------------------------------------------------------------------------------------ 6: the note viewer
  {
    const { page, api } = sup;
    const n = await api('POST', '/api/notes', { client_id: c1.id, kind: 'admin', content: 'r5 viewer check', occurred_at: new Date().toISOString() });
    eq(n.status, 201, 'a note to open');
    await page.evaluate(async (id) => (await import('./views/notes.js')).openNote(id), n.data.id);
    await page.waitForSelector('.modal [data-note-client]'); await settle(page);
    const link = (await page.textContent('.modal [data-note-client]')).trim();
    ok(link.includes(c1.client_code) && link !== 'view', 'the client link names the client', link);
    await axe(page, 'note viewer');
    await closeModals(page);
  }

  // ------------------------------------------------------------------------------------------ 7: search
  {
    const { page } = nav;
    const box = '.appbar .gsearch input[type=search]';
    ok(/Find a client or resource/.test(await page.getAttribute(box, 'placeholder')), 'the search box says it finds resources too');
    await page.fill(box, 'zzqqxx'); await until(async () => /No match/.test(await page.textContent('[data-search-status]')));
    eq((await page.textContent('[data-search-status]')).trim(), 'No match.', 'no result is announced');
    await page.fill(box, c1.last_name || c1.display_name.split(' ').pop());
    await until(async () => /found/.test(await page.textContent('[data-search-status]')));
    ok(/\d+ clients? (and \d+ resources? )?found/.test(await page.textContent('[data-search-status]')), 'results are announced with their count', await page.textContent('[data-search-status]'));
    eq(await page.getAttribute('[data-search-status]', 'role'), 'status', 'in a status live region');
    await page.focus(box); await page.keyboard.press('ArrowDown');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('search-hit')), 'Down arrow moves into the results');
    await page.keyboard.press('Escape'); await settle(page);
  }

  // ------------------------------------------------------------------------------------------ 10: wording
  {
    const { page, go } = nav;
    await go(`client/${c1.id}`);
    await page.keyboard.press('n'); await page.waitForSelector('.modal select[name=type]'); await settle(page);
    const who = await page.$eval('.modal [data-field="client_id"] input[type=text]', i => i.value).catch(() => '');
    ok(who.includes(c1.client_code), '"n" on a client\'s record logs a visit for that client', who);
    await closeModals(page);
    await page.evaluate(async () => (await import('./views/overdose.js')).openOverdoseForm(null, {}));
    await page.waitForSelector('.modal [data-field="naloxone_used"] .help'); await settle(page);
    const help = await page.textContent('.modal [data-field="naloxone_used"] .help');
    const label = await page.$$eval('.modal select[name=kind] option[value=reversal]', o => o[0]?.textContent);
    ok(label && help.includes(`"${label}"`), 'the overdose help names the reversal choice as the list shows it', [help, label]);
    await closeModals(page);
    await admin.go('admin?tab=users');
    await admin.page.click('.main button:has-text("+ New user")');
    await admin.page.waitForSelector('.modal select[name=role]'); await settle(admin.page);
    const ro = await admin.page.$eval('.modal select[name=role] option[value=readonly]', o => o.textContent);
    ok(/cannot open client records/.test(ro) && !/client summaries/.test(ro), 'Read-only is not described as seeing client summaries', ro);
    await closeModals(admin.page);
  }

  // ------------------------------------------------------------------------- 11: publication release page
  {
    const d = new Date(); const q = Math.floor(d.getMonth() / 3); const y = q ? d.getFullYear() : d.getFullYear() - 1; const pq = q ? q - 1 : 3;
    const from = `${y}-${String(pq * 3 + 1).padStart(2, '0')}-01`; const end = new Date(Date.UTC(y, pq * 3 + 3, 0)).toISOString().slice(0, 10);
    const { page, go } = sup;
    await go(`funder?from=${from}&to=${end}&purpose=publication`);
    ok(await page.$('[data-publication-review-step]'), 'a publication release of the last quarter');
    ok(!(await page.$('[data-funder-export="workbook"]')), 'offers no "Export everything to Excel" beside it');
    await go(`funder?from=${from}&to=${end}&purpose=submission`);
    ok(await page.$('[data-funder-export="workbook"]'), 'the submission still does');
  }

  // ------------------------------------------------------------ retest: the expiring consent, said once
  {
    const exp = daysAgo(-10);
    const k = await nav.api('POST', `/api/clients/${c2.id}/consents`, { type: 'part2_disclosure', recipient: `Test Clinic ${tag}`, purpose: 'Referral and care coordination', signed_at: daysAgo(30), scope: 'Referral information', expires_at: exp, signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true });
    eq(k.status, 201, 'a Part 2 consent that expires in 10 days');
    await nav.go(`client/${c2.id}`);
    const alert = await nav.page.textContent('[data-consent-alert]');
    ok(alert.includes(`The Part 2 consent to Test Clinic ${tag} expires on`), 'the Overview names it once as "the Part 2 consent to …"', alert.slice(0, 160));
    ok(!/consent consent/i.test(alert), 'never "consent consent"');
  }

  // ------------------------------------------------------------------ retest: an empty Waitlist
  {
    const w = (await sup.api('GET', '/api/waitlist?limit=500')).data.rows;
    for (const r of w) await sup.api('PUT', `/api/clients/${r.id}`, { status: 'active' });
    await nav.go('waitlist');
    ok(/Nobody is waiting/.test(await nav.page.textContent('.main')), 'an empty Waitlist says so');
    const btn = await nav.page.$('.main [data-empty-action="waitlist-add"]');
    ok(btn, 'and offers the next step: add someone to it');
    await btn.click(); await nav.page.waitForSelector('.modal select[name=status]'); await settle(nav.page);
    eq(await nav.page.inputValue('.modal select[name=status]'), 'waitlist', 'the intake form opens with the status Waitlist');
    await nav.page.fill('.modal input[name=first_name]', `Wait${tag}`); await nav.page.fill('.modal input[name=last_name]', 'Listed');
    await nav.page.click(`${top} .btn-row button[type=submit]`); await settle(nav.page);
    await until(async () => (await dialogs(nav.page)) === 0);
    await nav.go('waitlist');
    ok((await nav.page.textContent('.main')).includes(`Wait${tag}`), 'and the person is then on the Waitlist');
    await axe(nav.page, 'Waitlist');
    const ro = await session('rreader');
    await ro.go('waitlist');
    const t = await ro.page.textContent('.main');
    ok(/Nobody is waiting|Not available/.test(t) && !(await ro.page.$('[data-empty-action="waitlist-add"]')), 'a role that cannot add clients is not offered the button');
    await ro.ctx.close();
  }

  // ------------------------------------------------- retest: an inactive resource's profile, 1280 and 390 px
  {
    const res = await sup.api('POST', '/api/resources', { name: `Closed Clinic ${tag}`, category: 'outpatient' });
    eq(res.status, 201, 'a resource');
    eq((await sup.api('PUT', `/api/resources/${res.data.id}`, { is_active: false })).status, 200, 'deactivated');
    for (const [label, s] of [['1280 px', sup], ['390 px', await session('jwalker', PW, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })]]) {
      await s.go(`resource/${res.data.id}`);
      const inList = await s.page.$eval('[data-inactive]', el => !!el.closest('ul.badge-list > li')).catch(() => false);
      ok(inList, `${label}: the profile's Inactive badge is an item of its badge list`);
      const snap = await s.page.locator('ul.badge-list').first().ariaSnapshot();
      ok(/listitem: "?Status: Inactive"?/.test(snap), `${label}: a screen reader reads "Status: Inactive" as its own list item`, snap.slice(0, 200));
      ok(await s.page.$eval('[data-inactive]', el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0), `${label}: and it is visible`);
      if (s !== sup) await s.ctx.close();
    }
  }

  // ------------------------------------------ retest: an unsent visit left by navigating away is offered back
  {
    const { page, go } = nav;
    await go('dashboard');
    const logVisit = async () => { await page.locator('button.quick:visible').first().click(); await page.click(`${top} .quick-list button:has-text("Log a visit")`); await page.waitForSelector('.modal select[name=type]'); await settle(page); };
    await logVisit();
    await page.selectOption('.modal select[name=type]', 'outreach');
    await page.fill('.modal textarea[name=summary]', `r5 left unsent ${tag}`);
    await page.waitForTimeout(700); // the draft is kept 400 ms after the last keystroke
    await page.evaluate(() => { location.hash = '#/clients'; }); await settle(page);
    await page.waitForSelector('.main h1'); await closeModals(page);
    ok((await page.textContent('.main h1')).includes('Clients'), 'navigated away without saving');
    await go('dashboard');
    await logVisit();
    ok(await page.$('.modal [data-resume-question]'), 'opening Log a visit again offers the unsent visit');
    eq(await page.inputValue('.modal textarea[name=summary]'), '', 'without filling it in unasked');
    await page.click('.modal [data-resume-answer="resume"]'); await settle(page);
    eq(await page.inputValue('.modal textarea[name=summary]'), `r5 left unsent ${tag}`, 'Resume restores the summary');
    eq(await page.inputValue('.modal select[name=type]'), 'outreach', 'and what was done');
    await page.waitForTimeout(700); await closeModals(page);
    await logVisit();
    ok(await page.$('.modal [data-resume-answer="discard"]'), 'still offered until it is saved or discarded');
    await page.click('.modal [data-resume-answer="discard"]'); await settle(page);
    eq(await page.inputValue('.modal textarea[name=summary]'), '', 'Discard leaves the form empty');
    await closeModals(page);
    await logVisit();
    ok(!(await page.$('.modal [data-resume-question]')), 'and the next visit starts fresh');
    await closeModals(page);
  }

  // --------------------------------------------------------------- market 3: finance and the SSP summary
  {
    const { page, go } = fin;
    await go('funder');
    ok(await page.$('[data-ssp-link] a[href="#/ssp"]'), 'finance finds the syringe services summary from the funder report');
    await go('ssp');
    eq((await page.textContent('.main h1')).trim(), 'Syringe services program report', 'and it opens');
    ok(await page.$('.main [data-ssp-report]'), 'with the summary');
    await axe(page, 'syringe services summary (finance)');
  }
} catch (e) {
  fail(`the script stopped: ${e.stack || e.message}`);
}
eq(errors.length, 0, `no page errors, console errors or server errors${errors.length ? ' — ' + errors.slice(0, 5).join(' | ') : ''}`);
await browser.close();
finish();

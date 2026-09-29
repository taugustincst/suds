// The frontline-UX review of 1.16.2 (fixed in 1.16.3), in a browser:
//   M1 a change notice in the client's Recent activity reads "<editor> (not on the care team) changed: <fields> —
//      <primary> was told", is dated and attributed to the editor, never shows the to-do's own text, and opens the
//      notice card; the Open to-dos tile leaves notices out and warns only for an overdue to-do;
//   M2 the bell lists notices apart ("Changes to your clients"), marked New rather than "today", out of the due count,
//      with the client named as every list names them; the bell's cache can be dropped (a device sync does);
//   M3 + Log on a client's record starts the note and the visit for that client;
//   L1 the seeded programme is not called harm reduction while it uses the treatment profile; L2 the notice card's
//   When is the change, not when it was seen; L3 Notes name the client and have an Open button; L4 Notes and
//   Referrals are compact rows on a phone; L5 phone filters fold behind "Filters"; L6 the last row scrolls clear of
//   the floating + Log; L7 a SOAP note has no second required Narrative box; L8 a clinician's note starts Clinical;
//   L9 Finance's welcome does not promise that what they add shows up elsewhere.
// Pages and dialogs it changes are checked with axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('r8');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
const PHONE = [{ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }];

async function session(username, password = PW, viewport = { width: 1280, height: 900 }, extra = {}, { tour = true } = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  if (tour) await api('PUT', '/api/me/prefs', { tour_done: true });
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
const closeModals = async (page) => { for (let i = 0; i < 5 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await settle(page); } };
const tag = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const fmtDt = (page, iso) => page.evaluate(async (x) => (await import('/app.js')).fmt.dt(x), iso);

try {
  // ------------------------------------------------------------------ David's client; Maria (off the team) edits it
  const dchen = await session('dchen');
  const made = await dchen.api('POST', '/api/clients', { first_name: 'Nell', last_name: `Timeline${tag}`, confirm_duplicate: true });
  eq(made.status, 201, 'David adds a client (he becomes the primary worker)');
  const cid = made.data.id; const code = made.data.client_code || (await dchen.api('GET', `/api/clients/${cid}`)).data.client.client_code;
  const me = (await dchen.api('GET', '/api/auth/me')).data;
  const davidId = (me.user || me).id;
  await dchen.ctx.close();
  const maria = await session('mrivera');
  eq((await maria.api('PUT', `/api/clients/${cid}`, { phone: '555-301-4411' })).status, 200, 'Maria, off the care team, changes the phone number');
  // An ordinary, overdue to-do for David, so the bell has due work beside the notice.
  eq((await maria.api('POST', '/api/tasks', { title: `Overdue${tag}`, client_id: cid, assigned_to: davidId, due_at: new Date(Date.now() - 3600e3).toISOString() })).status, 201, 'and gives David an overdue to-do about the client');

  // ------------------------------------------------------------------ M1: the Overview, as a supervisor
  const jw = await session('jwalker');
  const tl = (await jw.api('GET', `/api/clients/${cid}/timeline`)).data.events;
  const ev = tl.find(e => e.notice === true);
  ok(ev, 'the timeline marks the change notice as one (notice: true)');
  if (ev) {
    eq(ev.worker, 'Maria Rivera', 'attributed to the editor, not the primary worker it was sent to');
    ok(ev.detail === null && !/primary worker\.|Reference/.test(ev.title), 'with none of the to-do\'s own text', ev.title);
  }
  await jw.go(`client/${cid}`);
  const li = await until(() => jw.page.$('.main [data-timeline-notice]'));
  ok(li, 'Recent activity lists the change');
  if (li) {
    const text = (await li.textContent()).replace(/\s+/g, ' ');
    ok(/Maria Rivera \(not on the care team\) changed: Phone — David Chen was told/.test(text), 'as "Maria Rivera (not on the care team) changed: Phone — David Chen was told"', text);
    ok(text.split('Maria Rivera').length === 2 && !/· David Chen/.test(text), 'by Maria (named once, r9 L1), not by David', text);
    ok(!/You are this client's primary worker|Reference|DEMO-|record \(/.test(text), 'never the to-do\'s text', text);
    await (await li.$('a')).click();
    const card = await until(() => jw.page.$('.modal [data-change-notice]'));
    ok(card, 'and a click opens the notice card');
    await closeModals(jw.page);
  }
  const counts = (await jw.api('GET', `/api/clients/${cid}`)).data.client.counts;
  const tile = await jw.page.$$eval('.main .stat', ss => ss.map(s => ({ l: s.querySelector('.l')?.textContent || '', v: s.querySelector('.v')?.textContent || '' })).find(s => /^Open to-dos/.test(s.l)));
  ok(tile && tile.v.includes(String(counts.open_tasks - counts.notices)) && counts.notices === 1, 'the Open to-dos tile counts the to-do, not the notice', JSON.stringify({ tile, counts }));
  ok(tile && !/change to review/.test(tile.l), 'and, to a supervisor (not the one told), no "change to review" (r9 L2)', tile && tile.l);
  ok(tile && tile.v.includes('⚠') === counts.overdue_tasks > 0, 'with ⚠ because a real to-do is overdue', JSON.stringify(tile));
  await axe(jw.page, 'client Overview with a change notice');
  await jw.ctx.close();

  // ------------------------------------------------------------------ M2 / L2: David's bell and the card
  const david = await session('dchen');
  let { page } = david;
  const due = (await david.api('GET', '/api/tasks/due?within=60')).data;
  const notice = due.rows.find(t => t.notice === true && t.client_id === cid);
  ok(notice, 'the notice is on David\'s due list, marked notice: true');
  ok(notice && notice.title.includes(`Timeline${tag}`) && !notice.title.includes(`${code}'s`), 'its title names the client as every list does, not by code', notice && notice.title);
  await page.click('[data-due-bell]'); await settle(page);
  const bell = await page.evaluate(() => {
    const panel = document.querySelector('[data-due-panel]'); const kids = [...panel.querySelectorAll('[data-due-notices], [data-due-heading], [data-due-item]')];
    const head = kids.findIndex(k => k.hasAttribute('data-due-heading'));
    return { notices: panel.querySelector('[data-due-notices]')?.textContent || '', firstNotice: kids.findIndex(k => k.dataset.dueItem === 'notice'), lastNotice: kids.map(k => k.dataset.dueItem).lastIndexOf('notice'), head,
      noticeText: [...panel.querySelectorAll('[data-due-item=notice]')].map(x => x.textContent).join(' | '), label: document.querySelector('[data-due-bell]').getAttribute('aria-label'), count: document.querySelector('[data-due-bell] .bell-count').textContent };
  });
  ok(/^Changes to your clients · \d+$/.test(bell.notices), 'the bell lists notices under "Changes to your clients"', bell.notices);
  ok(bell.firstNotice >= 0 && bell.lastNotice < bell.head, 'and none under "Due within the hour, or overdue"', JSON.stringify(bell));
  ok(/New/.test(bell.noticeText) && !/today/.test(bell.noticeText), 'marked New, not "today"', bell.noticeText);
  const dueWork = due.rows.filter(t => t.notice !== true).length;
  eq(bell.count, String(dueWork), 'the badge counts due work only');
  ok(new RegExp(`^${dueWork} to-dos? due or overdue, \\d+ changes? to your clients$`).test(bell.label), 'and the button says both', bell.label);
  await axe(page, 'the bell with a change notice');
  await page.keyboard.press('Escape');
  // The device's sync drops the bell's minute-long cache; here, the same call after a to-do saved elsewhere.
  eq((await david.api('POST', '/api/tasks', { title: `Synced${tag}`, due_at: new Date(Date.now() - 60e3).toISOString(), assigned_to: davidId })).status, 201, 'a to-do arrives from elsewhere');
  await page.evaluate(async () => (await import('/app.js')).forgetDue());
  eq(await until(async () => { const c = await page.$eval('[data-due-bell] .bell-count', x => x.textContent); return c === String(dueWork + 1) ? c : null; }, { timeout: 5000 }), String(dueWork + 1), 'forgetDue() shows it on the bell at once');
  ok(/forgetDue\(\)/.test(fs.readFileSync(new URL('../../public/views/local.js', import.meta.url), 'utf8')), 'and a device sync calls it');
  await david.go(`tasks?id=${notice && notice.id}`);
  const card = await until(() => page.$('.modal [data-change-notice]'));
  if (card) {
    const when = await page.$$eval('.modal [data-change-notice] dt', dts => { const dt = dts.find(d => d.textContent === 'When'); return dt ? dt.nextElementSibling.textContent : ''; });
    eq(when, await fmtDt(page, notice.created_at), 'the card\'s When is the change (created_at)');
    const client = await page.$$eval('.modal [data-change-notice] dt', dts => { const dt = dts.find(d => d.textContent === 'Client'); return dt ? dt.nextElementSibling.textContent : ''; });
    ok(client.includes(`Timeline${tag}`) && client.split(code).length === 2 && !client.includes(`Timeline${tag}, Nell Timeline`), 'and names the client once, with the code', client);
    await page.click('.modal [data-notice-seen]');
    await until(async () => !(await page.$('.modal [data-change-notice]')));
    const after = (await david.api('GET', `/api/tasks/${notice.id}`)).data.row;
    eq(await fmtDt(page, after.created_at), when, 'Mark as seen leaves When where it was');
  } else fail('the notice card did not open');
  await david.ctx.close();

  // ------------------------------------------------------------------ M3 / L7 / L8: a clinician on a phone
  const kp = await session('kpatel', PW, ...PHONE);
  await kp.go(`client/${cid}`);
  const quick = async (label) => {
    await kp.page.click('.fab .btn.quick'); await kp.page.waitForSelector(`.quick-list button:has-text("${label}")`);
    await kp.page.click(`.quick-list button:has-text("${label}")`); await kp.page.waitForSelector('.modal [name=client_id]', { state: 'attached' }); await settle(kp.page);
  };
  await quick('Note');
  eq(await kp.page.$eval('.modal [name=client_id]', i => i.value), cid, '+ Log › Note on a client\'s record starts with that client');
  eq(await kp.page.$eval('.modal select[name=kind]', s => s.value), 'clinical', 'a clinician\'s new note starts as Clinical');
  await kp.page.selectOption('.modal select[name=format]', 'SOAP'); await settle(kp.page);
  const fold = await kp.page.evaluate(() => { const d = document.querySelector('.modal [data-narrative-built]'); const t = document.querySelector('.modal textarea[name=content]'); return { folded: !!d && d.contains(t) && !d.open, required: t.required || t.getAttribute('aria-required') === 'true', summary: d?.querySelector('summary')?.textContent }; });
  ok(fold.folded && !fold.required, 'with SOAP, the Narrative box folds away and is not required', JSON.stringify(fold));
  await axe(kp.page, 'a SOAP note on a phone');
  await kp.page.fill('.modal textarea[data-sec=S]', `Says sleeping better ${tag}`); await kp.page.fill('.modal textarea[data-sec=P]', 'Review in two weeks');
  await kp.page.click('.modal .btn-row button[type=submit]:has-text("Save draft")');
  await until(async () => !(await kp.page.$('.modal [data-narrative-built]')));
  const saved = (await kp.api('GET', `/api/notes?client_id=${cid}&mine=1`)).data.rows[0];
  ok(saved && saved.kind === 'clinical', 'the draft saves without a narrative typed, as a clinical note');
  if (saved) ok(/Subjective: Says sleeping better/.test((await kp.api('GET', `/api/notes/${saved.id}`)).data.note.content), 'its narrative built from the sections');
  // Switching back to a narrative note makes the box required again.
  await quick('Note');
  await kp.page.selectOption('.modal select[name=format]', 'SOAP'); await kp.page.selectOption('.modal select[name=format]', 'narrative');
  ok(await kp.page.$eval('.modal textarea[name=content]', t => t.required && !t.closest('[data-narrative-built]')), 'a narrative note still asks for the narrative');
  await closeModals(kp.page);
  await quick('Log a visit');
  eq(await kp.page.$eval('.modal [name=client_id]', i => i.value), cid, '+ Log › Log a visit there starts with that client too');
  await closeModals(kp.page);
  await kp.ctx.close();

  // ------------------------------------------------------------------ L3 at 1280 px
  eq((await maria.api('POST', '/api/notes', { client_id: cid, kind: 'admin', format: 'narrative', occurred_at: new Date().toISOString(), title: `Note${tag}`, content: 'Met at the drop-in.' })).status, 201, 'Maria writes a note');
  await maria.go('notes');
  const nrow = await until(async () => { for (const tr of await maria.page.$$('.main tbody tr')) if ((await tr.textContent()).includes(`Note${tag}`)) return tr; return null; });
  ok(nrow && (await (await nrow.$('td[data-label=Client]')).textContent()).includes(`Timeline${tag}, Nell`), 'Notes name the client (Last, First) as the other lists do');
  ok(nrow && await nrow.$('button[data-note-open]:text-is("Open")'), 'and each row has an Open button');
  if (nrow) { await (await nrow.$('button[data-note-open]')).click(); ok(await until(() => maria.page.$('.modal [data-note-client]')), 'which opens the note'); await closeModals(maria.page); }
  await axe(maria.page, 'Notes at 1280 px');
  await maria.ctx.close();

  // ------------------------------------------------------------------ L4 / L5 / L6: lists on a phone
  const mp = await session('mrivera', PW, ...PHONE);
  for (const [hash, name, tall] of [['interventions', 'Visits', 140], ['notes', 'Notes', 140], ['referrals?status=all', 'Referrals', 260], ['calls', 'Calls', 140]]) {
    await mp.go(hash);
    const g = await mp.page.evaluate(() => {
      const box = document.querySelector('.main [data-filters]'); const sum = box && box.querySelector('summary');
      const rows = [...document.querySelectorAll('.main .compact-list .compact-row')].filter(r => r.offsetParent);
      return { box: !!box, open: box ? box.open : null, sum: sum ? sum.getBoundingClientRect().height : 0, n: rows.length, bottom: rows[0] ? rows[0].getBoundingClientRect().bottom + scrollY : 9999, fab: document.querySelector('.fab .btn')?.getBoundingClientRect().top ?? innerHeight, tall: Math.max(0, ...rows.slice(0, 10).map(r => r.getBoundingClientRect().height)) };
    });
    ok(g.box && g.open === false && g.sum >= 44, `${name} on a phone: the filters fold behind a Filters button`, JSON.stringify(g));
    ok(g.n > 0 && g.bottom <= g.fab, `${name}: the first row is on the first screen, above the floating + Log`, JSON.stringify(g));
    ok(g.tall > 0 && g.tall < tall, `${name}: compact rows (under ${tall} px)`, `${g.tall}px`);
    await axe(mp.page, `${name} on a phone`);
    if (name === 'Notes') ok(await mp.page.$$eval('.main .compact-row .primary', ps => ps.some(p => /,/.test(p.textContent))), 'Notes on a phone name the client');
    if (name === 'Visits') {
      await mp.page.click('.main [data-filters] summary'); await settle(mp.page);
      ok(await mp.page.isVisible('.main [data-filters] select'), 'Filters opens the filters');
      // L6: at the foot of the list the last row is clear of the floating + Log.
      await mp.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await mp.page.waitForTimeout(150);
      const clear = await mp.page.evaluate(() => { const rows = [...document.querySelectorAll('.main .compact-list .compact-row')].filter(r => r.offsetParent); const last = rows[rows.length - 1]; const fab = document.querySelector('.fab .btn'); return { last: last ? last.getBoundingClientRect().bottom : 0, fab: fab ? fab.getBoundingClientRect().top : 9999 }; });
      ok(clear.last > 0 && clear.last <= clear.fab, 'the last row scrolls clear of the floating + Log', JSON.stringify(clear));
    }
  }
  await mp.ctx.close();

  // ------------------------------------------------------------------ L1 / L9
  const admin = await session('admin', 'AdminPassw0rd!x');
  ok(!/Harm Reduction/.test((await admin.api('GET', '/api/app/info')).data.name), 'the seeded treatment-profile programme is not named harm reduction');
  await admin.ctx.close();
  const fin = await session('afinance', PW, undefined, {}, { tour: false });
  await fin.go('dashboard?welcome=1');
  const intro = await fin.page.textContent('[data-welcome]').catch(() => '');
  ok(intro && !/Anything you add/.test(intro) && /phone and your computer/.test(intro), 'Finance\'s welcome does not promise that what they add shows up elsewhere', intro.slice(0, 300));
  await fin.ctx.close();
} catch (e) {
  fail(`crashed: ${e.stack || e.message}`);
}
await browser.close();
eq(errors.length, 0, `no page errors, console errors or 5xx${errors.length ? ': ' + errors.join(' / ') : ''}`);
finish();

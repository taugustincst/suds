// The UI evaluation of all six roles (1.15.2), replayed in a browser:
//   1. Supervision: each unsigned draft has "Open note" (the note opens in place) and "Remind author" (a to-do
//      for the author, through POST /api/tasks); "Remind all overdue authors" confirms, sends one reminder per
//      note and never a second while one is open;
//   2. + 3. individual permissions have their own dialog (a Permissions button on each user's row, a badge on
//      rows with overrides), and a new user's permissions open straight after the account is created;
//   4. a supervisor's sidebar leads with Supervision and their daily pages; the rest is under More, not gone;
//   5. a read-only account's Home leads with its reports, with no to-do or "continue" card;
//   6. the client record's tab strip promotes Care plan and Assessments for a clinician, Episodes and Care team
//      for a supervisor, and keeps the six everyday tabs for everyone;
//   7. the funder report's three downloads each say what they are for.
// Each page it changes is checked with axe (WCAG 2.1 A/AA) as well.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('ui-eval');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
let expect400 = false; // set while a step deliberately sends what the server refuses (a too-short reason)

async function session(username, password = PW, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[134]/.test(m.text()) && !(expect400 && /status of 400/.test(m.text()))) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 });
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  await api('PUT', '/api/me/prefs', { tour_done: true });
  await settle(page);
  const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 15000 }).catch(() => {}); await settle(page); };
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
const sidebar = (page) => page.evaluate(() => {
  const nav = document.querySelector('.sidebar nav.nav');
  const more = nav.querySelector('details.nav-more');
  const name = (a) => [...a.childNodes].filter(n => !(n.classList && n.classList.contains('ico'))).map(n => n.textContent).join('').trim();
  return { main: [...nav.querySelectorAll(':scope > a')].map(name), more: more ? [...more.querySelectorAll('a')].map(name) : [] };
});
const visibleTabs = (page) => page.$$eval('.main nav.tabs > button[data-tab]', bs => bs.filter(b => !b.hidden && b.offsetParent !== null).map(b => b.dataset.tab));
const closeModals = async (page) => { for (let i = 0; i < 4 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await settle(page); } };
// A "finish and sign" reminder is one per author and client, known by its last line (1.23.2: no record id in it).
const MARK = 'This reminder closes itself once your draft notes on this client\'s record are signed.';
const pair = (d) => `${d.client_id} ${d.author_id}`;
const isReminder = (t) => (t.description || '').includes(MARK);
const openReminders = async (s) => ((await s.api('GET', '/api/tasks?status=open&limit=1000')).data.rows || []).filter(isReminder).map(t => `${t.client_id} ${t.assigned_to}`);

try {
  const sup = await session('jwalker');
  const nav = await session('mrivera');

  // ------------------------------------------------------------------------------------------------------ 1
  {
    // The seed's drafts: the queue marks one overdue by its creation date, which only the seed can set.
    await sup.go('supervision');
    let rows = await sup.page.$$('[data-section=unsigned] [data-open-note]');
    ok(rows.length > 0, 'the supervision queue lists the team\'s unsigned drafts', rows.length);
    const q = (await sup.api('GET', '/api/supervision/queue')).data;
    const meId = (await sup.api('GET', '/api/auth/me')).data.user.id;
    const overdue = q.unsigned_notes.filter(x => x.overdue && x.author_id && x.author_id !== meId);
    ok(q.unsigned_notes.every(x => x.author_id), 'every draft in the queue names its author', q.unsigned_notes.length);
    ok(overdue.length >= 2, 'the seed has overdue drafts to remind about', overdue.length);

    // Open note: the note opens in place, over the queue.
    const first = q.unsigned_notes[0];
    await sup.page.click(`[data-open-note="${first.id}"]`);
    await sup.page.waitForSelector('.modal', { timeout: 8000 }); await settle(sup.page);
    ok(/Author/.test(await sup.page.textContent('.modal')), '"Open note" opens the note in a dialog');
    eq(await sup.page.evaluate(() => location.hash.split('?')[0]), '#/supervision', 'without leaving the queue');
    await closeModals(sup.page);

    // Remind author: one row.
    const one = overdue[0];
    const before = await openReminders(sup);
    ok(!before.includes(pair(one)), 'no reminder is open for that note yet');
    await sup.page.click(`[data-remind-author="${one.id}"]`);
    ok(await until(() => sup.page.$(`[data-reminded="${one.id}"]`), { timeout: 8000 }), 'after "Remind author" the row says a reminder was sent');
    ok(!(await sup.page.$(`[data-remind-author="${one.id}"]`)), 'and offers no second reminder');
    const task = ((await sup.api('GET', '/api/tasks?status=open&limit=1000')).data.rows || []).find(t => isReminder(t) && `${t.client_id} ${t.assigned_to}` === pair(one));
    ok(task, 'a reminder to-do exists');
    ok(task && !task.description.includes(one.id) && !/Reference:/.test(task.description), 'its details carry no record id (1.23.2)', task && task.description);
    eq(task && task.assigned_to, one.author_id, 'assigned to the note\'s author');
    eq(task && task.client_id, one.client_id, 'on the note\'s client');
    // 1.23.3 (D3): it covers all the author's drafts on the client's record, so it names the client, not one note.
    ok(task && /^Finish and sign your draft notes for /.test(task.title), 'titled for the author\'s drafts on that client, without a note\'s content', task && task.title);
    ok(task && /once they are all signed/.test(task.description), 'and says it closes once they are all signed', task && task.description);
    eq(task && task.sign_reminder, true, 'the office marks it a sign reminder (its maker countersigns notes)');

    // Remind all overdue authors: confirmation, de-duplicated, one per note.
    const expected = new Set(overdue.filter(x => pair(x) !== pair(one)).map(pair)).size;
    const skipped = overdue.filter(x => pair(x) === pair(one)).length;
    eq(await sup.page.$eval('[data-remind-all]', b => b.dataset.remindAll), String(expected), 'the bulk action counts one reminder per author and client with no open reminder');
    await sup.page.click('[data-remind-all]');
    await sup.page.waitForSelector('.modal-bg .modal', { timeout: 5000 });
    const msg = await sup.page.textContent('.modal-bg:last-child .modal');
    ok(new RegExp(`Send ${expected} reminder`).test(msg), 'the confirmation says how many reminders it sends', msg);
    ok(new RegExp(`${skipped} notes? already ha(s|ve) an open reminder`).test(msg), 'and that the note already reminded is skipped', msg);
    await sup.page.locator('.modal-bg').nth(-1).locator('button', { hasText: /^Send \d+ reminder/ }).click();
    await until(async () => (await sup.page.$eval('[data-remind-all]', b => b.dataset.remindAll).catch(() => null)) === '0', { timeout: 15000 });
    eq(await sup.page.$eval('[data-remind-all]', b => b.dataset.remindAll), '0', 'afterwards every overdue note has its reminder');
    const after = await openReminders(sup);
    for (const d of overdue) eq(after.filter(x => x === pair(d)).length, 1, `exactly one open reminder for overdue note ${d.id.slice(0, 8)}'s author and client`);
    // Pressing it again sends nothing.
    await sup.page.click('[data-remind-all]'); await settle(sup.page);
    ok(!(await sup.page.$('.modal-bg')), 'a second press asks nothing: there is nobody left to remind');
    eq((await openReminders(sup)).length, after.length, 'and sends no further to-do');
    // The author sees the reminder among their own to-dos.
    const theirs = (await nav.api('GET', '/api/tasks?mine=1&status=open&limit=500')).data.rows || [];
    const navDrafts = overdue.filter(d => theirs.some(t => isReminder(t) && `${t.client_id} ${t.assigned_to}` === pair(d)));
    if (overdue.some(d => d.author === 'Maria Rivera')) ok(navDrafts.length > 0, 'the navigator has the reminders for her drafts');
    await axe(sup.page, 'supervision queue with reminders');
    // 1.23.3 (D2): the reminder leads to the drafts it asks about: "Open <client>'s notes", on the client's Notes tab
    // showing the author's own drafts. It used to open only as Edit to-do.
    const navReminder = theirs.find(t => t.sign_reminder && navDrafts.some(d => `${t.client_id} ${t.assigned_to}` === pair(d)));
    ok(navReminder, 'the navigator has a sign reminder to open');
    if (navReminder) {
      await nav.go(`tasks?id=${navReminder.id}`);
      ok(await until(() => nav.page.$('.modal [data-task-source="notes"]')), 'her reminder offers the client\'s notes');
      const label = await nav.page.textContent('.modal [data-task-source="notes"]');
      ok(/^Open .+'s notes$/.test(label), 'named "Open <client>\'s notes"', label);
      await nav.page.click('.modal [data-task-source="notes"]');
      ok(await until(() => nav.page.evaluate((cid) => location.hash.startsWith(`#/client/${cid}/notes?drafts=mine`), navReminder.client_id)), 'which opens the client\'s Notes tab on her drafts', await nav.page.evaluate(() => location.hash));
      await settle(nav.page);
      ok(await until(() => nav.page.$('[data-my-drafts]')), 'showing her own drafts');
      const shown = await nav.page.evaluate(() => document.querySelector('[data-my-drafts]').textContent);
      ok(/Your draft notes on this record \(\d+\)/.test(shown), 'counted, with a way back to all notes', shown.slice(0, 120));
      ok(await nav.page.$('[data-my-drafts] a[data-all-notes]'), 'and "Show all notes"');
      await axe(nav.page, 'a client\'s Notes tab on the reader\'s drafts');
    }
  }

  // ------------------------------------------------------------------------------------------------ 2 + 3
  {
    const admin = await session('admin', 'AdminPassw0rd!x');
    await admin.go('admin?tab=users');
    ok(await admin.page.$('[data-user-permissions="mrivera"]'), 'each user\'s row has a Permissions button');
    // The Edit dialog points to it rather than holding it below a dozen fields.
    await admin.page.locator('table tr', { hasText: 'mrivera' }).locator('button', { hasText: 'Edit' }).click();
    await admin.page.waitForSelector('.modal'); await settle(admin.page);
    ok(!(await admin.page.$('.modal [data-perm-grant-form]')), 'the Edit dialog no longer carries the permissions section');
    ok(await admin.page.$('.modal [data-open-permissions]'), 'it has a "Permissions…" button instead');
    await admin.page.click('.modal [data-open-permissions]');
    ok(await until(() => admin.page.$('.modal [data-perm-dialog] [data-perm-grant-form]'), { timeout: 8000 }), 'which opens the Permissions dialog');
    await closeModals(admin.page);

    // Create a user: the Permissions dialog follows straight away.
    const uname = 'uieval' + Date.now().toString().slice(-6);
    await admin.page.click('text=+ New user'); await admin.page.waitForSelector('.modal input[name=username]');
    ok(!/Save the user first/.test(await admin.page.textContent('.modal')), 'the new-user form no longer says "Save the user first"');
    await admin.page.fill('.modal input[name=username]', uname);
    await admin.page.fill('.modal input[name=display_name]', 'Eval Person');
    await admin.page.selectOption('.modal select[name=role]', 'navigator');
    await admin.page.click('.modal button[type=submit]');
    await admin.page.waitForSelector('[data-temp-password]', { timeout: 10000 });
    await admin.page.click('.modal button:has-text("I have shared it")');
    ok(await until(() => admin.page.$('.modal [data-perm-just-created]'), { timeout: 8000 }), 'after the password, the new user\'s Permissions dialog opens');
    ok(await until(() => admin.page.$('.modal [data-perm-grant-form]'), { timeout: 8000 }), 'ready to grant or deny');
    await axe(admin.page, 'Permissions dialog');
    await admin.page.selectOption('[data-perm-select]', 'audit:read');
    await admin.page.check('[data-perm-mode=grant]');
    // Reason enforcement and provenance are the same as before: a short reason is refused.
    await admin.page.fill('[data-perm-reason]', 'short');
    expect400 = true;
    await admin.page.click('[data-perm-save]');
    ok(await until(() => admin.page.$('.toast.error'), { timeout: 5000 }), 'a reason under 10 characters is refused');
    await settle(admin.page); expect400 = false;
    await admin.page.fill('[data-perm-reason]', 'reviews the break-glass queue weekly');
    await admin.page.click('[data-perm-save]');
    ok(await until(() => admin.page.$('[data-perm-overrides] [data-perm-badge="granted"]'), { timeout: 8000 }), 'the grant shows its "granted" badge');
    await admin.page.click('[data-perm-done]');
    await until(async () => !(await admin.page.$('.modal-bg')), { timeout: 5000 }); await settle(admin.page);
    ok(await until(() => admin.page.$(`[data-user-permissions="${uname}"]`), { timeout: 8000 }), 'the list shows the new user');
    // Two: the grant, and (1.17.0) the program default's deny of See every client, on for a new install.
    eq(await admin.page.locator('table tr', { hasText: uname }).locator('[data-perm-count]').getAttribute('data-perm-count'), '2', 'with a badge for their overrides (the grant and the program default\'s caseload hold)');
    ok(!(await admin.page.locator('table tr', { hasText: 'mrivera' }).locator('[data-perm-count]').count()), 'a user on their role alone has no badge');
    // The administrator's own row: explained, not editable.
    await admin.page.click('[data-user-permissions="admin"]');
    ok(await until(async () => /You cannot change your own permissions/.test(await admin.page.textContent('.modal').catch(() => ''))), 'the administrator\'s own permissions are explained, not editable');
    await closeModals(admin.page);
    await axe(admin.page, 'Users & permissions');
    await admin.ctx.close();
  }

  // ------------------------------------------------------------------------------------------------------ 4
  {
    await sup.go('dashboard');
    const sb = await sidebar(sup.page);
    eq(sb.main.slice(0, 2).join(', '), 'Home, Supervision', 'a supervisor\'s sidebar starts with Home and Supervision');
    ok(sb.main.length <= 11, `with ${sb.main.length} pages in the main list, not 23`, sb.main);
    for (const want of ['Clients', 'Waitlist', 'To-dos', 'Visits', 'Notes', 'Referrals', 'Settings']) ok(sb.main.includes(want), `the main list has ${want}`, sb.main);
    for (const want of ['Reports', 'Funder report', 'Funding & spending', 'Policies & contracts', 'Resource directory', 'Supplies', 'My time', 'Privacy & Part 2', 'Import']) ok(sb.more.includes(want), `${want} is under More`, sb.more);
    ok(sb.main.length + sb.more.length >= 21, 'nothing is gone: the main list and More together hold every page', sb);
    const adminSb = await (async () => { const a = await session('admin', 'AdminPassw0rd!x'); const x = await sidebar(a.page); await a.ctx.close(); return x; })();
    eq(adminSb.more.length, 0, 'an administrator\'s sidebar is unchanged (no More)');
    // More still reaches a page.
    await sup.page.evaluate(() => { document.querySelector('.sidebar details.nav-more').open = true; });
    await sup.page.click('.sidebar a[href="#/reports"]'); await settle(sup.page);
    ok(/Reports/.test(await sup.page.textContent('.main h1')), 'Reports opens from More');
  }

  // ------------------------------------------------------------------------------------------------------ 5
  {
    const ro = await session('rreader');
    await ro.go('dashboard');
    const heads = await ro.page.$$eval('.main h2', hs => hs.map(x => x.textContent.trim()));
    ok(!heads.includes('To-dos for today'), 'a read-only Home has no "To-dos for today"', heads);
    ok(!heads.includes('Continue where you left off'), 'and no "Continue where you left off"', heads);
    ok(await ro.page.$('[data-home-reports] a[href="#/funder"]'), 'it leads with the reports: the funder report');
    ok(await ro.page.$('[data-home-reports] a[href="#/reports"]'), 'and Reports');
    ok(await ro.page.evaluate(() => { const r = document.querySelector('[data-home-reports]'); const s = document.querySelector('.card.stat'); return !!r && !!s && !!(r.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'above the figures');
    ok((await ro.page.$$('.card.stat')).length > 0, 'and the figures it may see are still there');
    ok(!/\+ Add a reminder/.test(await ro.page.textContent('#main')), 'nothing offers an action it cannot take');
    await axe(ro.page, 'read-only Home');
    await ro.go('funder');
    ok(/Funder report/.test(await ro.page.textContent('.main h1')), 'the read-only funder report opens');
    await ro.ctx.close();
    await nav.go('dashboard');
    ok(await nav.page.$('.card h2:text-is("To-dos for today")'), 'a navigator\'s Home keeps "To-dos for today"');
    ok(!(await nav.page.$('[data-home-reports]')), 'and has no reports lead');
  }

  // ------------------------------------------------------------------------------------------------------ 6
  {
    const { data: list } = await nav.api('GET', '/api/clients?limit=5&status=active');
    const cid = list.clients[0].id;
    const me = (await sup.api('GET', '/api/auth/me')).data;
    const mods = (me.programme && me.programme.modules) || {};
    const core = ['overview', 'interventions', 'notes', 'tasks', 'consents', 'referrals'];
    await nav.go(`client/${cid}/overview`);
    let t = await visibleTabs(nav.page);
    eq(t.join(','), core.join(','), 'a navigator\'s strip is the six everyday tabs', t);
    const clin = await session('kpatel');
    // A clinician's caseload is their own: one of their clients, not the navigator's.
    const ccid = (await clin.api('GET', '/api/clients?limit=5&status=active')).data.clients[0].id;
    await clin.go(`client/${ccid}/overview`);
    t = await visibleTabs(clin.page);
    for (const k of core) ok(t.includes(k), `a clinician keeps ${k}`, t);
    if (mods.careplan !== false) ok(t.includes('careplan'), 'a clinician has Care plan in the strip', t);
    if (mods.assessments !== false) ok(t.includes('assessments'), 'and Assessments', t);
    ok(!t.includes('episodes'), 'but not the supervisor\'s Episodes', t);
    await clin.ctx.close();
    await sup.go(`client/${cid}/overview`);
    t = await visibleTabs(sup.page);
    for (const k of core) ok(t.includes(k), `a supervisor keeps ${k}`, t);
    ok(t.includes('episodes') && t.includes('team'), 'a supervisor has Episodes and Care team in the strip', t);
    ok(await sup.page.$('.main nav.tabs .tabs-more-wrap:not([hidden])'), 'the rest stay under More');
    // At 200% text the strip still fits the screen (WCAG 1.4.10): the row is measured after the promotion.
    await sup.page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await sup.go(`client/${cid}/budget`);
    await sup.page.evaluate(() => { document.documentElement.style.fontSize = '200%'; document.querySelector('.main nav.tabs').relayout(); });
    await settle(sup.page);
    const over = await sup.page.$$eval('.main nav.tabs > *', els => els.filter(e => !e.hidden && e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.className || e.tagName));
    eq(over.join(', '), '', 'at 200% text no tab runs past the screen');
    await sup.page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  }

  // ------------------------------------------------------------------------------------------------------ 7
  {
    const today = new Date().toISOString().slice(0, 10);
    await sup.go(`funder?from=${today.slice(0, 4)}-01-01&to=${today}`);
    ok(await sup.page.$('[data-funder-downloads] h2:text-is("Which file do I send?")'), 'the funder report groups its downloads under "Which file do I send?"');
    for (const k of ['xlsx', 'csv', 'workbook']) {
      const help = await sup.page.$(`[data-funder-export-help="${k}"]`);
      ok(help && (await help.textContent()).length > 20, `the ${k} download says what it is for`);
      eq(await sup.page.$eval(`[data-funder-export="${k}"]`, b => b.getAttribute('aria-describedby')), await sup.page.$eval(`[data-funder-export-help="${k}"]`, e => e.id), `and the ${k} button is described by it`);
    }
    ok(/Send this one to your funder/.test(await sup.page.textContent('[data-funder-export-help=xlsx]')), 'the Excel file is the one for the funder');
    ok(/portal|system/.test(await sup.page.textContent('[data-funder-export-help=csv]')), 'the CSV is for a portal or data system');
    ok(/Not for sending/.test(await sup.page.textContent('[data-funder-export-help=workbook]')), 'everything-to-Excel is not for sending');
    await axe(sup.page, 'funder report downloads');
  }
} catch (e) {
  fail(`script error: ${e.stack || e.message}`);
}
await browser.close();
finish(errors);

// The frontline-UX review of 1.16.0 (fixed in 1.16.1), in a browser:
//   H1 another worker's overdose event opens read-only, saying who reported it and who can change it;
//   H2 on a phone, Delete event sits in the form's own button row and never covers Save;
//   H3 a colleague's visit (and a desktop call) opens in full, read-only; your own offers Edit and Delete there;
//   M1 a row with no Edit/Delete says whose it is ("Recorded by … — view only"), as does a colleague's draft note;
//   M2 the server's refusal of someone else's record names who can change it;
//   M3 one role summary on New user and Edit user, the permission catalog says "change own";
//   M5 the Visits action column fits a 1280 px window; M6 Home says whose figures its tiles are;
//   L1 the to-do list's checkbox columns are named; L3 the Supplies tabs wrap at 390 px; L9 the client header
//   names the primary worker; L10 Referrals say Edit, not Update.
// Pages and dialogs it changes are checked with axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('r6');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];

async function session(username, password = PW, viewport = { width: 1280, height: 900 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  await api('PUT', '/api/me/prefs', { tour_done: true });
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
const rowWith = (page, text) => until(async () => { for (const tr of await page.$$('.main tbody tr')) if ((await tr.textContent()).includes(text)) return tr; return null; });
const tag = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

try {
  // ------------------------------------------------------------------ David's records, made through the API
  const dchen = await session('dchen');
  const cid = (await dchen.api('GET', '/api/clients?limit=1')).data.clients[0].id;
  const now = new Date().toISOString();
  const longSummary = `R6${tag} ` + 'Met at the encampment; talked through housing and the detox bed list. '.repeat(4) + `End${tag}: never call his mother; use the text line only.`;
  const ev = await dchen.api('POST', '/api/overdose-events', { occurred_at: now, kind: 'reversal', naloxone_used: 1, naloxone_doses: 2, city: `Town${tag}`, notes: `Notes${tag}` });
  eq(ev.status, 201, 'David records a reversal');
  const visit = await dchen.api('POST', '/api/interventions', { type: 'post_overdose_follow_up', client_id: cid, occurred_at: now, summary: longSummary });
  eq(visit.status, 201, 'David logs a visit with a long summary');
  const call = await dchen.api('POST', '/api/calls', { client_id: cid, direction: 'outbound', started_at: now, duration_minutes: 5, contact_type: 'client', outcome: 'reached', method: 'phone', purpose: `Call${tag}`, summary: longSummary });
  eq(call.status, 201, 'and a call');
  const task = await dchen.api('POST', '/api/tasks', { title: `Task${tag}`, client_id: cid, priority: 'normal', status: 'open' });
  eq(task.status, 201, 'and a to-do of his own');
  const note = await dchen.api('POST', '/api/notes', { client_id: cid, kind: 'admin', format: 'narrative', title: `Draft${tag}`, content: 'Draft by David.', occurred_at: now });
  eq(note.status, 201, 'and a draft note');
  await dchen.ctx.close();

  // ------------------------------------------------------------------ Maria, a navigator, at 1280 px
  const maria = await session('mrivera');
  const { page, go, api } = maria;
  const own = await api('POST', '/api/overdose-events', { occurred_at: now, kind: 'overdose', city: `Mine${tag}` });
  eq(own.status, 201, 'Maria records an event of her own');
  await api('POST', '/api/interventions', { type: 'post_overdose_follow_up', client_id: cid, occurred_at: now, summary: `Own${tag}` });

  // H1: David's event opens to read, not as a form Save would then refuse.
  await go('overdose');
  let row = await rowWith(page, `Town${tag}`);
  ok(row, 'David\'s event is listed');
  if (row) {
    await (await row.$('.row-open')).click();
    const view = await until(() => page.$('.modal [data-overdose-view]'));
    ok(view, 'another worker\'s event opens read-only');
    ok(!(await page.$('.modal select[name=kind]')) && !(await page.$('.modal button:has-text("Delete event")')), 'with no form fields and no Delete');
    const notice = view ? await page.textContent('.modal [data-owned-notice]') : '';
    ok(/Reported by David Chen/.test(notice) && /supervisor/.test(notice), 'and says who reported it and who can change it', notice);
    ok((await page.textContent('.modal')).includes(`Notes${tag}`), 'showing the whole event, notes included');
    await axe(page, 'overdose event, read-only');
    await closeModals(page);
  }
  row = await rowWith(page, `Mine${tag}`);
  if (row) {
    await (await row.$('.row-open')).click();
    ok(await until(() => page.$('.modal form > .btn-row button:has-text("Delete event")')), 'Maria\'s own event opens as its form, Delete in the form\'s own button row');
    await closeModals(page);
  }

  // M2: the refusal says who can change it (on the office server and the device alike: app.js maps it).
  const refusal = await page.evaluate(async (id) => { const m = await import('/app.js'); try { await m.put(`/api/overdose-events/${id}`, { city: 'x' }); return 'saved'; } catch (e) { return e.message; } }, ev.data.id);
  ok(/Only the person who recorded this, or a supervisor or administrator, can change it/.test(refusal), 'a refused change says who can make it', refusal);

  // H3 / M1 / M5: Visits.
  await go('interventions');
  row = await rowWith(page, `R6${tag}`);
  ok(row, 'David\'s visit is listed');
  if (row) {
    const cell = await row.$('[data-view-only]');
    // 1.16.2 (r7 L5): the row's Worker column already names David, so the actions cell says only "View only".
    eq(cell && (await cell.textContent()).trim(), 'View only', 'its actions cell says it is view only');
    ok(!(await row.textContent()).includes(`End${tag}`), 'the list shows only the start of the summary');
    await (await row.$('.row-open')).click();
    const view = await until(() => page.$('.modal [data-visit-view]'));
    ok(view, 'the visit opens from its row');
    ok(view && (await view.textContent()).includes(`End${tag}: never call his mother`), 'with the whole summary');
    ok(/Recorded by David Chen\. Only they or a supervisor or administrator can change it; you can add your own visit/.test(await page.textContent('.modal [data-owned-notice]').catch(() => '')), 'and who can change it');
    ok(!(await page.$('.modal button:has-text("Edit visit")')), 'with no Edit for Maria');
    await axe(page, 'a colleague\'s visit, read-only');
    await closeModals(page);
  }
  row = await rowWith(page, `Own${tag}`);
  if (row) {
    const edit = await row.$('button:has-text("Edit")');
    const box = edit && await edit.boundingBox();
    ok(box && box.x + box.width <= 1280, 'the Edit button fits a 1280 px window', box && `ends at ${Math.round(box.x + box.width)}`);
    await (await row.$('.row-open')).click();
    ok(await until(() => page.$('.modal [data-visit-view] button:has-text("Edit visit")')), 'Maria\'s own visit offers Edit in its dialog');
    ok(!(await page.$('.modal [data-owned-notice]')), 'with no ownership notice');
    await closeModals(page);
  }

  // H3: a desktop call opens in full.
  await go('calls');
  row = await rowWith(page, `Call${tag}`);
  ok(row, 'David\'s call is listed');
  if (row) {
    ok(await row.$('[data-view-only]'), 'saying whose it is');
    await (await row.$('.row-open')).click();
    const view = await until(() => page.$('.modal [data-call-view]'));
    ok(view && (await view.textContent()).includes(`End${tag}`), 'and it opens on a desktop, with the whole summary');
    ok(await page.$('.modal [data-owned-notice]'), 'and who can change it');
    await axe(page, 'a colleague\'s call, read-only');
    await closeModals(page);
  }

  // L10 + M1: referrals.
  await go('referrals?status=all');
  eq(await page.locator('.main button:text-is("Update")').count(), 0, 'Referrals say Edit, not Update');

  // L1 + M1 / L2: to-dos.
  await go('tasks?mine=0');
  const heads = await page.$$eval('.main table thead th', ths => ths.map(t => t.textContent.trim()));
  ok(heads.includes('Done') && heads.includes('Select'), 'the to-do checkbox columns are named Done and Select', heads.join(' | '));
  row = await rowWith(page, `Task${tag}`);
  const tcell = row && await row.$('[data-view-only]');
  // 1.23.4: only whoever it is assigned to or made it (or a manager of others' records) may mark it done; the server
  // refuses anyone else, so the list no longer offers Maria its box or says she can tick it.
  ok(tcell && /Assigned to David Chen — view only/.test(await tcell.textContent()) && !/mark it done/.test(await tcell.textContent()), 'David\'s to-do says whose it is, and no longer that Maria can mark it done', tcell && await tcell.textContent());
  eq(row ? await row.$$eval('input[type=checkbox]', x => x.length) : -1, 0, 'and offers Maria no box to tick on it');
  await axe(page, 'to-dos');

  // M1: a colleague's draft note.
  await page.evaluate(async (id) => (await import('/views/notes.js')).openNote(id), note.data.id);
  const dn = await until(() => page.$('.modal [data-owned-notice]'));
  ok(dn && /Draft by David Chen, not yet signed\. Only the author/.test(await dn.textContent()), 'a colleague\'s draft note says who can finish it', dn && await dn.textContent());
  await closeModals(page);

  // Owner decision (1.16.1): a navigator reads clinical notes but not SUD counseling notes; the list says so.
  await go('notes');
  ok(/visible only to their author, the co-signer and clinical staff/.test(await page.textContent('[data-counseling-hidden]').catch(() => '')), 'Notes tells a navigator where SUD counseling notes are');

  // M6 + L9: Home and the client header.
  await go('dashboard');
  eq((await page.textContent('[data-tiles-heading]').catch(() => '')).trim(), 'The whole program at a glance', 'Home says its tiles are the program\'s');
  ok(await page.$('h2:text-is("Your clients who need a check-in")'), 'and the check-in list is Maria\'s own');
  await axe(page, 'Home');
  await go(`client/${cid}`);
  const pw = await page.$('[data-primary-worker]');
  ok(pw && /primary worker|No primary worker/.test(await pw.textContent()), 'the client header says whose client it is', pw && await pw.textContent());
  await maria.ctx.close();

  // ------------------------------------------------------------------ H2: a supervisor on a phone
  const jw = await session('jwalker', PW, { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await jw.go('overdose');
  const card = await rowWith(jw.page, `Town${tag}`);
  if (card) {
    await (await card.$('.row-open')).click();
    await jw.page.waitForSelector('.modal select[name=kind]');
    const hit = await jw.page.evaluate(() => {
      const save = document.querySelector('.modal form > .btn-row button[type=submit]'); const r = save.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!el && save.contains(el);
    });
    ok(hit, 'at 390 px, Save is what is under its own centre (Delete no longer covers it)');
    ok(await jw.page.$('.modal form > .btn-row button:has-text("Delete event")'), 'and Delete event is beside it in the same row');
    await closeModals(jw.page);
  } else fail('the supervisor does not see David\'s event');
  // L3: Supplies tabs wrap instead of scrolling past the edge.
  await jw.go('supplies');
  const tabs = await jw.page.$eval('.main nav.tabs', n => ({ wrapped: n.classList.contains('wrapped'), over: n.scrollWidth - n.clientWidth })).catch(() => null);
  ok(tabs && tabs.wrapped && tabs.over <= 1, 'at 390 px the Supplies tabs wrap onto rows', JSON.stringify(tabs));
  await jw.ctx.close();

  // ------------------------------------------------------------------ M3: roles, for an administrator
  const admin = await session('admin', 'AdminPassw0rd!x');
  await admin.go('admin?tab=users');
  await admin.page.click('.main button:has-text("+ New user")');
  await admin.page.waitForSelector('.modal select[name=role]');
  const roles = await admin.page.$$eval('.modal select[name=role] option', os => os.map(o => o.textContent));
  // 1.16.2 (r7 L1): the options are the roles' names, and the chosen role's summary is shown in full under the select.
  ok(roles.includes('Navigator') && roles.includes('Supervisor'), 'New user lists the roles by name', roles.join(' | '));
  await admin.page.selectOption('.modal select[name=role]', 'navigator');
  ok(/^Navigator — sees and updates every client; reads clinical notes except SUD counseling notes.*changes only their own work$/.test(await admin.page.textContent('.modal [data-role-summary]')), 'and describes the chosen navigator role, see vs change');
  await admin.page.selectOption('.modal select[name=role]', 'supervisor');
  ok(/^Supervisor — .*can change other workers' records$/.test(await admin.page.textContent('.modal [data-role-summary]')), 'and says a supervisor changes other workers\' records');
  await axe(admin.page, 'New user dialog');
  await closeModals(admin.page);
  const cat = (await admin.api('GET', '/api/permissions/catalog')).data.permissions;
  const iv = cat.find(p => p.name === 'interventions:*');
  eq(iv && iv.label, 'Visits & services (read, log, change own)', 'the permission catalog says a visit permission changes your own');
  await admin.ctx.close();
} catch (e) {
  fail(`the script stopped: ${e.stack || e.message}`);
}
eq(errors.length, 0, `no page errors, console errors or server errors${errors.length ? ' — ' + errors.slice(0, 5).join(' | ') : ''}`);
await browser.close();
finish();

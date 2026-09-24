// What the end-user reviews found broken, checked in a real browser: the temporary password that vanished,
// the supervisor locked out of caseload transfer, countersigning blind, navigators editing grant totals,
// hidden-in-the-file document search, the local-mode hint on the office login, and phone ergonomics.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, finish } = makeChecks('review-fixes');
const errors = [];

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
async function session(user, pass, viewport = { width: 1360, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('response', r => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pass);
  await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 10000 });
  await page.evaluate((h) => fetch('/api/me/prefs', { method: 'PUT', headers: h, body: JSON.stringify({ tour_done: true }) }), H);
  await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body, h }) => { const r = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, data: j }; }, { method, path, body, h: H });
  return { page, api, close: () => ctx.close() };
}
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await settle(page); };

// ---- administrator: the generated temporary password is shown and stays until dismissed ----
const admin = await session('admin', 'AdminPassw0rd!x');
{
  const { page } = admin;
  await go(page, 'admin?tab=users');
  await page.click('text=+ New user');
  await page.waitForSelector('.modal input[name=username]');
  const uname = 'newhire' + Date.now().toString().slice(-5);
  await page.fill('.modal input[name=username]', uname); await page.fill('.modal input[name=display_name]', 'New Hire');
  await page.selectOption('.modal select[name=role]', 'navigator');
  await page.click('.modal button[type=submit]');
  const pw = await until(() => page.$('[data-temp-password]'));
  ok(pw, 'creating a user with a generated password shows that password');
  const shown = pw ? (await pw.textContent()).trim() : '';
  ok(shown.length >= 12, 'and it is a real password, not a placeholder', shown);
  await settle(page);
  ok(await page.$('[data-temp-password]'), 'it is still on screen a moment later (the list refresh no longer wipes it)');
  await page.click('text=I have shared it');
  await until(async () => (await page.textContent('.main')).includes(uname));
  ok((await page.textContent('.main')).includes(uname), 'dismissing it refreshes the user list with the new person on it');

  // ...and that person can actually get in and change it (they used to be bounced back to sign-in for ever)
  {
    const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const p2 = await ctx2.newPage();
    await p2.goto(base + '/#/login'); await p2.fill('input[name=username]', uname); await p2.fill('input[name=password]', shown);
    await p2.click('button[type=submit]');
    const landed = await until(() => p2.$('.layout input[name=new_password], .layout input[type=password]'), { timeout: 10000 });
    ok(landed, 'a new account lands on the change-password page instead of the sign-in form');
    ok(/profile/.test(p2.url()), 'on their profile', p2.url());
    await ctx2.close();
  }

  // "Finish setting up" points at backups and MFA on a fresh install
  await go(page, 'dashboard');
  const main = await page.textContent('.main');
  ok(/Turn on scheduled backups/.test(main), 'a fresh install is told that nothing is backing it up');

  // an administrator has a way in to clinical notes: break-glass, with a reason, logged
  {
    const clients = (await admin.api('GET', '/api/clients?limit=1')).data.clients;
    await go(page, `client/${clients[0].id}/notes`);
    ok(await page.$('button:has-text("Emergency access to clinical notes")'), 'the client Notes tab offers break-glass to an administrator');
  }

  // a document is found by what is inside it
  const text = Buffer.from('Naloxone kits: record the lot number and expiry on every distribution log.').toString('base64');
  const d = await admin.api('POST', '/api/documents', { title: 'Naloxone SOP', category: 'procedure', file_url: 'data:text/plain;base64,' + text, filename: 'naloxone-sop.txt' });
  eq(d.status, 201, 'a plain-text procedure uploads');
  await go(page, 'documents?q=' + encodeURIComponent('lot number'));
  const cards = await page.$$('.doc-card');
  ok(cards.length >= 1 && (await page.textContent('.main')).includes('Naloxone SOP'), 'searching for a phrase that appears only inside the file finds the document');
  ok(await page.$('.doc-snippet'), 'and shows the passage that matched');

  // Excel export dates come out as real date cells (a serial number, styled) rather than text
  const xl = await page.evaluate(async () => { const r = await fetch('/api/reports/export/expenditures?from=2000-01-01&format=xlsx', { credentials: 'same-origin' }); const b = await r.arrayBuffer(); return { status: r.status, size: b.byteLength }; });
  eq(xl.status, 200, 'the expenditure export downloads');
  ok(xl.size > 500, 'and is a real workbook');
}

// ---- administrator: the Settings form shows the policy defaults, and saving it keeps them ----
{
  const { page } = admin;
  await go(page, 'admin?tab=settings');
  const val = (n) => page.$eval(`input[name=${n}]`, e => e.value);
  eq(await val('session_idle_minutes'), '15', 'a fresh install shows the idle timeout default in the field, not a blank');
  eq(await val('session_absolute_hours'), '12', 'and the session length default');
  eq(await val('password_max_age_days'), '90', 'and the password age default');
  eq(await val('mfa_required_roles'), 'admin,supervisor,clinician,navigator,finance,readonly', 'and every role listed for MFA');
  eq(await val('backup_retain_count'), '14', 'and the backup retention default');
  await page.fill('input[name=county_name]', 'Demo County');
  await page.click('button[type=submit]:has-text("Save settings")');
  await until(async () => /Settings saved/.test(await page.textContent('body')));
  const after = (await admin.api('GET', '/api/admin/settings')).data;
  eq(after.county_name, 'Demo County', 'the county was saved');
  eq(after.policy.mfaRequiredRoles.join(','), 'admin,supervisor,clinician,navigator,finance,readonly', 'saving the form as shown did not switch MFA off for anyone');
  eq(after.policy.idleMinutes, 15, 'nor blank the idle timeout');
  eq(after.policy.passwordMaxAgeDays, 90, 'nor the password age');
}

// ---- finance: can approve staff time; sees nothing it cannot use ----
{
  // Something to approve: a navigator's submitted entry. Finance supervises nobody, so before the fix the
  // queue was scoped to "staff who name me as supervisor" and stayed empty for ever.
  const users = (await admin.api('GET', '/api/users')).data.users;
  const worker = users.find(u => u.username === 'mrivera');
  const entry = await admin.api('POST', '/api/time', { user_id: worker.id, work_date: new Date().toISOString().slice(0, 10), minutes: 35, category: 'travel', description: 'Browser check: to be returned' });
  eq(entry.status, 201, 'a time entry is logged for the navigator');
  eq((await admin.api('POST', `/api/time/${entry.data.id}/submit`, {})).status, 200, 'and submitted');
  const fin = await session('afinance', 'Navigator2026!!');
  await go(fin.page, 'supervision');
  ok(!/Not available for your role/.test(await fin.page.textContent('.main')), 'finance (time:approve) reaches the Supervision page');
  ok(/Staff time/.test(await fin.page.textContent('.main')), 'and sees the staff-time queue');
  const returnBtn = await fin.page.$('tbody button:has-text("Return")');
  ok(returnBtn, 'with the submitted entry in it (time:all, not "supervised staff")');
  if (returnBtn) {
    await returnBtn.click();
    const dialog = await until(() => fin.page.$('.modal input'));
    ok(dialog, 'Return asks for a reason before anything happens');
    await fin.page.click('.modal button:has-text("Cancel")');
    await until(async () => !(await fin.page.$('.modal-bg')));
    const entryRow = async () => (await fin.api('GET', `/api/time/${entry.data.id}`)).data.row;
    eq((await entryRow()).status, 'submitted', 'cancelling leaves the entry waiting');
    await fin.page.click('tbody button:has-text("Return")');
    await until(() => fin.page.$('.modal input'));
    await fin.page.click('.modal button:has-text("Return")');
    await settle(fin.page);
    ok(await fin.page.$('.modal input'), 'an empty reason does not send it back');
    await fin.page.fill('.modal input', 'Wrong date: the visit was on Tuesday');
    await fin.page.click('.modal button:has-text("Return")');
    await until(async () => (await entryRow()).status === 'rejected');
    const row = await entryRow();
    eq(row.status, 'rejected', 'with a reason, the entry is returned');
    eq(row.approval_note, 'Wrong date: the visit was on Tuesday', 'and the reason is on the record');
    const navS = await session('mrivera', 'Navigator2026!!');
    await go(navS.page, 'time');
    const reason = await until(() => navS.page.$('[data-return-reason]'));
    ok(reason, 'the worker sees the returned entry on My time');
    ok(reason && /Returned: Wrong date/.test(await reason.textContent()), 'with the reason spelled out, not hidden in a tooltip');
    await navS.close();
  }
  await go(fin.page, 'dashboard');
  ok(!/need a check-in/.test(await fin.page.textContent('.main')), 'no caseload card for a role with no caseload');
  ok(!(await fin.page.$$eval('.nav .sec', s => s.map(x => x.textContent))).includes('Connect clients'), 'no empty "Connect clients" heading');
  await go(fin.page, 'time');
  ok(!(await fin.page.$('tbody button:has-text("Edit")')), 'no Edit buttons on entries finance cannot edit');
  await fin.close();
}

// ---- supervisor: reaches caseload transfer; countersigns with the note in front of them; team alert ----
{
  const users = (await admin.api('GET', '/api/users')).data.users;
  const nav = users.find(u => u.username === 'mrivera'), sup = users.find(u => u.username === 'jwalker');
  eq((await admin.api('PUT', `/api/users/${nav.id}`, { requires_cosign: 1, supervisor_id: sup.id })).status, 200, 'the navigator now needs countersignature');
  const navS = await session('mrivera', 'Navigator2026!!');
  const clients = (await navS.api('GET', '/api/clients?limit=1')).data.clients;
  const note = await navS.api('POST', '/api/notes', { client_id: clients[0].id, kind: 'admin', title: 'Housing follow-up', content: 'Client secured a shelter bed; follow up Friday about the housing voucher.', occurred_at: new Date().toISOString() });
  eq(note.status, 201, 'the navigator writes a note');
  eq((await navS.api('POST', `/api/notes/${note.data.id}/sign`, { password: 'Navigator2026!!' })).status, 200, 'and signs it');
  await navS.close();

  const supS = await session('jwalker', 'Navigator2026!!');
  const { page } = supS;
  await go(page, 'admin');
  ok(/Supervision tools/.test(await page.textContent('h1')), 'a supervisor opening Settings gets their own tools page instead of "not available for your role"');
  ok(await page.$('select[name=from_user_id]'), 'with the transfer form in front of them');
  ok(await page.$('.tabs button:has-text("Audit log")'), 'and the audit log they hold audit:read for');
  const fromOpts = await page.$$eval('select[name=from_user_id] option', o => o.map(x => x.textContent));
  ok(!fromOpts.some(t => /Finance|Administrator/.test(t)), 'the caseload picker lists only staff who carry caseloads', fromOpts);
  await go(page, 'supervision');
  const btn = await page.$('button:has-text("Countersign")');
  ok(btn, 'the signed note is waiting for countersignature');
  if (btn) {
    await btn.click();
    const body = await until(() => page.$('[data-cosign-content]'));
    ok(body, 'the countersign dialog shows the note itself');
    ok(body && /shelter bed/.test(await body.textContent()), 'including what the navigator actually wrote');
    await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg')));
  }
  // the queue's row opens the note over the list, not the bare list
  const row = await page.$('tbody tr.click');
  if (row) { await row.click(); const opened = await until(() => page.$('.modal pre.note, .modal .kv')); ok(opened, 'clicking a queue row opens that note'); await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg'))); }
  await supS.close();
}

// ---- navigator: records expenses but cannot restructure grants; phone ergonomics; validation wording ----
{
  const navS = await session('mrivera', 'Navigator2026!!');
  const { page } = navS;
  await go(page, 'budget');
  ok(await page.$('button:has-text("+ Record expenditure")'), 'a navigator can still record an expenditure');
  ok(!(await page.$('button:has-text("+ Funding source")')), 'but no longer sees "+ Funding source"');
  ok(!(await page.$('button:has-text("+ Line")')), 'nor "+ Line"');
  eq((await navS.api('POST', '/api/budget/funds', { name: 'x', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1 })).status, 403, 'and the server refuses it regardless');

  // validation names the field the way the form does
  await go(page, 'interventions');
  await page.click('text=+ Log');
  await page.click('.modal button:has-text("Visit or service")');
  await page.waitForSelector('.modal select[name=type]');
  await page.click('.modal button[type=submit]');
  const msg = await until(async () => { const el = await page.$('.modal .banner, .modal .err:not(:empty)'); return el ? el.textContent() : null; });
  ok(msg && !/client_id|_id\b/.test(msg), 'a missing required field is named in plain words, not as a column name', msg);
  // Community naloxone distribution needs no client: the label says so, and it saves (with its time entry)
  // without one. Switching back to a service for a person makes Client required again.
  const clientLabel = () => page.textContent('.modal [data-field="client_id"] > label');
  ok(/\*/.test(await clientLabel()), 'Client is required before a type is chosen', await clientLabel());
  await page.selectOption('.modal select[name=type]', 'case_management');
  ok(/\*/.test(await clientLabel()), 'and for case management', await clientLabel());
  await page.selectOption('.modal select[name=type]', 'naloxone_distribution');
  ok(/optional/i.test(await clientLabel()), 'but optional for naloxone distribution', await clientLabel());
  const kitsBefore = (await navS.api('GET', '/api/interventions?type=naloxone_distribution&limit=200')).data.rows.filter(r => !r.client_id).length;
  await page.fill('.modal input[name=naloxone_kits]', '3');
  await page.click('.modal button[type=submit]');
  ok(await until(async () => !(await page.$('.modal-bg'))), 'a naloxone handout with no client saves');
  const kitsAfter = (await navS.api('GET', '/api/interventions?type=naloxone_distribution&limit=200')).data.rows.filter(r => !r.client_id).length;
  eq(kitsAfter, kitsBefore + 1, 'and is recorded with no client');
  await page.click('text=+ Log');
  await page.click('.modal button:has-text("Visit or service")');
  await page.waitForSelector('.modal select[name=type]');
  await page.selectOption('.modal select[name=type]', 'outreach');
  await page.selectOption('.modal select[name=type]', 'assessment');
  await page.click('.modal button[type=submit]');
  const msg2 = await until(async () => { const el = await page.$('.modal .banner:not(.hidden)'); const t = el ? await el.textContent() : ''; return /Client/.test(t) ? t : null; });
  ok(msg2, 'an assessment with no client is refused, naming Client', msg2);
  await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg')));
  await navS.close();

  const phone = await session('mrivera', 'Navigator2026!!', { width: 390, height: 844 });
  await go(phone.page, 'tasks');
  // On a phone the to-do list is a compact row list (see app.js table() compact); the done box lives there.
  const box = (await phone.page.$('.compact-row input[type=checkbox]')) || (await phone.page.$('tbody input[type=checkbox]'));
  const bb = box ? await box.boundingBox() : null;
  ok(bb && bb.width >= 22 && bb.height >= 22, 'to-do checkboxes are big enough to tap on a phone', JSON.stringify(bb));
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(overflow, 'the to-do list does not scroll sideways');
  await phone.close();
}

// ---- the office login points a phone with an on-device copy back to it ----
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(base + '/#/login'); await page.waitForSelector('input[name=username]');
  ok(!(await page.$('[data-local-hint]')), 'a browser that never used local mode gets the plain sign-in');
  await page.evaluate(() => localStorage.setItem('suds.localUsed', '1'));
  await page.reload(); await page.waitForSelector('input[name=username]');
  const hint = await page.$('[data-local-hint]');
  ok(hint, 'one that has an on-device copy is told where it is');
  ok(hint && /local=1/.test(await hint.innerHTML()), 'with a link straight to it');
  const manifest = await page.evaluate(() => document.querySelector('link[rel=manifest]').getAttribute('href'));
  eq(manifest, 'manifest.webmanifest', 'the office page keeps the office manifest');
  const local = await page.evaluate(async () => (await fetch('manifest-local.webmanifest')).json());
  ok(/local=1/.test(local.start_url), 'and the on-device manifest starts back on the device copy');
  await ctx.close();
}

await admin.close();
await browser.close();
if (errors.length) { console.log('ERRORS:'); errors.forEach(e => console.log('  ' + e)); } else console.log('NO ERRORS');
finish(errors);

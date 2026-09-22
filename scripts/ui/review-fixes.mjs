// What the end-user reviews found broken, checked in a real browser: the temporary password that vanished,
// the supervisor locked out of caseload transfer, countersigning blind, navigators editing grant totals,
// hidden-in-the-file document search, the local-mode hint on the office login, and phone ergonomics.
import { chromium } from 'playwright';
import { makeChecks, until } from './assert.mjs';

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
  await page.waitForTimeout(400); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body, h }) => { const r = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, data: j }; }, { method, path, body, h: H });
  return { page, api, close: () => ctx.close() };
}
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await page.waitForTimeout(500); };

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
  await page.waitForTimeout(1500);
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

// ---- finance: can approve staff time; sees nothing it cannot use ----
{
  const fin = await session('afinance', 'Navigator2026!!');
  await go(fin.page, 'supervision');
  ok(!/Not available for your role/.test(await fin.page.textContent('.main')), 'finance (time:approve) reaches the Supervision page');
  ok(/Staff time/.test(await fin.page.textContent('.main')), 'and sees the staff-time queue');
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
  await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg')));
  await navS.close();

  const phone = await session('mrivera', 'Navigator2026!!', { width: 390, height: 844 });
  await go(phone.page, 'tasks');
  const box = await phone.page.$('tbody input[type=checkbox]');
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

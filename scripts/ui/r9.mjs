// The frontline-UX review of 1.16.3 (fixed in 1.16.4), in a browser:
//   M2 the change-notice card offers Mark as seen only to the person it was sent to; anyone else sees who that is
//      ("Sent to David Chen", "Not seen yet by David Chen"), and "your client" is said only to them; the to-do list
//      gives nobody else a box to tick it off with;
//   M3 the 2-step bar goes as soon as 2-step verification is turned on (no reload), and the set-up dialog says
//      "2-step verification" / "Turn on 2-step", not "MFA";
//   M4 discharging a client whose care team you are not on says, before and after, that only your own part ends
//      and who the client stays open with, in a one-button dialog, with no "0 assignment(s) ended" toast;
//   L1 the timeline names a notice's editor once; L2 "changes to review" only for the primary worker; L3 a cancelled
//   signature says the note is saved as a draft; L4 a Reports table wider than its card says so; L5 on a phone,
//   Notes' Import folds into More and the first note is higher; L6 "Your first day" is not shown to a worker with
//   visits from before today; L7 Finance's Supervision page describes what Finance gets there.
// Pages and dialogs it changes are checked with axe (WCAG 2.1 A/AA).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('r9');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
const PHONE = [{ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }];

async function session(username, password = PW, viewport = { width: 1280, height: 900 }, extra = {}, prefs = { tour_done: true }) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${username} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`${username} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${username} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });
  await api('PUT', '/api/me/prefs', prefs);
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
const toastText = (page, re) => until(async () => { const t = await page.$$eval('#toasts .toast', ts => ts.map(x => x.textContent).join(' | ')); return re.test(t) ? t : null; }, { timeout: 5000 });
const dd = (page, sel, label) => page.$$eval(`${sel} dt`, (dts, label) => { const dt = dts.find(d => d.textContent === label); return dt ? dt.nextElementSibling.textContent : null; }, label);
const tag = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
// RFC 6238, as server/crypto.js totp(): the script is the authenticator app.
function totp(secretB32, time = Date.now()) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0; const bytes = [];
  for (const c of secretB32.toUpperCase().replace(/[^A-Z2-7]/g, '')) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest(); const off = h[h.length - 1] & 0xf;
  return String((((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1_000_000).padStart(6, '0');
}

try {
  // ------------------------------------------------------------------ David's client; Maria (off the team) edits it
  const dchen = await session('dchen');
  const made = await dchen.api('POST', '/api/clients', { first_name: 'Ada', last_name: `Notice${tag}`, confirm_duplicate: true });
  eq(made.status, 201, 'David adds a client (he becomes the primary worker)');
  const cid = made.data.id;
  await dchen.ctx.close();
  const maria = await session('mrivera');
  eq((await maria.api('PUT', `/api/clients/${cid}`, { phone: '555-301-7719' })).status, 200, 'Maria, off the care team, changes the phone number');
  await maria.ctx.close();

  // ------------------------------------------------------------------ M2 / L1 / L2: a supervisor opens the notice
  const jw = await session('jwalker');
  await jw.go(`client/${cid}`);
  const li = await until(() => jw.page.$('.main [data-timeline-notice]'));
  ok(li, 'the client\'s Recent activity lists the change');
  if (li) {
    const meta = await (await li.$('.t')).textContent();
    const text = (await li.textContent()).replace(/\s+/g, ' ');
    ok(!/·/.test(meta) && text.split('Maria Rivera').length === 2, 'L1: it names the editor once, not in the date line as well', text);
    await (await li.$('a')).click();
    const card = await until(() => jw.page.$('.modal [data-change-notice]'));
    ok(card, 'a click opens the notice card');
    if (card) {
      eq(await jw.page.textContent('.modal h2'), 'A change to a client\'s record', 'M2: to a supervisor it is "a client\'s record", not "your client\'s"');
      eq(await dd(jw.page, '.modal [data-change-notice]', 'Sent to'), 'David Chen', 'it says who it was sent to');
      eq(await dd(jw.page, '.modal [data-change-notice]', 'Status'), 'Not seen yet by David Chen', 'and that David has not seen it');
      ok(!(await jw.page.$('.modal [data-notice-seen]')), 'and offers the supervisor no Mark as seen');
      await axe(jw.page, 'the notice card, opened by a supervisor');
    }
    await closeModals(jw.page);
  }
  const tile = await jw.page.$$eval('.main .stat .l', ls => ls.map(l => l.textContent).find(t => /^Open to-dos/.test(t)) || '');
  ok(tile && !/to review/.test(tile), 'L2: the supervisor\'s Open to-dos tile does not say "changes to review"', tile);
  await jw.go('tasks?status=open&mine=0');
  const rows = await jw.page.$$eval('.main tbody tr', trs => trs.filter(tr => tr.querySelector('[data-open-notice]')).map(tr => !!tr.querySelector('input[type=checkbox]')));
  ok(rows.length > 0 && rows.every(x => !x), 'M2: in the to-do list, a notice sent to someone else has no box to tick off', JSON.stringify(rows));
  await jw.ctx.close();

  // ------------------------------------------------------------------ M2 / L2: David, the one told
  const david = await session('dchen');
  await david.go(`client/${cid}`);
  const dtile = await david.page.$$eval('.main .stat .l', ls => ls.map(l => l.textContent).find(t => /^Open to-dos/.test(t)) || '');
  ok(/1 change to review/.test(dtile), 'L2: the primary worker\'s tile says there is a change to review', dtile);
  const dli = await until(() => david.page.$('.main [data-timeline-notice] a'));
  if (dli) {
    await dli.click();
    await until(() => david.page.$('.modal [data-change-notice]'));
    eq(await david.page.textContent('.modal h2'), 'A change to your client\'s record', 'to David it is "your client\'s record"');
    ok(await david.page.$('.modal [data-notice-seen]'), 'with Mark as seen');
    eq(await dd(david.page, '.modal [data-change-notice]', 'Sent to'), null, 'and no "Sent to" line (it is him)');
    await david.page.click('.modal [data-notice-seen]');
    ok(await toastText(david.page, /Marked as seen/), 'Mark as seen marks it seen');
  } else fail('David\'s timeline has no notice link');
  await david.ctx.close();

  // ------------------------------------------------------------------ M4: discharging from off the care team
  const jw2 = await session('jwalker');
  const eps = (await jw2.api('GET', `/api/clients/${cid}/episodes`)).data.episodes;
  for (const e of eps.filter(x => x.status === 'open')) eq((await jw2.api('POST', `/api/episodes/${e.id}/close`, { discharge_reason: 'completed', keep_client_active: true })).status, 200, 'a supervisor closes the intake episode, keeping the client active with David');
  await jw2.ctx.close();
  const kp = await session('kpatel');
  eq((await kp.api('POST', `/api/clients/${cid}/episodes`, { opened_at: new Date().toISOString().slice(0, 10) })).status, 201, 'Dr. Patel, not on the care team, starts an episode');
  await kp.go(`client/${cid}/episodes`);
  await kp.page.click('.main button:text-is("Discharge")');
  const own = await until(() => kp.page.$('.modal [data-discharge-own-part]'));
  const ownText = own ? await own.textContent() : '';
  ok(/not on this client's care team/.test(ownText) && /ends only your own part/.test(ownText) && /stays open with David Chen/.test(ownText), 'before submit: only your own part ends, and the client stays open with David Chen', ownText);
  ok(!/This ends the assignments on this client/.test(await kp.page.textContent('.modal')), 'not "this ends the assignments on this client"');
  await axe(kp.page, 'the discharge form, off the care team');
  const reason = await kp.page.$eval('.modal select[name=discharge_reason]', s => [...s.options].find(o => o.value)?.value);
  await kp.page.selectOption('.modal select[name=discharge_reason]', reason);
  await kp.page.click('.modal button[type=submit]');
  const after = await until(async () => { const t = await kp.page.$('.modal h2'); const x = t && await t.textContent(); return x === 'Episode closed — client stays open' ? x : null; });
  eq(after, 'Episode closed — client stays open', 'after submit: "Episode closed — client stays open"');
  if (after) {
    ok(/David Chen is still on this client's care team/.test(await kp.page.textContent('.modal')), 'naming who is still on the care team');
    eq(await kp.page.$$eval('.modal .btn-row button', bs => bs.map(b => b.textContent).join(',')), 'OK', 'with one button, OK');
    await axe(kp.page, 'the episode-closed dialog');
    await kp.page.click('.modal .btn-row button');
  }
  const toast = await kp.page.$$eval('#toasts .toast', ts => ts.map(x => x.textContent).join(' | '));
  ok(/Episode closed/.test(toast) && !/0 assignment|assignment\(s\)|Discharged/.test(toast), 'the toast says the episode closed, with no "0 assignment(s) ended"', toast);
  eq((await kp.api('GET', `/api/clients/${cid}`)).data.client.status, 'active', 'and the client is still active');

  // ------------------------------------------------------------------ L3: a cancelled signature
  await kp.go(`client/${cid}`);
  await kp.page.evaluate(async (cid) => (await import('/views/notes.js')).openNoteForm(null, { clientId: cid }), cid);
  await kp.page.waitForSelector('.modal textarea[name=content]');
  await kp.page.fill('.modal textarea[name=content]', `Check-in ${tag}`);
  await kp.page.click('.modal [data-save-sign]');
  ok(await until(() => kp.page.$('.modal [data-signature-dialog]')), 'Save & sign opens the signature');
  await kp.page.keyboard.press('Escape');
  ok(await toastText(kp.page, /Not signed: the note is saved as a draft/), 'cancelling it says the note is saved as a draft');
  await closeModals(kp.page);
  await kp.ctx.close();

  // ------------------------------------------------------------------ L4: Reports at 1280 px
  const sup = await session('jwalker');
  await sup.go('reports');
  const wraps = await until(async () => {
    const w = await sup.page.$$eval('.main .table-wrap', ws => ws.map(w => ({ head: w.closest('.card')?.querySelector('h2')?.textContent || '', wide: w.scrollWidth > w.clientWidth + 1, hint: !!(w.previousElementSibling && w.previousElementSibling.hasAttribute('data-scroll-hint')) })));
    return w.length && w.every(x => !x.wide || x.hint) ? w : null;
  });
  ok(wraps, 'L4: every Reports table fits its card at 1280 px, or says to scroll sideways', JSON.stringify(wraps));
  const trend = (wraps || []).find(x => /Monthly trend/.test(x.head));
  ok(trend, 'the Monthly trend table is among them');
  await axe(sup.page, 'Reports at 1280 px');
  await sup.ctx.close();

  // ------------------------------------------------------------------ L5: Notes on a phone
  const mp = await session('mrivera', PW, ...PHONE);
  await mp.go('notes');
  const g = await mp.page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const row = [...document.querySelectorAll('.main .compact-list .compact-row')].find(r => r.offsetParent);
    const note = document.querySelector('.main .banner.phone-line');
    return { more: vis(document.querySelector('.main [data-notes-more] summary')), wideImport: vis(document.querySelector('.main .topbar a.wide-only[href="#/imports"]')),
      top: row ? row.getBoundingClientRect().top + scrollY : 9999, note: note ? note.getBoundingClientRect().height : 0 };
  });
  ok(g.more && !g.wideImport, 'L5: on a phone Import is under More, not a full-width button', JSON.stringify(g));
  ok(g.note > 0 && g.note < 60, 'the counseling-notes line is one short line', JSON.stringify(g));
  ok(g.top < 470, 'and the first note starts higher up the screen (it was at 532 px)', JSON.stringify(g));
  await mp.page.click('.main [data-notes-more] summary');
  ok(await mp.page.isVisible('.main [data-notes-more] a[href="#/imports"]'), 'More opens Import');
  await axe(mp.page, 'Notes on a phone with More open');
  await mp.ctx.close();

  // ------------------------------------------------------------------ L6: Home for a worker with past visits
  const mr = await session('mrivera', PW, undefined, {}, { tour_done: false, first_day: null, first_day_skip: null });
  await mr.go('dashboard');
  ok(await mr.page.$('[data-welcome]'), 'the welcome card is on Home');
  ok(!(await mr.page.$('[data-first-day]')), 'L6: but not "Your first day" for a navigator with visits from before today');
  eq((await mr.api('GET', '/api/me/prefs')).data.prefs.first_day_skip, true, 'and that is remembered');
  await mr.ctx.close();

  // ------------------------------------------------------------------ L7: Finance's Supervision
  const fin = await session('afinance');
  await fin.go('supervision');
  const intro = await fin.page.evaluate(() => ({ lead: [...document.querySelectorAll('.main p.muted')].map(p => p.textContent)[0] || '', help: document.querySelector('.main .topbar .helptip')?.textContent || '' }));
  ok(/Staff time submitted for approval/.test(intro.lead) && !/anything else your role reviews/.test(intro.lead), 'L7: Finance\'s Supervision page says it is staff time to approve', intro.lead);
  ok(/Staff time/.test(intro.help) && !/countersignature|referrals/.test(intro.help), 'and so does its ? help', intro.help);
  await fin.ctx.close();

  // ------------------------------------------------------------------ M3: 2-step set up on a phone
  const dp = await session('dchen', PW, ...PHONE);
  ok(await dp.page.$('[data-banner="mfa-required"], [data-mfa-link]'), 'David is reminded that 2-step verification is due');
  await dp.go('profile?mfa=1');
  await until(() => dp.page.$('.modal .qr'));
  eq(await dp.page.textContent('.modal h2'), 'Set up 2-step verification', 'M3: the set-up dialog says "Set up 2-step verification"');
  eq((await dp.page.textContent('.modal button[type=submit]')).trim(), 'Turn on 2-step', 'and its button "Turn on 2-step"');
  ok(!/MFA/.test(await dp.page.textContent('.modal')), 'with no "MFA" in it');
  await axe(dp.page, 'the 2-step set-up dialog on a phone');
  const secret = (await dp.page.textContent('.modal .qr')).replace(/\s+/g, '');
  await dp.page.fill('.modal input[name=code]', totp(secret));
  await dp.page.click('.modal button[type=submit]');
  ok(await toastText(dp.page, /2-step verification is on/), 'the toast says "2-step verification is on"');
  ok(await until(async () => !(await dp.page.$('[data-banner="mfa-required"], [data-mfa-link]'))), 'and the 2-step reminder is gone at once, without a reload');
  await dp.go('clients');
  ok(!(await dp.page.$('[data-banner="mfa-required"], [data-mfa-link]')), 'and stays gone on the next page');
  await dp.go('profile');
  ok(/2-step verification is on/.test(await dp.page.textContent('.main')), 'My profile says 2-step verification is on');
  await dp.ctx.close();

  // ------------------------------------------------------------------ 1.25.2, FL1: a wrong code at sign-in
  {
    const ctx = await browser.newContext({ viewport: PHONE[0], ...PHONE[1] }); const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`dchen-mfa PAGEERROR ${e.message}`));
    // FL12: nothing that needs a session is asked for before there is one (the refused code itself is the one 401).
    const refused = []; page.on('response', r => { if (r.status() === 401 && !/\/api\/auth\/mfa\/verify/.test(r.url())) refused.push(new URL(r.url()).pathname); });
    await page.goto(base + '/#/login'); await settle(page);
    eq(refused.join(', '), '', 'FL12: the sign-in page loads with no 401');
    await page.fill('input[name=username]', 'dchen'); await page.fill('input[name=password]', PW); await page.click('button[type=submit]');
    ok(await until(() => page.$('input[name=code]'), { timeout: 15000 }), 'signing in with 2-step on asks for the code');
    await page.fill('input[name=code]', '000000'); await page.click('button[type=submit]'); await settle(page);
    const said = await until(async () => { const t = await page.textContent('#app'); return /Invalid verification code/.test(t) ? t : null; }, { timeout: 5000 });
    ok(said, 'FL1: a wrong code says "Invalid verification code"');
    ok(/#\/mfa/.test(page.url()) && await page.$('input[name=code]'), 'and stays on the code screen, not back to the password', page.url());
    ok(!(await toastText(page, /Session expired/).catch(() => null)), 'with no "Session expired" toast');
    await page.fill('input[name=code]', totp(secret, Date.now() + 30000)); await page.click('button[type=submit]');
    ok(await page.waitForSelector('.layout', { timeout: 15000 }).then(() => true, () => false), 'the right code then finishes the same sign-in');
    eq(refused.join(', '), '', 'FL12: and nothing was asked for while the second step was owed');
    await ctx.close();
  }
} catch (e) {
  fail(`crashed: ${e.stack || e.message}`);
}
await browser.close();
eq(errors.length, 0, `no page errors, console errors or 5xx${errors.length ? ': ' + errors.join(' / ') : ''}`);
finish();

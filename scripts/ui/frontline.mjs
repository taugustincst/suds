// Front-line friction, checked in a real browser: "Save & sign" from the note editor, signing with a
// confirmation soon after signing in (and the password once the window has passed), the supervision queue
// with client names, rows that open the note or referral from the keyboard, countersigning several notes
// in one step, the referral form choosing the one consent that names the provider, and the warning for a
// consent that is already on file. And (1.14.0, the third UX review) anonymous outreach counted on Home and Reports as
// in the funder report, overdose doses said as stored, "+ Log → Overdose or reversal", the supply cupboard step
// and the visit that says its kits were not taken off, "Select all" when countersigning, per-role Home
// headings, and a forced password change that asks the server for nothing it will refuse.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, finish } = makeChecks('frontline');
const errors = [];
const PW = 'Navigator2026!!';

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
  return { page, ctx, api, close: () => ctx.close() };
}
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await settle(page); };
const closeModals = async (page) => { for (let i = 0; i < 4 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await settle(page); } };
const ELEMENTS = { signed_at: new Date().toISOString().slice(0, 10), scope: 'Referral summary', expires_at: '2099-01-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };

const admin = await session('admin', 'AdminPassw0rd!x');
const users = (await admin.api('GET', '/api/users')).data.users;
const navUser = users.find(u => u.username === 'mrivera'), supUser = users.find(u => u.username === 'jwalker');
eq((await admin.api('PUT', `/api/users/${navUser.id}`, { requires_cosign: 1, supervisor_id: supUser.id })).status, 200, 'the navigator\'s notes need countersignature');

const nav = await session('mrivera', PW);
const client = (await nav.api('GET', '/api/clients?limit=1')).data.clients[0];
const clientName = (await nav.api('GET', `/api/clients/${client.id}`)).data.client.display_name;

// ---- 1. Save & sign, straight from the editor ----
{
  const { page, api } = nav;
  await go(page, 'notes');
  await page.evaluate(async (id) => (await import('./views/notes.js')).openNoteForm(null, { clientId: id, clientDisplay: 'the client' }), client.id);
  await page.waitForSelector('.modal textarea[name=content]');
  ok(await page.$('.modal button[data-save-sign]'), 'the note editor has "Save & sign" beside "Save draft"');
  await page.fill('.modal input[name=title]', 'Frontline save and sign');
  await page.fill('.modal textarea[name=content]', 'Walked with the client to the pharmacy; naloxone kit given.');
  await page.click('.modal button[data-save-sign]');
  const dlg = await until(() => page.$('.modal [data-signature-dialog]'));
  ok(dlg, '"Save & sign" saves and opens the signature step at once');
  eq(dlg && await dlg.getAttribute('data-signature-dialog'), 'confirm', 'just after signing in, it is a confirmation — no password');
  ok(/attest that this documentation is accurate and complete/.test(await page.textContent('.modal [data-signature-dialog]')), 'the attestation is still shown');
  ok(!(await page.$('.modal input[name=password]')), 'and there is no password field');
  await page.click('.modal [data-signature-dialog] button[type=submit]');
  await until(async () => !(await page.$('.modal-bg')));
  const notes = (await api('GET', `/api/notes?client_id=${client.id}&mine=1`)).data.rows;
  const signed = notes.find(n => n.title === 'Frontline save and sign');
  eq(signed && signed.status, 'signed', 'two clicks from the editor: the note is signed and locked');
  ok(!(await page.$('.modal-bg')), 'and the editor has closed');
}

// ---- 2. once the window has passed, the password again ----
{
  const { page, api } = nav;
  eq((await admin.api('PUT', '/api/admin/settings', { sign_reauth_minutes: 0 })).status, 200, 'the programme sets the window to 0 (always ask)');
  const d = await api('POST', '/api/notes', { client_id: client.id, kind: 'admin', title: 'Frontline stale', content: 'Phone check-in.', occurred_at: new Date().toISOString() });
  await go(page, `notes/${d.data.id}`);
  await page.click('.modal button:has-text("Sign & lock")');
  const dlg = await until(() => page.$('.modal [data-signature-dialog]'));
  eq(dlg && await dlg.getAttribute('data-signature-dialog'), 'password', 'the signature step asks for the password');
  eq(await page.evaluate(() => document.activeElement && document.activeElement.name), 'password', 'with the cursor in the password field');
  await page.fill('.modal input[name=password]', PW); await page.keyboard.press('Enter');
  await until(async () => (await api('GET', `/api/notes/${d.data.id}`)).data.note.status === 'signed');
  eq((await api('GET', `/api/notes/${d.data.id}`)).data.note.status, 'signed', 'and signs with it');
  eq((await admin.api('PUT', '/api/admin/settings', { sign_reauth_minutes: null })).status, 200, 'back to the default window');
  await closeModals(page);
}

// ---- 3. the referral form picks the one consent that names the provider ----
let consentId;
{
  const { page, api } = nav;
  const res = await api('POST', '/api/resources', { name: 'Frontline Harbor Clinic', category: 'mat_otp' });
  eq(res.status, 201, 'a provider');
  const c = await api('POST', `/api/clients/${client.id}/consents`, { type: 'part2_disclosure', recipient: 'Frontline Harbor Clinic', purpose: 'Referral', ...ELEMENTS });
  eq(c.status, 201, 'and a consent that names it'); consentId = c.data.id;
  await api('POST', `/api/clients/${client.id}/consents`, { type: 'part2_disclosure', recipient: 'Somewhere Else Entirely', purpose: 'Referral', ...ELEMENTS });
  await go(page, 'referrals');
  await page.evaluate(async ({ id, rid }) => (await import('./views/referrals.js')).openReferralForm(null, { clientId: id, clientDisplay: 'the client', resourceId: rid }), { id: client.id, rid: res.data.id });
  await page.waitForSelector('.modal select[name=consent_id]');
  await until(async () => (await page.inputValue('.modal select[name=consent_id]')) === consentId);
  eq(await page.inputValue('.modal select[name=consent_id]'), consentId, 'the consent naming this provider is chosen for the worker');
  ok(/This referral will rely on:.*Frontline Harbor Clinic/.test(await page.textContent('.modal [data-consent-used]')), 'and the form says which consent will be used');
  await page.selectOption('.modal select[name=consent_id]', '');
  ok(/No consent chosen/.test(await page.textContent('.modal [data-consent-used]')), 'clearing it says no consent is chosen');
  await closeModals(page);

  // A consent that names the provider but was given for another purpose (pen test of 1.23.6, M1): it is not
  // chosen for the worker, "Record a consent naming …" is offered, and relying on it says why it cannot be used.
  const billing = await api('POST', '/api/resources', { name: 'Frontline Billing Clinic', category: 'mat_otp' });
  eq(billing.status, 201, 'a second provider');
  const bc = await api('POST', `/api/clients/${client.id}/consents`, { type: 'part2_disclosure', recipient: 'Frontline Billing Clinic', purpose: 'Billing and payment processing only', ...ELEMENTS });
  eq(bc.status, 201, 'with a consent naming it, for billing only');
  await page.evaluate(async ({ id, rid }) => (await import('./views/referrals.js')).openReferralForm(null, { clientId: id, clientDisplay: 'the client', resourceId: rid }), { id: client.id, rid: billing.data.id });
  await page.waitForSelector('.modal select[name=consent_id]');
  await settle(page);
  eq(await page.inputValue('.modal select[name=consent_id]'), '', 'the billing-only consent is not chosen for the worker');
  ok(await page.$('.modal [data-record-consent-naming]'), '"Record a consent naming …" is offered instead');
  const why = await page.textContent('.modal [data-no-consent-names]').catch(() => '');
  ok(/The consent naming Frontline Billing Clinic states its purpose as “Billing and payment processing only”, which does not cover this referral/.test(why) && /ask a supervisor to override/.test(why), 'the help says the consent names the provider but for another purpose, and what to do', why);
  ok(!/None of the consents on file names/.test(why), 'not that no consent names it', why);
  await page.selectOption('.modal select[name=consent_id]', bc.data.id);
  await page.check('.modal input[name=warm_handoff]');
  await page.click('.modal button[type=submit]');
  const refusal = await until(async () => { const t = await page.textContent('.modal .banner.danger').catch(() => ''); return /was given for/.test(t || '') ? t : null; });
  ok(refusal && /Billing and payment processing only/.test(refusal), 'saving says what the consent was given for');
  ok(refusal && /does not cover this disclosure's purpose/.test(refusal) && /record a new one/.test(refusal), 'that it does not cover a referral, and what to do');
  eq((await api('GET', `/api/referrals?client_id=${client.id}&resource_id=${billing.data.id}`)).data.rows.length, 0, 'and nothing was saved');
  await closeModals(page);
}

// ---- 4. a consent already on file ----
{
  const { page, api } = nav;
  const before = (await api('GET', `/api/clients/${client.id}/consents`)).data.consents.length;
  const fillDuplicate = async () => {
    await page.evaluate(async (id) => (await import('./views/part2.js')).openConsentForm(id, {}), client.id);
    await page.waitForSelector('.modal select[name=type]');
    await page.selectOption('.modal select[name=type]', 'part2_disclosure');
    await page.fill('.modal input[name=recipient]', 'frontline harbor clinic');
    await page.fill('.modal input[name=purpose]', 'Referral');
    // 1.14.0: what the consent covers is its ticks (written into its scope), not a second free-text answer.
    await page.check('.modal input[name=cat_referrals]');
    await page.fill('.modal input[name=expires_at]', '2027-01-01');
    for (const n of ['signed_on_paper', 'revocation_right_given', 'redisclosure_notice_given', 'refusal_consequences_given']) await page.check(`.modal input[name=${n}]`);
    await page.click('.modal button[type=submit]:has-text("Record consent")');
    return until(() => page.$('.modal [data-consent-duplicate]'));
  };
  const warn = await fillDuplicate();
  ok(warn, 'recording the same consent again warns that it is already on file');
  eq(warn && await warn.getAttribute('data-consent-duplicate'), consentId, 'naming the existing one');
  await page.click('.modal [data-open-existing]');
  const detail = await until(() => page.$('.modal [data-consent-detail]'));
  ok(detail, '"Open the existing consent" shows it');
  ok(detail && /Frontline Harbor Clinic/.test(await detail.textContent()), 'with its recipient');
  eq((await api('GET', `/api/clients/${client.id}/consents`)).data.consents.length, before, 'and nothing new was recorded');
  await closeModals(page);
  ok(await fillDuplicate(), 'warned again');
  await page.click('.modal [data-record-anyway]');
  await until(async () => (await api('GET', `/api/clients/${client.id}/consents`)).data.consents.length === before + 1);
  eq((await api('GET', `/api/clients/${client.id}/consents`)).data.consents.length, before + 1, '"Record it anyway" records it: a warning, not a block');
  await closeModals(page);

  // The programme's usual consent fills the form in one step.
  eq((await admin.api('PUT', '/api/consent-template', { type: 'part2_disclosure', recipient: 'Frontline Harbor Clinic', purpose: 'Referral for treatment', scope: 'Referral summary', expires_days: 365, info_categories: ['demographics', 'referrals'] })).status, 200, 'the programme saves its usual consent');
  await page.evaluate(async (id) => (await import('./views/part2.js')).openConsentForm(id, {}), client.id);
  const use = await until(() => page.$('.modal [data-use-template]'));
  ok(use, 'the consent form offers "Fill in the programme\'s usual consent"');
  ok(!(await page.$('.modal [data-save-template]')), 'a navigator cannot overwrite it');
  if (use) await use.click();
  eq(await page.inputValue('.modal select[name=type]'), 'part2_disclosure', 'it sets the type');
  eq(await page.inputValue('.modal input[name=recipient]'), 'Frontline Harbor Clinic', 'the recipient');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(await page.inputValue('.modal input[name=expires_at]')), 'an expiry a year from signing');
  ok(await page.isChecked('.modal input[name=cat_referrals]') && !(await page.isChecked('.modal input[name=cat_all]')), 'and the information categories');
  await closeModals(page);
}

// ---- 5. the supervision queue: names, rows that open, several countersignatures at once ----
const ids = [];
for (let i = 1; i <= 2; i++) {
  const d = await nav.api('POST', '/api/notes', { client_id: client.id, kind: 'admin', title: `Frontline batch ${i}`, content: `Batch note ${i}: met at the library.`, occurred_at: new Date().toISOString() });
  eq((await nav.api('POST', `/api/notes/${d.data.id}/sign`, { confirm: true })).status, 200, `note ${i} signed with a confirmation`);
  ids.push(d.data.id);
}
const refRes = (await nav.api('GET', '/api/resources?limit=1000')).data.rows.find(r => r.name === 'Frontline Harbor Clinic');
const scheduled = await nav.api('POST', '/api/referrals', { client_id: client.id, resource_id: refRes.id, referred_at: new Date().toISOString(), status: 'scheduled', consent_id: consentId });
const completed = await nav.api('POST', '/api/referrals', { client_id: client.id, resource_id: refRes.id, referred_at: new Date().toISOString(), status: 'completed', consent_id: consentId });
eq([scheduled.status, completed.status].join(), '201,201', 'a scheduled and a completed referral');
await nav.close();
{
  const sup = await session('jwalker', PW);
  const { page, api } = sup;
  await go(page, 'supervision');
  const cos = await page.$('[data-section=cosign]');
  ok(cos && (await cos.textContent()).includes(clientName), 'the countersignature queue names the client, not just the code', clientName);
  // A row opens the note, from the keyboard.
  await page.focus('[data-section=cosign] tbody tr.click .row-open');
  await page.keyboard.press('Enter');
  ok(await until(() => page.$('.modal .kv')), 'Enter on a queue row opens that note');
  await closeModals(page);
  // Several at once. "Select all" (1.14.0) ticks every note in the queue, and clears them again.
  const rowsInQueue = (await page.$$('[data-cosign-pick]')).length;
  const all = await page.$('[data-cosign-select-all]');
  ok(all, 'the queue has a "Select all" checkbox');
  ok(all && await all.evaluate(el => !!(el.labels && el.labels[0] && /Select all \d+ notes/.test(el.labels[0].textContent))), 'with a visible label');
  if (all) {
    await all.check();
    eq(await page.getAttribute('[data-cosign-picked]', 'data-cosign-picked'), String(rowsInQueue), 'it selects every note in the queue');
    eq((await page.$$('[data-cosign-pick]:checked')).length, rowsInQueue, 'and ticks each box');
    await all.uncheck();
    eq(await page.getAttribute('[data-cosign-picked]', 'data-cosign-picked'), '0', 'and clears them again');
  }
  for (const id of ids) await page.check(`[data-cosign-pick="${id}"]`);
  if (rowsInQueue > 2) ok(await page.$eval('[data-cosign-select-all]', el => el.indeterminate), 'with only some ticked, "Select all" shows as partly ticked');
  eq(await page.getAttribute('[data-cosign-picked]', 'data-cosign-picked'), '2', 'two notes selected');
  await page.click('[data-cosign-selected]');
  const list = await until(() => page.$('.modal [data-cosign-list]'));
  eq(list && await list.getAttribute('data-cosign-list'), '2', 'one dialog lists both notes');
  const text = list ? await list.textContent() : '';
  ok(/Batch note 1/.test(text) && /Batch note 2/.test(text), 'with each note\'s text to read before signing');
  eq(await page.getAttribute('.modal [data-signature-dialog]', 'data-signature-dialog'), 'confirm', 'one confirmation, no password just after signing in');
  // Each note has its own comment field under it; there is no one comment copied onto every note.
  ok(!(await page.$('.modal textarea[name=note]')), 'no shared "comment for every note" field in a batch');
  eq((await page.$$('.modal [data-cosign-comment]')).length, 2, 'one comment field per note');
  for (const id of ids) {
    const lbl = await page.evaluate((id) => { const t = document.querySelector(`.modal [data-cosign-comment="${id}"]`); return t && t.labels && t.labels[0] ? t.labels[0].textContent : ''; }, id);
    ok(/^Comment on note \d \(optional\)$/.test(lbl), 'each comment field has its own visible label', lbl);
    ok(await page.$(`.modal [data-cosign-content="${id}"] [data-cosign-comment="${id}"]`), 'and sits inside that note\'s section');
  }
  await page.fill(`.modal [data-cosign-comment="${ids[0]}"]`, 'Reviewed in supervision');
  await page.click('.modal [data-signature-dialog] button[type=submit]');
  await until(async () => !(await page.$('.modal-bg')));
  const after = await Promise.all(ids.map(id => api('GET', `/api/notes/${id}`)));
  ok(after.every(r => r.data.note.cosigned), 'both notes are countersigned', after.map(r => r.data.note.cosigned));
  eq(after[0].data.note.cosign_note, 'Reviewed in supervision', 'the first note keeps its comment');
  ok(!after[1].data.note.cosign_note, 'the second note does not get a copy of it', after[1].data.note.cosign_note);
  // Referrals: the completed one is not "waiting for an outcome"; the scheduled one opens its outcome form.
  await go(page, 'supervision');
  const waiting = await page.$('[data-awaiting-outcome]');
  const q = (await api('GET', '/api/supervision/queue')).data.referrals_awaiting_outcome.map(r => r.id);
  ok(q.includes(scheduled.data.id) && !q.includes(completed.data.id), '"No outcome recorded yet" has the scheduled referral and not the completed one');
  ok(waiting, 'the list is on the page');
  const row = waiting && await waiting.$(`tbody tr.click .row-open:has-text("${clientName}")`);
  ok(row, 'its row names the client');
  if (row) { await row.focus(); await page.keyboard.press('Enter'); ok(await until(() => page.$('.modal select[name=status]')), 'Enter on the referral row opens its outcome form'); await closeModals(page); }
  await sup.close();
}

// ---- 6. a safety flag stored as a code shows its label in the client header, not "no_home_visits" ----
{
  const { page, api } = admin;
  const before = (await api('GET', `/api/clients/${client.id}`)).data.client.flags || null;
  ok((await api('PUT', `/api/clients/${client.id}`, { flags: 'no_home_visits, allergy: naltrexone' })).status < 300, 'a client with a coded flag and a typed one');
  await go(page, `client/${client.id}`);
  const badgeText = await until(() => page.$eval('[data-client-flags]', el => el.textContent).catch(() => null));
  ok(badgeText && badgeText.includes('No home visits alone') && badgeText.includes('allergy: naltrexone'), 'the header shows the label from the Safety flags list and the typed flag as typed', badgeText);
  ok(badgeText && !/no_home_visits/.test(badgeText), 'never the raw code', badgeText);
  await api('PUT', `/api/clients/${client.id}`, { flags: before || '' });
}

// ---- 7. the third UX review (1.14.0) ----
const statValue = (page, label) => page.evaluate((l) => { const s = [...document.querySelectorAll('.main .stat')].find(x => x.querySelector('.l')?.textContent.trim() === l); return s ? Number(s.querySelector('.v').textContent.replace(/[^\d]/g, '')) : null; }, label);
const pageText = (page) => page.evaluate(() => (document.querySelector('.main')?.innerText || '').replace(/\s+/g, ' '));
const cupboard = (await admin.api('GET', '/api/supplies')).data.rows;
for (const x of cupboard) await admin.api('DELETE', `/api/supplies/${x.id}`);
eq((await admin.api('GET', '/api/supplies')).data.rows.length, 0, 'the supply cupboard is empty (a new program)');
{
  const phone = await session('mrivera', PW, { width: 390, height: 844 });
  const { page, api } = phone;
  // What the overdose list says of each event's naloxone, counted before and after (rows recorded in the same
  // minute sort in either order).
  const rowsSaying = async (re) => { await go(page, 'overdose'); return page.$$eval('.main table tbody tr', (trs, src) => trs.filter(tr => new RegExp(src).test(tr.innerText)).length, re.source); };
  const notRecordedBefore = await rowsSaying(/given, doses not recorded/); const twoBefore = await rowsSaying(/\b2 doses\b/);
  const newest = async () => (await api('GET', '/api/overdose-events?limit=200')).data.rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  // + Log offers an overdose or reversal; it opens the overdose form, charged to the default fund.
  await go(page, 'dashboard');
  const fab = await page.$('.fab button');
  if (fab && await fab.isVisible()) await fab.click(); else await page.click('.appbar .quick');
  await page.waitForSelector('.modal .quick-list');
  const quick = await page.$$eval('.modal .quick-list button', b => b.map(x => x.textContent.trim()));
  ok(quick.some(t => /Overdose or reversal/.test(t)), '+ Log offers "Overdose or reversal"', quick);
  await page.click('.modal .quick-list button:has-text("Overdose or reversal")');
  ok(await until(() => page.$('.modal select[name=kind]')), 'which opens the overdose form');
  const fund = (await api('GET', '/api/auth/me')).data.default_fund_id;
  if (fund && await page.$('.modal select[name=funding_source_id]')) eq(await page.inputValue('.modal select[name=funding_source_id]'), fund, 'charged to the default fund, as a visit is');
  // Doses left empty: stored as 0, and said as "doses not recorded" (the list said "1 dose", the reports 0).
  await page.selectOption('.modal select[name=kind]', 'reversal');
  eq(await page.inputValue('.modal input[name=naloxone_doses]'), '', 'Doses given is left empty');
  await page.click('.modal button[type=submit]');
  const t1 = await until(() => page.$('#toasts .toast:has-text("Event recorded")'), { timeout: 5000 });
  ok(t1 && /naloxone given \(doses not recorded\)/.test(await t1.textContent()), 'the toast mentions the naloxone and that no doses were recorded', t1 && await t1.textContent());
  await until(async () => !(await page.$('.modal-bg')));
  const ev1 = await newest();
  eq(ev1 && ev1.naloxone_doses, 0, 'stored as 0 doses');
  eq(await rowsSaying(/given, doses not recorded/), notRecordedBefore + 1, 'the list says "given, doses not recorded" (not "1 dose")');
  await page.click('.main button:has-text("+ Record an event")'); await page.waitForSelector('.modal select[name=kind]');
  await page.selectOption('.modal select[name=kind]', 'reversal'); await page.fill('.modal input[name=naloxone_doses]', '2');
  await page.click('.modal button[type=submit]');
  const t2 = await until(() => page.$('#toasts .toast:has-text("2 doses")'), { timeout: 5000 });
  ok(t2, 'with doses given, the toast says how many', t2 && await t2.textContent());
  await until(async () => !(await page.$('.modal-bg')));
  eq((await newest()).naloxone_doses, 2, 'stored as 2');
  eq(await rowsSaying(/\b2 doses\b/), twoBefore + 1, 'and the list shows what was stored');
  // Supplies: the cupboard is empty, so Supplies offers the two standard items, and a visit handing out kits says
  // they were not taken off.
  await go(page, 'supplies');
  ok(await page.$('[data-supplies-missing]'), 'Supplies says visits take kits off only once the items exist');
  // Adding items is for supervisors and administrators (supplies:manage, 1.14.0): a navigator is told so; the
  // administrator's one click is checked below.
  ok(!(await page.$('[data-add-standard-supplies]')) && /A supervisor or administrator adds items/.test(await page.textContent('[data-supplies-missing]')), 'and says who adds them');
  await go(page, 'interventions');
  await page.evaluate(async () => (await import('./views/interventions.js')).openInterventionForm(null, {}));
  await page.waitForSelector('.modal select[name=type]');
  await page.selectOption('.modal select[name=type]', 'naloxone_distribution');
  // 1.14.0: said inside the visit form before it is saved, with who can add the items; the toast stays as a fallback.
  const inForm = await page.$('.modal [data-supplies-missing]');
  ok(inForm && /not taken off any stock/.test(await inForm.textContent()) && /Ask a supervisor or administrator/.test(await inForm.textContent()), 'the visit form says, before saving, that kits will not come off any stock', inForm && await inForm.textContent());
  await page.fill('.modal input[name=naloxone_kits]', '10');
  await page.click('.modal button[type=submit]');
  const t3 = await until(() => page.$('#toasts .toast:has-text("not taken off Supplies")'), { timeout: 5000 });
  ok(t3 && /10 × Naloxone kit/.test(await t3.textContent()), 'an anonymous distribution of 10 kits with no supply item says the kits were not taken off', t3 && await t3.textContent());
  await until(async () => !(await page.$('.modal-bg')));
  await go(page, 'dashboard');
  // 1.16.0: a navigator holds clients:all, so Home's activity card counts the program's visits and says so
  // (was: "What you have been doing", their caseload's); their to-dos on Home are still their own.
  eq(await page.textContent('[data-activity-heading]'), 'What the team has been doing (90 days)', 'a navigator\'s Home activity card says whose visits it counts');
  await phone.close();
}
{
  // Home and Reports count that anonymous distribution: the supervisor's figures are the funder report's.
  const sup = await session('jwalker', PW);
  const { page, api } = sup;
  const d = (await api('GET', '/api/reports/dashboard')).data;
  const f = (await api('GET', `/api/reports/funder?from=${d.from}&to=${d.to}&purpose=submission&counts=exact`)).data;
  await go(page, 'dashboard');
  const homeKits = await statValue(page, 'Naloxone kits given');
  eq(homeKits, f.naloxone_distribution.kits, 'Home\'s "Naloxone kits given" is the funder report\'s kits for the same 90 days, anonymous distribution included');
  ok(f.naloxone_distribution.community_kits >= 10, 'which has the anonymous kits in it', f.naloxone_distribution);
  eq(await statValue(page, 'Visits (90 days)'), f.by_funding_source.reduce((s, x) => s + x.services, 0), 'Home\'s visits are the funder report\'s services');
  eq(await page.textContent('[data-activity-heading]'), 'What the team has been doing (90 days)', 'a supervisor\'s activity card is the team\'s');
  await go(page, `reports?from=${d.from}&to=${d.to}`);
  eq(await statValue(page, 'Naloxone kits'), f.naloxone_distribution.kits, 'Reports\' naloxone kits agree too');
  eq(await statValue(page, 'Fentanyl strips'), f.naloxone_distribution.strips, 'and the test strips');
  eq(await statValue(page, 'Visits'), f.by_funding_source.reduce((s, x) => s + x.services, 0), 'and the visits');
  await sup.close();
}
{
  const fin = await session('afinance', PW);
  await go(fin.page, 'dashboard');
  eq(await fin.page.textContent('[data-activity-heading]'), 'The program\'s visits (90 days)', 'finance\'s Home is not headed "What you have been doing"');
  await fin.close();
}
{
  // The Home checklist: "Add your supplies" while the cupboard is empty, done in one click.
  const { page, api } = admin;
  await go(page, 'dashboard');
  ok(/Add your supplies/.test(await pageText(page)), 'Home asks an administrator to add the supplies');
  await page.click('.main button:has-text("Add naloxone kits and test strips")');
  await until(() => /#\/supplies/.test(page.url())); await settle(page);
  const rows = (await api('GET', '/api/supplies')).data.rows.map(x => x.item).sort();
  eq(rows.join('|'), 'Fentanyl test strips|Naloxone kit', 'one click adds the two standard items');
  ok(!(await page.$('[data-supplies-missing]')), 'and Supplies no longer says they are missing');
  await go(page, 'dashboard');
  ok(!/Add your supplies/.test(await pageText(page)), 'the step is done');
  for (const x of cupboard) await api('POST', '/api/supplies', { item: x.item, quantity: x.quantity });
  // A forced password change does not fire requests the server will refuse (users, funds, to-dos).
  const temp = 'TempPassw0rd!2026';
  eq((await api('POST', '/api/users', { username: 'uxforced', display_name: 'Forced Change', role: 'navigator', password: temp })).status, 201, 'a new account that must change its password');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage();
  const refused = []; p.on('response', r => { if (r.status() === 403) refused.push(new URL(r.url()).pathname); });
  await p.goto(base + '/#/login'); await p.fill('input[name=username]', 'uxforced'); await p.fill('input[name=password]', temp); await p.click('button[type=submit]');
  ok(await until(() => p.$('input[name=new_password]'), { timeout: 10000 }), 'it lands on the password change');
  await settle(p);
  eq(refused.join(', '), '', 'and nothing it loads is refused (403)');
  await ctx.close();
}

await admin.api('PUT', `/api/users/${navUser.id}`, { requires_cosign: 0 });
await admin.close();
await browser.close();
if (errors.length) { console.log('ERRORS:'); errors.forEach(e => console.log('  ' + e)); } else console.log('NO ERRORS');
finish(errors);

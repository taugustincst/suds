// Front-line friction, checked in a real browser: "Save & sign" from the note editor, signing with a
// confirmation soon after signing in (and the password once the window has passed), the supervision queue
// with client names, rows that open the note or referral from the keyboard, countersigning several notes
// in one step, the referral form choosing the one consent that names the provider, and the warning for a
// consent that is already on file.
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
    await page.fill('.modal textarea[name=scope]', 'Referral summary');
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
  // Several at once.
  for (const id of ids) await page.check(`[data-cosign-pick="${id}"]`);
  eq(await page.getAttribute('[data-cosign-picked]', 'data-cosign-picked'), '2', 'two notes selected');
  await page.click('[data-cosign-selected]');
  const list = await until(() => page.$('.modal [data-cosign-list]'));
  eq(list && await list.getAttribute('data-cosign-list'), '2', 'one dialog lists both notes');
  const text = list ? await list.textContent() : '';
  ok(/Batch note 1/.test(text) && /Batch note 2/.test(text), 'with each note\'s text to read before signing');
  eq(await page.getAttribute('.modal [data-signature-dialog]', 'data-signature-dialog'), 'confirm', 'one confirmation, no password just after signing in');
  await page.fill('.modal textarea[name=note]', 'Reviewed in supervision');
  await page.click('.modal [data-signature-dialog] button[type=submit]');
  await until(async () => !(await page.$('.modal-bg')));
  const after = await Promise.all(ids.map(id => api('GET', `/api/notes/${id}`)));
  ok(after.every(r => r.data.note.cosigned), 'both notes are countersigned', after.map(r => r.data.note.cosigned));
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

await admin.api('PUT', `/api/users/${navUser.id}`, { requires_cosign: 0 });
await admin.close();
await browser.close();
if (errors.length) { console.log('ERRORS:'); errors.forEach(e => console.log('  ' + e)); } else console.log('NO ERRORS');
finish(errors);

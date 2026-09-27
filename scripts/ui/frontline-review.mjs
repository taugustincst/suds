// The second hands-on frontline review (1.12.4), checked in a real browser:
//   1. a referral whose provider no consent names offers "Record a consent naming <provider>", which opens the
//      consent form filled in for it and comes back to the referral with the new consent chosen; the Home
//      checklist offers the program's usual consent naming its referral partners;
//   2. finance and read-only see small counts of people as "<11" on Home and Reports, and no visits by worker;
//   3. the client tabs in their order (Overview first, Consents and Referrals beside it at 1280 px), the
//      referral list's client names and consent wording, "+ Referral";
//   4. the Home checklist's default-fund and settlement-category steps;
//   5. "visit" wording, "Program", proper labels for coded choices, badges that do not break inside a word;
//   6. Location on the street for a harm-reduction program, an overdose "Where" with no Phone, the overdose
//      toast, the client picker that lists nobody until you type and finds either part of a double surname,
//      no "another computer" line on a device copy, and the two-step bar that folds into a header link.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, finish } = makeChecks('frontline-review');
const errors = [];
const PW = 'Navigator2026!!';
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };

async function session(user, pass, viewport = { width: 1280, height: 900 }) {
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
const text = (page, sel = '.main') => page.evaluate((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' '), sel);

const admin = await session('admin', 'AdminPassw0rd!x');
const nav = await session('mrivera', PW);

// A client with a double surname and no consent, and a provider nobody's consent names.
const cl = await nav.api('POST', '/api/clients', { first_name: 'Rosalind', last_name: 'Quintero-Vasquez', status: 'active' });
eq(cl.status, 201, 'a client with a double surname');
const clientId = cl.data.id;
const prov = await nav.api('POST', '/api/resources', { name: 'Hope Street Detox', category: 'detox_withdrawal_mgmt' });
eq(prov.status, 201, 'a provider');

// ---- 1. "Record a consent naming <provider>" from the referral form ----
{
  const { page, api } = nav;
  await go(page, 'referrals');
  ok(await page.$('.main button:text-is("+ Make a referral")'), 'the Referrals page button reads "+ Make a referral" (one verb for the action everywhere, 1.14.0)');
  await page.evaluate(async ({ id, rid }) => (await import('./views/referrals.js')).openReferralForm(null, { clientId: id, clientDisplay: 'Quintero-Vasquez, Rosalind', resourceId: rid }), { id: clientId, rid: prov.data.id });
  const btn = await until(() => page.$('.modal [data-record-consent-naming]'));
  ok(btn, 'with no consent naming the provider, the referral form offers to record one');
  eq(btn && (await btn.textContent()).trim(), 'Record a consent naming Hope Street Detox', 'naming the provider');
  await btn.click();
  await until(() => page.$('.modal h2:has-text("Record a consent naming Hope Street Detox")'));
  eq(await page.inputValue('.modal select[name=type]'), 'part2_disclosure', 'the consent form opens on a Part 2 disclosure consent');
  eq(await page.inputValue('.modal input[name=recipient]'), 'Hope Street Detox', 'to the provider');
  eq(await page.inputValue('.modal input[name=purpose]'), 'Referral and care coordination', 'for referral and care coordination');
  ok(await page.isChecked('.modal input[name=cat_referrals]'), 'covering referrals');
  await page.fill('.modal textarea[name=scope]', 'Name, contact details and presenting need');
  await page.fill('.modal input[name=expires_at]', '2027-09-30');
  for (const n of ['signed_on_paper', 'revocation_right_given', 'redisclosure_notice_given', 'refusal_consequences_given']) await page.check(`.modal input[name=${n}]`);
  await page.click('.modal button[type=submit]:has-text("Record consent")');
  const consents = await until(async () => { const r = (await api('GET', `/api/clients/${clientId}/consents`)).data.consents; return r.length ? r : null; });
  eq(consents && consents.length, 1, 'the consent is recorded');
  await until(async () => (await page.$$('.modal')).length === 1 && (await page.inputValue('.modal select[name=consent_id]').catch(() => '')) === consents[0].id);
  eq((await page.$$('.modal')).length, 1, 'and the worker is back in the referral');
  eq(await page.inputValue('.modal select[name=consent_id]'), consents[0].id, 'with the new consent chosen');
  ok(/This referral will rely on:.*Hope Street Detox/.test(await text(page, '.modal [data-consent-used]')), 'and the form says the referral relies on it');
  ok(!(await page.$('.modal [data-record-consent-naming]')), 'the offer is gone once a consent names the provider');
  await page.selectOption('.modal select[name=status]', 'contacted');
  await page.click('.modal button[type=submit]:has-text("Create referral")');
  await until(async () => !(await page.$('.modal-bg')));
  const refs = (await api('GET', `/api/referrals?client_id=${clientId}&limit=50`)).data.rows;
  eq(refs.length, 1, 'the referral saves as "contacted" under that consent');
  eq(refs[0] && refs[0].consent_id, consents[0].id, 'citing it');
}
// The Home checklist: the program's usual consent, filled in from the directory.
{
  const { page, api } = admin;
  eq((await api('GET', '/api/consent-template')).data.template, null, 'no usual consent is saved yet');
  await go(page, 'dashboard');
  ok(/Save a usual consent naming your referral partners/.test(await text(page)), 'Home asks an administrator to save a usual consent naming the referral partners');
  await page.click('.main button:has-text("Set up the usual consent")');
  await until(() => page.$('.modal [data-consent-template-form]'));
  // 1.14.0: the partners are ticked from the directory, none for you (it used to pre-fill the first six
  // entries, 211 and a crisis line among them, into a recipient too long to save).
  const recipient = await page.inputValue('.modal textarea[name=recipient]');
  ok(!/including /.test(recipient), 'the recipient wording names no partner until one is ticked', recipient.slice(0, 120));
  const partners = await page.$$eval('.modal input[type=checkbox][name^=partner_]', bs => bs.map(b => ({ name: b.name, label: b.closest('label').textContent.trim(), checked: b.checked })));
  ok(partners.length >= 2, 'the directory\'s entries are offered to tick', partners.length);
  ok(partners.every(p => !p.checked), 'nothing is ticked to begin with');
  ok(!partners.some(p => /Crisis Line/.test(p.label)), 'crisis lines are not offered', partners.map(p => p.label));
  eq(await page.inputValue('.modal select[name=type]'), 'part2_tpo', 'on the treatment, payment and operations consent');
  const pick = partners.filter(p => /Hope Street Detox|County Opioid Treatment Program/.test(p.label)).slice(0, 2);
  eq(pick.length, 2, 'two partners to tick');
  for (const p of pick) await page.check(`.modal input[name=${p.name}]`);
  await page.click('.modal button[type=submit]');
  await until(async () => !(await page.$('.modal-bg')));
  ok(!(await page.$('.modal .banner.danger:not(.hidden)')), 'it saves as offered (no "Validation failed")');
  const t = (await api('GET', '/api/consent-template')).data.template;
  ok(t && t.type === 'part2_tpo' && t.expires_days === 365, 'the usual consent is saved', t);
  eq(t && [...t.partners].sort().join('|'), pick.map(p => p.label).sort().join('|'), 'naming the two partners ticked');
  ok(t && pick.every(p => t.recipient.includes(p.label)) && /, including /.test(t.recipient), 'after the consent\'s wording', t && t.recipient);
  // Reopened, the same two are ticked again.
  await page.evaluate(async () => (await import('./views/part2.js')).openConsentTemplateForm({}));
  await until(() => page.$('.modal [data-consent-template-form]'));
  const again = await page.$$eval('.modal input[type=checkbox][name^=partner_]', bs => bs.filter(b => b.checked).map(b => b.closest('label').textContent.trim()));
  eq(again.sort().join('|'), pick.map(p => p.label).sort().join('|'), 'reopened, the partners saved are ticked');
  eq(await page.inputValue('.modal textarea[name=recipient]'), recipient, 'and the wording is the wording, without them');
  // A validation message says what to do in words (the generic path every form uses).
  await page.fill('.modal textarea[name=recipient]', 'x'.repeat(2100));
  await page.click('.modal button[type=submit]');
  const err = await until(() => page.$('.modal .banner.danger:not(.hidden)'));
  const errText = err ? (await err.textContent()) : '';
  ok(/too long: keep it under 2,000 characters/.test(errText), 'a too-long answer says so in words', errText);
  ok(!/max length|Validation failed/.test(errText), 'not "Validation failed … max length"', errText);
  await closeModals(page);
  await go(page, 'dashboard');
  await go(page, 'dashboard');
  ok(!/Save a usual consent naming your referral partners/.test(await text(page)), 'and the step is done');
}

// ---- 2. small counts of people for roles that run publication releases only ----
for (const u of ['rreader', 'afinance']) {
  const s = await session(u, PW);
  await go(s.page, 'dashboard');
  const home = await text(s.page);
  ok(/<11/.test(home), `${u}: Home shows small counts of people as "<11"`);
  ok(await s.page.$('.main [data-small-cells]'), `${u}: and says why`);
  const d = (await s.api('GET', '/api/reports/dashboard')).data;
  ok(d.clients.by_substance.every(x => x.n === 0 || x.n === '<11' || x.n >= 11), `${u}: no primary-substance count from 1 to 10`, d.clients.by_substance);
  await go(s.page, 'reports');
  const rep = await text(s.page);
  ok(!/Visits by worker/.test(rep), `${u}: Reports has no visits by worker`);
  ok(!/NaN/.test(rep), `${u}: and no NaN where a rate would reveal a small count`);
  await s.close();
}
{
  const s = await session('jwalker', PW);
  await go(s.page, 'reports');
  ok(/Visits by worker/.test(await text(s.page)), 'a supervisor sees visits by worker');
  ok(!(await s.page.$('.main [data-small-cells]')), 'and exact counts');
  await s.close();
}

// ---- 3. client tabs, referral list ----
{
  const { page } = nav;
  await go(page, `client/${clientId}`);
  const strip = await page.$$eval('nav.tabs button[data-tab]', bs => bs.filter(b => !b.hidden && b.offsetParent !== null).map(b => b.dataset.tab));
  eq(strip.slice(0, 6).join(','), 'overview,interventions,notes,tasks,consents,referrals', 'at 1280 px the tabs read Overview, Visits, Notes, To-dos, Consents, Referrals', strip);
  const order = await page.$$eval('nav.tabs button[data-tab]', bs => bs.map(b => b.dataset.tab));
  eq(order[0], 'overview', 'Overview is first in the strip (it used to be moved after Forms)');
  const menu = await page.$$eval('.tabs-menu button', bs => bs.map(b => b.textContent));
  ok(!menu.some(t => /Consents/.test(t)), 'Consents is not under More', menu);
  ok(await page.$('nav.tabs button[data-tab=consents]:text-is("Consents")'), 'the tab is called "Consents"');
  await go(page, `client/${clientId}/notes`);
  const again = await page.$$eval('nav.tabs button[data-tab]', bs => bs.filter(b => !b.hidden).map(b => b.dataset.tab));
  eq(again[0], 'overview', 'with another tab open, Overview is still first');
  await go(page, 'referrals');
  const row = await text(page, '.main table');
  ok(/Quintero-Vasquez, Rosalind/.test(row), 'the referral list names the client for a worker who can open them');
  ok(/Consent on file/.test(row), 'a referral to a provider a live consent names says "Consent on file"');
  ok(!/ROI ✓/.test(row), 'no "ROI ✓" badge');
  const ws = await page.$eval('.main table .badge', b => getComputedStyle(b).whiteSpace);
  eq(ws, 'nowrap', 'at 1280 px a status badge in a table stays on one line');
}

// ---- 4. the Home checklist: default fund, settlement categories ----
{
  const { page, api } = admin;
  const f = await api('POST', '/api/budget/funds', { name: 'Opioid Settlement FY26', source_type: 'opioid_settlement', fiscal_year_start: '2025-07-01', fiscal_year_end: '2026-06-30', total_amount: 50000 });
  eq(f.status, 201, 'a settlement fund with no allowable use');
  eq((await api('PUT', '/api/admin/settings', { default_fund_id: '' })).status, 200, 'and no default fund');
  await go(page, 'dashboard');
  const home = await text(page);
  ok(/Set a default fund/.test(home), 'Home asks for a default fund');
  ok(/Set the opioid-settlement category of [^.]*Opioid Settlement FY26/.test(home), 'and for the settlement fund\'s category, since the settlement report would call it Uncategorised');
  const use = (await api('GET', '/api/meta/constants')).data.SETTLEMENT_USES[0].code;
  const uncategorised = (await api('GET', '/api/budget/funds')).data.funds.filter(x => x.source_type === 'opioid_settlement' && !x.settlement_use);
  for (const x of uncategorised) eq((await api('PUT', `/api/budget/funds/${x.id}`, { settlement_use: use })).status, 200, `the category of ${x.name} is set`);
  eq((await api('PUT', '/api/admin/settings', { default_fund_id: f.data.id })).status, 200, 'and a default fund');
  await go(page, 'dashboard');
  const after = await text(page);
  ok(!/Set a default fund/.test(after) && !/opioid-settlement category/.test(after), 'both steps are done');
}

// ---- 5. wording ----
{
  const { page } = nav;
  await go(page, 'interventions');
  ok(/\d+ visits? ·/.test(await text(page)), 'the Visits page counts "visits", not "interventions"');
  ok(!/intervention/i.test(await page.$eval('.main', m => [...m.querySelectorAll('[aria-label]')].map(x => x.getAttribute('aria-label')).join(' '))), 'no "intervention" in its buttons\' names');
  const secs = await page.$$eval('.sidebar .sec', s => s.map(x => x.textContent.trim()));
  ok(!secs.some(s => /Programme/.test(s)), 'the sidebar says "Program"', secs);
  await page.evaluate(async (id) => (await import('./views/interventions.js')).openInterventionForm(null, { clientId: id, clientDisplay: 'Quintero-Vasquez, Rosalind' }), clientId);
  await page.waitForSelector('.modal select[name=type]');
  const types = await page.$$eval('.modal select[name=type] option', o => o.map(x => x.textContent));
  ok(types.includes('Court or Probation') && types.includes('Screening (SBIRT)'), 'coded choices have proper labels', types.filter(t => /Court|SBIRT/.test(t)));
  ok(!types.some(t => /Court Or|Screening SBIRT/.test(t)), 'not the code capitalised');
  await closeModals(page);
}

// ---- 6. field defaults, picker, overdose, device copy, two-step ----
eq((await admin.api('PUT', '/api/admin/settings', { programme_profile: 'harm_reduction' })).status, 200, 'the program is a harm-reduction program');
{
  const phone = await session('mrivera', PW, { width: 390, height: 844 });
  const { page, api } = phone;
  eq((await api('GET', '/api/meta/constants')).data.DEFAULT_LOCATION, 'street', 'its default location is the street');
  await go(page, 'interventions');
  await page.evaluate(async () => (await import('./views/interventions.js')).openInterventionForm(null, {}));
  await page.waitForSelector('.modal select[name=location]');
  eq(await page.inputValue('.modal select[name=location]'), 'street', 'a new visit starts on Street / Outdoor');
  // The client picker: nothing listed until something is typed, either part of a double surname found,
  // closed once someone is chosen.
  await page.click('.modal input[role=combobox]'); await settle(page);
  ok(!(await page.$('.modal [role=listbox]:not(.hidden)')), 'focusing an empty client search lists nobody');
  await page.fill('.modal input[role=combobox]', 'Vasquez');
  const opt = await until(() => page.$('.modal [role=listbox]:not(.hidden) [role=option]:has-text("Quintero-Vasquez")'));
  ok(opt, '"Vasquez" finds Quintero-Vasquez');
  if (opt) await opt.click();
  await settle(page);
  ok(!(await page.$('.modal [role=listbox]:not(.hidden)')), 'choosing closes the list');
  eq(await page.getAttribute('.modal input[role=combobox]', 'aria-expanded'), 'false', 'and says so');
  await page.fill('.modal input[role=combobox]', 'Quin'); await until(() => page.$('.modal [role=listbox]:not(.hidden)'));
  await page.click('.modal select[name=location]'); await settle(page);
  ok(!(await page.$('.modal [role=listbox]:not(.hidden)')), 'moving on to the next field closes it');
  await closeModals(page);
  // Overdose: where it happened, never at a phone; a toast when it is recorded.
  await go(page, 'overdose');
  await page.click('.main button:has-text("+ Record an event")');
  await page.waitForSelector('.modal select[name=location_type]');
  const where = await page.$$eval('.modal select[name=location_type] option', o => o.map(x => x.value));
  ok(!where.includes('phone') && !where.includes('telehealth'), 'the overdose "Where" offers neither Phone nor Telehealth', where);
  eq(await page.inputValue('.modal select[name=location_type]'), 'street', 'and starts on the street');
  await page.selectOption('.modal select[name=kind]', 'reversal');
  await page.click('.modal button[type=submit]');
  const toast = await until(() => page.$('#toasts .toast:has-text("Event recorded")'), { timeout: 5000 });
  ok(toast, 'recording it shows a confirmation');
  ok(toast && /Overdose reversed with naloxone/.test(await toast.textContent()), 'saying what was recorded');
  // The two-step bar folds into a header link once dismissed, and stays folded.
  const bar = await page.$('[data-banner="mfa-required"]');
  if (bar) {
    await page.click('[data-banner="mfa-required"] button[aria-label="Dismiss"]');
    ok(await until(() => page.$('.appbar [data-mfa-link]')), 'dismissing the two-step bar puts a small link in the header');
    await settle(page);
    await page.reload(); await page.waitForSelector('.layout'); await settle(page);
    ok(!(await page.$('[data-banner="mfa-required"]')), 'after a reload the bar does not come back');
    const link = await page.$('.appbar [data-mfa-link]');
    ok(link, 'the header link does');
    eq(link && await link.getAttribute('href'), '#/profile?mfa=1', 'and goes to two-step set-up');
    const h = await page.$eval('#banners', b => b.getBoundingClientRect().height).catch(() => 0);
    ok(h < 10, 'no bar above the page', h);
  } else ok(false, 'the dev server requires two-step verification of navigators (the bar to fold)');
  // A device copy that has never synced does not say it is signed in on another computer.
  await go(page, 'dashboard');
  const other = await text(page);
  ok(/Also signed in on another computer/.test(other), 'on the office server, with the desktop session open, Home says the account is signed in elsewhere');
  await page.evaluate(async () => { const a = await import('./app.js'); a.state.local = true; a.nav('dashboard?_=' + Date.now()); });
  await settle(page);
  ok(!/Also signed in on another computer|stays in sync/.test(await text(page)), 'a device copy does not say "another computer … stays in sync"');
  await page.evaluate(async () => { const a = await import('./app.js'); a.state.local = false; });
  await phone.close();
}
await admin.api('PUT', '/api/admin/settings', { programme_profile: 'treatment' });

await nav.close(); await admin.close();
await browser.close();
for (const e of errors) ok(false, e);
finish();

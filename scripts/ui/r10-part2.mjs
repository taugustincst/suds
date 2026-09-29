// 1.17.0 in a browser: SUDS as the Part 2 layer beside an EHR, CalOMS automation and secure referral links.
//   1. the Part 2 compliance module profile — the harm-reduction pages leave the sidebar, Privacy & Part 2 leads it
//      and opens on the Part 2 layer tab (consents, disclosures, notice, counseling notes, requests, breaches,
//      referrals, integration), for an administrator and a navigator;
//   2. a secure referral link — made from a referral whose client's consent names the provider (the link and a
//      separate access code, shown once), opened by the provider in a browser with no account (the code, the
//      packet, the §2.32 notice, the token gone from the address bar), answered; the same link refused in a second
//      browser; the worker sees the answer; without a consent only a "please contact us" notice, naming nobody;
//   3. CalOMS automation — the monthly-run settings, the worklist, "Check and prepare (not sent)", a prepared file
//      produced (the disclosure), its upload recorded and the submission log; SUDS says it never contacts DHCS;
//   4. Import offers patients and encounters from the EHR's FHIR export.
// Every page and dialog it adds is checked with axe (WCAG 2.1 A/AA). And the r10 frontline fixes: no "null" in the
// Secure link dialog (H1), no Secure link on a declined or closed referral (M5), the recipient page's date, urgency
// and a mistyped code (L6), and CalOMS providers as rows with messages that name the provider (M6) and plurals (L5).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish, noStrayText } = makeChecks('r10-part2');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };

function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  // 401/403/404/409 are answers these flows expect (a wrong code, a claimed link, an unknown token).
  page.on('console', m => { if (m.type() === 'error' && !/40[01349]/.test(m.text())) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`${who} HTTP ${r.status()} ${r.url()}`); });
}
async function session(username, password = PW, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page, username);
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body, h }) => { const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body, h: H });
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
  // Every page and dialog checked here: no "null" or "undefined" written out as text (r10 H1, assert.mjs).
  await noStrayText(page, where);
}
const sidebar = (page) => page.evaluate(() => {
  const nav = document.querySelector('.sidebar nav.nav');
  const name = (a) => [...a.childNodes].filter(n => !(n.classList && n.classList.contains('ico'))).map(n => n.textContent).join('').trim();
  return { main: [...nav.querySelectorAll(':scope > a')].map(name), all: [...nav.querySelectorAll('a')].map(name) };
});
const toastText = (page, re) => until(async () => { const t = await page.$$eval('#toasts .toast', ts => ts.map(x => x.textContent).join(' | ')); return re.test(t) ? t : null; }, { timeout: 8000 });
const tag = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const today = new Date().toISOString().slice(0, 10);
const ELEMENTS = { signed_at: today, scope: 'Referral summary', expires_at: '2099-01-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };

let admin, nav;
try {
  // ------------------------------------------------------------------ 1. the Part 2 compliance module profile
  admin = await session('admin', 'AdminPassw0rd!x');
  // r10 L4: the help under the profile says what the one chosen does as soon as it is chosen, before saving.
  await admin.go('admin?tab=settings');
  await admin.page.waitForSelector('[data-programme-profile] select[name=programme_profile]');
  await admin.page.selectOption('[data-programme-profile] select[name=programme_profile]', 'part2_layer');
  ok(await until(async () => /beside an EHR|stays the clinical record/.test(await admin.page.textContent('[data-programme-profile] [data-field="programme_profile"] .help'))), 'choosing the Part 2 compliance module shows its own help at once', await admin.page.textContent('[data-programme-profile] [data-field="programme_profile"] .help'));
  await admin.page.selectOption('[data-programme-profile] select[name=programme_profile]', 'treatment');
  eq((await admin.api('PUT', '/api/admin/settings', { programme_profile: 'part2_layer' })).status, 200, 'an administrator chooses the Part 2 compliance module profile');
  await admin.page.reload(); await admin.page.waitForSelector('.layout'); await settle(admin.page);
  const aside = await sidebar(admin.page);
  ok(!aside.all.includes('Supplies') && !aside.all.includes('Overdose & reversals') && !aside.all.includes('Funding & spending'), 'the harm-reduction pages leave the sidebar', aside.all.join(', '));
  ok(aside.all.includes('Privacy & Part 2'), 'Privacy & Part 2 is in it');
  await admin.go('compliance');
  ok(await admin.page.$('[data-part2-layer="part2_layer"]'), 'Privacy & Part 2 opens on the Part 2 layer tab');
  for (const part of ['consents', 'disclosures', 'notice', 'counseling', 'requests', 'breaches', 'referrals', 'integration']) ok(await admin.page.$(`[data-layer-${part}]`), `the layer shows ${part}`);
  await axe(admin.page, 'the Part 2 layer tab (administrator)');

  nav = await session('mrivera');
  const nside = await sidebar(nav.page);
  ok(nside.main.includes('Privacy & Part 2'), 'a navigator has Privacy & Part 2 in the main sidebar, not folded under More', nside.main.join(', '));
  ok(!nside.all.includes('Supplies') && !nside.all.includes('My time'), 'and no Supplies or My time');
  await nav.go('compliance');
  ok(await nav.page.$('[data-part2-layer]'), 'the navigator sees the Part 2 layer');
  ok(!(await nav.page.$('[data-layer-breaches]')), 'without the breach register their role does not hold');
  await axe(nav.page, 'the Part 2 layer tab (navigator)');

  // ------------------------------------------------------------------ 2. a secure referral link
  const res = await nav.api('POST', '/api/resources', { name: `Harbor Clinic ${tag}`, category: 'outpatient' });
  eq(res.status, 201, 'a provider that does not use SUDS');
  const cl = await nav.api('POST', '/api/clients', { first_name: 'Rosa', last_name: `Linkman${tag}`, phone: '555-0199', status: 'active', confirm_duplicate: true });
  eq(cl.status, 201, 'a client');
  eq((await nav.api('POST', `/api/clients/${cl.data.id}/consents`, { type: 'part2_disclosure', recipient: `Harbor Clinic ${tag}`, purpose: 'Referral for treatment', ...ELEMENTS })).status, 201, 'whose Part 2 consent names the provider');
  const ref = await nav.api('POST', '/api/referrals', { client_id: cl.data.id, resource_id: res.data.id, referred_at: new Date().toISOString(), status: 'pending', warm_handoff: false });
  eq(ref.status, 201, 'a pending referral to it');
  // Off by default (counsel reviews the design first): no Secure link button until an administrator switches it on.
  await nav.go(`client/${cl.data.id}/referrals`);
  ok(!(await nav.page.$(`[data-secure-link-open="${ref.data.id}"]`)), 'secure referral links are off by default: no Secure link button');
  eq((await nav.api('POST', `/api/referrals/${ref.data.id}/links`, { kind: 'contact_notice' })).status, 409, 'and the server refuses to make one');
  await admin.go('compliance?tab=overview');
  await admin.page.waitForSelector('[data-invite-settings] input[name=enabled]', { timeout: 10000 });
  await axe(admin.page, 'Privacy & Part 2 overview with the Secure referral links setting');
  await admin.page.check('[data-invite-settings] input[name=enabled]');
  await admin.page.click('[data-invite-settings] button[type=submit]');
  await toastText(admin.page, /Saved/);
  eq((await admin.api('GET', '/api/referral-links/settings')).data.enabled, true, 'an administrator switches secure referral links on in Privacy & Part 2');
  await nav.page.reload(); await nav.page.waitForSelector('.layout'); await settle(nav.page);
  await nav.go(`client/${cl.data.id}/referrals`);
  await nav.page.waitForSelector(`[data-secure-link-open="${ref.data.id}"]`, { timeout: 10000 });
  await nav.page.click(`[data-secure-link-open="${ref.data.id}"]`);
  await nav.page.waitForSelector(`.modal [data-secure-link="${ref.data.id}"]`);
  eq(await nav.page.$eval('.modal select[name=kind]', s => s.value), 'packet', 'with a consent naming the provider, the referral itself is offered');
  await nav.page.fill('.modal textarea[name=message]', 'Needs an intake appointment this week');
  await axe(nav.page, 'the secure link dialog');
  await noStrayText(nav.page, 'the secure link dialog (r10 H1)');
  await nav.page.click('.modal button[type=submit]');
  await nav.page.waitForSelector('.modal [data-secure-link-made="packet"]');
  const url = await nav.page.$eval('.modal [data-secure-link-url]', i => i.value);
  const code = (await nav.page.textContent('.modal [data-secure-link-code]')).trim();
  ok(/\/referral-link\.html#[A-Za-z0-9_-]{43}$/.test(url), 'the link carries its token after "#", never in the path or query', url.replace(/#.*/, '#…'));
  ok(/^\d{6}$/.test(code), 'and a six-digit access code is shown separately');
  await axe(nav.page, 'the link and code, shown once');
  await noStrayText(nav.page, 'the link and code, shown once');
  await nav.page.click('.modal button:has-text("Done")');

  // The provider, in a browser with no account.
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await pctx.newPage(); watch(pp, 'provider');
  await pp.goto(url); await pp.waitForSelector('[data-code-form]:not(.hidden)');
  ok(!pp.url().includes('#'), 'the token is taken out of the address bar at once');
  ok(!/Rosa/.test(await pp.textContent('main')), 'nothing about the client before the code');
  await axe(pp, 'the recipient page asking for the code (phone)');
  // r10 L6: a code that is not six digits is a slip: said at once, never sent, no try used up.
  let opens = 0; pp.on('request', (rq) => { if (rq.url().includes('/api/referral-links/open')) opens++; });
  await pp.fill('#code', code.slice(0, 5)); await pp.click('[data-code-form] button[type=submit]');
  ok(await until(async () => /6 digits/.test(await pp.textContent('#code-error'))), 'a five-digit code is caught in the browser: "An access code is 6 digits"');
  eq(opens, 0, 'and is never sent, so it uses up no try');
  eq(await pp.getAttribute('#code', 'aria-invalid'), 'true', 'the field is marked invalid');
  eq(await pp.getAttribute('#code', 'maxlength'), '7', 'the field takes six digits (and a space), not twelve characters');
  await pp.fill('#code', code === '000000' ? '111111' : '000000'); await pp.click('[data-code-form] button[type=submit]');
  ok(await until(async () => /not right/.test(await pp.textContent('#code-error'))), 'a wrong code is refused, with the tries left');
  ok(/4 tries left/.test(await pp.textContent('#code-error')), 'the mistyped code did not count: 4 of 5 tries left', await pp.textContent('#code-error'));
  await pp.fill('#code', code); await pp.click('[data-code-form] button[type=submit]');
  await pp.waitForSelector('#content:not(.hidden)');
  const shown = await pp.textContent('#content');
  ok(shown.includes(`Rosa Linkman${tag}`) && shown.includes('Needs an intake appointment this week'), 'the code opens the referral: the client and the reason');
  ok(!shown.includes('555-0199'), 'the phone number only when the worker ticks it');
  ok(/42 CFR/i.test(await pp.textContent('#notice-wrap')), 'with the §2.32 notice');
  const details = await pp.textContent('#details');
  ok(!/\d{1,2}:\d{2}:\d{2}/.test(details), 'dates and times without seconds', details);
  ok(/UrgencyRoutine/.test(details.replace(/\s+/g, '')), 'urgency in words ("Routine"), not the stored code', details);
  ok(await pp.$('#invite:not(.hidden)'), 'and the invitation to receive referrals through SUDS');
  await axe(pp, 'the opened referral (phone)');
  await pp.selectOption('#ack-status', 'scheduled'); await pp.fill('#ack-by', 'T. Nguyen, Harbor Clinic intake'); await pp.fill('#ack-note', 'Tuesday 10am');
  await pp.click('[data-ack-form] button[type=submit]');
  ok(await until(async () => /Thank you/.test(await pp.textContent('#status'))), 'the provider\'s answer is sent');
  // Reloading in the same tab still works (the claim is kept for the tab).
  await pp.goto(url); await pp.waitForSelector('#content:not(.hidden)');
  ok(true, 'the same browser can read it again');
  await pctx.close();
  // The link forwarded to someone else — even with the code — opens nothing.
  const fctx = await browser.newContext(); const fp = await fctx.newPage(); watch(fp, 'forwarded');
  await fp.goto(url);
  ok(await until(async () => /already been opened on another device/.test(await fp.textContent('#status'))), 'a forwarded link is refused in another browser, code or no code');
  ok(await fp.$('[data-code-form].hidden'), 'without even asking for the code');
  ok(!/Rosa/.test(await fp.textContent('main')), 'and shows nothing about the client');
  await fctx.close();
  // The worker sees the answer.
  await nav.go(`client/${cl.data.id}/referrals`);
  await nav.page.click(`[data-secure-link-open="${ref.data.id}"]`);
  await nav.page.waitForSelector(`.modal [data-secure-link="${ref.data.id}"]`);
  ok(/T\. Nguyen, Harbor Clinic intake scheduled the client: Tuesday 10am/.test(await nav.page.textContent('.modal')), 'the worker sees who answered and what');
  ok(await nav.page.$('.modal [data-revoke-link]'), 'and can withdraw the link');
  await nav.page.keyboard.press('Escape'); await settle(nav.page);
  const acc = await nav.api('GET', `/api/clients/${cl.data.id}/disclosures/accounting`);
  ok((acc.data.disclosures || []).some(d => d.source === 'referral_link'), 'the disclosure is in the client\'s accounting');

  // Without a consent naming the provider: only the notice that names nobody.
  const cl2 = await nav.api('POST', '/api/clients', { first_name: 'Noel', last_name: `Noconsent${tag}`, status: 'active', confirm_duplicate: true });
  const ref2 = await nav.api('POST', '/api/referrals', { client_id: cl2.data.id, resource_id: res.data.id, referred_at: new Date().toISOString(), status: 'pending', warm_handoff: false });
  await nav.go(`client/${cl2.data.id}/referrals`);
  await nav.page.click(`[data-secure-link-open="${ref2.data.id}"]`);
  await nav.page.waitForSelector(`.modal [data-secure-link="${ref2.data.id}"]`);
  eq(await nav.page.$$eval('.modal select[name=kind] option', os => os.map(o => o.value).join(',')), 'contact_notice', 'without a consent naming the provider, only the contact notice is offered');
  await nav.page.click('.modal button[type=submit]');
  await nav.page.waitForSelector('.modal [data-secure-link-made="contact_notice"]');
  ok(!(await nav.page.$('.modal [data-secure-link-code]')), 'with no access code');
  const url2 = await nav.page.$eval('.modal [data-secure-link-url]', i => i.value);
  await nav.page.keyboard.press('Escape');
  const nctx = await browser.newContext(); const np = await nctx.newPage(); watch(np, 'notice');
  await np.goto(url2); await np.waitForSelector('#content:not(.hidden)');
  ok(/would like to talk to you about a referral/.test(await np.textContent('#status')) && !/Noel|Noconsent/.test(await np.textContent('main')), 'the notice asks the provider to call, and names nobody');
  await axe(np, 'the contact notice');
  await nctx.close();
  // r10 M5: a referral the client declined, or one that is closed, is not sent anywhere: no Secure link.
  for (const status of ['declined_by_client', 'closed']) {
    const rx = await nav.api('POST', '/api/referrals', { client_id: cl.data.id, resource_id: res.data.id, referred_at: new Date().toISOString(), status, warm_handoff: false });
    eq(rx.status, 201, `a ${status.replace(/_/g, ' ')} referral`);
    await nav.go(`client/${cl.data.id}/referrals`);
    ok(await nav.page.$(`[data-secure-link-open="${ref.data.id}"]`) && !(await nav.page.$(`[data-secure-link-open="${rx.data.id}"]`)), `no Secure link on it (the pending one keeps its own)`);
  }

  // ------------------------------------------------------------------ 3. CalOMS automation
  eq((await admin.api('PUT', '/api/admin/settings', { module_caloms: '1' })).status, 200, 'CalOMS switched on for this programme (off by default in the profile)');
  eq((await admin.api('PUT', '/api/caloms/settings', { enabled: true, start_date: '2020-01-01', providers: [{ id: '123456', name: 'Main clinic', legal_name: 'Harbor Recovery Inc.', npi: '1234567893' }, { id: '654321', name: 'Satellite' }] })).status, 200, 'with two provider IDs, one with its NPI');
  await admin.page.reload(); await admin.page.waitForSelector('.layout'); await settle(admin.page);
  await admin.go('caloms');
  ok(await admin.page.$('[data-caloms-no-dhcs]'), 'the page says SUDS never contacts DHCS');
  // r10 M6: one row of fields per provider, not "ID, name | legal name | NPI" on a line.
  const provRows = await admin.page.$$eval('[data-caloms-provider-row]', rows => rows.map(r => Object.fromEntries([...r.querySelectorAll('[data-prov]')].map(i => [i.dataset.prov, i.value]))));
  eq(JSON.stringify(provRows[0]), JSON.stringify({ id: '123456', name: 'Main clinic', legal_name: 'Harbor Recovery Inc.', npi: '1234567893' }), 'the settings show each provider as a row: ID, name, legal name and NPI');
  eq(provRows.length, 2, 'one row per provider');
  ok(!(await admin.page.$('[data-caloms-settings] textarea[name=providers]')), 'no separator format to get wrong');
  await axe(admin.page, 'State reporting settings with the provider rows');
  // A mistyped NPI: the message names the provider and what was typed, never "providers.0.npi".
  await admin.page.fill('[data-caloms-provider-row] >> nth=1 >> [data-prov=npi]', '1234567890');
  await admin.page.click('[data-caloms-settings] button[type=submit]');
  ok(await until(async () => /Provider 2: 1234567890 is not a valid NPI/.test(await admin.page.textContent('[data-caloms-providers]'))), 'a bad NPI is named with its provider and the number typed', await admin.page.textContent('[data-caloms-providers] [data-caloms-providers-error]'));
  ok(!/providers\.\d/.test(await admin.page.textContent('[data-caloms-settings]')), 'with no internal field path in the message');
  eq(await admin.page.evaluate(() => document.activeElement && document.activeElement.dataset.prov), 'npi', 'and the focus on that NPI');
  eq((await admin.api('GET', '/api/caloms/config')).data.providers.find(p => p.id === '654321').npi, undefined, 'nothing was saved');
  await admin.page.click('[data-prov-add]');
  eq(await admin.page.evaluate(() => document.activeElement && document.activeElement.dataset.prov), 'id', '+ Add a provider puts the cursor in the new row\'s ID');
  await admin.go('caloms');
  await admin.page.selectOption('[data-caloms-settings] select[name=schedule]', 'monthly');
  await admin.page.fill('[data-caloms-settings] input[name=schedule_day]', '5');
  await admin.page.click('[data-caloms-settings] button[type=submit]');
  ok(await until(() => admin.page.$('[data-caloms-schedule]')), 'the monthly run is set, and the page says when it runs');
  ok(await admin.page.$('[data-caloms-worklist="all"]'), 'the worklist shows everyone\'s errors to an administrator');
  ok(await admin.page.$('[data-caloms-provider]'), 'a submission can be made for one provider');
  await axe(admin.page, 'State reporting with the monthly run and the worklist');
  // A record ready to go, then Check and prepare.
  const cc = await nav.api('POST', '/api/clients', { first_name: 'Cal', last_name: `Prepared${tag}`, dob: '1990-04-02', status: 'waitlist', confirm_duplicate: true });
  const answers = { admission_transaction: '1', service_type: '01', referral_source: '01', days_waited: 3, prior_episodes: 0, mat_planned: 'N', calworks: 'N', sex_at_birth: 'F', gender_identity: '2', race: ['01'], ethnicity: '05', veteran: 'N', disability: ['1'], zip_code: '95814', education_grade: 12, children_under_18: 1, children_cps: 0, pregnant: 'N', primary_drug: '05', primary_route: '2', primary_age_first_use: 19, secondary_drug: '00', iv_use_12m: 'N', primary_days_used: 10, alcohol_days: 0, iv_use_30: 'N', employment_status: '3', paid_work_days: 0, school_enrolled: 'N', job_training: 'N', living_arrangement: '2', arrests_30: 0, jail_days_30: 0, prison_days_30: 0, er_visits_30: 0, hospital_nights_30: 0, physical_health_days_30: 2, mh_diagnosis: 'N', mh_er_visits_30: 0, psych_inpatient_days_30: 0, psych_meds: 'N', family_conflict_days_30: 1, social_support_days_30: 4, lives_with_user: 'N' };
  eq((await nav.api('POST', `/api/clients/${cc.data.id}/episodes`, { opened_at: today, caloms: { provider_id: '123456', answers } })).status, 201, 'an admission with a clean CalOMS record');
  await admin.go('caloms');
  await admin.page.click('[data-caloms-run]');
  ok(await toastText(admin.page, /prepared/), 'Check and prepare prepares a file, and says it is not sent');
  await settle(admin.page);
  const prep = await until(() => admin.page.$('[data-caloms-produce]'));
  ok(prep, 'the prepared file waits to be produced');
  const sid = prep ? await prep.getAttribute('data-caloms-produce') : null;
  ok(/Prepared/.test(await admin.page.textContent(`[data-caloms-status-of="${sid}"]`)), 'marked Prepared — not sent');
  const dl = admin.page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await admin.page.click(`[data-caloms-produce="${sid}"]`);
  await admin.page.waitForSelector('.modal button:has-text("Produce file")');
  const produceText = await admin.page.textContent('.modal');
  ok(!/\(s\)/.test(produceText), 'the produce dialog words its counts ("1 client", "2 clients"), not "client(s)"', produceText);
  const subRow = ((await admin.api('GET', '/api/caloms/submissions')).data.rows || []).find(x => x.id === sid);
  if (subRow && subRow.counts && subRow.counts.held_back) ok(/held back and (is|are) not in this file/.test(produceText), 'and says the records with fatal errors are held back', produceText);
  await admin.page.click('.modal button:has-text("Produce file")');
  ok(await dl, 'producing it downloads the file (the disclosure)');
  await settle(admin.page);
  ok(await until(() => admin.page.$(`[data-caloms-uploaded="${sid}"]`)), 'then its upload to DHCS can be recorded');
  await admin.page.click(`[data-caloms-uploaded="${sid}"]`);
  await admin.page.fill('.modal input[name=dhcs_reference]', 'BATCH-42');
  await axe(admin.page, 'the record-upload dialog');
  await admin.page.click('.modal button[type=submit]');
  ok(await toastText(admin.page, /Upload recorded/), 'the upload is recorded');
  await settle(admin.page);
  await admin.page.click(`[data-caloms-log-open="${sid}"]`);
  await admin.page.waitForSelector(`.modal [data-caloms-log="${sid}"]`);
  const log = await admin.page.textContent('.modal');
  ok(/Prepared/.test(log) && /Produced \(accounted\)/.test(log) && /Downloaded/.test(log) && /Recorded as uploaded to DHCS/.test(log) && /BATCH-42/.test(log), 'the submission log shows each step', log.slice(0, 300));
  ok(/Uploaded on [A-Z][a-z]{2} \d{1,2}, \d{4} · DHCS reference BATCH-42/.test(log) && !/\d{4}-\d{2}-\d{2} BATCH/.test(log), 'the upload\'s detail reads as a date and a reference, not "2026-09-29 BATCH-42"', log.slice(0, 400));
  await axe(admin.page, 'the submission log');
  await admin.page.keyboard.press('Escape');
  // A navigator's own worklist.
  await nav.page.reload(); await nav.page.waitForSelector('.layout'); await settle(nav.page);
  await nav.go('caloms');
  ok(await nav.page.$('[data-caloms-worklist="mine"]'), 'a navigator sees their own errors first');
  ok(!/\b\d{4}-\d{2}-\d{2}\b/.test(await nav.page.textContent('[data-caloms-worklist]')), 'problems give their dates as the page does ("May 2, 2026"), not as ISO dates');
  await noStrayText(nav.page, 'State reporting for a navigator');
  await axe(nav.page, 'State reporting for a navigator');

  // ------------------------------------------------------------------ 4. Import from the EHR
  await nav.go('imports');
  const opts = await nav.page.$$eval('[data-import-entity] option', os => os.map(o => o.value));
  ok(opts.includes('ehr:clients') && opts.includes('ehr:interventions'), 'Import offers patients and encounters from the EHR');
  // 1.17.1: the card says it takes an EHR export too; the spreadsheet templates are not offered for one; what
  // happens is said in a live region, and a file that cannot be read is an alert in the error colour.
  const card = '.card:has([data-import-entity])';
  eq((await nav.page.textContent(`${card} h2`)).trim(), 'Import a spreadsheet or EHR export', 'the import card is named for both');
  ok(/exported from your EHR/.test(await nav.page.textContent(`${card} > p`)), 'and its introduction says so');
  const templatesShown = () => nav.page.$$eval(`${card} [data-import-template]`, bs => bs.filter(b => b.offsetParent !== null).length);
  eq(await templatesShown(), 2, 'a spreadsheet choice offers its Excel and CSV templates');
  await nav.page.selectOption('[data-import-entity]', 'ehr:clients');
  eq(await templatesShown(), 0, 'an EHR choice does not offer spreadsheet templates');
  eq(await nav.page.getAttribute('[data-import-status]', 'role'), 'status', 'the import status is a live region');
  await nav.page.setInputFiles(`${card} input[type=file]`, { name: 'not-fhir.json', mimeType: 'application/json', buffer: Buffer.from('{"resourceType":"Nothing"}') });
  ok(await until(async () => (await nav.page.textContent('[data-import-error]')).trim().length > 0), 'a file that is not a FHIR export is refused');
  eq(await nav.page.getAttribute('[data-import-error]', 'role'), 'alert', 'as an alert');
  ok(/not-fhir\.json could not be read/.test(await nav.page.textContent('[data-import-error]')), 'naming the file', await nav.page.textContent('[data-import-error]'));
  ok(await nav.page.$eval('[data-import-error]', e => e.classList.contains('err') && getComputedStyle(e).color !== getComputedStyle(document.body).color), 'in the error colour');
  eq((await nav.page.textContent('[data-import-status]')).trim(), '', 'and the status line does not also hold it');
  await axe(nav.page, 'Import with an EHR file refused');
  await nav.page.selectOption('[data-import-entity]', 'clients');
  eq(await templatesShown(), 2, 'back on a spreadsheet choice, the templates are offered again');
} catch (e) {
  fail(`crashed: ${e.stack || e.message}`);
}
// Leave the seeded server as the other scripts expect it.
try { if (admin) { await admin.api('PUT', '/api/admin/settings', { programme_profile: 'treatment', module_caloms: '' }); await admin.api('PUT', '/api/caloms/settings', { enabled: false, schedule: 'off' }); } } catch { /* the next script gets a fresh server anyway */ }
await browser.close();
eq(errors.length, 0, `no page errors, console errors or 5xx${errors.length ? ': ' + errors.join(' / ') : ''}`);
finish();

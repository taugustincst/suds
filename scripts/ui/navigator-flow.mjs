import { chromium } from 'playwright';
import { makeChecks } from './assert.mjs';
async function dismissTour(p) { await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await p.waitForTimeout(700); await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); }
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
import('node:fs').then(m => m.mkdirSync('/tmp/suds-shots', { recursive: true }));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const { ok, eq, finish } = makeChecks('navigator-flow');
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
page.on('response', r => { if (r.status() >= 400 && r.request().method() !== 'GET' && !r.url().includes('/auth/')) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
const shot = (n) => page.screenshot({ path: `/tmp/suds-shots/${n}.png` });
// Wait for the confirmation rather than sampling for it: on a slower machine the save is still in flight
// 300ms after the click, and an empty read looks exactly like a failure.
const toastText = async () => {
  await page.waitForSelector('.toast', { timeout: 8000 }).catch(() => {});
  return (await page.$$eval('.toast', els => els.map(e => e.textContent))).join(' | ');
};
await page.goto(base + '/#/login');
await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]');
await page.waitForSelector('.layout'); await dismissTour(page);
// 1. create client
await page.goto(base + '/#/clients'); await page.waitForTimeout(500);
await page.click('text=+ New client'); await page.waitForSelector('.modal');
await page.fill('.modal input[name=first_name]', 'Test'); await page.fill('.modal input[name=last_name]', 'Playwright'); await page.fill('.modal input[name=dob]', '1990-01-02'); await page.fill('.modal input[name=phone]', '555-0199');
await page.evaluate(() => document.querySelectorAll('.modal details.section').forEach(d => { d.open = true; }));
await page.selectOption('.modal select[name=primary_substance]', 'opioids_fentanyl'); await page.selectOption('.modal select[name=risk_level]', 'high');
await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
const cid = page.url().split('/client/')[1]?.split('/')[0];
ok(!!cid, 'creating a client opens their record', page.url());
// 2. log intervention with time + follow-up
await page.click('text=+ Intervention'); await page.waitForSelector('.modal');
await page.selectOption('.modal select[name=type]', 'naloxone_distribution'); await page.fill('.modal input[name=naloxone_kits]', '1'); await page.fill('.modal input[name=follow_up_due]', '2026-10-01'); await page.fill('.modal textarea[name=summary]', 'Gave kit');
await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
ok(/saved|logged|✓/i.test(await toastText()), 'a naloxone hand-out is logged');
// 3. call
await page.click('text=+ Call'); await page.waitForSelector('.modal'); await page.fill('.modal input[name=purpose]', 'Check in'); await page.fill('.modal textarea[name=summary]', 'Reached client');
eq(await page.$eval('.modal select[name=outcome] option:checked', o => o.value), 'reached', 'a call opens on a call outcome');
await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
ok(/call logged/i.test(await toastText()), 'the call is logged');
// 3b. text message — the same record, worded for texting, with its own outcomes
await page.click('text=+ Text'); await page.waitForSelector('.modal');
const textOutcomes = await page.$$eval('.modal select[name=outcome] option', o => o.map(x => x.value));
ok(textOutcomes.includes('no_reply') && !textOutcomes.includes('voicemail'), 'a text offers text outcomes, not call ones', textOutcomes);
await page.fill('.modal input[name=purpose]', 'Appointment reminder'); await page.fill('.modal textarea[name=summary]', 'Reminded about tomorrow at 9.');
await page.selectOption('.modal select[name=outcome]', 'replied');
await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
ok(/text logged/i.test(await toastText()), 'the text is logged');
await page.goto(`${base}/#/client/${cid}/calls`); await page.waitForTimeout(800);
const how = await page.$$eval('tbody tr', rows => rows.map(r => r.textContent));
ok(how.some(t => /Text/.test(t)) && how.some(t => /Call/.test(t)), 'the contact list tells calls and texts apart', how.length);
await page.goto(`${base}/#/calls?method=text`); await page.waitForTimeout(900);
ok(await page.$$eval('tbody tr', rows => rows.length > 0 && rows.every(r => /Text/.test(r.textContent))), 'the Texts filter shows only texts');
// 4. admin note then sign — back on the client's own page
await page.goto(`${base}/#/client/${cid}/overview`); await page.waitForTimeout(800);
await page.click('text=+ Note'); await page.waitForSelector('.modal'); await page.fill('.modal input[name=title]', 'Contact note'); await page.fill('.modal textarea[name=content]', 'Met client at office.'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
ok(/saved|logged|✓/i.test(await toastText()), 'an administrative note is saved');
await page.goto(`${base}/#/client/${cid}/notes`); await page.waitForTimeout(600); await page.waitForSelector('tbody tr.click', { timeout: 15000 }); await page.click('tbody tr.click'); await page.waitForSelector('.modal'); await page.click('text=Sign & lock'); await page.waitForTimeout(300);
await page.fill('.modal:last-of-type input[name=password]', 'Navigator2026!!'); await page.click('.modal:last-of-type button[type=submit]'); await page.waitForTimeout(800);
ok(/sign|lock|✓/i.test(await toastText()), 'signing the note locks it');
// 5. task
await page.goto(`${base}/#/client/${cid}/overview`); await page.waitForTimeout(500); await page.click('text=+ Task'); await page.waitForSelector('.modal'); await page.fill('.modal input[name=title]', 'Bring ID docs'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(600);
ok(/saved|added|✓/i.test(await toastText()), 'a reminder is added');
// 6. consent
await page.goto(`${base}/#/client/${cid}/consents`); await page.waitForTimeout(600); await page.click('text=+ Consent'); await page.waitForSelector('.modal');
await page.selectOption('.modal select[name=type]', 'part2_disclosure'); await page.fill('.modal input[name=recipient]', 'County OTP'); await page.fill('.modal input[name=purpose]', 'Referral'); await page.fill('.modal input[name=expires_at]', '2027-09-01'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
ok(/saved|recorded|✓/i.test(await toastText()), 'a 42 CFR Part 2 release is recorded');
// 7. referral with consent
await page.goto(`${base}/#/client/${cid}/referrals`); await page.waitForTimeout(600); await page.click('text=+ New referral'); await page.waitForSelector('.modal'); await page.waitForTimeout(300);
// The provider list must offer a way in when the wanted provider is not on it — a phone that has not
// synced has an empty directory, and a referral cannot wait for that.
const providerOptions = await page.$$eval('.modal select[name=resource_id] option', o => o.map(x => x.value));
ok(providerOptions.includes('__add_resource__'), 'the provider picker offers adding one that is not listed', providerOptions.length);
await page.selectOption('.modal select[name=resource_id]', { index: 1 }); await page.selectOption('.modal select[name=consent_id]', { index: 1 }); await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
ok(/saved|✓/i.test(await toastText()), 'the referral is created against the consent');
// 8. expenditure
await page.goto(`${base}/#/client/${cid}/budget`); await page.waitForTimeout(600); await page.click('text=+ Record client assistance'); await page.waitForSelector('.modal');
await page.selectOption('.modal select[name=funding_source_id]', { index: 1 }); await page.waitForTimeout(200); await page.selectOption('.modal select[name=budget_line_id]', { index: 1 }); await page.fill('.modal input[name=amount]', '25'); await page.fill('.modal input[name=vendor]', 'Bus'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
ok(/saved|recorded|✓/i.test(await toastText()), 'client assistance is charged to a funding source');
// 9. time
await page.goto(`${base}/#/client/${cid}/time`); await page.waitForTimeout(600); await page.click('text=+ Log time'); await page.waitForSelector('.modal'); await page.fill('.modal input[name=minutes]', '20'); await page.click('.modal button[type=submit]'); await page.waitForTimeout(800);
ok(/saved|logged|✓/i.test(await toastText()), 'staff time is logged against the client');
await page.goto(`${base}/#/client/${cid}/timeline`); await page.waitForTimeout(700); await shot('flow_timeline');
const items = await page.$$eval('.timeline li', els => els.length);
ok(items >= 6, 'everything recorded appears on the client timeline', items);
ok((await page.textContent('.timeline')).includes('text message'), 'including the text message');
// 10. clinical note blocked for navigator?
await page.goto(`${base}/#/client/${cid}/overview`); await page.waitForTimeout(500); await page.click('text=+ Note'); await page.waitForSelector('.modal');
const kinds = await page.$$eval('.modal select[name=kind] option', o => o.map(x => x.value));
ok(!kinds.includes('clinical'), 'a navigator is not offered clinical notes', kinds);
await page.keyboard.press('Escape');
// 11. search
await page.goto(`${base}/#/clients?q=Playwright`); await page.waitForTimeout(600);
ok(await page.$$eval('tbody tr', r => r.length) > 0, 'the client can be found again by name');
finish(errors);
await browser.close();

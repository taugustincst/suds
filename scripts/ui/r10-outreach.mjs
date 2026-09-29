// 1.17.0: street outreach and settlement outcomes.
//   1. Street outreach on a phone (390 px, touch) at the office: reached from + Log, one screen, big targets, no
//      sideways scroll; a contact with naloxone and test strips saves as an anonymous visit, takes the kits off
//      the stock, and "My shift" counts it; the screen as a start page, on sign-in and from the profile.
//   2. Settlement outcomes for finance: a card per settlement fund, spending beside outcomes, small counts of
//      people suppressed, no client names; the Excel download and the printed page. A navigator cannot open it.
//   3. SUDS on this device (the static build) with no connection: the outreach screen saves a contact, the
//      device's stock goes down, and the shift survives a reload.
import { chromium } from 'playwright';
import { makeChecks, until, settle, saved, passRecoveryCode, signInAgain, skipTour } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const staticBase = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8878';
const { ok, eq, fail, finish, noStrayText } = makeChecks('r10-outreach');
const browser = await chromium.launch();
const errors = [];
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
let offline = false;
function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0-9]/.test(m.text()) && !(offline && /Failed to load resource|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()))) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
}
async function signIn(user, pw, opts = { viewport: { width: 1280, height: 900 } }) {
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true }); const page = await ctx.newPage(); watch(page, user);
  await page.goto(base + '/#/login'); await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true, first_day_skip: true }) })); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  return { ctx, page };
}
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  if (window.SUDS_LOCAL) { const r = await window.SUDS_LOCAL.handle(m, p, b, { 'X-Requested-With': 'suds', 'Content-Type': 'application/json' }); return { status: r.status, data: r.json }; }
  const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) };
}, [method, path, body]);
const go = async (page, hash) => { await page.goto(`${page.url().split('#')[0]}#/${hash}`); await settle(page); };
const toast = (page, re) => until(async () => { const t = await page.$$eval('.toast', e => e.map(x => x.textContent)); return t.find(x => re.test(x)) || null; });
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const stockOf = async (page, itemId, siteId) => (await api(page, 'GET', '/api/supplies')).data.stock.filter(s => s.item_id === itemId && (!siteId || s.site_id === siteId)).reduce((n, s) => n + s.quantity, 0);
const PEOPLE = ['reversals', 'people_served', 'referrals_made', 'people_linked', 'moud_linked', 'treatment_admissions', 'people_trained'];

try {
  // ---------------- 1. street outreach on a phone, at the office ----------------
  const { ctx: navCtx, page: nav } = await signIn('mrivera', 'Navigator2026!!', PHONE);
  const cat = (await api(nav, 'GET', '/api/supplies/catalog')).data;
  const kit = cat.items.filter(i => i.category === 'naloxone').sort((a, b) => b.quick - a.quick)[0];
  const strip = cat.items.filter(i => i.category === 'fentanyl_test_strips').sort((a, b) => b.quick - a.quick)[0];
  ok(kit && strip, 'the sample supplies have a naloxone kit and test strips', cat.items.map(i => i.name));
  await nav.click('.fab button'); await nav.waitForSelector('.quick-list');
  await nav.click('.quick-list button:has-text("Street outreach contact")');
  await until(() => nav.url().includes('#/outreach')); await settle(nav);
  eq((await nav.textContent('.main h1')).trim(), 'Street outreach', '+ Log › Street outreach contact opens the outreach screen');
  ok(await noSideScroll(nav), 'nothing scrolls sideways at 390 px');
  // r10 H1: an empty shift (no participant codes, no supplies yet) wrote "nullnull" under the counts.
  await noStrayText(nav, 'Street outreach at the start of a shift');
  // r10 M1: a contact out here is in the field; the office default is not taken.
  eq(await nav.inputValue('[data-outreach-place]'), 'street', 'Where starts at Street, not the program\'s office default');
  ok(await nav.$eval('[data-outreach-place]', (sel) => { const f = document.querySelector('[data-outreach-form] [data-outreach-supplies]'); return !!(sel.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'and Where is asked before the supplies, next to Contact');
  // r10 M2: the screen is itself the logger: no floating + Log over the − / + counters.
  ok(await nav.$eval('.fab', e => getComputedStyle(e).display === 'none').catch(() => true), 'the floating + Log button is not shown on the outreach screen');
  const nsBox = await nav.$eval('[data-new-shift]', e => { const r = e.getBoundingClientRect(); return { h: r.height, w: r.width }; });
  ok(nsBox.h >= 48 && nsBox.w >= 48, '"Start a new shift" is a 48 px target', nsBox);
  eq(await nav.$$eval('[data-contact-type]', e => e.map(x => x.value).sort().join(',')), 'naloxone_distribution,outreach', 'the kinds of contact are the services that need no client');
  const small = await nav.$$eval('.outreach-btn, .outreach-qty, .outreach-type, .outreach-save, [data-outreach-place]', els => els.map(e => e.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length);
  eq(small, 0, 'every stepper, count, contact type, the place and Save are at least 44 px for a thumb');
  const saveBox = await nav.$eval('[data-outreach-save]', e => { const r = e.getBoundingClientRect(); return { w: r.width, right: r.right }; });
  ok(saveBox.w >= 300, 'Save spans the screen, reachable with either thumb', saveBox);
  ok(await nav.$(`[data-outreach-item="${kit.id}"]`) && await nav.$(`[data-outreach-item="${strip.id}"]`), 'naloxone and test strips each have a − count + row');
  ok(!(await nav.$('[data-outreach-form] input[name=client_id], [data-outreach-form] [data-client-picker]')), 'and nothing asks who the person is');
  const siteId = cat.site_id;
  const kitsBefore = await stockOf(nav, kit.id, siteId);
  await nav.click('label.outreach-type:has([data-contact-type=naloxone_distribution])');
  for (let i = 0; i < 2; i++) await nav.tap(`[data-outreach-item="${kit.id}"] [data-step="1"]`);
  for (let i = 0; i < 4; i++) await nav.tap(`[data-outreach-item="${strip.id}"] [data-step="1"]`);
  await nav.tap(`[data-outreach-item="${strip.id}"] [data-step="-1"]`);
  eq(await nav.inputValue(`[data-outreach-item="${kit.id}"] input`), '2', 'two taps on + is two kits');
  eq(await nav.inputValue(`[data-outreach-item="${strip.id}"] input`), '3', 'and − takes one back');
  await nav.selectOption('[data-outreach-place]', 'shelter');
  await nav.fill('[data-outreach-notes]', 'Asked about the evening van');
  ok(/could identify someone/.test(await nav.textContent('.outreach-notes .help')), 'the notes field says to leave identifiers out');
  await nav.tap('[data-outreach-save]');
  ok(await toast(nav, /Contact saved: 2 Naloxone kits, 3 Fentanyl test strips?\b/), 'saving says what was handed out, in plural where it is more than one', await nav.$$eval('.toast', e => e.map(x => x.textContent)));
  await settle(nav);
  eq(await nav.inputValue(`[data-outreach-item="${kit.id}"] input`), '0', 'the counts start again at 0 for the next contact');
  eq(await nav.inputValue('[data-outreach-place]'), 'shelter', 'the place stays for the next contact');
  await noStrayText(nav, 'Street outreach after a contact');
  eq(await stockOf(nav, kit.id, siteId), kitsBefore - 2, 'two kits came off the stock at the worker\'s site');
  const shift = (await api(nav, 'GET', '/api/outreach/shift')).data;
  eq(shift.contacts, 1, 'my shift counts the contact'); eq(shift.naloxone_kits, 2, 'and its kits');
  ok((await nav.textContent('[data-shift-supplies]')).includes(`${kit.name}: 2`), 'the shift card lists what was handed out', await nav.textContent('[data-outreach-shift]'));
  const visit = (await api(nav, 'GET', '/api/interventions?type=naloxone_distribution&limit=5')).data;
  const mine = (visit.interventions || visit.rows || visit).find(v => v.summary === 'Asked about the evening van');
  ok(mine && !mine.client_id && mine.location === 'shelter', 'it is an anonymous visit at the shelter, as every report reads it', mine && { client_id: mine.client_id, location: mine.location });
  // Keyboard: the − count + and Save work without a pointer too.
  await nav.focus(`[data-outreach-item="${kit.id}"] [data-step="1"]`); await nav.keyboard.press('Enter');
  eq(await nav.inputValue(`[data-outreach-item="${kit.id}"] input`), '1', 'Enter on + adds one');
  await nav.focus('[data-outreach-save]'); await nav.keyboard.press('Enter');
  ok(await toast(nav, /Contact saved: 1 Naloxone kit\./), 'Enter on Save saves (one kit, singular)');
  await settle(nav);
  await nav.selectOption('[data-outreach-place]', 'community');
  await go(nav, 'dashboard'); await go(nav, 'outreach');
  eq(await nav.inputValue('[data-outreach-place]'), 'community', 'the worker\'s last place is remembered as soon as it is chosen, before any save');
  await nav.selectOption('[data-outreach-place]', 'shelter');
  // A new shift starts the counts again.
  await nav.tap('[data-new-shift]'); await settle(nav);
  ok(/Contacts\s*0/.test((await nav.textContent('[data-outreach-shift] .outreach-stats')).replace(/\s+/g, ' ')), 'Start a new shift starts the counts again', await nav.textContent('[data-outreach-shift] .outreach-stats'));
  // The start page.
  await nav.check('[data-outreach-start] input'); await settle(nav);
  await nav.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'suds' } }));
  await nav.goto(base + '/'); await nav.waitForSelector('input[name=username]');
  await nav.fill('input[name=username]', 'mrivera'); await nav.fill('input[name=password]', 'Navigator2026!!'); await nav.click('button[type=submit]');
  await nav.waitForSelector('.layout'); await settle(nav);
  ok(nav.url().endsWith('#/outreach'), 'with it chosen as the start page, signing in opens Street outreach', nav.url());
  await nav.goto(base + '/'); await nav.waitForSelector('.layout'); await settle(nav);
  ok(nav.url().endsWith('#/outreach'), 'and so does opening SUDS with no page in the address', nav.url());
  await go(nav, 'profile');
  eq(await nav.inputValue('[data-start-page]'), 'outreach', 'My profile shows the start page, and changes it');
  await nav.selectOption('[data-start-page]', 'dashboard'); await settle(nav);
  eq((await api(nav, 'GET', '/api/me/prefs')).data.prefs.start_page, undefined, 'choosing Home clears it');
  await go(nav, 'settlement');
  ok(/Not available for your role/.test(await nav.textContent('#main')), 'a navigator cannot open Settlement outcomes');
  await navCtx.close();

  // ---------------- 2. settlement outcomes, for finance ----------------
  const { ctx: supCtx, page: sup } = await signIn('jwalker', 'Navigator2026!!');
  const funds = (await api(sup, 'GET', '/api/budget/funds?all=1')).data.funds;
  const settle1 = funds.find(f => f.source_type === 'opioid_settlement');
  ok(settle1, 'the sample data has an opioid settlement fund');
  eq((await api(sup, 'PUT', `/api/budget/funds/${settle1.id}`, { settlement_use: 'approved_c', settlement_hiaa: 'hiaa_3' })).status, 200, 'a supervisor gives it its Exhibit E category');
  const clients = (await api(sup, 'GET', '/api/clients?limit=40')).data;
  const names = (clients.clients || clients.rows || []).flatMap(c => [c.first_name, c.last_name]).filter(n => n && n.length > 3);
  await supCtx.close();
  const { ctx: finCtx, page: fin } = await signIn('afinance', 'Navigator2026!!');
  await go(fin, 'settlement');
  eq((await fin.textContent('.main h1')).trim(), 'Settlement outcomes', 'finance opens Settlement outcomes');
  ok(await fin.$(`[data-so-fund="${settle1.name}"]`), 'with a card for the settlement fund');
  ok(/not an official state reporting system/.test(await fin.textContent('[data-so-note]')), 'the page says what it is and is not');
  ok(/"<11"/.test(await fin.textContent('[data-so-legend]')), 'and how small counts of people are shown');
  ok(await fin.$(`[data-so-fund="${settle1.name}"] th:has-text("Cost per")`), 'outcomes are shown with a cost per outcome');
  const from = await fin.inputValue('#so-from'); const to = await fin.inputValue('#so-to');
  const d = (await api(fin, 'GET', `/api/reports/settlement-outcomes?from=${from}&to=${to}`)).data;
  eq(d.suppression.mode, 'suppressed', 'finance sees small counts suppressed on the page');
  const cells = [d.total.values, ...d.categories.map(c => c.values), ...d.funds.map(f => f.values), ...d.funds.flatMap(f => f.months.map(m => m.values))];
  eq(cells.flatMap(v => PEOPLE.map(k => v[k])).filter(v => typeof v === 'number' && v > 0 && v < 11).length, 0, 'no count of people from 1 to 10 anywhere on it');
  const pageText = await fin.textContent('#main');
  eq(names.filter(n => pageText.includes(n)).length, 0, 'no client names on the page');
  ok(await noSideScroll(fin), 'nothing scrolls sideways');
  const [dl] = await Promise.all([fin.waitForEvent('download'), fin.click('[data-so-export=xlsx]')]);
  ok(/^suds-settlement-outcomes-.*-internal-suppressed\.xlsx$/.test(dl.suggestedFilename()), 'the Excel download is made on request, and says how it counts', dl.suggestedFilename());
  await fin.emulateMedia({ media: 'print' });
  ok(await fin.$eval('.settlement-print-head', e => getComputedStyle(e).display !== 'none'), 'printed, the page carries its own heading with the period and the kind of run');
  ok(await fin.$eval('.settlement-controls', e => getComputedStyle(e).display === 'none'), 'and leaves the controls out');
  await fin.emulateMedia({ media: 'screen' });
  await go(fin, 'reports');
  ok(await fin.$('[data-settlement-outcomes-link]'), 'Reports links to it');
  await finCtx.close();

  // ---------------- 3. SUDS on this device, with no connection ----------------
  const devCtx = await browser.newContext({ ...PHONE }); const dev = await devCtx.newPage(); watch(dev, 'device');
  await dev.goto(staticBase + '/'); await settle(dev);
  await dev.fill('input[name=display_name]', 'Field Lead'); await dev.fill('input[name=username]', 'fieldlead');
  await dev.fill('input[name=password]', 'Navigator2026!!'); await dev.fill('input[name=confirm]', 'Navigator2026!!');
  await dev.selectOption('select[name=role]', 'supervisor'); await dev.check('input[name=storage_ack]');
  await dev.click('button[type=submit]'); await dev.waitForSelector('.layout', { timeout: 15000 });
  await passRecoveryCode(dev); await skipTour(dev);
  const dsite = (await api(dev, 'GET', '/api/supplies/catalog')).data.site_id;
  const ditems = {};
  for (const [k, name, category] of [['kit', 'Naloxone kit', 'naloxone'], ['syr', 'Syringe 1 mL', 'syringes'], ['wound', 'Wound care kit', 'wound_care']]) {
    ditems[k] = (await api(dev, 'POST', '/api/supplies/items', { name, category, quick: true })).data.id;
    await api(dev, 'POST', '/api/supplies/receipts', { item_id: ditems[k], site_id: dsite, quantity: 25, lot_number: `DV-${k}`, expires_on: '2030-01-01', source: 'donation' });
  }
  await saved(dev);
  offline = true; await devCtx.setOffline(true);
  await dev.click('.fab button'); await dev.waitForSelector('.quick-list');
  await dev.click('.quick-list button:has-text("Street outreach contact")');
  await until(() => dev.url().includes('#/outreach')); await settle(dev);
  ok(/Works with no connection/.test(await dev.textContent('.outreach-intro')), 'offline on the device, the screen says it works with no connection');
  await dev.tap(`[data-outreach-item="${ditems.kit}"] [data-step="1"]`);
  await dev.fill(`[data-outreach-item="${ditems.syr}"] input`, '10');
  await dev.tap(`[data-outreach-item="${ditems.wound}"] [data-step="1"]`);
  await dev.tap('[data-outreach-save]');
  ok(await toast(dev, /Contact saved: 1 Naloxone kit, 10 Syringe 1 mL, 1 Wound care kit/), 'a contact saves with no connection');
  await settle(dev);
  eq(await stockOf(dev, ditems.syr, dsite), 15, 'the device\'s own stock goes down');
  await saved(dev); await dev.reload(); await signInAgain(dev, 'fieldlead', 'Navigator2026!!'); await settle(dev);
  ok(dev.url().includes('#/outreach'), 'after a reload (still offline) the device reopens the outreach screen', dev.url());
  eq((await api(dev, 'GET', '/api/outreach/shift')).data.contacts, 1, 'and the shift still counts the contact');
  offline = false; await devCtx.setOffline(false);
  await devCtx.close();
} catch (e) {
  fail(`the script stopped: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
}
finish(errors);
await browser.close();

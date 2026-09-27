// Supplies (docs/SUPPLIES.md): the Supplies page by site and lot, receiving on a phone, a transfer, an
// adjustment and a disposal, the expiry alerts on Home, the visit form's supply list (the usual items one tap
// away) drawing stock down first-expiry-first-out, the syringe services summary, and the same on a device
// (/?local=1): the office's items and stock arrive by sync, a visit recorded offline draws the device's copy
// down, and after the next sync the office has drawn it once and the device shows the office's figures.
import { chromium } from 'playwright';
import { makeChecks, until, settle, saved } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { ok, eq, fail, finish } = makeChecks('supplies');
const browser = await chromium.launch();
const errors = [];
async function signIn(user, pw, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${user} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0-9]/.test(m.text())) errors.push(`${user} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  return page;
}
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  if (window.SUDS_LOCAL) { const r = await window.SUDS_LOCAL.handle(m, p, b, { 'X-Requested-With': 'suds', 'Content-Type': 'application/json' }); return { status: r.status, data: r.json }; }
  const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) };
}, [method, path, body]);
const go = async (page, hash) => { await page.goto(`${page.url().split('#')[0]}#/${hash}`); await settle(page); };
const toast = (page, re) => until(async () => { const t = await page.$$eval('.toast', e => e.map(x => x.textContent)); return t.find(x => re.test(x)) || null; });
const onHand = async (page, itemName, siteId = null) => {
  const d = (await api(page, 'GET', '/api/supplies')).data; const it = d.items.find(i => i.name === itemName);
  return it ? d.stock.filter(s => s.item_id === it.id && (!siteId || s.site_id === siteId)).reduce((n, s) => n + s.quantity, 0) : null;
};
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

try {
  // ---------------- the supervisor: the page, Home, sites ----------------
  const sup = await signIn('jwalker', 'Navigator2026!!');
  await go(sup, 'supplies');
  const seeded = (await api(sup, 'GET', '/api/supplies')).data;
  const nal = seeded.items.find(i => i.name === 'Naloxone kit');
  ok(nal && nal.category === 'naloxone' && nal.product === 'nasal_4mg' && nal.quick, 'the sample data has naloxone by product, a usual item', nal);
  ok(await sup.$('[data-qty="Naloxone kit"]'), 'the Stock tab lists it with its quantity on hand');
  eq(await sup.$eval('[data-qty="Naloxone kit"]', e => e.textContent.trim()), '42', 'forty-two kits in two lots at the main office');
  ok(await sup.$('[data-supply-alerts] a:has-text("expiring")'), 'a lot expiring within 60 days is flagged on the page');
  await go(sup, 'dashboard');
  ok(await sup.$('[data-supply-tile] .stat'), 'Home has a supply tile for the supervisor');
  ok(await sup.$('a.badge:text-matches("supply lots? expires? within 60 days")'), 'and an alert naming the expiring lots');
  await go(sup, 'supplies?tab=setup');
  await sup.click('.main button:has-text("+ Add site")'); await sup.waitForSelector('.modal input[name=name]');
  await sup.fill('.modal input[name=name]', 'Outreach van'); await sup.selectOption('.modal select[name=kind]', 'van');
  await sup.click('.modal button[type=submit]');
  ok(await toast(sup, /site added/i), 'a supervisor adds a site (the van)');
  await settle(sup);
  const van = (await api(sup, 'GET', '/api/supplies')).data.sites.find(s => s.name === 'Outreach van');
  ok(van && van.kind === 'van', 'the van is a site', van);

  // A transfer to the van: the earliest-expiring naloxone goes first.
  await go(sup, 'supplies');
  await sup.click(`.main button[aria-label="Move ${nal.name}"]`); await sup.waitForSelector('.modal select[name=to_site_id]');
  await sup.selectOption('.modal select[name=to_site_id]', van.id); await sup.fill('.modal input[name=quantity]', '10');
  await sup.click('.modal button[type=submit]');
  ok(await toast(sup, /moved to Outreach van/), 'ten kits moved to the van');
  await settle(sup);
  eq(await onHand(sup, nal.name, van.id), 10, 'the van holds ten');
  const lots = (await api(sup, 'GET', '/api/supplies')).data.lots.filter(l => l.item_id === nal.id && l.site_id === van.id);
  eq(lots.map(l => l.lot_number).join(','), 'NX23K052', 'the lot that expires first moved');

  // An adjustment after a count, and a disposal of an expired lot.
  await sup.click(`.main button[aria-label="Adjust ${nal.name}"]`); await sup.waitForSelector('.modal select[name=reason]');
  await sup.selectOption('.modal select[name=site_id]', van.id); await sup.fill('.modal input[name=counted]', '9');
  await sup.click('.modal button[type=submit]');
  ok(await toast(sup, /−1 recorded/), 'counting nine where the books said ten records −1');
  eq((await api(sup, 'POST', '/api/supplies/receipts', { item_id: nal.id, site_id: van.id, quantity: 4, lot_number: 'OLD-1', expires_on: inDays(-3), source: 'donation' })).status, 201, 'an expired lot on the books');
  await go(sup, 'supplies?tab=lots');
  ok(await sup.$('.main td :text("Expired")') || await sup.$('.main .badge:has-text("Expired")'), 'the Lots tab marks it expired, in words');
  await sup.click('.main button[aria-label^="Dispose of Naloxone kit, Lot OLD-1"]'); await sup.waitForSelector('.modal input[name=quantity]');
  eq(await sup.inputValue('.modal input[name=quantity]'), '4', 'the whole lot, by default');
  await sup.click('.modal button[type=submit]');
  ok(await toast(sup, /4 disposed of/), 'the expired lot is disposed of');
  await go(sup, 'supplies?tab=history');
  ok(await sup.$('.main td:has-text("Disposed of — Expired")'), 'the history shows the disposal with its reason');
  ok(await sup.$('.main td:has-text("Transferred out")') && await sup.$('.main td:has-text("Transferred in")'), 'and both halves of the transfer');

  // ---------------- a navigator on a phone: receiving, then a visit ----------------
  const phone = await signIn('mrivera', 'Navigator2026!!', { width: 390, height: 844 });
  await go(phone, 'supplies');
  ok(await noSideScroll(phone), 'the Supplies page fits a 390px phone without sideways scrolling');
  ok(!(await phone.$('.main button:has-text("+ Add item")')), 'a navigator cannot add items');
  ok(!(await phone.$('.main button[aria-label^="Adjust"]')), 'or adjust stock');
  await phone.click('.main button:has-text("Receive stock")'); await phone.waitForSelector('.modal select[name=item_id]');
  const syr = seeded.items.find(i => i.category === 'syringes');
  await phone.selectOption('.modal select[name=item_id]', syr.id); await phone.fill('.modal input[name=quantity]', '100');
  await phone.fill('.modal input[name=lot_number]', 'SY-NEW'); await phone.fill('.modal input[name=expires_on]', inDays(700));
  await phone.selectOption('.modal select[name=source]', 'cdph_clearinghouse'); await phone.fill('.modal input[name=reference]', 'Clearinghouse order 88');
  const syrBefore = await onHand(phone, syr.name);
  await phone.click('.modal button[type=submit]');
  ok(await toast(phone, /100 received/), 'a navigator records a delivery from a phone');
  eq(await onHand(phone, syr.name), syrBefore + 100, 'and it is on hand');
  await phone.selectOption('#supply-my-site', van.id);
  ok(await toast(phone, /draw from Outreach van/), 'the navigator works from the van');

  await go(phone, 'interventions');
  await phone.click('text=+ Log a visit'); await phone.waitForSelector('.modal [data-supply-picker]');
  ok(await phone.$(`.modal [data-supply-row="${nal.id}"] input[name=naloxone_kits]`), 'the usual naloxone item is on the form, its box still named naloxone_kits');
  ok(!(await phone.$('.modal [data-field="naloxone_kits"]')), 'with no separate naloxone count field');
  await phone.selectOption('.modal select[name=type]', 'outreach');
  await phone.click(`.modal button[aria-label="One more ${nal.name}"]`); await phone.click(`.modal button[aria-label="One more ${nal.name}"]`);
  eq(await phone.inputValue(`.modal [data-supply-row="${nal.id}"] input`), '2', 'two taps, two kits');
  await phone.fill(`.modal [data-supply-row="${syr.id}"] input`, '20');
  const sharps = seeded.items.find(i => i.category === 'sharps_container');
  await phone.selectOption('.modal select[data-supply-add]', sharps.id); await phone.click('.modal button[data-supply-add-button]');
  ok(await phone.$(`.modal [data-supply-row="${sharps.id}"]`), 'another item is added from the list');
  eq(await phone.$eval('.modal select[data-supply-site]', s => s.options[s.selectedIndex].textContent), 'Outreach van', 'the supplies come from the worker\'s site');
  // 1.14.0: syringe returns are in the visit's "Syringe services" section, folded until opened.
  ok(!(await phone.isVisible('.modal input[name=syringes_returned]')), 'syringe returns are folded into their own section');
  await phone.click('.modal details[data-section-key="syringes"] > summary');
  await phone.fill('.modal input[name=syringes_returned]', '15');
  ok(await noSideScroll(phone), 'the visit form fits the phone');
  const vanBefore = await onHand(phone, nal.name, van.id);
  await phone.click('.modal button[type=submit]');
  ok(await toast(phone, /visit logged/i), 'the outreach contact is logged');
  await settle(phone);
  const visit = (await api(phone, 'GET', '/api/interventions?type=outreach&mine=1&limit=1')).data.rows[0];
  eq(visit.naloxone_kits, 2, 'its naloxone count is the kits on its list');
  eq(visit.syringes_returned, 15, 'with the syringes brought back');
  eq(visit.supplies.map(x => `${x.quantity} ${x.item}`).sort().join('; '), [`1 ${sharps.name}`, `2 ${nal.name}`, `20 ${syr.name}`].sort().join('; '), 'and every item handed out');
  eq(await onHand(phone, nal.name, van.id), vanBefore - 2, 'drawn from the van');
  ok(await phone.$('.main .badge:has-text("2 Naloxone kit")'), 'the visit list shows what went out');

  // ---------------- the syringe services summary ----------------
  const t = new Date().toISOString().slice(0, 10);
  await go(sup, `supplies?tab=ssp&from=${t.slice(0, 8)}01&to=${t}`);
  ok(await sup.$('[data-ssp-report] [data-run-kind]'), 'the SSP summary says what kind of run it is');
  const rep = (await api(sup, 'GET', `/api/reports/ssp?from=${t.slice(0, 8)}01&to=${t}`)).data;
  ok(rep.totals.syringes_distributed >= 20 && rep.totals.syringes_returned >= 15 && rep.totals.sharps_containers >= 1, 'it counts the syringes out and back and the sharps container', rep.totals);
  ok(await sup.$('[data-ssp-export="xlsx"]') && await sup.$('[data-ssp-export="csv"]'), 'with Excel and CSV exports');
  const [dl] = await Promise.all([sup.waitForEvent('download', { timeout: 10000 }), sup.click('[data-ssp-export="csv"]')]);
  ok(/suds-ssp-summary-.*\.csv$/.test(dl.suggestedFilename()), 'the CSV downloads', dl.suggestedFilename());

  // ---------------- the same on a device ----------------
  const dctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const dev = await dctx.newPage();
  dev.on('pageerror', e => errors.push(`device PAGEERROR ${e.message}`));
  await dev.goto(base + '/?local=1#/');
  await until(async () => (await dev.$('input[name=username]')) || (await dev.$('.boot.error')), { timeout: 20000 });
  await dev.fill('input[name=display_name]', 'Phone Nav'); await dev.fill('input[name=username]', 'mrivera'); await dev.fill('input[name=password]', 'Navigator2026!!'); await dev.fill('input[name=confirm]', 'Navigator2026!!');
  await dev.click('button[type=submit]'); await dev.waitForSelector('.layout', { timeout: 15000 });
  for (let i = 0; i < 5; i++) { const b = await dev.$('.modal button.primary'); if (!b) break; await b.click(); await settle(dev); }
  const sync = async () => {
    await dev.goto(base + '/?local=1#/sync'); await dev.waitForSelector('input[name=office_password]', { timeout: 10000 });
    await dev.fill('input[name=server]', base); await dev.fill('input[name=username]', 'mrivera'); await dev.fill('input[name=office_password]', 'Navigator2026!!');
    await dev.click('button[type=submit]');
    return await until(async () => { const x = (await dev.textContent('.card:nth-of-type(2) .small.muted.mt').catch(() => '')) || ''; return /connecting|signing|download|upload/i.test(x) && !/complete|done|synced/i.test(x) ? null : x || null; }, { timeout: 30000 }) || '';
  };
  const log1 = await sync();
  ok(!/fail|error|could not/i.test(log1), 'the device syncs', log1.slice(0, 160));
  await settle(dev);
  const officeVan = await onHand(sup, nal.name, van.id);
  eq(await onHand(dev, nal.name, van.id), officeVan, 'the device shows the office\'s stock at the van');
  await dev.goto(base + '/?local=1#/supplies'); await settle(dev);
  ok(await dev.$('[data-qty="Naloxone kit"]'), 'the Supplies page works on the device');
  ok(!(await dev.$('.main button:has-text("+ Add item"):not([disabled])')) && /kept at the office/.test(await dev.textContent('[data-supplies-office]').catch(() => '')), 'items are the office\'s there, and the page says so');
  eq((await api(dev, 'POST', '/api/supplies/items', { name: 'Device item' })).status, 403, 'and cannot be added on the device');
  // A visit recorded on the device draws the device's copy down at once.
  eq((await api(dev, 'POST', '/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), supply_site_id: van.id, supplies: [{ item_id: nal.id, quantity: 1 }] })).status, 201, 'a visit recorded offline');
  eq(await onHand(dev, nal.name, van.id), officeVan - 1, 'the device\'s own stock falls at once');
  await saved(dev);
  const log2 = await sync();
  ok(!/fail|error|could not/i.test(log2), 'the device syncs again', log2.slice(0, 160));
  eq(await onHand(sup, nal.name, van.id), officeVan - 1, 'the office drew it down once');
  const log3 = await sync();
  ok(!/fail|error|could not/i.test(log3), 'and once more', log3.slice(0, 160));
  eq(await onHand(dev, nal.name, van.id), officeVan - 1, 'the device shows the office\'s figure: its own draw-down replaced, not doubled');
  await dctx.close();
} catch (e) { fail(`the script stopped: ${e.message.split('\n')[0]}`); }

ok(!errors.length, 'no page or console errors', errors.slice(0, 5));
await browser.close();
finish();

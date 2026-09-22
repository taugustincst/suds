// The navigator-facing fixes, checked in a real browser: tap-to-call/text/map links, the offline banner
// and friendly failure, names instead of codes on the to-do / calls / time lists, compact phone rows, the
// client page's tab overflow menu, intake opening an episode and re-admission, requesting a co-sign, the
// inert drawer and tap targets, the reminders bell, the overdue label on Home, alias search, caseload
// sort, the hand-offs card, the safety-plan chip and the supply cupboard.
import { chromium } from 'playwright';
import { makeChecks, until } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, finish } = makeChecks('navigator-fixes');
const errors = [];

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
async function session(user, pass, viewport = { width: 1360, height: 900 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
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
  return { page, ctx, api, close: () => ctx.close() };
}
// A cache-buster: a hash-only navigation to the same URL never re-renders.
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await page.waitForTimeout(500); };
const closeModal = async (page) => { await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg'))); };

// ---------------- desktop: navigator ----------------
const nav = await session('mrivera', 'Navigator2026!!');
{
  const { page, api } = nav;
  // a client with a phone, an address and a safety plan
  const list = (await api('GET', '/api/clients?limit=50&status=all')).data.clients;
  const withPlan = (await api('GET', '/api/clients?limit=50&status=all')).data.clients;
  let planned = null;
  for (const c of withPlan) { const d = (await api('GET', `/api/clients/${c.id}`)).data.client; if (d.safety_plan) { planned = d; break; } }
  const c = planned || (await api('GET', `/api/clients/${list[0].id}`)).data.client;
  await go(page, `client/${c.id}`);

  // 1. tap-to-call / text / map
  const tel = await page.$(`a[href^="tel:"]`);
  ok(tel, 'the client overview renders the phone number as a tel: link');
  ok(await page.$(`a[href^="sms:"]`), 'and a Text (sms:) link beside it');
  const map = await page.$('a.maplink');
  ok(map, 'the address is a maps link');
  if (map) { eq(await map.getAttribute('target'), '_blank', 'maps opens in a new tab'); ok(/noopener/.test(await map.getAttribute('rel') || ''), 'with rel=noopener'); ok(/maps\.google\.com\/\?q=/.test(await map.getAttribute('href')), 'pointing at a maps search'); }
  const callBtn = await page.$('button[data-call]');
  ok(callBtn, 'there is a Call button next to the number');
  if (callBtn) {
    await callBtn.click();
    const modal = await until(() => page.$('.modal input[name=phone]'));
    ok(modal, 'Call opens the call log');
    eq(modal ? await modal.inputValue() : '', c.phone, 'prefilled with the number just dialled');
    await closeModal(page);
  }
  const textBtn = await page.$('button[data-text]');
  if (textBtn) { await textBtn.click(); const t = await until(() => page.$('.modal')); ok(t && /text message/i.test(await t.textContent()), 'Text opens the text log'); await closeModal(page); }

  // 12c. safety plan chip
  if (planned) {
    const chip = await page.$('button[data-safety-plan]');
    ok(chip, 'a safety plan on file is shown as a chip on the client header');
    ok(chip && /Safety plan on file/.test(await chip.textContent()), 'labelled with its date');
    if (chip) { await chip.click(); const m = await until(() => page.$('.modal')); ok(m && /Reasons for living/.test(await m.textContent()), 'tapping it opens the plan with its sections labelled'); await closeModal(page); }
  } else ok(false, 'the sample data has a safety plan to show');

  // 5. tab overflow menu on a narrow desktop window
  await page.setViewportSize({ width: 760, height: 900 });
  await go(page, `client/${c.id}`);
  const more = await until(async () => { const b = await page.$('.tabs-more'); return b && !(await page.$eval('.tabs-more-wrap', w => w.hidden)) ? b : null; });
  ok(more, 'tabs that do not fit fold into a More menu');
  const hiddenTabs = await page.$$eval('.tabs > button[hidden]', b => b.length);
  ok(hiddenTabs > 0, 'some tab buttons are hidden into the menu', hiddenTabs);
  eq(await page.$eval('.tabs > button.active', b => b.hidden), false, 'the active tab is never the one hidden');
  const overflowX = await page.$eval('.tabs', t => t.scrollWidth <= t.clientWidth + 1);
  ok(overflowX, 'the strip no longer scrolls sideways');
  if (more) {
    await more.focus(); await page.keyboard.press('Enter');
    const item = await until(() => page.$('.tabs-menu:not(.hidden) button'));
    ok(item, 'the menu opens from the keyboard');
    eq(await page.$eval('.tabs-more', b => b.getAttribute('aria-expanded')), 'true', 'and says so');
    eq(await page.evaluate(() => document.activeElement && document.activeElement.closest('.tabs-menu') !== null), true, 'focus moves into the menu');
    await page.keyboard.press('Escape');
    ok(await until(async () => page.$eval('.tabs-menu', m => m.classList.contains('hidden'))), 'Escape closes it');
    await more.click(); const last = await until(() => page.$('.tabs-menu:not(.hidden) button:last-child'));
    const label = last ? await last.textContent() : '';
    if (last) { await last.click(); await page.waitForTimeout(500); ok(new RegExp(label.split(' ')[0]).test(await page.$eval('.tabs > button.active', b => b.textContent)), 'choosing a menu item opens that tab and brings it into the strip', label); }
  }
  await page.setViewportSize({ width: 1360, height: 900 });

  // 6. intake opens an episode; New client has no discharge fields; re-admit
  await go(page, 'clients');
  await page.click('text=+ New client'); await page.waitForSelector('.modal input[name=first_name]');
  ok(!(await page.$('.modal [name=discharge_date]')), 'the New client form no longer asks for a discharge date');
  await page.fill('.modal input[name=first_name]', 'Auto'); await page.fill('.modal input[name=last_name]', 'Episode' + Date.now().toString().slice(-4));
  await page.fill('.modal input[name=preferred_name]', 'Sparky');
  await page.click('.modal button[type=submit]'); await page.waitForURL(/#\/client\//, { timeout: 10000 });
  const newId = page.url().split('/client/')[1].split('/')[0];
  await page.waitForTimeout(600);
  ok(/Open — first episode/.test(await page.textContent('.main')), 'the overview says the first episode is open');
  await go(page, `client/${newId}/episodes`);
  ok(/Intake opens the first episode automatically/.test(await page.textContent('.main')), 'the Episodes tab explains the model');
  eq(await page.$$eval('tbody tr', r => r.length), 1, 'one episode row, opened at intake');
  await page.click('button:has-text("Discharge")'); await page.waitForSelector('.modal select[name=discharge_reason]');
  await page.selectOption('.modal select[name=discharge_reason]', 'lost_contact'); await page.click('.modal button[type=submit]');
  await until(async () => !(await page.$('.modal-bg .modal form')));
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  await go(page, `client/${newId}/episodes`);
  const reopen = await page.$('button[data-reopen]');
  ok(reopen, 'a closed episode offers Reopen / re-admit');
  if (reopen) {
    await reopen.click(); const dlg = await until(() => page.$('.modal input'));
    if (dlg) { await dlg.fill('Discharged by mistake'); await page.click('.modal button:has-text("Reopen")'); }
    await page.waitForTimeout(800);
    const st = (await api('GET', `/api/clients/${newId}`)).data.client;
    eq(st.status, 'active', 're-admission makes the client active again'); eq(st.open_episode, true, 'and the episode is open');
  }
  // Edit form for a client with episodes points at the Episodes tab instead of discharge fields
  await go(page, `client/${newId}`); await page.click('button:has-text("Edit")'); await page.waitForSelector('.modal input[name=first_name]');
  ok(!(await page.$('.modal [name=discharge_date]')), 'Edit hides discharge fields for a client with episodes');
  ok(/Episodes tab/.test(await page.textContent('.modal')), 'and points at the Episodes tab');
  await closeModal(page);

  // 10. alias search
  await go(page, 'clients?status=all&q=Sparky');
  ok((await page.textContent('.main')).includes('Episode'), 'searching the preferred name finds the client');
  const ph = await page.$eval('.filters input[type=search]', i => i.placeholder);
  ok(/exact phone/.test(ph) && /preferred name/.test(ph), 'the search box promises exact phone and preferred name', ph);
  const gph = await page.$eval('.gsearch input', i => i.placeholder);
  ok(/name, code or exact phone/.test(gph), 'so does the global search', gph);

  // 12a. caseload sort
  await go(page, 'clients');
  const sortSel = await page.$('select[data-sort]');
  ok(sortSel, 'the client list has a sort control');
  if (sortSel) {
    const opts = await page.$$eval('select[data-sort] option', o => o.map(x => x.textContent));
    ok(opts.some(o => /oldest first/.test(o)) && opts.some(o => /Overdue/.test(o)) && opts.some(o => /Risk/.test(o)), 'with last-contact, overdue and risk orders', opts);
    await page.selectOption('select[data-sort]', 'risk'); await page.waitForTimeout(700);
    ok(/sort=risk/.test(page.url()), 'the choice is in the URL');
    const firstRisk = await page.$eval('tbody tr:first-child', r => r.textContent);
    ok(/Critical/.test(firstRisk), 'risk order puts a critical client first', firstRisk.slice(0, 80));
  }

  // 3. names instead of codes
  await go(page, 'tasks');
  const taskClient = await page.$eval('tbody tr td:nth-child(4)', td => td.textContent).catch(() => '');
  ok(!/^\s*DEMO-\d+\s*$/.test(taskClient) && /[A-Za-z]+,\s*[A-Za-z]+/.test(taskClient), 'the to-do list names the client', taskClient);
  ok(/DEMO-\d+/.test(taskClient), 'with the code secondary');
  await api('POST', '/api/calls', { client_id: c.id, direction: 'outbound', started_at: new Date().toISOString(), duration_minutes: 2, outcome: 'reached', phone: '555-0177', purpose: 'Tap test' });
  await go(page, 'calls');
  ok(/[A-Za-z]+,\s*[A-Za-z]+/.test(await page.$eval('tbody tr', r => r.textContent)), 'Calls & texts names the client');
  ok(await page.$('tbody a[href^="tel:"]'), 'and numbers on the calls list are tel: links');
  await go(page, 'time');
  ok(/[A-Za-z]+,\s*[A-Za-z]+/.test(await page.$$eval('tbody tr', rs => rs.map(r => r.textContent).join(' '))), 'My time names the client');

  // 9. bell and overdue label on Home
  await go(page, 'dashboard');
  const bell = await page.$('[data-due-bell]');
  ok(bell, 'the header has a reminders bell');
  const dueNow = (await api('GET', '/api/tasks/due?within=60')).data;
  if (bell && dueNow.rows.length) { const cnt = await until(async () => page.$eval('[data-due-bell] .bell-count', c => c.classList.contains('hidden') ? '' : c.textContent)); eq(cnt, String(dueNow.rows.length), 'the bell shows how many are due or overdue'); }
  const items = await page.$$eval('.today-item[data-overdue]', els => els.map(e => e.dataset.overdue));
  if (items.length) {
    const firstNotOverdue = items.indexOf('0'); const lastOverdue = items.lastIndexOf('1');
    ok(firstNotOverdue === -1 || lastOverdue < firstNotOverdue, 'overdue items are listed before today\'s', items.join(''));
    if (lastOverdue >= 0) ok(await page.$('.today-item[data-overdue="1"] .badge:has-text("Overdue")'), 'and are labelled Overdue');
  }
  ok(await page.$('[data-handoffs]'), 'Home shows the hand-offs from the last 24h');
  ok(/Hand-off: detox bed pending/.test(await page.textContent('[data-handoffs]')), 'including the sample hand-off');

  // 7. request a co-sign from the note editor / viewer
  await go(page, `client/${c.id}/notes`);
  await page.click('button:has-text("+ Note")'); await page.waitForSelector('.modal textarea[name=content]');
  ok(await page.$('.modal input[name=cosign_requested]'), 'the note editor offers "Request supervisor co-sign / review"');
  const fmtOpts = await page.$$eval('.modal select[name=format] option', o => o.map(x => x.value));
  ok(fmtOpts.includes('handoff') && fmtOpts.includes('safety_plan'), 'hand-off and safety plan are note formats', fmtOpts);
  await page.selectOption('.modal select[name=format]', 'safety_plan');
  ok(await page.$('.modal textarea[data-sec=warning_signs]'), 'a safety plan shows its structured sections');
  await page.selectOption('.modal select[name=format]', 'narrative');
  await page.fill('.modal input[name=title]', 'Needs a second look'); await page.fill('.modal textarea[name=content]', 'Client disclosed a safety concern; want this reviewed.');
  await page.check('.modal input[name=cosign_requested]');
  await page.click('.modal button[type=submit]'); await until(async () => !(await page.$('.modal-bg')));
  await page.waitForTimeout(700);
  const mine = (await api('GET', `/api/notes?client_id=${c.id}&mine=1&status=draft`)).data.rows.find(n => n.title === 'Needs a second look');
  ok(mine && mine.cosign_requested === true, 'the draft is saved with the request', mine && mine.cosign_requested);
  if (mine) {
    await api('POST', `/api/notes/${mine.id}/sign`, { password: 'Navigator2026!!' });
    // a plain signed note gets the "Send to supervisor" button
    const plain = (await api('POST', '/api/notes', { client_id: c.id, kind: 'admin', title: 'Plain one', content: 'Routine.', occurred_at: new Date().toISOString() })).data;
    await api('POST', `/api/notes/${plain.id}/sign`, { password: 'Navigator2026!!' });
    await go(page, `notes/${plain.id}`);
    const send = await until(() => page.$('button[data-send-supervisor]'));
    ok(send, 'a signed note offers "Send to supervisor"');
    if (send) { await send.click(); const badge = await until(() => page.$('.modal .badge:has-text("Review requested")')); ok(badge, 'and the note then shows the request'); }
    await closeModal(page);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
}

// supervisor sees the requested notes in the queue
{
  const sup = await session('jwalker', 'Navigator2026!!');
  await go(sup.page, 'supervision');
  const text = await sup.page.textContent('.main');
  ok(/Needs a second look/.test(text) && /Plain one/.test(text), 'both requested notes wait in the supervisor\'s countersignature queue');
  ok(await sup.page.$('.badge:has-text("Review requested by author")'), 'marked as requested by the author');
  await sup.close();
}

// ---------------- 12d. supplies ----------------
{
  const { page, api } = nav;
  await go(page, 'supplies');
  ok(/Naloxone kit/.test(await page.textContent('.main')), 'the Supplies page lists the cupboard');
  const before = Number((await page.$eval('[data-qty="Naloxone kit"]', e => e.textContent)).replace(/,/g, ''));
  const cid = (await api('GET', '/api/clients?limit=1')).data.clients[0].id;
  await api('POST', '/api/interventions', { client_id: cid, type: 'naloxone_distribution', occurred_at: new Date().toISOString(), duration_minutes: 5, naloxone_kits: 2 });
  await go(page, 'supplies');
  const after = Number((await page.$eval('[data-qty="Naloxone kit"]', e => e.textContent)).replace(/,/g, ''));
  eq(after, before - 2, 'logging a visit with 2 kits takes 2 off the shelf count');
  await page.click('button[aria-label="One more Naloxone kit"]'); await page.waitForTimeout(700);
  eq(Number((await page.$eval('[data-qty="Naloxone kit"]', e => e.textContent)).replace(/,/g, '')), before - 1, '+ adds one back');
  const ro = await session('afinance', 'Navigator2026!!');
  await go(ro.page, 'supplies');
  ok(/Naloxone kit/.test(await ro.page.textContent('.main')), 'finance can read the cupboard');
  ok(!(await ro.page.$('button:has-text("+ Add item")')), 'but cannot change it');
  await ro.close();
}

// profile: the notification toggle exists and is off by default
{
  const { page } = nav;
  await go(page, 'profile');
  const box = await page.$('[data-notify-due]');
  ok(box, 'Profile has the reminder-notification toggle', box ? '' : (await page.textContent('.main')).slice(0, 200));
  if (box) eq(await box.isChecked(), false, 'off by default');
}

// ---------------- 2. offline ----------------
{
  const { page, ctx } = nav;
  const cid = (await nav.api('GET', '/api/clients?limit=1')).data.clients[0].id;
  await go(page, `client/${cid}`);
  await page.click('button:has-text("+ Task")'); await page.waitForSelector('.modal input[name=title]');
  await page.fill('.modal input[name=title]', 'Typed while the signal dropped');
  await ctx.setOffline(true);
  await page.click('.modal button[type=submit]');
  const msg = await until(async () => { const el = await page.$('.modal .banner.danger:not(.hidden)'); return el ? el.textContent() : ''; });
  ok(/appear to be offline/.test(msg), 'saving without a connection says so in plain words', msg);
  ok(await page.$('.modal input[name=title]'), 'and the dialog stays open');
  eq(await page.$eval('.modal input[name=title]', i => i.value), 'Typed while the signal dropped', 'with what was typed still in it');
  const bannerEl = await page.$('#banners [data-banner="offline"]');
  ok(bannerEl, 'a persistent offline banner appears at the top');
  ok(bannerEl && /on this device/.test(await bannerEl.textContent()) && await bannerEl.$('a[href="get-app.html"]'), 'pointing at the use-on-this-device page');
  await ctx.setOffline(false);
  await page.click('.modal button[type=submit]');
  ok(await until(async () => !(await page.$('#banners [data-banner="offline"]'))), 'the banner goes away once a request gets through');
  await until(async () => !(await page.$('.modal-bg')));
  // reload while offline: the cached shell shows the banner on the sign-in screen instead of a silent bounce
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const offBanner = await page.$('#banners [data-banner="offline"]');
  const shell = await page.$('input[name=username], .layout');
  ok(offBanner, 'reloading while offline still shows the offline banner', await page.evaluate(() => document.body.innerText.slice(0, 120)));
  ok(shell, 'over a real screen rather than nothing');
  await ctx.setOffline(false);
}

// ---------------- phone: compact rows, inert drawer, tap targets, FAB ----------------
{
  const phone = await session('mrivera', 'Navigator2026!!', { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  const { page } = phone;
  await go(page, 'clients');
  ok(await page.$eval('.compact-list', l => getComputedStyle(l).display !== 'none'), 'the client list is a compact two-line list on a phone');
  ok(await page.$eval('.has-compact table', t => getComputedStyle(t).display === 'none'), 'and the full table is not drawn');
  const row = await page.$('.compact-row');
  const rb = row ? await row.boundingBox() : null;
  ok(rb && rb.height < 90, 'each row is two lines, not a stack of labels', rb && rb.height);
  ok(await page.$('.compact-row .badge'), 'with a risk badge on the first line');
  if (row) { await row.click(); await page.waitForURL(/#\/client\//, { timeout: 5000 }).catch(() => {}); ok(/#\/client\//.test(page.url()), 'tapping a row opens the client'); }
  await go(page, 'tasks');
  ok(await page.$eval('.compact-list', l => getComputedStyle(l).display !== 'none'), 'the to-do list is compact too');
  await go(page, 'calls');
  ok(await page.$eval('.compact-list', l => getComputedStyle(l).display !== 'none'), 'and Calls & texts');

  // 8. the closed drawer is inert; opening it makes it live
  eq(await page.$eval('#sidebar', s => s.inert), true, 'the closed drawer is inert');
  eq(await page.$eval('#sidebar', s => s.getAttribute('aria-hidden')), 'true', 'and hidden from assistive tech');
  await page.click('button[aria-label=Menu]'); await page.waitForTimeout(300);
  eq(await page.$eval('#sidebar', s => s.inert), false, 'opening the menu makes it live');
  eq(await page.$eval('#sidebar', s => s.getAttribute('aria-hidden')), null, 'and visible to assistive tech');
  eq(await page.$eval('.fab', f => getComputedStyle(f).display), 'none', 'the + Log button hides while the drawer is open');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  eq(await page.$eval('#sidebar', s => s.inert), true, 'Escape closes it and it is inert again');
  // tap targets
  await go(page, 'tasks');
  const editBtn = await page.$('tbody .btn.sm');
  await page.evaluate(() => { document.querySelector('.has-compact table').style.display = 'table'; });
  const eb = editBtn ? await editBtn.boundingBox() : null;
  ok(eb && eb.height >= 44, 'Edit buttons are at least 44px tall on a touch screen', eb && eb.height);
  const chip = await page.$('.filters .btn');
  const cb = chip ? await chip.boundingBox() : null;
  ok(cb && cb.height >= 44, 'filter chips too', cb && cb.height);
  const helpB = await page.$('.help-btn'); const hb = helpB ? await helpB.boundingBox() : null;
  ok(hb && hb.height >= 44 && hb.width >= 44, 'and the ? help button', hb && [hb.width, hb.height]);
  // FAB and toasts clear each other; nothing overlaps the bottom card on Home
  await go(page, 'dashboard');
  const fab = await page.$eval('.fab', f => f.getBoundingClientRect().bottom);
  const toastsBottom = await page.$eval('.toasts', t => window.innerHeight - t.getBoundingClientRect().bottom);
  ok(toastsBottom > 60, 'toasts sit above the floating button', toastsBottom);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  const lastCard = await page.$eval('.main > :last-child', el => el.getBoundingClientRect().bottom);
  const fabTop = await page.$eval('.fab', f => f.getBoundingClientRect().top);
  ok(lastCard <= fabTop + 1, 'scrolled to the end, the last card clears the floating button', [lastCard, fabTop]);
  void fab;
  await phone.close();
}

// contrast: the warn text is readable on its badge and on a card, in both themes
{
  const { page } = nav;
  const lum = (rgb) => { const c = rgb.match(/\d+/g).slice(0, 3).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const c = await page.evaluate(() => { const s = getComputedStyle(document.documentElement); const el = document.createElement('span'); el.className = 'badge warn'; document.body.append(el); const cs = getComputedStyle(el); const out = { fg: cs.color, bg: cs.backgroundColor, panel: s.getPropertyValue('--panel').trim() }; el.remove(); return out; });
    ok(ratio(c.fg, c.bg) >= 4.5, `${theme}: warn badge text has at least 4.5:1 contrast`, ratio(c.fg, c.bg).toFixed(2));
    const panelRgb = await page.evaluate((hex) => { const el = document.createElement('div'); el.style.color = hex; document.body.append(el); const v = getComputedStyle(el).color; el.remove(); return v; }, c.panel);
    ok(ratio(c.fg, panelRgb) >= 4.5, `${theme}: warn text on a card has at least 4.5:1 contrast`, ratio(c.fg, panelRgb).toFixed(2));
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}

await nav.close();
await browser.close();
if (errors.length) { console.log('ERRORS:'); errors.forEach(e => console.log('  ' + e)); } else console.log('NO ERRORS');
finish(errors);

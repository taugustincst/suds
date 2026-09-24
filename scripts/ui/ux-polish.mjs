// The phone review of the static (demo) build, replayed with real taps on a Pixel-7-sized touch screen:
//   H2 the demo banner covered the top of every dialog (title and ✕ hidden), worst at 200% text
//   H3 a referral started from a provider's page never loaded the chosen client's consents
//   M1 "Load sample data" on Home went to another page instead of loading it
//   M2 the demo promised a sync it never does ("both directions", "shows up on the other", pending counts)
//   M3 nothing said what SUDS is; no one-step "try it with sample data"
//   M5 tap targets under 44px (to-do boxes, chart rows); the + Log button over an open menu
//   M6 200% text: forms wider than the screen, top bar and buttons not scaling
//   and the smaller ones: Back closes a dialog, not the page; "Done" on the last tour step; labels;
//   badge contrast; required-field wording; the provider page's top bar; get-app.html's manifest; greeting.
// Screenshots go to $SHOTS (default /tmp/suds-ux-polish) so a person can look at them.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';
const base = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8877';
const SHOTS = process.env.SHOTS || '/tmp/suds-ux-polish';
fs.mkdirSync(SHOTS, { recursive: true });
const { ok, eq, finish } = makeChecks('ux-polish');
const browser = await chromium.launch();
const PIXEL7 = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' };
const errors = [];
const watch = (page, label) => {
  page.on('pageerror', e => errors.push(`${label}: PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(`${label}: CONSOLE ${m.text().slice(0, 250)}`); });
};
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
// A hash-only goto does not reload the page, so the large-text style is taken off again explicitly.
const bigText = (page) => page.evaluate(() => { if (document.getElementById('big-text')) return; const s = document.createElement('style'); s.id = 'big-text'; s.textContent = 'html { font-size: 200% !important; }'; document.head.append(s); });
const normalText = (page) => page.evaluate(() => document.getElementById('big-text')?.remove());
const go = async (page, hash) => { await normalText(page).catch(() => {}); await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.layout', { timeout: 15000 }); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 15000 }).catch(() => {}); await settle(page); };
const kernel = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await window.SUDS_LOCAL.handle(method, path, body, { 'X-Requested-With': 'suds' }); const data = r.json !== undefined ? r.json : (r.body ? JSON.parse(r.body.toString()) : null); return { status: r.status, data }; }, { method, path, body });
// Where the dialog's title and ✕ are, against the bottom of the demo banner.
const dialogTop = (page) => page.evaluate(() => {
  const b = document.querySelector('.static-demo-banner').getBoundingClientRect();
  const x = document.querySelector('.modal button[aria-label=Close]'); const t = document.querySelector('.modal h2');
  const xr = x ? x.getBoundingClientRect() : null; const tr = t ? t.getBoundingClientRect() : null;
  // The banner lets taps through (pointer-events: none), so hit-testing cannot see it: compare boxes.
  return { banner: b.bottom, close: xr && xr.top, title: tr && tr.top, closeHit: xr ? document.elementFromPoint(xr.x + xr.width / 2, xr.y + xr.height / 2) === x : false };
});
// Every control that sticks out past the right edge of the screen (a table that scrolls in its own box is fine).
const overflowing = (page) => page.evaluate(() => {
  const W = document.documentElement.clientWidth;
  return [...document.querySelectorAll('.main input, .main select, .main textarea, .main .btn, .modal input, .modal select, .modal textarea, .modal .btn, .mobilebar .btn, .card, .field')]
    .filter(el => el.offsetParent !== null && !el.closest('.table-wrap, .tabs, .tabs-menu, .file-btn'))
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width && r.right > W + 1)
    .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}[${(el.textContent || el.name || '').trim().slice(0, 20)}] right=${Math.round(r.right)}`);
});

// ---------------- first run on the demo site ----------------
const ctx = await browser.newContext(PIXEL7);
const page = await ctx.newPage(); watch(page, 'demo');
await page.goto(base + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 15000 });
await shot(page, 'setup');
eq(await page.$eval('[data-purpose]', p => p.textContent), 'Track services, referrals and follow-ups for people in substance-use-disorder care.', 'M3: the first screen says what SUDS is');
const setupText = await page.textContent('.login-wrap');
ok(!/both directions|tap Sync/i.test(setupText), 'M2: first-run setup on the demo does not promise a sync with the office');
ok(/stays in this browser/.test(setupText) && /office SUDS address/.test(setupText), 'M2: it says the demo stays in this browser, and where to use SUDS for real');
ok(await page.$('[data-try-sample]'), 'M3: the demo offers "Try it with sample data"');
await page.tap('[data-try-sample]');
await page.waitForSelector('.layout', { timeout: 30000 });
await settle(page);

// the tour
const tour = await until(() => page.$('.modal'), { timeout: 5000 });
ok(tour, 'the welcome tour opens for the new demo account');
const step1 = tour ? await page.textContent('.modal') : '';
ok(!/shows up on the other right away/.test(step1), 'M2: the tour does not promise that entries appear on other devices in the demo', step1.slice(0, 200));
ok(/stays in this browser/.test(step1), 'M2: the tour says the demo stays in this browser');
ok(/^Hi Demo\./.test(step1.replace(/^Welcome to SUDS/, '').trim()), 'the tour greets "Demo User" as Demo', step1.slice(0, 60));
let labels = [];
for (let i = 0; i < 8; i++) { const b = await page.$('.modal button.primary'); if (!b) break; labels.push((await b.textContent()).trim()); if (labels.at(-1) === 'Done') { await shot(page, 'tour-last-step'); } await b.tap(); await settle(page); }
eq(labels.at(-1), 'Done', 'the last tour step\'s button says Done');
ok(labels.slice(0, -1).every(l => l === 'Next'), 'the steps before it say Next', labels);
ok(!(await page.$('.modal-bg')), 'Done closes the tour');

const h1 = (await page.textContent('h1')).trim();
ok(/^Good (morning|afternoon|evening), Demo$/.test(h1), 'the greeting uses the first name', h1);
const clients = await kernel(page, 'GET', '/api/clients?limit=100&status=all');
ok(clients.data.clients.length > 5, 'M3: one tap created the account and loaded the sample data', clients.data.clients.length);

// ---------------- H2: dialogs clear of the banner, at normal and at 200% text ----------------
await page.tap('.fab button'); await page.waitForSelector('.modal');
let top = await dialogTop(page);
await shot(page, 'log-sheet');
ok(top.close >= top.banner - 0.5 && top.title >= top.banner - 0.5, 'H2: the + Log sheet\'s title and ✕ start below the demo banner', top);
ok(top.closeHit, 'H2: and a tap on the ✕ lands on it');
await page.tap('.modal button[aria-label=Close]');
ok(await until(async () => !(await page.$('.modal-bg')), { timeout: 3000 }), 'H2: tapping the ✕ closes the sheet');
await go(page, 'dashboard');
await bigText(page); await settle(page);
await page.tap('.fab button'); await page.waitForSelector('.modal');
top = await dialogTop(page);
await shot(page, 'log-sheet-200');
ok(top.banner > 100, 'at 200% text the banner is tall (the case the review measured)', top.banner);
ok(top.close >= top.banner - 0.5 && top.title >= top.banner - 0.5, 'H2: at 200% text the title and ✕ still start below the banner', top);
eq((await overflowing(page)).join(' | '), '', 'M6: nothing in the + Log sheet is wider than the screen at 200% text');

// ---------------- Back closes the dialog, not the page ----------------
const before = page.url();
await page.goBack(); await settle(page);
ok(!(await page.$('.modal-bg')), 'Back closes the open dialog');
eq(page.url(), before, 'and stays on the page underneath');
ok(await page.$('.layout'), 'with the app still there');
await go(page, 'clients');
const clientsUrl = page.url();
await page.tap('.fab button'); await page.waitForSelector('.modal');
await page.tap('.modal .quick-list button:has-text("Reminder")');
await page.waitForSelector('.modal input[name=title]');
await page.goBack(); await settle(page);
ok(!(await page.$('.modal-bg')), 'Back closes a form opened from the + Log sheet');
eq(page.url(), clientsUrl, 'and leaves the client list where it was');
// A dialog closed with its ✕ takes its history entry with it: the next Back leaves the page as usual.
await page.tap('.fab button'); await page.waitForSelector('.modal');
await page.tap('.modal button[aria-label=Close]'); await settle(page);
await page.goBack(); await settle(page);
ok(!/#\/clients/.test(page.url()), 'after closing a dialog with ✕, Back goes to the previous page (no dead press)', page.url().split('#')[1]);

// ---------------- Independent verification round: build stamp on a phone, overdue rows at 200% text ----------------
{
  // An overdue reminder for today's list, so the row with the badge and the date exists.
  const y = new Date(Date.now() - 86400000); const ymd = y.toISOString().slice(0, 10);
  await kernel(page, 'POST', '/api/tasks', { title: 'Overdue check for the phone layout', due_at: ymd });
  await go(page, 'dashboard');
  const stamp = await page.evaluate(() => { const e = document.querySelector('.mobilebar [data-build-stamp]'); if (!e) return null; const r = e.getBoundingClientRect(); return { text: e.textContent, onScreen: r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; });
  ok(stamp && /^SUDS \d+\.\d+\.\d+$/.test(stamp.text) && stamp.onScreen, 'signed in on a phone, the build stamp is on screen in the top bar without opening anything', stamp);
  await bigText(page); await settle(page);
  const cut = await page.evaluate(() => [...document.querySelectorAll('.today-item .today-due')].map(e => e.getBoundingClientRect()).filter(r => r.right > innerWidth + 0.5).length);
  eq(cut, 0, "at 200% text, Home's overdue badge and due date wrap inside the card instead of running off the screen");
}
// ---------------- M6: 200% text on the main screens ----------------
const cid = clients.data.clients[0].id;
for (const hash of ['dashboard', 'clients', `client/${cid}`, 'tasks', 'referrals', 'sync', 'resources']) {
  await go(page, hash); await bigText(page); await settle(page);
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  ok(w[0] <= w[1], `M6: #/${hash} does not scroll sideways at 200% text`, w);
  eq((await overflowing(page)).join(' | '), '', `M6: nothing on #/${hash} sticks out past the right edge at 200% text`);
  // Viewport only: a full-page screenshot resizes the emulated screen and Chromium drops the touch (pointer: coarse) emulation.
  await page.screenshot({ path: `${SHOTS}/200-${hash.replace(/\//g, '-')}.png` });
}
await go(page, 'clients'); await bigText(page);
eq(await page.evaluate(() => getComputedStyle(document.body).fontSize), '28px', 'M6: body text follows the root size (rem), so 200% text reaches it');
ok(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.mobilebar .btn')).fontSize) >= 36), 'M6: the top bar\'s buttons scale with the text size');
await page.tap('button:has-text("New client")'); await page.waitForSelector('.modal input[name=first_name]');
eq((await overflowing(page)).join(' | '), '', 'M6: the New client form fits the screen at 200% text');
await shot(page, 'new-client-200');
// required-field wording
await page.tap('.modal button[type=submit]');
const err = await until(async () => { const t = await page.$eval('.modal [data-field=first_name] .err', e => e.textContent).catch(() => ''); return t || null; }, { timeout: 4000 });
eq(err, 'First name is required', 'the required-field error names the field');
await page.tap('.modal button[aria-label=Close]'); await settle(page);

// ---------------- M2: the demo's Sync page ----------------
await go(page, 'sync');
const syncText = await page.textContent('.main');
ok(!/Changes waiting to send|Office server/.test(syncText), 'M2: the demo\'s Sync page shows no pending-change count or office server', syncText.slice(0, 200));
ok(await page.$('[data-static-status]') && /stays in this browser/.test(syncText), 'M2: it says the demo stays in this browser');
ok(/office SUDS address/.test(syncText), 'M2: and where to use SUDS for real');
await shot(page, 'sync-demo');

// ---------------- M5: tap targets ----------------
await go(page, 'tasks?mine=0');
const box = await page.evaluate(() => { const l = [...document.querySelectorAll('.compact-row .tap-target')].find(x => x.offsetParent); if (!l) return null; const r = l.getBoundingClientRect(); return { w: r.width, h: r.height }; });
ok(box && box.w >= 44 && box.h >= 44, 'M5: a to-do\'s "mark done" box is a 44px target on a phone', box);
if (box) {
  // A tap at the edge of the target, outside the 24px box itself, ticks it off rather than opening the to-do.
  const edge = await page.evaluate(() => { const l = [...document.querySelectorAll('.compact-row .tap-target')].find(x => x.offsetParent); const r = l.getBoundingClientRect(); const i = l.querySelector('input').getBoundingClientRect(); return { x: r.left + 3, y: r.top + r.height / 2, inside: r.left + 3 >= i.left }; });
  ok(!edge.inside, 'the edge of the target is outside the box itself');
  await page.touchscreen.tap(edge.x, edge.y);
  ok(await until(async () => (await page.textContent('#toasts')).includes('Marked done'), { timeout: 4000 }), 'M5: a tap near (not on) the box marks the to-do done');
  ok(!(await page.$('.modal-bg')), 'and does not open the to-do instead');
}
await go(page, 'dashboard');
const bars = await page.$$eval('a.bar.link', a => a.map(x => x.getBoundingClientRect().height));
ok(bars.length && bars.every(hh => hh >= 44), 'M5: the Home chart rows are 44px tap targets', bars);
const today = await page.$$eval('.today-item .check', a => a.map(x => x.getBoundingClientRect().height));
ok(today.every(hh => hh >= 44), 'M5: Home\'s to-do rows are 44px tap targets', today);
await go(page, `client/${cid}`); await bigText(page); await settle(page);
const more = await page.$('.tabs-more:visible');
if (more) {
  await more.tap(); await settle(page);
  ok(await page.$eval('.fab', f => getComputedStyle(f).display === 'none'), 'M5: the + Log button steps aside while the tab menu is open');
  await shot(page, 'client-more-menu-200');
  await more.tap();
} else ok(false, 'the client page has a More tab menu at 200% text');
const fab = await page.$eval('.fab .btn', b => b.getBoundingClientRect().height);
ok(fab <= 64, 'M5: the + Log button stays compact at 200% text', fab);

// ---------------- provider page ----------------
const res = (await kernel(page, 'GET', '/api/resources?limit=5')).data.rows[0];
await go(page, `resource/${res.id}`);
eq((await page.textContent('.mobilebar-title > b')).trim(), res.name, 'the phone top bar names the provider, not "SUDS"');
await kernel(page, 'PUT', `/api/resources/${res.id}`, { summary: '' });
await go(page, `resource/${res.id}`);
ok(/Tap or click Edit/.test(await page.textContent('.main')), 'the empty summary says "Tap or click Edit"');

// ---------------- H3: a referral started from the provider page ----------------
const withConsent = [];
for (const c of clients.data.clients) {
  const cs = (await kernel(page, 'GET', `/api/clients/${c.id}/consents`)).data.consents.filter(x => !x.revoked_at && (!x.expires_at || x.expires_at >= new Date().toISOString().slice(0, 10)));
  if (cs.length) { withConsent.push({ c, cs }); break; }
}
ok(withConsent.length, 'the sample data has a client with a valid Part 2 consent');
if (withConsent.length) {
  const { c } = withConsent[0];
  await page.tap('button:has-text("+ Refer a client")'); await page.waitForSelector('.modal .client-picker input[type=text]');
  ok(/Choose the client first/.test(await page.textContent('.modal [data-consent-help]')), 'before a client is chosen, the consent list says to choose one');
  await page.tap('.modal .client-picker input[type=text]');
  await page.fill('.modal .client-picker input[type=text]', c.last_name || c.display_name.split(' ').pop());
  const opt = await until(() => page.$(`.modal .client-picker-list .list-item:has-text("${c.client_code}")`), { timeout: 6000 });
  ok(opt, 'the client picker finds the client');
  if (opt) await opt.tap();
  const n = await until(async () => { const k = await page.$$eval('.modal select[name=consent_id] option', o => o.filter(x => x.value).length); return k || null; }, { timeout: 5000 });
  ok(n >= 1, 'H3: choosing the client loads their consents into the list', n);
  const help = await page.textContent('.modal [data-consent-help]');
  ok(!/Choose the client first/.test(help), 'H3: and the help text is about their consents now', help);
  // Warm handoff with no consent chosen: refused, with the advice once.
  await page.tap('.modal label.check:has-text("Warm handoff")');
  await page.tap('.modal button[type=submit]');
  const banner = await until(async () => { const b = await page.$('.modal .banner.danger:not(.hidden)'); return b ? b.textContent() : null; }, { timeout: 5000 });
  ok(banner && /Choose the client's consent/.test(banner), 'H3: without a consent chosen, it says to choose the consent on file (not to record one that exists)', banner);
  ok(banner && (banner.match(/lawful basis/g) || []).length === 1, 'H3: the advice is given once, not twice', banner);
  await shot(page, 'referral-consent');
  await page.selectOption('.modal select[name=consent_id]', { index: 1 });
  await page.tap('.modal button[type=submit]');
  ok(await until(async () => !(await page.$('.modal-bg')), { timeout: 6000 }), 'H3: with the consent chosen the referral saves');
}

// ---------------- labels, colours, greetings ----------------
const unit = await page.evaluate(async () => {
  const m = await import('./app.js');
  return { part2: m.fmt.label('part2_disclosure'), narrative: m.fmt.label('narrative'), soap: m.fmt.label('SOAP'), intake: m.fmt.label('intake'), safety: m.fmt.label('safety_plan'),
    g: ['Kiran Patel', 'Dr. Patel', 'Dr Kiran Patel', 'QATEST', 'Mary-Jo Baker', 'dr. kiran patel'].map(n => m.greetingName(n)), fb: m.greetingName('  ', 'jdoe') };
});
eq(unit.part2, 'Part 2 disclosure', 'consent type part2_disclosure reads "Part 2 disclosure"');
eq([unit.narrative, unit.soap, unit.intake, unit.safety].join(','), 'Narrative,SOAP,Intake,Safety Plan', 'note formats are Title Case with acronyms kept');
eq(unit.g.join(','), 'Kiran,Dr. Patel,Dr. Patel,QATEST,Mary-Jo,dr. patel', 'greetings: given name; honorific + surname; one word as typed; never re-cased');
eq(unit.fb, 'jdoe', 'a blank name greets by username');
const contrast = async (theme) => page.evaluate((theme) => {
  document.documentElement.dataset.theme = theme;
  const probe = (cls, text) => { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = text; document.body.append(b); const s = getComputedStyle(b); const out = [s.color, s.backgroundColor, s.fontSize]; b.remove(); return out; };
  const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = ([fg, bg]) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  return ['ok', 'warn', 'danger', 'info', 'purple'].map(k => [k, Math.round(ratio(probe(k, 'Active')) * 100) / 100]);
}, theme);
for (const theme of ['light', 'dark']) for (const [k, r] of await contrast(theme)) ok(r >= 4.5, `badge ${k} text is at least 4.5:1 in the ${theme} theme`, r);
await page.evaluate(() => { delete document.documentElement.dataset.theme; });
ok(await page.evaluate(() => { const s = document.createElement('div'); s.className = 'stat'; s.innerHTML = '<div class="v">$1,234.56</div>'; document.querySelector('.main').append(s); const w = getComputedStyle(s.firstChild).whiteSpace; s.remove(); return w === 'nowrap'; }), 'money in a stat card never wraps mid-number');

// ---------------- get-app.html installs the app ----------------
await page.goto(base + '/get-app.html'); await page.waitForSelector('#static-url');
const man = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); if (!l) return null; const r = await fetch(l.href); const j = await r.json(); return { start: new URL(j.start_url, l.href).href, here: location.href }; });
ok(man, 'get-app.html links a manifest');
ok(man && !/get-app/.test(man.start) && man.start === new URL('./', man.here).href, '"Install app" from that page installs SUDS, not the instructions page', man);
ok(await page.$('a[data-open-suds]'), 'and it has an Open SUDS button');
await ctx.close();

// ---------------- M1: Load sample data from Home, on a fresh demo ----------------
{
  const c2 = await browser.newContext(PIXEL7); const p = await c2.newPage(); watch(p, 'fresh');
  await p.goto(base + '/'); await p.waitForSelector('input[name=display_name]', { timeout: 15000 });
  await p.fill('input[name=display_name]', 'Kiran Patel'); await p.fill('input[name=username]', 'kpatel');
  await p.fill('input[name=password]', 'Navigator2026!!'); await p.fill('input[name=confirm]', 'Navigator2026!!');
  await p.tap('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 15000 }); await settle(p);
  for (let i = 0; i < 6; i++) { const b = await p.$('.modal button.primary'); if (!b) break; await b.tap(); await settle(p); }
  ok(/, Kiran$/.test((await p.textContent('h1')).trim()), '"Kiran Patel" is greeted as Kiran');
  const btn = await until(() => p.$('[data-sample-banner] [data-load-sample]'), { timeout: 5000 });
  ok(btn, 'M1: Home offers to load sample data with a button');
  if (btn) {
    await btn.tap(); await p.waitForSelector('.modal');
    await shot(p, 'home-load-sample-confirm');
    await p.tap('.modal button.primary');
    ok(await until(async () => !(await p.$('[data-sample-banner]')) && /#\/dashboard/.test(p.url()), { timeout: 20000 }), 'M1: it loads right there and Home refreshes without the offer', p.url());
    ok(!/#\/sync/.test(p.url()), 'M1: and never goes to the Sync page');
    ok(Number((await p.textContent('.stat .v')).replace(/\D/g, '')) > 0, 'M1: Home now counts the sample clients');
  }
  await c2.close();
}

await browser.close();
if (!finish(errors)) process.exitCode = 1;

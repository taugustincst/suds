// The load review's four fixes, checked in a real browser:
//  1. the client list filters on the server: the Home tile's number is the list's number, and "Load more"
//     reaches every match (the list used to filter its first 200 rows); the waitlist pages too;
//  2. a save from a stale copy is refused with the "changed by someone else" message and a Reload button,
//     and the client form sends only the fields that changed;
//  3. a save retried after the connection dropped (the server did the work, the answer never arrived) is
//     answered from the first attempt: same Idempotency-Key, one record;
//  4. a returning client discharged from someone else's caseload is offered for re-admission at intake,
//     and the re-admission reaches the supervisors' review queue.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, finish } = makeChecks('load-review');
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
const rowCount = (page) => page.$$eval('.main [data-paged-list] table tbody tr', rs => rs.length);

const admin = await session('admin', 'AdminPassw0rd!x');

// ---------------- 1. server-side filters and "Load more" ----------------
{
  const { page, api } = admin;
  // More high-risk active clients and more waiting clients than one page holds.
  // One spreadsheet-import commit rather than 445 separate POSTs, which would hit the per-address API limit.
  const records = [
    ...Array.from({ length: 230 }, (_, i) => ({ first_name: `Load${i}`, last_name: `Reviewactive${i}`, status: 'active', risk_level: i % 2 ? 'high' : 'critical' })),
    ...Array.from({ length: 215 }, (_, i) => ({ first_name: `Load${i}`, last_name: `Reviewwaiting${i}`, status: 'waitlist', risk_level: 'moderate' })),
  ];
  const made = (await api('POST', '/api/imports/data/commit', { entity: 'clients', records })).data.created;
  eq(made, 445, 'created 230 high-risk clients and 215 waiting ones');
  const dash = (await api('GET', '/api/reports/dashboard')).data;
  ok(dash.clients.high_risk > 230, 'the Home tile counts more high-risk clients than one page', dash.clients.high_risk);

  await go(page, 'dashboard');
  const tile = await page.$('a[href="#/clients?status=active&risk=high"]');
  ok(tile, 'the High-risk tile links to the filtered client list');
  if (tile) { await tile.click(); await page.waitForFunction(() => location.hash.startsWith('#/clients'), null, { timeout: 5000 }); await settle(page); }
  const total = Number(await page.getAttribute('[data-client-total]', 'data-client-total').catch(() => 'NaN'));
  eq(total, dash.clients.high_risk, 'the list header shows the same number as the tile (not a count of the first page)');
  eq(await rowCount(page), 200, 'the first page shows 200 rows');
  ok(await page.$('button[data-load-more]'), 'with a "Load more" button');
  await page.click('button[data-load-more]');
  await until(async () => (await rowCount(page)) === total, { timeout: 10000 });
  eq(await rowCount(page), total, 'after "Load more" every high-risk client is listed');
  ok(!(await page.$('button[data-load-more]')), 'and the button goes away when there is nothing left');
  const risks = await page.$$eval('.main [data-paged-list] table tbody tr td:nth-child(3)', tds => [...new Set(tds.map(t => t.textContent.trim()))]);
  ok(risks.every(r => /high|critical/i.test(r)), 'every row is high or critical risk', risks);

  // The waitlist no longer stops at a fixed number.
  const waiting = (await api('GET', '/api/waitlist?limit=1')).data.total;
  ok(waiting > 215, 'the waitlist holds more than one page', waiting);
  await go(page, 'waitlist');
  eq(await rowCount(page), 200, 'the waitlist shows its first 200');
  await page.click('button[data-load-more]');
  await until(async () => (await rowCount(page)) === waiting, { timeout: 10000 });
  eq(await rowCount(page), waiting, 'and "Load more" shows everyone waiting');
}

// ---------------- 2. a save from a stale copy ----------------
{
  const sup = await session('jwalker', PW);
  const { page, api } = sup;
  const id = (await api('POST', '/api/clients', { first_name: 'Stale', last_name: 'Copy', no_episode: true })).data.id;
  await go(page, `client/${id}`);
  await page.click('.main button:has-text("Edit")');
  await page.waitForSelector('.modal input[name=city]');
  // Someone else saves the record while the form is open.
  eq((await admin.api('PUT', `/api/clients/${id}`, { insurance: 'medicaid' })).status, 200, 'another person saves the record meanwhile');
  const bodies = [];
  page.on('request', r => { if (r.method() === 'PUT' && r.url().includes(`/api/clients/${id}`)) bodies.push(r.postDataJSON()); });
  await page.fill('.modal input[name=city]', 'Springfield');
  await page.click('.modal button[type=submit]');
  const banner = await until(async () => { const t = await page.textContent('.modal .banner.danger').catch(() => ''); return /changed by someone else/.test(t || '') ? t : null; });
  ok(banner, 'the save is refused with the "changed by someone else" message', banner);
  ok(await page.$('.modal button[data-reload-stale]'), 'with a Reload button');
  eq(JSON.stringify(Object.keys(bodies[0] || {}).sort()), JSON.stringify(['city', 'if_updated_at']), 'the form sent only the field that changed, and the version it opened');
  let after = (await api('GET', `/api/clients/${id}`)).data.client;
  eq(after.city, null, 'nothing from the refused save was written');
  await page.click('.modal button[data-reload-stale]');
  await until(async () => !(await page.$('.modal-bg')));
  ok(!(await page.$('.modal-bg')), 'Reload closes the form and shows the current record');
  await settle(page);
  await page.click('.main button:has-text("Edit")');
  await page.waitForSelector('.modal input[name=city]');
  await page.fill('.modal input[name=city]', 'Springfield');
  await page.click('.modal button[type=submit]');
  await until(async () => !(await page.$('.modal-bg')));
  after = (await api('GET', `/api/clients/${id}`)).data.client;
  eq(after.city, 'Springfield', 'saving again from the fresh copy works');
  eq(after.insurance, 'medicaid', 'and the other person’s change is still there');
  await sup.close();
}

// ---------------- 3. a retried save after a dropped connection ----------------
{
  const nav = await session('mrivera', PW);
  const { page, api } = nav;
  await go(page, 'tasks');
  await page.click('.main button:has-text("+ Add a reminder")');
  await page.waitForSelector('.modal input[name=title]');
  const title = `Retry check ${Date.now()}`;
  await page.fill('.modal input[name=title]', title);
  const keys = [];
  let first = true;
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    if (first) { first = false; await route.fetch(); return route.abort('connectionreset'); } // the server did it; the answer is lost
    return route.continue();
  });
  await page.click('.modal button[type=submit]');
  const offline = await until(async () => { const t = await page.textContent('.modal .banner.danger').catch(() => ''); return /offline/i.test(t || '') ? t : null; });
  ok(offline, 'the lost answer shows as a dropped connection, with the form kept', offline);
  await page.click('.modal button[type=submit]');
  await until(async () => !(await page.$('.modal-bg')));
  ok(!(await page.$('.modal-bg')), 'pressing Save again completes');
  eq(keys.length, 2, 'two requests went out');
  ok(keys[0] && keys[0] === keys[1], 'both with the same Idempotency-Key', keys);
  const mine = (await api('GET', '/api/tasks?limit=500&status=all')).data.rows.filter(t => t.title === title);
  eq(mine.length, 1, 'and only one to-do exists');
  await page.unroute('**/api/tasks');
  // A different submission gets a different key.
  await page.click('.main button:has-text("+ Add a reminder")');
  await page.waitForSelector('.modal input[name=title]');
  await page.fill('.modal input[name=title]', title + ' (second)');
  const req = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/tasks'));
  await page.click('.modal button[type=submit]');
  const k3 = (await req).headers()['idempotency-key'];
  ok(k3 && k3 !== keys[0], 'a new submission carries a new key');
  await until(async () => !(await page.$('.modal-bg')));
  await nav.close();
}

// ---------------- 4. a returning client, discharged from someone else's caseload ----------------
{
  const a = await session('mrivera', PW);
  const who = { first_name: 'Evening', last_name: `Walkin${Date.now() % 100000}`, dob: '1981-07-09', phone: '555-303-4040' };
  const made = await a.api('POST', '/api/clients', { ...who, intake_date: '2020-01-15' });
  eq(made.status, 201, 'navigator A admitted them years ago');
  const ep = (await a.api('GET', `/api/clients/${made.data.id}/episodes`)).data.episodes[0];
  eq((await a.api('POST', `/api/episodes/${ep.id}/close`, { discharge_reason: 'lost_contact', closed_at: '2021-06-01' })).status, 200, 'and discharged them');
  await a.close();

  const b = await session('dchen', PW);
  const { page, api } = b;
  eq((await api('GET', `/api/clients?status=all&q=${who.last_name}`)).data.total, 0, 'navigator B cannot find them by search (caseload-scoped, unchanged)');
  await go(page, 'clients');
  await page.click('.main button:has-text("+ New client")');
  await page.waitForSelector('.modal input[name=first_name]');
  await page.fill('.modal input[name=first_name]', who.first_name);
  await page.fill('.modal input[name=last_name]', who.last_name);
  await page.fill('.modal input[name=dob]', who.dob);
  await page.locator('.modal input[name=dob]').dispatchEvent('change');
  const offer = await until(() => page.$('.modal [data-readmit-offer]'));
  ok(offer, 'the intake form says an earlier, discharged record exists');
  const offerText = offer ? await offer.textContent() : '';
  ok(/discharged/i.test(offerText) && !offerText.includes(who.phone), 'it shows the discharge, nothing from the stored record', offerText);
  await page.click('.modal button[data-readmit]');
  const reasonInput = await until(() => page.$('.modal-bg:last-child .modal input'));
  ok(reasonInput, 'a reason is asked for');
  await reasonInput.fill('Walked in this evening asking to restart');
  await page.click('.modal-bg:last-child .modal button:has-text("Re-admit")');
  await page.waitForFunction((id) => location.hash.startsWith(`#/client/${id}`), made.data.id, { timeout: 10000 }).catch(() => {});
  ok(page.url().includes(`#/client/${made.data.id}`), 're-admitting opens the client record', page.url());
  await settle(page);
  eq((await api('GET', `/api/clients/${made.data.id}`)).status, 200, 'which is now on their caseload');
  await b.close();

  const sup = await session('jwalker', PW);
  await go(sup.page, 'dashboard');
  ok(await sup.page.$('a[href="#/supervision?tab=breakglass"]'), 'the supervisor’s Home page flags something to review');
  await go(sup.page, 'supervision?tab=breakglass');
  const row = await until(() => sup.page.$('[data-readmission]'));
  ok(row, 'the re-admission is in the supervisors’ review queue');
  await sup.close();
}

await admin.close();
await browser.close();
finish(errors);

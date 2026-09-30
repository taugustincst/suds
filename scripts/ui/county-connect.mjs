// The county connection (docs/COUNTY-VIEW.md, "Connecting"), in the browser. One office server plays both sides, as
// county.mjs does: the county switches the connection on and issues this server's programme a connection token, and
// the same server, as the programme, connects to itself over HTTP, tests the connection and sends its county file.
//   1. County connections (#/county-connect): the switch and cadence; the county's administrator turns it on.
//   2. County view › Programmes: Issue token opens a dialog; the token is shown once, in a field that takes the
//      focus, with a Copy button that says what it did; closing gives the focus back; the token is never on the
//      page again.
//   3. Settlement outcomes: an administrator connects (address and token), Test connection says what the county
//      expects (a status that takes the focus), finance sends the period and sees the county's receipt and the
//      send log; finance cannot change the connection.
//   4. The county sees the file in its combined view; a read token (shown once) reads the same over the API.
//   5. axe (WCAG 2.1 A/AA) on the pages and dialogs at 1280, 390 and 320 px, and nothing scrolls sideways.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const require = createRequire(import.meta.url);
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('county-connect');
let axeSource = null;
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* reported below */ }
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const STRUCTURE = ['landmark-one-main', 'landmark-no-duplicate-main', 'landmark-unique', 'page-has-heading-one', 'heading-order', 'empty-heading', 'aria-dialog-name', 'empty-table-header'];

const today = new Date().toISOString().slice(0, 10);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const lq = (() => { let y = Number(today.slice(0, 4)); let q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) - 1; if (q < 0) { q = 3; y--; } const m1 = q * 3 + 1; return { from: `${y}-${String(m1).padStart(2, '0')}-01`, to: lastDay(y, m1 + 2) }; })();

const browser = await chromium.launch();
const errors = [];
function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0-9]|42[0-9]/.test(m.text())) errors.push(`${who} CONSOLE ${m.text().slice(0, 200)}`); });
}
async function signIn(user, pw, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage(); watch(page, user);
  await page.goto(base + '/#/login'); await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true, first_day_skip: true }) })); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  return { ctx, page };
}
const api = (page, method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, [method, p, body]);
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
const toast = (page, re) => until(async () => { const t = await page.$$eval('.toast', e => e.map(x => x.textContent)); return t.find(x => re.test(x)) || null; });
async function axe(page, where) {
  if (!axeSource) { fail(`${where}: axe-core is not installed (npm i --no-save playwright axe-core)`); return; }
  await page.evaluate(axeSource + ';0').catch(() => {});
  const v = await page.evaluate(async ({ tags, extra }) => {
    const rules = [...new Set([...window.axe.getRules(tags).map(r => r.ruleId), ...extra])];
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  }, { tags: TAGS, extra: STRUCTURE });
  ok(v.length === 0, `${where}: no WCAG 2.1 A/AA violations`, v);
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const active = (page) => page.evaluate(() => { const a = document.activeElement; if (!a) return null; for (const k of ['data-cc-result', 'data-cc-issue-read']) if (a.hasAttribute(k)) return k; return a.id || a.tagName; });

try {
  const { ctx: admCtx, page: adm } = await signIn('admin', 'AdminPassw0rd!x');
  // This server's own county key, registered as a programme (as county.mjs does), so it can send to itself.
  const key = (await api(adm, 'POST', '/api/county-submission/key', {})).data.key;
  const prog = await api(adm, 'POST', '/api/county/programmes', { name: 'Our own programme', public_key: key.public_key });
  eq(prog.status, 201, 'the programme is registered with its own key');

  // ---------------- 1. the switch ----------------
  await go(adm, 'county-connect');
  eq((await adm.textContent('.main h1')).trim(), 'County connections', 'the County connections page opens');
  ok(/Off/.test(await adm.textContent('[data-cc-settings]')), 'the connection is off by default');
  eq((await api(adm, 'GET', '/api/county-connect/v1/status')).status, 404, 'and while off the endpoint does not exist');
  await axe(adm, 'County connections, off (1280)');
  await adm.check('[data-cc-settings] input[name=enabled]');
  await adm.click('[data-cc-settings] button[type=submit]');
  ok(await toast(adm, /Saved/), 'switching it on is saved');
  await settle(adm);
  ok(/On: accepting connections/.test(await adm.textContent('[data-cc-settings]')), 'and the page says it is on');

  // ---------------- 2. a connection token, shown once ----------------
  await go(adm, 'county?tab=programmes');
  ok(await adm.$('[data-cc-programmes-card]'), 'County view › Programmes has a Connection tokens card');
  await adm.focus(`[data-cc-issue="${prog.data.id}"]`); await adm.keyboard.press('Enter');
  await adm.waitForSelector('.modal-bg .modal');
  await axe(adm, 'Issue a connection token dialog (1280)');
  await adm.click('.modal button[type=submit]');
  await adm.waitForSelector('[data-cc-shown-once]');
  eq(await active(adm), 'cc-token-value', 'the token dialog opens with the focus on the token');
  const token = await adm.inputValue('[data-cc-token]');
  ok(/^sudscc_[A-Za-z0-9_-]{43}$/.test(token), 'the token is shown once, whole', token.slice(0, 12));
  await adm.click('[data-cc-copy]');
  const said = await until(async () => (await adm.textContent('[data-cc-copied]')).trim() || null);
  ok(/Copied|selected/.test(said || ''), 'Copy says what it did (in a status message)', said);
  eq(await adm.getAttribute('[data-cc-copied]', 'role'), 'status', 'the copy message is announced');
  await axe(adm, 'the token, shown once (1280)');
  await adm.click('[data-cc-done]');
  await until(async () => !(await adm.$('.modal-bg')));
  await settle(adm);
  ok(!(await adm.content()).includes(token), 'once closed, the token is nowhere on the page');
  ok((await adm.textContent('[data-cc-programmes]')).includes(token.slice(0, 12)), 'the card lists it by its first characters');

  // ---------------- 3. the programme's side ----------------
  const { ctx: finCtx, page: fin } = await signIn('afinance', PW);
  await go(fin, `settlement?from=${lq.from}&to=${lq.to}`);
  await until(() => fin.$('[data-cc-connection] p'));
  ok(await fin.$('[data-cc-send-card]'), 'Settlement outcomes has Send to the county over the connection for finance');
  ok(!(await fin.$('[data-cc-configure]')), 'finance cannot connect the server (an administrator does)');
  await go(adm, `settlement?from=${lq.from}&to=${lq.to}`);
  await adm.waitForSelector('[data-cc-configure]');
  await adm.click('[data-cc-configure]'); await adm.waitForSelector('.modal-bg .modal');
  await axe(adm, 'Connect to the county dialog (1280)');
  await adm.fill('.modal [name=base_url]', 'ftp://county.example');
  await adm.fill('.modal [name=token]', token);
  await adm.click('.modal button[type=submit]');
  const urlErr = await until(async () => adm.$eval('.modal [data-field=base_url] .err', e => e.textContent).catch(() => null));
  ok(/https/.test(urlErr || ''), 'an address that is not https is refused at the field', urlErr);
  await adm.fill('.modal [name=base_url]', base);
  await adm.click('.modal button[type=submit]');
  ok(await toast(adm, /Saved/), 'the connection is saved');
  await until(() => adm.$('[data-cc-url]'));
  ok(!(await adm.content()).includes(token), 'and the token is not shown again');
  await adm.click('[data-cc-test]');
  const tested = await until(async () => { const o = await adm.getAttribute('[data-cc-result]', 'data-cc-outcome'); return o ? { o, text: await adm.textContent('[data-cc-result]'), role: await adm.getAttribute('[data-cc-result]', 'role') } : null; });
  eq(tested && tested.o, 'ok', 'Test connection connects', tested && tested.text);
  ok(/Connected/.test(tested.text) && /Outstanding|Nothing outstanding/.test(tested.text), 'and says what the county expects', tested.text);
  eq(tested.role, 'status', 'as a status message');
  eq(await active(adm), 'data-cc-result', 'which takes the focus');
  await axe(adm, 'settlement, connected (1280)');
  await adm.click('[data-cc-disconnect]').catch(() => {}); // the confirmation, then keep it
  if (await adm.$('.modal-bg')) { await axe(adm, 'Disconnect confirmation (1280)'); await adm.keyboard.press('Escape'); }
  await until(async () => !(await adm.$('.modal-bg')));
  eq((await api(adm, 'GET', '/api/county-connect/connection')).data.connected, true, 'Escape on the confirmation keeps the connection');

  await fin.reload(); await settle(fin); // the same address as before: load it afresh, connected now
  ok(await until(() => fin.$('[data-cc-url]')), 'finance sees the connection');
  const finConn = await api(fin, 'GET', '/api/county-connect/connection');
  eq(finConn.data && finConn.data.can_send, true, 'finance may send', JSON.stringify(finConn.data).slice(0, 300));
  await fin.waitForSelector('[data-cc-send]');
  await fin.click('[data-cc-send]');
  const sent = await until(async () => { const o = await fin.getAttribute('[data-cc-result]', 'data-cc-outcome'); return o ? { o, text: await fin.textContent('[data-cc-result]') } : null; }, { timeout: 20000 });
  eq(sent && sent.o, 'ok', 'finance sends the period to the county', sent && sent.text);
  ok(/Sent\./.test(sent.text) && /receipt/.test(sent.text), 'and sees the county\'s receipt', sent.text);
  ok(await until(async () => /Imported/.test(await fin.textContent('[data-cc-send-card] table'))), 'the send log says the county imported it');
  await axe(fin, 'settlement with the send log (1280)');

  // ---------------- 4. the county sees it; a read token ----------------
  const view = await api(adm, 'GET', `/api/county/view?from=${lq.from}&to=${lq.to}`);
  const col = view.data.programmes.find(p => p.id === prog.data.id);
  eq(col && col.status, 'whole', 'the county\'s combined view counts the file for the period');
  await go(adm, 'county?tab=programmes');
  ok(/from/.test(await adm.textContent('[data-cc-programmes]')), 'the token\'s last use is shown with its address');
  await go(adm, 'county-connect');
  await adm.click('[data-cc-issue-read]'); await adm.waitForSelector('.modal-bg .modal');
  await axe(adm, 'Issue a read token dialog (1280)');
  await adm.fill('.modal [name=name]', 'County data warehouse');
  await adm.click('.modal button[type=submit]');
  await adm.waitForSelector('[data-cc-shown-once]');
  eq(await active(adm), 'cc-token-value', 'the read token dialog opens with the focus on the token');
  const readToken = await adm.inputValue('[data-cc-token]');
  await adm.keyboard.press('Escape');
  await until(async () => !(await adm.$('.modal-bg')));
  eq(await active(adm), 'data-cc-issue-read', 'closing gives the focus back to Issue a read token');
  const combined = await adm.evaluate(async ([t, f, to]) => { const r = await fetch(`/api/county-connect/v1/combined?from=${f}&to=${to}`, { headers: { Authorization: `Bearer ${t}` }, credentials: 'omit' }); return { status: r.status, data: await r.json() }; }, [readToken, lq.from, lq.to]);
  eq(combined.status, 200, 'the read token reads the combined view');
  ok(combined.data.notes && combined.data.notes.unduplicated === false, 'with its notes: not unduplicated, exact, internal');
  const pushWithRead = await adm.evaluate(async (t) => (await fetch('/api/county-connect/v1/status', { headers: { Authorization: `Bearer ${t}` }, credentials: 'omit' })).status, readToken);
  eq(pushWithRead, 403, 'and cannot act as a programme');
  await settle(adm);
  ok((await adm.textContent('[data-cc-read]')).includes('County data warehouse'), 'the read token is listed by name');
  await axe(adm, 'County connections, on, with tokens (1280)');

  // ---------------- 5. phone widths ----------------
  for (const width of [390, 320]) {
    const { ctx, page } = await signIn('admin', 'AdminPassw0rd!x', { width, height: 844 });
    for (const hash of ['county-connect', 'county?tab=programmes', `settlement?from=${lq.from}&to=${lq.to}`]) {
      await go(page, hash); if (hash.startsWith('settlement')) await until(() => page.$('[data-cc-url]'));
      await axe(page, `${hash.split('?')[0]} (${width})`); ok(await noSideScroll(page), `${hash.split('?')[0]}: nothing scrolls sideways at ${width} px`);
    }
    await go(page, 'county-connect'); await page.click('[data-cc-issue-read]'); await page.waitForSelector('.modal-bg .modal');
    await page.fill('.modal [name=name]', `Phone ${width}`); await page.click('.modal button[type=submit]'); await page.waitForSelector('[data-cc-shown-once]');
    await axe(page, `the token, shown once (${width})`); ok(await noSideScroll(page), `the token dialog does not scroll sideways at ${width} px`);
    await ctx.close();
  }
  await finCtx.close(); await admCtx.close();
} catch (e) {
  fail(`the script stopped: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
}
finish(errors);
await browser.close();

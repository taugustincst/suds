// The county connection (docs/COUNTY-VIEW.md, "Connecting"), in the browser. One office server plays both sides, as
// county.mjs does: the county switches the connection on and issues this server's programme a connection token, and
// the same server, as the programme, connects to itself over HTTP, tests the connection and sends its county file.
//   1. County connections (#/county-connect): the switch and cadence; the county's administrator turns it on.
//   2. County view › Programmes: Issue token opens a dialog; the token is shown once, in a field that takes the
//      focus, with a Copy button that says what it did; closing gives the focus back; the token is never on the
//      page again.
//   3. Settlement outcomes: an administrator connects (address and token), Test connection says what the county
//      expects (a status that takes the focus), and names the periods as the Send to the county card does; finance
//      sends what the card has chosen (its period, county code and name, and the funds ticked: with none ticked,
//      Send says so at the card, as Make the county file does) and sees the county's receipt and the send log;
//      finance cannot change the connection.
//   4. The county sees the file in its combined view; a read token (shown once) reads the same over the API.
//   5. A county whose server starts giving another county code (a stand-in county this script runs): Test connection
//      says so, the card says nothing is sent until an administrator confirms, and Confirm takes it; a proxy in front
//      of the county without TRUST_PROXY is warned about on County connections.
//   6. axe (WCAG 2.1 A/AA) on the pages and dialogs at 1280, 390 and 320 px, and nothing scrolls sideways.
//   Built for 1.21.0: the county sets how many days after a period its file is due; a program connected to a county
//   that reads the award is sent version 2 and shown the county's own schedule; one connected to a county on SUDS
//   1.20 (the stand-in, which does not say what it reads) is warned, and the card ticks "make a version 1 file".
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
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
  // This server's own county key, registered as a program (as county.mjs does), so it can send to itself; the
  // fingerprint typed, as the county view's register route requires (or "compared").
  const key = (await api(adm, 'POST', '/api/county-submission/key', {})).data.key;
  const prog = await api(adm, 'POST', '/api/county/programmes', { name: 'Our own program', public_key: key.public_key, fingerprint: key.fingerprint_display });
  eq(prog.status, 201, 'the program is registered with its own key');
  const code = (await api(adm, 'GET', '/api/county/code')).data;
  ok(code && /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code.code_display), 'this county has a code', code);
  // A settlement fund the county pays for, with money spent in the period, so the file has figures in it.
  const fund = await api(adm, 'POST', '/api/budget/funds', { name: 'County connection settlement share', grant_number: 'OSF-CC-UI', source_type: 'opioid_settlement', fiscal_year_start: `${lq.from.slice(0, 4)}-01-01`, fiscal_year_end: `${lq.from.slice(0, 4)}-12-31`, total_amount: 40000, settlement_use: 'core_a', settlement_hiaa: 'hiaa_6' });
  eq(fund.status, 201, 'a settlement fund', fund.data);

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
  // Built for 1.21.0: when a period's file is due, told to every connected program (30 days unless set).
  ok(/Files due\s*30 days after each period ends/.test(await adm.textContent('[data-cc-settings]')), 'the page says files are due 30 days after a period ends');
  await adm.fill('[data-cc-settings] input[name=due_days]', '20');
  await adm.click('[data-cc-settings] button[type=submit]');
  ok(await toast(adm, /Saved/), 'the days a file is due after its period are saved');
  await settle(adm);
  ok(/Files due\s*20 days after each period ends/.test(await adm.textContent('[data-cc-settings]')), 'and the page says 20 days');
  eq((await api(adm, 'GET', '/api/county-connect/settings')).data.due_days, 20, 'which the programs are told');

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
  await until(() => adm.$('[data-so-county-period-select]'));
  const lqLabel = await adm.$eval('[data-so-county-period-select]', s => s.options[0].text);
  ok(!/Outstanding/.test(tested.text) || tested.text.includes(lqLabel), 'the outstanding periods are named as the Send to the county card names them', [lqLabel, tested.text]);
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
  await until(() => fin.$('[data-so-county-form]'));
  const sendLabel = (await fin.textContent('[data-cc-send]')).trim();
  const makeLabel = (await fin.textContent('[data-so-county-file]')).trim();
  eq(sendLabel.replace(/^Send (.*) to the county now$/, '$1'), makeLabel.replace(/^Make the county file for /, ''), 'Send names the period chosen on the Send to the county card', [sendLabel, makeLabel]);
  // Nothing ticked on the card: Send says so there, and puts the focus on the funds, as Make the county file does.
  await fin.fill('[data-so-county-code]', code.code_display.toLowerCase());
  await fin.fill('[data-so-county-name]', 'Sample County Behavioral Health');
  await fin.click('[data-cc-send]');
  ok(/Tick the settlement funds/.test(await fin.textContent('[data-so-county-error]')), 'Send with no fund ticked: said at the card');
  ok(await fin.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-so-county-fund')), 'and the focus goes to the funds');
  eq((await api(fin, 'GET', '/api/county-connect/connection')).data.sends.length, 0, 'and nothing was sent');
  await fin.check(`[data-so-county-fund="${fund.data.id}"]`);
  await fin.click('[data-cc-send]');
  const sent = await until(async () => { const o = await fin.getAttribute('[data-cc-result]', 'data-cc-outcome'); return o ? { o, text: await fin.textContent('[data-cc-result]') } : null; }, { timeout: 20000 });
  eq(sent && sent.o, 'ok', 'finance sends the period to the county', sent && sent.text);
  ok(/Sent\./.test(sent.text) && /receipt/.test(sent.text), 'and sees the county\'s receipt', sent.text);
  ok(await until(async () => /Imported/.test(await fin.textContent('[data-cc-send-card] table'))), 'the send log says the county imported it');
  // What was sent is what the card chose: the funds ticked are remembered for this county's code, as Download does.
  const opts = (await api(fin, 'GET', '/api/county-submission/options')).data;
  const mine = opts.counties.find(c => c.code === code.code);
  ok(mine && mine.name === 'Sample County Behavioral Health' && mine.fund_ids.length === 1 && mine.fund_ids[0] === fund.data.id, 'the county\'s name and the fund ticked went into the file', mine);
  await axe(fin, 'settlement with the send log (1280)');
  // Built for 1.21.0: this county reads version 2 (no warning), and its schedule and due dates are the reminders'.
  ok(!(await fin.$('[data-cc-county-older]')), 'a county that reads the award (1.21) gets no older-county warning');
  const conn2 = (await api(fin, 'GET', '/api/county-connect/connection')).data;
  eq(conn2.send_version, 2, 'and is sent version 2, with the award');
  ok(await until(() => fin.$('[data-so-schedule-source=county]')), 'the reporting schedule on the same page is the county\'s own, said as such');
  const lqRow = await until(async () => fin.$$eval('[data-so-schedule] tbody tr', (trs) => trs.map(t => t.textContent)).then(t => (t.some(x => /Received by the county|Sent/.test(x)) ? t : null)));
  ok(lqRow && lqRow.some(t => /Received by the county|Sent/.test(t)), 'the quarter just sent is done, without reloading the page', lqRow);
  ok(lqRow.some(t => /Jul|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun/.test(t)), 'each period with its due date');
  await axe(fin, 'settlement with the county\'s reporting schedule (1280)');

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

  // ---------------- 5. a county that changes its code; a proxy without TRUST_PROXY ----------------
  let fakeCode = 'FAKE-2345';
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ county: { code: fakeCode, name: 'Stand-in County' }, programme: { id: 'p', name: 'Our own program', active: true }, cadence: 'quarterly_calendar', cadence_label: 'Quarterly', expected: [], outstanding: [], received: [] }));
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  try {
    eq((await api(adm, 'PUT', '/api/county-connect/connection', { base_url: `http://127.0.0.1:${fake.address().port}` })).status, 200, 'the connection points at the stand-in county');
    eq((await api(adm, 'POST', '/api/county-connect/connection/test', {})).data.ok, true, 'which gives its county code');
    // Built for 1.21.0: this stand-in answers as SUDS 1.20 does, without accepts_schema_versions: it reads version 1 only.
    await go(adm, `settlement?from=${lq.from}&to=${lq.to}`);
    const older = await until(() => adm.$('[data-cc-county-older]'));
    ok(older && /version 1 only \(SUDS 1\.20 or earlier\)/.test(await older.textContent()), 'the connection card warns that the county reads version 1 only', older && await older.textContent());
    await until(() => adm.$('[data-so-county-v1]'));
    await adm.fill('[data-so-county-code]', 'fake-2345'); await adm.dispatchEvent('[data-so-county-code]', 'change');
    ok(await adm.isChecked('[data-so-county-v1]'), 'typing that county\'s code on the card ticks "make a version 1 file"');
    ok(await adm.isVisible('[data-so-county-older]'), 'and says why there');
    await axe(adm, 'settlement, a county on SUDS 1.20 (1280)');
    fakeCode = 'ZZZZ-2345';
    await go(adm, `settlement?from=${lq.from}&to=${lq.to}`);
    await adm.waitForSelector('[data-cc-test]');
    await adm.click('[data-cc-test]');
    const changed = await until(async () => { const o = await adm.getAttribute('[data-cc-result]', 'data-cc-outcome'); return o ? { o, text: await adm.textContent('[data-cc-result]'), role: await adm.getAttribute('[data-cc-result]', 'role') } : null; });
    eq(changed && changed.o, 'failed', 'Test connection says the county code changed', changed && changed.text);
    ok(/county code changed/i.test(changed.text) && /ZZZZ-2345/.test(changed.text), 'naming the new code', changed.text);
    eq(changed.role, 'alert', 'as an alert');
    const banner = await until(() => adm.$('[data-cc-code-changed]'));
    ok(banner && /nothing is sent/.test(await banner.textContent()), 'the card says nothing is sent until an administrator confirms');
    await axe(adm, 'settlement, county code changed (1280)');
    await adm.click('[data-cc-confirm-code]'); await adm.waitForSelector('.modal-bg .modal');
    await axe(adm, 'Confirm the new county code dialog (1280)');
    await adm.click('.modal-bg .modal .btn.primary');
    ok(await toast(adm, /Confirmed/), 'confirming the new code is saved');
    ok(await until(async () => !(await adm.$('[data-cc-code-changed]'))), 'and the warning goes');
    eq((await api(adm, 'GET', '/api/county-connect/connection')).data.county_code, 'ZZZZ2345', 'the confirmed code is the one files are made for');
  } finally { await new Promise(r => { fake.closeAllConnections(); fake.close(r); }); }
  eq((await api(adm, 'PUT', '/api/county-connect/connection', { base_url: base })).status, 200, 'the connection points back at this server');
  // A machine call through a proxy (X-Forwarded-For) while this server has no TRUST_PROXY: County connections warns.
  await fetch(`${base}/api/county-connect/v1/status`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': '198.51.100.20' } });
  const trusted = (await api(adm, 'GET', '/api/county-connect/settings')).data.trust_proxy;
  await go(adm, 'county-connect');
  if (trusted) ok(!(await adm.$('[data-cc-proxy-warning]')), 'with TRUST_PROXY set there is no proxy warning');
  else {
    ok(/TRUST_PROXY=1/.test((await adm.textContent('[data-cc-proxy-warning]').catch(() => '')) || ''), 'County connections warns that TRUST_PROXY is not set behind a proxy');
    await axe(adm, 'County connections, proxy warning (1280)');
  }

  // ---------------- 6. phone widths ----------------
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

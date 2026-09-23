// Findings from the functional audit of local mode, sync and the PWA, reproduced in a real browser against
// the seeded office server: writes that used to be lost on the way out (H5), background requests keeping
// a session alive (H1), office errors that read as device faults (H2), an office MFA prompt that sent the
// device to its own #/mfa page (H3), starting offline (H4), a remote wipe the device wrote straight back
// (B1), a restored office database (H6), supply counts edited on the device (M3) and the conflict banner's
// raw column names (LOW).
import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import { makeChecks, until } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { ok, eq, fail, finish } = makeChecks('device-audit');
const browser = await chromium.launch();
const errors = [];
const watch = (page) => {
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 300)); });
};

// ---- office-side helpers (plain fetch, bearer sessions) ----
async function officeLogin(username, password, secret) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Client': '1' }, body: JSON.stringify({ username, password }) });
  const d = await r.json(); if (!d.token) throw new Error('office login failed: ' + JSON.stringify(d));
  const sess = { token: d.token, H: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', Authorization: 'Bearer ' + d.token } };
  if (d.mfaPending) { if (!secret) throw new Error('office login for ' + username + ' needs a code'); await officeJson(sess, 'POST', '/api/auth/mfa/verify', { code: totp(secret) }); }
  return sess;
}
const officeJson = (sess, method, path, body) => fetch(base + path, { method, headers: sess.H, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
// RFC 6238, the same arithmetic as server/crypto.js totp(), so the script can act as an authenticator app.
function totp(secretB32, time = Date.now()) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0; const bytes = [];
  for (const c of secretB32.toUpperCase().replace(/[^A-Z2-7]/g, '')) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest(); const off = h[h.length - 1] & 0xf;
  return String((((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1_000_000).padStart(6, '0');
}

// ---- device helpers ----
const api = (page, m, p, b, h = {}) => page.evaluate(([m, p, b, h]) => window.SUDS_LOCAL.handle(m, p, b, h).then(r => ({ status: r.status, json: r.json })), [m, p, b, h]);
async function setupDevice(page, { username, password, name }) {
  await page.goto(base + '/?local=1#/');
  await until(async () => (await page.$('input[name=display_name]')) || (await page.$('.boot.error')), { timeout: 20000 });
  await page.fill('input[name=display_name]', name); await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password); await page.fill('input[name=confirm]', password);
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 15000 });
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await page.waitForTimeout(150); }
}
const idbHasDb = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('suds-local', 1); req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => { const g = req.result.transaction('kv', 'readonly').objectStore('kv').get('db'); g.onsuccess = () => resolve(g.result !== undefined && g.result !== null); g.onerror = () => resolve(false); };
  req.onerror = () => resolve(false);
}));
const syncLog = (page) => until(async () => { const t = (await page.textContent('[data-sync-log]')) || ''; return /connecting/i.test(t) ? null : t; }, { timeout: 30000 });
async function syncViaForm(page, { username, password, code } = {}) {
  await page.goto(base + '/?local=1#/sync'); await page.waitForSelector('input[name=office_password]', { timeout: 15000 });
  await page.fill('input[name=server]', base);
  if (username) await page.fill('input[name=username]', username);
  await page.fill('input[name=office_password]', password);
  if (code) await page.fill('input[name=code]', code);
  await page.click('button[type=submit]');
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage(); watch(page);
  const admin = await officeLogin('admin', 'AdminPassw0rd!x');
  await setupDevice(page, { username: 'dchen', password: 'Navigator2026!!', name: 'Audit Device' });
  ok(await page.$('.layout'), 'a fresh device sets itself up');

  // ---- H1: background requests do not count as activity, on either side ----
  {
    // In the office app the reminder bell's poll is a real request: it must carry X-Background: 1, while a
    // request the person makes (opening the client list) must not.
    const octx = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const op = await octx.newPage(); watch(op);
    await op.goto(base + '/#/'); await op.waitForSelector('input[name=username]', { timeout: 15000 });
    const pollReq = op.waitForRequest(r => /\/api\/tasks\/due/.test(r.url()), { timeout: 15000 }).catch(() => null);
    await op.fill('input[name=username]', 'mrivera'); await op.fill('input[name=password]', 'Navigator2026!!'); await op.click('button[type=submit]');
    await op.waitForSelector('.layout', { timeout: 15000 });
    const poll = await pollReq;
    ok(poll && poll.headers()['x-background'] === '1', 'the reminder bell polls the office as a background request (X-Background: 1)', poll && poll.headers());
    const userReq = op.waitForRequest(r => /\/api\/clients\?/.test(r.url()), { timeout: 15000 }).catch(() => null);
    await op.click(".sidebar nav a[href=\"#/clients\"]");
    const clients = await userReq;
    ok(clients && clients.headers()['x-background'] === undefined, 'a request the person makes is not marked background', clients && clients.headers());
    const s = await officeLogin('mrivera', 'Navigator2026!!');
    eq((await fetch(base + '/api/tasks/due?within=60', { headers: { ...s.H, 'X-Background': '1' } })).status, 200, 'the office answers a background poll');
    await octx.close();
  }
  const idleText = await page.evaluate(() => fetch('app.js').then(r => r.text()).then(t => (t.match(/You will be signed out in 1 minute[^']*/) || [''])[0]));
  ok(/Tap the screen/.test(idleText), 'the idle warning speaks to phones too (Tap the screen …)', idleText);

  // ---- H5: a write in the last moments before a reload survives ----
  const cl = await api(page, 'POST', '/api/clients', { first_name: 'Last', last_name: 'Moment' });
  ok(cl.status === 201 || cl.status === 200, 'a client is recorded on the device', cl);
  const goal = 'Typed just before leaving ' + Date.now();
  await api(page, 'PUT', '/api/clients/' + cl.json.id, { goals: goal });
  await page.waitForTimeout(150);
  await page.reload(); await page.waitForSelector('.layout', { timeout: 20000 });
  const back = await api(page, 'GET', '/api/clients/' + cl.json.id);
  eq(back.json && back.json.client && back.json.client.goals, goal, 'an edit made 150 ms before a reload is still there afterwards');
  {
    // And with no wait at all: the pagehide flush starts the IndexedDB write on the way out.
    const goal2 = 'Written and gone ' + Date.now();
    await page.evaluate(([id, g]) => window.SUDS_LOCAL.handle('PUT', '/api/clients/' + id, { goals: g }, {}), [cl.json.id, goal2]);
    // A different query string is a real navigation (a hash change alone would not unload the page).
    await page.goto(base + '/?local=1&nav=' + Date.now() + '#/clients'); await page.waitForSelector('.layout', { timeout: 20000 });
    const back2 = await api(page, 'GET', '/api/clients/' + cl.json.id);
    eq(back2.json && back2.json.client && back2.json.client.goals, goal2, 'an edit made immediately before navigating away survives too');
  }

  // ---- H2: an office error is shown as the office's, not as a fault on the device ----
  await syncViaForm(page, { password: 'definitely-wrong' });
  const wrong = await syncLog(page);
  ok(/Sync failed: /.test(wrong) && !/Something went wrong on this device/.test(wrong), 'a wrong office password is reported as the office\'s answer', wrong);
  ok(/password|credentials|sign/i.test(wrong), 'and says what the office said', wrong);
  eq(page.url().split('#')[1], '/sync', 'the device stays on the Sync screen');
  ok(await page.$('.layout'), 'and stays signed in on the device');

  // ---- H3: an office account with two-step verification asks for the code inline ----
  const dchen = await officeLogin('dchen', 'Navigator2026!!');
  const setup = await officeJson(dchen, 'POST', '/api/auth/mfa/setup');
  ok(setup.data && setup.data.secret, 'the office account enrols in two-step verification for the test', setup);
  const enabled = await officeJson(dchen, 'POST', '/api/auth/mfa/enable', { code: totp(setup.data.secret) });
  eq(enabled.status, 200, 'enrolment completes with a code from the authenticator');
  await syncViaForm(page, { password: 'Navigator2026!!' });
  const prompt = await until(async () => (await page.$('[data-office-mfa]')) || ((await page.textContent('[data-sync-log]')) || '').includes('failed'), { timeout: 30000 });
  ok(await page.$('[data-office-mfa]'), 'the Sync screen asks for the authenticator code inline', await page.textContent('[data-sync-log]'));
  eq(page.url().split('#')[1], '/sync', 'without navigating the device to its own #/mfa page');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.name === 'code'), 'and puts the cursor in the code field');
  await page.fill('input[name=code]', totp(setup.data.secret));
  await page.click('button[type=submit]');
  const withCode = await syncLog(page);
  ok(/^Done /.test(withCode), 'syncing with the code succeeds', withCode);
  // Two-step verification stays on for this account (the seeded policy requires it for the role once
  // enrolled); every later sync in this script sends a code, as a navigator would.
  const mfaSecret = setup.data.secret;
  const dchen2 = await officeLogin('dchen', 'Navigator2026!!', mfaSecret);

  // ---- M3: supply counts cannot be edited on the device ----
  const shelf = await api(page, 'GET', '/api/supplies');
  const kit = (shelf.json.rows || []).find(x => /naloxone kit/i.test(x.item));
  ok(kit, 'the device holds the office supply counts after a sync', shelf.json);
  const edit = await api(page, 'PUT', '/api/supplies/' + kit.id, { quantity: 1 });
  eq(edit.status, 403, 'changing a count on the device is refused');
  ok(/kept at the office/.test(edit.json && edit.json.error), 'with an explanation', edit.json);
  eq((await api(page, 'POST', '/api/supplies', { item: 'Device-only item', quantity: 5 })).status, 403, 'as is adding one');
  eq((await api(page, 'GET', '/api/supplies')).json.rows.find(x => x.id === kit.id).quantity, kit.quantity, 'and the count is unchanged');

  // ---- LOW: a conflict names columns in plain words ----
  {
    const s = dchen2;
    const mineOffice = (await officeJson(s, 'GET', '/api/clients?limit=1')).data.clients[0];
    await api(page, 'PUT', '/api/clients/' + mineOffice.id, { goals: 'device version', preferred_name: 'Dev' });
    await new Promise(r => setTimeout(r, 1100));
    await officeJson(s, 'PUT', '/api/clients/' + mineOffice.id, { goals: 'office version', preferred_name: 'Off' });
    await syncViaForm(page, { password: 'Navigator2026!!', code: totp(mfaSecret) });
    await syncLog(page);
    const banner = await until(() => page.$('[data-sync-conflicts]'), { timeout: 5000 });
    ok(banner, 'an edit the office overrode is reported on the Sync screen');
    const text = banner ? await banner.textContent() : '';
    ok(!/_enc|_idx/.test(text), 'the conflict banner never shows raw column names', text);
    ok(/goals|preferred name/i.test(text), 'it names the fields in plain words', text);
  }

  // ---- H6: the office database is restored from a backup; the device re-sends what the backup lacks ----
  const backup = await fetch(base + '/api/admin/backup', { headers: admin.H });
  eq(backup.status, 200, 'the administrator downloads a backup');
  const backupBytes = Buffer.from(await backup.arrayBuffer());
  const afterBackup = await api(page, 'POST', '/api/clients', { first_name: 'After', last_name: 'Backup' });
  await syncViaForm(page, { password: 'Navigator2026!!', code: totp(mfaSecret) });
  ok(/^Done /.test(await syncLog(page)), 'the device syncs a client created after the backup was taken');
  eq((await officeJson(dchen2, 'GET', '/api/clients/' + afterBackup.json.id)).status, 200, 'the office has it');
  const restore = await officeJson(admin, 'POST', '/api/admin/restore', { password: 'AdminPassw0rd!x', confirm: 'REPLACE', file_b64: backupBytes.toString('base64') });
  eq(restore.status, 200, 'the backup is restored', restore.data);
  const admin2 = await officeLogin('admin', 'AdminPassw0rd!x');
  eq((await officeJson(admin2, 'GET', '/api/clients/' + afterBackup.json.id)).status, 404, 'the restore discarded the client synced after the backup');
  await syncViaForm(page, { password: 'Navigator2026!!', code: totp(mfaSecret) });
  const restoredLog = await syncLog(page);
  ok(/^Done /.test(restoredLog), 'the device syncs again after the restore', restoredLog);
  ok(await page.$('[data-sync-notice]'), 'and says the office database was restored', restoredLog);
  ok(/restored from a backup; re-sending/.test((await page.textContent('[data-sync-notice]')) || ''), 'in those words');
  eq((await officeJson(admin2, 'GET', '/api/clients/' + afterBackup.json.id)).status, 200, 'the client the restore lost is back at the office');

  // ---- B1: a remote wipe erases the device for real ----
  const devices = await officeJson(admin2, 'GET', '/api/admin/devices');
  const mine = (devices.data.devices || []).find(d => d.username === 'dchen');
  ok(mine, 'the office lists this device', devices.data);
  eq((await officeJson(admin2, 'POST', `/api/admin/devices/${mine.id}/wipe`)).status, 200, 'the administrator requests a wipe');
  await api(page, 'POST', '/api/clients', { first_name: 'Written', last_name: 'BeforeWipe' }); // dirty, unsaved work right before the wipe
  await syncViaForm(page, { password: 'Navigator2026!!', code: totp(mfaSecret) });
  const wipeLog = await syncLog(page);
  ok(/remotely wiped/i.test(wipeLog), 'the device reports that it was wiped', wipeLog);
  await page.waitForTimeout(400);
  eq(await idbHasDb(page), false, 'the database is gone from IndexedDB before the page reloads');
  eq(await page.evaluate(() => localStorage.getItem('suds.local.enc')), null, 'and so are the encryption keys');
  await until(() => page.$('input[name=display_name]'), { timeout: 15000 });
  ok(await page.$('input[name=display_name]'), 'the page reloads into first-run setup', page.url());
  await page.waitForTimeout(2500); // the old debounce window, and then some
  eq((await api(page, 'GET', '/api/local/status')).json.users, 0, 'nothing wrote the old database back after the reload: the device has no account');
  await page.reload(); await until(() => page.$('input[name=display_name]'), { timeout: 15000 });
  ok(await page.$('input[name=display_name]'), 'reopening the same profile still starts from first-run setup');
  const wiped = (await officeJson(admin2, 'GET', '/api/admin/devices')).data.devices.find(d => d.id === mine.id);
  ok(wiped && wiped.revoked_at, 'the office marks the device revoked (wiped)', wiped);
  await ctx.close();

  // ---- H4: a device set up for local mode starts offline ----
  {
    const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const p2 = await ctx2.newPage(); watch(p2);
    await setupDevice(p2, { username: 'offlinenav', password: 'Navigator2026!!', name: 'Offline Nav' });
    const sw = await until(() => p2.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!(r && (r.active || r.installing || r.waiting)))), { timeout: 15000 });
    ok(sw, 'the service worker is registered in local mode');
    await until(() => p2.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))), { timeout: 15000 });
    const cached = await until(() => p2.evaluate(async () => { const keys = await caches.keys(); for (const k of keys) { const c = await caches.open(k); if (await c.match('local/kernel.js', { ignoreSearch: true })) return k; } return null; }), { timeout: 15000 });
    ok(cached, 'the kernel is in the shell cache', cached);
    await ctx2.setOffline(true);
    await p2.reload().catch(() => {});
    await until(() => p2.$('.layout, input[name=username]'), { timeout: 20000 });
    ok(await p2.$('.layout'), 'with the network gone, the app still boots from the cache and is signed in', (await p2.textContent('body')).slice(0, 120));
    const offlineList = await api(p2, 'GET', '/api/local/status');
    eq(offlineList.status, 200, 'and the kernel answers requests offline');
    await ctx2.setOffline(false);
    await ctx2.close();
  }
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
}

finish(errors.slice(0, 10));
await browser.close();

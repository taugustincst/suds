import { chromium } from 'playwright';
import { makeChecks, until, settle, saved } from './assert.mjs';
const { ok, eq, fail, finish } = makeChecks('local-mode');
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
import('node:fs').then(m => m.mkdirSync('/tmp/suds-shots', { recursive: true }));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
await page.goto(base + '/?local=1#/');
await until(async () => (await page.$('input[name=username]')) || (await page.$('.boot.error')), { timeout: 15000 });
const bootText = (await page.textContent('#app')).slice(0, 120).replace(/\s+/g, ' ');
console.log('hash:', page.url().split('#')[1], '| boot text:', bootText);
// This whole block used to be inside `if (await page.$(...))`, so when the kernel failed to boot and the
// page rendered nothing, the script printed "NO ERRORS" and exited 0. A dead phone app is a failure.
ok(await page.$('input[name=username]'), 'the local kernel booted and offered first-run setup', bootText);
{
  await page.fill('input[name=display_name]', 'Phone Nav'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!');
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 });
  ok(await page.$('.layout'), 'the app is usable straight after setup');
  await page.waitForSelector('text=On this device', { timeout: 5000 }).catch(() => {});
  ok(await page.$('text=On this device'), 'and says it is running on this device');
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); }
  // create a client locally
  await page.click('text=+ Log'); await page.waitForSelector('.quick-list button:has-text("New client")'); await page.click('.quick-list button:has-text("New client")'); await page.waitForSelector('.modal input[name=first_name]');
  await page.fill('.modal input[name=first_name]', 'Local'); await page.fill('.modal input[name=last_name]', 'Phoneclient'); await page.click('.modal button[type=submit]'); await page.waitForURL(/#\/client\//, { timeout: 10000 }).catch(() => {});
  ok(/^\/client\//.test(page.url().split('#')[1] || ''), 'a client created on the device opens its own page', page.url().split('#')[1]);
  await page.click('text=+ Intervention'); await page.waitForSelector('.modal select[name=type]'); await page.selectOption('.modal select[name=type]', 'outreach'); await page.click('.modal button[type=submit]');
  const toasts = await until(async () => { const t = await page.$$eval('.toast', e => e.map(x => x.textContent)); return t.length ? t : null; }) || [];
  ok(toasts.length > 0 && !toasts.some(t => /error|failed|could not/i.test(t)), 'recording a visit on the device confirms it saved', toasts);
  // persistence across reload: the local kernel's writes flush to IndexedDB asynchronously, and reloading
  // before that flush lands is a real race, not just UI settling — so wait until it reports nothing unsaved.
  await settle(page); await saved(page); await page.reload(); await page.waitForSelector('.layout', { timeout: 15000 }).catch(() => {});
  ok(await page.$('.layout'), 'the device is still signed in after a reload', (await page.textContent('#app')).slice(0, 80));
  await page.goto(base + '/?local=1#/clients'); await page.waitForSelector('tbody', { timeout: 10000 }).catch(() => {});
  const rowsBefore = await page.$$eval('tbody tr', r => r.length);
  ok(rowsBefore >= 1, 'the client entered on the device survived the reload', rowsBefore);
  // sync against the dev server (same host)
  await page.goto(base + '/?local=1#/sync'); await page.waitForSelector('input[name=office_password]', { timeout: 10000 }).catch(() => {});
  ok((await page.inputValue('input[name=office_password]')) === '', 'the office-password field loads empty, not prefilled with the local sign-in credential');
  await page.fill('input[name=server]', base); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=office_password]', 'Navigator2026!!');
  await page.click('button[type=submit]');
  // The log reads "Connecting…" the instant the form submits, well before the round trip finishes — that
  // placeholder is truthy too, so waiting for "any text" resolves immediately with the wrong text. Wait for
  // it to move past that placeholder instead.
  const log = await until(async () => { const t = (await page.textContent('.card:nth-of-type(2) .small.muted.mt')) || ''; return /connecting/i.test(t) ? null : t; }, { timeout: 20000 }) || '';
  ok(!/fail|error|could not/i.test(log), 'the sync reported no failure', log.slice(0, 200));
  await page.goto(base + '/?local=1#/clients');
  const rowsAfter = await until(async () => { const n = await page.$$eval('tbody tr', r => r.length); return n > rowsBefore ? n : 0; }) || await page.$$eval('tbody tr', r => r.length);
  ok(rowsAfter > rowsBefore, 'syncing brought the office caseload onto the device', { before: rowsBefore, after: rowsAfter });
  await page.screenshot({ path: '/tmp/suds-shots/local_clients.png' });
  // The Sync page's own "Erase data on this device" (someone signed in, choosing this on purpose) shares
  // the same typed-ERASE dialog as the locked-out recovery paths, not a plain confirm.
  await page.goto(base + '/?local=1#/sync'); await page.waitForSelector('text=Erase data on this device', { timeout: 10000 }).catch(() => {});
  await page.click('text=Erase data on this device'); await page.waitForSelector('.modal');
  ok(await page.isDisabled('.modal button.danger'), 'the Sync page erase button also starts disabled until ERASE is typed');
  await page.click('.modal button:has-text("Cancel")'); await until(async () => !(await page.$('.modal')), { timeout: 5000 });
  ok(!(await page.$('.modal')), 'cancelling leaves the device untouched');
  // Locked out or forgot the password, with no office admin to ask: the login screen offers a self-service
  // reset instead of a dead end.
  // CI once timed out here with "element is outside of the viewport" (not reproduced in many local runs).
  // If it happens again, record what the page looked like instead of a bare timeout.
  const signOutState = () => page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => /^Sign out$/.test(x.textContent.trim())); const r = a && a.getBoundingClientRect(); const side = document.querySelector('.sidebar'); return { url: location.href, viewport: [innerWidth, innerHeight], scrollY, docHeight: document.documentElement.scrollHeight, signOut: r && [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], sidebarTransform: side && getComputedStyle(side).transform, sidebarRect: side && side.getBoundingClientRect().toJSON(), modal: !!document.querySelector('.modal'), banners: [...document.querySelectorAll('#banners > *')].map(b => b.textContent.slice(0, 60)), paused: !!document.querySelector('[data-paused]') }; });
  await page.click('text=Sign out', { timeout: 10000 }).catch(async (e) => { const st = JSON.stringify(await signOutState().catch(() => null)); console.error(` FAIL  could not click Sign out — page state ${st}`); fail(`could not click Sign out: ${e.message.split('\n')[0]} — ${st}`); throw e; });
  await page.waitForSelector('input[name=username]', { timeout: 8000 });
  ok(!(await page.$('input[name=display_name]')), 'signing out lands back on the login screen, not first-run setup', page.url());
  ok(await page.$('text=Reset this device'), 'a locked-out device offers a self-service reset instead of only "ask an admin"');
  await page.click('text=Reset this device'); await page.waitForSelector('.modal');
  ok(await page.isDisabled('.modal button.danger'), 'the erase button starts disabled until the confirmation text matches');
  await page.fill('#reset-device-confirm', 'nope');
  ok(await page.isDisabled('.modal button.danger'), 'a wrong confirmation phrase leaves the erase button disabled');
  await page.fill('#reset-device-confirm', 'ERASE');
  ok(!(await page.isDisabled('.modal button.danger')), 'typing ERASE exactly enables the erase button');
  await page.click('.modal button.danger'); await page.waitForSelector('input[name=display_name]', { timeout: 10000 });
  ok(!!(await page.$('input[name=display_name]')), 'typing ERASE wipes the device and returns to first-run setup', page.url());
}
// Only one window may write the device's database, but on a phone the "other window" is usually a tab the
// person forgot, or the very tab that just reloaded, and a screen that says "go and find it" is a dead end.
// `page` above still holds the on-device lock from its very first load; a second tab in the same context
// (same storage partition, so the same Web Lock namespace) exercises the takeover for real.
{
  const page2 = await ctx.newPage();
  await page2.goto(base + '/?local=1#/');
  await page2.waitForSelector('.boot.error', { timeout: 15000 });
  const lockText = (await page2.textContent('.boot.error')) || '';
  ok(/open in another tab or window/i.test(lockText), 'a second tab on the same device is told SUDS is open elsewhere, not left blank');
  ok(await page2.$('button:has-text("Use SUDS in this window")'), 'and offers to use SUDS here instead of sending the person hunting for a tab');
  ok(await page2.$('button:has-text("Try again")'), 'with "Try again" still there for the case where the other window was just closed');
  // Take over: the first tab is asked to write out and step aside, then this one loads the database.
  await page2.click('button:has-text("Use SUDS in this window")');
  await page2.waitForSelector('input[name=username], input[name=display_name], .layout', { timeout: 15000 });
  ok(!(await page2.$('.boot.error')), '"Use SUDS in this window" takes the database over and boots', page2.url());
  await until(() => page.$('.boot.error'), { timeout: 10000 });
  const pausedText = (await page.textContent('.boot.error').catch(() => '')) || '';
  ok(/paused/i.test(pausedText), 'the tab that held the lock is told it has been paused, not left running against a stale copy', pausedText);
  ok(await page.$('button:has-text("Use SUDS here instead")'), 'and can take it back');
  const refused = await page.evaluate(() => window.SUDS_LOCAL.handle('GET', '/api/local/status', undefined, {}).then(r => r.status));
  eq(refused, 409, 'the paused tab refuses every request (nothing there can be written again)');
  // A reload of the tab that holds the lock is not "another window": it waits for its previous document to
  // let go of the lock (never steals it) and boots with no screen. scripts/ui/multitab.mjs has the rest.
  await page2.reload();
  await page2.waitForSelector('input[name=username], input[name=display_name], .layout', { timeout: 15000 });
  ok(!(await page2.$('.boot.error')), 'reloading the tab that holds the lock boots straight back in, with no already-open screen');
  await page.close();
  await page2.close();
}
// A device whose kernel fails to start — a bad migration, a corrupted database — never reaches the login
// screen at all, so the reset option has to work from the boot-failure screen itself, with no signed-in
// session and no window.SUDS_LOCAL to lean on.
{
  const failCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const failPage = await failCtx.newPage();
  // Poison the on-device database with bytes SQLite cannot open, so the kernel fails inside db.openWith()
  // the same way a corrupted database or a broken migration would — landing in boot()'s catch-all, the
  // same path every startup failure takes other than SUDS_ALREADY_OPEN.
  await failPage.goto(base + '/');
  await failPage.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('suds-local', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const t = req.result.transaction('kv', 'readwrite');
      t.objectStore('kv').put(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'db');
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  }));
  await failPage.goto(base + '/?local=1#/');
  await until(async () => (await failPage.$('.boot.error')) || (await failPage.$('input[name=username]')), { timeout: 15000 });
  ok(await failPage.$('.boot.error'), 'a kernel that fails to start shows the boot-error screen, not a blank page');
  ok(await failPage.$('text=Reset this device'), 'the boot-error screen offers a self-service reset without needing a session');
  await failPage.click('text=Reset this device'); await failPage.waitForSelector('.modal');
  await failPage.fill('#reset-device-confirm', 'ERASE');
  await failPage.click('.modal button.danger'); await failPage.waitForSelector('input[name=display_name]', { timeout: 10000 });
  ok(!!(await failPage.$('input[name=display_name]')), 'resetting from the boot-error screen wipes the corrupted database and boots into first-run setup', (await failPage.textContent('#app')).slice(0, 120));
  await failCtx.close();
}
// Which build is running, what went wrong on this device, and a release published while the page is open.
// A page of its own, not watched for page errors: it throws one on purpose.
{
  const c = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base + '/?local=1#/'); await p.waitForSelector('input[name=display_name]', { timeout: 15000 });
  const version = JSON.parse(await (await fetch(base + '/version.json')).text()).version;
  eq((await p.textContent('[data-build-stamp]') || '').trim(), `SUDS ${version}`, 'the start screen shows which build is running');
  await p.fill('input[name=display_name]', 'Stamp Nav'); await p.fill('input[name=username]', 'stamp'); await p.fill('input[name=password]', 'Navigator2026!!'); await p.fill('input[name=confirm]', 'Navigator2026!!');
  await p.click('button[type=submit]'); await p.waitForSelector('.layout', { timeout: 10000 });
  for (let i = 0; i < 5; i++) { const b = await p.$('.modal button.primary'); if (!b) break; await b.click(); await settle(p); }
  ok(/SUDS \d+\.\d+\.\d+/.test(await p.textContent('.sidebar .foot')), 'and so does the sidebar once signed in');
  // An uncaught error is kept on the device, without long digit runs, and listed on the Sync page.
  await p.evaluate(() => { setTimeout(() => { throw new Error('Exploded near record 12345678'); }, 0); });
  await settle(p); // the report is written through the kernel like any other request
  await p.goto(base + '/?local=1#/sync'); await p.waitForSelector('[data-device-errors]', { timeout: 10000 });
  const errText = await p.textContent('[data-device-errors]');
  ok(/Errors on this device/.test(errText) && /Exploded near record #{8}/.test(errText), 'the Sync page lists the error under "Errors on this device"', errText.slice(0, 200));
  ok(!/12345678/.test(errText), 'with the digit run masked');
  // A new release: version.json names another version. With a form half-filled the page is not reloaded
  // under the person (not even when hidden); it offers a Reload, and reloads at the next navigation.
  await p.route('**/version.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: '99.0.0' }) }));
  await p.evaluate(() => { window.__sameDocument = true; });
  await p.click('text=+ Log'); await p.waitForSelector('.quick-list button:has-text("New client")'); await p.click('.quick-list button:has-text("New client")');
  await p.waitForSelector('.modal input[name=first_name]'); await p.fill('.modal input[name=first_name]', 'Halfway');
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // visible again: checks version.json
  ok(await p.waitForSelector('[data-banner="update-ready"] [data-update-reload]', { timeout: 10000 }).catch(() => null), 'a new version on the server shows "A new version of SUDS is ready — Reload"');
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState; });
  await p.waitForTimeout(800); // intentional: proving a reload does NOT happen needs time to pass
  ok(await p.evaluate(() => window.__sameDocument === true) && (await p.inputValue('.modal input[name=first_name]')) === 'Halfway', 'going to the background mid-form does not reload the page or lose the typing');
  await p.click('.modal button:has-text("Cancel")').catch(() => p.keyboard.press('Escape'));
  await p.evaluate(() => { location.hash = '#/clients'; });
  await until(() => p.evaluate(() => window.__sameDocument !== true).catch(() => false), { timeout: 10000 });
  ok(await p.evaluate(() => window.__sameDocument !== true), 'the next move to another page picks the new version up (the page reloads)');
  // Still the "old" build after that one reload (here: version.json keeps disagreeing): the banner stays,
  // and the page does not reload again on every move.
  await p.waitForSelector('.layout', { timeout: 15000 });
  await p.evaluate(() => { window.__sameDocument = true; location.hash = '#/dashboard'; });
  await p.waitForTimeout(1200); // intentional: proving a second reload does NOT happen needs time to pass
  ok(await p.evaluate(() => window.__sameDocument === true), 'one automatic reload per release, not one per page');
  ok(await p.$('[data-banner="update-ready"]'), 'the Reload banner is still offered');
  await c.close();
  // The office app sends the same report to the server (server/routes/client-errors.js), not to storage.
  const oc = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const op = await oc.newPage();
  await op.goto(base + '/#/'); await op.waitForSelector('input[name=username]', { timeout: 15000 });
  await op.fill('input[name=username]', 'admin'); await op.fill('input[name=password]', 'AdminPassw0rd!x'); await op.click('button[type=submit]');
  await op.waitForSelector('.layout, input[name=code]', { timeout: 15000 });
  const beacon = op.waitForRequest(r => /\/api\/client-errors$/.test(r.url()) && r.method() === 'POST', { timeout: 10000 }).catch(() => null);
  await op.evaluate(() => { setTimeout(() => { throw new Error('Office page broke at 98765432'); }, 0); });
  const sent = await beacon;
  const payload = sent ? JSON.parse(sent.postData() || '{}') : {};
  ok(sent && /Office page broke at #{8}/.test(payload.message) && payload.version && !('at' in payload), 'the office app reports an uncaught error to the server, digits masked', payload);
  eq(sent ? (await sent.response()).status() : 0, 200, 'and the server accepts it');
  eq(await op.evaluate(() => localStorage.getItem('suds.errors')), null, 'nothing is kept in the office browser');
  await oc.close();
}
// An offline copy that syncs with the office cannot reach provider websites (a browser gets no CORS
// headers from them), and it receives the office's pictures when it syncs. So it offers no "Download
// provider pictures" button, says where they come from, and its kernel refuses the download with that
// reason instead of 80 lines of "Failed to fetch". A fresh device of its own, so nothing here syncs.
{
  const dc = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const dp = await dc.newPage();
  dp.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await dp.goto(base + '/?local=1#/'); await dp.waitForSelector('input[name=display_name]', { timeout: 15000 });
  await dp.fill('input[name=display_name]', 'Picture Nav'); await dp.fill('input[name=username]', 'picnav'); await dp.fill('input[name=password]', 'Navigator2026!!'); await dp.fill('input[name=confirm]', 'Navigator2026!!');
  await dp.click('button[type=submit]'); await dp.waitForSelector('.layout', { timeout: 15000 });
  await dp.goto(base + '/?local=1#/resources'); await settle(dp);
  await dp.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  await dp.click('[data-region=sacramento-metro] button:has-text("Add")');
  await dp.waitForSelector('[data-region=sacramento-metro] button:has-text("Check for updates")', { timeout: 90000 });
  await settle(dp);
  eq(await dp.$$eval('[data-region=sacramento-metro] button', b => b.filter(x => /Download provider pictures/.test(x.textContent)).length), 0, 'an office device offers no "Download provider pictures" button');
  ok(/downloaded on the office server and reach this device when it syncs/.test(await dp.textContent('[data-region=sacramento-metro]')), 'it says where the pictures come from instead');
  const refused = await dp.evaluate(async () => {
    const { pending } = (await window.SUDS_LOCAL.handle('GET', '/api/regions/sacramento-metro/pictures', undefined, {})).json;
    return (await window.SUDS_LOCAL.handle('POST', '/api/regions/sacramento-metro/pictures', { keys: [pending[0].key] }, { 'X-Requested-With': 'suds' })).json.results[0];
  });
  ok(refused && !refused.ok && /on the office server/.test(refused.error), 'and its kernel refuses a download with that reason', refused);
  await dc.close();
}
finish(errors.slice(0, 8));
await browser.close();

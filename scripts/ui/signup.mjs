// "Log in" and "Sign up" on the sign-in page, on both builds:
//  * office server (SUDS_URL): a sign-up is a request; the account cannot sign in until an administrator
//    approves it with a role (then the MFA policy applies as for any account); sign-up can be turned off.
//  * the on-device app (SUDS_STATIC_URL): no banner anywhere; the first account is made via Sign up with
//    the storage confirmation; a second person signs up on the same device and sees only their own
//    clients; the device administrator turns sign-ups off; backup -> erase -> restore brings the records
//    back, a wrong passphrase and a tampered file are refused; Home's backup reminder.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeChecks, until, settle } from './assert.mjs';

const office = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const device = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8877';
const { ok, eq, finish } = makeChecks('signup');
const browser = await chromium.launch();
const errors = [];
const PW = 'Navigator2026!!';
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
const watch = (page, label) => {
  page.on('pageerror', e => errors.push(`${label}: PAGEERROR ${e.message}`));
  page.on('response', r => { if (r.status() >= 500) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-signup-'));
const dismissTour = async (page) => { await settle(page); for (let i = 0; i < 6; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); } };
const selected = (page) => page.$eval('[role=tablist] [aria-selected=true]', b => b.dataset.modeTab).catch(() => null);

// =============================== office server ===============================
{
  // The administrator, in a browser of their own.
  const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const admin = await actx.newPage(); watch(admin, 'office admin');
  // The sign-in page is shown at #/ as well as #/login. Moving between them re-renders it, and that must not
  // throw away what was already typed (1.10.0's swap-in replaced the form, so a password typed a moment before
  // a re-render went with it and Log in submitted an empty form).
  await admin.goto(office + '/#/'); await admin.waitForSelector('input[name=username]'); await settle(admin);
  await admin.fill('input[name=username]', 'admin-typed');
  await admin.evaluate(() => { location.hash = '#/login'; }); await settle(admin);
  eq(await admin.inputValue('input[name=username]'), 'admin-typed', 'a re-render of the sign-in page keeps what was typed in it');
  eq(await admin.locator('input[name=username]').count(), 1, 'and there is still exactly one sign-in form');
  await admin.fill('input[name=username]', 'admin'); await admin.fill('input[name=password]', 'AdminPassw0rd!x'); await admin.click('button[type=submit]');
  await admin.waitForSelector('.layout', { timeout: 10000 });
  await admin.evaluate((h) => fetch('/api/me/prefs', { method: 'PUT', headers: h, body: JSON.stringify({ tour_done: true }) }), H);
  const api = (method, p, body) => admin.evaluate(async ({ method, p, body, h }) => { const r = await fetch(p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, p, body, h: H });
  // Navigators must use two-step verification, with a grace period: an approved account starts inside it.
  eq((await api('PUT', '/api/admin/settings', { program_contact: 'Privacy officer: Sam Lee, 555-0100', mfa_required_roles: 'admin,navigator', mfa_grace_days: 14 })).status, 200, 'the administrator sets the programme contact and an MFA policy for navigators');

  // A newcomer, on a phone.
  const nctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await nctx.newPage(); watch(p, 'office newcomer');
  await p.goto(office + '/#/login'); await p.waitForSelector('[role=tablist]'); await settle(p);
  ok(await p.$('[role=tablist][aria-label="Log in or sign up"]'), 'the sign-in page offers two options in an accessible tab list');
  eq(await p.$$eval('[role=tab]', t => t.map(x => x.textContent).join(' | ')), 'Log in | Sign up', 'labelled Log in and Sign up');
  eq(await selected(p), 'login', 'Log in is selected by default');
  eq(await p.$eval('[data-program-contact]', e => e.textContent), 'Program contact: Privacy officer: Sam Lee, 555-0100', 'the footer names the programme contact');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the page fits a phone screen');
  const seg = await p.$$eval('[role=tab]', t => t.map(x => { const r = x.getBoundingClientRect(); return { top: Math.round(r.top), h: r.height }; }));
  ok(seg.length === 2 && seg[0].top === seg[1].top && seg.every(x => x.h >= 44), 'the two options sit side by side as 44px tap targets on a phone', seg);
  // Keyboard: an arrow key moves to the other option.
  await p.focus('[data-mode-tab=login]'); await p.keyboard.press('ArrowRight'); await settle(p);
  eq(await selected(p), 'signup', 'the arrow key moves to Sign up');
  ok(/#\/login\?mode=signup$/.test(p.url()), 'and the address follows, so it can be linked to', p.url());
  // Deep link, fresh load.
  await p.goto(office + '/#/login?mode=signup'); await p.reload(); await p.waitForSelector('input[name=display_name]'); await settle(p);
  eq(await selected(p), 'signup', '#/login?mode=signup opens on Sign up');
  await p.fill('input[name=display_name]', 'Robin Request'); await p.fill('input[name=username]', 'rrequest');
  await p.fill('input[name=email]', 'robin@example.org');
  await p.fill('input[name=password]', PW); await p.fill('input[name=confirm]', PW + 'x');
  await p.click('button[type=submit]'); await settle(p);
  ok(/do not match/.test(await p.textContent('#account-panel')), 'mismatched passwords are caught before anything is sent');
  await p.fill('input[name=confirm]', PW);
  await p.fill('textarea[name=reason]', 'Peer navigator, north county team');
  await p.click('button[type=submit]');
  ok(await until(() => p.$('[data-signup-sent]')), 'the request is sent and the page says an administrator will review it');
  // Signing in before approval.
  await p.click('[data-mode-tab=login]'); await settle(p);
  await p.fill('input[name=username]', 'rrequest'); await p.fill('input[name=password]', PW); await p.click('button[type=submit]');
  const refused = await until(async () => { const t = await p.textContent('#account-panel .banner.danger').catch(() => ''); return t || null; }, { timeout: 6000 });
  ok(refused && /waiting for an administrator to approve/.test(refused), 'a pending account is told its request is waiting', refused);
  ok(!(await p.$('.layout')), 'and is not let in');
  await p.fill('input[name=password]', 'Wrong-Passw0rd!!'); await p.click('button[type=submit]');
  const generic = await until(async () => { const t = await p.textContent('#account-panel .banner.danger').catch(() => ''); return /Invalid/.test(t) ? t : null; }, { timeout: 6000 });
  ok(generic, 'with a wrong password it gets the ordinary failure, which says nothing about the request', generic);

  // The administrator sees and approves the request.
  await admin.goto(office + '/#/dashboard?_=' + Date.now()); await settle(admin);
  ok(await admin.$('a.badge[href="#/admin?tab=users"]') && /1 access request waiting/.test(await admin.textContent('.main')), 'Home tells the administrator a request is waiting');
  await admin.goto(office + '/#/admin?tab=users'); await admin.waitForSelector('[data-access-requests]'); await settle(admin);
  eq(await admin.$eval('[data-access-requests] h2', e => e.textContent), 'Access requests (1)', 'Settings → Users & roles shows "Access requests (1)"');
  ok(/Users & roles \(1\)/.test(await admin.textContent('.tabs')), 'and the tab carries the count');
  ok(/Peer navigator, north county team/.test(await admin.textContent('[data-access-requests]')), 'with the reason the person gave');
  await admin.click('[data-approve=rrequest]'); await admin.waitForSelector('.modal select[name=role]');
  await admin.selectOption('.modal select[name=role]', 'navigator');
  await admin.click('.modal button[type=submit]');
  ok(await until(async () => (await admin.$eval('[data-access-requests]', e => e.dataset.accessRequests).catch(() => null)) === '0', { timeout: 8000 }), 'approving empties the list');
  ok(/Robin Request/.test(await admin.textContent('.main table')), 'and the person is in the user list');

  // Now they can sign in, with the MFA policy applied like any other navigator.
  await p.goto(office + '/#/login'); await p.waitForSelector('input[name=username]'); await settle(p);
  await p.fill('input[name=username]', 'rrequest'); await p.fill('input[name=password]', PW); await p.click('button[type=submit]');
  await p.waitForSelector('.layout', { timeout: 10000 }).catch(() => {});
  ok(await p.$('.layout'), 'after approval the account signs in');
  ok(await until(() => p.$('[data-banner="mfa-required"]'), { timeout: 5000 }), 'and is told its role requires two-step verification, with the grace period to set it up');
  const me = await p.evaluate(() => fetch('/api/auth/me').then(r => r.json()));
  eq(me.user.role, 'navigator', 'with the role the administrator chose');

  // Sign-up switched off.
  eq((await api('PUT', '/api/admin/settings', { self_signup: '0' })).status, 200, 'the administrator turns sign-up off');
  const off = await browser.newContext(); const q = await off.newPage(); watch(q, 'office signup off');
  await q.goto(office + '/#/login?mode=signup'); await q.waitForSelector('[data-signup-disabled]');
  ok(/Ask your administrator for an account/.test(await q.textContent('[data-signup-disabled]')), 'with sign-up off, Sign up says to ask the administrator');
  ok(!(await q.$('input[name=display_name]')), 'and offers no form');
  const direct = await q.evaluate((h) => fetch('/api/auth/signup', { method: 'POST', headers: h, body: JSON.stringify({ display_name: 'X', username: 'sneaky', password: 'Navigator2026!!' }) }).then(r => r.status), H);
  eq(direct, 403, 'and the route itself refuses');
  await api('PUT', '/api/admin/settings', { self_signup: '1', mfa_required_roles: null, mfa_grace_days: null });
  await off.close(); await nctx.close(); await actx.close();
}

// =============================== the on-device app ===============================
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page, 'device');
  const noBanner = async (where) => ok(!(await page.$('.static-demo-banner')) && !/demo\/evaluation|evaluation build|do not enter real client/i.test(await page.textContent('body')), `no demo banner or evaluation wording (${where})`);
  const kernel = (method, p, body) => page.evaluate(async ({ method, p, body }) => { const r = await window.SUDS_LOCAL.handle(method, p, body, { 'X-Requested-With': 'suds' }); return { status: r.status, data: r.json }; }, { method, p, body });
  const logout = async () => { await page.evaluate(async () => (await import('./app.js')).logout()); await page.waitForSelector('[role=tablist]'); await settle(page); };
  const login = async (u) => { await page.fill('input[name=username]', u); await page.fill('input[name=password]', PW); await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 }); await dismissTour(page); };
  const newClient = async (first, last) => {
    await page.goto(device + '/#/clients'); await settle(page);
    await page.click('button:has-text("New client")'); await page.waitForSelector('.modal input[name=first_name]');
    await page.fill('.modal input[name=first_name]', first); await page.fill('.modal input[name=last_name]', last);
    await page.click('.modal button[type=submit]'); await page.waitForURL(/#\/client\//, { timeout: 10000 }); await settle(page);
  };
  const clientNames = async () => (await kernel('GET', '/api/clients?status=all&limit=100')).data.clients.map(c => `${c.first_name} ${c.last_name}`).sort();

  await page.goto(device + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 15000 }); await settle(page);
  await noBanner('first run');
  eq(await selected(page), 'signup', 'with no account on the device, the page opens on Sign up');
  ok(/mode=signup/.test(page.url()), 'at #/login?mode=signup', page.url());
  await page.click('[data-mode-tab=login]'); await settle(page);
  ok(await page.$('[data-no-account] [data-restore-open]'), 'Log in on an empty device says there is no account yet, and offers to restore a backup');
  await page.click('[data-mode-tab=signup]'); await settle(page);
  ok(/nowhere else/.test(await page.textContent('[data-storage-notice]')) && /backup/.test(await page.textContent('[data-storage-notice]')), 'Sign up states once where the records are kept, and to back them up');
  await page.fill('input[name=display_name]', 'Olive Owner'); await page.fill('input[name=username]', 'owner');
  await page.fill('input[name=password]', PW); await page.fill('input[name=confirm]', PW);
  await page.click('button[type=submit]'); await settle(page);
  ok(!(await page.$('.layout')), 'the account is not created until the storage confirmation is ticked');
  await page.check('input[name=storage_ack]'); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await dismissTour(page);
  ok(await page.$('.layout'), 'ticking it creates the first account, the device administrator, and signs in');
  await noBanner('home');
  ok(!(await page.$('[data-backup-reminder]')), 'no backup reminder while the device has no clients');
  await newClient('Alpha', 'Owner');

  // ---- Home's backup reminder ----
  await page.goto(device + '/#/dashboard?_=1'); await settle(page);
  ok(await until(() => page.$('[data-backup-reminder]'), { timeout: 5000 }), 'with a client and no backup, Home shows the backup reminder');
  ok(/Last backup: never/.test(await page.textContent('[data-backup-reminder]')), 'saying "Last backup: never"');
  await page.click('[data-backup-reminder-dismiss]');
  await page.goto(device + '/#/dashboard?_=2'); await settle(page);
  ok(!(await page.$('[data-backup-reminder]')), 'dismissed, it stays away for the rest of the day');
  await page.evaluate(() => localStorage.setItem('suds.backupReminderDismissed', '2000-01-01'));
  await page.goto(device + '/#/dashboard?_=3'); await settle(page);
  ok(await page.$('[data-backup-reminder]'), 'and comes back on another day');

  // ---- the device page ----
  await page.goto(device + '/#/sync'); await settle(page);
  eq(await page.textContent('h1'), 'This device', 'the device page is called "This device"');
  await noBanner('device page');
  ok(await page.$('[data-storage-state]'), 'it shows whether the browser protects the storage', await page.textContent('[data-device-safety]').catch(() => ''));
  ok(/Protected|May be cleared by the browser/.test(await page.textContent('[data-device-safety]')), 'as "Protected" or "May be cleared by the browser"');
  ok(await page.isChecked('[data-device-accounts] input[name=signup_enabled]'), 'sign-ups on the device are on to begin with');

  // ---- a second person signs up on the same device ----
  await logout();
  eq(await selected(page), 'login', 'once the device has an account, the page opens on Log in');
  await page.click('[data-mode-tab=signup]'); await page.waitForSelector('[data-device-signup]');
  // The records are encrypted with a key only an account's password opens, so a new person is let in by
  // someone who can already log in here (ADR-0008): the form asks for them, and refuses without them.
  ok(await page.isVisible('[data-device-signup] input[name=sponsor_username]') && await page.isVisible('[data-device-signup] input[name=sponsor_password]'), 'signing up on a locked device asks for someone who can already log in here');
  await page.fill('input[name=display_name]', 'Sam Second'); await page.fill('input[name=username]', 'second');
  await page.fill('input[name=password]', PW); await page.fill('input[name=confirm]', PW); await page.click('button[type=submit]'); await settle(page);
  ok(!(await page.$('.layout')) && /already has an account on this device/.test(await page.textContent('[data-device-signup]')), 'without them the sign-up is refused, saying why');
  await page.fill('input[name=sponsor_username]', 'owner'); await page.fill('input[name=sponsor_password]', 'Wrong-Password-1!'); await page.click('button[type=submit]'); await settle(page);
  ok(!(await page.$('.layout')), 'with a wrong password for that person it is refused too');
  await page.fill('input[name=sponsor_password]', PW); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await dismissTour(page);
  const me2 = (await kernel('GET', '/api/auth/me')).data.user;
  eq(me2.role, 'navigator', 'a later sign-up is a navigator account');
  eq((await clientNames()).length, 0, 'which does not see the first person\'s clients');
  await newClient('Beta', 'Second');
  eq((await clientNames()).join(','), 'Beta Second', 'only its own');
  eq((await kernel('POST', '/api/local/backup', { passphrase: 'Long-enough-passphrase' })).status, 403, 'and it cannot take a backup of the whole device');
  eq((await kernel('PUT', '/api/local/device', { signup_enabled: false })).status, 403, 'or turn sign-ups off');
  await logout(); await login('owner');
  eq((await clientNames()).join(','), 'Alpha Owner', 'the first person still sees only their own client');

  // ---- the device administrator turns sign-ups off ----
  await page.goto(device + '/#/sync'); await settle(page);
  await page.uncheck('[data-device-accounts] input[name=signup_enabled]');
  await until(async () => (await kernel('GET', '/api/local/device')).data.signup_enabled === false, { timeout: 5000 });
  await logout();
  await page.click('[data-mode-tab=signup]'); await page.waitForSelector('[data-signup-disabled]');
  ok(/Sign-ups are turned off on this device/.test(await page.textContent('[data-signup-disabled]')), 'with sign-ups off, Sign up says so');
  eq((await kernel('POST', '/api/local/signup', { display_name: 'X', username: 'third', password: PW })).status, 403, 'and the kernel refuses a sign-up');
  await page.click('[data-mode-tab=login]'); await settle(page); await login('owner');

  // ---- backup ----
  await page.goto(device + '/#/sync'); await settle(page);
  await page.click('[data-device-safety] [data-backup-download]'); await page.waitForSelector('.modal input[name=passphrase]');
  await page.fill('.modal input[name=passphrase]', 'correct horse battery'); await page.fill('.modal input[name=confirm]', 'correct horse batteries');
  await page.click('.modal button[type=submit]'); await settle(page);
  ok(/do not match/.test(await page.textContent('.modal')), 'the passphrase is typed twice and a mismatch is caught');
  await page.fill('.modal input[name=confirm]', 'correct horse battery');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.modal button[type=submit]')]);
  const file = path.join(tmp, download.suggestedFilename()); await download.saveAs(file);
  ok(/^suds-device-backup-\d{4}-\d{2}-\d{2}\.sudsbackup$/.test(download.suggestedFilename()), 'the backup downloads as a .sudsbackup file', download.suggestedFilename());
  const raw = fs.readFileSync(file); const nl = raw.indexOf(0x0a); const header = JSON.parse(raw.subarray(0, nl).toString());
  ok(header.format === 'suds-device-backup' && header.kdf === 'PBKDF2-SHA256' && header.iterations >= 310000 && header.salt && header.iv && header.created_at && header.app_version, 'its header names the format, the key derivation (≥310k iterations), salt, iv, date and version', header);
  ok(!raw.includes(Buffer.from('SQLite format 3')) && !raw.includes(Buffer.from('Alpha')), 'and the rest is ciphertext: no database or names readable in the file');
  await page.goto(device + '/#/dashboard?_=4'); await settle(page);
  ok(!(await page.$('[data-backup-reminder]')), 'after a backup, Home no longer shows the reminder');
  await page.goto(device + '/#/sync'); await settle(page);
  eq(await page.textContent('[data-last-backup]'), 'today', '"Last backup: today" on the device page');

  // ---- erase the device ----
  await page.click('text=Erase data on this device'); await page.waitForSelector('.modal #reset-device-confirm');
  await page.fill('#reset-device-confirm', 'ERASE'); await page.click('.modal button.danger');
  await page.waitForSelector('input[name=display_name]', { timeout: 20000 }); await settle(page);
  eq(await selected(page), 'signup', 'the erased device is back at first-run Sign up');
  const tampered = path.join(tmp, 'tampered.sudsbackup'); const t = Buffer.from(raw); t[t.length - 40] ^= 0x01; fs.writeFileSync(tampered, t);
  const tryRestore = async (f, pass) => {
    await page.click('[data-restore-open]'); await page.waitForSelector('.modal input[name=backup_file]');
    await page.setInputFiles('.modal input[name=backup_file]', f); await page.fill('.modal input[name=backup_passphrase]', pass);
    await page.click('.modal [data-restore-check]');
    return until(() => page.$('.modal [data-restore-error], .modal [data-restore-preview]'), { timeout: 30000 });
  };
  await tryRestore(file, 'not the passphrase');
  ok(/passphrase does not open this backup/.test(await page.textContent('.modal [data-restore-error]').catch(() => '')), 'a wrong passphrase is refused', await page.textContent('.modal').catch(() => ''));
  await page.click('.modal button:has-text("Cancel")'); await settle(page);
  await tryRestore(tampered, 'correct horse battery');
  ok(/damaged or has been altered/.test(await page.textContent('.modal [data-restore-error]').catch(() => '')), 'a tampered file is refused', await page.textContent('.modal').catch(() => ''));
  await page.click('.modal button:has-text("Cancel")'); await settle(page);
  eq((await page.evaluate(() => window.SUDS_LOCAL.handle('GET', '/api/local/status', undefined, {}).then(r => r.json.users))), 0, 'and nothing was restored by either');
  await tryRestore(file, 'correct horse battery');
  eq(await page.getAttribute('.modal [data-restore-clients]', 'data-restore-clients'), '2', 'the right passphrase shows what the backup holds: 2 clients');
  ok(/Made/.test(await page.textContent('.modal .kv')), 'and when it was made');
  ok(await page.isDisabled('.modal [data-restore-go]'), 'restoring waits for RESTORE to be typed');
  await page.fill('.modal input[name=restore_confirm]', 'RESTORE');
  await page.click('.modal [data-restore-go]');
  await page.waitForSelector('[data-mode-tab=login][aria-selected=true]', { timeout: 20000 }); await page.waitForSelector('input[name=username]'); await settle(page);
  await login('owner');
  eq((await clientNames()).join(','), 'Alpha Owner', 'after the restore, the device administrator\'s client is back');
  const audit = await page.evaluate(() => window.SUDS_LOCAL.handle('GET', '/api/local/device', undefined, {}).then(r => r.json));
  ok(audit && audit.last_backup_at && audit.users === 2, 'with both accounts and the backup date', audit);
  await logout(); await login('second');
  eq((await clientNames()).join(','), 'Beta Second', 'and so is the second person\'s');
  await ctx.close();
}

finish(errors);
await browser.close();

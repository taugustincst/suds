// The owner's recovery code on SUDS on this device (docs/architecture/ADR-0008-device-encryption.md, "Recovery
// code"), on the static build in a real browser: set-up shows the code once and will not go on until "I have
// saved my recovery code" is ticked; the file it downloads holds the code; the locked sign-in page's "Can't sign
// in?" lists the ways back in; a wrong code is refused on the form; the right one sets a new password, keeps
// the records and shows a new code; the old password and the used code stop working; a device set up
// before this release (no code) is asked for one on Home until it has one; and when the device administrator is
// deactivated, their code stops working and the administrator who took over is asked for a new one (1.15.4).
import * as pw from 'playwright';
import fs from 'node:fs';
import { makeChecks, until, settle, saved, passRecoveryCode } from './assert.mjs';

const base = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8878';
const { ok, eq, finish } = makeChecks('device-recovery');
const PW = 'Navigator2026!!'; const NEW_PW = 'Recovered-Pass-2026!';
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
// SUDS_BROWSER=webkit runs it in WebKit: CI's advisory webkit job does, for section 6 (1.25.4, G2).
const browser = await pw[process.env.SUDS_BROWSER || 'chromium'].launch();
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', e => errors.push(`PAGEERROR (${tag}) ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_|region-pictures/.test(m.text())) errors.push(`CONSOLE (${tag}) ${m.text().slice(0, 300)}`); });
  return page;
};
const kernel = (page, method, p, body) => page.evaluate(async ([method, p, body]) => { const r = await window.SUDS_LOCAL.handle(method, p, body, { 'X-Requested-With': 'suds' }); return { status: r.status, json: r.json }; }, [method, p, body]);
const phase = (page) => page.evaluate(() => window.SUDS_LOCAL.phase());
const logout = async (page) => { await page.evaluate(async () => (await import('./app.js')).logout()); await page.waitForSelector('.login input[name=username]'); await settle(page); };
async function tryLogin(page, username, password) {
  await page.fill('.login input[name=username]', username); await page.fill('.login input[name=password]', password);
  await page.click('.login button[type=submit]');
  return until(async () => (await page.$('.layout')) ? 'in' : ((await page.$('.login .banner.danger:not(.hidden)')) ? 'refused' : null), { timeout: 20000 });
}
// "Can't sign in?" → Use your recovery code: 'in' (the new-code screen) or the error shown under the code.
async function useCode(page, code, { username = '', password = NEW_PW } = {}) {
  await page.click('[data-cant-sign-in] [data-recover-open]'); await page.waitForSelector('.modal input[name=code]');
  await page.fill('.modal input[name=code]', code); if (username) await page.fill('.modal input[name=username]', username);
  await page.fill('.modal input[name=password]', password); await page.fill('.modal input[name=confirm]', password);
  await page.click('.modal button[type=submit]');
  const out = await until(async () => (await page.$('[data-recovery-screen]')) ? 'in' : ((await page.$('.modal [data-field=code].error')) ? 'refused' : null), { timeout: 30000 });
  if (out === 'refused') {
    const said = (await page.textContent('.modal .banner.danger')).trim();
    await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal')), { timeout: 5000 });
    return { out, said };
  }
  await settle(page);
  return { out };
}

// ---------------------------------------------------------------------------------------------------------
// 1. Set-up: the code is shown once, downloaded, and "I have saved my recovery code" is required.
// ---------------------------------------------------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 }, acceptDownloads: true });
  const page = watch(await ctx.newPage(), 'recovery');
  await page.goto(base + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 20000 });
  ok(/recovery code/.test(await page.textContent('[data-storage-notice]')), 'the set-up screen says a recovery code comes next');
  await page.fill('input[name=display_name]', 'Device Owner'); await page.fill('input[name=username]', 'owner');
  await page.fill('input[name=password]', PW); await page.fill('input[name=confirm]', PW);
  await page.selectOption('select[name=role]', 'admin');
  await page.check('input[name=storage_ack]'); await page.click('button[type=submit]');
  await page.waitForSelector('[data-recovery-screen]', { timeout: 30000 }); await settle(page);
  ok(/#\/recovery-code/.test(page.url()), 'creating the first account goes to the recovery code screen', page.url());
  const code1 = (await page.textContent('[data-recovery-code]')).trim();
  ok(CODE.test(code1), 'which shows a code of seven groups of four letters and numbers', code1);
  ok(/only time it is shown/.test(await page.textContent('[data-recovery-warning]')) && /whoever has the code can open every record/.test(await page.textContent('[data-recovery-warning]')), 'and says it is shown once, and that it opens every record like a key');
  eq(await page.title(), 'Recovery code — SUDS', 'the page has its own title');
  ok(await page.$('[data-recovery-print]'), 'it can be printed');
  // 1.15.4 (L1): printing comes first, and saving says to put the file on another device.
  ok(await page.$eval('[data-recovery-print]', b => b.classList.contains('primary') && !b.previousElementSibling), 'Print is the first, main choice');
  ok(/another device/i.test(await page.textContent('[data-recovery-download]')), 'saving is "Save to another device"', await page.textContent('[data-recovery-download]'));
  ok(/not on this device/.test(await page.textContent('[data-recovery-file-hint]')), 'and says to keep the file off this device');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-recovery-download]')]);
  const file = fs.readFileSync(await download.path(), 'utf8');
  ok(/^suds-recovery-code-\d{4}-\d{2}-\d{2}\.txt$/.test(download.suggestedFilename()), 'it downloads as a text file', download.suggestedFilename());
  ok(file.includes(code1) && /Use your recovery code/.test(file), 'holding the code and how to use it');
  ok(/delete it from the device/.test(file), 'and saying to move it off the device');
  // Continue without the box ticked: refused, on the same screen.
  await page.click('[data-recovery-screen] button[type=submit]'); await settle(page);
  ok(await page.$('[data-recovery-screen] [data-field=saved].error'), 'Continue without ticking "I have saved my recovery code" is refused');
  ok(await page.$('[data-recovery-screen]'), 'and the code stays on screen');
  eq((await kernel(page, 'GET', '/api/local/device')).json.recovery.saved, false, 'the device knows it is not yet confirmed as saved');
  eq(await passRecoveryCode(page), code1, 'ticking the box and Continue goes on');
  ok(/#\/dashboard/.test(page.url()), 'to Home', page.url());
  ok(!(await page.$('[data-recovery-prompt]')), 'where nothing asks for a recovery code: this device has one');
  const dev = (await kernel(page, 'GET', '/api/local/device')).json;
  ok(dev.recovery.exists && dev.recovery.saved && !JSON.stringify(dev).includes(code1.replace(/-/g, '')), 'the device records that a code exists and was saved, and not the code', dev.recovery);
  await page.goto(base + '/#/sync'); await settle(page);
  eq(await page.getAttribute('[data-device-recovery] [data-recovery-state]', 'data-recovery-state'), 'saved', 'This device says there is a recovery code and when it was made');
  const c = await kernel(page, 'POST', '/api/clients', { first_name: 'Rhiannon', last_name: 'Recoverable', status: 'active' });
  eq(c.status, 201, 'a client is recorded');
  await saved(page);

  // -------------------------------------------------------------------------------------------------------
  // 2. Locked out: "Can't sign in?", a wrong code, the right code.
  // -------------------------------------------------------------------------------------------------------
  await logout(page);
  await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 }); await settle(page);
  eq(await phase(page), 'locked', 'after a reload the device is locked');
  const ways = await page.textContent('[data-cant-sign-in]');
  ok(/Can’t sign in\?/.test(ways), 'the sign-in page has a "Can’t sign in?" section');
  ok(await page.$('[data-way-back=recovery] [data-recover-open]') && /Keeps every record/.test(await page.textContent('[data-way-back=recovery]')), 'offering the recovery code, which keeps every record');
  ok(await page.$('[data-way-back=backup] [data-restore-open]') && /lost/.test(await page.textContent('[data-way-back=backup]')), 'restoring a backup, which loses what was added since');
  ok(await page.$('[data-way-back=start-over] [data-device-reset-open]') && /Nothing is kept/.test(await page.textContent('[data-way-back=start-over]')), 'and starting over, which keeps nothing');
  const wrong = await useCode(page, '7K3M-Q9TD-7K3M-Q9TD-7K3M-Q9TD-7K3M');
  eq(wrong.out, 'refused', 'a wrong recovery code is refused');
  ok(/recovery code is not right/.test(wrong.said), 'with a plain message', wrong.said);
  eq(await phase(page), 'locked', 'and the device stays locked');
  const malformed = await useCode(page, 'ABCD-1234');
  ok(malformed.out === 'refused' && /28 letters and numbers/.test(malformed.said), 'a code of the wrong shape is said so', malformed);
  // Typed as someone might: lower case, spaces for dashes. The username left empty: SUDS knows whose it is.
  const right = await useCode(page, code1.toLowerCase().replace(/-/g, ' '));
  eq(right.out, 'in', 'the right code opens the device');
  ok(/You are back in/.test(await page.textContent('[data-recovered]')) && /“owner”/.test(await page.textContent('[data-recovered]')), 'and says so, naming the username', await page.textContent('[data-recovered]'));
  const code2 = (await page.textContent('[data-recovery-code]')).trim();
  ok(CODE.test(code2) && code2 !== code1, 'a new code is shown at once, on the same screen as at set-up', code2);
  ok(await page.$('[data-recovery-screen] input[name=saved]'), 'with the same "I have saved my recovery code" box');
  await passRecoveryCode(page);
  const back = await kernel(page, 'GET', '/api/clients?limit=10');
  ok(back.json.clients.some(x => x.last_name === 'Recoverable'), 'the records are all still there', back.json.clients.map(x => x.last_name));
  eq((await kernel(page, 'GET', '/api/auth/me')).json.user.username, 'owner', 'signed in as the device administrator');

  // -------------------------------------------------------------------------------------------------------
  // 3. Afterwards: the forgotten password and the used code are dead; the new password and new code work.
  // -------------------------------------------------------------------------------------------------------
  await logout(page);
  eq(await tryLogin(page, 'owner', PW), 'refused', 'the forgotten password no longer opens the device');
  await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 }); await settle(page);
  const old = await useCode(page, code1);
  eq(old.out, 'refused', 'the code that was used is refused');
  eq(await tryLogin(page, 'owner', NEW_PW), 'in', 'the new password opens it');
  // A new code from This device replaces the one shown at recovery.
  await page.goto(base + '/#/sync'); await settle(page);
  await page.click('[data-recovery-new]'); await page.waitForSelector('.modal input[name=password]');
  ok(await page.$('.modal [data-recovery-replaces]'), 'making a new code says the old one stops working');
  await page.fill('.modal input[name=password]', 'Not-My-Password-1!'); await page.click('.modal button[type=submit]');
  ok(await until(() => page.$('.modal .banner.danger:not(.hidden)'), { timeout: 10000 }), 'the wrong password makes no code');
  ok(await page.$('.layout'), 'and does not sign the person out');
  await page.fill('.modal input[name=password]', NEW_PW); await page.click('.modal button[type=submit]');
  await page.waitForSelector('[data-recovery-screen]', { timeout: 20000 });
  const code3 = await passRecoveryCode(page);
  ok(CODE.test(code3 || '') && code3 !== code2, 'the device administrator makes a new recovery code after typing their password again', code3);
  ok(/#\/sync/.test(page.url()), 'and goes back to This device', page.url());
  await logout(page);
  const stale = await kernel(page, 'POST', '/api/local/recover', { code: code2, password: NEW_PW });
  ok(stale.status === 400 && stale.json.wrongRecoveryCode, 'the code it replaced no longer works', stale.json);
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------
// 4. A device set up before this release has no code: Home asks its administrator until there is one.
// ---------------------------------------------------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const page = watch(await ctx.newPage(), 'older device');
  await page.goto(base + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 20000 });
  // Set up the way 1.14 did (no code made): the account straight through the kernel.
  eq((await kernel(page, 'POST', '/api/local/signup', { display_name: 'Older Owner', username: 'older', password: PW, role: 'admin', storage_ack: true })).status, 200, 'older device: set up without a recovery code');
  eq((await kernel(page, 'POST', '/api/local/signup', { display_name: 'Older Colleague', username: 'olnav', password: PW })).status, 200, 'older device: and a second account');
  // Saved before the reload, as the app's own writes are (public/app.js waits for the save after an explicit write):
  // these went straight to the kernel, and WebKit drops a page's last write on its way out (the webkit job, 1.25.4).
  await page.evaluate(() => window.SUDS_LOCAL.flush());
  ok(!(await page.evaluate(() => window.SUDS_LOCAL.isDirty())), 'older device: both accounts are saved');
  // The page was on first-run Sign up: open Log in.
  await page.goto(base + '/#/login?mode=login'); await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 }); await settle(page);
  ok(/has none yet/.test(await page.textContent('[data-way-back=recovery]')) && !(await page.$('[data-recover-open]')), 'older device: the sign-in page says it has no recovery code yet');
  eq(await tryLogin(page, 'olnav', PW), 'in', 'older device: a navigator signs in');
  await settle(page);
  ok(!(await page.$('[data-recovery-prompt]')), 'older device: a navigator is not asked for a recovery code');
  eq((await kernel(page, 'POST', '/api/local/recovery', { password: PW })).status, 403, 'older device: nor may they make one');
  await logout(page);
  eq(await tryLogin(page, 'older', PW), 'in', 'older device: its administrator signs in');
  const prompt = await until(() => page.$('[data-recovery-prompt=none]'), { timeout: 10000 });
  ok(prompt, 'older device: Home asks for a recovery code');
  ok(/no recovery code/.test(await page.textContent('[data-recovery-prompt]')), 'older device: saying the device has none');
  await page.click('[data-recovery-prompt-dismiss]'); await settle(page);
  ok(!(await page.$('[data-recovery-prompt]')), 'older device: it can be dismissed');
  await page.goto(base + '/#/dashboard?_=1'); await settle(page);
  ok(!(await page.$('[data-recovery-prompt]')), 'older device: and stays away for the rest of that sign-in');
  await page.goto(base + '/#/sync'); await settle(page);
  eq(await page.getAttribute('[data-device-recovery] [data-recovery-state]', 'data-recovery-state'), 'none', 'older device: This device says there is none yet');
  await logout(page);
  eq(await tryLogin(page, 'older', PW), 'in', 'older device: signing in again');
  ok(await until(() => page.$('[data-recovery-prompt]'), { timeout: 10000 }), 'older device: the prompt is back until a code is made');
  await page.click('[data-recovery-prompt-make]'); await page.waitForSelector('.modal input[name=password]');
  await page.fill('.modal input[name=password]', PW); await page.click('.modal button[type=submit]');
  await page.waitForSelector('[data-recovery-screen]', { timeout: 20000 });
  ok(CODE.test(await passRecoveryCode(page) || ''), 'older device: the administrator makes one from the prompt');
  await page.goto(base + '/#/dashboard?_=2'); await settle(page);
  ok(!(await page.$('[data-recovery-prompt]')), 'older device: and Home stops asking');
  // 5. (1.15.4, L1) The administrator who deactivates the device administrator takes over, the old code stops
  // working, and Home asks the new one for a code of their own.
  const accounts = (await kernel(page, 'GET', '/api/local/accounts')).json.rows;
  const olnav = accounts.find(a => a.username === 'olnav'); const older = accounts.find(a => a.username === 'older');
  eq((await kernel(page, 'PUT', `/api/local/accounts/${olnav.id}`, { role: 'admin' })).status, 200, 'handover: the second account is made an administrator');
  await logout(page);
  eq(await tryLogin(page, 'olnav', PW), 'in', 'handover: who signs in');
  eq((await kernel(page, 'PUT', `/api/users/${older.id}`, { is_active: false })).status, 200, 'handover: and deactivates the first administrator');
  await page.goto(base + '/#/dashboard?_=3'); await settle(page);
  const handed = await until(() => page.$('[data-recovery-prompt=none]'), { timeout: 10000 });
  ok(handed, 'handover: Home asks the new administrator for a recovery code');
  ok(/code of the person who managed it before no longer works/.test(await page.textContent('[data-recovery-prompt]')), 'handover: saying the old one no longer works', await page.textContent('[data-recovery-prompt]'));
  await page.goto(base + '/#/sync'); await settle(page);
  ok(await page.$('[data-device-recovery] [data-recovery-dropped="device_admin_changed"]'), 'handover: This device says why there is none');
  await logout(page);
  ok(/has none yet/.test(await page.textContent('[data-way-back=recovery]')) && !(await page.$('[data-recover-open]')), 'handover: the sign-in page no longer offers the old code');
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------
// 6. (1.25.4, G2) A device database that will not open: WebKit once failed a sign-in after a reload with
// "malformed database schema (audit_log) - string or blob too big". The image is sealed (AES-GCM), so what can
// reach SQLite is a valid seal over a bad image: here the page's WebCrypto seals a cut-short image at sign-out.
// After a reload the sign-in is refused plainly, the damaged copy can be saved as a file, and Start over then
// Restore from a backup brings the records back.
// ---------------------------------------------------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 }, acceptDownloads: true });
  const page = await ctx.newPage(); const mine = [];
  page.on('pageerror', e => mine.push(`PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_|region-pictures|the device database would not open/.test(m.text())) mine.push(`CONSOLE ${m.text().slice(0, 300)}`); });
  await page.goto(base + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 20000 });
  eq((await kernel(page, 'POST', '/api/local/signup', { display_name: 'Damaged Owner', username: 'dmg', password: PW, role: 'admin', storage_ack: true })).status, 200, 'damaged: a device is set up');
  eq((await kernel(page, 'POST', '/api/auth/login', { username: 'dmg', password: PW })).status, 200, 'damaged: and signed in');
  eq((await kernel(page, 'POST', '/api/clients', { first_name: 'Damaged', last_name: 'Keeper', status: 'active' })).status, 201, 'damaged: a client');
  const backup = await page.evaluate(async () => { const r = await window.SUDS_LOCAL.handle('POST', '/api/local/backup', { passphrase: 'damaged device passphrase' }, { 'X-Requested-With': 'suds' }); let s = ''; for (const b of new Uint8Array(r.body)) s += String.fromCharCode(b); return btoa(s); });
  const backupFile = `${process.env.SUDS_UI_TMP || '/tmp'}/suds-ui-damaged.sudsbackup`; fs.writeFileSync(backupFile, Buffer.from(backup, 'base64'));
  // Everything written so far saved first; then the next sealed save of the image (at sign-out) seals it cut short.
  await page.evaluate(async () => { await window.SUDS_LOCAL.flush(); });
  ok(!(await page.evaluate(() => window.SUDS_LOCAL.isDirty())), 'damaged: everything written so far is saved');
  await page.evaluate(() => {
    const s = crypto.subtle; const real = s.encrypt.bind(s);
    s.encrypt = (alg, key, data) => { if (new TextDecoder().decode(alg.additionalData || new Uint8Array()) === 'suds-device-db/v1') { const b = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength); data = b.slice(0, Math.floor(b.length / 2) + 100); s.encrypt = real; window.damagedSeals = (window.damagedSeals || 0) + 1; } return real(alg, key, data); };
  });
  ok((await kernel(page, 'POST', '/api/auth/logout', {})).status < 300, 'damaged: signed out, the cut-short image sealed and stored');
  eq(await page.evaluate(() => window.damagedSeals), 1, 'damaged: the sign-out\'s save sealed the cut-short image');
  await page.goto(base + '/#/login?mode=login'); await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 }); await settle(page);
  eq(await tryLogin(page, 'dmg', PW), 'refused', 'damaged: after a reload the sign-in is refused');
  ok(/could not be opened/.test(await page.textContent('.login .banner.danger:not(.hidden)')) && /Nothing has been deleted/.test(await page.textContent('.login')), 'damaged: saying plainly that the records could not be opened and nothing was deleted', await page.textContent('.login'));
  ok(await page.$('[data-device-damaged][role=alert] [data-damaged-save]'), 'damaged: with a button to save the damaged copy');
  eq(await phase(page), 'locked', 'damaged: nothing was opened');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('[data-damaged-save]')]);
  const copy = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(copy.format === 'suds-damaged-device-db' && copy.image && copy.image.ct && copy.image.ct.b64 && copy.vault && /pages|whole number/.test(copy.why), 'damaged: the saved file holds the sealed image, the vault that opens it and what was found', { format: copy.format, why: copy.why });
  // Start over, then Restore from a backup: the existing way back.
  await page.click('[data-cant-sign-in] [data-device-reset-open]'); await page.waitForSelector('.modal #reset-device-confirm');
  await page.fill('#reset-device-confirm', 'ERASE'); await page.click('.modal button.danger');
  await page.waitForSelector('input[name=display_name]', { timeout: 20000 }); await settle(page);
  await page.click('[data-restore-open]'); await page.waitForSelector('.modal input[name=backup_file]');
  await page.setInputFiles('.modal input[name=backup_file]', backupFile); await page.fill('.modal input[name=backup_passphrase]', 'damaged device passphrase');
  await page.click('.modal [data-restore-check]'); await page.waitForSelector('.modal [data-restore-preview]', { timeout: 30000 });
  await page.fill('.modal input[name=restore_confirm]', 'RESTORE'); await page.click('.modal [data-restore-go]');
  await page.waitForSelector('[data-mode-tab=login][aria-selected=true]', { timeout: 20000 }); await settle(page);
  eq(await tryLogin(page, 'dmg', PW), 'in', 'damaged: after Start over and the restore, the same account signs in');
  ok(((await kernel(page, 'GET', '/api/clients')).json.clients || []).some(c => c.last_name === 'Keeper'), 'damaged: and the client is back');
  fs.rmSync(backupFile, { force: true });
  errors.push(...mine);
  await ctx.close();
}

finish(errors.slice(0, 10));
await browser.close();

// The owner's recovery code on SUDS on this device (docs/architecture/ADR-0008-device-encryption.md, "Recovery
// code"), on the static build in a real browser: set-up shows the code once and will not go on until "I have
// saved my recovery code" is ticked; the file it downloads holds the code; the locked sign-in page's "Can't sign
// in?" lists the ways back in; a wrong code is refused on the form; the right one sets a new password, keeps
// the records and shows a new code; the old password and the used code stop working; and a device set up
// before this release (no code) is asked for one on Home until it has one.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { makeChecks, until, settle, saved, passRecoveryCode } from './assert.mjs';

const base = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8878';
const { ok, eq, finish } = makeChecks('device-recovery');
const PW = 'Navigator2026!!'; const NEW_PW = 'Recovered-Pass-2026!';
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
const browser = await chromium.launch();
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
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-recovery-download]')]);
  const file = fs.readFileSync(await download.path(), 'utf8');
  ok(/^suds-recovery-code-\d{4}-\d{2}-\d{2}\.txt$/.test(download.suggestedFilename()), 'it downloads as a text file', download.suggestedFilename());
  ok(file.includes(code1) && /Use your recovery code/.test(file), 'holding the code and how to use it');
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
  eq((await kernel(page, 'POST', '/api/local/signup', { display_name: 'Older Navigator', username: 'olnav', password: PW })).status, 200, 'older device: and a second account');
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
  await ctx.close();
}

finish(errors.slice(0, 10));
await browser.close();

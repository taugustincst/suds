// First-run setup, the way a county actually does it: a production server with no configuration, the
// wizard in a browser, then sign in over the HTTPS address it chose and take the first backup.
//
// Needs a fresh production server (run-all.sh starts one): the wizard restarts it on the port it is
// given, with a self-signed certificate.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';
const base = process.env.SUDS_SETUP_URL || 'http://127.0.0.1:8095';
let port = Number(process.env.SETUP_PORT || 8496);
const { ok, eq, finish } = makeChecks('setup');
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
// The service worker cannot install behind a certificate the browser does not trust; a county trusts the
// self-signed one once per device, the test never does. Everything else on the console is a defect.
page.on('console', m => { if (m.type() === 'error' && !/40[13]|net::ERR|Failed to fetch|SSL certificate error/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 200)); });

await page.goto(base + '/'); await settle(page);
ok(/#\/setup$/.test(page.url()), 'an unconfigured server opens on the setup wizard, not a sign-in', page.url());
await page.fill('input[name=org_name]', 'Demo County SUD Navigation'); await page.fill('input[name=admin_display_name]', 'Pat Admin'); await page.fill('input[name=admin_username]', 'padmin');
await page.fill('input[name=admin_password]', 'SetupPassw0rd!x'); await page.fill('input[name=confirm]', 'SetupPassw0rd!x');
// The port lives under "Advanced", collapsed: a county leaves it blank and gets the standard port. The
// test cannot bind 443, so it opens the section and picks one -- unless PORT is set in the environment
// (run-all.sh sets it), in which case the wizard must not offer to change it and the server stays where
// IT put it, switching HTTPS on in place.
await page.evaluate(() => document.querySelectorAll('details.section').forEach(d => { d.open = true; }));
const status = await page.evaluate(() => fetch('/api/setup/status').then(r => r.json()));
if (status.port_env) {
  ok(!(await page.$('input[name=port]')), 'with PORT fixed by the environment the wizard offers no port field');
  ok(await page.$('[data-port-env]'), 'and says why');
  port = Number(new URL(base).port);
} else {
  ok(await page.$('input[name=port]'), 'without PORT in the environment the wizard offers a port field');
  await page.fill('input[name=port]', String(port));
}
eq(await page.$eval('input[name=https]', e => e.checked), true, 'HTTPS is on by default');
eq(await page.$eval('select[name=network]', e => e.value), 'lan', 'phones on the office network are allowed by default');
// Offline copies are a deliberate choice: the wizard asks, and the recommended answer (No) is preselected.
eq(status.local_mode_env, false, 'LOCAL_MODE_ENABLED is not set for the wizard server, so the wizard decides local mode');
eq(await page.$eval('select[name=local_mode]', e => e.value).catch(() => null), 'no', 'the wizard asks about offline copies and defaults to No');
ok(/offline copy on their devices\? Recommended: No/.test(await page.textContent('#app')), 'with the recommendation in the question');
await page.click('button[type=submit]');
ok(await until(() => page.textContent('#app').then(t => /Setup complete/.test(t)), { timeout: 20000 }), 'the wizard completes');
const done = (await page.textContent('#app')).replace(/\s+/g, ' ');
// When the wizard fails it says why in a banner; that reason is what a reader of this log needs.
const wizardError = await page.$eval('.banner.danger, .banner.error, .err', e => e.textContent).catch(() => '');
if (wizardError) console.log('  wizard said: ' + wizardError.slice(0, 300));
ok(/Back up your encryption keys/.test(done), 'and tells the administrator to back up the generated keys');
ok(new RegExp(`https://[^\\s]*:${port}`).test(done), `and shows the HTTPS address it is now listening on (port ${port})`, done.slice(0, 200));

const after = `https://127.0.0.1:${port}`;
await page.goto(after + '/#/login'); await settle(page);
await page.fill('input[name=username]', 'padmin'); await page.fill('input[name=password]', 'SetupPassw0rd!x'); await page.click('button[type=submit]');
await page.waitForSelector('.layout', { timeout: 10000 }).catch(() => {});
ok(await page.$('.layout'), 'the administrator signs in over HTTPS at the new address');
// The wizard's No is honoured straight away: the server serves the explanation, not the kernel.
{
  const lp = await ctx.newPage(); await lp.goto(after + '/?local=1'); await lp.waitForSelector('h1', { timeout: 10000 }).catch(() => {}); // a static page: no app to settle
  ok(/Local mode is turned off/.test(await lp.textContent('body')), 'after answering No, /?local=1 explains that local mode is off');
  eq((await ctx.request.get(after + '/local/kernel.js')).status(), 404, 'and the kernel is not served');
  await lp.close();
}
await page.keyboard.press('Escape');
// Nothing to protect yet, so the setup card must lead with the one step that cannot wait: the key backup.
await page.goto(after + '/#/dashboard'); await settle(page);
ok(/Save a copy of your encryption keys/.test(await page.textContent('#app')), 'Home asks for the key backup first');
await page.goto(after + '/#/admin?tab=system'); await settle(page);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('text=Download encrypted backup')]);
ok(/\.enc$|\.db/.test(dl.suggestedFilename()), 'the first encrypted backup downloads', dl.suggestedFilename());
const [kdl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('text=Download key backup')]);
ok(/KEEP-SECRET/.test(kdl.suggestedFilename()), 'and so does the key backup, named so nobody files it casually', kdl.suggestedFilename());
const again = await page.evaluate(() => fetch('/api/setup/status').then(r => r.json()));
eq(again.needed, false, 'setup cannot be run a second time');
const plainHttp = await ctx.request.get(base + '/api/health', { timeout: 5000 }).then(r => r.status()).catch(() => 'refused');
ok(plainHttp === 'refused' || plainHttp >= 400, 'the old plain-HTTP address no longer serves', plainHttp);
finish(errors);
await browser.close();

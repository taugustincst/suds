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
// The service worker cannot be fetched over the wizard's self-signed certificate: Chrome says "SSL certificate
// error" or "An unknown error occurred when fetching the script" for the same thing.
page.on('console', m => { if (m.type() === 'error' && !/40[13]|net::ERR|Failed to fetch|SSL certificate error|An unknown error occurred when fetching the script/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 200)); });

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
// Offline copies are a deliberate choice: the wizard asks, and preselects the answer it recommends for the
// programme profile — Yes for harm reduction & outreach (field work without signal), No for treatment-adjacent.
eq(status.local_mode_env, false, 'LOCAL_MODE_ENABLED is not set for the wizard server, so the wizard decides local mode');
const offlineField = () => page.$eval('[data-field=local_mode]', e => ({ value: e.querySelector('select').value, label: e.querySelector('label').textContent, help: (e.querySelector('.help') || {}).textContent || '', options: [...e.querySelectorAll('option')].map(o => o.value) })).catch(() => null);
let off = await offlineField();
eq(off && off.value, 'yes', 'for a harm-reduction programme the wizard recommends offline copies and preselects Yes');
ok(off && /offline copy on their devices\? Recommended: Yes/.test(off.label), 'with the recommendation in the question', off);
ok(off && /forget it, anything on that device that has not been synced yet cannot be recovered/.test(off.help), 'and says honestly what a forgotten password costs', off && off.help);
await page.selectOption('select[name=programme_profile]', 'treatment');
off = await offlineField();
eq(off && off.value, 'no', 'a treatment-adjacent programme keeps the recommendation No');
ok(off && /Recommended: No/.test(off.label) && /forget it/.test(off.help), 'its question and help say so', off);
await page.selectOption('select[name=programme_profile]', 'harm_reduction');
eq((await offlineField())?.value, 'yes', 'back to harm reduction: Yes again');
// An answer given by hand is kept when the profile changes; this run answers No, which the rest checks.
await page.selectOption('select[name=local_mode]', 'no');
await page.selectOption('select[name=programme_profile]', 'treatment');
await page.selectOption('select[name=programme_profile]', 'harm_reduction');
eq((await offlineField())?.value, 'no', 'a hand-picked answer is not overwritten by the profile');
// The programme profile: harm reduction & outreach unless the county says it is treatment-adjacent.
eq(await page.$eval('select[name=programme_profile]', e => e.value).catch(() => null), 'harm_reduction', 'the wizard asks what kind of programme this is and defaults to harm reduction & outreach');
// The programme's main fund (optional) becomes the default for new visits.
ok(await page.$('input[name=main_fund_name]'), 'the wizard asks for the programme\'s main funding source');
// 1.14.0: what kind of funding it is. The placeholder's example is settlement money, and a fund named as
// settlement money is taken to be that (it used to be created as "other", and never reached the settlement
// report); settlement money is also asked its allowable use.
ok(await page.$('select[name=main_fund_type]'), 'the wizard asks what kind of funding it is');
ok(await page.$eval('[data-field=main_fund_settlement_use]', e => e.classList.contains('hidden')).catch(() => false), 'the settlement category is not asked of a fund that is not settlement money');
await page.fill('input[name=main_fund_name]', 'County opioid settlement allocation');
eq(await page.inputValue('select[name=main_fund_type]'), 'opioid_settlement', 'a fund named as settlement money is taken to be opioid settlement');
ok(await page.$eval('[data-field=main_fund_settlement_use]', e => !e.classList.contains('hidden')).catch(() => false), 'and asks its allowable use, as Funding & spending does');
const fundTypes = await page.$$eval('select[name=main_fund_type] option', o => o.map(x => x.textContent));
ok(fundTypes.includes('SOR grant') && fundTypes.includes('SAMHSA') && !fundTypes.some(t => /Sor Grant|Samhsa/.test(t)), 'the funding types in words', fundTypes);
await page.selectOption('select[name=main_fund_settlement_use]', 'approved_h');
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
{
  const me = await page.evaluate(() => fetch('/api/auth/me', { headers: { 'X-Requested-With': 'suds' } }).then(r => r.json()));
  eq(me.programme && me.programme.profile, 'harm_reduction', 'the new install is a harm-reduction programme');
  // The clinical modules; SUPRT-A and publication releases (1.14.0) are programme modules too, but not clinical:
  // publication releases are on by default, SUPRT-A only with a SOR grant fund.
  const mods = (me.programme && me.programme.modules) || { careplan: true };
  eq(['careplan', 'assessments', 'caloms', 'fhir', 'handoff'].some(k => mods[k]), false, 'with every clinical module switched off');
  eq(mods.publication, true, 'and publication releases on, as a new install starts');
  const funds = await page.evaluate(() => fetch('/api/budget/funds', { headers: { 'X-Requested-With': 'suds' } }).then(r => r.json()));
  const main = (funds.funds || []).find(f => f.name === 'County opioid settlement allocation');
  ok(main, 'the main funding source named in the wizard exists', JSON.stringify(funds).slice(0, 200));
  eq(me.default_fund_id, main && main.id, 'and is the default fund for new visits');
  eq(main && main.source_type, 'opioid_settlement', 'as opioid settlement money');
  eq(main && main.settlement_use, 'approved_h', 'with the allowable use chosen in the wizard');
  const settle1 = await page.evaluate(() => fetch('/api/reports/opioid-settlement?purpose=internal&counts=exact', { headers: { 'X-Requested-With': 'suds' } }).then(r => r.json()));
  ok((settle1.funds || []).some(f => f.name === 'County opioid settlement allocation'), 'so it reaches the settlement report', settle1.funds);
}
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
// A production Home: no "Load sample data" in front of the administrator (it stays under Settings), and the
// audit-anchor finding as a plain sentence with a link, amber rather than a red pill.
ok(!(await page.$('[data-sample-banner]')), 'a production server\'s Home does not offer sample data');
const anchorNote = await page.$('[data-security-alert=audit_anchor_dir]');
ok(anchorNote, 'Home says the audit log\'s safety copies are on the database disk');
eq(anchorNote && await anchorNote.getAttribute('data-severity'), 'warn', 'amber: a finding, not an alarm');
ok(anchorNote && await anchorNote.evaluate(e => e.classList.contains('warn') && !e.classList.contains('danger')), 'and drawn amber');
const anchorText = anchorNote ? (await anchorNote.textContent()).replace(/\s+/g, ' ') : '';
ok(/Ask your IT support/.test(anchorText) && /LOGGING-AND-AUDIT\.md/.test(anchorText), 'in words that say who fixes it and where the steps are', anchorText);
eq(anchorNote && await anchorNote.$eval('a', a => a.getAttribute('href')), '#/admin?tab=security', 'with a link to Security status');
ok(!/Set the opioid-settlement category/.test(await page.textContent('#app')), 'the wizard\'s settlement fund already has its category, so Home does not ask for it');
await page.goto(after + '/#/admin?tab=system'); await settle(page);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('text=Download encrypted backup')]);
ok(/\.enc$|\.db/.test(dl.suggestedFilename()), 'the first encrypted backup downloads', dl.suggestedFilename());
// The key backup asks the administrator to prove it is them with every download (1.14.0: the password or
// authenticator code, even this soon after signing in): the server refuses a session alone.
await page.click('text=Download key backup');
const keyDialog = page.getByRole('dialog', { name: 'Download the key backup' });
ok(await keyDialog.waitFor({ timeout: 5000 }).then(() => true, () => false), 'the key backup opens a dialog that asks the administrator to confirm it is them');
const keyPw = keyDialog.getByLabel(/Re-enter your password/);
ok(await keyPw.isVisible().catch(() => false), 'it asks for the password even straight after signing in');
await keyPw.fill('SetupPassw0rd!x');
const [kdl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), keyDialog.getByRole('button', { name: 'Download the key backup' }).click()]);
ok(/KEEP-SECRET/.test(kdl.suggestedFilename()), 'and so does the key backup, named so nobody files it casually', kdl.suggestedFilename());
const again = await page.evaluate(() => fetch('/api/setup/status').then(r => r.json()));
eq(again.needed, false, 'setup cannot be run a second time');
const plainHttp = await ctx.request.get(base + '/api/health', { timeout: 5000 }).then(r => r.status()).catch(() => 'refused');
ok(plainHttp === 'refused' || plainHttp >= 400, 'the old plain-HTTP address no longer serves', plainHttp);
finish(errors);
await browser.close();

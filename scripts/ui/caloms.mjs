// CalOMS Tx state reporting in a real browser: an administrator turns it on with a provider ID; the
// admission dialog then asks the CalOMS questions (and refuses to open the episode without them); the
// episode shows its CalOMS records; the validation report lists a missing admission by client code and
// field; a supervisor downloads the extract, a navigator cannot; and the county EHR hand-off says plainly
// that SUDS does not submit Drug Medi-Cal claims.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, finish } = makeChecks('caloms');
const errors = [];
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
async function session(user, pass) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
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
  return { page, ctx, api };
}
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await settle(page); };
const today = new Date().toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-5);

// ---------------- administrator: switch CalOMS on ----------------
const adm = await session('admin', 'AdminPassw0rd!x');
{
  const { page } = adm;
  await go(page, 'caloms');
  eq(await page.getAttribute('[data-caloms-status]', 'data-caloms-status'), 'off', 'CalOMS reporting starts switched off');
  ok(await page.$('[data-caloms-settings]'), 'an administrator sees the CalOMS settings');
  await page.check('[data-caloms-settings] input[name=enabled]');
  await page.fill('[data-caloms-settings] textarea[name=providers]', '123456, Main clinic');
  await page.fill('[data-caloms-settings] input[name=start_date]', today);
  await page.click('[data-caloms-settings] button[type=submit]');
  await until(async () => (await page.getAttribute('[data-caloms-status]', 'data-caloms-status').catch(() => null)) === 'on');
  eq(await page.getAttribute('[data-caloms-status]', 'data-caloms-status'), 'on', 'saving turns it on');
  ok((await page.textContent('[data-caloms-status]')).includes('123456'), 'and the banner names the provider ID');
}

// ---------------- navigator: an admission with the CalOMS questions ----------------
const nav = await session('mrivera', 'Navigator2026!!');
let clientId;
{
  const { page, api } = nav;
  const c = await api('POST', '/api/clients', { first_name: 'Calla', last_name: 'Omstest' + stamp, dob: '1988-06-15', status: 'waitlist', confirm_duplicate: true });
  eq(c.status, 201, 'a waitlisted client to admit');
  clientId = c.data.id;
  await go(page, `client/${clientId}/episodes`);
  await page.click('button:has-text("+ Start an episode")');
  await page.waitForSelector('.modal [data-caloms-admission]');
  ok(await page.$('.modal select[name=caloms_primary_drug]'), 'the admission dialog asks the CalOMS questions');
  ok(await page.$('.modal input[name=caloms_race__01][type=checkbox]'), 'race is one tick box per answer');
  // Submitting with the CalOMS questions blank is refused in the form, by field.
  await page.click('.modal button[type=submit]'); await settle(page);
  ok(await page.$('.modal .field[data-field=caloms_service_type].error'), 'a blank CalOMS answer is flagged under its field');
  ok(await page.$('.modal'), 'and the episode is not opened');
  // Answer everything: the first choice in each list, except where that would be a contradiction.
  const pick = { caloms_sex_at_birth: 'F', caloms_pregnant: 'N', caloms_primary_drug: '05', caloms_secondary_drug: '00', caloms_iv_use_30: 'N', caloms_iv_use_12m: 'N' };
  for (const name of await page.$$eval('.modal select[name^=caloms_]', els => els.map(e => e.name))) {
    const value = pick[name] || await page.$eval(`.modal select[name=${name}]`, s => [...s.options].find(o => o.value)?.value);
    await page.selectOption(`.modal select[name=${name}]`, value);
  }
  const nums = { caloms_primary_age_first_use: '19', caloms_education_grade: '12' };
  for (const name of await page.$$eval('.modal input[type=number][name^=caloms_]', els => els.map(e => e.name))) await page.fill(`.modal input[name=${name}]`, nums[name] || '0');
  await page.fill('.modal input[name=caloms_zip_code]', '95814');
  await page.check('.modal input[name=caloms_race__01]'); await page.check('.modal input[name=caloms_disability__1]');
  await page.click('.modal button[type=submit]');
  await until(async () => !(await page.$('.modal [data-caloms-admission]')));
  ok(!(await page.$('.modal [data-caloms-admission]')), 'with the answers, the episode opens');
  const eps = await api('GET', `/api/clients/${clientId}/episodes`);
  eq(eps.data.episodes.filter(e => e.status === 'open').length, 1, 'one open episode');
  const cal = await api('GET', `/api/episodes/${eps.data.episodes[0].id}/caloms`);
  eq(cal.data.records.length, 1, 'with its CalOMS admission record');
  eq(cal.data.records[0].answers.zip_code, '95814', 'holding what was entered');
  eq(cal.data.records[0].issues.filter(i => i.severity === 'fatal').length, 0, 'and no fatal errors');
  // The episode's CalOMS records, from the Episodes tab.
  await go(page, `client/${clientId}/episodes`);
  await page.click('[data-caloms-episode-open]');
  await page.waitForSelector('.modal [data-caloms-episode]');
  ok((await page.textContent('.modal [data-caloms-episode]')).includes('Ready'), 'the admission record shows as ready to submit');
  await page.keyboard.press('Escape');
  // A navigator can see the validation report for their caseload but cannot make the extract.
  await go(page, 'caloms');
  ok(await page.$('[data-caloms-validation]'), 'a navigator sees the validation report');
  ok(!(await page.$('[data-caloms-extract]')), 'but not the extract (it is an identified disclosure)');
  ok(!(await page.$('[data-caloms-settings]')), 'nor the settings');
}

// ---------------- supervisor: validation report and extract ----------------
const sup = await session('jwalker', 'Navigator2026!!');
{
  const { page, api } = sup;
  // Intake with CalOMS on opens an episode with no admission record yet: the report must say so.
  const c = await api('POST', '/api/clients', { first_name: 'Missing', last_name: 'Admission' + stamp, dob: '1979-02-02', intake_date: today, confirm_duplicate: true });
  eq(c.status, 201, 'an intake that opens an episode');
  const code = c.data.client_code || (await api('GET', `/api/clients/${c.data.id}`)).data.client_code;
  await go(page, 'reports');
  ok(await page.$('[data-state-reporting-link]'), 'Reports links to State reporting');
  await go(page, 'caloms');
  const report = await page.textContent('[data-caloms-validation]');
  ok(report.includes(code), 'the validation report lists the client by code', code);
  ok(report.includes('No CalOMS admission record'), 'with the missing admission');
  ok(report.includes('Fatal'), 'as a fatal error');
  ok(!report.includes('Omstest' + stamp), 'and no client names');
  const handoff = await page.textContent('[data-handoff]');
  ok(handoff.includes('SUDS does not submit Drug Medi-Cal claims'), 'the hand-off states the billing boundary');
  await until(async () => !(await page.textContent('[data-handoff-summary]')).includes('Checking'));
  ok(/encounter row/.test(await page.textContent('[data-handoff-summary]')), 'and previews the period without names');
  // The extract: confirm, then a zip downloads.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    (async () => { await page.click('[data-caloms-download]'); await page.click('.modal button:has-text("Download extract")'); })(),
  ]);
  ok(/^caloms-tx-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.zip$/.test(download.suggestedFilename()), 'the extract downloads as a zip', download.suggestedFilename());
  const acct = await api('GET', `/api/clients/${clientId}/disclosures/accounting`);
  ok((acct.data.disclosures || []).some(d => d.basis === 'state_reporting'), 'and the admitted client\'s accounting of disclosures records it');
}

// ---------------- administrator: switch it off again ----------------
{
  const r = await adm.api('PUT', '/api/caloms/settings', { enabled: false });
  eq(r.status, 200, 'CalOMS can be switched off again');
  const { page, api } = nav;
  const c = await api('POST', '/api/clients', { first_name: 'Prevention', last_name: 'Only' + stamp, status: 'waitlist', confirm_duplicate: true });
  await go(page, `client/${c.data.id}/episodes`);
  await page.click('button:has-text("+ Start an episode")');
  await page.waitForSelector('.modal input[name=opened_at]');
  ok(!(await page.$('.modal select[name=caloms_primary_drug]')), 'with it off, the admission dialog asks nothing about CalOMS');
}

await browser.close();
finish(errors);

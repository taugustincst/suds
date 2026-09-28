// The funder report's counting choice and funding-attribution warnings, the visit form's default fund, and
// the harm-reduction reports on the Reports page (docs/compliance/HARM-REDUCTION-REPORTING.md).
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';
import fs from 'node:fs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { readWorkbook } = await import('../../server/spreadsheet.js');
const browser = await chromium.launch();
const { ok, eq, finish } = makeChecks('funder-reporting');
const errors = [];
async function signIn(user, pw) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1300, height: 950 } }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${user} PAGEERROR ${e.message}`)); page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push(`${user} CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('button[type=submit]'); await page.waitForSelector('.layout');
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) })); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  return page;
}
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => { const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, [method, path, body]);

// ---- the programme default fund pre-fills a new visit ----
const admin = await signIn('admin', 'AdminPassw0rd!x');
const funds = (await api(admin, 'GET', '/api/budget/funds')).data.funds;
ok(funds.length >= 1, 'the seed has a funding source', funds.length);
const fund = funds[0];
eq((await api(admin, 'PUT', '/api/admin/settings', { default_fund_id: fund.id })).status, 200, 'an administrator sets the programme default fund');
await admin.goto(base + '/#/admin?tab=settings'); await settle(admin);
eq(await admin.$eval('select[name=default_fund_id]', s => s.value), fund.id, 'Settings shows the programme default fund');

const sup = await signIn('jwalker', 'Navigator2026!!');
await sup.goto(base + '/#/interventions'); await settle(sup);
// 1.14.0: the fund is in the visit's "Funding & cost" section, folded until opened (its value is set all the same).
await sup.click('text=+ Log a visit'); await sup.waitForSelector('.modal select[name=funding_source_id]', { state: 'attached' });
eq(await sup.$eval('.modal select[name=funding_source_id]', s => s.value), fund.id, 'a new visit is pre-filled with the default fund');
await sup.keyboard.press('Escape'); await settle(sup);

// ---- funder report: what kind of run it is, counting mode, attribution warnings ----
// A visit charged to no fund, so the warning has something to point at.
eq((await api(sup, 'POST', '/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), funding_source_id: null })).status, 201, 'a visit charged to no fund');
const today = new Date().toISOString().slice(0, 10); const yearStart = `${today.slice(0, 4)}-01-01`;
await sup.goto(`${base}/#/funder?from=${yearStart}&to=${today}`); await settle(sup);
// A supervisor's first view is the programme's own submission to its funder, with exact counts (1.13.0).
eq(await sup.$eval('[data-counting-mode]', e => e.dataset.purpose), 'submission', 'a supervisor\'s funder report opens as the submission to the funder');
eq(await sup.$eval('[data-counting-mode]', e => e.dataset.countingMode), 'exact', 'with exact counts');
eq(await sup.$eval('[data-run-kind] .run-kind-title', e => e.textContent), 'Submission to your funder — not for publication', 'and says prominently what kind of run it is');
// The notice is two plain lines; the full statement is behind "About these counts" / "Why some numbers are hidden".
ok((await sup.$eval('[data-run-kind] .run-kind-line', e => e.textContent)).length < 200, 'the notice above the figures is short');
eq(await sup.$eval('[data-run-kind] details[data-counting-details]', d => d.open), false, 'the full counting statement is folded away');
ok(await sup.$('[data-no-fund-row]'), 'By funding source has a "No funding source" row');
ok(await sup.$('[data-unattributed]'), 'and a warning that services have no funding source');
ok(await sup.$('[data-prepare-publication]'), 'publication is a separate step: "Prepare a publication release"');
const [fx] = await Promise.all([sup.waitForEvent('download'), sup.click('[data-funder-export=xlsx]')]);
ok(/exact-counts\.xlsx$/.test(fx.suggestedFilename()), 'the exported submission is named for its counting mode', fx.suggestedFilename());
const fwb = readWorkbook(fs.readFileSync(await fx.path()));
const about = fwb.find(s => s.name === 'About');
ok(about && about.rows.some(r => /Exact counts/.test(r.join(' '))), 'and its About sheet states it', about && about.rows.map(r => r.join(':')).join(' | '));
ok(about && about.rows.some(r => /submission to its funder, not for publication/.test(r.join(' '))), 'and what it is for');
await sup.selectOption('select[data-counts]', 'suppressed'); await sup.click('.filters button.primary'); await settle(sup);
eq(await sup.$eval('[data-counting-mode]', e => e.dataset.countingMode), 'suppressed', 'a supervisor can choose small cells suppressed instead');
eq(await sup.$eval('[data-counting-mode]', e => e.dataset.purpose), 'submission', 'still the submission, not for publication');
eq(await sup.$eval('[data-run-kind] details[data-counting-details] summary', e => e.textContent), 'Why some numbers are hidden', 'with a plain link to why some numbers are hidden');
await sup.click('[data-unattributed] a'); await settle(sup);
ok(await until(() => sup.$('[data-no-fund-filter]')), 'the warning opens the visits with no funding source');
ok(/funding=none/.test(sup.url()), 'filtered to them', sup.url());
// Preparing a publication release: last month, for the whole programme.
await sup.goto(`${base}/#/funder?from=${yearStart}&to=${today}`); await settle(sup);
await sup.click('[data-prepare-publication] [data-publishable-periods] [data-period=month]'); await settle(sup);
ok(await until(async () => (await sup.$eval('[data-counting-mode]', e => e.dataset.purpose)) === 'publication'), 'last month, whole programme, prepared as a publication release');
ok(/Publication release/.test(await sup.$eval('[data-run-kind] .run-kind-title', e => e.textContent)), 'and the page says so first');
ok(/from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}&purpose=publication/.test(sup.url()), 'for one calendar month', sup.url());
ok(/small cells screened; review before sharing/.test(await sup.$eval('[data-run-kind] .run-kind-title', e => e.textContent)), 'labelled as screened, to be reviewed before sharing');
ok(await sup.$('[data-publication-review-step] [data-withheld-tables]'), 'the review step lists what was withheld, and why (or says nothing was)');
ok(await sup.$('[data-back-to-submission]'), 'with a way back to the submission');
// Its file needs the review confirmed first: without the tick nothing downloads and the page says why.
ok(await sup.$('[data-publication-review] input[type=checkbox]'), 'a publication release asks for the review to be confirmed before export');
let early = null; sup.once('download', d => { early = d; });
await sup.click('[data-funder-export=xlsx]'); await settle(sup);
eq(early, null, 'without the confirmation, the file is not exported');
ok(/Tick/.test(await sup.$eval('[data-publication-review-why]', e => e.textContent)), 'and the page says what to do');
eq(await sup.evaluate(() => document.activeElement && document.activeElement.dataset.publicationReviewed), '1', 'with focus on the confirmation');
await sup.check('[data-publication-review] input[type=checkbox]');
const [px] = await Promise.all([sup.waitForEvent('download'), sup.click('[data-funder-export=xlsx]')]);
ok(/publication-screened-review-before-sharing\.xlsx$/.test(px.suggestedFilename()), 'confirmed, the release downloads, named as screened and to be reviewed', px.suggestedFilename());
const pab = readWorkbook(fs.readFileSync(await px.path())).find(s => s.name === 'About');
ok(pab && pab.rows.some(r => /small cells screened; review before sharing/.test(r.join(' '))), 'and its About sheet says so');
const reviewed = await api(admin, 'GET', '/api/admin/audit?action=report.publication.reviewed');
ok(reviewed.data.rows.some(r => r.action === 'report.publication.reviewed' && r.details && r.details.release_id && r.details.report === 'funder'), 'the confirmation is in the audit log, with the release id', JSON.stringify(reviewed.data).slice(0, 300));

// ---- harm-reduction reports on the Reports page ----
await sup.goto(`${base}/#/reports?from=${yearStart}&to=${today}`); await settle(sup);
ok(await sup.$('[data-harm-reduction-reports]'), 'Reports has the harm-reduction reporting entries');
eq(await sup.$eval('select[data-hr-kind]', s => s.value), '', 'a supervisor\'s files are the submission to the funder by default');
ok(/Submission to your funder/.test(await sup.$eval('select[data-hr-kind]', s => s.selectedOptions[0].textContent)), 'and the choice says so');
eq(await sup.$eval('select[data-hr-kind] option[value=publication]', o => o.disabled), true, 'a range that is not a standard period that has ended cannot be a publication release');
const [nd] = await Promise.all([sup.waitForEvent('download'), sup.click('[data-ndp-export=xlsx]')]);
const nwb = readWorkbook(fs.readFileSync(await nd.path()));
ok(/naloxone-ndp-log.*exact-counts/.test(nd.suggestedFilename()), 'the NDP log downloads, the programme\'s own submission', nd.suggestedFilename());
// 1.14: the day log (the programme's submission) also says which naloxone product went out (docs/SUPPLIES.md).
eq((nwb[0].rows[0] || []).slice(0, 6).join(','), 'Date,Entry,Site type,Recipient type,Naloxone product,Kits distributed', 'with the NDP-style columns, the naloxone product among them');
ok(await sup.$('[data-ssp-row] [data-ssp-export=xlsx]'), 'and the syringe services summary is offered beside them');
ok(nwb.some(s => s.name === 'About' && s.rows.some(r => /not the official NDP template/.test(r.join(' ')))), 'labelled as not the official NDP template');
const [sd] = await Promise.all([sup.waitForEvent('download'), sup.click('[data-settlement-export=xlsx]')]);
const swb = readWorkbook(fs.readFileSync(await sd.path()));
ok(swb.some(s => s.name === 'By allowable use' && s.rows.length > 10), 'the opioid settlement report lists every allowable use', swb.map(s => s.name).join(','));

// The overdose form: choosing "Reversal" ticks "Naloxone was given", and "Where" is the visit Location list.
await sup.goto(`${base}/#/overdose`); await settle(sup);
await sup.click('text=+ Record an event'); await sup.waitForSelector('.modal select[name=kind]');
ok(await sup.$('.modal select[name=location_type] option[value=field]'), '"Where" offers the same coded locations as a visit');
eq(await sup.$eval('.modal input[name=naloxone_used]', e => e.checked), false, 'naloxone starts unticked');
await sup.selectOption('.modal select[name=kind]', 'reversal');
eq(await sup.$eval('.modal input[name=naloxone_used]', e => e.checked), true, 'choosing Reversal ticks "Naloxone was given"');
await sup.keyboard.press('Escape'); await settle(sup);

// A read-only account sees neither export.
const ro = await signIn('rreader', 'Navigator2026!!');
await ro.goto(base + '/#/reports'); await settle(ro);
ok(!(await ro.$('[data-harm-reduction-reports]')), 'a read-only account is not offered the exports');
// Read-only runs publication releases only (server/auth.js reportRunAllowed): the funder report opens on the
// last quarter that has ended, with no custom range, fund or counts choice to make.
{
  const page = ro; const who = 'read-only';
  await page.goto(`${base}/#/funder`); await settle(page);
  eq(await page.$eval('[data-purpose]', e => e.dataset.purpose).catch(() => null), 'publication', `${who}: the funder report opens on a publication release`);
  ok(!(await page.$('[data-custom-range]')), `${who}: no custom range or fund filter`);
  ok(!(await page.$('[data-counts]')), `${who}: no exact-counts choice`);
  ok(await page.$('[data-publication-only]'), `${who}: the page says the role runs publication releases`);
  // A link to an internal run is refused with the reason, and the periods it can run are offered.
  await page.goto(`${base}/#/funder?from=${yearStart}&to=${today}`); await settle(page);
  ok(/publication release/i.test(await page.textContent('[data-funder-refused]').catch(() => '')), `${who}: an internal run is refused with a clear message`);
  ok(await page.$('[data-publishable-periods] [data-period=quarter]'), `${who}: and offered the periods it can run`);
}
// Finance writes the funder report (reports:funder, 1.14.0): the programme's own submission, exact aggregate
// counts, for any range and any fund, without opening a client record.
const finp = await signIn('afinance', 'Navigator2026!!');
await finp.goto(`${base}/#/funder`); await settle(finp);
eq(await finp.$eval('[data-counting-mode]', e => e.dataset.purpose).catch(() => null), 'submission', 'finance: the funder report opens as the submission to the funder');
eq(await finp.$eval('[data-counting-mode]', e => e.dataset.countingMode).catch(() => null), 'exact', 'finance: with exact counts');
ok(await finp.$('[data-custom-range]'), 'finance: a custom range and fund filter');
ok(await finp.$('[data-counts]'), 'finance: and the counts choice');
ok(!(await finp.$('[data-publication-only]')), 'finance: not told it runs publication releases only');
await finp.selectOption('[data-custom-range] select[aria-label="Funding source"]', fund.id);
await finp.fill('[data-custom-range] input[aria-label=From]', yearStart); await finp.fill('[data-custom-range] input[aria-label=To]', today);
await finp.click('[data-custom-range] button.primary'); await settle(finp);
ok(await until(() => finp.url().includes(`funding_source_id=${fund.id}`)), 'finance: one fund, a custom range', finp.url());
eq(await finp.$eval('[data-counting-mode]', e => e.dataset.purpose).catch(() => null), 'submission', 'finance: a single fund\'s run is the submission, not refused');
const [ffx] = await Promise.all([finp.waitForEvent('download'), finp.click('[data-funder-export=xlsx]')]);
ok(/exact-counts\.xlsx$/.test(ffx.suggestedFilename()), 'finance: the fund\'s submission exports with exact counts', ffx.suggestedFilename());
const fabout = readWorkbook(fs.readFileSync(await ffx.path())).find(x => x.name === 'About');
ok(fabout && fabout.rows.some(r => /no names, client codes or dates of service/.test(r.join(' '))), 'finance: and the file is aggregate counts only');
const someClient = (await api(admin, 'GET', '/api/clients?limit=1')).data.clients[0];
eq((await api(finp, 'GET', `/api/clients/${someClient.id}`)).status, 403, 'finance: still no client record to open');
await finp.goto(`${base}/#/reports?from=${yearStart}&to=${today}`); await settle(finp);
ok(await finp.$('[data-ndp-export=xlsx]'), 'finance: the NDP log is offered for any range');
ok(await finp.$('select[data-hr-kind]'), 'finance: as the submission, with the kind of file to choose');
ok(!(await finp.$('[data-hr-publication-only]')), 'finance: no "publication release only" note');
// The DHCS settlement expenditure layout, and a county's own template set up without code.
const [dl] = await Promise.all([finp.waitForEvent('download'), finp.click('[data-settlement-layout=dhcs]')]);
ok(/dhcs-layout/.test(dl.suggestedFilename()), 'finance: the DHCS settlement expenditure layout downloads', dl.suggestedFilename());
const dwb = readWorkbook(fs.readFileSync(await dl.path()));
ok((dwb[0].rows[0] || []).includes('Exhibit E category (opioid remediation use)'), 'with the DHCS fields as its columns', (dwb[0].rows[0] || []).join(' | '));
ok(dwb.some(x => x.name === 'About' && x.rows.some(r => /For the program to write/.test(r.join(' ')))), 'and its About sheet says what the program must still write');
await finp.click('[data-county-template]'); await finp.waitForSelector('[data-county-template-form]');
await finp.fill('#county-template-name', 'Harbor County quarterly report');
await finp.fill('#county-col-0', 'Strategy');
await finp.click('text=+ Add a column');
await finp.fill('#county-col-1', 'Dollars'); await finp.selectOption('#county-src-1', 'approved_amount');
await finp.click('text=+ Add a column');
await finp.fill('#county-col-2', 'Narrative');
await finp.click('[data-county-template-save]'); await settle(finp);
ok(!(await finp.$('[data-county-template-form]')), 'finance: the county template is saved');
const [cl] = await Promise.all([finp.waitForEvent('download'), finp.click('[data-settlement-layout=county]')]);
ok(/county-template/.test(cl.suggestedFilename()), 'finance: the county template downloads', cl.suggestedFilename());
eq((readWorkbook(fs.readFileSync(await cl.path()))[0].rows[0] || []).join(','), 'Strategy,Dollars,Narrative', 'in the county\'s own columns');
await finp.context().close();

// ---- publication releases switched off (Settings › Program › Modules) ----
eq((await api(admin, 'PUT', '/api/admin/settings', { module_publication: '0' })).status, 200, 'an administrator switches publication releases off');
{
  const sp = await signIn('jwalker', 'Navigator2026!!');
  await sp.goto(`${base}/#/funder?from=${yearStart}&to=${today}`); await settle(sp);
  eq(await sp.$eval('[data-counting-mode]', e => e.dataset.purpose).catch(() => null), 'submission', 'publication off: the supervisor\'s submission is unaffected');
  ok(!(await sp.$('[data-prepare-publication]')), 'publication off: no "Prepare a publication release"');
  ok(await sp.$('[data-publication-off]'), 'publication off: the page says so');
  await sp.goto(`${base}/#/reports?from=${yearStart}&to=${today}`); await settle(sp);
  ok(/switched off/.test(await sp.$eval('select[data-hr-kind] option[value=publication]', o => o.textContent).catch(() => '')), 'publication off: the harm-reduction files offer no publication release');
  const rp = await signIn('rreader', 'Navigator2026!!');
  await rp.goto(`${base}/#/funder`); await settle(rp);
  ok(/Publication releases are switched off/.test(await rp.textContent('[data-funder-refused]').catch(() => '')), 'publication off: read-only is told why there is nothing to run');
  ok(!(await rp.$('[data-publishable-periods]')), 'publication off: and offered no periods');
  await sp.context().close(); await rp.context().close();
}
eq((await api(admin, 'PUT', '/api/admin/settings', { module_publication: null })).status, 200, 'publication releases back on');
await api(admin, 'PUT', '/api/admin/settings', { default_fund_id: null });

// ---- no programme default fund: the warning says where to set one ----
await admin.goto(`${base}/#/funder?from=${yearStart}&to=${today}`); await settle(admin);
ok(await admin.$('[data-unattributed] [data-default-fund-link]'), 'with no default fund, the "no funding source" warning links to Settings');
await admin.click('[data-default-fund-link]'); await settle(admin);
ok(/tab=settings/.test(admin.url()), 'the link opens Settings', admin.url());
eq(await admin.$eval('details[data-section=Reporting]', d => d.open).catch(() => null), true, 'with the Reporting section, where the default fund is set, open');
ok(await admin.$eval('select[name=default_fund_id]', s => s.offsetParent !== null).catch(() => false), 'and the default fund field visible');
// A filtered report says which fund, and the small-cell note is shown when counts are suppressed.
await sup.goto(`${base}/#/funder?from=${yearStart}&to=${today}&funding_source_id=${fund.id}`); await settle(sup);
ok(!(await sup.$('[data-no-fund-row]')), 'filtered to one fund, the table has no "No funding source" row');
ok(!(await sup.$('[data-unattributed]')), 'nor the warning about visits charged to no fund');
await sup.goto(`${base}/#/funder?from=${yearStart}&to=${today}`); await settle(sup);
ok(!/NaN/.test(await sup.textContent('#app')), 'suppressed figures are shown as sent, never as NaN');
finish(errors);
await browser.close();

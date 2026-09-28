// The forms around the everyday loops (1.14.0 usability review, forms): the visit as a field note with its
// sections, remembered defaults, the time entry it logs and the overlap hint, a note saved with the visit in
// one request, the supplies pre-check inside the visit form, Quick add with the re-admission in the same
// dialog, the referral's consent and provider steps inside one dialog, the consent's scope as its ticks, the
// inbound/outbound referral wording, and the action row that keeps Save in view at every width.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, finish } = makeChecks('ux-forms');
const errors = [];
const PW = 'Navigator2026!!';
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
const today = new Date().toISOString().slice(0, 10);

async function session(user, pass, viewport = { width: 1360, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('response', r => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pass);
  await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 10000 });
  const api = (method, path, body) => page.evaluate(async ({ method, path, body, h }) => { const r = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, data: j }; }, { method, path, body, h: H });
  // A clean slate for what the forms remember (the sections, the last visit's defaults, the time-entry choice).
  await api('PUT', '/api/me/prefs', { tour_done: true, visit_sections: null, visit_last: null, visit_log_time: null });
  await page.reload(); await page.waitForSelector('.layout'); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  return { page, ctx, api, close: () => ctx.close() };
}
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await settle(page); };
const closeModals = async (page) => { for (let i = 0; i < 4 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await settle(page); } };
const dialogs = (page) => page.$$eval('#modal-root > .modal-bg', x => x.length);
// Is the dialog's own submit button on screen, without scrolling?
const saveInView = (page) => page.evaluate(() => {
  const top = [...document.querySelectorAll('#modal-root > .modal-bg')].pop();
  const b = [...top.querySelectorAll('button[type=submit]')].filter(x => x.offsetParent).pop();
  const r = b && b.getBoundingClientRect();
  return !!r && r.top >= 0 && r.bottom <= innerHeight;
});
const isOpen = (page, key) => page.$eval(`.modal details[data-section-key="${key}"]`, d => d.open).catch(() => null);
const hint = (page, key) => page.$eval(`.modal details[data-section-key="${key}"] summary [data-section-hint]`, e => e.textContent).catch(() => '');
const flushPrefs = (page) => page.evaluate(async () => { await new Promise(r => setTimeout(r, 900)); });
const openVisit = async (page, clientId) => {
  await page.evaluate(async (id) => (await import('./views/interventions.js')).openInterventionForm(null, { clientId: id, clientDisplay: 'the client' }), clientId);
  await page.waitForSelector('.modal select[name=type]'); await settle(page);
};

const admin = await session('admin', 'AdminPassw0rd!x');
const nav = await session('mrivera', PW);
const C = (await nav.api('GET', '/api/meta/constants')).data;
const mine = (await nav.api('GET', '/api/clients?limit=20')).data.clients;
const [c1, c2, c3] = mine;

// ---- 1-3. the visit as a field note: sections, remembered defaults, the time entry ----
{
  const { page, api } = nav;
  await go(page, `client/${c1.id}`);
  await page.click('.client-actions.wide button:has-text("+ Log a visit")');
  await page.waitForSelector('.modal select[name=type]'); await settle(page);
  const sections = await page.$$eval('.modal details[data-section-key]', ds => ds.map(d => ({ key: d.dataset.sectionKey, open: d.open, heading: !!d.querySelector('summary h3') })));
  for (const key of ['outcome', 'time', 'note']) ok(sections.some(s => s.key === key), `the visit form has a "${key}" section`, sections.map(s => s.key));
  ok(sections.some(s => s.key === 'funding'), 'and "Funding & cost" for a role that sees budgets', sections.map(s => s.key));
  ok(sections.every(s => !s.open), 'every section starts folded for a new visit', sections);
  ok(sections.every(s => s.heading), 'each section heading is a real heading inside a keyboard disclosure (summary)');
  const visible = await page.$$eval('.modal .form-grid > .field:not([hidden]), .modal [data-supply-picker]', xs => xs.filter(x => x.offsetParent && !x.closest('details')).map(x => x.dataset.field || 'supplies'));
  for (const f of ['client_id', 'type', 'occurred_at', 'location', 'modality', 'summary', 'supplies']) ok(visible.includes(f), `the everyday field "${f}" shows without opening anything`, visible);
  ok(visible.length <= 8, 'and little else (about six core fields and the supply picker)', visible);
  for (const f of ['duration_minutes', 'cost', 'follow_up_due', 'outcome', 'note_content']) ok(!visible.includes(f), `"${f}" is folded into its section`, visible);
  ok(await saveInView(page), 'Save is on screen at 1360×900 without scrolling');
  eq(await page.inputValue('.modal select[name=location]'), C.DEFAULT_LOCATION, 'a first visit starts at the program\'s default location');
  eq(await page.inputValue('.modal select[name=modality]'), 'in_person', 'in person');
  ok(await page.isChecked('.modal input[name=log_time]'), '"Also log this as a time entry" is on the first time');
  ok(/adds 30 min of direct service to your time/i.test(await hint(page, 'time')), 'the folded Time section says what it will add', await hint(page, 'time'));
  const help = await page.textContent('.modal [data-field="log_time"] .help');
  ok(/Adds 30 min of direct service to your time/.test(help) && /supervisors approve hours/.test(help), 'the checkbox\'s help says what it creates and why it is on', help);
  // Opening a section is remembered for this person.
  await page.click('.modal details[data-section-key="time"] > summary');
  ok(await isOpen(page, 'time'), 'the Time section opens from its heading');
  await page.fill('.modal input[name=duration_minutes]', '20');
  ok(/adds 20 min of direct service/i.test(await hint(page, 'time')), 'and what it says follows the duration', await hint(page, 'time'));
  await page.uncheck('.modal input[name=log_time]');
  ok(/not added to your time/.test(await hint(page, 'time')), 'unticked, it says no time is added', await hint(page, 'time'));
  // Where and how: something other than the defaults, to be remembered.
  const locs = await page.$$eval('.modal select[name=location] option', os => os.map(o => o.value).filter(Boolean));
  const loc = locs.find(v => v !== C.DEFAULT_LOCATION);
  const mods = await page.$$eval('.modal select[name=modality] option', os => os.map(o => o.value).filter(Boolean));
  const mod = mods.find(v => v !== 'in_person');
  await page.selectOption('.modal select[name=type]', 'case_management');
  await page.selectOption('.modal select[name=location]', loc); await page.selectOption('.modal select[name=modality]', mod);
  await page.fill('.modal textarea[name=summary]', 'Check-in about housing');
  // ---- 4. the note, in the same dialog and the same request ----
  await page.click('.modal details[data-section-key="note"] > summary');
  const noteText = 'Talked through the shelter waitlist and a detox bed for next week.';
  await page.fill('.modal textarea[name=note_content]', noteText);
  eq((await page.textContent('.modal .btn-row button[type=submit]')).trim(), 'Save visit & note', 'Save says it saves the note too');
  const posts = [];
  const onReq = (r) => { if (r.method() === 'POST' && /\/api\/(interventions|notes)(\?|$)/.test(new URL(r.url()).pathname + (new URL(r.url()).search))) posts.push(new URL(r.url()).pathname); };
  page.on('request', onReq);
  const resp = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/interventions');
  await page.click('.modal .btn-row button[type=submit]');
  const saved = await (await resp).json();
  await until(async () => !(await page.$('.modal-bg')));
  page.off('request', onReq);
  eq(posts.join(','), '/api/interventions', 'the visit and its note are one request');
  ok(saved.note_id, 'the note was created with the visit', saved);
  const note = saved.note_id ? (await api('GET', `/api/notes/${saved.note_id}`)).data.note : null;
  ok(note && note.intervention_id === saved.id && note.client_id === c1.id && note.status === 'draft' && note.content === noteText, 'a draft note on the client\'s record, linked to the visit', note && { i: note.intervention_id, s: note.status });
  const te = (await api('GET', `/api/time?source=visit&from=${today}&to=${today}`)).data.rows;
  ok(!te.some(r => r.intervention_id === saved.id), 'with the box unticked, no time entry was made');
  await flushPrefs(page);
  // The next visit starts where this one was, and remembers the choices.
  await openVisit(page, c2.id);
  eq(await page.inputValue('.modal select[name=location]'), loc, 'the next visit starts at the last visit\'s location');
  eq(await page.inputValue('.modal select[name=modality]'), mod, 'and its modality');
  eq(await page.inputValue('.modal select[name=type]'), 'case_management', 'and its type');
  ok(!(await page.isChecked('.modal input[name=log_time]')), 'the time-entry box follows the last choice (off)');
  ok(await isOpen(page, 'time'), 'the Time section this person opened is open again');
  ok(!(await isOpen(page, 'outcome')), 'the ones they did not open stay folded');
  await page.check('.modal input[name=log_time]');
  await page.click('.modal details[data-section-key="time"] > summary');
  await closeModals(page); await flushPrefs(page);
  // A validation error opens the section it is in: a cost needs a budget line.
  await openVisit(page, c2.id);
  if (await page.$('.modal details[data-section-key="funding"]')) {
    await page.selectOption('.modal select[name=type]', 'case_management');
    await page.click('.modal details[data-section-key="funding"] > summary');
    const fund = await page.$$eval('.modal select[name=funding_source_id] option', os => os.map(o => o.value).filter(Boolean)[0]);
    if (fund) await page.selectOption('.modal select[name=funding_source_id]', fund);
    await page.fill('.modal input[name=cost]', '12');
    await page.click('.modal details[data-section-key="funding"] > summary');
    ok(!(await isOpen(page, 'funding')), 'folded again before saving');
    await page.click('.modal .btn-row button[type=submit]');
    await until(() => page.$('.modal [data-field="budget_line_id"].error, .modal [data-field="funding_source_id"].error'));
    ok(await isOpen(page, 'funding'), 'a missing budget line opens "Funding & cost" to show the error');
    ok(/required when there is a direct cost/.test(await page.textContent('.modal details[data-section-key="funding"]')), 'with the reason under the field');
    eq(await dialogs(page), 1, 'and nothing was saved (the dialog is still open)');
  }
  await closeModals(page);
  // An edit opens the sections holding something other than a new visit's default.
  const v = await api('POST', '/api/interventions', { client_id: c2.id, type: 'case_management', occurred_at: new Date().toISOString(), duration_minutes: 30, outcome: 'completed', follow_up_due: '2099-01-02' });
  eq(v.status, 201, 'a visit with an outcome and a follow-up');
  const row = (await api('GET', `/api/interventions/${v.data.id}`)).data.row;
  await page.evaluate(async (r) => (await import('./views/interventions.js')).openInterventionForm(r, {}), row);
  await page.waitForSelector('.modal select[name=type]'); await settle(page);
  ok(await isOpen(page, 'outcome'), 'editing it, "Outcome & follow-up" is open because it holds values');
  ok(/Completed/.test(await hint(page, 'outcome')), 'and says what it holds', await hint(page, 'outcome'));
  ok(!(await page.$('.modal details[data-section-key="note"]')), 'a note is added when a visit is recorded, not on an edit');
  await closeModals(page);
}

// ---- 3. the time entry a visit logs: marked, and a manual entry for the same day warns first ----
{
  const { page, api } = nav;
  const v = await api('POST', '/api/interventions', { client_id: c3.id, type: 'case_management', occurred_at: new Date().toISOString(), duration_minutes: 25, log_time: true });
  eq(v.status, 201, 'a visit that logs its time');
  await go(page, `time?from=${today}&to=${today}`);
  ok(await page.$('.main [data-time-source="visit"]'), 'the time list marks the entries a visit logged');
  await page.evaluate(async ({ id }) => (await import('./views/time.js')).openTimeForm(null, { clientId: id, clientDisplay: 'the client' }), { id: c3.id });
  await page.waitForSelector('.modal input[name=minutes]');
  const warn = await until(async () => { const t = await page.$eval('.modal [data-time-overlap]', e => (e.classList.contains('hidden') ? '' : e.textContent)).catch(() => ''); return t || null; });
  ok(warn && /already logged by (a visit|\d+ visits) with this client/.test(warn) && /counts twice/.test(warn), 'logging time by hand for that client and day says a visit already logged it', warn);
  ok(!(await page.$('.modal .btn-row button[type=submit][disabled]')), 'as a hint: Log time still works');
  await page.fill('.modal input[name=work_date]', '2020-01-02'); await page.locator('.modal input[name=work_date]').dispatchEvent('change');
  await until(async () => page.$eval('.modal [data-time-overlap]', e => e.classList.contains('hidden')));
  ok(await page.$eval('.modal [data-time-overlap]', e => e.classList.contains('hidden')), 'another day with no visit time says nothing');
  await closeModals(page);
}

// ---- 5. the supply picker says, inside the visit, when kits have no item — and one person can fix it there ----
{
  const cupboard = (await admin.api('GET', '/api/supplies')).data.items.filter(i => i.is_active && ['naloxone', 'fentanyl_test_strips'].includes(i.category));
  ok(cupboard.length >= 1, 'the program keeps naloxone and test strip items to begin with', cupboard.map(i => i.name));
  for (const x of cupboard) eq((await admin.api('DELETE', `/api/supplies/${x.id}`)).status, 200, `${x.name} is taken out of use`);
  const { page } = nav;
  await go(page, `client/${c1.id}`);
  await openVisit(page, c1.id);
  const notice = await page.$('.modal [data-supply-picker] [data-supplies-missing]');
  ok(notice, 'the visit form says, before saving, that naloxone and test strips have no item in Supplies');
  const text = notice ? await notice.textContent() : '';
  ok(/not taken off any stock/.test(text) && /Ask a supervisor or administrator/.test(text), 'that they will not come off stock, and who can add them', text);
  ok(!(await page.$('.modal [data-add-standard-supplies]')), 'a navigator is not offered the button');
  ok(await page.$('.modal [data-untracked-row="naloxone_kits"] input[name=naloxone_kits]'), 'kits are still recorded in the same picker');
  ok(!(await page.$('.modal [data-field="naloxone_kits"]')), 'not in a second, separate number field');
  await closeModals(page);
  const sup = await session('jwalker', PW);
  await go(sup.page, `supplies`);
  const supClient = (await sup.api('GET', '/api/clients?limit=1')).data.clients[0];
  await openVisit(sup.page, supClient.id);
  const add = await sup.page.$('.modal [data-add-standard-supplies]');
  ok(add, 'a supervisor is offered "Add naloxone kits and test strips" right there');
  eq(add && (await add.textContent()).trim(), 'Add naloxone kits and test strips', 'in those words');
  await sup.page.click('.modal [data-untracked-row="naloxone_kits"] button[aria-label^="One more"]');
  await sup.page.click('.modal [data-untracked-row="naloxone_kits"] button[aria-label^="One more"]');
  if (add) await add.click();
  await until(() => sup.page.$('.modal [data-supply-picker]:not(:has([data-supplies-missing]))'));
  ok(!(await sup.page.$('.modal [data-supplies-missing]')), 'once added, the notice goes');
  const items = (await sup.api('GET', '/api/supplies/catalog')).data.items;
  const nal = items.find(i => i.category === 'naloxone');
  ok(nal, 'the naloxone item is back in the catalog');
  eq(nal && await sup.page.inputValue(`.modal [data-supply-row="${nal.id}"] input`), '2', 'and the 2 kits already entered moved onto it');
  eq(await dialogs(sup.page), 1, 'all without leaving the visit');
  await closeModals(sup.page);
  await sup.close();
}

// ---- 6. Quick add, the full intake, and the re-admission in the same dialog ----
{
  const { page } = nav;
  await go(page, 'clients');
  await page.click('.main button:has-text("+ New client")');
  await page.waitForSelector('.modal [data-quick-add] input[name=first_name]'); await settle(page);
  const fields = await page.$$eval('.modal .field[data-field]', xs => xs.filter(x => x.offsetParent).map(x => x.dataset.field));
  eq(fields.join(','), 'first_name,last_name,preferred_name,dob,phone', 'Quick add asks for the name (or alias), date of birth and phone');
  ok(await saveInView(page), 'Create client is on screen');
  ok(await page.$('.modal button[data-full-intake]'), 'the full intake is one button away');
  const last = `Quickadd${Date.now() % 100000}`;
  await page.fill('.modal input[name=first_name]', 'Robin'); await page.fill('.modal input[name=last_name]', last);
  await page.click('.modal button[type=submit]');
  await page.waitForFunction(() => /^#\/client\/[^/?]+/.test(location.hash), null, { timeout: 10000 }).catch(() => {});
  await settle(page);
  ok(/#\/client\/[^/?]+/.test(page.url()), 'creating opens the new record', page.url());
  ok(await page.$('.client-actions.wide [data-client-add-details]'), 'where "Add details" carries on with the intake');
  await page.click('.client-actions.wide [data-client-add-details]');
  await page.waitForSelector('.modal input[name=first_name]');
  eq(await page.inputValue('.modal input[name=last_name]'), last, 'on the record just created');
  const inbound = await page.$eval('.modal [data-field="referral_source"] > label', l => l.textContent);
  ok(/Who referred them to us/.test(inbound), 'the intake\'s referral source says it is inbound', inbound);
  await closeModals(page);
  // Full intake carries over what was typed, in one dialog.
  await go(page, 'clients');
  await page.click('.main button:has-text("+ New client")');
  await page.waitForSelector('.modal [data-quick-add]');
  await page.fill('.modal input[name=first_name]', 'Sam'); await page.fill('.modal input[name=last_name]', 'Fullform');
  await page.click('.modal button[data-full-intake]');
  await until(() => page.$('.modal select[name=housing_status]'));
  eq(await dialogs(page), 1, '"Full intake" replaces Quick add (one dialog)');
  eq(await page.inputValue('.modal input[name=last_name]'), 'Fullform', 'with the name already typed');
  await closeModals(page);
  // A discharged earlier record: offered and re-admitted inside the one dialog.
  const who = { first_name: 'Nightly', last_name: `Returner${Date.now() % 100000}`, dob: '1983-02-03' };
  const made = await nav.api('POST', '/api/clients', { ...who, intake_date: '2020-01-15' });
  const ep = (await nav.api('GET', `/api/clients/${made.data.id}/episodes`)).data.episodes[0];
  eq((await nav.api('POST', `/api/episodes/${ep.id}/close`, { discharge_reason: 'lost_contact', closed_at: '2021-06-01' })).status, 200, 'an earlier client is discharged');
  // From 1.16.0 a navigator sees every client (clients:all), so the record would simply be shown; the offer is for
  // a worker the programme holds to their caseload (a per-user deny).
  const bId = (await admin.api('GET', '/api/users')).data.users.find(u => u.username === 'dchen').id;
  eq((await admin.api('POST', `/api/users/${bId}/permissions`, { permission: 'clients:all', mode: 'deny', reason: 'held to their own caseload' })).status, 200, 'the administrator holds the other navigator to their caseload');
  const b = await session('dchen', PW);
  const hisBefore = (await b.api('GET', '/api/clients?status=all&limit=1')).data.total;
  await go(b.page, 'clients');
  await b.page.click('.main button:has-text("+ New client")');
  await b.page.waitForSelector('.modal [data-quick-add]');
  await b.page.fill('.modal input[name=first_name]', who.first_name); await b.page.fill('.modal input[name=last_name]', who.last_name);
  await b.page.fill('.modal input[name=dob]', who.dob); await b.page.locator('.modal input[name=dob]').dispatchEvent('change');
  const offer = await until(() => b.page.$('.modal [data-readmit-offer]'));
  ok(offer, 'Quick add says an earlier record exists');
  await b.page.click('.modal button[data-readmit]');
  const reason = await until(() => b.page.$('.modal [data-readmit-panel] input[data-readmit-reason]'));
  ok(reason, 'the reason is asked for under the offer');
  eq(await dialogs(b.page), 1, 'in the same dialog — no second dialog on top');
  eq(await b.page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-readmit-reason')), true, 'the cursor goes to the reason');
  await reason.fill('ok');
  await b.page.keyboard.press('Enter');
  await until(() => b.page.$('.modal [data-readmit-panel].error'));
  ok(/at least 8 characters/.test(await b.page.textContent('.modal [data-readmit-panel] .err')), 'too short is explained under the field, and Enter did not create a new client');
  eq((await b.api('GET', '/api/clients?status=all&limit=1')).data.total, hisBefore, 'nothing was created by that Enter');
  await reason.fill('walked in');
  await b.page.click('.modal button[data-readmit-confirm]');
  await b.page.waitForFunction((id) => location.hash.startsWith(`#/client/${id}`), made.data.id, { timeout: 10000 }).catch(() => {});
  ok(b.page.url().includes(`#/client/${made.data.id}`), 'a short, real reason re-admits and opens the record', b.page.url());
  await b.close();
}

// ---- 7-9. a referral that needs a consent, and a provider not listed: steps of one dialog ----
{
  const { page, api } = nav;
  await go(page, 'referrals');
  ok(/Referrals we make/.test(await page.textContent('.main h1')), 'the Referrals page says these are referrals the program makes', await page.textContent('.main h1'));
  const target = mine[6] || mine[3];
  await go(page, `client/${target.id}/referrals`);
  await page.click('.main button:has-text("+ Make a referral")');
  await page.waitForSelector('.modal select[name=resource_id]'); await settle(page);
  ok(await page.$eval('.modal [data-field="barrier"]', e => e.hidden) && await page.$eval('.modal [data-field="outcome"]', e => e.hidden), 'a new referral under way does not ask for its outcome or barrier');
  await page.selectOption('.modal select[name=status]', 'completed');
  ok(!(await page.$eval('.modal [data-field="barrier"]', e => e.hidden)), 'one entered as already completed does');
  await page.selectOption('.modal select[name=status]', 'pending');
  const opts = await page.$$eval('.modal select[name=resource_id] option', os => os.map(o => o.value).filter(v => v && !v.startsWith('__')));
  let pick = null;
  for (const o of opts) { const r = (await api('GET', `/api/clients/${target.id}/consents?resource_id=${o}`)).data; if (!(r.consents || []).some(x => x.names_resource)) { pick = o; break; } }
  await page.selectOption('.modal select[name=resource_id]', pick);
  const rec = await until(() => page.$('.modal [data-record-consent-naming]'));
  ok(rec, 'no consent names the provider: the form offers to record one');
  await rec.click();
  await until(() => page.$('.modal [data-referral-step="consent"]'));
  eq(await dialogs(page), 1, 'the consent is a step of the referral dialog, not a dialog on top');
  ok(await page.$eval('.modal form:has(select[name=resource_id])', f => f.hidden), 'the referral waits, hidden, as it was left');
  eq(await page.evaluate(() => document.activeElement && document.activeElement.tagName), 'H3', 'focus moves to the step\'s heading');
  ok(!(await page.$('.modal textarea[name=scope]')), 'the consent asks for its scope once: the ticks');
  const noteLabel = await page.$eval('.modal [data-field="scope_note"] > label', l => l.textContent);
  ok(/not enforced/.test(noteLabel), 'the free text is an optional note that says it is not enforced', noteLabel);
  ok(await page.isChecked('.modal input[name=cat_referrals]') && await page.isChecked('.modal input[name=cat_demographics]'), 'identity and referrals are ticked for a referral');
  ok(await saveInView(page), 'Record consent is on screen in the step');
  await page.fill('.modal input[name=expires_at]', '2099-01-01');
  for (const n of ['signed_on_paper', 'revocation_right_given', 'redisclosure_notice_given', 'refusal_consequences_given']) await page.check(`.modal input[name=${n}]`);
  await page.click('.modal button[type=submit]:visible:has-text("Record consent")');
  await until(async () => !(await page.$('.modal [data-referral-step="consent"]')));
  const consents = (await api('GET', `/api/clients/${target.id}/consents`)).data.consents;
  const fresh = consents.find(c => c.names_resource !== false && /Referral and care coordination/.test(c.purpose || '')) || consents[0];
  ok(fresh && /Identity and contact details/.test(fresh.scope || '') && /Referrals and care coordination/.test(fresh.scope || ''), 'the consent\'s scope is written from its ticks', fresh && fresh.scope);
  await until(async () => (await page.inputValue('.modal select[name=consent_id]').catch(() => '')) === (fresh && fresh.id));
  eq(await page.inputValue('.modal select[name=consent_id]'), fresh && fresh.id, 'back in the referral, with the new consent chosen');
  // A provider not listed: its own step, the same dialog.
  await page.selectOption('.modal select[name=resource_id]', '__add_resource__');
  await until(() => page.$('.modal [data-referral-step="provider"]'));
  eq(await dialogs(page), 1, 'adding an unlisted provider is a step too');
  const provName = `Riverside Recovery ${Date.now() % 10000}`;
  await page.fill('.modal [data-referral-step="provider"] input[name=name]', provName);
  const cats = await page.$$eval('.modal [data-referral-step="provider"] select[name=category] option', os => os.map(o => o.value).filter(Boolean));
  await page.selectOption('.modal [data-referral-step="provider"] select[name=category]', cats[0]);
  await page.click('.modal [data-referral-step="provider"] button[type=submit]');
  await until(async () => !(await page.$('.modal [data-referral-step="provider"]')));
  const chosen = await page.$eval('.modal select[name=resource_id]', s => s.options[s.selectedIndex].textContent);
  ok(chosen.includes(provName), 'the new provider is chosen in the referral', chosen);
  // Escape in a step goes back to the referral, not out of it.
  await page.selectOption('.modal select[name=resource_id]', '__add_resource__');
  await until(() => page.$('.modal [data-referral-step="provider"]'));
  await page.keyboard.press('Escape');
  await until(async () => !(await page.$('.modal [data-referral-step="provider"]')));
  eq(await dialogs(page), 1, 'Escape in a step returns to the referral');
  await closeModals(page);
}

// ---- 10. Save stays in view at phone width, below the last field, in the same order ----
{
  const phone = await session('mrivera', PW, { width: 390, height: 844 });
  const { page } = phone;
  await go(page, `client/${c1.id}`);
  const checks = [
    ['the visit form', () => openVisit(page, c1.id)],
    ['the consent form', async () => { await page.evaluate(async (id) => (await import('./views/part2.js')).openConsentForm(id, {}), c1.id); await page.waitForSelector('.modal input[name=signed_on_paper]'); }],
    ['the full intake form', async () => { await page.evaluate(async () => (await import('./views/clients.js')).openClientForm(null, null, { full: true })); await page.waitForSelector('.modal select[name=housing_status]'); }],
    ['the referral form', async () => { await page.evaluate(async (id) => (await import('./views/referrals.js')).openReferralForm(null, { clientId: id, clientDisplay: 'x' }), c1.id); await page.waitForSelector('.modal select[name=resource_id]'); }],
  ];
  for (const [name, open] of checks) {
    await open(); await settle(page);
    ok(await saveInView(page), `${name}: Save is on screen at 390×844 as it opens`);
    const end = await page.evaluate(() => {
      const bg = [...document.querySelectorAll('#modal-root > .modal-bg')].pop(); bg.scrollTop = bg.scrollHeight;
      const form = [...bg.querySelectorAll('form')].filter(f => !f.hidden).pop(); const row = form.lastElementChild;
      const fields = [...form.querySelectorAll('.field')].filter(x => x.checkVisibility() && x.getBoundingClientRect().height > 0); const lastField = fields[fields.length - 1];
      return { rowIsLast: row.classList.contains('btn-row'), sticky: getComputedStyle(row).position, gap: Math.round(row.getBoundingClientRect().top - lastField.getBoundingClientRect().bottom) };
    });
    ok(end.rowIsLast && end.sticky === 'sticky', `${name}: the action row is still the form's last element (Tab and screen-reader order unchanged)`, end);
    ok(end.gap >= 0, `${name}: scrolled to the end, it sits below the last field, covering nothing`, end);
    await closeModals(page);
  }
  await phone.close();
}

await nav.close(); await admin.close();
await browser.close();
finish(errors);

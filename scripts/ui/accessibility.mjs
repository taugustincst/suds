// WCAG 2.1 A/AA conformance audit. docs/accessibility/ACR-WCAG21.md reports what this checks; the rules a
// view has to follow to pass it are in docs/accessibility/DEVELOPERS.md.
//
// axe-core is a test-only dependency, like Playwright: it is never in package.json. Install both for a run
// (in one command — a later `npm i --no-save` of one package prunes the other):
//   npm i --no-save playwright axe-core && npx playwright install chromium
//
// 1. axe-core, with every rule tagged wcag2a, wcag2aa, wcag21a or wcag21aa plus the structural rules that
//    back 1.3.1/2.4.1/2.4.6 (one main landmark, heading order, a level-one heading, named dialogs), on every
//    page in the navigation, the profile, the second views of tabbed pages, every client tab, a resource
//    profile, every Settings tab (Security status, FHIR clients, System & backups with the recovery drill
//    card, Lists, an access request waiting), State reporting (#/caloms), each section of Privacy & Part 2
//    (the notice and its editor, complaints, incidents) and the key dialogs (+ Log and each thing it records,
//    new client, referral, consent with the §2.31 elements, disclosure and its §2.32 notice, Part 2 notice,
//    court order, problem, goal, step, ASAM and each outcome measure, the CalOMS admission, discharge and
//    episode records, complaint, incident, FHIR client, access request approval, identified export, resource,
//    overdose, expenditure). The seed has none of the clinical, CalOMS or Part 2 records, so prepareOffice()
//    makes them through the API before the passes start. For every seeded role on the office server, and for a fresh
//    Sign up on SUDS on this device (the static build) — at desktop (1280) and phone (390) widths, in the
//    light and dark themes, and at 200% text. Any violation fails the run; the report lists every one by
//    page, rule, impact and element, and a summary by rule at the end.
// 2. What axe cannot judge, checked on the same pages: a descriptive title per address that never names a
//    client (2.4.2); no sideways scrolling or clipped content at 320 CSS px and at 200% text (1.4.10, 1.4.4);
//    nothing clipped with the WCAG text-spacing overrides applied (1.4.12); a visible focus indicator on every
//    control the keyboard reaches, and no focus stop that cannot be seen (2.4.7, 2.4.3).
// 3. Keyboard only (2.1.1, 2.1.2, 2.4.1, 2.4.3, 3.3.1, 3.3.3, 4.1.3, 2.2.1): the skip link; a dialog keeps
//    Tab inside it, closes with Escape and gives focus back; a form error is announced, identified and
//    focused; the idle sign-out warning can be extended; and the main tasks done with the keyboard alone —
//    create a client, log a visit, record a consent and make a referral that relies on it, write and sign a
//    note.
//
// Environment: SUDS_URL (office server, seeded) and SUDS_STATIC_URL (the static build), as run-all.sh sets
// them. A11Y_SCOPE=quick runs one role and the light desktop pass only (for iterating on a fix);
// A11Y_SKIP_STATIC=1 leaves out the on-device build; A11Y_REPORT=file.json writes the findings as JSON.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, settle, until } from './assert.mjs';

const require = createRequire(import.meta.url);
let axeSource;
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); }
catch { console.error('axe-core is not installed. Run: npm i --no-save playwright axe-core'); process.exit(2); }

const office = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const device = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8878';
const quick = process.env.A11Y_SCOPE === 'quick';
const PW = 'Navigator2026!!';
const ROLES = [['admin', 'AdminPassw0rd!x'], ['jwalker', PW], ['kpatel', PW], ['mrivera', PW], ['afinance', PW], ['rreader', PW]];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
// Best-practice rules in axe that test what 1.3.1 (structure), 2.4.1 (bypass blocks) and 2.4.6 (headings)
// ask for. They are held to the same standard: any hit fails the run.
const STRUCTURE = ['landmark-one-main', 'landmark-no-duplicate-main', 'landmark-unique', 'page-has-heading-one', 'heading-order', 'empty-heading', 'aria-dialog-name', 'empty-table-header'];
const DEFAULT_TITLE = 'SUDS — SUD Navigator Services Tracker';

const { ok, eq, fail, finish } = makeChecks('accessibility');
const errors = [];
const browser = await chromium.launch();

// ------------------------------------------------------------------------------------------------ report
const byRule = new Map(); // rule -> { impact, help, url, pages:Set, nodes }
const pageReports = [];
function record(where, violations) {
  for (const v of violations) {
    const r = byRule.get(v.id) || { impact: v.impact, help: v.help, url: v.helpUrl, pages: new Set(), nodes: 0 };
    r.pages.add(where); r.nodes += v.nodes.length; byRule.set(v.id, r);
  }
  if (violations.length) pageReports.push({ where, violations });
}
const describe = (violations) => violations.map(v => `${v.id} [${v.impact}] ${v.help}: ${v.nodes.slice(0, 4).map(n => n.target.join(' ') + (n.summary ? ` (${n.summary})` : '')).join(' | ')}${v.nodes.length > 4 ? ` … +${v.nodes.length - 4} more` : ''}`);
// A finding of one of this script's own checks, reported like an axe rule so the summary counts it.
const own = (id, help) => ({ id, impact: 'serious', help, helpUrl: 'docs/accessibility/ACR-WCAG21.md' });

async function axe(page, where) {
  await page.evaluate(axeSource + ';0').catch(() => {});
  const res = await page.evaluate(async ({ tags, extra }) => {
    if (!window.axe) return { error: 'axe did not load' };
    const rules = [...new Set([...window.axe.getRules(tags).map(r => r.ruleId), ...extra])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.map(n => ({ target: n.target, summary: (n.failureSummary || '').split('\n').slice(1, 2).join('').trim() })) })) };
  }, { tags: TAGS, extra: STRUCTURE });
  if (res.error) { fail(`${where}: ${res.error}`); return; }
  record(where, res.violations);
  ok(res.violations.length === 0, `${where}: no WCAG 2.1 A/AA violations`, res.violations.length ? describe(res.violations) : undefined);
}

// ------------------------------------------------------------------------------ checks axe cannot make
// 2.4.2: every address has a title of its own that says what the page is, and never a client's name.
async function titleCheck(page, where, { clientName } = {}) {
  const t = await page.title();
  const bad = !t || t === DEFAULT_TITLE || !/— SUDS/.test(t) || (clientName && t.includes(clientName));
  if (bad) record(where, [{ ...own('page-title', 'Each page has a descriptive title that does not name a client'), nodes: [{ target: ['title'], summary: t }] }]);
  ok(!bad, `${where}: the page title says what the page is ("${t}")`, t);
}
// 1.4.10 / 1.4.4: nothing wider than the viewport outside something meant to scroll sideways (a data table's
// wrapper, a tab strip). Content cut off by an overflow:clip ancestor counts: it is lost, not reflowed.
const OVERFLOW_PROBE = () => {
  const vw = document.documentElement.clientWidth; const out = [];
  const scroller = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll)/.test(s.overflowX)) return true; if (a.classList.contains('sr-only')) return true; } return false; };
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sr-only, [hidden], .hidden, [aria-hidden=true], .skip-link, .modal-bg:not(:last-child), .sidebar:not(.open)')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > vw + 1 && r.left < vw && !scroller(el)) {
      const s = getComputedStyle(el); if (s.position === 'fixed' && r.left >= vw) continue;
      out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} (${Math.round(r.right)}px > ${vw}px) "${(el.textContent || '').trim().slice(0, 30)}"`);
    }
  }
  // The innermost offenders are the useful ones; their ancestors overflow because of them.
  return { page: document.documentElement.scrollWidth > vw + 1, items: out.slice(-6) };
};
async function reflowCheck(page, where, width) {
  const size = page.viewportSize();
  if (width) { await page.setViewportSize({ width, height: 640 }); await page.waitForTimeout(150); }
  const r = await page.evaluate(OVERFLOW_PROBE);
  if (width) { await page.setViewportSize(size); await page.waitForTimeout(80); }
  const bad = r.page || r.items.length;
  if (bad) record(where, [{ ...own('reflow', `Content reflows without sideways scrolling or clipping${width ? ` at ${width} CSS px` : ''}`), nodes: r.items.map(x => ({ target: [x] })) }]);
  ok(!bad, `${where}: content reflows${width ? ` at ${width} CSS px` : ''} (no sideways scroll or clipped content)`, bad ? r : undefined);
}
// 1.4.12: the WCAG text-spacing overrides (line height 1.5, paragraph spacing 2em, letter .12em, word .16em)
// clip nothing. Truncation that is a design choice with the full text available (ellipsis with a tooltip,
// a clamped summary that opens the full record) is left to the ACR; everything else must grow.
async function spacingCheck(page, where) {
  const r = await page.evaluate(() => {
    const st = document.createElement('style'); st.id = 'a11y-spacing';
    st.textContent = '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }';
    document.head.append(st);
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.sr-only, [hidden], .hidden, .sidebar:not(.open), [aria-hidden=true]')) continue;
      if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
      const s = getComputedStyle(el);
      if (!/(hidden|clip)/.test(s.overflowX + s.overflowY) || s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none') continue;
      if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/).slice(0, 2).join('.')} "${el.textContent.trim().slice(0, 30)}"`);
    }
    st.remove();
    return out.slice(0, 6);
  });
  if (r.length) record(where, [{ ...own('text-spacing', 'No text is clipped with increased text spacing'), nodes: r.map(x => ({ target: [x] })) }]);
  ok(!r.length, `${where}: nothing is clipped with WCAG text spacing`, r.length ? r : undefined);
}
// 2.4.7 / 2.4.3: Tab from the top of the page; every stop shows a focus indicator and is something visible.
async function focusCheck(page, where, stops = 30) {
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); });
  const bad = [];
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      let el = document.activeElement; if (!el || el === document.body) return { done: true };
      // Inside a date or time field Tab also visits the browser's own parts (the calendar button), which
      // draw their own focus ring; the field is the host, not the thing focused, so there is nothing to read.
      if (/^(date|time|datetime-local|month|week)$/.test(el.type) && !el.matches(':focus')) return { skip: true };
      // A file input laid invisibly over its label (.file-btn): the label carries the ring.
      if (el.type === 'file' && el.closest('.file-btn')) el = el.closest('.file-btn');
      const s = getComputedStyle(el); const r = el.getBoundingClientRect();
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1) || (s.boxShadow && s.boxShadow !== 'none');
      const label = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.getAttribute('aria-label') || el.textContent || el.name || '').trim().slice(0, 30)}"`;
      return { label, ring, visible: r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.opacity !== '0' };
    });
    if (f.done) break;
    if (f.skip) continue;
    if (!f.ring) bad.push(`no focus indicator: ${f.label}`);
    if (!f.visible) bad.push(`focus on something that cannot be seen: ${f.label}`);
  }
  if (bad.length) record(where, [{ ...own('focus-visible', 'Every keyboard focus stop is visible and shows a focus indicator'), nodes: bad.slice(0, 6).map(x => ({ target: [x] })) }]);
  ok(!bad.length, `${where}: every focus stop is visible with a focus indicator`, bad.length ? bad.slice(0, 6) : undefined);
}

// ---------------------------------------------------------------------------------------------- helpers
// The office server allows 600 API requests a minute from one address (server/app.js), and four passes in
// parallel ask for more than that. Every office API request is counted, and a pass waits before its next page
// or dialog while the last minute is near the limit, rather than being refused part-way through a page.
const apiTimes = [];
async function pace() {
  for (;;) {
    const now = Date.now(); while (apiTimes.length && apiTimes[0] < now - 61000) apiTimes.shift();
    if (apiTimes.length < 480) return;
    await new Promise(r => setTimeout(r, 400));
  }
}
const watch = (page, who) => {
  page.on('request', r => { if (r.url().startsWith(office + '/api/')) apiTimes.push(Date.now()); });
  page.on('pageerror', e => errors.push(`${who}: PAGEERROR ${e.message}`));
  page.on('response', r => { if (r.status() >= 500) errors.push(`${who}: HTTP ${r.status()} ${r.url()}`); });
};
async function dismissTour(p) {
  await p.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ tour_done: true }) }).catch(() => {}));
  await settle(p);
  await p.evaluate(async () => { const a = await import('./app.js'); a.prefs.set('tour_done', true); document.querySelectorAll('.modal-bg').forEach(m => m.remove()); });
}
async function signIn(page, base, username, password) {
  if (base === office) await pace();
  await page.goto(base + '/#/login'); await page.waitForSelector('input[name=username]'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', password);
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  await dismissTour(page);
}
async function go(page, base, hash) {
  if (base === office) await pace();
  await page.goto(`${base}/#/${hash}`); await settle(page);
  await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {});
  await settle(page);
  // Nothing left open behind a page (the tour, a stray dialog) is part of what is being audited.
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
}
const closeDialogs = async (page) => { for (let i = 0; i < 4 && await page.$('.modal-bg'); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(80); } await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove())); };

// The pages a signed-in person can reach: the navigation (filtered by what the role may open), the
// profile, and the second views of tabbed pages.
async function pagesFor(page) {
  return page.evaluate(async () => {
    const a = await import('./app.js');
    const may = (perm) => !perm || (Array.isArray(perm) ? perm.some(x => a.can(x)) : a.can(perm));
    const out = a.NAV.filter(n => n.name && may(n.perm)).map(n => n.name);
    out.push('profile');
    if (out.includes('calls')) out.push('calls?method=text');
    if (out.includes('budget')) out.push('budget?tab=expenditures', 'budget?tab=analysis');
    if (out.includes('supervision') && a.can('audit:read')) out.push('supervision?tab=breakglass');
    if (a.state.local) out.push('sync');
    // State reporting (CalOMS Tx and the county EHR hand-off) is reached from Reports, not the navigation.
    if (a.can('episodes:read') || a.can('episodes:write') || a.can('export:identified')) out.push('caloms');
    return out;
  });
}
async function firstId(page, path, key) {
  return page.evaluate(async ({ path, key }) => {
    if (window.SUDS_LOCAL) { const r = await window.SUDS_LOCAL.handle('GET', path, undefined, { 'X-Requested-With': 'suds' }); return ((r.json && r.json[key]) || [])[0]?.id || null; }
    const r = await fetch(path, { headers: { 'X-Requested-With': 'suds' } }); if (!r.ok) return null; const j = await r.json(); return ((j[key] || [])[0] || {}).id || null;
  }, { path, key });
}

// ------------------------------------------------------------------ records for the newer views
// The seed has no problem list, care plan, ASAM or outcome measures, CalOMS records, Part 2 notices, court
// orders, complaints, incidents, FHIR clients or access requests. Without them those views would only be
// audited empty, so they are made here, once, through the API: on the first client each role's audit opens
// (a caseload-scoped role's first client is not the administrator's), plus one client with no episode for
// the CalOMS admission dialog.
const prepared = { freshClient: null, firstClient: {} };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const CALOMS_ADMISSION = {
  admission_transaction: '1', service_type: '01', referral_source: '01', days_waited: 3, prior_episodes: 0, mat_planned: 'N', calworks: 'N',
  sex_at_birth: 'F', gender_identity: '2', race: ['01'], ethnicity: '05', veteran: 'N', disability: ['1'], zip_code: '95814', education_grade: 12,
  children_under_18: 1, children_cps: 0, pregnant: 'N', primary_drug: '05', primary_route: '2', primary_age_first_use: 19, secondary_drug: '00', iv_use_12m: 'N',
  primary_days_used: 10, alcohol_days: 0, iv_use_30: 'N', employment_status: '3', paid_work_days: 0, school_enrolled: 'N', job_training: 'N', living_arrangement: '2',
  arrests_30: 0, jail_days_30: 0, prison_days_30: 0, er_visits_30: 0, hospital_nights_30: 0, physical_health_days_30: 2, mh_diagnosis: 'N', mh_er_visits_30: 0,
  psych_inpatient_days_30: 0, psych_meds: 'N', family_conflict_days_30: 1, social_support_days_30: 4, lives_with_user: 'N',
};
async function prepareOffice() {
  const { ctx, page } = await newPage(CONFIGS[0]); watch(page, 'prepare');
  const P = 'prepare';
  const must = (r, what) => { ok(r.status >= 200 && r.status < 300, `${P}: ${what}`, r.status >= 300 ? r : undefined); return r.data || {}; };
  // An access request waiting for an administrator (Settings → Users & roles), sent the way Sign up sends it.
  await page.goto(office + '/#/login'); await page.waitForSelector('input[name=username]');
  must(await api(page, 'POST', '/api/auth/signup', { display_name: 'Riley Request', username: `riley${Date.now().toString(36)}`, password: 'Request2026!!x', reason: 'New outreach worker' }), 'an access request is waiting');
  const ids = new Set();
  const as = async (user, pw) => { if (await page.$('.layout')) { await page.evaluate(async () => (await import('./app.js')).logout()); await page.waitForSelector('input[name=username]'); } await signIn(page, office, user, pw); };
  for (const [user, pw] of ROLES) { await as(user, pw); const id = await firstId(page, '/api/clients?limit=1', 'clients'); if (id) { ids.add(id); prepared.firstClient[user] = id; } }
  // The administrator: CalOMS Tx on (so the episode dialogs ask its questions) and a FHIR client.
  await as('admin', ROLES[0][1]);
  must(await api(page, 'PUT', '/api/caloms/settings', { enabled: true, providers: [{ id: '123456', name: 'Main clinic' }, { id: '654321', name: 'Satellite' }], start_date: '2020-01-01' }), 'CalOMS Tx reporting is on');
  must(await api(page, 'POST', '/api/admin/fhir-clients', { name: 'County EHR', recipient: 'County Behavioral Health', purpose: 'TREAT', scopes: ['system/*.read'] }), 'a FHIR client exists');
  // A supervisor (clients:all, care plan, assessments, Part 2 registers) records the clinical and Part 2 records.
  await as('jwalker', PW);
  const fresh = must(await api(page, 'POST', '/api/clients', { first_name: 'Ada', last_name: 'Audit', status: 'waitlist', confirm_duplicate: true }), 'a client with no episode');
  prepared.freshClient = fresh.id;
  for (const id of ids) {
    const prob = must(await api(page, 'POST', `/api/clients/${id}/problems`, { problem: 'Opioid use disorder, seeking MOUD', icd10_code: 'F11.20', icd10_description: 'Opioid dependence, uncomplicated', z_codes: ['Z59.02'], onset_date: day(-60), source: 'assessment' }), 'a problem on the list');
    const goal = must(await api(page, 'POST', `/api/clients/${id}/goals`, { goal: 'I want my ID back so I can get a job', problem_id: prob.id, target_date: day(60), review_date: day(-1) }), 'a care plan goal, its review overdue');
    must(await api(page, 'POST', `/api/goals/${goal.id}/steps`, { step: 'Request a birth certificate from the county clerk', owner_role: 'staff', target_date: day(7) }), 'a step toward it');
    must(await api(page, 'POST', `/api/clients/${id}/asam`, { assessed_at: day(-10), d1_rating: 1, d2_rating: 0, d3_rating: 2, d4_rating: 3, d5_rating: 3, d6_rating: 4, recommended_loc: '3.5', actual_loc: '2.1', discrepancy_reason: 'waitlist', summary: 'Residential recommended; waitlisted.' }), 'an ASAM assessment');
    must(await api(page, 'POST', `/api/clients/${id}/outcomes`, { instrument: 'phq9', administered_at: day(-30), responses: [2, 2, 2, 2, 2, 2, 2, 2, 0] }), 'a PHQ-9');
    must(await api(page, 'POST', `/api/clients/${id}/outcomes`, { instrument: 'phq9', administered_at: day(-1), responses: [1, 1, 1, 1, 1, 1, 1, 1, 1] }), 'a second PHQ-9, with a safety alert');
    must(await api(page, 'POST', `/api/clients/${id}/outcomes`, { instrument: 'gad7', administered_at: day(-1), responses: [2, 2, 1, 1, 0, 0, 1] }), 'a GAD-7');
    must(await api(page, 'POST', `/api/clients/${id}/consents`, { type: 'part2_tpo', signed_at: day(-5), discloser: 'This program', recipient: 'County Behavioral Health', purpose: 'For treatment, payment, and health care operations', scope: 'Assessment, care plan and attendance', expires_event: 'end of treatment', signed_on_paper: true, revocation_right_given: true, redisclosure_notice_given: true, refusal_consequences_given: true }), 'a §2.31 consent');
    must(await api(page, 'POST', `/api/clients/${id}/court-orders`, { order_type: 'noncriminal_2_64', court: 'Superior Court, Dept 4', case_ref: '26-FL-0042', issued_at: day(-3), purpose: 'Custody hearing', scope: 'Attendance dates only', findings_recorded: true, notice_requirement_met: true }), 'a court order');
    const eps = (await api(page, 'GET', `/api/clients/${id}/episodes`)).data?.episodes || [];
    const open = eps.find(e => e.status === 'open');
    if (open) must(await api(page, 'POST', `/api/episodes/${open.id}/caloms`, { record_type: 'admission', provider_id: '123456', answers: CALOMS_ADMISSION }), 'a CalOMS admission record');
    else must(await api(page, 'POST', `/api/clients/${id}/episodes`, { opened_at: day(-20), caloms: { provider_id: '123456', answers: CALOMS_ADMISSION } }), 'an episode with its CalOMS admission');
  }
  const [cid] = ids;
  must(await api(page, 'POST', '/api/complaints', { client_id: cid, received_at: day(-4), channel: 'in_person', complainant: 'client', summary: 'My information went to my employer' }), 'a privacy complaint');
  const inc = must(await api(page, 'POST', '/api/incidents', { title: 'Misdirected fax', discovered_at: day(-2), description: 'A referral fax went to the wrong clinic', affected_count: 1 }), 'an incident');
  must(await api(page, 'POST', `/api/incidents/${inc.id}/clients`, { client_ids: [cid] }), 'with an affected client linked');
  await ctx.close();
}

// Dialogs opened the way the page opens them (the same exported functions the buttons call).
const DIALOGS = [
  ['+ Log menu', null, async (p) => { await p.locator('.appbar .quick:visible, .fab .quick:visible').first().click(); }],
  ['New client', 'clients:write', async (p) => p.evaluate(async () => (await import('./views/clients.js')).openClientForm(null))],
  ['Log visit', 'interventions:write', async (p) => p.evaluate(async () => (await import('./views/interventions.js')).openInterventionForm(null, {}))],
  ['Log call', 'calls:write', async (p) => p.evaluate(async () => (await import('./views/calls.js')).openCallForm(null, {}))],
  ['Log text', 'calls:write', async (p) => p.evaluate(async () => (await import('./views/calls.js')).openCallForm(null, { method: 'text' }))],
  ['Write note', ['notes:admin:write', 'notes:clinical:write'], async (p) => p.evaluate(async () => (await import('./views/notes.js')).openNoteForm(null, {}))],
  ['New task', 'tasks:write', async (p) => p.evaluate(async () => (await import('./views/tasks.js')).openTaskForm(null, {}))],
  ['Log time', 'time:write', async (p) => p.evaluate(async () => (await import('./views/time.js')).openTimeForm(null, {}))],
  ['New referral', 'referrals:write', async (p) => p.evaluate(async () => (await import('./views/referrals.js')).openReferralForm(null, {}))],
  ['New resource', 'resources:write', async (p) => p.evaluate(async () => (await import('./views/resources.js')).openResourceForm(null))],
  ['Overdose report', 'overdose:write', async (p) => p.evaluate(async () => (await import('./views/overdose.js')).openOverdoseForm(null, {}))],
  ['§2.32 notice with a disclosure', 'consents:write', async (p) => p.evaluate(async () => (await import('./views/part2.js')).showNotice({ text: 'This record which has been disclosed to you is protected by Federal confidentiality rules (42 CFR part 2).' }))],
  ['Expenditure', 'budget:write', async (p) => p.evaluate(async () => (await import('./views/budget.js')).openExpenditureForm(null, {}))],
];
async function auditDialogs(page, base, tag, clientId) {
  await go(page, base, 'dashboard');
  for (const [name, perm, open] of DIALOGS) {
    if (base === office) await pace();
    const allowed = await page.evaluate(async (perm) => { const a = await import('./app.js'); return !perm || [].concat(perm).some(x => a.can(x)); }, perm);
    if (!allowed) continue;
    if (name === '+ Log menu' && !(await page.$('.appbar .quick:visible, .fab .quick:visible'))) continue;
    try { await open(page); await page.waitForSelector('.modal', { timeout: 8000 }); await settle(page); }
    catch (e) { fail(`${tag} dialog "${name}" did not open: ${e.message.split('\n')[0]}`); await closeDialogs(page); continue; }
    await axe(page, `${tag} dialog: ${name}`);
    await closeDialogs(page);
  }
  // Dialogs opened from a button on a page, where the role has that button. A list of texts is a dialog
  // opened from inside another one (CalOMS records → + Annual update).
  for (const [hash, spec] of BUTTON_DIALOGS) {
    if (hash.includes(':client') && !clientId) continue;
    if (hash.includes(':fresh') && (!prepared.freshClient || base !== office)) continue;
    const texts = [].concat(spec);
    await go(page, base, hash.replace(':client', clientId).replace(':fresh', prepared.freshClient));
    const btn = page.locator(`.main button:visible:has-text("${texts[0]}")`).first();
    // A button the page shows but has switched off (the extract, with CalOMS off on the device) opens nothing.
    if (!(await btn.count()) || await btn.isDisabled()) continue;
    try {
      await btn.click(); await page.waitForSelector('.modal', { timeout: 8000 }); await settle(page);
      for (const text of texts.slice(1)) {
        const n = await page.$$eval('.modal', m => m.length);
        const inner = page.locator('.modal').last().locator(`button:visible:has-text("${text}")`).first();
        try { await inner.waitFor({ state: 'visible', timeout: 8000 }); }
        catch { throw new Error(`no "${text}" button in the dialog "${await page.locator('.modal h2').last().textContent().catch(() => '?')}"`); }
        await inner.click(); await until(async () => (await page.$$eval('.modal', m => m.length)) > n, { timeout: 8000 }); await settle(page);
      }
    } catch (e) { fail(`${tag} dialog "${texts.join(' → ')}" did not open: ${e.message.split('\n')[0]}`); await closeDialogs(page); continue; }
    await axe(page, `${tag} dialog: ${texts.join(' → ')} (#/${hash})`);
    await closeDialogs(page);
  }
  // Dialogs a list row opens (the row's own button, as the keyboard reaches it).
  for (const [hash, list, name] of ROW_DIALOGS) {
    if (hash.includes(':client') && !clientId) continue;
    await go(page, base, hash.replace(':client', clientId));
    const row = page.locator(`.main ${list} tbody tr.click .row-open:visible, .main ${list} tbody tr.click .row-open-extra:visible`).first();
    if (!(await row.count())) continue;
    try { await row.click(); await page.waitForSelector('.modal', { timeout: 8000 }); await settle(page); }
    catch (e) { fail(`${tag} dialog "${name}" did not open: ${e.message.split('\n')[0]}`); await closeDialogs(page); continue; }
    await axe(page, `${tag} dialog: ${name} (#/${hash})`);
    await closeDialogs(page);
  }
  // A note, opened from the list, and its signature dialog.
  if (clientId) {
    await go(page, base, `client/${clientId}/notes`);
    const row = page.locator('.main tbody tr.click:visible, .main .compact-row.click:visible').first();
    if (await row.count()) {
      await row.click(); await page.waitForSelector('.modal', { timeout: 8000 }).catch(() => {}); await settle(page);
      if (await page.$('.modal')) await axe(page, `${tag} dialog: a note`);
      await closeDialogs(page);
    }
  }
}
const BUTTON_DIALOGS = [
  ['client/:client/consents', '+ Consent'], ['client/:client/consents', '+ Disclosure'], ['client/:client/requests', '+ Request'],
  ['client/:client/team', '+ Assign worker'], ['client/:client/budget', '+ Record client assistance'],
  ['admin?tab=users', '+ New user'], ['admin?tab=apikeys', '+ New API key'], ['budget', '+ Funding source'], ['budget', '+ Line'],
  ['forms', '+ Add a county form'], ['forms', '+ Fill out a form'], ['documents', '+ Upload'], ['supplies', '+ Add item'],
  ['overdose', '+ Record an event'], ['resources', '+ Add resource'],
  // Clinical depth: the problem list, the care plan, ASAM and each outcome measure.
  ['client/:client/problems', '+ Problem'], ['client/:client/problems', 'Edit'], ['client/:client/problems', 'History'],
  ['client/:client/careplan', '+ Goal'], ['client/:client/careplan', '+ Step'], ['client/:client/careplan', 'Reviewed'],
  ['client/:client/assessments', '+ ASAM assessment'], ['client/:client/assessments', '+ PHQ-9'], ['client/:client/assessments', '+ GAD-7'],
  ['client/:client/assessments', '+ AUDIT-C'], ['client/:client/assessments', '+ DAST-10'],
  // CalOMS Tx on the Episodes tab (it is switched on for the audit), and the extract's confirmation.
  ['client/:client/episodes', 'CalOMS records'], ['client/:client/episodes', ['CalOMS records', '+ Annual update']], ['client/:client/episodes', 'Discharge'],
  ['client/:fresh/episodes', '+ Start an episode'], ['caloms', 'Download CalOMS Tx extract'],
  // 42 CFR Part 2 on the client record and on Privacy & Part 2.
  ['client/:client/consents', '+ Notice given'], ['client/:client/consents', '+ Court order'], ['client/:client/consents', 'Vacate'],
  ['compliance?tab=complaints', '+ Complaint'], ['compliance?tab=incidents', '+ Incident'],
  // Settings: an access request, a FHIR client, the recovery drill.
  ['admin?tab=users', 'Approve'], ['admin?tab=fhir', '+ New FHIR client'], ['admin?tab=fhir', 'Edit'],
  ['reports', 'Identified Excel workbook'], ['admin?tab=lists', '+ Add funding source'],
];
// [page, the <summary> that unfolds it, name]
const EXPANDED = [
  ['compliance?tab=notice', 'details[data-notice-editor] > summary', 'notice editor open'],
  ['admin?tab=lists', 'details.list-card > summary', 'a list open'],
];
// [page, the list's container, name]: the first row's own button opens the record in a dialog.
const ROW_DIALOGS = [
  ['client/:client/assessments', '[data-asam]', 'an ASAM assessment'], ['client/:client/assessments', '[data-outcomes]', 'an outcome measure'],
  ['compliance?tab=complaints', '.card', 'a complaint'], ['compliance?tab=incidents', '.card', 'an incident'],
];

// What each pass checks beyond axe, so a matrix of 5 passes × 7 roles does not repeat the slow ones.
const focusSeen = new Set();
async function checkPage(page, cfg, tag, hash, extra = {}) {
  const where = `${tag} #/${hash}`;
  await axe(page, where);
  await titleCheck(page, where, extra);
  if (cfg.mobile) await reflowCheck(page, where, 320);
  if (cfg.text200) await reflowCheck(page, where);
  if (cfg.id === 'desktop-light') {
    await spacingCheck(page, where);
    const key = `${tag.split(' ')[0]} ${hash.replace(/[0-9a-f-]{36}/g, ':id')}`;
    if (!focusSeen.has(key)) { focusSeen.add(key); await focusCheck(page, where); }
  }
}
async function auditPages(page, base, cfg, tag, { clientId, resourceId, settingsTabs }) {
  const pages = await pagesFor(page);
  for (const hash of pages) { await go(page, base, hash); await checkPage(page, cfg, tag, hash); }
  if (clientId) {
    await go(page, base, `client/${clientId}`);
    const clientName = await page.evaluate(() => document.querySelector('.main h1')?.firstChild?.textContent.trim());
    const tabs = await page.$$eval('.main nav.tabs [data-tab]', els => els.map(e => e.dataset.tab));
    // A role that never sees client records (finance, read-only) gets "Not available for your role" there.
    const forbidden = await page.$('[data-client-forbidden]');
    ok(tabs.length > 5 || forbidden, `${tag}: the client record lists its sections, or says it is not available to this role`, tabs);
    if (forbidden) await checkPage(page, cfg, tag, `client/${clientId}`);
    for (const t of tabs) { await go(page, base, `client/${clientId}/${t}`); await checkPage(page, cfg, tag, `client/${clientId}/${t}`, { clientName }); }
  }
  if (resourceId) { await go(page, base, `resource/${resourceId}`); await checkPage(page, cfg, tag, `resource/${resourceId}`); }
  // Privacy & Part 2: each of its sections the role may open, and the notice editor opened.
  if (pages.includes('compliance')) {
    await go(page, base, 'compliance');
    const tabs = await page.$$eval('.main nav.tabs [data-tab]', els => els.map(e => e.dataset.tab));
    for (const t of tabs.slice(1)) { await go(page, base, `compliance?tab=${t}`); await checkPage(page, cfg, tag, `compliance?tab=${t}`); }
  }
  // Content that is on the page but folded away until it is opened.
  for (const [hash, summary, name] of EXPANDED) {
    if (hash.startsWith('admin') && !settingsTabs) continue;
    if (hash.startsWith('compliance') && !pages.includes('compliance')) continue;
    await go(page, base, hash);
    const el = await page.$(summary);
    if (!el) continue;
    if (!(await el.evaluate(x => x.parentElement.open))) { await el.click(); await settle(page); }
    const where = `${tag} #/${hash} (${name})`;
    await axe(page, where);
    if (cfg.mobile) await reflowCheck(page, where, 320);
    if (cfg.text200) await reflowCheck(page, where);
  }
  if (settingsTabs) {
    await go(page, base, 'admin');
    const tabs = await page.$$eval('.main nav.tabs [data-tab]', els => els.map(e => e.dataset.tab));
    for (const t of tabs.slice(1)) { await go(page, base, `admin?tab=${t}`); await checkPage(page, cfg, tag, `admin?tab=${t}`); }
  }
}

// ---------------------------------------------------------------------------------------- configurations
// Each pass is a browser context: a width, a colour scheme, and (for 200%) the root font size doubled —
// the app sizes its text in rem, so this is what a browser's text-size setting does.
const CONFIGS = [
  { id: 'desktop-light', viewport: { width: 1280, height: 900 }, scheme: 'light' },
  { id: 'phone-light', viewport: { width: 390, height: 844 }, scheme: 'light', mobile: true },
  { id: 'desktop-dark', viewport: { width: 1280, height: 900 }, scheme: 'dark' },
  { id: 'phone-dark', viewport: { width: 390, height: 844 }, scheme: 'dark', mobile: true },
  { id: 'text-200', viewport: { width: 1280, height: 900 }, scheme: 'light', text200: true },
];
async function newPage(cfg) {
  const ctx = await browser.newContext({ viewport: cfg.viewport, colorScheme: cfg.scheme, isMobile: !!cfg.mobile, hasTouch: !!cfg.mobile, deviceScaleFactor: 1 });
  if (cfg.text200) await ctx.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; }); });
  const page = await ctx.newPage();
  return { ctx, page };
}

// --------------------------------------------------------------------------------------- office server
async function officeRun(cfg, roles) {
  const { ctx, page } = await newPage(cfg); watch(page, `office ${cfg.id}`);
  // Signed out: the sign-in page, Sign up, and the phone/tablet page.
  const signedOut = async (where) => { await axe(page, where); await titleCheck(page, where); if (cfg.mobile) await reflowCheck(page, where, 320); if (cfg.text200) await reflowCheck(page, where); if (cfg.id === 'desktop-light') { await spacingCheck(page, where); await focusCheck(page, where, 15); } };
  await page.goto(office + '/#/login'); await page.waitForSelector('input[name=username]'); await settle(page);
  await signedOut(`office ${cfg.id} signed out #/login`);
  await page.goto(office + '/#/login?mode=signup'); await page.reload(); await page.waitForSelector('[data-account-mode=signup]'); await settle(page);
  await signedOut(`office ${cfg.id} signed out #/login?mode=signup`);
  for (const file of ['get-app.html', 'accessibility.html']) {
    await page.goto(`${office}/${file}`); await page.waitForLoadState('networkidle');
    await axe(page, `office ${cfg.id} ${file}`);
    if (cfg.mobile) await reflowCheck(page, `office ${cfg.id} ${file}`, 320);
    if (cfg.text200) await reflowCheck(page, `office ${cfg.id} ${file}`);
  }
  // The statement is reachable from the sign-in page and, signed in, from the menu (checked below).
  await page.goto(office + '/#/login'); await page.waitForSelector('input[name=username]');
  ok(await page.$('a[data-accessibility-statement][href="accessibility.html"]'), `office ${cfg.id}: the sign-in page links to the accessibility statement`);
  for (const [user, pw] of roles) {
    // Sign the previous role out the way the app does (the page must drop its signed-in state too).
    if (await page.$('.layout')) { await page.evaluate(async () => (await import('./app.js')).logout()); await page.waitForSelector('input[name=username]'); }
    await signIn(page, office, user, pw);
    const tag = `office ${cfg.id} ${user}`;
    // The client prepared for this role (the keyboard pass adds clients, which would change "the first one").
    const clientId = prepared.firstClient[user] || await firstId(page, '/api/clients?limit=1', 'clients');
    const resourceId = await firstId(page, '/api/resources?limit=1', 'rows');
    const settingsTabs = await page.evaluate(async () => { const a = await import('./app.js'); return a.can('users:manage') || a.can('assignments:manage'); });
    ok(await page.$('.sidebar a[data-accessibility-statement]'), `${tag}: the menu links to the accessibility statement`);
    await auditPages(page, office, cfg, tag, { clientId, resourceId, settingsTabs });
    await auditDialogs(page, office, tag, clientId);
  }
  await ctx.close();
}

// ------------------------------------------------------------------------------------ SUDS on this device
async function deviceRun(cfg) {
  const { ctx, page } = await newPage(cfg); watch(page, `device ${cfg.id}`);
  await page.goto(device + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 20000 }); await settle(page);
  await axe(page, `device ${cfg.id} first-run Sign up`); await titleCheck(page, `device ${cfg.id} first-run Sign up`);
  if (cfg.mobile) await reflowCheck(page, `device ${cfg.id} first-run Sign up`, 320);
  await page.click('[data-mode-tab=login]'); await settle(page);
  await axe(page, `device ${cfg.id} Log in (no account yet)`);
  await page.click('[data-mode-tab=signup]'); await settle(page);
  await page.fill('input[name=display_name]', 'Avery Access'); await page.fill('input[name=username]', 'avery');
  await page.fill('input[name=password]', PW); await page.fill('input[name=confirm]', PW);
  // The administrator role reaches every page on the device, Settings included.
  if (await page.$('select[name=role] option[value=admin]')) await page.selectOption('select[name=role]', 'admin');
  await page.check('input[name=storage_ack]'); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 20000 }); await dismissTour(page);
  // One client with a record of each kind, so the tabs and lists have rows to audit.
  await page.evaluate(async () => {
    const H = { 'X-Requested-With': 'suds', 'Content-Type': 'application/json' };
    const call = (m, p, b) => window.SUDS_LOCAL.handle(m, p, b, H);
    const c = (await call('POST', '/api/clients', { first_name: 'Dana', last_name: 'Device', status: 'active', risk_level: 'moderate', phone: '555-0100' })).json;
    await call('POST', '/api/interventions', { client_id: c.id, type: 'outreach', occurred_at: new Date().toISOString(), duration_minutes: 20, summary: 'Met at the library.' });
    await call('POST', '/api/tasks', { client_id: c.id, title: 'Call back', due_at: new Date().toISOString().slice(0, 10) });
    await call('POST', '/api/resources', { name: 'Harbor Clinic', category: 'outpatient', city: 'Springfield', phone: '555-0199' });
  });
  const tag = `device ${cfg.id} avery`;
  const clientId = await firstId(page, '/api/clients?limit=1', 'clients');
  const resourceId = await firstId(page, '/api/resources?limit=1', 'rows');
  ok(clientId && resourceId, `${tag}: the device has a client and a resource to audit`, { clientId, resourceId });
  await auditPages(page, device, cfg, tag, { clientId, resourceId, settingsTabs: true });
  await auditDialogs(page, device, tag, clientId);
  for (const file of ['get-app.html', 'accessibility.html']) {
    await page.goto(`${device}/${file}`); await page.waitForLoadState('networkidle');
    await axe(page, `device ${cfg.id} ${file}`);
    if (cfg.mobile) await reflowCheck(page, `device ${cfg.id} ${file}`, 320);
  }
  await page.goto(device + '/get-app.html'); await page.waitForLoadState('networkidle');
  ok(await page.$('a[data-accessibility-statement][href="accessibility.html"]'), `device ${cfg.id}: the phone/tablet page links to the accessibility statement`);
  await ctx.close();
}

// ---------------------------------------------------------------------------------------- keyboard only
// Everything below is done with page.keyboard: no clicks, no fill(). Page loads use the address bar (itself
// a keyboard action); reading state back uses the API.
async function tabTo(page, selector, { text = null, max = 120, shift = false } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    const hit = await page.evaluate(({ selector, text }) => { const el = document.activeElement; return !!el && el.matches(selector) && (!text || (el.textContent || el.getAttribute('aria-label') || '').includes(text)); }, { selector, text });
    if (hit) return true;
  }
  return false;
}
const active = (page) => page.evaluate(() => { const el = document.activeElement; return el ? { tag: el.tagName.toLowerCase(), name: el.name || '', text: (el.textContent || '').trim().slice(0, 40), inModal: !!el.closest('.modal'), id: el.id } : null; });
async function keyboardType(page, text) { await page.keyboard.type(text, { delay: 10 }); }
// Choose a <select> option by typing the start of its label (the browser's own type-ahead).
async function pickByTyping(page, text) { await page.keyboard.type(text, { delay: 60 }); await page.waitForTimeout(100); }
async function chooseClient(page, query) {
  await keyboardType(page, query);
  await until(() => page.$('.modal [role=listbox]:not(.hidden) [role=option]'), { timeout: 6000 });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  return page.evaluate(() => document.querySelector('.modal .client-picker input[type=hidden]')?.value || '');
}
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, { method, path, body });

async function keyboardRun() {
  const cfg = CONFIGS[0];
  const { ctx, page } = await newPage(cfg); watch(page, 'keyboard');
  await signIn(page, office, 'mrivera', PW);
  const K = 'keyboard';

  // --- 2.4.1 skip link: the first Tab on a page reaches it, and Enter moves focus to the page content.
  await go(page, office, 'dashboard');
  await page.reload(); await page.waitForSelector('.layout'); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  await page.keyboard.press('Tab');
  eq((await active(page))?.text, 'Skip to content', `${K}: the first Tab on a page is "Skip to content"`);
  ok(await page.evaluate(() => { const el = document.activeElement; const r = el.getBoundingClientRect(); return r.left >= 0 && r.width > 0; }), `${K}: and it is visible when focused`);
  await page.keyboard.press('Enter');
  ok(await page.evaluate(() => !!document.activeElement.closest('#main')), `${K}: Enter on it moves focus to the page content`, await active(page));

  // --- 2.4.3 focus after moving pages: focus lands on the new page's heading, not the top of the document.
  await tabTo(page, '.nav a', { text: 'To-do list' });
  await page.keyboard.press('Enter'); await settle(page);
  ok(await page.evaluate(() => document.activeElement?.tagName === 'H1'), `${K}: after following a link, focus is on the new page's heading`, await active(page));
  eq(await page.title(), 'To-do list — SUDS', `${K}: and the title names the new page`);

  // --- create a client, keyboard only; with an error first (3.3.1, 3.3.3, 4.1.3), then correctly.
  await go(page, office, 'clients');
  ok(await tabTo(page, 'button', { text: 'New client' }), `${K}: Tab reaches "+ New client"`);
  const opener = await active(page);
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal');
  eq((await active(page))?.name, 'first_name', `${K}: the New client dialog opens with focus on its first field`);
  // Tab stays inside the dialog (2.1.2: no trap, and no escape into the page behind it).
  let escaped = 0; for (let i = 0; i < 70; i++) { await page.keyboard.press('Tab'); if (!(await active(page))?.inModal) escaped++; }
  eq(escaped, 0, `${K}: 70 Tabs inside the dialog never leave it`);
  await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal')));
  eq((await active(page))?.text, opener.text, `${K}: Escape closes the dialog and focus goes back to the button that opened it`);
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal');
  // Submit it empty: Enter in the first field.
  await page.keyboard.press('Enter');
  await until(() => page.evaluate(() => document.querySelector('.modal [name=first_name]')?.getAttribute('aria-invalid') === 'true'), { timeout: 5000 });
  const err = await page.evaluate(() => { const i = document.querySelector('.modal [name=first_name]'); const ids = (i.getAttribute('aria-describedby') || '').split(' ').filter(Boolean); return { focused: document.activeElement === i, invalid: i.getAttribute('aria-invalid'), described: ids.map(id => document.getElementById(id)?.textContent || '').join(' '), banner: document.querySelector('.modal .banner.danger:not(.hidden)')?.getAttribute('role') }; });
  ok(err.focused, `${K}: a missing required field gets the focus`, err);
  eq(err.invalid, 'true', `${K}: and is marked aria-invalid`);
  ok(/First name is required/.test(err.described), `${K}: its error message names the field and is tied to it (aria-describedby)`, err.described);
  eq(err.banner, 'alert', `${K}: the summary above the form is an alert, so it is announced`);
  const stamp = Date.now().toString(36);
  await keyboardType(page, 'Kay'); await page.keyboard.press('Tab'); await keyboardType(page, `Board${stamp}`);
  await page.keyboard.press('Enter');
  // A possible duplicate is offered first; the keyboard can confirm it.
  await until(async () => /#\/client\//.test(page.url()) || await page.$('.modal button:has-text("Create anyway"), .modal [data-confirm-new]'), { timeout: 10000 });
  if (!/#\/client\//.test(page.url())) { await tabTo(page, 'button', { text: 'anyway' }); await page.keyboard.press('Enter'); }
  await until(() => /#\/client\//.test(page.url()), { timeout: 10000 }); await settle(page);
  const clientId = page.url().split('/client/')[1]?.split(/[/?]/)[0];
  ok(clientId, `${K}: a client is created with the keyboard alone`, page.url());
  const toastRole = await page.evaluate(() => [...document.querySelectorAll('#toasts [role]')].map(t => t.getAttribute('role')));
  ok(await page.evaluate(() => document.querySelector('#toasts')?.getAttribute('aria-live') === 'polite'), `${K}: saved-messages are in a polite live region (4.1.3)`, toastRole);

  // --- log a visit from + Log, keyboard only.
  await go(page, office, 'dashboard');
  ok(await tabTo(page, '.appbar .quick'), `${K}: Tab reaches "+ Log"`);
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal .quick-list');
  ok(await tabTo(page, '.modal .quick-list button', { text: 'Visit or service' }), `${K}: Tab reaches "Visit or service"`);
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal [name=type]');
  ok((await active(page))?.inModal, `${K}: the visit form opens with focus inside it`);
  ok(await chooseClient(page, `Board${stamp}`) === clientId, `${K}: the client is chosen from the search with arrow keys and Enter`);
  ok(await tabTo(page, '.modal select[name=type]'), `${K}: Tab reaches "What did you do?"`);
  await pickByTyping(page, 'Outreach');
  ok(await page.evaluate(() => document.querySelector('.modal select[name=type]').value !== ''), `${K}: a type is chosen by typing`);
  ok(await tabTo(page, '.modal button[type=submit]'), `${K}: Tab reaches Save`);
  await page.keyboard.press('Enter');
  await until(async () => !(await page.$('.modal')), { timeout: 10000 });
  const visits = await api(page, 'GET', `/api/interventions?client_id=${clientId}`);
  eq((visits.data?.rows || []).length, 1, `${K}: the visit is saved`);

  // --- a consent, then a referral that relies on it.
  await go(page, office, `client/${clientId}/consents`);
  ok(await tabTo(page, 'button', { text: '+ Consent' }), `${K}: Tab reaches "+ Consent"`);
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal [name=type]');
  eq((await active(page))?.name, 'type', `${K}: the consent form opens on its first field`);
  await pickByTyping(page, 'Roi');
  if (!(await page.evaluate(() => document.querySelector('.modal [name=type]').value))) { await page.keyboard.press('ArrowDown'); }
  await tabTo(page, '.modal [name=recipient]'); await keyboardType(page, 'Harbor Clinic');
  await tabTo(page, '.modal [name=purpose]'); await keyboardType(page, 'Coordinate treatment admission');
  await tabTo(page, '.modal [name=scope]'); await keyboardType(page, 'Name, contact details and referral need');
  await tabTo(page, '.modal [name=signed_on_paper]'); await page.keyboard.press('Space');
  await tabTo(page, '.modal [name=redisclosure_notice_given]'); await page.keyboard.press('Space');
  await tabTo(page, '.modal [name=expires_event]'); await keyboardType(page, 'discharge from the program');
  await tabTo(page, '.modal button[type=submit]'); await page.keyboard.press('Enter');
  await until(async () => !(await page.$('.modal')), { timeout: 10000 });
  const cons = await api(page, 'GET', `/api/clients/${clientId}/consents`);
  eq((cons.data?.consents || []).length, 1, `${K}: the consent is recorded`, cons.data);
  await go(page, office, `client/${clientId}/referrals`);
  ok(await tabTo(page, 'button', { text: '+ New referral' }), `${K}: Tab reaches "+ New referral"`);
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal [name=resource_id]');
  await tabTo(page, '.modal select[name=resource_id]'); await page.keyboard.press('ArrowDown');
  await tabTo(page, '.modal select[name=consent_id]'); await page.keyboard.press('ArrowDown');
  const chosen = await page.evaluate(() => ({ resource: document.querySelector('.modal [name=resource_id]').value, consent: document.querySelector('.modal [name=consent_id]').value }));
  ok(chosen.resource && chosen.resource !== '__add_resource__' && chosen.consent, `${K}: a provider and the consent are chosen with arrow keys`, chosen);
  await tabTo(page, '.modal button[type=submit]'); await page.keyboard.press('Enter');
  await until(async () => !(await page.$('.modal')), { timeout: 10000 });
  const refs = await api(page, 'GET', `/api/referrals?client_id=${clientId}`);
  ok((refs.data?.rows || []).some(r => r.consent_id === chosen.consent), `${K}: the referral is saved, relying on the consent`, (refs.data?.rows || []).map(r => r.consent_id));

  // --- write a note, then sign it.
  await go(page, office, 'dashboard');
  await tabTo(page, '.appbar .quick'); await page.keyboard.press('Enter'); await page.waitForSelector('.modal .quick-list');
  await tabTo(page, '.modal .quick-list button', { text: 'Note' }); await page.keyboard.press('Enter');
  await page.waitForSelector('.modal [name=content]');
  await chooseClient(page, `Board${stamp}`);
  await tabTo(page, '.modal [name=content]'); await keyboardType(page, 'Met at the drop-in. Agreed to the referral.');
  await tabTo(page, '.modal button[type=submit]'); await page.keyboard.press('Enter');
  await until(async () => !(await page.$('.modal')), { timeout: 10000 });
  await go(page, office, `client/${clientId}/notes`);
  ok(await tabTo(page, 'tbody tr.click button.row-open'), `${K}: Tab reaches the note in the list`);
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal');
  ok(await tabTo(page, '.modal button', { text: 'Sign & lock' }), `${K}: Tab reaches "Sign & lock"`);
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal [name=password]');
  eq((await active(page))?.name, 'password', `${K}: the signature dialog opens on the password field`);
  await keyboardType(page, PW); await page.keyboard.press('Enter');
  await until(async () => !(await page.$('.modal')), { timeout: 10000 });
  const notes = await api(page, 'GET', `/api/notes?client_id=${clientId}`);
  ok((notes.data?.rows || []).some(n => n.status === 'signed'), `${K}: the note is signed with the keyboard alone`, (notes.data?.rows || []).map(n => n.status));

  // --- 2.2.1 the idle sign-out warning: it comes a minute ahead, is announced, and can be extended.
  await go(page, office, 'dashboard');
  await page.evaluate(async () => { const a = await import('./app.js'); a.state.idleMinutes = 65 / 60; });
  const warn = await until(() => page.$('#idle-warn'), { timeout: 20000 });
  ok(warn, `${K}: a warning appears before the idle sign-out`);
  eq(await page.getAttribute('#idle-warn', 'role'), 'alert', `${K}: it is announced (role=alert)`);
  ok(await page.$('#idle-warn [data-stay-signed-in]'), `${K}: it has a "Stay signed in" button`);
  await page.focus('#idle-warn [data-stay-signed-in]'); await page.keyboard.press('Enter');
  ok(!(await page.$('#idle-warn')), `${K}: "Stay signed in" removes the warning`);
  await page.evaluate(async () => { const a = await import('./app.js'); a.state.idleMinutes = 15; });
  ok(await page.$('.layout'), `${K}: and the person is still signed in`);
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ run
const roles = quick ? ROLES.filter(([u]) => u === 'jwalker') : ROLES;
const configs = quick ? CONFIGS.slice(0, 1) : CONFIGS;
const jobs = [];
for (const cfg of configs) {
  // Every role in the light desktop pass (each role sees different pages and buttons); the other passes
  // use the three roles that between them reach every page and dialog: the administrator, a navigator, and a
  // supervisor (the only one of the three with ASAM and the outcome measures, which are clinical content).
  jobs.push(['office ' + cfg.id, () => officeRun(cfg, cfg.id === 'desktop-light' ? roles : roles.filter(([u]) => u === 'admin' || u === 'mrivera' || u === 'jwalker'))]);
  if (!process.env.A11Y_SKIP_STATIC) jobs.push(['device ' + cfg.id, () => deviceRun(cfg)]);
}
jobs.push(['keyboard', () => keyboardRun()]);
await prepareOffice().catch(e => fail(`preparing the records for the newer views failed: ${e.message.split('\n').slice(0, 3).join(' / ')}`));
const LIMIT = Number(process.env.A11Y_PARALLEL || 4);
const running = new Set();
for (const [name, job] of jobs) {
  const p = job().catch(e => fail(`the ${name} pass stopped: ${e.message.split('\n').slice(0, 3).join(' / ')}`)).finally(() => running.delete(p));
  running.add(p);
  if (running.size >= LIMIT) await Promise.race(running);
}
await Promise.all(running);

// ------------------------------------------------------------------------------------------------ summary
console.log('\n==== WCAG 2.1 A/AA findings by rule ====');
if (!byRule.size) console.log('none');
for (const [id, r] of [...byRule].sort((a, b) => b[1].nodes - a[1].nodes)) console.log(`${id} [${r.impact}] ${r.nodes} element(s) on ${r.pages.size} page(s) — ${r.help} (${r.url})`);
if (pageReports.length) {
  console.log('\n==== by page ====');
  for (const p of pageReports) { console.log(p.where); for (const line of describe(p.violations)) console.log('   ' + line); }
}
if (process.env.A11Y_REPORT) fs.writeFileSync(process.env.A11Y_REPORT, JSON.stringify({ rules: Object.fromEntries([...byRule].map(([k, v]) => [k, { ...v, pages: [...v.pages] }])), pages: pageReports }, null, 1));
await browser.close();
finish(errors);

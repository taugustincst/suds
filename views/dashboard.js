import { backupReminderCard, recoveryPromptCard } from './local.js';
import { h, route, get, put, post, confirmDialog, loadRefData, state, stat, bars, fmt, badge, statusKind, table, can, nav, pageHead, sparkline, quickActions, emptyState, toast, greetingName, prefs, welcomeCard, reachable } from '../app.js';

// One refresh timer for Home, however often it is drawn (each draw used to start another, and they piled up).
let homeTimer = null;
const onHome = () => location.hash.replace(/^#\/?/, '').split('?')[0] === 'dashboard' || location.hash === '' || location.hash === '#/';
// Home is never redrawn under someone working in it (focus on a control in the page, or a dialog open): a redraw
// takes the keyboard focus away.
const idle = () => { const a = document.activeElement; const main = document.getElementById('main');
  return !(a && a !== document.body && a !== main && a.tagName !== 'H1' && main && main.contains(a)) && !document.querySelector('.modal-bg'); };
// A redraw builds the new Home first and swaps it in whole, so the page never blanks to "Loading…" (it used to redraw
// the whole page every 90 seconds, empty until the figures came back). Only the latest redraw lands.
let homeRoute = null, homeSeq = 0;
async function redrawHome() {
  const seq = ++homeSeq;
  let view; try { view = await drawHome(homeRoute); } catch { return; }
  const main = document.getElementById('main');
  if (!(seq === homeSeq && main && onHome() && idle())) return;
  // The heading may have had the keyboard focus (idle() lets that be redrawn): it goes to the new heading, not to the
  // page's body, which a zoom user crossing 640 px lost their place to (market evaluation of 1.23.3, N2).
  const had = document.activeElement;
  main.replaceChildren(view);
  if (had && had !== document.body && !had.isConnected) {
    const h1 = main.querySelector('h1');
    if (h1) { if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1'); try { h1.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }
}
// Home is laid out for the width it is drawn at: a phone's order (today's to-dos first) up to 640 px, a computer's
// above. It was chosen once, when the figures came back, and never again: a screen whose width settled after that
// moment (a phone browser still sizing its window on a first sign-in, a phone turned, a window resized) kept the other
// layout, and "To-dos for today" sat below the first screen on some loads and not others (external retest of 1.23.2).
// Now Home follows the width: when it crosses 640 px, Home is laid out again for the new width (1.23.3).
const PHONE_HOME = '(max-width: 640px)';
let widthWatch = null;
function followWidth() {
  if (widthWatch || typeof matchMedia !== 'function') return;
  widthWatch = matchMedia(PHONE_HOME);
  const changed = () => {
    const shown = document.querySelector('#main [data-home-layout]');
    // Not drawn yet: the draw under way reads the width when it lays the page out.
    if (!onHome() || !shown || (shown.dataset.homeLayout === 'phone') === widthWatch.matches) return;
    // Someone working in the page keeps it until they leave the control or close the dialog.
    if (!idle()) { document.addEventListener('focusout', () => setTimeout(changed, 0), { once: true }); return; }
    redrawHome();
  };
  widthWatch.addEventListener('change', changed);
}
async function drawHome(r) {
  clearInterval(homeTimer);
  // Everything else Home asks the server for is asked for now, alongside the figures below, and waited for
  // where it is used. Each of these used to wait for the one before it: an administrator's Home was seven
  // round trips one after another, most of three seconds on a phone's connection before anything showed.
  const quiet = (p) => get(p, { quiet: true });
  const early = {
    requests: can('users:manage') && !state.local ? quiet('/api/users/access-requests').catch(() => null) : null,
    security: can('settings:manage') && !state.local ? quiet('/api/admin/security/alerts').catch(() => null) : null,
    caseloads: can('assignments:manage') ? quiet('/api/users/caseloads').catch(() => null) : null,
    // The intake queue (1.24.0): new referrals to the programme, and the open ones assigned to this person.
    incoming: can('intake:read') && (!state.local || !!window.SUDS_STATIC_HOST) ? quiet('/api/incoming-referrals/summary').catch(() => null) : null,
    supplies: can('supplies:manage') ? import('./supplies.js').then(m => m.supplyHome()) : null,
    // County files due (released in 1.21.0; server/county-schedule.js): for whoever makes the county
    // file, on an office server (SUDS on this device makes none).
    county: can('reports:funder') && can('budget:read') && can('export:read') && !state.local ? quiet('/api/county-submission/reminders').catch(() => null) : null,
    setup: can('settings:manage') && !state.local ? Promise.all([
      quiet('/api/forms/starters').catch(() => null),
      quiet('/api/users').catch(() => ({ users: [] })),
      quiet('/api/budget/funds').catch(() => ({ funds: [] })),
      quiet('/api/resources?limit=8').catch(() => ({ total: 0, rows: [] })),
      quiet('/api/admin/stats').catch(() => ({})),
      quiet('/api/admin/settings').catch(() => null),
      quiet('/api/consent-template').catch(() => null),
      can('interventions:write') ? quiet('/api/supplies').catch(() => null) : null,
      // The hardening checklist (server/hardening.js, 1.24.0): security settings shipped off or unset.
      quiet('/api/admin/security/hardening').catch(() => null),
    ]) : null,
  };
  // Waited for below, in order; marked handled now so a failure is not reported before its turn comes.
  for (const p of Object.values(early)) if (p) p.catch(() => {});
  const [d, cont, caseload, handoffs] = await Promise.all([get('/api/reports/dashboard'), get('/api/me/continue'), can('clients:read') ? get('/api/caseload') : { caseload: [] },
    can('notes:admin:read') ? get('/api/notes/handoffs?hours=24', { quiet: true }).catch(() => null) : null]);
  const force = !!(r && r.query && r.query.get('welcome') === '1');
  const experienced = force || !prefs.get('tour_done') ? await priorWork() : false;
  // "Today" is really "due by the end of today": anything from before today is overdue and goes first.
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));
  const isOverdue = (t) => fmt.isDateOnly(t.due_at) ? fmt.parse(t.due_at) < startOfToday : fmt.isPast(t.due_at);
  cont.due_today = [...cont.due_today].sort((a, b) => (isOverdue(b) - isOverdue(a)) || String(a.due_at).localeCompare(String(b.due_at)));
  const c = d.clients, i = d.interventions;
  // auto-refresh so changes made on another device appear without a manual reload. It can be switched off
  // (WCAG 2.2.2: moving content has a way to stop it), and it never redraws the page under someone working in
  // it — focus on a control in the page, or a dialog open — because a redraw takes the keyboard focus away.
  const autoOn = () => prefs.get('home_autorefresh', true) !== false;
  homeRoute = r; followWidth();
  homeTimer = setInterval(() => {
    if (!onHome()) { clearInterval(homeTimer); return; }
    if (autoOn() && idle()) redrawHome();
  }, 90_000);
  const autoToggle = h('label', { class: 'check small', style: { marginTop: 0 }, 'data-home-autorefresh': '1' }, h('input', { type: 'checkbox', checked: autoOn(), onChange: (e) => prefs.set('home_autorefresh', e.target.checked) }), 'Update this page every 90 seconds');
  const who = greetingName(state.user.display_name, state.user.username);
  const hour = new Date().getHours(); const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const alerts = [];
  // A count of people can come back as "<11" for a role that runs publication releases only
  // (server/dashboard-mask.js): plural, since it stands for more than one.
  const many = (n) => typeof n === 'string' || n > 1;
  // Your own overdue to-dos are counted in one place, the bell in the header (and listed under To-dos for
  // today below); a pill here said the same number a third time. A supervisor's count covers the team, which
  // the bell does not, so theirs stays, and says so.
  if (d.tasks.overdue && d.tasks.team) alerts.push(['danger', `${d.tasks.overdue} overdue to-do${d.tasks.overdue > 1 ? 's' : ''} across the team`, '#/tasks?overdue=1']);
  if (d.notes.unsigned) alerts.push([d.notes.unsigned_overdue ? 'danger' : 'warn', `${d.notes.unsigned} unsigned note${d.notes.unsigned > 1 ? 's' : ''}${d.notes.team ? ' across your team' : ''}`, d.notes.team ? '#/supervision' : '#/notes?status=draft&mine=1']);
  if (cont.staged_imports) alerts.push(['info', `${cont.staged_imports} imported note${cont.staged_imports > 1 ? 's' : ''} to review`, '#/imports']);
  if (c.no_contact_30d) alerts.push(['warn', `${c.no_contact_30d} client${many(c.no_contact_30d) ? 's' : ''} not contacted in 30 days`, '#/clients?stale=1']);
  { const n = d.consents_expiring_clients ?? d.consents_expiring.length; if (n) alerts.push(['warn', `${n} client${many(n) ? 's have' : ' has'} a consent expiring soon`, '#/clients?consent_expiring=1']); }
  // Break-glass reads of clinical notes and re-admissions of a discharged client from outside a caseload.
  if (d.breakglass_pending) alerts.push(['danger', `${d.breakglass_pending} emergency access${d.breakglass_pending > 1 ? 'es' : ''} / re-admission${d.breakglass_pending > 1 ? 's' : ''} to review`, '#/supervision?tab=breakglass']);
  // Patient-rights requests run a 30-day clock: an overdue one is a compliance failure, not a to-do.
  const pr = d.patient_requests;
  if (pr && pr.n) alerts.push([pr.overdue ? 'danger' : 'warn', `${pr.n} open client rights request${many(pr.n) ? 's' : ''}${pr.overdue ? ` (${pr.overdue} overdue)` : ''}`, '#/clients?status=all&patient_requests=1']);
  // 42 CFR Part 2: active clients never given the §2.22 notice; the breach clock (60 days from discovery) on
  // open incidents; and complaints still open (docs/compliance/PART2.md).
  if (d.part2_notice_missing) alerts.push(['warn', `${d.part2_notice_missing} active client${many(d.part2_notice_missing) ? 's have' : ' has'} no Part 2 notice on record`, '#/compliance?tab=notices']);
  const inc = d.incidents;
  if (inc && (inc.overdue || inc.due_soon)) alerts.push(['danger', `${inc.overdue ? `${inc.overdue} privacy incident${inc.overdue > 1 ? 's' : ''} past the notification deadline` : `${inc.due_soon} privacy incident${inc.due_soon > 1 ? 's' : ''} due within 14 days`}`, '#/compliance?tab=incidents']);
  else if (inc && inc.attention) alerts.push(['warn', `${inc.attention} privacy incident${inc.attention > 1 ? 's' : ''} need a determination or notice`, '#/compliance?tab=incidents']);
  // An administrator switched the programme's Part 2 protections off: shown until it is switched back on.
  if (d.part2_program_off) alerts.push(['danger', `42 CFR Part 2 protections are switched off${d.part2_program_off.since ? ` (since ${fmt.date(d.part2_program_off.since)})` : ''}`, '#/compliance?tab=overview']);
  if (d.complaints_open) alerts.push(['warn', `${d.complaints_open} open privacy complaint${d.complaints_open > 1 ? 's' : ''}`, '#/compliance?tab=complaints']);
  // Referrals to the programme waiting for someone to try to reach the person (red when one is urgent), and the
  // open ones assigned to this person.
  {
    const inc = await early.incoming;
    if (inc && inc.new) alerts.push([inc.new_urgent ? 'danger' : 'warn', `${inc.new} new referral${inc.new > 1 ? 's' : ''}${inc.new_urgent ? ` (${inc.new_urgent} urgent)` : ''}`, '#/incoming?status=new']);
    if (inc && inc.mine) alerts.push(['info', `${inc.mine} incoming referral${inc.mine > 1 ? 's' : ''} assigned to you`, '#/incoming?assigned_to=me']);
  }
  // Account requests from the sign-in page's Sign up, waiting for an administrator (office server only).
  if (can('users:manage') && !state.local) {
    const reqs = await early.requests;
    const n = reqs ? reqs.requests.length : 0;
    if (n) alerts.push(['warn', `${n} access request${n > 1 ? 's' : ''} waiting`, '#/admin?tab=users']);
  }
  // Production configuration that leaves the county exposed — backups off, audit anchors on the database's
  // own disk (server/startup-checks.js). Only an administrator can fix these, so only they see them.
  // Each is a sentence saying what is wrong and who fixes it, with a link to what to do: a red pill reading
  // "Audit anchors are on the database disk" told a non-technical administrator nothing they could act on.
  // Amber for a finding, red when something has actually failed. Not dismissible: they are security findings.
  let securityNotes = null;
  if (can('settings:manage') && !state.local) {
    const sec = await early.security;
    const list = (sec && sec.alerts) || [];
    if (list.length) securityNotes = h('div', { class: 'mb', 'data-security-alerts': '1' }, list.map(a => h('div', { class: `banner ${a.severity === 'warn' ? 'warn' : 'danger'} small mb`, 'data-security-alert': a.key, 'data-severity': a.severity || 'danger' },
      h('b', {}, a.label, '. '), a.explain || a.detail, ' ', h('a', { href: a.link || '#/admin?tab=security' }, a.key === 'backups_off' ? 'Turn on backups' : 'See Security status'),
      // What to send IT, ready to paste into an email or a ticket (the audit anchors: a server setting nobody in
      // the programme can change from inside SUDS).
      a.it_request ? [' ', h('button', { type: 'button', class: 'btn sm', 'data-copy-it-request': a.key, onClick: async (e) => {
        const btn = e.currentTarget;
        try { await navigator.clipboard.writeText(a.it_request); toast('Copied. Paste it into an email or ticket to your IT support.', 'ok'); }
        catch { btn.replaceWith(h('span', { class: 'small', 'data-it-request-text': '1' }, h('b', {}, 'Send IT: '), a.it_request)); }
      } }, 'Copy the request for IT')] : null)));
  }
  // Clients still assigned to someone whose account was deactivated: nobody is working them until a
  // supervisor moves them (GET /api/users/caseloads, counts only).
  if (can('assignments:manage')) {
    const cl = await early.caseloads;
    if (cl && (cl.inactive_clients || cl.inactive_tasks)) {
      const gone = cl.users.filter(u => !u.is_active);
      const what = cl.inactive_clients ? `${cl.inactive_clients} client${cl.inactive_clients > 1 ? 's are' : ' is'}` : `${cl.inactive_tasks} open to-do${cl.inactive_tasks > 1 ? 's are' : ' is'}`;
      alerts.push(['warn', `${what} assigned to inactive staff`, gone.length === 1 ? `#/admin?tab=caseload&from=${gone[0].id}` : '#/admin?tab=caseload']);
    }
  }
  // A county file due or overdue and not yet made or sent: one pill each (three at most, then how many more), to the
  // reporting schedule on Settlement outcomes.
  const county = await early.county;
  if (county && county.reminders && county.reminders.length) {
    for (const x of county.reminders.slice(0, 3)) alerts.push([x.overdue ? 'danger' : 'warn', x.text, '#/settlement?card=schedule']);
    if (county.reminders.length > 3) alerts.push(['warn', `${county.reminders.length - 3} more county file${county.reminders.length - 3 === 1 ? '' : 's'} not yet made or sent`, '#/settlement?card=schedule']);
  }
  // Supplies expired or expiring, running low, or short on the books: for whoever runs the cupboard (views/supplies.js).
  const supplies = await early.supplies;
  if (supplies) alerts.push(...supplies.alerts);
  // The on-device app keeps its records nowhere else: a week without a backup is worth a word on Home.
  const backupReminder = await backupReminderCard();
  // A device whose administrator has no recovery code yet (set up before 1.15.1, or the code never confirmed saved).
  const recoveryPrompt = await recoveryPromptCard();
  // Empty program: offer sample data (office admins, or anyone on a phone-only copy)
  let sample = null;
  if (!c.active && !c.waitlist && !caseload.caseload.length && (state.local || can('settings:manage'))) {
    // A production office server does not put it on Home (home_offer false): it stays under Settings › Program.
    try { const st = await get(state.local ? '/api/local/demo' : '/api/admin/demo', { quiet: true }); if (st.home_offer !== false && (st.can_load ?? (!st.loaded && st.clients_total === 0))) {
      // Loaded right here, after a confirmation — the button used to send people to the Sync page (or
      // Settings) and leave them to find a second "Load sample data" at the bottom of it.
      const path = state.local ? '/api/local/demo' : '/api/admin/demo';
      const busy = h('span', { class: 'small muted', 'data-sample-busy': '1' }, 'It can be removed in one click.');
      const loadHere = async (e) => {
        const btn = e.currentTarget;
        if (!await confirmDialog('Load sample data', 'Add a set of fictional clients, visits, calls, notes, referrals, to-dos, resources and funding so you can try every screen? Nothing in it is real, and it can be removed in one click.', { okText: 'Load sample data' })) return;
        btn.disabled = true; busy.textContent = 'Adding sample data…';
        try { const r = await post(path, {}); toast(`Added ${r.counts.clients} sample clients with visits, calls, notes, referrals and to-dos`, 'ok'); state.funds = null; await loadRefData(); nav('dashboard?_=' + Date.now()); }
        catch (err) { btn.disabled = false; busy.textContent = ''; toast(err.message || 'Could not load sample data', 'error'); }
      };
      sample = h('div', { class: 'banner mb', 'data-sample-banner': '1' }, h('b', {}, 'New here? '), st.clients_total > 0 ? 'Load fictional sample clients beside yours to see how SUDS looks with a full caseload, visits, notes and reports. ' : 'Load fictional sample data to see how SUDS looks with clients, visits, notes and reports. ', h('button', { type: 'button', class: 'btn sm primary', 'data-load-sample': '1', style: { marginLeft: '.5rem' }, onClick: loadHere }, 'Load sample data'), ' ', busy);
    } } catch { /* no permission or offline */ }
  }
  // A brand-new program: the wizard only creates one account, so this is where the rest of setting up
  // actually happens. Each step is one click, and the card disappears as they are done.
  let setupCard = null;
  if (can('settings:manage') && !state.local) {
    try {
      const [forms, users, funds, resources, sys, settings, consentTemplate, supplies, hardening] = await early.setup;
      const steps = [];
      // Nothing about the deployment was ever going to point an administrator at these: backups off, two-step
      // verification not required or not set up by the privileged accounts, the idle sign-out nobody confirmed, and
      // the security switches that ship off (1.24.0: server/hardening.js). Each is computed from the configuration in
      // force, so it leaves this card the moment the setting is saved, and comes back if someone turns it off. The
      // audit-anchor finding is already a banner above in production, so it is not said twice.
      const shownAlerts = new Set((((await early.security) || {}).alerts || []).map(a => a.key));
      for (const it of ((hardening && hardening.items) || []).filter(x => x.recommended && !x.done && !(x.id === 'audit_anchor' && shownAlerts.has('audit_anchor_dir')))) {
        steps.push([it.title, it.why, it.action.label, () => nav(it.action.href.replace(/^#\//, '')), null, it.id]);
      }
      // Without the keys, every backup is unreadable — so this is the step that matters most, and it goes first.
      if (sys.key_source === 'file' && !sys.keys_backup_at) {
        steps.push(['Save a copy of your encryption keys', 'Backups of the database can only be opened with these keys. Download the file and put it somewhere separate from this computer, such as the county password manager.', 'Download key backup', async () => { (await import('./admin.js')).downloadKeyBackup(() => nav('dashboard?_=' + Date.now())); }]);
      }
      if ((users.users || []).filter(u => u.is_active !== 0).length < 2) {
        steps.push(['Add your staff', 'Everyone needs their own sign-in — shared accounts are not supported, and the audit trail depends on knowing who did what.', 'Add staff', () => nav('admin?tab=users')]);
      }
      if (forms && forms.starters.some(x => !x.installed)) {
        steps.push(['Put a consent form in the library', 'Including a 42 CFR Part 2 release, which you need before any record can be shared with another agency.', 'Add starter forms', async () => { (await import('./forms.js')).openStarters(() => nav('dashboard?_=' + Date.now())); }]);
      }
      if (!resources.total) {
        steps.push(['Fill the resource directory', 'Load a regional starter directory (shelters, syringe services, MAT and treatment programs), or enter your own referral partners.', 'Open the directory', () => nav('resources')]);
      }
      // A referral can rely on a consent only when it names the provider. The usual consent, naming the
      // program's regular referral partners, is what a worker fills a new consent in from in one step.
      if (consentTemplate && !consentTemplate.template) {
        steps.push(['Save a usual consent naming your referral partners', 'A referral can share a client\'s details only under a consent that names the provider. Name the partners you refer to most, and workers can record such a consent in one step.', 'Set up the usual consent',
          async () => { (await import('./part2.js')).openConsentTemplateForm({ onDone: () => nav('dashboard?_=' + Date.now()) }); }]);
      }
      // The supply cupboard: visits take naloxone kits and test strips off it only once it has those items, so
      // a new program's first distributions were counted nowhere. One click adds the two standard items.
      if (supplies && !(supplies.rows || []).length) {
        // The items a visit's counts draw from, by name; an empty cupboard has none yet (drawdown's names are
        // null until the items exist), so the standard names are what gets added.
        const STANDARD = { naloxone_kits: 'Naloxone kit', fentanyl_strips: 'Fentanyl test strips' };
        const standard = Object.entries({ ...STANDARD, ...(supplies.drawdown || {}) }).map(([k, name]) => name || STANDARD[k]);
        steps.push(['Add your supplies', `Naloxone kits and fentanyl test strips handed out on a visit are taken off the supply count only once the cupboard has them. Add them now, then record what is on the shelf under Supplies.`, 'Add naloxone kits and test strips',
          async (e) => {
            const btn = e.currentTarget; btn.disabled = true;
            try { for (const item of standard) await post('/api/supplies', { item, quantity: 0 }); toast(`Added ${standard.join(' and ')} to Supplies. Record what is on the shelf there.`, 'ok'); nav('supplies'); }
            catch (err) { btn.disabled = false; toast(err.message || 'The supplies could not be added.', 'error'); }
          }, h('a', { class: 'btn sm', href: '#/supplies', 'data-setup-supplies-link': '1' }, 'Open Supplies')]);
      }
      const activeFunds = (funds.funds || []).filter(f => f.is_active !== 0 && f.is_active !== false);
      if (!(funds.funds || []).length) {
        steps.push(['Add your funding sources', 'Grants and budgets, so services and staff time can be charged to the right one and reported per fund.', 'Add funding', () => nav('budget')]);
      } else {
        // Without a default, a visit nobody charged to a fund is reported under "No funding source".
        if (settings && !(settings.default_fund_id && activeFunds.some(f => f.id === settings.default_fund_id))) {
          steps.push(['Set a default fund', 'New visits are charged to it unless the worker chooses another, so the funder report does not count them under "No funding source".', 'Choose the default fund', () => nav('admin?tab=settings&section=reporting')]);
        }
        // A settlement fund with no allowable use is reported as "Uncategorised" in the settlement report.
        const uncategorised = activeFunds.filter(f => (f.source_type === 'opioid_settlement' || f.settlement_hiaa) && !f.settlement_use);
        if (uncategorised.length) {
          const names = uncategorised.map(x => x.name);
          steps.push([`Set the opioid-settlement category of ${names.length <= 3 ? names.join(names.length === 2 ? ' and ' : ', ') : `${names.length} settlement funds`}`, 'The opioid settlement report lists its spending as "Uncategorised" until the fund says which allowable use (Exhibit E) it pays for.', 'Edit funding', () => nav('budget')]);
        }
      }
      if (steps.length) {
        setupCard = h('section', { class: 'card mb' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Finish setting up'), badge(`${steps.length} left`, 'warn')),
          h('div', {}, steps.map(([title, why, label, action, more, key]) => h('div', { class: 'list-item row', 'data-setup-step': key || null, style: { justifyContent: 'space-between', alignItems: 'center', gap: '1rem' } },
            h('div', {}, h('b', {}, title), h('div', { class: 'small muted' }, why)),
            h('div', { class: 'row' }, typeof action === 'string'
              // A download, not a page: an anchor, so the browser saves the file. Re-render afterwards so the
              // step disappears once the server has recorded it.
              ? h('a', { class: 'btn sm primary', href: action, download: '', onClick: () => setTimeout(() => nav('dashboard?_=' + Date.now()), 1500) }, label)
              : h('button', { class: 'btn sm primary', onClick: action }, label), more || null)))));
      }
    } catch { /* a missing permission or an offline copy simply means no card */ }
  }

  // Whose visits the card counts (server/routes/reports.js visitScope): a caseload-scoped worker's own
  // caseload and outreach; everyone's for a supervisor or administrator; the program's for finance and
  // read-only, who log no visits (their Home was headed "What you have been doing").
  const activityHeading = can('clients:all') ? 'What the team has been doing (90 days)' : can('clients:list-deidentified') && !can('clients:read') ? 'The program\'s visits (90 days)' : 'What you have been doing (90 days)';
  // Someone who may look but not act (a read-only oversight account) — decided by permissions, deny-aware, not
  // the role name: they hold nothing but reading, reports and exports. Their Home leads with the reports they
  // came for, and has no to-do or "continue" card (they keep no to-dos and open no client records).
  const onlyReads = !(state.user.permissions || []).some(p => can(p) && !/:read$|:list-deidentified$|^reports:|^export:/.test(p));
  const showTodos = can('tasks:read');
  const showContinue = can('clients:read') || can('notes:admin:read') || can('notes:clinical:read');
  const reportsLead = onlyReads && can('reports:read') ? h('section', { class: 'card mb', 'data-home-reports': '1' },
    h('h2', {}, 'Your reports'),
    h('p', { class: 'small muted' }, 'The figures your account may see: counts of people and services, never who they are. The numbers below are the program\'s at a glance.'),
    h('ul', { class: 'download-list' },
      h('li', {}, h('a', { class: 'btn primary', href: '#/funder', 'data-home-funder': '1' }, 'Funder report'), h('span', { class: 'small' }, 'People served, admissions, discharges and demographics for a month, quarter or fiscal year that has ended.')),
      h('li', {}, h('a', { class: 'btn', href: '#/reports', 'data-home-reports-link': '1' }, 'Reports'), h('span', { class: 'small' }, 'Program summaries and monthly trends for any date range.')),
      can('resources:read') ? h('li', {}, h('a', { class: 'btn', href: '#/resources' }, 'Resource directory'), h('span', { class: 'small' }, 'The services and partners the program refers people to.')) : null)) : null;
  // The empty caseload's next step: add a client, where this person may.
  const newClientBtn = () => (can('clients:write') ? h('button', { class: 'btn primary', type: 'button', 'data-empty-action': 'new-client', onClick: async () => (await import('./clients.js')).openClientForm(null) }, '+ New client') : null);
  // Only the box completes a to-do (1.23.2): the title used to sit inside the box's label, so tapping it to see the to-do
  // marked it done. The title opens the to-do, or the call, visit or referral it came from (tasks.js openTodo), and
  // "Done" offers Undo, which reopens it.
  const refreshHome = () => nav('dashboard?_=' + Date.now());
  const done = async (t, box) => {
    if (box) box.disabled = true;
    try {
      const { doneToast, confirmReminderDone } = await import('./tasks.js');
      // A sign reminder with drafts still unsigned asks first; Cancel leaves it open (1.23.5).
      if (!(await confirmReminderDone(t))) { if (box) { box.checked = false; box.disabled = false; } return; }
      await put(`/api/tasks/${t.id}`, { status: 'done' });
      // Reopened as it was: an in-progress to-do stays in progress (review of 1.23.2); Undo after the worker has moved
      // on reopens it where they are, without taking them back to Home. "View in Done" (1.23.3) opens the To-dos list
      // showing Done; Home's to-dos are the person's own, so it is the "Assigned to me" one.
      doneToast(t, { mine: true, onUndone: refreshHome });
      refreshHome();
    } catch (err) { if (box) { box.checked = false; box.disabled = false; } toast(err.message || 'Could not mark that done. Check your connection and try again.', 'error'); }
  };
  const openTodo = async (t) => (await import('./tasks.js')).openTodo(t.id, refreshHome);
  // A phone's Home is triage (1.23.0): today's work first — to-dos due and overdue (follow-ups included), then the
  // things waiting on this person (unsigned notes, clients to call, as one compact row of links), then where they
  // left off — and the rest below: the welcome, the program-wide figures folded, the auto-refresh switch at the foot.
  // A first sign-in used to show the welcome card, the switch and the status links before "To-dos for today", which
  // sat below the first screen. A computer keeps its layout.
  const phone = typeof matchMedia === 'function' && matchMedia(PHONE_HOME).matches;
  // The program-wide cards fold away, each remembered for this person on every device (prefs home_folded: { key:
  // true } folded, false open). Not chosen yet: folded on a phone, open on a computer.
  const foldedNow = () => prefs.get('home_folded', null) || {};
  const isFolded = (key) => (key in foldedNow() ? !!foldedNow()[key] : phone);
  const fold = (key, attrs, summary, ...body) => {
    const d = h('details', { ...attrs, class: `${attrs.class || ''} home-fold`.trim(), 'data-home-fold': key, open: isFolded(key) ? null : true }, h('summary', {}, summary), ...body);
    // Only a change the person made is saved: creating the element open fires a toggle as well.
    d.addEventListener('toggle', () => { if (!d.open === isFolded(key)) return; prefs.set('home_folded', { ...foldedNow(), [key]: !d.open }); });
    return d;
  };
  const alertRow = alerts.length ? h('div', { class: `row mb${phone ? ' home-alerts' : ''}`, 'data-home-alerts': '1' }, alerts.map(([k, t, href]) => h(href && reachable(href) ? 'a' : 'span', { href: href && reachable(href) ? href : null, class: `badge ${k}`, 'data-home-alert': '', style: { fontSize: '.9rem', padding: '.4rem .8rem' } }, t))) : null;
  // At most five rows, overdue first, then "N more" to the to-do list (1.23.1): nine rows pushed "Continue where you
  // left off" off a phone's second screen. The server sends at most ten, so a full ten says "at least".
  const TODAY_MAX = 5;
  const dueSorted = [...cont.due_today].sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)));
  const todayRows = dueSorted.slice(0, TODAY_MAX); const todayMore = dueSorted.length - todayRows.length;
  const todayMoreLink = todayMore > 0 ? h('p', { class: 'small mt', 'data-today-more': String(todayMore) }, h('a', { href: '#/tasks' }, `${dueSorted.length >= 10 ? 'At least ' : ''}${todayMore} more due to-do${todayMore === 1 ? '' : 's'}`)) : null;
  const todosCard = !showTodos ? null : h('div', { class: phone ? 'card mb' : 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'To-dos for today'), can('tasks:read') ? h('a', { href: '#/tasks' }, 'All to-dos') : null),
    cont.due_today.length ? todayRows.map(t => h('div', { class: 'today-item', 'data-overdue': isOverdue(t) ? '1' : '0', 'data-today-task': t.id }, h('span', { class: 'today-main' }, h('label', { class: 'tap-target today-check' }, h('input', { type: 'checkbox', 'aria-label': `Mark done: ${t.title}`, onChange: (e) => done(t, e.target) })), h('span', {}, h('button', { type: 'button', class: 'today-open', 'data-today-open': t.id, onClick: () => openTodo(t) }, t.title), t.client_name ? h('span', { class: 'muted small' }, ` · ${t.client_name}`) : null)), h('span', { class: 'small today-due', style: isOverdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, isOverdue(t) ? [badge('Overdue', 'danger'), ' '] : null, h('span', { class: 'nowrap' }, fmt.dt(t.due_at))))).concat(todayMoreLink || []) : emptyState('Nothing due today', 'Reminders you set for today will appear here.', can('tasks:write') ? h('button', { class: 'btn sm', onClick: async () => (await import('./tasks.js')).openTaskForm(null, { onDone: () => nav('dashboard?_=' + Date.now()) }) }, '+ Add a reminder') : null));
  const continueCard = !showContinue ? null : h('div', { class: phone ? 'card mb' : 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Continue where you left off'), window.SUDS_STATIC_HOST ? null : h('span', { class: 'muted small' }, 'from any device')),
    cont.drafts.length ? h('div', { class: 'mb' }, h('h3', { class: 'eyebrow' }, 'Unfinished notes'), cont.drafts.slice(0, 4).map(n => h('div', { class: 'today-item' }, h('a', { href: '#', onClick: async (e) => { e.preventDefault(); (await import('./notes.js')).openNote(n.id, { onChange: () => nav('dashboard?_=' + Date.now()) }); } }, n.title || `${fmt.label(n.format, 'NOTE_FORMATS')} note`, h('span', { class: 'muted small' }, ` · ${n.client_name}`)), h('span', { class: 'muted small' }, fmt.ago(n.updated_at))))) : null,
    cont.recent.length ? h('div', {}, h('h3', { class: 'eyebrow' }, 'Recent clients'), h('div', { class: 'row' }, cont.recent.slice(0, 8).map(x => h('a', { class: 'chip', href: `#/client/${x.id}` }, x.display_name)))) : null,
    !cont.drafts.length && !cont.recent.length ? emptyState('You are all caught up', 'Clients and notes you open show here, ready to pick up on your phone or computer.', can('clients:read') ? h('a', { class: 'btn', 'data-empty-action': 'clients', href: '#/clients' }, 'Open the client list') : null) : null);
  const handoffCard = handoffs && handoffs.rows.length ? fold('handoffs', { class: 'card mb', 'data-handoffs': '1' }, [h('h2', {}, 'Hand-offs from the last 24h'), ' ', h('span', { class: 'muted small' }, 'for the whole team')],
    handoffs.rows.map(n => h('div', { class: 'hand-off' }, h('div', {}, h('a', { href: '#', onClick: async (e) => { e.preventDefault(); (await import('./notes.js')).openNote(n.id, { onChange: () => nav('dashboard?_=' + Date.now()) }); } }, h('b', {}, n.title || 'Hand-off')), ' ', h('span', { class: 'muted small' }, `· ${n.client_name || n.client_code} · ${n.author} · ${fmt.dt(n.occurred_at)}`)), h('div', { class: 'small excerpt' }, n.excerpt)))) : null;
  const otherDevice = cont.other_device && !state.local ? h('div', { class: 'muted small mb' }, `Also signed in on ${cont.other_device.mobile ? 'your phone' : 'another computer'} (${fmt.ago(cont.other_device.last_seen_at) === 'today' ? 'active today' : fmt.ago(cont.other_device.last_seen_at)}). Everything stays in sync.`) : null;
  const smallCells = d.small_cells ? h('p', { class: 'small muted mb', 'data-small-cells': '1' }, `Counts of people from 1 to ${d.small_cells.threshold - 1} are shown as "<${d.small_cells.threshold}" for your role, as they are in the funder report.`) : null;
  const rest = [
    // Whose figures these are: the program's for anyone who sees every client, otherwise their own caseload's.
    // "Open referrals 13 — needs attention" read as the worker's own 13 (hours and to-dos stay their own).
    // Someone's own hours are not the program's figure: they sat among the program's tiles (r7 L2).
    d.time && !can('time:all') ? [h('h2', { class: 'eyebrow', 'data-own-tiles': '1' }, 'Your own work'),
      h('div', { class: 'grid cols-4 mb', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 11.25rem), 1fr))' } }, stat('My hours logged (90 days)', (d.time.minutes / 60).toFixed(1), '', 'time'))] : null,
    fold('tiles', { class: 'mb' }, h('h2', { class: 'eyebrow', 'data-tiles-heading': '1' }, can('clients:all') ? 'The whole program at a glance' : can('clients:read') ? 'Your caseload at a glance' : 'The program at a glance'),
      h('div', { class: 'grid cols-4 mb' },
        stat('Active clients', fmt.num(c.active), '', 'clients?status=active', 'All active clients, any time — not limited to the last 90 days'), stat('High-risk clients', fmt.num(c.high_risk), c.high_risk ? 'danger' : '', 'clients?status=active&risk=high'), stat('Visits (90 days)', fmt.num(i.total), '', 'interventions', `${fmt.date(d.from)} – ${fmt.date(d.to)}; other numbers on this page are all-time`), stat('Naloxone kits given', fmt.num(i.naloxone_kits), '', `interventions?naloxone=1&from=${String(d.from).slice(0, 10)}&to=${String(d.to).slice(0, 10)}`, 'Kits handed out on any visit in the last 90 days, whatever the visit type'),
        stat('Calls', fmt.num(d.calls.total), '', 'calls'), stat('Open referrals', fmt.num(d.referrals.open), d.referrals.open ? 'warn' : '', 'referrals?status=open'),
        pr ? h('div', { 'data-patient-requests': '1', style: { display: 'contents' } }, stat('Open client rights requests', pr.overdue ? `${fmt.num(pr.n)} (${pr.overdue} overdue)` : fmt.num(pr.n), pr.overdue ? 'danger' : pr.n ? 'warn' : '', 'clients?status=all&patient_requests=1', 'Requests for access, amendment, restriction or an accounting of disclosures — each must be answered within 30 days')) : null, d.time && can('time:all') ? stat('Team hours logged', (d.time.minutes / 60).toFixed(1), '', 'time') : null, d.budget && can('budget:approve') ? stat('Spent of budget', h('span', {}, h('span', { class: 'money' }, fmt.money(d.budget.spent)), ' / ', h('span', { class: 'money' }, fmt.money(d.budget.total))), '', 'budget') : null, supplies ? supplies.tile : null)),
    h('div', { class: 'grid cols-2' },
      can('clients:read') ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Your clients who need a check-in'), h('a', { href: '#/clients' }, 'All clients')),
        caseload.caseload.length ? caseload.caseload.slice(0, 8).map(x => h('div', { class: 'today-item' }, h('div', {}, h('a', { href: `#/client/${x.id}` }, x.display_name), ' ', badge(x.risk_level ? fmt.label(x.risk_level) : 'Not assessed', statusKind(x.risk_level))), h('div', { class: 'small muted' }, 'last contact ', fmt.ago(x.last_contact), x.overdue_tasks ? [' ', badge(`${x.overdue_tasks} overdue`, 'danger')] : null)))
          : can('clients:all') ? emptyState('Nothing on your own caseload', c.active ? `You see every client already (${c.active} active). This list only shows people assigned to you directly.` : sample ? 'Add the first client, or load the sample data above to look around.' : 'Add the first client.', c.active ? h('a', { class: 'btn', 'data-empty-action': 'clients', href: '#/clients' }, 'Open the client list') : newClientBtn())
          : emptyState('No clients assigned to you yet', can('clients:write') ? 'Add your first client, or ask your supervisor to assign clients to you.' : 'Ask your supervisor to assign clients to you.', newClientBtn())) : null,
      fold('activity', { class: 'card' }, h('h2', { 'data-activity-heading': '1' }, activityHeading), bars(i.by_type.slice(0, 8), { list: 'INTERVENTION_TYPES', link: x => `interventions?type=${x.k}` }), h('div', { class: 'mt' }, sparkline(i.by_week.map(w => w.n), { label: 'Visits per week, last 90 days' }), h('div', { class: 'muted small' }, 'visits per week'))),
      state.user.role === 'admin' && !state.local ? h('div', { class: 'card' }, h('h2', {}, 'Use SUDS on phones and tablets'), h('p', { class: 'small muted' }, 'There is no app to install: staff open SUDS in the browser on the office Wi-Fi and add it to their home screen. Show them the QR code under Settings → Network & devices, or send them to ', h('a', { href: 'get-app.html' }, 'Use SUDS on your phone or tablet'), '.'), h('a', { class: 'btn sm', href: '#/admin?tab=network' }, 'Connect a device')) : null,
      d.consents_expiring.length ? fold('consents', { class: 'card' }, h('h2', {}, 'Consents expiring soon'), table([{ label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}` }, r.client_code) }, { label: 'Type', render: r => fmt.label(r.type) }, { label: 'Recipient', key: 'recipient' }, { label: 'Expires', render: r => fmt.date(r.expires_at) }], d.consents_expiring, { wrap: false })) : null),
  ];
  const welcome = welcomeCard({ force, experienced });
  if (phone) {
    return h('div', { 'data-home-layout': 'phone' },
      pageHead(`${greet}, ${who}`),
      // Help at the foot of the menu opens the welcome on purpose (?welcome=1): then it comes first.
      force ? welcome : null,
      securityNotes,
      reportsLead,
      todosCard,
      alertRow,
      continueCard,
      force ? null : welcome,
      recoveryPrompt, backupReminder, sample, setupCard, otherDevice, smallCells,
      handoffCard,
      ...rest,
      h('div', { class: 'home-foot', 'data-home-foot': '1' }, autoToggle));
  }
  return h('div', { 'data-home-layout': 'computer' },
    pageHead(`${greet}, ${who}`, autoToggle),
    welcome,
    recoveryPrompt,
    backupReminder,
    securityNotes,
    sample,
    setupCard,
    // A device copy keeps its own sign-ins, all on this device, and syncs with nothing on its own: "another
    // computer … stays in sync" was wrong there.
    otherDevice,
    smallCells,
    reportsLead,
    alertRow,
    showTodos || showContinue ? h('div', { class: 'grid cols-2 mb' }, todosCard, continueCard) : null,
    handoffCard,
    ...rest);
}
// "Your first day" is for a first day (r9 L6): someone who logged a visit or wrote a note before today, as every
// worker has after an upgrade, is not asked to "Log your first visit". Remembered once known (prefs first_day_skip).
// A "no" is remembered for the session too (per signed-in user): Home redraws every few minutes, and asking the
// office twice on each redraw, for as long as someone has logged nothing, is traffic the rate limit counts.
let priorWorkNo = null;
async function priorWork() {
  if (prefs.get('first_day_skip')) return true;
  const who = state.user && state.user.id;
  if (who && priorWorkNo === who) return false;
  const d = new Date(); d.setDate(d.getDate() - 1); const p = n => String(n).padStart(2, '0');
  const before = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const any = async (path) => { try { return ((await get(path, { quiet: true })).rows || []).length > 0; } catch { return false; } };
  const seen = (can('interventions:read') && await any(`/api/interventions?mine=1&to=${before}&limit=1`))
    || ((can('notes:admin:read') || can('notes:clinical:read')) && await any(`/api/notes?mine=1&to=${before}&limit=1`));
  if (seen) prefs.set('first_day_skip', true); else priorWorkNo = who;
  return seen;
}
// A render by the router supersedes any redraw still in flight, so a redraw started before it never swaps in after it
// (and takes the focus the router gave the heading with it; review of 1.23.3).
route('dashboard', (r) => { homeSeq++; return drawHome(r); });

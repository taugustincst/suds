import { backupReminderCard } from './local.js';
import { h, route, get, put, post, confirmDialog, loadRefData, state, stat, bars, fmt, badge, statusKind, table, can, nav, pageHead, sparkline, quickActions, emptyState, toast, greetingName } from '../app.js';

route('dashboard', async () => {
  const [d, cont, caseload, handoffs] = await Promise.all([get('/api/reports/dashboard'), get('/api/me/continue'), can('clients:read') ? get('/api/caseload') : { caseload: [] },
    can('notes:admin:read') ? get('/api/notes/handoffs?hours=24', { quiet: true }).catch(() => null) : null]);
  // "Today" is really "due by the end of today": anything from before today is overdue and goes first.
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));
  const isOverdue = (t) => fmt.isDateOnly(t.due_at) ? fmt.parse(t.due_at) < startOfToday : fmt.isPast(t.due_at);
  cont.due_today = [...cont.due_today].sort((a, b) => (isOverdue(b) - isOverdue(a)) || String(a.due_at).localeCompare(String(b.due_at)));
  const c = d.clients, i = d.interventions;
  // auto-refresh so changes made on another device appear without a manual reload
  const timer = setInterval(() => { if (location.hash.replace(/^#\/?/, '').split('?')[0] === 'dashboard' || location.hash === '' || location.hash === '#/') { if (!document.querySelector('.modal-bg')) nav('dashboard?_=' + Date.now()); } else clearInterval(timer); }, 90_000);
  const who = greetingName(state.user.display_name, state.user.username);
  const hour = new Date().getHours(); const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const alerts = [];
  if (d.tasks.overdue) alerts.push(['danger', `${d.tasks.overdue} overdue reminder${d.tasks.overdue > 1 ? 's' : ''}`, '#/tasks?overdue=1']);
  if (d.notes.unsigned) alerts.push([d.notes.unsigned_overdue ? 'danger' : 'warn', `${d.notes.unsigned} unsigned note${d.notes.unsigned > 1 ? 's' : ''}${d.notes.team ? ' across your team' : ''}`, d.notes.team ? '#/supervision' : '#/notes?status=draft&mine=1']);
  if (cont.staged_imports) alerts.push(['info', `${cont.staged_imports} imported note${cont.staged_imports > 1 ? 's' : ''} to review`, '#/imports']);
  if (c.no_contact_30d) alerts.push(['warn', `${c.no_contact_30d} client${c.no_contact_30d > 1 ? 's' : ''} not contacted in 30 days`, '#/clients?stale=1']);
  { const n = d.consents_expiring_clients ?? d.consents_expiring.length; if (n) alerts.push(['warn', `${n} client${n > 1 ? 's have' : ' has'} a consent expiring soon`, '#/clients?consent_expiring=1']); }
  // Break-glass reads of clinical notes and re-admissions of a discharged client from outside a caseload.
  if (d.breakglass_pending) alerts.push(['danger', `${d.breakglass_pending} emergency access${d.breakglass_pending > 1 ? 'es' : ''} / re-admission${d.breakglass_pending > 1 ? 's' : ''} to review`, '#/supervision?tab=breakglass']);
  // Patient-rights requests run a 30-day clock: an overdue one is a compliance failure, not a to-do.
  const pr = d.patient_requests;
  if (pr && pr.n) alerts.push([pr.overdue ? 'danger' : 'warn', `${pr.n} open patient request${pr.n > 1 ? 's' : ''}${pr.overdue ? ` (${pr.overdue} overdue)` : ''}`, '#/clients?status=all&patient_requests=1']);
  // 42 CFR Part 2: active clients never given the §2.22 notice; the breach clock (60 days from discovery) on
  // open incidents; and complaints still open (docs/compliance/PART2.md).
  if (d.part2_notice_missing) alerts.push(['warn', `${d.part2_notice_missing} active client${d.part2_notice_missing > 1 ? 's have' : ' has'} no Part 2 notice on record`, '#/compliance?tab=notices']);
  const inc = d.incidents;
  if (inc && (inc.overdue || inc.due_soon)) alerts.push(['danger', `${inc.overdue ? `${inc.overdue} privacy incident${inc.overdue > 1 ? 's' : ''} past the notification deadline` : `${inc.due_soon} privacy incident${inc.due_soon > 1 ? 's' : ''} due within 14 days`}`, '#/compliance?tab=incidents']);
  else if (inc && inc.attention) alerts.push(['warn', `${inc.attention} privacy incident${inc.attention > 1 ? 's' : ''} need a determination or notice`, '#/compliance?tab=incidents']);
  if (d.complaints_open) alerts.push(['warn', `${d.complaints_open} open privacy complaint${d.complaints_open > 1 ? 's' : ''}`, '#/compliance?tab=complaints']);
  // Account requests from the sign-in page's Sign up, waiting for an administrator (office server only).
  if (can('users:manage') && !state.local) {
    const reqs = await get('/api/users/access-requests', { quiet: true }).catch(() => null);
    const n = reqs ? reqs.requests.length : 0;
    if (n) alerts.push(['warn', `${n} access request${n > 1 ? 's' : ''} waiting`, '#/admin?tab=users']);
  }
  // Clients still assigned to someone whose account was deactivated: nobody is working them until a
  // supervisor moves them (GET /api/users/caseloads, counts only).
  if (can('assignments:manage')) {
    const cl = await get('/api/users/caseloads', { quiet: true }).catch(() => null);
    if (cl && (cl.inactive_clients || cl.inactive_tasks)) {
      const gone = cl.users.filter(u => !u.is_active);
      const what = cl.inactive_clients ? `${cl.inactive_clients} client${cl.inactive_clients > 1 ? 's are' : ' is'}` : `${cl.inactive_tasks} open to-do${cl.inactive_tasks > 1 ? 's are' : ' is'}`;
      alerts.push(['warn', `${what} assigned to inactive staff`, gone.length === 1 ? `#/admin?tab=caseload&from=${gone[0].id}` : '#/admin?tab=caseload']);
    }
  }
  // The on-device app keeps its records nowhere else: a week without a backup is worth a word on Home.
  const backupReminder = await backupReminderCard();
  // Empty program: offer sample data (office admins, or anyone on a phone-only copy)
  let sample = null;
  if (!c.active && !c.waitlist && !caseload.caseload.length && (state.local || can('settings:manage'))) {
    try { const st = await get(state.local ? '/api/local/demo' : '/api/admin/demo', { quiet: true }); if (st.can_load ?? (!st.loaded && st.clients_total === 0)) {
      // Loaded right here, after a confirmation — the button used to send people to the Sync page (or
      // Settings) and leave them to find a second "Load sample data" at the bottom of it.
      const path = state.local ? '/api/local/demo' : '/api/admin/demo';
      const busy = h('span', { class: 'small muted', 'data-sample-busy': '1' }, 'It can be removed in one click.');
      const loadHere = async (e) => {
        const btn = e.currentTarget;
        if (!await confirmDialog('Load sample data', 'Add a set of fictional clients, visits, calls, notes, referrals, reminders, resources and funding so you can try every screen? Nothing in it is real, and it can be removed in one click.', { okText: 'Load sample data' })) return;
        btn.disabled = true; busy.textContent = 'Adding sample data…';
        try { const r = await post(path, {}); toast(`Added ${r.counts.clients} sample clients with visits, calls, notes, referrals and reminders`, 'ok'); state.funds = null; await loadRefData(); nav('dashboard?_=' + Date.now()); }
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
      const [forms, users, funds, resources, sys, settings] = await Promise.all([
        get('/api/forms/starters', { quiet: true }).catch(() => null),
        get('/api/users', { quiet: true }).catch(() => ({ users: [] })),
        get('/api/budget/funds', { quiet: true }).catch(() => ({ funds: [] })),
        get('/api/resources?limit=1', { quiet: true }).catch(() => ({ total: 0 })),
        get('/api/admin/stats', { quiet: true }).catch(() => ({})),
        get('/api/admin/settings', { quiet: true }).catch(() => null),
      ]);
      const steps = [];
      // Nothing about the deployment was ever going to point an administrator at these. Backups off and no
      // MFA requirement are the defaults a fresh install runs with until someone finds the Settings tab.
      if (settings && !Number(settings.backup_schedule_hours || 0)) {
        steps.push(['Turn on scheduled backups', 'Right now nothing is backing up this database automatically. Set how often, and where a copy should go, under Settings.', 'Set up backups', () => nav('admin?tab=settings')]);
      }
      if (settings && settings.policy && !(settings.policy.mfaRequiredRoles || []).length) {
        steps.push(['Require two-step verification', 'No role has to use an authenticator app yet. Staff who can see client records should, and the county will expect it.', 'Choose roles', () => nav('admin?tab=settings')]);
      }
      // Without the keys, every backup is unreadable — so this is the step that matters most, and it goes first.
      if (sys.key_source === 'file' && !sys.keys_backup_at) {
        steps.push(['Save a copy of your encryption keys', 'Backups of the database can only be opened with these keys. Download the file and put it somewhere separate from this computer, such as the county password manager.', 'Download key backup', '/api/admin/keys-backup']);
      }
      if ((users.users || []).filter(u => u.is_active !== 0).length < 2) {
        steps.push(['Add your staff', 'Everyone needs their own sign-in — shared accounts are not supported, and the audit trail depends on knowing who did what.', 'Add staff', () => nav('admin?tab=users')]);
      }
      if (forms && forms.starters.some(x => !x.installed)) {
        steps.push(['Put a consent form in the library', 'Including a 42 CFR Part 2 release, which you need before any record can be shared with another agency.', 'Add starter forms', async () => { (await import('./forms.js')).openStarters(() => nav('dashboard?_=' + Date.now())); }]);
      }
      if (!resources.total) {
        steps.push(['Fill the resource directory', 'Load a regional starter directory of treatment programs, or enter your own referral partners.', 'Open the directory', () => nav('resources')]);
      }
      if (!(funds.funds || []).length) {
        steps.push(['Add your funding sources', 'Grants and budgets, so services and staff time can be charged to the right one and reported per fund.', 'Add funding', () => nav('budget')]);
      }
      if (steps.length) {
        setupCard = h('section', { class: 'card mb' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Finish setting up'), badge(`${steps.length} left`, 'warn')),
          h('div', {}, steps.map(([title, why, label, action]) => h('div', { class: 'list-item row', style: { justifyContent: 'space-between', alignItems: 'center', gap: '1rem' } },
            h('div', {}, h('b', {}, title), h('div', { class: 'small muted' }, why)),
            typeof action === 'string'
              // A download, not a page: an anchor, so the browser saves the file. Re-render afterwards so the
              // step disappears once the server has recorded it.
              ? h('a', { class: 'btn sm primary', href: action, download: '', onClick: () => setTimeout(() => nav('dashboard?_=' + Date.now()), 1500) }, label)
              : h('button', { class: 'btn sm primary', onClick: action }, label)))));
      }
    } catch { /* a missing permission or an offline copy simply means no card */ }
  }

  const done = async (t, box) => {
    if (box) box.disabled = true;
    try { await put(`/api/tasks/${t.id}`, { status: 'done' }); toast('Done ✓', 'ok'); nav('dashboard?_=' + Date.now()); }
    catch (err) { if (box) { box.checked = false; box.disabled = false; } toast(err.message || 'Could not mark that done. Check your connection and try again.', 'error'); }
  };
  return h('div', {},
    pageHead(`${greet}, ${who}`),
    backupReminder,
    sample,
    setupCard,
    cont.other_device ? h('div', { class: 'muted small mb' }, `Also signed in on ${cont.other_device.mobile ? 'your phone' : 'another computer'} (${fmt.ago(cont.other_device.last_seen_at) === 'today' ? 'active today' : fmt.ago(cont.other_device.last_seen_at)}). Everything stays in sync.`) : null,
    alerts.length ? h('div', { class: 'row mb' }, alerts.map(([k, t, href]) => h('a', { href, class: `badge ${k}`, style: { fontSize: '.9rem', padding: '.4rem .8rem' } }, t))) : null,
    h('div', { class: 'grid cols-2 mb' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Today'), can('tasks:read') ? h('a', { href: '#/tasks' }, 'All to-dos') : null),
        cont.due_today.length ? cont.due_today.map(t => h('div', { class: 'today-item', 'data-overdue': isOverdue(t) ? '1' : '0' }, h('label', { class: 'check', style: { marginTop: 0 } }, h('span', { class: 'tap-target' }, h('input', { type: 'checkbox', 'aria-label': `Mark "${t.title}" done`, onChange: (e) => done(t, e.target) })), h('span', {}, t.title, t.client_name ? h('span', { class: 'muted small' }, ` · ${t.client_name}`) : null)), h('span', { class: 'small today-due', style: isOverdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, isOverdue(t) ? [badge('Overdue', 'danger'), ' '] : null, h('span', { class: 'nowrap' }, fmt.dt(t.due_at))))) : emptyState('Nothing due today', 'Reminders you set for today will appear here.', can('tasks:write') ? h('button', { class: 'btn sm', onClick: async () => (await import('./tasks.js')).openTaskForm(null, { onDone: () => nav('dashboard?_=' + Date.now()) }) }, '+ Add a reminder') : null)),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Continue where you left off'), h('span', { class: 'muted small' }, 'from any device')),
        cont.drafts.length ? h('div', { class: 'mb' }, h('h4', {}, 'Unfinished notes'), cont.drafts.slice(0, 4).map(n => h('div', { class: 'today-item' }, h('a', { href: '#', onClick: async (e) => { e.preventDefault(); (await import('./notes.js')).openNote(n.id, { onChange: () => nav('dashboard?_=' + Date.now()) }); } }, n.title || `${fmt.label(n.format, 'NOTE_FORMATS')} note`, h('span', { class: 'muted small' }, ` · ${n.client_name}`)), h('span', { class: 'muted small' }, fmt.ago(n.updated_at))))) : null,
        cont.recent.length ? h('div', {}, h('h4', {}, 'Recent clients'), h('div', { class: 'row' }, cont.recent.slice(0, 8).map(x => h('a', { class: 'chip', href: `#/client/${x.id}` }, x.display_name)))) : null,
        !cont.drafts.length && !cont.recent.length ? emptyState('You are all caught up', 'Clients and notes you open show here, ready to pick up on your phone or computer.') : null)),
    handoffs && handoffs.rows.length ? h('div', { class: 'card mb', 'data-handoffs': '1' }, h('div', { class: 'card-head' }, h('h3', {}, 'Hand-offs from the last 24h'), h('span', { class: 'muted small' }, 'for the whole team')),
      handoffs.rows.map(n => h('div', { class: 'hand-off' }, h('div', {}, h('a', { href: '#', onClick: async (e) => { e.preventDefault(); (await import('./notes.js')).openNote(n.id, { onChange: () => nav('dashboard?_=' + Date.now()) }); } }, h('b', {}, n.title || 'Hand-off')), ' ', h('span', { class: 'muted small' }, `· ${n.client_name || n.client_code} · ${n.author} · ${fmt.dt(n.occurred_at)}`)), h('div', { class: 'small excerpt' }, n.excerpt)))) : null,
    h('div', { class: 'grid cols-4 mb' },
      stat('Active clients', fmt.num(c.active), '', 'clients?status=active', 'All active clients, any time — not limited to the last 90 days'), stat('High-risk clients', fmt.num(c.high_risk), c.high_risk ? 'danger' : '', 'clients?status=active&risk=high'), stat('Visits & services (90 days)', fmt.num(i.total), '', 'interventions', `${fmt.date(d.from)} – ${fmt.date(d.to)}; other numbers on this page are all-time`), stat('Naloxone kits given', fmt.num(i.naloxone_kits), '', 'interventions?type=naloxone_distribution'),
      stat('Calls', fmt.num(d.calls.total), '', 'calls'), stat('Open referrals', fmt.num(d.referrals.open), d.referrals.open ? 'warn' : '', 'referrals?status=open'),
      pr ? h('div', { 'data-patient-requests': '1', style: { display: 'contents' } }, stat('Open patient requests', pr.overdue ? `${fmt.num(pr.n)} (${pr.overdue} overdue)` : fmt.num(pr.n), pr.overdue ? 'danger' : pr.n ? 'warn' : '', 'clients?status=all&patient_requests=1', 'Requests for access, amendment, restriction or an accounting of disclosures — each must be answered within 30 days')) : null, d.time ? stat(can('time:all') ? 'Team hours logged' : 'My hours logged', (d.time.minutes / 60).toFixed(1), '', 'time') : null, d.budget ? stat('Spent of budget', h('span', {}, h('span', { class: 'money' }, fmt.money(d.budget.spent)), ' / ', h('span', { class: 'money' }, fmt.money(d.budget.total))), '', 'budget') : null),
    h('div', { class: 'grid cols-2' },
      can('clients:read') ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Clients who need a check-in'), h('a', { href: '#/clients' }, 'All clients')),
        caseload.caseload.length ? caseload.caseload.slice(0, 8).map(x => h('div', { class: 'today-item' }, h('div', {}, h('a', { href: `#/client/${x.id}` }, x.display_name), ' ', badge(fmt.label(x.risk_level), statusKind(x.risk_level))), h('div', { class: 'small muted' }, 'last contact ', fmt.ago(x.last_contact), x.overdue_tasks ? [' ', badge(`${x.overdue_tasks} overdue`, 'danger')] : null)))
          : can('clients:all') ? emptyState('Nothing on your own caseload', c.active ? `You see every client already (${c.active} active). This list only shows people assigned to you directly.` : 'Add the first client with the + Log button, or load sample data to look around.')
          : emptyState('No clients assigned to you yet', can('clients:write') ? 'Add your first client with the + Log button, or ask your supervisor to assign clients to you.' : 'Ask your supervisor to assign clients to you.')) : null,
      h('div', { class: 'card' }, h('h3', {}, 'What you have been doing (90 days)'), bars(i.by_type.slice(0, 8), { list: 'INTERVENTION_TYPES', link: x => `interventions?type=${x.k}` }), h('div', { class: 'mt' }, sparkline(i.by_week.map(w => w.n)), h('div', { class: 'muted small' }, 'visits per week'))),
      state.user.role === 'admin' && !state.local ? h('div', { class: 'card' }, h('h3', {}, 'Use SUDS on phones and tablets'), h('p', { class: 'small muted' }, 'There is no app to install: staff open SUDS in the browser on the office Wi-Fi and add it to their home screen. Show them the QR code under Settings → Network & devices, or send them to ', h('a', { href: 'get-app.html' }, 'Use SUDS on your phone or tablet'), '.'), h('a', { class: 'btn sm', href: '#/admin?tab=network' }, 'Connect a device')) : null,
      d.consents_expiring.length ? h('div', { class: 'card' }, h('h3', {}, 'Consents expiring soon'), table([{ label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}` }, r.client_code) }, { label: 'Type', render: r => fmt.label(r.type) }, { label: 'Recipient', key: 'recipient' }, { label: 'Expires', render: r => fmt.date(r.expires_at) }], d.consents_expiring, { wrap: false })) : null));
});

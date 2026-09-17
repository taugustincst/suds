import { h, route, get, put, state, stat, bars, fmt, badge, statusKind, table, can, nav, pageHead, sparkline, quickActions, emptyState, toast } from '../app.js';

route('dashboard', async () => {
  const [d, cont, caseload] = await Promise.all([get('/api/reports/dashboard'), get('/api/me/continue'), can('clients:read') ? get('/api/caseload') : { caseload: [] }]);
  const c = d.clients, i = d.interventions;
  // auto-refresh so changes made on another device appear without a manual reload
  const timer = setInterval(() => { if (location.hash.replace(/^#\/?/, '').split('?')[0] === 'dashboard' || location.hash === '' || location.hash === '#/') { if (!document.querySelector('.modal-bg')) nav('dashboard?_=' + Date.now()); } else clearInterval(timer); }, 90_000);
  const first = state.user.display_name.split(' ')[0];
  const hour = new Date().getHours(); const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const alerts = [];
  if (d.tasks.overdue) alerts.push(['danger', `${d.tasks.overdue} overdue reminder${d.tasks.overdue > 1 ? 's' : ''}`, '#/tasks?overdue=1']);
  if (d.notes.unsigned) alerts.push([d.notes.unsigned_overdue ? 'danger' : 'warn', `${d.notes.unsigned} unsigned note${d.notes.unsigned > 1 ? 's' : ''}`, '#/notes?status=draft&mine=1']);
  if (cont.staged_imports) alerts.push(['info', `${cont.staged_imports} imported note${cont.staged_imports > 1 ? 's' : ''} to review`, '#/imports']);
  if (c.no_contact_30d) alerts.push(['warn', `${c.no_contact_30d} client${c.no_contact_30d > 1 ? 's' : ''} not contacted in 30 days`, '#/clients?stale=1']);
  if (d.consents_expiring.length) alerts.push(['warn', `${d.consents_expiring.length} consent${d.consents_expiring.length > 1 ? 's' : ''} expiring soon`, '#/clients']);
  // Empty program: offer sample data (office admins, or anyone on a phone-only copy)
  let sample = null;
  if (!c.active && !c.waitlist && !caseload.caseload.length && (state.local || can('settings:manage'))) {
    try { const st = await get(state.local ? '/api/local/demo' : '/api/admin/demo', { quiet: true }); if (!st.loaded && st.clients_total === 0) sample = h('div', { class: 'banner mb', 'data-sample-banner': '1' }, h('b', {}, 'New here? '), 'Load fictional sample data to see how SUDS looks with clients, visits, notes and reports. ', h('a', { href: state.local ? '#/sync' : '#/admin?tab=settings', class: 'btn sm primary', style: { marginLeft: '.5rem' } }, 'Load sample data'), ' ', h('span', { class: 'small muted' }, 'It can be removed in one click.')); } catch { /* no permission or offline */ }
  }
  const done = async (t) => { await put(`/api/tasks/${t.id}`, { status: 'done' }); toast('Done ✓', 'ok'); nav('dashboard?_=' + Date.now()); };
  return h('div', {},
    pageHead(`${greet}, ${first}`),
    sample,
    cont.other_device ? h('div', { class: 'muted small mb' }, `Also signed in on ${cont.other_device.mobile ? 'your phone' : 'another computer'} (${fmt.ago(cont.other_device.last_seen_at) === 'today' ? 'active today' : fmt.ago(cont.other_device.last_seen_at)}). Everything stays in sync.`) : null,
    alerts.length ? h('div', { class: 'row mb' }, alerts.map(([k, t, href]) => h('a', { href, class: `badge ${k}`, style: { fontSize: '.9rem', padding: '.4rem .8rem' } }, t))) : null,
    h('div', { class: 'grid cols-2 mb' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Today'), h('a', { href: '#/tasks' }, 'All to-dos')),
        cont.due_today.length ? cont.due_today.map(t => h('div', { class: 'today-item' }, h('label', { class: 'check', style: { marginTop: 0 } }, h('input', { type: 'checkbox', onChange: () => done(t) }), h('span', {}, t.title, t.client_name ? h('span', { class: 'muted small' }, ` · ${t.client_name}`) : null)), h('span', { class: 'small', style: Date.parse(t.due_at) < Date.now() - 86400000 ? { color: 'var(--danger)' } : {} }, fmt.date(t.due_at)))) : emptyState('Nothing due today', 'Reminders you set for today will appear here.', can('tasks:write') ? h('button', { class: 'btn sm', onClick: async () => (await import('./tasks.js')).openTaskForm(null, { onDone: () => nav('dashboard?_=' + Date.now()) }) }, '+ Add a reminder') : null)),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Continue where you left off'), h('span', { class: 'muted small' }, 'from any device')),
        cont.drafts.length ? h('div', { class: 'mb' }, h('h4', {}, 'Unfinished notes'), cont.drafts.slice(0, 4).map(n => h('div', { class: 'today-item' }, h('a', { href: '#', onClick: async (e) => { e.preventDefault(); (await import('./notes.js')).openNote(n.id, { onChange: () => nav('dashboard?_=' + Date.now()) }); } }, n.title || `${n.format} note`, h('span', { class: 'muted small' }, ` · ${n.client_name}`)), h('span', { class: 'muted small' }, fmt.ago(n.updated_at))))) : null,
        cont.recent.length ? h('div', {}, h('h4', {}, 'Recent clients'), h('div', { class: 'row' }, cont.recent.slice(0, 8).map(x => h('a', { class: 'chip', href: `#/client/${x.id}` }, x.display_name)))) : null,
        !cont.drafts.length && !cont.recent.length ? emptyState('You are all caught up', 'Clients you open and notes you start will show here so you can pick them up on your phone or computer.') : null)),
    h('div', { class: 'grid cols-4 mb' },
      stat('Active clients', fmt.num(c.active), '', 'clients?status=active'), stat('High-risk clients', fmt.num(c.high_risk), c.high_risk ? 'danger' : '', 'clients?status=active&risk=high'), stat('Visits & services (90 days)', fmt.num(i.total), '', 'interventions'), stat('Naloxone kits given', fmt.num(i.naloxone_kits), '', 'interventions?type=naloxone_distribution'),
      stat('Calls', fmt.num(d.calls.total), '', 'calls'), stat('Open referrals', fmt.num(d.referrals.open), d.referrals.open ? 'warn' : '', 'referrals?status=open'), d.time ? stat('My hours logged', (d.time.minutes / 60).toFixed(1), '', 'time') : null, d.budget ? stat('Spent of budget', `${fmt.money(d.budget.spent)} / ${fmt.money(d.budget.total)}`, '', 'budget') : null),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Clients who need a check-in'), h('a', { href: '#/clients' }, 'All clients')),
        caseload.caseload.length ? caseload.caseload.slice(0, 8).map(x => h('div', { class: 'today-item' }, h('div', {}, h('a', { href: `#/client/${x.id}` }, x.display_name), ' ', badge(fmt.label(x.risk_level), statusKind(x.risk_level))), h('div', { class: 'small muted' }, 'last contact ', fmt.ago(x.last_contact), x.overdue_tasks ? [' ', badge(`${x.overdue_tasks} overdue`, 'danger')] : null))) : emptyState('No clients assigned to you yet', can('clients:write') ? 'Add your first client with the + Log button, or ask your supervisor to assign clients to you.' : 'Ask your supervisor to assign clients to you.')),
      h('div', { class: 'card' }, h('h3', {}, 'What you have been doing (90 days)'), bars(i.by_type.slice(0, 8), { link: x => `interventions?type=${x.k}` }), h('div', { class: 'mt' }, sparkline(i.by_week.map(w => w.n)), h('div', { class: 'muted small' }, 'visits per week'))),
      state.user.role === 'admin' && !state.local ? h('div', { class: 'card' }, h('h3', {}, 'Use SUDS on phones'), h('p', { class: 'small muted' }, 'Staff can open SUDS on a phone or tablet on the office Wi-Fi and add it to their home screen. Show them the QR code under Settings → Network & devices.'), h('a', { class: 'btn sm', href: '#/admin?tab=network' }, 'Connect a phone')) : null,
      d.consents_expiring.length ? h('div', { class: 'card' }, h('h3', {}, 'Consents expiring soon'), table([{ label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}` }, r.client_code) }, { label: 'Type', render: r => fmt.label(r.type) }, { label: 'Recipient', key: 'recipient' }, { label: 'Expires', render: r => fmt.date(r.expires_at) }], d.consents_expiring, { wrap: false })) : null));
});

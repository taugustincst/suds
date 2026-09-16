import { h, route, get, state, stat, bars, fmt, badge, statusKind, table, can, nav, pageHead, sparkline } from '../app.js';

route('dashboard', async () => {
  const [d, tasks, caseload] = await Promise.all([get('/api/reports/dashboard'), can('tasks:read') ? get('/api/tasks?status=open&mine=1&limit=8') : { rows: [] }, can('clients:read') ? get('/api/caseload') : { caseload: [] }]);
  const c = d.clients, i = d.interventions;
  const alerts = [];
  if (d.tasks.overdue) alerts.push(['danger', `${d.tasks.overdue} overdue task${d.tasks.overdue > 1 ? 's' : ''}`, '#/tasks?overdue=1']);
  if (d.notes.unsigned) alerts.push([d.notes.unsigned_overdue ? 'danger' : 'warn', `${d.notes.unsigned} unsigned draft note${d.notes.unsigned > 1 ? 's' : ''}${d.notes.unsigned_overdue ? ` (${d.notes.unsigned_overdue} overdue)` : ''}`, '#/notes?status=draft&mine=1']);
  if (d.notes.staged_imports) alerts.push(['info', `${d.notes.staged_imports} imported note${d.notes.staged_imports > 1 ? 's' : ''} awaiting review`, '#/imports']);
  if (c.no_contact_30d) alerts.push(['warn', `${c.no_contact_30d} active client${c.no_contact_30d > 1 ? 's' : ''} with no intervention in 30 days`, '#/clients?stale=1']);
  if (d.consents_expiring.length) alerts.push(['warn', `${d.consents_expiring.length} consent${d.consents_expiring.length > 1 ? 's' : ''} expiring within 30 days`, '#/clients']);
  return h('div', {},
    pageHead(`Welcome, ${state.user.display_name.split(' ')[0]}`, h('span', { class: 'muted small' }, `Last 90 days · ${fmt.date(d.from)} – ${fmt.date(d.to)}`)),
    alerts.length ? h('div', { class: 'row mb' }, alerts.map(([k, t, href]) => h('a', { href, class: `badge ${k}`, style: { fontSize: '.85rem', padding: '.35rem .7rem' } }, t))) : null,
    h('div', { class: 'grid cols-4 mb' },
      stat('Active clients', fmt.num(c.active)), stat('High / critical risk', fmt.num(c.high_risk), c.high_risk ? 'danger' : ''), stat('New intakes', fmt.num(c.new_in_range)), stat('Waitlist', fmt.num(c.waitlist), c.waitlist ? 'warn' : ''),
      stat('Interventions', fmt.num(i.total)), stat('Service time', fmt.mins(i.minutes)), stat('Naloxone kits', fmt.num(i.naloxone_kits)), stat('Calls', `${fmt.num(d.calls.total)} · ${fmt.mins(d.calls.minutes)}`),
      stat('Referrals', fmt.num(d.referrals.total)), stat('Open referrals', fmt.num(d.referrals.open), d.referrals.open ? 'warn' : ''), stat('Tasks due today', fmt.num(d.tasks.due_today), d.tasks.due_today ? 'warn' : ''), stat('Overdue tasks', fmt.num(d.tasks.overdue), d.tasks.overdue ? 'danger' : ''),
      d.budget ? stat('Budget spent', `${fmt.money(d.budget.spent)} / ${fmt.money(d.budget.total)}`, d.budget.total && d.budget.spent / d.budget.total > .9 ? 'danger' : '') : null,
      d.time ? stat('My logged time', fmt.mins(d.time.minutes)) : null),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'My open tasks'), h('a', { href: '#/tasks' }, 'All tasks')),
        tasks.rows.length ? tasks.rows.map(t => h('div', { class: 'list-item row between' }, h('div', {}, h('a', { href: `#/tasks?id=${t.id}` }, t.title), ' ', t.client_code ? h('span', { class: 'muted small' }, t.client_code) : null), h('div', {}, badge(t.priority, statusKind(t.priority)), ' ', h('span', { class: `small ${t.due_at && Date.parse(t.due_at) < Date.now() ? 'muted' : 'muted'}`, style: t.due_at && Date.parse(t.due_at) < Date.now() ? { color: 'var(--danger)' } : {} }, t.due_at ? fmt.date(t.due_at) : 'no due date')))) : h('div', { class: 'empty' }, 'Nothing due. Nice.')),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'My caseload — needs attention'), h('a', { href: '#/clients' }, 'All clients')),
        caseload.caseload.length ? caseload.caseload.slice(0, 8).map(x => h('div', { class: 'list-item row between' }, h('div', {}, h('a', { href: `#/client/${x.id}` }, x.display_name), ' ', h('span', { class: 'muted small' }, x.client_code)), h('div', {}, badge(x.risk_level, statusKind(x.risk_level)), ' ', h('span', { class: 'muted small' }, 'last contact ', fmt.ago(x.last_contact)), x.overdue_tasks ? [' ', badge(`${x.overdue_tasks} overdue`, 'danger')] : null))) : h('div', { class: 'empty' }, 'No clients assigned to you.')),
      h('div', { class: 'card' }, h('h3', {}, 'Interventions by type'), bars(i.by_type.slice(0, 10))),
      h('div', { class: 'card' }, h('h3', {}, 'Interventions per week'), sparkline(i.by_week.map(w => w.n)), h('div', { class: 'muted small mt' }, `${i.by_week.length} weeks shown`),
        h('h3', { class: 'mt' }, 'Referrals by status'), bars(d.referrals.by_status)),
      h('div', { class: 'card' }, h('h3', {}, 'Active clients by primary substance'), bars(c.by_substance)),
      h('div', { class: 'card' }, h('h3', {}, 'MAT status (active clients)'), bars(c.mat), h('h3', { class: 'mt' }, 'Call outcomes'), bars(d.calls.by_outcome)),
      d.consents_expiring.length ? h('div', { class: 'card' }, h('h3', {}, 'Consents expiring soon'), table([{ label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}` }, r.client_code) }, { label: 'Type', render: r => fmt.label(r.type) }, { label: 'Recipient', key: 'recipient' }, { label: 'Expires', render: r => fmt.date(r.expires_at) }], d.consents_expiring, { wrap: false })) : null,
    ));
});

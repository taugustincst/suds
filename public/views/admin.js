import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, stat, kv, loadRefData } from '../app.js';

function openUserForm(values, onDone) {
  const isNew = !values;
  const f = form([
    { name: 'username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@-]+' }, { name: 'display_name', label: 'Display name', required: true }, { name: 'email', label: 'Email' }, { name: 'title', label: 'Job title' },
    { name: 'role', label: 'Role', type: 'select', required: true, options: [['navigator', 'Navigator — own caseload, admin notes, referrals, budget entry'], ['clinician', 'Clinician — clinical notes, own caseload'], ['supervisor', 'Supervisor — all clients, all notes, approvals, audit'], ['finance', 'Finance — budget & de-identified data only'], ['readonly', 'Read-only — reports and client summaries'], ['admin', 'Administrator — users, settings, audit (no clinical notes)']].map(([v, l]) => ({ value: v, label: l })) },
    { name: 'hourly_cost', label: 'Loaded hourly cost ($, for budget)', type: 'number', min: 0, step: 0.01 }, { name: 'is_active', label: 'Active', type: 'checkbox', value: values ? values.is_active : true },
    { name: 'password', label: isNew ? 'Temporary password (blank = generate)' : 'Reset password (blank = keep)', type: 'password', autocomplete: 'new-password', help: '12+ chars with upper, lower, number, symbol. User must change at next login.' },
    !isNew ? { name: 'unlock', label: 'Unlock account', type: 'checkbox' } : null, !isNew && values.mfa_enabled ? { name: 'reset_mfa', label: 'Reset MFA (user re-enrolls)', type: 'checkbox' } : null,
  ].filter(Boolean), { values: values || {}, submitText: isNew ? 'Create user' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) { const r = await post('/api/users', d); m.close(); if (r.temporary_password) modal('User created', h('div', {}, h('p', {}, 'Share this temporary password securely (not by email). The user must change it at first login.'), h('div', { class: 'qr' }, r.temporary_password))); }
    else { await put(`/api/users/${values.id}`, d); m.close(); toast('User updated', 'ok'); }
    await loadRefData(); onDone();
  } });
  const m = modal(isNew ? 'New user' : `Edit ${values.display_name}`, f, { wide: true });
}

route('admin', async (r) => {
  const tab = r.query.get('tab') || 'users';
  const refresh = () => nav(`admin?tab=${tab}&_=${Date.now()}`);
  const body = h('div', {});
  const T = {
    async users() {
      const { users } = await get('/api/users');
      return h('div', {}, h('div', { class: 'row mb' }, h('button', { class: 'btn primary', onClick: () => openUserForm(null, refresh) }, '+ New user')),
        table([{ label: 'Name', render: u => h('div', {}, h('b', {}, u.display_name), h('div', { class: 'small muted' }, u.username, u.title ? ` · ${u.title}` : '')) }, { label: 'Role', render: u => badge(fmt.label(u.role), u.role === 'admin' ? 'purple' : 'info') }, { label: 'Email', key: 'email' }, { label: 'MFA', render: u => u.mfa_enabled ? badge('On', 'ok') : badge('Off', 'warn') }, { label: 'Status', render: u => [u.is_active ? badge('Active', 'ok') : badge('Inactive'), u.locked_until && Date.parse(u.locked_until) > Date.now() ? [' ', badge('Locked', 'danger')] : null] }, { label: 'Last login', render: u => u.last_login_at ? fmt.dt(u.last_login_at) : 'never' }, { label: '', render: u => h('button', { class: 'btn sm', onClick: () => openUserForm(u, refresh) }, 'Edit') }], users));
    },
    async settings() {
      const s = await get('/api/admin/settings');
      const f = form([{ name: 'org_name', label: 'Organization / program name', required: true }, { name: 'county_name', label: 'County' }, { name: 'program_contact', label: 'Privacy officer / program contact' },
        { name: 'caseload_restriction', label: 'Caseload restriction', type: 'select', options: [{ value: '1', label: 'On — navigators & clinicians see assigned clients only (recommended)' }, { value: '0', label: 'Off — all staff see all clients' }], noBlank: true },
        { name: 'note_lock_days', label: 'Days before unsigned drafts are flagged', type: 'number', min: 0, step: 1 }], { values: s, submitText: 'Save settings', onSubmit: async (d) => { await put('/api/admin/settings', d); toast('Settings saved', 'ok'); } });
      return h('div', { class: 'grid cols-2' }, h('div', { class: 'card' }, h('h3', {}, 'Program settings'), f),
        h('div', { class: 'card' }, h('h3', {}, 'Server security configuration'), h('p', { class: 'small muted' }, 'Set via environment variables (see .env.example and docs/DEPLOYMENT.md).'),
          kv([['Environment', s.env.env], ['TLS', s.env.tls ? badge('Enabled', 'ok') : badge('Not configured — use a TLS proxy', 'danger')], ['Idle timeout', `${s.env.idle_minutes} min`], ['Session max', `${s.env.absolute_hours} h`], ['MFA required for', s.env.mfa_required_roles.join(', ') || 'none'], ['OneNote (Graph) sync', s.env.ms_graph_configured ? badge('Configured', 'ok') : badge('Not configured', 'warn')]])));
    },
    async audit() {
      const q = new URLSearchParams(); for (const k of ['action', 'user_id', 'client_id', 'from', 'to', 'failures']) if (r.query.get(k)) q.set(k, r.query.get(k)); q.set('limit', '200');
      const [a, v] = await Promise.all([get(`/api/admin/audit?${q}`), get('/api/admin/audit/verify')]);
      const actionI = h('input', { value: r.query.get('action') || '', placeholder: 'e.g. note.view, auth., client.' }), fromI = h('input', { type: 'date', value: r.query.get('from') || '' }), toI = h('input', { type: 'date', value: r.query.get('to') || '' }), userSel = h('select', {}, h('option', { value: '' }, 'Any user'), state.users.map(u => h('option', { value: u.id, selected: u.id === r.query.get('user_id') }, u.display_name))), failI = h('input', { type: 'checkbox', checked: r.query.get('failures') === '1' });
      const apply = () => nav(`admin?tab=audit&action=${encodeURIComponent(actionI.value)}&user_id=${userSel.value}&from=${fromI.value}&to=${toI.value}${failI.checked ? '&failures=1' : ''}`);
      return h('div', {},
        h('div', { class: 'row mb' }, v.ok ? badge(`Audit chain intact (${v.checked} entries verified)`, 'ok') : badge(`AUDIT CHAIN BROKEN at entry #${v.firstBadId} — investigate immediately`, 'danger')),
        h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Action prefix'), actionI), h('div', { class: 'field' }, h('label', {}, 'User'), userSel), h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('label', { class: 'check', style: { marginTop: 0 } }, failI, 'Failures only'), h('button', { class: 'btn', onClick: apply }, 'Filter'),
          h('button', { class: 'btn sm', onClick: () => nav('admin?tab=audit&action=note.view.breakglass') }, 'Break-glass events'), h('button', { class: 'btn sm', onClick: () => nav('admin?tab=audit&action=authz.denied') }, 'Access denials'), h('button', { class: 'btn sm', onClick: () => nav('admin?tab=audit&action=report.export') }, 'Exports')),
        h('div', { class: 'muted small mb' }, `${a.total} entries`),
        table([{ label: 'Time', render: x => h('span', { class: 'nowrap small' }, fmt.dt(x.at)) }, { label: 'User', key: 'username' }, { label: 'Action', render: x => h('code', {}, x.action) }, { label: 'Entity', render: x => x.entity ? h('span', { class: 'small' }, x.entity, ' ', h('code', {}, (x.entity_id || '').slice(0, 8))) : '' }, { label: 'Client', render: x => x.client_id ? h('a', { href: `#/client/${x.client_id}`, class: 'small' }, x.client_id.slice(0, 8)) : '' }, { label: 'IP', render: x => h('span', { class: 'small mono' }, x.ip) }, { label: 'OK', render: x => x.success ? '' : badge('FAIL', 'danger') }, { label: 'Details', render: x => x.details ? h('span', { class: 'small mono' }, JSON.stringify(x.details).slice(0, 160)) : '' }], a.rows));
    },
    async apikeys() {
      const { keys } = await get('/api/admin/api-keys');
      const create = () => { const f = form([{ name: 'name', label: 'Key name (e.g. "Navigator phone – Pocket AI")', required: true, span: true }], { submitText: 'Generate key', onCancel: () => m.close(), onSubmit: async (d) => { const rr = await post('/api/admin/api-keys', d); m.close(); modal('API key created', h('div', {}, h('p', {}, 'Copy this key now — it will not be shown again.'), h('div', { class: 'qr' }, rr.key), h('p', { class: 'small muted mt' }, `Intake URL: ${location.origin}/api/intake/notes — POST JSON with header Authorization: Bearer <key>. See docs/IMPORTS.md for Pocket AI setup.`))); refresh(); } }); const m = modal('New intake API key', f); };
      return h('div', {}, h('div', { class: 'banner small' }, 'API keys let external apps (e.g. Pocket AI via a share shortcut or webhook) push notes into the import staging area. Keys cannot read data. Notes still require staff review before becoming part of the record.'),
        h('div', { class: 'row mb' }, h('button', { class: 'btn primary', onClick: create }, '+ New API key')),
        table([{ label: 'Name', key: 'name' }, { label: 'Prefix', render: k => h('code', {}, k.prefix + '…') }, { label: 'Created', render: k => `${fmt.dt(k.created_at)} by ${k.created_by_name || ''}` }, { label: 'Last used', render: k => k.last_used_at ? fmt.dt(k.last_used_at) : 'never' }, { label: 'Status', render: k => k.revoked_at ? badge('Revoked', 'danger') : badge('Active', 'ok') }, { label: '', render: k => !k.revoked_at ? h('button', { class: 'btn sm danger', onClick: async () => { if (await confirmDialog('Revoke key', `Revoke "${k.name}"? Apps using it will stop working.`, { danger: true, okText: 'Revoke' })) { await del(`/api/admin/api-keys/${k.id}`); refresh(); } } }, 'Revoke') : null }], keys, { empty: 'No API keys.' }));
    },
    async system() {
      const s = await get('/api/admin/stats');
      return h('div', { class: 'grid cols-2' }, h('div', { class: 'grid cols-2' }, stat('Active users', s.users), stat('Clients', s.clients), stat('Notes', s.notes), stat('Audit entries', s.audit_rows), stat('Active sessions', s.active_sessions)),
        h('div', { class: 'card' }, h('h3', {}, 'Operations'), kv([['Database', h('code', {}, s.db_path)], ['Backups', 'Run npm run backup (encrypted copy) on a schedule; store off-host. See docs/DEPLOYMENT.md.'], ['Keys', 'SUDS_ENCRYPTION_KEY and SUDS_INDEX_KEY must be backed up separately from the database — without them PHI is unrecoverable.'], ['Retention', 'Audit logs are kept per AUDIT_RETENTION_DAYS (default 7 years). Client records are soft-deleted only.']])));
    },
  };
  body.append(await (T[tab] || T.users)());
  return h('div', {}, pageHead('Administration'), h('div', { class: 'tabs' }, [['users', 'Users & roles'], ['settings', 'Settings'], ['audit', 'Audit log'], ['apikeys', 'API keys (intake)'], ['system', 'System']].map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onClick: () => nav(`admin?tab=${k}`) }, l))), body);
});

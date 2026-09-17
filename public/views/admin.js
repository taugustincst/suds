import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, stat, kv, loadRefData, downloadCsv } from '../app.js';
import { qrSvg } from '../qr.js';

function openUserForm(values, onDone) {
  const isNew = !values;
  const f = form([
    { name: 'username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\-]+' }, { name: 'display_name', label: 'Display name', required: true }, { name: 'email', label: 'Email' }, { name: 'title', label: 'Job title' },
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

async function nativeAppsCard(primary) {
  const info = await get('/api/app/info', { quiet: true }).catch(() => null);
  const appUrl = primary.replace(/\/$/, '') + '/app';
  const fileIn = h('input', { type: 'file', accept: '.apk', class: 'hidden' });
  const status = h('div', { class: 'small muted' });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; if (!f) return; status.textContent = `Uploading ${f.name}…`;
    try { const r = await fetch('/api/admin/app/android?version=' + encodeURIComponent(prompt('App version (as shown to staff):', state.constants ? '1.0.0' : '1.0.0') || ''), { method: 'POST', headers: { 'X-Requested-With': 'suds', 'Content-Type': 'application/octet-stream' }, body: f, credentials: 'same-origin' }); const j = await r.json(); if (!r.ok) throw new Error(j.error); toast('Android app published', 'ok'); nav('admin?tab=network&_=' + Date.now()); }
    catch (e) { status.textContent = e.message; }
  });
  const a = info?.android;
  return h('div', { class: 'card' }, h('h3', {}, 'Native apps'),
    h('p', { class: 'small' }, 'Staff get the phone app from your own server — no app store. Send them to ', h('b', {}, appUrl), ' or let them scan this code:'),
    h('div', { class: 'center mb' }, qrSvg(appUrl, { size: 140 })),
    h('h4', {}, 'Android'),
    a?.available ? h('div', {}, h('div', { class: 'row' }, badge(`Published · version ${a.version} · ${(a.size / 1048576).toFixed(1)} MB`, 'ok'), h('span', { class: 'small muted' }, `uploaded ${fmt.dt(a.uploaded_at)}`)), h('div', { class: 'small mono muted' }, `SHA-256 ${a.sha256.slice(0, 32)}…`))
      : h('p', { class: 'small muted' }, 'Not published yet. Build the APK (GitHub Actions "Android app" workflow, or Android Studio → Build APK) and upload it here. See docs/MOBILE_APPS.md.'),
    h('div', { class: 'row mt' }, h('button', { class: 'btn primary sm', onClick: () => fileIn.click() }, a?.available ? 'Upload new version' : 'Upload APK'), a?.available ? h('button', { class: 'btn sm', onClick: async () => { if (await confirmDialog('Remove app', 'Remove the Android app download from this server?', { danger: true, okText: 'Remove' })) { await del('/api/admin/app/android'); nav('admin?tab=network&_=' + Date.now()); } } }, 'Remove') : null, fileIn), status,
    h('h4', { class: 'mt' }, 'iPhone / iPad'), h('p', { class: 'small muted' }, 'Apple only allows installs through TestFlight or the App Store. The Xcode project is in mobile/ios; until it is published, iPhone users open ', h('b', {}, primary), ' in Safari → Share → Add to Home Screen.'));
}

// Fictional sample data: lets a new program (or a phone with nothing on it yet) explore every screen, then remove it in one click.
export async function sampleDataCard(onChange) {
  const path = state.local ? '/api/local/demo' : '/api/admin/demo';
  let st; try { st = await get(path, { quiet: true }); } catch { return null; }
  const busy = h('span', { class: 'small muted' });
  const load = async () => {
    busy.textContent = 'Adding sample data…';
    try { const r = await post(path, {}); toast(`Added ${r.counts.clients} sample clients with visits, calls, notes, referrals, reminders and funding`, 'ok'); state.funds = null; await loadRefData(); onChange && onChange(); }
    catch (e) { busy.textContent = ''; throw e; }
  };
  const remove = async () => {
    if (!await confirmDialog('Remove sample data', 'This deletes every fictional sample record (clients, visits, notes, funding and resources added by "Load sample data"). Records you created yourself are kept.', { danger: true, okText: 'Remove sample data' })) return;
    busy.textContent = 'Removing…';
    const r = await del(path); toast(`Removed ${r.removed} sample records`, 'ok'); state.funds = null; await loadRefData(); onChange && onChange();
  };
  return h('div', { class: 'card', 'data-sample': st.loaded ? 'loaded' : 'empty' }, h('h3', {}, 'Sample data'),
    st.loaded ? [h('p', { class: 'small' }, badge('Sample data loaded', 'info'), ' ', `${st.counts.clients} fictional clients and ${st.total} records added ${fmt.dt(st.loaded_at)}. Client codes start with DEMO-.`),
      h('p', { class: 'small muted' }, state.local ? 'Sample data is removed automatically before this phone syncs with the office, so it never mixes with real records.' : 'Remove it before entering real clients.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onClick: remove }, 'Remove sample data'), busy)]
    : st.clients_total > 0 ? h('p', { class: 'small muted' }, 'Sample data can only be added while there are no clients yet, so it never mixes with real records.')
    : [h('p', { class: 'small muted' }, 'Add a set of fictional clients, visits, calls, notes, referrals, reminders, resources and funding so you can try every screen. Nothing here is real, and it can be removed in one click.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: load }, 'Load sample data'), busy)]);
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
        { name: 'note_lock_days', label: 'Days before unsigned drafts are flagged', type: 'number', min: 0, step: 1 },
        { type: 'section', label: 'Security policy' },
        { name: 'session_idle_minutes', label: 'Auto sign-out after inactivity (minutes, max 60)', type: 'number', min: 1, max: 60, step: 1, value: s.policy.idleMinutes }, { name: 'session_absolute_hours', label: 'Maximum session length (hours)', type: 'number', min: 1, max: 24, step: 1, value: s.policy.absoluteHours },
        { name: 'password_max_age_days', label: 'Password expires after (days)', type: 'number', min: 1, step: 1, value: s.policy.passwordMaxAgeDays },
        { name: 'mfa_required_roles', label: 'Roles that must use MFA (comma separated)', value: s.policy.mfaRequiredRoles.join(','), help: 'admin, supervisor, clinician, navigator, finance, readonly — recommended: all', span: true }], { values: s, submitText: 'Save settings', onSubmit: async (d) => { await put('/api/admin/settings', d); toast('Settings saved', 'ok'); } });
      return h('div', { class: 'grid cols-2' }, h('div', { class: 'card' }, h('h3', {}, 'Program settings'), f), await sampleDataCard(refresh),
        h('div', { class: 'card' }, h('h3', {}, 'Server security configuration'), h('p', { class: 'small muted' }, 'Set via environment variables (see .env.example and docs/DEPLOYMENT.md).'),
          kv([['Environment', s.env.env], ['HTTPS', s.env.tls ? badge(s.env.tls_mode === 'selfsigned' ? 'Self-signed certificate' : 'Enabled', 'ok') : badge('Off — enable under Network', 'danger')], ['Encryption keys', s.env.key_source === 'file' ? 'data/keys.json (back it up under System)' : s.env.key_source === 'devfile' ? 'Development key files in data/' : 'Environment variables'], ['Addresses', (s.env.listener?.urls || []).join(', ')], ['OneNote (Graph) sync', s.env.ms_graph_configured ? badge('Configured', 'ok') : badge('Not configured', 'warn')]])));
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
    async network() {
      const n = await get('/api/admin/network');
      const L = n.listener; const primary = L.friendly || L.urls.find(u => !/localhost/.test(u)) || L.urls[0];
      const locked = n.env_overrides.host || n.env_overrides.port || n.env_overrides.tls;
      const f = form([
        { name: 'network', label: 'Who can reach SUDS', type: 'select', noBlank: true, required: true, value: L.host === '0.0.0.0' ? 'lan' : 'local', options: [{ value: 'lan', label: 'Phones, tablets and other computers on the office network' }, { value: 'local', label: 'Only this computer' }], span: true },
        { name: 'https', label: 'Encrypt connections with HTTPS (self-signed certificate)', type: 'checkbox', value: L.tls }, { name: 'port', label: 'Port (blank = standard port, no number in the address)', type: 'number', value: [443, 80].includes(L.port) ? '' : L.port, min: 1, max: 65535, step: 1 },
        { name: 'regenerate_cert', label: 'Create a new certificate (after the address changed)', type: 'checkbox' }, { name: 'extra_hosts', label: 'Extra names for the certificate', placeholder: 'suds.county.local' },
        { name: 'trust_proxy', label: 'Behind a reverse proxy (trust X-Forwarded-For)', type: 'checkbox', value: !!n.file.trustProxy },
      ], { submitText: 'Apply network settings', onSubmit: async (d) => { if (d.network === 'lan' && !d.https) throw new Error('HTTPS is required when other devices can connect'); const r = await put('/api/admin/network', d); toast('Applied. If the address changed, open the new address now.', 'ok'); const u = r.listener.urls.find(x => !/localhost/.test(x)) || r.listener.urls[0]; if (!location.href.startsWith(u.split('//')[0]) || Number(location.port || (location.protocol === 'https:' ? 443 : 80)) !== r.listener.port) setTimeout(() => { location.href = u + '#/admin?tab=network'; }, 1500); else refresh(); } });
      f.querySelectorAll('.form-grid').forEach(g => g.style.gridTemplateColumns = '1fr');
      return h('div', { class: 'grid cols-2' },
        h('div', { class: 'card' }, h('h3', {}, 'Connect a phone, tablet or another computer'), h('p', {}, 'On the office Wi-Fi, open ', h('b', {}, primary), L.mdns ? ' — no setup needed on the device.' : '.', ' Or scan this code. Then add it to the home screen: ', h('b', {}, 'iPhone'), ' Share → Add to Home Screen; ', h('b', {}, 'Android'), ' ⋮ → Install app. Everything staff do on the phone is instantly on the computer and vice versa.'),
          h('div', { class: 'center' }, qrSvg(primary, { size: 200 }), h('div', { class: 'mono' }, primary)),
          h('ul', { class: 'small mt' }, L.urls.map(u => h('li', {}, u))),
          L.tls ? h('div', { class: 'mt small' }, h('p', {}, `The certificate is self-signed${n.cert_expires ? ` (valid until ${fmt.date(n.cert_expires)})` : ''}. Browsers show a one-time warning; choose Advanced → Proceed, or install the certificate on the device to remove the warning.`), h('a', { class: 'btn sm', href: '/api/admin/certificate', download: '' }, 'Download certificate')) : h('div', { class: 'banner danger mt' }, 'HTTPS is off. Enable it before allowing other devices to connect.')),
        h('div', { class: 'card' }, h('h3', {}, 'Network settings'), locked ? h('div', { class: 'banner' }, 'Network settings are controlled by environment variables on this server (see docs/DEPLOYMENT.md).') : f),
        await nativeAppsCard(primary));
    },
    async system() {
      const s = await get('/api/admin/stats');
      return h('div', { class: 'grid cols-2' }, h('div', { class: 'grid cols-2' }, stat('Active users', s.users, '', 'admin?tab=users'), stat('Clients', s.clients, '', 'clients?status=all'), stat('Notes', s.notes, '', 'notes'), stat('Audit entries', s.audit_rows, '', 'admin?tab=audit'), stat('Active sessions', s.active_sessions)),
        h('div', { class: 'card' }, h('h3', {}, 'Backups'), h('p', { class: 'small muted' }, 'Download an encrypted copy of the database at least weekly and store it off this computer. Backups can only be opened with the encryption keys, so keep the key backup somewhere separate (e.g. the county password manager).'),
          h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '/api/admin/backup', download: '' }, 'Download encrypted backup'), s.key_source === 'file' ? h('a', { class: 'btn danger', href: '/api/admin/keys-backup', download: '' }, 'Download key backup (keep secret)') : null),
          h('h3', { class: 'mt' }, 'About this server'), kv([['SUDS version', s.version], ['Database', h('code', {}, s.db_path)], ['Keys', s.key_source === 'file' ? 'data/keys.json (generated by setup)' : 'Environment variables'], ['Addresses', (s.listener?.urls || []).join(', ')], ['Restore', 'Ask IT: node scripts/backup.js --restore <file> (docs/DEPLOYMENT.md).'], ['Retention', 'Audit logs are kept 7 years by default. Client records are soft-deleted only.']])));
    },
  };
  body.append(await (T[state.local && !['users', 'settings', 'audit'].includes(tab) ? 'users' : tab] || T.users)());
  const tabs = state.local ? [['users', 'Users & roles'], ['settings', 'Settings'], ['audit', 'Audit log']] : [['users', 'Users & roles'], ['settings', 'Settings'], ['network', 'Network & devices'], ['audit', 'Audit log'], ['apikeys', 'API keys (intake)'], ['system', 'System & backups']];
  return h('div', {}, pageHead('Settings'), state.local ? h('div', { class: 'banner small' }, 'This is the copy of SUDS on this device. Network, API keys and backups are managed on the office SUDS; use Sync to exchange data.') : null, h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onClick: () => nav(`admin?tab=${k}`) }, l))), body);
});

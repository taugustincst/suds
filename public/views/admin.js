import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, stat, kv, loadRefData, downloadCsv, clear } from '../app.js';
import { qrSvg } from '../qr.js';

let oidcStatusPromise;
function oidcStatusCached() {
  if (!oidcStatusPromise) oidcStatusPromise = get('/api/auth/oidc/status', { quiet: true }).catch(() => ({ enabled: false }));
  return oidcStatusPromise;
}

async function openUserForm(values, onDone) {
  const isNew = !values;
  const oidcStatus = !isNew && !state.local ? await oidcStatusCached() : { enabled: false };
  // How many devices this person syncs from, so the "also wipe" choice below is made with the number in view.
  let deviceCount = 0;
  if (!isNew && !state.local) deviceCount = await get('/api/admin/devices', { quiet: true }).then(r => r.devices.filter(d => d.user_id === values.id && !d.revoked_at).length).catch(() => 0);
  const f = form([
    { name: 'username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\\-]+' }, { name: 'display_name', label: 'Display name', required: true }, { name: 'email', label: 'Email' }, { name: 'title', label: 'Job title' },
    { name: 'role', label: 'Role', type: 'select', required: true, options: [['navigator', 'Navigator — own caseload, admin notes, referrals, budget entry'], ['clinician', 'Clinician — clinical notes, own caseload'], ['supervisor', 'Supervisor — all clients, all notes, approvals, audit'], ['finance', 'Finance — budget & de-identified data only'], ['readonly', 'Read-only — reports and client summaries'], ['admin', 'Administrator — users, settings, audit (no clinical notes)']].map(([v, l]) => ({ value: v, label: l })) },
    { name: 'hourly_cost', label: 'Loaded hourly cost ($, for budget)', type: 'number', min: 0, step: 0.01 }, { name: 'is_active', label: 'Active', type: 'checkbox', value: values ? values.is_active : true },
    { name: 'supervisor_id', label: 'Supervisor', type: 'select', placeholder: '— none —', options: state.users.filter(u => u.is_active !== 0 && ['supervisor', 'admin'].includes(u.role) && u.id !== values?.id).map(u => ({ value: u.id, label: u.display_name })), help: 'Whose Supervision page their unfinished work shows on.' },
    { name: 'requires_cosign', label: 'Notes need a supervisor\'s countersignature (trainee or unlicensed staff)', type: 'checkbox', span: true },
    { name: 'password', label: isNew ? 'Temporary password (blank = generate)' : 'Reset password (blank = keep)', type: 'password', autocomplete: 'new-password', help: '12+ chars with upper, lower, number, symbol. User must change at next login.' },
    !isNew ? { name: 'wipe_devices', label: `Also wipe this person's synced devices when deactivating or resetting the password (${deviceCount} device${deviceCount === 1 ? '' : 's'})`, type: 'checkbox', value: true, span: true, help: 'Each device they sync from in local mode is told to erase its local copy of client records the next time it connects.' } : null,
    !isNew ? { name: 'unlock', label: 'Unlock account', type: 'checkbox' } : null, !isNew && values.mfa_enabled ? { name: 'reset_mfa', label: 'Reset MFA (user re-enrolls)', type: 'checkbox' } : null,
    oidcStatus.enabled ? { name: 'oidc_subject', label: `Single sign-on identity (${oidcStatus.label})`, span: true, help: values && values.oidc_subject ? 'Linked. Clear this field to unlink — the user can still sign in with their SUDS password.' : 'Paste the "sub" claim from the identity provider to let this user sign in with SSO instead of a SUDS password. Leave blank if they should only use their SUDS password.' } : null,
  ].filter(Boolean), { values: values || {}, submitText: isNew ? 'Create user' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) {
      const r = await post('/api/users', d); m.close(); await loadRefData();
      // The list refresh below re-renders the page, and render() clears every open modal with it -- so the
      // one-time password used to flash up and vanish before anyone could read it. It now stays until
      // the administrator dismisses it, and only then does the page move on.
      if (r.temporary_password) {
        const pw = modal('User created', h('div', {},
          h('p', {}, 'Share this temporary password securely (not by email). The user must change it at first login.'),
          h('div', { class: 'qr', 'data-temp-password': '1' }, r.temporary_password),
          h('p', { class: 'small muted' }, 'It is not stored and cannot be shown again. If it is lost, edit the user and set a new one.'),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: () => pw.close() }, 'I have shared it'))), { onClose: onDone });
        return;
      }
      toast('User created', 'ok');
    }
    else {
      // Turning an account off is confirmed: it ends every session and, with the box above ticked, tells
      // each of their synced devices to erase its local copy. Neither is a thing to do by mis-click.
      if (values.is_active && !d.is_active) {
        const wipe = d.wipe_devices && deviceCount ? ` ${deviceCount} synced device${deviceCount === 1 ? '' : 's'} will be told to erase ${deviceCount === 1 ? 'its' : 'their'} local copy of client records the next time ${deviceCount === 1 ? 'it' : 'they'} connect.` : '';
        if (!await confirmDialog('Deactivate this account', `${values.display_name} will be signed out everywhere and can no longer sign in.${wipe} Continue?`, { danger: true, okText: 'Deactivate' })) return;
      }
      await put(`/api/users/${values.id}`, d); m.close(); toast('User updated', 'ok'); await loadRefData();
    }
    onDone();
  } });
  const m = modal(isNew ? 'New user' : `Edit ${values.display_name}`, f, { wide: true });
}

// The native apps are deprecated (docs/PLATFORM.md); staff use the web app in a browser. /app is the
// step-by-step page for adding it to a home screen.
function useOnDevicesCard(primary) {
  const appUrl = primary.replace(/\/$/, '') + '/app';
  return h('div', { class: 'card' }, h('h3', {}, 'Use SUDS on phones and tablets'),
    h('p', { class: 'small' }, 'There is no separate app to install: staff open SUDS in the browser at the address on the left and add it to their home screen. The step-by-step page for that is ', h('a', { href: appUrl, target: '_blank', rel: 'noopener' }, appUrl), '.'),
    h('p', { class: 'small muted' }, 'The web application on this server is the system of record. The former Android and iOS apps and the desktop launchers are deprecated and will be removed; existing installs should sync one last time and be uninstalled — see docs/PLATFORM.md.'));
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
      h('p', { class: 'small muted' }, state.local ? 'Sample data is removed automatically before this device syncs with the office, so it never mixes with real records.' : 'Remove it before entering real clients.'),
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
        { name: 'mfa_required_roles', label: 'Roles that must use MFA (comma separated)', value: s.policy.mfaRequiredRoles.join(','), help: 'admin, supervisor, clinician, navigator, finance, readonly — recommended: all', span: true },
        { type: 'section', label: 'Record retention' },
        { name: 'client_retention_years', label: 'Keep discharged client records for (years, minimum 6)', type: 'number', min: 6, step: 1, value: s.client_retention_years || '7', help: 'Once every episode is closed and this many years have passed since discharge, the record is permanently deleted from every table — unless an administrator has placed it on legal hold from the client\'s Care team tab.' },
        { type: 'section', label: 'Scheduled backups' },
        { name: 'backup_schedule_hours', label: 'Back up automatically every (hours, 0 = off)', type: 'number', min: 0, step: 1, value: s.backup_schedule_hours || '0' },
        { name: 'backup_retain_count', label: 'Keep this many recent backups on disk', type: 'number', min: 1, step: 1, value: s.backup_retain_count || '14' },
        { name: 'backup_offsite_dir', label: 'Also copy each backup to (a mounted network share or drive path; blank = local only)', span: true, value: s.backup_offsite_dir || '' },
      ], { values: s, submitText: 'Save settings', onSubmit: async (d) => { await put('/api/admin/settings', d); toast('Settings saved', 'ok'); } });
      return h('div', { class: 'grid cols-2' }, h('div', { class: 'card' }, h('h3', {}, 'Program settings'), f), await sampleDataCard(refresh),
        h('div', { class: 'card' }, h('h3', {}, 'Server security configuration'), h('p', { class: 'small muted' }, 'Set via environment variables (see .env.example and docs/DEPLOYMENT.md).'),
          kv([['Environment', s.env.env], ['HTTPS', s.env.tls ? badge(s.env.tls_mode === 'selfsigned' ? 'Self-signed certificate' : 'Enabled', 'ok') : badge('Off — enable under Network', 'danger')], ['Encryption keys', s.env.key_source === 'file' ? 'data/keys.json (back it up under System)' : s.env.key_source === 'devfile' ? 'Development key files in data/' : 'Environment variables'], ['Addresses', (s.env.listener?.urls || []).join(', ')], ['OneNote (Graph) sync', s.env.ms_graph_configured ? badge('Configured', 'ok') : badge('Not configured', 'warn')],
            ['Single sign-on (OIDC)', s.env.oidc_configured ? badge(`Configured — "${s.env.oidc_label}"`, 'ok') : badge('Not configured — set OIDC_ISSUER etc. (see docs/DEPLOYMENT.md)', 'warn')]])));
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
          L.tls ? h('div', { class: 'mt small' }, h('p', {}, `SUDS made its own certificate${n.cert_expires ? ` (valid until ${fmt.date(n.cert_expires)})` : ''}. Browsers show a one-time warning; choose Advanced → Proceed, or install SUDS's certificate authority on the device to remove it for good (Android: Settings → Security → Install a certificate → CA certificate; iPhone: install, then Settings → General → About → Certificate Trust Settings). Android browsers cannot use the suds.local name — give them the numeric address below, or the QR code.`), h('a', { class: 'btn sm', href: '/api/admin/certificate', download: '' }, 'Download certificate (CA)')) : h('div', { class: 'banner danger mt' }, 'HTTPS is off. Enable it before allowing other devices to connect.')),
        h('div', { class: 'card' }, h('h3', {}, 'Network settings'), locked ? h('div', { class: 'banner' }, 'Network settings are controlled by environment variables on this server (see docs/DEPLOYMENT.md).') : f),
        useOnDevicesCard(primary));
    },
    async system() {
      const s = await get('/api/admin/stats');
      const runNow = h('span', { class: 'small muted' });
      const runBackupNow = async () => {
        runNow.textContent = 'Running…';
        try { const r = await post('/api/admin/backup/run-now', {}); runNow.textContent = r.offsite_ok === false ? `Backup saved, but the offsite copy failed${r.offsite_error ? `: ${r.offsite_error}` : ''} — check the path and try again.` : 'Backup saved.'; }
        catch (e) { runNow.textContent = e.message; }
      };
      const updateStatus = h('span', { class: 'small muted' });
      const checkForUpdate = async () => {
        updateStatus.textContent = 'Checking…';
        try {
          const r = await get('/api/admin/update/check');
          if (!r.configured) { updateStatus.textContent = 'Not configured — set UPDATE_FEED_URL to enable (see docs/DEPLOYMENT.md).'; return; }
          updateStatus.replaceChildren(r.available
            ? h('span', {}, badge(`Update available: ${r.latest}`, 'info'), ' ', h('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'View release'), ' — run ', h('code', {}, 'node scripts/update.js --apply'), ' to install it.')
            : badge(`Up to date (${r.current})`, 'ok'));
        } catch (e) { updateStatus.textContent = e.message; }
      };
      return h('div', { class: 'grid cols-2' }, h('div', { class: 'grid cols-2' }, stat('Active users', s.users, '', 'admin?tab=users'), stat('Clients', s.clients, '', 'clients?status=all'), stat('Notes', s.notes, '', 'notes'), stat('Audit entries', s.audit_rows, '', 'admin?tab=audit'), stat('Active sessions', s.active_sessions)),
        h('div', { class: 'card' }, h('h3', {}, 'Backups'), h('p', { class: 'small muted' }, 'Download an encrypted copy of the database at least weekly and store it off this computer. Backups can only be opened with the encryption keys, so keep the key backup somewhere separate (e.g. the county password manager).'),
          h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '/api/admin/backup', download: '' }, 'Download encrypted backup'), s.key_source === 'file' ? h('a', { class: 'btn danger', href: '/api/admin/keys-backup', download: '' }, 'Download key backup (keep secret)') : null),
          h('p', { class: 'small mt' }, 'Scheduled backups: ', s.last_scheduled_backup_at ? [badge(/^ok/.test(s.last_scheduled_backup_status || '') ? 'Configured' : 'Attention needed', /^ok/.test(s.last_scheduled_backup_status || '') ? 'ok' : 'danger'), ` last ran ${fmt.dt(s.last_scheduled_backup_at)}${s.last_scheduled_backup_status ? ` — ${s.last_scheduled_backup_status}` : ''}`] : badge('Off — turn on under Settings → Program settings'), ' ', h('button', { class: 'btn sm', onClick: runBackupNow }, 'Run a backup now'), ' ', runNow),
          restoreCard(),
          h('h3', { class: 'mt' }, 'About this server'), kv([['SUDS version', s.version], ['Database', h('code', {}, s.db_path)], ['Keys', s.key_source === 'file' ? 'data/keys.json (generated by setup)' : 'Environment variables'], ['Key backup last downloaded', s.key_source !== 'file' ? 'Not applicable — keys come from the environment' : s.keys_backup_at ? fmt.dt(s.keys_backup_at) : badge('Never — download it below', 'danger')], ['Addresses', (s.listener?.urls || []).join(', ')], ['Retention', 'Audit logs are kept 7 years by default. Client records are soft-deleted only.']]),
          h('div', { class: 'row mt' }, h('button', { class: 'btn sm', onClick: checkForUpdate }, 'Check for updates'), updateStatus)));
    },
    async caseload() { return transferCard(); },
    async devices() {
      const { devices } = await get('/api/admin/devices');
      const act = async (id, action) => { await post(`/api/admin/devices/${id}/${action}`, {}); refresh(); };
      return h('div', {},
        h('div', { class: 'banner small mb' }, 'One row per device (a browser running the offline copy, local mode) that has synced with this server. "Revoke" blocks it from syncing again until cleared. "Wipe" additionally erases its local database, the next time it tries to sync — it cannot reach a device that is never opened again; that limitation is inherent to working offline, not a bug in this feature.'),
        table([
          { label: 'Device', render: d => h('div', {}, h('b', {}, d.label || 'Device'), h('div', { class: 'small mono muted' }, d.id.slice(0, 8))) },
          { label: 'Belongs to', render: d => h('div', {}, d.display_name, h('div', { class: 'small muted' }, d.username)) },
          { label: 'First seen', render: d => fmt.dt(d.first_seen_at) },
          { label: 'Last synced', render: d => fmt.dt(d.last_seen_at) },
          { label: 'Syncs', key: 'sync_count' },
          { label: 'Status', render: d => d.revoked_at ? badge(d.wipe_requested_at ? 'Wiped' : 'Revoked', 'danger') : d.wipe_requested_at ? badge('Wipe pending', 'warn') : badge('Active', 'ok') },
          { label: '', render: d => h('div', { class: 'row' },
            !d.revoked_at && !d.wipe_requested_at ? h('button', { class: 'btn sm', onClick: async () => { if (await confirmDialog('Revoke this device', `"${d.label || 'This device'}" (${d.display_name}) will be blocked from syncing until you clear it. Its local copy is kept; use Wipe to erase it.`, { danger: true, okText: 'Revoke' })) act(d.id, 'revoke'); } }, 'Revoke') : null,
            !d.wipe_requested_at && !d.revoked_at ? h('button', { class: 'btn sm danger', onClick: async () => { if (await confirmDialog('Wipe this device', `The next time "${d.label || 'this device'}" (${d.display_name}) tries to sync, it will be told to erase everything it has stored and will need to be set up again. This cannot reach a device that never syncs again.`, { danger: true, okText: 'Request wipe' })) act(d.id, 'wipe'); } }, 'Wipe') : null,
            (d.revoked_at || d.wipe_requested_at) ? h('button', { class: 'btn sm', onClick: () => act(d.id, 'clear') }, 'Clear') : null) },
        ], devices, { empty: 'No devices have synced yet.' }));
    },
  };
  // Someone without users:manage (a supervisor) reaches this page for one thing: moving a caseload.
  const full = can('users:manage');
  const tabs = !full ? [['caseload', 'Move a caseload'], ...(can('audit:read') ? [['audit', 'Audit log']] : [])]
    : state.local ? [['users', 'Users & roles'], ['settings', 'Settings'], ['caseload', 'Move a caseload'], ['audit', 'Audit log']]
    : [['users', 'Users & roles'], ['settings', 'Settings'], ['network', 'Network & devices'], ['devices', 'Synced devices'], ['caseload', 'Move a caseload'], ['audit', 'Audit log'], ['apikeys', 'API keys (intake)'], ['system', 'System & backups']];
  const allowed = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  body.append(await (T[allowed] || T[tabs[0][0]])());
  return h('div', {}, pageHead(full ? 'Settings' : 'Supervision tools'), state.local ? h('div', { class: 'banner small' }, 'This is the copy of SUDS on this device. Network, API keys and backups are managed on the office SUDS; use Sync to exchange data.') : null, h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onClick: () => nav(`admin?tab=${k}`) }, l))), body);
});

// ---------------------------------------------------------------------------
// Restoring from a backup, without a terminal. INSTALL.md is written for an
// office manager; "ask IT to run node scripts/backup.js --restore" was not a
// recovery plan for the audience this app is for.
// ---------------------------------------------------------------------------
export function restoreCard() {
  const fileInput = h('input', { type: 'file', accept: '.enc,application/octet-stream', 'aria-label': 'Backup file' });
  const summary = h('div', { class: 'mt' });
  let fileB64 = null;

  const readFile = () => new Promise((resolve, reject) => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) { reject(new Error('Choose the backup file first')); return; }
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('That file could not be read'));
    r.readAsDataURL(f);
  });

  const preview = async () => {
    clear(summary);
    try {
      fileB64 = await readFile();
      const info = await post('/api/admin/restore/preview', { file_b64: fileB64 });
      summary.append(
        h('div', { class: 'banner warn', role: 'status' }, 'Nothing has changed yet. Check that this is the backup you meant before restoring.'),
        kv([
          ['Taken from', info.org_name || '—'],
          ['Clients in the backup', `${info.counts.clients} (this server has ${info.current.clients})`],
          ['Notes', String(info.counts.notes)],
          ['Visits & services', String(info.counts.interventions)],
          ['Staff accounts', String(info.counts.users)],
          ['Version', `schema ${info.schema_version}${info.schema_version < info.current.schema_version ? ' — older than this server; it will be brought up to date automatically' : ''}`],
          ['Size', fmt.bytes(info.bytes)],
        ]),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onClick: doRestore }, 'Replace everything with this backup')));
    } catch (e) { summary.append(h('div', { class: 'banner error', role: 'alert' }, e.message)); }
  };

  const doRestore = async () => {
    let password, confirmBox;
    const m = modal('Replace all data with this backup', h('div', {},
      h('p', {}, 'Everything recorded since this backup was taken will be gone. The current database is kept aside on the server first, so this can be undone by someone with access to the machine.'),
      h('p', { class: 'small muted' }, 'Everyone will be signed out. Devices should sync afterwards.'),
      h('div', { class: 'field' }, h('label', { for: 'restore-confirm' }, 'Type REPLACE to confirm *'), confirmBox = h('input', { id: 'restore-confirm', autocomplete: 'off' })),
      h('div', { class: 'field' }, h('label', { for: 'restore-pw' }, 'Your password *'), password = h('input', { id: 'restore-pw', type: 'password', autocomplete: 'current-password' })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn danger', onClick: async () => {
          try {
            const r = await post('/api/admin/restore', { file_b64: fileB64, password: password.value, confirm: confirmBox.value.trim() });
            m.close();
            toast(`Restored ${r.counts.clients} client record(s).`, 'ok');
            // The session this page holds belongs to the database that was just replaced, so there is
            // nothing to cancel back to: however the dialog is dismissed, the next stop is the sign-in page.
            const signIn = async () => { try { await post('/api/auth/logout', {}); } catch { /* the session is already gone with the old database */ } location.hash = '#/login'; location.reload(); };
            const done = modal('Restore complete', h('div', {},
              h('p', {}, `${r.note} The database that was replaced is kept on the server as ${r.previous_database_kept_at.split('/').pop()}.`),
              h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', 'data-restore-done': '1', onClick: () => done.close() }, 'Sign in again'))), { onClose: signIn });
          } catch (e) { toast(e.message, 'error'); }
        } }, 'Replace everything'))));
  };

  return h('div', { class: 'card mt' },
    h('h3', {}, 'Restore from a backup'),
    h('p', { class: 'small muted' }, 'Put a backup back onto this server. It can only be opened with this server\'s encryption keys, so a backup from a different installation will be refused.'),
    h('div', { class: 'row' }, fileInput, h('button', { class: 'btn', onClick: preview }, 'Check this backup')),
    summary);
}

// ---------------------------------------------------------------------------
// Moving a whole caseload when a worker leaves. Doing this one client at a time
// through the care-team tab is how clients get missed.
// ---------------------------------------------------------------------------
export function transferCard() {
  if (!can('assignments:manage')) return null;
  // Only people who carry a caseload: a finance or admin account has no clients to move.
  const staff = state.users.filter(u => u.is_active !== 0 && ['navigator', 'clinician', 'supervisor'].includes(u.role));
  const result = h('div', { class: 'mt' });
  const f = form([
    { name: 'from_user_id', label: 'Move clients from', type: 'select', required: true, options: staff.map(u => ({ value: u.id, label: `${u.display_name} (${fmt.label(u.role)})` })) },
    { name: 'to_user_id', label: 'To', type: 'select', required: true, options: staff.map(u => ({ value: u.id, label: `${u.display_name} (${fmt.label(u.role)})` })) },
    { name: 'role_on_case', label: 'Role on the case', type: 'select', options: ['primary', 'secondary', 'clinician', 'peer', 'supervisor'], help: 'Leave empty to keep whatever role each assignment already has.' },
    { name: 'effective_date', label: 'Effective from', type: 'date', value: new Date().toISOString().slice(0, 10) },
    { name: 'reassign_open_tasks', label: 'Also move their open to-dos for those clients', type: 'checkbox', value: 1 },
    { name: 'reason', label: 'Reason (recorded in the audit log)', span: true, placeholder: 'e.g. left the program, extended leave' },
  ], { submitText: 'Transfer caseload', onSubmit: async (d) => {
    const from = staff.find(u => u.id === d.from_user_id), to = staff.find(u => u.id === d.to_user_id);
    if (!await confirmDialog('Transfer caseload', `Move every client currently assigned to ${from?.display_name} over to ${to?.display_name}?`, { danger: true, okText: 'Transfer' })) return;
    const r = await post('/api/caseload/transfer', d);
    clear(result);
    result.append(h('div', { class: 'banner ok', role: 'status' },
      `${r.transferred} client${r.transferred === 1 ? '' : 's'} moved from ${r.from} to ${r.to}${r.tasks_reassigned ? `, and ${r.tasks_reassigned} to-do(s) reassigned` : ''}.`));
    if (r.skipped && r.skipped.length) result.append(h('p', { class: 'small muted' }, `${r.skipped.length} were already assigned to the receiving worker.`));
    toast('Caseload transferred', 'ok');
  } });
  return h('div', { class: 'card' },
    h('h3', {}, 'Move a caseload to another worker'),
    h('p', { class: 'small muted' }, 'When someone leaves or goes on extended leave, this ends every one of their current assignments and gives those clients to another worker in one step. Their last day is the day before the transfer takes effect, so nobody holds a client twice.'),
    f, result);
}

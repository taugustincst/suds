import { h, route, api, get, post, put, del, state, form, modal, toast, table, badge, flag, statusKind, fmt, can, pageHead, confirmDialog, nav, stat, kv, loadRefData, downloadCsv, clear, pageTabs } from '../app.js';
import { qrSvg } from '../qr.js';
import { listsTab } from './lists.js';
import { securityTab, drillCard } from './security.js';
import { instrumentsCard } from './clinical.js';

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
    (state.funds || []).length ? { name: 'default_fund_id', label: 'Default funding source for their visits', type: 'select', placeholder: '— the programme default —', options: state.funds.map(f => ({ value: f.id, label: f.name })), help: 'Pre-filled on the visit form; they can still choose another.' } : null,
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
      let moveTo = null;
      if (values.is_active && !d.is_active) {
        const wipe = d.wipe_devices && deviceCount ? ` ${deviceCount} synced device${deviceCount === 1 ? '' : 's'} will be told to erase ${deviceCount === 1 ? 'its' : 'their'} local copy of client records the next time ${deviceCount === 1 ? 'it' : 'they'} connect.` : '';
        const answer = await deactivateDialog(values, `${values.display_name} will be signed out everywhere and can no longer sign in.${wipe}`);
        if (!answer) return;
        moveTo = answer.moveTo;
      }
      await put(`/api/users/${values.id}`, d); m.close(); toast('User updated', 'ok');
      // The caseload moves through the same audited transfer as Settings -> Move a caseload. If that fails the
      // account is still deactivated, and Home's "assigned to inactive staff" warning keeps it in view.
      if (moveTo) {
        try {
          const r = await post('/api/caseload/transfer', { from_user_id: values.id, to_user_id: moveTo, reassign_open_tasks: true, reason: 'Account deactivated' });
          toast(`${r.transferred} client${r.transferred === 1 ? '' : 's'}${r.tasks_reassigned ? ` and ${r.tasks_reassigned} to-do${r.tasks_reassigned === 1 ? '' : 's'}` : ''} moved to ${r.to}`, 'ok');
        } catch (e) { toast(`The account is deactivated, but its caseload was not moved: ${e.message}. Move it under Settings → Move a caseload.`, 'error'); }
      }
      await loadRefData();
    }
    onDone();
  } });
  const m = modal(isNew ? 'New user' : `Edit ${values.display_name}`, f, { wide: true });
}

// Deactivating an account does not take its clients and to-dos away from it, so the confirmation says how
// many there are and -- for someone who may move caseloads -- offers to move them to an active worker in the
// same step. Resolves { moveTo } (an id, or null to leave them) or null when cancelled.
async function deactivateDialog(values, intro) {
  const load = await get(`/api/users/${values.id}/caseload`, { quiet: true }).catch(() => null);
  const n = load ? load.clients : 0, t = load ? load.open_tasks : 0;
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const held = n || t ? `${plural(n, 'client', 'clients')} and ${plural(t, 'open to-do', 'open to-dos')} ${n + t === 1 ? 'is' : 'are'} assigned to ${values.display_name}.` : '';
  const mayMove = (n || t) && can('assignments:manage');
  const staff = caseloadStaff().filter(u => u.id !== values.id);
  let pick = null;
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; m.close(); resolve(v); };
    const okBtn = h('button', { class: 'btn danger', 'data-deactivate-ok': '1', onClick: () => done({ moveTo: pick && pick.value ? pick.value : null }) }, 'Deactivate');
    const m = modal('Deactivate this account', h('div', { 'data-deactivate': '1' },
      h('p', {}, intro),
      held ? h('p', { 'data-deactivate-caseload': `${n}/${t}` }, h('b', {}, held)) : null,
      mayMove ? h('div', { class: 'field' },
        h('label', { for: 'deactivate-move-to' }, 'Move them to'),
        pick = h('select', { id: 'deactivate-move-to', name: 'move_to', onChange: () => { okBtn.textContent = pick.value ? 'Move and deactivate' : 'Deactivate'; } },
          h('option', { value: '' }, '— leave them for now —'), staff.map(u => h('option', { value: u.id }, `${u.display_name} (${fmt.label(u.role)})`))),
        h('div', { class: 'small muted' }, 'Their current assignments end today and the other worker takes over, with their open to-dos. Left for now, they can be moved later under Move a caseload.'))
        : (n || t) ? h('p', { class: 'small muted', 'data-deactivate-supervisor': '1' }, 'A supervisor must move them to another worker (Supervision tools → Move a caseload). Until then nobody is working them.') : null,
      h('p', {}, 'Continue?'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => done(null) }, 'Cancel'), okBtn)), { onClose: () => { if (!answered) resolve(null); } });
  });
}

// Active staff who carry a caseload: who clients can be given to. A finance or admin account has none.
function caseloadStaff() { return state.users.filter(u => u.is_active !== 0 && ['navigator', 'clinician', 'supervisor'].includes(u.role)); }

// There is no native app (removed in 1.9.3, docs/PLATFORM.md); staff use the web app in a browser. /app is the
// step-by-step page for adding it to a home screen — on the office server, which rewrites that path. A
// static host (the published on-device app) has no rewrite, so there the page is linked by its file name.
function useOnDevicesCard(primary) {
  const appUrl = window.SUDS_STATIC_HOST || state.local ? 'get-app.html' : primary.replace(/\/$/, '') + '/app';
  return h('div', { class: 'card' }, h('h2', {}, 'Use SUDS on phones and tablets'),
    h('p', { class: 'small' }, 'There is no separate app to install: staff open SUDS in the browser at the address on the left and add it to their home screen. The step-by-step page for that is ', h('a', { href: appUrl, target: '_blank', rel: 'noopener' }, appUrl), '.'),
    h('p', { class: 'small muted' }, 'The web application on this server is the system of record. The former Android and iOS apps and the desktop launchers were removed in SUDS 1.9.3; a phone that still has one should sync one last time and uninstall it — see docs/PLATFORM.md.'));
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
  return h('div', { class: 'card', 'data-sample': st.loaded ? 'loaded' : 'empty' }, h('h2', {}, 'Sample data'),
    st.loaded ? [h('p', { class: 'small' }, badge('Sample data loaded', 'info'), ' ', `${st.counts.clients} fictional clients and ${st.total} records added ${fmt.dt(st.loaded_at)}. Client codes start with DEMO-.`),
      h('p', { class: 'small muted' }, state.local ? 'Sample data is removed automatically before this device syncs with the office, so it never mixes with real records.' : 'Remove it before entering real clients.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onClick: remove }, 'Remove sample data'), busy)]
    // can_load comes from the server (or the in-browser kernel), which decides: an office server, or a
    // browser copy it hands out, and the on-device app all offer sample data only to an empty program
    // (server/demo.js loadRefusal); the "alongside" branch below is for a server that says otherwise.
    : !(st.can_load ?? st.clients_total === 0) ? h('p', { class: 'small muted', 'data-sample-refused': '1' }, 'Sample data can only be added while there are no clients yet, so it never mixes with real records.')
    : st.clients_total > 0 ? [h('p', { class: 'small muted', 'data-sample-alongside': '1' }, `Add a set of fictional clients, visits, notes, referrals and funding beside the ${st.clients_total === 1 ? 'client' : `${st.clients_total} clients`} you entered yourself. Sample client codes start with DEMO-, and "Remove sample data" takes away only those, leaving yours.`),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: load }, 'Load sample data'), busy)]
    : [h('p', { class: 'small muted' }, 'Add a set of fictional clients, visits, calls, notes, referrals, reminders, resources and funding so you can try every screen. Nothing here is real, and it can be removed in one click.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: load }, 'Load sample data'), busy)]);
}

// The programme's time zone: which calendar day a visit, a due date and a report period fall on
// (server/routes/budget.js orgTimezone). Offered from the zones this browser knows, with its own zone first.
function timezoneField(s) {
  const tz = s.timezone || {};
  const here = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
  let zones = []; try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  const all = [...new Set([here, s.org_timezone, tz.effective, ...zones].filter(Boolean))];
  const options = [
    ...(here ? [{ value: here, label: `${here.replace(/_/g, ' ')} (this device's time zone)` }] : []),
    ...all.filter(z => z !== here).sort().map(z => ({ value: z, label: z.replace(/_/g, ' ') })),
  ];
  const fallback = tz.fallback || here;
  return { name: 'org_timezone', label: 'Organisation time zone', type: 'select', options, value: s.org_timezone || '', placeholder: state.local ? `Not set — ${here || 'this device'}'s time zone` : `Not set — the server's (${fallback})`, span: true,
    help: `Decides which calendar day a visit, a due date and a report period fall on. In use now: ${tz.effective || fallback || 'not known'}.${!state.local && tz.from_env ? ' Choosing one here overrides ORG_TIMEZONE on the server.' : ''}` };
}
// On a device copy, the settings the office server has elsewhere: backups and restore are on This device,
// and staff reach SUDS on a phone or tablet through get-app.html (not /app, which only an office has).
function deviceSettingsCard() {
  const onStatic = !!window.SUDS_STATIC_HOST;
  return h('div', { class: 'card', 'data-device-settings': '1' }, h('h2', {}, 'Backups and other devices'),
    h('p', { class: 'small' }, onStatic ? 'SUDS on this device keeps its records only in this browser. Back them up, and restore a backup, on ' : 'This copy syncs with the office SUDS, which makes the backups. Sync, and erase this device, on ', h('a', { href: '#/sync', 'data-device-page-link': '1' }, 'This device'), '.'),
    h('p', { class: 'small' }, h('a', { href: 'get-app.html', target: '_blank', rel: 'noopener', 'data-get-app-link': '1' }, 'Use SUDS on your phone or tablet'), ' — how to add SUDS to a home screen.'),
    h('p', { class: 'small muted' }, onStatic ? 'There is no server here, so there is no backup schedule, network setting or certificate to download: those belong to an office SUDS server.' : 'The backup schedule, network settings and certificate are managed on the office SUDS server.'));
}

route('admin', async (r) => {
  const tab = r.query.get('tab') || 'users';
  const refresh = () => nav(`admin?tab=${tab}&_=${Date.now()}`);
  const body = h('div', {});
  const T = {
    async users() {
      const { users } = await get('/api/users');
      return h('div', {}, state.local ? null : await accessRequestsCard(refresh), h('div', { class: 'row mb' }, h('button', { class: 'btn primary', onClick: () => openUserForm(null, refresh) }, '+ New user')),
        table([{ label: 'Name', render: u => h('div', {}, h('b', {}, u.display_name), h('div', { class: 'small muted' }, u.username, u.title ? ` · ${u.title}` : '')) }, { label: 'Role', render: u => badge(fmt.label(u.role), u.role === 'admin' ? 'purple' : 'info') }, { label: 'Email', key: 'email' }, { label: 'MFA', render: u => u.mfa_enabled ? badge('On', 'ok') : badge('Off', 'warn') }, { label: 'Status', render: u => [u.is_active ? badge('Active', 'ok') : u.access_status === 'declined' ? badge('Request declined') : badge('Inactive'), u.locked_until && Date.parse(u.locked_until) > Date.now() ? [' ', badge('Locked', 'danger')] : null] }, { label: 'Last login', render: u => u.last_login_at ? fmt.dt(u.last_login_at) : 'never' }, { label: '', render: u => h('button', { class: 'btn sm', onClick: () => openUserForm(u, refresh) }, 'Edit') }], users));
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
        ...(state.local ? [] : [
          { name: 'mfa_require_all', label: 'Require two-step verification for every role', type: 'select', noBlank: true, value: s.mfa_require_all === '1' ? '1' : '0', options: [{ value: '1', label: 'On — every role, whatever the list above says (recommended)' }, { value: '0', label: 'Off — the roles listed above' }], span: true },
          { name: 'sso_required', label: 'Require single sign-on', type: 'select', noBlank: true, value: s.sso_required === '1' ? '1' : '0', options: [{ value: '0', label: 'Off — passwords and SSO both work' }, { value: '1', label: 'On — password sign-in only for the emergency accounts below' }], span: true, help: s.env.oidc_configured ? 'Staff sign in through the county identity provider; leavers are cut off there.' : 'Needs single sign-on to be configured first (OIDC_* settings, docs/DEPLOYMENT.md).' },
          { name: 'sso_emergency_accounts', label: 'Emergency (break-glass) administrator accounts that keep a password', value: s.sso_emergency_accounts || '', placeholder: 'e.g. admin', span: true, help: 'Usernames, comma separated. Keep their passwords sealed; every use is audited.' },
          { name: 'sso_trust_idp_mfa', label: "Trust the identity provider's multi-factor sign-in", type: 'select', noBlank: true, value: s.sso_trust_idp_mfa === '1' ? '1' : '0', options: [{ value: '0', label: 'Off — SSO sign-ins still need the SUDS second factor' }, { value: '1', label: 'On — accept the provider\'s MFA (amr mfa, or two factor kinds such as pwd+otp) in place of it' }], span: true, help: 'Only if the county identity provider enforces MFA for SUDS (conditional access). A sign-in it does not mark as multi-factor still needs the SUDS code; every trusted sign-in is audited.' },
          { name: 'sso_mfa_acr_values', label: 'Also accept these authentication context (acr) values as MFA', value: s.sso_mfa_acr_values || '', placeholder: 'e.g. http://schemas.openid.net/pape/policies/2007/06/multi-factor', span: true, help: 'Comma separated; asked for at sign-in when trust is on. Leave blank if the provider reports MFA in amr (Entra ID and Okta do).' },
          { name: 'sso_deprovision_days', label: 'Disable single sign-on accounts not seen for (days, 0 = never)', type: 'number', min: 0, step: 1, value: s.sso_deprovision_days || '0', help: 'An account linked to the identity provider that has not signed in through it (or been updated by provisioning) for this long is disabled, its sessions ended and its devices wiped on their next sync. Emergency accounts are never disabled.' },
          { name: 'scim_group_roles', label: 'Provisioning (SCIM): identity-provider groups to SUDS roles', type: 'textarea', rows: 3, value: s.scim_group_roles || '', placeholder: 'SUD Navigators=navigator; SUD Supervisors=supervisor', span: true, help: 'One Group=role per line or separated by semicolons. A person in several mapped groups gets the most privileged role.' },
          { name: 'scim_default_role', label: 'Role for a provisioned person in no mapped group', type: 'select', noBlank: true, value: s.scim_default_role || 'readonly', options: ['readonly', 'finance', 'navigator', 'clinician', 'supervisor'].map((r) => ({ value: r, label: r })) },
        ]),
        { name: 'mfa_grace_days', label: 'Days a new account has to set up MFA', type: 'number', min: 0, step: 1, value: s.policy.mfaGraceDays, help: 'Counted from when the account is created (or its access request approved). 0 = at first sign-in.' },
        { name: 'self_signup', label: 'Sign up on the sign-in page', type: 'select', noBlank: true, value: s.self_signup === '0' ? '0' : '1', options: [{ value: '1', label: 'On — people can request an account; an administrator approves each one' }, { value: '0', label: 'Off — the sign-in page says to ask an administrator' }], span: true },
        { type: 'section', label: 'Record retention' },
        { name: 'client_retention_years', label: 'Keep discharged client records for (years, minimum 6)', type: 'number', min: 6, step: 1, value: s.client_retention_years || '7', help: 'Once every episode is closed and this many years have passed since discharge, the record is permanently deleted from every table — unless an administrator has placed it on legal hold from the client\'s Care team tab.' },
        // Reporting: which fund a visit is charged to when nobody chooses one, the funder report's small-cell
        // threshold, and how many doses a distributed naloxone kit holds (the NDP log).
        { type: 'section', label: 'Reporting' },
        { name: 'default_fund_id', label: 'Default funding source for new visits', type: 'select', placeholder: '— none —', options: (state.funds || []).map(f => ({ value: f.id, label: f.name })), span: true, help: 'Pre-filled on the visit form, and charged when the worker does not choose a fund. A worker\'s own default (Users & roles → Edit) comes first.' },
        { name: 'small_cell_threshold', label: 'Small-cell threshold (funder report)', type: 'number', min: 2, max: 50, step: 1, value: s.small_cell_threshold || '11', help: 'Breakdown rows counting fewer people than this are shown as "<N" unless a supervisor, administrator or finance runs the report with exact counts for the programme\'s own submission.' },
        { name: 'naloxone_doses_per_kit', label: 'Naloxone doses per kit (NDP log)', type: 'number', min: 1, max: 20, step: 1, value: s.naloxone_doses_per_kit || '2' },
        { type: 'section', label: 'Time zone' },
        timezoneField(s),
        // Scheduled server backups belong to the office server. A device copy has no backup schedule and no
        // backup folder: it showed "every 0 hours, keep 0" fields that did nothing. Its backups are on the
        // This device page (the card beside this form says so).
        ...(state.local ? [] : [
          { type: 'section', label: 'Scheduled backups' },
          { name: 'backup_schedule_hours', label: 'Back up automatically every (hours, 0 = off)', type: 'number', min: 0, step: 1, value: s.backup_schedule_hours || '0',
            help: Number(s.backup_schedule_hours) > 0 ? `On: a backup is made every ${s.backup_schedule_hours} hour${Number(s.backup_schedule_hours) === 1 ? '' : 's'}, and the newest ${s.backup_retain_count || 14} are kept.` : 'Off: no backups are made automatically. Enter a number of hours (24 = daily) to turn them on.' },
          { name: 'backup_retain_count', label: 'Keep this many recent backups on disk', type: 'number', min: 1, step: 1, value: s.backup_retain_count || '14' },
          { name: 'backup_offsite_dir', label: 'Also copy each backup to (a mounted network share or drive path; blank = local only)', span: true, value: s.backup_offsite_dir || '' },
          { name: 'backup_schedule_minutes', label: 'Also snapshot every (minutes, 0 = off)', type: 'number', min: 0, max: 1440, step: 1, value: s.backup_schedule_minutes || '0',
            help: Number(s.backup_schedule_minutes) > 0 ? `On: an encrypted snapshot every ${s.backup_schedule_minutes} minutes goes to the offsite folder (or the local backups folder), so at most ${s.backup_schedule_minutes} minutes of work can be lost.` : 'Off. 5 or more turns on frequent online snapshots, which bring the recovery point down to minutes; they run while people work.' },
          { name: 'backup_snapshot_retain', label: 'Keep this many recent snapshots', type: 'number', min: 1, max: 1000, step: 1, value: s.backup_snapshot_retain || '24' },
          { name: 'dr_drill_monthly', label: 'Recovery drill every month', type: 'select', noBlank: true, value: s.dr_drill_monthly === '1' ? '1' : '0', options: [{ value: '0', label: 'Off — run drills by hand (System & backups)' }, { value: '1', label: 'On — restore the newest backup into a temporary copy monthly and check it' }], span: true },
          { name: 'dr_rto_target_minutes', label: 'Recovery time objective (minutes)', type: 'number', min: 1, step: 1, value: s.dr_rto_target_minutes || '60' },
          { name: 'dr_rpo_target_hours', label: 'Recovery point objective (hours)', type: 'number', min: 1, step: 1, value: s.dr_rpo_target_hours || '', placeholder: 'the backup interval, else 24' },
        ]),
      ], { values: s, submitText: 'Save settings', onSubmit: async (d) => { await put('/api/admin/settings', d); toast('Settings saved', 'ok'); },
        extra: state.local ? null : h('p', { class: 'small', 'data-backup-link': '1' }, 'To back up now, download a backup or restore one, open ', h('a', { href: '#/admin?tab=system' }, 'System & backups'), '.') });
      return h('div', { class: 'grid cols-2' }, h('div', { class: 'card' }, h('h2', {}, 'Program settings'), f), state.local ? deviceSettingsCard() : null, await instrumentsCard(refresh), await sampleDataCard(refresh),
        h('div', { class: 'card' }, h('h2', {}, 'Server security configuration'), h('p', { class: 'small muted' }, 'Set via environment variables (see .env.example and docs/DEPLOYMENT.md).'),
          kv([['Environment', s.env.env], ['HTTPS', s.env.tls ? badge(s.env.tls_mode === 'selfsigned' ? 'Self-signed certificate' : 'Enabled', 'ok') : badge('Off — enable under Network', 'danger')], ['Encryption keys', s.env.key_source === 'file' ? 'data/keys.json (back it up under System)' : s.env.key_source === 'devfile' ? 'Development key files in data/' : 'Environment variables'], ['Addresses', (s.env.listener?.urls || []).join(', ')], ['OneNote (Graph) sync', s.env.ms_graph_configured ? badge('Configured', 'ok') : badge('Not configured', 'warn')],
            ['Single sign-on (OIDC)', s.env.oidc_configured ? badge(`Configured — "${s.env.oidc_label}"`, 'ok') : badge('Not configured — set OIDC_ISSUER etc. (see docs/DEPLOYMENT.md)', 'warn')]])));
    },
    async audit() {
      const q = new URLSearchParams(); for (const k of ['action', 'user_id', 'client_id', 'from', 'to', 'failures']) if (r.query.get(k)) q.set(k, r.query.get(k)); q.set('limit', '200');
      const [a, v] = await Promise.all([get(`/api/admin/audit?${q}`), get('/api/admin/audit/verify')]);
      const actionI = h('input', { value: r.query.get('action') || '', placeholder: 'e.g. note.view, auth., client.' }), fromI = h('input', { type: 'date', value: r.query.get('from') || '' }), toI = h('input', { type: 'date', value: r.query.get('to') || '' }), userSel = h('select', {}, h('option', { value: '' }, 'Any user'), state.users.map(u => h('option', { value: u.id, selected: u.id === r.query.get('user_id') }, u.display_name))), failI = h('input', { type: 'checkbox', checked: r.query.get('failures') === '1' });
      const apply = () => nav(`admin?tab=audit&action=${encodeURIComponent(actionI.value)}&user_id=${userSel.value}&from=${fromI.value}&to=${toI.value}${failI.checked ? '&failures=1' : ''}`);
      return h('div', {},
        h('div', { class: 'row mb' }, v.ok ? badge(`Audit chain intact (${v.checked} entries verified)`, 'ok') : badge(`AUDIT CHAIN BROKEN at entry #${v.firstBadId} — investigate immediately`, 'danger'), v.anchors ? (v.anchors.ok ? badge(`Matches ${v.anchors.matched} anchor${v.anchors.matched === 1 ? '' : 's'} outside the database`, v.anchors.matched ? 'ok' : '') : badge(`DOES NOT MATCH its anchors outside the database: ${v.anchors.bad[0].reason}`, 'danger')) : null),
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
        h('div', { class: 'card' }, h('h2', {}, 'Connect a phone, tablet or another computer'), h('p', {}, 'On the office Wi-Fi, open ', h('b', {}, primary), L.mdns ? ' — no setup needed on the device.' : '.', ' Or scan this code. Then add it to the home screen: ', h('b', {}, 'iPhone'), ' Share → Add to Home Screen; ', h('b', {}, 'Android'), ' ⋮ → Install app. Everything staff do on the phone is instantly on the computer and vice versa.'),
          h('div', { class: 'center' }, qrSvg(primary, { size: 200 }), h('div', { class: 'mono' }, primary)),
          h('ul', { class: 'small mt' }, L.urls.map(u => h('li', {}, u))),
          L.tls ? h('div', { class: 'mt small' }, h('p', {}, `SUDS made its own certificate${n.cert_expires ? ` (valid until ${fmt.date(n.cert_expires)})` : ''}. Browsers show a one-time warning; choose Advanced → Proceed, or install SUDS's certificate authority on the device to remove it for good (Android: Settings → Security → Install a certificate → CA certificate; iPhone: install, then Settings → General → About → Certificate Trust Settings). Android browsers cannot use the suds.local name — give them the numeric address below, or the QR code.`), h('a', { class: 'btn sm', href: '/api/admin/certificate', download: '' }, 'Download certificate (CA)')) : h('div', { class: 'banner danger mt' }, 'HTTPS is off. Enable it before allowing other devices to connect.')),
        h('div', { class: 'card' }, h('h2', {}, 'Network settings'), locked ? h('div', { class: 'banner' }, 'Network settings are controlled by environment variables on this server (see docs/DEPLOYMENT.md).') : f),
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
        h('div', { class: 'card' }, h('h2', {}, 'Backups'), h('p', { class: 'small muted' }, 'Download an encrypted copy of the database at least weekly and store it off this computer. Backups can only be opened with the encryption keys, so keep the key backup somewhere separate (e.g. the county password manager).'),
          h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '/api/admin/backup', download: '' }, 'Download encrypted backup'), s.key_source === 'file' ? h('a', { class: 'btn danger', href: '/api/admin/keys-backup', download: '' }, 'Download key backup (keep secret)') : null),
          h('p', { class: 'small mt' }, 'Scheduled backups: ', s.last_scheduled_backup_at ? [badge(/^ok/.test(s.last_scheduled_backup_status || '') ? 'Configured' : 'Attention needed', /^ok/.test(s.last_scheduled_backup_status || '') ? 'ok' : 'danger'), ` last ran ${fmt.dt(s.last_scheduled_backup_at)}${s.last_scheduled_backup_status ? ` — ${s.last_scheduled_backup_status}` : ''}`] : badge('Off — turn on under Settings → Program settings'), ' ', h('button', { class: 'btn sm', onClick: runBackupNow }, 'Run a backup now'), ' ', runNow),
          restoreCard(),
          h('div', { class: 'mt' }, await drillCard()),
          h('h2', { class: 'mt' }, 'About this server'), kv([['SUDS version', s.version], ['Database', h('code', {}, s.db_path)], ['Keys', s.key_source === 'file' ? 'data/keys.json (generated by setup)' : 'Environment variables'], ['Key backup last downloaded', s.key_source !== 'file' ? 'Not applicable — keys come from the environment' : s.keys_backup_at ? fmt.dt(s.keys_backup_at) : badge('Never — download it below', 'danger')], ['Addresses', (s.listener?.urls || []).join(', ')], ['Retention', 'Audit logs are kept 7 years by default. Client records are soft-deleted only.']]),
          h('div', { class: 'row mt' }, h('button', { class: 'btn sm', onClick: checkForUpdate }, 'Check for updates'), updateStatus)));
    },
    async security() { return securityTab(); },
    async caseload() { return transferCard(r.query.get('from')); },
    async lists() { return listsTab(r.query.get('list')); },
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
  // Waiting account requests are counted on the tab itself, so they are seen from any tab of this page.
  const pending = full && !state.local ? await get('/api/users/access-requests', { quiet: true }).then(x => x.requests.length).catch(() => 0) : 0;
  let tabs = !full ? [['caseload', 'Move a caseload'], ...(can('audit:read') ? [['audit', 'Audit log']] : [])]
    : state.local ? [['users', 'Users & roles'], ['settings', 'Settings'], ['caseload', 'Move a caseload'], ['audit', 'Audit log']]
    : [['users', pending ? `Users & roles (${pending})` : 'Users & roles'], ['settings', 'Settings'], ['network', 'Network & devices'], ['devices', 'Synced devices'], ['caseload', 'Move a caseload'], ['audit', 'Audit log'], ['apikeys', 'API keys (intake)'], ['system', 'System & backups'], ['security', 'Security status']];
  // Moving a caseload needs assignments:manage; a role that manages users without it does not get a tab
  // whose form it could not submit (the deactivate dialog tells it a supervisor must move the clients).
  if (!can('assignments:manage')) tabs = tabs.filter(([k]) => k !== 'caseload');
  // Lists: the choices on documentation forms (settings:manage, administrators) and funding sources
  // (budget:manage — which is how a supervisor gets this tab, with only the funding sources on it).
  if (can('settings:manage') || can('budget:manage')) tabs.splice(full ? 2 : tabs.length, 0, ['lists', 'Lists']);
  // FHIR clients (the county EHR reading SUDS over FHIR): an office-server feature, next to the intake keys.
  if (full && !state.local && can('apikeys:manage')) { T.fhir = () => fhirClientsTab(refresh); const at = tabs.findIndex(([k]) => k === 'apikeys'); tabs.splice(at < 0 ? tabs.length : at + 1, 0, ['fhir', 'FHIR clients']); }
  const allowed = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  body.append(await (T[allowed] || T[tabs[0][0]])());
  return h('div', {}, pageHead(full ? 'Settings' : 'Supervision tools'), state.local ? h('div', { class: 'banner small' }, window.SUDS_STATIC_HOST ? 'This is SUDS on this device. Backups, and who may sign up here, are on the This device page.' : 'This is the copy of SUDS on this device. Network, API keys and backups are managed on the office SUDS; use Sync to exchange data.') : null, pageTabs(tabs, allowed, (k) => nav(`admin?tab=${k}`), { label: full ? 'Settings sections' : 'Supervision tools sections' }), body);
});

// ---------------------------------------------------------------------------
// Access requests: what the sign-in page's "Sign up" sends (POST /api/auth/signup). Each waits here until an
// administrator approves it — choosing the role, and a supervisor if wanted — or declines it.
// ---------------------------------------------------------------------------
async function accessRequestsCard(onDone) {
  const { requests } = await get('/api/users/access-requests', { quiet: true }).catch(() => ({ requests: [] }));
  const approve = (q) => {
    const f = form([
      { name: 'role', label: 'Role', type: 'select', required: true, options: [['navigator', 'Navigator'], ['clinician', 'Clinician'], ['supervisor', 'Supervisor'], ['finance', 'Finance'], ['readonly', 'Read-only'], ['admin', 'Administrator']].map(([value, label]) => ({ value, label })) },
      { name: 'supervisor_id', label: 'Supervisor (optional)', type: 'select', placeholder: '— none —', options: state.users.filter(u => u.is_active !== 0 && ['supervisor', 'admin'].includes(u.role)).map(u => ({ value: u.id, label: u.display_name })) },
      { name: 'title', label: 'Job title (optional)' },
    ], { submitText: 'Approve', onCancel: () => m.close(), onSubmit: async (d) => {
      await post(`/api/users/${q.id}/approve`, d); m.close(); toast(`${q.display_name} can now sign in`, 'ok'); await loadRefData(); onDone();
    } });
    const m = modal(`Approve ${q.display_name}`, h('div', {}, h('p', { class: 'small muted' }, `${q.username}${q.email ? ` · ${q.email}` : ''}. They sign in with the password they chose; two-step verification applies as for any new account.`), f));
  };
  const decline = async (q) => {
    if (!await confirmDialog('Decline this request', `${q.display_name} (${q.username}) will not be able to sign in. They are told the request was not approved when they next try.`, { danger: true, okText: 'Decline' })) return;
    await post(`/api/users/${q.id}/decline`, {}); toast('Request declined', 'ok'); onDone();
  };
  return h('div', { class: 'card mb', 'data-access-requests': String(requests.length) }, h('h2', {}, `Access requests (${requests.length})`),
    requests.length
      ? table([
        { label: 'Name', render: q => h('div', {}, h('b', {}, q.display_name), h('div', { class: 'small muted' }, q.username, q.email ? ` · ${q.email}` : '')) },
        { label: 'Reason given', render: q => h('span', { class: 'small' }, q.reason || '—') },
        { label: 'Requested', render: q => fmt.dt(q.requested_at) },
        { label: '', render: q => h('div', { class: 'row' }, h('button', { class: 'btn sm primary', 'data-approve': q.username, onClick: () => approve(q) }, 'Approve'), h('button', { class: 'btn sm danger', 'data-decline': q.username, onClick: () => decline(q) }, 'Decline')) },
      ], requests)
      : h('p', { class: 'small muted' }, 'No requests waiting. People can ask for an account from the sign-in page’s Sign up option (Settings → Program settings turns it off).'));
}

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
    h('h2', {}, 'Restore from a backup'),
    h('p', { class: 'small muted' }, 'Put a backup back onto this server. It can only be opened with this server\'s encryption keys, so a backup from a different installation will be refused.'),
    h('div', { class: 'row' }, fileInput, h('button', { class: 'btn', onClick: preview }, 'Check this backup')),
    summary);
}

// ---------------------------------------------------------------------------
// Moving a whole caseload when a worker leaves. Doing this one client at a time
// through the care-team tab is how clients get missed.
// ---------------------------------------------------------------------------
export async function transferCard(fromId) {
  if (!can('assignments:manage')) return h('div', { class: 'card' }, h('p', { class: 'small muted' }, 'Moving a caseload needs a supervisor account. Ask a supervisor to move the clients.'));
  const staff = caseloadStaff();
  // Someone already deactivated can still be holding clients (GET /api/users lists only active staff to a
  // supervisor), so those come from the caseload counts and are marked as inactive.
  const { users: holders = [] } = await get('/api/users/caseloads', { quiet: true }).catch(() => ({}));
  const inactive = holders.filter(u => !u.is_active && (u.clients || u.open_tasks) && !staff.some(s => s.id === u.id));
  const fromList = [...staff, ...inactive];
  const label = (u) => `${u.display_name} (${fmt.label(u.role)})${u.is_active === 0 ? ' (inactive)' : ''}`;
  const result = h('div', { class: 'mt' });
  const f = form([
    { name: 'from_user_id', label: 'Move clients from', type: 'select', required: true, value: fromList.some(u => u.id === fromId) ? fromId : undefined, options: fromList.map(u => ({ value: u.id, label: label(u) })) },
    { name: 'to_user_id', label: 'To', type: 'select', required: true, options: staff.map(u => ({ value: u.id, label: label(u) })) },
    { name: 'role_on_case', label: 'Role on the case', type: 'select', options: ['primary', 'secondary', 'clinician', 'peer', 'supervisor'], help: 'Leave empty to keep whatever role each assignment already has.' },
    { name: 'effective_date', label: 'Effective from', type: 'date', value: new Date().toISOString().slice(0, 10) },
    { name: 'reassign_open_tasks', label: 'Also move their open to-dos for those clients', type: 'checkbox', value: 1 },
    { name: 'reason', label: 'Reason (recorded in the audit log)', span: true, placeholder: 'e.g. left the program, extended leave' },
  ], { submitText: 'Transfer caseload', onSubmit: async (d) => {
    const from = fromList.find(u => u.id === d.from_user_id), to = staff.find(u => u.id === d.to_user_id);
    if (!await confirmDialog('Transfer caseload', `Move every client currently assigned to ${from?.display_name} over to ${to?.display_name}?`, { danger: true, okText: 'Transfer' })) return;
    const r = await post('/api/caseload/transfer', d);
    clear(result);
    result.append(h('div', { class: 'banner ok', role: 'status' },
      `${r.transferred} client${r.transferred === 1 ? '' : 's'} moved from ${r.from} to ${r.to}${r.tasks_reassigned ? `, and ${r.tasks_reassigned} to-do(s) reassigned` : ''}.`));
    if (r.skipped && r.skipped.length) result.append(h('p', { class: 'small muted' }, `${r.skipped.length} were already assigned to the receiving worker.`));
    toast('Caseload transferred', 'ok');
  } });
  return h('div', { class: 'card' },
    h('h2', {}, 'Move a caseload to another worker'),
    h('p', { class: 'small muted' }, 'When someone leaves or goes on extended leave, this ends every one of their current assignments and gives those clients to another worker in one step. Their last day is the day before the transfer takes effect, so nobody holds a client twice.'),
    f, result);
}

// ---------------------------------------------------------------------------
// FHIR clients: outside systems (the county EHR, an HIE) allowed to read SUDS over the FHIR API
// (docs/integration/FHIR.md). Each stands for one recipient organisation; a client's records reach it only
// while the client has a live consent naming that organisation for the chosen purpose.
// ---------------------------------------------------------------------------
// How a FHIR client proves who it is at the token endpoint. Its secret is never a bearer token itself.
const FHIR_SIGNIN = [
  { value: 'secret', label: 'Client secret (shown once)' },
  { value: 'jwt', label: 'Signed JWT only (SMART Backend Services, private_key_jwt)' },
  { value: 'both', label: 'Signed JWT or client secret (while the other system moves to JWT)' },
];
const fhirSigninOf = (c) => c.auth.jwt_only ? 'jwt' : c.auth.private_key_jwt ? 'both' : 'secret';
const fhirSigninLabel = { secret: 'Client secret', jwt: 'Signed JWT', both: 'Signed JWT or secret' };

// Before aliases are saved: how many clients each name would cover today (counts only, never who), and
// which aliases are too broad to be accepted. A one-word or generic alias ("county", "health") would match
// almost every consent that names a class of recipients.
function aliasPreview(getValues) {
  const out = h('div', { class: 'span', role: 'status', 'aria-live': 'polite', 'data-alias-preview': '1' });
  const run = async () => {
    const v = getValues();
    clear(out);
    if (!String(v.aliases || '').trim() && !String(v.recipient || '').trim()) { out.append(h('p', { class: 'small muted' }, 'Enter the recipient organisation or an alias first.')); return; }
    const r = await post('/api/admin/fhir-clients/alias-preview', { recipient: v.recipient || undefined, aliases: v.aliases || '', purpose: v.purpose || 'TREAT' });
    const rows = [
      ...(r.recipient ? [{ name: `${r.recipient.name} (recipient)`, ok: true, clients: r.recipient.clients }] : []),
      ...r.aliases.map(a => ({ name: a.alias, ok: a.ok, problem: a.problem, clients: a.clients })),
    ];
    out.append(
      h('h3', { class: 'eyebrow' }, 'Who this would cover today'),
      table([
        { label: 'Name', render: x => x.name },
        { label: 'Clients covered', render: x => String(x.clients) },
        { label: 'Accepted', render: x => x.ok ? 'Yes' : flag('No', true, 'too broad', 'danger') },
        { label: 'Why not', render: x => x.problem || '' },
      ], rows, { empty: 'Nothing to check.' }),
      h('p', { class: 'small' }, `In total ${r.total} client${r.total === 1 ? '' : 's'} with a live consent would be covered by the accepted names, for ${r.purpose}. Only counts are shown.`));
  };
  const btn = h('button', { class: 'btn sm', type: 'button', onClick: () => run().catch(e => { clear(out); out.append(h('p', { class: 'err' }, e.message)); }) }, 'Check aliases');
  return { btn, out };
}

async function fhirClientsTab(refresh) {
  const d = await get('/api/admin/fhir-clients');
  const keyFields = (values = {}) => [
    { type: 'section', label: 'How it signs in' },
    { name: 'signin', label: 'Authentication at the token URL', type: 'select', noBlank: true, span: true, options: FHIR_SIGNIN, value: values.signin || 'secret',
      help: 'Either way the other system gets a 15-minute access token from the token URL; its secret is never accepted as a bearer token on a data request. A signed JWT (RS384 or ES384) is the SMART Backend Services standard and keeps no shared secret on either side.' },
    { name: 'jwks', label: 'Public key set (JWKS JSON)', type: 'textarea', rows: 3, span: true, placeholder: '{"keys":[{"kty":"RSA","kid":"…","n":"…","e":"AQAB"}]}', help: 'Paste the public keys only. SUDS refuses a key set that contains private key material.' },
    { name: 'jwks_url', label: 'Or the key set\'s https address (JWKS URL)', type: 'url', span: true, help: 'Fetched by the server over the internet (never an address on this network) and cached for an hour. For a system on the county network, paste the key set instead.' },
  ];
  const keysOf = (v, { editing = false } = {}) => {
    const out = {};
    if (v.signin !== 'secret' && !String(v.jwks || '').trim() && !String(v.jwks_url || '').trim() && !editing) throw new Error('A signed-JWT client needs its public key set or the key set\'s address');
    if (String(v.jwks || '').trim()) out.jwks = v.jwks.trim(); else if (editing) out.jwks = null;
    if (String(v.jwks_url || '').trim()) out.jwks_url = v.jwks_url.trim(); else if (editing) out.jwks_url = null;
    out.jwt_only = v.signin === 'jwt';
    if (v.signin === 'secret' && editing) { out.jwks = null; out.jwks_url = null; }
    return out;
  };
  const create = () => {
    let f;
    const preview = aliasPreview(() => Object.fromEntries(new FormData(f)));
    f = form([
      { name: 'name', label: 'Name (e.g. "County EHR – SmartCare")', required: true, span: true },
      { name: 'recipient', label: 'Recipient organisation, exactly as consents name it', required: true, span: true, help: 'A client\'s data is returned only while they have an active Part 2 or release-of-information consent naming this organisation.' },
      { name: 'aliases', label: 'Other names consents use for it (one per line)', type: 'textarea', rows: 2, span: true, help: 'Each must name this organisation and no other: its full name (two specific words, or one within a longer name), or exactly a name in the resource directory. Generic words like county, health or services are not enough. Check them before saving.' },
      { name: 'purpose', label: 'Purpose of use', type: 'select', noBlank: true, value: 'TREAT', options: d.purposes.map(p => ({ value: p.code, label: `${p.label} (${p.code})` })), help: 'The consent\'s purpose must cover it (or say TPO).' },
      { name: 'rate_limit', label: 'Requests per minute', type: 'number', min: 1, max: 6000, step: 1, value: 120 },
      ...keyFields(),
      { type: 'section', label: 'What it may read' },
      { name: 'scope_all', label: 'Every resource type (system/*.read)', type: 'checkbox', span: true },
      ...d.resource_types.map(t => ({ name: `scope_${t.type}`, label: `${t.type}${t.phi ? '' : ' (directory, not PHI)'}`, type: 'checkbox' })),
    ], { submitText: 'Create FHIR client', onCancel: () => m.close(), extra: h('div', {}, h('div', { class: 'btn-row' }, preview.btn), preview.out), onSubmit: async (v) => {
      const scopes = v.scope_all ? ['system/*.read'] : d.resource_types.filter(t => v[`scope_${t.type}`]).map(t => `system/${t.type}.read`);
      if (!scopes.length) throw new Error('Choose at least one resource type');
      const rr = await post('/api/admin/fhir-clients', { name: v.name, recipient: v.recipient, aliases: v.aliases || '', purpose: v.purpose, rate_limit: v.rate_limit ? Number(v.rate_limit) : undefined, scopes, ...keysOf(v) });
      m.close();
      const origin = location.origin;
      const shown = modal('FHIR client created', h('div', {},
        rr.key ? h('p', {}, 'Copy the secret now — it will not be shown again. Give it to the other system\'s administrator over a secure channel.') : h('p', {}, 'This client signs in with a JWT signed by its own private key. Give the other system\'s administrator the client_id and the token URL; there is no secret to share.'),
        kv([['FHIR base URL', `${origin}${d.base_path}`], ['Token URL', `${origin}${d.token_path}`], ['client_id', rr.id], ['Scopes', rr.scopes.join(' ')]]),
        rr.key ? h('div', { class: 'qr', 'data-fhir-secret': '1' }, rr.key) : null,
        h('p', { class: 'small muted' }, rr.key ? 'client_secret above. Exchange it at the token URL (grant_type=client_credentials) for a 15-minute access token; the secret itself is not accepted as a bearer token. See docs/integration/FHIR.md.' : 'The assertion\'s iss and sub are the client_id and its aud is the token URL (SMART Backend Services). See docs/integration/FHIR.md.'),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: () => shown.close() }, rr.key ? 'I have copied it' : 'Done'))), { onClose: refresh });
    } });
    const m = modal('New FHIR client', f);
  };
  const edit = (c) => {
    let f;
    const preview = aliasPreview(() => ({ ...Object.fromEntries(new FormData(f)), recipient: c.recipient, purpose: c.purpose }));
    f = form([
      { name: 'aliases', label: 'Other names consents use for it (one per line)', type: 'textarea', rows: 2, span: true, value: c.aliases.join('\n'), help: 'Each must name this organisation and no other; generic words like county, health or services are not enough.' },
      ...keyFields({ signin: fhirSigninOf(c) }),
    ], { values: { jwks_url: c.auth.jwks_url || '' }, submitText: 'Save', onCancel: () => m.close(), extra: h('div', {}, h('div', { class: 'btn-row' }, preview.btn), preview.out), onSubmit: async (v) => {
      const body = { aliases: v.aliases || '', ...keysOf(v, { editing: true }) };
      // Keys already registered stay unless a new set is pasted (the public keys are not shown back here).
      if (!String(v.jwks || '').trim() && v.signin !== 'secret') delete body.jwks;
      await api('PATCH', `/api/admin/fhir-clients/${c.id}`, body);
      m.close(); toast('FHIR client saved'); refresh();
    } });
    const m = modal(`Edit FHIR client: ${c.name}`, h('div', {},
      c.auth.jwks_keys.length ? h('p', { class: 'small' }, `Registered public keys: ${c.auth.jwks_keys.map(k => `${k.kid || '(no kid)'} ${k.alg}`).join(', ')}. Paste a new key set to replace them.`) : null, f));
  };
  const purposeLabel = (c) => (d.purposes.find(p => p.code === c) || {}).label || c;
  return h('div', {},
    h('div', { class: 'banner small' }, 'FHIR clients read SUDS through the standards-based FHIR R4 API (read-only). Every answer that names a client is a 42 CFR Part 2 disclosure: it is made only under that client\'s consent, carries the redisclosure notice, and appears in the client\'s accounting of disclosures. The resource directory is not PHI.'),
    h('div', { class: 'row mb' }, h('button', { class: 'btn primary', onClick: create }, '+ New FHIR client')),
    table([
      { label: 'Name', key: 'name' },
      { label: 'Recipient', render: c => h('div', {}, [c.recipient, ...c.aliases.filter(a => !c.aliases_ignored.some(x => x.alias === a))].join(' / '),
        c.aliases_ignored.length ? h('div', { class: 'small' }, flag(`Ignored: ${c.aliases_ignored.map(x => x.alias).join(', ')}`, true, 'too broad to name one organisation', 'warn')) : null) },
      { label: 'Purpose', render: c => purposeLabel(c.purpose) },
      { label: 'Sign-in', render: c => fhirSigninLabel[fhirSigninOf(c)] },
      { label: 'Scopes', render: c => h('span', { class: 'small mono' }, c.scopes.join(' ')) }, { label: 'Limit', render: c => `${c.rate_limit}/min` },
      { label: 'Created', render: c => `${fmt.dt(c.created_at)} by ${c.created_by_name || ''}` }, { label: 'Last used', render: c => c.last_used_at ? fmt.dt(c.last_used_at) : 'never' },
      { label: 'Status', render: c => c.revoked_at ? badge('Revoked', 'danger') : badge('Active', 'ok') },
      { label: '', render: c => !c.revoked_at ? h('div', { class: 'btn-row' },
        h('button', { class: 'btn sm', onClick: () => edit(c) }, 'Edit'),
        h('button', { class: 'btn sm danger', onClick: async () => { if (await confirmDialog('Revoke FHIR client', `Revoke "${c.name}"? It stops working at once, including any access token it holds.`, { danger: true, okText: 'Revoke' })) { await del(`/api/admin/fhir-clients/${c.id}`); refresh(); } } }, 'Revoke')) : null },
    ], d.clients, { empty: 'No FHIR clients.' }));
}

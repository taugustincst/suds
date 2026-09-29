import { h, route, get, post, state, form, modal, toast, table, badge, fmt, pageHead, loadSession, nav, render, kv, confirmDialog, prefs, can, refreshPermissions, shortcutsOn, openShortcutsHelp } from '../app.js';
import { qrSvg } from '../qr.js';

route('profile', async (r) => {
  const force = r.query.get('force') === '1'; const mfaPrompt = r.query.get('mfa') === '1';
  const u = state.user;
  const pw = form([{ name: 'current_password', label: 'Current password', type: 'password', required: true }, { name: 'new_password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', help: 'At least 12 characters with upper & lower case, a number and a symbol.' }, { name: 'confirm', label: 'Confirm new password', type: 'password', required: true, autocomplete: 'new-password' }],
    { submitText: 'Change password', onSubmit: async (d) => { if (d.new_password !== d.confirm) throw new Error('Passwords do not match'); await post('/api/auth/password', { current_password: d.current_password, new_password: d.new_password }); toast('Password changed', 'ok'); await loadSession(); nav(force ? 'dashboard' : 'profile'); render(); } });
  const mfaBox = h('div', {});
  const renderMfa = () => {
    mfaBox.replaceChildren();
    if (u.mfa_enabled) mfaBox.append(...[badge('2-step verification is on', 'ok'), h('p', { class: 'small muted mt' }, 'Your account requires an authenticator code at sign-in.'), !u.mfa_required ? h('button', { class: 'btn sm danger', onClick: async () => { const f = form([{ name: 'password', label: 'Confirm password', type: 'password', required: true },
      // Both factors: a password on its own must not be able to remove the second one.
      { name: 'code', label: 'Code from your authenticator app', required: true, pattern: '[0-9]{6}', autocomplete: 'one-time-code', help: 'The 6-digit code the app shows now. If you have lost the app, ask an administrator to reset two-step verification for you.' }], { submitText: 'Turn off 2-step', onCancel: () => m.close(), onSubmit: async (d) => { await post('/api/auth/mfa/disable', d); m.close(); await loadSession(); render(); } }); const m = modal('Turn off 2-step verification', f); } }, 'Turn off 2-step') : null].filter(Boolean));
    else mfaBox.append(...[u.mfa_required ? h('div', { class: 'banner warn' }, u.mfa_setup_deadline ? `Your role requires two-step verification. Set it up by ${fmt.date(u.mfa_setup_deadline)} — after that SUDS will not let you in until it is done.` : 'Your role requires two-step verification. Set it up now to keep using SUDS.') : null, h('button', { class: 'btn primary', onClick: enroll }, 'Set up 2-step verification')].filter(Boolean));
  };
  async function enroll() {
    const s = await post('/api/auth/mfa/setup', {});
    const f = form([{ name: 'code', label: 'Enter the 6-digit code from the app', required: true, pattern: '[0-9]{6}', autocomplete: 'one-time-code' }], { submitText: 'Turn on 2-step', onCancel: () => m.close(), onSubmit: async (d) => { await post('/api/auth/mfa/enable', d); toast('2-step verification is on', 'ok'); m.close(); await loadSession(); nav('dashboard'); render(); } });
    const m = modal('Set up 2-step verification', h('div', {}, h('p', {}, '1. Open Microsoft Authenticator, Google Authenticator, or another TOTP app.'), h('p', {}, '2. Scan this QR code, or add an account manually with the secret key:'), h('div', { class: 'center mb' }, qrSvg(s.otpauth, { size: 220 })), h('div', { class: 'qr' }, s.secret.match(/.{1,4}/g).join(' ')), h('p', { class: 'small muted' }, h('a', { href: s.otpauth }, 'Open in authenticator app (on this device)')), h('p', {}, '3. Enter the code shown by the app:'), f));
  }
  renderMfa();
  if (mfaPrompt && !u.mfa_enabled) setTimeout(enroll, 0);
  const sessions = await get('/api/auth/sessions');
  // Desktop/browser notifications for reminders coming due, off unless this person switches it on here.
  const notifySupported = typeof Notification !== 'undefined';
  const notifyBox = h('input', { type: 'checkbox', id: 'notify-due', 'data-notify-due': '1', checked: !!prefs.get('notify_due') && notifySupported && Notification.permission === 'granted', disabled: !notifySupported, onChange: async (e) => {
    if (!e.target.checked) { prefs.set('notify_due', false); toast('Reminder notifications off'); return; }
    let perm = Notification.permission;
    if (perm !== 'granted') { try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; } }
    if (perm !== 'granted') { e.target.checked = false; toast('This browser did not allow notifications. Check its site settings for SUDS and try again.', 'error'); return; }
    prefs.set('notify_due', true); toast('You will be told here when a reminder comes due', 'ok');
  } });
  const reminders = can('tasks:read') ? h('div', { class: 'card' }, h('h2', {}, 'Reminders'),
    h('label', { class: 'check', for: 'notify-due', style: { marginTop: 0 } }, notifyBox, 'Show a notification on this device when one of my reminders comes due (while SUDS is open)'),
    h('p', { class: 'small muted mt' }, notifySupported ? 'The notification shows the reminder\'s title and the client\'s name, so switch it off on a shared computer. The bell at the top of every page shows the same count either way.' : 'This browser does not support notifications; the bell at the top of every page still shows what is due.')) : null;
  // Keyboard shortcuts (WCAG 2.1.4): the single-key ones can be switched off, per person, on every device.
  const shortcuts = h('div', { class: 'card', 'data-shortcuts-card': '1' }, h('h2', {}, 'Keyboard shortcuts'),
    h('label', { class: 'check', for: 'shortcuts-on', style: { marginTop: 0 } }, h('input', { type: 'checkbox', id: 'shortcuts-on', 'data-shortcuts-on': '1', checked: shortcutsOn(), onChange: (e) => { prefs.set('shortcuts_off', !e.target.checked); toast(e.target.checked ? 'Single-key shortcuts on' : 'Single-key shortcuts off', 'ok'); } }),
      'Use single-key shortcuts: / to find a client, n to log a visit, ? to list them'),
    h('p', { class: 'small muted mt' }, 'They work only when you are not typing in a field. Switch them off if they get in your way, for example with speech recognition. Ctrl + Enter (⌘ + Enter on a Mac) saves the open form either way. ',
      h('button', { class: 'btn sm', type: 'button', 'data-shortcuts-list': '1', onClick: () => openShortcutsHelp() }, 'Show the shortcuts')));
  return h('div', {}, pageHead('My profile'),
    force ? h('div', { class: 'banner warn' }, 'You must change your password before continuing.') : null,
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Account'), kv([['Name', u.display_name], ['Username', u.username], ['Role', fmt.label(u.role)], ['Title', u.title], ['Email', u.email], ['Caseload', u.caseload_restricted ? 'Assigned clients only' : 'All clients']]),
        h('p', { class: 'small mt' }, h('button', { class: 'btn sm', 'data-refresh-permissions': '1', onClick: async (e) => { e.target.disabled = true; await refreshPermissions(); toast('Permissions refreshed', 'ok'); } }, 'Refresh permissions'), ' ',
          h('span', { class: 'muted' }, 'If an administrator changed what you can do, pick it up without signing out.'))),
      h('div', { class: 'card' }, h('h2', {}, '2-step verification'), mfaBox),
      h('div', { class: 'card' }, h('h2', {}, 'Change password'), pw),
      reminders,
      shortcuts,
      state.local ? null : h('div', { class: 'card' }, h('h2', {}, 'Use SUDS on your phone'), h('p', { class: 'small' }, 'On the office Wi-Fi open ', h('b', {}, location.origin.replace(/^https?:\/\//, '')), ' or scan this code, then add it to the home screen: ', h('b', {}, 'iPhone:'), ' Share → Add to Home Screen. ', h('b', {}, 'Android:'), ' ⋮ → Install app. Your clients, notes and reminders are the same on every device — nothing to set up.'), h('div', { class: 'center' }, qrSvg(location.origin + '/', { size: 160 }))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Active sessions'), sessions.sessions.length > 1 ? h('button', { class: 'btn sm', onClick: async () => { await post('/api/auth/sessions/revoke-others', {}); toast('Other sessions signed out', 'ok'); nav('profile?_=' + Date.now()); } }, 'Sign out other sessions') : null),
        table([{ label: 'Started', render: s => fmt.dt(s.created_at) }, { label: 'Last active', render: s => fmt.dt(s.last_seen_at) }, { label: 'IP', key: 'ip' }, { label: 'Device', render: s => h('span', { class: 'small muted' }, (s.user_agent || '').slice(0, 60)) }, { label: '', srLabel: 'Current session', render: s => s.current ? badge('This session', 'ok') : '' }], sessions.sessions))));
});

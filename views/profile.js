import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, pageHead, loadSession, nav, render, kv, confirmDialog, prefs, can, refreshPermissions, shortcutsOn, openShortcutsHelp, passkeyGraceNotice } from '../app.js';
import { qrSvg } from '../qr.js';
import { passkeysPossible, platformAvailable, createPasskey, passkeyErrorMessage, approveWithFingerprintPref } from '../passkey.js';

// ---- Fingerprint sign-in (passkeys, docs/FINGERPRINT.md) ----
// This person's fingerprint sign-ins: add one on this device (the password again, and the authenticator code with
// two-step verification on, then the device's own prompt), rename, remove (the password again). Office server only;
// the card says plainly when this device or address cannot have one rather than offering a button that cannot work.
// In these screens it is "fingerprint sign-in on this device"; the technical word, passkey, is said once, explained.
const DEVICE = () => { const ua = navigator.userAgent || ''; return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows computer' : /CrOS/.test(ua) ? 'Chromebook' : 'computer'; };
const BROWSER = () => { const ua = navigator.userAgent || ''; return /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'this browser'; };
/** A default name that tells devices apart: the browser and the device ("Safari on iPhone"), not only whose it is. */
const guessName = () => `${BROWSER()} on ${DEVICE()}`;
// Which of this person's passkeys were added in this browser, so the list can say "this device". WebAuthn does not
// tell a page which passkeys a device holds; this browser remembers the ones it made (and forgets them if its storage
// is cleared: then nothing is marked, and the card says so).
const HERE_KEY = 'suds.passkeys.here';
const addedHere = () => { try { return JSON.parse(localStorage.getItem(HERE_KEY) || '[]'); } catch { return []; } };
const rememberHere = (id) => { try { localStorage.setItem(HERE_KEY, JSON.stringify([...new Set([...addedHere(), id])].slice(-20))); } catch { /* not remembered */ } };
/** "Add fingerprint sign-in": the password again (and the code with two-step verification on), then the device's prompt. */
export function openAddPasskeyDialog({ totp = false, onDone = null } = {}) {
  const f = form([
    { name: 'name', label: 'Name for this device', required: true, value: guessName(), help: 'So you can tell your devices apart, for example “Safari on iPhone” or “Work laptop”.' },
    { name: 'password', label: 'Your password', type: 'password', required: true, autocomplete: 'current-password', help: 'Asked again before a new way to sign in is added.' },
    ...(totp ? [{ name: 'code', label: 'Code from your authenticator app', required: true, autocomplete: 'one-time-code', pattern: '[0-9]{6}' }] : []),
  ], { submitText: 'Continue to fingerprint', onCancel: () => m.close(), onSubmit: async (v) => {
    // quiet: a wrong password is this form's answer (401), not the session ending.
    const o = await post('/api/auth/passkeys/register/options', { password: v.password, code: v.code || undefined }, { quiet: true });
    let credential;
    // A failure is the form's error (it re-enables its button and moves the focus to the message).
    try { credential = await createPasskey(o.publicKey); }
    catch (e) { const err = new Error(passkeyErrorMessage(e)); err.labelled = true; throw err; }
    const r = await post('/api/auth/passkeys/register', { credential, name: v.name });
    if (r && r.passkey) rememberHere(r.passkey.id);
    m.close(); toast('Fingerprint sign-in added on this device. You can sign in, sign and approve with your fingerprint here.', 'ok');
    await loadSession(); if (onDone) onDone();
  } });
  const m = modal('Add fingerprint sign-in', h('div', { 'data-passkey-add': '1' },
    h('p', {}, 'Your device will ask for your fingerprint (or its screen lock) and make a passkey for SUDS: a key that stays on the device. SUDS keeps only its public key — never your fingerprint.'), f));
  return m;
}
/** "Remove": the password again. */
export function openRemovePasskeyDialog(p, onDone = null) {
  const f = form([{ name: 'password', label: 'Your password', type: 'password', required: true, autocomplete: 'current-password' }], { submitText: 'Remove', onCancel: () => m.close(), onSubmit: async (v) => {
    await del(`/api/auth/passkeys/${p.id}`, { password: v.password }, { quiet: true }); m.close();
    toast(`Removed fingerprint sign-in “${p.name}”. It no longer signs you in, and anywhere it was signed in has been signed out.`, 'ok'); await loadSession(); if (onDone) onDone();
  } });
  const m = modal('Remove fingerprint sign-in', h('div', { 'data-passkey-remove': '1' }, h('p', {}, `“${p.name}” will no longer sign you in or confirm signatures, and any session it signed in ends. Enter your password to remove it.`), f));
  return m;
}
async function passkeysCard({ onChange = null } = {}) {
  if (state.local) return null;
  let d; try { d = await get('/api/auth/passkeys', { quiet: true }); } catch { return null; }
  if (!d.signin && !d.signing) return null;
  const card = h('div', { class: 'card', 'data-passkeys-card': '1' });
  const draw = async () => {
    try { d = await get('/api/auth/passkeys', { quiet: true }); } catch { /* keep the last */ }
    const possible = passkeysPossible() && d.available && await platformAvailable();
    const rows = d.passkeys;
    const here = addedHere();
    const changed = async () => { await draw(); if (onChange) onChange(); };
    const add = () => openAddPasskeyDialog({ totp: d.totp, onDone: changed });
    const rename = (p) => {
      const f = form([{ name: 'name', label: 'Name', required: true, value: p.name }], { submitText: 'Rename', onCancel: () => m.close(), onSubmit: async (v) => { await put(`/api/auth/passkeys/${p.id}`, { name: v.name }); m.close(); toast('Renamed', 'ok'); draw(); } });
      const m = modal('Rename fingerprint sign-in', f);
    };
    const remove = (p) => openRemovePasskeyDialog(p, changed);
    const approveBox = d.signing ? h('label', { class: 'check', for: 'approve-with-fingerprint' }, h('input', { type: 'checkbox', id: 'approve-with-fingerprint', 'data-approve-with-fingerprint': '1', checked: approveWithFingerprintPref(), onChange: (e) => { prefs.set('approve_with_fingerprint', e.target.checked); toast(e.target.checked ? 'You will confirm approvals with your fingerprint' : 'Approvals no longer ask for your fingerprint', 'ok'); } }),
      'Confirm my approvals of time and spending with my fingerprint') : null;
    // replaceChildren writes a null as the text "null": the parts that may be absent are filtered out.
    card.replaceChildren(...[h('h2', {}, 'Fingerprint sign-in'),
      d.grace ? passkeyGraceNotice(d.grace) : null,
      h('p', { class: 'small' }, 'Sign in, sign notes and approve with your fingerprint (or your device’s screen lock) instead of typing your password. It counts as two-step verification. SUDS never receives or stores your fingerprint: your device checks it, and SUDS keeps only a public key for the device.'),
      rows.length ? table([
        { label: 'Name', render: p => h('span', {}, p.name, here.includes(p.id) ? [' ', h('span', { 'data-passkey-here': '1' }, badge('This device', 'info'))] : null, p.synced ? [' ', badge('Synced', '')] : null, p.flagged ? [' ', badge('Disabled: possible copy', 'danger')] : null,
          // The authenticator allow-list (docs/FINGERPRINT.md): a passkey whose model the programme does not accept.
          p.accepted === false && !p.flagged ? [' ', h('span', { 'data-passkey-not-accepted': p.id }, badge('Not accepted: model not on your programme\'s list', 'danger'))] : null,
          // In the list's grace period (1.22.0): works until the date, then stops.
          p.stops_at && !p.flagged ? [' ', h('span', { 'data-passkey-stops': p.id }, badge(`Stops working on ${fmt.date(p.stops_at)}`, 'warn'))] : null) },
        { label: 'Added', render: p => fmt.date(p.created_at) },
        { label: 'Last used', render: p => (p.last_used_at ? fmt.dt(p.last_used_at) : 'never') },
        { label: '', srLabel: 'Actions', render: p => h('div', { class: 'row nowrap' },
          h('button', { class: 'btn sm', type: 'button', 'data-passkey-rename': p.id, 'aria-label': `Rename ${p.name}`, onClick: () => rename(p) }, 'Rename'),
          h('button', { class: 'btn sm danger', type: 'button', 'data-passkey-remove': p.id, 'aria-label': `Remove ${p.name}`, onClick: () => remove(p) }, 'Remove')) },
      ], rows) : h('p', { class: 'small muted', 'data-passkeys-none': '1' }, 'None yet.'),
      rows.length ? h('p', { class: 'small muted' }, '“This device” marks the ones added in this browser (it forgets if its data is cleared). “Synced” ones also work on your other devices signed in to the same account (iCloud Keychain, Google Password Manager).') : null,
      possible ? (rows.length < d.max ? h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', 'data-passkey-add-open': '1', onClick: add }, 'Add fingerprint sign-in on this device')) : h('p', { class: 'small muted' }, `You have ${d.max}, the most an account may have. Remove one to add another.`))
        : h('p', { class: 'small muted', 'data-passkeys-unavailable': '1' }, d.available ? 'This device or browser cannot do fingerprint sign-in (it needs a fingerprint reader, face recognition or a screen lock that the browser can use). You can add it from another device.' : (d.reason || 'Fingerprint sign-in cannot be used at this address.')),
      d.allowlist ? h('p', { class: 'small', 'data-passkeys-allowlist': '1' }, `Your programme accepts only these authenticator models: ${d.allowlist.models.join(', ') || 'none yet'}. A passkey kept in a password manager or synced between devices cannot prove its model and is refused; one not accepted stops working for sign-in and signing. Remove it and add one on an accepted authenticator.`) : null,
      approveBox,
      d.strong_required ? h('p', { class: 'small' }, 'Your programme asks for a fingerprint or an authenticator code (not the password alone) to sign notes and approve.') : null].filter(Boolean));
  };
  await draw();
  return card;
}

route('profile', async (r) => {
  const force = r.query.get('force') === '1'; const mfaPrompt = r.query.get('mfa') === '1';
  const u = state.user;
  const pw = form([{ name: 'current_password', label: 'Current password', type: 'password', required: true }, { name: 'new_password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', help: 'At least 12 characters with upper & lower case, a number and a symbol. Not your name or username, and not a common password.' }, { name: 'confirm', label: 'Confirm new password', type: 'password', required: true, autocomplete: 'new-password' }],
    { submitText: 'Change password', onSubmit: async (d) => { if (d.new_password !== d.confirm) throw new Error('Passwords do not match'); await post('/api/auth/password', { current_password: d.current_password, new_password: d.new_password }); toast('Password changed', 'ok'); await loadSession(); nav(force ? 'dashboard' : 'profile'); render(); } });
  const mfaBox = h('div', {});
  // Drawn from state.user each time: adding or removing fingerprint sign-in (below) changes what it says.
  const renderMfa = () => {
    const u = state.user;
    mfaBox.replaceChildren();
    if (u.mfa_enabled) mfaBox.append(...[badge('2-step verification is on', 'ok'), h('p', { class: 'small muted mt' }, 'Your account requires an authenticator code at sign-in.'), !u.mfa_required ? h('button', { class: 'btn sm danger', onClick: async () => { const f = form([{ name: 'password', label: 'Confirm password', type: 'password', required: true },
      // Both factors: a password on its own must not be able to remove the second one.
      { name: 'code', label: 'Code from your authenticator app', required: true, pattern: '[0-9]{6}', autocomplete: 'one-time-code', help: 'The 6-digit code the app shows now. If you have lost the app, ask an administrator to reset two-step verification for you.' }], { submitText: 'Turn off 2-step', onCancel: () => m.close(), onSubmit: async (d) => { await post('/api/auth/mfa/disable', d); m.close(); await loadSession(); render(); } }); const m = modal('Turn off 2-step verification', f); } }, 'Turn off 2-step') : null].filter(Boolean));
    else mfaBox.append(...[u.mfa_required && !u.passkey_mfa ? h('div', { class: 'banner warn', 'data-mfa-required-note': '1' }, u.mfa_setup_deadline ? `Your role requires two-step verification. Set it up by ${fmt.date(u.mfa_setup_deadline)} — after that SUDS will not let you in until it is done. Fingerprint sign-in (below) counts too.` : 'Your role requires two-step verification. Set it up now to keep using SUDS. Fingerprint sign-in (below) counts too.') : null,
      // Fingerprint sign-in lives on the device: without a second way, a lost or replaced phone means asking an
      // administrator to reset two-step verification. So an authenticator app is recommended beside it.
      u.passkey_mfa ? h('p', { class: 'small', 'data-mfa-by-passkey': '1' }, 'Your fingerprint sign-in counts as two-step verification. Add an authenticator app as well, so you can still sign in from a device without it, or if you lose that device.') : null,
      h('button', { class: `btn ${u.passkey_mfa ? '' : 'primary'}`, onClick: enroll }, u.passkey_mfa ? 'Add an authenticator app' : 'Set up 2-step verification')].filter(Boolean));
  };
  async function enroll() {
    const s = await post('/api/auth/mfa/setup', {});
    const f = form([{ name: 'code', label: 'Enter the 6-digit code from the app', required: true, pattern: '[0-9]{6}', autocomplete: 'one-time-code' }], { submitText: 'Turn on 2-step', onCancel: () => m.close(), onSubmit: async (d) => { await post('/api/auth/mfa/enable', d); toast('2-step verification is on', 'ok'); m.close(); await loadSession(); nav('dashboard'); render(); } });
    const m = modal('Set up 2-step verification', h('div', {}, h('p', {}, '1. Open Microsoft Authenticator, Google Authenticator, or another TOTP app.'), h('p', {}, '2. Scan this QR code, or add an account manually with the secret key:'), h('div', { class: 'center mb' }, qrSvg(s.otpauth, { size: 220 })), h('div', { class: 'qr' }, s.secret.match(/.{1,4}/g).join(' ')), h('p', { class: 'small muted' }, h('a', { href: s.otpauth }, 'Open in authenticator app (on this device)')), h('p', {}, '3. Enter the code shown by the app:'), f));
  }
  renderMfa();
  if (mfaPrompt && !u.mfa_enabled) setTimeout(enroll, 0);
  const passkeys = await passkeysCard({ onChange: renderMfa });
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
  // Start page (1.17.0): where SUDS opens after signing in. Street outreach suits a worker who spends the day in the field.
  const startSel = can('interventions:write') ? h('select', { id: 'start-page', 'data-start-page': '1', onChange: (e) => { prefs.set('start_page', e.target.value === 'outreach' ? 'outreach' : null); toast(e.target.value === 'outreach' ? 'SUDS will open on Street outreach when you sign in' : 'SUDS will open on Home when you sign in', 'ok'); } },
    h('option', { value: 'dashboard', selected: prefs.get('start_page', null) !== 'outreach' }, 'Home'), h('option', { value: 'outreach', selected: prefs.get('start_page', null) === 'outreach' }, 'Street outreach')) : null;
  const startCard = startSel ? h('div', { class: 'card', 'data-start-page-card': '1' }, h('h2', {}, 'Start page'),
    h('div', { class: 'field' }, h('label', { for: 'start-page' }, 'Open SUDS on'), startSel),
    h('p', { class: 'small muted mt' }, 'Street outreach is the one-screen logger for anonymous field contacts. The choice follows you to every device you sign in on.')) : null;
  return h('div', {}, pageHead('My profile'),
    force ? h('div', { class: 'banner warn' }, 'You must change your password before continuing.') : null,
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Account'), kv([['Name', u.display_name], ['Username', u.username], ['Role', fmt.label(u.role)], ['Title', u.title], ['Email', u.email], ['Caseload', u.caseload_restricted ? 'Assigned clients only' : 'All clients']]),
        h('p', { class: 'small mt' }, h('button', { class: 'btn sm', 'data-refresh-permissions': '1', onClick: async (e) => { e.target.disabled = true; await refreshPermissions(); toast('Permissions refreshed', 'ok'); } }, 'Refresh permissions'), ' ',
          h('span', { class: 'muted' }, 'If an administrator changed what you can do, pick it up without signing out.'))),
      h('div', { class: 'card' }, h('h2', {}, '2-step verification'), mfaBox),
      passkeys,
      h('div', { class: 'card' }, h('h2', {}, 'Change password'), pw),
      reminders,
      shortcuts,
      startCard,
      state.local ? null : h('div', { class: 'card' }, h('h2', {}, 'Use SUDS on your phone'), h('p', { class: 'small' }, 'On the office Wi-Fi open ', h('b', {}, location.origin.replace(/^https?:\/\//, '')), ' or scan this code, then add it to the home screen: ', h('b', {}, 'iPhone:'), ' Share → Add to Home Screen. ', h('b', {}, 'Android:'), ' ⋮ → Install app. Your clients, notes and reminders are the same on every device — nothing to set up.'), h('div', { class: 'center' }, qrSvg(location.origin + '/', { size: 160 }))),
      // The whole width of the grid (1.23.0): in one of three columns at a 1366 px laptop its five-column table ran
      // some 150 px past the card and had to be scrolled sideways. A phone still gets one card per session.
      h('div', { class: 'card', 'data-profile-sessions': '1', style: { gridColumn: '1 / -1' } }, h('div', { class: 'card-head' }, h('h2', {}, 'Active sessions'), sessions.sessions.length > 1 ? h('button', { class: 'btn sm', onClick: async () => { await post('/api/auth/sessions/revoke-others', {}); toast('Other sessions signed out', 'ok'); nav('profile?_=' + Date.now()); } }, 'Sign out other sessions') : null),
        table([{ label: 'Started', render: s => fmt.dt(s.created_at) }, { label: 'Last active', render: s => fmt.dt(s.last_seen_at) }, { label: 'IP', key: 'ip' }, { label: 'Device', render: s => h('span', { class: 'small muted' }, (s.user_agent || '').slice(0, 60)) }, { label: '', srLabel: 'Current session', render: s => s.current ? badge('This session', 'ok') : '' }], sessions.sessions))));
});

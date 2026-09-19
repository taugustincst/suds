import { h, route, get, post, state, form, toast, nav, render, loadSession, badge, fmt, pageHead, eraseDeviceButton, kv } from '../app.js';
import { sampleDataCard } from './admin.js';

// First run on a device: create the local account (no server needed)
route('localsetup', async () => {
  const f = form([
    { name: 'org_name', label: 'Program name (optional)', placeholder: 'e.g. Clark County SUD Navigation', span: true },
    { name: 'display_name', label: 'Your name', required: true }, { name: 'username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\\-]+', help: 'Use the same username as on the office SUDS if you have one.' },
    { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', help: '12+ characters with upper and lower case, a number and a symbol. Protects the data on this device.' }, { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
    // Asked for rather than assumed: a clinician set up as a navigator loses access to clinical notes,
    // including notes they wrote themselves, and only finds out when they try to open one.
    { name: 'role', label: 'Your role', type: 'select', noBlank: true, value: 'navigator', span: true,
      options: [
        { value: 'navigator', label: 'Navigator / peer support — outreach, referrals, case management' },
        { value: 'clinician', label: 'Clinician — everything a navigator does, plus clinical notes' },
        { value: 'supervisor', label: 'Supervisor — clinical notes, countersigning, approving time' },
        { value: 'admin', label: 'Administrator — settings and user accounts' },
      ],
      help: 'Use the same role you have on the office SUDS. This decides what you can open on this device.' },
  ], { submitText: 'Start using SUDS', onSubmit: async (d) => {
    if (d.password !== d.confirm) throw new Error('Passwords do not match'); delete d.confirm;
    await post('/api/local/setup', d);
    await post('/api/auth/login', { username: d.username, password: d.password });
    await loadSession(); nav('dashboard'); render();
  } });
  f.querySelectorAll('.form-grid').forEach(g => g.style.gridTemplateColumns = '1fr');
  return h('div', { class: 'login-wrap' }, h('div', { class: 'card login', style: { maxWidth: '520px' } },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'SUDS on this device'), h('small', {}, 'Works without the office computer'))),
    h('p', { class: 'small muted' }, 'Everything you record is stored encrypted on this device. Whenever you are near the office, tap Sync to exchange changes with the office SUDS — both directions.'), f));
});

// Sync screen (local mode)
route('sync', async () => {
  if (!state.local) { nav('dashboard'); return h('div'); }
  const st = await get('/api/local/sync/status');
  const disc = window.SudsNative && window.SudsNative.discover ? JSON.parse(window.SudsNative.discover() || 'null') : null;
  const serverGuess = st.server || disc || 'https://suds.local';
  const log = h('div', { class: 'small muted mt' });
  const f = form([
    { name: 'server', label: 'Office SUDS address', required: true, value: serverGuess, help: 'Usually https://suds.local on the office Wi-Fi. Shown under Settings → Network & devices on the office computer.', span: true },
    { name: 'username', label: 'Your office username', required: true, value: st.username || state.user.username },
    // A field literally named "password" next to a filled-in username is exactly the pattern browsers scan
    // for when deciding what to autofill — autocomplete="off" is routinely ignored for that pattern, so it
    // was quietly prefilled with the local sign-in credential (a different, unrelated password). A field
    // name the browser has no saved credential for, plus autocomplete="new-password" (which browsers do
    // still honor, unlike "off"), keeps this field empty until the person types into it themselves.
    { name: 'office_password', label: 'Office password', type: 'password', required: true, autocomplete: 'new-password', help: 'Your office SUDS account password — not the password you use to unlock this device.' },
    { name: 'code', label: 'MFA code (if your office account uses it)', placeholder: '123456' },
  ], { submitText: 'Sync now', onSubmit: async (d) => {
    log.textContent = 'Connecting…';
    try {
      const { office_password, ...rest } = d;
      const r = await post('/api/local/sync', { ...rest, password: office_password });
      const sum = (o) => Object.entries(o || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${fmt.label(k).toLowerCase()}`).join(', ') || 'nothing new';
      log.textContent = `Done ${fmt.dt(r.at)}. Received: ${sum(r.pulled)}. Sent: ${sum(r.pushed)}.${r.rejected.length ? ` ${r.rejected.length} item(s) were not accepted by the office (not on your caseload).` : ''}`;
      toast('Sync complete', 'ok'); await loadSession();
    } catch (e) {
      log.textContent = 'Sync failed: ' + e.message;
      // The device has already erased its local database (local/sync.js, before this error even reached
      // here) — show why, then start over exactly as a brand-new device would.
      if (e.data && e.data.wiped) { toast('This device was remotely wiped by an administrator', 'error'); setTimeout(() => location.reload(), 2500); return; }
      throw e;
    }
  } });
  window.addEventListener('suds-scan', (e) => { const v = String(e.detail || ''); if (v.startsWith('http')) { f.inputs.server.value = v.replace(/\/app\/?$/, '').replace(/\/$/, ''); toast('Office address filled in from QR code', 'ok'); } }, { once: true });
  const scanBtn = window.SudsNative && window.SudsNative.scanQr ? h('button', { class: 'btn sm', type: 'button', onClick: () => window.SudsNative.scanQr() }, 'Scan office QR code') : null;
  if (scanBtn) f.querySelector('.btn-row').prepend(scanBtn);
  // A plain browser has no Keystore or Keychain, so the local kernel keeps its encryption keys in this
  // profile's localStorage, beside the data they protect. Say so where someone is about to put real
  // client information into it, not only in the documentation.
  const protectedKeys = !!(window.SudsNative || window.__sudsSecrets);
  return h('div', {}, pageHead('Sync with the office'),
    protectedKeys ? null : h('div', { class: 'banner warn mb' }, h('b', {}, 'This is a browser copy, for trying SUDS out. '),
      'Its encryption keys are stored in this browser profile alongside the data, so anyone who can use this browser profile can read what is in it. Keep real client information on the phone app or the office computer — here, use sample data.'),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h3', {}, 'Status'), kv([['This device', badge('Local copy', 'info')], ['Data protection', protectedKeys ? (window.SudsNative ? 'Encrypted; keys in the Android Keystore' : 'Encrypted; keys in the iOS Keychain') : badge('Keys kept in this browser', 'warn')], ['Last sync', st.last_sync_at ? fmt.dt(st.last_sync_at) : 'never'], ['Changes waiting to send', String(st.pending)], ['Office server', st.server || 'not set yet']]),
        h('p', { class: 'small muted mt' }, 'Sync exchanges clients, visits, calls, notes, reminders, referrals and everything else in both directions. The newest change wins. The office computer does not need to be on at any other time.')),
      h('div', { class: 'card' }, h('h3', {}, 'Sync now'), h('p', { class: 'small muted' }, 'Connect this phone to the office Wi-Fi (or the address IT gave you), then sign in with your office account.'), f, log,
        h('div', { class: 'btn-row' }, eraseDeviceButton())),
      await sampleDataCard(() => nav('sync?_=' + Date.now()))));
});

import { h, route, get, post, state, form, toast, nav, render, loadSession, badge, fmt, pageHead, eraseDeviceButton, kv } from '../app.js';

// A column name as the person would say it: `first_name_enc` is "first name" (the suffix is how the
// database marks an encrypted column, not something a navigator should have to read past).
const column = (x) => fmt.label(String(x).replace(/_enc$/, '').replace(/_idx$/, '')).toLowerCase();
// The demo build served from a static host (scripts/build-static-site.js). It never syncs: see local/sync.js.
const isStaticHost = () => { try { return window.SUDS_STATIC_HOST === true; } catch { return false; } };
const STATIC_HOST_MESSAGE = 'Sync is not available from the demo site. Open SUDS at the office address instead; this copy is for trying SUDS out and never talks to an office server.';
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
  // The same warning the Sync page shows, but here -- before the first real name is typed in, not days
  // later on a page nobody has had a reason to open yet.
  const protectedKeys = !!(window.SudsNative || window.__sudsSecrets);
  return h('div', { class: 'login-wrap' }, h('div', { class: 'card login', style: { maxWidth: '520px' } },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'SUDS on this device'), h('small', {}, 'Offline copy — the office SUDS is the system of record'))),
    protectedKeys ? null : h('div', { class: 'banner warn mb', 'data-browser-copy-warning': '1' }, h('div', {}, h('b', {}, 'This is a browser copy, for trying SUDS out. '), 'Its encryption keys stay in this browser profile beside the data. Use sample data here; keep real client information on the office SUDS unless your administrator has approved this device for field work.')),
    h('p', { class: 'small muted' }, 'Everything you record is stored encrypted on this device. Whenever you are near the office, tap Sync to exchange changes with the office SUDS — both directions.'), f));
});

// Sync screen (local mode)
route('sync', async () => {
  if (!state.local) { nav('dashboard'); return h('div'); }
  const st = await get('/api/local/sync/status');
  const disc = window.SudsNative && window.SudsNative.discover ? JSON.parse(window.SudsNative.discover() || 'null') : null;
  const serverGuess = st.server || disc || 'https://suds.local';
  const log = h('div', { class: 'small muted mt', 'data-sync-log': '1' });
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
      // quiet: what comes back is about the *office* account (a wrong office password is a 401, an office
      // account that needs a code is a 401 too) and must not be read by api() as this device's own session
      // expiring or needing its own second factor.
      const r = await post('/api/local/sync', { ...rest, password: office_password }, { quiet: true });
      const sum = (o) => Object.entries(o || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${fmt.label(k).toLowerCase()}`).join(', ') || 'nothing new';
      const retrying = (r.rejected || []).filter(x => !(r.conflicts || []).some(c => c.table === x.table && c.id === x.id && c.reason));
      log.textContent = `Done ${fmt.dt(r.at)}. Received: ${sum(r.pulled)}. Sent: ${sum(r.pushed)}.${retrying.length ? ` ${retrying.length} item(s) could not be sent this time and will be retried.` : ''}${(r.skipped || []).length ? ` ${r.skipped.length} office record(s) could not be stored on this device (see the audit log).` : ''}`;
      // An edit made here that a newer office edit replaced is not a footnote: the person saw "saved".
      // Neither is a change the office refused for good: it is shown here, once, and then not sent again.
      const all = r.conflicts || [];
      const conflicts = all.filter(c => !c.reason);
      const refused = all.filter(c => c.reason && !c.warning);
      const warnings = all.filter(c => c.warning);
      const name = (c) => `${fmt.label(c.table).replace(/s$/, '')}${c.label ? ' ' + c.label : ''}`;
      if (conflicts.length) {
        const what = conflicts.slice(0, 5).map(c => `${name(c)} (${(c.columns || []).map(column).join(', ')})`).join('; ');
        log.append(h('div', { class: 'banner warn mt', role: 'alert', 'data-sync-conflicts': String(conflicts.length) }, h('div', {}, h('b', {}, `${conflicts.length} of your change${conflicts.length === 1 ? ' was' : 's were'} replaced by a newer edit made at the office: `), what, conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : '', '. The office version is what everyone now sees; re-enter anything from your version that still matters.')));
      }
      if (refused.length) {
        const why = (c) => c.reason === 'purged' ? 'the office has removed this record under its retention policy; it has been removed from this device too' : c.reason;
        const what = refused.slice(0, 5).map(c => `${name(c)}: ${why(c)}`).join('; ');
        log.append(h('div', { class: 'banner warn mt', role: 'alert', 'data-sync-refused': String(refused.length) }, h('div', {}, h('b', {}, `${refused.length} change${refused.length === 1 ? '' : 's'} made on this device ${refused.length === 1 ? 'was' : 'were'} not accepted by the office and will not be sent again: `), what, refused.length > 5 ? ` and ${refused.length - 5} more` : '', '. The office copy is what everyone now sees; if something still matters, ask a supervisor to enter it there.')));
      }
      if (warnings.length) log.append(h('div', { class: 'banner info mt', 'data-sync-warnings': String(warnings.length) }, h('div', {}, warnings.slice(0, 5).map(c => `${name(c)}: ${c.reason}`).join('; '))));
      // The office database was restored from a backup, so this device re-sent everything it holds.
      for (const n of r.notices || []) log.append(h('div', { class: 'banner info mt', 'data-sync-notice': '1' }, h('div', {}, n)));
      toast('Sync complete', 'ok'); await loadSession();
    } catch (e) {
      // The office account uses two-step verification and no code was given: ask for it here, on this
      // form, rather than treating it as an error (and never as this device's own MFA prompt).
      if (e.data && e.data.officeMfaRequired) {
        log.textContent = '';
        log.append(h('div', { class: 'banner info mt', role: 'alert', 'data-office-mfa': '1' }, h('div', {}, h('b', {}, 'Enter the code from your authenticator app'), ' for your office account, then tap Sync now again.')));
        try { f.inputs.code.focus(); } catch {}
        return;
      }
      log.textContent = 'Sync failed: ' + e.message;
      // The device has already erased its local database (local/sync.js, before this error even reached
      // here) — show why, then start over exactly as a brand-new device would. The erase resolved before
      // the error was thrown; the flush is a no-op after a wipe and is awaited so a save that was already
      // in flight cannot outlive the reload.
      if (e.data && e.data.wiped) { toast('This device was remotely wiped by an administrator', 'error'); setTimeout(async () => { try { await window.SUDS_LOCAL.flush(); } catch {} location.reload(); }, 1500); return; }
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
  // The demo site: no form at all, and nothing is ever sent. Honest, instead of a sync that always fails.
  const syncCard = isStaticHost()
    ? h('div', { class: 'card' }, h('h3', {}, 'Sync now'), h('div', { class: 'banner info', 'data-static-no-sync': '1' }, h('div', {}, STATIC_HOST_MESSAGE)), h('div', { class: 'btn-row mt' }, eraseDeviceButton()))
    : h('div', { class: 'card' }, h('h3', {}, 'Sync now'), h('p', { class: 'small muted' }, 'Connect this device to the office Wi-Fi (or the address IT gave you), then sign in with your office account.'), f, log,
        h('div', { class: 'btn-row' }, eraseDeviceButton()));
  return h('div', {}, pageHead('Sync with the office'),
    protectedKeys ? null : h('div', { class: 'banner warn mb' }, h('b', {}, 'This is a browser copy, for trying SUDS out. '),
      'Its encryption keys are stored in this browser profile alongside the data, so anyone who can use this browser profile can read what is in it. Keep real client information on the office SUDS unless your administrator has approved this device for field work — otherwise, use sample data.'),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h3', {}, 'Status'), kv([['This device', badge('Local copy', 'info')], ['Data protection', protectedKeys ? 'Encrypted; keys in protected device storage' : badge('Keys kept in this browser', 'warn')], ['Last sync', st.last_sync_at ? fmt.dt(st.last_sync_at) : 'never'], ['Changes waiting to send', String(st.pending)], ['Office server', st.server || 'not set yet']]),
        h('p', { class: 'small muted mt' }, 'Sync exchanges clients, visits, calls, notes, reminders, referrals and everything else in both directions. The office SUDS decides: the newest change wins, a change it rejects for good is not sent again, and a record the office has purged or merged does not come back.')),
      syncCard,
      await sampleDataCard(() => nav('sync?_=' + Date.now()))));
});

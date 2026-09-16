import { h, route, get, post, state, form, toast, nav, render, loadSession, badge, fmt, pageHead, modal, confirmDialog, kv } from '../app.js';
import { sampleDataCard } from './admin.js';

// First run on a device: create the local account (no server needed)
route('localsetup', async () => {
  const f = form([
    { name: 'org_name', label: 'Program name (optional)', placeholder: 'e.g. Clark County SUD Navigation', span: true },
    { name: 'display_name', label: 'Your name', required: true }, { name: 'username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\\-]+', help: 'Use the same username as on the office SUDS if you have one.' },
    { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', help: '12+ characters with upper and lower case, a number and a symbol. Protects the data on this device.' }, { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
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
    { name: 'username', label: 'Your office username', required: true, value: st.username || state.user.username }, { name: 'password', label: 'Office password', type: 'password', required: true },
    { name: 'code', label: 'MFA code (if your office account uses it)', placeholder: '123456' },
  ], { submitText: 'Sync now', onSubmit: async (d) => {
    log.textContent = 'Connecting…';
    try {
      const r = await post('/api/local/sync', d);
      const sum = (o) => Object.entries(o || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${fmt.label(k).toLowerCase()}`).join(', ') || 'nothing new';
      log.textContent = `Done ${fmt.dt(r.at)}. Received: ${sum(r.pulled)}. Sent: ${sum(r.pushed)}.${r.rejected.length ? ` ${r.rejected.length} item(s) were not accepted by the office (not on your caseload).` : ''}`;
      toast('Sync complete', 'ok'); await loadSession();
    } catch (e) { log.textContent = 'Sync failed: ' + e.message; throw e; }
  } });
  window.addEventListener('suds-scan', (e) => { const v = String(e.detail || ''); if (v.startsWith('http')) { f.inputs.server.value = v.replace(/\/app\/?$/, '').replace(/\/$/, ''); toast('Office address filled in from QR code', 'ok'); } }, { once: true });
  const scanBtn = window.SudsNative && window.SudsNative.scanQr ? h('button', { class: 'btn sm', type: 'button', onClick: () => window.SudsNative.scanQr() }, 'Scan office QR code') : null;
  if (scanBtn) f.querySelector('.btn-row').prepend(scanBtn);
  return h('div', {}, pageHead('Sync with the office'),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h3', {}, 'Status'), kv([['This device', badge('Local copy', 'info')], ['Last sync', st.last_sync_at ? fmt.dt(st.last_sync_at) : 'never'], ['Changes waiting to send', String(st.pending)], ['Office server', st.server || 'not set yet']]),
        h('p', { class: 'small muted mt' }, 'Sync exchanges clients, visits, calls, notes, reminders, referrals and everything else in both directions. The newest change wins. The office computer does not need to be on at any other time.')),
      h('div', { class: 'card' }, h('h3', {}, 'Sync now'), h('p', { class: 'small muted' }, 'Connect this phone to the office Wi-Fi (or the address IT gave you), then sign in with your office account.'), f, log,
        h('div', { class: 'btn-row' }, h('button', { class: 'btn danger sm', onClick: async () => { if (await confirmDialog('Erase this device', 'Remove all SUDS data from this device? Anything not yet synced will be lost.', { danger: true, okText: 'Erase', requireReason: true })) { await window.SUDS_LOCAL.wipe(); location.reload(); } } }, 'Erase data on this device'))),
      await sampleDataCard(() => nav('sync?_=' + Date.now()))));
});

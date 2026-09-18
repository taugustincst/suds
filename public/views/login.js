import { h, route, post, state, form, modal, nav, render, loadRefData, loadSession, toast } from '../app.js';

// A device with no office server behind it has no administrator to ask for a password reset — "ask your
// supervisor" is not an answer there. The only recovery this app can offer without the old password is to
// erase this device's local copy and start over, so that is offered directly, with a typed confirmation
// since it is irreversible and reachable by anyone with the device in hand, not just whoever is locked out.
function resetDeviceLink() {
  const openResetDialog = () => {
    let confirmBox;
    const m = modal('Reset this device', h('div', {},
      h('p', {}, 'This permanently erases everything SUDS has stored on this device — clients, visits, notes, everything — and signs out whatever account is set up here. There is no undo.'),
      h('p', { class: 'banner warn small' }, 'Anything recorded on this device that has not been synced to the office SUDS server is lost for good. If there is any chance the office server has a copy and you can reach it later, consider waiting instead.'),
      h('p', {}, 'Afterwards this device is treated as brand new: the first-run setup runs again and a new local account is created.'),
      h('div', { class: 'field' }, h('label', { for: 'reset-device-confirm' }, 'Type ERASE to confirm *'), confirmBox = h('input', { id: 'reset-device-confirm', autocomplete: 'off' })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn danger', onClick: async () => {
          if (confirmBox.value.trim() !== 'ERASE') { confirmBox.focus(); return; }
          await window.SUDS_LOCAL.wipe();
          location.reload();
        } }, 'Erase this device'))));
  };
  return h('p', { class: 'small muted center mt' },
    'Locked out or forgot your password? ',
    h('a', { href: '#', onClick: (e) => { e.preventDefault(); openResetDialog(); } }, 'Reset this device'),
    ' — this erases all SUDS data stored here and starts over.');
}

route('login', async () => {
  const f = form([
    { name: 'username', label: 'Username', required: true, autocomplete: 'username' },
    { name: 'password', label: 'Password', type: 'password', required: true },
  ], { submitText: 'Sign in', onSubmit: async (d) => {
    const r = await post('/api/auth/login', d);
    await loadSession();
    if (r.mfaPending) { nav('mfa'); }
    else if (r.mfaSetupRequired) { toast('Your role requires multi-factor authentication. Please enroll now.', 'error'); nav('profile?mfa=1'); }
    else nav('dashboard');
    render();
  } });
  f.querySelectorAll('.form-grid').forEach(g => g.style.gridTemplateColumns = '1fr');
  return h('div', { class: 'login-wrap' }, h('div', { class: 'card login' },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'SUDS'), h('small', {}, 'SUD Navigator Services Tracker'))),
    f,
    state.local && window.SUDS_LOCAL
      ? resetDeviceLink()
      : h('p', { class: 'small muted center mt' }, 'Forgot your password or locked out? Ask your supervisor or the SUDS administrator to reset it.'),
    h('p', { class: 'small muted center' }, 'Tip: on a phone, add SUDS to your home screen (Share → Add to Home Screen) to open it like an app.'),
    h('div', { class: 'small muted center mt' }, 'Contains protected health information (HIPAA, 42 CFR Part 2). Authorized staff only; all activity is logged.')));
});

route('mfa', async () => {
  const f = form([{ name: 'code', label: 'Authenticator code', required: true, placeholder: '123456', autocomplete: 'one-time-code', pattern: '[0-9]{6}' }], { submitText: 'Verify', onSubmit: async (d) => {
    await post('/api/auth/mfa/verify', d);
    state.mfaPending = false; await loadRefData(); nav('dashboard'); render();
  } });
  return h('div', { class: 'login-wrap' }, h('div', { class: 'card login' }, h('h2', {}, 'Two-factor verification'), h('p', { class: 'muted' }, 'Enter the 6-digit code from your authenticator app.'), f,
    h('p', { class: 'small center mt' }, h('a', { href: '#', onClick: async (e) => { e.preventDefault(); await post('/api/auth/logout', {}); state.user = null; state.mfaPending = false; nav('login'); render(); } }, 'Cancel and sign out'))));
});

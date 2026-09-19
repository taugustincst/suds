import { h, route, get, post, state, form, offerDeviceReset, nav, render, loadRefData, loadSession, toast } from '../app.js';

const OIDC_ERRORS = {
  provider_denied: 'The identity provider declined the sign-in.',
  exchange_failed: 'Could not complete single sign-on. Try again, or sign in with a username and password.',
  not_linked: 'This identity is not linked to a SUDS account here. Ask an administrator to link it under Users, or sign in with a username and password.',
  inactive: 'This account is not active. Contact a SUDS administrator.',
};

route('login', async (r) => {
  const f = form([
    { name: 'username', label: 'Username', required: true, autocomplete: 'username' },
    { name: 'password', label: 'Password', type: 'password', required: true },
  ], { submitText: 'Sign in', onSubmit: async (d) => {
    const r2 = await post('/api/auth/login', d);
    await loadSession();
    if (r2.mfaPending) { nav('mfa'); }
    else if (r2.mfaSetupRequired) { toast('Your role requires multi-factor authentication. Please enroll now.', 'error'); nav('profile?mfa=1'); }
    else nav('dashboard');
    render();
  } });
  f.querySelectorAll('.form-grid').forEach(g => g.style.gridTemplateColumns = '1fr');
  // Local (offline, on-device) mode has no route to an identity provider, so single sign-on is never
  // offered there — only the office server, where /api/auth/oidc/status can actually mean something.
  const oidc = state.local ? { enabled: false } : await get('/api/auth/oidc/status', { quiet: true }).catch(() => ({ enabled: false }));
  const oidcError = r.query.get('oidc_error');
  return h('div', { class: 'login-wrap' }, h('div', { class: 'card login' },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'SUDS'), h('small', {}, 'SUD Navigator Services Tracker'))),
    oidcError ? h('div', { class: 'banner danger', role: 'alert' }, OIDC_ERRORS[oidcError] || 'Single sign-on failed.') : null,
    oidc.enabled ? h('div', { class: 'btn-row mb' }, h('a', { class: 'btn primary', href: '/api/auth/oidc/start', style: { width: '100%', textAlign: 'center' } }, oidc.label)) : null,
    oidc.enabled ? h('div', { class: 'small muted center mb' }, '— or —') : null,
    f,
    // A device with no office server behind it has no administrator to ask for a password reset — "ask
    // your supervisor" is not an answer there, so it gets a self-service reset instead.
    state.local
      ? offerDeviceReset()
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

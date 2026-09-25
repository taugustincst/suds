import { h, route, get, post, state, form, offerDeviceReset, nav, render, loadRefData, loadSession, toast, clear, replaceHash, accessibilityLink } from '../app.js';
import { restoreBackupButton, requestPersistentStorage } from './local.js';

const OIDC_ERRORS = {
  provider_denied: 'The identity provider declined the sign-in.',
  exchange_failed: 'Could not complete single sign-on. Try again, or sign in with a username and password.',
  not_linked: 'This identity is not linked to a SUDS account here. Ask an administrator to link it under Users, or sign in with a username and password.',
  inactive: 'This account is not active. Contact a SUDS administrator.',
};

// What SUDS is, in one line, on the first screen anyone sees.
export const PURPOSE = 'Track services, referrals and follow-ups for people in substance-use-disorder care.';
// The published on-device web app (scripts/build-static-site.js): records live in this browser and nowhere
// else, and nothing is ever synced from it (local/sync.js). An internal marker for those differences only.
export const isStaticHost = () => { try { return window.SUDS_STATIC_HOST === true; } catch { return false; } };
const PASSWORD_HELP = '12+ characters with upper and lower case, a number and a symbol.';
// The account the optional "Try it with sample data" button creates on the on-device app. Shown on screen
// before it is used: the password is printed here, so it is for looking around, not for real records.
const SAMPLE_ACCOUNT = { username: 'sample', password: 'Sample-SUDS-2026', display_name: 'Sample User', role: 'admin', org_name: 'SUDS sample data' };

const brand = (subtitle) => h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('h1', { class: 'brand-title' }, state.local ? 'SUDS on this device' : 'SUDS'), h('small', {}, subtitle)));
const oneColumn = (f) => { f.querySelectorAll('.form-grid').forEach(g => { g.style.gridTemplateColumns = '1fr'; }); return f; };
const fieldError = (name, message) => { const e = new Error(message); e.labelled = true; e.data = { fields: { [name]: message } }; return e; };
async function signInAs(username, password) {
  await post('/api/auth/login', { username, password });
  await loadSession(); nav('dashboard'); render();
}

// ---------------------------------------------------------------------------------------------------------
// The sign-in page: two options, "Log in" and "Sign up", on the office server and on a device alike.
// Deep-linkable (#/login?mode=signup); a device with no account yet opens on Sign up, which is its first-run
// set-up. The two are a tab list (arrow keys move between them) switching one panel in place, and the
// address follows along without a reload, so a link to either option opens it.
// ---------------------------------------------------------------------------------------------------------
async function accountPage(r) {
  const status = state.local
    ? await get('/api/local/status', { quiet: true }).catch(() => ({ users: 1, signup_enabled: false }))
    : await get('/api/auth/signup/status', { quiet: true }).catch(() => ({ enabled: false }));
  const noAccount = state.local && status.users === 0;
  const asked = r.query.get('mode');
  let mode = asked === 'signup' || asked === 'login' ? asked : (noAccount || r.name === 'localsetup' ? 'signup' : 'login');
  const panel = h('div', { id: 'account-panel', role: 'tabpanel', 'data-account-mode': mode });
  const tabs = {};
  const select = async (m, { focus = false } = {}) => {
    mode = m; panel.dataset.accountMode = m;
    document.title = `${m === 'signup' ? 'Sign up' : 'Log in'} — ${state.local ? 'SUDS on this device' : 'SUDS'}`;
    for (const [k, b] of Object.entries(tabs)) { const on = k === m; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle('active', on); }
    panel.setAttribute('aria-labelledby', `account-tab-${m}`);
    const content = m === 'signup' ? await signupPanel(status, noAccount) : await loginPanel(r, noAccount);
    clear(panel).append(content);
    const q = new URLSearchParams(r.query); q.delete('_'); q.set('mode', m);
    replaceHash(`#/login?${q}`);
    if (focus) tabs[m].focus();
  };
  const tab = (m, label) => (tabs[m] = h('button', { type: 'button', role: 'tab', id: `account-tab-${m}`, 'aria-controls': 'account-panel', 'data-mode-tab': m, class: 'seg-btn',
    onClick: () => { if (mode !== m) select(m); },
    onKeydown: (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); select(m === 'login' ? 'signup' : 'login', { focus: true }); } } }, label));
  const tablist = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Log in or sign up' }, tab('login', 'Log in'), tab('signup', 'Sign up'));
  const contact = status.program_contact ? h('p', { class: 'small muted center', 'data-program-contact': '1' }, 'Program contact: ', status.program_contact) : null;
  // This browser has an on-device copy of SUDS. Someone landing here from a bookmark or an older
  // home-screen icon is most likely looking for that, not the office server.
  let localUsed = false; try { localUsed = !state.local && localStorage.getItem('suds.localUsed') === '1'; } catch {}
  const card = h('div', { class: 'card login' },
    brand(state.local ? (isStaticHost() ? 'Runs entirely in this browser' : 'Offline copy — the office SUDS is the system of record') : 'SUD Navigator Services Tracker'),
    h('p', { class: 'small muted', 'data-purpose': '1' }, PURPOSE),
    localUsed ? h('div', { class: 'banner info', 'data-local-hint': '1' }, h('div', {}, h('b', {}, 'Looking for your on-device copy? '), 'This is the office sign-in. Your clients recorded on this device are in ', h('a', { href: location.pathname + '?local=1' }, 'SUDS on this device'), '.')) : null,
    tablist, panel,
    h('p', { class: 'small muted center mt' }, 'Tip: on a phone, add SUDS to your home screen (Share → Add to Home Screen) to open it like an app. ', h('a', { href: 'get-app.html' }, 'Use SUDS on your phone or tablet')),
    contact,
    h('div', { class: 'small muted center mt' }, 'Contains protected health information (HIPAA, 42 CFR Part 2). Authorized staff only; all activity is logged.'));
  await select(mode);
  return h('main', { class: 'login-wrap', id: 'main', tabindex: '-1' }, card, accessibilityLink());
}

async function loginPanel(r, noAccount) {
  if (noAccount) {
    return h('div', { 'data-no-account': '1' },
      h('p', {}, 'There is no account on this device yet. Choose ', h('b', {}, 'Sign up'), ' to set SUDS up here, or put a backup back.'),
      h('div', { class: 'btn-row' }, restoreBackupButton()));
  }
  const f = oneColumn(form([
    { name: 'username', label: 'Username', required: true, autocomplete: 'username' },
    { name: 'password', label: 'Password', type: 'password', required: true },
  ], { submitText: 'Log in', onSubmit: async (d) => {
    const r2 = await post('/api/auth/login', d);
    await loadSession();
    if (r2.mfaPending) { nav('mfa'); }
    // Past the deadline the server refuses everything else anyway; inside it, the banner on every page says
    // when -- an error toast and a hijacked landing page every morning is not "advisory".
    else if (r2.mfaSetupRequired && (!r2.mfaSetupDeadline || Date.parse(r2.mfaSetupDeadline) < Date.now())) { toast('Two-step verification must be set up before you can continue.', 'error'); nav('profile?mfa=1'); }
    else nav('dashboard');
    render();
  } }));
  // Local (offline, on-device) mode has no route to an identity provider, so single sign-on is never
  // offered there — only the office server, where /api/auth/oidc/status can actually mean something.
  const oidc = state.local ? { enabled: false } : await get('/api/auth/oidc/status', { quiet: true }).catch(() => ({ enabled: false }));
  const oidcError = r.query.get('oidc_error');
  return h('div', {},
    oidcError ? h('div', { class: 'banner danger', role: 'alert' }, OIDC_ERRORS[oidcError] || 'Single sign-on failed.') : null,
    oidc.enabled ? h('div', { class: 'btn-row mb' }, h('a', { class: 'btn primary', href: '/api/auth/oidc/start', style: { width: '100%', textAlign: 'center' } }, oidc.label)) : null,
    oidc.enabled ? h('div', { class: 'small muted center mb' }, '— or —') : null,
    f,
    // A device with no office server behind it has no administrator to ask for a password reset — "ask
    // your supervisor" is not an answer there, so it gets a self-service reset instead.
    state.local
      ? offerDeviceReset()
      : h('p', { class: 'small muted center mt' }, 'Forgot your password or locked out? Ask your supervisor or the SUDS administrator to reset it.'));
}

async function signupPanel(status, noAccount) {
  if (!state.local) return officeSignup(status);
  if (noAccount) return firstRun();
  if (status.signup_enabled) return deviceSignup();
  return h('div', { class: 'banner info', 'data-signup-disabled': '1' }, h('div', {}, isStaticHost()
    ? 'Sign-ups are turned off on this device. Ask the person who manages it to create your account, or to turn sign-ups back on under This device.'
    : 'This device is already set up. Your account comes from the office SUDS: log in, or ask your administrator for an account.'));
}

// ---- office server: ask for an account; an administrator approves it ----
function officeSignup(status) {
  if (!status.enabled) {
    return h('div', { class: 'banner info', 'data-signup-disabled': '1' }, h('div', {}, h('b', {}, 'Ask your administrator for an account. '), 'Sign-up is not available on this SUDS server.'));
  }
  const out = h('div', {});
  const f = oneColumn(form([
    { name: 'display_name', label: 'Full name', required: true, autocomplete: 'name' },
    { name: 'username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\\-]+', autocomplete: 'username', help: 'Letters, numbers and . _ @ - only.' },
    { name: 'email', label: 'Email (optional)', type: 'email', autocomplete: 'email' },
    { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', help: PASSWORD_HELP },
    { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
    { name: 'reason', label: 'Your role, or why you need access', type: 'textarea', rows: 2, placeholder: 'e.g. Peer navigator, north county team', help: 'Up to 200 characters. Do not include client information.' },
  ], { submitText: 'Request access', onSubmit: async (d) => {
    if (d.password !== d.confirm) throw fieldError('confirm', 'Passwords do not match');
    delete d.confirm;
    const r = await post('/api/auth/signup', d);
    clear(out).append(h('div', { class: 'banner ok', role: 'status', 'data-signup-sent': '1' }, h('div', {}, h('b', {}, 'Request sent. '), r.message || 'An administrator will review it; you can log in once it is approved.')));
  } }));
  f.inputs.reason.maxLength = 200;
  out.append(h('p', { class: 'small muted' }, 'Ask for an account here. An administrator reviews each request and chooses your role; you can log in with the password you choose once it is approved.'), f);
  return out;
}

// ---- a device: the first account (its administrator), from the first-run set-up ----
function firstRun() {
  const stat = isStaticHost();
  const f = oneColumn(form([
    { name: 'org_name', label: 'Program name (optional)', placeholder: 'e.g. Clark County SUD Navigation', span: true },
    { name: 'display_name', label: 'Your name', required: true }, { name: 'username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\\-]+', help: stat ? 'You will use this to log in on this device.' : 'Use the same username as on the office SUDS if you have one.' },
    { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', help: `${PASSWORD_HELP} Protects the records on this device.` }, { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
    // Asked for rather than assumed: a clinician set up as a navigator loses access to clinical notes,
    // including notes they wrote themselves, and only finds out when they try to open one.
    { name: 'role', label: 'Your role', type: 'select', noBlank: true, value: 'navigator', span: true,
      options: [
        { value: 'navigator', label: 'Navigator / peer support — outreach, referrals, case management' },
        { value: 'clinician', label: 'Clinician — everything a navigator does, plus clinical notes' },
        { value: 'supervisor', label: 'Supervisor — clinical notes, countersigning, approving time' },
        { value: 'admin', label: 'Administrator — settings and user accounts' },
      ],
      help: stat ? 'This decides what you can open. You manage this device whichever you choose.' : 'Use the same role you have on the office SUDS. This decides what you can open on this device.' },
    stat ? { name: 'storage_ack', label: 'I understand that my records are kept only in this browser, and that I need to download backups to keep them safe.', type: 'checkbox', span: true } : null,
  ].filter(Boolean), { submitText: stat ? 'Create account' : 'Start using SUDS', onSubmit: async (d) => {
    if (d.password !== d.confirm) throw fieldError('confirm', 'Passwords do not match');
    if (stat && !d.storage_ack) throw fieldError('storage_ack', 'Tick the box to confirm you have read where your records are kept');
    delete d.confirm;
    await post('/api/local/signup', d);
    await requestPersistentStorage();
    await signInAs(d.username, d.password);
  } }));
  // Optional, and after the real thing: one tap from nothing to a set of fictional records to look around.
  let tryIt = null;
  if (stat) {
    const busyText = h('span', { class: 'small muted', role: 'status' });
    const btn = h('button', { type: 'button', class: 'btn', 'data-try-sample': '1', onClick: async () => {
      btn.disabled = true; busyText.textContent = 'Setting up…';
      try {
        await post('/api/local/signup', { ...SAMPLE_ACCOUNT, storage_ack: true });
        await post('/api/auth/login', { username: SAMPLE_ACCOUNT.username, password: SAMPLE_ACCOUNT.password });
        await loadSession();
        busyText.textContent = 'Adding sample data…';
        const r = await post('/api/local/demo', {});
        toast(`Ready: ${r.counts.clients} fictional clients to explore`, 'ok');
        await loadSession(); nav('dashboard'); render();
      } catch (e) { btn.disabled = false; busyText.textContent = ''; toast(e.message || 'Could not set up the sample data', 'error'); }
    } }, 'Try it with sample data');
    tryIt = h('details', { class: 'mt', 'data-try-it': '1' }, h('summary', { class: 'small' }, 'Just looking around? Try SUDS with sample data'),
      h('p', { class: 'small muted' }, `Creates an account called “${SAMPLE_ACCOUNT.username}” (password “${SAMPLE_ACCOUNT.password}”) with a set of fictional clients, visits, notes and referrals. Use it to look around, not for real records: to start for real, erase this device and sign up.`),
      h('div', { class: 'row' }, btn, busyText));
  }
  // Where the records are, said once, here — before the first real name is typed in, and confirmed with the
  // checkbox above. A browser has no Keystore or Keychain, so the kernel keeps its keys in this profile's
  // localStorage (local/shims/config.js), beside the data.
  const notice = stat
    ? h('div', { class: 'banner info mb', 'data-storage-notice': '1' }, h('div', {}, h('b', {}, 'Where your records are kept. '),
      'Everything you record is stored encrypted in this browser on this device, and nowhere else. The keys that unlock it are kept in the same browser. ',
      'If this browser’s site data is cleared, or the device is lost or replaced, the records are gone for good unless you have a backup — download one regularly from ', h('b', {}, 'This device'), '.'))
    : h('div', {},
      h('div', { class: 'banner warn mb', 'data-browser-copy-warning': '1' }, h('div', {}, h('b', {}, 'This is an offline copy of the office SUDS. '), 'Its encryption keys stay in this browser profile beside the data. Keep real client information on the office SUDS unless your administrator has approved this device for field work.')),
      h('p', { class: 'small muted' }, 'Everything you record is stored encrypted on this device. Whenever you are near the office, tap Sync to exchange changes with the office SUDS — both directions.'));
  return h('div', { 'data-first-run': '1' },
    h('p', { class: 'small' }, stat ? 'Create the first account on this device. You will manage it: backups, and whether other people may sign up here.' : 'Set up SUDS on this device.'),
    notice, f, tryIt,
    h('p', { class: 'small muted center mt' }, 'Have a backup from this or another device? ', restoreBackupButton({ link: true })));
}

// ---- the on-device app, after its first account: another person on the same device ----
function deviceSignup() {
  const f = oneColumn(form([
    { name: 'display_name', label: 'Your name', required: true },
    { name: 'username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\\-]+' },
    { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', help: PASSWORD_HELP },
    { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
  ], { submitText: 'Create account', onSubmit: async (d) => {
    if (d.password !== d.confirm) throw fieldError('confirm', 'Passwords do not match');
    delete d.confirm;
    await post('/api/local/signup', d);
    await signInAs(d.username, d.password);
  } }));
  return h('div', { 'data-device-signup': '1' },
    h('p', { class: 'small muted' }, 'Create your own account on this device. You will see the clients you record or are assigned to — not other people’s. Records stay in this browser.'), f);
}

route('login', accountPage);
// The first-run address older links and home-screen icons use: the same page, on Sign up.
route('localsetup', accountPage);

route('mfa', async () => {
  const f = form([{ name: 'code', label: 'Authenticator code', required: true, placeholder: '123456', autocomplete: 'one-time-code', pattern: '[0-9]{6}' }], { submitText: 'Verify', onSubmit: async (d) => {
    await post('/api/auth/mfa/verify', d);
    state.mfaPending = false; await loadRefData(); nav('dashboard'); render();
  } });
  return h('main', { class: 'login-wrap', id: 'main', tabindex: '-1' }, h('div', { class: 'card login' }, h('h1', {}, 'Two-factor verification'), h('p', { class: 'muted' }, 'Enter the 6-digit code from your authenticator app.'), f,
    h('p', { class: 'small center mt' }, h('a', { href: '#', onClick: async (e) => { e.preventDefault(); await post('/api/auth/logout', {}); state.user = null; state.mfaPending = false; nav('login'); render(); } }, 'Cancel and sign out'))));
});

import { h, route, get, post, state, form, toast, nav, render, loadSession, badge } from '../app.js';
import { qrSvg } from '../qr.js';

route('setup', async () => {
  const status = await get('/api/setup/status', { quiet: true });
  if (!status.needed) { nav('login'); return h('div'); }
  const done = h('div', { class: 'hidden' });
  const f = form([
    { type: 'section', label: 'Your program' },
    { name: 'org_name', label: 'Program name', required: true, placeholder: 'e.g. Clark County SUD Navigation Program', span: true },
    { name: 'county_name', label: 'County' }, { name: 'program_contact', label: 'Privacy officer / program contact' },
    { type: 'section', label: 'Administrator account (you)' },
    { name: 'admin_display_name', label: 'Your name', required: true }, { name: 'admin_username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\\-]+', placeholder: 'e.g. jsmith' },
    { name: 'admin_password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', help: '12+ characters with upper and lower case, a number and a symbol.' }, { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
    { type: 'section', label: 'Who can reach SUDS' },
    { name: 'network', label: 'Access', type: 'select', noBlank: true, required: true, value: 'lan', options: [{ value: 'lan', label: 'Phones, tablets and other computers on the office network (recommended for mobile use)' }, { value: 'local', label: 'Only this computer' }], span: true },
    { name: 'https', label: 'Encrypt connections (HTTPS) — recommended, created automatically', type: 'checkbox', value: true, span: true },
    { type: 'section', label: 'Advanced (usually not needed)', collapsible: true },
    // With PORT set in the environment the port is IT's decision (Settings → Network & devices says the same
    // afterwards), so the wizard does not offer a field it would then ignore.
    status.port_env ? null : { name: 'port', label: 'Port', type: 'number', min: 1, max: 65535, step: 1, help: 'Leave blank: SUDS picks the standard port so the address needs no number.' },
    { name: 'extra_hosts', label: 'Extra names for the certificate', placeholder: 'e.g. suds.county.local', help: 'Only if IT gives this computer a name.' },
  ].filter(Boolean), { submitText: 'Finish setup', onSubmit: async (d) => {
    if (d.admin_password !== d.confirm) throw new Error('Passwords do not match');
    if (d.network === 'lan' && !d.https) throw new Error('HTTPS is required when other devices can connect');
    delete d.confirm;
    const r = await post('/api/setup/complete', d);
    f.classList.add('hidden'); done.classList.remove('hidden');
    const L = r.listener;
    // suds.local depends on mDNS, which Windows PCs without Bonjour and Android browsers do not have; the
    // numeric address always works, so that is where this page sends the browser and what the QR carries.
    const byIp = L.urls.find(u => /\/\/\d{1,3}(\.\d{1,3}){3}/.test(u));
    const primary = byIp || L.urls.find(u => !/localhost/.test(u)) || L.urls[0];
    const lan = d.network === 'lan';
    done.append(h('div', { class: 'banner' }, h('b', {}, 'Setup complete. '), 'SUDS is now running at the address below. This page will take you there in a moment.'),
      h('div', { class: 'grid cols-2' },
        h('div', {}, h('h3', {}, 'Open SUDS at'), h('p', {}, h('a', { href: primary, style: { fontSize: '1.2rem', fontWeight: 700 } }, primary), h('div', { class: 'small muted' }, lan ? 'on any phone or computer on the office Wi-Fi' : 'on this computer')), L.friendly && lan ? h('p', { class: 'small' }, 'Also ', h('a', { href: L.friendly }, L.friendly), ' on computers and iPhones that understand that name (not Android browsers).') : null, h('details', {}, h('summary', { class: 'small muted' }, 'Other addresses'), h('ul', {}, L.urls.map(u => h('li', {}, h('a', { href: u }, u))))), L.tls ? h('p', { class: 'small muted' }, 'The first time, browsers warn that the certificate is self-signed. Tap "Advanced → Proceed" once per device.') : null),
        lan ? h('div', { class: 'center' }, h('h3', {}, 'Scan with a phone'), qrSvg(primary, { size: 180 }), h('div', { class: 'small muted' }, primary)) : h('div', { class: 'small muted' }, 'Only this computer can reach SUDS. To let phones in later, change that under Settings → Network & devices.')),
      r.keys_file ? h('div', { class: 'banner danger mt' }, h('b', {}, 'Back up your encryption keys now. '), `They were generated for you and saved to ${r.keys_file}. Sign in, open Administration → System → "Download key backup" and store the file somewhere separate from this computer (e.g. the county password manager). Without the keys, database backups cannot be read.`) : null,
      h('div', { class: 'btn-row' }, h('a', { class: 'btn primary', href: primary + '#/login' }, 'Go to sign-in')));
    setTimeout(() => { location.href = primary + '#/login'; }, 8000);
  } });
  return h('div', { class: 'login-wrap' }, h('div', { class: 'card', style: { maxWidth: '760px', width: '100%' } },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'Welcome to SUDS'), h('small', {}, 'First-run setup — about 2 minutes'))),
    h('p', { class: 'muted' }, `Three quick questions and SUDS is ready on this computer and on staff phones. (Running on ${status.hostname}; setup can only be completed from this computer.)`),
    status.port_env ? h('p', { class: 'small muted', 'data-port-env': '1' }, `The port (${status.listener?.port}) is set by the PORT environment variable on this server, so it is not asked here.`) : null, f, done));
});

import { h, route, get, post, state, form, toast, nav, render, loadSession, badge } from '../app.js';
import { qrSvg } from '../qr.js';

// The offline-copy question's advice for each programme profile.
const OFFLINE_TRADEOFF = 'The copy is encrypted under each person\'s own password: if they forget it, anything on that device that has not been synced yet cannot be recovered, so staff should sync often. IT can change this later with LOCAL_MODE_ENABLED.' +
  // What a copy holds (1.16.0 defaults): said here, where the choice is made, as the IT guide says it.
  ' A copy holds every record its user may see: with the default roles, navigators and clinicians see every client, so each device holds the whole program\'s records, clinical notes included. To keep a device to one caseload, deny that person "See every client" (Settings → Users & permissions) before their device first syncs.';
const OFFLINE = {
  harm_reduction: { value: 'yes', label: 'Allow staff to keep an offline copy on their devices? Recommended: Yes',
    options: [{ value: 'yes', label: 'Yes — outreach staff may keep an encrypted offline copy in their browser and sync it later (recommended for field work)' }, { value: 'no', label: 'No — staff use SUDS only while connected to this server' }],
    help: `Outreach happens where there is no signal: an offline copy lets staff record visits and supplies there and sync when back in range. ${OFFLINE_TRADEOFF}` },
  treatment: { value: 'no', label: 'Allow staff to keep an offline copy on their devices? Recommended: No',
    options: [{ value: 'no', label: 'No — staff use SUDS while connected to this server (recommended)' }, { value: 'yes', label: 'Yes — navigators may keep an encrypted offline copy in their browser and sync it later' }],
    help: `Only say Yes for a documented field-work need, on county-managed devices with a passcode and remote wipe. ${OFFLINE_TRADEOFF}` },
};

route('setup', async () => {
  const status = await get('/api/setup/status', { quiet: true });
  // Setup is done (here, or in another tab): the app must stop thinking it is needed, or its router sends
  // #/login straight back to #/setup, which sends it to #/login again — a loop of status requests that had
  // the server refusing everything from this computer (429) for a minute. scripts/ui/setup-same-origin.mjs.
  if (!status.needed) { state.setupNeeded = false; nav('login'); return h('div'); }
  const done = h('div', { class: 'hidden' });
  const fundOpts = status.fund_options || null;
  const f = form([
    { type: 'section', label: 'Your program' },
    { name: 'org_name', label: 'Program name', required: true, placeholder: 'e.g. Clark County SUD Navigation Program', span: true },
    { name: 'county_name', label: 'County' }, { name: 'program_contact', label: 'Privacy officer / program contact' },
    // The programme profile (server/programme.js): what the screens lead with. Harm reduction is the default;
    // Settings › Programme changes it, and switches single clinical modules on, at any time.
    { name: 'programme_profile', label: 'What kind of program is this?', type: 'select', noBlank: true, required: true, value: 'harm_reduction', span: true,
      options: [{ value: 'harm_reduction', label: 'Harm reduction & outreach — outreach, visits, supplies, referrals and grant reporting (recommended)' }, { value: 'treatment', label: 'Treatment-adjacent — adds care plans, assessments (ASAM), CalOMS Tx, the FHIR API and the county EHR hand-off' }, { value: 'part2_layer', label: 'Part 2 compliance module beside your EHR — consents, disclosures, notices, breaches and patient requests; the EHR stays the clinical record' }],
      help: 'Changes only what the screens show. You can switch any clinical module on later in Settings › Program.' },
    // Minimal personal information (1.21.0): offered to a harm-reduction or syringe services programme only (shown
    // while that profile is chosen); off unless answered Yes, as it is everywhere else. Settings › Program changes it.
    { name: 'participant_code_default', label: 'Should outreach records use a participant code instead of a name by default?', type: 'select', noBlank: true, value: 'no', span: true,
      options: [{ value: 'no', label: 'No — new clients start with their name (you can change this later)' }, { value: 'yes', label: 'Yes — new clients and outreach contacts start with a participant code; a name is an extra step' }],
      help: 'For a syringe services program whose participants often give no name. A client known only by a code is counted like any other client. Change it any time in Settings › Program › Minimal personal information.' },
    // Optional: the fund most of the work is charged to. Created for this fiscal year (July–June) and made the
    // default for new visits, so they are not all "No funding source" until someone finds Settings.
    { name: 'main_fund_name', label: 'Main funding source (optional)', placeholder: 'e.g. County opioid settlement allocation', span: true, maxLen: 200,
      help: 'New visits are charged to it unless the worker chooses another. Add its amount, grant number and dates, and any other funds, under Budget; change the default in Settings › Program › Reporting.' },
    // What kind of money it is: opioid settlement money is what the settlement report lists, by the allowable
    // use the fund pays for (the same questions Funding & spending asks). A fund the wizard created used to be
    // "other" whatever its name said, and the settlement report had nothing in it.
    fundOpts ? { name: 'main_fund_type', label: 'What kind of funding is it?', type: 'select', placeholder: '— choose —', options: fundOpts.types, span: true,
      help: 'Opioid settlement money is listed in the opioid settlement report by what it pays for.' } : null,
    fundOpts ? { name: 'main_fund_settlement_use', label: 'Opioid settlement allowable use (Exhibit E)', type: 'select', placeholder: '— choose later under Funding & spending —', options: fundOpts.settlement_uses, span: true } : null,
    fundOpts ? { name: 'main_fund_settlement_hiaa', label: 'California High Impact Abatement Activity', type: 'select', placeholder: '— not recorded —', options: fundOpts.settlement_hiaa, span: true,
      help: 'Check the category against the agreement that governs the fund. Both can be changed later under Funding & spending.' } : null,
    { type: 'section', label: 'Administrator account (you)' },
    { name: 'admin_display_name', label: 'Your name', required: true }, { name: 'admin_username', label: 'Username', required: true, pattern: '[a-zA-Z0-9._@\\-]+', value: 'guest', help: 'The first administrator is called guest unless you choose another name. You set its password below.' },
    { name: 'admin_password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', help: '12+ characters with upper and lower case, a number and a symbol. Not your name or username, and not a common password.' }, { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
    { type: 'section', label: 'Who can reach SUDS' },
    { name: 'network', label: 'Access', type: 'select', noBlank: true, required: true, value: 'lan', options: [{ value: 'lan', label: 'Phones, tablets and other computers on the office network (recommended for mobile use)' }, { value: 'local', label: 'Only this computer' }], span: true },
    { name: 'https', label: 'Encrypt connections (HTTPS) — recommended, created automatically', type: 'checkbox', value: true, span: true },
    // The web app on this server is the system of record (docs/PLATFORM.md). An offline copy keeps an encrypted
    // caseload in a browser, sealed under each person's password (docs/architecture/ADR-0008-device-encryption.md).
    // Field outreach works where there is no signal, so a harm-reduction programme is advised to allow it; a
    // treatment-adjacent one keeps the stricter "No". The advice follows the profile chosen above until the
    // answer is changed by hand. With LOCAL_MODE_ENABLED set on the server the environment decides, and the
    // page says so instead. Left unanswered (an API call without it), the server keeps it off.
    status.local_mode_env ? null : { type: 'section', label: 'Working offline' },
    status.local_mode_env ? null : { name: 'local_mode', label: OFFLINE.harm_reduction.label, type: 'select', noBlank: true, required: true, value: OFFLINE.harm_reduction.value, span: true,
        options: OFFLINE.harm_reduction.options, help: OFFLINE.harm_reduction.help },
    { type: 'section', label: 'Advanced (usually not needed)', collapsible: true },
    // With PORT set in the environment the port is IT's decision (Settings → Network & devices says the same
    // afterwards), so the wizard does not offer a field it would then ignore.
    status.port_env ? null : { name: 'port', label: 'Port', type: 'number', min: 1, max: 65535, step: 1, help: 'Leave blank: SUDS picks the standard port so the address needs no number.' },
    { name: 'extra_hosts', label: 'Extra names for the certificate', placeholder: 'e.g. suds.county.local', help: 'Only if IT gives this computer a name.' },
  ].filter(Boolean), { submitText: 'Finish setup', onSubmit: async (d) => {
    if (d.admin_password !== d.confirm) throw new Error('Passwords do not match');
    if (d.network === 'lan' && !d.https) throw new Error('HTTPS is required when other devices can connect');
    delete d.confirm;
    if ('local_mode' in d) d.local_mode = d.local_mode === 'yes';
    // Answered only for a harm-reduction programme; any other profile leaves it off.
    d.participant_code_default = d.programme_profile === 'harm_reduction' && d.participant_code_default === 'yes';
    // The fund's type and settlement category go only with a fund, and the category only with settlement money.
    if (!d.main_fund_name) { delete d.main_fund_type; delete d.main_fund_settlement_use; delete d.main_fund_settlement_hiaa; }
    else if (d.main_fund_type !== 'opioid_settlement') { delete d.main_fund_settlement_use; delete d.main_fund_settlement_hiaa; }
    for (const k of ['main_fund_type', 'main_fund_settlement_use', 'main_fund_settlement_hiaa']) if (d[k] === '') delete d[k];
    const r = await post('/api/setup/complete', d);
    state.setupNeeded = false; // "Go to sign-in" may be the same page with only a new #hash
    f.classList.add('hidden'); done.classList.remove('hidden');
    const L = r.listener;
    // suds.local depends on mDNS, which Windows PCs without Bonjour and Android browsers do not have; the
    // numeric address always works, so that is where this page sends the browser and what the QR carries.
    const byIp = L.urls.find(u => /\/\/\d{1,3}(\.\d{1,3}){3}/.test(u));
    const primary = byIp || L.urls.find(u => !/localhost/.test(u)) || L.urls[0];
    const lan = d.network === 'lan';
    done.append(...[h('div', { class: 'banner' }, h('b', {}, 'Setup complete. '), 'SUDS is now running at the address below. This page will take you there in a moment.'),
      h('div', { class: 'grid cols-2' },
        h('div', {}, h('h2', {}, 'Open SUDS at'), h('p', {}, h('a', { href: primary, style: { fontSize: '1.2rem', fontWeight: 700 } }, primary), h('div', { class: 'small muted' }, lan ? 'on any phone or computer on the office Wi-Fi' : 'on this computer')), L.friendly && lan ? h('p', { class: 'small' }, 'Also ', h('a', { href: L.friendly }, L.friendly), ' on computers and iPhones that understand that name (not Android browsers).') : null, h('details', {}, h('summary', { class: 'small muted' }, 'Other addresses'), h('ul', {}, L.urls.map(u => h('li', {}, h('a', { href: u }, u))))), L.tls ? h('p', { class: 'small muted' }, 'The first time, browsers warn that the certificate is self-signed. Tap "Advanced → Proceed" once per device.') : null),
        lan ? h('div', { class: 'center' }, h('h2', {}, 'Scan with a phone'), qrSvg(primary, { size: 180 }), h('div', { class: 'small muted' }, primary)) : h('div', { class: 'small muted' }, 'Only this computer can reach SUDS. To let phones in later, change that under Settings → Network & devices.')),
      r.keys_file ? h('div', { class: 'banner danger mt' }, h('b', {}, 'Back up your encryption keys now. '), `They were generated for you and saved to ${r.keys_file}. Sign in, open Settings → System & backups → "Download key backup (keep secret)" and store the file somewhere separate from this computer (e.g. the county password manager). Without the keys, database backups cannot be read.`) : null,
      h('div', { class: 'btn-row' }, h('a', { class: 'btn primary', href: primary + '#/login' }, 'Go to sign-in'))].filter(Boolean));
    setTimeout(() => { location.href = primary + '#/login'; }, 8000);
  } });
  // The offline-copy advice follows the programme profile until someone answers the question themselves.
  const profileSel = f.querySelector('select[name=programme_profile]'); const offlineSel = f.querySelector('select[name=local_mode]');
  // The participant-code question is for a harm-reduction programme only (1.21.0).
  const codeWrap = f.querySelector('[data-field="participant_code_default"]');
  const syncCodeQuestion = () => { if (codeWrap && profileSel) codeWrap.hidden = profileSel.value !== 'harm_reduction'; };
  if (profileSel) profileSel.addEventListener('change', syncCodeQuestion);
  syncCodeQuestion();
  if (profileSel && offlineSel) {
    let touched = false;
    offlineSel.addEventListener('change', () => { touched = true; });
    profileSel.addEventListener('change', () => {
      const a = OFFLINE[profileSel.value] || OFFLINE.harm_reduction;
      const field = offlineSel.closest('.field');
      const lbl = field && field.querySelector(':scope > label'); if (lbl) lbl.textContent = `${a.label} *`;
      const help = field && field.querySelector(':scope > .help'); if (help) help.textContent = a.help;
      const current = offlineSel.value;
      offlineSel.replaceChildren(...a.options.map(o => h('option', { value: o.value }, o.label)));
      offlineSel.value = touched ? current : a.value;
      offlineSel.dataset.recommended = a.value;
    });
  }
  if (offlineSel) offlineSel.dataset.recommended = OFFLINE.harm_reduction.value;
  // The username's help explains the "guest" default; once another name is typed it has nothing left to say.
  const userIn = f.querySelector('input[name=admin_username]'); const userHelp = userIn && userIn.closest('.field')?.querySelector(':scope > .help');
  if (userIn && userHelp) { const sync = () => { userHelp.hidden = userIn.value.trim().toLowerCase() !== 'guest'; }; userIn.addEventListener('input', sync); sync(); }
  // The settlement questions show only for opioid settlement money. A fund named as settlement money
  // ("County opioid settlement allocation") is taken to be that, until someone chooses the type themselves.
  const fundName = f.querySelector('input[name=main_fund_name]'); const fundType = f.querySelector('select[name=main_fund_type]');
  if (fundName && fundType) {
    let typeTouched = false;
    const settlementFields = ['main_fund_settlement_use', 'main_fund_settlement_hiaa'].map(n => f.querySelector(`[name=${n}]`)?.closest('.field')).filter(Boolean);
    const sync = () => { const on = fundType.value === 'opioid_settlement'; for (const el of settlementFields) el.classList.toggle('hidden', !on); };
    fundType.addEventListener('change', () => { typeTouched = true; sync(); });
    fundName.addEventListener('input', () => { if (!typeTouched && /settlement/i.test(fundName.value)) { fundType.value = 'opioid_settlement'; sync(); } });
    sync();
  }
  return h('main', { class: 'login-wrap', id: 'main', tabindex: '-1' }, h('div', { class: 'card', style: { maxWidth: '760px', width: '100%' } },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('h1', { class: 'brand-title' }, 'Welcome to SUDS'), h('small', {}, 'First-run setup — about 2 minutes'))),
    h('p', { class: 'muted' }, `A few quick questions and SUDS is ready on this computer and on staff phones. (Running on ${status.hostname}; setup can only be completed from this computer.)`),
    status.local_mode_env ? h('p', { class: 'small muted', 'data-local-mode-env': '1' }, `Offline copies on staff devices are ${status.local_mode ? 'allowed' : 'not allowed'} by the LOCAL_MODE_ENABLED setting on this server, so that is not asked here.`) : null,
    status.port_env ? h('p', { class: 'small muted', 'data-port-env': '1' }, `The port (${status.listener?.port}) is set by the PORT environment variable on this server, so it is not asked here.`) : null, f, done));
});

// Settings › All settings (1.27.0): every setting on the Settings pages in one list, grouped by what it is for, each
// with what it is set to now and a link that opens its tab, scrolls to it and marks it (settings-nav.js). A box at the
// top narrows the list as you type. The Server configuration entries come from the server's own list
// (/api/admin/server-config), so a setting added there appears here without a change to this file; the rest are
// listed below by the `name` of their form field or the `data-setting` of their card, and the browser suite follows
// every link and checks it lands on something.
import { h, get, can, moduleOn } from '../app.js';
import { settingHref } from './settings-nav.js';

const yes = (v) => (v === '1' ? 'On' : v === '0' ? 'Off' : null);
const n = (v, unit) => (v === null || v === undefined || v === '' ? null : `${v}${unit ? ` ${unit}` : ''}`);

// [group, label, tab, target, value(s) => text | null, words]
function catalogue(s) {
  const p = s.policy || {};
  const prog = s.programme || {};
  return [
    ['Your program', 'Organization / program name', 'settings', 'org_name', () => s.org_name],
    ['Your program', 'County', 'settings', 'county_name', () => s.county_name],
    ['Your program', 'Privacy officer / program contact', 'settings', 'program_contact', () => s.program_contact],
    ['Your program', 'Time zone', 'settings', 'org_timezone', () => (s.timezone ? `${s.timezone.effective}${s.org_timezone ? '' : ' (not chosen: the server\'s)'}` : null), 'timezone clock date'],
    ['Your program', 'What kind of program this is, and its modules', 'settings', 'programme_profile', () => ((prog.profiles || []).find(x => x.value === prog.profile) || {}).label || prog.profile || null, 'profile modules clinical calOMS fhir care plan assessments'],
    ['Your program', 'Caseload restriction', 'settings', 'caseload_restriction', () => (s.caseload_restriction === '0' ? 'Off' : 'On')],
    ['Your program', 'Days before unsigned drafts are flagged', 'settings', 'note_lock_days', () => n(s.note_lock_days, 'days')],
    ['Your program', 'Screening instruments (PHQ-9, GAD-7, DAST-10…)', 'settings', 'screening-instruments', null, 'dast audit instruments licence'],
    ['Your program', 'Lists on forms (visit types, outcomes, supplies, funds)', 'lists', null, null, 'options dropdowns choices'],

    ['Sign-in and security', 'Auto sign-out after inactivity', 'settings', 'session_idle_minutes', () => n(p.idleMinutes, 'minutes'), 'timeout session idle'],
    ['Sign-in and security', 'Maximum session length', 'settings', 'session_absolute_hours', () => n(p.absoluteHours, 'hours')],
    ['Sign-in and security', 'Password expiry', 'settings', 'password_max_age_days', () => n(p.passwordMaxAgeDays, 'days')],
    ['Sign-in and security', 'Sign notes without the password for', 'settings', 'sign_reauth_minutes', () => n(p.signReauthMinutes, 'minutes')],
    ['Sign-in and security', 'Roles that must use two-step verification', 'settings', 'mfa_required_roles', () => (p.mfaRequiredRoles || []).join(', ') || null, 'mfa 2fa authenticator totp'],
    ['Sign-in and security', 'Days a new account has to set up two-step verification', 'settings', 'mfa_grace_days', () => n(p.mfaGraceDays, 'days'), 'mfa grace'],
    ['Sign-in and security', 'Fingerprint sign-in', 'settings', 'passkey_signin', () => yes(s.passkey_signin), 'passkey face'],
    ['Sign-in and security', 'Fingerprint for signatures and approvals', 'settings', 'passkey_signing', () => yes(s.passkey_signing), 'passkey'],
    ['Sign-in and security', 'Require fingerprint or authenticator for signing', 'settings', 'sign_strong_required', () => yes(s.sign_strong_required)],
    ['Sign-in and security', 'Sign up on the sign-in page', 'settings', 'self_signup', () => (s.self_signup === '0' ? 'Off' : 'On'), 'access requests register'],
    ['Sign-in and security', 'Authenticator allow-list for passkeys', 'settings', 'passkey-allowlist', null, 'fido metadata attestation'],
    ['Sign-in and security', 'Who may do what: users, roles and permissions', 'users', null, null, 'accounts staff roles permissions'],
    ['Sign-in and security', 'Security status: what to fix', 'security', null, null, 'checklist findings hardening'],

    ['Single sign-on', 'Require single sign-on', 'settings', 'sso_required', () => yes(s.sso_required), 'oidc entra okta'],
    ['Single sign-on', 'Emergency administrator accounts that keep a password', 'settings', 'sso_emergency_accounts', () => s.sso_emergency_accounts, 'break-glass'],
    ['Single sign-on', 'Disable single sign-on accounts not seen for', 'settings', 'sso_deprovision_days', () => n(s.sso_deprovision_days, 'days')],
    ['Single sign-on', 'Provisioning (SCIM): groups to roles', 'settings', 'scim_group_roles', null, 'scim'],

    ['Records and reporting', 'Outreach records use a participant code by default', 'settings', 'participant_code_default', () => yes(s.participant_code_default), 'minimal pii anonymous'],
    ['Records and reporting', 'New devices start as field devices', 'settings', 'field_device_default', () => yes(s.field_device_default)],
    ['Records and reporting', 'Keep discharged client records for', 'settings', 'client_retention_years', () => n(s.client_retention_years, 'years'), 'retention delete purge'],
    ['Records and reporting', 'Default funding source for new visits', 'settings', 'default_fund_id', null, 'fund grant'],
    ['Records and reporting', 'Small-cell threshold for reports', 'settings', 'small_cell_threshold', () => s.small_cell_threshold, 'suppression privacy'],
    ['Records and reporting', 'Naloxone doses per kit', 'settings', 'naloxone_doses_per_kit', () => s.naloxone_doses_per_kit, 'ndp narcan'],
    ['Records and reporting', 'Security & procurement page (your published terms)', 'settings', 'procurement_legal_entity', () => s.procurement_legal_entity, 'baa contact pricing sla'],

    ['Backups and the server', 'Scheduled backups', 'settings', 'backup_schedule_hours', () => (s.backup_schedule_hours === '0' ? 'Off' : n(s.backup_schedule_hours, 'hours')), 'backup restore'],
    ['Backups and the server', 'Offsite copy of each backup', 'settings', 'backup_offsite_dir', () => s.backup_offsite_dir, 'share drive'],
    ['Backups and the server', 'Monthly recovery drill', 'settings', 'dr_drill_monthly', () => yes(s.dr_drill_monthly), 'disaster recovery rto rpo'],
    ['Backups and the server', 'Back up now, restore, download the key backup', 'system', null, null, 'keys restore download'],
    ['Backups and the server', 'Listening address and HTTPS', 'network', null, null, 'port tls certificate https'],
    ['Backups and the server', 'Synced devices', 'devices', null, null, 'phones revoke wipe'],
    ['Backups and the server', 'API keys for intake apps', 'apikeys', null, null, 'pocket ai'],
  ];
}

export async function settingsOverview() {
  const [s, sc] = await Promise.all([get('/api/admin/settings'), can('settings:manage') ? get('/api/admin/server-config', { quiet: true }).catch(() => null) : null]);
  const rows = catalogue(s).map(([group, label, tab, target, value, words]) => ({ group, label, tab, target, value: value ? value() : null, words: words || '' }));
  if (moduleOn('fhir')) rows.push({ group: 'Backups and the server', label: 'FHIR clients (an EHR reading SUDS)', tab: 'fhir', target: null, value: null, words: 'fhir ehr' });
  if (sc) {
    rows.push({ group: 'AI copilot', label: 'Switch the copilot on, its agreement and limits', tab: 'ai', target: null, value: null, words: 'ai claude anthropic baa' });
    const groupLabel = Object.fromEntries(sc.groups.map(g => [g.id, g.label]));
    // The AI settings of the provider in use only: another provider's are on Server configuration, a choice away.
    const provider = (sc.entries.find(e => e.name === 'SUDS_AI_PROVIDER') || {}).value || 'anthropic';
    for (const e of sc.entries.filter(x => !x.provider || x.provider === provider)) {
      const value = e.type === 'secret' ? (e.set ? 'Set' : 'Not set') : e.value !== null && e.value !== undefined ? (e.type === 'bool' ? (e.value ? 'On' : 'Off') : String(e.value)) : e.default !== null ? `${e.type === 'bool' ? (e.default ? 'On' : 'Off') : e.default} (default)` : null;
      rows.push({ group: groupLabel[e.group] || 'Server configuration', label: e.label, tab: 'server', target: e.name, value: e.source === 'environment' ? `${value || 'Set'} (server environment)` : value, words: `${e.name} ${e.help || ''}` });
    }
  }
  const search = h('input', { type: 'search', id: 'settings-find', placeholder: 'For example: password, backup, API key, time zone', autocomplete: 'off' });
  const groups = [...new Set(rows.map(r => r.group))];
  const sections = groups.map(g => {
    const items = rows.filter(r => r.group === g).map(r => {
      const li = h('li', { 'data-overview-item': '1', 'data-words': `${r.label} ${r.group} ${r.words}`.toLowerCase() },
        h('a', { href: settingHref(r.tab, r.target), 'data-overview-link': `${r.tab}:${r.target || ''}` }, r.label),
        r.value ? h('span', { class: 'muted small' }, ` — ${r.value}`) : null);
      return li;
    });
    return h('section', { class: 'card settings-group', 'data-overview-group': g }, h('h2', {}, g), h('ul', { class: 'settings-index' }, ...items));
  });
  const none = h('p', { class: 'muted', hidden: true, role: 'status' }, 'No setting matches that. Try another word, such as "password" or "backup".');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const sec of sections) {
      let any = 0;
      for (const li of sec.querySelectorAll('[data-overview-item]')) { const hit = q.every(w => li.dataset.words.includes(w)); li.hidden = !hit; any += hit ? 1 : 0; }
      sec.hidden = !any; shown += any;
    }
    none.hidden = shown > 0;
  });
  return h('div', { 'data-settings-overview': '1' },
    h('p', { class: 'muted' }, 'Every setting in one place. Choose one to go straight to it.'),
    h('div', { class: 'field' }, h('label', { for: 'settings-find' }, 'Find a setting'), search),
    none,
    h('div', { class: 'grid cols-2' }, ...sections));
}

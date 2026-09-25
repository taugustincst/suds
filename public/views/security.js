// Settings → Security status (read-only) and the recovery-drill card on System & backups. What a county IT
// reviewer is shown: each control as this installation actually has it (server/security-status.js), and
// the evidence behind it — the last drill's signed report, audit anchors, the auditor's export.
import { h, get, post, del, toast, table, badge, fmt, stat } from '../app.js';

const KIND = { ok: 'ok', warn: 'warn', bad: 'danger', info: 'info' };
const LABEL = { ok: 'OK', warn: 'Attention', bad: 'Action needed', info: 'Info' };
const dur = (s) => s == null ? '—' : s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 6) / 10} min` : `${Math.round(s / 360) / 10} h`;

export async function securityTab() {
  const [s, signingKey] = await Promise.all([get('/api/admin/security/status'), get('/api/admin/security/signing-key', { quiet: true }).catch(() => null)]);
  const groups = [...new Set(s.items.map(i => i.group))];
  const exportLink = h('a', { class: 'btn sm', href: '/api/admin/audit/export', download: '' }, 'Download audit export (NDJSON + manifest)');
  const anchorMsg = h('span', { class: 'small muted' });
  const anchorNow = async () => { anchorMsg.textContent = 'Writing…'; try { const r = await post('/api/admin/audit/anchor', {}); anchorMsg.textContent = r.anchor ? `Anchored entry ${r.anchor.head_id}.` : 'Nothing to anchor yet.'; } catch (e) { anchorMsg.textContent = e.message; } };
  return h('div', { 'data-security-status': '1' },
    h('div', { class: 'banner small mb' }, 'Read-only. Each line is read from where the control is enforced or recorded in this installation, not from a document. ', h('b', {}, s.attestation)),
    h('div', { class: 'grid cols-4 mb' }, stat('OK', s.counts.ok, 'ok'), stat('Attention', s.counts.warn, s.counts.warn ? 'warn' : ''), stat('Action needed', s.counts.bad, s.counts.bad ? 'danger' : ''), stat('Two-step verification', `${s.mfa.coverage_pct}%`, s.mfa.coverage_pct === 100 ? 'ok' : 'warn')),
    groups.map(g => h('div', { class: 'card mb', 'data-group': g }, h('h2', {}, g),
      table([
        { label: 'Control', render: i => h('b', {}, i.name) },
        { label: 'Status', render: i => badge(LABEL[i.level], KIND[i.level]) },
        { label: 'In this installation', render: i => h('div', {}, i.value, i.detail ? h('div', { class: 'small muted' }, i.detail) : null) },
        { label: 'Where', render: i => h('span', { class: 'small mono' }, i.evidence) },
      ], s.items.filter(i => i.group === g)))),
    h('div', { class: 'card mb', 'data-mfa-report': '1' }, h('h2', {}, 'Accounts without two-step verification'),
      s.mfa.without.length ? table([
        { label: 'Name', render: u => h('div', {}, h('b', {}, u.display_name), h('div', { class: 'small muted' }, u.username)) },
        { label: 'Role', render: u => fmt.label(u.role) },
        { label: 'Required', render: u => u.required ? badge('Required', 'warn') : badge('Optional') },
        { label: 'Deadline', render: u => u.deadline ? [fmt.dt(u.deadline), u.overdue ? [' ', badge('Overdue', 'danger')] : null] : '—' },
        { label: 'SSO linked', render: u => u.sso_linked ? 'Yes' : 'No' },
        { label: 'Last sign-in', render: u => u.last_login_at ? fmt.dt(u.last_login_at) : 'never' },
      ], s.mfa.without) : h('p', {}, badge('Every active account has enrolled', 'ok'))),
    await provisioningCard(),
    h('div', { class: 'card' }, h('h2', {}, 'Evidence for an auditor'),
      h('p', { class: 'small' }, 'The audit export is the hash chain as NDJSON with a manifest (digest, MAC, the anchors in range and an Ed25519 signature). It is verified away from this server with ', h('code', {}, 'npm run verify-audit-export -- <file> --public-key <key>.pem'), ', and a recovery-drill report with ', h('code', {}, 'npm run verify-dr-report'), ' — the public key is all either needs. Anchors seal the chain head outside the database; the recovery drill report is on System & backups. The evidence package for county IT is docs/security/.'),
      signingKey ? h('p', { class: 'small', 'data-signing-key': signingKey.key_id }, 'Signing key: Ed25519, key id ', h('code', {}, signingKey.key_id), '. Record this id where the auditor can find it independently of the documents it signs.') : null,
      h('div', { class: 'row' }, exportLink, signingKey ? h('a', { class: 'btn sm', href: '/api/admin/security/signing-key?format=pem', download: '' }, 'Download signing public key') : null, h('button', { class: 'btn sm', onClick: anchorNow }, 'Anchor the audit log now'), anchorMsg)));
}

// Provisioning from the county identity provider: SCIM tokens (Entra ID / Okta user provisioning) and the
// accounts disabled — or about to be — because the provider no longer vouches for them.
async function provisioningCard() {
  const box = h('div', { class: 'card mb', 'data-provisioning': '1' });
  const [tok, dep] = await Promise.all([get('/api/admin/scim/tokens', { quiet: true }).catch(() => null), get('/api/admin/security/deprovisioning', { quiet: true }).catch(() => null)]);
  if (!tok && !dep) return null;
  const shown = h('div', { 'aria-live': 'polite' });
  const nameI = h('input', { id: 'scim-token-name', value: 'Identity provider provisioning', maxlength: 100 });
  const create = async () => {
    try {
      const r = await post('/api/admin/scim/tokens', { name: nameI.value || 'Identity provider provisioning' });
      shown.replaceChildren(h('div', { class: 'banner small' }, h('b', {}, 'Copy this token now; it is not shown again. '), 'Tenant URL: ', h('code', {}, `${location.origin}${r.endpoint}`), ' Secret token: ', h('code', { class: 'mono', style: { overflowWrap: 'anywhere' } }, r.token)));
      toast('SCIM token created', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
  const revoke = async (t) => { try { await del(`/api/admin/scim/tokens/${t.id}`); toast('Token revoked', 'ok'); box.replaceWith(await provisioningCard()); } catch (e) { toast(e.message, 'error'); } };
  box.append(h('h2', {}, 'Provisioning (SCIM) and deprovisioning'),
    h('p', { class: 'small muted' }, 'Entra ID or Okta can create, update and deactivate SUDS accounts through SCIM 2.0 at ', h('code', {}, '/scim/v2'), '. Group-to-role mapping and the role for everyone else are under Settings → Security policy. A provisioned account signs in through single sign-on; it has no SUDS password.'),
    tok ? table([
      { label: 'Token', render: (t) => h('div', {}, h('b', {}, t.name), h('div', { class: 'small muted mono' }, `${t.prefix}…`)) },
      { label: 'Created', render: (t) => fmt.dt(t.created_at) },
      { label: 'Last used', render: (t) => t.last_used_at ? fmt.dt(t.last_used_at) : 'never' },
      { label: 'Status', render: (t) => t.revoked_at ? badge('Revoked') : h('button', { class: 'btn sm danger', onClick: () => revoke(t) }, 'Revoke') },
    ], tok.tokens, { empty: 'No SCIM token yet.' }) : null,
    tok ? h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'scim-token-name' }, 'New token name'), nameI), h('button', { class: 'btn sm primary', onClick: create }, 'Create a SCIM token')) : null,
    shown,
    dep ? h('div', { class: 'mt', 'data-deprovisioning': '1' },
      h('h3', { class: 'eyebrow' }, 'Accounts the identity provider no longer vouches for'),
      h('p', { class: 'small' }, dep.days ? `Single sign-on accounts not seen for ${dep.days} days are disabled daily${dep.last_run_at ? ` (last run ${fmt.dt(dep.last_run_at)})` : ''}. ${dep.linked_active} active account${dep.linked_active === 1 ? ' is' : 's are'} linked.` : 'Off: set "Disable single sign-on accounts not seen for (days)" under Settings → Security policy.'),
      dep.due.length || dep.soon.length ? table([
        { label: 'Account', render: (u) => h('div', {}, h('b', {}, u.display_name), h('div', { class: 'small muted' }, u.username)) },
        { label: 'Last seen at the provider', render: (u) => fmt.dt(u.seen_at) },
        { label: 'Days', render: (u) => String(u.days_unseen) },
        { label: 'Next run', render: (u) => u.days_unseen >= dep.days ? badge('Will be disabled', 'danger') : badge('Within 7 days', 'warn') },
      ], [...dep.due, ...dep.soon]) : null,
      dep.recent.length ? h('details', {}, h('summary', {}, `Disabled in the last 90 days (${dep.recent.length})`),
        table([{ label: 'When', render: (x) => fmt.dt(x.at) }, { label: 'Account', render: (x) => x.username || x.user_id }, { label: 'Why', render: (x) => x.reason || '' }], dep.recent)) : null) : null);
  return box;
}

// The card on System & backups: last drill, targets, and a button that runs one in the background.
export async function drillCard() {
  const box = h('div', { class: 'card', 'data-dr-drill': '1' });
  const render = (st) => {
    const l = st.last;
    const running = st.running;
    const progress = running ? h('ul', { class: 'small', 'data-drill-progress': '1' }, running.steps.map(x => h('li', {}, x.step))) : null;
    // Optional: the escrowed key backup (the "Download key backup" file kept offline), so the drill proves
    // that file opens the backup instead of using the keys this server already has in memory. Read in the
    // browser and sent once with the request; the server never stores it.
    const keysInput = h('input', { type: 'file', id: 'drill-keys-file', 'aria-describedby': 'drill-keys-help', accept: '.json,.env,.txt,application/json,text/plain' });
    const copySel = h('select', { id: 'drill-copy' }, h('option', { value: 'auto' }, 'Offsite copy if one is set up, else local'), h('option', { value: 'local' }, 'Local copy'), h('option', { value: 'offsite' }, 'Offsite copy'));
    const btn = h('button', { class: 'btn sm primary', disabled: !!running, onClick: async () => {
      btn.disabled = true;
      try {
        const body = { copy: copySel.value };
        const f = keysInput.files && keysInput.files[0];
        if (f) { if (f.size > 64 * 1024) throw new Error('That file is too large to be a key backup'); body.keys_file = await f.text(); body.keys_file_name = f.name; }
        await post('/api/admin/dr-drill', body); keysInput.value = ''; toast('Recovery drill started', 'ok'); poll();
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    } }, running ? 'Drill running…' : 'Run a recovery drill now');
    box.replaceChildren(h('h2', {}, 'Recovery drill'),
      h('p', { class: 'small muted' }, 'Restores the newest backup into a temporary copy (never the live database), starts SUDS against it, verifies the schema, row counts, the audit chain and its anchors, decrypts a sample of encrypted fields and signs in with a second factor. RTO is the time from starting the restore to the copy serving; RPO is the age of the backup it restored.'),
      l ? h('div', { 'data-drill-last': l.ok ? 'passed' : 'failed' },
        h('p', {}, l.ok ? badge('Last drill passed', 'ok') : badge('Last drill failed', 'danger'), ` ${fmt.dt(l.at)} — ${l.checks_passed}/${l.checks_total} checks`),
        h('dl', { class: 'kv' },
          h('dt', {}, 'RTO (restore → serving)'), h('dd', {}, `${dur(l.rto_seconds)} — target ${l.rto_target_minutes} min`),
          h('dt', {}, 'RPO (backup age)'), h('dd', {}, `${dur(l.rpo_seconds)} — target ${l.rpo_target_hours} h`),
          h('dt', {}, 'Backup restored'), h('dd', {}, l.backup_file || '—', l.backup_copy ? h('div', { class: 'small muted' }, `the ${l.backup_copy} copy`) : null),
          h('dt', {}, 'Keys used'), h('dd', {}, l.keys_source || 'server memory', (l.keys_source || 'server memory') === 'server memory' ? h('div', { class: 'small muted' }, 'Not proof that the escrowed key backup works — run with the key file below.') : null),
          h('dt', {}, 'Signed report'), h('dd', {}, h('code', {}, `backups/${l.report_file || '—'}`), h('div', { class: 'small muted mono' }, `SHA-256 ${String(l.sha256 || '').slice(0, 16)}…`))),
        l.failures && l.failures.length ? h('ul', { class: 'small' }, l.failures.map(f => h('li', {}, f))) : null)
        : h('p', {}, badge('No drill has been run', 'warn')),
      h('p', { class: 'small' }, `Monthly drill: ${st.monthly ? 'on' : 'off'} (Settings → Scheduled backups). Also from a shell: `, h('code', {}, 'npm run dr-drill')),
      running ? null : h('div', { class: 'grid cols-2' },
        h('div', { class: 'field' }, h('label', { for: 'drill-copy' }, 'Which copy to restore'), copySel),
        h('div', { class: 'field' }, h('label', { for: 'drill-keys-file' }, 'Escrowed key backup file (optional)'), keysInput, h('div', { class: 'small muted', id: 'drill-keys-help' }, 'The key backup kept offline. With it, the drill decrypts with that file only, proving it opens the backups; it is not stored.'))),
      h('div', { class: 'row' }, btn), progress);
  };
  let timer = null;
  const poll = async () => {
    clearTimeout(timer);
    const st = await get('/api/admin/dr-drill', { quiet: true }).catch(() => null);
    if (!st || !box.isConnected) return;
    render(st);
    if (st.running) timer = setTimeout(poll, 1000);
  };
  render(await get('/api/admin/dr-drill'));
  const first = box.querySelector('[data-drill-progress]'); if (first) timer = setTimeout(poll, 1000);
  return box;
}

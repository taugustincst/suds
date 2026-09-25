// Settings → Security status (read-only) and the recovery-drill card on System & backups. What a county IT
// reviewer is shown: each control as this installation actually has it (server/security-status.js), and
// the evidence behind it — the last drill's signed report, audit anchors, the auditor's export.
import { h, get, post, toast, table, badge, fmt, stat } from '../app.js';

const KIND = { ok: 'ok', warn: 'warn', bad: 'danger', info: 'info' };
const LABEL = { ok: 'OK', warn: 'Attention', bad: 'Action needed', info: 'Info' };
const dur = (s) => s == null ? '—' : s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 6) / 10} min` : `${Math.round(s / 360) / 10} h`;

export async function securityTab() {
  const s = await get('/api/admin/security/status');
  const groups = [...new Set(s.items.map(i => i.group))];
  const exportLink = h('a', { class: 'btn sm', href: '/api/admin/audit/export', download: '' }, 'Download audit export (NDJSON + manifest)');
  const anchorMsg = h('span', { class: 'small muted' });
  const anchorNow = async () => { anchorMsg.textContent = 'Writing…'; try { const r = await post('/api/admin/audit/anchor', {}); anchorMsg.textContent = r.anchor ? `Anchored entry ${r.anchor.head_id}.` : 'Nothing to anchor yet.'; } catch (e) { anchorMsg.textContent = e.message; } };
  return h('div', { 'data-security-status': '1' },
    h('div', { class: 'banner small mb' }, 'Read-only. Each line is read from where the control is enforced or recorded in this installation, not from a document. ', h('b', {}, s.attestation)),
    h('div', { class: 'grid cols-4 mb' }, stat('OK', s.counts.ok, 'ok'), stat('Attention', s.counts.warn, s.counts.warn ? 'warn' : ''), stat('Action needed', s.counts.bad, s.counts.bad ? 'danger' : ''), stat('Two-step verification', `${s.mfa.coverage_pct}%`, s.mfa.coverage_pct === 100 ? 'ok' : 'warn')),
    groups.map(g => h('div', { class: 'card mb', 'data-group': g }, h('h3', {}, g),
      table([
        { label: 'Control', render: i => h('b', {}, i.name) },
        { label: 'Status', render: i => badge(LABEL[i.level], KIND[i.level]) },
        { label: 'In this installation', render: i => h('div', {}, i.value, i.detail ? h('div', { class: 'small muted' }, i.detail) : null) },
        { label: 'Where', render: i => h('span', { class: 'small mono' }, i.evidence) },
      ], s.items.filter(i => i.group === g)))),
    h('div', { class: 'card mb', 'data-mfa-report': '1' }, h('h3', {}, 'Accounts without two-step verification'),
      s.mfa.without.length ? table([
        { label: 'Name', render: u => h('div', {}, h('b', {}, u.display_name), h('div', { class: 'small muted' }, u.username)) },
        { label: 'Role', render: u => fmt.label(u.role) },
        { label: 'Required', render: u => u.required ? badge('Required', 'warn') : badge('Optional') },
        { label: 'Deadline', render: u => u.deadline ? [fmt.dt(u.deadline), u.overdue ? [' ', badge('Overdue', 'danger')] : null] : '—' },
        { label: 'SSO linked', render: u => u.sso_linked ? 'Yes' : 'No' },
        { label: 'Last sign-in', render: u => u.last_login_at ? fmt.dt(u.last_login_at) : 'never' },
      ], s.mfa.without) : h('p', {}, badge('Every active account has enrolled', 'ok'))),
    h('div', { class: 'card' }, h('h3', {}, 'Evidence for an auditor'),
      h('p', { class: 'small' }, 'The audit export is the hash chain as NDJSON with a manifest (digest, MAC and the anchors in range). It is verified away from this server with ', h('code', {}, 'npm run verify-audit-export -- <file>'), '. Anchors seal the chain head outside the database; the recovery drill report is on System & backups. The evidence package for county IT is docs/security/.'),
      h('div', { class: 'row' }, exportLink, h('button', { class: 'btn sm', onClick: anchorNow }, 'Anchor the audit log now'), anchorMsg)));
}

// The card on System & backups: last drill, targets, and a button that runs one in the background.
export async function drillCard() {
  const box = h('div', { class: 'card', 'data-dr-drill': '1' });
  const render = (st) => {
    const l = st.last;
    const running = st.running;
    const progress = running ? h('ul', { class: 'small', 'data-drill-progress': '1' }, running.steps.map(x => h('li', {}, x.step))) : null;
    const btn = h('button', { class: 'btn sm primary', disabled: !!running, onClick: async () => {
      btn.disabled = true;
      try { await post('/api/admin/dr-drill', {}); toast('Recovery drill started', 'ok'); poll(); } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    } }, running ? 'Drill running…' : 'Run a recovery drill now');
    box.replaceChildren(h('h3', {}, 'Recovery drill'),
      h('p', { class: 'small muted' }, 'Restores the newest backup into a temporary copy (never the live database), starts SUDS against it, verifies the schema, row counts, the audit chain and its anchors, decrypts a sample of encrypted fields and signs in with a second factor. RTO is the time from starting the restore to the copy serving; RPO is the age of the backup it restored.'),
      l ? h('div', { 'data-drill-last': l.ok ? 'passed' : 'failed' },
        h('p', {}, l.ok ? badge('Last drill passed', 'ok') : badge('Last drill failed', 'danger'), ` ${fmt.dt(l.at)} — ${l.checks_passed}/${l.checks_total} checks`),
        h('dl', { class: 'kv' },
          h('dt', {}, 'RTO (restore → serving)'), h('dd', {}, `${dur(l.rto_seconds)} — target ${l.rto_target_minutes} min`),
          h('dt', {}, 'RPO (backup age)'), h('dd', {}, `${dur(l.rpo_seconds)} — target ${l.rpo_target_hours} h`),
          h('dt', {}, 'Backup restored'), h('dd', {}, l.backup_file || '—'),
          h('dt', {}, 'Signed report'), h('dd', {}, h('code', {}, `backups/${l.report_file || '—'}`), h('div', { class: 'small muted mono' }, `SHA-256 ${String(l.sha256 || '').slice(0, 16)}…`))),
        l.failures && l.failures.length ? h('ul', { class: 'small' }, l.failures.map(f => h('li', {}, f))) : null)
        : h('p', {}, badge('No drill has been run', 'warn')),
      h('p', { class: 'small' }, `Monthly drill: ${st.monthly ? 'on' : 'off'} (Settings → Scheduled backups). Also from a shell: `, h('code', {}, 'npm run dr-drill')),
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

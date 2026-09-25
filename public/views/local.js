import { h, route, get, post, put, state, form, toast, nav, render, loadSession, badge, fmt, pageHead, eraseDeviceButton, kv, modal, clear } from '../app.js';

// A column name as the person would say it: `first_name_enc` is "first name" (the suffix is how the
// database marks an encrypted column, not something a navigator should have to read past).
const column = (x) => fmt.label(String(x).replace(/_enc$/, '').replace(/_idx$/, '')).toLowerCase();
import { sampleDataCard } from './admin.js';
import { isStaticHost } from './login.js';
// Must match local/sync.js (the kernel says the same when a sync is attempted from the on-device app).
const STATIC_HOST_MESSAGE = 'SUDS on this device does not sync with an office server: your records stay in this browser. Keep them safe with "Download a backup" on this page. If your programme runs an office SUDS server, use SUDS at its address instead.';
const BACKUP_EVERY_DAYS = 7;
const MIN_PASSPHRASE = 12; // local/backup.js

// ---------------------------------------------------------------------------------------------------------
// Keeping the records on a device safe: persistent storage, backup, restore, and the reminder on Home.
// ---------------------------------------------------------------------------------------------------------

/** Ask the browser not to clear this site's storage under pressure. The browser decides; true if granted. */
export async function requestPersistentStorage() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
async function storagePersisted() {
  try { if (navigator.storage && navigator.storage.persisted) return await navigator.storage.persisted(); } catch {}
  return null;
}
const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000)) : null);
const ago = (iso) => { const d = daysSince(iso); return d === null ? 'never' : d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`; };

/** "Download a backup": a passphrase typed twice, then the encrypted file (local/backup.js) is saved. */
export function openBackupDialog(onDone) {
  const f = form([
    { name: 'passphrase', label: 'Backup passphrase', type: 'password', required: true, autocomplete: 'new-password', help: `At least ${MIN_PASSPHRASE} characters. You will need it to restore this backup; nobody can recover it for you.` },
    { name: 'confirm', label: 'Type the passphrase again', type: 'password', required: true, autocomplete: 'new-password' },
  ], { submitText: 'Download backup', onCancel: () => m.close(), onSubmit: async (d) => {
    if (d.passphrase.length < MIN_PASSPHRASE) { const e = new Error(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters.`); e.labelled = true; e.data = { fields: { passphrase: `At least ${MIN_PASSPHRASE} characters` } }; throw e; }
    if (d.passphrase !== d.confirm) { const e = new Error('The two passphrases do not match.'); e.labelled = true; e.data = { fields: { confirm: 'Does not match' } }; throw e; }
    // Straight to the kernel, not through api(): the answer is a binary file, which api() would read as text.
    const r = await window.SUDS_LOCAL.handle('POST', '/api/local/backup', { passphrase: d.passphrase }, { 'X-Requested-With': 'suds' });
    if (r.status >= 400) { const e = new Error((r.json && r.json.error) || 'The backup could not be made'); throw e; }
    try { await window.SUDS_LOCAL.flush(); } catch {}
    const name = (/filename="([^"]+)"/.exec(r.headers['content-disposition'] || '') || [])[1] || 'suds-device-backup.sudsbackup';
    const url = URL.createObjectURL(new Blob([r.body], { type: 'application/octet-stream' }));
    const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    m.close();
    toast('Backup downloaded. Keep the file somewhere other than this device, and keep the passphrase safe.', 'ok');
    if (onDone) onDone();
  } });
  const m = modal('Download a backup', h('div', {},
    h('p', {}, 'The backup holds every record on this device, encrypted with a passphrase you choose. Store the file somewhere other than this device — a county drive, or a USB stick kept securely.'),
    h('p', { class: 'small muted' }, 'Without the passphrase the file cannot be opened by anyone, including you.'), f));
  return m;
}
export const backupButton = (onDone) => h('button', { type: 'button', class: 'btn primary', 'data-backup-download': '1', onClick: () => openBackupDialog(onDone) }, 'Download a backup');

/** "Restore from a backup": choose the file, type the passphrase, see what is in it, type RESTORE. */
export function openRestoreDialog() {
  const file = h('input', { type: 'file', name: 'backup_file', accept: '.sudsbackup,application/octet-stream', 'aria-label': 'Backup file' });
  const pass = h('input', { type: 'password', name: 'backup_passphrase', autocomplete: 'off', id: 'restore-passphrase' });
  const out = h('div', { class: 'mt' });
  let fileB64 = null;
  const read = () => new Promise((resolve, reject) => {
    const x = file.files && file.files[0]; if (!x) { reject(new Error('Choose the backup file first')); return; }
    const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.onerror = () => reject(new Error('That file could not be read')); fr.readAsDataURL(x);
  });
  const check = async () => {
    clear(out);
    const busy = h('p', { class: 'small muted', role: 'status' }, 'Opening the backup…'); out.append(busy);
    try {
      fileB64 = await read();
      const info = await post('/api/local/restore/preview', { file_b64: fileB64, passphrase: pass.value });
      let typed; let go;
      clear(out).append(
        h('div', { class: 'banner warn', role: 'status', 'data-restore-preview': '1' }, h('div', {}, 'Nothing has changed yet. Check this is the backup you meant.')),
        kv([['Made', fmt.dt(info.created_at)], ['Clients', h('span', { 'data-restore-clients': String(info.clients) }, String(info.clients))], ['Accounts', String(info.users)], ['Program', info.org_name || '—'], ['SUDS version', info.app_version || '—']]),
        h('p', { class: 'small' }, info.current.clients ? `Restoring replaces everything on this device now (${info.current.clients} client${info.current.clients === 1 ? '' : 's'}) with the backup. ` : 'Restoring puts these records on this device. ', 'Afterwards you log in with an account from the backup.'),
        h('div', { class: 'field' }, h('label', { for: 'restore-confirm' }, 'Type RESTORE to confirm *'), typed = h('input', { id: 'restore-confirm', name: 'restore_confirm', autocomplete: 'off', onInput: () => { go.disabled = typed.value.trim() !== 'RESTORE'; } })),
        h('div', { class: 'btn-row' }, go = h('button', { type: 'button', class: 'btn danger', disabled: true, 'data-restore-go': '1', onClick: async () => {
          go.disabled = true;
          try {
            const r = await post('/api/local/restore', { file_b64: fileB64, passphrase: pass.value, confirm: typed.value.trim() });
            toast(`Restored ${r.clients} client record${r.clients === 1 ? '' : 's'}. Log in with an account from the backup.`, 'ok');
            state.user = null;
            setTimeout(() => { location.hash = '#/login?mode=login'; location.reload(); }, 600);
          } catch (e) { go.disabled = false; toast(e.message, 'error'); }
        } }, 'Replace everything on this device')));
    } catch (e) { clear(out).append(h('div', { class: 'banner error', role: 'alert', 'data-restore-error': '1' }, e.message)); }
  };
  const m = modal('Restore from a backup', h('div', {},
    h('p', {}, 'Put a SUDS device backup back onto this device. Everything on the device now is replaced by what is in the backup.'),
    h('div', { class: 'field' }, h('label', {}, 'Backup file *'), file),
    h('div', { class: 'field' }, h('label', { for: 'restore-passphrase' }, 'Backup passphrase *'), pass),
    h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', 'data-restore-check': '1', onClick: check }, 'Check this backup')),
    out));
  return m;
}
export function restoreBackupButton({ link = false } = {}) {
  return link
    ? h('a', { href: '#', 'data-restore-open': '1', onClick: (e) => { e.preventDefault(); openRestoreDialog(); } }, 'Restore from a backup')
    : h('button', { type: 'button', class: 'btn', 'data-restore-open': '1', onClick: () => openRestoreDialog() }, 'Restore from a backup');
}

/** Home's reminder on the on-device app: no backup for a week (or ever), with at least one client. Per day. */
const REMINDER_KEY = 'suds.backupReminderDismissed';
const today = () => new Date().toLocaleDateString('en-CA');
export async function backupReminderCard() {
  if (!state.local || !isStaticHost()) return null;
  let st; try { st = await get('/api/local/device', { quiet: true }); } catch { return null; }
  if (!st.device_admin || !st.clients) return null;
  const days = daysSince(st.last_backup_at);
  if (days !== null && days < BACKUP_EVERY_DAYS) return null;
  try { if (localStorage.getItem(REMINDER_KEY) === today()) return null; } catch {}
  const card = h('div', { class: 'banner warn mb', role: 'status', 'data-backup-reminder': '1' },
    h('div', {}, h('b', {}, `Last backup: ${ago(st.last_backup_at)}. `), 'Your records are kept only in this browser. ', backupButton(() => card.remove())),
    h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Dismiss until tomorrow', 'data-backup-reminder-dismiss': '1', onClick: () => { try { localStorage.setItem(REMINDER_KEY, today()); } catch {} card.remove(); } }, '✕'));
  return card;
}

/** The "Keep your records safe" card on This device: storage protection, last backup, backup and restore. */
async function safetyCard(dev, onChange) {
  const persisted = await storagePersisted();
  const storageLine = h('span', { 'data-storage-state': persisted ? 'protected' : 'best-effort' }, persisted ? badge('Protected', 'ok') : badge('May be cleared by the browser', 'warn'));
  const protect = persisted ? null : h('button', { type: 'button', class: 'btn sm', onClick: async () => { const ok = await requestPersistentStorage(); toast(ok ? 'The browser will keep SUDS’s storage.' : 'The browser did not agree. Installing SUDS to the home screen usually helps; keep downloading backups either way.', ok ? 'ok' : 'error'); onChange(); } }, 'Ask the browser to protect it');
  return h('div', { class: 'card', 'data-device-safety': '1' }, h('h2', {}, 'Keep your records safe'),
    kv([['Storage', h('span', {}, storageLine, ' ', protect)], ['Last backup', h('span', { 'data-last-backup': dev ? (dev.last_backup_at || 'never') : '' }, dev ? ago(dev.last_backup_at) : '—')]]),
    h('p', { class: 'small muted mt' }, isStaticHost()
      ? 'The records on this device exist only in this browser. If its site data is cleared, or the device is lost, only a backup brings them back. Download one at least weekly and keep it off this device.'
      : 'The office SUDS is where your records are kept for good; sync often. A backup here protects what has not been synced yet.'),
    dev && dev.device_admin
      ? h('div', { class: 'btn-row' }, backupButton(onChange), restoreBackupButton())
      : h('p', { class: 'small muted' }, 'Backups hold every record on this device, so only the person who manages it can download or restore one.'));
}

/** Who may create an account on this device (the on-device app only; the device administrator decides). */
function accountsCard(dev, onChange) {
  if (!isStaticHost() || !dev) return null;
  const box = h('input', { type: 'checkbox', name: 'signup_enabled', checked: !!dev.signup_enabled, disabled: !dev.device_admin, onChange: async () => {
    try { await put('/api/local/device', { signup_enabled: box.checked }); toast(box.checked ? 'Other people can sign up on this device' : 'Sign-ups on this device are off', 'ok'); onChange(); }
    catch (e) { box.checked = !box.checked; toast(e.message, 'error'); }
  } });
  return h('div', { class: 'card', 'data-device-accounts': '1' }, h('h2', {}, 'Accounts on this device'),
    kv([['Accounts', String(dev.users)], ['You', dev.device_admin ? badge('Manage this device', 'info') : 'Navigator account']]),
    h('label', { class: 'check mt' }, box, 'Let other people create their own account here (Sign up)'),
    h('p', { class: 'small muted' }, dev.device_admin
      ? 'Each person who signs up gets a navigator account and sees only the clients they record or are assigned. Turn this off once everyone who shares the device has an account.'
      : 'Only the person who manages this device can change this.'),
    dev.device_admin ? accountRoles() : null);
}
/** The device administrator gives the other accounts on this device their roles (sign-ups start as navigators). */
function accountRoles() {
  const box = h('div', { class: 'mt', 'data-account-roles': '1' });
  const LABELS = { navigator: 'Navigator', clinician: 'Clinician (clinical notes)', supervisor: 'Supervisor (countersigning, approving time)', admin: 'Administrator (settings and user accounts)' };
  get('/api/local/accounts', { quiet: true }).then(({ rows, roles }) => {
    const others = rows.filter(u => u.id !== state.user.id);
    if (!others.length) return;
    box.append(h('h3', { class: 'eyebrow' }, 'Roles'),
      ...others.map(u => {
        const sel = h('select', { 'data-account-role': u.id, onChange: async () => {
          const before = u.role;
          try { await put(`/api/local/accounts/${u.id}`, { role: sel.value }); u.role = sel.value; toast(`${u.display_name} is now ${LABELS[sel.value] || sel.value} — from their next sign-in`, 'ok'); }
          catch (e) { sel.value = before; toast(e.message, 'error'); }
        } }, roles.map(r => h('option', { value: r, selected: r === u.role }, LABELS[r] || r)));
        return h('div', { class: 'field' }, h('label', {}, `Role for ${u.display_name} (${u.username})`), sel);
      }),
      h('p', { class: 'small muted' }, 'A new role applies the next time that person signs in.'));
  }).catch(() => {});
  return box;
}

// Sync screen (local mode)
route('sync', async () => {
  if (!state.local) { nav('dashboard'); return h('div'); }
  const st = await get('/api/local/sync/status');
  const serverGuess = st.server || 'https://suds.local';
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
  const refresh = () => nav('sync?_=' + Date.now());
  const dev = await get('/api/local/device', { quiet: true }).catch(() => null);
  if (isStaticHost()) {
    // The on-device app: no sync form at all (nothing is ever sent from it; local/sync.js refuses), and no
    // count of "changes waiting to send", which read as work at risk. This page is about the device itself.
    return h('div', {}, pageHead('This device'),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card', 'data-static-status': '1' }, h('h2', {}, 'Status'),
          kv([['This device', badge('SUDS on this device', 'info')], ['Where your records are', 'In this browser on this device only'], ['Clients', dev ? String(dev.clients) : '—']]),
          h('p', { class: 'small muted mt' }, 'Your records stay in this browser and are never sent anywhere. Clearing this browser’s site data erases them, so keep a recent backup.')),
        await safetyCard(dev, refresh),
        accountsCard(dev, refresh),
        h('div', { class: 'card' }, h('h2', {}, 'Office server'), h('div', { class: 'banner info', 'data-static-no-sync': '1' }, h('div', {}, STATIC_HOST_MESSAGE)), h('div', { class: 'btn-row mt' }, eraseDeviceButton())),
        await sampleDataCard(refresh)));
  }
  // A browser has no Keystore or Keychain, so the local kernel keeps its encryption keys in this profile's
  // localStorage, beside the data they protect. Say so where someone is about to put real client
  // information into it, not only in the documentation.
  return h('div', {}, pageHead('Sync with the office'),
    h('div', { class: 'banner warn mb' }, h('b', {}, 'This is an offline copy of the office SUDS. '),
      'Its encryption keys are stored in this browser profile alongside the data, so anyone who can use this browser profile can read what is in it — a lost device is protected only by its own disk encryption and screen lock. Keep real client information on the office SUDS unless your administrator has approved this device for field work.'),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Status'), kv([['This device', badge('Local copy', 'info')], ['Data protection', badge('Keys kept in this browser', 'warn')], ['Last sync', st.last_sync_at ? fmt.dt(st.last_sync_at) : 'never'], ['Changes waiting to send', String(st.pending)], ['Office server', st.server || 'not set yet']]),
        h('p', { class: 'small muted mt' }, 'Sync exchanges clients, visits, calls, notes, reminders, referrals and everything else in both directions. The office SUDS decides: the newest change wins, a change it rejects for good is not sent again, and a record the office has purged or merged does not come back.')),
      h('div', { class: 'card' }, h('h2', {}, 'Sync now'), h('p', { class: 'small muted' }, 'Connect this device to the office Wi-Fi (or the address IT gave you), then sign in with your office account.'), f, log,
        h('div', { class: 'btn-row' }, eraseDeviceButton())),
      await safetyCard(dev, refresh),
      await sampleDataCard(refresh)));
});

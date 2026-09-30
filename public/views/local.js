import { h, route, get, post, put, state, form, toast, nav, navAndRender, render, loadSession, badge, fmt, pageHead, eraseDeviceButton, kv, modal, clear, forgetDue } from '../app.js';

// A column name as the person would say it: `first_name_enc` is "first name" (the suffix is how the
// database marks an encrypted column, not something a navigator should have to read past).
const column = (x) => fmt.label(String(x).replace(/_enc$/, '').replace(/_idx$/, '')).toLowerCase();
import { isStaticHost } from './login.js';
// Administration (admin.js, with the lists, security and clinical modules it pulls in) is loaded only when the
// sample-data card is shown, so the sign-in page and Home do not download it (main.js loads views on demand).
const sampleDataCard = async (...a) => (await import('./admin.js')).sampleDataCard(...a);
// Must match local/sync.js (the kernel says the same when a sync is attempted from the on-device app).
const STATIC_HOST_MESSAGE = 'SUDS on this device does not sync with an office server: your records stay in this browser. Keep them safe with "Download a backup" on this page. If your program runs an office SUDS server, use SUDS at its address instead.';
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
    h('p', { class: 'small muted' }, 'Without the passphrase the file cannot be opened by anyone, including you. It is separate from your password: if you forget your password, this file and its passphrase are the only way back to the records.'), f));
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
            // The restored records are open in this page under a new key that no account can unlock yet: the
            // first person from the backup to log in, now, gets one. So no reload here (local/kernel.js).
            toast(`Restored ${r.clients} client record${r.clients === 1 ? '' : 's'}. Log in now with an account from the backup.`, 'ok');
            state.user = null; m.close();
            if (r.reload === false) { nav('login?mode=login'); render(); }
            else setTimeout(() => { location.hash = '#/login?mode=login'; location.reload(); }, 600);
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

// ---------------------------------------------------------------------------------------------------------
// The owner's recovery code (local/vault.js; docs/architecture/ADR-0008-device-encryption.md, "Recovery code").
// A random code that opens this device's records without a password, for the day the device administrator
// forgets theirs. Made at set-up (and again after every use, or when asked for), shown once on its own screen,
// and never stored: the kernel keeps only the device key wrapped under it.
// ---------------------------------------------------------------------------------------------------------
// The code to show, from the request that made it until the person leaves its screen. In this page's memory
// only; a reload loses it (the device then asks for a new one: the old one may not have been saved).
let freshCode = null;
/** Show a new recovery code once, on its own screen; afterwards go to `after`. */
export function showRecoveryCode(code, createdAt, { after = 'dashboard', recovered = false, username = '' } = {}) {
  freshCode = { code, createdAt, after, recovered, username };
  navAndRender('recovery-code');
}
const codeFileName = (at) => `suds-recovery-code-${String(at || new Date().toISOString()).slice(0, 10)}.txt`;
function codeText(c) {
  const program = state.org || '';
  return [
    'SUDS on this device: recovery code',
    '',
    `    ${c.code}`,
    '',
    `Made: ${fmt.dt(c.createdAt)}${program ? `\nProgram: ${program}` : ''}`,
    `Web address: ${location.origin}${location.pathname}`,
    '',
    'If you forget your password: open SUDS on this device, choose Log in, then under "Can\'t sign in?" choose',
    '"Use your recovery code". Type this code and choose a new password. Capitals and dashes do not matter.',
    'The code then stops working and SUDS shows you a new one to keep instead.',
    '',
    'Keep this away from the device: whoever has this code can open every record on it, the way a key would.',
    'If you saved this as a file on the device itself, move it (to a USB stick, another computer or a password',
    'manager) and delete it from the device.',
    'Making a new code (This device > Recovery code) makes this one stop working.',
  ].join('\n');
}
function downloadCode(c) {
  const url = URL.createObjectURL(new Blob([codeText(c) + '\n'], { type: 'text/plain' }));
  const a = h('a', { href: url, download: codeFileName(c.createdAt) }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function printCode(c) {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the recovery code, or download it instead', 'error'); return; }
  w.document.open();
  w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SUDS recovery code</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111;line-height:1.45;white-space:pre-wrap}</style></head><body>${esc(codeText(c))}</body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
}

/** "Make a new recovery code": the device administrator's password again, then the code on its own screen. */
export function openRecoveryDialog({ exists = false, after = 'sync' } = {}) {
  const f = form([
    { name: 'password', label: 'Your password', type: 'password', required: true, autocomplete: 'current-password', help: 'To make sure it is you. Your password does not change.' },
  ], { submitText: exists ? 'Make a new code' : 'Make the code', onCancel: () => m.close(), onSubmit: async (d) => {
    // quiet: a wrong password here is this form's error, not the session ending.
    const r = await post('/api/local/recovery', { password: d.password }, { quiet: true });
    m.close();
    showRecoveryCode(r.code, r.created_at, { after });
  } });
  const m = modal(exists ? 'Make a new recovery code' : 'Make a recovery code', h('div', {},
    h('p', {}, 'If you forget your password, a recovery code lets you back into SUDS on this device and choose a new one, without losing any records.'),
    exists ? h('p', { class: 'banner warn', 'data-recovery-replaces': '1' }, 'This replaces the recovery code you have now: the old one stops working at once.') : null,
    f));
  return m;
}

/** Home's prompt for the device administrator of a device with no recovery code (or one never confirmed saved). */
let promptDismissed = false; // until the next sign-in (every page load, and every sign-in, starts again)
export function resetRecoveryPrompt() { promptDismissed = false; }
export async function recoveryPromptCard() {
  if (!state.local || promptDismissed) return null;
  let st; try { st = await get('/api/local/device', { quiet: true }); } catch { return null; }
  if (!st || !st.device_admin || !st.recovery || (st.recovery.exists && st.recovery.saved)) return null;
  const unsaved = st.recovery.exists;
  const card = h('div', { class: 'banner warn mb', role: 'status', 'data-recovery-prompt': unsaved ? 'unsaved' : 'none' },
    h('div', {}, h('b', {}, unsaved ? 'Your recovery code was not confirmed as saved. ' : 'This device has no recovery code. '),
      !unsaved && st.recovery.dropped && st.recovery.dropped.reason === 'device_admin_changed' ? 'You now manage this device, and the code of the person who managed it before no longer works. ' : null,
      'If you forget your password, a recovery code is the only way back to the records here without a backup. ',
      h('button', { type: 'button', class: 'btn sm primary', 'data-recovery-prompt-make': '1', onClick: () => openRecoveryDialog({ exists: unsaved, after: 'dashboard' }) }, unsaved ? 'Make a new recovery code' : 'Make a recovery code')),
    h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Dismiss until you next sign in', 'data-recovery-prompt-dismiss': '1', onClick: () => { promptDismissed = true; card.remove(); } }, '✕'));
  return card;
}

/** Why a device that had a recovery code has none now, when it was not the person's own doing. */
function droppedNote(rc) {
  if (!rc || !rc.dropped) return null;
  return h('span', { class: 'small', 'data-recovery-dropped': rc.dropped.reason }, ' ', rc.dropped.reason === 'device_admin_changed'
    ? `The last one stopped working ${fmt.dt(rc.dropped.at)}, when the account of the person who managed this device was deactivated: make a new one.`
    : `The last one stopped working ${fmt.dt(rc.dropped.at)}, when a backup was restored: make a new one.`);
}

/** The "Recovery code" card on This device: whether there is one and when it was made, and making a new one. */
function recoveryCard(dev, onChange) {
  if (!dev || !dev.recovery) return null;
  const rc = dev.recovery;
  const status = rc.exists
    ? h('span', { 'data-recovery-state': rc.saved ? 'saved' : 'unsaved' }, `Made ${fmt.dt(rc.created_at)}`, rc.saved ? null : [' ', badge('Not confirmed as saved', 'warn')])
    : h('span', { 'data-recovery-state': 'none' }, badge('None yet', 'warn'), droppedNote(rc));
  return h('div', { class: 'card', 'data-device-recovery': '1' }, h('h2', {}, 'Recovery code'),
    kv([['Recovery code', status]]),
    h('p', { class: 'small muted mt' }, 'If the person who manages this device forgets their password, the recovery code lets them back in from the sign-in page (Can’t sign in? → Use your recovery code) and keeps every record. Keep it away from this device: whoever has the code can open every record here, like a key. SUDS never shows an existing code again; making a new one makes the old one stop working.'),
    dev.device_admin
      ? h('div', { class: 'btn-row' }, h('button', { type: 'button', class: rc.exists && rc.saved ? 'btn' : 'btn primary', 'data-recovery-new': '1', onClick: () => openRecoveryDialog({ exists: rc.exists, after: 'sync' }) }, rc.exists ? 'Make a new recovery code' : 'Make a recovery code'))
      : h('p', { class: 'small muted' }, 'Only the person who manages this device can make its recovery code.'));
}

// The screen that shows a new code, once: download, print, and "I have saved my recovery code" before going on.
route('recovery-code', async () => {
  const c = freshCode;
  if (!c) {
    // Reached again (a reload, the Back button): the code is gone from this page on purpose.
    const dev = await get('/api/local/device', { quiet: true }).catch(() => null);
    return h('div', {}, pageHead('Recovery code'),
      h('div', { class: 'banner info mb', 'data-recovery-gone': '1' }, h('div', {}, 'A recovery code is shown only once, when it is made. If you did not save the one shown then, make a new one: the old one stops working.')),
      recoveryCard(dev, () => nav('sync')) || h('p', {}, h('a', { href: '#/sync' }, 'This device')));
  }
  const f = form([
    { name: 'saved', label: 'I have saved my recovery code somewhere safe, away from this device', type: 'checkbox', span: true },
  ], { submitText: 'Continue', onSubmit: async (d) => {
    if (!d.saved) { const e = new Error('Tick the box once you have saved the recovery code'); e.labelled = true; e.data = { fields: { saved: 'Save the code, then tick the box' } }; throw e; }
    await post('/api/local/recovery/saved', {});
    freshCode = null;
    toast('Recovery code saved. Keep it safe.', 'ok');
    navAndRender(c.after || 'dashboard');
  } });
  return h('div', { 'data-recovery-screen': '1' }, pageHead(c.recovered ? 'Your new recovery code' : 'Your recovery code'),
    c.recovered ? h('div', { class: 'banner ok mb', role: 'status', 'data-recovered': '1' }, h('div', {}, h('b', {}, 'You are back in. '), c.username ? `Your username is “${c.username}” and your new password is set. ` : 'Your new password is set. ', 'The recovery code you used no longer works: here is a new one to keep instead.')) : null,
    h('div', { class: 'card' },
      h('p', {}, 'If you ever forget your password, this code lets you back into SUDS on this device and choose a new password, keeping every record. On the sign-in page choose ', h('b', {}, 'Can’t sign in?'), ' → ', h('b', {}, 'Use your recovery code'), '.'),
      h('div', { class: 'recovery-code', 'data-recovery-code': '1' }, c.code),
      h('p', { class: 'small muted' }, `Made ${fmt.dt(c.createdAt)}. Capitals and dashes do not matter when you type it.`),
      h('div', { class: 'banner warn', 'data-recovery-warning': '1' }, h('div', {}, h('b', {}, 'This is the only time it is shown. '), 'SUDS does not keep a copy, so nobody can show it to you again. Keep it away from this device, on paper in a safe place or in a password manager: whoever has the code can open every record on this device, the way a key would.')),
      // Printing it, or saving it straight to another device, keeps it off this one (security review of 1.15.3,
      // L1): a file saved here sits next to the records it opens.
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', 'data-recovery-print': '1', onClick: () => printCode(c) }, 'Print it'),
        h('button', { type: 'button', class: 'btn', 'data-recovery-download': '1', onClick: () => downloadCode(c) }, 'Save to another device (as a file)')),
      h('p', { class: 'small muted', 'data-recovery-file-hint': '1' }, 'Saving asks where to put the file: choose a USB stick or a folder that is not on this device, or move the file there afterwards and delete it here. A copy left on this device is found by anyone who uses it.'),
      f));
});

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
  // The office that served this page: the Content-Security-Policy (connect-src 'self', server/csp.js) lets a
  // browser sync only with the site it opened SUDS from.
  const serverGuess = st.server || location.origin;
  // What this device holds, as the office last said (local/sync.js scopeStatus).
  const fieldDevice = !!(st.device && st.device.scope === 'field');
  const fieldInfo = fieldDevice ? st.device.field : null;
  const log = h('div', { class: 'small muted mt', 'data-sync-log': '1' });
  const f = form([
    { name: 'server', label: 'Office SUDS address', required: true, value: serverGuess, help: 'The address you opened SUDS from (this browser can sync only with that office SUDS). Shown under Settings → Network & devices on the office computer.', span: true },
    { name: 'username', label: 'Your office username', required: true, value: st.username || state.user.username },
    // A field literally named "password" next to a filled-in username is exactly the pattern browsers scan
    // for when deciding what to autofill — autocomplete="off" is routinely ignored for that pattern, so it
    // was quietly prefilled with the local sign-in credential (a different, unrelated password). A field
    // name the browser has no saved credential for, plus autocomplete="new-password" (which browsers do
    // still honor, unlike "off"), keeps this field empty until the person types into it themselves.
    { name: 'office_password', label: 'Office password', type: 'password', required: true, autocomplete: 'new-password', help: 'Your office SUDS account password — not the password you use to unlock this device.' },
    { name: 'code', label: '2-step code (if your office account uses it)', placeholder: '123456' },
    // A field device (1.21.0, server/field-scope.js): its user may narrow what it holds as they enrol it; only an
    // administrator can widen it again (Settings -> Synced devices).
    ...(fieldDevice ? [] : [{ name: 'field_device', label: 'Keep only what I need in the field on this device (field device)', type: 'checkbox', span: true,
      help: 'The device then holds your own clients assigned or seen recently (name, participant code and safety flags only), your contacts, to-dos, supplies and lists — no notes, documents, consents or intake details. Only an administrator can change it back.' }]),
  ], { submitText: 'Sync now', onSubmit: async (d) => {
    log.textContent = 'Connecting…';
    try {
      const { office_password, field_device: fd, ...rest } = d;
      if (fd) rest.field_device = true;
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
      // What the sync brought down (to-dos, change notices) is on the bell now, not after its minute's cache (r8 M2).
      toast('Sync complete', 'ok'); await loadSession(); forgetDue();
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
          h('p', { class: 'small muted mt' }, 'Your records stay in this browser, encrypted with the passwords of the accounts on this device, and are never sent anywhere. Clearing this browser’s site data erases them, and a forgotten password with no other account here locks them away for good, so keep a recent backup.')),
        await safetyCard(dev, refresh),
        recoveryCard(dev, refresh),
        accountsCard(dev, refresh),
        h('div', { class: 'card' }, h('h2', {}, 'Office server'), h('div', { class: 'banner info', 'data-static-no-sync': '1' }, h('div', {}, STATIC_HOST_MESSAGE)), h('div', { class: 'btn-row mt' }, eraseDeviceButton())),
        await sampleDataCard(refresh)));
  }
  // The copy is encrypted under a key only a device account's password opens (local/vault.js); what that
  // does and does not protect is said here, where someone is about to put real client information into it.
  return h('div', {}, pageHead('Sync with the office'),
    h('div', { class: 'banner warn mb', 'data-device-protection': '1' }, h('b', {}, 'This is an offline copy of the office SUDS. '),
      'Its records are encrypted with your device password and locked whenever you log out or step away, so a lost device does not give them up without that password. While you are logged in they are open on this device: log out when you put it down. If you forget the password, the records here cannot be opened; anything not yet synced is lost and the rest comes back from the office when the device is set up again. Keep real client information on the office SUDS unless your administrator has approved this device for field work.'),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Status'), kv([['This device', badge('Local copy', 'info')], ['Holds', h('span', { 'data-device-holds': fieldDevice ? 'field' : 'full' }, fieldDevice ? badge('Field device', 'info') : 'Everything you may see')], ['Data protection', badge('Encrypted, opened by your password', 'ok')], ['Last sync', st.last_sync_at ? fmt.dt(st.last_sync_at) : 'never'], ['Changes waiting to send', String(st.pending)], ['Office server', st.server || 'not set yet']]),
        fieldDevice ? h('p', { class: 'small mt', 'data-field-device-status': '1' }, h('b', {}, 'Field device: '), `holds only ${(fieldInfo && fieldInfo.holds) || 'what you need in the field'}. Everything else stays at the office. Your administrator decides this (Settings › Synced devices on the office SUDS).`) : null,
        h('p', { class: 'small muted mt' }, fieldDevice ? 'Sync exchanges what this field device holds in both directions. The office SUDS decides: the newest change wins, a change it rejects for good is not sent again, and a record outside what a field device holds is not accepted from it.' : 'Sync exchanges clients, visits, calls, notes, reminders, referrals and everything else in both directions. The office SUDS decides: the newest change wins, a change it rejects for good is not sent again, and a record the office has purged or merged does not come back.')),
      h('div', { class: 'card' }, h('h2', {}, 'Sync now'), h('p', { class: 'small muted' }, 'Connect this device to the office Wi-Fi (or the address IT gave you), then sign in with your office account.'), f, log,
        h('div', { class: 'btn-row' }, eraseDeviceButton())),
      await safetyCard(dev, refresh),
      recoveryCard(dev, refresh),
      await sampleDataCard(refresh)));
});

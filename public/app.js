// SUDS frontend core: API client, hash router, DOM + form helpers, session/idle handling.
export const state = { user: null, org: 'SUDS', constants: null, users: [], funds: [], idleMinutes: 15, prefs: {}, local: false };
// Local mode: the whole server runs inside this page (the offline copy). Requests go to the in-page kernel.
// window.SUDS_FORCE_LOCAL is set by a small external script tag, before this module loads, on builds
// meant to run with no backend at all (e.g. a static hosting deploy of public/ — see
// scripts/build-static-site.js). External, not inline, so it works under the CSP the office server sends.
// It is distinct from window.SUDS_LOCAL, which the boot sequence itself sets only after local mode is
// already chosen, so it cannot be used to make that choice.
export function isLocalMode() { try { return new URLSearchParams(location.search).get('local') === '1' || location.protocol === 'file:' || location.protocol === 'suds:' || location.hostname === 'appassets.androidplatform.net' || window.SUDS_FORCE_LOCAL === true || !!window.SUDS_LOCAL; } catch { return false; } }

// ---------- workspace preferences (follow the user across devices) ----------
let prefsTimer; const prefsDirty = {};
export const prefs = {
  get: (k, d) => (state.prefs[k] === undefined ? d : state.prefs[k]),
  set(k, v) { state.prefs[k] = v; prefsDirty[k] = v; try { localStorage.setItem('suds.prefs', JSON.stringify(state.prefs)); } catch {} clearTimeout(prefsTimer); prefsTimer = setTimeout(prefs.flush, 800); },
  async flush() {
    const body = { ...prefsDirty };
    if (!Object.keys(body).length || !state.user) return;
    for (const k of Object.keys(body)) delete prefsDirty[k];
    // On failure the change stays pending rather than being dropped, so the next save retries it — this
    // used to lose a filter or a theme choice with no sign anything had happened.
    try { await put('/api/me/prefs', body, { quiet: true }); }
    catch { Object.assign(prefsDirty, body); }
  },
  async load() { try { state.prefs = (await get('/api/me/prefs', { quiet: true })).prefs || {}; try { localStorage.setItem('suds.prefs', JSON.stringify(state.prefs)); } catch {} } catch { try { state.prefs = JSON.parse(localStorage.getItem('suds.prefs') || '{}'); } catch { state.prefs = {}; } } applyTheme(); },
};
function applyTheme() { const t = state.prefs.theme; if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }

// ---------- images ----------
// Pictures are served as ordinary image URLs rather than base64 inside JSON, which keeps list responses
// small. In local mode there is no HTTP server behind those URLs, so the bytes come from the in-page
// kernel and become an object URL instead.
const objectUrls = new Map();
// A freshly-picked picture (a resource photo, right after upload) is passed around as a data: URL — the
// browser's own canvas output — before anything has round-tripped through the server. That is already a
// usable image source on its own; it is never something the local kernel's router can answer a GET for.
const isInlineImageSrc = (path) => typeof path === 'string' && /^(data|blob):/.test(path);
export function img(path, attrs = {}) {
  const local = state.local && !isInlineImageSrc(path);
  const el = h('img', { ...attrs, src: local ? TRANSPARENT_PIXEL : path });
  if (local) {
    if (objectUrls.has(path)) el.src = objectUrls.get(path);
    else {
      window.SUDS_LOCAL.handle('GET', path, undefined, {}).then((r) => {
        if (!r || r.status >= 400 || !r.body) return;
        const url = URL.createObjectURL(new Blob([r.body], { type: r.headers['content-type'] || 'image/png' }));
        objectUrls.set(path, url);
        el.src = url;
      }).catch(() => {});
    }
  }
  return el;
}
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/** Point an existing <img> at a server path, going through the local kernel when there is no server. */
export function setImage(el, path) {
  if (!el) return;
  if (!state.local || isInlineImageSrc(path)) { el.src = path; return; }
  if (objectUrls.has(path)) { el.src = objectUrls.get(path); return; }
  el.src = TRANSPARENT_PIXEL;
  window.SUDS_LOCAL.handle('GET', path, undefined, {}).then((r) => {
    if (!r || r.status >= 400 || !r.body) return;
    const url = URL.createObjectURL(new Blob([r.body], { type: r.headers['content-type'] || 'image/png' }));
    objectUrls.set(path, url); el.src = url;
  }).catch(() => {});
}

// ---------- API ----------
// A request the person did not just cause — the reminder bell's poll, the dashboard's auto-refresh, a
// quiet lookup — must not count as activity, or a tab left open never times out (H1). `background: true`
// says so explicitly; `quiet` requests are treated the same; and any request made after a minute with no
// input at all cannot have been the person either. Such requests carry X-Background: 1 so the office
// server leaves the session's last-seen time alone as well (server/auth.js).
const BACKGROUND_AFTER_MS = 60_000;
function isBackground(opts) { return opts.background === true || opts.quiet === true || Date.now() - lastActivity > BACKGROUND_AFTER_MS; }

export async function api(method, path, body, opts = {}) {
  const background = isBackground(opts);
  const headers = { 'X-Requested-With': 'suds', ...(background ? { 'X-Background': '1' } : {}), ...(opts.headers || {}) };
  if (state.local && window.SUDS_LOCAL) {
    let payload = body; if (body instanceof Blob) payload = await body.arrayBuffer();
    const r = await window.SUDS_LOCAL.handle(method, path, payload, headers);
    if (!background) touch();
    const data = r.json !== undefined ? r.json : (r.body ? (String(r.headers['content-type'] || '').includes('json') ? JSON.parse(r.body.toString()) : r.body.toString()) : null);
    if (r.status === 401 && state.user && !opts.quiet) { if (data && data.mfaRequired) location.hash = '#/mfa'; else { state.user = null; render(); } }
    if (r.status === 403 && data && data.passwordChangeRequired) location.hash = '#/profile?force=1';
    if (r.status >= 400) { const err = new Error((data && data.error) || `Request failed (${r.status})`); err.status = r.status; err.data = data; throw err; }
    return data;
  }
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer || typeof body === 'string') { payload = body; if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch (e) {
    // A dropped connection used to surface as "Failed to fetch" (or nothing at all) and the dialog sat
    // there with the entry in it. Say what happened, keep the form open, and put the banner up.
    setOffline(true);
    const err = new Error(OFFLINE_MESSAGE); err.offline = true; err.cause = e; throw err;
  }
  setOffline(false);
  if (!background) touch();
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && state.user && !opts.quiet) { if (data && data.mfaRequired) { location.hash = '#/mfa'; } else { state.user = null; render(); toast('Session expired. Please sign in again.', 'error'); } }
  if (res.status === 403 && data && data.passwordChangeRequired) { location.hash = '#/profile?force=1'; }
  if (!res.ok) { const err = new Error((data && data.error) || `Request failed (${res.status})`); err.status = res.status; err.data = data; throw err; }
  return data;
}
export const get = (p, o) => api('GET', p, undefined, o), post = (p, b, o) => api('POST', p, b, o), put = (p, b, o) => api('PUT', p, b, o), del = (p, b, o) => api('DELETE', p, b, o);

// ---------- offline ----------
// Office mode has no offline store (PHI never sits in browser storage), so the one honest thing to do when
// the network goes is say so, loudly, everywhere -- including on a sign-in screen served from the cached
// shell, which used to just bounce back to the form as if the password were wrong.
export const OFFLINE_MESSAGE = 'You appear to be offline. Your entry has been kept in this form — try again when you have signal.';
let offlineBanner = null;
export function setOffline(on) {
  if (state.local) return; // the on-device copy keeps working without a network
  if (on === state.offline) return;
  state.offline = on;
  document.documentElement.classList.toggle('offline', on);
  if (on) {
    offlineBanner = banner('Offline — changes can\'t be saved until you reconnect. SUDS needs a connection to the office server.', 'error', { id: 'offline' });
    if (offlineBanner) offlineBanner.firstChild.append(' ', h('a', { href: 'get-app.html', class: 'small' }, 'Use SUDS on this device'));
  } else {
    document.querySelectorAll('#banners [data-banner="offline"]').forEach(b => b.remove());
    if (offlineBanner) { toast('Back online', 'ok'); offlineBanner = null; }
  }
}
window.addEventListener('offline', () => setOffline(true));
window.addEventListener('online', () => setOffline(false));

// ---------- tap-to-call / text / map ----------
// A phone number on a screen is something a navigator standing on a sidewalk wants to tap, not copy.
const telDigits = (p) => String(p || '').trim().replace(/[^\d+]/g, '');
const swallow = (e) => e.stopPropagation(); // links live inside rows that are themselves clickable
export function telLink(phone) { return phone ? h('a', { href: `tel:${telDigits(phone)}`, class: 'tel nowrap', onClick: swallow }, phone) : null; }
export function smsLink(phone, label = 'Text') { return phone ? h('a', { href: `sms:${telDigits(phone)}`, class: 'sms small', 'aria-label': `Text ${phone}`, onClick: swallow }, label) : null; }
export function contactLinks(phone) { return phone ? h('span', { class: 'contact' }, telLink(phone), ' ', h('span', { class: 'muted small' }, '·'), ' ', smsLink(phone)) : null; }
export function mapLink(address, label) { return address ? h('a', { href: 'https://maps.google.com/?q=' + encodeURIComponent(address), target: '_blank', rel: 'noopener', class: 'maplink', title: 'Open in maps', onClick: swallow }, label || address) : null; }
/** Open a tel:/sms: link the way a tap on an anchor would (the OS decides what handles it). */
export function openHref(href) { const a = h('a', { href }); document.body.append(a); a.click(); a.remove(); }

// ---------- DOM helpers ----------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) { for (const c of children.flat(Infinity)) { if (c === null || c === undefined || c === false) continue; el.append(c instanceof Node ? c : document.createTextNode(String(c))); } }
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function frag(...children) { const f = document.createDocumentFragment(); append(f, children); return f; }

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').append(t);
  announce(msg);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}

// A single polite live region. Screen readers announce anything written here, which is how a toast, a
// validation failure or a background save error reaches someone not looking at the screen.
let liveRegion;
export function announce(message) {
  if (!liveRegion) {
    liveRegion = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(liveRegion);
  }
  // Clearing first makes a repeated message announce again.
  liveRegion.textContent = '';
  clearTimeout(liveRegion._clear);
  setTimeout(() => { liveRegion.textContent = String(message || ''); }, 50);
  // A live region only needs its text long enough to be read out. Left in place, the last announcement
  // (a dialog title such as "Add resource") stays in the accessibility tree of every page visited
  // afterwards, as a stray text node that has nothing to do with what is on screen.
  liveRegion._clear = setTimeout(() => { liveRegion.textContent = ''; }, 4000);
}

/**
 * A message that stays until it is dismissed, for conditions the user has to act on rather than
 * acknowledge in passing — a device that has stopped saving, a consent that was revoked.
 */
export function banner(message, kind = 'warn', { id = message } = {}) {
  const host = document.getElementById('banners') || (() => { const b = h('div', { id: 'banners' }); document.body.prepend(b); return b; })();
  if (host.querySelector(`[data-banner="${CSS.escape(String(id))}"]`)) return;
  const el = h('div', { class: `banner ${kind}`, 'data-banner': String(id), role: 'alert' },
    h('span', {}, message),
    h('button', { class: 'btn ghost sm', 'aria-label': 'Dismiss', onClick: () => el.remove() }, '✕'));
  host.append(el);
  announce(message);
  return el;
}
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function modal(title, content, { wide = false, onClose = null } = {}) {
  const root = document.getElementById('modal-root');
  const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 9);
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'card-head' }, h('h2', { id: titleId }, title), h('button', { class: 'btn ghost sm', onClick: close, 'aria-label': 'Close' }, '✕')), content);
  const bg = h('div', { class: 'modal-bg', onClick: (e) => { if (e.target === bg) close(); } }, box);
  // Remember where focus was, so closing the dialog returns the keyboard to what opened it.
  // activeElement can be null, and document.contains() throws on anything that is not a Node.
  const opener = document.activeElement instanceof Element ? document.activeElement : null;
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    bg.remove();
    document.removeEventListener('keydown', onKey);
    if (opener && document.contains(opener) && typeof opener.focus === 'function') { try { opener.focus(); } catch { /* the element may have been replaced by a re-render */ } }
    if (onClose) onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    // Keep Tab inside the dialog: a keyboard user must not tab out into the page behind it.
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey);
  root.append(bg);
  announce(title);
  const first = box.querySelector('input,select,textarea,button.primary') || box.querySelector(FOCUSABLE);
  if (first) first.focus();
  return { close, el: box };
}
export function confirmDialog(title, message, { danger = false, okText = 'Confirm', requireReason = false, minLength = 0 } = {}) {
  return new Promise((resolve) => {
    let reason;
    const err = h('div', { class: 'err', role: 'alert' });
    const m = modal(title, h('div', {}, h('p', {}, message), requireReason ? h('div', { class: 'field' }, h('label', {}, `Reason (recorded in audit log${minLength ? `, at least ${minLength} characters` : ''})`), reason = h('input', { required: true, minLength: minLength || null }), err) : null,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => { m.close(); resolve(null); } }, 'Cancel'), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => {
        if (requireReason) {
          const text = reason.value.trim();
          // Say what is wrong rather than quietly refusing: a too-short reason used to look like a button that did nothing.
          if (!text || text.length < minLength) { err.textContent = !text ? 'A reason is required.' : `The reason must be at least ${minLength} characters — say why, so it can be reviewed.`; reason.closest('.field').classList.add('error'); reason.setAttribute('aria-invalid', 'true'); reason.focus(); return; }
        }
        m.close(); resolve(requireReason ? reason.value.trim() : true);
      } }, okText))));
  });
}

// A locked-out or forgotten-password local device has no admin to ask for a reset, and a device whose
// kernel failed to start (a bad migration, a lost encryption key) never even reaches window.SUDS_LOCAL —
// so this talks to the on-device IndexedDB store directly, the same one local/shims/sqlite.js persists to,
// rather than going through the kernel. Duplicated rather than imported: public/ is unbundled and cannot
// reach a module esbuild wrote for local/kernel.js's bundle. Keep the store/key names in sync with that file.
function wipeLocalDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('suds-local', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const t = req.result.transaction('kv', 'readwrite');
      t.objectStore('kv').delete('db');
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    };
  }).then(() => { try { localStorage.removeItem('suds.local.session'); } catch {} });
}
/** The typed-confirmation dialog behind both offerDeviceReset() and eraseDeviceButton() below. The erase
 *  button starts disabled and only enables once the typed text matches exactly — a reason field that is
 *  merely non-empty (the pattern confirmDialog's requireReason uses elsewhere) is not a strong enough gate
 *  for something this irreversible and reachable with a single click. */
function openDeviceResetDialog(onDone) {
  let confirmBox, eraseBtn;
  const m = modal('Reset this device', h('div', {},
    h('p', {}, 'This permanently erases everything SUDS has stored on this device — clients, visits, notes, everything — and signs out whatever account is set up here. There is no undo.'),
    h('p', { class: 'banner warn small' }, 'Anything recorded on this device that has not been synced to the office SUDS server is lost for good. If there is any chance the office server has a copy and you can reach it later, consider waiting instead.'),
    h('p', {}, 'Afterwards this device is treated as brand new: the first-run setup runs again and a new local account is created.'),
    h('div', { class: 'field' }, h('label', { for: 'reset-device-confirm' }, 'Type ERASE to confirm *'),
      confirmBox = h('input', { id: 'reset-device-confirm', autocomplete: 'off', onInput: () => { eraseBtn.disabled = confirmBox.value.trim() !== 'ERASE'; } })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
      eraseBtn = h('button', { class: 'btn danger', disabled: true, onClick: async () => {
        if (confirmBox.value.trim() !== 'ERASE') { confirmBox.focus(); return; }
        await wipeLocalDatabase();
        m.close();
        onDone ? onDone() : location.reload();
      } }, 'Erase this device'))));
}
/** A "Reset this device" link + typed-confirmation dialog, usable wherever a local device might need
 *  self-service recovery: the normal login screen, and the boot-failure screen (see boot() below), which
 *  cannot rely on window.SUDS_LOCAL because reaching it is exactly what failed. */
export function offerDeviceReset({ onDone } = {}) {
  return h('p', { class: 'small muted center mt' },
    'Locked out or forgot your password? ',
    h('a', { href: '#', onClick: (e) => { e.preventDefault(); openDeviceResetDialog(onDone); } }, 'Reset this device'),
    ' — this erases all SUDS data stored here and starts over.');
}
/** A plain "Erase data on this device" button for someone already signed in and choosing this on purpose
 *  (the Sync page), rather than someone locked out — same dialog, without the "locked out?" framing. */
export function eraseDeviceButton({ label = 'Erase data on this device', onDone } = {}) {
  return h('button', { class: 'btn danger sm', onClick: () => openDeviceResetDialog(onDone) }, label);
}

// ---------- formatting ----------
export const fmt = {
  // A value like 2026-09-26 is a calendar day, not an instant: parse it as local midnight so it never drifts to the day before.
  isDateOnly: (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s),
  parse: (s) => { if (!s) return null; if (fmt.isDateOnly(s)) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); } const d = new Date(s); return isNaN(d) ? null : d; },
  date: (s) => { const d = fmt.parse(s); return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; },
  dt: (s) => { const d = fmt.parse(s); if (!d) return '—'; return fmt.isDateOnly(s) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); },
  time: (s) => { const d = fmt.parse(s); return d && !fmt.isDateOnly(s) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''; },
  // Past due? A calendar-day deadline is only late once that whole local day has ended.
  isPast: (s) => { const d = fmt.parse(s); if (!d) return false; if (fmt.isDateOnly(s)) d.setHours(23, 59, 59, 999); return d.getTime() < Date.now(); },
  money: (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' }),
  bytes: (n) => { n = Number(n || 0); const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`; },
  num: (n) => Number(n || 0).toLocaleString(),
  mins: (m) => { m = Number(m || 0); const hh = Math.floor(m / 60), mm = m % 60; return hh ? `${hh}h ${mm}m` : `${mm}m`; },
  label: (s) => s ? String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSbirt\b/, 'SBIRT').replace(/\bMat\b/g, 'MAT').replace(/\bOtp\b/, 'OTP').replace(/\bObot\b/, 'OBOT').replace(/\bEd\b/, 'ED').replace(/\bMh\b/, 'MH').replace(/\bRx\b/, 'Rx').replace(/\bIds\b/, 'IDs').replace(/\bRoi\b/, 'ROI') : '—',
  ago: (s) => { const p = fmt.parse(s); if (!p) return 'never'; const d = (Date.now() - p.getTime()) / 86400000; if (d < 1) return 'today'; if (d < 2) return 'yesterday'; return `${Math.floor(d)}d ago`; },
  isoLocal: (d = new Date()) => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; },
  today: () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },
};
export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }
// A client's programme status as shown on screen. Rows from before the status column was enforced can
// carry NULL or "" (server/db.js migration 19 backfills them); a blank badge in the header looked like
// a missing record, so the schema default is what an empty value means here too.
export const clientStatus = (c) => { const s = c && typeof c.status === 'string' ? c.status.trim() : ''; return s || 'active'; };
export const statusKind = (s) => ({ active: 'ok', admitted: 'ok', completed: 'ok', done: 'ok', signed: 'ok', approved: 'ok', reimbursed: 'ok', reached: 'ok', replied: 'ok',
  waitlist: 'warn', pending: 'warn', waitlisted: 'warn', scheduled: 'info', contacted: 'info', accepted: 'info', in_progress: 'info', open: 'info', draft: 'warn', amended: 'purple', staged: 'warn', committed: 'ok',
  inactive: '', closed: '', cancelled: '', discarded: '', rejected: 'danger', deceased: 'danger', no_show: 'danger', declined_by_client: 'danger', declined_by_provider: 'danger', critical: 'danger', high: 'warn', urgent: 'danger', crisis_escalated: 'danger', no_reply: 'warn', sent: 'info', undeliverable: 'danger', opted_out: 'danger' }[s] || '');
export const can = (perm) => { const u = state.user; if (!u) return false; const p = u.permissions || []; if (p.includes(perm)) return true; const [ns] = perm.split(':'); if (p.includes(`${ns}:*`)) return true; if (perm.endsWith(':read') && p.includes(perm.replace(/:read$/, ':write'))) return true; return false; };

// ---------- forms ----------
// fields: [{name,label,type:'text|number|date|datetime|select|textarea|checkbox|client|user|resource|fund', options, required, value, span, help, min, max, step}]
// Unsaved form contents, kept in memory only. Deliberately not localStorage: a half-typed intake form is
// PHI, and this app's whole design keeps PHI out of browser storage. Memory survives a closed dialog, a
// route change and an idle sign-out within the same tab, which is what was actually being lost.
const drafts = new Map();
export function discardDraft(key) { drafts.delete(key); }
export function hasDraft(key) { return drafts.has(key); }

// A "date & time" field is a date input and a separate, optional time input rather than one
// datetime-local control. Every browser renders those two natively and predictably (a calendar and a
// clock), whereas datetime-local swallows a date entered without a time — value reads as "" while the
// box still shows the date — and its picker is awkward on phones. The wrapper exposes `.value` in the
// shape the drafts and read() expect: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM" or "".
function dateTimePair(f, v) {
  const dateI = h('input', { type: 'date', name: f.name, required: !!f.required, 'aria-label': `${f.label} — date` });
  const timeI = h('input', { type: 'time', name: `${f.name}_time`, 'aria-label': `${f.label} — time (optional)` });
  const wrap = h('div', { class: 'dt-pair' }, dateI, timeI);
  wrap.dateInput = dateI; wrap.timeInput = timeI;
  Object.defineProperty(wrap, 'value', {
    get: () => dateI.value ? (timeI.value ? `${dateI.value}T${timeI.value}` : dateI.value) : '',
    set: (x) => {
      const s = x == null ? '' : String(x);
      if (!s) { dateI.value = ''; timeI.value = ''; return; }
      if (fmt.isDateOnly(s)) { dateI.value = s; timeI.value = ''; return; }
      const d = new Date(s); if (isNaN(d)) { dateI.value = ''; timeI.value = ''; return; }
      const local = fmt.isoLocal(d); dateI.value = local.slice(0, 10); timeI.value = local.slice(11, 16);
    },
  });
  wrap.value = v;
  return wrap;
}

export function form(fields, { values = {}, submitText = 'Save', onSubmit, onCancel, cancelText = 'Cancel', extra, draftKey } = {}) {
  const inputs = {};
  const grid = h('div', { class: 'form-grid' });
  let target = grid;
  for (const f of fields) {
    if (f.type === 'section') {
      if (f.collapsible) { const inner = h('div', { class: 'form-grid' }); grid.append(h('details', { class: 'section', open: !!f.open }, h('summary', {}, f.label, f.hint ? h('span', { class: 'muted small' }, ` — ${f.hint}`) : null), inner)); target = inner; }
      else { target = grid; grid.append(h('div', { class: 'span' }, h('h4', {}, f.label))); }
      continue;
    }
    let input; const v = values[f.name] ?? f.value ?? '';
    const opts = (f.options || []).map(o => typeof o === 'string' ? { value: o, label: fmt.label(o) } : o);
    switch (f.type) {
      case 'select': input = h('select', { name: f.name, required: !!f.required }, f.noBlank ? null : h('option', { value: '' }, f.placeholder || '—'), opts.map(o => h('option', { value: o.value, selected: String(o.value) === String(v), disabled: !!o.disabled, title: o.title || null }, o.label))); break;
      case 'textarea': input = h('textarea', { name: f.name, required: !!f.required, rows: f.rows || 4, placeholder: f.placeholder || '' }, v || ''); break;
      case 'checkbox': input = h('input', { type: 'checkbox', name: f.name, checked: !!(v === 1 || v === true || v === '1') }); break;
      case 'datetime': input = dateTimePair(f, v); break;
      case 'date': input = h('input', { type: 'date', name: f.name, required: !!f.required, value: v ? String(v).slice(0, 10) : '', min: f.min || null, max: f.max || null }); break;
      case 'number': input = h('input', { type: 'number', name: f.name, required: !!f.required, value: v ?? '', min: f.min, max: f.max, step: f.step ?? 'any', placeholder: f.placeholder || '' }); break;
      case 'client': input = clientPicker(f.name, v, f); break;
      case 'user': input = h('select', { name: f.name, required: !!f.required }, h('option', { value: '' }, f.placeholder || '—'), state.users.filter(u => u.is_active !== 0).map(u => h('option', { value: u.id, selected: u.id === v }, `${u.display_name} (${fmt.label(u.role)})`))); break;
      case 'fund': input = h('select', { name: f.name, required: !!f.required }, h('option', { value: '' }, '—'), state.funds.map(x => h('option', { value: x.id, selected: x.id === v }, x.name))); break;
      case 'password': input = h('input', { type: 'password', name: f.name, required: !!f.required, autocomplete: f.autocomplete || 'current-password' }); break;
      // A phone number field brings up the dial pad on a phone, not the full keyboard.
      case 'tel': input = h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'off', name: f.name, required: !!f.required, value: v ?? '', placeholder: f.placeholder || '' }); break;
      default: input = h('input', { type: f.type || 'text', name: f.name, required: !!f.required, value: v ?? '', placeholder: f.placeholder || '', maxlength: f.maxLen, pattern: f.pattern, autocomplete: f.autocomplete || 'off' });
    }
    inputs[f.name] = input;
    // Label, help text and any error are tied to the control by id, so a screen reader reads the field's
    // name, its guidance and what went wrong — rather than just "edit text".
    const fieldId = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
    const helpId = f.help ? `${fieldId}-help` : null;
    const errId = `${fieldId}-err`;
    // A date & time field is two controls; the label points at the date, and both are described alike.
    for (const ctl of input && input.dateInput ? [input.dateInput, input.timeInput] : [input]) {
      if (!ctl || !ctl.tagName) continue;
      ctl.id = ctl === input.timeInput ? `${fieldId}-time` : fieldId;
      ctl.setAttribute('aria-describedby', [helpId, errId].filter(Boolean).join(' '));
      if (f.required && ctl !== input.timeInput) ctl.setAttribute('aria-required', 'true');
    }
    const errEl = h('div', { class: 'err', id: errId, role: 'alert' });
    const wrap = h('div', { class: `field ${f.span ? 'span' : ''}`, 'data-field': f.name },
      f.type === 'checkbox' ? h('label', { class: 'check', for: fieldId }, input, f.label) : [h('label', { for: fieldId }, f.label, f.required ? ' *' : ''), input],
      f.help ? h('div', { class: 'help', id: helpId }, f.help) : null, errEl);
    target.append(wrap);
  }
  // A draft kept from an earlier attempt at this same form wins over the defaults.
  const restored = draftKey && drafts.get(draftKey);
  if (restored) for (const [k, v] of Object.entries(restored)) { const i = inputs[k]; if (!i) continue; if (i.type === 'checkbox') i.checked = !!v; else i.value = v ?? ''; }
  const errBox = h('div', { class: 'banner danger hidden', role: 'alert', tabindex: '-1' });
  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, submitText);
  let submitted = false; let saveTimer;
  // noValidate: the browser's own constraint validation can silently refuse to even dispatch the submit
  // event for a field it considers invalid — including, on some mobile browsers/WebViews, a non-required
  // datetime-local field stuck in a broken partial state that never fires our onSubmit at all, so nothing
  // in this file ever gets a chance to show an error. read() below now does its own required-field and
  // bad-input checking and reports it through the same on-screen banner as every other validation error,
  // so nothing here depends on a native UI that does not reliably render on every platform.
  const el = h('form', { noValidate: true, onSubmit: async (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    submitBtn.disabled = true;
    // Everything from clearing the old errors onwards is inside the try: whatever throws — read() on a
    // half-entered date, the request itself, or a DOM assumption that a view broke (the resource form
    // adds `.field` blocks of its own without an `.err` slot, and clearing them used to throw before
    // the request was even sent) — ends up in the banner, never in an unhandled rejection that leaves
    // the dialog sitting there looking like nothing happened.
    try {
      el.querySelectorAll('.field').forEach(x => { x.classList.remove('error'); const errSlot = x.querySelector('.err'); if (errSlot) errSlot.textContent = ''; const c = x.querySelector('input,select,textarea'); if (c) c.removeAttribute('aria-invalid'); });
      const data = read(); await onSubmit(data, el);
      // Saved: the draft is finished with, and no autosave still queued behind this submit may put it back
      // — the debounced savers below used to fire after the delete, so the next "+ New client" opened
      // prefilled with the person just created.
      submitted = true; clearTimeout(saveTimer); if (draftKey) drafts.delete(draftKey);
    } catch (err) {
      if (!err || typeof err !== 'object') err = new Error(String(err || 'Something went wrong'));
      if (!err.message) err.message = 'Something went wrong. Try again.';
      const fieldsErr = err.data && err.data.fields;
      let firstBad = null;
      if (fieldsErr) for (const [k, msg] of Object.entries(fieldsErr)) {
        const w = el.querySelector(`[data-field="${k}"]`);
        if (!w) continue;
        w.classList.add('error');
        const slot = w.querySelector('.err'); if (slot) slot.textContent = msg;
        const control = w.querySelector('input,select,textarea');
        if (control) { control.setAttribute('aria-invalid', 'true'); if (!firstBad) firstBad = control; }
      }
      // Field errors are already shown inline under each field; the banner names them the way the form
      // does ("Client"), never by column ("client_id").
      const labelOf = (k) => (fields.find(f => f.name === k) || {}).label || k;
      const text = err.labelled ? err.message : err.message + (fieldsErr ? ': ' + Object.entries(fieldsErr).map(([k, m]) => `${labelOf(k)} ${m}`).join('; ') : '');
      errBox.textContent = text; errBox.classList.remove('hidden');
      // Say it out loud and put the cursor on the first thing that needs fixing, rather than leaving a
      // keyboard user to hunt for a red outline they cannot see.
      announce(text);
      (firstBad || errBox).focus({ preventScroll: false });
      (firstBad || errBox).scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally { submitBtn.disabled = false; }
  } }, restored ? h('div', { class: 'banner', role: 'status' },
    h('span', {}, 'Restored what you had already typed.'),
    h('button', { class: 'btn ghost sm', type: 'button', onClick: (e) => { drafts.delete(draftKey); e.target.closest('.banner').remove(); for (const f of fields) { const i = inputs[f.name]; if (!i) continue; if (i.type === 'checkbox') i.checked = false; else i.value = ''; } } }, 'Start over')) : null,
    errBox, grid, extra || null, h('div', { class: 'btn-row' }, onCancel ? h('button', { class: 'btn', type: 'button', onClick: onCancel }, cancelText) : null, submitBtn));

  // Keep what has been typed so a dialog closed by accident, a route change, or an idle sign-out does not
  // throw it away.
  if (draftKey) {
    // A field mid-typing an incomplete date/time is expected while drafting — read() now rejects that
    // rather than silently mangling it, so the autosave tick here just skips this round instead of
    // erroring; the field firms up (or clears) before the next tick or before the person tries to submit.
    const save = (onlyIfSomething) => { if (submitted) return; try { const d = read(); if (!onlyIfSomething || Object.values(d).some(v => v !== '' && v !== null && v !== undefined && v !== 0)) drafts.set(draftKey, d); } catch { /* firms up or gets fixed before submit */ } };
    el.addEventListener('input', () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(true), 400); });
    el.addEventListener('change', () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(false), 400); });
  }
  // For a dialog that closes this form after a save of its own (not through onSubmit): stop drafting.
  el.finished = () => { submitted = true; clearTimeout(saveTimer); if (draftKey) drafts.delete(draftKey); };
  function read() {
    const data = {}; const bad = []; const missing = [];
    for (const f of fields) {
      if (f.type === 'section') continue;
      const i = inputs[f.name];
      if (f.type === 'checkbox') data[f.name] = i.checked;
      else if (f.type === 'client') data[f.name] = i.value || null;
      else if (f.type === 'number') data[f.name] = i.value === '' ? null : Number(i.value);
      else if (f.type === 'datetime') {
        // A date and a separate, optional time. The old single datetime-local control silently dropped a
        // date typed without a time: the browser reports an empty value for a partial entry (validity
        // .badInput is set, but value is ""), so the field looked filled in and saved as nothing. Now a
        // date on its own is a valid answer, and anything the browser cannot parse is flagged by field.
        const d = i.dateInput, t = i.timeInput;
        if (d.validity?.badInput || t.validity?.badInput || (t.value && !d.value) || (d.value && !/^\d{4}-\d{2}-\d{2}$/.test(d.value))) { bad.push(f); data[f.name] = null; }
        else if (!d.value) data[f.name] = null;
        // A required date & time (a visit, a call) with no time is midnight local, so it orders among
        // that day's other records; an optional one (a due date, an appointment) is kept as the calendar
        // day itself, which the server and fmt.dt already understand (a to-do due "Oct 1" is due all day).
        else if (!t.value) data[f.name] = f.required ? new Date(`${d.value}T00:00`).toISOString() : d.value;
        else data[f.name] = new Date(`${d.value}T${t.value}`).toISOString();
      }
      else data[f.name] = i.value === '' ? null : i.value;
      if (f.required && (data[f.name] === null || data[f.name] === undefined || data[f.name] === '') && !bad.includes(f)) missing.push(f);
    }
    if (bad.length || missing.length) {
      const fields = { ...Object.fromEntries(bad.map(f => [f.name, 'enter a valid date (the time is optional), or leave both blank'])), ...Object.fromEntries(missing.map(f => [f.name, 'is required'])) };
      // Name the field the way the form does ("Client"), not the way the database does ("client_id").
      const names = missing.map(f => f.label).filter(Boolean);
      const e = new Error(bad.length ? 'Check the date below — it is not a valid date.' : names.length ? `Fill in ${names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]} below.` : 'Fill in the required field below.');
      e.labelled = true;
      e.data = { fields };
      throw e;
    }
    return data;
  }
  el.read = read; el.inputs = inputs;
  return el;
}

// Client picker: search-as-you-type against /api/clients?q=, stores id in hidden value
export function clientPicker(name, value, f = {}) {
  // A combobox, not a div that happens to respond to clicks: arrow keys move through the matches, Enter
  // chooses, Escape closes, and the whole thing is announced.
  const listId = `cp-${Math.random().toString(36).slice(2, 9)}`;
  const hidden = h('input', { type: 'hidden', name });
  const text = h('input', {
    type: 'text', placeholder: 'Search name, code, date of birth or exact phone…', autocomplete: 'off', required: !!f.required,
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list',
  });
  // The results sit in the flow of the form, pushing the fields under them down while open, rather than
  // floating over those fields: on a phone the list used to cover the next field (a task's due date), so
  // a tap on that field's date picker was swallowed — it either did nothing or chose whichever client
  // happened to be under the finger.
  const list = h('div', { class: 'card tight hidden client-picker-list', id: listId, role: 'listbox', style: { maxHeight: '220px', overflow: 'auto', marginTop: '.25rem' } });
  const wrap = h('div', { class: 'client-picker' }, text, hidden, list);
  Object.defineProperty(wrap, 'value', { get: () => hidden.value, set: (v) => { hidden.value = v || ''; } });
  hidden.value = value || '';
  if (value && f.display) text.value = f.display;
  else if (value) get(`/api/clients/${value}`, { quiet: true }).then(r => { text.value = `${r.client.display_name} (${r.client.client_code})`; }).catch(() => {});

  let timer; let options = []; let active = -1;
  const openList = (open) => { list.classList.toggle('hidden', !open); text.setAttribute('aria-expanded', String(open)); if (!open) { active = -1; text.removeAttribute('aria-activedescendant'); } };
  const highlight = (i) => {
    options.forEach((o, n) => { o.el.classList.toggle('active', n === i); o.el.setAttribute('aria-selected', String(n === i)); });
    active = i;
    if (options[i]) { text.setAttribute('aria-activedescendant', options[i].el.id); options[i].el.scrollIntoView({ block: 'nearest' }); }
  };
  const choose = (c) => {
    hidden.value = c.id; text.value = `${c.display_name} (${c.client_code})`;
    openList(false); wrap.dispatchEvent(new Event('change'));
    announce(`${c.display_name} selected`);
  };

  text.addEventListener('input', () => { hidden.value = ''; clearTimeout(timer); timer = setTimeout(search, 250); });
  text.addEventListener('focus', () => { if (!hidden.value) search(); });
  // The open list is positioned over whatever sits below the field — on a phone that is the next field
  // down (a task's due date, for one), and it kept intercepting taps meant for that field's date picker
  // because the "click outside" handler saw those taps as inside this picker. Close it when focus
  // leaves, deferred so a tap on one of its options (which takes focus first) still chooses it.
  text.addEventListener('blur', () => { setTimeout(() => { if (!wrap.contains(document.activeElement)) openList(false); }, 120); });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.classList.contains('hidden')) { search(); return; }
      e.preventDefault();
      if (!options.length) return;
      highlight(e.key === 'ArrowDown' ? (active + 1) % options.length : (active - 1 + options.length) % options.length);
    } else if (e.key === 'Enter') {
      if (active >= 0 && options[active]) { e.preventDefault(); choose(options[active].client); }
    } else if (e.key === 'Escape') {
      if (!list.classList.contains('hidden')) { e.preventDefault(); openList(false); }
    }
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) openList(false); });

  async function search() {
    const q = text.value.trim();
    try {
      const r = await get(`/api/clients?limit=15&status=all${q ? '&q=' + encodeURIComponent(q) : ''}`);
      clear(list); options = []; active = -1;
      if (!r.clients.length) {
        list.append(h('div', { class: 'muted small' }, q ? 'No matches. Try a first, last or preferred name, the full phone number, date of birth or client code.' : 'Type to search'));
        announce('No matching clients');
      } else {
        r.clients.forEach((c, i) => {
          const el = h('div', {
            class: 'list-item', id: `${listId}-o${i}`, role: 'option', 'aria-selected': 'false', tabindex: '-1',
            style: { cursor: 'pointer' },
            onClick: () => choose(c),
            // Keep focus on the search box while an option is pressed, so the blur-close above never
            // hides the list between the press and the click that chooses.
            onMousedown: (e) => e.preventDefault(),
            onMousemove: () => highlight(i),
          }, c.display_name, ' ', h('span', { class: 'muted small' }, c.client_code, ' · ', fmt.label(c.status)));
          options.push({ el, client: c });
          list.append(el);
        });
        announce(`${r.clients.length} matching client${r.clients.length === 1 ? '' : 's'}`);
      }
      openList(true);
    } catch { /* a failed lookup leaves the previous list alone */ }
  }
  return wrap;
}

// compact: { primary(r), secondary(r), onTap(r) } -- a two-line row per record on a phone instead of every
// column stacked as label/value pairs. The full table is still rendered for wider screens; CSS picks one.
export function table(columns, rows, { onRow, empty = 'No records', wrap = true, rowLabel, compact } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  // A clickable row must also be reachable and activatable from the keyboard, or the whole view is
  // mouse-only. tabindex + Enter/Space + a role is the minimum that makes that true.
  const rowAttrs = (r) => (onRow ? {
    class: 'click', tabindex: '0', role: 'button',
    'aria-label': rowLabel ? rowLabel(r) : undefined,
    onClick: () => onRow(r),
    onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow(r); } },
  } : {});
  const t = h('table', {}, h('thead', {}, h('tr', {}, columns.map(c => h('th', { class: c.num ? 'num' : '', scope: 'col' }, c.label)))),
    h('tbody', {}, rows.map(r => h('tr', rowAttrs(r), columns.map(c => h('td', { class: c.num ? 'num' : '', 'data-label': c.label || '' }, c.render ? c.render(r) : (r[c.key] ?? '—')))))));
  if (compact && wrap) {
    const tap = compact.onTap || onRow;
    const list = h('div', { class: 'compact-list' }, rows.map(r => h('div', tap ? {
      class: 'compact-row click', tabindex: '0', role: 'button', 'aria-label': rowLabel ? rowLabel(r) : undefined,
      onClick: () => tap(r), onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap(r); } },
    } : { class: 'compact-row' },
    h('div', { class: 'primary' }, compact.primary(r)), compact.secondary ? h('div', { class: 'secondary small muted' }, compact.secondary(r)) : null)));
    return h('div', { class: 'table-wrap has-compact' }, t, list);
  }
  return wrap ? h('div', { class: 'table-wrap' }, t) : t;
}

// A tab strip that folds the tabs that do not fit into a "More ▾" menu instead of scrolling them off the
// edge with nothing to say so. Re-measured on resize; the active tab is always kept in view.
export function tabStrip(tabs, active, onPick) {
  const strip = h('div', { class: 'tabs managed', role: 'tablist' });
  const buttons = tabs.map(([k, label]) => h('button', { class: k === active ? 'active' : '', role: 'tab', type: 'button', 'aria-selected': String(k === active), 'data-tab': k, onClick: () => onPick(k) }, label));
  const menu = h('div', { class: 'tabs-menu hidden', role: 'menu' });
  const moreBtn = h('button', { class: 'tabs-more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More tabs' }, 'More ▾');
  const wrap = h('div', { class: 'tabs-more-wrap' }, moreBtn, menu);
  strip.append(...buttons, wrap);
  const setOpen = (open) => { menu.classList.toggle('hidden', !open); moreBtn.setAttribute('aria-expanded', String(open)); if (open) (menu.querySelector('button.active') || menu.querySelector('button'))?.focus(); };
  moreBtn.addEventListener('click', () => setOpen(menu.classList.contains('hidden')));
  moreBtn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')]; const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); moreBtn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
  const onDoc = (e) => { if (!strip.isConnected) { document.removeEventListener('click', onDoc); return; } if (!wrap.contains(e.target)) setOpen(false); };
  document.addEventListener('click', onDoc);
  function layout() {
    for (const b of buttons) { b.hidden = false; strip.insertBefore(b, wrap); }
    clear(menu); wrap.hidden = false; moreBtn.textContent = `More (${buttons.length}) ▾`; // measured at its widest
    const avail = strip.clientWidth; if (!avail) return;
    const widths = buttons.map(b => b.offsetWidth + 4);
    if (widths.reduce((a, b) => a + b, 0) <= avail) { wrap.hidden = true; setOpen(false); return; }
    const limit = avail - (wrap.offsetWidth + 8);
    let used = 0; const overflow = [];
    buttons.forEach((b, i) => { if (!overflow.length && used + widths[i] <= limit) used += widths[i]; else overflow.push(i); });
    const activeIdx = buttons.findIndex(b => b.classList.contains('active'));
    if (overflow.includes(activeIdx) && overflow[0] > 0) { overflow[overflow.indexOf(activeIdx)] = overflow[0] - 1; }
    for (const i of overflow.sort((a, b) => a - b)) {
      const b = buttons[i]; b.hidden = true;
      menu.append(h('button', { role: 'menuitem', type: 'button', class: b.classList.contains('active') ? 'active' : '', onClick: () => { setOpen(false); onPick(tabs[i][0]); } }, tabs[i][1]));
    }
    // The active tab, if it was swapped in, goes right before the More button so the strip reads in order.
    if (!buttons[activeIdx]?.hidden) strip.insertBefore(buttons[activeIdx], wrap);
    moreBtn.textContent = `More (${overflow.length}) ▾`;
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => layout()).observe(strip);
  else requestAnimationFrame(layout);
  strip.relayout = layout;
  return strip;
}
export function bars(items, { max, valueKey = 'n', labelKey = 'k', format = fmt.num, link = null } = {}) {
  // A value can be a string such as "<11" (a suppressed small cell in the funder report): it draws no bar and
  // is printed as sent.
  const numOf = (i) => { const n = Number(i[valueKey]); return Number.isFinite(n) ? n : 0; };
  const show = (v) => (Number.isFinite(Number(v)) ? format(v) : String(v ?? ''));
  const m = max || Math.max(1, ...items.map(numOf));
  if (!items.length) return h('div', { class: 'muted small' }, 'No data');
  return h('div', {}, items.map(i => { const href = link ? link(i) : null; const row = [h('div', { class: 'lbl', title: fmt.label(i[labelKey]) }, fmt.label(i[labelKey])), h('div', { class: 'trk' }, h('div', { class: 'fil', style: { width: `${(numOf(i) / m) * 100}%` } })), h('div', { class: 'n' }, show(i[valueKey]))];
    return href ? h('a', { class: 'bar link', href: href.startsWith('#') ? href : '#/' + href, title: 'Show these' }, row) : h('div', { class: 'bar' }, row); }));
}
export function sparkline(values) { const m = Math.max(1, ...values); return h('div', { class: 'spark' }, values.map(v => h('div', { style: { height: `${(v / m) * 100}%` }, title: String(v) }))); }
export function stat(label, value, kind = '', href = null, title = 'Open') {
  const body = [h('div', { class: 'v' }, value), h('div', { class: 'l' }, label)];
  return href ? h('a', { class: `card stat link ${kind}`, href: href.startsWith('#') ? href : '#/' + href, title }, body) : h('div', { class: `card stat ${kind}` }, body);
}
export function kv(pairs) { return h('dl', { class: 'kv' }, pairs.filter(p => p).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')])); }
export function pageHead(title, ...actions) {
  const r = parseHash(); const item = NAV.find(n => n.name === r.name);
  return h('div', { class: 'topbar' }, h('div', { class: 'row', style: { gap: '.4rem' } }, h('h1', {}, title), item?.help ? helpTip(item.help) : null), h('div', { class: 'row' }, actions));
}
// Small "?" that reveals a plain-language explanation
export function helpTip(text) {
  const box = h('div', { class: 'helptip hidden' }, text);
  const btn = h('button', { class: 'help-btn', type: 'button', 'aria-label': 'What is this?', onClick: () => box.classList.toggle('hidden') }, '?');
  return h('span', { class: 'help-wrap' }, btn, box);
}
// Empty state with one obvious next step
export function emptyState(title, text, action) { return h('div', { class: 'empty-state' }, h('div', { class: 'big' }, title), h('p', { class: 'muted' }, text), action || null); }

// "+ Log" quick action: the one button non-technical users need most
export function quickActions() {
  const items = [
    can('interventions:write') ? ['✚', 'Visit or service', async () => (await import('./views/interventions.js')).openInterventionForm(null, { onDone: render })] : null,
    can('calls:write') ? ['☎', 'Phone call', async () => (await import('./views/calls.js')).openCallForm(null, { onDone: render })] : null,
    can('calls:write') ? ['💬', 'Text message', async () => (await import('./views/calls.js')).openCallForm(null, { method: 'text', onDone: render })] : null,
    (can('notes:admin:write') || can('notes:clinical:write')) ? ['✎', 'Note', async () => (await import('./views/notes.js')).openNoteForm(null, { onDone: render })] : null,
    can('tasks:write') ? ['☑', 'Reminder / to-do', async () => (await import('./views/tasks.js')).openTaskForm(null, { onDone: render })] : null,
    can('time:write') ? ['◷', 'Time (meeting, travel, paperwork…)', async () => (await import('./views/time.js')).openTimeForm(null, { onDone: render })] : null,
    can('clients:write') ? ['👤', 'New client', async () => (await import('./views/clients.js')).openClientForm(null)] : null,
  ].filter(Boolean);
  if (!items.length) return null;
  return h('button', { class: 'btn primary quick', onClick: () => { const m = modal('What would you like to record?', h('div', { class: 'quick-list' }, items.map(([ico, label, fn]) => h('button', { class: 'btn', onClick: () => { m.close(); fn(); } }, h('span', { class: 'ico' }, ico), label)))); } }, '+ Log');
}
// Global client search (top bar / mobile bar)
export function globalSearch() {
  const input = h('input', { type: 'search', placeholder: 'Find a client: name, code or exact phone…', 'aria-label': 'Find a client' });
  const list = h('div', { class: 'card tight hidden search-results' });
  const wrap = h('div', { class: 'gsearch' }, input, list);
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 400); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { nav(`clients?status=all&q=${encodeURIComponent(input.value.trim())}`); list.classList.add('hidden'); } if (e.key === 'Escape') list.classList.add('hidden'); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) list.classList.add('hidden'); });
  async function run() {
    // Every search is a PHI read that is audited, so do not issue one for a single letter.
    const q = input.value.trim();
    if (q.length < 2) { list.classList.add('hidden'); return; }
    try { const r = await get(`/api/clients?limit=8&status=all&q=${encodeURIComponent(q)}`, { quiet: true }); clear(list);
      if (!r.clients.length) list.append(h('div', { class: 'muted small' }, 'No match. Try just the start of the last name, the full phone number, date of birth or client code.'));
      for (const c of r.clients) list.append(h('a', { class: 'list-item', href: `#/client/${c.id}`, style: { display: 'block' }, onClick: () => list.classList.add('hidden') }, h('b', {}, c.display_name), ' ', h('span', { class: 'muted small' }, c.client_code, ' · ', fmt.label(c.status))));
      list.classList.remove('hidden'); } catch {}
  }
  return wrap;
}
// Reminders due within the hour, or overdue: a count in the header, refreshed while the app is open, and
// (only if the person switched it on under Profile) a system notification when one comes due.
// Polled every five minutes while the tab is visible, and again when it comes back into view or gets
// focus: a tab left open overnight used to ask once a minute all night for an answer nobody was looking at.
const DUE_POLL_MS = 5 * 60000;
let dueCache = { at: 0, data: null }; const notifiedDue = new Set(); let dueTimer; let duePoll = null; let dueListening = false;
export function dueBell() {
  if (!can('tasks:read')) return null;
  const count = h('span', { class: 'bell-count hidden', 'aria-hidden': 'true' });
  const btn = h('a', { class: 'btn ghost bell', href: '#/tasks?overdue=1', 'data-due-bell': '1', 'aria-label': 'Reminders due', title: 'Reminders due within the hour, or overdue' }, h('span', { 'aria-hidden': 'true' }, '🔔'), count);
  const paint = (r) => {
    const n = r ? r.rows.length : 0;
    count.textContent = String(n); count.classList.toggle('hidden', !n); btn.classList.toggle('has-due', !!n);
    btn.setAttribute('aria-label', n ? `${n} reminder${n === 1 ? '' : 's'} due or overdue` : 'No reminders due');
  };
  async function poll(force = false) {
    if (!state.user) return;
    if (!force && dueCache.data && Date.now() - dueCache.at < 60000) { paint(dueCache.data); return; }
    try { const r = await get('/api/tasks/due?within=60', { quiet: true, background: true }); dueCache = { at: Date.now(), data: r }; paint(r); maybeNotify(r.rows); } catch { /* offline or no permission: the badge just stays as it was */ }
  }
  clearInterval(dueTimer);
  dueTimer = setInterval(() => { if (!document.body.contains(btn)) { clearInterval(dueTimer); return; } if (document.visibilityState === 'visible') poll(true); }, DUE_POLL_MS);
  duePoll = poll;
  if (!dueListening) {
    dueListening = true;
    const wake = () => { if (document.visibilityState === 'visible' && duePoll) duePoll(); };
    document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake);
  }
  poll();
  return btn;
}
function maybeNotify(rows) {
  if (!prefs.get('notify_due') || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const t of rows) {
    if (notifiedDue.has(t.id)) continue;
    notifiedDue.add(t.id);
    try {
      const n = new Notification(t.overdue ? 'Overdue reminder' : 'Reminder due now', { body: t.title + (t.client_name ? ` · ${t.client_name}` : ''), tag: `suds-task-${t.id}` });
      n.onclick = () => { window.focus(); nav(`tasks?id=${t.id}`); n.close(); };
    } catch { /* the browser refused; the badge still shows it */ }
  }
}
// Welcome tour shown once per user (stored in synced preferences)
let tourOpen = false;
export function maybeTour() {
  if (prefs.get('tour_done') || tourOpen || document.querySelector('.modal-bg')) return;
  tourOpen = true;
  const steps = [
    ['Welcome to SUDS', `Hi ${firstName(state.user.display_name)}. SUDS keeps everything about the people you serve in one place, and it works the same on your phone and your computer. Anything you add on one shows up on the other right away.`],
    ['Start with Home', 'Home shows what needs attention today: reminders due, clients you have not contacted in a while, and drafts you started on another device.'],
    ['Record work with + Log', 'The blue + Log button (top of the page, or bottom-right on a phone) records a visit, call, note, reminder or time in a few taps. Visits and calls also fill in your time sheet.'],
    ['Find anyone fast', 'Use the search box at the top with a last name, phone number or client code. Open a client to see their story: visits, calls, notes, referrals and reminders on one timeline.'],
    ['Look for the ? marks', 'Every page has a ? that explains it in plain language. You cannot break anything: records are never truly deleted and every change is logged.'],
  ];
  let i = 0; const body = h('div', {}); const dots = h('div', { class: 'muted small center' });
  const draw = () => { clear(body).append(h('h2', {}, steps[i][0]), h('p', { style: { fontSize: '1.05rem' } }, steps[i][1])); dots.textContent = `${i + 1} of ${steps.length}`; };
  // Closing the dialog any other way (backdrop, Escape, the corner button) counts as "skip" too -- it must
  // not come back on every page load, and it must never sit blocking the app on a phone in the field.
  const finish = () => { prefs.set('tour_done', true); tourOpen = false; m.close(); };
  const m = modal('', h('div', {}, body, h('div', { class: 'btn-row', style: { justifyContent: 'space-between', alignItems: 'center' } }, h('button', { class: 'btn ghost', onClick: finish }, 'Skip'), dots, h('button', { class: 'btn primary', onClick: () => { if (i < steps.length - 1) { i++; draw(); } else finish(); } }, 'Next'))), { onClose: () => { prefs.set('tour_done', true); tourOpen = false; } });
  m.el.querySelector('.card-head').remove(); draw();
}
export async function downloadCsv(path) {
  if (state.local && window.SUDS_LOCAL) { const r = await window.SUDS_LOCAL.handle('GET', path, undefined, {}); if (r.status >= 400) { toast('Download failed', 'error'); return; } const name = (/filename="([^"]+)"/.exec(r.headers['content-disposition'] || '') || [])[1] || 'download'; if (window.SudsNative && window.SudsNative.saveFile) { let bin = ''; const bytes = new Uint8Array(r.body); for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); window.SudsNative.saveFile(name, btoa(bin), r.headers['content-type'] || 'application/octet-stream'); return; }
    const blob = new Blob([r.body], { type: r.headers['content-type'] || 'application/octet-stream' }); const u = URL.createObjectURL(blob); const a = h('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); return; }
  const a = h('a', { href: path, download: '' }); document.body.append(a); a.click(); a.remove();
}

// A promise nobody caught (a click handler that awaited a request and did not try/catch) used to fail
// silently: the button did nothing, the console said why, and nobody reads the console on a phone.
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason;
  const msg = (err && (err.message || (typeof err === 'string' ? err : ''))) || 'Something went wrong. Try again.';
  try { toast(msg, 'error'); } catch { /* the toast host is not on the page yet */ }
});

// ---------- routing ----------
const routes = {};
export function route(name, loader) { routes[name] = loader; }
// "Dr. Kiran Patel" is Kiran, not Dr.
// The name is used exactly as the person typed it (a single word, all capitals, a hyphenated first
// name — none of it is re-cased or cut), and a blank display name falls back to the username so a
// greeting is never "Good morning, ".
const HONORIFIC = /^(dr|mr|mrs|ms|mx|rev|fr|sr|jr|prof)\.?$/i;
export const firstName = (n, fallback = '') => {
  const words = String(n || '').trim().split(/\s+/).filter(Boolean);
  const real = words.filter(w => !HONORIFIC.test(w));
  return real[0] || words[0] || String(fallback || '').trim();
};
// The name a greeting uses. A display name of one or two words ("QATEST", "QA Tester", "Mary-Jo Baker")
// is used whole — cutting "QA Tester" to "QA" reads as a truncation, not a first name. Only a longer,
// formal name ("Dr. Kiran Patel", "Maria de la Cruz Jones") is shortened to the first name, honorifics
// skipped. Never re-cased; a blank display name falls back to the username.
export const greetingName = (n, fallback = '') => {
  const words = String(n || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return String(fallback || '').trim();
  const real = words.filter(w => !HONORIFIC.test(w));
  if (words.length <= 2 && real.length === words.length) return words.join(' ');
  return real[0] || words[0];
};
const canAny = (perm) => (Array.isArray(perm) ? perm.some(p => can(p)) : can(perm));
export function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'dashboard', id: parts[1], sub: parts[2], query: new URLSearchParams(qs || '') };
}
export function nav(to) { location.hash = to.startsWith('#') ? to : '#/' + to; }

export const NAV = [
  { sec: 'My day' },
  { name: 'dashboard', label: 'Home', ico: '⌂', help: 'What needs attention today, and where you left off on any device.' },
  { name: 'clients', label: 'My clients', ico: '👤', perm: 'clients:read', help: 'Everyone you serve. Open a client to see their whole story in one place.' },
  { name: 'waitlist', label: 'Waitlist', ico: '⧗', perm: 'clients:read', help: 'People waiting for a place, longest and highest risk first.' },
  { name: 'tasks', label: 'To-do list', ico: '☑', perm: 'tasks:read', help: 'Follow-ups and reminders. Check a box when it is done.' },
  { name: 'supervision', label: 'Supervision', ico: '✍', perm: ['notes:cosign', 'time:approve', 'assignments:manage'], help: 'Notes waiting for your countersignature, drafts your team has not finished, staff time to approve, and referrals with no outcome recorded.' },
  { sec: 'Record work' },
  { name: 'interventions', label: 'Visits & services', ico: '✚', perm: 'interventions:read', help: 'Every face-to-face or phone service you provide: outreach, screenings, warm handoffs, naloxone, transport and more.' },
  { name: 'calls', label: 'Calls & texts', ico: '☎', perm: 'calls:read', help: 'Phone calls and text messages with clients, families and providers — including ones that went to voicemail or got no reply.' },
  { name: 'forms', label: 'Forms', ico: '🧾', perm: 'forms:read', help: 'County forms (releases, intake sheets, assistance requests). Fill one out from a client record: it is pre-filled from the chart, printable, and holds the signed copy.' },
  { name: 'notes', label: 'Notes', ico: '✎', perm: 'notes:admin:read', help: 'Written documentation. Drafts save automatically and can be finished on any device; sign when complete.' },
  { name: 'time', label: 'My time', ico: '◷', perm: 'time:read', help: 'Your hours by activity. Visits and calls add time automatically; log meetings, travel and paperwork here.' },
  { name: 'imports', label: 'Import', ico: '⇩', perm: 'imports:write', help: 'Bring in spreadsheets (Excel / CSV) of clients, visits, calls, resources and more, or notes from Pocket AI and OneNote. Everything is checked before it is saved.' },
  { name: 'overdose', label: 'Overdose & reversals', ico: '⛑', perm: 'overdose:read', help: 'Overdoses and naloxone reversals, including ones involving people who are not clients. These are the counts funders ask for.' },
  { name: 'supplies', label: 'Supplies', ico: '📦', perm: 'interventions:read', help: 'Naloxone kits, test strips and other harm-reduction stock on hand. A visit that hands out kits or strips takes them off this count automatically.' },
  { sec: 'Connect clients' },
  { name: 'referrals', label: 'Referrals', ico: '⇢', perm: 'referrals:read', help: 'Track each referral from "sent" to "admitted" so nothing falls through the cracks.' },
  { name: 'resources', label: 'Resource directory', ico: '☰', perm: 'resources:read', help: 'Treatment programs, MAT clinics, shelters, legal aid and other partners you refer to.' },
  { sec: 'Program' },
  { name: 'budget', label: 'Funding & spending', ico: '$', perm: 'budget:read', help: 'Grants and what has been spent, including client assistance such as bus passes and IDs.' },
  { name: 'documents', label: 'Policies & contracts', ico: '📋', perm: 'documents:read', help: 'County policies, procedures and signed contracts, searchable by title and category.' },
  { name: 'reports', label: 'Reports', ico: '▤', perm: 'reports:read', help: 'Numbers for your funders and supervisors. Exports never include client names unless you ask.' },
  { name: 'funder', label: 'Funder report', ico: '▦', perm: 'reports:read', help: 'Unduplicated counts — people, not services — by fiscal period and funding source, with admissions, discharges, demographics and overdose figures in the shape a grant report asks for.' },
  // A supervisor holds assignments:manage (moving a caseload when someone leaves lives on this page) but not
  // users:manage; gating the whole page on the latter locked them out of a feature built for them.
  { name: 'admin', label: 'Settings', ico: '⚙', perm: ['users:manage', 'assignments:manage'], help: 'Staff accounts, security, connecting devices and backups — or, for a supervisor, moving a caseload and the audit log.' },
];

let current = null;
export async function render() {
  const app = document.getElementById('app');
  app.removeAttribute('aria-busy'); // was set on the static pre-hydration shell in index.html
  clear(document.getElementById('modal-root'));
  const r = parseHash();
  if (state.localSetupNeeded) { if (r.name !== 'localsetup') { nav('localsetup'); return; } clear(app).append(await routes.localsetup(r)); return; }
  if (state.setupNeeded) { if (r.name !== 'setup') { nav('setup'); return; } clear(app).append(await routes.setup(r)); return; }
  if (!state.user) { clear(app).append(await routes.login(r)); return; }
  if (state.mfaPending && r.name !== 'mfa') { nav('mfa'); return; }
  if (r.name === 'mfa' || r.name === 'login') { clear(app).append(await routes[r.name === 'mfa' ? 'mfa' : 'dashboard'](r)); return; }
  if (state.user.must_change_password && r.name !== 'profile') { nav('profile?force=1'); return; }
  const navItem = NAV.find(n => n.name === r.name);
  // An address that goes nowhere (a mistyped link, a page that no longer exists) says so, instead of
  // quietly showing Home under the wrong address.
  const loader = navItem?.perm && !canAny(navItem.perm) ? (async () => emptyState('Not available for your role', `Your account does not have access to ${navItem.label}. Ask your supervisor or administrator if you need it.`, h('button', { class: 'btn', onClick: () => nav('dashboard') }, 'Back to home')))
    : routes[r.name] || (async () => h('div', { 'data-not-found': '1' }, emptyState('Page not found', `There is no page at "#/${r.name}". The link may be out of date.`, h('a', { class: 'btn primary', href: '#/dashboard' }, 'Go to Home'))));
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' }, h('div', { class: 'boot' }, 'Loading…'));
  const side = sidebar(r);
  const qa = quickActions();
  const layout = h('div', { class: 'layout' }, h('a', { class: 'skip-link', href: '#main', onClick: (e) => { e.preventDefault(); main.focus(); main.scrollIntoView(); } }, 'Skip to content'), mobileBar(r, side), side, h('div', { class: 'content' }, h('div', { class: 'appbar' }, can('clients:read') ? globalSearch() : h('div', { class: 'grow' }), dueBell(), qa), main), qa ? h('div', { class: 'fab' }, qa.cloneNode(true)) : null);
  if (qa) layout.querySelector('.fab button')?.addEventListener('click', () => qa.click());
  clear(app).append(layout);
  // A hash change keeps the old scroll position, so leaving a long list for another page landed the
  // reader part-way down it, with the new page's header and alerts scrolled off the top.
  if (!current || current.name !== r.name || current.id !== r.id) window.scrollTo(0, 0);
  if (r.name === 'dashboard') setTimeout(() => { if (parseHash().name === 'dashboard') maybeTour(); }, 400);
  try { const view = await loader(r); clear(main).append(view); }
  catch (e) { clear(main).append(h('div', { class: 'banner danger' }, e.message)); }
  current = r;
}
function sidebar(r) {
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'SUDS'), h('small', {}, state.org))),
    h('nav', { class: 'nav' }, NAV.map((n, i) => {
      if (n.sec) {
        // A heading with nothing under it (a finance account and "Connect clients") is just noise.
        const rest = NAV.slice(i + 1); const end = rest.findIndex(m => m.sec); const items = end < 0 ? rest : rest.slice(0, end);
        return items.some(m => !m.perm || canAny(m.perm)) ? h('div', { class: 'sec' }, n.sec) : null;
      }
      return (!n.perm || canAny(n.perm)) ? h('a', { href: '#/' + n.name, class: r.name === n.name ? 'active' : '' }, h('span', { class: 'ico' }, n.ico), n.label) : null;
    })),
    h('div', { class: 'foot' }, state.local ? h('a', { href: '#/sync', class: 'badge info', style: { display: 'block', textAlign: 'center', marginBottom: '.5rem' } }, '📱 On this device · Sync') : null, h('div', {}, h('b', {}, state.user.display_name)), h('div', { class: 'muted' }, fmt.label(state.user.role)),
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, h('a', { href: '#/profile' }, 'Profile'), h('a', { href: '#', onClick: (e) => { e.preventDefault(); logout(); } }, 'Sign out'), h('a', { href: '#', title: 'Light / dark', onClick: (e) => { e.preventDefault(); toggleTheme(); } }, 'Light/dark'))));
}
function mobileBar(r, side) {
  const item = NAV.find(n => n.name === r.name) || (r.name === 'client' ? { label: 'Client' } : { label: 'SUDS' });
  const menuBtn = h('button', { class: 'btn ghost', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'sidebar' }, '☰');
  side.id = 'sidebar';
  // Off-canvas but still in the tab order and the accessibility tree is a trap: a keyboard or screen-reader
  // user lands on invisible links. While the drawer is closed on a phone it is inert; on a desktop it is
  // always a real sidebar.
  const phone = matchMedia('(max-width: 900px)');
  const syncInert = () => { const closed = phone.matches && !side.classList.contains('open'); side.inert = closed; if (closed) side.setAttribute('aria-hidden', 'true'); else side.removeAttribute('aria-hidden'); };
  const setOpen = (open) => { side.classList.toggle('open', open); document.body.classList.toggle('nav-open', open); menuBtn.setAttribute('aria-expanded', String(open)); syncInert(); if (open) side.querySelector('a')?.focus(); else menuBtn.focus(); };
  const toggle = () => setOpen(!side.classList.contains('open'));
  menuBtn.addEventListener('click', toggle);
  side.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  side.addEventListener('keydown', (e) => { if (e.key === 'Escape' && side.classList.contains('open')) setOpen(false); });
  // The layout is rebuilt on every route change; keep exactly one media listener, for the current sidebar.
  if (mobileBar.onChange) phone.removeEventListener('change', mobileBar.onChange);
  mobileBar.onChange = syncInert; phone.addEventListener('change', syncInert);
  syncInert();
  return h('div', { class: 'mobilebar' }, menuBtn, h('b', {}, item.label), h('a', { href: '#/clients', class: 'btn ghost', 'aria-label': 'Clients' }, '👤'));
}
function toggleTheme() { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const next = cur === 'dark' ? 'light' : 'dark'; prefs.set('theme', next); applyTheme(); }
try { const cached = JSON.parse(localStorage.getItem('suds.prefs') || '{}'); if (cached.theme) document.documentElement.dataset.theme = cached.theme; } catch {}

export async function logout() { await prefs.flush(); try { await post('/api/auth/logout', {}); } catch {} state.user = null; state.mfaPending = false; document.querySelectorAll('#banners [data-banner="mfa-required"]').forEach(b => b.remove()); nav('login'); render(); }

// ---------- session / idle ----------
let lastActivity = Date.now(); let idleTimer;
function touch() { lastActivity = Date.now(); }
['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
function startIdleWatch() {
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (!state.user) return;
    const idleMs = Date.now() - lastActivity; const limit = state.idleMinutes * 60000;
    let w = document.getElementById('idle-warn');
    if (idleMs > limit - 60000 && !w) { w = h('div', { id: 'idle-warn', class: 'idle-warn' }, 'You will be signed out in 1 minute due to inactivity. Tap the screen, move the mouse or press a key to stay signed in.'); document.body.append(w); }
    if (idleMs <= limit - 60000 && w) w.remove();
    if (idleMs > limit) {
      if (w) w.remove();
      logout();
      // Anything half-typed is kept in memory, so say so rather than letting it look like lost work.
      toast(drafts.size ? 'Signed out due to inactivity. What you had typed is kept — reopen the form after signing in.' : 'Signed out due to inactivity', 'error');
    }
  }, 5000);
}

export async function loadSession() {
  if (state.local) { try { const st = await get('/api/local/status', { quiet: true }); state.localSetupNeeded = st.users === 0; } catch { state.localSetupNeeded = false; } if (state.localSetupNeeded) { state.user = null; return; } }
  else { try { const st = await get('/api/setup/status', { quiet: true }); state.setupNeeded = !!st.needed; } catch { state.setupNeeded = false; } if (state.setupNeeded) { state.user = null; return; } }
  try {
    const me = await get('/api/auth/me', { quiet: true });
    state.user = me.user; state.org = me.org_name; state.mfaPending = me.mfaPending; state.idleMinutes = me.idle_minutes || 15;
    await Promise.all([loadRefData(), prefs.load()]);
    // Two-step verification is required of this role but not set up yet. There is a grace period, after which
    // the server refuses every request until it is done -- so say when that is, and where to do it, instead of
    // a vague "please enroll" that reads as advisory right up until the day everything stops working.
    if (state.user.mfa_required && !state.user.mfa_enabled && !state.mfaPending && !state.local) {
      const due = state.user.mfa_setup_deadline ? fmt.parse(state.user.mfa_setup_deadline) : null;
      const when = due ? (due.getTime() < Date.now() ? 'now' : `by ${fmt.date(state.user.mfa_setup_deadline)}`) : 'now';
      const el = banner(`Your role requires two-step verification. Set it up ${when} — after that, SUDS will not let you in until it is done.`, 'warn', { id: 'mfa-required' });
      if (el) el.firstChild.append(' ', h('a', { href: '#/profile?mfa=1', class: 'btn sm primary', style: { marginLeft: '.5rem' } }, 'Set up now'));
    }
  } catch { state.user = null; }
}
export async function loadRefData() {
  // Not fatal: an account that must change its password first is refused nearly everything, and the one
  // page it may use has to render regardless.
  if (!state.constants) { try { state.constants = await get('/api/meta/constants', { quiet: true }); } catch { state.constants = state.constants || {}; } }
  try { state.users = (await get('/api/users', { quiet: true })).users; } catch { state.users = []; }
  if (can('budget:read')) { try { state.funds = (await get('/api/budget/funds', { quiet: true })).funds; } catch { state.funds = []; } }
}

// ---------- boot (called from main.js after all views are registered) ----------
window.__suds = { downloadCsv: (...a) => downloadCsv(...a) };
// Stamped by scripts/build-local.js from package.json. The two kernel assets are requested with it as a
// version query so the browser may keep them for good (server/http.js serves `?v=` as immutable) while a
// new release, with a new version, is a new URL. public/sw.js caches the same URLs for offline starts.
const SUDS_VERSION = '1.9.1';
async function startLocalKernel(force) {
  const k = await import(`./local/kernel.js?v=${SUDS_VERSION}`);
  await k.start({
    wasmUrl: new URL(`./local/sql-wasm.wasm?v=${SUDS_VERSION}`, location.href).href,
    force,
    // A device that has stopped being able to save is not a console message; the person using it needs
    // to know before they type anything else in.
    onSaveError: (err) => {
      const full = String(err && err.name) === 'QuotaExceededError';
      banner(full
        ? 'This device is out of storage space, so nothing is being saved. Sync with the office, then remove sample data or attachments to free space.'
        : 'This device has stopped saving your work. Sync with the office as soon as you can.', 'error');
    },
  });
}
export async function boot(force = false) {
  state.local = isLocalMode();
  if (state.local) {
    document.getElementById('app').innerHTML = '<div class="boot">Starting SUDS on this device…</div>';
    try {
      await startLocalKernel(force);
    } catch (e) {
      // Two specific failures need their own explanation rather than a raw message.
      const alreadyOpen = e && e.code === 'SUDS_ALREADY_OPEN';
      const msg = alreadyOpen
        ? 'SUDS is already open in another window on this device. Switch to that window, or close it and reload this page.'
        : e && e.code === 'SUDS_KEY_LOST'
          ? e.message
          : 'Could not start SUDS on this device: ' + (e && e.message);
      console.error(e);
      const app = document.getElementById('app');
      app.removeAttribute('aria-busy');
      clear(app);
      // This is the one screen a locked-out or broken device can reach without a kernel — reset has to work
      // here directly. SUDS_ALREADY_OPEN gets its own recovery instead: that device and its data are fine,
      // just apparently open elsewhere, so wiping it would be the wrong tool. "Try again" always works — it
      // re-checks in case the other window closed in the meantime. Past that, once the previous holder has
      // gone quiet long enough to be presumed gone (a crashed tab, a browser killed outright rather than
      // closed) rather than genuinely still open, "Continue anyway" lets the person proceed instead of being
      // locked out of their own device with no way back in.
      app.append(
        h('div', { class: 'boot error' }, msg),
        alreadyOpen ? h('div', { class: 'btn-row center mt' },
          h('button', { class: 'btn', type: 'button', onClick: () => boot() }, 'Try again'),
          e.stale ? h('button', { class: 'btn danger', type: 'button', onClick: () => boot(true) }, 'Continue anyway — no other window is actually open') : null,
        ) : offerDeviceReset(),
      );
      return;
    }
    // Anything written in the last moments before the page goes away is persisted on the way out: pagehide
    // for a close or navigation, visibilitychange for a phone switching apps (where pagehide may never
    // come). An urgent flush issues the IndexedDB write synchronously and commits it without waiting for
    // any callback, so the browser finishes it even as the page unloads; nothing is awaited here because
    // nothing after unload would run.
    const flushNow = () => { try { window.SUDS_LOCAL && window.SUDS_LOCAL.flush({ urgent: true }); } catch {} };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
    // Redeploying the site (new files at the same origin) never touches this device's IndexedDB/localStorage
    // — the sign-in session, the account, and every client record already survive that on their own. What
    // does not survive on its own is the browser treating this storage as "best-effort": under disk pressure
    // it can be evicted with no warning, silently taking the whole device's data with it. Asking for the
    // persistent-storage grant is the one thing actually in the app's control here; the browser still decides
    // (based on things like whether the person installed/bookmarked the app), so this is best-effort itself.
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
    // "Add to Home Screen" installs whatever the manifest's start_url says, and the shared manifest points at
    // the office login -- so a phone set up here, installed the way the login screen tells people to, opened
    // to a server sign-in with its own caseload nowhere in sight. The on-device manifest starts back here.
    try { const link = document.querySelector('link[rel="manifest"]'); if (link) link.href = 'manifest-local.webmanifest'; localStorage.setItem('suds.localUsed', '1'); } catch {}
  }
  // Registered in local mode too: the worker caches the kernel and the shell, so a device set up for local
  // mode (or the demo build installed to a home screen) starts with no connection at all (H4).
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      // When a newer worker takes over (a release was published while this page was open, or this is the
      // first load after one), reload once so the page runs the files that worker now serves, rather than
      // the previous build's modules the browser already had. Only when a worker was in control before:
      // the very first registration must not reload the page someone has just started using.
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded && !document.querySelector('.modal-bg')) { reloaded = true; location.reload(); } });
      navigator.serviceWorker.register('sw.js').then(r => r && r.update && r.update()).catch(() => {});
    } catch {}
  }
  await loadSession();
  startIdleWatch();
  window.addEventListener('hashchange', render);
  render();
}

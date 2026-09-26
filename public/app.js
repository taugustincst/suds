// SUDS frontend core: API client, hash router, DOM + form helpers, session/idle handling.
export const state = { user: null, org: 'SUDS', constants: null, users: [], funds: [], idleMinutes: 15, prefs: {}, local: false };
// Local mode: the whole server runs inside this page (the offline copy). Requests go to the in-page kernel.
// window.SUDS_FORCE_LOCAL is set by a small external script tag, before this module loads, on builds
// meant to run with no backend at all (e.g. a static hosting deploy of public/ — see
// scripts/build-static-site.js). External, not inline, so it works under the CSP the office server sends.
// It is distinct from window.SUDS_LOCAL, which the boot sequence itself sets only after local mode is
// already chosen, so it cannot be used to make that choice.
export function isLocalMode() { try { return new URLSearchParams(location.search).get('local') === '1' || location.protocol === 'file:' || window.SUDS_FORCE_LOCAL === true || !!window.SUDS_LOCAL; } catch { return false; } }

// ---------- workspace preferences (follow the user across devices) ----------
let prefsTimer; const prefsDirty = {};
export const prefs = {
  get: (k, d) => (state.prefs[k] === undefined ? d : state.prefs[k]),
  set(k, v) { state.prefs[k] = v; prefsDirty[k] = v; try { localStorage.setItem('suds.prefs', JSON.stringify(state.prefs)); } catch {} // The pending save counts as work in progress (see activity below), so "has the page finished?" covers it.
    if (prefsTimer) clearTimeout(prefsTimer); else busy(1);
    prefsTimer = setTimeout(() => { prefsTimer = null; busy(-1); prefs.flush(); }, 800); },
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

// What the page is still doing, for anything that needs to know when it has finished: requests in flight,
// work scheduled to run shortly (the Home tour), and the address the last render completed for. The
// browser suite waits on this (settle() in scripts/ui/assert.mjs) instead of sleeping a fixed time and
// hoping the page was done. It holds counts and a hash, never data.
const activity = { pending: 0, rendered: null, at: Date.now() };
try { window.__sudsActivity = activity; } catch {}
const busy = (n) => { activity.pending += n; activity.at = Date.now(); };
export async function api(method, path, body, opts = {}) {
  busy(1);
  try { return await apiCall(method, path, body, opts); } finally { busy(-1); }
}
// ---- Idempotency-Key ----
// Every POST carries a key, so the server can answer a repeat of the same request from what it already did
// instead of doing it twice (server/idempotency.js): a referral resent after a dropped connection used to
// create two referrals, two disclosure records and two follow-up to-dos. A form's submission holds one key
// for as long as its contents are unchanged, so pressing Save again after "you appear to be offline" is
// recognised as the same submission; editing the form, or a successful save, starts a new one. Each POST
// the submission makes gets its own key derived from it (path and sequence), stable across retries.
// crypto.getRandomValues, not randomUUID: the latter only exists on https, and a LAN install may be http.
export function newIdempotencyKey() { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
let submitScope = null;
function idempotencyKey(method, path, opts) {
  if (method !== 'POST') return null;
  if (opts.idempotencyKey) return opts.idempotencyKey;
  if (submitScope && !opts.quiet && !opts.background) {
    const p = String(path).split('?')[0]; const n = (submitScope.seq.get(p) || 0) + 1; submitScope.seq.set(p, n);
    return `${submitScope.key}:${n}:${p}`.slice(0, 255);
  }
  return newIdempotencyKey();
}
async function apiCall(method, path, body, opts) {
  const background = isBackground(opts);
  const idem = idempotencyKey(method, path, opts);
  const headers = { 'X-Requested-With': 'suds', ...(background ? { 'X-Background': '1' } : {}), ...(idem ? { 'Idempotency-Key': idem } : {}), ...(opts.headers || {}) };
  if (state.local && window.SUDS_LOCAL) {
    let payload = body; if (body instanceof Blob) payload = await body.arrayBuffer();
    // Writes in flight (a sync above all) hold off an update reload; see newVersionReady().
    const writing = method !== 'GET' && method !== 'HEAD'; if (writing) localWritesInFlight++;
    let r;
    try {
      r = await window.SUDS_LOCAL.handle(method, path, payload, headers);
      // Something the person saved is on disk before the page says it is. The kernel batches its saves
      // (every 250 ms) and writes the rest on the way out, but Safari's engine drops that last unload write:
      // a client saved and the page reloaded straight away was gone. So an explicit write waits for the
      // on-device save; background writes (autosave, preferences, polls) stay batched. A failed save still
      // raises the "stopped saving" banner through the kernel's own error handler.
      if (writing && !background && r.status < 400 && window.SUDS_LOCAL.flush) { try { await window.SUDS_LOCAL.flush(); } catch {} }
    } finally { if (writing) localWritesInFlight--; }
    if (r.status >= 500) reportClientError({ kind: 'api', status: r.status, message: `${method} ${String(path).split('?')[0]} answered ${r.status}` });
    if (!background) touch();
    const data = r.json !== undefined ? r.json : (r.body ? (String(r.headers['content-type'] || '').includes('json') ? JSON.parse(r.body.toString()) : r.body.toString()) : null);
    if (r.status === 401 && state.user && !opts.quiet) { if (data && data.mfaRequired) location.hash = '#/mfa'; else { state.user = null; render(); } }
    if (r.status === 403 && data && data.passwordChangeRequired) location.hash = '#/profile?force=1';
    // The enrolment deadline passed (possibly mid-session): go to enrolment, rather than failing every page.
    if (r.status === 403 && data && data.mfaSetupRequired && !location.hash.startsWith('#/profile')) location.hash = '#/profile?mfa=1';
    if (r.status === 409 && data && data.frozen) showPausedScreen();
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
  if (res.status >= 500) reportClientError({ kind: 'api', status: res.status, message: `${method} ${String(path).split('?')[0]} answered ${res.status}` });
  if (!background) touch();
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && state.user && !opts.quiet) { if (data && data.mfaRequired) { location.hash = '#/mfa'; } else { state.user = null; render(); toast('Session expired. Please sign in again.', 'error'); } }
  if (res.status === 403 && data && data.passwordChangeRequired) { location.hash = '#/profile?force=1'; }
  if (res.status === 403 && data && data.mfaSetupRequired && !location.hash.startsWith('#/profile')) { location.hash = '#/profile?mfa=1'; }
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
    // No `html` attribute: markup from a string is how stored text becomes script (scripts/check-html-sinks.js).
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

// ---------- accessibility pass (docs/accessibility/DEVELOPERS.md) ----------
// Every view builds its DOM with h(); a few conventions are applied here, to whatever is added to the page,
// so a view written tomorrow gets them without doing anything:
//  * a <label> without `for` next to a control (the filter bars: h('div', {class:'field'}, h('label', {},
//    'Status'), select)) is tied to that control, so the control has a name (WCAG 1.3.1, 4.1.2);
//  * a table wrapper that scrolls and has nothing focusable inside becomes a named, focusable region, so a
//    keyboard can scroll it (2.1.1);
//  * a control given a placeholder and nothing else gets the placeholder as its name (placeholder alone
//    disappears as soon as someone types, and some screen readers skip it).
const LABELABLE = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]),select,textarea';
const hasName = (c) => (c.labels && c.labels.length) || c.hasAttribute('aria-label') || c.hasAttribute('aria-labelledby') || c.closest('label');
function a11yPass(root) {
  if (!root || !root.querySelectorAll) return;
  for (const label of root.querySelectorAll('label:not([for])')) {
    if (label.querySelector(LABELABLE)) continue; // wraps its control: already tied
    // The control that goes with it: the next element (past an "Edit this list" link), when that is a
    // control or a wrapper around exactly one (a date field with its calendar button, the client search).
    // A label over a group of several controls is a heading for them, not a name, and is left alone.
    let n = label.nextElementSibling;
    while (n && n.matches('a.field-link, .help')) n = n.nextElementSibling;
    if (!n || n.tagName === 'LABEL') continue;
    const inside = n.matches(LABELABLE) ? [n] : [...n.querySelectorAll(LABELABLE)];
    const target = inside.length === 1 && !hasName(inside[0]) ? inside[0] : null;
    if (!target) continue;
    if (!target.id) target.id = 'c-' + Math.random().toString(36).slice(2, 9);
    label.htmlFor = target.id;
  }
  for (const c of root.querySelectorAll('input[placeholder],textarea[placeholder]')) {
    if (!hasName(c) && c.placeholder) c.setAttribute('aria-label', c.placeholder);
  }
}
function scrollRegions(root) {
  for (const w of (root || document).querySelectorAll('.table-wrap, .table-scroll, pre.note, [data-scroll-region]')) {
    // Whether it scrolls can change after it is drawn (fonts, a sibling growing, a rotation): watch its size.
    if (scrollWatch && !w._a11yWatched) { w._a11yWatched = true; scrollWatch.observe(w); if (w.firstElementChild) scrollWatch.observe(w.firstElementChild); }
    const scrolls = w.scrollHeight > w.clientHeight + 1 || w.scrollWidth > w.clientWidth + 1;
    // Only a control that is showing counts: a table that has collapsed to its phone list hides its own links.
    if (!scrolls || w.hasAttribute('tabindex') || [...w.querySelectorAll(FOCUSABLE)].some(e => e.getClientRects().length)) continue;
    w.tabIndex = 0; w.setAttribute('role', 'region');
    if (!w.hasAttribute('aria-label')) {
      const head = w.closest('.card, .modal')?.querySelector('h2,h3') || document.querySelector('.main h1');
      w.setAttribute('aria-label', `${head ? head.textContent.trim() + ' — ' : ''}${w.matches('pre') ? 'text' : 'table'} (scrolls)`);
    }
  }
}
let a11yFrame = 0;
const scrollWatch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => scrollCheckSoon());
const scrollCheckSoon = () => { if (!a11yFrame) a11yFrame = requestAnimationFrame(() => { a11yFrame = 0; scrollRegions(document); }); };
// Labels at once, in the same task that added them (before anyone can reach the control); whether a table
// scrolls is only known after layout, so that check waits for the next frame (and runs again on resize).
if (typeof MutationObserver !== 'undefined') {
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.isConnected) a11yPass(n);
    scrollCheckSoon();
  }).observe(document.documentElement, { childList: true, subtree: true });
}
window.addEventListener('resize', scrollCheckSoon);

/**
 * A message that stays until it is dismissed, for conditions the user has to act on rather than
 * acknowledge in passing — a device that has stopped saving, a consent that was revoked.
 */
export function banner(message, kind = 'warn', { id = message, short = null, compact: always = false, announceText = null } = {}) {
  // After the skip link, which stays the first thing a keyboard reaches on every page.
  const host = document.getElementById('banners') || (() => { const b = h('div', { id: 'banners' }); skipLink().after(b); return b; })();
  if (host.querySelector(`[data-banner="${CSS.escape(String(id))}"]`)) return;
  // `short`: a banner that must come back (two-step set-up still owed) but that this person has already
  // dismissed once in this browser session returns as one line, not the whole paragraph above every page.
  const key = `suds.banner.${id}`;
  // `compact`: always one line (the message is already short); `announceText` is then said once instead.
  let compact = always; try { compact = compact || (!!short && sessionStorage.getItem(key) === '1'); } catch { /* storage blocked: full banner */ }
  const el = h('div', { class: `banner ${kind}${compact ? ' compact' : ''}`, 'data-banner': String(id), 'data-compact': compact ? '1' : null, role: compact ? null : 'alert' },
    h('span', {}, compact && short ? short : message),
    h('button', { class: 'btn ghost sm', 'aria-label': 'Dismiss', onClick: () => { el.remove(); if (short) { try { sessionStorage.setItem(key, '1'); } catch { /* not remembered */ } } } }, '✕'));
  host.append(el);
  if (!compact) announce(message);
  else if (always && announceText) { let said = false; try { said = sessionStorage.getItem(`${key}.said`) === '1'; sessionStorage.setItem(`${key}.said`, '1'); } catch { /* say it */ } if (!said) announce(announceText); }
  return el;
}
// "Skip to content" (WCAG 2.4.1): one link, the first focusable thing in the document on every screen, that
// moves focus to the page's <main> — the app's content, or the sign-in form.
let skipEl = null;
function skipLink() {
  if (skipEl && skipEl.isConnected) return skipEl;
  skipEl = h('a', { class: 'skip-link', href: '#main', onClick: (e) => {
    e.preventDefault();
    const main = document.querySelector('main') || document.getElementById('app');
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    main.focus(); main.scrollIntoView();
  } }, 'Skip to content');
  document.body.prepend(skipEl);
  return skipEl;
}
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
// The phone's Back button (Android, or a browser's back) closes the dialog on top instead of leaving the
// page underneath it. Opening a dialog pushes a history entry (same URL, so no route change) marked with
// its id; Back pops it and the popstate below closes that dialog. A dialog closed any other way (✕,
// Escape, Save) does not call history.back() — that is asynchronous, and a Save that navigates or opens
// the next dialog straight afterwards would be undone by it — but rewrites its entry in place as "closed"
// (sudsClosed). The next dialog reuses such an entry, and a Back press that would only step from it onto
// the same page is followed through to the page before, so no press is ever spent on nothing.
const modalStack = [];
let here = { closed: false, url: location.href };
const syncHere = () => { here = { closed: !!(history.state && history.state.sudsClosed), url: location.href }; };
window.addEventListener('hashchange', syncHere);
window.addEventListener('popstate', (e) => {
  const prev = here;
  const landed = e.state && e.state.sudsModal;
  syncHere();
  for (let i = modalStack.length - 1; i >= 0; i--) if (!modalStack[i].bg.isConnected) modalStack.splice(i, 1);
  let closedAny = false;
  while (modalStack.length && modalStack[modalStack.length - 1].id !== landed) { modalStack.pop().close({ fromHistory: true }); closedAny = true; }
  if (closedAny) return;
  // Stepped off a spent entry onto the same page, or onto the entry of a dialog that is already gone
  // (removed by a re-render): nothing changed on screen, so take the next step too.
  if ((prev.closed && prev.url === location.href) || (landed && !modalStack.some(m => m.id === landed))) history.back();
});
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
  const historyId = 'm' + Math.random().toString(36).slice(2, 10);
  function close(opts) {
    if (closed) return; closed = true;
    const fromHistory = !!(opts && opts.fromHistory);
    const at = modalStack.findIndex(x => x.id === historyId); if (at >= 0) modalStack.splice(at, 1);
    if (!fromHistory) {
      try {
        if (history.state && history.state.sudsModal === historyId) {
          const parent = modalStack.length ? modalStack[modalStack.length - 1].id : undefined;
          history.replaceState({ ...history.state, sudsModal: parent, sudsClosed: true }, ''); syncHere();
        }
      } catch { /* no history API */ }
    }
    bg.remove(); syncInertBehindDialogs(); // now, not at the observer's turn: focus goes back to the page below
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
  watchDialogs(root);
  root.append(bg); syncInertBehindDialogs();
  try {
    const st = { ...(history.state || {}), sudsModal: historyId, sudsClosed: false };
    // A spent entry (a dialog closed with ✕ on this same page) is reused rather than piling up more.
    if (history.state && history.state.sudsClosed) history.replaceState(st, ''); else history.pushState(st, '');
    syncHere(); modalStack.push({ id: historyId, bg, close });
  } catch { /* no history API: Back leaves the page as before */ }
  // No announce(title): the dialog is named by its heading (aria-labelledby) and screen readers read it when
  // focus moves in; copying the title into the live region put a second "Add resource" in the page.
  const first = box.querySelector('input,select,textarea,button.primary') || box.querySelector(FOCUSABLE);
  if (first) first.focus();
  return { close, el: box };
}
// While a dialog is open the page behind it cannot be reached by Tab, a screen reader's virtual cursor or a
// click; only the top dialog is live. Banners and toasts stay outside, so a warning is still heard.
// Kept in step by watching #modal-root itself, so a dialog removed any way at all (closed, a re-render
// clearing the root, the paused screen) never leaves the page behind it dead.
function syncInertBehindDialogs() {
  const open = [...document.querySelectorAll('#modal-root > .modal-bg')];
  const app = document.getElementById('app');
  // aria-hidden as well as inert: some tools that read the accessibility tree do not yet honour inert.
  const hide = (el, on) => { el.inert = on; if (on) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden'); };
  if (app) hide(app, open.length > 0);
  open.forEach((bg, i) => hide(bg, i < open.length - 1));
}
let dialogWatch = null;
function watchDialogs(root) {
  if (dialogWatch || typeof MutationObserver === 'undefined') return;
  dialogWatch = new MutationObserver(syncInertBehindDialogs);
  dialogWatch.observe(root, { childList: true });
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
      // The whole store: the sealed database (under an epoch key since 1.9.3), its epoch, the vault holding
      // every account's wrap of its key, and a pre-1.9.3 copy; and any keys 1.11 or earlier left in localStorage.
      t.objectStore('kv').clear();
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    };
  }).then(() => { for (const k of ['suds.local.session', 'suds.local.enc', 'suds.local.idx']) { try { localStorage.removeItem(k); } catch {} } });
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
        // The erased device starts over at first-run Sign up, whatever address this page was on.
        if (onDone) onDone(); else { try { history.replaceState(null, '', '#/login?mode=signup'); } catch {} location.reload(); }
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
  // A code in words. With `list` (a documentation list: 'INTERVENTION_TYPES', 'CALL_OUTCOMES'…) it is the
  // wording the programme set under Settings → Lists, which is the only wording a programme's own choice
  // has. Without one it is the code tidied up: the same code ('admin', 'closed', 'other') means different
  // things in different places, so a list's wording is never applied to a value from somewhere else.
  // `list` may be several (a call's outcome is in the phone or the text list): the first that has it.
  label: (s, list) => { if (!s) return '—'; const L = (state.constants || {}).option_lists; if (list && L) for (const k of [].concat(list)) { const e = (L[k] || []).find(x => x.code === s); if (e) return e.label; } return fmt.code(s); },
  // A client's safety flags (free text, comma separated) in words: a flag stored as a code
  // ('no_home_visits', from an import or the sample data) shows its label from the Safety flags list; a
  // flag typed in words is shown as typed.
  flags: (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => { const L = ((state.constants || {}).option_lists || {}).CLIENT_FLAGS || []; const e = L.find(o => o.code === x); return e ? e.label : /^[a-z0-9]+(_[a-z0-9]+)+$/.test(x) ? fmt.code(x) : x; }).join(', '),
  code: (s) => s ? String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSbirt\b/, 'SBIRT').replace(/\bMat\b/g, 'MAT').replace(/\bOtp\b/, 'OTP').replace(/\bObot\b/, 'OBOT').replace(/\bEd\b/, 'ED').replace(/\bMh\b/, 'MH').replace(/\bRx\b/, 'Rx').replace(/\bIds\b/, 'IDs').replace(/\bRoi\b/, 'ROI').replace(/\bPart2 Disclosure\b/, 'Part 2 disclosure').replace(/\bPart2\b/g, 'Part 2') : '—',
  ago: (s) => { const p = fmt.parse(s); if (!p) return 'never'; const d = (Date.now() - p.getTime()) / 86400000; if (d < 1) return 'today'; if (d < 2) return 'yesterday'; return `${Math.floor(d)}d ago`; },
  isoLocal: (d = new Date()) => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; },
  today: () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },
};
// ---- documentation lists (Settings → Lists) ----
// The small link beside a list-driven select: "Edit this list" for an administrator, "Manage" beside a
// Funding source for whoever may add, rename or retire funding sources.
function fieldLink(f) {
  if (f.type === 'select' && f.list && canEditLists()) return h('a', { class: 'field-link small', href: `#/admin?tab=lists&list=${f.list}`, 'data-edit-list': f.list, title: 'Change the choices offered here (Settings → Lists)' }, 'Edit this list');
  if (f.type === 'fund' && can('budget:manage')) return h('a', { class: 'field-link small', href: fundsManageHref(), 'data-manage-funds': '1', title: 'Add, rename or retire funding sources' }, 'Manage');
  return null;
}
/** The entries of one documentation list, as the office set it up: [{ code, label, hidden, custom, protected }]. */
export function listEntries(list) { const C = state.constants || {}; return (C.option_lists && C.option_lists[list]) || (C[list] || []).map(code => ({ code, label: fmt.label(code), hidden: false })); }
/**
 * Select options for a documentation list: the choices a new record may use, in order — plus, when editing
 * a record whose value has since been retired (or is unknown here), that value, so saving the record does
 * not silently change it.
 */
export function listOptions(list, current) {
  const es = listEntries(list);
  const out = es.filter(e => !e.hidden).map(e => ({ value: e.code, label: e.label }));
  if (current && !out.some(o => o.value === current)) { const e = es.find(x => x.code === current); out.push({ value: current, label: `${e ? e.label : fmt.label(current, list)} (no longer offered)` }); }
  return out;
}
/** Every value a filter should offer (retired ones too: old records still carry them). */
export function listFilterOptions(list) { return listEntries(list).map(e => ({ value: e.code, label: e.hidden ? `${e.label} (retired)` : e.label })); }
// The lists belong to the office: a device that syncs with one shows them but cannot change them; SUDS on
// this device (no office) keeps its own.
export const canEditLists = () => can('settings:manage') && (!state.local || !!window.SUDS_STATIC_HOST);
// Funding sources are managed from Settings → Lists by whoever can open Settings, and from Funding &
// spending by anyone else who holds budget:manage (finance cannot open Settings).
export const fundsManageHref = () => (can('users:manage') || can('assignments:manage') ? '#/admin?tab=lists&list=funds' : '#/budget');
/** Fetch the lists again (after an administrator changed one, or funding sources changed). */
// Fetch the fresh lists first and swap them in: emptying state.constants and then awaiting left every view
// that reads it (a dialog opened in that moment) with nothing, or a TypeError.
export async function reloadRefData() {
  let fresh = null;
  try { fresh = await get('/api/meta/constants', { quiet: true }); } catch { /* keep what we have */ }
  if (fresh) state.constants = fresh;
  await loadRefData();
}

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
// fields: [{name,label,type:'text|number|date|datetime|select|textarea|checkbox|client|user|resource|fund', options, list, required, value, span, help, min, max, step}]
// `list` (with type 'select'): a documentation list from Settings → Lists instead of fixed options — the
// choices come from the office's setup, a retired value on the record being edited stays selectable, and an
// administrator gets an "Edit this list" link beside the label. `current`: the record's value when the
// form is not given the record as `values`, so a retired value it has is still offered.
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
// Every date field in a form accepts 1900-01-01 to 2100-12-31 unless the field says otherwise. Without a
// max, Chrome's year segment takes six digits, so digits typed in the wrong order or into the wrong
// segment ended up as dates like 0006-09-05 or 20260-01-01 that looked accepted; read() below refuses a
// date outside the range, by field, instead of saving it.
export const DATE_MIN = '1900-01-01', DATE_MAX = '2100-12-31';
// A calendar button beside a date field, opening the browser's own date picker (input.showPicker()).
// The picker button Chrome draws inside the field ("Show date picker") is a small target at the field's
// right edge that automated testers and some people miss; this one is a full-size button of the page's
// own, never under anything. A browser without showPicker gets the field focused instead.
function datePickButton(input, label) {
  return h('button', { type: 'button', class: 'btn sm date-pick', 'data-date-pick': input.name, 'aria-label': `Choose ${label ? label.replace(/\s*\*$/, '') : 'the date'} from a calendar`, title: 'Open the calendar',
    onClick: () => { try { if (typeof input.showPicker === 'function') { input.focus(); input.showPicker(); } else input.focus(); } catch { input.focus(); } } }, '📅');
}
// Only the overall range is enforced here: a field's own narrower min/max (a date of birth not in the
// future) shapes the picker, and an existing record outside it must still be editable.
const dateOutOfRange = (i) => !!i.value && (!/^\d{4}-\d{2}-\d{2}$/.test(i.value) || i.value < DATE_MIN || i.value > DATE_MAX);
function dateTimePair(f, v) {
  const dateI = h('input', { type: 'date', name: f.name, required: !!f.required, 'aria-label': `${f.label} — date`, min: f.min || DATE_MIN, max: f.max || DATE_MAX });
  const timeI = h('input', { type: 'time', name: `${f.name}_time`, 'aria-label': `${f.label} — time (optional)` });
  const wrap = h('div', { class: 'dt-pair' }, dateI, datePickButton(dateI, f.label), timeI);
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
      // heading: the summary carries an h3, so a long form's sections are in the page's outline (a screen
      // reader's heading list) as well as being folded away.
      if (f.collapsible) { const inner = h('div', { class: 'form-grid' }); grid.append(h('details', { class: 'section', open: !!f.open, 'data-section': f.heading ? f.label : null }, h('summary', {}, f.heading ? h('h3', { class: 'summary-heading' }, f.label) : f.label, f.hint ? h('span', { class: 'muted small' }, ` — ${f.hint}`) : null), inner)); target = inner; }
      else { target = grid; grid.append(h('div', { class: 'span' }, h('h3', { class: 'eyebrow' }, f.label))); }
      continue;
    }
    let input; const v = values[f.name] ?? f.value ?? '';
    const opts = f.list ? listOptions(f.list, values[f.name] ?? f.current) : (f.options || []).map(o => typeof o === 'string' ? { value: o, label: fmt.label(o) } : o);
    switch (f.type) {
      case 'select': input = h('select', { name: f.name, required: !!f.required }, f.noBlank ? null : h('option', { value: '' }, f.placeholder || '—'), opts.map(o => h('option', { value: o.value, selected: String(o.value) === String(v), disabled: !!o.disabled, title: o.title || null }, o.label))); break;
      case 'textarea': input = h('textarea', { name: f.name, required: !!f.required, rows: f.rows || 4, placeholder: f.placeholder || '' }, v || ''); break;
      case 'checkbox': input = h('input', { type: 'checkbox', name: f.name, checked: !!(v === 1 || v === true || v === '1') }); break;
      case 'datetime': input = dateTimePair(f, v); break;
      case 'date': input = h('input', { type: 'date', name: f.name, required: !!f.required, value: v ? String(v).slice(0, 10) : '', min: f.min || DATE_MIN, max: f.max || DATE_MAX }); break;
      case 'number': input = h('input', { type: 'number', name: f.name, required: !!f.required, value: v ?? '', min: f.min, max: f.max, step: f.step ?? 'any', placeholder: f.placeholder || '' }); break;
      case 'client': input = clientPicker(f.name, v, f); break;
      case 'user': input = h('select', { name: f.name, required: !!f.required }, h('option', { value: '' }, f.placeholder || '—'), state.users.filter(u => u.is_active !== 0).map(u => h('option', { value: u.id, selected: u.id === v }, `${u.display_name} (${fmt.label(u.role)})`))); break;
      case 'fund': { const inactive = v && !state.funds.some(x => x.id === v) ? (state.allFunds || []).find(x => x.id === v) : null; input = h('select', { name: f.name, required: !!f.required }, h('option', { value: '' }, '—'), state.funds.map(x => h('option', { value: x.id, selected: x.id === v }, x.name)), inactive ? h('option', { value: inactive.id, selected: true }, `${inactive.name} (inactive)`) : null); break; }
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
    // A client picker is a wrapper; its name, description and required state belong on the search box.
    for (const ctl of input && input.dateInput ? [input.dateInput, input.timeInput] : input && input.searchInput ? [input.searchInput] : [input]) {
      if (!ctl || !ctl.tagName) continue;
      ctl.id = ctl === input.timeInput ? `${fieldId}-time` : fieldId;
      ctl.setAttribute('aria-describedby', [helpId, errId].filter(Boolean).join(' '));
      if (f.required && ctl !== input.timeInput) ctl.setAttribute('aria-required', 'true');
    }
    const errEl = h('div', { class: 'err', id: errId, role: 'alert' });
    const wrap = h('div', { class: `field ${f.span ? 'span' : ''}`, 'data-field': f.name },
      f.type === 'checkbox' ? h('label', { class: 'check', for: fieldId }, input, f.label) : [h('label', { for: fieldId }, f.label, f.required ? ' *' : ''), fieldLink(f), f.type === 'date' ? h('div', { class: 'date-with-pick' }, input, datePickButton(input, f.label)) : input],
      f.help ? h('div', { class: 'help', id: helpId }, f.help) : null, errEl);
    target.append(wrap);
  }
  // What each control showed when the form opened (before any restored draft), so an edit form can send
  // only what the person actually changed (el.changedKeys) instead of every field it happens to display.
  const rawValue = (f) => { const i = inputs[f.name]; if (!i) return undefined; return f.type === 'checkbox' ? !!i.checked : String(i.value ?? ''); };
  const initial = Object.fromEntries(fields.filter(f => f.type !== 'section').map(f => [f.name, rawValue(f)]));
  // A draft kept from an earlier attempt at this same form wins over the defaults.
  const restored = draftKey && drafts.get(draftKey);
  if (restored) for (const [k, v] of Object.entries(restored)) { const i = inputs[k]; if (!i) continue; if (i.type === 'checkbox') i.checked = !!v; else i.value = v ?? ''; }
  const errBox = h('div', { class: 'banner danger hidden', role: 'alert', tabindex: '-1' });
  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, submitText);
  let submitted = false; let saveTimer;
  // This submission's Idempotency-Key base (see idempotencyKey above): kept while the contents are
  // unchanged, so a retry is the same submission; replaced when anything is edited or after a save.
  let submitKey = newIdempotencyKey();
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
      const data = read();
      submitScope = { key: submitKey, seq: new Map() };
      try { await onSubmit(data, el); } finally { submitScope = null; }
      submitKey = newIdempotencyKey();
      // Saved: the draft is finished with, and no autosave still queued behind this submit may put it back
      // — the debounced savers below used to fire after the delete, so the next "+ New client" opened
      // prefilled with the person just created.
      submitted = true; clearTimeout(saveTimer); if (draftKey) drafts.delete(draftKey);
    } catch (err) {
      if (!err || typeof err !== 'object') err = new Error(String(err || 'Something went wrong'));
      if (!err.message) err.message = 'Something went wrong. Try again.';
      const fieldsErr = err.data && err.data.fields;
      let firstBad = null;
      const labelOf = (k) => (fields.find(f => f.name === k) || {}).label || k;
      if (fieldsErr) for (const [k, msg] of Object.entries(fieldsErr)) {
        const w = el.querySelector(`[data-field="${k}"]`);
        if (!w) continue;
        w.classList.add('error');
        // A field folded away in a closed section is opened, so the error and the focus land on something visible.
        for (let d = w.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
        // Under the field, say which field: "Client is required", not a bare "is required" (a server
        // message in that shape gets the label put in front of it too).
        const slot = w.querySelector('.err'); if (slot) slot.textContent = /^(is|must|should)\b/.test(String(msg)) ? `${labelOf(k)} ${msg}` : msg;
        const control = w.querySelector('input,select,textarea');
        if (control) { control.setAttribute('aria-invalid', 'true'); if (!firstBad) firstBad = control; }
      }
      // Field errors are already shown inline under each field; the banner names them the way the form
      // does ("Client"), never by column ("client_id").
      const text = err.labelled ? err.message : err.message + (fieldsErr ? ': ' + Object.entries(fieldsErr).map(([k, m]) => `${labelOf(k)} ${m}`).join('; ') : '');
      errBox.textContent = text; errBox.classList.remove('hidden');
      // Someone else saved this record after it was opened (409 from if_updated_at). Saving again would
      // overwrite their changes, so the way forward is to reload and see them. The draft goes too: restoring
      // it over the fresh record would put back the very values the other person just changed.
      if (err.status === 409 && err.data && err.data.stale) {
        errBox.append(' ', h('button', { class: 'btn sm', type: 'button', 'data-reload-stale': '1', onClick: () => { submitted = true; clearTimeout(saveTimer); if (draftKey) drafts.delete(draftKey); render(); } }, 'Reload'));
      }
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

  // Changed contents are a different submission, with a different Idempotency-Key.
  const newSubmission = () => { submitKey = newIdempotencyKey(); };
  el.addEventListener('input', newSubmission); el.addEventListener('change', newSubmission);
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
  // Keep what is typed right now as a draft (the paused screen closes every dialog; see showPausedScreen).
  el.saveDraft = () => { if (draftKey && !submitted) { clearTimeout(saveTimer); try { const d = read(); if (Object.values(d).some(v => v !== '' && v !== null && v !== undefined && v !== 0)) drafts.set(draftKey, d); } catch {} } };
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
        if (d.validity?.badInput || t.validity?.badInput || (t.value && !d.value) || dateOutOfRange(d)) { bad.push(f); data[f.name] = null; }
        else if (!d.value) data[f.name] = null;
        // A required date & time (a visit, a call) with no time is midnight local, so it orders among
        // that day's other records; an optional one (a due date, an appointment) is kept as the calendar
        // day itself, which the server and fmt.dt already understand (a to-do due "Oct 1" is due all day).
        else if (!t.value) data[f.name] = f.required ? new Date(`${d.value}T00:00`).toISOString() : d.value;
        else data[f.name] = new Date(`${d.value}T${t.value}`).toISOString();
      }
      // A date the browser half-parsed (badInput) or a year typed into the wrong segment (0006, 20260) is
      // refused by field rather than saved.
      else if (f.type === 'date' && (i.validity?.badInput || dateOutOfRange(i))) { bad.push(f); data[f.name] = null; }
      else data[f.name] = i.value === '' ? null : i.value;
      if (f.required && (data[f.name] === null || data[f.name] === undefined || data[f.name] === '') && !bad.includes(f)) missing.push(f);
    }
    if (bad.length || missing.length) {
      const badMsg = (f) => { const i = inputs[f.name]; const d = i.dateInput || i;
        return d.value && dateOutOfRange(d) ? `is not a real date: the year must be four digits, between ${DATE_MIN.slice(0, 4)} and ${DATE_MAX.slice(0, 4)}` : f.type === 'datetime' ? 'enter a valid date (the time is optional), or leave both blank' : 'enter a valid date, or leave it blank'; };
      const fields = { ...Object.fromEntries(bad.map(f => [f.name, badMsg(f)])), ...Object.fromEntries(missing.map(f => [f.name, `${f.label || 'This field'} is required`])) };
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
  // Names of the fields whose control differs from what the form opened with.
  el.changedKeys = () => fields.filter(f => f.type !== 'section' && inputs[f.name] && rawValue(f) !== initial[f.name]).map(f => f.name);
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
  // What the search found when it found nothing ("No matches…") is said beside the list, not inside it: a
  // listbox holds options only.
  const msg = h('div', { class: 'card tight hidden client-picker-list muted small', 'data-picker-message': '1', style: { marginTop: '.25rem' } });
  const wrap = h('div', { class: 'client-picker' }, text, hidden, list, msg);
  wrap.searchInput = text;
  Object.defineProperty(wrap, 'value', { get: () => hidden.value, set: (v) => { hidden.value = v || ''; } });
  hidden.value = value || '';
  if (value && f.display) text.value = f.display;
  else if (value) get(`/api/clients/${value}`, { quiet: true }).then(r => { text.value = `${r.client.display_name} (${r.client.client_code})`; }).catch(() => {});

  let timer; let options = []; let active = -1;
  const openList = (open) => { if (!open) msg.classList.add('hidden'); list.classList.toggle('hidden', !open || !options.length); text.setAttribute('aria-expanded', String(open && options.length > 0)); if (!open) { active = -1; text.removeAttribute('aria-activedescendant'); } };
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
      clear(list); options = []; active = -1; msg.classList.add('hidden');
      if (!r.clients.length) {
        msg.textContent = q ? 'No matches. Try a first, last or preferred name, the full phone number, date of birth or client code.' : 'Type to search';
        msg.classList.remove('hidden');
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
  // A clickable row opens on a click anywhere in it, and from the keyboard through a real button: the first
  // cell's content (a name, a date) is that button, so Tab reaches one control per row and a screen reader
  // hears a button named by what the row shows. The row itself stays a table row, so its cells are still read
  // with their column headings (WCAG 1.3.1, 2.1.1, 4.1.2). A cell that already holds a control of its own is
  // passed over for the next one; a row with no such cell gets an "Open" button at its end.
  // (rowLabel is accepted but not applied: a row's name is its own visible text, WCAG 2.5.3.)
  const cell = (c, r) => (c.render ? c.render(r) : (r[c.key] ?? '—'));
  const rowFor = (r) => {
    const cells = columns.map(c => h('td', { class: c.num ? 'num' : '', 'data-label': c.label || '' }, cell(c, r)));
    if (!onRow) return h('tr', {}, cells);
    const open = (e) => { e.stopPropagation(); onRow(r); };
    const td = cells.find(x => x.textContent.trim() && !x.querySelector(FOCUSABLE));
    if (td) { const b = h('button', { type: 'button', class: 'row-open', onClick: open }); b.append(...td.childNodes); td.append(b); }
    else cells[cells.length - 1].append(h('button', { type: 'button', class: 'btn sm ghost row-open-extra', onClick: open }, 'Open'));
    return h('tr', { class: 'click', onClick: () => onRow(r) }, cells);
  };
  // A column with no heading (the Edit/Delete buttons, a select box) still has one for a screen reader.
  const t = h('table', {}, h('thead', {}, h('tr', {}, columns.map(c => h('th', { class: c.num ? 'num' : '', scope: 'col' }, c.label || h('span', { class: 'sr-only' }, c.srLabel || 'Actions'))))),
    h('tbody', {}, rows.map(rowFor)));
  if (compact && wrap) {
    const tap = compact.onTap || onRow;
    const list = h('div', { class: 'compact-list' }, rows.map(r => {
      const primary = h('div', { class: 'primary' }, compact.primary(r));
      const secondary = compact.secondary ? h('div', { class: 'secondary small muted' }, compact.secondary(r)) : null;
      if (!tap) return h('div', { class: 'compact-row' }, primary, secondary);
      // A row that holds a control of its own (a to-do's done box) cannot also be a button — a control inside
      // a control (WCAG 4.1.2). The row still opens on a tap; the keyboard gets its own "Open" button.
      if (primary.querySelector(FOCUSABLE) || (secondary && secondary.querySelector(FOCUSABLE))) {
        primary.append(h('button', { type: 'button', class: 'btn ghost sm compact-open', onClick: (e) => { e.stopPropagation(); tap(r); } }, h('span', { class: 'sr-only' }, `Open ${primary.textContent.trim()}`), h('span', { 'aria-hidden': 'true' }, '›')));
        return h('div', { class: 'compact-row click', onClick: () => tap(r) }, primary, secondary);
      }
      return h('div', { class: 'compact-row click', tabindex: '0', role: 'button', onClick: () => tap(r), onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap(r); } } }, primary, secondary);
    }));
    return h('div', { class: 'table-wrap has-compact' }, t, list);
  }
  // Unwrapped (a small table inside a card) still scrolls inside its own frame when it is wider than a
  // phone, rather than pushing the page sideways or being cut off (WCAG 1.4.10).
  return wrap ? h('div', { class: 'table-wrap' }, t) : h('div', { class: 'table-scroll' }, t);
}

/**
 * A list that shows its first page and a "Load more" button while there are more rows on the server.
 * The list pages used to ask for 300 (the client list 200) and stop there, with nothing to say so.
 *   first: the first page's response ({ rows|clients, total }); url: the same request without limit/offset;
 *   key: the array in the response; limit: rows per further page; render(rows): the table (or anything)
 *   for everything loaded so far; summary(rows, total): optional line above it that updates as rows arrive.
 * Rows already shown are not repeated if something was added in between (offset paging shifts by one).
 */
export function pagedList({ first, url, key = 'rows', limit = 200, render, summary }) {
  let rows = (first[key] || []).slice(); let total = Number(first.total ?? rows.length); let offset = rows.length;
  const box = h('div', { 'data-paged-list': '1' });
  const draw = (focusFrom) => {
    clear(box);
    if (summary) box.append(summary(rows, total));
    box.append(render(rows));
    if (rows.length < total) {
      const btn = h('button', { class: 'btn', type: 'button', 'data-load-more': '1', onClick: () => more(btn) }, `Load more (${fmt.num(Math.min(limit, total - rows.length))} of ${fmt.num(total - rows.length)} remaining)`);
      box.append(h('div', { class: 'row mt load-more' }, h('span', { class: 'muted small', 'data-shown': String(rows.length) }, `Showing ${fmt.num(rows.length)} of ${fmt.num(total)}`), btn));
    }
    // Keep a keyboard user where they were: on the first row that just arrived.
    if (focusFrom !== undefined) { const r = box.querySelectorAll('tbody tr')[focusFrom]; const b = r && r.querySelector('.row-open, .row-open-extra'); if (b) b.focus({ preventScroll: true }); else if (r) { if (!r.hasAttribute('tabindex')) r.setAttribute('tabindex', '-1'); r.focus({ preventScroll: true }); } }
  };
  const more = async (btn) => {
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const d = await get(`${url}${url.includes('?') ? '&' : '?'}limit=${limit}&offset=${offset}`);
      offset += (d[key] || []).length;
      const seen = new Set(rows.map(r => r.id));
      const from = rows.length;
      rows = rows.concat((d[key] || []).filter(r => !r.id || !seen.has(r.id)));
      total = Number(d.total ?? total);
      // Nothing new came back (rows were deleted meanwhile): stop offering more rather than loop.
      if (!(d[key] || []).length || offset >= total) total = rows.length;
      draw(from);
    } catch (e) { btn.disabled = false; btn.textContent = 'Load more'; toast(e.message || 'Could not load more', 'error'); }
  };
  draw();
  return box;
}

// A tab strip that folds the tabs that do not fit into a "More ▾" menu instead of scrolling them off the
// edge with nothing to say so. Re-measured on resize; the active tab is always kept in view.
// `core`: the keys of the sections used every day. On a phone (600px or narrower) only those — and the
// current section — stay in the strip, whatever else would fit; the rest are under More.
// Each tab is its own address (#/client/…/notes), so the strip is navigation, not an ARIA tab widget: a
// labelled <nav> of buttons, the current one marked aria-current="page" (WCAG 1.3.1, 4.1.2). role=tablist
// promised arrow-key behaviour and tab panels that were never there, and could not hold the More button.
export function tabStrip(tabs, active, onPick, { label = 'Sections', core = null } = {}) {
  const strip = h('nav', { class: 'tabs managed', 'aria-label': label });
  const buttons = tabs.map(([k, text]) => h('button', { class: k === active ? 'active' : '', type: 'button', 'aria-current': k === active ? 'page' : null, 'data-tab': k, onClick: () => onPick(k) }, text));
  const menu = h('div', { class: 'tabs-menu hidden', role: 'menu' });
  const moreBtn = h('button', { class: 'tabs-more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  const moreText = (n) => { clear(moreBtn).append(n === undefined ? 'More' : `More (${n})`, h('span', { 'aria-hidden': 'true' }, ' ▾')); };
  moreText();
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
    clear(menu); wrap.hidden = false; moreText(buttons.length); // measured at its widest
    const avail = strip.clientWidth; if (!avail) return;
    // A phone with everyday sections named: those (and the current one) stay, in order, wrapping onto a
    // second row rather than being measured out; everything else is under More.
    const phoneCore = core && matchMedia('(max-width: 600px)').matches ? new Set(core) : null;
    strip.classList.toggle('core-wrap', !!phoneCore);
    if (phoneCore) {
      const overflow = buttons.map((_, i) => i).filter(i => !phoneCore.has(tabs[i][0]) && tabs[i][0] !== active);
      if (!overflow.length) { wrap.hidden = true; setOpen(false); return; }
      for (const i of overflow) { buttons[i].hidden = true; menu.append(menuItem(i)); }
      moreText(overflow.length);
      return;
    }
    const widths = buttons.map(b => b.offsetWidth + 4);
    if (widths.reduce((a, b) => a + b, 0) <= avail) { wrap.hidden = true; setOpen(false); return; }
    const limit = avail - (wrap.offsetWidth + 8);
    let used = 0; const overflow = [];
    buttons.forEach((b, i) => { if (!overflow.length && used + widths[i] <= limit) used += widths[i]; else overflow.push(i); });
    const activeIdx = buttons.findIndex(b => b.classList.contains('active'));
    if (overflow.includes(activeIdx) && overflow[0] > 0) { overflow[overflow.indexOf(activeIdx)] = overflow[0] - 1; }
    for (const i of overflow.sort((a, b) => a - b)) { buttons[i].hidden = true; menu.append(menuItem(i)); }
    // The active tab, if it was swapped in, goes right before the More button so the strip reads in order.
    if (!buttons[activeIdx]?.hidden) strip.insertBefore(buttons[activeIdx], wrap);
    moreText(overflow.length);
  }
  function menuItem(i) {
    const b = buttons[i];
    return h('button', { role: 'menuitem', type: 'button', class: b.classList.contains('active') ? 'active' : '', 'aria-current': b.classList.contains('active') ? 'page' : null, onClick: () => { setOpen(false); onPick(tabs[i][0]); } }, tabs[i][1]);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => layout()).observe(strip);
  else requestAnimationFrame(layout);
  strip.relayout = layout;
  return strip;
}
/**
 * A simple row of section buttons for a page whose sections are addresses (Settings, Funding, Supervision).
 * items: [[key, label, extraAttrs?]]; the current one is aria-current="page", not only a colour.
 */
export function pageTabs(items, active, onPick, { label = 'Sections' } = {}) {
  return h('nav', { class: 'tabs', 'aria-label': label }, items.filter(Boolean).map(([k, text, attrs]) => h('button', { ...(attrs || {}), type: 'button', class: k === active ? 'active' : '', 'aria-current': k === active ? 'page' : null, 'data-tab': k, onClick: () => onPick(k) }, text)));
}
export function bars(items, { max, valueKey = 'n', labelKey = 'k', format = fmt.num, link = null, list = null } = {}) {
  // A value can be a string such as "<11" (a suppressed small cell in the funder report): it draws no bar and
  // is printed as sent.
  const numOf = (i) => { const n = Number(i[valueKey]); return Number.isFinite(n) ? n : 0; };
  const show = (v) => (Number.isFinite(Number(v)) ? format(v) : String(v ?? ''));
  const m = max || Math.max(1, ...items.map(numOf));
  if (!items.length) return h('div', { class: 'muted small' }, 'No data');
  return h('div', {}, items.map(i => { const href = link && link(i) && reachable(link(i)) ? link(i) : null; const row = [h('div', { class: 'lbl', title: fmt.label(i[labelKey], list) }, fmt.label(i[labelKey], list)), h('div', { class: 'trk' }, h('div', { class: 'fil', style: { width: `${(numOf(i) / m) * 100}%` } })), h('div', { class: 'n' }, show(i[valueKey]))];
    return href ? h('a', { class: 'bar link', href: href.startsWith('#') ? href : '#/' + href, title: 'Show these' }, row) : h('div', { class: 'bar' }, row); }));
}
// A sparkline is a picture of numbers: it carries them as its text alternative (WCAG 1.1.1), so a screen
// reader hears the series and someone who cannot tell the bar heights apart can still get the values.
export function sparkline(values, { label = 'Trend', unit = '' } = {}) {
  const m = Math.max(1, ...values);
  const text = values.length ? `${label}: ${values.join(', ')}${unit ? ' ' + unit : ''} (oldest first; highest ${Math.max(...values)})` : `${label}: no data`;
  return h('div', { class: 'spark', role: 'img', 'aria-label': text, title: text }, values.map(v => h('div', { style: { height: `${(v / m) * 100}%` } })));
}
/**
 * Emphasis that is not colour alone (WCAG 1.4.1): a value shown in red or amber because it needs attention
 * also carries a symbol and says why — visibly (⚠ and a tooltip) and to a screen reader. `on` false renders
 * the content plain. Use this, not an inline `color: var(--danger)`, for any at-risk value.
 */
export function flag(content, on, why, kind = 'danger') {
  if (!on) return h('span', {}, content);
  return h('span', { class: `flag ${kind}`, title: why }, h('span', { 'aria-hidden': 'true' }, '⚠\u00a0'), content, h('span', { class: 'sr-only' }, ` (${why})`));
}
// A number or bar on Home links to the page it counts only for someone who may open that page: for a
// read-only oversight account every "Active clients ›" used to land on "Not available for your role".
function reachable(href) {
  const name = String(href).replace(/^#?\/?/, '').split(/[/?]/)[0];
  const item = NAV.find(n => n.name === name);
  return !item || !item.perm || canAny(item.perm);
}
export function stat(label, value, kind = '', href = null, title = 'Open') {
  // A red or amber figure also carries ⚠ (and says "needs attention" to a screen reader): WCAG 1.4.1.
  const alert = kind === 'danger' || kind === 'warn';
  const body = [h('div', { class: 'v' }, alert ? h('span', { 'aria-hidden': 'true', class: 'stat-flag' }, '⚠ ') : null, value, alert ? h('span', { class: 'sr-only' }, ' (needs attention)') : null), h('div', { class: 'l' }, label)];
  return href && reachable(href) ? h('a', { class: `card stat link ${kind}`, href: href.startsWith('#') ? href : '#/' + href, title }, body) : h('div', { class: `card stat ${kind}` }, body);
}
export function kv(pairs) { return h('dl', { class: 'kv' }, pairs.filter(p => p).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')])); }
export function pageHead(title, ...actions) {
  const r = parseHash(); const item = NAV.find(n => n.name === r.name);
  return h('div', { class: 'topbar' }, h('div', { class: 'row', style: { gap: '.4rem' } }, h('h1', {}, title), item?.help ? helpTip(item.help) : null), h('div', { class: 'row' }, actions));
}
// Small "?" that reveals a plain-language explanation
export function helpTip(text) {
  // A disclosure: the button says whether the explanation is showing (aria-expanded) and Escape puts it away.
  const id = 'help-' + Math.random().toString(36).slice(2, 9);
  const box = h('div', { class: 'helptip hidden', id, role: 'note' }, text);
  const show = (on) => { box.classList.toggle('hidden', !on); btn.setAttribute('aria-expanded', String(on)); };
  const btn = h('button', { class: 'help-btn', type: 'button', 'aria-label': 'What is this?', 'aria-expanded': 'false', 'aria-controls': id, onClick: () => show(box.classList.contains('hidden')) }, '?');
  const wrap = h('span', { class: 'help-wrap', onKeydown: (e) => { if (e.key === 'Escape' && !box.classList.contains('hidden')) { e.stopPropagation(); show(false); btn.focus(); } } }, btn, box);
  return wrap;
}
// Empty state with one obvious next step
// The accessibility statement (public/accessibility.html; docs/accessibility/STATEMENT.md): how SUDS meets
// WCAG 2.1 AA, what does not yet, and how to report a barrier. Linked from every screen's footer.
export function accessibilityLink() { return h('p', { class: 'small center a11y-link' }, h('a', { href: 'accessibility.html', 'data-accessibility-statement': '1' }, 'Accessibility')); }
// `level`: when the empty state is the whole page (Not found, Not available), its title is that page's heading.
export function emptyState(title, text, action, { level = 0 } = {}) { return h('div', { class: 'empty-state' }, h(level ? `h${level}` : 'div', { class: 'big' }, title), h('p', { class: 'muted' }, text), action || null); }

// "+ Log" quick action: the one button non-technical users need most
export function quickActions() {
  const items = [
    can('interventions:write') ? ['✚', 'Visit', async () => (await import('./views/interventions.js')).openInterventionForm(null, { onDone: render })] : null,
    can('calls:write') ? ['☎', 'Phone call', async () => (await import('./views/calls.js')).openCallForm(null, { onDone: render })] : null,
    can('calls:write') ? ['💬', 'Text message', async () => (await import('./views/calls.js')).openCallForm(null, { method: 'text', onDone: render })] : null,
    (can('notes:admin:write') || can('notes:clinical:write')) ? ['✎', 'Note', async () => (await import('./views/notes.js')).openNoteForm(null, { onDone: render })] : null,
    can('tasks:write') ? ['☑', 'To-do', async () => (await import('./views/tasks.js')).openTaskForm(null, { onDone: render })] : null,
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
  const btn = h('a', { class: 'btn ghost bell', href: '#/tasks?overdue=1', 'data-due-bell': '1', 'aria-label': 'To-dos due', title: 'To-dos due within the hour, or overdue' }, h('span', { 'aria-hidden': 'true' }, '🔔'), count);
  const paint = (r) => {
    const n = r ? r.rows.length : 0;
    count.textContent = String(n); count.classList.toggle('hidden', !n); btn.classList.toggle('has-due', !!n);
    btn.setAttribute('aria-label', n ? `${n} to-do${n === 1 ? '' : 's'} due or overdue` : 'No to-dos due');
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
      const n = new Notification(t.overdue ? 'Overdue to-do' : 'To-do due now', { body: t.title + (t.client_name ? ` · ${t.client_name}` : ''), tag: `suds-task-${t.id}` });
      n.onclick = () => { window.focus(); nav(`tasks?id=${t.id}`); n.close(); };
    } catch { /* the browser refused; the badge still shows it */ }
  }
}
// Welcome tour shown once per user (stored in synced preferences)
let tourOpen = false;
export function maybeTour() {
  if (paused || prefs.get('tour_done') || tourOpen || document.querySelector('.modal-bg')) return;
  tourOpen = true;
  const steps = [
    ['Welcome to SUDS', `Hi ${greetingName(state.user.display_name, state.user.username)}. SUDS keeps your programme's outreach, visits, naloxone and supplies, referrals and follow-ups in one place, with the privacy substance-use records need. ${window.SUDS_STATIC_HOST
      // The on-device app never syncs with anything (local/sync.js): promising "shows up on the other right
      // away" there sent people looking for their entries on a second device.
      ? 'Everything you record stays in this browser on this device, encrypted. Download a backup regularly from This device so a cleared browser or a lost phone does not take your records with it.'
      : state.local ? 'This copy keeps your work on this device; it reaches the office SUDS when you sync.'
      : 'It works the same on your phone and your computer. Anything you add on one shows up on the other right away.'}`],
    ['Start with Home', 'Home shows what needs attention today: to-dos due, clients you have not contacted in a while, and drafts you started on another device.'],
    ['Record work with + Log', 'The blue + Log button (top of the page, or bottom-right on a phone) records a visit, call, note, to-do or time in a few taps. Visits and calls also fill in your time sheet.'],
    ['Find anyone fast', 'Use the search box at the top with a last name, phone number or client code. Open a client to see their story: visits, calls, notes, referrals and to-dos on one timeline.'],
    ['Look for the ? marks', 'Every page has a ? that explains it in plain language. You cannot break anything: records are never truly deleted and every change is logged.'],
  ];
  let i = 0; const body = h('div', {}); const dots = h('div', { class: 'muted small center' });
  let nextBtn;
  // The last step's button ends the tour, so it says so rather than promising a step that is not there.
  const draw = () => { clear(body).append(h('h2', {}, steps[i][0]), h('p', { style: { fontSize: '1.05rem' } }, steps[i][1])); dots.textContent = `${i + 1} of ${steps.length}`; if (nextBtn) nextBtn.textContent = i === steps.length - 1 ? 'Done' : 'Next'; };
  // Closing the dialog any other way (backdrop, Escape, the corner button) counts as "skip" too -- it must
  // not come back on every page load, and it must never sit blocking the app on a phone in the field.
  const finish = () => { prefs.set('tour_done', true); tourOpen = false; m.close(); };
  const m = modal('', h('div', {}, body, h('div', { class: 'btn-row', style: { justifyContent: 'space-between', alignItems: 'center' } }, h('button', { class: 'btn ghost', onClick: finish }, 'Skip'), dots, nextBtn = h('button', { class: 'btn primary', onClick: () => { if (i < steps.length - 1) { i++; draw(); } else finish(); } }, 'Next'))), { onClose: () => { prefs.set('tour_done', true); tourOpen = false; } });
  m.el.querySelector('.card-head').remove(); draw();
}
export async function downloadCsv(path) {
  if (state.local && window.SUDS_LOCAL) { const r = await window.SUDS_LOCAL.handle('GET', path, undefined, {}); if (r.status >= 400) { toast('Download failed', 'error'); return; } const name = (/filename="([^"]+)"/.exec(r.headers['content-disposition'] || '') || [])[1] || 'download'; 
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
// The name a greeting uses: the display name exactly as the person typed it ("QATEST QA Engineer",
// "Dr. Kiran Patel"), with runs of spaces collapsed. It used to be cut to a first name ("Good evening,
// QATEST" for "QATEST QA Engineer"), which a tester read — twice — as the name being truncated; a
// person's display name is theirs to choose, so it is shown whole. Never re-cased; a blank display name
// falls back to the username so a greeting is never "Good morning, ".
export const greetingName = (n, fallback = '') => {
  const name = String(n || '').trim().split(/\s+/).filter(Boolean).join(' ');
  return name || String(fallback || '').trim();
};
const canAny = (perm) => (Array.isArray(perm) ? perm.some(p => can(p)) : can(perm));
export function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'dashboard', id: parts[1], sub: parts[2], query: new URLSearchParams(qs || '') };
}
export function nav(to) { location.hash = to.startsWith('#') ? to : '#/' + to; }

// The sidebar. Each entry shows for a role that holds its permission (perm) — and, so a front-line worker's
// sidebar is the handful of pages they use every day rather than every page they may open, two more marks:
//   more: true       — for front-line roles (frontline() below) it folds into a closed "More" group at the end;
//                      everyone else sees it in its section.
//   programme: true  — the programme's own pages (money, contracts, imports, the funder report, settings), in
//                      the "Programme" section, shown to the roles that run the programme. A front-line worker
//                      who may still open one (a navigator may record spending) reaches it from the page that
//                      needs it, or its address; Import, which Home links to for imported notes, sits in More.
// Nothing here changes a permission: the server decides what each role may do (server/auth.js PERMS).
export const NAV = [
  { sec: 'My day' },
  { name: 'dashboard', label: 'Home', ico: '⌂', help: 'What needs attention today, and where you left off on any device.' },
  { name: 'clients', label: 'My clients', ico: '👤', perm: 'clients:read', help: 'Everyone you serve. Open a client to see their whole story in one place.' },
  { name: 'waitlist', label: 'Waitlist', ico: '⧗', perm: 'clients:read', more: true, help: 'People waiting for a place, longest and highest risk first.' },
  { name: 'tasks', label: 'To-dos', ico: '☑', perm: 'tasks:read', help: 'Your to-dos: follow-ups and reminders. Check a box when it is done.' },
  { name: 'supervision', label: 'Supervision', ico: '✍', perm: ['notes:cosign', 'time:approve', 'assignments:manage'], help: 'Notes waiting for your countersignature, drafts your team has not finished, staff time to approve, and referrals with no outcome recorded.' },
  { sec: 'Record work' },
  { name: 'interventions', label: 'Visits', ico: '✚', perm: 'interventions:read', help: 'Every visit: the face-to-face or phone services you provide — outreach, screenings, warm handoffs, naloxone, transport and more.' },
  { name: 'calls', label: 'Calls & texts', ico: '☎', perm: 'calls:read', help: 'Phone calls and text messages with clients, families and providers — including ones that went to voicemail or got no reply.' },
  { name: 'notes', label: 'Notes', ico: '✎', perm: 'notes:admin:read', help: 'Written documentation. Drafts save automatically and can be finished on any device; sign when complete.' },
  { name: 'supplies', label: 'Supplies', ico: '📦', perm: 'interventions:read', help: 'Naloxone kits, test strips and other harm-reduction stock on hand. A visit that hands out kits or strips takes them off this count automatically.' },
  { name: 'overdose', label: 'Overdose & reversals', ico: '⛑', perm: 'overdose:read', help: 'Overdoses and naloxone reversals, including ones involving people who are not clients. These are the counts funders ask for.' },
  { name: 'forms', label: 'Forms', ico: '🧾', perm: 'forms:read', more: true, help: 'County forms (releases, intake sheets, assistance requests). Fill one out from a client record: it is pre-filled from the chart, printable, and holds the signed copy.' },
  { name: 'time', label: 'My time', ico: '◷', perm: 'time:read', more: true, help: 'Your hours by activity. Visits and calls add time automatically; log meetings, travel and paperwork here.' },
  { sec: 'Connect clients' },
  { name: 'referrals', label: 'Referrals', ico: '⇢', perm: 'referrals:read', help: 'Track each referral from "sent" to "admitted" so nothing falls through the cracks.' },
  { name: 'resources', label: 'Resource directory', ico: '☰', perm: 'resources:read', help: 'Syringe services, drop-ins, shelters, MAT and treatment programmes, legal aid and the other partners you refer people to.' },
  { sec: 'Programme' },
  { name: 'reports', label: 'Reports', ico: '▤', perm: 'reports:read', more: true, help: 'Numbers for your funders and supervisors. Exports never include client names unless you ask.' },
  { name: 'funder', label: 'Funder report', ico: '▦', perm: 'reports:read', programme: true, help: 'Unduplicated counts — people, not services — by fiscal period and funding source, with admissions, discharges, demographics and overdose figures in the shape a grant report asks for.' },
  { name: 'budget', label: 'Funding & spending', ico: '$', perm: 'budget:read', programme: true, help: 'Grants and what has been spent, including client assistance such as bus passes and IDs.' },
  { name: 'documents', label: 'Policies & contracts', ico: '📋', perm: 'documents:read', programme: true, help: 'County policies, procedures and signed contracts, searchable by title and category.' },
  { name: 'compliance', label: 'Privacy & Part 2', ico: '⚖', perm: ['consents:read', 'complaints:read', 'incidents:read', 'settings:manage'], more: true, help: '42 CFR Part 2: the patient notice and who has not been given it, the privacy complaint log, and the incident and breach register with its 60-day notification clock.' },
  { name: 'imports', label: 'Import', ico: '⇩', perm: 'imports:write', programme: true, more: true, help: 'Bring in spreadsheets (Excel / CSV) of clients, visits, calls, resources and more, or notes from Pocket AI and OneNote. Everything is checked before it is saved.' },
  // A supervisor holds assignments:manage (moving a caseload when someone leaves lives on this page) but not
  // users:manage; gating the whole page on the latter locked them out of a feature built for them.
  { name: 'admin', label: 'Settings', ico: '⚙', perm: ['users:manage', 'assignments:manage'], programme: true, help: 'Staff accounts, security, connecting devices and backups — or, for a supervisor, moving a caseload and the audit log.' },
];
/**
 * A front-line worker (navigator, clinician): records work with clients and does not run the programme's
 * money, staff or settings. Presentation only — the short sidebar and a Home without the budget.
 */
export function frontline() {
  return can('interventions:write') && !can('budget:approve') && !can('assignments:manage') && !can('users:manage') && !can('settings:manage');
}
/** Where a NAV entry goes in this person's sidebar: 'main', 'more' (folded away), or null (not shown). */
export function navPlacement(n) {
  if (!n.name || (n.perm && !canAny(n.perm))) return null;
  if (!frontline()) return 'main';
  if (n.more) return 'more';
  return n.programme ? null : 'main';
}
/** Is a module of the programme profile switched on (server/programme.js)? Unknown means on. */
export function moduleOn(key) { const m = state.programme && state.programme.modules; return !m || m[key] !== false; }

let current = null;
let renderSeq = 0;
// A view that rewrites its own address in place (the sign-in page's Log in / Sign up, #/login?mode=…) is
// still the render that finished: replaceHash() records the rewrite so render() can tell it from a redirect.
let replacedDuringRender = null;
const APP_ALIASES = new Set(['getapp', 'get-app', 'app', 'phone', 'tablet', 'install']);
/** Change the address without a new history entry or a re-render (a view switching its own panel). */
export function replaceHash(to) {
  const from = location.hash;
  try { history.replaceState(history.state, '', to); } catch { return; }
  syncHere();
  if (activity.rendered === from) activity.rendered = location.hash; else replacedDuringRender = { from, to: location.hash };
  activity.at = Date.now();
}
export async function render() {
  const hash = location.hash;
  busy(1);
  try { await renderPage(); }
  finally {
    // A render that redirected (nav() to another address) is not the one that finished this address.
    if (location.hash === hash) activity.rendered = hash;
    else if (replacedDuringRender && replacedDuringRender.from === hash && replacedDuringRender.to === location.hash) activity.rendered = location.hash;
    replacedDuringRender = null;
    busy(-1);
  }
}
async function renderPage() {
  const app = document.getElementById('app');
  app.removeAttribute('aria-busy'); // was set on the static pre-hydration shell in index.html
  // A paused window stays paused: a hash change or a view's own refresh must not draw the app back over it.
  if (paused) return;
  showBuildStamp(!state.user);
  if (updateArmed && !updateBlocked({ navigating: true })) { reloadForUpdate(); return; }
  clear(document.getElementById('modal-root'));
  const r = parseHash();
  // A whole-screen view (sign-in, set-up, MFA) is built first and swapped in whole. Clearing #app and then
  // awaiting the view left the screen blank for as long as the view's request took, and a second render
  // (signing out re-renders, then the hash change renders again) blanked a sign-in page that was already
  // showing. Only the latest render swaps in, so an older, slower one never lands on top of a newer one
  // (two overlapping sign-in renders used to append two sign-in forms).
  const seq = ++renderSeq;
  // The same whole-screen view already showing (the hash went from #/ to #/login, or signing out rendered
  // twice) is kept, not replaced: replacing it threw away whatever the person had started typing into it.
  const screen = [r.name === 'mfa' || r.name === 'setup' ? r.name : 'login', new URLSearchParams(location.hash.split('?')[1] || '').get('mode') || '', !!state.localSetupNeeded, !!state.setupNeeded, !!state.user].join('|');
  const show = async (pending) => {
    const view = await pending;
    if (seq !== renderSeq) return;
    if (app.firstElementChild && app.firstElementChild.dataset.screen === screen) return;
    if (view && view.dataset) view.dataset.screen = screen;
    clear(app).append(view);
    // The sign-in page names itself as it switches between Log in and Sign up (views/login.js).
    if (r.name === 'mfa' || r.name === 'setup') document.title = `${TITLES[r.name]} — SUDS`;
  };
  // A device with no account yet opens the sign-in page on Sign up, which is its first-run set-up.
  if (state.localSetupNeeded) { if (r.name !== 'localsetup' && r.name !== 'login') { nav('login?mode=signup'); return; } return show(routes.login(r)); }
  if (state.setupNeeded) { if (r.name !== 'setup') { nav('setup'); return; } return show(routes.setup(r)); }
  if (!state.user) return show(routes.login(r));
  if (state.mfaPending && r.name !== 'mfa') { nav('mfa'); return; }
  if (r.name === 'mfa' || r.name === 'login') return show(routes[r.name === 'mfa' ? 'mfa' : 'dashboard'](r));
  if (state.user.must_change_password && r.name !== 'profile') { nav('profile?force=1'); return; }
  // Addresses people guess or bookmark for "SUDS on my phone" and for the list of devices were "Page not
  // found". The phone/tablet page is a page of its own (get-app.html; /app on the office server); the
  // devices are This device on a device copy, and Settings › Synced devices on the office server.
  // location.replace, so Back does not land on the alias and bounce forward again.
  if (APP_ALIASES.has(r.name)) { location.replace(state.local || window.SUDS_STATIC_HOST ? 'get-app.html' : '/app'); return; }
  if (r.name === 'devices') { location.replace('#/' + (state.local ? 'sync' : can('users:manage') ? 'admin?tab=devices' : 'dashboard')); return; }
  const navItem = NAV.find(n => n.name === r.name);
  // An address that goes nowhere (a mistyped link, a page that no longer exists) says so, instead of
  // quietly showing Home under the wrong address.
  const loader = navItem?.perm && !canAny(navItem.perm) ? (async () => emptyState('Not available for your role', `Your account does not have access to ${navItem.label}. Ask your supervisor or administrator if you need it.`, h('button', { class: 'btn', onClick: () => nav('dashboard') }, 'Back to home'), { level: 1 }))
    : routes[r.name] || (async () => h('div', { 'data-not-found': '1' }, emptyState('Page not found', `There is no page at "#/${r.name}". The link may be out of date.`, h('a', { class: 'btn primary', href: '#/dashboard' }, 'Go to Home'), { level: 1 })));
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' }, h('div', { class: 'boot' }, 'Loading…'));
  const side = sidebar(r);
  const qa = quickActions();
  const layout = h('div', { class: 'layout' }, mobileBar(r, side), side, h('div', { class: 'content' }, h('div', { class: 'appbar' }, can('clients:read') ? globalSearch() : h('div', { class: 'grow' }), dueBell(), qa), main), qa ? h('div', { class: 'fab' }, qa.cloneNode(true)) : null);
  if (qa) layout.querySelector('.fab button')?.addEventListener('click', () => qa.click());
  const focusWas = focusKey(document.activeElement, app);
  clear(app).append(layout);
  // A hash change keeps the old scroll position, so leaving a long list for another page landed the
  // reader part-way down it, with the new page's header and alerts scrolled off the top.
  if (!current || current.name !== r.name || current.id !== r.id) window.scrollTo(0, 0);
  if (r.name === 'dashboard') { busy(1); setTimeout(() => { try { if (parseHash().name === 'dashboard') maybeTour(); } finally { busy(-1); } }, 400); }
  const lost = () => !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
  try { const view = await loader(r); clear(main).append(view); if (state.local && r.name === 'sync') main.append(deviceErrorsCard()); }
  catch (e) { clear(main).append(h('h1', {}, 'This page could not be shown'), h('div', { class: 'banner danger', role: 'alert' }, e.message)); }
  if (seq !== renderSeq) return;
  setPageTitle(r, navItem);
  // Moving to another page left focus on nothing (the link that was pressed is gone with the old page), so
  // a keyboard or screen-reader user started again from the top of the document. Put it on the new page's
  // heading instead — only for a real move, and only when focus was not already placed by the view.
  if (current && (current.name !== r.name || current.id !== r.id || current.sub !== r.sub) && lost()) {
    const h1 = main.querySelector('h1') || main;
    if (h1 !== main && !h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
    try { h1.focus({ preventScroll: true }); } catch {}
  } else if (focusWas && lost()) {
    // The same page drawn again (a filter changed, a record saved, Home's refresh): focus goes back to the
    // control it was on, not to the top of the document (WCAG 2.4.3, 3.2.2). Labels are tied by the
    // accessibility pass first, which runs as a microtask.
    await Promise.resolve();
    restoreFocus(app, focusWas);
  }
  current = r;
}
// Enough about a focused control to find "the same one" in a freshly drawn page.
function focusKey(el, root) {
  if (!el || el === document.body || !root.contains(el) || !el.tagName) return null;
  const lbl = (el.labels && el.labels[0] ? el.labels[0].textContent : '') || '';
  return { tag: el.tagName.toLowerCase(), name: el.getAttribute('name') || '', aria: el.getAttribute('aria-label') || '', lbl: lbl.trim(),
    text: /^(A|BUTTON)$/.test(el.tagName) ? (el.textContent || '').trim().slice(0, 80) : '', href: el.getAttribute('href') || '', role: el.getAttribute('role') || '' };
}
function restoreFocus(root, k) {
  const same = [...root.querySelectorAll(k.tag)].filter(el => (el.getAttribute('name') || '') === k.name && (el.getAttribute('aria-label') || '') === k.aria
    && (el.getAttribute('href') || '') === k.href && (el.getAttribute('role') || '') === k.role
    && (!k.lbl || ((el.labels && el.labels[0] ? el.labels[0].textContent : '') || '').trim() === k.lbl)
    && (!k.text || (el.textContent || '').trim().slice(0, 80) === k.text));
  const el = same[0];
  if (el && typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch {} }
}
// Every address has its own title (WCAG 2.4.2): the page, the section within it, and the programme — never a
// client's name, which would sit in the browser's history and tab list.
const TITLES = { client: 'Client record', caloms: 'State reporting', resource: 'Resource profile', profile: 'My profile', sync: 'This device', mfa: 'Two-step verification', setup: 'Set up SUDS' };
export function setPageTitle(r = parseHash(), navItem = NAV.find(n => n.name === r.name)) {
  let page = TITLES[r.name] || navItem?.label;
  if (!page) page = document.querySelector('.main h1')?.textContent.trim() || (document.querySelector('[data-not-found]') ? 'Page not found' : 'SUDS');
  const section = document.querySelector('.main nav.tabs [aria-current=page]')?.textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
  const parts = [section && section !== page ? `${section} · ${page}` : page, 'SUDS'];
  document.title = parts.join(' — ');
}
function sidebar(r) {
  // Sections with nothing to show (a finance account and "Connect clients") are left out, headings and all.
  const groups = []; let cur = null; const more = [];
  const link = (n) => h('a', { href: '#/' + n.name, class: r.name === n.name ? 'active' : '', 'aria-current': r.name === n.name ? 'page' : null }, h('span', { class: 'ico', 'aria-hidden': 'true' }, n.ico), n.label);
  for (const n of NAV) {
    if (n.sec) { cur = { sec: n.sec, items: [] }; groups.push(cur); continue; }
    const where = navPlacement(n);
    if (where === 'main') cur.items.push(link(n)); else if (where === 'more') more.push({ n, a: link(n) });
  }
  // A front-line worker's less-used pages, folded into one closed group (open while one of them is showing).
  const moreGroup = more.length ? h('details', { class: 'nav-more', 'data-nav-more': '1', open: more.some(x => x.n.name === r.name) ? true : null },
    h('summary', {}, 'More'), ...more.map(x => x.a)) : null;
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'SUDS'), h('small', {}, state.org))),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, groups.filter(g => g.items.length).flatMap(g => [h('div', { class: 'sec' }, g.sec), ...g.items]), moreGroup),
    h('div', { class: 'foot' }, state.local ? h('a', { href: '#/sync', class: 'badge info', style: { display: 'block', textAlign: 'center', marginBottom: '.5rem' } }, window.SUDS_STATIC_HOST ? '📱 On this device · Backup' : '📱 On this device · Sync') : null, h('div', {}, h('b', {}, state.user.display_name)), h('div', { class: 'muted' }, fmt.label(state.user.role)),
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, h('a', { href: '#/profile' }, 'Profile'), h('a', { href: '#', onClick: (e) => { e.preventDefault(); logout(); } }, 'Sign out'), h('a', { href: '#', title: 'Light / dark', onClick: (e) => { e.preventDefault(); toggleTheme(); } }, 'Light/dark'), h('a', { href: 'accessibility.html', 'data-accessibility-statement': '1' }, 'Accessibility')),
      h('div', { class: 'small muted', 'data-build-stamp': '1', style: { marginTop: '.4rem' } }, `SUDS ${SUDS_VERSION}`)));
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
  // The build stamp sits under the page title on a phone: the sidebar foot is below the fold with the menu open.
  return h('div', { class: 'mobilebar' }, menuBtn, h('div', { class: 'mobilebar-title' }, h('b', {}, item.label), h('span', { class: 'mobilebar-stamp', 'data-build-stamp': '1' }, `SUDS ${SUDS_VERSION}`)), h('a', { href: '#/clients', class: 'btn ghost', 'aria-label': 'Clients' }, '👤'));
}
function toggleTheme() { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const next = cur === 'dark' ? 'light' : 'dark'; prefs.set('theme', next); applyTheme(); }
try { const cached = JSON.parse(localStorage.getItem('suds.prefs') || '{}'); if (cached.theme) document.documentElement.dataset.theme = cached.theme; } catch {}

export async function logout() { await prefs.flush(); try { await post('/api/auth/logout', {}); } catch {} state.user = null; state.mfaPending = false; document.querySelectorAll('#banners [data-banner="mfa-required"]').forEach(b => b.remove());
  // nav() to a new address renders through the hash change; rendering here as well drew the sign-in page twice.
  const from = location.hash; nav('login'); if (location.hash === from) render(); }

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
    // WCAG 2.2.1: warned a minute ahead, with one obvious way to stay — a button (any key or tap works too).
    // Announced as an alert; focus is left where it is so nothing being typed is interrupted.
    if (idleMs > limit - 60000 && !w) {
      w = h('div', { id: 'idle-warn', class: 'idle-warn', role: 'alert' },
        h('span', {}, 'You will be signed out in 1 minute due to inactivity. Tap the screen, move the mouse or press a key to stay signed in. '),
        h('button', { class: 'btn sm', type: 'button', 'data-stay-signed-in': '1', onClick: () => { lastActivity = Date.now(); w.remove(); get('/api/auth/me').catch(() => {}); announce('You are still signed in.'); } }, 'Stay signed in'));
      document.body.append(w);
    }
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
    state.user = me.user; state.org = me.org_name; state.mfaPending = me.mfaPending; state.idleMinutes = me.idle_minutes || 15; state.programme = me.programme || null;
    // The fund a new visit is pre-filled with (the worker's own default, else the programme's).
    state.defaultFundId = me.default_fund_id || null;
    await Promise.all([loadRefData(), prefs.load()]);
    // Two-step verification is required of this role but not set up yet. There is a grace period, after which
    // the server refuses every request until it is done -- so say when that is, and where to do it, instead of
    // a vague "please enroll" that reads as advisory right up until the day everything stops working.
    if (state.user.mfa_required && !state.user.mfa_enabled && !state.mfaPending && !state.local) {
      const due = state.user.mfa_setup_deadline ? fmt.parse(state.user.mfa_setup_deadline) : null;
      const when = due ? (due.getTime() < Date.now() ? 'now' : `by ${fmt.date(state.user.mfa_setup_deadline)}`) : 'now';
      // One line on every screen (a paragraph took a third of a phone's screen above every page): the
      // deadline stays visible, the consequence is said to a screen reader in the same line and announced
      // once, and "Set up" goes straight to enrolment.
      const full = `Your role requires two-step verification. Set it up ${when} — after that, SUDS will not let you in until it is done.`;
      const el = banner(`Two-step verification required ${when}.`, 'warn', { id: 'mfa-required', compact: true, announceText: full });
      if (el) {
        el.firstChild.append(h('span', { class: 'sr-only' }, ' After that, SUDS will not let you in until it is done.'));
        el.insertBefore(h('a', { href: '#/profile?mfa=1', class: 'btn sm primary', 'data-mfa-setup': '1' }, 'Set up'), el.lastChild);
      }
    }
  } catch { state.user = null; }
}
export async function loadRefData() {
  // Not fatal: an account that must change its password first is refused nearly everything, and the one
  // page it may use has to render regardless.
  if (!state.constants) { try { state.constants = await get('/api/meta/constants', { quiet: true }); } catch { state.constants = state.constants || {}; } }
  try { state.users = (await get('/api/users', { quiet: true })).users; } catch { state.users = []; }
  // Every funding source, inactive ones too (allFunds), so a record charged to one that has since been
  // deactivated still shows it; state.funds is what new records are offered.
  if (can('budget:read')) { try { state.allFunds = (await get('/api/budget/funds?all=1', { quiet: true })).funds; state.funds = state.allFunds.filter(x => x.is_active); } catch { state.funds = []; state.allFunds = []; } }
}

// ---------- boot (called from main.js after all views are registered) ----------
window.__suds = { downloadCsv: (...a) => downloadCsv(...a) };
// Stamped by scripts/build-local.js from package.json. The two kernel assets are requested with it as a
// version query so the browser may keep them for good (server/http.js serves `?v=` as immutable) while a
// new release, with a new version, is a new URL. public/sw.js caches the same URLs for offline starts.
const SUDS_VERSION = '1.12.1';

// ---------- build stamp ----------
// Which build is this? A tester reporting "still broken" after a release needs to be able to say, and so
// does whoever reads their report. Shown on the sign-in and start-up screens (fixed, small) and at the foot
// of the sidebar once signed in.
let stampEl = null;
function showBuildStamp(visible) {
  if (!stampEl) {
    stampEl = h('div', { class: 'small muted', 'data-build-stamp': '1', 'aria-label': `SUDS version ${SUDS_VERSION}`, style: { position: 'fixed', left: '.5rem', bottom: '.35rem', fontSize: '11px', opacity: '.7', pointerEvents: 'none', zIndex: '1' } }, `SUDS ${SUDS_VERSION}`);
    document.body.append(stampEl);
  }
  stampEl.hidden = !visible;
}

// ---------- error beacon ----------
// A script error on someone's phone was invisible to everyone but them. Uncaught errors, unhandled
// rejections and 5xx answers are reported without PHI: the message cut to 300 characters with long digit
// runs masked, the stack reduced to its top five file:line frames, the route without its query, the build
// and the browser family. Office mode sends them to the server's application log
// (server/routes/client-errors.js); a device keeps the last 50 here, listed on its Sync page.
const DEVICE_ERRORS_KEY = 'suds.errors';
let errorWindow = { start: 0, n: 0 };
const maskDigits = (s) => String(s == null ? '' : s).replace(/\d{5,}/g, (m) => '#'.repeat(Math.min(m.length, 8)));
function browserFamily() {
  const ua = navigator.userAgent || '';
  const m = /(Edg|OPR|SamsungBrowser|CriOS|FxiOS|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  const name = m ? `${({ Edg: 'Edge', OPR: 'Opera', CriOS: 'Chrome', FxiOS: 'Firefox', Version: 'Safari' })[m[1]] || m[1]} ${m[2]}` : 'unknown';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  return `${name} / ${os}`;
}
function stackFrames(stack) {
  const out = [];
  for (const line of String(stack || '').split('\n')) {
    const m = /([\w.-]+\.m?js)(?:\?[^:)\s]*)?:(\d+)(?::\d+)?/.exec(line);
    if (m) out.push(`${m[1]}:${m[2]}`);
    if (out.length >= 5) break;
  }
  return out;
}
export function reportClientError({ kind = 'error', message = '', stack = '', status } = {}) {
  try {
    const now = Date.now();
    if (now - errorWindow.start > 60_000) errorWindow = { start: now, n: 0 };
    if (++errorWindow.n > 10) return; // a loop throwing on every frame is one report, not thousands
    const entry = { kind, message: maskDigits(message).slice(0, 300), stack: stackFrames(stack), route: maskDigits(location.hash.split('?')[0]).slice(0, 80), version: SUDS_VERSION, browser: browserFamily(), ...(status ? { status } : {}) };
    if (state.local || isLocalMode()) {
      let list = []; try { list = JSON.parse(localStorage.getItem(DEVICE_ERRORS_KEY) || '[]'); if (!Array.isArray(list)) list = []; } catch {}
      list.push({ ...entry, at: new Date().toISOString() });
      try { localStorage.setItem(DEVICE_ERRORS_KEY, JSON.stringify(list.slice(-50))); } catch {}
      return;
    }
    if (!state.user) return; // the office only takes reports from a signed-in session
    fetch('/api/client-errors', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', 'X-Background': '1' }, body: JSON.stringify(entry) }).catch(() => {});
  } catch { /* reporting an error must never cause one */ }
}
window.addEventListener('error', (e) => { if (e && e.message && !/ResizeObserver loop/.test(e.message)) reportClientError({ kind: 'error', message: e.message, stack: e.error && e.error.stack }); });
// A request that failed and was not caught carries the server's own words, which can name what was being
// saved: only its status is reported.
window.addEventListener('unhandledrejection', (e) => { const r = e && e.reason; const fromApi = r && (r.status || r.offline); reportClientError({ kind: 'rejection', message: fromApi ? `request failed (${r.offline ? 'offline' : r.status})` : (r && r.message ? r.message : String(r)), stack: r && r.stack }); });
/** The Sync page's "Errors on this device" card: what went wrong here, readable out loud to whoever supports it. */
function deviceErrorsCard() {
  let list = []; try { list = JSON.parse(localStorage.getItem(DEVICE_ERRORS_KEY) || '[]'); if (!Array.isArray(list)) list = []; } catch {}
  const card = h('div', { class: 'card mt', 'data-device-errors': String(list.length) }, h('h2', {}, 'Errors on this device'));
  if (!list.length) { card.append(h('p', { class: 'small muted' }, `None recorded. (SUDS ${SUDS_VERSION})`)); return card; }
  card.append(
    h('p', { class: 'small muted' }, 'The most recent problems SUDS ran into on this device, newest first. They hold no client information; if someone supporting SUDS asks, read them out.'),
    h('ol', { class: 'small' }, list.slice().reverse().map(e => h('li', {}, `${fmt.dt(e.at)} — ${e.message}${e.stack && e.stack.length ? ` (${e.stack.join(', ')})` : ''}${e.route ? ` · ${e.route}` : ''} · SUDS ${e.version} · ${e.browser}`))),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { try { localStorage.removeItem(DEVICE_ERRORS_KEY); } catch {} card.replaceWith(deviceErrorsCard()); } }, 'Clear this list')));
  return card;
}

// ---------- a new version is ready ----------
// A release reaches an open page two ways: a new service worker takes control (controllerchange), or
// version.json — fetched past every cache on start and whenever the page comes back into view — names a
// different version (workers installed by 1.9.0 still fill their shell from the HTTP cache, so a page can
// start on old files for a while after a deploy). Either way the page is never reloaded under someone:
// with a dialog open, a form half-filled or a write (a sync) in flight it says so and waits for them;
// otherwise it reloads the next time the page is hidden or the person moves to another page.
let localWritesInFlight = 0;
let updateArmed = false;
document.addEventListener('input', (e) => { const f = e.target && e.target.closest && e.target.closest('form'); if (f) f.dataset.dirty = '1'; }, true);
function updateBlocked({ navigating = false } = {}) {
  if (localWritesInFlight > 0) return true;
  if (navigating) return false; // leaving the page discards its dialogs and forms anyway (drafts are kept)
  return !!(document.querySelector('.modal-bg') || document.querySelector('form[data-dirty]'));
}
function updateBanner() {
  const el = banner('A new version of SUDS is ready.', 'info', { id: 'update-ready' });
  if (el) el.firstChild.append(' ', h('button', { class: 'btn sm primary', type: 'button', 'data-update-reload': '1', onClick: () => location.reload() }, 'Reload'));
}
// One automatic reload per release: if the page comes back still on the old files (a 1.9.0 worker serving
// its HTTP-cached copy for a few minutes), it says so with the banner instead of reloading on every move.
const UPDATE_TRIED = 'suds-update-tried';
let updateTarget = '';
function reloadForUpdate() { try { sessionStorage.setItem(UPDATE_TRIED, updateTarget); } catch {} location.reload(); }
function newVersionReady(target) {
  updateBanner();
  if (updateArmed || paused) return;
  try { if (sessionStorage.getItem(UPDATE_TRIED) === target) return; } catch {}
  updateArmed = true; updateTarget = target;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && updateArmed && !paused && !updateBlocked()) reloadForUpdate(); });
}
async function checkVersion() {
  if (navigator.onLine === false) return; // nothing to learn, and a failed fetch is noise in the console
  try {
    const r = await fetch(new URL('version.json', location.href), { cache: 'no-store' });
    if (!r.ok) return;
    const v = (await r.json()).version;
    if (v && v !== SUDS_VERSION) newVersionReady(`version:${v}`);
  } catch { /* offline, or a server without the file: nothing to say */ }
}

// ---------- local mode: the kernel, and the window that owns it ----------
// "Use SUDS here instead" reloads the page with this set, so taking the database back always starts from a
// fresh document: nothing from the copy this page held before it was paused can survive to be saved.
const TAKEOVER_FLAG = 'suds-local-takeover';
async function startLocalKernel(force) {
  const k = await import(`./local/kernel.js?v=${SUDS_VERSION}`);
  await k.start({
    wasmUrl: new URL(`./local/sql-wasm.wasm?v=${SUDS_VERSION}`, location.href).href,
    force,
    onLockLost: showPausedScreen,
    // A device that has stopped being able to save is not a console message; the person using it needs
    // to know before they type anything else in.
    onSaveError: (err) => {
      const full = String(err && err.name) === 'QuotaExceededError';
      reportClientError({ kind: 'error', message: `save failed: ${err && err.name}` });
      banner(full
        ? (window.SUDS_STATIC_HOST ? 'This device is out of storage space, so nothing is being saved. Download a backup now (This device), then free up space on the device.' : 'This device is out of storage space, so nothing is being saved. Sync with the office, then remove sample data or attachments to free space.')
        : (window.SUDS_STATIC_HOST ? 'This device has stopped saving your work. Download a backup from This device as soon as you can.' : 'This device has stopped saving your work. Sync with the office as soon as you can.'), 'error');
    },
  });
}
// Another window on this device took the database over (local/shims/sqlite.js). This page has stopped: it
// says why — truthfully about whether its last changes were written out first — and offers to take it
// back. Dialogs are closed first (what was typed in a form that keeps drafts is kept as one, in this
// window), and `paused` keeps any later render — a hash change, the dashboard's refresh — from drawing
// the app back over this screen.
let paused = false;
function showPausedScreen(info) {
  if (paused) return; paused = true;
  const savedFirst = !!(info && info.savedFirst);
  document.querySelectorAll('form').forEach(f => { try { f.saveDraft && f.saveDraft(); } catch {} });
  clear(document.getElementById('modal-root'));
  document.body.classList.remove('nav-open');
  const app = document.getElementById('app');
  clear(app);
  app.append(
    h('div', { class: 'boot error', 'data-paused': savedFirst ? 'saved' : 'unsaved' }, 'SUDS is now open in another window on this device, so this one has been paused. ',
      savedFirst ? 'Your work here was saved first.' : 'Changes made here in the last moment before that may need to be re-entered.'),
    h('div', { class: 'btn-row center mt' },
      h('button', { class: 'btn primary', type: 'button', onClick: () => { try { sessionStorage.setItem(TAKEOVER_FLAG, '1'); } catch {} location.reload(); } }, 'Use SUDS here instead'),
    ),
  );
}
export async function boot(force = false) {
  state.local = isLocalMode();
  skipLink();
  showBuildStamp(true);
  if (state.local) {
    document.getElementById('app').innerHTML = '<div class="boot">Starting SUDS on this device…</div>';
    try { if (sessionStorage.getItem(TAKEOVER_FLAG)) { sessionStorage.removeItem(TAKEOVER_FLAG); force = true; } } catch {}
    try {
      await startLocalKernel(force);
    } catch (e) {
      // Two specific failures need their own explanation rather than a raw message.
      const alreadyOpen = e && e.code === 'SUDS_ALREADY_OPEN';
      const msg = alreadyOpen
        ? 'SUDS is open in another tab or window on this device.'
        : e && e.code === 'SUDS_KEY_LOST'
          ? e.message
          : 'Could not start SUDS on this device: ' + (e && e.message);
      if (!alreadyOpen) { console.error(e); reportClientError({ kind: 'error', message: msg, stack: e && e.stack }); }
      const app = document.getElementById('app');
      app.removeAttribute('aria-busy');
      clear(app);
      // This is the one screen a locked-out or broken device can reach without a kernel — reset has to work
      // here directly. SUDS_ALREADY_OPEN gets its own recovery instead: that device and its data are fine,
      // just open elsewhere, so wiping it would be the wrong tool. Every other window lands here, including
      // one that has gone quiet (a phone freezes background tabs; they wake up) and a duplicated tab; only
      // a reload of the holding tab itself gets in without asking. The person decides: use SUDS here,
      // which asks the other window to write out and step aside, or go back to it.
      app.append(
        h('div', { class: 'boot error' }, msg),
        alreadyOpen ? h('div', {},
          h('p', { class: 'muted center' }, e.stale
            ? 'The other window has not responded for a while (a phone pauses tabs in the background). You can use SUDS here instead — the other window will be stopped so nothing is written twice.'
            : 'You can use it here instead — the other window will be paused so nothing is written twice.'),
          h('div', { class: 'btn-row center mt' },
            h('button', { class: 'btn primary', type: 'button', onClick: () => boot(true) }, 'Use SUDS in this window'),
            h('button', { class: 'btn', type: 'button', onClick: () => boot() }, 'Try again'),
          ),
        ) : offerDeviceReset(),
      );
      return;
    }
    // Anything written and not yet saved is saved on the way out: pagehide for a close or navigation,
    // visibilitychange for a phone switching apps (where pagehide may never come), freeze for a background
    // tab the browser is about to suspend. An urgent flush issues the IndexedDB write synchronously and
    // commits it without waiting for any callback, so the browser finishes it even as the page goes; the
    // next document of this tab waits for this one's lock before reading (local/shims/sqlite.js).
    const flushNow = () => { try { window.SUDS_LOCAL && window.SUDS_LOCAL.flush({ urgent: true }).catch(() => {}); } catch {} };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
    document.addEventListener('freeze', flushNow);
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
  // mode (or the on-device app installed to a home screen) starts with no connection at all (H4).
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      // A newer worker taking control means a release was published while this page was open (or this is
      // the first load after one). The page is not reloaded on the spot — that dropped whatever was being
      // typed — but offered, and reloaded only at a moment nothing can be lost (newVersionReady). Only when
      // a worker was in control before: the very first registration is not an update.
      const hadController = !!navigator.serviceWorker.controller;
      // A new worker is only news if it brings a different release than the one this page is running: the
      // first open after a deploy already runs the new files, and offering to reload into them again was noise.
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) checkVersion(); });
      navigator.serviceWorker.register('sw.js').then(r => r && r.update && r.update()).catch(() => {});
    } catch {}
  }
  checkVersion();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
  await loadSession();
  startIdleWatch();
  window.addEventListener('hashchange', render);
  render();
}

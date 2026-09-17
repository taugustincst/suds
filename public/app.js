// SUDS frontend core: API client, hash router, DOM + form helpers, session/idle handling.
export const state = { user: null, org: 'SUDS', constants: null, users: [], funds: [], idleMinutes: 15, prefs: {}, local: false };
// Local mode: the whole server runs inside this page (phone app / offline). Requests go to the in-page kernel.
export function isLocalMode() { try { return new URLSearchParams(location.search).get('local') === '1' || location.protocol === 'file:' || location.protocol === 'suds:' || location.hostname === 'appassets.androidplatform.net' || !!window.SUDS_LOCAL; } catch { return false; } }

// ---------- workspace preferences (follow the user across devices) ----------
let prefsTimer; const prefsDirty = {};
export const prefs = {
  get: (k, d) => (state.prefs[k] === undefined ? d : state.prefs[k]),
  set(k, v) { state.prefs[k] = v; prefsDirty[k] = v; try { localStorage.setItem('suds.prefs', JSON.stringify(state.prefs)); } catch {} clearTimeout(prefsTimer); prefsTimer = setTimeout(prefs.flush, 800); },
  async flush() { const body = { ...prefsDirty }; for (const k of Object.keys(prefsDirty)) delete prefsDirty[k]; if (!Object.keys(body).length || !state.user) return; try { await put('/api/me/prefs', body, { quiet: true }); } catch {} },
  async load() { try { state.prefs = (await get('/api/me/prefs', { quiet: true })).prefs || {}; try { localStorage.setItem('suds.prefs', JSON.stringify(state.prefs)); } catch {} } catch { try { state.prefs = JSON.parse(localStorage.getItem('suds.prefs') || '{}'); } catch { state.prefs = {}; } } applyTheme(); },
};
function applyTheme() { const t = state.prefs.theme; if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }

// ---------- images ----------
// Pictures are served as ordinary image URLs rather than base64 inside JSON, which keeps list responses
// small. In local mode there is no HTTP server behind those URLs, so the bytes come from the in-page
// kernel and become an object URL instead.
const objectUrls = new Map();
export function img(path, attrs = {}) {
  const el = h('img', { ...attrs, src: state.local ? TRANSPARENT_PIXEL : path });
  if (state.local && path) {
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
  if (!state.local) { el.src = path; return; }
  if (objectUrls.has(path)) { el.src = objectUrls.get(path); return; }
  el.src = TRANSPARENT_PIXEL;
  window.SUDS_LOCAL.handle('GET', path, undefined, {}).then((r) => {
    if (!r || r.status >= 400 || !r.body) return;
    const url = URL.createObjectURL(new Blob([r.body], { type: r.headers['content-type'] || 'image/png' }));
    objectUrls.set(path, url); el.src = url;
  }).catch(() => {});
}

// ---------- API ----------
export async function api(method, path, body, opts = {}) {
  const headers = { 'X-Requested-With': 'suds', ...(opts.headers || {}) };
  if (state.local && window.SUDS_LOCAL) {
    let payload = body; if (body instanceof Blob) payload = await body.arrayBuffer();
    const r = await window.SUDS_LOCAL.handle(method, path, payload, headers);
    touch();
    const data = r.json !== undefined ? r.json : (r.body ? (String(r.headers['content-type'] || '').includes('json') ? JSON.parse(r.body.toString()) : r.body.toString()) : null);
    if (r.status === 401 && state.user && !opts.quiet) { if (data && data.mfaRequired) location.hash = '#/mfa'; else { state.user = null; render(); } }
    if (r.status === 403 && data && data.passwordChangeRequired) location.hash = '#/profile?force=1';
    if (r.status >= 400) { const err = new Error((data && data.error) || `Request failed (${r.status})`); err.status = r.status; err.data = data; throw err; }
    return data;
  }
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer || typeof body === 'string') { payload = body; if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  touch();
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && state.user && !opts.quiet) { if (data && data.mfaRequired) { location.hash = '#/mfa'; } else { state.user = null; render(); toast('Session expired. Please sign in again.', 'error'); } }
  if (res.status === 403 && data && data.passwordChangeRequired) { location.hash = '#/profile?force=1'; }
  if (!res.ok) { const err = new Error((data && data.error) || `Request failed (${res.status})`); err.status = res.status; err.data = data; throw err; }
  return data;
}
export const get = (p, o) => api('GET', p, undefined, o), post = (p, b, o) => api('POST', p, b, o), put = (p, b, o) => api('PUT', p, b, o), del = (p, b, o) => api('DELETE', p, b, o);

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
  setTimeout(() => { liveRegion.textContent = String(message || ''); }, 50);
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
export function modal(title, content, { wide = false } = {}) {
  const root = document.getElementById('modal-root');
  const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 9);
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'card-head' }, h('h2', { id: titleId }, title), h('button', { class: 'btn ghost sm', onClick: close, 'aria-label': 'Close' }, '✕')), content);
  const bg = h('div', { class: 'modal-bg', onClick: (e) => { if (e.target === bg) close(); } }, box);
  // Remember where focus was, so closing the dialog returns the keyboard to what opened it.
  // activeElement can be null, and document.contains() throws on anything that is not a Node.
  const opener = document.activeElement instanceof Element ? document.activeElement : null;
  function close() {
    bg.remove();
    document.removeEventListener('keydown', onKey);
    if (opener && document.contains(opener) && typeof opener.focus === 'function') { try { opener.focus(); } catch { /* the element may have been replaced by a re-render */ } }
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
export function confirmDialog(title, message, { danger = false, okText = 'Confirm', requireReason = false } = {}) {
  return new Promise((resolve) => {
    let reason;
    const m = modal(title, h('div', {}, h('p', {}, message), requireReason ? h('div', { class: 'field' }, h('label', {}, 'Reason (recorded in audit log)'), reason = h('input', { required: true })) : null,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => { m.close(); resolve(null); } }, 'Cancel'), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => { if (requireReason && !reason.value.trim()) { reason.focus(); return; } m.close(); resolve(requireReason ? reason.value.trim() : true); } }, okText))));
  });
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
  label: (s) => s ? String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSbirt\b/, 'SBIRT').replace(/\bMat\b/g, 'MAT').replace(/\bOtp\b/, 'OTP').replace(/\bObot\b/, 'OBOT').replace(/\bEd\b/, 'ED').replace(/\bMh\b/, 'MH').replace(/\bRx\b/, 'Rx').replace(/\bIds\b/, 'IDs') : '—',
  ago: (s) => { const p = fmt.parse(s); if (!p) return 'never'; const d = (Date.now() - p.getTime()) / 86400000; if (d < 1) return 'today'; if (d < 2) return 'yesterday'; return `${Math.floor(d)}d ago`; },
  isoLocal: (d = new Date()) => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; },
  today: () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },
};
export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }
export const statusKind = (s) => ({ active: 'ok', admitted: 'ok', completed: 'ok', done: 'ok', signed: 'ok', approved: 'ok', reimbursed: 'ok', reached: 'ok',
  waitlist: 'warn', pending: 'warn', waitlisted: 'warn', scheduled: 'info', contacted: 'info', accepted: 'info', in_progress: 'info', open: 'info', draft: 'warn', amended: 'purple', staged: 'warn', committed: 'ok',
  inactive: '', closed: '', cancelled: '', discarded: '', rejected: 'danger', deceased: 'danger', no_show: 'danger', declined_by_client: 'danger', declined_by_provider: 'danger', critical: 'danger', high: 'warn', urgent: 'danger', crisis_escalated: 'danger' }[s] || '');
export const can = (perm) => { const u = state.user; if (!u) return false; const p = u.permissions || []; if (p.includes(perm)) return true; const [ns] = perm.split(':'); if (p.includes(`${ns}:*`)) return true; if (perm.endsWith(':read') && p.includes(perm.replace(/:read$/, ':write'))) return true; return false; };

// ---------- forms ----------
// fields: [{name,label,type:'text|number|date|datetime|select|textarea|checkbox|client|user|resource|fund', options, required, value, span, help, min, max, step}]
// Unsaved form contents, kept in memory only. Deliberately not localStorage: a half-typed intake form is
// PHI, and this app's whole design keeps PHI out of browser storage. Memory survives a closed dialog, a
// route change and an idle sign-out within the same tab, which is what was actually being lost.
const drafts = new Map();
export function discardDraft(key) { drafts.delete(key); }
export function hasDraft(key) { return drafts.has(key); }

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
      case 'select': input = h('select', { name: f.name, required: !!f.required }, f.noBlank ? null : h('option', { value: '' }, f.placeholder || '—'), opts.map(o => h('option', { value: o.value, selected: String(o.value) === String(v) }, o.label))); break;
      case 'textarea': input = h('textarea', { name: f.name, required: !!f.required, rows: f.rows || 4, placeholder: f.placeholder || '' }, v || ''); break;
      case 'checkbox': input = h('input', { type: 'checkbox', name: f.name, checked: !!(v === 1 || v === true || v === '1') }); break;
      case 'datetime': input = h('input', { type: 'datetime-local', name: f.name, required: !!f.required, value: v ? fmt.isoLocal(new Date(v)) : '' }); break;
      case 'date': input = h('input', { type: 'date', name: f.name, required: !!f.required, value: v ? String(v).slice(0, 10) : '' }); break;
      case 'number': input = h('input', { type: 'number', name: f.name, required: !!f.required, value: v ?? '', min: f.min, max: f.max, step: f.step ?? 'any', placeholder: f.placeholder || '' }); break;
      case 'client': input = clientPicker(f.name, v, f); break;
      case 'user': input = h('select', { name: f.name, required: !!f.required }, h('option', { value: '' }, f.placeholder || '—'), state.users.filter(u => u.is_active !== 0).map(u => h('option', { value: u.id, selected: u.id === v }, `${u.display_name} (${fmt.label(u.role)})`))); break;
      case 'fund': input = h('select', { name: f.name, required: !!f.required }, h('option', { value: '' }, '—'), state.funds.map(x => h('option', { value: x.id, selected: x.id === v }, x.name))); break;
      case 'password': input = h('input', { type: 'password', name: f.name, required: !!f.required, autocomplete: f.autocomplete || 'current-password' }); break;
      default: input = h('input', { type: f.type || 'text', name: f.name, required: !!f.required, value: v ?? '', placeholder: f.placeholder || '', maxlength: f.maxLen, pattern: f.pattern, autocomplete: f.autocomplete || 'off' });
    }
    inputs[f.name] = input;
    // Label, help text and any error are tied to the control by id, so a screen reader reads the field's
    // name, its guidance and what went wrong — rather than just "edit text".
    const fieldId = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
    const helpId = f.help ? `${fieldId}-help` : null;
    const errId = `${fieldId}-err`;
    if (input && input.tagName) {
      input.id = fieldId;
      input.setAttribute('aria-describedby', [helpId, errId].filter(Boolean).join(' '));
      if (f.required) input.setAttribute('aria-required', 'true');
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
  const el = h('form', { onSubmit: async (e) => {
    e.preventDefault();
    const data = read();
    errBox.classList.add('hidden');
    el.querySelectorAll('.field').forEach(x => { x.classList.remove('error'); x.querySelector('.err').textContent = ''; const c = x.querySelector('input,select,textarea'); if (c) c.removeAttribute('aria-invalid'); });
    submitBtn.disabled = true;
    try { await onSubmit(data, el); if (draftKey) drafts.delete(draftKey); }
    catch (err) {
      const fieldsErr = err.data && err.data.fields;
      let firstBad = null;
      if (fieldsErr) for (const [k, msg] of Object.entries(fieldsErr)) {
        const w = el.querySelector(`[data-field="${k}"]`);
        if (!w) continue;
        w.classList.add('error');
        w.querySelector('.err').textContent = msg;
        const control = w.querySelector('input,select,textarea');
        if (control) { control.setAttribute('aria-invalid', 'true'); if (!firstBad) firstBad = control; }
      }
      const text = err.message + (fieldsErr ? ': ' + Object.entries(fieldsErr).map(([k, m]) => `${k} ${m}`).join('; ') : '');
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
    let saveTimer;
    el.addEventListener('input', () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { const d = read(); if (Object.values(d).some(v => v !== '' && v !== null && v !== undefined && v !== 0)) drafts.set(draftKey, d); }, 400); });
    el.addEventListener('change', () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => drafts.set(draftKey, read()), 400); });
  }
  function read() {
    const data = {};
    for (const f of fields) {
      if (f.type === 'section') continue;
      const i = inputs[f.name];
      if (f.type === 'checkbox') data[f.name] = i.checked;
      else if (f.type === 'client') data[f.name] = i.value || null;
      else if (f.type === 'number') data[f.name] = i.value === '' ? null : Number(i.value);
      else if (f.type === 'datetime') data[f.name] = i.value ? new Date(i.value).toISOString() : null;
      else data[f.name] = i.value === '' ? null : i.value;
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
    type: 'text', placeholder: 'Search name, phone, date of birth or code…', autocomplete: 'off', required: !!f.required,
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list',
  });
  const list = h('div', { class: 'card tight hidden', id: listId, role: 'listbox', style: { position: 'absolute', zIndex: 20, maxHeight: '220px', overflow: 'auto', width: '100%' } });
  const wrap = h('div', { style: { position: 'relative' } }, text, hidden, list);
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
        list.append(h('div', { class: 'muted small' }, q ? 'No matches. Try a surname, phone number, date of birth or client code.' : 'Type to search'));
        announce('No matching clients');
      } else {
        r.clients.forEach((c, i) => {
          const el = h('div', {
            class: 'list-item', id: `${listId}-o${i}`, role: 'option', 'aria-selected': 'false', tabindex: '-1',
            style: { cursor: 'pointer' },
            onClick: () => choose(c),
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

export function table(columns, rows, { onRow, empty = 'No records', wrap = true, rowLabel } = {}) {
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
  return wrap ? h('div', { class: 'table-wrap' }, t) : t;
}
export function bars(items, { max, valueKey = 'n', labelKey = 'k', format = fmt.num, link = null } = {}) {
  const m = max || Math.max(1, ...items.map(i => Number(i[valueKey] || 0)));
  if (!items.length) return h('div', { class: 'muted small' }, 'No data');
  return h('div', {}, items.map(i => { const href = link ? link(i) : null; const row = [h('div', { class: 'lbl', title: fmt.label(i[labelKey]) }, fmt.label(i[labelKey])), h('div', { class: 'trk' }, h('div', { class: 'fil', style: { width: `${(Number(i[valueKey] || 0) / m) * 100}%` } })), h('div', { class: 'n' }, format(i[valueKey]))];
    return href ? h('a', { class: 'bar link', href: href.startsWith('#') ? href : '#/' + href, title: 'Show these' }, row) : h('div', { class: 'bar' }, row); }));
}
export function sparkline(values) { const m = Math.max(1, ...values); return h('div', { class: 'spark' }, values.map(v => h('div', { style: { height: `${(v / m) * 100}%` }, title: String(v) }))); }
export function stat(label, value, kind = '', href = null) {
  const body = [h('div', { class: 'v' }, value), h('div', { class: 'l' }, label)];
  return href ? h('a', { class: `card stat link ${kind}`, href: href.startsWith('#') ? href : '#/' + href, title: 'Open' }, body) : h('div', { class: `card stat ${kind}` }, body);
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
  const input = h('input', { type: 'search', placeholder: 'Find a client: last name, phone or code…', 'aria-label': 'Find a client' });
  const list = h('div', { class: 'card tight hidden search-results' });
  const wrap = h('div', { class: 'gsearch' }, input, list);
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { nav(`clients?status=all&q=${encodeURIComponent(input.value.trim())}`); list.classList.add('hidden'); } if (e.key === 'Escape') list.classList.add('hidden'); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) list.classList.add('hidden'); });
  async function run() {
    const q = input.value.trim(); if (!q) { list.classList.add('hidden'); return; }
    try { const r = await get(`/api/clients?limit=8&status=all&q=${encodeURIComponent(q)}`, { quiet: true }); clear(list);
      if (!r.clients.length) list.append(h('div', { class: 'muted small' }, 'No match. Search uses the exact last name, full phone number, date of birth or client code.'));
      for (const c of r.clients) list.append(h('a', { class: 'list-item', href: `#/client/${c.id}`, style: { display: 'block' }, onClick: () => list.classList.add('hidden') }, h('b', {}, c.display_name), ' ', h('span', { class: 'muted small' }, c.client_code, ' · ', fmt.label(c.status))));
      list.classList.remove('hidden'); } catch {}
  }
  return wrap;
}
// Welcome tour shown once per user (stored in synced preferences)
let tourOpen = false;
export function maybeTour() {
  if (prefs.get('tour_done') || tourOpen || document.querySelector('.modal-bg')) return;
  tourOpen = true;
  const steps = [
    ['Welcome to SUDS', `Hi ${state.user.display_name.split(' ')[0]}. SUDS keeps everything about the people you serve in one place, and it works the same on your phone and your computer. Anything you add on one shows up on the other right away.`],
    ['Start with Home', 'Home shows what needs attention today: reminders due, clients you have not contacted in a while, and drafts you started on another device.'],
    ['Record work with + Log', 'The blue + Log button (top of the page, or bottom-right on a phone) records a visit, call, note, reminder or time in a few taps. Visits and calls also fill in your time sheet.'],
    ['Find anyone fast', 'Use the search box at the top with a last name, phone number or client code. Open a client to see their story: visits, calls, notes, referrals and reminders on one timeline.'],
    ['Look for the ? marks', 'Every page has a ? that explains it in plain language. You cannot break anything: records are never truly deleted and every change is logged.'],
  ];
  let i = 0; const body = h('div', {}); const dots = h('div', { class: 'muted small center' });
  const draw = () => { clear(body).append(h('h2', {}, steps[i][0]), h('p', { style: { fontSize: '1.05rem' } }, steps[i][1])); dots.textContent = `${i + 1} of ${steps.length}`; };
  const finish = () => { prefs.set('tour_done', true); tourOpen = false; m.close(); };
  const m = modal('', h('div', {}, body, h('div', { class: 'btn-row', style: { justifyContent: 'space-between', alignItems: 'center' } }, h('button', { class: 'btn ghost', onClick: finish }, 'Skip'), dots, h('button', { class: 'btn primary', onClick: () => { if (i < steps.length - 1) { i++; draw(); } else finish(); } }, 'Next'))));
  m.el.querySelector('.card-head').remove(); draw();
}
export async function downloadCsv(path) {
  if (state.local && window.SUDS_LOCAL) { const r = await window.SUDS_LOCAL.handle('GET', path, undefined, {}); if (r.status >= 400) { toast('Download failed', 'error'); return; } const name = (/filename="([^"]+)"/.exec(r.headers['content-disposition'] || '') || [])[1] || 'download'; if (window.SudsNative && window.SudsNative.saveFile) { let bin = ''; const bytes = new Uint8Array(r.body); for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); window.SudsNative.saveFile(name, btoa(bin), r.headers['content-type'] || 'application/octet-stream'); return; }
    const blob = new Blob([r.body], { type: r.headers['content-type'] || 'application/octet-stream' }); const u = URL.createObjectURL(blob); const a = h('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); return; }
  const a = h('a', { href: path, download: '' }); document.body.append(a); a.click(); a.remove();
}

// ---------- routing ----------
const routes = {};
export function route(name, loader) { routes[name] = loader; }
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
  { name: 'supervision', label: 'Supervision', ico: '✍', perm: 'notes:cosign', help: 'Notes waiting for your countersignature, drafts your team has not finished, staff time to approve, and referrals with no outcome recorded.' },
  { sec: 'Record work' },
  { name: 'interventions', label: 'Visits & services', ico: '✚', perm: 'interventions:read', help: 'Every face-to-face or phone service you provide: outreach, screenings, warm handoffs, naloxone, transport and more.' },
  { name: 'calls', label: 'Calls', ico: '☎', perm: 'calls:read', help: 'Phone calls with clients, families and providers, including ones that went to voicemail.' },
  { name: 'forms', label: 'Forms', ico: '🧾', perm: 'forms:read', help: 'County forms (releases, intake sheets, assistance requests). Fill one out from a client record: it is pre-filled from the chart, printable, and holds the signed copy.' },
  { name: 'notes', label: 'Notes', ico: '✎', perm: 'notes:admin:read', help: 'Written documentation. Drafts save automatically and can be finished on any device; sign when complete.' },
  { name: 'time', label: 'My time', ico: '◷', perm: 'time:read', help: 'Your hours by activity. Visits and calls add time automatically; log meetings, travel and paperwork here.' },
  { name: 'imports', label: 'Import', ico: '⇩', perm: 'imports:write', help: 'Bring in spreadsheets (Excel / CSV) of clients, visits, calls, resources and more, or notes from Pocket AI and OneNote. Everything is checked before it is saved.' },
  { name: 'overdose', label: 'Overdose & reversals', ico: '⛑', perm: 'overdose:read', help: 'Overdoses and naloxone reversals, including ones involving people who are not clients. These are the counts funders ask for.' },
  { sec: 'Connect clients' },
  { name: 'referrals', label: 'Referrals', ico: '⇢', perm: 'referrals:read', help: 'Track each referral from "sent" to "admitted" so nothing falls through the cracks.' },
  { name: 'resources', label: 'Resource directory', ico: '☰', perm: 'resources:read', help: 'Treatment programs, MAT clinics, shelters, legal aid and other partners you refer to.' },
  { sec: 'Program' },
  { name: 'budget', label: 'Funding & spending', ico: '$', perm: 'budget:read', help: 'Grants and what has been spent, including client assistance such as bus passes and IDs.' },
  { name: 'reports', label: 'Reports', ico: '▤', perm: 'reports:read', help: 'Numbers for your funders and supervisors. Exports never include client names unless you ask.' },
  { name: 'funder', label: 'Funder report', ico: '▦', perm: 'reports:read', help: 'Unduplicated counts — people, not services — by fiscal period and funding source, with admissions, discharges, demographics and overdose figures in the shape a grant report asks for.' },
  { name: 'admin', label: 'Settings', ico: '⚙', perm: 'users:manage', help: 'Staff accounts, security, connecting phones, and backups.' },
];

let current = null;
export async function render() {
  const app = document.getElementById('app');
  clear(document.getElementById('modal-root'));
  const r = parseHash();
  if (state.localSetupNeeded) { if (r.name !== 'localsetup') { nav('localsetup'); return; } clear(app).append(await routes.localsetup(r)); return; }
  if (state.setupNeeded) { if (r.name !== 'setup') { nav('setup'); return; } clear(app).append(await routes.setup(r)); return; }
  if (!state.user) { clear(app).append(await routes.login(r)); return; }
  if (state.mfaPending && r.name !== 'mfa') { nav('mfa'); return; }
  if (r.name === 'mfa' || r.name === 'login') { clear(app).append(await routes[r.name === 'mfa' ? 'mfa' : 'dashboard'](r)); return; }
  if (state.user.must_change_password && r.name !== 'profile') { nav('profile?force=1'); return; }
  const navItem = NAV.find(n => n.name === r.name);
  const loader = navItem?.perm && !can(navItem.perm) ? (async () => emptyState('Not available for your role', `Your account does not have access to ${navItem.label}. Ask your supervisor or administrator if you need it.`, h('button', { class: 'btn', onClick: () => nav('dashboard') }, 'Back to home'))) : (routes[r.name] || routes.dashboard);
  const main = h('div', { class: 'main' }, h('div', { class: 'boot' }, 'Loading…'));
  const side = sidebar(r);
  const qa = quickActions();
  const layout = h('div', { class: 'layout' }, mobileBar(r, side), side, h('div', { class: 'content' }, h('div', { class: 'appbar' }, can('clients:read') ? globalSearch() : h('div', { class: 'grow' }), qa), main), qa ? h('div', { class: 'fab' }, qa.cloneNode(true)) : null);
  if (qa) layout.querySelector('.fab button')?.addEventListener('click', () => qa.click());
  clear(app).append(layout);
  if (r.name === 'dashboard') setTimeout(() => { if (parseHash().name === 'dashboard') maybeTour(); }, 400);
  try { const view = await loader(r); clear(main).append(view); }
  catch (e) { clear(main).append(h('div', { class: 'banner danger' }, e.message)); }
  current = r;
}
function sidebar(r) {
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'SUDS'), h('small', {}, state.org))),
    h('nav', { class: 'nav' }, NAV.map(n => n.sec ? h('div', { class: 'sec' }, n.sec) : (!n.perm || can(n.perm)) ? h('a', { href: '#/' + n.name, class: r.name === n.name ? 'active' : '' }, h('span', { class: 'ico' }, n.ico), n.label) : null)),
    h('div', { class: 'foot' }, state.local ? h('a', { href: '#/sync', class: 'badge info', style: { display: 'block', textAlign: 'center', marginBottom: '.5rem' } }, '📱 On this device · Sync') : null, h('div', {}, h('b', {}, state.user.display_name)), h('div', { class: 'muted' }, fmt.label(state.user.role)),
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, h('a', { href: '#/profile' }, 'Profile'), h('a', { href: '#', onClick: (e) => { e.preventDefault(); logout(); } }, 'Sign out'), h('a', { href: '#', title: 'Light / dark', onClick: (e) => { e.preventDefault(); toggleTheme(); } }, 'Light/dark'))));
}
function mobileBar(r, side) {
  const item = NAV.find(n => n.name === r.name) || (r.name === 'client' ? { label: 'Client' } : { label: 'SUDS' });
  const toggle = () => { side.classList.toggle('open'); document.body.classList.toggle('nav-open', side.classList.contains('open')); };
  side.addEventListener('click', (e) => { if (e.target.closest('a')) { side.classList.remove('open'); document.body.classList.remove('nav-open'); } });
  return h('div', { class: 'mobilebar' }, h('button', { class: 'btn ghost', 'aria-label': 'Menu', onClick: toggle }, '☰'), h('b', {}, item.label), h('a', { href: '#/clients', class: 'btn ghost', 'aria-label': 'Clients' }, '👤'));
}
function toggleTheme() { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const next = cur === 'dark' ? 'light' : 'dark'; prefs.set('theme', next); applyTheme(); }
try { const cached = JSON.parse(localStorage.getItem('suds.prefs') || '{}'); if (cached.theme) document.documentElement.dataset.theme = cached.theme; } catch {}

export async function logout() { await prefs.flush(); try { await post('/api/auth/logout', {}); } catch {} state.user = null; state.mfaPending = false; nav('login'); render(); }

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
    if (idleMs > limit - 60000 && !w) { w = h('div', { id: 'idle-warn', class: 'idle-warn' }, 'You will be signed out in 1 minute due to inactivity. Move the mouse or press a key to stay signed in.'); document.body.append(w); }
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
  } catch { state.user = null; }
}
export async function loadRefData() {
  if (!state.constants) state.constants = await get('/api/meta/constants');
  try { state.users = (await get('/api/users', { quiet: true })).users; } catch { state.users = []; }
  if (can('budget:read')) { try { state.funds = (await get('/api/budget/funds', { quiet: true })).funds; } catch { state.funds = []; } }
}

// ---------- boot (called from main.js after all views are registered) ----------
window.__suds = { downloadCsv: (...a) => downloadCsv(...a) };
export async function boot() {
  state.local = isLocalMode();
  if (state.local) {
    document.getElementById('app').innerHTML = '<div class="boot">Starting SUDS on this device…</div>';
    try {
      const k = await import('./local/kernel.js');
      await k.start({
        wasmUrl: new URL('./local/sql-wasm.wasm', location.href).href,
        // A device that has stopped being able to save is not a console message; the person using it needs
        // to know before they type anything else in.
        onSaveError: (err) => {
          const full = String(err && err.name) === 'QuotaExceededError';
          banner(full
            ? 'This device is out of storage space, so nothing is being saved. Sync with the office, then remove sample data or attachments to free space.'
            : 'This device has stopped saving your work. Sync with the office as soon as you can.', 'error');
        },
      });
    } catch (e) {
      // Two specific failures need their own explanation rather than a raw message.
      const msg = e && e.code === 'SUDS_ALREADY_OPEN'
        ? 'SUDS is already open in another window on this device. Switch to that window, or close it and reload this page.'
        : e && e.code === 'SUDS_KEY_LOST'
          ? e.message
          : 'Could not start SUDS on this device: ' + (e && e.message);
      document.getElementById('app').innerHTML = '<div class="boot error">' + msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</div>';
      console.error(e);
      return;
    }
    window.addEventListener('pagehide', () => { window.SUDS_LOCAL && window.SUDS_LOCAL.flush(); });
  } else if ('serviceWorker' in navigator && location.protocol !== 'file:') { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch {} }
  await loadSession();
  startIdleWatch();
  window.addEventListener('hashchange', render);
  render();
}

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
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}
export function modal(title, content, { wide = false } = {}) {
  const root = document.getElementById('modal-root');
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'card-head' }, h('h2', {}, title), h('button', { class: 'btn ghost sm', onClick: close, 'aria-label': 'Close' }, '✕')), content);
  const bg = h('div', { class: 'modal-bg', onClick: (e) => { if (e.target === bg) close(); } }, box);
  function close() { bg.remove(); document.removeEventListener('keydown', esc); }
  function esc(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', esc);
  root.append(bg);
  const first = box.querySelector('input,select,textarea,button.primary'); if (first) first.focus();
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
  date: (s) => s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—',
  dt: (s) => s ? new Date(s).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—',
  time: (s) => s ? new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '',
  money: (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' }),
  num: (n) => Number(n || 0).toLocaleString(),
  mins: (m) => { m = Number(m || 0); const hh = Math.floor(m / 60), mm = m % 60; return hh ? `${hh}h ${mm}m` : `${mm}m`; },
  label: (s) => s ? String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSbirt\b/, 'SBIRT').replace(/\bMat\b/g, 'MAT').replace(/\bOtp\b/, 'OTP').replace(/\bObot\b/, 'OBOT').replace(/\bEd\b/, 'ED').replace(/\bMh\b/, 'MH').replace(/\bRx\b/, 'Rx').replace(/\bIds\b/, 'IDs') : '—',
  ago: (s) => { if (!s) return 'never'; const d = (Date.now() - Date.parse(s)) / 86400000; if (d < 1) return 'today'; if (d < 2) return 'yesterday'; return `${Math.floor(d)}d ago`; },
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
export function form(fields, { values = {}, submitText = 'Save', onSubmit, onCancel, cancelText = 'Cancel', extra } = {}) {
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
    const wrap = h('div', { class: `field ${f.span ? 'span' : ''}`, 'data-field': f.name },
      f.type === 'checkbox' ? h('label', { class: 'check' }, input, f.label) : [h('label', {}, f.label, f.required ? ' *' : ''), input],
      f.help ? h('div', { class: 'help' }, f.help) : null, h('div', { class: 'err' }));
    target.append(wrap);
  }
  const errBox = h('div', { class: 'banner danger hidden' });
  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, submitText);
  const el = h('form', { onSubmit: async (e) => {
    e.preventDefault();
    const data = read();
    errBox.classList.add('hidden'); el.querySelectorAll('.field').forEach(x => { x.classList.remove('error'); x.querySelector('.err').textContent = ''; });
    submitBtn.disabled = true;
    try { await onSubmit(data, el); }
    catch (err) {
      const fieldsErr = err.data && err.data.fields;
      if (fieldsErr) for (const [k, msg] of Object.entries(fieldsErr)) { const w = el.querySelector(`[data-field="${k}"]`); if (w) { w.classList.add('error'); w.querySelector('.err').textContent = msg; } }
      errBox.textContent = err.message + (fieldsErr ? ': ' + Object.entries(fieldsErr).map(([k, m]) => `${k} ${m}`).join('; ') : ''); errBox.classList.remove('hidden');
    } finally { submitBtn.disabled = false; }
  } }, errBox, grid, extra || null, h('div', { class: 'btn-row' }, onCancel ? h('button', { class: 'btn', type: 'button', onClick: onCancel }, cancelText) : null, submitBtn));
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
  const hidden = h('input', { type: 'hidden', name });
  const text = h('input', { type: 'text', placeholder: 'Search last name, phone, DOB or code…', autocomplete: 'off', required: !!f.required });
  const list = h('div', { class: 'card tight hidden', style: { position: 'absolute', zIndex: 20, maxHeight: '220px', overflow: 'auto', width: '100%' } });
  const wrap = h('div', { style: { position: 'relative' } }, text, hidden, list);
  wrap.value = value || '';
  Object.defineProperty(wrap, 'value', { get: () => hidden.value, set: (v) => { hidden.value = v || ''; } });
  hidden.value = value || '';
  if (value && f.display) text.value = f.display;
  else if (value) get(`/api/clients/${value}`, { quiet: true }).then(r => { text.value = `${r.client.display_name} (${r.client.client_code})`; }).catch(() => {});
  let timer;
  text.addEventListener('input', () => { hidden.value = ''; clearTimeout(timer); timer = setTimeout(search, 250); });
  text.addEventListener('focus', () => { if (!hidden.value) search(); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) list.classList.add('hidden'); });
  async function search() {
    const q = text.value.trim();
    try {
      const r = await get(`/api/clients?limit=15&status=all${q ? '&q=' + encodeURIComponent(q) : ''}`);
      clear(list);
      if (!r.clients.length) list.append(h('div', { class: 'muted small' }, q ? 'No matches (exact last name, phone, DOB or code)' : 'Type to search'));
      for (const c of r.clients) list.append(h('div', { class: 'list-item', style: { cursor: 'pointer' }, onClick: () => { hidden.value = c.id; text.value = `${c.display_name} (${c.client_code})`; list.classList.add('hidden'); wrap.dispatchEvent(new Event('change')); } }, c.display_name, ' ', h('span', { class: 'muted small' }, c.client_code, ' · ', fmt.label(c.status))));
      list.classList.remove('hidden');
    } catch {}
  }
  return wrap;
}

export function table(columns, rows, { onRow, empty = 'No records', wrap = true } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  const t = h('table', {}, h('thead', {}, h('tr', {}, columns.map(c => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', {}, rows.map(r => h('tr', { class: onRow ? 'click' : '', onClick: onRow ? () => onRow(r) : null }, columns.map(c => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : (r[c.key] ?? '—')))))));
  return wrap ? h('div', { class: 'table-wrap' }, t) : t;
}
export function bars(items, { max, valueKey = 'n', labelKey = 'k', format = fmt.num } = {}) {
  const m = max || Math.max(1, ...items.map(i => Number(i[valueKey] || 0)));
  if (!items.length) return h('div', { class: 'muted small' }, 'No data');
  return h('div', {}, items.map(i => h('div', { class: 'bar' }, h('div', { class: 'lbl', title: fmt.label(i[labelKey]) }, fmt.label(i[labelKey])), h('div', { class: 'trk' }, h('div', { class: 'fil', style: { width: `${(Number(i[valueKey] || 0) / m) * 100}%` } })), h('div', { class: 'n' }, format(i[valueKey])))));
}
export function sparkline(values) { const m = Math.max(1, ...values); return h('div', { class: 'spark' }, values.map(v => h('div', { style: { height: `${(v / m) * 100}%` }, title: String(v) }))); }
export function stat(label, value, kind = '') { return h('div', { class: `card stat ${kind}` }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label)); }
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
  { name: 'tasks', label: 'To-do list', ico: '☑', perm: 'tasks:read', help: 'Follow-ups and reminders. Check a box when it is done.' },
  { sec: 'Record work' },
  { name: 'interventions', label: 'Visits & services', ico: '✚', perm: 'interventions:read', help: 'Every face-to-face or phone service you provide: outreach, screenings, warm handoffs, naloxone, transport and more.' },
  { name: 'calls', label: 'Calls', ico: '☎', perm: 'calls:read', help: 'Phone calls with clients, families and providers, including ones that went to voicemail.' },
  { name: 'notes', label: 'Notes', ico: '✎', perm: 'notes:admin:read', help: 'Written documentation. Drafts save automatically and can be finished on any device; sign when complete.' },
  { name: 'time', label: 'My time', ico: '◷', perm: 'time:read', help: 'Your hours by activity. Visits and calls add time automatically; log meetings, travel and paperwork here.' },
  { name: 'imports', label: 'Import', ico: '⇩', perm: 'imports:write', help: 'Bring in spreadsheets (Excel / CSV) of clients, visits, calls, resources and more, or notes from Pocket AI and OneNote. Everything is checked before it is saved.' },
  { sec: 'Connect clients' },
  { name: 'referrals', label: 'Referrals', ico: '⇢', perm: 'referrals:read', help: 'Track each referral from "sent" to "admitted" so nothing falls through the cracks.' },
  { name: 'resources', label: 'Resource directory', ico: '☰', perm: 'resources:read', help: 'Treatment programs, MAT clinics, shelters, legal aid and other partners you refer to.' },
  { sec: 'Program' },
  { name: 'budget', label: 'Funding & spending', ico: '$', perm: 'budget:read', help: 'Grants and what has been spent, including client assistance such as bus passes and IDs.' },
  { name: 'reports', label: 'Reports', ico: '▤', perm: 'reports:read', help: 'Numbers for your funders and supervisors. Exports never include client names unless you ask.' },
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
  const loader = routes[r.name] || routes.dashboard;
  const main = h('div', { class: 'main' }, h('div', { class: 'boot' }, 'Loading…'));
  const side = sidebar(r);
  const qa = quickActions();
  const layout = h('div', { class: 'layout' }, mobileBar(r, side), side, h('div', { class: 'content' }, h('div', { class: 'appbar' }, can('clients:read') ? globalSearch() : h('div', { class: 'grow' }), qa), main), qa ? h('div', { class: 'fab' }, qa.cloneNode(true)) : null);
  if (qa) layout.querySelector('.fab button')?.addEventListener('click', () => qa.click());
  clear(app).append(layout);
  if (r.name === 'dashboard') setTimeout(maybeTour, 400);
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
    if (idleMs > limit) { if (w) w.remove(); logout(); toast('Signed out due to inactivity', 'error'); }
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
    try { const k = await import('./local/kernel.js'); await k.start({ wasmUrl: new URL('./local/sql-wasm.wasm', location.href).href }); }
    catch (e) { document.getElementById('app').innerHTML = '<div class="boot">Could not start local SUDS: ' + (e && e.message) + '</div>'; console.error(e); return; }
    window.addEventListener('pagehide', () => { window.SUDS_LOCAL && window.SUDS_LOCAL.flush(); });
  } else if ('serviceWorker' in navigator && location.protocol !== 'file:') { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch {} }
  await loadSession();
  startIdleWatch();
  window.addEventListener('hashchange', render);
  render();
}

// SUDS frontend core: API client, hash router, DOM + form helpers, session/idle handling.
export const state = { user: null, org: 'SUDS', constants: null, users: [], funds: [], idleMinutes: 15 };

// ---------- API ----------
export async function api(method, path, body, opts = {}) {
  const headers = { 'X-Requested-With': 'suds', ...(opts.headers || {}) };
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
  for (const f of fields) {
    if (f.type === 'section') { grid.append(h('div', { class: 'span' }, h('h4', {}, f.label))); continue; }
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
    grid.append(wrap);
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
export function pageHead(title, ...actions) { return h('div', { class: 'topbar' }, h('h1', {}, title), h('div', { class: 'row' }, actions)); }
export function downloadCsv(path) { const a = h('a', { href: path, download: '' }); document.body.append(a); a.click(); a.remove(); }

// ---------- routing ----------
const routes = {};
export function route(name, loader) { routes[name] = loader; }
export function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'dashboard', id: parts[1], sub: parts[2], query: new URLSearchParams(qs || '') };
}
export function nav(to) { location.hash = to.startsWith('#') ? to : '#/' + to; }

const NAV = [
  { sec: 'Work' },
  { name: 'dashboard', label: 'Dashboard', ico: '◫' },
  { name: 'clients', label: 'Clients', ico: '👤', perm: 'clients:read' },
  { name: 'tasks', label: 'Tasks & Follow-ups', ico: '☑', perm: 'tasks:read' },
  { name: 'interventions', label: 'Interventions', ico: '✚', perm: 'interventions:read' },
  { name: 'calls', label: 'Call Log', ico: '☎', perm: 'calls:read' },
  { name: 'time', label: 'Time Tracking', ico: '◷', perm: 'time:read' },
  { sec: 'Coordination' },
  { name: 'referrals', label: 'Referrals', ico: '⇢', perm: 'referrals:read' },
  { name: 'resources', label: 'Resource Directory', ico: '☰', perm: 'resources:read' },
  { name: 'notes', label: 'Notes', ico: '✎', perm: 'notes:admin:read' },
  { name: 'imports', label: 'Import Notes', ico: '⇩', perm: 'imports:write' },
  { sec: 'Program' },
  { name: 'budget', label: 'Budget', ico: '$', perm: 'budget:read' },
  { name: 'reports', label: 'Reports', ico: '▤', perm: 'reports:read' },
  { name: 'admin', label: 'Administration', ico: '⚙', perm: 'users:manage' },
];

let current = null;
export async function render() {
  const app = document.getElementById('app');
  clear(document.getElementById('modal-root'));
  const r = parseHash();
  if (!state.user) { clear(app).append(await routes.login(r)); return; }
  if (state.mfaPending && r.name !== 'mfa') { nav('mfa'); return; }
  if (r.name === 'mfa' || r.name === 'login') { clear(app).append(await routes[r.name === 'mfa' ? 'mfa' : 'dashboard'](r)); return; }
  if (state.user.must_change_password && r.name !== 'profile') { nav('profile?force=1'); return; }
  const loader = routes[r.name] || routes.dashboard;
  const main = h('div', { class: 'main' }, h('div', { class: 'boot' }, 'Loading…'));
  const layout = h('div', { class: 'layout' }, sidebar(r), main);
  clear(app).append(layout);
  try { const view = await loader(r); clear(main).append(view); }
  catch (e) { clear(main).append(h('div', { class: 'banner danger' }, e.message)); }
  current = r;
}
function sidebar(r) {
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'SUDS'), h('small', {}, state.org))),
    h('nav', { class: 'nav' }, NAV.map(n => n.sec ? h('div', { class: 'sec' }, n.sec) : (!n.perm || can(n.perm)) ? h('a', { href: '#/' + n.name, class: r.name === n.name ? 'active' : '' }, h('span', { class: 'ico' }, n.ico), n.label) : null)),
    h('div', { class: 'foot' }, h('div', {}, h('b', {}, state.user.display_name)), h('div', { class: 'muted' }, fmt.label(state.user.role)),
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, h('a', { href: '#/profile' }, 'Profile'), h('a', { href: '#', onClick: (e) => { e.preventDefault(); logout(); } }, 'Sign out'), h('a', { href: '#', title: 'Toggle theme', onClick: (e) => { e.preventDefault(); toggleTheme(); } }, '☾'))));
}
function toggleTheme() { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('suds.theme', next); } catch {} }
try { const t = localStorage.getItem('suds.theme'); if (t) document.documentElement.dataset.theme = t; } catch {}

export async function logout() { try { await post('/api/auth/logout', {}); } catch {} state.user = null; state.mfaPending = false; nav('login'); render(); }

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
  try {
    const me = await get('/api/auth/me', { quiet: true });
    state.user = me.user; state.org = me.org_name; state.mfaPending = me.mfaPending; state.idleMinutes = me.idle_minutes || 15;
    await loadRefData();
  } catch { state.user = null; }
}
export async function loadRefData() {
  if (!state.constants) state.constants = await get('/api/meta/constants');
  try { state.users = (await get('/api/users', { quiet: true })).users; } catch { state.users = []; }
  if (can('budget:read')) { try { state.funds = (await get('/api/budget/funds', { quiet: true })).funds; } catch { state.funds = []; } }
}

// ---------- boot (called from main.js after all views are registered) ----------
export async function boot() {
  await loadSession();
  startIdleWatch();
  window.addEventListener('hashchange', render);
  render();
}

// Settings › Server configuration (1.27.0; server/server-config.js, server/routes/server-config.js): what an office
// server took only from its environment until then (the AI provider and its key, single sign-on, OneNote, metrics,
// limits, retention), set here instead. Each setting is a row saying where its value comes from:
//   * Set in the server's environment: shown, not changeable here (the environment wins); a secret only as "set";
//   * Set here: changeable, removable (back to the default);
//   * Default / Not set.
// A secret is write-only: the box is always empty, and saving it replaces what was there. Changing a secret, or a
// setting that decides where data or sign-in goes, asks for the administrator's password or code again
// (signatureDialog, fresh). Every row has data-setting="<NAME>" so a link (settings-nav.js) can bring it into view.
import { h, get, put, del, badge, toast, fmt } from '../app.js';
import { settingHref } from './settings-nav.js';

const SOURCE = {
  environment: () => badge('Set in the server\'s environment', ''),
  here: () => badge('Set here', 'ok'),
  default: (e) => badge(e.type === 'secret' ? 'Not set' : 'Default', e.type === 'secret' ? 'warn' : ''),
};
const shown = (e, v) => (v === null || v === undefined ? '' : e.type === 'bool' ? (v ? 'On' : 'Off') : e.type === 'enum' ? ((e.options || []).find(o => o.value === v) || { label: v }).label : String(v));

/** The control for an entry's new value, and how to read it. */
function control(e, id) {
  if (e.type === 'secret') {
    const el = e.name === 'SUDS_AI_VERTEX_CREDENTIALS'
      ? h('textarea', { id, rows: 4, autocomplete: 'off', spellcheck: 'false', placeholder: e.set ? 'Paste a new key file to replace the one kept here' : '{ "type": "service_account", … }' })
      : h('input', { id, type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: e.set ? 'Enter a new value to replace it' : (e.placeholder || '') });
    return { el, read: () => el.value };
  }
  if (e.type === 'enum' || e.type === 'bool') {
    const opts = e.type === 'bool' ? [{ value: '1', label: 'On' }, { value: '0', label: 'Off' }] : e.options;
    const cur = e.value ?? e.default;
    const now = e.type === 'bool' ? (cur ? '1' : '0') : cur;
    const el = h('select', { id }, ...opts.map(o => h('option', { value: o.value, selected: o.value === now }, o.label)));
    return { el, read: () => (e.type === 'bool' ? el.value === '1' : el.value) };
  }
  const el = h('input', { id, type: e.type === 'number' ? 'number' : e.type === 'url' ? 'url' : 'text', value: e.value ?? '', placeholder: e.placeholder || (e.default !== null && e.type !== 'number' ? String(e.default) : ''),
    ...(e.type === 'number' ? { min: e.min, max: e.max, step: 1, inputmode: 'numeric' } : {}) });
  if (e.type === 'number' && (e.value === null || e.value === undefined) && e.default !== null) el.placeholder = `${e.default} (default)`;
  return { el, read: () => (e.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value) };
}

/** Save (or remove) one entry, asking for the password or code first when it is sensitive. */
async function send(e, method, value) {
  const url = `/api/admin/server-config/${encodeURIComponent(e.name)}`;
  const go = (extra = {}) => (method === 'PUT' ? put(url, { value, ...extra }) : del(url, extra));
  if (!e.sensitive) return go();
  const { signatureDialog } = await import('./notes.js');
  const verb = method === 'PUT' ? `change ${e.label.toLowerCase()}` : `remove ${e.label.toLowerCase()}`;
  // The dialog returns as soon as it is open: this settles when it is done (the answer) or cancelled (null).
  return new Promise((resolve) => {
    let out = null;
    signatureDialog({ title: method === 'PUT' ? `Change ${e.label}` : `Remove ${e.label}`, submitText: method === 'PUT' ? 'Save' : 'Remove', verb, fresh: true,
      returnTo: settingHref('server', e.name),
      intro: h('p', {}, 'This setting is a credential, or decides where client text, sign-in or audit evidence goes, so your password or code is asked for again.'),
      send: async (body) => { out = await go(body); }, done: () => resolve(out), onCancel: () => resolve(null) });
  });
}

/** One setting's row. `changed` redraws whatever holds it. */
export function entryRow(e, changed) {
  const id = `sc-${e.name}`;
  const status = h('div', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const row = h('div', { class: 'setting-row', id: `setting-${e.name}`, 'data-setting': e.name, 'data-source': e.source });
  const PROVIDER = { anthropic: 'Anthropic', bedrock: 'Amazon Bedrock', vertex: 'Vertex AI' };
  const head = h('div', { class: 'setting-head' }, h('label', { for: id }, e.label), SOURCE[e.source](e), e.provider ? h('span', { class: 'small muted' }, `for ${PROVIDER[e.provider] || e.provider}`) : null);
  row.append(head);
  if (e.help) row.append(h('p', { class: 'small muted' }, e.help));
  if (e.source === 'environment') {
    row.append(h('p', { class: 'small' }, e.type === 'secret' || e.value === null ? 'A value is set ' : `${shown(e, e.value)} — set `, 'where the server is configured (', h('code', {}, e.name),
      '). It wins over anything set here: change it there, or remove it there to set it here.'));
    // The label still names something focusable for a link to land on.
    row.querySelector('label').removeAttribute('for');
    return row;
  }
  if (e.source === 'here') row.append(h('p', { class: 'small muted' }, e.type === 'secret' ? 'A value is kept here, encrypted. It is never shown again.' : `Now: ${shown(e, e.value)}.`,
    e.updated_at ? ` Set ${fmt.dt(e.updated_at)}${e.updated_by ? ` by ${e.updated_by}` : ''}.` : ''));
  else if (e.type !== 'secret' && e.default !== null) row.append(h('p', { class: 'small muted' }, `Now: ${shown(e, e.default)} (the default).`));
  const c = control(e, id);
  const save = h('button', { type: 'button', class: 'btn primary sm', 'data-setting-save': e.name, onClick: async () => {
    const value = c.read();
    if (value === null || value === '') { status.textContent = e.source === 'here' ? 'Nothing entered. To go back to the default, choose Remove.' : 'Enter a value first.'; c.el.focus(); return; }
    save.disabled = true; status.textContent = 'Saving…';
    try {
      const r = await send(e, 'PUT', value);
      if (!r) { status.textContent = ''; return; }
      toast(`${e.label} saved${r.restart ? '. It takes effect when SUDS restarts' : ''}`, 'ok');
      changed();
    } catch (err) { status.textContent = err.message; } finally { save.disabled = false; }
  } }, e.type === 'secret' && e.set ? 'Replace' : 'Save');
  const remove = e.source === 'here' ? h('button', { type: 'button', class: 'btn sm', 'data-setting-remove': e.name, onClick: async () => {
    remove.disabled = true;
    try { const r = await send(e, 'DELETE'); if (r) { toast(`${e.label} removed${e.type === 'secret' ? '' : ': the default applies'}`, 'ok'); changed(); } }
    catch (err) { status.textContent = err.message; } finally { remove.disabled = false; }
  } }, 'Remove') : null;
  row.append(h('div', { class: 'setting-control' }, c.el, h('div', { class: 'btn-row' }, save, remove)), status);
  if (e.restart) row.append(h('p', { class: 'small muted' }, 'Takes effect when SUDS restarts.'));
  return row;
}

/** The provider the AI settings are for now. */
export const currentProvider = (entries) => { const p = entries.find(e => e.name === 'SUDS_AI_PROVIDER'); return (p && (p.value ?? p.default)) || 'anthropic'; };

/** One group as a card. `onlyProvider`: of the AI settings, only the chosen provider's (the AI copilot tab); otherwise
 * every provider's, each marked with the provider it is for (Server configuration). */
export function groupCard(g, entries, changed, { headingLevel = 'h2', onlyProvider = false } = {}) {
  let list = entries.filter(e => e.group === g.id);
  if (g.id === 'ai' && onlyProvider) { const provider = currentProvider(entries); list = list.filter(e => !e.provider || e.provider === provider); }
  return h('section', { class: 'card', 'data-setting': `group-${g.id}`, 'aria-labelledby': `scg-${g.id}` },
    h(headingLevel, { id: `scg-${g.id}` }, g.label), g.help ? h('p', { class: 'small muted' }, g.help) : null,
    ...list.map(e => entryRow(e, changed)));
}

/** The whole tab. */
export async function serverConfigTab(refresh) {
  const c = await get('/api/admin/server-config');
  const box = h('div', { 'data-server-config': '1' });
  box.append(h('p', { class: 'muted' }, 'Settings this server used to take only from its environment. Set them here; a value set in the server\'s environment still wins, and shows as such.'),
    h('nav', { class: 'card on-this-page', 'aria-label': 'Server configuration sections' }, h('h2', {}, 'On this page'),
      h('ul', {}, ...c.groups.map(g => h('li', {}, h('a', { href: settingHref('server', `group-${g.id}`) }, g.label))),
        h('li', {}, h('a', { href: settingHref('server', 'env-only') }, 'Kept in the server\'s environment')))),
    ...c.groups.map(g => groupCard(g, c.entries, refresh)),
    h('section', { class: 'card', 'data-setting': 'env-only', 'aria-labelledby': 'sc-env-only' }, h('h2', { id: 'sc-env-only' }, 'Kept in the server\'s environment'),
      h('p', { class: 'small muted' }, 'These cannot be changed in the browser, and why. They are set where the server is installed (keys.json, server.json or its environment).'),
      h('dl', { class: 'kv' }, ...c.env_only.flatMap(x => [h('dt', {}, x.label), h('dd', {}, h('div', {}, x.reason), h('div', { class: 'small muted' }, x.names.map(n => `${n.name}${n.set ? ' (set)' : ''}`).join(' · ')))]))));
  return box;
}

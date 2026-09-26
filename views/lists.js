// Settings → Lists: the choices on documentation forms, and funding sources, in one place an administrator
// can change without a new release. Each documentation list can have its choices reworded, reordered,
// retired (hidden from new records; old records keep showing them), added to, or put back as SUDS ships it.
// The stored codes never change (server/options.js), so old records and reports keep their meaning.
import { h, get, post, put, state, form, modal, toast, badge, fmt, can, confirmDialog, canEditLists, reloadRefData, loadRefData } from '../app.js';

// A new funding source needs a period and an amount (the budget pages count against them); quick add fills
// in the current July–June fiscal year and $0, which can be corrected on Funding & spending.
function fiscalYear() {
  const d = new Date(); const y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  return { start: `${y}-07-01`, end: `${y + 1}-06-30` };
}

function listCard(l, { editable, open }) {
  const box = h('details', { class: 'card list-card', open: !!open, 'data-list': l.key });
  const paint = () => {
    const shown = l.entries.filter(e => !e.hidden).length;
    const move = async (i, dir) => {
      const codes = l.entries.map(e => e.code); const j = i + dir; if (j < 0 || j >= codes.length) return;
      [codes[i], codes[j]] = [codes[j], codes[i]];
      const r = await put(`/api/admin/lists/${l.key}/order`, { codes }); l.entries = r.entries; changed(); paint();
    };
    const rename = async (e, input) => {
      const label = input.value.trim(); if (label === e.label) return;
      const r = await put(`/api/admin/lists/${l.key}/entries/${encodeURIComponent(e.code)}`, { label: label || null });
      l.entries = r.entries; toast(label ? `Renamed to "${label}"` : 'Built-in wording restored', 'ok'); changed(); paint();
    };
    const toggle = async (e) => {
      const r = await put(`/api/admin/lists/${l.key}/entries/${encodeURIComponent(e.code)}`, { hidden: !e.hidden });
      l.entries = r.entries; toast(e.hidden ? `"${e.label}" is offered again` : `"${e.label}" is hidden from new records`, 'ok'); changed(); paint();
    };
    const addI = h('input', { name: 'new_label', placeholder: 'Wording for a new choice', maxlength: 80, 'aria-label': `New choice for ${l.name}` });
    const add = async () => {
      const label = addI.value.trim(); if (!label) { addI.focus(); return; }
      const r = await post(`/api/admin/lists/${l.key}/entries`, { label }); l.entries = r.entries; toast(`Added "${label}"`, 'ok'); changed(); paint();
    };
    const reset = async () => {
      if (!await confirmDialog('Restore defaults', `Put "${l.name}" back as SUDS ships it: the built-in wording and order, with every built-in choice offered. Choices you added are hidden (records that use them keep them) and can be shown again.`, { okText: 'Restore defaults' })) return;
      const r = await post(`/api/admin/lists/${l.key}/reset`, {}); l.entries = r.entries; toast('Defaults restored', 'ok'); changed(); paint();
    };
    const rows = l.entries.map((e, i) => {
      const input = h('input', { value: e.label, maxlength: 80, disabled: !editable, 'aria-label': `Wording for ${e.label}`, 'data-entry-label': e.code,
        onKeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); rename(e, input); } } });
      return h('tr', { 'data-entry': e.code, class: e.hidden ? 'muted' : '' },
        editable ? h('td', { class: 'nowrap' },
          h('button', { class: 'btn sm ghost', type: 'button', disabled: i === 0, 'aria-label': `Move ${e.label} up`, 'data-move-up': e.code, onClick: () => move(i, -1) }, '↑'),
          h('button', { class: 'btn sm ghost', type: 'button', disabled: i === l.entries.length - 1, 'aria-label': `Move ${e.label} down`, 'data-move-down': e.code, onClick: () => move(i, 1) }, '↓')) : null,
        h('td', {}, input, h('div', { class: 'small muted' }, h('code', {}, e.code), e.default_label && e.label !== e.default_label ? ` · built-in wording: ${e.default_label}` : '')),
        h('td', {}, e.hidden ? badge('Hidden', 'warn') : badge('Offered', 'ok'), e.custom ? [' ', badge('Added by you', 'purple')] : null,
          e.protected ? h('div', { class: 'small muted', 'data-used-by': e.code }, `Used by SUDS: ${e.protected}`) : null),
        editable ? h('td', { class: 'nowrap' },
          h('button', { class: 'btn sm', type: 'button', 'data-rename': e.code, onClick: () => rename(e, input) }, 'Save'),
          e.protected ? null : h('button', { class: 'btn sm ghost', type: 'button', 'data-toggle': e.code, onClick: () => toggle(e) }, e.hidden ? 'Show' : 'Hide')) : null);
    });
    box.replaceChildren(...[
      h('summary', {}, h('b', {}, l.name), h('span', { class: 'muted small' }, ` — ${shown} of ${l.entries.length} offered`)),
      l.note ? h('p', { class: 'small muted' }, l.note) : null,
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, editable ? h('th', { scope: 'col' }, 'Order') : null, h('th', { scope: 'col' }, 'Wording'), h('th', { scope: 'col' }, 'Status'), editable ? h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')) : null)), h('tbody', {}, rows))),
      editable ? h('div', { class: 'row mt' },
        l.custom_allowed ? [addI, h('button', { class: 'btn sm primary', type: 'button', 'data-add-entry': l.key, onClick: add }, 'Add choice')] : null,
        h('button', { class: 'btn sm ghost', type: 'button', 'data-reset-list': l.key, onClick: reset }, 'Restore defaults')) : null].filter(Boolean)); // replaceChildren would print a null as "null"
  };
  paint();
  return box;
}

// The forms read the lists once per sign-in; after a change they are fetched again so this browser's
// forms show it at once (everyone else's pick it up the next time they sign in or reload).
let pendingReload = null;
function changed() { clearTimeout(pendingReload); pendingReload = setTimeout(() => { reloadRefData().catch(() => {}); }, 300); }

async function fundsCard(open) {
  const { funds } = await get('/api/budget/funds?all=1');
  const box = h('details', { class: 'card list-card', open: !!open, 'data-list': 'funds' });
  const refresh = async () => { const r = await get('/api/budget/funds?all=1'); funds.splice(0, funds.length, ...r.funds); state.funds = null; changed(); paint(); };
  // Every change on this page reloads the reference lists (changed()), which empties state.constants for a
  // moment: wait for them rather than opening a dialog with no funding types (or throwing).
  const quickAdd = async () => {
    if (!state.constants) await loadRefData();
    const fy = fiscalYear();
    const f = form([
      { name: 'name', label: 'Name', required: true, span: true, placeholder: 'e.g. Opioid Settlement FY26' },
      { name: 'source_type', label: 'Source type', type: 'select', options: state.constants?.FUNDING_TYPES || [], required: true },
      { name: 'fiscal_year_start', label: 'Period start', type: 'date', required: true, value: fy.start }, { name: 'fiscal_year_end', label: 'Period end', type: 'date', required: true, value: fy.end },
      { name: 'total_amount', label: 'Total award ($)', type: 'number', min: 0, step: 0.01, required: true, value: 0, help: 'Budget lines, restrictions and the rest are on Funding & spending.' },
    ], { submitText: 'Add funding source', onCancel: () => m.close(), onSubmit: async (d) => { await post('/api/budget/funds', d); toast(`Added "${d.name}"`, 'ok'); m.close(); await refresh(); } });
    const m = modal('Add a funding source', f);
  };
  const paint = () => {
    const rows = funds.map(x => {
      const input = h('input', { value: x.name, maxlength: 200, 'aria-label': `Name of ${x.name}`, 'data-fund-name': x.id });
      const save = async () => { const name = input.value.trim(); if (!name || name === x.name) return; await put(`/api/budget/funds/${x.id}`, { name, if_updated_at: x.updated_at }); toast('Funding source renamed', 'ok'); await refresh(); };
      const toggle = async () => { await put(`/api/budget/funds/${x.id}`, { is_active: !x.is_active, if_updated_at: x.updated_at }); toast(x.is_active ? `"${x.name}" deactivated: no longer offered on new records` : `"${x.name}" is active again`, 'ok'); await refresh(); };
      return h('tr', { 'data-fund': x.id, class: x.is_active ? '' : 'muted' },
        h('td', {}, input, h('div', { class: 'small muted' }, `${fmt.label(x.source_type)} · ${fmt.date(x.fiscal_year_start)} – ${fmt.date(x.fiscal_year_end)}`)),
        h('td', {}, x.is_active ? badge('Active', 'ok') : badge('Inactive')),
        h('td', { class: 'nowrap' }, h('button', { class: 'btn sm', type: 'button', 'data-fund-rename': x.id, onClick: save }, 'Save'), h('button', { class: 'btn sm ghost', type: 'button', 'data-fund-toggle': x.id, onClick: toggle }, x.is_active ? 'Deactivate' : 'Reactivate')));
    });
    box.replaceChildren(...[
      h('summary', {}, h('b', {}, 'Funding sources'), h('span', { class: 'muted small' }, ` — ${funds.filter(x => x.is_active).length} active`)),
      h('p', { class: 'small muted' }, 'The "Funding source" choice on visits, time, overdose events and episodes. A deactivated source is no longer offered; records already charged to it keep it. Budget lines and spending are on ', h('a', { href: '#/budget' }, 'Funding & spending'), '.'),
      funds.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))), h('tbody', {}, rows))) : h('p', { class: 'muted' }, 'No funding sources yet.'),
      h('div', { class: 'row mt' }, h('button', { class: 'btn sm primary', type: 'button', 'data-fund-add': '1', onClick: quickAdd }, '+ Add funding source'))].filter(Boolean));
  };
  paint();
  return box;
}

/** The Lists tab. `focus` is a list key (or 'funds') to open and scroll to, from an "Edit this list" link. */
export async function listsTab(focus) {
  const out = h('div', { 'data-lists': '1' });
  if (can('settings:manage')) {
    const d = await get('/api/admin/lists');
    const editable = d.editable && canEditLists();
    out.append(h('div', { class: 'banner small mb' }, editable
      ? 'The choices offered on documentation forms. Rewording a choice changes how it reads everywhere — forms, lists, reports and exports — without changing the records that use it. A hidden choice is no longer offered on new records; records that already have it keep it. Choices marked "Used by SUDS" drive a count or an automatic step, so they can be reworded but not hidden.'
      : 'These lists are managed on the office SUDS and arrive on this device when it syncs.'));
    const groups = [...new Set(d.lists.map(l => l.group))];
    for (const g of groups) out.append(h('h2', { class: 'mt' }, g), ...d.lists.filter(l => l.group === g).map(l => listCard(l, { editable, open: focus === l.key })));
    out.append(h('details', { class: 'card mt' }, h('summary', {}, h('b', {}, 'Lists that cannot be changed here')),
      h('ul', { class: 'small' }, d.excluded.map(x => h('li', {}, h('b', {}, x.name), ` — ${x.why}`)))));
  }
  if (can('budget:manage')) out.append(h('h2', { class: 'mt' }, 'Funding'), await fundsCard(focus === 'funds' || !can('settings:manage')));
  if (focus) setTimeout(() => { const el = out.querySelector(`[data-list="${CSS.escape(focus)}"]`); if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); } }, 0);
  return out;
}

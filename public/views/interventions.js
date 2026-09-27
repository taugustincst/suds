import { h, route, get, pagedList, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav, listFilterOptions } from '../app.js';
import { flattenLines } from './budget.js';

// ---- supplies handed out (docs/SUPPLIES.md) ----
// The program's usual items are on the form already, one tap each (a stepper: − count +), and any other item
// is one choice away. The quantity box of the usual naloxone and fentanyl test strip items carries the name
// the visit's two counts always had (naloxone_kits, fentanyl_strips), so the form reads the same to anything
// that filled those in. What is sent is the whole list; the server works the counts out from it.
const COUNTED = { naloxone: 'naloxone_kits', fentanyl_test_strips: 'fentanyl_strips' };
async function supplyCatalog() { try { return await get('/api/supplies/catalog', { quiet: true }); } catch { return null; } }
/** The first item of a category, the usual one first: the one a bare count is drawn from (server/supplies.js defaultItemFor). */
const defaultOf = (cat, category) => cat.items.filter(i => i.category === category).sort((a, b) => (b.quick - a.quick))[0] || null;
function supplyPicker(cat, { lines = [], counts = {}, siteId = null, isNew = true } = {}) {
  const rows = new Map(); // item_id -> { item, input, row }
  const list = h('div', { class: 'supply-rows' });
  const named = new Map(Object.entries(COUNTED).map(([category, col]) => [defaultOf(cat, category)?.id, col]).filter(([id]) => id));
  const addRow = (it, qty = '', { removable = false, focus = false } = {}) => {
    if (rows.has(it.id)) { const r = rows.get(it.id); if (qty !== '') r.input.value = String((Number(r.input.value) || 0) + Number(qty)); if (focus) r.input.focus(); return r; }
    const id = `supply-${it.id}-${Math.random().toString(36).slice(2, 7)}`;
    const input = h('input', { type: 'number', id, min: 0, max: 100000, step: 1, inputmode: 'numeric', value: qty, name: named.get(it.id) || null, 'data-supply-item': it.id, class: 'supply-qty' });
    const step = (n) => { input.value = String(Math.max(0, (Number(input.value) || 0) + n)); input.dispatchEvent(new Event('input', { bubbles: true })); };
    const row = h('div', { class: 'supply-row', 'data-supply-row': it.id },
      h('label', { for: id }, it.name, h('span', { class: 'muted small' }, ` (${it.unit})`)),
      h('div', { class: 'row nowrap supply-step' },
        h('button', { type: 'button', class: 'btn sm', 'aria-label': `One fewer ${it.name}`, onClick: () => step(-1) }, '−'), input,
        h('button', { type: 'button', class: 'btn sm', 'aria-label': `One more ${it.name}`, onClick: () => step(1) }, '+'),
        removable ? h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Remove ${it.name}`, onClick: () => { rows.delete(it.id); row.remove(); refreshAdd(); } }, '✕') : null));
    const r = { item: it, input, row }; rows.set(it.id, r); list.append(row);
    if (focus) input.focus();
    refreshAdd();
    return r;
  };
  const addSel = h('select', { id: `supply-add-${Math.random().toString(36).slice(2, 7)}`, 'data-supply-add': '1' });
  const refreshAdd = () => { addSel.replaceChildren(h('option', { value: '' }, 'Another item…'), ...cat.items.filter(i => !rows.has(i.id)).map(i => h('option', { value: i.id }, i.name))); addWrap.hidden = !cat.items.some(i => !rows.has(i.id)); };
  const addWrap = h('div', { class: 'row supply-add' }, h('label', { for: addSel.id, class: 'sr-only' }, 'Add another item'), addSel,
    h('button', { type: 'button', class: 'btn sm', 'data-supply-add-button': '1', onClick: () => { const it = cat.items.find(i => i.id === addSel.value); if (it) addRow(it, 1, { removable: true, focus: true }); } }, 'Add'));
  // The usual items first, then what this visit already lists; a count the visit carries with no item behind
  // it (recorded before items existed) is shown on its category's usual item, as the server reads it.
  for (const it of cat.items.filter(i => i.quick)) addRow(it);
  const byId = new Map(cat.items.map(i => [i.id, i]));
  for (const l of lines) { const it = byId.get(l.item_id) || { id: l.item_id, name: l.item, unit: l.unit || 'each', category: l.category }; addRow(it, '', { removable: !it.quick }).input.value = String(l.quantity); }
  for (const [category, col] of Object.entries(COUNTED)) {
    const have = lines.filter(l => l.category === category).reduce((n, l) => n + l.quantity, 0);
    const d = defaultOf(cat, category);
    if (d && Number(counts[col] || 0) > have) addRow(d, Number(counts[col]) - have, { removable: !d.quick });
  }
  refreshAdd();
  const siteSel = cat.sites.length > 1 ? h('select', { id: `supply-site-${Math.random().toString(36).slice(2, 7)}`, 'data-supply-site': '1' }, cat.sites.map(s => h('option', { value: s.id, selected: s.id === (siteId || cat.site_id) }, s.name))) : null;
  const value = () => [...rows.values()].map(r => ({ item_id: r.item.id, quantity: Math.max(0, Math.floor(Number(r.input.value) || 0)) })).filter(x => x.quantity > 0);
  const initial = JSON.stringify(value()); const initialSite = siteSel ? siteSel.value : null;
  const el = h('fieldset', { class: 'supply-picker span', 'data-supply-picker': '1' },
    h('legend', {}, 'Supplies given'),
    list, addWrap,
    siteSel ? h('div', { class: 'field' }, h('label', { for: siteSel.id }, 'Supplies came from'), siteSel) : null,
    h('p', { class: 'help small muted' }, isNew ? 'Taken off the stock at that site, the batch that expires first first.' : 'A change here puts stock back or takes more, by the difference.'));
  return { el, value, changed: () => JSON.stringify(value()) !== initial, site: () => (siteSel ? siteSel.value : null), siteChanged: () => !!siteSel && siteSel.value !== initialSite };
}

// `template`: an earlier intervention for this same client to prefill from (type, location, modality,
// supplies, funding…) when the worker is logging the same kind of visit again — the date/time, duration
// and free-text summary are never carried over, since those are specific to today.
// `preset`: fields a new visit starts with (Supplies' Hand out: a distribution with the item already on it).
export async function openInterventionForm(values, { clientId, clientDisplay, onDone, template, preset } = {}) {
  const C = state.constants; const isNew = !values;
  // The items this program hands out (none: the two counts as number fields, as before items existed).
  const cat = can('interventions:write') ? await supplyCatalog() : null;
  const kept = new Set((cat ? cat.items : []).map(i => i.category));
  const src = values || template || preset || {};
  const picker = cat && cat.items.length ? supplyPicker(cat, { lines: src.supplies || [], counts: src, siteId: src.supply_site_id, isNew }) : null;
  const ssp = cat && (kept.has('syringes') || kept.has('sharps_container')) || Number(src.syringes_returned || 0) > 0;
  // `values` (the `form()` helper's lookup for a field's starting value) wins over a field's own `value`
  // default, so the parts of the template we do NOT want carried over — when it happened, how long it
  // took, what was written up — have to be scrubbed from the seed itself, not overridden per-field below.
  const seed = values || (template ? { ...template, occurred_at: new Date().toISOString(), duration_minutes: 30, summary: '', follow_up_due: '', user_id: undefined, syringes_returned: null, returns_estimated: 0, sharps_returned_litres: null } : preset ? { ...preset } : {});
  // A new visit is charged to the worker's default fund (or the programme's) unless they choose another, so it
  // is not left out of the funder report's "By funding source"; a repeated visit keeps the fund it had.
  if (!values && !template && !(preset && preset.funding_source_id) && state.defaultFundId && state.funds?.some(x => x.id === state.defaultFundId)) seed.funding_source_id = state.defaultFundId;
  // Outreach and community naloxone distribution can be recorded with no client (a kit handed to someone who
  // gives no name); every other service needs one. The server enforces the same list.
  const clientless = (type) => (C.CLIENTLESS_INTERVENTION_TYPES || ['outreach', 'naloxone_distribution']).includes(type);
  const clientField = { name: 'client_id', label: 'Client', type: 'client', required: !clientless(seed.type), value: clientId || values?.client_id, display: clientDisplay,
    help: 'Optional for outreach and community naloxone distribution; required for everything else.' };
  const f = form([
    clientField,
    { name: 'type', label: 'What did you do?', type: 'select', list: 'INTERVENTION_TYPES', required: true },
    { name: 'occurred_at', label: 'Date & time', type: 'datetime', required: true, value: new Date().toISOString() },
    { name: 'duration_minutes', label: 'Duration (minutes)', type: 'number', min: 0, max: 1440, step: 1, value: 30 },
    { name: 'location', label: 'Location', type: 'select', list: 'LOCATIONS', value: C.DEFAULT_LOCATION || 'office' }, { name: 'modality', label: 'Modality', type: 'select', list: 'MODALITIES', value: 'in_person' },
    { name: 'outcome', label: 'Outcome', type: 'select', list: 'OUTCOMES' }, { name: 'stage_of_change', label: 'Stage of change', type: 'select', options: C.STAGES },
    // A count as a number field only where the program keeps no item of that kind (the picker shows the rest).
    !picker || !kept.has('naloxone') ? { name: 'naloxone_kits', label: 'Naloxone kits given', type: 'number', min: 0, step: 1, value: 0 } : null,
    !picker || !kept.has('fentanyl_test_strips') ? { name: 'fentanyl_strips', label: 'Fentanyl test strips given', type: 'number', min: 0, step: 1, value: 0 } : null,
    ssp ? { name: 'syringes_returned', label: 'Used syringes returned', type: 'number', min: 0, step: 1, help: 'Counted, or estimated from the container below.' } : null,
    ssp ? { name: 'returns_estimated', label: 'Estimated from the container, not counted', type: 'checkbox' } : null,
    ssp ? { name: 'sharps_returned_litres', label: 'Container volume (litres)', type: 'number', min: 0, max: 1000, step: 0.1, help: `Estimated at ${cat ? cat.syringes_per_litre : 100} syringes a litre (Supplies settings).` } : null,
    can('budget:read') ? { name: 'funding_source_id', label: 'Funding source', type: 'fund' } : null,
    // A cost is only ever deducted from a specific allocation, never just "the fund" — the line is what
    // actually shrinks (server/routes/interventions.js requires it once cost > 0).
    can('budget:read') ? { name: 'budget_line_id', label: 'Budget line', type: 'select', options: [] } : null,
    can('budget:read') ? { name: 'cost', label: 'Direct cost ($)', type: 'number', min: 0, step: 0.01 } : null,
    { name: 'summary', label: 'Short summary (no names or health details here — put those in a Note)', type: 'textarea', span: true, rows: 3 },
    { name: 'follow_up_due', label: 'Remind me to follow up on', type: 'date' },
    isNew ? { name: 'log_time', label: 'Also log this as a time entry', type: 'checkbox', value: true } : null,
    isNew ? { name: 'time_category', label: 'Time category', type: 'select', list: 'TIME_CATEGORIES', value: 'direct_service' } : null,
    isNew && can('clients:all') ? { name: 'user_id', label: 'Worker (defaults to you)', type: 'user' } : null,
  ].filter(Boolean), { values: seed, extra: picker ? picker.el : null, submitText: isNew ? 'Save' : 'Save changes', draftKey: values ? `intervention:${values.id}` : 'intervention:new', onCancel: () => m.close(), onSubmit: async (d) => {
    if (picker) {
      // The whole list, for a new visit or when it changed; an edit that did not touch it leaves the stock alone.
      if (isNew || picker.changed()) d.supplies = picker.value();
      if (picker.site() && (isNew || picker.siteChanged())) d.supply_site_id = picker.site();
    }
    const saved = isNew ? await post('/api/interventions', d) : await put(`/api/interventions/${values.id}`, { ...d, if_updated_at: values.updated_at });
    // Kits or strips handed out that the cupboard has no item for were not taken off any stock: say so,
    // rather than leave Supplies silently wrong (Supplies offers to add the standard items).
    const missed = (saved && saved.supplies_untracked) || [];
    if (missed.length) toast(`Visit logged. ${missed.map(x => `${x.quantity} × ${x.item}`).join(' and ')} ${missed.length === 1 && missed[0].quantity === 1 ? 'was' : 'were'} not taken off Supplies: there is no "${missed.map(x => x.item).join('" or "')}" item there yet. Add it under Supplies.`, 'warn', { ms: 12000 });
    else toast(isNew ? 'Visit logged' : 'Saved', 'ok');
    m.close(); onDone && onDone();
  } });
  // Whether Client is required follows the type chosen: the field's own flag is what form().read() checks,
  // and the label's asterisk and the control's required/aria-required say the same thing on screen.
  const syncClientRequired = () => {
    const req = !clientless(f.inputs.type.value);
    clientField.required = req;
    const wrap = f.querySelector('[data-field="client_id"]');
    const label = wrap && wrap.querySelector(':scope > label');
    if (label) label.textContent = req ? 'Client *' : 'Client (optional)';
    const text = wrap && wrap.querySelector('input[type="text"]');
    if (text) { text.required = req; if (req) text.setAttribute('aria-required', 'true'); else text.removeAttribute('aria-required'); }
    if (!req && wrap) { wrap.classList.remove('error'); const err = wrap.querySelector('.err'); if (err) err.textContent = ''; }
  };
  f.inputs.type.addEventListener('change', syncClientRequired);
  syncClientRequired();
  if (can('budget:read')) {
    const fundSel = f.inputs.funding_source_id, lineSel = f.inputs.budget_line_id;
    const fillLines = () => { const fund = state.funds.find(x => x.id === fundSel.value); lineSel.replaceChildren(h('option', { value: '' }, '— none —'), ...flattenLines(fund ? fund.lines : []).map(l => h('option', { value: l.id, selected: l.id === seed.budget_line_id }, `${'— '.repeat(l._depth)}${l.label || fmt.label(l.category)} (${fmt.money(l.allocated_amount - l.subtree_spent)} left)`))); };
    fundSel.addEventListener('change', fillLines);
    fillLines();
  }
  // An estimate from the container fills in the count as it is typed (the server makes the same estimate).
  if (ssp) {
    const est = () => { const l = Number(f.inputs.sharps_returned_litres.value); if (f.inputs.returns_estimated.checked && l > 0) f.inputs.syringes_returned.value = String(Math.round(l * (cat ? cat.syringes_per_litre : 100))); };
    f.inputs.sharps_returned_litres.addEventListener('input', est); f.inputs.returns_estimated.addEventListener('change', est);
  }
  const m = modal(isNew ? (template ? 'Repeat a visit' : 'Log a visit') : 'Edit visit', f, { wide: true });
}
// Opens the form prefilled from the client's most recent intervention, or falls back to a blank one if
// they have none yet — so the button on a client's page never has to know in advance whether history exists.
export async function openRepeatInterventionForm(clientId, clientDisplay, onDone) {
  let template = null;
  try { const { rows } = await get(`/api/interventions?client_id=${clientId}&limit=1`); template = rows[0] || null; } catch { /* fall back to a blank form */ }
  openInterventionForm(null, { clientId, clientDisplay, onDone, template });
}

export function interventionTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'Date', render: r => h('span', { class: 'nowrap' }, fmt.dt(r.occurred_at)) },
    showClient ? { label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}`, onClick: e => e.stopPropagation() }, r.client_code) } : null,
    { label: 'Type', render: r => fmt.label(r.type, 'INTERVENTION_TYPES') }, { label: 'Duration', render: r => fmt.mins(r.duration_minutes), num: true },
    { label: 'Where', render: r => `${fmt.label(r.location, 'LOCATIONS')} · ${fmt.label(r.modality, 'MODALITIES')}` }, { label: 'Outcome', render: r => r.outcome ? badge(fmt.label(r.outcome, 'OUTCOMES'), statusKind(r.outcome)) : '—' },
    { label: 'Supplies', render: r => (r.supplies && r.supplies.length
      ? r.supplies.map((x, i) => [i ? ' ' : null, badge(`${x.quantity} ${x.item}`, x.category === 'naloxone' ? 'ok' : 'info')])
      : [r.naloxone_kits ? badge(`${r.naloxone_kits} naloxone`, 'ok') : null, r.fentanyl_strips ? [' ', badge(`${r.fentanyl_strips} FTS`, 'info')] : null]).concat(r.syringes_returned ? [' ', badge(`${r.syringes_returned} returned${r.returns_estimated ? ' (est.)' : ''}`, '')] : []) },
    { label: 'Worker', key: 'worker' }, { label: 'Summary', render: r => h('span', { class: 'small' }, (r.summary || '').slice(0, 120)) },
    { label: '', render: r => (r.user_id === state.user.id || can('clients:all')) && can('interventions:write') ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: (e) => { e.stopPropagation(); openInterventionForm(r, { onDone: onChange }); } }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this visit', onClick: async (e) => { e.stopPropagation(); if (await confirmDialog('Delete visit', 'Delete this visit? This is logged.', { danger: true, okText: 'Delete' })) { await del(`/api/interventions/${r.id}`); toast('Deleted'); onChange && onChange(); } } }, '✕')) : null },
  ].filter(Boolean), rows, { empty: 'Nothing recorded yet. Use + Log › Log a visit for a visit, screening, warm handoff or other service.' });
}

route('interventions', async (r) => {
  const type = r.query.get('type') || ''; const from = r.query.get('from') || ''; const to = r.query.get('to') || ''; const mine = r.query.get('mine') === '1';
  // funding=none: the visits with no funding source (the funder report's warning links here).
  const noFund = r.query.get('funding') === 'none';
  // naloxone=1: the visits that handed out naloxone kits, of any type (Home's kit count links here).
  const kits = r.query.get('naloxone') === '1';
  const qs = `${type ? '&type=' + type : ''}${from ? '&from=' + from : ''}${to ? '&to=' + to : ''}${mine ? '&mine=1' : ''}${noFund ? '&funding=none' : ''}${kits ? '&naloxone=1' : ''}`.replace(/^&/, '');
  const PAGE = 200;
  const data = await get(`/api/interventions?limit=${PAGE}${qs ? '&' + qs : ''}`);
  const refresh = () => nav(`interventions?${qs}&_=${Date.now()}`);
  const C = state.constants;
  const typeSel = h('select', { onChange: () => nav(`interventions?type=${typeSel.value}&from=${from}&to=${to}${mine ? '&mine=1' : ''}${noFund ? '&funding=none' : ''}${kits ? '&naloxone=1' : ''}`) }, h('option', { value: '' }, 'All types'), listFilterOptions('INTERVENTION_TYPES').map(o => h('option', { value: o.value, selected: o.value === type }, o.label)));
  const fromI = h('input', { type: 'date', value: from }), toI = h('input', { type: 'date', value: to });
  const mineI = h('input', { type: 'checkbox', checked: mine });
  const apply = () => nav(`interventions?type=${type}&from=${fromI.value}&to=${toI.value}${mineI.checked ? '&mine=1' : ''}${noFund ? '&funding=none' : ''}${kits ? '&naloxone=1' : ''}`);
  return h('div', {},
    pageHead('Visits', can('interventions:write') ? h('button', { class: 'btn primary', onClick: () => openInterventionForm(null, { onDone: refresh }) }, '+ Log a visit') : null, can('export:read') ? h('button', { class: 'btn', onClick: () => downloadCsv(`/api/reports/export/interventions?from=${from || '2000-01-01'}&to=${to || fmt.today()}&format=xlsx`) }, 'Export to Excel') : null),
    noFund ? h('div', { class: 'banner warn small', 'data-no-fund-filter': '1' }, 'Showing only visits with no funding source. Edit each one to choose the fund it was charged to. ', h('a', { href: `#/interventions?type=${type}&from=${from}&to=${to}${mine ? '&mine=1' : ''}` }, 'Show all visits')) : null,
    kits ? h('div', { class: 'banner info small', 'data-naloxone-filter': '1' }, 'Showing only visits that handed out naloxone kits, of any type. ', h('a', { href: `#/interventions?type=${type}&from=${from}&to=${to}${mine ? '&mine=1' : ''}` }, 'Show all visits')) : null,
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Type'), typeSel), h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('label', { class: 'check', style: { marginTop: 0 } }, mineI, 'Mine only'), h('button', { class: 'btn', onClick: apply }, 'Apply')),
    pagedList({ first: data, url: `/api/interventions${qs ? '?' + qs : ''}`, limit: PAGE, render: (rows) => interventionTable(rows, { onChange: refresh }),
      summary: (rows, total) => h('div', { class: 'muted small mb' }, `${total} visit${total === 1 ? '' : 's'} · ${fmt.mins(rows.reduce((s, x) => s + (x.duration_minutes || 0), 0))} shown`) }));
});

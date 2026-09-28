import { h, route, get, pagedList, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav, listFilterOptions, listEntries, prefs, NOT_SAVED, offerResume, render } from '../app.js';
import { flattenLines } from './budget.js';
import { SECTIONS as NOTE_SECTIONS, sectionLabel } from './notes.js';

// ---- supplies handed out (docs/SUPPLIES.md) ----
// The program's usual items are on the form already, one tap each (a stepper: − count +), and any other item
// is one choice away. The quantity box of the usual naloxone and fentanyl test strip items carries the name
// the visit's two counts always had (naloxone_kits, fentanyl_strips), so the form reads the same to anything
// that filled those in. What is sent is the whole list; the server works the counts out from it.
const COUNTED = { naloxone: 'naloxone_kits', fentanyl_test_strips: 'fentanyl_strips' };
// The two items every report counts, by the names the Supplies page's one-click adds them under, and what
// the picker calls them while the programme keeps no item for them.
const STANDARD = { naloxone: 'Naloxone kit', fentanyl_test_strips: 'Fentanyl test strips' };
const UNTRACKED_LABEL = { naloxone: 'Naloxone kits', fentanyl_test_strips: 'Fentanyl test strips' };
async function supplyCatalog() { try { return await get('/api/supplies/catalog', { quiet: true }); } catch { return null; } }
/** The first item of a category, the usual one first: the one a bare count is drawn from (server/supplies.js defaultItemFor). */
const defaultOf = (cat, category) => cat.items.filter(i => i.category === category).sort((a, b) => (b.quick - a.quick))[0] || null;
const rid = () => Math.random().toString(36).slice(2, 7);
/**
 * Add the naloxone kit and fentanyl test strip items the programme does not keep yet (supplies:manage), the
 * same one click as on the Supplies page; nothing on hand until stock is received. Resolves to the new catalog.
 */
async function addStandardItems(names) {
  for (const item of names) await post('/api/supplies', { item, quantity: 0 });
  toast(`Added ${names.join(' and ')} to Supplies. Record what is on the shelf there with Receive stock.`, 'ok');
  return supplyCatalog();
}
/** Where the programme keeps no naloxone or test strip item: said inside the visit form, before it is saved. */
function missingNotice(cat, missing, onAdd) {
  if (!missing.length) return null;
  const names = missing.map(c => STANDARD[c]);
  return h('div', { class: 'banner warn small supply-notice', role: 'note', 'data-supplies-missing': names.join('|') },
    h('p', { style: { margin: 0 } }, `Supplies has no ${names.map(n => `"${n}"`).join(' or ')} item yet, so ${missing.map(c => UNTRACKED_LABEL[c].toLowerCase()).join(' and ')} recorded here count on the visit and in reports but are not taken off any stock.`,
      cat.can_configure ? '' : ' Ask a supervisor or administrator to add them under Supplies.'),
    cat.can_configure && onAdd ? h('div', { class: 'row', style: { marginTop: '.45rem' } }, h('button', { type: 'button', class: 'btn sm', 'data-add-standard-supplies': '1', onClick: (e) => onAdd(names, e.currentTarget) },
      missing.length === 2 ? 'Add naloxone kits and test strips' : `Add ${names[0].toLowerCase()} to Supplies`)) : null);
}
function supplyPicker(cat, { lines = [], counts = {}, siteId = null, isNew = true, onAddStandard = null } = {}) {
  const rows = new Map(); // item_id -> { item, input, row }
  const list = h('div', { class: 'supply-rows' });
  const named = new Map(Object.entries(COUNTED).map(([category, col]) => [defaultOf(cat, category)?.id, col]).filter(([id]) => id));
  const stepper = (input, name) => {
    const step = (n) => { input.value = String(Math.max(0, (Number(input.value) || 0) + n)); input.dispatchEvent(new Event('input', { bubbles: true })); };
    return [h('button', { type: 'button', class: 'btn sm', 'aria-label': `One fewer ${name}`, onClick: () => step(-1) }, '−'), input,
      h('button', { type: 'button', class: 'btn sm', 'aria-label': `One more ${name}`, onClick: () => step(1) }, '+')];
  };
  const addRow = (it, qty = '', { removable = false, focus = false } = {}) => {
    if (rows.has(it.id)) { const r = rows.get(it.id); if (qty !== '') r.input.value = String((Number(r.input.value) || 0) + Number(qty)); if (focus) r.input.focus(); return r; }
    const id = `supply-${it.id}-${rid()}`;
    const input = h('input', { type: 'number', id, min: 0, max: 100000, step: 1, inputmode: 'numeric', value: qty, name: named.get(it.id) || null, 'data-supply-item': it.id, class: 'supply-qty' });
    const row = h('div', { class: 'supply-row', 'data-supply-row': it.id },
      h('label', { for: id }, it.name, h('span', { class: 'muted small' }, ` (${it.unit})`)),
      h('div', { class: 'row nowrap supply-step' }, ...stepper(input, it.name),
        removable ? h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Remove ${it.name}`, onClick: () => { rows.delete(it.id); row.remove(); refreshAdd(); } }, '✕') : null));
    const r = { item: it, input, row }; rows.set(it.id, r); list.append(row);
    if (focus) input.focus();
    refreshAdd();
    return r;
  };
  const addSel = h('select', { id: `supply-add-${rid()}`, 'data-supply-add': '1' });
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
  // A category every report counts that the programme keeps no item for is still a row of this same picker, so
  // kits are recorded in one place whatever Supplies holds: counted on the visit (naloxone_kits /
  // fentanyl_strips, which the server keeps accepting) but taken off no stock, and the notice says so.
  const missing = Object.keys(COUNTED).filter(category => !cat.items.some(i => i.category === category));
  const untracked = new Map();
  for (const category of missing) {
    const col = COUNTED[category]; const id = `supply-${col}-${rid()}`;
    const input = h('input', { type: 'number', id, min: 0, max: 100000, step: 1, inputmode: 'numeric', value: Number(counts[col] || 0) > 0 ? String(counts[col]) : '', name: col, 'data-untracked': col, class: 'supply-qty' });
    list.append(h('div', { class: 'supply-row', 'data-supply-row': col, 'data-untracked-row': col },
      h('label', { for: id }, UNTRACKED_LABEL[category], h('span', { class: 'muted small' }, ' (not taken off stock)')),
      h('div', { class: 'row nowrap supply-step' }, ...stepper(input, UNTRACKED_LABEL[category]))));
    untracked.set(col, input);
  }
  refreshAdd();
  const siteSel = cat.sites.length > 1 ? h('select', { id: `supply-site-${rid()}`, 'data-supply-site': '1' }, cat.sites.map(s => h('option', { value: s.id, selected: s.id === (siteId || cat.site_id) }, s.name))) : null;
  const value = () => [...rows.values()].map(r => ({ item_id: r.item.id, quantity: Math.max(0, Math.floor(Number(r.input.value) || 0)) })).filter(x => x.quantity > 0);
  const untrackedValue = () => Object.fromEntries([...untracked].map(([col, i]) => [col, Math.max(0, Math.floor(Number(i.value) || 0))]));
  const snapshot = () => JSON.stringify([value(), untrackedValue()]);
  const initial = snapshot(); const initialSite = siteSel ? siteSel.value : null;
  const el = h('fieldset', { class: 'supply-picker span', 'data-supply-picker': '1' },
    h('legend', {}, 'Supplies given'),
    list, addWrap, missingNotice(cat, missing, onAddStandard),
    siteSel ? h('div', { class: 'field' }, h('label', { for: siteSel.id }, 'Supplies came from'), siteSel) : null,
    h('p', { class: 'help small muted' }, isNew ? 'Taken off the stock at that site, the batch that expires first first.' : 'A change here puts stock back or takes more, by the difference.'));
  return { el, value, untrackedValue, total: () => value().reduce((n, x) => n + x.quantity, 0) + Object.values(untrackedValue()).reduce((n, x) => n + x, 0),
    changed: () => snapshot() !== initial, site: () => (siteSel ? siteSel.value : null), siteChanged: () => !!siteSel && siteSel.value !== initialSite };
}

// ---- the visit form as a field note (1.14.0) ----
// A visit is recorded dozens of times a day, so the form shows what every visit has — who (or no one, for
// anonymous outreach), what was done, when, where, what was handed out, a short summary — and folds the rest
// into sections a person opens when the visit needs them. A section opens by itself when it holds something
// other than a new visit's default (an edit with a cost, a repeated visit with a follow-up) or when a field in
// it needs fixing (form() opens the section of a field with an error), and otherwise stays the way this
// person last left it (prefs VISIT_SECTIONS, per user). Nothing was removed; every field is still there.
const VISIT_SECTIONS = 'visit_sections';
// The worker's last new visit: its type, location and modality start the next one (prefs VISIT_LAST); the
// programme's default location is used until there is one.
// "Also log this as a time entry" starts unticked on every new visit, for everyone (1.15.3): ticked by default
// (and then remembered), a duration nobody checked went on the time sheet as hours worked. Ticking it is now an
// explicit choice each time, and a prefilled duration nobody changed is confirmed before it is logged.
const VISIT_LAST = 'visit_last';
// A new visit's unsent draft (every field, the supply lines and the note's sections) is kept in memory like
// every form's (public/app.js drafts: never in browser storage). Opening Log a visit again asks "Resume your
// unsent visit?" rather than filling it in unasked, and after signing back in the same question is at the top.
const VISIT_DRAFT = 'intervention:new';
offerResume(VISIT_DRAFT, { question: 'Resume your unsent visit?', open: () => openInterventionForm(null, { onDone: render }) });
const SECTION_FIELDS = { outcome: ['outcome', 'stage_of_change', 'follow_up_due'], syringes: ['syringes_returned', 'returns_estimated', 'sharps_returned_litres'],
  funding: ['funding_source_id', 'budget_line_id', 'cost'], time: ['duration_minutes', 'log_time', 'time_category'], recorded_by: ['user_id'], note: ['note_title', 'note_content'] };
const NOTE_KINDS = () => ['admin', 'clinical'].filter(k => can(`notes:${k}:write`));
const usable = (list, code) => !!code && listEntries(list).some(e => e.code === code && !e.hidden);

// `template`: an earlier intervention for this same client to prefill from (type, location, modality,
// supplies, funding…) when the worker is logging the same kind of visit again — the date/time, duration
// and free-text summary are never carried over, since those are specific to today.
// `preset`: fields a new visit starts with (Supplies' Hand out: a distribution with the item already on it).
export async function openInterventionForm(values, { clientId, clientDisplay, onDone, template, preset } = {}) {
  const C = state.constants; const isNew = !values;
  // The items this program hands out (none: the two counts as number fields, as before items existed).
  let cat = can('interventions:write') ? await supplyCatalog() : null;
  const kept = new Set((cat ? cat.items : []).map(i => i.category));
  const src = values || template || preset || {};
  let picker = null; let pickerRebuilt = false;
  const makePicker = (c, opts) => supplyPicker(c, { siteId: src.supply_site_id, isNew, onAddStandard: addStandard, ...opts });
  if (cat && cat.items.length) picker = makePicker(cat, { lines: src.supplies || [], counts: src });
  const ssp = cat && (kept.has('syringes') || kept.has('sharps_container')) || Number(src.syringes_returned || 0) > 0;
  // `values` (the `form()` helper's lookup for a field's starting value) wins over a field's own `value`
  // default, so the parts of the template we do NOT want carried over — when it happened, how long it
  // took, what was written up — have to be scrubbed from the seed itself, not overridden per-field below.
  const seed = values || (template ? { ...template, occurred_at: new Date().toISOString(), duration_minutes: 30, summary: '', follow_up_due: '', user_id: undefined, syringes_returned: null, returns_estimated: 0, sharps_returned_litres: null } : preset ? { ...preset } : {});
  // A new visit is charged to the worker's default fund (or the programme's) unless they choose another, so it
  // is not left out of the funder report's "By funding source"; a repeated visit keeps the fund it had.
  const defaultFund = state.defaultFundId && state.funds?.some(x => x.id === state.defaultFundId) ? state.defaultFundId : '';
  if (!values && !template && !(preset && preset.funding_source_id) && defaultFund) seed.funding_source_id = defaultFund;
  // A new visit (not a repeat, which has its own) starts where this worker's last one was: same type, place
  // and way of meeting, while those are still on the programme's lists.
  if (!values && !template) {
    const last = prefs.get(VISIT_LAST, null) || {};
    // A preset (Supplies' Hand out) says what kind of visit this is; the last visit only fills what it leaves open.
    if (usable('INTERVENTION_TYPES', last.type) && !(preset && preset.type)) seed.type = last.type;
    if (usable('LOCATIONS', last.location) && !(preset && preset.location)) seed.location = last.location;
    if (usable('MODALITIES', last.modality)) seed.modality = last.modality;
  }
  const logTimeDefault = false;
  // Outreach and community naloxone distribution can be recorded with no client (a kit handed to someone who
  // gives no name); every other service needs one. The server enforces the same list.
  const clientless = (type) => (C.CLIENTLESS_INTERVENTION_TYPES || ['outreach', 'naloxone_distribution']).includes(type);
  const clientField = { name: 'client_id', label: 'Client', type: 'client', required: !clientless(seed.type), value: clientId || values?.client_id, display: clientDisplay,
    help: 'Optional for outreach and community naloxone distribution (someone who gives no name); required for everything else.' };
  const noteKinds = isNew ? NOTE_KINDS() : [];
  // The duration counts as looked at once the person changes it (or a resumed draft had one of its own).
  let durationChecked = false;
  const clientName = () => { const t = f.inputs.client_id && f.inputs.client_id.searchInput; return (t && t.value.trim()) || clientDisplay || 'this client'; };
  const section = (key, label, hint) => ({ type: 'section', key, label, collapsible: true, heading: true, hint });
  const f = form([
    clientField,
    { name: 'type', label: 'What did you do?', type: 'select', list: 'INTERVENTION_TYPES', required: true },
    { name: 'occurred_at', label: 'Date & time', type: 'datetime', required: true, value: new Date().toISOString() },
    // Where and how (1.15.3): filled in from this worker's last visit, so on a new visit it is folded away with
    // what it holds in its heading ("Where & how — Office · In person"), one tap from being changed. At 390 px a
    // new visit of any type then shows seven fields before its sections: client, what was done, date & time,
    // the supplies' usual items and the summary. An edit shows it open.
    section('where', 'Where & how'),
    { name: 'location', label: 'Location', type: 'select', list: 'LOCATIONS', value: C.DEFAULT_LOCATION || 'office' }, { name: 'modality', label: 'Modality', type: 'select', list: 'MODALITIES', value: 'in_person' },
    { type: 'section', end: true },
    // The two counts as number fields only where the program keeps no supply items at all (the picker holds
    // them otherwise, tracked or not): stock is then not tracked, and the help says so.
    !picker ? { name: 'naloxone_kits', label: 'Naloxone kits given', type: 'number', min: 0, step: 1, value: 0 } : null,
    !picker ? { name: 'fentanyl_strips', label: 'Fentanyl test strips given', type: 'number', min: 0, step: 1, value: 0 } : null,
    { name: 'summary', label: 'Short summary', type: 'textarea', span: true, rows: 2,
      help: noteKinds.length ? 'No names or health details here: those go in "Add a note" below.' : 'No names or health details here: put those in a Note.' },
    section('outcome', 'Outcome & follow-up'),
    { name: 'outcome', label: 'Outcome', type: 'select', list: 'OUTCOMES' }, { name: 'stage_of_change', label: 'Stage of change', type: 'select', options: C.STAGES },
    { name: 'follow_up_due', label: 'Remind me to follow up on', type: 'date' },
    ...(ssp ? [section('syringes', 'Syringe services'),
      { name: 'syringes_returned', label: 'Used syringes returned', type: 'number', min: 0, step: 1, help: 'Counted, or estimated from the container below.' },
      { name: 'returns_estimated', label: 'Estimated from the container, not counted', type: 'checkbox' },
      { name: 'sharps_returned_litres', label: 'Container volume (litres)', type: 'number', min: 0, max: 1000, step: 0.1, help: `Estimated at ${cat ? cat.syringes_per_litre : 100} syringes a litre (Supplies settings).` }] : []),
    ...(can('budget:read') ? [section('funding', 'Funding & cost'),
      { name: 'funding_source_id', label: 'Funding source', type: 'fund' },
      // A cost is only ever deducted from a specific allocation, never just "the fund" — the line is what
      // actually shrinks (server/rules/interventions.js requires it once cost > 0).
      { name: 'budget_line_id', label: 'Budget line', type: 'select', options: [], help: 'Required when there is a direct cost.' },
      { name: 'cost', label: 'Direct cost ($)', type: 'number', min: 0, step: 0.01 }] : []),
    section('time', 'Time'),
    { name: 'duration_minutes', label: 'Duration (minutes)', type: 'number', min: 0, max: 1440, step: 1, value: 30, help: isNew ? 'Filled in as 30 minutes: change it to how long the visit took.' : null },
    isNew ? { name: 'log_time', label: 'Also log this as a time entry', type: 'checkbox', value: logTimeDefault, span: true, help: ' ' } : null,
    isNew ? { name: 'time_category', label: 'Time category', type: 'select', list: 'TIME_CATEGORIES', value: 'direct_service' } : null,
    ...(isNew && can('clients:all') ? [section('recorded_by', 'Recorded by'), { name: 'user_id', label: 'Worker (defaults to you)', type: 'user' }] : []),
    // A substantive visit's note, written here and saved with the visit in one request (server/routes/
    // interventions.js planNote): the same kinds, formats and Part 2 flag as the Note form, as a draft.
    ...(noteKinds.length ? [section('note', 'Add a note'),
      noteKinds.length > 1 ? { name: 'note_kind', label: 'Note type', type: 'select', options: noteKinds.map(k => ({ value: k, label: k === 'clinical' ? 'Clinical (restricted to clinical roles)' : 'Administrative / contact' })), value: noteKinds[0], noBlank: true } : null,
      { name: 'note_format', label: 'Format', type: 'select', list: 'NOTE_FORMATS', value: 'narrative', noBlank: true },
      { name: 'note_title', label: 'Title (optional)', span: true },
      { name: 'note_content', label: 'Note', type: 'textarea', span: true, rows: 5, help: 'Saved with the visit as a draft note on the client\'s record, linked to this visit. Sign it from Notes when it is complete.' },
      { name: 'note_part2_protected', label: 'Contains 42 CFR Part 2 protected SUD information', type: 'checkbox', value: true }] : []),
  ].filter(Boolean), { values: seed, submitText: isNew ? 'Save' : 'Save changes', draftKey: values ? `intervention:${values.id}` : VISIT_DRAFT, resume: isNew ? 'Resume your unsent visit?' : null, onCancel: () => m.close(), onSubmit: async (d) => {
    // What the server would refuse, said under the field before the round trip — in its section, which
    // form() opens for the error: a cost is charged to a fund and a line of it.
    const bad = {};
    if (can('budget:read') && Number(d.cost) > 0) { if (!d.funding_source_id) bad.funding_source_id = 'is required when there is a direct cost'; else if (!d.budget_line_id) bad.budget_line_id = 'is required when there is a direct cost, so it is deducted from the right allocation'; }
    const note = readNote(d);
    if (note && !d.client_id) bad.note_content = 'needs a client: choose the client above, or leave the note empty (outreach with no name has no record to put it on)';
    if (Object.keys(bad).length) { const e = new Error('Check the highlighted fields.'); e.data = { fields: bad }; throw e; }
    // Time is logged only from a duration someone looked at: with the prefilled 30 minutes untouched, Save asks
    // first, naming the minutes; "Change the duration" goes back to the field with nothing saved.
    if (isNew && d.log_time && Number(d.duration_minutes) > 0 && !durationChecked) {
      const mins = Number(d.duration_minutes);
      const ok = await confirmDialog('Log this time?', `This adds ${mins} minutes of ${fmt.label(d.time_category || 'direct_service', 'TIME_CATEGORIES').toLowerCase()} to ${workerName()} time sheet. ${mins} minutes is what the form starts with: is that how long the visit took?`, { okText: `Log ${mins} minutes`, cancelText: 'Change the duration' });
      if (!ok) { const t = f.sections.time; if (t) t.open = true; setTimeout(() => { f.inputs.duration_minutes.focus(); f.inputs.duration_minutes.select(); }, 0); return NOT_SAVED; }
      durationChecked = true;
    }
    // The same client, the same day and the same kind of visit already recorded (a double tap, a visit logged
    // on the phone and again at the desk): asked, not refused, since two visits in a day do happen.
    if (isNew && d.client_id && d.type && !(await confirmNotDuplicateVisit(d, clientName()))) return NOT_SAVED;
    for (const k of Object.keys(d)) if (k.startsWith('note_')) delete d[k];
    if (note) d.note = note;
    if (picker) {
      // The whole list, for a new visit or when it changed; an edit that did not touch it leaves the stock alone.
      delete d.naloxone_kits; delete d.fentanyl_strips;
      if (isNew || picker.changed() || pickerRebuilt) { d.supplies = picker.value(); Object.assign(d, picker.untrackedValue()); }
      if (picker.site() && (isNew || picker.siteChanged())) d.supply_site_id = picker.site();
    }
    const saved = isNew ? await post('/api/interventions', d) : await put(`/api/interventions/${values.id}`, { ...d, if_updated_at: values.updated_at });
    if (isNew) prefs.set(VISIT_LAST, { type: d.type, location: d.location, modality: d.modality });
    // Kits or strips handed out that the cupboard has no item for were not taken off any stock: say so,
    // rather than leave Supplies silently wrong (the form said so before saving; this is the fallback).
    const missed = (saved && saved.supplies_untracked) || [];
    const noted = saved && saved.note_id ? ' The note is saved as a draft: sign it under Notes.' : '';
    if (missed.length) toast(`Visit logged.${noted} ${missed.map(x => `${x.quantity} × ${x.item}`).join(' and ')} ${missed.length === 1 && missed[0].quantity === 1 ? 'was' : 'were'} not taken off Supplies: there is no "${missed.map(x => x.item).join('" or "')}" item there yet. Add it under Supplies.`, 'warn', { ms: 12000 });
    else toast(isNew ? `Visit logged.${noted}` : 'Saved', 'ok');
    m.close(); onDone && onDone();
  } });
  // The picker sits with the everyday fields, before the summary.
  if (picker) f.querySelector('[data-field="summary"]').before(picker.el);
  // Kits and strips the programme keeps no item for: added to Supplies from here in one click, and the picker
  // rebuilt with what was already entered, now drawn from the new items.
  async function addStandard(names, btn) {
    btn.disabled = true;
    try {
      const fresh = await addStandardItems(names);
      if (!fresh || !fresh.items.length) throw new Error('The items were added, but the list could not be read again. Close this form and open it again.');
      const counts = picker ? picker.untrackedValue() : { naloxone_kits: Number(f.inputs.naloxone_kits?.value) || 0, fentanyl_strips: Number(f.inputs.fentanyl_strips?.value) || 0 };
      const next = makePicker(fresh, { lines: picker ? picker.value() : [], counts });
      if (picker) picker.el.replaceWith(next.el);
      else { f.querySelector('[data-field="summary"]').before(next.el); for (const n of ['naloxone_kits', 'fentanyl_strips']) { const w = f.querySelector(`[data-field="${n}"]`); if (w) w.hidden = true; } }
      picker = next; cat = fresh; pickerRebuilt = true;
      (next.el.querySelector('input.supply-qty') || next.el).focus();
    } catch (e) { btn.disabled = false; toast(e.message || 'The items could not be added.', 'error'); }
  }
  // The same notice where the program keeps no items at all (the number fields): stock is not tracked.
  if (!picker && cat) {
    const n = missingNotice(cat, Object.keys(COUNTED), addStandard);
    if (n) f.querySelector('[data-field="fentanyl_strips"]').after(h('div', { class: 'span' }, n));
  }
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

  // ---- the note's structured sections (SOAP, DAP…), as in the Note form ----
  const structuredBox = h('div', { class: 'span', 'data-note-structured': '1' });
  const readStructured = () => { const out = {}; let any = false; structuredBox.querySelectorAll('textarea[data-sec]').forEach(t => { out[t.dataset.sec] = t.value; if (t.value.trim()) any = true; }); return any ? out : null; };
  function readNote(d) {
    if (!f.inputs.note_content) return null;
    const structured = readStructured(); const format = d.note_format || 'narrative';
    let content = (d.note_content || '').trim();
    if (!content && structured) content = Object.entries(structured).filter(([, v]) => v.trim()).map(([k, v]) => `${sectionLabel(format, k)}: ${v}`).join('\n\n');
    if (!content) return null;
    return { kind: d.note_kind || noteKinds[0], format, title: d.note_title || undefined, content, structured: structured || undefined, part2_protected: !!d.note_part2_protected };
  }
  if (f.inputs.note_format) {
    f.querySelector('[data-field="note_content"]').before(structuredBox);
    const renderStructured = () => {
      structuredBox.replaceChildren();
      const fmtCode = f.inputs.note_format.value; const secs = NOTE_SECTIONS[fmtCode]; if (!secs) return;
      structuredBox.append(h('fieldset', {}, h('legend', {}, fmtCode === 'safety_plan' ? 'Safety plan' : `${fmtCode} sections`),
        secs.map(([k, label]) => { const id = `vn-${k}-${rid()}`; return h('div', { class: 'field' }, h('label', { for: id }, k.length <= 2 ? `${k} — ${label}` : label), h('textarea', { id, 'data-sec': k, rows: 3 })); })));
    };
    f.inputs.note_format.addEventListener('change', renderStructured); renderStructured();
  }

  // ---- the sections: open when they hold something, else as this person last left them; a folded one says
  // what it holds ----
  const defaults = { outcome: '', stage_of_change: '', follow_up_due: '', syringes_returned: '', returns_estimated: false, sharps_returned_litres: '', funding_source_id: defaultFund, budget_line_id: '', cost: '',
    duration_minutes: '30', log_time: logTimeDefault, time_category: 'direct_service', user_id: '', note_title: '', note_content: '' };
  const differs = (n) => { const i = f.inputs[n]; if (!i) return false; return i.type === 'checkbox' ? i.checked !== !!defaults[n] : String(i.value ?? '') !== String(defaults[n] ?? ''); };
  const remembered = prefs.get(VISIT_SECTIONS, null) || {};
  for (const [key, d] of Object.entries(f.sections)) {
    if (key === 'where') continue;
    if ((SECTION_FIELDS[key] || []).some(differs) || remembered[key] === true) d.open = true;
    // Only the person's own opening or closing is remembered (a click on the heading, or Enter or Space on it),
    // not a section opened for them because of a value or an error.
    d.querySelector('summary').addEventListener('click', () => setTimeout(() => prefs.set(VISIT_SECTIONS, { ...(prefs.get(VISIT_SECTIONS, null) || {}), [key]: d.open }), 0));
  }
  if (f.sections.where) f.sections.where.open = !isNew;
  f.inputs.duration_minutes.addEventListener('input', () => { durationChecked = true; });
  const workerName = () => { const id = f.inputs.user_id?.value; const u = id && state.users.find(x => x.id === id); return u && u.id !== state.user.id ? `${u.display_name}'s` : 'your'; };
  const label = (list, code) => (code ? fmt.label(code, list) : '');
  const say = (key, text) => { const s = f.sections[key]; const el = s && s.querySelector('summary [data-section-hint]'); if (el) el.textContent = text ? ` — ${text}` : ''; };
  const refreshHints = () => {
    const i = f.inputs; const mins = Number(i.duration_minutes.value) || 0;
    const timeText = !i.log_time ? `${mins} min`
      : i.log_time.checked && mins > 0 ? `adds ${mins} min of ${label('TIME_CATEGORIES', i.time_category.value || 'direct_service').toLowerCase()} to ${workerName()} time`
      : `${mins} min, not added to ${workerName()} time`;
    say('time', timeText);
    if (i.log_time) {
      const help = f.querySelector('[data-field="log_time"] .help');
      if (help) help.textContent = `${i.log_time.checked && mins > 0 ? `Adds ${mins} min of ${label('TIME_CATEGORIES', i.time_category.value || 'direct_service').toLowerCase()} to ${workerName()} time (My time), as a draft to submit for approval. Check the duration above first.` : 'No time entry is made. Tick this to put the visit on your time sheet, or log the time yourself under My time.'} It starts unticked on every visit.`;
    }
    say('where', [label('LOCATIONS', i.location.value), label('MODALITIES', i.modality.value)].filter(Boolean).join(' · '));
    say('outcome', [label('OUTCOMES', i.outcome.value), i.follow_up_due.value ? `follow up ${fmt.date(i.follow_up_due.value)}` : ''].filter(Boolean).join(' · '));
    if (i.syringes_returned) say('syringes', Number(i.syringes_returned.value) > 0 ? `${i.syringes_returned.value} returned${i.returns_estimated.checked ? ' (estimated)' : ''}` : '');
    if (i.funding_source_id) { const fund = state.funds.find(x => x.id === i.funding_source_id.value) || (state.allFunds || []).find(x => x.id === i.funding_source_id.value); say('funding', [fund ? fund.name : 'no funding source', Number(i.cost.value) > 0 ? fmt.money(Number(i.cost.value)) : ''].filter(Boolean).join(' · ')); }
    if (i.user_id) say('recorded_by', workerName() === 'your' ? 'you' : workerName().replace(/'s$/, ''));
    if (i.note_content) {
      const has = !!(i.note_content.value.trim() || readStructured());
      say('note', has ? 'saved with the visit as a draft note' : 'optional: names and health details go here');
      const btn = f.querySelector('.btn-row button[type=submit]'); if (btn && isNew) btn.textContent = has ? 'Save visit & note' : 'Save';
    }
  };
  // What the draft keeps beside the fields: the supply lines and where they came from, and the note's sections.
  if (isNew) f.draftExtras = {
    read: () => { const x = {}; if (picker) { x.supplies = picker.value(); x.counts = picker.untrackedValue(); if (picker.site()) x.site = picker.site(); } const st = readStructured(); if (st) x.structured = st; return (x.supplies && x.supplies.length) || (x.counts && Object.values(x.counts).some(Boolean)) || x.structured ? x : null; },
    restore: (x) => {
      if (!x) return;
      if (String(f.inputs.duration_minutes.value) !== '30') durationChecked = true;
      if ((x.supplies || x.counts) && cat && cat.items.length) {
        const next = makePicker(cat, { lines: x.supplies || [], counts: x.counts || {}, siteId: x.site || src.supply_site_id });
        if (picker) picker.el.replaceWith(next.el); picker = next;
      }
      if (f.inputs.note_format) f.inputs.note_format.dispatchEvent(new Event('change'));
      if (x.structured) structuredBox.querySelectorAll('textarea[data-sec]').forEach(t => { if (x.structured[t.dataset.sec]) t.value = x.structured[t.dataset.sec]; });
      refreshHints();
    },
  };
  f.addEventListener('input', refreshHints); f.addEventListener('change', refreshHints);
  refreshHints();
  const m = modal(isNew ? (template ? 'Repeat a visit' : 'Log a visit') : 'Edit visit', f, { wide: true });
}
/**
 * Before a new visit is saved: is a visit of the same kind already recorded for this client on the same day?
 * Asked through the ordinary visits list (client, type and that local day), so it sees exactly what this person
 * may see. Resolves true to go ahead; a failed check does not stand in the way of saving.
 */
async function confirmNotDuplicateVisit(d, who) {
  const at = new Date(d.occurred_at || Date.now()); if (isNaN(at)) return true;
  const from = new Date(at.getFullYear(), at.getMonth(), at.getDate()).toISOString();
  const to = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 23, 59, 59, 999).toISOString();
  let rows = [];
  try { ({ rows } = await get(`/api/interventions?client_id=${encodeURIComponent(d.client_id)}&type=${encodeURIComponent(d.type)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=5`, { quiet: true })); } catch { return true; }
  if (!rows || !rows.length) return true;
  const r = rows[0];
  const day = fmt.isoLocal(at).slice(0, 10) === fmt.today() ? 'today' : `on ${fmt.date(fmt.isoLocal(at).slice(0, 10))}`;
  const more = rows.length > 1 ? ` (${rows.length} like it that day)` : '';
  return confirmDialog('Save another visit?', `A visit like this (${fmt.label(d.type, 'INTERVENTION_TYPES')}) is already recorded for ${who} ${day} at ${fmt.time(r.occurred_at) || 'an unrecorded time'}${r.worker ? `, by ${r.worker}` : ''}${more} — save another?`, { okText: 'Save another' });
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

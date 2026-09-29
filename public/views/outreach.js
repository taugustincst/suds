import { h, route, get, post, state, toast, can, pageHead, prefs, fmt, listEntries, emptyState, stat, clear, announce } from '../app.js';

// Street outreach (1.17.0; server/outreach.js, docs/USER_GUIDE.md "Street outreach"). One screen, big targets,
// one hand at 390 px: what kind of contact, what was handed out (− count + for each usual item, any other item
// from the supplies catalog one choice away), where (a coarse place and the site the supplies came from), and a
// line of notes without identifiers. Save logs it as an anonymous visit through POST /api/interventions, so the
// supplies come off the stock by the supply rules, it syncs like any visit, and the reports count it as anonymous
// distribution. On SUDS on this device (and a device that syncs with an office) the kernel answers, so it works
// with no connection. "My shift" below says what this worker has logged since their shift began.
//
// An anonymous contact's SSP participant code (1.17.0, server/participant-code.js), as on the visit form: optional,
// stored encrypted and counted by its blind index; "My shift" counts the different codes as participants seen.
function participantInput() {
  const id = `or-code-${rid()}`;
  const input = h('input', { type: 'text', id, maxlength: 20, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-describedby': `${id}-help`, 'data-outreach-code': '1' });
  const field = h('div', { class: 'field outreach-code' }, h('label', { for: id }, 'Participant code (optional)'), input,
    h('p', { class: 'help small muted', id: `${id}-help` }, 'Only if the person gives one: the code they build the same way every time, by your program\'s recipe. Never a name. Stored encrypted.'));
  return { field, value: () => (input.value.trim() ? { participant_code: input.value.trim() } : {}), reset: () => { input.value = ''; } };
}

const LAST = 'outreach_last'; // the contact type, place and site of this worker's last contact
const SHIFT = 'outreach_shift_start'; // when "Start a new shift" was last pressed (ISO)
export const START_PAGE = 'start_page';
const SHIFT_MS = 36 * 3600 * 1000; // as server/outreach.js: an older start is not this shift
// Shown first, in this order, whether or not the programme marked them usual (then its other usual items).
const FIRST = ['naloxone', 'fentanyl_test_strips', 'xylazine_test_strips', 'syringes', 'wound_care'];
// Counted on the visit when the programme keeps no item for them (as the visit form does): not taken off any stock.
const UNTRACKED = { naloxone: ['naloxone_kits', 'Naloxone kits'], fentanyl_test_strips: ['fentanyl_strips', 'Fentanyl test strips'] };
const rid = () => Math.random().toString(36).slice(2, 7);

function counter(name, unit, { id = `or-${rid()}`, dataset = {} } = {}) {
  const input = h('input', { type: 'number', id, min: 0, max: 1000, step: 1, inputmode: 'numeric', value: '0', class: 'outreach-qty', ...dataset });
  const step = (n) => { input.value = String(Math.max(0, Math.min(1000, (Math.floor(Number(input.value)) || 0) + n))); input.dispatchEvent(new Event('input', { bubbles: true })); };
  const row = h('div', { class: 'outreach-item', 'data-outreach-item': dataset['data-item'] || dataset['data-untracked'] || '' },
    h('label', { for: id }, name, unit ? h('span', { class: 'muted small' }, ` (${unit})`) : null),
    h('div', { class: 'outreach-step' },
      h('button', { type: 'button', class: 'btn outreach-btn', 'aria-label': `One fewer ${name}`, 'data-step': '-1', onClick: () => step(-1) }, '−'),
      input,
      h('button', { type: 'button', class: 'btn outreach-btn', 'aria-label': `One more ${name}`, 'data-step': '1', onClick: () => step(1) }, '+')));
  return { row, input, value: () => Math.max(0, Math.floor(Number(input.value) || 0)), reset: () => { input.value = '0'; } };
}

route('outreach', async () => {
  if (!can('interventions:write')) return emptyState('Not available for your role', 'Street outreach records visits, which your account does not do.', null, { level: 1 });
  const C = state.constants || {};
  let cat = null; try { cat = await get('/api/supplies/catalog', { quiet: true }); } catch { cat = null; }
  const items = cat ? cat.items : [];
  const sites = cat ? cat.sites : [];
  const last = prefs.get(LAST, null) || {};

  // ---- what kind of contact: the services that may be recorded with no client, as the programme words them ----
  const types = listEntries('INTERVENTION_TYPES').filter(e => !e.hidden && (C.CLIENTLESS_INTERVENTION_TYPES || ['outreach', 'naloxone_distribution']).includes(e.code));
  const typeName = `or-type-${rid()}`;
  const chosenType = types.some(t => t.code === last.type) ? last.type : (types[0] && types[0].code);
  const typeGroup = h('fieldset', { class: 'outreach-types', 'data-outreach-types': '1' }, h('legend', {}, 'Contact'),
    types.map(t => h('label', { class: 'outreach-type' }, h('input', { type: 'radio', name: typeName, value: t.code, checked: t.code === chosenType, 'data-contact-type': t.code }), h('span', {}, t.label))));
  const typeValue = () => (typeGroup.querySelector('input:checked') || {}).value || chosenType;

  // ---- what was handed out ----
  const counters = [];
  const list = h('div', { class: 'outreach-items' });
  const shownIds = new Set();
  const addItem = (it, focus = false) => {
    if (shownIds.has(it.id)) return null;
    shownIds.add(it.id);
    const c = counter(it.name, it.unit && it.unit !== 'each' ? it.unit : '', { dataset: { 'data-item': it.id } });
    counters.push({ kind: 'item', item: it, ...c }); list.append(c.row);
    if (focus) c.input.focus();
    return c;
  };
  const byCat = (cat0) => items.filter(i => i.category === cat0).sort((a, b) => (b.quick - a.quick));
  for (const c0 of FIRST) { const first = byCat(c0)[0]; if (first) addItem(first); }
  for (const it of items.filter(i => i.quick)) addItem(it);
  for (const [category, [col, label]] of Object.entries(UNTRACKED)) {
    if (items.some(i => i.category === category)) continue;
    const c = counter(label, 'not taken off stock', { dataset: { 'data-untracked': col } });
    counters.push({ kind: 'untracked', col, ...c }); list.append(c.row);
  }
  const otherSel = h('select', { id: `or-other-${rid()}`, 'data-outreach-other': '1' });
  const refreshOther = () => { const rest = items.filter(i => !shownIds.has(i.id)); otherSel.replaceChildren(h('option', { value: '' }, 'Choose an item…'), ...rest.map(i => h('option', { value: i.id }, i.name))); otherWrap.hidden = !rest.length; };
  const otherWrap = h('div', { class: 'outreach-other' }, h('label', { for: otherSel.id }, 'Another item'), h('div', { class: 'row' }, otherSel,
    h('button', { type: 'button', class: 'btn', 'data-outreach-add': '1', onClick: () => { const it = items.find(i => i.id === otherSel.value); if (it) { const c = addItem(it, true); if (c) { c.input.value = '1'; } refreshOther(); } } }, 'Add')));
  refreshOther();
  const suppliesBox = h('fieldset', { class: 'outreach-supplies', 'data-outreach-supplies': '1' }, h('legend', {}, 'Supplies given'), list, otherWrap,
    !items.length ? h('p', { class: 'small muted' }, 'The program keeps no supply items yet: naloxone kits and test strips are counted on the contact, not taken off any stock. A supervisor adds items under Supplies.') : null);

  // ---- where: a coarse place, and the site the supplies came from ----
  const remote = C.REMOTE_LOCATIONS || ['phone', 'telehealth'];
  const places = listEntries('LOCATIONS').filter(e => !e.hidden && !remote.includes(e.code));
  const placeDefault = places.some(p => p.code === last.location) ? last.location : places.some(p => p.code === C.DEFAULT_LOCATION) ? C.DEFAULT_LOCATION : places.some(p => p.code === 'street') ? 'street' : (places[0] || {}).code;
  const placeSel = h('select', { id: `or-place-${rid()}`, 'data-outreach-place': '1' }, places.map(p => h('option', { value: p.code, selected: p.code === placeDefault }, p.label)));
  const siteDefault = sites.some(s => s.id === last.site) ? last.site : cat && cat.site_id;
  const siteSel = sites.length > 1 ? h('select', { id: `or-site-${rid()}`, 'data-outreach-site': '1' }, sites.map(s => h('option', { value: s.id, selected: s.id === siteDefault }, s.name))) : null;
  const whereBox = h('div', { class: 'outreach-where' },
    h('div', { class: 'field' }, h('label', { for: placeSel.id }, 'Where'), placeSel),
    siteSel ? h('div', { class: 'field' }, h('label', { for: siteSel.id }, 'Supplies came from'), siteSel) : null);

  const participant = participantInput();

  // ---- notes, without identifiers ----
  const notesId = `or-notes-${rid()}`;
  const notes = h('textarea', { id: notesId, rows: 2, maxlength: 280, 'aria-describedby': `${notesId}-help`, 'data-outreach-notes': '1' });
  const notesBox = h('div', { class: 'field outreach-notes' }, h('label', { for: notesId }, 'Notes (optional)'), notes,
    h('p', { class: 'help small muted', id: `${notesId}-help` }, 'No names, nicknames, descriptions or anything else that could identify someone. Say what happened, not who.'));

  // ---- save ----
  const payload = () => {
    const supplies = counters.filter(c => c.kind === 'item' && c.value() > 0).map(c => ({ item_id: c.item.id, quantity: c.value() }));
    const untracked = Object.fromEntries(counters.filter(c => c.kind === 'untracked').map(c => [c.col, c.value()]));
    const site = siteSel ? siteSel.value : (cat && cat.site_id) || null;
    return { type: typeValue(), occurred_at: new Date().toISOString(), location: placeSel.value || null, modality: 'in_person', duration_minutes: 0,
      ...(supplies.length || Object.values(untracked).some(Boolean) ? { supplies } : {}), ...untracked, ...(site ? { supply_site_id: site } : {}),
      ...(notes.value.trim() ? { summary: notes.value.trim() } : {}), ...participant.value() };
  };
  const given = (p) => {
    const parts = counters.filter(c => c.value() > 0).map(c => `${c.value()} ${c.kind === 'item' ? c.item.name : UNTRACKED[Object.keys(UNTRACKED).find(k => UNTRACKED[k][0] === c.col)][1]}`);
    return parts.length ? parts.join(', ') : 'no supplies';
  };
  const saveBtn = h('button', { type: 'submit', class: 'btn primary outreach-save', 'data-outreach-save': '1' }, 'Save contact');
  const errorBox = h('div', { class: 'banner danger hidden', role: 'alert', 'data-outreach-error': '1' });
  const shiftCard = h('section', { class: 'card', 'aria-labelledby': 'outreach-shift-h', 'data-outreach-shift': '1' });
  const formEl = h('form', { class: 'card outreach-form', 'data-outreach-form': '1', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    if (saveBtn.disabled) return;
    errorBox.classList.add('hidden');
    const p = payload(); const what = given(p);
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const r = await post('/api/interventions', p);
      prefs.set(LAST, { type: p.type, location: p.location, site: p.supply_site_id || null });
      for (const c of counters) c.reset();
      notes.value = ''; participant.reset();
      const missed = (r && r.supplies_untracked) || [];
      toast(`Contact saved: ${what}.${missed.length ? ' Not taken off any stock (no item kept for it).' : ''}`, 'ok');
      await drawShift();
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (err) {
      errorBox.textContent = `Not saved: ${err.message || 'something went wrong'}. Nothing was lost: try again.`;
      errorBox.classList.remove('hidden');
    } finally { saveBtn.disabled = false; saveBtn.textContent = 'Save contact'; }
  } },
  typeGroup, participant.field, suppliesBox, whereBox, notesBox, errorBox, saveBtn);

  // ---- my shift ----
  const shiftSince = () => { const s = prefs.get(SHIFT, null); const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) && Date.now() - t < SHIFT_MS && t <= Date.now() ? s : null; };
  async function drawShift() {
    let d;
    try { const since = shiftSince(); d = await get(`/api/outreach/shift${since ? `?since=${encodeURIComponent(since)}` : ''}`, { quiet: true }); }
    catch { clear(shiftCard).append(h('h2', { id: 'outreach-shift-h' }, 'My shift'), h('p', { class: 'muted small' }, 'Could not load your shift just now.')); return; }
    const typeLabel = (t) => fmt.label(t, 'INTERVENTION_TYPES');
    clear(shiftCard).append(
      h('div', { class: 'card-head' }, h('h2', { id: 'outreach-shift-h' }, 'My shift'),
        h('button', { type: 'button', class: 'btn sm', 'data-new-shift': '1', onClick: async () => { prefs.set(SHIFT, new Date().toISOString()); await prefs.flush(); await drawShift(); announce('A new shift started: the counts start again from now.'); } }, 'Start a new shift')),
      h('p', { class: 'small muted', 'data-shift-since': '1' }, `Since ${fmt.dt(d.since)}. Only contacts you logged here.`),
      h('div', { class: 'grid cols-3 outreach-stats' }, stat('Contacts', d.contacts), stat('Naloxone kits', d.naloxone_kits), stat('Test strips', d.fentanyl_strips)),
      d.participants ? h('p', { class: 'small', 'data-shift-participants': '1' }, `${d.participants} different participant code${d.participants === 1 ? '' : 's'} this shift.`) : null,
      d.supplies.length ? h('div', {}, h('h3', { class: 'eyebrow' }, 'Supplies given'), h('ul', { class: 'outreach-list', 'data-shift-supplies': '1' }, d.supplies.map(s => h('li', {}, `${s.item}: ${fmt.num(s.quantity)}${s.unit && s.unit !== 'each' ? ` ${s.unit}` : ''}`)))) : null,
      d.recent.length ? h('div', {}, h('h3', { class: 'eyebrow' }, 'Latest contacts'), h('ul', { class: 'outreach-list', 'data-shift-recent': '1' }, d.recent.map(v => h('li', {},
        h('span', { class: 'nowrap' }, fmt.time(v.occurred_at)), ` · ${typeLabel(v.type)} · ${fmt.label(v.location, 'LOCATIONS')}${v.site ? ` · ${v.site}` : ''}`,
        v.supplies.length ? h('span', { class: 'muted' }, ` · ${v.supplies.map(s => `${s.quantity} ${s.item}`).join(', ')}`) : null)))) : h('p', { class: 'muted small' }, 'No contacts yet this shift.'));
  }
  await drawShift();

  // ---- start page ----
  const startId = `or-start-${rid()}`;
  const startBox = h('label', { class: 'check small', for: startId, 'data-outreach-start': '1' },
    h('input', { type: 'checkbox', id: startId, checked: prefs.get(START_PAGE, null) === 'outreach', onChange: (e) => { prefs.set(START_PAGE, e.target.checked ? 'outreach' : null); toast(e.target.checked ? 'SUDS will open on Street outreach when you sign in' : 'SUDS will open on Home when you sign in', 'ok'); } }),
    'Open SUDS on this screen when I sign in');

  return h('div', { class: 'outreach', 'data-outreach': '1' },
    pageHead('Street outreach'),
    h('p', { class: 'small muted outreach-intro' }, 'Anonymous: no names or client records. Each contact is saved as an anonymous visit, and its supplies come off the stock.',
      state.local ? (window.SUDS_STATIC_HOST ? ' Works with no connection.' : ' Works with no connection: the office gets it at the next sync.') : ''),
    formEl, shiftCard, h('div', { class: 'outreach-foot' }, startBox, h('a', { href: '#/interventions?type=outreach' }, 'All outreach visits')));
});

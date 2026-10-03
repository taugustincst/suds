import { h, route, get, post, del, state, toast, undoToast, can, pageHead, prefs, fmt, listEntries, emptyState, stat, clear, announce, newIdempotencyKey, confirmDialog, render } from '../app.js';
import * as Q from '../outreach-queue.js';

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
// Participant-code mode (1.21.0, the programme's "Outreach records use a participant code by default"): the code is
// asked for first, right under the kind of contact, and the intro says no name is needed.
function participantInput(codeFirst = false) {
  const id = `or-code-${rid()}`;
  const input = h('input', { type: 'text', id, maxlength: 20, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-describedby': `${id}-help`, 'data-outreach-code': '1' });
  const field = h('div', { class: 'field outreach-code', 'data-code-first': codeFirst ? '1' : null }, h('label', { for: id }, codeFirst ? 'Participant code' : 'Participant code (optional)'), input,
    h('p', { class: 'help small muted', id: `${id}-help` }, 'Only if the person gives one: the code they build the same way every time, by your program\'s recipe. Never a name. Letters and digits count; spaces and dashes are dropped. Stored encrypted.'));
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
// "3 Naloxone kits", "1 Naloxone kit", "10 Syringe 1 mL": the last word of an item's name or unit takes a plural
// when it is an ordinary word (a unit such as "mL" or a name ending in a number is left as it is).
export function plural(n, name) {
  const s = String(name || '');
  if (Number(n) === 1) return s;
  const m = /^(.*?)([A-Za-z][a-z]+)$/.exec(s);
  if (!m) return s;
  const [, head, w] = m;
  if (/(s|x|z|ch|sh)$/.test(w)) return /s$/.test(w) ? s : `${head}${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${head}${w.slice(0, -1)}ies`;
  return `${head}${w}s`;
}
const counted = (n, name) => `${fmt.num(n)} ${plural(n, name)}`;

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
  // "Same as last contact" (1.22.0): a peer handing out the same bundle all shift (a kit and two strips) fills the
  // counts in one tap instead of five. What is kept is the items and how many (prefs LAST.given: item ids or the
  // untracked count's column, never anything about the person); the button says what it will fill in, and an item
  // added with "Another item" last time comes back as a row of its own.
  const lastGiven = () => { const g = (prefs.get(LAST, null) || {}).given; return g && typeof g === 'object' ? Object.entries(g).filter(([, n]) => Number.isInteger(n) && n > 0 && n <= 1000) : []; };
  const givenName = (key) => { const it = items.find(i => i.id === key); if (it) return it.name; const u = Object.values(UNTRACKED).find(([col]) => col === key); return u ? u[1].replace(/s$/, '') : null; };
  const sameBtn = h('button', { type: 'button', class: 'btn outreach-same', 'data-outreach-same': '1', onClick: () => {
    const g = lastGiven(); if (!g.length) return;
    for (const c of counters) c.reset();
    for (const [key, n] of g) {
      let c = counters.find(x => (x.kind === 'item' ? x.item.id : x.col) === key);
      if (!c) { const it = items.find(i => i.id === key); if (it) { addItem(it); refreshOther(); c = counters.find(x => x.kind === 'item' && x.item.id === key); } }
      if (c) c.input.value = String(n);
    }
    announce(`Filled in as your last contact: ${sameText(g)}.`);
  } });
  const sameText = (g) => g.map(([k, n]) => (givenName(k) ? counted(n, givenName(k)) : null)).filter(Boolean).join(', ');
  const drawSame = () => { const g = lastGiven().filter(([k]) => givenName(k)); sameBtn.hidden = !g.length; sameBtn.textContent = g.length ? `↻ Same as last contact: ${sameText(g)}` : ''; };
  drawSame();
  const suppliesBox = h('fieldset', { class: 'outreach-supplies', 'data-outreach-supplies': '1' }, h('legend', {}, 'Supplies given'), sameBtn, list, otherWrap,
    !items.length ? h('p', { class: 'small muted' }, 'The program keeps no supply items yet: naloxone kits and test strips are counted on the contact, not taken off any stock. A supervisor adds items under Supplies.') : null);

  // ---- where: a coarse place, and the site the supplies came from ----
  const remote = C.REMOTE_LOCATIONS || ['phone', 'telehealth'];
  const places = listEntries('LOCATIONS').filter(e => !e.hidden && !remote.includes(e.code));
  // An outreach contact is in the field by definition (r10 M1): the worker's last place here, else the street (or
  // the field), else the first place that is not the office; the program's usual visit location (DEFAULT_LOCATION,
  // the office in most programs) only when nothing else is kept.
  const known = (c) => places.some(p => p.code === c);
  const placeDefault = known(last.location) ? last.location : ['street', 'field', 'community'].find(known)
    || (places.find(p => p.code !== 'office' && p.code !== C.DEFAULT_LOCATION) || {}).code || (known(C.DEFAULT_LOCATION) ? C.DEFAULT_LOCATION : (places[0] || {}).code);
  const placeSel = h('select', { id: `or-place-${rid()}`, 'data-outreach-place': '1', onChange: () => prefs.set(LAST, { ...(prefs.get(LAST, null) || {}), location: placeSel.value }) }, places.map(p => h('option', { value: p.code, selected: p.code === placeDefault }, p.label)));
  const siteDefault = sites.some(s => s.id === last.site) ? last.site : cat && cat.site_id;
  const siteSel = sites.length > 1 ? h('select', { id: `or-site-${rid()}`, 'data-outreach-site': '1' }, sites.map(s => h('option', { value: s.id, selected: s.id === siteDefault }, s.name))) : null;
  const whereBox = h('div', { class: 'outreach-where' },
    h('div', { class: 'field' }, h('label', { for: placeSel.id }, 'Where'), placeSel),
    siteSel ? h('div', { class: 'field' }, h('label', { for: siteSel.id }, 'Supplies came from'), siteSel) : null);

  const codeFirst = !!(state.programme && state.programme.participant_code_default);
  const participant = participantInput(codeFirst);

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
    const parts = counters.filter(c => c.value() > 0).map(c => (c.kind === 'item' ? counted(c.value(), c.item.name) : counted(c.value(), UNTRACKED[Object.keys(UNTRACKED).find(k => UNTRACKED[k][0] === c.col)][1].replace(/s$/, ''))));
    return parts.length ? parts.join(', ') : 'no supplies';
  };
  const saveBtn = h('button', { type: 'submit', class: 'btn primary outreach-save', 'data-outreach-save': '1' }, 'Save contact');
  const errorBox = h('div', { class: 'banner danger hidden', role: 'alert', 'data-outreach-error': '1' });
  const shiftCard = h('section', { class: 'card', 'aria-labelledby': 'outreach-shift-h', 'data-outreach-shift': '1' });
  // Not disabled while it saves (a disabled button drops the keyboard focus to the page, 1.17.1): aria-disabled,
  // and a second press is ignored. After a save the focus goes back to the top of the form (Contact), ready for
  // the next one; after a failure, to what went wrong.
  let saving = false;
  // The submission's Idempotency-Key (1.23.0): one per contact, kept while the form holds the same contact, so the
  // screen's attempt and any later one (Save again, or the waiting list's) are one contact at the office
  // (server/crud.js keyedId). Its time is kept with it: the same contact, sent again, is the same request.
  let pending = null;
  // What the counts were before a save, so the form can be cleared and "Same as last contact" set as a save does.
  const afterSave = (p) => {
    const handed = Object.fromEntries(counters.filter(c => c.value() > 0).map(c => [c.kind === 'item' ? c.item.id : c.col, c.value()]));
    const prevGiven = (prefs.get(LAST, null) || {}).given || null;
    // A contact with nothing handed out keeps the last bundle for "Same as last contact".
    const keep = Object.keys(handed).length ? handed : prevGiven;
    prefs.set(LAST, { type: p.type, location: p.location, site: p.supply_site_id || null, given: keep });
    for (const c of counters) c.reset();
    notes.value = ''; participant.reset();
    drawSame();
    pending = null;
    return prevGiven;
  };
  const typeLabel = (t) => fmt.label(t, 'INTERVENTION_TYPES');
  // No signal: a contact that names nobody waits on the phone (public/outreach-queue.js); one with a participant code
  // or notes is not kept there (no PHI in the office app's browser storage), and the worker may keep it without them.
  async function keepWaiting(p, what) {
    await Q.keep({ key: pending.key, payload: p, what, typeLabel: typeLabel(p.type) });
    afterSave(p);
    const n = (await Q.waiting()).length;
    toast(`No signal: the contact (${what}) is kept on this phone and will be sent when you're back online. ${n} waiting.`, 'ok');
    announce(`No signal. The contact is kept on this phone and will be sent when you are back online. ${n} contact${n === 1 ? '' : 's'} waiting to send.`);
    await drawWaiting();
  }
  const formEl = h('form', { class: 'card outreach-form', 'data-outreach-form': '1', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    if (saving) return;
    errorBox.classList.add('hidden'); errorBox.replaceChildren();
    const p = payload(); const what = given(p);
    const sig = JSON.stringify({ ...p, occurred_at: null });
    if (pending && pending.sig === sig) p.occurred_at = pending.occurred_at;
    else pending = { key: `outreach-${newIdempotencyKey()}`, sig, occurred_at: p.occurred_at };
    saving = true; saveBtn.setAttribute('aria-disabled', 'true'); saveBtn.textContent = 'Saving…';
    let saved = false;
    try {
      const r = await post('/api/interventions', p, { idempotencyKey: pending.key });
      const prevGiven = afterSave(p);
      const missed = (r && r.supplies_untracked) || [];
      const msg = `Contact saved: ${what}.${missed.length ? ' Not taken off any stock (no item kept for it).' : ''}`;
      // Undo for 10 seconds (1.22.0): a contact saved twice, or with the wrong count, is taken back here instead of
      // being hunted for under Visits. Deleting their own visit is what its worker may already do (the supplies go
      // back on the stock, server/rules/interventions.js afterDelete; the deletion is audited). The keyboard focus
      // stays on the form, ready for the next contact. Undo also puts "Same as last contact" back to the bundle
      // before this one (1.23.0), or hides it when there was none: the undone contact's bundle is not offered.
      if (r && r.id) undoToast(msg, async () => {
        await del(`/api/interventions/${r.id}`);
        prefs.set(LAST, { ...(prefs.get(LAST, null) || {}), given: prevGiven });
        drawSame();
        await drawShift(); announce('The contact was taken back: it is not counted, and its supplies are back on the stock.');
      }, { focus: false });
      else toast(msg, 'ok');
      saved = true;
      await drawShift();
    } catch (err) {
      if (err && err.offline && !state.local && await Q.available()) {
        if (!Q.identifies(p)) {
          try { await keepWaiting(p, what); saved = true; } catch { /* storage refused: say so below */ }
        } else {
          // The contact stays in the form; it may be kept without what identifies someone.
          errorBox.append(h('p', {}, h('b', {}, 'No signal. '), 'This contact has a participant code or notes, which SUDS does not keep on a phone. It is still in the form: save it again when you have signal, or keep it on this phone without the code and notes.'),
            h('button', { type: 'button', class: 'btn', 'data-outreach-keep-bare': '1', onClick: async () => {
              notes.value = ''; participant.reset();
              const bare = { ...p }; for (const k of Q.NOT_KEPT) delete bare[k];
              pending = { key: `outreach-${newIdempotencyKey()}`, sig: JSON.stringify({ ...bare, occurred_at: null }), occurred_at: bare.occurred_at };
              errorBox.classList.add('hidden'); errorBox.replaceChildren();
              try { await keepWaiting(bare, what); (typeGroup.querySelector('input:checked') || saveBtn).focus(); }
              catch { errorBox.textContent = err.message; errorBox.classList.remove('hidden'); }
            } }, 'Keep it without the code and notes'));
          errorBox.classList.remove('hidden');
        }
      }
      // An offline failure already says that the entry was kept and to try again (app.js OFFLINE_MESSAGE).
      if (!saved && errorBox.classList.contains('hidden')) {
        errorBox.textContent = err && err.offline ? err.message : `Not saved: ${(err && err.message) || 'something went wrong'}. Nothing was lost: try again.`;
        errorBox.classList.remove('hidden');
      }
    } finally { saving = false; saveBtn.removeAttribute('aria-disabled'); saveBtn.textContent = 'Save contact'; }
    if (saved) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      (typeGroup.querySelector('input:checked') || typeGroup.querySelector('input') || saveBtn).focus({ preventScroll: true });
    } else if (!errorBox.classList.contains('hidden')) {
      errorBox.setAttribute('tabindex', '-1'); errorBox.focus();
    }
  } },
  ...(codeFirst ? [typeGroup, participant.field, whereBox] : [typeGroup, whereBox, participant.field]), suppliesBox, notesBox, errorBox, h('div', { class: 'outreach-savebar', 'data-outreach-savebar': '1' }, saveBtn));

  // ---- waiting to send (1.23.0, public/outreach-queue.js) ----
  // The contacts kept on this phone while there was no signal: when, what, and Discard for one entered by mistake
  // (it is then never sent). Send now tries them all again, including any the office did not accept.
  const waitCard = h('section', { class: 'card outreach-waiting', 'aria-labelledby': 'outreach-wait-h', 'data-outreach-waiting': '0', hidden: true });
  async function drawWaiting() {
    if (state.local) return;
    const w = await Q.waiting();
    waitCard.hidden = !w.length; waitCard.dataset.outreachWaiting = String(w.length);
    if (!w.length) { waitCard.replaceChildren(); return; }
    const sendBtn = h('button', { type: 'button', class: 'btn', 'data-outreach-send-now': '1', onClick: async () => {
      sendBtn.setAttribute('aria-disabled', 'true'); sendBtn.textContent = 'Sending…';
      const r = await Q.flush({ all: true });
      // The session ended while they waited (review of 1.23.0): say so and sign in again, rather than "no signal".
      // They stay on this phone and are sent once the worker has signed in (the header sends them).
      if (r.stopped === 'signin') {
        toast('Your session has ended: sign in again. The waiting contacts stay on this phone and are sent once you have.', 'error');
        state.user = null; render(); return;
      }
      await drawShift();
      if (r.left && !r.sent && !r.failed) toast(r.stopped === 'office' ? 'The office could not take them just now: they stay on this phone. Try again in a moment.' : 'Still no signal: they stay on this phone and go when you are back online.', 'error');
      (waitCard.isConnected && !waitCard.hidden ? waitCard.querySelector('h2') : typeGroup.querySelector('input:checked'))?.focus?.();
    } }, 'Send now');
    waitCard.replaceChildren(
      h('div', { class: 'card-head' }, h('h2', { id: 'outreach-wait-h', tabindex: '-1' }, `Waiting to send (${w.length})`), sendBtn),
      h('p', { class: 'small muted' }, 'Kept on this phone because there was no signal. They are sent by themselves when you are back online, or the next time you sign in, and counted once. They name nobody: no participant code or notes are kept.'),
      h('ul', { class: 'outreach-list', 'data-outreach-waiting-list': '1' }, w.map(x => h('li', { 'data-waiting-key': x.key },
        h('span', { class: 'nowrap' }, fmt.dt(x.payload.occurred_at)), ` · ${x.type_label || typeLabel(x.payload.type)} · ${x.what || 'no supplies'}`,
        x.error ? h('div', { class: 'small', 'data-waiting-error': '1' }, h('b', {}, 'Not accepted: '), x.error) : null,
        h('button', { type: 'button', class: 'btn sm', 'data-outreach-discard': x.key, 'aria-label': `Discard the contact of ${fmt.dt(x.payload.occurred_at)}: ${x.what || 'no supplies'}`, onClick: async () => {
          if (!await confirmDialog('Discard this contact?', `The contact of ${fmt.dt(x.payload.occurred_at)} (${x.what || 'no supplies'}) is removed from this phone and never sent. Its supplies are not taken off the stock.`, { danger: true, okText: 'Discard' })) return;
          await Q.discard(x.key);
          announce('The contact was discarded.');
          (waitCard.hidden ? typeGroup.querySelector('input:checked') : waitCard.querySelector('h2'))?.focus?.();
        } }, 'Discard')))));
  }
  const offWaiting = Q.onChange(() => { if (!waitCard.isConnected && waitCard.dataset.drawn) { offWaiting(); return; } waitCard.dataset.drawn = '1'; drawWaiting(); drawShift(); });
  await drawWaiting();
  waitCard.dataset.drawn = '1';

  // ---- my shift ----
  const shiftSince = () => { const s = prefs.get(SHIFT, null); const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) && Date.now() - t < SHIFT_MS && t <= Date.now() ? s : null; };
  async function drawShift() {
    let d;
    try { const since = shiftSince(); d = await get(`/api/outreach/shift${since ? `?since=${encodeURIComponent(since)}` : ''}`, { quiet: true }); }
    catch { clear(shiftCard).append(h('h2', { id: 'outreach-shift-h' }, 'My shift'), h('p', { class: 'muted small' }, 'Could not load your shift just now.')); return; }
    const typeLabel = (t) => fmt.label(t, 'INTERVENTION_TYPES');
    // Through h(): the DOM's own append writes a null as the text "null" (r10 H1), h() leaves it out.
    clear(shiftCard).append(h('div', { class: 'outreach-shift-body' },
      h('div', { class: 'card-head' }, h('h2', { id: 'outreach-shift-h' }, 'My shift'),
        h('button', { type: 'button', class: 'btn outreach-newshift', 'data-new-shift': '1', onClick: async () => { prefs.set(SHIFT, new Date().toISOString()); await prefs.flush(); await drawShift(); announce('A new shift started: the counts start again from now.'); } }, 'Start a new shift')),
      h('p', { class: 'small muted', 'data-shift-since': '1' }, `Since ${fmt.dt(d.since)}. Only contacts you logged here.`),
      h('div', { class: 'grid cols-3 outreach-stats' }, stat('Contacts', d.contacts), stat('Naloxone kits', d.naloxone_kits), stat('Fentanyl test strips', d.fentanyl_strips)),
      d.participants ? h('p', { class: 'small', 'data-shift-participants': '1' }, `${d.participants} different participant code${d.participants === 1 ? '' : 's'} this shift.`) : null,
      d.supplies.length ? h('div', {}, h('h3', { class: 'eyebrow' }, 'Supplies given'), h('ul', { class: 'outreach-list', 'data-shift-supplies': '1' }, d.supplies.map(s => h('li', {}, `${s.item}: ${s.unit && s.unit !== 'each' ? counted(s.quantity, s.unit) : fmt.num(s.quantity)}`)))) : null,
      d.recent.length ? h('div', {}, h('h3', { class: 'eyebrow' }, 'Latest contacts'), h('ul', { class: 'outreach-list', 'data-shift-recent': '1' }, d.recent.map(v => h('li', {},
        h('span', { class: 'nowrap' }, fmt.time(v.occurred_at)), ` · ${typeLabel(v.type)} · ${fmt.label(v.location, 'LOCATIONS')}${v.site ? ` · ${v.site}` : ''}`,
        v.supplies.length ? h('span', { class: 'muted' }, ` · ${v.supplies.map(s => counted(s.quantity, s.item)).join(', ')}`) : null)))) : h('p', { class: 'muted small' }, 'No contacts yet this shift.')));
  }
  await drawShift();

  // ---- start page ----
  const startId = `or-start-${rid()}`;
  const startBox = h('label', { class: 'check small', for: startId, 'data-outreach-start': '1' },
    h('input', { type: 'checkbox', id: startId, checked: prefs.get(START_PAGE, null) === 'outreach', onChange: (e) => { prefs.set(START_PAGE, e.target.checked ? 'outreach' : null); toast(e.target.checked ? 'SUDS will open on Street outreach when you sign in' : 'SUDS will open on Home when you sign in', 'ok'); } }),
    'Open SUDS on this screen when I sign in');

  return h('div', { class: 'outreach', 'data-outreach': '1' },
    pageHead('Street outreach'),
    h('p', { class: 'small muted outreach-intro' }, codeFirst ? 'No names: ask for the person\'s participant code instead. Each contact is saved as an anonymous visit, and its supplies come off the stock.' : 'Anonymous: no names or client records. Each contact is saved as an anonymous visit, and its supplies come off the stock.',
      state.local ? (window.SUDS_STATIC_HOST ? ' Works with no connection.' : ' Works with no connection: the office gets it at the next sync.') : ' With no signal, a contact with no participant code or notes is kept on this phone and sent when you are back online.'),
    formEl, waitCard, shiftCard, h('div', { class: 'outreach-foot' }, startBox, h('a', { href: '#/interventions?type=outreach' }, 'All outreach visits'),
      state.local ? null : h('a', { href: '#/field-phone', 'data-field-phone-link': '1' }, 'Set up this phone for the field')));
});

// ---- Set up this phone for the field (1.23.0; server/field-request.js, docs/USER_GUIDE.md "Street outreach") ----
// For a worker on the office app who needs to work with no signal: what Street outreach already keeps with no
// signal, what a field device is, who decides (a worker may narrow what a phone holds; only an administrator widens
// it), how to set the phone up themselves where the office allows offline copies (the existing enrolment option,
// "Keep only what I need in the field" on This device › Sync), and "Ask my administrator", which gives every
// administrator a to-do to approve it (Settings › Synced devices).
const SCOPE_WORDS = { field: 'Field device: keeps only what you need in the field', full: 'Keeps everything your account may see' };
route('field-phone', async () => {
  if (state.local) {
    return h('div', { 'data-field-phone': 'device' }, pageHead('Set up this phone for the field'),
      h('p', {}, 'This is already an offline copy of SUDS on this phone. What it keeps, and whether it is a field device, is under ', h('a', { href: '#/sync' }, 'This device'), '.'));
  }
  const box = h('div', { 'data-field-phone': '1' });
  async function draw() {
    const st = await get('/api/me/field-device');
    const req = st.request;
    const status = h('div', { role: 'status', 'data-field-request-status': req ? req.status : 'none' },
      req && req.status === 'open' ? h('p', {}, h('b', {}, 'Asked. '), `You asked on ${fmt.dt(req.requested_at)}. Your administrators have a to-do to approve it.`)
        : req && req.status === 'approved' ? (st.local_mode
          ? h('p', {}, h('b', {}, 'Approved. '), `An administrator approved it on ${fmt.dt(req.decided_at)}: every phone you sync is a field device.`)
          // 1.23.1: approved while offline copies are off on the server: nothing works offline yet; say who to ask.
          : h('p', { 'data-field-approved-off': '1' }, h('b', {}, 'Approved, but not ready yet. '), `On ${fmt.dt(req.decided_at)} an administrator set your account as a field account, but your office has not turned on offline copies yet, so this phone cannot keep one. Ask your SUDS administrator (whoever manages Settings › Synced devices) to turn on offline copies on the office server. Until then, Street outreach still keeps contacts that name nobody when you have no signal.`))
          : req && req.status === 'declined' ? h('p', {}, h('b', {}, 'Not approved. '), `An administrator declined it on ${fmt.dt(req.decided_at)}. Ask them why, or ask again.`) : null);
    const askBtn = h('button', { type: 'button', class: 'btn primary', 'data-field-request': '1', onClick: async () => {
      askBtn.setAttribute('aria-disabled', 'true');
      try {
        const r = await post('/api/me/field-device/request', {});
        toast(r.already ? 'You have already asked: your administrators have it on their to-dos.' : 'Asked: your administrators have a to-do to approve it.', 'ok');
        await draw();
        box.querySelector('[data-field-request-status]')?.setAttribute('tabindex', '-1');
        box.querySelector('[data-field-request-status]')?.focus();
      } catch (e) { askBtn.removeAttribute('aria-disabled'); toast(e.message, 'error'); }
    } }, req && req.status === 'declined' ? 'Ask again' : 'Ask my administrator');
    const askable = !req || req.status === 'declined';
    clear(box).append(
      h('section', { class: 'card', 'aria-labelledby': 'fp-now-h' }, h('h2', { id: 'fp-now-h' }, 'With no signal, already'),
        h('p', {}, 'On ', h('a', { href: '#/outreach' }, 'Street outreach'), ', a contact with no participant code or notes is kept on this phone and sent to the office when you are back online, or the next time you sign in. The top of every page says how many are waiting.')),
      h('section', { class: 'card', 'aria-labelledby': 'fp-what-h' }, h('h2', { id: 'fp-what-h' }, 'A field device, for everything else'),
        h('p', {}, 'For your clients, to-dos and every kind of contact with no signal, this phone needs an offline copy of SUDS that keeps only what a field worker needs: your own clients assigned or seen recently (their name, participant code and safety flags), your contacts, your to-dos, supplies and lists. Notes, documents, consents and intake details stay at the office.'),
        // Only what is true here (1.23.2): with offline copies off, the card below says an administrator decides first.
        st.local_mode ? h('p', { 'data-field-who-decides': '1' }, 'Who decides: making a phone a field device narrows what it holds, so you may do it yourself as you set the phone up. Only an administrator can widen a phone back to everything.') : null),
      st.local_mode
        ? h('section', { class: 'card', 'aria-labelledby': 'fp-self-h', 'data-field-self': '1' }, h('h2', { id: 'fp-self-h' }, 'Set it up yourself'),
          h('ol', {},
            h('li', {}, h('a', { href: `${location.pathname}?local=1`, 'data-field-open-copy': '1' }, 'Open the offline copy of SUDS'), ' on this phone, and set it up with a password for this phone.'),
            h('li', {}, 'On ', h('b', {}, 'This device'), ', tick ', h('b', {}, 'Keep only what I need in the field'), ', enter your office username and password, and press ', h('b', {}, 'Sync now'), '.'),
            h('li', {}, 'Sync whenever you have signal; the top of every page says what is still to send.')),
          h('p', { class: 'small muted' }, 'Your administrator sees the phone under Settings › Synced devices. You may also ask them to approve it: then every phone you sync is a field device.'))
        : h('section', { class: 'card', 'aria-labelledby': 'fp-ask-h', 'data-field-ask-only': '1' }, h('h2', { id: 'fp-ask-h' }, 'Ask your administrator'),
          h('p', {}, req && req.status === 'approved' ? 'Your office has not turned on offline copies on phones yet. Only your SUDS administrator can turn them on.'
            : 'Your office has not allowed offline copies on phones, so an administrator decides first. Asking gives every administrator a to-do; you see the answer here.')),
      h('section', { class: 'card', 'aria-labelledby': 'fp-req-h' }, h('h2', { id: 'fp-req-h' }, 'Your request'), status,
        askable ? askBtn : null,
        st.devices.length ? h('div', {}, h('h3', { class: 'eyebrow' }, 'Your synced phones and tablets'),
          h('ul', { class: 'outreach-list', 'data-field-devices': '1' }, st.devices.map(d => h('li', {}, `${d.label || 'Device'} · ${d.revoked ? 'Revoked' : SCOPE_WORDS[d.scope] || d.scope}${d.last_seen_at ? ` · last synced ${fmt.dt(d.last_seen_at)}` : ''}`)))) : null));
  }
  await draw();
  return h('div', {}, pageHead('Set up this phone for the field'), box);
});

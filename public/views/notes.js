import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, kv } from '../app.js';

const SECTIONS = { SOAP: [['S', 'Subjective'], ['O', 'Objective'], ['A', 'Assessment'], ['P', 'Plan']], DAP: [['D', 'Data'], ['A', 'Assessment'], ['P', 'Plan']], BIRP: [['B', 'Behavior'], ['I', 'Intervention'], ['R', 'Response'], ['P', 'Plan']], GIRP: [['G', 'Goal'], ['I', 'Intervention'], ['R', 'Response'], ['P', 'Plan']],
  // Stanley-Brown style safety plan, as a structured note so it prints and reads the same for everyone.
  safety_plan: [['warning_signs', 'Warning signs (thoughts, moods, situations)'], ['coping', 'Coping strategies I can use on my own'], ['distraction', 'People and places that take my mind off things'], ['people_to_ask', 'People I can ask for help'], ['professionals', 'Professionals / agencies I can contact, with phone numbers'], ['environment', 'Making the environment safe (naloxone on hand, not using alone…)'], ['reasons_for_living', 'Reasons for living']] };
const FORMAT_LABELS = { handoff: 'Shift hand-off (for the next worker on)', safety_plan: 'Safety plan (structured)' };
const sectionLabel = (format, key) => (SECTIONS[format] || []).find(([k]) => k === key)?.[1] || key;

export function openNoteForm(values, { clientId, clientDisplay, kind, onDone, prefill } = {}) {
  const C = state.constants; const isNew = !values;
  const kinds = ['admin', 'clinical'].filter(k => can(`notes:${k}:write`));
  let fmtSel, structuredBox, contentArea;
  const f = form([
    { name: 'client_id', label: 'Client', type: 'client', required: true, value: clientId || values?.client_id, display: clientDisplay },
    { name: 'kind', label: 'Note type', type: 'select', options: kinds.map(k => ({ value: k, label: k === 'clinical' ? 'Clinical (restricted to clinical roles)' : 'Administrative / contact' })), value: kind || values?.kind || kinds[0], noBlank: true, required: true },
    { name: 'format', label: 'Format', type: 'select', options: C.NOTE_FORMATS.map(f => ({ value: f, label: FORMAT_LABELS[f] || fmt.label(f) })), value: prefill?.format || 'narrative', noBlank: true }, { name: 'occurred_at', label: 'Date of service', type: 'datetime', required: true, value: values?.occurred_at || new Date().toISOString() },
    { name: 'title', label: 'Title', span: true, value: prefill?.title }, { name: 'content', label: 'Narrative', type: 'textarea', span: true, rows: 10, required: true, value: prefill?.content },
    { name: 'part2_protected', label: 'Contains 42 CFR Part 2 protected SUD information', type: 'checkbox', value: values ? values.part2_protected : true },
    { name: 'cosign_requested', label: 'Request supervisor co-sign / review', type: 'checkbox', help: 'Puts this note in the supervisor queue once it is signed — for a difficult contact, a safety concern, or anything you want a second pair of eyes on.' },
  ], { values: values || {}, submitText: 'Save draft', onCancel: () => m.close(), onSubmit: async (d) => {
    await save(d, true);
    toast('Saved as a draft. Sign it when it is complete.', 'ok'); m.close(); onDone && onDone();
  } });
  // ---- autosave: after a pause in typing the draft is saved to the server, so it can be finished on any device
  let noteId = values?.id || null; let saving = false; let dirty = false; let asTimer;
  const status = h('span', { class: 'autosave' }, isNew ? 'Not saved yet' : 'Saved');
  async function save(d, explicit = false) {
    let data;
    // f.read() now throws for a required field left empty — exactly the state autosave finds this form
    // in constantly while someone is still filling it out (a client picked, nothing typed yet). The
    // explicit "Save draft" button goes through the form's own submit handler, which already turns that
    // into an on-screen error; autosave calls read() directly, so it has to catch that itself and treat
    // it as "not ready to save yet", the same as the client/content check two lines down already did for
    // the same situation before required fields could throw at all.
    if (d) data = d;
    else { try { data = f.read(); } catch { if (explicit) throw new Error('Choose a client and write something first'); return; } }
    const structured = readStructured();
    if (structured) { data.structured = structured; if (!data.content || data.content === autoText) data.content = Object.entries(structured).map(([k, v]) => `${sectionLabel(fmtSel.value, k)}: ${v}`).join('\n\n'); }
    if (!data.client_id || !data.content) { if (explicit) throw new Error('Choose a client and write something first'); return; }
    if (saving) { dirty = true; return; }
    saving = true; status.textContent = 'Saving…';
    try {
      if (!noteId) { const r = await post('/api/notes', data, { quiet: !explicit }); noteId = r.id; }
      else await put(`/api/notes/${noteId}`, data, { quiet: !explicit });
      status.textContent = `Saved ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · continue on any device`;
    } catch (e) { status.textContent = explicit ? '' : 'Not saved yet — will retry'; if (explicit) throw e; }
    finally { saving = false; if (dirty) { dirty = false; save(); } }
  }
  const scheduleSave = () => { clearTimeout(asTimer); status.textContent = 'Unsaved changes'; asTimer = setTimeout(() => save(), 2500); };
  f.addEventListener('input', scheduleSave); f.addEventListener('change', scheduleSave);
  f.querySelector('.btn-row').prepend(status);
  fmtSel = f.inputs.format; contentArea = f.inputs.content;
  structuredBox = h('div', { class: 'span' });
  f.querySelector('[data-field="content"]').before(structuredBox);
  let autoText = '';
  function renderStructured() {
    structuredBox.replaceChildren();
    const secs = SECTIONS[fmtSel.value]; if (!secs) return;
    const vals = values?.structured || {};
    structuredBox.append(h('fieldset', {}, h('legend', {}, fmtSel.value === 'safety_plan' ? 'Safety plan' : `${fmtSel.value} sections`), secs.map(([k, label]) => h('div', { class: 'field' }, h('label', {}, k.length <= 2 ? `${k} — ${label}` : label), h('textarea', { 'data-sec': k, rows: 3 }, vals[k] || '')))));
    structuredBox.querySelectorAll('textarea').forEach(t => t.addEventListener('input', () => { const s = readStructured(); autoText = Object.entries(s).filter(([, v]) => v).map(([k, v]) => `${sectionLabel(fmtSel.value, k)}: ${v}`).join('\n\n'); if (!contentArea.value || contentArea.dataset.auto === '1') { contentArea.value = autoText; contentArea.dataset.auto = '1'; } }));
    contentArea.addEventListener('input', () => { contentArea.dataset.auto = '0'; });
  }
  function readStructured() { const out = {}; let any = false; structuredBox.querySelectorAll('textarea[data-sec]').forEach(t => { out[t.dataset.sec] = t.value; if (t.value.trim()) any = true; }); return any ? out : null; }
  fmtSel.addEventListener('change', renderStructured); renderStructured();
  const m = modal(isNew ? 'New note' : 'Edit draft note', f, { wide: true });
  const origClose = m.close; m.close = () => { clearTimeout(asTimer); if (noteId && onDone) onDone(); origClose(); };
}

export async function openNote(id, { onChange } = {}) {
  let n;
  try { n = (await get(`/api/notes/${id}`)).note; }
  catch (e) {
    if (e.status === 403 && can('notes:clinical:breakglass')) {
      const reason = await confirmDialog('Break-glass access', 'This is a clinical note outside your normal role. Emergency access is permitted only with a documented reason and will be reported to the privacy officer.', { danger: true, okText: 'Access with reason', requireReason: true });
      if (!reason) return; n = (await get(`/api/notes/${id}`, { headers: { 'X-Break-Glass-Reason': reason } })).note;
    } else { toast(e.message, 'error'); return; }
  }
  const mine = n.author_id === state.user.id;
  const writable = can(`notes:${n.kind}:write`);
  const body = h('div', {},
    h('div', { class: 'row mb' }, badge(n.kind === 'clinical' ? 'Clinical' : 'Administrative', n.kind === 'clinical' ? 'purple' : 'info'), badge(fmt.label(n.status), statusKind(n.status)), badge(fmt.label(n.format)), n.source !== 'manual' ? badge(`Imported: ${fmt.label(n.source)}`, 'warn') : null, n.part2_protected ? badge('42 CFR Part 2', 'danger') : null,
      n.cosigned_at ? badge(`Countersigned by ${n.cosigner}`, 'ok') : n.cosign_requested ? badge('Review requested', 'warn') : n.cosign_required ? badge('Needs countersignature', 'warn') : null),
    kv([['Client', h('a', { href: `#/client/${n.client_id}` }, n.client_code || 'view')], ['Date of service', fmt.dt(n.occurred_at)], ['Author', n.author], n.signed_at ? ['Signed', `${fmt.dt(n.signed_at)} by ${n.signer}`] : null, n.signature_hash ? ['Signature hash', h('code', {}, n.signature_hash.slice(0, 16) + '…')] : null, ['Created', fmt.dt(n.created_at)]]),
    n.structured ? h('div', { class: 'mt' }, Object.entries(n.structured).map(([k, v]) => v ? h('div', { class: 'mb' }, h('b', {}, sectionLabel(n.format, k)), h('div', { style: { whiteSpace: 'pre-wrap' } }, v)) : null)) : h('pre', { class: 'note mt' }, n.content),
    n.structured && n.content ? h('details', { class: 'mt' }, h('summary', { class: 'muted small' }, 'Narrative text'), h('pre', { class: 'note' }, n.content)) : null,
    n.addenda.length ? h('div', { class: 'mt' }, h('h4', {}, 'Addenda'), n.addenda.map(a => h('div', { class: 'list-item' }, h('div', { class: 'small muted' }, `${fmt.dt(a.created_at)} · ${a.author}${a.reason ? ' · ' + a.reason : ''}`), h('div', { style: { whiteSpace: 'pre-wrap' } }, a.content)))) : null,
    h('div', { class: 'btn-row' },
      writable && n.status === 'draft' && (mine || can('clients:all')) ? h('button', { class: 'btn', onClick: () => { m.close(); openNoteForm(n, { onDone: onChange }); } }, 'Edit draft') : null,
      writable && n.status === 'draft' && (mine || can('clients:all')) ? h('button', { class: 'btn danger', onClick: async () => { if (await confirmDialog('Delete draft', 'Delete this draft note?', { danger: true, okText: 'Delete' })) { await del(`/api/notes/${n.id}`); m.close(); onChange && onChange(); } } }, 'Delete draft') : null,
      writable && n.status === 'draft' && (mine || can('clients:all')) ? h('button', { class: 'btn primary', onClick: () => signNote(n, () => { m.close(); onChange && onChange(); }) }, 'Sign & lock') : null,
      writable && n.status !== 'draft' ? h('button', { class: 'btn', onClick: () => addAddendum(n, () => { m.close(); openNote(n.id, { onChange }); onChange && onChange(); }) }, 'Add addendum') : null,
      // A navigator who wants a supervisor's eyes on a note asks for it here; the note goes into the
      // supervision queue once it is signed (immediately, if it already is).
      writable && (mine || can('clients:all')) && !n.cosigned_at && !n.cosign_requested ? h('button', { class: 'btn', 'data-send-supervisor': '1', onClick: async () => {
        try { const r = await post(`/api/notes/${n.id}/request-cosign`, {}); toast(r.awaiting_cosign ? 'Sent to your supervisor for review' : 'Marked for review — it goes to your supervisor once signed', 'ok'); m.close(); openNote(n.id, { onChange }); onChange && onChange(); }
        catch (e) { toast(e.message, 'error'); }
      } }, 'Send to supervisor') : null,
      h('button', { class: 'btn ghost', onClick: () => window.print() }, 'Print')));
  const m = modal(n.title || `${fmt.label(n.format)} note`, body, { wide: true });
}

function signNote(n, done) {
  const f = form([{ name: 'password', label: 'Re-enter your password to sign', type: 'password', required: true }], { submitText: 'Sign note', onCancel: () => m.close(), onSubmit: async (d) => { await post(`/api/notes/${n.id}/sign`, d); toast('Note signed and locked', 'ok'); m.close(); done(); } });
  const m = modal('Electronic signature', h('div', {}, h('p', { class: 'small muted' }, 'By signing you attest that this documentation is accurate and complete. Signed notes cannot be edited or deleted; corrections are made by addendum.'), f));
}
function addAddendum(n, done) {
  const f = form([{ name: 'reason', label: 'Reason (e.g. late entry, correction)' }, { name: 'content', label: 'Addendum', type: 'textarea', required: true, span: true }], { submitText: 'Add addendum', onCancel: () => m.close(), onSubmit: async (d) => { await post(`/api/notes/${n.id}/addenda`, d); toast('Addendum added', 'ok'); m.close(); done(); } });
  const m = modal('Add addendum', f);
}
export function noteTable(rows, { showClient = true, onChange } = {}) {
  // The client code used to be a real <a> inside a cell of a row that is itself a keyboard-focusable
  // "button" (table()'s onRow) — a link nested inside a button, which is invalid and leaves a screen
  // reader announcing the whole row as one control while a second, separately-focusable control sits
  // inside it. The row already opens the note, and the note itself links to the client without any such
  // nesting, so here the client code is a plain (mouse-only) shortcut rather than its own control.
  return table([
    { label: 'Date of service', render: n => h('span', { class: 'nowrap' }, fmt.dt(n.occurred_at)) }, showClient ? { label: 'Client', render: n => h('span', { class: 'link-like', onClick: (e) => { e.stopPropagation(); nav(`client/${n.client_id}`); } }, n.client_code) } : null,
    { label: 'Type', render: n => badge(n.kind === 'clinical' ? 'Clinical' : 'Admin', n.kind === 'clinical' ? 'purple' : 'info') }, { label: 'Format', render: n => fmt.label(n.format) }, { label: 'Title', render: n => n.title || h('span', { class: 'muted' }, '(untitled)') },
    { label: 'Status', render: n => [badge(fmt.label(n.status), statusKind(n.status)), n.addenda ? [' ', badge(`${n.addenda} addend.`)] : null, n.cosigned_at ? [' ', badge('Countersigned', 'ok')] : n.awaiting_cosign ? [' ', badge('Awaiting review', 'warn')] : n.cosign_requested ? [' ', badge('Review requested', 'warn')] : null] }, { label: 'Source', render: n => n.source === 'manual' ? '' : badge(fmt.label(n.source), 'warn') }, { label: 'Author', key: 'author' },
  ].filter(Boolean), rows, { onRow: n => openNote(n.id, { onChange }), empty: 'No notes yet. Notes save as drafts automatically while you type, and you sign them when they are complete.' });
}
route('notes', async (r) => {
  const status = r.query.get('status') || '', kind = r.query.get('kind') || '', mine = r.query.get('mine') === '1';
  const qs = `limit=300${status ? '&status=' + status : ''}${kind ? '&kind=' + kind : ''}${mine ? '&mine=1' : ''}`;
  const data = await get(`/api/notes?${qs}`);
  const refresh = () => nav(`notes?status=${status}&kind=${kind}${mine ? '&mine=1' : ''}&_=${Date.now()}`);
  // #/notes/<id> (the supervision queue's rows link here) opens that note over the list instead of
  // silently showing the unfiltered list and leaving the reader to hunt for it.
  if (r.id) setTimeout(() => openNote(r.id, { onChange: refresh }), 0);
  const sSel = h('select', { onChange: () => nav(`notes?status=${sSel.value}&kind=${kind}${mine ? '&mine=1' : ''}`) }, [['', 'Any status'], ['draft', 'Unsigned drafts'], ['signed', 'Signed'], ['amended', 'Amended']].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  const kSel = h('select', { onChange: () => nav(`notes?status=${status}&kind=${kSel.value}${mine ? '&mine=1' : ''}`) }, [['', 'All types'], ['admin', 'Administrative'], ['clinical', 'Clinical']].map(([v, l]) => h('option', { value: v, selected: v === kind }, l)));
  return h('div', {},
    pageHead('Notes', (can('notes:admin:write') || can('notes:clinical:write')) ? h('button', { class: 'btn primary', onClick: () => openNoteForm(null, { onDone: refresh }) }, '+ New note') : null, can('imports:write') ? h('a', { class: 'btn', href: '#/imports' }, 'Import from Pocket AI / OneNote') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Status'), sSel), h('div', { class: 'field' }, h('label', {}, 'Type'), kSel), h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => nav(`notes?status=${status}&kind=${kind}${mine ? '' : '&mine=1'}`) }, 'My notes')),
    !can('notes:clinical:read') ? h('div', { class: 'banner small' }, 'Clinical notes are visible only to clinical roles and supervisors.') : null,
    h('div', { class: 'muted small mb' }, `${data.total} notes`), noteTable(data.rows, { onChange: refresh }));
});

import { h, route, get, pagedList, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, kv } from '../app.js';
import { problemPicker } from './clinical.js';

const SECTIONS = { SOAP: [['S', 'Subjective'], ['O', 'Objective'], ['A', 'Assessment'], ['P', 'Plan']], DAP: [['D', 'Data'], ['A', 'Assessment'], ['P', 'Plan']], BIRP: [['B', 'Behavior'], ['I', 'Intervention'], ['R', 'Response'], ['P', 'Plan']], GIRP: [['G', 'Goal'], ['I', 'Intervention'], ['R', 'Response'], ['P', 'Plan']],
  // Stanley-Brown style safety plan, as a structured note so it prints and reads the same for everyone.
  safety_plan: [['warning_signs', 'Warning signs (thoughts, moods, situations)'], ['coping', 'Coping strategies I can use on my own'], ['distraction', 'People and places that take my mind off things'], ['people_to_ask', 'People I can ask for help'], ['professionals', 'Professionals / agencies I can contact, with phone numbers'], ['environment', 'Making the environment safe (naloxone on hand, not using alone…)'], ['reasons_for_living', 'Reasons for living']] };
// Formats and their wording are a documentation list (Settings → Lists; server/options.js has the built-in wording).
const sectionLabel = (format, key) => (SECTIONS[format] || []).find(([k]) => k === key)?.[1] || key;

export function openNoteForm(values, { clientId, clientDisplay, kind, onDone, prefill } = {}) {
  const C = state.constants; const isNew = !values;
  const kinds = ['admin', 'clinical'].filter(k => can(`notes:${k}:write`));
  let fmtSel, structuredBox, contentArea;
  const f = form([
    { name: 'client_id', label: 'Client', type: 'client', required: true, value: clientId || values?.client_id, display: clientDisplay },
    { name: 'kind', label: 'Note type', type: 'select', options: kinds.map(k => ({ value: k, label: k === 'clinical' ? 'Clinical (restricted to clinical roles)' : 'Administrative / contact' })), value: kind || values?.kind || kinds[0], noBlank: true, required: true },
    { name: 'format', label: 'Format', type: 'select', list: 'NOTE_FORMATS', value: prefill?.format || 'narrative', noBlank: true }, { name: 'occurred_at', label: 'Date of service', type: 'datetime', required: true, value: values?.occurred_at || new Date().toISOString() },
    { name: 'title', label: 'Title', span: true, value: prefill?.title }, { name: 'content', label: 'Narrative', type: 'textarea', span: true, rows: 10, required: true, value: prefill?.content },
    { name: 'part2_protected', label: 'Contains 42 CFR Part 2 protected SUD information', type: 'checkbox', value: values ? values.part2_protected : true },
    // 42 CFR §2.11: a clinician's own analysis of a counselling session, kept apart from the rest of the record
    // and disclosed only under a consent for counseling notes alone. Only clinical notes can be one.
    ...(can('notes:clinical:write') ? [{ name: 'counseling_note', label: 'SUD counseling note (§2.11) — needs its own consent before it can be shared', type: 'checkbox', value: values ? values.counseling_note : false, help: 'Clinical notes only. Not covered by a treatment/payment/operations consent or any general Part 2 consent.' }] : []),
    { name: 'cosign_requested', label: 'Request supervisor co-sign / review', type: 'checkbox', help: 'Puts this note in the supervisor queue once it is signed — for a difficult contact, a safety concern, or anything you want a second pair of eyes on.' },
  ], { values: values || {}, submitText: 'Save draft', onCancel: () => m.close(), onSubmit: async (d) => {
    const andSign = signAfter; signAfter = false;
    await save(d, true);
    // "Save & sign": the signature step opens straight from the editor, over it; the editor closes once the
    // note is signed (or stays, saved, if the signature is cancelled).
    if (andSign && noteId) { signNote({ id: noteId }, () => { m.close(); }); return; }
    toast('Saved as a draft. Sign it when it is complete.', 'ok'); m.close(); onDone && onDone();
  } });
  // Only the author can sign (a supervisor editing someone else's draft countersigns later instead).
  let signAfter = false;
  const maySign = isNew || values.author_id === state.user.id;
  if (maySign) {
    const draftBtn = f.querySelector('.btn-row button[type=submit]');
    draftBtn.addEventListener('click', () => { signAfter = false; });
    draftBtn.after(h('button', { class: 'btn', type: 'submit', 'data-save-sign': '1', onClick: () => { signAfter = true; } }, 'Save & sign'));
  }
  // ---- autosave: after a pause in typing the draft is saved to the server, so it can be finished on any device
  let noteId = values?.id || null; let saving = false; let dirty = false; let asTimer;
  // The version this editor last saved or loaded. Every autosave sends it, so two people with the same draft
  // open cannot keep overwriting each other in turn: the one whose copy is out of date is told to reload.
  let version = values?.updated_at || null; let stale = false;
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
    // The problems ticked, once the list has loaded (never an empty list sent by a form that could not load it).
    if (problemBox.loaded) data.problem_ids = problemBox.read();
    if (structured) { data.structured = structured; if (!data.content || data.content === autoText) data.content = Object.entries(structured).map(([k, v]) => `${sectionLabel(fmtSel.value, k)}: ${v}`).join('\n\n'); }
    if (!data.client_id || !data.content) { if (explicit) throw new Error('Choose a client and write something first'); return; }
    if (saving) { dirty = true; return; }
    if (stale && !explicit) return;
    saving = true; status.textContent = 'Saving…';
    try {
      if (!noteId) { const r = await post('/api/notes', data, { quiet: !explicit }); noteId = r.id; version = r.updated_at || null; }
      else { const r = await put(`/api/notes/${noteId}`, { ...data, if_updated_at: version || undefined }, { quiet: !explicit }); if (r && r.updated_at) version = r.updated_at; }
      status.textContent = `Saved ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · continue on any device`;
    } catch (e) {
      // Changed elsewhere since this editor loaded it: retrying would never succeed, so stop autosaving and
      // say why (the explicit Save shows the same message with a Reload button).
      if (e.status === 409 && e.data && e.data.stale) { stale = true; status.textContent = e.message; if (explicit) throw e; return; }
      status.textContent = explicit ? '' : 'Not saved yet — will retry'; if (explicit) throw e;
    }
    finally { saving = false; if (dirty) { dirty = false; save(); } }
  }
  const scheduleSave = () => { clearTimeout(asTimer); status.textContent = 'Unsaved changes'; asTimer = setTimeout(() => save(), 2500); };
  f.addEventListener('input', scheduleSave); f.addEventListener('change', scheduleSave);
  f.querySelector('.btn-row').prepend(status);
  // CalAIM: which problem-list entries this note addresses.
  let linkedIds = []; try { linkedIds = values?.problem_ids ? JSON.parse(values.problem_ids) : (values?.problems || []).map(p => p.id); } catch { linkedIds = []; }
  const problemBox = problemPicker(Array.isArray(linkedIds) ? linkedIds : []);
  f.querySelector('[data-field="part2_protected"]').before(problemBox);
  let problemClient = clientId || values?.client_id || null;
  problemBox.load(problemClient);
  // A client picked from the search list sets a hidden value without a change event, so a click is checked too.
  const followClient = () => setTimeout(() => { const cid = f.inputs.client_id?.value || null; if (cid && cid !== problemClient) { problemClient = cid; problemBox.reset(); problemBox.load(cid); } }, 0);
  f.addEventListener('change', followClient); f.addEventListener('click', followClient);
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

// Re-computes the signature over the note as it is stored now (GET /api/notes/:id/verify) and says in plain
// words whether it still matches what was signed. The hash is evidence; this is the answer to "was it changed?".
function verifyPanel(n, breakGlass) {
  const out = h('div', { class: 'sig-verify-result', role: 'status', 'aria-live': 'polite' });
  const line = (good, text) => h('div', { class: 'row', style: { gap: '.4rem', alignItems: 'center' } }, badge(good ? 'Signature intact' : 'Changed after signing', good ? 'ok' : 'danger'), h('span', { class: 'small muted' }, text));
  const btn = h('button', { class: 'btn sm', 'data-verify-signature': '1', onClick: async () => {
    btn.disabled = true; out.replaceChildren(h('span', { class: 'small muted' }, 'Checking…'));
    try {
      const v = await get(`/api/notes/${n.id}/verify`, breakGlass ? { headers: { 'X-Break-Glass-Reason': breakGlass } } : undefined);
      out.replaceChildren(
        line(v.intact, v.intact ? `The note is exactly as ${v.signer || 'the signer'} signed it${v.signed_at ? ` on ${fmt.dt(v.signed_at)}` : ''}.` : 'The stored note no longer matches its signature. Report this to your privacy officer.'),
        v.cosignature_intact === undefined ? null : line(v.cosignature_intact, v.cosignature_intact ? `Countersignature by ${v.cosigner || 'the supervisor'} also matches.` : 'The countersignature no longer matches.'));
    } catch (e) { out.replaceChildren(h('span', { class: 'err' }, e.message || 'Could not check the signature')); }
    finally { btn.disabled = false; }
  } }, 'Verify signature');
  return h('div', { class: 'mt row', style: { gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' } }, btn, out);
}

export async function openNote(id, { onChange } = {}) {
  let n; let breakGlass = null;
  try { n = (await get(`/api/notes/${id}`)).note; }
  catch (e) {
    if (e.status === 403 && can('notes:clinical:breakglass')) {
      const reason = await confirmDialog('Break-glass access', 'This is a clinical note outside your normal role. Emergency access is permitted only with a documented reason and will be reported to the privacy officer.', { danger: true, okText: 'Access with reason', requireReason: true });
      if (!reason) return; breakGlass = reason; n = (await get(`/api/notes/${id}`, { headers: { 'X-Break-Glass-Reason': reason } })).note;
    } else { toast(e.message, 'error'); return; }
  }
  const mine = n.author_id === state.user.id;
  const writable = can(`notes:${n.kind}:write`);
  const body = h('div', {},
    h('div', { class: 'row mb' }, badge(n.kind === 'clinical' ? 'Clinical' : 'Administrative', n.kind === 'clinical' ? 'purple' : 'info'), badge(fmt.label(n.status), statusKind(n.status)), badge(fmt.label(n.format, 'NOTE_FORMATS')), n.source !== 'manual' ? badge(`Imported: ${fmt.label(n.source)}`, 'warn') : null, n.part2_protected ? badge('42 CFR Part 2', 'danger') : null, n.counseling_note ? h('span', { 'data-counseling-note': '1' }, badge('SUD counseling note', 'purple')) : null,
      n.cosigned_at ? badge(`Countersigned by ${n.cosigner}`, 'ok') : n.cosign_requested ? badge('Review requested', 'warn') : n.cosign_required ? badge('Needs countersignature', 'warn') : null),
    // On paper the label travels with the page (42 CFR §2.32(a)(2)).
    n.part2_protected && state.constants?.PART2_NOTICE_SHORT ? h('div', { class: 'print-only small', 'data-part2-print': '1' }, `Protected by 42 CFR Part 2. ${state.constants.PART2_NOTICE_SHORT}`) : null,
    kv([['Client', h('a', { href: `#/client/${n.client_id}` }, n.client_code || 'view')], ['Date of service', fmt.dt(n.occurred_at)], ['Author', n.author], n.signed_at ? ['Signed', `${fmt.dt(n.signed_at)} by ${n.signer}`] : null, n.signature_hash ? ['Signature hash', h('details', { class: 'sig-hash' }, h('summary', {}, h('code', {}, n.signature_hash.slice(0, 16) + '…'), ' ', h('span', { class: 'small muted' }, 'show full')), h('code', { class: 'sig-hash-full', style: { wordBreak: 'break-all' } }, n.signature_hash))] : null, ['Created', fmt.dt(n.created_at)]]),
    n.signature_hash ? verifyPanel(n, breakGlass) : null,
    n.problems && n.problems.length ? h('div', { class: 'small mt', 'data-note-problems-view': '1' }, h('b', {}, 'Addresses: '), n.problems.map(p => p.problem || 'a problem on the list').join('; ')) : null,
    n.structured ? h('div', { class: 'mt' }, Object.entries(n.structured).map(([k, v]) => v ? h('div', { class: 'mb' }, h('b', {}, sectionLabel(n.format, k)), h('div', { style: { whiteSpace: 'pre-wrap' } }, v)) : null)) : h('pre', { class: 'note mt' }, n.content),
    n.structured && n.content ? h('details', { class: 'mt' }, h('summary', { class: 'muted small' }, 'Narrative text'), h('pre', { class: 'note' }, n.content)) : null,
    n.addenda.length ? h('div', { class: 'mt' }, h('h3', { class: 'eyebrow' }, 'Addenda'), n.addenda.map(a => h('div', { class: 'list-item' }, h('div', { class: 'small muted' }, `${fmt.dt(a.created_at)} · ${a.author}${a.reason ? ' · ' + a.reason : ''}`), h('div', { style: { whiteSpace: 'pre-wrap' } }, a.content)))) : null,
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
  const m = modal(n.title || `${fmt.label(n.format, 'NOTE_FORMATS')} note`, body, { wide: true });
}

/**
 * The electronic-signature dialog, for a signature and a countersignature alike. Within a few minutes of
 * signing in (or of the last password or code given) it is the attestation and one button; after that it
 * asks for the password — or the authenticator code, with two-step verification on (GET /api/auth/reauth,
 * the same rule the server applies). `send(body)` makes the request; `fields` come before the identity field.
 */
export async function signatureDialog({ title, intro, submitText, send, done, fields = [] }) {
  let st = { recent: false, method: 'password' };
  try { st = await get('/api/auth/reauth', { quiet: true }); } catch { /* ask for the password */ }
  const open = (st, why) => {
    const identity = st.recent ? []
      : st.method === 'totp' ? [{ name: 'code', label: 'Code from your authenticator app', required: true, autocomplete: 'one-time-code', pattern: '[0-9]{6}', help: 'It has been a while since you confirmed it is you.' }]
      : [{ name: 'password', label: 'Re-enter your password to sign', type: 'password', required: true, autocomplete: 'current-password', help: 'It has been a while since you confirmed it is you.' }];
    const f = form([...fields, ...identity], { submitText, onCancel: () => m.close(), onSubmit: async (d) => {
      try { await send(st.recent ? { ...d, confirm: true } : d); }
      catch (e) {
        // The few minutes ran out while the dialog was open: ask again, keeping what was typed.
        if (e.data && e.data.reauthRequired && st.recent) { m.close(); open({ recent: false, method: e.data.method || 'password' }, e.message); return; }
        throw e;
      }
      m.close(); done && done();
    } });
    const m = modal(title, h('div', { 'data-signature-dialog': st.recent ? 'confirm' : st.method },
      why ? h('div', { class: 'banner warn', role: 'status' }, why) : null,
      intro,
      st.recent ? h('p', { class: 'small muted' }, 'You confirmed it is you a few minutes ago, so your password is not needed again.') : null,
      f));
  };
  open(st);
}
function signNote(n, done) {
  return signatureDialog({ title: 'Electronic signature', submitText: 'Sign note',
    intro: h('p', { 'data-attestation': '1' }, 'By signing you attest that this documentation is accurate and complete. Signed notes cannot be edited or deleted; corrections are made by addendum.'),
    send: (body) => post(`/api/notes/${n.id}/sign`, body),
    done: () => { toast('Note signed and locked', 'ok'); done(); } });
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
    { label: 'Type', render: n => badge(n.kind === 'clinical' ? 'Clinical' : 'Admin', n.kind === 'clinical' ? 'purple' : 'info') }, { label: 'Format', render: n => fmt.label(n.format, 'NOTE_FORMATS') }, { label: 'Title', render: n => n.title || h('span', { class: 'muted' }, '(untitled)') },
    { label: 'Status', render: n => [badge(fmt.label(n.status), statusKind(n.status)), n.addenda ? [' ', badge(`${n.addenda} addend.`)] : null, n.cosigned_at ? [' ', badge('Countersigned', 'ok')] : n.awaiting_cosign ? [' ', badge('Awaiting review', 'warn')] : n.cosign_requested ? [' ', badge('Review requested', 'warn')] : null] }, { label: 'Source', render: n => n.source === 'manual' ? '' : badge(fmt.label(n.source), 'warn') }, { label: 'Author', key: 'author' },
  ].filter(Boolean), rows, { onRow: n => openNote(n.id, { onChange }), empty: 'No notes yet. Notes save as drafts automatically while you type, and you sign them when they are complete.' });
}
route('notes', async (r) => {
  const status = r.query.get('status') || '', kind = r.query.get('kind') || '', mine = r.query.get('mine') === '1';
  const qs = `${status ? '&status=' + status : ''}${kind ? '&kind=' + kind : ''}${mine ? '&mine=1' : ''}`.replace(/^&/, '');
  const PAGE = 200;
  const data = await get(`/api/notes?limit=${PAGE}${qs ? '&' + qs : ''}`);
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
    pagedList({ first: data, url: `/api/notes${qs ? '?' + qs : ''}`, limit: PAGE, render: (rows) => noteTable(rows, { onChange: refresh }), summary: (rows, total) => h('div', { class: 'muted small mb' }, `${total} notes`) }));
});

import { h, route, get, pagedList, filterBar, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, kv } from '../app.js';
import { problemPicker } from './clinical.js';
import { noteCopilot, aiDraftBanner, putDraft } from './ai.js';

export const SECTIONS = { SOAP: [['S', 'Subjective'], ['O', 'Objective'], ['A', 'Assessment'], ['P', 'Plan']], DAP: [['D', 'Data'], ['A', 'Assessment'], ['P', 'Plan']], BIRP: [['B', 'Behavior'], ['I', 'Intervention'], ['R', 'Response'], ['P', 'Plan']], GIRP: [['G', 'Goal'], ['I', 'Intervention'], ['R', 'Response'], ['P', 'Plan']],
  // Stanley-Brown style safety plan, as a structured note so it prints and reads the same for everyone.
  safety_plan: [['warning_signs', 'Warning signs (thoughts, moods, situations)'], ['coping', 'Coping strategies I can use on my own'], ['distraction', 'People and places that take my mind off things'], ['people_to_ask', 'People I can ask for help'], ['professionals', 'Professionals / agencies I can contact, with phone numbers'], ['environment', 'Making the environment safe (naloxone on hand, not using alone…)'], ['reasons_for_living', 'Reasons for living']] };
// Formats and their wording are a documentation list (Settings → Lists; server/options.js has the built-in wording).
export const sectionLabel = (format, key) => (SECTIONS[format] || []).find(([k]) => k === key)?.[1] || key;

export function openNoteForm(values, { clientId, clientDisplay, kind, onDone, prefill } = {}) {
  const C = state.constants; const isNew = !values;
  const kinds = ['admin', 'clinical'].filter(k => can(`notes:${k}:write`));
  let fmtSel, structuredBox, contentArea;
  // Required only for a narrative note: with SOAP, DAP, BIRP, GIRP or a safety plan it is built from the sections, and
  // folds away under them rather than asking for everything twice (r8 L7).
  const narrative = { name: 'content', label: 'Narrative', type: 'textarea', span: true, rows: 10, required: true, value: prefill?.content };
  const f = form([
    { name: 'client_id', label: 'Client', type: 'client', required: true, value: clientId || values?.client_id, display: clientDisplay },
    { name: 'kind', label: 'Note type', type: 'select', options: kinds.map(k => ({ value: k, label: k === 'clinical' ? 'Clinical (not shown to finance or read-only)' : 'Administrative / contact' })), value: kind || values?.kind || (kinds.includes('clinical') ? 'clinical' : kinds[0]), noBlank: true, required: true }, // clinical for those who write it (r8 L8)
    { name: 'format', label: 'Format', type: 'select', list: 'NOTE_FORMATS', value: prefill?.format || 'narrative', noBlank: true }, { name: 'occurred_at', label: 'Date of service', type: 'datetime', required: true, value: values?.occurred_at || new Date().toISOString() },
    { name: 'title', label: 'Title', span: true, value: prefill?.title }, narrative,
    { name: 'part2_protected', label: 'Contains 42 CFR Part 2 protected SUD information', type: 'checkbox', value: values ? values.part2_protected : true },
    // 42 CFR §2.11: a clinician's own analysis of a counselling session, kept apart from the rest of the record
    // and disclosed only under a consent for counseling notes alone. Only clinical notes can be one.
    ...(can('notes:clinical:write') ? [{ name: 'counseling_note', label: 'SUD counseling note (§2.11) — needs its own consent before it can be shared', type: 'checkbox', value: values ? values.counseling_note : false, help: 'Clinical notes only. Read only by you, a co-signer and clinical staff (not navigators). Not covered by a treatment/payment/operations consent or any general Part 2 consent.' }] : []),
    { name: 'cosign_requested', label: 'Request supervisor co-sign / review', type: 'checkbox', help: 'Puts this note in the supervisor queue once it is signed — for a difficult contact, a safety concern, or anything you want a second pair of eyes on.' },
  ], { values: values || {}, submitText: 'Save draft', onCancel: () => m.close(), onSubmit: async (d) => {
    const andSign = signAfter; signAfter = false;
    await save(d, true);
    // "Save & sign": the signature step opens straight from the editor, over it; the editor closes once the
    // note is signed (or stays, saved, if the signature is cancelled).
    // A cancelled signature leaves the saved draft: say so, or it turns up in Unsigned notes as a surprise (r9 L3).
    if (andSign && noteId) { signNote({ id: noteId, ai_assisted: aiAssisted }, () => { m.close(); }, { onCancel: () => toast('Not signed: the note is saved as a draft. Sign it when it is complete.', 'ok') }); return; }
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
    // Text the AI copilot drafted is in this note: it is marked AI-assisted, for good (docs/AI-COPILOT.md).
    if (aiAssisted) data.ai_assisted = true;
    if (structured) { data.structured = structured; if (!data.content || data.content === autoText) data.content = Object.entries(structured).map(([k, v]) => `${sectionLabel(fmtSel.value, k)}: ${v}`).join('\n\n'); }
    if (!data.client_id || !data.content) { if (explicit) throw new Error('Choose a client and write something first'); return; }
    if (saving) { dirty = true; return; }
    if (stale && !explicit) return;
    saving = true; status.textContent = 'Saving…';
    try {
      if (!noteId) { const r = await post('/api/notes', data, { quiet: !explicit }); noteId = r.id; version = r.updated_at || null; }
      else { const r = await put(`/api/notes/${noteId}`, { ...data, if_updated_at: version || undefined }, { quiet: !explicit }); if (r && r.updated_at) version = r.updated_at; }
      if (data.ai_assisted) aiAssistedSaved = true;
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
  const contentField = f.querySelector('[data-field="content"]');
  const builtBox = h('details', { class: 'span section', 'data-narrative-built': '1' }, h('summary', {}, 'Narrative text (built from the sections)'));
  function foldNarrative(built) {
    narrative.required = !built; contentArea.required = !built;
    if (built) contentArea.removeAttribute('aria-required'); else contentArea.setAttribute('aria-required', 'true');
    const lab = contentField.querySelector('label'); if (lab) lab.textContent = built ? 'Narrative' : 'Narrative *';
    if (built && !builtBox.contains(contentField)) { contentField.replaceWith(builtBox); builtBox.append(contentField); }
    else if (!built && builtBox.isConnected) builtBox.replaceWith(contentField);
  }
  function renderStructured() {
    structuredBox.replaceChildren();
    const secs = SECTIONS[fmtSel.value]; foldNarrative(!!secs); if (!secs) return;
    const vals = values?.structured || {};
    structuredBox.append(h('fieldset', {}, h('legend', {}, fmtSel.value === 'safety_plan' ? 'Safety plan' : `${fmtSel.value} sections`), secs.map(([k, label]) => h('div', { class: 'field' }, h('label', {}, k.length <= 2 ? `${k} — ${label}` : label), h('textarea', { 'data-sec': k, rows: 3 }, vals[k] || '')))));
    // A draft whose narrative is still the one built from its sections goes on being built from them, folded away.
    const now = readStructured() || {}; const texts = [false, true].map(all => Object.entries(now).filter(([, v]) => all || v).map(([k, v]) => `${sectionLabel(fmtSel.value, k)}: ${v}`).join('\n\n'));
    if (!contentArea.value || texts.includes(contentArea.value)) contentArea.dataset.auto = '1';
    structuredBox.querySelectorAll('textarea').forEach(t => t.addEventListener('input', () => { const s = readStructured() || {}; autoText = Object.entries(s).filter(([, v]) => v).map(([k, v]) => `${sectionLabel(fmtSel.value, k)}: ${v}`).join('\n\n'); if (!contentArea.value || contentArea.dataset.auto === '1') { contentArea.value = autoText; contentArea.dataset.auto = '1'; } }));
    contentArea.addEventListener('input', () => { contentArea.dataset.auto = '0'; });
  }
  function readStructured() { const out = {}; let any = false; structuredBox.querySelectorAll('textarea[data-sec]').forEach(t => { out[t.dataset.sec] = t.value; if (t.value.trim()) any = true; }); return any ? out : null; }
  fmtSel.addEventListener('change', renderStructured); renderStructured();
  // ---- the AI copilot (views/ai.js): a draft from the author's own session notes, put into the sections
  // above for them to review, marked "AI draft — review before signing"; signing asks for the review statement.
  // A section the author already wrote in is never replaced unless they choose to (putDraft), and Undo on the
  // banner takes the draft out again.
  let aiAssisted = !!(values && Number(values.ai_assisted)); let aiBanner = null;
  let aiAssistedSaved = aiAssisted; // the server keeps AI-assisted for good once a save has carried it
  const showAiBanner = (b) => { if (aiBanner) aiBanner.remove(); aiBanner = b; if (b) structuredBox.before(b); };
  if (aiAssisted) showAiBanner(aiDraftBanner({}));
  const copilot = noteCopilot({
    read: () => ({ client_id: f.inputs.client_id?.value || null, kind: f.inputs.kind.value, format: fmtSel.value, note_id: noteId, counseling_note: !!f.inputs.counseling_note?.checked }),
    apply: async (r, ask) => {
      if (r.structured && fmtSel.value !== r.format) { fmtSel.value = r.format; renderStructured(); }
      const targets = r.structured
        ? [...structuredBox.querySelectorAll('textarea[data-sec]')].map(t => ({ el: t, label: t.dataset.sec.length <= 2 ? `${t.dataset.sec} (${sectionLabel(fmtSel.value, t.dataset.sec)})` : sectionLabel(fmtSel.value, t.dataset.sec), text: r.draft.sections[t.dataset.sec] }))
        : [{ el: contentArea, label: 'the narrative', text: r.draft.narrative, after: () => { contentArea.dataset.auto = '0'; } }];
      const done = await putDraft(targets, ask);
      if (!done) return null;
      const wasAssisted = aiAssisted;
      aiAssisted = true; syncCounseling();
      const banner = aiDraftBanner({ gaps: r.gaps, counts: r.identifiers_replaced, onUndo: (box) => {
        done.undo();
        if (!aiAssistedSaved) { aiAssisted = wasAssisted; syncCounseling(); }
        const back = h('p', { class: 'banner info span small', 'data-ai-undone': '1' }, aiAssisted
          ? 'The draft was taken out: what you had written is back. The note stays marked AI-assisted, because it was saved with AI-drafted text in it.'
          : 'The draft was taken out: what you had written is back.');
        box.replaceWith(back); aiBanner = back;
        back.setAttribute('tabindex', '-1'); back.focus();
        scheduleSave();
      } });
      showAiBanner(banner);
      scheduleSave();
      return banner;
    },
  });
  if (copilot) (aiBanner || structuredBox).before(copilot);
  // A SUD counseling note (§2.11) is written without the copilot (docs/AI-COPILOT.md): ticking the box hides the
  // panel, and a note that already has copilot text cannot be ticked as one (the server refuses both ways).
  const counselBox = f.inputs.counseling_note;
  const counselHelp = counselBox && h('p', { class: 'small muted', 'data-counseling-ai-note': '1', hidden: true }, 'This note has text drafted by the AI copilot, so it cannot be a SUD counseling note. Write a counseling note yourself, in a new note.');
  if (counselHelp) counselBox.closest('[data-field]').append(counselHelp);
  const syncCounseling = () => {
    if (!counselBox) return;
    if (copilot) copilot.hidden = counselBox.checked;
    counselBox.disabled = aiAssisted && !counselBox.checked;
    counselHelp.hidden = !counselBox.disabled;
  };
  if (counselBox) counselBox.addEventListener('change', syncCounseling);
  syncCounseling();
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
      out.replaceChildren(...[
        line(v.intact, v.intact ? `The note is exactly as ${v.signer || 'the signer'} signed it${v.signed_at ? ` on ${fmt.dt(v.signed_at)}` : ''}.` : 'The stored note no longer matches its signature. Report this to your privacy officer.'),
        v.cosignature_intact === undefined ? null : line(v.cosignature_intact, v.cosignature_intact ? `Countersignature by ${v.cosigner || 'the supervisor'} also matches.` : 'The countersignature no longer matches.')].filter(Boolean));
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
    h('div', { class: 'row mb' }, badge(n.kind === 'clinical' ? 'Clinical' : 'Administrative', n.kind === 'clinical' ? 'purple' : 'info'), badge(fmt.label(n.status), statusKind(n.status)), badge(fmt.label(n.format, 'NOTE_FORMATS')), n.source !== 'manual' ? badge(`Imported: ${fmt.label(n.source)}`, 'warn') : null, Number(n.ai_assisted) ? h('span', { 'data-ai-assisted': '1' }, badge('AI-assisted', 'info')) : null, n.part2_protected ? badge('42 CFR Part 2', 'danger') : null, n.counseling_note ? h('span', { 'data-counseling-note': '1' }, badge('SUD counseling note', 'purple')) : null,
      n.cosigned_at ? badge(`Countersigned by ${n.cosigner}`, 'ok') : n.cosign_requested ? badge('Review requested', 'warn') : n.cosign_required ? badge('Needs countersignature', 'warn') : null),
    // On paper the label travels with the page (42 CFR §2.32(a)(2)).
    n.part2_protected && state.constants?.PART2_NOTICE_SHORT ? h('div', { class: 'print-only small', 'data-part2-print': '1' }, `Protected by 42 CFR Part 2. ${state.constants.PART2_NOTICE_SHORT}`) : null,
    kv([['Client', n.client_id ? h('a', { href: `#/client/${n.client_id}`, 'data-note-client': n.client_code || '' }, n.client_name ? `${n.client_name} (${n.client_code})` : n.client_code ? `Client ${n.client_code}` : 'Open the client record') : null], ['Date of service', fmt.dt(n.occurred_at)], ['Author', n.author], n.signed_at ? ['Signed', `${fmt.dt(n.signed_at)} by ${n.signer}`] : null, n.signature_hash ? ['Signature hash', h('details', { class: 'sig-hash' }, h('summary', {}, h('code', {}, n.signature_hash.slice(0, 16) + '…'), ' ', h('span', { class: 'small muted' }, 'show full')), h('code', { class: 'sig-hash-full', style: { wordBreak: 'break-all' } }, n.signature_hash))] : null, ['Created', fmt.dt(n.created_at)]]),
    n.signature_hash ? verifyPanel(n, breakGlass) : null,
    Number(n.ai_assisted) && n.status === 'draft' ? h('p', { class: 'banner warn small', 'data-ai-draft-banner': '1' }, h('strong', {}, 'AI draft — review before signing. '), 'Some of this note was drafted by the AI copilot. Read it against what happened and correct it before you sign.') : null,
    Number(n.ai_assisted) && n.status !== 'draft' ? h('p', { class: 'small muted', 'data-ai-signed': '1' }, 'Some of this note was drafted with the AI copilot and reviewed by its author before signing.') : null,
    n.problems && n.problems.length ? h('div', { class: 'small mt', 'data-note-problems-view': '1' }, h('b', {}, 'Addresses: '), n.problems.map(p => p.problem || 'a problem on the list').join('; ')) : null,
    n.structured ? h('div', { class: 'mt' }, Object.entries(n.structured).map(([k, v]) => v ? h('div', { class: 'mb' }, h('b', {}, sectionLabel(n.format, k)), h('div', { style: { whiteSpace: 'pre-wrap' } }, v)) : null)) : h('pre', { class: 'note mt' }, n.content),
    n.structured && n.content ? h('details', { class: 'mt' }, h('summary', { class: 'muted small' }, 'Narrative text'), h('pre', { class: 'note' }, n.content)) : null,
    // A colleague's draft shows only Print: say why, and what can be done about it.
    writable && n.status === 'draft' && !mine && !can('records:manage-others') ? h('p', { class: 'banner info small', 'data-owned-notice': '1' }, `Draft by ${n.author || 'another worker'}, not yet signed. Only the author, or a supervisor or administrator, can finish, sign or delete it: send them a reminder or ask a supervisor.`) : null,
    n.addenda.length ? h('div', { class: 'mt' }, h('h3', { class: 'eyebrow' }, 'Addenda'), n.addenda.map(a => h('div', { class: 'list-item' }, h('div', { class: 'small muted' }, `${fmt.dt(a.created_at)} · ${a.author}${a.reason ? ' · ' + a.reason : ''}`), h('div', { style: { whiteSpace: 'pre-wrap' } }, a.content)))) : null,
    h('div', { class: 'btn-row' },
      writable && n.status === 'draft' && (mine || can('records:manage-others')) ? h('button', { class: 'btn', onClick: () => { m.close(); openNoteForm(n, { onDone: onChange }); } }, 'Edit draft') : null,
      writable && n.status === 'draft' && (mine || can('records:manage-others')) ? h('button', { class: 'btn danger', onClick: async () => { if (await confirmDialog('Delete draft', 'Delete this draft note?', { danger: true, okText: 'Delete' })) { await del(`/api/notes/${n.id}`); m.close(); onChange && onChange(); } } }, 'Delete draft') : null,
      writable && n.status === 'draft' && (mine || can('records:manage-others')) ? h('button', { class: 'btn primary', onClick: () => signNote(n, () => { m.close(); onChange && onChange(); }) }, 'Sign & lock') : null,
      writable && n.status !== 'draft' ? h('button', { class: 'btn', onClick: () => addAddendum(n, () => { m.close(); openNote(n.id, { onChange }); onChange && onChange(); }) }, 'Add addendum') : null,
      // A navigator who wants a supervisor's eyes on a note asks for it here; the note goes into the
      // supervision queue once it is signed (immediately, if it already is).
      writable && (mine || can('records:manage-others')) && !n.cosigned_at && !n.cosign_requested ? h('button', { class: 'btn', 'data-send-supervisor': '1', onClick: async () => {
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
 * the same rule the server applies). An account that signs in through single sign-on and has no SUDS
 * password confirms with the identity provider instead (POST /api/auth/oidc/reauth): the browser goes to
 * the county sign-in and comes back to `returnTo` (the note) ready to sign with the confirmation alone.
 * `send(body)` makes the request; `fields` come before the identity field.
 */
// fresh: no "you confirmed a few minutes ago" (the key backup, POST /api/admin/keys-backup): the password or
// code is asked for every time; only a single sign-on confirmation just completed (sso_fresh) stands in for it.
export async function signatureDialog({ title, intro, submitText, send, done, fields = [], returnTo, verb = 'sign', fresh = false, onCancel = null }) {
  let finished = false; // signed, or asking again: not a cancel
  let st = { recent: false, method: 'password' };
  try { st = await get('/api/auth/reauth', { quiet: true }); } catch { /* ask for the password */ }
  if (fresh) st = { ...st, recent: !!st.sso_fresh };
  const ssoButton = (label, primary) => {
    const status = h('div', { class: 'small', role: 'status', 'aria-live': 'polite' });
    const btn = h('button', { type: 'button', class: `btn ${primary ? 'primary' : ''}`, 'data-sso-reauth': '1', onClick: async () => {
      btn.disabled = true; status.textContent = 'Opening the county sign-in…';
      try { const r = await post('/api/auth/oidc/reauth', { return: returnTo || location.hash }); location.assign(r.url); }
      catch (e) { btn.disabled = false; status.textContent = e.message; }
    } }, label);
    return [btn, status];
  };
  const open = (st, why) => {
    const viaSso = !st.recent && st.method === 'sso';
    const why2 = fresh ? 'Asked for every time, however recently you signed in.' : 'It has been a while since you confirmed it is you.';
    const identity = st.recent ? []
      : st.method === 'totp' ? [{ name: 'code', label: 'Code from your authenticator app', required: true, autocomplete: 'one-time-code', pattern: '[0-9]{6}', help: why2 }]
      : [{ name: 'password', label: `Re-enter your password to ${verb}`, type: 'password', required: true, autocomplete: 'current-password', help: why2 }];
    const f = viaSso ? null : form([...fields, ...identity], { submitText, onCancel: () => m.close(), onSubmit: async (d) => {
      try { await send(st.recent ? { ...d, confirm: true } : d); }
      catch (e) {
        // The few minutes ran out while the dialog was open: ask again, keeping what was typed.
        if (e.data && e.data.reauthRequired && st.recent) { finished = true; m.close(); finished = false; open({ recent: false, method: e.data.method || 'password', sso: !!e.data.sso }, e.message); return; }
        throw e;
      }
      finished = true; m.close(); done && done();
    } });
    const m = modal(title, h('div', { 'data-signature-dialog': st.recent ? 'confirm' : st.method },
      why ? h('div', { class: 'banner warn', role: 'status' }, why) : null,
      intro,
      st.recent ? h('p', { class: 'small muted' }, fresh ? 'You have just confirmed it is you with single sign-on.' : st.method === 'sso' ? 'You confirmed it is you a few minutes ago, so you do not need to sign in again.' : 'You confirmed it is you a few minutes ago, so your password is not needed again.') : null,
      viaSso ? (() => {
        const [btn, status] = ssoButton('Confirm with single sign-on', true);
        return [h('p', {}, `${fresh ? 'This needs you to confirm it is you each time.' : 'It has been a while since you confirmed it is you.'} Your account signs in through single sign-on, so confirm with the county sign-in. You will come back here and ` + (verb === 'sign' ? 'sign' : 'continue') + ' with one click.'),
          status, h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Cancel'), btn)];
      })() : f,
      !viaSso && !st.recent && st.sso && st.method === 'password' ? h('div', { class: 'mt' }, ...ssoButton('Confirm with single sign-on instead', false)) : null),
      { onClose: () => { if (!finished && onCancel) onCancel(); } });
  };
  open(st);
}
// Back from the county sign-in (POST /api/auth/oidc/reauth → the provider → #/…?sso_reauth=<result>).
const SSO_REAUTH_RESULT = {
  ok: ['You confirmed it is you with single sign-on. You can sign now.', 'ok'],
  stale: ['The county sign-in did not ask for your credentials again, so it could not confirm it is you. Try again.', 'error'],
  mismatch: ['The county sign-in was for a different account. Sign in there as yourself, then try again.', 'error'],
  denied: ['Single sign-on did not confirm it is you. Try again, or sign with your password if you have one.', 'error'],
  failed: ['Single sign-on did not confirm it is you. Try again; if it keeps failing, tell your administrator.', 'error'],
};
export function ssoReauthNotice(query) {
  const r = SSO_REAUTH_RESULT[query.get('sso_reauth')];
  if (r) toast(r[0], r[1]);
  return !!r;
}
function signNote(n, done, { onCancel = null } = {}) {
  // A note with AI-drafted text is signed only with the author's statement that they reviewed it (server/routes/notes.js).
  const ai = !!Number(n.ai_assisted);
  return signatureDialog({ title: 'Electronic signature', submitText: 'Sign note',
    intro: h('p', { 'data-attestation': '1' }, 'By signing you attest that this documentation is accurate and complete. Signed notes cannot be edited or deleted; corrections are made by addendum.'),
    fields: ai ? [{ name: 'ai_reviewed', label: 'Some of this note was drafted by the AI copilot. I have reviewed and corrected it, and it accurately records what happened.', type: 'checkbox', span: true }] : [],
    send: (body) => {
      if (ai && !body.ai_reviewed) { const e = new Error('Confirm you have reviewed the AI-drafted text before signing.'); e.data = { fields: { ai_reviewed: 'Tick to confirm you reviewed the AI-drafted text.' } }; throw e; }
      return post(`/api/notes/${n.id}/sign`, body);
    }, returnTo: `#/notes/${n.id}`,
    done: () => { toast('Note signed and locked', 'ok'); done(); }, onCancel });
}
function addAddendum(n, done) {
  const f = form([{ name: 'reason', label: 'Reason (e.g. late entry, correction)' }, { name: 'content', label: 'Addendum', type: 'textarea', required: true, span: true }], { submitText: 'Add addendum', onCancel: () => m.close(), onSubmit: async (d) => { await post(`/api/notes/${n.id}/addenda`, d); toast('Addendum added', 'ok'); m.close(); done(); } });
  const m = modal('Add addendum', f);
}
/** For someone who reads clinical notes but does not write them: SUD counseling notes are not listed (server/routes/notes.js). */
export const counselingHidden = () => (can('notes:clinical:read') && !can('notes:clinical:write') ? h('div', { class: 'banner small phone-line', 'data-counseling-hidden': '1' }, h('span', { class: 'wide-only' }, 'SUD counseling notes are visible only to their author, the co-signer and clinical staff, so they are not listed here.'), h('span', { class: 'phone-only' }, 'Counseling notes (§2.11) are not listed.')) : null);
export function noteTable(rows, { showClient = true, onChange } = {}) {
  // The client code used to be a real <a> inside a cell of a row that is itself a keyboard-focusable
  // "button" (table()'s onRow) — a link nested inside a button, which is invalid and leaves a screen
  // reader announcing the whole row as one control while a second, separately-focusable control sits
  // inside it. The row already opens the note, and the note itself links to the client without any such
  // nesting, so here the client code is a plain (mouse-only) shortcut rather than its own control.
  return table([
    { label: 'Date of service', render: n => h('span', { class: 'nowrap' }, fmt.dt(n.occurred_at)) }, showClient ? { label: 'Client', render: n => h('span', { class: 'link-like', onClick: (e) => { e.stopPropagation(); nav(`client/${n.client_id}`); } }, n.client_name || n.client_code, n.client_name ? h('div', { class: 'muted small mono' }, n.client_code) : null) } : null,
    { label: 'Type', render: n => badge(n.kind === 'clinical' ? 'Clinical' : 'Admin', n.kind === 'clinical' ? 'purple' : 'info') }, { label: 'Format', render: n => fmt.label(n.format, 'NOTE_FORMATS') }, { label: 'Title', render: n => n.title || h('span', { class: 'muted' }, '(untitled)') },
    { label: 'Status', render: n => [badge(fmt.label(n.status), statusKind(n.status)), Number(n.ai_assisted) ? [' ', h('span', { 'data-ai-assisted-row': n.id }, badge('AI-assisted', 'info'))] : null, n.addenda ? [' ', badge(`${n.addenda} addend.`)] : null, n.cosigned_at ? [' ', badge('Countersigned', 'ok')] : n.awaiting_cosign ? [' ', badge('Awaiting review', 'warn')] : n.cosign_requested ? [' ', badge('Review requested', 'warn')] : null] }, { label: 'Source', render: n => n.source === 'manual' ? '' : badge(fmt.label(n.source), 'warn') }, { label: 'Author', key: 'author' },
    // Said on every row, not only known to those who try clicking one (r8 L3).
    { label: '', render: n => h('button', { type: 'button', class: 'btn sm', 'data-note-open': n.id, onClick: (e) => { e.stopPropagation(); openNote(n.id, { onChange }); } }, 'Open') },
  ].filter(Boolean), rows, { onRow: n => openNote(n.id, { onChange }), empty: 'No notes yet. Notes save as drafts automatically while you type, and you sign them when they are complete.',
    // On a phone, two lines a note (as Visits): who and what kind, then when, its title, where it stands and whose (r8 L4).
    compact: { primary: n => [h('span', {}, showClient ? (n.client_name || n.client_code) : (n.title || fmt.label(n.format, 'NOTE_FORMATS'))), badge(n.kind === 'clinical' ? 'Clinical' : 'Admin', n.kind === 'clinical' ? 'purple' : 'info')],
      secondary: n => [h('span', {}, fmt.dt(n.occurred_at)), showClient && n.title ? h('span', {}, n.title) : null, badge(fmt.label(n.status), statusKind(n.status)), Number(n.ai_assisted) ? h('span', { 'data-ai-assisted-row': n.id }, badge('AI-assisted', 'info')) : null, n.awaiting_cosign ? badge('Awaiting review', 'warn') : null, n.author ? h('span', {}, `by ${n.author}`) : null] } });
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
  // Back from confirming with single sign-on: say how it went, once (drop the marker from the address).
  if (ssoReauthNotice(r.query)) history.replaceState(history.state, '', `${location.pathname}${location.search}#/notes${r.id ? '/' + r.id : ''}`);
  const sSel = h('select', { onChange: () => nav(`notes?status=${sSel.value}&kind=${kind}${mine ? '&mine=1' : ''}`) }, [['', 'Any status'], ['draft', 'Unsigned drafts'], ['signed', 'Signed'], ['amended', 'Amended']].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  const kSel = h('select', { onChange: () => nav(`notes?status=${status}&kind=${kSel.value}${mine ? '&mine=1' : ''}`) }, [['', 'All types'], ['admin', 'Administrative'], ['clinical', 'Clinical']].map(([v, l]) => h('option', { value: v, selected: v === kind }, l)));
  return h('div', {},
    pageHead('Notes', (can('notes:admin:write') || can('notes:clinical:write')) ? h('button', { class: 'btn primary', onClick: () => openNoteForm(null, { onDone: refresh }) }, '+ New note') : null, can('imports:write') ? h('a', { class: 'btn wide-only', href: '#/imports' }, 'Import from Pocket AI / OneNote') : null,
      // On a phone Import folds into More, so the first note is higher up the screen (r9 L5).
      can('imports:write') ? h('details', { class: 'more-menu phone-only', 'data-notes-more': '1' }, h('summary', { class: 'btn' }, 'More'), h('a', { class: 'btn', href: '#/imports' }, 'Import from Pocket AI / OneNote')) : null),
    filterBar([status, kind, mine].filter(Boolean).length, h('div', { class: 'field' }, h('label', {}, 'Status'), sSel), h('div', { class: 'field' }, h('label', {}, 'Type'), kSel), h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => nav(`notes?status=${status}&kind=${kind}${mine ? '' : '&mine=1'}`) }, 'My notes')),
    !can('notes:clinical:read') ? h('div', { class: 'banner small phone-line' }, 'Clinical notes are visible only to clinical roles and supervisors.') : counselingHidden(),
    pagedList({ first: data, url: `/api/notes${qs ? '?' + qs : ''}`, limit: PAGE, render: (rows) => noteTable(rows, { onChange: refresh }), summary: (rows, total) => h('div', { class: 'muted small mb' }, `${total} notes`) }));
});

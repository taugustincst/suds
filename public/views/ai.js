// The AI documentation copilot in the browser (docs/AI-COPILOT.md; server/routes/ai.js).
//
// The copilot is a panel inside the form it helps with (a note, a six-dimension assessment, the CalOMS
// questions of an episode), never a dialog over that dialog: the author pastes or types their session notes,
// asks for a draft, and the draft goes into the form's own fields, marked "AI draft — review before signing".
// Nothing is saved or signed by the copilot: the form's own Save and Sign are the author's, and the statement
// ticked when signing an AI-assisted note is the one review step. When the provider fails, the form is exactly
// as it was and works by hand. A draft never replaces what the author already wrote without asking
// (putDraft), and can be taken out again (Undo on its banner).
//
// When the copilot is off for the program (no agreement, switched off, not configured on the server), no panel
// and no "Suggest with AI" is shown: the administrator sees why under Settings › AI copilot. On SUDS on this
// device (local mode) there is no copilot: the panel says why and offers nothing.
import { h, get, post, put, del, state, form, modal, confirmDialog, toast, can, fmt, badge, emptyState, announce } from '../app.js';

export const AI_NOTICE = 'AI draft — review before signing';

let statusCache = null; let statusAt = 0;
/** GET /api/ai/status, kept for a minute. null when there is no copilot here (a device, or an older server). */
export async function aiStatus({ fresh = false } = {}) {
  if (state.local) return { available: false, code: 'device', reason: 'The AI copilot runs only on an office server. SUDS on this device never sends anything to an AI provider.' };
  if (!fresh && statusCache && Date.now() - statusAt < 60000) return statusCache;
  try { statusCache = await get('/api/ai/status', { quiet: true }); statusAt = Date.now(); }
  catch { statusCache = { available: false, code: 'none', reason: 'The AI copilot is not available on this server.' }; statusAt = Date.now(); }
  return statusCache;
}
export const mayUseAi = () => can('ai:draft');
// Off for the program, or not set up on this server: nothing a worker can use or change, so nothing is shown (an
// empty panel on every note also reads to a county reviewer as records going to an AI provider). A monthly limit
// reached, or paused, and a device still say why in the panel.
const NOT_OFFERED = new Set(['no_agreement', 'off', 'no_key', 'endpoint', 'none']);
export const aiOffered = (st) => !!st && (!!st.available || !NOT_OFFERED.has(st.code));

// What is sent and what is not, in the words every panel uses.
const WHAT_IS_SENT = 'Only the text you give here is sent to the AI provider, after SUDS replaces this client\'s name, date of birth, phone, email, address, Medi-Cal number, emergency contact, client code and your name with placeholders, and masks anything that looks like a phone number, email, SSN or long ID number. Other names, places or details you type can still identify someone: leave out what the note does not need, and never paste another client\'s information.';

/** How many identifiers were replaced, in words (from the draft route's identifiers_replaced). */
function replacedText(counts) {
  const n = Object.values(counts || {}).reduce((a, b) => a + b, 0);
  return n ? `${n} identifier${n === 1 ? ' was' : 's were'} replaced before sending.` : 'No identifiers were found to replace.';
}

/** Move focus to `el` (made focusable if it is not), so a keyboard or screen-reader user carries on from there. */
export function focusOn(el) {
  if (!el || !el.isConnected) return;
  if (!el.matches('a[href],button,input,select,textarea,[tabindex]')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: false });
}

/**
 * The copilot panel: a folded section with its own heading, what is sent, the text box, and a Draft button.
 * `draft(text, { ask })` asks the server and applies the result to the form; it returns a sentence for the status
 * line, or { message, focus } to move the focus to what it added (the draft's banner). `ask(question, choices)`
 * puts a question inside the panel (never a dialog over the form's dialog) and resolves with the choice made.
 * The panel's own typing is kept from the form around it (no autosave of the note for a keystroke here).
 */
export function aiPanel({ key, title = 'Draft with the AI copilot', label, help, intro, draft, open = false }) {
  const id = `ai-${key}-${Math.random().toString(36).slice(2, 7)}`;
  const body = h('div', { class: 'ai-panel-body' }, h('p', { class: 'small muted' }, 'Checking whether the AI copilot is available…'));
  // Hidden until the status says the copilot is offered here at all.
  const panel = h('details', { class: 'section span ai-panel', 'data-ai-panel': key, open, hidden: true },
    h('summary', {}, h('h3', { class: 'summary-heading' }, title), h('span', { class: 'muted small' }, ' — optional; you review everything it drafts')), body);
  // Keep the panel's input out of the surrounding form's autosave and draft keeping.
  for (const ev of ['input', 'change']) panel.addEventListener(ev, (e) => e.stopPropagation());
  aiStatus().then((st) => {
    if (!aiOffered(st)) { panel.remove(); return; }
    panel.hidden = false;
    if (!st.available) {
      body.replaceChildren(h('p', { class: 'small', 'data-ai-unavailable': st.code || '1' }, st.reason || 'The AI copilot is not available.', ' You can fill in the form yourself as usual.'));
      return;
    }
    const ta = h('textarea', { id, rows: 6, maxLength: 30000, 'aria-describedby': `${id}-help` });
    const status = h('div', { class: 'small', role: 'status', 'aria-live': 'polite', 'data-ai-status': '1' });
    const err = h('div', { class: 'err', role: 'alert', 'data-ai-error': '1' });
    const choiceBox = h('div', { class: 'banner info small', 'data-ai-choice-box': '1', hidden: true });
    const ask = (question, choices) => new Promise((resolve) => {
      const qid = `${id}-q`;
      choiceBox.replaceChildren(h('p', { id: qid }, question),
        h('div', { class: 'row', role: 'group', 'aria-labelledby': qid, style: { gap: '.4rem', flexWrap: 'wrap' } }, choices.map(c => h('button', { type: 'button', class: `btn sm${c.primary ? ' primary' : ''}`, 'data-ai-choice': c.value,
          onClick: () => { choiceBox.hidden = true; choiceBox.replaceChildren(); resolve(c.value); } }, c.label))));
      choiceBox.hidden = false; status.textContent = '';
      announce(question);
      focusOn(choiceBox.querySelector('button.primary') || choiceBox.querySelector('button'));
    });
    // Not disabled while it works (a disabled button drops the keyboard focus to the page, r10 M7): aria-disabled,
    // and a second press is ignored.
    let busy = false;
    const btn = h('button', { type: 'button', class: 'btn', 'data-ai-draft': key, onClick: async () => {
      if (busy) return;
      err.textContent = ''; status.textContent = '';
      const text = ta.value.trim();
      if (!text) { err.textContent = 'Type or paste your notes first.'; ta.focus(); return; }
      busy = true; btn.setAttribute('aria-disabled', 'true'); status.textContent = 'Drafting… this can take up to a minute. You can keep working on the form.';
      try {
        const res = await draft(text, { ask });
        const message = typeof res === 'string' ? res : (res && res.message) || '';
        status.textContent = message;
        if (res && res.focus) focusOn(res.focus);
        else if (document.activeElement === document.body) focusOn(btn);
      } catch (e) { status.textContent = ''; err.textContent = e.message || 'The AI copilot failed. Your form is unchanged: write it yourself.'; }
      finally { busy = false; btn.removeAttribute('aria-disabled'); }
    } }, 'Draft');
    body.replaceChildren(...[
      intro ? h('p', { class: 'small' }, intro) : null,
      h('p', { class: 'small muted', 'data-ai-what-is-sent': '1' }, WHAT_IS_SENT),
      h('div', { class: 'field' }, h('label', { for: id }, label), ta, h('div', { class: 'small muted', id: `${id}-help` }, help || 'Your own notes or transcript for this session only.')),
      err, choiceBox, h('div', { class: 'row', style: { gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' } }, btn, status)].filter(Boolean));
  });
  return panel;
}

/**
 * Put drafted text into the form's own fields without losing what the author wrote (r10 H2). An empty field is
 * filled. When some already hold the author's text, `ask` puts the question — keep theirs and add the draft below
 * (the default), keep theirs and fill only the empty ones, replace, or cancel — so nothing is overwritten unless
 * they choose it. `targets`: [{ el, label, text, empty?(), after?() }]. Resolves null when cancelled, else
 * { how, undo() } (undo puts every field back as it was).
 */
export async function putDraft(targets, ask) {
  const todo = targets.filter(t => t.el && t.text !== undefined && t.text !== null && String(t.text).trim() !== '');
  const written = (t) => (t.empty ? !t.empty() : !!t.el.value.trim());
  const mine = todo.filter(written);
  let how = 'fill';
  if (mine.length) {
    const names = mine.map(t => t.label);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    how = await ask(`You have already written in ${list}. Keep what you wrote?`, [
      { value: 'below', label: 'Keep mine, add the draft below it', primary: true },
      ...(todo.length > mine.length ? [{ value: 'empty', label: 'Keep mine, fill only the empty ones' }] : []),
      { value: 'replace', label: 'Replace what I wrote' },
      { value: 'cancel', label: 'Cancel' }]);
    if (how === 'cancel') return null;
  }
  const before = todo.map(t => ({ t, value: t.el.value, auto: t.el.dataset.auto }));
  for (const t of todo) {
    const has = written(t);
    if (has && how === 'empty') continue;
    t.el.value = has && how === 'below' ? `${t.el.value.replace(/\s+$/, '')}\n\n${t.text}` : String(t.text);
    if (t.after) t.after();
    t.el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { how, undo: () => {
    for (const { t, value, auto } of before) {
      t.el.value = value; if (auto === undefined) delete t.el.dataset.auto; else t.el.dataset.auto = auto;
      t.el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } };
}

/**
 * The "AI draft — review before signing" banner a form carries once a draft is in it, with what the author
 * should add or check. The review itself is the statement ticked when signing (one step, not two). `onUndo(box)`
 * adds a button that takes the draft back out.
 */
export function aiDraftBanner({ gaps = [], counts, notice = AI_NOTICE, text = 'Read every part against what happened, correct it, and fill in anything marked [needs clinician input] or left as a placeholder such as [PHONE].', onUndo } = {}) {
  const box = h('div', { class: 'banner warn span', 'data-ai-draft-banner': '1' });
  box.append(...[
    h('strong', {}, notice), ' ',
    h('span', {}, text), ' ',
    counts ? h('span', { class: 'small' }, replacedText(counts)) : null,
    gaps.length ? h('div', { class: 'small mt' }, h('b', {}, 'Check or add: '), gaps.join('; ')) : null,
    onUndo ? h('div', { class: 'mt' }, h('button', { type: 'button', class: 'btn sm', 'data-ai-undo': '1', onClick: () => onUndo(box) }, 'Undo: take the draft out')) : null].filter(Boolean));
  return box;
}

// ---------------------------------------------------------------- progress notes
/**
 * The copilot for the note form (public/views/notes.js). `ctx` gives what the panel needs from the form:
 * the client, note kind and format chosen, the note's id once saved, and `apply(result, ask)` to put the draft in
 * (it resolves with the banner it added, or null when the author chose to keep their note as it was).
 */
export function noteCopilot(ctx) {
  if (!mayUseAi()) return null;
  return aiPanel({ key: 'note', label: 'Your session notes or transcript', help: 'For this session and this client only. The draft goes into the note\'s sections below for you to review. What you have already written there is kept unless you choose to replace it.',
    draft: async (text, { ask }) => {
      const c = ctx.read();
      if (!c.client_id) throw new Error('Choose the client first.');
      if (c.format === 'safety_plan') throw new Error('A safety plan is the client\'s own plan, in their words: the copilot does not draft one.');
      if (c.counseling_note) throw new Error('The AI copilot is not used for SUD counseling notes (§2.11). Write this note yourself.');
      const r = await post('/api/ai/draft/note', { client_id: c.client_id, kind: c.kind, format: c.format || 'narrative', source_text: text, note_id: c.note_id || undefined, counseling_note: c.counseling_note || undefined }, { quiet: true });
      const banner = await ctx.apply(r, ask);
      if (!banner) return 'The draft was not added: your note is as you left it.';
      return { message: `Draft added below. ${replacedText(r.identifiers_replaced)} Review it before signing.`, focus: banner };
    } });
}

// ---------------------------------------------------------------- six-dimension assessment
/**
 * The copilot for the six-dimension assessment form (public/views/clinical.js). A narrative goes into each
 * dimension's notes (kept apart from what the clinician already wrote there, as for a note); the suggested
 * rating is shown beside the rating, with a button to use it, and each dimension gets a "reviewed" box the
 * clinician must tick before saving (checked by `confirmed()`).
 */
export function asamCopilot({ clientId, form: f, dims }) {
  if (!mayUseAi() || !can('assessments:write')) return { panel: null, confirmed: () => true };
  const boxes = {};
  let applied = false; let banner = null;
  const panel = aiPanel({ key: 'asam', label: 'Intake or assessment notes', help: 'Your notes from the intake or assessment interview for this client.',
    draft: async (text, { ask }) => {
      const r = await post('/api/ai/draft/asam', { client_id: clientId, source_text: text }, { quiet: true });
      const put1 = await putDraft(dims.map(d => ({ el: f.inputs[`note_${d.key}`], label: d.label.split(':')[0], text: (r.dimensions[d.key] || {}).narrative })), ask);
      if (!put1) return 'The draft was not added: the assessment is as you left it.';
      const ratingLabel = (v) => ((state.constants?.ASAM_RATINGS || []).find(x => x.value === v) || {}).label || String(v);
      for (const d of dims) {
        const x = r.dimensions[d.key] || {};
        const field = f.querySelector(`[data-field="${d.key}_rating"]`);
        if (!field) continue;
        field.parentElement.querySelectorAll(`[data-ai-asam-suggest="${d.key}"]`).forEach(el => el.remove());
        const sel = f.inputs[`${d.key}_rating`];
        const useBtn = x.suggested_rating === null || x.suggested_rating === undefined ? null : h('button', { type: 'button', class: 'btn sm', 'data-ai-use-rating': d.key, onClick: () => { sel.value = String(x.suggested_rating); sel.dispatchEvent(new Event('change', { bubbles: true })); } }, `Use ${x.suggested_rating}`);
        const cbId = `ai-ok-${d.key}-${Math.random().toString(36).slice(2, 6)}`;
        boxes[d.key] = h('input', { type: 'checkbox', id: cbId, 'data-ai-dim-reviewed': d.key });
        field.after(h('div', { class: 'span small banner warn', 'data-ai-asam-suggest': d.key },
          h('div', {}, h('strong', {}, 'AI suggestion: '), x.suggested_rating === null || x.suggested_rating === undefined ? 'not enough information to suggest a rating' : ratingLabel(x.suggested_rating), x.rationale ? ` — ${x.rationale}` : ''),
          h('div', { class: 'row', style: { gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' } }, useBtn, h('span', {}, boxes[d.key], ' ', h('label', { for: cbId }, `I have reviewed ${d.label.split(':')[0]} and chosen its rating myself`)))));
      }
      applied = true;
      if (banner) banner.remove();
      banner = aiDraftBanner({ gaps: r.gaps, counts: r.identifiers_replaced, text: 'Read each dimension\'s notes against the interview, correct them, and choose every rating yourself.',
        onUndo: (box) => {
          put1.undo();
          f.querySelectorAll('[data-ai-asam-suggest]').forEach(el => el.remove());
          for (const k of Object.keys(boxes)) delete boxes[k];
          applied = false;
          const done = h('p', { class: 'banner info span small', 'data-ai-undone': '1' }, 'The draft was taken out: each dimension\'s notes are back as they were.');
          box.replaceWith(done); banner = null; focusOn(done);
        } });
      panel.after(banner);
      return { message: `Drafted. ${replacedText(r.identifiers_replaced)} Review each dimension and choose its rating.`, focus: banner };
    } });
  return { panel, confirmed: () => !applied || dims.every(d => boxes[d.key] && boxes[d.key].checked) };
}

// ---------------------------------------------------------------- care plan
// The copilot's gap marker. A suggestion that still holds one cannot be added: the clinician says it in the
// client's words first (r10 M4).
const NEEDS_INPUT = /\[needs clinician input[^\]]*\]/i;
/**
 * Care plan suggestions from an assessment and/or notes, in a dialog opened from the care plan card. Each
 * problem, goal and step is shown in a box the clinician edits, and added on its own, when they choose, through
 * the ordinary care plan routes (so it is theirs, audited as theirs); nothing is added for them. A goal is
 * added to a problem (the suggestion's own, once added, or one already on the list); a step to its goal.
 */
export async function carePlanCopilot(clientId, { onChange } = {}) {
  const st = await aiStatus({ fresh: true });
  if (!st.available) { toast(st.reason || 'The AI copilot is not available.', 'error'); return; }
  let assessments = [];
  if (can('assessments:read') || can('assessments:write')) { try { assessments = (await get(`/api/clients/${clientId}/asam`, { quiet: true })).rows || []; } catch { assessments = []; } }
  let problems = [];
  try { problems = ((await get(`/api/clients/${clientId}/problems`, { quiet: true })).rows || []).filter(p => !p.status || p.status === 'active'); } catch { problems = []; }
  const results = h('div', { 'data-ai-careplan-results': '1' });
  let added = false; // the care plan behind the dialog is shown again when it closes, if anything was added
  const selId = 'ai-cp-asam'; const taId = 'ai-cp-text';
  const sel = assessments.length ? h('select', { id: selId }, h('option', { value: '' }, '— none —'), assessments.map((a, i) => h('option', { value: a.id, selected: i === 0 }, `${fmt.date(a.assessed_at)}${a.assessed_by_name ? ' · ' + a.assessed_by_name : ''}`))) : null;
  const ta = h('textarea', { id: taId, rows: 4, maxLength: 30000 });
  const status = h('div', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const err = h('div', { class: 'err', role: 'alert' });
  let busy = false;
  const btn = h('button', { type: 'button', class: 'btn primary', 'data-ai-draft': 'careplan', onClick: async () => {
    if (busy) return;
    err.textContent = ''; status.textContent = 'Drafting… this can take up to a minute.'; busy = true; btn.setAttribute('aria-disabled', 'true');
    try {
      const r = await post('/api/ai/draft/careplan', { client_id: clientId, assessment_id: sel && sel.value ? sel.value : undefined, source_text: ta.value.trim() || undefined }, { quiet: true });
      status.textContent = `${r.entries.length} suggestion${r.entries.length === 1 ? '' : 's'}. ${replacedText(r.identifiers_replaced)} Put each in the client's words, then add the ones you want, one at a time.`;
      focusOn(renderEntries(r));
    } catch (e) { status.textContent = ''; err.textContent = e.message; }
    finally { busy = false; btn.removeAttribute('aria-disabled'); }
  } }, 'Suggest');
  function renderEntries(r) {
    const banner = aiDraftBanner({ gaps: r.gaps, notice: 'AI suggestions — review before adding', text: 'Nothing is added until you press Add. Change each one to the client\'s own words, and replace anything marked [needs clinician input] first.' });
    results.replaceChildren(...[banner,
      !r.entries.length ? emptyState('No suggestions', 'The material did not support any. Write the plan with the client as usual.') : null,
      ...r.entries.map((e, i) => entry(e, i))].filter(Boolean));
    return banner;
  }
  // One suggestion: a box for each part, and its Add button, enabled once the text is ready (and, for a goal,
  // its problem is on the list; for a step, its goal).
  function entry(e, i) {
    let problemId = null; let goalId = null;
    const checks = [];
    const recheck = () => checks.forEach(fn => fn());
    const part = ({ kind, fieldLabel, label, text, attr, max, rows = 2, blocked, add }) => {
      const id = `ai-cp-${i}-${kind}-${checks.length}`;
      const box = h('textarea', { id, rows, maxLength: max, 'aria-describedby': `${id}-why`, [`data-ai-cp-${kind}`]: String(i) }, text);
      const why = h('div', { class: 'small muted', id: `${id}-why`, 'data-ai-cp-why': kind });
      let done = false;
      const b = h('button', { type: 'button', class: 'btn sm', [attr]: String(i), onClick: async () => {
        if (b.disabled) return;
        b.disabled = true;
        try { await add(box.value.trim()); done = true; box.readOnly = true; b.textContent = '✓ Added'; why.textContent = ''; added = true; recheck(); }
        catch (x) { b.disabled = false; toast(x.message, 'error'); }
      } }, label);
      const check = () => {
        if (done) return;
        const v = box.value.trim();
        const reason = !v ? 'Write it first.' : NEEDS_INPUT.test(v) ? 'Replace the part marked [needs clinician input] with what the client said, then add it.' : (blocked && blocked()) || '';
        b.disabled = !!reason; why.textContent = reason;
      };
      checks.push(check); box.addEventListener('input', check);
      return h('div', { class: 'field span' }, h('label', { for: id }, fieldLabel), box, h('div', { class: 'row', style: { gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' } }, b, why));
    };
    // The goal's problem: this suggestion's own once it is added, or one already on the client's list.
    const psId = `ai-cp-${i}-for`;
    const ownOpt = e.problem ? h('option', { value: '__own' }, 'The problem in this suggestion (add it first)') : null;
    const probSel = h('select', { id: psId, 'data-ai-cp-goal-problem': String(i), onChange: () => recheck() }, ...[ownOpt, ...problems.map(p => h('option', { value: p.id }, String(p.problem || '').slice(0, 80)))].filter(Boolean));
    const goalProblem = () => (probSel.value === '__own' ? problemId : probSel.value || null);
    const steps = [...(e.objectives || []).map(o => ['Objective', o]), ...(e.interventions || []).map(o => ['Intervention', o])];
    const card = h('div', { class: 'card mt', 'data-ai-careplan-entry': String(i) }, ...[
      h('h3', {}, `Suggestion ${i + 1}: ${String(e.problem || e.goal || 'a goal').replace(NEEDS_INPUT, '').trim().slice(0, 80)}`),
      e.evidence ? h('p', { class: 'small muted' }, `From: ${e.evidence}`) : null,
      e.problem ? part({ kind: 'problem', fieldLabel: 'Problem', label: 'Add problem', text: e.problem, attr: 'data-ai-add-problem', max: 500,
        add: async (v) => { problemId = (await post(`/api/clients/${clientId}/problems`, { problem: v, source: assessments.length && sel && sel.value ? 'assessment' : 'other' })).id; if (ownOpt) ownOpt.textContent = `This suggestion's problem: ${v.slice(0, 60)}`; } }) : null,
      e.goal && (ownOpt || problems.length) ? h('div', { class: 'field span' }, h('label', { for: psId }, 'The goal addresses'), probSel) : null,
      e.goal ? part({ kind: 'goal', fieldLabel: 'Goal, in the client\'s words', label: 'Add goal', text: e.goal, attr: 'data-ai-add-goal', max: 1000, rows: 3,
        blocked: () => (goalProblem() ? '' : e.problem ? 'Add the problem first, or choose one already on the list.' : 'Add a problem to the list first: a goal addresses a problem.'),
        add: async (v) => { goalId = (await post(`/api/clients/${clientId}/goals`, { goal: v, problem_id: goalProblem() })).id; probSel.disabled = true; } }) : null,
      ...steps.map(([kind, text]) => part({ kind: 'step', fieldLabel: kind, label: `Add as a step`, text, attr: 'data-ai-add-step', max: 1000,
        blocked: () => (goalId ? '' : 'Add the goal first, then its steps.'),
        add: async (v) => { await post(`/api/goals/${goalId}/steps`, { step: v, owner_role: 'staff' }); } }))].filter(Boolean));
    recheck();
    return card;
  }
  const m = modal('Care plan suggestions from the AI copilot', h('div', { 'data-ai-careplan': '1' }, ...[
    h('p', { class: 'small' }, 'The copilot suggests problems, goals, objectives and interventions. Nothing is added until you add it; goals belong to the client, so change the wording to theirs.'),
    h('p', { class: 'small muted' }, WHAT_IS_SENT),
    sel ? h('div', { class: 'field' }, h('label', { for: selId }, 'Six-dimension assessment to draw on'), sel) : null,
    h('div', { class: 'field' }, h('label', { for: taId }, sel ? 'Notes to add (optional)' : 'Notes to draw on'), ta),
    err, h('div', { class: 'row', style: { gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' } }, btn, status),
    results,
    h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Close'))].filter(Boolean)), { wide: true, onClose: () => { if (added && onChange) onChange(); } });
}

// ---------------------------------------------------------------- CalOMS helper
/**
 * The copilot for the CalOMS questions of an admission or discharge dialog (public/views/episodes.js): each
 * suggested answer is listed with the words it rests on, and applied to its question only when the worker
 * clicks Apply. Uses the form's own caloms_<key> fields; nothing about CalOMS itself changes here.
 */
export function calomsCopilot({ clientId, form: f, type }) {
  if (!mayUseAi() || !can('episodes:write')) return null;
  const list = h('div', { 'data-ai-caloms-results': '1' });
  const panel = aiPanel({ key: `caloms-${type}`, title: 'Suggest CalOMS answers with the AI copilot', label: 'Intake notes', help: 'Your notes from this intake. Suggestions only: check each against what the client told you.',
    draft: async (text) => {
      const r = await post('/api/ai/draft/caloms', { client_id: clientId, record_type: type, source_text: text }, { quiet: true });
      const banner = aiDraftBanner({ gaps: r.gaps, notice: 'AI suggestions — check each before you apply it', text: 'Nothing is filled in until you press Apply beside it.' });
      list.replaceChildren(banner, !r.suggestions.length ? h('p', { class: 'small' }, 'The notes did not clearly answer any CalOMS question.') : h('ul', {}, r.suggestions.map(s => {
        const b = h('button', { type: 'button', class: 'btn sm', 'data-ai-caloms-apply': s.field, onClick: () => {
          if (Array.isArray(s.value)) { for (const code of s.value) { const cb = f.inputs[`caloms_${s.field}__${code}`]; if (cb) cb.checked = true; } }
          else { const i = f.inputs[`caloms_${s.field}`]; if (!i) { toast('That question is not on this form', 'error'); return; } i.value = String(s.value); i.dispatchEvent(new Event('change', { bubbles: true })); }
          b.textContent = 'Applied ✓';
        } }, 'Apply');
        return h('li', { 'data-ai-caloms-suggestion': s.field }, h('b', {}, `${s.label}: `), s.value_label, s.evidence ? h('span', { class: 'muted' }, ` (“${s.evidence}”)`) : null, ' ', b);
      })));
      return { message: `${r.suggestions.length} suggestion${r.suggestions.length === 1 ? '' : 's'}. ${replacedText(r.identifiers_replaced)}`, focus: banner };
    } });
  panel.append(list);
  // Just above the CalOMS questions it helps with.
  const firstCal = [...f.querySelectorAll('details.section')].find(d => /^\s*CalOMS/.test(d.querySelector('summary')?.textContent || ''));
  if (firstCal) firstCal.before(panel); else f.querySelector('.form-grid')?.append(panel);
  return panel;
}

// ---------------------------------------------------------------- Settings → AI copilot
/** The administrator's tab: what the copilot does and sends, the agreement, the switch, model, cap and usage. */
export async function aiSettingsTab(refresh) {
  const s = await get('/api/ai/settings');
  const a = s.attestation;
  const box = h('div', { 'data-ai-settings': '1' });
  const statusLine = s.status.available ? badge('On', 'ok') : badge('Off', 'warn');
  box.append(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'AI documentation copilot'), statusLine),
    h('p', {}, 'An optional module that drafts documentation for staff to review: progress note sections (DAP, SOAP, BIRP, GIRP or narrative) from a counselor\'s own session notes, six-dimension assessment narratives with suggested ratings, care plan suggestions, and CalOMS answers. A person always reviews and decides: the copilot never saves, signs or submits anything, and a signed note records that it was AI-assisted.'),
    h('h3', { class: 'eyebrow' }, 'What is sent, and what is not'),
    h('ul', { class: 'small' },
      h('li', {}, 'Only the text a worker types or pastes into the copilot for one client (and, for care plan suggestions, the one assessment they choose) is sent, to the AI provider only, over HTTPS from this server. Nothing is sent from browsers, and nothing from SUDS on a device.'),
      h('li', {}, 'Before sending, SUDS replaces that client\'s names, date of birth, phone numbers, email, address, city and ZIP, Medi-Cal number, emergency contact, client code and the worker\'s own name with placeholders, and masks anything that looks like a phone number, email address, SSN, URL, street address or long ID number. Names are put back into the draft here, after it returns.'),
      h('li', {}, 'This is not de-identification under HIPAA\'s Safe Harbor or expert-determination standards: free text can still identify someone (other people\'s names, places, events, dates). That is why a business associate agreement and Part 2 qualified service organization terms with the provider are required first.'),
      h('li', {}, 'Every call is in the audit log (who, which client, which feature, the model and token counts; never the text), and counted against the monthly cap below. Prompts and drafts are not logged or stored by SUDS; what the provider keeps is governed by your agreement with it.')),
    h('p', { class: 'banner warn small', 'data-ai-counsel': '1' }, 'Have your counsel review this use before switching it on: it is a use of client records by a business associate under HIPAA and a qualified service organization under 42 CFR Part 2. SUDS records what you attest; it does not make the arrangement compliant, and it makes no claim about the accuracy of what the AI drafts.'),
    !s.key_configured ? h('p', { class: 'banner danger small', 'data-ai-no-key': '1' }, 'This server has no AI provider key. Set ANTHROPIC_API_KEY in the server\'s environment (docs/AI-COPILOT.md) and restart SUDS.') : null,
    s.endpoint_problem ? h('p', { class: 'banner danger small' }, s.endpoint_problem) : null));

  // The agreement.
  const agreement = h('section', { class: 'card mt', 'data-ai-attestation': a ? 'recorded' : 'none' }, h('div', { class: 'card-head' }, h('h2', {}, 'Agreement with the AI provider')));
  if (a) {
    agreement.append(h('dl', { class: 'kv' },
      h('dt', {}, 'Provider'), h('dd', {}, a.provider), h('dt', {}, 'Signed for the program by'), h('dd', {}, a.signed_by), h('dt', {}, 'Date signed'), h('dd', {}, fmt.date(a.agreement_date)),
      h('dt', {}, 'Reference'), h('dd', {}, a.reference), h('dt', {}, 'Covers'), h('dd', {}, 'HIPAA business associate agreement, with 42 CFR Part 2 qualified service organization terms; reviewed by counsel'),
      h('dt', {}, 'Recorded'), h('dd', {}, `${fmt.dt(a.recorded_at)} by ${a.recorded_by_name || 'an administrator'}`)),
    h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn danger', 'data-ai-withdraw': '1', onClick: async () => {
      if (!(await confirmDialog('Withdraw the agreement?', 'The AI copilot is switched off at once and cannot be switched on again until an agreement is recorded.', { danger: true, okText: 'Withdraw' }))) return;
      await del('/api/ai/attestation'); toast('Agreement withdrawn; the AI copilot is off', 'ok'); refresh();
    } }, 'Withdraw the agreement')));
  } else {
    agreement.append(h('p', { class: 'small' }, 'Record the agreement before the copilot can be switched on. Each statement below must be true.'),
      form([
        { name: 'provider', label: 'AI provider', required: true, value: 'Anthropic' },
        { name: 'signed_by', label: 'Signed for the program by (name and title)', required: true },
        { name: 'agreement_date', label: 'Date the agreement was signed', type: 'date', required: true },
        { name: 'reference', label: 'Agreement reference (contract or document number)', required: true },
        { name: 'baa', label: 'A HIPAA business associate agreement with this provider is in place and covers this use', type: 'checkbox', span: true },
        { name: 'qsoa', label: 'It includes qualified service organization terms under 42 CFR Part 2 (§2.11), binding the provider to Part 2', type: 'checkbox', span: true },
        { name: 'counsel_reviewed', label: 'Our counsel has reviewed this use of client records', type: 'checkbox', span: true },
      ], { submitText: 'Record the agreement', onSubmit: async (d) => { await post('/api/ai/attestation', d); toast('Agreement recorded', 'ok'); refresh(); } }));
  }
  box.append(agreement);

  // The switch, model and cap.
  box.append(h('section', { class: 'card mt', 'data-ai-switch': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'Copilot settings')),
    form([
      { name: 'enabled', label: 'Switch the AI copilot on for this program', type: 'checkbox', value: s.enabled, span: true, help: a ? 'Staff with the "Use the AI documentation copilot" permission (clinicians, supervisors and navigators by default) see it in the note, assessment, care plan and CalOMS forms. While it is off they see nothing of it.' : 'Record the agreement above first. Until the copilot is on, staff see nothing of it.' },
      { name: 'model', label: 'Model', value: s.model === s.default_model ? '' : s.model, placeholder: s.default_model, help: `Blank for the default (${s.default_model}). Another model id from the provider can be entered; see docs/AI-COPILOT.md.` },
      { name: 'monthly_cap', label: 'Most drafts per calendar month (the whole program)', type: 'number', min: 0, step: 1, value: s.monthly_cap, help: 'Once it is reached, staff write documentation themselves until the limit resets on the 1st of each month. 0 pauses the copilot.' },
    ], { submitText: 'Save copilot settings', onSubmit: async (d) => { await put('/api/ai/settings', { enabled: !!d.enabled, model: d.model || '', monthly_cap: d.monthly_cap ?? s.monthly_cap }); toast('Saved', 'ok'); refresh(); } })));

  const u = s.usage;
  box.append(h('section', { class: 'card mt', 'data-ai-usage': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'This month')),
    h('p', {}, `${u.calls} of ${s.monthly_cap} drafts used since ${fmt.date(u.since)}${u.failed ? `; ${u.failed} failed call${u.failed === 1 ? '' : 's'} (not counted against the limit)` : ''}. ${u.input_tokens.toLocaleString()} tokens sent, ${u.output_tokens.toLocaleString()} received.`),
    u.by_feature.length ? h('p', { class: 'small' }, u.by_feature.map(x => `${({ note: 'Notes', asam: 'Assessments', careplan: 'Care plans', caloms: 'CalOMS' })[x.feature] || x.feature}: ${x.calls}`).join(' · ')) : null,
    h('p', { class: 'small' }, h('a', { href: '#/admin?tab=audit&action=ai.' }, 'Copilot entries in the audit log'))));
  return box;
}

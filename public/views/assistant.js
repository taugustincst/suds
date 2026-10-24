// The AI assistant (docs/AI-COPILOT.md, "The assistant"; server/ai-assistant.js): a conversation, built for a phone,
// in which a worker asks about one client before a visit, about their own day, or about programme facts (supplies,
// the referral directory). Each answer comes from a summary SUDS prepares from the record and carries the sections
// it used, as links to the record, under "AI answer — check it against the record before you act".
//
// The conversation lives in this module only: nothing is stored (not in the browser, not on the server, never in
// the address bar), and it is gone when the page is left or "New conversation" is pressed. A conversation is about
// one scope (and one client) at a time: changing either starts a new one. Nothing here writes to any record. The one
// bridge to documentation is "Draft a note from this": it opens the ordinary new-note form with the worker's recap in
// the AI copilot's own text box, where the copilot's draft flow (and its AI-assisted marking) takes over.
//
// Office server only, like the copilot: on SUDS on this device the page says the assistant is not there.
import { h, route, post, state, can, pageHead, announce, clientPicker } from '../app.js';
import { aiStatus, focusOn } from './ai.js';

const NOTICE = 'AI answer — check it against the record before you act';
const SCOPES = [
  ['client', 'A client', 'Before a visit: their care plan, recent contacts, referrals and what is coming up.'],
  ['day', 'My day', 'What is due today, what is overdue, and your unsigned notes.'],
  ['programme', 'Program information', 'Supplies on hand by site, and the referral directory.'],
];
const STARTERS = {
  client: ['Brief me before a visit', 'What referrals are open?', 'What is coming up for them?'],
  day: ['What does my day look like?', 'What is overdue?', 'How many notes do I need to sign?'],
  programme: ['Naloxone stock by site', 'Who takes walk-in referrals for wound care?', 'Which supplies are running low?'],
};
// Where each section of the summary lives in the record: a citation opens it in one tap.
function sectionHref(section, clientId) {
  const tab = { 'client.header': 'overview', 'client.careplan': 'careplan', 'client.contacts': 'interventions', 'client.supplies': 'interventions', 'client.referrals': 'referrals', 'client.upcoming': 'tasks' }[section];
  if (tab && clientId) return `#/client/${encodeURIComponent(clientId)}/${tab}`;
  return { 'day.schedule': '#/tasks', 'day.overdue': '#/tasks', 'day.unsigned': '#/notes', 'programme.supplies': '#/supplies', 'programme.sites': '#/supplies', 'programme.referrals': '#/resources' }[section] || null;
}
const whatIsSent = 'SUDS sends the AI provider a summary it prepares from records you can already see (dates, statuses, counts, care plan entries, and what workers wrote on contacts, referrals and to-dos; never a note\'s text, and never a SUD counseling note) with your question and the conversation so far, after replacing the client\'s name, date of birth, phone, email, address, Medi-Cal number and client code with placeholders, and masking anything that looks like a phone number, email or ID number. Other names you type can still identify someone: never type another client\'s information. Nothing here is saved.';

route('assistant', async (r) => {
  const root = h('div', { class: 'assistant-page', 'data-assistant': '1' });
  root.append(pageHead('Assistant'));
  if (state.local) {
    root.append(h('p', { class: 'banner info', 'data-assistant-unavailable': 'device' }, 'The AI assistant runs only on an office server. SUDS on this device never sends anything to an AI provider.'));
    return root;
  }
  if (!can('ai:ask')) {
    root.append(h('p', { class: 'banner info', 'data-assistant-unavailable': 'permission' }, 'Your account does not use the AI assistant. Ask your administrator if you need it.'));
    return root;
  }
  const st = await aiStatus({ fresh: true });
  const a = (st && st.assistant) || { available: false, code: st && st.code, reason: st && st.reason };
  if (!a.available) {
    root.append(h('p', { class: 'banner warn', 'data-assistant-unavailable': a.code || 'none' }, a.reason || 'The AI assistant is not available on this server.',
      can('settings:manage') ? h('span', {}, ' ', h('a', { href: '#/admin?tab=ai' }, 'Settings › AI copilot')) : ' Tell your administrator if you need it.'));
    return root;
  }

  // ---- conversation state (this module only)
  let scope = ['client', 'day', 'programme'].includes(r.query && r.query.get('scope')) ? r.query.get('scope') : 'client';
  let clientId = (r.query && r.query.get('client')) || null; let clientName = '';
  let turns = []; // { role, text, answer? }
  let busy = false;

  const intro = h('p', { class: 'muted' }, 'Ask about a client before a visit, about your day, or about program information. The assistant answers from a summary of the record and never changes anything.');
  const scopeBox = h('fieldset', { class: 'assistant-scopes', 'data-assistant-scopes': '1' }, h('legend', {}, 'Ask about'),
    ...SCOPES.map(([key, label, help]) => h('label', { class: 'assistant-scope' },
      h('input', { type: 'radio', name: 'assistant-scope', value: key, checked: key === scope, onChange: () => { scope = key; reset(); } }),
      h('span', {}, h('strong', {}, label), h('span', { class: 'small muted' }, ` — ${help}`)))));
  const clientRow = h('div', { class: 'field', 'data-assistant-client': '1' });
  const starters = h('div', { class: 'row assistant-starters', role: 'group', 'aria-label': 'Suggested questions', style: { gap: '.4rem', flexWrap: 'wrap' } });
  const turnsBox = h('ol', { id: 'assistant-turns', class: 'assistant-turns', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const err = h('div', { class: 'err', role: 'alert', 'data-assistant-error': '1' });
  const statusLine = h('div', { class: 'small', role: 'status', 'data-assistant-status': '1' });
  const question = h('textarea', { id: 'assistant-question', rows: 3, maxLength: 4000, 'aria-describedby': 'assistant-sent' });
  const send = h('button', { type: 'submit', class: 'btn primary', id: 'assistant-send' }, 'Ask');
  const fresh = h('button', { type: 'button', class: 'btn', 'data-assistant-new': '1', onClick: () => { reset(); focusOn(question); } }, 'New conversation');
  const composer = h('form', { id: 'assistant-composer', class: 'assistant-composer', onSubmit: (e) => { e.preventDefault(); ask(question.value); } },
    h('div', { class: 'field' }, h('label', { for: 'assistant-question' }, 'Your question'), question,
      h('p', { class: 'small muted', id: 'assistant-sent', 'data-assistant-what-is-sent': '1' }, whatIsSent)),
    err, h('div', { class: 'row', style: { gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' } }, send, fresh, statusLine));

  function drawClientRow() {
    clientRow.hidden = scope !== 'client';
    if (scope !== 'client') return;
    // The app's own client search (the form's client field), so a worker finds a client the way they always do.
    const picker = clientPicker('assistant-client', clientId, { required: true });
    const pid = 'assistant-client-input';
    const input = picker.querySelector('input[type="text"]'); if (input) input.id = pid;
    picker.addEventListener('change', () => {
      if (picker.value === clientId) return;
      clientId = picker.value || null; clientName = input ? input.value : ''; reset({ keepClient: true });
    });
    clientRow.replaceChildren(h('label', { for: pid }, 'Client'), picker,
      h('p', { class: 'small muted' }, 'One client per conversation: choosing another starts a new one.'));
  }
  function drawStarters() {
    starters.replaceChildren(...STARTERS[scope].map(q => h('button', { type: 'button', class: 'btn sm chip', 'data-assistant-starter': q, onClick: () => { question.value = q; ask(q); } }, q)));
  }
  function reset({ keepClient = false } = {}) {
    turns = []; err.textContent = ''; statusLine.textContent = '';
    if (!keepClient && scope !== 'client') { clientId = null; clientName = ''; }
    drawClientRow(); drawStarters(); drawTurns();
  }

  function answerBlock(t) {
    const x = t.answer;
    return h('div', { class: 'ai-answer', 'data-ai-answer': '1' },
      h('p', { class: 'banner warn small ai-answer-banner' }, h('strong', {}, NOTICE)),
      h('p', { class: 'assistant-text' }, x.answer),
      x.missing && x.missing.length ? h('p', { class: 'small', 'data-assistant-missing': '1' }, h('strong', {}, 'Not in the summary: '), x.missing.join('; ')) : null,
      x.citations && x.citations.length ? h('p', { class: 'small assistant-cites' }, h('span', { class: 'muted' }, 'From: '),
        ...x.citations.map(c => { const href = sectionHref(c.section, t.clientId); return href ? h('a', { class: 'chip', href, 'data-ai-cite': c.section }, c.label) : h('span', { class: 'chip', 'data-ai-cite': c.section }, c.label); })) : null);
  }
  function drawTurns() {
    const lastUser = [...turns].reverse().find(t => t.role === 'user');
    turnsBox.replaceChildren(...turns.map(t => h('li', { class: `assistant-turn ${t.role === 'user' ? 'you' : 'ai'}` },
      h('p', { class: 'small muted assistant-who' }, t.role === 'user' ? 'You' : 'Assistant'),
      t.role === 'user' ? h('p', { class: 'assistant-text' }, t.text) : answerBlock(t),
      t === lastUser ? draftAction(t) : null)));
    turnsBox.hidden = !turns.length;
  }
  // "Draft a note from this": the worker's own words (their recap) into the copilot's box on a new note for this
  // client. Only for a client conversation, and only for someone who uses the copilot while it is on.
  function draftAction(t) {
    if (scope !== 'client' || !t.clientId || !can('ai:draft') || !(st && st.available)) return null;
    if (!can('notes:admin:write') && !can('notes:clinical:write')) return null;
    return h('div', { class: 'btn-row', style: { justifyContent: 'flex-start', marginTop: '.3rem' } }, h('button', { type: 'button', class: 'btn sm', id: 'assistant-draft-note', onClick: async () => {
      const { openNoteForm } = await import('./notes.js');
      openNoteForm(null, { clientId: t.clientId, clientDisplay: clientName || undefined, prefill: { ai_source: t.text } });
    } }, 'Draft a note from this'));
  }

  async function ask(text) {
    if (busy) return;
    const q = String(text || '').trim();
    err.textContent = ''; statusLine.textContent = '';
    if (!q) { err.textContent = 'Type a question first.'; focusOn(question); return; }
    if (scope === 'client' && !clientId) { err.textContent = 'Choose the client first.'; focusOn(clientRow.querySelector('input[type="text"]')); return; }
    busy = true; send.setAttribute('aria-disabled', 'true'); statusLine.textContent = 'Asking… this can take up to a minute.';
    const sentTurns = turns.map(t => ({ role: t.role, text: t.role === 'user' ? t.text : t.answer.answer }));
    try {
      const res = await post('/api/ai/ask', { scope, client_id: scope === 'client' ? clientId : undefined, question: q, turns: sentTurns }, { quiet: true });
      const forClient = scope === 'client' ? clientId : null;
      turns.push({ role: 'user', text: q, clientId: forClient }, { role: 'assistant', answer: res, clientId: forClient });
      if (turns.length > 20) turns = turns.slice(-20);
      question.value = ''; statusLine.textContent = '';
      drawTurns();
      announce('The assistant answered.');
      const last = turnsBox.lastElementChild; if (last) last.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      // The conversation is exactly as it was: the question stays in the box, nothing is shown as an answer.
      statusLine.textContent = '';
      err.textContent = (e && e.message) || 'The AI assistant failed. Your conversation is unchanged.';
    } finally { busy = false; send.removeAttribute('aria-disabled'); }
  }

  root.append(h('section', { class: 'card' }, intro, scopeBox, clientRow, starters), h('section', { class: 'card mt' }, turnsBox, composer));
  reset({ keepClient: true });
  return root;
});

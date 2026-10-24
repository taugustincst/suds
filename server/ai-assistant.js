'use strict';
// The AI assistant (docs/AI-COPILOT.md, "The assistant"): one question answered from a context pack, for staff in
// the field. It is the copilot's machinery in another shape, not a second AI system: every ask goes through
// AI.draft() (server/ai-copilot.js), so it is gated, reserved against the monthly cap, de-identified, sent, recorded
// in ai_usage and re-identified exactly as a draft is. What it adds:
//   * the pack (server/ai-context.js): fields and workers' short free text from records the person may see (never a
//     note's text), for one scope (one client
//     in their reach, their own day, or programme facts), access asserted while it is built;
//   * the conversation, kept by the browser and sent with each ask: at most MAX_TURNS turns, each cut to TURN_MAX
//     characters, all of them to TURNS_MAX, the oldest dropped first and the pack told so;
//   * a cited answer: every citation must name a section the pack held, or the answer is refused as unreadable and
//     never shown (a wrong section is the clearest sign of an answer not drawn from the pack).
// It is stateless: nothing of the question, the pack or the answer is stored or logged. The route audits the ask
// (routes/ai.js, ai.ask: metadata only). It never writes to any record.
const db = require('./db');
const AI = require('./ai-copilot');
const P = require('./ai-prompts');
const X = require('./ai-context');

const SCOPES = ['client', 'day', 'programme'];
const MAX_TURNS = 12;
const TURN_MAX = 4000;
const TURNS_MAX = AI.MAX_TEXT;
const MAX_TOKENS = 4000; // a few sentences for a phone; a draft's 16,000 is for long notes

/**
 * The conversation as sent: the last MAX_TURNS turns, each cut to TURN_MAX, together at most TURNS_MAX (the oldest
 * dropped first). Returns { lines, omitted }.
 */
function trimTurns(turns) {
  const all = (Array.isArray(turns) ? turns : []).filter(t => t && ['user', 'assistant'].includes(t.role) && typeof t.text === 'string' && t.text.trim())
    .map(t => ({ role: t.role, text: t.text.trim().slice(0, TURN_MAX) }));
  let kept = all.slice(-MAX_TURNS);
  while (kept.length && kept.reduce((n, t) => n + t.text.length, 0) > TURNS_MAX) kept = kept.slice(1);
  return { kept, omitted: all.length - kept.length };
}

/** How a client is named in a day answer: their first (or preferred) name and code, as the to-do list names them. */
function displayName(clientId) {
  const row = db.one(`SELECT * FROM clients WHERE id=?`, clientId);
  if (!row) return 'a client';
  const c = require('./clients-model').decryptRow(row);
  const first = (c.preferred_name || c.first_name || '').trim();
  return first ? `${first} (${row.client_code})` : row.client_code;
}

/**
 * Ask one question. `scope` is client | day | programme; `clientId` for client scope; `turns` the conversation so far
 * ([{ role: 'user'|'assistant', text }]). Returns { answer, citations: [{ section, label }], missing, model, tokens,
 * counts, sent_chars, client_ids }. Throws AI.AiError with the copilot's kinds, plus scope (an unknown scope),
 * restriction (a client with an agreed restriction) and unreadable (an answer citing a section not sent).
 */
async function ask({ user, ip = null, scope, clientId = null, question, turns = [], date = null }) {
  if (!SCOPES.includes(scope)) throw new AI.AiError('scope', 400, 'Choose what to ask about: a client, your day, or programme information.');
  // Checked before anything is built, as a draft is: with the assistant off, no record is read for a pack.
  const st = AI.status().assistant;
  if (!st.available) throw new AI.AiError(st.code === 'cap' ? 'cap' : 'off', st.code === 'cap' ? 429 : 409, st.reason, { ai_unavailable: st.code });
  if (scope === 'client') {
    if (!clientId) throw new AI.AiError('scope', 400, 'Choose the client to ask about.');
    // The route refuses (and audits) this first (routes/ai.js clientFor); here too, so no caller can skip it.
    if (require('./disclosure').agreedRestrictions(clientId)) throw new AI.AiError('restriction', 409, 'This client has an agreed restriction on how their information is used or shared (see their Requests tab), so the AI assistant is not used for their records.');
  }
  const ctx = { user, ip };
  const pack = scope === 'client' ? X.clientBrief(ctx, clientId) : scope === 'day' ? X.myDay(ctx, date || undefined) : X.programmeReference(ctx, { question });
  const author = db.one(`SELECT display_name FROM users WHERE id=?`, user.id);

  // Which identifiers are masked. A client brief: that client's (and the author's), the copilot's own set. A day
  // pack names no one, but the question and earlier answers may: every pack client's identifiers are masked, and none
  // is put back by name (they all share the copilot's placeholders), the answer naming clients by reference instead.
  // Programme facts: the copilot's patterns only (phone numbers, emails and the like typed into the question).
  let ids = null; const refs = pack.refs || new Map();
  if (scope === 'day') {
    ids = [];
    for (const id of refs.values()) for (const x of AI.identifiersFor(id, author)) ids.push({ ...x, reinsert: null });
    ids.sort((a, b) => b.len - a.len);
  } else if (scope === 'programme') ids = [];
  const names = new Map([...refs].map(([r, id]) => [r, displayName(id)]));

  const { kept, omitted } = trimTurns(turns);
  // An earlier answer named day-pack clients ("Maria (C26-0014)"): back to their references before it is masked.
  const back = (text) => { let t = text; for (const [r, n] of names) t = t.split(n).join(`[${r}]`); return t; };
  const conversation = kept.map(t => `${t.role === 'user' ? 'Staff member' : 'Assistant'}: ${back(t.text)}`).join('\n');
  const sections = new Set(pack.sections.map(s => s.id));
  const check = (data) => {
    const ok = data && typeof data.answer === 'string' && data.answer.trim() && Array.isArray(data.citations)
      && data.citations.every(c => c && typeof c.section === 'string' && sections.has(c.section));
    if (!ok) throw new AI.AiError('unreadable', 502, 'The AI assistant\'s answer could not be checked against the record summary it was given, so it is not shown. Ask again, or look in the record.');
  };
  const r = await AI.draft({
    user, clientId: scope === 'client' ? clientId : null, feature: 'assistant', assistant: true, ids, check,
    pieces: { pack: pack.text, conversation, question: String(question || '') },
    build: (c) => {
      const p = P.assistantPrompt(scope);
      const user = [
        `Context pack (prepared by SUDS from the record; identifiers replaced):\n<context_pack scope="${scope}">\n${c.pack}\n</context_pack>`,
        (c.conversation || omitted) ? `The conversation so far:\n<conversation>\n${omitted ? `(${omitted} earlier turn${omitted === 1 ? '' : 's'} omitted)\n` : ''}${c.conversation}\n</conversation>` : null,
        `The staff member's question:\n<question>\n${c.question}\n</question>`,
      ].filter(Boolean).join('\n\n');
      return { system: p.system, user, schema: p.schema, max_tokens: MAX_TOKENS };
    },
  });
  const d = r.data;
  const name = (s) => String(s).replace(/\[(C\d+)\]/g, (m, ref) => names.get(ref) || m);
  const seen = new Set();
  const citations = d.citations.filter(c => !seen.has(c.section) && seen.add(c.section)).map(c => ({ section: c.section, label: pack.sections.find(s => s.id === c.section).label }));
  return {
    answer: name(d.answer).slice(0, 8000), citations,
    missing: (Array.isArray(d.missing) ? d.missing : []).filter(m => typeof m === 'string' && m.trim()).slice(0, 10).map(m => name(m).slice(0, 300)),
    model: r.model, tokens: r.tokens, counts: r.counts, sent_chars: r.sent_chars, client_ids: [...refs.values()],
  };
}

module.exports = { SCOPES, MAX_TURNS, TURN_MAX, TURNS_MAX, MAX_TOKENS, ask, trimTurns };

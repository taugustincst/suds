'use strict';
// The AI documentation copilot's routes (server/ai-copilot.js, docs/AI-COPILOT.md). Office server only: the
// local kernel does not load this file (server/app.js LOCAL_ROUTE_MODULES), so on a device every /api/ai
// request is a 404 and the browser says why the copilot is not there.
//
// A draft route returns text for the caller's form and writes nothing but the usage row and the audit entry:
// it never creates, saves or signs a note, assessment, care plan entry or CalOMS record. The author does that,
// through the ordinary routes, after reading the draft.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const AI = require('../ai-copilot');
const AP = require('../ai-providers');
const COST = require('../ai-cost');
const P = require('../ai-prompts');
const CL = require('../clinical');
const { badRequest, forbidden, notFound, HttpError } = require('../http');
const { validate } = require('../validate');
const { decrypt } = require('../crypto');

const text = { type: 'string', maxLen: AI.MAX_TEXT };
// How many drafts one person may ask for in a minute: a person reads a draft before asking for another.
const PER_USER_PER_MINUTE = 12;

/**
 * The client exists and is in the caller's reach, and nothing the programme agreed with them stops their text
 * going to the provider. A §164.522 / §2.26 restriction the programme granted may cover this use (a business
 * associate's work needs no consent, but a restriction can still forbid it), and SUDS cannot read a restriction's
 * terms, so the copilot is not used for that client at all (security review of 1.17.0, L6; docs/AI-COPILOT.md).
 * Refused before anything is sent, and audited as a draft that did not happen.
 */
function clientFor(ctx, clientId, feature) {
  if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, clientId)) throw notFound('Client not found');
  auth.assertClientAccess(ctx, clientId);
  if (require('../disclosure').agreedRestrictions(clientId)) {
    audit.log({ user: ctx.user, action: 'ai.draft', entity: 'client', entityId: clientId, clientId, ip: ctx.ip, success: false, details: { feature, outcome: 'restriction' } });
    throw new HttpError(409, 'This client has an agreed restriction on how their information is used or shared (see their Requests tab), so the AI copilot is not used for their records. Write this yourself.', { ai_error: 'restriction' });
  }
}
function perUserLimit(ctx) {
  if (!require('../app').rateLimit(`ai:${ctx.user.id}`, PER_USER_PER_MINUTE, 60_000)) throw new HttpError(429, 'Too many AI drafts in a minute. Read the last one first, then try again.');
}

/**
 * Ask for one draft and audit it, whatever happens. `details` are the feature's own (format, kind, note id):
 * never text. A failure is answered with the reason and the form stays as the author left it.
 */
async function run(ctx, { clientId, feature, pieces, build, details = {} }) {
  perUserLimit(ctx);
  try {
    const r = await AI.draft({ user: ctx.user, clientId, feature, pieces, build });
    audit.log({ user: ctx.user, action: 'ai.draft', entity: 'client', entityId: clientId, clientId, ip: ctx.ip,
      details: { feature, ...details, model: r.model, outcome: 'ok', input_tokens: r.tokens.input_tokens, output_tokens: r.tokens.output_tokens, identifiers_replaced: r.counts, sent_chars: r.sent_chars } });
    return r;
  } catch (e) {
    if (!(e instanceof AI.AiError)) throw e;
    audit.log({ user: ctx.user, action: 'ai.draft', entity: 'client', entityId: clientId, clientId, ip: ctx.ip, success: false,
      details: { feature, ...details, model: e.model || AI.settings().model, outcome: e.kind, input_tokens: e.extra.tokens ? e.extra.tokens.input_tokens : 0, output_tokens: e.extra.tokens ? e.extra.tokens.output_tokens : 0 } });
    // Only the failure's kind in the server log: never the prompt, the text or the provider's answer.
    if (!['off', 'cap'].includes(e.kind)) console.warn(`[suds] AI copilot: ${feature} draft failed (${e.kind})`);
    throw new HttpError(e.status, e.message, { ai_error: e.kind, ...(e.extra.retry_after ? { retry_after: e.extra.retry_after } : {}), ...(e.extra.ai_unavailable ? { ai_unavailable: e.extra.ai_unavailable } : {}) });
  }
}
const common = (r) => ({ model: r.model, notice: 'AI draft — review before signing', identifiers_replaced: r.counts, usage: r.tokens });
const s = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const list = (v, n, max = 500) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, n).map(x => x.slice(0, max)) : []);

module.exports = (r) => {
  // Whether this person can ask for a draft now, and if not why. Any signed-in user may ask (the note form
  // shows the button, or the reason); the numbers are the programme's, not anyone's PHI.
  r.get('/api/ai/status', auth.requireAuth, (ctx) => {
    const st = AI.status();
    return { ...st, can_draft: auth.hasPerm(ctx.user, 'ai:draft'), office: true };
  });

  // ---- Settings → AI copilot (administrators)
  r.get('/api/ai/settings', auth.requireAuth, auth.requirePerm('settings:manage'), () => {
    const st = AI.settings();
    return { ...st, key_configured: AI.keyConfigured(), endpoint_problem: AI.endpointProblem(), custom_endpoint: !!process.env.SUDS_AI_BASE_URL, status: AI.status(), usage: AI.usage(),
      provider: AP.describe(), attestation_provider: st.attestation ? AI.attestedProvider(st.attestation) : null };
  });
  // Prices (dollars per million input / output tokens, for the estimate on the This month card) and the optional
  // monthly spending limit in dollars (server/ai-cost.js): non-negative numbers, or null / blank to clear.
  r.put('/api/ai/settings', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const price = { type: 'number', min: 0, max: COST.MAX_PRICE };
    const v = validate(ctx.body, { enabled: { type: 'boolean' }, model: { type: 'string', maxLen: 100 }, monthly_cap: { type: 'number', integer: true, min: 0, max: 100000 },
      price_input: price, price_output: price, monthly_cost_cap: { type: 'number', min: 0, max: COST.MAX_COST_CAP } }, { partial: true });
    if (v.model !== undefined && v.model !== null && v.model !== '' && !AP.modelOk(v.model)) throw badRequest('Validation failed', { fields: { model: `must be ${AP.current() ? AP.current().modelHint : 'a model id'} (the provider is ${AP.label()})` } });
    const was = AI.settings();
    const next = { ...COST.pricing(), ...Object.fromEntries(['price_input', 'price_output', 'monthly_cost_cap'].filter(k => v[k] !== undefined).map(k => [k, v[k]])) };
    if (next.monthly_cost_cap !== null && !COST.priced(next)) throw badRequest('A monthly spending limit needs both prices, to estimate the cost', { fields: { monthly_cost_cap: 'enter the prices per million input and output tokens first' } });
    if (v.enabled === 1 && !was.enabled) {
      if (!was.attestation) throw badRequest('Record the programme\'s agreement (BAA / QSOA) with the AI provider before switching the copilot on', { fields: { enabled: 'needs the agreement recorded first' } });
      if (!AI.keyConfigured()) throw badRequest(AP.id() === 'anthropic' ? 'This server has no AI provider key (ANTHROPIC_API_KEY in its environment). Set it and restart SUDS, then switch the copilot on.'
        : `This server has no credentials for ${AP.label()} (${AP.describe().credentials_hint} in its environment). Set them and restart SUDS, then switch the copilot on.`, { fields: { enabled: 'no provider key on the server' } });
      if (AI.attestedProvider(was.attestation) !== AP.id()) throw badRequest(`The agreement recorded is with ${AP.label(AI.attestedProvider(was.attestation))}, but this server sends drafts to ${AP.label()}. Withdraw it and record the agreement with ${AP.label()} first.`, { fields: { enabled: 'the agreement is with another provider' } });
    }
    const changed = [];
    db.transaction(() => {
      if (v.enabled !== undefined) { db.setSetting('ai_enabled', v.enabled ? '1' : '0'); changed.push('enabled'); }
      if (v.model !== undefined) { if (v.model) db.setSetting('ai_model', v.model); else db.run(`DELETE FROM settings WHERE key='ai_model'`); changed.push('model'); }
      if (v.monthly_cap !== undefined && v.monthly_cap !== null) { db.setSetting('ai_monthly_cap', String(v.monthly_cap)); changed.push('monthly_cap'); }
      changed.push(...COST.save(v));
    });
    const now = AI.settings();
    audit.log({ user: ctx.user, action: 'ai.settings.update', ip: ctx.ip, details: { changed, enabled: now.enabled, model: now.model, monthly_cap: now.monthly_cap,
      price_input: now.price_input, price_output: now.price_output, monthly_cost_cap: now.monthly_cost_cap } });
    return { ok: true, ...now };
  });
  // The attestation: who signed the agreement with the provider for the programme, when, its reference, and
  // that it covers HIPAA (BAA) and Part 2 (QSOA terms), and that counsel reviewed this use. Not legal advice:
  // SUDS records what the administrator says is in place.
  r.post('/api/ai/attestation', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const v = validate(ctx.body, {
      provider: { type: 'string', required: true, maxLen: 200 }, signed_by: { type: 'string', required: true, maxLen: 200 },
      agreement_date: { type: 'date', required: true }, reference: { type: 'string', required: true, maxLen: 300 },
      baa: { type: 'boolean' }, qsoa: { type: 'boolean' }, counsel_reviewed: { type: 'boolean' },
    });
    const missing = {};
    if (!v.baa) missing.baa = 'Confirm that a HIPAA business associate agreement with this provider is in place.';
    if (!v.qsoa) missing.qsoa = 'Confirm that it includes qualified service organization terms under 42 CFR Part 2.';
    if (!v.counsel_reviewed) missing.counsel_reviewed = 'Confirm that your counsel has reviewed this use of client records.';
    if (Object.keys(missing).length) throw badRequest('The agreement cannot be recorded until each statement is confirmed.', { fields: missing });
    if (v.agreement_date > new Date().toISOString().slice(0, 10)) throw badRequest('Validation failed', { fields: { agreement_date: 'The date the agreement was signed cannot be in the future.' } });
    // configured_provider: the provider this server was set up for when the agreement was recorded (SUDS_AI_PROVIDER);
    // drafts are refused while the server is set up for another (ai-copilot.js status(), provider_changed).
    if (!AP.current()) throw badRequest(`This server's AI provider is not one SUDS knows (${AP.configProblem()}).`);
    const a = { provider: v.provider, configured_provider: AP.id(), signed_by: v.signed_by, agreement_date: v.agreement_date, reference: v.reference, baa: true, qsoa: true, counsel_reviewed: true,
      recorded_by: ctx.user.id, recorded_by_name: ctx.user.display_name || ctx.user.username, recorded_at: db.now() };
    db.setSetting('ai_attestation', JSON.stringify(a));
    audit.log({ user: ctx.user, action: 'ai.attestation.record', ip: ctx.ip, details: { provider: a.provider, configured_provider: a.configured_provider, signed_by: a.signed_by, agreement_date: a.agreement_date, reference: a.reference, baa: true, qsoa: true, counsel_reviewed: true } });
    ctx.status = 201; return { ok: true, attestation: a };
  });
  // Withdrawing it (the agreement ended, or was never right) switches the copilot off at once.
  r.delete('/api/ai/attestation', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const was = AI.attestation();
    db.run(`DELETE FROM settings WHERE key='ai_attestation'`);
    db.setSetting('ai_enabled', '0');
    audit.log({ user: ctx.user, action: 'ai.attestation.withdraw', ip: ctx.ip, details: { had: !!was, provider: was ? was.provider : undefined, reference: was ? was.reference : undefined } });
    return { ok: true };
  });

  // ---- Drafts. Each needs ai:draft and the permission to write what it drafts, and the client in reach.

  // A progress note, from the author's own session notes or transcript for this session. Only the text sent
  // with the request goes to the provider: never another note, never anyone else's (42 CFR Part 2, counseling
  // notes). note_id, when the author is editing a saved draft, must be their own draft about this client.
  r.post('/api/ai/draft/note', auth.requireAuth, auth.requirePerm('ai:draft'), async (ctx) => {
    const v = validate(ctx.body, { client_id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['clinical', 'admin'] },
      format: { type: 'string', enum: P.NOTE_FORMATS }, source_text: { ...text, required: true }, note_id: { type: 'string' }, counseling_note: { type: 'boolean' } });
    if (!auth.hasPerm(ctx.user, `notes:${v.kind}:write`)) throw forbidden(`You cannot author ${v.kind} notes`);
    // A SUD counseling note (42 CFR §2.11) is never drafted with the copilot until counsel says otherwise
    // (docs/AI-COPILOT.md, docs/market/STRATEGY.md): not one being written with the box ticked, nor a saved one.
    const COUNSELING = 'The AI copilot is not used for SUD counseling notes (§2.11). Write this note yourself, or untick "SUD counseling note" if it is not one.';
    if (v.counseling_note) throw badRequest(COUNSELING, { ai_error: 'counseling_note' });
    clientFor(ctx, v.client_id, 'note');
    if (v.note_id) {
      const n = db.one(`SELECT client_id, author_id, status, kind, counseling_note FROM notes WHERE id=? AND deleted_at IS NULL`, v.note_id);
      if (!n || n.client_id !== v.client_id) throw notFound('Note not found');
      if (n.author_id !== ctx.user.id) throw forbidden('The AI copilot drafts only in your own note');
      if (n.status !== 'draft') throw badRequest('A signed note cannot be redrafted; add an addendum instead');
      if (Number(n.counseling_note)) throw badRequest(COUNSELING, { ai_error: 'counseling_note' });
    }
    const format = v.format || 'narrative';
    const out = await run(ctx, { clientId: v.client_id, feature: 'note', pieces: { text: v.source_text },
      build: (c) => P.notePrompt({ format, kind: v.kind, text: c.text }), details: { format, kind: v.kind, note_id: v.note_id || undefined } });
    // The note the draft was asked for is AI-assisted from now on, whatever the browser later sends (security review
    // of 1.17.0, L1): signing it then needs the author's review statement. The ai.draft audit entry above, with
    // this note's id, is the authoritative record that the copilot was used.
    if (v.note_id) db.run(`UPDATE notes SET ai_assisted=1, updated_at=? WHERE id=? AND ai_assisted=0`, db.now(), v.note_id);
    // A note not saved yet: the next note this author writes for this client is marked AI-assisted by the office,
    // over REST or sync, whatever the browser sends (server/rules/notes.js, security review of 1.17.0, r11 finding 2).
    else require('../rules/notes').copilotDrafted(ctx.user.id, v.client_id);
    const secs = P.NOTE_SECTIONS[format];
    const d = out.data || {};
    const draft = secs ? { sections: Object.fromEntries(secs.map(([k]) => [k, s(d.sections && d.sections[k], 20000)])) } : { narrative: s(d.narrative, 50000) };
    return { format, structured: !!secs, draft, gaps: list(d.gaps, 20), ...common(out) };
  });

  // The six assessment dimensions from intake notes: a narrative and a suggested rating for each, which the
  // clinician confirms or changes one by one. Nothing is saved.
  r.post('/api/ai/draft/asam', auth.requireAuth, auth.requirePerm('ai:draft'), auth.requirePerm('assessments:write'), async (ctx) => {
    require('../programme').requireModule('assessments')();
    const v = validate(ctx.body, { client_id: { type: 'string', required: true }, source_text: { ...text, required: true } });
    clientFor(ctx, v.client_id, 'asam');
    const out = await run(ctx, { clientId: v.client_id, feature: 'asam', pieces: { text: v.source_text }, build: (c) => P.asamPrompt({ text: c.text }) });
    const dims = (out.data && out.data.dimensions) || {};
    const dimensions = {};
    for (const dm of CL.ASAM_DIMENSIONS) {
      const x = dims[dm.key] || {};
      const rating = P.RATING_CHOICES.includes(x.suggested_rating) && /^[0-4]$/.test(x.suggested_rating) ? Number(x.suggested_rating) : null;
      dimensions[dm.key] = { narrative: s(x.narrative), suggested_rating: rating, rationale: s(x.rationale, 1000) };
    }
    return { dimensions, gaps: list(out.data && out.data.gaps, 20), ...common(out) };
  });

  // Care plan suggestions from one of this client's assessments (the clinician picks it) and/or notes they give.
  // Each is accepted, or not, one by one through the ordinary care plan routes.
  r.post('/api/ai/draft/careplan', auth.requireAuth, auth.requirePerm('ai:draft'), auth.requirePerm('careplan:write'), async (ctx) => {
    require('../programme').requireModule('careplan')();
    const v = validate(ctx.body, { client_id: { type: 'string', required: true }, assessment_id: { type: 'string' }, source_text: text });
    if (!v.assessment_id && !v.source_text) throw badRequest('Choose an assessment or give some notes to draft from', { fields: { source_text: 'required without an assessment' } });
    clientFor(ctx, v.client_id, 'careplan');
    let assessment = null;
    if (v.assessment_id) {
      if (!auth.hasPerm(ctx.user, 'assessments:read') && !auth.hasPerm(ctx.user, 'assessments:write')) throw forbidden('You cannot read assessments');
      const a = db.one(`SELECT * FROM asam_assessments WHERE id=?`, v.assessment_id);
      if (!a || a.client_id !== v.client_id) throw notFound('Assessment not found');
      let notes = {}; try { notes = a.dimension_notes_enc ? JSON.parse(decrypt(a.dimension_notes_enc)) : {}; } catch { notes = {}; }
      assessment = { ...a, notes, summary: a.summary_enc ? decrypt(a.summary_enc) : '' };
    }
    const problems = db.all(`SELECT problem_enc FROM problems WHERE client_id=? AND status='active'`, v.client_id).map(p => { try { return decrypt(p.problem_enc); } catch { return null; } }).filter(Boolean).slice(0, 30);
    // Every piece of text is de-identified the same way: the assessment's narratives and summary, the notes,
    // and the problem list.
    const pieces = { text: v.source_text || '', summary: assessment ? assessment.summary || '' : '', problems: problems.join('\n') };
    if (assessment) for (const dm of CL.ASAM_DIMENSIONS) pieces[`n_${dm.key}`] = assessment.notes[dm.key] || '';
    const out = await run(ctx, { clientId: v.client_id, feature: 'careplan', pieces,
      build: (c) => P.careplanPrompt({ text: c.text, problems: c.problems ? c.problems.split('\n') : [],
        assessment: assessment ? { ...Object.fromEntries(CL.ASAM_DIMENSIONS.map(dm => [`${dm.key}_rating`, assessment[`${dm.key}_rating`]])), recommended_loc: assessment.recommended_loc, summary: c.summary, notes: Object.fromEntries(CL.ASAM_DIMENSIONS.map(dm => [dm.key, c[`n_${dm.key}`]])) } : null }),
      details: { assessment_id: v.assessment_id || undefined } });
    const entries = (Array.isArray(out.data && out.data.entries) ? out.data.entries : []).slice(0, 6).map(e => ({
      problem: s(e && e.problem, 500), goal: s(e && e.goal, 1000), objectives: list(e && e.objectives, 5), interventions: list(e && e.interventions, 5), evidence: s(e && e.evidence, 500),
    })).filter(e => e.problem || e.goal);
    return { entries, gaps: list(out.data && out.data.gaps, 20), ...common(out) };
  });

  // CalOMS answers the intake notes state, as suggestions the worker applies one by one to the CalOMS questions
  // of the admission or discharge dialog. Read-only use of the CalOMS layout (server/caloms-spec.js): each
  // suggestion is checked against its code set or range here and dropped if it does not fit.
  r.post('/api/ai/draft/caloms', auth.requireAuth, auth.requirePerm('ai:draft'), auth.requirePerm('episodes:write'), async (ctx) => {
    require('../programme').requireModule('caloms')();
    const v = validate(ctx.body, { client_id: { type: 'string', required: true }, record_type: { type: 'string', required: true, enum: ['admission', 'discharge', 'annual_update'] }, source_text: { ...text, required: true } });
    clientFor(ctx, v.client_id, 'caloms');
    const out = await run(ctx, { clientId: v.client_id, feature: 'caloms', pieces: { text: v.source_text }, build: (c) => P.calomsPrompt({ type: v.record_type, text: c.text }), details: { record_type: v.record_type } });
    const S = require('../caloms-spec');
    const fields = new Map(P.calomsFields(v.record_type).map(f => [f.key, f]));
    const suggestions = []; let dropped = 0; const seen = new Set();
    for (const x of (Array.isArray(out.data && out.data.suggestions) ? out.data.suggestions : [])) {
      const f = x && fields.get(x.field);
      if (!f || seen.has(f.key)) { dropped++; continue; }
      const raw = String(x.value ?? '').trim();
      let value = null;
      if (f.set) {
        const codes = new Set(S.SETS[f.set].map(c => c.code));
        if (f.multi) { const vals = [...new Set(raw.split(/[\s,;]+/).filter(c => codes.has(c)))].slice(0, f.multi_max || S.MULTI_MAX); value = vals.length ? vals : null; }
        else value = codes.has(raw) ? raw : null;
      } else if (f.type === 'int') { const n = Number(raw); value = /^\d+$/.test(raw) && ((n >= (f.min ?? 0) && n <= (f.max ?? 999)) || (f.alt || []).includes(n)) ? n : null; }
      if (value === null) { dropped++; continue; }
      seen.add(f.key);
      const label = f.set ? (Array.isArray(value) ? value : [value]).map(c => S.SETS[f.set].find(y => y.code === c).label).join('; ') : String(value);
      suggestions.push({ field: f.key, label: f.label, value, value_label: label, evidence: s(x.evidence, 300) });
    }
    return { record_type: v.record_type, suggestions, dropped, gaps: list(out.data && out.data.gaps, 20), ...common(out) };
  });
};

'use strict';
// The AI documentation copilot (docs/AI-COPILOT.md): drafts a progress note, six-dimension assessment
// narratives, care plan suggestions or CalOMS answers from text the author gives it, for the author to
// review, change and sign. It never saves, signs or submits anything itself.
//
// Sending session content to an AI provider is a use of PHI by a business associate and, for Part 2 records,
// a qualified service organisation. So:
//   * it is off until an administrator records that a BAA / QSOA with the provider is in place (who signed it,
//     when, its reference; counsel reviewed) and switches it on (settings ai_*), and the provider's API key is
//     in the server's environment (config.ai), never in the database or the browser;
//   * it runs only on the office server: a device (SUDS on this device, local mode) has no copilot
//     (server/app.js leaves routes/ai.js out of the local kernel);
//   * before anything is sent, the identifiers SUDS holds for that client (names, date of birth, phones, email,
//     address, city and ZIP, Medi-Cal number, emergency contact, client code) and the author's own name are
//     replaced with placeholders, and obvious phone, email, SSN, long-number, URL and street-address patterns
//     are masked; the names are put back into the draft here, after it returns (deidentify / reidentify);
//   * only the text the caller passes for this client is sent: never another client's data, never anyone
//     else's notes (routes/ai.js);
//   * each call is audited (ai.draft: who, which client, which feature, model, token counts; never the text)
//     and counted in ai_usage for the programme's monthly cap. Prompts and drafts are never logged.
const db = require('./db');
const config = require('./config');
const P = require('./ai-prompts');
const { uuid } = require('./crypto');

// The model the copilot asks for unless the administrator names another. Any other model id may be set
// (Settings → AI copilot); the request for it leaves out the options only this default is known to accept.
const DEFAULT_MODEL = 'claude-opus-5-5';
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{1,62}$/;
const DEFAULT_CAP = 500;
const MAX_TEXT = 30000;
const MAX_TOKENS = 16000;

// ---------------------------------------------------------------- settings
function attestation() {
  const raw = db.getSetting('ai_attestation', null);
  if (!raw) return null;
  try { const a = JSON.parse(raw); return a && typeof a === 'object' ? a : null; } catch { return null; }
}
function settings() {
  const cap = Number(db.getSetting('ai_monthly_cap', String(DEFAULT_CAP)));
  return {
    enabled: db.getSetting('ai_enabled', '0') === '1',
    model: db.getSetting('ai_model', null) || DEFAULT_MODEL,
    default_model: DEFAULT_MODEL,
    monthly_cap: Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_CAP,
    attestation: attestation(),
  };
}
const keyConfigured = () => !!config.ai.apiKey;
/** The endpoint may be plain http only on this machine (a test double); anywhere else it must be https. */
function endpointProblem() {
  let u; try { u = new URL(config.ai.baseUrl); } catch { return 'SUDS_AI_BASE_URL is not a URL'; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
  return 'SUDS_AI_BASE_URL must be https (plain http only to this machine)';
}

function monthStart(now = new Date()) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(); }
// The outcomes that count as a draft against the monthly cap: the provider answered and did the work (a draft,
// a refusal, or one cut off at max_tokens, each of which it bills). A failed call (rate limited, unavailable,
// timed out, refused by the provider as a request, unreadable) is recorded too, but does not use up the cap:
// a provider outage or a burst of rate limits must not spend the programme's drafts (engineering review of the
// 1.17.0 candidate, M4).
const COUNTED = ['ok', 'refused', 'truncated'];
const COUNTED_SQL = `outcome IN (${COUNTED.map(o => `'${o}'`).join(',')})`;
function usage(since = monthStart()) {
  const t = db.one(`SELECT COUNT(*) attempts, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens FROM ai_usage WHERE at >= ?`, since);
  const drafts = db.one(`SELECT COUNT(*) n FROM ai_usage WHERE at >= ? AND ${COUNTED_SQL}`, since).n;
  const byFeature = db.all(`SELECT feature, COUNT(*) calls FROM ai_usage WHERE at >= ? AND ${COUNTED_SQL} GROUP BY feature ORDER BY feature`, since);
  const errors = db.one(`SELECT COUNT(*) n FROM ai_usage WHERE at >= ? AND outcome <> 'ok'`, since).n;
  const failed = db.one(`SELECT COUNT(*) n FROM ai_usage WHERE at >= ? AND NOT ${COUNTED_SQL}`, since).n;
  // calls: the drafts counted against the cap; attempts: every request, failed ones included; errors: every one
  // that did not return a draft (refused and cut off included); failed: those not counted against the cap.
  return { since, calls: drafts, attempts: t.attempts, input_tokens: t.input_tokens, output_tokens: t.output_tokens, errors, failed, by_feature: byFeature };
}

// Drafts sent to the provider and not answered yet (this process; SUDS runs one server process per database).
// The cap is checked before the provider is called and the draft recorded in ai_usage only once it answers, so
// without these a burst of concurrent requests at cap - 1 all passed the check and overshot the cap (security
// review of 1.17.0, r11 finding 1). draft() reserves one before anything is sent and releases it once the outcome
// is recorded; status() counts them as used.
let inFlight = 0;
const pending = () => inFlight;

/** Whether a draft can be asked for now, and if not, why (in words for the person at the keyboard). */
function status() {
  const s = settings();
  const used = usage().calls; // drafts, not failed calls (COUNTED)
  const reserved = used + inFlight; // with the drafts on their way to the provider
  let reason = null; let code = null;
  const no = (c, r) => { code = c; reason = r; };
  if (config.local) no('device', 'The AI copilot runs only on an office server. SUDS on this device never sends anything to an AI provider.');
  else if (!s.attestation) no('no_agreement', 'The AI copilot is off: an administrator has not recorded the program\'s agreement (BAA / QSOA) with the AI provider.');
  else if (!s.enabled) no('off', 'The AI copilot is switched off for this program (Settings → AI copilot).');
  else if (!keyConfigured()) no('no_key', 'The AI copilot is not configured on this server (no provider API key). Tell your administrator.');
  else if (endpointProblem()) no('endpoint', `The AI copilot is misconfigured on this server: ${endpointProblem()}.`);
  else if (!s.monthly_cap) no('cap', 'The AI copilot is paused for this program. Write the documentation yourself as usual.');
  else if (reserved >= s.monthly_cap) no('cap', `This program has used its ${s.monthly_cap} AI draft${s.monthly_cap === 1 ? '' : 's'} for this month. Write the documentation yourself; the limit resets on the 1st of each month.`);
  return { available: !reason, reason, code, enabled: s.enabled, attested: !!s.attestation, key_configured: keyConfigured(), model: s.model, monthly_cap: s.monthly_cap, used_this_month: used };
}

// ---------------------------------------------------------------- de-identification
// What SUDS knows about the client (and the author) is masked however it is written, as far as that can be done
// conservatively: masking a word that was not an identifier costs the author a correction; missing one sends it
// (security review of 1.17.0, L5). Names, streets and cities are compared "folded": accents and apostrophes taken
// off both sides (José = Jose, O'Brien = OBrien = Obrien), a hyphen the same as a space.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Words in an emergency contact entry that are relationships or filler, not names.
const NOT_NAMES = new Set(['mother', 'mom', 'father', 'dad', 'sister', 'brother', 'aunt', 'uncle', 'grandmother', 'grandma', 'grandfather', 'grandpa', 'wife', 'husband',
  'partner', 'spouse', 'friend', 'son', 'daughter', 'cousin', 'niece', 'nephew', 'guardian', 'sponsor', 'case', 'manager', 'worker', 'caseworker', 'pastor', 'neighbor', 'neighbour',
  'girlfriend', 'boyfriend', 'fiance', 'fiancee', 'roommate', 'cell', 'home', 'work', 'phone', 'mobile', 'call', 'text', 'only', 'the', 'and', 'or', 'of', 'at', 'is', 'not', 'ok', 'to', 'mr', 'mrs', 'ms', 'dr']);
// Capitalised words that come before a surname without being someone's given name: titles, roles, and words that
// start a sentence in a note. The counselor's surname after one of these is the counselor.
const BEFORE_SURNAME = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'miss', 'counselor', 'counsellor', 'clinician', 'therapist', 'navigator', 'worker', 'nurse', 'coach', 'supervisor', 'staff',
  'peer', 'specialist', 'lcsw', 'lmft', 'acsw', 'cadc', 'rn', 'np', 'md', 'today', 'yesterday', 'tomorrow', 'then', 'also', 'later', 'when', 'after', 'before', 'per', 'and', 'but', 'so',
  'with', 'by', 'from', 'to', 'for', 'as', 'client', 'writer', 'this', 'that', 'called', 'met', 'saw', 'told', 'asked', 'spoke', 'plan', 'note', 'i', 'we']);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_RE = `(?:${MONTHS.map(m => `${m}|${m.slice(0, 3)}\\.?${m === 'September' ? '|Sept\\.?' : ''}`).join('|')})`;
const ORD = '(?:st|nd|rd|th)?';

/** Accents and apostrophes off, for comparing names: "José O'Brien" and "Jose OBrien" fold the same. */
const foldChars = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').replace(/['’`´]/g, '');
/** `text` folded, with where each folded character came from in the original ([start, end) per character). */
function foldMapped(text) {
  let folded = ''; const from = []; const to = [];
  let i = 0;
  for (const ch of text) {
    const f = foldChars(ch);
    for (let k = 0; k < f.length; k++) { from.push(i); to.push(i + ch.length); }
    folded += f; i += ch.length;
  }
  return { folded, from, to };
}

/** The ways a date of birth (YYYY-MM-DD) is likely to be written: month first or day first, any separator, words. */
function dobPattern(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); if (!m) return null;
  const [, y, mo, d] = m; const mi = Number(mo); const di = Number(d);
  const M = `0?${mi}`, D = `0?${di}`, Y = `(?:${y}|${y.slice(2)})`, S = '[\\/.\\-]';
  const mon = MONTHS[mi - 1];
  const name = `(?:${mon}|${mon.slice(0, 3)}\\.?${mon === 'September' ? '|Sept\\.?' : ''})`;
  const forms = [
    `${y}${S}${M}${S}${D}`, `${M}${S}${D}${S}${Y}`, `${D}${S}${M}${S}${Y}`,
    `${name}\\s+${D}${ORD},?\\s+${y}`, `${D}${ORD}\\s+(?:of\\s+)?${name},?\\s+${y}`,
  ];
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}
/** A pattern for a phone number's ten (or seven) digits, however it is punctuated. */
function phonePattern(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length < 7) return null;
  const sep = '[\\s().+-]*';
  return new RegExp(`(?<!\\d)(?:\\+?1${sep})?${digits.split('').map(esc).join(sep)}(?!\\d)`, 'g');
}
const nameParts = (s) => String(s || '').split(/[\s,-]+/).map(x => x.replace(/[^\p{L}'’.]/gu, '')).filter(x => x.replace(/[.'’]/g, '').length >= 2);
/** A folded value as a pattern: whole words, any case, a space or a hyphen between its words. */
const foldedPattern = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(foldChars(s).trim()).replace(/[\s-]+/g, '[\\s-]+')}(?![\\p{L}\\p{N}])`, 'giu');
const exactPattern = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');

// Street suffixes, each with the ways it is written: "Road" in the record is "Rd" in a note.
const SUFFIXES = [['Street', 'St'], ['Avenue', 'Ave', 'Av'], ['Road', 'Rd'], ['Boulevard', 'Blvd'], ['Drive', 'Dr'], ['Lane', 'Ln'], ['Way'], ['Court', 'Ct'], ['Place', 'Pl'],
  ['Terrace', 'Ter'], ['Circle', 'Cir'], ['Highway', 'Hwy'], ['Parkway', 'Pkwy'], ['Trail', 'Trl'], ['Square', 'Sq'], ['Alley', 'Aly']];
/** The client's street however it is written: with or without its number, the suffix in full or short, any case. */
function streetPattern(street) {
  const words = foldChars(street).trim().split(/\s+/);
  const at = words.findIndex((w, i) => i > 0 && SUFFIXES.some(s => s.some(x => x.toLowerCase() === w.replace(/\.$/, '').toLowerCase())));
  if (at < 1) return null;
  const num = /^\d+[A-Za-z]?$/.test(words[0]) ? words[0] : null;
  const name = words.slice(num ? 1 : 0, at);
  if (!name.length || name.join('').replace(/[^\p{L}\p{N}]/gu, '').length < 3) return null;
  const suffix = SUFFIXES.find(s => s.some(x => x.toLowerCase() === words[at].replace(/\.$/, '').toLowerCase()));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${num ? `${esc(num)}\\s+` : ''})?${name.map(esc).join('\\s+')}\\s+(?:${suffix.join('|')})\\b\\.?`, 'giu');
}

/**
 * What SUDS knows that identifies this client (and the author), as replacements to make before sending.
 * Each: { pattern, token, kind, reinsert, fold, keep } — reinsert is the value put back into the draft (names
 * only); fold, compared with accents and apostrophes off; keep(folded, at, match), a match to leave alone.
 */
function identifiersFor(clientId, author) {
  const M = require('./clients-model');
  const row = db.one(`SELECT * FROM clients WHERE id=?`, clientId);
  if (!row) return [];
  const c = M.decryptRow(row);
  const out = [];
  const add = (value, token, kind, reinsert = null, pattern = null, extra = {}) => {
    const v = String(value || '').trim();
    if (!pattern && v.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return;
    const fold = !pattern && ['name', 'contact', 'address', 'staff'].includes(kind);
    out.push({ pattern: pattern || (fold ? foldedPattern(v) : exactPattern(v)), token, kind, reinsert, fold: fold || !!extra.fold, keep: extra.keep || null, len: pattern ? 1000 : v.length });
  };
  const first = (c.first_name || '').trim(), last = (c.last_name || '').trim(), pref = (c.preferred_name || '').trim();
  // Whole names first (longest wins, below), then each part of each name on its own.
  if (first && last) {
    for (const v of [`${first} ${last}`, `${last}, ${first}`, `${last} ${first}`]) add(v, 'CLIENT_FULL_NAME', 'name', `${first} ${last}`);
    if (pref) add(`${pref} ${last}`, 'CLIENT_FULL_NAME', 'name', `${pref} ${last}`);
  }
  if (first) { add(first, 'CLIENT_FIRST_NAME', 'name', first); for (const p of nameParts(first)) add(p, 'CLIENT_FIRST_NAME', 'name', first); }
  if (last) { add(last, 'CLIENT_LAST_NAME', 'name', last); for (const p of nameParts(last)) add(p, 'CLIENT_LAST_NAME', 'name', last); }
  if (pref) { add(pref, 'CLIENT_PREFERRED_NAME', 'name', pref); for (const p of nameParts(pref)) add(p, 'CLIENT_PREFERRED_NAME', 'name', pref); }
  if (row.client_code) add(row.client_code, 'CLIENT_CODE', 'code');
  const dob = dobPattern(c.dob); if (dob) add(c.dob, 'DOB', 'dob', null, dob);
  for (const ph of [c.phone, c.alt_phone]) { const re = phonePattern(ph); if (re) add(ph, 'PHONE', 'phone', null, re); }
  if (c.email) add(c.email, 'EMAIL', 'email');
  if (c.address) {
    add(c.address, 'ADDRESS', 'address');
    const street = String(c.address).split(/[,\n]/)[0];
    if (street && street !== c.address) add(street, 'ADDRESS', 'address');
    const sp = street && streetPattern(street.replace(/\s+(?:#|Apt\.?|Unit|Suite|Ste\.?)\s*[\w-]+$/i, ''));
    if (sp) add(street, 'ADDRESS', 'address', null, sp, { fold: true });
  }
  if (row.city) add(row.city, 'CITY', 'address');
  if (row.zip) add(row.zip, 'ZIP', 'address', null, new RegExp(`(?<!\\d)${esc(row.zip)}(?:-\\d{4})?(?!\\d)`, 'g'));
  if (c.medicaid_id) add(c.medicaid_id, 'ID', 'id');
  if (c.emergency_contact) {
    const ec = String(c.emergency_contact);
    for (const re of ec.match(/\+?\d[\d\s().-]{6,}\d/g) || []) { const p = phonePattern(re); if (p) add(re, 'PHONE', 'phone', null, p); }
    for (const w of nameParts(ec)) if (/^\p{Lu}/u.test(w) && !NOT_NAMES.has(w.toLowerCase().replace(/[.'’]/g, '')) && w.length >= 2) add(w, 'CONTACT_NAME', 'contact');
  }
  if (author && author.display_name) {
    add(author.display_name, 'COUNSELOR', 'staff', author.display_name);
    // A part of the author's name on its own is theirs only written as a name: capitalised ("pat dry" is not
    // Pat), and not after another given name ("Patricia Jones" is someone else who shares the surname).
    const own = new Set(nameParts(author.display_name).map(p => foldChars(p).toLowerCase()));
    const keep = (folded, at, m) => {
      if (m[0] === m[0].toLowerCase()) return true;
      const w = /(\p{Lu}[\p{L}.]*)[ \t]+$/u.exec(folded.slice(Math.max(0, at - 40), at));
      if (!w) return false;
      const word = w[1].replace(/\./g, '').toLowerCase();
      return !BEFORE_SURNAME.has(word) && !NOT_NAMES.has(word) && !own.has(word);
    };
    for (const p of nameParts(author.display_name)) if (p.length >= 3) add(p, 'COUNSELOR', 'staff', author.display_name, null, { keep });
  }
  // Longest first, so "Maria Lopez" goes as a whole before "Maria" does.
  return out.sort((a, b) => b.len - a.len);
}

// Patterns masked whatever client they belong to: a pasted note can carry someone else's number or address.
const PATTERNS = [
  ['EMAIL', 'email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ['URL', 'url', /\b(?:https?:\/\/|www\.)[^\s<>"]*[^\s<>".,;:!?)\]]/gi],
  ['SSN', 'ssn', /(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)/g],
  ['PHONE', 'phone', /(?<![\d-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\d-])/g],
  // A date said to be someone's date of birth, whoever's: "DOB 1/2/1990", "born March 4th, 1988".
  ['DOB', 'dob', new RegExp(`(?<=\\b(?:DOB|D\\.O\\.B\\.?|date of birth|birth ?date|born(?:\\s+on)?)\\s*:?\\s*)(?:\\d{1,4}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4}|${MONTH_RE}\\s+\\d{1,2}${ORD},?\\s+\\d{4}|\\d{1,2}${ORD}\\s+(?:of\\s+)?${MONTH_RE},?\\s+\\d{4})(?!\\d)`, 'gi')],
  ['ADDRESS', 'address', /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][\p{L}'-]*\s+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Highway|Pkwy|Parkway)\b\.?(?:\s*(?:#|Apt\.?|Unit|Suite)\s*[\w-]+)?/gu],
  // An identifier-like run: a Medi-Cal CIN (9 characters ending in a letter) or 7+ digits (an MRN, a case number).
  ['ID', 'id', /\b9\d{7}[A-Z]\b/g],
  ['NUMBER', 'number', /(?<!\d|\d\.)\d{7,}(?!\d|\.\d)/g],
];

/**
 * Replace the identifiers in `text`. Returns { text, counts } — counts by kind (never the values), for the
 * audit entry and so the author can be told what was taken out.
 */
// While replacing, each placeholder is held as one private-use character (neither a letter nor a digit), so a
// later pattern can never match inside one already made; they become [TOKEN] at the end.
const TOKENS = P.PLACEHOLDERS;
const hold = (token) => String.fromCharCode(0xE000 + TOKENS.indexOf(token));
/** Replace one folded identifier: matched on the folded text, replaced in the original. Returns [text, n]. */
function replaceFolded(out, id) {
  const { folded, from, to } = foldMapped(out);
  const spans = [];
  for (const m of folded.matchAll(id.pattern)) {
    if (!m[0].length || (id.keep && id.keep(folded, m.index, m[0]))) continue;
    spans.push([from[m.index], to[m.index + m[0].length - 1]]);
  }
  for (let i = spans.length - 1; i >= 0; i--) out = out.slice(0, spans[i][0]) + hold(id.token) + out.slice(spans[i][1]);
  return [out, spans.length];
}
function deidentify(text, ids) {
  let out = String(text || '').replace(/[-]/g, '');
  const counts = {};
  const hit = (kind, n) => { if (n) counts[kind] = (counts[kind] || 0) + n; };
  for (const id of ids) {
    let n = 0;
    if (id.fold) [out, n] = replaceFolded(out, id);
    else out = out.replace(id.pattern, () => { n++; return hold(id.token); });
    hit(id.kind, n);
  }
  for (const [token, kind, re] of PATTERNS) {
    let n = 0; out = out.replace(re, () => { n++; return hold(token); }); hit(kind, n);
  }
  out = out.replace(/[-]/g, (ch) => `[${TOKENS[ch.charCodeAt(0) - 0xE000]}]`);
  return { text: out, counts };
}

/** Put the names back: [CLIENT_FIRST_NAME] → the client's first name, and so on. Other placeholders stay for the author. */
function reidentify(value, ids) {
  const names = new Map();
  for (const id of ids) if (id.reinsert && !names.has(id.token)) names.set(id.token, id.reinsert);
  const fix = (s) => s.replace(/\[([A-Z_]+)\]/g, (m, t) => (names.has(t) ? names.get(t) : m));
  const walk = (v) => (typeof v === 'string' ? fix(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(value);
}

// ---------------------------------------------------------------- the provider call
class AiError extends Error {
  constructor(kind, status, message, extra = {}) { super(message); this.kind = kind; this.status = status; this.extra = extra; }
}
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The Messages API request for one prompt (exported for the tests that pin its shape). */
function buildRequest(prompt, model) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    // The rules and task are the same for every call of a feature, so they are cached; the session text is not.
    system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt.user }],
    output_config: { format: { type: 'json_schema', schema: prompt.schema } },
  };
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (model === DEFAULT_MODEL) {
    // Drafting from a page of notes is not a hard reasoning task: medium effort, set explicitly. A request the
    // model's safeguards decline is re-run by the provider on its recommended fallback model.
    body.output_config.effort = 'medium';
    body.fallbacks = 'default';
    headers['anthropic-beta'] = FALLBACK_BETA;
  }
  return { body, headers };
}

function classify(status, retryAfter) {
  // A 400 or 404 is the provider refusing the request itself, almost always a model id it does not know (the
  // model setting) or an option that model does not take: shortening the text would not help.
  if (status === 400 || status === 404) return new AiError('misconfigured', 502, 'The AI provider refused the request (check the model setting in Settings → AI copilot). Your form is unchanged: write it yourself, and tell your administrator.');
  if (status === 413) return new AiError('too_large', 502, 'The text is too long for the AI provider. Your form is unchanged: shorten the text and try again, or write it yourself.');
  if (status === 429) return new AiError('rate_limited', 503, 'The AI provider is busy (rate limited). Your form is unchanged: try again in a minute, or write it yourself.', { retry_after: retryAfter || null });
  if (status === 401 || status === 403) return new AiError('auth', 502, 'The AI provider refused this server\'s key. Your form is unchanged. Tell your administrator.');
  if (status === 529 || status >= 500) return new AiError('unavailable', 503, 'The AI provider is unavailable right now. Your form is unchanged: try again later, or write it yourself.');
  return new AiError('rejected', 502, 'The AI provider could not take this request. Your form is unchanged: write it yourself, or shorten the text and try again.');
}

// One retry, inside the same deadline, for what is usually transient: a rate limit (429), an overloaded or failing
// provider (529, 500, 502, 503, 504) or a connection that failed. Only when the provider's retry-after (if any) is
// at most RETRY_MAX_WAIT_MS and the wait leaves time for the answer; never after a timeout (the deadline is spent).
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_MAX_WAIT_MS = 10000;
const RETRY_DEFAULT_WAIT_MS = 1000;
/** How long to wait before the one retry, from the provider's retry-after header (seconds), or null for no retry. */
function retryWait(retryAfter) {
  if (retryAfter == null || retryAfter === '') return RETRY_DEFAULT_WAIT_MS + Math.floor(Math.random() * 500);
  const sec = Number(retryAfter);
  if (!Number.isFinite(sec) || sec < 0) return RETRY_DEFAULT_WAIT_MS;
  return sec * 1000 <= RETRY_MAX_WAIT_MS ? sec * 1000 : null;
}

/** Send one request to the provider; returns { data, usage, model }. Throws AiError. Never logs the body. */
async function send(prompt, model) {
  const { body, headers } = buildRequest(prompt, model);
  headers['x-api-key'] = config.ai.apiKey;
  const deadline = Date.now() + config.ai.timeoutMs;
  const payload = JSON.stringify(body);
  let res; let json = null;
  for (let attempt = 0; ; attempt++) {
    let wait = null; let failure = null;
    try {
      // A redirect is never followed (security review of 1.17.0, r11 finding 5): the session text and the key would
      // go wherever the answer points. The provider's API does not redirect, so one is refused, not retried.
      res = await fetch(`${config.ai.baseUrl}/v1/messages`, { method: 'POST', headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new AiError('timeout', 504, 'The AI provider did not answer in time. Your form is unchanged: try again, or write it yourself.');
      if (e && e.cause && /redirect/i.test(String(e.cause.message || ''))) throw new AiError('redirect', 502, 'The AI provider\'s address answered with a redirect, which SUDS does not follow. Your form is unchanged: write it yourself, and tell your administrator.');
      failure = new AiError('unreachable', 503, 'The server could not reach the AI provider. Your form is unchanged: try again later, or write it yourself.');
      wait = retryWait(null);
    }
    if (!failure) {
      json = null;
      try { json = await res.json(); } catch { json = null; }
      if (res.ok) break;
      failure = classify(res.status, res.headers.get('retry-after'));
      wait = RETRY_STATUSES.has(res.status) ? retryWait(res.headers.get('retry-after')) : null;
    }
    // The retry must leave the answer as long as the wait at least (and a second), or it is not worth making.
    if (attempt > 0 || wait == null || Date.now() + 2 * wait + 1000 > deadline) throw failure;
    await new Promise(ok => setTimeout(ok, wait));
  }
  const u = (json && json.usage) || {};
  const tokens = { input_tokens: Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0), output_tokens: Number(u.output_tokens || 0) };
  if (!json || !Array.isArray(json.content)) throw new AiError('bad_response', 502, 'The AI provider sent an answer SUDS could not read. Your form is unchanged.', { tokens });
  if (json.stop_reason === 'refusal') throw new AiError('refused', 422, 'The AI provider declined to draft this. Your form is unchanged: write it yourself.', { tokens });
  if (json.stop_reason === 'max_tokens') throw new AiError('truncated', 502, 'The draft was cut off before it was finished. Your form is unchanged: try with shorter text, or write it yourself.', { tokens });
  const text = json.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch { throw new AiError('bad_response', 502, 'The AI provider sent an answer SUDS could not read. Your form is unchanged.', { tokens }); }
  return { data, tokens, model: typeof json.model === 'string' ? json.model : model };
}

function recordUsage({ user, feature, model, outcome, tokens = {}, ms }) {
  db.run(`INSERT INTO ai_usage(id,at,user_id,feature,model,outcome,input_tokens,output_tokens,latency_ms) VALUES(?,?,?,?,?,?,?,?,?)`,
    uuid(), db.now(), user ? user.id : null, feature, model, outcome, tokens.input_tokens || 0, tokens.output_tokens || 0, Math.max(0, Math.round(ms || 0)));
}

/**
 * One draft: check the copilot is available, de-identify, send, put the names back. `build(clean)` makes the
 * prompt from the de-identified pieces. Returns { data, tokens, model, counts }; throws AiError. The caller
 * audits (it knows the client and the feature's details).
 */
async function draft({ user, clientId, feature, pieces, build }) {
  const st = status();
  if (!st.available) throw new AiError(st.code === 'cap' ? 'cap' : 'off', st.code === 'cap' ? 429 : 409, st.reason, { ai_unavailable: st.code });
  // Reserved in the same turn of the event loop as the check above, before anything is awaited; released in the
  // finally below, after the outcome is in ai_usage.
  inFlight++;
  try { return await sendDraft({ user, clientId, feature, pieces, build }); } finally { inFlight--; }
}
async function sendDraft({ user, clientId, feature, pieces, build }) {
  const author = db.one(`SELECT display_name FROM users WHERE id=?`, user.id);
  const ids = identifiersFor(clientId, author);
  const counts = {};
  const clean = {};
  for (const [k, v] of Object.entries(pieces)) {
    if (typeof v === 'string') { const d = deidentify(v, ids); clean[k] = d.text; for (const [kind, n] of Object.entries(d.counts)) counts[kind] = (counts[kind] || 0) + n; }
    else clean[k] = v;
  }
  const prompt = build(clean);
  const model = settings().model;
  const t0 = Date.now();
  try {
    const r = await send(prompt, model);
    recordUsage({ user, feature, model, outcome: 'ok', tokens: r.tokens, ms: Date.now() - t0 });
    return { data: reidentify(r.data, ids), tokens: r.tokens, model: r.model, counts, sent_chars: prompt.user.length };
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError('error', 502, 'The AI copilot failed. Your form is unchanged: write it yourself.');
    recordUsage({ user, feature, model, outcome: err.kind, tokens: err.extra.tokens, ms: Date.now() - t0 });
    err.counts = counts; err.model = model;
    throw err;
  }
}

module.exports = { DEFAULT_MODEL, MODEL_ID, DEFAULT_CAP, MAX_TEXT, MAX_TOKENS, COUNTED, retryWait, settings, attestation, status, pending, usage, monthStart, keyConfigured, endpointProblem,
  identifiersFor, deidentify, reidentify, buildRequest, send, draft, AiError, PATTERNS };

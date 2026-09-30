'use strict';
// County publication releases (built for 1.21.0, not yet released; docs/COUNTY-VIEW.md "Publication"): the
// publication screen over the combined county release. A county manager prepares a screened release of the combined
// figures for a period that has ended, reads it, and publishes it; each release is recorded, immutable, and
// withdrawn only by a record of its own.
//
// The figures are the combined view's (server/county.js combined(): the same counting rule, the same D1-D5 rules for
// figures the county entered, signed outranking entered), for the whole period. Money and the outcomes that are not
// counts of people are exact; the county totals of counts of people and events are screened by SUDS's small-cell
// method (server/county-publication-audit.js over server/sdc.js), audited against the county total and every
// programme's own publication release it could be differenced against. The audit runs in the publication audit's
// worker thread (server/publication-release.js runAudit, kind 'county').
//
// A release is aggregates only: the programmes' names, the period, money, and screened totals. Nothing in it can name
// a client, so it is not a disclosure (server/disclosure.js is for anything that identifies someone; checkAggregate()
// below refuses content with anything but the keys a release carries).
//
// Two releases whose periods overlap could be subtracted from each other (a year beside its quarters), so a period
// that overlaps any release already published, withdrawn or not (a withdrawn release was still seen), is refused.
const db = require('./db');
const K = require('./county');
const MAP = require('./settlement-outcome-map');
const SC = require('./small-cells');
const CPA = require('./county-publication-audit');
const config = require('./config');
const { encrypt, decrypt, uuid } = require('./crypto');

const FORMAT = 'suds-county-publication';
const SCHEMA_VERSION = 1;
const METHOD_NAME = 'SUDS small-cell method (server/sdc.js), county release audited against each program\'s own release';
/** The threshold may be raised for one release, never below the county's own setting; at most this. */
const MAX_THRESHOLD = 50;
const DEFAULT_THRESHOLD = 11;
const REVIEW_CONFIRMATION = 'I have reviewed the suppressed figures and the programs named before publishing';
const SECTION = { spending: 'Spending', use: 'Spent by allowable use (Exhibit E)', hiaa: 'Spent by High Impact Abatement Activity', outcome: 'Outcomes' };

class PublicationError extends Error { constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; } }
const refuse = (code, message, status) => { throw new PublicationError(code, message, status); };

/** The county's own threshold (the small_cell_threshold setting a programme's releases use), 11 by default. */
const countyThreshold = () => Math.max(3, Number(db.getSetting('small_cell_threshold', '')) || DEFAULT_THRESHOLD);

/** Why each screened total is hidden, in words that never say its value. */
function suppressedWhy(reason, T) {
  if (reason === 'small') return `Shown as "<${T}": the county total is from 1 to ${T - 1}.`;
  if (reason === 'complementary') return 'Hidden ("suppressed") so that no program\'s small figure can be worked out by subtracting the other programs\' own published figures from the county total.';
  return CPA.WITHHELD_WHY.protect;
}

/** The releases (kind 'release') whose periods overlap [from, to], published or withdrawn. */
function overlapping(from, to) {
  return db.all(`SELECT id, period_from, period_to, created_at FROM county_publications WHERE kind='release' AND period_from<=? AND period_to>=? ORDER BY period_from, created_at`, to, from);
}

/**
 * Prepare the release for a period: { content, sha256 } or a PublicationError. Deterministic: the same counted
 * files, choices and threshold give the same content and hash (no time or person is in the content).
 */
async function prepare({ from, to, entered = true, threshold = null }, { today }) {
  if (!K.isDay(from) || !K.isDay(to)) refuse('period', 'Choose a period: from and to must be real dates (YYYY-MM-DD).', 400);
  if (from > to) refuse('period', `The start date (${K.humanDay(from)}) is after the end date (${K.humanDay(to)}).`, 400);
  if (to >= today) refuse('period', `The period is not over yet: it ends ${K.humanDay(to)}. A publication release covers a period that has ended.`, 400);
  const floor = countyThreshold();
  const T = threshold === null || threshold === undefined ? floor : Number(threshold);
  if (!Number.isInteger(T) || T < floor || T > MAX_THRESHOLD) refuse('threshold', `The threshold must be a whole number from ${floor} (the county's own) to ${MAX_THRESHOLD}.`, 400);
  const over = overlapping(from, to);
  if (over.length) {
    const o = over[0];
    refuse('overlap', `A release for ${K.humanPeriod(o.period_from, o.period_to)} was already published (${K.humanDay(o.created_at)}). Two releases whose periods overlap could be subtracted from each other, so this period cannot be published${over.length > 1 ? ` (${over.length} releases overlap it)` : ''}. A withdrawn release still counts: it was seen.`, 409);
  }
  const d = K.combined(from, to, { entered });
  const counted = d.programmes.filter(p => p.status !== 'none');
  if (!counted.length) refuse('no_figures', `No program has figures for ${K.humanPeriod(from, to)}${entered ? '' : ' once figures entered by the county are left out'}: there is nothing to publish.`);
  const rowOf = (g, k) => d.rows.find(r => r.group === g && r.key === k);
  const inputs = { programmes: counted.map(p => ({ values: Object.fromEntries(CPA.SCREENED.map(m => [m, rowOf('outcome', m).by[p.id] || 0])) })) };
  const r = await require('./publication-release').runAudit(inputs, T, { kind: 'county' });
  if (r.refused) {
    const e = new PublicationError('refused', r.refused.backstop ? CPA.refusalMessage({ backstop: true }) : r.refused.message);
    e.refusal = { reason: r.refused.backstop ? 'backstop' : r.refused.out_of_budget ? 'budget' : 'unprotected', unprotected: r.refused.unprotected || 0, ...(r.audit ? { steps: r.audit.steps, rounds: r.audit.rounds } : {}) };
    throw e;
  }
  const screened = new Set(CPA.SCREENED);
  // The release publishes spending and the outcomes (SECTION). The award rows (1.21.0, county file version 2) are
  // contract amounts the county already holds, over only the programmes whose files carry one: not part of a
  // publication release.
  const rows = d.rows.filter(x => SECTION[x.group]).map(x => {
    const out = { section: SECTION[x.group], group: x.group, key: x.key, label: x.label, money: !!x.money };
    if (x.group === 'outcome' && screened.has(x.key)) {
      out.value = r.shown[x.key]; out.screened = true;
      if (r.reason[x.key]) { out.suppressed = r.reason[x.key]; }
    } else out.value = x.total;
    return out;
  });
  const suppressed = rows.filter(x => x.suppressed).map(x => ({ key: x.key, label: x.label, shown: x.value, reason: x.suppressed, why: suppressedWhy(x.suppressed, T) }));
  const enteredProgs = counted.filter(p => p.source === K.ENTERED || p.source === 'mixed');
  const content = {
    format: FORMAT, schema_version: SCHEMA_VERSION,
    county: { code: K.formatCode(K.countyCode().code), name: db.getSetting('org_name', '') || '' },
    period: { from, to },
    method: methodOf(T, entered),
    release_id: r.id,
    programmes: counted.map(p => ({ name: p.name, coverage: p.status, source: p.source })),
    figures_entered_by_the_county: { counted: entered, programmes: enteredProgs.map(p => p.name), left_out: (d.entered_left_out || []).map(p => p.name) },
    rows,
    suppressed,
    withheld: (r.withheld_reasons || []).map(w => ({ key: w.measure, reason: w.reason, why: w.why })),
    notes: notesOf(T, entered, enteredProgs, d),
  };
  checkAggregate(content);
  return { content, sha256: K.sha256Hex(K.canonical(content)), audit: r.audit, T };
}
function methodOf(T, entered) {
  return { name: METHOD_NAME, threshold: T, screened_measures: CPA.SCREENED, exact: 'money and the outcomes that are not counts of people',
    differencing: 'audited against the county totals and every program\'s own publication release (each program\'s figure as its own release would show it at most)',
    entered: entered ? 'include' : 'exclude', suds_version: config.version };
}
function notesOf(T, entered, enteredProgs, d) {
  const n = [
    `Combined figures of the programs listed, for the whole period. ${K.PERIOD_RULE}`,
    'Counts of people are each program\'s own count, added up: a person served by two programs counts twice. They are not unduplicated.',
    `Counts of people and of events are screened: a total from 1 to ${T - 1} is shown as "<${T}", and a total that could be subtracted with the programs' own published figures to reveal a small one is "suppressed". Zero is shown as 0. Money, contacts, kits, test strips, syringes, education sessions and staff training hours are not counts of people and are exact.`,
    'Suppressed and withheld figures are listed with why, never with their values. Screened automatically by SUDS\'s method; not an expert determination.',
  ];
  if (!entered) n.push(`Figures entered by the county were left out${d.entered_left_out && d.entered_left_out.length ? ` (${d.entered_left_out.map(p => p.name).join('; ')})` : ''}: only files the programs signed are counted.`);
  else if (enteredProgs.length) n.push(`Figures of ${enteredProgs.map(p => p.name).join('; ')} were ${K.ENTERED_LABEL}: typed or imported by the county's staff from a document the program sent.`);
  return n;
}
/** A release carries these keys only: aggregates, names of programmes and labels (never a client, a date of service or a record). */
const ALLOWED = new Set(['format', 'schema_version', 'county', 'code', 'name', 'period', 'from', 'to', 'method', 'threshold', 'screened_measures', 'exact', 'differencing', 'entered', 'suds_version', 'release_id',
  'programmes', 'coverage', 'source', 'figures_entered_by_the_county', 'counted', 'left_out', 'rows', 'section', 'group', 'key', 'label', 'money', 'value', 'screened', 'suppressed', 'shown', 'reason', 'why', 'withheld', 'notes']);
function checkAggregate(v) {
  if (Array.isArray(v)) { v.forEach(checkAggregate); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!ALLOWED.has(k)) throw new Error(`a county publication release may not carry ${k}`); checkAggregate(x); }
}

/** Record a prepared release (published). Returns the record. */
function record(prep, { from, to, entered }, user) {
  const id = uuid();
  // Checked again where it is written: two people publishing overlapping periods at once get one release.
  db.transaction(() => {
    const o = overlapping(from, to)[0];
    if (o) refuse('overlap', `A release for ${K.humanPeriod(o.period_from, o.period_to)} was published while this one was being prepared: two releases whose periods overlap could be subtracted from each other.`, 409);
    db.run(`INSERT INTO county_publications(id,kind,period_from,period_to,threshold,entered,method,content,sha256,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id, 'release', from, to, prep.T, entered ? 'include' : 'exclude', JSON.stringify(prep.content.method), K.canonical(prep.content), prep.sha256, user ? user.id : null);
  });
  return get(id);
}
function withdraw(id, reason, user) {
  const rel = db.one(`SELECT * FROM county_publications WHERE id=? AND kind='release'`, id);
  if (!rel) return null;
  if (db.one(`SELECT 1 x FROM county_publications WHERE release_id=?`, id)) refuse('withdrawn', 'This release was already withdrawn.', 409);
  const wid = uuid();
  db.run(`INSERT INTO county_publications(id,kind,release_id,period_from,period_to,threshold,entered,method,sha256,reason_enc,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    wid, 'withdrawal', id, rel.period_from, rel.period_to, rel.threshold, rel.entered, rel.method, rel.sha256, encrypt(reason), user ? user.id : null);
  return get(id);
}
const userName = (id) => { if (!id) return null; const u = db.one(`SELECT display_name, username FROM users WHERE id=?`, id); return u ? (u.display_name || u.username) : null; };
/** One release with its withdrawal, if any. reasons: include the withdrawal's reason (county:manage only). */
function get(id, { reasons = false, content = true } = {}) {
  const r = db.one(`SELECT * FROM county_publications WHERE id=? AND kind='release'`, id);
  if (!r) return null;
  const w = db.one(`SELECT * FROM county_publications WHERE release_id=?`, id);
  const c = JSON.parse(r.content);
  return {
    id: r.id, period_from: r.period_from, period_to: r.period_to, threshold: r.threshold, entered: r.entered, method: JSON.parse(r.method), sha256: r.sha256,
    published_at: r.created_at, published_by: userName(r.created_by), release_id: c.release_id,
    status: w ? 'withdrawn' : 'published',
    withdrawal: w ? { id: w.id, at: w.created_at, by: userName(w.created_by), ...(reasons ? { reason: decrypt(w.reason_enc) } : {}) } : null,
    ...(content ? { content: c } : { programmes: c.programmes.length, suppressed: c.suppressed.length, withheld: c.withheld.length }),
  };
}
function list({ reasons = false } = {}) {
  return db.all(`SELECT id FROM county_publications WHERE kind='release' ORDER BY period_from DESC, created_at DESC`).map(r => get(r.id, { reasons, content: false }));
}

/** A shown value in a file: numbers as numbers, the symbols as they are. */
const cell = (v) => v;
/** The release's rows, notes and suppression list as spreadsheet sheets (CSV: About then Figures). */
function sheets(rec) {
  const c = rec.content;
  const about = [
    { k: 'Report', v: `County publication release: combined settlement spending and outcomes of ${c.programmes.length} program${c.programmes.length === 1 ? '' : 's'}` },
    { k: 'County', v: c.county.name }, { k: 'Period', v: `${c.period.from} to ${c.period.to}` },
    { k: 'Classification', v: 'Publication release: screened for small cells; for publication.' },
    { k: 'Release', v: rec.id }, { k: 'SHA-256 of the release', v: rec.sha256 }, { k: 'Published', v: rec.published_at }, { k: 'Published by', v: rec.published_by || '' },
    ...(rec.status === 'withdrawn' ? [{ k: 'Status', v: `WITHDRAWN on ${rec.withdrawal.at}: do not use these figures.` }] : [{ k: 'Status', v: 'Published' }]),
    { k: 'Method', v: c.method.name }, { k: 'Threshold', v: String(c.method.threshold) }, { k: 'Differencing', v: c.method.differencing },
    { k: 'Programs', v: c.programmes.map(p => `${p.name}${p.coverage === 'part' ? ' (part of the period)' : ''}${p.source === K.ENTERED ? ` (${K.ENTERED_LABEL})` : p.source === 'mixed' ? ` (some figures ${K.ENTERED_LABEL})` : ''}`).join('; ') },
    { k: 'Figures entered by the county', v: c.figures_entered_by_the_county.counted ? (c.figures_entered_by_the_county.programmes.length ? `Counted: ${c.figures_entered_by_the_county.programmes.join('; ')}` : 'Counted (none in this period)') : `Left out${c.figures_entered_by_the_county.left_out.length ? `: ${c.figures_entered_by_the_county.left_out.join('; ')}` : ''}` },
    ...c.notes.map((n, i) => ({ k: `Note ${i + 1}`, v: n })),
  ];
  const figures = c.rows.map(x => ({ section: x.section, measure: x.label, value: cell(x.value), note: x.suppressed ? { small: 'small', complementary: 'suppressed', withheld: 'withheld' }[x.suppressed] : '' }));
  const notes = [...c.suppressed.map(s => ({ measure: s.label, shown: s.shown, why: s.why })), ...c.withheld.map(w => ({ measure: MAP.INDICATORS[w.key] ? K.measureLabel(w.key) : w.key, shown: SC.WITHHELD, why: w.why }))];
  if (!notes.length) notes.push({ measure: 'Nothing', shown: '', why: 'No figure of this release was suppressed or withheld.' });
  return {
    about, figures, notes,
    aboutCols: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }],
    figureCols: [{ key: 'section', label: 'Section' }, { key: 'measure', label: 'Measure' }, { key: 'value', label: 'County total' }, { key: 'note', label: 'Screened' }],
    noteCols: [{ key: 'measure', label: 'Measure' }, { key: 'shown', label: 'Shown as' }, { key: 'why', label: 'Why (the value is never given)' }],
  };
}

module.exports = { prepare, record, withdraw, get, list, sheets, overlapping, countyThreshold, checkAggregate, PublicationError, FORMAT, SCHEMA_VERSION, METHOD_NAME, MAX_THRESHOLD, REVIEW_CONFIRMATION };

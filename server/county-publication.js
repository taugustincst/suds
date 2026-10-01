'use strict';
// County publication releases (released in 1.21.0; docs/COUNTY-VIEW.md "Publication"): the
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
// that overlaps any release already published, withdrawn or not (a withdrawn release was still seen), is refused. The
// one exception (released in 1.22.0): a CORRECTED release of exactly the same period, once every release of that period
// is withdrawn. Its audit treats every total the withdrawn releases printed as known to the reader (sdc.js `fixed`
// cells, beside the programmes' own figures then and now: county-publication-audit.js `earlier`), so nothing new can
// be worked out by subtracting one from the other. A release published before 1.22.0 kept no record of what it was
// screened from (county_publication_inputs), so its period still cannot be published again.
//
// Publication consent (released in 1.22.0): a release names the programmes whose figures it counts, and the data
// contribution agreement says the county publishes figures that name a programme only with its written agreement.
// The county records, per programme, that it agreed in writing (the date, the agreement's reference, who recorded it)
// and withdraws that record when it is withdrawn. A release that would name a programme without a current consent is
// refused, naming the programmes; or, if the preparer chooses (without_consent: 'leave_out'), those programmes are
// left out of the release whole (their figures too), and the release says which were left out and why.
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
  return db.all(`SELECT r.id, r.period_from, r.period_to, r.created_at, r.threshold, r.content, r.sha256, (SELECT w.created_at FROM county_publications w WHERE w.release_id=r.id) withdrawn_at
    FROM county_publications r WHERE r.kind='release' AND r.period_from<=? AND r.period_to>=? ORDER BY r.period_from, r.created_at`, to, from);
}
/** What a release was screened from (county_publication_inputs), or null: a release published before 1.22.0 kept none. */
function inputsOf(releaseId) {
  const r = db.one(`SELECT inputs_enc FROM county_publication_inputs WHERE id=?`, releaseId);
  return r ? JSON.parse(decrypt(r.inputs_enc)) : null;
}
/**
 * The releases already made of [from, to] that a new release must be checked against: none, or (a corrected release)
 * every release of exactly this period, each withdrawn and with what it was screened from. Refuses anything else.
 */
function earlierReleases(from, to, T) {
  const over = overlapping(from, to);
  if (!over.length) return [];
  const other = over.filter(o => o.period_from !== from || o.period_to !== to);
  if (other.length) {
    const o = other[0];
    refuse('overlap', `A release for ${K.humanPeriod(o.period_from, o.period_to)} was already published (${K.humanDay(o.created_at)}). Two releases whose periods overlap could be subtracted from each other, so this period cannot be published${other.length > 1 ? ` (${other.length} releases overlap it)` : ''}. A withdrawn release still counts: it was seen. Only a corrected release of exactly the same period as a withdrawn one can be published.`, 409);
  }
  const live = over.find(o => !o.withdrawn_at);
  if (live) refuse('overlap', `A release for ${K.humanPeriod(from, to)} was already published (${K.humanDay(live.created_at)}) and is not withdrawn. To publish a corrected release of this period, withdraw that one first (say why); the corrected release is then checked against everything the withdrawn one printed.`, 409);
  const old = over.find(o => !inputsOf(o.id));
  if (old) refuse('overlap', `The withdrawn release for ${K.humanPeriod(from, to)} (${K.humanDay(old.created_at)}) was published before SUDS kept what a release was screened from. A corrected release could not be checked against it, so this period cannot be published again.`, 409);
  const otherT = over.find(o => o.threshold !== T);
  if (otherT) refuse('threshold', `A corrected release must use the threshold of the withdrawn release it corrects (${otherT.threshold}), so that what that release printed is read the same way. Leave the threshold empty, or set it to ${otherT.threshold}.`, 400);
  return over.map(o => {
    const c = JSON.parse(o.content);
    const printed = Object.fromEntries(CPA.SCREENED.map(m => { const r = c.rows.find(x => x.group === 'outcome' && x.key === m); return [m, r ? r.value : null]; }));
    return { id: o.id, sha256: o.sha256, withdrawn_at: o.withdrawn_at, inputs: inputsOf(o.id), printed };
  });
}

// ---- publication consent (released in 1.22.0) ----
const userName = (id) => { if (!id) return null; const u = db.one(`SELECT display_name, username FROM users WHERE id=?`, id); return u ? (u.display_name || u.username) : null; };
function consentOut(r, reference) {
  return { id: r.id, agreed_on: r.agreed_on, recorded_at: r.recorded_at, recorded_by: userName(r.recorded_by), withdrawn_at: r.withdrawn_at || null, withdrawn_by: userName(r.withdrawn_by),
    ...(reference ? { reference: r.reference_enc ? decrypt(r.reference_enc) : '' } : {}) };
}
/** Each programme's current consent to publication (the one not withdrawn), by programme id. reference: decrypt it. */
function consents({ reference = false } = {}) {
  const out = new Map();
  for (const r of db.all(`SELECT * FROM county_publication_consents WHERE withdrawn_at IS NULL`)) out.set(r.programme_id, consentOut(r, reference));
  return out;
}
/** Every consent recorded for a programme, newest first (current and withdrawn). */
function consentHistory(programmeId, { reference = false } = {}) {
  return db.all(`SELECT * FROM county_publication_consents WHERE programme_id=? ORDER BY recorded_at DESC, rowid DESC`, programmeId).map(r => consentOut(r, reference));
}
/** Record a programme's written agreement to publication. */
function recordConsent(programmeId, { agreed_on: agreedOn, reference }, user, { today }) {
  if (!K.isDay(agreedOn)) refuse('agreed_on', 'Give the date the program agreed in writing (YYYY-MM-DD).', 400);
  if (agreedOn > today) refuse('agreed_on', `The date of the agreement (${K.humanDay(agreedOn)}) is in the future: record it once the program has agreed in writing.`, 400);
  const ref = K.cleanText(reference || '', 200);
  if (ref.length < 2) refuse('reference', 'Give the agreement\'s reference (its title, number or where it is filed), so that the agreement can be found.', 400);
  const id = uuid();
  db.transaction(() => {
    if (db.one(`SELECT 1 x FROM county_publication_consents WHERE programme_id=? AND withdrawn_at IS NULL`, programmeId)) refuse('consent_exists', 'This program\'s consent to publication is already recorded. Withdraw it first to record a new agreement.', 409);
    db.run(`INSERT INTO county_publication_consents(id,programme_id,agreed_on,reference_enc,recorded_at,recorded_by) VALUES(?,?,?,?,?,?)`, id, programmeId, agreedOn, encrypt(ref), db.now(), user ? user.id : null);
  });
  return consentOut(db.one(`SELECT * FROM county_publication_consents WHERE id=?`, id), true);
}
/** Withdraw a programme's current consent: releases from now on cannot name it. Releases already published stand. */
function withdrawConsent(programmeId, user) {
  const r = db.one(`SELECT * FROM county_publication_consents WHERE programme_id=? AND withdrawn_at IS NULL`, programmeId);
  if (!r) refuse('no_consent', 'No consent to publication is recorded for this program.', 409);
  db.run(`UPDATE county_publication_consents SET withdrawn_at=?, withdrawn_by=? WHERE id=?`, db.now(), user ? user.id : null, r.id);
  return consentOut(db.one(`SELECT * FROM county_publication_consents WHERE id=?`, r.id), false);
}
/** What prepare does with a programme it would name that has no current consent. */
const WITHOUT_CONSENT = ['refuse', 'leave_out'];

/**
 * Prepare the release for a period: { content, sha256 } or a PublicationError. Deterministic: the same counted
 * files, choices and threshold give the same content and hash (no time or person is in the content).
 */
async function prepare({ from, to, entered = true, threshold = null, withoutConsent = 'refuse' }, { today }) {
  if (!K.isDay(from) || !K.isDay(to)) refuse('period', 'Choose a period: from and to must be real dates (YYYY-MM-DD).', 400);
  if (from > to) refuse('period', `The start date (${K.humanDay(from)}) is after the end date (${K.humanDay(to)}).`, 400);
  if (to >= today) refuse('period', `The period is not over yet: it ends ${K.humanDay(to)}. A publication release covers a period that has ended.`, 400);
  if (!WITHOUT_CONSENT.includes(withoutConsent)) refuse('without_consent', 'without_consent must be refuse or leave_out.', 400);
  const floor = countyThreshold();
  // A corrected release reads what the withdrawn one printed with that release's threshold (earlierReleases).
  const same = overlapping(from, to).filter(o => o.period_from === from && o.period_to === to);
  const T = threshold === null || threshold === undefined ? (same.length ? same[0].threshold : floor) : Number(threshold);
  if (!Number.isInteger(T) || T < floor || T > MAX_THRESHOLD) {
    if (same.length && Number.isInteger(T) && T < floor) refuse('threshold', `The withdrawn release of this period used a threshold of ${T}, below the county's own threshold now (${floor}). A corrected release must use the threshold of the release it corrects, and a release never uses less than the county's own, so this period cannot be published again.`, 409);
    refuse('threshold', `The threshold must be a whole number from ${floor} (the county's own) to ${MAX_THRESHOLD}.`, 400);
  }
  const earlier = earlierReleases(from, to, T);
  // Publication consent: every programme the release would name needs a current consent, or is left out whole.
  const agreed = consents();
  const lacking = K.combined(from, to, { entered }).programmes.filter(p => p.status !== 'none' && !agreed.has(p.id));
  if (lacking.length && withoutConsent !== 'leave_out') {
    const e = new PublicationError('no_consent', `This release would name ${lacking.length === 1 ? 'a program' : `${lacking.length} programs`} with no consent to publication recorded: ${lacking.map(p => p.name).join('; ')}. The county publishes figures that name a program only with its written agreement. Record each program's agreement on County view › Programs (Publication consent), or leave ${lacking.length === 1 ? 'it' : 'them'} out of this release.`, 409);
    e.programmes = lacking.map(p => ({ id: p.id, name: p.name }));
    throw e;
  }
  const d = K.combined(from, to, { entered, ...(lacking.length ? { leaveOut: new Set(lacking.map(p => p.id)) } : {}) });
  const counted = d.programmes.filter(p => p.status !== 'none');
  if (!counted.length) refuse('no_figures', `No program has figures for ${K.humanPeriod(from, to)}${entered ? '' : ' once figures entered by the county are left out'}${lacking.length ? ' once the programs with no consent to publication are left out' : ''}: there is nothing to publish.`);
  const rowOf = (g, k) => d.rows.find(r => r.group === g && r.key === k);
  const own = counted.map(p => ({ id: p.id, name: p.name, values: Object.fromEntries(CPA.SCREENED.map(m => [m, rowOf('outcome', m).by[p.id] || 0])) }));
  const inputs = { programmes: own, ...(earlier.length ? { earlier: earlier.map(e => ({ programmes: e.inputs.programmes, printed: e.printed })) } : {}) };
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
    ...(lacking.length ? { left_out_without_consent: lacking.map(p => p.name) } : {}),
    ...(earlier.length ? { corrects: earlier.map(e => ({ sha256: e.sha256, withdrawn: e.withdrawn_at.slice(0, 10) })) } : {}),
    rows,
    suppressed,
    withheld: (r.withheld_reasons || []).map(w => ({ key: w.measure, reason: w.reason, why: w.why })),
    notes: notesOf(T, entered, enteredProgs, d, { lacking, earlier }),
  };
  checkAggregate(content);
  return { content, sha256: K.sha256Hex(K.canonical(content)), audit: r.audit, T, inputs: { programmes: own } };
}
function methodOf(T, entered) {
  return { name: METHOD_NAME, threshold: T, screened_measures: CPA.SCREENED, exact: 'money and the outcomes that are not counts of people',
    differencing: 'audited against the county totals and every program\'s own publication release (each program\'s figure as its own release would show it at most)',
    entered: entered ? 'include' : 'exclude', suds_version: config.version };
}
function notesOf(T, entered, enteredProgs, d, { lacking = [], earlier = [] } = {}) {
  const n = [
    `Combined figures of the programs listed, for the whole period. ${K.PERIOD_RULE}`,
    'Counts of people are each program\'s own count, added up: a person served by two programs counts twice. They are not unduplicated.',
    `Counts of people and of events are screened: a total from 1 to ${T - 1} is shown as "<${T}", and a total that could be subtracted with the programs' own published figures to reveal a small one is "suppressed". Zero is shown as 0. Money, contacts, kits, test strips, syringes, education sessions and staff training hours are not counts of people and are exact.`,
    'Suppressed and withheld figures are listed with why, never with their values. Screened automatically by SUDS\'s method; not an expert determination.',
  ];
  if (!entered) n.push(`Figures entered by the county were left out${d.entered_left_out && d.entered_left_out.length ? ` (${d.entered_left_out.map(p => p.name).join('; ')})` : ''}: only files the programs signed are counted.`);
  else if (enteredProgs.length) n.push(`Figures of ${enteredProgs.map(p => p.name).join('; ')} were ${K.ENTERED_LABEL}: typed or imported by the county's staff from a document the program sent.`);
  if (lacking.length) n.push(`Left out for lack of consent to publication: ${lacking.map(p => p.name).join('; ')}. The county publishes figures that name a program only with its written agreement; these programs' figures are not in this release's totals.`);
  if (earlier.length) n.push(`A corrected release: it replaces ${earlier.length === 1 ? 'a release' : `${earlier.length} releases`} of the same period that ${earlier.length === 1 ? 'was' : 'were'} withdrawn. Its figures were screened against everything the withdrawn ${earlier.length === 1 ? 'release' : 'releases'} printed, so that nothing new can be worked out by setting them side by side.`);
  return n;
}
/** A release carries these keys only: aggregates, names of programmes and labels (never a client, a date of service or a record). */
const ALLOWED = new Set(['format', 'schema_version', 'county', 'code', 'name', 'period', 'from', 'to', 'method', 'threshold', 'screened_measures', 'exact', 'differencing', 'entered', 'suds_version', 'release_id',
  'programmes', 'coverage', 'source', 'figures_entered_by_the_county', 'counted', 'left_out', 'left_out_without_consent', 'corrects', 'sha256', 'withdrawn', 'rows', 'section', 'group', 'key', 'label', 'money', 'value', 'screened', 'suppressed', 'shown', 'reason', 'why', 'withheld', 'notes']);
function checkAggregate(v) {
  if (Array.isArray(v)) { v.forEach(checkAggregate); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!ALLOWED.has(k)) throw new Error(`a county publication release may not carry ${k}`); checkAggregate(x); }
}

/** Record a prepared release (published). Returns the record. */
function record(prep, { from, to, entered }, user) {
  const id = uuid();
  // Checked again where it is written: two people publishing overlapping periods at once get one release.
  db.transaction(() => {
    // Only the withdrawn releases of exactly this period that its audit was checked against may be there (a corrected
    // release); one published, or withdrawn, since it was prepared was not in its audit.
    const now = overlapping(from, to);
    const checked = new Set((prep.content.corrects || []).map(x => x.sha256));
    const o = now.find(x => !x.withdrawn_at || !checked.has(x.sha256));
    if (o || now.length !== checked.size) refuse('overlap', `A release for ${K.humanPeriod((o || now[0]).period_from, (o || now[0]).period_to)} was published or withdrawn while this one was being prepared: two releases whose periods overlap could be subtracted from each other. Prepare it again.`, 409);
    // Consent, checked again where it is written (integration review of 1.22.0): a programme's consent withdrawn while
    // the release was screened (the audit takes a moment) must not let the release name it.
    const agreed = consents();
    const lost = (prep.inputs.programmes || []).filter(p => !agreed.has(p.id));
    if (lost.length) {
      const e = new PublicationError('no_consent', `The consent to publication of ${lost.map(p => p.name).join('; ')} was withdrawn while this release was being prepared, and the release names ${lost.length === 1 ? 'it' : 'them'}. Prepare it again.`, 409);
      e.programmes = lost.map(p => ({ id: p.id, name: p.name }));
      throw e;
    }
    db.run(`INSERT INTO county_publications(id,kind,period_from,period_to,threshold,entered,method,content,sha256,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id, 'release', from, to, prep.T, entered ? 'include' : 'exclude', JSON.stringify(prep.content.method), K.canonical(prep.content), prep.sha256, user ? user.id : null);
    // What it was screened from, for a corrected release of this period later (encrypted: exact programme figures).
    db.run(`INSERT INTO county_publication_inputs(id,inputs_enc) VALUES(?,?)`, id, encrypt(JSON.stringify(prep.inputs)));
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
    ...(c.left_out_without_consent ? [{ k: 'Left out for lack of consent to publication', v: c.left_out_without_consent.join('; ') }] : []),
    ...(c.corrects ? [{ k: 'Corrects', v: c.corrects.map(x => `the release withdrawn on ${x.withdrawn} (SHA-256 ${x.sha256})`).join('; ') }] : []),
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

module.exports = { prepare, record, withdraw, get, list, sheets, overlapping, inputsOf, countyThreshold, checkAggregate, PublicationError,
  consents, consentHistory, recordConsent, withdrawConsent, WITHOUT_CONSENT, FORMAT, SCHEMA_VERSION, METHOD_NAME, MAX_THRESHOLD, REVIEW_CONFIRMATION };

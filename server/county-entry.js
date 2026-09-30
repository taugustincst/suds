'use strict';
// County-entered figures for grantees not on SUDS (released in 1.20.0; docs/COUNTY-VIEW.md "County-entered figures").
//
// A county funds programmes that run SUDS (their figures arrive as signed files, server/county.js) and some that do
// not. For one that does not, registered "not on SUDS" (county_programmes.on_suds = 0, no key), a person with
// county:manage enters its figures for a period: in a form, or by importing a CSV in the long "tidy" layout the
// county view itself exports (program, period_from, period_to, fund, grant_number, measure_code, measure_label,
// value). Either way the figures are turned into a payload of the SAME allow-list a signed file carries
// (county.js PAYLOAD, checked by checkPayload), stored as a county submission with source 'county_entered', no key
// and no signature, encrypted like a signed one, with who entered it (received_by), when (received_at), how
// (entered_via) and the document it came from (source_ref_enc). From there it is counted by the county view's own
// rule (county.js countingSubs, coverage, filesCount), supersedes and is withdrawn and reinstated by the signed
// files' own paths (resettle, withdraw, reinstate), and every view and file marks it "entered by the county — not
// signed by the program".
//
// Numbers are strict: digits and at most one decimal point (two decimals for money and hours; whole numbers for
// counts), no thousands separators, currency signs, spaces, signs or exponents. Text is held to county.js cleanText.
// Nothing here writes the audit log: routes/county.js does, with ids, periods and hashes, never figures.
const db = require('./db');
const config = require('./config');
const K = require('./county');
const MAP = require('./settlement-outcome-map');
const { encrypt, decrypt, uuid } = require('./crypto');

/**
 * The source column's values: the codes the county view's long CSV and the read API give (signed, county_entered),
 * the words its source_label column (and 1.20.0's first builds) gave, or nothing.
 */
const SOURCE_WORDS = { '': null, signed: 'signed', county_entered: K.ENTERED, 'signed by the program': 'signed', [K.ENTERED_LABEL]: K.ENTERED };
/** The one line a preview or a refusal says about another programme's rows (never read). */
const othersLine = (list) => {
  const n = list.reduce((x, o) => x + o.rows, 0);
  return `${n} row${n === 1 ? '' : 's'} for other programs (${list.slice(0, 5).map(o => o.name).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}) ${n === 1 ? 'was' : 'were'} not read: import each program's figures from its own row of Programs.`;
};
/** The long ("tidy") CSV layout the county view exports (routes/county.js), in order; `source` and `source_label` may follow. */
const CSV_COLUMNS = ['program', 'period_from', 'period_to', 'fund', 'grant_number', 'measure_code', 'measure_label', 'value'];
/** The fund name the tidy export gives a file's totals. */
const TOTAL_FUND = 'All funds in the submission';
const SPEND_CODES = ['spend_own_category', 'spend_other_categories', 'spend_approved', 'spend_pending'];
const TOTAL_CODES = ['spend_approved', 'spend_pending', ...K.VALUE_KEYS];
/**
 * A fund's award (schema version 2; built for 1.21.0, not yet released), optional: its amount, and the award period's
 * first and last days. In the form, three fields per fund; in the long CSV, three measure codes per fund whose value is
 * the amount or a date (YYYY-MM-DD). All three, or none (an empty value is "not given").
 */
const AWARD_MEASURES = [['award_amount', 'Award or contract amount ($)'], ['award_from', 'Award period: first day (YYYY-MM-DD)'], ['award_to', 'Award period: last day (YYYY-MM-DD)']];
const AWARD_CODES = AWARD_MEASURES.map(([c]) => c);
const MAX_CSV_BYTES = 256 * 1024;
const MAX_CSV_ROWS = 5000;
const MAX_PERIODS = 12;
const MAX_FUNDS = 20;
const MAX_ERRORS = 25;
const REF_MAX = 200;

/** A refusal: `code` for the audit log, `message` for the person, `fields` (form) or `errors` (CSV rows) to show where. */
class EntryError extends Error {
  constructor(code, message, { fields = null, errors = null } = {}) { super(message); this.code = code; this.fields = fields; this.errors = errors; }
}

/** What kind of number a measure is: money (2 decimals), hours (2 decimals) or a count (whole). */
const kindOf = (code) => (SPEND_CODES.includes(code) || code === 'award_amount' ? 'money' : code === 'staff_training_hours' ? 'hours' : 'count');
const PATTERN = { money: /^\d{1,12}(\.\d{1,2})?$/, hours: /^\d{1,9}(\.\d{1,2})?$/, count: /^\d{1,12}$/ };
const HINT = {
  money: 'an amount of 0 or more, digits only with up to two decimals (for example 1234.50): no commas, currency signs or spaces',
  hours: 'a number of hours of 0 or more, with up to two decimals (for example 12.5)',
  count: 'a whole number of 0 or more (for example 42): no commas, decimals or spaces',
};
/**
 * A strict number: a JSON number that is finite, not negative and of the right kind, or a string of digits in the
 * pattern for its kind. Returns the number, or throws a sentence (never 0 for something that is not a number).
 */
function strictNumber(raw, code) {
  const kind = kindOf(code);
  let t;
  if (typeof raw === 'number') { if (!Number.isFinite(raw)) throw new Error(`Type ${HINT[kind]}.`); t = String(raw); } else if (typeof raw === 'string') t = raw.trim(); else t = '';
  if (t === '') throw new Error(`Type ${HINT[kind]}; type 0 where the program reported none.`);
  if (!PATTERN[kind].test(t)) throw new Error(`"${t.slice(0, 30)}" is not ${HINT[kind]}.`);
  const n = Number(t);
  if (!Number.isFinite(n) || n > 1e12) throw new Error(`Type ${HINT[kind]}.`);
  return n;
}
const round2 = (n) => Math.round(n * 100) / 100;

/** A period for entered figures: real days, the start on or before the end, and over before today (as a county file's). */
function checkPeriod(from, to, today) {
  const fields = {};
  if (!K.isDay(from)) fields.from = 'must be a real date (YYYY-MM-DD)';
  if (!K.isDay(to)) fields.to = 'must be a real date (YYYY-MM-DD)';
  if (!fields.from && !fields.to) {
    if (from > to) fields.from = `is after the end (${K.humanDay(to)}): choose a start on or before the end`;
    else if (to >= today) fields.to = `is not over yet (${K.humanDay(to)}; today is ${K.humanDay(today)}): figures are entered for a period that has ended`;
  }
  return Object.keys(fields).length ? fields : null;
}

/** The programme the figures are for: registered, not on SUDS, active. Throws EntryError otherwise. */
function programmeFor(id) {
  const p = db.one(`SELECT * FROM county_programmes WHERE id=?`, id);
  if (!p) return null;
  if (p.on_suds !== 0) throw new EntryError('on_suds', `${p.name} runs SUDS and signs its own files: import the files it sends under Submissions. Figures are entered only for a program registered as not on SUDS.`);
  if (!p.active) throw new EntryError('inactive', `${p.name} is not an active program here. Reactivate it under County view › Programs before entering its figures.`);
  return p;
}

/**
 * One fund as entered, checked: { name, grant_number, category, hiaa, spend: { own_category, other_categories,
 * approved, pending }, values }. `f` holds strings or numbers as the form or the CSV gave them; `at(field)` names
 * where a problem goes (a form field, or a CSV cell) and `problems` collects them.
 */
function checkFund(f, at, problems) {
  const name = K.cleanText(f.name, K.TEXT_MAX.fund_name);
  if (!name) problems.push([at('name'), 'is required: the fund\'s name, as the program calls it']);
  else if (name.toLowerCase() === TOTAL_FUND.toLowerCase()) problems.push([at('name'), `cannot be "${TOTAL_FUND}": that is what the long CSV calls the totals`]);
  const grant = K.cleanText(f.grant_number, K.TEXT_MAX.grant_number) || null;
  const category = f.category === undefined || f.category === null || f.category === '' ? 'uncategorised' : K.textOf(f.category);
  if (!K.USE_CODES.has(category)) problems.push([at('category'), 'must be one of the Exhibit E allowable uses offered']);
  const hiaa = f.hiaa === undefined || f.hiaa === null || f.hiaa === '' || f.hiaa === 'none' ? null : K.textOf(f.hiaa);
  if (hiaa !== null && !K.HIAA_CODES.has(hiaa)) problems.push([at('hiaa'), 'must be one of the High Impact Abatement Activities offered']);
  const num = (code) => { try { return strictNumber(f[code], code); } catch (e) { problems.push([at(code), e.message]); return 0; } };
  const own = num('spend_own_category'); const other = num('spend_other_categories'); const pending = num('spend_pending');
  const values = Object.fromEntries(K.VALUE_KEYS.map(k => [k, num(k)]));
  return { name: name || 'Fund', grant_number: grant, category, hiaa, spend: { own_category: own, other_categories: other, approved: round2(own + other), pending }, values, award: checkAward(f, at, problems) };
}
/** A fund's award as entered: null when none of its three fields is given, else all three, checked. */
function checkAward(f, at, problems) {
  const given = (k) => f[k] !== undefined && f[k] !== null && String(f[k]).trim() !== '';
  if (!AWARD_CODES.some(given)) return null;
  const before = problems.length;
  let amount = null;
  if (!given('award_amount')) problems.push([at('award_amount'), 'is needed with the award period: the award or contract amount (or leave the award period empty too)']);
  else { try { amount = strictNumber(f.award_amount, 'award_amount'); if (!(amount > 0)) problems.push([at('award_amount'), 'must be more than 0 (leave the award empty if the program has none)']); } catch (e) { problems.push([at('award_amount'), e.message]); } }
  const day = (k, what) => { const v = given(k) ? String(f[k]).trim() : ''; if (!v) { problems.push([at(k), `is needed with the award amount: the award period's ${what} (YYYY-MM-DD)`]); return null; } if (!K.isDay(v)) { problems.push([at(k), `"${v.slice(0, 20)}" is not a real date (YYYY-MM-DD)`]); return null; } return v; };
  const from = day('award_from', 'first day'); const to = day('award_to', 'last day');
  if (from && to && from > to) problems.push([at('award_from'), `is after the award period's last day (${K.humanDay(to)})`]);
  return problems.length > before ? null : { amount: round2(amount), from, to };
}

/**
 * The payload for entered figures: the same allow-list as a signed file (county.js checkPayload), for this county
 * (its code and name), the programme's name as registered, made now. Categories and the total are worked out from
 * the funds: each category's spending under its own category and its outcomes summed over its funds, the total's
 * spending summed, and its outcomes summed unless `totalValues` (a CSV's own "All funds" rows) gives them.
 */
function payloadFor(prog, period, funds, { totalValues = null, now = new Date().toISOString() } = {}) {
  const sum = (list, pick) => round2(list.reduce((n, x) => n + pick(x), 0));
  const cats = [...new Set(funds.map(f => f.category))].map(key => {
    const fs = funds.filter(f => f.category === key);
    return { key, spend_own_category: sum(fs, f => f.spend.own_category), values: Object.fromEntries(K.VALUE_KEYS.map(k => [k, sum(fs, f => f.values[k])])) };
  });
  const payload = {
    schema_version: K.SCHEMA_VERSION,
    programme: K.cleanText(prog.name, K.TEXT_MAX.programme) || 'Unnamed program',
    recipient: { county_code: K.countyCode().code, county_name: K.cleanText(db.getSetting('org_name', ''), K.TEXT_MAX.county_name) || 'County' },
    period: { from: period.from, to: period.to },
    generated_at: now,
    suds_version: String(config.version),
    counts: 'exact',
    funds: funds.map(f => ({ name: f.name, grant_number: f.grant_number, category: f.category, hiaa: f.hiaa, spend: { ...f.spend }, values: { ...f.values }, award: f.award ? { ...f.award } : null })),
    categories: cats,
    total: { spend: { approved: sum(funds, f => f.spend.approved), pending: sum(funds, f => f.spend.pending) },
      values: totalValues ? { ...totalValues } : Object.fromEntries(K.VALUE_KEYS.map(k => [k, sum(funds, f => f.values[k])])) },
  };
  return payload;
}

/** Store one entry (inside the caller's transaction) and settle which of the programme's files for the period counts. */
function insert(prog, payload, user, { via, ref }) {
  const bytes = K.canonical(payload); const sha256 = K.sha256Hex(bytes);
  const before = db.one(K.CURRENT, prog.id, payload.period.from, payload.period.to);
  const id = uuid();
  db.run(`INSERT INTO county_submissions(id,programme_id,key_id,period_from,period_to,schema_version,programme_name,generated_at,suds_version,payload_enc,sha256,signature,received_at,received_by,source,entered_via,source_ref_enc)
    VALUES(?,?,NULL,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)`,
  id, prog.id, payload.period.from, payload.period.to, payload.schema_version, payload.programme, payload.generated_at, payload.suds_version, encrypt(bytes), sha256, db.now(), user ? user.id : null, K.ENTERED, via, ref ? encrypt(ref) : null);
  const winner = K.resettle(prog.id, payload.period.from, payload.period.to);
  const status = winner !== id ? 'older' : before ? 'superseded' : 'entered';
  return { id, sha256, status, replaced: status === 'superseded' ? before.id : null, replaced_source: status === 'superseded' ? (K.subById(before.id).source || 'signed') : null,
    counting_source: status === 'older' && winner ? (K.subById(winner).source || 'signed') : null };
}

/** The source document's reference: required, cleaned, at most 200 characters. */
function checkRef(raw) {
  const ref = K.cleanText(raw, REF_MAX);
  return ref.length >= 3 ? ref : null;
}

/**
 * Enter a programme's figures for one period from the form: { from, to, source_ref, funds: [{ name, grant_number,
 * category, hiaa, spend_own_category, spend_other_categories, spend_pending, <each outcome> }] }. Field problems are
 * keyed as the form names its fields ("from", "source_ref", "funds.0.contacts"). Returns { programme, submission,
 * status: 'entered' | 'superseded' | 'older', replaced, replaced_source }, or null for an unknown programme.
 */
function enter(programmeId, body, user, { today }) {
  const prog = programmeFor(programmeId);
  if (!prog) return null;
  const b = body && typeof body === 'object' ? body : {};
  const problems = [];
  // K.textOf: a JSON body may carry an object whose toString is not a function ({"toString": 1}), which String()
  // cannot convert: it is no date, refused as one, never a 500 (found by test/county-fuzz.test.js).
  const from = K.textOf(b.from); const to = K.textOf(b.to);
  const pf = checkPeriod(from, to, today);
  if (pf) for (const [k, m] of Object.entries(pf)) problems.push([k, m]);
  const ref = checkRef(b.source_ref);
  if (!ref) problems.push(['source_ref', 'is required: say which document the figures come from (for example "Q2 report emailed 3 July 2026")']);
  const list = Array.isArray(b.funds) ? b.funds : [];
  if (!list.length) problems.push(['funds', 'add at least one fund']);
  if (list.length > MAX_FUNDS) problems.push(['funds', `at most ${MAX_FUNDS} funds`]);
  const funds = list.slice(0, MAX_FUNDS).map((f, i) => checkFund(f && typeof f === 'object' ? f : {}, (k) => `funds.${i}.${k}`, problems));
  const seen = new Set();
  funds.forEach((f, i) => { const k = `${f.name.toLowerCase()}\u0000${(f.grant_number || '').toLowerCase()}`; if (seen.has(k)) problems.push([`funds.${i}.name`, 'is the same fund as one above (the same name and grant number)']); seen.add(k); });
  if (problems.length) {
    const fields = {}; for (const [k, m] of problems) if (!fields[k]) fields[k] = m;
    throw new EntryError('invalid', `Check the figures: ${problems.length} ${problems.length === 1 ? 'field needs' : 'fields need'} attention.`, { fields });
  }
  const payload = payloadFor(prog, { from, to }, funds);
  try { K.checkPayload(payload, { today, now: db.now() }); } catch (e) { if (e instanceof K.SubmissionError) throw new EntryError('schema', e.message); throw e; }
  let out;
  db.transaction(() => { out = insert(prog, payload, user, { via: 'form', ref }); });
  return { programme: prog, submission: K.summary(K.subById(out.id)), status: out.status, replaced: out.replaced, replaced_source: out.replaced_source, counting_source: out.counting_source };
}

// ---- the CSV ---------------------------------------------------------------------------------------------------
/**
 * A cell as exported: the spreadsheet guard's one leading quote (spreadsheet.js toCsv) taken off a cell that begins
 * with quotes before =, +, -, @, a tab or a carriage return (spreadsheet.js UNGUARD). toCsv adds exactly one there,
 * so a name SUDS exported reads back as itself, "'=x" included (test/county-fuzz.test.js, the round trip).
 */
const cellText = (v) => { const t = String(v === undefined || v === null ? '' : v); return require('./spreadsheet').UNGUARD.test(t) ? t.slice(1) : t; };

/**
 * Read a tidy CSV for one programme, as far as can be done without writing: the header, each row (the programme's
 * name, a real period that has ended, a fund, a measure of the allow-list, a strict number), no row twice, and every
 * fund complete. `funds` optionally gives each fund's Exhibit E category and HIAA ([{ name, grant_number, category,
 * hiaa }]; the layout has neither, so the preview asks). Throws EntryError('csv', …, { errors: [{ row, column,
 * message }] }). Returns { periods: [{ from, to, funds, totalValues, payloadFunds }], rows, funds: [the distinct funds] }.
 */
function readCsv(prog, text, { today, funds: choices = [] } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new EntryError('csv', 'Choose a CSV file: the long "tidy" layout County view downloads (program, period_from, period_to, fund, grant_number, measure_code, measure_label, value).');
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) throw new EntryError('csv', `The file is larger than ${MAX_CSV_BYTES / 1024} KB. Import one program's figures for a few periods at a time.`);
  const rows = require('./spreadsheet').parseCsv(text);
  if (!rows.length) throw new EntryError('csv', 'The file has no rows.');
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  const want = CSV_COLUMNS.join(',');
  const extra = head.slice(8).join(',');
  if (!(head.slice(0, 8).join(',') === want && ['', 'source', 'source,source_label'].includes(extra))) {
    throw new EntryError('csv', `The first row must name the columns ${CSV_COLUMNS.join(', ')} (and optionally source and source_label), in that order, as County view's long CSV does. This file's first row is: ${head.slice(0, 10).join(', ').slice(0, 200)}.`);
  }
  const hasSource = head.length > 8;
  const body = rows.slice(1);
  if (!body.length) throw new EntryError('csv', 'The file has a header but no figures.');
  if (body.length > MAX_CSV_ROWS) throw new EntryError('csv', `The file has ${body.length} rows; at most ${MAX_CSV_ROWS} are read at once.`);
  const errors = [];
  const err = (row, column, message) => { if (errors.length < MAX_ERRORS) errors.push({ row, column, message }); };
  const progName = K.cleanText(prog.name, 200).toLowerCase();
  const periods = new Map(); const seen = new Set();
  // Rows of another programme are never read (a county's own long CSV has every programme in it): they are counted,
  // by name, and said once. Rows whose source says "signed" are read (the county may re-enter what it downloaded),
  // and the preview warns that, once imported, they are entered by the county and not signed.
  const others = new Map(); let mine = 0; let signedRows = 0;
  body.forEach((r, i) => {
    const line = i + 2;
    if (r.length !== head.length) { err(line, null, `has ${r.length} columns; the header has ${head.length}. A quote may be missing, or a comma is inside a value that is not quoted.`); return; }
    const [program, from, to, fund, grant, code, , value, source] = r.map(cellText);
    const pname = K.cleanText(program, 200);
    if (pname.toLowerCase() !== progName) { const k = pname || '(no program named)'; others.set(k, (others.get(k) || 0) + 1); return; }
    mine++;
    if (hasSource) {
      const src = SOURCE_WORDS[String(source || '').trim().toLowerCase()];
      if (src === undefined) err(line, 'source', `is "${K.cleanText(source, 40)}": it must be signed or ${K.ENTERED} (or empty).`);
      else if (src === 'signed') signedRows++;
    }
    const pf = checkPeriod(from.trim(), to.trim(), today);
    if (pf) { if (pf.from) err(line, 'period_from', pf.from); if (pf.to) err(line, 'period_to', pf.to); return; }
    const fname = K.cleanText(fund, K.TEXT_MAX.fund_name);
    if (!fname) { err(line, 'fund', 'is empty: name the fund, or "All funds in the submission" for the totals'); return; }
    const gnum = K.cleanText(grant, K.TEXT_MAX.grant_number) || null;
    const isTotal = fname === TOTAL_FUND;
    const mcode = String(code || '').trim();
    const allowed = isTotal ? TOTAL_CODES : [...SPEND_CODES, ...K.VALUE_KEYS, ...AWARD_CODES];
    if (!allowed.includes(mcode)) { err(line, 'measure_code', `"${K.cleanText(mcode, 40)}" is not a measure a county submission carries${isTotal ? ' in its totals' : ''}.`); return; }
    // The award is optional (an empty value is "not given"), and its period is two dates in the value column.
    const isAward = AWARD_CODES.includes(mcode);
    if (isAward && !String(value || '').trim()) return;
    let n = null; let badValue = null;
    if (isAward && mcode !== 'award_amount') { n = String(value).trim(); if (!K.isDay(n)) badValue = `"${n.slice(0, 20)}" is not a real date (YYYY-MM-DD): ${mcode} is the award period's ${mcode === 'award_from' ? 'first' : 'last'} day.`; }
    else { try { n = strictNumber(value, mcode); } catch (e) { badValue = e.message; } }
    const pkey = `${from.trim()}_${to.trim()}`;
    const fkey = isTotal ? '\u0000total' : `${fname.toLowerCase()}\u0000${(gnum || '').toLowerCase()}`;
    const dup = `${pkey}|${fkey}|${mcode}`;
    if (seen.has(dup)) { err(line, 'measure_code', `${mcode} for ${fname} in ${K.humanPeriod(from.trim(), to.trim())} is given twice.`); return; }
    seen.add(dup);
    if (!periods.has(pkey)) periods.set(pkey, { from: from.trim(), to: to.trim(), funds: new Map(), total: {}, firstRow: line });
    const per = periods.get(pkey);
    // A figure that is not a number is said at its cell; its fund (or the totals) is then not checked for being
    // complete, so one mistake is one problem, not also "has no ..." for the same figure.
    if (badValue) { err(line, 'value', badValue); if (isTotal) per.totalBad = true; else { if (!per.funds.has(fkey)) per.funds.set(fkey, { name: fname, grant_number: gnum, m: {}, firstRow: line }); per.funds.get(fkey).bad = true; } return; }
    if (isTotal) { per.total[mcode] = { n, line }; return; }
    if (!per.funds.has(fkey)) per.funds.set(fkey, { name: fname, grant_number: gnum, m: {}, firstRow: line });
    per.funds.get(fkey).m[mcode] = n;
  });
  const otherList = [...others.entries()].map(([name, n]) => ({ name, rows: n }));
  if (!mine && !errors.length) {
    throw new EntryError('csv', `The file has no rows for ${prog.name}${otherList.length ? `: its rows are for ${otherList.slice(0, 5).map(o => o.name).join(', ')}${otherList.length > 5 ? ` and ${otherList.length - 5} more` : ''}` : ''}. The program column must be ${prog.name} exactly, as registered. Nothing was saved.`, { errors: [{ row: 2, column: 'program', message: `is not ${prog.name}` }] });
  }
  if (periods.size > MAX_PERIODS) err(null, 'period_from', `The file has ${periods.size} periods; import at most ${MAX_PERIODS} at once.`);
  // Each fund complete: every outcome, the pending spending, and its spending (own and other categories, or the
  // approved total, which must then equal them).
  const distinct = new Map();
  const out = [];
  for (const per of periods.values()) {
    if (!per.funds.size) { err(per.firstRow, 'fund', `${K.humanPeriod(per.from, per.to)} has totals but no fund's figures.`); continue; }
    const pf = [];
    for (const f of per.funds.values()) {
      if (f.bad) continue;
      const where = `${f.name} in ${K.humanPeriod(per.from, per.to)}`;
      const missing = [...K.VALUE_KEYS, 'spend_pending'].filter(k => f.m[k] === undefined);
      if (f.m.spend_own_category === undefined && f.m.spend_approved === undefined) missing.unshift('spend_own_category (or spend_approved)');
      if (missing.length) { err(f.firstRow, 'measure_code', `${where} has no ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}: every measure is needed (0 where the program reported none).`); continue; }
      let own = f.m.spend_own_category; let other = f.m.spend_other_categories;
      if (own === undefined) { own = round2(f.m.spend_approved - (other || 0)); other = other || 0; if (own < 0) { err(f.firstRow, 'value', `${where}: spent under other categories is more than spent in all.`); continue; } }
      if (other === undefined) other = f.m.spend_approved === undefined ? 0 : round2(f.m.spend_approved - own);
      if (other < 0 || (f.m.spend_approved !== undefined && Math.abs(round2(own + other) - f.m.spend_approved) > 0.005)) { err(f.firstRow, 'value', `${where}: spent, approved or reimbursed (${f.m.spend_approved}) is not the spending under its own category (${own}) plus under other categories (${other}).`); continue; }
      const key = `${f.name.toLowerCase()}\u0000${(f.grant_number || '').toLowerCase()}`;
      if (!distinct.has(key)) distinct.set(key, { name: f.name, grant_number: f.grant_number });
      const pick = choices.find(c => c && K.cleanText(c.name, 200).toLowerCase() === f.name.toLowerCase() && (K.cleanText(c.grant_number, 100) || '').toLowerCase() === (f.grant_number || '').toLowerCase()) || {};
      pf.push({ name: f.name, grant_number: f.grant_number, category: pick.category, hiaa: pick.hiaa, spend_own_category: own, spend_other_categories: other, spend_pending: f.m.spend_pending, ...Object.fromEntries(K.VALUE_KEYS.map(k => [k, f.m[k]])),
        ...Object.fromEntries(AWARD_CODES.filter(k => f.m[k] !== undefined).map(k => [k, f.m[k]])), firstRow: f.firstRow });
    }
    let totalValues = null;
    const t = per.total;
    if (Object.keys(t).length && !per.totalBad) {
      const miss = TOTAL_CODES.filter(k => t[k] === undefined);
      const first = Math.min(...Object.values(t).map(x => x.line));
      if (miss.length) err(first, 'measure_code', `The totals for ${K.humanPeriod(per.from, per.to)} have no ${miss.slice(0, 5).join(', ')}: give every total, or leave the totals out (SUDS then adds the funds up).`);
      else {
        const fundsSum = (k) => round2(pf.reduce((n, f) => n + (k === 'spend_approved' ? f.spend_own_category + f.spend_other_categories : f.spend_pending), 0));
        for (const k of ['spend_approved', 'spend_pending']) if (pf.length === per.funds.size && Math.abs(fundsSum(k) - t[k].n) > 0.005) err(t[k].line, 'value', `The total ${k} for ${K.humanPeriod(per.from, per.to)} (${t[k].n}) is not the funds' ${k} added up (${fundsSum(k)}).`);
        totalValues = Object.fromEntries(K.VALUE_KEYS.map(k => [k, t[k].n]));
      }
    }
    out.push({ from: per.from, to: per.to, funds: pf, totalValues });
  }
  if (errors.length) throw new EntryError('csv', `The file has ${errors.length >= MAX_ERRORS ? `at least ${MAX_ERRORS}` : errors.length} problem${errors.length === 1 ? '' : 's'}${errors.length > 1 ? ` (the first ${Math.min(errors.length, MAX_ERRORS)} listed)` : ''}. Nothing was saved.${otherList.length ? ` ${othersLine(otherList)}` : ''}`, { errors });
  out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const warnings = [];
  if (signedRows) warnings.push(`${signedRows} row${signedRows === 1 ? ' says' : 's say'} "signed" in the source column. Once imported, these figures are ${K.ENTERED_LABEL}: no key of the program signs them.`);
  if (otherList.length) warnings.push(othersLine(otherList));
  return { periods: out, rows: mine, funds: [...distinct.values()], others: otherList, signed_rows: signedRows, warnings };
}

/**
 * Import a tidy CSV for a programme not on SUDS: { text, source_ref, funds: [{ name, grant_number, category, hiaa }],
 * preview }. With `preview`, nothing is written: the periods and funds found (for the person to give each fund its
 * category) and each period's spending and outcomes. Otherwise every period is entered in one transaction (all or
 * nothing), each by the same path as the form. Returns { programme, preview, periods: [...], entries: [...] }, or null.
 */
function importCsv(programmeId, body, user, { today }) {
  const prog = programmeFor(programmeId);
  if (!prog) return null;
  const b = body && typeof body === 'object' ? body : {};
  const parsed = readCsv(prog, b.text, { today, funds: Array.isArray(b.funds) ? b.funds.slice(0, 200) : [] });
  const built = parsed.periods.map((per) => {
    const problems = [];
    const funds = per.funds.map((f) => checkFund(f, (k) => `${f.name}: ${k}`, problems));
    if (problems.length) {
      const award = problems.filter(([c]) => AWARD_CODES.some(k => c.endsWith(`: ${k}`)));
      throw new EntryError('csv', award.length ? `Check each fund's award in ${K.humanPeriod(per.from, per.to)}: give its amount and both days of its award period (award_amount, award_from, award_to), or none of them.` : 'Choose an Exhibit E allowable use and a High Impact Abatement Activity SUDS knows for each fund.',
        { errors: problems.slice(0, MAX_ERRORS).map(([c, m]) => ({ row: (per.funds.find(f => c.startsWith(`${f.name}: `)) || {}).firstRow || null, column: c, message: m })) });
    }
    return { period: { from: per.from, to: per.to }, funds, totalValues: per.totalValues };
  });
  const describe = (x) => ({ from: x.period.from, to: x.period.to, funds: x.funds.map(f => ({ name: f.name, grant_number: f.grant_number, category: f.category, hiaa: f.hiaa, spend_approved: f.spend.approved, spend_pending: f.spend.pending, award: f.award })),
    total: { spend_approved: round2(x.funds.reduce((n, f) => n + f.spend.approved, 0)), spend_pending: round2(x.funds.reduce((n, f) => n + f.spend.pending, 0)), values: x.totalValues || Object.fromEntries(K.VALUE_KEYS.map(k => [k, round2(x.funds.reduce((n, f) => n + f.values[k], 0))])) },
    totals_given: !!x.totalValues });
  const said = { others: parsed.others, warnings: parsed.warnings };
  if (b.preview) return { programme: prog, preview: true, rows: parsed.rows, funds: parsed.funds, periods: built.map(describe), entries: [], ...said };
  const ref = checkRef(b.source_ref);
  if (!ref) throw new EntryError('invalid', 'Say which document the figures come from.', { fields: { source_ref: 'is required: say which document the figures come from (for example "FY 2025-26 report, emailed 3 July 2026")' } });
  const now = new Date().toISOString();
  const payloads = built.map(x => payloadFor(prog, x.period, x.funds, { totalValues: x.totalValues, now }));
  for (const p of payloads) { try { K.checkPayload(p, { today, now: db.now() }); } catch (e) { if (e instanceof K.SubmissionError) throw new EntryError('schema', e.message); throw e; } }
  const entries = [];
  db.transaction(() => { for (const p of payloads) entries.push({ ...insert(prog, p, user, { via: 'csv', ref }), from: p.period.from, to: p.period.to }); });
  return { programme: prog, preview: false, rows: parsed.rows, funds: parsed.funds, periods: built.map(describe), entries: entries.map(e => ({ ...e, submission: K.summary(K.subById(e.id)) })), ...said };
}

/**
 * An entered submission's figures in the form's shape, to correct them (a new entry for the same period, which
 * supersedes this one): { id, programme_id, from, to, source_ref, funds: [...] }. Null for an unknown id or a signed file.
 */
function entryForm(id) {
  const s = K.subById(id);
  if (!s || s.source !== K.ENTERED) return null;
  const pl = JSON.parse(decrypt(s.payload_enc));
  return {
    id: s.id, programme_id: s.programme_id, from: s.period_from, to: s.period_to, status: K.summary(s).status, entered_via: s.entered_via, received_at: s.received_at,
    source_ref: s.source_ref_enc ? decrypt(s.source_ref_enc) : '',
    funds: pl.funds.map(f => ({ name: f.name, grant_number: f.grant_number || '', category: f.category, hiaa: f.hiaa || '', spend_own_category: f.spend.own_category, spend_other_categories: f.spend.other_categories, spend_pending: f.spend.pending, ...f.values,
      award_amount: f.award ? f.award.amount : '', award_from: f.award ? f.award.from : '', award_to: f.award ? f.award.to : '' })),
  };
}
/** The source document's reference of entered submissions, for the county's own list (never in a summary or the read API). */
function sourceRefs(ids) {
  if (!ids.length) return new Map();
  return new Map(db.all(`SELECT id, source_ref_enc FROM county_submissions WHERE source=? AND id IN (SELECT value FROM json_each(?))`, K.ENTERED, JSON.stringify(ids))
    .map(r => [r.id, r.source_ref_enc ? decrypt(r.source_ref_enc) : '']));
}

/** What an entry did, in words. */
function entryMessage(prog, from, to, status, replacedSource, counting = null) {
  const period = K.humanPeriod(from, to);
  if (status === 'superseded') return `Saved ${prog.name}'s figures for ${period}, ${K.ENTERED_LABEL}. They replace the ${replacedSource === K.ENTERED ? 'figures entered earlier' : 'file'} for the same period, which ${replacedSource === K.ENTERED ? 'are' : 'is'} kept but no longer count${replacedSource === K.ENTERED ? '' : 's'}.`;
  if (status === 'older') return `Saved ${prog.name}'s figures for ${period}, but they do not count: ${counting === 'signed' ? 'a signed file for that period counts, and a signed file outranks figures the county entered' : 'figures entered later for that period count'}.`;
  return `Saved ${prog.name}'s figures for ${period}, ${K.ENTERED_LABEL}.`;
}

module.exports = { SOURCE_WORDS, CSV_COLUMNS, TOTAL_FUND, SPEND_CODES, TOTAL_CODES, AWARD_MEASURES, AWARD_CODES, MAX_CSV_BYTES, MAX_PERIODS, MAX_FUNDS, EntryError, strictNumber, kindOf, checkPeriod, readCsv, enter, importCsv, entryForm, sourceRefs, entryMessage, payloadFor, INDICATORS: MAP.INDICATORS };

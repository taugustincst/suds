'use strict';
// Fuzz and property tests for the county surface (docs/security/THREAT-MODEL.md, *County surface*; PEN-TEST-SCOPE.md):
//
//   * the county-entered figures' CSV import (server/county-entry.js readCsv, importCsv; server/spreadsheet.js
//     parseCsv): random bytes, random CSV structure (quotes, embedded newlines, BOM, CRLF/LF, huge cells, duplicate
//     headers), formula-injection strings, Unicode, numbers with commas, signs, NaN, Infinity and exponents, and the
//     source/source_label columns. Properties: nothing but an EntryError is ever thrown; a refusal is structured
//     ({ code, message, errors: [{ row, column, message }] }); a file the model says is invalid is never accepted;
//     an accepted figure is exact (whole counts, cents for money and hours) and its totals are the exact sums; rows
//     of another programme are never read, whatever they hold; and the county view's own tidy CSV, imported again,
//     gives back exactly the figures it was made from (with names that look like formulas, quotes, commas, Unicode).
//   * the entry form's payload validation (county-entry.js enter): random JSON of every type in every field, objects
//     whose toString is not a function (JSON can carry {"toString": 1}); accepted figures are exactly the ones typed.
//   * the signed county file's verifier (county.js parseFile, importParsed): flipped bytes, a changed signature, a
//     fingerprint swapped for another programme's, an unregistered key, hostile payloads re-signed with the right
//     key; only a file whose payload and signature are the original's (re-serialised) is ever taken, as a duplicate.
//   * the county connection's request parsing (county-connect.js bearer, lookup; county-connect-client.js
//     checkBaseUrl, countyFromStatus, periodProblem) and the push route with random tokens and bodies.
//
// Seeded and repeatable: SUDS_FUZZ_SEED=<n> replays a run (a failure names its seed and iteration). The default run
// is small and fast (a fixed seed); SUDS_THOROUGH=1 (the `thorough` CI job, scripts/test-thorough.js) runs many more
// iterations with a fresh seed, and SUDS_FUZZ_ITERATIONS=<n> sets the base count by hand. Node built-ins only.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const H = require('./helpers');
const K = require('../server/county');
const E = require('../server/county-entry');
const S = require('../server/spreadsheet');
const CC = require('../server/county-connect');
const CL = require('../server/county-connect-client');
const SAMPLE = require('../scripts/county-sample');
const { rateLimitReset } = require('../server/app');

const THOROUGH = process.env.SUDS_THOROUGH === '1';
const BASE = Number(process.env.SUDS_FUZZ_ITERATIONS) > 0 ? Math.floor(Number(process.env.SUDS_FUZZ_ITERATIONS)) : THOROUGH ? 3000 : 150;
const SEED = process.env.SUDS_FUZZ_SEED !== undefined && process.env.SUDS_FUZZ_SEED !== '' ? Number(process.env.SUDS_FUZZ_SEED) >>> 0
  : THOROUGH ? crypto.randomInt(2 ** 31) : 0x5d5c0417;

// ---- a seeded generator (mulberry32), one stream per test so tests do not shift each other's inputs ----
function rngFor(name) {
  let a = (SEED ^ crypto.createHash('sha256').update(name).digest().readUInt32LE(0)) >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = {
    next, int: (n) => Math.floor(next() * n), chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bytes: (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256); return b; },
    shuffle: (arr) => { const a2 = [...arr]; for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
    str: (max, alphabet) => { const n = Math.floor(next() * (max + 1)); let s = ''; for (let i = 0; i < n; i++) s += alphabet[Math.floor(next() * alphabet.length)]; return s; },
  };
  return r;
}
/** Runs `n` iterations of `fn(rng, i)`, naming the seed and iteration of the first failure. */
function fuzz(name, n, fn) {
  const rng = rngFor(name);
  for (let i = 0; i < n; i++) {
    try { fn(rng, i); } catch (e) { e.message = `[${name}] seed ${SEED} iteration ${i}: ${e.message}`; throw e; }
  }
}
async function fuzzAsync(name, n, fn) {
  const rng = rngFor(name);
  for (let i = 0; i < n; i++) {
    try { await fn(rng, i); } catch (e) { e.message = `[${name}] seed ${SEED} iteration ${i}: ${e.message}`; throw e; }
  }
}

// ---- building blocks ----
/** Text an attacker or a careless spreadsheet puts in a cell. */
const NASTY = ['=cmd|\' /C calc\'!A0', '=HYPERLINK("http://x.example","y")', '+1+1', '-1', '@SUM(A1:A9)', '\t=1', '\r=1', '\'=1', '\'\'=1', '\'+x', '"', '""', '","', ',', '\n', '\r\n', '\r', '﻿',
  '‮evil', '⁦x⁩', '\u0000', '\u0007', ' ', 'é', '日本語', '𝟙𝟚', '١٢٣', 'Ｏｎｅ', ' ', '  x  ', 'All funds in the submission', 'all funds in the submission', 'NaN', 'Infinity', '-Infinity',
  '-0', '1e3', '1E3', '0x10', '1,000', '1 000', '$5', '5$', '1.234', '.5', '5.', '+5', '−5', '0.1e1', '1_000', '00012', '9'.repeat(13), '9'.repeat(12) + '.999', '12.5.1', ' 12', '1 000',
  '<script>alert(1)</script>', '../../etc/passwd', 'x'.repeat(300), 'null', 'undefined', 'true', '[object Object]', '__proto__', 'constructor', 'toString'];
const FORMULA_TEXT = ['=cmd|\' /C calc\'!A0', '+Fund', '-Fund', '@Fund', '=1+1', '\'=already guarded', '\'+x', '\'-x', '\'@x', '\'\'=x'];
const kindOf = E.kindOf;
const MEASURES = [...E.SPEND_CODES.filter(c => c !== 'spend_approved'), ...K.VALUE_KEYS];
/** An independent statement of the documented number rule (docs/COUNTY-VIEW.md): digits, a point and up to two decimals for money and hours, whole numbers for counts. */
function refNumber(raw, code) {
  const kind = kindOf(code);
  let t;
  if (typeof raw === 'number') { if (!Number.isFinite(raw)) return null; t = String(raw); } else if (typeof raw === 'string') t = raw.trim(); else return null;
  const int = kind === 'hours' ? 9 : 12;
  const m = new RegExp(`^([0-9]{1,${int}})${kind === 'count' ? '' : '(\\.[0-9]{1,2})?'}$`).exec(t);
  return m ? Number(t) : null;
}
/** A valid figure for a measure, as { text, cents } (cents: the value times 100, exact). */
function validFigure(rng, code) {
  const kind = kindOf(code);
  if (kind === 'count') { const n = rng.pick([0, 1, 7, rng.int(1000), rng.int(1e6), rng.int(1e9), 99999999999]); return { text: String(n), cents: n * 100 }; } // at most 11 digits: three funds' sum stays under the 10^12 cap
  const whole = rng.pick([0, 1, rng.int(100), rng.int(1e5), kind === 'money' ? rng.int(1e9) : rng.int(1e6)]);
  const dec = rng.pick(['', '', '.5', '.05', '.50', '.99', `.${rng.int(10)}`, `.${String(rng.int(100)).padStart(2, '0')}`]);
  const cents = whole * 100 + (dec ? (dec.length === 2 ? Number(dec[1]) * 10 : Number(dec.slice(1))) : 0);
  return { text: `${whole}${dec}`, cents };
}
/** A figure that is not a strict number of its kind (checked against refNumber, so the list cannot drift). */
function invalidFigure(rng, code) {
  for (;;) {
    const t = rng.chance(0.7) ? rng.pick(['1,000', '$5', '1e3', '1E3', '-1', '-0', '+5', '0x10', 'NaN', 'Infinity', '-Infinity', '1.234', '.5', '5.', '1 000', '١٢٣', '𝟙', '12.5.1', '9'.repeat(13), '=1+1', '1_0', '−5', '', ' ', 'x', '0.001', `${rng.int(99)}.${rng.int(9)}${rng.int(9)}${rng.int(9)}`])
      : rng.str(8, '0123456789.,-+eE $xN ');
    if (refNumber(t, code) === null) return t;
  }
}
/** Text whose cleaned, lower-cased form is not `taken`'s: another programme's name. */
function otherName(rng, taken) {
  for (;;) {
    const n = rng.chance(0.5) ? `Other ${rng.str(12, 'abcXYZ =+-@,"\'\n é')}` : rng.pick(NASTY);
    if (K.cleanText(n, 200).toLowerCase() !== K.cleanText(taken, 200).toLowerCase()) return n;
  }
}
/** A value for a failure message, whatever it is ({"toString": 1} cannot be turned into text by String()). */
const describe = (v) => { try { return JSON.stringify(v); } catch { return Object.prototype.toString.call(v); } };
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
/** A period that has ended, well before today. */
function pastPeriod(rng) {
  const end = Date.now() - (40 + rng.int(700)) * 86400000;
  return { from: dayOf(end - rng.int(120) * 86400000), to: dayOf(end) };
}
/** A CSV cell, quoted as a spreadsheet may quote it (always, when needed, or with the export's formula guard). */
function cell(rng, v) {
  const t = String(v);
  const needs = /[",\r\n]/.test(t) || /^\s|\s$/.test(t);
  if (/^'*[=+\-@\t\r]/.test(t)) return `"'${t.replace(/"/g, '""')}"`; // the export's guard (spreadsheet.js toCsv FORMULA_START): one more quote, taken off again on import
  if (needs || rng.chance(0.2)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}
/**
 * A model of one programme's figures for 1-3 periods and 1-3 funds, and the tidy CSV that carries it, with other
 * programmes' rows (junk figures included) mixed in. Returns { csv, model, rowsMine }.
 */
function modelCsv(rng, progName, { others = true, source = rng.pick(['', 'source', 'source,source_label']), totals = rng.chance(0.5) } = {}) {
  const periods = [];
  const nP = 1 + rng.int(3); const used = new Set();
  while (periods.length < nP) { const p = pastPeriod(rng); const k = `${p.from}_${p.to}`; if (!used.has(k)) { used.add(k); periods.push(p); } }
  const header = [...E.CSV_COLUMNS, ...(source ? source.split(',') : [])];
  const rows = []; let mine = 0;
  const model = periods.map(p => {
    const nF = 1 + rng.int(3); const names = new Set(); const funds = [];
    while (funds.length < nF) {
      let name = K.cleanText(rng.chance(0.4) ? rng.pick(FORMULA_TEXT.concat(NASTY)) : `Fund ${rng.str(6, 'abcdefgh ')}`, 200) || 'Fund';
      if (name.toLowerCase() === E.TOTAL_FUND.toLowerCase()) name = 'Fund total-ish';
      const grant = rng.chance(0.3) ? '' : K.cleanText(rng.chance(0.3) ? rng.pick(NASTY) : `G-${rng.int(1000)}`, 100);
      const key = `${name.toLowerCase()}\u0000${grant.toLowerCase()}`;
      if (names.has(key)) continue; names.add(key);
      const figs = Object.fromEntries(MEASURES.map(c => [c, validFigure(rng, c)]));
      funds.push({ name, grant, figs });
    }
    return { ...p, funds };
  });
  const sourceCells = () => (source === '' ? [] : source === 'source' ? [rng.pick(['', 'signed', 'county_entered', 'SIGNED', ' county_entered '])] : [rng.pick(['', 'signed', 'county_entered']), rng.pick(['', 'signed by the program', K.ENTERED_LABEL, 'anything at all'])]);
  for (const p of model) {
    for (const f of p.funds) {
      for (const c of MEASURES) { rows.push([progName, p.from, p.to, f.name, f.grant, c, 'label', f.figs[c].text, ...sourceCells()]); mine++; }
      if (rng.chance(0.5)) { const cents = f.figs.spend_own_category.cents + f.figs.spend_other_categories.cents; rows.push([progName, p.from, p.to, f.name, f.grant, 'spend_approved', 'label', centsText(cents), ...sourceCells()]); mine++; }
    }
    if (totals) {
      const sum = (c) => p.funds.reduce((n, f) => n + f.figs[c].cents, 0);
      const tot = { spend_approved: sum('spend_own_category') + sum('spend_other_categories'), spend_pending: sum('spend_pending'), ...Object.fromEntries(K.VALUE_KEYS.map(k => [k, sum(k)])) };
      p.totals = tot;
      for (const [c, cents] of Object.entries(tot)) { rows.push([progName, p.from, p.to, E.TOTAL_FUND, '', c, 'label', centsText(cents, kindOf(c) === 'count'), ...sourceCells()]); mine++; }
    }
  }
  if (others) {
    const n = rng.int(20);
    for (let i = 0; i < n; i++) rows.push([otherName(rng, progName), rng.pick([pastPeriod(rng).from, 'not a date', '2099-01-01']), rng.pick(['2099-12-31', pastPeriod(rng).to, '']), rng.pick(NASTY), rng.pick(NASTY), rng.pick([...MEASURES, 'client_name', 'dob']), rng.pick(NASTY), rng.pick([...NASTY, '999999999999']), ...sourceCells()]);
  }
  const eol = rng.pick(['\r\n', '\n']);
  const lines = [header.map(h => (rng.chance(0.2) ? h.toUpperCase() : h)).map(h => cell(rng, h)).join(','), ...rng.shuffle(rows).map(r => r.map(v => cell(rng, v)).join(','))];
  const csv = (rng.chance(0.3) ? '﻿' : '') + lines.join(eol) + (rng.chance(0.5) ? eol : '');
  return { csv, model, rowsMine: mine, header };
}
function centsText(cents, whole = false) { if (whole) return String(cents / 100); return cents % 100 === 0 ? String(cents / 100) : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`; }

/** A refusal is structured: an EntryError with a code, a sentence, and (for a CSV) the places it found. */
function assertRefusal(e) {
  if (!(e instanceof E.EntryError)) throw new Error(`threw something other than an EntryError: ${e && e.stack}`);
  assert.ok(['csv', 'invalid', 'schema', 'on_suds', 'inactive'].includes(e.code), `refusal code ${e.code}`);
  assert.equal(typeof e.message, 'string'); assert.ok(e.message.length > 0 && e.message.length < 2000, 'a refusal is one bounded sentence or two');
  if (e.errors !== null) {
    assert.ok(Array.isArray(e.errors) && e.errors.length <= 25, 'at most 25 places named');
    for (const x of e.errors) {
      assert.ok(x.row === null || (Number.isInteger(x.row) && x.row >= 1), `row ${x.row}`);
      assert.ok(x.column === null || typeof x.column === 'string', 'column');
      assert.equal(typeof x.message, 'string');
      assert.ok(x.message.length < 600, 'a place\'s message is bounded (it quotes at most a few characters of what was typed)');
    }
  }
  if (e.fields !== null) { assert.equal(typeof e.fields, 'object'); for (const m of Object.values(e.fields)) assert.equal(typeof m, 'string'); }
}
/** What readCsv accepted holds only strict numbers of each kind, and periods that are real and over. */
function assertAcceptedShape(out, today) {
  for (const p of out.periods) {
    assert.ok(K.isDay(p.from) && K.isDay(p.to) && p.from <= p.to && p.to < today, `period ${p.from} ${p.to}`);
    for (const f of p.funds) {
      for (const c of ['spend_own_category', 'spend_other_categories', 'spend_pending', ...K.VALUE_KEYS]) {
        const v = f[c];
        assert.ok(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12, `${c} = ${v}`);
        if (kindOf(c) === 'count') assert.ok(Number.isInteger(v), `${c} is whole`); else assert.match(String(v), /^[0-9]+(\.[0-9]{1,2})?$/, `${c} has at most two decimals`);
      }
    }
  }
}

let today; let admin; let COUNTY;
const insertProgramme = (name, { onSuds = 0, active = 1 } = {}) => { const id = crypto.randomUUID(); H.db.run(`INSERT INTO county_programmes(id,name,active,keep_files,on_suds) VALUES(?,?,?,0,?)`, id, name, active, onSuds); return { id, name, active, on_suds: onSuds }; };
before(async () => {
  await H.start();
  H.db.setSetting('org_name', 'Fuzz Test County');
  today = require('../server/routes/budget').localDate();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  COUNTY = { county_code: K.countyCode().code, county_name: 'Fuzz Test County' };
});
after(async () => { await H.stop(); });
beforeEach(() => { for (const t of ['county_connect_tokens', 'county_submissions', 'county_programme_keys', 'county_programmes']) H.db.run(`DELETE FROM ${t}`); });

test('the run\'s seed and size (SUDS_FUZZ_SEED replays it)', (t) => { t.diagnostic(`seed ${SEED}, base iterations ${BASE}${THOROUGH ? ' (thorough)' : ''}`); });

// ------------------------------------------------------------------------------------------------ the CSV parser
test('CSV import: random bytes and random CSV structure never throw anything but a structured refusal', () => {
  const prog = { name: 'Valley Outreach Collective' };
  const alphabet = ['a', 'Z', '0', '9', '.', ',', '"', '\'', '\r', '\n', '\r\n', ' ', '\t', '=', '+', '-', '@', '﻿', 'é', '‮', '\u0000', ...E.CSV_COLUMNS.map(c => `${c},`), 'Valley Outreach Collective', '2025-01-01', ...MEASURES];
  fuzz('csv-random', BASE * 4, (rng) => {
    let text;
    const shape = rng.int(4);
    if (shape === 0) text = rng.bytes(rng.int(600)).toString(rng.pick(['utf8', 'latin1']));
    else if (shape === 1) text = rng.str(400, alphabet);
    else if (shape === 2) text = `${E.CSV_COLUMNS.join(',')}\n${rng.str(400, alphabet)}`;
    else { const { csv } = modelCsv(rng, prog.name); const b = Buffer.from(csv); for (let k = 0, n = 1 + rng.int(4); k < n; k++) b[rng.int(b.length)] = rng.int(256); text = b.toString('utf8'); }
    try { const out = E.readCsv(prog, text, { today }); assertAcceptedShape(out, today); } catch (e) { assertRefusal(e); }
  });
  // Very large inputs: over the byte cap, over the row cap, one huge cell, duplicate header columns.
  const big = (s) => { try { E.readCsv(prog, s, { today }); assert.fail('accepted'); } catch (e) { assertRefusal(e); return e; } };
  assert.match(big('a'.repeat(E.MAX_CSV_BYTES + 1)).message, /larger than/);
  assert.match(big(`${E.CSV_COLUMNS.join(',')}\n${`V,2025-01-01,2025-03-31,F,,contacts,l,1\n`.repeat(5001)}`).message, /at most 5000/);
  big(`${E.CSV_COLUMNS.join(',')}\n${prog.name},2025-01-01,2025-03-31,"${'x'.repeat(200000)}",,contacts,l,1`);
  big(`${E.CSV_COLUMNS.join(',')},value\n${prog.name},2025-01-01,2025-03-31,F,,contacts,l,1,2`);
  big(`program,program,period_to,fund,grant_number,measure_code,measure_label,value\n${prog.name},${prog.name},2025-03-31,F,,contacts,l,1`);
  big('"unclosed quote,' + 'x'.repeat(1000));
});

test('CSV import: a valid file is read exactly, whatever the quoting, line ends, BOM, source columns and other programmes\' rows', () => {
  const prog = { name: rngFor('csv-valid-name').pick(['Valley Outreach Collective', '=Valley Outreach', '+1 Outreach, "Inc"', 'Ünïcødé Outreach', '-Minus Outreach']) };
  fuzz('csv-valid', BASE, (rng) => {
    const { csv, model, rowsMine } = modelCsv(rng, prog.name);
    let out;
    try { out = E.readCsv(prog, csv, { today }); } catch (e) { throw new Error(`a valid file was refused: ${e.message} ${JSON.stringify(e.errors)}\n${csv.slice(0, 2000)}`); }
    assertAcceptedShape(out, today);
    assert.equal(out.rows, rowsMine, 'every row of the programme read, and only those');
    assert.equal(out.periods.length, model.length);
    for (const want of model) {
      const got = out.periods.find(p => p.from === want.from && p.to === want.to);
      assert.ok(got, `period ${want.from}`);
      assert.equal(got.funds.length, want.funds.length, 'the funds of the programme, and only those');
      for (const wf of want.funds) {
        const gf = got.funds.find(f => f.name === wf.name && (f.grant_number || '') === wf.grant);
        assert.ok(gf, `fund ${JSON.stringify(wf.name)} / ${JSON.stringify(wf.grant)} (got ${JSON.stringify(got.funds.map(f => [f.name, f.grant_number]))})`);
        for (const c of MEASURES) assert.equal(gf[c], wf.figs[c].cents / 100, `${c}: exactly the figure typed`);
      }
      if (want.totals) for (const k of K.VALUE_KEYS) assert.equal(got.totalValues[k], want.totals[k] / 100, `total ${k}`);
      else assert.equal(got.totalValues, null);
    }
  });
});

test('CSV import: a file with one invalid figure, measure, row or period is never accepted', () => {
  const prog = { name: 'Valley Outreach Collective' };
  const kinds = ['value', 'measure', 'drop', 'duplicate', 'future', 'reversed', 'columns', 'header', 'total_mismatch', 'total_fund_name'];
  fuzz('csv-invalid', BASE * 2, (rng) => {
    const { model, header } = modelCsv(rng, prog.name, { others: false, source: '' , totals: false });
    // Rebuild the rows so a known one can be broken.
    const rows = [];
    for (const p of model) for (const f of p.funds) for (const c of MEASURES) rows.push([prog.name, p.from, p.to, f.name, f.grant, c, 'label', f.figs[c].text]);
    const kind = rng.pick(kinds);
    const i = rng.int(rows.length);
    if (kind === 'value') rows[i][7] = invalidFigure(rng, rows[i][5]);
    else if (kind === 'measure') rows[i][5] = rng.pick(['client_name', 'dob', 'ssn', 'contacts_', 'Contacts', 'spend', '', 'people_served_x', '__proto__', 'constructor']);
    else if (kind === 'drop') { const j = rows.findIndex((r, k) => k >= i && [...K.VALUE_KEYS, 'spend_pending'].includes(r[5])); rows.splice(j >= 0 ? j : rows.findIndex(r => r[5] === 'contacts'), 1); }
    else if (kind === 'duplicate') rows.push([...rows[i]]);
    else if (kind === 'future') { const p = rows[i][1]; for (const r of rows) if (r[1] === p) { r[2] = rng.pick([today, '2999-12-31']); } }
    else if (kind === 'reversed') { const p = rows[i][1]; const to = rows[i][2]; for (const r of rows) if (r[1] === p && r[2] === to) { r[1] = to; r[2] = p; } if (rows[i][1] === rows[i][2]) rows[i][1] = 'not-a-day'; }
    else if (kind === 'columns') rows[i].push(rng.pick(['x', '', '1']));
    else if (kind === 'total_mismatch') { const p = model[0]; const approved = p.funds.reduce((n, f) => n + f.figs.spend_own_category.cents + f.figs.spend_other_categories.cents, 0) + 1 + rng.int(100);
      rows.push([prog.name, p.from, p.to, E.TOTAL_FUND, '', 'spend_approved', 'l', centsText(approved)], [prog.name, p.from, p.to, E.TOTAL_FUND, '', 'spend_pending', 'l', centsText(p.funds.reduce((n, f) => n + f.figs.spend_pending.cents, 0))],
        ...K.VALUE_KEYS.map(k => [prog.name, p.from, p.to, E.TOTAL_FUND, '', k, 'l', '0'])); }
    else if (kind === 'total_fund_name') rows[i][3] = E.TOTAL_FUND; // a fund's row moved into totals that are then incomplete
    let head = header.join(',');
    if (kind === 'header') head = rng.pick([rng.shuffle(E.CSV_COLUMNS).join(','), E.CSV_COLUMNS.slice(0, 7).join(','), `${E.CSV_COLUMNS.join(',')},extra`, E.CSV_COLUMNS.join(';'), `x${head}`]);
    if (kind === 'header' && head === E.CSV_COLUMNS.join(',')) head = `${head},surplus`;
    const csv = [head, ...rows.map(r => r.map(v => cell(rng, v)).join(','))].join('\r\n');
    try { E.readCsv(prog, csv, { today }); } catch (e) { assertRefusal(e); return; }
    assert.fail(`a file with a broken ${kind} was accepted:\n${csv.slice(0, 1500)}`);
  });
});

test('CSV import: strictNumber is exactly the documented rule, for strings and JSON numbers of every kind', () => {
  fuzz('strict-number', BASE * 20, (rng) => {
    const code = rng.pick(MEASURES);
    const raw = rng.pick([() => rng.pick(NASTY), () => rng.str(16, '0123456789.,-+eE xN ٠０'), () => validFigure(rng, code).text, () => invalidFigure(rng, code),
      () => rng.pick([0, -0, 1, -1, 0.1, 0.25, 1.005, 1e12, 1e12 + 1, 1e21, 1e-7, NaN, Infinity, -Infinity, 2 ** 53, 123456.78, rng.next() * 1e6, Math.floor(rng.next() * 1e9)]),
      () => rng.pick([null, undefined, true, false, [], [1], {}, { toString: 1 }])])();
    const want = refNumber(raw, code);
    let got = null;
    try { got = E.strictNumber(raw, code); } catch (e) { assert.ok(!(e instanceof E.EntryError) && e instanceof Error && typeof e.message === 'string'); got = null; }
    assert.equal(got, want, `${code} ${describe(raw)} (${typeof raw}): got ${got}, rule says ${want}`);
  });
});

// ------------------------------------------------------------------------------------- the entry form's payload
/** A random JSON value, of any type, including objects whose toString or valueOf is not a function. */
function randomJson(rng, depth = 0) {
  const k = rng.int(depth > 2 ? 6 : 9);
  if (k === 0) return null;
  if (k === 1) return rng.chance(0.5);
  if (k === 2) return rng.pick([0, -1, 1.5, 1e21, 123, -0.001, 2 ** 53]);
  if (k === 3 || k === 4) return rng.pick(NASTY);
  if (k === 5) return rng.str(10, 'abc0123.,-');
  if (k === 6) return Array.from({ length: rng.int(3) }, () => randomJson(rng, depth + 1));
  if (k === 7) return rng.pick([{ toString: 1 }, { valueOf: 'x', toString: [] }, { toString: null }, JSON.parse('{"__proto__": {"x": 1}}'), { length: 1e9 }]);
  const o = {}; for (let i = rng.int(4); i > 0; i--) o[rng.pick(['name', 'x', 'toString', 'constructor', '0'])] = randomJson(rng, depth + 1); return o;
}
function validFormFund(rng, i) {
  const figs = Object.fromEntries(MEASURES.map(c => [c, validFigure(rng, c)]));
  return { fund: { name: `Fund ${i} ${rng.pick(FORMULA_TEXT)}`, grant_number: rng.chance(0.5) ? `G-${i}` : '', category: rng.pick(['core_h', 'core_a', 'uncategorised', '']), hiaa: rng.pick(['hiaa_4', 'none', '', null]),
    ...Object.fromEntries(MEASURES.map(c => [c, rng.chance(0.8) ? figs[c].text : Number(figs[c].text)])) }, figs };
}
test('entry form: random JSON in every field is refused with a structured refusal, never a crash; accepted figures are exactly those typed', () => {
  const prog = insertProgramme('Form Fuzz Outreach');
  let accepted = 0; let refused = 0;
  fuzz('entry-form', BASE * 3, (rng) => {
    const nF = 1 + rng.int(2);
    const made = Array.from({ length: nF }, (_, i) => validFormFund(rng, i));
    const period = pastPeriod(rng);
    const body = { from: period.from, to: period.to, source_ref: 'Quarterly report emailed', funds: made.map(m => ({ ...m.fund })) };
    // Break 0-3 things, anywhere, with any JSON value.
    const breaks = rng.int(4); const broken = [];
    for (let b = 0; b < breaks; b++) {
      const where = rng.int(4);
      if (where === 0) { const k = rng.pick(['from', 'to', 'source_ref', 'funds']); body[k] = randomJson(rng); broken.push(k); }
      else if (where === 1 && Array.isArray(body.funds) && body.funds.length) { const f = rng.pick(body.funds); if (f && typeof f === 'object') { const k = rng.pick(['name', 'grant_number', 'category', 'hiaa', ...MEASURES]); f[k] = randomJson(rng); broken.push(`funds.${k}`); } }
      else if (where === 2 && Array.isArray(body.funds)) { body.funds.push(randomJson(rng)); broken.push('funds[]'); }
      else { broken.push('none'); }
    }
    const input = rng.chance(0.05) ? randomJson(rng) : body;
    let out;
    try { out = E.enter(prog.id, input, null, { today }); } catch (e) { assertRefusal(e); refused++; return; }
    accepted++;
    assert.ok(out && out.submission, 'an entry');
    const s = K.subById(out.submission.id);
    assert.equal(s.source, K.ENTERED); assert.equal(s.key_id, null); assert.equal(s.signature, null);
    const pl = JSON.parse(require('../server/crypto').decrypt(s.payload_enc));
    K.checkPayload(pl, { today }); // the stored payload is exactly the allow-list
    // Every accepted figure is the strict reading of what was typed (the reference rule), never a coerced one.
    const funds = input.funds;
    assert.equal(pl.funds.length, funds.length);
    pl.funds.forEach((pf, i) => {
      for (const c of MEASURES) {
        const want = refNumber(funds[i][c], c);
        assert.notEqual(want, null, `accepted ${c} = ${JSON.stringify(funds[i][c])}, which is not a strict number (broken: ${broken})`);
        const have = c === 'spend_own_category' ? pf.spend.own_category : c === 'spend_other_categories' ? pf.spend.other_categories : c === 'spend_pending' ? pf.spend.pending : pf.values[c];
        assert.equal(have, want, c);
      }
      assert.equal(pf.spend.approved, Math.round((pf.spend.own_category + pf.spend.other_categories) * 100) / 100);
    });
    // The total is the exact sum, in cents.
    const cents = (x) => Math.round(x * 100);
    assert.equal(cents(pl.total.spend.approved), pl.funds.reduce((n, f) => n + cents(f.spend.approved), 0));
    for (const k of K.VALUE_KEYS) assert.equal(cents(pl.total.values[k]), pl.funds.reduce((n, f) => n + cents(f.values[k]), 0), k);
  });
  assert.ok(accepted > 0 && refused > 0, `both accepted (${accepted}) and refused (${refused}) entries were exercised`);
});

// --------------------------------------------------------------------------------- export, then import: stable
test('the county view\'s tidy CSV, imported again, gives back exactly the figures it was made from; no export cell is a formula', async () => {
  await fuzzAsync('round-trip', Math.max(8, Math.floor(BASE / 10)), async (rng, i) => {
    H.db.run(`DELETE FROM county_submissions`); H.db.run(`DELETE FROM county_programmes`);
    rateLimitReset('api:127.0.0.1'); // a thorough run makes more requests a minute than the per-address API limit allows
    const nameA = K.cleanText(`${rng.pick(['', ...FORMULA_TEXT, '"Quoted", Inc', 'Ünïcødé'])} Outreach ${i}`, 200);
    const A = insertProgramme(nameA); const B = insertProgramme(K.cleanText(`${rng.pick(FORMULA_TEXT)} Neighbour ${i}`, 200));
    const period = pastPeriod(rng);
    const entered = {};
    for (const p of [A, B]) {
      const made = Array.from({ length: 1 + rng.int(3) }, (_, k) => validFormFund(rng, k));
      for (const m of made) { m.fund.name = K.cleanText(`${rng.pick([...FORMULA_TEXT, ...NASTY.filter(x => K.cleanText(x, 200) && K.cleanText(x, 200).toLowerCase() !== E.TOTAL_FUND.toLowerCase())])} ${made.indexOf(m)}`, 200); m.fund.grant_number = rng.chance(0.5) ? K.cleanText(rng.pick([...FORMULA_TEXT, 'G-1, "x"']), 100) : ''; }
      const out = E.enter(p.id, { ...period, source_ref: '=cmd|\' /C calc\'!A0 report', funds: made.map(m => m.fund) }, null, { today });
      entered[p.id] = JSON.parse(require('../server/crypto').decrypt(K.subById(out.submission.id).payload_enc));
    }
    for (const format of ['tidy', 'csv']) {
      const r = await admin.get(`/api/county/view/export?from=${period.from}&to=${period.to}&format=${format}`);
      assert.equal(r.status, 200, String(r.data).slice(0, 300));
      const cells = S.parseCsv(r.data).flat();
      for (const c of cells) assert.ok(!/^[=+\-@\t\r]/.test(c), `an exported cell starts like a formula: ${JSON.stringify(c)}`);
      if (format !== 'tidy') continue;
      // Import A's figures from the export (B's rows are there too, and must not be read).
      const pre = E.importCsv(A.id, { text: r.data, preview: true }, null, { today });
      assert.deepEqual(pre.others.map(o => o.name), [B.name], 'the other programme\'s rows are counted, by name, and not read');
      assert.equal(pre.periods.length, 1);
      const want = entered[A.id];
      const got = pre.periods[0];
      assert.deepEqual(got.funds.map(f => [f.name, f.grant_number || null, f.spend_approved, f.spend_pending]), want.funds.map(f => [f.name, f.grant_number, f.spend.approved, f.spend.pending]), 'the funds and their spending, exactly');
      assert.deepEqual(got.total.values, want.total.values, 'the totals, exactly');
      const imp = E.importCsv(A.id, { text: r.data, source_ref: 'from the export', funds: want.funds.map(f => ({ name: f.name, grant_number: f.grant_number, category: f.category, hiaa: f.hiaa })) }, null, { today });
      const again = JSON.parse(require('../server/crypto').decrypt(K.subById(imp.entries[0].id).payload_enc));
      const strip = (pl) => ({ ...pl, generated_at: null });
      assert.deepEqual(strip(again), strip(want), 'the imported payload is the exported one, field for field');
    }
    // The Excel file: every text cell is an inline string, never a formula.
    const x = await admin.raw(`/api/county/view/export?from=${period.from}&to=${period.to}&format=xlsx`);
    assert.equal(x.status, 200);
    for (const [name, data] of require('../server/importers/text').unzip(Buffer.from(await x.arrayBuffer()))) if (/worksheets\/sheet/.test(name)) assert.ok(!/<f[ >]/.test(data.toString('utf8')), `${name} holds a formula`);
    // The read API's tidy CSV: the same guard.
    CC.saveSettings({ enabled: true });
    try {
      const { token, row } = CC.issue({ scope: CC.SCOPES.read, name: 'Fuzz warehouse', user: null });
      const res = await fetch(`${await baseUrl()}/api/county-connect/v1/combined?from=${period.from}&to=${period.to}&format=tidy-csv`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.text();
      assert.equal(res.status, 200, body.slice(0, 200));
      for (const c of S.parseCsv(body).flat()) assert.ok(!/^[=+\-@\t\r]/.test(c), `a read API cell starts like a formula: ${JSON.stringify(c)}`);
      rateLimitReset(`county-connect-token:${row.id}`); rateLimitReset('county-connect:127.0.0.1'); rateLimitReset('county-connect:*');
    } finally { CC.saveSettings({ enabled: false }); }
  });
});

// ------------------------------------------------------------------------------------------- the signed file
test('signed county file: tampered bytes, signature, fingerprint or key are never accepted; re-serialising is a duplicate', () => {
  const [a, b] = SAMPLE.sample({ periods: SAMPLE.lastQuarters(today, 1), recipient: COUNTY });
  const A = insertProgramme(a.name, { onSuds: 1 }); const B = insertProgramme(b.name, { onSuds: 1 });
  for (const [p, s] of [[A, a], [B, b]]) H.db.run(`INSERT INTO county_programme_keys(id,programme_id,public_key,fingerprint) VALUES(?,?,?,?)`, crypto.randomUUID(), p.id, s.public_key, s.fingerprint);
  const file = a.files[0].file; const text = JSON.stringify(file, null, 2);
  const want = K.canonical(file.payload); const wantSig = Buffer.from(file.signature.value, 'base64');
  const first = K.importParsed(K.parseFile(text, { today, now: new Date().toISOString() }), null, { countyCode: COUNTY.county_code });
  assert.equal(first.status, 'imported');
  const outsider = crypto.createHash('sha256').update('fuzz-outsider').digest();
  const tries = (t) => { try { return K.importParsed(K.parseFile(t, { today, now: new Date().toISOString() }), null, { countyCode: COUNTY.county_code }); } catch (e) { if (!(e instanceof K.SubmissionError)) throw new Error(`threw ${e && e.stack}`); assert.equal(typeof e.code, 'string'); return { refused: e.code }; } };
  const counts = { refused: 0, duplicate: 0 };
  fuzz('signed-file', BASE * 4, (rng) => {
    const m = rng.int(8); let t;
    if (m === 0) { const buf = Buffer.from(text); for (let k = 0, n = 1 + rng.int(3); k < n; k++) buf[rng.int(buf.length)] = rng.int(256); t = buf.toString('utf8'); }
    else if (m === 1) { const f = structuredClone(file); const v = f.signature.value.split(''); v[rng.int(86)] = rng.pick([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/']); f.signature.value = v.join(''); t = JSON.stringify(f); }
    else if (m === 2) { const f = structuredClone(file); f.signature.key_fingerprint = rng.pick([b.fingerprint, K.formatFingerprint(b.fingerprint), crypto.randomBytes(16).toString('hex')]); t = JSON.stringify(f); }
    else if (m === 3) { t = JSON.stringify(K.signWithSeed(structuredClone(file.payload), outsider).file); }
    else if (m === 4) { const f = structuredClone(file); mutatePayload(rng, f.payload); t = JSON.stringify(f); } // changed after signing
    else if (m === 5) { const f = structuredClone(file); f[rng.pick(['format', 'schema_version', 'signature', 'payload', 'extra'])] = randomJson(rng); t = JSON.stringify(f); }
    else if (m === 6) { t = JSON.stringify(reorder(rng, structuredClone(file)), null, rng.pick([0, 1, '\t', ' \n '.trim() || 2])); } // the same file, other layout
    else { const f = structuredClone(file); f.signature.algorithm = rng.pick(['ed25519', 'Ed448', 'RS256', 'none', '']); t = JSON.stringify(f); }
    const out = tries(t);
    if (out.refused) { counts.refused++; return; }
    counts.duplicate++;
    assert.equal(out.status, 'duplicate', `a changed file was taken as ${out.status} (mutation ${m})`);
    const f = JSON.parse(t);
    assert.equal(K.canonical(f.payload), want, 'only the signed payload itself');
    assert.ok(Buffer.from(f.signature.value, 'base64').equals(wantSig), 'only the signature itself');
  });
  assert.ok(counts.refused > 0 && counts.duplicate > 0, JSON.stringify(counts));
  // Nothing but the one import is stored.
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 1);
});

function reorder(rng, v) {
  if (Array.isArray(v)) return v.map(x => reorder(rng, x));
  if (v && typeof v === 'object') return Object.fromEntries(rng.shuffle(Object.keys(v)).map(k => [k, reorder(rng, v[k])]));
  return v;
}
/** One change somewhere in a payload: a value of another type or size, a field added or removed. */
function mutatePayload(rng, p) {
  const paths = [];
  const walk = (o, path) => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { paths.push([...path, k]); walk(o[k], [...path, k]); } };
  walk(p, []);
  const path = rng.pick(paths); const parent = path.slice(0, -1).reduce((o, k) => o[k], p); const key = path[path.length - 1];
  const m = rng.int(4);
  if (m === 0) parent[key] = randomJson(rng);
  else if (m === 1) delete parent[key];
  else if (m === 2 && parent && typeof parent === 'object' && !Array.isArray(parent)) parent[rng.pick(['client_name', 'dob', 'extra', '__proto__x'])] = rng.pick(NASTY);
  else parent[key] = typeof parent[key] === 'number' ? rng.pick([parent[key] + 1, -1, 1e13, 0.1 + 0.2, parent[key] === 0 ? 1 : 0]) : typeof parent[key] === 'string' ? `${parent[key]}${rng.pick(['‮', ' ', 'x', '\u0000'])}` : randomJson(rng);
}

test('signed county file: hostile payloads signed with the programme\'s own key are refused unless they are exactly the allow-list', () => {
  const [a] = SAMPLE.sample({ periods: SAMPLE.lastQuarters(today, 1), recipient: COUNTY });
  const A = insertProgramme(a.name, { onSuds: 1 });
  H.db.run(`INSERT INTO county_programme_keys(id,programme_id,public_key,fingerprint) VALUES(?,?,?,?)`, crypto.randomUUID(), A.id, a.public_key, a.fingerprint);
  const seed = crypto.createHash('sha256').update(`suds-county-sample:${a.slug}`).digest();
  const base = a.files[0].file.payload;
  let taken = 0; let refused = 0;
  fuzz('signed-hostile', BASE * 3, (rng) => {
    const p = structuredClone(base); for (let k = 0, n = 1 + rng.int(3); k < n; k++) mutatePayload(rng, p);
    // Signed as-is (signWithSeed would refuse an invalid payload: sign the canonical bytes directly, as an attacker holding the key would).
    let bytes; try { bytes = K.canonical(p); } catch { return; }
    const sig = crypto.sign(null, Buffer.from(bytes), require('../server/signing').privateKeyFrom(seed)).toString('base64');
    const t = JSON.stringify({ format: K.FORMAT, schema_version: K.SCHEMA_VERSION, payload: p, signature: { algorithm: K.ALGORITHM, key_fingerprint: a.fingerprint, value: sig } });
    let out;
    try { out = K.importParsed(K.parseFile(t, { today, now: new Date().toISOString() }), null, { countyCode: COUNTY.county_code }); }
    catch (e) { if (!(e instanceof K.SubmissionError)) throw new Error(`threw ${e && e.stack}`); refused++; return; }
    taken++;
    // Taken: then it is exactly a county submission payload, by an independent reading of the allow-list.
    assert.deepEqual(Object.keys(p).sort(), K.PAYLOAD.top);
    const amounts = [];
    const collect = (o) => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'number') amounts.push([k, v]); else if (v && typeof v === 'object') collect(v); } };
    collect({ total: p.total, funds: p.funds, categories: p.categories });
    for (const [k, v] of amounts) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1e12, `${k} = ${v}`);
    for (const f of p.funds) { assert.deepEqual(Object.keys(f).sort(), K.PAYLOAD.fund); assert.deepEqual(Object.keys(f.values).sort(), K.PAYLOAD.values); assert.ok(typeof f.name === 'string' && f.name === K.cleanText(f.name, 200) && f.name); }
    assert.ok(['imported', 'superseded', 'older', 'duplicate'].includes(out.status));
  });
  assert.ok(refused > 0, `refused ${refused}, taken ${taken}`);
  // Deeply nested JSON at the size cap does not crash the parser.
  for (const deep of ['['.repeat(200000), `{"format":"${K.FORMAT}","payload":${'['.repeat(100000)}${']'.repeat(100000)}}`]) {
    assert.throws(() => K.parseFile(deep, { today }), (e) => e instanceof K.SubmissionError);
  }
});

test('a pasted public key: random bytes, mutated PEMs and private keys are refused with a sentence; an accepted one is Ed25519 with its own fingerprint', () => {
  const [a] = SAMPLE.sample({ periods: SAMPLE.lastQuarters(today, 1), recipient: COUNTY });
  const priv = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  fuzz('public-key', BASE * 2, (rng) => {
    const m = rng.int(5); let t;
    if (m === 0) t = rng.bytes(rng.int(200)).toString('latin1');
    else if (m === 1) { const c = a.public_key.split(''); for (let k = 0, n = 1 + rng.int(3); k < n; k++) c[rng.int(c.length)] = rng.pick([...'ABCDEFabcdef0123456789+/=\n -']); t = c.join(''); }
    else if (m === 2) t = rng.pick([priv, rsa, `${a.public_key}\n${priv}`, a.public_key.replace('PUBLIC', 'PRIVATE'), 'x'.repeat(3000)]);
    else if (m === 3) t = rng.pick([a.public_key, `  ${a.public_key}\n\n`, a.public_key.replace(/\n/g, '\r\n')]);
    else t = rng.pick(NASTY);
    let k;
    try { k = K.parsePublicKey(t); } catch (e) { assert.ok(e instanceof Error && typeof e.message === 'string' && e.message.length < 400); assert.ok(!/BEGIN PRIVATE/.test(e.message)); return; }
    assert.equal(crypto.createPublicKey(k.pem).asymmetricKeyType, 'ed25519');
    assert.equal(k.fingerprint, K.fingerprintOf(k.pem));
    if (k.fingerprint !== a.fingerprint) assert.ok(m === 1 || m === 0, 'only a changed key has another fingerprint'); // a changed PEM that still decodes is another key: registering it needs its fingerprint read out
  });
});

// ------------------------------------------------------------------------------------ the county connection
test('county connection: the bearer header, token lookup, the county\'s /status answer and its periods are parsed strictly', () => {
  const prog = insertProgramme('Connect Fuzz Outreach', { onSuds: 1 });
  const { token } = CC.issue({ scope: CC.SCOPES.submit, programmeId: prog.id, user: null });
  const chars = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/= .\t\r\n:', 'Bearer ', 'bearer ', 'Basic ', token.slice(0, 20), '\u0000', 'é'];
  fuzz('bearer', BASE * 10, (rng) => {
    const h = rng.chance(0.3) ? `Bearer ${token.slice(0, rng.int(token.length + 1))}${rng.str(3, chars)}` : rng.chance(0.2) ? token : rng.str(60, chars);
    const b = CC.bearer({ headers: { authorization: h } });
    if (b !== null) { assert.match(b, /^[A-Za-z0-9_-]{20,200}$/); assert.equal(`Bearer ${b}`, h); }
    const r = CC.lookup({ headers: { authorization: h } });
    if (r.token && !r.refused) assert.equal(h, `Bearer ${token}`, 'only the exact token is found');
    else assert.ok(['no_token', 'unknown_token'].includes(r.refused), r.refused);
  });
  fuzz('county-from-status', BASE * 5, (rng) => {
    const v = rng.chance(0.3) ? { code: rng.pick([COUNTY.county_code, K.formatCode(COUNTY.county_code), 'ilo0-abcd', ...NASTY]), name: rng.pick([...NASTY, 'Fuzz County', null]) } : randomJson(rng);
    let out;
    try { out = CL.countyFromStatus(v); } catch (e) { assert.ok(e instanceof CL.ConnectError, `threw ${e && e.stack}`); assert.equal(e.reason, 'bad_answer'); return; }
    assert.ok(out.code === null || /^[0-9A-HJKMNP-TV-Z]{8}$/.test(out.code), `code ${out.code}`);
    assert.ok(out.name === null || (typeof out.name === 'string' && out.name === K.cleanText(out.name, 200) && out.name.length <= 200), `name ${JSON.stringify(out.name)}`);
  });
  const allowed = CL.cadencePeriods('quarterly_calendar', today);
  fuzz('period-problem', BASE * 5, (rng) => {
    const p = rng.chance(0.3) ? rng.pick(allowed) : rng.chance(0.5) ? { from: rng.pick([...NASTY, pastPeriod(rng).from, '2026-02-30']), to: rng.pick([...NASTY, pastPeriod(rng).to, today, '2999-01-01']) } : randomJson(rng);
    const why = CL.periodProblem(p, allowed, today);
    if (why === null) assert.ok(allowed.some(x => x.from === p.from && x.to === p.to), 'only a period of the cadence is sent automatically');
    else assert.equal(typeof why, 'string');
  });
  fuzz('base-url', BASE * 5, (rng) => {
    const u = rng.pick([() => rng.pick(NASTY), () => `${rng.pick(['https://', 'http://', 'ftp://', 'javascript:', 'file:///', '//', 'https:/'])}${rng.pick(['suds.county.example', '127.0.0.1', 'localhost', '10.0.0.7', '169.254.169.254', '[::1]', '0.0.0.0', 'user:pw@x.example', 'x.example?t=1', 'x.example#f', 'metadata.google.internal', '[::ffff:127.0.0.1]', '0x7f.1'])}${rng.pick(['', '/', '/suds/', ':8443'])}`, () => rng.str(40, 'htps:/.@?#[]:1270xlocalhost')])();
    let out;
    try { out = CL.checkBaseUrl(u); } catch (e) { assert.ok(e instanceof CL.ConnectError, `threw ${e && e.stack}`); return; }
    const x = new URL(out);
    assert.ok(x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname)), out);
    assert.ok(!x.username && !x.password && !x.search && !x.hash, out);
  });
});

test('county connection: the push route answers random tokens and bodies with 401, 404, 413, 422 or 429, never a crash or an import', async () => {
  const [a] = SAMPLE.sample({ periods: SAMPLE.lastQuarters(today, 1), recipient: COUNTY });
  const prog = insertProgramme(a.name, { onSuds: 1 });
  H.db.run(`INSERT INTO county_programme_keys(id,programme_id,public_key,fingerprint) VALUES(?,?,?,?)`, crypto.randomUUID(), prog.id, a.public_key, a.fingerprint);
  CC.saveSettings({ enabled: true });
  const { token, row } = CC.issue({ scope: CC.SCOPES.submit, programmeId: prog.id, user: null });
  const text = JSON.stringify(a.files[0].file);
  const reset = () => { for (const k of ['county-connect-bad:127.0.0.1', 'county-connect-bad:*', 'county-connect:127.0.0.1', 'county-connect:*', `county-connect-token:${row.id}`, `county-connect-refused:${row.id}`]) rateLimitReset(k); };
  try {
    await fuzzAsync('push', Math.max(20, Math.floor(BASE / 3)), async (rng) => {
      reset();
      const auth = rng.pick([`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, `Bearer ${CC.PREFIX['county.read']}${token.slice(7)}`, '', 'Bearer', `bearer ${token}`, rng.str(40, 'Bearer xyz_-0123')]);
      let body;
      const m = rng.int(4);
      if (m === 0) { const b = Buffer.from(text); b[rng.int(b.length)] = rng.int(256); body = b; }
      else if (m === 1) body = rng.bytes(rng.int(2000));
      else if (m === 2) body = JSON.stringify(randomJson(rng));
      else body = text;
      const res = await fetch(`${await baseUrl()}/api/county-connect/v1/submissions`, { method: 'POST', headers: { 'Content-Type': rng.pick(['application/json', 'text/plain', 'application/octet-stream']), ...(auth ? { Authorization: auth } : {}) }, body });
      const answer = await res.text();
      assert.ok([200, 201, 400, 401, 403, 413, 415, 422, 429].includes(res.status), `status ${res.status}: ${answer.slice(0, 200)}`);
      assert.ok(!/at .*\.js:\d+/.test(answer), 'no stack trace in an answer');
      if (res.status === 201 || res.status === 200) { assert.equal(auth, `Bearer ${token}`); const d = JSON.parse(answer); assert.ok(['imported', 'duplicate'].includes(d.status)); }
    });
    assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n <= 1, true, 'only the one real file is ever kept');
  } finally { CC.saveSettings({ enabled: false }); reset(); }
});
let baseCache = null;
async function baseUrl() { if (!baseCache) baseCache = await H.start(); return baseCache; }

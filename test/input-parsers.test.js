'use strict';
// Typed time/date parsing (1.24.3): public/input-parsers.js is import-free, so it loads
// in node through a data: URL the way test/nav-menu.test.js loads public/nav.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let P;
test('input-parsers loads', async () => {
  P = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '..', 'public', 'input-parsers.js')).toString('base64'));
  assert.equal(typeof P.parseTime, 'function');
  assert.equal(typeof P.parseDate, 'function');
  assert.equal(typeof P.fmtMDY, 'function');
});

test('parseTime: the formats people actually type', () => {
  const cases = [
    ['14:30', '14:30'], ['2:30', '02:30'], ['09:05', '09:05'],
    ['2:30p', '14:30'], ['2:30 pm', '14:30'], ['2:30PM', '14:30'], ['2:30p.m.', '14:30'],
    ['12:30a', '00:30'], ['12:30p', '12:30'],
    ['930', '09:30'], ['1430', '14:30'], ['0930', '09:30'],
    ['14.30', '14:30'], ['2.30pm', '14:30'],
  ];
  for (const [input, want] of cases) assert.equal(P.parseTime(input), want, JSON.stringify(input));
});

test('parseTime: rejects what is not a time', () => {
  for (const input of ['', '   ', 'abc', '9', '2p', '12a', '25:00', '24:00', '13:99', '2:60', '2400', '13p', '0p', '14:30:99x', 'noon'])
    assert.equal(P.parseTime(input), null, JSON.stringify(input));
});

test('parseDate: the formats people actually type', () => {
  const cases = [
    ['10/5/2026', '2026-10-05'], ['10/05/2026', '2026-10-05'], ['1/2/2026', '2026-01-02'],
    ['10-05-2026', '2026-10-05'], ['10.5.26', '2026-10-05'], ['10/5/26', '2026-10-05'],
    ['2026-10-05', '2026-10-05'], ['2026-1-5', '2026-01-05'],
    ['20261005', '2026-10-05'],
    [' 10/5/2026 ', '2026-10-05'],
  ];
  for (const [input, want] of cases) assert.equal(P.parseDate(input), want, JSON.stringify(input));
});

test('parseDate: rejects impossible and malformed dates', () => {
  for (const input of ['', '   ', 'abc', '13/1/2026', '0/5/2026', '2/30/2026', '2/29/2026', '2026-13-01', '2026-02-30', '10/5', '2026/10/05', '5-Oct-2026'])
    assert.equal(P.parseDate(input), null, JSON.stringify(input));
  // 2024 was a leap year: Feb 29 parses there.
  assert.equal(P.parseDate('2/29/2024'), '2024-02-29');
});

test('fmtMDY: ISO in, M/D/YYYY out', () => {
  assert.equal(P.fmtMDY('2026-10-05'), '10/5/2026');
  assert.equal(P.fmtMDY(''), '');
  assert.equal(P.fmtMDY(null), '');
  assert.equal(P.fmtMDY('not a date'), 'not a date');
});

test('app.js imports and re-exports the parsers (single source of truth)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /from '\.\/input-parsers\.js'/);
  assert.match(src, /export \{ parseTime, parseDate, fmtMDY \}/);
  assert.ok(!src.includes('export function parseTime('), 'no duplicate parseTime in app.js');
  assert.ok(!src.includes('export function parseDate('), 'no duplicate parseDate in app.js');
});

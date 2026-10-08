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
    // An hour alone (evaluation of 1.25.0, E8): with am/pm, or bare on the 24-hour clock as "930" is.
    ['2pm', '14:00'], ['2 pm', '14:00'], ['2p', '14:00'], ['2P.M.', '14:00'], ['9am', '09:00'], ['9 a', '09:00'],
    ['12a', '00:00'], ['12pm', '12:00'], ['11pm', '23:00'],
    ['9', '09:00'], ['09', '09:00'], ['14', '14:00'], ['0', '00:00'], ['23', '23:00'],
  ];
  for (const [input, want] of cases) assert.equal(P.parseTime(input), want, JSON.stringify(input));
});

test('parseTime: rejects what is not a time', () => {
  for (const input of ['', '   ', 'abc', '24', '99', '25:00', '24:00', '13:99', '2:60', '2400', '13p', '0p', '00am', '13pm', '123456', 'p', '9x', '14:30:99x', 'noon'])
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

test('parseDate: a two-digit year slides, into the past only for a field that is never in the future (F2)', () => {
  // Evaluation of 1.25.0, E8: a date of birth typed "7/9/81" was read as 2081 and refused as in the future.
  // Evaluation of 1.25.1, F2: a consent's expiry typed "10/1/28" was read as 1928 and refused.
  const in2026 = new Date(2026, 9, 8);
  for (const [input, want] of [['7/9/81', '1981-07-09'], ['3/4/15', '2015-03-04'], ['1/1/00', '2000-01-01'], ['10/5/26', '2026-10-05'],
    ['12/31/27', '2027-12-31'], ['10/1/28', '2028-10-01'], ['10/1/30', '2030-10-01'], ['1/1/46', '2046-01-01'], ['1/1/47', '1947-01-01'],
    ['6.1.99', '1999-06-01'], ['2/29/28', '2028-02-29']]) assert.equal(P.parseDate(input, in2026), want, `${input}: a forward window of 20 years`);
  for (const [input, want] of [['7/9/81', '1981-07-09'], ['10/5/26', '2026-10-05'], ['1/5/27', '1927-01-05'], ['1/1/46', '1946-01-01'], ['3/4/15', '2015-03-04']])
    assert.equal(P.parseDate(input, in2026, { past: true }), want, `${input}: a date of birth`);
  assert.equal(P.parseDate('1/1/47', new Date(2027, 0, 1)), '2047-01-01', 'the window moves with the year');
  assert.equal(P.parseDate('1/1/99', new Date(2098, 5, 1)), '2099-01-01');
  assert.equal(P.parseDate('1/1/00', new Date(2099, 5, 1)), '2100-01-01', 'at the end of a century, 00 is the next one ahead');
  assert.equal(P.parseDate('1/1/00', new Date(2099, 5, 1), { past: true }), '2000-01-01', 'and this one for a date of birth');
  assert.equal(P.parseDate('7/9/1981', in2026), '1981-07-09', 'four digits are taken as written');
  assert.equal(P.parseDate('7/9/2081', in2026, { past: true }), '2081-07-09');
  assert.equal(P.fullYear(28, 2026), 2028); assert.equal(P.fullYear(28, 2026, true), 1928);
});

test('a date box reads a two-digit year by its field: into the past when its max is today (F2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /const past = !!f\.past \|\| \(!!f\.max && f\.max <= fmt\.today\(\)\)/);
  assert.match(src, /parseDate\(t, new Date\(\), opts\)/);
});

test('parseDate: rejects impossible and malformed dates', () => {
  for (const input of ['', '   ', 'abc', '13/1/2026', '0/5/2026', '2/30/2026', '2/29/2026', '2026-13-01', '2026-02-30', '13/5', '2/30', '2026/10/05', '5-Oct-2026'])
    assert.equal(P.parseDate(input), null, JSON.stringify(input));
  // 2024 was a leap year: Feb 29 parses there.
  assert.equal(P.parseDate('2/29/2024'), '2024-02-29');
});

test('parseDate: a month and day alone is this year\'s, or the nearest past or next one by field (FL3)', () => {
  const oct8 = new Date(2026, 9, 8, 21, 0);
  for (const [input, want] of [['10/8', '2026-10-08'], ['10/15', '2026-10-15'], ['1/5', '2026-01-05'], ['12-31', '2026-12-31'], ['3.4', '2026-03-04']])
    assert.equal(P.parseDate(input, oct8), want, input);
  assert.equal(P.parseDate('10/8', oct8, { past: true }), '2026-10-08', 'today is not the future');
  assert.equal(P.parseDate('10/15', oct8, { past: true }), '2025-10-15', 'a date of birth or a date given: the last one');
  assert.equal(P.parseDate('1/5', oct8, { past: true }), '2026-01-05');
  assert.equal(P.parseDate('10/8', oct8, { future: true }), '2026-10-08', 'today is a follow-up date');
  assert.equal(P.parseDate('1/5', oct8, { future: true }), '2027-01-05', 'a follow-up: the next one');
  assert.equal(P.parseDate('10/15', oct8, { future: true }), '2026-10-15');
  assert.equal(P.parseDate('2/29', new Date(2027, 0, 1)), null, 'no February 29th this year');
  assert.equal(P.parseDate('2/29', new Date(2028, 0, 1)), '2028-02-29');
});

test('a date box looks ahead for a due or follow-up date (FL3)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /future: !past && \(!!f\.future \|\| !!f\.quick \|\| \(!!f\.min && f\.min >= fmt\.today\(\)\)\)/);
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

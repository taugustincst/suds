'use strict';
// The browser suite waits for conditions, not for time (scripts/ui/assert.mjs until, settle, saved): a fixed
// wait is a guess that a slow runner loses, and passes on a fast one whatever the page did. A wait of 300 ms or
// more is allowed only where time passing is the point (proving something does NOT happen, outlasting a debounce
// that exposes nothing to wait on, waiting for the clock), and then says so on its line: `// intentional: <why>`.
// Both forms are found: `page.waitForTimeout(N)` and the sleep `new Promise(r => setTimeout(r, N))` (the second
// since 1.16.3; engineering review of 1.16.2, L2), in the script or in the page. The waits below are in files
// this check does not edit, each with the reason it stays: replace one with a condition and remove it here; add
// none.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'scripts', 'ui');
const ALLOWED = [
  // [file, the line as it stands, why it stays]
  ['a11y-round4.mjs', 'await page.waitForTimeout(300);', 'proves the live region is NOT filled after a dialog opens: nothing to wait on'],
  ['setup-same-origin.mjs', 'await page.waitForTimeout(1500); // long enough for a redirect loop to show itself in the count', 'proves a redirect loop does NOT happen'],
  ['assert.mjs', 'await new Promise(r => setTimeout(r, every));', 'the poll interval of until(), the condition wait itself'],
  ['accessibility.mjs', 'await new Promise(r => setTimeout(r, 400));', 'a poll: waits while the last minute\'s API requests are near the server\'s rate limit'],
];
const MIN_MS = 300;

/** Every fixed wait of at least MIN_MS (a literal, or anything else: a variable hides the length) not marked intentional. */
function fixedWaits(file, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const waits = [...line.matchAll(/waitForTimeout\(\s*([^)]*)\)/g)].map((m) => m[1]);
    // new Promise(r => setTimeout(r, N)), new Promise((resolve) => setTimeout(resolve, N)): a sleep by another name.
    for (const m of line.matchAll(/new Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*setTimeout\(\s*\1\s*,\s*([^)]*)\)/g)) waits.push(m[2]);
    for (const w of waits) {
      const n = Number(w);
      if (Number.isFinite(n) && n < MIN_MS) continue;
      if (/\/\/\s*intentional:/.test(line)) continue;
      if (ALLOWED.some(([f, t]) => f === file && t === line.trim())) continue;
      out.push(`scripts/ui/${file}:${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

test('the browser suite has no new fixed wait of 300 ms or more that does not say why (a condition wait instead)', () => {
  const found = fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs')).flatMap((f) => fixedWaits(f, fs.readFileSync(path.join(DIR, f), 'utf8')));
  assert.deepEqual(found, [], 'wait for a condition (until, settle, saved in scripts/ui/assert.mjs), or mark the line "// intentional: <why>"');
});

test('the fixed-wait check finds one, and lets an intentional one or a short one through', () => {
  assert.equal(fixedWaits('x.mjs', 'await page.waitForTimeout(700);').length, 1);
  assert.equal(fixedWaits('x.mjs', 'await page.waitForTimeout(ms);').length, 1, 'a length it cannot read counts');
  assert.equal(fixedWaits('x.mjs', 'await page.waitForTimeout(700); // intentional: nothing to wait on').length, 0);
  assert.equal(fixedWaits('x.mjs', 'await page.waitForTimeout(100);').length, 0);
  // The sleep written as a promise (1.16.3), in the script or inside page.evaluate.
  assert.equal(fixedWaits('x.mjs', 'await new Promise(r => setTimeout(r, 1000));').length, 1);
  assert.equal(fixedWaits('x.mjs', 'await new Promise((resolve) => setTimeout(resolve, 900));').length, 1);
  assert.equal(fixedWaits('x.mjs', 'page.evaluate(async () => { await new Promise(r => { setTimeout(r, every); }); });').length, 1, 'a length it cannot read counts');
  assert.equal(fixedWaits('x.mjs', 'await new Promise(r => setTimeout(r, 250));').length, 0);
  assert.equal(fixedWaits('x.mjs', 'await new Promise(r => setTimeout(r, 1200)); // intentional: outlasting a slowed render').length, 0);
  assert.equal(fixedWaits('x.mjs', 'Promise.race([p, new Promise((r) => setTimeout(() => r(false), 5000))])').length, 0, 'a time limit on a condition is not a sleep');
  // The allowlist still names lines that exist: one gone from its file is removed from the list.
  for (const [f, t, why] of ALLOWED) assert.ok(why && why.length > 10, `${f}: "${t}" says why it stays`);
  for (const [f, t] of ALLOWED) assert.ok(fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').some((l) => l.trim() === t), `${f}: "${t}" is no longer there; remove it from ALLOWED`);
});

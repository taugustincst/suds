'use strict';
// The browser suite waits for conditions, not for time (scripts/ui/assert.mjs until, settle, saved): a fixed
// wait is a guess that a slow runner loses, and passes on a fast one whatever the page did. A wait of 300 ms or
// more is allowed only where time passing is the point (proving something does NOT happen, outlasting a debounce
// that exposes nothing to wait on), and then says so on its line: `// intentional: <why>`. The waits below were
// there before this check (1.16.2; engineering review of 1.16.1, L2) and are its allowlist, by file and line text:
// replace one with a condition and remove it here; add none.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'scripts', 'ui');
const ALLOWED = [
  ['a11y-round4.mjs', 'await page.waitForTimeout(300);'],
  ['setup-same-origin.mjs', 'await page.waitForTimeout(1500); // long enough for a redirect loop to show itself in the count'],
  ['ux13.mjs', 'await page.waitForTimeout(1000);'],
  ['ux13.mjs', "await page.check('[data-shortcuts-on]'); await page.waitForTimeout(1000);"],
];
const MIN_MS = 300;

/** Every fixed wait of at least MIN_MS (a literal, or anything else: a variable hides the length) not marked intentional. */
function fixedWaits(file, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/waitForTimeout\(\s*([^)]*)\)/g)) {
      const n = Number(m[1]);
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
  // The allowlist still names lines that exist: one gone from its file is removed from the list.
  for (const [f, t] of ALLOWED) assert.ok(fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').some((l) => l.trim() === t), `${f}: "${t}" is no longer there; remove it from ALLOWED`);
});

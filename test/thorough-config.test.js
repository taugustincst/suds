'use strict';
// Performance checks live in test/thorough/ and run in CI's required `thorough` job, not in `npm test`,
// where the whole suite runs in parallel and an absolute timing budget flakes on a busy runner.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('npm test does not run test/thorough; the thorough run finds it and every test with a thorough mode', () => {
  const pkg = require('../package.json');
  assert.match(pkg.scripts.test, /"test\/\*\.test\.js"/, 'npm test runs test/*.test.js only');
  assert.ok(!/\*\*/.test(pkg.scripts.test), 'a recursive glob would pull test/thorough into npm test');
  const files = require('../scripts/test-thorough').thoroughFiles();
  assert.ok(files.includes('test/publication-release.test.js'), 'the full-size disclosure sweeps');
  assert.ok(files.includes('test/publication-release-funds.test.js'), 'the combined-funds families at T = 3 and 5');
  assert.ok(files.includes('test/thorough/perf.test.js') && files.includes('test/thorough/funder-perf.test.js'));
  for (const f of fs.readdirSync(path.join(root, 'test', 'thorough'))) assert.ok(f.endsWith('.test.js'), `${f}: test/thorough holds tests only`);
});

test('the thorough CI job runs the thorough set with SUDS_THOROUGH=1 and is required by the release gate', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = ci.slice(ci.indexOf('\n  thorough:'), ci.indexOf('\n  browser:'));
  assert.match(job, /SUDS_THOROUGH: '1'/);
  assert.match(job, /node scripts\/test-thorough\.js/);
  assert.ok(!/continue-on-error/.test(job));
  assert.ok(require('../scripts/release-gate').REQUIRED_JOBS.includes('thorough'));
});

test('no test outside test/thorough asserts a fixed wall-clock budget', () => {
  // The pattern the flakes had: `ms < 800`, `elapsed < BUDGET_MS`. Relative bounds (a ratio of a baseline
  // measured in the same run) and condition waits are fine; so is anything under SUDS_THOROUGH.
  const offenders = [];
  for (const f of fs.readdirSync(path.join(root, 'test')).filter((x) => x.endsWith('.test.js') && !x.startsWith('publication-release'))) {
    const src = fs.readFileSync(path.join(root, 'test', f), 'utf8');
    if (src.includes('SUDS_THOROUGH')) continue;
    src.split('\n').forEach((line, i) => { if (/assert\.ok\(\s*(ms|elapsed|took|duration|total)\s*<\s*\d/.test(line)) offenders.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
});

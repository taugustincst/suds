'use strict';
// scripts/release-gate.js: release.yml refuses to publish a commit unless CI passed for exactly that commit,
// with every required job (including the browser suite) green.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { evaluate, REQUIRED_JOBS } = require('../scripts/release-gate');

const SHA = 'a'.repeat(40);
const run = (id, extra = {}) => ({ id, head_sha: SHA, event: 'push', status: 'completed', conclusion: 'success', ...extra });
const jobs = (overrides = {}) => [...REQUIRED_JOBS, 'webkit'].map((name) => ({ name, conclusion: overrides[name] || 'success' }));

test('passes only when a push run for the exact commit succeeded with every required job green', () => {
  assert.equal(evaluate(SHA, [run(1)], { 1: jobs() }).decision, 'pass');
  assert.deepEqual(REQUIRED_JOBS.slice().sort(), ['browser', 'dr-drill', 'node24', 'test', 'thorough'], 'the browser suite, Node 24, the recovery drill and the thorough disclosure sweeps are required');
});

test('refuses when the browser suite failed, even if the run as a whole is marked success', () => {
  const out = evaluate(SHA, [run(1)], { 1: jobs({ browser: 'failure' }) });
  assert.equal(out.decision, 'fail'); assert.match(out.reason, /browser/);
});

test('refuses when the run failed; WebKit (advisory) failing alone does not block', () => {
  assert.equal(evaluate(SHA, [run(1, { conclusion: 'failure' })], {}).decision, 'fail');
  assert.equal(evaluate(SHA, [run(1)], { 1: jobs({ webkit: 'failure' }) }).decision, 'pass');
});

test('a required job missing from the run (renamed or deleted from ci.yml) refuses the release', () => {
  const out = evaluate(SHA, [run(1)], { 1: jobs().filter((j) => j.name !== 'dr-drill') });
  assert.equal(out.decision, 'fail'); assert.match(out.reason, /missing job\(s\) dr-drill/);
});

test('runs for another commit, and pull_request runs (merge commits), do not count', () => {
  assert.equal(evaluate(SHA, [run(1, { head_sha: 'b'.repeat(40) })], { 1: jobs() }).decision, 'wait');
  assert.equal(evaluate(SHA, [run(1, { event: 'pull_request' })], { 1: jobs() }).decision, 'wait');
});

test('waits while CI for the commit is still running; a later successful re-run passes', () => {
  assert.equal(evaluate(SHA, [run(2, { status: 'in_progress', conclusion: null }), run(1, { conclusion: 'failure' })], {}).decision, 'wait');
  assert.equal(evaluate(SHA, [run(2), run(1, { conclusion: 'failure' })], { 2: jobs() }).decision, 'pass');
});

test('release.yml runs the gate before building anything, and the node24 job is required in ci.yml', () => {
  const rel = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(rel, /node scripts\/release-gate\.js/);
  assert.match(rel, /needs: gate/);
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const node24 = ci.slice(ci.indexOf('\n  node24:'), ci.indexOf('\n  dr-drill:'));
  assert.ok(node24.length > 10 && !/continue-on-error/.test(node24), 'node24 is not advisory');
  for (const j of REQUIRED_JOBS) assert.match(ci, new RegExp(`\\n  ${j}:\\n`), `ci.yml has a ${j} job`);
  assert.ok(!/\n\s+uses:/.test(ci) && !/\n\s+uses:/.test(rel), 'no marketplace (or any) actions');
});

test('the Node 24 job installs an exact, pinned version and checks it against a pinned SHA-256', () => {
  // It used to download whatever latest-v24.x was that day and check it against a checksum file fetched from
  // the same place: an unannounced Node change between two pushes, verified only against itself.
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const node24 = ci.slice(ci.indexOf('\n  node24:'), ci.indexOf('\n  dr-drill:'));
  assert.match(node24, /\n {6}NODE24_VERSION: v24\.\d+\.\d+\n/, 'an exact v24.x.y');
  assert.match(node24, /\n {6}NODE24_SHA256: [0-9a-f]{64}\n/, 'a full SHA-256');
  assert.ok(!/latest-v24/.test(node24), 'never the moving latest-v24.x directory');
  assert.ok(!/SHASUMS256\.txt"/.test(node24.split('steps:')[1] || ''), 'the checksum is not fetched at run time');
  assert.match(node24, /sha256sum -c -/, 'and the check is still made');
});

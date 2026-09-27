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

test('RELEASE.md gives the browser suite\'s real size, wherever it gives one', () => {
  // It said "thirty scripts" in one place and "29 scripts" in another. A script added to run-all.sh's list
  // updates the number here too.
  const runAll = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ui', 'run-all.sh'), 'utf8');
  const list = /\$\{SCRIPTS:-([^}]+)\}; do/.exec(runAll);
  assert.ok(list, 'run-all.sh has its default script list');
  const n = list[1].trim().split(/\s+/).length;
  const release = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RELEASE.md'), 'utf8');
  const said = [...release.matchAll(/(\w+) scripts\b/g)].map((m) => m[1]).filter((w) => /^\d+$|^(twenty|thirty|forty)/i.test(w));
  assert.ok(said.length >= 2, 'RELEASE.md states the count');
  assert.deepEqual([...new Set(said)], [String(n)], `RELEASE.md says ${said.join(', ')} scripts; run-all.sh runs ${n}`);
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

test('every Node 22 job, and the release, runs an exact pinned Node 22 checked against a pinned SHA-256', () => {
  // Until 1.14.0 they ran whatever Node 22 the runner image carried, checked by major only: a Node change
  // between two pushes that nobody committed. Now the release ci.yml pins, the same in release.yml.
  const wf = (f) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', f), 'utf8');
  const ci = wf('ci.yml'); const rel = wf('release.yml');
  const pinOf = (y) => ({ v: (/\nenv:\n {2}NODE22_VERSION: (v22\.\d+\.\d+)\n/.exec(y) || [])[1], h: (/\n {2}NODE22_SHA256: ([0-9a-f]{64})\n/.exec(y) || [])[1] });
  const a = pinOf(ci); const b = pinOf(rel);
  assert.ok(a.v && a.h, 'ci.yml pins an exact v22.x.y and a full SHA-256');
  assert.deepEqual(b, a, 'release.yml pins the same release and checksum');
  const nvmrc = fs.readFileSync(path.join(__dirname, '..', '.nvmrc'), 'utf8').trim();
  assert.equal(a.v.split('.')[0], `v${nvmrc}`, 'of the major .nvmrc names');
  const job = (y, name, next) => y.slice(y.indexOf(`\n  ${name}:`), next ? y.indexOf(`\n  ${next}:`) : undefined);
  const jobs = [['test', job(ci, 'test', 'thorough')], ['thorough', job(ci, 'thorough', 'browser')], ['browser', job(ci, 'browser', 'node24')], ['dr-drill', job(ci, 'dr-drill', 'webkit')], ['release', job(rel, 'release')]];
  for (const [name, text] of jobs) {
    assert.match(text, /curl -fsSLO "https:\/\/nodejs\.org\/dist\/\$\{NODE22_VERSION\}\/\$\{file\}"/, `${name}: downloads the pinned release`);
    assert.match(text, /echo "\$\{NODE22_SHA256\}  \$\{file\}" \| sha256sum -c -/, `${name}: checks it against the pinned checksum`);
    assert.match(text, /\[ "\$\(node --version\)" = "\$NODE22_VERSION" \]/, `${name}: and runs on it`);
    const first = text.search(/\n\s+run: (npm|node|scripts)\b/);
    assert.ok(first > 0 && text.indexOf('Install Node 22') < first, `${name}: before anything is installed or run`);
    assert.ok(!/SHASUMS256\.txt"/.test(text.split('steps:')[1] || ''), `${name}: the checksum is not fetched at run time`);
  }
  assert.ok(!/latest-v22/.test(ci + rel), 'never the moving latest-v22.x directory');
});

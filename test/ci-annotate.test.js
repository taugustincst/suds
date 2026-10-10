'use strict';
// 1.25.4, G1: a red CI job names its failures where the GitHub API can read them (one ::error annotation per failing
// test or browser check, and the step summary), not only in a log the API may not serve. scripts/ci-annotate.js is the
// node:test reporter ci.yml's test steps add through NODE_OPTIONS; scripts/ui/run-all.sh annotates the browser suite.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Y = require('../scripts/workflow-yaml');

const root = path.join(__dirname, '..');
const ci = Y.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));

test('the reporter writes one annotation per failing test (job, file, line, name, first line of the error) and a summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-annotate-'));
  try {
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), [
      "const { test, describe } = require('node:test'); const assert = require('node:assert');",
      "test('passes', () => {});",
      "test('signs in, 100% sure', () => { assert.equal(401, 200, 'the code of the step the server checks'); });",
      "describe('a suite', () => { test('inner', () => { throw new Error('first line\\nsecond line'); }); });",
      "test('parent', async (t) => { await t.test('child', () => assert.ok(false, 'from a subtest')); });",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'test', 'b.test.js'), "throw new TypeError('the file did not load');\n");
    const summary = path.join(dir, 'summary.md');
    const env = { ...process.env, GITHUB_JOB: 'evening', GITHUB_STEP_SUMMARY: summary };
    delete env.NODE_OPTIONS; delete env.SUDS_CI_ANNOTATING; delete env.NODE_TEST_CONTEXT; // the outer run, whatever runs this one
    const r = spawnSync(process.execPath, ['--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${path.join(root, 'scripts', 'ci-annotate.js')}`, '--test-reporter-destination=stdout',
      '--test', 'test/a.test.js', 'test/b.test.js'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 1, 'the run still fails');
    const notes = r.stdout.split('\n').filter((l) => l.startsWith('::error'));
    assert.deepEqual(notes, [
      '::error file=test/a.test.js,line=3,title=evening::test/a.test.js › signs in, 100%25 sure: the code of the step the server checks',
      '::error file=test/a.test.js,line=4,title=evening::test/a.test.js › inner: first line',
      '::error file=test/a.test.js,line=5,title=evening::test/a.test.js › child: from a subtest',
      "::error file=test/b.test.js,line=1,title=evening::test/b.test.js › test/b.test.js: TypeError: the file did not load",
    ], 'a parent or suite that failed only through its subtests is not repeated');
    assert.match(r.stdout, /✖ signs in, 100% sure/, 'the spec output is still there');
    const md = fs.readFileSync(summary, 'utf8');
    assert.match(md, /^### evening: 4 failing/);
    assert.match(md, /- `test\/a\.test\.js:3` signs in, 100% sure: the code of the step the server checks/);
    // Started inside a run that already annotates (it inherits NODE_OPTIONS), it stays quiet.
    const nested = spawnSync(process.execPath, ['--test-reporter', path.join(root, 'scripts', 'ci-annotate.js'), '--test', 'test/a.test.js'],
      { cwd: dir, env: { ...env, SUDS_CI_ANNOTATING: '1', GITHUB_STEP_SUMMARY: path.join(dir, 'nested.md') }, encoding: 'utf8' });
    assert.equal(nested.status, 1); assert.equal(nested.stdout.trim(), ''); assert.ok(!fs.existsSync(path.join(dir, 'nested.md')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ci.yml: every node:test job runs its tests with the annotating reporter beside spec', () => {
  assert.match(ci.env.TEST_REPORTERS, /^--test-reporter=spec --test-reporter-destination=stdout --test-reporter=\.\/scripts\/ci-annotate\.js --test-reporter-destination=stdout$/);
  const want = { test: 'npm test', node24: 'npm test', evening: 'scripts/test-evening.sh', thorough: 'node scripts/test-thorough.js --part rest', 'thorough-sdc': 'node scripts/test-thorough.js --part sdc' };
  for (const [job, run] of Object.entries(want)) {
    const step = ci.jobs[job].steps.find((s) => s.run === run);
    assert.ok(step, `${job} runs ${run}`);
    assert.equal(step.env && step.env.NODE_OPTIONS, '${{ env.TEST_REPORTERS }}', `${job}'s test step annotates its failures`);
  }
});

test('the browser suite annotates each failed script in GitHub Actions; the browser and webkit jobs both run it', () => {
  const runAll = fs.readFileSync(path.join(root, 'scripts', 'ui', 'run-all.sh'), 'utf8');
  assert.match(runAll, /if \[ -n "\$\{GITHUB_ACTIONS:-\}" \] && \[ \$\{#failed\[@\]\} -gt 0 \]; then/);
  assert.match(runAll, /echo "::error file=scripts\/ui\/\$s\.mjs,title=\$suite::\$s: \$l"/);
  assert.match(runAll, />> "\$GITHUB_STEP_SUMMARY"/);
  for (const job of ['browser', 'webkit']) assert.match(ci.jobs[job].steps.at(-1).run, /scripts\/ui\/run-all\.sh$/, job);
});

test('run-all.sh writes the annotations: a FAIL line, and a script that ended without one', () => {
  // The annotation block, run on its own against two script logs, as run-all.sh runs it after the suite.
  const runAll = fs.readFileSync(path.join(root, 'scripts', 'ui', 'run-all.sh'), 'utf8');
  const block = /\nif \[ -n "\$\{GITHUB_ACTIONS:-\}" \][\s\S]*?\nfi\n/.exec(runAll)[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-annotate-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'suds-ui-dates.log'), '  ok   one\n FAIL  the date is today — got "2026-10-10"\n FAIL  50% done\n');
    fs.writeFileSync(path.join(dir, 'suds-ui-static-site.log'), 'loading\nTIMED OUT after 900 s (a wait that never resolved)\n');
    const summary = path.join(dir, 'summary.md');
    const r = spawnSync('bash', ['-c', `T=${dir}; failed=(dates static-site)\n${block}`],
      { env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_JOB: 'webkit', SUDS_BROWSER: 'webkit', GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [
      '::error file=scripts/ui/dates.mjs,title=webkit (webkit)::dates: the date is today — got "2026-10-10"',
      '::error file=scripts/ui/dates.mjs,title=webkit (webkit)::dates: 50%25 done',
      '::error file=scripts/ui/static-site.mjs,title=webkit (webkit)::static-site: TIMED OUT after 900 s (a wait that never resolved)',
    ]);
    assert.match(fs.readFileSync(summary, 'utf8'), /^### webkit \(webkit\): 2 failing script\(s\)\n\n- `dates`: the date is today — got "2026-10-10"\n- `dates`: 50% done\n- `static-site`: TIMED OUT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

'use strict';
// scripts/workflow-yaml.js reads the workflows as data, and the checks here read them that way: who may write, which
// job waits in which environment, what starts each workflow and which actions run (engineering reviews of 1.16.1 L6
// and 1.16.3 L7: the workflow tests were regular expressions over the text). The tests of what a step's shell script
// does stay text matches on the parsed `run` string (release-*.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Y = require('../scripts/workflow-yaml');
const { REQUIRED_JOBS } = require('../scripts/release-gate');

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const wf = (f) => Y.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

test('the parser reads the YAML the workflows use', () => {
  const doc = Y.parse([
    'name: X   # a comment',
    '# a whole-line comment',
    'on: [push, pull_request]',
    'env:',
    "  A: 'it''s # not a comment'",
    '  B: "tab\\tand \\"quotes\\""',
    '  C: 15',
    '  D: true',
    '  E: ${{ github.token }}',
    'jobs:',
    '  j:',
    '    needs: [a, \'b\']',
    '    steps:',
    '      - name: one',
    '        run: |',
    '          echo "#1"   # kept: inside a block scalar',
    '',
    '          echo two',
    '      - run: echo three',
    '      -',
    '        name: four',
    '    outputs: {}',
    '    list:',
    '    - x',
    '    - y',
    '    stripped: |-',
    '      no newline',
  ].join('\n'));
  assert.deepEqual(doc, {
    name: 'X',
    on: ['push', 'pull_request'],
    env: { A: "it's # not a comment", B: 'tab\tand "quotes"', C: 15, D: true, E: '${{ github.token }}' },
    jobs: { j: {
      needs: ['a', 'b'],
      steps: [{ name: 'one', run: 'echo "#1"   # kept: inside a block scalar\n\necho two\n' }, { run: 'echo three' }, { name: 'four' }],
      outputs: {},
      list: ['x', 'y'],
      stripped: 'no newline',
    } },
  });
  assert.deepEqual(Y.parse('on:\n  workflow_dispatch: {}\n'), { on: { workflow_dispatch: {} } }, '`on` stays a key, not YAML 1.1\'s boolean');
});

test('the parser refuses what it does not read, with the line, instead of reading it wrong', () => {
  const bad = {
    'a: &x 1\nb: *x': /anchors, aliases and tags/,
    'a: 1\na: 2': /duplicate key a/,
    'a: one\n  two': /multi-line plain scalar/,
    'a:\n\tb: 1': /tabs in indentation/,
    'a: 1\n---\nb: 2': /several documents/,
    'a: {b: 1}': /flow mappings are not read/,
    'a: "open': /unterminated or multi-line double-quoted/,
    'a: [1, [2]]': /nested flow collections/,
    'a:\n  - b\n c: 1': /line 3/,
  };
  for (const [src, re] of Object.entries(bad)) assert.throws(() => Y.parse(src), re, src);
});

test('every workflow parses, and every job runs on a hosted runner with named steps', () => {
  const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  assert.deepEqual(files, ['ci.yml', 'release.yml', 'settings-check.yml', 'web-app.yml']);
  for (const f of files) {
    const w = wf(f);
    assert.equal(typeof w.name, 'string', `${f}: a name`);
    for (const [name, job] of Object.entries(w.jobs)) {
      // ci.yml's windows job is the one exception: the path a Windows tester takes (docs/TRY-ON-WINDOWS.md).
      assert.equal(job['runs-on'], f === 'ci.yml' && name === 'windows' ? 'windows-latest' : 'ubuntu-latest', `${f} ${name}`);
      assert.ok(Array.isArray(job.steps) && job.steps.length, `${f} ${name}: steps`);
      for (const s of job.steps) assert.ok(s.run || s.uses, `${f} ${name}: a step runs something`);
    }
  }
});

test('the only actions are GitHub\'s own, pinned to a full commit SHA, and only in web-app.yml', () => {
  // The Actions policy allows only actions created by GitHub (docs/RELEASE.md, step 4).
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yml'))) {
    for (const [job, s] of Y.steps(wf(f))) {
      if (!s.uses) continue;
      assert.equal(f, 'web-app.yml', `${f} ${job}: no action outside web-app.yml`);
      assert.match(s.uses, /^actions\/(upload|download)-artifact@[0-9a-f]{40}$/, `${f} ${job}: ${s.uses}`);
    }
  }
});

test('write scopes: only the release job and the web-app publish job, both in the `release` environment', () => {
  const writers = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yml'))) {
    const w = wf(f);
    assert.ok(w.permissions && typeof w.permissions === 'object', `${f}: a top-level permissions block (else the repository default token)`);
    assert.ok(Object.values(w.permissions).every((v) => v === 'read'), `${f}: read-only at the top`);
    for (const [name, job] of Object.entries(w.jobs)) {
      const p = job.permissions || {};
      if (Object.values(p).some((v) => v === 'write')) writers.push([`${f} ${name}`, job.environment || null]);
    }
  }
  assert.deepEqual(writers, [['release.yml release', 'release'], ['web-app.yml publish', 'release']]);
});

test('triggers: CI on every push and pull request, a release on a v* tag, the web app on dispatch only, the settings weekly', () => {
  assert.deepEqual(wf('ci.yml').on, ['push', 'pull_request']);
  const rel = wf('release.yml').on;
  assert.deepEqual(rel.push, { tags: ['v*'] });
  assert.deepEqual(Object.keys(rel.workflow_dispatch.inputs), ['confirm', 'policy_exception', 'allow_patch_changes']);
  assert.deepEqual(wf('web-app.yml').on, { workflow_dispatch: {} }, 'no tag push, release event or push trigger');
  const s = wf('settings-check.yml').on;
  assert.deepEqual(Object.keys(s).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(s.schedule.length, 1);
  assert.match(s.schedule[0].cron, /^\d+ \d+ \* \* [0-6]$/, 'weekly');
});

test('ci.yml: every job the release gate requires exists and is not advisory; only webkit and release-state are', () => {
  const jobs = wf('ci.yml').jobs;
  for (const j of REQUIRED_JOBS) {
    assert.ok(jobs[j], `ci.yml has a ${j} job`);
    assert.ok(!jobs[j]['continue-on-error'], `${j} is not advisory`);
  }
  // release-state (scripts/release-state.js) compares the documents with origin's tags and gh-pages, which change
  // without a commit: advisory, and never a required job.
  assert.deepEqual(Object.keys(jobs).filter((j) => jobs[j]['continue-on-error']), ['webkit', 'release-state']);
  assert.ok(!REQUIRED_JOBS.includes('release-state'));
});

test('ci.yml: the windows job runs npm run try and the OS-sensitive tests on the pinned Node 22, with no npm install, and is not advisory', () => {
  const ci = wf('ci.yml');
  const job = ci.jobs.windows;
  assert.equal(job['runs-on'], 'windows-latest');
  assert.ok(!job['continue-on-error'], 'a red Windows run fails CI');
  const runs = job.steps.map((s) => s.run || '').join('\n');
  assert.match(runs, /nodejs\.org\/dist\/\$env:NODE22_VERSION\/\$file/, 'the release ci.yml pins for every Node 22 job');
  assert.match(runs, /Get-FileHash \$file -Algorithm SHA256/); assert.match(runs, /-ne \$env:NODE22_WIN_SHA256/, 'checked against a pinned SHA-256');
  assert.match(job.env.NODE22_WIN_SHA256, /^[0-9a-f]{64}$/);
  assert.match(runs, /\(node --version\) -ne \$env:NODE22_VERSION/, 'and runs on it');
  assert.match(runs, /--test test\/try-local\.test\.js/);
  for (const t of ['crypto', 'backup', 'audit-anchor-interval', 'instance-lock', 'migrations', 'secret-files']) assert.ok(runs.includes(`test/${t}.test.js`), t);
  for (const t of runs.match(/test\/[a-z0-9-]+\.test\.js/g)) assert.ok(fs.existsSync(path.join(__dirname, '..', t)), `${t} exists`);
  assert.ok(!/npm (ci|install)/.test(runs), 'no npm install: the doc says none is needed');
});

test('ci.yml: release-policy runs the policy on every push, from the tags or the hand-off commit, and is not advisory', () => {
  const job = wf('ci.yml').jobs['release-policy'];
  assert.ok(job, 'ci.yml has a release-policy job');
  assert.ok(!job['continue-on-error'], 'a red policy fails the run, so the release gate refuses the commit');
  assert.equal(job.permissions, undefined, 'the top-level read-only token');
  const run = job.steps.map((s) => s.run || '').join('\n');
  assert.match(run, /git fetch --quiet --depth 1 origin '\+refs\/tags\/v\*:refs\/tags\/v\*'/, 'the release tags are fetched');
  assert.match(run, /node scripts\/release-policy-ci\.js --fetch\s*$/m, 'the script fetches the hand-off commit it compares with');
  assert.doesNotMatch(run, /npm (ci|install)/, 'Node built-ins and git only');
  assert.doesNotMatch(run, /RELEASE_POLICY_EXCEPTION|ALLOW_PATCH_CHANGES/, 'no exception on a push');
  assert.ok(job.steps.some((s) => /sha256sum -c/.test(s.run || '')), 'the pinned Node 22, checked');
});

test('release.yml: gate, then verify, then the release job, which alone waits for approval', () => {
  const { jobs } = wf('release.yml');
  assert.deepEqual(Object.keys(jobs), ['gate', 'verify', 'release']);
  assert.equal(jobs.gate.environment, undefined);
  assert.equal(jobs.verify.environment, undefined);
  assert.equal(jobs.verify.needs, 'gate');
  assert.deepEqual(jobs.release.needs, ['gate', 'verify']);
  assert.equal(jobs.release.environment, 'release');
  assert.deepEqual(Object.keys(jobs.gate.outputs).sort(), ['latest', 'main_sha', 'policy_notes']);
  assert.equal(jobs.release.env.LATEST, '${{ needs.gate.outputs.latest }}');
});

test('settings-check.yml: read-only, no action, the token from its own environment, the check script', () => {
  const w = wf('settings-check.yml');
  assert.deepEqual(w.permissions, { contents: 'read', actions: 'read', deployments: 'read' });
  const job = w.jobs.settings;
  assert.equal(job.permissions, undefined, 'the read-only top-level permissions');
  assert.equal(job.environment, 'settings-check', 'SETTINGS_READ_TOKEN is a secret of an environment limited to the default branch');
  const check = job.steps.find((s) => /repo-settings-check\.js/.test(s.run || ''));
  assert.ok(check, 'runs scripts/repo-settings-check.js');
  assert.equal(check.run, 'node scripts/repo-settings-check.js --repo "${GITHUB_REPOSITORY}"');
  assert.equal(check.env.GH_TOKEN, '${{ secrets.SETTINGS_READ_TOKEN || github.token }}');
  assert.ok(!Y.steps(w).some(([, s]) => s.uses), 'no action');
  assert.ok(!/SETTINGS_READ_TOKEN/.test(job.steps[0].run), 'the clone uses the workflow token, never the settings token');
});

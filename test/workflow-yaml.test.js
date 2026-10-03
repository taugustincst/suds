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
      // The Windows jobs are the exceptions: ci.yml's windows job (the path a Windows tester takes, docs/TRY-ON-WINDOWS.md),
      // and the Windows server zip's build in ci.yml and release.yml, and its signing (docs/WINDOWS-SERVER.md).
      const windows = (f === 'ci.yml' && ['windows', 'windows-exe'].includes(name)) || (f === 'release.yml' && ['windows-exe', 'windows-sign'].includes(name));
      assert.equal(job['runs-on'], windows ? 'windows-latest' : 'ubuntu-latest', `${f} ${name}`);
      assert.ok(Array.isArray(job.steps) && job.steps.length, `${f} ${name}: steps`);
      for (const s of job.steps) assert.ok(s.run || s.uses, `${f} ${name}: a step runs something`);
    }
  }
});

test('the only actions are GitHub\'s own artifact actions, pinned to a full commit SHA, in the jobs that hand files on', () => {
  // The Actions policy allows only actions created by GitHub (docs/RELEASE.md, step 4). web-app.yml hands the built
  // site to its publish job; the Windows server zip is handed from its build to its signing and to the release job, and
  // CI's build is uploaded for the owner to download (owner decision of 2026-10-03).
  const used = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yml')).sort()) {
    for (const [job, s] of Y.steps(wf(f))) {
      if (!s.uses) continue;
      assert.match(s.uses, /^actions\/(upload|download)-artifact@[0-9a-f]{40}$/, `${f} ${job}: ${s.uses}`);
      used.push(`${f} ${job} ${s.uses.split('@')[0].slice(8)}`);
    }
  }
  assert.deepEqual(used, [
    'ci.yml windows-exe upload-artifact',
    'release.yml windows-exe upload-artifact', 'release.yml windows-sign download-artifact', 'release.yml windows-sign upload-artifact', 'release.yml release download-artifact',
    'web-app.yml build upload-artifact', 'web-app.yml publish download-artifact',
  ]);
  // One pinned commit per action across the workflows: a bump changes every use.
  const pins = new Map();
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yml'))) for (const [, s] of Y.steps(wf(f))) if (s.uses) { const [a, sha] = s.uses.split('@'); assert.equal(pins.get(a) || sha, sha, `${a} is pinned to one commit everywhere`); pins.set(a, sha); }
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

test('ci.yml: windows-exe builds the Windows server zip from pinned inputs, smoke-tests it and uploads it; not advisory, not a required job', () => {
  const ci = wf('ci.yml');
  const job = ci.jobs['windows-exe'];
  assert.equal(job['runs-on'], 'windows-latest');
  assert.ok(!job['continue-on-error'], 'a red Windows build fails CI');
  assert.ok(!REQUIRED_JOBS.includes('windows-exe'), 'not in the release gate\'s required list (the release builds the zip itself)');
  assert.equal(job.permissions, undefined, 'the top-level read-only token');
  assert.equal(job.env.NODE22_WIN_SHA256, ci.jobs.windows.env.NODE22_WIN_SHA256, 'the same node win-x64.zip pin as the windows job');
  assert.match(job.env.WINSW_VERSION, /^v\d+\.\d+\.\d+$/); assert.match(job.env.WINSW_SHA256, /^[0-9a-f]{64}$/);
  assert.match(job.env.POSTJECT_VERSION, /^\d+\.\d+\.\d+(-[\w.]+)?$/); assert.match(job.env.POSTJECT_INTEGRITY, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const runs = job.steps.map((s) => s.run || '').join('\n');
  assert.match(runs, /-ne \$env:NODE22_WIN_SHA256/); assert.match(runs, /-ne \$env:WINSW_SHA256/, 'WinSW checked against its pin at download');
  assert.match(runs, /node scripts\/build-windows\.js --node-zip [^\n]* --winsw [^\n]* --postject [^\n]* --out dist/);
  assert.match(runs, /\.\/scripts\/windows\/smoke-test\.ps1 -Dir \$dir -Version \$ver/);
  assert.ok(!/npm (ci|install)|npx /.test(runs), 'no npm install and no npx: postject is used from its pinned tarball');
  assert.ok(!/secrets\./.test(JSON.stringify(job)), 'no secret on a push: CI builds are unsigned');
  const up = job.steps.find((s) => s.uses);
  assert.equal(up.with.name, 'suds-windows-x64');
  assert.match(up.with.path, /src\/dist\/\*\.zip\n/); assert.equal(up.with['if-no-files-found'], 'error');
  for (const f of ['scripts/build-windows.js', 'scripts/windows/smoke-test.ps1']) assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f);
  // The smoke test covers what the owner asked for.
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'windows', 'smoke-test.ps1'), 'utf8');
  for (const cmd of ["@('version')", "'try', '--port'", "@('status', '--json')", "@('service', 'install')", "@('service', 'start')", "@('service', 'stop')", "@('service', 'uninstall')", "@('logs', '--lines', '5')", '/api/auth/login', 'shutting down']) assert.ok(smoke.includes(cmd), `smoke test: ${cmd}`);
});

test('release.yml: the Windows zip is built from the gated commit with ci.yml\'s pins, signed apart from the build, and attached by the release job', () => {
  const ci = wf('ci.yml'); const rel = wf('release.yml');
  const b = rel.jobs['windows-exe']; const sg = rel.jobs['windows-sign'];
  assert.equal(b.needs, 'gate'); assert.equal(sg.needs, 'windows-exe');
  assert.deepEqual(b.permissions, { contents: 'read' }); assert.deepEqual(sg.permissions, { contents: 'read' });
  assert.equal(b.environment, undefined); assert.equal(sg.environment, undefined);
  for (const k of ['NODE22_WIN_SHA256', 'WINSW_VERSION', 'WINSW_SHA256', 'POSTJECT_VERSION', 'POSTJECT_INTEGRITY']) assert.equal(b.env[k], ci.jobs['windows-exe'].env[k], `release.yml windows-exe pins ${k} as ci.yml does`);
  assert.equal(sg.env.NODE22_WIN_SHA256, ci.jobs['windows-exe'].env.NODE22_WIN_SHA256);
  assert.ok(!/secrets\./.test(JSON.stringify(b)), 'the build job (which runs postject) has no secret');
  // The certificate reaches the signing step only, and that step runs signtool, not the repository's code or npm.
  const withSecrets = sg.steps.filter((s) => /secrets\./.test(JSON.stringify(s)));
  assert.equal(withSecrets.length, 1);
  assert.deepEqual(Object.keys(withSecrets[0].env).sort(), ['WINDOWS_CERT_PASSWORD', 'WINDOWS_CERT_PFX_BASE64']);
  assert.ok(!/\bnode\b|\bnpm\b|\bnpx\b|scripts[\\/]/.test(withSecrets[0].run), 'the signing step runs no node, npm or repository script');
  assert.match(withSecrets[0].run, /signtool[^\n]* sign \/fd SHA256 [^\n]*\/tr http[^\n]* \/td SHA256/, 'signed with SHA-256 and timestamped');
  assert.match(withSecrets[0].run, /::notice::No code-signing certificate/, 'without the secrets: unsigned, with a notice');
  assert.match(sg.steps.map((s) => s.run || '').join('\n'), /node scripts\/build-windows\.js --pack/);
  assert.deepEqual(rel.jobs.release.needs, ['gate', 'verify', 'windows-sign']);
  assert.ok(rel.jobs.release.steps.some((s) => (s.uses || '').startsWith('actions/download-artifact@') && s.with.name === 'suds-windows-x64'));
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
  assert.deepEqual(Object.keys(jobs), ['gate', 'verify', 'windows-exe', 'windows-sign', 'release']);
  assert.equal(jobs.gate.environment, undefined);
  assert.equal(jobs.verify.environment, undefined);
  assert.equal(jobs.verify.needs, 'gate');
  assert.deepEqual(jobs.release.needs, ['gate', 'verify', 'windows-sign']);
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

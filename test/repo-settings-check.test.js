'use strict';
// scripts/repo-settings-check.js: the weekly check that the repository settings docs/RELEASE.md asks for are in force.
// Decided from saved API responses (test/fixtures/repo-settings/configured.json: every setting as documented), and
// variants of them: the repository as the 1.16.3 review found it (nothing set), the workflow's default token (the
// admin-only settings unreadable), and one setting off at a time.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const C = require('../scripts/repo-settings-check');

const FIXTURE = path.join(__dirname, 'fixtures', 'repo-settings', 'configured.json');
const configured = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const CTX = { repo: 'taugustincst/suds' };
const run = (data) => C.evaluate(data, CTX);
const state = (checks, re) => { const c = checks.filter((x) => re.test(x.setting)); assert.ok(c.length, `a check matching ${re}`); return c.map((x) => x.state); };
const failing = (checks) => checks.filter((c) => c.state === 'off' || c.state === 'unverified');
const FORBIDDEN = { status: 403, body: { message: 'Resource not accessible by integration' } };

test('every documented setting in force: all ok, nothing to check by hand', () => {
  const checks = run(configured());
  assert.deepEqual(checks.filter((c) => c.state !== 'ok'), []);
  // Every step of RELEASE.md's owner settings but the optional code scanning (8) is checked.
  assert.deepEqual([...new Set(checks.map((c) => c.step))], ['1', '2', '3', '4', '5', '6', '7']);
  assert.ok(checks.length >= 25, `${checks.length} checks`);
});

test('the repository as the 1.16.3 review found it (no ruleset, no environment, nothing immutable) fails on each', () => {
  const d = configured();
  d['rulesets?includes_parents=true&per_page=100'] = { status: 200, body: [] };
  for (const k of Object.keys(d)) if (k.startsWith('rulesets/')) delete d[k];
  d['rules/branches/main'] = { status: 200, body: [] };
  d['branches/main'] = { status: 200, body: { name: 'main', protected: false } };
  d['rules/branches/gh-pages'] = { status: 200, body: [] };
  d['environments/release'] = { status: 404, body: { message: 'Not Found' } };
  d['immutable-releases'] = { status: 404, body: { message: 'Not Found' } };
  d['releases/latest'] = { status: 200, body: { tag_name: 'v1.16.3', immutable: false } };
  d['git/matching-refs/heads/release/v'] = { status: 200, body: Array.from({ length: 30 }, (_, i) => ({ ref: `refs/heads/release/v1.${i}.0` })) };
  const checks = run(d);
  for (const re of [/`release` environment exists/, /`main`: deletion/, /`main`: force pushes/, /`main`: pull request/, /`main`: required checks/, /`maint\/\*`: only an administrator/, /`v\*` tags: creation/, /`gh-pages`: updates/, /^Immutable releases$/, /No `release\/v\*` branches/, /PAGES_PUBLISH_KEY` is a secret/]) {
    assert.deepEqual([...new Set(state(checks, re))], ['off'], String(re));
  }
  assert.match(checks.find((c) => /release\/v/.test(c.setting)).detail, /^30 left/);
});

test('the workflow\'s default token: the admin-only settings "cannot be verified", which fails; bypass lists are for the owner to look at', () => {
  const d = configured();
  for (const k of ['actions/permissions', 'actions/permissions/workflow', 'keys?per_page=100', 'environments/release/secrets?per_page=100', 'actions/secrets?per_page=100', 'immutable-releases']) d[k] = FORBIDDEN;
  delete d['actions/permissions/selected-actions'];
  delete d[''].body.delete_branch_on_merge;
  for (const k of Object.keys(d)) if (k.startsWith('rulesets/')) delete d[k].body.bypass_actors;
  d['releases/latest'] = { status: 200, body: { tag_name: 'v1.16.4', immutable: false } };
  const checks = run(d);
  const unverified = checks.filter((c) => c.state === 'unverified').map((c) => c.setting);
  assert.deepEqual(unverified, ['Default workflow token read-only', 'Only actions created by GitHub may run', 'Immutable releases', 'One deploy key with write access',
    '`PAGES_PUBLISH_KEY` is a secret of `release`', 'No deploy key among the repository secrets', 'Automatically delete head branches']);
  assert.match(checks.find((c) => c.setting === 'Default workflow token read-only').detail, /403\): needs a token with Administration: read/);
  assert.match(checks.find((c) => c.setting === 'Immutable releases').detail, /the newest release, v1\.16\.4, is not immutable/);
  assert.equal(checks.filter((c) => c.state === 'off').length, 0, 'nothing read is off');
  assert.deepEqual(checks.filter((c) => c.state === 'manual').map((c) => c.step), ['2', '2', '3', '6'], 'the bypass lists of the main, maint, tag and gh-pages rulesets');
  // An immutable newest release is evidence enough that the setting is on.
  d['releases/latest'].body.immutable = true;
  assert.deepEqual(state(run(d), /^Immutable releases$/), ['ok']);
});

test('one setting off at a time is found, with what is wrong', () => {
  const cases = [
    ['prevent self-review with the owner the only reviewer', (d) => { d['environments/release'].body.protection_rules[0].prevent_self_review = true; }, /Prevent self-review/, /cannot approve/],
    ['no required reviewer', (d) => { d['environments/release'].body.protection_rules.shift(); }, /Required reviewers/, /no required reviewer/],
    ['a reviewer, not the owner', (d) => { d['environments/release'].body.protection_rules[0].reviewers[0].reviewer.login = 'someone'; }, /Required reviewers/, /do not include taugustincst/],
    ['main may deploy', (d) => { d['environments/release/deployment-branch-policies'].body.branch_policies.push({ name: 'main', type: 'branch' }); }, /Deployment refs/, /v\* \(tag\), main \(branch\)/],
    ['any ref may deploy', (d) => { d['environments/release'].body.deployment_branch_policy = null; }, /Deployment refs/, /any branch or tag/],
    ['dr-drill not required', (d) => { const r = d['rules/branches/main'].body[3].parameters.required_status_checks; r.splice(r.findIndex((c) => c.context === 'dr-drill'), 1); }, /`main`: required checks/, /missing: dr-drill/],
    ['branch need not be up to date', (d) => { d['rules/branches/main'].body[3].parameters.strict_required_status_checks_policy = false; }, /`main`: required checks/, /up to date/],
    ['no code-owner review', (d) => { d['rules/branches/main'].body[2].parameters.require_code_owner_review = false; }, /`main`: pull request/, /code owners false/],
    ['main bypassed by an app', (d) => { d['rulesets/101'].body.bypass_actors.push({ actor_id: 15368, actor_type: 'Integration', bypass_mode: 'always' }); }, /`main`: bypass/, /Integration 15368/, 2], // the main ruleset covers maint/* too
    ['main ruleset only evaluated', (d) => { d['rulesets/101'].body.enforcement = 'evaluate'; }, /`maint\/\*`: force pushes/, /^$/, 3], // not active: maint/* loses force-push, review and check rules
    ['maint/* not in the main ruleset', (d) => { d['rulesets/101'].body.conditions.ref_name.include = ['~DEFAULT_BRANCH']; }, /`maint\/\*`: force pushes/, /^$/, 3],
    ['anyone may create maint/*', (d) => { d['rulesets/104'].body.rules = [{ type: 'deletion' }]; }, /`maint\/\*`: only an administrator/, /no ruleset restricts/],
    ['tags may be moved', (d) => { d['rulesets/102'].body.rules = [{ type: 'creation' }, { type: 'deletion' }]; }, /`v\*` tags: creation/, /not restricted: update/],
    ['deploy keys may make tags', (d) => { d['rulesets/102'].body.bypass_actors.push({ actor_id: null, actor_type: 'DeployKey', bypass_mode: 'always' }); }, /`v\*` tags: bypass/, /DeployKey/],
    ['the Actions app may push gh-pages', (d) => { d['rulesets/103'].body.bypass_actors.push({ actor_id: 15368, actor_type: 'Integration', bypass_mode: 'always' }); }, /`gh-pages`: bypass/, /Integration/],
    ['gh-pages may be force-pushed', (d) => { d['rules/branches/gh-pages'].body.pop(); }, /`gh-pages`: updates/, /non_fast_forward/],
    ['write token by default', (d) => { d['actions/permissions/workflow'].body.default_workflow_permissions = 'write'; }, /Default workflow token/, /write/],
    ['Actions may approve pull requests', (d) => { d['actions/permissions/workflow'].body.can_approve_pull_request_reviews = true; }, /approve pull requests/, /true/],
    ['marketplace actions allowed', (d) => { d['actions/permissions'].body.allowed_actions = 'all'; }, /Only actions created by GitHub/, /allowed_actions: all/],
    ['verified creators allowed', (d) => { d['actions/permissions/selected-actions'].body.verified_allowed = true; }, /Only actions created by GitHub/, /verified_allowed: true/],
    ['SHA pinning off', (d) => { d['actions/permissions'].body.sha_pinning_required = false; }, /pinned to a full commit SHA/, /false/],
    ['immutable releases off', (d) => { d['immutable-releases'].body.enabled = false; }, /^Immutable releases$/, /enabled: false/],
    ['a second write deploy key', (d) => { d['keys?per_page=100'].body.push({ id: 32, title: 'old', read_only: false }); }, /One deploy key/, /2 with write access/],
    ['no deploy key', (d) => { d['keys?per_page=100'].body = []; }, /One deploy key/, /0 with write access/],
    ['the key as a repository secret', (d) => { d['actions/secrets?per_page=100'].body.secrets.push({ name: 'PAGES_DEPLOY_KEY' }); }, /No deploy key among the repository secrets/, /PAGES_DEPLOY_KEY/],
    ['the old secret name in the environment', (d) => { d['environments/release/secrets?per_page=100'].body.secrets.push({ name: 'PAGES_DEPLOY_KEY' }); }, /No `PAGES_DEPLOY_KEY`/, /in the `release` environment/],
    ['head branches kept', (d) => { d[''].body.delete_branch_on_merge = false; }, /Automatically delete head branches/, /^$/],
  ];
  for (const [what, change, setting, detail, n = 1] of cases) {
    const d = configured(); change(d);
    const bad = failing(run(d));
    assert.equal(bad.length, n, `${what}: exactly ${n} failing check(s), not ${JSON.stringify(bad)}`);
    assert.equal(bad[0].state, 'off', what);
    assert.match(bad[0].setting, setting, what);
    assert.match(bad[0].detail, detail, what);
  }
});

test('an expired token, a server error or a network failure is "cannot verify", never a pass', async () => {
  const d = configured();
  d['environments/release'] = { status: 401, body: { message: 'Bad credentials' } };
  assert.match(run(d).find((c) => /`release` environment/.test(c.setting)).detail, /refused \(401: expired or revoked\?\)/);
  assert.equal(run(d).find((c) => /`release` environment/.test(c.setting)).state, 'unverified');
  // collect() turns a thrown request into status 0, which evaluate() cannot pass.
  const data = await C.collect(async (p) => { if (p === 'rules/branches/gh-pages') throw new Error('socket hang up'); return configured()[p] || { status: 404, body: {} }; });
  const gp = C.evaluate(data, CTX).find((c) => /`gh-pages`: updates/.test(c.setting));
  assert.deepEqual([gp.state, gp.detail], ['unverified', 'could not be read (socket hang up)']);
});

test('main protected by a classic rule instead of a ruleset is read the same way (with a token that can read it)', () => {
  const d = configured();
  d['rules/branches/main'] = { status: 200, body: [] };
  d['branches/main'] = { status: 200, body: { name: 'main', protected: true } };
  d['branches/main/protection'] = { status: 200, body: {
    required_status_checks: { strict: true, contexts: ['test', 'thorough', 'thorough-sdc', 'browser', 'node24', 'dr-drill'] },
    required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true, dismiss_stale_reviews: true },
    enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
  } };
  const checks = run(d);
  assert.deepEqual(checks.filter((c) => /^`main`/.test(c.setting)).map((c) => c.state), ['ok', 'ok', 'ok', 'ok', 'ok']);
  d['branches/main/protection'].body.allow_force_pushes.enabled = true;
  assert.deepEqual(state(run(d), /`main`: force pushes/), ['off']);
  d['branches/main/protection'] = FORBIDDEN;
  const u = run(d).find((c) => c.setting === '`main` is protected');
  assert.deepEqual([u.state, u.detail], ['unverified', 'a classic protection rule is on; its settings are not readable with this token (403): needs a token with Administration: read']);
});

test('collect() reads each ruleset\'s details, and a classic rule only when no ruleset covers main', async () => {
  const asked = [];
  const fx = configured();
  await C.collect(async (p) => { asked.push(p); return fx[p] || { status: 404, body: {} }; });
  for (const p of ['', 'rulesets/101', 'rulesets/102', 'rulesets/103', 'rulesets/104', 'rules/branches/main', 'environments/release', 'actions/permissions/selected-actions', 'git/matching-refs/heads/maint/']) assert.ok(asked.includes(p), p);
  assert.ok(!asked.includes('branches/main/protection'), 'the ruleset answers for main');
  assert.equal(new Set(asked).size, asked.length, 'each once');
  const asked2 = [];
  fx['rules/branches/main'] = { status: 200, body: [] }; fx['branches/main'] = { status: 200, body: { protected: true } };
  await C.collect(async (p) => { asked2.push(p); return fx[p] || { status: 404, body: {} }; });
  assert.ok(asked2.includes('branches/main/protection'));
});

test('ruleset ref patterns: ~DEFAULT_BRANCH, one-segment and any-depth wildcards, exclusions', () => {
  const rs = (include, exclude = []) => ({ conditions: { ref_name: { include, exclude } } });
  assert.ok(C.rulesetCovers(rs(['~DEFAULT_BRANCH']), 'refs/heads/main', 'main'));
  assert.ok(!C.rulesetCovers(rs(['~DEFAULT_BRANCH']), 'refs/heads/maint/1.16', 'main'));
  assert.ok(C.rulesetCovers(rs(['refs/heads/maint/*']), 'refs/heads/maint/1.16', 'main'));
  assert.ok(!C.rulesetCovers(rs(['refs/heads/maint/*']), 'refs/heads/maint/1.16/x', 'main'), '* stays within a segment');
  assert.ok(C.rulesetCovers(rs(['refs/heads/**']), 'refs/heads/maint/1.16/x', 'main'));
  assert.ok(C.rulesetCovers(rs(['refs/tags/v*']), 'refs/tags/v0.0.0', 'main'));
  assert.ok(!C.rulesetCovers(rs(['refs/tags/v*'], ['refs/tags/v0*']), 'refs/tags/v0.0.0', 'main'));
  assert.ok(C.rulesetCovers(rs(['~ALL']), 'refs/tags/v0.0.0', 'main'));
  assert.ok(!C.rulesetCovers({}, 'refs/heads/main', 'main'));
});

test('run as the workflow runs it: exit status, error annotations and a summary table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-settings-'));
  try {
    const cli = (fixture) => {
      const f = path.join(dir, 'fx.json'); fs.writeFileSync(f, JSON.stringify(fixture));
      const sum = path.join(dir, 'summary.md'); fs.writeFileSync(sum, '');
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'repo-settings-check.js'), '--repo', 'taugustincst/suds', '--fixtures', f], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: sum, SETTINGS_TOKEN_KIND: 'default workflow' } });
      return { ...r, summary: fs.readFileSync(sum, 'utf8') };
    };
    const good = cli(configured());
    assert.equal(good.status, 0, good.stdout);
    assert.ok(!/::error::/.test(good.stdout));
    assert.match(good.summary, /^### Repository settings \(taugustincst\/suds\)\n/);
    assert.match(good.summary, /Every setting that can be read is as documented/);
    assert.match(good.summary, /\n\| Step \| Setting \| State \| Detail \|\n/);
    const d = configured(); d['actions/permissions/workflow'] = FORBIDDEN; d['immutable-releases'].body.enabled = false;
    const bad = cli(d);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /::error::Setting off \(docs\/RELEASE\.md step 5\): 5 Immutable releases: off/);
    assert.match(bad.stdout, /::error::Cannot verify \(docs\/RELEASE\.md step 4\): 4 Default workflow token read-only: unverified/);
    assert.match(bad.summary, /\*\*1 off, 1 cannot be verified\*\* with the default workflow token/);
    assert.match(bad.summary, /\| 4 \| Default workflow token read-only \| \*\*cannot verify\*\* \|/);
    assert.match(bad.summary, /\| 5 \| Immutable releases \| \*\*OFF\*\* \| enabled: false \|/);
    assert.match(bad.summary, /A setting that cannot be verified is not a pass/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RELEASE.md documents the check, its token and what it cannot see', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RELEASE.md'), 'utf8');
  assert.ok(!/Proposed, not done: a scheduled job/.test(doc), 'no longer "proposed"');
  const step = doc.slice(doc.indexOf('**9. '), doc.indexOf('### Migration numbering'));
  assert.ok(step.length > 200, 'step 9: the settings-check token');
  for (const s of ['SETTINGS_READ_TOKEN', 'settings-check', 'Administration', 'Secrets', 'Environments', 'Read-only', 'bypass']) assert.ok(step.includes(s), `step 9 names ${s}`);
});

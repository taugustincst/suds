'use strict';
// scripts/release-policy.js: a patch release carries no migration, no new permission and no new route, and a
// feature release comes at most once every 28 days, unless the release is run with a policy exception
// (policy_exception, or allow_patch_changes, its earlier name), whose reason is then printed in the release notes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../scripts/release-policy');

const base = { migrations: 40, perms: { admin: ['a:read', 'a:write'], navigator: ['a:read'] }, routes: ['GET /api/a', 'POST /api/a'] };
const clone = (x) => JSON.parse(JSON.stringify(x));

test('bump kinds', () => {
  assert.equal(P.bumpKind('1.12.4', '1.12.5'), 'patch');
  assert.equal(P.bumpKind('v1.12.4', '1.13.0'), 'minor');
  assert.equal(P.bumpKind('1.12.4', '2.0.0'), 'major');
  assert.equal(P.bumpKind('1.12.4', '1.12.4'), 'none');
  assert.equal(P.bumpKind('1.12.4', '1.12.3'), 'downgrade');
  assert.equal(P.bumpKind('1.9.4', '1.10.0'), 'minor', 'compared as numbers, not strings');
  assert.throws(() => P.bumpKind('1.12', '1.12.1'));
});

test('the previous release is the highest version tag below the one being released', () => {
  const tags = ['v1.9.4', 'v1.10.0', 'v1.11.0', 'v1.12.0', 'v1.12.1', 'v1.12.10', 'v1.13.0', 'vnext', 'release-1'];
  assert.equal(P.previousTag(tags, '1.12.11'), 'v1.12.10');
  assert.equal(P.previousTag(tags, '1.12.2'), 'v1.12.1');
  assert.equal(P.previousTag(tags, '1.12.1'), 'v1.12.0', 'the tag of the release itself does not count');
  assert.equal(P.previousTag(tags, '1.10.0'), 'v1.9.4');
  assert.equal(P.previousTag([], '1.0.0'), null);
});

test('detects an added migration, a new permission, a widened grant and a new route', () => {
  const next = clone(base);
  next.migrations = 41;
  next.perms.admin.push('b:read');
  next.perms.navigator.push('a:write');
  next.routes.push('PUT /api/a/:');
  const d = P.diffSurfaces(base, next);
  assert.equal(d.migrations, 1); assert.deepEqual(d.schema, { from: 40, to: 41 });
  assert.deepEqual(d.newPermissions, ['b:read']);
  assert.deepEqual(d.widenedGrants, ['navigator += a:write']);
  assert.deepEqual(d.newRoutes, ['PUT /api/a/:']);
  assert.equal(P.violations(d).length, 4);
});

test('removals and a new role holding only existing permissions are not additions of a permission or route', () => {
  const next = clone(base);
  next.perms.navigator = [];
  next.routes = ['GET /api/a'];
  const d = P.diffSurfaces(base, next);
  assert.deepEqual(P.violations(d), [], 'narrowing access and removing a route are allowed in a fix release');
});

test('a patch release with no additions passes; a minor release may add anything', () => {
  const same = P.diffSurfaces(base, clone(base));
  assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.12.5', diff: same }).decision, 'pass');
  const next = clone(base); next.migrations = 42; next.routes.push('GET /api/b');
  const grew = P.diffSurfaces(base, next);
  const minor = P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.13.0', diff: grew });
  assert.equal(minor.decision, 'pass'); assert.equal(minor.kind, 'minor');
  assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '2.0.0', diff: grew }).decision, 'pass');
});

test('a patch release that adds a migration, permission or route fails without the override', () => {
  const next = clone(base); next.migrations = 41;
  const out = P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.12.5', diff: P.diffSurfaces(base, next) });
  assert.equal(out.decision, 'fail');
  assert.match(out.reason, /1 schema migration/);
  assert.match(out.reason, /policy_exception/, 'the refusal says how to make an exception');
  assert.match(out.reason, /allow_patch_changes/, 'and that the earlier name still works');
  for (const blank of ['', '   ', undefined]) {
    assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.12.5', diff: P.diffSurfaces(base, next), override: blank }).decision, 'fail', 'an empty override is no override');
  }
});

test('the override passes the release and puts the reason and every exception in the release notes', () => {
  const next = clone(base); next.routes.push('POST /api/auth/oidc/reauth'); next.perms.admin.push('reports:internal');
  const out = P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.12.5', diff: P.diffSurfaces(base, next), override: 'Security fix from the independent review:\nre-authentication for SSO users' });
  assert.equal(out.decision, 'override');
  assert.match(out.notes, /Release policy override: a policy exception/);
  assert.match(out.notes, /Security fix from the independent review: re-authentication for SSO users/, 'the reason, on one line');
  assert.match(out.notes, /new route POST \/api\/auth\/oidc\/reauth/);
  assert.match(out.notes, /new permission reports:internal/);
});

// ---- feature releases (1.14.0): at most one every 28 days ----
// 1.12.0 was tagged 2026-09-26T00:21Z and 1.13.0 the same day at 20:52Z: a feature release within a day of the
// previous one, which the check did not look at (it checked patch releases only).
const V1120 = { tag: 'v1.12.0', date: '2026-09-26T00:21:01+00:00' };
const HOUR = 3600e3;
test('the previous feature release is the newest vX.Y.0 tag below the version', () => {
  const tags = ['v1.11.0', 'v1.11.1', 'v1.12.0', 'v1.12.4', 'v1.13.0', 'v1.13.1', 'v2.0.0'];
  assert.equal(P.previousFeatureTag(tags, '1.14.0'), 'v1.13.0');
  assert.equal(P.previousFeatureTag(tags, '1.13.0'), 'v1.12.0', 'the release itself does not count');
  assert.equal(P.previousFeatureTag(tags, '3.0.0'), 'v2.0.0');
  assert.equal(P.previousFeatureTag(['v1.9.4'], '1.10.0'), null, 'no feature release below: nothing to compare with');
  assert.equal(P.FEATURE_INTERVAL_DAYS, 28);
});
test('a minor release 22 hours after the previous feature release fails without a policy exception', () => {
  const same = P.diffSurfaces(base, clone(base));
  const now = Date.parse(V1120.date) + 22 * HOUR;
  const out = P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.13.0', diff: same, feature: V1120, now });
  assert.equal(out.decision, 'fail');
  assert.equal(out.kind, 'minor');
  assert.match(out.reason, /22 hours after the previous one \(v1\.12\.0\)/);
  assert.match(out.reason, /at most once every 28 days/);
  assert.match(out.reason, /Wait until 2026-10-24/, 'says when it may be released');
  assert.match(out.reason, /policy_exception/, 'and how to make an exception');
  for (const blank of ['', '  ', undefined]) assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.13.0', diff: same, feature: V1120, now, override: blank }).decision, 'fail', 'an empty exception is none');
  // A major bump is a feature release too; a Date works as the clock.
  assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '2.0.0', diff: same, feature: V1120, now: new Date(now) }).decision, 'fail');
});
test('a minor release 30 days after the previous feature release passes (and may add migrations, permissions and routes)', () => {
  const next = clone(base); next.migrations = 42; next.routes.push('GET /api/b'); next.perms.admin.push('b:read');
  const out = P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.13.0', diff: P.diffSurfaces(base, next), feature: V1120, now: Date.parse(V1120.date) + 30 * 24 * HOUR });
  assert.equal(out.decision, 'pass', out.reason);
  assert.match(out.reason, /30 days after v1\.12\.0/);
  // Exactly 28 days is enough; a minute less is not.
  const at28 = Date.parse(V1120.date) + 28 * 24 * HOUR;
  assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.13.0', diff: P.diffSurfaces(base, clone(base)), feature: V1120, now: at28 }).decision, 'pass');
  assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.13.0', diff: P.diffSurfaces(base, clone(base)), feature: V1120, now: at28 - 60e3 }).decision, 'fail');
  // With no earlier feature release, or its date unknown, there is nothing to compare with.
  assert.equal(P.decide({ prevVersion: 'v1.9.4', nextVersion: '1.10.0', diff: P.diffSurfaces(base, clone(base)), feature: null }).decision, 'pass');
  assert.equal(P.decide({ prevVersion: 'v1.9.4', nextVersion: '1.10.0', diff: P.diffSurfaces(base, clone(base)), feature: { tag: 'v1.9.0', date: null } }).decision, 'pass');
});
test('a policy exception lets the early feature release through, with its reason at the top of the release notes', () => {
  const out = P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.13.0', diff: P.diffSurfaces(base, clone(base)), feature: V1120, now: Date.parse(V1120.date) + 22 * HOUR, override: 'Encrypts document references (migration 43)\nbefore the county pilot' });
  assert.equal(out.decision, 'override');
  assert.match(out.reason, /policy_exception: Encrypts document references/);
  assert.match(out.notes, /^> \*\*Release policy override: a policy exception\.\*\* This is a minor release less than 28 days after the previous feature release/);
  assert.match(out.notes, /Reason given \(`policy_exception`\): Encrypts document references \(migration 43\) before the county pilot/, 'the reason, on one line');
  assert.match(out.notes, /> \* feature release 1\.13\.0 22 hours after the previous one \(v1\.12\.0\)/);
});
test('a patch release is not held to the feature-release interval', () => {
  const same = P.diffSurfaces(base, clone(base));
  const now = Date.parse(V1120.date) + HOUR;
  const out = P.decide({ prevVersion: 'v1.12.0', nextVersion: '1.12.1', diff: same, feature: V1120, now });
  assert.equal(out.decision, 'pass');
  assert.equal(out.violations.length, 0);
  // ... and still to its own rule: an added route fails, and passes with an exception.
  const next = clone(base); next.routes.push('POST /api/auth/oidc/reauth');
  assert.equal(P.decide({ prevVersion: 'v1.12.0', nextVersion: '1.12.1', diff: P.diffSurfaces(base, next), feature: V1120, now }).decision, 'fail');
  assert.equal(P.decide({ prevVersion: 'v1.12.0', nextVersion: '1.12.1', diff: P.diffSurfaces(base, next), feature: V1120, now, override: 'security fix' }).decision, 'override');
});
test('the dates are read from the tags: 1.13.0 came less than a day after 1.12.0', () => {
  const d12 = P.tagDate('v1.12.0'); const d13 = P.tagDate('v1.13.0');
  if (!d12 || !d13) return; // a checkout without the release tags (a shallow CI clone) has nothing to read
  const out = P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.13.0', diff: P.diffSurfaces(base, clone(base)), feature: { tag: 'v1.12.0', date: d12 }, now: Date.parse(d13) });
  assert.equal(out.decision, 'fail', 'had the check existed, 1.13.0 would have needed a recorded exception');
});

test('releasing the same version again, or an older one, fails', () => {
  const same = P.diffSurfaces(base, clone(base));
  assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.12.4', diff: same }).decision, 'fail');
  assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.12.3', diff: same, override: 'x' }).decision, 'fail');
});

test('reading the current tree finds the real migration count, permissions and routes', () => {
  const s = P.surface(path.join(__dirname, '..'));
  assert.equal(s.migrations, require('../server/db').LATEST_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(s.perms).sort(), Object.keys(require('../server/auth').PERMS).sort());
  assert.ok(s.routes.includes('GET /api/health/live'));
  assert.ok(s.routes.includes('GET /api/clients/:'), 'generic CRUD routes are seen, with parameter names ignored');
  assert.ok(s.routes.some((r) => r.startsWith('GET /api/reports/')), 'routes registered through a wrapper are seen');
  assert.ok(s.routes.some((r) => r.startsWith('GET /fhir/')));
});

test('release.yml runs the policy in the gate and takes the exception only as an explicit input', () => {
  const rel = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const gate = rel.slice(rel.indexOf('\n  gate:'), rel.indexOf('\n  release:'));
  assert.match(gate, /node scripts\/release-policy\.js/, 'the gate job runs the policy check before anything is built');
  assert.match(gate, /refs\/tags\/v\*/, 'and fetches the tags it compares with');
  assert.match(rel, /allow_patch_changes:\n\s+description:/);
  assert.match(rel, /default: ''/);
  assert.match(rel, /ALLOW_PATCH_CHANGES: \$\{\{ github\.event\.inputs\.allow_patch_changes \}\}/, 'passed through the environment, never pasted into a script');
  assert.ok(!/run:.*\$\{\{ github\.event\.inputs\.allow_patch_changes/.test(rel), 'no script injection through the reason');
  assert.match(rel, /--notes-out/, 'the release job writes the override into the release notes');
  // 1.14.0: the exception's own name, for both rules; the earlier name still works.
  assert.match(rel, /policy_exception:\n\s+description:/);
  assert.equal((rel.match(/RELEASE_POLICY_EXCEPTION: \$\{\{ github\.event\.inputs\.policy_exception \}\}/g) || []).length, 2, 'passed through the environment to the gate and to the notes');
  assert.ok(!/run:.*\$\{\{ github\.event\.inputs\.policy_exception/.test(rel), 'no script injection through the reason');
  assert.match(gate, /RELEASE_POLICY_EXCEPTION/, 'the gate sees the exception');
  const policy = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release-policy.js'), 'utf8');
  assert.match(policy, /process\.env\.RELEASE_POLICY_EXCEPTION \|\| process\.env\.ALLOW_PATCH_CHANGES/);
});

// ---- 1.15.4: the browser kernel's own routes count, and a patch release stays small ----
test('the browser kernel\'s own routes (/api/local/*) are in the route inventory', () => {
  const src = `router.get('/api/local/status', () => 1);\n  router.post("/api/local/recover", async (ctx) => {});\n  router.put(\`/api/local/accounts/:id\`, f);\n  other.get('/nope');`;
  assert.deepEqual(P.localRoutes([src]), ['GET /api/local/status', 'POST /api/local/recover', 'PUT /api/local/accounts/:']);
  const s = P.surface(path.join(__dirname, '..'));
  for (const r of ['GET /api/local/status', 'POST /api/local/signup', 'POST /api/local/recover', 'POST /api/local/sync', 'GET /api/local/sync/status', 'PUT /api/local/accounts/:']) assert.ok(s.routes.includes(r), `${r} is seen`);
  // Every router.<verb>('/api/local/...') in local/ is found: a device route cannot hide in another file.
  const dir = path.join(__dirname, '..', 'local');
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) assert.ok(P.LOCAL_ROUTE_FILES.includes(`local/${f}`), `local/${f} is read for routes`);
  for (const r of P.localRoutes(all)) assert.ok(s.routes.includes(r), r);
});

test('a patch release that adds a device route fails like any other new route (1.15.1 added three)', () => {
  const next = clone(base); next.routes.push('POST /api/local/recovery');
  const out = P.decide({ prevVersion: 'v1.15.0', nextVersion: '1.15.1', diff: P.diffSurfaces(base, next) });
  assert.equal(out.decision, 'fail');
  assert.match(out.reason, /new route POST \/api\/local\/recovery/);
});

// `git diff --numstat` output, injected: added, deleted, path.
const NUMSTAT = [
  '900\t10\tserver/routes/new-feature.js',
  '700\t0\tpublic/views/new-feature.js',
  '4000\t0\ttest/new-feature.test.js', // tests do not count
  '600\t0\tscripts/ui/new-feature.mjs',
  '300\t20\tdocs/USER_GUIDE.md',
  '120\t0\tCHANGELOG.md',
  '5000\t4000\tpublic/local/kernel.js', // generated
  '40\t3\tserver/schema-text.js',
  '12\t12\tpublic/sw.js',
  '800\t100\tpackage-lock.json',
  '-\t-\tpublic/icons/new.png', // binary
  '5\t0\tserver/{old.js => renamed.js}',
  '3\t1\tdocs/{a.md => b.md}',
].join('\n');

test('the patch size counts added lines outside docs, tests and generated files', () => {
  const s = P.patchSize(NUMSTAT);
  assert.equal(s.added, 900 + 700 + 5);
  assert.deepEqual(s.files.map((f) => f.path), ['server/routes/new-feature.js', 'public/views/new-feature.js', 'server/renamed.js']);
  assert.equal(P.patchSize('').added, 0);
  assert.equal(P.PATCH_MAX_ADDED_LINES, 1500);
});

test('a patch release over the size limit fails, names its largest files, and passes with a policy exception', () => {
  const same = P.diffSurfaces(base, clone(base));
  const size = P.patchSize(NUMSTAT);
  const out = P.decide({ prevVersion: 'v1.15.3', nextVersion: '1.15.4', diff: same, size });
  assert.equal(out.decision, 'fail');
  assert.match(out.reason, /1605 lines added outside docs, tests and generated files, over the patch limit of 1500/);
  assert.match(out.reason, /largest: server\/routes\/new-feature\.js \+900, public\/views\/new-feature\.js \+700/);
  assert.match(out.reason, /policy_exception/);
  const ok = P.decide({ prevVersion: 'v1.15.3', nextVersion: '1.15.4', diff: same, size, override: 'Security fix: the review\'s finding 7 needs a new worker' });
  assert.equal(ok.decision, 'override');
  assert.match(ok.notes, /> \* 1605 lines added/);
  // The limit is configurable (PATCH_MAX_ADDED_LINES in the environment, passed in as maxAdded).
  assert.equal(P.decide({ prevVersion: 'v1.15.3', nextVersion: '1.15.4', diff: same, size, maxAdded: 2000 }).decision, 'pass');
  assert.equal(P.decide({ prevVersion: 'v1.15.3', nextVersion: '1.15.4', diff: same, size: P.patchSize('1500\t0\tserver/x.js') }).decision, 'pass', 'exactly the limit is allowed');
  assert.equal(P.decide({ prevVersion: 'v1.15.3', nextVersion: '1.15.4', diff: same, size: P.patchSize('1501\t0\tserver/x.js') }).decision, 'fail');
  // A feature release is not held to it.
  assert.equal(P.decide({ prevVersion: 'v1.15.3', nextVersion: '1.16.0', diff: same, size }).decision, 'pass');
});

test('the size is measured against the previous tag with git diff --numstat', () => {
  // 1.14.1 was a 24-line fix; skip in a checkout without the tags (a shallow CI clone).
  let s; try { s = P.measureSize('v1.14.0', 'v1.14.1'); } catch { return; }
  assert.ok(s.added > 0 && s.added < 100, `1.14.1 added ${s.added} counted lines`);
});

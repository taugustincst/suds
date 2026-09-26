'use strict';
// scripts/release-policy.js: a patch release carries no migration, no new permission and no new route unless
// the release is run with allow_patch_changes, whose reason is then printed in the release notes.
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
  assert.match(out.reason, /allow_patch_changes/, 'the refusal says how to override');
  for (const blank of ['', '   ', undefined]) {
    assert.equal(P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.12.5', diff: P.diffSurfaces(base, next), override: blank }).decision, 'fail', 'an empty override is no override');
  }
});

test('the override passes the release and puts the reason and every exception in the release notes', () => {
  const next = clone(base); next.routes.push('POST /api/auth/oidc/reauth'); next.perms.admin.push('reports:internal');
  const out = P.decide({ prevVersion: 'v1.12.4', nextVersion: '1.12.5', diff: P.diffSurfaces(base, next), override: 'Security fix from the independent review:\nre-authentication for SSO users' });
  assert.equal(out.decision, 'override');
  assert.match(out.notes, /Release policy override/);
  assert.match(out.notes, /Security fix from the independent review: re-authentication for SSO users/, 'the reason, on one line');
  assert.match(out.notes, /new route POST \/api\/auth\/oidc\/reauth/);
  assert.match(out.notes, /new permission reports:internal/);
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

test('release.yml runs the policy in the gate and takes the override only as an explicit input', () => {
  const rel = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const gate = rel.slice(rel.indexOf('\n  gate:'), rel.indexOf('\n  release:'));
  assert.match(gate, /node scripts\/release-policy\.js/, 'the gate job runs the policy check before anything is built');
  assert.match(gate, /refs\/tags\/v\*/, 'and fetches the tags it compares with');
  assert.match(rel, /allow_patch_changes:\n\s+description:/);
  assert.match(rel, /default: ''/);
  assert.match(rel, /ALLOW_PATCH_CHANGES: \$\{\{ github\.event\.inputs\.allow_patch_changes \}\}/, 'passed through the environment, never pasted into a script');
  assert.ok(!/run:.*\$\{\{ github\.event\.inputs\.allow_patch_changes/.test(rel), 'no script injection through the reason');
  assert.match(rel, /--notes-out/, 'the release job writes the override into the release notes');
});

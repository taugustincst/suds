'use strict';
// scripts/migration-order.js: a released migration keeps its position (its number is the schema version a
// database records), is never edited or removed, and new ones are appended after it with numbered headers.
// Two branches that each add "migration 49" and merge in the wrong order fail here, not at a county.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../scripts/migration-order');

const src = (bodies) => `const x = 1;\nconst migrations = [\n${bodies.map((b, i) => `  // ${i + 1}: migration ${b}\n  (d) => { d.exec(\`CREATE TABLE t${b} (id)\`); },`).join('\n')}\n];\nmodule.exports = {};\n`;

test('the migrations array is read one entry per numbered header, code compared without comments', () => {
  const chunks = M.migrationChunks(src(['a', 'b']));
  assert.deepEqual(chunks.map((c) => [c.number, c.title]), [[1, 'migration a'], [2, 'migration b']]);
  assert.equal(M.normalizeCode("(d) => { // note\n  d.exec('// not a comment'); /* gone */ }"), "(d) => { d.exec('// not a comment'); }");
  const real = M.migrationChunks(fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8'));
  assert.equal(real.length, require('../server/db').LATEST_SCHEMA_VERSION, 'one header per migration in server/db.js');
  assert.deepEqual(M.compareMigrations(null, real), [], 'server/db.js headers number its migrations 1..N in order');
});

test('appending migrations passes; a released one moved, edited or removed fails', () => {
  const prev = M.migrationChunks(src(['a', 'b', 'c']));
  assert.deepEqual(M.compareMigrations(prev, M.migrationChunks(src(['a', 'b', 'c', 'd']))), []);
  // Another branch's migration landed above a released one (a merge or rebase in the wrong order).
  const moved = M.compareMigrations(prev, M.migrationChunks(src(['a', 'd', 'b', 'c'])));
  assert.ok(moved.some((p) => /released migration 2 \(migration b\) moved to position 3/.test(p)), moved.join('\n'));
  const edited = M.compareMigrations(prev, M.migrationChunks(src(['a', 'B', 'c'])));
  assert.ok(edited.some((p) => /released migration 2 \(migration b\) was changed/.test(p)), edited.join('\n'));
  assert.ok(M.compareMigrations(prev, M.migrationChunks(src(['a', 'b']))).some((p) => /released migration 3 .* is gone/.test(p)));
  // A comment edit is not a code change.
  const recommented = src(['a', 'b', 'c']).replace('// 2: migration b', '// 2: migration b, better described');
  assert.deepEqual(M.compareMigrations(prev, M.migrationChunks(recommented)), []);
  // A header that does not carry the entry's position (two branches both wrote "// 4:").
  const twice = src(['a', 'b', 'c', 'd', 'e']).replace('// 5: migration e', '// 4: migration e');
  assert.ok(M.compareMigrations(prev, M.migrationChunks(twice)).some((p) => /position 5 is headed "\/\/ 4:"/.test(p)));
});

test('server/db.js keeps every migration of the previous release tag at its position', (t) => {
  const tag = (() => { try { return M.baselineTag(require('../package.json').version); } catch { return null; } })();
  if (!tag) {
    // CI's test job fetches the release tags and sets SUDS_REQUIRE_RELEASE_TAGS, so the check cannot be skipped there.
    if (process.env.SUDS_REQUIRE_RELEASE_TAGS) assert.fail('no release tag to compare server/db.js with: fetch the tags (git fetch origin "+refs/tags/v*:refs/tags/v*")');
    t.skip('no release tags in this checkout'); return;
  }
  const prev = M.migrationChunks(M.dbSourceAt(tag));
  const next = M.migrationChunks(fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8'));
  assert.deepEqual(M.compareMigrations(prev, next), [], `against ${tag}`);
});

test('CI\'s test job fetches the release tags and requires them for this check', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = ci.slice(ci.indexOf('\n  test:'), ci.indexOf('\n  thorough:'));
  assert.match(job, /git fetch --quiet --depth 1 origin '\+refs\/tags\/v\*:refs\/tags\/v\*'/);
  assert.match(job, /SUDS_REQUIRE_RELEASE_TAGS: '1'/);
});

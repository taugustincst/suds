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

test('a reviewed edit to a released migration passes only for the exact code it names (RELEASED_EDITS)', () => {
  const prev = M.migrationChunks(src(['a', 'b', 'c']));
  const next = M.migrationChunks(src(['a', 'B', 'c']));
  const fp = M.fingerprintCode(next[1].code);
  assert.ok(M.compareMigrations(prev, next, { edits: [] }).some((p) => p.includes(`fingerprint ${fp}`)), 'the failure names the fingerprint to record');
  assert.deepEqual(M.compareMigrations(prev, next, { edits: [{ number: 2, fingerprint: fp, reason: 'test' }] }), []);
  // The same fingerprint for another position, or the code changed again, is not acknowledged.
  assert.ok(M.compareMigrations(prev, next, { edits: [{ number: 3, fingerprint: fp, reason: 'test' }] }).some((p) => /released migration 2 .* was changed/.test(p)));
  const again = M.migrationChunks(src(['a', 'BB', 'c']));
  assert.ok(M.compareMigrations(prev, again, { edits: [{ number: 2, fingerprint: fp, reason: 'test' }] }).some((p) => /released migration 2 .* was changed/.test(p)));
  // Every recorded edit names a released position and says why it is safe.
  for (const e of M.RELEASED_EDITS) { assert.ok(Number.isInteger(e.number) && e.number > 0); assert.match(e.fingerprint, /^[0-9a-f]{16}$/); assert.ok(e.reason.length > 40); }
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
  // And what those migrations run and read (1.17.0): the helpers and schema.sql definitions, or an acknowledged change.
  assert.deepEqual(M.compareDependencies(M.migrationDependencies(M.treeAt(tag)), M.migrationDependencies(M.treeAt(null)), { tag }), [], `dependencies against ${tag}`);
});

// ---- What released migrations depend on (1.17.0; engineering review of 1.16.0, M6) ----
const DB = (migrations, helpers = '') => `'use strict';\nconst fs = require('node:fs');\nconst path = require('node:path');\nfunction safeSchema() { return fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'); }\n`
  + `const addColumn = (d, table, col, def) => { d.exec(\`ALTER TABLE \${table} ADD COLUMN \${col} \${def}\`); };\n`
  + `// Rebuild a table from schema.sql.\nfunction rebuildTable(d, schemaText, table) {\n  const m = schemaText.match(new RegExp(\`CREATE TABLE IF NOT EXISTS \${table} \\\\(\`));\n  if (!m) throw new Error('no ' + table);\n}\n${helpers}`
  + `const migrations = [\n${migrations.map((b, i) => `  // ${i + 1}: m${i + 1}\n  ${b},`).join('\n')}\n];\nfunction open() { return 1; }\nmodule.exports = { migrations };\n`;
const SCHEMA = (extra = {}) => ['CREATE TABLE IF NOT EXISTS tasks (', `  id TEXT PRIMARY KEY${extra.tasks || ''}`, ');', 'CREATE INDEX IF NOT EXISTS idx_tasks_id ON tasks(id);',
  'CREATE TABLE IF NOT EXISTS notes (', `  id TEXT PRIMARY KEY${extra.notes || ''}`, ');', 'CREATE INDEX IF NOT EXISTS idx_notes_id ON notes(id);'].join('\n') + '\n';
const MIGS = [
  "(d) => { addColumn(d, 'notes', 'title', 'TEXT'); }",
  "(d) => { const schemaText = safeSchema(); rebuildTable(d, schemaText, 'tasks'); d.exec(`UPDATE notes SET id = id`); }",
  "(d) => { const { decrypt } = require('./crypto'); const open = d.prepare('SELECT 1').all(); for (const r of open) decrypt(r); }",
];
const tree = (o = {}) => ({ db: o.db || DB(MIGS, o.helpers), schema: o.schema || SCHEMA(o.extra), module: (f) => (f === 'crypto.js' ? (o.crypto || "'use strict';\nfunction decrypt(x) { return x; }\nfunction encrypt(x) { return x; }\nmodule.exports = { decrypt, encrypt };\n") : null) });
const deps = (o) => M.migrationDependencies(tree(o));

test('what each released migration runs and reads: helpers by name, required functions, schema.sql tables it takes from the file', () => {
  const d = deps().deps;
  assert.deepEqual(d[0], ['db.js#addColumn'], 'addColumn\'s own SQL is not a schema.sql read');
  assert.deepEqual(d[1], ['db.js#fs', 'db.js#path', 'db.js#rebuildTable', 'db.js#safeSchema', 'schema.sql:index:idx_tasks_id', 'schema.sql:table:tasks'], 'tasks through rebuildTable; notes only in its own SQL');
  assert.deepEqual(d[2], ['crypto.js#decrypt'], 'a required function; `open` is its own variable, not db.js\'s open()');
});

test('a changed helper, required function or schema.sql definition a released migration depends on fails, naming them; comments and unrelated changes do not', () => {
  const prev = deps();
  const cmp = (o) => M.compareDependencies(prev, deps(o), { tag: 'v9.9.9', acks: [] });
  assert.deepEqual(cmp({}), []);
  assert.deepEqual(cmp({ db: DB(MIGS).replace('// Rebuild a table from schema.sql.', '// Rebuild it (reworded).') }), [], 'a comment');
  assert.deepEqual(cmp({ extra: { notes: ',\n  body TEXT' } }), [], 'notes is not read from schema.sql by a released migration');
  assert.deepEqual(cmp({ helpers: 'function unrelated() { return 2; }\n' }), [], 'a new helper');
  const helper = cmp({ db: DB(MIGS).replace("if (!m) throw new Error('no ' + table);", "if (!m) return;") });
  assert.equal(helper.length, 1); assert.match(helper[0], /^db\.js rebuildTable\(\), which released migration\(s\) 2 run, changed since v9\.9\.9 \(fingerprint [0-9a-f]{16}\)/);
  const table = cmp({ extra: { tasks: ',\n  title TEXT NOT NULL' } });
  assert.equal(table.length, 1); assert.match(table[0], /^schema\.sql's table tasks, which released migration\(s\) 2 read from schema\.sql, changed since v9\.9\.9/);
  const mod = cmp({ crypto: "'use strict';\nfunction decrypt(x) { return String(x); }\nmodule.exports = { decrypt };\n" });
  assert.equal(mod.length, 1); assert.match(mod[0], /^crypto\.js decrypt\(\), which released migration\(s\) 3 run, changed/);
  const gone = cmp({ schema: SCHEMA().replace(/CREATE INDEX IF NOT EXISTS idx_tasks_id[^\n]*\n/, '') });
  assert.equal(gone.length, 1); assert.match(gone[0], /index idx_tasks_id, which released migration\(s\) 2 read from schema\.sql, is gone since v9\.9\.9/);
});

test('a reviewed change is acknowledged with its new fingerprint and passes; a later change needs a new acknowledgement', () => {
  const prev = deps();
  const next = deps({ extra: { tasks: ',\n  title TEXT' } });
  const fp = /fingerprint ([0-9a-f]{16})/.exec(M.compareDependencies(prev, next, { acks: [] })[0])[1];
  assert.deepEqual(M.compareDependencies(prev, next, { acks: [{ dependency: 'schema.sql:table:tasks', fingerprint: fp, reason: 'additive, nullable' }] }), []);
  const again = deps({ extra: { tasks: ',\n  title TEXT,\n  due TEXT' } });
  assert.equal(M.compareDependencies(prev, again, { acks: [{ dependency: 'schema.sql:table:tasks', fingerprint: fp, reason: 'x' }] }).length, 1);
  assert.deepEqual(M.compareDependencies(prev, deps({ schema: SCHEMA().replace(/CREATE INDEX IF NOT EXISTS idx_tasks_id[^\n]*\n/, '') }), { acks: [{ dependency: 'schema.sql:index:idx_tasks_id', fingerprint: 'gone', reason: 'dropped by migration 47' }] }), []);
  for (const a of M.DEPENDENCY_CHANGES) {
    assert.ok(a.dependency && /^([0-9a-f]{16}|gone)$/.test(a.fingerprint) && String(a.reason || '').length > 10, `DEPENDENCY_CHANGES entry ${JSON.stringify(a)} has a dependency, a fingerprint and a reason`);
  }
});

test('the lexer tells code from strings, templates, regular expressions and comments', () => {
  const t = M.lex("const a = '}' + `x${b + `y${c}`}z` / 2; const r = /[/}]'/g; // }\n{ d }");
  assert.deepEqual(t.filter((x) => x.type === 'id').map((x) => x.value), ['const', 'a', 'b', 'c', 'const', 'r', 'd']);
  assert.deepEqual(t.filter((x) => x.type === 'regex').map((x) => x.value), ["/[/}]'/g"]);
  assert.ok(t.every((x) => x.depth >= 0) && t[t.length - 1].depth === 0, 'brackets balance');
  const top = M.topLevel("function f() {\n  return 1;\n}\nconst { a, b: c } = require('./m');\nconst x = `\nnot a statement\n`;\nmodule.exports = {};\n");
  assert.deepEqual([...top.keys()], ['f', 'a', 'c', 'x']);
});

test('history: the check would have stopped 1.14.0, which changed encryptColumn and dropped supply_stock from schema.sql under released migrations', (t) => {
  let before; let after;
  try { before = M.migrationDependencies(M.treeAt('v1.13.0')); after = M.migrationDependencies(M.treeAt('v1.14.0')); } catch { t.skip('no release tags in this checkout'); return; }
  const found = M.compareDependencies(before, after, { tag: 'v1.13.0', acks: [] });
  assert.ok(found.some((p) => /^db\.js encryptColumn\(\), which released migration\(s\) 5, 19, 24/.test(p)), found.join('\n'));
  assert.ok(found.some((p) => /^schema\.sql's table supply_stock, which released migration\(s\) 20 read from schema\.sql, is gone/.test(p)), found.join('\n'));
});

test('CI\'s test job fetches the release tags and requires them for this check', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = ci.slice(ci.indexOf('\n  test:'), ci.indexOf('\n  thorough:'));
  assert.match(job, /git fetch --quiet --depth 1 origin '\+refs\/tags\/v\*:refs\/tags\/v\*'/);
  assert.match(job, /SUDS_REQUIRE_RELEASE_TAGS: '1'/);
});

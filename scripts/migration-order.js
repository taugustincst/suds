'use strict';
// Migration numbering across parallel branches (docs/architecture/ADR-0007-migrations.md, "Numbering").
// The schema version of a database is the number of migrations that have run on it, so a released migration's
// position in server/db.js's `migrations` array IS its identity. Two branches that each append "migration 49"
// and are merged in the wrong order, or a rebase that moves one migration above another, would make a county
// that upgraded from one branch's build skip the other's migration forever. This compares the array with the
// one in the previous release tag:
//   * every migration the tag had is still there, at the same position, with the same code (comments and
//     whitespace aside), and its header comment still carries its number (`// 45: ...`);
//   * the migrations after the tag's are numbered on from it, one header per entry, in order;
//   * since 1.17.0, what the tag's migrations depend on (the helpers they run and the schema.sql definitions they
//     read) is unchanged, or the change is acknowledged in DEPENDENCY_CHANGES (below, "What released migrations
//     depend on").
//
//   node scripts/migration-order.js [--previous v1.15.3]      # compare the working tree with a tag
//
// `migrationChunks` and `compareMigrations` are pure and tested in test/migration-order.test.js, which also
// runs the check against the previous release tag (CI's `test` job fetches the tags for it).

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HEADER = /^ {2}\/\/ (\d+): ?(.*)$/;

/** Strip // and /* *\/ comments outside strings and template literals, then collapse whitespace. */
function normalizeCode(src) {
  let out = ''; let i = 0; let q = null;
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (q) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    out += c; i++;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The migrations array of a server/db.js source, one entry per `// N: ...` header comment.
 * @returns {Array<{ number: number, title: string, code: string }>} code: normalized (normalizeCode)
 */
function migrationChunks(src) {
  const lines = String(src).split('\n');
  const start = lines.findIndex((l) => /^const migrations = \[\s*$/.test(l));
  if (start < 0) throw new Error('server/db.js has no `const migrations = [` line');
  const end = lines.findIndex((l, i) => i > start && /^\];\s*$/.test(l));
  if (end < 0) throw new Error('the migrations array in server/db.js has no closing `];` line');
  const chunks = [];
  let cur = null;
  for (const line of lines.slice(start + 1, end)) {
    const h = HEADER.exec(line);
    if (h) { cur = { number: Number(h[1]), title: h[2].trim(), body: [] }; chunks.push(cur); continue; }
    if (!cur) { if (line.trim()) throw new Error(`code before the first migration header: ${line.trim()}`); continue; }
    cur.body.push(line);
  }
  return chunks.map((c) => ({ number: c.number, title: c.title, code: normalizeCode(c.body.join('\n')) }));
}

/**
 * Problems with `next` (the tree being built) against `prev` (the previous release), as sentences; [] = none.
 * `prev` may be null (no release to compare with): only the numbering of `next` is checked.
 */
function compareMigrations(prev, next) {
  const out = [];
  next.forEach((m, i) => { if (m.number !== i + 1) out.push(`the migration at position ${i + 1} is headed "// ${m.number}:" (headers number the array from 1, one per migration, in order)`); });
  if (!prev) return out;
  const where = (code) => next.findIndex((m) => m.code === code);
  prev.forEach((m, i) => {
    const at = where(m.code);
    if (i >= next.length) out.push(`released migration ${i + 1} (${m.title}) is gone: released migrations are never removed`);
    else if (next[i].code === m.code) return;
    else if (at >= 0) out.push(`released migration ${i + 1} (${m.title}) moved to position ${at + 1}: a released migration keeps its number; append new ones after ${prev.length}`);
    else out.push(`released migration ${i + 1} (${m.title}) was changed: a released migration is never edited (fix forward with a new migration)`);
  });
  return out;
}

// ---- What released migrations depend on (1.17.0; engineering review of 1.16.0, M6) ------------------------------
// A released migration's own code is pinned above, but it also runs helpers (addColumn, encryptColumn, rebuildTable,
// migrateSupplies, createIndexesFromSchema, functions of other server modules such as crypto.decrypt) and, through
// safeSchema(), today's schema.sql: rebuildTable and the table-creating migrations take a table's definition from the
// current file. Editing one of those silently changes what an old migration does on a county database that has not
// yet run it (a table rebuilt from today's schema before an intermediate migration that expects the old shape). So
// the check also fingerprints, per released migration, every such dependency at the previous release tag, and fails
// when one changed, unless the change is acknowledged below with its new fingerprint and the reason it is safe
// (the upgrade fixtures of test/migrations.test.js pass; the helper stays idempotent; the table change is
// additive). Heuristic, and it says so: it finds helpers by name (top-level functions and constants of server/db.js
// and of the modules a migration requires with a relative path), and schema.sql tables by their name appearing in a
// schema-reading migration outside its own SQL (d.exec, d.prepare, addColumn and the like), with the indexes and
// triggers on them. It does not follow a dynamic require, a helper passed around as a value, or a module required
// by a helper's module in turn.

/**
 * Changes to what released migrations depend on that were reviewed and are safe: { dependency, fingerprint, reason }.
 * `dependency` and `fingerprint` are what the failure names; an entry stops applying when the dependency changes
 * again. Entries can be removed once a release tag includes the change (the next comparison starts from it).
 */
const DEPENDENCY_CHANGES = [
  {
    dependency: 'schema.sql:table:interventions', fingerprint: 'd780d1abc3b41803',
    reason: '1.17.0 (migration 51) adds two nullable columns, participant_code_enc and participant_code_idx, and the index '
      + 'idx_interventions_participant. Additive: a database that runs migration 5 now rebuilds interventions with the two '
      + 'columns already there (every row NULL), migration 51 adds each only when missing (addColumn) and creates the '
      + 'index IF NOT EXISTS, and test/migrations.test.js upgrades the 1.6.1 fixture through migration 5 and 51 to the '
      + 'same structure as a fresh install.',
  },
];

/** Tokens of JavaScript source, enough to tell code from strings, comments, templates and regular expressions. */
function lex(src) {
  const toks = []; const tmpl = []; let depth = 0; let i = 0;
  const push = (type, value, pos, d = depth) => toks.push({ type, value, pos, depth: d });
  const regexOk = () => {
    const t = toks[toks.length - 1];
    if (!t) return true;
    if (t.type === 'punct') return !/^[)\]}]$/.test(t.value);
    return t.type === 'id' && /^(return|typeof|case|in|of|new|delete|void|throw|else|do|yield|await)$/.test(t.value);
  };
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { s += src[j + 1] || ''; j += 2; continue; } s += src[j++]; }
      push('str', s, i); i = j + 1; continue;
    }
    if (c === '`' || (c === '}' && tmpl.length && tmpl[tmpl.length - 1] === depth)) {
      if (c === '}') tmpl.pop();
      let j = i + 1; let s = ''; let open = false;
      while (j < src.length) {
        if (src[j] === '\\') { s += src[j + 1] || ''; j += 2; continue; }
        if (src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') { tmpl.push(depth); j += 2; open = true; break; }
        s += src[j++];
      }
      push('str', s, i); i = j; if (open) continue; continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1; let cls = false;
      while (j < src.length && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; j++; }
      j++; while (/[a-z]/.test(src[j] || '')) j++;
      push('regex', src.slice(i, j), i); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < src.length && /[\w$]/.test(src[j])) j++; push('id', src.slice(i, j), i); i = j; continue; }
    if (/\d/.test(c)) { let j = i; while (j < src.length && /[\w.]/.test(src[j])) j++; push('num', src.slice(i, j), i); i = j; continue; }
    if ('([{'.includes(c)) { push('punct', c, i); depth++; i++; continue; }
    if (')]}'.includes(c)) { depth--; push('punct', c, i); i++; continue; }
    push('punct', c, i); i++;
  }
  return toks;
}

/**
 * The top-level declarations of a module: Map name -> normalized source of the statement that declares it. A
 * statement starts at a token in column 0 outside any bracket; `function f`, `async function f`, `const|let|var x`
 * and `const { a, b: c } = …` are named (a and c for the last).
 */
function topLevel(src) {
  src = String(src);
  const starts = lex(src).filter((t) => t.depth === 0 && (t.pos === 0 || src[t.pos - 1] === '\n')).map((t) => t.pos);
  const out = new Map();
  starts.forEach((s, k) => {
    const text = src.slice(s, k + 1 < starts.length ? starts[k + 1] : src.length);
    const m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s*\{([^}]*)\}/.exec(text);
    if (!m) return;
    const names = m[3] ? m[3].split(',').map((x) => x.split(':').pop().trim()).filter(Boolean) : [m[1] || m[2]];
    for (const name of names) out.set(name, normalizeCode(text));
  });
  return out;
}

/** Identifiers a piece of code uses (not properties after a dot), and relative requires: { mod, names } . */
function references(code) {
  const toks = lex(code);
  const ids = new Set(); const reqs = [];
  // Names the code declares itself (`const open = …` in migration 5 is not db.js's open()): not references.
  const local = new Set();
  toks.forEach((t, k) => {
    if (t.type !== 'id' || !/^(const|let|var|function)$/.test(t.value) || !toks[k + 1]) return;
    const n = toks[k + 1];
    if (n.type === 'id') { local.add(n.value); return; }
    if (n.value === '{' || n.value === '[') { for (let x = k + 2; x < toks.length && !(toks[x].depth === n.depth && (toks[x].value === '}' || toks[x].value === ']')); x++) if (toks[x].type === 'id') local.add(toks[x].value); }
  });
  toks.forEach((t, k) => { if (t.type === 'id' && !local.has(t.value) && !(toks[k - 1] && toks[k - 1].value === '.')) ids.add(t.value); });
  // const { a, b } = require('./m')   /   const M = require('./m') … M.a
  for (let k = 0; k < toks.length; k++) {
    if (!(toks[k].type === 'id' && toks[k].value === 'require' && toks[k + 1] && toks[k + 1].value === '(' && toks[k + 2] && toks[k + 2].type === 'str' && /^\.\.?\//.test(toks[k + 2].value))) continue;
    const mod = toks[k + 2].value;
    let j = k - 1; if (!(toks[j] && toks[j].value === '=')) continue; j--;
    if (toks[j] && toks[j].type === 'id') {
      const alias = toks[j].value;
      const names = new Set(); toks.forEach((t, x) => { if (t.type === 'id' && t.value === alias && toks[x + 1] && toks[x + 1].value === '.' && toks[x + 2] && toks[x + 2].type === 'id') names.add(toks[x + 2].value); });
      reqs.push({ mod, names: [...names] });
    } else if (toks[j] && toks[j].value === '}') {
      const names = []; let x = j - 1;
      while (x >= 0 && toks[x].value !== '{') { if (toks[x].type === 'id' && !(toks[x + 1] && toks[x + 1].value === ':')) names.push(toks[x].value); x--; }
      reqs.push({ mod, names: names.reverse() });
    }
  }
  return { ids, reqs };
}

const NON_SCHEMA_CALLS = new Set(['exec', 'prepare', 'addColumn', 'encryptColumn', 'tableExists', 'tableCols']);
/** Every word of code that is not inside a call that runs SQL of its own (the names a schema-reading migration takes from schema.sql). */
function schemaWords(code) {
  const toks = lex(code); const words = new Set();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'id' && NON_SCHEMA_CALLS.has(t.value) && toks[k + 1] && toks[k + 1].value === '(') {
      const d = toks[k + 1].depth; k += 2; while (k < toks.length && !(toks[k].value === ')' && toks[k].depth === d)) k++;
      continue;
    }
    for (const w of String(t.value).match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) words.add(w);
  }
  return words;
}

/** schema.sql's statements: Map 'schema.sql:table:x' | ':index:x' | ':trigger:x' -> { text, table }. */
function schemaStatements(sql) {
  const norm = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const out = new Map();
  for (const m of String(sql).matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\n\);/g)) out.set(`schema.sql:table:${m[1]}`, { text: norm(m[0]), table: m[1] });
  for (const m of String(sql).matchAll(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)\s*\(.*$/gm)) out.set(`schema.sql:index:${m[1]}`, { text: norm(m[0]), table: m[2] });
  for (const m of String(sql).matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)[^;]*? ON (\w+)[\s\S]*?END;/g)) out.set(`schema.sql:trigger:${m[1]}`, { text: norm(m[0]), table: m[2] });
  return out;
}

const fingerprint = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * What each migration depends on, and every dependency's fingerprint, for one tree.
 * @param {{ db: string, schema: string, module: (file: string) => string|null }} tree server/db.js, server/schema.sql,
 *   and a reader of other server files ('crypto.js' -> its source, null when missing)
 * @returns {{ deps: string[][], prints: Map<string,string> }} deps[i]: migration i+1's dependencies, sorted
 */
function migrationDependencies(tree) {
  const mods = new Map();
  const index = (file) => {
    if (!mods.has(file)) { const src = file === 'db.js' ? tree.db : tree.module(file); const t = src == null ? new Map() : topLevel(src); if (file === 'db.js') t.delete('migrations'); mods.set(file, t); }
    return mods.get(file);
  };
  const resolve = (from, mod) => path.posix.normalize(path.posix.join(path.posix.dirname(from), mod)).replace(/\.js$/, '') + '.js';
  const statements = schemaStatements(tree.schema);
  const prints = new Map();
  const code = (key) => { const [file, name] = key.split('#'); return index(file).get(name); };
  const deps = migrationChunks(tree.db).map((m) => {
    const found = new Set(); const helperCode = [];
    const visit = (src, file) => {
      const { ids, reqs } = references(src);
      for (const id of ids) {
        const key = `${file}#${id}`;
        if (index(file).has(id) && !found.has(key)) { found.add(key); if (file === 'db.js') helperCode.push(index(file).get(id)); visit(index(file).get(id), file); }
      }
      for (const r of reqs) {
        const target = resolve(file, r.mod);
        for (const n of r.names) { const key = `${target}#${n}`; if (index(target).has(n) && !found.has(key)) { found.add(key); visit(index(target).get(n), target); } }
      }
    };
    visit(m.code, 'db.js');
    for (const k of found) prints.set(k, fingerprint(code(k)));
    // A migration that reads schema.sql (itself or through a helper) depends on the tables it names there, and on
    // the indexes and triggers on them or named.
    const all = [m.code, ...helperCode];
    if (all.some((c) => /\b(safeSchema|schemaText)\b/.test(c))) {
      const words = new Set(all.flatMap((c) => [...schemaWords(c)]));
      const tables = new Set([...statements].filter(([k, s]) => k.includes(':table:') && words.has(s.table)).map(([, s]) => s.table));
      for (const [k, s] of statements) {
        const name = k.split(':').pop();
        if (k.includes(':table:') ? tables.has(s.table) : (words.has(name) || tables.has(s.table))) { found.add(k); prints.set(k, fingerprint(s.text)); }
      }
    }
    return [...found].sort();
  });
  // The fingerprints of every statement and helper of this tree, for looking up what a previous tree depended on.
  for (const [k, s] of statements) if (!prints.has(k)) prints.set(k, fingerprint(s.text));
  return { deps, prints, lookup: (key) => { if (prints.has(key)) return prints.get(key); if (key.startsWith('schema.sql:')) return null; const c = code(key); return c == null ? null : fingerprint(c); } };
}

/**
 * Problems: a dependency of a released migration (one of `prev`'s, by `prev`'s tree) whose fingerprint differs in
 * `next`, and is not acknowledged in `acks` with next's fingerprint. `tag` names the previous release in the text.
 */
function compareDependencies(prev, next, { tag = 'the previous release', acks = DEPENDENCY_CHANGES } = {}) {
  const users = new Map();
  prev.deps.forEach((ds, i) => { for (const d of ds) { if (!users.has(d)) users.set(d, []); users.get(d).push(i + 1); } });
  const out = [];
  for (const [dep, ms] of [...users].sort(([a], [b]) => a.localeCompare(b))) {
    const before = prev.lookup(dep); const after = next.lookup(dep);
    if (before === after) continue;
    if (acks.some((a) => a.dependency === dep && a.fingerprint === (after || 'gone'))) continue;
    const what = dep.startsWith('schema.sql:') ? `schema.sql's ${dep.split(':')[1]} ${dep.split(':')[2]}, which released migration(s) ${ms.join(', ')} read from schema.sql,` : `${dep.replace('#', ' ')}(), which released migration(s) ${ms.join(', ')} run,`;
    out.push(after
      ? `${what} changed since ${tag} (fingerprint ${after}): a database that has not run them yet would now get the new definition. If that is safe (the upgrade fixtures in test/migrations.test.js pass, and the change is additive or the helper still idempotent), add { dependency: '${dep}', fingerprint: '${after}', reason: '…' } to DEPENDENCY_CHANGES in scripts/migration-order.js`
      : `${what} is gone since ${tag}: those migrations no longer run as released. If that is safe (the upgrade fixtures pass), add { dependency: '${dep}', fingerprint: 'gone', reason: '…' } to DEPENDENCY_CHANGES in scripts/migration-order.js`);
  }
  return out;
}

/** The tree at a git ref (or the working tree, ref null) as migrationDependencies reads it. */
function treeAt(ref) {
  const read = (p) => {
    try { return ref ? execFileSync('git', ['show', `${ref}:server/${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, 'server', p), 'utf8'); } catch { return null; }
  };
  const db = read('db.js'); const schema = read('schema.sql');
  if (db == null || schema == null) throw new Error(`no server/db.js or server/schema.sql at ${ref || 'the working tree'}`);
  return { db, schema, module: read };
}

/** The newest vX.Y.Z tag at or below `version` that is not the working tree itself, or null. */
function baselineTag(version) {
  const P = require('./release-policy');
  const tags = execFileSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter((t) => P.parseVersion(t));
  const atOrBelow = tags.filter((t) => P.compareVersions(t, version) <= 0).sort(P.compareVersions);
  return atOrBelow.pop() || null;
}
function dbSourceAt(ref) { return execFileSync('git', ['show', `${ref}:server/db.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }

function main() {
  const i = process.argv.indexOf('--previous');
  const tag = i > 0 ? process.argv[i + 1] : baselineTag(require(path.join(ROOT, 'package.json')).version);
  const next = migrationChunks(fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8'));
  const prev = tag ? migrationChunks(dbSourceAt(tag)) : null;
  const problems = compareMigrations(prev, next);
  // What the released migrations depend on (helpers, schema.sql), fingerprinted at the tag and now.
  if (tag) {
    const before = migrationDependencies(treeAt(tag)); const now = migrationDependencies(treeAt(null));
    problems.push(...compareDependencies(before, now, { tag }));
    console.log(`[migration-order] ${new Set(before.deps.flat()).size} helpers and schema.sql statements that released migrations depend on, compared with ${tag}`);
  }
  console.log(`[migration-order] ${next.length} migrations; compared with ${tag || 'no release tag'}${prev ? ` (${prev.length})` : ''}: ${problems.length ? 'FAIL' : 'ok'}`);
  for (const p of problems) console.log(`  - ${p}`);
  return problems.length ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.log(`::error::The migration order check could not run: ${e.message}`); process.exitCode = 1; }
}
module.exports = { normalizeCode, migrationChunks, compareMigrations, baselineTag, dbSourceAt, lex, topLevel, references, schemaWords, schemaStatements, migrationDependencies, compareDependencies, treeAt, DEPENDENCY_CHANGES };

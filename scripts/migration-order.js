'use strict';
// Migration numbering across parallel branches (docs/architecture/ADR-0007-migrations.md, "Numbering").
// The schema version of a database is the number of migrations that have run on it, so a released migration's
// position in server/db.js's `migrations` array IS its identity. Two branches that each append "migration 49"
// and are merged in the wrong order, or a rebase that moves one migration above another, would make a county
// that upgraded from one branch's build skip the other's migration forever. This compares the array with the
// one in the previous release tag:
//   * every migration the tag had is still there, at the same position, with the same code (comments and
//     whitespace aside), and its header comment still carries its number (`// 45: ...`);
//   * the migrations after the tag's are numbered on from it, one header per entry, in order.
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
  console.log(`[migration-order] ${next.length} migrations; compared with ${tag || 'no release tag'}${prev ? ` (${prev.length})` : ''}: ${problems.length ? 'FAIL' : 'ok'}`);
  for (const p of problems) console.log(`  - ${p}`);
  return problems.length ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.log(`::error::The migration order check could not run: ${e.message}`); process.exitCode = 1; }
}
module.exports = { normalizeCode, migrationChunks, compareMigrations, baselineTag, dbSourceAt };

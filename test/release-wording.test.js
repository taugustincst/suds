'use strict';
// The documents say what a coming feature release adds with one phrase, "built for X.Y.Z, not yet released"
// (market review of the 1.17.0 candidate, finding 4). Every such line becomes false the moment X.Y.Z is stamped,
// so this test fails once package.json's version has a dated CHANGELOG heading ("## X.Y.Z — YYYY-MM-DD") while a
// document still says X.Y.Z is not yet released; and it refuses the other spellings of the same thing, so there is
// one phrase for the stamp checklist (docs/RELEASE.md, *Cutting a release*) to search for.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function docs() {
  const out = [path.join(ROOT, 'README.md')];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) out.push(p); } };
  walk(path.join(ROOT, 'docs'));
  // The evidence index describes a stamp commit and its tag, not a feature (docs/evidence/README.md).
  return out.filter(p => !p.includes(`${path.sep}evidence${path.sep}`));
}
// Markdown emphasis and line breaks are not part of the phrase.
const flat = (s) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
const rel = (p) => path.relative(ROOT, p);

/** Versions whose CHANGELOG section carries a date: stamped. */
function stamped() {
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  return new Set([...log.matchAll(/^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}\s*$/gm)].map(m => m[1]));
}
/** Every "built for X.Y.Z, not yet released" in the documents: [file, version]. */
function notYetReleased() {
  const out = [];
  for (const f of docs()) for (const m of flat(fs.readFileSync(f, 'utf8')).matchAll(/built for (\d+\.\d+\.\d+),? not yet released/gi)) out.push([rel(f), m[1]]);
  return out;
}

test('no document says the stamped version is not yet released', () => {
  const version = require('../package.json').version;
  const dated = stamped();
  // Any stamped version, the current one included: a line left from an earlier release is as wrong.
  const stale = notYetReleased().filter(([, v]) => dated.has(v));
  assert.deepEqual(stale, [], `stamped ${[...new Set(stale.map(([, v]) => v))].join(', ')} (package.json: ${version}) but still "not yet released" in: ${stale.map(([f]) => f).join(', ')}. Rewrite each to say what is now true (docs/RELEASE.md, stamp checklist).`);
});

/** Every "built for X.Y.Z" in the documents, with or without "not yet released": [file, version, context]. */
function builtFor() {
  const out = [];
  for (const f of docs()) {
    const text = flat(fs.readFileSync(f, 'utf8'));
    for (const m of text.matchAll(/built for (\d+\.\d+\.\d+)/gi)) out.push([rel(f), m[1], text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20)]);
  }
  return out;
}

test('no document says a stamped version\'s feature is only "built for" it', () => {
  // "Built for X.Y.Z" describes a candidate. Once X.Y.Z is stamped, the line says "released in X.Y.Z" or
  // "available from X.Y.Z" instead, even where "not yet released" was already taken out (market review of 1.17.0).
  const dated = stamped();
  const stale = builtFor().filter(([, v]) => dated.has(v));
  assert.deepEqual(stale.map(([f, v, c]) => `${f} (${v}): "…${c}…"`), [], 'say "released in X.Y.Z" or "available from X.Y.Z" for a stamped version');
});

test('one phrase for an unreleased version: "built for X.Y.Z, not yet released"', () => {
  const bad = [];
  for (const f of docs()) {
    const text = flat(fs.readFileSync(f, 'utf8'));
    for (const re of [/not yet tagged/gi, /not yet in a released version/gi, /before that release is tagged/gi, /built for \d+\.\d+\.\d+ and not yet released/gi, /planned for \d+\.\d+\.\d+/gi]) {
      for (const m of text.matchAll(re)) bad.push(`${rel(f)}: "…${text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 10)}…"`);
    }
  }
  assert.deepEqual(bad, [], 'say "built for X.Y.Z, not yet released" (or, for a release gate, "not available until X.Y.Z is released")');
});

test('the check finds what it is for', () => {
  // A stamped heading is recognised, an unstamped one is not; and the phrase is found across a line break and bold.
  assert.ok(stamped().has('1.16.4'), 'the latest stamped release');
  assert.ok(!stamped().has('9.9.9'));
  const m = [...flat('the copilot is **built for 1.17.0,\nnot yet released** (office only)').matchAll(/built for (\d+\.\d+\.\d+),? not yet released/gi)];
  assert.equal(m.length, 1); assert.equal(m[0][1], '1.17.0');
  // A bare "built for" a stamped version is found too, across a line break and bold.
  const bare = [...flat('the copilot **built for\n1.16.4** (office only)').matchAll(/built for (\d+\.\d+\.\d+)/gi)];
  assert.equal(bare.length, 1); assert.ok(stamped().has(bare[0][1]));
  // While package.json's version is not yet stamped, the documents describe what it adds with the phrase; once it is
  // stamped, none may (the test above).
  const version = require('../package.json').version;
  if (!stamped().has(version)) assert.ok(notYetReleased().length > 0, `the documents do use the phrase while ${version} is being built`);
});

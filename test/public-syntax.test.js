'use strict';
// Every browser module parses (1.25.2). public/ is served as-is, with no build step, so a syntax error in one view
// (an unescaped quote, or two branches merged side by side that both declare the same export) breaks that page,
// or every page, and only the browser suite would notice. Each module is checked as an ES module by `node --check`
// on a copy with the .mjs extension; nothing is run.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function modules(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== path.join(PUBLIC, 'local')) out.push(...modules(p)); } // the kernel is built and checked by its own build
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every module under public/ is valid JavaScript', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-syntax-'));
  const bad = [];
  try {
    for (const f of modules(PUBLIC)) {
      const copy = path.join(tmp, 'm.mjs');
      fs.copyFileSync(f, copy);
      try { execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }); }
      catch (e) { bad.push(`${path.relative(ROOT, f)}: ${String(e.stderr).split('\n').find((l) => /Error/.test(l)) || 'does not parse'}`); }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.deepEqual(bad, [], 'a browser module does not parse');
});

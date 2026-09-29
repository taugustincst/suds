'use strict';
// The software bill of materials (scripts/sbom.js; docs/evidence/README.md). The committed SBOM must be exactly
// what the script produces from the commit it records, so a reviewer who regenerates it gets the same bytes; and
// the script must keep working on the current tree, where it also checks that server/ requires only Node
// built-ins and that every npm package bundled into the browser kernel is in package-lock.json.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const S = require('../scripts/sbom');

const ROOT = path.join(__dirname, '..');
const EVIDENCE = path.join(ROOT, 'docs', 'evidence');
const semver = (f) => f.match(/^sbom-(\d+)\.(\d+)\.(\d+)\.cdx\.json$/).slice(1).map(Number);
const prop = (o, name) => ((o.properties || []).find(p => p.name === name) || {}).value;

/** The committed SBOM of the newest version. */
function newest() {
  const files = fs.readdirSync(EVIDENCE).filter(f => /^sbom-\d+\.\d+\.\d+\.cdx\.json$/.test(f))
    .sort((a, b) => { const x = semver(a); const y = semver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  assert.ok(files.length, 'docs/evidence has a committed SBOM (sbom-<version>.cdx.json)');
  const file = path.join(EVIDENCE, files[files.length - 1]);
  return { file, text: fs.readFileSync(file, 'utf8'), bom: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function checkShape(bom) {
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.specVersion, '1.5');
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(bom.metadata.timestamp, /^\d{4}-\d\d-\d\dT00:00:00Z$/);
  const refs = new Set([bom.metadata.component['bom-ref']]);
  for (const c of bom.components) {
    assert.ok(!refs.has(c['bom-ref']), `bom-ref ${c['bom-ref']} is unique`);
    refs.add(c['bom-ref']);
    assert.ok(['required', 'optional', 'excluded'].includes(c.scope), `${c.name} has a scope`);
    // Everything that ships as bytes carries a hash; only SUDS's own trees (a manifest hash in a property), the
    // unlocked test-only tools, the SHA-pinned actions, the tag-pinned base image and the SQLite compiled into the
    // wasm (whose file is hashed) do not.
    const hashless = c.type === 'application' || c.type === 'container' || prop(c, 'suds:role') === 'test' || !!prop(c, 'suds:embedded-in');
    if (!hashless) assert.ok((c.hashes || []).length, `${c.name} carries a hash`);
    if (c.type === 'application' && c.scope === 'required') assert.match(prop(c, 'suds:tree-sha256') || '', /^[0-9a-f]{64}$/, `${c.name} has a tree hash`);
  }
  for (const d of bom.dependencies) {
    assert.ok(refs.has(d.ref), `dependency ${d.ref} names a component`);
    for (const x of d.dependsOn) assert.ok(refs.has(x), `${d.ref} depends on ${x}, a component`);
  }
  const shipped = bom.components.filter(c => c.scope === 'required');
  const named = (n) => shipped.find(c => c.name === n);
  assert.ok(named('node'), 'the Node.js runtime is listed');
  assert.ok(named('sql.js') && named('sqlite'), 'sql.js and the SQLite in its wasm are listed as shipped');
  assert.ok(named('public/local/kernel.js') && named('public/local/sql-wasm.wasm') && named('public/qr.js'), 'the vendored and generated browser files are listed');
  for (const tool of ['esbuild', 'playwright', 'axe-core']) {
    const c = bom.components.find(x => x.name === tool);
    assert.ok(c && c.scope === 'excluded', `${tool} is listed as tooling that never ships`);
  }
  assert.ok(!shipped.some(c => c.name === 'esbuild' || c.name.startsWith('@esbuild/')), 'no build tool is marked as shipped');
}

test('the committed SBOM is what scripts/sbom.js produces from the commit it records', (t) => {
  const { file, text, bom } = newest();
  checkShape(bom);
  const commit = prop(bom.metadata, 'suds:source-commit');
  assert.match(commit || '', /^[0-9a-f]{40}$/, 'the SBOM records the commit it describes');
  try { execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT, stdio: 'ignore' }); } catch {
    // CI's shallow checkout has the pushed commit and the release tags only: this runs there once the version is tagged.
    t.skip(`commit ${commit.slice(0, 12)} is not in this clone`);
    return;
  }
  const again = S.serialize(S.generate({ ref: commit }));
  assert.equal(text, again, `${path.basename(file)} differs from a fresh run; regenerate it with: node scripts/sbom.js --ref ${commit} --out docs/evidence/${path.basename(file)}`);
  assert.equal(bom.metadata.component.version, JSON.parse(execFileSync('git', ['show', `${commit}:package.json`], { cwd: ROOT })).version, 'the SBOM is for the version that commit carries');
});

test('the script runs on the current tree and lists what it ships', () => {
  const bom = S.generate();
  checkShape(bom);
  const version = require('../package.json').version;
  assert.equal(bom.metadata.component.version, version);
  // The shipped npm packages are exactly those whose code is inside the committed kernel.
  const kernel = fs.readFileSync(path.join(ROOT, 'public', 'local', 'kernel.js'));
  const bundled = S.bundledPackages(kernel);
  const shippedLibs = bom.components.filter(c => c.scope === 'required' && c.type === 'library' && c.purl.startsWith('pkg:npm/')).map(c => c.name).sort();
  assert.deepEqual(shippedLibs, bundled);
  // Files are hashed as they are on disk.
  const wasm = bom.components.find(c => c.name === 'public/local/sql-wasm.wasm');
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public', 'local', 'sql-wasm.wasm'))).digest('hex');
  assert.equal(wasm.hashes.find(h => h.alg === 'SHA-256').content, sha);
  // Same tree, same bytes: nothing in the output depends on the time or the machine.
  assert.equal(S.serialize(S.generate()), S.serialize(bom));
});

test('the SBOM script refuses a server that requires an npm package, and reads esbuild\'s module comments', () => {
  const fake = (files) => ({ sha: null, list: (dir) => Object.keys(files).filter(p => p.startsWith(dir + '/')).sort(), read: (p) => Buffer.from(files[p]) });
  assert.deepEqual(S.serverBuiltins(fake({ 'server/a.js': "require('node:fs'); require('./b'); require('path');", 'server/b.js': "require('node:sqlite')" })), ['node:fs', 'node:path', 'node:sqlite']);
  assert.throws(() => S.serverBuiltins(fake({ 'server/a.js': "require('express')" })), /not Node built-ins[\s\S]*server\/a\.js: express/);
  assert.deepEqual(S.bundledPackages(Buffer.from('// local/kernel.js\n// node_modules/@noble/hashes/esm/sha2.js\n// node_modules/fflate/esm/browser.js\n// node_modules/@noble/hashes/esm/utils.js\n')), ['@noble/hashes', 'fflate']);
  assert.deepEqual(S.sqliteIn(Buffer.from('\u0001\u00013.45.2\u0000x\u00002024-03-12 11:06:23 ' + 'a'.repeat(64) + '\u0000', 'latin1')), { version: '3.45.2', sourceId: '2024-03-12 11:06:23 ' + 'a'.repeat(64) });
});

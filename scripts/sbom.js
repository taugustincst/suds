'use strict';
// Software bill of materials (CycloneDX 1.5, JSON) for what SUDS ships, for county IT and procurement review
// (docs/evidence/README.md). No npm package is needed to run it: it reads the repository (a git ref, or the
// working tree's tracked files) with Node built-ins and git.
//
//   node scripts/sbom.js                                   # the working tree, to stdout
//   node scripts/sbom.js --ref <commit|tag> --out docs/evidence/sbom-<version>.cdx.json
//
// What it lists, and how each entry is found (nothing is typed in by hand, so the file cannot drift from the code):
//   * the runtime: Node.js, the exact release CI and the release workflow pin (.github/workflows/ci.yml,
//     NODE22_VERSION / NODE22_SHA256), the `engines` range from package.json, the built-in modules server/ requires
//     (the script fails if server/ requires anything that is not a `node:` built-in or a relative path: the
//     "zero runtime dependencies" rule in CLAUDE.md, checked), and the Docker base image named in the Dockerfile;
//   * SUDS's own code as three trees (server/, public/, scripts/), each with a file count and a SHA-256 over its
//     manifest (sorted `sha256  path` lines of the tracked files, the same method `sha256sum` prints);
//   * the vendored and generated browser files, one by one, with SHA-256 and SHA-512: the browser kernel
//     public/local/kernel.js (esbuild output of local/ and server/, committed) and its .gz/.br copies,
//     public/local/sql-wasm.wasm (sql.js's WebAssembly build) and its copies, public/qr.js (a QR encoder written
//     for SUDS, no third-party code), server/schema-text.js (generated from server/schema.sql);
//   * the npm packages whose code is inside the kernel, read from esbuild's `// node_modules/<package>/` module
//     comments in kernel.js, with version, licence and hash from package-lock.json (the registry tarball's
//     SHA-512), and the SQLite release compiled into sql-wasm.wasm (its source id, read from the wasm bytes);
//   * separately, scope "excluded": the build tooling in package-lock.json that never ships (esbuild and its
//     platform binaries), the test-only tools CI installs with --no-save (Playwright, axe-core; version from
//     ci.yml, not locked), and the GitHub Actions the workflows use (pinned by commit).
// The output is deterministic for a given tree: the timestamp is the date of the version's CHANGELOG section,
// and the serial number is derived from the content. test/sbom.test.js regenerates the committed file from its
// recorded commit and fails on any difference.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { isBuiltin } = require('node:module');

// Files shipped under public/ or server/ that are generated or carry third-party code: listed one by one.
const FILES = [
  { path: 'public/local/kernel.js', origin: 'generated', note: 'The browser kernel: local/ and server/ bundled by esbuild (scripts/build-local.js, scripts/kernel-build-options.js), with the npm packages listed as bundled in it. Committed; CI fails if it differs from a fresh build.' },
  { path: 'public/local/kernel.js.gz', origin: 'generated', compressedOf: 'public/local/kernel.js', note: 'gzip (level 9) copy of kernel.js, served with Content-Encoding.' },
  { path: 'public/local/kernel.js.br', origin: 'generated', compressedOf: 'public/local/kernel.js', note: 'Brotli (quality 11) copy of kernel.js, served with Content-Encoding.' },
  { path: 'public/local/sql-wasm.wasm', origin: 'vendored', note: 'Copied unchanged from the sql.js package (dist/sql-wasm.wasm) by scripts/build-local.js; SQLite compiled to WebAssembly.' },
  { path: 'public/local/sql-wasm.wasm.gz', origin: 'generated', compressedOf: 'public/local/sql-wasm.wasm', note: 'gzip (level 9) copy of sql-wasm.wasm.' },
  { path: 'public/local/sql-wasm.wasm.br', origin: 'generated', compressedOf: 'public/local/sql-wasm.wasm', note: 'Brotli (quality 11) copy of sql-wasm.wasm.' },
  { path: 'public/qr.js', origin: 'first-party', note: 'QR code encoder written for SUDS (two-step verification enrolment), no third-party code: the secret never goes to a QR service.' },
  { path: 'server/schema-text.js', origin: 'generated', note: 'server/schema.sql as a JavaScript string for the browser kernel (scripts/gen-schema-text.js); CI fails if it drifts.' },
];
const TREES = [
  { name: 'suds-server', dir: 'server', note: 'The office server: Node.js built-ins only. Also bundled into the browser kernel.' },
  { name: 'suds-web-app', dir: 'public', note: 'The web app (vanilla ES modules, no build step), served by the office server and published as SUDS on this device. The files listed individually are included in this tree too.' },
  { name: 'suds-scripts', dir: 'scripts', note: 'Operator and maintainer scripts (backup, key rotation, recovery drill, evidence verification, release checks, build) and the browser test suite (scripts/ui/). The Dockerfile copies this directory.' },
];

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') o.ref = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else throw new Error(`Unknown argument ${argv[i]} (usage: node scripts/sbom.js [--ref <commit|tag>] [--out <file>])`);
  }
  return o;
}

const git = (a, opts = {}) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 1 << 28, ...opts });

/** A reader over one tree: a git commit, or the working tree's tracked files. */
function reader(ref) {
  if (ref) {
    const sha = git(['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
    return {
      sha,
      list: (dir) => git(['ls-tree', '-r', '--name-only', sha, '--', dir], { encoding: 'utf8' }).split('\n').filter(Boolean).sort(),
      read: (p) => git(['cat-file', 'blob', `${sha}:${p}`]),
    };
  }
  let tracked = null;
  try { tracked = git(['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean); } catch { tracked = null; }
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(p)); else if (e.isFile()) out.push(p);
    }
    return out;
  };
  return {
    sha: null,
    list: (dir) => (tracked ? tracked.filter(p => p.startsWith(dir + '/')) : walk(dir)).filter(p => fs.existsSync(path.join(ROOT, p))).sort(),
    read: (p) => fs.readFileSync(path.join(ROOT, p)),
  };
}

const digest = (alg, buf) => crypto.createHash(alg).update(buf).digest('hex');
const hashes = (buf) => [{ alg: 'SHA-256', content: digest('sha256', buf) }, { alg: 'SHA-512', content: digest('sha512', buf) }];
const prop = (name, value) => ({ name, value: String(value) });

/** `sha256  path` lines of every file under `dir`, sorted by path, and the SHA-256 of that text. */
function treeManifest(r, dir) {
  const files = r.list(dir);
  const text = files.map(p => `${digest('sha256', r.read(p))}  ${p}\n`).join('');
  return { count: files.length, sha256: digest('sha256', Buffer.from(text)) };
}

/** Every module server/ requires that is not relative; throws on anything but a Node built-in. */
function serverBuiltins(r) {
  const seen = new Set(); const bad = [];
  for (const p of r.list('server').filter(f => f.endsWith('.js'))) {
    const src = r.read(p).toString('utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const id = m[1];
      if (id.startsWith('.') || id.startsWith('/')) continue;
      const bare = id.replace(/^node:/, '');
      if (isBuiltin(id) || isBuiltin(`node:${bare}`)) seen.add(`node:${bare}`); else bad.push(`${p}: ${id}`);
    }
  }
  if (bad.length) throw new Error(`server/ requires modules that are not Node built-ins (CLAUDE.md: zero runtime dependencies):\n  ${bad.join('\n  ')}`);
  return [...seen].sort();
}

/** The npm packages esbuild bundled into kernel.js, from its `// node_modules/<pkg>/...` module comments. */
function bundledPackages(kernel) {
  const names = new Set();
  for (const m of kernel.toString('utf8').matchAll(/^\/\/ node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm)) names.add(m[1]);
  return [...names].sort();
}

/** The SQLite release compiled into a wasm build: its version and source id (the `sqlite_source_id()` text). */
function sqliteIn(wasm) {
  const s = wasm.toString('latin1');
  const id = s.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [0-9a-f]{64})/);
  // The version string (sqlite_version()) is NUL-terminated; exactly one such 3.x.y string is expected.
  const versions = [...new Set([...s.matchAll(/[^\d.](3\.\d{2}\.\d{1,2})\x00/g)].map(m => m[1]))];
  return id && versions.length === 1 ? { version: versions[0], sourceId: id[1] } : null;
}

const integrityHex = (sri) => {
  const [alg, b64] = String(sri || '').split('-');
  return alg === 'sha512' && b64 ? { alg: 'SHA-512', content: Buffer.from(b64, 'base64').toString('hex') } : null;
};
const npmPurl = (name, version) => `pkg:npm/${name.startsWith('@') ? '%40' + name.slice(1) : name}@${version}`;
const licenses = (id) => (id ? [{ license: { id } }] : undefined);

function generate({ ref } = {}) {
  const r = reader(ref);
  const pkg = JSON.parse(r.read('package.json'));
  const lock = JSON.parse(r.read('package-lock.json'));
  const ci = r.read('.github/workflows/ci.yml').toString('utf8');
  const dockerfile = r.read('Dockerfile').toString('utf8');
  const changelog = r.read('CHANGELOG.md').toString('utf8');
  const version = pkg.version;
  const dated = changelog.match(new RegExp(`^## ${version.replace(/\./g, '\\.')} — (\\d{4}-\\d\\d-\\d\\d)`, 'm'));
  const timestamp = `${dated ? dated[1] : '1970-01-01'}T00:00:00Z`;

  const components = []; const deps = new Map();
  const depend = (from, to) => { if (!deps.has(from)) deps.set(from, new Set()); deps.get(from).add(to); };
  const APP = `pkg:github/taugustincst/suds@v${version}`;

  // --- Runtime: Node.js ---
  const nodeVersion = (ci.match(/NODE22_VERSION:\s*v?([\d.]+)/) || [])[1];
  const nodeSha = (ci.match(/NODE22_SHA256:\s*([0-9a-f]{64})/) || [])[1];
  if (!nodeVersion || !nodeSha) throw new Error('.github/workflows/ci.yml does not pin NODE22_VERSION and NODE22_SHA256');
  const nodeRef = `pkg:generic/node@${nodeVersion}`;
  components.push({
    type: 'platform', 'bom-ref': nodeRef, name: 'node', version: nodeVersion, scope: 'required',
    description: 'Node.js runtime. The office server needs nothing else: no npm package is installed to run it. The operator supplies and patches Node; this is the release CI and the release workflow test on.',
    hashes: [{ alg: 'SHA-256', content: nodeSha }], licenses: licenses('MIT'), purl: nodeRef,
    externalReferences: [{ type: 'distribution', url: `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz`, comment: 'The hash is of this file, pinned in .github/workflows/ci.yml' }],
    properties: [
      prop('suds:engines', pkg.engines && pkg.engines.node),
      prop('suds:hash-of', `node-v${nodeVersion}-linux-x64.tar.xz`),
      prop('suds:builtins-used-by-server', serverBuiltins(r).join(', ')),
      prop('suds:embedded-sqlite', 'node:sqlite embeds SQLite; its version is the Node release\'s own (node -p process.versions.sqlite)'),
    ],
  });
  depend(APP, nodeRef);
  const base = (dockerfile.match(/^FROM\s+(\S+)/m) || [])[1];
  if (base) {
    const [img, tag = 'latest'] = base.split(':');
    const baseRef = `pkg:docker/${img}@${tag}`;
    components.push({
      type: 'container', 'bom-ref': baseRef, name: img, version: tag, scope: 'optional', purl: baseRef,
      description: 'Base image of the Dockerfile (the container deployment only). Pinned to a minor line by tag, not by digest: a rebuild takes that line\'s newest patch release.',
      properties: [prop('suds:pinned-by', 'tag'), prop('suds:source', 'Dockerfile')],
    });
    depend(APP, baseRef);
  }

  // --- SUDS's own code, as trees ---
  for (const t of TREES) {
    const m = treeManifest(r, t.dir);
    const ref2 = `suds:${t.dir}/`;
    components.push({
      type: 'application', 'bom-ref': ref2, name: t.name, version, scope: 'required', description: t.note, licenses: licenses(pkg.license),
      properties: [prop('suds:path', `${t.dir}/`), prop('suds:files', m.count), prop('suds:tree-sha256', m.sha256),
        prop('suds:tree-method', `SHA-256 of the sorted lines "<sha256>  <path>\\n" for every tracked file under ${t.dir}/ (the last line of: git ls-files -z ${t.dir} | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum)`)],
    });
    depend(APP, ref2);
  }

  // --- Vendored and generated files ---
  const kernel = r.read('public/local/kernel.js');
  const wasm = r.read('public/local/sql-wasm.wasm');
  for (const f of FILES) {
    const buf = r.read(f.path);
    const fref = `file:${f.path}`;
    components.push({
      type: 'file', 'bom-ref': fref, name: f.path, version, scope: 'required', description: f.note, hashes: hashes(buf),
      properties: [prop('suds:origin', f.origin), prop('suds:bytes', buf.length), ...(f.compressedOf ? [prop('suds:compressed-copy-of', f.compressedOf)] : [])],
    });
    depend(`suds:${f.path.split('/')[0]}/`, fref);
  }

  // --- npm packages whose code ships inside the kernel ---
  const lockPkgs = lock.packages || {};
  const bundled = bundledPackages(kernel);
  if (!bundled.length) throw new Error('public/local/kernel.js names no bundled npm package: has esbuild stopped writing module comments?');
  const shipped = new Set();
  for (const name of bundled) {
    const e = lockPkgs[`node_modules/${name}`];
    if (!e) throw new Error(`kernel.js bundles ${name}, which package-lock.json does not list`);
    const pref = npmPurl(name, e.version);
    const h = integrityHex(e.integrity);
    components.push({
      type: 'library', 'bom-ref': pref, name, version: e.version, scope: 'required', purl: pref, licenses: licenses(e.license),
      ...(h ? { hashes: [h] } : {}),
      description: name === 'sql.js' ? 'SQLite for the browser: its JavaScript is bundled in kernel.js and its WebAssembly is public/local/sql-wasm.wasm.' : 'Bundled into the browser kernel (public/local/kernel.js). A devDependency in package.json because it is used only to build the kernel; its code ships inside it.',
      properties: [prop('suds:bundled-in', 'public/local/kernel.js'), ...(h ? [prop('suds:hash-of', 'the npm registry tarball (package-lock.json integrity)')] : []),
        prop('suds:declared-in', pkg.devDependencies && pkg.devDependencies[name] ? 'package.json devDependencies' : 'package-lock.json (dependency of a bundled package)')],
    });
    shipped.add(name);
    depend('file:public/local/kernel.js', pref);
    if (name === 'sql.js') depend('file:public/local/sql-wasm.wasm', pref);
  }
  const sq = sqliteIn(wasm);
  if (sq) {
    const sref = `pkg:generic/sqlite@${sq.version}`;
    components.push({
      type: 'library', 'bom-ref': sref, name: 'sqlite', version: sq.version, scope: 'required', purl: sref, licenses: [{ license: { name: 'blessing (public domain)' } }],
      description: 'SQLite compiled into public/local/sql-wasm.wasm by the sql.js project (the browser kernel\'s database).',
      properties: [prop('suds:source-id', sq.sourceId), prop('suds:embedded-in', 'public/local/sql-wasm.wasm'), prop('suds:found-by', 'the version and source id strings in the wasm bytes')],
    });
    depend('file:public/local/sql-wasm.wasm', sref);
  }

  // --- Development, build and test tooling: never shipped ---
  for (const [k, e] of Object.entries(lockPkgs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!k.startsWith('node_modules/')) continue;
    const name = k.slice('node_modules/'.length);
    if (shipped.has(name)) continue;
    const pref = npmPurl(name, e.version); const h = integrityHex(e.integrity);
    components.push({
      type: 'library', 'bom-ref': pref, name, version: e.version, scope: 'excluded', purl: pref, licenses: licenses(e.license), ...(h ? { hashes: [h] } : {}),
      description: name === 'esbuild' || name.startsWith('@esbuild/') ? 'Build tool: bundles the browser kernel on a maintainer\'s machine or in CI. Never shipped or run by an installation.' : 'Build-time dependency in package-lock.json; not bundled into any shipped file.',
      properties: [prop('suds:role', 'build'), ...(e.optional ? [prop('suds:optional', 'platform-specific binary; npm installs only the one for the machine')] : [])],
    });
  }
  const testOnly = new Map();
  for (const m of ci.matchAll(/npm i --no-save[^\n]*/g)) for (const t of m[0].matchAll(/\s((?:@[\w.-]+\/)?[\w.-]+)@(\d[\w.-]*)/g)) testOnly.set(t[1], t[2]);
  for (const [name, v] of [...testOnly].sort()) {
    const pref = npmPurl(name, v);
    components.push({
      type: 'library', 'bom-ref': pref, name, version: v, scope: 'excluded', purl: pref,
      description: 'Test-only: installed by CI with --no-save for the browser suite (scripts/ui/run-all.sh), never in package.json or package-lock.json, never shipped.',
      properties: [prop('suds:role', 'test'), prop('suds:locked', 'false: the version is pinned in .github/workflows/ci.yml, the hash is not')],
    });
  }
  const actions = new Map();
  for (const wf of r.list('.github/workflows').filter(p => /\.ya?ml$/.test(p))) {
    for (const m of r.read(wf).toString('utf8').matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})(?:\s*#\s*(\S+))?/g)) actions.set(`${m[1]}@${m[2]}`, { name: m[1], sha: m[2], tag: m[3], wf });
  }
  for (const a of [...actions.values()].sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const pref = `pkg:github/${a.name}@${a.sha}`;
    components.push({
      type: 'application', 'bom-ref': pref, name: a.name, version: a.sha, scope: 'excluded', purl: pref,
      description: 'GitHub Action used by a release workflow (pinned to a full commit SHA). Runs on GitHub\'s runners; never shipped.',
      properties: [prop('suds:role', 'ci'), prop('suds:workflow', a.wf), ...(a.tag ? [prop('suds:tag-comment', a.tag)] : [])],
    });
  }

  const bom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: {
      timestamp,
      tools: { components: [{ type: 'application', name: 'scripts/sbom.js', description: 'SUDS SBOM generator (Node built-ins and git only)' }] },
      component: {
        type: 'application', 'bom-ref': APP, name: 'suds', version, purl: APP, licenses: licenses(pkg.license), description: pkg.description,
        externalReferences: [{ type: 'vcs', url: 'https://github.com/taugustincst/suds' }],
      },
      properties: [
        prop('suds:source', r.sha ? `git commit ${r.sha}` : 'working tree (tracked files)'),
        ...(r.sha ? [prop('suds:source-commit', r.sha)] : []),
        prop('suds:timestamp-is', `the date of the ${version} section of CHANGELOG.md (the version stamp's date; a release's date is its tag's)`),
        prop('suds:scopes', 'required = shipped and used at run time; optional = one deployment shape only; excluded = development, build, test or CI tooling that never ships'),
      ],
    },
    components,
    dependencies: [...deps].map(([ref2, set]) => ({ ref: ref2, dependsOn: [...set].sort() })).sort((a, b) => (a.ref < b.ref ? -1 : 1)),
  };
  // A serial number that is the same for the same content (RFC 4122 layout, name-based).
  const h = crypto.createHash('sha256').update(JSON.stringify(bom)).digest('hex');
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { bomFormat: bom.bomFormat, specVersion: bom.specVersion, serialNumber: `urn:uuid:${uuid}`, version: bom.version, metadata: bom.metadata, components: bom.components, dependencies: bom.dependencies };
}

const serialize = (bom) => JSON.stringify(bom, null, 2) + '\n';

if (require.main === module) {
  try {
    const o = args(process.argv.slice(2));
    const text = serialize(generate(o));
    if (o.out) { fs.writeFileSync(path.resolve(o.out), text); console.error(`[suds] SBOM written to ${o.out}`); } else process.stdout.write(text);
  } catch (e) { console.error(e.message || e); process.exit(1); }
}

module.exports = { generate, serialize, bundledPackages, sqliteIn, serverBuiltins, reader };

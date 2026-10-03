'use strict';
// scripts/build-windows.js (docs/RELEASE.md, "The Windows server zip"): every input is pinned by hash in ci.yml and a
// mismatch stops the build; app\ holds the server, the web app and the scripts the Windows command line runs, and
// everything they load; the zip is deterministic. The full build (node.exe, postject, WinSW) runs on windows-latest in
// ci.yml's windows-exe job; here it runs as far as it can without those downloads.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const W = require('../scripts/build-windows');
const Z = require('../scripts/windows/zip');

const ROOT = path.join(__dirname, '..');
const ciText = () => fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

test('the pins: read from ci.yml\'s windows-exe job, each in its exact form', () => {
  const p = W.readPins();
  assert.match(p.nodeVersion, /^v22\.\d+\.\d+$/); assert.match(p.nodeWinSha256, /^[0-9a-f]{64}$/);
  assert.equal(p.winswVersion, 'v2.12.0'); assert.match(p.winswSha256, /^[0-9a-f]{64}$/);
  assert.equal(p.postjectVersion, '1.0.0-alpha.6'); assert.match(p.postjectIntegrity, /^sha512-/);
  assert.equal(p.urls.node, `https://nodejs.org/dist/${p.nodeVersion}/node-${p.nodeVersion}-win-x64.zip`);
  assert.equal(p.urls.winsw, 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe');
  assert.equal(p.urls.postject, 'https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz');
  // A pin that is not a full hash is refused, not used.
  const ci = ciText();
  assert.throws(() => W.readPins(ci.replace(/WINSW_SHA256: [0-9a-f]{64}/, 'WINSW_SHA256: latest')), /does not pin WINSW_SHA256/);
  assert.throws(() => W.readPins(ci.replace(/POSTJECT_INTEGRITY: \S+/, 'POSTJECT_INTEGRITY: sha1-abc')), /does not pin POSTJECT_INTEGRITY/);
  assert.throws(() => W.readPins(ci.replace('  windows-exe:', '  windows-exe-renamed:')), /no windows-exe job/);
});

test('the checksum pinning: a file that is not the pinned one stops the build (SHA-256 and npm\'s SHA-512 integrity)', async () => {
  const buf = Buffer.from('the real WinSW');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(W.verifyPinned(buf, sha, 'WinSW-x64.exe'), sha);
  assert.equal(W.verifyPinned(buf, sha.toUpperCase(), 'WinSW-x64.exe'), sha, 'hex in either case');
  assert.throws(() => W.verifyPinned(Buffer.from('a swapped WinSW'), sha, 'WinSW-x64.exe'), (e) => e instanceof W.BuildError && /WinSW-x64\.exe does not match the checksum pinned in \.github\/workflows\/ci\.yml/.test(e.message));
  const sri = `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
  assert.equal(W.verifyPinned(buf, sri, 'postject.tgz'), sri);
  assert.throws(() => W.verifyPinned(Buffer.from('x'), sri, 'postject.tgz'), /postject\.tgz does not match the checksum pinned/);
  // The build itself: wrong inputs are refused before anything is made from them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-winbuild-'));
  try {
    for (const f of ['node.zip', 'winsw.exe', 'postject.tgz']) fs.writeFileSync(path.join(dir, f), `not the pinned ${f}`);
    await assert.rejects(W.build({ nodeZip: path.join(dir, 'node.zip'), winsw: path.join(dir, 'winsw.exe'), postject: path.join(dir, 'postject.tgz'), out: path.join(dir, 'out'), zip: true }), /node\.zip does not match the checksum pinned/);
    assert.ok(!fs.existsSync(path.join(dir, 'out')), 'nothing was written');
    await assert.rejects(W.build({ out: dir }), /Give --node-zip, --winsw and --postject/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('postject is read from its tarball (no npm install, no npx): a plain ustar .tgz is unpacked in memory', () => {
  const header = (name, size) => {
    const h = Buffer.alloc(512); h.write(name, 0); h.write(size.toString(8).padStart(11, '0'), 124); h.write('0', 156);
    return h;
  };
  const body = Buffer.from('module.exports = 1;\n');
  const tar = Buffer.concat([header('package/dist/api.js', body.length), body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
  const files = W.untgz(zlib.gzipSync(tar));
  assert.deepEqual([...files.keys()], ['package/dist/api.js']); assert.equal(files.get('package/dist/api.js').toString(), body.toString());
});

test('app\\: server/, public/, the runtime scripts, package.json, LICENSE and NOTICE; no tests, docs or browser tooling', () => {
  const files = W.appFiles();
  const has = (f) => files.includes(f);
  for (const f of ['server/index.js', 'server/schema.sql', 'public/index.html', 'public/local/kernel.js', 'package.json', 'LICENSE', 'NOTICE', ...W.RUNTIME_SCRIPTS]) assert.ok(has(f), f);
  for (const f of files) assert.match(f, /^(server|public|scripts)\/|^(package\.json|LICENSE|NOTICE)$/, f);
  assert.ok(!files.some((f) => /^(test|docs|deploy|local|mobile|launchers)\//.test(f) || f.startsWith('scripts/ui/') || f.startsWith('scripts/bench/')));
  assert.ok(!has('scripts/windows/smoke-test.ps1') && !has('scripts/build-windows.js'), 'the build and its CI test are not shipped');
  // Every local module the shipped scripts and server load is shipped too.
  const set = new Set(files);
  const missing = [];
  for (const f of files.filter((x) => x.endsWith('.js') && !x.startsWith('public/'))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
      let t = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!t.endsWith('.js') && !t.endsWith('.json')) t = set.has(`${t}.js`) ? `${t}.js` : `${t}/index.js`;
      if (!set.has(t)) missing.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  // The scripts the command line names by path (runScript, passthrough, try-local's, and the ones it requires by path).
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'cli.js'), 'utf8');
  const named = new Set([...cli.matchAll(/(?:runScript(?:Child)?|passthrough)\('([\w-]+\.js)'/g)].map((m) => `scripts/${m[1]}`));
  for (const m of cli.matchAll(/path\.join\(ROOT, 'scripts', '([\w-]+\.js)'\)/g)) named.add(`scripts/${m[1]}`);
  for (const m of fs.readFileSync(path.join(ROOT, 'scripts', 'try-local.js'), 'utf8').matchAll(/path\.join\(ROOT, 'scripts', '([\w-]+\.js)'\)/g)) named.add(`scripts/${m[1]}`);
  assert.ok(named.size >= 8, [...named].join(' '));
  for (const f of named) assert.ok(set.has(f), `${f} (named by the command line) is shipped`);
});

test('the zip of a staged folder: deterministic, every required file checked, and its .sha256 beside it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-winpack-'));
  try {
    const stage = path.join(dir, 'stage');
    const put = (f, d) => { fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true }); fs.writeFileSync(path.join(stage, f), d); };
    for (const f of ['suds.exe', 'suds-service.exe', 'suds-service.xml', 'README-WINDOWS.txt', 'THIRD-PARTY-NOTICES.txt', 'app/scripts/windows/cli.js', 'app/server/index.js']) put(f, `content of ${f}`);
    put('app/package.json', JSON.stringify({ version: '7.8.9' }));
    const a = W.pack(stage, path.join(dir, 'a'), { mtime: '2026-10-03T00:00:00Z' });
    const b = W.pack(stage, path.join(dir, 'b'), { mtime: '2026-10-03T00:00:00Z' });
    assert.equal(path.basename(a.zip), 'suds-7.8.9-windows-x64.zip');
    assert.equal(a.sha256, b.sha256, 'the same staged files give the same zip');
    assert.equal(fs.readFileSync(`${a.zip}.sha256`, 'utf8'), `${a.sha256}  suds-7.8.9-windows-x64.zip\n`);
    const names = Z.readZip(fs.readFileSync(a.zip)).map((e) => e.name);
    assert.deepEqual(names, [...names].sort(), 'in name order');
    assert.ok(names.includes('suds.exe') && names.includes('app/server/index.js') && !names.some((n) => n.startsWith('stage')), 'no top-level folder: unzip into C:\\Program Files\\SUDS');
    fs.rmSync(path.join(stage, 'suds-service.exe'));
    assert.throws(() => W.pack(stage, path.join(dir, 'c')), /The staged folder has no suds-service\.exe/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('README-WINDOWS.txt and THIRD-PARTY-NOTICES.txt: the five steps, the folders, and both licences', () => {
  const pins = W.readPins();
  const r = W.readmeText('1.24.0', pins);
  for (const s of ['C:\\Program Files\\SUDS', 'suds service install', 'suds service start', 'setup wizard', 'C:\\ProgramData\\SUDS', 'keys.json', 'BitLocker', 'firewall', 'suds try', 'suds logs --errors']) assert.ok(r.includes(s), s);
  assert.ok(!/\r?\n/.test(r.replace(/\r\n/g, '')), 'Windows line endings, for Notepad');
  assert.match(r, /app\\LICENSE/); assert.match(r, /90 days with fictional data/); assert.doesNotMatch(r, /SUDS[^\r\n]*MIT/);
  const n = W.noticesText(pins, 'Node.js is licensed for use as follows:\n\nCopyright Node.js contributors.\n');
  assert.match(n, /Node\.js v22\.\d+\.\d+/); assert.ok(n.includes(pins.nodeWinSha256)); assert.ok(n.includes(pins.winswSha256));
  assert.match(n, /SUDS itself is proprietary \(Copyright \(c\) 2026 AugustInnovations\): app\\LICENSE/); assert.match(n, /app\\NOTICE/);
  assert.match(n, /Copyright Node\.js contributors/); assert.match(n, /MIT License\r\n\r\nCopyright \(c\) 2008-2020 Kohsuke Kawaguchi/);
});

test('the runtime stays free of npm packages: the Windows command line and bootstrap load Node built-ins and their own files only', () => {
  const { isBuiltin } = require('node:module');
  for (const f of W.RUNTIME_SCRIPTS.filter((x) => x.startsWith('scripts/windows/'))) {
    for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
      assert.ok(m[1].startsWith('.') || isBuiltin(m[1]), `${f} requires ${m[1]}`);
    }
  }
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.ok(!Object.keys(pkg.devDependencies || {}).includes('postject'), 'postject is not a dependency of any kind');
});

'use strict';
// Builds the SUDS Windows server zip, suds-<version>-windows-x64.zip (docs/WINDOWS-SERVER.md; docs/RELEASE.md,
// "The Windows server zip"). Run by CI only (.github/workflows/ci.yml `windows-exe`, release.yml `windows-exe`), on
// the pinned Node 22 that every other job uses. Owner decision of 2026-10-03 (docs/PLATFORM.md): the office server
// is also shipped as a Windows executable, so county IT install and manage it with one program. The runtime stays
// free of npm dependencies: suds.exe is the official node.exe with a bootstrap injected, and app\ is this tree.
//
//   node scripts/build-windows.js --node-zip <node-vX-win-x64.zip> --winsw <WinSW-x64.exe> --postject <postject-X.tgz> [--out dist]
//        [--stage <folder>] [--no-zip] [--signtool <signtool.exe>]
//   node scripts/build-windows.js --pack <staged folder> [--out dist]     zip a staged folder (after signing it)
//   node scripts/build-windows.js --pins                                  print the pinned inputs as JSON
//
// Every input is checked against a SHA-256 (or, for the npm tarball, the SHA-512 integrity) pinned in ci.yml's
// windows-exe job, read from there so there is one place to bump them; a mismatch stops the build. The steps follow
// Node's single executable application docs: the signature of node.exe is removed (signtool remove /s on Windows;
// scripts/windows/pe.js elsewhere, for a local cross-build), the SEA blob is made from scripts/windows/sea-main.js
// by this very Node (the blob must come from the same Node version as node.exe), and postject injects it. postject
// is used as a build-time library only: its pinned tarball is checked against its pinned integrity and its API
// file (Node built-ins only) is loaded from it, so no other npm package is fetched or run. The zip is deterministic
// (scripts/windows/zip.js): one timestamp (the commit's), files in name order.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { writeZip } = require('./windows/zip');
const pe = require('./windows/pe');
const svc = require('./windows/service');

const ROOT = path.join(__dirname, '..');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
// The scripts the Windows server runs (scripts/windows/cli.js), and what they load. Test checks every local require
// of these resolves inside the zip (test/windows-build.test.js).
const RUNTIME_SCRIPTS = [
  'scripts/windows/cli.js', 'scripts/windows/service.js', 'scripts/windows/zip.js', 'scripts/windows/pe.js', 'scripts/windows/sea-main.js',
  'scripts/try-local.js', 'scripts/seed.js', 'scripts/backup.js', 'scripts/create-admin.js', 'scripts/reset-admin.js', 'scripts/dr-drill.js',
  'scripts/verify-audit-export.js', 'scripts/verify-dr-report.js', 'scripts/verify-compliance-report.js', 'scripts/verify-passkey-evidence.js',
  'scripts/rotate-key.js', 'scripts/rotate-index-key.js', 'scripts/compliance-check.js', 'scripts/compliance/app-checks.js',
  'scripts/compliance/host-checks.js', 'scripts/compliance/safe-fs.js',
];

class BuildError extends Error {}

function args(argv) {
  const o = { out: path.join(ROOT, 'dist'), zip: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => { if (i + 1 >= argv.length) throw new BuildError(`${a} needs a value`); return argv[++i]; };
    if (a === '--node-zip') o.nodeZip = path.resolve(v());
    else if (a === '--winsw') o.winsw = path.resolve(v());
    else if (a === '--postject') o.postject = path.resolve(v());
    else if (a === '--out') o.out = path.resolve(v());
    else if (a === '--stage') o.stage = path.resolve(v());
    else if (a === '--signtool') o.signtool = path.resolve(v());
    else if (a === '--pack') o.pack = path.resolve(v());
    else if (a === '--no-zip') o.zip = false;
    else if (a === '--pins') o.pins = true;
    else throw new BuildError(`Unknown option ${a}`);
  }
  return o;
}

/** The pinned inputs, from .github/workflows/ci.yml (the windows-exe job's env, and the top-level Node 22 version). */
function readPins(ciText = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')) {
  const Y = require('./workflow-yaml');
  const ci = Y.parse(ciText);
  const job = ci.jobs && ci.jobs['windows-exe'];
  if (!job || !job.env) throw new BuildError('.github/workflows/ci.yml has no windows-exe job with the pinned inputs');
  const pins = {
    nodeVersion: ci.env && ci.env.NODE22_VERSION, nodeWinSha256: job.env.NODE22_WIN_SHA256,
    winswVersion: job.env.WINSW_VERSION, winswSha256: job.env.WINSW_SHA256,
    postjectVersion: job.env.POSTJECT_VERSION, postjectIntegrity: job.env.POSTJECT_INTEGRITY,
  };
  const bad = [];
  if (!/^v22\.\d+\.\d+$/.test(pins.nodeVersion || '')) bad.push('NODE22_VERSION');
  if (!/^[0-9a-f]{64}$/.test(pins.nodeWinSha256 || '')) bad.push('NODE22_WIN_SHA256');
  if (!/^v\d+\.\d+\.\d+$/.test(pins.winswVersion || '')) bad.push('WINSW_VERSION');
  if (!/^[0-9a-f]{64}$/.test(pins.winswSha256 || '')) bad.push('WINSW_SHA256');
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pins.postjectVersion || '')) bad.push('POSTJECT_VERSION');
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(pins.postjectIntegrity || '')) bad.push('POSTJECT_INTEGRITY');
  if (bad.length) throw new BuildError(`ci.yml windows-exe does not pin ${bad.join(', ')} in the expected form`);
  pins.urls = {
    node: `https://nodejs.org/dist/${pins.nodeVersion}/node-${pins.nodeVersion}-win-x64.zip`,
    winsw: `https://github.com/winsw/winsw/releases/download/${pins.winswVersion}/WinSW-x64.exe`,
    postject: `https://registry.npmjs.org/postject/-/postject-${pins.postjectVersion}.tgz`,
  };
  return pins;
}

/** Throws unless `buf` has the pinned digest: 'sha256:<hex>' or an npm integrity 'sha512-<base64>'. */
function verifyPinned(buf, pinned, what) {
  let have; let want = pinned;
  if (/^sha512-/.test(pinned)) have = `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
  else { have = crypto.createHash('sha256').update(buf).digest('hex'); want = String(pinned).toLowerCase(); }
  if (have !== want) throw new BuildError(`${what} does not match the checksum pinned in .github/workflows/ci.yml (expected ${want}, got ${have}). Do not build with it: download it again from its official source, or, for a deliberate bump, change the pin (docs/RELEASE.md).`);
  return have;
}

/** The files of a .tgz (npm tarball): Map name → Buffer. Plain ustar entries; pax headers are skipped. */
function untgz(buf) {
  const tar = zlib.gunzipSync(buf); const out = new Map(); let p = 0; let longName = null;
  while (p + 512 <= tar.length) {
    const h = tar.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.toString('utf8', a, b).replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    let name = str(0, 100); const prefix = str(345, 500); if (prefix) name = `${prefix}/${name}`;
    const body = tar.subarray(p + 512, p + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '\0') { out.set(longName || name, Buffer.from(body)); longName = null; }
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

/** The app folder's files: server/, public/, the runtime scripts, package.json, LICENSE, NOTICE (tracked files only in a checkout). */
function appFiles({ list = null } = {}) {
  let tracked = list;
  if (!tracked) {
    try { tracked = git(['ls-files', '-z']).split('\0').filter(Boolean); } catch { tracked = null; }
  }
  if (!tracked) throw new BuildError('scripts/build-windows.js builds from a git checkout (git ls-files lists what goes into app\\)');
  const set = new Set(tracked);
  const files = tracked.filter((f) => /^(server|public)\//.test(f));
  for (const f of [...RUNTIME_SCRIPTS, 'package.json', 'LICENSE', 'NOTICE']) {
    if (!set.has(f)) throw new BuildError(`${f} is not a tracked file: commit it, or take it out of RUNTIME_SCRIPTS`);
    files.push(f);
  }
  return [...new Set(files)].filter((f) => fs.existsSync(path.join(ROOT, f))).sort();
}

function findSigntool() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  let vers = []; try { vers = fs.readdirSync(base).filter((d) => /^10\./.test(d)).sort().reverse(); } catch {}
  for (const v of vers) { const f = path.join(base, v, 'x64', 'signtool.exe'); if (fs.existsSync(f)) return f; }
  return null;
}

/** node.exe without its signature, at `exe`: signtool remove /s on Windows (Node's SEA docs), else scripts/windows/pe.js. */
function stripSignature(exe, { signtool } = {}) {
  const tool = signtool || (process.platform === 'win32' ? findSigntool() : null);
  if (tool) {
    const r = spawnSync(tool, ['remove', '/s', exe], { encoding: 'utf8' });
    if (r.status !== 0) throw new BuildError(`signtool remove /s failed: ${(r.stdout || '') + (r.stderr || '')}`);
  } else {
    fs.writeFileSync(exe, pe.stripSignature(fs.readFileSync(exe)));
  }
  if (pe.isSigned(fs.readFileSync(exe))) throw new BuildError('node.exe still carries a signature after removing it');
  return tool ? 'signtool remove /s' : 'scripts/windows/pe.js';
}

function readmeText(version, pins) {
  return [
    `SUDS ${version} for Windows: the SUDS office server`,
    '='.repeat(60),
    '',
    'What is in this folder',
    '  suds.exe                 SUDS: the server and its command line (Node.js ' + pins.nodeVersion + ' inside).',
    '  app\\                     SUDS itself (server, web app, scripts). An update replaces this folder.',
    '                           Proprietary: app\\LICENSE (evaluation terms) and app\\NOTICE (third-party licences).',
    '  suds-service.exe         The Windows service wrapper (WinSW ' + pins.winswVersion + ', MIT licence).',
    '  suds-service.xml         Its settings. "suds service install" writes it again.',
    '  THIRD-PARTY-NOTICES.txt  The licences of Node.js and WinSW.',
    '',
    'Install it as a Windows service (production, under a signed licence agreement)',
    '  1. Unzip this folder to C:\\Program Files\\SUDS (or C:\\SUDS).',
    '  2. Open Terminal as administrator: right-click Start, choose "Terminal (Admin)".',
    '  3. cd "C:\\Program Files\\SUDS"',
    '     .\\suds service install',
    '  4. .\\suds service start',
    '  5. Open the address it prints (http://localhost:8080) in a browser ON THIS COMPUTER and finish the setup wizard.',
    '     It asks whether other computers may connect, and sets up HTTPS.',
    '',
    '  The data (database, keys, logs, backups) is in C:\\ProgramData\\SUDS. Back up keys.json from there separately:',
    '  without it the database cannot be read. Turn BitLocker on for the drive that holds it.',
    '  Other computers need an inbound firewall rule for the port: see the guide.',
    '',
    'Try it first, with made-up data (not for real records)',
    '  Double-click suds.exe? That starts the real server. To try SUDS with sample data instead, in a terminal here:',
    '  .\\suds try',
    '  Evaluation is allowed for up to 90 days with fictional data only; anything else needs a signed agreement',
    '  (app\\LICENSE, sections 2 and 3).',
    '',
    'Everyday commands',
    '  suds status               Is it running and healthy? Last backup, disk space, port, folders.',
    '  suds logs --errors        What went wrong.',
    '  suds service restart      Restart it.',
    '  suds backup               An encrypted backup now.',
    '  suds help                 Every command.',
    '',
    'The full guide for county IT: docs/WINDOWS-SERVER.md in the SUDS repository',
    '(https://github.com/taugustincst/suds/blob/main/docs/WINDOWS-SERVER.md).',
    '',
  ].join('\r\n');
}

const WINSW_LICENSE = `MIT License

Copyright (c) 2008-2020 Kohsuke Kawaguchi, Sun Microsystems, Inc., CloudBees, Inc., Oleg Nenashev and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function noticesText(pins, nodeLicense) {
  const rule = '-'.repeat(78);
  return [
    'THIRD-PARTY NOTICES for the SUDS Windows server', '',
    'SUDS itself is proprietary (Copyright (c) 2026 AugustInnovations LLC): app\\LICENSE.',
    'The third-party components built into its web app are listed in app\\NOTICE.', '',
    rule, `Node.js ${pins.nodeVersion} (suds.exe is node.exe from https://nodejs.org/dist/${pins.nodeVersion}/,`,
    `node-${pins.nodeVersion}-win-x64.zip, SHA-256 ${pins.nodeWinSha256}, with the SUDS bootstrap injected).`,
    'Its licence, which includes the licences of the libraries built into Node.js:', rule, '', nodeLicense.replace(/\r?\n/g, '\r\n'), '',
    rule, `WinSW ${pins.winswVersion} (suds-service.exe is WinSW-x64.exe from https://github.com/winsw/winsw/releases/tag/${pins.winswVersion},`,
    `SHA-256 ${pins.winswSha256}, unchanged).`, rule, '', WINSW_LICENSE.replace(/\r?\n/g, '\r\n'), '',
  ].join('\r\n');
}

function commitDate() {
  if (process.env.SOURCE_DATE_EPOCH) return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
  try { return git(['log', '-1', '--format=%cI']); } catch { return '2026-01-01T00:00:00Z'; }
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** Zip a staged folder: suds-<version>-windows-x64.zip and its .sha256, in `out`. */
function pack(stage, out, { mtime = commitDate() } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(stage, 'app', 'package.json'), 'utf8')).version;
  for (const f of ['suds.exe', 'suds-service.exe', 'suds-service.xml', 'README-WINDOWS.txt', 'THIRD-PARTY-NOTICES.txt', 'app/package.json', 'app/scripts/windows/cli.js']) {
    if (!fs.existsSync(path.join(stage, f))) throw new BuildError(`The staged folder has no ${f}`);
  }
  const names = walk(stage).sort();
  const zip = writeZip(names.map((n) => ({ name: n, data: fs.readFileSync(path.join(stage, n)), mode: /\.exe$/.test(n) ? 0o100755 : 0o100644 })), { mtime });
  fs.mkdirSync(out, { recursive: true });
  const name = `suds-${version}-windows-x64.zip`;
  fs.writeFileSync(path.join(out, name), zip);
  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  fs.writeFileSync(path.join(out, `${name}.sha256`), `${sha}  ${name}\n`);
  return { zip: path.join(out, name), sha256: sha, bytes: zip.length, files: names.length, version };
}

async function build(o) {
  const pins = readPins();
  if (!o.nodeZip || !o.winsw || !o.postject) throw new BuildError('Give --node-zip, --winsw and --postject (the pinned downloads; their URLs: node scripts/build-windows.js --pins)');
  // The inputs first: a file that is not the pinned one stops the build before anything is made from it.
  const nodeZip = fs.readFileSync(o.nodeZip); verifyPinned(nodeZip, pins.nodeWinSha256, path.basename(o.nodeZip));
  const winsw = fs.readFileSync(o.winsw); verifyPinned(winsw, pins.winswSha256, path.basename(o.winsw));
  const pj = fs.readFileSync(o.postject); verifyPinned(pj, pins.postjectIntegrity, path.basename(o.postject));
  if (process.version !== pins.nodeVersion) throw new BuildError(`Build with Node ${pins.nodeVersion}, the version suds.exe is made from (this is ${process.version}): the SEA blob must come from the same Node release as node.exe.`);
  const version = require('../package.json').version;
  const stage = o.stage || fs.mkdtempSync(path.join(os.tmpdir(), 'suds-win-'));
  fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-win-build-'));
  try {
    // 1. node.exe and its licence, from the pinned zip.
    const entries = require('./windows/zip').readZip(nodeZip);
    const top = `node-${pins.nodeVersion}-win-x64/`;
    const exeEntry = entries.find((e) => e.name === `${top}node.exe`); const lic = entries.find((e) => e.name === `${top}LICENSE`);
    if (!exeEntry || !lic) throw new BuildError(`${path.basename(o.nodeZip)} has no ${top}node.exe and LICENSE`);
    const exe = path.join(stage, 'suds.exe');
    fs.writeFileSync(exe, exeEntry.data());
    // 2. Its signature removed: it would not match once the blob is in.
    const how = stripSignature(exe, { signtool: o.signtool });
    console.log(`[build-windows] node.exe ${pins.nodeVersion}: signature removed (${how})`);
    // 3. The SEA blob, made by this Node (the same release), from the bootstrap alone.
    const cfg = path.join(tmp, 'sea-config.json'); const blob = path.join(tmp, 'sea-prep.blob');
    fs.writeFileSync(cfg, JSON.stringify({ main: path.join(ROOT, 'scripts', 'windows', 'sea-main.js'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2));
    const r = spawnSync(process.execPath, ['--experimental-sea-config', cfg], { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(blob)) throw new BuildError(`node --experimental-sea-config failed: ${r.stdout}${r.stderr}`);
    // 4. postject, from its pinned tarball: the API file only (Node built-ins), loaded from a private folder.
    const files = untgz(pj);
    const api = files.get('package/dist/api.js');
    if (!api) throw new BuildError(`postject-${pins.postjectVersion}.tgz has no package/dist/api.js`);
    const apiFile = path.join(tmp, 'postject-api.js'); fs.writeFileSync(apiFile, api);
    await require(apiFile).inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: SEA_FUSE });
    const injected = fs.readFileSync(exe);
    if (!injected.includes(Buffer.from(`${SEA_FUSE}:1`))) throw new BuildError('postject did not set the SEA fuse in suds.exe');
    console.log(`[build-windows] suds.exe: SEA bootstrap injected (postject ${pins.postjectVersion})`);
    // 5. app\, the service wrapper and its default settings, the two text files.
    for (const f of appFiles()) { const to = path.join(stage, 'app', ...f.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), to); }
    fs.writeFileSync(path.join(stage, svc.WRAPPER_EXE), winsw);
    fs.writeFileSync(path.join(stage, svc.WRAPPER_XML), svc.serviceXml({ dataDir: '%ProgramData%\\SUDS', version }));
    fs.writeFileSync(path.join(stage, 'README-WINDOWS.txt'), readmeText(version, pins));
    fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), noticesText(pins, lic.data().toString('utf8')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`[build-windows] staged in ${stage}`);
  if (!o.zip) return { stage };
  const res = pack(stage, o.out);
  if (!o.stage) fs.rmSync(stage, { recursive: true, force: true });
  console.log(`[build-windows] wrote ${res.zip} (${(res.bytes / 1048576).toFixed(1)} MB, ${res.files} files), SHA-256 ${res.sha256}`);
  return res;
}

async function main(argv) {
  const o = args(argv);
  if (o.pins) { console.log(JSON.stringify(readPins(), null, 2)); return; }
  if (o.pack) { const r = pack(o.pack, o.out); console.log(`[build-windows] wrote ${r.zip} (${r.files} files), SHA-256 ${r.sha256}`); return; }
  await build(o);
}

module.exports = { build, readPins, verifyPinned, untgz, appFiles, pack, readmeText, noticesText, RUNTIME_SCRIPTS, SEA_FUSE, BuildError, stripSignature };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e instanceof BuildError ? `[build-windows] ${e.message}` : (e && e.stack) || e); process.exit(1); });

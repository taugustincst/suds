'use strict';
// scripts/county-packet.js: the county evidence packet is the same bytes every time it is made from a commit, holds
// every file its README lists, and its manifest and zip say what is in it (docs/market/COUNTY-KIT.md, *The evidence
// packet*).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const CP = require('../scripts/county-packet');

const ROOT = path.join(__dirname, '..');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'suds-packet-'));
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])).sort();

test('two runs at the same commit make identical bytes: every file and the zip', () => {
  const a = CP.buildPacket(ROOT, HEAD);
  const b = CP.buildPacket(ROOT, HEAD);
  const [da, db] = [tmp(), tmp()];
  try {
    CP.writeDir(da, a, { force: true });
    CP.writeDir(db, b, { force: true });
    const fa = walk(da); const fb = walk(db);
    assert.deepEqual(fa, fb);
    for (const f of fa) assert.ok(fs.readFileSync(path.join(da, f)).equals(fs.readFileSync(path.join(db, f))), `${f} differs between two runs`);
    assert.ok(CP.zipBytes(a, CP.packetName(a)).equals(CP.zipBytes(b, CP.packetName(b))), 'the zip differs between two runs');
    // The CLI makes the same folder as the module.
    const dc = path.join(tmp(), 'p');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'county-packet.js'), '--ref', HEAD, '--out', dc], { cwd: ROOT, stdio: 'ignore' });
    assert.deepEqual(walk(dc), fa);
    for (const f of fa) assert.ok(fs.readFileSync(path.join(dc, f)).equals(fs.readFileSync(path.join(da, f))), `${f}: CLI and module differ`);
    fs.rmSync(path.dirname(dc), { recursive: true, force: true });
  } finally {
    fs.rmSync(da, { recursive: true, force: true });
    fs.rmSync(db, { recursive: true, force: true });
  }
});

test('every listed file exists, in the packet and in the repository, and the manifest covers them', () => {
  const p = CP.buildPacket(ROOT, HEAD);
  const paths = p.files.map((f) => f.path);
  const tree = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', '--full-tree', HEAD], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean));
  for (const f of CP.PACKET_FILES) assert.ok(paths.includes(f.path), `${f.path} is in the packet`);
  for (const k of CP.PACKET_NEWEST) assert.ok(p.entries.some((e) => e.kind === k.kind && e.paths.length), `the newest ${k.kind} evidence is in the packet`);
  for (const f of paths) if (f !== 'README.md' && f !== 'MANIFEST.sha256') assert.ok(tree.has(f), `${f} is the repository's own file`);
  const readme = p.files.find((f) => f.path === 'README.md').data.toString('utf8');
  for (const e of p.entries) assert.ok(readme.includes(`\`${e.root && e.paths.length > 1 ? `${e.root}/` : e.paths[0]}\``), `the README lists ${e.paths[0]}`);
  for (const m of readme.matchAll(/^\| `([^`]+)`/gm)) {
    const listed = m[1];
    assert.ok(paths.includes(listed) || paths.some((x) => x.startsWith(listed)), `the README's ${listed} is in the packet`);
  }
  assert.match(readme, /sha256sum -c MANIFEST\.sha256/);
  assert.match(readme, /node scripts\/sbom\.js --ref [0-9a-f]{40} --out/);
  assert.match(readme, /npm run verify-audit-export -- /);
  assert.match(readme, /npm run verify-dr-report -- /);
  // The manifest: one line per file but itself, each hash right.
  const manifest = p.files.find((f) => f.path === 'MANIFEST.sha256').data.toString('utf8').trim().split('\n');
  assert.deepEqual(manifest.map((l) => l.slice(66)), paths.filter((x) => x !== 'MANIFEST.sha256'));
  for (const l of manifest) assert.equal(l.slice(0, 64), CP.sha256(p.files.find((f) => f.path === l.slice(66)).data), l);
  // The newest SBOM is the newest in the tree, and no private key is shipped.
  const sboms = [...tree].filter((f) => /^docs\/evidence\/sbom-\d+\.\d+\.\d+\.cdx\.json$/.test(f)).sort((x, y) => { const a = x.match(/\d+/g).map(Number), b = y.match(/\d+/g).map(Number); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
  assert.ok(paths.includes(sboms[sboms.length - 1]));
  for (const f of p.files) assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(f.data.toString('latin1')), `${f.path} holds no private key`);
});

test('the zip: stored entries under one folder, readable by its own central directory', () => {
  assert.equal(CP.crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 check value');
  const p = CP.buildPacket(ROOT, HEAD);
  const zip = CP.zipBytes(p, CP.packetName(p));
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), p.files.length);
  let at = zip.readUInt32LE(end + 16);
  for (const f of p.files) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const n = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + n).toString('utf8');
    assert.equal(name, `${CP.packetName(p)}/${f.path}`);
    const local = zip.readUInt32LE(at + 42);
    const ln = zip.readUInt16LE(local + 26);
    assert.ok(zip.subarray(local + 30 + ln, local + 30 + ln + f.data.length).equals(f.data), `${f.path}'s bytes`);
    assert.equal(zip.readUInt32LE(at + 16), CP.crc32(f.data));
    at += 46 + n;
  }
});

test('the newest evidence: the latest date, then the latest release re-run on that date (a -vX.Y.Z folder beside the plain one)', () => {
  // The 1.20.0 re-runs are "<kind>-2026-09-30-v1.20.0" beside the 1.19.0 "<kind>-2026-09-30"; the packet shipped the
  // 1.19.0 ones because the match wanted the date at the end of the folder's name.
  const dr = CP.PACKET_NEWEST.find((n) => n.kind === 'dr');
  const inst = CP.PACKET_NEWEST.find((n) => n.kind === 'installer');
  const plain = dr.match('docs/evidence/dr-drill-2026-09-30/a.json'); const rerun = dr.match('docs/evidence/dr-drill-2026-09-30-v1.20.0/a.json');
  assert.equal(rerun.root, 'docs/evidence/dr-drill-2026-09-30-v1.20.0');
  assert.ok(rerun.key > plain.key, 'a re-run on the same day is newer than the plain folder');
  assert.ok(dr.match('docs/evidence/dr-drill-2026-10-01/a.json').key > rerun.key, 'a later day is newer still');
  assert.ok(dr.match('docs/evidence/dr-drill-2026-09-30-v1.20.10/a.json').key > dr.match('docs/evidence/dr-drill-2026-09-30-v1.20.9/a.json').key, 'releases compare as numbers');
  assert.equal(inst.match('docs/evidence/installer-container-run-2026-09-30-v1.20.0/x/y.txt').root, 'docs/evidence/installer-container-run-2026-09-30-v1.20.0');
  assert.equal(dr.match('docs/evidence/dr-drill-2026-09-30.md'), null, 'the summary page beside a folder is not the folder');
  // In the repository: each kind's folder is the newest there is.
  const p = CP.buildPacket(ROOT, HEAD);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', '--full-tree', HEAD], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const n of CP.PACKET_NEWEST.filter((x) => x.kind !== 'sbom')) {
    const keys = tree.map((f) => n.match(f)).filter(Boolean).map((m) => m.key).sort();
    const e = p.entries.find((x) => x.kind === n.kind);
    assert.equal(n.match(`${e.root}/x`).key, keys[keys.length - 1], `${n.kind}: ${e.root}`);
  }
});

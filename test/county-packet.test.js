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

test('the packet holds what a county security and privacy review asks for next (1.22.0)', () => {
  const p = CP.buildPacket(ROOT, HEAD);
  const paths = p.files.map((f) => f.path);
  for (const f of ['docs/security/THREAT-MODEL.md', 'docs/security/DATA-INVENTORY.md', 'docs/security/LOGGING-AND-AUDIT.md',
    'docs/COUNTY-VIEW.md', 'docs/security/BACKUP-AND-DR.md', 'docs/security/INCIDENT-RESPONSE.md']) {
    assert.ok(CP.PACKET_FILES.some((x) => x.path === f), `${f} is listed`);
    assert.ok(paths.includes(f), `${f} is in the packet`);
  }
  const tm = p.entries.find((e) => e.paths[0] === 'docs/security/THREAT-MODEL.md');
  assert.match(tm.describes || '', /^SUDS \d+\.\d+\.\d+ \(its \*Version\.\* line\)$/, 'the threat model\'s own version line is read');
  const dr = p.entries.find((e) => e.paths[0] === 'docs/security/BACKUP-AND-DR.md');
  assert.match(dr.describes || '', /latest recorded recovery drill: \d{4}-\d{2}-\d{2}, on SUDS \d+\.\d+\.\d+/, 'BACKUP-AND-DR.md\'s latest recorded drill is read');
});

test('the README flags every file whose stated release is older than the packet\'s minor', () => {
  assert.equal(CP.statedVersion('1.16.2, 1.18.0 and 1.19.0 → 1.20.0'), '1.20.0', 'the newest version named');
  assert.equal(CP.statedVersion('SUDS 1.21.0, built from commit `d1efeb7057da791227134a1187e858bf627b40b1`'), '1.21.0');
  assert.equal(CP.statedVersion(null), null);
  assert.ok(CP.olderThan('1.11.0', '1.21.0') && CP.olderThan('1.20.9', '1.21.0') && CP.olderThan('0.99.0', '1.0.0'));
  assert.ok(!CP.olderThan('1.21.0', '1.21.3') && !CP.olderThan('1.21.4', '1.21.0') && !CP.olderThan(null, '1.21.0'), 'the same minor line, or no version, is not flagged');
  // Synthetic entries: an accessibility report on 1.11.0 and a drill on 1.20.0 in a 1.21.x packet; the threat model
  // on 1.21.0 and a file with no version line are not flagged.
  const entries = [
    { kind: 'file', what: 'ACR', paths: ['docs/accessibility/ACR-WCAG21.md'], describes: 'SUDS 1.11.0 (its *Name of Product/Version*)' },
    { kind: 'file', what: 'TM', paths: ['docs/security/THREAT-MODEL.md'], describes: 'SUDS 1.21.0 (its *Version.* line)' },
    { kind: 'file', what: 'Licence', paths: ['LICENSE'], describes: null },
    { kind: 'dr', what: 'Drill', paths: ['docs/evidence/dr-drill-x/a', 'docs/evidence/dr-drill-x/b'], root: 'docs/evidence/dr-drill-x', describes: 'SUDS 1.20.0' },
  ];
  const text = CP.readmeText({ commit: 'a'.repeat(40), date: '2026-10-01T00:00:00Z', version: '1.21.2' }, entries, []);
  assert.match(text, /\*\*Older than this release\.\*\* 2 files state an earlier release than this packet's 1\.21\.2\./);
  assert.match(text, /^\* `docs\/accessibility\/ACR-WCAG21\.md`: SUDS 1\.11\.0 /m);
  assert.match(text, /^\* `docs\/evidence\/dr-drill-x\/` \(2 files\): SUDS 1\.20\.0\.$/m);
  const row = (p) => text.split('\n').find((l) => l.startsWith(`| \`${p}`));
  assert.match(row('docs/accessibility/ACR-WCAG21.md'), /\*\*Older than this release\*\* \(1\.11\.0; this packet is 1\.21\.2\)/);
  assert.match(row('docs/evidence/dr-drill-x/'), /\*\*Older than this release\*\* \(1\.20\.0;/);
  for (const p of ['docs/security/THREAT-MODEL.md', 'LICENSE']) assert.doesNotMatch(row(p), /Older than this release/, `${p} is not flagged`);
  // Nothing older: no flag at all.
  assert.doesNotMatch(CP.readmeText({ commit: 'a'.repeat(40), date: '2026-10-01T00:00:00Z', version: '1.21.0' }, entries.slice(1, 3), []), /Older than this release/);
  // The repository's own packet: every flagged file really states an older minor, and every such file is flagged.
  const p = CP.buildPacket(ROOT, HEAD);
  const readme = p.files.find((f) => f.path === 'README.md').data.toString('utf8');
  for (const e of p.entries) {
    const stated = e.stated || CP.statedVersion(e.describes);
    const line = readme.split('\n').find((l) => l.startsWith(`| \`${e.root && e.paths.length > 1 ? `${e.root}/` : e.paths[0]}\``));
    assert.equal(/Older than this release/.test(line), CP.olderThan(stated, p.version), `${e.paths[0]}: states ${stated}, packet ${p.version}`);
  }
  // The accessibility report: revised for a release, its conformance levels established on an earlier one. The README
  // compares the latter, and says both.
  const acr = CP.PACKET_FILES.find((f) => f.path === 'docs/accessibility/ACR-WCAG21.md');
  const revised = '## Name of Product/Version\n\nSUDS — x, SUDS 1.21.0 (this revision).\n\n**The conformance levels in the tables were established on SUDS 1.11.0** (y).\n';
  assert.equal(acr.stated(revised), '1.11.0');
  assert.match(acr.describes(revised), /^SUDS 1\.21\.0 \(its \*Name of Product\/Version\*\); its conformance levels were established on SUDS 1\.11\.0/);
  assert.equal(acr.stated('## Name of Product/Version\n\nSUDS 1.21.0, all of it evaluated.\n'), '1.21.0', 'a report evaluated on the release it names');
  const acrEntry = p.entries.find((e) => e.paths[0] === acr.path);
  assert.ok(acrEntry.stated, 'the repository\'s report states a version');
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

'use strict';
// The county evidence packet (1.21.0): the documents a county's IT, privacy and purchasing staff ask for, in one
// folder (and optionally one zip), with a README saying what each file is and which version it describes, and a
// SHA-256 manifest. docs/market/COUNTY-KIT.md, *The evidence packet*, says when to send it.
//
//   node scripts/county-packet.js [--ref <commit|tag>] [--out <dir>] [--zip <file>] [--force]
//
// The files are read from git at --ref (default HEAD), never from the working tree, so an uncommitted edit cannot
// slip in and the same commit always gives the same bytes: the README's dates are the commit's, the manifest is
// sorted, and the zip stores its entries uncompressed with the commit's time (deflate output can change with Node's
// zlib; stored bytes cannot). test/county-packet.test.js builds it twice and compares every byte.
//
// What goes in: PACKET_FILES (fixed paths) and PACKET_NEWEST (the newest SBOM and the newest recovery, upgrade and
// installer drill evidence, by the version or date in their names). A path that does not exist at --ref fails the
// run: a packet missing a document it lists is worse than none.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PACKET_FILES = [
  { path: 'docs/security/QUESTIONNAIRE.md', what: 'Security questionnaire: each answer with the file or test that shows it', describes: (t) => { const m = /^\*\*Checked against:\*\*\s*(\d+\.\d+\.\d+)/m.exec(t); return m ? `checked against ${m[1]} (its *Checked against* line)` : null; } },
  { path: 'docs/market/COUNTY-KIT.md', what: 'County pilot kit: what the county gets and runs, data flows, timeline, measures, roles, the documents list, owner-pending items' },
  { path: 'docs/market/templates/COUNTY-RFI-ANSWERS.md', what: 'Answers to a county IT and privacy RFI (template; organisational answers marked [owner to complete])' },
  { path: 'docs/market/templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md', what: 'Data contribution agreement, CBO and county (DRAFT for counsel; not reviewed)' },
  { path: 'docs/market/templates/DPA-DRAFT.md', what: 'Data processing addendum (DRAFT for counsel; not reviewed)' },
  { path: 'docs/market/templates/BAA-QSOA-DRAFT.md', what: 'Business associate agreement and 42 CFR Part 2 QSOA (DRAFT for counsel; not reviewed)' },
  { path: 'docs/security/PEN-TEST-SCOPE.md', what: 'Penetration test scope for a county-commissioned test (no test has been done)' },
  { path: 'docs/accessibility/ACR-WCAG21.md', what: 'Accessibility conformance report, WCAG 2.1 (a self-assessment, not a third-party review)', describes: (t) => { const m = /Name of Product\/Version[\s\S]*?SUDS (\d+\.\d+\.\d+)/.exec(t); return m ? `SUDS ${m[1]} (its *Name of Product/Version*; later releases are covered by the accessibility checks in CI, not by a new report)` : null; } },
  { path: 'SECURITY.md', what: 'Security policy: supported versions and how to report a vulnerability' },
  { path: 'LICENSE', what: 'The licence (MIT)' },
];
// A dated evidence folder, and the release it was re-run on when there was more than one that day (the 1.20.0 re-runs
// are "<kind>-2026-09-30-v1.20.0" beside the 1.19.0 "<kind>-2026-09-30"). Newest: the latest date, then the latest
// release on that date (a folder without a release suffix is the older one).
const DATED = /-(\d{4}-\d{2}-\d{2})(?:-v(\d+)\.(\d+)\.(\d+))?$/;
const pad = (n) => String(Number(n || 0)).padStart(6, '0');
const datedKey = (root) => { const m = root.match(DATED); return `${m[1]}|${pad(m[2])}.${pad(m[3])}.${pad(m[4])}`; };
const evidenceDir = (prefix) => new RegExp(`^(docs/evidence/${prefix}-\\d{4}-\\d{2}-\\d{2}(?:-v\\d+\\.\\d+\\.\\d+)?)/`);
const DR_DIR = evidenceDir('dr-drill'); const UPGRADE_DIR = evidenceDir('upgrade-drill'); const INSTALLER_DIR = evidenceDir('installer-[a-z0-9-]+?-run');
const PACKET_NEWEST = [
  { kind: 'sbom', what: 'Software bill of materials (CycloneDX 1.5), the newest one', match: (p) => { const m = /^docs\/evidence\/sbom-(\d+\.\d+\.\d+)\.cdx\.json$/.exec(p); return m ? { key: m[1], root: p } : null; } },
  { kind: 'dr', what: 'Recovery drill evidence (backup, restore, signed report), the newest', match: (p) => { const m = DR_DIR.exec(p); return m ? { key: datedKey(m[1]), root: m[1] } : null; } },
  { kind: 'upgrade', what: 'Upgrade drill evidence (older releases\' databases opened by a newer one), the newest', match: (p) => { const m = UPGRADE_DIR.exec(p); return m ? { key: datedKey(m[1]), root: m[1] } : null; } },
  { kind: 'installer', what: 'Installer run evidence (SUDS Server\'s installer and upgrader run for real), the newest', match: (p) => { const m = INSTALLER_DIR.exec(p); return m ? { key: datedKey(m[1]), root: m[1] } : null; } },
];

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: root, encoding, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const cmpV = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The tree at `ref`: Map path -> blob sha (files only). */
function listTree(root, ref) {
  const out = new Map();
  for (const rec of git(root, ['ls-tree', '-r', '-z', '--full-tree', ref]).split('\0')) {
    const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(rec);
    if (m) out.set(m[3], m[2]);
  }
  return out;
}

/** What the packet holds, from git at `ref`: { commit, date, version, entries, files: [{ path, data }] }. Pure of the working tree. */
function buildPacket(root, ref = 'HEAD') {
  const commit = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const date = git(root, ['show', '-s', '--format=%cI', commit]).trim();
  const tree = listTree(root, commit);
  const blob = (p) => { if (!tree.has(p)) throw new Error(`${p} is not in the tree at ${commit.slice(0, 12)}`); return git(root, ['cat-file', 'blob', tree.get(p)], 'buffer'); };
  const version = JSON.parse(blob('package.json').toString('utf8')).version;
  const entries = []; // one row of the README each: { what, paths, describes, kind }
  for (const f of PACKET_FILES) {
    const text = blob(f.path).toString('utf8');
    entries.push({ kind: 'file', what: f.what, paths: [f.path], describes: (f.describes && f.describes(text)) || null });
  }
  for (const n of PACKET_NEWEST) {
    const found = new Map();
    for (const p of tree.keys()) { const m = n.match(p); if (m) found.set(m.root, m.key); }
    if (!found.size) throw new Error(`no ${n.kind} evidence in the tree at ${commit.slice(0, 12)}`);
    const [rootPath] = [...found].sort((a, b) => (n.kind === 'sbom' ? cmpV(a[1], b[1]) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[0] < b[0] ? -1 : 1)).pop();
    const paths = n.kind === 'sbom' ? [rootPath] : [...tree.keys()].filter((p) => p.startsWith(`${rootPath}/`)).sort();
    let describes = null;
    if (n.kind === 'sbom') {
      const bom = JSON.parse(blob(rootPath).toString('utf8'));
      const src = ((bom.metadata.component || {}).properties || []).concat(bom.metadata.properties || []).find((p) => p.name === 'suds:source-commit');
      describes = `SUDS ${bom.metadata.component.version}${src ? `, built from commit \`${src.value}\`` : ''}`;
    } else {
      const readme = paths.find((p) => p === `${rootPath}/README.md`);
      const h1 = readme ? (/^# .*?\(([^)]*\d+\.\d+\.\d+[^)]*)\)\s*$/m.exec(blob(readme).toString('utf8')) || [])[1] : null;
      describes = h1 || null;
    }
    entries.push({ kind: n.kind, what: n.what, paths, root: rootPath, describes });
  }
  const files = [];
  for (const e of entries) for (const p of e.paths) files.push({ path: p, data: blob(p) });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const meta = { commit, date, version };
  const readme = Buffer.from(readmeText(meta, entries, files), 'utf8');
  const all = [...files, { path: 'README.md', data: readme }].sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = Buffer.from(all.map((f) => `${sha256(f.data)}  ${f.path}\n`).join(''), 'utf8');
  return { ...meta, entries, files: [...all, { path: 'MANIFEST.sha256', data: manifest }].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

function readmeText({ commit, date, version }, entries, files) {
  const short = commit.slice(0, 12);
  const L = [];
  L.push(`# SUDS county evidence packet: ${version}, commit ${short}`, '');
  L.push(`Made with \`node scripts/county-packet.js --ref ${commit}\` from the SUDS repository at commit \`${commit}\``);
  L.push(`(${date}; \`package.json\` says ${version}). The same command at the same commit makes the same bytes. Every file`);
  L.push('below is the repository\'s own file at that commit, at the same path, so its links to other SUDS documents name');
  L.push('files in the repository (<https://github.com/taugustincst/suds>, at that commit).', '');
  L.push('Read it with its limits: the agreements are **drafts for counsel, not reviewed**; SUDS holds **no** certification,');
  L.push('attestation or independent audit, and **no penetration test** has been done; the drills are **development-environment');
  L.push('exercises**, not production drills; the accessibility report is a **self-assessment**. The owner-pending items are');
  L.push('listed in `docs/market/COUNTY-KIT.md`, *Owner-pending items*.', '');
  L.push('## What is in it', '');
  L.push('| File | What it is | What it describes |', '| --- | --- | --- |');
  for (const e of entries) {
    const where = e.root && e.paths.length > 1 ? `\`${e.root}/\` (${e.paths.length} files)` : `\`${e.paths[0]}\``;
    L.push(`| ${where} | ${e.what} | ${e.describes || `no version line of its own: the document as at \`${short}\` (${version})`} |`);
  }
  L.push('| `README.md` | This page | — |', '| `MANIFEST.sha256` | SHA-256 of every file above, this page included | — |', '');
  L.push('## Checking it', '');
  L.push('1. **Nothing changed since it was made.** From this folder: `sha256sum -c MANIFEST.sha256` (every line `OK`).');
  L.push('2. **It is SUDS\'s own, from that commit.** From a clone of the repository:');
  L.push('   `git fetch origin && node scripts/county-packet.js --ref ' + commit + ' --out /tmp/packet && diff -r /tmp/packet <this folder>`');
  L.push('   (no output: identical).');
  const sbom = entries.find((e) => e.kind === 'sbom');
  const src = sbom && /commit `([0-9a-f]{40})`/.exec(sbom.describes || '');
  if (sbom) L.push(`3. **The SBOM is what the code gives.** From a clone: \`node scripts/sbom.js --ref ${src ? src[1] : '<its commit>'} --out /tmp/sbom.json && cmp /tmp/sbom.json <this folder>/${sbom.paths[0]}\` (no output: identical).`);
  const signed = files.filter((f) => /\/dr-drill-[^/]+\.json$/.test(f.path)).map((f) => ({ file: f.path, key: `${path.posix.dirname(f.path)}/suds-signing-key.pem`, cmd: 'verify-dr-report' }))
    .concat(files.filter((f) => /\/compliance-[^/]+\.json$/.test(f.path)).map((f) => ({ file: f.path, key: `${path.posix.dirname(f.path)}/compliance-signing-key.pub.pem`, cmd: 'verify-compliance-report' })));
  L.push('4. **The signed drill and compliance reports verify** with the public key beside each, from a clone (`PACKET=<this folder>`):');
  L.push('', '```bash');
  const have = new Set(files.map((f) => f.path));
  for (const s of signed) L.push(`npm run ${s.cmd} -- "$PACKET/${s.file}"${have.has(s.key) ? ` --public-key "$PACKET/${s.key}"` : ''}`);
  L.push('```', '');
  L.push('   A key shipped beside its report proves the report was not edited since it was signed, not who signed it; for a');
  L.push('   county\'s own server, take the public key from the server itself (Settings → Security status).');
  L.push('5. **An audit export from a county\'s own server** (not in the packet: it is the county\'s data) verifies away from');
  L.push('   the server with `npm run verify-audit-export -- <export.ndjson> --public-key <signing-key.pem>` (`docs/security/LOGGING-AND-AUDIT.md`).', '');
  return `${L.join('\n')}\n`;
}

function writeDir(out, packet, { force = false } = {}) {
  if (fs.existsSync(out)) {
    if (!force) throw new Error(`${out} exists (use --force to replace it)`);
    fs.rmSync(out, { recursive: true, force: true });
  }
  for (const f of packet.files) {
    const p = path.join(out, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.data);
  }
}

// ---- a deterministic zip: entries stored (no compression), sorted, with the commit's time, no extra fields
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function dosTime(iso) {
  const d = new Date(iso);
  const y = Math.max(1980, d.getUTCFullYear());
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}
function zipBytes(packet, prefix) {
  const { time, date } = dosTime(packet.date);
  const locals = []; const central = []; let offset = 0;
  for (const f of packet.files) {
    const name = Buffer.from(`${prefix}/${f.path}`, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(packet.files.length, 8); end.writeUInt16LE(packet.files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const packetName = (packet) => `suds-county-packet-${packet.version}-${packet.commit.slice(0, 12)}`;

if (require.main === module) {
  const args = process.argv.slice(2);
  let ref = 'HEAD'; let out = null; let zip = null; let force = false; let root = path.join(__dirname, '..');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--ref') ref = args[++i];
    else if (a === '--out') out = args[++i];
    else if (a === '--zip') zip = args[++i];
    else if (a === '--force') force = true;
    else if (a === '--root') root = path.resolve(args[++i]);
    else { console.error(`usage: node scripts/county-packet.js [--ref <commit|tag>] [--out <dir>] [--zip <file>] [--force] (unknown: ${a})`); process.exit(2); }
  }
  try {
    const packet = buildPacket(root, ref);
    const dir = path.resolve(out || packetName(packet));
    writeDir(dir, packet, { force });
    console.log(`[county-packet] ${packet.files.length} files in ${dir} (SUDS ${packet.version}, commit ${packet.commit})`);
    console.log(`[county-packet] MANIFEST.sha256: ${sha256(packet.files.find((f) => f.path === 'MANIFEST.sha256').data)}`);
    if (zip) {
      const bytes = zipBytes(packet, packetName(packet));
      if (fs.existsSync(zip) && !force) throw new Error(`${zip} exists (use --force to replace it)`);
      fs.writeFileSync(zip, bytes);
      console.log(`[county-packet] ${zip}: ${bytes.length} bytes, SHA-256 ${sha256(bytes)}`);
    }
  } catch (e) {
    console.error(`[county-packet] ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { PACKET_FILES, PACKET_NEWEST, buildPacket, writeDir, zipBytes, crc32, packetName, sha256 };

'use strict';
// Verify an audit export (GET /api/admin/audit/export) away from the server. Needs only Node — no database,
// no configuration, no network.
//
//   npm run verify-audit-export -- <export.ndjson> [--public-key <signing-key.pem>] [--key <64 hex> | --key-file <file>] [--anchors <dir>] [--json]
//
// --public-key: the server's Ed25519 signing public key (GET /api/admin/security/signing-key), obtained
// separately from the export. With it, the manifest's signature proves the export was made by that server
// and not edited since — without any secret key. Without it the key embedded in the manifest is used, which
// proves only that the manifest is intact, and the output says so.
//
// Without a key it checks what anyone can: the file's digest against its manifest, that every entry follows
// the one before it, the older unkeyed entries' hashes, and that every anchor inside the range recorded the
// hash the entry still has. With the index key (SUDS_INDEX_KEY, held by the county's key custodian; also
// read from the SUDS_INDEX_KEY environment variable or a keys.json given to --key-file) it also checks every
// keyed entry, the manifest's MAC and each anchor's MAC. --anchors adds anchor files copied independently
// from the write-once anchor store, so the export is checked against evidence it did not bring with it.
// Exit status: 0 verified, 1 not verified, 2 usage error.
const fs = require('node:fs');
const path = require('node:path');
const { verifyExport } = require('../server/audit-export');

function parseArgs(argv) {
  const a = { file: null, key: null, anchors: null, json: false, publicKey: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--key') a.key = argv[++i];
    else if (v === '--key-file') { const f = argv[++i]; const t = fs.readFileSync(f, 'utf8').trim(); try { a.key = JSON.parse(t).SUDS_INDEX_KEY; } catch { a.key = t; } }
    else if (v === '--anchors') a.anchors = argv[++i];
    else if (v === '--public-key') { const t = fs.readFileSync(argv[++i], 'utf8'); a.publicKey = t.trim().startsWith('{') ? JSON.parse(t).public_key_pem : t; }
    else if (v === '--json') a.json = true;
    else if (!a.file) a.file = v;
  }
  if (!a.key && process.env.SUDS_INDEX_KEY) a.key = process.env.SUDS_INDEX_KEY;
  return a;
}

function main(argv) {
  const a = parseArgs(argv);
  if (!a.file) { console.error('Usage: npm run verify-audit-export -- <export.ndjson> [--public-key <signing-key.pem>] [--key <hex> | --key-file <keys.json>] [--anchors <dir>] [--json]'); return 2; }
  if (a.key && !/^[0-9a-fA-F]{64}$/.test(a.key)) { console.error('The index key must be 64 hex characters.'); return 2; }
  const extraAnchors = [];
  if (a.anchors) for (const f of fs.readdirSync(a.anchors).filter((x) => /^anchor-.*\.json$/.test(x)).sort()) {
    try { extraAnchors.push(JSON.parse(fs.readFileSync(path.join(a.anchors, f), 'utf8'))); } catch { console.error(`warning: ${f} is not readable JSON`); }
  }
  const r = verifyExport(fs.readFileSync(a.file, 'utf8'), { key: a.key ? Buffer.from(a.key, 'hex') : null, extraAnchors, publicKey: a.publicKey });
  if (a.json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  console.log(`SUDS audit export: ${a.file}`);
  if (r.header) console.log(`  generated ${r.header.generated_at} by SUDS ${r.header.server_version} (${r.header.org_name || 'unnamed programme'})`);
  console.log(`  entries ${r.entries} (ids ${r.manifest ? `${r.manifest.first_id}–${r.manifest.last_id}` : '?'})`);
  console.log(`  level: ${r.level}`);
  console.log(`  Ed25519 signature: ${r.signature ? `verified with the ${r.signature.key_source} public key (key id ${r.signature.key_id})` : 'not verified'}`);
  console.log(`  keyed entries checked ${r.keyed_checked}, unchecked ${r.keyed_unchecked}; unkeyed entries checked ${r.legacy_checked}`);
  console.log(`  anchors inside the range ${r.anchors_checked}, matched ${r.anchors_matched} (outside the range: ${r.anchors_outside_range})`);
  for (const w of r.warnings) console.log(`  note: ${w}`);
  for (const e of r.errors.slice(0, 50)) console.log(`  FAIL: ${e}`);
  if (r.errors.length > 50) console.log(`  … and ${r.errors.length - 50} more`);
  console.log(r.ok ? 'VERIFIED' : 'NOT VERIFIED');
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };

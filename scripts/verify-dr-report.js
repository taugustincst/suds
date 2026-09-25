'use strict';
// Verify a recovery-drill report (<data>/backups/dr-drill-*.json) away from the server, with the signing
// public key only — no database, no configuration, no secret key, no network.
//
//   npm run verify-dr-report -- <dr-drill-….json> [--public-key <signing-key.pem>] [--json]
//
// --public-key is the key published by the server (Settings → Security status → "Signing key", or
// GET /api/admin/security/signing-key), obtained independently of the report. Without it the key embedded in
// the report is used: that proves the report was not edited after it was signed, but not who signed it, and
// the output says so. Exit status: 0 verified, 1 not verified, 2 usage error.
const fs = require('node:fs');
const { verifyDoc } = require('../server/dr-report');

function main(argv) {
  const a = { file: null, publicKey: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--public-key') a.publicKey = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (!a.file) a.file = argv[i];
    else { console.error(`Unexpected argument ${argv[i]}`); return 2; }
  }
  if (!a.file) { console.error('Usage: npm run verify-dr-report -- <dr-drill-report.json> [--public-key <signing-key.pem>] [--json]'); return 2; }
  let doc; let pem = null;
  try { doc = JSON.parse(fs.readFileSync(a.file, 'utf8')); } catch (e) { console.error(`Could not read ${a.file}: ${e.message}`); return 2; }
  if (a.publicKey) {
    try { const t = fs.readFileSync(a.publicKey, 'utf8'); pem = t.trim().startsWith('{') ? JSON.parse(t).public_key_pem : t; } catch (e) { console.error(`Could not read ${a.publicKey}: ${e.message}`); return 2; }
  }
  const r = verifyDoc(doc, { publicKeyPem: pem });
  if (a.json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  const rep = doc && doc.report;
  console.log(`SUDS recovery-drill report: ${a.file}`);
  if (rep) console.log(`  drill ${rep.ok ? 'PASSED' : 'FAILED'} ${rep.started_at} on ${rep.server && rep.server.host} (SUDS ${rep.server && rep.server.version}); RTO ${rep.rto && rep.rto.seconds} s, RPO ${rep.rpo && rep.rpo.seconds} s`);
  console.log(`  public key: ${r.key_source}${r.key_id ? ` (key id ${r.key_id})` : ''}`);
  for (const w of r.warnings) console.log(`  note: ${w}`);
  for (const e of r.errors) console.log(`  FAIL: ${e}`);
  console.log(r.ok ? 'VERIFIED' : 'NOT VERIFIED');
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };

'use strict';
// Verify a SUDS compliance report (scripts/compliance-check.js; <data>/compliance/compliance-*.json or .html)
// away from the server, with the signing public key only — no database, no configuration, no secret key.
//
//   npm run verify-compliance-report -- <report.json | report.html> [--public-key <signing-key.pem>] [--json]
//
// --public-key is the public half of the key that signed the report, obtained independently of it. On SUDS
// Server that is the compliance check's own key, /etc/suds/compliance-signing-key.pub.pem (the installer prints
// its key id; record both at install): the SUDS service never holds its private half, so it cannot sign a
// report about itself. A report from a wizard or Docker install (report.host.signed_with says which) is
// signed with the server's evidence key (Settings → Security status → "Download signing public key").
// Without it the key embedded in the report is used, which proves the report was not edited but not who signed it; the output says so.
// For an HTML report, the page must also be exactly what the signed report embedded in it renders to, so
// an edit to what the page shows fails as surely as an edit to the data. Exit: 0 verified, 1 not, 2 usage.
const fs = require('node:fs');
const cr = require('../server/compliance-report');

function main(argv, log = console.log) {
  const a = { file: null, publicKey: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--public-key') a.publicKey = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (!a.file) a.file = argv[i];
    else { console.error(`Unexpected argument ${argv[i]}`); return 2; }
  }
  if (!a.file) { console.error('Usage: npm run verify-compliance-report -- <report.json|report.html> [--public-key <signing-key.pem>] [--json]'); return 2; }
  let text; let pem = null;
  try { text = fs.readFileSync(a.file, 'utf8'); } catch (e) { console.error(`Could not read ${a.file}: ${e.message}`); return 2; }
  if (a.publicKey) {
    try { const t = fs.readFileSync(a.publicKey, 'utf8'); pem = t.trim().startsWith('{') ? JSON.parse(t).public_key_pem : t; } catch (e) { console.error(`Could not read ${a.publicKey}: ${e.message}`); return 2; }
  }
  const isHtml = /^\s*<!doctype html/i.test(text);
  let r; let doc = null;
  if (isHtml) { r = cr.verifyHtml(text, { publicKeyPem: pem }); doc = cr.extractFromHtml(text); }
  else { try { doc = JSON.parse(text); } catch { doc = null; } r = cr.verifyDoc(doc, { publicKeyPem: pem }); }
  if (a.json) { log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  const rep = doc && doc.report;
  log(`SUDS compliance report (${isHtml ? 'HTML' : 'JSON'}): ${a.file}`);
  if (rep && rep.summary) log(`  ${rep.summary.overall} on ${rep.host && rep.host.hostname} at ${rep.generated_at}: ${rep.summary.counts.pass} pass, ${rep.summary.counts.fail} fail, ${rep.summary.counts.warn} warning, ${rep.summary.counts['not-checked']} could not check`);
  if (rep && rep.host && rep.host.signed_with) log(`  signed with: ${rep.host.signed_with}`);
  log(`  public key: ${r.key_source || 'none'}${r.key_id ? ` (key id ${r.key_id})` : ''}`);
  for (const w of r.warnings || []) log(`  note: ${w}`);
  for (const e of r.errors) log(`  FAIL: ${e}`);
  log(r.ok ? 'VERIFIED' : 'NOT VERIFIED');
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };

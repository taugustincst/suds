'use strict';
// Verify the evidence of a signature or approval confirmed with a fingerprint (docs/FINGERPRINT.md), offline, with
// nothing but Node: the file an auditor saved from GET /api/admin/signature-evidence?record_type=note&record_id=<id>
// (Settings access with audit:read), or one evidence object on its own.
//   node scripts/verify-passkey-evidence.js evidence.json [--content <hash>]
// For each piece of evidence it checks that the statement hashes to the challenge the device signed, that the client
// data is a WebAuthn assertion from a page of the relying party, that the device verified its user (UV) and was
// present (UP), and that the signature is valid under the passkey's public key (carried in the evidence, so it
// verifies after the passkey is removed). --content also checks the statement names that content hash (a note's
// signature_hash, as its Verify signature shows it). Exit 0 when every one verifies, 1 otherwise.
const fs = require('node:fs');
const { verifyEvidence } = require('../server/webauthn');

function run(argv) {
  const file = argv.find(a => !a.startsWith('--'));
  const ci = argv.indexOf('--content');
  const content = ci >= 0 ? argv[ci + 1] : null;
  if (!file) return { code: 2, lines: ['Usage: node scripts/verify-passkey-evidence.js <evidence.json> [--content <hash>]'] };
  let doc; try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { code: 2, lines: [`Cannot read ${file}: ${e.message}`] }; }
  const items = Array.isArray(doc.rows) ? doc.rows.map(r => r.evidence) : [doc.evidence || doc];
  const lines = []; let bad = 0;
  for (const ev of items) {
    if (!ev || !ev.statement) { bad++; lines.push('FAIL  an entry has no evidence'); continue; }
    const r = verifyEvidence(ev);
    const contentOk = !content || ev.statement.content === content;
    const ok = r.ok && contentOk;
    if (!ok) bad++;
    const s = ev.statement;
    lines.push(`${ok ? 'OK  ' : 'FAIL'}  ${s.purpose} of ${s.record_type} ${s.record_ids.join(', ')} by user ${s.user_id} at ${s.issued_at}` +
      ` — statement ${r.checks.statement ? 'ok' : 'MISMATCH'}, relying party ${r.checks.rp ? ev.rp_id : 'MISMATCH'}, user verified ${r.checks.flags ? 'yes' : 'NO'}, signature ${r.checks.signature ? 'valid' : 'INVALID'}` +
      (content ? `, content ${contentOk ? 'matches' : 'DOES NOT MATCH'}` : ''));
  }
  lines.push(bad ? `${bad} of ${items.length} did not verify.` : `All ${items.length} verified.`);
  return { code: bad ? 1 : 0, lines };
}

if (require.main === module) {
  const out = run(process.argv.slice(2));
  for (const l of out.lines) console.log(l);
  process.exit(out.code);
}
module.exports = { run };

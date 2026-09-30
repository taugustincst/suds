'use strict';
// Verify the evidence of a signature or approval confirmed with a fingerprint (docs/FINGERPRINT.md), offline, with
// nothing but Node: the file an auditor saved from GET /api/admin/signature-evidence?record_type=note&record_id=<id>
// (Settings access with audit:read), or one evidence object on its own.
//   node scripts/verify-passkey-evidence.js evidence.json [--content <hash>] [--audit <audit-export.ndjson> [--public-key <pem>]]
// For each piece of evidence it checks that the statement hashes to the challenge the device signed; that the client
// data is a WebAuthn assertion from an https page of the relying party (http only on localhost), not embedded in
// another page, and for the RP ID the statement names; that the device verified its user (UV) and was present (UP);
// that the signature is valid under the passkey's public key (carried in the evidence, so it verifies after the
// passkey is removed); and that this key and credential are the ones SUDS accepted when the passkey was enrolled: the
// SHA-256 of each is in the enrolment's hash-chained audit entry (auth.passkey.enrolled). --audit reads that entry
// from an audit export (GET /api/admin/audit/export), which is verified first (scripts/verify-audit-export.js, with
// --public-key for its signature); without it, the enrolment record the evidence export carries is used, and the
// output says so. --content also checks the statement names that content hash (a note's content hash, as its Verify
// signature shows it; for countersignatures given together, that it is among them). Exit 0 when every one verifies,
// 1 otherwise, 2 for a usage error.
const fs = require('node:fs');
const { verifyEvidence, canonical } = require('../server/webauthn');
const crypto = require('node:crypto');

const listHash = (rows) => crypto.createHash('sha256').update(canonical(rows)).digest('hex');
/** Enrolment records (passkey id -> { spki_sha256, credential_sha256, user_id }) from a verified audit export. */
function enrolmentsFromAudit(file, publicKey) {
  const { verifyExport } = require('../server/audit-export');
  const text = fs.readFileSync(file, 'utf8');
  const r = verifyExport(text, { publicKey });
  if (!r.ok) return { error: `the audit export does not verify: ${(r.errors || [])[0] || 'see npm run verify-audit-export'}` };
  const out = new Map();
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== 'entry' || e.action !== 'auth.passkey.enrolled' || !e.entity_id) continue;
    let d = {}; try { d = JSON.parse(e.details || '{}'); } catch { d = {}; }
    if (d.spki_sha256 && d.credential_sha256 && !out.has(e.entity_id)) out.set(e.entity_id, { spki_sha256: d.spki_sha256, credential_sha256: d.credential_sha256, user_id: e.user_id, audit_id: e.id });
  }
  return { enrolments: out, signed: !!r.signature };
}
/** Does the statement name `content`: directly, or as `recordId`'s entry in a batch's list (whose hash is its content)? */
function namesContent(s, content) {
  if (s.content === content) return true;
  return Array.isArray(s.items) && listHash(s.items) === s.content && s.items.some(x => Array.isArray(x) && x[1] === content);
}

function run(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const content = opt('--content'); const auditFile = opt('--audit'); const pkFile = opt('--public-key');
  const values = new Set([content, auditFile, pkFile].filter(Boolean));
  const file = argv.find(a => !a.startsWith('--') && !values.has(a));
  if (!file) return { code: 2, lines: ['Usage: node scripts/verify-passkey-evidence.js <evidence.json> [--content <hash>] [--audit <audit-export.ndjson> [--public-key <pem>]]'] };
  let doc; try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { code: 2, lines: [`Cannot read ${file}: ${e.message}`] }; }
  const items = Array.isArray(doc.rows) ? doc.rows.map(r => ({ ev: r.evidence, enrolment: r.enrolment || null, signer: r.user_id })) : [{ ev: doc.evidence || doc, enrolment: doc.enrolment || null, signer: null }];
  const lines = [];
  let audit = null;
  if (auditFile) {
    let pem = null; try { pem = pkFile ? fs.readFileSync(pkFile, 'utf8') : null; } catch (e) { return { code: 2, lines: [`Cannot read ${pkFile}: ${e.message}`] }; }
    try { audit = enrolmentsFromAudit(auditFile, pem); } catch (e) { return { code: 2, lines: [`Cannot read ${auditFile}: ${e.message}`] }; }
    if (audit.error) return { code: 1, lines: [`FAIL  ${audit.error}`] };
    lines.push(`Enrolment records read from the audit export ${auditFile} (verified${audit.signed ? ', signature checked' : ''}).`);
  } else lines.push('Enrolment records taken from the evidence export itself; pass --audit <audit export> to check them against the signed, hash-chained audit log.');
  let bad = 0;
  for (const { ev, enrolment, signer } of items) {
    if (!ev || !ev.statement) { bad++; lines.push('FAIL  an entry has no evidence'); continue; }
    const anchor = audit ? (audit.enrolments.get(ev.passkey_id) || null) : enrolment;
    const r = verifyEvidence(ev, { anchor });
    const who = anchor && anchor.user_id && anchor.user_id !== ev.statement.user_id ? false : !signer || signer === ev.statement.user_id;
    const contentOk = !content || namesContent(ev.statement, content);
    const ok = r.ok && contentOk && who;
    if (!ok) bad++;
    const s = ev.statement;
    lines.push(`${ok ? 'OK  ' : 'FAIL'}  ${s.purpose} of ${s.record_type} ${s.record_ids.join(', ')} by user ${s.user_id} at ${s.issued_at}` +
      ` — statement ${r.checks.statement ? 'ok' : 'MISMATCH'}, relying party ${r.checks.rp ? ev.rp_id : 'MISMATCH'}, origin ${r.checks.origin ? 'ok' : 'NOT ACCEPTABLE'}, user verified ${r.checks.flags ? 'yes' : 'NO'}, signature ${r.checks.signature ? 'valid' : 'INVALID'}` +
      `, enrolled key ${!anchor ? 'NO ENROLMENT RECORD' : r.checks.anchor ? 'matches' : 'DOES NOT MATCH'}${who ? '' : ', signer DOES NOT MATCH'}` +
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

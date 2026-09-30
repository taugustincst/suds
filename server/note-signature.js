'use strict';
// A note's signature hashes, in one place (docs/FINGERPRINT.md, "What a fingerprint signature is bound to"). Used by
// POST /api/notes/:id/sign and /cosign, GET /api/notes/:id/verify (server/routes/notes.js), a signature arriving by
// sync push (server/rules/notes.js), a fingerprint confirmation's binding (server/passkeys.js) and key rotation
// (scripts/rotate-key.js). Two hashes:
//
//  * signatureHash / cosignatureHash: the hash a note has carried since electronic signatures began
//    (notes.signature_hash, notes.cosignature_hash; audited as note.sign / note.cosign `hash`). It is taken over the
//    note's CIPHERTEXT, so it changes when the encryption key does: scripts/rotate-key.js recomputes it for every note
//    whose hash was intact under the old key (and leaves one that was not, so a tampered note stays visible). Kept
//    for back-compatibility: every signed note, every audit entry and every export names it.
//  * contentHash: SHA-256 over the canonical JSON (server/canonical.js) of what was signed, in PLAINTEXT: the note
//    id, the signer, the act (sign or cosign), the note's kind, title, text, structured sections, when it happened and
//    whose record it is. It does not change when the key does. A fingerprint confirmation's statement names this
//    hash (its `content`), so its evidence verifies after a key rotation, on the office server and offline.
//
// Works in the browser kernel too (rules/notes.js): nothing here reaches beyond server/crypto.js and canonical.js.
const { sha256, decrypt } = require('./crypto');
const { canonical } = require('./canonical');

/** The ciphertext signature hash (notes.signature_hash): the note as stored, and its signer. */
function signatureHash(n, signerId) { return sha256(`${n.id}|${signerId}|${n.content_enc}|${n.structured_enc || ''}`); }
/** The ciphertext countersignature hash (notes.cosignature_hash). */
function cosignatureHash(n, signerId) { return sha256(`${n.id}|${signerId}|cosign|${n.content_enc}|${n.structured_enc || ''}`); }

/** What a signature on this note says, in plaintext and in a fixed shape. `act`: 'sign' or 'cosign'. */
function signedContent(n, signerId, act = 'sign') {
  const dec = (v) => (v ? decrypt(v) : null);
  let structured = null;
  if (n.structured_enc) { const t = decrypt(n.structured_enc); try { structured = JSON.parse(t); } catch { structured = t; } }
  return { v: 1, act, note_id: n.id, signer_id: signerId, kind: n.kind, title: dec(n.title_enc), content: dec(n.content_enc), structured, occurred_at: n.occurred_at, client_id: n.client_id };
}
/** The plaintext content hash (hex SHA-256 of signedContent in canonical JSON): a fingerprint statement's `content`. */
function contentHash(n, signerId, act = 'sign') { return sha256(canonical(signedContent(n, signerId, act))); }

module.exports = { signatureHash, cosignatureHash, signedContent, contentHash };

'use strict';
// The canonical JSON SUDS hashes when a hash must mean the same thing wherever it is computed (docs/FINGERPRINT.md):
// object keys sorted at every level, no whitespace, undefined as null. Used for a fingerprint confirmation's
// statement (server/webauthn.js) and a note's plaintext signature hash (server/note-signature.js). Kept free of every
// other module, so the browser kernel and an offline verifier can load it with nothing but Node.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
module.exports = { canonical };

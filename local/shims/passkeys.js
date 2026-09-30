'use strict';
// SUDS on this device has no fingerprint sign-in or signing (docs/FINGERPRINT.md, "Not covered, or deferred"): the
// browser kernel is built with this in place of server/passkeys.js, server/webauthn.js and server/routes/passkeys.js
// (scripts/kernel-build-options.js), so none of the WebAuthn code is in it. The kernel's policy says passkeys are off
// (auth.passkeyPolicy), no route is mounted, and anything that would reach here is refused as not available.
const { HttpError } = require('../../server/http');
const unavailable = () => { throw new HttpError(404, 'Fingerprint sign-in is not available on this device'); };
module.exports = new Proxy({ remove: () => 0, adoption: () => ({ active: 0, with_passkey: 0, total: 0, flagged: 0, sign_ins_30d: 0, confirmations_30d: 0 }), configuredRpId: () => '', PURPOSES: [] }, {
  get: (t, k) => (k in t ? t[k] : k === '__esModule' ? false : unavailable),
});

// A device has no first-run password file (server/bootstrap.js writes one for the office operator), so there
// is nothing to discard when its administrator changes their password. Without this the password change
// answered 500 after the new password had been stored — and on a device whose records are sealed under the
// account's password (local/vault.js), the new password was never wrapped.
export function discardPasswordFile() {}
export function ensureBootstrap() {}
export default { discardPasswordFile, ensureBootstrap };

'use strict';
// The authenticator allow-list for passkeys (docs/FINGERPRINT.md, "Authenticator allow-list"): built for 1.21.0, not
// yet released. Off by default. When an administrator turns it on, only the authenticator models on the programme's
// list (by AAGUID) may be added as passkeys, and each new one must prove its model: SUDS asks for attestation
// ('direct') and verifies it (server/attestation.js) against the root certificates the FIDO Metadata Service lists
// for that model, from the Metadata Service BLOB the administrator downloaded and uploaded (SUDS makes no outbound
// call). A model the Metadata Service reports as compromised or revoked is refused.
//
// Passkeys already there when the list is turned on (the owner's decision, conservative): one that was not attested
// for a listed model at enrolment — every passkey added while the list was off — stops working for sign-in, the
// second step and signing at its next use, with a message saying why and the audit entry auth.passkey.not_allowed.
// The administrator sees which accounts that affects before saving (preview), and must confirm the number.
//
// Settings: authn_allowlist ('1' on), authn_allowlist_models (JSON [{ name, aaguid }]), authn_mds (JSON: the BLOB's
// number, next update, when it was loaded, its SHA-256, how many entries). The entries: authenticator_metadata.
// Office server only: SUDS on this device has no passkeys (local/shims/passkeys.js), and this module is never in the
// browser kernel (scripts/kernel-build-options.js).
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const A = require('./attestation');
const W = require('./webauthn');

const MAX_MODELS = 100;
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
const parse = (s, dflt) => { try { const v = JSON.parse(s); return v === null || v === undefined ? dflt : v; } catch { return dflt; } };

/**
 * The trust anchors for the Metadata Service BLOB: the FIDO Alliance's (attestation.js FIDO_MDS_ROOT_PEM). The test
 * and browser suites sign BLOBs of their own with a test root named by SUDS_TEST_FIDO_MDS_ROOT (a PEM file), honoured
 * only when SUDS_ENV is 'test' or 'development' — never in production. { roots, test }.
 */
function trustRoots() {
  const roots = [A.FIDO_MDS_ROOT_PEM];
  const f = process.env.SUDS_TEST_FIDO_MDS_ROOT;
  if (f && (config.env === 'test' || config.env === 'development')) {
    try { roots.push(fs.readFileSync(f, 'utf8')); return { roots, test: true }; } catch { /* the real root only */ }
  }
  return { roots, test: false };
}

// ---- the settings ----
function enabled() { return !config.local && db.getSetting('authn_allowlist', '0') === '1'; }
function models() { return parse(db.getSetting('authn_allowlist_models', '[]'), []).filter((m) => m && typeof m.aaguid === 'string'); }
/** The Metadata Service BLOB loaded: { no, next_update, loaded_at, sha256, entries, test_root, expired } or null. */
function metadataInfo(now = new Date()) {
  const m = parse(db.getSetting('authn_mds', 'null'), null);
  return m ? { ...m, expired: A.mdsExpired(m.next_update, now) } : null;
}
/**
 * The models a list names, checked: [{ name, aaguid }], AAGUIDs lower-case and each once. Throws `badRequest` with
 * the reason (an AAGUID not in the 8-4-4-4-12 form, a name missing, too many).
 */
function normaliseModels(list, badRequest) {
  if (!Array.isArray(list)) throw badRequest('models must be a list of { name, aaguid }');
  if (list.length > MAX_MODELS) throw badRequest(`At most ${MAX_MODELS} authenticator models`);
  const out = []; const seen = new Set();
  for (const m of list) {
    const aaguid = String((m && m.aaguid) || '').trim().toLowerCase();
    if (!A.AAGUID_RE.test(aaguid)) throw badRequest(`"${String((m && m.aaguid) || '').slice(0, 40)}" is not an AAGUID (8-4-4-4-12 hexadecimal digits)`, { fields: { models: 'aaguid' } });
    if (seen.has(aaguid)) continue;
    seen.add(aaguid);
    out.push({ name: cleanName(m.name) || entryFor({ aaguid })?.description || aaguid, aaguid });
  }
  return out;
}

// ---- the metadata ----
function rowToEntry(r) {
  return r ? { id: r.id, aaguid: r.aaguid, keyIds: parse(r.key_ids, []), description: r.description, roots: parse(r.root_certificates, []), statuses: parse(r.status_reports, []), attestationTypes: parse(r.attestation_types, []), mdsNo: r.mds_no } : null;
}
/** The Metadata Service entry for an AAGUID or (fido-u2f) an attestation key identifier. */
function entryFor({ aaguid, keyId }) {
  if (keyId) return rowToEntry(db.one(`SELECT * FROM authenticator_metadata WHERE EXISTS (SELECT 1 FROM json_each(authenticator_metadata.key_ids) WHERE value=?)`, keyId));
  if (!aaguid || aaguid === A.ZERO_AAGUID) return null;
  return rowToEntry(db.one(`SELECT * FROM authenticator_metadata WHERE aaguid=?`, aaguid));
}
/** The FIDO2 models the loaded file lists, for choosing from: [{ aaguid, description, refused }], by description. */
function catalog() {
  return db.all(`SELECT aaguid, description, status_reports FROM authenticator_metadata WHERE aaguid IS NOT NULL ORDER BY description COLLATE NOCASE, aaguid`)
    .map((r) => ({ aaguid: r.aaguid, description: r.description || r.aaguid, refused: A.refusedStatuses(parse(r.status_reports, [])) }));
}
/**
 * How a listed model stands in the loaded file: 'ok', 'missing' (the file does not list it, so nothing could be
 * attested for it) or 'refused' (a compromised or revoked status). The zero AAGUID (fido-u2f keys) is 'ok' when the
 * file lists any U2F key.
 */
function modelStanding(aaguid) {
  if (aaguid === A.ZERO_AAGUID) return db.one(`SELECT 1 FROM authenticator_metadata WHERE key_ids <> '[]' LIMIT 1`) ? { standing: 'ok', description: 'FIDO U2F security keys (no AAGUID)' } : { standing: 'missing', description: '' };
  const e = entryFor({ aaguid });
  if (!e) return { standing: 'missing', description: '' };
  const refused = A.refusedStatuses(e.statuses);
  return { standing: refused.length ? 'refused' : 'ok', description: e.description, refused };
}

/**
 * Load a Metadata Service BLOB: verified (attestation.js verifyMdsBlob, against trustRoots()), not older than the one
 * loaded (a lower `no` could hide a newer revocation), and then kept in place of the old one, in one transaction.
 * Throws WebAuthnError (the route turns it into a 400). Returns metadataInfo().
 */
function loadMetadata(jwt, { now = new Date() } = {}) {
  const tr = trustRoots();
  const blob = A.verifyMdsBlob(jwt, { roots: tr.roots, now });
  const cur = metadataInfo(now);
  if (cur && blob.no < cur.no) throw new W.WebAuthnError('mds_older', `This metadata file (number ${blob.no}) is older than the one already loaded (number ${cur.no}). Download the current one from the FIDO Metadata Service.`);
  const info = { no: blob.no, next_update: blob.nextUpdate, loaded_at: new Date().toISOString(), sha256: crypto.createHash('sha256').update(String(jwt).trim()).digest('hex'), entries: blob.entries.length, test_root: tr.test };
  db.transaction(() => {
    db.run(`DELETE FROM authenticator_metadata`);
    for (const e of blob.entries) {
      db.run(`INSERT OR REPLACE INTO authenticator_metadata(id,aaguid,key_ids,description,root_certificates,status_reports,attestation_types,mds_no) VALUES(?,?,?,?,?,?,?,?)`,
        e.aaguid || `u2f:${e.keyIds[0]}`, e.aaguid, JSON.stringify(e.keyIds), e.description, JSON.stringify(e.roots), JSON.stringify(e.statuses), JSON.stringify(e.attestationTypes), blob.no);
    }
    db.setSetting('authn_mds', JSON.stringify(info));
  });
  return metadataInfo(now);
}

// ---- enrolment under the list ----
/**
 * Verify a new passkey's attestation under the allow-list (called by server/passkeys.js registrationFinish with
 * verifyRegistration's `attestation`). Refused, with a WebAuthnError whose code starts 'allowlist_' or is the
 * verifier's: no metadata or out-of-date metadata; no attestation ('none': synced passkeys in iCloud Keychain or
 * Google Password Manager give none), self attestation or a format SUDS cannot verify; a model not on the list, not
 * in the metadata, or with a compromised or revoked status; a certificate chain that does not lead to that model's
 * roots. Returns what passkeys.attestation keeps: { verified, fmt, type, aaguid, mds_no, verified_at }.
 */
function checkRegistration(att, { now = new Date() } = {}) {
  const meta = metadataInfo(now);
  if (!meta) throw new W.WebAuthnError('allowlist_metadata', 'Your programme accepts only certain authenticator models, and its administrator has not loaded the FIDO Metadata Service file SUDS checks them against yet. Ask your administrator.');
  if (meta.expired) throw new W.WebAuthnError('allowlist_metadata_expired', `Your programme accepts only certain authenticator models, and the FIDO Metadata Service file SUDS checks them against is out of date (its next update was due on ${meta.next_update}). Ask your administrator to load the current one.`);
  const r = A.verifyAttestation(att);
  if (r.type === 'none') throw new W.WebAuthnError('allowlist_attestation', 'Your programme accepts only certain authenticator models, and this device did not say which model it is (no attestation). Passkeys kept in a password manager or synced between devices do not. Use an authenticator your administrator lists.');
  if (r.type === 'self') throw new W.WebAuthnError('allowlist_self_attestation', 'Your programme accepts only certain authenticator models, and this authenticator vouched only for itself (self attestation), which does not prove its model. Use an authenticator your administrator lists.');
  const listed = models().map((m) => m.aaguid);
  if (!listed.includes(r.aaguid)) throw new W.WebAuthnError('allowlist_model', `This authenticator model (${r.aaguid}) is not on your programme's list of accepted authenticators. Use one your administrator lists.`);
  const entry = entryFor({ aaguid: r.aaguid, keyId: r.keyId });
  if (!entry) throw new W.WebAuthnError('allowlist_metadata_missing', 'This authenticator model is not in the FIDO Metadata Service file your administrator loaded, so SUDS cannot check it.');
  const refused = A.refusedStatuses(entry.statuses);
  if (refused.length) throw new W.WebAuthnError('allowlist_status', `The FIDO Metadata Service reports this authenticator model as not to be trusted (${refused.join(', ')}). Use another one.`);
  A.verifyChain(r.x5c, entry.roots.map((c) => Buffer.from(c, 'base64')), { now, code: 'allowlist_chain' });
  return { verified: true, fmt: r.fmt, type: r.type, aaguid: r.aaguid, ...(r.keyId ? { key_id: r.keyId } : {}), mds_no: meta.no, verified_at: now.toISOString() };
}

// ---- using a passkey under the list ----
/**
 * Whether a stored passkey may be used now: always with the list off; with it on, only one whose attestation was
 * verified at enrolment for a model on the list, whose metadata entry is still there and not compromised or revoked.
 * `list`/`on`: a proposed list, for the preview. { ok, reason: 'unattested' | 'not listed' | 'status' | 'not in metadata' }.
 */
function passkeyAllowed(pk, { on = enabled(), list = null } = {}) {
  if (!on) return { ok: true };
  const att = parse(pk.attestation, null);
  if (!att || !att.verified || !att.aaguid) return { ok: false, reason: 'unattested' };
  const aaguids = (list || models()).map((m) => m.aaguid);
  if (!aaguids.includes(att.aaguid)) return { ok: false, reason: 'not listed' };
  const e = entryFor({ aaguid: att.aaguid, keyId: att.key_id });
  if (!e) return { ok: false, reason: 'not in metadata' };
  if (A.refusedStatuses(e.statuses).length) return { ok: false, reason: 'status' };
  return { ok: true };
}
const REASONS = {
  unattested: 'it was added before your programme began accepting only certain authenticator models, so its model was never proven',
  'not listed': 'its authenticator model is not on your programme\'s list',
  status: 'the FIDO Metadata Service reports its authenticator model as compromised or revoked',
  'not in metadata': 'its authenticator model is no longer in the metadata file your administrator loaded',
};
/** The message a person sees when their passkey is refused by the list. */
function refusalMessage(reason) {
  return `This passkey is not accepted any more: ${REASONS[reason] || 'its authenticator model is not accepted'}. Sign in with your password instead, then add a passkey on an accepted authenticator under My profile, or ask your administrator.`;
}

/**
 * Who a proposed setting would stop: every active account's passkeys (not already disabled as a possible copy) that
 * the list would refuse. [{ user_id, username, display_name, other_factor (an authenticator app), passkeys: [{ id,
 * name, aaguid, reason }] }] and the counts. Staff names only: no PHI.
 */
function affected({ on, list }) {
  if (!on) return { accounts: [], account_count: 0, passkey_count: 0 };
  const rows = db.all(`SELECT p.*, u.username, u.display_name, u.mfa_enabled FROM passkeys p JOIN users u ON u.id=p.user_id WHERE u.is_active=1 AND p.flagged_at IS NULL ORDER BY u.display_name COLLATE NOCASE, p.created_at`);
  const by = new Map();
  for (const p of rows) {
    const a = passkeyAllowed(p, { on, list });
    if (a.ok) continue;
    if (!by.has(p.user_id)) by.set(p.user_id, { user_id: p.user_id, username: p.username, display_name: p.display_name, other_factor: !!p.mfa_enabled, passkeys: [] });
    by.get(p.user_id).passkeys.push({ id: p.id, name: p.name, aaguid: p.aaguid, reason: a.reason });
  }
  const accounts = [...by.values()];
  return { accounts, account_count: accounts.length, passkey_count: accounts.reduce((n, a) => n + a.passkeys.length, 0) };
}

/** Settings → Security status's line, and the settings card's summary. */
function status() {
  const meta = metadataInfo();
  const list = models();
  return { enabled: enabled(), models: list.map((m) => ({ ...m, ...modelStanding(m.aaguid) })), metadata: meta };
}

module.exports = { MAX_MODELS, trustRoots, enabled, models, metadataInfo, normaliseModels, entryFor, catalog, modelStanding, loadMetadata, checkRegistration, passkeyAllowed, refusalMessage, affected, status };

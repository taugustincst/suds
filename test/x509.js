'use strict';
// A minimal X.509 certificate maker for the tests (node:crypto signs; it has no way to make a certificate): DER
// encoding by hand, enough for the authenticator allow-list's tests (test/attestation.test.js) to build attestation
// CAs and leaves (packed, fido-u2f, TPM, Android key), FIDO Metadata Service BLOBs and their signing chain, and to
// bend every part that must be checked (the dates, the subject, the extensions, the issuer). Test keys only, made
// fresh on every run; nothing here is a real authenticator's or the FIDO Alliance's.
const crypto = require('node:crypto');

const len = (n) => {
  if (n < 128) return Buffer.from([n]);
  const b = []; while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, content) => Buffer.concat([Buffer.isBuffer(tag) ? tag : Buffer.from([tag]), len(content.length), content]);
const seq = (...xs) => tlv(0x30, Buffer.concat(xs));
const set = (...xs) => tlv(0x31, Buffer.concat(xs));
function int(n) {
  if (Buffer.isBuffer(n)) return tlv(0x02, n[0] & 0x80 ? Buffer.concat([Buffer.from([0]), n]) : n);
  const b = []; let v = n; do { b.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(0x02, Buffer.from(b));
}
const enumerated = (n) => { const i = int(n); i[0] = 0x0a; return i; };
function oid(s) {
  const p = s.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) { const b = []; let x = v; do { b.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x > 0); for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80; out.push(...b); }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const printable = (s) => tlv(0x13, Buffer.from(s, 'ascii'));
const octet = (b) => tlv(0x04, b);
const bitstring = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const nul = () => Buffer.from([0x05, 0x00]);
/** A context-specific tag [n], constructed (EXPLICIT), including the high tag numbers Android uses ([600], [702]). */
function ctx(n, content) {
  if (n < 31) return tlv(0xa0 | n, content);
  const b = []; let x = n; do { b.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x > 0); for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80;
  return tlv(Buffer.from([0xbf, ...b]), content);
}
function time(d) {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2) + 'Z', 'ascii')) : tlv(0x18, Buffer.from(iso + 'Z', 'ascii'));
}
const NAME_OIDS = { C: '2.5.4.6', O: '2.5.4.10', OU: '2.5.4.11', CN: '2.5.4.3' };
/** A Name from [['C', 'US'], ['O', 'Maker'], ...] (C as PrintableString, the rest UTF8String); [] is the empty Name. */
const name = (attrs) => seq(...attrs.map(([k, v]) => set(seq(oid(NAME_OIDS[k] || k), k === 'C' ? printable(v) : utf8(v)))));
const ext = (id, value, critical = false) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));

const EXT = {
  basicConstraints: (ca) => ext('2.5.29.19', ca ? seq(bool(true)) : seq(), true),
  keyUsageCA: () => ext('2.5.29.15', tlv(0x03, Buffer.from([0x01, 0x06])), true), // keyCertSign, cRLSign
  aaguid: (aaguid, critical = false) => ext('1.3.6.1.4.1.45724.1.1.4', octet(Buffer.isBuffer(aaguid) ? aaguid : Buffer.from(String(aaguid).replace(/-/g, ''), 'hex')), critical),
  eku: (...oids) => ext('2.5.29.37', seq(...oids.map(oid))),
  sanDns: (...names) => ext('2.5.29.17', seq(...names.map((n) => tlv(0x82, Buffer.from(n, 'ascii'))))),
  /** A TPM's subject alternative name: directoryName with the TCG manufacturer, model and version. */
  sanTpm: ({ manufacturer = 'id:FFFFF1D0', model = 'SUDS test TPM', version = 'id:13' } = {}) => ext('2.5.29.17', seq(ctx(4, seq(
    set(seq(oid('2.23.133.2.1'), utf8(manufacturer))), set(seq(oid('2.23.133.2.2'), utf8(model))), set(seq(oid('2.23.133.2.3'), utf8(version)))))), true),
  /** Android's KeyDescription: the challenge, and what the secure hardware (teeEnforced) says of the key. */
  androidKey: ({ challenge, teeOrigin = 0, teePurpose = [2], allApplications = false, sw = [] } = {}) => {
    const authz = (items) => seq(...items);
    const tee = [ctx(1, set(...teePurpose.map(int))), ...(teeOrigin === null ? [] : [ctx(702, int(teeOrigin))]), ...(allApplications ? [ctx(600, nul())] : [])];
    return ext('1.3.6.1.4.1.11129.2.1.17', seq(int(3), enumerated(1), int(4), enumerated(1), octet(challenge), octet(Buffer.alloc(0)), authz(sw), authz(tee)));
  },
};

const sigAlgFor = (key) => (key.asymmetricKeyType === 'rsa' ? seq(oid('1.2.840.113549.1.1.11'), nul()) : seq(oid('1.2.840.10045.4.3.2')));
let serial = 1;
/**
 * A certificate: `subject` and `issuer` as Name attribute lists, `publicKey` the subject's KeyObject, `signKey` the
 * issuer's private KeyObject, dates, and `extensions` (DER, from EXT). `version` 3 unless bent. Returns DER.
 */
function cert({ subject = [['CN', 'test']], issuer, publicKey, signKey, notBefore = new Date(Date.now() - 86400_000), notAfter = new Date(Date.now() + 365 * 86400_000), extensions = [], version = 3 }) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const alg = sigAlgFor(signKey);
  const tbs = seq(...(version === 3 ? [ctx(0, int(2))] : []), int(serial++), alg, name(issuer || subject), seq(time(notBefore), time(notAfter)), name(subject), spki,
    ...(extensions.length && version === 3 ? [ctx(3, seq(...extensions))] : []));
  const sig = signKey.asymmetricKeyType === 'rsa' ? crypto.sign('sha256', tbs, signKey) : crypto.sign('sha256', tbs, { key: signKey, dsaEncoding: 'der' });
  return seq(tbs, alg, bitstring(sig));
}
const ecKeys = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsaKeys = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

/** A CA: { keys, der, subject }, self-signed unless `issuer` ({ keys, subject }) is given. */
function ca(cn, { issuer, notBefore, notAfter, keys = ecKeys() } = {}) {
  const subject = [['C', 'US'], ['O', 'SUDS tests'], ['CN', cn]];
  const der = cert({ subject, issuer: issuer ? issuer.subject : subject, publicKey: keys.publicKey, signKey: issuer ? issuer.keys.privateKey : keys.privateKey, notBefore, notAfter, extensions: [EXT.basicConstraints(true), EXT.keyUsageCA()] });
  return { keys, der, subject };
}

// ---- the FIDO Metadata Service BLOB ----
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/**
 * A signed BLOB: `payload` ({ no, nextUpdate, entries }), signed by `signer` ({ keys, der }) whose chain (`chain`, DER,
 * after the signer) goes to a root. `alg` ES256 or RS256. `tamper` changes the payload after signing.
 */
function mdsBlob({ payload, signer, chain = [], alg, tamper }) {
  const a = alg || (signer.keys.privateKey.asymmetricKeyType === 'rsa' ? 'RS256' : 'ES256');
  const header = b64url(JSON.stringify({ alg: a, typ: 'JWT', x5c: [signer.der, ...chain].map((d) => d.toString('base64')) }));
  const body = b64url(JSON.stringify(payload));
  const data = Buffer.from(`${header}.${body}`);
  const sig = a === 'RS256' ? crypto.sign('sha256', data, signer.keys.privateKey) : crypto.sign('sha256', data, { key: signer.keys.privateKey, dsaEncoding: 'ieee-p1363' });
  const out = tamper ? b64url(JSON.stringify(tamper(JSON.parse(JSON.stringify(payload))))) : body;
  return `${header}.${out}.${b64url(sig)}`;
}
/**
 * A Metadata Service signing chain under `root` ({ keys, der, subject }): an intermediate CA, and a leaf for
 * mds.fidoalliance.org (or `host`). { signer, chain }.
 */
function mdsSigner(root, { host = 'mds.fidoalliance.org', keys = rsaKeys(), notAfter } = {}) {
  const inter = ca('SUDS test MDS intermediate', { issuer: root });
  const subject = [['C', 'US'], ['O', 'SUDS tests'], ['CN', host]];
  const der = cert({ subject, issuer: inter.subject, publicKey: keys.publicKey, signKey: inter.keys.privateKey, notAfter, extensions: [EXT.basicConstraints(false), EXT.sanDns(host)] });
  return { signer: { keys, der }, chain: [inter.der] };
}
/** A Metadata Service entry for a FIDO2 model (or, with keyIds and no aaguid, a U2F key). */
function mdsEntry({ aaguid, keyIds, description = 'SUDS test authenticator', roots = [], statuses = [{ status: 'FIDO_CERTIFIED_L1', effectiveDate: '2025-01-01' }] }) {
  return { ...(aaguid ? { aaguid } : {}), ...(keyIds ? { attestationCertificateKeyIdentifiers: keyIds } : {}),
    metadataStatement: { description, attestationRootCertificates: roots.map((d) => d.toString('base64')), attestationTypes: ['basic_full'] }, statusReports: statuses, timeOfLastStatusChange: '2025-01-01' };
}

module.exports = { tlv, seq, set, int, oid, octet, utf8, bitstring, bool, nul, ctx, name, ext, EXT, cert, ca, ecKeys, rsaKeys, pem, b64url, mdsBlob, mdsSigner, mdsEntry };

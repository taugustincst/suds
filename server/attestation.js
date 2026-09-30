'use strict';
// Attestation for the authenticator allow-list (docs/FINGERPRINT.md, "Authenticator allow-list"), with node:crypto
// alone, as for the rest of SUDS's WebAuthn code (server/webauthn.js). Off by default: SUDS asks for attestation only
// when a programme turns the allow-list on, and then checks here that the new passkey really is the model it says:
//  * a small DER reader, for the parts of an X.509 certificate node:crypto does not expose (the version, the
//    extensions: the FIDO AAGUID, a TPM's subject alternative name, Android's key description);
//  * a certificate chain check with node:crypto's X509Certificate, ending at a trust anchor the administrator supplied
//    (the FIDO Metadata Service's attestationRootCertificates for that model);
//  * the attestation statement formats: `packed` (full attestation with a certificate; self attestation is reported
//    as such, and the allow-list refuses it), `fido-u2f`, `tpm` (TPM 2.0) and `android-key`. Any other format (`apple`,
//    `android-safetynet`, `none`) is reported as unverifiable, which the allow-list refuses;
//  * the FIDO Metadata Service BLOB (a JWT the administrator downloads and uploads: SUDS makes no outbound call): its
//    certificate chain to the FIDO Alliance's root (FIDO_MDS_ROOT_PEM below), its signer's name, its signature, its
//    nextUpdate date, and the few fields SUDS needs from each entry.
//
// Kept free of the database and of config at require time, like server/webauthn.js.
const crypto = require('node:crypto');
const W = require('./webauthn');

const fail = (code, message) => { throw new W.WebAuthnError(code, message); };

/**
 * The FIDO Alliance Metadata Service (MDS3) BLOB is signed by a certificate for mds.fidoalliance.org that chains to
 * GlobalSign Root CA - R3 (https://fidoalliance.org/metadata/, "Metadata BLOB signing trust anchor"). This is that
 * root, as published by GlobalSign (https://secure.globalsign.com/cacert/root-r3.crt).
 *   Subject: OU=GlobalSign Root CA - R3, O=GlobalSign, CN=GlobalSign; valid 2009-03-18 to 2029-03-18.
 *   SHA-256: CB:B5:22:D7:B7:F1:27:AD:6A:01:13:86:5B:DF:1C:D4:10:2E:7D:07:59:AF:63:5A:7C:F4:72:0D:C9:63:C5:3B
 * A GlobalSign root signs many other sites' certificates too, so the BLOB's signing certificate must also be for
 * mds.fidoalliance.org (MDS_SIGNER_HOST). test/attestation.test.js checks this constant against its SHA-256.
 */
const FIDO_MDS_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIDXzCCAkegAwIBAgILBAAAAAABIVhTCKIwDQYJKoZIhvcNAQELBQAwTDEgMB4G
A1UECxMXR2xvYmFsU2lnbiBSb290IENBIC0gUjMxEzARBgNVBAoTCkdsb2JhbFNp
Z24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMDkwMzE4MTAwMDAwWhcNMjkwMzE4
MTAwMDAwWjBMMSAwHgYDVQQLExdHbG9iYWxTaWduIFJvb3QgQ0EgLSBSMzETMBEG
A1UEChMKR2xvYmFsU2lnbjETMBEGA1UEAxMKR2xvYmFsU2lnbjCCASIwDQYJKoZI
hvcNAQEBBQADggEPADCCAQoCggEBAMwldpB5BngiFvXAg7aEyiie/QV2EcWtiHL8
RgJDx7KKnQRfJMsuS+FggkbhUqsMgUdwbN1k0ev1LKMPgj0MK66X17YUhhB5uzsT
gHeMCOFJ0mpiLx9e+pZo34knlTifBtc+ycsmWQ1z3rDI6SYOgxXG71uL0gRgykmm
KPZpO/bLyCiR5Z2KYVc3rHQU3HTgOu5yLy6c+9C7v/U9AOEGM+iCK65TpjoWc4zd
QQ4gOsC0p6Hpsk+QLjJg6VfLuQSSaGjlOCZgdbKfd/+RFO+uIEn8rUAVSNECMWEZ
XriX7613t2Saer9fwRPvm2L7DWzgVGkWqQPabumDk3F2xmmFghcCAwEAAaNCMEAw
DgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFI/wS3+o
LkUkrk1Q+mOai97i3Ru8MA0GCSqGSIb3DQEBCwUAA4IBAQBLQNvAUKr+yAzv95ZU
RUm7lgAJQayzE4aGKAczymvmdLm6AC2upArT9fHxD4q/c2dKg8dEe3jgr25sbwMp
jjM5RcOO5LlXbKr8EpbsU8Yt5CRsuZRj+9xTaGdWPoO4zzUhw8lo/s7awlOqzJCK
6fBdRoyV3XpYKBovHd7NADdBj+1EbddTKJd+82cEHhXXipa0095MJ6RMG3NzdvQX
mcIfeg7jLQitChws/zyrVQ4PkX4268NXSb7hLi18YIvDQVETI53O9zJrlAGomecs
Mx86OyXShkDOOyyGeMlhLxS67ttVb9+E7gUJTb0o2HLO02JQZR7rkpeDMdmztcpH
WD9f
-----END CERTIFICATE-----
`;
const FIDO_MDS_ROOT_SHA256 = 'CB:B5:22:D7:B7:F1:27:AD:6A:01:13:86:5B:DF:1C:D4:10:2E:7D:07:59:AF:63:5A:7C:F4:72:0D:C9:63:C5:3B';
const MDS_SIGNER_HOST = 'mds.fidoalliance.org';

// Statuses in a Metadata Service entry that mean the model must not be trusted (FIDO Metadata Service v3.0, §3.1.4
// AuthenticatorStatus). One such report anywhere in the entry's history refuses the model: a later "update
// available" does not make the devices already made safe.
const REFUSED_STATUSES = ['REVOKED', 'USER_VERIFICATION_BYPASS', 'ATTESTATION_KEY_COMPROMISE', 'USER_KEY_REMOTE_COMPROMISE', 'USER_KEY_PHYSICAL_COMPROMISE'];
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

// ---- DER (X.690), read only ----
/** One TLV at `off` in `buf`: { cls, constructed, tag, value, end, raw }. Definite lengths only. */
function derRead(buf, off = 0) {
  if (!Buffer.isBuffer(buf) || off + 2 > buf.length) fail('der', 'A certificate or attestation field ends early');
  const b0 = buf[off]; let p = off + 1;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) {
    tag = 0; let b;
    do { if (p >= buf.length) fail('der', 'A certificate field ends early'); b = buf[p++]; tag = tag * 128 + (b & 0x7f); if (tag > 0xffffff) fail('der', 'A certificate tag is too large'); } while (b & 0x80);
  }
  if (p >= buf.length) fail('der', 'A certificate field ends early');
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) fail('der', 'A certificate field has a length SUDS does not read');
    len = 0; for (let i = 0; i < n; i++) { if (p >= buf.length) fail('der', 'A certificate field ends early'); len = len * 256 + buf[p++]; }
  }
  if (p + len > buf.length) fail('der', 'A certificate field ends early');
  return { cls: b0 >> 6, constructed: !!(b0 & 0x20), tag, value: buf.subarray(p, p + len), end: p + len, raw: buf.subarray(off, p + len) };
}
/** The TLVs inside a constructed value, in order. */
function derChildren(value) {
  const out = []; let p = 0;
  while (p < value.length) { const c = derRead(value, p); out.push(c); p = c.end; if (out.length > 4096) fail('der', 'A certificate field has too many parts'); }
  return out;
}
function oidString(b) {
  if (!b.length) fail('der', 'An empty object identifier');
  const parts = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  if (b[0] >= 80) { parts[0] = 2; parts[1] = b[0] - 80; }
  return parts.join('.');
}
function derInt(value) { let n = 0; for (const x of value) n = n * 256 + x; return n; }

/** The certificate's version and extensions ({ oid → { critical, value } }), which X509Certificate does not give. */
function certDetails(der) {
  const cert = derRead(der);
  if (cert.end !== der.length) fail('der', 'A certificate has bytes left over');
  const [tbs] = derChildren(cert.value);
  const f = derChildren(tbs.value);
  let i = 0; let version = 1;
  if (f[0] && f[0].cls === 2 && f[0].tag === 0) { version = derInt(derRead(f[0].value).value) + 1; i = 1; }
  const subject = f[i + 4];
  const extensions = new Map();
  for (const x of f.slice(i + 6)) {
    if (x.cls !== 2 || x.tag !== 3) continue;
    for (const e of derChildren(derRead(x.value).value)) {
      const parts = derChildren(e.value);
      const oid = oidString(parts[0].value);
      let critical = false; let k = 1;
      if (parts[1] && parts[1].cls === 0 && parts[1].tag === 1) { critical = parts[1].value[0] !== 0; k = 2; }
      if (!parts[k] || parts[k].tag !== 4) fail('der', 'A certificate extension is not understood');
      if (extensions.has(oid)) fail('der', 'A certificate has the same extension twice');
      extensions.set(oid, { critical, value: parts[k].value });
    }
  }
  return { version, extensions, subjectEmpty: !!subject && derChildren(subject.value).length === 0 };
}
/** The subject of an X509Certificate as { C, O, OU, CN, ... } (node gives "C=US\nO=...", one attribute a line). */
function subjectFields(x) {
  const out = {};
  for (const line of String(x.subject || '').split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i)] = line.slice(i + 1); }
  return out;
}
/** The certificate's public key, as RFC 5280's key identifier (method 1): SHA-1 of the subjectPublicKey bits, hex. */
function keyIdentifier(x) {
  const spki = x.publicKey.export({ type: 'spki', format: 'der' });
  const [, bits] = derChildren(derRead(spki).value);
  return crypto.createHash('sha1').update(bits.value.subarray(1)).digest('hex');
}

function x509(der, what = 'An attestation certificate') {
  try { return new crypto.X509Certificate(der); } catch { return fail('certificate', `${what} could not be read`); }
}
const inDate = (x, now) => Date.parse(x.validFrom) <= now.getTime() && now.getTime() <= Date.parse(x.validTo);

/**
 * Check that `chain` (DER Buffers, the leaf first) leads to one of `roots` (DER Buffers or PEM strings): every
 * certificate in date, each issued and signed by the next (which must be a CA), and the last either one of the roots
 * or issued and signed by one (itself in date). No revocation lists are fetched (SUDS makes no outbound call): the
 * Metadata Service's status reports stand for them. `code` names the failure. Returns the anchor.
 */
function verifyChain(chain, roots, { now = new Date(), code = 'chain', what = 'The attestation certificate' } = {}) {
  if (!Array.isArray(chain) || !chain.length) fail(code, `${what} has no certificate`);
  if (chain.length > 6) fail(code, `${what} chain is too long`);
  const certs = chain.map((d) => x509(d));
  const anchors = (roots || []).map((r) => { try { return new crypto.X509Certificate(r); } catch { return null; } }).filter(Boolean);
  if (!anchors.length) fail(code, 'There is no trusted root certificate to check it against');
  for (const c of certs) if (!inDate(c, now)) fail(code, `${what} has expired or is not valid yet (${c.validFrom} to ${c.validTo})`);
  for (let i = 0; i + 1 < certs.length; i++) {
    const child = certs[i]; const parent = certs[i + 1];
    if (!parent.ca) fail(code, `${what} chain has a certificate that is not a certificate authority where one is needed`);
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) fail(code, `${what} chain is broken: a certificate was not signed by the next one`);
  }
  const last = certs[certs.length - 1];
  const same = anchors.find((a) => a.raw.equals(last.raw));
  if (same) return same;
  const anchor = anchors.find((a) => { try { return last.checkIssued(a) && last.verify(a.publicKey); } catch { return false; } });
  if (!anchor) fail(code, `${what} does not lead to a root certificate SUDS was given for it (not trusted)`);
  if (!inDate(anchor, now)) fail(code, `The root certificate for ${what.toLowerCase()} has expired`);
  return anchor;
}

// ---- signatures in attestation statements ----
// COSE algorithm → [hash, kind]. RS1 (SHA-1) is not accepted.
const SIG = { [-7]: ['sha256', 'ec'], [-35]: ['sha384', 'ec'], [-36]: ['sha512', 'ec'], [-257]: ['sha256', 'rsa'], [-258]: ['sha384', 'rsa'], [-259]: ['sha512', 'rsa'],
  [-37]: ['sha256', 'pss'], [-38]: ['sha384', 'pss'], [-39]: ['sha512', 'pss'], [-8]: [null, 'ed'], [-19]: [null, 'ed'] };
function verifyWith(alg, key, data, sig) {
  const s = SIG[alg];
  if (!s) fail('attestation_alg', 'The attestation uses a signature algorithm SUDS does not accept');
  try {
    if (s[1] === 'ec') return crypto.verify(s[0], data, { key, dsaEncoding: 'der' }, sig);
    if (s[1] === 'rsa') return crypto.verify(s[0], data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
    if (s[1] === 'pss') return crypto.verify(s[0], data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
    return crypto.verify(null, data, key, sig);
  } catch { return false; }
}
function x5cOf(st, { max = 6 } = {}) {
  const x5c = st.get('x5c');
  if (!Array.isArray(x5c) || !x5c.length || x5c.length > max || !x5c.every(Buffer.isBuffer)) fail('attestation', 'The attestation statement has no certificate chain');
  return x5c;
}
/** The FIDO AAGUID extension (1.3.6.1.4.1.45724.1.1.4), when the certificate has one, must name this AAGUID and not be critical. */
function checkAaguidExtension(details, aaguid) {
  const ext = details.extensions.get('1.3.6.1.4.1.45724.1.1.4');
  if (!ext) return;
  if (ext.critical) fail('attestation_cert', 'The attestation certificate marks its AAGUID extension critical');
  const o = derRead(ext.value);
  if (o.tag !== 4 || !aaguid || !o.value.equals(aaguid)) fail('attestation_aaguid', 'The attestation certificate is for a different authenticator model than the device reported');
}

// ---- formats (W3C Web Authentication Level 2, §8) ----
function packed(a) {
  const st = a.attStmt; const alg = st.get('alg'); const sig = st.get('sig');
  if (typeof alg !== 'number' || !Buffer.isBuffer(sig)) fail('attestation', 'The packed attestation statement is not understood');
  if (st.has('ecdaaKeyId')) fail('attestation_format', 'ECDAA attestation is not supported');
  const data = Buffer.concat([a.authData, a.clientDataHash]);
  if (!st.has('x5c')) {
    // Self attestation: signed with the credential's own key. It proves nothing about the model.
    if (alg !== a.credAlg) fail('attestation', 'The self attestation uses another algorithm than the credential');
    if (!verifyWith(alg, a.credKey, data, sig)) fail('attestation_signature', 'The attestation signature is not valid');
    return { fmt: 'packed', type: 'self', aaguid: W.aaguidString(a.ad.aaguid), x5c: [] };
  }
  const x5c = x5cOf(st);
  const leaf = x509(x5c[0]);
  if (!verifyWith(alg, leaf.publicKey, data, sig)) fail('attestation_signature', 'The attestation signature is not valid');
  const d = certDetails(x5c[0]);
  const s = subjectFields(leaf);
  if (d.version !== 3) fail('attestation_cert', 'The attestation certificate is not an X.509 version 3 certificate');
  if (!/^[A-Z]{2}$/.test(s.C || '') || !s.O || s.OU !== 'Authenticator Attestation' || !s.CN) fail('attestation_cert', 'The attestation certificate\'s subject is not an authenticator attestation subject (C, O, OU "Authenticator Attestation", CN)');
  if (leaf.ca) fail('attestation_cert', 'The attestation certificate is a certificate authority');
  checkAaguidExtension(d, a.ad.aaguid);
  return { fmt: 'packed', type: 'basic', aaguid: W.aaguidString(a.ad.aaguid), x5c };
}

function fidoU2f(a) {
  const st = a.attStmt; const sig = st.get('sig');
  const x5c = x5cOf(st, { max: 1 });
  if (!Buffer.isBuffer(sig)) fail('attestation', 'The fido-u2f attestation statement is not understood');
  const leaf = x509(x5c[0]);
  const k = leaf.publicKey;
  if (k.asymmetricKeyType !== 'ec' || (k.asymmetricKeyDetails || {}).namedCurve !== 'prime256v1') fail('attestation_cert', 'A fido-u2f attestation certificate must have a P-256 key');
  const cose = a.ad.coseKey;
  if (a.credAlg !== W.ALGS.ES256) fail('attestation', 'A fido-u2f credential must be ES256');
  const x = cose.get(-2); const y = cose.get(-3);
  const data = Buffer.concat([Buffer.from([0x00]), a.ad.rpIdHash, a.clientDataHash, a.ad.credentialId, Buffer.from([0x04]), x, y]);
  if (!verifyWith(-7, k, data, sig)) fail('attestation_signature', 'The attestation signature is not valid');
  // A U2F authenticator has no AAGUID: it is the all-zero one, and the Metadata Service names it by its key identifier.
  return { fmt: 'fido-u2f', type: 'basic', aaguid: ZERO_AAGUID, keyId: keyIdentifier(leaf), x5c };
}

// TPM 2.0 structures (TCG TPM 2.0 Library, Part 2): what WebAuthn §8.3 needs of them.
const TPM_ALG = { RSA: 0x0001, ECC: 0x0023, SHA1: 0x0004, SHA256: 0x000b, SHA384: 0x000c, SHA512: 0x000d };
const TPM_HASH = { [TPM_ALG.SHA256]: 'sha256', [TPM_ALG.SHA384]: 'sha384', [TPM_ALG.SHA512]: 'sha512' };
const TPM_CURVES = { 0x0003: [1, 32], 0x0004: [2, 48], 0x0005: [3, 66] }; // TPM_ECC_NIST_P256/384/521 → COSE crv, bytes
function tpmReader(buf, what) {
  let p = 0;
  const need = (n) => { if (p + n > buf.length) fail('attestation', `The TPM ${what} ends early`); };
  return {
    u8() { need(1); return buf[p++]; }, u16() { need(2); const v = buf.readUInt16BE(p); p += 2; return v; }, u32() { need(4); const v = buf.readUInt32BE(p); p += 4; return v; },
    bytes(n) { need(n); const v = buf.subarray(p, p + n); p += n; return v; }, sized() { return this.bytes(this.u16()); },
    done() { if (p !== buf.length) fail('attestation', `The TPM ${what} has bytes left over`); },
  };
}
function parsePubArea(buf) {
  const r = tpmReader(buf, 'public area');
  const out = { type: r.u16(), nameAlg: r.u16(), objectAttributes: r.u32(), authPolicy: r.sized() };
  if (out.type === TPM_ALG.RSA) { out.symmetric = r.u16(); out.scheme = r.u16(); out.keyBits = r.u16(); out.exponent = r.u32(); out.unique = r.sized(); }
  else if (out.type === TPM_ALG.ECC) { out.symmetric = r.u16(); out.scheme = r.u16(); out.curveId = r.u16(); out.kdf = r.u16(); out.x = r.sized(); out.y = r.sized(); }
  else fail('attestation', 'The TPM key is neither RSA nor ECC');
  r.done();
  return out;
}
function parseCertInfo(buf) {
  const r = tpmReader(buf, 'attestation');
  const out = { magic: r.u32(), type: r.u16(), qualifiedSigner: r.sized(), extraData: r.sized() };
  r.bytes(17); r.bytes(8); // clockInfo, firmwareVersion
  out.name = r.sized(); out.qualifiedName = r.sized();
  r.done();
  return out;
}
/** The TPM's subject alternative name (a directoryName with tcg-at-tpmManufacturer, -Model, -Version). */
function tpmSan(details) {
  const ext = details.extensions.get('2.5.29.17');
  if (!ext) return null;
  const out = {};
  for (const gn of derChildren(derRead(ext.value).value)) {
    if (gn.cls !== 2 || gn.tag !== 4) continue;
    for (const rdn of derChildren(derRead(gn.value).value)) for (const atv of derChildren(rdn.value)) {
      // An AttributeTypeAndValue is SEQUENCE { type OID, value }: anything else is refused as not understood (a
      // certificate the device made up need not be well formed where OpenSSL does not look).
      const [oid, val] = derChildren(atv.value);
      if (!oid || !val || oid.tag !== 6) fail('attestation_cert', 'The TPM attestation certificate\'s subject alternative name is not understood');
      const k ={ '2.23.133.2.1': 'manufacturer', '2.23.133.2.2': 'model', '2.23.133.2.3': 'version' }[oidString(oid.value)];
      if (k) out[k] = val.value.toString('utf8');
    }
  }
  return out;
}
function tpm(a) {
  const st = a.attStmt;
  if (st.get('ver') !== '2.0') fail('attestation', 'Only TPM 2.0 attestation is supported');
  const alg = st.get('alg'); const sig = st.get('sig'); const certInfoB = st.get('certInfo'); const pubAreaB = st.get('pubArea');
  if (typeof alg !== 'number' || !Buffer.isBuffer(sig) || !Buffer.isBuffer(certInfoB) || !Buffer.isBuffer(pubAreaB)) fail('attestation', 'The TPM attestation statement is not understood');
  if (st.has('ecdaaKeyId')) fail('attestation_format', 'ECDAA attestation is not supported');
  const pub = parsePubArea(pubAreaB);
  // The key in pubArea must be the credential's.
  const cose = a.ad.coseKey;
  if (pub.type === TPM_ALG.RSA) {
    const n = cose.get(-1); const e = cose.get(-2);
    const exp = pub.exponent === 0 ? 65537 : pub.exponent;
    if (cose.get(1) !== 3 || !Buffer.isBuffer(n) || !n.equals(pub.unique) || !Buffer.isBuffer(e) || derInt(e) !== exp) fail('attestation', 'The TPM attestation is for another key than the credential');
  } else {
    const c = TPM_CURVES[pub.curveId];
    if (cose.get(1) !== 2 || !c || cose.get(-1) !== c[0] || !pub.x.equals(cose.get(-2) || Buffer.alloc(0)) || !pub.y.equals(cose.get(-3) || Buffer.alloc(0))) fail('attestation', 'The TPM attestation is for another key than the credential');
  }
  const ci = parseCertInfo(certInfoB);
  if (ci.magic !== 0xff544347) fail('attestation', 'The TPM attestation is not a TPM-generated structure');
  if (ci.type !== 0x8017) fail('attestation', 'The TPM attestation is not a certification of the key');
  const s = SIG[alg];
  if (!s || !s[0]) fail('attestation_alg', 'The TPM attestation uses a signature algorithm SUDS does not accept');
  const attToBeSigned = Buffer.concat([a.authData, a.clientDataHash]);
  if (!ci.extraData.equals(crypto.createHash(s[0]).update(attToBeSigned).digest())) fail('attestation', 'The TPM attestation is not for this registration');
  const nameHash = TPM_HASH[pub.nameAlg];
  if (!nameHash) fail('attestation_alg', 'The TPM names the key with a hash SUDS does not accept');
  if (ci.name.length < 2 || ci.name.readUInt16BE(0) !== pub.nameAlg || !ci.name.subarray(2).equals(crypto.createHash(nameHash).update(pubAreaB).digest())) fail('attestation', 'The TPM attestation names another key');
  const x5c = x5cOf(st);
  const aik = x509(x5c[0]);
  if (!verifyWith(alg, aik.publicKey, certInfoB, sig)) fail('attestation_signature', 'The attestation signature is not valid');
  // The attestation identity key's certificate (WebAuthn §8.3.1).
  const d = certDetails(x5c[0]);
  if (d.version !== 3) fail('attestation_cert', 'The TPM attestation certificate is not an X.509 version 3 certificate');
  if (!d.subjectEmpty) fail('attestation_cert', 'The TPM attestation certificate must have an empty subject');
  const san = tpmSan(d);
  if (!san || !/^id:[0-9A-F]{8}$/i.test(san.manufacturer || '') || !san.model || !san.version) fail('attestation_cert', 'The TPM attestation certificate does not name the TPM (manufacturer, model and version)');
  if (!(aik.keyUsage || []).includes('2.23.133.8.3')) fail('attestation_cert', 'The TPM attestation certificate is not for attestation identity keys (extended key usage 2.23.133.8.3)');
  if (aik.ca) fail('attestation_cert', 'The TPM attestation certificate is a certificate authority');
  checkAaguidExtension(d, a.ad.aaguid);
  return { fmt: 'tpm', type: 'attca', aaguid: W.aaguidString(a.ad.aaguid), x5c };
}

// Android Keystore key attestation: the KeyDescription extension (1.3.6.1.4.1.11129.2.1.17).
const KM_TAG = { purpose: 1, allApplications: 600, origin: 702 };
/** An AuthorizationList as { tag number → the tagged value's inner TLV }. */
function authList(node) {
  const out = new Map();
  for (const c of derChildren(node.value)) if (c.cls === 2) out.set(c.tag, derRead(c.value));
  return out;
}
function androidKey(a) {
  const st = a.attStmt; const alg = st.get('alg'); const sig = st.get('sig');
  if (typeof alg !== 'number' || !Buffer.isBuffer(sig)) fail('attestation', 'The android-key attestation statement is not understood');
  const x5c = x5cOf(st);
  const leaf = x509(x5c[0]);
  if (!verifyWith(alg, leaf.publicKey, Buffer.concat([a.authData, a.clientDataHash]), sig)) fail('attestation_signature', 'The attestation signature is not valid');
  const spki = (k) => k.export({ type: 'spki', format: 'der' });
  if (!spki(leaf.publicKey).equals(spki(a.credKey))) fail('attestation', 'The Android attestation certificate is for another key than the credential');
  const ext = certDetails(x5c[0]).extensions.get('1.3.6.1.4.1.11129.2.1.17');
  if (!ext) fail('attestation_cert', 'The Android attestation certificate has no key description');
  const kd = derChildren(derRead(ext.value).value);
  if (kd.length < 8 || kd[4].tag !== 4) fail('attestation_cert', 'The Android key description is not understood');
  if (!kd[4].value.equals(a.clientDataHash)) fail('attestation', 'The Android attestation is not for this registration');
  const sw = authList(kd[6]); const tee = authList(kd[7]);
  if (sw.has(KM_TAG.allApplications) || tee.has(KM_TAG.allApplications)) fail('attestation', 'The Android key may be used by every app on the device');
  // Held by the secure hardware (teeEnforced), generated there, and for signing: a key only software vouches for is refused.
  const origin = tee.get(KM_TAG.origin);
  if (!origin || derInt(origin.value) !== 0) fail('attestation', 'The Android key was not generated in the device\'s secure hardware');
  const purpose = tee.get(KM_TAG.purpose);
  if (!purpose || !derChildren(purpose.value).some((p) => derInt(p.value) === 2)) fail('attestation', 'The Android key is not a signing key held by the secure hardware');
  return { fmt: 'android-key', type: 'basic', aaguid: W.aaguidString(a.ad.aaguid), x5c };
}

const FORMATS = { packed, 'fido-u2f': fidoU2f, tpm, 'android-key': androidKey };
const SUPPORTED_FORMATS = Object.keys(FORMATS);

/**
 * Verify an attestation statement (the attestation object's fmt and attStmt, the authenticator data it came with and
 * the client data's hash). `none` returns { type: 'none' }; a format SUDS does not verify throws 'attestation_format'.
 * Otherwise { fmt, type ('basic', 'attca' or 'self'), aaguid, keyId? (fido-u2f), x5c (DER Buffers, leaf first) }:
 * the signature checked and the certificate's requirements met. The chain to a trusted root is verifyChain's.
 */
function verifyAttestation({ fmt, attStmt, authData, clientDataHash }) {
  const ad = W.parseAuthData(authData);
  if (!ad.credentialId) fail('authdata', 'The authenticator did not return a new credential');
  const k = W.coseToKey(ad.coseKey);
  if (fmt === 'none') return { fmt: 'none', type: 'none', aaguid: W.aaguidString(ad.aaguid), x5c: [] };
  const f = FORMATS[fmt];
  if (!f) fail('attestation_format', `This authenticator's attestation format (${String(fmt).slice(0, 30)}) is not one SUDS can verify (${SUPPORTED_FORMATS.join(', ')})`);
  if (!(attStmt instanceof Map)) fail('attestation', 'The attestation statement is not understood');
  return f({ attStmt, authData, clientDataHash, ad, credAlg: k.alg, credKey: k.key });
}

// ---- the FIDO Metadata Service BLOB ----
const b64urlJson = (s, what) => { try { return JSON.parse(W.fromB64url(s).toString('utf8')); } catch { return fail('mds', `The metadata file's ${what} is not JSON`); } };
const AAGUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Today as YYYY-MM-DD (UTC): nextUpdate is a date. */
const isoDay = (d) => d.toISOString().slice(0, 10);
/** Whether a BLOB whose nextUpdate is `nextUpdate` is past it on `now`: the next one is out, and this one is stale. */
function mdsExpired(nextUpdate, now = new Date()) { return !nextUpdate || isoDay(now) > String(nextUpdate); }

/**
 * Verify a Metadata Service BLOB (a JWS in compact form, as downloaded from https://mds3.fidoalliance.org/) and keep
 * what SUDS needs of it. The header's x5c chain must lead to one of `roots` (FIDO_MDS_ROOT_PEM in production), its
 * first certificate must be for mds.fidoalliance.org, its signature (RS256, ES256 or PS256) must verify, and its
 * nextUpdate must not have passed. Returns { no, nextUpdate, legalHeader, entries: [{ aaguid, keyIds, description,
 * roots (base64 DER), statuses: [{ status, effectiveDate }], attestationTypes }] }, only entries with an AAGUID or
 * attestation key identifiers (FIDO2 and U2F; UAF-only ones are left out).
 */
function verifyMdsBlob(jwt, { roots, now = new Date(), signerHost = MDS_SIGNER_HOST } = {}) {
  if (typeof jwt !== 'string') fail('mds', 'The metadata file is not text');
  const parts = jwt.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) fail('mds', 'The metadata file is not a FIDO Metadata Service BLOB (a signed JWT)');
  const header = b64urlJson(parts[0], 'header');
  if (!['RS256', 'ES256', 'PS256'].includes(header.alg)) fail('mds', 'The metadata file is signed with an algorithm SUDS does not accept');
  if (!Array.isArray(header.x5c) || !header.x5c.length || header.x5c.length > 5 || !header.x5c.every((c) => typeof c === 'string')) fail('mds', 'The metadata file has no certificate chain');
  const chain = header.x5c.map((c) => Buffer.from(c, 'base64'));
  verifyChain(chain, roots, { now, code: 'mds_chain', what: 'The metadata file\'s signing certificate' });
  const signer = x509(chain[0], 'The metadata file\'s signing certificate');
  if (!signer.checkHost(signerHost, { subject: 'default' })) fail('mds_chain', `The metadata file is not signed by the FIDO Metadata Service (${signerHost})`);
  const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
  const sig = W.fromB64url(parts[2]);
  let good = false;
  try {
    if (header.alg === 'RS256') good = crypto.verify('sha256', data, { key: signer.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
    else if (header.alg === 'PS256') good = crypto.verify('sha256', data, { key: signer.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
    else good = crypto.verify('sha256', data, { key: signer.publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  } catch { good = false; }
  if (!good) fail('mds_signature', 'The metadata file\'s signature is not valid (it was changed after it was signed, or not signed by its certificate)');
  const payload = b64urlJson(parts[1], 'contents');
  if (!payload || !Number.isInteger(payload.no) || typeof payload.nextUpdate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.nextUpdate) || !Array.isArray(payload.entries)) fail('mds', 'The metadata file\'s contents are not a Metadata Service BLOB (no, nextUpdate, entries)');
  if (mdsExpired(payload.nextUpdate, now)) fail('mds_expired', `The metadata file is out of date: its next update was due on ${payload.nextUpdate}. Download the current one from the FIDO Metadata Service.`);
  const entries = [];
  for (const e of payload.entries.slice(0, 20000)) {
    if (!e || typeof e !== 'object') continue;
    const ms = e.metadataStatement && typeof e.metadataStatement === 'object' ? e.metadataStatement : {};
    const aaguid = typeof e.aaguid === 'string' && AAGUID_RE.test(e.aaguid.toLowerCase()) ? e.aaguid.toLowerCase() : null;
    const keyIds = Array.isArray(e.attestationCertificateKeyIdentifiers) ? e.attestationCertificateKeyIdentifiers.filter((k) => typeof k === 'string' && /^[0-9a-f]{40}$/i.test(k)).map((k) => k.toLowerCase()).slice(0, 100) : [];
    if (!aaguid && !keyIds.length) continue;
    entries.push({
      aaguid, keyIds, description: String(ms.description || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
      roots: (Array.isArray(ms.attestationRootCertificates) ? ms.attestationRootCertificates : []).filter((c) => typeof c === 'string' && c.length < 20000).slice(0, 20),
      statuses: (Array.isArray(e.statusReports) ? e.statusReports : []).filter((r) => r && typeof r.status === 'string').map((r) => ({ status: r.status.slice(0, 60), effectiveDate: typeof r.effectiveDate === 'string' ? r.effectiveDate.slice(0, 10) : null })).slice(-100),
      attestationTypes: (Array.isArray(ms.attestationTypes) ? ms.attestationTypes : []).filter((t) => typeof t === 'string').slice(0, 10),
    });
  }
  return { no: payload.no, nextUpdate: payload.nextUpdate, legalHeader: typeof payload.legalHeader === 'string' ? payload.legalHeader.slice(0, 2000) : '', entries };
}
/** The status reports that refuse a model (REFUSED_STATUSES), or [] when none does. */
function refusedStatuses(statuses) { return (statuses || []).filter((s) => REFUSED_STATUSES.includes(s.status)).map((s) => s.status); }

module.exports = { FIDO_MDS_ROOT_PEM, FIDO_MDS_ROOT_SHA256, MDS_SIGNER_HOST, REFUSED_STATUSES, ZERO_AAGUID, SUPPORTED_FORMATS, AAGUID_RE,
  derRead, derChildren, oidString, certDetails, keyIdentifier, verifyChain, verifyAttestation, verifyMdsBlob, mdsExpired, refusedStatuses };

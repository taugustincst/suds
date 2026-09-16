'use strict';
// Generates a self-signed X.509 certificate (ECDSA P-256, SHA-256) using only node:crypto.
// Used by the setup wizard so non-technical installs still get HTTPS on the local network.
const crypto = require('node:crypto');

// ---- minimal DER encoder ----
function len(n) { if (n < 0x80) return Buffer.from([n]); const b = []; while (n) { b.unshift(n & 0xff); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); }
function tlv(tag, body) { return Buffer.concat([Buffer.from([tag]), len(body.length), body]); }
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (buf) => { let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]); while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); };
const bitstr = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const octstr = (buf) => tlv(0x04, buf);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const ia5 = (s) => tlv(0x16, Buffer.from(s, 'ascii'));
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);
function oid(s) { const p = s.split('.').map(Number); const out = [40 * p[0] + p[1]]; for (const v of p.slice(2)) { const b = []; let x = v; do { b.unshift(x & 0x7f); x >>= 7; } while (x); for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80; out.push(...b); } return tlv(0x06, Buffer.from(out)); }
function utcTime(d) { const p = n => String(n).padStart(2, '0'); return tlv(0x17, Buffer.from(`${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); }

const OID = { cn: '2.5.4.3', o: '2.5.4.10', ecPublicKey: '1.2.840.10045.2.1', p256: '1.2.840.10045.3.1.7', ecdsaSha256: '1.2.840.10045.4.3.2', san: '2.5.29.17', basic: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', serverAuth: '1.3.6.1.5.5.7.3.1' };

/**
 * generate({ commonName, org, hosts: ['localhost','192.168.1.5','suds.local'], days })
 * returns { key: PEM (PKCS#8), cert: PEM, expires }
 */
function generate({ commonName = 'SUDS', org = 'SUDS', hosts = ['localhost'], days = 825 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const now = new Date(); const notBefore = new Date(now.getTime() - 60_000); const notAfter = new Date(now.getTime() + days * 86400000);
  const name = seq(set(seq(oid(OID.o), utf8(org))), set(seq(oid(OID.cn), utf8(commonName))));
  const sanItems = hosts.map(h => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? ctx(7, Buffer.from(h.split('.').map(Number)), false) : ctx(2, Buffer.from(h, 'ascii'), false));
  const exts = seq(
    seq(oid(OID.basic), bool(true), octstr(seq(bool(false)))),
    seq(oid(OID.keyUsage), bool(true), octstr(tlv(0x03, Buffer.from([0x07, 0x80])))), // digitalSignature
    seq(oid(OID.extKeyUsage), octstr(seq(oid(OID.serverAuth)))),
    seq(oid(OID.san), octstr(seq(...sanItems))),
  );
  const tbs = seq(
    ctx(0, int(2)),                                  // version v3
    int(crypto.randomBytes(16)),                     // serial
    seq(oid(OID.ecdsaSha256)),                       // signature algorithm
    name,                                            // issuer (self)
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,                                            // subject
    spki,
    ctx(3, exts),
  );
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const cert = seq(tbs, seq(oid(OID.ecdsaSha256)), bitstr(sig));
  const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', cert), expires: notAfter.toISOString() };
}

module.exports = { generate };

'use strict';
// Native app distribution: the administrator uploads the built Android APK once; phones download it from the server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const audit = require('../audit');
const listener = require('../listener');
const { badRequest, notFound, HttpError } = require('../http');

const dir = () => path.join(config.dataDir, 'downloads');
const apkPath = () => path.join(dir(), 'suds.apk');
function apkInfo() {
  try { const st = fs.statSync(apkPath()); const meta = JSON.parse(fs.readFileSync(apkPath() + '.json', 'utf8')); return { available: true, size: st.size, uploaded_at: meta.uploaded_at, sha256: meta.sha256, version: meta.version }; } catch { return { available: false }; }
}
function certFingerprint() {
  try { const c = new crypto.X509Certificate(fs.readFileSync(path.join(config.dataDir, 'certs', 'suds.crt'))); return { sha256: c.fingerprint256, valid_to: c.validTo }; } catch { return null; }
}

module.exports = (r) => {
  // Public (no PHI): what a phone needs to connect and install
  r.get('/api/app/info', () => ({ name: db.getSetting('org_name', 'SUDS'), version: config.version, listener: listener.describe(), android: apkInfo(), certificate: certFingerprint(), service: '_suds._tcp' }));
  r.get('/api/app/android.apk', (ctx) => {
    if (!apkInfo().available) throw notFound('The Android app has not been uploaded yet');
    const data = fs.readFileSync(apkPath());
    ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="SUDS.apk"', 'Content-Length': data.length }); ctx.res.end(data);
  });
  r.get('/api/app/certificate.crt', (ctx) => {
    const crt = path.join(config.dataDir, 'certs', 'suds.crt'); if (!fs.existsSync(crt)) throw notFound('No certificate');
    ctx.res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="suds-certificate.crt"' }); ctx.res.end(fs.readFileSync(crt));
  });
  // Admin: upload the APK built from mobile/android (raw body)
  r.post('/api/admin/app/android', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const buf = ctx.rawBody; if (!buf || buf.length < 1000) throw badRequest('Upload the .apk file as the request body');
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw badRequest('That does not look like an APK (zip) file');
    if (buf.length > config.maxBodyBytes) throw new HttpError(413, 'APK too large');
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(apkPath(), buf, { mode: 0o600 });
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(apkPath() + '.json', JSON.stringify({ uploaded_at: db.now(), sha256, version: String(ctx.query.get('version') || config.version), by: ctx.user.id }), { mode: 0o600 });
    audit.log({ user: ctx.user, action: 'app.android.upload', ip: ctx.ip, details: { bytes: buf.length, sha256 } });
    return { ok: true, ...apkInfo() };
  });
  r.delete('/api/admin/app/android', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    try { fs.unlinkSync(apkPath()); fs.unlinkSync(apkPath() + '.json'); } catch {}
    audit.log({ user: ctx.user, action: 'app.android.remove', ip: ctx.ip });
    return { ok: true };
  });
};

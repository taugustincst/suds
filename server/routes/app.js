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
const { badRequest, notFound, unauthorized, HttpError } = require('../http');

const dir = () => path.join(config.dataDir, 'downloads');
const apkPath = () => path.join(dir(), 'suds.apk');
function apkInfo() {
  try { const st = fs.statSync(apkPath()); const meta = JSON.parse(fs.readFileSync(apkPath() + '.json', 'utf8')); return { available: true, size: st.size, uploaded_at: meta.uploaded_at, sha256: meta.sha256, version: meta.version }; } catch { return { available: false }; }
}
function certFingerprint() {
  try { const c = new crypto.X509Certificate(fs.readFileSync(path.join(config.dataDir, 'certs', 'suds.crt'))); return { sha256: c.fingerprint256, valid_to: c.validTo }; } catch { return null; }
}

module.exports = (r) => {
  // Liveness and readiness. Unauthenticated and carrying no PHI or configuration detail, so a monitor, a
  // Docker HEALTHCHECK or a county's IT can call it. /api/meta/constants only proved the listener was up;
  // this proves the database answers and reports the numbers an operator needs before disk runs out.
  r.get('/api/health', (ctx) => {
    const out = { ok: true, version: config.version, uptime_seconds: Math.round(process.uptime()) };
    try {
      out.schema_version = Number(db.getSetting('schema_version', '0'));
      out.database = db.one('SELECT 1 AS ok').ok === 1 ? 'ok' : 'unexpected';
    } catch (e) { out.ok = false; out.database = 'error'; out.error = String(e.message || e).slice(0, 200); }
    try {
      const st = fs.statSync(config.dbPath);
      out.database_bytes = st.size;
      const fsinfo = fs.statfsSync(config.dataDir);
      out.disk_free_bytes = fsinfo.bavail * fsinfo.bsize;
      // Below this a write is likely to fail mid-transaction, which is worth saying before it happens.
      if (out.disk_free_bytes < 100 * 1024 * 1024) { out.ok = false; out.warning = 'Less than 100 MB of disk space remains.'; }
    } catch { /* :memory: or a platform without statfs — liveness still stands */ }
    // The failures nobody notices until it is too late: a tampered audit chain, backups that stopped or
    // stopped verifying, and a certificate about to expire. Each one is a reason to say "not ok" to whatever
    // is watching this endpoint, with a sentence a county IT person can act on.
    const warnings = [];
    try {
      if (db.getSetting('audit_verify_failed_at', null)) warnings.push(`The audit log failed its integrity check at ${db.getSetting('audit_verify_failed_at')}. Investigate before anything else.`);
      const hours = Number(db.getSetting('backup_schedule_hours', '0')) || 0;
      const last = db.getSetting('last_scheduled_backup_at', null); const status = db.getSetting('last_scheduled_backup_status', '') || '';
      if (hours && (!last || Date.now() - Date.parse(last) > 2 * hours * 3600_000)) warnings.push(`Scheduled backups are set for every ${hours} hours but the last one ${last ? 'ran ' + last : 'has never run'}.`);
      if (hours && status && !/^ok/.test(status)) warnings.push(`The last scheduled backup reported: ${status}`);
      const crt = path.join(config.dataDir, 'certs', 'suds.crt');
      if (fs.existsSync(crt)) { const validTo = new (require('node:crypto').X509Certificate)(fs.readFileSync(crt)).validTo; const left = (Date.parse(validTo) - Date.now()) / 86400000; if (left < 14) warnings.push(`The HTTPS certificate ${left < 0 ? 'expired' : 'expires'} ${validTo}. Create a new one under Settings → Network & devices.`); }
    } catch { /* a check that cannot run must not itself take the endpoint down */ }
    if (warnings.length) { out.ok = false; out.warnings = warnings; }
    ctx.status = out.ok ? 200 : 503;
    return out;
  });

  // Off unless METRICS_TOKEN is set (server/config.js) — see server/metrics.js for what it reports and why
  // a bearer token, not the usual session cookie: a scraper has no way to sign in interactively.
  r.get('/api/metrics', (ctx) => {
    if (!config.metricsToken) throw notFound();
    const header = ctx.headers['authorization'] || '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const expected = Buffer.from(config.metricsToken), got = Buffer.from(given);
    if (given.length !== config.metricsToken.length || !crypto.timingSafeEqual(expected, got)) throw unauthorized('A valid bearer token is required');
    const body = require('../metrics').render();
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    ctx.res.end(body);
  });

  // Public (no PHI): what a phone needs to connect and install
  r.get('/api/app/info', () => ({ name: db.getSetting('org_name', 'SUDS'), version: config.version, listener: listener.describe(), android: apkInfo(), certificate: certFingerprint(), service: '_suds._tcp' }));
  r.get('/api/app/android.apk', (ctx) => {
    if (!apkInfo().available) throw notFound('The Android app has not been uploaded yet');
    const data = fs.readFileSync(apkPath());
    ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="SUDS.apk"', 'Content-Length': data.length }); ctx.res.end(data);
  });
  r.get('/api/app/certificate.crt', (ctx) => {
    const caPath = path.join(config.dataDir, 'certs', 'suds-ca.crt'); const crt = fs.existsSync(caPath) ? caPath : path.join(config.dataDir, 'certs', 'suds.crt');
    if (!fs.existsSync(crt)) throw notFound('No certificate');
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

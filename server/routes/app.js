'use strict';
// Health, metrics and what a browser needs to reach this server (addresses, certificate). The native-app
// distribution that used to live here (APK upload/download) was removed when the native apps were
// deprecated — docs/PLATFORM.md.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const listener = require('../listener');
const { notFound, unauthorized } = require('../http');

function certFingerprint() {
  try { const c = new crypto.X509Certificate(fs.readFileSync(path.join(config.dataDir, 'certs', 'suds.crt'))); return { sha256: c.fingerprint256, valid_to: c.validTo }; } catch { return null; }
}
const CERT_WARN_DAYS = 60;
// True when the request carries the METRICS_TOKEN as a bearer token (constant-time compare). Used by both
// /api/metrics and the detailed form of /api/health.
function metricsTokenPresented(ctx) {
  if (!config.metricsToken) return false;
  const header = ctx.headers['authorization'] || '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!given || given.length !== config.metricsToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(config.metricsToken), Buffer.from(given));
}

module.exports = (r) => {
  // Liveness and readiness. Unauthenticated and carrying no PHI or configuration detail, so a monitor, a
  // Docker HEALTHCHECK or a county's IT can call it. /api/meta/constants only proved the listener was up;
  // this proves the database answers and reports the numbers an operator needs before disk runs out.
  r.get('/api/health', (ctx) => {
    // Status and warnings are for any monitor. The version, schema number and disk figures describe the
    // installation (what to attack, how much it holds) and go only to an administrator's session or to a
    // caller presenting the METRICS_TOKEN — the same credential a scraper already has.
    const detailed = (ctx.user && auth.hasPerm(ctx.user, 'settings:manage') && !ctx.session?.mfa_pending) || metricsTokenPresented(ctx);
    const out = { ok: true, uptime_seconds: Math.round(process.uptime()) };
    if (detailed) out.version = config.version;
    try {
      const schema = Number(db.getSetting('schema_version', '0'));
      if (detailed) out.schema_version = schema;
      out.database = db.one('SELECT 1 AS ok').ok === 1 ? 'ok' : 'unexpected';
    } catch (e) { out.ok = false; out.database = 'error'; out.error = String(e.message || e).slice(0, 200); }
    try {
      const st = fs.statSync(config.dbPath);
      const fsinfo = fs.statfsSync(config.dataDir);
      const free = fsinfo.bavail * fsinfo.bsize;
      if (detailed) { out.database_bytes = st.size; out.disk_free_bytes = free; }
      // Below this a write is likely to fail mid-transaction, which is worth saying before it happens.
      if (free < 100 * 1024 * 1024) { out.ok = false; out.warning = 'Less than 100 MB of disk space remains.'; }
    } catch { /* :memory: or a platform without statfs — liveness still stands */ }
    // The failures nobody notices until it is too late: a tampered audit chain, backups that stopped or
    // stopped verifying, and a certificate about to expire. Each one is a reason to say "not ok" to whatever
    // is watching this endpoint, with a sentence a county IT person can act on.
    const warnings = [];
    try {
      if (db.getSetting('audit_verify_failed_at', null)) warnings.push(`The audit log failed its integrity check at ${db.getSetting('audit_verify_failed_at')}. Investigate before anything else.`);
      if (/^FAILED/.test(db.getSetting('audit_anchor_verify_status', '') || '')) warnings.push(`The audit log no longer matches the anchors written outside the database (checked ${db.getSetting('audit_anchor_verified_at')}). Investigate before anything else.`);
      const hours = Number(db.getSetting('backup_schedule_hours', '0')) || 0;
      const last = db.getSetting('last_scheduled_backup_at', null); const status = db.getSetting('last_scheduled_backup_status', '') || '';
      if (hours && (!last || Date.now() - Date.parse(last) > 2 * hours * 3600_000)) warnings.push(`Scheduled backups are set for every ${hours} hours but the last one ${last ? 'ran ' + last : 'has never run'}.`);
      if (hours && status && !/^ok/.test(status)) warnings.push(`The last scheduled backup reported: ${status}`);
      const crt = path.join(config.dataDir, 'certs', 'suds.crt');
      // Sixty days, not fourteen: renewing the self-signed certificate means re-enrolling every phone that
      // trusts the old one (docs/INSTALL.md), which takes an office more than a fortnight to get round to.
      if (fs.existsSync(crt)) { const validTo = new (require('node:crypto').X509Certificate)(fs.readFileSync(crt)).validTo; const left = (Date.parse(validTo) - Date.now()) / 86400000; if (left < CERT_WARN_DAYS) warnings.push(`The HTTPS certificate ${left < 0 ? 'expired' : 'expires'} ${validTo}. Create a new one under Settings → Network & devices.`); }
    } catch { /* a check that cannot run must not itself take the endpoint down */ }
    if (warnings.length) { out.ok = false; out.warnings = warnings; }
    ctx.status = out.ok ? 200 : 503;
    return out;
  });

  // Off unless METRICS_TOKEN is set (server/config.js) — see server/metrics.js for what it reports and why
  // a bearer token, not the usual session cookie: a scraper has no way to sign in interactively.
  r.get('/api/metrics', (ctx) => {
    if (!config.metricsToken) throw notFound();
    if (!metricsTokenPresented(ctx)) throw unauthorized('A valid bearer token is required');
    const body = require('../metrics').render();
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    ctx.res.end(body);
  });

  // What a device needs to reach this server from a browser. No PHI, but the addresses and certificate
  // fingerprint map the office network, so the full answer needs a session unless PUBLIC_APP_INFO=1;
  // anyone else gets the programme name. allow_static_sync is what a copy of the app served from a
  // static host (docs/WEB_APP.md) checks before it will sync with this server. local_mode tells the
  // /app page whether this server hands out the offline copy at all (docs/PLATFORM.md).
  r.get('/api/app/info', (ctx) => {
    const name = db.getSetting('org_name', 'SUDS');
    const authed = !!ctx.user && !ctx.session?.mfa_pending;
    if (!authed && !config.publicAppInfo) return { name, allow_static_sync: config.allowStaticSync, local_mode: config.localModeEnabled, public: false };
    return { name, version: config.version, listener: listener.describe(), certificate: certFingerprint(), service: '_suds._tcp', allow_static_sync: config.allowStaticSync, local_mode: config.localModeEnabled, public: true };
  });
  r.get('/api/app/certificate.crt', (ctx) => {
    const caPath = path.join(config.dataDir, 'certs', 'suds-ca.crt'); const crt = fs.existsSync(caPath) ? caPath : path.join(config.dataDir, 'certs', 'suds.crt');
    if (!fs.existsSync(crt)) throw notFound('No certificate');
    ctx.res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="suds-certificate.crt"' }); ctx.res.end(fs.readFileSync(crt));
  });
};

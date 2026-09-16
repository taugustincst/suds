// Local-mode configuration: keys live in this browser profile (Android WebView storage is sandboxed per app
// and protected by device encryption). They are generated on first run.
const crypto = require('./crypto.js');
// Key storage, most secure available first: Android Keystore-backed store (SudsNative.getSecret), iOS Keychain
// (window.__sudsSecrets injected at start), then browser localStorage (testing / plain browser use).
function key(name) {
  let hex = null;
  try { if (window.SudsNative && window.SudsNative.getSecret) hex = window.SudsNative.getSecret(name) || null; } catch {}
  if (!hex && window.__sudsSecrets && window.__sudsSecrets[name]) hex = window.__sudsSecrets[name];
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) { config.keySource = window.SudsNative ? 'android-keystore' : 'ios-keychain'; return Buffer.from(hex, 'hex'); }
  hex = localStorage.getItem(name); if (!hex) { hex = crypto.randomBytes(32).toString('hex'); localStorage.setItem(name, hex); }
  return Buffer.from(hex, 'hex');
}
const config = {
  version: (typeof SUDS_VERSION !== 'undefined' ? SUDS_VERSION : 'local'),
  env: 'local', isProd: true, isTest: false, local: true,
  port: 0, host: 'local', dataDir: '/local', dbPath: ':memory:', serverJsonPath: '', keysJsonPath: '', fileCfg: {}, keySource: 'device', setupComplete: true,

  tls: { cert: '', key: '', mode: 'none' },
  session: { idleMinutes: 15, absoluteHours: 12 },
  mfaRequiredRoles: [],
  password: { minLength: 12, maxAgeDays: 90 },
  lockout: { maxAttempts: 5, minutes: 15 },
  msGraph: { tenantId: '', clientId: '', clientSecret: '', user: '' },
  auditRetentionDays: 2555, maxBodyBytes: 60 * 1024 * 1024, trustProxy: false,
  saveServerJson() {},
};
config.encryptionKey = key('suds.local.enc'); config.indexKey = key('suds.local.idx');
module.exports = config;

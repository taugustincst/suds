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
  // One person, one device: there is no address to rate-limit, and the office server's per-address cap
  // must not turn into a lockout here.
  loginRateLimit: 100000,
  msGraph: { tenantId: '', clientId: '', clientSecret: '', user: '' },
  auditRetentionDays: 2555, maxBodyBytes: 60 * 1024 * 1024, maxRestoreBodyBytes: 60 * 1024 * 1024, maxJsonBodyBytes: 1024 * 1024, maxUnauthBodyBytes: 64 * 1024, trustProxy: false,
  publicAppInfo: false, allowStaticSync: false, backupKey: null,
  // Every config key the shared route code reads has to exist here, or the first route to touch it
  // fails with "Cannot read properties of undefined" on the device — the Settings tab did exactly that
  // over config.oidc. Single sign-on, the metrics endpoint, update checks and JSON logs are office-only.
  oidc: { enabled: false, label: '', issuer: '', clientId: '', clientSecret: '', redirectUri: '', scopes: '', allowedDomains: [] },
  mfaGraceDays: 14, tombstoneRetentionDays: 180, logFormat: 'text', metricsToken: '', updateFeedUrl: '',
  saveServerJson() {},
};
config.encryptionKey = key('suds.local.enc'); config.indexKey = key('suds.local.idx');
module.exports = config;

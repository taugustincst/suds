// Local-mode configuration: keys live in this browser profile's localStorage, beside the encrypted database
// (docs/HIPAA.md, risk register). They are generated on first run. The native Android Keystore / iOS
// Keychain lookups that used to come first here served the phone apps, which were removed in 1.9.3.
const crypto = require('./crypto.js');
function key(name) {
  let hex = localStorage.getItem(name); if (!hex) { hex = crypto.randomBytes(32).toString('hex'); localStorage.setItem(name, hex); }
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
  loginRateLimit: 100000, signupRateLimit: 100000,
  msGraph: { tenantId: '', clientId: '', clientSecret: '', user: '' },
  auditRetentionDays: 2555, maxBodyBytes: 60 * 1024 * 1024, maxRestoreBodyBytes: 60 * 1024 * 1024, maxJsonBodyBytes: 1024 * 1024, maxUnauthBodyBytes: 64 * 1024, trustProxy: false,
  publicAppInfo: false, allowStaticSync: false, backupKey: null,
  // The office server's switch for handing out this kernel; inside the kernel it is, by definition, running.
  localModeEnabled: true, localModeFromEnv: false,
  // Every config key the shared route code reads has to exist here, or the first route to touch it
  // fails with "Cannot read properties of undefined" on the device — the Settings tab did exactly that
  // over config.oidc. Single sign-on, the metrics endpoint, update checks and JSON logs are office-only.
  oidc: { enabled: false, label: '', issuer: '', clientId: '', clientSecret: '', redirectUri: '', scopes: '', allowedDomains: [] },
  mfaGraceDays: 14, tombstoneRetentionDays: 180, logFormat: 'text', metricsToken: '', updateFeedUrl: '',
  saveServerJson() {},
};
config.encryptionKey = key('suds.local.enc'); config.indexKey = key('suds.local.idx');
module.exports = config;

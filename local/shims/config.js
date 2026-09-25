// Local-mode configuration. The two column keys (encryptionKey for `*_enc`, indexKey for blind indexes) are
// not kept here: the kernel sets them when a device account signs in and unseals them from the vault
// (local/vault.js), and clears them when the device locks (local/kernel.js setKeys / clearKeys). Up to
// 1.11 they sat in this browser profile's localStorage in hex; the kernel reads them from there once, to
// seal an old device's database, and then erases them.
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
  auditAnchorDir: '', auditAnchorDirConfigured: false, auditAnchorHours: 0, auditSyslog: '',
  saveServerJson() {},
};
config.encryptionKey = null; config.indexKey = null;
module.exports = config;

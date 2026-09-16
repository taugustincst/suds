// Local-mode configuration: keys live in this browser profile (Android WebView storage is sandboxed per app
// and protected by device encryption). They are generated on first run.
const crypto = require('./crypto.js');
function key(name) { let hex = localStorage.getItem(name); if (!hex) { hex = crypto.randomBytes(32).toString('hex'); localStorage.setItem(name, hex); } return Buffer.from(hex, 'hex'); }
const config = {
  version: (typeof SUDS_VERSION !== 'undefined' ? SUDS_VERSION : 'local'),
  env: 'local', isProd: true, isTest: false, local: true,
  port: 0, host: 'local', dataDir: '/local', dbPath: ':memory:', serverJsonPath: '', keysJsonPath: '', fileCfg: {}, keySource: 'device', setupComplete: true,
  encryptionKey: key('suds.local.enc'), indexKey: key('suds.local.idx'),
  tls: { cert: '', key: '', mode: 'none' },
  session: { idleMinutes: 15, absoluteHours: 12 },
  mfaRequiredRoles: [],
  password: { minLength: 12, maxAgeDays: 90 },
  lockout: { maxAttempts: 5, minutes: 15 },
  msGraph: { tenantId: '', clientId: '', clientSecret: '', user: '' },
  auditRetentionDays: 2555, maxBodyBytes: 60 * 1024 * 1024, trustProxy: false,
  saveServerJson() {},
};
module.exports = config;

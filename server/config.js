'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Load .env (no dependency) — values already in process.env win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(process.cwd(), '.env'));

const env = process.env.SUDS_ENV || 'development';
const dataDir = path.resolve(process.env.SUDS_DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true });

// Key management: in production keys MUST be provided. In development we generate and persist
// keys under data/ so that a developer database stays readable across restarts.
function loadKey(envName, fileName) {
  let hex = process.env[envName];
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (hex) throw new Error(`${envName} must be 64 hex characters (32 bytes). Generate with: npm run gen-key`);
  if (env === 'production') throw new Error(`${envName} is required in production`);
  const f = path.join(dataDir, fileName);
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(f, key.toString('hex'), { mode: 0o600 });
  console.warn(`[suds] ${envName} not set; generated a development key at ${f}`);
  return key;
}

const config = {
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '127.0.0.1',
  dataDir,
  dbPath: process.env.SUDS_DB_PATH === ':memory:' ? ':memory:' : (process.env.SUDS_DB_PATH ? path.resolve(process.env.SUDS_DB_PATH) : path.join(dataDir, 'suds.db')),
  encryptionKey: env === 'test' ? crypto.createHash('sha256').update('test-enc-key').digest() : loadKey('SUDS_ENCRYPTION_KEY', '.dev-encryption-key'),
  indexKey: env === 'test' ? crypto.createHash('sha256').update('test-index-key').digest() : loadKey('SUDS_INDEX_KEY', '.dev-index-key'),
  tls: {
    cert: process.env.TLS_CERT_PATH || '',
    key: process.env.TLS_KEY_PATH || '',
  },
  session: {
    idleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 15),
    absoluteHours: Number(process.env.SESSION_ABSOLUTE_HOURS || 12),
  },
  mfaRequiredRoles: (process.env.MFA_REQUIRED_ROLES ?? 'admin,supervisor').split(',').map(s => s.trim()).filter(Boolean),
  password: { minLength: 12, maxAgeDays: 90 },
  lockout: { maxAttempts: 5, minutes: 15 },
  msGraph: {
    tenantId: process.env.MS_TENANT_ID || '',
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    user: process.env.MS_ONENOTE_USER || '',
  },
  auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS || 2555),
  maxBodyBytes: 25 * 1024 * 1024,
};

module.exports = config;

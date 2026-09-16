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

// data/server.json is written by the browser-based setup wizard so non-technical installs never touch
// environment variables. Environment variables still take precedence when set.
const serverJsonPath = path.join(dataDir, 'server.json');
let fileCfg = {};
try { if (fs.existsSync(serverJsonPath)) fileCfg = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8')); } catch (e) { console.warn('[suds] could not read server.json:', e.message); }
const keysJsonPath = path.join(dataDir, 'keys.json');
let fileKeys = {};
try { if (fs.existsSync(keysJsonPath)) fileKeys = JSON.parse(fs.readFileSync(keysJsonPath, 'utf8')); } catch (e) { console.warn('[suds] could not read keys.json:', e.message); }

// Key management: in production keys MUST be provided. In development we generate and persist
// keys under data/ so that a developer database stays readable across restarts.
const keySourceHolder = { value: 'env' };
function loadKey(envName, fileName) {
  let hex = process.env[envName];
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (hex) throw new Error(`${envName} must be 64 hex characters (32 bytes). Generate with: npm run gen-key`);
  // keys.json (created by the setup wizard, mode 0600)
  const fk = fileKeys[envName];
  if (fk && /^[0-9a-fA-F]{64}$/.test(fk)) { keySourceHolder.value = 'file'; return Buffer.from(fk, 'hex'); }
  if (env === 'production') {
    // First run without environment keys: generate a key file (mode 0600) so the browser setup wizard can run.
    // The wizard reminds the administrator to back this file up.
    const key = crypto.randomBytes(32);
    fileKeys[envName] = key.toString('hex'); fileKeys.created_at = fileKeys.created_at || new Date().toISOString();
    fs.writeFileSync(keysJsonPath, JSON.stringify(fileKeys, null, 2), { mode: 0o600 });
    keySourceHolder.value = 'file';
    console.warn(`[suds] ${envName} not set; generated ${keysJsonPath}. Back this file up separately from the database.`);
    return key;
  }
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
  port: Number(process.env.PORT || fileCfg.port || 8080),
  host: process.env.HOST || fileCfg.host || '127.0.0.1',
  dataDir,
  serverJsonPath, keysJsonPath,
  fileCfg,
  setupComplete: !!fileCfg.setupComplete,
  dbPath: process.env.SUDS_DB_PATH === ':memory:' ? ':memory:' : (process.env.SUDS_DB_PATH ? path.resolve(process.env.SUDS_DB_PATH) : path.join(dataDir, 'suds.db')),
  encryptionKey: env === 'test' ? crypto.createHash('sha256').update('test-enc-key').digest() : loadKey('SUDS_ENCRYPTION_KEY', '.dev-encryption-key'),
  indexKey: env === 'test' ? crypto.createHash('sha256').update('test-index-key').digest() : loadKey('SUDS_INDEX_KEY', '.dev-index-key'),
  tls: {
    cert: process.env.TLS_CERT_PATH || (fileCfg.tls === 'selfsigned' && fs.existsSync(path.join(dataDir, 'certs', 'suds.crt')) ? path.join(dataDir, 'certs', 'suds.crt') : ''),
    key: process.env.TLS_KEY_PATH || (fileCfg.tls === 'selfsigned' && fs.existsSync(path.join(dataDir, 'certs', 'suds.key')) ? path.join(dataDir, 'certs', 'suds.key') : ''),
    mode: process.env.TLS_CERT_PATH ? 'custom' : (fileCfg.tls || 'none'),
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
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' || !!fileCfg.trustProxy,
  auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS || 2555),
  maxBodyBytes: 25 * 1024 * 1024,
};

config.keySource = keySourceHolder.value;
config.saveServerJson = (patch) => { Object.assign(fileCfg, patch); fs.writeFileSync(serverJsonPath, JSON.stringify(fileCfg, null, 2), { mode: 0o600 }); config.setupComplete = !!fileCfg.setupComplete; };
module.exports = config;

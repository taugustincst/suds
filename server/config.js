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
    // The wizard reminds the administrator to back this file up. But only on a genuinely first run: a database
    // that already exists was written with keys, and quietly minting new ones turns every record in it into
    // unreadable ciphertext while the server looks healthy -- the single easiest way for a county to lose
    // everything (a data folder copied to a new PC without its 0600 key file, say).
    const existingDb = path.join(dataDir, 'suds.db');
    if (fs.existsSync(existingDb) && fs.statSync(existingDb).size > 0) {
      throw new Error(`${envName} is not set and ${keysJsonPath} is missing, but a database already exists at ${existingDb}. It was written with keys this server does not have. Restore the key backup (keys.json) saved at setup, or set the keys in the environment -- do not start with new keys, which would make every record unreadable.`);
    }
    const key = crypto.randomBytes(32);
    fileKeys[envName] = key.toString('hex'); fileKeys.created_at = fileKeys.created_at || new Date().toISOString();
    fs.writeFileSync(keysJsonPath, JSON.stringify(fileKeys, null, 2), { mode: 0o600 });
    keySourceHolder.value = 'file';
    console.warn(`[suds] ${envName} not set; generated ${keysJsonPath}. Back this file up separately from the database.`);
    return key;
  }
  const f = path.join(dataDir, fileName);
  keySourceHolder.value = 'devfile';
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(f, key.toString('hex'), { mode: 0o600 });
  console.warn(`[suds] ${envName} not set; generated a development key at ${f}`);
  return key;
}

/** LOCAL_MODE_ENABLED / server.json localModeEnabled: on only when explicitly true. Unset means off. */
function parseLocalMode(v) { return ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase()); }

const config = {
  version: require('../package.json').version,
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
  // Every role by default: a navigator's caseload is as much PHI as an administrator's console. Narrow it
  // only with a documented reason (and see docs/HIPAA.md).
  mfaRequiredRoles: (process.env.MFA_REQUIRED_ROLES ?? 'admin,supervisor,clinician,navigator,finance,readonly').split(',').map(s => s.trim()).filter(Boolean),
  // Days a new account in one of those roles has to enrol before it is locked out of everything but the
  // enrolment screens. Set to 0 to require it immediately.
  mfaGraceDays: Number(process.env.MFA_GRACE_DAYS ?? 14),
  password: { minLength: 12, maxAgeDays: 90 },
  lockout: { maxAttempts: 5, minutes: 15 },
  // Sign-in attempts allowed per source address per 15 minutes. A whole office behind one NAT address
  // shares this, so it is a knob; the test suite raises it because every script signs in afresh.
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT ?? (env === 'test' ? 100000 : 20)),
  // Account requests (POST /api/auth/signup) per address per hour. Every attempt counts, accepted or not:
  // the form is open to anyone who can reach the sign-in page.
  signupRateLimit: Number(process.env.SIGNUP_RATE_LIMIT ?? 5),
  msGraph: {
    tenantId: process.env.MS_TENANT_ID || '',
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    user: process.env.MS_ONENOTE_USER || '',
  },
  // Optional OIDC single sign-on against the county's identity provider (Entra ID, Okta, Keycloak, ...).
  // One issuer per server — an account is linked to it by an administrator (see server/routes/users.js),
  // never auto-created by a login, so OIDC can only ever sign in to an account that already exists here.
  oidc: {
    issuer: (process.env.OIDC_ISSUER || '').replace(/\/$/, ''),
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.OIDC_REDIRECT_URI || '',
    label: process.env.OIDC_LABEL || 'Sign in with county SSO',
  },
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' || !!fileCfg.trustProxy,
  // A restore uploads a whole database as base64 through the browser; the ordinary body cap (60 MB) fits
  // roughly a 45 MB database. Larger ones go through here, or through scripts/backup.js --restore on the
  // server itself, which has no such limit.
  maxRestoreBodyBytes: Number(process.env.SUDS_MAX_RESTORE_BYTES || 600 * 1024 * 1024),
  // Off by default: nothing calls out to check for updates unless this is set and an administrator clicks
  // "Check for updates" (server/update.js). A GitHub releases API URL, e.g.
  // https://api.github.com/repos/<owner>/<repo>/releases/latest — or an internal mirror for an air-gapped county.
  updateFeedUrl: process.env.UPDATE_FEED_URL || '',
  // Off by default: GET /api/metrics answers 404 unless this is set, and requires it as a bearer token
  // when it is (no PHI in it, but row counts and session activity are not for just anyone who can reach the
  // server). Lets a county's existing Prometheus/Grafana/etc. stack scrape SUDS without a new dependency.
  metricsToken: process.env.METRICS_TOKEN || '',
  // 'json' emits newline-delimited JSON to both stdout and the log file (server/log.js), for a log
  // collector (Loki, CloudWatch, ELK); the default is the existing human-readable text.
  logFormat: process.env.LOG_FORMAT === 'json' ? 'json' : 'text',
  // Audit entries are kept for the full HIPAA seven years, then purged; the chain stays verifiable because a
  // purge records the hash it continues from.
  auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS || 2555),
  // How long deletions are remembered for devices that have been away. A device offline longer than this
  // is sent for a full resync rather than being left holding rows the office deleted.
  tombstoneRetentionDays: Number(process.env.TOMBSTONE_RETENTION_DAYS || 180),
  // Request body caps, chosen per route in server/app.js (bodyLimit): the large one only for the file
  // routes and only behind a session, the JSON one for every other signed-in request, and the small one
  // for anything reachable without a session — sign-in, setup, health.
  maxBodyBytes: 60 * 1024 * 1024,
  maxJsonBodyBytes: 1024 * 1024,
  maxUnauthBodyBytes: 64 * 1024,
  // What /api/app/info tells a caller who is not signed in. Off by default: the listener's addresses, the
  // certificate fingerprint describe the office network to anyone who can reach the port. The /app page
  // still works for a signed-in browser, and a county that wants the page to answer with no account can
  // set PUBLIC_APP_INFO=1.
  publicAppInfo: process.env.PUBLIC_APP_INFO === '1' || process.env.PUBLIC_APP_INFO === 'true',
  // Whether a copy of the web app served from somewhere other than this server (the GitHub Pages
  // demo build, say) may sync with it. Off by default: a static host nobody in the county controls is
  // not somewhere client records should be typed in, and the sync code on such a build refuses an office
  // address unless /api/app/info here says allow_static_sync is true.
  allowStaticSync: process.env.ALLOW_STATIC_SYNC === '1' || process.env.ALLOW_STATIC_SYNC === 'true',
  // Backups are encrypted with a key derived from SUDS_ENCRYPTION_KEY unless SUDS_BACKUP_KEY is set,
  // which makes the backup set independent of PHI-key rotation (docs/DEPLOYMENT.md, "Key rotation runbook").
  backupKey: (() => {
    const hex = process.env.SUDS_BACKUP_KEY;
    if (!hex) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('SUDS_BACKUP_KEY must be 64 hex characters (32 bytes). Generate with: npm run gen-key');
    return Buffer.from(hex, 'hex');
  })(),
  // Whether this server hands out the browser kernel for /?local=1 (a whole copy of SUDS running in the
  // browser, with its keys in that browser's storage beside the data). Off by default: the office server is
  // the system of record (docs/PLATFORM.md), and an offline copy is something a county turns on for a
  // documented field-work need. The setup wizard asks and stores the answer in server.json
  // (localModeEnabled); LOCAL_MODE_ENABLED in the environment overrides it either way.
  localModeEnabled: parseLocalMode(process.env.LOCAL_MODE_ENABLED ? process.env.LOCAL_MODE_ENABLED : fileCfg.localModeEnabled),
  // Audit anchoring (server/audit-anchor.js): the head of the audit hash chain is sealed with the index key
  // and written, one write-once file per anchor, to this directory — every AUDIT_ANCHOR_HOURS and at every
  // scheduled backup. Point it at storage the database's administrator cannot rewrite (a WORM/immutable
  // NAS share, an object-lock bucket mounted read/append-only) so that a wholesale rewrite of the audit
  // table is detectable. Unset, anchors go to <data>/audit-anchors, which catches a rewrite of the
  // database alone but not of the whole data directory; the Security status page says which it is.
  auditAnchorDir: process.env.AUDIT_ANCHOR_DIR ? path.resolve(process.env.AUDIT_ANCHOR_DIR) : path.join(dataDir, 'audit-anchors'),
  auditAnchorDirConfigured: !!process.env.AUDIT_ANCHOR_DIR,
  auditAnchorHours: process.env.AUDIT_ANCHOR_HOURS ? Number(process.env.AUDIT_ANCHOR_HOURS) : 6,
  // Optional: also send each anchor to a syslog collector (UDP, RFC 5424), e.g. udp://siem.county.gov:514.
  auditSyslog: process.env.AUDIT_SYSLOG || '',
  // Years a discharged client's record is kept before the retention job hard-deletes it (server/retention.js).
  // Overridable per installation in Administration -> Settings (client_retention_years).
  clientRetentionYears: Number(process.env.CLIENT_RETENTION_YEARS || 7),
  // The calendar the programme runs on. A visit at 9pm on June 30th in Sacramento is June 30th to the
  // grant it is charged to, even though it is already July 1st in UTC; fiscal-period checks, expenditure
  // dates and "due today" all take the date in this zone (server/routes/budget.js localDate). Defaults to
  // the machine's own zone, which for a county server is the county's.
  orgTimezone: (() => {
    const want = process.env.ORG_TIMEZONE || fileCfg.orgTimezone || '';
    const machine = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
    if (!want) return machine || 'UTC';
    try { Intl.DateTimeFormat('en-US', { timeZone: want }); return want; }
    catch { console.warn(`[suds] ORG_TIMEZONE "${want}" is not a known IANA time zone; using ${machine || 'UTC'}`); return machine || 'UTC'; }
  })(),
};

config.oidc.enabled = !!(config.oidc.issuer && config.oidc.clientId && config.oidc.clientSecret && config.oidc.redirectUri);
config.keySource = keySourceHolder.value;
config.localModeFromEnv = !!process.env.LOCAL_MODE_ENABLED;
config.parseLocalMode = parseLocalMode;
config.saveServerJson = (patch) => { Object.assign(fileCfg, patch); fs.writeFileSync(serverJsonPath, JSON.stringify(fileCfg, null, 2), { mode: 0o600 }); config.setupComplete = !!fileCfg.setupComplete; };
module.exports = config;

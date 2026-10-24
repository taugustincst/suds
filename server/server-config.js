'use strict';
// Server configuration from the front end (1.27.0; Settings › Server configuration). Until 1.27.0 an office server took
// these only from its environment (.env, systemd credentials, Docker secrets), so an administrator could not, say, give
// the AI copilot its provider key without a shell on the machine. Each name below can now also be set by an
// administrator in the browser and is kept in server_config (migration 73): a secret encrypted (value_enc, picked up by
// key rotation like every _enc column) and never sent back to a browser, anything else in plain text.
//
// The environment still wins: a name set there is shown as "Set in the server's environment" and cannot be changed
// here, so an install that pins a value (a hardened county server, a container) keeps it pinned. What cannot be kept
// here at all is listed in ENV_ONLY with the reason: the keys that open the database cannot be stored inside it, where
// the database lives is read before it is opened, and the destinations that receive client text or audit evidence stay
// with whoever runs the machine.
//
// config.setting(name) (server/config.js) reads a name: the environment, else a row here, else undefined (the
// caller's default). Changes take effect at once unless an entry says `restart`. Every change is audited with the name
// and, for anything but a secret, the new value; a secret's value is never logged, audited or returned.
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

const GROUPS = [
  { id: 'ai', label: 'AI copilot provider', help: 'Where the AI documentation copilot sends a worker\'s text, and the credentials it uses. The copilot stays off until its agreement is recorded on the AI copilot tab.' },
  { id: 'sso', label: 'Single sign-on (OIDC)', help: 'The county\'s identity provider (Entra ID, Okta, Keycloak…). Sign-on is on when the issuer, client ID, client secret and redirect address are all set; accounts are linked to it one by one under Users & permissions.' },
  { id: 'onenote', label: 'OneNote import (Microsoft Graph)', help: 'An app registration in the county\'s Microsoft 365 tenant, for importing notes from a OneNote notebook.' },
  { id: 'monitoring', label: 'Monitoring, logs and updates', help: 'What this server tells the county\'s monitoring, and where it looks for new releases.' },
  { id: 'access', label: 'Sign-in and request limits', help: 'How many attempts and requests one address may make. Raise a limit for a day of bulk work from many desks behind one office address.' },
  { id: 'retention', label: 'Retention', help: 'How long the audit log and deletion records are kept.' },
];

const https = 'https://…';
const ENTRIES = [
  { name: 'SUDS_AI_PROVIDER', group: 'ai', label: 'AI provider', type: 'enum', default: 'anthropic', options: [['anthropic', 'Anthropic (Claude API)'], ['bedrock', 'Amazon Bedrock'], ['vertex', 'Google Cloud Vertex AI']], help: 'The service the copilot\'s requests go to. The agreement recorded on the AI copilot tab must be with this provider.' },
  { name: 'ANTHROPIC_API_KEY', group: 'ai', label: 'Anthropic API key', type: 'secret', sensitive: true, provider: 'anthropic', placeholder: 'sk-ant-…', help: 'From console.anthropic.com › API keys. Used only for the copilot\'s requests.' },
  { name: 'AWS_ACCESS_KEY_ID', group: 'ai', label: 'AWS access key ID', type: 'text', sensitive: true, provider: 'bedrock', maxLen: 128, help: 'An IAM user or role allowed to call bedrock:InvokeModel, and nothing else.' },
  { name: 'AWS_SECRET_ACCESS_KEY', group: 'ai', label: 'AWS secret access key', type: 'secret', sensitive: true, provider: 'bedrock' },
  { name: 'AWS_REGION', group: 'ai', label: 'AWS region', type: 'text', provider: 'bedrock', maxLen: 40, placeholder: 'us-west-2', pattern: /^[a-z]{2}(-gov)?-[a-z]+-\d$/, patternHelp: 'a region such as us-west-2' },
  { name: 'SUDS_AI_VERTEX_CREDENTIALS', group: 'ai', label: 'Google service account key (JSON)', type: 'secret', json: true, sensitive: true, provider: 'vertex', help: 'The whole key file a Google Cloud service account gives you, pasted in. In the environment it is a file path instead (GOOGLE_APPLICATION_CREDENTIALS), which wins when set.' },
  { name: 'SUDS_AI_VERTEX_PROJECT', group: 'ai', label: 'Google Cloud project', type: 'text', provider: 'vertex', maxLen: 100, help: 'Taken from the service account key when blank.' },
  { name: 'SUDS_AI_VERTEX_REGION', group: 'ai', label: 'Vertex AI region', type: 'text', provider: 'vertex', maxLen: 40, placeholder: 'us-east5' },
  { name: 'SUDS_AI_TIMEOUT_MS', group: 'ai', label: 'Longest wait for a draft (seconds)', type: 'number', scale: 1000, min: 10, max: 600, default: 180, help: 'A long transcript can take minutes. The draft is refused, and nothing is kept, if it takes longer.' },

  { name: 'OIDC_ISSUER', group: 'sso', label: 'Issuer address', type: 'url', sensitive: true, placeholder: 'https://login.microsoftonline.com/<tenant>/v2.0' },
  { name: 'OIDC_CLIENT_ID', group: 'sso', label: 'Client ID', type: 'text', sensitive: true, maxLen: 200 },
  { name: 'OIDC_CLIENT_SECRET', group: 'sso', label: 'Client secret', type: 'secret', sensitive: true },
  { name: 'OIDC_REDIRECT_URI', group: 'sso', label: 'Redirect address', type: 'url', sensitive: true, placeholder: 'https://suds.county.gov/api/auth/oidc/callback', help: 'This server\'s address followed by /api/auth/oidc/callback, registered with the identity provider exactly as written here.' },
  { name: 'OIDC_LABEL', group: 'sso', label: 'Sign-in button text', type: 'text', maxLen: 60, default: 'Sign in with county SSO' },

  { name: 'MS_TENANT_ID', group: 'onenote', label: 'Tenant ID', type: 'text', maxLen: 100 },
  { name: 'MS_CLIENT_ID', group: 'onenote', label: 'Client ID', type: 'text', maxLen: 100 },
  { name: 'MS_CLIENT_SECRET', group: 'onenote', label: 'Client secret', type: 'secret', sensitive: true },
  { name: 'MS_ONENOTE_USER', group: 'onenote', label: 'Mailbox whose notebooks are read', type: 'text', maxLen: 200, placeholder: 'notes@county.gov' },

  { name: 'METRICS_TOKEN', group: 'monitoring', label: 'Metrics token', type: 'secret', sensitive: true, help: 'Turns on GET /api/metrics for a Prometheus or Grafana scraper, which sends it as a bearer token. Row counts and session activity, never client data. Blank: metrics are off.' },
  { name: 'AUDIT_SYSLOG', group: 'monitoring', label: 'Audit anchors to syslog', type: 'text', sensitive: true, maxLen: 300, placeholder: 'udp://siem.county.gov:514', pattern: /^udp:\/\/[^\s/:]+(:\d{1,5})?$/, patternHelp: 'udp://host:port', help: 'Each seal of the audit log (no client data) is also sent to this collector, so a rewrite of the log here is visible there.' },
  { name: 'AUDIT_ANCHOR_HOURS', group: 'monitoring', label: 'Seal the audit log every (hours)', type: 'number', min: 1, max: 24, default: 1, restart: true },
  { name: 'UPDATE_FEED_URL', group: 'monitoring', label: 'Where to check for updates', type: 'url', placeholder: 'https://api.github.com/repos/<owner>/<repo>/releases/latest', help: 'Nothing is checked until an administrator chooses Check for updates on System & backups. Blank: no checking.' },
  { name: 'LOG_FORMAT', group: 'monitoring', label: 'Log format', type: 'enum', default: 'text', options: [['text', 'Plain text'], ['json', 'JSON lines, for a log collector']], restart: true },

  { name: 'LOGIN_RATE_LIMIT', group: 'access', label: 'Failed sign-ins per name, per address, per 15 minutes', type: 'number', min: 3, max: 1000, default: 20 },
  { name: 'LOGIN_IP_RATE_LIMIT', group: 'access', label: 'Failed sign-ins per address, any name, per 15 minutes', type: 'number', min: 10, max: 100000, default: 200 },
  { name: 'API_RATE_LIMIT', group: 'access', label: 'Requests per address per minute', type: 'number', min: 60, max: 100000, default: 600 },
  { name: 'SIGNUP_RATE_LIMIT', group: 'access', label: 'Account requests per address per hour', type: 'number', min: 1, max: 1000, default: 5 },
  { name: 'PUBLIC_APP_INFO', group: 'access', label: 'Show this server\'s addresses on the /app page to anyone', type: 'bool', default: false, sensitive: true, help: 'Off: only a signed-in browser sees the listener\'s addresses and certificate fingerprint.' },
  { name: 'ALLOW_STATIC_SYNC', group: 'access', label: 'Let copies of the web app served elsewhere sync with this server', type: 'bool', default: false, sensitive: true, help: 'Off: only the web app this server serves may sync with it. A copy on a host nobody in the county controls is not somewhere client records should be typed in.' },

  { name: 'AUDIT_RETENTION_DAYS', group: 'retention', label: 'Keep audit entries for (days)', type: 'number', min: 2190, max: 36500, default: 2555, sensitive: true, help: 'Never less than six years (HIPAA documentation retention); seven by default.' },
  { name: 'TOMBSTONE_RETENTION_DAYS', group: 'retention', label: 'Remember deletions for devices for (days)', type: 'number', min: 30, max: 3650, default: 180, help: 'A device away longer than this is sent for a full resync.' },
];
const BY_NAME = new Map(ENTRIES.map((e) => [e.name, e]));

// Kept in the environment, with why. Shown read-only, so an administrator sees what is there without a shell.
const ENV_ONLY = [
  { names: ['SUDS_ENCRYPTION_KEY', 'SUDS_INDEX_KEY', 'SUDS_BACKUP_KEY', 'SUDS_SIGNING_KEY'], label: 'Encryption, index, backup and signing keys', reason: 'They open the database and its backups, so they cannot be kept inside it. They are set at install (keys.json or the environment); System & backups downloads their backup.' },
  { names: ['SUDS_DATA_DIR', 'SUDS_DB_PATH'], label: 'Where the database lives', reason: 'Read before the database is opened.' },
  { names: ['PORT', 'HOST', 'TLS_CERT_PATH', 'TLS_KEY_PATH', 'TRUST_PROXY'], label: 'Listening address and HTTPS certificate', reason: 'Set on Network & devices (saved beside the database, applied at restart), or in the environment.' },
  { names: ['SUDS_AI_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS'], label: 'Another endpoint for the AI provider; a key file path', reason: 'Where client text is sent stays with whoever runs the machine: a signed-in account alone cannot point the copilot elsewhere.' },
  { names: ['AUDIT_ANCHOR_DIR', 'SUDS_COMPLIANCE_DIR', 'SUDS_COMPLIANCE_PUBLIC_KEY_FILE'], label: 'Audit seals and compliance reports', reason: 'Kept outside the reach of the SUDS service on purpose, so the service cannot rewrite the evidence about itself.' },
  { names: ['HTTPS_PROXY', 'NODE_USE_ENV_PROXY'], label: 'Outbound proxy', reason: 'Read by Node.js when the server starts.' },
  { names: ['SUDS_ENV'], label: 'Environment (production or development)', reason: 'Decides how the server starts.' },
];

// ---------------------------------------------------------------- reading
let cache = null, cacheFor = null; // name -> { value, updated_at, updated_by } (secrets decrypted), read once per change
function rows() {
  // Kept for the database it was read from: a restore, or a test's fresh database, is another handle.
  const handle = db.get();
  if (cache && cacheFor === handle) return cache;
  cacheFor = handle;
  const m = new Map();
  for (const r of db.all(`SELECT name, value, value_enc, updated_by, updated_at FROM server_config`)) {
    let value = r.value;
    if (r.value_enc) { try { value = decrypt(r.value_enc); } catch { value = null; } }
    m.set(r.name, { value, updated_by: r.updated_by, updated_at: r.updated_at });
  }
  cache = m;
  return m;
}
/** The value set here for `name`, or undefined. Never throws: before the database is open there is nothing set here. */
function storedValue(name) {
  if (!BY_NAME.has(name)) return undefined;
  // Only from a database already open: reading a setting must never open (and so migrate) one, as db.all would.
  if (!db.isOpen()) return undefined;
  try { const r = rows().get(name); return r && r.value !== null && r.value !== '' ? r.value : undefined; } catch { return undefined; }
}
const envSet = (name) => { const config = require('./config'); return config.envHas(name); };

/** What Settings › Server configuration shows: every entry, where its value comes from, never a secret's value. */
function list() {
  const set = rows();
  const users = new Map(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name]));
  return {
    groups: GROUPS,
    entries: ENTRIES.map((e) => {
      const fromEnv = envSet(e.name);
      const row = set.get(e.name);
      const here = !!(row && row.value !== null && row.value !== '');
      const out = {
        name: e.name, group: e.group, label: e.label, type: e.type, help: e.help || null, options: e.options ? e.options.map(([value, label]) => ({ value, label })) : null,
        min: e.min ?? null, max: e.max ?? null, placeholder: e.placeholder || null, restart: !!e.restart, sensitive: !!e.sensitive, provider: e.provider || null,
        default: e.default ?? null, source: fromEnv ? 'environment' : here ? 'here' : 'default',
        updated_at: here ? row.updated_at : null, updated_by: here ? (users.get(row.updated_by) || null) : null,
      };
      // A secret is only ever "set" or not. So is any sensitive setting the environment sets (an access key ID, an
      // identity provider): what the machine was given is not shown to a browser; what was set here is.
      if (e.type === 'secret' || (fromEnv && e.sensitive)) out.set = fromEnv || here;
      if (e.type !== 'secret') {
        const config = require('./config');
        const v = fromEnv ? (e.sensitive ? null : config.envValue(e.name)) : here ? row.value : null;
        out.value = v === null || v === undefined ? null : shown(e, v);
      }
      return out;
    }),
    env_only: ENV_ONLY.map((x) => ({ label: x.label, reason: x.reason, names: x.names.map((n) => ({ name: n, set: envSet(n) })) })),
  };
}
const shown = (e, v) => (e.type === 'number' ? Number(v) / (e.scale || 1) : e.type === 'bool' ? v === '1' || v === 'true' : v);

// ---------------------------------------------------------------- changing
const problem = (msg) => Object.assign(new Error(msg), { status: 400 });
/** The stored form of `raw` for entry `e`, or throws a 400 saying what is wrong. */
function normalise(e, raw) {
  if (e.type === 'bool') { if (typeof raw !== 'boolean') throw problem(`${e.label}: choose on or off`); return raw ? '1' : '0'; }
  if (e.type === 'number') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < e.min || n > e.max) throw problem(`${e.label} must be a whole number from ${e.min} to ${e.max}`);
    return String(n * (e.scale || 1));
  }
  if (typeof raw !== 'string') throw problem(`${e.label} must be text`);
  const v = raw.trim();
  if (!v) throw problem(`${e.label} is empty: to go back to the default, remove it instead`);
  if (e.type === 'enum') { if (!e.options.some(([o]) => o === v)) throw problem(`${e.label} must be one of ${e.options.map(([o]) => o).join(', ')}`); return v; }
  if (e.type === 'url') {
    let u; try { u = new URL(v); } catch { throw problem(`${e.label} must be a web address (https://…)`); }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !require('./config').isProd)) throw problem(`${e.label} must start with https://`);
    if (u.username || u.password) throw problem(`${e.label} must not contain a user name or password`);
    if (v.length > 500) throw problem(`${e.label} is too long`);
    return v.replace(/\/+$/, '');
  }
  if (e.type === 'secret') {
    if (v.length > (e.json ? 20000 : 4000)) throw problem(`${e.label} is too long`);
    if (/\s/.test(v) && !e.json) throw problem(`${e.label} must not contain spaces or line breaks`);
    if (e.json) { let j; try { j = JSON.parse(v); } catch { throw problem(`${e.label} must be the key file's JSON`); } if (!j || !j.client_email || !j.private_key) throw problem(`${e.label} has no client_email or private_key: paste the whole key file`); }
    return v;
  }
  if (v.length > (e.maxLen || 200)) throw problem(`${e.label} is too long`);
  if (e.pattern && !e.pattern.test(v)) throw problem(`${e.label} must be ${e.patternHelp}`);
  return v;
}
/** Throws (400, 404 or 409) unless `raw` may be set for `name` now; returns the entry. Writes nothing. */
function check(name, raw) {
  const e = BY_NAME.get(name); if (!e) throw Object.assign(new Error('No such setting'), { status: 404 });
  if (envSet(name)) throw Object.assign(new Error(`${e.label} is set in the server's environment (${name}), which wins: change it there, or remove it there to set it here`), { status: 409 });
  normalise(e, raw);
  return e;
}
/** Set `name` to `raw` (the form's value) for `user`. Returns { name, value? } (never a secret's value). */
function set(name, raw, user) {
  const e = check(name, raw);
  const v = normalise(e, raw);
  const secret = e.type === 'secret';
  db.run(`INSERT INTO server_config(name, value, value_enc, updated_by, updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(name) DO UPDATE SET value=excluded.value, value_enc=excluded.value_enc, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  name, secret ? null : v, secret ? encrypt(v) : null, user.id, db.now());
  cache = null;
  return secret ? { name } : { name, value: shown(e, v) };
}
/** Remove what was set here for `name` (its default, or the environment's, applies again). True if there was one. */
function clear(name) {
  if (!BY_NAME.has(name)) throw Object.assign(new Error('No such setting'), { status: 404 });
  const had = !!db.one(`SELECT 1 FROM server_config WHERE name=?`, name);
  db.run(`DELETE FROM server_config WHERE name=?`, name);
  cache = null;
  return had;
}
/** After a restore or a key rotation the rows may have changed under the cache. */
function forget() { cache = null; }

module.exports = { GROUPS, ENTRIES, ENV_ONLY, entry: (n) => BY_NAME.get(n) || null, storedValue, list, check, set, clear, forget };

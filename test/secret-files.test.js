'use strict';
// Secrets from files (server/config.js envSecret): every key and secret can be given as <NAME>_FILE — Docker
// and Kubernetes secrets, systemd LoadCredential= — or found in $CREDENTIALS_DIRECTORY under its lower-case
// name, and is then never copied into the process environment. <NAME> itself wins. Each case is a fresh
// production-mode process, since config.js reads its environment once.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-secret-files-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const hex = () => crypto.randomBytes(32).toString('hex');
let n = 0;

/** Load server/config.js in production with `env`; report what it resolved (fingerprints only) and what process.env holds. */
function load(env) {
  const data = path.join(tmp, `data${++n}`); fs.mkdirSync(data);
  const code = `
    const c = require(${JSON.stringify(path.join(REPO, 'server/config.js'))});
    const fp = (b) => b ? require('node:crypto').createHash('sha256').update(b).digest('hex') : null;
    process.stdout.write(JSON.stringify({ enc: fp(c.encryptionKey), idx: fp(c.indexKey), sig: fp(c.signingKey), backup: fp(c.backupKey), metrics: c.metricsToken, oidc: c.oidc.clientSecret, ai: c.ai.apiKey,
      keySource: c.keySource, signingSource: c.signingKeySource, keysJson: require('node:fs').existsSync(c.keysJsonPath),
      envHas: Object.keys(process.env).filter((k) => /^(SUDS_(ENCRYPTION|INDEX|BACKUP|SIGNING)_KEY|METRICS_TOKEN|OIDC_CLIENT_SECRET|ANTHROPIC_API_KEY)$/.test(k)) }));`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SUDS_|METRICS_TOKEN|OIDC_|ANTHROPIC_|CREDENTIALS_DIRECTORY|MS_CLIENT)/.test(k)));
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', code], { cwd: tmp, env: { ...clean, SUDS_ENV: 'production', SUDS_DATA_DIR: data, ...env }, encoding: 'utf8' });
  return { code: r.status, err: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}
const fp = (h) => crypto.createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex');
function file(name, content, mode = 0o600) { const f = path.join(tmp, `${name}-${++n}`); fs.writeFileSync(f, content, { mode }); return f; }

test('each key from a *_FILE (trailing newline allowed), and not left in the environment', () => {
  const k = { enc: hex(), idx: hex(), sig: hex(), backup: hex() };
  const r = load({ SUDS_ENCRYPTION_KEY_FILE: file('enc', k.enc + '\n'), SUDS_INDEX_KEY_FILE: file('idx', k.idx), SUDS_SIGNING_KEY_FILE: file('sig', k.sig), SUDS_BACKUP_KEY_FILE: file('bk', `${k.backup}\n`),
    METRICS_TOKEN_FILE: file('m', 'scrape-token\n'), OIDC_CLIENT_SECRET_FILE: file('o', 'oidc-secret'), ANTHROPIC_API_KEY_FILE: file('a', 'sk-test') });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.enc, fp(k.enc)); assert.equal(r.out.idx, fp(k.idx)); assert.equal(r.out.sig, fp(k.sig)); assert.equal(r.out.backup, fp(k.backup));
  assert.equal(r.out.metrics, 'scrape-token'); assert.equal(r.out.oidc, 'oidc-secret'); assert.equal(r.out.ai, 'sk-test');
  assert.equal(r.out.keySource, 'env'); assert.equal(r.out.signingSource, 'env');
  assert.equal(r.out.keysJson, false, 'no keys.json was generated');
  assert.deepEqual(r.out.envHas, [], 'no secret was copied into process.env');
});

test('systemd credentials found by name in $CREDENTIALS_DIRECTORY; the variable itself wins over a file', () => {
  const dir = path.join(tmp, 'creds'); fs.mkdirSync(dir, { mode: 0o700 });
  const k = { enc: hex(), idx: hex(), sig: hex() };
  fs.writeFileSync(path.join(dir, 'suds_encryption_key'), k.enc, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'suds_index_key'), k.idx, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'suds_signing_key'), k.sig, { mode: 0o600 });
  let r = load({ CREDENTIALS_DIRECTORY: dir });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.enc, fp(k.enc)); assert.equal(r.out.idx, fp(k.idx)); assert.equal(r.out.sig, fp(k.sig)); assert.equal(r.out.backup, null, 'absent stays absent');
  const direct = hex();
  r = load({ CREDENTIALS_DIRECTORY: dir, SUDS_ENCRYPTION_KEY: direct, SUDS_INDEX_KEY_FILE: file('idx2', k.enc) });
  assert.equal(r.out.enc, fp(direct), 'SUDS_ENCRYPTION_KEY wins');
  assert.equal(r.out.idx, fp(k.enc), 'an explicit *_FILE wins over the credentials directory');
});

test('an unreadable or malformed key file stops the start with a message that names the variable, never the value', () => {
  let r = load({ SUDS_ENCRYPTION_KEY_FILE: path.join(tmp, 'nope'), SUDS_INDEX_KEY: hex() });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /SUDS_ENCRYPTION_KEY_FILE names .*nope, which cannot be read \(ENOENT\)/);
  r = load({ SUDS_ENCRYPTION_KEY_FILE: file('short', 'abc123'), SUDS_INDEX_KEY: hex() });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /SUDS_ENCRYPTION_KEY must be 64 hex characters/);
  assert.ok(!r.err.includes('abc123'));
});

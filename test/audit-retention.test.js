'use strict';
// Audit history is HIPAA documentation (45 CFR §164.316(b)(2)): kept six years at least. A shorter
// AUDIT_RETENTION_DAYS is raised to the floor, with a warning in the log, rather than letting the hourly
// purge delete history the county must keep — and without refusing to start an existing server.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./helpers');

const root = path.join(__dirname, '..');
function freshConfig(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-ar-'));
  try {
    const childEnv = { ...process.env, SUDS_ENV: 'test', SUDS_DATA_DIR: dir, ...env };
    if (!('AUDIT_RETENTION_DAYS' in env)) delete childEnv.AUDIT_RETENTION_DAYS;
    const script = `const c = require(${JSON.stringify(path.join(root, 'server', 'config.js'))}); process.stdout.write(JSON.stringify({ days: c.auditRetentionDays, configured: c.auditRetentionDaysConfigured, min: c.AUDIT_RETENTION_MIN_DAYS }))`;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: childEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { ...JSON.parse(r.stdout), stderr: r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('AUDIT_RETENTION_DAYS below six years is raised to 2190 days with a startup warning; the server still starts', () => {
  const low = freshConfig({ AUDIT_RETENTION_DAYS: '30' });
  assert.equal(low.days, 2190); assert.equal(low.configured, 30); assert.equal(low.min, 2190);
  assert.match(low.stderr, /AUDIT_RETENTION_DAYS=30 is below .*2190/);
  const def = freshConfig({});
  assert.equal(def.days, 2555); assert.doesNotMatch(def.stderr, /AUDIT_RETENTION_DAYS/);
  const high = freshConfig({ AUDIT_RETENTION_DAYS: '3650' });
  assert.equal(high.days, 3650); assert.doesNotMatch(high.stderr, /AUDIT_RETENTION_DAYS/);
  assert.equal(freshConfig({ AUDIT_RETENTION_DAYS: '2190' }).days, 2190);
  // Not a number is not "keep nothing": the default, and a warning.
  const junk = freshConfig({ AUDIT_RETENTION_DAYS: 'seven years' });
  assert.equal(junk.days, 2555); assert.match(junk.stderr, /AUDIT_RETENTION_DAYS/);
});

before(H.start);
after(H.stop);

test('Security status: audit retention is "bad" when configured below the floor, "ok" otherwise', () => {
  const config = require('../server/config');
  const item = () => require('../server/security-status').status().items.find((i) => i.name === 'Audit retention');
  const saved = [config.auditRetentionDays, config.auditRetentionDaysConfigured];
  try {
    assert.equal(item().level, 'ok');
    config.auditRetentionDaysConfigured = 30; config.auditRetentionDays = 2190;
    assert.equal(item().level, 'bad');
    assert.match(item().detail, /AUDIT_RETENTION_DAYS=30/);
  } finally { [config.auditRetentionDays, config.auditRetentionDaysConfigured] = saved; }
});

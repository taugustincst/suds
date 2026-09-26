'use strict';
// Liveness and readiness are separate from the detailed status. /api/health answers 503 for things a restart
// cannot fix (a certificate near expiry, a stopped backup schedule, a failed audit check); used as a liveness
// probe it would put the container into a restart loop. /api/health/live and /api/health/ready are what
// probes call (Dockerfile HEALTHCHECK, docker-compose, docs/DEPLOYMENT.md "Monitoring and logs").
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let c;
before(async () => { await H.start(); c = H.client(); });
after(() => H.stop());

test('live and ready answer 200 on a healthy server, unauthenticated and with no detail', async () => {
  const live = await c.get('/api/health/live');
  assert.equal(live.status, 200); assert.deepEqual(live.data, { ok: true });
  const ready = await c.get('/api/health/ready');
  assert.equal(ready.status, 200); assert.deepEqual(ready.data, { ok: true });
});

test('operational warnings make /api/health 503 but leave liveness and readiness green', async () => {
  H.db.setSetting('audit_verify_failed_at', '2026-09-01T00:00:00.000Z');
  H.db.setSetting('backup_schedule_hours', '24'); H.db.setSetting('last_scheduled_backup_at', '2026-01-01T00:00:00.000Z');
  H.db.setSetting('last_scheduled_backup_status', 'failed: disk');
  try {
    const detailed = await c.get('/api/health');
    assert.equal(detailed.status, 503, 'the detailed status still says an operator must act');
    assert.ok(detailed.data.warnings.length >= 2);
    assert.equal((await c.get('/api/health/live')).status, 200, 'a warning must not make a platform restart the process');
    assert.equal((await c.get('/api/health/ready')).status, 200, 'nor stop it taking traffic');
  } finally {
    H.db.run(`DELETE FROM settings WHERE key IN ('audit_verify_failed_at','backup_schedule_hours','last_scheduled_backup_at','last_scheduled_backup_status')`);
  }
});

test('readiness fails while a restore holds the backup lock, and recovers when it ends; liveness stays up', async () => {
  const release = require('../server/backup-lock').tryAcquire('restore');
  assert.ok(release, 'the lock was free');
  try {
    const ready = await c.get('/api/health/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.data.ok, false);
    assert.match(ready.data.reason, /restore/);
    assert.equal((await c.get('/api/health/live')).status, 200, 'a restore is not a reason to restart');
  } finally { release(); }
  assert.equal((await c.get('/api/health/ready')).status, 200);
});

test('a backup (not a restore) holding the lock does not affect readiness', async () => {
  const release = require('../server/backup-lock').tryAcquire('backup');
  try { assert.equal((await c.get('/api/health/ready')).status, 200); } finally { release(); }
});

test('readiness fails when the open database is not at this build\'s schema version', async () => {
  const was = H.db.getSetting('schema_version');
  H.db.setSetting('schema_version', String(Number(was) - 1));
  try {
    const ready = await c.get('/api/health/ready');
    assert.equal(ready.status, 503);
    assert.match(ready.data.reason, /schema/);
  } finally { H.db.setSetting('schema_version', was); }
  assert.equal((await c.get('/api/health/ready')).status, 200);
});

test('liveness fails when the database does not answer', async () => {
  const one = H.db.one;
  H.db.one = () => { throw new Error('disk I/O error'); };
  try {
    const live = await c.get('/api/health/live');
    assert.equal(live.status, 503);
    assert.deepEqual(live.data, { ok: false }, 'no error text to an unauthenticated caller');
  } finally { H.db.one = one; }
});

test('the container probes use liveness, never the detailed status', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.join(__dirname, '..');
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(docker.split('\n').find(l => l.startsWith('HEALTHCHECK')) || '', /\/api\/health\/live\b/, 'Dockerfile HEALTHCHECK');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const probe = compose.split('\n').find(l => /^\s+test:/.test(l)) || '';
  assert.match(probe, /\/api\/health\/live\b/, 'docker-compose healthcheck');
});

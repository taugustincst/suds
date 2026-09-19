'use strict';
// server/instance-lock.js: the pidfile guard that stops a second SUDS process from running against the
// same data directory and corrupting the database.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquire } = require('../server/instance-lock');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-lock-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('acquire with no data directory is a harmless no-op', () => {
  const release = acquire('');
  assert.doesNotThrow(() => release());
});

test('acquire takes the lock and writes this process\'s pid', () => {
  const d = fs.mkdtempSync(path.join(dir, 'a-'));
  const release = acquire(d);
  assert.equal(fs.readFileSync(path.join(d, '.suds.lock'), 'utf8').trim(), String(process.pid));
  release();
  assert.ok(!fs.existsSync(path.join(d, '.suds.lock')), 'release removes the lock file');
});

test('a second acquire against the same directory, while the first is still held, is refused', () => {
  const d = fs.mkdtempSync(path.join(dir, 'b-'));
  const release = acquire(d);
  try {
    // This process's own pid is, definitionally, still running — the same condition a genuinely different
    // live process would trigger.
    assert.throws(() => acquire(d), /already running against this data directory/);
  } finally { release(); }
});

test('a lock left by a process that is no longer running is taken over, not left stuck forever', () => {
  const d = fs.mkdtempSync(path.join(dir, 'c-'));
  const deadPid = 999999; // exceedingly unlikely to be a live pid on any system running this test
  fs.writeFileSync(path.join(d, '.suds.lock'), String(deadPid));
  const release = acquire(d);
  assert.equal(fs.readFileSync(path.join(d, '.suds.lock'), 'utf8').trim(), String(process.pid), 'the stale lock was overwritten with this process\'s own pid');
  release();
});

test('release is idempotent and safe to call more than once', () => {
  const d = fs.mkdtempSync(path.join(dir, 'e-'));
  const release = acquire(d);
  release();
  assert.doesNotThrow(() => release());
});

test('releasing does not remove a lock another process has since taken (double-release ordering)', () => {
  const d = fs.mkdtempSync(path.join(dir, 'f-'));
  const release1 = acquire(d);
  release1();
  // Simulate a different process taking the lock after ours released it.
  fs.writeFileSync(path.join(d, '.suds.lock'), '424242');
  release1(); // already released once; must not touch the new owner's file even if called again
  assert.equal(fs.readFileSync(path.join(d, '.suds.lock'), 'utf8').trim(), '424242');
});

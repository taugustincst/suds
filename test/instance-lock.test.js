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
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, '.suds.lock'), 'utf8')).pid, process.pid);
  release();
  assert.ok(!fs.existsSync(path.join(d, '.suds.lock')), 'release removes the lock file');
});

test('a second acquire against the same directory, while the first is still held, is refused', () => {
  const d = fs.mkdtempSync(path.join(dir, 'b-'));
  const release = acquire(d);
  try {
    // This process already holds the lock for this directory; a second acquire in the same process is refused.
    assert.throws(() => acquire(d), /already running against this data directory/);
  } finally { release(); }
});

test('a lock left by a process that is no longer running is taken over, not left stuck forever', () => {
  const d = fs.mkdtempSync(path.join(dir, 'c-'));
  const deadPid = 999999; // exceedingly unlikely to be a live pid on any system running this test
  fs.writeFileSync(path.join(d, '.suds.lock'), String(deadPid));
  const release = acquire(d);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, '.suds.lock'), 'utf8')).pid, process.pid, 'the stale lock was overwritten with this process\'s own pid');
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

// ---- Stale-lock detection that does not trust a bare pid ----
const { spawn } = require('node:child_process');
const { _internals } = require('../server/instance-lock');
const lockOf = (d) => JSON.parse(fs.readFileSync(path.join(d, '.suds.lock'), 'utf8'));

test('a lock file naming THIS process\'s pid, left by a previous run, is stale (node as PID 1 in Docker after a kill)', () => {
  // In a container node is PID 1 on every start. After SIGKILL / OOM / power loss the old .suds.lock says "1";
  // the new process is also PID 1, so "is pid 1 running?" is always yes, and the old code crash-looped forever.
  const d = fs.mkdtempSync(path.join(dir, 'self-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), String(process.pid)); // old plain-pid format
  const release = acquire(d);
  assert.equal(lockOf(d).pid, process.pid);
  release();
  // And the same in the JSON format.
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid: process.pid, bootId: _internals.bootId(), startTime: _internals.startTime(process.pid) }));
  const release2 = acquire(d);
  release2();
});

test('the lock records pid, boot id and process start time as JSON', { skip: process.platform !== 'linux' }, () => {
  const d = fs.mkdtempSync(path.join(dir, 'json-'));
  const release = acquire(d);
  const rec = lockOf(d);
  assert.equal(rec.pid, process.pid);
  assert.match(rec.bootId, /^[0-9a-f-]{36}$/);
  assert.ok(rec.startTime, 'start time recorded');
  release();
  assert.ok(!fs.existsSync(path.join(d, '.suds.lock')));
});

async function withLiveChild(fn) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  try { await fn(child.pid); } finally { child.kill('SIGKILL'); }
}

test('a lock held by a different live process (same boot, same start time) is refused', { skip: process.platform !== 'linux' }, () => withLiveChild((pid) => {
  const d = fs.mkdtempSync(path.join(dir, 'live-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid, bootId: _internals.bootId(), startTime: _internals.startTime(pid) }));
  assert.throws(() => acquire(d), /already running against this data directory/);
  // An old plain-pid lock naming a live other process is still honoured.
  fs.writeFileSync(path.join(d, '.suds.lock'), String(pid));
  assert.throws(() => acquire(d), /already running against this data directory/);
}));

test('a lock whose pid now belongs to an unrelated process (different start time) is stale', { skip: process.platform !== 'linux' }, () => withLiveChild((pid) => {
  const d = fs.mkdtempSync(path.join(dir, 'reuse-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid, bootId: _internals.bootId(), startTime: '1' }));
  const release = acquire(d);
  assert.equal(lockOf(d).pid, process.pid);
  release();
}));

test('a lock written during a previous boot is stale even if its pid is running now', { skip: process.platform !== 'linux' }, () => withLiveChild((pid) => {
  const d = fs.mkdtempSync(path.join(dir, 'boot-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid, bootId: '00000000-0000-0000-0000-000000000000', startTime: _internals.startTime(pid) }));
  const release = acquire(d);
  assert.equal(lockOf(d).pid, process.pid);
  release();
}));

test('a corrupt lock file (e.g. torn write at power loss) is stale, not a permanent lock-out', () => {
  const d = fs.mkdtempSync(path.join(dir, 'corrupt-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), '{"pid": 12');
  const release = acquire(d);
  release();
});

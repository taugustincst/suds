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

// ---- Hostname + heartbeat: a lock from another machine or container is judged by its heartbeat alone ----
// Docker replicas on one host all run node as the same pid (1, or tini's child) and share the host's boot id;
// two hosts on one NFS volume have different boot ids. Neither may be read as "our own previous run".
const HOST = os.hostname();
const ageLock = (d, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(path.join(d, '.suds.lock'), t, t); };
const fast = { heartbeatMs: 50, staleMs: 400, waitMs: 0 };

test('the lock records this host\'s name', () => {
  const d = fs.mkdtempSync(path.join(dir, 'host-'));
  const release = acquire(d, fast);
  assert.equal(lockOf(d).hostname, HOST);
  release();
});

test('same host, own pid (container restarted after a crash keeps its hostname) is taken over at once', () => {
  const d = fs.mkdtempSync(path.join(dir, 'samehost-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid: process.pid, hostname: HOST, bootId: _internals.bootId(), startTime: 'x' }));
  const release = acquire(d, fast); // fresh heartbeat, but provably our own dead predecessor
  assert.equal(lockOf(d).pid, process.pid);
  release();
});

test('another host (a second replica) with our pid and a live heartbeat is refused, not taken over', () => {
  const d = fs.mkdtempSync(path.join(dir, 'replica-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid: process.pid, hostname: 'replica-2', bootId: _internals.bootId(), startTime: _internals.startTime(process.pid) }));
  assert.throws(() => acquire(d, fast), (e) => /replica-2/.test(e.message) && /already running/.test(e.message) && /heartbeat/.test(e.message));
  assert.equal(lockOf(d).hostname, 'replica-2', 'the other holder\'s lock is untouched');
});

test('another host with a different boot id (shared NFS) and a live heartbeat is refused', () => {
  const d = fs.mkdtempSync(path.join(dir, 'nfs-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid: 4242, hostname: 'other-host', bootId: '00000000-0000-0000-0000-000000000000', startTime: '5' }));
  assert.throws(() => acquire(d, fast), /other-host/);
});

test('another host whose heartbeat is older than the stale window is taken over', () => {
  const d = fs.mkdtempSync(path.join(dir, 'stale-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid: process.pid, hostname: 'crashed-container', bootId: _internals.bootId() }));
  ageLock(d, 1000);
  const release = acquire(d, fast);
  assert.equal(lockOf(d).hostname, HOST);
  release();
});

test('start-up waits for another host\'s heartbeat to go stale, then takes over', () => {
  const d = fs.mkdtempSync(path.join(dir, 'wait-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid: 7, hostname: 'gone' }));
  ageLock(d, 200); // 200 ms old; stale at 400 ms
  const t0 = Date.now();
  const release = acquire(d, { ...fast, waitMs: 3000 });
  assert.ok(Date.now() - t0 >= 150, 'it waited');
  assert.equal(lockOf(d).hostname, HOST);
  release();
});

test('the holder refreshes the heartbeat (the lock file\'s mtime) while it runs', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'beat-'));
  const release = acquire(d, fast);
  ageLock(d, 5000);
  await new Promise((r) => setTimeout(r, 200));
  const age = Date.now() - fs.statSync(path.join(d, '.suds.lock')).mtimeMs;
  assert.ok(age < 1000, `heartbeat refreshed (age ${age} ms)`);
  release();
});

test('a holder whose lock was taken over is told (onLost), so it can stop writing', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'lost-'));
  let lost = null;
  const release = acquire(d, { ...fast, onLost: (why) => { lost = why; } });
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid: 99, hostname: 'usurper' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(lost, 'onLost was called');
  release();
  assert.equal(lockOf(d).hostname, 'usurper', 'release leaves the new holder\'s lock alone');
});

test('old lock formats (1.12.0 and earlier, no hostname) are judged as written on this host', () => {
  const d = fs.mkdtempSync(path.join(dir, 'legacy-'));
  fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ pid: process.pid, bootId: _internals.bootId(), startTime: 'x' }));
  const r1 = acquire(d, fast); r1(); // own pid: the crashed predecessor (node as PID 1 in a container)
  fs.writeFileSync(path.join(d, '.suds.lock'), String(process.pid));
  const r2 = acquire(d, fast); r2(); // old plain-pid format, own pid
  fs.writeFileSync(path.join(d, '.suds.lock'), '999999');
  const r3 = acquire(d, fast); r3(); // dead pid
});

// ---- Same hostname, different container: the identity of the process's container decides (1.12.1) ----
// Two containers can share a hostname -- network_mode: host, a fixed `hostname:`, a StatefulSet pod rescheduled
// onto another node -- and both run node as pid 1. Up to 1.12.0 the second read the first's live lock as its own
// dead predecessor ("own pid") and took it over at once; the first stopped within 10 s, and with restart policies
// the two alternated. The lock now records the container's identity (a digest of the root mount from
// /proc/self/mountinfo, the pid namespace, /etc/machine-id); the local rules apply only when the hostname AND
// that identity match, and otherwise only the heartbeat counts.
const ME = { hostname: HOST, rootId: 'root-a', pidNs: 'pid:[4026532001]', machineId: 'machine-1' };
const writeLock = (d, rec) => fs.writeFileSync(path.join(d, '.suds.lock'), JSON.stringify({ bootId: _internals.bootId(), startTime: _internals.startTime(process.pid), ...rec }));

test('the lock records the container identity (root mount digest, pid namespace, machine id)', { skip: process.platform !== 'linux' }, () => {
  const d = fs.mkdtempSync(path.join(dir, 'ident-'));
  const release = acquire(d, fast);
  const rec = lockOf(d);
  assert.match(rec.rootId, /^[0-9a-f]{16}$/);
  assert.match(rec.pidNs, /^pid:\[\d+\]$/);
  release();
});

test('same hostname and pid, another container (different root mount), live heartbeat: refused, not taken over', () => {
  const d = fs.mkdtempSync(path.join(dir, 'twin-'));
  writeLock(d, { pid: process.pid, hostname: HOST, rootId: 'root-b', pidNs: 'pid:[4026532999]', machineId: 'machine-1' });
  assert.throws(() => acquire(d, { ...fast, identity: ME }), (e) => /already running/.test(e.message) && /heartbeat/.test(e.message));
  assert.equal(lockOf(d).rootId, 'root-b', 'the other holder\'s lock is untouched');
});

test('same hostname and pid, no root digest on either side, different pid namespace: refused', () => {
  const d = fs.mkdtempSync(path.join(dir, 'twin-ns-'));
  writeLock(d, { pid: process.pid, hostname: HOST, pidNs: 'pid:[4026532999]' });
  assert.throws(() => acquire(d, { ...fast, identity: { ...ME, rootId: null } }), /already running/);
});

test('same hostname and root mount, another machine (machine id differs, shared storage): refused', () => {
  const d = fs.mkdtempSync(path.join(dir, 'twin-host-'));
  writeLock(d, { pid: process.pid, hostname: HOST, rootId: 'root-a', pidNs: 'pid:[4026531836]', machineId: 'machine-2' });
  assert.throws(() => acquire(d, { ...fast, identity: ME }), /already running/);
});

test('the same container restarted after a crash (same root mount, new pid namespace) is still taken over at once', () => {
  const d = fs.mkdtempSync(path.join(dir, 'restart-'));
  writeLock(d, { pid: process.pid, hostname: HOST, rootId: 'root-a', pidNs: 'pid:[4026530000]', machineId: 'machine-1' });
  const release = acquire(d, { ...fast, identity: ME });
  assert.equal(lockOf(d).rootId, 'root-a');
  assert.equal(lockOf(d).pidNs, ME.pidNs);
  release();
});

test('another container with the same hostname whose heartbeat has gone stale is taken over', () => {
  const d = fs.mkdtempSync(path.join(dir, 'twin-stale-'));
  writeLock(d, { pid: process.pid, hostname: HOST, rootId: 'root-b', pidNs: 'pid:[4026532999]' });
  ageLock(d, 1000);
  const release = acquire(d, { ...fast, identity: ME });
  assert.equal(lockOf(d).rootId, 'root-a');
  release();
});

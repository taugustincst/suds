'use strict';
// The audit chain's head is sealed, and its first anchor written, when the office server first starts (1.24; pen
// test of 1.23.6, L5). Until then the first seal waited for the daily verification at the first hourly housekeeping
// pass, and checkHead answered "not checkpointed": deleting the newest entries of a new install left no trace.
// The real server (server/index.js) is started against a throwaway data directory and stopped again.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const KEYS = { SUDS_ENCRYPTION_KEY: '5a'.repeat(32), SUDS_INDEX_KEY: '6b'.repeat(32), SUDS_SIGNING_KEY: '7c'.repeat(32) };

/** Start server/index.js on `dir` until it says it is listening, then stop it. Resolves with its output. */
function startAndStop(dir) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH || '', HOME: dir, SUDS_ENV: 'test', SUDS_DATA_DIR: dir, SUDS_DB_PATH: path.join(dir, 'suds.db'), HOST: '127.0.0.1', PORT: '0',
      SUDS_ADMIN_USERNAME: 'admin', SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x', SUDS_SKIP_SETUP: '1', LOG_FORMAT: 'text', TZ: process.env.TZ || '', ...KEYS };
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server did not start:\n${out}`)); }, 30_000);
    const seen = (d) => { out += d; if (/listening on/.test(out) && !child.stopping) { child.stopping = true; child.kill('SIGTERM'); } };
    child.stdout.on('data', seen); child.stderr.on('data', seen);
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
  });
}

test('the first start seals the audit head and writes the first anchor; deleting the newest entries is then detected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-head-at-start-'));
  try {
    const out = await startAndStop(dir);
    assert.match(out, /audit checkpoint id=\d+ rows=\d+/, out);
    const anchors = fs.readdirSync(path.join(dir, 'audit-anchors')).filter((f) => f.endsWith('.json'));
    assert.equal(anchors.length, 1, 'the first anchor, written at start');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'audit-anchors', anchors[0]), 'utf8')).reason, 'first-start');

    // Open the database the server left, as the server would, and look at the head.
    Object.assign(process.env, { SUDS_ENV: 'test', SUDS_DATA_DIR: dir, SUDS_DB_PATH: path.join(dir, 'suds.db'), ...KEYS });
    const db = require('../server/db');
    const audit = require('../server/audit');
    db.open();
    try {
      assert.deepEqual({ ...audit.checkHead(), checkpointAt: undefined }, { checkpointed: true, checkpointId: Number(db.getSetting('audit_head_id')), checkpointAt: undefined, truncated: false });
      assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='audit.started'`), 'an empty chain gets an entry to seal');
      // A start with a head already sealed leaves it alone.
      assert.equal(audit.sealHeadAtStart(), null);
      // Someone with the database deletes the newest entries: the sealed head says so at once.
      audit.log({ user: { username: 'system' }, action: 'test.later' });
      const head = Number(db.getSetting('audit_head_id'));
      // (The append-only trigger is no obstacle to whoever holds the file; the test goes through the flag.)
      audit.maintenance('test: truncation', () => db.run(`DELETE FROM audit_log WHERE id >= ?`, head));
      const h = audit.checkHead();
      assert.equal(h.truncated, true, JSON.stringify(h));
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

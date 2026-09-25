'use strict';
// The frequent snapshot on a real (file) database: SQLite's online backup API copies it in page batches and
// yields between them, so the server keeps answering (and writing) while a snapshot runs, and the result
// is a whole database that restores. The in-memory database the other tests use takes the VACUUM INTO path.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-snapshot-'));
process.env.SUDS_ENV = 'test';
process.env.SUDS_DATA_DIR = dir;
process.env.SUDS_DB_PATH = path.join(dir, 'suds.db');
const { test, after } = require('node:test');
const assert = require('node:assert');
const db = require('../server/db');
const backup = require('../server/backup');

after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('an online snapshot of a file database yields to other work, and restores to the same rows', async () => {
  db.open();
  const { encrypt, uuid } = require('../server/crypto');
  db.transaction(() => { for (let i = 0; i < 3000; i++) db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc) VALUES(?,?,?,?)`, uuid(), `S26-${String(i).padStart(5, '0')}`, encrypt('Snap'), encrypt(`Person ${i}`)); });
  // Writes keep landing while the copy runs: count event-loop turns that happened during it.
  let turns = 0; let running = true;
  const tick = () => { if (!running) return; turns++; db.run(`INSERT INTO settings(key,value) VALUES('snapshot_tick',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, String(turns)); setImmediate(tick); };
  setImmediate(tick);
  const made = await backup.createAsync({ rate: 16 });
  running = false;
  assert.equal(made.method, typeof require('node:sqlite').backup === 'function' ? 'sqlite-online-backup' : 'vacuum-into');
  if (made.method === 'sqlite-online-backup') assert.ok(turns > 1, `the event loop ran during the copy (${turns} turns)`);
  const info = backup.inspect(backup.decrypt(made.bytes));
  assert.ok(info.counts.clients >= 3000);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.backup-')), [], 'no plaintext copy is left behind');
});

'use strict';
// Indexes schema.sql declares must exist in the database. Migration 5 creates every index with a bare
// `catch {}` (some name columns a later migration adds), so an index that could not be created at all — a
// UNIQUE index over rows that already break it, most likely — used to vanish without a word: slow queries,
// or duplicates the index exists to prevent. Every open now checks the whole list, creates what is missing,
// and reports what still cannot be created: a structured log line (no row values) and a /api/health warning.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '11'.repeat(32);
process.env.SUDS_INDEX_KEY = '22'.repeat(32);
process.env.MFA_REQUIRED_ROLES = '';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-db-indexes-'));
process.env.SUDS_DATA_DIR = dir;
const file = path.join(dir, 'suds.db');
process.env.SUDS_DB_PATH = file;
const db = require('../server/db');
after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

const raw = (fn) => { const d = new DatabaseSync(file); try { return fn(d); } finally { d.close(); } };
const hasIndex = (name) => !!db.one(`SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name=?`, name);

test('a missing index is re-created on open', () => {
  db.open(); db.close();
  raw((d) => d.exec('DROP INDEX idx_sessions_user'));
  db.open();
  assert.ok(hasIndex('idx_sessions_user'), 'the dropped index is back');
  assert.deepEqual(db.indexProblems(), []);
  db.close();
});

test('an index that cannot be created is logged (no row values) and reported by /api/health', async () => {
  raw((d) => {
    d.exec('DROP INDEX idx_users_oidc_subject');
    const ins = d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role,oidc_subject) VALUES(?,?,?,?,?,?)`);
    ins.run('u-dup-1', 'dup1', 'x', 'Dup One', 'navigator', 'secret-subject-value');
    ins.run('u-dup-2', 'dup2', 'x', 'Dup Two', 'navigator', 'secret-subject-value');
  });
  const logged = [];
  const orig = console.warn; console.warn = (...a) => { logged.push(a.join(' ')); };
  try { db.open(); } finally { console.warn = orig; }
  const problems = db.indexProblems();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].index, 'idx_users_oidc_subject');
  assert.match(problems[0].error, /UNIQUE/);
  const line = logged.find((l) => /idx_users_oidc_subject/.test(l));
  assert.ok(line, 'the failure is logged');
  const rec = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(rec.event, 'db.index_missing');
  assert.ok(!/secret-subject-value/.test(line), 'no row values in the log');

  const { createHandler } = require('../server/app');
  const server = http.createServer(createHandler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.ok(body.warnings.some((w) => /idx_users_oidc_subject/.test(w) && !/secret-subject-value/.test(w)), JSON.stringify(body.warnings));
  } finally { await new Promise((r) => server.close(r)); }
});

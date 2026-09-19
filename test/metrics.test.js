'use strict';
// server/metrics.js: the Prometheus exposition text is well-formed and carries no PHI.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = 'cc'.repeat(32);
process.env.SUDS_INDEX_KEY = 'dd'.repeat(32);
process.env.SUDS_DB_PATH = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const db = require('../server/db');
const metrics = require('../server/metrics');
const { uuid, encrypt, hashPassword } = require('../server/crypto');

before(() => {
  db.open();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`, uuid(), 'metricstest', hashPassword('x'), 'Metrics Test', 'navigator');
  db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc) VALUES(?,?,?,?)`, uuid(), 'C26-METRICS', encrypt('Pat'), encrypt('Sample'));
});
after(() => db.close());

test('render() produces well-formed Prometheus exposition text', () => {
  const text = metrics.render();
  assert.match(text, /^# HELP suds_up /m);
  assert.match(text, /^# TYPE suds_up gauge$/m);
  assert.match(text, /^suds_up 1$/m);
  assert.match(text, /^suds_uptime_seconds \d+$/m);
  assert.match(text, /^suds_users_active \d+$/m);
  assert.match(text, /^suds_clients_total \d+$/m);
  assert.match(text, /^suds_build_info\{version="[^"]+",schema_version="\d+"\} 1$/m);
  assert.ok(text.endsWith('\n'), 'ends with a trailing newline, as the format expects');
});

test('counts reflect what is actually in the database', () => {
  const text = metrics.render();
  const usersLine = text.match(/^suds_users_active (\d+)$/m);
  assert.equal(Number(usersLine[1]), db.one(`SELECT COUNT(*) n FROM users WHERE is_active=1`).n);
  const clientsLine = text.match(/^suds_clients_total (\d+)$/m);
  assert.equal(Number(clientsLine[1]), db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n);
});

test('nothing that looks like PHI appears in the output', () => {
  const text = metrics.render();
  assert.ok(!text.includes('Pat'), 'a decrypted first name must never appear in metrics');
  assert.ok(!text.includes('C26-METRICS'), 'not even a client code');
});

'use strict';
// server/devices.js in isolation: touch()'s create/update/reattribution behaviour, and markWiped().
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '88'.repeat(32);
process.env.SUDS_INDEX_KEY = '99'.repeat(32);
process.env.SUDS_DB_PATH = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const db = require('../server/db');
const devices = require('../server/devices');
const { uuid, hashPassword } = require('../server/crypto');

let userA, userB;
before(() => {
  db.open();
  userA = uuid(); userB = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`, userA, 'devtest-a', hashPassword('x'), 'Device Test A', 'navigator');
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`, userB, 'devtest-b', hashPassword('x'), 'Device Test B', 'navigator');
});
after(() => db.close());

test('labelFrom guesses a friendly name from the user-agent', () => {
  assert.equal(devices.labelFrom('Mozilla/5.0 (Linux; Android 14)'), 'Android phone');
  assert.equal(devices.labelFrom('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'iPad');
  assert.equal(devices.labelFrom('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'iPhone');
  assert.equal(devices.labelFrom(''), 'Device');
  assert.equal(devices.labelFrom(undefined), 'Device');
});

test('touch creates a device on first sight and updates it on return visits', () => {
  const id = uuid();
  const first = devices.touch({ id: userA }, id, { headers: { 'user-agent': 'Android' }, ip: '10.0.0.1' });
  assert.equal(first.user_id, userA);
  assert.equal(first.sync_count, 1);
  assert.equal(first.label, 'Android phone');
  assert.equal(first.first_seen_at, first.last_seen_at);

  const second = devices.touch({ id: userA }, id, { headers: { 'user-agent': 'Android' }, ip: '10.0.0.2' });
  assert.equal(second.sync_count, 2);
  assert.equal(second.last_ip, '10.0.0.2');
  assert.equal(second.first_seen_at, first.first_seen_at, 'first_seen_at never moves');
});

test('a device that later syncs as a different user is reattributed, not duplicated', () => {
  const id = uuid();
  devices.touch({ id: userA }, id, { headers: {}, ip: '10.0.0.1' });
  const reassigned = devices.touch({ id: userB }, id, { headers: {}, ip: '10.0.0.1' });
  assert.equal(reassigned.user_id, userB);
  assert.equal(db.all(`SELECT * FROM devices WHERE id=?`, id).length, 1, 'still one row, not two');
});

test('markWiped revokes the device and clears the pending wipe flag', () => {
  const id = uuid();
  devices.touch({ id: userA }, id, { headers: {}, ip: '10.0.0.1' });
  db.run(`UPDATE devices SET wipe_requested_at=? WHERE id=?`, db.now(), id);
  devices.markWiped(id);
  const row = db.one(`SELECT * FROM devices WHERE id=?`, id);
  assert.ok(row.revoked_at);
  assert.equal(row.wipe_requested_at, null);
});

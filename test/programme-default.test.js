'use strict';
// Which programme profile a database gets when it has none (server/programme.js, server/db.js initialise):
// a new install is harm reduction & outreach; a database from before profiles existed keeps every module
// it was using — treatment-adjacent if it holds any clinical record or has CalOMS or FHIR set up — so
// nothing disappears on upgrade.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.SUDS_INDEX_KEY = '1'.repeat(64);
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const db = require('../server/db');
const P = require('../server/programme');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-profile-'));
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Opens `file` as an upgrade would find it: an existing database with no profile stored.
function reopenWithoutProfile(file, prepare = () => {}) {
  db.close();
  const d = new DatabaseSync(file);
  d.exec(`DELETE FROM settings WHERE key='programme_profile'`);
  prepare(d);
  d.close();
  db.open(file);
}

test('a new database is a harm-reduction programme with every clinical module off', () => {
  db.open(path.join(dir, 'fresh.db'));
  assert.equal(db.getSetting('programme_profile'), 'harm_reduction');
  assert.ok(Object.values(P.modules()).every(v => v === false));
});

test('an upgraded database with no clinical records is harm reduction', () => {
  reopenWithoutProfile(path.join(dir, 'fresh.db'));
  assert.equal(db.getSetting('programme_profile'), 'harm_reduction');
});

test('an upgraded database that reports CalOMS is treatment-adjacent, so nothing disappears', () => {
  reopenWithoutProfile(path.join(dir, 'fresh.db'), (d) => d.exec(`INSERT INTO settings(key,value) VALUES('caloms_enabled','1')`));
  assert.equal(db.getSetting('programme_profile'), 'treatment');
  assert.ok(Object.values(P.modules()).every(v => v === true));
});

test('the decision is made once: a stored profile is never recomputed', () => {
  db.setSetting('programme_profile', 'harm_reduction');
  db.close(); db.open(path.join(dir, 'fresh.db'));
  assert.equal(db.getSetting('programme_profile'), 'harm_reduction');
});

test('any clinical record makes an existing database treatment-adjacent', () => {
  for (const [table, sql] of [['problems', `INSERT INTO problems(id) VALUES('p')`], ['asam_assessments', `INSERT INTO asam_assessments(id) VALUES('a')`],
    ['caloms_records', `INSERT INTO caloms_records(id) VALUES('c')`], ['fhir client', `INSERT INTO api_keys(id, scopes) VALUES('k', 'fhir:system/*.read')`]]) {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE problems(id TEXT); CREATE TABLE asam_assessments(id TEXT); CREATE TABLE caloms_records(id TEXT); CREATE TABLE api_keys(id TEXT, scopes TEXT)`);
    assert.equal(P.defaultForExisting(d), 'harm_reduction', 'nothing clinical yet');
    d.exec(sql);
    assert.equal(P.defaultForExisting(d), 'treatment', table);
    d.close();
  }
});

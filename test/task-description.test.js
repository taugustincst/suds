'use strict';
// tasks.description was plaintext beside an encrypted title, although the details of a to-do say even more
// about a named person's treatment than its title does. It is description_enc now (migration 24). This
// file checks both upgrade paths (a 1.6.1 database, which goes through the migration-19 table rebuild,
// and a 1.9.2 one at schema 23), the API round trip, exports and sync.
process.env.SUDS_ENV = 'test';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { uuid, encrypt, decrypt } = require('../server/crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-taskdesc-'));
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const DETAILS = 'Detox bed at Granite on Tuesday; bring the MAT letter';

test('a 1.6.1 database keeps its to-do details, encrypted, through every migration', () => {
  const dbPath = path.join(dir, 'v4.db');
  const d = new DatabaseSync(dbPath);
  d.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-v4.sql'), 'utf8'));
  const user = uuid(), task = uuid(), blank = uuid();
  d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`).run(user, 'u1', 'x', 'U One', 'navigator');
  d.prepare(`INSERT INTO tasks(id,created_by,title,description) VALUES(?,?,?,?)`).run(task, user, 'Call about detox', DETAILS);
  d.prepare(`INSERT INTO tasks(id,created_by,title,description) VALUES(?,?,?,?)`).run(blank, user, 'No details', null);
  d.close();
  const db = require('../server/db');
  db.open(dbPath);
  try {
    const cols = db.all(`PRAGMA table_info(tasks)`).map(c => c.name);
    assert.ok(!cols.includes('description'), 'the plaintext column is gone');
    const row = db.one(`SELECT * FROM tasks WHERE id=?`, task);
    assert.match(row.description_enc, /^v1:/);
    assert.equal(decrypt(row.description_enc), DETAILS);
    assert.equal(decrypt(row.title_enc), 'Call about detox');
    assert.equal(db.one(`SELECT description_enc FROM tasks WHERE id=?`, blank).description_enc, null);
  } finally { db.close(); }
});

test('a 1.9.2 database (schema 23) has its plaintext to-do details encrypted by migration 24', () => {
  const dbPath = path.join(dir, 'v23.db');
  const db = require('../server/db');
  db.open(dbPath); db.close();
  // Wind a fresh database back to what 1.9.2 wrote: plaintext description, no description_enc, schema 23.
  const d = new DatabaseSync(dbPath);
  d.exec(`ALTER TABLE tasks ADD COLUMN description TEXT`);
  d.exec(`ALTER TABLE tasks DROP COLUMN description_enc`);
  const user = uuid(), task = uuid();
  d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`).run(user, 'u1', 'x', 'U One', 'navigator');
  d.prepare(`INSERT INTO tasks(id,created_by,title_enc,description) VALUES(?,?,?,?)`).run(task, user, encrypt('Call about detox'), DETAILS);
  d.prepare(`UPDATE settings SET value='23' WHERE key='schema_version'`).run();
  d.close();
  db.open(dbPath);
  try {
    assert.equal(db.getSetting('schema_version'), String(db.LATEST_SCHEMA_VERSION));
    assert.ok(db.LATEST_SCHEMA_VERSION >= 24);
    const cols = db.all(`PRAGMA table_info(tasks)`).map(c => c.name);
    assert.ok(!cols.includes('description') && cols.includes('description_enc'));
    assert.equal(decrypt(db.one(`SELECT description_enc FROM tasks WHERE id=?`, task).description_enc), DETAILS);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally { db.close(); }
});

test('the API keeps `description`, stores it encrypted, and exports and sync treat it as PHI', async () => {
  process.env.SUDS_DB_PATH = ':memory:';
  const H = require('./helpers');
  await H.start();
  // These tests sync like a device does, which needs local mode on (it is off by default on a server).
  require('../server/config').localModeEnabled = true;
  try {
    H.makeUser('tdnav', 'navigator');
    const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
    const nav = H.client(); await nav.login('tdnav', 'StaffPassw0rd!x');
    const clientId = (await nav.post('/api/clients', { first_name: 'Task', last_name: 'Details' })).data.id;
    const created = await nav.post('/api/tasks', { client_id: clientId, title: 'Bed search', description: DETAILS });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    const stored = H.db.one(`SELECT * FROM tasks WHERE id=?`, id);
    assert.ok(!('description' in stored));
    assert.match(stored.description_enc, /^v1:/);
    assert.ok(!stored.description_enc.includes('Granite'));
    const got = (await nav.get(`/api/tasks/${id}`)).data.row;
    assert.equal(got.description, DETAILS);
    assert.equal(got.description_enc, undefined, 'ciphertext does not leave the server');
    const list = (await nav.get(`/api/tasks?client_id=${clientId}`)).data;
    const rows = list.rows || list;
    assert.equal(rows.find(t => t.id === id).description, DETAILS);
    assert.equal((await nav.put(`/api/tasks/${id}`, { description: 'Changed' })).status, 200);
    assert.equal(decrypt(H.db.one(`SELECT description_enc FROM tasks WHERE id=?`, id).description_enc), 'Changed');
    assert.equal((await nav.put(`/api/tasks/${id}`, { description: '' })).status, 200);
    assert.equal(H.db.one(`SELECT description_enc FROM tasks WHERE id=?`, id).description_enc, null);
    await nav.put(`/api/tasks/${id}`, { description: DETAILS });
    const timeline = JSON.stringify((await nav.get(`/api/clients/${clientId}/timeline`)).data);
    assert.ok(timeline.includes(DETAILS), 'the client timeline shows the details decrypted');

    // Exports: never in a de-identified file; decrypted in an identified one.
    const q = 'from=2000-01-01&to=2100-12-31';
    const deid = String((await admin.get(`/api/reports/export/tasks?${q}`)).data);
    assert.ok(!deid.includes('Granite') && !/description/i.test(deid.split('\n')[0]), 'a de-identified export has no details column');
    const ident = await admin.get(`/api/reports/export/tasks?${q}&identified=1&recipient=Auditor&purpose=Audit`);
    assert.equal(ident.status, 200);
    assert.ok(String(ident.data).includes('Granite'), 'an identified export carries the details');

    // Sync: pushed decrypted for transport, stored encrypted, pulled decrypted.
    const pushedId = uuid(); const at = new Date().toISOString();
    const push = await nav.post('/api/sync/push', { device_now: at, tables: { tasks: [{ id: pushedId, client_id: clientId, created_by: H.db.one(`SELECT id FROM users WHERE username='tdnav'`).id, title_enc: 'From a device', description_enc: 'Pushed details', created_at: at, updated_at: at }] } });
    assert.equal(push.status, 200, JSON.stringify(push.data));
    assert.equal(decrypt(H.db.one(`SELECT description_enc FROM tasks WHERE id=?`, pushedId).description_enc), 'Pushed details');
    const bare = H.client();
    const l = await bare.post('/api/auth/login', { username: 'tdnav', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' });
    const pull = (await bare.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', { Authorization: 'Bearer ' + l.data.token, Cookie: '' })).data;
    assert.equal(pull.tables.tasks.find(t => t.id === pushedId).description_enc, 'Pushed details');
  } finally { await H.stop(); }
});

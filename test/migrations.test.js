'use strict';
// Upgrading a real county database is the one operation that cannot be retried, so it gets its own test.
// test/fixtures/schema-v4.sql is the schema exactly as SUDS 1.6.1 left it; release-v1.9.4.sql, release-v1.11.0.sql,
// release-v1.13.0.sql and release-v1.15.3.sql are databases those releases wrote themselves
// (test/fixtures/make-release-fixture.js; the last three with rows in every table that has an encrypted column),
// upgraded at the end of this file.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.SUDS_INDEX_KEY = '1'.repeat(64);
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-migrate-'));
const dbPath = path.join(dir, 'suds.db');
const ids = {};

before(() => {
  // Build a 1.6.1 database with rows in every column migration 5 has to move.
  const d = new DatabaseSync(dbPath);
  d.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-v4.sql'), 'utf8'));
  const { uuid, encrypt } = require('../server/crypto');
  ids.user = uuid(); ids.client = uuid(); ids.note = uuid(); ids.consent = uuid(); ids.disclosure = uuid(); ids.intervention = uuid(); ids.generalConsent = uuid();
  d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`).run(ids.user, 'u1', 'x', 'U One', 'navigator');
  d.prepare(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,goals,flags,intake_date,status,created_by) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(ids.client, 'M26-0001', encrypt('Ada'), encrypt('Lovelace'), 'Housing, then MAT induction', 'od_risk,no_voicemail', '2026-01-05', 'active', ids.user);
  d.prepare(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,summary) VALUES(?,?,?,?,?,?)`)
    .run(ids.intervention, ids.client, ids.user, 'outreach', '2026-02-01T10:00:00.000Z', 'Met at the shelter, discussed detox');
  d.prepare(`INSERT INTO notes(id,client_id,author_id,kind,title,content_enc,occurred_at) VALUES(?,?,?,?,?,?,?)`)
    .run(ids.note, ids.client, ids.user, 'admin', 'Intake call', encrypt('note body'), '2026-02-01T10:00:00.000Z');
  d.prepare(`INSERT INTO consents(id,client_id,type,recipient,purpose,scope,signed_at,created_by) VALUES(?,?,?,?,?,?,?,?)`)
    .run(ids.consent, ids.client, 'part2_disclosure', 'Granite Wellness', 'treatment referral', 'dates of service only', '2026-01-06', ids.user);
  d.prepare(`INSERT INTO consents(id,client_id,type,recipient,purpose,scope,signed_at,created_by) VALUES(?,?,?,?,?,?,?,?)`)
    .run(ids.generalConsent, ids.client, 'part2_disclosure', 'Granite Wellness', 'treatment referral', 'All of my SUD treatment records', '2026-01-06', ids.user);
  d.prepare(`INSERT INTO disclosures(id,client_id,disclosed_to,purpose,info_disclosed,disclosed_at,disclosed_by) VALUES(?,?,?,?,?,?,?)`)
    .run(ids.disclosure, ids.client, 'Granite Wellness', 'referral', 'intake summary', '2026-01-07T00:00:00.000Z', ids.user);
  d.prepare(`INSERT INTO assignments(id,client_id,user_id,start_date,created_by) VALUES(?,?,?,?,?)`).run(uuid(), ids.client, ids.user, '2026-01-05', ids.user);
  d.close();

  require('../server/db').open(dbPath);
});
after(() => { require('../server/db').close(); fs.rmSync(dir, { recursive: true, force: true }); });

const db = () => require('../server/db');
const colsOf = (t) => db().all(`PRAGMA table_info(${t})`);

test('a 1.6.1 database upgrades to the current schema version', () => {
  assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
});

test('an upgraded office starts with the least-privilege default off (1.17.0), so nobody\'s access changes silently', () => {
  // A new install has it on (test/least-privilege-default.test.js); server/caseload-default.js.
  assert.equal(db().getSetting('caseload_hold_new_staff'), '0');
});

test('migration leaves no orphaned rows', () => {
  assert.deepEqual(db().all('PRAGMA foreign_key_check'), []);
});

test('plaintext PHI is moved into encrypted columns and the plaintext column is dropped', () => {
  const { decrypt } = require('../server/crypto');
  const c = db().one(`SELECT * FROM clients WHERE id=?`, ids.client);
  assert.ok(!('goals' in c), 'clients.goals should be gone');
  assert.ok(!('flags' in c), 'clients.flags should be gone');
  assert.match(c.goals_enc, /^v1:/, 'goals_enc holds ciphertext');
  assert.equal(decrypt(c.goals_enc), 'Housing, then MAT induction');
  assert.equal(decrypt(c.flags_enc), 'od_risk,no_voicemail');

  const n = db().one(`SELECT * FROM notes WHERE id=?`, ids.note);
  assert.ok(!('title' in n));
  assert.equal(decrypt(n.title_enc), 'Intake call');

  const iv = db().one(`SELECT * FROM interventions WHERE id=?`, ids.intervention);
  assert.ok(!('summary' in iv));
  assert.equal(decrypt(iv.summary_enc), 'Met at the shelter, discussed detox');

  const con = db().one(`SELECT * FROM consents WHERE id=?`, ids.consent);
  assert.ok(!('recipient' in con) && !('purpose' in con) && !('scope' in con));
  assert.equal(decrypt(con.recipient_enc), 'Granite Wellness');
  assert.equal(decrypt(con.scope_enc), 'dates of service only');

  const dis = db().one(`SELECT * FROM disclosures WHERE id=?`, ids.disclosure);
  assert.ok(!('disclosed_to' in dis) && !('info_disclosed' in dis));
  assert.equal(decrypt(dis.recipient_enc), 'Granite Wellness');
  assert.equal(decrypt(dis.what_enc), 'intake summary');
});

test('interventions accept a row with no client (community naloxone distribution)', () => {
  const { uuid } = require('../server/crypto');
  const id = uuid();
  db().run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,naloxone_kits) VALUES(?,?,?,?,?,?)`, id, null, ids.user, 'naloxone_distribution', '2026-03-01T10:00:00.000Z', 25);
  assert.equal(db().one(`SELECT naloxone_kits n FROM interventions WHERE id=?`, id).n, 25);
});

test('updated_at is backfilled and non-null on every synced table', () => {
  for (const t of ['assignments', 'consents', 'disclosures', 'budget_lines', 'note_addenda', 'imports', 'import_items', 'interventions']) {
    const col = colsOf(t).find(c => c.name === 'updated_at');
    assert.ok(col, `${t} has updated_at`);
    assert.equal(col.notnull, 1, `${t}.updated_at is NOT NULL`);
    assert.equal(db().one(`SELECT COUNT(*) n FROM ${t} WHERE updated_at IS NULL`).n, 0);
  }
  assert.ok(db().one(`SELECT updated_at u FROM consents WHERE id=?`, ids.consent).u, 'consent kept a timestamp');
});

test('sync reads are indexed by updated_at', () => {
  const plan = db().all(`EXPLAIN QUERY PLAN SELECT * FROM interventions WHERE updated_at > ?`, '2020-01-01');
  assert.match(plan.map(p => p.detail).join(' '), /USING INDEX/, 'updated_at lookup should use an index');
});

test('every existing client gets an episode so admissions and discharges are countable', () => {
  const e = db().one(`SELECT * FROM episodes WHERE client_id=?`, ids.client);
  assert.ok(e, 'an episode was opened for the existing client');
  assert.equal(e.status, 'open');
  assert.equal(e.opened_at, '2026-01-05');
});

test('migrations are idempotent — a second open changes nothing', () => {
  const before = db().one(`SELECT COUNT(*) n FROM episodes`).n;
  require('../server/db').close();
  require('../server/db').open(dbPath);
  assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
  assert.equal(db().one(`SELECT COUNT(*) n FROM episodes`).n, before, 'no duplicate episodes');
  assert.deepEqual(db().all('PRAGMA foreign_key_check'), []);
});

test('a database from a newer build is refused rather than silently downgraded', () => {
  db().setSetting('schema_version', '99');
  require('../server/db').close();
  assert.throws(() => require('../server/db').open(dbPath), /newer version of SUDS/);
  const d = new DatabaseSync(dbPath);
  d.prepare(`UPDATE settings SET value=? WHERE key='schema_version'`).run(String(require('../server/db').LATEST_SCHEMA_VERSION));
  d.close();
  require('../server/db').open(dbPath);
});

// The shape of a database, compared structurally (column names, types, nullability, defaults, indexes,
// triggers) — physical column order and comments differ between ADD COLUMN and a fresh CREATE, and neither
// affects behaviour.
function schemaShape(d) {
  const out = {};
  for (const t of d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()) {
    if (t.name.startsWith('__new_')) continue;
    out[t.name] = {
      columns: d.prepare(`PRAGMA table_info(${t.name})`).all()
        .map(c => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? ''} pk=${c.pk}`).sort(),
      indexes: d.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(t.name)
        .map(i => i.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /gi, '').trim()).sort(),
      // Triggers too: the audit log's append-only guard (schema.sql) must reach an upgraded county.
      triggers: d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`).all(t.name)
        .map(i => i.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /gi, '').trim()).sort(),
    };
  }
  return out;
}
function freshShape() {
  const freshPath = path.join(dir, 'fresh.db');
  fs.rmSync(freshPath, { force: true });
  const f = new DatabaseSync(freshPath);
  f.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8'));
  const fresh = schemaShape(f);
  f.close();
  return fresh;
}
function assertSameShape(upgraded, fresh, from) {
  // sync_seen is created outside schema.sql, so an upgraded database legitimately has it.
  for (const extra of ['sync_seen']) delete upgraded[extra];
  assert.deepEqual(Object.keys(upgraded).sort(), Object.keys(fresh).sort(), `same set of tables (from ${from})`);
  for (const t of Object.keys(fresh)) {
    assert.deepEqual(upgraded[t].columns, fresh[t].columns, `columns of ${t} differ between a fresh and an upgraded (from ${from}) database`);
    assert.deepEqual(upgraded[t].indexes, fresh[t].indexes, `indexes of ${t} differ between a fresh and an upgraded (from ${from}) database`);
    assert.deepEqual(upgraded[t].triggers, fresh[t].triggers, `triggers of ${t} differ between a fresh and an upgraded (from ${from}) database`);
  }
}

test('a fresh install and an upgraded install end at the same schema', () => {
  // The two paths through initialise() must not drift: everything schema.sql adds for a new county has to
  // reach an existing one through a migration, or phones and servers end up with different tables.
  const fresh = freshShape();
  assertSameShape(schemaShape(db().get()), fresh, '1.6.1');
  assert.equal(fresh.audit_log.triggers.length, 2, 'the audit log carries its UPDATE and DELETE guards');
});

test('the generated browser schema matches schema.sql', () => {
  // server/schema-text.js is what a local-mode device builds its database from; if it drifts, the device
  // silently gets a different schema from the office server.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
  assert.equal(require('../server/schema-text.js'), sql, 'run `node scripts/gen-schema-text.js`');
});

test('every place that carries a version number agrees with package.json', () => {
  // The version lived in several hand-maintained files, so a release could ship with some of them bumped.
  // scripts/gen-schema-text.js stamps the service worker from package.json; this fails if it has drifted.
  // The native Android/iOS projects were removed in 1.9.3 (docs/PLATFORM.md), so there is nothing else to stamp.
  const root = path.join(__dirname, '..');
  const version = require('../package.json').version;
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  assert.match(read('public/sw.js'), new RegExp(`const VERSION = 'suds-shell-${version.replace(/\./g, '\\.')}'`), 'public/sw.js — run `npm run gen:schema`');
});

test('the database is snapshotted before the migration runs', () => {
  const snapDir = path.join(dir, 'pre-migration');
  const files = fs.readdirSync(snapDir);
  assert.equal(files.length, 1, 'one snapshot for the one upgrade');
  assert.match(files[0], /^suds\.db\.v4\./, 'named for the version it was taken at');
  // 1.14.0: once the upgrade has succeeded the snapshot is sealed with the backup key (it held every value a
  // later migration encrypted, in the clear): test/plaintext-remnants.test.js. It opens like a backup.
  assert.match(files[0], /\.db\.enc$/, 'sealed');
  const plainFile = path.join(os.tmpdir(), `suds-snap-${process.pid}.db`);
  fs.writeFileSync(plainFile, require('../server/backup').decrypt(fs.readFileSync(path.join(snapDir, files[0]))));
  // It is a real database, still holding the pre-migration shape.
  const snap = new DatabaseSync(plainFile, { readOnly: true });
  try {
    assert.equal(snap.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get().value, '4');
    const cols = snap.prepare('PRAGMA table_info(clients)').all().map(c => c.name);
    assert.ok(cols.includes('goals'), 'the snapshot predates the goals -> goals_enc move');
  } finally { snap.close(); fs.rmSync(plainFile, { force: true }); }
});

test('a pre-existing orphaned row (unrelated to this upgrade) does not brick every future boot', () => {
  // A dangling foreign key from a bug elsewhere, an interrupted sync, or manual tinkering — not something
  // this upgrade caused — used to fail foreign_key_check and abort the migration every single time, with a
  // full device wipe as the only way back in. It must instead be tolerated and reported, not fatal.
  const orphanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-migrate-orphan-'));
  const orphanPath = path.join(orphanDir, 'suds.db');
  const { uuid } = require('../server/crypto');
  const userId = uuid(), clientId = uuid(), assignmentId = uuid(), missingClientId = uuid();
  const d = new DatabaseSync(orphanPath);
  d.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-v4.sql'), 'utf8'));
  d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`).run(userId, 'orphantest', 'x', 'Orphan Test', 'navigator');
  d.prepare(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,intake_date,status,created_by) VALUES(?,?,?,?,?,?,?)`)
    .run(clientId, 'M26-0099', 'x', 'x', '2026-01-01', 'active', userId);
  // References a client id that was never inserted — a dangling foreign key, present before any migration
  // runs. FK enforcement has to be off to even create it, same as real orphans arrive (a bug elsewhere, an
  // interrupted sync, or manual tinkering never goes through app-level validation either).
  d.exec('PRAGMA foreign_keys = OFF');
  d.prepare(`INSERT INTO assignments(id,client_id,user_id,start_date,created_by) VALUES(?,?,?,?,?)`).run(assignmentId, missingClientId, userId, '2026-01-01', userId);
  d.close();

  require('../server/db').close();
  try {
    assert.doesNotThrow(() => require('../server/db').open(orphanPath), 'a pre-existing orphan must not abort the upgrade');
    const upgraded = require('../server/db');
    assert.equal(upgraded.getSetting('schema_version'), String(upgraded.LATEST_SCHEMA_VERSION), 'the database still reaches the latest schema');
    const row = upgraded.one(`SELECT client_id FROM assignments WHERE id=?`, assignmentId);
    assert.equal(row.client_id, missingClientId, 'the orphaned row is preserved, not silently dropped or nulled');
  } finally {
    require('../server/db').close();
    require('../server/db').open(dbPath); // restore the shared fixture db for anything after this test
    fs.rmSync(orphanDir, { recursive: true, force: true });
  }
});

test('migration 35: a free-text scope covers nothing automated unless it plainly says the whole record', () => {
  assert.equal(db().one(`SELECT info_categories FROM consents WHERE id=?`, ids.consent).info_categories, null, '"dates of service only" is not machine-readable');
  assert.equal(db().one(`SELECT info_categories FROM consents WHERE id=?`, ids.generalConsent).info_categories, 'all');
  assert.ok(db().one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='caloms_submissions'`));
});

test('migration 46: a preferred name with no search index gets one; a written index, an empty name and a second run are left alone', () => {
  const d = require('../server/db');
  const { encrypt } = require('../server/crypto');
  const M = require('../server/clients-model');
  const ids = { missing: 'm46-missing', written: 'm46-written', none: 'm46-none', unreadable: 'm46-unreadable' };
  const add = (id, pref, idx) => db().run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,preferred_name_enc,preferred_name_idx) VALUES(?,?,?,?,?,?)`, id, id, encrypt('Ana'), encrypt('Lopez'), pref, idx);
  add(ids.missing, encrypt('Annie'), null);
  add(ids.written, encrypt('Nita'), 'kept-as-written');
  add(ids.none, null, null);
  add(ids.unreadable, 'not-ciphertext', null);
  // Run migration 46 again, as an upgrade from 45 would.
  db().setSetting('schema_version', '45'); // the schema before migration 46, whatever comes after it
  d.close(); d.open(dbPath);
  const idx = (id) => db().one(`SELECT preferred_name_idx i FROM clients WHERE id=?`, id).i;
  assert.equal(idx(ids.missing), M.preferredNameIndex('Annie'), 'filled in from the decrypted name');
  assert.equal(idx(ids.written), 'kept-as-written', 'an index already written is left alone');
  assert.equal(idx(ids.none), null, 'no name, no index');
  assert.equal(idx(ids.unreadable), null, 'a row that cannot be decrypted keeps what it had');
  assert.equal(db().getSetting('schema_version'), String(d.LATEST_SCHEMA_VERSION));
  // A second run changes nothing.
  db().setSetting('schema_version', '45'); // the schema before migration 46, whatever comes after it
  d.close(); d.open(dbPath);
  assert.equal(idx(ids.missing), M.preferredNameIndex('Annie')); assert.equal(idx(ids.written), 'kept-as-written');
  for (const id of Object.values(ids)) db().run(`DELETE FROM clients WHERE id=?`, id);
});

// ---- Databases written by later releases ----
// 1.6.1 is not the only starting point a county has: each fixture below is a database a released SUDS created
// and wrote through its own API (test/fixtures/make-release-fixture.js: schema, the rows, indexes, triggers;
// fictional data, the test keys above). Each is upgraded to the current schema and must end structurally
// identical to a fresh install, with its records present and its ciphertext still readable.
// The --rich fixtures (1.11.0, and 1.13.0: schema 43, the last release before 1.14.0's migrations 44 to 46, so
// it is the starting point they are tested from) hold several rows in every table with an encrypted
// column, NULLs and text in other scripts among them: every value must still decrypt, to what it was, and every
// blind index must still match, after the upgrade. 1.15.3 (schema 48, --rich) is the starting point of 1.16.0's
// defaults; 1.16.4 (schema 48, --rich, made from 6491308, the released commit) is the newest: the release before
// 1.17.0, whose migrations 49 to 55 and first-start data logic are tested from a database it wrote (below, too).
// 1.18.0 (schema 57, --rich, made from 39e397e, the released commit) is the release before 1.19.0: its migrations
// 58 and 59 run on a database that already holds rows in the county tables of 56 and 57 (county_connection, a
// single-row table, holds its one row), and on sessions it opened (below).
for (const fixture of ['release-v1.9.4.sql', 'release-v1.11.0.sql', 'release-v1.13.0.sql', 'release-v1.15.3.sql', 'release-v1.16.4.sql', 'release-v1.18.0.sql']) {
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8');
  const expect = JSON.parse(/^-- expect: (.*)$/m.exec(sql)[1]);
  test(`a SUDS ${expect.version} database (schema ${expect.schema_version}) upgrades to the current schema with its records intact`, () => {
    const { decrypt } = require('../server/crypto');
    const fdir = fs.mkdtempSync(path.join(os.tmpdir(), `suds-migrate-${expect.version}-`));
    const fpath = path.join(fdir, 'suds.db');
    const d = new DatabaseSync(fpath);
    d.exec(sql);
    assert.equal(d.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get().value, String(expect.schema_version));
    const rowsBefore = Object.fromEntries(d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()
      .map(({ name }) => [name, d.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n]));
    // Every encrypted value the release wrote, decrypted before the upgrade: table -> column -> id -> plaintext.
    const plainBefore = {};
    for (const { name } of d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()) {
      const cols = d.prepare(`PRAGMA table_info("${name}")`).all().map((x) => x.name);
      if (!cols.includes('id')) continue;
      for (const col of cols.filter((x) => x.endsWith('_enc'))) {
        plainBefore[name] = plainBefore[name] || {};
        plainBefore[name][col] = Object.fromEntries(d.prepare(`SELECT id, "${col}" v FROM "${name}"`).all().map((r) => [r.id, r.v === null || r.v === '' ? r.v : decrypt(r.v)]));
      }
      // A plaintext column a later migration encrypts (court_orders.document_ref in 43, say): its values too.
      for (const col of cols.filter((x) => !x.endsWith('_enc') && !x.endsWith('_idx'))) {
        const rows = d.prepare(`SELECT id, "${col}" v FROM "${name}" WHERE typeof("${col}")='text'`).all();
        if (rows.length) { plainBefore[name] = plainBefore[name] || {}; plainBefore[name][`${col}_enc`] = plainBefore[name][`${col}_enc`] || Object.fromEntries(rows.map((r) => [r.id, r.v])); }
      }
    }
    const before = Object.fromEntries(Object.entries(plainBefore).map(([t, cols]) => [t, Object.fromEntries(Object.keys(cols).filter((c) => d.prepare(`PRAGMA table_info("${t}")`).all().some((x) => x.name === c)).map((c) => [c, true]))]));
    // And every blind index it wrote.
    const idxBefore = Object.fromEntries(d.prepare(`SELECT * FROM clients`).all().map((c) => [c.id, Object.fromEntries(Object.entries(c).filter(([k]) => k.endsWith('_idx')))]));
    d.close();

    require('../server/db').close();
    try {
      require('../server/db').open(fpath);
      assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
      assert.deepEqual(db().all('PRAGMA foreign_key_check'), []);
      assertSameShape(schemaShape(db().get()), freshShape(), expect.version);

      // Nothing was lost: every table the release had still holds at least as many rows (migrations may add
      // rows — an episode per client — never drop them).
      for (const [t, n] of Object.entries(rowsBefore)) {
        if (!db().one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t)) continue; // a table a migration folded into another
        assert.ok(db().one(`SELECT COUNT(*) n FROM "${t}"`).n >= n, `${t} kept its ${n} row(s)`);
      }
      const c = db().one(`SELECT * FROM clients WHERE id=?`, expect.client.id);
      assert.ok(c, 'the client is there');
      assert.equal(decrypt(c.first_name_enc), expect.client.first_name);
      assert.equal(decrypt(c.last_name_enc), expect.client.last_name);
      assert.equal(decrypt(c.dob_enc), expect.client.dob);
      const v = db().one(`SELECT * FROM interventions WHERE id=?`, expect.visit.id);
      assert.equal(decrypt(v.summary_enc), expect.visit.summary);
      assert.equal(v.naloxone_kits, expect.visit.naloxone_kits);
      assert.equal(decrypt(db().one(`SELECT content_enc FROM notes WHERE id=?`, expect.note.id).content_enc), expect.note.content);
      assert.equal(decrypt(db().one(`SELECT recipient_enc FROM consents WHERE id=?`, expect.consent.id).recipient_enc), expect.consent.recipient);
      const ref = db().one(`SELECT * FROM referrals WHERE id=?`, expect.referral.id);
      assert.equal(ref.resource_id, expect.referral.resource_id);
      assert.ok(db().one(`SELECT 1 FROM disclosures WHERE source_ref=?`, expect.referral.id), 'the referral\'s disclosure accounting survived');

      // Every encrypted value anywhere in the upgraded database still decrypts under the same key, including
      // the ones migrations moved out of plaintext columns.
      let checked = 0;
      for (const { name } of db().all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)) {
        const enc = db().all(`PRAGMA table_info("${name}")`).map((x) => x.name).filter((x) => x.endsWith('_enc'));
        for (const col of enc) for (const r of db().all(`SELECT "${col}" v FROM "${name}" WHERE "${col}" IS NOT NULL AND "${col}" != ''`)) {
          assert.doesNotThrow(() => decrypt(r.v), `${name}.${col} decrypts`); checked++;
        }
      }
      assert.ok(checked >= 6, `${checked} encrypted values checked`);
      // ... to exactly what it was, and every NULL is still NULL (a migration that re-encrypts a column must not
      // lose a value or invent one).
      let same = 0; let migrated = 0;
      for (const [t, cols] of Object.entries(plainBefore)) {
        if (!db().one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t)) continue;
        const now = new Set(db().all(`PRAGMA table_info("${t}")`).map((x) => x.name));
        for (const [col, byId] of Object.entries(cols)) {
          if (!now.has(col)) continue; // a column a migration moved or folded
          // A plaintext column's values are compared only where a migration encrypted the column (it is gone).
          if (!Object.prototype.hasOwnProperty.call(before[t] || {}, col) && now.has(col.slice(0, -4))) continue;
          for (const [id, v] of Object.entries(byId)) {
            const r = db().one(`SELECT "${col}" v FROM "${t}" WHERE id=?`, id);
            if (!r) continue;
            assert.equal(r.v === null || r.v === '' ? r.v : decrypt(r.v), v, `${t}.${col} of ${id} after the upgrade`); same++;
            if (!Object.prototype.hasOwnProperty.call(before[t] || {}, col) && v) migrated++;
          }
        }
      }
      assert.ok(same >= checked, `${same} values compared with the release's own`);
      // Migration 43 encrypted the document references a 1.11.0 database holds in plaintext: they arrive intact.
      if (expect.rich && expect.schema_version < 43) assert.ok(migrated >= 2, `${migrated} plaintext values a migration encrypted, compared`);
      // Every blind index matches the value it indexes after the upgrade - as the release wrote it, or as a
      // migration recomputed it (the name indexes of names in other scripts were, between 1.11.0 and 1.13.0) - or
      // a search would stop finding a client. 1.13.0's sample data wrote no preferred-name index (server/demo.js,
      // fixed in 1.14.0): migration 46 fills it in, and it is checked like the rest.
      const M = require('../server/clients-model');
      let indexed = 0; let backfilled = 0;
      for (const c of db().all(`SELECT * FROM clients`)) {
        const plain = { first_name: c.first_name_enc && decrypt(c.first_name_enc), last_name: c.last_name_enc && decrypt(c.last_name_enc), preferred_name: c.preferred_name_enc ? decrypt(c.preferred_name_enc) : null, dob: c.dob_enc ? decrypt(c.dob_enc) : null, phone: c.phone_enc ? decrypt(c.phone_enc) : null };
        const was = idxBefore[c.id] || {};
        for (const [col, v] of Object.entries(M.clientIndexes(plain))) {
          if (!(col in c)) continue;
          if (col === 'preferred_name_idx' && v !== null && was[col] === null) backfilled++;
          assert.equal(c[col], v, `clients.${col} of ${c.client_code} matches its value after the upgrade`); indexed++;
        }
      }
      assert.ok(indexed >= 9, `${indexed} blind indexes checked`);
      if (expect.version === '1.13.0') assert.ok(backfilled > 0, `migration 46 wrote the preferred-name index the sample data left out (${backfilled})`);
      if (expect.rich) {
        // Several rows in every table the release had with an encrypted column, each column holding a value in
        // some row; text in other scripts among them.
        for (const [t, n] of Object.entries(expect.rich.encTables)) {
          assert.ok(n >= ((expect.rich.singletons || []).includes(t) ? 1 : 3), `the fixture has ${n} rows in ${t}`);
          if (!db().one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t)) continue;
          for (const col of db().all(`PRAGMA table_info("${t}")`).map((x) => x.name).filter((x) => x.endsWith('_enc') && plainBefore[t] && x in plainBefore[t])) {
            assert.ok(Object.values(plainBefore[t][col]).some((v) => v !== null && v !== ''), `${t}.${col} holds a value in some row`);
          }
        }
        assert.ok(Object.values(plainBefore).some((cols) => Object.values(cols).some((byId) => Object.values(byId).some((v) => v === null))), 'and NULLs');
        for (const u of expect.rich.unicodeClients) {
          const c = db().one(`SELECT * FROM clients WHERE id=?`, u.id);
          assert.equal(decrypt(c.first_name_enc), u.first_name); assert.equal(decrypt(c.last_name_enc), u.last_name);
          // Found by name after the upgrade, as a search would.
          assert.equal(c.last_name_idx, M.clientIndexes({ last_name: u.last_name }).last_name_idx);
        }
        assert.ok(expect.rich.unicodeClients.some((u) => /[^\x00-\x7f]/.test(u.first_name + u.last_name)));
      }
      // The audit chain that release wrote still verifies after the upgrade.
      assert.equal(require('../server/audit').verifyChain().ok, true, 'the audit chain verifies');
    } finally {
      require('../server/db').close();
      require('../server/db').open(dbPath);
      fs.rmSync(fdir, { recursive: true, force: true });
    }
  });
}

// 1.17.0's first start on a 1.16.4 database (engineering review of the 1.17.0 candidate, M3): beyond the schema, the
// data logic that runs once. The least-privilege default is recorded off (an upgrade changes nobody's access), the
// permission overrides are as they were, the retention pass clears the text of an import item already filed as a
// note (and keeps the staged ones'), and migration 55 gives every existing CalOMS submission its defaults (produced,
// by hand). Then the database is structurally what a fresh install is.
test('SUDS 1.17.0\'s first start on a 1.16.4 database: caseload default off, access unchanged, filed import text cleared, CalOMS submissions defaulted', () => {
  const { decrypt } = require('../server/crypto');
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-v1.16.4.sql'), 'utf8');
  const expect = JSON.parse(/^-- expect: (.*)$/m.exec(sql)[1]);
  assert.equal(expect.version, '1.16.4'); assert.equal(expect.schema_version, 48);
  const st = expect.state;
  assert.ok(st && st.overrides.length && st.committed_import_item && st.staged_import_items.length && st.caloms_submissions.length, 'the fixture holds the state checked here');
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-first-start-1.16.4-'));
  const fpath = path.join(fdir, 'suds.db');
  const d = new DatabaseSync(fpath);
  d.exec(sql);
  assert.equal(d.prepare(`SELECT value FROM settings WHERE key='caseload_hold_new_staff'`).get(), undefined, '1.16.4 had no such setting');
  const usersBefore = d.prepare(`SELECT id, role, access_status FROM users ORDER BY id`).all().map((r) => ({ ...r }));
  const overridesBefore = d.prepare(`SELECT user_id, permission, mode, reason FROM user_permission_overrides ORDER BY user_id, permission`).all().map((r) => ({ ...r }));
  const stagedBefore = Object.fromEntries(d.prepare(`SELECT id, content_enc FROM import_items WHERE status='staged'`).all().map((r) => [r.id, r.content_enc]));
  assert.ok(decrypt(d.prepare(`SELECT content_enc FROM import_items WHERE id=?`).get(st.committed_import_item).content_enc).length > 0, 'the filed item still holds its text before the upgrade');
  d.close();
  require('../server/db').close();
  try {
    require('../server/db').open(fpath);
    assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
    assertSameShape(schemaShape(db().get()), freshShape(), '1.16.4 (first start)');
    // The least-privilege default: off, recorded once, so no account is held to its caseload by the upgrade.
    assert.equal(db().getSetting('caseload_hold_new_staff'), '0');
    assert.equal(require('../server/caseload-default').enabled(), false);
    assert.deepEqual(db().all(`SELECT id, role, access_status FROM users ORDER BY id`).map((r) => ({ ...r })), usersBefore, 'every account keeps its role and status');
    assert.deepEqual(db().all(`SELECT user_id, permission, mode, reason FROM user_permission_overrides ORDER BY user_id, permission`).map((r) => ({ ...r })), overridesBefore, 'and its permission overrides: none added, none removed');
    // A first start that runs again (a restart) changes nothing more.
    require('../server/db').close(); require('../server/db').open(fpath);
    assert.equal(db().getSetting('caseload_hold_new_staff'), '0');
    // Migration 55: every existing submission was produced by hand.
    for (const id of st.caloms_submissions) {
      const r = db().one(`SELECT status, origin, provider_id, record_ids, uploaded_at, uploaded_by, dhcs_reference FROM caloms_submissions WHERE id=?`, id);
      assert.deepEqual({ ...r }, { status: 'produced', origin: 'manual', provider_id: null, record_ids: null, uploaded_at: null, uploaded_by: null, dhcs_reference: null }, `submission ${id}`);
    }
    assert.equal(db().one(`SELECT COUNT(*) n FROM caloms_submission_events`).n, 0);
    assert.equal(db().one(`SELECT COUNT(*) n FROM referral_links`).n, 0);
    // The retention pass (the server's housekeeping runs it once a day, first at start): the filed item's text goes.
    db().run(`DELETE FROM settings WHERE key='client_retention_ran_at'`);
    const R = require('../server/retention');
    R.runIfDue();
    const filed = db().one(`SELECT content_enc, title_enc, metadata_enc, status FROM import_items WHERE id=?`, st.committed_import_item);
    assert.deepEqual({ ...filed }, { content_enc: '', title_enc: null, metadata_enc: null, status: 'committed' }, 'the text of an item filed as a note is cleared');
    for (const [id, enc] of Object.entries(stagedBefore)) assert.equal(db().one(`SELECT content_enc FROM import_items WHERE id=?`, id).content_enc, enc, 'a staged item keeps its text');
    assert.ok(db().one(`SELECT 1 FROM audit_log WHERE action='import.committed_text_cleared'`), 'and it is audited');
    assert.equal(require('../server/audit').verifyChain().ok, true, 'the audit chain verifies');
  } finally {
    require('../server/db').close();
    require('../server/db').open(dbPath);
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

// SUDS 1.19.0's first start on a 1.18.0 database (upgrade drill of 1.19.0, docs/evidence/upgrade-drill-2026-09-30):
// migrations 58 and 59 add sessions.reauth_method, passkey_id and sync_client to a table that holds rows. A session
// 1.18.0 opened must still sign its holder in afterwards (nobody is signed out by the upgrade), read as a browser's
// (sync_client 0: its second factor, if any, was 1.18.0's own), with no passkey and no recorded re-authentication
// method; a session still owing its second factor still owes it. The county rows 1.18.0 wrote are all still there.
test('SUDS 1.19.0\'s first start on a 1.18.0 database: sessions it opened survive migrations 58 and 59 as browser sessions, county rows intact', () => {
  const { sha256, decrypt } = require('../server/crypto');
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-v1.18.0.sql'), 'utf8');
  const expect = JSON.parse(/^-- expect: (.*)$/m.exec(sql)[1]);
  assert.equal(expect.version, '1.18.0'); assert.equal(expect.schema_version, 57);
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-first-start-1.18.0-'));
  const fpath = path.join(fdir, 'suds.db');
  const d = new DatabaseSync(fpath);
  d.exec(sql);
  const cols = d.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
  for (const c of ['reauth_method', 'passkey_id', 'sync_client']) assert.ok(!cols.includes(c), `1.18.0 had no sessions.${c}`);
  const user = d.prepare(`SELECT id FROM users WHERE is_active=1 AND role='navigator' ORDER BY rowid LIMIT 1`).get();
  const now = new Date(); const later = new Date(now.getTime() + 8 * 3600_000);
  const tokens = { signedIn: 'fixture-session-signed-in', owesCode: 'fixture-session-owes-code' };
  const ins = d.prepare(`INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_pending,ip,user_agent,mfa_source,reauth_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  ins.run(sha256(tokens.signedIn), user.id, now.toISOString(), now.toISOString(), later.toISOString(), 0, '127.0.0.1', 'fixture', null, now.toISOString());
  ins.run(sha256(tokens.owesCode), user.id, now.toISOString(), now.toISOString(), later.toISOString(), 1, '127.0.0.1', 'fixture', null, null);
  const county = Object.fromEntries(['county_signing_keys', 'county_programmes', 'county_programme_keys', 'county_submissions', 'county_connect_tokens', 'county_connection', 'county_connect_sends']
    .map((t) => [t, d.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
  const conn = d.prepare(`SELECT token_enc FROM county_connection WHERE id='county'`).get();
  assert.ok(conn, 'the fixture holds the county connection row');
  const token = decrypt(conn.token_enc);
  d.close();
  require('../server/db').close();
  try {
    require('../server/db').open(fpath);
    assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
    assertSameShape(schemaShape(db().get()), freshShape(), '1.18.0 (first start)');
    for (const t of ['signedIn', 'owesCode']) {
      const s = db().one(`SELECT sync_client, reauth_method, passkey_id, mfa_pending, revoked_at FROM sessions WHERE id=?`, sha256(tokens[t]));
      assert.deepEqual({ ...s }, { sync_client: 0, reauth_method: null, passkey_id: null, mfa_pending: t === 'owesCode' ? 1 : 0, revoked_at: null }, `the ${t} session after migrations 58 and 59`);
    }
    const auth = require('../server/auth');
    const ctx = { cookies: { suds_session: tokens.signedIn }, headers: {} };
    const u = auth.resolveSession(ctx);
    assert.equal(u && u.id, user.id, 'a session 1.18.0 opened still signs its holder in');
    assert.equal(ctx.session.sync_client, 0);
    const pending = { cookies: { suds_session: tokens.owesCode }, headers: {} };
    auth.resolveSession(pending);
    assert.equal(pending.session.mfa_pending, 1, 'and one still owing its second factor still owes it');
    for (const t of ['passkeys', 'webauthn_challenges', 'signature_evidence']) assert.equal(db().one(`SELECT COUNT(*) n FROM "${t}"`).n, 0, `${t} starts empty`);
    for (const [t, n] of Object.entries(county)) assert.equal(db().one(`SELECT COUNT(*) n FROM "${t}"`).n, n, `${t} keeps its ${n} row(s)`);
    assert.equal(decrypt(db().one(`SELECT token_enc FROM county_connection WHERE id='county'`).token_enc), token, 'the county connection token still decrypts to what it was');
    assert.equal(require('../server/audit').verifyChain().ok, true, 'the audit chain verifies');
  } finally {
    require('../server/db').close();
    require('../server/db').open(dbPath);
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

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
// single-row table, holds its one row), and on sessions it opened (below). 1.19.0 (schema 59, --rich, made from
// 3dc20dc, the released commit) is the release before 1.20.0: migration 60 rebuilds county_submissions while it holds
// the signed rows --rich made there, and adds county_programmes.on_suds to programmes that exist. 1.20.0 (schema 60,
// --rich, made from 8f365b4, the released commit) is the release before 1.21.0: migrations 61 to 63 run on a database
// whose county_submissions holds signed rows and a county-entered one that 1.20.0 wrote through its own API. 1.22.0
// (schema 66, --rich, made from 8b136df, the commit after its stamp that adds its SBOM) is the release before 1.23.0:
// migration 67 runs on a database whose county publication tables hold releases, a withdrawal, consents and inputs that
// 1.22.0 wrote through its own API.
for (const fixture of ['release-v1.9.4.sql', 'release-v1.11.0.sql', 'release-v1.13.0.sql', 'release-v1.15.3.sql', 'release-v1.16.4.sql', 'release-v1.18.0.sql', 'release-v1.19.0.sql', 'release-v1.20.0.sql', 'release-v1.22.0.sql']) {
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

// SUDS 1.20.0's first start on a 1.19.0 database (upgrade drill of 1.20.0, docs/evidence/upgrade-drill-2026-09-30-v1.20.0):
// the database 1.19.0 wrote itself (release-v1.19.0.sql), with signed county submissions in county_submissions and
// sessions 1.19.0 opened. Migration 60 rebuilds county_submissions (the only way SQLite relaxes NOT NULL): every row
// must come through as a signed one with its key, signature, hash and encrypted payload unchanged, every programme
// gets on_suds 1, the sessions still sign their holders in, and the audit chain still verifies.
test('SUDS 1.20.0\'s first start on a 1.19.0 database: county submissions survive migration 60 as signed, sessions survive, audit chain verifies', () => {
  const { sha256, decrypt } = require('../server/crypto');
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-v1.19.0.sql'), 'utf8');
  const expect = JSON.parse(/^-- expect: (.*)$/m.exec(sql)[1]);
  assert.equal(expect.version, '1.19.0'); assert.equal(expect.schema_version, 59);
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-first-start-1.19.0-'));
  const fpath = path.join(fdir, 'suds.db');
  const d = new DatabaseSync(fpath);
  d.exec(sql);
  const subCols = d.prepare(`PRAGMA table_info(county_submissions)`).all();
  assert.ok(!subCols.some((c) => c.name === 'source'), '1.19.0 had no county_submissions.source');
  assert.equal(subCols.find((c) => c.name === 'key_id').notnull, 1, '1.19.0 required a key on every submission');
  assert.ok(!d.prepare(`PRAGMA table_info(county_programmes)`).all().some((c) => c.name === 'on_suds'), '1.19.0 had no county_programmes.on_suds');
  const subsBefore = d.prepare(`SELECT id, programme_id, key_id, period_from, period_to, sha256, signature, superseded_by, withdrawn_at, payload_enc FROM county_submissions ORDER BY id`).all().map((r) => ({ ...r }));
  assert.ok(subsBefore.length >= 3, `the fixture holds ${subsBefore.length} county submissions`);
  assert.ok(subsBefore.every((r) => r.key_id && r.signature), 'each one signed, as 1.19.0 required');
  const payloads = Object.fromEntries(subsBefore.map((r) => [r.id, decrypt(r.payload_enc)]));
  const programmes = d.prepare(`SELECT id FROM county_programmes ORDER BY id`).all().map((r) => r.id);
  assert.ok(programmes.length >= 1);
  // Sessions 1.19.0 opened: one signed in (its second factor a passkey, as 1.19.0 recorded it), one still owing its code.
  const user = d.prepare(`SELECT id FROM users WHERE is_active=1 AND role='navigator' ORDER BY rowid LIMIT 1`).get();
  const now = new Date(); const later = new Date(now.getTime() + 8 * 3600_000);
  const tokens = { signedIn: 'fixture-1.19-signed-in', owesCode: 'fixture-1.19-owes-code' };
  const ins = d.prepare(`INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_pending,ip,user_agent,mfa_source,reauth_at,reauth_method,passkey_id,sync_client) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(sha256(tokens.signedIn), user.id, now.toISOString(), now.toISOString(), later.toISOString(), 0, '127.0.0.1', 'fixture', null, now.toISOString(), 'totp', null, 0);
  ins.run(sha256(tokens.owesCode), user.id, now.toISOString(), now.toISOString(), later.toISOString(), 1, '127.0.0.1', 'fixture', null, null, null, null, 0);
  const auditBefore = d.prepare(`SELECT COUNT(*) n FROM audit_log`).get().n;
  d.close();
  require('../server/db').close();
  try {
    require('../server/db').open(fpath);
    assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
    assertSameShape(schemaShape(db().get()), freshShape(), '1.19.0 (first start)');
    const after = db().all(`SELECT id, programme_id, key_id, period_from, period_to, sha256, signature, superseded_by, withdrawn_at, payload_enc, source, entered_via, source_ref_enc FROM county_submissions ORDER BY id`).map((r) => ({ ...r }));
    assert.deepEqual(after, subsBefore.map((r) => ({ ...r, source: 'signed', entered_via: null, source_ref_enc: null })), 'every submission kept, unchanged, as a signed one');
    for (const r of after) assert.equal(decrypt(r.payload_enc), payloads[r.id], `submission ${r.id}'s payload still decrypts to what it was`);
    assert.deepEqual(db().all(`SELECT id, on_suds FROM county_programmes ORDER BY id`).map((r) => ({ ...r })), programmes.map((id) => ({ id, on_suds: 1 })), 'every programme registered so far is on SUDS');
    assert.deepEqual(db().all('PRAGMA foreign_key_check'), []);
    for (const t of ['signedIn', 'owesCode']) {
      const s = db().one(`SELECT mfa_pending, revoked_at, reauth_method, sync_client FROM sessions WHERE id=?`, sha256(tokens[t]));
      assert.deepEqual({ ...s }, { mfa_pending: t === 'owesCode' ? 1 : 0, revoked_at: null, reauth_method: t === 'signedIn' ? 'totp' : null, sync_client: 0 }, `the ${t} session after migration 60`);
    }
    const auth = require('../server/auth');
    const ctx = { cookies: { suds_session: tokens.signedIn }, headers: {} };
    assert.equal((auth.resolveSession(ctx) || {}).id, user.id, 'a session 1.19.0 opened still signs its holder in');
    const pending = { cookies: { suds_session: tokens.owesCode }, headers: {} };
    auth.resolveSession(pending);
    assert.equal(pending.session.mfa_pending, 1, 'and one still owing its second factor still owes it');
    const chain = require('../server/audit').verifyChain();
    assert.equal(chain.ok, true, 'the audit chain verifies');
    assert.ok(chain.checked >= auditBefore, `every audit entry 1.19.0 wrote is checked (${chain.checked} >= ${auditBefore})`);
  } finally {
    require('../server/db').close();
    require('../server/db').open(dbPath);
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

// SUDS 1.21.0's first start on a 1.20.0 database (upgrade drill of 1.21.0, docs/evidence/upgrade-drill-2026-10-01-v1.21.0):
// the database 1.20.0 wrote itself (release-v1.20.0.sql), whose county_submissions holds signed files it imported and a
// quarter its county entered for a programme not on SUDS, with a passkey, a sync device and sessions 1.20.0 opened
// (a passkey sign-in, one still owing its code, a device's sync sign-in). Migrations 61 to 63 add county_publications,
// devices.sync_scope ('full' for every existing device), sessions.device_id, clients.participant_code_enc/_idx,
// passkeys.attestation and authenticator_metadata: every county row must come through unchanged, the sessions still
// sign their holders in, the defaults are the ones that change nothing, and the audit chain still verifies.
test('SUDS 1.21.0\'s first start on a 1.20.0 database: county rows (a county-entered one too) survive, sessions survive, audit chain verifies', () => {
  const { sha256, decrypt } = require('../server/crypto');
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-v1.20.0.sql'), 'utf8');
  const expect = JSON.parse(/^-- expect: (.*)$/m.exec(sql)[1]);
  assert.equal(expect.version, '1.20.0'); assert.equal(expect.schema_version, 60);
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-first-start-1.20.0-'));
  const fpath = path.join(fdir, 'suds.db');
  const d = new DatabaseSync(fpath);
  d.exec(sql);
  const colsIn = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(!colsIn('devices').includes('sync_scope'), '1.20.0 had no devices.sync_scope');
  assert.ok(!colsIn('sessions').includes('device_id'), '1.20.0 had no sessions.device_id');
  assert.ok(!colsIn('clients').includes('participant_code_enc'), '1.20.0 had no participant codes');
  assert.ok(!colsIn('passkeys').includes('attestation'), '1.20.0 had no passkeys.attestation');
  for (const t of ['county_publications', 'authenticator_metadata']) assert.ok(!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t), `1.20.0 had no ${t}`);
  const SUBS = `SELECT id, programme_id, key_id, period_from, period_to, sha256, signature, superseded_by, withdrawn_at, payload_enc, source, entered_via, source_ref_enc FROM county_submissions ORDER BY id`;
  const subsBefore = d.prepare(SUBS).all().map((r) => ({ ...r }));
  const signed = subsBefore.filter((r) => r.source === 'signed'); const entered = subsBefore.filter((r) => r.source === 'county_entered');
  assert.ok(signed.length >= 3 && signed.every((r) => r.key_id && r.signature), `the fixture holds ${signed.length} signed county submissions, each with its key and signature`);
  assert.ok(signed.some((r) => r.superseded_by), 'one of them superseded by a later file');
  assert.equal(entered.length, 1, 'and one quarter the county entered');
  assert.ok(entered[0].key_id === null && entered[0].signature === null && entered[0].entered_via && entered[0].source_ref_enc, 'entered: no key, no signature, how it was entered and where it came from');
  const payloads = Object.fromEntries(subsBefore.map((r) => [r.id, decrypt(r.payload_enc)]));
  const sourceRef = decrypt(entered[0].source_ref_enc);
  const programmes = d.prepare(`SELECT id, on_suds FROM county_programmes ORDER BY id`).all().map((r) => ({ ...r }));
  assert.deepEqual(programmes.map((p) => p.on_suds).sort(), [0, 1], 'a programme on SUDS and one not');
  // What 1.20.0 held for a person signing in: a passkey, a sync device, and three sessions.
  const user = d.prepare(`SELECT id FROM users WHERE is_active=1 AND role='navigator' ORDER BY rowid LIMIT 1`).get();
  const now = new Date(); const later = new Date(now.getTime() + 8 * 3600_000);
  d.prepare(`INSERT INTO passkeys(id,user_id,credential_id,public_key,alg,sign_count,rp_id,name) VALUES(?,?,?,?,?,?,?,?)`).run('fixture-passkey', user.id, 'Y3JlZC1maXh0dXJl', 'MFkwEwYHKoZIzj0CAQ', -7, 4, 'suds.example.org', 'Fixture phone');
  d.prepare(`INSERT INTO devices(id,user_id,label,last_ip,sync_count) VALUES(?,?,?,?,?)`).run('fixture-device', user.id, 'Android phone', '10.0.0.7', 12);
  const passkeyBefore = { ...d.prepare(`SELECT * FROM passkeys WHERE id='fixture-passkey'`).get() };
  const deviceBefore = { ...d.prepare(`SELECT * FROM devices WHERE id='fixture-device'`).get() };
  const tokens = { passkey: 'fixture-1.20-passkey', owesCode: 'fixture-1.20-owes-code', device: 'fixture-1.20-device' };
  const ins = d.prepare(`INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_pending,ip,user_agent,mfa_source,reauth_at,reauth_method,passkey_id,sync_client) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(sha256(tokens.passkey), user.id, now.toISOString(), now.toISOString(), later.toISOString(), 0, '127.0.0.1', 'fixture', null, now.toISOString(), 'passkey', 'fixture-passkey', 0);
  ins.run(sha256(tokens.owesCode), user.id, now.toISOString(), now.toISOString(), later.toISOString(), 1, '127.0.0.1', 'fixture', null, null, null, null, 0);
  ins.run(sha256(tokens.device), user.id, now.toISOString(), now.toISOString(), later.toISOString(), 0, '10.0.0.7', 'fixture device', null, now.toISOString(), 'password', null, 1);
  const auditBefore = d.prepare(`SELECT COUNT(*) n FROM audit_log`).get().n;
  d.close();
  require('../server/db').close();
  try {
    require('../server/db').open(fpath);
    assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
    assertSameShape(schemaShape(db().get()), freshShape(), '1.20.0 (first start)');
    assert.deepEqual(db().all(SUBS).map((r) => ({ ...r })), subsBefore, 'every county submission kept unchanged: the signed ones and the county-entered one');
    for (const r of subsBefore) assert.equal(decrypt(db().one(`SELECT payload_enc FROM county_submissions WHERE id=?`, r.id).payload_enc), payloads[r.id], `submission ${r.id}'s payload still decrypts to what it was`);
    assert.equal(decrypt(db().one(`SELECT source_ref_enc FROM county_submissions WHERE id=?`, entered[0].id).source_ref_enc), sourceRef, 'the entered quarter\'s source still decrypts');
    assert.deepEqual(db().all(`SELECT id, on_suds FROM county_programmes ORDER BY id`).map((r) => ({ ...r })), programmes, 'each programme keeps on_suds');
    assert.deepEqual(db().all('PRAGMA foreign_key_check'), []);
    // Migrations 61 and 63: the new tables, empty.
    for (const t of ['county_publications', 'authenticator_metadata']) assert.equal(db().one(`SELECT COUNT(*) n FROM "${t}"`).n, 0, `${t} exists and starts empty`);
    // Migration 62: the device keeps everything and syncs everything (full); no client has a participant code.
    // (Columns later migrations add, such as 64's scope_set_by, are those migrations' tests to check.)
    const want = { ...deviceBefore, sync_scope: 'full', scope_changed_at: null, field_applied_at: null };
    const got = db().one(`SELECT * FROM devices WHERE id='fixture-device'`);
    const dev = Object.fromEntries(Object.keys(want).map(k => [k, got[k]]));
    assert.deepEqual(dev, want, 'the device: unchanged, scope full');
    assert.equal(db().one(`SELECT COUNT(*) n FROM clients WHERE participant_code_enc IS NOT NULL OR participant_code_idx IS NOT NULL`).n, 0, 'no client has a participant code');
    // Migration 63: the passkey keeps everything, with no attestation (none was attested before the allow-list).
    const pkWant = { ...passkeyBefore, attestation: null };
    const pkGot = db().one(`SELECT * FROM passkeys WHERE id='fixture-passkey'`);
    assert.deepEqual(Object.fromEntries(Object.keys(pkWant).map(k => [k, pkGot[k]])), pkWant, 'the passkey: unchanged, unattested');
    const S = (t) => ({ ...db().one(`SELECT mfa_pending, revoked_at, reauth_method, passkey_id, sync_client, device_id FROM sessions WHERE id=?`, sha256(tokens[t])) });
    assert.deepEqual(S('passkey'), { mfa_pending: 0, revoked_at: null, reauth_method: 'passkey', passkey_id: 'fixture-passkey', sync_client: 0, device_id: null }, 'the passkey session after migrations 61-63');
    assert.deepEqual(S('owesCode'), { mfa_pending: 1, revoked_at: null, reauth_method: null, passkey_id: null, sync_client: 0, device_id: null }, 'the session owing its code');
    assert.deepEqual(S('device'), { mfa_pending: 0, revoked_at: null, reauth_method: 'password', passkey_id: null, sync_client: 1, device_id: null }, 'the device\'s sync session: no device_id (it predates the column)');
    const auth = require('../server/auth');
    const ctx = { cookies: { suds_session: tokens.passkey }, headers: {} };
    assert.equal((auth.resolveSession(ctx) || {}).id, user.id, 'a session 1.20.0 opened with a passkey still signs its holder in');
    const pending = { cookies: { suds_session: tokens.owesCode }, headers: {} };
    auth.resolveSession(pending);
    assert.equal(pending.session.mfa_pending, 1, 'and one still owing its second factor still owes it');
    const chain = require('../server/audit').verifyChain();
    assert.equal(chain.ok, true, 'the audit chain verifies');
    assert.ok(chain.checked >= auditBefore, `every audit entry 1.20.0 wrote is checked (${chain.checked} >= ${auditBefore})`);
  } finally {
    require('../server/db').close();
    require('../server/db').open(dbPath);
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

// SUDS 1.23.0's first start on a 1.22.0 database (upgrade drill of 1.23.0, docs/evidence/upgrade-drill-2026-10-01-v1.23.0):
// the database 1.22.0 wrote itself (release-v1.22.0.sql), whose county tables hold signed files, a county-entered
// quarter, each programme's consent to publication (one withdrawn and recorded again), and releases with what they were
// screened from (one withdrawn, its corrected release, and another period), with what 1.22.0 held besides: a field
// device and its account held to the field scope, a whole device, an attested passkey and one in the allow-list's grace
// period, their sessions, a call and a visit with follow-up dates and the to-dos 1.22.0 made for them, and a
// supervisor's reminder to sign a draft. Migration 67 adds tasks.call_id and tasks.intervention_id only: every row is
// compared by the columns 1.22.0 had, the new columns are NULL, an old to-do is linked the first time its call is
// edited (by title and date), the reminder still closes, and the audit chain still verifies.
test('SUDS 1.23.0\'s first start on a 1.22.0 database: county consents, releases and inputs, field device, passkeys, follow-up to-dos and a reminder survive', () => {
  const { sha256, encrypt, decrypt, uuid } = require('../server/crypto');
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-v1.22.0.sql'), 'utf8');
  const expect = JSON.parse(/^-- expect: (.*)$/m.exec(sql)[1]);
  assert.equal(expect.version, '1.22.0'); assert.equal(expect.schema_version, 66);
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-first-start-1.22.0-'));
  const fpath = path.join(fdir, 'suds.db');
  const d = new DatabaseSync(fpath);
  d.exec(sql);
  const colsIn = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['call_id', 'intervention_id']) assert.ok(!colsIn('tasks').includes(c), `1.22.0 had no tasks.${c}`);
  assert.ok(colsIn('passkeys').includes('allowlist_grace_until') && colsIn('devices').includes('scope_set_by'), '1.22.0 had migrations 64 and 66');
  // The county publication tables as 1.22.0 wrote them through its own API.
  const pubs = d.prepare(`SELECT kind, release_id IS NOT NULL withdraws FROM county_publications ORDER BY created_at`).all().map((r) => `${r.kind}${r.withdraws ? ' of a release' : ''}`);
  assert.deepEqual(pubs, ['release', 'withdrawal of a release', 'release', 'release'], 'a release, its withdrawal, its corrected release and another period');
  assert.equal(d.prepare(`SELECT COUNT(*) n FROM county_publication_inputs`).get().n, 3, 'what each of the three releases was screened from');
  const consentsIn = d.prepare(`SELECT COUNT(*) n, SUM(withdrawn_at IS NOT NULL) withdrawn FROM county_publication_consents`).get();
  assert.ok(consentsIn.n >= 3 && consentsIn.withdrawn === 1, 'consents, one withdrawn');
  // What 1.22.0 held for its people and devices, written as 1.22.0 wrote them.
  const user = d.prepare(`SELECT id FROM users WHERE is_active=1 AND role='navigator' ORDER BY rowid LIMIT 1`).get();
  const sup = d.prepare(`SELECT id FROM users WHERE is_active=1 AND role='supervisor' ORDER BY rowid LIMIT 1`).get();
  const client = d.prepare(`SELECT id FROM clients ORDER BY rowid LIMIT 1`).get();
  const now = new Date(); const later = new Date(now.getTime() + 8 * 3600_000); const iso = (t) => new Date(t).toISOString();
  const graceUntil = iso(now.getTime() + 14 * 86400_000);
  const pk = d.prepare(`INSERT INTO passkeys(id,user_id,credential_id,public_key,alg,sign_count,rp_id,name,aaguid,attestation,allowlist_grace_until) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  pk.run('fixture-attested', user.id, 'Y3JlZC1hdHRlc3RlZA', 'MFkwEwYHKoZIzj0CAQ', -7, 3, 'suds.example.org', 'Listed key', 'd1a11d1a-0000-4000-8000-0000000c0123', JSON.stringify({ verified: true, fmt: 'packed', type: 'basic', aaguid: 'd1a11d1a-0000-4000-8000-0000000c0123', mds_no: 4000, verified_at: iso(now) }), null);
  pk.run('fixture-grace', sup.id, 'Y3JlZC1ncmFjZQ', 'MFkwEwYHKoZIzj0CAQ', -7, 1, 'suds.example.org', 'Phone from before the list', null, null, graceUntil);
  d.prepare(`INSERT INTO devices(id,user_id,label,last_ip,sync_count,sync_scope,scope_changed_at,field_applied_at,scope_set_by) VALUES(?,?,?,?,?,?,?,?,?)`).run('fixture-field', user.id, 'Android phone', '10.0.0.8', 5, 'field', iso(now), iso(now), 'admin');
  d.prepare(`INSERT INTO devices(id,user_id,label,last_ip,sync_count,sync_scope,scope_set_by) VALUES(?,?,?,?,?,?,?)`).run('fixture-whole', sup.id, 'Office tablet', '10.0.0.9', 9, 'full', 'default');
  d.prepare(`INSERT INTO field_accounts(user_id,bound_at,bound_via) VALUES(?,?,?)`).run(user.id, iso(now), 'admin');
  const tokens = { passkey: 'fixture-1.22-passkey', grace: 'fixture-1.22-grace', field: 'fixture-1.22-field-device' };
  const ins = d.prepare(`INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_pending,ip,user_agent,reauth_at,reauth_method,passkey_id,sync_client,device_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(sha256(tokens.passkey), user.id, iso(now), iso(now), iso(later), 0, '127.0.0.1', 'fixture', iso(now), 'passkey', 'fixture-attested', 0, null);
  ins.run(sha256(tokens.grace), sup.id, iso(now), iso(now), iso(later), 0, '127.0.0.1', 'fixture', iso(now), 'passkey', 'fixture-grace', 0, null);
  ins.run(sha256(tokens.field), user.id, iso(now), iso(now), iso(later), 0, '10.0.0.8', 'fixture device', iso(now), 'password', null, 1, 'fixture-field');
  // A call and a visit with follow-up dates, and the to-dos 1.22.0 made for them (routes/calls.js, interventions.js).
  const call = { id: uuid(), client_id: client.id, user_id: user.id, direction: 'outbound', method: 'phone', started_at: iso(now), purpose_enc: encrypt('MAT intake'), follow_up_needed: 1, follow_up_due: '2026-10-20' };
  d.prepare(`INSERT INTO calls(${Object.keys(call)}) VALUES(${Object.keys(call).map(() => '?')})`).run(...Object.values(call));
  const visit = { id: uuid(), client_id: client.id, user_id: user.id, type: 'case_management', occurred_at: iso(now), follow_up_due: '2026-10-21' };
  d.prepare(`INSERT INTO interventions(${Object.keys(visit)}) VALUES(${Object.keys(visit).map(() => '?')})`).run(...Object.values(visit));
  const task = d.prepare(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority) VALUES(?,?,?,?,?,?,?,?)`);
  const ids = { callTask: uuid(), visitTask: uuid(), reminder: uuid(), draft: uuid() };
  task.run(ids.callTask, client.id, user.id, user.id, encrypt('Call back: MAT intake'), null, '2026-10-20', 'normal');
  task.run(ids.visitTask, client.id, user.id, user.id, encrypt('Follow up: Case Management'), null, '2026-10-21', 'normal');
  // A supervisor's "Finish and sign your note" reminder for a draft (public/views/supervision.js).
  d.prepare(`INSERT INTO notes(id,client_id,author_id,kind,title_enc,content_enc,occurred_at) VALUES(?,?,?,?,?,?,?)`).run(ids.draft, client.id, user.id, 'admin', encrypt('Draft'), encrypt('Not signed yet'), iso(now));
  task.run(ids.reminder, client.id, user.id, sup.id, encrypt('Finish and sign your administrative note'), encrypt(`Asked to finish and sign this draft note.\nReference: supervision reminder for note ${ids.draft}`), '2026-10-01', 'normal');
  // Every row of these tables, by the columns 1.22.0 had.
  const KEEP = ['county_publications', 'county_publication_consents', 'county_publication_inputs', 'county_submissions', 'county_programmes', 'field_accounts', 'devices', 'passkeys', 'tasks'];
  const cols = Object.fromEntries(KEEP.map((t) => [t, colsIn(t)]));
  const rowsOf = (all, t) => all(`SELECT ${cols[t].map((c) => `"${c}"`).join(',')} FROM "${t}" ORDER BY rowid`).map((r) => ({ ...r }));
  const before = Object.fromEntries(KEEP.map((t) => [t, rowsOf((q) => d.prepare(q).all(), t)]));
  const plain = (t, c) => Object.fromEntries(before[t].filter((r) => r[c]).map((r) => [r.id, decrypt(r[c])]));
  const encBefore = { inputs: plain('county_publication_inputs', 'inputs_enc'), reasons: plain('county_publications', 'reason_enc'), references: plain('county_publication_consents', 'reference_enc') };
  const sessBefore = d.prepare(`SELECT id, user_id, mfa_pending, reauth_method, passkey_id, sync_client, device_id, revoked_at, expires_at FROM sessions ORDER BY id`).all().map((r) => ({ ...r }));
  const auditBefore = d.prepare(`SELECT COUNT(*) n FROM audit_log`).get().n;
  d.close();
  require('../server/db').close();
  try {
    require('../server/db').open(fpath);
    assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
    assertSameShape(schemaShape(db().get()), freshShape(), '1.22.0 (first start)');
    assert.deepEqual(db().all('PRAGMA foreign_key_check'), []);
    for (const t of KEEP) assert.deepEqual(rowsOf((q) => db().all(q), t), before[t], `every ${t} row 1.22.0 wrote, unchanged`);
    assert.deepEqual(db().all(`SELECT id, user_id, mfa_pending, reauth_method, passkey_id, sync_client, device_id, revoked_at, expires_at FROM sessions ORDER BY id`).map((r) => ({ ...r })), sessBefore, 'every session unchanged');
    const again = { inputs: Object.fromEntries(db().all(`SELECT id, inputs_enc v FROM county_publication_inputs`).map((r) => [r.id, decrypt(r.v)])),
      reasons: Object.fromEntries(db().all(`SELECT id, reason_enc v FROM county_publications WHERE reason_enc IS NOT NULL`).map((r) => [r.id, decrypt(r.v)])),
      references: Object.fromEntries(db().all(`SELECT id, reference_enc v FROM county_publication_consents WHERE reference_enc IS NOT NULL`).map((r) => [r.id, decrypt(r.v)])) };
    assert.deepEqual(again, encBefore, 'what each release was screened from, why one was withdrawn and each agreement\'s reference still decrypt to what they were');
    // Migration 67: the new columns, NULL on every to-do 1.22.0 made, and their indexes.
    assert.equal(db().one(`SELECT COUNT(*) n FROM tasks WHERE call_id IS NOT NULL OR intervention_id IS NOT NULL`).n, 0, 'no to-do linked yet');
    for (const i of ['idx_tasks_call', 'idx_tasks_intervention']) assert.ok(db().one(`SELECT 1 x FROM sqlite_master WHERE type='index' AND name=?`, i), i);
    // Migration 69 (built for 1.24.0): tasks.note_id, NULL on every to-do (the old reminder keeps opening the drafts
    // list, and still closes below), and running it again changes nothing.
    assert.ok(!cols.tasks.includes('note_id'), '1.22.0 had no tasks.note_id');
    assert.equal(db().one(`SELECT COUNT(*) n FROM tasks WHERE note_id IS NOT NULL`).n, 0, 'no reminder linked to a draft');
    const m69 = require('../server/db');
    assert.ok(db().all(`PRAGMA table_info(tasks)`).some((c) => c.name === 'note_id' && c.type === 'TEXT' && !c.notnull && c.dflt_value === null));
    assert.equal(m69.LATEST_SCHEMA_VERSION, 69);
    // The field scope still follows the account; the whole device stays whole.
    const DEV = require('../server/devices');
    assert.equal(DEV.accountFieldBound(user.id), true, 'the field device\'s account is still held to the field scope');
    assert.equal(DEV.effectiveField(user.id, db().one(`SELECT * FROM devices WHERE id='fixture-field'`)), true);
    assert.equal(DEV.effectiveField(sup.id, db().one(`SELECT * FROM devices WHERE id='fixture-whole'`)), false);
    // The sessions still sign their holders in (the passkey ones; a field device's is held to syncing).
    const auth = require('../server/auth');
    for (const [t, who] of [['passkey', user.id], ['grace', sup.id]]) assert.equal((auth.resolveSession({ cookies: { suds_session: tokens[t] }, headers: {} }) || {}).id, who, `the ${t} session still signs its holder in`);
    // Editing the call's follow-up date (1.23.0's rule): the to-do 1.22.0 made is found by title and date, linked and
    // moved, not duplicated; the visit's likewise.
    const FU = require('../server/rules/follow-ups');
    const c0 = db().one(`SELECT * FROM calls WHERE id=?`, call.id);
    db().run(`UPDATE calls SET follow_up_due='2026-10-27' WHERE id=?`, call.id);
    assert.equal(FU.reconcile('calls', db().one(`SELECT * FROM calls WHERE id=?`, call.id), c0, { user: { id: user.id, username: 'fixture' } }), 'moved');
    const v0 = db().one(`SELECT * FROM interventions WHERE id=?`, visit.id);
    db().run(`UPDATE interventions SET follow_up_due='2026-10-28' WHERE id=?`, visit.id);
    assert.equal(FU.reconcile('interventions', db().one(`SELECT * FROM interventions WHERE id=?`, visit.id), v0, { user: { id: user.id, username: 'fixture' } }), 'moved');
    assert.deepEqual({ ...db().one(`SELECT call_id, due_at, status FROM tasks WHERE id=?`, ids.callTask) }, { call_id: call.id, due_at: '2026-10-27', status: 'open' }, 'the call\'s to-do, linked and moved');
    assert.deepEqual({ ...db().one(`SELECT intervention_id, due_at, status FROM tasks WHERE id=?`, ids.visitTask) }, { intervention_id: visit.id, due_at: '2026-10-28', status: 'open' }, 'the visit\'s to-do, linked and moved');
    assert.equal(db().one(`SELECT COUNT(*) n FROM tasks`).n, before.tasks.length, 'no second to-do');
    // Signing the draft closes the supervisor's reminder (server/rules/notes.js).
    assert.deepEqual(require('../server/rules/notes').closeSignReminders(user.id, ids.draft, client.id), [ids.reminder], 'the reminder 1.22.0 held closes');
    const chain = require('../server/audit').verifyChain();
    assert.equal(chain.ok, true, 'the audit chain verifies');
    assert.ok(chain.checked >= auditBefore, `every audit entry 1.22.0 wrote is checked (${chain.checked} >= ${auditBefore})`);
  } finally {
    require('../server/db').close();
    require('../server/db').open(dbPath);
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

// Migration 60 (county-entered figures, released in 1.20.0) on a county's 1.19.0 database that already holds signed
// county submissions: county_submissions is rebuilt (key_id and signature may be NULL now, with source, entered_via,
// source_ref_enc and a CHECK), every existing row is kept as a signed one, and county_programmes gains on_suds (1).
test('migration 60: a county\'s signed submissions survive the rebuild as signed ones, and the table takes entered figures', () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-migrate-60-'));
  const fpath = path.join(fdir, 'suds.db');
  require('../server/db').close();
  try {
    require('../server/db').open(fpath); require('../server/db').close();
    // Back to 1.19.0's shape (schema 59): the table as migration 56 made it, and no on_suds.
    const d = new DatabaseSync(fpath);
    d.exec('DROP TABLE county_submissions');
    d.exec(`CREATE TABLE IF NOT EXISTS county_submissions (
  id TEXT PRIMARY KEY,
  programme_id TEXT NOT NULL REFERENCES county_programmes(id),
  key_id TEXT NOT NULL REFERENCES county_programme_keys(id),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  programme_name TEXT,
  generated_at TEXT NOT NULL,
  suds_version TEXT,
  payload_enc TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  received_by TEXT REFERENCES users(id),
  superseded_by TEXT REFERENCES county_submissions(id),
  withdrawn_at TEXT,
  withdrawn_by TEXT REFERENCES users(id),
  UNIQUE(programme_id, sha256)
)`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_county_submissions_programme ON county_submissions(programme_id, period_from, period_to)');
    d.exec('ALTER TABLE county_programmes DROP COLUMN on_suds');
    d.prepare(`INSERT INTO county_programmes(id,name) VALUES('p1','Riverbend')`).run();
    d.prepare(`INSERT INTO county_programme_keys(id,programme_id,public_key,fingerprint) VALUES('k1','p1','pem','f01')`).run();
    const ins = d.prepare(`INSERT INTO county_submissions(id,programme_id,key_id,period_from,period_to,schema_version,programme_name,generated_at,suds_version,payload_enc,sha256,signature,superseded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('s2', 'p1', 'k1', '2026-01-01', '2026-03-31', 1, 'Riverbend', '2026-04-03T00:00:00.000Z', '1.19.0', 'enc2', 'h2', 'sig2', null);
    ins.run('s1', 'p1', 'k1', '2026-01-01', '2026-03-31', 1, 'Riverbend', '2026-04-02T00:00:00.000Z', '1.19.0', 'enc1', 'h1', 'sig1', 's2');
    d.prepare(`UPDATE settings SET value='59' WHERE key='schema_version'`).run();
    d.close();
    require('../server/db').open(fpath);
    assert.equal(db().getSetting('schema_version'), String(require('../server/db').LATEST_SCHEMA_VERSION));
    assertSameShape(schemaShape(db().get()), freshShape(), '1.19.0 with county submissions');
    const rows = db().all(`SELECT id, key_id, signature, superseded_by, source, entered_via, source_ref_enc, payload_enc FROM county_submissions ORDER BY id`).map(r => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 's1', key_id: 'k1', signature: 'sig1', superseded_by: 's2', source: 'signed', entered_via: null, source_ref_enc: null, payload_enc: 'enc1' },
      { id: 's2', key_id: 'k1', signature: 'sig2', superseded_by: null, source: 'signed', entered_via: null, source_ref_enc: null, payload_enc: 'enc2' },
    ], 'every row kept, as signed');
    assert.equal(db().one(`SELECT on_suds FROM county_programmes WHERE id='p1'`).on_suds, 1);
    assert.deepEqual(db().all('PRAGMA foreign_key_check'), []);
    // The rebuilt table takes figures the county entered, and refuses a signed row with no key or an entered one with one.
    db().run(`INSERT INTO county_submissions(id,programme_id,key_id,period_from,period_to,schema_version,generated_at,payload_enc,sha256,signature,source,entered_via) VALUES('e1','p1',NULL,'2026-04-01','2026-06-30',1,'x','enc','h3',NULL,'county_entered','form')`);
    assert.throws(() => db().run(`INSERT INTO county_submissions(id,programme_id,key_id,period_from,period_to,schema_version,generated_at,payload_enc,sha256,signature) VALUES('x1','p1',NULL,'2026-04-01','2026-06-30',1,'x','enc','h4',NULL)`), /CHECK/);
    assert.throws(() => db().run(`INSERT INTO county_submissions(id,programme_id,key_id,period_from,period_to,schema_version,generated_at,payload_enc,sha256,signature,source,entered_via) VALUES('x2','p1','k1','2026-04-01','2026-06-30',1,'x','enc','h5','sig','county_entered','csv')`), /CHECK/);
    // A second start changes nothing (idempotent).
    require('../server/db').close(); require('../server/db').open(fpath);
    assert.equal(db().one(`SELECT COUNT(*) n FROM county_submissions`).n, 3);
  } finally {
    require('../server/db').close();
    require('../server/db').open(dbPath);
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

'use strict';
// Upgrading a real county database is the one operation that cannot be retried, so it gets its own test.
// test/fixtures/schema-v4.sql is the schema exactly as SUDS 1.6.1 left it.
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
  ids.user = uuid(); ids.client = uuid(); ids.note = uuid(); ids.consent = uuid(); ids.disclosure = uuid(); ids.intervention = uuid();
  d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`).run(ids.user, 'u1', 'x', 'U One', 'navigator');
  d.prepare(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,goals,flags,intake_date,status,created_by) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(ids.client, 'M26-0001', encrypt('Ada'), encrypt('Lovelace'), 'Housing, then MAT induction', 'od_risk,no_voicemail', '2026-01-05', 'active', ids.user);
  d.prepare(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,summary) VALUES(?,?,?,?,?,?)`)
    .run(ids.intervention, ids.client, ids.user, 'outreach', '2026-02-01T10:00:00.000Z', 'Met at the shelter, discussed detox');
  d.prepare(`INSERT INTO notes(id,client_id,author_id,kind,title,content_enc,occurred_at) VALUES(?,?,?,?,?,?,?)`)
    .run(ids.note, ids.client, ids.user, 'admin', 'Intake call', encrypt('note body'), '2026-02-01T10:00:00.000Z');
  d.prepare(`INSERT INTO consents(id,client_id,type,recipient,purpose,scope,signed_at,created_by) VALUES(?,?,?,?,?,?,?,?)`)
    .run(ids.consent, ids.client, 'part2_disclosure', 'Granite Wellness', 'treatment referral', 'dates of service only', '2026-01-06', ids.user);
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

test('a fresh install and an upgraded install end at the same schema', () => {
  // The two paths through initialise() must not drift: everything schema.sql adds for a new county has to
  // reach an existing one through a migration, or phones and servers end up with different tables.
  // Compared structurally (column names, types, nullability, defaults, indexes) — physical column order
  // and comments differ between ADD COLUMN and a fresh CREATE, and neither affects behaviour.
  const describe = (d) => {
    const out = {};
    for (const t of d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()) {
      if (t.name.startsWith('__new_')) continue;
      out[t.name] = {
        columns: d.prepare(`PRAGMA table_info(${t.name})`).all()
          .map(c => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? ''} pk=${c.pk}`).sort(),
        indexes: d.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(t.name)
          .map(i => i.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /gi, '').trim()).sort(),
      };
    }
    return out;
  };

  const upgraded = describe(db().get());
  const freshPath = path.join(dir, 'fresh.db');
  fs.rmSync(freshPath, { force: true });
  const f = new DatabaseSync(freshPath);
  f.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8'));
  const fresh = describe(f);
  f.close();

  // tombstones and sync_seen are created outside schema.sql, so an upgraded database legitimately has them.
  for (const extra of ['sync_seen']) delete upgraded[extra];
  assert.deepEqual(Object.keys(upgraded).sort(), Object.keys(fresh).sort(), 'same set of tables');
  for (const t of Object.keys(fresh)) {
    assert.deepEqual(upgraded[t].columns, fresh[t].columns, `columns of ${t} differ between a fresh and an upgraded database`);
    assert.deepEqual(upgraded[t].indexes, fresh[t].indexes, `indexes of ${t} differ between a fresh and an upgraded database`);
  }
});

test('the generated browser schema matches schema.sql', () => {
  // server/schema-text.js is what the phone builds its database from; if it drifts, the phone silently
  // gets a different schema from the office server.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
  assert.equal(require('../server/schema-text.js'), sql, 'run `node scripts/gen-schema-text.js`');
});

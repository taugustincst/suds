'use strict';
// Backup, restore and key rotation are the operations a county cannot retry. Until now none of them had a
// test: nothing ever decrypted a backup, and key rotation silently skipped two tables of form PHI.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '11'.repeat(32);
process.env.SUDS_INDEX_KEY = '22'.repeat(32);
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-backup-'));
process.env.SUDS_DATA_DIR = dir;
process.env.SUDS_DB_PATH = path.join(dir, 'suds.db');

const db = require('../server/db');
const backup = require('../server/backup');
const { encrypt, decrypt, uuid } = require('../server/crypto');
const { encryptedColumns } = require('../scripts/rotate-key');

const ids = {};
before(() => {
  db.open();
  ids.user = uuid(); ids.client = uuid(); ids.form = uuid(); ids.file = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`, ids.user, 'bk', 'x', 'Backup Tester', 'admin');
  db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc) VALUES(?,?,?,?)`, ids.client, 'C26-9001', encrypt('Rosa'), encrypt('Delgado'));
  db.run(`INSERT INTO client_forms(id,client_id,template_name,values_enc,created_by) VALUES(?,?,?,?,?)`, ids.form, ids.client, 'Release of Information', encrypt('{"recipient":"County OTP"}'), ids.user);
  db.run(`INSERT INTO client_form_files(id,client_form_id,client_id,filename,content_type,data_enc,uploaded_by) VALUES(?,?,?,?,?,?,?)`, ids.file, ids.form, ids.client, 'scan.pdf', 'application/pdf', encrypt('JVBERi0xLjQK'), ids.user);
});
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('key rotation covers every encrypted column in the schema', () => {
  // The old rotation script carried a hand-written table list. These two were added in 1.5 and never
  // added to it, so rotating a key made every completed county form permanently unreadable.
  const found = encryptedColumns(db);
  const pairs = found.flatMap(t => t.cols.map(c => `${t.table}.${c}`));
  for (const required of ['client_forms.values_enc', 'client_form_files.data_enc', 'clients.first_name_enc', 'clients.goals_enc', 'notes.content_enc', 'notes.title_enc', 'consents.recipient_enc', 'disclosures.what_enc', 'interventions.summary_enc', 'users.mfa_secret_enc']) {
    assert.ok(pairs.includes(required), `${required} must be re-encrypted on rotation`);
  }
  // And nothing claims to rotate a table it cannot address by id.
  for (const t of found) assert.ok(db.all(`PRAGMA table_info(${t.table})`).some(c => c.name === 'id'));
});

test('rotating the key re-encrypts form PHI and leaves it readable', () => {
  const newKey = Buffer.from('33'.repeat(32), 'hex');
  const before = db.one(`SELECT values_enc FROM client_forms WHERE id=?`, ids.form).values_enc;
  // The rotation loop itself, run against the discovered columns.
  db.transaction(() => {
    for (const { table, cols } of encryptedColumns(db)) {
      for (const r of db.all(`SELECT id, ${cols.join(',')} FROM ${table}`)) {
        const sets = []; const params = [];
        for (const c of cols) if (r[c]) { sets.push(`${c}=?`); params.push(encrypt(decrypt(r[c]), newKey)); }
        if (sets.length) db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id=?`, ...params, r.id);
      }
    }
  });
  const after = db.one(`SELECT values_enc FROM client_forms WHERE id=?`, ids.form).values_enc;
  assert.notEqual(after, before, 'the ciphertext changed');
  assert.equal(decrypt(after, newKey), '{"recipient":"County OTP"}', 'and still decrypts under the new key');
  assert.equal(decrypt(db.one(`SELECT data_enc FROM client_form_files WHERE id=?`, ids.file).data_enc, newKey), 'JVBERi0xLjQK');
  assert.throws(() => decrypt(after), /./, 'the old key no longer opens it');
  // Put it back so the remaining tests run against the configured key.
  db.transaction(() => {
    for (const { table, cols } of encryptedColumns(db)) {
      for (const r of db.all(`SELECT id, ${cols.join(',')} FROM ${table}`)) {
        const sets = []; const params = [];
        for (const c of cols) if (r[c]) { sets.push(`${c}=?`); params.push(encrypt(decrypt(r[c], newKey))); }
        if (sets.length) db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id=?`, ...params, r.id);
      }
    }
  });
});

test('a backup round-trips: create, decrypt, inspect', () => {
  const bytes = backup.create();
  assert.ok(bytes.length > 1000);
  // The ciphertext must not contain the plaintext it was made from.
  assert.ok(!bytes.includes(Buffer.from('C26-9001')), 'the backup is actually encrypted');
  const plain = backup.decrypt(bytes);
  assert.equal(plain.subarray(0, 15).toString(), 'SQLite format 3', 'it decrypts to a database');
  const info = backup.inspect(plain);
  assert.equal(info.counts.clients, 1);
  assert.equal(info.counts.users, 1);
  assert.ok(info.schema_version >= 5);
});

test('a backup made with a different key, or altered in transit, is refused', () => {
  const bytes = backup.create();
  assert.throws(() => backup.decrypt(bytes, { encryptionKey: Buffer.from('99'.repeat(32), 'hex') }), /different encryption key|damaged/);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => backup.decrypt(tampered), /damaged|different encryption key/);
  assert.throws(() => backup.decrypt(Buffer.from('nope')), /does not look like/);
  assert.throws(() => backup.inspect(Buffer.from('not a database at all, just text'.repeat(10))), /./);
});

test('with SUDS_BACKUP_KEY set, backups no longer depend on the PHI key — and older ones still open', () => {
  const config = require('../server/config');
  const before = backup.create();                       // keyed from the PHI key, the pre-SUDS_BACKUP_KEY way
  const phiKey = config.encryptionKey;
  config.backupKey = Buffer.from('77'.repeat(32), 'hex');
  try {
    const after = backup.create();
    assert.ok(backup.decrypt(after).length > 0, 'a new backup opens with the backup key');
    assert.ok(backup.decrypt(before).length > 0, 'one from before the backup key was set still opens (it falls back to the PHI-derived key)');
    // Rotating the PHI key now leaves the new backup readable: only the backup key matters to it.
    config.encryptionKey = Buffer.from('55'.repeat(32), 'hex');
    assert.ok(backup.decrypt(after).length > 0);
    assert.throws(() => backup.decrypt(before), /different encryption key|damaged/, 'the old one needs the retired PHI key...');
    assert.ok(backup.decrypt(before, { encryptionKey: phiKey }).length > 0, '...which a restore can supply explicitly');
  } finally { config.backupKey = null; config.encryptionKey = phiKey; }
});

test('a backup from a newer SUDS is refused before anything is swapped, and the server keeps serving its own data', () => {
  const plain = backup.decrypt(backup.create());
  // Stamp the copy as schema 99: what a backup taken on a future build looks like.
  const { DatabaseSync } = require('node:sqlite');
  const tmp = path.join(dir, 'future.db'); fs.writeFileSync(tmp, plain);
  const d = new DatabaseSync(tmp); d.exec(`UPDATE settings SET value='99' WHERE key='schema_version'`); d.close();
  const future = fs.readFileSync(tmp);
  const clientsBefore = db.one(`SELECT COUNT(*) n FROM clients`).n;
  const asides = () => fs.readdirSync(dir).filter(f => f.includes('.before-restore-'));
  const asidesBefore = asides().length;
  assert.throws(() => backup.inspect(future), /newer version of SUDS \(schema 99/);
  assert.throws(() => backup.restore(future), /newer version of SUDS \(schema 99/);
  assert.equal(db.one(`SELECT COUNT(*) n FROM clients`).n, clientsBefore, 'the live database is untouched');
  assert.equal(db.getSetting('schema_version'), String(db.LATEST_SCHEMA_VERSION), 'and is still the one this build opened');
  assert.equal(asides().length, asidesBefore, 'nothing was swapped, so nothing was set aside');
  assert.equal(decrypt(db.one(`SELECT first_name_enc FROM clients WHERE id=?`, ids.client).first_name_enc), 'Rosa');
});

test('a file that opens for inspection but is refused on reopen is rolled back to the previous database', () => {
  // Stub the reopen to fail once: stands in for a migration that throws on the restored data.
  const realOpen = db.open; let calls = 0;
  db.open = (...a) => { calls++; if (calls === 1) throw new Error('simulated migration failure'); return realOpen(...a); };
  try {
    const clientsBefore = db.one(`SELECT COUNT(*) n FROM clients`).n;
    assert.throws(() => backup.restore(backup.decrypt(backup.create())), /previous database was put back: simulated migration failure/);
    assert.equal(db.one(`SELECT COUNT(*) n FROM clients`).n, clientsBefore, 'serving the previous database again');
    assert.equal(decrypt(db.one(`SELECT first_name_enc FROM clients WHERE id=?`, ids.client).first_name_enc), 'Rosa');
  } finally { db.open = realOpen; }
});

test('db.open() leaves no handle behind when the file is refused', () => {
  const { DatabaseSync } = require('node:sqlite');
  const p = path.join(dir, 'refused.db'); fs.copyFileSync(process.env.SUDS_DB_PATH, p);
  const d = new DatabaseSync(p); d.exec(`UPDATE settings SET value='99' WHERE key='schema_version'`); d.close();
  db.close();
  assert.throws(() => db.open(p), /newer version of SUDS/);
  // The next open is a real open of the configured database, not the refused handle.
  db.open();
  assert.equal(db.getSetting('schema_version'), String(db.LATEST_SCHEMA_VERSION));
  assert.equal(decrypt(db.one(`SELECT first_name_enc FROM clients WHERE id=?`, ids.client).first_name_enc), 'Rosa');
});

test('restoring replaces the live database and keeps the previous one aside', () => {
  const bytes = backup.create();
  // Work done after the backup was taken — a restore is expected to discard it.
  const later = uuid();
  db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc) VALUES(?,?,?,?)`, later, 'C26-9002', encrypt('Later'), encrypt('Entry'));
  assert.equal(db.one(`SELECT COUNT(*) n FROM clients`).n, 2);

  const out = backup.restore(backup.decrypt(bytes));
  assert.equal(out.counts.clients, 1);
  assert.equal(db.one(`SELECT COUNT(*) n FROM clients`).n, 1, 'the later client is gone');
  assert.ok(!db.one(`SELECT 1 FROM clients WHERE id=?`, later));
  // The PHI in the restored database still decrypts, and the form attachment survived.
  assert.equal(decrypt(db.one(`SELECT first_name_enc FROM clients WHERE id=?`, ids.client).first_name_enc), 'Rosa');
  assert.equal(decrypt(db.one(`SELECT data_enc FROM client_form_files WHERE id=?`, ids.file).data_enc), 'JVBERi0xLjQK');
  // Restoring the wrong file must be recoverable, so the database it replaced is kept.
  assert.ok(fs.existsSync(out.previous_database_kept_at), 'the replaced database was kept');
  assert.equal(fs.readFileSync(out.previous_database_kept_at).subarray(0, 15).toString(), 'SQLite format 3');
  // The server is still usable straight afterwards.
  assert.equal(db.one(`SELECT 1 AS ok`).ok, 1);
});

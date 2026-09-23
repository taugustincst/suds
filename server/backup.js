'use strict';
// Encrypted backup and restore. One implementation, used by both `npm run backup` and the Administration
// page — the two used to assemble the same AES-GCM frame in different places, so a change to either would
// have silently made a county's backups unreadable.
//
// Frame: [12-byte IV][16-byte GCM tag][ciphertext]. The key is derived from the PHI encryption key, so a
// backup is only readable by someone who also holds that key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const db = require('./db');

// With SUDS_BACKUP_KEY set (server/config.js) new backups are keyed from that key, on its own: rotating the
// PHI key then leaves every existing backup readable, and a retired PHI key need not be kept just to open
// old backup sets. An explicit encryptionKey argument (a restore under an old key) still wins.
function backupKey(encryptionKey) {
  if (!encryptionKey && config.backupKey) return crypto.createHash('sha256').update(Buffer.concat([config.backupKey, Buffer.from('suds-backup-key')])).digest();
  return crypto.createHash('sha256').update(Buffer.concat([encryptionKey || config.encryptionKey, Buffer.from('suds-backup')])).digest();
}
// Every key a backup on this server might have been made with: the backup key if there is one, then the
// PHI-derived key (backups from before SUDS_BACKUP_KEY was set). GCM says which one is right.
function candidateKeys(encryptionKey) {
  if (encryptionKey) return [backupKey(encryptionKey)];
  const out = [];
  if (config.backupKey) out.push(backupKey());
  out.push(crypto.createHash('sha256').update(Buffer.concat([config.encryptionKey, Buffer.from('suds-backup')])).digest());
  return out;
}

/** A consistent snapshot of the live database, encrypted. Returns the bytes to write or send. */
function create({ encryptionKey } = {}) {
  const tmp = path.join(config.dataDir, `.backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  let plain;
  try {
    // VACUUM INTO writes a consistent copy even while the server is serving requests. It lands on disk in
    // the clear for a moment, so it is created 0600 and removed as soon as it has been read.
    fs.writeFileSync(tmp, '', { mode: 0o600 });
    fs.unlinkSync(tmp);
    db.get().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    try { fs.chmodSync(tmp, 0o600); } catch {}
    plain = fs.readFileSync(tmp);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', backupKey(encryptionKey), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/** Decrypt a backup. Throws if the key is wrong or the file has been altered (GCM authenticates both). */
function decrypt(buf, { encryptionKey } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 29) throw new Error('That does not look like a SUDS backup file');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  for (const key of candidateKeys(encryptionKey)) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    try { return Buffer.concat([d.update(data), d.final()]); } catch { /* not this key */ }
  }
  throw new Error('The backup could not be read. It is either damaged, or it was made with a different encryption key.');
}

/** Open a decrypted backup read-only and describe what is inside, without touching the live database. */
function inspect(plainBytes) {
  const tmp = path.join(config.dataDir, `.inspect-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  fs.writeFileSync(tmp, plainBytes, { mode: 0o600 });
  try {
    const d = new DatabaseSync(tmp, { readOnly: true });
    try {
      const integrity = d.prepare('PRAGMA integrity_check').get();
      if ((integrity.integrity_check || '').toLowerCase() !== 'ok') throw new Error('The backup file is damaged.');
      const has = (t) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      if (!has('settings') || !has('clients')) throw new Error('That file is not a SUDS backup.');
      const count = (t) => (has(t) ? d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : 0);
      const schemaVersion = Number(d.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get()?.value || 0);
      // Checked here, before anything is swapped: db.open() would refuse the file too, but by then the
      // live database has already been replaced and the server is left running on nothing.
      if (schemaVersion > db.LATEST_SCHEMA_VERSION) throw new Error(`This backup was made by a newer version of SUDS (schema ${schemaVersion}; this build understands ${db.LATEST_SCHEMA_VERSION}). Upgrade SUDS before restoring it.`);
      return {
        schema_version: schemaVersion,
        org_name: d.prepare(`SELECT value FROM settings WHERE key='org_name'`).get()?.value || null,
        counts: { clients: count('clients'), notes: count('notes'), interventions: count('interventions'), users: count('users'), audit_log: count('audit_log') },
        bytes: plainBytes.length,
      };
    } finally { d.close(); }
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/**
 * Replace the live database with a backup. The current database is copied aside first, so a restore of the
 * wrong file is recoverable. Migrations run on reopen, so an older backup is brought forward automatically.
 */
function restore(plainBytes) {
  const info = inspect(plainBytes);
  const dbPath = config.dbPath;
  if (dbPath === ':memory:') throw new Error('This server is running on an in-memory database; there is nothing to restore into.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aside = `${dbPath}.before-restore-${stamp}`;
  const dropJournal = () => { for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} } };
  // Put the original back, so a failed restore is not also a lost database — whatever failed, and whether
  // or not the swap had happened yet.
  const rollBack = (cause) => {
    try { if (fs.existsSync(aside)) { fs.copyFileSync(aside, dbPath); dropJournal(); } } catch (e) { cause.message += ` (and the previous database could not be put back from ${aside}: ${e.message})`; }
    try { db.close(); } catch {}
    try { db.open(); } catch (e) { cause.message += ` (the previous database could not be reopened either: ${e.message})`; }
  };
  // Checkpoint and close so the copy set aside is the whole database, not a file plus a write-ahead log.
  try { db.get().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  db.close();
  try {
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, aside);
    fs.writeFileSync(dbPath, plainBytes, { mode: 0o600 });
    // The write-ahead log belongs to the database we just replaced; leaving it would corrupt the new one.
    dropJournal();
  } catch (e) { rollBack(e); throw e; }
  // Reopening runs the migrations. If the file is refused after all (damaged in a way integrity_check did
  // not catch, a migration that fails on its data), the server must come back on the database it had.
  try { db.open(); }
  catch (e) { rollBack(e); throw new Error(`The backup could not be opened after it was restored, so the previous database was put back: ${e.message}`); }
  db.setSetting('db_generation', require('./crypto').uuid()); // a new lineage: devices see it on their next pull and re-offer what the backup lacks (server/routes/sync.js)
  return { ...info, previous_database_kept_at: aside };
}

module.exports = { create, decrypt, inspect, restore, backupKey };

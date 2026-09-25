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
  if (!encryptionKey && config.backupKey) return fromBackupKey(config.backupKey);
  return crypto.createHash('sha256').update(Buffer.concat([encryptionKey || config.encryptionKey, Buffer.from('suds-backup')])).digest();
}
const fromBackupKey = (raw) => crypto.createHash('sha256').update(Buffer.concat([raw, Buffer.from('suds-backup-key')])).digest();
// Every key a backup on this server might have been made with: the backup key if there is one, then the
// PHI-derived key (backups from before SUDS_BACKUP_KEY was set). GCM says which one is right. `escrow` is a
// key set read from somewhere other than this process (the recovery drill's --keys-file): only those keys
// are tried, so a success proves the escrowed copy opens the backup, not the keys this server holds.
function candidateKeys(encryptionKey, escrow) {
  if (escrow) {
    const out = [];
    if (escrow.backupKey) out.push(fromBackupKey(escrow.backupKey));
    if (escrow.encryptionKey) out.push(backupKey(escrow.encryptionKey));
    return out;
  }
  if (encryptionKey) return [backupKey(encryptionKey)];
  const out = [];
  if (config.backupKey) out.push(backupKey());
  out.push(crypto.createHash('sha256').update(Buffer.concat([config.encryptionKey, Buffer.from('suds-backup')])).digest());
  return out;
}

/** Encrypt a plaintext database image in the backup frame. */
function encryptPlain(plain, { encryptionKey } = {}) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', backupKey(encryptionKey), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/**
 * The same encrypted snapshot as create(), without holding the event loop while it is made: SQLite's online
 * backup API (node:sqlite backup(), which copies `rate` pages per step and yields between steps) where this
 * Node has it, else VACUUM INTO; then the copy is read, encrypted in 4 MB slices with a turn of the event
 * loop between them, and the plaintext copy overwritten and removed asynchronously. Used by the frequent
 * snapshots (server/scheduled-backup.js), which run every few minutes while staff are working.
 * Resolves to { bytes, method, copy_ms, encrypt_ms, plain_bytes }.
 */
async function createAsync({ encryptionKey, rate = 256 } = {}) {
  const sqlite = require('node:sqlite');
  const tmp = path.join(config.dataDir, `.backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  let plain; let method; const t0 = Date.now(); let t1;
  try {
    fs.writeFileSync(tmp, '', { mode: 0o600 });
    if (typeof sqlite.backup === 'function' && config.dbPath !== ':memory:') {
      method = 'sqlite-online-backup';
      await sqlite.backup(db.get(), tmp, { rate });
    } else {
      method = 'vacuum-into';
      fs.unlinkSync(tmp);
      db.get().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    }
    try { fs.chmodSync(tmp, 0o600); } catch {}
    t1 = Date.now();
    plain = await fs.promises.readFile(tmp);
  } finally { await secureUnlinkAsync(tmp); for (const suffix of ['-wal', '-shm', '-journal']) await secureUnlinkAsync(tmp + suffix); }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', backupKey(encryptionKey), iv);
  const parts = [];
  const SLICE = 4 << 20;
  for (let off = 0; off < plain.length; off += SLICE) {
    parts.push(c.update(plain.subarray(off, Math.min(off + SLICE, plain.length))));
    await new Promise((resolve) => (globalThis.setImmediate ? globalThis.setImmediate(resolve) : setTimeout(resolve, 0)));
  }
  parts.push(c.final());
  const bytes = Buffer.concat([iv, c.getAuthTag(), ...parts]);
  const plainBytes = plain.length;
  plain.fill(0);
  return { bytes, method, copy_ms: t1 - t0, encrypt_ms: Date.now() - t1, plain_bytes: plainBytes };
}

const SLICE = 4 << 20;
const tmpName = (kind) => path.join(config.dataDir, `.${kind}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
const removeTmp = async (tmp) => { await secureUnlinkAsync(tmp); for (const suffix of ['-wal', '-shm', '-journal']) await secureUnlinkAsync(tmp + suffix); };

/**
 * The encrypted backup written straight to `outFile`, never holding the event loop and never holding the
 * whole database in memory: SQLite's online backup API copies the live database to a private temporary file
 * (`rate` pages per step, yielding between steps), which is then read, encrypted and written 4 MB at a time
 * by the thread pool; the GCM tag goes into the frame header at the end, and the plaintext copy is
 * overwritten and removed. createAsync() builds one Buffer of the whole database (and a second for the
 * ciphertext) — at a few hundred megabytes, allocating and copying those alone stalled the server for
 * seconds. Used by scheduled backups (server/scheduled-backup.js).
 * Resolves to { bytes, method, copy_ms, encrypt_ms, plain_bytes }.
 */
async function createToFileAsync(outFile, { encryptionKey, rate = 256, flag = 'w' } = {}) {
  const sqlite = require('node:sqlite');
  const tmp = tmpName('backup');
  let method; const t0 = Date.now(); let t1; let plainBytes = 0; let written = 0;
  try {
    await fs.promises.writeFile(tmp, '', { mode: 0o600 });
    if (typeof sqlite.backup === 'function' && config.dbPath !== ':memory:') {
      method = 'sqlite-online-backup';
      await sqlite.backup(db.get(), tmp, { rate });
    } else {
      method = 'vacuum-into';
      await fs.promises.unlink(tmp);
      db.get().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    }
    try { await fs.promises.chmod(tmp, 0o600); } catch {}
    t1 = Date.now();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', backupKey(encryptionKey), iv);
    const src = await fs.promises.open(tmp, 'r');
    let out = null;
    try {
      out = await fs.promises.open(outFile, flag, 0o600);
      await out.write(Buffer.concat([iv, Buffer.alloc(16)]), 0, 28, 0); // tag written last, when it is known
      written = 28;
      const chunk = Buffer.alloc(SLICE);
      for (;;) {
        const { bytesRead } = await src.read(chunk, 0, SLICE, plainBytes);
        if (!bytesRead) break;
        plainBytes += bytesRead;
        const enc = c.update(chunk.subarray(0, bytesRead));
        await out.write(enc, 0, enc.length, written); written += enc.length;
      }
      chunk.fill(0);
      const fin = c.final();
      if (fin.length) { await out.write(fin, 0, fin.length, written); written += fin.length; }
      await out.write(c.getAuthTag(), 0, 16, 12);
      await out.sync();
    } finally { await src.close().catch(() => {}); if (out) await out.close().catch(() => {}); }
  } finally { await removeTmp(tmp); }
  return { bytes: written, method, copy_ms: t1 - t0, encrypt_ms: Date.now() - t1, plain_bytes: plainBytes };
}

/**
 * Decrypt the backup file `encFile` into `plainFile` (created 0600), 4 MB at a time, without holding the
 * event loop. Throws — and removes `plainFile` — when the key is wrong or the file has been altered (the GCM
 * tag is checked at the end). With no keys given, tries the same keys decrypt() does.
 */
async function decryptFileAsync(encFile, plainFile, { encryptionKey, escrow } = {}) {
  const src = await fs.promises.open(encFile, 'r');
  try {
    const { size } = await src.stat();
    if (size < 29) throw new Error('That does not look like a SUDS backup file');
    const head = Buffer.alloc(28); await src.read(head, 0, 28, 0);
    const iv = head.subarray(0, 12), tag = head.subarray(12, 28);
    const chunk = Buffer.alloc(SLICE);
    for (const key of candidateKeys(encryptionKey, escrow)) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      const out = await fs.promises.open(plainFile, 'w', 0o600);
      let ok = false;
      try {
        let pos = 28; let at = 0;
        for (;;) {
          const { bytesRead } = await src.read(chunk, 0, SLICE, pos);
          if (!bytesRead) break;
          pos += bytesRead;
          const p = d.update(chunk.subarray(0, bytesRead));
          await out.write(p, 0, p.length, at); at += p.length; p.fill(0);
        }
        const fin = d.final(); // throws when the tag does not match: wrong key, or altered
        if (fin.length) await out.write(fin, 0, fin.length, at);
        ok = true;
      } catch { /* not this key */ } finally { await out.close().catch(() => {}); chunk.fill(0); }
      if (ok) return;
      await secureUnlinkAsync(plainFile);
    }
  } finally { await src.close().catch(() => {}); }
  throw new Error(escrow ? 'The backup could not be read with the escrowed keys. Either the key file is not the one for this backup set, or the backup is damaged.' : 'The backup could not be read. It is either damaged, or it was made with a different encryption key.');
}

// The body of inspect() that touches SQLite, run in a worker thread by verifyFileAsync so PRAGMA
// integrity_check on a large database (seconds) does not stop requests being served. Reports plain facts;
// the decisions (damaged, not a SUDS backup, newer schema) are made by the caller, as inspect() makes them.
const INSPECT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  const d = new DatabaseSync(workerData.file, { readOnly: true });
  try {
    const integrity = d.prepare('PRAGMA integrity_check').get();
    const has = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const count = (t) => (has(t) ? d.prepare('SELECT COUNT(*) n FROM ' + t).get().n : 0);
    const setting = (k) => (has('settings') ? d.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value : undefined);
    parentPort.postMessage({ ok: true, integrity: String(integrity.integrity_check || ''), hasSettings: has('settings'), hasClients: has('clients'),
      schema_version: Number(setting('schema_version') || 0), org_name: setting('org_name') || null,
      counts: { clients: count('clients'), notes: count('notes'), interventions: count('interventions'), users: count('users'), audit_log: count('audit_log') } });
  } finally { d.close(); }
} catch (e) { parentPort.postMessage({ ok: false, error: String(e && e.message || e) }); }
`;
let WorkerCtor;
try { WorkerCtor = require('node:worker_threads').Worker; } catch { WorkerCtor = null; }

function inspectInWorker(file) {
  return new Promise((resolve, reject) => {
    // Settled on exit, not on the message: the worker has closed the database by then, so the copy and the
    // -wal/-shm files SQLite made beside it can be removed without the close re-creating them.
    const w = new WorkerCtor(INSPECT_WORKER, { eval: true, workerData: { file } });
    let msg = null;
    w.once('message', (m) => { msg = m; }); w.once('error', reject);
    w.once('exit', (code) => (msg ? resolve(msg) : reject(new Error(`backup verification worker exited (${code})`))));
  });
}

/**
 * The scheduled backup's read-back check, without holding the event loop: decrypt `encFile` to a private
 * temporary file (decryptFileAsync), open it read-only in a worker thread and run the same checks inspect()
 * does, then overwrite and remove the copy. Resolves to what inspect() returns; throws what it throws.
 */
async function verifyFileAsync(encFile, opts = {}) {
  if (typeof WorkerCtor !== 'function' || config.local) return inspect(decrypt(fs.readFileSync(encFile), opts));
  const tmp = tmpName('inspect');
  try {
    await decryptFileAsync(encFile, tmp, opts);
    const { size } = await fs.promises.stat(tmp);
    const r = await inspectInWorker(tmp);
    if (!r.ok) throw new Error(r.error);
    if (r.integrity.toLowerCase() !== 'ok') throw new Error('The backup file is damaged.');
    if (!r.hasSettings || !r.hasClients) throw new Error('That file is not a SUDS backup.');
    if (r.schema_version > db.LATEST_SCHEMA_VERSION) throw new Error(`This backup was made by a newer version of SUDS (schema ${r.schema_version}; this build understands ${db.LATEST_SCHEMA_VERSION}). Upgrade SUDS before restoring it.`);
    return { schema_version: r.schema_version, org_name: r.org_name, counts: r.counts, bytes: size };
  } finally { await removeTmp(tmp); }
}

/** secureUnlink without blocking: the overwrite is written by the thread pool, a slice at a time. */
async function secureUnlinkAsync(file) {
  let st = null; try { st = await fs.promises.lstat(file); } catch (e) { if (e && e.code === 'ENOENT') return false; }
  if (st && st.isFile() && st.size > 0) {
    let fh = null;
    try {
      fh = await fs.promises.open(file, 'r+');
      const chunk = Buffer.alloc(Math.min(st.size, 4 << 20));
      for (let off = 0; off < st.size; off += chunk.length) await fh.write(chunk, 0, Math.min(chunk.length, st.size - off), off);
      await fh.sync();
    } catch { /* unlink it anyway */ } finally { if (fh) await fh.close().catch(() => {}); }
  }
  try { await fs.promises.unlink(file); return true; } catch { return false; }
}

/**
 * Overwrite a plaintext file with zeros, flush it, then remove it. Best effort, and honest about its limits:
 * on SSDs, copy-on-write and journaling filesystems the old blocks may survive an overwrite; full-disk
 * encryption of the data volume is what actually protects them (docs/security/BACKUP-AND-DR.md).
 */
function secureUnlink(file) {
  let st = null; try { st = fs.lstatSync(file); } catch (e) { if (e && e.code === 'ENOENT') return false; }
  if (st && st.isFile() && st.size > 0) {
    try {
      const fd = fs.openSync(file, 'r+');
      try {
        const chunk = Buffer.alloc(Math.min(st.size, 1 << 20));
        for (let off = 0; off < st.size; off += chunk.length) fs.writeSync(fd, chunk, 0, Math.min(chunk.length, st.size - off), off);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    } catch { /* unlink it anyway */ }
  }
  try { fs.unlinkSync(file); return true; } catch { return false; }
}
/** secureUnlink every file under a directory, then remove the directory. */
function secureRemoveDir(dir) {
  let n = 0;
  let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += secureRemoveDir(p); else if (secureUnlink(p)) n++;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return n;
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
  } finally { secureUnlink(tmp); }
  return encryptPlain(plain, { encryptionKey });
}

/** Decrypt a backup. Throws if the key is wrong or the file has been altered (GCM authenticates both). */
function decrypt(buf, { encryptionKey, escrow } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 29) throw new Error('That does not look like a SUDS backup file');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  for (const key of candidateKeys(encryptionKey, escrow)) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    try { return Buffer.concat([d.update(data), d.final()]); } catch { /* not this key */ }
  }
  throw new Error(escrow ? 'The backup could not be read with the escrowed keys. Either the key file is not the one for this backup set, or the backup is damaged.' : 'The backup could not be read. It is either damaged, or it was made with a different encryption key.');
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
  } finally { secureUnlink(tmp); for (const suffix of ['-wal', '-shm', '-journal']) secureUnlink(tmp + suffix); } // a read-only open of a WAL database leaves both beside it
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
  const restoredGen = db.getSetting('db_generation', null) || 'initial';
  db.setSetting('db_generation', require('./crypto').uuid()); // a new lineage: devices see it on their next pull and re-offer what the backup lacks (server/routes/sync.js)
  // Anchor the restored chain at once: anchors written since the backup was taken no longer match it, and
  // this one (reason 'restore', the new generation) is what tells verification that the change was a
  // restore rather than a rewrite (server/audit-anchor.js).
  if (!config.local) require('./audit-anchor').safeWrite('restore', { prevGen: restoredGen });
  return { ...info, previous_database_kept_at: aside };
}

module.exports = { create, createAsync, encryptPlain, decrypt, decryptFileAsync, createToFileAsync, verifyFileAsync, inspect, restore, backupKey, secureUnlink, secureUnlinkAsync, secureRemoveDir };

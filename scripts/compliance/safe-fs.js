'use strict';
// File operations for scripts/compliance-check.js, which runs as root (suds-compliance.service) over
// directories the suds user controls: the data directory, the backups, the offsite share. Root must never
// follow a path the suds user can redirect, or a symlink planted there turns a weekly check into a way to
// write or chown any file on the host. So:
//   * no chown/chmod through a path: a file is created with O_CREAT|O_EXCL|O_NOFOLLOW and changed through
//     its descriptor (fchown/fchmod);
//   * a directory is opened with O_DIRECTORY|O_NOFOLLOW, checked (a directory, the expected owner, not
//     world-writable, reached without a symlink anywhere on its path) and files are created in it through
//     /proc/self/fd/<fd>, so a directory swapped for a symlink after the check is not followed either;
//   * a file is read with O_NOFOLLOW and only when fstat says it is a regular file of a sane size;
//   * the live database is never opened by root: it is copied, through descriptors, into a private
//     directory and the copy is opened (SQLite would otherwise create root-owned -wal/-shm files beside it).
// Tests run as an ordinary user and pass the owner they expect (expectUid), which simulates root's check.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = fs.constants;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const refuse = (msg, code = 'EUNSAFE') => Object.assign(new Error(msg), { code });
const hasProcFd = (() => { try { return fs.existsSync('/proc/self/fd'); } catch { return false; } })();

/**
 * Open (and with `create`, first make) a directory safely. Returns { fd, st, path }; close it with closeDir.
 * Refuses a symlink, a non-directory, an unexpected owner (expectUid), a world-writable directory, and a
 * path that resolves elsewhere than it says (a symlink in a parent directory).
 */
function openDir(dir, { expectUid = null, create = false, mode = 0o750 } = {}) {
  const abs = path.resolve(dir);
  if (create) { try { fs.mkdirSync(abs, { mode }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  const lst = fs.lstatSync(abs);
  if (lst.isSymbolicLink()) throw refuse(`${abs} is a symbolic link: refusing to write through it`);
  if (!lst.isDirectory()) throw refuse(`${abs} is not a directory`);
  let fd;
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); } catch (e) { throw e.code === 'ELOOP' ? refuse(`${abs} is a symbolic link: refusing to write through it`) : e; }
  try {
    const st = fs.fstatSync(fd);
    if (st.ino !== lst.ino || st.dev !== lst.dev) throw refuse(`${abs} changed while it was being opened`);
    if (expectUid !== null && expectUid !== undefined && st.uid !== expectUid) throw refuse(`${abs} is owned by uid ${st.uid}, not the expected uid ${expectUid}`);
    if (st.mode & 0o002) throw refuse(`${abs} is writable by everyone`);
    if (hasProcFd) {
      let real = null; try { real = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
      if (real && real !== abs) throw refuse(`${abs} resolves to ${real}: a parent directory is a symbolic link`);
    }
    return { fd, st, path: abs };
  } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
}
function closeDir(d) { try { fs.closeSync(d.fd); } catch {} }

/** The path to create `name` inside an opened directory, through its descriptor where the OS allows it. */
function inDir(d, name) {
  if (!NAME_RE.test(String(name))) throw refuse(`refusing the file name ${JSON.stringify(String(name).slice(0, 80))}`);
  return path.join(hasProcFd ? `/proc/self/fd/${d.fd}` : d.path, name);
}

/**
 * Create a new file in an opened directory: never an existing file, never through a symlink. `uid`/`gid`
 * (when given) and `mode` are set through the descriptor. Returns the file's path.
 */
function writeNew(d, name, data, { mode = 0o600, uid = null, gid = null } = {}) {
  const fd = fs.openSync(inDir(d, name), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
  try {
    fs.writeSync(fd, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    if (uid !== null || gid !== null) fs.fchownSync(fd, uid === null ? -1 : uid, gid === null ? -1 : gid);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return path.join(d.path, name);
}

/** Read a regular file without following a symlink at its last component. Throws a message without content. */
function readRegular(file, { maxBytes = 16 * 1024 * 1024 } = {}) {
  let fd;
  try { fd = fs.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); } catch (e) { throw refuse(e.code === 'ELOOP' ? 'it is a symbolic link' : (e.code || 'cannot be opened'), e.code || 'EOPEN'); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw refuse('not a regular file');
    if (st.size > maxBytes) throw refuse(`larger than ${maxBytes} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0; while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
    return buf.subarray(0, off);
  } finally { fs.closeSync(fd); }
}

/** Parse JSON from a file read with readRegular; the error names the problem, never the file's content. */
function readJson(file, opts) {
  const buf = readRegular(file, opts);
  try { return JSON.parse(buf.toString('utf8')); } catch { throw refuse('not valid JSON', 'EJSON'); }
}

// Copy one file through descriptors; returns the source's identity before and after, to detect a writer.
function copyThroughFds(src, dest) {
  let sfd;
  try { sfd = fs.openSync(src, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); } catch (e) { if (e.code === 'ENOENT') return null; throw refuse(`${path.basename(src)}: ${e.code === 'ELOOP' ? 'a symbolic link' : e.code || e.message}`); }
  try {
    const a = fs.fstatSync(sfd);
    if (!a.isFile()) throw refuse(`${path.basename(src)} is not a regular file`);
    const dfd = fs.openSync(dest, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    try {
      const buf = Buffer.alloc(1024 * 1024); let pos = 0;
      for (;;) { const n = fs.readSync(sfd, buf, 0, buf.length, pos); if (!n) break; fs.writeSync(dfd, buf, 0, n); pos += n; }
    } finally { fs.closeSync(dfd); }
    const b = fs.fstatSync(sfd);
    return { before: `${a.ino}:${a.size}:${a.mtimeMs}`, after: `${b.ino}:${b.size}:${b.mtimeMs}` };
  } finally { fs.closeSync(sfd); }
}

function identity(file) {
  let fd; try { fd = fs.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); } catch { return null; }
  try { const s = fs.fstatSync(fd); return `${s.ino}:${s.size}:${s.mtimeMs}`; } finally { fs.closeSync(fd); }
}

/**
 * A consistent private copy of a SQLite database (and its write-ahead log) in a new 0700 directory under
 * `tmpRoot`, to open instead of the live file: { dir, file }. Retries while a writer changes the files
 * underneath; the copy is then checked with PRAGMA quick_check. The caller removes `dir`.
 */
function snapshotDb(dbPath, { tmpRoot = os.tmpdir(), tries = 5 } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'suds-compliance-db-'));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'suds.db');
    try {
      const main = copyThroughFds(dbPath, file);
      if (!main) throw refuse(`no database at ${dbPath}`, 'NODB');
      const wal = copyThroughFds(`${dbPath}-wal`, `${file}-wal`);
      const stable = main.before === main.after && (!wal || wal.before === wal.after) && identity(dbPath) === main.after;
      if (!stable) throw refuse('the database changed while it was being copied', 'EAGAIN');
      const d = new DatabaseSync(file);
      try { const q = d.prepare('PRAGMA quick_check').get(); if (String(Object.values(q)[0]).toLowerCase() !== 'ok') throw refuse('the copy of the database does not pass quick_check', 'EAGAIN'); } finally { d.close(); }
      return { dir, file };
    } catch (e) {
      lastErr = e; fs.rmSync(dir, { recursive: true, force: true });
      if (e.code !== 'EAGAIN') throw e;
    }
  }
  throw lastErr;
}

module.exports = { openDir, closeDir, writeNew, readRegular, readJson, snapshotDb, NAME_RE };

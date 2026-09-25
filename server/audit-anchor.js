'use strict';
// Audit anchoring: evidence that lives outside the database.
//
// The audit chain (server/audit.js) is keyed with the index key, and its head is sealed into the settings
// table, so an edit, a deletion or a truncation is detected by anyone who does not hold that key. Someone
// who holds the database AND the key (a server administrator, by definition) could still rebuild the whole
// table and re-seal it: every check inside the database would pass. Anchors close that gap. Every
// AUDIT_ANCHOR_HOURS, at every scheduled backup and on demand, the current head of the chain — the newest
// entry's id and hash, the oldest surviving id and the row count — is sealed with the index key and written
// as a new file that is never modified again (created with O_EXCL, then made read-only) to AUDIT_ANCHOR_DIR,
// which a county points at write-once storage (a WORM/immutable NAS share, an object-lock bucket). Each
// anchor also names the one before it, so removing an anchor file breaks the sequence. Optionally the same
// line goes to a syslog collector (AUDIT_SYSLOG). A rewritten chain no longer matches the hashes the older
// anchors recorded, and nobody can go back and change those.
//
// Anchors carry no PHI: integers, hashes, a timestamp and the host name.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');

const FILE_RE = /^anchor-.*\.json$/;
const keyId = (key = config.indexKey) => crypto.createHmac('sha256', key).update('suds-audit-anchor-key-id').digest('hex').slice(0, 16);
// The fields in a fixed order, so the MAC is over the same bytes whoever computes it (scripts/verify-audit-export.js too).
const FIELDS = ['v', 'kind', 'at', 'reason', 'install', 'gen', 'prev_gen', 'head_id', 'head_hash', 'first_id', 'rows', 'host', 'key_id', 'prev_mac'];
// Which database an anchor belongs to. `install` is minted once per installation (a restore keeps it: the
// backup carries it); `gen` is the database generation, which a restore changes (server/backup.js). Anchors
// of another installation sharing the directory are ignored; anchors from before a restore are expected
// not to match the restored database, but only when the restore itself was anchored (reason 'restore').
const installId = () => db.getSetting('audit_anchor_install', null);
const generation = () => db.getSetting('db_generation', null) || 'initial';
function canonical(a) { const o = {}; for (const k of FIELDS) o[k] = a[k] === undefined ? null : a[k]; return JSON.stringify(o); }
function macOf(a, key = config.indexKey) { return crypto.createHmac('sha256', key).update(canonical(a)).digest('hex'); }
function macOk(a, key = config.indexKey) {
  if (typeof a.mac !== 'string') return false;
  const want = macOf(a, key);
  return want.length === a.mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(a.mac));
}

function dir() { return config.auditAnchorDir; }

/** Every anchor file in the directory, oldest first (the names sort by time). Unreadable ones are returned as { file, error }. */
function list(d = dir()) {
  let names = [];
  try { names = fs.readdirSync(d).filter((f) => FILE_RE.test(f)).sort(); } catch { return []; }
  return names.map((file) => {
    try { return { file, anchor: JSON.parse(fs.readFileSync(path.join(d, file), 'utf8')) }; }
    catch (e) { return { file, error: String(e.message || e) }; }
  });
}

// Resolved through symlinks where the path exists, so a link from outside into the data directory (or the
// other way round) is seen for what it is.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
/** Where the directory stands: exists / writable / configured / inside the data directory. Never throws. */
function dirStatus(d = dir()) {
  let exists = false; let writable = false;
  try { exists = fs.statSync(d).isDirectory(); } catch {}
  if (exists) { try { fs.accessSync(d, fs.constants.W_OK); writable = true; } catch {} }
  const a = real(d); const data = real(config.dataDir);
  // Either way round is the same disk: anchors inside the data directory, or the data directory inside the anchor directory.
  return { dir: d, configured: config.auditAnchorDirConfigured, exists, writable, inside_data_dir: within(a, data) || within(data, a) };
}

/**
 * In production, anchors on the same disk as the database are no anchors at all: whoever can rewrite the
 * data directory rewrites them with it. Returns the sentence to show (Security status, /api/health, the
 * startup log) or null when the placement is acceptable. Outside production (a laptop, the test suite) the
 * default directory is fine and this says nothing.
 */
function placementProblem(d = dir()) {
  if (!config.isProd) return null;
  const st = dirStatus(d);
  if (!st.configured) return `AUDIT_ANCHOR_DIR is not set, so audit anchors are written to ${d}, inside the data directory on the same disk as the database they are meant to check. Point AUDIT_ANCHOR_DIR at write-once (WORM) storage outside the data directory (docs/security/LOGGING-AND-AUDIT.md).`;
  if (st.inside_data_dir) return `AUDIT_ANCHOR_DIR (${d}) is inside the data directory (or contains it), so a rewrite of the data directory rewrites the anchors too. Point it at write-once (WORM) storage outside the data directory (docs/security/LOGGING-AND-AUDIT.md).`;
  return null;
}

/**
 * Write an anchor for the chain as it stands now. `reason` is 'schedule', 'backup', 'manual' or
 * 'index-key-rotation'. Returns the anchor, or null when there is nothing to anchor. Throws when the
 * directory cannot be written — callers that must not fail (housekeeping, a backup) catch and record it.
 */
function write(reason = 'manual', { key = config.indexKey, d = dir(), prevGen = null } = {}) {
  const head = db.one(`SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1`);
  if (!head) return null;
  const first = db.one(`SELECT MIN(id) m FROM audit_log`).m;
  const rows = db.one(`SELECT COUNT(*) n FROM audit_log WHERE id <= ?`, head.id).n;
  // A configured directory is never created: an unmounted share is an empty mount point, and mkdir there
  // would put the "immutable" evidence on the server's own disk without anyone noticing. The default
  // (inside the data directory) is created on first use.
  if (!config.auditAnchorDirConfigured || d !== config.auditAnchorDir) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  else if (!dirStatus(d).exists) throw new Error(`the audit anchor directory ${d} does not exist (is the share mounted?)`);
  let install = installId();
  if (!install) { install = require('./crypto').uuid(); db.setSetting('audit_anchor_install', install); }
  const all = list(d);
  const prev = all.filter((x) => x.anchor && x.anchor.install === install).pop();
  // Anchor times are strictly increasing, one millisecond apart at least. File names are the time and the
  // head, and two anchors of the same head in the same millisecond (a scheduled anchor and a restore, say)
  // used to share a name: the second write hit EEXIST and was dropped without a word, so a restore could
  // go unanchored and every older anchor then read as tampering. Names also sort in the order written.
  const newest = all.filter((x) => x.anchor && typeof x.anchor.at === 'string').map((x) => Date.parse(x.anchor.at)).filter(Number.isFinite);
  const floor = newest.length ? Math.max(...newest) + 1 : 0;
  let atMs = Math.max(Date.now(), floor);
  let a; let file;
  for (let attempt = 0; ; attempt++, atMs++) {
    a = { v: 1, kind: 'suds-audit-anchor', at: new Date(atMs).toISOString(), reason, install, gen: generation(), prev_gen: prevGen, head_id: head.id, head_hash: head.hash, first_id: first, rows, host: require('node:os').hostname(), key_id: keyId(key), prev_mac: prev ? prev.anchor.mac || null : null };
    a.mac = macOf(a, key);
    file = path.join(d, `anchor-${a.at.replace(/[:.]/g, '-')}-${String(head.id).padStart(12, '0')}.json`);
    // 'wx': never overwrite an anchor. A name already taken (another process writing to the same share in
    // the same millisecond) moves this one a millisecond later rather than losing it.
    try { fs.writeFileSync(file, JSON.stringify(a) + '\n', { flag: 'wx', mode: 0o600 }); break; }
    catch (e) { if (e.code !== 'EEXIST' || attempt >= 50) throw e; }
  }
  try { fs.chmodSync(file, 0o400); } catch {}
  db.setSetting('audit_anchor_last_at', a.at);
  db.setSetting('audit_anchor_last_status', 'ok');
  // Never PHI. At info level, so it also lands in the collected log file (server/log.js).
  console.log(`[suds] audit anchor id=${a.head_id} rows=${a.rows} hash=${a.head_hash} mac=${a.mac} reason=${reason}`);
  sendSyslog(a);
  return { ...a, file: path.basename(file) };
}

/** Best effort: a syslog collector that is down must not stop an anchor being written to disk. */
function sendSyslog(a) {
  if (!config.auditSyslog) return;
  try {
    const m = String(config.auditSyslog).match(/^(?:udp:\/\/)?\[?([^\]]+?)\]?(?::(\d+))?$/);
    if (!m) return;
    const host = m[1]; const port = Number(m[2] || 514);
    const dgram = require('node:dgram');
    const sock = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    // <110> = facility 13 (log audit), severity 6 (informational). RFC 5424.
    const msg = Buffer.from(`<110>1 ${a.at} ${a.host} suds - audit-anchor - ${JSON.stringify(a)}`);
    sock.send(msg, port, host, () => { try { sock.close(); } catch {} });
    if (sock.unref) sock.unref();
  } catch (e) { console.error('[suds] audit anchor syslog send failed:', e.message); }
}

/** Housekeeping: anchor if AUDIT_ANCHOR_HOURS have passed since the last one. Never throws. */
function runIfDue(now = Date.now()) {
  const hours = config.auditAnchorHours;
  if (!(hours > 0)) return null;
  const last = db.getSetting('audit_anchor_last_at', null);
  if (last && now - Date.parse(last) < hours * 3600_000) return null;
  return safeWrite('schedule');
}
function safeWrite(reason, opts = {}) {
  try { return write(reason, opts); }
  catch (e) {
    const msg = String(e.message || e);
    console.error('[suds] audit anchor could not be written:', msg);
    db.setSetting('audit_anchor_last_status', `failed: ${msg}`);
    try { require('./audit').log({ user: { username: 'system' }, action: 'audit.anchor.failed', success: false, details: { reason, error: msg.slice(0, 300) } }); } catch {}
    return null;
  }
}

/**
 * Check the database's chain against every anchor on file. For each anchor sealed with the current key:
 * its MAC must verify, it must name the anchor before it, the entry it recorded must still be in the table
 * with the same hash (or have been removed by a retention purge that says so), and — while no purge has
 * happened since — the row count up to it must be unchanged. Anchors sealed under an earlier index key
 * (before a rotation) cannot be checked with this one and are counted separately.
 *
 * `tolerateNewer`: an anchor beyond the newest entry is not a truncation (a DR drill checks a restored
 * backup, which is older than the anchors written since it was taken).
 */
function verify({ key = config.indexKey, d = dir(), tolerateNewer = false } = {}) {
  const files = list(d);
  const out = { dir: d, total: files.length, matched: 0, other_key: 0, other_install: 0, other_generation: 0, purged: 0, newer: 0, bad: [], last_anchor_at: null };
  const install = installId(); const gen = generation();
  const kid = keyId(key);
  const bounds = db.one(`SELECT MIN(id) mn, MAX(id) mx FROM audit_log`);
  const minId = bounds.mn || 0; const maxId = bounds.mx || 0;
  // The highest entry id a retention purge says it removed (audit.purge rows record last_purged_id). Looked
  // up only when an anchor points before the oldest surviving entry: it is a scan of the whole table.
  let purgedThrough = null;
  const purged = () => {
    if (purgedThrough === null) { purgedThrough = 0; for (const r of db.all(`SELECT details FROM audit_log WHERE action='audit.purge'`)) { try { purgedThrough = Math.max(purgedThrough, Number(JSON.parse(r.details).last_purged_id) || 0); } catch {} } }
    return purgedThrough;
  };
  // The row count is compared for the newest anchor only. For the others the hash is enough: each entry's
  // hash commits to the one before it, so an unchanged hash at the anchored entry means an unchanged prefix
  // wherever the chain itself verifies — and counting up to every anchor would cost a table scan apiece.
  const mine = files.filter((f) => f.anchor && f.anchor.install === install);
  const newest = mine.filter((f) => f.anchor.key_id === kid && f.anchor.gen === gen).pop();
  // The lineage of restores: a restore anchor for generation X names the generation of the backup it
  // restored (prev_gen) and the entry the restored chain ended at (head_id). A backup's chain is a prefix of
  // the chain it was taken from, so an older generation's anchors up to that entry must still match; only
  // the ones after it (written after the backup was taken) cannot, and those are counted, not failed.
  const restores = new Map();
  for (const f of mine) if (f.anchor.reason === 'restore' && f.anchor.key_id === kid && macOk(f.anchor, key) && !restores.has(f.anchor.gen)) restores.set(f.anchor.gen, f.anchor);
  const boundFor = (g) => { let bound = Infinity; let cur = gen; const seen = new Set(); while (cur !== g) { const r = restores.get(cur); if (!r || seen.has(cur)) return null; seen.add(cur); bound = Math.min(bound, r.head_id); cur = r.prev_gen || 'initial'; } return bound; };
  let prevMac = null; let first = true;
  for (const f of files) {
    const bad = (reason) => out.bad.push({ file: f.file, head_id: f.anchor ? f.anchor.head_id : null, reason });
    if (!f.anchor) { bad(`unreadable: ${f.error}`); prevMac = undefined; first = false; continue; }
    const a = f.anchor;
    if (!install || a.install !== install) { out.other_install++; continue; }
    out.last_anchor_at = a.at || out.last_anchor_at;
    // The sequence: each anchor names the MAC of the one before it. The first file on record starts it.
    if (!first && prevMac !== undefined && a.prev_mac !== prevMac) bad('the anchor before this one is missing or was replaced (the sequence of anchor files is broken)');
    first = false; prevMac = a.mac;
    if (a.key_id !== kid) { out.other_key++; continue; }
    if (!macOk(a, key)) { bad('the anchor file does not verify (it was altered, or was not written by this server)'); continue; }
    if (a.gen !== gen) {
      const bound = boundFor(a.gen);
      if (bound === null && !tolerateNewer) { bad('the database has been replaced since this anchor (its generation changed) but no restore was anchored'); continue; }
      if (bound === null || a.head_id > bound) { out.other_generation++; continue; }
    }
    const row = db.one(`SELECT id, hash FROM audit_log WHERE id=?`, a.head_id);
    if (!row) {
      if (a.head_id > maxId) { if (tolerateNewer) out.newer++; else bad(`the audit log now ends at entry ${maxId}, before this anchor's entry ${a.head_id}: newer entries were removed`); continue; }
      if (a.head_id < minId && a.head_id <= purged()) { out.purged++; continue; }
      bad(`entry ${a.head_id} recorded by this anchor is missing${a.head_id < minId ? ' and no retention purge accounts for it' : ''}`); continue;
    }
    if (row.hash !== a.head_hash) { bad(`entry ${a.head_id} no longer has the hash this anchor recorded: the chain was rewritten`); continue; }
    if (f === newest && a.first_id === minId) {
      const n = db.one(`SELECT COUNT(*) n FROM audit_log WHERE id <= ?`, a.head_id).n;
      if (n !== a.rows) { bad(`${a.rows - n} entr${Math.abs(a.rows - n) === 1 ? 'y' : 'ies'} at or before entry ${a.head_id} ${n < a.rows ? 'were removed' : 'were inserted'} since this anchor`); continue; }
    }
    out.matched++;
  }
  out.ok = out.bad.length === 0;
  return out;
}

/** verify(), and remember the outcome where the Security status page and /api/health read it. */
function verifyAndRecord() {
  const r = verify();
  db.setSetting('audit_anchor_verified_at', db.now());
  db.setSetting('audit_anchor_verify_status', r.ok ? `ok: ${r.matched} matched${r.purged ? `, ${r.purged} before a retention purge` : ''}${r.other_key ? `, ${r.other_key} under an earlier index key` : ''}${r.other_generation ? `, ${r.other_generation} from before a restore` : ''}${r.other_install ? `, ${r.other_install} from another installation` : ''} of ${r.total}` : `FAILED: ${r.bad[0].reason} (${r.bad[0].file})`);
  if (!r.ok) {
    console.error(`[suds] AUDIT ANCHOR MISMATCH: ${r.bad.length} anchor(s) do not match the audit log — ${r.bad[0].reason}`);
    try { require('./audit').log({ user: { username: 'system' }, action: 'audit.anchor.verify.failed', success: false, details: { bad: r.bad.slice(0, 20), total: r.total } }); } catch {}
    // As with a broken hash chain, an audit log that no longer matches its anchors may hide who read what:
    // a possible breach until someone has looked (server/incidents.js). One open draft, however often checked.
    try {
      require('./incidents').draft({ source: 'audit_chain', sourceRef: 'audit_anchor', title: 'Audit log does not match its external anchors',
        description: `${r.bad.length} audit anchor(s) written outside the database do not match the audit log (${r.bad[0].reason}). Establish whether audit entries were altered, rebuilt or removed, and whether that concealed access to client records.` });
    } catch (e) { console.error('[suds] could not open an incident for the anchor mismatch:', e.message); }
  }
  return r;
}

module.exports = { write, safeWrite, runIfDue, verify, verifyAndRecord, list, dirStatus, placementProblem, keyId, macOf, macOk, canonical, FIELDS };

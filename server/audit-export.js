'use strict';
// The auditor's copy of the audit log: a range of the hash chain as NDJSON, with a manifest that lets it be
// verified away from the server (scripts/verify-audit-export.js). Kept free of the database and config so
// the verifier can run on an auditor's laptop with nothing but Node.
//
// Format (one JSON object per line):
//   {"type":"header", format, version, generated_at, server_version, org_name, first_id, last_id}
//   {"type":"entry", id, at, user_id, username, action, entity, entity_id, client_id, ip, success, details, prev_hash, hash}   (details is the stored string, byte for byte)
//   ...
//   {"type":"manifest", entries, first_id, last_id, first_prev_hash, last_hash, sha256, key_id, anchors:[...], head_checkpoint, mac}
// `sha256` is over every line before the manifest (each with its trailing newline). `mac` is HMAC-SHA256
// with the index key over the manifest without `mac`, so a manifest cannot be recomputed by whoever edits
// the file unless they also hold the key.
const crypto = require('node:crypto');

const FORMAT = 'suds-audit-export';
const KEYED_PREFIX = 'v2:';
// Must match server/audit.js payloadOf — test/security-evidence.test.js exports a real chain and verifies it.
const payloadOf = (r) => [r.at, r.user_id || '', r.username || '', r.action, r.entity || '', r.entity_id || '', r.client_id || '', r.ip || '', r.success ? 1 : 0, r.details || '', r.prev_hash].join('|');
const ENTRY_FIELDS = ['id', 'at', 'user_id', 'username', 'action', 'entity', 'entity_id', 'client_id', 'ip', 'success', 'details', 'prev_hash', 'hash'];
function entryLine(r) { const o = { type: 'entry' }; for (const k of ENTRY_FIELDS) o[k] = r[k] === undefined ? null : r[k]; return JSON.stringify(o); }
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function manifestMac(m, key) { const { mac, ...rest } = m; return hmac(key, JSON.stringify(rest)); }

// The anchor MAC, duplicated from server/audit-anchor.js (which needs the database); the test checks they agree.
const ANCHOR_FIELDS = ['v', 'kind', 'at', 'reason', 'install', 'gen', 'prev_gen', 'head_id', 'head_hash', 'first_id', 'rows', 'host', 'key_id', 'prev_mac'];
function anchorMac(a, key) { const o = {}; for (const k of ANCHOR_FIELDS) o[k] = a[k] === undefined ? null : a[k]; return hmac(key, JSON.stringify(o)); }
const keyIdOf = (key) => hmac(key, 'suds-audit-anchor-key-id').slice(0, 16);

/**
 * Verify an export. Without `key`: the line digest, the chain's linkage (every entry's prev_hash is the hash
 * before it), the unkeyed (pre-2023 'SHA-256') entries' hashes, and the anchors' recorded hashes against
 * the entries they name. With `key` (the index key, held by the county's key custodian): additionally every
 * keyed entry's HMAC, the manifest's MAC and each anchor's MAC. `extraAnchors` are anchor objects obtained
 * independently (copied from the WORM share by the auditor), checked the same way as the embedded ones.
 */
function verifyExport(text, { key = null, extraAnchors = [] } = {}) {
  const errors = []; const warn = [];
  const lines = String(text).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out = { ok: false, level: key ? 'cryptographic (entries, manifest and anchors checked with the index key)' : 'structural (linkage, digest and anchors; keyed entry hashes not checked without the index key)', entries: 0, keyed_checked: 0, keyed_unchecked: 0, legacy_checked: 0, anchors_checked: 0, anchors_matched: 0, anchors_outside_range: 0, errors, warnings: warn };
  if (!lines.length) { errors.push('the file is empty'); return out; }
  let manifest; try { manifest = JSON.parse(lines[lines.length - 1]); } catch { manifest = null; }
  if (!manifest || manifest.type !== 'manifest') { errors.push('the last line is not a manifest: the file is incomplete or was cut short'); return out; }
  let header; try { header = JSON.parse(lines[0]); } catch { header = null; }
  if (!header || header.type !== 'header' || header.format !== FORMAT) errors.push('the first line is not a SUDS audit export header');
  out.header = header; out.manifest = { entries: manifest.entries, first_id: manifest.first_id, last_id: manifest.last_id, generated_at: header && header.generated_at };
  const body = lines.slice(0, -1).map((l) => l + '\n').join('');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  if (digest !== manifest.sha256) errors.push('the SHA-256 of the file does not match its manifest: lines were changed, added or removed');
  if (key) {
    if (!safeEq(manifestMac(manifest, key), manifest.mac)) errors.push('the manifest MAC does not verify with this index key (the manifest was altered, or the key is not the one this server used)');
    if (manifest.key_id && manifest.key_id !== keyIdOf(key)) warn.push('the manifest names a different index key than the one supplied');
  }
  const byId = new Map();
  let prev = null; let lastId = 0;
  for (let i = 1; i < lines.length - 1; i++) {
    let e; try { e = JSON.parse(lines[i]); } catch { errors.push(`line ${i + 1} is not JSON`); continue; }
    if (e.type !== 'entry') { errors.push(`line ${i + 1} is not an entry`); continue; }
    out.entries++;
    if (e.id <= lastId) errors.push(`entry ${e.id} is out of order`);
    lastId = e.id;
    if (prev === null) { if (manifest.first_prev_hash !== undefined && e.prev_hash !== manifest.first_prev_hash) errors.push(`the first entry's prev_hash does not match the manifest`); }
    else if (e.prev_hash !== prev) errors.push(`entry ${e.id} does not follow the entry before it (prev_hash mismatch): the chain is broken here`);
    const p = payloadOf(e);
    if (String(e.hash).startsWith(KEYED_PREFIX)) {
      if (key) { out.keyed_checked++; if (!safeEq(KEYED_PREFIX + hmac(key, p), e.hash)) errors.push(`entry ${e.id}: its hash does not verify with the index key (the entry was altered)`); }
      else out.keyed_unchecked++;
    } else {
      out.legacy_checked++;
      if (crypto.createHash('sha256').update(p).digest('hex') !== e.hash) errors.push(`entry ${e.id}: its (unkeyed) hash does not match its contents`);
    }
    byId.set(e.id, e.hash);
    prev = e.hash;
  }
  if (out.entries !== manifest.entries) errors.push(`the manifest lists ${manifest.entries} entries but the file holds ${out.entries}`);
  if (prev !== null && manifest.last_hash !== prev) errors.push('the last entry does not match the manifest');
  const anchors = [...(manifest.anchors || []).map((a) => ({ a, src: 'embedded' })), ...extraAnchors.map((a) => ({ a, src: 'supplied' }))];
  for (const { a, src } of anchors) {
    if (!a || a.kind !== 'suds-audit-anchor') continue;
    if (!byId.has(a.head_id)) { out.anchors_outside_range++; continue; }
    out.anchors_checked++;
    if (key && a.key_id === keyIdOf(key) && !safeEq(anchorMac(a, key), a.mac)) { errors.push(`${src} anchor for entry ${a.head_id} (${a.at}) does not verify with the index key`); continue; }
    if (byId.get(a.head_id) !== a.head_hash) { errors.push(`${src} anchor written ${a.at} recorded a different hash for entry ${a.head_id}: the chain was rewritten after it was anchored`); continue; }
    out.anchors_matched++;
  }
  if (!out.anchors_checked) warn.push('no anchor falls inside this range, so a wholesale rewrite before the export was made cannot be ruled out from this file alone; supply the anchor files (--anchors)');
  if (!key && out.keyed_unchecked) warn.push(`${out.keyed_unchecked} keyed entries were checked for linkage only; their HMACs need the index key (--key)`);
  out.ok = errors.length === 0;
  return out;
}

module.exports = { FORMAT, payloadOf, entryLine, manifestMac, anchorMac, keyIdOf, verifyExport, ENTRY_FIELDS };

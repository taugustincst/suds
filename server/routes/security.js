'use strict';
// The evidence a county IT reviewer asks for, served to administrators: Security status, the accounts
// without two-step verification, the recovery drill, audit anchors and the auditor's export of the chain.
// Office-server only (not part of the local-mode kernel: LOCAL_ROUTE_MODULES in server/app.js).
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const { badRequest, HttpError } = require('../http');

module.exports = (r) => {
  r.get('/api/admin/security/status', auth.requireAuth, auth.requirePerm('settings:manage'), () => require('../security-status').status());

  // The public half of the Ed25519 key that signs recovery-drill reports and audit-export manifests
  // (server/signing.js). Not a secret; an auditor records it once and verifies documents against it
  // (npm run verify-dr-report / verify-audit-export -- --public-key). ?format=pem downloads it as a file.
  r.get('/api/admin/security/signing-key', auth.requireAuth, auth.requirePerm('audit:read', 'settings:manage'), (ctx) => {
    const info = require('../signing').publicInfo();
    if (ctx.query.get('format') === 'pem') {
      ctx.res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': `attachment; filename="suds-signing-key-${info.key_id}.pem"` });
      ctx.res.end(info.public_key_pem); return;
    }
    return { ...info, signs: ['recovery-drill reports (<data>/backups/dr-drill-*.json)', 'audit-export manifests (GET /api/admin/audit/export)'], verify_with: ['npm run verify-dr-report -- <report.json> --public-key <this key>.pem', 'npm run verify-audit-export -- <export.ndjson> --public-key <this key>.pem'] };
  });

  r.get('/api/admin/security/mfa-report', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const rep = require('../security-status').mfaReport();
    audit.log({ user: ctx.user, action: 'security.mfa_report', ip: ctx.ip, details: { without: rep.without.length } });
    return rep;
  });

  // Production configuration problems for the Home page (server/startup-checks.js): a short label for the
  // alert and the full sentence. Empty outside production.
  r.get('/api/admin/security/alerts', auth.requireAuth, auth.requirePerm('settings:manage'), () => {
    const sc = require('../startup-checks');
    const out = [];
    const anchorProblem = require('../audit-anchor').placementProblem();
    if (anchorProblem) out.push({ key: 'audit_anchor_dir', label: 'Audit anchors are on the database disk', detail: anchorProblem });
    const backupProblem = sc.backupProblem();
    if (backupProblem) out.push({ key: 'backups_off', label: 'Scheduled backups are off', detail: backupProblem });
    return { alerts: out };
  });

  // ---- Deprovisioning by absence (server/deprovision.js) ----
  r.get('/api/admin/security/deprovisioning', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const rep = require('../deprovision').report();
    audit.log({ user: ctx.user, action: 'security.deprovision_report', ip: ctx.ip, details: { due: rep.due.length, soon: rep.soon.length } });
    return rep;
  });
  r.post('/api/admin/security/deprovisioning/run', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const d = require('../deprovision');
    if (!d.days()) throw badRequest('Set "Disable single sign-on accounts not seen for (days)" first (Settings → Security policy)');
    const out = d.run({ by: ctx.user });
    audit.log({ user: ctx.user, action: 'security.deprovision_run', ip: ctx.ip, details: { disabled: out.disabled.length } });
    return out;
  });

  // ---- Recovery drill (server/dr-drill.js) ----
  r.get('/api/admin/dr-drill', auth.requireAuth, auth.requirePerm('settings:manage'), () => require('../dr-drill').status());
  // Optional `keys_file`: the text of the escrowed key backup (keys.json), uploaded from the Settings page so
  // the drill proves that file opens the backup. It is parsed in memory, handed to the drill, and never
  // written to disk or to the audit log (only which kind of keys were used, and their short fingerprints,
  // appear in the report). `copy`: 'auto' | 'local' | 'offsite'.
  r.post('/api/admin/dr-drill', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const drill = require('../dr-drill');
    if (drill.status().running) throw new HttpError(409, 'A recovery drill is already running');
    const b = ctx.body || {};
    const keysText = typeof b.keys_file === 'string' && b.keys_file.trim() ? b.keys_file : null;
    if (keysText) { try { drill.parseKeysFile(keysText); } catch (e) { throw badRequest(e.message); } }
    const copy = ['auto', 'local', 'offsite'].includes(b.copy) ? b.copy : 'auto';
    const keysLabel = typeof b.keys_file_name === 'string' ? b.keys_file_name.replace(/[^\w.\- ]/g, '').slice(0, 80) : null;
    audit.log({ user: ctx.user, action: 'dr.drill.start', ip: ctx.ip, details: { fresh: !!b.fresh, keys: keysText ? 'uploaded escrow file' : 'server memory', copy } });
    drill.start({ by: { id: ctx.user.id, username: ctx.user.username }, trigger: 'manual', fresh: !!b.fresh, keysText, keysLabel, copy });
    ctx.status = 202;
    return { started: true };
  });

  // ---- Audit anchors (server/audit-anchor.js) ----
  r.post('/api/admin/audit/anchor', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    let a;
    try { a = require('../audit-anchor').write('manual'); }
    catch (e) { throw badRequest(`The anchor could not be written: ${e.message}`); }
    audit.log({ user: ctx.user, action: 'audit.anchor', ip: ctx.ip, details: a ? { head_id: a.head_id, file: a.file } : { empty: true } });
    return { ok: true, anchor: a };
  });

  // ---- Auditor's export of the chain (server/audit-export.js; verified by scripts/verify-audit-export.js) ----
  // A range of the audit log as NDJSON with a manifest (digest, MAC under the index key, the anchors inside
  // the range and the sealed head). Audit entries carry no PHI (CLAUDE.md), so this is not a disclosure, but
  // it names staff and client ids, so it is audit:read and is itself audited.
  r.get('/api/admin/audit/export', auth.requireAuth, auth.requirePerm('audit:read'), async (ctx) => {
    const ex = require('../audit-export');
    const q = ctx.query;
    const num = (k) => { const v = q.get(k); if (v === null || v === '') return null; if (!/^\d+$/.test(v)) throw badRequest(`${k} must be an entry id`); return Number(v); };
    const date = (k) => { const v = q.get(k); if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}/.test(v) || !Number.isFinite(Date.parse(v))) throw badRequest(`${k} must be a date (YYYY-MM-DD)`); return v; };
    let fromId = num('from_id'); let toId = num('to_id');
    const from = date('from'); const to = date('to');
    if (from) fromId = Math.max(fromId || 0, db.one(`SELECT MIN(id) m FROM audit_log WHERE at >= ?`, from).m || Number.MAX_SAFE_INTEGER);
    if (to) toId = Math.min(toId || Number.MAX_SAFE_INTEGER, db.one(`SELECT MAX(id) m FROM audit_log WHERE at <= ?`, to.length === 10 ? to + 'T23:59:59.999Z' : to).m || 0);
    const bounds = db.one(`SELECT MIN(id) mn, MAX(id) mx FROM audit_log`);
    fromId = Math.max(fromId || 0, bounds.mn || 0); toId = Math.min(toId === null ? Number.MAX_SAFE_INTEGER : toId, bounds.mx || 0);
    const count = toId >= fromId ? db.one(`SELECT COUNT(*) n FROM audit_log WHERE id BETWEEN ? AND ?`, fromId, toId).n : 0;
    // Audited before a byte is sent (the entry itself falls after the range, so it is not in this file).
    audit.log({ user: ctx.user, action: 'audit.export', ip: ctx.ip, details: { from_id: fromId, to_id: toId, entries: count } });
    const anchorMod = require('../audit-anchor');
    const anchors = anchorMod.list().filter((f) => f.anchor && f.anchor.head_id >= fromId && f.anchor.head_id <= toId).map((f) => f.anchor);
    const head = audit.checkHead();
    const crypto = require('node:crypto');
    const hash = crypto.createHash('sha256');
    const res = ctx.res;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="suds-audit-${fromId}-${toId}-${stamp}.ndjson"`, 'Cache-Control': 'no-store' });
    const write = (line) => { const s = line + '\n'; hash.update(s); return res.write(s); };
    const drained = () => new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
    const header = { type: 'header', format: ex.FORMAT, version: 1, generated_at: db.now(), server_version: config.version, org_name: db.getSetting('org_name', null), first_id: count ? fromId : null, last_id: count ? toId : null, chain: 'each entry: hash = "v2:" + HMAC-SHA256(index key, payload) (or plain SHA-256 for entries before keyed hashing); payload = at|user_id|username|action|entity|entity_id|client_id|ip|success|details|prev_hash' };
    write(JSON.stringify(header));
    let after = fromId - 1; let n = 0; let firstPrev = null; let lastHash = null;
    for (;;) {
      const rows = count ? db.all(`SELECT * FROM audit_log WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT 5000`, after, toId) : [];
      if (!rows.length) break;
      if (res.destroyed) return;
      for (const row of rows) { if (firstPrev === null) firstPrev = row.prev_hash; lastHash = row.hash; n++; if (!write(ex.entryLine(row))) await drained(); }
      after = rows[rows.length - 1].id;
      await new Promise((resolve) => (globalThis.setImmediate ? globalThis.setImmediate(resolve) : setTimeout(resolve, 0)));
    }
    const manifest = { type: 'manifest', entries: n, first_id: n ? fromId : null, last_id: n ? after : null, first_prev_hash: firstPrev, last_hash: lastHash, sha256: hash.digest('hex'), key_id: anchorMod.keyId(), anchors, head_checkpoint: head, verify_with: 'npm run verify-audit-export -- <this file> --public-key <signing-key.pem> [--key <SUDS_INDEX_KEY>] [--anchors <anchor dir>]' };
    ex.sealManifest(manifest, { indexKey: config.indexKey });
    res.end(JSON.stringify(manifest) + '\n');
  });
};

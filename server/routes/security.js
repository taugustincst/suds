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

  r.get('/api/admin/security/mfa-report', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const rep = require('../security-status').mfaReport();
    audit.log({ user: ctx.user, action: 'security.mfa_report', ip: ctx.ip, details: { without: rep.without.length } });
    return rep;
  });

  // ---- Recovery drill (server/dr-drill.js) ----
  r.get('/api/admin/dr-drill', auth.requireAuth, auth.requirePerm('settings:manage'), () => require('../dr-drill').status());
  r.post('/api/admin/dr-drill', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const drill = require('../dr-drill');
    if (drill.status().running) throw new HttpError(409, 'A recovery drill is already running');
    audit.log({ user: ctx.user, action: 'dr.drill.start', ip: ctx.ip, details: { fresh: !!(ctx.body && ctx.body.fresh) } });
    drill.start({ by: { id: ctx.user.id, username: ctx.user.username }, trigger: 'manual', fresh: !!(ctx.body && ctx.body.fresh) });
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
    const manifest = { type: 'manifest', entries: n, first_id: n ? fromId : null, last_id: n ? after : null, first_prev_hash: firstPrev, last_hash: lastHash, sha256: hash.digest('hex'), key_id: anchorMod.keyId(), anchors, head_checkpoint: head, verify_with: 'npm run verify-audit-export -- <this file> [--key <SUDS_INDEX_KEY>] [--anchors <anchor dir>]' };
    manifest.mac = ex.manifestMac(manifest, config.indexKey);
    res.end(JSON.stringify(manifest) + '\n');
  });
};

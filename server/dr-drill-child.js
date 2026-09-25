'use strict';
// The restored side of a disaster-recovery drill (server/dr-drill.js). Runs as its own process, forked by
// the drill, with SUDS_DATA_DIR and SUDS_DB_PATH pointing at a throwaway copy of the backup: this process
// never has the live database's path, so nothing it does can touch it. The keys arrive over the IPC channel
// (never on the command line or in the environment the parent passes), and are put where server/config.js
// looks before anything requires it.
//
// It proves what a real recovery needs: the backup opens with the keys the county holds, migrates to this
// build's schema, holds what it held when it was taken, its audit chain verifies, its encrypted fields
// decrypt, and the application serves from it — a sign-in with a second factor and an authenticated read.
// It reports counts, booleans and timings only; no decrypted value ever leaves this process.
const http = require('node:http');

function send(msg) { return new Promise((resolve) => { if (process.send) process.send(msg, () => resolve()); else resolve(); }); }
const progress = (step) => send({ type: 'progress', step, at: Date.now() });

async function drill({ keys, anchorDir }) {
  if (keys) {
    process.env.SUDS_ENCRYPTION_KEY = keys.enc;
    process.env.SUDS_INDEX_KEY = keys.idx;
    if (keys.sig) process.env.SUDS_SIGNING_KEY = keys.sig;
  }
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail }); };
  const out = { checks, adjustments: [] };
  const dbPath = process.env.SUDS_DB_PATH;
  const { DatabaseSync } = require('node:sqlite');

  // 1. The file as restored, before this build migrates it: the counts it was taken with.
  await progress('Opening the restored copy');
  const tablesOf = (d) => d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name);
  const countAll = (d) => Object.fromEntries(tablesOf(d).map((t) => [t, d.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  let sourceCounts; let sourceSchema;
  try {
    const ic = raw.prepare('PRAGMA integrity_check').get();
    check('The restored file passes SQLite integrity_check', String(ic.integrity_check).toLowerCase() === 'ok', ic.integrity_check);
    sourceCounts = countAll(raw);
    sourceSchema = Number(raw.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get()?.value || 0);
    out.latest_audit_at = raw.prepare(`SELECT MAX(at) m FROM audit_log`).get().m || null;
  } finally { raw.close(); }
  out.source_schema_version = sourceSchema;
  out.source_counts = sourceCounts;

  // 2. Open it the way the server would: migrations, then the key check.
  await progress('Starting SUDS against the restored copy');
  const config = require('./config');
  const db = require('./db');
  db.open();
  // Counted before anything below writes to the copy (the key check records a fingerprint on a database
  // that never had one).
  const restored = Object.fromEntries(Object.keys(sourceCounts).map((t) => [t, db.one(`SELECT COUNT(*) n FROM "${t}"`).n]));
  try { db.checkKeyFingerprint(); check('The encryption key in custody opens this backup', true); }
  catch (e) { check('The encryption key in custody opens this backup', false, e.message); }
  const schema = Number(db.getSetting('schema_version', '0'));
  out.schema_version = schema;
  check(`Schema is at this build's version (${db.LATEST_SCHEMA_VERSION})`, schema === db.LATEST_SCHEMA_VERSION, sourceSchema === schema ? `schema ${schema}` : `migrated ${sourceSchema} → ${schema}`);

  // 3. Row counts after opening, against the file as it was restored.
  // A backup from an older schema is migrated on open, and a migration may add settings rows of its own.
  const differ = Object.keys(sourceCounts).filter((t) => restored[t] !== sourceCounts[t] && !(t === 'settings' && sourceSchema !== schema));
  out.restored_counts = restored;
  check('Every table holds the rows the backup was taken with', !differ.length, differ.length ? differ.map((t) => `${t}: ${sourceCounts[t]} → ${restored[t]}`).join('; ') : `${Object.keys(restored).length} tables`);

  // 4. The audit chain, the whole of it, and the anchors written outside the database.
  await progress('Verifying the audit chain');
  const audit = require('./audit');
  const chain = audit.verifyChain();
  check('The audit chain verifies end to end', chain.ok, chain.ok ? `${chain.checked} entries` : `first bad entry ${chain.firstBadId || ''} ${chain.reason || ''}`.trim());
  out.audit_entries_verified = chain.checked || 0;
  if (anchorDir) {
    const anchors = require('./audit-anchor').verify({ d: anchorDir, tolerateNewer: true });
    out.anchors = { total: anchors.total, matched: anchors.matched, newer: anchors.newer, other_key: anchors.other_key, purged: anchors.purged, bad: anchors.bad.length };
    if (anchors.total) check('The restored audit chain matches the anchors written before the backup', anchors.ok, `${anchors.matched} matched, ${anchors.newer} written after this backup${anchors.bad.length ? `; ${anchors.bad[0].reason}` : ''}`);
  }

  // 5. Encrypted fields decrypt: a sample of every *_enc column.
  await progress('Decrypting a sample of encrypted fields');
  const { decrypt } = require('./crypto');
  let tried = 0; let failed = 0; const failedCols = [];
  for (const t of Object.keys(restored)) {
    const cols = db.all(`PRAGMA table_info("${t}")`).map((c) => c.name).filter((c) => c.endsWith('_enc'));
    for (const c of cols) {
      for (const r of db.all(`SELECT "${c}" v FROM "${t}" WHERE "${c}" IS NOT NULL AND "${c}" <> '' ORDER BY random() LIMIT 5`)) {
        tried++;
        try { decrypt(r.v); } catch { failed++; if (!failedCols.includes(`${t}.${c}`)) failedCols.push(`${t}.${c}`); }
      }
    }
  }
  out.decrypt_sample = { tried, failed };
  check('A sample of encrypted fields decrypts', tried === 0 ? true : failed === 0, tried === 0 ? 'the backup holds no encrypted values yet' : failed ? `${failed} of ${tried} failed (${failedCols.join(', ')})` : `${tried} values across every *_enc column`);

  // 6. Serve it. Jobs that belong to the live server are switched off in this copy first, and a throwaway
  //    administrator with a known second factor is added — to the copy only, which is deleted afterwards.
  await progress('Signing in to the restored copy');
  for (const k of ['backup_schedule_hours', 'dr_drill_monthly', 'sso_required']) {
    if (db.getSetting(k, null) !== null) { db.run(`DELETE FROM settings WHERE key=?`, k); out.adjustments.push(`${k} cleared in the drill copy`); }
  }
  const { uuid, hashPassword, randomToken, generateTotpSecret, totp, encrypt } = require('./crypto');
  const username = `dr-drill-${randomToken(6).replace(/[^a-zA-Z0-9]/g, 'x')}`;
  const password = `Dr!${randomToken(18)}9a`;
  const secret = generateTotpSecret();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,is_active,mfa_enabled,mfa_secret_enc,must_change_password,password_changed_at) VALUES(?,?,?,?,?,1,1,?,0,?)`, uuid(), username, hashPassword(password), 'Recovery drill', 'admin', encrypt(secret), db.now());
  const { createHandler } = require('./app');
  const server = http.createServer(createHandler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  try {
    const health = await call('GET', '/api/health');
    out.ready_at = Date.now();
    check('The application serves from the restored copy (/api/health)', health.status === 200 && health.data && health.data.database === 'ok', health.status === 200 ? 'healthy' : `HTTP ${health.status}${health.data && health.data.warnings ? ': ' + health.data.warnings.join(' ') : ''}`);
    const login = await call('POST', '/api/auth/login', { username, password });
    const mfa = login.status === 200 && login.data.mfaPending ? await call('POST', '/api/auth/mfa/verify', { code: totp(secret) }) : { status: 0 };
    check('Password and second-factor sign-in work', login.status === 200 && mfa.status === 200, `login HTTP ${login.status}, MFA HTTP ${mfa.status}`);
    const stats = await call('GET', '/api/admin/stats');
    const liveClients = db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n;
    check('An authenticated read returns the restored records', stats.status === 200 && stats.data.clients === liveClients, `HTTP ${stats.status}, ${stats.data ? stats.data.clients : '?'} clients`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (server.closeAllConnections) server.closeAllConnections();
    try { db.close(); } catch {}
  }
  out.config_env = config.env;
  return out;
}

process.once('message', async (msg) => {
  let result;
  try { result = { type: 'result', ok: true, ...(await drill(msg || {})) }; }
  catch (e) { result = { type: 'result', ok: false, error: String(e && e.message || e), checks: [{ name: 'The drill ran to completion', ok: false, detail: String(e && e.message || e) }] }; }
  await send(result);
  process.exit(0);
});

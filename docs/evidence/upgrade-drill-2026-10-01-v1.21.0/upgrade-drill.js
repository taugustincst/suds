'use strict';
// Upgrade drill: a database written by an older released SUDS, opened by a newer one, then backed up, restored and
// drilled with the newer one. Evidence tooling for docs/evidence/upgrade-drill-2026-10-01-v1.21.0/ (README.md there);
// not part of the product, and it never touches a real data directory: everything lives under a new temporary
// directory, with keys generated for the run and deleted with it. It is docs/evidence/upgrade-drill-2026-09-30-v1.20.0/'s
// driver with what migrations 61 to 63 (1.21.0) touch added: before the upgrade, an older release with passkeys
// (1.19.0 on) enrols one through its own API (test/authenticator.js, a software authenticator) and signs in with it;
// a sync device signs in (a devices row and a sync session); an older release with county-entered figures (1.20.0)
// enters a quarter for a programme not on SUDS. After it, the newer release is checked to keep every one of those rows
// and sessions, to give every device sync_scope 'full', every client no participant code, every passkey no
// attestation and every older session no device_id, to have the new tables, to sign the passkey and the device in
// again, and to publish a screened county release (migration 61's table) over the figures the older release kept.
//
//   git archive v1.16.2 | tar -x -C /tmp/suds-1.16.2        (and 348e18c, the v1.21.0 commit, into /tmp/suds-1.21.0)
//   node docs/evidence/upgrade-drill-2026-10-01-v1.21.0/upgrade-drill.js --from /tmp/suds-1.16.2 --to /tmp/suds-1.21.0 \
//        [--clients 2000] [--out <dir>]
//
// Each step runs the named release's own code in its own process (cwd = that release's tree):
//   old  1  npm run seed (its sample data), then N fictional clients x 8 visits, each creation audited (as
//           scripts/dr-exercise.js adds volume)
//   old  2  its server (server/index.js) on that data directory, driven through its API: a navigator writes a note
//           and signs it (password), a supervisor countersigns it, the navigator enrols TOTP; a release with the
//           county view (1.18.0 on) also makes a county-submission signing key and rotates it (migration 56's
//           table), registers itself as a county programme with that key, and imports its own signed county files
//           for two quarters, the second quarter twice (so one row is superseded by another); a release with
//           passkeys (1.19.0 on) enrols one for the navigator (before TOTP) and signs in with it; a release with
//           county-entered figures (1.20.0) enters a quarter for a programme not on SUDS; a sync device (supervisor,
//           X-Sync-Client + X-Device-Id) signs in; every signed-in session is kept
//   old  3  an audit anchor sealed outside the database; the manifest: row counts of every table, a SHA-256 of the
//           plaintext of up to 25 rows of every *_enc column, the note's hashes, verifyChain(), the county rows,
//           and the rows of sessions, devices and passkeys (the columns an upgrade must not change)
//   new  4  its server started on the same data directory: the upgrade (migrations) runs at start; then through
//           its API: the session kept from the old release, a new sign-in with password + TOTP, the note's
//           GET /api/notes/:id/verify, a name search (blind index), every kept session (browser, passkey, device),
//           the passkey and the device signing in again (the device told scope 'full'), the county files and
//           entered figures listed, and a screened county release prepared and published over them (migration 61)
//   new  5  structure and data: schema_version, integrity_check, foreign_key_check, schema shape equal to a fresh
//           install (schema.sql executed, and a database the new release creates itself; the comparison of
//           test/migrations.test.js), every table's rows, every sampled value decrypts to the same plaintext, the
//           note's signature hashes, the audit chain, the sessions, devices and passkeys kept, migrations 61-63's
//           tables and defaults, the county rows, the sealed pre-migration snapshot
//   new  6  after the upgrade: an encrypted backup (server/scheduled-backup.js run), the recovery drill with the
//           escrowed key file (scripts/dr-drill.js), the host restore (scripts/backup.js --restore) into a fresh
//           data directory served by server/index.js, row counts and the audit chain there, and the signed
//           report verified with the public key only (scripts/verify-dr-report.js)
// Exit status 0 only if every check passed. With --out, the signed report (.json, .txt), the public key and
// summary.json are copied there.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');

// ---- child tasks: run inside a release tree (process.cwd()), print one JSON line last ----
const CHILD = process.argv[2] === '--child' ? process.argv[3] : null;
if (CHILD) {
  const tree = process.cwd();
  const req = (m) => require(path.join(tree, 'server', m));
  const out = (v) => console.log(JSON.stringify(v));
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const shape = (d) => { // test/migrations.test.js schemaShape, verbatim in what it compares
    const o = {};
    for (const t of d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()) {
      if (t.name.startsWith('__new_')) continue;
      o[t.name] = {
        columns: d.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? ''} pk=${c.pk}`).sort(),
        indexes: d.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(t.name).map((i) => i.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /gi, '').trim()).sort(),
        triggers: d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`).all(t.name).map((i) => i.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /gi, '').trim()).sort(),
      };
    }
    delete o.sync_seen; // created outside schema.sql (test/migrations.test.js assertSameShape)
    return o;
  };
  const diff = (a, b) => { // names of what differs between two shapes
    const out2 = [];
    for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!a[t] || !b[t]) { out2.push(`${t}: ${a[t] ? 'only upgraded' : 'only fresh'}`); continue; }
      for (const k of ['columns', 'indexes', 'triggers']) if (JSON.stringify(a[t][k]) !== JSON.stringify(b[t][k])) out2.push(`${t}.${k}`);
    }
    return out2;
  };
  const counts = (db) => Object.fromEntries(db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => [r.name, db.one(`SELECT COUNT(*) n FROM "${r.name}"`).n]));
  const samples = (db, decrypt) => {
    const s = {};
    for (const { name } of db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)) {
      const cols = db.all(`PRAGMA table_info("${name}")`).map((c) => c.name);
      if (!cols.includes('id')) continue;
      for (const c of cols.filter((x) => x.endsWith('_enc'))) {
        for (const r of db.all(`SELECT id, "${c}" v FROM "${name}" WHERE "${c}" IS NOT NULL AND "${c}" != '' ORDER BY rowid LIMIT 25`)) s[`${name}.${c}.${r.id}`] = sha(decrypt(r.v));
      }
    }
    return s;
  };
  // The county submissions and programmes (migrations 56 and 60), with a SHA-256 of each decrypted payload.
  const countyRows = (db, decrypt) => {
    const has = (t) => !!db.one(`SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?`, t);
    if (!has('county_submissions')) return null;
    const cols = db.all(`PRAGMA table_info(county_submissions)`).map((c) => c.name);
    const pcols = db.all(`PRAGMA table_info(county_programmes)`).map((c) => c.name);
    return {
      submissions: db.all(`SELECT id, programme_id, key_id, period_from, period_to, sha256, signature, superseded_by, withdrawn_at, payload_enc${cols.includes('source') ? ', source, entered_via, source_ref_enc' : ''} FROM county_submissions ORDER BY received_at, id`)
        .map((r) => { const o = { ...r, payload_sha256: sha(decrypt(r.payload_enc)) }; delete o.payload_enc; return o; }),
      programmes: db.all(`SELECT id, name${pcols.includes('on_suds') ? ', on_suds' : ''} FROM county_programmes ORDER BY id`).map((r) => ({ ...r })),
      submissions_not_null: Object.fromEntries(db.all(`PRAGMA table_info(county_submissions)`).filter((c) => ['key_id', 'signature'].includes(c.name)).map((c) => [c.name, c.notnull])),
    };
  };
  // Rows an upgrade must keep, by the columns it must not change (volatile ones such as last_seen_at are left out:
  // signing in again after the upgrade moves them).
  const KEEP = { sessions: ['id', 'user_id', 'created_at', 'mfa_pending', 'reauth_method', 'passkey_id', 'sync_client', 'revoked_at'],
    devices: ['id', 'user_id', 'label', 'first_seen_at', 'revoked_at', 'wipe_requested_at'],
    passkeys: ['id', 'user_id', 'credential_id', 'public_key', 'name', 'created_at'] };
  const keepRows = (db) => {
    const o = {};
    for (const [t, want] of Object.entries(KEEP)) {
      if (!db.one(`SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?`, t)) continue;
      const have = db.all(`PRAGMA table_info("${t}")`).map((c) => c.name);
      const cols = want.filter((c) => have.includes(c));
      o[t] = { cols, rows: db.all(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${t}" ORDER BY id`).map((r) => ({ ...r })) };
    }
    return o;
  };
  (async () => {
    if (CHILD === 'volume') {
      const n = Number(process.env.DRILL_CLIENTS);
      const db = req('db'); db.open(); const audit = req('audit'); const { encryptFields, uuid } = req('clients-model'); const { blindIndex } = req('crypto');
      const u = db.one(`SELECT id FROM users WHERE username='mrivera'`).id;
      db.transaction(() => {
        for (let i = 0; i < n; i++) {
          const id = uuid(); const last = 'Exercise' + (i % 500); const first = 'Person' + i;
          const enc = encryptFields({ first_name: first, last_name: last, dob: '1980-01-01', phone: '555' + String(i).padStart(7, '0') }); enc.full_name_idx = blindIndex(last + first);
          const cols = { id, client_code: 'UPG-' + String(i).padStart(6, '0'), status: 'active', risk_level: 'moderate', intake_date: '2026-01-01', created_by: u, ...enc };
          const k = Object.keys(cols).filter((x) => cols[x] !== undefined);
          db.run(`INSERT INTO clients(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`, ...k.map((x) => cols[x]));
          for (let j = 0; j < 8; j++) db.run('INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality) VALUES(?,?,?,?,?,?,?,?)', uuid(), id, u, 'check_in', `2026-0${1 + (j % 9)}-15T10:00:00.000Z`, 30, 'office', 'in_person');
          audit.log({ user: { id: u, username: 'mrivera' }, action: 'client.create', entity: 'client', entityId: id, clientId: id, details: { client_code: cols.client_code } });
        }
      });
      out({ clients: db.one('SELECT COUNT(*) n FROM clients').n, audit: db.one('SELECT COUNT(*) n FROM audit_log').n }); db.close();
    } else if (CHILD === 'manifest') {
      const db = req('db'); db.open(); const { decrypt } = req('crypto');
      const f = req('audit-anchor').safeWrite('upgrade-drill');
      const noteId = process.env.DRILL_NOTE_ID;
      const note = db.one(`SELECT id, status, signed_by, signature_hash, cosigned_by, cosignature_hash FROM notes WHERE id=?`, noteId);
      const users = db.all(`SELECT username, role, mfa_enabled, is_active FROM users ORDER BY username`).map((r) => ({ ...r }));
      out({ version: require(path.join(tree, 'package.json')).version, schema_version: Number(db.getSetting('schema_version')), anchor: f && path.basename(String(f.file || f)),
        counts: counts(db), samples: samples(db, decrypt), note: { ...note }, users, audit: req('audit').verifyChain(),
        sessions: db.one(`SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL`).n, county: countyRows(db, decrypt), keep: keepRows(db) });
      db.close();
    } else if (CHILD === 'verify') {
      const { DatabaseSync } = require('node:sqlite');
      const m = JSON.parse(fs.readFileSync(process.env.DRILL_MANIFEST, 'utf8'));
      const db = req('db'); db.open(); const { decrypt } = req('crypto'); const NS = req('note-signature');
      const r = { schema_version: Number(db.getSetting('schema_version')), latest: db.LATEST_SCHEMA_VERSION };
      r.integrity = db.one('PRAGMA integrity_check').integrity_check;
      r.foreign_key_violations = db.all('PRAGMA foreign_key_check').length;
      const up = shape(db.get());
      const sqlFresh = path.join(process.env.DRILL_WORK, 'fresh-schema-sql.db'); fs.rmSync(sqlFresh, { force: true });
      const f1 = new DatabaseSync(sqlFresh); f1.exec(fs.readFileSync(path.join(tree, 'server', 'schema.sql'), 'utf8')); const fresh1 = shape(f1); f1.close();
      r.tables = Object.keys(up).length;
      r.shape_vs_schema_sql = diff(up, fresh1);
      // Row counts and every sampled value, against the old release's manifest.
      const now = counts(db);
      r.counts = { before: m.counts, after: now };
      r.lost = Object.keys(m.counts).filter((t) => (now[t] ?? -1) < m.counts[t]);
      r.changed = Object.keys(m.counts).filter((t) => now[t] !== m.counts[t]).map((t) => `${t} ${m.counts[t]} -> ${now[t]}`);
      r.new_tables = Object.keys(now).filter((t) => !(t in m.counts)).map((t) => `${t} ${now[t]}`);
      let same = 0; const bad = [];
      for (const [k, h] of Object.entries(m.samples)) {
        const [t, c, ...id] = k.split('.');
        const row = db.one(`SELECT "${c}" v FROM "${t}" WHERE id=?`, id.join('.'));
        let got = null; try { got = row && sha(decrypt(row.v)); } catch { got = 'error'; }
        if (got === h) same++; else bad.push(k);
      }
      r.samples = { compared: Object.keys(m.samples).length, same, differ: bad.slice(0, 20), columns: new Set(Object.keys(m.samples).map((k) => k.split('.').slice(0, 2).join('.'))).size };
      const n = db.one(`SELECT * FROM notes WHERE id=?`, m.note.id);
      r.note = { status: n.status, signature_hash_unchanged: n.signature_hash === m.note.signature_hash, signature_intact: NS.signatureHash(n, n.signed_by) === n.signature_hash,
        cosignature_hash_unchanged: n.cosignature_hash === m.note.cosignature_hash, cosignature_intact: !!n.cosignature_hash && NS.cosignatureHash(n, n.cosigned_by) === n.cosignature_hash };
      r.users = { before: m.users, after: db.all(`SELECT username, role, mfa_enabled, is_active FROM users ORDER BY username`).map((x) => ({ ...x })) };
      r.users_unchanged = JSON.stringify(r.users.before) === JSON.stringify(r.users.after);
      r.audit = req('audit').verifyChain();
      r.audit_before = m.audit;
      const sessCols = db.all(`PRAGMA table_info(sessions)`).map((c) => c.name);
      r.session_columns = ['reauth_method', 'passkey_id', 'sync_client'].filter((c) => sessCols.includes(c));
      r.old_sessions = db.all(`SELECT sync_client, reauth_method, passkey_id IS NOT NULL with_passkey, COUNT(*) n FROM sessions WHERE created_at < ? GROUP BY 1,2,3`, process.env.DRILL_UPGRADE_AT).map((x) => ({ ...x }));
      // Sessions, devices and passkeys the old release wrote: each row still there with the same values.
      const nowKeep = keepRows(db);
      r.kept = Object.fromEntries(Object.entries(m.keep || {}).map(([t, b]) => {
        const after = new Map(nowKeep[t].rows.map((x) => [x.id, x]));
        const bad = b.rows.filter((x) => { const y = after.get(x.id); return !y || b.cols.some((c) => y[c] !== x[c]); }).map((x) => x.id);
        return [t, { before: b.rows.length, kept: b.rows.length - bad.length, changed_or_lost: bad }];
      }));
      // Migrations 61-63 (1.21.0): the new tables, and the defaults the new columns take on rows written before them.
      const has = (t) => !!db.one(`SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?`, t);
      const colsOf = (t) => db.all(`PRAGMA table_info("${t}")`).map((c) => c.name);
      const plain = (x) => (x ? { ...x } : x);
      r.m61_63 = {
        tables: Object.fromEntries(['county_publications', 'authenticator_metadata'].map((t) => [t, has(t) ? now[t] : null])),
        devices: db.all(`SELECT sync_scope, scope_changed_at, field_applied_at, COUNT(*) n FROM devices WHERE first_seen_at < ? GROUP BY 1,2,3`, process.env.DRILL_UPGRADE_AT).map((x) => ({ ...x })),
        clients: { total: now.clients, participant_code_set: colsOf('clients').includes('participant_code_enc') ? db.one(`SELECT COUNT(*) n FROM clients WHERE participant_code_enc IS NOT NULL OR participant_code_idx IS NOT NULL`).n : null },
        passkeys: colsOf('passkeys').includes('attestation') ? plain(db.one(`SELECT COUNT(*) n, COALESCE(SUM(attestation IS NOT NULL),0) attested FROM passkeys WHERE created_at < ?`, process.env.DRILL_UPGRADE_AT)) : null,
        old_sessions_device_id: colsOf('sessions').includes('device_id') ? plain(db.one(`SELECT COUNT(*) n, COALESCE(SUM(device_id IS NOT NULL),0) with_device FROM sessions WHERE created_at < ?`, process.env.DRILL_UPGRADE_AT)) : null,
        participant_code_index: !!db.one(`SELECT 1 x FROM sqlite_master WHERE type='index' AND name='idx_clients_participant_code'`),
      };
      r.new_tables_rows = Object.fromEntries(['passkeys', 'webauthn_challenges', 'signature_evidence', 'county_signing_keys', 'county_programmes', 'county_programme_keys', 'county_submissions', 'county_connect_tokens', 'county_connection', 'county_connect_sends', 'county_publications', 'authenticator_metadata', 'devices'].map((t) => [t, now[t]]));
      const ck = db.all(`SELECT * FROM county_signing_keys`);
      r.county = { before: m.county, after: countyRows(db, decrypt) };
      r.county_signing_keys = ck.map((k) => { const enc = Object.keys(k).filter((c) => c.endsWith('_enc') && k[c]); let ok = true; for (const c of enc) { try { decrypt(k[c]); } catch { ok = false; } } return { enc_columns: enc, decrypts: ok }; });
      // The pre-migration snapshot (server/db.js snapshotBeforeMigration), sealed with the backup key once the upgrade took.
      const snapDir = path.join(process.env.SUDS_DATA_DIR, 'pre-migration');
      const snaps = fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : [];
      r.pre_migration = { files: snaps };
      if (snaps.length) {
        const plain = path.join(process.env.DRILL_WORK, 'snap-check.db');
        fs.writeFileSync(plain, req('backup').decrypt(fs.readFileSync(path.join(snapDir, snaps[0]))));
        const s = new DatabaseSync(plain, { readOnly: true });
        r.pre_migration.schema_version = Number(s.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get().value);
        r.pre_migration.clients = s.prepare('SELECT COUNT(*) n FROM clients').get().n;
        s.close(); fs.rmSync(plain, { force: true });
      }
      db.close();
      // A database this release creates itself (the fresh-install path through db.open), compared the same way.
      const freshDir = path.join(process.env.DRILL_WORK, 'fresh-install'); fs.mkdirSync(freshDir, { recursive: true });
      db.open(path.join(freshDir, 'suds.db')); const fresh2 = shape(db.get()); db.close();
      r.shape_vs_fresh_install = diff(up, fresh2);
      out(r);
    } else if (CHILD === 'backup') {
      const db = req('db'); db.open();
      const c = counts(db);
      const o = await req('scheduled-backup').run({ retain: 14 });
      out({ counts: c, file: o.file, bytes: o.bytes, verified: o.verified, method: o.method, error: o.error || o.verifyError || null }); db.close();
    } else if (CHILD === 'restored') {
      const db = req('db'); db.open();
      out({ counts: counts(db), audit: req('audit').verifyChain(), schema_version: Number(db.getSetting('schema_version')) }); db.close();
    } else if (CHILD === 'latest') {
      out(req('db').LATEST_SCHEMA_VERSION);
    } else if (CHILD === 'pubkey') {
      out(req('signing').publicInfo());
    }
  })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
  return;
}

// ---- the orchestrator ----
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const FROM = path.resolve(arg('--from'));
const TO = path.resolve(arg('--to'));
const OUT = arg('--out') ? path.resolve(arg('--out')) : null;
const SCALE = Number(arg('--clients', '2000'));
const ver = (t) => JSON.parse(fs.readFileSync(path.join(t, 'package.json'), 'utf8')).version;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-upgrade-drill-'));
const dataDir = path.join(work, 'data'); const freshDir = path.join(work, 'fresh-data'); const scratch = path.join(work, 'restore-scratch'); const anchors = path.join(work, 'anchors');
for (const d of [dataDir, freshDir, scratch, anchors]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const hex = () => crypto.randomBytes(32).toString('hex');
const keys = { SUDS_ENCRYPTION_KEY: hex(), SUDS_INDEX_KEY: hex(), SUDS_BACKUP_KEY: hex(), SUDS_SIGNING_KEY: hex() };
const keysFile = path.join(work, 'escrowed-keys.json'); fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
const ADMIN_PW = 'Drill-' + crypto.randomBytes(9).toString('base64url') + '1!';
const baseEnv = { ...process.env, SUDS_ENV: 'development', ...keys, AUDIT_ANCHOR_DIR: anchors, LOG_FORMAT: 'text', MFA_REQUIRED_ROLES: '', SUDS_ADMIN_USERNAME: 'admin', SUDS_ADMIN_PASSWORD: ADMIN_PW, DRILL_WORK: work };
delete baseEnv.SUDS_DB_PATH;
const envFor = (dir, extra = {}) => ({ ...baseEnv, SUDS_DATA_DIR: dir, ...extra });
const PW = 'Navigator2026!!'; // the sample data's published demo password (scripts/seed.js)

const steps = [];
function record(name, ms, ok, detail) { steps.push({ name, ms: Math.round(ms), ok: !!ok, detail }); console.log(`[upgrade-drill] ${ok ? 'PASS' : 'FAIL'} ${name} (${Math.round(ms)} ms)${detail ? ` — ${detail}` : ''}`); }
function run(tree, argv, env) {
  const t = performance.now();
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', ...argv], { cwd: tree, env, encoding: 'utf8', maxBuffer: 256 << 20 });
  return { ms: performance.now() - t, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function child(tree, task, env) {
  const r = run(tree, [__filename, '--child', task], env);
  let value = null; try { value = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { process.stdout.write(r.stdout.slice(-2000)); process.stderr.write(r.stderr.slice(-2000)); }
  return { ...r, value };
}
async function startServer(tree, dir) {
  const port = 20000 + crypto.randomInt(20000);
  const t = performance.now();
  const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], { cwd: tree, env: { ...envFor(dir), PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  let health = null;
  for (let i = 0; i < 1200 && !health && p.exitCode === null; i++) {
    await new Promise((res) => setTimeout(res, 100));
    try { const res = await fetch(`http://127.0.0.1:${port}/api/health`); const body = await res.json(); if (body.database === 'ok') health = { status: res.status, body }; } catch {}
  }
  return { proc: p, base: `http://127.0.0.1:${port}`, health, ms: performance.now() - t, log: () => log, stop: async () => { if (p.exitCode === null) { p.kill('SIGTERM'); await new Promise((res) => p.once('exit', res)); } } };
}
function client(base, extra = {}) {
  let cookie = '';
  const call = async (method, p, body, { raw = false } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...extra, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
    const d = await res.json().catch(() => null);
    if (raw) return { status: res.status, body: d };
    if (res.status >= 300) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(d)}`);
    return d;
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}
// RFC 6238 (SHA-1, 6 digits, 30 s), as an authenticator app computes it; kept here so this process loads no
// release code (which would read keys from the environment).
function totp(secretB32, time = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of secretB32.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const h = crypto.createHmac('sha1', key).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// A code is used once (per 30 s step): each later sign-in uses a step after the last one used.
let lastStep = 0;
async function freshCode(secret) {
  while (Math.floor((Date.now() + 30000) / 30000) <= lastStep) await new Promise((res) => setTimeout(res, 500));
  lastStep = Math.floor((Date.now() + 30000) / 30000);
  return totp(secret, Date.now() + 30000);
}
const rows = (d) => (Array.isArray(d) ? d : d.rows || d.clients || d.items || []);
// A software WebAuthn authenticator (this repository's test/authenticator.js; no release code), for the passkey.
const { SoftAuthenticator } = require(path.join(__dirname, '..', '..', '..', 'test', 'authenticator.js'));
const DEVICE = { 'X-Sync-Client': '1', 'X-Device-Id': 'upgrade-drill-device-1' };
async function passkeySignIn(base, a) {
  a.origin = base;
  const c = client(base);
  const o = await c.call('POST', '/api/auth/passkeys/login/options', { username: 'mrivera' });
  const res = await c.call('POST', '/api/auth/passkeys/login', { credential: a.get(o.publicKey) }, { raw: true });
  return { c, res };
}
// County-entered figures for one quarter (the Enter figures form's fields, 1.20.0 on).
const FUND = { name: 'County settlement share', grant_number: 'OSF-DRILL-1', category: 'core_h', hiaa: 'hiaa_4', spend_own_category: '1000.50', spend_other_categories: '0', spend_pending: '25',
  contacts: '120', naloxone_kits: '80', fentanyl_strips: '300', syringes: '900', reversals: '3', treatment_admissions: '2', education_contacts: '5', staff_training_hours: '12.5',
  referrals_made: '14', people_served: '70', people_linked: '6', moud_linked: '2', people_trained: '9' };

async function main() {
  const started = new Date();
  const from = ver(FROM); const to = ver(TO);
  console.log(`[upgrade-drill] ${from} (${FROM}) -> ${to} (${TO}); work directory ${work}; node ${process.version}`);
  const ctx = {};
  // ---- old 1: sample data and volume ----
  let r = run(FROM, ['scripts/seed.js'], envFor(dataDir));
  record(`${from}: seed the fictional sample data (npm run seed)`, r.ms, r.status === 0, (r.stdout.match(/Seeded[^\n]*/) || [r.stderr.slice(-300)])[0]);
  if (r.status !== 0) return finish(started, ctx);
  if (SCALE > 0) {
    r = child(FROM, 'volume', envFor(dataDir, { DRILL_CLIENTS: String(SCALE) }));
    record(`${from}: add ${SCALE} fictional clients with 8 visits each, every creation audited`, r.ms, !!r.value, r.value ? `${r.value.clients} clients, ${r.value.audit} audit entries` : '');
    if (!r.value) return finish(started, ctx);
  }
  // ---- old 2: through its own API ----
  let srv = await startServer(FROM, dataDir);
  record(`${from}: its server starts on the data directory (/api/health)`, srv.ms, !!srv.health, srv.health ? `HTTP ${srv.health.status}` : srv.log().slice(-800));
  if (!srv.health) { await srv.stop(); return finish(started, ctx); }
  let secret = null;
  try {
    const t = performance.now();
    const nav = client(srv.base);
    await nav.call('POST', '/api/auth/login', { username: 'mrivera', password: PW });
    const list = rows(await nav.call('GET', '/api/clients?limit=5'));
    const cl = list[0];
    const note = await nav.call('POST', '/api/notes', { client_id: cl.id, kind: 'admin', title: 'Upgrade drill note', content: `Signed on ${from}; must verify on ${to}. Zoë 李明 ✓`, occurred_at: new Date().toISOString() });
    const signed = await nav.call('POST', `/api/notes/${note.id}/sign`, { password: PW, confirm: true });
    const sup = client(srv.base);
    await sup.call('POST', '/api/auth/login', { username: 'jwalker', password: PW });
    const cos = await sup.call('POST', `/api/notes/${note.id}/cosign`, { password: PW, confirm: true });
    const extras = [];
    if (fs.existsSync(path.join(FROM, 'server', 'routes', 'passkeys.js'))) {
      // A passkey for the navigator (before TOTP, so the password alone opens enrolment), and a sign-in with it.
      const a = new SoftAuthenticator({ origin: srv.base });
      const o = await nav.call('POST', '/api/auth/passkeys/register/options', { password: PW });
      const reg = await nav.call('POST', '/api/auth/passkeys/register', { credential: a.create(o.publicKey), name: 'Drill phone' });
      const pk = await passkeySignIn(srv.base, a);
      if (pk.res.status !== 200) throw new Error(`passkey sign-in on ${from}: HTTP ${pk.res.status} ${JSON.stringify(pk.res.body)}`);
      ctx.authenticator = a; ctx.passkeySessionCookie = pk.c.cookie;
      extras.push(`passkey ${String((reg.passkey && reg.passkey.id) || '').slice(0, 8)}… enrolled for mrivera and signed in with (HTTP ${pk.res.status})`);
    } else extras.push('no passkeys in this release');
    // A sync device (the supervisor's): a devices row and a sync session.
    const dev = client(srv.base, DEVICE);
    const dl = await dev.call('POST', '/api/auth/login', { username: 'jwalker', password: PW });
    ctx.deviceSessionCookie = dev.cookie;
    extras.push(`sync device ${DEVICE['X-Device-Id']} signed in as jwalker (token ${dl.token ? 'issued' : 'missing'})`);
    const setup = await nav.call('POST', '/api/auth/mfa/setup', {});
    secret = setup.secret;
    lastStep = Math.floor(Date.now() / 30000);
    await nav.call('POST', '/api/auth/mfa/enable', { code: totp(secret) });
    const oldVerify = await nav.call('GET', `/api/notes/${note.id}/verify`);
    ctx.note = { id: note.id, client_id: cl.id, signature_hash: signed.signature_hash, cosignature_hash: cos.cosignature_hash };
    ctx.oldSessionCookie = nav.cookie; // a session opened on the old release, kept across the upgrade
    let county = 'not in this release';
    if (fs.existsSync(path.join(FROM, 'server', 'routes', 'county.js'))) {
      const adm = client(srv.base);
      await adm.call('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
      const k = await adm.call('POST', '/api/county-submission/key', {});
      const k2 = await adm.call('POST', '/api/county-submission/key/new', {});
      county = `county-submission signing key ${k.key.fingerprint} made and rotated to ${k2.key.fingerprint} (${(k2.retired || []).length} retired)`;
      // This server is both the programme and the county: it registers itself with its current key, makes its own
      // signed county files and imports them (the rows migration 60 rebuilds).
      const code = await adm.call('GET', '/api/county/code');
      const opts = await adm.call('GET', '/api/county-submission/options');
      const funds = opts.funds.map((f) => f.id);
      const cur = await adm.call('GET', '/api/county-submission/key');
      const prog = await adm.call('POST', '/api/county/programmes', { name: 'Upgrade Drill Programme', public_key: cur.key.public_key, compared: true });
      const file = (from, to) => adm.call('GET', `/api/county-submission/file?from=${from}&to=${to}&county_code=${code.code}&county_name=${encodeURIComponent('Drill County')}&funds=${funds.join(',')}`);
      const imported = [];
      for (const [from, to] of [['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30'], ['2026-04-01', '2026-06-30']]) {
        const f = await file(from, to);
        await new Promise((res) => setTimeout(res, 20));
        const out = await adm.call('POST', '/api/county/submissions', { text: JSON.stringify(f, null, 2) });
        imported.push(`${from}..${to} ${out.status}`);
      }
      ctx.countyProgramme = prog.id;
      county += `; programme ${prog.id} registered with ${cur.key.fingerprint}; ${funds.length} settlement fund(s); signed files imported: ${imported.join(', ')}`;
      // A release with county-entered figures (1.20.0): a programme not on SUDS and a quarter the county entered.
      const other = await adm.call('POST', '/api/county/programmes', { name: 'Mailed Figures Cooperative', not_on_suds: true }, { raw: true });
      if (other.status === 201 && fs.readFileSync(path.join(FROM, 'server', 'routes', 'county.js'), 'utf8').includes('/entries')) {
        const ent = await adm.call('POST', `/api/county/programmes/${other.body.id}/entries`, { from: '2026-01-01', to: '2026-03-31', source_ref: 'Q1 report emailed 3 April 2026', funds: [FUND] });
        ctx.enteredProgramme = other.body.id;
        county += `; county-entered figures for programme ${other.body.id} (not on SUDS), 2026-01-01..2026-03-31: ${ent.submission && ent.submission.source}`;
      } else county += `; no county-entered figures in this release (programme not on SUDS: HTTP ${other.status})`;
    }
    ctx.county = county; ctx.extras = extras.join('; ');
    record(`${from}: through its API — note written, signed (password) and countersigned; TOTP enrolled for mrivera; passkey and sync device where the release has them; sessions kept`, performance.now() - t, oldVerify.signed && oldVerify.intact !== false,
      `note ${note.id} signature ${signed.signature_hash.slice(0, 12)}…, countersignature ${cos.cosignature_hash.slice(0, 12)}…; /verify ${JSON.stringify({ signed: oldVerify.signed, intact: oldVerify.intact, cosignature_intact: oldVerify.cosignature_intact })}; ${ctx.extras}; ${county}`);
  } catch (e) {
    record(`${from}: through its API`, 0, false, e.message); await srv.stop(); return finish(started, ctx);
  }
  await srv.stop();
  // ---- old 3: anchor and manifest ----
  r = child(FROM, 'manifest', envFor(dataDir, { DRILL_NOTE_ID: ctx.note.id }));
  const m = r.value;
  if (m) fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(m));
  record(`${from}: audit anchor sealed; manifest of the database before the upgrade`, r.ms, !!m && m.audit.ok && !!m.anchor,
    m ? `schema ${m.schema_version}; ${Object.keys(m.counts).length} tables; clients ${m.counts.clients}, notes ${m.counts.notes}, audit_log ${m.counts.audit_log}; ${Object.keys(m.samples).length} encrypted values sampled; audit chain ${JSON.stringify(m.audit)}; anchor ${m.anchor}` : r.stderr.slice(-500));
  if (!m) return finish(started, ctx);
  ctx.before = { version: m.version, schema_version: m.schema_version, tables: Object.keys(m.counts).length };
  await new Promise((res) => setTimeout(res, 1100));
  const upgradeAt = new Date().toISOString();

  // ---- new 4: the upgrade, at the new release's start, and its API ----
  const latest = child(TO, 'latest', envFor(scratch)).value;
  srv = await startServer(TO, dataDir);
  const upLog = srv.log();
  record(`${to}: its server starts on the ${from} data directory — migrations ${m.schema_version + 1}..${latest} run — and answers /api/health`, srv.ms, !!srv.health,
    srv.health ? `HTTP ${srv.health.status}; start to healthy ${(srv.ms / 1000).toFixed(1)} s${srv.health.body.warnings ? ` (warnings: ${srv.health.body.warnings.join(' ')})` : ''}` : upLog.slice(-1500));
  ctx.upgrade_to_healthy_seconds = Math.round(srv.ms / 100) / 10;
  if (!srv.health) { await srv.stop(); return finish(started, ctx); }
  try {
    const t = performance.now();
    const old = client(srv.base); old.cookie = ctx.oldSessionCookie;
    const me = await old.call('GET', '/api/auth/me', undefined, { raw: true });
    const nav = client(srv.base);
    const login = await nav.call('POST', '/api/auth/login', { username: 'mrivera', password: PW });
    const code = await freshCode(secret);
    const wrong = await nav.call('POST', '/api/auth/mfa/verify', { code: String((Number(code) + 1) % 1000000).padStart(6, '0') }, { raw: true });
    const mfa = await nav.call('POST', '/api/auth/mfa/verify', { code }, { raw: true });
    const v = await nav.call('GET', `/api/notes/${ctx.note.id}/verify`);
    const found = rows(await nav.call('GET', `/api/clients?q=${encodeURIComponent('Exercise7')}&limit=5`));
    const noCode = client(srv.base);
    await noCode.call('POST', '/api/auth/login', { username: 'mrivera', password: PW });
    const blocked = await noCode.call('GET', '/api/clients?limit=1', undefined, { raw: true });
    ctx.api_after = { old_session_me: me.status, login_mfa_pending: !!login.mfaPending, wrong_code: wrong.status, totp: mfa.status, verify: v, search_hits: found.length, read_without_second_factor: blocked.status };
    const ok = me.status === 200 && login.mfaPending && wrong.status >= 400 && mfa.status === 200 && v.signed && v.intact === true && v.cosignature_intact === true && blocked.status === 401 && (SCALE === 0 || found.length > 0);
    record(`${to}: through its API after the upgrade — the ${from} session, password + TOTP sign-in, the signed note verifies, a name search finds clients`, performance.now() - t, ok,
      `old session /api/auth/me HTTP ${me.status}; password -> second factor asked (${!!login.mfaPending}); wrong code HTTP ${wrong.status}; TOTP HTTP ${mfa.status}; read before the code HTTP ${blocked.status}; /api/notes/:id/verify ${JSON.stringify({ signed: v.signed, intact: v.intact, cosignature_intact: v.cosignature_intact })}; search "Exercise7" ${found.length} hit(s)`);
  } catch (e) { record(`${to}: through its API after the upgrade`, 0, false, e.message); }
  try {
    // The sessions the old release opened (browser, passkey, sync device) and migrations 62-63 through the API: the
    // passkey enrolled on the old release signs in again; the device signs in again and is told scope 'full'.
    const t = performance.now();
    const meWith = async (cookie) => { const c = client(srv.base); c.cookie = cookie; return (await c.call('GET', '/api/auth/me', undefined, { raw: true })).status; };
    const kept = { browser: await meWith(ctx.oldSessionCookie), device: await meWith(ctx.deviceSessionCookie) };
    if (ctx.passkeySessionCookie) kept.passkey = await meWith(ctx.passkeySessionCookie);
    let pk = null;
    if (ctx.authenticator) { const p2 = await passkeySignIn(srv.base, ctx.authenticator); pk = { status: p2.res.status, me: p2.res.status === 200 ? await meWith(p2.c.cookie) : null }; }
    const dev = client(srv.base, DEVICE);
    const dl = await dev.call('POST', '/api/auth/login', { username: 'jwalker', password: PW }, { raw: true });
    ctx.api_after_1_21 = { kept_sessions_me: kept, passkey_sign_in: pk, device_sign_in: dl.status, device_scope: dl.body && dl.body.device ? dl.body.device.scope : null };
    const ok = Object.values(kept).every((x) => x === 200) && (!ctx.authenticator || (pk.status === 200 && pk.me === 200)) && dl.status === 200 && ctx.api_after_1_21.device_scope === 'full';
    record(`${to}: the ${from} sessions (browser${ctx.passkeySessionCookie ? ', passkey' : ''}, sync device) still answer; ${ctx.authenticator ? `the passkey enrolled on ${from} signs in again; ` : ''}the device signs in again and is told scope 'full' (migration 62)`, performance.now() - t, ok,
      `/api/auth/me with each kept session ${JSON.stringify(kept)}; ${pk ? `passkey sign-in HTTP ${pk.status}, then /api/auth/me ${pk.me}; ` : 'no passkey on the older release; '}device sign-in HTTP ${dl.status}, device ${JSON.stringify(dl.body && dl.body.device)}`);
  } catch (e) { record(`${to}: the kept sessions, passkey and device after the upgrade`, 0, false, e.message); }
  if (ctx.countyProgramme) {
    // Migration 60 through the new release's API: the signed files are listed and counted as they were, and the
    // rebuilt table takes figures the county enters for a programme not on SUDS (1.20.0's feature).
    try {
      const t = performance.now();
      const adm = client(srv.base);
      await adm.call('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
      const subs = (await adm.call('GET', '/api/county/submissions')).rows.filter((x) => x.programme_id === ctx.countyProgramme);
      const progs = (await adm.call('GET', '/api/county/programmes')).rows;
      const mine = progs.find((p) => p.id === ctx.countyProgramme);
      const view = await adm.call('GET', '/api/county/view?from=2026-01-01&to=2026-06-30');
      const inView = (view.programmes || []).find((p) => p.id === ctx.countyProgramme);
      const other = await adm.call('POST', '/api/county/programmes', { name: 'Paper Reports Collective', not_on_suds: true });
      const fund = { name: 'County settlement share', grant_number: 'OSF-DRILL-1', category: 'core_h', hiaa: 'hiaa_4', spend_own_category: '1000.50', spend_other_categories: '0', spend_pending: '25',
        contacts: '120', naloxone_kits: '80', fentanyl_strips: '300', syringes: '900', reversals: '3', treatment_admissions: '2', education_contacts: '5', staff_training_hours: '12.5',
        referrals_made: '14', people_served: '70', people_linked: '6', moud_linked: '2', people_trained: '9' };
      const ent = await adm.call('POST', `/api/county/programmes/${other.id}/entries`, { from: '2026-01-01', to: '2026-03-31', source_ref: 'Q1 report emailed 3 April 2026', funds: [fund] }, { raw: true });
      ctx.county_api_after = { listed: subs.map((x) => ({ id: x.id, source: x.source, status: x.status })), on_suds: mine && mine.on_suds, in_view: inView ? inView.submissions.length : 0, entered: ent.status, entered_source: ent.body && ent.body.submission && ent.body.submission.source };
      // Figures the older release's county entered (1.20.0): still listed as county_entered, the programme not on SUDS.
      let oldEnteredOk = true;
      if (ctx.enteredProgramme) {
        const allSubs = (await adm.call('GET', '/api/county/submissions')).rows;
        const es = allSubs.filter((x) => x.programme_id === ctx.enteredProgramme);
        const ep = progs.find((p) => p.id === ctx.enteredProgramme);
        ctx.county_api_after.old_entered = { listed: es.map((x) => `${x.source}/${x.status}`), on_suds: ep && ep.on_suds };
        oldEnteredOk = es.length === 1 && es[0].source === 'county_entered' && ep && ep.on_suds === false;
      }
      // Migration 61 through the API: a screened county release over January-March 2026 (the files and figures the
      // older release kept, and the quarter entered just now), prepared, reviewed and published.
      const q = { from: '2026-01-01', to: '2026-03-31' };
      const prep = await adm.call('POST', '/api/county/publications/prepare', q, { raw: true });
      const pub = prep.status === 200 ? await adm.call('POST', '/api/county/publications', { ...q, sha256: prep.body.sha256, reviewed: true }, { raw: true }) : { status: null, body: null };
      const pubs = pub.status === 201 ? (await adm.call('GET', '/api/county/publications')).rows : [];
      ctx.county_api_after.publication = { prepare: prep.status, publish: pub.status, sha256: pub.body && pub.body.sha256, listed: pubs.length, detail: prep.status === 200 ? undefined : prep.body };
      ctx.publications = pubs.length;
      const ok = oldEnteredOk && prep.status === 200 && pub.status === 201 && pubs.length === 1 && subs.length === 3 && subs.every((x) => x.source === 'signed') && subs.filter((x) => x.status === 'superseded').length === 1 && mine && mine.on_suds === true && inView && inView.submissions.length === 2 && ent.status === 201 && ctx.county_api_after.entered_source === 'county_entered';
      record(`${to}: the county through its API — the ${from} signed county files listed as signed (one superseded)${ctx.enteredProgramme ? `, its county-entered quarter listed as county_entered` : ''}, counted in the combined view; new county-entered figures accepted; a screened county release published (migration 61)`, performance.now() - t, ok,
        `listed ${JSON.stringify(ctx.county_api_after.listed.map((x) => `${x.source}/${x.status}`))}; on_suds ${ctx.county_api_after.on_suds}; ${ctx.county_api_after.old_entered ? `${from}'s entered programme ${JSON.stringify(ctx.county_api_after.old_entered)}; ` : ''}combined view Jan-Jun counts ${ctx.county_api_after.in_view} file(s) for it; entered figures for a programme not on SUDS HTTP ${ent.status}${ent.status === 201 ? '' : ` ${JSON.stringify(ent.body)}`}, source ${ctx.county_api_after.entered_source}; publication Jan-Mar 2026: prepare HTTP ${prep.status}, publish HTTP ${pub.status}${pub.body && pub.body.sha256 ? ` (sha256 ${pub.body.sha256.slice(0, 12)}…)` : ''}, ${pubs.length} listed${prep.status === 200 ? '' : ` ${JSON.stringify(prep.body)}`}`);
    } catch (e) { record(`${to}: the county through its API`, 0, false, e.message); }
  }
  await srv.stop();

  // ---- new 5: structure and data ----
  r = child(TO, 'verify', envFor(dataDir, { DRILL_MANIFEST: path.join(work, 'manifest.json'), DRILL_UPGRADE_AT: upgradeAt }));
  const v = r.value;
  if (!v) { record(`${to}: structure and data after the upgrade`, r.ms, false, r.stderr.slice(-800)); return finish(started, ctx); }
  ctx.verify = v;
  record(`${to}: schema at this build's version, integrity_check, foreign keys`, r.ms, v.schema_version === v.latest && v.integrity === 'ok' && v.foreign_key_violations === 0, `schema ${v.schema_version} (latest ${v.latest}); integrity_check ${v.integrity}; foreign_key_check ${v.foreign_key_violations} violation(s)`);
  record(`${to}: upgraded schema identical to a fresh install (test/migrations.test.js comparison: columns, indexes, triggers of every table)`, 0, !v.shape_vs_schema_sql.length && !v.shape_vs_fresh_install.length,
    `${v.tables} tables; vs schema.sql: ${v.shape_vs_schema_sql.length ? v.shape_vs_schema_sql.join(', ') : 'identical'}; vs a database ${to} created itself: ${v.shape_vs_fresh_install.length ? v.shape_vs_fresh_install.join(', ') : 'identical'}`);
  record(`${to}: no rows lost — every ${from} table holds at least what it did`, 0, !v.lost.length, `${Object.keys(v.counts.before).length} tables compared; lost: ${v.lost.length ? v.lost.join(', ') : 'none'}; changed: ${v.changed.length ? v.changed.join(', ') : 'none'}; new tables: ${v.new_tables.join(', ') || 'none'}`);
  record(`${to}: every sampled encrypted value decrypts to the plaintext ${from} wrote`, 0, v.samples.same === v.samples.compared && v.samples.compared > 0, `${v.samples.same}/${v.samples.compared} values across ${v.samples.columns} *_enc columns${v.samples.differ.length ? `; differ: ${v.samples.differ.join(', ')}` : ''}`);
  record(`${to}: the signed and countersigned note's hashes are unchanged and verify`, 0, v.note.signature_hash_unchanged && v.note.signature_intact && v.note.cosignature_hash_unchanged && v.note.cosignature_intact, JSON.stringify(v.note));
  record(`${to}: users unchanged (role, active, TOTP enrolled)`, 0, v.users_unchanged && v.users.after.some((u) => u.username === 'mrivera' && u.mfa_enabled === 1), `${v.users.after.length} users; mrivera mfa_enabled=${(v.users.after.find((u) => u.username === 'mrivera') || {}).mfa_enabled}`);
  record(`${to}: the audit chain verifies end to end`, 0, v.audit.ok === true && v.audit.checked >= v.audit_before.checked, `${JSON.stringify(v.audit)} (before the upgrade: ${v.audit_before.checked} entries)`);
  const keptOk = Object.values(v.kept).every((k) => k.kept === k.before && !k.changed_or_lost.length);
  record(`${to}: every session, device and passkey ${from} wrote is kept with the same values (sessions: id, user, created, mfa_pending, reauth_method, passkey_id, sync_client, revoked)`, 0, keptOk && v.session_columns.length === 3,
    `${Object.entries(v.kept).map(([t, k]) => `${t} ${k.kept}/${k.before}${k.changed_or_lost.length ? ` (changed or lost: ${k.changed_or_lost.join(', ')})` : ''}`).join('; ')}; sessions opened before the upgrade: ${JSON.stringify(v.old_sessions)}; rows ${JSON.stringify(v.new_tables_rows)}${v.county_signing_keys.length ? `; county_signing_keys ${JSON.stringify(v.county_signing_keys)}` : ''}`);
  const x = v.m61_63;
  const devOk = x.devices.length > 0 && x.devices.every((d) => d.sync_scope === 'full' && d.scope_changed_at === null && d.field_applied_at === null);
  const pkOk = ctx.authenticator ? x.passkeys && x.passkeys.n >= 1 && x.passkeys.attested === 0 : x.passkeys && x.passkeys.n === 0;
  const m6163ok = x.tables.county_publications === (ctx.publications || 0) && x.tables.authenticator_metadata === 0 && devOk && x.clients.participant_code_set === 0 && x.participant_code_index && pkOk
    && x.old_sessions_device_id && x.old_sessions_device_id.n > 0 && x.old_sessions_device_id.with_device === 0;
  record(`${to}: migrations 61-63 — county_publications and authenticator_metadata exist; devices sync_scope 'full'; no client has a participant code; passkeys unattested; older sessions have no device_id`, 0, m6163ok,
    `tables ${JSON.stringify(x.tables)} (county_publications holds the ${ctx.publications || 0} release(s) published in step 4); devices written before the upgrade ${JSON.stringify(x.devices)}; clients ${JSON.stringify(x.clients)}, index idx_clients_participant_code ${x.participant_code_index}; passkeys written before ${JSON.stringify(x.passkeys)}; sessions opened before ${JSON.stringify(x.old_sessions_device_id)}`);
  if (v.county && v.county.before) {
    const b4 = v.county.before; const af = v.county.after;
    const pick = (x) => ({ id: x.id, programme_id: x.programme_id, key_id: x.key_id, period_from: x.period_from, period_to: x.period_to, sha256: x.sha256, signature: x.signature, superseded_by: x.superseded_by, withdrawn_at: x.withdrawn_at, payload_sha256: x.payload_sha256 });
    // Rows the new release added in step 4 (figures the county entered) are not the old release's.
    const oldAfter = af.submissions.filter((x) => b4.submissions.some((y) => y.id === x.id));
    const same = JSON.stringify(oldAfter.map(pick)) === JSON.stringify(b4.submissions.map(pick));
    // Rows written before migration 60 become 'signed'; rows that already had a source (1.20.0 on) keep theirs.
    const signed = oldAfter.every((x) => { const y = b4.submissions.find((z) => z.id === x.id); return y.source === undefined ? x.source === 'signed' && x.entered_via === null && x.source_ref_enc === null : x.source === y.source && x.entered_via === y.entered_via && x.source_ref_enc === y.source_ref_enc; });
    const progOk = b4.programmes.every((p) => (af.programmes.find((q) => q.id === p.id) || {}).on_suds === (p.on_suds === undefined ? 1 : p.on_suds));
    record(`${to}: county_submissions keeps its ${b4.submissions.length} ${from} row(s) unchanged (signed${b4.submissions.some((y) => y.source === 'county_entered') ? ' and county-entered' : ''}); every programme keeps on_suds; key_id and signature nullable`, 0,
      b4.submissions.length > 0 && same && signed && progOk && af.submissions_not_null.key_id === 0 && af.submissions_not_null.signature === 0,
      `${oldAfter.length}/${b4.submissions.length} rows kept (id, key, signature, hash, superseded_by, decrypted payload identical: ${same}); source ${oldAfter.map((x) => x.source).join(',')}; superseded ${oldAfter.filter((x) => x.superseded_by).length}; programmes ${JSON.stringify(af.programmes.map((p) => ({ name: p.name, on_suds: p.on_suds })))}; NOT NULL before ${JSON.stringify(b4.submissions_not_null)}, after ${JSON.stringify(af.submissions_not_null)}`);
  }
  record(`${to}: the database was snapshotted before the migrations and the snapshot sealed`, 0, v.pre_migration.files.length === 1 && /\.enc$/.test(v.pre_migration.files[0]) && v.pre_migration.schema_version === m.schema_version,
    `${v.pre_migration.files.join(', ')}: opens with the backup key, schema ${v.pre_migration.schema_version}, ${v.pre_migration.clients} clients`);

  // ---- new 6: backup after the upgrade, recovery drill, host restore ----
  r = child(TO, 'backup', envFor(dataDir));
  const b = r.value || {};
  record(`${to}: encrypted backup of the upgraded database (scheduled-backup path, read back and verified)`, r.ms, !!(b.file && b.verified), b.file ? `${path.basename(b.file)}, ${(b.bytes / 1024).toFixed(0)} KB, ${b.method}, verified=${b.verified}` : b.error || r.stderr.slice(-500));
  if (!b.file || !b.verified) return finish(started, ctx);
  r = run(TO, ['scripts/dr-drill.js', '--backup', b.file, '--keys-file', keysFile, '--json'], envFor(dataDir));
  let doc = null; try { doc = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch {}
  const rep = doc && doc.report;
  record(`${to}: recovery drill on that backup with the escrowed key file (npm run dr-drill -- --backup <file> --keys-file <keys.json>)`, r.ms, r.status === 0 && rep && rep.ok,
    rep ? `${rep.checks.filter((c) => c.ok).length}/${rep.checks.length} checks passed; RTO ${rep.rto.seconds} s; RPO ${rep.rpo.seconds} s; audit entries verified ${rep.audit.entries_verified}${rep.checks.filter((c) => !c.ok).map((c) => `; FAILED ${c.name}: ${c.detail || ''}`).join('')}` : (r.stderr || r.stdout).slice(-800));
  ctx.doc = doc;
  const reportFiles = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => /^dr-drill-.*\.(json|txt)$/.test(f)).sort();
  ctx.reportFiles = reportFiles; ctx.reportJson = reportFiles.filter((f) => f.endsWith('.json')).pop();
  const tRestore = performance.now();
  r = run(TO, ['scripts/backup.js', '--restore', b.file, path.join(freshDir, 'suds.db')], envFor(scratch));
  record(`${to}: host restore of that backup into a fresh data directory (node scripts/backup.js --restore)`, r.ms, r.status === 0, (r.stdout.trim().split('\n')[0] || r.stderr.slice(-300)).replace(work, '<work>'));
  if (r.status !== 0) return finish(started, ctx);
  srv = await startServer(TO, freshDir);
  ctx.hostRtoMs = performance.now() - tRestore;
  record(`${to}: the restored copy serves (server/index.js on the fresh data directory, /api/health)`, srv.ms, !!srv.health, srv.health ? `HTTP ${srv.health.status}; restore start to healthy ${(ctx.hostRtoMs / 1000).toFixed(1)} s` : srv.log().slice(-800));
  if (srv.health) {
    const nav = client(srv.base);
    await nav.call('POST', '/api/auth/login', { username: 'mrivera', password: PW });
    const mfa = await nav.call('POST', '/api/auth/mfa/verify', { code: await freshCode(secret) }, { raw: true });
    const vv = mfa.status === 200 ? await nav.call('GET', `/api/notes/${ctx.note.id}/verify`) : {};
    record(`${to}: in the restored copy, mrivera signs in with password + TOTP and the note still verifies`, 0, mfa.status === 200 && vv.intact === true && vv.cosignature_intact === true, `TOTP HTTP ${mfa.status}; /verify ${JSON.stringify({ signed: vv.signed, intact: vv.intact, cosignature_intact: vv.cosignature_intact })}`);
  }
  await srv.stop();
  r = child(TO, 'restored', envFor(freshDir));
  const rv = r.value || {};
  const own = new Set(['audit_log', 'settings', 'sessions', 'idempotency_keys', 'used_totp', 'login_attempts']);
  const src = b.counts || {}; const got = rv.counts || {};
  const mismatched = Object.keys(src).filter((t) => (own.has(t) ? (got[t] ?? 0) < src[t] : got[t] !== src[t]));
  record(`${to}: row counts in the fresh data directory equal the upgraded source at backup time; audit chain verifies`, r.ms, !!rv.counts && !mismatched.length && rv.audit && rv.audit.ok,
    `${Object.keys(src).length} tables; ${mismatched.length ? `mismatched: ${mismatched.map((t) => `${t} ${src[t]} -> ${got[t]}`).join(', ')}` : `clients ${got.clients}, interventions ${got.interventions}, notes ${got.notes}, audit_log ${src.audit_log} -> ${got.audit_log}`}; schema ${rv.schema_version}; audit ${JSON.stringify(rv.audit)}`);
  const pub = child(TO, 'pubkey', envFor(dataDir)).value;
  ctx.pemFile = path.join(work, 'suds-signing-key.pem'); if (pub) fs.writeFileSync(ctx.pemFile, pub.public_key_pem);
  r = ctx.reportJson ? run(TO, ['scripts/verify-dr-report.js', path.join(dataDir, 'backups', ctx.reportJson), '--public-key', ctx.pemFile], baseEnv) : { ms: 0, status: 1, stdout: 'no report' };
  record(`${to}: the signed drill report verifies with the public key only (npm run verify-dr-report)`, r.ms, r.status === 0, r.stdout.trim().split('\n').slice(-2).map((l) => l.trim()).join('; '));
  return finish(started, ctx);
}

function finish(started, ctx) {
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  const rep = ctx.doc && ctx.doc.report;
  const summary = {
    kind: 'suds-upgrade-drill', ok, environment: 'development exercise on a throwaway seeded database (fictional data); not a production upgrade',
    from: { version: ver(FROM), schema_version: ctx.before && ctx.before.schema_version, tables: ctx.before && ctx.before.tables },
    to: { version: ver(TO), schema_version: ctx.verify && ctx.verify.schema_version, tables: ctx.verify && ctx.verify.tables },
    started_at: started.toISOString(), finished_at: new Date().toISOString(),
    host: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, memory_gb: Math.round(os.totalmem() / 2 ** 30) },
    clients_added: SCALE, steps,
    upgrade_start_to_healthy_seconds: ctx.upgrade_to_healthy_seconds ?? null,
    api_after_upgrade: ctx.api_after || null,
    sessions_passkey_device_after_upgrade: ctx.api_after_1_21 || null,
    before_upgrade: ctx.extras || null,
    county: ctx.county || null,
    county_after_upgrade: ctx.county_api_after || null,
    drill: rep ? { ok: rep.ok, rto_seconds: rep.rto.seconds, rpo_seconds: rep.rpo.seconds, checks_passed: rep.checks.filter((c) => c.ok).length, checks_total: rep.checks.length, audit_entries_verified: rep.audit.entries_verified, report_sha256: ctx.doc.integrity.sha256, signing_key_id: ctx.doc.integrity.signing_key_id } : null,
    host_restore_to_health_seconds: ctx.hostRtoMs ? Math.round(ctx.hostRtoMs / 100) / 10 : null,
    report_file: ctx.reportJson || null,
  };
  const txt = (ctx.reportFiles || []).filter((f) => f.endsWith('.txt')).pop();
  if (txt) { console.log('\n===== signed drill report on the upgraded database (text) ====='); process.stdout.write(fs.readFileSync(path.join(dataDir, 'backups', txt), 'utf8')); }
  console.log('\n===== upgrade drill summary =====');
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of ctx.reportFiles || []) fs.copyFileSync(path.join(dataDir, 'backups', f), path.join(OUT, f));
    if (ctx.pemFile && fs.existsSync(ctx.pemFile)) fs.copyFileSync(ctx.pemFile, path.join(OUT, 'suds-signing-key.pem'));
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`[upgrade-drill] evidence written to ${OUT}`);
  }
  // The work directory holds the throwaway keys and fictional data only.
  if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true }); else console.log(`[upgrade-drill] kept ${work}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('[upgrade-drill]', e && e.stack || e); try { finish(new Date(), {}); } catch {} process.exitCode = 1; });

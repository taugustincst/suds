'use strict';
// Upgrade drill: a database written by an older released SUDS, opened by a newer one, then backed up, restored and
// drilled with the newer one. Evidence tooling for docs/evidence/upgrade-drill-2026-10-01-v1.23.0/ (README.md there);
// not part of the product, and it never touches a real data directory: everything lives under a new temporary
// directory, with keys generated for the run and deleted with it. It is docs/evidence/upgrade-drill-2026-10-01-v1.21.0/'s
// driver with what migrations 64 to 67 (1.22.0 and 1.23.0) touch added, written by the older release (1.21.0 or 1.22.0)
// through its own API before the upgrade: a field device (an administrator narrows a peer navigator's synced phone to
// the field scope); the authenticator allow-list turned on over a metadata file signed under the repository's
// TEST-ONLY root (test/fixtures/fido-mds; trusted by a development server only), with a passkey enrolled before it
// (refused at once by 1.21.0, given a grace period by 1.22.0) and an attested passkey of the listed model enrolled
// under it and signed in with; a call and a visit with follow-up dates (their to-dos); a supervisor's "Finish and sign
// your note" reminder on a draft note; and, on 1.22.0, each programme's written consent to publication; then a
// screened county release of January-March 2026 published. After it, the newer release is checked to keep every one
// of those rows; the field device signs in again and is told 'field', and the account's next new device too
// (migration 64's field_accounts); both passkeys behave as their release left them; editing the call's and the visit's
// follow-up dates moves the to-dos the older release made (matched once by title and date, then linked: migration
// 67) with no second to-do; signing the draft closes the reminder; the release published on the older release is
// withdrawn and a corrected release of its period is refused (1.21.0: it kept no inputs) or published (1.22.0: it
// did; migration 65); and a release of April-June is published.
//
//   git archive 348e18c | tar -x -C /tmp/suds-1.21.0        (and 9877d07, the v1.23.0 commit, into /tmp/suds-1.23.0)
//   node docs/evidence/upgrade-drill-2026-10-01-v1.23.0/upgrade-drill.js --from /tmp/suds-1.21.0 --to /tmp/suds-1.23.0 \
//        [--clients 2000] [--out <dir>]
//
// Each step runs the named release's own code in its own process (cwd = that release's tree):
//   old  1  npm run seed (its sample data), then N fictional clients x 8 visits, each creation audited
//   old  2  its server (server/index.js) on that data directory, driven through its API: a navigator writes a note
//           and signs it (password), a supervisor countersigns it; the allow-list as above (where the release has
//           it); the navigator enrols a passkey and signs in with it, then TOTP; a sync device (supervisor) and a
//           field device (peer navigator) sign in; a call and a visit with follow-up dates; a second note left as a
//           draft and the supervisor's reminder to sign it; the county files, the entered figures, the consents
//           (1.22.0) and a published release; every signed-in session is kept
//   old  3  an audit anchor sealed outside the database; the manifest: row counts of every table, a SHA-256 of the
//           plaintext of up to 25 rows of every *_enc column, the note's hashes, verifyChain(), the county rows,
//           and the rows of sessions, devices, passkeys, tasks and the county publication tables (the columns an
//           upgrade must not change)
//   new  4  its server started on the same data directory: the upgrade (migrations) runs at start; then through
//           its API: the kept sessions, password + TOTP, the note verifies, a name search; the passkeys and devices
//           sign in again; the follow-up dates edited and the draft signed; the county, its consents and releases
//   new  5  structure and data: schema_version, integrity_check, foreign_key_check, schema shape equal to a fresh
//           install, every table's rows, every sampled value decrypts to the same plaintext, the note's hashes, the
//           audit chain, the kept rows, migrations 64-67's tables and defaults, the county rows, the pre-migration
//           snapshot
//   new  6  after the upgrade: an encrypted backup, the recovery drill with the escrowed key file, the host restore
//           into a fresh data directory served by server/index.js, row counts and the audit chain there, and the
//           signed report verified with the public key only
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
  // Tasks by what moving a due date or closing a reminder leaves alone; the county publication tables are append-only
  // apart from a consent's withdrawal, which this drill does not do.
  const KEEP = { sessions: ['id', 'user_id', 'created_at', 'mfa_pending', 'reauth_method', 'passkey_id', 'sync_client', 'device_id', 'revoked_at'],
    devices: ['id', 'user_id', 'label', 'first_seen_at', 'revoked_at', 'wipe_requested_at', 'sync_scope', 'scope_changed_at', 'scope_set_by'],
    passkeys: ['id', 'user_id', 'credential_id', 'public_key', 'name', 'created_at', 'attestation', 'allowlist_grace_until'],
    tasks: ['id', 'client_id', 'assigned_to', 'created_by', 'title_enc', 'description_enc', 'created_at', 'referral_id'],
    county_publications: ['id', 'kind', 'period_from', 'period_to', 'threshold', 'sha256', 'content', 'release_id', 'created_at', 'created_by'],
    county_publication_consents: ['id', 'programme_id', 'agreed_on', 'reference_enc', 'recorded_at', 'recorded_by', 'withdrawn_at'],
    county_publication_inputs: ['id', 'inputs_enc', 'created_at'] };
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
      // Migrations 64-67 (1.22.0 and 1.23.0): the new tables, and the defaults the new columns take on rows written before them.
      const has = (t) => !!db.one(`SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?`, t);
      const colsOf = (t) => db.all(`PRAGMA table_info("${t}")`).map((c) => c.name);
      const at = process.env.DRILL_UPGRADE_AT;
      const fu = JSON.parse(process.env.DRILL_FOLLOWUPS || '{}');
      const task = (id) => (id ? { ...(db.one(`SELECT id, due_at, status, call_id, intervention_id, completed_at FROM tasks WHERE id=?`, id) || { missing: id }) } : null);
      r.m64_67 = {
        tables: Object.fromEntries(['field_accounts', 'county_publication_consents', 'county_publication_inputs'].map((t) => [t, has(t) ? now[t] : null])),
        field_accounts: has('field_accounts') ? db.all(`SELECT f.user_id, u.username, f.bound_via, f.bound_at < ? before_upgrade FROM field_accounts f JOIN users u ON u.id=f.user_id ORDER BY u.username`, at).map((x) => ({ ...x })) : null,
        devices: db.all(`SELECT d.id, u.username, d.sync_scope, d.scope_set_by, d.first_seen_at < ? before_upgrade FROM devices d JOIN users u ON u.id=d.user_id ORDER BY d.first_seen_at, d.id`, at).map((x) => ({ ...x })),
        passkeys: colsOf('passkeys').includes('allowlist_grace_until') ? db.all(`SELECT p.id, u.username, p.attestation IS NOT NULL attested, p.allowlist_grace_until, p.created_at < ? before_upgrade FROM passkeys p JOIN users u ON u.id=p.user_id ORDER BY p.created_at`, at).map((x) => ({ ...x })) : null,
        allowlist: { enabled: db.getSetting('authn_allowlist', '0'), models: db.getSetting('authn_allowlist_models', '[]'), metadata_entries: has('authenticator_metadata') ? now.authenticator_metadata : null },
        tasks: { linked_call: colsOf('tasks').includes('call_id') ? db.one(`SELECT COUNT(*) n FROM tasks WHERE call_id IS NOT NULL`).n : null, linked_visit: colsOf('tasks').includes('intervention_id') ? db.one(`SELECT COUNT(*) n FROM tasks WHERE intervention_id IS NOT NULL`).n : null,
          of_call: fu.call_id ? db.one(`SELECT COUNT(*) n FROM tasks WHERE call_id=?`, fu.call_id).n : null, of_visit: fu.visit_id ? db.one(`SELECT COUNT(*) n FROM tasks WHERE intervention_id=?`, fu.visit_id).n : null,
          call_task: task(fu.call_task), visit_task: task(fu.visit_task), reminder: task(fu.reminder_task),
          index_call: !!db.one(`SELECT 1 x FROM sqlite_master WHERE type='index' AND name='idx_tasks_call'`), index_visit: !!db.one(`SELECT 1 x FROM sqlite_master WHERE type='index' AND name='idx_tasks_intervention'`) },
        publications: has('county_publications') ? db.all(`SELECT id, kind, period_from, period_to, release_id IS NOT NULL withdrawal, created_at < ? before_upgrade, (SELECT COUNT(*) FROM county_publication_inputs i WHERE i.id=p.id) inputs FROM county_publications p ORDER BY created_at`, at).map((x) => ({ ...x })) : null,
        consents: has('county_publication_consents') ? db.all(`SELECT programme_id, agreed_on, withdrawn_at, recorded_at < ? before_upgrade FROM county_publication_consents ORDER BY recorded_at`, at).map((x) => ({ ...x })) : null,
      };
      r.new_tables_rows = Object.fromEntries(['passkeys', 'webauthn_challenges', 'signature_evidence', 'authenticator_metadata', 'county_programmes', 'county_submissions', 'county_publications', 'county_publication_consents', 'county_publication_inputs', 'field_accounts', 'devices', 'tasks'].map((t) => [t, now[t]]));
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
// The metadata files the allow-list loads are signed under the repository's TEST-ONLY root, which SUDS trusts only with
// SUDS_ENV development or test (server/authenticator-allowlist.js trustRoots); never in production.
const REPO = path.join(__dirname, '..', '..', '..');
const MDS_ROOT = path.join(REPO, 'test', 'fixtures', 'fido-mds', 'TEST-ONLY-mds-root.pem');
const baseEnv = { ...process.env, SUDS_ENV: 'development', ...keys, AUDIT_ANCHOR_DIR: anchors, LOG_FORMAT: 'text', MFA_REQUIRED_ROLES: '', SUDS_ADMIN_USERNAME: 'admin', SUDS_ADMIN_PASSWORD: ADMIN_PW, DRILL_WORK: work, SUDS_TEST_FIDO_MDS_ROOT: MDS_ROOT };
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
const FIELD_DEVICE = { 'X-Sync-Client': '1', 'X-Device-Id': 'upgrade-drill-field-1' };
const FIELD_DEVICE_2 = { 'X-Sync-Client': '1', 'X-Device-Id': 'upgrade-drill-field-2' };
async function passkeySignIn(base, a, username = 'mrivera') {
  a.origin = base;
  const c = client(base);
  const o = await c.call('POST', '/api/auth/passkeys/login/options', { username });
  const res = await c.call('POST', '/api/auth/passkeys/login', { credential: a.get(o.publicKey) }, { raw: true });
  return { c, res };
}
// The authenticator allow-list (1.21.0 on): a model, its maker's root in a metadata file signed under the TEST-ONLY
// root, and a packed full attestation by a batch certificate of that maker (as test/attestation.test.js makes them).
const X = require(path.join(REPO, 'test', 'x509.js'));
const MODEL = 'd1a11d1a-0000-4000-8000-0000000c0123';
const aaguidBuf = (s) => Buffer.from(s.replace(/-/g, ''), 'hex');
const maker = X.ca('Upgrade drill authenticator maker');
function metadataBlob() {
  const root = { der: new crypto.X509Certificate(fs.readFileSync(MDS_ROOT, 'utf8')).raw, keys: { privateKey: crypto.createPrivateKey(fs.readFileSync(MDS_ROOT.replace(/\.pem$/, '.key.pem'), 'utf8')) }, subject: [['C', 'US'], ['O', 'SUDS tests'], ['CN', 'SUDS TEST-ONLY FIDO MDS root']] };
  return X.mdsBlob({ payload: { no: 4000, nextUpdate: '2099-12-31', legalHeader: 'test', entries: [X.mdsEntry({ aaguid: MODEL, description: 'Upgrade drill key', roots: [maker.der] })] }, ...X.mdsSigner(root) });
}
const packedFull = () => (authData, cdh, a) => {
  const k = X.ecKeys();
  const der = X.cert({ subject: [['C', 'US'], ['O', 'Upgrade drill maker'], ['OU', 'Authenticator Attestation'], ['CN', 'Upgrade drill batch']], issuer: maker.subject, publicKey: k.publicKey, signKey: maker.keys.privateKey,
    extensions: [X.EXT.basicConstraints(false), X.EXT.aaguid(a.aaguid)] });
  return { fmt: 'packed', attStmt: new Map([['alg', -7], ['sig', crypto.sign('sha256', Buffer.concat([authData, cdh]), { key: k.privateKey, dsaEncoding: 'der' })], ['x5c', [der]]]) };
};
const FOLLOW = { call: '2026-10-20', call_moved: '2026-10-27', visit: '2026-10-21', visit_moved: '2026-10-28' };
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
    const adm0 = client(srv.base);
    await adm0.call('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
    const hasAllowlist = fs.existsSync(path.join(FROM, 'server', 'authenticator-allowlist.js'));
    ctx.hasGrace = hasAllowlist && fs.readFileSync(path.join(FROM, 'server', 'authenticator-allowlist.js'), 'utf8').includes('function applyGrace');
    if (hasAllowlist) {
      // The authenticator allow-list (1.21.0 on): the metadata file loaded (the password again), a clinician's passkey
      // enrolled while the list is off (unattested), then the list turned on for one model, confirming who it affects.
      const meta = await adm0.call('POST', '/api/admin/authenticator-metadata', { blob: metadataBlob(), password: ADMIN_PW });
      const early = new SoftAuthenticator({ origin: srv.base });
      const kp = client(srv.base);
      await kp.call('POST', '/api/auth/login', { username: 'kpatel', password: PW });
      const ko = await kp.call('POST', '/api/auth/passkeys/register/options', { password: PW });
      await kp.call('POST', '/api/auth/passkeys/register', { credential: early.create(ko.publicKey), name: 'Clinician phone (before the list)' });
      const models = [{ name: 'Upgrade drill key', aaguid: MODEL }];
      const pv = await adm0.call('POST', '/api/admin/authenticator-allowlist/preview', { enabled: true, models });
      const on = await adm0.call('PUT', '/api/admin/authenticator-allowlist', { enabled: true, models, password: ADMIN_PW, acknowledge_affected: pv.affected.passkey_count });
      const early2 = await passkeySignIn(srv.base, early, 'kpatel');
      ctx.earlyAuthenticator = early; ctx.earlyOnOld = early2.res.status;
      extras.push(`allow-list: metadata file no. ${meta.metadata.no} loaded (${meta.metadata.entries} model, test root ${meta.metadata.test_root}); kpatel's unattested passkey enrolled before it; list turned on for ${MODEL} (${pv.affected.passkey_count} passkey affected, enabled ${on.enabled}${ctx.hasGrace ? `, grace ${on.grace_days ?? '?'} days` : ''}); kpatel's passkey then signs in: HTTP ${early2.res.status}`);
    } else extras.push('no authenticator allow-list in this release');
    if (fs.existsSync(path.join(FROM, 'server', 'routes', 'passkeys.js'))) {
      // A passkey for the navigator (before TOTP, so the password alone opens enrolment), and a sign-in with it; under
      // the allow-list, of the listed model with a packed full attestation.
      const a = new SoftAuthenticator({ origin: srv.base, ...(hasAllowlist ? { aaguid: aaguidBuf(MODEL) } : {}) });
      const o = await nav.call('POST', '/api/auth/passkeys/register/options', { password: PW });
      const reg = await nav.call('POST', '/api/auth/passkeys/register', { credential: a.create(o.publicKey, hasAllowlist ? { attest: packedFull() } : {}), name: 'Drill phone' });
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
    // A field device (1.21.0 on): the peer navigator's phone, narrowed to the field scope by an administrator.
    const fdev = client(srv.base, FIELD_DEVICE);
    const fl = await fdev.call('POST', '/api/auth/login', { username: 'dchen', password: PW });
    ctx.fieldSessionCookie = fdev.cookie;
    const sc = await adm0.call('POST', `/api/admin/devices/${FIELD_DEVICE['X-Device-Id']}/scope`, { scope: 'field' });
    const fl2 = await client(srv.base, FIELD_DEVICE).call('POST', '/api/auth/login', { username: 'dchen', password: PW });
    extras.push(`field device ${FIELD_DEVICE['X-Device-Id']} signed in as dchen (scope ${fl.device && fl.device.scope}), narrowed by the administrator (changed ${sc.changed}), signs in again told ${fl2.device && fl2.device.scope}`);
    // Follow-up dates (their to-dos, as this release makes them) on a call and a visit.
    const me = await nav.call('GET', '/api/auth/me');
    ctx.mriveraId = (me.user || me).id;
    const call = await nav.call('POST', '/api/calls', { client_id: cl.id, direction: 'outbound', started_at: new Date().toISOString(), purpose: 'MAT intake', follow_up_needed: true, follow_up_due: FOLLOW.call });
    const visit = await nav.call('POST', '/api/interventions', { client_id: cl.id, type: 'case_management', occurred_at: new Date().toISOString(), follow_up_due: FOLLOW.visit });
    const open = rows(await nav.call('GET', '/api/tasks?status=open&limit=1000'));
    const callTask = open.find((t) => t.client_id === cl.id && /^Call back: MAT intake$/.test(t.title) && String(t.due_at).slice(0, 10) === FOLLOW.call);
    const visitTask = open.find((t) => t.client_id === cl.id && /^Follow up: /.test(t.title) && String(t.due_at).slice(0, 10) === FOLLOW.visit);
    ctx.followups = { call_id: call.id, visit_id: visit.id, call_task: callTask && callTask.id, visit_task: visitTask && visitTask.id, call_title: callTask && callTask.title, visit_title: visitTask && visitTask.title };
    if (!callTask || !visitTask) throw new Error(`follow-up to-dos on ${from}: call ${!!callTask}, visit ${!!visitTask}`);
    extras.push(`call ${call.id.slice(0, 8)}… with a follow-up on ${FOLLOW.call} made to-do "${callTask.title}"; visit ${visit.id.slice(0, 8)}… with one on ${FOLLOW.visit} made "${visitTask.title}"`);
    // A draft note and the supervisor's "Finish and sign your note" reminder (public/views/supervision.js's to-do).
    const draft = await nav.call('POST', '/api/notes', { client_id: cl.id, kind: 'admin', title: 'Upgrade drill draft', content: `Drafted on ${from}; signed on ${to}.`, occurred_at: new Date().toISOString() });
    const reminder = await sup.call('POST', '/api/tasks', { client_id: cl.id, assigned_to: ctx.mriveraId, title: 'Finish and sign your administrative note', description: `Jordan Walker asked you to finish and sign this draft note. Open it from the client's Notes tab.\nReference: supervision reminder for note ${draft.id}`, due_at: new Date().toISOString().slice(0, 10), priority: 'normal' });
    ctx.followups.reminder_task = reminder.id; ctx.draftNote = draft.id;
    extras.push(`draft note ${draft.id.slice(0, 8)}… and jwalker's reminder to-do ${reminder.id.slice(0, 8)}… for mrivera to sign it`);
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
      // Each programme's written consent to publication (1.22.0), then a screened release of January-March 2026.
      if (fs.readFileSync(path.join(FROM, 'server', 'routes', 'county.js'), 'utf8').includes('/publication-consent')) {
        const progs = (await adm.call('GET', '/api/county/programmes')).rows;
        for (const p of progs) await adm.call('POST', `/api/county/programmes/${p.id}/publication-consent`, { agreed_on: '2026-04-01', reference: `Signed agreement ${p.name}, 1 April 2026` });
        ctx.oldConsents = progs.length;
        county += `; publication consent recorded for ${progs.length} programme(s)`;
      }
      if (fs.existsSync(path.join(FROM, 'server', 'county-publication.js'))) {
        const q = { from: '2026-01-01', to: '2026-03-31' };
        const prep = await adm.call('POST', '/api/county/publications/prepare', q);
        const pub = await adm.call('POST', '/api/county/publications', { ...q, sha256: prep.sha256, reviewed: true });
        ctx.oldRelease = pub.id;
        county += `; county release of 2026-01-01..2026-03-31 published (${pub.id.slice(0, 8)}…, sha256 ${pub.sha256.slice(0, 12)}…)`;
      }
    }
    ctx.county = county; ctx.extras = extras.join('; ');
    record(`${from}: through its API — note written, signed (password) and countersigned; the allow-list on, a passkey before it and an attested one under it; TOTP enrolled for mrivera; a sync device and a field device; a call and a visit with follow-up dates; a draft note and its reminder; county files, consents where the release has them and a release; sessions kept`, performance.now() - t, oldVerify.signed && oldVerify.intact !== false,
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
    // The sessions the old release opened (browser, passkey, sync device, field device); the passkeys and the devices
    // signing in again (migrations 64 and 66).
    const t = performance.now();
    const meWith = async (cookie) => { const c = client(srv.base); c.cookie = cookie; return (await c.call('GET', '/api/auth/me', undefined, { raw: true })).status; };
    const kept = { browser: await meWith(ctx.oldSessionCookie), device: await meWith(ctx.deviceSessionCookie) };
    // A field device's sync session reaches only the sync routes (1.21.0 on): /api/auth/me answers 403 fieldDevice for
    // it, which is the session recognised (an ended one would be 401).
    const fc = client(srv.base); fc.cookie = ctx.fieldSessionCookie;
    const fme = await fc.call('GET', '/api/auth/me', undefined, { raw: true });
    const fieldKept = { status: fme.status, fieldDevice: !!(fme.body && fme.body.fieldDevice) };
    if (ctx.passkeySessionCookie) kept.passkey = await meWith(ctx.passkeySessionCookie);
    let pk = null;
    if (ctx.authenticator) { const p2 = await passkeySignIn(srv.base, ctx.authenticator); pk = { status: p2.res.status, me: p2.res.status === 200 ? await meWith(p2.c.cookie) : null }; }
    // The passkey enrolled before the list: 1.21.0 refused it at once and so does this release; 1.22.0 gave it a grace
    // period, which this release honours.
    let early = null;
    if (ctx.earlyAuthenticator) { const p3 = await passkeySignIn(srv.base, ctx.earlyAuthenticator, 'kpatel'); early = { status: p3.res.status, reason: p3.res.body && p3.res.body.passkeyError, on_old: ctx.earlyOnOld }; }
    const dl = await client(srv.base, DEVICE).call('POST', '/api/auth/login', { username: 'jwalker', password: PW }, { raw: true });
    const fl = await client(srv.base, FIELD_DEVICE).call('POST', '/api/auth/login', { username: 'dchen', password: PW }, { raw: true });
    const fl2 = await client(srv.base, FIELD_DEVICE_2).call('POST', '/api/auth/login', { username: 'dchen', password: PW }, { raw: true });
    const scope = (x) => (x.body && x.body.device ? x.body.device.scope : null);
    ctx.api_after_1_23 = { kept_sessions_me: kept, field_device_session: fieldKept, passkey_sign_in: pk, early_passkey: early, device: { status: dl.status, scope: scope(dl) }, field_device: { status: fl.status, scope: scope(fl) }, field_account_new_device: { status: fl2.status, scope: scope(fl2) } };
    const earlyOk = !early || (ctx.hasGrace ? early.status === 200 && early.on_old === 200 : early.status === 403 && early.reason === 'not_allowed' && early.on_old === 403);
    const ok = Object.values(kept).every((x) => x === 200) && fieldKept.status === 403 && fieldKept.fieldDevice && (!ctx.authenticator || (pk.status === 200 && pk.me === 200)) && earlyOk
      && dl.status === 200 && scope(dl) === 'full' && fl.status === 200 && scope(fl) === 'field' && fl2.status === 200 && scope(fl2) === 'field';
    record(`${to}: the ${from} sessions (browser, passkey, sync device) still answer and the field device's is still held to syncing; the attested passkey signs in again${early ? `, the one enrolled before the allow-list is ${ctx.hasGrace ? 'still in its grace period (signs in)' : 'still refused'}` : ''}; the full device is told 'full', the field device 'field', and the field account's next new device 'field' (migration 64)`, performance.now() - t, ok,
      `/api/auth/me with each kept session ${JSON.stringify(kept)}, with the field device's ${JSON.stringify(fieldKept)} (it can only sync); ${pk ? `attested passkey sign-in HTTP ${pk.status}, then /api/auth/me ${pk.me}; ` : ''}${early ? `kpatel's passkey from before the list: on ${from} HTTP ${early.on_old}, now HTTP ${early.status}${early.reason ? ` (${early.reason})` : ''}; ` : ''}jwalker's device HTTP ${dl.status} scope ${scope(dl)}; dchen's field device HTTP ${fl.status} scope ${scope(fl)}; dchen on a device never seen HTTP ${fl2.status} scope ${scope(fl2)}`);
  } catch (e) { record(`${to}: the kept sessions, passkeys and devices after the upgrade`, 0, false, e.message); }
  try {
    // Migration 67 through the API: the follow-up dates the older release's to-dos were made from, changed; the to-dos
    // move (found by title and date, then linked), no second one is made; signing the draft closes the reminder.
    const t = performance.now();
    const nav = client(srv.base);
    await nav.call('POST', '/api/auth/login', { username: 'mrivera', password: PW });
    await nav.call('POST', '/api/auth/mfa/verify', { code: await freshCode(secret) });
    const f = ctx.followups;
    const c1 = await nav.call('PUT', `/api/calls/${f.call_id}`, { follow_up_due: FOLLOW.call_moved }, { raw: true });
    const v1 = await nav.call('PUT', `/api/interventions/${f.visit_id}`, { follow_up_due: FOLLOW.visit_moved }, { raw: true });
    const open = rows(await nav.call('GET', '/api/tasks?status=open&limit=1000'));
    const ct = open.find((x) => x.id === f.call_task); const vt = open.find((x) => x.id === f.visit_task);
    const dupCall = open.filter((x) => x.title === f.call_title).length; const dupVisit = open.filter((x) => x.title === f.visit_title).length;
    const signed = await nav.call('POST', `/api/notes/${ctx.draftNote}/sign`, { password: PW, confirm: true }, { raw: true });
    const rem = rows(await nav.call('GET', '/api/tasks?status=done&limit=1000')).find((x) => x.id === f.reminder_task);
    ctx.followups_after = { call_put: c1.status, visit_put: v1.status, call_task_due: ct && String(ct.due_at).slice(0, 10), visit_task_due: vt && String(vt.due_at).slice(0, 10), open_with_call_title: dupCall, open_with_visit_title: dupVisit, draft_signed: signed.status, reminder_status: rem ? rem.status : 'not done' };
    const ok = c1.status === 200 && v1.status === 200 && ct && String(ct.due_at).slice(0, 10) === FOLLOW.call_moved && vt && String(vt.due_at).slice(0, 10) === FOLLOW.visit_moved && dupCall === 1 && dupVisit === 1 && signed.status === 200 && rem && rem.status === 'done';
    record(`${to}: the follow-up dates of the ${from} call and visit changed — their to-dos move, no second one; the draft signed — the supervisor's reminder closes (migration 67)`, performance.now() - t, ok,
      `PUT call HTTP ${c1.status}, its to-do ${f.call_task && f.call_task.slice(0, 8)}… ${FOLLOW.call} -> ${ctx.followups_after.call_task_due} (${dupCall} open with its title); PUT visit HTTP ${v1.status}, its to-do ${FOLLOW.visit} -> ${ctx.followups_after.visit_task_due} (${dupVisit} open with its title); draft signed HTTP ${signed.status}; reminder ${ctx.followups_after.reminder_status}${c1.status === 200 ? '' : ` ${JSON.stringify(c1.body)}`}${v1.status === 200 ? '' : ` ${JSON.stringify(v1.body)}`}`);
  } catch (e) { record(`${to}: follow-up to-dos and the supervisor's reminder after the upgrade`, 0, false, e.message); }
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
      // April-June, so that the corrected release of January-March below is screened from what the withdrawn one was.
      const ent = await adm.call('POST', `/api/county/programmes/${other.id}/entries`, { from: '2026-04-01', to: '2026-06-30', source_ref: 'Q2 report emailed 3 July 2026', funds: [fund] }, { raw: true });
      ctx.county_api_after = { listed: subs.map((x) => ({ id: x.id, source: x.source, status: x.status })), on_suds: mine && mine.on_suds, in_view: inView ? inView.submissions.length : 0, entered: ent.status, entered_source: ent.body && ent.body.submission && ent.body.submission.source };
      // Figures the older release's county entered: still listed as county_entered, the programme not on SUDS.
      let oldEnteredOk = true;
      if (ctx.enteredProgramme) {
        const allSubs = (await adm.call('GET', '/api/county/submissions')).rows;
        const es = allSubs.filter((x) => x.programme_id === ctx.enteredProgramme);
        const ep = progs.find((p) => p.id === ctx.enteredProgramme);
        ctx.county_api_after.old_entered = { listed: es.map((x) => `${x.source}/${x.status}`), on_suds: ep && ep.on_suds };
        oldEnteredOk = es.length === 1 && es[0].source === 'county_entered' && ep && ep.on_suds === false;
      }
      // Migration 65 through the API. The older release's consents (1.22.0) are current; a programme with none (every
      // one, on 1.21.0, which had no consents) gets one now, as a county must before publishing that names it.
      const progs2 = (await adm.call('GET', '/api/county/programmes')).rows;
      const oldConsents = progs2.filter((p) => p.publication_consent).map((p) => p.name);
      const recorded = [];
      for (const p of progs2.filter((x) => !x.publication_consent)) { await adm.call('POST', `/api/county/programmes/${p.id}/publication-consent`, { agreed_on: '2026-09-01', reference: `Agreement ${p.name}, 1 September 2026` }); recorded.push(p.name); }
      // The release the older release published: listed; withdrawn; and its period published again as a corrected
      // release, which needs what the withdrawn one was screened from (county_publication_inputs, kept from 1.22.0 on).
      const q = { from: '2026-01-01', to: '2026-03-31' };
      const listed0 = (await adm.call('GET', '/api/county/publications')).rows;
      const old = listed0.find((x) => x.id === ctx.oldRelease);
      const wd = await adm.call('POST', `/api/county/publications/${ctx.oldRelease}/withdraw`, { reason: 'A programme corrected its January-March figures' }, { raw: true });
      const prep = await adm.call('POST', '/api/county/publications/prepare', q, { raw: true });
      const pub = prep.status === 200 ? await adm.call('POST', '/api/county/publications', { ...q, sha256: prep.body.sha256, reviewed: true }, { raw: true }) : { status: null, body: null };
      // And a new period, April-June 2026 (the file the older release imported and the quarter entered just now).
      const q2 = { from: '2026-04-01', to: '2026-06-30' };
      const prep2 = await adm.call('POST', '/api/county/publications/prepare', q2, { raw: true });
      const pub2 = prep2.status === 200 ? await adm.call('POST', '/api/county/publications', { ...q2, sha256: prep2.body.sha256, reviewed: true }, { raw: true }) : { status: null, body: null };
      const pubs = (await adm.call('GET', '/api/county/publications')).rows;
      const corrects = prep.status === 200 && prep.body.content && prep.body.content.corrects ? prep.body.content.corrects.length : 0;
      ctx.county_api_after.publication = { old_consents: oldConsents, consents_recorded: recorded, old_release: old ? { status: old.status, from: old.period_from, to: old.period_to } : null, withdraw: wd.status,
        corrected: { prepare: prep.status, reason: prep.status === 200 ? undefined : prep.body && prep.body.reason, publish: pub.status, corrects }, april_june: { prepare: prep2.status, publish: pub2.status, detail: prep2.status === 200 ? undefined : prep2.body }, listed: pubs.map((x) => `${x.period_from}..${x.period_to} ${x.status}`) };
      ctx.publicationsWritten = 1 + (pub.status === 201 ? 1 : 0) + (pub2.status === 201 ? 1 : 0);
      ctx.consentsWritten = recorded.length;
      const correctedOk = ctx.oldConsents ? prep.status === 200 && pub.status === 201 && corrects === 1 : prep.status === 409 && prep.body && prep.body.reason === 'overlap';
      const consentsOk = ctx.oldConsents ? oldConsents.length === ctx.oldConsents && recorded.length === 1 : oldConsents.length === 0 && recorded.length === progs2.length;
      const ok = oldEnteredOk && consentsOk && old && old.status === 'published' && wd.status === 200 && correctedOk && prep2.status === 200 && pub2.status === 201
        && subs.length === 3 && subs.every((x) => x.source === 'signed') && subs.filter((x) => x.status === 'superseded').length === 1 && mine && mine.on_suds === true && inView && inView.submissions.length === 2 && ent.status === 201 && ctx.county_api_after.entered_source === 'county_entered';
      const P = ctx.county_api_after.publication;
      record(`${to}: the county through its API — the ${from} signed files and entered quarter listed as they were; ${ctx.oldConsents ? `the ${from} consents current` : 'consents recorded (none existed before 1.22.0)'}; the ${from} release listed, withdrawn, and a corrected release of its period ${ctx.oldConsents ? 'published from what it was screened from' : 'refused (it kept no inputs)'}; a release of April-June published (migration 65)`, performance.now() - t, ok,
        `listed ${JSON.stringify(ctx.county_api_after.listed.map((x) => `${x.source}/${x.status}`))}; on_suds ${ctx.county_api_after.on_suds}; ${ctx.county_api_after.old_entered ? `${from}'s entered programme ${JSON.stringify(ctx.county_api_after.old_entered)}; ` : ''}combined view Jan-Jun counts ${ctx.county_api_after.in_view} file(s) for it; Apr-Jun entered figures HTTP ${ent.status}, source ${ctx.county_api_after.entered_source}; consents current from ${from} ${JSON.stringify(P.old_consents)}, recorded now ${JSON.stringify(P.consents_recorded)}; ${from}'s release ${JSON.stringify(P.old_release)}, withdrawn HTTP ${wd.status}; corrected Jan-Mar: prepare HTTP ${prep.status}${P.corrected.reason ? ` (${P.corrected.reason})` : ''}, publish HTTP ${pub.status}, corrects ${corrects}; Apr-Jun: prepare HTTP ${prep2.status}, publish HTTP ${pub2.status}${P.april_june.detail ? ` ${JSON.stringify(P.april_june.detail)}` : ''}; releases now ${JSON.stringify(P.listed)}`);
    } catch (e) { record(`${to}: the county through its API`, 0, false, e.message); }
  }
  await srv.stop();

  // ---- new 5: structure and data ----
  r = child(TO, 'verify', envFor(dataDir, { DRILL_MANIFEST: path.join(work, 'manifest.json'), DRILL_UPGRADE_AT: upgradeAt, DRILL_FOLLOWUPS: JSON.stringify(ctx.followups || {}) }));
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
  record(`${to}: every session, device, passkey, to-do, county release, consent and release input ${from} wrote is kept with the same values (by the columns ${from} had)`, 0, keptOk && v.session_columns.length === 3,
    `${Object.entries(v.kept).map(([t, k]) => `${t} ${k.kept}/${k.before}${k.changed_or_lost.length ? ` (changed or lost: ${k.changed_or_lost.join(', ')})` : ''}`).join('; ')}; sessions opened before the upgrade: ${JSON.stringify(v.old_sessions)}; rows ${JSON.stringify(v.new_tables_rows)}${v.county_signing_keys.length ? `; county_signing_keys ${JSON.stringify(v.county_signing_keys)}` : ''}`);
  const x = v.m64_67;
  const oldHad = (t) => Object.prototype.hasOwnProperty.call(m.counts, t);
  const b4 = (t) => m.counts[t] || 0;
  // 64: dchen's account held to the field scope (by 1.22.0 itself, or by the migration from 1.21.0's field device); the
  // devices keep their scopes; the account's device first seen after the upgrade is a field device.
  const fa = x.field_accounts || [];
  const faOk = fa.length === 1 && fa[0].username === 'dchen' && fa[0].bound_via === (oldHad('field_accounts') ? 'admin' : 'migration');
  const dev = (id) => x.devices.find((d) => d.id === id) || {};
  const devOk = dev(DEVICE['X-Device-Id']).sync_scope === 'full' && dev(FIELD_DEVICE['X-Device-Id']).sync_scope === 'field' && dev(FIELD_DEVICE_2['X-Device-Id']).sync_scope === 'field' && dev(FIELD_DEVICE_2['X-Device-Id']).scope_set_by === 'account'
    && (oldHad('field_accounts') || (dev(DEVICE['X-Device-Id']).scope_set_by === null && dev(FIELD_DEVICE['X-Device-Id']).scope_set_by === null));
  // 66: the attested passkey keeps its attestation; the one from before the list keeps 1.22.0's grace period, or none (1.21.0).
  const pkOf = (u) => (x.passkeys || []).find((p) => p.username === u) || {};
  const pkOk = pkOf('mrivera').attested === 1 && pkOf('kpatel').attested === 0 && (oldHad('field_accounts') ? !!pkOf('kpatel').allowlist_grace_until : pkOf('kpatel').allowlist_grace_until === null)
    && x.allowlist.enabled === '1' && x.allowlist.models.includes(MODEL) && x.allowlist.metadata_entries === 1;
  // 67: only the two to-dos whose call and visit were edited are linked, each moved; the reminder closed.
  const T = x.tasks;
  const taskOk = T.linked_call === 1 && T.linked_visit === 1 && T.of_call === 1 && T.of_visit === 1 && T.index_call && T.index_visit
    && T.call_task.call_id === ctx.followups.call_id && String(T.call_task.due_at).slice(0, 10) === FOLLOW.call_moved && T.call_task.status === 'open'
    && T.visit_task.intervention_id === ctx.followups.visit_id && String(T.visit_task.due_at).slice(0, 10) === FOLLOW.visit_moved && T.visit_task.status === 'open'
    && T.reminder.status === 'done' && T.reminder.call_id === null && T.reminder.intervention_id === null && v.counts.after.tasks === b4('tasks');
  // 65: the older release's release and consents kept; its release has inputs from 1.22.0 on; what step 4 wrote added.
  const oldPub = (x.publications || []).filter((p) => p.before_upgrade);
  const pubOk = oldPub.length === b4('county_publications') && oldPub.length === 1 && oldPub[0].inputs === (oldHad('county_publication_inputs') ? 1 : 0)
    && x.tables.county_publication_consents === b4('county_publication_consents') + (ctx.consentsWritten || 0) && (x.publications || []).length === b4('county_publications') + (ctx.publicationsWritten || 0)
    && x.tables.county_publication_inputs === b4('county_publication_inputs') + (ctx.publicationsWritten || 0) - 1;
  record(`${to}: migrations 64-67 — field_accounts holds the field device's account and the devices keep their scopes; passkeys keep attestation and grace period; the edited follow-ups' to-dos linked and moved, the reminder closed, no to-do added; county releases, consents and inputs kept, step 4's added`, 0, faOk && devOk && pkOk && taskOk && pubOk,
    `tables ${JSON.stringify(x.tables)}; field_accounts ${JSON.stringify(fa)}; devices ${JSON.stringify(x.devices)}; passkeys ${JSON.stringify(x.passkeys)}; allow-list ${JSON.stringify(x.allowlist)}; tasks ${JSON.stringify(T)} (tasks ${b4('tasks')} -> ${v.counts.after.tasks}); publications ${JSON.stringify(x.publications)}; consents ${JSON.stringify(x.consents)}`);
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
    sessions_passkeys_devices_after_upgrade: ctx.api_after_1_23 || null,
    follow_ups_after_upgrade: ctx.followups_after || null,
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

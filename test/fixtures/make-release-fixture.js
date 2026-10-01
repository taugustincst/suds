'use strict';
// Builds a migration fixture from a released SUDS: that release's own code creates the database and writes a
// few fictional records through its own API, and the result is dumped as SQL (schema, rows, indexes, triggers)
// for test/migrations.test.js to upgrade. Sessions are dropped; nothing else is changed, so the rows are what
// that release really wrote (ciphertext, blind indexes, the audit chain). Keys are the test keys the migration
// test uses; every name in it is invented.
//
//   git archive v1.11.0 server package.json | tar -x -C /tmp/suds-v1.11.0
//   node test/fixtures/make-release-fixture.js /tmp/suds-v1.11.0 test/fixtures/release-v1.11.0.sql [--rich]
//
// release-v1.18.0.sql: `git archive 39e397e` (the "Release 1.18.0" commit; not tagged), --rich; release-v1.19.0.sql:
// `git archive 3dc20dc server package.json` ("Release 1.19.0"), --rich (its county_submissions rows are signed ones);
// release-v1.20.0.sql: `git archive 8f365b4 server package.json` (the v1.20.0 commit), --rich (its county rows made
// through its own API: signed files it imported, one superseded, and a quarter the county entered); release-v1.22.0.sql:
// `git archive 8b136df` (the commit after the 1.22.0 stamp that adds its SBOM), --rich (its county rows as 1.20.0's, and
// its county publication releases, a withdrawal, consents and inputs through its own API too). A table whose key is
// CHECKed to one value (county_connection) gets its one row, and is listed in the expectation's `rich.singletons`.
//
// --rich (release-v1.11.0.sql and release-v1.13.0.sql): a database with realistic rows in every table that has
// an encrypted (_enc) column, not one row each - the release's own sample data (server/demo.js seed, as `npm run
// seed` loads it), clients with names in other scripts written through its API, and then, for every table with
// an _enc column that still has fewer than RICH_ROWS rows, rows of its own made with the release's encrypt():
// every _enc column holds a value in some row (unicode among them) and is NULL in another where it may be. The
// migration test checks that every value still decrypts, and every blind index still matches, after the upgrade.
//
// The first line of the output is `-- expect: {...}`: the ids and plaintext the test checks after upgrading.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const rich = process.argv.includes('--rich');
const [tree, out] = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((p) => path.resolve(p));
if (!tree || !out) { console.error('usage: node test/fixtures/make-release-fixture.js <extracted release tree> <out.sql>'); process.exit(2); }
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-fixture-'));
Object.assign(process.env, {
  SUDS_ENV: 'test', SUDS_DATA_DIR: data, SUDS_DB_PATH: path.join(data, 'suds.db'),
  SUDS_ENCRYPTION_KEY: '0'.repeat(64), SUDS_INDEX_KEY: '1'.repeat(64),
  SUDS_ADMIN_USERNAME: 'admin', SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x', MFA_REQUIRED_ROLES: '',
});
const req = (m) => require(path.join(tree, 'server', m));

async function main() {
  const db = req('db');
  db.open();
  req('bootstrap').ensureBootstrap();
  db.run(`UPDATE users SET must_change_password=0`);
  // Only a release that has programme profiles gets one; an older database must reach the upgrade without it.
  if (fs.existsSync(path.join(tree, 'server', 'programme.js'))) db.setSetting('programme_profile', 'treatment');
  const version = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')).version;
  const server = http.createServer(req('app').createHandler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const d = await res.json().catch(() => null);
    if (res.status >= 300) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(d)}`);
    return d;
  };
  const expect = { version, schema_version: Number(db.getSetting('schema_version')) };
  try {
    await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPassw0rd!x' });
    const client = await call('POST', '/api/clients', { first_name: 'Wren', last_name: 'Fixture', dob: '1988-04-12', phone: '(555) 010-0142', primary_substance: 'opioids_fentanyl', risk_level: 'high', status: 'active', intake_date: '2026-08-01' });
    const visit = await call('POST', '/api/interventions', { client_id: client.id, type: 'naloxone_distribution', occurred_at: '2026-08-02T15:00:00Z', duration_minutes: 20, naloxone_kits: 2, summary: 'Kits handed over at the library' });
    const note = await call('POST', '/api/notes', { client_id: client.id, kind: 'admin', title: 'Intake call', content: 'Asked about MAT; prefers texts.', occurred_at: '2026-08-02T15:30:00Z' });
    const consent = await call('POST', `/api/clients/${client.id}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT referral', signed_at: '2026-08-01', scope: 'Referral summary and MAT status', expires_at: '2027-08-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true, signer_relationship: 'patient' });
    const resource = await call('POST', '/api/resources', { name: 'County OTP', category: 'mat_otp', phone: '555-0199', accepts_medicaid: true });
    const referral = await call('POST', '/api/referrals', { client_id: client.id, resource_id: resource.id, referred_at: '2026-08-03T09:00:00Z', urgency: 'urgent', warm_handoff: true, consent_id: consent.id });
    Object.assign(expect, {
      client: { id: client.id, first_name: 'Wren', last_name: 'Fixture', dob: '1988-04-12' },
      visit: { id: visit.id, summary: 'Kits handed over at the library', naloxone_kits: 2 },
      note: { id: note.id, content: 'Asked about MAT; prefers texts.' },
      consent: { id: consent.id, recipient: 'County OTP' },
      referral: { id: referral.id, resource_id: resource.id },
    });
    if (rich) Object.assign(expect, { rich: await enrich(db, call) });
    if (rich) Object.assign(expect, { state: laterState(db) });
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
  fs.writeFileSync(out, dump(path.join(data, 'suds.db'), expect));
  fs.rmSync(data, { recursive: true, force: true });
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes), SUDS ${version}, schema ${expect.schema_version}`);
}

// ---- --rich ----
const RICH_ROWS = 3;
// Plaintext for the rows made here: other scripts, accents, an emoji, quotes, a long value, and a zero-width
// joiner - what a county's records hold beside plain English.
const SAMPLES = ['Zoë Ñúñez-Ørsted, café on 3rd — “follow-up” ✓', 'Łucja Wiśniewska: prefers texts; ¿teléfono? 📞', '李明 / 김민준 / Nguyễn Văn An — interpreter needed',
  'O\'Brien said "no" (twice)', 'Kits × 2 at the library 🌿; note: ½ dose', 'Line one\nLine two\tand a tab', 'x'.repeat(600), 'क्ष family 👨‍👩‍👧'];
async function enrich(db, call) {
  const { hashPassword, uuid, encrypt } = req('crypto');
  // The release's own sample data, with its own users, as `npm run seed` loads it.
  const user = (username, role) => { const id = uuid(); db.run(`INSERT INTO users(id,username,password_hash,display_name,role,password_changed_at) VALUES(?,?,?,?,?,?)`, id, username, hashPassword('FixturePassw0rd!x'), `Fixture ${role}`, role, db.now()); return id; };
  const nav1 = user('fxnav1', 'navigator'); const nav2 = user('fxnav2', 'navigator'); const clin = user('fxclin', 'clinician'); const sup = user('fxsup', 'supervisor');
  const demo = req('demo');
  if (typeof demo.seed === 'function') demo.seed({ actor: sup, workers: [nav1, nav2], clinician: clin, supervisor: sup, seedValue: 7 });
  // Names in other scripts, through the release's API (which writes their blind indexes).
  const unicode = [];
  for (const [first_name, last_name, preferred_name, dob, phone] of [['Zoë', 'Ñúñez-Ørsted', 'Zo', '1979-02-28', '555-010-0171'], ['Łucja', 'Wiśniewska', null, '2001-12-31', '+1 (555) 010-0172'], ['明', '李', 'Ming', '1990-07-04', '5550100173']]) {
    const c = await call('POST', '/api/clients', { first_name, last_name, ...(preferred_name ? { preferred_name } : {}), dob, phone, status: 'active', intake_date: '2026-08-04', confirm_duplicate: true });
    unicode.push({ id: c.id, first_name, last_name, preferred_name, dob, phone });
  }
  const d = db.get();
  // A release with county-entered figures (1.20.0 on: county_submissions.source, and a CHECK tying a signed row to its
  // key and signature and an entered one to neither, which rows made up below cannot satisfy): its county rows
  // through its own API, as docs/evidence/upgrade-drill-2026-10-01-v1.21.0 makes them. This server registers itself
  // as a programme with its county-submission key and imports its own signed files for two quarters, the second twice
  // (so one is superseded); and a programme not on SUDS gets a quarter the county entered.
  if (d.prepare(`PRAGMA table_info(county_submissions)`).all().some((c) => c.name === 'source')) {
    await call('POST', '/api/county-submission/key', {});
    const cur = await call('GET', '/api/county-submission/key');
    const code = await call('GET', '/api/county/code');
    const funds = (await call('GET', '/api/county-submission/options')).funds.map((f) => f.id);
    await call('POST', '/api/county/programmes', { name: 'Fixture Programme', public_key: cur.key.public_key, compared: true });
    for (const [from, to] of [['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30'], ['2026-04-01', '2026-06-30']]) {
      const f = await call('GET', `/api/county-submission/file?from=${from}&to=${to}&county_code=${code.code}&county_name=${encodeURIComponent('Fixture County')}&funds=${funds.join(',')}`);
      await new Promise((res) => setTimeout(res, 20));
      await call('POST', '/api/county/submissions', { text: JSON.stringify(f, null, 2) });
    }
    const other = await call('POST', '/api/county/programmes', { name: 'Paper Reports Collective', not_on_suds: true });
    await call('POST', `/api/county/programmes/${other.id}/entries`, { from: '2026-01-01', to: '2026-03-31', source_ref: 'Q1 report emailed 3 April 2026 — “Zoë”', funds: [{ name: 'County settlement share', grant_number: 'OSF-FX-1', category: 'core_h', hiaa: 'hiaa_4',
      spend_own_category: '1000.50', spend_other_categories: '0', spend_pending: '25', contacts: '120', naloxone_kits: '80', fentanyl_strips: '300', syringes: '900', reversals: '3', treatment_admissions: '2',
      education_contacts: '5', staff_training_hours: '12.5', referrals_made: '14', people_served: '70', people_linked: '6', moud_linked: '2', people_trained: '9' }] });
    // A release with county publication releases (1.21.0 on): the releases through its own API too, as
    // docs/evidence/upgrade-drill-2026-10-01-v1.23.0 makes them, since a release row is CHECKed to its content and a
    // withdrawal to the release it withdraws, which rows made up below cannot satisfy. Where the release has consents
    // (1.22.0 on), each programme's first; January-March published and withdrawn (with its reason); where the release
    // keeps what a release was screened from (1.22.0 on), a corrected release of that period; April-June published;
    // and then one programme's consent withdrawn and recorded again, so a withdrawn consent is among the rows.
    if (d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='county_publications'`).get()) {
      const has = (t) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      const progs = (await call('GET', '/api/county/programmes')).rows;
      if (has('county_publication_consents')) for (const p of progs) await call('POST', `/api/county/programmes/${p.id}/publication-consent`, { agreed_on: '2026-04-01', reference: `Signed agreement — ${p.name}, “Zoë” ✓` });
      const publish = async (q) => { const prep = await call('POST', '/api/county/publications/prepare', q); return call('POST', '/api/county/publications', { ...q, sha256: prep.sha256, reviewed: true }); };
      const q1 = { from: '2026-01-01', to: '2026-03-31' };
      const first = await publish(q1);
      await call('POST', `/api/county/publications/${first.id}/withdraw`, { reason: 'A programme corrected its figures — “Zoë” ✓' });
      if (has('county_publication_inputs')) await publish(q1);
      await publish({ from: '2026-04-01', to: '2026-06-30' });
      if (has('county_publication_consents')) {
        await call('POST', `/api/county/programmes/${other.id}/publication-consent/withdraw`, {});
        await call('POST', `/api/county/programmes/${other.id}/publication-consent`, { agreed_on: '2026-07-01', reference: 'Renewed agreement 李明' });
      }
    }
  }
  // Every table with an encrypted column: top it up to RICH_ROWS rows, and give every such column a value.
  const tables = d.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  const made = {}; let n = 0;
  // A table after the tables it refers to, so a row made here can refer to rows made here.
  const byName = new Map(tables.map((t) => [t.name, t])); const ordered = []; const seen = new Set();
  const visit = (t) => { if (seen.has(t.name)) return; seen.add(t.name); for (const f of d.prepare(`PRAGMA foreign_key_list("${t.name}")`).all()) if (byName.has(f.table)) visit(byName.get(f.table)); ordered.push(t); };
  tables.forEach(visit);
  // One row of `name`, made up; a table it refers to that is still empty gets a row first. Plain columns that
  // may be empty get a value too (a document reference a later release encrypts, say), except in the last row;
  // where a value of that shape breaks a CHECK, the row is made again with them empty.
  const insertRow = (name, k, fillOptional = true) => {
    const { sql } = byName.get(name);
    const cols = d.prepare(`PRAGMA table_info("${name}")`).all();
    const fks = d.prepare(`PRAGMA foreign_key_list("${name}")`).all();
    const row = {};
    for (const c of cols) {
      const fk = fks.find((f) => f.from === c.name);
      if (c.pk && singletonId(sql, c.name)) row[c.name] = singletonId(sql, c.name);
      else if (c.pk && /TEXT/i.test(c.type)) row[c.name] = uuid();
      else if (c.pk) continue;
      else if (fk) {
        if (!c.notnull && k === RICH_ROWS - 1) { row[c.name] = null; continue; }
        if (byName.has(fk.table) && fk.table !== name && !d.prepare(`SELECT COUNT(*) n FROM "${fk.table}"`).get().n) insertRow(fk.table, 0);
        const refs = d.prepare(`SELECT "${fk.to || 'id'}" v FROM "${fk.table}" ORDER BY rowid`).all();
        row[c.name] = refs.length ? refs[(k + n) % refs.length].v : null;
      } else if (c.name.endsWith('_enc')) row[c.name] = k === RICH_ROWS - 1 && !c.notnull ? null : encrypt(SAMPLES[(k + n++) % SAMPLES.length]);
      else if (c.name.endsWith('_idx')) row[c.name] = null;
      else if (c.notnull && c.dflt_value === null) row[c.name] = valueFor(name, c, sql, k);
      else if (fillOptional && !c.notnull && c.dflt_value === null && /TEXT/i.test(c.type) && k < RICH_ROWS - 1) row[c.name] = valueFor(name, c, sql, k);
    }
    const keys = Object.keys(row);
    try { d.prepare(`INSERT INTO "${name}"(${keys.map((x) => `"${x}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((x) => row[x])); }
    catch (e) {
      if (fillOptional && /CHECK/.test(e.message)) { insertRow(name, k, false); return; }
      throw new Error(`${name}: ${e.message} ${JSON.stringify(fks)} ${JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k2]) => !k2.endsWith('_enc'))))}`); }
    made[name] = (made[name] || 0) + 1;
  };
  for (const { name } of ordered) {
    if (SKIP_ROWS.has(name)) continue;
    const enc = d.prepare(`PRAGMA table_info("${name}")`).all().filter((c) => c.name.endsWith('_enc'));
    if (!enc.length) continue;
    // A single-row table (its key CHECKed to one value: county_connection, 1.18.0) gets its one row.
    const rowsWanted = isSingleton(byName.get(name).sql) ? 1 : RICH_ROWS;
    for (let k = d.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n; k < rowsWanted; k++) insertRow(name, k);
    // A column no row has a value in gets one (users.mfa_secret_enc: an enrolment not finished yet, say).
    for (const c of enc) {
      if (d.prepare(`SELECT COUNT(*) n FROM "${name}" WHERE "${c.name}" IS NOT NULL`).get().n) continue;
      d.prepare(`UPDATE "${name}" SET "${c.name}"=? WHERE rowid=(SELECT MIN(rowid) FROM "${name}")`).run(encrypt(SAMPLES[n++ % SAMPLES.length]));
    }
  }
  const encTables = {}; const singletons = [];
  for (const { name } of tables) {
    if (SKIP_ROWS.has(name) || !d.prepare(`PRAGMA table_info("${name}")`).all().some((c) => c.name.endsWith('_enc'))) continue;
    encTables[name] = d.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n;
    if (isSingleton(byName.get(name).sql)) singletons.push(name);
  }
  return { encTables, singletons, unicodeClients: unicode, made };
}
/**
 * --rich, for a release that has them (1.15.0 on): the state a later release's first start acts on besides the
 * schema (release-v1.16.4.sql; engineering review of the 1.17.0 candidate, M3). A per-user permission override;
 * an import item filed as a note with its text still held (1.17.0's retention pass clears it); the CalOMS
 * submissions --rich made (migration 55 gives each its defaults). What the test checks after the upgrade.
 */
function laterState(db) {
  const d = db.get(); const { encrypt } = req('crypto');
  const has = (t) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const out = { settings: Object.fromEntries(d.prepare(`SELECT key, value FROM settings WHERE key IN ('caseload_hold_new_staff','programme_profile')`).all().map((r) => [r.key, r.value])) };
  if (has('user_permission_overrides')) {
    const u = d.prepare(`SELECT id FROM users WHERE username='fxnav1'`).get();
    const admin = d.prepare(`SELECT id FROM users WHERE username='admin'`).get();
    d.prepare(`INSERT OR REPLACE INTO user_permission_overrides(user_id,permission,mode,reason,granted_by) VALUES(?,?,?,?,?)`).run(u.id, 'reports:funder', 'grant', 'Fixture: covers the funder report', admin.id);
    out.overrides = d.prepare(`SELECT user_id, permission, mode FROM user_permission_overrides ORDER BY user_id, permission`).all().map((r) => ({ ...r }));
  }
  if (has('import_items')) {
    const item = d.prepare(`SELECT id FROM import_items ORDER BY rowid LIMIT 1`).get();
    d.prepare(`UPDATE import_items SET status='committed', content_enc=?, title_enc=? WHERE id=?`).run(encrypt('Filed session text a 1.16 release kept'), encrypt('Filed title'), item.id);
    out.committed_import_item = item.id;
    out.staged_import_items = d.prepare(`SELECT id FROM import_items WHERE status='staged' AND content_enc<>''`).all().map((r) => r.id);
  }
  if (has('caloms_submissions')) out.caloms_submissions = d.prepare(`SELECT id FROM caloms_submissions ORDER BY rowid`).all().map((r) => r.id);
  return out;
}
/** The one value a primary key is CHECKed to (`id TEXT PRIMARY KEY CHECK (id = 'county')`), or null. */
function singletonId(sql, col) {
  const esc = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\b${esc}\\b[^,]*?PRIMARY KEY[^,]*?CHECK\\s*\\(\\s*${esc}\\s*=\\s*'([^']*)'\\s*\\)`, 'i').exec(sql);
  return m ? m[1] : null;
}
const isSingleton = (sql) => /PRIMARY KEY[^,]*?CHECK\s*\(\s*\w+\s*=\s*'[^']*'\s*\)/i.test(sql);
/** A value for a NOT NULL column with no default: the first choice its CHECK allows, else one of its type's shape. */
function valueFor(table, c, sql, k) {
  const esc = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const check = new RegExp(`\\b${esc}\\b[^,]*?CHECK\\s*\\(\\s*${esc}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql);
  if (check) { const opts = check[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')); return opts[k % opts.length]; }
  if (/INT/i.test(c.type)) return 1;
  if (/REAL|NUM/i.test(c.type)) return 1.5;
  if (/(_at|_on)$/.test(c.name)) return `2026-08-${String(10 + k).padStart(2, '0')}T10:00:00.000Z`;
  if (/date/.test(c.name)) return `2026-08-${String(10 + k).padStart(2, '0')}`;
  return `fixture-${table}-${k}`;
}

const SKIP_ROWS = new Set(['sessions', 'idempotency_keys']);
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
function dump(file, expect) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(file, { readOnly: true });
  const objs = d.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all();
  const lines = [`-- expect: ${JSON.stringify(expect)}`,
    `-- SUDS ${expect.version} database (schema ${expect.schema_version}) made by test/fixtures/make-release-fixture.js. Fictional data, test keys.`,
    'PRAGMA foreign_keys=OFF;', 'BEGIN;'];
  for (const o of objs.filter((x) => x.type === 'table')) {
    lines.push(`${o.sql};`);
    if (SKIP_ROWS.has(o.name)) continue;
    // The sample data's placeholder pictures are 400 KB of base64 and no record: a rich fixture leaves them out.
    if (rich && o.name === 'resource_photos') continue;
    const cols = d.prepare(`PRAGMA table_info("${o.name}")`).all().map((c) => c.name);
    for (const row of d.prepare(`SELECT * FROM "${o.name}"`).all()) lines.push(`INSERT INTO "${o.name}"(${cols.map((c) => `"${c}"`).join(',')}) VALUES(${cols.map((c) => lit(row[c])).join(',')});`);
  }
  for (const o of objs.filter((x) => x.type !== 'table')) lines.push(`${o.sql};`);
  lines.push('COMMIT;', '');
  d.close();
  return lines.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });

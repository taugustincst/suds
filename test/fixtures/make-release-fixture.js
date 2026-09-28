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
  // Every table with an encrypted column: top it up to RICH_ROWS rows, and give every such column a value.
  const d = db.get();
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
      if (c.pk && /TEXT/i.test(c.type)) row[c.name] = uuid();
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
    for (let k = d.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n; k < RICH_ROWS; k++) insertRow(name, k);
    // A column no row has a value in gets one (users.mfa_secret_enc: an enrolment not finished yet, say).
    for (const c of enc) {
      if (d.prepare(`SELECT COUNT(*) n FROM "${name}" WHERE "${c.name}" IS NOT NULL`).get().n) continue;
      d.prepare(`UPDATE "${name}" SET "${c.name}"=? WHERE rowid=(SELECT MIN(rowid) FROM "${name}")`).run(encrypt(SAMPLES[n++ % SAMPLES.length]));
    }
  }
  const encTables = {};
  for (const { name } of tables) {
    if (SKIP_ROWS.has(name) || !d.prepare(`PRAGMA table_info("${name}")`).all().some((c) => c.name.endsWith('_enc'))) continue;
    encTables[name] = d.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n;
  }
  return { encTables, unicodeClients: unicode, made };
}
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

'use strict';
// Builds a migration fixture from a released SUDS: that release's own code creates the database and writes a
// few fictional records through its own API, and the result is dumped as SQL (schema, rows, indexes, triggers)
// for test/migrations.test.js to upgrade. Sessions are dropped; nothing else is changed, so the rows are what
// that release really wrote (ciphertext, blind indexes, the audit chain). Keys are the test keys the migration
// test uses; every name in it is invented.
//
//   git archive v1.11.0 server package.json | tar -x -C /tmp/suds-v1.11.0
//   node test/fixtures/make-release-fixture.js /tmp/suds-v1.11.0 test/fixtures/release-v1.11.0.sql
//
// The first line of the output is `-- expect: {...}`: the ids and plaintext the test checks after upgrading.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const [tree, out] = process.argv.slice(2).map((p) => path.resolve(p));
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
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
  fs.writeFileSync(out, dump(path.join(data, 'suds.db'), expect));
  fs.rmSync(data, { recursive: true, force: true });
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes), SUDS ${version}, schema ${expect.schema_version}`);
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
    const cols = d.prepare(`PRAGMA table_info("${o.name}")`).all().map((c) => c.name);
    for (const row of d.prepare(`SELECT * FROM "${o.name}"`).all()) lines.push(`INSERT INTO "${o.name}"(${cols.map((c) => `"${c}"`).join(',')}) VALUES(${cols.map((c) => lit(row[c])).join(',')});`);
  }
  for (const o of objs.filter((x) => x.type !== 'table')) lines.push(`${o.sql};`);
  lines.push('COMMIT;', '');
  d.close();
  return lines.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
